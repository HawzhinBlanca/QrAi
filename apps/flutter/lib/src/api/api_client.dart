/// The typed API client. One place that knows how to talk to the platform API.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

/// A failure the UI can branch on without parsing strings.
///
/// The API's error bodies are `{"error": "..."}` and those messages are wire contract, but they are
/// server-authored English. `kind` is what the UI switches on; `message` is for logs and for a
/// details expander, never for a `==` comparison.
enum ApiErrorKind {
  /// No usable credentials, or they were rejected. The caller should re-authenticate.
  unauthorized,

  /// Authenticated, but not permitted. Re-authenticating will not help.
  forbidden,

  /// No such record — or, deliberately, a resource whose existence is hidden.
  notFound,

  /// The request was malformed. A retry with the same body will fail the same way.
  badRequest,

  /// The server failed. A retry may succeed.
  server,

  /// The request never reached the server: no route to host, DNS, TLS, timeout.
  offline,
}

class ApiException implements Exception {
  ApiException(this.kind, this.message, {this.statusCode});

  final ApiErrorKind kind;
  final String message;
  final int? statusCode;

  /// Whether a plain retry is worth offering the user.
  bool get isRetryable => kind == ApiErrorKind.offline || kind == ApiErrorKind.server;

  @override
  String toString() => 'ApiException($kind, $statusCode): $message';
}

/// Supplies the bearer token for each request, or null when there is none.
///
/// A function rather than a stored string so the client never holds a credential in a field that
/// outlives the request, and so tests can drive it without touching platform storage.
typedef TokenProvider = Future<String?> Function();

class ApiClient {
  ApiClient({
    required this.baseUrl,
    required this.tokenProvider,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 20),
  }) : _http = httpClient ?? http.Client();

  final Uri baseUrl;

  /// Supplies the bearer token per request. Public so a caller can swap it on sign-out without
  /// rebuilding the client — and so the client never caches a credential of its own.
  final TokenProvider tokenProvider;
  final Duration timeout;
  final http.Client _http;

  void close() => _http.close();

  // ── the routes this client speaks ─────────────────────────────────────────────────────────────

  Future<List<SurahSummary>> listSurahs() async {
    final Object? body = await _get('/v1/quran/surahs');
    if (body is! List) throw ApiException(ApiErrorKind.server, 'expected a list of surahs');
    return body
        .map((Object? e) => SurahSummary.fromJson(e! as Map<String, dynamic>))
        .toList(growable: false);
  }

  Future<SurahDetail> getSurah(int surahNumber) async =>
      SurahDetail.fromJson(await _getObject('/v1/quran/surahs/$surahNumber'));

  Future<Ayah> getAyah(int surahNumber, int ayahNumber) async =>
      Ayah.fromJson(await _getObject('/v1/quran/ayahs/$surahNumber/$ayahNumber'));

  Future<LearnerProgress> getProgress({String? learnerId}) async {
    final String path = learnerId == null
        ? '/v1/learner/progress'
        : '/v1/learner/progress?learnerId=${Uri.encodeQueryComponent(learnerId)}';
    return LearnerProgress.fromJson(await _getObject(path));
  }

  Future<List<TajweedFinding>> listTajweedFindings({required String sessionId}) async {
    final Object? body =
        await _get('/v1/tajweed-findings?sessionId=${Uri.encodeQueryComponent(sessionId)}');
    if (body is! List) throw ApiException(ApiErrorKind.server, 'expected a list of findings');
    return body
        .map((Object? e) => TajweedFinding.fromJson(e! as Map<String, dynamic>))
        .toList(growable: false);
  }

  /// Create a recitation session. This is where consent is CAPTURED — the server stores what is
  /// sent here and every later ML call is scoped to that stored record, not to anything the client
  /// re-supplies. There is deliberately no default for any consent field.
  Future<RecitationSession> createRecitationSession({
    required String learnerId,
    required QuranRef quranRef,
    required String sourceChecksum,
    required String modelVersion,
    required String language,
    required String mode,
    required Consent consent,
  }) async =>
      RecitationSession.fromJson(
        await _postObject('/v1/recitation-sessions', <String, Object?>{
          'learnerId': learnerId,
          'quranRef': quranRef.toJson(),
          'sourceChecksum': sourceChecksum,
          'modelVersion': modelVersion,
          'language': language,
          'mode': mode,
          'consent': consent.toJson(),
        }),
      );

  Future<RealtimeTicket> createRealtimeTicket({
    required String sessionId,
    List<int> requestedSampleRates = const <int>[16000],
  }) async =>
      RealtimeTicket.fromJson(await _postObject('/v1/realtime-session-tickets', <String, Object?>{
        'sessionId': sessionId,
        'requestedSampleRates': requestedSampleRates,
      }));

  /// Both privacy routes deserialize `PrivacyJobRequest { learner_id }` and neither has a default:
  /// an empty body is a 422, not a self-scoped request. The learner id is the CALLER's to supply
  /// because `requireSelfOrAny` lets admin and ops act for another learner — the server decides
  /// whether that is allowed, and a client that could not name a learner could not express it.
  Future<void> requestPrivacyExport({required String learnerId}) async =>
      _post('/v1/privacy/export', <String, Object?>{'learnerId': learnerId});

  Future<void> requestPrivacyDelete({required String learnerId}) async =>
      _post('/v1/privacy/delete', <String, Object?>{'learnerId': learnerId});

  // ── transport ─────────────────────────────────────────────────────────────────────────────────

  Future<Map<String, String>> _headers() async {
    final Map<String, String> headers = <String, String>{'accept': 'application/json'};
    final String? token = await tokenProvider();
    if (token != null && token.isNotEmpty) headers['authorization'] = 'Bearer $token';
    return headers;
  }

  Future<Object?> _get(String path) async {
    final http.Response res;
    try {
      res = await _http.get(baseUrl.resolve(path), headers: await _headers()).timeout(timeout);
    } on Object catch (e) {
      // Every transport failure — SocketException, TimeoutException, HandshakeException — is the
      // same thing to the user: the request never arrived. Catching the base type deliberately;
      // enumerating platform exception types here would let a new one surface as a raw crash.
      throw ApiException(ApiErrorKind.offline, 'request did not reach the server: $e');
    }
    return _decode(res);
  }

  Future<Map<String, dynamic>> _getObject(String path) async => _asObject(await _get(path));

  Future<Object?> _post(String path, Map<String, Object?> body) async {
    final http.Response res;
    try {
      res = await _http
          .post(
            baseUrl.resolve(path),
            headers: <String, String>{...await _headers(), 'content-type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(timeout);
    } on Object catch (e) {
      throw ApiException(ApiErrorKind.offline, 'request did not reach the server: $e');
    }
    return _decode(res);
  }

  Future<Map<String, dynamic>> _postObject(String path, Map<String, Object?> body) async =>
      _asObject(await _post(path, body));

  Map<String, dynamic> _asObject(Object? body) {
    if (body is Map<String, dynamic>) return body;
    throw ApiException(ApiErrorKind.server, 'expected a JSON object, got ${body.runtimeType}');
  }

  /// Decode a response, or turn its status into a typed failure.
  ///
  /// `utf8.decode(res.bodyBytes)` rather than `res.body`: `http` derives the response encoding from
  /// the content-type's charset parameter, and this API answers `application/json` with NO charset
  /// (axum's `Json` responder omits it — established in N9). JSON is UTF-8 by definition
  /// (RFC 8259 §8.1), so decoding it as UTF-8 is always right and never depends on a header the
  /// server does not send. `test/api_client_test.dart` measures the difference rather than
  /// asserting it, because the first version of this comment claimed a latin-1 fallback that turned
  /// out to be the wrong explanation for a real difference.
  ///
  /// One Dart behaviour worth knowing: `utf8.decode` SKIPS a leading U+FEFF. Harmless here, since a
  /// JSON body always begins with `{` or `[` — but this corpus stores ayah 1:1 with a leading
  /// U+FEFF, so a future raw-text endpoint serving canonical text through this method would lose
  /// the first character of the first ayah silently. Bounded by a test, not by memory.
  Object? _decode(http.Response res) {
    final String text = utf8.decode(res.bodyBytes, allowMalformed: false);

    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (text.isEmpty) return null;
      return jsonDecode(text);
    }

    String message = text;
    try {
      final Object? parsed = jsonDecode(text);
      if (parsed is Map<String, dynamic> && parsed['error'] is String) {
        message = parsed['error']! as String;
      }
    } on FormatException {
      // A non-JSON error body is normal here: axum's path-parameter rejection is text/plain.
    }

    throw ApiException(_kindFor(res.statusCode), message, statusCode: res.statusCode);
  }

  static ApiErrorKind _kindFor(int status) => switch (status) {
        401 => ApiErrorKind.unauthorized,
        403 => ApiErrorKind.forbidden,
        404 => ApiErrorKind.notFound,
        >= 400 && < 500 => ApiErrorKind.badRequest,
        _ => ApiErrorKind.server,
      };
}
