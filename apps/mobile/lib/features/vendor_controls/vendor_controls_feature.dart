import '../../core/navigation/feature.dart';
import 'screens/contractor_screen.dart';
import 'screens/risk_list_screen.dart';
import 'vendor_strings.dart';

/// VND-2 on the phone: MOB-73 the grades of risk of the contractors and MOB-74 the grade and the performance of one contractor, read only. The grade is
/// a signal with its explanation; the commands (assessing, confirming, rejecting, posting a rating) stay on the computer, where a second person is needed.
const MobileFeature feature = MobileFeature(
  id: 'vendor_controls',
  strings: vendorStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-73', builder: buildRiskListScreen),
    ScreenSpec(screenId: 'MOB-74', pathSuffix: '/:contractorId', builder: buildContractorScreen),
  ],
);
