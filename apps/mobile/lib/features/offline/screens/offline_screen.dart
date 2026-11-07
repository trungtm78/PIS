import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/drafts/local_draft.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/offline/store/local_store.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../offline_format.dart';
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
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.offline.title.label'))),
      body: SafeArea(
        child: StateBoundary(
          state: state,
          problem: problem,
          onRetry: () => ref.invalidate(localStoreProvider),
          keepContent: false,
          child: store.hasValue ? _Guide(store: store.requireValue, offline: reachability == Reachability.offline) : const SizedBox.shrink(),
        ),
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
    final ThemeData theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        Semantics(
          container: true,
          liveRegion: true,
          child: Text(
            offline ? context.t('mob.offline.status.offline.title') : context.t('mob.offline.status.online.title'),
            style: theme.textTheme.titleLarge,
          ),
        ),
        const SizedBox(height: 8),
        if (asOf == null)
          Text(context.t('mob.offline.asof.none'))
        else ...<Widget>[
          Text(context.t('mob.offline.asof.label', <String, Object>{'time': formatMoment(asOf, language)}), style: const TextStyle(fontWeight: FontWeight.w600)),
          Text(context.t('mob.offline.asof.notice')),
        ],
        const SizedBox(height: 16),
        Text(context.t('mob.offline.available.title'), style: theme.textTheme.titleMedium),
        Text(context.t('mob.offline.available.body')),
        const SizedBox(height: 4),
        _Bullet(context.t('mob.offline.available.item.report')),
        _Bullet(context.t('mob.offline.available.item.issue')),
        _Bullet(context.t('mob.offline.available.item.diary')),
        _Bullet(context.t('mob.offline.available.item.measurement')),
        const SizedBox(height: 16),
        Text(context.t('mob.offline.online.title'), style: theme.textTheme.titleMedium),
        Text(context.t('mob.offline.online.body')),
        const SizedBox(height: 16),
        Text(context.t('mob.offline.drafts.title', <String, Object>{'count': drafts.length}), style: theme.textTheme.titleMedium),
        if (drafts.isEmpty) Text(context.t('mob.offline.drafts.empty')),
        for (final LocalDraft draft in drafts)
          ListTile(
            key: ValueKey<String>(draft.id),
            contentPadding: EdgeInsets.zero,
            title: Text(_kindLabel(context, draft.kind)),
            subtitle: Text(context.t('mob.offline.draft.saved.label', <String, Object>{'time': formatMoment(DateTime.fromMillisecondsSinceEpoch(draft.updatedAt, isUtc: true), language)})),
          ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: () => context.push(ref.read(routeTableProvider).locationOf('MOB-41')),
          child: Text(context.t('mob.offline.queue.link.action', <String, Object>{'count': waiting})),
        ),
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

class _Bullet extends StatelessWidget {
  const _Bullet(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Text('•  '),
            Expanded(child: Text(text)),
          ],
        ),
      );
}
