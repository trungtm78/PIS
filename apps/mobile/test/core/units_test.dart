import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/core/l10n/app_strings.dart';
import 'package:machvon_mobile/core/l10n/core_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';

void main() {
  group('TK-MOB-001-1 small contracts of the foundation', () {
    test('the base URL of the API must be given when the application starts', () {
      expect(AppConfig.fromEnvironment, throwsFormatException);
    });

    test('a tab is found by the key of the navigation architecture', () {
      expect(AppTab.byKey('approval'), AppTab.approval);
      expect(AppTab.byKey('nowhere'), isNull);
      expect(AppTab.values.map((AppTab tab) => tab.name), <String>['home', 'projects', 'approval', 'inbox', 'account']);
    });

    test('the sync status compares by its counts and is idle only when nothing waits', () {
      expect(const SyncStatus(pendingCommands: 1), const SyncStatus(pendingCommands: 1));
      expect(const SyncStatus(pendingCommands: 1).hashCode, const SyncStatus(pendingCommands: 1).hashCode);
      expect(const SyncStatus(pendingCommands: 1), isNot(const SyncStatus(conflicts: 1)));
      expect(const SyncStatus().isIdle, isTrue);
      expect(const SyncStatus(conflicts: 1).isIdle, isFalse);
    });

    test('the session compares by status, tenant and user', () {
      const SessionSnapshot a = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u');
      expect(a, const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u'));
      expect(a.hashCode, const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u').hashCode);
      expect(a, isNot(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'other', userId: 'u')));
      expect(a.isSignedIn, isTrue);
      expect(const SessionSnapshot.signedOut().isSignedIn, isFalse);
    });

    test('the signed-out session has no token', () async {
      expect(await SignedOutSession().accessToken(), isNull);
    });

    test('a string is found in the language asked, a missing key shows itself, and placeholders are filled', () {
      final AppStrings vi = AppStrings('vi', StringCatalogue(<StringTable>[kCoreStrings]));
      final AppStrings en = AppStrings('en', StringCatalogue(<StringTable>[kCoreStrings]));
      expect(vi.t('mob.shell.tab.home'), 'Trang chủ');
      expect(en.t('mob.shell.tab.home'), 'Home');
      expect(vi.t('mob.nothing.such.key'), 'mob.nothing.such.key');
      expect(en.t('mob.banner.sync.pending', <String, Object>{'count': 4}), '4 changes are waiting to be sent');
      expect(en.t('mob.banner.sync.pending', <String, Object>{'other': 4}), '{count} changes are waiting to be sent');
    });

    test('the string delegate supports vi and en only and reloads when the catalogue changes', () async {
      final AppStringsDelegate delegate = AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings]));
      expect(delegate.isSupported(const Locale('vi')), isTrue);
      expect(delegate.isSupported(const Locale('en', 'US')), isTrue);
      expect(delegate.isSupported(const Locale('fr')), isFalse);
      expect((await delegate.load(const Locale('en'))).language, 'en');
      expect(delegate.shouldReload(AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings]))), isTrue);
      expect(delegate.shouldReload(delegate), isFalse);
    });
  });
}
