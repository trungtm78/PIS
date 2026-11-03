import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/di/providers.dart';
import '../session/session_providers.dart';
import 'permission_service.dart';

/// The phone's permission API. Tests override it.
final Provider<PermissionPlatform> permissionPlatformProvider = Provider<PermissionPlatform>((Ref ref) => const HandlerPermissionPlatform());

final Provider<PermissionService> permissionServiceProvider = Provider<PermissionService>(
  (Ref ref) => PermissionService(
    platform: ref.watch(permissionPlatformProvider),
    ledger: PermissionLedger(ref.watch(secureValueStoreProvider)),
  ),
);

/// Opens the rationale screen for the feature that needs [permissions] and returns how it ended. The system prompt is shown
/// only from that screen, after the person has read why; when everything is granted already no screen is shown.
///
/// A feature that needs the camera calls `requestPermissions(context, ref, [AppPermission.camera])`, and on a denial offers the
/// alternative the outcome names (attach a file, a place typed by hand). Notifications use MOB-05, camera and position MOB-06.
Future<PermissionOutcome> requestPermissions(BuildContext context, WidgetRef ref, List<AppPermission> permissions) async {
  final PermissionService service = ref.read(permissionServiceProvider);
  final Map<AppPermission, PermissionState> states = <AppPermission, PermissionState>{
    for (final AppPermission permission in permissions) permission: await service.status(permission),
  };
  if (states.values.every((PermissionState state) => state == PermissionState.granted)) return PermissionOutcome(states: states);
  if (!context.mounted) return PermissionOutcome(states: states, deferred: true);
  final bool notifications = permissions.length == 1 && permissions.single == AppPermission.notifications;
  final String location = ref.read(routeTableProvider).locationOf(notifications ? 'MOB-05' : 'MOB-06');
  final String need = permissions.map((AppPermission permission) => permission.name).join(',');
  final PermissionOutcome? outcome = await context.push<PermissionOutcome>(Uri(path: location, queryParameters: <String, String>{'need': need}).toString());
  return outcome ?? PermissionOutcome(states: states, deferred: true);
}
