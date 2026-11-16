import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/filter_chips.dart';
import '../../core/widgets/state_view.dart';
import '../../core/widgets/work_row.dart';
import 'pwf_models.dart';
import 'pwf_process_widgets.dart';
import 'pwf_step_logic.dart';
import 'pwf_step_row.dart';
import 'pwf_workflow_header.dart';

/// The official colour a list can be narrowed to. Only the official bands are here: a shared screen never shows a personal one (R40).
enum PwfBandFilter { all, red, yellow, green }

/// The workflow of a project as the phone's form of the step table (PWF-5): a compact head (the stage that is open and how far the steps are, the deadline of the
/// whole file with its slip, the steps by official colour), then the phases as sections of a list of steps, each step with its unit and holder (or "Chưa có người nhận"),
/// its deadline with the dot in the official colour and a sentence of where the colour comes from, its state and what blocks it. A colour filter narrows the list to one
/// official band. It reads nothing itself: it draws the [workflow] it is given and calls [onOpenTask] when a row is tapped (MOB-78 opens the actions of the step; the Progress
/// tab of a project opens the task). It replaces the three tabs (overview, work, milestones) of the earlier design: a milestone is a step with a flag, the overview is the head.
class PwfWorkflowPanel extends StatefulWidget {
  const PwfWorkflowPanel({required this.workflow, required this.onOpenTask, this.hints, super.key});

  final PwfWorkflow workflow;
  final ValueChanged<PwfTaskRow> onOpenTask;

  /// The second read of the schedule (the slip of the whole file, the step that drives another); null when it was not read.
  final PwfScheduleHints? hints;

  @override
  State<PwfWorkflowPanel> createState() => _PwfWorkflowPanelState();
}

class _PwfWorkflowPanelState extends State<PwfWorkflowPanel> {
  PwfBandFilter _filter = PwfBandFilter.all;
  final Set<String> _opened = <String>{};
  final Set<String> _closed = <String>{};

  PwfBandKind? get _kind => switch (_filter) {
        PwfBandFilter.all => null,
        PwfBandFilter.red => PwfBandKind.red,
        PwfBandFilter.yellow => PwfBandKind.yellow,
        PwfBandFilter.green => PwfBandKind.green,
      };

  /// The stage the person looks at is open; the others are closed until asked for. A colour filter opens every stage that has a match.
  bool _isOpen(PwfPhase phase, bool hasMatches) {
    if (_closed.contains(phase.code)) return false;
    if (_opened.contains(phase.code)) return true;
    if (_filter != PwfBandFilter.all) return hasMatches;
    return phase.code == widget.workflow.currentPhase?.code;
  }

  void _toggle(PwfPhase phase, bool open) => setState(() {
        if (open) {
          _opened.remove(phase.code);
          _closed.add(phase.code);
        } else {
          _closed.remove(phase.code);
          _opened.add(phase.code);
        }
      });

  @override
  Widget build(BuildContext context) {
    final PwfWorkflow workflow = widget.workflow;
    final Map<PwfBandKind, int> counts = workflow.countsByBand;
    final MachvonV2Text text = context.v2text;
    final PwfBandKind? kind = _kind;
    final Map<String, PwfTaskRow> byCode = <String, PwfTaskRow>{for (final PwfTaskRow task in workflow.tasks) task.code: task};
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (workflow.status != 'ACTIVE') StatusBanner(text: _statusText(context, workflow.status), tone: workflow.status == 'CANCELLED' ? BannerTone.warning : BannerTone.info, icon: Icons.info_outline),
        if (workflow.unverified) StatusBanner(text: context.t('mob.pwf.panel.unverified'), icon: Icons.info_outline),
        if (workflow.lapsedLegalDocuments.isNotEmpty) StatusBanner(text: context.t('mob.pwf.process.lapsed', <String, Object>{'count': workflow.lapsedLegalDocuments.length}), tone: BannerTone.warning, icon: Icons.gavel_outlined),
        PwfWorkflowHeader(workflow: workflow, hints: widget.hints),
        FilterChips<PwfBandFilter>(
          options: <ChipOption<PwfBandFilter>>[
            ChipOption<PwfBandFilter>(value: PwfBandFilter.all, label: context.t('mob.pwf.panel.filter.all')),
            ChipOption<PwfBandFilter>(value: PwfBandFilter.red, label: context.t('mob.pwf.panel.filter.late'), count: counts[PwfBandKind.red] ?? 0),
            ChipOption<PwfBandFilter>(value: PwfBandFilter.yellow, label: context.t('mob.pwf.panel.filter.soon'), count: counts[PwfBandKind.yellow] ?? 0),
            ChipOption<PwfBandFilter>(value: PwfBandFilter.green, label: context.t('mob.pwf.panel.filter.ok'), count: counts[PwfBandKind.green] ?? 0),
          ],
          selected: _filter,
          onChanged: (PwfBandFilter next) => setState(() => _filter = next),
        ),
        for (final PwfPhaseRows phase in pwfPhaseRows(workflow)) ..._phase(context, phase, byCode),
        if (workflow.phases.isEmpty && workflow.visibleTasks.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf.panel.noTasks'), style: text.body)),
        if (kind != null && !workflow.visibleTasks.any((PwfTaskRow task) => !task.status.isFinal && task.band.kind == kind)) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf.panel.filter.none'), style: text.body)),
        const SizedBox(height: MachvonV2Space.s24),
      ],
    );
  }

  List<Widget> _phase(BuildContext context, PwfPhaseRows rows, Map<String, PwfTaskRow> byCode) {
    final PwfPhase phase = rows.phase;
    final PwfBandKind? kind = _kind;
    final List<PwfTaskRow> shown = kind == null ? rows.tasks : <PwfTaskRow>[for (final PwfTaskRow task in rows.tasks) if (!task.status.isFinal && task.band.kind == kind) task];
    if (kind != null && shown.isEmpty) return const <Widget>[];
    final bool open = _isOpen(phase, shown.isNotEmpty);
    Widget row(PwfTaskRow task, {required bool divider, bool indent = false}) => PwfStepRow(
          task: task,
          waiting: pwfWaitingFor(task, hints: widget.hints, byCode: byCode),
          dividerAbove: divider,
          indent: indent,
          onTap: () => widget.onOpenTask(task),
        );
    final List<Widget> body = <Widget>[];
    if (open && rows.entries.isEmpty) {
      body.add(Padding(padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s12), child: Text(context.t('mob.pwf.panel.phaseEmpty'), style: context.v2text.caption)));
    } else if (open && kind != null) {
      // A colour filter keeps the flat list of what matches: the step headers would stand over rows that are not shown.
      for (int index = 0; index < shown.length; index += 1) {
        body.add(row(shown[index], divider: index > 0));
      }
    } else if (open) {
      int index = 0;
      for (final PwfStepEntry entry in rows.entries) {
        if (entry.hasHeader) {
          body.add(PwfStepHeader(step: entry.step!, onLegal: entry.step!.legalBasis.isEmpty ? null : () => showPwfLegalBasisSheet(context, title: entry.step!.name, basis: entry.step!.legalBasis)));
        }
        for (final PwfTaskRow task in entry.tasks) {
          body.add(row(task, divider: index > 0 && !entry.hasHeader, indent: entry.hasHeader));
          index += 1;
        }
      }
    }
    return <Widget>[
      WorkRow(
        title: phase.name,
        titleMaxLines: 3,
        subtitle: context.t('mob.pwf.panel.phaseDone', <String, Object>{'done': phase.requiredDone, 'total': phase.requiredTotal}),
        leading: Icon(open ? Icons.expand_less : Icons.expand_more, size: 24, color: context.v2.palette.ink2),
        trailing: kind == null ? null : Text('${shown.length}', style: context.v2text.label),
        semanticLabel: open
            ? context.t('mob.pwf.panel.phaseOpen', <String, Object>{'name': phase.name, 'done': phase.requiredDone, 'total': phase.requiredTotal})
            : context.t('mob.pwf.panel.phaseClosed', <String, Object>{'name': phase.name, 'done': phase.requiredDone, 'total': phase.requiredTotal}),
        onTap: () => _toggle(phase, open),
        dividerAbove: true,
      ),
      ...body,
    ];
  }

  String _statusText(BuildContext context, String status) => switch (status) {
        'ON_HOLD' => context.t('mob.pwf.panel.status.onHold'),
        'COMPLETED' => context.t('mob.pwf.panel.status.completed'),
        _ => context.t('mob.pwf.panel.status.cancelled'),
      };
}

/// The project has no workflow yet: the screen says so, and says who can start one, instead of an empty list.
class PwfNoWorkflow extends StatelessWidget {
  const PwfNoWorkflow({super.key});

  @override
  Widget build(BuildContext context) => StateView(kind: StateKind.empty, icon: Icons.account_tree_outlined, title: context.t('mob.pwf.none.title'), body: context.t('mob.pwf.none.body'));
}
