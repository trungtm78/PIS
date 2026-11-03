import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import '../../core/di/providers.dart';
import '../../core/session/session.dart';
import '../../core/theme/app_theme.dart';
import '../session/session_providers.dart';
import 'published_theme.dart';
import 'tenant_directory.dart';
import 'theme_service.dart';

/// The directory of tenants. Tests override it with a fake.
final Provider<TenantDirectory> tenantDirectoryProvider = Provider<TenantDirectory>(
  (Ref ref) => HttpTenantDirectory(
    baseUrl: ref.watch(appConfigProvider).apiBaseUrl,
    transport: ref.watch(httpTransportProvider),
    locale: () => ref.read(localeProvider).languageCode,
  ),
);

/// The version of the published theme applied now (tenant, version, hash), or null for the base theme.
class ActiveThemeNotifier extends Notifier<ActiveTheme?> {
  @override
  ActiveTheme? build() => null;

  void set(ActiveTheme? value) => state = value;
}

final NotifierProvider<ActiveThemeNotifier, ActiveTheme?> activeThemeProvider =
    NotifierProvider<ActiveThemeNotifier, ActiveTheme?>(ActiveThemeNotifier.new);

final Provider<TenantThemeService> tenantThemeServiceProvider = Provider<TenantThemeService>(
  (Ref ref) => TenantThemeService(
    store: ref.watch(secureValueStoreProvider),
    publish: (Map<String, String>? overlay) => ref.read(tenantThemeProvider.notifier).publish(overlay),
    activate: (ActiveTheme? theme) => ref.read(activeThemeProvider.notifier).set(theme),
    fetchMine: () => ref.read(apiClientProvider).execute('getMyPublishedTheme'),
  ),
);

/// The theme notifier of the application: it follows the session. When a tenant is entered, the theme of the tenant left is
/// dropped at once, the copy kept for the new tenant is applied, and the published theme is read from the server; when the
/// person signs out nothing of the tenant stays. The route, the scroll positions and the forms are untouched: only `ThemeData`
/// changes. `main.dart` installs it with `tenantThemeProvider.overrideWith(PublishedTenantTheme.new)`.
class PublishedTenantTheme extends TenantThemeNotifier {
  String? _tenant;

  @override
  Map<String, String>? build() {
    ref.listen<SessionSnapshot>(sessionProvider, (SessionSnapshot? previous, SessionSnapshot next) => unawaited(_follow(next)));
    unawaited(_follow(ref.read(sessionProvider)));
    return null;
  }

  Future<void> _follow(SessionSnapshot session) async {
    final TenantThemeService service = ref.read(tenantThemeServiceProvider);
    final String? tenant = session.status == SessionStatus.signedIn ? session.tenantId : null;
    if (session.status == SessionStatus.expired) return;
    if (tenant == _tenant) return;
    _tenant = tenant;
    service.clear();
    if (tenant == null) return;
    await service.restore(tenant);
    if (_tenant == tenant) await service.refresh(tenant);
  }

  /// Reads the published theme of the active tenant again (the person pulled to refresh, or the application came back).
  Future<bool> refresh() async {
    final String? tenant = _tenant;
    return tenant != null && await ref.read(tenantThemeServiceProvider).refresh(tenant);
  }
}

/// What the application root installs for the tenant theme.
List<Override> themeOverrides() => <Override>[tenantThemeProvider.overrideWith(PublishedTenantTheme.new)];
