/// AUD1 — the practice flow, end to end without a microphone or a gateway.
///
/// The screen the audit found missing. These cases assert the two properties that matter more than
/// the layout: the consent record actually reaches the wire, and the guardian gate refuses BEFORE a
/// recorder exists — not after, and not by disabling a button.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qrai/src/api/api_client.dart';
import 'package:qrai/src/api/models.dart';
import 'package:qrai/src/practice/consent_gate.dart';
import 'package:qrai/src/practice/practice_screen.dart';

/// Records that it was built and started, so a test can assert on both separately — "constructed"
/// and "started" are different failures.
class SpyRecorder implements AudioRecorder {
  bool started = false;
  bool stopped = false;

  @override
  Future<void> start() async => started = true;
  @override
  Future<void> stop() async => stopped = true;
  @override
  Future<void> dispose() async {}
}

/// Answers both POSTs the flow makes, and keeps every request body for inspection.
ApiClient stubClient(List<http.Request> seen) {
  final MockClient mock = MockClient((http.Request req) async {
    seen.add(req);
    if (req.url.path == '/v1/recitation-sessions') {
      return http.Response(
        jsonEncode(<String, Object?>{
          'id': 'session-1',
          'tenantId': 'tenant-1',
          'learnerId': 'learner-1',
          'quranRef': <String, Object?>{
            'surahNumber': 1,
            'ayahStart': 1,
            'ayahEnd': 7,
            'display': 'Surah 1 1-7',
          },
          'reviewStatus': 'draft',
        }),
        200,
        headers: <String, String>{'content-type': 'application/json'},
      );
    }
    return http.Response(
      jsonEncode(<String, Object?>{
        'token': 'rt_v1.session-1.tenant-1.learner-1.false.9999999999.n.${'0' * 64}',
        'sessionId': 'session-1',
        'tenantId': 'tenant-1',
        'learnerId': 'learner-1',
        'expiresAt': '9999999999',
        'allowedSampleRates': <int>[16000],
        'externalAsrProcessing': false,
      }),
      200,
      headers: <String, String>{'content-type': 'application/json'},
    );
  });
  return ApiClient(
    baseUrl: Uri.parse('http://127.0.0.1:8080'),
    tokenProvider: () async => null,
    httpClient: mock,
  );
}

Widget host(
  ApiClient client,
  AudioRecorder Function(RealtimeTicket)? recorder, {
  bool micGranted = true,
}) =>
    MaterialApp(
      home: Scaffold(
        body: PracticeScreen(
          client: client,
          gatewayBase: Uri.parse('http://127.0.0.1:8081'),
          learnerId: 'learner-1',
          recorderOverride: recorder,
          // There is no platform channel under `flutter test`; the REAL check is what ships.
          micPermission: () async => micGranted,
        ),
      ),
    );

/// Scroll it into view, THEN tap. The practice form is taller than the default test viewport, and a
/// tap that misses silently does nothing — which made two of these cases pass for the wrong reason
/// on their first run.
Future<void> tapKey(WidgetTester tester, String key) async {
  final Finder finder = find.byKey(ValueKey<String>(key));
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder, warnIfMissed: true);
  await tester.pumpAndSettle();
}

/// The status line, read by key — matching on prose would also match the consent labels above it.
String? statusText(WidgetTester tester) {
  final Finder finder = find.byKey(const ValueKey<String>('practice-status'));
  if (finder.evaluate().isEmpty) return null;
  return (tester.widget(finder) as Text).data;
}

void main() {
  testWidgets('nothing is pre-consented — every switch starts off', (WidgetTester tester) async {
    await tester.pumpWidget(host(stubClient(<http.Request>[]), (RealtimeTicket _) => SpyRecorder()));

    for (final String key in <String>[
      'consent-anonymized',
      'consent-external-asr',
      'consent-guardian',
    ]) {
      final SwitchListTile tile =
          tester.widget(find.byKey(ValueKey<String>(key))) as SwitchListTile;
      expect(tile.value, isFalse, reason: '$key arrived already agreed to');
    }
  });

  testWidgets('without guardian approval NO recorder is ever constructed', (WidgetTester tester) async {
    SpyRecorder? built;
    final List<http.Request> seen = <http.Request>[];
    await tester.pumpWidget(host(stubClient(seen), (RealtimeTicket _) => built = SpyRecorder()));

    await tapKey(tester, 'practice-toggle');

    // The strong claim: not "started and stopped", not "constructed but idle". Never built.
    expect(built, isNull, reason: 'a recorder existed for a learner with no guardian approval');
    // By key, and asserting the REFUSAL text — `findsOneWidget` on "parent or guardian" would also
    // match the consent switch's own label, so it passed before the button was even reachable.
    expect(
      statusText(tester),
      contains('parent or guardian'),
      reason: 'the refusal must say what would unblock it',
    );
    // And it must be the refusal, not a network failure wearing the same screen.
    expect(seen, isEmpty, reason: 'a session was created for a learner who may not record');
  });

  testWidgets('with consent, the session carries it and recording starts', (WidgetTester tester) async {
    SpyRecorder? built;
    final List<http.Request> seen = <http.Request>[];
    await tester.pumpWidget(host(stubClient(seen), (RealtimeTicket _) => built = SpyRecorder()));

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'retention-teacher-review');
    await tapKey(tester, 'practice-toggle');

    expect(built, isNotNull);
    expect(built!.started, isTrue);

    // The consent the learner gave is what went to the server — not a default, not an assumption.
    final http.Request create =
        seen.firstWhere((http.Request r) => r.url.path == '/v1/recitation-sessions');
    final Map<String, Object?> body = jsonDecode(create.body) as Map<String, Object?>;
    final Map<String, Object?> consent = body['consent']! as Map<String, Object?>;
    expect(consent['guardianApproved'], isTrue);
    expect(consent['audioRetention'], 'teacher-review');
    expect(consent['externalAsrProcessing'], isFalse);
    expect(consent['consentVersion'], 'pilot-v1');

    // The ticket is requested only AFTER the session exists — a ticket for a session that was
    // never created would be a live microphone with no consent record behind it.
    expect(seen.map((http.Request r) => r.url.path).toList(), <String>[
      '/v1/recitation-sessions',
      '/v1/realtime-session-tickets',
    ]);
  });

  testWidgets('stopping stops the recorder', (WidgetTester tester) async {
    SpyRecorder? built;
    await tester.pumpWidget(
      host(stubClient(<http.Request>[]), (RealtimeTicket _) => built = SpyRecorder()),
    );

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');
    expect(built, isNotNull, reason: 'nothing started, so "stop" would prove nothing');
    await tapKey(tester, 'practice-toggle');

    expect(built!.stopped, isTrue, reason: 'the microphone was left open');
  });

  testWidgets('a denied microphone refuses, and says so', (WidgetTester tester) async {
    // The branch that was unreachable while `requestMicPermission` was hardcoded to true. Consent
    // passes here; the OS is what refuses, and the learner is told which of the two it was.
    SpyRecorder? built;
    final List<http.Request> seen = <http.Request>[];
    await tester.pumpWidget(
      host(stubClient(seen), (RealtimeTicket _) => built = SpyRecorder(), micGranted: false),
    );

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');

    expect(statusText(tester), contains('microphone'));
    // Nothing was CREATED either. The OS prompt now comes before the session, so a learner who
    // declines the microphone leaves behind no session row carrying their consent and no live
    // gateway ticket — the same assertion the guardian case makes, one layer down.
    expect(seen, isEmpty, reason: 'a session or ticket was created despite the OS refusing the mic');
    // A recorder IS constructed before the permission check?  No: the gate asks the OS first and
    // only then calls the factory. If this ever fails, that ordering has regressed.
    expect(built, isNull, reason: 'a recorder existed despite the OS refusing the microphone');
  });

  testWidgets('a transport failure leaks no errno, address or URI', (WidgetTester tester) async {
    // Measured against a dead server, `ApiException.message` is:
    //   request did not reach the server: ClientException with SocketException: Connection refused
    //   (OS Error: Connection refused, errno = 61), address = 127.0.0.1, port = 59493, uri=http://…
    // That used to be interpolated straight into the screen.
    final ApiClient dead = ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: MockClient((http.Request _) async =>
          throw ApiException(ApiErrorKind.offline,
              'request did not reach the server: SocketException: Connection refused '
              '(OS Error: Connection refused, errno = 61), address = 127.0.0.1, port = 59493')),
    );

    await tester.pumpWidget(host(dead, (RealtimeTicket _) => SpyRecorder()));
    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');

    final String shown = statusText(tester)!;
    expect(shown, contains('Could not start'));
    // The learner is told what it means for them, in the same words every other screen uses.
    expect(shown, contains("You're offline"));
    for (final String leak in <String>['errno', 'address =', 'port =', 'SocketException', 'uri=']) {
      expect(shown, isNot(contains(leak)), reason: '$leak reached the learner');
    }
  });
}

