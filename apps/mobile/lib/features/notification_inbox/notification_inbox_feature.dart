import '../../core/navigation/deep_link_guard.dart' show LocationRule;
import '../../core/navigation/feature.dart';
import 'deep_links.dart';
import 'notification_strings.dart';
import 'screens/notification_detail_screen.dart';
import 'screens/notification_inbox_screen.dart';
import 'screens/notification_preferences_screen.dart';

/// ST-MOB-015: the notifications. MOB-32 the inbox, MOB-33 the detail with read and acknowledged kept apart, MOB-34 the
/// preferences; the opaque deep link of a push (`/r/<id>`) is routed by a rule of the deep-link guard, after the sign-in and the
/// tenant check; the registration of the device for push is `push_registration.dart`.
const MobileFeature feature = MobileFeature(
  id: 'notification_inbox',
  strings: notificationStrings,
  locationRules: <LocationRule>[opaqueLinkRule],
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-32', builder: buildNotificationInboxScreen),
    ScreenSpec(screenId: 'MOB-33', pathSuffix: '/:notificationId', builder: buildNotificationDetailScreen),
    ScreenSpec(screenId: 'MOB-34', builder: buildNotificationPreferencesScreen),
  ],
);
