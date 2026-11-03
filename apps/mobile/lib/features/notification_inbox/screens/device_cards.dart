import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../read_support/moment.dart';
import '../../read_support/widgets.dart';
import '../device_ownership.dart';
import '../push_registration.dart';

typedef _DeviceRead = ({List<MyDevice>? devices, String installId});

/// The devices of the member and the one the push goes to (ST-MOB-031, CR-SMP-06). A person with several devices is pushed on one of
/// them, the device they used last that allows notifications, so that an event does not ring on every phone; the inbox has it on all of
/// them. Opening this card registers this device again with what the operating system allows now (so the choice follows the member's use
/// and a permission they just changed) and then reads the list; the server decides the owner and the phone shows its decision.
class PushDevicesCard extends ConsumerStatefulWidget {
  const PushDevicesCard({super.key});

  @override
  ConsumerState<PushDevicesCard> createState() => _PushDevicesCardState();
}

class _PushDevicesCardState extends ConsumerState<PushDevicesCard> {
  late Future<_DeviceRead> _read = _load();

  Future<_DeviceRead> _load() async {
    final PushRegistration registration = ref.read(pushRegistrationProvider);
    final String installId = await ref.read(pushPlatformProvider).installId();
    try {
      await registration.sync();
      return (devices: parseMyDevices(await ref.read(apiClientProvider).listMyDevices()), installId: installId);
    } on ApiError {
      return (devices: null, installId: installId);
    }
  }

  void _again() {
    final Future<_DeviceRead> next = _load();
    setState(() {
      _read = next;
    });
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return SectionCard(
      title: context.t('mob.ntf.devices.title'),
      children: <Widget>[
        Text(context.t('mob.ntf.devices.policy'), style: theme.textTheme.bodyMedium),
        const SizedBox(height: MachvonSpace.space8),
        FutureBuilder<_DeviceRead>(
          future: _read,
          builder: (BuildContext context, AsyncSnapshot<_DeviceRead> snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return Semantics(liveRegion: true, child: Text(context.t('mob.ntf.devices.loading'), style: theme.textTheme.bodySmall));
            }
            final List<MyDevice>? devices = snapshot.data?.devices;
            if (devices == null) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Semantics(liveRegion: true, child: Text(context.t('mob.ntf.devices.unreadable'), style: theme.textTheme.bodyMedium)),
                  OutlinedButton(onPressed: _again, child: Text(context.t('mob.ntf.devices.retry.action'))),
                ],
              );
            }
            final String installId = snapshot.data!.installId;
            if (devices.isEmpty) return Text(context.t('mob.ntf.devices.none'), style: theme.textTheme.bodyMedium);
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: <Widget>[for (final MyDevice device in devices) _DeviceRow(device: device, thisDevice: device.publicId == installId)]);
          },
        ),
      ],
    );
  }
}

class _DeviceRow extends StatelessWidget {
  const _DeviceRow({required this.device, required this.thisDevice});

  final MyDevice device;
  final bool thisDevice;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final DeviceRole role = roleOf(device);
    final String name = switch (device.platform) {
      'ios' => context.t('mob.ntf.devices.platform.ios'),
      'web' => context.t('mob.ntf.devices.platform.web'),
      _ => context.t('mob.ntf.devices.platform.android'),
    };
    final String roleText = switch (role) {
      DeviceRole.owner => context.t('mob.ntf.devices.role.owner'),
      DeviceRole.standby => context.t('mob.ntf.devices.role.standby'),
      DeviceRole.silent => context.t('mob.ntf.devices.role.silent'),
    };
    final String title = thisDevice ? context.t('mob.ntf.devices.this', <String, Object>{'name': name}) : name;
    final String seen = device.lastSeenAt == null ? '' : context.t('mob.ntf.devices.seen', <String, Object>{'time': formatMoment(device.lastSeenAt!)});
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
      child: MergeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(title, style: theme.textTheme.titleSmall),
            Align(alignment: Alignment.centerLeft, child: StatusPill(label: roleText, warn: role == DeviceRole.owner)),
            if (seen.isNotEmpty) Text(seen, style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

/// Whether conversations with people outside through Zalo, WhatsApp and SMS are on for the organisation. They start only when the channels
/// are contracted: until the release flag is on the phone offers no external reply, and says so (CR-SMP-06, D06).
class ExternalChannelsCard extends ConsumerWidget {
  const ExternalChannelsCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bool? enabled = ref.watch(externalChannelsEnabledProvider).value;
    final ThemeData theme = Theme.of(context);
    return SectionCard(
      title: context.t('mob.ntf.external.title'),
      children: <Widget>[
        if (enabled == null)
          Semantics(liveRegion: true, child: Text(context.t('mob.ntf.devices.loading'), style: theme.textTheme.bodySmall))
        else if (enabled)
          Text(context.t('mob.ntf.external.on'), style: theme.textTheme.bodyMedium)
        else
          Text(context.t('mob.ntf.external.off'), style: theme.textTheme.bodyMedium),
      ],
    );
  }
}
