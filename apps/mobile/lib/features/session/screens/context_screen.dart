import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/deep_link_guard.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/router.dart' show homeLocation;
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/state/state_card.dart';
import '../auth/auth_service.dart';
import '../auth/identity_api.dart';
import '../flow.dart';
import '../session_providers.dart';

/// The memberships the person can enter, read once per visit of MOB-04 (and again on retry).
final FutureProvider<List<MembershipChoice>> membershipChoicesProvider =
    FutureProvider.autoDispose<List<MembershipChoice>>(
  (Ref ref) => ref.watch(authServiceProvider).candidates(),
  retry: (int count, Object error) => null, // a failure is shown with its code and the person retries
);

final NotifierProvider<FlowNotifier, FlowState> selectionFlowProvider =
    NotifierProvider.autoDispose<FlowNotifier, FlowState>(FlowNotifier.new);

/// MOB-04: choose the unit and role. Every membership is listed with the organisation, the role and its validity; one that
/// the server will not let in is shown and cannot be chosen. The choice is what the server binds the session to, so every
/// later call carries it.
Widget buildContextScreen(BuildContext context, ScreenContext screen) =>
    ContextScreen(returnTo: safeReturnLocation(screen.queryParameters[returnParameter]));

class ContextScreen extends ConsumerStatefulWidget {
  const ContextScreen({required this.returnTo, super.key});

  final String? returnTo;

  @override
  ConsumerState<ContextScreen> createState() => _ContextScreenState();
}

class _ContextScreenState extends ConsumerState<ContextScreen> {
  MembershipChoice? _chosen;

  Future<void> _continue(MembershipChoice choice) async {
    final SignInOutcome? outcome = await ref.read(selectionFlowProvider.notifier).run(() => ref.read(authServiceProvider).selectContext(choice));
    if (outcome == null || !mounted) return;
    context.go(
      outcome == SignInOutcome.needsSecondFactor
          ? withReturn(ref.read(routeTableProvider).locationOf('MOB-03'), widget.returnTo)
          : widget.returnTo ?? homeLocation,
    );
  }

  @override
  Widget build(BuildContext context) {
    final AsyncValue<List<MembershipChoice>> choices = ref.watch(membershipChoicesProvider);
    final FlowState flow = ref.watch(selectionFlowProvider);
    final Reachability reachability = ref.watch(reachabilityProvider);
    final ProblemView? loadProblem = choices.hasError ? problemOfAuthFailure(choices.error!, reachability) : null;
    final ScreenState state = flow.state != ScreenState.defaultState
        ? flow.state
        : choices.isLoading
            ? ScreenState.loading
            : loadProblem?.state ?? ScreenState.defaultState;
    final List<MembershipChoice> items = choices.asData?.value ?? const <MembershipChoice>[];
    final MembershipChoice? chosen = _chosen ?? items.where((MembershipChoice c) => c.selectable && c.preselected).firstOrNull;
    return AuthPage(
      child: StateBoundary(
        state: state,
        problem: flow.problem ?? loadProblem,
        onRetry: state == ScreenState.loading ? null : () => ref.invalidate(membershipChoicesProvider),
        child: items.isEmpty && !choices.isLoading
            ? StateCard(
                icon: Icons.apartment_outlined,
                title: context.t('mob.context.empty.title'),
                body: context.t('mob.context.empty.body'),
                announcement: '${context.t('mob.context.empty.title')}. ${context.t('mob.context.empty.body')}',
              )
            : ListView(
                padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space24),
                children: <Widget>[
                  Semantics(header: true, child: Text(context.t('mob.context.title.text'), style: Theme.of(context).textTheme.headlineSmall)),
                  const SizedBox(height: MachvonSpace.space12),
                  Text(context.t('mob.context.body.text')),
                  const SizedBox(height: MachvonSpace.space16),
                  RadioGroup<MembershipChoice>(
                    groupValue: chosen,
                    onChanged: (MembershipChoice? value) => setState(() => _chosen = value),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[for (final MembershipChoice item in items) _MembershipCard(item: item)],
                    ),
                  ),
                  const SizedBox(height: MachvonSpace.space16),
                  FilledButton(
                    onPressed: chosen == null || state == ScreenState.loading ? null : () => _continue(chosen),
                    child: Text(context.t('mob.context.submit.action')),
                  ),
                ],
              ),
      ),
    );
  }
}

class _MembershipCard extends StatelessWidget {
  const _MembershipCard({required this.item});

  final MembershipChoice item;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String role = '${context.t('mob.context.role.label')}: ${item.membershipType}';
    final String? until = item.validUntil == null ? null : context.t('mob.context.validUntil.label', <String, Object>{'date': _date(item.validUntil!)});
    final String? unavailable = item.selectable ? null : context.t('mob.context.unavailable.label', <String, Object>{'status': _unavailableStatus(item)});
    return Card(
      child: RadioListTile<MembershipChoice>(
        value: item,
        enabled: item.selectable,
        title: Text(item.tenantName),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(role),
            if (until != null) Text(until),
            if (item.preselected) Text(context.t('mob.context.preselected.label'), style: theme.textTheme.bodySmall),
            if (unavailable != null) Text(unavailable, style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }

  static String _unavailableStatus(MembershipChoice item) => item.status == 'Active' ? item.tenantStatus : item.status;

  static String _date(DateTime value) {
    final DateTime local = value.toLocal();
    return '${local.day.toString().padLeft(2, '0')}/${local.month.toString().padLeft(2, '0')}/${local.year}';
  }
}
