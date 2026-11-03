import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show ProviderException;
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../data/report_drafts.dart';
import '../data/report_providers.dart';
import '../data/submit_flow.dart';
import '../labels.dart';
import '../model/report_form.dart';
import 'notices.dart';

/// The steps of a report in the order a person goes through them (DIS 3 F1; MOB-19 is the attachment list of `attachments`).
const List<String> kSteps = <String>['MOB-14', 'MOB-15', 'MOB-16', 'MOB-17', 'MOB-18', 'MOB-55', 'MOB-19', 'MOB-20'];

/// What a step screen is given: the draft as it stands, whether it can be changed, and how to change it.
final class DraftSession {
  const DraftSession({required this.snapshot, required this.editable, required this.status, required this.update});

  final DraftSnapshot snapshot;

  /// The draft can be changed: it is not waiting in the queue, not handed in, and the tenant lets the session change things.
  final bool editable;
  final SubmitStatus status;

  /// Changes the form and writes the draft on the device at once; the screen is rebuilt with the new draft.
  final void Function(ReportForm Function(ReportForm form) change) update;

  ReportForm get form => snapshot.form;
}

/// The frame of a step of the weekly report: the draft is opened from its id alone (so a restart finds it again), saved at every
/// change, and shown with where it stands (project, period, step, last saved, waiting in the queue, refused). The states are the
/// standard ones for what is on the device (loading, not found, no session, store failure); what the server says while the
/// reference figures are read (no connection, no right, licence expired) is told above the form, which stays, because a person in
/// the field must be able to go on with the draft they have.
class DraftHost extends ConsumerStatefulWidget {
  const DraftHost({required this.draftId, required this.screenId, required this.title, required this.body, this.step, this.tellsSending = false, super.key});

  final String draftId;
  final String screenId;
  final String title;

  /// The position in [kSteps] shown as `Bước n/8`; null for a screen outside the sequence.
  final int? step;

  /// The screen tells where the sending of the draft stands (waiting, unknown, refused) in its own words, so the frame does not.
  final bool tellsSending;
  final Widget Function(BuildContext context, DraftSession session) body;

  @override
  ConsumerState<DraftHost> createState() => _DraftHostState();
}

class _DraftHostState extends ConsumerState<DraftHost> {
  DraftSnapshot? _snapshot;
  ReportDrafts? _drafts;
  ReportProblem? _referenceProblem;
  bool _started = false;

  /// Whether this step was the one on top at the last build. A step stays alive under the one opened on it, and the draft changes
  /// there without any event it could hear (the other step writes the device store directly): it is read again when it comes back.
  bool _onTop = true;

  void _begin(ReportDrafts drafts) {
    if (identical(_drafts, drafts)) return;
    _drafts = drafts;
    _snapshot = drafts.read(widget.draftId);
    if (!_started && _snapshot != null) {
      _started = true;
      unawaited(_openReference(drafts));
    }
  }

  /// A report that exists on the server is read for its reference figures (the allocation, the period before); a draft made with
  /// no network is made on the server as soon as there is one. Neither stops the person: what failed is told above the form.
  Future<void> _openReference(ReportDrafts drafts) async {
    if (ref.read(reachabilityProvider) == Reachability.offline) return;
    ReportProblem? problem;
    try {
      final DraftSnapshot current = drafts.read(widget.draftId)!;
      if (current.reportId == null) {
        await drafts.ensureRecord(widget.draftId);
      } else {
        await drafts.refreshReference(widget.draftId);
      }
    } on DraftExists {
      problem = ReportProblem.draftExists;
    } on ApiError catch (error) {
      if (error.code != networkErrorCode) problem = problemOf(error);
    } on ContractMismatch {
      problem = ReportProblem.general;
    } on DraftDropped {
      problem = null;
    }
    if (!mounted) return;
    setState(() {
      _referenceProblem = problem;
      _snapshot = drafts.read(widget.draftId);
    });
  }

  void _update(ReportForm Function(ReportForm form) change) {
    final ReportDrafts? drafts = _drafts;
    // The change is applied to the draft as the device holds it now, never to the copy this step was opened with: the figures
    // typed at other steps meanwhile are in the draft and must stay in it.
    final DraftSnapshot? current = drafts?.read(widget.draftId);
    if (drafts == null || current == null) return;
    final ReportForm next = change(current.form);
    if (next == current.form) return;
    setState(() => _snapshot = drafts.writeForm(widget.draftId, next));
  }

  void _reload() {
    final ReportDrafts? drafts = _drafts;
    if (drafts == null || !mounted) return;
    setState(() => _snapshot = drafts.read(widget.draftId));
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AsyncValue<List<QueuedCommand>>>(queuedCommandsProvider, (AsyncValue<List<QueuedCommand>>? previous, AsyncValue<List<QueuedCommand>> next) => _reload());
    final AsyncValue<ReportDrafts> opened = ref.watch(reportDraftsProvider);
    final bool onTop = ModalRoute.isCurrentOf(context) ?? true;
    final Reachability reachability = ref.watch(reachabilityProvider);
    final SessionSnapshot session = ref.watch(sessionProvider);
    final List<QueuedCommand> commands = ref.watch(queuedCommandsProvider).value ?? const <QueuedCommand>[];
    ScreenState state = ScreenState.defaultState;
    ProblemView? problem;
    if (opened.hasError) {
      problem = storeProblemOf(opened.error!, reachability);
      state = problem.state;
    } else if (!opened.hasValue) {
      state = ScreenState.loading;
    } else {
      _begin(opened.requireValue);
      if (onTop && !_onTop) _snapshot = opened.requireValue.read(widget.draftId);
      if (_snapshot == null) state = ScreenState.empty;
    }
    _onTop = onTop;
    final DraftSnapshot? snapshot = _snapshot;
    final SubmitStatus status = submitStatusOf(commands, widget.draftId);
    final bool editable = snapshot != null && !status.isPending && status.stage != SubmitStage.submitted && !session.isReadOnly;
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: SafeArea(
        child: StateBoundary(
          state: state,
          problem: problem,
          onRetry: () => ref.invalidate(reportDraftsProvider),
          child: snapshot == null
              ? const SizedBox.shrink()
              : ListView(
                  padding: const EdgeInsets.all(MachvonSpace.space16),
                  children: <Widget>[
                    _Header(snapshot: snapshot, step: widget.step),
                    DraftNotices(
                      snapshot: snapshot,
                      status: status,
                      readOnlySession: session.isReadOnly,
                      offline: reachability == Reachability.offline,
                      referenceProblem: _referenceProblem,
                      tellsSending: widget.tellsSending,
                    ),
                    const SizedBox(height: MachvonSpace.space8),
                    widget.body(context, DraftSession(snapshot: snapshot, editable: editable, status: status, update: _update)),
                    const SizedBox(height: MachvonSpace.space16),
                    _Footer(screenId: widget.screenId, draftId: widget.draftId),
                  ],
                ),
        ),
      ),
    );
  }
}

/// The failure to open the store of the device, as the screen shows it. Nobody signed in is an ended session; anything else is mapped
/// like every other failure.
ProblemView storeProblemOf(Object error, Reachability reachability) {
  Object cause = error;
  while (cause is ProviderException) {
    cause = cause.exception;
  }
  if (cause is OfflineUnavailable) return const ProblemView(state: ScreenState.signedOut, code: 'SESSION_EXPIRED');
  return ProblemView.from(cause, reachability: reachability);
}

class _Header extends StatelessWidget {
  const _Header({required this.snapshot, required this.step});

  final DraftSnapshot snapshot;
  final int? step;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? line = snapshot.context == null
        ? null
        : context.t('mob.rep.header.context.label', <String, Object>{'project': snapshot.context!.projectCode, 'period': snapshot.context!.periodCode});
    final String saved = context.t('mob.rep.saved.label', <String, Object>{
      'time': formatMoment(DateTime.fromMillisecondsSinceEpoch(snapshot.draft.updatedAt, isUtc: true).toIso8601String()),
      'id': snapshot.shortId,
    });
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (line != null) Text(line, style: theme.textTheme.titleMedium),
        if (snapshot.context != null && snapshot.context!.projectName.isNotEmpty) Text(snapshot.context!.projectName, style: theme.textTheme.bodyMedium),
        if (step != null) Text(context.t('mob.rep.step.position.label', <String, Object>{'n': step!, 'total': kSteps.length}), style: theme.textTheme.bodySmall),
        Semantics(liveRegion: true, container: true, child: Text(saved, style: theme.textTheme.bodySmall)),
      ],
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({required this.screenId, required this.draftId});

  final String screenId;
  final String draftId;

  @override
  Widget build(BuildContext context) {
    final int index = kSteps.indexOf(screenId);
    final String? next = index >= 0 && index < kSteps.length - 1 ? kSteps[index + 1] : null;
    return Wrap(
      spacing: MachvonSpace.space8,
      runSpacing: MachvonSpace.space8,
      children: <Widget>[
        OutlinedButton(
          style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: () => context.canPop() ? context.pop() : openScreen(context, 'MOB-22'),
          child: Text(context.t('mob.rep.step.back.action')),
        ),
        if (next != null)
          FilledButton(
            style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
            onPressed: () => openStep(context, next, draftId),
            child: Text(context.t('mob.rep.step.next.action')),
          ),
      ],
    );
  }
}

/// Opens a step of a draft on top of the screen that opened it, so that back returns to where the person was.
void openStep(BuildContext context, String screenId, String draftId) {
  if (screenId == 'MOB-19') {
    openScreen(context, screenId, query: <String, String>{'owner': 'report', 'ref': draftId}, stacked: true);
  } else {
    openScreen(context, screenId, pathSuffix: '/$draftId', stacked: true);
  }
}
