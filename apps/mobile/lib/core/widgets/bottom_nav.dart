import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';

/// One tab of the [AppBottomNav]: the icon (and the one of the chosen state), the name, and a count when something waits there.
class NavItem {
  const NavItem({required this.icon, required this.selectedIcon, required this.label, this.badge = 0, this.badgeHint});

  final IconData icon;
  final IconData selectedIcon;
  final String label;

  /// The number of things waiting in the tab; 0 draws nothing (a count that was not read is never shown as 0).
  final int badge;

  /// What the count means, said after the name by a screen reader ("3 items need action"); the number is not read as a word of its own.
  final String? badgeHint;
}

/// The bottom navigation of the five tabs (design B): 64 high, a thin line above it, the labels always shown, a 3 high primary bar at the
/// top of the chosen tab, a count in a pill on the icon. The labels stop growing at 1.3 times the system text scale and wrap to two
/// lines, so five of them fit at every scale; each tab is one semantic node named by its label, with the place ("Tab 4 of 5") and the count
/// as a hint.
class AppBottomNav extends StatelessWidget {
  const AppBottomNav({required this.items, required this.selectedIndex, required this.onSelected, super.key});

  final List<NavItem> items;
  final int selectedIndex;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return DecoratedBox(
      decoration: BoxDecoration(color: v2.palette.surface, border: Border(top: BorderSide(color: v2.palette.line))),
      child: SafeArea(
        top: false,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: MachvonV2Size.navBarHeight),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                for (int index = 0; index < items.length; index += 1)
                  Expanded(child: AppBottomNavItem(item: items[index], index: index, count: items.length, selected: index == selectedIndex, onTap: () => onSelected(index))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One tab of the bar; public so a test can find the tabs and their semantics.
class AppBottomNavItem extends StatelessWidget {
  const AppBottomNavItem({required this.item, required this.index, required this.count, required this.selected, required this.onTap, super.key});

  final NavItem item;
  final int index;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Palette p = v2.palette;
    final MachvonV2Text text = context.v2text;
    final Color color = selected ? p.primaryStrong : p.ink2;
    final String place = MaterialLocalizations.of(context).tabLabel(tabIndex: index + 1, tabCount: count);
    final Widget icon = Icon(selected ? item.selectedIcon : item.icon, size: 24, color: color);
    return Semantics(
      container: true,
      selected: selected,
      button: true,
      label: '${item.label}\n$place',
      hint: item.badge > 0 ? item.badgeHint : null,
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            if (selected)
              Positioned(
                top: 0,
                left: 0,
                right: 0,
                child: Center(
                  child: FractionallySizedBox(
                    widthFactor: 0.56,
                    child: SizedBox(height: 3, child: DecoratedBox(decoration: BoxDecoration(color: p.primary, borderRadius: const BorderRadius.vertical(bottom: Radius.circular(3))))),
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s4, vertical: MachvonV2Space.s8),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  if (item.badge > 0)
                    Badge(
                      backgroundColor: p.lateMark,
                      textColor: p.surface,
                      textStyle: text.captionStrong,
                      label: Text(item.badge > 99 ? '99+' : '${item.badge}'),
                      child: icon,
                    )
                  else
                    icon,
                  const SizedBox(height: 3),
                  Text(
                    item.label,
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.visible,
                    style: text.captionStrong.copyWith(color: color),
                    textScaler: cappedScaler(context, MachvonV2Type.navLabelScaleCap),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
