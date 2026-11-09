import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart'
    show UserProfileResponse;
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../permissions/permission_providers.dart';
import '../../permissions/permission_service.dart';
import '../../read_support/widgets.dart' show MachvonTone, StatusPill;
import '../../release/app_info.dart';
import '../../session/auth/auth_service.dart';
import '../../session/auth/identity_api.dart';
import '../../session/membership_label.dart';
import '../../session/session_providers.dart';
import '../account_providers.dart';

/// MOB-47: the account. Who is signed in and to which organisation and role, the language, the biometric unlock, the state of
/// push notifications, and the way to the tenant switch, the devices and the help.
Widget buildAccountScreen(BuildContext context, ScreenContext screen) =>
    const AccountScreen();

final FutureProvider<PermissionState> _pushStateProvider =
    FutureProvider.autoDispose<PermissionState>(
      (Ref ref) => ref
          .watch(permissionServiceProvider)
          .status(AppPermission.notifications),
    );

final FutureProvider<bool> _biometricEnabledProvider =
    FutureProvider.autoDispose<bool>(
      (Ref ref) => ref.watch(authServiceProvider).biometricUnlockEnabled(),
    );

class AccountScreen extends ConsumerStatefulWidget {
  const AccountScreen({super.key});

  @override
  ConsumerState<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends ConsumerState<AccountScreen> {
  bool _biometricFailed = false;
  bool _biometricUnavailable = false;

  Future<void> _setBiometric(bool enabled) async {
    final AuthService service = ref.read(authServiceProvider);
    final String reason = context.t('mob.account.biometric.reason');
    final bool available = await service.biometricAvailable();
    if (!mounted) return;
    if (enabled && !available) {
      setState(() => _biometricUnavailable = true);
      return;
    }
    final bool done = await service.setBiometricUnlock(
      enabled: enabled,
      reason: reason,
    );
    if (!mounted) return;
    setState(() {
      _biometricUnavailable = false;
      _biometricFailed = !done;
    });
    ref.invalidate(_biometricEnabledProvider);
  }

  @override
  Widget build(BuildContext context) {
    final SessionSnapshot session = ref.watch(sessionProvider);
    final AsyncValue<UserProfileResponse> profile = ref.watch(
      myProfileProvider,
    );
    final AsyncValue<List<MembershipChoice>> memberships = ref.watch(
      myMembershipsProvider,
    );
    final AsyncValue<bool> biometric = ref.watch(_biometricEnabledProvider);
    final AsyncValue<PermissionState> push = ref.watch(_pushStateProvider);
    final AsyncValue<AppInfo> info = ref.watch(appInfoProvider);
    final Reachability reachability = ref.watch(reachabilityProvider);
    final ({ScreenState state, ProblemView? problem}) shown = stateOfAsync(
      profile,
      reachability,
    );
    final MembershipChoice? current = memberships.asData?.value
        .where((MembershipChoice m) => isCurrentMembership(m, session))
        .firstOrNull;
    final ThemeData theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.account.title.text'))),
      body: SafeArea(
        child: StateBoundary(
          state: shown.state,
          problem: shown.problem,
          onRetry: () {
            ref.invalidate(myProfileProvider);
            ref.invalidate(myMembershipsProvider);
          },
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (profile.asData != null) ...<Widget>[
                  Semantics(
                    header: true,
                    child: Text(
                      profile.requireValue.displayName,
                      style: theme.textTheme.titleLarge,
                    ),
                  ),
                  if (profile.requireValue.emailMasked != null)
                    Text(
                      context.t('mob.account.email.label', <String, Object>{
                        'email': profile.requireValue.emailMasked!,
                      }),
                    ),
                  const SizedBox(height: MachvonSpace.space12),
                ],
                Text(
                  context.t('mob.account.tenant.label'),
                  style: theme.textTheme.labelMedium,
                ),
                Text(
                  current?.tenantName ?? session.tenantId ?? '',
                  style: theme.textTheme.titleMedium,
                ),
                if (current != null)
                  Text(
                    context.t('mob.account.role.label', <String, Object>{
                      'role': membershipTypeLabel(context, current.membershipType),
                    }),
                  ),
                if (session.isReadOnly) ...<Widget>[
                  const SizedBox(height: MachvonSpace.space8),
                  Semantics(
                    liveRegion: true,
                    child: Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: StatusPill(
                        label: context.t('mob.account.readOnly.text'),
                        tone: MachvonTone.warning,
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: MachvonSpace.space16),
                _Row(
                  icon: Icons.swap_horiz,
                  label: context.t('mob.account.switch.action'),
                  onTap: () => context.push(
                    ref.read(routeTableProvider).locationOf('MOB-48'),
                  ),
                ),
                _Row(
                  icon: Icons.devices_other_outlined,
                  label: context.t('mob.account.devices.action'),
                  onTap: () => context.push(
                    ref.read(routeTableProvider).locationOf('MOB-49'),
                  ),
                ),
                _Row(
                  icon: Icons.outbox_outlined,
                  label: context.t('mob.account.queue.action'),
                  onTap: () => context.go(
                    ref.read(routeTableProvider).locationOf('MOB-41'),
                  ),
                ),
                _Row(
                  icon: Icons.cloud_sync_outlined,
                  label: context.t('mob.account.offline.action'),
                  onTap: () => context.go(
                    ref.read(routeTableProvider).locationOf('MOB-43'),
                  ),
                ),
                _Row(
                  icon: Icons.search,
                  label: context.t('mob.srch.open.action'),
                  onTap: () => context.push(
                    ref.read(routeTableProvider).locationOf('MOB-51'),
                  ),
                ),
                _Row(
                  icon: Icons.swap_horiz_outlined,
                  label: context.t('mob.reads.entry.delegations'),
                  onTap: () => context.push(
                    ref.read(routeTableProvider).locationOf('MOB-75'),
                  ),
                ),
                _Row(
                  icon: Icons.fact_check_outlined,
                  label: context.t('mob.reads.entry.kpi'),
                  onTap: () => context.push(
                    ref.read(routeTableProvider).locationOf('MOB-76'),
                  ),
                ),
                _Row(
                  icon: Icons.description_outlined,
                  label: context.t('mob.reads.entry.reports'),
                  onTap: () => context.push(
                    ref.read(routeTableProvider).locationOf('MOB-77'),
                  ),
                ),
                _Row(
                  icon: Icons.help_outline,
                  label: context.t('mob.account.help.action'),
                  onTap: () => context.push(
                    ref.read(routeTableProvider).locationOf('MOB-50'),
                  ),
                ),
                const Divider(),
                Text(
                  context.t('mob.account.language.label'),
                  style: theme.textTheme.labelMedium,
                ),
                RadioGroup<String>(
                  groupValue: ref.watch(localeProvider).languageCode,
                  onChanged: (String? code) {
                    if (code != null)
                      ref.read(localeProvider.notifier).select(Locale(code));
                  },
                  child: Column(
                    children: <Widget>[
                      RadioListTile<String>(
                        value: 'vi',
                        title: Text(context.t('mob.account.language.vi')),
                      ),
                      RadioListTile<String>(
                        value: 'en',
                        title: Text(context.t('mob.account.language.en')),
                      ),
                    ],
                  ),
                ),
                const Divider(),
                SwitchListTile(
                  title: Text(context.t('mob.account.biometric.title')),
                  subtitle: Text(context.t('mob.account.biometric.body')),
                  value: biometric.asData?.value ?? false,
                  onChanged: biometric.isLoading ? null : _setBiometric,
                ),
                if (_biometricUnavailable)
                  Semantics(
                    liveRegion: true,
                    child: Text(context.t('mob.account.biometric.unavailable')),
                  ),
                if (_biometricFailed)
                  Semantics(
                    liveRegion: true,
                    child: Text(context.t('mob.account.biometric.failed')),
                  ),
                const Divider(),
                ListTile(
                  title: Text(context.t('mob.account.push.title')),
                  subtitle: Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: StatusPill(
                      label: _pushText(context, push.asData?.value),
                      tone: push.asData?.value == PermissionState.granted
                          ? MachvonTone.success
                          : MachvonTone.neutral,
                    ),
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push(
                    ref.read(routeTableProvider).locationOf('MOB-05'),
                  ),
                ),
                const Divider(),
                if (info.asData != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      vertical: MachvonSpace.space8,
                    ),
                    child: Text(
                      context.t('mob.account.version.label', <String, Object>{
                        'version': info.requireValue.full,
                      }),
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _pushText(BuildContext context, PermissionState? state) {
    switch (state) {
      case PermissionState.granted:
        return context.t('mob.account.push.granted');
      case PermissionState.blocked:
        return context.t('mob.account.push.blocked');
      case PermissionState.notAsked:
      case PermissionState.denied:
      case null:
        return context.t('mob.account.push.off');
    }
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon),
      title: Text(label),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}
