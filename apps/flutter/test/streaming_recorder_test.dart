/// AUD1 — the transport half: microphone → gateway.
///
/// Driven with an injected socket and PCM stream, so these assert ORDER and ROUTING rather than
/// whether a microphone exists. The ordering claims are the ones worth a test — they are invisible
/// in a screenshot and only fail in production.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/api/models.dart';
import 'package:qrai/src/practice/streaming_recorder.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

RealtimeTicket ticketWith({List<int> rates = const <int>[16000]}) => RealtimeTicket(
      token: 'rt_v1.token',
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      learnerId: 'learner-1',
      expiresAt: 9999999999,
      allowedSampleRates: rates,
      externalAsrProcessing: false,
    );

/// A socket that records what was sent and when it was closed.
///
/// `noSuchMethod` covers the `StreamChannel` members nothing here calls (`pipe`, `transform`, …).
/// Implementing all seven by hand would be boilerplate that asserts nothing; a call to one of them
/// would still fail loudly at runtime rather than silently returning null.
class FakeChannel implements WebSocketChannel {
  final List<Object?> sent = <Object?>[];
  bool closed = false;

  @override
  Stream<dynamic> get stream => const Stream<dynamic>.empty();

  @override
  WebSocketSink get sink => _FakeSink(this);

  @override
  Future<void> get ready async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeSink implements WebSocketSink {
  _FakeSink(this._channel);
  final FakeChannel _channel;

  @override
  void add(Object? data) => _channel.sent.add(data);

  @override
  Future<void> close([int? closeCode, String? closeReason]) async => _channel.closed = true;

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream<Object?> stream) => stream.forEach(add);
  @override
  Future<void> get done async {}
}

void main() {
  test('the audio URL carries the ticket and the session, on the ws scheme', () {
    final Uri uri = audioUriFor(Uri.parse('https://rt.example.com'), 'session-9', 'tok en/+');
    expect(uri.scheme, 'wss', reason: 'https must upgrade to wss, never plain ws');
    expect(uri.path, '/v1/recitation-sessions/session-9/audio');
    // Percent-encoded, not concatenated: a token containing / or + would otherwise reshape the URL.
    expect(uri.queryParameters['ticket'], 'tok en/+');
  });

  test('http downgrades to ws, for a local gateway', () {
    expect(audioUriFor(Uri.parse('http://127.0.0.1:8081'), 's', 't').scheme, 'ws');
  });

  test('no stray fragment — Uri.replace carries an empty one over', () {
    // `Uri.parse('http://host:port')` has an empty-but-present fragment, and `replace` keeps it, so
    // the URL used to end in a bare `#`. Seen in a real handshake error against the live gateway.
    final Uri uri = audioUriFor(Uri.parse('http://127.0.0.1:8086'), 'session-1', 'tok');
    expect(uri.hasFragment, isFalse);
    expect(uri.toString(), isNot(endsWith('#')));
  });

  test('the one truthful 16 kHz PCM profile comes from the ticket', () {
    final StreamingRecorder r = StreamingRecorder(
      ticket: ticketWith(rates: <int>[16000]),
      gatewayBase: Uri.parse('http://127.0.0.1:8081'),
      socketFactory: (Uri _) => FakeChannel(),
      pcmStreamFactory: (int _) async => const Stream<Uint8List>.empty(),
    );
    expect(r.sampleRate, 16000);
  });

  test('empty, 24/48 kHz, duplicate, and mixed ticket profiles fail closed', () {
    for (final List<int> rates in <List<int>>[
      <int>[],
      <int>[24000],
      <int>[48000],
      <int>[16000, 16000],
      <int>[48000, 16000],
    ]) {
      final StreamingRecorder r = StreamingRecorder(
        ticket: ticketWith(rates: rates),
        gatewayBase: Uri.parse('http://127.0.0.1:8081'),
        socketFactory: (Uri _) => FakeChannel(),
        pcmStreamFactory: (int _) async => const Stream<Uint8List>.empty(),
      );
      expect(() => r.sampleRate, throwsStateError, reason: '$rates must fail closed');
    }
  });

  test('the socket opens BEFORE the microphone', () async {
    final List<String> order = <String>[];
    final FakeChannel channel = FakeChannel();
    final StreamingRecorder r = StreamingRecorder(
      ticket: ticketWith(),
      gatewayBase: Uri.parse('http://127.0.0.1:8081'),
      socketFactory: (Uri _) {
        order.add('socket');
        return channel;
      },
      pcmStreamFactory: (int _) async {
        order.add('microphone');
        return const Stream<Uint8List>.empty();
      },
    );

    await r.start();
    // A gateway that refuses the ticket must do so before a child's microphone is opened, even
    // though nothing would have been transmitted.
    expect(order, <String>['socket', 'microphone']);
    await r.stop();
  });

  test('a gateway that refuses the ticket never opens the microphone', () async {
    bool micOpened = false;
    final StreamingRecorder r = StreamingRecorder(
      ticket: ticketWith(),
      gatewayBase: Uri.parse('http://127.0.0.1:8081'),
      socketFactory: (Uri _) => _RefusingChannel(),
      pcmStreamFactory: (int _) async {
        micOpened = true;
        return const Stream<Uint8List>.empty();
      },
    );

    await expectLater(r.start(), throwsA(isA<StateError>()));
    expect(micOpened, isFalse);
  });

  test('captured frames reach the socket unchanged', () async {
    final FakeChannel channel = FakeChannel();
    final StreamController<Uint8List> pcm = StreamController<Uint8List>();
    final StreamingRecorder r = StreamingRecorder(
      ticket: ticketWith(),
      gatewayBase: Uri.parse('http://127.0.0.1:8081'),
      socketFactory: (Uri _) => channel,
      pcmStreamFactory: (int _) async => pcm.stream,
    );

    await r.start();
    final Uint8List frame = Uint8List.fromList(<int>[1, 2, 3, 250]);
    pcm.add(frame);
    await Future<void>.delayed(Duration.zero);

    // Byte-identical: no resampling, no re-encoding, nothing that would move a word boundary.
    expect(channel.sent, <Object?>[frame]);
    await r.stop();
    expect(channel.closed, isTrue, reason: 'the socket was left open after stop');
  });
  test('a cancel that throws still stops the device and closes the socket', () async {
    // The same defect `consent_gate.dart` had one level up, in code written the same day: a plain
    // sequence of awaits, where the first failure skipped every release after it. A `cancel()` that
    // throws used to leave the microphone open AND the socket connected.
    final FakeChannel channel = FakeChannel();
    final StreamController<Uint8List> pcm =
        StreamController<Uint8List>(onCancel: () => throw StateError('cancel failed'));

    final StreamingRecorder r = StreamingRecorder(
      ticket: ticketWith(),
      gatewayBase: Uri.parse('http://127.0.0.1:8081'),
      socketFactory: (Uri _) => channel,
      pcmStreamFactory: (int _) async => pcm.stream,
    );

    await r.start();
    // The error is NOT swallowed — a caller must not be told the stop was clean.
    await expectLater(r.stop(), throwsA(isA<StateError>()));
    // …and the release that came after it still happened.
    expect(channel.closed, isTrue, reason: 'the socket was left open by a failing cancel');
  });
  test('a close that also fails does not hide why the handshake failed', () async {
    // The gateway refusing a ticket is the most diagnostic failure in this flow. A bare
    // `await socket.sink.close()` in the catch would swap it for whatever the socket said on the
    // way down, and the caller would chase the wrong thing.
    final StreamingRecorder r = StreamingRecorder(
      ticket: ticketWith(),
      gatewayBase: Uri.parse('http://127.0.0.1:8081'),
      socketFactory: (Uri _) => _RefusesThenFailsToClose(),
      pcmStreamFactory: (int _) async => const Stream<Uint8List>.empty(),
    );

    await expectLater(
      r.start(),
      throwsA(isA<StateError>().having((StateError e) => e.message, 'message',
          contains('gateway refused'))),
      reason: 'the close error replaced the handshake error',
    );
  });
}

/// A socket whose handshake fails, like a gateway rejecting an expired or foreign ticket.
class _RefusingChannel extends FakeChannel {
  @override
  Future<void> get ready async => throw StateError('gateway refused the ticket');
}

/// Refuses the handshake AND fails to close — the case where a naive catch reports the wrong cause.
class _RefusesThenFailsToClose extends FakeChannel {
  @override
  Future<void> get ready async => throw StateError('gateway refused the ticket');

  @override
  WebSocketSink get sink => _ThrowingSink();
}

class _ThrowingSink implements WebSocketSink {
  @override
  void add(Object? data) {}
  @override
  Future<void> close([int? closeCode, String? closeReason]) async =>
      throw StateError('socket close also failed');
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream<Object?> stream) async {}
  @override
  Future<void> get done async {}
}
