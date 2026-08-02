/// Reading the role out of a bearer token.
///
/// This decides whether a Review tab appears. It is not a security boundary — every route it leads
/// to is gated server-side — but it must not CRASH the app on a malformed token, and it must fall
/// back to "learner" rather than guess, so a garbled token hides the tab instead of showing a
/// broken one.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/auth/actor.dart';

/// A JWT-shaped string. The signature is arbitrary: nothing here verifies it, deliberately.
String jwt(Object? claims, {String header = '{"alg":"HS256","typ":"JWT"}'}) {
  String seg(String s) => base64Url.encode(utf8.encode(s)).replaceAll('=', '');
  return '${seg(header)}.${seg(jsonEncode(claims))}.c2ln';
}

void main() {
  test('reads the role, subject and tenant a real token carries', () {
    final Actor? a = Actor.fromJwt(jwt(<String, Object?>{
      'sub': 'teacher-1',
      'tenant_id': 'hikmah-pilot-erbil',
      'role': 'teacher',
      'exp': 9999999999,
    }));
    expect(a, isNotNull);
    expect(a!.userId, 'teacher-1');
    expect(a.tenantId, 'hikmah-pilot-erbil');
    expect(a.role, ActorRole.teacher);
  });

  test('only the roles the review routes accept can reach the queue', () {
    // Mirrors require_any([Teacher, Admin, Ops]) on create_teacher_review. Scholar is excluded on
    // purpose: list_tajweed_findings admits one, create_teacher_review does not, so a scholar would
    // be handed a queue they cannot act on.
    Actor? of(String role) => Actor.fromJwt(
        jwt(<String, Object?>{'sub': 'u', 'tenant_id': 't', 'role': role}));

    for (final String role in <String>['teacher', 'admin', 'ops']) {
      expect(of(role)!.canReviewFindings, isTrue, reason: '$role must see the queue');
    }
    for (final String role in <String>['learner', 'scholar']) {
      expect(of(role)!.canReviewFindings, isFalse, reason: '$role must NOT see the queue');
    }
  });

  test('an unrecognised role is not a teacher', () {
    // An allowlist: a role added upstream must default to hiding the tab, not to showing it.
    for (final String role in <String>['superuser', 'Teacher', 'TEACHER', 'teacher ', '']) {
      expect(
        Actor.fromJwt(jwt(<String, Object?>{'sub': 'u', 'tenant_id': 't', 'role': role})),
        isNull,
        reason: '"$role" must not parse as a known role',
      );
    }
  });

  test('a malformed token returns null instead of throwing', () {
    // Every one of these has reached a client at some point in this project's life. A crash on
    // launch because a stored token was truncated is not an acceptable failure mode.
    for (final String? bad in <String?>[
      null,
      '',
      'not-a-jwt',
      'only.two',
      'a.b.c.d',
      'aaa.!!!not-base64!!!.ccc',
      'aaa.${base64Url.encode(utf8.encode('not json')).replaceAll('=', '')}.ccc',
      // Valid base64, valid JSON, but an array rather than a claims object.
      'aaa.${base64Url.encode(utf8.encode('[1,2,3]')).replaceAll('=', '')}.ccc',
    ]) {
      expect(Actor.fromJwt(bad), isNull, reason: 'token ${bad ?? "null"} should decode to null');
    }
  });

  test('claims of the wrong TYPE are rejected, not coerced', () {
    // A numeric role would stringify to something plausible-looking under a laxer read.
    expect(Actor.fromJwt(jwt(<String, Object?>{'sub': 'u', 'tenant_id': 't', 'role': 7})), isNull);
    expect(Actor.fromJwt(jwt(<String, Object?>{'sub': 1, 'tenant_id': 't', 'role': 'teacher'})), isNull);
    expect(Actor.fromJwt(jwt(<String, Object?>{'sub': 'u', 'role': 'teacher'})), isNull);
  });

  test('every base64url payload length decodes — padding is computed, not assumed', () {
    // JWTs strip '='. A payload whose length %4 is 2 or 3 needs different padding, and getting it
    // wrong throws FormatException on a perfectly valid token — which would hide the Review tab
    // from a real teacher depending only on how long their tenant id happened to be.
    for (int pad = 0; pad < 12; pad++) {
      final Actor? a = Actor.fromJwt(jwt(<String, Object?>{
        'sub': 'u',
        'tenant_id': 't' * (pad + 1),
        'role': 'teacher',
      }));
      expect(a, isNotNull, reason: 'tenant id of length ${pad + 1} failed to decode');
      expect(a!.role, ActorRole.teacher);
    }
  });
}
