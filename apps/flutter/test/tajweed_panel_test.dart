/// FL6 — the learner-facing feedback surface.
///
/// The gate is enforced twice, deliberately: the model REFUSES to parse a finding without status,
/// confidence and source (tested in tajweed_gate_test.dart), and this widget filters on
/// `isLearnerVisible` and renders the provenance alongside anything it shows.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/api/models.dart';
import 'package:qrai/src/feedback/tajweed_panel.dart';

TajweedFinding finding({
  String id = 'f1',
  String status = 'scholar-approved',
  double confidence = 0.93,
  String source = 'tajweed-rules-v2',
}) =>
    TajweedFinding.fromJson(<String, dynamic>{
      'id': id,
      'rule': 'ghunnah',
      'status': status,
      'confidence': confidence,
      'source': source,
    });

Future<void> pump(WidgetTester tester, List<TajweedFinding> findings) => tester.pumpWidget(
      MaterialApp(home: Scaffold(body: TajweedPanel(findings: findings))),
    );

void main() {
  testWidgets('only scholar-approved findings are rendered', (tester) async {
    await pump(tester, <TajweedFinding>[
      finding(id: 'ok', status: 'scholar-approved'),
      finding(id: 'draft', status: 'draft'),
      finding(id: 'pending', status: 'teacher-review-required'),
      finding(id: 'teacher', status: 'teacher-reviewed'),
      finding(id: 'blocked', status: 'blocked'),
    ]);

    expect(find.byKey(const ValueKey<String>('finding-ok')), findsOneWidget);
    for (final String hidden in <String>['draft', 'pending', 'teacher', 'blocked']) {
      expect(
        find.byKey(ValueKey<String>('finding-$hidden')),
        findsNothing,
        reason: '"$hidden" is not scholar-approved and must not reach a learner',
      );
    }
  });

  testWidgets('a 1.0-confidence unapproved finding is STILL hidden', (tester) async {
    // A model's confidence is not a scholar's approval, and a threshold must never stand in for one.
    await pump(tester, <TajweedFinding>[
      finding(id: 'sure', status: 'teacher-review-required', confidence: 1.0),
    ]);
    expect(find.byKey(const ValueKey<String>('finding-sure')), findsNothing);
    expect(find.byKey(const ValueKey<String>('tajweed-none')), findsOneWidget);
  });

  testWidgets('every rendered finding shows its SOURCE and CONFIDENCE', (tester) async {
    // A learner shown a judgement about their recitation is entitled to see who stands behind it.
    await pump(tester, <TajweedFinding>[finding(id: 'x', source: 'scholar-panel-2026')]);
    expect(find.byKey(const ValueKey<String>('finding-source-x')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('finding-confidence-x')), findsOneWidget);
    expect(find.textContaining('scholar-panel-2026'), findsOneWidget);
    expect(find.textContaining('93%'), findsOneWidget);
  });

  testWidgets('the empty state does NOT claim the recitation was clean', (tester) async {
    // Everything may be awaiting review. Telling a learner there were no mistakes when nobody has
    // looked yet is a fabrication.
    await pump(tester, <TajweedFinding>[finding(status: 'teacher-review-required')]);
    final Text empty = tester.widget<Text>(
      find.descendant(
        of: find.byKey(const ValueKey<String>('tajweed-none')),
        matching: find.byType(Text),
      ),
    );
    expect(empty.data, 'No reviewed feedback yet.');
    expect(empty.data!.toLowerCase(), isNot(contains('no mistakes')));
    expect(empty.data!.toLowerCase(), isNot(contains('perfect')));
  });
}
