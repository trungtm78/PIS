import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/filter_chips.dart';
import '../../core/widgets/stage_strip.dart';
import '../../core/widgets/stat_strip.dart';
import '../../core/widgets/state_view.dart';
import '../../core/widgets/work_row.dart';
import 'pwf_models.dart';
import 'pwf_widgets.dart';

/// The official colour a list can be narrowed to. Only the official bands are here: a shared screen never shows a personal one (R40).
enum PwfBandFilter { all, red, yellow, green }

/// The progress of a project's workflow: the strip of its stages, the count of its tasks by official colour, the milestones ahead and the tasks of
/// each stage with their deadline bands (MOB-78, and the Progress tab of the project). It reads nothing itself: it draws the [workflow] it is given
/// and calls [onOpenTask] when a row is tapped.
class PwfWorkflowPanel extends StatefulWidget {
  const PwfWorkflowPanel({required this.workflow, required this.onOpenTask, super.key});

  final PwfWorkflow workflow;
  final ValueChanged<PwfTaskRow> onOpenTask;

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
    final MachvonV2Text text = context.v2text;
    final PwfPhase? current = workflow.currentPhase;
    final int total = workflow.phases.length;
    final bool finished = workflow.currentIndex > 0 && current != null && !current.open && workflow.openPhase == null;
    final double fraction = current == null || current.requiredTotal == 0 ? (finished ? 1 : 0) : current.requiredDone / current.requiredTotal;
    final Map<PwfBandKind, int> counts = workflow.countsByBand;
    final List<PwfTaskRow> milestones = _filter == PwfBandFilter.all ? workflow.upcomingMilestones() : const <PwfTaskRow>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (workflow.status != 'ACTIVE') StatusBanner(text: _statusText(context, workflow.status), tone: workflow.status == 'CANCELLED' ? BannerTone.warning : BannerTone.info, icon: Icons.info_outline),
        if (workflow.unverified) StatusBanner(text: context.t('mob.pwf.panel.unverified'), icon: Icons.info_outline),
        const SizedBox(height: MachvonV2Space.s12),
        if (total > 0)
          StageStrip(
            total: total,
            current: workflow.currentIndex,
            currentFraction: fraction,
            label: finished ? context.t('mob.pwf.panel.stageAll', <String, Object>{'total': total}) : context.t('mob.pwf.panel.stage', <String, Object>{'current': workflow.currentIndex, 'total': total, 'name': current?.name ?? ''}),
            trailing: context.t('mob.pwf.panel.progress', <String, Object>{'done': workflow.requiredDone, 'total': workflow.requiredTotal}),
          ),
        const SizedBox(height: MachvonV2Space.s12),
        StatStrip(
          cells: <StatCell>[
            StatCell(value: '${counts[PwfBandKind.red] ?? 0}', label: context.t('mob.pwf.panel.count.late'), band: DeadlineBand.late, bandText: context.t('mob.deadline.band.late')),
            StatCell(value: '${counts[PwfBandKind.yellow] ?? 0}', label: context.t('mob.pwf.panel.count.soon'), band: DeadlineBand.soon, bandText: context.t('mob.deadline.band.soon')),
            StatCell(value: '${counts[PwfBandKind.green] ?? 0}', label: context.t('mob.pwf.panel.count.ok'), band: DeadlineBand.ok, bandText: context.t('mob.deadline.band.ok')),
          ],
        ),
        if ((counts[PwfBandKind.unknown] ?? 0) > 0)
          Padding(
            padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s8, right: MachvonV2Space.s16),
            child: Text(context.t('mob.pwf.panel.count.unknown', <String, Object>{'count': counts[PwfBandKind.unknown]!}), style: text.caption),
          ),
        Padding(
          padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s8, right: MachvonV2Space.s16),
          child: Text(context.t('mob.pwf.panel.official'), style: text.caption),
        ),
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
        if (milestones.isNotEmpty) ...<Widget>[
          GroupHeader(title: context.t('mob.pwf.panel.milestones'), count: milestones.length),
          for (int index = 0; index < milestones.length; index += 1) pwfTaskRow(context, milestones[index], onTap: () => widget.onOpenTask(milestones[index]), dividerAbove: index > 0),
        ],
        for (final PwfPhase phase in workflow.phases) ..._phase(context, workflow, phase),
        if (workflow.phases.isEmpty && workflow.visibleTasks.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf.panel.noTasks'), style: text.body)),
        if (_filter != PwfBandFilter.all && !workflow.visibleTasks.any((PwfTaskRow task) => !task.status.isFinal && task.band.kind == _kind))
          Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf.panel.filter.none'), style: text.body)),
        const SizedBox(height: MachvonV2Space.s24),
      ],
    );
  }

  List<Widget> _phase(BuildContext context, PwfWorkflow workflow, PwfPhase phase) {
    final List<PwfTaskRow> all = workflow.tasksOf(phase.code);
    final PwfBandKind? kind = _kind;
    final List<PwfTaskRow> shown = kind == null ? all : <PwfTaskRow>[for (final PwfTaskRow task in all) if (!task.status.isFinal && task.band.kind == kind) task];
    if (kind != null && shown.isEmpty) return const <Widget>[];
    final bool open = _isOpen(phase, shown.isNotEmpty);
    final PwfBandKind? active = kind;
    final List<PwfTaskRow> ordered = <PwfTaskRow>[...shown]..sort(_byUrgency);
    return <Widget>[
      WorkRow(
        title: phase.name,
        subtitle: context.t('mob.pwf.panel.phaseDone', <String, Object>{'done': phase.requiredDone, 'total': phase.requiredTotal}),
        leading: Icon(open ? Icons.expand_less : Icons.expand_more, size: 24, color: context.v2.palette.ink2),
        trailing: active == null ? null : Text('${shown.length}', style: context.v2text.label),
        semanticLabel: open
            ? context.t('mob.pwf.panel.phaseOpen', <String, Object>{'name': phase.name, 'done': phase.requiredDone, 'total': phase.requiredTotal})
            : context.t('mob.pwf.panel.phaseClosed', <String, Object>{'name': phase.name, 'done': phase.requiredDone, 'total': phase.requiredTotal}),
        onTap: () => _toggle(phase, open),
        dividerAbove: false,
      ),
      if (open && ordered.isEmpty) Padding(padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s12), child: Text(context.t('mob.pwf.panel.phaseEmpty'), style: context.v2text.caption)),
      if (open)
        for (int index = 0; index < ordered.length; index += 1) pwfTaskRow(context, ordered[index], onTap: () => widget.onOpenTask(ordered[index]), dividerAbove: index > 0),
    ];
  }

  /// A task that is not over comes before one that is; among the open ones the redder and the nearer first, and the server's own order of the rest.
  static int _byUrgency(PwfTaskRow a, PwfTaskRow b) {
    if (a.status.isFinal != b.status.isFinal) return a.status.isFinal ? 1 : -1;
    final int rank = _rank(a.band.kind).compareTo(_rank(b.band.kind));
    if (rank != 0) return rank;
    return (a.plannedFinish ?? '9999-99-99').compareTo(b.plannedFinish ?? '9999-99-99');
  }

  static int _rank(PwfBandKind kind) => switch (kind) {
        PwfBandKind.red => 0,
        PwfBandKind.yellow => 1,
        PwfBandKind.green => 2,
        PwfBandKind.unknown => 3,
        PwfBandKind.none => 4,
      };

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
