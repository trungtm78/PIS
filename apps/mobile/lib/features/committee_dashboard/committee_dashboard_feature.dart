import '../../core/navigation/feature.dart';
import 'committee_dashboard_strings.dart';
import 'screens/committee_dashboard_screen.dart';

/// BAN-1 on the phone: MOB-72 the dashboard of the head of the provincial steering committee, read only. It is opened from the card of the leader home and from an
/// alert of the committee. The commands (decisions on the attention list, acknowledgement of alerts, the roster) stay on the computer.
const MobileFeature feature = MobileFeature(
  id: 'committee_dashboard',
  strings: committeeDashboardStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-72', builder: buildCommitteeDashboardScreen),
  ],
);
