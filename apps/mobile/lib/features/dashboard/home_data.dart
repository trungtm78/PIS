import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/wire.dart';
import 'alerts.dart';
import 'command_center.dart';

/// What the home of a leader reads: the alerts and the command center, each on its own. One of them failing leaves the other on
/// the screen with the failing one named; only when both fail (or the session ended, or there is no connection) is the whole
/// screen in the state of the failure.
final class LeaderHomeData {
  const LeaderHomeData({this.center, this.centerError, this.alerts, this.alertsError, this.scopeRefused = false});

  final CommandCenter? center;

  /// The stable code of the failure of the command center, when it could not be read.
  final String? centerError;
  final AlertFeed? alerts;
  final String? alertsError;

  /// The scope was refused and the alerts of the person were read instead.
  final bool scopeRefused;
}

Future<({Object? value, ApiError? error})> _attempt(Future<Object?> Function() read) async {
  try {
    return (value: await read(), error: null);
  } on ApiError catch (error) {
    return (value: null, error: error);
  }
}

/// Reads the alerts of the scope (those of the person when the scope is refused) and the command center together.
Future<Object?> readLeaderHome(MachvonApiClient client) async {
  final List<({Object? value, ApiError? error})> results = await Future.wait(<Future<({Object? value, ApiError? error})>>[
    _attempt(() => client.getCommandCenter()),
    _attempt(() => readAlertFeed(client, view: 'scope', fallbackToMine: true)),
  ]);
  final ApiError? centerError = results[0].error;
  final ApiError? alertsError = results[1].error;
  // The end of the session and a missing connection are the state of the whole screen, whichever read met them.
  for (final ApiError? error in <ApiError?>[centerError, alertsError]) {
    if (error != null && (error.status == 401 || error.code == networkErrorCode)) throw error;
  }
  if (centerError != null && alertsError != null) throw centerError;
  final Json? alerts = asRecord(results[1].value);
  return <String, Object?>{
    'center': results[0].value,
    'center_error': centerError?.code,
    'alerts': alerts,
    'alerts_error': alertsError?.code,
    'scope_refused': alerts?['scope_refused'] == true,
  };
}

/// The home of a leader from [readLeaderHome], or null when it holds neither part.
LeaderHomeData? parseLeaderHome(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null) return null;
  final CommandCenter? center = row['center'] == null ? null : parseCommandCenter(row['center']);
  final AlertFeed? alerts = row['alerts'] == null ? null : parseAlertFeed(row['alerts']);
  if (center == null && alerts == null) return null;
  return LeaderHomeData(
    center: center,
    centerError: center != null ? null : (filled(row['center_error']) ?? (row['center'] == null ? 'UNKNOWN' : 'CONTRACT_MISMATCH')),
    alerts: alerts,
    alertsError: alerts != null ? null : (filled(row['alerts_error']) ?? (row['alerts'] == null ? 'UNKNOWN' : 'CONTRACT_MISMATCH')),
    scopeRefused: row['scope_refused'] == true,
  );
}
