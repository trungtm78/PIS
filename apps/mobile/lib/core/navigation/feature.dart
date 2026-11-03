import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import '../l10n/string_table.dart';
import '../offline/drafts/conflict_adapter.dart' show ConflictAdapter;
import 'deep_link_guard.dart' show LocationRule;

/// What a screen builder receives: the parameters of the location it was opened with.
final class ScreenContext {
  const ScreenContext({
    required this.screenId,
    this.pathParameters = const <String, String>{},
    this.queryParameters = const <String, String>{},
    this.extra,
  });

  factory ScreenContext.fromState(String screenId, GoRouterState state) => ScreenContext(
        screenId: screenId,
        pathParameters: state.pathParameters,
        queryParameters: state.uri.queryParameters,
        extra: state.extra,
      );

  final String screenId;

  /// The values of the `:name` segments of [ScreenSpec.pathSuffix].
  final Map<String, String> pathParameters;
  final Map<String, String> queryParameters;

  /// An object passed in memory by the code that navigated here; it does not survive a restart, so a screen must be
  /// able to open from its path parameters alone.
  final Object? extra;
}

typedef ScreenBuilder = Widget Function(BuildContext context, ScreenContext screen);

/// The implementation of one screen of the catalogue (`MOB-52`).
///
/// The path, the tab and the requirement of the screen come from the generated route table, never from the feature;
/// a feature only says which screen id it implements and how to build it.
final class ScreenSpec {
  const ScreenSpec({required this.screenId, required this.builder, this.pathSuffix = ''});

  /// A screen id of `mobile_routes.generated.dart`; an unknown id fails when the router is built.
  final String screenId;
  final ScreenBuilder builder;

  /// Path parameters appended to the path of the screen (`/:projectId`). Not allowed on a tab root.
  final String pathSuffix;
}

/// One feature of the application: the screens of a story together with their strings. A feature is the unit a story
/// adds without editing a shared file: it lives in `lib/features/<name>/<name>_feature.dart` and is declared there as
/// the top-level `feature` that `tool/generate_registry.dart` lists.
final class MobileFeature {
  const MobileFeature({
    required this.id,
    this.screens = const <ScreenSpec>[],
    this.strings,
    this.locationRules = const <LocationRule>[],
    this.conflictAdapters = const <String, ConflictAdapter>{},
  });

  /// The directory name of the feature.
  final String id;
  final List<ScreenSpec> screens;

  /// The strings of the feature; its keys start with the module prefix, both languages carry the same keys.
  final StringTable? strings;

  /// Rules added to the deep-link guard (see [LocationRule]); applied after the session guard has let the location through.
  final List<LocationRule> locationRules;

  /// How a command of this feature that came back in conflict finds the server's copy of its record (MOB-42), by command type. The
  /// queue and the conflict screen know nothing about the shape of a diary or a measurement; the feature that queues the command does.
  final Map<String, ConflictAdapter> conflictAdapters;
}
