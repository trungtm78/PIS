import '../../core/navigation/feature.dart';
import 'screens/empty_state_screen.dart';
import 'screens/error_state_screen.dart';

/// ST-MOB-001: the screens of the foundation, the empty state (MOB-52) and the service error with retry (MOB-53).
const MobileFeature feature = MobileFeature(
  id: 'foundation',
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-52', builder: buildEmptyStateScreen),
    ScreenSpec(screenId: 'MOB-53', builder: buildErrorStateScreen),
  ],
);
