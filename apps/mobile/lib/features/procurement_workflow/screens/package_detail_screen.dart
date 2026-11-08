import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/app_theme.dart' show kTabularFigures;
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../workflow_models.dart';

/// MOB-70: one package with its progress (docs/process-tree-design.md sections 6 and 7): the stepper of the steps with the standard and the
/// actual days, the one line that says where it is, what blocks it, the checklist of the step, and the day-by-day timeline with the quiet days
/// shown as the waits they are. It only reads; the timeline is derived from the append-only history, so it has nothing to edit.
Widget buildPackageDetailScreen(BuildContext context, ScreenContext screen) => PackageDetailScreen(packageId: screen.pathParameters['packageId'] ?? '');

class PackageDetailScreen extends StatelessWidget {
  const PackageDetailScreen({required this.packageId, super.key});

  final String packageId;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.prc.detail.title'),
      body: DataView<PrcDetail>(
        cacheKey: 'prc.detail.$packageId',
        read: (MachvonApiClient client) => client.execute('getPackageWorkflow', path: <String, Object?>{'package_id': packageId}),
        parse: parsePrcDetail,
        asOf: (PrcDetail detail) => detail.asOf,
        builder: (BuildContext context, Loaded<PrcDetail> loaded) => _DetailBody(detail: loaded.value),
      ),
    );
  }
}

class _DetailBody extends StatefulWidget {
  const _DetailBody({required this.detail});

  final PrcDetail detail;

  @override
  State<_DetailBody> createState() => _DetailBodyState();
}

class _DetailBodyState extends State<_DetailBody> {
  bool _onlyChanges = false;

  @override
  Widget build(BuildContext context) {
    final PrcDetail detail = widget.detail;
    final PrcWorkflow? workflow = detail.workflow;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        _Header(detail: detail),
        if (workflow == null) _NotStarted(detail: detail) else ..._workflowSections(context, detail, workflow),
      ],
    );
  }

  List<Widget> _workflowSections(BuildContext context, PrcDetail detail, PrcWorkflow workflow) {
    return <Widget>[
      _StatusCard(workflow: workflow),
      if (workflow.blockers.isNotEmpty) _Blockers(blockers: workflow.blockers),
      _Stepper(workflow: workflow),
      if (workflow.running) _Checklist(workflow: workflow),
      _Timeline(workflow: workflow, today: dayOfAnswer(detail.asOf), onlyChanges: _onlyChanges, onFilter: (bool value) => setState(() => _onlyChanges = value)),
      _Links(workflow: workflow),
    ];
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.detail});

  final PrcDetail detail;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String title = detail.title ?? '';
    return Padding(
      padding: const EdgeInsets.all(MachvonSpace.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Semantics(header: true, child: Text(title.isEmpty ? detail.code : '${detail.code} · $title', style: theme.textTheme.titleLarge)),
          const SizedBox(height: MachvonSpace.space4),
          Text(context.t('mob.prc.row.project', <String, Object>{'project': detail.projectName == null ? detail.projectCode : '${detail.projectCode} · ${detail.projectName}'}), style: theme.textTheme.bodyMedium),
          if (detail.unitName != null) Text(context.t('mob.prc.detail.unit', <String, Object>{'unit': detail.unitName!}), style: theme.textTheme.bodySmall),
          Text(context.t('mob.prc.detail.method', <String, Object>{'method': methodLabel(context, detail.method)}), style: theme.textTheme.bodySmall),
          Text(context.t('mob.prc.row.value', <String, Object>{'value': millionsLabel(context, detail.valueVnd)}), style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _NotStarted extends StatelessWidget {
  const _NotStarted({required this.detail});

  final PrcDetail detail;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SectionCard(
          title: context.t('mob.prc.status.notStarted'),
          children: <Widget>[Text(context.t('mob.prc.detail.notStarted'))],
        ),
        if (detail.definitionSteps.isNotEmpty)
          SectionCard(
            title: context.t('mob.prc.detail.definition.title'),
            children: <Widget>[
              for (final PrcStepDef step in detail.definitionSteps)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
                  child: Text('${step.order}. ${step.name} · ${context.t('mob.prc.detail.step.standard', <String, Object>{'n': step.standardDays})}'),
                ),
            ],
          ),
      ],
    );
  }
}

/// The one line that says where the package is, and the bar of how far it has gone.
class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.workflow});

  final PrcWorkflow workflow;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final List<String> parts = <String>[];
    if (workflow.status == 'COMPLETED') {
      parts.add(context.t('mob.prc.detail.status.completed'));
    } else if (workflow.status == 'CANCELLED') {
      parts.add(context.t('mob.prc.detail.status.cancelled', <String, Object>{'reason': workflow.endReason ?? ''}));
    } else {
      parts.add(context.t('mob.prc.detail.status.line', <String, Object>{'step': workflow.stepName ?? workflow.stepCode ?? ''}));
      final int? days = workflow.daysInStep;
      if (days != null) {
        parts.add(workflow.daysWorking != null ? context.t('mob.prc.detail.days.working', <String, Object>{'n': days}) : context.t('mob.prc.detail.days.calendar', <String, Object>{'n': days}));
      }
      final PrcStepSummary? spent = workflow.summaryOf(workflow.stepCode);
      if (spent != null && spent.daysOver > 0) parts.add(context.t('mob.prc.detail.status.over', <String, Object>{'n': spent.daysOver}));
      if (workflow.ownerName != null) parts.add(context.t('mob.prc.detail.status.owner', <String, Object>{'name': workflow.ownerName!}));
    }
    final int? left = workflow.daysLeft;
    return SectionCard(
      title: statusLabel(context, workflow.status),
      children: <Widget>[
        Text(parts.join(' · '), style: theme.textTheme.bodyLarge),
        if (workflow.status == 'ON_HOLD' && workflow.holdReason != null) Text(context.t('mob.prc.detail.status.hold', <String, Object>{'reason': workflow.holdReason!}), style: theme.textTheme.bodyMedium),
        if (workflow.running && left != null && workflow.dueOn != null) Padding(padding: const EdgeInsets.only(top: MachvonSpace.space4), child: Text(countdownLabel(context, left, workflow.dueOn!), style: theme.textTheme.bodyMedium?.copyWith(color: left < 0 ? MachvonColors.danger : null))),
        const SizedBox(height: MachvonSpace.space8),
        ExcludeSemantics(
          child: ClipRRect(
            borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.pill)),
            child: LinearProgressIndicator(value: workflow.percent / 100, minHeight: 6),
          ),
        ),
        const SizedBox(height: MachvonSpace.space4),
        Text(context.t('mob.prc.detail.progress', <String, Object>{'done': workflow.stepsDone, 'total': workflow.stepsTotal, 'percent': workflow.percent}), style: theme.textTheme.bodySmall),
      ],
    );
  }
}

class _Blockers extends StatelessWidget {
  const _Blockers({required this.blockers});

  final List<PrcBlocker> blockers;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: context.t('mob.prc.detail.blockers.title'),
      children: <Widget>[
        for (final PrcBlocker blocker in blockers)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const ExcludeSemantics(child: Icon(Icons.block, size: 18, color: MachvonColors.danger)),
                const SizedBox(width: MachvonSpace.space8),
                Expanded(child: Text(blockerLabel(context, blocker))),
              ],
            ),
          ),
      ],
    );
  }
}

IconData _iconOfStep(PrcStepState state) {
  switch (state) {
    case PrcStepState.done:
      return Icons.check_circle;
    case PrcStepState.current:
      return Icons.radio_button_checked;
    case PrcStepState.upcoming:
      return Icons.radio_button_unchecked;
    case PrcStepState.hold:
      return Icons.pause_circle;
    case PrcStepState.late:
      return Icons.block;
  }
}

Color _colorOfStep(PrcStepState state) {
  switch (state) {
    case PrcStepState.done:
      return MachvonColors.success;
    case PrcStepState.current:
      return MachvonColors.primary;
    case PrcStepState.upcoming:
      return MachvonColors.textSecondary;
    case PrcStepState.hold:
      return MachvonColors.neutral;
    case PrcStepState.late:
      return MachvonColors.danger;
  }
}

/// The steps as a vertical list: icon, name, the word of the state, and the standard days against the actual ones.
class _Stepper extends StatelessWidget {
  const _Stepper({required this.workflow});

  final PrcWorkflow workflow;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final List<PrcStepRow> rows = stepperOf(workflow);
    return SectionCard(
      title: context.t('mob.prc.detail.stepper.title'),
      children: <Widget>[
        for (final PrcStepRow row in rows)
          () {
            final String days = row.actualDays == null
                ? context.t('mob.prc.step.planned', <String, Object>{'planned': row.plannedDays})
                : context.t('mob.prc.step.days', <String, Object>{'planned': row.plannedDays, 'actual': row.actualDays!});
            final String state = stepStateLabel(context, row.state);
            return Semantics(
              container: true,
              label: context.t('mob.prc.step.aria', <String, Object>{'order': row.step.order, 'name': row.step.name, 'state': state, 'days': days}),
              excludeSemantics: true,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Icon(_iconOfStep(row.state), size: 24, color: _colorOfStep(row.state)),
                    const SizedBox(width: MachvonSpace.space12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text('${row.step.order}. ${row.step.name}', style: theme.textTheme.bodyLarge?.copyWith(fontWeight: row.state == PrcStepState.upcoming || row.state == PrcStepState.done ? null : FontWeight.w700)),
                          Wrap(
                            spacing: MachvonSpace.space8,
                            children: <Widget>[
                              Text(state, style: theme.textTheme.bodySmall?.copyWith(color: _colorOfStep(row.state), fontWeight: FontWeight.w600)),
                              Text(days, style: theme.textTheme.bodySmall?.copyWith(fontFeatures: kTabularFigures)),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            );
          }(),
      ],
    );
  }
}

class _EvidenceChips extends StatelessWidget {
  const _EvidenceChips({required this.evidence});

  final List<PrcEvidence> evidence;

  @override
  Widget build(BuildContext context) {
    if (evidence.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: MachvonSpace.space4),
      child: Wrap(
        spacing: MachvonSpace.space8,
        runSpacing: MachvonSpace.space4,
        children: <Widget>[
          for (final PrcEvidence one in evidence) StatusPill(label: one.milestoneKind == null ? evidenceLabel(context, one.kind) : '${evidenceLabel(context, one.kind)}: ${milestoneLabel(context, one.milestoneKind!)}', icon: Icons.attach_file),
        ],
      ),
    );
  }
}

/// The checklist of the current step, read only.
class _Checklist extends StatelessWidget {
  const _Checklist({required this.workflow});

  final PrcWorkflow workflow;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return SectionCard(
      title: context.t('mob.prc.check.title'),
      children: <Widget>[
        if (workflow.checklist.isEmpty) Text(context.t('mob.prc.check.empty')),
        for (final PrcChecklistItem item in workflow.checklist)
          () {
            final String need = item.required ? context.t('mob.prc.check.required') : context.t('mob.prc.check.optional');
            final String status = item.status == 'DONE' ? context.t('mob.prc.check.done') : (item.status == 'WAIVED' ? context.t('mob.prc.check.waived') : context.t('mob.prc.check.open'));
            return Semantics(
              container: true,
              label: context.t('mob.prc.check.aria', <String, Object>{'name': item.name, 'need': need, 'status': status}),
              excludeSemantics: true,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(item.name, style: theme.textTheme.bodyLarge),
                    const SizedBox(height: MachvonSpace.space4),
                    Wrap(
                      spacing: MachvonSpace.space8,
                      runSpacing: MachvonSpace.space4,
                      children: <Widget>[
                        StatusPill(label: need, tone: item.required ? MachvonTone.info : MachvonTone.neutral),
                        StatusPill(label: status, tone: item.status == 'OPEN' ? (item.required ? MachvonTone.warning : MachvonTone.neutral) : MachvonTone.success, icon: item.status == 'OPEN' ? Icons.radio_button_unchecked : Icons.check_circle_outline),
                      ],
                    ),
                    if (item.dueOn != null) Text(context.t('mob.prc.check.due', <String, Object>{'date': formatDay(item.dueOn!)}), style: theme.textTheme.bodySmall),
                    if (item.ownerName != null) Text(context.t('mob.prc.check.owner', <String, Object>{'name': item.ownerName!}), style: theme.textTheme.bodySmall),
                    if (item.completedVia == 'MILESTONE') Text(context.t('mob.prc.check.viaMilestone'), style: theme.textTheme.bodySmall),
                    _EvidenceChips(evidence: item.evidence),
                  ],
                ),
              ),
            );
          }(),
      ],
    );
  }
}

IconData _iconOfKind(String kind) {
  switch (kind) {
    case 'START':
      return Icons.flag_outlined;
    case 'STATE_CHANGE':
      return Icons.arrow_forward;
    case 'RETURN':
    case 'CORRECTION':
      return Icons.undo;
    case 'CHECKLIST_DONE':
      return Icons.task_alt;
    case 'HOLD':
      return Icons.pause_circle_outline;
    case 'RESUME':
      return Icons.play_circle_outline;
    case 'EXCEPTION':
      return Icons.rule;
    case 'ASSIGNMENT':
      return Icons.person_outline;
    case 'MILESTONE':
      return Icons.event_available;
    case 'IMPORT':
      return Icons.cloud_download_outlined;
    case 'CLOCK_OVERDUE':
      return Icons.block;
    case 'CANCEL':
      return Icons.cancel_outlined;
    case 'COMPLETE':
      return Icons.verified_outlined;
    default:
      return Icons.circle_outlined;
  }
}

/// The timeline: the filter, the summary of the days in the step, and the days newest first with their entries and the quiet waits between them.
class _Timeline extends StatelessWidget {
  const _Timeline({required this.workflow, required this.today, required this.onlyChanges, required this.onFilter});

  final PrcWorkflow workflow;
  final String today;
  final bool onlyChanges;
  final ValueChanged<bool> onFilter;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final List<PrcTimelineRow> rows = timelineRowsOf(workflow, today: today, onlyStateChanges: onlyChanges);
    final PrcStepSummary? summary = workflow.summaryOf(workflow.stepCode) ?? (workflow.summary.isEmpty ? null : workflow.summary.last);
    return SectionCard(
      title: context.t('mob.prc.timeline.title'),
      children: <Widget>[
        SegmentedButton<bool>(
          showSelectedIcon: false,
          segments: <ButtonSegment<bool>>[
            ButtonSegment<bool>(value: false, label: Text(context.t('mob.prc.timeline.filter.all'))),
            ButtonSegment<bool>(value: true, label: Text(context.t('mob.prc.timeline.filter.changes'))),
          ],
          selected: <bool>{onlyChanges},
          onSelectionChanged: (Set<bool> value) => onFilter(value.first),
          style: const ButtonStyle(minimumSize: WidgetStatePropertyAll<Size>(Size(0, 48))),
        ),
        if (summary != null) ...<Widget>[
          const SizedBox(height: MachvonSpace.space8),
          Text(
            summary.daysOver > 0
                ? context.t('mob.prc.timeline.summary.late', <String, Object>{'days': summary.days, 'step': workflow.stepNameOf(summary.stepCode), 'over': summary.daysOver})
                : context.t('mob.prc.timeline.summary.onTime', <String, Object>{'days': summary.days, 'step': workflow.stepNameOf(summary.stepCode)}),
            style: theme.textTheme.bodyMedium,
          ),
          if (!summary.working) Text(context.t('mob.prc.timeline.summary.calendarNote'), style: theme.textTheme.bodySmall),
        ],
        const SizedBox(height: MachvonSpace.space8),
        if (rows.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space16), child: Text(context.t('mob.prc.timeline.empty'))),
        for (final PrcTimelineRow row in rows)
          switch (row) {
            PrcDayHeaderRow() => _DayHeader(row: row),
            PrcEntryRow() => _EntryTile(entry: row.entry, workflow: workflow),
            PrcGapRow() => _GapTile(row: row, workflow: workflow, current: row.waitingStep == workflow.stepCode && workflow.running && row.quietDays.contains(today)),
          },
      ],
    );
  }
}

class _DayHeader extends StatelessWidget {
  const _DayHeader({required this.row});

  final PrcDayHeaderRow row;

  @override
  Widget build(BuildContext context) {
    final String weekday = weekdayLabel(context, weekdayOf(row.day));
    final String date = formatDay(row.day);
    final String text = row.changes == 0
        ? context.t('mob.prc.timeline.day.headerNone', <String, Object>{'weekday': weekday, 'date': date})
        : context.t('mob.prc.timeline.day.header', <String, Object>{'weekday': weekday, 'date': date, 'n': row.changes});
    return Semantics(
      header: true,
      child: Container(
        margin: const EdgeInsets.only(top: MachvonSpace.space8),
        padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8, horizontal: MachvonSpace.space8),
        decoration: const BoxDecoration(color: MachvonColors.surface2, border: Border(bottom: BorderSide(color: MachvonColors.border))),
        child: Text(text, style: Theme.of(context).textTheme.titleSmall),
      ),
    );
  }
}

class _EntryTile extends StatefulWidget {
  const _EntryTile({required this.entry, required this.workflow});

  final PrcTimelineEntry entry;
  final PrcWorkflow workflow;

  @override
  State<_EntryTile> createState() => _EntryTileState();
}

class _EntryTileState extends State<_EntryTile> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final PrcTimelineEntry entry = widget.entry;
    final String title = entryTitle(context, entry, widget.workflow.stepNameOf);
    final int? spentWorking = entry.spentWorkingDays;
    final int? spentCalendar = entry.spentCalendarDays;
    final String? spent = spentWorking != null
        ? context.t('mob.prc.timeline.spent.working', <String, Object>{'n': spentWorking})
        : (spentCalendar != null ? context.t('mob.prc.timeline.spent.calendar', <String, Object>{'n': spentCalendar}) : null);
    final String time = formatMoment(entry.at).length >= 16 ? formatMoment(entry.at).substring(11) : '';
    final bool overdue = entry.kind == 'CLOCK_OVERDUE';
    final String? note = overdue ? null : entry.reason;
    final String actor = entry.actorName ?? context.t('mob.prc.timeline.system');
    return MergeSemantics(
      child: InkWell(
        onTap: note == null ? null : () => setState(() => _open = !_open),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8, horizontal: MachvonSpace.space4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SizedBox(width: 48, child: Text(time, style: theme.textTheme.bodySmall?.copyWith(fontFeatures: kTabularFigures))),
                DecoratedBox(
                  decoration: BoxDecoration(color: overdue ? MachvonColors.dangerSoft : MachvonColors.surface2, shape: BoxShape.circle),
                  child: SizedBox(width: 28, height: 28, child: Icon(_iconOfKind(entry.kind), size: 16, color: overdue ? MachvonColors.danger : MachvonColors.textSecondary)),
                ),
                const SizedBox(width: MachvonSpace.space8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(title, style: theme.textTheme.bodyLarge),
                      Text(context.t('mob.prc.timeline.actor', <String, Object>{'name': actor}), style: theme.textTheme.bodySmall),
                      if (spent != null) Text(spent, style: theme.textTheme.bodySmall),
                      if (overdue) ...<Widget>[
                        const SizedBox(height: MachvonSpace.space4),
                        StatusPill(label: context.t('mob.prc.row.late', <String, Object>{'n': _overdueDays(entry)}), tone: MachvonTone.danger, icon: Icons.block),
                        Text(context.t('mob.prc.timeline.kind.overdueEffect'), style: theme.textTheme.bodySmall),
                      ],
                      if (note != null) Text(context.t('mob.prc.timeline.note', <String, Object>{'note': note}), maxLines: _open ? null : 2, overflow: _open ? TextOverflow.visible : TextOverflow.ellipsis, style: theme.textTheme.bodyMedium),
                      _EvidenceChips(evidence: entry.evidence),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// How many days late a "step overdue" entry says the step is: from its due day to the day of the entry.
int _overdueDays(PrcTimelineEntry entry) {
  final String? due = entry.reason;
  if (due == null || !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(due)) return 1;
  final int days = daysBetween(due, entry.day);
  return days < 1 ? 1 : days;
}

/// A run of days with no change: the wait. Tapping it lists the days.
class _GapTile extends StatefulWidget {
  const _GapTile({required this.row, required this.workflow, required this.current});

  final PrcGapRow row;
  final PrcWorkflow workflow;
  final bool current;

  @override
  State<_GapTile> createState() => _GapTileState();
}

class _GapTileState extends State<_GapTile> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final PrcGapRow row = widget.row;
    final String? step = row.waitingStep == null ? null : widget.workflow.stepNameOf(row.waitingStep);
    final String text;
    if (step == null) {
      text = context.t('mob.prc.timeline.gap.noStep', <String, Object>{'n': row.days});
    } else if (widget.current) {
      text = context.t('mob.prc.timeline.gap', <String, Object>{'n': row.days, 'step': step});
    } else {
      text = context.t('mob.prc.timeline.gap.past', <String, Object>{'n': row.days, 'step': step});
    }
    return Semantics(
      button: true,
      label: text,
      hint: _open ? context.t('mob.prc.timeline.gap.collapse') : context.t('mob.prc.timeline.gap.expand'),
      excludeSemantics: true,
      child: InkWell(
        onTap: () => setState(() => _open = !_open),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8, horizontal: MachvonSpace.space8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    const Icon(Icons.hourglass_empty, size: 16, color: MachvonColors.textSecondary),
                    const SizedBox(width: MachvonSpace.space8),
                    Expanded(child: Text(text, style: theme.textTheme.bodyMedium?.copyWith(color: MachvonColors.textSecondary))),
                    Icon(_open ? Icons.expand_less : Icons.expand_more, size: 20, color: MachvonColors.textSecondary),
                  ],
                ),
                if (_open)
                  Padding(
                    padding: const EdgeInsets.only(top: MachvonSpace.space4, left: MachvonSpace.space24),
                    child: Text(<String>[for (final String quiet in row.quietDays.take(60)) shortDay(quiet)].join(', ') + (row.quietDays.length > 60 ? ' …' : ''), style: theme.textTheme.bodySmall),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Links extends StatelessWidget {
  const _Links({required this.workflow});

  final PrcWorkflow workflow;

  @override
  Widget build(BuildContext context) {
    final List<String> lines = <String>[
      for (final PrcMilestone milestone in workflow.milestones)
        if (milestone.actualAt != null) context.t('mob.prc.detail.links.milestone', <String, Object>{'kind': milestoneLabel(context, milestone.kind), 'date': formatDay(milestone.actualAt!)}),
      if (workflow.petitionsTotal > 0) context.t('mob.prc.detail.links.petitions', <String, Object>{'open': workflow.petitionsOpen, 'total': workflow.petitionsTotal}),
      if (workflow.resultStatus != null) context.t('mob.prc.detail.links.result', <String, Object>{'status': workflow.resultStatus!}),
      if (workflow.contractCode != null) context.t('mob.prc.detail.links.contract', <String, Object>{'code': workflow.contractCode!}),
    ];
    return SectionCard(
      title: context.t('mob.prc.detail.links.title'),
      children: <Widget>[
        if (lines.isEmpty) Text(context.t('mob.prc.detail.links.none')),
        for (final String line in lines) Padding(padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4), child: Text(line)),
      ],
    );
  }
}
