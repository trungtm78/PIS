import '../../core/navigation/feature.dart';
import 'offline_strings.dart';
import 'screens/conflict_screen.dart';
import 'screens/offline_screen.dart';
import 'screens/queue_screen.dart';

/// ST-MOB-005 and ST-MOB-006: the queue of commands waiting on the device (MOB-41), the comparison of the version on the
/// device with the version on the server (MOB-42) and the offline guide (MOB-43). The queue itself is
/// `lib/core/offline`; docs/mobile-offline.md describes how a feature uses it.
const MobileFeature feature = MobileFeature(
  id: 'offline',
  strings: offlineStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-41', builder: buildQueueScreen),
    ScreenSpec(screenId: 'MOB-42', pathSuffix: '/:commandId', builder: buildConflictScreen),
    ScreenSpec(screenId: 'MOB-43', builder: buildOfflineScreen),
  ],
);
