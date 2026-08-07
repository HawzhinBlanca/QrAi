/// FL6 — the learner-facing feedback surface.
///
/// The gate is enforced twice, deliberately: the model REFUSES to parse a finding without
/// reviewStatus, confidence and sources (tested in tajweed_gate_test.dart), and this widget filters
/// on `isLearnerVisible` and renders the provenance alongside anything it shows.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/api/models.dart';
import 'package:qrai/src/feedback/tajweed_panel.dart';

TajweedFinding finding({
  String wordId = '1:1:1',
  String rule = 'ghunnah',
  String reviewStatus = 'scholar-approved',
  double confidence = 0.93,
  String sourceTitle = 'Tajweed rules',
  String? arabicName,
}) =>
    TajweedFinding.fromJson(<String, dynamic>{
      'wordId': wordId,
      'rule': rule,
      'analysisBasis': 'acoustic',
      'severity': 'practice',
      'explanation': 'Apply ghunnah on the noon sakina.',
      'reviewStatus': reviewStatus,
      'confidence': confidence,
      'arabicName': arabicName,
      'sources': <Map<String, dynamic>>[
        <String, dynamic>{'id': 's1', 'title': sourceTitle, 'citation': 'Ch. 4'},
      ],
    });

Future<void> pump(WidgetTester tester, List<TajweedFinding> findings) => tester.pumpWidget(
      MaterialApp(home: Scaffold(body: TajweedPanel(findings: findings))),
    );

/// Findings are keyed by wordId+rule — there is no `id` on the wire.
ValueKey<String> keyFor(String wordId, String rule) => ValueKey<String>('finding-$wordId-$rule');

void main() {
  testWidgets('only human-approved findings are rendered', (tester) async {
    await pump(tester, <TajweedFinding>[
      finding(rule: 'scholar', reviewStatus: 'scholar-approved'),
      finding(rule: 'teacher', reviewStatus: 'teacher-reviewed'),
      finding(rule: 'draft', reviewStatus: 'draft'),
      finding(rule: 'ai', reviewStatus: 'ai-suggested'),
      finding(rule: 'pending', reviewStatus: 'teacher-review-required'),
      finding(rule: 'blocked', reviewStatus: 'blocked'),
    ]);

    for (final String shown in <String>['scholar', 'teacher']) {
      expect(find.byKey(keyFor('1:1:1', shown)), findsOneWidget,
          reason: '"$shown" is a human approval and must be shown');
    }
    for (final String hidden in <String>['draft', 'ai', 'pending', 'blocked']) {
      expect(
        find.byKey(keyFor('1:1:1', hidden)),
        findsNothing,
        reason: '"$hidden" is not a human approval and must not reach a learner',
      );
    }
  });

  testWidgets('a 1.0-confidence unapproved finding is STILL hidden', (tester) async {
    // A model's confidence is not a human's approval, and a threshold must never stand in for one.
    await pump(tester, <TajweedFinding>[
      finding(rule: 'sure', reviewStatus: 'ai-suggested', confidence: 1.0),
    ]);
    expect(find.byKey(keyFor('1:1:1', 'sure')), findsNothing);
    expect(find.byKey(const ValueKey<String>('tajweed-none')), findsOneWidget);
  });

  testWidgets('every rendered finding shows its SOURCE and CONFIDENCE', (tester) async {
    // A learner shown a judgement about their recitation is entitled to see who stands behind it.
    await pump(tester, <TajweedFinding>[finding(sourceTitle: 'Scholar panel 2026')]);
    expect(find.byKey(const ValueKey<String>('finding-source-1:1:1-ghunnah-s1')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('finding-confidence-1:1:1-ghunnah')), findsOneWidget);
    expect(find.textContaining('Scholar panel 2026'), findsOneWidget);
    expect(find.textContaining('Ch. 4'), findsOneWidget);
    expect(find.textContaining('93%'), findsOneWidget);
  });

  testWidgets('the empty state does NOT claim the recitation was clean', (tester) async {
    // Everything here is awaiting review. Telling a learner there were no mistakes when nobody has
    // looked yet is a fabrication, and so is implying there is nothing to look at.
    await pump(tester, <TajweedFinding>[
      finding(rule: 'a', reviewStatus: 'ai-suggested'),
      finding(rule: 'b', reviewStatus: 'ai-suggested'),
    ]);
    final Text empty = tester.widget<Text>(
      find.descendant(
        of: find.byKey(const ValueKey<String>('tajweed-none')),
        matching: find.byType(Text),
      ),
    );
    expect(empty.data, contains('2 notes are waiting'));
    expect(empty.data!.toLowerCase(), isNot(contains('no mistakes')));
    expect(empty.data!.toLowerCase(), isNot(contains('perfect')));
  });

  testWidgets('withheld and genuinely-empty are DIFFERENT messages', (tester) async {
    // The bug this prevents: telling a learner "no feedback" while findings sit unreviewed. Those
    // are different facts and a learner acts differently on each.
    await pump(tester, <TajweedFinding>[]);
    final Text none = tester.widget<Text>(
      find.descendant(
        of: find.byKey(const ValueKey<String>('tajweed-none')),
        matching: find.byType(Text),
      ),
    );
    expect(none.data, isNot(contains('waiting')));

    await pump(tester, <TajweedFinding>[finding(reviewStatus: 'ai-suggested')]);
    final Text withheld = tester.widget<Text>(
      find.descendant(
        of: find.byKey(const ValueKey<String>('tajweed-none')),
        matching: find.byType(Text),
      ),
    );
    expect(withheld.data, contains('1 note is waiting'));
    expect(withheld.data, isNot(none.data));
  });

  testWidgets('the Arabic rule name is rendered RTL and byte-for-byte', (tester) async {
    // Canonical text: never transformed, never translated. `ghunnah` in Arabic.
    const String ghunnah = 'غنة';
    await pump(tester, <TajweedFinding>[finding(arabicName: ghunnah)]);
    final Text name = tester.widget<Text>(find.text(ghunnah));
    expect(name.data, ghunnah, reason: 'rendered exactly as sent');
    expect(name.textDirection, TextDirection.rtl);
  });
}
