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

/// The deadline of a task on one line under its name, across the width of the row: the words of the band with its shape, the day the deadline falls on
/// and, when the progress points to another day, the forecast. A task that waits for an approval, is paused or is over says its status instead of a
/// count of days. It replaces the narrow end column, where "Còn 1 ngày làm việc" and "Chờ duyệt hoàn thành" broke into four or five lines.
/// Whether the line of the deadline says the STATE of the task instead of the days left: a task that is over, waiting for approval or on hold has no
/// countdown to show. A screen that shows the line does not say the state a second time beside it.
bool pwfDeadlineLineSaysStatus(PwfTaskStatus status) => status.isFinal || status == PwfTaskStatus.awaitingApproval || status == PwfTaskStatus.onHold;

class PwfDeadlineLine extends StatelessWidget {
  const PwfDeadlineLine({required this.band, required this.status, this.dueDay, this.forecastDay, this.missingYear, super.key});

  final PwfBand band;
  final PwfTaskStatus status;
  final String? dueDay;

  /// The day the progress now points to; shown only when it is another day than [dueDay].
  final String? forecastDay;
  final int? missingYear;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final bool byStatus = pwfDeadlineLineSaysStatus(status);
    final DeadlineBand? colour = byStatus ? (status == PwfTaskStatus.done ? DeadlineBand.done : null) : pwfDeadlineBandOf(band);
    final String words = byStatus ? pwfStatusLabel(context, status) : pwfDeadlineWords(context, band, missingYear: missingYear);
    // A deadline that is not in range yet, or cannot be counted, may fall in another year: its day is then written with the year.
    final bool far = band.kind == PwfBandKind.none || band.kind == PwfBandKind.unknown;
    final String? due = status.isFinal || dueDay == null ? null : context.t('mob.deadline.due.label', <String, Object>{'date': far ? formatDay(dueDay!, language: AppStrings.of(context).language) : formatDayShort(dueDay!)});
    final String? forecast = pwfForecastWords(context, status: status, dueDay: dueDay, forecastDay: forecastDay);
    return Wrap(
      spacing: MachvonV2Space.s8,
      runSpacing: MachvonV2Space.s4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: <Widget>[
        if (colour != null) DeadlineLabel(band: colour, text: words, dueDay: status.isFinal ? null : dueDay) else Text(words, style: text.label),
        if (due != null) Text(due, style: text.caption),
        if (forecast != null) Text(forecast, style: text.caption),
      ],
    );
  }
}

/// "Dự báo xong 20/11" when the progress of a task that is not over points to another day than its official deadline; null otherwise.
String? pwfForecastWords(BuildContext context, {required PwfTaskStatus status, String? dueDay, String? forecastDay}) {
  if (status.isFinal || forecastDay == null || forecastDay == dueDay) return null;
  // The forecast of a task that runs late may fall in the year after its deadline: the year is then written.
  final bool sameYear = dueDay != null && dueDay.length >= 4 && forecastDay.startsWith(dueDay.substring(0, 4));
  return context.t('mob.pwf7.forecast.short', <String, Object>{'date': sameYear ? formatDayShort(forecastDay) : formatDay(forecastDay, language: AppStrings.of(context).language)});
}

/// One row of a task of the workflow: the glyph of its official band, its name (never cut short of three lines), who does it and where it stands, and
/// the deadline on a line of its own. The official band is the only colour a shared screen shows (R40). The code of the task is not a thing a person
/// reads: it is in the facts of the task (MOB-79), not on the row.
WorkRow pwfTaskRow(BuildContext context, PwfTaskRow task, {VoidCallback? onTap, bool dividerAbove = false}) {
  final List<String> facts = <String>[
    if (task.assignee != null) task.assignee!,
    // A task that waits for an approval says so on its deadline line; only "in progress" is a fact of its own here.
    if (task.status == PwfTaskStatus.inProgress) pwfStatusLabel(context, task.status),
    if (task.returnCount > 0) context.t('mob.pwf.row.returned', <String, Object>{'count': task.returnCount}),
    // PWF-4: the checklist of the task itself, counted by the server.
    if (task.checklistTotal > 0) context.t('mob.pwf.process.row.checklist', <String, Object>{'done': task.checklistDone, 'total': task.checklistTotal}),
  ];
  return WorkRow(
    title: task.name,
    subtitle: facts.isEmpty ? null : facts.join(' · '),
    subtitleMaxLines: 2,
    titleMaxLines: 3,
    leading: PwfGlyph(band: task.band, status: task.status),
    footer: PwfDeadlineLine(band: task.band, status: task.status, dueDay: task.plannedFinish, forecastDay: task.forecastFinish, missingYear: task.missingYear),
    trailing: onTap == null ? null : Icon(Icons.chevron_right, color: context.v2.palette.ink3),
    onTap: onTap,
    semanticLabel: pwfSpokenRow(context, title: task.name, facts: facts, band: task.band, status: task.status, dueDay: task.plannedFinish, missingYear: task.missingYear, note: pwfForecastWords(context, status: task.status, dueDay: task.plannedFinish, forecastDay: task.forecastFinish)),
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
