import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/attempts.dart';
import '../read_support/wire.dart';
import 'query_models.dart';

/// How a question that became a job is waited for: how often the run of the job is looked at, and how many times. The server makes
/// a job of a question that is too heavy to wait for (`202 ASYNC_JOB`); the phone looks at its run, and asks the same question
/// again when it has completed (it is then answered from what the job kept).
final class JobPolling {
  const JobPolling({required this.interval, required this.attempts, this.waitBetweenPolls = Future.delayed});

  final Duration interval;
  final int attempts;
  final Future<void> Function(Duration duration) waitBetweenPolls;
}

/// A minute in all: a phone does not hold a leader at a dashboard for the five minutes the web waits.
final Provider<JobPolling> jobPollingProvider = Provider<JobPolling>((Ref ref) => const JobPolling(interval: Duration(seconds: 3), attempts: 20));

/// The job did not end in the time the screen waits: it goes on in the background.
final class QueryStillRunning implements Exception {
  const QueryStillRunning(this.runId);

  final String runId;
}

/// The job ended without an answer (refused, failed, stopped by the database): the question is not asked again for it.
final class QueryJobEnded implements Exception {
  const QueryJobEnded(this.status, this.code);

  final String status;
  final String? code;
}

/// The screen the question was asked for is gone: nothing more is asked in its name.
final class QueryCancelled implements Exception {
  const QueryCancelled();
}

/// An answer with the JSON it was read from (the copy kept for a lost connection is the JSON).
final class RawQuery {
  const RawQuery(this.raw, this.result);

  final Object? raw;
  final QueryResult result;
}

/// The renewed analysis: a new context on the newest snapshot of the period of the token.
final class RenewedContext {
  const RenewedContext({required this.snapshotId, required this.drillToken});

  final String snapshotId;
  final String drillToken;
}

const Set<String> _openRun = <String>{'QUEUED', 'RUNNING'};

/// The reads and commands of the dashboard that go to the BI module: a metric over a snapshot, a step down from a group, the renewal
/// of an analysis on the newest snapshot. A metric is asked of the snapshot that is named, so the figures of a screen are all of
/// one snapshot; the server decides the scope, and the answer says whose it is.
class BiQueryService {
  BiQueryService({required this.client, required this.polling, this.cancelled});

  final MachvonApiClient client;
  final JobPolling polling;

  /// Whether the screen that asked has gone: checked before each look at a job.
  final bool Function()? cancelled;
  final AttemptRegistry _renewals = AttemptRegistry();

  /// One metric over one snapshot, cut by [dimension] when given.
  Future<RawQuery> run({required String metricVersionId, required String snapshotId, String? dimension}) async {
    final DrillQuery body = DrillQuery(metricVersionId: metricVersionId, snapshotId: snapshotId, dimensions: <String>[?dimension], filters: const <DrillQueryFiltersItem>[]);
    Object? raw = await client.postDashboardQueries(body);
    String? run = _runOf(raw);
    for (int attempt = 0; run != null && attempt < polling.attempts; attempt += 1) {
      await polling.waitBetweenPolls(polling.interval);
      if (cancelled?.call() ?? false) throw const QueryCancelled();
      final Json? state = asRecord(await client.getBiQueryRun(id: run));
      final String? status = text(state?['status']);
      if (status == null) throw const ContractMismatch('response', 'does not hold what the screen needs');
      if (_openRun.contains(status)) continue;
      if (status != 'COMPLETED') throw QueryJobEnded(status, text(state?['error_code']));
      if (cancelled?.call() ?? false) throw const QueryCancelled();
      raw = await client.postDashboardQueries(body);
      // What a job kept may be gone again by the time it is asked for: the question is then a job of its own, waited for in its turn.
      run = _runOf(raw);
      if (run == null) return _read(raw);
    }
    if (run != null) throw QueryStillRunning(run);
    return _read(raw);
  }

  /// One step down: the groups of the group whose token is given, cut by [dimension]. It stays on the snapshot of the token.
  Future<RawQuery> explain({required String drillToken, required String dimension}) async {
    final Object? raw = await client.explainBiMetric(query: <String, Object?>{'drill_token': drillToken, 'child_dimension': dimension});
    return _read(raw);
  }

  /// A new context on the newest snapshot of the period of [drillToken]. The old token goes on answering for the snapshot it was
  /// made on until it expires; nothing is mixed.
  Future<RenewedContext> renew(String drillToken) async {
    final CommandAttempt attempt = _renewals.forPayload(drillToken);
    try {
      final Json? answer = asRecord(await client.refreshBiQueryContext(BiContextRefresh(drillToken: drillToken), attempt: attempt));
      _renewals.done();
      final String? snapshot = filled(answer?['snapshot_id']);
      final String? token = filled(answer?['drill_token']);
      if (snapshot == null || token == null) throw const ContractMismatch('response', 'does not hold what the screen needs');
      return RenewedContext(snapshotId: snapshot, drillToken: token);
    } on ApiError catch (error) {
      _renewals.ended(error);
      rethrow;
    }
  }

  String? _runOf(Object? raw) {
    final Json? row = asRecord(raw);
    return row != null && row['status'] == 'ASYNC_JOB' ? filled(row['run_id']) : null;
  }

  RawQuery _read(Object? raw) {
    final QueryResult? result = parseQueryResult(raw);
    if (result == null) throw const ContractMismatch('response', 'does not hold what the screen needs');
    return RawQuery(raw, result);
  }
}

/// What a refusal of a query means to the person, for the words of the screen. The sentences are those of the web BI-09.
enum QueryProblem { running, changed, timeout, policy, dimension, metric, snapshot, scope, token, expired, invalid, session, general }

const Map<String, QueryProblem> _problemByCode = <String, QueryProblem>{
  'ACCESS_POLICY_MISSING': QueryProblem.policy,
  'DIMENSION_NOT_IN_DATASET': QueryProblem.dimension,
  'METRIC_NOT_CERTIFIED': QueryProblem.metric,
  'SNAPSHOT_NOT_FOUND': QueryProblem.snapshot,
  'SCOPE_DENIED': QueryProblem.scope,
  'DRILL_TOKEN_INVALID': QueryProblem.token,
  'SNAPSHOT_EXPIRED': QueryProblem.expired,
  'VALIDATION_FAILED': QueryProblem.invalid,
  'FIELD_NOT_ALLOWED': QueryProblem.invalid,
  'INVALID_REQUEST': QueryProblem.invalid,
  'SESSION_EXPIRED': QueryProblem.session,
};

/// The stable code behind a failure, for the line under the sentence; a job that ended carries the code of its run.
String? problemCodeOf(Object error) {
  if (error is ApiError) return error.code;
  if (error is ContractMismatch) return 'CONTRACT_MISMATCH';
  if (error is QueryJobEnded) return error.code ?? error.status;
  if (error is QueryStillRunning) return null;
  return 'CLIENT_ERROR';
}

QueryProblem problemOfFailure(Object error) {
  if (error is QueryStillRunning) return QueryProblem.running;
  if (error is QueryJobEnded) return error.status == 'TIMEOUT' ? QueryProblem.timeout : (error.code == 'SCOPE_CHANGED' ? QueryProblem.changed : (_problemByCode[error.code] ?? QueryProblem.general));
  if (error is ApiError) return _problemByCode[error.code] ?? QueryProblem.general;
  return QueryProblem.general;
}
