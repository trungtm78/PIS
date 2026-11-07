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
              Expanded(child: navigationShell),
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
    return Semantics(
      label: context.t('mob.shell.badge.pending', <String, Object>{
        'count': count,
      }),
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
