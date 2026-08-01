/// The learner-visibility gate for AI feedback.
///
/// A tajweed finding must never reach a learner without a source, a confidence, and an approval.
/// This is the single most consequential rule in the product: an unapproved model output presented
/// as a judgement about someone's recitation of the Qur'an is a religious claim the software is not
/// entitled to make.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/api/models.dart';

Map<String, dynamic> finding({
  String status = 'scholar-approved',
  double confidence = 0.99,
  String source = 'tajweed-rules-v2',
}) =>
    <String, dynamic>{
      'id': 'f1',
      'rule': 'ghunnah',
      'status': status,
      'confidence': confidence,
      'source': source,
    };

void main() {
  test('only scholar-approved is learner-visible', () {
    expect(TajweedFinding.fromJson(finding(status: 'scholar-approved')).isLearnerVisible, isTrue);
    for (final String status in <String>[
      'draft',
      'pending-review',
      'teacher-approved',
      'blocked',
      'rejected',
      '',
    ]) {
      expect(
        TajweedFinding.fromJson(finding(status: status)).isLearnerVisible,
        isFalse,
        reason: '"$status" must not reach a learner',
      );
    }
  });

  test('a 1.0-confidence finding is STILL hidden without scholar approval', () {
    final TajweedFinding f =
        TajweedFinding.fromJson(finding(status: 'pending-review', confidence: 1.0));
    expect(f.isLearnerVisible, isFalse,
        reason: "a model's confidence is not a scholar's approval, and a threshold must never "
            'stand in for one');
  });

  test('a payload with no source fails to PARSE — it cannot be rendered at all', () {
    final Map<String, dynamic> json = finding()..remove('source');
    expect(TajweedFinding.fromJson, isNotNull);
    expect(() => TajweedFinding.fromJson(json), throwsA(isA<FormatException>()));
  });

  test('a payload with no confidence fails to PARSE', () {
    final Map<String, dynamic> json = finding()..remove('confidence');
    expect(() => TajweedFinding.fromJson(json), throwsA(isA<FormatException>()));
  });

  test('a payload with no status fails to PARSE', () {
    final Map<String, dynamic> json = finding()..remove('status');
    expect(() => TajweedFinding.fromJson(json), throwsA(isA<FormatException>()));
  });
}
