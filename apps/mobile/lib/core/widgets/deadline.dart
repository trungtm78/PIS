import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../format/format.dart';
import '../l10n/app_strings.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';

/// The name of a band for a screen reader and for a group title: `Qua han`, `Sap den han`, `Con thoi gian`, `Da xong`.
String deadlineBandName(BuildContext context, DeadlineBand band) {
  switch (band) {
    case DeadlineBand.late:
      return context.t('mob.deadline.band.late');
    case DeadlineBand.soon:
      return context.t('mob.deadline.band.soon');
    case DeadlineBand.ok:
      return context.t('mob.deadline.band.ok');
    case DeadlineBand.done:
      return context.t('mob.deadline.band.done');
  }
}

/// The square at the start of a row: the shape of the band (octagon with an exclamation mark, triangle with an exclamation mark,
/// clock, tick in a circle) on its soft fill. It is decorative: the label next to it carries the words, so it says nothing to a screen reader.
class DeadlineGlyph extends StatelessWidget {
  const DeadlineGlyph({required this.band, this.size = MachvonV2Size.glyph, super.key});

  final DeadlineBand band;
  final double size;

  @override
  Widget build(BuildContext context) {
    final DeadlineStyle style = band.styleIn(context.v2);
    return ExcludeSemantics(
      child: SizedBox(
        width: size,
        height: size,
        child: DecoratedBox(
          decoration: BoxDecoration(color: style.fill, borderRadius: BorderRadius.circular(MachvonV2Radius.glyph)),
          child: Center(child: Icon(style.icon, size: size * 0.55, color: style.foreground)),
        ),
      ),
    );
  }
}

/// The words of a deadline with the shape of its band beside them: `Tre 2 ngay`, `Hom nay`, `Con 8 ngay` (or any [text] for a band
/// such as done). The band is never told by colour alone: the shape, the words and the colour travel together, and a screen reader hears
/// the name of the band and, when the day is given, the day: "Qua han, Tre 2 ngay, han 10/11/2026".
class DeadlineLabel extends StatelessWidget {
  /// A label with its own [text] (done, or any word the screen chose).
  const DeadlineLabel({required this.band, required String this.text, this.dueDay, super.key}) : daysRemaining = null;

  /// The label of a deadline the server counted: the band follows the days unless [band] says otherwise.
  DeadlineLabel.days({required int this.daysRemaining, DeadlineBand? band, this.dueDay, super.key})
      : band = band ?? DeadlineBand.fromDays(daysRemaining),
        text = null;

  final DeadlineBand band;
  final String? text;
  final int? daysRemaining;

  /// The day the deadline falls on, as YYYY-MM-DD; it is read out with the label.
  final String? dueDay;

  @override
  Widget build(BuildContext context) {
    final DeadlineStyle style = band.styleIn(context.v2);
    final String words = text ?? formatDeadline(context, daysRemaining!);
    final String name = deadlineBandName(context, band);
    final String spoken = dueDay == null
        ? context.t('mob.deadline.spoken.short', <String, Object>{'band': name, 'label': words})
        : context.t('mob.deadline.spoken.full', <String, Object>{'band': name, 'label': words, 'date': formatDay(dueDay!, language: AppStrings.of(context).language)});
    return Semantics(
      container: true,
      label: spoken,
      excludeSemantics: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(style.icon, size: 16, color: style.foreground),
          const SizedBox(width: MachvonV2Space.s4),
          Flexible(child: Text(words, style: context.v2text.label.copyWith(color: style.foreground))),
        ],
      ),
    );
  }
}
