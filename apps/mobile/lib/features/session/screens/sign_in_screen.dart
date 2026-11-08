import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/deep_link_guard.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/router.dart' show homeLocation;
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/widgets/brand_logo.dart';
import '../auth/auth_service.dart';
import '../auth/oidc_client.dart';
import '../flow.dart';
import '../session_providers.dart';

final NotifierProvider<FlowNotifier, FlowState> signInFlowProvider = NotifierProvider.autoDispose<FlowNotifier, FlowState>(FlowNotifier.new);

/// MOB-02: sign in through the system browser (Authorization Code with PKCE). The screen only starts the flow and shows how
/// it went; the password and the second factor are typed in the browser of the system, never here. With `unlock=1` (the
/// biometric lock of a stored session) it offers the unlock first.
Widget buildSignInScreen(BuildContext context, ScreenContext screen) =>
    SignInScreen(returnTo: safeReturnLocation(screen.queryParameters[returnParameter]), unlock: screen.queryParameters[unlockParameter] == '1');

class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({required this.returnTo, required this.unlock, super.key});

  final String? returnTo;
  final bool unlock;

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends ConsumerState<SignInScreen> {
  bool _cancelled = false;
  bool _unlockFailed = false;

  OidcConfig? get _config => ref.read(oidcConfigProvider) ?? ref.read(authServiceProvider).config;

  @override
  void initState() {
    super.initState();
    // No tenant is known yet: tenant discovery (MOB-01) comes first.
    WidgetsBinding.instance.addPostFrameCallback((Duration _) {
      if (mounted && _config == null && !widget.unlock) {
        context.go(withReturn(ref.read(routeTableProvider).locationOf('MOB-01'), widget.returnTo));
      }
    });
  }

  Future<void> _signIn() async {
    final OidcConfig? config = _config;
    if (config == null) return;
    setState(() => _cancelled = false);
    final SignInOutcome? outcome = await ref.read(signInFlowProvider.notifier).run(() => ref.read(authServiceProvider).signIn(config));
    if (!mounted) return;
    if (outcome == null) {
      setState(() => _cancelled = ref.read(signInFlowProvider).problem == null);
      return;
    }
    _continue(outcome);
  }

  Future<void> _unlock() async {
    final String reason = context.t('mob.signIn.unlock.reason');
    setState(() => _unlockFailed = false);
    final bool? unlocked = await ref.read(signInFlowProvider.notifier).run(() => ref.read(authServiceProvider).unlock(reason: reason));
    if (!mounted) return;
    if (unlocked == true) {
      context.go(widget.returnTo ?? homeLocation);
    } else {
      setState(() => _unlockFailed = true);
    }
  }

  void _continue(SignInOutcome outcome) {
    final table = ref.read(routeTableProvider);
    switch (outcome) {
      case SignInOutcome.signedIn:
        context.go(widget.returnTo ?? homeLocation);
      case SignInOutcome.needsSelection:
        context.go(withReturn(table.locationOf('MOB-04'), widget.returnTo));
      case SignInOutcome.needsSecondFactor:
        context.go(withReturn(table.locationOf('MOB-03'), widget.returnTo));
    }
  }

  @override
  Widget build(BuildContext context) {
    final FlowState flow = ref.watch(signInFlowProvider);
    final OidcConfig? config = _config;
    return AuthPage(
      child: StateBoundary(
        state: flow.state,
        problem: flow.problem,
        onRetry: flow.state == ScreenState.loading ? null : (widget.unlock ? _unlock : _signIn),
        // A scrolling column rather than a lazy list: every control is built at once, so the sign-in button is reachable
        // (and found by assistive technology) at 200 percent text on a small phone.
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const BrandHeader(),
              const SizedBox(height: MachvonSpace.space24),
              Semantics(header: true, child: Text(context.t('mob.signIn.title.text'), style: Theme.of(context).textTheme.headlineSmall)),
              const SizedBox(height: MachvonSpace.space12),
              Text(context.t('mob.signIn.body.text')),
              const SizedBox(height: MachvonSpace.space24),
              if (config != null) ...<Widget>[
                Text(context.t('mob.signIn.tenant.label'), style: Theme.of(context).textTheme.labelMedium),
                Text(config.issuer.host),
                const SizedBox(height: MachvonSpace.space8),
              ],
              if (widget.unlock) ...<Widget>[
                Text(context.t('mob.signIn.unlock.title'), style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: MachvonSpace.space8),
                Text(context.t('mob.signIn.unlock.body')),
                const SizedBox(height: MachvonSpace.space12),
                FilledButton(onPressed: _unlock, child: Text(context.t('mob.signIn.unlock.action'))),
                if (_unlockFailed) ...<Widget>[
                  const SizedBox(height: MachvonSpace.space8),
                  Semantics(liveRegion: true, child: Text(context.t('mob.signIn.unlock.failed'))),
                ],
                const SizedBox(height: MachvonSpace.space16),
              ],
              if (_cancelled) ...<Widget>[
                Semantics(liveRegion: true, child: Text(context.t('mob.signIn.cancelled.hint'))),
                const SizedBox(height: MachvonSpace.space12),
              ],
              FilledButton(onPressed: config == null ? null : _signIn, child: Text(context.t('mob.signIn.submit.action'))),
              const SizedBox(height: MachvonSpace.space8),
              OutlinedButton(
                onPressed: () => context.go(withReturn(ref.read(routeTableProvider).locationOf('MOB-01'), widget.returnTo)),
                child: Text(context.t('mob.signIn.tenantChange.action')),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
