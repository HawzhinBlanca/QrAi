/// The learner-visibility gate for AI feedback.
///
/// A tajweed finding must never reach a learner without a source, a confidence, and a human
/// approval. This is the single most consequential rule in the product: an unapproved model output
/// presented as a judgement about someone's recitation of the Qur'an is a religious claim the
/// software is not entitled to make.
///
/// The gate mirrors `canShowLearnerFacingAiOutput` in `packages/contracts/src/index.ts`. That the
/// two agree is asserted separately and by construction in
/// `tests/contract/tajweed-gate-parity.test.mjs`; this file asserts that the Dart side does what it
/// says on its own terms.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/api/models.dart';

Map<String, dynamic> finding({
  String reviewStatus = 'scholar-approved',
  double confidence = 0.99,
  List<Map<String, dynamic>>? sources,
}) =>
    <String, dynamic>{
      'wordId': '1:1:1',
      'rule': 'ghunnah',
      'severity': 'practice',
      'explanation': 'Apply ghunnah on the noon sakina.',
      'reviewStatus': reviewStatus,
      'confidence': confidence,
      'sources': sources ??
          <Map<String, dynamic>>[
            <String, dynamic>{
              'id': 'tajweed-rules-v2',
              'title': 'Tajweed rules',
              'citation': 'Ch. 4',
            },
          ],
    };

void main() {
  test('only a human-approved status is learner-visible', () {
    for (final String status in <String>['teacher-reviewed', 'scholar-approved']) {
      expect(TajweedFinding.fromJson(finding(reviewStatus: status)).isLearnerVisible, isTrue,
          reason: '"$status" is an approval and must reach the learner');
    }
    // An ALLOWLIST: every one of these must be blocked, including the ones that do not exist. A
    // denylist would let a typo or a new upstream status through, which is the failure that
    // matters — it fails open, toward the learner.
    for (final String status in <String>[
      'draft',
      'ai-suggested',
      'teacher-review-required',
      'blocked',
      'teacher-approved', // plausible, and not a real status
      'scholar_approved', // underscore, not hyphen
      'SCHOLAR-APPROVED',
      'rejected',
      '',
    ]) {
      expect(
        TajweedFinding.fromJson(finding(reviewStatus: status)).isLearnerVisible,
        isFalse,
        reason: '"$status" must not reach a learner',
      );
    }
  });

  test('a 1.0-confidence finding is STILL hidden without approval', () {
    final TajweedFinding f =
        TajweedFinding.fromJson(finding(reviewStatus: 'ai-suggested', confidence: 1.0));
    expect(f.isLearnerVisible, isFalse,
        reason: "a model's confidence is not a human's approval, and a threshold must never "
            'stand in for one');
  });

  test('an approved finding below the confidence floor is hidden', () {
    // The floor is 0.82 and it is shared with the web client. Approval alone is not enough: a
    // reviewer signing off a batch does not make a low-confidence guess worth showing.
    expect(
      TajweedFinding.fromJson(finding(confidence: 0.81)).isLearnerVisible,
      isFalse,
      reason: 'below learnerMinConfidence',
    );
    expect(
      TajweedFinding.fromJson(finding(confidence: learnerMinConfidence)).isLearnerVisible,
      isTrue,
      reason: 'the floor is inclusive, as it is in canShowLearnerFacingAiOutput',
    );
  });

  test('an approved, confident finding with NO sources is hidden', () {
    // `sources: []` parses — an empty list is a valid list — so unlike the missing-field cases
    // below, this one has to be caught by the gate rather than by the parser.
    expect(
      TajweedFinding.fromJson(finding(sources: <Map<String, dynamic>>[])).isLearnerVisible,
      isFalse,
      reason: 'a judgement with nothing standing behind it must not be shown',
    );
  });

  test('a payload with no sources fails to PARSE — it cannot be rendered at all', () {
    final Map<String, dynamic> json = finding()..remove('sources');
    expect(() => TajweedFinding.fromJson(json), throwsA(isA<FormatException>()));
  });

  test('a payload with no confidence fails to PARSE', () {
    final Map<String, dynamic> json = finding()..remove('confidence');
    expect(() => TajweedFinding.fromJson(json), throwsA(isA<FormatException>()));
  });

  test('a payload with no reviewStatus fails to PARSE', () {
    final Map<String, dynamic> json = finding()..remove('reviewStatus');
    expect(() => TajweedFinding.fromJson(json), throwsA(isA<FormatException>()));
  });

  test('a source missing its citation fails to PARSE', () {
    // Provenance is rendered next to the finding, so a half-built source would render as a dangling
    // "Source: " with nothing after it.
    final Map<String, dynamic> json = finding(sources: <Map<String, dynamic>>[
      <String, dynamic>{'id': 's1', 'title': 'Tajweed rules'},
    ]);
    expect(() => TajweedFinding.fromJson(json), throwsA(isA<FormatException>()));
  });
}
