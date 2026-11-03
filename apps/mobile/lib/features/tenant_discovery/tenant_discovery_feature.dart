import '../../core/navigation/feature.dart';
import 'screens/welcome_screen.dart';
import 'tenant_discovery_strings.dart';

/// ST-MOB-004: the welcome screen MOB-01 (tenant discovery) and the published tenant theme. The theme follows the session
/// through `PublishedTenantTheme` of `theme_providers.dart`, which the application root installs with `themeOverrides()`.
const MobileFeature feature = MobileFeature(
  id: 'tenant_discovery',
  strings: tenantDiscoveryStrings,
  screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-01', builder: buildWelcomeScreen)],
);
