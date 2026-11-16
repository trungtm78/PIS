import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/components.dart';
import '../../core/theme/machvon_semantic.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/deadline.dart';
import '../../core/widgets/sheets.dart';
import '../../core/widgets/status_pill.dart';
import '../../core/widgets/tap_target.dart';
import '../../core/widgets/tint_chip.dart';
import 'pwf_models.dart';
import 'pwf_step_logic.dart';
import 'pwf_step_words.dart';
import 'pwf_widgets.dart';

/// One step of the list of MOB-78 (PWF-5), the phone's form of a row of the step table: the name of the step with the star of the deadline of the whole file,
/// who it goes to (the unit that receives it and who holds it, or the chip "Chưa có người nhận"), the deadline with the dot in the OFFICIAL colour (R73: the
/// server's colour, never counted here) and its days, the state as a chip of words, and one line "Đang chặn bởi" when something stands in the way.
/// Tapping the row opens the actions of the step; the dot and the "i" open the sentence that says where the colour comes from.
///
/// A colour is never the only signal: the dot is a shape with its own words in the deadline label, a screen reader hears "Màu Đỏ" among the facts of the row, and
/// the state and the missing holder are written out.
class PwfStepRow extends StatelessWidget {
  const PwfStepRow({required this.task, required this.onTap, this.waiting, this.dividerAbove = false, this.indent = false, super.key});

  final PwfTaskRow task;

  /// What the step waits for (the first thing is said); null or empty says nothing.
  final List<PwfWaitingFor>? waiting;
  final VoidCallback onTap;
  final bool dividerAbove;

  /// A task under the header of a step with several tasks is drawn one level in.
  final bool indent;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final PwfStepFacts facts = task.facts;
    final String language = AppStrings.of(context).language;
    final bool over = task.status.isFinal;
    final String statusWord = pwfStatusLabel(context, task.status);
    final bool says = pwfDeadlineLineSaysStatus(task.status);
    final String? waits = waiting == null || waiting!.isEmpty ? null : context.t('mob.pwfs.row.blocked', <String, Object>{'what': pwfWaitingWords(context, waiting!.first)});
    final String? unit = facts.unitName == null ? null : context.t('mob.pwfs.row.unit', <String, Object>{'unit': facts.unitName!});
    final String? holder = task.assignee == null ? null : context.t('mob.pwfs.row.holder', <String, Object>{'name': task.assignee!});
    final bool unclaimed = facts.unclaimed && !over;
    final String? dueText = over || task.plannedFinish == null ? null : context.t('mob.deadline.due.label', <String, Object>{'date': formatDay(task.plannedFinish!, language: language)});
    final String? forecast = pwfForecastWords(context, status: task.status, dueDay: task.plannedFinish, forecastDay: task.forecastFinish);
    final String bandSpoken = over ? '' : pwfBandSpoken(context, task.band.kind);
    final String deadlineWords = says ? statusWord : pwfDeadlineWords(context, task.band, missingYear: task.missingYear);
    final String spoken = <String>[
      task.name,
      if (facts.isOverallDeadline) context.t('mob.pwfs.row.overall'),
      if (task.isMilestone) context.t('mob.pwfs.row.milestone'),
      ?unit,
      if (unclaimed) context.t('mob.pwfs.row.unclaimed') else ?holder,
      if (!over && !says) bandSpoken,
      deadlineWords,
      ?dueText,
      ?forecast,
      if (!says) context.t('mob.pwfs.row.state', <String, Object>{'state': statusWord}),
      ?waits,
    ].join(', ');
    final MachvonTone tone = switch (task.status) {
      PwfTaskStatus.done => MachvonTone.success,
      PwfTaskStatus.awaitingApproval => MachvonTone.warning,
      PwfTaskStatus.inProgress => MachvonTone.info,
      PwfTaskStatus.onHold || PwfTaskStatus.cancelled || PwfTaskStatus.notStarted => MachvonTone.neutral,
    };
    final DeadlineBand? colour = says ? null : pwfDeadlineBandOf(task.band);
    final Widget main = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(child: Text(task.name, style: over ? text.body.copyWith(color: v2.palette.ink2) : text.bodyStrong)),
            if (facts.isOverallDeadline) Padding(padding: const EdgeInsets.only(left: MachvonV2Space.s4, top: MachvonV2Space.s4), child: Icon(Icons.star, size: 18, color: v2.palette.soonFg)),
          ],
        ),
        if (unit != null || (holder != null && !unclaimed)) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(<String>[?unit, if (!unclaimed) ?holder].join(' · '), style: text.caption)),
        const SizedBox(height: MachvonV2Space.s4),
        Wrap(
          spacing: MachvonV2Space.s8,
          runSpacing: MachvonV2Space.s4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: <Widget>[
            if (colour != null) DeadlineLabel(band: colour, text: deadlineWords, dueDay: task.plannedFinish) else if (!says) Text(deadlineWords, style: text.label),
            if (dueText != null) Text(dueText, style: text.caption),
            if (forecast != null) Text(forecast, style: text.caption),
          ],
        ),
        const SizedBox(height: MachvonV2Space.s4),
        Wrap(
          spacing: MachvonV2Space.s8,
          runSpacing: MachvonV2Space.s4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: <Widget>[
            StatusPill(label: statusWord, tone: tone),
            if (unclaimed) TintChip(label: context.t('mob.pwfs.row.unclaimed'), icon: Icons.person_off_outlined, ink: v2.palette.infoFg, fill: v2.palette.infoBg),
            if (task.isMilestone) TintChip(label: context.t('mob.pwfs.row.milestone'), icon: Icons.flag_outlined, ink: v2.palette.ink2, fill: v2.palette.sunken),
          ],
        ),
        if (waits != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(waits, style: text.caption)),
      ],
    );
    final double left = MachvonV2Space.s16 + (indent ? MachvonV2Space.s16 : 0);
    final Widget content = Padding(
      padding: EdgeInsets.fromLTRB(left, MachvonV2Space.s12, MachvonV2Space.s4, MachvonV2Space.s12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // The dot is a shortcut for whoever sees it: the "i" at the end is the control that is named for a screen reader.
          ExcludeSemantics(
            child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: over ? null : () => showPwfTierSheet(context, band: task.band, facts: facts, missingYear: task.missingYear), child: PwfGlyph(band: task.band, status: task.status)),
          ),
          const SizedBox(width: MachvonV2Space.s12),
          Expanded(child: TapTarget(onTap: onTap, semanticLabel: '$spoken. ${context.t('mob.pwfs.row.hint')}', radius: 0, child: SizedBox(width: double.infinity, child: main))),
          if (over) const SizedBox(width: MachvonV2Size.touchMin) else PwfTierButton(band: task.band, facts: facts, missingYear: task.missingYear),
        ],
      ),
    );
    final Widget row = ConstrainedBox(constraints: const BoxConstraints(minHeight: MachvonV2Size.rowMinHeight), child: content);
    if (!dividerAbove) return row;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(padding: EdgeInsets.only(left: left + MachvonV2Size.glyph + MachvonV2Space.s12), child: SizedBox(height: 1, child: ColoredBox(color: v2.palette.line))),
        row,
      ],
    );
  }
}

/// The "i" at the end of a row: it opens the sentence that says where the colour of the step comes from. It is named with the colour, so that it is the one
/// control of the row that tells the colour in words to a screen reader.
class PwfTierButton extends StatelessWidget {
  const PwfTierButton({required this.band, required this.facts, this.missingYear, super.key});

  final PwfBand band;
  final PwfStepFacts facts;
  final int? missingYear;

  @override
  Widget build(BuildContext context) {
    return TapTarget(
      onTap: () => showPwfTierSheet(context, band: band, facts: facts, missingYear: missingYear),
      semanticLabel: '${pwfBandSpoken(context, band.kind)}. ${context.t('mob.pwfs.tier.open')}',
      alignment: Alignment.center,
      radius: MachvonV2Radius.pill,
      child: Icon(Icons.info_outline, size: 22, color: context.v2.palette.ink2),
    );
  }
}

/// The sheet of "Màu này tính thế nào": the colour with its words, the sentence of the tier (the step, an exception of the policy, the policy, the default of
/// the system) and the thresholds in the unit the colour counts in. It says only what the server said; an answer from before the tiers says that the colour is the official one.
Future<void> showPwfTierSheet(BuildContext context, {required PwfBand band, required PwfStepFacts facts, int? missingYear}) {
  return showActionSheet<void>(
    context,
    title: context.t('mob.pwfs.tier.title'),
    builder: (BuildContext sheet) => PwfTierContent(band: band, facts: facts, missingYear: missingYear),
  );
}

class PwfTierContent extends StatelessWidget {
  const PwfTierContent({required this.band, required this.facts, this.missingYear, super.key});

  final PwfBand band;
  final PwfStepFacts facts;
  final int? missingYear;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final DeadlineBand? colour = pwfDeadlineBandOf(band);
    final String words = pwfDeadlineWords(context, band, missingYear: missingYear);
    final PwfThresholds? thresholds = facts.bandThresholds;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: <Widget>[
            if (colour != null) ...<Widget>[DeadlineGlyph(band: colour), const SizedBox(width: MachvonV2Space.s12)],
            Expanded(child: Text(<String>[pwfBandName(context, band.kind), words].join(' · '), style: text.heading)),
          ],
        ),
        const SizedBox(height: MachvonV2Space.s12),
        Semantics(container: true, child: Text(pwfTierSentence(context, facts.bandTier), style: text.bodyStrong)),
        if (thresholds != null && facts.bandTier != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(pwfThresholdsSentence(context, thresholds, working: band.isWorking), style: text.body)),
        const SizedBox(height: MachvonV2Space.s16),
        OutlinedButton(onPressed: () => Navigator.pop(context), style: v2QuietButtonStyle(v2), child: Text(context.t('mob.pwfs.tier.close'), textAlign: TextAlign.center)),
      ],
    );
  }
}
