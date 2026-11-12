import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/drafts/local_draft.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../data/report_drafts.dart';
import '../data/report_providers.dart';
import '../data/submit_flow.dart';
import '../model/report_cells.dart';
import '../widgets/draft_host.dart';
import '../widgets/notices.dart';

/// MOB-22: the reports being drafted on this phone, the last saved first, each with its project, its period, when it was saved and
/// where it stands (being written, waiting to be sent, refused, kept by the server). A draft is opened to go on with it, or dropped
/// from the phone after the person has been told what dropping it does (ST-MOB-011).
Widget buildDraftsScreen(BuildContext context, ScreenContext screen) => const DraftsScreen();

class DraftsScreen extends ConsumerStatefulWidget {
  const DraftsScreen({super.key});

  @override
  ConsumerState<DraftsScreen> createState() => _DraftsScreenState();
}

class _DraftsScreenState extends ConsumerState<DraftsScreen> {
  Future<void> _discard(ReportDrafts drafts, DraftSnapshot snapshot) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialog) => AlertDialog(
        title: Text(dialog.t('mob.rep.drafts.discard.title')),
        content: Text(snapshot.reportId == null ? dialog.t('mob.rep.drafts.discardLocal.body') : dialog.t('mob.rep.drafts.discardServer.body')),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.of(dialog).pop(false), child: Text(dialog.t('mob.rep.drafts.discardCancel.action'))),
          TextButton(onPressed: () => Navigator.of(dialog).pop(true), child: Text(dialog.t('mob.rep.drafts.discardConfirm.action'))),
        ],
      ),
    );
    if (confirmed ?? false) {
      drafts.discard(snapshot.id);
      if (mounted) setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final AsyncValue<ReportDrafts> opened = ref.watch(reportDraftsProvider);
    final List<QueuedCommand> commands = ref.watch(queuedCommandsProvider).value ?? const <QueuedCommand>[];
    final Reachability reachability = ref.watch(reachabilityProvider);
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    ScreenState state = ScreenState.defaultState;
    ProblemView? problem;
    List<DraftSnapshot> drafts = const <DraftSnapshot>[];
    if (opened.hasError) {
      problem = storeProblemOf(opened.error!, reachability);
      state = problem.state;
    } else if (!opened.hasValue) {
      state = ScreenState.loading;
    } else {
      drafts = opened.requireValue.all();
      if (drafts.isEmpty) state = ScreenState.empty;
    }
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.rep.drafts.title'))),
      floatingActionButton: state == ScreenState.signedOut || readOnly
          ? null
          : FloatingActionButton.extended(
              onPressed: () => openScreen(context, 'MOB-13', stacked: true),
              icon: const Icon(Icons.add),
              label: Text(context.t('mob.rep.drafts.new.action')),
            ),
      body: SafeArea(
        child: StateBoundary(
          state: state,
          problem: problem,
          onRetry: () => ref.invalidate(reportDraftsProvider),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(MachvonSpace.space16, MachvonSpace.space16, MachvonSpace.space16, 96),
            children: <Widget>[
              Text(context.t('mob.rep.drafts.summary.label', <String, Object>{'count': drafts.length}), style: Theme.of(context).textTheme.titleMedium),
              if (reachability == Reachability.offline) NoticeLine(icon: Icons.cloud_off_outlined, text: context.t('mob.rep.offline.notice.body')),
              if (readOnly) NoticeLine(icon: Icons.lock_outline, text: context.t('mob.rep.readOnly.notice.body')),
              const SizedBox(height: 8),
              for (final DraftSnapshot snapshot in drafts)
                _DraftTile(
                  key: ValueKey<String>(snapshot.id),
                  snapshot: snapshot,
                  status: submitStatusOf(commands, snapshot.id),
                  onDiscard: opened.hasValue ? () => _discard(opened.requireValue, snapshot) : null,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Where a draft stands, in the words of the person.
String _standing(BuildContext context, DraftSnapshot snapshot, SubmitStatus status) {
  switch (status.stage) {
    case SubmitStage.queued:
    case SubmitStage.sending:
      return context.t('mob.rep.drafts.stateQueued.label');
    case SubmitStage.unknown:
      return context.t('mob.rep.drafts.stateUnknown.label');
    case SubmitStage.rejected:
    case SubmitStage.conflict:
      return context.t('mob.rep.drafts.stateBlocked.label');
    case SubmitStage.submitted:
      return context.t('mob.rep.drafts.stateSubmitted.label');
    case SubmitStage.idle:
      switch (snapshot.draft.status) {
        case DraftStatus.synced:
          return context.t('mob.rep.drafts.stateSynced.label');
        case DraftStatus.blocked:
          return context.t('mob.rep.drafts.stateBlocked.label');
        case DraftStatus.queued:
          return context.t('mob.rep.drafts.stateQueued.label');
        case DraftStatus.editing:
          return context.t('mob.rep.drafts.stateEditing.label');
      }
  }
}

class _DraftTile extends StatelessWidget {
  const _DraftTile({required this.snapshot, required this.status, required this.onDiscard, super.key});

  final DraftSnapshot snapshot;
  final SubmitStatus status;
  final VoidCallback? onDiscard;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String project = snapshot.context?.projectCode ?? snapshot.form.projectId;
    final String period = snapshot.context?.periodCode ?? snapshot.form.periodId;
    final String standing = _standing(context, snapshot, status);
    final String saved = context.t('mob.rep.drafts.saved.label', <String, Object>{
      'time': formatMoment(DateTime.fromMillisecondsSinceEpoch(snapshot.draft.updatedAt, isUtc: true).toIso8601String()),
      'id': snapshot.shortId,
    });
    final String total = moneyLabel(context, sumTyped(<String>[for (final CellKey key in kCells) snapshot.form.cell(key).cumulative]));
    final bool pending = status.isPending;
    final String title = context.t('mob.rep.header.context.label', <String, Object>{'project': project, 'period': period});
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Semantics(
              container: true,
              label: <String>[title, snapshot.context?.projectName ?? '', standing, saved, total].where((String part) => part.isNotEmpty).join('. '),
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(title, style: theme.textTheme.titleMedium),
                  if ((snapshot.context?.projectName ?? '').isNotEmpty) Text(snapshot.context!.projectName),
                  const SizedBox(height: 4),
                  StatusPill(label: standing, warn: status.stage == SubmitStage.rejected || status.stage == SubmitStage.conflict || snapshot.draft.status == DraftStatus.blocked),
                  Text(saved, style: theme.textTheme.bodySmall),
                  Text(total, style: theme.textTheme.bodySmall),
                ],
              ),
            ),
            Wrap(
              spacing: 8,
              children: <Widget>[
                TextButton(
                  onPressed: () => pending ? openScreen(context, 'MOB-20', pathSuffix: '/${snapshot.id}', stacked: true) : openScreen(context, 'MOB-14', pathSuffix: '/${snapshot.id}', stacked: true),
                  child: Text(pending ? context.t('mob.rep.drafts.status.action') : context.t('mob.rep.drafts.open.action')),
                ),
                if (!pending)
                  TextButton(
                    onPressed: onDiscard,
                    child: Text(context.t('mob.rep.drafts.discard.action')),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
