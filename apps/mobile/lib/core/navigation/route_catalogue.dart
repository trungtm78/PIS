/// The five tabs of the bottom navigation, in display order. The key is the tab key of `navigation_architecture.json`.
enum AppTab {
  home,
  projects,
  approval,
  inbox,
  account;

  /// The tab with the given key of the navigation architecture, or null.
  static AppTab? byKey(String key) {
    for (final AppTab tab in AppTab.values) {
      if (tab.name == key) return tab;
    }
    return null;
  }
}

/// One screen of the mobile navigation architecture: the identity every later story hangs its implementation on.
///
/// The table of these (`mobile_routes.generated.dart`) is generated from `navigation_architecture.json` and
/// `screen_catalog.json`; a screen is identified by its screen id (`MOB-52`), never by a path or a class name.
final class MobileRoute {
  const MobileRoute({
    required this.id,
    required this.kind,
    required this.requirement,
    this.tab,
    this.isTabRoot = false,
  });

  /// `MOB-52`, or the id of a web module screen that is also shown on the phone (`QMS-09`).
  final String id;

  /// The design kind of the screen (`empty`, `error`, `form`, ...).
  final String kind;

  /// The functional requirement the screen implements (`FR-MOB-52`); the UI test id is `UI-<id>`.
  final String requirement;

  /// The tab the screen belongs to, null for the screens without the bottom navigation (onboarding).
  final AppTab? tab;

  /// The screen is the root of its tab.
  final bool isTabRoot;

  /// The UI test id of the screen (`UI-MOB-52`).
  String get uiTestId => 'UI-$id';

  /// The path segment of the screen: the lower-case id.
  String get segment => id.toLowerCase();
}
