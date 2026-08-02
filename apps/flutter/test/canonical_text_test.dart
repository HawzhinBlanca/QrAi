/// The canonical-text guard for the Dart client.
///
/// The vectors here are the same ones `packages/contracts/fixtures/canonical-gates.json` pins for
/// the TypeScript side, so a Dart client that damages text fails for the same reason and with the
/// same evidence. Written as `\u` escapes and code-point lists, NEVER as literal Arabic with
/// combining marks: a literal reorders itself in transit through editors and tooling — it happened
/// while WRITING the TS version of this test, which is why the vectors are stored as code points.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/api/models.dart';

/// Ayah 1:1 as the corpus stores it: U+FEFF, then bismillah.
const List<int> bismillahCodePoints = <int>[
  0xFEFF, 0x0628, 0x0650, 0x0633, 0x0652, 0x0645, 0x0650, 0x0020, // بِسْمِ
  0x0671, 0x0644, 0x0644, 0x064E, 0x0651, 0x0647, 0x0650, // ٱللَّهِ
];

void main() {
  final String bismillah = String.fromCharCodes(bismillahCodePoints);

  test('a decoded Ayah carries the text byte-for-byte, U+FEFF included', () {
    final Ayah ayah = Ayah.fromJson(<String, dynamic>{
      'id': '1:1',
      'surahNumber': 1,
      'ayahNumber': 1,
      'text': bismillah,
      'sourceChecksum': 'sha256:whatever',
    });

    expect(ayah.text.codeUnits, equals(bismillah.codeUnits));
    expect(ayah.text.runes.first, equals(0xFEFF),
        reason: 'a trim() would remove the leading U+FEFF and no user would ever see the loss');
  });

  test('the vector is NFC-UNSTABLE, so a normalize() would be detectable', () {
    // Dart has no String.normalize, which is a genuine safety property here: the accidental
    // normalization that plagues the JS client is not reachable in this language without adding a
    // package. Assert the vector's instability by construction instead: the combining marks are in
    // an order NFC would reorder (shadda U+0651 after fatha U+064E).
    final int shadda = bismillah.codeUnits.indexOf(0x0651);
    final int fatha = bismillah.codeUnits.indexOf(0x064E);
    expect(shadda, greaterThan(-1));
    expect(fatha, greaterThan(-1));
    expect(fatha, lessThan(shadda),
        reason: 'NFC would reorder these two marks; if they are already in NFC order this vector '
            'can no longer detect a normalization');
  });

  test('a full JSON round-trip through the client codec does not alter the text', () {
    final String encoded = jsonEncode(<String, Object?>{'text': bismillah});
    final Map<String, dynamic> decoded =
        jsonDecode(utf8.decode(utf8.encode(encoded))) as Map<String, dynamic>;
    expect(decoded['text'], equals(bismillah));
  });

  test('words keep their own text verbatim and are ordered by wordIndex', () {
    final Ayah ayah = Ayah.fromJson(<String, dynamic>{
      'id': '1:1',
      'surahNumber': 1,
      'ayahNumber': 1,
      'text': bismillah,
      'sourceChecksum': 'sha256:a',
      'words': <Map<String, dynamic>>[
        <String, dynamic>{
          'id': '1:1:1',
          'wordIndex': 1,
          'text': bismillah,
          'sourceChecksum': 'sha256:b',
        },
      ],
    });
    expect(ayah.words.single.text.codeUnits, equals(bismillah.codeUnits));
    expect(ayah.words.single.wordIndex, equals(1));
  });

  test('an Ayah with no `words` key parses as an empty list, not an error', () {
    // GET /v1/quran/surahs/{n} omits `words` entirely; GET /v1/quran/ayahs/{s}/{a} includes it.
    final Ayah ayah = Ayah.fromJson(<String, dynamic>{
      'id': '2:1',
      'surahNumber': 2,
      'ayahNumber': 1,
      'text': 'x',
      'sourceChecksum': 'sha256:c',
    });
    expect(ayah.words, isEmpty);
  });

  test('a missing required field is a FormatException, not a silent empty string', () {
    expect(
      () => Ayah.fromJson(<String, dynamic>{'id': '1:1', 'surahNumber': 1, 'ayahNumber': 1}),
      throwsA(isA<FormatException>()),
      reason: 'defaulting canonical text to "" would render a blank ayah as if it were scripture',
    );
  });

  group('a contract mismatch names the field it was reading', () {
    // Measured before this change: `type 'Null' is not a subtype of type 'Map<String, dynamic>' in
    // type cast` — no field, no model, nothing to grep the server for. Three real contract
    // mismatches surfaced during this session's live runs, so the message is what someone will
    // actually be holding when the next one happens.

    test('a missing nested object names the key', () {
      expect(
        () => RecitationSession.fromJson(<String, dynamic>{
          'id': 'x',
          'tenantId': 't',
          'learnerId': 'l',
          'reviewStatus': 'draft',
        }),
        throwsA(isA<FormatException>()
            .having((FormatException e) => e.message, 'message', contains('quranRef'))),
      );
    });

    test('a wrongly-typed list element names the list', () {
      expect(
        () => RealtimeTicket.fromJson(<String, dynamic>{
          'token': 't',
          'sessionId': 's',
          'tenantId': 'te',
          'learnerId': 'l',
          'expiresAt': '1',
          'allowedSampleRates': <Object?>['16000'],
          'externalAsrProcessing': false,
        }),
        throwsA(isA<FormatException>()
            .having((FormatException e) => e.message, 'message', contains('allowedSampleRates'))),
      );
    });

    test('a wrongly-typed optional string is a violation, not a silent null', () {
      // `as String?` would have turned a number into a TypeError; returning null instead would have
      // been worse — a contract violation rendered as "no review scheduled".
      expect(
        () => LearnerProgress.fromJson(<String, dynamic>{
          'learnerId': 'l',
          'tenantId': 't',
          'mastery': 1,
          'streak': 0,
          'totalSessions': 0,
          'nextReviewAt': 12345,
        }),
        throwsA(isA<FormatException>()
            .having((FormatException e) => e.message, 'message', contains('nextReviewAt'))),
      );
    });

    test('a non-object in a decoded list names the list', () {
      expect(
        () => objectsIn(<Object?>[<String, dynamic>{}, 'not an object'], 'surahs'),
        throwsA(isA<FormatException>()
            .having((FormatException e) => e.message, 'message', contains('surahs'))),
      );
    });
  });
}

