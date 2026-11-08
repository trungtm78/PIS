import 'package:machvon_api_client/machvon_api_client.dart';

import '../directives/directive_models.dart';
import '../read_support/wire.dart';
import 'alerts.dart';
import 'command_center.dart';
import 'home_insight.dart';

/// What the home of a leader reads: the alerts and the command center, each on its own, and beside them the colours of the units with their reasons, what
/// changed since last week and the steering directives (the parts the web leader home has). One of them failing leaves the others on the screen with the
/// failing one named; only when both the alerts and the command center fail (or the session ended, or there is no connection) is the whole screen in the
/// state of the failure. The three added parts never take the screen down: each says why it is missing and offers its own retry.
final class LeaderHomeData {
  const LeaderHomeData({
    this.center,
    this.centerError,
    this.alerts,
    this.alertsError,
    this.scopeRefused = false,
    this.rag,
    this.ragError,
    this.changes,
    this.changesError,
    this.directives,
    this.directivesError,
  });

  final CommandCenter? center;

  /// The stable code of the failure of the command center, when it could not be read.
  final String? centerError;
  final AlertFeed? alerts;
  final String? alertsError;

  /// The scope was refused and the alerts of the person were read instead.
  final bool scopeRefused;

  /// The colours of the units with the reason for each, or the stable code of the failure.
  final RagReading? rag;
  final String? ragError;

  /// What changed since last week, or the stable code of the failure.
  final HomeChanges? changes;
  final String? changesError;

  /// The steering directives (counts and the oldest overdue ones), or the stable code of the failure.
  final DirectiveWidgetData? directives;
  final String? directivesError;
}

Future<({Object? value, ApiError? error})> _attempt(Future<Object?> Function() read) async {
  try {
    return (value: await read(), error: null);
  } on ApiError catch (error) {
    return (value: null, error: error);
  }
}

/// The code a part of the home reports for a failure: the stable code of the server, and a refusal of the right (403) as `SCOPE_DENIED` whichever of its
/// codes the server used, so the part says "not allowed" and not "could not read".
String _partCode(ApiError error) => error.status == 403 && error.code != 'PERMISSION_DENIED' ? 'SCOPE_DENIED' : error.code;

/// Reads the alerts of the scope (those of the person when the scope is refused), the command center, the colours, the changes and the directives together.
Future<Object?> readLeaderHome(MachvonApiClient client) async {
  final List<({Object? value, ApiError? error})> results = await Future.wait(<Future<({Object? value, ApiError? error})>>[
    _attempt(() => client.getCommandCenter()),
    _attempt(() => readAlertFeed(client, view: 'scope', fallbackToMine: true)),
    _attempt(() => client.execute('getRagReading')),
    _attempt(() => client.execute('getHomeChanges')),
    _attempt(() => client.execute('getDirectiveWidget')),
  ]);
  final ApiError? centerError = results[0].error;
  final ApiError? alertsError = results[1].error;
  // The end of the session and a missing connection are the state of the whole screen, whichever read met them.
  for (final ApiError? error in <ApiError?>[centerError, alertsError, results[2].error, results[3].error, results[4].error]) {
    if (error != null && error.status == 401) throw error;
  }
  for (final ApiError? error in <ApiError?>[centerError, alertsError]) {
    if (error != null && error.code == networkErrorCode) throw error;
  }
  if (centerError != null && alertsError != null) throw centerError;
  final Json? alerts = asRecord(results[1].value);
  return <String, Object?>{
    'center': results[0].value,
    'center_error': centerError?.code,
    'alerts': alerts,
    'alerts_error': alertsError?.code,
    'scope_refused': alerts?['scope_refused'] == true,
    'rag': results[2].value,
    'rag_error': results[2].error == null ? null : _partCode(results[2].error!),
    'changes': results[3].value,
    'changes_error': results[3].error == null ? null : _partCode(results[3].error!),
    'directives': results[4].value,
    'directives_error': results[4].error == null ? null : _partCode(results[4].error!),
  };
}

/// The home of a leader from [readLeaderHome], or null when it holds neither part.
LeaderHomeData? parseLeaderHome(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null) return null;
  final CommandCenter? center = row['center'] == null ? null : parseCommandCenter(row['center']);
  final AlertFeed? alerts = row['alerts'] == null ? null : parseAlertFeed(row['alerts']);
  if (center == null && alerts == null) return null;
  final RagReading? rag = row['rag'] == null ? null : parseRagReading(row['rag']);
  final HomeChanges? changes = row['changes'] == null ? null : parseHomeChanges(row['changes']);
  final DirectiveWidgetData? directives = row['directives'] == null ? null : parseDirectiveWidget(row['directives']);
  return LeaderHomeData(
    center: center,
    centerError: center != null ? null : (filled(row['center_error']) ?? (row['center'] == null ? 'UNKNOWN' : 'CONTRACT_MISMATCH')),
    alerts: alerts,
    alertsError: alerts != null ? null : (filled(row['alerts_error']) ?? (row['alerts'] == null ? 'UNKNOWN' : 'CONTRACT_MISMATCH')),
    scopeRefused: row['scope_refused'] == true,
    rag: rag,
    ragError: rag != null ? null : (filled(row['rag_error']) ?? (row['rag'] == null ? 'UNKNOWN' : 'CONTRACT_MISMATCH')),
    changes: changes,
    changesError: changes != null ? null : (filled(row['changes_error']) ?? (row['changes'] == null ? 'UNKNOWN' : 'CONTRACT_MISMATCH')),
    directives: directives,
    directivesError: directives != null ? null : (filled(row['directives_error']) ?? (row['directives'] == null ? 'UNKNOWN' : 'CONTRACT_MISMATCH')),
  );
}
