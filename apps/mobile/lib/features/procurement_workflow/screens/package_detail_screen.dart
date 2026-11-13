import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/deadline.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/stage_strip.dart';
import '../../../core/widgets/tap_target.dart';
import '../../../core/widgets/timeline.dart';
import '../../../core/widgets/underline_tabs.dart';
import '../../../core/widgets/work_row.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../workflow_models.dart';

/// MOB-70: one package with its progress (docs/process-tree-design.md sections 6 and 7): the strip of the steps of the workflow, the facts of the
/// package, and four tabs: the overview (where it is, what blocks it, the links), the steps with the standard and the actual days, the checklist
/// of the step, and the day-by-day timeline with the quiet days shown as the waits they are. It only reads; the timeline is derived from the
/// append-only history, so it has nothing to edit, and there is no decision to take: the screen has no action bar.
Widget buildPackageDetailScreen(BuildContext context, ScreenContext screen) => PackageDetailScreen(packageId: screen.pathParameters['packageId'] ?? '');

class PackageDetailScreen extends StatelessWidget {
  const PackageDetailScreen({required this.packageId, super.key});

  final String packageId;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
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

/// The tabs of the screen of a package that runs a workflow.
enum _Tab { overview, steps, checklist, timeline }

class _DetailBody extends StatefulWidget {
  const _DetailBody({required this.detail});

  final PrcDetail detail;

  @override
  State<_DetailBody> createState() => _DetailBodyState();
}

class _DetailBodyState extends State<_DetailBody> {
  bool _onlyChanges = false;
  _Tab _tab = _Tab.overview;

  @override
  Widget build(BuildContext context) {
    final PrcDetail detail = widget.detail;
    final PrcWorkflow? workflow = detail.workflow;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        _Header(detail: detail),
        if (workflow == null) _NotStarted(detail: detail) else ..._workflowSections(context, detail, workflow),
      ],
    );
  }

  List<Widget> _workflowSections(BuildContext context, PrcDetail detail, PrcWorkflow workflow) {
    final List<_Tab> tabs = <_Tab>[_Tab.overview, _Tab.steps, if (workflow.running) _Tab.checklist, _Tab.timeline];
    final _Tab shown = tabs.contains(_tab) ? _tab : _Tab.overview;
    String name(_Tab tab) {
      switch (tab) {
        case _Tab.overview:
          return context.t('mob.prc.tab.overview');
        case _Tab.steps:
          return context.t('mob.prc.tab.steps');
        case _Tab.checklist:
          return context.t('mob.prc.tab.checklist');
        case _Tab.timeline:
          return context.t('mob.prc.tab.timeline');
      }
    }

    return <Widget>[
      _Progress(workflow: workflow),
      const SizedBox(height: MachvonV2Space.s8),
      UnderlineTabs(
        tabs: <TabOption>[for (final _Tab tab in tabs) TabOption(label: name(tab), count: tab == _Tab.checklist ? workflow.checklist.length : null)],
        index: tabs.indexOf(shown),
        onChanged: (int index) => setState(() => _tab = tabs[index]),
      ),
      const SizedBox(height: MachvonV2Space.s8),
      switch (shown) {
        _Tab.overview => _Overview(workflow: workflow),
        _Tab.steps => _Stepper(workflow: workflow),
        _Tab.checklist => _Checklist(workflow: workflow),
        _Tab.timeline => _Timeline(workflow: workflow, today: dayOfAnswer(detail.asOf), onlyChanges: _onlyChanges, onFilter: (bool value) => setState(() => _onlyChanges = value)),
      },
    ];
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.detail});

  final PrcDetail detail;

  @override
  Widget build(BuildContext context) {
    final String title = detail.title ?? '';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s12),
          child: Semantics(container: true, header: true, child: Text(title.isEmpty ? detail.code : '${detail.code} · $title', style: context.v2text.title)),
        ),
        InfoRow(label: context.t('mob.prc.info.project'), value: detail.projectName == null ? detail.projectCode : '${detail.projectCode} · ${detail.projectName}'),
        InfoRow(label: context.t('mob.prc.info.unit'), value: detail.unitName),
        InfoRow(label: context.t('mob.prc.info.method'), value: methodLabel(context, detail.method)),
        InfoRow(label: context.t('mob.prc.info.value'), value: moneyFullLabel(context, detail.valueVnd)),
        const SizedBox(height: MachvonV2Space.s12),
      ],
    );
  }
}

class _NotStarted extends StatelessWidget {
  const _NotStarted({required this.detail});

  final PrcDetail detail;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SectionCard(
          title: context.t('mob.prc.status.notStarted'),
          children: <Widget>[Text(context.t('mob.prc.detail.notStarted'), style: text.body)],
        ),
        if (detail.definitionSteps.isNotEmpty)
          SectionCard(
            title: context.t('mob.prc.detail.definition.title'),
            children: <Widget>[
              for (final PrcStepDef step in detail.definitionSteps)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
                  child: Text('${step.order}. ${step.name} · ${context.t('mob.prc.detail.step.standard', <String, Object>{'n': step.standardDays})}', style: text.body),
                ),
            ],
          ),
      ],
    );
  }
}

/// How far the package has gone: one segment for each step of the workflow, and the words that say it ("done 2 of 4 steps, 52 percent").
class _Progress extends StatelessWidget {
  const _Progress({required this.workflow});

  final PrcWorkflow workflow;

  @override
  Widget build(BuildContext context) {
    final int total = workflow.stepsTotal;
    final String label = context.t('mob.prc.detail.progress', <String, Object>{'done': workflow.stepsDone, 'total': total, 'percent': workflow.percent});
    if (total <= 0) return Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16), child: Text(label, style: context.v2text.captionStrong));
    final bool finished = workflow.stepsDone >= total;
    return StageStrip(total: total, current: finished ? total : workflow.stepsDone + 1, currentFraction: finished ? 1 : 0, label: label);
  }
}

/// The overview: the one line that says where the package is, the countdown to its due day, what blocks it and the links of the package.
class _Overview extends StatelessWidget {
  const _Overview({required this.workflow});

  final PrcWorkflow workflow;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _StatusCard(workflow: workflow),
        if (workflow.blockers.isNotEmpty) _Blockers(blockers: workflow.blockers),
        _Links(workflow: workflow),
      ],
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.workflow});

  final PrcWorkflow workflow;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
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
        Text(parts.join(' · '), style: text.body),
        if (workflow.status == 'ON_HOLD' && workflow.holdReason != null) Text(context.t('mob.prc.detail.status.hold', <String, Object>{'reason': workflow.holdReason!}), style: text.body),
        if (workflow.running && left != null && workflow.dueOn != null)
          Padding(
            padding: const EdgeInsets.only(top: MachvonV2Space.s8),
            child: Align(alignment: AlignmentDirectional.centerStart, child: DeadlineLabel(band: DeadlineBand.fromDays(left), text: countdownLabel(context, left, workflow.dueOn!), dueDay: workflow.dueOn)),
          ),
      ],
    );
  }
}

class _Blockers extends StatelessWidget {
  const _Blockers({required this.blockers});

  final List<PrcBlocker> blockers;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return SectionCard(
      title: context.t('mob.prc.detail.blockers.title'),
      children: <Widget>[
        for (final PrcBlocker blocker in blockers)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                ExcludeSemantics(child: Icon(Icons.block, size: 18, color: v2.palette.lateMark)),
                const SizedBox(width: MachvonV2Space.s8),
                Expanded(child: Text(blockerLabel(context, blocker), style: context.v2text.body)),
              ],
            ),
          ),
      ],
    );
  }
}

/// The steps in one timeline: the shape of the state (a tick for done, an octagon for late, a ring for the current step), the name, the word of
/// the state and the standard days against the actual ones.
class _Stepper extends StatelessWidget {
  const _Stepper({required this.workflow});

  final PrcWorkflow workflow;

  @override
  Widget build(BuildContext context) {
    final List<PrcStepRow> rows = stepperOf(workflow);
    final List<TimelineEntry> entries = <TimelineEntry>[
      for (final PrcStepRow row in rows)
        TimelineEntry(
          title: '${row.step.order}. ${row.step.name}',
          when: stepStateLabel(context, row.state),
          detail: row.actualDays == null
              ? context.t('mob.prc.step.planned', <String, Object>{'planned': row.plannedDays})
              : context.t('mob.prc.step.days', <String, Object>{'planned': row.plannedDays, 'actual': row.actualDays!}),
          band: row.state == PrcStepState.done ? DeadlineBand.done : (row.state == PrcStepState.late ? DeadlineBand.late : null),
          icon: _iconOfStep(row.state),
        ),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
      child: Semantics(container: true, label: context.t('mob.prc.detail.stepper.title'), child: TimelineList(entries: entries)),
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

class _EvidenceChips extends StatelessWidget {
  const _EvidenceChips({required this.evidence});

  final List<PrcEvidence> evidence;

  @override
  Widget build(BuildContext context) {
    if (evidence.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: MachvonV2Space.s4),
      child: Wrap(
        spacing: MachvonV2Space.s8,
        runSpacing: MachvonV2Space.s4,
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
    final MachvonV2Text text = context.v2text;
    if (workflow.checklist.isEmpty) {
      return Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.prc.check.empty'), style: text.body));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int index = 0; index < workflow.checklist.length; index += 1)
          () {
            final PrcChecklistItem item = workflow.checklist[index];
            final String need = item.required ? context.t('mob.prc.check.required') : context.t('mob.prc.check.optional');
            final String status = item.status == 'DONE' ? context.t('mob.prc.check.done') : (item.status == 'WAIVED' ? context.t('mob.prc.check.waived') : context.t('mob.prc.check.open'));
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (index > 0) Padding(padding: const EdgeInsets.only(left: MachvonV2Space.s16), child: SizedBox(height: 1, child: ColoredBox(color: context.v2.palette.line))),
                Semantics(
                  container: true,
                  label: context.t('mob.prc.check.aria', <String, Object>{'name': item.name, 'need': need, 'status': status}),
                  excludeSemantics: true,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(item.name, style: text.bodyStrong),
                        const SizedBox(height: MachvonV2Space.s4),
                        Wrap(
                          spacing: MachvonV2Space.s8,
                          runSpacing: MachvonV2Space.s4,
                          children: <Widget>[
                            StatusPill(label: need, tone: item.required ? MachvonTone.info : MachvonTone.neutral),
                            StatusPill(
                              label: status,
                              tone: item.status == 'OPEN' ? (item.required ? MachvonTone.warning : MachvonTone.neutral) : MachvonTone.success,
                              icon: item.status == 'OPEN' ? Icons.radio_button_unchecked : Icons.check_circle_outline,
                            ),
                          ],
                        ),
                        if (item.dueOn != null) Text(context.t('mob.prc.check.due', <String, Object>{'date': formatDay(item.dueOn!)}), style: text.caption),
                        if (item.ownerName != null) Text(context.t('mob.prc.check.owner', <String, Object>{'name': item.ownerName!}), style: text.caption),
                        if (item.completedVia == 'MILESTONE') Text(context.t('mob.prc.check.viaMilestone'), style: text.caption),
                        _EvidenceChips(evidence: item.evidence),
                      ],
                    ),
                  ),
                ),
              ],
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
    final MachvonV2Text text = context.v2text;
    final List<PrcTimelineRow> rows = timelineRowsOf(workflow, today: today, onlyStateChanges: onlyChanges);
    final PrcStepSummary? summary = workflow.summaryOf(workflow.stepCode) ?? (workflow.summary.isEmpty ? null : workflow.summary.last);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        FilterChips<bool>(
          options: <ChipOption<bool>>[
            ChipOption<bool>(value: false, label: context.t('mob.prc.timeline.filter.all')),
            ChipOption<bool>(value: true, label: context.t('mob.prc.timeline.filter.changes')),
          ],
          selected: onlyChanges,
          onChanged: onFilter,
        ),
        if (summary != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  summary.daysOver > 0
                      ? context.t('mob.prc.timeline.summary.late', <String, Object>{'days': summary.days, 'step': workflow.stepNameOf(summary.stepCode), 'over': summary.daysOver})
                      : context.t('mob.prc.timeline.summary.onTime', <String, Object>{'days': summary.days, 'step': workflow.stepNameOf(summary.stepCode)}),
                  style: text.body,
                ),
                if (!summary.working) Text(context.t('mob.prc.timeline.summary.calendarNote'), style: text.caption),
              ],
            ),
          ),
        if (rows.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.prc.timeline.empty'), style: text.body)),
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
    final String title = row.changes == 0
        ? context.t('mob.prc.timeline.day.headerNone', <String, Object>{'weekday': weekday, 'date': date})
        : context.t('mob.prc.timeline.day.header', <String, Object>{'weekday': weekday, 'date': date, 'n': row.changes});
    return Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: GroupHeader(title: title));
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
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
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
      child: TapTarget(
        onTap: note == null ? null : () => setState(() => _open = !_open),
        radius: 0,
        minHeight: 56,
        child: SizedBox(
          width: double.infinity,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8, horizontal: MachvonV2Space.s16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SizedBox(width: 48, child: Text(time, style: text.caption)),
                if (overdue)
                  const DeadlineGlyph(band: DeadlineBand.late, size: 28)
                else
                  SizedBox(
                    width: 28,
                    height: 28,
                    child: ClipOval(child: ColoredBox(color: v2.palette.sunken, child: Icon(_iconOfKind(entry.kind), size: 16, color: v2.palette.ink2))),
                  ),
                const SizedBox(width: MachvonV2Space.s8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(title, style: text.body),
                      Text(context.t('mob.prc.timeline.actor', <String, Object>{'name': actor}), style: text.caption),
                      if (spent != null) Text(spent, style: text.caption),
                      if (overdue) ...<Widget>[
                        const SizedBox(height: MachvonV2Space.s4),
                        StatusPill(label: context.t('mob.prc.row.late', <String, Object>{'n': _overdueDays(entry)}), tone: MachvonTone.danger, icon: Icons.block),
                        Text(context.t('mob.prc.timeline.kind.overdueEffect'), style: text.caption),
                      ],
                      if (note != null) Text(context.t('mob.prc.timeline.note', <String, Object>{'note': note}), maxLines: _open ? null : 2, overflow: _open ? TextOverflow.visible : TextOverflow.ellipsis, style: text.body),
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
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final PrcGapRow row = widget.row;
    final String? step = row.waitingStep == null ? null : widget.workflow.stepNameOf(row.waitingStep);
    final String line;
    if (step == null) {
      line = context.t('mob.prc.timeline.gap.noStep', <String, Object>{'n': row.days});
    } else if (widget.current) {
      line = context.t('mob.prc.timeline.gap', <String, Object>{'n': row.days, 'step': step});
    } else {
      line = context.t('mob.prc.timeline.gap.past', <String, Object>{'n': row.days, 'step': step});
    }
    return Semantics(
      button: true,
      label: line,
      hint: _open ? context.t('mob.prc.timeline.gap.collapse') : context.t('mob.prc.timeline.gap.expand'),
      excludeSemantics: true,
      child: TapTarget(
        onTap: () => setState(() => _open = !_open),
        radius: 0,
        minHeight: 48,
        child: SizedBox(
          width: double.infinity,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8, horizontal: MachvonV2Space.s16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Icon(Icons.hourglass_empty, size: 16, color: v2.palette.ink2),
                    const SizedBox(width: MachvonV2Space.s8),
                    Expanded(child: Text(line, style: text.body.copyWith(color: v2.palette.ink2))),
                    Icon(_open ? Icons.expand_less : Icons.expand_more, size: 20, color: v2.palette.ink2),
                  ],
                ),
                if (_open)
                  Padding(
                    padding: const EdgeInsets.only(top: MachvonV2Space.s4, left: MachvonV2Space.s24),
                    child: Text(<String>[for (final String quiet in row.quietDays.take(60)) shortDay(quiet)].join(', ') + (row.quietDays.length > 60 ? ' …' : ''), style: text.caption),
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
        if (lines.isEmpty) Text(context.t('mob.prc.detail.links.none'), style: context.v2text.body),
        for (final String line in lines) Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4), child: Text(line, style: context.v2text.body)),
      ],
    );
  }
}
