/// AUD1 — the app assembles and its tabs are reachable.
///
/// Every other test in this directory exercises one component. This one exists because the audit's
/// finding was not "a component is wrong", it was "there is no application" — and a suite of green
/// component tests is exactly what that failure looks like from the inside.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qrai/main.dart';
import 'package:qrai/src/auth/actor.dart';
import 'package:qrai/src/api/api_client.dart';

ApiClient offlineClient() => ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: MockClient((http.Request _) async => throw const SocketishFailure()),
    );

/// Stands in for a dead network without importing `dart:io` (which web builds cannot).
class SocketishFailure implements Exception {
  const SocketishFailure();
}

ApiClient listingClient() => ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: MockClient((http.Request _) async => http.Response(
            jsonEncode(<Map<String, Object?>>[
              <String, Object?>{
                'surahNumber': 1,
                'name': 'Al-Fatihah',
                'arabicName': 'الفاتحة',
                'translation': 'The Opening',
                'revelationType': 'meccan',
                'ayahCount': 7,
              },
            ]),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          )),
    );

Widget app(ApiClient client, {Actor? actor}) => QrAiApp(
      client: client,
      gatewayBase: Uri.parse('http://127.0.0.1:8081'),
      learnerId: 'learner-1',
      // Null = a device with no readable token, which is the default the learner tabs are built
      // for. Cases that need the Review tab pass a teacher explicitly.
      actor: actor,
    );

void main() {
  testWidgets('the app boots and offers all four destinations', (WidgetTester tester) async {
    await tester.pumpWidget(app(listingClient()));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey<String>('home-nav')), findsOneWidget);
    for (final String label in <String>['Read', 'Practice', 'Progress', 'Privacy']) {
      expect(find.text(label), findsOneWidget, reason: '$label is unreachable');
    }
  });

  testWidgets('the reader lists surahs, with the Arabic name in RTL', (WidgetTester tester) async {
    await tester.pumpWidget(app(listingClient()));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey<String>('surah-list')), findsOneWidget);
    expect(find.text('Al-Fatihah'), findsOneWidget);

    // The canonical-derived name carries its own direction rather than inheriting the app's — the
    // same rule the mushaf applies to ayah text.
    final Directionality dir = tester.widget(
      find.ancestor(of: find.text('الفاتحة'), matching: find.byType(Directionality)).first,
    );
    expect(dir.textDirection, TextDirection.rtl);
  });

  testWidgets('a dead network shows the offline state, not an empty screen', (WidgetTester tester) async {
    await tester.pumpWidget(app(offlineClient()));
    await tester.pumpAndSettle();

    // Whatever the wording, it must be the failure branch and it must offer a way forward — a blank
    // list would be indistinguishable from "this learner has nothing".
    expect(find.byKey(const ValueKey<String>('load-failed')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('surah-list')), findsNothing);
  });

  testWidgets('switching to Practice reaches the consent form', (WidgetTester tester) async {
    await tester.pumpWidget(app(listingClient()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Practice'));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey<String>('practice-screen')), findsOneWidget);
    expect(find.text('Consent'), findsOneWidget);

    // Scrolled, not merely "present in the tree": the form is a lazy ListView, so a widget below
    // the fold is not built at all. Reaching the guardian switch is the claim worth making — it is
    // the control that unblocks recording.
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey<String>('consent-guardian')),
      200,
      // Named explicitly: the screen holds more than one Scrollable, and the default "the only one"
      // lookup throws rather than guessing.
      scrollable: find
          .descendant(
            of: find.byKey(const ValueKey<String>('practice-screen')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(find.byKey(const ValueKey<String>('consent-guardian')), findsOneWidget);
  });

  testWidgets('a malformed payload fails visibly instead of spinning forever', (WidgetTester tester) async {
    // The surah list is valid JSON but omits `name`, which `SurahSummary` requires. `_str` throws a
    // FormatException — a class the transport never wraps, so before this it escaped the future and
    // the screen stayed on its spinner with no error anywhere. A learner cannot tell that apart
    // from a slow network, and it never resolves.
    final ApiClient client = ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: MockClient((http.Request _) async => http.Response(
            jsonEncode(<Map<String, Object?>>[
              <String, Object?>{'surahNumber': 1, 'ayahCount': 7},
            ]),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          )),
    );

    await tester.pumpWidget(app(client));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey<String>('load-failed')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('load-loading')), findsNothing,
        reason: 'still loading — the exception escaped instead of becoming a state');
    // Retryable, because the usual cause is a half-finished deploy that fixes itself.
    expect(find.byKey(const ValueKey<String>('load-retry')), findsOneWidget);
  });

  // ── Who sees the Review tab ────────────────────────────────────────────────────────────────────
  // Navigation only — every route behind it is gated by require_any([Teacher, Admin, Ops]) on the
  // server, and a forged role would get a tab full of 403s rather than access. What this must not
  // do is put a staff console in front of a learner, or hide it from the teacher it exists for.

  testWidgets('a learner never sees the Review tab', (WidgetTester tester) async {
    for (final Actor? who in <Actor?>[
      null, // no token, or one this client cannot read
      const Actor(userId: 'l', tenantId: 't', role: ActorRole.learner),
      // A scholar can LIST findings but create_teacher_review refuses them, so a Review tab would
      // be a queue they cannot act on.
      const Actor(userId: 's', tenantId: 't', role: ActorRole.scholar),
    ]) {
      await tester.pumpWidget(app(listingClient(), actor: who));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(NavigationDestination, 'Review'), findsNothing,
          reason: '${who?.role} must not be offered the review surface');
    }
  });

  testWidgets('a teacher, admin and ops each get it', (WidgetTester tester) async {
    for (final ActorRole role in <ActorRole>[ActorRole.teacher, ActorRole.admin, ActorRole.ops]) {
      await tester.pumpWidget(app(
        listingClient(),
        actor: Actor(userId: 'u', tenantId: 't', role: role),
      ));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(NavigationDestination, 'Review'), findsOneWidget,
          reason: '$role reviews findings and must be able to reach the queue');
    }
  });

  testWidgets('the extra destination selects the review screen, not another tab',
      (WidgetTester tester) async {
    // Tabs and destinations are two lists built from the same condition. If they ever disagree,
    // tapping Review shows whatever sits at that index — which is how a staff console ends up
    // under a learner's finger, or a teacher taps Review and gets Privacy.
    await tester.pumpWidget(app(
      listingClient(),
      actor: const Actor(userId: 'u', tenantId: 't', role: ActorRole.teacher),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(NavigationDestination, 'Review'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey<String>('review-queue')), findsOneWidget);
  });
}
