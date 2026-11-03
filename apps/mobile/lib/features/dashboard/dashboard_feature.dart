import '../../core/navigation/feature.dart';
import 'dashboard_strings.dart';
import 'screens/funding_structure_screen.dart';
import 'screens/leader_home_screen.dart';
import 'screens/officer_home_screen.dart';

/// ST-MOB-010: the home dashboards. MOB-07 the leader's command center, MOB-08 the officer's work, MOB-58 the funding
/// structure. The screens only read; they use the cache rules of `read_support` (BR-MOB-01).
const MobileFeature feature = MobileFeature(
  id: 'dashboard',
  strings: dashboardStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-07', builder: buildLeaderHomeScreen),
    ScreenSpec(screenId: 'MOB-08', builder: buildOfficerHomeScreen),
    ScreenSpec(screenId: 'MOB-58', builder: buildFundingStructureScreen),
  ],
);
