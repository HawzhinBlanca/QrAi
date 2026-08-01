/// The app's own transport against a REAL realtime-gateway, with a REAL ticket minted by a REAL
/// platform-api. Everything else in this directory fakes one side or the other.
///
/// ── Skipped unless you point it at a running stack ──────────────────────────────────────────────
/// It needs two live services, so it is gated on `QRAI_LIVE_TICKET` and skips silently in
/// `verify.sh`. Gating rather than deleting is the point: a proof you cannot re-run is an anecdote.
///
///   # platform-api on :8083, realtime-gateway on :8084 (see docs/TESTING.md)
///   export QRAI_LIVE_TICKET="$(cat ticket.json)"
///   export QRAI_LIVE_GATEWAY="http://127.0.0.1:8084"
///   flutter test test/live_gateway_test.dart
///
/// What it proves that a mock cannot: the ticket the API mints is one the gateway ACCEPTS, the URL
/// this client builds is one it routes, and the frames it sends are ones it takes. Three
/// independently-written pieces agreeing — the ticket format is HMAC-signed by Rust and verified by
/// Rust, and this client only ever handles it as an opaque string.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/api/models.dart';
import 'package:qrai/src/practice/streaming_recorder.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

void main() {
  final String? ticketJson = Platform.environment['QRAI_LIVE_TICKET'];
  final String gateway = Platform.environment['QRAI_LIVE_GATEWAY'] ?? 'http://127.0.0.1:8084';

  test('the real gateway accepts a real ticket and takes real frames', () async {
    final RealtimeTicket ticket =
        RealtimeTicket.fromJson(jsonDecode(ticketJson!) as Map<String, dynamic>);

    final List<Object?> fromGateway = <Object?>[];
    final StreamController<Uint8List> pcm = StreamController<Uint8List>();

    final StreamingRecorder recorder = StreamingRecorder(
      ticket: ticket,
      gatewayBase: Uri.parse(gateway),
      // The REAL connect, wrapped only to observe what comes back. The URL under test is the one
      // `audioUriFor` builds — if it were wrong, this would fail at the handshake.
      socketFactory: (Uri uri) {
        final WebSocketChannel c = WebSocketChannel.connect(uri);
        c.stream.listen(fromGateway.add, onError: (Object _) {});
        return c;
      },
      pcmStreamFactory: (int rate) async {
        expect(rate, ticket.allowedSampleRates.first, reason: 'recorded at a rate not on the ticket');
        return pcm.stream;
      },
    );

    // If the gateway refuses the ticket, `start` throws here and the test says so.
    await recorder.start();

    // 20 ms of silence at 16 kHz mono PCM16 — a real frame shape, not a token payload.
    final Uint8List frame = Uint8List(ticket.allowedSampleRates.first ~/ 50 * 2);
    for (int i = 0; i < 5; i += 1) {
      pcm.add(frame);
      await Future<void>.delayed(const Duration(milliseconds: 60));
    }
    await Future<void>.delayed(const Duration(milliseconds: 400));
    await recorder.stop();
    await pcm.close();

    // The gateway acknowledges chunks it accepted. An empty list means it upgraded and then ignored
    // everything, which would look like success from this side and be a silent data-loss bug.
    expect(fromGateway, isNotEmpty, reason: 'the gateway never acknowledged a frame');
    // ignore: avoid_print
    print('gateway replied ${fromGateway.length} message(s); first: ${fromGateway.first}');
  }, skip: ticketJson == null ? 'set QRAI_LIVE_TICKET to run against a live stack' : null);
}
