import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/components.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/deadline.dart';
import '../../../core/widgets/glyph_square.dart';
import '../../../core/widgets/work_row.dart';
import '../alerts.dart';
import 'alert_card.dart';

final RegExp _dayOnly = RegExp(r'^\d{4}-\d{2}-\d{2}$');

/// Where an alert stands against its due day, in the vocabulary of the three bands: the band, the whole days left (negative when late, the
/// order the list is sorted by) and the words. The server decides what is late; the phone only counts the days before a due day the server
/// named (`describeDue`). Null when the alert has no due day.
final class AlertDeadline {
  const AlertDeadline({required this.band, required this.days, required this.due, this.dueDay});

  final DeadlineBand band;

  /// Whole calendar days left; negative when late; 0 for today and for hours left.
  final int days;
  final AlertDue due;

  /// The due day as YYYY-MM-DD when the server gave a day, so the label can say the real date.
  final String? dueDay;

  /// The words: `Tre 2 ngay`, `Hom nay`, `Con 8 ngay` for whole days; the countdown line for hours left or late.
  String words(BuildContext context) {
    switch (due.kind) {
      case AlertDueKind.remainingDays:
      case AlertDueKind.today:
      case AlertDueKind.overdueDays:
        return formatDeadline(context, days);
      // Late with no count of days (the sort key is -1 only to put it among the late ones): the words of the server's flag, no invented duration.
      case AlertDueKind.overdue:
      case AlertDueKind.remainingHours:
      case AlertDueKind.overdueHours:
      case AlertDueKind.none:
        return dueLine(context, due);
    }
  }
}

AlertDeadline? alertDeadline(AlertItem item, DateTime now) {
  final AlertDue due = describeDue(item, now);
  final String? dueDay = item.dueOn != null && _dayOnly.hasMatch(item.dueOn!) ? item.dueOn : null;
  switch (due.kind) {
    case AlertDueKind.none:
      return null;
    case AlertDueKind.remainingDays:
      return AlertDeadline(band: DeadlineBand.fromDays(due.amount), days: due.amount, due: due, dueDay: dueDay);
    case AlertDueKind.today:
    case AlertDueKind.remainingHours:
      return AlertDeadline(band: DeadlineBand.late, days: 0, due: due, dueDay: dueDay);
    case AlertDueKind.overdueDays:
      return AlertDeadline(band: DeadlineBand.late, days: -due.amount, due: due, dueDay: dueDay);
    case AlertDueKind.overdueHours:
    case AlertDueKind.overdue:
      return AlertDeadline(band: DeadlineBand.late, days: -1, due: due, dueDay: dueDay);
  }
}

/// One alert as a row of the list (design B "WorkRow"): the shape of its deadline band at the start (or its level when it has no due day),
/// the title, one line of source and context, and at the end the deadline label with its day and the one primary action of the alert. The
/// rest of the alert (the clocks, who holds it, what follows, the other acts) is one tap away in the sheet [onTap] opens.
class AlertRow extends StatelessWidget {
  const AlertRow({required this.item, required this.now, required this.onTap, this.primaryLabel, this.onPrimary, this.busy = false, this.dividerAbove = false, super.key});

  final AlertItem item;
  final DateTime now;

  /// Opens the whole alert.
  final VoidCallback onTap;

  /// The words and the act of the primary button: "Open" for a record the phone can show, "Take" for an alert nobody holds; null shows none.
  final String? primaryLabel;
  final VoidCallback? onPrimary;
  final bool busy;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final AlertDeadline? deadline = alertDeadline(item, now);
    final String title = item.title.isEmpty ? alertSourceLabel(context, item.source) : item.title;
    final String source = alertSourceLabel(context, item.source);
    final String subtitle = item.subtitle == null ? source : '$source · ${item.subtitle}';
    final ({Color ink, Color fill, IconData icon}) look = severityLook(context, item.severity);
    final Widget? action = primaryLabel == null
        ? null
        : FilledButton(onPressed: busy ? null : onPrimary, style: v2PrimaryButtonStyle(v2), child: Text(primaryLabel!, textAlign: TextAlign.center));
    final bool large = largeText(context);
    // A larger text wraps the words of the button, so its height is not a number to reserve: from 1.15 times it is laid out under the row, at its own height.
    final bool stacked = MediaQuery.textScalerOf(context).scale(1) > 1.15;
    final Widget trailing = Column(
      crossAxisAlignment: large ? CrossAxisAlignment.start : CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (deadline != null) ...<Widget>[
          DeadlineLabel(band: deadline.band, text: deadline.words(context), dueDay: deadline.dueDay),
          if (deadline.dueDay != null)
            Padding(
              padding: const EdgeInsets.only(top: MachvonV2Space.s4),
              child: Text(context.t('mob.deadline.due.label', <String, Object>{'date': formatDayShort(deadline.dueDay!)}), style: context.v2text.caption),
            ),
        ] else
          Text(severityLabel(context, item.severity), style: context.v2text.label.copyWith(color: look.ink)),
        // The room the button takes at the normal text size: the button itself sits over the row (below), so it is a control of its own and not a part of the one the row is.
        if (action != null && !stacked) const SizedBox(height: MachvonV2Space.s8 + MachvonV2Size.touchMin, width: 1),
      ],
    );
    final String spoken = <String>[
      if (deadline != null)
        deadline.dueDay == null
            ? context.t('mob.deadline.spoken.short', <String, Object>{'band': deadlineBandName(context, deadline.band), 'label': deadline.words(context)})
            : context.t('mob.deadline.spoken.full', <String, Object>{'band': deadlineBandName(context, deadline.band), 'label': deadline.words(context), 'date': formatDay(deadline.dueDay!, language: AppStrings.of(context).language)})
      else
        severityLabel(context, item.severity),
      title,
      subtitle,
    ].join('. ');
    final Widget row = WorkRow(
      title: title,
      subtitle: subtitle,
      leading: deadline != null ? DeadlineGlyph(band: deadline.band) : GlyphSquare(icon: look.icon, tone: item.severity == AlertSeverity.watch ? GlyphTone.neutral : GlyphTone.attention),
      trailing: trailing,
      onTap: onTap,
      semanticLabel: spoken,
      dividerAbove: dividerAbove,
    );
    if (action == null) return row;
    if (stacked) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          row,
          Padding(
            padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s12),
            child: Align(alignment: Alignment.centerRight, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 220), child: action)),
          ),
        ],
      );
    }
    return Stack(
      children: <Widget>[
        row,
        Positioned(right: MachvonV2Space.s16, bottom: MachvonV2Space.s12, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 116), child: action)),
      ],
    );
  }
}
