import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/drafts/conflict_adapter.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/features/site_diary/diary_conflict.dart';

import '../support/scripted_server.dart';
import 'diary_fixtures.dart';

QueuedCommand _command(Map<String, Object?>? payload) => QueuedCommand(
      id: 'q-1',
      tenantId: 't-1',
      userId: 'u-1',
      commandType: 'site_diary.append',
      payload: payload,
      payloadBytes: 10,
      baseServerVersion: 2,
      idempotencyKey: 'k-1',
      state: CommandState.conflict,
      createdAt: 1,
      updatedAt: 1,
    );

MachvonApiClient _client(ScriptedServer server) => MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 't');

void main() {
  group('AC-ST-MOB-020-3 UAT-AC366 how a save in conflict finds the diary the server holds', () {
    test('a revision names its diary: that diary is read, with its content and version', () async {
      final ScriptedServer server = ScriptedServer()..on('GET', '/resources/site_diary/d-1', (_) => diaryRow('d-1', version: 5));
      final ServerCopy copy = await siteDiaryConflictAdapter.read(_client(server), _command(<String, Object?>{'diary_id': 'd-1'}));
      expect(copy.version, 5);
      expect((copy.fields['content']! as Map<String, Object?>)['summary'], 'Đào móng trụ T3');
      expect(server.callsTo('GET', '/resources/site_diary'), isEmpty, reason: 'no search when the diary is named');
    });

    test('a first save of a day is looked up by contract and day, and a superseded diary is not the one', () async {
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/resources/site_diary', (_) => page(<Object?>[diaryRow('d-9', status: 'DRAFT', version: 4), diaryRow('d-old', status: 'SUPERSEDED')]))
        ..on('GET', '/resources/site_diary/d-9', (_) => diaryRow('d-9', version: 4));
      final ServerCopy copy = await siteDiaryConflictAdapter.read(
        _client(server),
        _command(<String, Object?>{'contract_id': 'c-1', 'record_date': '2026-11-03'}),
      );
      expect(copy.version, 4);
      final Map<String, Object?> asked = server.callsTo('GET', '/resources/site_diary').single.url.queryParameters;
      expect(asked['contract_id'], 'c-1');
      expect(asked['from'], '2026-11-03');
      expect(asked['to'], '2026-11-03');
      expect(server.callsTo('GET', '/resources/site_diary/d-old'), isEmpty);
    });

    test('a day with no diary, or a diary the phone cannot read, is a mismatch of the contract, never a guess', () async {
      final ScriptedServer none = ScriptedServer()..on('GET', '/resources/site_diary', (_) => page(<Object?>[]));
      await expectLater(
        siteDiaryConflictAdapter.read(_client(none), _command(<String, Object?>{'contract_id': 'c-1', 'record_date': '2026-11-03'})),
        throwsA(isA<ContractMismatch>()),
      );
      final ScriptedServer odd = ScriptedServer()..on('GET', '/resources/site_diary/d-1', (_) => <String, Object?>{'id': 'd-1'});
      await expectLater(
        siteDiaryConflictAdapter.read(_client(odd), _command(<String, Object?>{'diary_id': 'd-1'})),
        throwsA(isA<ContractMismatch>()),
      );
      await expectLater(
        siteDiaryConflictAdapter.read(_client(none), _command(null)),
        throwsA(isA<ContractMismatch>()),
      );
    });
  });
}
