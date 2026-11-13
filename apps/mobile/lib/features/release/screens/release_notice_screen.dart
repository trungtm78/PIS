import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/router.dart' show homeLocation;
import '../../../core/release/release_notice.dart';
import '../../../core/state/state_card.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../app_info.dart';
import '../release_providers.dart';

/// MOB-54: the application is stopped, either because the server declared this version unsafe (it must be updated, with its
/// reason, and the drafts on the phone stay safe) or because the service is in a maintenance window (the window and its expected
/// end, with the offline drafts still within reach). It opens without a session. Every value is the server's: the clock of the
/// phone decides nothing here.
Widget buildReleaseNoticeScreen(BuildContext context, ScreenContext screen) => const ReleaseNoticeScreen();

class ReleaseNoticeScreen extends ConsumerStatefulWidget {
  const ReleaseNoticeScreen({super.key});

  @override
  ConsumerState<ReleaseNoticeScreen> createState() => _ReleaseNoticeScreenState();
}

class _ReleaseNoticeScreenState extends ConsumerState<ReleaseNoticeScreen> {
  bool _checking = false;
  bool _stillDown = false;
  bool _updateFailed = false;

  Future<void> _check() async {
    final ReleaseNoticeController controller = ref.read(releaseNoticeProvider.notifier);
    if (controller is! PolicyReleaseNotice) return;
    setState(() {
      _checking = true;
      _stillDown = false;
    });
    final ReleaseNotice notice = await controller.check();
    if (!mounted) return;
    setState(() {
      _checking = false;
      _stillDown = notice.blocks;
    });
    if (!notice.blocks) context.go(homeLocation);
  }

  Future<void> _update(Uri url) async {
    final bool opened = await ref.read(urlOpenerProvider).open(url);
    if (mounted) setState(() => _updateFailed = !opened);
  }

  @override
  Widget build(BuildContext context) {
    final ReleaseNotice notice = ref.watch(releaseNoticeProvider);
    final AppInfo? app = ref.watch(appInfoProvider).asData?.value;
    final MachvonV2Text text = context.v2text;
    final String version = app == null ? '' : context.t('mob.release.version.label', <String, Object>{'version': app.full});
    switch (notice.block) {
      case ReleaseBlock.upgradeRequired:
        final Uri? store = notice.storeUrl;
        return AppScaffold(
          showTopBar: false,
          body: StateCard(
            icon: Icons.system_update_outlined,
            title: context.t('mob.release.upgrade.title'),
            body: context.t('mob.release.upgrade.body'),
            announcement: <String>[context.t('mob.release.upgrade.title'), context.t('mob.release.upgrade.body'), context.t('mob.release.upgrade.drafts')].join('. '),
            details: <Widget>[
              Text(context.t('mob.release.upgrade.drafts'), textAlign: TextAlign.center, style: text.body),
              if (notice.reasonCode != null) Text(context.t('mob.release.code.label', <String, Object>{'code': notice.reasonCode!}), style: text.label),
              if (notice.minimumVersion != null) Text(context.t('mob.release.upgrade.minimum', <String, Object>{'version': notice.minimumVersion!})),
              if (version.isNotEmpty) Text(version, style: text.caption),
              if (_updateFailed) Semantics(liveRegion: true, child: Text(context.t('mob.release.upgrade.failed'), textAlign: TextAlign.center)),
            ],
            actions: <Widget>[
              if (store != null) FilledButton(onPressed: () => _update(store), child: Text(context.t('mob.release.upgrade.action'))),
            ],
          ),
        );
      case ReleaseBlock.maintenance:
        final DateTime? starts = notice.windowStartsAt;
        final DateTime? ends = notice.windowEndsAt;
        return AppScaffold(
          showTopBar: false,
          body: StateCard(
            icon: Icons.construction_outlined,
            title: context.t('mob.release.maintenance.title'),
            body: context.t('mob.release.maintenance.body'),
            announcement: <String>[
              context.t('mob.release.maintenance.title'),
              context.t('mob.release.maintenance.body'),
              if (starts != null) context.t('mob.release.maintenance.start', <String, Object>{'time': _time(starts)}),
              if (ends != null) context.t('mob.release.maintenance.end', <String, Object>{'time': _time(ends)}),
            ].join('. '),
            details: <Widget>[
              if (starts != null) Text(context.t('mob.release.maintenance.start', <String, Object>{'time': _time(starts)})),
              if (ends != null) Text(context.t('mob.release.maintenance.end', <String, Object>{'time': _time(ends)}), style: text.label),
              if (version.isNotEmpty) Text(version, style: text.caption),
              if (_stillDown) Semantics(liveRegion: true, child: Text(context.t('mob.release.maintenance.stillDown'), textAlign: TextAlign.center)),
            ],
            actions: <Widget>[
              FilledButton(
                onPressed: () => context.go(ref.read(routeTableProvider).locationOf('MOB-41')),
                child: Text(context.t('mob.release.maintenance.drafts')),
              ),
              OutlinedButton(
                onPressed: _checking ? null : _check,
                child: Text(_checking ? context.t('mob.release.maintenance.checking') : context.t('mob.release.maintenance.check')),
              ),
            ],
          ),
        );
      case ReleaseBlock.none:
        return AppScaffold(
          showTopBar: false,
          body: StateCard(
            icon: Icons.check_circle_outline,
            title: context.t('mob.release.none.title'),
            body: context.t('mob.release.none.body'),
            announcement: '${context.t('mob.release.none.title')}. ${context.t('mob.release.none.body')}',
            details: <Widget>[if (version.isNotEmpty) Text(version, style: text.caption)],
            actions: <Widget>[FilledButton(onPressed: () => context.go(homeLocation), child: Text(context.t('mob.release.none.action')))],
          ),
        );
    }
  }

  /// The time as the server gave it, in Vietnam time like every moment of the phone.
  static String _time(DateTime value) => formatInstant(value);
}
