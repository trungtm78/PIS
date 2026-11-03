import 'feature.dart';
import 'route_catalogue.dart';
import 'route_policy.dart';

/// The screens of the catalogue joined with the implementations the features registered, and the locations of both.
///
/// Locations are decided here and nowhere else: a tab root is `/<tab>`, another screen of a tab `/<tab>/<id>`, a public
/// screen `/<id>`, with the id in lower case (`/account/mob-52`, `/mob-02`). Building the table checks the registry, so a
/// wrong registration fails when the application starts and in the registry test, never on a user's phone.
final class RouteTable {
  factory RouteTable({required List<MobileRoute> routes, required List<MobileFeature> features}) {
    final Map<String, MobileRoute> byId = <String, MobileRoute>{};
    for (final MobileRoute route in routes) {
      if (byId.containsKey(route.id)) throw StateError('screen ${route.id} appears twice in the route table');
      byId[route.id] = route;
    }
    final Map<String, ScreenSpec> implementations = <String, ScreenSpec>{};
    final Map<String, String> owner = <String, String>{};
    for (final MobileFeature feature in features) {
      for (final ScreenSpec spec in feature.screens) {
        final MobileRoute? route = byId[spec.screenId];
        if (route == null) throw StateError('feature ${feature.id} implements ${spec.screenId}, which is not a screen of the catalogue');
        if (owner.containsKey(spec.screenId)) {
          throw StateError('screen ${spec.screenId} is implemented by both ${owner[spec.screenId]} and ${feature.id}');
        }
        if (route.isTabRoot && spec.pathSuffix.isNotEmpty) {
          throw StateError('tab root ${spec.screenId} cannot take path parameters');
        }
        if (spec.pathSuffix.isNotEmpty && !spec.pathSuffix.startsWith('/')) {
          throw StateError('the path suffix of ${spec.screenId} must start with /');
        }
        owner[spec.screenId] = feature.id;
        implementations[spec.screenId] = spec;
      }
    }
    final RouteTable table = RouteTable._(byId, implementations);
    for (final AppTab tab in AppTab.values) {
      if (table.rootOf(tab) == null) throw StateError('tab ${tab.name} has no root screen');
    }
    return table;
  }

  RouteTable._(this._byId, this.implementations);

  final Map<String, MobileRoute> _byId;

  /// The registered implementation by screen id; a screen without one shows the not-implemented screen.
  final Map<String, ScreenSpec> implementations;

  Iterable<MobileRoute> get routes => _byId.values;

  MobileRoute? routeOf(String screenId) => _byId[screenId];

  /// The screen shown inside the shell: it has a tab and opens with a session.
  bool inShell(MobileRoute route) => route.tab != null && !isPublicScreen(route.id);

  MobileRoute? rootOf(AppTab tab) {
    for (final MobileRoute route in _byId.values) {
      if (route.tab == tab && route.isTabRoot && inShell(route)) return route;
    }
    return null;
  }

  /// The screens of a tab other than its root.
  Iterable<MobileRoute> childrenOf(AppTab tab) =>
      _byId.values.where((MobileRoute route) => route.tab == tab && !route.isTabRoot && inShell(route));

  Iterable<MobileRoute> get outsideShell => _byId.values.where((MobileRoute route) => !inShell(route));

  /// The location of a screen without path parameters (the one the router registers is longer when it has a suffix).
  String locationOf(String screenId) {
    final MobileRoute route = _byId[screenId]!;
    if (!inShell(route)) return '/${route.segment}';
    if (route.isTabRoot) return '/${route.tab!.name}';
    return '/${route.tab!.name}/${route.segment}';
  }

  /// Whether a location opens without a session: its first segment is a public screen.
  bool isPublicLocation(Uri location) {
    if (location.pathSegments.isEmpty) return false;
    final String first = location.pathSegments.first;
    return kPublicScreenIds.any((String id) => id.toLowerCase() == first);
  }
}
