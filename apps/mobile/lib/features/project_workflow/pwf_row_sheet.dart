import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show ApiError, newUuidV4;
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/connectivity/reachability.dart';
import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/components.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/info_row.dart';
import '../../core/widgets/sheets.dart';
import '../command_support/command_outcome.dart';
import '../read_support/loaded.dart';
import 'pwf_extension_sheet.dart';
import 'pwf_models.dart';
import 'pwf_step_commands.dart';
import 'pwf_step_logic.dart';
import 'pwf_step_words.dart';
import 'pwf_task_read.dart';
import 'pwf_task_service.dart';
import 'pwf_task_sheets.dart';
import 'pwf_widgets.dart';

/// How the sheet of a row ended: what the screen under it says (a notice, a problem), whether it must read the workflow again (somebody else acted, the schedule
/// moved, or the person did something that changes the list) and whether the person asked for the whole task (MOB-79).
final class PwfRowOutcome {
  const PwfRowOutcome({this.notice, this.problem = false, this.code, this.reload = false, this.openTask = false});

  final String? notice;
  final bool problem;
  final String? code;
  final bool reload;
  final bool openTask;
}

/// The sheet of one row of MOB-78: the facts of the step in a few lines (the unit that receives it and who holds it, its deadline and where the colour comes from, its
/// time limit and extension) and the actions the person may do and the state allows: "Nhận việc", "Nộp hồ sơ", "Hoàn thành", "Xin gia hạn", and always the way to the
/// whole task. The actions are decided by what the server says of THIS person on THIS task (the detail of the task), never by the row alone; a copy kept on the device
/// is said to be one, and the two actions that must be judged against the present (taking a task, asking for more time) are not offered from a copy or with no connection.
/// [fresh] says the workflow on the screen is the answer the server just gave.
Future<PwfRowOutcome?> showPwfRowSheet(BuildContext context, {required PwfTaskRow task, required PwfWorkflow workflow, required String projectId, required bool fresh}) {
  return showActionSheet<PwfRowOutcome>(
    context,
    title: task.name,
    builder: (BuildContext sheet) => PwfRowSheet(task: task, workflow: workflow, projectId: projectId, fresh: fresh),
  );
}

class PwfRowSheet extends ConsumerStatefulWidget {
  const PwfRowSheet({required this.task, required this.workflow, required this.projectId, required this.fresh, super.key});

  final PwfTaskRow task;
  final PwfWorkflow workflow;
  final String projectId;
  final bool fresh;

  @override
  ConsumerState<PwfRowSheet> createState() => _PwfRowSheetState();
}

class _PwfRowSheetState extends ConsumerState<PwfRowSheet> {
  bool _busy = false;

  /// One intention for everything done from this sheet: a second tap is the same command (the same key), so the server records one.
  final String _intention = newUuidV4();

  PwfTaskRow get _task => widget.task;

  /// The workflow the request for more time is based on is the one the server just gave and the person may propose a change of its schedule.
  bool get _canPropose => widget.fresh && widget.workflow.canProposeReschedule && widget.workflow.version != null;

  void _close(PwfRowOutcome outcome) {
    if (mounted) Navigator.pop(context, outcome);
  }

  PwfRowOutcome _outcomeOf(CommandOutcome outcome, {required String done, String? unit}) {
    switch (outcome) {
      case CommandDone():
        return PwfRowOutcome(notice: done, reload: true);
      case CommandOffline():
        return PwfRowOutcome(notice: context.t('mob.pwf.notice.needsNetwork'), problem: true);
      case CommandUnknown():
        return PwfRowOutcome(notice: context.t('mob.pwf.notice.unknown'), problem: true);
      case CommandRefused(:final String code, :final Map<String, Object?> extensions, :final String? detail):
        return PwfRowOutcome(notice: pwfStepRefusalText(context, code, extensions: extensions, unit: unit, detail: detail), problem: true, code: code, reload: pwfRefusalNeedsReload(code));
    }
  }

  Future<void> _claim() async {
    if (_busy) return;
    final String done = context.t('mob.pwfs.notice.claimed');
    setState(() => _busy = true);
    final CommandOutcome outcome = await ref.read(pwfStepCommandsProvider).claim(_task.id);
    if (!mounted) return;
    _close(_outcomeOf(outcome, done: done));
  }

  Future<void> _complete(PwfTaskDetail detail) async {
    if (_busy) return;
    final String? note = await showPwfCompleteSheet(context, detail);
    if (note == null || !mounted) return;
    setState(() => _busy = true);
    PwfRowOutcome outcome;
    try {
      await ref.read(pwfTaskServiceProvider).complete(detail, intention: _intention, note: note);
      if (!mounted) return;
      outcome = PwfRowOutcome(notice: context.t('mob.pwfs.notice.completeQueued'), reload: true);
    } on PwfEarlierCommandUnresolved {
      if (!mounted) return;
      outcome = PwfRowOutcome(notice: context.t('mob.pwf.notice.earlier'), problem: true);
    } on Object catch (error) {
      if (!mounted) return;
      outcome = PwfRowOutcome(notice: context.t('mob.pwf.notice.failed'), problem: true, code: error is ApiError ? error.code : null);
    }
    _close(outcome);
  }

  Future<void> _extend(PwfExtension extension) async {
    final int? version = widget.workflow.version;
    if (_busy || version == null) return;
    final PwfExtensionForm? form = await showPwfExtensionSheet(context, stepName: _task.name, extension: extension);
    if (form == null || !mounted) return;
    setState(() => _busy = true);
    final String unit = pwfDurationUnitWord(context, extension.unit);
    final CommandOutcome outcome = await ref.read(pwfStepCommandsProvider).requestExtension(
          projectId: widget.projectId,
          workflowVersion: version,
          taskCode: _task.code,
          value: form.value,
          reason: form.reason,
        );
    if (!mounted) return;
    _close(_outcomeOf(outcome, done: context.t('mob.pwfs.notice.extSent'), unit: unit));
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final bool online = ref.watch(reachabilityProvider) != Reachability.offline;
    final AsyncValue<Loaded<PwfTaskDetail>> read = ref.watch(pwfSheetTaskProvider(_task.id));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        ..._facts(context),
        const SizedBox(height: MachvonV2Space.s12),
        read.when(
          loading: () => Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8), child: Semantics(liveRegion: true, child: Text(context.t('mob.pwfs.sheet.checking'), style: text.body))),
          error: (Object error, StackTrace _) => Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Semantics(liveRegion: true, child: Text(context.t('mob.pwfs.sheet.unchecked'), style: text.body)),
              Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () => ref.invalidate(pwfSheetTaskProvider(_task.id)), child: Text(context.t('mob.pwfs.sheet.retry')))),
            ],
          ),
          data: (Loaded<PwfTaskDetail> loaded) => _actions(context, loaded, online),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        OutlinedButton(onPressed: _busy ? null : () => _close(const PwfRowOutcome(openTask: true)), style: v2QuietButtonStyle(context.v2), child: Text(context.t('mob.pwfs.action.detail'), textAlign: TextAlign.center)),
      ],
    );
  }

  /// The facts of the step in a few lines; a fact the answer does not give is left out, as everywhere.
  List<Widget> _facts(BuildContext context) {
    final String language = AppStrings.of(context).language;
    final PwfStepFacts facts = _task.facts;
    final bool over = _task.status.isFinal;
    final bool says = pwfDeadlineLineSaysStatus(_task.status);
    final String? tier = over ? null : pwfTierSentence(context, facts.bandTier);
    final String? thresholds = over || facts.bandThresholds == null || facts.bandTier == null ? null : pwfThresholdsSentence(context, facts.bandThresholds!, working: _task.band.isWorking);
    final List<(String, String?)> rows = <(String, String?)>[
      (context.t('mob.pwfs.fact.unit'), facts.receivingUnits.isEmpty ? facts.unitName : facts.receivingUnits.map((PwfReceivingUnit unit) => unit.role == null ? unit.name : '${unit.name} (${unit.role})').join(', ')),
      (context.t('mob.pwfs.fact.holder'), facts.unclaimed && !over ? context.t('mob.pwfs.row.unclaimed') : _task.assignee),
      (context.t('mob.pwfs.fact.state'), pwfStatusLabel(context, _task.status)),
      (context.t('mob.pwfs.fact.due'), over || _task.plannedFinish == null ? null : formatDay(_task.plannedFinish!, language: language)),
      (context.t('mob.pwfs.fact.deadline'), over || says ? null : <String>[pwfBandName(context, _task.band.kind), pwfDeadlineWords(context, _task.band, missingYear: _task.missingYear)].join(' · ')),
      (context.t('mob.pwfs.fact.tier'), tier == null ? null : <String>[tier, ?thresholds].join('. ')),
      (context.t('mob.pwfs.fact.duration'), facts.duration == null ? null : pwfDurationWords(context, facts.duration!)),
      (context.t('mob.pwfs.fact.extension'), facts.extension == null || !facts.extension!.allowed ? null : pwfExtensionUsed(context, facts.extension!)),
    ];
    final List<(String, String?)> known = <(String, String?)>[for (final (String, String?) row in rows) if (row.$2 != null && row.$2!.isNotEmpty) row];
    return <Widget>[for (int index = 0; index < known.length; index += 1) InfoRow(label: known[index].$1, value: known[index].$2, divider: index > 0)];
  }

  Widget _actions(BuildContext context, Loaded<PwfTaskDetail> loaded, bool online) {
    final MachvonV2Text text = context.v2text;
    final PwfTaskDetail detail = loaded.value;
    final PwfRowActions actions = pwfRowActions(detail, canPropose: _canPropose, extension: _task.facts.extension);
    final bool live = online && !loaded.fromCache;
    final List<Widget> buttons = <Widget>[];
    void add({required String label, required VoidCallback? onPressed, String? hint, String? why, Key? key}) {
      final bool primary = buttons.isEmpty;
      final Widget button = primary
          ? FilledButton(key: key, onPressed: onPressed, style: v2PrimaryButtonStyle(context.v2), child: Text(label, textAlign: TextAlign.center))
          : OutlinedButton(key: key, onPressed: onPressed, style: v2QuietButtonStyle(context.v2), child: Text(label, textAlign: TextAlign.center));
      if (buttons.isNotEmpty) buttons.add(const SizedBox(height: MachvonV2Space.s8));
      buttons.add(button);
      final String line = <String>[if (onPressed == null && why != null) why, ?hint].join(' ');
      if (line.isNotEmpty) buttons.add(Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(line, style: text.caption)));
    }

    if (actions.claim) add(key: const ValueKey<String>('pwf-action-claim'), label: context.t('mob.pwfs.action.claim'), hint: context.t('mob.pwfs.action.claim.hint'), why: context.t('mob.pwfs.action.online'), onPressed: _busy || !live ? null : _claim);
    if (actions.submit) add(key: const ValueKey<String>('pwf-action-submit'), label: context.t('mob.pwfs.action.submit'), hint: context.t('mob.pwfs.action.submit.hint', <String, Object>{'count': actions.pendingRequirements}), onPressed: _busy ? null : () => _close(const PwfRowOutcome(openTask: true)));
    if (actions.complete) add(key: const ValueKey<String>('pwf-action-complete'), label: context.t('mob.pwfs.action.complete'), hint: context.t('mob.pwfs.action.complete.hint'), onPressed: _busy ? null : () => _complete(detail));
    final PwfExtensionOffer? offer = actions.extend;
    if (offer != null) {
      if (offer.capped) {
        buttons.add(Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(<String>[context.t('mob.pwfs.ext.capped', <String, Object>{'unit': pwfDurationUnitWord(context, offer.extension.unit)}), pwfExtensionUsed(context, offer.extension)].join(' '), style: text.caption)));
      } else {
        add(
          key: const ValueKey<String>('pwf-action-extend'),
          label: context.t('mob.pwfs.action.extend'),
          hint: pwfExtensionUsed(context, offer.extension),
          why: context.t('mob.pwfs.action.online'),
          onPressed: _busy || !live ? null : () => _extend(offer.extension),
        );
      }
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (loaded.fromCache) Padding(padding: const EdgeInsets.only(bottom: MachvonV2Space.s8), child: Text(context.t('mob.pwfs.sheet.copy'), style: text.caption)),
        if (buttons.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4), child: Text(context.t('mob.pwfs.sheet.none'), style: text.body)) else ...buttons,
      ],
    );
  }
}
