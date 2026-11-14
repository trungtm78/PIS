import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/timeline.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/command_outcome.dart';
import '../../read_support/clock.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../pwf_codes.dart';
import '../pwf_commands.dart';
import '../pwf_models.dart';
import '../pwf_process_widgets.dart';
import '../pwf_tabs.dart';
import '../pwf_task_service.dart';
import '../pwf_task_sheets.dart';
import '../pwf_widgets.dart';

/// MOB-79: one task of a project's workflow. Its facts and its official deadline, what is still needed before it can be completed (the checklist, the
/// legal documents and the forms, the evidence given), and what the person can do now: start it, give evidence, tick an item, complete it, ask for more
/// time or a pause. What the person does is queued on the device and sent when there is a connection, on the version of the task they saw; when
/// the task changed meanwhile, the screen says so, shows the task as it is and lets them send their work again on it or drop it (never written over).
/// An approval and a return are decisions of another person and are made online only.
Widget buildTaskDetailScreen(BuildContext context, ScreenContext screen) => PwfTaskDetailScreen(taskId: screen.pathParameters['taskId'] ?? '');

class PwfTaskDetailScreen extends ConsumerStatefulWidget {
  const PwfTaskDetailScreen({required this.taskId, super.key});

  final String taskId;

  @override
  ConsumerState<PwfTaskDetailScreen> createState() => _PwfTaskDetailScreenState();
}

/// How the last action of the person ended, in words, above the task.
final class _Notice {
  const _Notice(this.text, {this.code, this.problem = false});

  final String text;
  final String? code;
  final bool problem;
}

class _PwfTaskDetailScreenState extends ConsumerState<PwfTaskDetailScreen> {
  int _reload = 0;
  _Notice? _notice;
  bool _busy = false;

  String get _taskId => widget.taskId;

  Future<Object?> _read(MachvonApiClient client) => client.getProjectTask(taskId: _taskId);

  void _say(_Notice notice) {
    if (mounted) setState(() => _notice = notice);
  }

  void _reloadNow() {
    if (mounted) setState(() => _reload += 1);
  }

  /// Queues one action of the person. A second tap on the same sheet is the same intention (the same key), so it is one command.
  Future<void> _queue(Future<QueuedCommand> Function(PwfTaskService service, String intention) make) async {
    if (_busy) return;
    setState(() => _busy = true);
    _Notice? notice;
    try {
      await make(ref.read(pwfTaskServiceProvider), newUuidV4());
      if (!mounted) return;
      notice = _Notice(context.t('mob.pwf.notice.queued'));
    } on PwfEarlierCommandUnresolved {
      if (!mounted) return;
      notice = _Notice(context.t('mob.pwf.notice.earlier'), problem: true);
    } on Object catch (error) {
      if (!mounted) return;
      notice = _Notice(context.t('mob.pwf.notice.failed'), code: error is ApiError ? error.code : null, problem: true);
    }
    setState(() {
      _busy = false;
      _notice = notice;
    });
  }

  /// Sends one decision online. Offline there is nothing to send: it says so and nothing is queued.
  Future<void> _decide(Future<CommandOutcome> Function(PwfDecisionCommands commands) send, {required String done}) async {
    if (_busy) return;
    setState(() => _busy = true);
    final CommandOutcome outcome = await send(ref.read(pwfDecisionCommandsProvider));
    if (!mounted) return;
    setState(() => _busy = false);
    switch (outcome) {
      case CommandDone():
        _say(_Notice(done));
        _reloadNow();
      case CommandOffline():
        _say(_Notice(context.t('mob.pwf.notice.needsNetwork'), problem: true));
      case CommandUnknown():
        _say(_Notice(context.t('mob.pwf.notice.unknown'), problem: true));
      case CommandRefused(:final String code):
        _say(_Notice(_refusalText(context, code), code: code, problem: true));
        if (code == 'VERSION_CONFLICT') _reloadNow();
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AsyncValue<PwfTaskQueueView>>(pwfTaskQueueProvider(_taskId), (AsyncValue<PwfTaskQueueView>? previous, AsyncValue<PwfTaskQueueView> next) {
      final PwfTaskQueueView? before = previous?.value;
      final PwfTaskQueueView? after = next.value;
      if (before == null || after == null) return;
      // A command that left the queue was taken by the server (or dropped), and one that came back in conflict means the task moved: either way the task is read again.
      final bool left = before.commands.any((QueuedCommand c) => !after.commands.any((QueuedCommand a) => a.id == c.id));
      if (left || after.conflicts.length > before.conflicts.length) _reloadNow();
    });
    final PwfTaskQueueView queue = ref.watch(pwfTaskQueueProvider(_taskId)).value ?? const PwfTaskQueueView.empty();
    final bool online = ref.watch(reachabilityProvider) != Reachability.offline;
    return AppScaffold(
      title: context.t('mob.pwf.task.title'),
      body: DataView<PwfTaskDetail>(
        cacheKey: 'pwf.task.$_taskId',
        read: _read,
        parse: parsePwfTaskDetail,
        asOf: (PwfTaskDetail detail) => detail.asOf,
        reloadKey: _reload,
        builder: (BuildContext context, Loaded<PwfTaskDetail> loaded) => _TaskBody(
          detail: loaded.value,
          fresh: !loaded.fromCache,
          queue: queue,
          notice: _notice,
          busy: _busy,
          online: online,
          onStart: _start,
          onComplete: _complete,
          onItem: _item,
          onEvidence: _evidence,
          onException: _exception,
          onApprove: _approve,
          onReturn: _return,
          onResume: _resume,
          onResend: _resend,
          onDrop: _drop,
          onFiles: _files,
        ),
      ),
    );
  }

  // ---- What the person does ------------------------------------------------------------------------------------------------------

  Future<void> _start(PwfTaskDetail task) async {
    final String? note = await showPwfNoteSheet(
      context,
      title: context.t('mob.pwf.start.title'),
      facts: <String>[context.t('mob.pwf.start.fact')],
      confirmLabel: context.t('mob.pwf.start.confirm'),
      noteLabel: context.t('mob.pwf.sheet.note.label'),
    );
    if (note == null || !mounted) return;
    await _queue((PwfTaskService service, String intention) => service.start(task, intention: intention, note: note));
  }

  Future<void> _complete(PwfTaskDetail task) async {
    final String? note = await showPwfNoteSheet(
      context,
      title: context.t('mob.pwf.complete.title'),
      facts: <String>[
        task.approverRole == null ? context.t('mob.pwf.complete.fact.done') : context.t('mob.pwf.complete.fact.approval', <String, Object>{'role': pwfRoleName(context, task.approverRole!)}),
        context.t('mob.pwf.complete.fact.check'),
      ],
      confirmLabel: context.t('mob.pwf.complete.confirm'),
      noteLabel: context.t('mob.pwf.sheet.note.label'),
    );
    if (note == null || !mounted) return;
    await _queue((PwfTaskService service, String intention) => service.complete(task, intention: intention, note: note));
  }

  Future<void> _item(PwfTaskDetail task, PwfChecklistItem item) async {
    final String? choice = await showActionSheet<String>(
      context,
      title: item.name,
      builder: (BuildContext sheet) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          WorkRow(title: context.t('mob.pwf.item.evidence'), subtitle: item.evidenceKinds.isEmpty ? null : context.t('mob.pwf.item.kinds', <String, Object>{'kinds': item.evidenceKinds.map((String kind) => pwfEvidenceKindName(context, kind)).join(', ')}), leading: const Icon(Icons.attach_file), onTap: () => Navigator.pop(sheet, 'evidence')),
          WorkRow(title: context.t('mob.pwf.item.done'), leading: const Icon(Icons.check_circle_outline), onTap: () => Navigator.pop(sheet, 'done'), dividerAbove: true),
        ],
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'evidence') return _evidence(task, itemCode: item.code);
    final String? note = await showPwfNoteSheet(
      context,
      title: context.t('mob.pwf.item.done.title'),
      facts: <String>[item.name, if (item.evidenceKinds.isNotEmpty) context.t('mob.pwf.item.needsEvidence', <String, Object>{'kinds': item.evidenceKinds.map((String kind) => pwfEvidenceKindName(context, kind)).join(', ')})],
      confirmLabel: context.t('mob.pwf.item.done.confirm'),
      noteLabel: context.t('mob.pwf.sheet.note.label'),
    );
    if (note == null || !mounted) return;
    await _queue((PwfTaskService service, String intention) => service.completeChecklistItem(task, item.code, intention: intention, note: note));
  }

  Future<void> _evidence(PwfTaskDetail task, {String? itemCode}) async {
    final PwfEvidenceForm? form = await showPwfEvidenceSheet(context, task, itemCode: itemCode);
    if (form == null || !mounted) return;
    await _queue(
      (PwfTaskService service, String intention) => service.attachEvidence(
        task,
        intention: intention,
        evidenceKind: form.kind,
        itemCode: form.itemCode,
        legalDocType: form.legalDocType,
        formTemplateCode: form.formTemplateCode,
        externalRef: form.externalRef,
        note: form.note,
      ),
    );
  }

  Future<void> _exception(PwfTaskDetail task) async {
    final String today = vietnamDayOf(ref.read(clockProvider)());
    final PwfExceptionForm? form = await showPwfExceptionSheet(context, task, today: today);
    if (form == null || !mounted) return;
    await _queue((PwfTaskService service, String intention) => service.requestException(task, intention: intention, kind: form.kind, reason: form.reason, validFrom: form.validFrom, validTo: form.validTo));
  }

  Future<void> _approve(PwfTaskDetail task) async {
    final String? note = await showPwfNoteSheet(
      context,
      title: context.t('mob.pwf.approve.title'),
      facts: <String>[context.t('mob.pwf.approve.fact.done'), context.t('mob.pwf.approve.fact.audit')],
      confirmLabel: context.t('mob.pwf.approve.confirm'),
      noteLabel: context.t('mob.pwf.sheet.note.label'),
    );
    if (note == null || !mounted) return;
    await _decide((PwfDecisionCommands commands) => commands.approve(task.id, task.version, note: note), done: context.t('mob.pwf.notice.approved'));
  }

  Future<void> _return(PwfTaskDetail task) async {
    final String? reason = await showPwfNoteSheet(
      context,
      title: context.t('mob.pwf.return.title'),
      facts: <String>[context.t('mob.pwf.return.fact')],
      confirmLabel: context.t('mob.pwf.return.confirm'),
      noteLabel: context.t('mob.pwf.return.reason'),
      noteRequired: true,
      minLength: kPwfMinReasonLength,
      destructive: true,
    );
    if (reason == null || !mounted) return;
    await _decide((PwfDecisionCommands commands) => commands.returnTask(task.id, task.version, reason), done: context.t('mob.pwf.notice.returned'));
  }

  Future<void> _resume(PwfTaskDetail task) async {
    final bool yes = await showConfirmSheet(
      context,
      title: context.t('mob.pwf.resume.title'),
      facts: <String>[context.t('mob.pwf.resume.fact')],
      confirmLabel: context.t('mob.pwf.resume.confirm'),
      cancelLabel: context.t('mob.pwf.sheet.cancel'),
    );
    if (!yes || !mounted) return;
    await _decide((PwfDecisionCommands commands) => commands.resume(task.id, task.version), done: context.t('mob.pwf.notice.resumed'));
  }

  Future<void> _resend(PwfTaskDetail task) async {
    final int sent = await ref.read(pwfTaskServiceProvider).resendConflicts(task.id, task.version);
    if (!mounted) return;
    _say(_Notice(context.t('mob.pwf.notice.resent', <String, Object>{'count': sent})));
  }

  Future<void> _drop(PwfTaskDetail task) async {
    final bool yes = await showConfirmSheet(
      context,
      title: context.t('mob.pwf.drop.title'),
      facts: <String>[context.t('mob.pwf.drop.fact')],
      confirmLabel: context.t('mob.pwf.drop.confirm'),
      cancelLabel: context.t('mob.pwf.sheet.cancel'),
      destructive: true,
    );
    if (!yes || !mounted) return;
    final int dropped = await ref.read(pwfTaskServiceProvider).dropUnsent(task.id);
    if (!mounted) return;
    _say(_Notice(context.t('mob.pwf.notice.dropped', <String, Object>{'count': dropped})));
  }

  void _files() {
    if (!mounted) return;
    context.push(locationOfScreen(context, 'MOB-19', query: <String, String>{'owner': 'pwf_task', 'ref': _taskId}));
  }
}

/// What a refusal of the server means to the person.
String _refusalText(BuildContext context, String code) => switch (code) {
      'VERSION_CONFLICT' => context.t('mob.pwf.refusal.versionConflict'),
      'SELF_APPROVAL_DENIED' || 'MAKER_IS_APPROVER' => context.t('mob.pwf.refusal.maker'),
      'PWF_TASK_STATE_INVALID' => context.t('mob.pwf.refusal.state'),
      'PWF_TASK_COMPLETION_BLOCKED' => context.t('mob.pwf.refusal.blocked'),
      'SCOPE_DENIED' => context.t('mob.pwf.refusal.scope'),
      _ => context.t('mob.pwf.refusal.other'),
    };

class _TaskBody extends StatelessWidget {
  const _TaskBody({
    required this.detail,
    required this.fresh,
    required this.queue,
    required this.notice,
    required this.busy,
    required this.online,
    required this.onStart,
    required this.onComplete,
    required this.onItem,
    required this.onEvidence,
    required this.onException,
    required this.onApprove,
    required this.onReturn,
    required this.onResume,
    required this.onResend,
    required this.onDrop,
    required this.onFiles,
  });

  final PwfTaskDetail detail;

  /// The task was just read from the server (not a copy kept on the device): only then can the person send their work again on it.
  final bool fresh;
  final PwfTaskQueueView queue;
  final _Notice? notice;
  final bool busy;
  final bool online;
  final Future<void> Function(PwfTaskDetail) onStart;
  final Future<void> Function(PwfTaskDetail) onComplete;
  final Future<void> Function(PwfTaskDetail, PwfChecklistItem) onItem;
  final Future<void> Function(PwfTaskDetail) onEvidence;
  final Future<void> Function(PwfTaskDetail) onException;
  final Future<void> Function(PwfTaskDetail) onApprove;
  final Future<void> Function(PwfTaskDetail) onReturn;
  final Future<void> Function(PwfTaskDetail) onResume;
  final Future<void> Function(PwfTaskDetail) onResend;
  final Future<void> Function(PwfTaskDetail) onDrop;
  final VoidCallback onFiles;

  /// The person has started the task on the device and the server does not know yet: what follows (evidence, items, completion) is queued behind it.
  bool get _startPending => queue.has(kPwfStartCommand);

  bool get _canWork => (detail.canComplete || (_startPending && detail.status == PwfTaskStatus.notStarted)) && !detail.status.isFinal;

  /// Another command of the person on this task is on its way and the device is online: a new one waits for it (offline, the commands chain behind each other).
  bool get _waitingForOwnCommand => online && queue.inFlight.isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final String language = AppStrings.of(context).language;
    final MachvonV2Text text = context.v2text;
    final bool problem = queue.hasProblem;
    final bool locked = busy || _waitingForOwnCommand || problem;
    final ActionBar? bar = _bar(context, locked, problem);
    // One purpose a tab (the long list of facts is no longer one page): what there is to do, the facts of the task, its legal grounds, and what happened to it.
    final List<Widget> todo = <Widget>[
      if (detail.blockers.isNotEmpty && !detail.status.isFinal) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf.blockers.title'), count: detail.blockers.length),
        for (int index = 0; index < detail.blockers.length; index += 1) _blocker(context, detail.blockers[index], index > 0),
      ],
      if (detail.checklist.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf.checklist.title'), count: detail.checklist.length),
        for (int index = 0; index < detail.checklist.length; index += 1) _checklist(context, detail.checklist[index], index > 0),
      ],
      if (detail.legalDocTypes.isNotEmpty || detail.formTemplates.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf.requirements.title'), count: detail.legalDocTypes.length + detail.formTemplates.length),
        for (int index = 0; index < detail.legalDocTypes.length; index += 1) _requirement(context, detail.legalDocTypes[index], context.t('mob.pwf.requirements.legal'), index > 0),
        for (int index = 0; index < detail.formTemplates.length; index += 1) _requirement(context, detail.formTemplates[index], context.t('mob.pwf.requirements.form'), true),
      ],
      if (detail.formRevisions.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf.process.forms.title'), count: detail.formRevisions.length),
        for (int index = 0; index < detail.formRevisions.length; index += 1) PwfFormRevisionRow(form: detail.formRevisions[index], dividerAbove: index > 0),
      ],
      GroupHeader(title: context.t('mob.pwf.evidence.section'), count: detail.evidence.length),
      if (detail.evidence.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf.evidence.none'), style: text.body)),
      for (int index = 0; index < detail.evidence.length; index += 1) _evidenceRow(context, detail.evidence[index], index > 0, language),
      if (_canWork) WorkRow(title: context.t('mob.pwf.evidence.add'), leading: const Icon(Icons.add_circle_outline), onTap: locked ? null : () => onEvidence(detail), dividerAbove: detail.evidence.isNotEmpty),
      WorkRow(title: context.t('mob.pwf.evidence.files.open'), subtitle: context.t('mob.pwf.evidence.files.hint'), leading: const Icon(Icons.attach_file), trailing: const Icon(Icons.chevron_right), onTap: onFiles, dividerAbove: true),
    ];
    final List<Widget> facts = <Widget>[
      if (detail.responsibleRole != null) InfoRow(label: context.t('mob.pwf.fact.role'), value: pwfRoleName(context, detail.responsibleRole!)),
      if (detail.approverRole != null) InfoRow(label: context.t('mob.pwf.fact.approver'), value: pwfRoleName(context, detail.approverRole!)),
      if (detail.plannedStart != null) InfoRow(label: context.t('mob.pwf.fact.plannedStart'), value: formatDay(detail.plannedStart!, language: language)),
      if (detail.plannedFinish != null) InfoRow(label: context.t('mob.pwf.fact.plannedFinish'), value: formatDay(detail.plannedFinish!, language: language)),
      if (detail.baselineFinish != null) InfoRow(label: context.t('mob.pwf.fact.baselineFinish'), value: formatDay(detail.baselineFinish!, language: language)),
      if (detail.finishVarianceDays != null && detail.finishVarianceDays != 0) InfoRow(label: context.t('mob.pwf.fact.variance'), value: context.t('mob.pwf.fact.variance.days', <String, Object>{'days': detail.finishVarianceDays!})),
      if (detail.actualStart != null) InfoRow(label: context.t('mob.pwf.fact.actualStart'), value: formatDay(detail.actualStart!, language: language)),
      if (detail.actualFinish != null) InfoRow(label: context.t('mob.pwf.fact.actualFinish'), value: formatDay(detail.actualFinish!, language: language)),
      if (detail.critical) InfoRow(label: context.t('mob.pwf.fact.critical'), value: context.t('mob.pwf.fact.critical.value')),
      if (detail.returnCount > 0) InfoRow(label: context.t('mob.pwf.fact.returns'), value: '${detail.returnCount}'),
      if (detail.step != null) InfoRow(label: context.t('mob.pwf.process.fact.step'), value: context.t('mob.pwf.process.fact.stepValue', <String, Object>{'order': detail.step!.order, 'name': detail.step!.name})),
      if (detail.step?.responsibleRole != null) InfoRow(label: context.t('mob.pwf.process.fact.stepRole'), value: pwfRoleName(context, detail.step!.responsibleRole!)),
    ];
    final List<Widget> grounds = <Widget>[
      // PWF-4: the legal grounds of the task and of its step (read only), and the revision of each form with a warning when the form was revised since.
      if (detail.legalBasis.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf.process.legal.task'), count: detail.legalBasis.length),
        for (int index = 0; index < detail.legalBasis.length; index += 1) PwfLegalBasisRow(basis: detail.legalBasis[index], dividerAbove: index > 0),
      ],
      if (detail.stepLegalBasis.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf.process.legal.step'), count: detail.stepLegalBasis.length),
        for (int index = 0; index < detail.stepLegalBasis.length; index += 1) PwfLegalBasisRow(basis: detail.stepLegalBasis[index], dividerAbove: index > 0),
      ],
      if (detail.legalBasis.isEmpty && detail.stepLegalBasis.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf6.tab.legal.none'), style: text.body)),
    ];
    final List<Widget> log = <Widget>[
      if (detail.exceptions.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf.exceptions.title'), count: detail.exceptions.length),
        for (int index = 0; index < detail.exceptions.length; index += 1) _exceptionRow(context, detail.exceptions[index], index > 0, language),
      ],
      if (detail.history.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf.history.title'), count: detail.history.length),
        Padding(
          padding: const EdgeInsets.all(MachvonV2Space.s16),
          child: TimelineList(
            entries: <TimelineEntry>[
              for (final PwfHistoryEntry entry in detail.history) TimelineEntry(title: _historyKind(context, entry.kind), when: formatMoment(entry.at, language: language), detail: entry.reason),
            ],
          ),
        ),
      ],
      if (detail.exceptions.isEmpty && detail.history.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf6.tab.log.none'), style: text.body)),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
            children: <Widget>[
              _Header(detail: detail),
              if (notice != null) StatusBanner(text: notice!.code == null ? notice!.text : '${notice!.text} (${notice!.code})', tone: notice!.problem ? BannerTone.warning : BannerTone.info, icon: notice!.problem ? Icons.error_outline : Icons.check_circle_outline),
              if (queue.conflicts.isNotEmpty) _ConflictCard(detail: detail, queue: queue, fresh: fresh, onResend: onResend, onDrop: onDrop),
              if (queue.refused.isNotEmpty) _RefusedCard(detail: detail, queue: queue, onDrop: onDrop),
              if (queue.inFlight.isNotEmpty) StatusBanner(text: _pendingText(context, queue.inFlight, online), icon: Icons.schedule),
              // The two facts every reader wants first stay above the tabs: where the task stands and who has it.
              InfoRow(label: context.t('mob.pwf.fact.status'), value: pwfStatusLabel(context, detail.status), divider: false),
              if (detail.assignee != null) InfoRow(label: context.t('mob.pwf.fact.assignee'), value: detail.assignee),
              PwfTabs(
                tabs: <PwfTab>[
                  PwfTab(label: context.t('mob.pwf6.tab.todo'), count: detail.checklist.where((PwfChecklistItem item) => !item.done).length, children: todo),
                  PwfTab(label: context.t('mob.pwf6.tab.facts'), children: facts),
                  PwfTab(label: context.t('mob.pwf6.tab.legal'), count: detail.legalBasis.length + detail.stepLegalBasis.length, children: grounds),
                  PwfTab(label: context.t('mob.pwf6.tab.log'), count: detail.history.length, children: log),
                ],
              ),
            ],
          ),
        ),
        ?bar,
      ],
    );
  }

  ActionBar? _bar(BuildContext context, bool locked, bool problem) {
    String? why() {
      if (problem) return context.t('mob.pwf.bar.why.problem');
      if (_waitingForOwnCommand) return context.t('mob.pwf.bar.why.pending');
      return null;
    }

    final PwfTaskStatus status = detail.status;
    if (status == PwfTaskStatus.awaitingApproval && detail.canApprove) {
      return ActionBar(
        primary: ActionBarButton(label: context.t('mob.pwf.bar.approve'), icon: Icons.check, onPressed: busy || !online ? null : () => onApprove(detail)),
        secondary: detail.canReturn ? ActionBarButton(label: context.t('mob.pwf.bar.return'), onPressed: busy || !online ? null : () => onReturn(detail)) : null,
        why: online ? null : context.t('mob.pwf.bar.why.online'),
      );
    }
    if (status == PwfTaskStatus.onHold && detail.canResume) {
      return ActionBar(primary: ActionBarButton(label: context.t('mob.pwf.bar.resume'), icon: Icons.play_arrow, onPressed: busy || !online ? null : () => onResume(detail)), why: online ? null : context.t('mob.pwf.bar.why.online'));
    }
    final bool canAsk = detail.canRequestException && !detail.hasPendingException && !status.isFinal && !queue.has(kPwfExceptionCommand);
    final ActionBarButton? ask = canAsk ? ActionBarButton(label: context.t('mob.pwf.bar.exception'), onPressed: locked ? null : () => onException(detail)) : null;
    if (detail.canStart && !_startPending) {
      return ActionBar(primary: ActionBarButton(label: context.t('mob.pwf.bar.start'), icon: Icons.play_arrow, onPressed: locked ? null : () => onStart(detail)), secondary: ask, why: why());
    }
    if (_canWork && !queue.has(kPwfCompleteCommand)) {
      final bool openBlockers = detail.blockers.isNotEmpty && queue.inFlight.isEmpty && !_startPending;
      return ActionBar(
        primary: ActionBarButton(label: context.t('mob.pwf.bar.complete'), icon: Icons.task_alt, onPressed: locked || openBlockers ? null : () => onComplete(detail)),
        secondary: ask,
        why: why() ?? (openBlockers ? context.t('mob.pwf.bar.why.blockers', <String, Object>{'count': detail.blockers.length}) : null),
      );
    }
    if (ask != null) return ActionBar(primary: ask, why: why());
    return null;
  }

  Widget _blocker(BuildContext context, PwfBlocker blocker, bool divider) => WorkRow(
        title: _blockerText(context, blocker),
        leading: const Icon(Icons.error_outline),
        dividerAbove: divider,
      );

  Widget _checklist(BuildContext context, PwfChecklistItem item, bool divider) {
    final bool pending = queue.pendingItems.contains(item.code);
    final bool done = item.done;
    final bool actionable = _canWork && !done && !pending && !queue.has(kPwfCompleteCommand);
    final String state = done ? context.t('mob.pwf.checklist.done') : (pending ? context.t('mob.pwf.checklist.pending') : context.t('mob.pwf.checklist.open'));
    return WorkRow(
      title: item.name,
      subtitle: item.mandatory ? context.t('mob.pwf.checklist.required') : context.t('mob.pwf.checklist.optional'),
      leading: Icon(done ? Icons.check_circle : (pending ? Icons.schedule : Icons.radio_button_unchecked)),
      trailing: Text(state, style: context.v2text.label),
      onTap: actionable && !busy ? () => onItem(detail, item) : null,
      semanticLabel: '${item.name}, ${item.mandatory ? context.t('mob.pwf.checklist.required') : context.t('mob.pwf.checklist.optional')}, $state',
      dividerAbove: divider,
    );
  }

  Widget _requirement(BuildContext context, PwfRequirement requirement, String kind, bool divider) => WorkRow(
        title: pwfDocTypeName(context, requirement.code),
        subtitle: pwfDocTypeName(context, requirement.code) == requirement.code ? kind : '$kind · ${requirement.code}',
        leading: Icon(requirement.satisfied ? Icons.check_circle : Icons.radio_button_unchecked),
        trailing: Text(requirement.satisfied ? context.t('mob.pwf.requirements.satisfied') : context.t('mob.pwf.requirements.missing'), style: context.v2text.label),
        dividerAbove: divider,
      );

  Widget _evidenceRow(BuildContext context, PwfEvidence evidence, bool divider, String language) {
    final List<String> facts = <String>[
      if (evidence.formTemplateCode != null) evidence.formTemplateCode!,
      formatMoment(evidence.attachedAt, language: language),
    ];
    // What the evidence is, by name: the legal document it answers, else the reference typed with it, else the kind of evidence in words (never a bare code as the title).
    final String kind = pwfEvidenceKindName(context, evidence.kind);
    final String title = evidence.legalDocType != null ? pwfDocTypeName(context, evidence.legalDocType!) : (evidence.externalRef ?? kind);
    return WorkRow(title: title, subtitle: <String>[if (title != kind) kind, ...facts, if (evidence.note != null) evidence.note!].join(' · '), leading: const Icon(Icons.description_outlined), dividerAbove: divider);
  }

  Widget _exceptionRow(BuildContext context, PwfException exception, bool divider, String language) {
    final String kind = switch (exception.kind) {
      'EXTERNAL_DELAY' => context.t('mob.pwf.exception.kind.delay'),
      'PAUSE' => context.t('mob.pwf.exception.kind.pause'),
      'CANCEL_TASK' => context.t('mob.pwf.exception.kind.cancel'),
      _ => context.t('mob.pwf.exception.kind.waive'),
    };
    final String status = switch (exception.status) {
      'APPROVED' || 'USED' => context.t('mob.pwf.exception.status.approved'),
      'REJECTED' => context.t('mob.pwf.exception.status.rejected'),
      _ => context.t('mob.pwf.exception.status.requested'),
    };
    final String range = exception.validFrom == null ? '' : ' · ${formatDay(exception.validFrom!, language: language)}${exception.validTo == null ? '' : ' - ${formatDay(exception.validTo!, language: language)}'}';
    return WorkRow(title: '$kind · $status', subtitle: '${exception.reason}$range', leading: const Icon(Icons.pending_actions_outlined), dividerAbove: divider);
  }

  String _blockerText(BuildContext context, PwfBlocker blocker) => switch (blocker.code) {
        'CHECKLIST_ITEM_OPEN' => context.t('mob.pwf.blocker.item', <String, Object>{'subject': blocker.subject}),
        'EVIDENCE_MISSING' => context.t('mob.pwf.blocker.evidence', <String, Object>{'subject': blocker.subject}),
        'LEGAL_DOC_MISSING' => context.t('mob.pwf.blocker.legal', <String, Object>{'subject': blocker.subject}),
        'FORM_MISSING' => context.t('mob.pwf.blocker.form', <String, Object>{'subject': blocker.subject}),
        'APPROVER_REQUIRED' => context.t('mob.pwf.blocker.approver'),
        'MAKER_IS_APPROVER' => context.t('mob.pwf.blocker.maker'),
        _ => context.t('mob.pwf.blocker.other', <String, Object>{'code': blocker.code}),
      };

  String _historyKind(BuildContext context, String kind) => switch (kind) {
        'START' || 'STARTED' => context.t('mob.pwf.history.started'),
        'COMPLETE_REQUESTED' => context.t('mob.pwf.history.completeRequested'),
        'COMPLETED' => context.t('mob.pwf.history.completed'),
        'APPROVED' => context.t('mob.pwf.history.approved'),
        'RETURNED' => context.t('mob.pwf.history.returned'),
        'EVIDENCE_ATTACHED' => context.t('mob.pwf.history.evidence'),
        'CHECKLIST_DONE' => context.t('mob.pwf.history.checklist'),
        _ => context.t('mob.pwf.history.other', <String, Object>{'kind': kind}),
      };
}

/// The command a person made, in words, for the lines that say what is waiting.
String pwfCommandLabel(BuildContext context, QueuedCommand command) => switch (command.commandType) {
      kPwfStartCommand => context.t('mob.pwf.cmd.start'),
      kPwfChecklistCommand => context.t('mob.pwf.cmd.checklist'),
      kPwfEvidenceCommand => context.t('mob.pwf.cmd.evidence'),
      kPwfCompleteCommand => context.t('mob.pwf.cmd.complete'),
      kPwfExceptionCommand => context.t('mob.pwf.cmd.exception'),
      _ => context.t('mob.pwf.cmd.other'),
    };

String _pendingText(BuildContext context, List<QueuedCommand> pending, bool online) {
  final String list = pending.map((QueuedCommand c) => pwfCommandLabel(context, c)).join(', ');
  return online ? context.t('mob.pwf.pending.sending', <String, Object>{'list': list}) : context.t('mob.pwf.pending.offline', <String, Object>{'list': list});
}

class _Header extends StatelessWidget {
  const _Header({required this.detail});

  final PwfTaskDetail detail;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Padding(
      padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Semantics(container: true, header: true, child: Text(detail.name, style: text.title, textScaler: cappedScaler(context, MachvonV2Type.titleScaleCap))),
          const SizedBox(height: MachvonV2Space.s4),
          Text(
            <String>[detail.code, if (detail.isMilestone) context.t('mob.pwf.header.milestone'), if (detail.mandatory) context.t('mob.pwf.header.required')].join(' · '),
            style: text.caption,
          ),
          const SizedBox(height: MachvonV2Space.s12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              PwfGlyph(band: detail.band, status: detail.status),
              const SizedBox(width: MachvonV2Space.s12),
              Expanded(
                child: Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: PwfDeadlineColumn(band: detail.band, status: detail.status, dueDay: detail.status.isFinal ? null : detail.plannedFinish, missingYear: detail.missingYear, note: detail.status.isFinal ? null : context.t('mob.pwf.header.official')),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The task changed while the person's commands waited on the device. It says what waits, shows that the task above is as the server has it now, and
/// offers two ways on: send the work again on this version (the server checks it again) or drop it. It never decides for the person.
class _ConflictCard extends StatelessWidget {
  const _ConflictCard({required this.detail, required this.queue, required this.fresh, required this.onResend, required this.onDrop});

  final PwfTaskDetail detail;
  final PwfTaskQueueView queue;
  final bool fresh;
  final Future<void> Function(PwfTaskDetail) onResend;
  final Future<void> Function(PwfTaskDetail) onDrop;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String waiting = queue.conflicts.map((QueuedCommand c) => pwfCommandLabel(context, c)).join(', ');
    return Padding(
      padding: const EdgeInsets.all(MachvonV2Space.s16),
      child: Semantics(
        container: true,
        liveRegion: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            StatusBanner(text: context.t('mob.pwf.conflict.title'), tone: BannerTone.late, icon: Icons.sync_problem),
            Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8), child: Text(context.t('mob.pwf.conflict.body', <String, Object>{'list': waiting, 'status': pwfStatusLabel(context, detail.status)}), style: text.body)),
            if (!fresh) Padding(padding: const EdgeInsets.only(bottom: MachvonV2Space.s8), child: Text(context.t('mob.pwf.conflict.needsNetwork'), style: text.caption.copyWith(color: v2.palette.lateFg))),
            FilledButton(onPressed: fresh ? () => onResend(detail) : null, child: Text(context.t('mob.pwf.conflict.resend'), textAlign: TextAlign.center)),
            const SizedBox(height: MachvonV2Space.s8),
            OutlinedButton(onPressed: () => onDrop(detail), child: Text(context.t('mob.pwf.conflict.drop'), textAlign: TextAlign.center)),
          ],
        ),
      ),
    );
  }
}

/// A command the server refused for good (the state does not allow it, the right is gone): the code, the words, and the way to drop it.
class _RefusedCard extends StatelessWidget {
  const _RefusedCard({required this.detail, required this.queue, required this.onDrop});

  final PwfTaskDetail detail;
  final PwfTaskQueueView queue;
  final Future<void> Function(PwfTaskDetail) onDrop;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final QueuedCommand first = queue.refused.first;
    final String code = first.errorCode ?? 'COMMAND_REFUSED';
    return Padding(
      padding: const EdgeInsets.all(MachvonV2Space.s16),
      child: Semantics(
        container: true,
        liveRegion: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            StatusBanner(text: context.t('mob.pwf.refused.title', <String, Object>{'action': pwfCommandLabel(context, first)}), tone: BannerTone.late, icon: Icons.block),
            Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8), child: Text('${_refusalText(context, code)} ($code)', style: text.body)),
            OutlinedButton(onPressed: () => onDrop(detail), child: Text(context.t('mob.pwf.refused.drop'), textAlign: TextAlign.center)),
          ],
        ),
      ),
    );
  }
}
