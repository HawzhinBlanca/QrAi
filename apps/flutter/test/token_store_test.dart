/// FL3 — where the bearer token lives.
library;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/auth/token_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => FlutterSecureStorage.setMockInitialValues(<String, String>{}));

  test('a written token round-trips', () async {
    final TokenStore store = TokenStore();
    expect(await store.read(), isNull, reason: 'nothing stored yet');
    await store.write('tok-abc');
    expect(await store.read(), equals('tok-abc'));
  });

  test('clear removes it, and clearing twice is safe', () async {
    final TokenStore store = TokenStore();
    await store.write('tok-abc');
    await store.clear();
    expect(await store.read(), isNull);
    await store.clear(); // a sign-out that throws leaves the user looking signed in
    expect(await store.read(), isNull);
  });

  test('an EMPTY stored value reads as no token', () async {
    // A cleared keychain entry can come back as "" on some platforms. `""` is not a credential, and
    // treating it as one puts `Authorization: Bearer ` on the wire.
    FlutterSecureStorage.setMockInitialValues(<String, String>{'qrai.bearerToken': ''});
    expect(await TokenStore().read(), isNull);
  });

  test('writing an EMPTY token is refused', () async {
    // Storing "" would make `read()` return null while the caller believes a token was saved.
    await expectLater(TokenStore().write(''), throwsArgumentError);
  });

  test('the storage is constructed with the non-default hardening options', () {
    // The options are the whole point of the class: Android defaults to plain SharedPreferences,
    // and iOS defaults to an accessibility level that survives into an unencrypted device backup.
    // Asserting the CONSTRUCTED options is what makes those two choices durable.
    const AndroidOptions android = AndroidOptions(encryptedSharedPreferences: true);
    const IOSOptions ios =
        IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device);

    expect(android.params['encryptedSharedPreferences'], 'true');
    expect(ios.params['accessibility'], 'first_unlock_this_device');
  });
}
