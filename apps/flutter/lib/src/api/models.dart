/// Wire models for the QrAi platform API.
///
/// Hand-written from `specs/flutter-client/openapi.yaml`, which is itself hand-authored and
/// asserted against the Rust router in both directions by `tests/contract/coverage.test.mjs`.
/// Generating these from the server would produce models that cannot disagree with it, and a model
/// that cannot disagree is not a check.
///
/// ── The rule that governs this whole file ───────────────────────────────────────────────────────
/// Canonical Quran text is NEVER transformed. No `trim()`, no `normalize`, no `replaceAll`, no
/// `toLowerCase`. `Ayah.text` and `Word.text` carry exactly the bytes the API sent — this corpus
/// stores 1:1 with a leading U+FEFF and is NFC-unstable, so a tidy-up is a silent mutation of
/// scripture. `test/canonical_text_test.dart` asserts it round-trips byte-for-byte.
library;

/// Reads a required String, failing loudly rather than substituting "".
String _str(Map<String, dynamic> json, String key) {
  final Object? v = json[key];
  if (v is String) return v;
  throw FormatException('expected String at "$key", got ${v.runtimeType}');
}

int _int(Map<String, dynamic> json, String key) {
  final Object? v = json[key];
  if (v is int) return v;
  if (v is num) return v.toInt();
  throw FormatException('expected int at "$key", got ${v.runtimeType}');
}

double _num(Map<String, dynamic> json, String key) {
  final Object? v = json[key];
  if (v is num) return v.toDouble();
  throw FormatException('expected num at "$key", got ${v.runtimeType}');
}

/// A required nested object. `json['x'] as Map<String, dynamic>` on a missing key throws
/// `type 'Null' is not a subtype of type 'Map<String, dynamic>' in type cast` — measured — which
/// names neither the field nor the model. Every other read in this file names the field, and a
/// contract mismatch is exactly when that matters: this session found three of them.
Map<String, dynamic> _object(Map<String, dynamic> json, String key) {
  final Object? v = json[key];
  if (v is Map<String, dynamic>) return v;
  throw FormatException('expected an object at "$key", got ${v.runtimeType}');
}

/// An optional String. Absent is null; present-but-not-a-String is a contract violation, not a null.
String? _strOrNull(Map<String, dynamic> json, String key) {
  final Object? v = json[key];
  if (v == null || v is String) return v as String?;
  throw FormatException('expected String or null at "$key", got ${v.runtimeType}');
}

/// Elements of a list, each required to be an object. Public because `api_client.dart` decodes
/// top-level arrays and was doing `e! as Map<String, dynamic>` — the same cast, the same unhelpful
/// message, in a second place.
List<Map<String, dynamic>> objectsIn(Object? v, String what) => _objects(v, what);

List<Map<String, dynamic>> _objects(Object? v, String what) {
  if (v is! List) throw FormatException('expected a List for $what, got ${v.runtimeType}');
  return v.map((Object? e) {
    if (e is Map<String, dynamic>) return e;
    throw FormatException('expected objects in $what, got ${e.runtimeType}');
  }).toList(growable: false);
}

/// Parse a server timestamp, or null if it cannot be read as the calendar date it claims to be.
///
/// ── `parse`/`tryParse` are not validators ───────────────────────────────────────────────────────
/// Both ROLL OVER out-of-range components instead of refusing them. Measured:
/// `DateTime.tryParse('2026-13-45')` returns **14 February 2027** — month 13 becomes January of the
/// next year, day 45 walks into February. `DateTime.parse` does the same; it only throws on input it
/// cannot lex at all.
///
/// On a revision schedule that is a confidently wrong date with nothing downstream able to notice,
/// so the parse has to round-trip: if the calendar fields the server sent are not the fields that
/// came back, this is not a date we can read.
///
/// One function, used by both the model accessor and the display path. They were two, and the two
/// disagreed — the display path was guarded and the accessor was not.
DateTime? parseServerTimestamp(String? iso) {
  if (iso == null) return null;
  final DateTime? parsed = DateTime.tryParse(iso);
  if (parsed == null) return null;
  final Match? ymd = RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch(iso);
  if (ymd == null) return null;
  final bool roundTrips = int.parse(ymd[1]!) == parsed.year &&
      int.parse(ymd[2]!) == parsed.month &&
      int.parse(ymd[3]!) == parsed.day;
  return roundTrips ? parsed : null;
}

/// One entry of `GET /v1/quran/surahs`.
class SurahSummary {
  const SurahSummary({
    required this.surahNumber,
    required this.ayahCount,
    required this.name,
    required this.arabicName,
    required this.translation,
    required this.revelationType,
  });

  factory SurahSummary.fromJson(Map<String, dynamic> json) => SurahSummary(
        surahNumber: _int(json, 'surahNumber'),
        ayahCount: _int(json, 'ayahCount'),
        name: _str(json, 'name'),
        // Arabic surah names are canonical-derived; same no-transform rule as ayah text.
        arabicName: _str(json, 'arabicName'),
        translation: _str(json, 'translation'),
        revelationType: _str(json, 'revelationType'),
      );

  final int surahNumber;
  final int ayahCount;
  final String name;
  final String arabicName;
  final String translation;
  final String revelationType;
}

/// One word of canonical text, with the checksum computed at ingest.
class Word {
  const Word({
    required this.id,
    required this.wordIndex,
    required this.text,
    required this.sourceChecksum,
  });

  factory Word.fromJson(Map<String, dynamic> json) => Word(
        id: _str(json, 'id'),
        wordIndex: _int(json, 'wordIndex'),
        text: _str(json, 'text'), // verbatim
        sourceChecksum: _str(json, 'sourceChecksum'),
      );

  final String id;
  final int wordIndex;

  /// Canonical Uthmani text. Never transformed, never normalized, never trimmed.
  final String text;
  final String sourceChecksum;
}

class Ayah {
  const Ayah({
    required this.id,
    required this.surahNumber,
    required this.ayahNumber,
    required this.text,
    required this.sourceChecksum,
    this.words = const <Word>[],
  });

  factory Ayah.fromJson(Map<String, dynamic> json) => Ayah(
        id: _str(json, 'id'),
        surahNumber: _int(json, 'surahNumber'),
        ayahNumber: _int(json, 'ayahNumber'),
        text: _str(json, 'text'), // verbatim
        sourceChecksum: _str(json, 'sourceChecksum'),
        // `GET /v1/quran/surahs/{n}` omits `words` entirely; `GET /v1/quran/ayahs/{s}/{a}` includes
        // it. An absent key is an empty list, NOT an error — the two routes return the same shape
        // with a different level of detail.
        words: json.containsKey('words')
            ? _objects(json['words'], 'words').map(Word.fromJson).toList(growable: false)
            : const <Word>[],
      );

  final String id;
  final int surahNumber;
  final int ayahNumber;

  /// Canonical Uthmani text. Never transformed, never normalized, never trimmed.
  final String text;
  final String sourceChecksum;
  final List<Word> words;
}

/// `GET /v1/quran/surahs/{surah_number}`.
class SurahDetail {
  const SurahDetail({required this.surahNumber, required this.ayahs});

  factory SurahDetail.fromJson(Map<String, dynamic> json) => SurahDetail(
        surahNumber: _int(json, 'surahNumber'),
        ayahs: _objects(json['ayahs'], 'ayahs').map(Ayah.fromJson).toList(growable: false),
      );

  final int surahNumber;
  final List<Ayah> ayahs;
}

/// `GET /v1/learner/progress`.
class LearnerProgress {
  const LearnerProgress({
    required this.learnerId,
    required this.tenantId,
    required this.mastery,
    required this.streak,
    required this.totalSessions,
    required this.nextReviewAt,
  });

  factory LearnerProgress.fromJson(Map<String, dynamic> json) => LearnerProgress(
        learnerId: _str(json, 'learnerId'),
        tenantId: _str(json, 'tenantId'),
        mastery: _num(json, 'mastery'),
        streak: _int(json, 'streak'),
        totalSessions: _int(json, 'totalSessions'),
        // NULLABLE: a learner with no scheduled review has none. The server renders
        // chrono's `+00:00` offset rather than `Z`, and 0/3/6/9 fractional digits — both of which
        // DateTime.parse accepts. Kept as the raw string as well so nothing re-serializes a
        // different spelling of the same instant back to the server.
        nextReviewAt: _strOrNull(json, 'nextReviewAt'),
      );

  final String learnerId;
  final String tenantId;
  final double mastery;
  final int streak;
  final int totalSessions;
  final String? nextReviewAt;

  /// Null when there is no review scheduled OR when the server's string does not round-trip —
  /// see `parseServerTimestamp`. It used to be a bare `DateTime.parse`, which both threw on junk
  /// and silently rolled `2026-13-45` over to February 2027.
  DateTime? get nextReviewAtUtc => parseServerTimestamp(nextReviewAt)?.toUtc();
}

/// A tajweed finding as the learner may see it.
///
/// ── The gate this class exists to make structural ───────────────────────────────────────────────
/// A finding must never reach a learner without a source, a confidence, and an approval. Those are
/// REQUIRED fields here, so a payload missing any of them fails to parse rather than rendering as a
/// confident-looking judgement about someone's recitation. `isLearnerVisible` is the only thing the
/// UI is allowed to branch on.
class TajweedFinding {
  const TajweedFinding({
    required this.id,
    required this.rule,
    required this.status,
    required this.confidence,
    required this.source,
    required this.detail,
  });

  factory TajweedFinding.fromJson(Map<String, dynamic> json) => TajweedFinding(
        id: _str(json, 'id'),
        rule: _str(json, 'rule'),
        status: _str(json, 'status'),
        confidence: _num(json, 'confidence'),
        source: _str(json, 'source'),
        detail: _strOrNull(json, 'detail'),
      );

  final String id;
  final String rule;

  /// Server-side review state. Only `scholar-approved` is learner-visible.
  final String status;
  final double confidence;

  /// Where the judgement came from — a model version, a rule id, or a human reviewer.
  final String source;
  final String? detail;

  /// The ONLY predicate the UI may use to decide whether a learner sees this.
  ///
  /// Not "confidence is high enough". A model's confidence is not a scholar's approval, and letting
  /// a threshold stand in for one is exactly the substitution this gate refuses.
  bool get isLearnerVisible => status == 'scholar-approved';
}

/// `POST /v1/realtime-session-tickets`.
class RealtimeTicket {
  const RealtimeTicket({
    required this.token,
    required this.sessionId,
    required this.tenantId,
    required this.learnerId,
    required this.expiresAt,
    required this.allowedSampleRates,
    required this.externalAsrProcessing,
  });

  factory RealtimeTicket.fromJson(Map<String, dynamic> json) => RealtimeTicket(
        token: _str(json, 'token'),
        sessionId: _str(json, 'sessionId'),
        tenantId: _str(json, 'tenantId'),
        learnerId: _str(json, 'learnerId'),
        // A DECIMAL STRING of unix seconds, not RFC3339: the server renders `u64::to_string()`.
        // Parsing it as a date silently yields null and the ticket looks permanently valid.
        expiresAt: int.parse(_str(json, 'expiresAt')),
        allowedSampleRates: (json['allowedSampleRates'] as List<Object?>? ?? <Object?>[])
            .map((Object? e) => e is num
                ? e.toInt()
                : throw FormatException(
                    'expected a number in "allowedSampleRates", got ${e.runtimeType}'))
            .toList(growable: false),
        externalAsrProcessing: json['externalAsrProcessing'] == true,
      );

  final String token;
  final String sessionId;
  final String tenantId;
  final String learnerId;

  /// Unix seconds.
  final int expiresAt;
  final List<int> allowedSampleRates;

  /// Whether audio may leave for external ASR. Resolved SERVER-side from the session row; the
  /// client may not override it and must not infer it from the learner's stated preference.
  final bool externalAsrProcessing;

  bool isExpiredAt(DateTime now) => now.millisecondsSinceEpoch ~/ 1000 >= expiresAt;
}

/// Where in the canonical text a session sits.
///
/// `display` is required on the create request, so the client composes it there; on a response it
/// is whatever the server stored. `apps/web/src/lib/api.ts:208` builds the same string, and the two
/// clients agreeing matters — a session created from the phone and one created from the browser
/// should not read differently in a teacher's review queue.
class QuranRef {
  const QuranRef({
    required this.surahNumber,
    required this.ayahStart,
    required this.ayahEnd,
    required this.display,
  });

  factory QuranRef.fromJson(Map<String, dynamic> json) => QuranRef(
        surahNumber: _int(json, 'surahNumber'),
        ayahStart: _int(json, 'ayahStart'),
        ayahEnd: _int(json, 'ayahEnd'),
        display: _str(json, 'display'),
      );

  final int surahNumber;
  final int ayahStart;
  final int ayahEnd;
  final String display;

  Map<String, Object?> toJson() => <String, Object?>{
        'surahNumber': surahNumber,
        'ayahStart': ayahStart,
        'ayahEnd': ayahEnd,
        'display': display,
      };
}

/// What the learner agreed to, as sent when a session is created.
///
/// Every field is required by the contract and none has a client-side default: a consent record
/// with an assumed value is not consent. `audioRetention` is an enum on the wire, so the allowed
/// values live here as constants rather than as free strings at each call site.
class Consent {
  const Consent({
    required this.audioRetention,
    required this.anonymizedLearning,
    required this.externalAsrProcessing,
    required this.guardianApproved,
    required this.consentVersion,
  });

  /// The three the server accepts — `AudioRetention` in `types.rs:103`, kebab-cased by serde.
  /// `discard` is the fail-safe default a UI should start from.
  ///
  /// There is no `session-only`. The contract claimed one, this class copied it, and the practice
  /// flow offered a learner a choice the API answers with a 422 — found by creating a real session
  /// against the running service, not by any test.
  static const String retentionDiscard = 'discard';
  static const String retentionTrainingOptIn = 'training-opt-in';
  static const String retentionTeacherReview = 'teacher-review';

  final String audioRetention;
  final bool anonymizedLearning;
  final bool externalAsrProcessing;
  final bool guardianApproved;
  final String consentVersion;

  Map<String, Object?> toJson() => <String, Object?>{
        'audioRetention': audioRetention,
        'anonymizedLearning': anonymizedLearning,
        'externalAsrProcessing': externalAsrProcessing,
        'guardianApproved': guardianApproved,
        'consentVersion': consentVersion,
      };
}

/// A created recitation session. `reviewStatus` starts at `draft` and only the server moves it.
class RecitationSession {
  const RecitationSession({
    required this.id,
    required this.tenantId,
    required this.learnerId,
    required this.quranRef,
    required this.reviewStatus,
  });

  factory RecitationSession.fromJson(Map<String, dynamic> json) => RecitationSession(
        id: _str(json, 'id'),
        tenantId: _str(json, 'tenantId'),
        learnerId: _str(json, 'learnerId'),
        quranRef: QuranRef.fromJson(_object(json, 'quranRef')),
        reviewStatus: _str(json, 'reviewStatus'),
      );

  final String id;
  final String tenantId;
  final String learnerId;
  final QuranRef quranRef;

  /// `draft` | `ai-suggested` | `teacher-review-required` | `teacher-reviewed` | `scholar-approved`.
  final String reviewStatus;
}
