/// FL8 — offline and error states.
///
/// The property: stale data can never be rendered without saying it is stale. `Stale` carries the
/// failure with it, so there is no way to hold cached data without also holding the reason.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/api/api_client.dart';
import 'package:qrai/src/shell/load_state.dart';

Future<void> pump(
  WidgetTester tester,
  LoadState<String> state, {
  VoidCallback? onRetry,
}) =>
    tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LoadStateView<String>(
            state: state,
            onRetry: onRetry,
            builder: (_, String v) => Text(v, key: const ValueKey<String>('content')),
          ),
        ),
      ),
    );

void main() {
  final ApiException offline = ApiException(ApiErrorKind.offline, 'no route to host');
  final ApiException forbidden = ApiException(ApiErrorKind.forbidden, 'nope', statusCode: 403);

  testWidgets('loading shows a spinner and no content', (tester) async {
    await pump(tester, const Loading<String>());
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('content')), findsNothing);
  });

  testWidgets('loaded shows content and NO stale banner', (tester) async {
    await pump(tester, const Loaded<String>('fresh'));
    expect(find.text('fresh'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('stale-banner')), findsNothing);
  });

  testWidgets('STALE always shows the banner alongside the cached content', (tester) async {
    // The whole point: the learner still sees their data, and is told it may not be current.
    await pump(tester, Stale<String>('yesterday', offline));
    expect(find.text('yesterday'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('stale-banner')), findsOneWidget);
    expect(find.textContaining("You're offline"), findsOneWidget);
  });

  testWidgets('a failure with no cached data shows the reason, not a blank screen', (tester) async {
    await pump(tester, Failed<String>(forbidden));
    expect(find.byKey(const ValueKey<String>('content')), findsNothing);
    expect(find.textContaining("don't have access"), findsOneWidget);
  });

  testWidgets('retry is offered for a RETRYABLE failure only', (tester) async {
    await pump(tester, Failed<String>(offline), onRetry: () {});
    expect(find.byKey(const ValueKey<String>('load-retry')), findsOneWidget);

    // Offering "try again" on a 403 invites a learner to press it forever.
    await pump(tester, Failed<String>(forbidden), onRetry: () {});
    expect(find.byKey(const ValueKey<String>('load-retry')), findsNothing);
  });

  testWidgets('the retry callback actually fires', (tester) async {
    int calls = 0;
    await pump(tester, Failed<String>(offline), onRetry: () => calls += 1);
    await tester.tap(find.byKey(const ValueKey<String>('load-retry')));
    expect(calls, 1);
  });

  test('every ApiErrorKind has a message — a new one cannot fall through silently', () {
    for (final ApiErrorKind kind in ApiErrorKind.values) {
      final String message = messageFor(ApiException(kind, 'x'));
      expect(message, isNotEmpty, reason: '$kind has no user-facing message');
    }
  });
}
