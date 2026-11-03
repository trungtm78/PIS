import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/problem.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/state/problem_state_view.dart';
import '../../../core/state/screen_state.dart';

/// MOB-53: the full-screen service error with its code, the correlation id and retry. The failure arrives in memory as
/// the `extra` of the navigation; a plain open shows a generic error. Retry goes back to the screen that failed, which
/// loads again.
Widget buildErrorStateScreen(BuildContext context, ScreenContext screen) {
  final Object? extra = screen.extra;
  final ProblemView problem = extra is ProblemView ? extra : const ProblemView(state: ScreenState.error, code: clientErrorCode);
  return Scaffold(
    body: SafeArea(
      child: ProblemStateView(
        problem: problem,
        onRetry: context.canPop() ? context.pop : null,
      ),
    ),
  );
}
