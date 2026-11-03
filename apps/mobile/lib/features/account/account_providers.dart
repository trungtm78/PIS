import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/api/answer.dart';
import '../../core/api/problem.dart';
import '../../core/connectivity/reachability.dart';
import '../../core/di/providers.dart';
import '../../core/state/screen_state.dart';
import '../session/auth/identity_api.dart';
import '../session/flow.dart';
import '../session/session_providers.dart';

/// A failure of a provider is shown with its code and the person retries; Riverpod's automatic retry would hide it.
Duration? noAutomaticRetry(int count, Object error) => null;

/// The profile of the signed-in person (display name, masked email).
final FutureProvider<UserProfileResponse> myProfileProvider =
    FutureProvider.autoDispose<UserProfileResponse>(retry: noAutomaticRetry, (
      Ref ref,
    ) async {
      final Object? json = await ref
          .watch(apiClientProvider)
          .execute('getMyProfile');
      return decodeAnswer('getMyProfile', json)! as UserProfileResponse;
    });

/// Every membership of the person, for the account line and the tenant switcher.
final FutureProvider<List<MembershipChoice>> myMembershipsProvider =
    FutureProvider.autoDispose<List<MembershipChoice>>(
      retry: noAutomaticRetry,
      (Ref ref) => ref.watch(authServiceProvider).candidates(),
    );

/// One open session of the person.
final class SessionRow {
  const SessionRow({
    required this.id,
    required this.current,
    required this.summary,
    required this.lastSeenAt,
    this.deviceId,
  });

  final String id;
  final bool current;
  final String summary;
  final DateTime? lastSeenAt;

  /// The device this session was opened on, when the server says.
  final String? deviceId;
}

/// One registered device of the person.
final class DeviceRow {
  const DeviceRow({
    required this.id,
    required this.platform,
    required this.publicId,
    required this.lastSeenAt,
    required this.revoked,
  });

  final String id;
  final String platform;
  final String publicId;
  final DateTime? lastSeenAt;
  final bool revoked;
}

final class DevicesView {
  const DevicesView({required this.sessions, required this.devices});

  final List<SessionRow> sessions;
  final List<DeviceRow> devices;

  /// The device of the session this phone uses, or null when the server does not say.
  String? get thisDeviceId {
    for (final SessionRow row in sessions) {
      if (row.current) return row.deviceId;
    }
    return null;
  }
}

/// The sessions and the devices of the person, read together.
final FutureProvider<DevicesView> myDevicesProvider =
    FutureProvider.autoDispose<DevicesView>(retry: noAutomaticRetry, (
      Ref ref,
    ) async {
      final MachvonApiClient client = ref.watch(apiClientProvider);
      final ListMySessionsResponse sessions =
          decodeAnswer(
                'listMySessions',
                await client.execute('listMySessions'),
              )!
              as ListMySessionsResponse;
      final ListMyDevicesResponse devices =
          decodeAnswer('listMyDevices', await client.execute('listMyDevices'))!
              as ListMyDevicesResponse;
      return DevicesView(
        sessions: <SessionRow>[
          for (final ListMySessionsResponseItemsItem item
              in sessions.items ?? const <ListMySessionsResponseItemsItem>[])
            if (item.id != null)
              SessionRow(
                id: item.id!,
                current: item.current ?? false,
                summary: item.userAgentSummary ?? '',
                lastSeenAt: item.lastSeenAt == null
                    ? null
                    : DateTime.tryParse(item.lastSeenAt!),
                deviceId: item.device?['id'] is String
                    ? item.device!['id']! as String
                    : null,
              ),
        ],
        devices: <DeviceRow>[
          for (final ListMyDevicesResponseItemsItem item
              in devices.items ?? const <ListMyDevicesResponseItemsItem>[])
            if (item.id != null)
              DeviceRow(
                id: item.id!,
                platform: item.platform ?? '',
                publicId: item.devicePublicId ?? '',
                lastSeenAt: item.lastSeenAt == null
                    ? null
                    : DateTime.tryParse(item.lastSeenAt!),
                revoked: item.status == 'REVOKED' || item.revokedAt != null,
              ),
        ],
      );
    });

/// The screen state and the failure of an asynchronous value, as the standard states show them.
({ScreenState state, ProblemView? problem}) stateOfAsync(
  AsyncValue<Object?> value,
  Reachability reachability,
) {
  if (value.isLoading && !value.hasValue)
    return (state: ScreenState.loading, problem: null);
  if (value.hasError) {
    final ProblemView? problem = problemOfAuthFailure(
      value.error!,
      reachability,
    );
    return (state: problem?.state ?? ScreenState.error, problem: problem);
  }
  return (state: ScreenState.defaultState, problem: null);
}
