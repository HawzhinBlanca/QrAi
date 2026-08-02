/// Who this device is provisioned as, read from the bearer token.
///
/// ── This is NAVIGATION, not security ────────────────────────────────────────────────────────────
/// The signature is deliberately NOT verified. It cannot be: verifying HS256 needs `JWT_SECRET`,
/// and a client that held the signing secret could mint its own tokens — which is worse than not
/// checking. So this reads the payload the way a debugger would, and the ONLY thing it may be used
/// for is deciding which tabs to draw.
///
/// Every teacher route is gated server-side by `require_any([Teacher, Admin, Ops])`
/// (`services/platform-api/src/handlers/review.rs`). A learner who forged `"role":"teacher"` into
/// their token would get a Review tab whose every request comes back 403 — a cosmetic lie, not an
/// escalation. The authority is the server, here and everywhere.
///
/// Without this the alternative is worse in both directions: show the Review tab to everyone (every
/// learner taps it and gets a permission error) or to nobody (the surface exists and no teacher can
/// reach it).
library;

import 'dart:convert';

/// Roles the platform recognises. `parse_role` in `services/platform-api/src/auth.rs` is the
/// authority; this mirrors only what the client needs to branch on.
enum ActorRole { learner, teacher, scholar, admin, ops }

class Actor {
  const Actor({required this.userId, required this.tenantId, required this.role});

  /// Read the claims out of a JWT payload. Returns null for anything that is not a readable token —
  /// a null token, the wrong number of segments, invalid base64, non-object JSON, or an
  /// unrecognised role.
  ///
  /// Null means "treat this device as a plain learner", which is the safe direction: the extra tab
  /// stays hidden and nothing else in the app changes.
  static Actor? fromJwt(String? token) {
    if (token == null) return null;
    final List<String> parts = token.split('.');
    if (parts.length != 3) return null;
    try {
      // base64Url refuses unpadded input, and JWTs are always unpadded. `%4` is never 1 for valid
      // base64, so the padding below is either 0, 1 or 2 '=' — a malformed length falls through to
      // the FormatException catch rather than producing a wrong decode.
      final String payload = parts[1];
      final String padded = payload.padRight((payload.length + 3) ~/ 4 * 4, '=');
      final Object? claims = jsonDecode(utf8.decode(base64Url.decode(padded)));
      if (claims is! Map<String, dynamic>) return null;

      final Object? role = claims['role'];
      final Object? sub = claims['sub'];
      final Object? tenant = claims['tenant_id'];
      if (role is! String || sub is! String || tenant is! String) return null;

      final ActorRole? parsed = _roles[role];
      if (parsed == null) return null;
      return Actor(userId: sub, tenantId: tenant, role: parsed);
    } on Object {
      // Any malformed token is "not a teacher". There is no error to surface: the server will
      // answer 401 on the next request and the app already renders that state.
      return null;
    }
  }

  /// An ALLOWLIST keyed on the exact wire strings. A `values.byName` lookup would accept any future
  /// enum name silently, and an unrecognised role must fall back to learner rather than guess.
  static const Map<String, ActorRole> _roles = <String, ActorRole>{
    'learner': ActorRole.learner,
    'teacher': ActorRole.teacher,
    'scholar': ActorRole.scholar,
    'admin': ActorRole.admin,
    'ops': ActorRole.ops,
  };

  final String userId;
  final String tenantId;
  final ActorRole role;

  /// Whether to DRAW the review surface — matching `require_any([Teacher, Admin, Ops])` on every
  /// route it calls. Scholar is deliberately absent: `list_tajweed_findings` admits a scholar but
  /// `create_teacher_review` does not, so a scholar would get a queue they cannot act on.
  bool get canReviewFindings =>
      role == ActorRole.teacher || role == ActorRole.admin || role == ActorRole.ops;
}
