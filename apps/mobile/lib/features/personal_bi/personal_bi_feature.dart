import '../../core/navigation/feature.dart';
import 'personal_bi_strings.dart';
import 'screens/dashboard_screen.dart';

/// ST-MOB-027: the personal BI dashboard (MOB-40). The library of the dashboards of the reader, and one dashboard with its tiles read
/// over one snapshot, the banner for newer data, the renewal, and the drill from a group to the figures behind it. The figures are
/// those of the web (the same operations, decided by the server); nothing is computed on the phone.
const MobileFeature feature = MobileFeature(
  id: 'personal_bi',
  strings: personalBiStrings,
  screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-40', builder: buildDashboardScreen)],
);
