import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';
import 'tap_target.dart';

/// One choice of a [FilterChips] row: its name and, when it is a count, the number beside it.
class ChipOption<T> {
  const ChipOption({required this.value, required this.label, this.count});

  final T value;
  final String label;
  final int? count;
}

/// A row of filter chips (design B): 44 high, 8 radius, a 1.5 outline; the chosen one is filled with the ink colour and its text turns to
/// the surface colour, so the choice is a fill and a different text colour (and `selected` for a screen reader), not a colour alone.
/// The row scrolls sideways; at a large text scale the chips keep their words whole.
///
/// It is single choice: tapping the chosen chip again keeps it, which is what a filter that always has a value ("All") wants.
class FilterChips<T> extends StatelessWidget {
  const FilterChips({required this.options, required this.selected, required this.onChanged, this.padding = const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: 6), super.key});

  final List<ChipOption<T>> options;
  final T selected;
  final ValueChanged<T> onChanged;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: padding,
      child: Row(
        children: <Widget>[
          for (int index = 0; index < options.length; index += 1) ...<Widget>[
            if (index > 0) const SizedBox(width: MachvonV2Space.s8),
            _Chip(
              label: options[index].count == null ? options[index].label : '${options[index].label} ${options[index].count}',
              selected: options[index].value == selected,
              onTap: () => onChanged(options[index].value),
              palette: v2.palette,
              style: text.label,
            ),
          ],
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.selected, required this.onTap, required this.palette, required this.style});

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final MachvonV2Palette palette;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    return TapTarget(
      onTap: onTap,
      selected: selected,
      semanticLabel: label,
      radius: MachvonV2Radius.chip,
      // The chip is drawn 44 high; its tap target is 48, the Android minimum, so the padding above and below is 2 less and the row keeps its height.
      minHeight: 48,
      alignment: Alignment.center,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: selected ? palette.ink : Colors.transparent,
          borderRadius: BorderRadius.circular(MachvonV2Radius.chip),
          border: Border.all(color: selected ? palette.ink : palette.outline, width: 1.5),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: MachvonV2Size.touchMin),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Center(widthFactor: 1, child: Text(label, style: style.copyWith(color: selected ? palette.surface : palette.ink))),
          ),
        ),
      ),
    );
  }
}
