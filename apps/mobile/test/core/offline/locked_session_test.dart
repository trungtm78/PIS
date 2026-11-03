import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_uploader.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/core/session/session.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../../support/queue_rig.dart';
import 'attachment_uploader_test.dart' show UploaderRig;
import 'offline_providers_test.dart' show containerFor;

const SessionSnapshot _locked = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', locked: true);
const SessionSnapshot _unlocked = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('REVIEW-m1-6 a session locked by the biometric unlock has no credential: nothing is sent until it is unlocked', () {
    test('the queue sends nothing while the session is locked and its commands wait intact; unlocked, they go', () async {
      SessionSnapshot session = _locked;
      final QueueRig rig = await QueueRig.create(sessionOf: () => session);
      final QueuedCommand command = rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});

      final FlushResult result = await rig.queue.flush();

      expect(result.blocker, FlushBlocker.noSession);
      expect(rig.server.calls, isEmpty, reason: 'a request without a bearer token must not leave the phone');
      expect(rig.queue.command(command.id)!.state, CommandState.queued);
      expect(rig.queue.command(command.id)!.attempts, 0);

      session = _unlocked;
      expect((await rig.queue.flush()).accepted, 1);
    });

    test('the uploader sends nothing while the session is locked: the file waits for the unlock and no request leaves', () async {
      SessionSnapshot session = _locked;
      final UploaderRig rig = await UploaderRig.create(sessionOf: () => session);
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');

      await rig.uploader.run(added.id);

      expect(rig.server.calls, isEmpty);
      final AttachmentUpload waiting = rig.uploader.upload(added.id)!;
      expect(waiting.state, UploadState.pending);

      session = _unlocked;
      await rig.uploader.run(added.id);
      expect(rig.uploader.upload(added.id)!.state, UploadState.clean);
    });

    test('the queue runner of the application does not send on a locked cold start, and sends the moment the session is unlocked', () async {
      final TestStorage storage = TestStorage.create();
      final LocalStore store = await storage.open();
      store.deviceId = '11111111-1111-4111-8111-111111111111';
      final FakeSyncServer server = FakeSyncServer();
      final FakeSession session = FakeSession(_locked);
      final ProviderContainer container = containerFor(storage: storage, server: server, session: session);
      final CommandQueue queue = await container.read(commandQueueProvider.future);
      queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});
      container.listen(queueRunnerProvider, (previous, next) {});
      await container.read(queueRunnerProvider.future);
      await pumpEventQueue();
      expect(server.calls, isEmpty, reason: 'the runner started on a locked session');
      expect(queue.commands().single.state, CommandState.queued);

      session.change(_unlocked);
      await pumpEventQueue();

      expect(queue.commands().single.state, CommandState.accepted, reason: 'unlocking triggers the runner; it does not wait for another signal');
    });

    test('the upload runner of the application does not send on a locked cold start, and resumes the moment the session is unlocked', () async {
      final TestStorage storage = TestStorage.create();
      final LocalStore store = await storage.open();
      store.deviceId = '11111111-1111-4111-8111-111111111111';
      final FakeSyncServer server = FakeSyncServer();
      final FakeSession session = FakeSession(_locked);
      final ProviderContainer container = containerFor(storage: storage, server: server, session: session);
      final AttachmentUploader uploader = await container.read(attachmentUploaderProvider.future);
      final Directory folder = Directory.systemTemp.createTempSync('machvon-locked-');
      addTearDown(() => folder.deleteSync(recursive: true));
      final File pdf = File('${folder.path}/a.pdf')..writeAsBytesSync(<int>[...'%PDF-1.4 locked test'.codeUnits]);
      final AttachmentUpload added = await uploader.add(file: pdf, ownerKind: 'report');
      container.listen(uploadRunnerProvider, (previous, next) {});
      await container.read(uploadRunnerProvider.future);
      await pumpEventQueue();
      expect(server.calls.where((HttpCall c) => c.url.path.endsWith('/sync/attachments')), isEmpty);
      expect(uploader.upload(added.id)!.state, UploadState.pending);

      session.change(_unlocked);
      for (int turn = 0; turn < 50 && !server.calls.any((HttpCall c) => c.url.path.endsWith('/sync/attachments')); turn += 1) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }

      expect(server.calls.where((HttpCall c) => c.url.path.endsWith('/sync/attachments')), isNotEmpty, reason: 'unlocking resumes the uploads');
    });
  });
}
