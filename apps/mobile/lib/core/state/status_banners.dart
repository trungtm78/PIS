import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../connectivity/reachability.dart';
import '../di/providers.dart';
import '../l10n/app_strings.dart';
import '../security/device_integrity.dart';
import '../security/integrity_state.dart';
import '../sync/sync_status.dart';
import '../widgets/state_view.dart';

/// The screen of the queue (MOB-41): what the sync banner opens.
const String _queueScreenId = 'MOB-41';

/// The strips above every tab, all drawn with the one `StatusBanner`: "you are offline" while the device cannot reach the server, "n changes
/// are waiting" while commands are queued or in conflict (a button: it opens the queue), and, once per session, the notice that this phone
/// looks modified. Each is a live region, so the change is announced; none takes space when there is nothing to say. A screen that shows a
/// saved copy does not add a second offline strip while this one is up (`FreshnessBar`): the connection is told once.
class StatusBanners extends ConsumerWidget {
  const StatusBanners({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bool offline = ref.watch(reachabilityProvider) == Reachability.offline;
    final SyncStatus sync = ref.watch(syncStatusProvider);
    final IntegrityStatus integrity = ref.watch(integrityProvider);
    // `go`, not `push`: the queue belongs to the Projects tab, and going there twice is the same place, not two copies of it.
    void openQueue() => context.go(ref.read(routeTableProvider).locationOf(_queueScreenId));

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (offline) StatusBanner(text: '${context.t('mob.banner.offline.title')}. ${context.t('mob.banner.offline.body')}'),
        if (sync.conflicts > 0)
          StatusBanner(tone: BannerTone.warning, icon: Icons.sync_problem, text: context.t('mob.banner.sync.conflict', <String, Object>{'count': sync.conflicts}), onTap: openQueue)
        else if (sync.pendingCommands > 0)
          StatusBanner(icon: Icons.sync, text: context.t('mob.banner.sync.pending', <String, Object>{'count': sync.pendingCommands}), onTap: openQueue),
        if (integrity.warningVisible)
          StatusBanner(
            tone: integrity.decision.level == IntegrityLevel.restrict ? BannerTone.late : BannerTone.warning,
            icon: Icons.warning_amber_outlined,
            text: integrity.decision.level == IntegrityLevel.restrict ? context.t('mob.banner.integrity.restrict') : context.t('mob.banner.integrity.warn'),
            actionLabel: context.t('mob.banner.integrity.dismiss'),
            onAction: ref.read(integrityProvider.notifier).dismissWarning,
          ),
      ],
    );
  }
}
