import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/drafts/conflict_adapter.dart';
import 'package:machvon_mobile/core/offline/drafts/decimal.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_conflict.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_store.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';

import '../../support/fake_sync_server.dart';
import '../../support/queue_rig.dart';
import '../../support/report_fixtures.dart';

void main() {
  group('Decimal', () {
    test('reads the exact text of the contract and nothing else', () {
      expect(Decimal.tryParse('130000000')!.toPlainString(), '130000000');
      expect(Decimal.tryParse('-12.50')!.toPlainString(), '-12.50');
      for (final Object? bad in <Object?>['1e3', '1,5', ' 1', '', '.5', '5.', null, 5, 1.5, '--1']) {
        expect(Decimal.tryParse(bad), isNull, reason: '$bad');
      }
    });

    test('compares and subtracts exactly, whatever the number of decimals', () {
      expect(Decimal.tryParse('80000000.00'), Decimal.tryParse('80000000'));
      expect(Decimal.tryParse('80000000.00').hashCode, Decimal.tryParse('80000000').hashCode);
      expect(Decimal.tryParse('0.1')!.compareTo(Decimal.tryParse('0.10')!), 0);
      expect((Decimal.tryParse('130000000')! - Decimal.tryParse('120000000')!).toPlainString(), '10000000');
      expect((Decimal.tryParse('0.3')! - Decimal.tryParse('0.1')!).toPlainString(), '0.2', reason: 'no floating point');
      expect((Decimal.tryParse('1')! - Decimal.tryParse('1.25')!).toPlainString(), '-0.25');
      expect((Decimal.tryParse('1.50')! - Decimal.tryParse('1.5')!).isZero, isTrue);
      expect((Decimal.tryParse('1')! - Decimal.tryParse('2')!).isNegative, isTrue);
      expect(Decimal.tryParse('99999999999999999999999')! - Decimal.tryParse('1')!, Decimal.tryParse('99999999999999999999998'));
    });

    test('groups the thousands for the language of the person', () {
      expect(Decimal.tryParse('130000000')!.format(separator: '.', decimalMark: ','), '130.000.000');
      expect(Decimal.tryParse('-1234567.50')!.format(separator: ',', decimalMark: '.'), '-1,234,567.5');
      expect(Decimal.tryParse('999')!.format(separator: '.', decimalMark: ','), '999');
      expect(Decimal.tryParse('0.05')!.format(separator: '.', decimalMark: ','), '0,05');
      expect(Decimal.tryParse('-0.00')!.format(separator: '.', decimalMark: ','), '0');
    });
  });

  group('AC-ST-MOB-006-1 UAT-AC504 the comparison of the device and the server', () {
    test('130,000,000 on the device against 120,000,000 on the server is one money difference of 10,000,000, with both amounts', () {
      final DraftConflict conflict = reportConflictAdapter.compare(
        QueuedCommand(
          id: 'c',
          tenantId: 't',
          userId: 'u',
          commandType: 'report.draft.save',
          payload: devicePayload(),
          payloadBytes: 1,
          baseServerVersion: 3,
          idempotencyKey: 'k' * 20,
          state: CommandState.conflict,
          createdAt: 0,
          updatedAt: 0,
        ),
        ServerCopy(version: 7, fields: reportDraftFields(serverView())),
      );
      final FieldDifference volume = conflict.differences.singleWhere((FieldDifference d) => d.path == 'construction_vnd');
      expect(volume.mine, '130000000');
      expect(volume.server, '120000000');
      expect(volume.isMoney, isTrue);
      expect(volume.moneyDelta!.toPlainString(), '10000000');
      expect(conflict.hasMoney, isTrue);
    });

    test('what is the same is not offered: the same amount written with decimals, lines in another order, fields the draft leaves out, the ids', () {
      final DraftConflict conflict = reportConflictAdapter.compare(
        QueuedCommand(
          id: 'c',
          tenantId: 't',
          userId: 'u',
          commandType: 'report.draft.save',
          payload: devicePayload(),
          payloadBytes: 1,
          baseServerVersion: 3,
          idempotencyKey: 'k' * 20,
          state: CommandState.conflict,
          createdAt: 0,
          updatedAt: 0,
        ),
        ServerCopy(version: 7, fields: reportDraftFields(serverView())),
      );
      expect(conflict.differences.map((FieldDifference d) => d.path).toList()..sort(), <String>[
        'construction_vnd',
        'funding_lines[CARRYOVER|LOCAL|].cumulative_vnd',
        'narrative.results',
      ]);
      final FieldDifference line = conflict.differences.singleWhere((FieldDifference d) => d.path.startsWith('funding_lines'));
      expect(line.mine, '65000000');
      expect(line.server, '70000000');
      expect(line.moneyDelta!.toPlainString(), '-5000000');
      final FieldDifference text = conflict.differences.singleWhere((FieldDifference d) => d.path == 'narrative.results');
      expect(text.isMoney, isFalse);
      expect(text.moneyDelta, isNull);
    });

    test('a line on one side only is one difference about the whole line, and it is money when the line holds amounts', () {
      final DraftConflict conflict = DraftConflict.compare(
        mine: <String, Object?>{
          'funding_lines': <Object?>[
            <String, Object?>{'bucket': 'A', 'cumulative_vnd': '5'},
            <String, Object?>{'bucket': 'B', 'cumulative_vnd': '6'},
          ],
        },
        server: <String, Object?>{
          'funding_lines': <Object?>[
            <String, Object?>{'bucket': 'A', 'cumulative_vnd': '5'},
            <String, Object?>{'bucket': 'C', 'cumulative_vnd': '7'},
          ],
        },
        listIdentity: const <String, List<String>>{'funding_lines': <String>['bucket']},
      );
      expect(conflict.differences.map((FieldDifference d) => d.path).toList()..sort(), <String>['funding_lines[B]', 'funding_lines[C]']);
      expect(conflict.differences.every((FieldDifference d) => d.isMoney), isTrue);
      expect(conflict.differences.first.moneyDelta, isNull);
    });

    test('a list without an identity, and a list with a repeated identity, is compared as one value', () {
      final DraftConflict conflict = DraftConflict.compare(
        mine: <String, Object?>{
          'ids': <Object?>['a', 'b'],
          'funding_lines': <Object?>[
            <String, Object?>{'bucket': 'A', 'cumulative_vnd': '1'},
            <String, Object?>{'bucket': 'A', 'cumulative_vnd': '2'},
          ],
          'empty': <Object?>[],
          'scalars': <Object?>[1],
        },
        server: <String, Object?>{
          'ids': <Object?>['b', 'a'],
          'funding_lines': <Object?>[
            <String, Object?>{'bucket': 'A', 'cumulative_vnd': '1'},
          ],
          'empty': <Object?>[],
          'scalars': <Object?>[1],
        },
        listIdentity: const <String, List<String>>{'funding_lines': <String>['bucket'], 'empty': <String>['x'], 'scalars': <String>['x']},
      );
      expect(conflict.differences.map((FieldDifference d) => d.path).toList()..sort(), <String>['funding_lines', 'ids']);
      expect(conflict.differences.firstWhere((FieldDifference d) => d.path == 'funding_lines').isMoney, isTrue);
    });

    test('a field that exists on one side only is a difference unless the draft leaves it out on purpose', () {
      final Map<String, Object?> mine = <String, Object?>{'a': '1'};
      final Map<String, Object?> server = <String, Object?>{'a': '1', 'b': 'x', 'c': <String, Object?>{'d': 1}};
      expect(DraftConflict.compare(mine: mine, server: server).differences.map((FieldDifference d) => d.path), <String>['b', 'c']);
      expect(DraftConflict.compare(mine: mine, server: server, onlyFieldsOfMine: true).isEmpty, isTrue);
      expect(DraftConflict.compare(mine: <String, Object?>{'a': <String, Object?>{'x.y': 1}}, server: <String, Object?>{'a': <String, Object?>{'x.y': 2}}).differences.single.path, 'a');
    });
  });

  group('AC-ST-MOB-006-1 UAT-AC504 money is never merged by a rule', () {
    DraftConflict twoFields() => DraftConflict.compare(
          mine: <String, Object?>{'construction_vnd': '130000000', 'note': 'mine'},
          server: <String, Object?>{'construction_vnd': '120000000', 'note': 'server'},
        );

    test('resolve needs a choice for every difference, the amounts included, and refuses a path that does not differ', () {
      final DraftConflict conflict = twoFields();
      expect(() => conflict.resolve(const <String, FieldChoice>{}), throwsA(isA<UnresolvedConflict>()));
      expect(() => conflict.resolve(const <String, FieldChoice>{'note': FieldChoice.server}), throwsA(isA<UnresolvedConflict>().having((UnresolvedConflict e) => e.paths, 'paths', <String>['construction_vnd'])));
      expect(() => conflict.resolve(const <String, FieldChoice>{'note': FieldChoice.mine, 'construction_vnd': FieldChoice.mine, 'other': FieldChoice.mine}), throwsA(isA<UnresolvedConflict>()));
    });

    test('keeping the device value, or taking the server value, field by field', () {
      final DraftConflict conflict = twoFields();
      expect(conflict.resolve(const <String, FieldChoice>{'construction_vnd': FieldChoice.mine, 'note': FieldChoice.server}), <String, Object?>{'construction_vnd': '130000000', 'note': 'server'});
      expect(conflict.resolve(const <String, FieldChoice>{'construction_vnd': FieldChoice.server, 'note': FieldChoice.mine}), <String, Object?>{'construction_vnd': '120000000', 'note': 'mine'});
      expect(conflict.mine['construction_vnd'], '130000000', reason: 'the comparison does not change what it compared');
    });

    test('a choice reaches nested fields, list items, added items and removed fields', () {
      final DraftConflict conflict = DraftConflict.compare(
        mine: <String, Object?>{
          'narrative': <String, Object?>{'results': 'a'},
          'funding_lines': <Object?>[
            <String, Object?>{'bucket': 'A', 'cumulative_vnd': '1'},
            <String, Object?>{'bucket': 'B', 'cumulative_vnd': '2'},
          ],
          'gone_on_server': 'x',
        },
        server: <String, Object?>{
          'narrative': <String, Object?>{'results': 'b'},
          'funding_lines': <Object?>[
            <String, Object?>{'bucket': 'A', 'cumulative_vnd': '9'},
            <String, Object?>{'bucket': 'C', 'cumulative_vnd': '3'},
          ],
        },
        listIdentity: const <String, List<String>>{'funding_lines': <String>['bucket']},
      );
      final Map<String, Object?> merged = conflict.resolve(<String, FieldChoice>{for (final FieldDifference d in conflict.differences) d.path: FieldChoice.server});
      expect(merged, <String, Object?>{
        'narrative': <String, Object?>{'results': 'b'},
        'funding_lines': <Object?>[
          <String, Object?>{'bucket': 'A', 'cumulative_vnd': '9'},
          <String, Object?>{'bucket': 'C', 'cumulative_vnd': '3'},
        ],
      });
      final Map<String, Object?> kept = conflict.resolve(<String, FieldChoice>{for (final FieldDifference d in conflict.differences) d.path: FieldChoice.mine});
      expect(kept, conflict.mine);
    });

    test('a choice for a nested path is applied whether or not the parent exists on the device', () {
      final DraftConflict conflict = DraftConflict.compare(
        mine: <String, Object?>{'narrative': <String, Object?>{'results': 'a'}, 'funding_lines': <Object?>[]},
        server: <String, Object?>{'narrative': <String, Object?>{'results': 'a', 'causes': 'rain'}, 'funding_lines': <Object?>[]},
      );
      expect(conflict.resolve(const <String, FieldChoice>{'narrative.causes': FieldChoice.server}), <String, Object?>{
        'narrative': <String, Object?>{'results': 'a', 'causes': 'rain'},
        'funding_lines': <Object?>[],
      });
    });
  });

  group('AC-ST-MOB-006-1 AC-ST-MOB-006-3 UAT-AC504 MOB01 two devices, one draft: the conflict is read, decided and accepted once', () {
    test('the second device sends 130,000,000 against version 3; the server keeps 120,000,000 and the device does not overwrite it', () async {
      final FakeSyncServer server = FakeSyncServer(decide: (Map<String, Object?> item) => const ServerOutcome.conflict(code: 'DRAFT_VERSION_CONFLICT', version: 7))..reports[reportId] = serverView();
      final QueueRig rig = await QueueRig.create(server: server);
      final DraftStore drafts = DraftStore(rig.store, clock: rig.clock.call);
      final LocalDraft draft = drafts.save(kind: 'report', recordId: reportId, fields: devicePayload(), baseServerVersion: 3);
      final QueuedCommand command = rig.queue.enqueue(commandType: 'report.draft.save', payload: devicePayload(), baseServerVersion: 3, draftId: draft.id);

      await rig.queue.flush();
      final QueuedCommand conflicted = rig.queue.command(command.id)!;
      expect(conflicted.state, CommandState.conflict);
      expect(conflicted.errorCode, 'DRAFT_VERSION_CONFLICT');
      expect(conflicted.serverVersion, 7);
      expect(server.effectsOf(command.idempotencyKey), 0, reason: 'nothing of the device reached the record');
      expect(server.reports[reportId]!['progress'], containsPair('construction_vnd', '120000000'));
      expect(rig.store.drafts.byId(draft.id)!.status, DraftStatus.blocked);
      expect(rig.store.drafts.byId(draft.id)!.blockedCode, 'DRAFT_VERSION_CONFLICT');
      expect(rig.store.drafts.byId(draft.id)!.fields, devicePayload(), reason: 'the draft is intact');

      // MOB-42 reads the server's copy through the read operation and shows both amounts.
      final LoadedConflict loaded = await ConflictAdapters.standard().conflictOf(_clientOf(rig), conflicted);
      expect(loaded.serverVersion, 7);
      final DraftConflict conflict = loaded.conflict;
      expect(conflict.differences.singleWhere((FieldDifference d) => d.path == 'construction_vnd').moneyDelta!.toPlainString(), '10000000');
    });

    test('the person chooses: the command returns to QUEUED with the new base version, a new key, and is accepted once', () async {
      final FakeSyncServer server = FakeSyncServer(decide: (Map<String, Object?> item) => (item['base_server_version'] as int) < 7 ? const ServerOutcome.conflict(code: 'DRAFT_VERSION_CONFLICT', version: 7) : const ServerOutcome.accepted(version: 8))
        ..reports[reportId] = serverView();
      final QueueRig rig = await QueueRig.create(server: server);
      final DraftStore drafts = DraftStore(rig.store, clock: rig.clock.call);
      final LocalDraft draft = drafts.save(kind: 'report', recordId: reportId, fields: devicePayload(), baseServerVersion: 3);
      final QueuedCommand command = rig.queue.enqueue(commandType: 'report.draft.save', payload: devicePayload(), baseServerVersion: 3, draftId: draft.id);
      await rig.queue.flush();
      final QueuedCommand conflicted = rig.queue.command(command.id)!;
      final LoadedConflict loaded = await ConflictAdapters.standard().conflictOf(_clientOf(rig), conflicted);
      final DraftConflict conflict = loaded.conflict;

      // Not auto-merged: the person must decide the amount.
      final Map<String, FieldChoice> choices = <String, FieldChoice>{
        for (final FieldDifference d in conflict.differences) d.path: d.isMoney ? FieldChoice.server : FieldChoice.mine,
      };
      expect(() => conflict.resolve(<String, FieldChoice>{...choices}..remove('construction_vnd')), throwsA(isA<UnresolvedConflict>()));
      final Map<String, Object?> merged = conflict.resolve(choices);
      expect(merged['construction_vnd'], '120000000');
      expect((merged['narrative']! as Map<String, Object?>)['results'], 'Done on site and checked');

      expect(() => rig.queue.resolveConflict(command.id, payload: merged, baseServerVersion: 3), throwsArgumentError, reason: 'the version must be the one that was looked at');
      final QueuedCommand queued = rig.queue.resolveConflict(command.id, payload: merged, baseServerVersion: loaded.serverVersion);
      expect(queued.state, CommandState.queued);
      expect(queued.baseServerVersion, 7);
      expect(queued.idempotencyKey, isNot(command.idempotencyKey));
      expect(queued.supersededKeys, <String>[command.idempotencyKey]);
      expect(rig.store.drafts.byId(draft.id)!.status, DraftStatus.queued);
      expect(rig.store.drafts.byId(draft.id)!.baseServerVersion, 7);
      expect(rig.store.drafts.byId(draft.id)!.fields['construction_vnd'], '120000000');

      await rig.queue.flush();
      await rig.queue.flush();
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      expect(server.effectsOf(queued.idempotencyKey), 1, reason: 'accepted once');
      expect(server.effectsOf(command.idempotencyKey), 0);
      expect(rig.store.drafts.byId(draft.id)!.status, DraftStatus.synced);
      expect(rig.store.drafts.byId(draft.id)!.baseServerVersion, 8);
      expect(() => rig.queue.resolveConflict(command.id, payload: merged, baseServerVersion: 9), throwsStateError);
    });

    test('a conflict adapter is found by command type, one per type, and a type without one says so', () async {
      final ConflictAdapters adapters = ConflictAdapters.standard();
      expect(adapters.forType('report.submit'), isNotNull);
      expect(adapters.forType('issue.create'), isNull);
      expect(() => adapters.register('report.submit', reportConflictAdapter), throwsStateError);
      adapters.register('issue.create', reportConflictAdapter);
      expect(adapters.forType('issue.create'), isNotNull);
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand other = rig.queue.enqueue(commandType: 'measurement.record', payload: <String, Object?>{});
      await expectLater(adapters.conflictOf(_clientOf(rig), other), throwsStateError);
    });

    test('the report is read by the id in the command; a command that names no report, or a view without a version, is not read', () async {
      final FakeSyncServer server = FakeSyncServer()..reports[reportId] = (serverView()..remove('version'));
      final QueueRig rig = await QueueRig.create(server: server);
      final QueuedCommand named = rig.queue.enqueue(commandType: 'report.draft.save', payload: devicePayload());
      final QueuedCommand nameless = rig.queue.enqueue(commandType: 'report.draft.save', payload: <String, Object?>{'construction_vnd': '1'});
      final ConflictAdapters adapters = ConflictAdapters.standard();
      await expectLater(adapters.conflictOf(_clientOf(rig), nameless), throwsStateError);
      await expectLater(adapters.conflictOf(_clientOf(rig), named), throwsA(isA<ContractMismatch>()));
    });

    test('a submit has no fields of its own: a conflict about it shows no difference, and the person still confirms the new version', () async {
      final FakeSyncServer server = FakeSyncServer(decide: (Map<String, Object?> item) => (item['base_server_version'] as int) < 7 ? const ServerOutcome.conflict(version: 7) : const ServerOutcome.accepted())
        ..reports[reportId] = serverView();
      final QueueRig rig = await QueueRig.create(server: server);
      final QueuedCommand command = rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'report_id': reportId}, baseServerVersion: 3);
      await rig.queue.flush();
      final LoadedConflict loaded = await ConflictAdapters.standard().conflictOf(_clientOf(rig), rig.queue.command(command.id)!);
      final DraftConflict conflict = loaded.conflict;
      expect(conflict.isEmpty, isTrue);
      rig.queue.resolveConflict(command.id, payload: conflict.resolve(const <String, FieldChoice>{}), baseServerVersion: 7);
      await rig.queue.flush();
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      expect(server.effectsOf(rig.queue.command(command.id)!.idempotencyKey), 1);
    });
  });

  group('AC-ST-MOB-006-2 UAT-AC507 a period locked while the draft was offline', () {
    test('the submit is refused with PERIOD_LOCKED, the draft stays on the device unchanged, and sending again after the period is reopened works once', () async {
      bool locked = true;
      final FakeSyncServer server = FakeSyncServer(decide: (Map<String, Object?> item) => locked ? const ServerOutcome.rejected('PERIOD_LOCKED') : const ServerOutcome.accepted(version: 9));
      final QueueRig rig = await QueueRig.create(server: server);
      final DraftStore drafts = DraftStore(rig.store, clock: rig.clock.call);
      final LocalDraft draft = drafts.save(kind: 'report', recordId: reportId, fields: devicePayload(), baseServerVersion: 3);
      final QueuedCommand command = rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'report_id': reportId}, baseServerVersion: 3, draftId: draft.id, releaseDraft: true);

      final events = <bool>[];
      final sub = rig.queue.events.listen((e) => events.add(e.becamePeriodLocked));
      await rig.queue.flush();
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();

      final QueuedCommand refused = rig.queue.command(command.id)!;
      expect(refused.state, CommandState.rejected);
      expect(refused.errorCode, 'PERIOD_LOCKED');
      expect(refused.payload, isNotNull, reason: 'what was refused keeps its data so that it can be sent again');
      expect(events, contains(true));
      final LocalDraft kept = rig.store.drafts.byId(draft.id)!;
      expect(kept.fields, devicePayload(), reason: 'the draft is not touched by the refusal');
      expect(kept.status, DraftStatus.blocked);
      expect(kept.blockedCode, 'PERIOD_LOCKED');
      expect(jsonEncode(kept.fields), contains('130000000'));

      // A second flush sends nothing: a refusal is not retried by itself.
      await rig.queue.flush();
      expect(server.batchPosts, 1);

      locked = false;
      await rig.queue.retry(command.id);
      final QueuedCommand done = rig.queue.command(command.id)!;
      expect(done.state, CommandState.accepted);
      expect(done.idempotencyKey, isNot(command.idempotencyKey));
      expect(server.effectsOf(done.idempotencyKey), 1);
      expect(rig.store.drafts.byId(draft.id), isNull, reason: 'the submit released its draft once it was accepted');
    });

    test('editing a blocked draft makes it editable again, and a draft that is queued stays queued', () async {
      final QueueRig rig = await QueueRig.create();
      final DraftStore drafts = DraftStore(rig.store, clock: rig.clock.call, newId: () => 'draft-00000000000001');
      LocalDraft draft = drafts.save(kind: 'report', fields: <String, Object?>{'a': 1}, baseServerVersion: 4);
      expect(draft.id, 'draft-00000000000001');
      expect(draft.status, DraftStatus.editing);
      rig.store.drafts.upsert(LocalDraft(id: draft.id, tenantId: draft.tenantId, userId: draft.userId, kind: 'report', fields: draft.fields, baseServerVersion: 4, status: DraftStatus.blocked, blockedCode: 'PERIOD_LOCKED', createdAt: draft.createdAt, updatedAt: 1));
      draft = drafts.save(id: draft.id, kind: 'report', fields: <String, Object?>{'a': 2}, baseServerVersion: 2);
      expect(draft.status, DraftStatus.editing);
      expect(draft.blockedCode, isNull);
      expect(draft.baseServerVersion, 4, reason: 'the version it was based on never goes back');
      expect(drafts.byId(draft.id)!.fields, <String, Object?>{'a': 2});
      rig.queue.enqueue(commandType: 'report.draft.save', payload: <String, Object?>{'a': 2}, draftId: draft.id);
      expect(drafts.save(id: draft.id, kind: 'report', fields: <String, Object?>{'a': 3}).status, DraftStatus.queued);
      expect(drafts.list(kind: 'report'), hasLength(1));
      expect(drafts.list(kind: 'issue'), isEmpty);
      expect(() => drafts.save(id: 'nope', kind: 'report', fields: <String, Object?>{}), throwsArgumentError);
      drafts.delete(draft.id);
      expect(drafts.list(), isEmpty);
    });
  });
}

/// The API client of a rig, to read the server's copy the way the screen does.
MachvonApiClient _clientOf(QueueRig rig) => rig.client;
