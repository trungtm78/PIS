import '../../core/navigation/feature.dart';
import 'permissions_strings.dart';
import 'screens/error_screens.dart';
import 'screens/permission_screen.dart';

/// ST-MOB-003: the permission rationale screens (MOB-05 push, MOB-06 camera and position), and the two screens that explain a
/// refusal of the server: no permission (MOB-45) and an expired licence (MOB-46). A feature that needs a permission calls
/// `requestPermissions` of `permission_providers.dart`; a screen that meets a refusal opens `errorScreenLocation`.
const MobileFeature feature = MobileFeature(
  id: 'permissions',
  strings: permissionsStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-05', builder: buildNotificationPermissionScreen),
    ScreenSpec(screenId: 'MOB-06', builder: buildCameraLocationPermissionScreen),
    ScreenSpec(screenId: 'MOB-45', builder: buildAccessDeniedScreen),
    ScreenSpec(screenId: 'MOB-46', builder: buildLicenceExpiredScreen),
  ],
);
