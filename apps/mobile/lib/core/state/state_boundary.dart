import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show networkErrorCode;

import '../api/problem.dart';
import '../l10n/app_strings.dart';
import 'empty_state_view.dart';
import 'problem_state_view.dart';
import 'screen_state.dart';
import 'state_card.dart';

/// Shows a screen in its standard state: the content in the default state, the skeleton while loading, the empty card
/// when there is nothing, and the problem card for an error, denied access, an expired licence, an ended session or no
/// connection. The same eight states as the web `StateBoundary`.
///
/// The content is kept mounted, only hidden, behind every other state (unless [keepContent] is false), so what the user
/// typed in a form survives an error and a retry. A screen that cannot build its content before its data arrives passes
/// `keepContent: false`.
class StateBoundary extends StatelessWidget {
  const StateBoundary({
    required this.state,
    required this.child,
    this.problem,
    this.onRetry,
    this.activeFilters = const <String>[],
    this.onClearFilters,
    this.keepContent = true,
    super.key,
  });

  final ScreenState state;
  final Widget child;

  /// The failure behind an error, denied, expired, signed-out or offline state; without it a generic one is shown.
  final ProblemView? problem;
  final VoidCallback? onRetry;
  final List<String> activeFilters;
  final VoidCallback? onClearFilters;

  final bool keepContent;

  @override
  Widget build(BuildContext context) {
    if (!keepContent) return state == ScreenState.defaultState ? child : _message(context);
    // The structure is the same in every state, so the content keeps its State while a message is shown over it.
    final bool showsMessage = state != ScreenState.defaultState;
    return Stack(
      children: <Widget>[
        Offstage(offstage: showsMessage, child: TickerMode(enabled: !showsMessage, child: child)),
        if (showsMessage) _message(context),
      ],
    );
  }

  Widget _message(BuildContext context) {
    switch (state) {
      case ScreenState.defaultState:
        return child;
      case ScreenState.loading:
        return LoadingView(label: context.t('mob.states.loading.label'));
      case ScreenState.empty:
        return EmptyStateView(activeFilters: activeFilters, onClearFilters: onClearFilters);
      case ScreenState.error:
      case ScreenState.denied:
      case ScreenState.expired:
      case ScreenState.signedOut:
      case ScreenState.offline:
        return ProblemStateView(problem: problem ?? _generic(state), onRetry: onRetry);
    }
  }

  ProblemView _generic(ScreenState state) =>
      ProblemView(state: state, code: state == ScreenState.offline ? networkErrorCode : clientErrorCode);
}
