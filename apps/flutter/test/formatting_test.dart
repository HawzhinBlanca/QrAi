/// The learner-facing rendering of a server timestamp.
///
/// Seen on the running app: `nextReviewAt` came back as
/// `2026-08-03T21:48:28.922280+00:00` and was rendered verbatim in the progress screen.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/main.dart';

void main() {
  test('a real server timestamp becomes something a learner can read', () {
    final String out = friendlyReviewDate('2026-08-03T21:48:28.922280+00:00');
    expect(out, isNot(contains('T')), reason: 'still an ISO string');
    expect(out, contains('2026'));
    expect(out, contains('August'));
  });

  test('null means not scheduled, not "unknown"', () {
    expect(friendlyReviewDate(null), 'Not scheduled yet');
  });

  test('an unparseable value is shown UNCHANGED, never guessed', () {
    // The load-bearing case. Inventing a plausible date for a value we could not read would put a
    // wrong revision date in front of a learner, and nothing downstream could tell.
    for (final String junk in <String>['tomorrow', '', 'soon', '2026-13-45']) {
      expect(friendlyReviewDate(junk), junk, reason: 'invented a date for $junk');
    }
  });
}
