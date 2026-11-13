import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/drafts/local_draft.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/offline/store/local_store.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/work_row.dart';
import '../offline_problem.dart';

/// MOB-43: what the person can do without a network, the drafts that are on the device, and how old the data on the device
/// is (ST-MOB-005, BR-MOB-01). It names the time the data was last known to match the server and says that it may have
/// changed since; it never calls data from the device the latest.
Widget buildOfflineScreen(BuildContext context, ScreenContext screen) => const OfflineScreen();

class OfflineScreen extends ConsumerWidget {
  const OfflineScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<LocalStore> store = ref.watch(localStoreProvider);
    final Reachability reachability = ref.watch(reachabilityProvider);
    ScreenState state = ScreenState.defaultState;
    ProblemView? problem;
    if (store.hasError) {
      problem = offlineProblemOf(store.error!, reachability);
      state = problem.state;
    } else if (!store.hasValue) {
      state = ScreenState.loading;
    }
    return AppScaffold(
      title: context.t('mob.offline.title.label'),
      body: StateBoundary(
        state: state,
        problem: problem,
        onRetry: () => ref.invalidate(localStoreProvider),
        keepContent: false,
        child: store.hasValue ? _Guide(store: store.requireValue, offline: reachability == Reachability.offline) : const SizedBox.shrink(),
      ),
    );
  }
}

class _Guide extends ConsumerWidget {
  const _Guide({required this.store, required this.offline});

  final LocalStore store;
  final bool offline;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final String language = Localizations.localeOf(context).languageCode;
    final DateTime? asOf = store.dataAsOf;
    final List<LocalDraft> drafts = store.drafts.all();
    final int waiting = (ref.watch(queuedCommandsProvider).value ?? const <QueuedCommand>[]).where((QueuedCommand c) => c.state.isPending).length;
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String queueLabel = context.t('mob.offline.queue.link.action', <String, Object>{'count': waiting});
    Widget heading(String title) => Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s24, MachvonV2Space.s16, MachvonV2Space.s8),
          child: Semantics(header: true, child: Text(title, style: text.heading)),
        );
    Widget bullet(String line) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              ExcludeSemantics(child: Icon(Icons.check_circle_outline, size: 18, color: v2.palette.primaryStrong)),
              const SizedBox(width: MachvonV2Space.s8),
              Expanded(child: Text(line, style: text.body)),
            ],
          ),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s8),
                child: Semantics(
                  container: true,
                  liveRegion: true,
                  child: Text(offline ? context.t('mob.offline.status.offline.title') : context.t('mob.offline.status.online.title'), style: text.title),
                ),
              ),
              if (asOf == null)
                Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16), child: Text(context.t('mob.offline.asof.none'), style: text.body))
              else
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(context.t('mob.offline.asof.label', <String, Object>{'time': formatInstant(asOf, language: language)}), style: text.bodyStrong),
                      Text(context.t('mob.offline.asof.notice'), style: text.caption.copyWith(color: v2.palette.ink2)),
                    ],
                  ),
                ),
              heading(context.t('mob.offline.available.title')),
              Padding(padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s8), child: Text(context.t('mob.offline.available.body'), style: text.body)),
              bullet(context.t('mob.offline.available.item.report')),
              bullet(context.t('mob.offline.available.item.issue')),
              bullet(context.t('mob.offline.available.item.diary')),
              bullet(context.t('mob.offline.available.item.measurement')),
              heading(context.t('mob.offline.online.title')),
              Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16), child: Text(context.t('mob.offline.online.body'), style: text.body)),
              heading(context.t('mob.offline.drafts.title', <String, Object>{'count': drafts.length})),
              if (drafts.isEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16), child: Text(context.t('mob.offline.drafts.empty'), style: text.body)),
              for (int i = 0; i < drafts.length; i += 1)
                WorkRow(
                  key: ValueKey<String>(drafts[i].id),
                  title: _kindLabel(context, drafts[i].kind),
                  subtitle: context.t('mob.offline.draft.saved.label', <String, Object>{'time': formatInstant(DateTime.fromMillisecondsSinceEpoch(drafts[i].updatedAt, isUtc: true), language: language)}),
                  dividerAbove: i > 0,
                ),
            ],
          ),
        ),
        ActionBar(primary: ActionBarButton(label: queueLabel, icon: Icons.outbox_outlined, onPressed: () => context.push(ref.read(routeTableProvider).locationOf('MOB-41')))),
      ],
    );
  }

  String _kindLabel(BuildContext context, String kind) {
    switch (kind) {
      case 'report':
        return context.t('mob.offline.draft.kind.report');
      case 'issue':
        return context.t('mob.offline.draft.kind.issue');
      case 'site_diary':
        return context.t('mob.offline.draft.kind.siteDiary');
      default:
        return context.t('mob.offline.draft.kind.other');
    }
  }
}
