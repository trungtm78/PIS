import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart';
import '../../core/session/session.dart';
import '../read_support/wire.dart';

/// One device of the member as the server lists it (`listMyDevices`).
final class MyDevice {
  const MyDevice({required this.id, required this.platform, required this.publicId, required this.active, required this.permission, required this.pushOwner, this.lastSeenAt});

  final String id;
  final String platform;

  /// The identity of the installation (the same the application registers with); it is the member's own device, so it is shown whole to them.
  final String publicId;
  final bool active;

  /// What the operating system allows the device to do with notifications: `granted`, `provisional`, `denied` or `unknown`.
  final String permission;

  /// The device the member's push goes to. The server decides it (the live device used last that allows notifications); the phone only shows it.
  final bool pushOwner;
  final String? lastSeenAt;

  bool get allowsPush => permission == 'granted' || permission == 'provisional';
}

/// What a device does for the member's notifications.
enum DeviceRole {
  /// The push of the member goes here.
  owner,

  /// It allows notifications, but the member used another device last, so the push goes there; this one takes over when it is used.
  standby,

  /// The operating system does not allow notifications here, or has not said.
  silent,
}

DeviceRole roleOf(MyDevice device) => device.pushOwner ? DeviceRole.owner : (device.allowsPush ? DeviceRole.standby : DeviceRole.silent);

MyDevice? parseMyDevice(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? publicId = filled(row?['device_public_id']);
  if (row == null || id == null || publicId == null) return null;
  return MyDevice(
    id: id,
    platform: text(row['platform']) ?? '',
    publicId: publicId,
    active: row['status'] != 'REVOKED' && row['revoked_at'] == null,
    permission: text(row['permission_state']) ?? 'unknown',
    pushOwner: row['push_owner'] == true,
    lastSeenAt: filled(row['last_seen_at']),
  );
}

/// The live devices of the member, the one the push goes to first; null when the answer is not a list of devices.
List<MyDevice>? parseMyDevices(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  final List<MyDevice> devices = <MyDevice>[for (final Object? item in listOf(body['items'])) ?parseMyDevice(item)].where((MyDevice d) => d.active).toList();
  devices.sort((MyDevice a, MyDevice b) => (b.pushOwner ? 1 : 0) - (a.pushOwner ? 1 : 0));
  return devices;
}

/// The release flag that says the organisation may hold conversations with people outside through Zalo, WhatsApp and SMS. It is on only
/// once the channel contracts are in force (D06, CR-SMP-06: not before R2) and the channel accounts of the organisation are active; the
/// server operates it per tenant (SAS-20). It only switches the offer off: consent, window and account are judged by the server whatever
/// it says.
const String externalChannelsFlag = 'omni.external_channels';

/// Whether external-channel conversation is on for the tenant of the session. A flag that cannot be read, or that is absent, is off:
/// the external channels start only when they are contracted, never by default.
final FutureProvider<bool> externalChannelsEnabledProvider = FutureProvider.autoDispose<bool>((Ref ref) async {
  ref.watch(sessionProvider.select((SessionSnapshot session) => session.tenantId));
  final MachvonApiClient client = ref.watch(apiClientProvider);
  try {
    final Json? body = asRecord(await client.getMyFeatureFlags());
    for (final Object? item in listOf(body?['items'])) {
      final Json? flag = asRecord(item);
      if (flag?['flag_key'] == externalChannelsFlag) return flag?['enabled'] == true;
    }
    return false;
  } on ApiError {
    return false;
  }
});
