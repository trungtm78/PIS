import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/api/problem.dart';
import '../../core/connectivity/reachability.dart';
import '../../core/navigation/deep_link_guard.dart' show returnParameter;
import '../../core/state/screen_state.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/app_scaffold.dart';
import 'auth/auth_service.dart';
import 'auth/oidc_client.dart';

/// Where one user intention stands: nothing yet, running, or failed (with the failure as the user sees it).
final class FlowState {
  const FlowState({this.state = ScreenState.defaultState, this.problem});

  final ScreenState state;
  final ProblemView? problem;

  bool get busy => state == ScreenState.loading;
}

/// Runs one asynchronous intention of a screen (the sign-in, the second factor, the selection) and keeps its state for the
/// screen: `loading` while it runs, the failure otherwise. A second tap while it runs does nothing.
class FlowNotifier extends Notifier<FlowState> {
  @override
  FlowState build() => const FlowState();

  /// Runs [action]; returns its result, or null when it failed, was already running, or the person cancelled the browser.
  Future<T?> run<T>(Future<T> Function() action) async {
    if (state.busy) return null;
    state = const FlowState(state: ScreenState.loading);
    try {
      final T result = await action();
      state = const FlowState();
      return result;
    } on Object catch (error) {
      final ProblemView? problem = problemOfAuthFailure(error, ref.read(reachabilityProvider));
      state = problem == null ? const FlowState() : FlowState(state: problem.state, problem: problem);
      return null;
    }
  }

  void reset() => state = const FlowState();
}

/// The failure of a sign-in step as the screen shows it: the code, never the text of the provider or the server. The person
/// cancelling the browser is not a failure (null); an unreachable provider is a time-out or no connection; everything the
/// provider refused carries a stable `OIDC_*` code.
ProblemView? problemOfAuthFailure(Object error, Reachability reachability) {
  if (error is OidcException) {
    switch (error.failure) {
      case OidcFailure.browserCancelled:
        return null;
      case OidcFailure.unreachable:
        final bool offline = reachability == Reachability.offline;
        return ProblemView(state: offline ? ScreenState.offline : ScreenState.error, code: networkErrorCode, timedOut: !offline);
      case OidcFailure.discoveryFailed:
      case OidcFailure.browserFailed:
      case OidcFailure.callbackInvalid:
      case OidcFailure.stateMismatch:
      case OidcFailure.providerRefused:
      case OidcFailure.tokenExchangeFailed:
      case OidcFailure.nonceMismatch:
      case OidcFailure.tokenInvalid:
      case OidcFailure.secondFactorNotSatisfied:
      case OidcFailure.refreshRejected:
        return ProblemView(state: ScreenState.error, code: _codeOf(error.failure));
    }
  }
  if (error is NoSession) return const ProblemView(state: ScreenState.signedOut, code: 'SESSION_EXPIRED');
  return ProblemView.from(error, reachability: reachability);
}

String _codeOf(OidcFailure failure) {
  final String snake = failure.name.replaceAllMapped(RegExp('[A-Z]'), (Match match) => '_${match.group(0)}').toUpperCase();
  return 'OIDC_$snake';
}

/// The page every sign-in screen is drawn on: the frame of the phone design without a top bar (these screens carry their own heading), a column
/// no wider than a phone in portrait needs, scrolling so that 200 percent text never overflows.
class AuthPage extends StatelessWidget {
  const AuthPage({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      showTopBar: false,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16), child: child),
        ),
      ),
    );
  }
}

/// The heading of a sign-in screen and the sentence under it: the Title step (held at 1.3 times so it never takes the screen) and the body.
class AuthHeading extends StatelessWidget {
  const AuthHeading({required this.title, this.body, super.key});

  final String title;
  final String? body;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(header: true, child: Text(title, style: text.title, textScaler: cappedScaler(context, MachvonV2Type.titleScaleCap))),
        if (body != null) ...<Widget>[
          const SizedBox(height: MachvonV2Space.s8),
          Text(body!, style: text.body.copyWith(color: context.v2.palette.ink2)),
        ],
      ],
    );
  }
}

/// The return location carried by a screen, when it is safe to open (a path of this application).
String withReturn(String location, String? returnTo) =>
    returnTo == null ? location : Uri(path: location, queryParameters: <String, String>{returnParameter: returnTo}).toString();
