import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../l10n/app_strings.dart';
import '../state/status_banners.dart';
import '../widgets/bottom_nav.dart';
import 'route_catalogue.dart';
import 'tab_badges.dart';

const Map<AppTab, IconData> _icons = <AppTab, IconData>{
  AppTab.home: Icons.home_outlined,
  AppTab.projects: Icons.apartment_outlined,
  AppTab.approval: Icons.fact_check_outlined,
  AppTab.inbox: Icons.notifications_outlined,
  AppTab.account: Icons.person_outline,
};

const Map<AppTab, IconData> _selectedIcons = <AppTab, IconData>{AppTab.home: Icons.home, AppTab.projects: Icons.apartment, AppTab.approval: Icons.fact_check, AppTab.inbox: Icons.notifications, AppTab.account: Icons.person};

/// The frame of the five tabs: the status banners on top, the active tab, the bottom navigation.
///
/// Every tab keeps its own navigation stack and stays mounted while another tab is open, so going back to a tab (or
/// popping a detail screen) finds the scroll position and the filter where they were left. The system back button pops
/// the screen of the tab first; on the root of another tab it goes to Home, and only on the Home root does it leave.
class AppShell extends ConsumerWidget {
  const AppShell({required this.navigationShell, this.detail = false, super.key});

  final StatefulNavigationShell navigationShell;

  /// The screen on top is the screen of ONE record (its address names the record): a detail screen has its own action bar at the bottom and
  /// hides the five tabs (design-system-v2, section 7), so the bar of actions is the only thing under the thumb and nothing sits below it.
  final bool detail;

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
        // The bottom navigation of the phone design: 64 high, the labels always shown, a bar at the top of the chosen tab, a count in a pill.
        bottomNavigationBar: detail
            ? null
            : AppBottomNav(
                selectedIndex: navigationShell.currentIndex,
                onSelected: (int index) => navigationShell.goBranch(index, initialLocation: index == navigationShell.currentIndex),
                items: <NavItem>[
                  for (final AppTab tab in AppTab.values)
                    NavItem(
                      icon: _icons[tab]!,
                      selectedIcon: _selectedIcons[tab]!,
                      label: _labelOf(context, tab),
                      badge: badges[tab] ?? 0,
                      badgeHint: (badges[tab] ?? 0) > 0 ? context.t('mob.shell.badge.pending', <String, Object>{'count': badges[tab]!}) : null,
                    ),
                ],
              ),
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
