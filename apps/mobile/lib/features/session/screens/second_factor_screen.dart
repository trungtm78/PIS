import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/deep_link_guard.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/route_policy.dart' show kSignInScreenId;
import '../../../core/navigation/router.dart' show homeLocation;
import '../../../core/session/session.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/theme/typography.dart';
import '../auth/auth_service.dart';
import '../flow.dart';
import '../session_providers.dart';

final NotifierProvider<FlowNotifier, FlowState> secondFactorFlowProvider =
    NotifierProvider.autoDispose<FlowNotifier, FlowState>(FlowNotifier.new);

/// MOB-03: the second factor. It opens when the server refuses a membership that needs it (sign-in) or answers 403
/// `MFA_REQUIRED` to an action (an approval). The code is typed in the identity provider's page in the system browser (the
/// application asks for `aal2` and refuses an answer that does not prove it); afterwards the membership is selected again
/// with the stronger identity, and the person goes back to what they were doing, where the action is now allowed.
Widget buildSecondFactorScreen(BuildContext context, ScreenContext screen) =>
    SecondFactorScreen(returnTo: safeReturnLocation(screen.queryParameters[returnParameter]));

class SecondFactorScreen extends ConsumerWidget {
  const SecondFactorScreen({required this.returnTo, super.key});

  final String? returnTo;

  Future<void> _verify(BuildContext context, WidgetRef ref) async {
    final SignInOutcome? outcome = await ref.read(secondFactorFlowProvider.notifier).run(() => ref.read(authServiceProvider).stepUp());
    if (outcome == null || !context.mounted) return;
    context.go(outcome == SignInOutcome.needsSelection ? ref.read(routeTableProvider).locationOf('MOB-04') : returnTo ?? homeLocation);
  }

  void _later(BuildContext context, WidgetRef ref) {
    ref.read(authServiceProvider).cancelSecondFactor();
    final bool signedIn = ref.read(sessionProvider).isSignedIn;
    context.go(signedIn ? homeLocation : ref.read(routeTableProvider).locationOf(kSignInScreenId));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final FlowState flow = ref.watch(secondFactorFlowProvider);
    final SessionSnapshot session = ref.watch(sessionProvider);
    final bool needed = ref.read(authServiceProvider).needsSecondFactor || session.stepUpRequired;
    return AuthPage(
      child: StateBoundary(
        state: flow.state,
        problem: flow.problem,
        onRetry: flow.state == ScreenState.loading ? null : () => _verify(context, ref),
        child: needed ? _Challenge(onVerify: () => _verify(context, ref), onLater: () => _later(context, ref)) : _NothingToDo(returnTo: returnTo),
      ),
    );
  }
}

class _Challenge extends StatelessWidget {
  const _Challenge({required this.onVerify, required this.onLater});

  final VoidCallback onVerify;
  final VoidCallback onLater;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s24),
      children: <Widget>[
        AuthHeading(title: context.t('mob.mfa.title.text'), body: context.t('mob.mfa.body.text')),
        const SizedBox(height: MachvonV2Space.s16),
        Text(context.t('mob.mfa.field.label'), style: text.label),
        Text(context.t('mob.mfa.field.hint'), style: text.caption),
        const SizedBox(height: MachvonV2Space.s24),
        FilledButton(onPressed: onVerify, child: Text(context.t('mob.mfa.submit.action'))),
        const SizedBox(height: MachvonV2Space.s8),
        OutlinedButton(onPressed: onLater, child: Text(context.t('mob.mfa.cancel.action'))),
      ],
    );
  }
}

class _NothingToDo extends StatelessWidget {
  const _NothingToDo({required this.returnTo});

  final String? returnTo;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s24),
      children: <Widget>[
        AuthHeading(title: context.t('mob.mfa.done.title'), body: context.t('mob.mfa.done.body')),
        const SizedBox(height: MachvonV2Space.s24),
        FilledButton(onPressed: () => context.go(returnTo ?? homeLocation), child: Text(context.t('mob.mfa.done.action'))),
      ],
    );
  }
}
