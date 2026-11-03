import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/state/state_card.dart';
import '../../session/auth/auth_service.dart';
import '../../session/flow.dart';
import '../../session/session_providers.dart';
import '../account_providers.dart';

final NotifierProvider<FlowNotifier, FlowState> devicesFlowProvider =
    NotifierProvider.autoDispose<FlowNotifier, FlowState>(FlowNotifier.new);

/// MOB-49: the open sessions and the registered devices of the person, the revocation of a device, and the sign-out of this
/// phone with the purge of its local data. Revoking a device ends its session (401 `SESSION_EXPIRED` on its next call), deletes
/// its local database on its next contact and stops its push notifications; revoking this phone signs it out here at once.
Widget buildDevicesScreen(BuildContext context, ScreenContext screen) =>
    const DevicesScreen();

class DevicesScreen extends ConsumerStatefulWidget {
  const DevicesScreen({super.key});

  @override
  ConsumerState<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends ConsumerState<DevicesScreen> {
  String? _revokedMessage;
  Future<void> Function()? _lastIntention;

  Future<void> _revoke(DeviceRow device, {required bool thisPhone}) async {
    final int pending = thisPhone
        ? await ref.read(pendingWorkProvider).count()
        : 0;
    if (!mounted) return;
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: Text(context.t('mob.devices.revoke.title')),
        content: Text(
          <String>[
            context.t('mob.devices.revoke.body'),
            if (thisPhone) context.t('mob.devices.revokeThis.body'),
            if (pending > 0)
              context.t('mob.devices.signOut.pending', <String, Object>{
                'count': pending,
              }),
          ].join('\n\n'),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(context.t('mob.devices.revoke.cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(context.t('mob.devices.revoke.confirm')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final String reason = context.t('mob.devices.revoke.reason');
    // One intention, one attempt: a retry after a lost answer repeats the same command with the same key.
    final CommandAttempt attempt = CommandAttempt.fresh();
    final String done = context.t('mob.devices.revoked.done');
    Future<void> send() async {
      final bool? sent = await ref.read(devicesFlowProvider.notifier).run(
        () async {
          await ref
              .read(apiClientProvider)
              .revokeMyDevice(
                ReasonOnly(reason: reason),
                deviceId: device.id,
                attempt: attempt,
              );
          if (thisPhone)
            await ref
                .read(authServiceProvider)
                .signOut(discardPending: true, scope: SignOutScope.allTenants);
          return true;
        },
      );
      if (sent != true || !mounted) return;
      _lastIntention = null;
      setState(() => _revokedMessage = done);
      ref.invalidate(myDevicesProvider);
    }

    // The retry after a lost answer is this same command with the same key, never a new one.
    _lastIntention = send;
    await send();
  }

  Future<void> _signOut() async {
    final AuthService service = ref.read(authServiceProvider);
    final int pending = await ref.read(pendingWorkProvider).count();
    if (!mounted) return;
    bool everything = false;
    final ({bool confirmed, bool everything})? answer =
        await showDialog<({bool confirmed, bool everything})>(
          context: context,
          builder: (BuildContext context) => StatefulBuilder(
            builder: (BuildContext context, StateSetter setLocal) =>
                AlertDialog(
                  title: Text(context.t('mob.devices.signOut.title')),
                  content: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(context.t('mob.devices.signOut.body')),
                      if (pending > 0) ...<Widget>[
                        const SizedBox(height: MachvonSpace.space12),
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            context.t(
                              'mob.devices.signOut.pending',
                              <String, Object>{'count': pending},
                            ),
                          ),
                        ),
                      ],
                      CheckboxListTile(
                        contentPadding: EdgeInsets.zero,
                        value: everything,
                        title: Text(context.t('mob.devices.signOut.all')),
                        onChanged: (bool? value) =>
                            setLocal(() => everything = value ?? false),
                      ),
                    ],
                  ),
                  actions: <Widget>[
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: Text(context.t('mob.devices.revoke.cancel')),
                    ),
                    FilledButton(
                      onPressed: () =>
                          Navigator.of(context)
                              .pop((confirmed: true, everything: everything)),
                      child: Text(
                        pending > 0
                            ? context.t(
                                'mob.devices.signOut.discard',
                                <String, Object>{'count': pending},
                              )
                            : context.t('mob.devices.signOut.confirm'),
                      ),
                    ),
                  ],
                ),
          ),
        );
    if (answer == null || !answer.confirmed) return;
    await ref
        .read(devicesFlowProvider.notifier)
        .run(
          () => service.signOut(
            discardPending: pending > 0,
            scope: answer.everything
                ? SignOutScope.allTenants
                : SignOutScope.activeTenant,
          ),
        );
  }

  @override
  Widget build(BuildContext context) {
    final AsyncValue<DevicesView> view = ref.watch(myDevicesProvider);
    final FlowState flow = ref.watch(devicesFlowProvider);
    final Reachability reachability = ref.watch(reachabilityProvider);
    final ({ScreenState state, ProblemView? problem}) loaded = stateOfAsync(
      view,
      reachability,
    );
    final ScreenState state = flow.state != ScreenState.defaultState
        ? flow.state
        : loaded.state;
    final DevicesView? data = view.asData?.value;
    final ThemeData theme = Theme.of(context);
    final bool empty =
        data != null && data.sessions.isEmpty && data.devices.isEmpty;
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.devices.title.text'))),
      body: SafeArea(
        child: StateBoundary(
          state: state,
          problem: flow.problem ?? loaded.problem,
          onRetry: state == ScreenState.loading
              ? null
              : () => flow.problem != null && _lastIntention != null
                    ? _lastIntention!()
                    : ref.invalidate(myDevicesProvider),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (_revokedMessage != null)
                  Semantics(liveRegion: true, child: Text(_revokedMessage!)),
                if (empty)
                  StateCardInline(
                    title: context.t('mob.devices.empty.title'),
                    body: context.t('mob.devices.empty.body'),
                  )
                else if (data != null) ...<Widget>[
                  Semantics(
                    header: true,
                    child: Text(
                      context.t('mob.devices.sessions.title'),
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  for (final SessionRow row in data.sessions)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(row.summary.isEmpty ? row.id : row.summary),
                      subtitle: Text(
                        <String>[
                          if (row.current)
                            context.t('mob.devices.current.label'),
                          if (row.lastSeenAt != null)
                            context.t(
                              'mob.devices.lastSeen.label',
                              <String, Object>{'date': _date(row.lastSeenAt!)},
                            ),
                        ].join(' · '),
                      ),
                    ),
                  const SizedBox(height: MachvonSpace.space16),
                  Semantics(
                    header: true,
                    child: Text(
                      context.t('mob.devices.devices.title'),
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  for (final DeviceRow device in data.devices)
                    _DeviceTile(
                      device: device,
                      thisPhone: device.id == data.thisDeviceId,
                      onRevoke: () => _revoke(
                        device,
                        thisPhone: device.id == data.thisDeviceId,
                      ),
                    ),
                ],
                const SizedBox(height: MachvonSpace.space24),
                FilledButton.tonal(
                  onPressed: _signOut,
                  child: Text(context.t('mob.devices.signOut.action')),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  static String _date(DateTime value) {
    final DateTime local = value.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(local.day)}/${two(local.month)}/${local.year} ${two(local.hour)}:${two(local.minute)}';
  }
}

class _DeviceTile extends StatelessWidget {
  const _DeviceTile({
    required this.device,
    required this.thisPhone,
    required this.onRevoke,
  });

  final DeviceRow device;
  final bool thisPhone;
  final VoidCallback onRevoke;

  @override
  Widget build(BuildContext context) {
    final String id = device.publicId.length > 8
        ? '…${device.publicId.substring(device.publicId.length - 8)}'
        : device.publicId;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      title: Text('${device.platform} $id'),
      subtitle: Text(
        <String>[
          if (thisPhone) context.t('mob.devices.thisDevice.label'),
          if (device.revoked) context.t('mob.devices.revoked.label'),
          if (device.lastSeenAt != null)
            context.t('mob.devices.lastSeen.label', <String, Object>{
              'date': _DevicesScreenState._date(device.lastSeenAt!),
            }),
        ].join(' · '),
      ),
      trailing: device.revoked
          ? null
          : OutlinedButton(
              onPressed: onRevoke,
              child: Text(context.t('mob.devices.revoke.action')),
            ),
    );
  }
}

/// The empty message inside a list (the card of the standard empty state fills a whole screen).
class StateCardInline extends StatelessWidget {
  const StateCardInline({required this.title, required this.body, super.key});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 240,
      child: StateCard(
        icon: Icons.devices_other_outlined,
        title: title,
        body: body,
        announcement: '$title. $body',
      ),
    );
  }
}
