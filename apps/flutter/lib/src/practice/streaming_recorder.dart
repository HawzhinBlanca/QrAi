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

/// Builds the audio URL for a session. The ticket travels in the query string because a WebSocket
/// handshake from a browser cannot carry an Authorization header — the gateway's own contract.
Uri audioUriFor(Uri gatewayBase, String sessionId, String ticketToken) {
  return gatewayBase.replace(
    scheme: gatewayBase.scheme == 'https' ? 'wss' : 'ws',
    path: '/v1/recitation-sessions/$sessionId/audio',
    queryParameters: <String, String>{'ticket': ticketToken},
  );
}

class StreamingRecorder implements AudioRecorder {
  StreamingRecorder({
    required this.ticket,
    required this.gatewayBase,
    SocketFactory? socketFactory,
    PcmStreamFactory? pcmStreamFactory,
  })  : _socketFactory = socketFactory ?? WebSocketChannel.connect,
        _pcmStreamFactory = pcmStreamFactory ?? _microphone;

  final RealtimeTicket ticket;
  final Uri gatewayBase;
  final SocketFactory _socketFactory;
  final PcmStreamFactory _pcmStreamFactory;

  static final rec.AudioRecorder _device = rec.AudioRecorder();

  WebSocketChannel? _socket;
  StreamSubscription<Uint8List>? _subscription;

  /// The default source: the real microphone, as uncompressed PCM the gateway can align.
  static Future<Stream<Uint8List>> _microphone(int sampleRate) => _device.startStream(
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
      await socket.sink.close();
      rethrow;
    }

    final Stream<Uint8List> pcm = await _pcmStreamFactory(sampleRate);
    // No `onData` logging of any kind. These bytes are a child reciting the Qur'an; the only place
    // they belong is the sink.
    _subscription = pcm.listen(socket.sink.add, onDone: stop, cancelOnError: true);
  }

  @override
  Future<void> stop() async {
    final StreamSubscription<Uint8List>? sub = _subscription;
    _subscription = null;
    // Microphone before socket: the reverse order streams captured audio into a closing sink.
    await sub?.cancel();
    if (identical(_pcmStreamFactory, _microphone)) await _device.stop();

    final WebSocketChannel? socket = _socket;
    _socket = null;
    await socket?.sink.close();
  }

  @override
  Future<void> dispose() async {
    await stop();
  }
}
