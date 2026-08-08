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

import 'dart:convert';
import 'dart:io';

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
      'analysisBasis': 'acoustic',
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
      'withheld': false,
      'startMs': 120,
      'endMs': 460,
      'audioStatus': 'available',
      'evidenceId': 'audio-evidence-1',
      'modelVersion': 'acoustic-model-v1',
      'modelArtifactSha256':
          'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      'acousticDatasetVersion': 'kurdish-l1-held-out-v1',
      'acousticDatasetManifestSha256':
          'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      'calibratorId': 'tajweed-calibrator-v1',
      'calibratorArtifactSha256':
          'sha256:3333333333333333333333333333333333333333333333333333333333333333',
      'calibrationStatus': 'calibrated',
      'evaluationEvidenceId': 'evaluation-evidence-v1',
      'evaluationEvidenceSha256':
          'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      'evaluationEvidenceStatus': 'release-trusted',
      'auditEventId': 'audit-learner-feedback-1',
    };

void main() {
  test('the shared expanded learner-feedback corpus is enforced', () {
    final Map<String, dynamic> corpus = jsonDecode(
      File('../../packages/contracts/fixtures/learner-feedback-gate.json').readAsStringSync(),
    ) as Map<String, dynamic>;
    final Map<String, dynamic> base = <String, dynamic>{
      // The shared corpus describes only the language-neutral gate. Dart's full wire parser also
      // requires these presentation fields, so supply a declared test envelope before applying
      // each gate vector.
      'wordId': '1:1:1',
      'rule': 'ghunnah',
      'severity': 'practice',
      'explanation': 'Declared learner-feedback gate fixture.',
      ...Map<String, dynamic>.from(corpus['base'] as Map<String, dynamic>),
    };
    final List<dynamic> cases = corpus['cases'] as List<dynamic>;
    expect(cases.length, greaterThanOrEqualTo(24));
    for (final Object? raw in cases) {
      final Map<String, dynamic> vector = Map<String, dynamic>.from(raw! as Map);
      final Map<String, dynamic> input =
          jsonDecode(jsonEncode(base)) as Map<String, dynamic>;
      final Object? patch = vector['patch'];
      if (patch is Map) {
        input.addAll(Map<String, dynamic>.from(patch));
      }
      final Object? remove = vector['remove'];
      if (remove is List) {
        for (final Object? field in remove) {
          input.remove(field);
        }
      }
      bool actual;
      try {
        actual = TajweedFinding.fromJson(input).isLearnerVisible;
      } on FormatException {
        actual = false;
      }
      expect(actual, vector['expected'], reason: vector['name'] as String);
    }
  });

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

  test('instructional text rules cannot parse as learner-performance findings', () {
    final Map<String, dynamic> json = finding()..['analysisBasis'] = 'text-rule';
    expect(() => TajweedFinding.fromJson(json), throwsA(isA<FormatException>()));
  });

  test('a payload with no analysisBasis fails to PARSE', () {
    final Map<String, dynamic> json = finding()..remove('analysisBasis');
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
