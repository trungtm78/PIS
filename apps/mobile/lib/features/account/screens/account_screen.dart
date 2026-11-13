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
import '../../../core/theme/theme_mode.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/nav_row.dart';
import '../../../core/widgets/work_row.dart';
import '../../permissions/permission_providers.dart';
import '../../permissions/permission_service.dart';
import '../../read_support/widgets.dart'
    show MachvonTone, ScreenFrame, StatusPill;
import '../../release/app_info.dart';
import '../../session/auth/auth_service.dart';
import '../../session/auth/identity_api.dart';
import '../../session/membership_label.dart';
import '../../session/session_providers.dart';
import '../account_providers.dart';
import '../deadline_preview.dart';
import '../deadline_thresholds.dart';

/// MOB-47: the account tab ("Cá nhân"). Who is signed in and to which organisation and role; the preview of the three deadline bands (the
/// place of the personal thresholds); the look (light, dark or the system's) and the language; the biometric unlock and the state of push
/// notifications; the tools (search, send queue, offline work, delegations, indicators, reports, help); and the way to the organisation
/// switch and the devices.
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
    final ThemeMode themeMode = ref.watch(themeModeProvider);
    final String language = ref.watch(localeProvider).languageCode;
    final MachvonV2Text text = context.v2text;
    String location(String screenId) =>
        ref.read(routeTableProvider).locationOf(screenId);
    final UserProfileResponse? person = profile.asData?.value;
    return ScreenFrame(
      root: true,
      title: context.t('mob.account.title.text'),
      body: StateBoundary(
        state: shown.state,
        problem: shown.problem,
        onRetry: () {
          ref.invalidate(myProfileProvider);
          ref.invalidate(myMembershipsProvider);
        },
        // A short screen of a few groups: one scroll view that builds everything, so a row below the fold is in the tree for a screen reader and a test.
        child: SingleChildScrollView(
          padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  MachvonV2Space.s16,
                  MachvonV2Space.s8,
                  MachvonV2Space.s16,
                  MachvonV2Space.s16,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    if (person != null) ...<Widget>[
                      Semantics(
                        container: true,
                        header: true,
                        child: Text(person.displayName, style: text.title),
                      ),
                      if (person.emailMasked != null)
                        Text(
                          context.t('mob.account.email.label', <String, Object>{
                            'email': person.emailMasked!,
                          }),
                          style: text.caption,
                        ),
                      const SizedBox(height: MachvonV2Space.s12),
                    ],
                    Text(
                      context.t('mob.account.tenant.label'),
                      style: text.caption,
                    ),
                    Text(
                      current?.tenantName ?? session.tenantId ?? '',
                      style: text.bodyStrong,
                    ),
                    if (current != null)
                      Text(
                        context.t('mob.account.role.label', <String, Object>{
                          'role': membershipTypeLabel(
                            context,
                            current.membershipType,
                          ),
                        }),
                        style: text.caption,
                      ),
                    if (session.isReadOnly) ...<Widget>[
                      const SizedBox(height: MachvonV2Space.s8),
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
                  ],
                ),
              ),
              GroupHeader(title: context.t('mob.account.deadline.title')),
              DeadlinePreview(
                thresholds: ref.watch(deadlineThresholdsProvider),
              ),
              NavRow(
                icon: Icons.tune,
                label: context.t('mob.pwf.entry.reminders'),
                onTap: () => context.push(location('MOB-82')),
              ),
              GroupHeader(title: context.t('mob.account.appearance.title')),
              _Choice(
                label: context.t('mob.account.appearance.mode.label'),
                child: FilterChips<ThemeMode>(
                  options: <ChipOption<ThemeMode>>[
                    ChipOption<ThemeMode>(
                      value: ThemeMode.system,
                      label: context.t('mob.account.appearance.mode.system'),
                    ),
                    ChipOption<ThemeMode>(
                      value: ThemeMode.light,
                      label: context.t('mob.account.appearance.mode.light'),
                    ),
                    ChipOption<ThemeMode>(
                      value: ThemeMode.dark,
                      label: context.t('mob.account.appearance.mode.dark'),
                    ),
                  ],
                  selected: themeMode,
                  onChanged: (ThemeMode mode) =>
                      ref.read(themeModeProvider.notifier).select(mode),
                ),
              ),
              _Choice(
                label: context.t('mob.account.language.label'),
                child: FilterChips<String>(
                  options: <ChipOption<String>>[
                    ChipOption<String>(
                      value: 'vi',
                      label: context.t('mob.account.language.vi'),
                    ),
                    ChipOption<String>(
                      value: 'en',
                      label: context.t('mob.account.language.en'),
                    ),
                  ],
                  selected: language,
                  onChanged: (String code) =>
                      ref.read(localeProvider.notifier).select(Locale(code)),
                ),
              ),
              SwitchRow(
                label: context.t('mob.account.biometric.title'),
                help: context.t('mob.account.biometric.body'),
                value: biometric.asData?.value ?? false,
                onChanged: biometric.isLoading ? null : _setBiometric,
                dividerAbove: true,
              ),
              if (_biometricUnavailable)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: MachvonV2Space.s16,
                  ),
                  child: Semantics(
                    liveRegion: true,
                    child: Text(
                      context.t('mob.account.biometric.unavailable'),
                      style: text.caption,
                    ),
                  ),
                ),
              if (_biometricFailed)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: MachvonV2Space.s16,
                  ),
                  child: Semantics(
                    liveRegion: true,
                    child: Text(
                      context.t('mob.account.biometric.failed'),
                      style: text.caption,
                    ),
                  ),
                ),
              NavRow(
                icon: Icons.notifications_active_outlined,
                label: context.t('mob.account.push.title'),
                value: _pushText(context, push.asData?.value),
                dividerAbove: true,
                onTap: () => context.push(location('MOB-05')),
              ),
              GroupHeader(title: context.t('mob.account.tools.title')),
              NavRow(
                icon: Icons.search,
                label: context.t('mob.srch.open.action'),
                onTap: () => context.push(location('MOB-51')),
              ),
              // The send queue and the offline settings belong to this tab (navigation architecture), so `go` keeps the tab selected.
              NavRow(
                icon: Icons.outbox_outlined,
                label: context.t('mob.account.queue.action'),
                dividerAbove: true,
                onTap: () => context.go(location('MOB-41')),
              ),
              NavRow(
                icon: Icons.cloud_sync_outlined,
                label: context.t('mob.account.offline.action'),
                dividerAbove: true,
                onTap: () => context.go(location('MOB-43')),
              ),
              NavRow(
                icon: Icons.swap_horiz_outlined,
                label: context.t('mob.reads.entry.delegations'),
                dividerAbove: true,
                onTap: () => context.push(location('MOB-75')),
              ),
              NavRow(
                icon: Icons.fact_check_outlined,
                label: context.t('mob.reads.entry.kpi'),
                dividerAbove: true,
                onTap: () => context.push(location('MOB-76')),
              ),
              NavRow(
                icon: Icons.event_available_outlined,
                label: context.t('mob.pwf.entry.tasks'),
                dividerAbove: true,
                onTap: () => context.push(location('MOB-80')),
              ),
              NavRow(
                icon: Icons.insights_outlined,
                label: context.t('mob.pwf.entry.score'),
                dividerAbove: true,
                onTap: () => context.push(location('MOB-81')),
              ),
              NavRow(
                icon: Icons.description_outlined,
                label: context.t('mob.reads.entry.reports'),
                dividerAbove: true,
                onTap: () => context.push(location('MOB-77')),
              ),
              NavRow(
                icon: Icons.help_outline,
                label: context.t('mob.account.help.action'),
                dividerAbove: true,
                onTap: () => context.push(location('MOB-50')),
              ),
              GroupHeader(title: context.t('mob.account.organisation.title')),
              NavRow(
                icon: Icons.swap_horiz,
                label: context.t('mob.account.switch.action'),
                onTap: () => context.push(location('MOB-48')),
              ),
              NavRow(
                icon: Icons.devices_other_outlined,
                label: context.t('mob.account.devices.action'),
                dividerAbove: true,
                onTap: () => context.push(location('MOB-49')),
              ),
              if (info.asData != null)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: MachvonV2Space.s16,
                    vertical: MachvonV2Space.s12,
                  ),
                  child: Text(
                    context.t('mob.account.version.label', <String, Object>{
                      'version': info.requireValue.full,
                    }),
                    style: text.caption,
                  ),
                ),
            ],
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

/// A setting that is a choice among a few words: its name above and the chips under it.
class _Choice extends StatelessWidget {
  const _Choice({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(
            left: MachvonV2Space.s16,
            top: MachvonV2Space.s12,
            right: MachvonV2Space.s16,
          ),
          child: Semantics(
            container: true,
            header: true,
            child: Text(label, style: context.v2text.label),
          ),
        ),
        child,
      ],
    );
  }
}
