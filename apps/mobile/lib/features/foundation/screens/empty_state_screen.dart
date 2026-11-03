import 'package:flutter/material.dart';

import '../../../core/navigation/feature.dart';
import '../../../core/state/empty_state_view.dart';

/// MOB-52: the full-screen empty state. Screens normally show the empty state inline through `StateBoundary`; this route
/// is for a navigation that ends on an empty result.
Widget buildEmptyStateScreen(BuildContext context, ScreenContext screen) {
  final List<String> filters = screen.queryParameters['filter'] == null ? const <String>[] : <String>[screen.queryParameters['filter']!];
  return Scaffold(body: SafeArea(child: EmptyStateView(activeFilters: filters)));
}
