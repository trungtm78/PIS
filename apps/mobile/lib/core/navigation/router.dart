import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../api/problem.dart';
import '../l10n/app_strings.dart';
import '../security/device_integrity.dart' show IntegrityRestriction;
import '../security/integrity_gate.dart';
import '../security/secure_screen.dart';
import '../session/session.dart';
import '../state/problem_state_view.dart';
import '../state/screen_state.dart';
import 'app_shell.dart';
import 'deep_link_guard.dart';
import 'feature.dart';
import 'not_implemented_screen.dart';
import 'route_catalogue.dart';
import 'route_policy.dart';
import 'route_table.dart';

/// The location the application opens on.
const String homeLocation = '/home';

/// The code shown when a location matches no screen.
const String routeNotFoundCode = 'ROUTE_NOT_FOUND';

/// Builds the router from the route table: the five tabs as one shell with a navigation stack per tab, the public
/// screens outside it, and the deep-link guard in front of every location.
GoRouter buildRouter({
  required RouteTable table,
  required DeepLinkGuard guard,
  required SessionSnapshot Function() session,
  required Listenable refreshListenable,
  String initialLocation = homeLocation,
}) {
  Widget screenOf(MobileRoute route, BuildContext context, GoRouterState state) {
    final ScreenSpec? spec = table.implementations[route.id];
    if (spec == null) return NotImplementedScreen(route: route);
    Widget screen = spec.builder(context, ScreenContext.fromState(route.id, state));
    final IntegrityRestriction? restriction = kIntegrityRestrictedScreens[route.id];
    if (restriction != null) screen = IntegrityStepUp(restriction: restriction, child: screen);
    return kSecureScreenIds.contains(route.id) ? SecureScreen(child: screen) : screen;
  }

  GoRoute routeOf(MobileRoute route, String path, {List<RouteBase> routes = const <RouteBase>[]}) => GoRoute(
        path: path,
        name: route.id,
        builder: (BuildContext context, GoRouterState state) => screenOf(route, context, state),
        routes: routes,
      );

  String suffixOf(MobileRoute route) => table.implementations[route.id]?.pathSuffix ?? '';

  return GoRouter(
    initialLocation: initialLocation,
    refreshListenable: refreshListenable,
    redirect: (BuildContext context, GoRouterState state) => guard.redirectFor(state.uri, session()),
    errorBuilder: (BuildContext context, GoRouterState state) => const _RouteNotFound(),
    routes: <RouteBase>[
      for (final MobileRoute route in table.outsideShell) routeOf(route, '/${route.segment}${suffixOf(route)}'),
      StatefulShellRoute.indexedStack(
        builder: (BuildContext context, GoRouterState state, StatefulNavigationShell shell) => AppShell(navigationShell: shell),
        branches: <StatefulShellBranch>[
          for (final AppTab tab in AppTab.values)
            StatefulShellBranch(
              routes: <RouteBase>[
                routeOf(
                  table.rootOf(tab)!,
                  '/${tab.name}',
                  routes: <RouteBase>[
                    for (final MobileRoute child in table.childrenOf(tab)) routeOf(child, '${child.segment}${suffixOf(child)}'),
                  ],
                ),
              ],
            ),
        ],
      ),
    ],
  );
}

class _RouteNotFound extends StatelessWidget {
  const _RouteNotFound();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.route.notFound.title'))),
      body: SafeArea(
        child: ProblemStateView(
          problem: const ProblemView(state: ScreenState.error, code: routeNotFoundCode),
          onRetry: () => context.go(homeLocation),
        ),
      ),
    );
  }
}
