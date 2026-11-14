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
import 'pwf_process_widgets.dart';
import 'pwf_tabs.dart';
import 'pwf_widgets.dart';

/// The official colour a list can be narrowed to. Only the official bands are here: a shared screen never shows a personal one (R40).
enum PwfBandFilter { all, red, yellow, green }

/// The workflow of a project, one purpose a part: the overview (where it stands on the strip of its stages, the count of its tasks by official
/// colour, the stages with what is done of each and the tasks that need attention), the work (stage, then step, then task, each task with its
/// deadline band) and the milestones. MOB-78 shows the three parts as tabs; the Progress tab of the project, which is already a tab, shows the
/// figures of the overview and the work under one another ([tabbed] false) and lists the milestones of the project itself.
/// It reads nothing itself: it draws the [workflow] it is given and calls [onOpenTask] when a row is tapped.
class PwfWorkflowPanel extends StatefulWidget {
  const PwfWorkflowPanel({required this.workflow, required this.onOpenTask, this.tabbed = true, super.key});

  final PwfWorkflow workflow;
  final ValueChanged<PwfTaskRow> onOpenTask;

  /// Three tabs (MOB-78), or the figures and the work in one column for a host that is a tab itself.
  final bool tabbed;

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
    final List<Widget> banners = <Widget>[
      if (workflow.status != 'ACTIVE') StatusBanner(text: _statusText(context, workflow.status), tone: workflow.status == 'CANCELLED' ? BannerTone.warning : BannerTone.info, icon: Icons.info_outline),
      if (workflow.unverified) StatusBanner(text: context.t('mob.pwf.panel.unverified'), icon: Icons.info_outline),
      if (workflow.lapsedLegalDocuments.isNotEmpty) StatusBanner(text: context.t('mob.pwf.process.lapsed', <String, Object>{'count': workflow.lapsedLegalDocuments.length}), tone: BannerTone.warning, icon: Icons.gavel_outlined),
    ];
    if (!widget.tabbed) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          ...banners,
          ..._figures(context, workflow, counts),
          GroupHeader(title: context.t('mob.pwf7.work.title'), count: workflow.visibleTasks.length),
          ..._work(context, workflow, counts),
        ],
      );
    }
    final List<PwfTaskRow> milestones = <PwfTaskRow>[for (final PwfTaskRow task in workflow.visibleTasks) if (task.isMilestone) task];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        ...banners,
        PwfTabs(
          tabs: <PwfTab>[
            PwfTab(label: context.t('mob.pwf7.tab.overview'), children: _overview(context, workflow, counts)),
            PwfTab(label: context.t('mob.pwf7.tab.work'), count: workflow.visibleTasks.where((PwfTaskRow task) => !task.status.isFinal).length, children: _work(context, workflow, counts)),
            PwfTab(label: context.t('mob.pwf7.tab.milestones'), count: milestones.where((PwfTaskRow task) => !task.status.isFinal).length, children: _milestones(context, milestones)),
          ],
        ),
      ],
    );
  }

  /// The main figures first: the place on the strip of the stages, then the three official bands as three figures.
  List<Widget> _figures(BuildContext context, PwfWorkflow workflow, Map<PwfBandKind, int> counts) {
    final MachvonV2Text text = context.v2text;
    final PwfPhase? current = workflow.currentPhase;
    final int total = workflow.phases.length;
    final bool finished = workflow.currentIndex > 0 && current != null && !current.open && workflow.openPhase == null;
    final double fraction = current == null || current.requiredTotal == 0 ? (finished ? 1 : 0) : current.requiredDone / current.requiredTotal;
    return <Widget>[
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
          StatCell(value: '${counts[PwfBandKind.red] ?? 0}', label: context.t('mob.pwf.panel.filter.late'), band: DeadlineBand.late, bandInline: true),
          StatCell(value: '${counts[PwfBandKind.yellow] ?? 0}', label: context.t('mob.pwf.panel.filter.soon'), band: DeadlineBand.soon, bandInline: true),
          StatCell(value: '${counts[PwfBandKind.green] ?? 0}', label: context.t('mob.pwf.panel.filter.ok'), band: DeadlineBand.ok, bandInline: true),
        ],
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s12),
        child: Text(
          <String>[
            context.t('mob.pwf.panel.official'),
            if ((counts[PwfBandKind.unknown] ?? 0) > 0) context.t('mob.pwf.panel.count.unknown', <String, Object>{'count': counts[PwfBandKind.unknown]!}),
          ].join(' '),
          style: text.caption,
        ),
      ),
    ];
  }

  /// The overview: the figures, the stages each with what is done of it, and the few tasks that need a person now.
  List<Widget> _overview(BuildContext context, PwfWorkflow workflow, Map<PwfBandKind, int> counts) {
    final MachvonV2 v2 = context.v2;
    final List<PwfTaskRow> urgent = <PwfTaskRow>[for (final PwfTaskRow task in workflow.visibleTasks) if (!task.status.isFinal && task.band.kind == PwfBandKind.red) task]..sort(_byUrgency);
    final List<PwfTaskRow> shown = urgent.take(3).toList();
    final String? currentCode = workflow.currentPhase?.code;
    return <Widget>[
      ..._figures(context, workflow, counts),
      if (shown.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf7.overview.urgent'), count: urgent.length),
        for (int index = 0; index < shown.length; index += 1) pwfTaskRow(context, shown[index], onTap: () => widget.onOpenTask(shown[index]), dividerAbove: index > 0),
      ],
      if (workflow.phases.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf7.overview.phases'), count: workflow.phases.length),
        for (int index = 0; index < workflow.phases.length; index += 1)
          (() {
            final PwfPhase phase = workflow.phases[index];
            final bool done = phase.requiredTotal > 0 && phase.requiredDone >= phase.requiredTotal;
            final bool current = phase.code == currentCode;
            final String state = done ? context.t('mob.pwf7.stage.done') : (current ? context.t('mob.pwf7.stage.current') : context.t('mob.pwf7.stage.ahead'));
            final String progress = context.t('mob.pwf.panel.phaseDone', <String, Object>{'done': phase.requiredDone, 'total': phase.requiredTotal});
            return WorkRow(
              title: phase.name,
              titleMaxLines: 3,
              subtitle: '$state · $progress',
              leading: Icon(done ? Icons.check_circle : (current ? Icons.timelapse : Icons.radio_button_unchecked), color: current ? v2.palette.primary : v2.palette.ink2),
              semanticLabel: '${phase.name}, $state, $progress',
              dividerAbove: index > 0,
              quiet: !current && !done,
            );
          })(),
      ],
      if (workflow.phases.isEmpty && workflow.visibleTasks.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf.panel.noTasks'), style: context.v2text.body)),
      const SizedBox(height: MachvonV2Space.s24),
    ];
  }

  /// The work: stage, then step, then task. A colour filter narrows it to one official band.
  List<Widget> _work(BuildContext context, PwfWorkflow workflow, Map<PwfBandKind, int> counts) {
    final MachvonV2Text text = context.v2text;
    return <Widget>[
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
      for (final PwfPhase phase in workflow.phases) ..._phase(context, workflow, phase),
      if (workflow.phases.isEmpty && workflow.visibleTasks.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf.panel.noTasks'), style: text.body)),
      if (_filter != PwfBandFilter.all && !workflow.visibleTasks.any((PwfTaskRow task) => !task.status.isFinal && task.band.kind == _kind))
        Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf.panel.filter.none'), style: text.body)),
      const SizedBox(height: MachvonV2Space.s24),
    ];
  }

  /// The milestones: the ones still ahead, the nearest first, then the ones that are over.
  List<Widget> _milestones(BuildContext context, List<PwfTaskRow> milestones) {
    final List<PwfTaskRow> ahead = <PwfTaskRow>[for (final PwfTaskRow task in milestones) if (!task.status.isFinal) task]
      ..sort((PwfTaskRow a, PwfTaskRow b) => (a.plannedFinish ?? '9999-99-99').compareTo(b.plannedFinish ?? '9999-99-99'));
    final List<PwfTaskRow> over = <PwfTaskRow>[for (final PwfTaskRow task in milestones) if (task.status.isFinal) task];
    return <Widget>[
      if (ahead.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf7.milestones.ahead'), count: ahead.length),
        for (int index = 0; index < ahead.length; index += 1) pwfTaskRow(context, ahead[index], onTap: () => widget.onOpenTask(ahead[index]), dividerAbove: index > 0),
      ],
      if (over.isNotEmpty) ...<Widget>[
        GroupHeader(title: context.t('mob.pwf7.milestones.over'), count: over.length),
        for (int index = 0; index < over.length; index += 1) pwfTaskRow(context, over[index], onTap: () => widget.onOpenTask(over[index]), dividerAbove: index > 0),
      ],
      if (milestones.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf7.milestones.none'), style: context.v2text.body)),
      const SizedBox(height: MachvonV2Space.s24),
    ];
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
        titleMaxLines: 3,
        subtitle: context.t('mob.pwf.panel.phaseDone', <String, Object>{'done': phase.requiredDone, 'total': phase.requiredTotal}),
        leading: Icon(open ? Icons.expand_less : Icons.expand_more, size: 24, color: context.v2.palette.ink2),
        trailing: active == null ? null : Text('${shown.length}', style: context.v2text.label),
        semanticLabel: open
            ? context.t('mob.pwf.panel.phaseOpen', <String, Object>{'name': phase.name, 'done': phase.requiredDone, 'total': phase.requiredTotal})
            : context.t('mob.pwf.panel.phaseClosed', <String, Object>{'name': phase.name, 'done': phase.requiredDone, 'total': phase.requiredTotal}),
        onTap: () => _toggle(phase, open),
        dividerAbove: true,
      ),
      if (open && ordered.isEmpty) Padding(padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s12), child: Text(context.t('mob.pwf.panel.phaseEmpty'), style: context.v2text.caption)),
      // PWF-4: a phase that has steps shows its tasks under them, each step with its progress and its legal grounds; a colour filter and an answer from before steps existed keep the flat list.
      if (open && active == null && workflow.stepsOf(phase.code).isNotEmpty)
        ..._steps(context, workflow, phase)
      else if (open)
        for (int index = 0; index < ordered.length; index += 1) pwfTaskRow(context, ordered[index], onTap: () => widget.onOpenTask(ordered[index]), dividerAbove: index > 0),
    ];
  }

  List<Widget> _steps(BuildContext context, PwfWorkflow workflow, PwfPhase phase) {
    final List<Widget> out = <Widget>[];
    for (final PwfStep step in workflow.stepsOf(phase.code)) {
      final List<PwfTaskRow> tasks = <PwfTaskRow>[...workflow.tasksOfStep(phase.code, step.code)]..sort(_byUrgency);
      out.add(PwfStepHeader(step: step, onLegal: step.legalBasis.isEmpty ? null : () => showPwfLegalBasisSheet(context, title: step.name, basis: step.legalBasis)));
      for (int index = 0; index < tasks.length; index += 1) {
        out.add(pwfTaskRow(context, tasks[index], onTap: () => widget.onOpenTask(tasks[index]), dividerAbove: index > 0));
      }
    }
    final List<PwfTaskRow> loose = <PwfTaskRow>[...workflow.tasksOfStep(phase.code, null)]..sort(_byUrgency);
    if (loose.isNotEmpty) {
      out.add(GroupHeader(title: context.t('mob.pwf.process.loose'), count: loose.length));
      for (int index = 0; index < loose.length; index += 1) {
        out.add(pwfTaskRow(context, loose[index], onTap: () => widget.onOpenTask(loose[index]), dividerAbove: index > 0));
      }
    }
    return out;
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
