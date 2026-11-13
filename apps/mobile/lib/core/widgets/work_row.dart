import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../format/format.dart';
import '../l10n/app_strings.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import 'deadline.dart';
import 'tap_target.dart';

/// The one row of every list of the phone (design B "Dong viec"): a glyph, a title of at most two lines, one line of context and a
/// column at the end. It replaces the hand-built cards: a list is rows separated by hairlines, not boxes, so a screen shows five or six
/// items at once and scrolling stays cheap (fixed minimum height, no shadow, no gradient).
///
/// At a large text scale (from 1.5 times) the title and the context are no longer cut and the end column drops below them, so nothing is
/// lost at 200 percent. Tapping the row needs [onTap]; the row is then one semantic node named by [semanticLabel] or by its texts.
class WorkRow extends StatelessWidget {
  const WorkRow({
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onTap,
    this.semanticLabel,
    this.dividerAbove = false,
    this.quiet = false,
    super.key,
  });

  /// A row of a task with a deadline: the glyph of the band at the start, the label of the deadline and its day at the end.
  /// [daysRemaining] is what the server counted (negative when passed); the phone does not count days.
  factory WorkRow.deadline({
    required String title,
    required int daysRemaining,
    String? subtitle,
    String? dueDay,
    DeadlineBand? band,
    Widget? action,
    VoidCallback? onTap,
    String? semanticLabel,
    bool dividerAbove = false,
    Key? key,
  }) {
    final DeadlineBand resolved = band ?? DeadlineBand.fromDays(daysRemaining);
    return WorkRow(
      key: key,
      title: title,
      subtitle: subtitle,
      leading: DeadlineGlyph(band: resolved),
      trailing: _DeadlineColumn(band: resolved, daysRemaining: daysRemaining, dueDay: dueDay, action: action),
      onTap: onTap,
      semanticLabel: semanticLabel,
      dividerAbove: dividerAbove,
    );
  }

  final String title;
  final String? subtitle;

  /// Usually a [DeadlineGlyph] or an icon in a square.
  final Widget? leading;

  /// The column at the end: a label, a figure, a button.
  final Widget? trailing;
  final VoidCallback? onTap;

  /// Replaces the texts for a screen reader; null reads the title, the context and the end column.
  final String? semanticLabel;

  /// A hairline above the row, inset to the start of the text: the separator between two rows.
  final bool dividerAbove;

  /// A row that is done with (a notification already read): the title is drawn in the body weight and the secondary ink, so what is new
  /// stands out without a colour.
  final bool quiet;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final bool large = largeText(context);
    final Widget main = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(title, style: quiet ? text.body.copyWith(color: v2.palette.ink2) : text.bodyStrong, maxLines: large ? null : 2, overflow: large ? TextOverflow.visible : TextOverflow.ellipsis),
        if (subtitle != null) Text(subtitle!, style: text.caption, maxLines: large ? null : 1, overflow: large ? TextOverflow.visible : TextOverflow.ellipsis),
      ],
    );
    final double inset = leading == null ? MachvonV2Space.s16 : MachvonV2Space.s16 + MachvonV2Size.glyph + MachvonV2Space.s12;
    final Widget content = Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
      child: large && trailing != null
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
                  if (leading != null) ...<Widget>[leading!, const SizedBox(width: MachvonV2Space.s12)],
                  Expanded(child: main),
                ]),
                Padding(
                  padding: EdgeInsets.only(left: leading == null ? 0 : MachvonV2Size.glyph + MachvonV2Space.s12, top: MachvonV2Space.s8),
                  child: trailing,
                ),
              ],
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (leading != null) ...<Widget>[leading!, const SizedBox(width: MachvonV2Space.s12)],
                Expanded(child: main),
                if (trailing != null) ...<Widget>[
                  const SizedBox(width: MachvonV2Space.s12),
                  ConstrainedBox(constraints: const BoxConstraints(maxWidth: 116), child: trailing),
                ],
              ],
            ),
    );
    final Widget row = ConstrainedBox(constraints: const BoxConstraints(minHeight: MachvonV2Size.rowMinHeight), child: content);
    final Widget tappable = onTap == null
        ? Semantics(container: true, label: semanticLabel, excludeSemantics: semanticLabel != null, child: row)
        : TapTarget(onTap: onTap, semanticLabel: semanticLabel, radius: 0, child: SizedBox(width: double.infinity, child: row));
    if (!dividerAbove) return tappable;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(padding: EdgeInsets.only(left: inset), child: SizedBox(height: 1, child: ColoredBox(color: v2.palette.line))),
        tappable,
      ],
    );
  }
}

class _DeadlineColumn extends StatelessWidget {
  const _DeadlineColumn({required this.band, required this.daysRemaining, this.dueDay, this.action});

  final DeadlineBand band;
  final int daysRemaining;
  final String? dueDay;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final bool large = largeText(context);
    return Column(
      crossAxisAlignment: large ? CrossAxisAlignment.start : CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        DeadlineLabel.days(daysRemaining: daysRemaining, band: band, dueDay: dueDay),
        if (dueDay != null)
          Padding(
            padding: const EdgeInsets.only(top: MachvonV2Space.s4),
            child: Text(
              context.t('mob.deadline.due.label', <String, Object>{'date': formatDayShort(dueDay!)}),
              style: context.v2text.caption,
              textAlign: large ? TextAlign.start : TextAlign.end,
            ),
          ),
        if (action != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: action),
      ],
    );
  }
}

/// A row that is still loading: the shape of a [WorkRow] in bars, so the list does not jump when the data arrives. It is not animated, it
/// shows no figure (never a 0) and it says nothing to a screen reader: the screen announces "loading" once.
class WorkRowSkeleton extends StatelessWidget {
  const WorkRowSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final Color color = context.v2.palette.line;
    Widget bar(double width, double height) => SizedBox(
          width: width,
          height: height,
          child: DecoratedBox(decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(6))),
        );
    return ExcludeSemantics(
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: MachvonV2Size.rowMinHeight),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              SizedBox(
                width: MachvonV2Size.glyph,
                height: MachvonV2Size.glyph,
                child: DecoratedBox(decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(MachvonV2Radius.glyph))),
              ),
              const SizedBox(width: MachvonV2Space.s12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    bar(double.infinity, 14),
                    const SizedBox(height: MachvonV2Space.s8),
                    bar(160, 12),
                  ],
                ),
              ),
              const SizedBox(width: MachvonV2Space.s12),
              bar(72, 14),
            ],
          ),
        ),
      ),
    );
  }
}

/// The title of a group of rows ("Overdue", "Due soon"): a band across the list with the number of rows at the end. It is a heading for
/// a screen reader, so the groups can be jumped through.
class GroupHeader extends StatelessWidget {
  const GroupHeader({required this.title, this.count, super.key});

  final String title;
  final int? count;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Semantics(
      header: true,
      container: true,
      label: count == null ? title : '$title, $count',
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: v2.palette.bg,
          border: Border.symmetric(horizontal: BorderSide(color: v2.palette.line)),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
          child: Row(
            children: <Widget>[
              Expanded(child: Text(title, style: text.label.copyWith(color: v2.palette.ink2))),
              if (count != null) Text('$count', style: text.caption),
            ],
          ),
        ),
      ),
    );
  }
}
