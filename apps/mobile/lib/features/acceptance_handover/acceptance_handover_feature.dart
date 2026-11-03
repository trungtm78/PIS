import '../../core/navigation/feature.dart';
import 'acceptance_strings.dart';
import 'screens/acceptance_screen.dart';
import 'screens/handover_screen.dart';

/// ST-MOB-022: MOB-65 quality acceptance minutes (read, sign, approve: online only, never from a cache) and MOB-66 the handover and
/// warranty list (read only). One record is opened with a query parameter (`?acceptance=<id>`, `?handover=<id>`), so a screen
/// without it is the list.
const MobileFeature feature = MobileFeature(
  id: 'acceptance_handover',
  strings: acceptanceStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-65', builder: buildAcceptanceScreen),
    ScreenSpec(screenId: 'MOB-66', builder: buildHandoverScreen),
  ],
);
