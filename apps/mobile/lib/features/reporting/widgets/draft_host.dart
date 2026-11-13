import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show ProviderException;
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
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
  const DraftSession({required this.snapshot, required this.editable, required this.status, required this.update, this.referenceProblem, this.scrollingContext});

  final DraftSnapshot snapshot;

  /// The draft can be changed: it is not waiting in the queue, not handed in, and the tenant lets the session change things.
  final bool editable;
  final SubmitStatus status;

  /// Changes the form and writes the draft on the device at once; the screen is rebuilt with the new draft.
  final void Function(ReportForm Function(ReportForm form) change) update;

  /// What the server said while the reference figures were read, or null; a screen that owns its bar shows it with [DraftNotices].
  final ReportProblem? referenceProblem;

  /// The context of the draft when the text is large: it then scrolls with the content instead of taking the top of the screen. A screen that owns
  /// its bar puts it first in its list.
  final Widget? scrollingContext;

  ReportForm get form => snapshot.form;
}

/// The frame of a step of the weekly report: the draft is opened from its id alone (so a restart finds it again), saved at every
/// change, and shown with where it stands (project, period, step, last saved, waiting in the queue, refused). The states are the
/// standard ones for what is on the device (loading, not found, no session, store failure); what the server says while the
/// reference figures are read (no connection, no right, licence expired) is told above the form, which stays, because a person in
/// the field must be able to go on with the draft they have.
///
/// The frame is an [AppScaffold]: the title of the step, a compact context line (project, period, `Step n/8`, last saved), one strip for
/// the connection and a sticky bar at the foot (Back quiet, Next primary), so the way on is always under the thumb. A step that sends something
/// (MOB-20, MOB-56) owns its bar ([ownBar]) and its body then fills the area and scrolls itself.
class DraftHost extends ConsumerStatefulWidget {
  const DraftHost({required this.draftId, required this.screenId, required this.title, required this.body, this.step, this.tellsSending = false, this.ownBar = false, super.key});

  final String draftId;
  final String screenId;
  final String title;

  /// The position in [kSteps] shown as `Step n/8`; null for a screen outside the sequence.
  final int? step;

  /// The screen tells where the sending of the draft stands (waiting, unknown, refused) in its own words, so the frame does not.
  final bool tellsSending;

  /// The body owns the sticky bar at the foot and scrolls itself: the frame draws neither the Back/Next bar nor the notices, nor the list.
  final bool ownBar;
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

  /// The context of the draft as the frame shows it: the project and the period, the name of the project, the step and when it was saved.
  Widget _contextOf(BuildContext context, DraftSnapshot snapshot) {
    final int? step = widget.step;
    return DraftContext(
      line: snapshot.context == null
          ? null
          : context.t('mob.rep.header.context.label', <String, Object>{'project': snapshot.context!.projectCode, 'period': snapshot.context!.periodCode}),
      name: snapshot.context?.projectName,
      step: step == null ? null : context.t('mob.rep.step.position.label', <String, Object>{'n': step, 'total': kSteps.length}),
      saved: context.t('mob.rep.saved.label', <String, Object>{
        'time': formatMoment(DateTime.fromMillisecondsSinceEpoch(snapshot.draft.updatedAt, isUtc: true).toIso8601String()),
        'id': snapshot.shortId,
      }),
    );
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
    final bool offline = reachability == Reachability.offline;
    // At a large text scale the context would take the screen, so it scrolls with the content.
    final bool large = largeText(context);
    final Widget? draftContext = snapshot == null ? null : _contextOf(context, snapshot);
    final Widget? content = snapshot == null
        ? null
        : widget.body(context, DraftSession(snapshot: snapshot, editable: editable, status: status, update: _update, referenceProblem: _referenceProblem, scrollingContext: large ? draftContext : null));
    return AppScaffold(
      title: widget.title,
      contextLine: snapshot == null
          ? null
          : Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (!large) draftContext!,
                DraftBanners(offline: offline, readOnlySession: session.isReadOnly),
              ],
            ),
      bottomBar: snapshot == null || widget.ownBar ? null : _StepBar(screenId: widget.screenId, draftId: widget.draftId),
      body: StateBoundary(
        state: state,
        problem: problem,
        onRetry: () => ref.invalidate(reportDraftsProvider),
        child: content == null
            ? const SizedBox.shrink()
            : widget.ownBar
                ? content
                : ListView(
                    keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                    padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
                    children: <Widget>[
                      ?(large ? draftContext : null),
                      DraftNotices(snapshot: snapshot!, status: status, referenceProblem: _referenceProblem, tellsSending: widget.tellsSending),
                      content,
                    ],
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

/// Where the draft stands, in a few lines under the title: the project and the period with the step it is at, the name of the project, and the time it
/// was last saved on the phone (a live region, so a screen reader says it when it changes). It takes the words it shows, so a test can hold it with no
/// draft behind it, and it wraps at a large text scale instead of being cut.
class DraftContext extends StatelessWidget {
  const DraftContext({required this.saved, this.line, this.name, this.step, super.key});

  /// `Project DA-1 · Period W45`.
  final String? line;
  final String? name;

  /// `Step 2/8`.
  final String? step;
  final String saved;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final bool large = largeText(context);
    final TextOverflow overflow = large ? TextOverflow.visible : TextOverflow.ellipsis;
    final int? lines = large ? null : 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  if (line != null) Expanded(child: Text(line!, style: text.label, maxLines: lines, overflow: overflow)) else const Spacer(),
                  if (step != null) ...<Widget>[
                    const SizedBox(width: MachvonV2Space.s8),
                    Text(step!, style: text.captionStrong.copyWith(color: v2.palette.primaryStrong)),
                  ],
                ],
              ),
              if (name != null && name!.isNotEmpty) Text(name!, style: text.caption.copyWith(color: v2.palette.ink2), maxLines: lines, overflow: overflow),
              Semantics(liveRegion: true, container: true, child: Text(saved, style: text.caption.copyWith(color: v2.palette.ink2), maxLines: lines, overflow: overflow)),
            ],
          ),
        ),
        Divider(height: 1, thickness: 1, color: v2.palette.line),
      ],
    );
  }
}

/// The sticky bar of a step: Back (quiet) and Next (primary). The last step of the sequence and a step outside it have Back only.
class _StepBar extends StatelessWidget {
  const _StepBar({required this.screenId, required this.draftId});

  final String screenId;
  final String draftId;

  @override
  Widget build(BuildContext context) {
    final int index = kSteps.indexOf(screenId);
    final String? next = index >= 0 && index < kSteps.length - 1 ? kSteps[index + 1] : null;
    final ActionBarButton back = ActionBarButton(label: context.t('mob.rep.step.back.action'), onPressed: () => context.canPop() ? context.pop() : openScreen(context, 'MOB-22'));
    if (next == null) return ActionBar(primary: back);
    return ActionBar(
      primary: ActionBarButton(label: context.t('mob.rep.step.next.action'), onPressed: () => openStep(context, next, draftId)),
      secondary: back,
    );
  }
}

/// Opens a step of a draft on top of the screen that opened it, so that back returns to where the person was.
///
/// [from] names the screen that opens the attachment list, so that its way on returns there instead of opening that screen a second time.
void openStep(BuildContext context, String screenId, String draftId, {String? from}) {
  if (screenId == 'MOB-19') {
    openScreen(context, screenId, query: <String, String>{'owner': 'report', 'ref': draftId, 'from': ?from}, stacked: true);
  } else {
    openScreen(context, screenId, pathSuffix: '/$draftId', stacked: true);
  }
}
