import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/session/auth/auth_service.dart';
import 'package:machvon_mobile/features/session/auth/pending_work.dart';

import '../features/session/support/world.dart';
import '../support/fake_sync_server.dart';
import '../support/offline_support.dart';
import '../support/queue_rig.dart';

const String _report = '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a01';
const String _foreignKey = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/// A man in the middle that sees the answer of the server and rewrites it. It stands for a hostile proxy
/// whose certificate the phone was made to trust; what the phone does with an answer it did not ask for is what is under test.
class HostileProxy extends FakeSyncServer {
  HostileProxy({required this.rewriteAnswer});

  final Map<String, Object?> Function(Map<String, Object?> answer) rewriteAnswer;

  @override
  Future<HttpResult> send(HttpCall call) async {
    final HttpResult answer = await super.send(call);
    final bool batch = call.method == 'POST' && call.url.path.endsWith('/sync/batches');
    if (!batch || answer.status != 200) return answer;
    return HttpResult(status: answer.status, headers: answer.headers, body: jsonEncode(rewriteAnswer(jsonDecode(answer.body) as Map<String, Object?>)));
  }
}

QueuedCommand _own(QueueRig rig, {String report = _report}) => rig.queue.enqueue(
      commandType: 'report.submit',
      payload: <String, Object?>{'report_id': report},
      baseServerVersion: 3,
    );

QueuedCommand _foreign(String tenantId, String userId, {String key = _foreignKey}) => QueuedCommand(
      id: 'foreign-row-0000000000000001',
      tenantId: tenantId,
      userId: userId,
      commandType: 'report.submit',
      payload: <String, Object?>{'report_id': _report},
      payloadBytes: 40,
      baseServerVersion: 3,
      idempotencyKey: key,
      state: CommandState.queued,
      createdAt: 1,
      updatedAt: 1,
    );

Set<String> _keysSent(FakeSyncServer server) => <String>{
      for (final HttpCall call in server.batches)
        for (final Object? item in (jsonDecode(call.body!) as Map<String, Object?>)['items']! as List<Object?>) (item! as Map<String, Object?>)['idempotency_key']! as String,
    };

void main() {
  group('AC-ST-MOB-041-2 UAT-AC500 the envelope of a command: tenant and user are the phone\'s own and never go where another could change them', () {
    test('a row of another tenant that got into the store is never sent, and the rows of this tenant are', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuedCommand mine = _own(rig);
      rig.store.commands.insert(_foreign('tenant-b', 'user-1'));

      final FlushResult result = await rig.queue.flush();

      expect(result.accepted, 1);
      expect(_keysSent(rig.server), <String>{mine.idempotencyKey}, reason: 'only the key of this tenant left the phone');
      expect(rig.server.effectsOf(_foreignKey), 0);
      expect(rig.store.commands.byKey(_foreignKey)!.state, CommandState.queued, reason: 'the foreign row is left exactly as it was');
    });

    test('a row of another user of the same tenant is not sent either', () async {
      final QueueRig rig = await QueueRig.create();
      _own(rig);
      rig.store.commands.insert(_foreign('tenant-a', 'user-2'));
      await rig.queue.flush();
      expect(_keysSent(rig.server), isNot(contains(_foreignKey)));
      expect(rig.store.commands.byKey(_foreignKey)!.state, CommandState.queued);
    });

    test('the next due time of the queue is that of this person\'s commands: a foreign row does not wake the runner', () async {
      final QueueRig rig = await QueueRig.create();
      rig.store.commands.insert(_foreign('tenant-b', 'user-1'));
      expect(rig.queue.nextDueAt, isNull);
    });

    test('a session of another tenant blocks the flush: nothing is sent under it, whatever the store holds', () async {
      final QueueRig rig = await QueueRig.create(session: kSignedInA, storeTenantId: 'tenant-b');
      rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'report_id': _report}, baseServerVersion: 3);
      final FlushResult result = await rig.queue.flush();
      expect(result.blocker, FlushBlocker.noSession);
      expect(rig.server.calls, isEmpty, reason: 'not one request left the phone');
    });

    test('a signed-out or expired session blocks the flush in the same way', () async {
      for (final SessionStatus status in <SessionStatus>[SessionStatus.signedOut, SessionStatus.expired]) {
        final QueueRig rig = await QueueRig.create(session: SessionSnapshot(status: status, tenantId: 'tenant-a', userId: 'user-1'));
        _own(rig);
        expect((await rig.queue.flush()).blocker, FlushBlocker.noSession, reason: status.name);
        expect(rig.server.calls, isEmpty, reason: status.name);
      }
    });

    test('the request names the device and the commands and nothing a proxy could change to move them to another tenant', () async {
      final QueueRig rig = await QueueRig.create();
      _own(rig);
      await rig.queue.flush();

      final HttpCall call = rig.server.batches.single;
      final Map<String, Object?> body = jsonDecode(call.body!) as Map<String, Object?>;
      expect(body.keys.toSet(), <String>{'device_id', 'items'});
      final Map<String, Object?> item = (body['items']! as List<Object?>).single! as Map<String, Object?>;
      expect(item.keys.toSet(), <String>{'idempotency_key', 'command_type', 'base_server_version', 'payload'});
      expect(jsonEncode(body), isNot(contains('tenant')), reason: 'the tenant is the one of the bearer token, which the server judges');
      expect(jsonEncode(body), isNot(contains('user-1')));
      final Set<String> headers = call.headers.keys.map((String h) => h.toLowerCase()).toSet();
      expect(headers.any((String h) => h.contains('tenant')), isFalse, reason: 'no header names a tenant');
      expect(headers, contains('authorization'));
    });

    test('a proxy that adds an answer for a key the batch did not hold writes nothing: no row appears and no other command moves', () async {
      final HostileProxy proxy = HostileProxy(
        rewriteAnswer: (Map<String, Object?> answer) => <String, Object?>{
          'results': <Object?>[
            ...(answer['results']! as List<Object?>),
            <String, Object?>{'idempotency_key': _foreignKey, 'status': 'accepted', 'server_version': 9},
          ],
        },
      );
      final QueueRig rig = await QueueRig.create(server: proxy);
      final QueuedCommand mine = _own(rig);
      final int rowsBefore = rig.store.commands.inStates(CommandState.values.toSet()).length;

      final FlushResult result = await rig.queue.flush();

      expect(result.accepted, 1);
      expect(rig.store.commands.byKey(_foreignKey), isNull, reason: 'an answer does not create a command');
      expect(rig.store.commands.inStates(CommandState.values.toSet()), hasLength(rowsBefore));
      expect(rig.queue.command(mine.id)!.state, CommandState.accepted);
    });

    test('a proxy that drops the answer of one command leaves it unknown, to be looked up by its key, never accepted and never lost', () async {
      final HostileProxy proxy = HostileProxy(
        rewriteAnswer: (Map<String, Object?> answer) => <String, Object?>{'results': <Object?>[]},
      );
      final QueueRig rig = await QueueRig.create(server: proxy);
      final QueuedCommand mine = _own(rig);
      final FlushResult result = await rig.queue.flush();
      expect(result.unknown, 1);
      expect(rig.queue.command(mine.id)!.state, CommandState.unknown);
      expect(rig.queue.command(mine.id)!.payload, isNotNull, reason: 'what is unknown keeps its data');
    });
  });

  group('AC-ST-MOB-041-3 UAT-AC501 a revoked membership leaves nothing on the device', () {
    late World world;
    late TestStorage storage;

    Future<({AuthService service, LocalStore store})> signedInWithData() async {
      storage = TestStorage.create();
      world = World();
      world.extraPurgers.add(OfflineStoragePurger(storage.storage));
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      final LocalStore store = await storage.open(tenantId: service.snapshot.tenantId!, userId: service.snapshot.userId!);
      store.setMeta('probe', 'tenant data of the person');
      return (service: service, store: store);
    }

    List<String> filesOf(TestStorage s) => s.directory.existsSync() ? s.directory.listSync().map((FileSystemEntity e) => e.uri.pathSegments.last).toList() : <String>[];

    test('the control: signing out deletes the database file, its journals and its key', () async {
      final ({AuthService service, LocalStore store}) device = await signedInWithData();
      expect(filesOf(storage).where((String f) => f.startsWith('machvon-')), isNotEmpty);
      expect(storage.keys.keys, hasLength(1));

      await device.service.signOut(discardPending: true);

      expect(filesOf(storage).where((String f) => f.startsWith('machvon-')), isEmpty);
      expect(storage.keys.keys, isEmpty, reason: 'the key is gone, so a copy of the file made earlier cannot be opened');
    });

    test('the server telling the device it is revoked deletes the data of every tenant on the first contact', () async {
      final ({AuthService service, LocalStore store}) device = await signedInWithData();
      device.service.noteResponse(401, 'DEVICE_REVOKED');
      await pumpEventQueue();
      expect(device.service.snapshot.status, SessionStatus.signedOut);
      expect(filesOf(storage).where((String f) => f.startsWith('machvon-')), isEmpty);
      expect(storage.keys.keys, isEmpty);
    });

    test('a membership lost while the device was offline ends the session at the first renewal that reaches the server', () async {
      final ({AuthService service, LocalStore store}) device = await signedInWithData();
      world.advance(const Duration(minutes: 6));
      world.api.selectFailureStatus = 403;
      world.api.selectFailureCode = 'MEMBERSHIP_INACTIVE';
      await expectLater(device.service.accessToken(), throwsA(isA<ApiError>().having((ApiError e) => e.code, 'code', 'MEMBERSHIP_INACTIVE')));
      expect(device.service.snapshot.status, SessionStatus.expired);
    });

    // SEC-01 (docs/mobile-security-review.md), fixed: the renewal that the server answers with MEMBERSHIP_INACTIVE, TENANT_SELECTION_INVALID
    // or SCOPE_DENIED purges the store of the person and its key (`AuthService._revoke`) before it expires the session, and the scope
    // revocation of the sync coordinator signs the person out (test/app/session_services_test.dart).
    for (final String code in <String>['MEMBERSHIP_INACTIVE', 'TENANT_SELECTION_INVALID', 'SCOPE_DENIED']) {
      test('SEC-01 fixed: the encrypted store and its key are gone at the first renewal that reaches the server after the revocation ($code)', () async {
        final ({AuthService service, LocalStore store}) device = await signedInWithData();
        final List<String> copyMadeBefore = filesOf(storage).where((String f) => f.startsWith('machvon-')).toList();
        expect(copyMadeBefore, isNotEmpty, reason: 'the control: the file existed');
        world.advance(const Duration(minutes: 6));
        world.api.selectFailureStatus = 403;
        world.api.selectFailureCode = code;
        await expectLater(device.service.accessToken(), throwsA(isA<ApiError>().having((ApiError e) => e.code, 'code', code)));
        await pumpEventQueue();
        expect(filesOf(storage).where((String f) => f.startsWith('machvon-')), isEmpty, reason: 'the file and its journals are gone');
        expect(storage.keys.keys, isEmpty, reason: 'and so is its key');
        expect(device.store.isClosed, isTrue);
        expect(world.store.data.keys.any((String k) => k == 'session.v1'), isFalse, reason: 'the refresh token is gone: the person cannot get back in');
        expect(device.service.snapshot.status, SessionStatus.expired);
      });
    }

    test('a sign-out of a session that expired for another reason (401) still deletes the file and the key', () async {
      final ({AuthService service, LocalStore store}) device = await signedInWithData();
      world.advance(const Duration(minutes: 6));
      world.api.selectFailureStatus = 401;
      await expectLater(device.service.accessToken(), throwsA(isA<ApiError>()));
      expect(filesOf(storage).where((String f) => f.startsWith('machvon-')), isNotEmpty, reason: 'a 401 only locks the data');
      await device.service.signOut(discardPending: true);
      expect(filesOf(storage).where((String f) => f.startsWith('machvon-')), isEmpty);
      expect(storage.keys.keys, isEmpty);
    });
  });
}

