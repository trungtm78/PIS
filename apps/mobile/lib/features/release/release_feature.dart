import '../../core/navigation/feature.dart';
import 'release_strings.dart';
import 'screens/help_screen.dart';
import 'screens/release_notice_screen.dart';

/// ST-MOB-016: the release channel in the application. MOB-54 stops the application when the server declares this version unsafe
/// or the service is in a maintenance window; MOB-50 sends a help request as a support ticket with the software versions. The
/// version policy and the telemetry are in `release_providers.dart` and `telemetry.dart`; the application root installs them.
const MobileFeature feature = MobileFeature(
  id: 'release',
  strings: releaseStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-50', builder: buildHelpScreen),
    ScreenSpec(screenId: 'MOB-54', builder: buildReleaseNoticeScreen),
  ],
);
