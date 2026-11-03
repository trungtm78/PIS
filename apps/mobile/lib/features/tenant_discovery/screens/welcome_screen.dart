import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/deep_link_guard.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../session/auth/session_vault.dart';
import '../../session/flow.dart';
import '../../session/session_providers.dart';
import '../published_theme.dart';
import '../tenant_directory.dart';
import '../theme_providers.dart';

final NotifierProvider<FlowNotifier, FlowState> lookupFlowProvider = NotifierProvider.autoDispose<FlowNotifier, FlowState>(FlowNotifier.new);

/// The device-wide limit of lookups, kept for the life of the application.
final Provider<LookupThrottle> lookupThrottleProvider = Provider<LookupThrottle>((Ref ref) => LookupThrottle(now: ref.watch(sessionClockProvider)));

/// What a lookup came to, for the screen: a tenant, a uniform "not found", or a wait.
typedef _Lookup = ({TenantDiscovery? found, bool notFound, Duration? wait});

/// MOB-01: the welcome screen. The person enters the code or the domain of their organisation; the application loads the
/// identity provider and the published theme of that tenant, applies the theme, and goes on to sign-in. A code that finds
/// nothing gets one answer, whatever the reason, so the screen never says whether a tenant exists.
Widget buildWelcomeScreen(BuildContext context, ScreenContext screen) =>
    WelcomeScreen(returnTo: safeReturnLocation(screen.queryParameters[returnParameter]));

class WelcomeScreen extends ConsumerStatefulWidget {
  const WelcomeScreen({required this.returnTo, super.key});

  final String? returnTo;

  @override
  ConsumerState<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends ConsumerState<WelcomeScreen> {
  final TextEditingController _controller = TextEditingController();
  Timer? _waitTimer;
  bool _invalid = false;
  bool _notFound = false;
  Duration? _wait;
  String? _lastCode;

  @override
  void initState() {
    super.initState();
    unawaited(_loadHint());
  }

  @override
  void dispose() {
    _waitTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  Future<void> _loadHint() async {
    final LastContext? last = await ref.read(sessionVaultProvider).loadLast();
    if (mounted && last?.tenantCode != null) setState(() => _lastCode = last!.tenantCode);
  }

  void _waitFor(Duration duration) {
    _waitTimer?.cancel();
    setState(() {
      _wait = duration;
      _notFound = false;
      _invalid = false;
    });
    _waitTimer = Timer(duration, () {
      if (mounted) setState(() => _wait = null);
    });
  }

  Future<void> _submit() async {
    final String? query = normalizeTenantInput(_controller.text);
    if (query == null) {
      setState(() {
        _invalid = true;
        _notFound = false;
      });
      return;
    }
    final LookupThrottle throttle = ref.read(lookupThrottleProvider);
    final Duration? blocked = throttle.waitTime();
    if (blocked != null) {
      _waitFor(blocked);
      return;
    }
    throttle.record();
    setState(() {
      _invalid = false;
      _notFound = false;
      _wait = null;
    });
    final _Lookup? result = await ref.read(lookupFlowProvider.notifier).run<_Lookup>(() async {
      try {
        return (found: await ref.read(tenantDirectoryProvider).lookup(query), notFound: false, wait: null);
      } on TenantNotFound {
        return (found: null, notFound: true, wait: null);
      } on TenantLookupRateLimited catch (limited) {
        return (found: null, notFound: false, wait: limited.retryAfter);
      }
    });
    if (result == null || !mounted) return;
    if (result.wait != null) {
      _waitFor(result.wait!);
    } else if (result.notFound) {
      setState(() => _notFound = true);
    } else {
      await _enter(result.found!);
    }
  }

  Future<void> _enter(TenantDiscovery found) async {
    ref.read(oidcConfigProvider.notifier).choose(found.oidc);
    final SessionVault vault = ref.read(sessionVaultProvider);
    final LastContext? last = await vault.loadLast();
    await vault.saveLast((last ?? const LastContext()).copyWith(config: found.oidc, tenantCode: found.code));
    final PublishedTheme? theme = found.theme;
    if (theme != null) await ref.read(tenantThemeServiceProvider).apply(theme, tenantId: theme.tenantId);
    if (!mounted) return;
    final String signIn = ref.read(routeTableProvider).locationOf('MOB-02');
    context.go(withReturn(signIn, widget.returnTo));
  }

  @override
  Widget build(BuildContext context) {
    final FlowState flow = ref.watch(lookupFlowProvider);
    final ThemeData theme = Theme.of(context);
    final String? message = _invalid
        ? context.t('mob.welcome.invalid.text')
        : _notFound
            ? context.t('mob.welcome.notFound.text')
            : _wait != null
                ? context.t('mob.welcome.rateLimited.text', <String, Object>{'seconds': _wait!.inSeconds + 1})
                : null;
    return AuthPage(
      child: StateBoundary(
        state: flow.state,
        problem: flow.problem,
        onRetry: flow.state == ScreenState.loading ? null : _submit,
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space24),
          children: <Widget>[
            Semantics(
              label: context.t('mob.welcome.logo.label'),
              image: true,
              child: ExcludeSemantics(child: Icon(Icons.account_balance_outlined, size: MachvonSpace.space48, color: theme.colorScheme.primary)),
            ),
            const SizedBox(height: MachvonSpace.space16),
            Semantics(header: true, child: Text(context.t('mob.welcome.title.text'), style: theme.textTheme.headlineSmall)),
            const SizedBox(height: MachvonSpace.space12),
            Text(context.t('mob.welcome.body.text')),
            const SizedBox(height: MachvonSpace.space24),
            TextField(
              controller: _controller,
              keyboardType: TextInputType.url,
              textInputAction: TextInputAction.go,
              autocorrect: false,
              enableSuggestions: false,
              maxLength: 253,
              onSubmitted: (String _) => _submit(),
              onChanged: (String _) {
                if (_invalid || _notFound) {
                  setState(() {
                    _invalid = false;
                    _notFound = false;
                  });
                }
              },
              decoration: InputDecoration(
                labelText: context.t('mob.welcome.field.label'),
                hintText: context.t('mob.welcome.field.hint'),
                errorText: message,
                helperText: context.t('mob.welcome.domain.label'),
                counterText: '',
              ),
            ),
            if (_lastCode != null) ...<Widget>[
              const SizedBox(height: MachvonSpace.space8),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: ActionChip(
                  label: Text(context.t('mob.welcome.last.action', <String, Object>{'code': _lastCode!})),
                  onPressed: () {
                    _controller.text = _lastCode!;
                    unawaited(_submit());
                  },
                ),
              ),
            ],
            const SizedBox(height: MachvonSpace.space16),
            FilledButton(onPressed: _wait == null ? _submit : null, child: Text(context.t('mob.welcome.submit.action'))),
          ],
        ),
      ),
    );
  }
}
