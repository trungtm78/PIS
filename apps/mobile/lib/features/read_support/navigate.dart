import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/di/providers.dart';

/// The location of a screen by its screen id, with the path parameter and the query it takes. A screen is identified by
/// its id, never by a path written out by hand.
String locationOfScreen(BuildContext context, String screenId, {String pathSuffix = '', Map<String, String> query = const <String, String>{}}) {
  final String base = ProviderScope.containerOf(context).read(routeTableProvider).locationOf(screenId);
  return Uri(path: '$base$pathSuffix', queryParameters: query.isEmpty ? null : query).toString();
}

/// Opens a screen of the same tab. By default it replaces the stack under the tab root (`go`: the list, then this screen); with
/// [stacked] it is pushed on top of the screen that opened it (`push`), so the back button returns to that screen where it was
/// left (a confirmation returns to the detail it was opened from).
void openScreen(BuildContext context, String screenId, {String pathSuffix = '', Map<String, String> query = const <String, String>{}, bool stacked = false}) {
  final String location = locationOfScreen(context, screenId, pathSuffix: pathSuffix, query: query);
  if (stacked) {
    context.push(location);
  } else {
    context.go(location);
  }
}
