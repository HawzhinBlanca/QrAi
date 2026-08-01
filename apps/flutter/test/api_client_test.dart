/// The transport: charset handling, auth headers, and how failures reach the UI.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qrai/src/api/api_client.dart';
import 'package:qrai/src/api/models.dart';

const List<int> bismillahCodePoints = <int>[
  0xFEFF, 0x0628, 0x0650, 0x0633, 0x0652, 0x0645, 0x0650,
];

ApiClient clientReturning(
  Object? body, {
  int status = 200,
  String? contentType = 'application/json',
  Future<String?> Function()? token,
  void Function(http.Request)? onRequest,
}) {
  final MockClient mock = MockClient((http.Request req) async {
    onRequest?.call(req);
    final List<int> bytes =
        body is String ? utf8.encode(body) : utf8.encode(jsonEncode(body));
    return http.Response.bytes(
      bytes,
      status,
      headers: contentType == null ? <String, String>{} : <String, String>{'content-type': contentType},
    );
  });
  return ApiClient(
    baseUrl: Uri.parse('http://127.0.0.1:8080'),
    tokenProvider: token ?? () async => null,
    httpClient: mock,
  );
}

void main() {
  final String bismillah = String.fromCharCodes(bismillahCodePoints);

  /// This is the test the `_decode` comment exists for, and it is not hypothetical.
  ///
  /// `package:http` picks the response encoding from the content-type's charset parameter and, per
  /// RFC 2616, falls back to LATIN-1 when there is none. N9 established that this API answers
  /// `application/json` with NO charset — axum's `Json` responder omits it. So `res.body` decodes
  /// every Arabic byte as latin-1 and returns mojibake. `res.bodyBytes` + `utf8.decode` is the fix,
  /// and this test fails if anyone "simplifies" it back.
  test('an application/json response with NO charset still decodes as UTF-8', () async {
    final ApiClient c = clientReturning(<String, Object?>{
      'id': '1:1',
      'surahNumber': 1,
      'ayahNumber': 1,
      'text': bismillah,
      'sourceChecksum': 'sha256:a',
    });

    final Ayah ayah = await c.getAyah(1, 1);
    expect(ayah.text.codeUnits, equals(bismillah.codeUnits));
    expect(ayah.text.runes.first, equals(0xFEFF));
  });

  /// Two premises, both MEASURED here rather than asserted in a comment. The first draft of this
  /// file claimed `package:http` falls back to latin-1 and that `utf8.decode` is a faithful
  /// inverse. Both claims were wrong in interesting ways, and this test is what found that out.
  test('premise 1: res.body does NOT reproduce the bytes, so the explicit decode earns its place',
      () {
    final http.Response res = http.Response.bytes(
      utf8.encode(bismillah),
      200,
      headers: <String, String>{'content-type': 'application/json'},
    );
    expect(
      res.body,
      isNot(equals(bismillah)),
      reason: 'if res.body became byte-faithful, the explicit decode in _decode may be redundant — '
          'check before removing it, do not assume',
    );
  });

  /// A real Dart behaviour, worth knowing and worth bounding.
  ///
  /// `utf8.decode` SKIPS a leading U+FEFF. For this API that is harmless — a JSON body always
  /// begins with `{` or `[`, never with a BOM — but the corpus stores ayah 1:1 with a leading
  /// U+FEFF, so if a raw-text endpoint ever returned canonical text directly, this decode would eat
  /// the first character of the first ayah of the Qur'an and nothing would report it.
  test('premise 2: utf8.decode strips a LEADING BOM — harmless for JSON, and bounded here', () {
    expect(
      utf8.decode(utf8.encode(bismillah)),
      isNot(equals(bismillah)),
      reason: 'Dart no longer strips a leading BOM; the note in _decode can be simplified',
    );
    expect(utf8.decode(utf8.encode(bismillah)), equals(bismillah.substring(1)));

    // The bound: inside a JSON string value the BOM is not leading, so it survives intact. That is
    // the only way canonical text reaches this client.
    final Map<String, dynamic> decoded =
        jsonDecode(utf8.decode(utf8.encode(jsonEncode(<String, String>{'t': bismillah}))))
            as Map<String, dynamic>;
    expect(decoded['t'], equals(bismillah));
  });

  test('a bearer token is sent when one exists, and no header at all when it does not', () async {
    String? seen;
    final ApiClient withToken = clientReturning(
      <Object>[],
      token: () async => 'tok-123',
      onRequest: (http.Request r) => seen = r.headers['authorization'],
    );
    await withToken.listSurahs();
    expect(seen, equals('Bearer tok-123'));

    seen = 'not-overwritten';
    final ApiClient without = clientReturning(
      <Object>[],
      token: () async => null,
      onRequest: (http.Request r) => seen = r.headers['authorization'],
    );
    await without.listSurahs();
    expect(seen, isNull, reason: 'an empty Authorization header is not the same as none');
  });

  test('an EMPTY token is treated as no token, not as `Bearer `', () async {
    String? seen = 'x';
    final ApiClient c = clientReturning(
      <Object>[],
      token: () async => '',
      onRequest: (http.Request r) => seen = r.headers['authorization'],
    );
    await c.listSurahs();
    expect(seen, isNull);
  });

  test('statuses map to kinds the UI can branch on without reading messages', () async {
    Future<ApiErrorKind> kindFor(int status) async {
      try {
        await clientReturning(<String, Object?>{'error': 'nope'}, status: status).listSurahs();
        fail('expected $status to throw');
      } on ApiException catch (e) {
        return e.kind;
      }
    }

    expect(await kindFor(401), equals(ApiErrorKind.unauthorized));
    expect(await kindFor(403), equals(ApiErrorKind.forbidden));
    expect(await kindFor(404), equals(ApiErrorKind.notFound));
    expect(await kindFor(422), equals(ApiErrorKind.badRequest));
    expect(await kindFor(500), equals(ApiErrorKind.server));
    expect(await kindFor(503), equals(ApiErrorKind.server));
  });

  test('a text/plain error body (axum path rejection) surfaces intact, not as a parse crash',
      () async {
    try {
      await clientReturning(
        r'Invalid URL: Cannot parse `abc` to a `i32`',
        status: 400,
        contentType: 'text/plain; charset=utf-8',
      ).getSurah(1);
      fail('expected a 400');
    } on ApiException catch (e) {
      expect(e.kind, equals(ApiErrorKind.badRequest));
      expect(e.message, contains('Cannot parse'));
    }
  });

  test('a transport failure is `offline` and retryable — not an opaque crash', () async {
    final ApiClient c = ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: MockClient((http.Request _) => throw const _NoRoute()),
    );
    try {
      await c.listSurahs();
      fail('expected an offline failure');
    } on ApiException catch (e) {
      expect(e.kind, equals(ApiErrorKind.offline));
      expect(e.isRetryable, isTrue);
      expect(e.statusCode, isNull);
    }
  });

  test('an unauthorized failure is NOT offered as retryable', () async {
    try {
      await clientReturning(<String, Object?>{'error': 'x'}, status: 401).listSurahs();
      fail('expected 401');
    } on ApiException catch (e) {
      expect(e.isRetryable, isFalse, reason: 'retrying the same rejected credential is a loop');
    }
  });

  test('the realtime ticket expiry is a decimal string of unix seconds, not a date', () async {
    final ApiClient c = clientReturning(<String, Object?>{
      'token': 'rt_v1.abc',
      'sessionId': 's1',
      'tenantId': 't1',
      'learnerId': 'l1',
      'expiresAt': '1900000000',
      'allowedSampleRates': <int>[16000],
      'externalAsrProcessing': false,
    });
    final RealtimeTicket t = await c.createRealtimeTicket(sessionId: 's1');
    // 1_900_000_000 is 2030-03-17T13:46:40Z. DateTime.utc(2030) is January, which is BEFORE that —
    // an arithmetic slip in the first draft of this test, caught by running it.
    expect(t.expiresAt, equals(1900000000));
    expect(t.isExpiredAt(DateTime.utc(2031)), isTrue);
    expect(t.isExpiredAt(DateTime.utc(2030)), isFalse);
    expect(t.isExpiredAt(DateTime.utc(2020)), isFalse);
  });

  test('externalAsrProcessing defaults to FALSE when the field is absent', () async {
    // Fail closed: a missing consent gate must never read as "audio may leave".
    final ApiClient c = clientReturning(<String, Object?>{
      'token': 'rt_v1.abc',
      'sessionId': 's1',
      'tenantId': 't1',
      'learnerId': 'l1',
      'expiresAt': '1900000000',
      'allowedSampleRates': <int>[16000],
    });
    expect((await c.createRealtimeTicket(sessionId: 's1')).externalAsrProcessing, isFalse);
  });
}

class _NoRoute implements Exception {
  const _NoRoute();
  @override
  String toString() => 'SocketException: no route to host';
}
