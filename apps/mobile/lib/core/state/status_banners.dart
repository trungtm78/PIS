import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../connectivity/reachability.dart';
import '../di/providers.dart';
import '../l10n/app_strings.dart';
import '../security/device_integrity.dart';
import '../security/integrity_state.dart';
import '../sync/sync_status.dart';

/// The screen of the queue (MOB-41): what the sync banner opens.
const String _queueScreenId = 'MOB-41';

/// The banners above every tab: "you are offline" while the device cannot reach the server, "n changes are waiting" while commands
/// are queued or in conflict (a button: it opens the queue), and, once per session, the notice that this phone looks modified. Each
/// is a live region, so the change is announced; none takes space when there is nothing to say.
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
        if (offline)
          _Banner(
            icon: Icons.cloud_off_outlined,
            text: '${context.t('mob.banner.offline.title')}. ${context.t('mob.banner.offline.body')}',
          ),
        if (sync.conflicts > 0)
          _Banner(icon: Icons.sync_problem, text: context.t('mob.banner.sync.conflict', <String, Object>{'count': sync.conflicts}), onOpen: openQueue)
        else if (sync.pendingCommands > 0)
          _Banner(icon: Icons.sync, text: context.t('mob.banner.sync.pending', <String, Object>{'count': sync.pendingCommands}), onOpen: openQueue),
        if (integrity.warningVisible)
          _Banner(
            icon: Icons.warning_amber_outlined,
            text: integrity.decision.level == IntegrityLevel.restrict ? context.t('mob.banner.integrity.restrict') : context.t('mob.banner.integrity.warn'),
            actionLabel: context.t('mob.banner.integrity.dismiss'),
            onAction: ref.read(integrityProvider.notifier).dismissWarning,
          ),
      ],
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.icon, required this.text, this.onOpen, this.actionLabel, this.onAction});

  final IconData icon;
  final String text;

  /// The whole banner is a button that opens something.
  final VoidCallback? onOpen;

  /// A separate button at the end of the banner.
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final Widget row = ConstrainedBox(
      constraints: BoxConstraints(minHeight: onOpen == null && onAction == null ? 0 : kMinInteractiveDimension),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
        child: Row(
          children: <Widget>[
            ExcludeSemantics(child: Icon(icon, size: MachvonSpace.space20, color: theme.colorScheme.primary)),
            const SizedBox(width: MachvonSpace.space8),
            Expanded(child: Text(text, style: theme.textTheme.bodySmall?.copyWith(color: MachvonColors.ink))),
            if (onOpen != null) ExcludeSemantics(child: Icon(Icons.chevron_right, size: MachvonSpace.space20, color: theme.colorScheme.primary)),
            if (actionLabel != null) TextButton(onPressed: onAction, child: Text(actionLabel!)),
          ],
        ),
      ),
    );
    return Semantics(
      container: true,
      liveRegion: true,
      child: ColoredBox(
        color: MachvonColors.selected,
        child: onOpen == null ? row : InkWell(onTap: onOpen, child: Semantics(button: true, child: row)),
      ),
    );
  }
}
