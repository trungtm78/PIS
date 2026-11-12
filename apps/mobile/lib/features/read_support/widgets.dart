import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/app_scaffold.dart';
import '../../core/widgets/kpi_tile.dart';
import '../../core/widgets/section_panel.dart';
import '../../core/widgets/tap_target.dart';

export '../../core/theme/machvon_semantic.dart' show MachvonTone;
export '../../core/widgets/kpi_tile.dart';
export '../../core/widgets/status_pill.dart';

/// The frame of a screen that reads: the slim top bar (with the back button when the screen was opened from another), the large title of
/// a tab root, an optional line of context and the body under them. It is the one frame of the screens of `lib/features`
/// (`AppScaffold`), so every screen has the same bar.
///
/// A tab root passes [root] so its [title] is drawn large; a child screen has the small title in the bar.
class ScreenFrame extends StatelessWidget {
  const ScreenFrame({
    required this.title,
    required this.body,
    this.actions = const <Widget>[],
    this.root = false,
    this.subtitle,
    this.contextLine,
    this.bottomBar,
    this.floatingAction,
    super.key,
  });

  final String title;
  final Widget body;
  final List<Widget> actions;

  /// The screen is the root of a tab: the title is large and there is no back button.
  final bool root;
  final String? subtitle;

  /// The line of context under the titles (see `ContextLine`).
  final Widget? contextLine;
  final Widget? bottomBar;
  final Widget? floatingAction;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: root ? null : title,
      largeTitle: root ? title : null,
      subtitle: subtitle,
      actions: actions,
      contextLine: contextLine,
      bottomBar: bottomBar,
      floatingAction: floatingAction,
      showBack: root ? false : null,
      body: body,
    );
  }
}

/// A titled block of a screen. The title is a heading for a screen reader, so the blocks can be walked through by heading. With [unit] an
/// "Unit: ..." chip sits at the end of the title line, for the blocks that hold money. It is a [SectionPanel]: a heading and a hairline, not
/// a box.
class SectionCard extends StatelessWidget {
  const SectionCard({required this.title, required this.children, this.semanticLabel, this.unit, this.uppercase = false, super.key});

  final String title;
  final List<Widget> children;

  /// Read instead of the visible texts when the block is one fact to a screen reader.
  final String? semanticLabel;

  /// The unit of the figures in the block ("billion dong"); shown as the chip "Unit: billion dong".
  final String? unit;

  /// Kept for the callers that asked for the uppercase label of the first design; the heading of the phone design is sentence case.
  final bool uppercase;

  @override
  Widget build(BuildContext context) {
    return SectionPanel(
      title: title,
      semanticLabel: semanticLabel,
      trailing: unit == null ? null : UnitChip(unit: unit!),
      children: children,
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

/// The chip "Unit: billion dong" that names the unit of the figures beside it.
class UnitChip extends StatelessWidget {
  const UnitChip({required this.unit, super.key});

  final String unit;

  @override
  Widget build(BuildContext context) => NoteChip(label: context.t('mob.unit.chip.label', <String, Object>{'unit': unit}));
}

/// A label and its value on one line that wraps (no overflow at a large text scale); a screen reader says them together.
class FactLine extends StatelessWidget {
  const FactLine({required this.label, required this.value, super.key});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
      child: MergeSemantics(
        child: Wrap(
          spacing: MachvonV2Space.s8,
          children: <Widget>[
            Text('$label:', style: text.caption),
            Text(value, style: text.bodyStrong),
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
    return TapTarget(
      onTap: onTap,
      semanticLabel: semanticLabel,
      radius: 0,
      minHeight: MachvonV2Size.rowMinHeight,
      child: SizedBox(
        width: double.infinity,
        child: Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8), child: child),
      ),
    );
  }
}
