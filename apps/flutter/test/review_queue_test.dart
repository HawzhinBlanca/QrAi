/// The teacher review queue.
///
/// Two classes of claim are asserted here and they matter for different reasons:
///
///  * **the wire** — a decision reaches `POST /v1/teacher-reviews` with the right body, and the
///    server's answer is what gets displayed; and
///  * **the honesty** — the screen states what a decision actually did, in both directions. Since
///    ADR-0027 accepting DOES release a note to the learner, so the pre-ADR wording ("unchanged")
///    would now understate it; and promotion is necessary but not sufficient, so claiming a plain
///    "released" would overstate it. Both failures are asserted against.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qrai/src/api/api_client.dart';
import 'package:qrai/src/api/models.dart';
import 'package:qrai/src/auth/actor.dart';
import 'package:qrai/src/review/review_queue_screen.dart';

/// A persisted finding, as `GET /v1/tajweed-findings` returns them (it selects `tf.id`, unlike the
/// learner's predict route).
Map<String, Object?> stubFinding({
  String id = 'finding-1',
  String rule = 'ghunnah',
  String reviewStatus = 'ai-suggested',
  double confidence = 0.9,
  List<Map<String, Object?>>? sources,
}) =>
    <String, Object?>{
      'id': id,
      'wordId': '1:1:1',
      'rule': rule,
      'analysisBasis': 'acoustic',
      'severity': 'warning',
      'explanation': 'Model suggests the noon sakina was not nasalised.',
      'confidence': confidence,
      'reviewStatus': reviewStatus,
      'sources': sources ??
          <Map<String, Object?>>[
            <String, Object?>{
              'id': 'tajweed-scholar-board',
              'title': 'Quran AI Scholar Board',
              'citation': 'Internal reviewed tajweed explanation policy',
            },
          ],
    };

ApiClient clientFor(
  List<http.Request> seen, {
  List<Map<String, Object?>>? findings,
  int reviewStatus = 200,
}) {
  final MockClient mock = MockClient((http.Request req) async {
    seen.add(req);
    if (req.url.path == '/v1/teacher-reviews') {
      if (reviewStatus != 200) {
        return http.Response('{"error":"nope"}', reviewStatus,
            headers: <String, String>{'content-type': 'application/json'});
      }
      final Map<String, dynamic> body = jsonDecode(req.body) as Map<String, dynamic>;
      return http.Response(
        jsonEncode(<String, Object?>{
          'id': 'teacher-review-1',
          'tenantId': 't',
          'findingId': body['findingId'],
          // The server decides the author and ignores what the client sent. Echoing the request
          // here would hide a regression where the client started trusting its own value.
          'teacherId': 'server-decided-teacher',
          'decision': body['decision'],
          'note': body['note'],
          'auditEventId': 'audit-9',
        }),
        200,
        headers: <String, String>{'content-type': 'application/json'},
      );
    }
    return http.Response(
      jsonEncode(findings ?? <Map<String, Object?>>[stubFinding()]),
      200,
      headers: <String, String>{'content-type': 'application/json'},
    );
  });
  return ApiClient(
    baseUrl: Uri.parse('http://127.0.0.1:8080'),
    tokenProvider: () async => 'tok',
    httpClient: mock,
  );
}

const Actor teacher =
    Actor(userId: 'teacher-1', tenantId: 'hikmah-pilot-erbil', role: ActorRole.teacher);

Future<void> pump(WidgetTester tester, ApiClient client) async {
  await tester.pumpWidget(
    MaterialApp(home: Scaffold(body: ReviewQueueScreen(client: client, actor: teacher))),
  );
  await tester.pumpAndSettle();
}

void main() {
  test('pendingForReview keeps work and drops what is finished', () {
    TajweedFinding of(String status) =>
        TajweedFinding.fromJson(stubFinding(reviewStatus: status));

    final List<TajweedFinding> pending = pendingForReview(<TajweedFinding>[
      of('ai-suggested'),
      of('draft'),
      of('teacher-review-required'),
      of('teacher-reviewed'),
      of('scholar-approved'),
      of('blocked'),
      // A status nobody taught this client about. It must count as PENDING: showing a teacher an
      // extra item is recoverable, silently dropping one from the queue is not.
      of('quarantined-pending-scholar'),
    ]);
    expect(
      pending.map((TajweedFinding f) => f.reviewStatus),
      <String>['ai-suggested', 'draft', 'teacher-review-required', 'quarantined-pending-scholar'],
    );
  });

  testWidgets('the queue asks the staff route, unscoped', (WidgetTester tester) async {
    final List<http.Request> seen = <http.Request>[];
    await pump(tester, clientFor(seen));

    final http.Request q = seen.firstWhere((http.Request r) => r.method == 'GET');
    expect(q.url.path, '/v1/tajweed-findings');
    // The handler filters on tenant only. A sessionId here would look like scoping that does not
    // happen — the server would ignore it and the whole tenant would come back regardless.
    expect(q.url.queryParameters, isEmpty);
    expect(find.byKey(const ValueKey<String>('review-finding-finding-1')), findsOneWidget);
  });

  testWidgets('a decision reaches the wire with the right body', (WidgetTester tester) async {
    final List<http.Request> seen = <http.Request>[];
    await pump(tester, clientFor(seen));

    await tester.enterText(
        find.byKey(const ValueKey<String>('review-note-finding-1')), 'Confirmed by ear.');
    await tester.tap(find.byKey(const ValueKey<String>('review-accept-finding-1')));
    await tester.pumpAndSettle();

    final http.Request post =
        seen.firstWhere((http.Request r) => r.url.path == '/v1/teacher-reviews');
    final Map<String, dynamic> body = jsonDecode(post.body) as Map<String, dynamic>;
    expect(body['findingId'], 'finding-1');
    expect(body['decision'], 'accepted', reason: 'serde renders the unit variant lowercase');
    expect(body['note'], 'Confirmed by ear.');
    expect(body['teacherId'], 'teacher-1');
  });

  testWidgets('the recorded decision names what it did, and the audit id', (WidgetTester tester) async {
    // ADR-0027: accepting promotes the finding to `teacher-reviewed`, so the wording must not
    // repeat the pre-ADR claim that nothing reaches the learner — and must not overclaim either,
    // because promotion is necessary, not sufficient (sources and the 0.82 floor still apply).
    await pump(tester, clientFor(<http.Request>[]));

    await tester.tap(find.byKey(const ValueKey<String>('review-accept-finding-1')));
    await tester.pumpAndSettle();

    final Finder recorded = find.byKey(const ValueKey<String>('review-recorded-finding-1'));
    expect(recorded, findsOneWidget);
    final String text = (tester.widget(recorded) as Text).data!;
    expect(text, contains('accepted'));
    expect(text, contains('cleared for learners'));
    expect(text, contains('sources and confidence permitting'),
        reason: 'promotion alone does not make a finding visible');
    expect(text, contains('audit-9'), reason: 'the audit id is what makes a decision traceable');
    expect(text.toLowerCase(), isNot(contains('unchanged')),
        reason: 'the pre-ADR-0027 wording; a teacher would be told their work did nothing');

    // Still on screen: the list is not refetched, so the teacher can see the tap registered.
    expect(find.byKey(const ValueKey<String>('review-finding-finding-1')), findsOneWidget);
  });

  testWidgets('rejecting says blocked, and an unknown verdict does not guess',
      (WidgetTester tester) async {
    // The `_ => ...` branch covers `edited` and anything this client has never heard of. Describing
    // an unknown verdict's effect would be a guess presented to a teacher as fact.
    await pump(tester, clientFor(<http.Request>[]));
    await tester.tap(find.byKey(const ValueKey<String>('review-reject-finding-1')));
    await tester.pumpAndSettle();
    final String text = (tester.widget(
            find.byKey(const ValueKey<String>('review-recorded-finding-1'))) as Text)
        .data!;
    expect(text, contains('rejected'));
    expect(text, contains('blocked'));
  });

  testWidgets('a failed submission says so and does not claim a decision', (WidgetTester tester) async {
    await pump(tester, clientFor(<http.Request>[], reviewStatus: 403));

    await tester.tap(find.byKey(const ValueKey<String>('review-accept-finding-1')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey<String>('review-error')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('review-recorded-finding-1')), findsNothing,
        reason: 'a 403 must never render as a recorded decision');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a sourceless finding says why, and Accept is not tappable',
      (WidgetTester tester) async {
    // The server REFUSES an unsourced acceptance (ADR-0027 item 6). Leaving the button live would
    // spend a teacher's judgement and answer 400; the rule is knowable before they tap. Reject
    // stays live — an unsourced finding must not be trapped in the queue forever.
    await pump(
      tester,
      clientFor(<http.Request>[],
          findings: <Map<String, Object?>>[stubFinding(sources: <Map<String, Object?>>[])]),
    );
    expect(find.byKey(const ValueKey<String>('review-nosource-finding-1')), findsOneWidget);

    final FilledButton accept =
        tester.widget(find.byKey(const ValueKey<String>('review-accept-finding-1')));
    expect(accept.onPressed, isNull, reason: 'Accept must be disabled without a source');

    final OutlinedButton reject =
        tester.widget(find.byKey(const ValueKey<String>('review-reject-finding-1')));
    expect(reject.onPressed, isNotNull, reason: 'rejecting an unsourced finding is the way out');
  });

  testWidgets('a SOURCED finding keeps Accept live', (WidgetTester tester) async {
    // The other direction: a guard that disabled Accept everywhere would be safe and useless.
    await pump(tester, clientFor(<http.Request>[]));
    final FilledButton accept =
        tester.widget(find.byKey(const ValueKey<String>('review-accept-finding-1')));
    expect(accept.onPressed, isNotNull);
  });

  testWidgets('every finding shows its provenance before a decision is asked for',
      (WidgetTester tester) async {
    await pump(tester, clientFor(<http.Request>[]));
    expect(
      find.byKey(const ValueKey<String>('review-source-finding-1-tajweed-scholar-board')),
      findsOneWidget,
    );
    expect(find.textContaining('Quran AI Scholar Board'), findsOneWidget);
  });

  testWidgets('an empty queue does not look like a failure', (WidgetTester tester) async {
    await pump(tester, clientFor(<http.Request>[], findings: <Map<String, Object?>>[]));
    expect(find.byKey(const ValueKey<String>('review-empty')), findsOneWidget);
  });

  testWidgets('a 403 on the queue itself renders as a failure, not an empty queue',
      (WidgetTester tester) async {
    // The difference matters: "nothing to review" and "you are not allowed to review" would look
    // identical if the error were swallowed, and only one of them means the teacher can go home.
    final MockClient mock = MockClient((http.Request req) async => http.Response(
        '{"error":"actor is not allowed to perform this action"}', 403,
        headers: <String, String>{'content-type': 'application/json'}));
    await pump(
      tester,
      ApiClient(
        baseUrl: Uri.parse('http://127.0.0.1:8080'),
        tokenProvider: () async => 'tok',
        httpClient: mock,
      ),
    );
    expect(find.byKey(const ValueKey<String>('load-failed')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('review-empty')), findsNothing);
  });
}
