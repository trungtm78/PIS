import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'route_catalogue.dart';

/// The number shown on a tab (approvals waiting, unread notifications). Empty until the platform shell exposes the
/// navigation badge counts; the feature that owns the count writes it, the shell only reads it.
class TabBadgeNotifier extends Notifier<Map<AppTab, int>> {
  @override
  Map<AppTab, int> build() => const <AppTab, int>{};

  void set(AppTab tab, int count) => state = <AppTab, int>{...state, tab: count};
}

final NotifierProvider<TabBadgeNotifier, Map<AppTab, int>> tabBadgeProvider =
    NotifierProvider<TabBadgeNotifier, Map<AppTab, int>>(TabBadgeNotifier.new);
