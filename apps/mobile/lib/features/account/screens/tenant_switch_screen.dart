import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/router.dart' show homeLocation;
import '../../../core/session/session.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/state/state_card.dart';
import '../../session/auth/auth_service.dart';
import '../../session/auth/identity_api.dart';
import '../../session/auth/session_vault.dart';
import '../../session/flow.dart';
import '../../session/session_providers.dart';
import '../account_providers.dart';

final NotifierProvider<FlowNotifier, FlowState> switchFlowProvider =
    NotifierProvider.autoDispose<FlowNotifier, FlowState>(FlowNotifier.new);

final FutureProvider<LocalDataPolicy> _policyProvider =
    FutureProvider.autoDispose<LocalDataPolicy>(
      (Ref ref) => ref.watch(authServiceProvider).localDataPolicy(),
    );

/// MOB-48: switch tenant (or role). Every other membership is listed; choosing one asks for confirmation and says what happens to
/// the data of the organisation left. While commands wait on the device the switch is refused with their number, until they are
/// sent or the person chooses to discard them; only then is the old data deleted (or kept encrypted, per the option).
Widget buildTenantSwitchScreen(BuildContext context, ScreenContext screen) =>
    const TenantSwitchScreen();

class TenantSwitchScreen extends ConsumerStatefulWidget {
  const TenantSwitchScreen({super.key});

  @override
  ConsumerState<TenantSwitchScreen> createState() => _TenantSwitchScreenState();
}

class _TenantSwitchScreenState extends ConsumerState<TenantSwitchScreen> {
  MembershipChoice? _chosen;
  int? _blockedBy;
  bool _sendFailed = false;

  Future<void> _switch({required bool discard}) async {
    final MembershipChoice? target = _chosen;
    if (target == null) return;
    setState(() {
      _sendFailed = false;
      _blockedBy = null;
    });
    final AuthService service = ref.read(authServiceProvider);
    final SignInOutcome? outcome = await ref
        .read(switchFlowProvider.notifier)
        .run<SignInOutcome?>(() async {
          try {
            return await service.switchTenant(target, discardPending: discard);
          } on PendingCommandsBlock catch (block) {
            if (mounted) setState(() => _blockedBy = block.count);
            return null;
          }
        });
    if (outcome == null || !mounted) return;
    if (outcome == SignInOutcome.needsSecondFactor) {
      context.go(
        Uri(
          path: ref.read(routeTableProvider).locationOf('MOB-03'),
          queryParameters: const <String, String>{'return': homeLocation},
        ).toString(),
      );
    } else {
      context.go(homeLocation);
    }
  }

  Future<void> _sendNow() async {
    setState(() => _sendFailed = false);
    try {
      await ref.read(pendingWorkProvider).sendNow();
    } on Object {
      if (mounted) setState(() => _sendFailed = true);
      return;
    }
    final int left = await ref.read(pendingWorkProvider).count();
    if (!mounted) return;
    setState(() {
      _blockedBy = left == 0 ? null : left;
      _sendFailed = left != 0;
    });
  }

  @override
  Widget build(BuildContext context) {
    final SessionSnapshot session = ref.watch(sessionProvider);
    final AsyncValue<List<MembershipChoice>> choices = ref.watch(
      myMembershipsProvider,
    );
    final FlowState flow = ref.watch(switchFlowProvider);
    final Reachability reachability = ref.watch(reachabilityProvider);
    final LocalDataPolicy policy =
        ref.watch(_policyProvider).asData?.value ?? LocalDataPolicy.purge;
    final ({ScreenState state, ProblemView? problem}) loaded = stateOfAsync(
      choices,
      reachability,
    );
    final ScreenState state = flow.state != ScreenState.defaultState
        ? flow.state
        : loaded.state;
    final List<MembershipChoice> items =
        choices.asData?.value ?? const <MembershipChoice>[];
    final ThemeData theme = Theme.of(context);
    final bool alone = items
        .where(
          (MembershipChoice m) =>
              m.selectable && m.membershipId != session.membershipId,
        )
        .isEmpty;
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.tenantSwitch.title.text'))),
      body: SafeArea(
        child: StateBoundary(
          state: state,
          problem: flow.problem ?? loaded.problem,
          onRetry: state == ScreenState.loading
              ? null
              : () => ref.invalidate(myMembershipsProvider),
          child: items.isNotEmpty && alone
              ? StateCard(
                  icon: Icons.apartment_outlined,
                  title: context.t('mob.tenantSwitch.empty.title'),
                  body: context.t('mob.tenantSwitch.empty.body'),
                  announcement:
                      '${context.t('mob.tenantSwitch.empty.title')}. ${context.t('mob.tenantSwitch.empty.body')}',
                )
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(MachvonSpace.space16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Text(context.t('mob.tenantSwitch.body.text')),
                      const SizedBox(height: MachvonSpace.space12),
                      RadioGroup<MembershipChoice>(
                        groupValue: _chosen,
                        onChanged: (MembershipChoice? value) => setState(() {
                          _chosen = value;
                          _blockedBy = null;
                        }),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            for (final MembershipChoice item in items)
                              _Option(
                                item: item,
                                current:
                                    item.membershipId == session.membershipId,
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(height: MachvonSpace.space8),
                      SwitchListTile(
                        title: Text(context.t('mob.tenantSwitch.cache.title')),
                        subtitle: Text(
                          policy == LocalDataPolicy.purge
                              ? context.t('mob.tenantSwitch.cache.on')
                              : context.t('mob.tenantSwitch.cache.off'),
                        ),
                        value: policy == LocalDataPolicy.purge,
                        onChanged: (bool on) async {
                          await ref
                              .read(authServiceProvider)
                              .setLocalDataPolicy(
                                on
                                    ? LocalDataPolicy.purge
                                    : LocalDataPolicy.keepEncrypted,
                              );
                          ref.invalidate(_policyProvider);
                        },
                      ),
                      if (_blockedBy != null) ...<Widget>[
                        const SizedBox(height: MachvonSpace.space8),
                        Semantics(
                          liveRegion: true,
                          container: true,
                          child: Card(
                            color: theme.colorScheme.errorContainer,
                            child: Padding(
                              padding: const EdgeInsets.all(
                                MachvonSpace.space16,
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: <Widget>[
                                  Text(
                                    context.t('mob.tenantSwitch.blocked.title'),
                                    style: theme.textTheme.titleSmall?.copyWith(
                                      color: theme.colorScheme.onErrorContainer,
                                    ),
                                  ),
                                  Text(
                                    context.t(
                                      'mob.tenantSwitch.blocked.body',
                                      <String, Object>{'count': _blockedBy!},
                                    ),
                                    style: TextStyle(
                                      color: theme.colorScheme.onErrorContainer,
                                    ),
                                  ),
                                  if (_sendFailed)
                                    Text(
                                      context.t(
                                        'mob.tenantSwitch.sendFailed.text',
                                      ),
                                      style: TextStyle(
                                        color:
                                            theme.colorScheme.onErrorContainer,
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: MachvonSpace.space8),
                        FilledButton(
                          onPressed: _sendNow,
                          child: Text(
                            context.t('mob.tenantSwitch.send.action'),
                          ),
                        ),
                        const SizedBox(height: MachvonSpace.space8),
                        OutlinedButton(
                          onPressed: () => _switch(discard: true),
                          child: Text(
                            context.t(
                              'mob.tenantSwitch.discard.action',
                              <String, Object>{'count': _blockedBy!},
                            ),
                          ),
                        ),
                      ] else ...<Widget>[
                        const SizedBox(height: MachvonSpace.space8),
                        FilledButton(
                          onPressed:
                              _chosen == null || state == ScreenState.loading
                              ? null
                              : () => _switch(discard: false),
                          child: Text(
                            context.t('mob.tenantSwitch.confirm.action'),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
        ),
      ),
    );
  }
}

class _Option extends StatelessWidget {
  const _Option({required this.item, required this.current});

  final MembershipChoice item;
  final bool current;

  @override
  Widget build(BuildContext context) {
    final bool enabled = item.selectable && !current;
    return Card(
      child: RadioListTile<MembershipChoice>(
        value: item,
        enabled: enabled,
        title: Text(item.tenantName),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              context.t('mob.account.role.label', <String, Object>{
                'role': item.membershipType,
              }),
            ),
            if (current)
              Text(
                context.t('mob.tenantSwitch.current.label'),
                style: Theme.of(context).textTheme.labelMedium,
              ),
            if (!item.selectable)
              Text(
                context.t('mob.tenantSwitch.unavailable.text', <String, Object>{
                  'status': item.status == 'Active'
                      ? item.tenantStatus
                      : item.status,
                }),
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ),
      ),
    );
  }
}
