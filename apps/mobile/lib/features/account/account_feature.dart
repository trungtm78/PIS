import '../../core/navigation/feature.dart';
import 'account_strings.dart';
import 'screens/account_screen.dart';
import 'screens/devices_screen.dart';
import 'screens/tenant_switch_screen.dart';

/// ST-MOB-008: the account (MOB-47: profile, language, biometric unlock, push state), the tenant switch with the guard for
/// unsent commands and the purge of the local data of the tenant left (MOB-48), and the devices and sign-out (MOB-49).
const MobileFeature feature = MobileFeature(
  id: 'account',
  strings: accountStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-47', builder: buildAccountScreen),
    ScreenSpec(screenId: 'MOB-48', builder: buildTenantSwitchScreen),
    ScreenSpec(screenId: 'MOB-49', builder: buildDevicesScreen),
  ],
);
