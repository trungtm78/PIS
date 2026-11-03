import '../../core/navigation/feature.dart';
import 'payment_strings.dart';
import 'screens/payment_timeline_screen.dart';
import 'screens/reconciliation_screen.dart';

/// ST-MOB-025: MOB-27, the payment requests of a project on a timeline (read only: the phone never creates, changes or sends a payment
/// request), and MOB-60, the Treasury reconciliation items with both amounts and their difference side by side (no figure is chosen; the
/// person may write down what was found, online, where the server offers it).
const MobileFeature feature = MobileFeature(
  id: 'payment_tracking',
  strings: paymentStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-27', builder: buildPaymentTimelineScreen),
    ScreenSpec(screenId: 'MOB-60', builder: buildReconciliationScreen),
  ],
);
