/// The real `AudioRecorder`: microphone → PCM16 → realtime gateway WebSocket.
///
/// `consent_gate.dart` defines the interface and guarantees nothing here is CONSTRUCTED before
/// consent passes. This file is what it constructs, and it extends that guarantee one step further:
/// the socket is opened inside `start()`, so a learner who has not consented has neither a
/// microphone stream nor a connection to the gateway — not an idle one, not a connecting one.
///
/// ── The sample rate is the ticket's decision, not this file's ───────────────────────────────────
/// `RealtimeTicket.allowedSampleRates` is what the gateway will accept for THIS session. Hardcoding
/// 16 kHz would work until the day a session is issued for something else, and then fail as garbled
/// audio rather than as an error — the worst way for an audio bug to present.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart' as rec;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../api/models.dart';
import 'consent_gate.dart';

/// Opens the gateway socket. Injected so a test can drive the whole path without a gateway.
typedef SocketFactory = WebSocketChannel Function(Uri uri);

/// Captures PCM frames. Injected for the same reason — a test has no microphone.
typedef PcmStreamFactory = Future<Stream<Uint8List>> Function(int sampleRate);

/// Ask the OS for the microphone, prompting if it has not been asked before.
///
/// A free function, not a method, because the consent gate must be able to ask BEFORE any recorder
/// exists — that ordering is the whole point of `consent_gate.dart`, and a method would require
/// constructing the thing the gate is deciding about.
Future<bool> requestMicrophonePermission() => StreamingRecorder.device.hasPermission();

/// Builds the audio URL for a session. The ticket travels in the query string because a WebSocket
/// handshake from a browser cannot carry an Authorization header — the gateway's own contract.
Uri audioUriFor(Uri gatewayBase, String sessionId, String ticketToken) {
  return gatewayBase
      .replace(
        scheme: gatewayBase.scheme == 'https' ? 'wss' : 'ws',
        path: '/v1/recitation-sessions/$sessionId/audio',
        queryParameters: <String, String>{'ticket': ticketToken},
      )
      // `replace` CARRIES THE FRAGMENT OVER, and `Uri.parse('http://host:port')` has an empty-but-
      // present one — so the URL came out ending in a bare `#`. Seen in a real handshake error
      // message. Harmless to this gateway, which never sees a fragment, but a URL nobody meant to
      // build is one nobody has reasoned about.
      .removeFragment();
}

class StreamingRecorder implements AudioRecorder {
  StreamingRecorder({
    required this.ticket,
    required this.gatewayBase,
    SocketFactory? socketFactory,
    PcmStreamFactory? pcmStreamFactory,
  })  : _socketFactory = socketFactory ?? WebSocketChannel.connect,
        _injectedPcm = pcmStreamFactory;

  final RealtimeTicket ticket;
  final Uri gatewayBase;
  final SocketFactory _socketFactory;

  /// Null in the app; a fake in a test. Kept nullable rather than defaulted to the microphone so
  /// `stop()` can tell whether there is a real device to stop — `identical()` against a static
  /// tear-off happened to work, but "happened to work" is how a muted microphone ships.
  final PcmStreamFactory? _injectedPcm;

  /// One shared device. `record` holds a platform channel per instance, and two recorders competing
  /// for the microphone is a failure with no error message.
  static final rec.AudioRecorder device = rec.AudioRecorder();

  WebSocketChannel? _socket;
  StreamSubscription<Uint8List>? _subscription;
  bool _deviceStarted = false;

  Future<Stream<Uint8List>> _pcm(int sampleRate) =>
      _injectedPcm?.call(sampleRate) ?? _microphone(sampleRate);

  /// The default source: the real microphone, as uncompressed PCM the gateway can align.
  Future<Stream<Uint8List>> _microphone(int sampleRate) async {
    final Stream<Uint8List> stream = await device.startStream(
      rec.RecordConfig(
        // PCM, not AAC: the aligner needs samples, and a lossy codec moves the word boundaries
        // this whole feature reports on.
        encoder: rec.AudioEncoder.pcm16bits,
        sampleRate: sampleRate,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
      ),
    );
    _deviceStarted = true;
    return stream;
  }

  /// The rate to record at: the ticket's first allowed value.
  int get sampleRate {
    if (ticket.allowedSampleRates.isEmpty) {
      throw StateError('the ticket allows no sample rate; refusing to guess one');
    }
    return ticket.allowedSampleRates.first;
  }

  @override
  Future<void> start() async {
    if (_socket != null) return;

    // Socket first. If the gateway refuses the ticket, that must happen BEFORE the microphone
    // opens — a rejected session that had already turned on a child's mic is the wrong order even
    // though nothing was transmitted.
    final WebSocketChannel socket =
        _socketFactory(audioUriFor(gatewayBase, ticket.sessionId, ticket.token));
    _socket = socket;
    try {
      await socket.ready;
    } on Object {
      _socket = null;
      // The close must NOT replace the handshake error. That error is the one the caller needs —
      // "the gateway refused this ticket" is the most diagnostic failure in the whole flow, and a
      // bare `await close()` here would swap it for whatever the socket said on the way down.
      try {
        await socket.sink.close();
      } on Object {
        // Deliberately swallowed: the handshake failure below is the real cause.
      }
      rethrow;
    }

    final Stream<Uint8List> pcm = await _pcm(sampleRate);
    // No `onData` logging of any kind. These bytes are a child reciting the Qur'an; the only place
    // they belong is the sink.
    _subscription = pcm.listen(socket.sink.add, onDone: stop, cancelOnError: true);
  }

  @override
  Future<void> stop() async {
    // Every handle is taken and cleared FIRST, so a throwing release cannot leave this object
    // pointing at something it no longer owns.
    final StreamSubscription<Uint8List>? sub = _subscription;
    final WebSocketChannel? socket = _socket;
    final bool startedDevice = _deviceStarted;
    _subscription = null;
    _socket = null;
    _deviceStarted = false;

    // ── Every step runs, whatever the earlier ones did ────────────────────────────────────────
    // This was a plain sequence of awaits, which is the same defect `consent_gate.dart` had one
    // level up: a `cancel()` that threw skipped `device.stop()` — leaving a child's microphone
    // open — and skipped the socket close too. The first error still propagates, so a caller is
    // never told a clean stop happened when it did not.
    Object? firstError;
    StackTrace? firstTrace;
    Future<void> release(Future<void> Function() step) async {
      try {
        await step();
      } on Object catch (e, st) {
        firstError ??= e;
        firstTrace ??= st;
      }
    }

    // Order is unchanged and still matters: microphone before socket, or captured audio is
    // streamed into a closing sink.
    await release(() async => sub?.cancel());
    if (startedDevice) await release(device.stop);
    await release(() async => socket?.sink.close());

    if (firstError != null) Error.throwWithStackTrace(firstError!, firstTrace!);
  }

  @override
  Future<void> dispose() async {
    await stop();
  }
}
