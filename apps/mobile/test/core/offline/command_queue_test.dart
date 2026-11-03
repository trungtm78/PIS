import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';

import '../../support/fake_sync_server.dart';
import '../../support/queue_rig.dart';

const String reportA = '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a01';
const String reportB = '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a02';

QueuedCommand submit(QueueRig rig, {String report = reportA, int version = 3, CommandAttempt? attempt, String? draftId}) => rig.queue.enqueue(
      commandType: 'report.submit',
      payload: <String, Object?>{'report_id': report},
      baseServerVersion: version,
      attempt: attempt,
      draftId: draftId,
      releaseDraft: draftId != null,
    );

LocalDraft draft(QueueRig rig, {String id = 'draft-0000000000000001', Map<String, Object?>? fields}) {
  final LocalDraft value = LocalDraft(
    id: id,
    tenantId: 'tenant-a',
    userId: 'user-1',
    kind: 'report',
    recordId: reportA,
    fields: fields ?? <String, Object?>{'construction_vnd': '130000000'},
    baseServerVersion: 3,
    status: DraftStatus.editing,
    createdAt: 1,
    updatedAt: 1,
  );
  rig.store.drafts.upsert(value);
  return value;
}

void main() {
  group('AC-ST-MOB-005-1 UAT-AC502 a submit whose answer is lost is unknown, then looked up, never created again', () {
    test('the connection is cut after the server did the work: UNKNOWN, then ACCEPTED by the lookup, one effect, no new batch', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.server.dropNextBatchAnswer = true;

      final FlushResult first = await rig.queue.flush();
      expect(first.blocker, FlushBlocker.offline);
      expect(rig.queue.command(command.id)!.state, CommandState.unknown);
      expect(rig.queue.command(command.id)!.payload, isNotNull, reason: 'what is unknown keeps its data');
      expect(rig.server.batchPosts, 1);

      final FlushResult second = await rig.queue.flush();
      expect(second.looked, 1);
      expect(second.accepted, 1);
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      expect(rig.server.effectsOf(command.idempotencyKey), 1, reason: 'the server holds one revision');
      expect(rig.server.batchPosts, 1, reason: 'the client sent no new command');
      expect(rig.server.lookups, 1);
    });

    test('a request that never left is unknown too, and the lookup finds nothing: the same command is sent again under the same key', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.server.offline = true;
      expect((await rig.queue.flush()).blocker, FlushBlocker.offline);
      expect(rig.queue.command(command.id)!.state, CommandState.unknown);

      rig.server.offline = false;
      final FlushResult result = await rig.queue.flush();
      expect(result.accepted, 1);
      final QueuedCommand settled = rig.queue.command(command.id)!;
      expect(settled.state, CommandState.accepted);
      expect(settled.idempotencyKey, command.idempotencyKey, reason: 'one intention is one key');
      expect(rig.server.effectsOf(command.idempotencyKey), 1);
      final Map<String, Object?> second = jsonDecode(rig.server.batches.last.body!) as Map<String, Object?>;
      expect(((second['items']! as List<Object?>).single! as Map<String, Object?>)['idempotency_key'], command.idempotencyKey);
    });

    test('the lookup answers rejected or conflict: the command takes that outcome and is not sent again', () async {
      final QueueRig rig = await QueueRig.create(server: FakeSyncServer(decide: (Map<String, Object?> item) => item['base_server_version'] == 1 ? const ServerOutcome.rejected('PERIOD_LOCKED') : const ServerOutcome.conflict()));
      final QueuedCommand locked = submit(rig, version: 1);
      final QueuedCommand moved = submit(rig, report: reportB, version: 2);
      rig.server.dropNextBatchAnswer = true;
      await rig.queue.flush();
      expect(rig.queue.commands(states: <CommandState>{CommandState.unknown}), hasLength(2));
      final FlushResult result = await rig.queue.flush();
      expect(result.rejected, 1);
      expect(result.conflicts, 1);
      expect(rig.queue.command(locked.id)!.state, CommandState.rejected);
      expect(rig.queue.command(locked.id)!.errorCode, 'PERIOD_LOCKED');
      expect(rig.queue.command(moved.id)!.state, CommandState.conflict);
      expect(rig.server.batchPosts, 1);
    });

    test('an unknown command is never discarded: it may have been carried out', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.server.offline = true;
      await rig.queue.flush();
      expect(() => rig.queue.discard(command.id), throwsStateError);
      expect(rig.queue.command(command.id)!.state, CommandState.unknown);
    });

    test('a command found sending after the app was killed becomes unknown, not queued', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.store.commands.move(command.id, CommandState.sending, (QueuedCommand c) => c);
      expect(rig.queue.recoverInterrupted(), 1);
      expect(rig.queue.command(command.id)!.state, CommandState.unknown);
      expect(rig.queue.command(command.id)!.errorCode, 'INTERRUPTED');
      final FlushResult result = await rig.queue.flush();
      expect(result.looked, 1);
      expect(result.accepted, 1, reason: 'the lookup finds nothing, so it is sent again under the same key');
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      expect(rig.server.effectsOf(command.idempotencyKey), 1);
    });

    test('the state is written before the request leaves', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      CommandState? seenByServer;
      rig.server.decide = (Map<String, Object?> item) {
        seenByServer = rig.store.commands.byId(command.id)!.state;
        return const ServerOutcome.accepted();
      };
      await rig.queue.flush();
      expect(seenByServer, CommandState.sending);
    });

    test('after seven days a command the server does not know proves nothing, so it is not sent again', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.server.offline = true;
      await rig.queue.flush();
      rig.server.offline = false;
      rig.clock.advance(const Duration(days: 7, minutes: 1));
      await rig.queue.flush();
      final QueuedCommand settled = rig.queue.command(command.id)!;
      expect(settled.state, CommandState.rejected);
      expect(settled.errorCode, 'RESULT_UNVERIFIABLE');
      expect(rig.server.effectsOf(command.idempotencyKey), 0);
    });

    test('REVIEW-m1-2 such a command is not retried under a new key by the ordinary retry: it may have been carried out, so only the person who checked the record can send it again', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.server.dropNextBatchAnswer = true;
      await rig.queue.flush();
      rig.server.forgetReceipts();
      rig.clock.advance(const Duration(days: 7, minutes: 1));
      await rig.queue.flush();
      expect(rig.queue.command(command.id)!.errorCode, 'RESULT_UNVERIFIABLE');
      final int batches = rig.server.batchPosts;

      await expectLater(rig.queue.retry(command.id), throwsA(isA<ResultUnverifiable>()));
      final QueuedCommand still = rig.queue.command(command.id)!;
      expect(still.state, CommandState.rejected);
      expect(still.idempotencyKey, command.idempotencyKey, reason: 'no new key was made for work that may have been done');
      expect(still.supersededKeys, isEmpty);
      expect(rig.server.batchPosts, batches, reason: 'nothing was sent');
      expect(rig.server.effectsOf(command.idempotencyKey), 1, reason: 'the server did carry it out once, and still does');

      await rig.queue.retry(command.id, confirmedNotExecuted: true);
      final QueuedCommand decided = rig.queue.command(command.id)!;
      expect(decided.idempotencyKey, isNot(command.idempotencyKey), reason: 'the explicit decision of the person is a new command');
      expect(decided.supersededKeys, <String>[command.idempotencyKey]);
      expect(decided.state, CommandState.accepted);
    });

    test('REVIEW-m1-2 the person can always drop an unverifiable command', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.server.offline = true;
      await rig.queue.flush();
      rig.server.offline = false;
      rig.clock.advance(const Duration(days: 8));
      await rig.queue.flush();
      expect(rig.queue.command(command.id)!.errorCode, 'RESULT_UNVERIFIABLE');
      rig.queue.discard(command.id);
      expect(rig.queue.command(command.id)!.state, CommandState.discarded);
    });
  });

  group('AC-ST-MOB-005-2 UAT-AC503 one key is one command', () {
    test('the same attempt gives the same command; the same key with another body is refused before it is queued', () async {
      final QueueRig rig = await QueueRig.create();
      const CommandAttempt attempt = CommandAttempt('c0000000-0000-4000-8000-000000000001');
      final QueuedCommand first = submit(rig, attempt: attempt);
      expect(submit(rig, attempt: attempt).id, first.id);
      expect(rig.queue.commands(), hasLength(1));
      expect(() => submit(rig, report: reportB, attempt: attempt), throwsA(isA<IdempotencyKeyReuse>()));
      expect(() => submit(rig, version: 9, attempt: attempt), throwsA(isA<IdempotencyKeyReuse>()));
      expect(rig.queue.commands(), hasLength(1));
    });

    test('when the server reports IDEMPOTENCY_CONFLICT for a command, the first answer stands and this one is rejected, not retried', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      await rig.queue.flush();
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      // Another command arrives under the key of the first (as if the key had been reused by mistake).
      final QueueRig other = await QueueRig.create(server: rig.server, storage: rig.storage, session: const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-2'));
      final QueuedCommand clash = other.queue.enqueue(
        commandType: 'report.submit',
        payload: <String, Object?>{'report_id': reportB},
        baseServerVersion: 9,
        attempt: CommandAttempt(command.idempotencyKey),
      );
      await other.queue.flush();
      expect(other.queue.command(clash.id)!.state, CommandState.rejected);
      expect(other.queue.command(clash.id)!.errorCode, 'IDEMPOTENCY_CONFLICT');
      expect(rig.server.effectsOf(command.idempotencyKey), 1);
    });

    test('a corrected or resolved command is a new decision with a new key, and the old key can never be used again', () async {
      final QueueRig rig = await QueueRig.create(server: FakeSyncServer(decide: (Map<String, Object?> item) => const ServerOutcome.rejected('PERIOD_LOCKED')));
      final QueuedCommand command = submit(rig);
      await rig.queue.flush();
      rig.server.decide = (Map<String, Object?> item) => const ServerOutcome.accepted();
      await rig.queue.retry(command.id);
      final QueuedCommand renewed = rig.queue.command(command.id)!;
      expect(renewed.state, CommandState.accepted);
      expect(renewed.idempotencyKey, isNot(command.idempotencyKey));
      expect(renewed.supersededKeys, <String>[command.idempotencyKey]);
      expect(() => submit(rig, attempt: CommandAttempt(command.idempotencyKey)), throwsA(isA<IdempotencyKeyReuse>()));
    });

    test('every send of the batch carries a fresh Idempotency-Key, and a key of the command is 16 to 128 characters', () async {
      final QueueRig rig = await QueueRig.create();
      submit(rig);
      rig.server.offline = true;
      await rig.queue.flush();
      rig.server.offline = false;
      submit(rig, report: reportB);
      await rig.queue.flush();
      final Set<String?> keys = rig.server.batches.map((c) => c.headers['idempotency-key']).toSet();
      expect(keys, hasLength(2));
      expect(() => submit(rig, attempt: const CommandAttempt('short')), throwsArgumentError);
      expect(() => rig.queue.enqueue(commandType: '', payload: <String, Object?>{}), throwsArgumentError);
      expect(() => rig.queue.enqueue(commandType: 'x', payload: <String, Object?>{}, baseServerVersion: -1), throwsArgumentError);
    });
  });

  group('AC-ST-MOB-005-3 UAT-AC358 one refusal does not fail the batch', () {
    test('five commands, one rejected: the four valid ones are accepted, the answer is read item by item', () async {
      final QueueRig rig = await QueueRig.create(server: FakeSyncServer(decide: (Map<String, Object?> item) => (item['payload']! as Map<String, Object?>)['n'] == 3 ? const ServerOutcome.rejected('VALIDATION_FAILED') : const ServerOutcome.accepted()));
      for (int n = 1; n <= 5; n += 1) {
        rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': n});
      }
      final FlushResult result = await rig.queue.flush();
      expect(result.accepted, 4);
      expect(result.rejected, 1);
      expect(rig.server.batchPosts, 1, reason: 'one batch carried all five');
      final Map<int, CommandState> byN = <int, CommandState>{};
      for (final QueuedCommand c in rig.queue.commands()) {
        byN[(jsonDecode(jsonEncode(c.payload ?? <String, Object?>{'n': -1})) as Map<String, Object?>)['n']! as int] = c.state;
      }
      expect(rig.queue.commands(states: <CommandState>{CommandState.rejected}).single.errorCode, 'VALIDATION_FAILED');
      expect(rig.queue.commands(states: <CommandState>{CommandState.accepted}), hasLength(4));
      expect(byN[-1], CommandState.accepted, reason: 'an accepted command keeps no data');
    });

    test('a batch carries at most 50 commands and the rest go in the next one, in the order they were made', () async {
      final QueueRig rig = await QueueRig.create();
      for (int n = 1; n <= 53; n += 1) {
        rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': n});
      }
      await rig.queue.flush();
      final List<Object?> sent = (jsonDecode(rig.server.batches.single.body!) as Map<String, Object?>)['items']! as List<Object?>;
      expect(sent, hasLength(50));
      expect(((sent.first! as Map<String, Object?>)['payload']! as Map<String, Object?>)['n'], 1);
      expect(rig.queue.commands(states: <CommandState>{CommandState.queued}), hasLength(3));
      await rig.queue.flush();
      expect(rig.queue.commands(states: <CommandState>{CommandState.accepted}), hasLength(53));
    });

    test('a conflict is read with the version the server holds and the command waits for the person', () async {
      final QueueRig rig = await QueueRig.create(server: FakeSyncServer(decide: (Map<String, Object?> item) => const ServerOutcome.conflict(code: 'DRAFT_VERSION_CONFLICT', version: 7)));
      final QueuedCommand command = submit(rig);
      final FlushResult result = await rig.queue.flush();
      expect(result.conflicts, 1);
      final QueuedCommand stored = rig.queue.command(command.id)!;
      expect(stored.state, CommandState.conflict);
      expect(stored.serverVersion, 7);
      expect(stored.errorCode, 'DRAFT_VERSION_CONFLICT');
      expect(stored.payload, isNotNull);
    });
  });

  group('TK-MOB-005-4 retry, backoff and the failures of the batch', () {
    test('what the server did not keep (a 5xx of the operation) comes back to the queue with a growing wait, under the same key', () async {
      final QueueRig rig = await QueueRig.create(server: FakeSyncServer(decide: (Map<String, Object?> item) => const ServerOutcome.transient('UNAVAILABLE')));
      final QueuedCommand command = submit(rig);
      await rig.queue.flush();
      QueuedCommand c = rig.queue.command(command.id)!;
      expect(c.state, CommandState.queued);
      expect(c.attempts, 1);
      expect(c.nextAttemptAt - rig.clock.call().millisecondsSinceEpoch, 2000);
      expect(rig.queue.nextDueAt, DateTime.fromMillisecondsSinceEpoch(c.nextAttemptAt));

      await rig.queue.flush();
      expect(rig.server.batchPosts, 1, reason: 'not before the wait is over');
      rig.clock.advance(const Duration(seconds: 2));
      await rig.queue.flush();
      c = rig.queue.command(command.id)!;
      expect(c.attempts, 2);
      expect(c.nextAttemptAt - rig.clock.call().millisecondsSinceEpoch, 4000);
      expect(c.idempotencyKey, command.idempotencyKey);

      rig.server.decide = (Map<String, Object?> item) => const ServerOutcome.accepted();
      rig.clock.advance(const Duration(seconds: 4));
      await rig.queue.flush();
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      expect(rig.server.effectsOf(command.idempotencyKey), 1);
    });

    test('the wait is capped and a retry makes the command due at once', () async {
      final QueueRig rig = await QueueRig.create(server: FakeSyncServer(decide: (Map<String, Object?> item) => const ServerOutcome.transient()));
      final QueuedCommand command = submit(rig);
      for (int i = 0; i < 12; i += 1) {
        rig.clock.advance(const Duration(minutes: 6));
        await rig.queue.flush();
      }
      final QueuedCommand c = rig.queue.command(command.id)!;
      expect(c.nextAttemptAt - rig.clock.call().millisecondsSinceEpoch, const Duration(minutes: 5).inMilliseconds);
      final int before = rig.server.batchPosts;
      await rig.queue.retry(command.id);
      expect(rig.server.batchPosts, before + 1);
    });

    test('a lapsed session (401) keeps the commands queued and says so; a refused device (403) keeps them too', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.server.failNext = (status: 401, code: 'SESSION_EXPIRED');
      expect((await rig.queue.flush()).blocker, FlushBlocker.sessionExpired);
      expect(rig.queue.command(command.id)!.state, CommandState.queued);
      expect(rig.queue.command(command.id)!.attempts, 0);
      rig.server.failNext = (status: 403, code: 'SCOPE_DENIED');
      expect((await rig.queue.flush()).blocker, FlushBlocker.deviceRejected);
      expect(rig.queue.command(command.id)!.state, CommandState.queued);
      expect((await rig.queue.flush()).accepted, 1);
    });

    test('a server that is busy (503 PROVIDER_UNAVAILABLE, 429) did nothing, so the commands wait with a backoff', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.server.failNext = (status: 503, code: 'PROVIDER_UNAVAILABLE');
      expect((await rig.queue.flush()).blocker, FlushBlocker.busy);
      expect(rig.queue.command(command.id)!.state, CommandState.queued);
      expect(rig.queue.command(command.id)!.attempts, 1);
      rig.clock.advance(const Duration(seconds: 3));
      rig.server.failNext = (status: 429, code: 'RATE_LIMITED');
      expect((await rig.queue.flush()).blocker, FlushBlocker.busy);
    });

    test('a failure of the server after it may have started (500) leaves the commands unknown, to be looked up', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.server.failNext = (status: 500, code: 'INTERNAL_ERROR');
      expect((await rig.queue.flush()).blocker, FlushBlocker.serverError);
      expect(rig.queue.command(command.id)!.state, CommandState.unknown);
      expect((await rig.queue.flush()).accepted, 1);
    });

    test('a refusal of the whole batch (a lapsed licence) rejects the commands with its code and keeps their drafts', () async {
      final QueueRig rig = await QueueRig.create();
      final LocalDraft saved = draft(rig);
      final QueuedCommand command = submit(rig, draftId: saved.id);
      rig.server.failNext = (status: 422, code: 'LICENSE_EXPIRED');
      await rig.queue.flush();
      expect(rig.queue.command(command.id)!.state, CommandState.rejected);
      expect(rig.queue.command(command.id)!.errorCode, 'LICENSE_EXPIRED');
      expect(rig.store.drafts.byId(saved.id)!.status, DraftStatus.blocked);
      expect(rig.store.drafts.byId(saved.id)!.fields, saved.fields);
    });

    test('an answer that does not match the contract leaves the commands unknown rather than lost', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      rig.server.decide = (Map<String, Object?> item) => throw StateError('unused');
      rig.server.failNext = null;
      // A batch result that names a different key: the command is not answered, so it is unknown.
      final QueueRig odd = await QueueRig.create(server: _NamelessServer(), storage: rig.storage, session: const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-3'));
      final QueuedCommand lonely = odd.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});
      final FlushResult result = await odd.queue.flush();
      expect(result.unknown, 1);
      expect(odd.queue.command(lonely.id)!.state, CommandState.unknown);
      expect(command.state, CommandState.queued);
    });

    test('nothing is sent without a session of this tenant and user, or without a device; the commands wait', () async {
      final QueueRig signedOut = await QueueRig.create(session: const SessionSnapshot.signedOut());
      expect((await signedOut.queue.flush()).blocker, FlushBlocker.noSession);
      final QueueRig noDevice = await QueueRig.create(deviceId: null);
      submit(noDevice);
      expect((await noDevice.queue.flush()).blocker, FlushBlocker.noDevice);
      expect(noDevice.server.calls, isEmpty);
      // The queue of tenant-b is bound to tenant-b; a session that moved to tenant-a does not make it send.
      final QueueRig moved = await QueueRig.create(session: kSignedInA, storeTenantId: 'tenant-b');
      moved.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{});
      expect((await moved.queue.flush()).blocker, FlushBlocker.noSession);
      final QueueRig otherUser = await QueueRig.create(session: kSignedInA, storeUserId: 'user-2');
      expect((await otherUser.queue.flush()).blocker, FlushBlocker.noSession);
      expect(moved.server.calls, isEmpty);
    });

    test('a command made under another tenant is never sent by this queue (the envelope is checked at the door)', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand mine = submit(rig);
      rig.store.commands.insert(const QueuedCommand(
        id: 'foreign-command-0001',
        tenantId: 'tenant-b',
        userId: 'user-1',
        commandType: 'issue.create',
        payload: <String, Object?>{'n': 1},
        payloadBytes: 8,
        baseServerVersion: 0,
        idempotencyKey: 'foreign-key-0000000001',
        state: CommandState.queued,
        createdAt: 0,
        updatedAt: 0,
      ));
      await rig.queue.flush();
      final List<Object?> sent = (jsonDecode(rig.server.batches.single.body!) as Map<String, Object?>)['items']! as List<Object?>;
      expect(sent.map((Object? i) => (i! as Map<String, Object?>)['idempotency_key']), <Object?>[mine.idempotencyKey]);
      expect(rig.queue.command('foreign-command-0001')!.state, CommandState.queued);
    });
  });

  group('TK-MOB-005-4 the decisions of the person', () {
    test('a rejected command can be sent again as a new decision, or discarded; its draft stays', () async {
      final QueueRig rig = await QueueRig.create(server: FakeSyncServer(decide: (Map<String, Object?> item) => const ServerOutcome.rejected('PERIOD_LOCKED')));
      final LocalDraft saved = draft(rig);
      final QueuedCommand command = submit(rig, draftId: saved.id);
      await rig.queue.flush();
      expect(rig.queue.command(command.id)!.state, CommandState.rejected);
      rig.queue.discard(command.id);
      final QueuedCommand dropped = rig.queue.command(command.id)!;
      expect(dropped.state, CommandState.discarded);
      expect(dropped.payload, isNull);
      expect(rig.store.drafts.byId(saved.id)!.status, DraftStatus.editing);
      expect(() => rig.queue.discard(command.id), throwsStateError);
      expect(() => rig.queue.retry(command.id), throwsStateError);
    });

    test('a queued command can be discarded together with its draft', () async {
      final QueueRig rig = await QueueRig.create();
      final LocalDraft saved = draft(rig);
      final QueuedCommand command = submit(rig, draftId: saved.id);
      expect(rig.store.drafts.byId(saved.id)!.status, DraftStatus.queued);
      rig.queue.discard(command.id, deleteDraft: true);
      expect(rig.store.drafts.byId(saved.id), isNull);
      expect(rig.queue.unsentCount, 0);
    });

    test('an accepted submit releases its draft, an accepted save keeps it at the new version', () async {
      final QueueRig rig = await QueueRig.create();
      final LocalDraft one = draft(rig);
      final LocalDraft two = draft(rig, id: 'draft-0000000000000002');
      submit(rig, draftId: one.id);
      rig.queue.enqueue(commandType: 'report.draft.save', payload: <String, Object?>{'report_id': reportB}, baseServerVersion: 3, draftId: two.id);
      await rig.queue.flush();
      expect(rig.store.drafts.byId(one.id), isNull);
      final LocalDraft kept = rig.store.drafts.byId(two.id)!;
      expect(kept.status, DraftStatus.synced);
      expect(kept.baseServerVersion, 2, reason: 'the version the server answered');
      expect(kept.fields, two.fields);
      expect(() => rig.queue.enqueue(commandType: 'x', payload: <String, Object?>{}, draftId: 'no-such-draft'), throwsArgumentError);
    });

    test('the queue tells the screens what happens: events carry the move and what it became', () async {
      final QueueRig rig = await QueueRig.create(server: FakeSyncServer(decide: (Map<String, Object?> item) => item['base_server_version'] == 1 ? const ServerOutcome.rejected('PERIOD_LOCKED') : const ServerOutcome.conflict()));
      final List<QueueEvent> events = <QueueEvent>[];
      final sub = rig.queue.events.listen(events.add);
      submit(rig, version: 1);
      submit(rig, report: reportB, version: 2);
      await rig.queue.flush();
      await Future<void>.delayed(Duration.zero);
      expect(events.where((QueueEvent e) => e.becamePeriodLocked), hasLength(1));
      expect(events.where((QueueEvent e) => e.becameConflict), hasLength(1));
      expect(events.where((QueueEvent e) => e.becameAccepted), isEmpty);
      await sub.cancel();
    });

    test('watch shows the queue now and after every change, and the counts add up', () async {
      final QueueRig rig = await QueueRig.create();
      final List<List<CommandState>> seen = <List<CommandState>>[];
      final sub = rig.queue.watch().listen((List<QueuedCommand> list) => seen.add(<CommandState>[for (final QueuedCommand c in list) c.state]));
      await Future<void>.delayed(Duration.zero);
      submit(rig);
      await Future<void>.delayed(Duration.zero);
      expect(rig.queue.stats().queued, 1);
      expect(rig.queue.stats().pendingBytes, greaterThan(0));
      expect(rig.queue.stats().oldestPendingAgeMs, 0);
      expect(rig.queue.unsentCount, 1);
      await rig.queue.flush();
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();
      expect(seen.first, isEmpty);
      expect(seen, anyElement(equals(<CommandState>[CommandState.queued])));
      expect(seen.last, <CommandState>[CommandState.accepted]);
      expect(rig.queue.stats().unknownRate, 0);
      expect(rig.queue.unsentCount, 0);
    });

    test('the share of unknown among the sent is what the alert watches', () async {
      final QueueRig rig = await QueueRig.create();
      submit(rig);
      await rig.queue.flush();
      submit(rig, report: reportB);
      rig.server.offline = true;
      await rig.queue.flush();
      final QueueStats stats = rig.queue.stats();
      expect(stats.unknown, 1);
      expect(stats.accepted, 1);
      expect(stats.unknownRate, 0.5);
      expect(stats.pending, 1);
    });

    test('settled receipts are pruned after seven days and not before', () async {
      final QueueRig rig = await QueueRig.create();
      submit(rig);
      await rig.queue.flush();
      rig.clock.advance(const Duration(days: 6));
      expect(rig.store.commands.pruneSettled(rig.clock.call().millisecondsSinceEpoch - kReceiptRetention.inMilliseconds), 0);
      rig.clock.advance(const Duration(days: 2));
      expect(rig.store.commands.pruneSettled(rig.clock.call().millisecondsSinceEpoch - kReceiptRetention.inMilliseconds), 1);
      expect(rig.queue.commands(), isEmpty);
    });
  });

  group('state machine', () {
    test('accepted and discarded are final; sending cannot be discarded; a queued command cannot be accepted without being sent', () {
      expect(kAllowedMoves[CommandState.accepted], isEmpty);
      expect(kAllowedMoves[CommandState.discarded], isEmpty);
      expect(canMove(CommandState.sending, CommandState.discarded), isFalse);
      expect(canMove(CommandState.queued, CommandState.accepted), isFalse);
      expect(canMove(CommandState.unknown, CommandState.discarded), isFalse);
      expect(canMove(CommandState.conflict, CommandState.queued), isTrue);
      expect(canMove(CommandState.unknown, CommandState.queued), isTrue);
      expect(CommandState.queued.isPending && CommandState.sending.isPending && CommandState.unknown.isPending, isTrue);
      expect(CommandState.rejected.isPending, isFalse);
      expect(CommandState.accepted.isSettled && CommandState.discarded.isSettled, isTrue);
    });

    test('the repository refuses a move the design does not allow and changes nothing', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand command = submit(rig);
      expect(() => rig.store.commands.move(command.id, CommandState.accepted, (QueuedCommand c) => c), throwsStateError);
      expect(rig.queue.command(command.id)!.state, CommandState.queued);
      expect(() => rig.store.commands.move('nope', CommandState.sending, (QueuedCommand c) => c), throwsStateError);
      expect(() => rig.store.commands.update(command.id, (QueuedCommand c) => c.copyWith(state: CommandState.sending)), throwsStateError);
      expect(() => rig.store.commands.update('nope', (QueuedCommand c) => c), throwsStateError);
    });
  });
}

/// A server that answers a batch with a result for another key, as a broken proxy might.
class _NamelessServer extends FakeSyncServer {
  @override
  Future<HttpResult> send(HttpCall call) async {
    if (call.method == 'POST') {
      return HttpResult(
        status: 200,
        headers: const <String, String>{'content-type': 'application/json'},
        body: jsonEncode(<String, Object?>{
          'results': <Object?>[
            <String, Object?>{'idempotency_key': 'someone-elses-key-0001', 'status': 'accepted'},
          ],
        }),
      );
    }
    return super.send(call);
  }
}
