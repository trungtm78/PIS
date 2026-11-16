import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/deadline.dart';
import '../../core/widgets/stage_strip.dart';
import '../../core/widgets/stat_strip.dart';
import 'pwf_models.dart';
import 'pwf_step_logic.dart';
import 'pwf_step_row.dart';
import 'pwf_step_words.dart';
import 'pwf_widgets.dart';

/// The head of the workflow of a project above the step list (PWF-5): which stage is open and how far the steps are, the deadline of the whole file with how
/// far it stands behind its first baseline, and the count of steps by official colour (the server's counts, not the length of a list). It is the phone's
/// form of the header strip of the web: compact, one screen, no tabs.
class PwfWorkflowHeader extends StatelessWidget {
  const PwfWorkflowHeader({required this.workflow, this.hints, super.key});

  final PwfWorkflow workflow;

  /// The second read of the schedule; null when it was not read (the slip is then not said).
  final PwfScheduleHints? hints;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final Map<PwfBandKind, int> counts = workflow.countsByBand;
    final PwfPhase? current = workflow.currentPhase;
    final int total = workflow.phases.length;
    final bool finished = workflow.currentIndex > 0 && current != null && !current.open && workflow.openPhase == null;
    final double fraction = current == null || current.requiredTotal == 0 ? (finished ? 1 : 0) : current.requiredDone / current.requiredTotal;
    final ({int done, int total, bool ofSteps}) progress = pwfProgress(workflow);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const SizedBox(height: MachvonV2Space.s12),
        if (total > 0)
          StageStrip(
            total: total,
            current: workflow.currentIndex,
            currentFraction: fraction,
            label: finished ? context.t('mob.pwf.panel.stageAll', <String, Object>{'total': total}) : context.t('mob.pwf.panel.stage', <String, Object>{'current': workflow.currentIndex, 'total': total, 'name': current?.name ?? ''}),
            trailing: progress.ofSteps
                ? context.t('mob.pwfs.head.progress', <String, Object>{'done': progress.done, 'total': progress.total})
                : context.t('mob.pwf.panel.progress', <String, Object>{'done': workflow.requiredDone, 'total': workflow.requiredTotal}),
          ),
        if (workflow.overallDeadline != null) _Overall(workflow: workflow, overall: workflow.overallDeadline!, slip: pwfOverallSlip(workflow, hints)),
        const SizedBox(height: MachvonV2Space.s12),
        StatStrip(
          cells: <StatCell>[
            StatCell(value: '${counts[PwfBandKind.red] ?? 0}', label: context.t('mob.pwf.panel.filter.late'), band: DeadlineBand.late, bandInline: true),
            StatCell(value: '${counts[PwfBandKind.yellow] ?? 0}', label: context.t('mob.pwf.panel.filter.soon'), band: DeadlineBand.soon, bandInline: true),
            StatCell(value: '${counts[PwfBandKind.green] ?? 0}', label: context.t('mob.pwf.panel.filter.ok'), band: DeadlineBand.ok, bandInline: true),
          ],
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s4),
          child: Text(
            <String>[
              context.t('mob.pwf.panel.official'),
              if ((counts[PwfBandKind.unknown] ?? 0) > 0) context.t('mob.pwf.panel.count.unknown', <String, Object>{'count': counts[PwfBandKind.unknown]!}),
            ].join(' '),
            style: text.caption,
          ),
        ),
      ],
    );
  }
}

/// The deadline of the whole file: its day, the colour of the task that carries it with the days left and the "i" for the sentence of the tier, and how far it
/// stands behind its first baseline (or that it does not).
class _Overall extends StatelessWidget {
  const _Overall({required this.workflow, required this.overall, required this.slip});

  final PwfWorkflow workflow;
  final PwfOverallDeadline overall;
  final int? slip;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String language = AppStrings.of(context).language;
    final PwfBandKind kind = pwfBandKindOf(overall.band);
    final PwfTaskRow? row = pwfOverallTask(workflow);
    final bool over = row?.status.isFinal ?? false;
    final PwfBand band = PwfBand(kind: kind, unit: 'WORKING', remainingDays: overall.remainingDays, overdue: (overall.remainingDays ?? 0) < 0);
    final DeadlineBand? colour = over ? null : pwfDeadlineBandOf(band);
    final String due = context.t('mob.pwfs.head.overall', <String, Object>{'date': formatDay(overall.dueOn, language: language)});
    final String words = pwfDeadlineWords(context, band);
    final PwfStepFacts facts = PwfStepFacts(bandTier: overall.bandTier, bandThresholds: row?.facts.bandThresholds);
    final String? slipText = slip == null ? null : (slip! > 0 ? context.t('mob.pwfs.head.slip', <String, Object>{'days': slip!}) : context.t('mob.pwfs.head.onTime'));
    return Padding(
      padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s12, MachvonV2Space.s4, 0),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(padding: const EdgeInsets.only(top: 2), child: ExcludeSemantics(child: Icon(Icons.star, size: 20, color: v2.palette.soonFg))),
          const SizedBox(width: MachvonV2Space.s8),
          Expanded(
            child: Semantics(
              container: true,
              label: <String>[due, overall.taskName, if (colour != null) pwfBandSpoken(context, kind), if (colour != null) words, ?slipText].join(', '),
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(due, style: text.bodyStrong),
                  Text(context.t('mob.pwfs.head.overallTask', <String, Object>{'name': overall.taskName}), style: text.caption),
                  const SizedBox(height: MachvonV2Space.s4),
                  if (colour != null) DeadlineLabel(band: colour, text: words, dueDay: overall.dueOn),
                  if (slipText != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(slipText, style: slip! > 0 ? text.label.copyWith(color: v2.palette.lateFg) : text.caption)),
                ],
              ),
            ),
          ),
          if (colour != null) PwfTierButton(band: band, facts: facts),
        ],
      ),
    );
  }
}
