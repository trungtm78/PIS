import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/kpi_tile.dart';

export '../../core/theme/machvon_semantic.dart' show MachvonTone;
export '../../core/widgets/kpi_tile.dart';
export '../../core/widgets/status_pill.dart';

/// The frame of a screen that reads: a title bar (with the back button when the screen was opened from another) and the
/// body under it.
class ScreenFrame extends StatelessWidget {
  const ScreenFrame({required this.title, required this.body, this.actions = const <Widget>[], super.key});

  final String title;
  final Widget body;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title), actions: actions),
      body: body,
    );
  }
}

/// A titled block of a screen. The title is a heading for a screen reader, so the blocks can be walked through by heading.
///
/// With [uppercase] the title is the 12 px section label of the design (uppercase, spaced); with [unit] an "ĐVT: ..." chip sits
/// at the end of the title line, for the blocks that hold money. The title line wraps at a large text scale.
class SectionCard extends StatelessWidget {
  const SectionCard({required this.title, required this.children, this.semanticLabel, this.unit, this.uppercase = false, super.key});

  final String title;
  final List<Widget> children;

  /// Read instead of the visible texts when the block is one fact to a screen reader.
  final String? semanticLabel;

  /// The unit of the figures in the block ("tỷ đồng"); shown as the chip "ĐVT: tỷ đồng".
  final String? unit;

  /// Draws the title as the uppercase section label instead of a sentence-case heading.
  final bool uppercase;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final Widget heading = Semantics(
      header: true,
      child: uppercase
          ? Text(title.toUpperCase(), style: theme.textTheme.labelMedium?.copyWith(color: MachvonColors.textSecondary, letterSpacing: 0.72))
          : Text(title, style: theme.textTheme.titleMedium),
    );
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Semantics(
          container: true,
          label: semanticLabel,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              if (unit == null)
                heading
              else
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Flexible(child: heading),
                    const SizedBox(width: MachvonSpace.space8),
                    Flexible(child: UnitChip(unit: unit!)),
                  ],
                ),
              const SizedBox(height: MachvonSpace.space8),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}

/// The headline figures of a block as [KpiTile]s, two to a line ([columns]); one under the other when the text is enlarged so much (more than 150
/// percent) that two columns would clip a figure. An odd last tile takes the width of one column. Put it inside a [SectionCard].
class KpiGroup extends StatelessWidget {
  const KpiGroup({required this.tiles, this.columns = 2, super.key});

  final List<Widget> tiles;

  /// 2 for short figures (counts), 1 for amounts, which need the whole width.
  final int columns;

  @override
  Widget build(BuildContext context) {
    if (tiles.isEmpty) return const SizedBox.shrink();
    final bool stacked = columns < 2 || MediaQuery.textScalerOf(context).scale(1) > 1.5;
    final List<Widget> lines = <Widget>[];
    if (stacked) {
      for (final Widget tile in tiles) {
        lines.add(tile);
      }
    } else {
      for (int index = 0; index < tiles.length; index += 2) {
        lines.add(
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Expanded(child: tiles[index]),
                const SizedBox(width: MachvonSpace.space8),
                Expanded(child: index + 1 < tiles.length ? tiles[index + 1] : const SizedBox.shrink()),
              ],
            ),
          ),
        );
      }
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int index = 0; index < lines.length; index += 1) ...<Widget>[
          if (index > 0) const SizedBox(height: MachvonSpace.space8),
          lines[index],
        ],
      ],
    );
  }
}

/// The chip "ĐVT: tỷ đồng" that names the unit of the figures beside it.
class UnitChip extends StatelessWidget {
  const UnitChip({required this.unit, super.key});

  final String unit;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: MachvonColors.surface2,
        borderRadius: BorderRadius.all(Radius.circular(MachvonRadius.pill)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space8, vertical: MachvonSpace.space4),
        child: Text(context.t('mob.unit.chip.label', <String, Object>{'unit': unit}), style: Theme.of(context).textTheme.labelMedium?.copyWith(color: MachvonColors.textSecondary)),
      ),
    );
  }
}

/// A label and its value on one line that wraps (no overflow at a large text scale); a screen reader says them together.
class FactLine extends StatelessWidget {
  const FactLine({required this.label, required this.value, super.key});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: MergeSemantics(
        child: Wrap(
          spacing: MachvonSpace.space8,
          children: <Widget>[
            Text('$label:', style: theme.textTheme.bodySmall),
            Text(value, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600, fontFeatures: kTabularFigures)),
          ],
        ),
      ),
    );
  }
}

/// A row of a list that opens something: at least 48 logical pixels high, one tap target, read as one button.
class TappableRow extends StatelessWidget {
  const TappableRow({required this.semanticLabel, required this.onTap, required this.child, super.key});

  final String semanticLabel;
  final VoidCallback? onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: onTap != null,
      label: semanticLabel,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
            child: child,
          ),
        ),
      ),
    );
  }
}
