import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/attachments/chunk_transport.dart';
import 'package:machvon_mobile/core/session/session.dart';

import '../../support/fake_attachment_server.dart';
import '../../support/queue_rig.dart';
import 'attachment_uploader_test.dart' show UploaderRig, deviceId;

/// A point of the exchange the test holds still: `reached` completes when the code under test waits at it, `open` lets it go on.
class Gate {
  final Completer<void> _reached = Completer<void>();
  final Completer<void> _released = Completer<void>();

  Future<void> get reached => _reached.future;

  Future<void> pass() {
    if (!_reached.isCompleted) _reached.complete();
    return _released.future;
  }

  void open() {
    if (!_released.isCompleted) _released.complete();
  }
}

/// The fake server with answers held back: the server has done the work, the answer is still on its way to the phone.
class GatedServer extends FakeAttachmentServer {
  GatedServer();

  Gate? afterStart;
  Gate? afterChunk;
  Gate? afterComplete;

  @override
  Future<HttpResult> send(HttpCall call) async {
    final HttpResult result = await super.send(call);
    if (call.method == 'POST' && call.url.path.endsWith('/complete')) {
      await afterComplete?.pass();
    } else if (call.method == 'POST' && call.url.path.endsWith('/sync/attachments')) {
      await afterStart?.pass();
    }
    return result;
  }

  @override
  Future<ChunkAnswer> put(Uri url, Uint8List bytes) async {
    final ChunkAnswer answer = await super.put(url, bytes);
    await afterChunk?.pass();
    return answer;
  }
}

void main() {
  group('REVIEW-m1-5 a cancelled upload stays cancelled whatever answer was still on its way', () {
    Future<(UploaderRig, GatedServer, AttachmentUpload)> gated({Future<String?> Function()? deviceLookup}) async {
      final GatedServer server = GatedServer();
      final UploaderRig rig = await UploaderRig.create(server: server, deviceLookup: deviceLookup);
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');
      return (rig, server, added);
    }

    void expectTerminal(UploaderRig rig, AttachmentUpload added) {
      final AttachmentUpload now = rig.uploader.upload(added.id)!;
      expect(now.state, UploadState.cancelled);
      expect(now.errorCode, isNull, reason: 'the cancellation is not turned into a failure');
      expect(File(added.sourcePath).existsSync(), isFalse, reason: 'the prepared copy stays removed');
    }

    test('while the answer of a chunk is awaited: no further chunk is sent, the upload is not completed, the state is not overwritten', () async {
      final (UploaderRig rig, GatedServer server, AttachmentUpload added) = await gated();
      server.afterChunk = Gate();
      final Future<void> running = rig.uploader.run(added.id);
      await server.afterChunk!.reached;
      rig.uploader.cancel(added.id);
      server.afterChunk!.open();
      await running;
      expectTerminal(rig, added);
      expect(server.chunkLog, hasLength(1), reason: 'only the chunk that was already on its way');
      expect(server.calls.where((HttpCall c) => c.url.path.endsWith('/complete')), isEmpty);
    });

    test('while the start is awaited: the answer is dropped and nothing is sent', () async {
      final (UploaderRig rig, GatedServer server, AttachmentUpload added) = await gated();
      server.afterStart = Gate();
      final Future<void> running = rig.uploader.run(added.id);
      await server.afterStart!.reached;
      rig.uploader.cancel(added.id);
      server.afterStart!.open();
      await running;
      expectTerminal(rig, added);
      expect(rig.uploader.upload(added.id)!.serverId, isNull);
      expect(server.chunkLog, isEmpty);
    });

    test('while the completion is awaited: the file is not marked clean', () async {
      final (UploaderRig rig, GatedServer server, AttachmentUpload added) = await gated();
      server.afterComplete = Gate();
      final Future<void> running = rig.uploader.run(added.id);
      await server.afterComplete!.reached;
      rig.uploader.cancel(added.id);
      server.afterComplete!.open();
      await running;
      expectTerminal(rig, added);
    });

    test('while the device id is awaited: nothing is started', () async {
      final Completer<String?> device = Completer<String?>();
      final (UploaderRig rig, GatedServer server, AttachmentUpload added) = await gated(deviceLookup: () => device.future);
      final Future<void> running = rig.uploader.run(added.id);
      await pumpEventQueue();
      rig.uploader.cancel(added.id);
      device.complete(deviceId);
      await running;
      expectTerminal(rig, added);
      expect(server.started, 0);
    });

    test('an unknown device answered after the cancellation does not bring the upload back to waiting', () async {
      final Completer<String?> device = Completer<String?>();
      final (UploaderRig rig, GatedServer server, AttachmentUpload added) = await gated(deviceLookup: () => device.future);
      final Future<void> running = rig.uploader.run(added.id);
      await pumpEventQueue();
      rig.uploader.cancel(added.id);
      device.complete(null);
      await running;
      expectTerminal(rig, added);
      expect(server.started, 0);
    });
  });

  group('REVIEW-m1-1 an uploader that is disposed or whose session changed sends nothing more', () {
    test('after dispose, the answer that was on its way changes nothing and nothing else is sent', () async {
      final GatedServer server = GatedServer();
      final UploaderRig rig = await UploaderRig.create(server: server);
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');
      server.afterChunk = Gate();
      final Future<void> running = rig.uploader.run(added.id);
      await server.afterChunk!.reached;
      final int before = server.calls.length;
      await rig.uploader.dispose();
      server.afterChunk!.open();
      await running;
      expect(server.chunkLog, hasLength(1));
      expect(server.calls.length, before, reason: 'no request after the dispose');
      expect(rig.uploader.upload(added.id)!.state, UploadState.uploading, reason: 'the row is left as it was; recoverInterrupted puts it back to waiting on the next open');
    });

    test('a session that moves to another tenant in the middle of a run stops it before the next request: the file waits for its own tenant', () async {
      final GatedServer server = GatedServer();
      SessionSnapshot session = kSignedInA;
      final UploaderRig rig = await UploaderRig.create(server: server, sessionOf: () => session);
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');
      server.afterChunk = Gate();
      final Future<void> running = rig.uploader.run(added.id);
      await server.afterChunk!.reached;
      session = const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-1');
      server.afterChunk!.open();
      await running;
      expect(server.chunkLog, hasLength(1), reason: 'no second chunk of tenant-a once tenant-b is active');
      expect(server.calls.where((HttpCall c) => c.url.path.endsWith('/complete')), isEmpty);
      final AttachmentUpload now = rig.uploader.upload(added.id)!;
      expect(now.state, UploadState.pending);
      expect(now.errorCode, 'SESSION_EXPIRED');
    });

    test('a token refused because another tenant is active leaves the file waiting for its own tenant, and nothing leaves the phone', () async {
      final UploaderRig rig = await UploaderRig.create(tokenOf: () async => throw const TenantMismatch());
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');
      await rig.uploader.run(added.id);
      final AttachmentUpload now = rig.uploader.upload(added.id)!;
      expect(now.state, UploadState.pending);
      expect(now.errorCode, 'SESSION_EXPIRED');
      expect(rig.server.calls, isEmpty);
    });
  });
}
