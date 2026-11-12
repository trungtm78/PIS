import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../l10n/app_strings.dart';
import '../state/status_banners.dart';
import 'route_catalogue.dart';
import 'tab_badges.dart';

const Map<AppTab, IconData> _icons = <AppTab, IconData>{
  AppTab.home: Icons.home_outlined,
  AppTab.projects: Icons.apartment_outlined,
  AppTab.approval: Icons.fact_check_outlined,
  AppTab.inbox: Icons.notifications_outlined,
  AppTab.account: Icons.person_outline,
};

const Map<AppTab, IconData> _selectedIcons = <AppTab, IconData>{
  AppTab.home: Icons.home,
  AppTab.projects: Icons.apartment,
  AppTab.approval: Icons.fact_check,
  AppTab.inbox: Icons.notifications,
  AppTab.account: Icons.person,
};

/// The frame of the five tabs: the status banners on top, the active tab, the bottom navigation.
///
/// Every tab keeps its own navigation stack and stays mounted while another tab is open, so going back to a tab (or
/// popping a detail screen) finds the scroll position and the filter where they were left. The system back button pops
/// the screen of the tab first; on the root of another tab it goes to Home, and only on the Home root does it leave.
class AppShell extends ConsumerWidget {
  const AppShell({required this.navigationShell, super.key});

  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final Map<AppTab, int> badges = ref.watch(tabBadgeProvider);
    final bool onHome = navigationShell.currentIndex == AppTab.home.index;
    return PopScope(
      canPop: onHome,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (!didPop) navigationShell.goBranch(AppTab.home.index);
      },
      child: Scaffold(
        body: SafeArea(
          bottom: false,
          child: Column(
            children: <Widget>[
              const StatusBanners(),
              // A semantic boundary of its own. Every route of the tabs sits on a modal barrier, and a barrier blocks the
              // semantics of what was painted before it; without a boundary that reaches up to the banners above, so they
              // are drawn but a screen reader never meets them. With the boundary the barrier blocks only inside the tab.
              Expanded(child: Semantics(container: true, explicitChildNodes: true, child: navigationShell)),
            ],
          ),
        ),
        // The bar itself is themed (white, teal selected, danger badges); the 1 px line above it is the only separator.
        bottomNavigationBar: DecoratedBox(
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: MachvonColors.border)),
          ),
          child: NavigationBar(
            selectedIndex: navigationShell.currentIndex,
            onDestinationSelected: (int index) => navigationShell.goBranch(
              index,
              initialLocation: index == navigationShell.currentIndex,
            ),
            destinations: <Widget>[
              for (final AppTab tab in AppTab.values)
                NavigationDestination(
                  icon: _badged(context, tab, badges[tab] ?? 0, _icons[tab]!),
                  selectedIcon: _badged(
                    context,
                    tab,
                    badges[tab] ?? 0,
                    _selectedIcons[tab]!,
                  ),
                  label: _labelOf(context, tab),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _badged(BuildContext context, AppTab tab, int count, IconData icon) {
    if (count <= 0) return Icon(icon);
    // The count is a hint of the tab, not a label: the bar merges the icon, the label and the position of the tab into one
    // node, and a label on the icon came first in it ("10 mục cần xử lý, 10, Thông báo, Tab 4 trong tổng số 5"), so a screen
    // reader and a UI test never met the name on the screen first. A hint is read after the label, and the badge drawn on
    // the icon ("10") is left out of the semantics so the number is not said twice.
    return Semantics(
      hint: context.t('mob.shell.badge.pending', <String, Object>{
        'count': count,
      }),
      excludeSemantics: true,
      child: Badge(
        label: Text(count > 99 ? '99+' : '$count'),
        child: Icon(icon),
      ),
    );
  }

  // Each key is written out so the string check can see it is in use.
  String _labelOf(BuildContext context, AppTab tab) {
    switch (tab) {
      case AppTab.home:
        return context.t('mob.shell.tab.home');
      case AppTab.projects:
        return context.t('mob.shell.tab.projects');
      case AppTab.approval:
        return context.t('mob.shell.tab.approval');
      case AppTab.inbox:
        return context.t('mob.shell.tab.inbox');
      case AppTab.account:
        return context.t('mob.shell.tab.account');
    }
  }
}
