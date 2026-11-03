import '../../core/navigation/feature.dart';
import 'clearance_strings.dart';
import 'screens/clearance_screen.dart';

/// ST-MOB-024: MOB-68, the field work of the land-clearance officer: the households of a project by code, one household's task with its
/// inventory (counted in the field, kept on the encrypted device when there is no network and sent when there is one), the answer of the
/// household, and the photos of the site. The phone never keeps a name, an identity number, a telephone or an address of a household.
const MobileFeature feature = MobileFeature(
  id: 'site_clearance',
  strings: clearanceStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-68', builder: buildClearanceScreen),
  ],
);
