import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';

import '../../support/fake_sync_server.dart';
import '../../support/queue_rig.dart';
import 'attachment_uploader_scope_test.dart' show Gate;

/// The sync server with the answers held back: it has done the work, the answer is still on its way to the phone.
class GatedSyncServer extends FakeSyncServer {
  Gate? afterBatch;
  Gate? afterLookup;

  @override
  Future<HttpResult> send(HttpCall call) async {
    final HttpResult result = await super.send(call);
    if (call.method == 'POST' && call.url.path.endsWith('/sync/batches')) {
      await afterBatch?.pass();
    } else if (call.method == 'GET' && call.url.path.contains('/sync/commands/')) {
      await afterLookup?.pass();
    }
    return result;
  }
}

const SessionSnapshot kSignedInB = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-1');

QueuedCommand issue(QueueRig rig, int n) => rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': n});

void main() {
  group('REVIEW-m1-1 a queue that is disposed or whose session changed sends nothing more', () {
    test('after dispose the answer of a batch that was on its way changes nothing; the commands stay sending, for the next owner of the store to look up', () async {
      final GatedSyncServer server = GatedSyncServer();
      final QueueRig rig = await QueueRig.create(server: server);
      final QueuedCommand command = issue(rig, 1);
      server.afterBatch = Gate();
      final Future<FlushResult> flushing = rig.queue.flush();
      await server.afterBatch!.reached;
      await rig.queue.dispose();
      server.afterBatch!.open();
      final FlushResult result = await flushing;
      expect(result.blocker, FlushBlocker.noSession);
      expect(rig.store.commands.byId(command.id)!.state, CommandState.sending, reason: 'nothing was written after the dispose');
    });

    test('after dispose the answer of a lookup that was on its way changes nothing', () async {
      final GatedSyncServer server = GatedSyncServer();
      final QueueRig rig = await QueueRig.create(server: server);
      final QueuedCommand command = issue(rig, 1);
      server.dropNextBatchAnswer = true;
      await rig.queue.flush();
      expect(rig.queue.command(command.id)!.state, CommandState.unknown);
      server.afterLookup = Gate();
      final Future<FlushResult> flushing = rig.queue.flush();
      await server.afterLookup!.reached;
      await rig.queue.dispose();
      server.afterLookup!.open();
      final FlushResult result = await flushing;
      expect(result.blocker, FlushBlocker.noSession);
      expect(rig.store.commands.byId(command.id)!.state, CommandState.unknown);
      expect(server.batchPosts, 1, reason: 'no second send');
    });

    test('a session that moves to another tenant while a lookup is on its way sends no batch of the first tenant', () async {
      final GatedSyncServer server = GatedSyncServer();
      SessionSnapshot session = kSignedInA;
      final QueueRig rig = await QueueRig.create(server: server, sessionOf: () => session);
      final QueuedCommand command = issue(rig, 1);
      server.offline = true;
      await rig.queue.flush();
      server.offline = false;
      server.afterLookup = Gate();
      final Future<FlushResult> flushing = rig.queue.flush();
      await server.afterLookup!.reached;
      session = kSignedInB;
      server.afterLookup!.open();
      final FlushResult result = await flushing;
      expect(result.blocker, FlushBlocker.noSession);
      expect(server.batchPosts, 1, reason: 'the command found "not received" is not sent under tenant-b');
      expect(rig.queue.command(command.id)!.state, CommandState.queued, reason: 'the lookup answer is the truth about tenant-a; it waits for tenant-a');
    });

    test('a token refused because another tenant is active leaves the commands queued, intact, and nothing leaves the phone', () async {
      bool refuse = true;
      final QueueRig rig = await QueueRig.create(tokenOf: () async => refuse ? throw const TenantMismatch() : 'test-token');
      final QueuedCommand command = issue(rig, 1);
      final FlushResult result = await rig.queue.flush();
      expect(result.blocker, FlushBlocker.noSession);
      final QueuedCommand waiting = rig.queue.command(command.id)!;
      expect(waiting.state, CommandState.queued, reason: 'not stuck in sending');
      expect(waiting.attempts, 0, reason: 'no attempt was made');
      expect(rig.server.calls, isEmpty);

      refuse = false;
      expect((await rig.queue.flush()).accepted, 1);
    });

    test('a token refused during a lookup leaves the command unknown', () async {
      bool refuse = false;
      final QueueRig rig = await QueueRig.create(tokenOf: () async => refuse ? throw const TenantMismatch() : 'test-token');
      final QueuedCommand command = issue(rig, 1);
      rig.server.dropNextBatchAnswer = true;
      await rig.queue.flush();
      refuse = true;
      final FlushResult result = await rig.queue.flush();
      expect(result.blocker, FlushBlocker.noSession);
      expect(rig.queue.command(command.id)!.state, CommandState.unknown);
      expect(rig.server.lookups, 0);
    });
  });
}
