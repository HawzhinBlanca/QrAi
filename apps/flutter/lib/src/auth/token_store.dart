/// FL3 — where the bearer token lives.
///
/// Keychain on iOS, EncryptedSharedPreferences on Android. Never `SharedPreferences`, never a file,
/// never a log line, never a field that outlives the request that needed it.
///
/// ── Why the options blocks are not defaults ─────────────────────────────────────────────────────
/// `flutter_secure_storage`'s Android default is the plain `SharedPreferences` backend unless
/// `encryptedSharedPreferences: true` is passed — a default that silently downgrades a "secure"
/// store to a world-readable-by-root XML file. On iOS the default accessibility is
/// `kSecAttrAccessibleWhenUnlocked`, which survives into an unencrypted device backup;
/// `first_unlock_this_device` keeps the token off backups and off other devices entirely.
library;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class TokenStore {
  TokenStore({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
              iOptions: IOSOptions(
                accessibility: KeychainAccessibility.first_unlock_this_device,
              ),
            );

  static const String _tokenKey = 'qrai.bearerToken';

  final FlutterSecureStorage _storage;

  /// Read the token, or null when there is none.
  ///
  /// A read failure is NOT an error the caller must handle: a locked or corrupt keychain means the
  /// user is not signed in, which is a state the app already renders. Throwing here would turn a
  /// recoverable "sign in again" into a crash on launch.
  Future<String?> read() async {
    try {
      final String? value = await _storage.read(key: _tokenKey);
      if (value == null || value.isEmpty) return null;
      return value;
    } on Object {
      return null;
    }
  }

  Future<void> write(String token) async {
    if (token.isEmpty) {
      throw ArgumentError.value(token, 'token', 'refusing to store an empty token');
    }
    await _storage.write(key: _tokenKey, value: token);
  }

  /// Remove the token. Used on sign-out and on a 401.
  ///
  /// Deliberately tolerant: a delete that fails because the key was already gone is a success, and
  /// a sign-out that throws would leave the user looking signed in.
  Future<void> clear() async {
    try {
      await _storage.delete(key: _tokenKey);
    } on Object {
      // nothing to do — the goal is "no token readable", and read() returning null satisfies it
    }
  }
}
