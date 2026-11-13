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
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/tap_target.dart';
import '../../../core/widgets/work_row.dart';
import '../../read_support/navigate.dart';
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
    final bool confirmed = await showConfirmSheet(
      context,
      title: context.t('mob.rep.drafts.discard.title'),
      facts: <String>[snapshot.reportId == null ? context.t('mob.rep.drafts.discardLocal.body') : context.t('mob.rep.drafts.discardServer.body')],
      confirmLabel: context.t('mob.rep.drafts.discardConfirm.action'),
      cancelLabel: context.t('mob.rep.drafts.discardCancel.action'),
      destructive: true,
    );
    if (confirmed) {
      drafts.discard(snapshot.id);
      if (mounted) setState(() {});
    }
  }

  void _start() => openScreen(context, 'MOB-13', stacked: true);

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
    }
    final bool canStart = state != ScreenState.signedOut && !readOnly;
    final bool listed = state == ScreenState.defaultState && drafts.isNotEmpty;
    return AppScaffold(
      title: context.t('mob.rep.drafts.title'),
      contextLine: DraftBanners(offline: reachability == Reachability.offline, readOnlySession: readOnly),
      bottomBar: listed && canStart ? ActionBar(primary: ActionBarButton(label: context.t('mob.rep.drafts.new.action'), icon: Icons.add, onPressed: _start)) : null,
      body: StateBoundary(
        state: state,
        problem: problem,
        onRetry: () => ref.invalidate(reportDraftsProvider),
        child: state != ScreenState.defaultState
            ? const SizedBox.shrink()
            : drafts.isEmpty
                ? DraftsEmpty(canStart: canStart, onStart: _start)
                : DraftsList(
                    entries: <DraftEntry>[
                      for (final DraftSnapshot snapshot in drafts) _entryOf(context, snapshot, submitStatusOf(commands, snapshot.id), opened.requireValue),
                    ],
                  ),
      ),
    );
  }

  DraftEntry _entryOf(BuildContext context, DraftSnapshot snapshot, SubmitStatus status, ReportDrafts drafts) {
    final String project = snapshot.context?.projectCode ?? snapshot.form.projectId;
    final String period = snapshot.context?.periodCode ?? snapshot.form.periodId;
    final bool pending = status.isPending;
    return DraftEntry(
      id: snapshot.id,
      title: context.t('mob.rep.header.context.label', <String, Object>{'project': project, 'period': period}),
      projectName: snapshot.context?.projectName ?? '',
      standing: _standing(context, snapshot, status),
      tone: _toneOf(snapshot, status),
      saved: context.t('mob.rep.drafts.saved.label', <String, Object>{
        'time': formatMoment(DateTime.fromMillisecondsSinceEpoch(snapshot.draft.updatedAt, isUtc: true).toIso8601String()),
        'id': snapshot.shortId,
      }),
      total: moneyLabel(context, sumTyped(<String>[for (final CellKey key in kCells) snapshot.form.cell(key).cumulative])),
      pending: pending,
      onOpen: () => pending ? openScreen(context, 'MOB-20', pathSuffix: '/${snapshot.id}', stacked: true) : openScreen(context, 'MOB-14', pathSuffix: '/${snapshot.id}', stacked: true),
      onDiscard: pending ? null : () => _discard(drafts, snapshot),
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

/// The tone of the state pill: what needs the person is red, what waits for the network or the answer is blue or amber, what is done is green.
MachvonTone _toneOf(DraftSnapshot snapshot, SubmitStatus status) {
  switch (status.stage) {
    case SubmitStage.queued:
    case SubmitStage.sending:
      return MachvonTone.info;
    case SubmitStage.unknown:
      return MachvonTone.warning;
    case SubmitStage.rejected:
    case SubmitStage.conflict:
      return MachvonTone.danger;
    case SubmitStage.submitted:
      return MachvonTone.success;
    case SubmitStage.idle:
      switch (snapshot.draft.status) {
        case DraftStatus.synced:
          return MachvonTone.success;
        case DraftStatus.blocked:
          return MachvonTone.danger;
        case DraftStatus.queued:
          return MachvonTone.info;
        case DraftStatus.editing:
          return MachvonTone.neutral;
      }
  }
}

/// What a row of the list of drafts shows and does; the screen makes it from the draft and the queue, a test makes it by hand.
final class DraftEntry {
  const DraftEntry({
    required this.id,
    required this.title,
    required this.projectName,
    required this.standing,
    required this.tone,
    required this.saved,
    required this.total,
    required this.pending,
    required this.onOpen,
    this.onDiscard,
  });

  final String id;
  final String title;
  final String projectName;
  final String standing;
  final MachvonTone tone;
  final String saved;
  final String total;

  /// The draft waits in the queue: it opens at its sending, and it cannot be dropped.
  final bool pending;
  final VoidCallback onOpen;
  final VoidCallback? onDiscard;
}

/// The drafts as rows with hairlines: the project and the period with the state of the draft at the end, when it was saved and the total under
/// them, then the two things to do (open it, drop it) as 48 high links. The whole row opens the draft.
class DraftsList extends StatelessWidget {
  const DraftsList({required this.entries, super.key});

  final List<DraftEntry> entries;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
      children: <Widget>[
        GroupHeader(title: context.t('mob.rep.drafts.summary.label', <String, Object>{'count': entries.length})),
        for (int index = 0; index < entries.length; index += 1) _DraftRow(key: ValueKey<String>(entries[index].id), entry: entries[index], dividerAbove: index > 0),
      ],
    );
  }
}

class _DraftRow extends StatelessWidget {
  const _DraftRow({required this.entry, required this.dividerAbove, super.key});

  final DraftEntry entry;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String spoken = <String>[entry.title, entry.projectName, entry.standing, entry.saved, entry.total].where((String part) => part.isNotEmpty).join('. ');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        WorkRow(
          title: entry.title,
          subtitle: entry.projectName.isEmpty ? null : entry.projectName,
          trailing: Align(alignment: Alignment.topRight, child: StatusPill(label: entry.standing, tone: entry.tone)),
          dividerAbove: dividerAbove,
          semanticLabel: spoken,
          onTap: entry.onOpen,
        ),
        Padding(
          padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(entry.saved, style: text.caption.copyWith(color: v2.palette.ink2)),
              Text(entry.total, style: text.caption.copyWith(color: v2.palette.ink2)),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s4),
          child: Wrap(
            children: <Widget>[
              _Link(label: entry.pending ? context.t('mob.rep.drafts.status.action') : context.t('mob.rep.drafts.open.action'), color: v2.palette.primaryStrong, onTap: entry.onOpen),
              if (!entry.pending) _Link(label: context.t('mob.rep.drafts.discard.action'), color: v2.palette.lateFg, onTap: entry.onDiscard),
            ],
          ),
        ),
      ],
    );
  }
}

class _Link extends StatelessWidget {
  const _Link({required this.label, required this.color, required this.onTap});

  final String label;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => TapTarget(
        onTap: onTap,
        semanticLabel: label,
        minHeight: MachvonV2Size.actionButton,
        alignment: Alignment.center,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s12),
          child: Text(label, style: context.v2text.label.copyWith(color: onTap == null ? context.v2.palette.ink3 : color)),
        ),
      );
}

/// No draft on the phone: what a draft is, and the one thing that fixes the emptiness, starting a report. A tenant that is read only cannot start
/// one, so it is told why instead of being offered a button.
class DraftsEmpty extends StatelessWidget {
  const DraftsEmpty({required this.canStart, required this.onStart, super.key});

  final bool canStart;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) => StateView(
        kind: StateKind.empty,
        title: context.t('mob.rep.drafts.empty.title'),
        body: canStart ? context.t('mob.rep.drafts.empty.body') : context.t('mob.rep.readOnly.notice.body'),
        actionLabel: canStart ? context.t('mob.rep.drafts.start.action') : null,
        onAction: canStart ? onStart : null,
      );
}
