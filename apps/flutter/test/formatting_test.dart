/// The learner-facing rendering of a server timestamp.
///
/// Seen on the running app: `nextReviewAt` came back as
/// `2026-08-03T21:48:28.922280+00:00` and was rendered verbatim in the progress screen.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/main.dart';
import 'package:qrai/src/api/models.dart';

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

  group('parseServerTimestamp — the one parser both paths share', () {
    test('a real server timestamp parses', () {
      expect(parseServerTimestamp('2026-08-03T21:48:28.922280+00:00'), isNotNull);
    });

    test('a rolled-over date is REFUSED, not silently corrected', () {
      // The load-bearing case, and the reason this function exists. Dart's parsers roll month 13
      // into the next January and day 45 into February — measured, they return 14 Feb 2027 rather
      // than null. A revision date nobody can tell is wrong is worse than no date.
      expect(parseServerTimestamp('2026-13-45'), isNull);
      expect(parseServerTimestamp('2026-02-30'), isNull);
    });

    test('junk is null, not an exception', () {
      for (final String junk in <String>['tomorrow', '', 'soon']) {
        expect(parseServerTimestamp(junk), isNull, reason: junk);
      }
    });

    test('null in, null out', () => expect(parseServerTimestamp(null), isNull));
  });

  group('LearnerProgress.nextReviewAtUtc — the sibling that was unguarded', () {
    LearnerProgress withDate(String? d) => LearnerProgress(
          learnerId: 'l',
          tenantId: 't',
          mastery: 1,
          streak: 0,
          totalSessions: 0,
          nextReviewAt: d,
        );

    test('a real timestamp becomes a UTC DateTime', () {
      final DateTime? dt = withDate('2026-08-03T21:48:28.922280+00:00').nextReviewAtUtc;
      expect(dt, isNotNull);
      expect(dt!.isUtc, isTrue);
      expect(dt.year, 2026);
    });

    test('a rolled-over date is null here too — it used to return February 2027', () {
      // This accessor was a bare `DateTime.parse`. It had no callers, which made it a trap rather
      // than a bug: the next person to want "the review date" would have reached for it.
      expect(withDate('2026-13-45').nextReviewAtUtc, isNull);
    });

    test('junk is null, not a thrown FormatException', () {
      // `DateTime.parse` THREW on this. An accessor that throws is not one a UI can call.
      expect(withDate('tomorrow').nextReviewAtUtc, isNull);
    });

    test('no scheduled review is null', () => expect(withDate(null).nextReviewAtUtc, isNull));
  });

  group('shouldProvisionDevToken — a release build must not carry a credential', () {
    // `--dart-define` values are compiled into the artifact. `strings` on an APK, or an extracted
    // IPA, finds them; copying one into the Keychain at launch does not remove it from the binary.
    // The comment in main.dart used to claim otherwise, which is why this rule is now a tested
    // function rather than an `if` nobody can reach.
    test('a release build refuses a build-time token, however it was set', () {
      expect(shouldProvisionDevToken(releaseMode: true, token: 'a-real-looking-jwt'), isFalse);
      expect(shouldProvisionDevToken(releaseMode: true, token: ''), isFalse);
    });

    test('a debug build accepts one, which is how the live stack is driven', () {
      expect(shouldProvisionDevToken(releaseMode: false, token: 'a-real-looking-jwt'), isTrue);
    });

    test('no token means no provisioning, in either mode', () {
      expect(shouldProvisionDevToken(releaseMode: false, token: ''), isFalse);
    });
  });
}

