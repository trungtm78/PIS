import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/deadline.dart';
import '../../core/widgets/work_row.dart';
import 'pwf_models.dart';

/// The words of the status of a task.
String pwfStatusLabel(BuildContext context, PwfTaskStatus status) => switch (status) {
      PwfTaskStatus.notStarted => context.t('mob.pwf.status.notStarted'),
      PwfTaskStatus.inProgress => context.t('mob.pwf.status.inProgress'),
      PwfTaskStatus.awaitingApproval => context.t('mob.pwf.status.awaitingApproval'),
      PwfTaskStatus.done => context.t('mob.pwf.status.done'),
      PwfTaskStatus.onHold => context.t('mob.pwf.status.onHold'),
      PwfTaskStatus.cancelled => context.t('mob.pwf.status.cancelled'),
    };

/// The band as the shared widgets draw it, or null when it has no colour: "not in range yet", "cannot be counted" and a task that is over carry words
/// and a neutral mark instead (never a green one).
DeadlineBand? pwfDeadlineBandOf(PwfBand band) => switch (band.kind) {
      PwfBandKind.red => DeadlineBand.late,
      PwfBandKind.yellow => DeadlineBand.soon,
      PwfBandKind.green => DeadlineBand.ok,
      PwfBandKind.none || PwfBandKind.unknown => null,
    };

/// What the deadline says in words, from what the server counted (the unit it counted in decides "days" or "working days"). A band that cannot be
/// counted says why and never guesses a day: "cannot be worked out yet, no calendar for 2027".
String pwfDeadlineWords(BuildContext context, PwfBand band, {int? missingYear}) {
  switch (band.kind) {
    case PwfBandKind.unknown:
      return missingYear == null || band.reason != 'CALENDAR_UNAVAILABLE'
          ? context.t('mob.pwf.deadline.unknown')
          : context.t('mob.pwf.deadline.unknownYear', <String, Object>{'year': missingYear});
    case PwfBandKind.none:
      return band.reason == 'NO_DUE' ? context.t('mob.pwf.deadline.noDue') : context.t('mob.pwf.deadline.far');
    case PwfBandKind.red || PwfBandKind.yellow || PwfBandKind.green:
      final int? days = band.remainingDays;
      if (days == null) return context.t('mob.pwf.deadline.unknown');
      if (days < 0 && band.isWorking) return context.t('mob.pwf.deadline.lateWorking', <String, Object>{'days': -days});
      if (days < 0) return context.t('mob.pwf.deadline.late', <String, Object>{'days': -days});
      // The one wording of the server (R49): overdue with no working day of lateness counted yet (the weekend after the deadline) is overdue, never "today"; "today" is the day of the deadline only; a
      // deadline still ahead that falls on a day off has no working day left before it.
      if (days == 0 && band.overdue) return context.t('mob.pwf.deadline.overdueNow');
      if (days == 0 && band.dueToday == false) return context.t('mob.pwf.deadline.noDayLeft');
      if (days == 0) return context.t('mob.pwf.deadline.today');
      if (band.isWorking) return context.t('mob.pwf.deadline.leftWorking', <String, Object>{'days': days});
      return context.t('mob.pwf.deadline.left', <String, Object>{'days': days});
  }
}

/// The square at the start of a row of a task: the shape of the band when it has one, a neutral clock for a deadline that is not in range or cannot
/// be counted, a tick for a task that is done and a dash for one that was cancelled.
class PwfGlyph extends StatelessWidget {
  const PwfGlyph({required this.band, required this.status, super.key});

  final PwfBand band;
  final PwfTaskStatus status;

  @override
  Widget build(BuildContext context) {
    if (status == PwfTaskStatus.done) return const DeadlineGlyph(band: DeadlineBand.done);
    final DeadlineBand? colour = status.isFinal ? null : pwfDeadlineBandOf(band);
    if (colour != null) return DeadlineGlyph(band: colour);
    final MachvonV2 v2 = context.v2;
    final IconData icon = status == PwfTaskStatus.cancelled
        ? Icons.remove_circle_outline
        : (band.kind == PwfBandKind.unknown ? Icons.help_outline : (status == PwfTaskStatus.onHold ? Icons.pause_circle_outline : Icons.schedule_outlined));
    return ExcludeSemantics(
      child: SizedBox(
        width: MachvonV2Size.glyph,
        height: MachvonV2Size.glyph,
        child: Material(
          color: v2.palette.sunken,
          borderRadius: BorderRadius.circular(MachvonV2Radius.glyph),
          child: Center(child: Icon(icon, size: MachvonV2Size.glyph * 0.55, color: v2.palette.ink2)),
        ),
      ),
    );
  }
}

/// The end column of a row of a task: the deadline label with its shape, and under it the day the deadline falls on. A task that is over has no
/// deadline: it says its status in words.
class PwfDeadlineColumn extends StatelessWidget {
  const PwfDeadlineColumn({required this.band, required this.status, this.dueDay, this.missingYear, this.note, super.key});

  final PwfBand band;
  final PwfTaskStatus status;

  /// The day the task falls due, `YYYY-MM-DD`: always shown with a coloured band, so a colour is never the only thing said.
  final String? dueDay;
  final int? missingYear;

  /// A line under the day (the label of a personal setting).
  final String? note;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final bool large = largeText(context);
    final CrossAxisAlignment align = large ? CrossAxisAlignment.start : CrossAxisAlignment.end;
    final TextAlign textAlign = large ? TextAlign.start : TextAlign.end;
    if (status.isFinal || status == PwfTaskStatus.awaitingApproval || status == PwfTaskStatus.onHold) {
      final DeadlineBand? colour = status == PwfTaskStatus.done ? DeadlineBand.done : null;
      final String words = pwfStatusLabel(context, status);
      return Column(
        crossAxisAlignment: align,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (colour != null) DeadlineLabel(band: colour, text: words) else Text(words, style: text.label, textAlign: textAlign),
          if (note != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(note!, style: text.caption, textAlign: textAlign)),
        ],
      );
    }
    final DeadlineBand? colour = pwfDeadlineBandOf(band);
    final String words = pwfDeadlineWords(context, band, missingYear: missingYear);
    return Column(
      crossAxisAlignment: align,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (colour != null)
          DeadlineLabel(band: colour, text: words, dueDay: dueDay)
        else
          Semantics(container: true, label: dueDay == null ? words : context.t('mob.deadline.spoken.short', <String, Object>{'band': words, 'label': context.t('mob.deadline.due.label', <String, Object>{'date': formatDay(dueDay!, language: AppStrings.of(context).language)})}), excludeSemantics: true, child: Text(words, style: text.label, textAlign: textAlign)),
        if (dueDay != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(context.t('mob.deadline.due.label', <String, Object>{'date': formatDayShort(dueDay!)}), style: text.caption, textAlign: textAlign)),
        if (note != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(note!, style: text.caption, textAlign: textAlign)),
      ],
    );
  }
}

/// One row of a task of the workflow: the glyph of its official band, its name, who does it and its code, and the deadline at the end. The official
/// band is the only colour a shared screen shows (R40).
WorkRow pwfTaskRow(BuildContext context, PwfTaskRow task, {VoidCallback? onTap, bool dividerAbove = false}) {
  final List<String> facts = <String>[
    task.code,
    if (task.assignee != null) task.assignee!,
    if (task.status == PwfTaskStatus.inProgress || task.status == PwfTaskStatus.awaitingApproval) pwfStatusLabel(context, task.status),
    if (task.returnCount > 0) context.t('mob.pwf.row.returned', <String, Object>{'count': task.returnCount}),
    // PWF-4: the checklist of the task itself, counted by the server.
    if (task.checklistTotal > 0) context.t('mob.pwf.process.row.checklist', <String, Object>{'done': task.checklistDone, 'total': task.checklistTotal}),
  ];
  return WorkRow(
    title: task.name,
    subtitle: facts.join(' · '),
    leading: PwfGlyph(band: task.band, status: task.status),
    trailing: PwfDeadlineColumn(band: task.band, status: task.status, dueDay: task.status.isFinal ? null : task.plannedFinish, missingYear: task.missingYear),
    onTap: onTap,
    semanticLabel: pwfSpokenRow(context, title: task.name, facts: facts, band: task.band, status: task.status, dueDay: task.plannedFinish, missingYear: task.missingYear),
    dividerAbove: dividerAbove,
  );
}

/// What a screen reader says of a row that opens a task: the name, who and what, then the deadline in words with its day (the band is never told by colour alone).
String pwfSpokenRow(BuildContext context, {required String title, required List<String> facts, required PwfBand band, required PwfTaskStatus status, String? dueDay, int? missingYear, String? note}) {
  final String language = AppStrings.of(context).language;
  final String deadline = status.isFinal || status == PwfTaskStatus.awaitingApproval || status == PwfTaskStatus.onHold
      ? pwfStatusLabel(context, status)
      : <String>[pwfDeadlineWords(context, band, missingYear: missingYear), if (dueDay != null) context.t('mob.deadline.due.label', <String, Object>{'date': formatDay(dueDay, language: language)})].join(', ');
  return <String>[title, ...facts, deadline, if (note != null) note.replaceAll('\n', ', ')].join(', ');
}
