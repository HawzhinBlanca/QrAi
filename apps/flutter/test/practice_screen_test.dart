/// AUD1 — the practice flow, end to end without a microphone or a gateway.
///
/// The screen the audit found missing. These cases assert the two properties that matter more than
/// the layout: the consent record actually reaches the wire, and the guardian gate refuses BEFORE a
/// recorder exists — not after, and not by disabling a button.
library;

import 'dart:async';
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

/// One tajweed finding as the ML proxy actually returns them.
///
/// `reviewStatus` defaults to `ai-suggested` because that is what `services/ml-inference` stamps on
/// EVERY finding, on both its branches. A stub that defaulted to `scholar-approved` would test a
/// response the service has never produced.
Map<String, Object?> stubFinding({
  String rule = 'ghunnah',
  String reviewStatus = 'ai-suggested',
  double confidence = 0.9,
}) =>
    <String, Object?>{
      'wordId': '1:1:1',
      'rule': rule,
      'severity': 'practice',
      'explanation': 'Apply ghunnah on the noon sakina.',
      'reviewStatus': reviewStatus,
      'confidence': confidence,
      'sources': <Map<String, Object?>>[
        <String, Object?>{'id': 's1', 'title': 'Tajweed rules', 'citation': 'Ch. 4'},
      ],
    };

/// The responses the flow needs, shared by the stub client and by tests that drive their own.
///
/// `stored` is what `GET /v1/recitation-sessions/{id}/tajweed-findings` returns and defaults to the
/// same list as the analysis — the shape of a session whose words were aligned, so everything the
/// analyser produced was persisted. Passing `stored: []` models the other real case: nothing could
/// be anchored, so nothing was stored.
http.Response stubResponseFor(
  http.Request req, {
  List<Map<String, Object?>>? findings,
  List<Map<String, Object?>>? stored,
}) {
  if (req.url.path.endsWith('/tajweed-findings')) {
    return http.Response(
      jsonEncode(stored ?? findings ?? <Map<String, Object?>>[stubFinding()]),
      200,
      headers: <String, String>{'content-type': 'application/json'},
    );
  }
  if (req.url.path == '/v1/ml/tajweed-findings:predict') {
    return http.Response(
      jsonEncode(<String, Object?>{
        'findings': findings ?? <Map<String, Object?>>[stubFinding()],
        'confidence': 0.9,
      }),
      200,
      headers: <String, String>{'content-type': 'application/json'},
    );
  }
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
}

/// Answers both POSTs the flow makes, and keeps every request body for inspection.
ApiClient stubClient(List<http.Request> seen) {
  final MockClient mock = MockClient((http.Request req) async {
    seen.add(req);
    return stubResponseFor(req);
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

  testWidgets('a stop that fails does not leave the screen claiming to be recording',
      (WidgetTester tester) async {
    // The status line used to keep its last value when gate.stop() threw, so the button flipped to
    // "Start reciting" while the screen still read "Recording Surah 1 1-7" — and the error escaped
    // unhandled. A learner told they are recording when they are not is the failure this catches.
    await tester.pumpWidget(
      host(stubClient(<http.Request>[]), (RealtimeTicket _) => _StopThrows()),
    );

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');
    expect(statusText(tester), contains('Recording'));

    await tapKey(tester, 'practice-toggle');

    final String shown = statusText(tester)!;
    expect(shown, isNot(contains('Recording Surah')), reason: 'still claims to be recording');
    expect(shown, contains('Recording stopped'));
    // Never claims the recitation was delivered, because that is not known.
    expect(shown, isNot(contains('sent for review')));
  });
  testWidgets('a failure that lands after the screen is gone does not throw',
      (WidgetTester tester) async {
    // Reachable: HomeShell builds `tabs[_tab]`, so switching tabs disposes this screen. Tap Start,
    // switch away while createRecitationSession is still in flight, and the catch block used to
    // call setState on a disposed State — "setState() called after dispose()". The success path
    // was guarded; the three failure paths were not.
    final Completer<void> inFlight = Completer<void>();
    final ApiClient slowFailure = ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: MockClient((http.Request _) async {
        await inFlight.future;
        throw ApiException(ApiErrorKind.offline, 'gone');
      }),
    );

    await tester.pumpWidget(host(slowFailure, (RealtimeTicket _) => SpyRecorder()));
    await tapKey(tester, 'consent-guardian');
    await tester.tap(find.byKey(const ValueKey<String>('practice-toggle')));
    await tester.pump();

    // The learner navigates away while the request is still open.
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox())));
    inFlight.complete();
    await tester.pumpAndSettle();

    // No exception. `tester.takeException()` returns null when nothing was thrown.
    expect(tester.takeException(), isNull, reason: 'setState ran on a disposed State');
  });
  testWidgets('P0: a SUCCESS that lands after dispose does not leave the mic running',
      (WidgetTester tester) async {
    // The sibling of the late-FAILURE case above, and the one that mattered. The session and ticket
    // calls SUCCEED — this is the happy path — but slowly, and the learner switches tabs while they
    // are in flight. `_gate` used to be assigned only AFTER start(), so dispose() found null,
    // start() then opened the microphone, and the early `!mounted` return dropped the only
    // reference to it. Recording, on a child's device, with nothing able to stop it.
    final Completer<void> inFlight = Completer<void>();
    SpyRecorder? built;

    final ApiClient slowSuccess = ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: MockClient((http.Request req) async {
        await inFlight.future;
        return stubResponseFor(req);
      }),
    );

    await tester.pumpWidget(
      host(slowSuccess, (RealtimeTicket _) => built = SpyRecorder()),
    );
    await tapKey(tester, 'consent-guardian');
    await tester.tap(find.byKey(const ValueKey<String>('practice-toggle')));
    await tester.pump();

    // The learner navigates away while the session/ticket calls are still open.
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox())));
    inFlight.complete();
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(built, isNotNull, reason: 'the recorder was never constructed; the race is untested');
    expect(built!.started, isTrue, reason: 'start() did not run; the race is untested');
    // The assertion the P0 is about.
    expect(built!.stopped, isTrue,
        reason: 'the microphone was left running with no owner after the screen was disposed');
  });

  // ── The learner-facing end of the loop (FL6 wiring) ───────────────────────────────────────────────
  // Before this, practice was write-only: a recitation went up and nothing came back. `TajweedPanel`
  // and its gate existed, fully tested, wired to nothing. These cases assert the wiring itself.

  testWidgets('stopping asks for feedback on THAT session', (WidgetTester tester) async {
    final List<http.Request> seen = <http.Request>[];
    await tester.pumpWidget(host(stubClient(seen), (RealtimeTicket _) => SpyRecorder()));

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');
    await tapKey(tester, 'practice-toggle');
    await tester.pumpAndSettle();

    final Iterable<http.Request> predicts =
        seen.where((http.Request r) => r.url.path == '/v1/ml/tajweed-findings:predict');
    expect(predicts, hasLength(1), reason: 'the analysis was never requested');

    final Map<String, dynamic> body =
        jsonDecode(predicts.single.body) as Map<String, dynamic>;
    expect(body['sessionId'], 'session-1', reason: 'analysis must name the session that was recorded');
      // tenantId and consent are the server's to decide (proxy_ml overwrites both). A client that
      // sent them would be claiming something it is not entitled to claim.
    expect(body.containsKey('tenantId'), isFalse);
    expect(body.containsKey('consent'), isFalse);
  });

  testWidgets('unreviewed findings are WITHHELD, and the learner is told they exist',
      (WidgetTester tester) async {
      // The honest default: ml-inference returns ai-suggested, so nothing is shown — but "nothing to
      // show" and "nothing found" are different facts and the learner gets the true one.
    await tester.pumpWidget(host(stubClient(<http.Request>[]), (RealtimeTicket _) => SpyRecorder()));

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');
    await tapKey(tester, 'practice-toggle');
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey<String>('practice-findings')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('tajweed-none')), findsOneWidget);
    expect(find.textContaining('waiting for a teacher'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('tajweed-list')), findsNothing,
        reason: 'an ai-suggested finding must never render as feedback');
  });

  testWidgets('an APPROVED finding does reach the learner, with its source',
      (WidgetTester tester) async {
      // The gate is not a wall: once a human has approved a confident, sourced finding, it shows.
      // Without this case the panel could be permanently broken and every other test would still pass.
    final MockClient mock = MockClient((http.Request req) async => stubResponseFor(
          req,
          findings: <Map<String, Object?>>[
            stubFinding(rule: 'ghunnah', reviewStatus: 'scholar-approved', confidence: 0.95),
          ],
        ));
    final ApiClient client = ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: mock,
    );
    await tester.pumpWidget(host(client, (RealtimeTicket _) => SpyRecorder()));

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');
    await tapKey(tester, 'practice-toggle');
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey<String>('tajweed-list')), findsOneWidget);
    expect(find.textContaining('Tajweed rules'), findsOneWidget, reason: 'no source shown');
    expect(find.textContaining('95%'), findsOneWidget, reason: 'no confidence shown');
  });

  testWidgets('a failed ANALYSIS never says the recording failed', (WidgetTester tester) async {
      // The bug this exists to prevent: folding the analysis into _stop's try block, so a 500 from the
      // ML proxy overwrites "sent for review" and tells a learner their recitation may not have
      // arrived. It did arrive — the analysis is a separate step and a separate failure.
    final MockClient mock = MockClient((http.Request req) async =>
        req.url.path == '/v1/ml/tajweed-findings:predict'
            ? http.Response('{"error":"upstream exploded"}', 500,
                headers: <String, String>{'content-type': 'application/json'})
            : stubResponseFor(req));
    final ApiClient client = ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: mock,
    );
    await tester.pumpWidget(host(client, (RealtimeTicket _) => SpyRecorder()));

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');
    await tapKey(tester, 'practice-toggle');
    await tester.pumpAndSettle();

    expect(statusText(tester), 'Stopped. Your recitation was sent for review.',
        reason: 'an analysis failure must not be reported as a recording failure');
    expect(find.byKey(const ValueKey<String>('load-failed')), findsOneWidget,
        reason: 'the learner must not be shown an empty panel when the request failed');
    expect(tester.takeException(), isNull);
  });

  testWidgets('feedback that lands after the screen is gone does not throw',
      (WidgetTester tester) async {
      // The same class of bug as the P0 above, one layer out: _loadFindings runs AFTER _stop has
      // returned, so its setState can land on a disposed widget.
    final Completer<http.Response> analysis = Completer<http.Response>();
    final MockClient mock = MockClient((http.Request req) async =>
        req.url.path == '/v1/ml/tajweed-findings:predict'
            ? analysis.future
            : stubResponseFor(req));
    final ApiClient client = ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: mock,
    );
    await tester.pumpWidget(host(client, (RealtimeTicket _) => SpyRecorder()));

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');
    await tapKey(tester, 'practice-toggle');
    await tester.pump();

      // The screen goes away while the analysis is still in flight.
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox.shrink())));
    analysis.complete(stubResponseFor(
      http.Request('POST', Uri.parse('http://x/v1/ml/tajweed-findings:predict')),
    ));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull,
        reason: 'setState after dispose, or an unhandled async failure');
  });

  testWidgets('the STORED findings win — that is what carries a teacher decision back',
      (WidgetTester tester) async {
    // The analysis route always answers `ai-suggested` (it re-analyses rather than reading), so if
    // the screen displayed its result the learner could never be shown an approved note no matter
    // how many teachers reviewed it. Analysis says pending; storage says scholar-approved; the
    // learner must see the approval.
    final List<http.Request> seen = <http.Request>[];
    final MockClient mock = MockClient((http.Request req) async {
      seen.add(req);
      return stubResponseFor(
        req,
        findings: <Map<String, Object?>>[stubFinding(reviewStatus: 'ai-suggested')],
        stored: <Map<String, Object?>>[
          stubFinding(reviewStatus: 'scholar-approved', confidence: 0.95),
        ],
      );
    });
    await tester.pumpWidget(host(
      ApiClient(
        baseUrl: Uri.parse('http://127.0.0.1:8080'),
        tokenProvider: () async => null,
        httpClient: mock,
      ),
      (RealtimeTicket _) => SpyRecorder(),
    ));

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');
    await tapKey(tester, 'practice-toggle');
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey<String>('tajweed-list')), findsOneWidget,
        reason: 'the approved stored finding must be shown, not the pending computed one');
    expect(find.textContaining('95%'), findsOneWidget);

    // Analysis is still requested: it is what makes the server persist the findings at all.
    expect(
      seen.where((http.Request r) => r.url.path == '/v1/ml/tajweed-findings:predict'),
      hasLength(1),
    );
    expect(
      seen.where((http.Request r) => r.url.path.endsWith('/tajweed-findings')),
      hasLength(1),
    );
  });

  testWidgets('when NOTHING could be stored, the computed findings still say notes are waiting',
      (WidgetTester tester) async {
    // A session whose words were never aligned persists nothing — the Flutter practice flow's shape
    // today. Falling back to the computed set cannot overstate anything (all `ai-suggested`, all
    // withheld) and it is the difference between "3 notes are waiting" and a false "no feedback".
    final MockClient mock = MockClient((http.Request req) async => stubResponseFor(
          req,
          findings: <Map<String, Object?>>[
            stubFinding(rule: 'a'),
            stubFinding(rule: 'b'),
            stubFinding(rule: 'c'),
          ],
          stored: <Map<String, Object?>>[],
        ));
    await tester.pumpWidget(host(
      ApiClient(
        baseUrl: Uri.parse('http://127.0.0.1:8080'),
        tokenProvider: () async => null,
        httpClient: mock,
      ),
      (RealtimeTicket _) => SpyRecorder(),
    ));

    await tapKey(tester, 'consent-guardian');
    await tapKey(tester, 'practice-toggle');
    await tapKey(tester, 'practice-toggle');
    await tester.pumpAndSettle();

    expect(find.textContaining('3 notes are waiting'), findsOneWidget);
  });
}

/// A recorder whose stop() fails, as a platform channel can.
class _StopThrows implements AudioRecorder {
  @override
  Future<void> start() async {}
  @override
  Future<void> stop() async => throw StateError('platform channel died');
  @override
  Future<void> dispose() async {}
}
