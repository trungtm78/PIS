import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';
import 'tap_target.dart';

/// One tab of [UnderlineTabs]: its name and, when it counts something, the number beside it.
class TabOption {
  const TabOption({required this.label, this.count});

  final String label;
  final int? count;
}

/// Tabs with an underline (design B): the chosen tab is in the ink colour with a 3 high primary bar under it, the others in the
/// secondary ink. Each is at least 48 high and 48 wide, the row scrolls sideways when the words do not fit (a large text scale), and the
/// chosen tab says `selected` to a screen reader.
class UnderlineTabs extends StatelessWidget {
  const UnderlineTabs({required this.tabs, required this.index, required this.onChanged, super.key});

  final List<TabOption> tabs;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return DecoratedBox(
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: v2.palette.line))),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
        child: Row(
          children: <Widget>[
            for (int position = 0; position < tabs.length; position += 1) ...<Widget>[
              if (position > 0) const SizedBox(width: 20),
              TapTarget(
                onTap: () => onChanged(position),
                selected: position == index,
                semanticLabel: tabs[position].count == null ? tabs[position].label : '${tabs[position].label} ${tabs[position].count}',
                radius: 0,
                minHeight: 48,
                minWidth: 48,
                alignment: Alignment.center,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    border: Border(bottom: BorderSide(color: position == index ? v2.palette.primary : Colors.transparent, width: 3)),
                  ),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 48),
                    child: Center(
                      widthFactor: 1,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s4),
                        child: Text.rich(
                          TextSpan(
                            text: tabs[position].label,
                            children: <InlineSpan>[if (tabs[position].count != null) TextSpan(text: ' ${tabs[position].count}', style: text.caption)],
                          ),
                          style: text.label.copyWith(color: position == index ? v2.palette.ink : v2.palette.ink2),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
