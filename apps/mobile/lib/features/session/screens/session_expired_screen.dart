import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/deep_link_guard.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/router.dart' show homeLocation;
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/state/state_card.dart';
import '../../../core/sync/sync_status.dart';
import '../../../core/theme/typography.dart';
import '../auth/auth_service.dart';
import '../auth/oidc_client.dart';
import '../flow.dart';
import '../session_providers.dart';

final NotifierProvider<FlowNotifier, FlowState> reSignInFlowProvider =
    NotifierProvider.autoDispose<FlowNotifier, FlowState>(FlowNotifier.new);

/// MOB-44: the session ended (idle, absolute lifetime, a refresh token that was used twice, a revoked device). The server
/// answered 401 `SESSION_EXPIRED`; the screen shows that code, says that the unsent drafts stay on the phone locked, and signs
/// in again. Signing out is not offered here: nothing on the phone is deleted by a session that ended.
Widget buildSessionExpiredScreen(BuildContext context, ScreenContext screen) =>
    SessionExpiredScreen(returnTo: safeReturnLocation(screen.queryParameters[returnParameter]));

class SessionExpiredScreen extends ConsumerWidget {
  const SessionExpiredScreen({required this.returnTo, super.key});

  final String? returnTo;

  Future<void> _signIn(BuildContext context, WidgetRef ref) async {
    final OidcConfig? config = ref.read(oidcConfigProvider) ?? ref.read(authServiceProvider).config;
    if (config == null) {
      context.go(ref.read(routeTableProvider).locationOf('MOB-01'));
      return;
    }
    final SignInOutcome? outcome = await ref.read(reSignInFlowProvider.notifier).run(() => ref.read(authServiceProvider).signIn(config));
    if (outcome == null || !context.mounted) return;
    switch (outcome) {
      case SignInOutcome.signedIn:
        context.go(returnTo ?? homeLocation);
      case SignInOutcome.needsSelection:
        context.go(withReturn(ref.read(routeTableProvider).locationOf('MOB-04'), returnTo));
      case SignInOutcome.needsSecondFactor:
        context.go(withReturn(ref.read(routeTableProvider).locationOf('MOB-03'), returnTo));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final FlowState flow = ref.watch(reSignInFlowProvider);
    final int pending = ref.watch(syncStatusProvider).pendingCommands;
    final String drafts = pending == 0
        ? context.t('mob.expired.drafts.none')
        : context.t('mob.expired.drafts.some', <String, Object>{'count': pending});
    final String code = context.t('mob.expired.code.label', <String, Object>{'code': 'SESSION_EXPIRED'});
    return AuthPage(
      child: StateBoundary(
        state: flow.state,
        problem: flow.problem,
        onRetry: flow.state == ScreenState.loading ? null : () => _signIn(context, ref),
        child: StateCard(
          icon: Icons.lock_clock_outlined,
          title: context.t('mob.expired.title.text'),
          body: context.t('mob.expired.body.text'),
          announcement: '${context.t('mob.expired.title.text')}. ${context.t('mob.expired.body.text')} $code. $drafts',
          details: <Widget>[
            Text(code, textAlign: TextAlign.center, style: context.v2text.label),
            Text(drafts, textAlign: TextAlign.center, style: context.v2text.body),
          ],
          actions: <Widget>[
            FilledButton(onPressed: () => _signIn(context, ref), child: Text(context.t('mob.expired.submit.action'))),
          ],
        ),
      ),
    );
  }
}
