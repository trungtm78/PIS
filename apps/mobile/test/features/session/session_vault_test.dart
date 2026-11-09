import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/release/release_notice.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/session/auth/session_vault.dart';

import 'support/world.dart';

void main() {
  late MemorySecureStore store;
  late SessionVault vault;

  setUp(() {
    store = MemorySecureStore();
    vault = SessionVault(store);
  });

  group('AC-ST-MOB-002-1 TK-MOB-002-2 what the device keeps of a session', () {
    test('keeps the provider, the refresh token and the context, and its text never shows the token', () async {
      final StoredSession session = StoredSession(config: kOidcConfig, refreshToken: 'refresh-secret', userId: 'sub-ana', tenantId: 'tenant-a', membershipId: 'm-1');
      await vault.saveSession(session);
      final StoredSession loaded = (await vault.loadSession())!;
      expect(loaded.refreshToken, 'refresh-secret');
      expect(loaded.tenantId, 'tenant-a');
      expect(loaded.toString(), isNot(contains('refresh-secret')));
      await vault.clearSession();
      expect(await vault.loadSession(), isNull);
    });

    test('a session record that is damaged, of the wrong shape or with an issuer that cannot be trusted is removed and read as no session', () async {
      store.data['session.v1'] = 'not json';
      expect(await vault.loadSession(), isNull);
      expect(store.data.containsKey('session.v1'), isFalse);

      store.data['session.v1'] = jsonEncode(<String, Object?>{'refresh_token': 'x'});
      expect(await vault.loadSession(), isNull);
      expect(store.data.containsKey('session.v1'), isFalse);

      store.data['session.v1'] = jsonEncode(<String, Object?>{
        'config': <String, Object?>{'issuer': 'http://evil.example/realms/x', 'client_id': 'c', 'redirect_uri': 'vn.machvon.app:/oauth2redirect'},
        'refresh_token': 'x',
        'user_id': 'u',
        'tenant_id': 't',
        'membership_id': 'm',
      });
      expect(await vault.loadSession(), isNull);
      expect(store.data.containsKey('session.v1'), isFalse);
    });

    test('the last context is a hint: kept after the session is gone, merged field by field, removed when damaged', () async {
      await vault.saveLast(const LastContext(tenantCode: 'minh-ha'));
      await vault.saveLast((await vault.loadLast())!.copyWith(config: kOidcConfig, tenantId: 'tenant-a', membershipId: 'm-1'));
      final LastContext last = (await vault.loadLast())!;
      expect((last.tenantCode, last.tenantId, last.membershipId, last.config), ('minh-ha', 'tenant-a', 'm-1', kOidcConfig));
      expect(last.copyWith(tenantCode: 'bo').tenantCode, 'bo');
      await vault.saveLast(last.copyWith(tenantName: 'Tổng công ty Đạm Phú Mỹ'));
      final LastContext named = (await vault.loadLast())!;
      expect((named.tenantName, named.tenantCode, named.tenantId), ('Tổng công ty Đạm Phú Mỹ', 'minh-ha', 'tenant-a'));
      expect(last.copyWith(tenantCode: 'bo').tenantId, 'tenant-a');

      await vault.clearLast();
      expect(await vault.loadLast(), isNull);
      store.data['last_context.v1'] = '[1]';
      expect(await vault.loadLast(), isNull);
      store.data['last_context.v1'] = 'not json';
      expect(await vault.loadLast(), isNull);
      expect(store.data.containsKey('last_context.v1'), isFalse);
      store.data['last_context.v1'] = jsonEncode(<String, Object?>{
        'config': <String, Object?>{'issuer': 'http://evil.example/x', 'client_id': 'c', 'redirect_uri': 'vn.machvon.app:/o'},
      });
      expect(await vault.loadLast(), isNull);
      expect(store.data.containsKey('last_context.v1'), isFalse);
    });

    test('the tenants with data, the purge journal and the preferences are sets and flags that survive a restart', () async {
      await vault.addTenant('b');
      await vault.addTenant('a');
      expect(await SessionVault(store).knownTenants(), <String>{'a', 'b'});
      await vault.removeTenant('a');
      await vault.removeTenant('b');
      expect(store.data.containsKey('tenants.v1'), isFalse, reason: 'an empty set is not kept');

      await vault.markPurge('t/u');
      expect(await vault.pendingPurges(), <String>{'t/u'});
      await vault.markPurgeDone('t/u');
      expect(await vault.pendingPurges(), isEmpty);
      store.data['purge_pending.v1'] = '{"a":1}';
      expect(await vault.pendingPurges(), isEmpty);

      expect(await vault.localDataPolicy(), LocalDataPolicy.purge);
      await vault.setLocalDataPolicy(LocalDataPolicy.keepEncrypted);
      expect(await vault.localDataPolicy(), LocalDataPolicy.keepEncrypted);
      expect(await vault.biometricUnlock(), isFalse);
      await vault.setBiometricUnlock(enabled: true);
      expect(await vault.biometricUnlock(), isTrue);
      await vault.setBiometricUnlock(enabled: false);
      expect(await vault.biometricUnlock(), isFalse);
    });

    test('the values of one tenant are found by their prefix and no other value is touched', () async {
      store.data[tenantKey('a', 'theme.v1')] = '1';
      store.data[tenantKey('a', 'other')] = '2';
      store.data[tenantKey('ab', 'theme.v1')] = '3';
      store.data['session.v1'] = '4';
      await vault.deleteTenantValues('a');
      expect(store.data.keys.toSet(), <String>{'tenant.ab.theme.v1', 'session.v1'});
    });
  });

  group('AC-ST-MOB-002-3 the state of a session is a value', () {
    test('two snapshots with the same content are equal and hash alike; a different field makes them different', () {
      const SessionSnapshot a = SessionSnapshot(
        status: SessionStatus.signedIn,
        tenantId: 't',
        userId: 'u',
        membershipId: 'm',
        mode: SessionMode.readOnly,
        assurance: AssuranceLevel.aal2,
        stepUpRequired: true,
        locked: true,
      );
      const SessionSnapshot b = SessionSnapshot(
        status: SessionStatus.signedIn,
        tenantId: 't',
        userId: 'u',
        membershipId: 'm',
        mode: SessionMode.readOnly,
        assurance: AssuranceLevel.aal2,
        stepUpRequired: true,
        locked: true,
      );
      expect(a, b);
      expect(a.hashCode, b.hashCode);
      expect(a.isReadOnly, isTrue);
      expect(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't'), isNot(a));
      expect(const SessionSnapshot.signedOut().isSignedIn, isFalse);
    });

    test('two release notices with the same content are equal and hash alike', () {
      final ReleaseNotice a = ReleaseNotice(block: ReleaseBlock.maintenance, reasonCode: 'X_Y_Z', windowEndsAt: DateTime.utc(2026), storeUrl: Uri.parse('https://a.example/'));
      final ReleaseNotice b = ReleaseNotice(block: ReleaseBlock.maintenance, reasonCode: 'X_Y_Z', windowEndsAt: DateTime.utc(2026), storeUrl: Uri.parse('https://a.example/'));
      expect(a, b);
      expect(a.hashCode, b.hashCode);
      expect(a, isNot(const ReleaseNotice()));
      expect(const ReleaseNotice().blocks, isFalse);
      expect(a.blocks, isTrue);
    });
  });
}
