import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/features/personal_bi/bi_query_service.dart';

import '../../support/harness.dart';
import '../support/scripted_server.dart';
import 'bi_fixtures.dart';

MachvonApiClient _client(ScriptedServer server) => MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 'token');

JobPolling _polling({int attempts = 3, List<Duration>? slept}) => JobPolling(interval: const Duration(seconds: 3), attempts: attempts, sleep: (Duration d) async => slept?.add(d));

HttpResult _job(String runId) => FakeTransport.json(202, <String, Object?>{'status': 'ASYNC_JOB', 'run_id': runId, 'mode': 'ASYNC_JOB'});

Map<String, Object?> _body(HttpCall call) => jsonDecode(call.body!) as Map<String, Object?>;

void main() {
  group('AC-ST-MOB-027-1 UAT-AC34 a metric is asked of the snapshot that is named', () {
    test('a single figure asks for no dimension, a group asks for one; both carry the snapshot and no filter', () async {
      final ScriptedServer server = biServer();
      final BiQueryService service = BiQueryService(client: _client(server), polling: _polling());

      final RawQuery one = await service.run(metricVersionId: metricRate, snapshotId: snapA);
      final RawQuery grouped = await service.run(metricVersionId: metricPaid, snapshotId: snapA, dimension: 'unit');

      final List<HttpCall> calls = server.callsTo('POST', '/dashboard-queries');
      expect(_body(calls[0]), <String, Object?>{'metric_version_id': metricRate, 'snapshot_id': snapA, 'dimensions': <Object?>[], 'filters': <Object?>[]});
      expect(_body(calls[1]), <String, Object?>{'metric_version_id': metricPaid, 'snapshot_id': snapA, 'dimensions': <Object?>['unit'], 'filters': <Object?>[]});
      expect(one.result.snapshotId, snapA);
      expect(grouped.result.children, hasLength(3));
      expect(calls[0].headers['idempotency-key'], isNot(calls[1].headers['idempotency-key']), reason: 'a question asked again is a new request');
    });

    test('an answer the screen cannot read is a contract mismatch, not half a tile', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', '/dashboard-queries', (_) => <String, Object?>{'total': <String, Object?>{}});
      await expectLater(BiQueryService(client: _client(server), polling: _polling()).run(metricVersionId: metricRate, snapshotId: snapA), throwsA(isA<ContractMismatch>()));
    });
  });

  group('AC-ST-MOB-027-3 a heavy question becomes a job that is waited for', () {
    test('the run is looked at until it completes, then the same question is asked again and answered', () async {
      final ScriptedServer server = ScriptedServer();
      int asked = 0;
      server.answer('POST', '/dashboard-queries', (HttpCall call) {
        asked += 1;
        return asked == 1 ? _job('run-1') : FakeTransport.json(200, rateAnswer());
      });
      int looks = 0;
      server.on('GET', '/bi/query-runs/:id', (_) => <String, Object?>{'status': ++looks < 2 ? 'RUNNING' : 'COMPLETED'});
      final List<Duration> slept = <Duration>[];

      final RawQuery done = await BiQueryService(client: _client(server), polling: _polling(slept: slept)).run(metricVersionId: metricRate, snapshotId: snapA);

      expect(done.result.metricCode, 'DISBURSEMENT_RATE');
      expect(slept, <Duration>[const Duration(seconds: 3), const Duration(seconds: 3)]);
      expect(server.callsTo('POST', '/dashboard-queries'), hasLength(2));
    });

    test('a job that has not ended in the time given is "still running", and is not asked again', () async {
      final ScriptedServer server = ScriptedServer()
        ..answer('POST', '/dashboard-queries', (_) => _job('run-1'))
        ..on('GET', '/bi/query-runs/:id', (_) => <String, Object?>{'status': 'RUNNING'});
      await expectLater(
        BiQueryService(client: _client(server), polling: _polling(attempts: 2)).run(metricVersionId: metricRate, snapshotId: snapA),
        throwsA(isA<QueryStillRunning>().having((QueryStillRunning e) => e.runId, 'run', 'run-1')),
      );
      expect(server.callsTo('GET', '/bi/query-runs/run-1'), hasLength(2));
      expect(server.callsTo('POST', '/dashboard-queries'), hasLength(1));
    });

    test('a job that ended without an answer says how, and no other job is made for it', () async {
      final ScriptedServer server = ScriptedServer()
        ..answer('POST', '/dashboard-queries', (_) => _job('run-1'))
        ..on('GET', '/bi/query-runs/:id', (_) => <String, Object?>{'status': 'FAILED', 'error_code': 'SCOPE_CHANGED'});
      await expectLater(
        BiQueryService(client: _client(server), polling: _polling()).run(metricVersionId: metricRate, snapshotId: snapA),
        throwsA(isA<QueryJobEnded>().having((QueryJobEnded e) => e.code, 'code', 'SCOPE_CHANGED')),
      );
      expect(server.callsTo('POST', '/dashboard-queries'), hasLength(1));
    });

    test('a run without a state is a contract mismatch', () async {
      final ScriptedServer server = ScriptedServer()
        ..answer('POST', '/dashboard-queries', (_) => _job('run-1'))
        ..on('GET', '/bi/query-runs/:id', (_) => <String, Object?>{});
      await expectLater(BiQueryService(client: _client(server), polling: _polling()).run(metricVersionId: metricRate, snapshotId: snapA), throwsA(isA<ContractMismatch>()));
    });

    test('nothing more is asked once the screen is gone', () async {
      final ScriptedServer server = ScriptedServer()
        ..answer('POST', '/dashboard-queries', (_) => _job('run-1'))
        ..on('GET', '/bi/query-runs/:id', (_) => <String, Object?>{'status': 'COMPLETED'});
      bool gone = false;
      final JobPolling polling = JobPolling(interval: Duration.zero, attempts: 3, sleep: (Duration d) async => gone = true);
      await expectLater(BiQueryService(client: _client(server), polling: polling, cancelled: () => gone).run(metricVersionId: metricRate, snapshotId: snapA), throwsA(isA<QueryCancelled>()));
      expect(server.callsTo('GET', '/bi/query-runs/run-1'), isEmpty);
    });

    test('a screen that goes while the job is completing asks nothing more', () async {
      final ScriptedServer server = ScriptedServer()..answer('POST', '/dashboard-queries', (_) => _job('run-1'));
      bool gone = false;
      server.on('GET', '/bi/query-runs/:id', (_) {
        gone = true;
        return <String, Object?>{'status': 'COMPLETED'};
      });
      await expectLater(BiQueryService(client: _client(server), polling: _polling(), cancelled: () => gone).run(metricVersionId: metricRate, snapshotId: snapA), throwsA(isA<QueryCancelled>()));
      expect(server.callsTo('POST', '/dashboard-queries'), hasLength(1));
    });

    test('what a job kept may be gone when it is asked for again: the question is then a job of its own, waited for in its turn', () async {
      final ScriptedServer server = ScriptedServer();
      int asked = 0;
      server.answer('POST', '/dashboard-queries', (HttpCall call) {
        asked += 1;
        if (asked == 1) return _job('run-1');
        if (asked == 2) return _job('run-2');
        return FakeTransport.json(200, rateAnswer());
      });
      server.on('GET', '/bi/query-runs/:id', (_) => <String, Object?>{'status': 'COMPLETED'});
      final RawQuery done = await BiQueryService(client: _client(server), polling: _polling(attempts: 4)).run(metricVersionId: metricRate, snapshotId: snapA);
      expect(done.result.metricCode, 'DISBURSEMENT_RATE');
      expect(asked, 3);
    });
  });

  group('AC-ST-MOB-027-1 UAT-AC34 a step down and the renewal', () {
    test('a drill is asked with the token of the group and the dimension to cut by', () async {
      final ScriptedServer server = ScriptedServer()..on('GET', '/bi/drill', (_) => paidAnswer());
      final RawQuery step = await BiQueryService(client: _client(server), polling: _polling()).explain(drillToken: tokenAUnit, dimension: 'project');
      expect(server.callsTo('GET', '/bi/drill').single.url.queryParameters, <String, String>{'drill_token': tokenAUnit, 'child_dimension': 'project'});
      expect(step.result.snapshotId, snapA);
    });

    test('the renewal gives the newest snapshot of the period and a new token', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', '/bi/query-contexts/refresh', (_) => <String, Object?>{'operation_id': 'o', 'status': 'OK', 'resource_version': 1, 'snapshot_id': snapB, 'drill_token': tokenB});
      final RenewedContext renewed = await BiQueryService(client: _client(server), polling: _polling()).renew(tokenA);
      expect(renewed.snapshotId, snapB);
      expect(renewed.drillToken, tokenB);
      expect(_body(server.callsTo('POST', '/bi/query-contexts/refresh').single), <String, Object?>{'drill_token': tokenA});
    });

    test('a renewal whose answer was lost is sent again under the same key: the context is made once', () async {
      final ScriptedServer server = ScriptedServer();
      int asked = 0;
      server.answer('POST', '/bi/query-contexts/refresh', (HttpCall call) {
        asked += 1;
        if (asked == 1) throw const SocketException('lost');
        return FakeTransport.json(200, <String, Object?>{'snapshot_id': snapB, 'drill_token': tokenB});
      });
      final BiQueryService service = BiQueryService(client: _client(server), polling: _polling());
      await expectLater(service.renew(tokenA), throwsA(isA<ApiError>().having((ApiError e) => e.code, 'code', networkErrorCode)));
      await service.renew(tokenA);
      final List<HttpCall> calls = server.callsTo('POST', '/bi/query-contexts/refresh');
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
    });

    test('a renewal that is refused ends its intention: the next one has a new key', () async {
      final ScriptedServer server = ScriptedServer()..refuse('POST', '/bi/query-contexts/refresh', 400, 'DRILL_TOKEN_INVALID');
      final BiQueryService service = BiQueryService(client: _client(server), polling: _polling());
      await expectLater(service.renew(tokenA), throwsA(isA<ApiError>()));
      await expectLater(service.renew(tokenA), throwsA(isA<ApiError>()));
      final List<HttpCall> calls = server.callsTo('POST', '/bi/query-contexts/refresh');
      expect(calls[1].headers['idempotency-key'], isNot(calls[0].headers['idempotency-key']));
    });

    test('a renewal without a snapshot or a token in the answer is a contract mismatch', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', '/bi/query-contexts/refresh', (_) => <String, Object?>{'status': 'OK'});
      await expectLater(BiQueryService(client: _client(server), polling: _polling()).renew(tokenA), throwsA(isA<ContractMismatch>()));
    });
  });

  group('AC-ST-MOB-027-1 a refusal is told in the words of the web', () {
    ApiError api(String code, int status) => ApiError(status: status, code: code, correlationId: 'c');

    test('the codes of the query, the drill and the renewal are told apart', () {
      expect(problemOfFailure(api('ACCESS_POLICY_MISSING', 403)), QueryProblem.policy);
      expect(problemOfFailure(api('DIMENSION_NOT_IN_DATASET', 422)), QueryProblem.dimension);
      expect(problemOfFailure(api('METRIC_NOT_CERTIFIED', 422)), QueryProblem.metric);
      expect(problemOfFailure(api('SNAPSHOT_NOT_FOUND', 404)), QueryProblem.snapshot);
      expect(problemOfFailure(api('SCOPE_DENIED', 403)), QueryProblem.scope);
      expect(problemOfFailure(api('DRILL_TOKEN_INVALID', 400)), QueryProblem.token);
      expect(problemOfFailure(api('SNAPSHOT_EXPIRED', 409)), QueryProblem.expired);
      expect(problemOfFailure(api('VALIDATION_FAILED', 422)), QueryProblem.invalid);
      expect(problemOfFailure(api('FIELD_NOT_ALLOWED', 422)), QueryProblem.invalid);
      expect(problemOfFailure(api('INVALID_REQUEST', 400)), QueryProblem.invalid);
      expect(problemOfFailure(api('SESSION_EXPIRED', 401)), QueryProblem.session);
      expect(problemOfFailure(api('SOMETHING_NEW', 500)), QueryProblem.general);
      expect(problemOfFailure(StateError('x')), QueryProblem.general);
    });

    test('a job that is still running, timed out, or lost its scope is told, and a job that ended with a code of the query is told by it', () {
      expect(problemOfFailure(const QueryStillRunning('r')), QueryProblem.running);
      expect(problemOfFailure(const QueryJobEnded('TIMEOUT', null)), QueryProblem.timeout);
      expect(problemOfFailure(const QueryJobEnded('FAILED', 'SCOPE_CHANGED')), QueryProblem.changed);
      expect(problemOfFailure(const QueryJobEnded('FAILED', 'ACCESS_POLICY_MISSING')), QueryProblem.policy);
      expect(problemOfFailure(const QueryJobEnded('FAILED', null)), QueryProblem.general);
    });

    test('the stable code behind a failure is the one under the sentence', () {
      expect(problemCodeOf(api('SNAPSHOT_EXPIRED', 409)), 'SNAPSHOT_EXPIRED');
      expect(problemCodeOf(const ContractMismatch('response', 'x')), 'CONTRACT_MISMATCH');
      expect(problemCodeOf(const QueryJobEnded('FAILED', 'SCOPE_CHANGED')), 'SCOPE_CHANGED');
      expect(problemCodeOf(const QueryJobEnded('TIMEOUT', null)), 'TIMEOUT');
      expect(problemCodeOf(const QueryStillRunning('r')), isNull);
      expect(problemCodeOf(StateError('x')), 'CLIENT_ERROR');
    });
  });
}
