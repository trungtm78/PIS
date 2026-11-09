import '../../core/navigation/feature.dart';
import 'reads_strings.dart';
import 'screens/reads_screens.dart';

/// Read-only views of the phone for delegations and absences (MOB-75, ADM-04, ADM-25, ADM-28), the KPI register (MOB-76) and the report
/// catalogue (MOB-77). Opened from the account screen. No command exists on these screens.
const MobileFeature feature = MobileFeature(
  id: 'governance_reads',
  strings: readsStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-75', builder: buildDelegationsScreen),
    ScreenSpec(screenId: 'MOB-76', builder: buildKpiRegisterScreen),
    ScreenSpec(screenId: 'MOB-77', builder: buildReportCatalogueScreen),
  ],
);
