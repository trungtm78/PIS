import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';

import '../support/fake_sync_server.dart';
import '../support/queue_rig.dart';

/// A server whose process can be killed in the middle of a batch: before it did the work, or after it did and before it answered
/// (the phone is gone by then, so the answer is never read).
class KillableServer extends FakeSyncServer {
  KillableServer({super.decide});

  bool killBeforeWork = false;
  bool killAfterWork = false;

  @override
  Future<HttpResult> send(HttpCall call) async {
    final bool batch = call.method == 'POST' && call.url.path.endsWith('/sync/batches');
    if (batch && killBeforeWork) {
      killBeforeWork = false;
      calls.add(call);
      return Completer<HttpResult>().future;
    }
    final HttpResult answer = await super.send(call);
    if (batch && killAfterWork) {
      killAfterWork = false;
      return Completer<HttpResult>().future;
    }
    return answer;
  }
}

const int _submissions = 8;

/// What the seeded runs met, so that the matrix is shown to have reached the cases it claims (a run that never lost an answer proves nothing).
int _unknownAfterWork = 0;
int _unknownBeforeWork = 0;

String _report(int n) => '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a${n.toString().padLeft(2, '0')}';

Map<String, Object?> _fields(int n) => <String, Object?>{
      'report_id': _report(n),
      'construction_vnd': '${130000000 + n}',
      'note': 'Ghi chú ngoài công trường số $n',
      'funding_lines': <Object?>[
        <String, Object?>{'bucket': 'CURRENT_YEAR', 'cumulative_vnd': '${n * 1000}.50'},
      ],
    };

/// The phone is killed and started again: a new queue on the same encrypted store, as the provider builds it at start. A kill the
/// old process never reached (it had nothing to send) is not carried over into the new life of the phone.
Future<QueueRig> _restart(QueueRig old, int generation) async {
  final FakeSyncServer server = old.server;
  if (server is KillableServer) {
    server.killBeforeWork = false;
    server.killAfterWork = false;
  }
  final QueueRig fresh = await QueueRig.create(storage: old.storage, server: old.server, clock: old.clock, keyStart: 1000 * generation);
  fresh.queue.recoverInterrupted();
  return fresh;
}

void main() {
  group('AC-ST-MOB-040-3 UAT-AC502 network flapping and an app killed during a send: one record for each submission, no field lost, no message ahead of the server', () {
    for (int seed = 1; seed <= 24; seed += 1) {
      test('seed $seed: eight submissions through cut networks, lost answers, kills and server failures', () async {
        final Map<String, Map<String, Object?>> received = <String, Map<String, Object?>>{};
        final KillableServer server = KillableServer(
          decide: (Map<String, Object?> item) {
            received[item['idempotency_key']! as String] = (item['payload']! as Map<String, Object?>);
            return const ServerOutcome.accepted();
          },
        );
        final Random random = Random(seed);
        QueueRig rig = await QueueRig.create(server: server);
        int generation = 1;
        final Map<String, Map<String, Object?>> submitted = <String, Map<String, Object?>>{};
        int made = 0;

        void check(String step) {
          final List<QueuedCommand> all = rig.store.commands.inStates(CommandState.values.toSet());
          expect(all, hasLength(made), reason: '$step: exactly one row for each submission');
          for (final QueuedCommand command in all) {
            final int effects = server.effectsOf(command.idempotencyKey);
            expect(effects, lessThanOrEqualTo(1), reason: '$step: ${command.idempotencyKey} was carried out ${effects}x');
            switch (command.state) {
              case CommandState.accepted:
                expect(effects, 1, reason: '$step: a message "accepted" only when the server holds the record');
              case CommandState.queued:
                expect(effects, 0, reason: '$step: "waiting" while the server holds the record would send it a second time');
              case CommandState.unknown:
                if (effects == 1) {
                  _unknownAfterWork += 1;
                } else {
                  _unknownBeforeWork += 1;
                }
                expect(command.payload, isNotNull, reason: '$step: what is unknown keeps its fields');
              case CommandState.sending:
                break;
              case CommandState.rejected || CommandState.conflict || CommandState.discarded:
                fail('$step: ${command.state.name} for a command the server would accept');
            }
          }
        }

        for (int step = 0; step < 36; step += 1) {
          final int action = random.nextInt(8);
          final String name = 'step $step action $action';
          switch (action) {
            case 0 || 1:
              if (made < _submissions) {
                made += 1;
                final QueuedCommand command = rig.queue.enqueue(commandType: 'report.draft.save', payload: _fields(made), baseServerVersion: made);
                submitted[command.idempotencyKey] = _fields(made);
              }
            case 2:
              await rig.queue.flush();
            case 3:
              server.offline = true;
              await rig.queue.flush();
              server.offline = false;
            case 4:
              server.dropNextBatchAnswer = true;
              await rig.queue.flush();
            case 5:
              server.killBeforeWork = true;
              unawaited(rig.queue.flush());
              await pumpEventQueue();
              generation += 1;
              rig = await _restart(rig, generation);
            case 6:
              server.killAfterWork = true;
              unawaited(rig.queue.flush());
              await pumpEventQueue();
              generation += 1;
              rig = await _restart(rig, generation);
            case 7:
              server.failNext = (status: 503, code: 'PROVIDER_UNAVAILABLE');
              await rig.queue.flush();
          }
          rig.clock.advance(Duration(seconds: 1 + random.nextInt(90)));
          check(name);
        }

        // The network is stable now: every submission that is not settled settles, whatever its history.
        while (made < _submissions) {
          made += 1;
          final QueuedCommand command = rig.queue.enqueue(commandType: 'report.draft.save', payload: _fields(made), baseServerVersion: made);
          submitted[command.idempotencyKey] = _fields(made);
        }
        for (int round = 0; round < 12 && rig.store.commands.inStates(<CommandState>{CommandState.queued, CommandState.unknown, CommandState.sending}).isNotEmpty; round += 1) {
          rig.clock.advance(const Duration(minutes: 6));
          if (rig.store.commands.inStates(<CommandState>{CommandState.sending}).isNotEmpty) rig.queue.recoverInterrupted();
          await rig.queue.flush();
          check('settling round $round');
        }

        expect(submitted, hasLength(_submissions));
        for (final MapEntry<String, Map<String, Object?>> entry in submitted.entries) {
          expect(server.effectsOf(entry.key), 1, reason: 'exactly one record for ${entry.key}');
          expect(received[entry.key], entry.value, reason: 'every saved field reached the server unchanged: ${entry.key}');
          expect(rig.store.commands.byKey(entry.key)!.state, CommandState.accepted);
        }
        expect(server.effects.values.fold<int>(0, (int a, int b) => a + b), _submissions, reason: 'and nothing else was created');
      });
    }
  });

  test('AC-ST-MOB-040-3 UAT-AC502 the seeded runs reached both kinds of lost answer: the work was done, and it was not', () {
    expect(_unknownAfterWork, greaterThan(20));
    expect(_unknownBeforeWork, greaterThan(5));
  });

  group('AC-ST-MOB-040-3 UAT-AC502 the message matches the server: unknown until the lookup returns accepted', () {
    test('a lost answer is "unknown" however many times the phone is killed, and becomes "accepted" only when the lookup says so', () async {
      final KillableServer server = KillableServer();
      QueueRig rig = await QueueRig.create(server: server);
      final QueuedCommand command = rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'report_id': _report(1)}, baseServerVersion: 3);

      server.killAfterWork = true;
      unawaited(rig.queue.flush());
      await pumpEventQueue();
      expect(rig.queue.command(command.id)!.state, CommandState.sending, reason: 'the request left and nothing came back');
      expect(server.effectsOf(command.idempotencyKey), 1, reason: 'the server did the work');

      for (int kills = 1; kills <= 3; kills += 1) {
        rig = await _restart(rig, kills + 1);
        expect(rig.queue.command(command.id)!.state, CommandState.unknown, reason: 'after kill $kills the message is "result unknown", not a guess');
        expect(rig.queue.command(command.id)!.state.isPending, isTrue);
      }

      server.offline = true;
      expect((await rig.queue.flush()).blocker, FlushBlocker.offline);
      expect(rig.queue.command(command.id)!.state, CommandState.unknown, reason: 'no lookup reached the server, so nothing changes');

      server.offline = false;
      final FlushResult result = await rig.queue.flush();
      expect(result.looked, 1);
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      expect(server.effectsOf(command.idempotencyKey), 1);
      expect(server.batchPosts, 1, reason: 'the submission was never sent a second time');
    });

    test('a kill before the server did the work is looked up as not received, sent again under the same key, and carried out once', () async {
      final KillableServer server = KillableServer();
      QueueRig rig = await QueueRig.create(server: server);
      final QueuedCommand command = rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'report_id': _report(2)}, baseServerVersion: 3);

      server.killBeforeWork = true;
      unawaited(rig.queue.flush());
      await pumpEventQueue();
      expect(server.effectsOf(command.idempotencyKey), 0);
      rig = await _restart(rig, 2);
      expect(rig.queue.command(command.id)!.state, CommandState.unknown);

      await rig.queue.flush();
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      expect(server.effectsOf(command.idempotencyKey), 1);
    });
  });

  group('AC-ST-MOB-040-3 UAT-AC502 the licence expires and the tenant changes while work is waiting: the fields stay and nothing is created', () {
    test('a licence that expired before the send refuses the command with its code, the draft keeps every field, and no record exists', () async {
      final KillableServer server = KillableServer(decide: (Map<String, Object?> item) => const ServerOutcome.rejected('LICENSE_EXPIRED'));
      final QueueRig rig = await QueueRig.create(server: server);
      final LocalDraft draft = LocalDraft(
        id: 'draft-0000000000000001',
        tenantId: 'tenant-a',
        userId: 'user-1',
        kind: 'report',
        recordId: _report(3),
        fields: _fields(3),
        baseServerVersion: 3,
        status: DraftStatus.editing,
        createdAt: 1,
        updatedAt: 1,
      );
      rig.store.drafts.upsert(draft);
      final QueuedCommand command = rig.queue.enqueue(
        commandType: 'report.submit',
        payload: <String, Object?>{'report_id': _report(3)},
        baseServerVersion: 3,
        draftId: draft.id,
        releaseDraft: true,
      );

      await rig.queue.flush();

      expect(rig.queue.command(command.id)!.state, CommandState.rejected);
      expect(rig.queue.command(command.id)!.errorCode, 'LICENSE_EXPIRED');
      expect(server.effectsOf(command.idempotencyKey), 0);
      expect(rig.store.drafts.byId(draft.id)!.fields, _fields(3), reason: '0 saved fields lost');
    });

    test('a tenant change with a command waiting: the old tenant\'s queue sends nothing, and the work is still there for when the person returns', () async {
      final KillableServer server = KillableServer();
      final QueueRig rig = await QueueRig.create(server: server, storeTenantId: 'tenant-b', storeUserId: 'user-1');
      final QueuedCommand command = rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'report_id': _report(4)}, baseServerVersion: 3);
      // the session of the application is tenant-a (kSignedInA): the queue of tenant-b is not the active one
      expect((await rig.queue.flush()).blocker, FlushBlocker.noSession);
      expect(server.calls, isEmpty);
      expect(rig.queue.command(command.id)!.state, CommandState.queued);
      expect(rig.queue.command(command.id)!.payload, isNotNull);
    });
  });
}
