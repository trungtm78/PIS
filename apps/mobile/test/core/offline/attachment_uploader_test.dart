import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_policy.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_uploader.dart';
import 'package:machvon_mobile/core/offline/attachments/chunk_transport.dart';
import 'package:machvon_mobile/core/offline/attachments/image_compressor.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/core/session/session.dart';

import '../../support/fake_attachment_server.dart';
import '../../support/offline_support.dart';
import '../../support/queue_rig.dart';

const String deviceId = '11111111-1111-4111-8111-111111111111';

/// An uploader on a real encrypted store and a temporary folder, talking to the fake attachment server through the real
/// generated client.
class UploaderRig {
  UploaderRig._(this.storage, this.store, this.server, this.uploader, this.folder, this.clock);

  final TestStorage storage;
  final LocalStore store;
  final FakeAttachmentServer server;
  final AttachmentUploader uploader;
  final Directory folder;
  final FakeClock clock;

  static Future<UploaderRig> create({
    FakeAttachmentServer? server,
    TestStorage? storage,
    ImageCompressor? compressor,
    SessionSnapshot session = kSignedInA,
    SessionSnapshot Function()? sessionOf,
    Future<String?> Function()? tokenOf,
    Future<String?> Function()? deviceLookup,
    String? device = deviceId,
    int chunkBytes = 4,
  }) async {
    final TestStorage test = storage ?? TestStorage.create();
    final LocalStore store = await test.open();
    final FakeAttachmentServer fake = server ?? FakeAttachmentServer(chunkBytes: chunkBytes);
    final Directory folder = Directory.systemTemp.createTempSync('machvon-files-');
    addTearDown(() {
      if (folder.existsSync()) folder.deleteSync(recursive: true);
    });
    final FakeClock clock = FakeClock();
    int counter = 1;
    final MachvonApiClient client = MachvonApiClient(
      baseUrl: Uri.parse('https://api.test/v1'),
      transport: fake,
      token: tokenOf ?? () async => 'test-token',
      newKey: () => 'a0000000-0000-4000-8000-${(counter++).toString().padLeft(12, '0')}',
      delay: (Duration _) async {},
    );
    final AttachmentUploader uploader = AttachmentUploader(
      store: store,
      client: client,
      baseUrl: Uri.parse('https://api.test/v1'),
      chunks: fake,
      session: sessionOf ?? () => session,
      deviceId: deviceLookup ?? () async => device,
      compressor: compressor,
      clock: clock.call,
      newKey: () => 'b0000000-0000-4000-8000-${(counter++).toString().padLeft(12, '0')}',
    );
    return UploaderRig._(test, store, fake, uploader, folder, clock);
  }

  /// A PDF of [size] bytes: the header and then bytes that depend on [seed].
  File pdf(String name, int size, {int seed = 1, String? text}) {
    final Random random = Random(seed);
    final Uint8List bytes = Uint8List(size);
    for (int i = 0; i < size; i += 1) {
      bytes[i] = random.nextInt(256);
    }
    bytes.setRange(0, 5, '%PDF-'.codeUnits);
    if (text != null) bytes.setRange(10, 10 + text.length, text.codeUnits);
    return File('${folder.path}/$name')..writeAsBytesSync(bytes);
  }

  List<UploadState> record() {
    final List<UploadState> states = <UploadState>[];
    final sub = uploader.watch().listen((List<AttachmentUpload> list) {
      if (list.isNotEmpty && (states.isEmpty || states.last != list.last.state)) states.add(list.last.state);
    });
    addTearDown(sub.cancel);
    return states;
  }
}

String sha256Of(List<int> bytes) => sha256.convert(bytes).toString();

void main() {
  group('AC-ST-MOB-009-1 UAT-PLAN-34 a 12 MB file with the network cut at chunk 7 resumes without sending chunks 1 to 6 again', () {
    test('the chunks the server holds are not sent again, the checksum matches, and the status moves UPLOADING, SCANNING, CLEAN', () async {
      final FakeAttachmentServer server = FakeAttachmentServer(chunkBytes: 1024 * 1024);
      final UploaderRig rig = await UploaderRig.create(server: server);
      final File file = rig.pdf('report.pdf', 12 * 1024 * 1024);
      final List<UploadState> seen = rig.record();
      final AttachmentUpload added = await rig.uploader.add(file: file, ownerKind: 'report', ownerRef: 'r-1');
      expect(added.state, UploadState.pending);
      expect(added.sha256, sha256Of(file.readAsBytesSync()));

      server.cutAtChunk = 6;
      await rig.uploader.run(added.id);
      AttachmentUpload cut = rig.uploader.upload(added.id)!;
      expect(cut.state, UploadState.pending);
      expect(cut.errorCode, networkErrorCode);
      expect(cut.sentChunks, <int>{0, 1, 2, 3, 4, 5}, reason: 'the progress is stored: chunks 1 to 6');
      expect(cut.progress, 0.5);
      expect(() => rig.uploader.linkableId(added.id), throwsA(isA<AttachmentNotClean>()));

      await rig.uploader.run(added.id);
      cut = rig.uploader.upload(added.id)!;
      expect(cut.state, UploadState.clean);
      for (int index = 0; index < 6; index += 1) {
        expect(server.chunkSends(cut.serverId!, index), 1, reason: 'chunk ${index + 1} was sent once');
      }
      expect(server.chunkSends(cut.serverId!, 6), 2, reason: 'the cut chunk is sent again');
      expect(server.started, 1, reason: 'one upload on the server');
      expect(cut.sentChunks, <int>{for (int i = 0; i < 12; i += 1) i}, reason: 'the chunks the server held are counted with the ones sent now');
      expect(sha256Of(server.storedBytes(cut.serverId!)!), added.sha256, reason: 'the completed file has the checksum of the original');
      expect(server.storedBytes(cut.serverId!), file.readAsBytesSync());
      await Future<void>.delayed(Duration.zero);
      expect(seen, <UploadState>[UploadState.pending, UploadState.uploading, UploadState.pending, UploadState.uploading, UploadState.scanning, UploadState.clean]);
      expect(rig.uploader.linkableId(added.id), cut.serverId);
    });

    test('the app is killed in the middle: a new uploader on the same store asks the server and sends only what is missing', () async {
      final UploaderRig first = await UploaderRig.create();
      final File file = first.pdf('a.pdf', 40);
      final AttachmentUpload added = await first.uploader.add(file: file, ownerKind: 'report');
      first.server.cutAtChunk = 5;
      await first.uploader.run(added.id);
      // the process dies while the row says uploading
      first.store.uploads.upsert(first.uploader.upload(added.id)!.copyWith(state: UploadState.uploading));

      final UploaderRig second = await UploaderRig.create(server: first.server, storage: first.storage);
      expect(second.uploader.recoverInterrupted(), 1);
      expect(second.uploader.upload(added.id)!.state, UploadState.pending);
      expect(second.uploader.upload(added.id)!.errorCode, 'INTERRUPTED');
      await second.uploader.resumeAll();
      final AttachmentUpload done = second.uploader.upload(added.id)!;
      expect(done.state, UploadState.clean);
      for (int index = 0; index < 5; index += 1) {
        expect(first.server.chunkSends(done.serverId!, index), 1);
      }
      expect(first.server.started, 1);
    });

    test('the start whose answer was lost does not make a second upload: it carries the key of the upload', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 10), ownerKind: 'report');
      rig.server.dropNextStartAnswer = true;
      await rig.uploader.run(added.id);
      expect(rig.uploader.upload(added.id)!.state, UploadState.pending);
      expect(rig.uploader.upload(added.id)!.serverId, isNull);
      await rig.uploader.run(added.id);
      expect(rig.uploader.upload(added.id)!.state, UploadState.clean);
      expect(rig.server.started, 1, reason: 'the same Idempotency-Key gave the same upload back');
    });

    test('a link that expired is replaced by a fresh one from the server, and the chunks already held are not sent again', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 20), ownerKind: 'report');
      rig.server.cutAtChunk = 3;
      await rig.uploader.run(added.id);
      rig.server.expireIssuedLinks();
      await rig.uploader.run(added.id);
      final AttachmentUpload done = rig.uploader.upload(added.id)!;
      expect(done.state, UploadState.clean);
      expect(rig.server.chunkSends(done.serverId!, 0), 1);
    });

    test('a chunk the storage lost after acknowledging it is sent again when the completion finds it missing', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 20), ownerKind: 'report');
      rig.server.forgetChunkOnce = 2;
      await rig.uploader.run(added.id);
      final AttachmentUpload done = rig.uploader.upload(added.id)!;
      expect(done.state, UploadState.clean);
      expect(rig.server.chunkSends(done.serverId!, 2), 2);
      expect(rig.server.chunkSends(done.serverId!, 1), 1);
    });

    test('a checksum that does not match makes the server drop the chunks: the file is sent again once with a new completion, and then settles', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');
      rig.server.corruptNextChunk = true;
      await rig.uploader.run(added.id);
      final AttachmentUpload done = rig.uploader.upload(added.id)!;
      expect(done.state, UploadState.clean);
      expect(done.restarts, 1);
      expect(done.completeKey, isNot(added.completeKey), reason: 'the refusal is remembered under the old key');
      expect(rig.server.chunkSends(done.serverId!, 0), 2);
    });

    test('a checksum that never matches ends the upload after the restarts it is allowed, with the code', () async {
      // every chunk reaches the storage damaged
      final UploaderRig rig = await UploaderRig.create(server: _DamagingServer());
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 8), ownerKind: 'report');
      await rig.uploader.run(added.id);
      final AttachmentUpload failed = rig.uploader.upload(added.id)!;
      expect(failed.state, UploadState.failed);
      expect(failed.errorCode, 'CHECKSUM_MISMATCH');
      expect(failed.restarts, 2);
    });
  });

  group('AC-ST-MOB-041-1 UAT-NFR-TENANCY-07 SEC-03 the prepared copy of a file the server holds clean does not stay on the phone', () {
    test('after the completion answers CLEAN the prepared copy is deleted, the row stays with its checksum and server id, and the original of the person is untouched', () async {
      final UploaderRig rig = await UploaderRig.create();
      final File original = rig.pdf('report.pdf', 40);
      final AttachmentUpload added = await rig.uploader.add(file: original, ownerKind: 'report');
      expect(File(added.sourcePath).existsSync(), isTrue);
      await rig.uploader.run(added.id);
      final AttachmentUpload done = rig.uploader.upload(added.id)!;
      expect(done.state, UploadState.clean);
      expect(File(done.sourcePath).existsSync(), isFalse);
      expect(done.sha256, added.sha256);
      expect(done.serverId, isNotNull);
      expect(rig.store.uploadsDirectory.listSync(), isEmpty, reason: 'nothing of the file is left in the private folder');
      expect(original.existsSync(), isTrue);
      expect(rig.uploader.linkableId(added.id), done.serverId);
    });

    test('the same when the server already holds the file clean at the next look (the answer to the completion was lost)', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 20), ownerKind: 'report');
      await rig.uploader.run(added.id);
      final AttachmentUpload clean = rig.uploader.upload(added.id)!;
      // The phone never saw the answer: the row says uploading and the prepared copy is still there.
      File(clean.sourcePath).writeAsBytesSync(rig.server.storedBytes(clean.serverId!)!);
      rig.store.uploads.upsert(clean.copyWith(state: UploadState.pending));
      await rig.uploader.run(added.id);
      expect(rig.uploader.upload(added.id)!.state, UploadState.clean);
      expect(File(clean.sourcePath).existsSync(), isFalse);
    });

    test('an infected or unfinished upload keeps its prepared copy: the person may retry it', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('eicar.pdf', 80, text: 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!'), ownerKind: 'report');
      await rig.uploader.run(added.id);
      final AttachmentUpload infected = rig.uploader.upload(added.id)!;
      expect(infected.state, UploadState.infected);
      expect(File(infected.sourcePath).existsSync(), isTrue);
    });
  });

  group('AC-ST-MOB-009-2 UAT-AC506 an infected file is not linked and the person sees why, with a retry', () {
    test('the EICAR test file is INFECTED: the state, the reason, no link, and Retry starts a new upload', () async {
      final UploaderRig rig = await UploaderRig.create();
      final File eicar = rig.pdf('eicar.pdf', 80, text: 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!');
      final AttachmentUpload added = await rig.uploader.add(file: eicar, ownerKind: 'report', ownerRef: 'r-1');
      final List<UploadState> seen = rig.record();
      await rig.uploader.run(added.id);
      final AttachmentUpload infected = rig.uploader.upload(added.id)!;
      expect(infected.state, UploadState.infected);
      expect(infected.errorCode, 'FILE_INFECTED');
      expect(rig.server.statusOf(infected.serverId!), 'INFECTED');
      expect(() => rig.uploader.linkableId(added.id), throwsA(isA<AttachmentNotClean>().having((AttachmentNotClean e) => e.state, 'state', UploadState.infected)));
      await Future<void>.delayed(Duration.zero);
      expect(seen, containsAllInOrder(<UploadState>[UploadState.scanning, UploadState.infected]));

      await rig.uploader.retry(added.id);
      final AttachmentUpload again = rig.uploader.upload(added.id)!;
      expect(again.state, UploadState.infected, reason: 'the same file is infected again');
      expect(again.serverId, isNot(infected.serverId));
      expect(again.startKey, isNot(added.startKey));
      expect(rig.server.started, 2);
    });

    test('only a refused or infected upload can be retried, and only an unfinished one cancelled', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 8), ownerKind: 'report');
      expect(() => rig.uploader.retry(added.id), throwsStateError);
      await rig.uploader.run(added.id);
      expect(() => rig.uploader.retry(added.id), throwsStateError, reason: 'clean');
      expect(() => rig.uploader.cancel(added.id), throwsStateError);
      expect(() => rig.uploader.retry('nope'), throwsStateError);
      expect(() => rig.uploader.linkableId('nope'), throwsArgumentError);
      final AttachmentUpload other = await rig.uploader.add(file: rig.pdf('b.pdf', 8, seed: 2), ownerKind: 'report');
      final File prepared = File(other.sourcePath);
      expect(prepared.existsSync(), isTrue);
      rig.uploader.cancel(other.id);
      expect(rig.uploader.upload(other.id)!.state, UploadState.cancelled);
      expect(prepared.existsSync(), isFalse, reason: 'the prepared copy goes');
      await rig.uploader.run(other.id);
      expect(rig.server.started, 1, reason: 'a cancelled upload is not run');
    });
  });

  group('AC-ST-MOB-009-3 UAT-NFR-TENANCY-05 a link of another tenant or an expired link is never used', () {
    test('the link is on the chunk path of an attachment of this tenant under this server, or it is refused', () {
      final Uri base = Uri.parse('https://api.test/v1');
      const String id = '00000000-0000-4000-8000-000000000001';
      expect(resolveChunkUrl(base, '/sync/attachments/$id/chunks/3?tenant=tenant-a&epoch=1&expires=9&signature=ab', 'tenant-a').toString(), 'https://api.test/v1/sync/attachments/$id/chunks/3?tenant=tenant-a&epoch=1&expires=9&signature=ab');
      expect(resolveChunkUrl(Uri.parse('https://api.test/v1/'), '/sync/attachments/$id/chunks/0?tenant=tenant-a', 'tenant-a').path, '/v1/sync/attachments/$id/chunks/0');
      for (final String bad in <String>[
        '/sync/attachments/$id/chunks/3?tenant=tenant-b&epoch=1',
        '/sync/attachments/$id/chunks/3?epoch=1',
        'https://evil.test/sync/attachments/$id/chunks/3?tenant=tenant-a',
        '//evil.test/sync/attachments/$id/chunks/3?tenant=tenant-a',
        '/sync/attachments/$id/chunks/../../../admin?tenant=tenant-a',
        '/files/$id?tenant=tenant-a',
        '/sync/attachments/$id/chunks/x?tenant=tenant-a',
        '/sync/attachments/not-an-id/chunks/3?tenant=tenant-a',
      ]) {
        expect(() => resolveChunkUrl(base, bad, 'tenant-a'), throwsA(isA<ChunkLinkRefused>()), reason: bad);
      }
    });

    test('a link that names another tenant ends the upload: nothing is sent to it', () async {
      final FakeAttachmentServer server = FakeAttachmentServer(tenantId: 'tenant-b');
      final UploaderRig rig = await UploaderRig.create(server: server);
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 8), ownerKind: 'report');
      await rig.uploader.run(added.id);
      final AttachmentUpload failed = rig.uploader.upload(added.id)!;
      expect(failed.state, UploadState.failed);
      expect(failed.errorCode, 'CHUNK_LINK_REFUSED');
      expect(server.chunkLog, isEmpty, reason: 'no byte of the file went to a link of another tenant');
    });

    test('a link the storage refuses as stale is replaced a limited number of times, then the upload ends', () async {
      final UploaderRig rig = await UploaderRig.create(server: _StaleServer());
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 8), ownerKind: 'report');
      await rig.uploader.run(added.id);
      final AttachmentUpload failed = rig.uploader.upload(added.id)!;
      expect(failed.state, UploadState.failed);
      expect(failed.errorCode, 'SIGNATURE_INVALID');
    });

    test('the chunk transport sends over https only, with the exact length, and never follows a redirect', () async {
      final DartIoChunkTransport transport = DartIoChunkTransport();
      await expectLater(transport.put(Uri.parse('http://api.test/x'), Uint8List(1)), throwsStateError);
      final HttpServer server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final List<String> seen = <String>[];
      server.listen((HttpRequest request) async {
        final List<int> body = await request.fold<List<int>>(<int>[], (List<int> all, List<int> part) => all..addAll(part));
        seen.add('${request.method} ${request.uri.path} ${request.headers.contentLength} ${body.length} ${request.headers.value('authorization')}');
        if (request.uri.path == '/redirect') {
          request.response.statusCode = 302;
          request.response.headers.set('location', '/elsewhere');
        } else if (request.uri.path == '/refuse') {
          request.response.statusCode = 401;
          request.response.headers.contentType = ContentType.json;
          request.response.write('{"code":"SIGNATURE_INVALID","title":"secret server text"}');
        } else if (request.uri.path == '/garbage') {
          request.response.statusCode = 500;
          request.response.write('<html>gateway</html>');
        }
        await request.response.close();
      });
      final DartIoChunkTransport local = DartIoChunkTransport(allowInsecureLoopback: true);
      final String origin = 'http://127.0.0.1:${server.port}';
      final ChunkAnswer ok = await local.put(Uri.parse('$origin/ok'), Uint8List.fromList(<int>[1, 2, 3]));
      expect(ok.ok, isTrue);
      expect(seen.single, 'PUT /ok 3 3 null', reason: 'the exact length, and no bearer token goes to a signed link');
      final ChunkAnswer redirect = await local.put(Uri.parse('$origin/redirect'), Uint8List(1));
      expect(redirect.status, 302);
      expect(seen.where((String s) => s.contains('/elsewhere')), isEmpty);
      final ChunkAnswer refused = await local.put(Uri.parse('$origin/refuse'), Uint8List(1));
      expect((refused.status, refused.code), (401, 'SIGNATURE_INVALID'));
      final ChunkAnswer garbage = await local.put(Uri.parse('$origin/garbage'), Uint8List(1));
      expect((garbage.status, garbage.code), (500, ''));
    });
  });

  group('AC-ST-MOB-009-4 UAT-NFR-SECURITY-12 the type is judged by the bytes, never by the name', () {
    test('a script renamed to .jpg is refused before anything is copied or sent', () async {
      final UploaderRig rig = await UploaderRig.create();
      final File script = File('${rig.folder.path}/photo.jpg')..writeAsStringSync('#!/bin/sh\nrm -rf /\n');
      await expectLater(rig.uploader.add(file: script, ownerKind: 'report'), throwsA(isA<AttachmentRefused>().having((AttachmentRefused e) => e.code, 'code', 'FILE_TYPE_NOT_ALLOWED')));
      expect(rig.uploader.uploads(), isEmpty);
      expect(rig.server.calls, isEmpty);
      expect(rig.store.uploadsDirectory.existsSync() ? rig.store.uploadsDirectory.listSync() : <FileSystemEntity>[], isEmpty);
    });

    test('and when the server refuses the type of a file that looked right (422 FILE_TYPE_NOT_ALLOWED), the upload ends with that code', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('a.pdf', 8), ownerKind: 'report');
      rig.server.refuseNextCompletion = (status: 422, code: 'FILE_TYPE_NOT_ALLOWED');
      await rig.uploader.run(added.id);
      expect(rig.uploader.upload(added.id)!.state, UploadState.failed);
      expect(rig.uploader.upload(added.id)!.errorCode, 'FILE_TYPE_NOT_ALLOWED');
    });

    test('the type is read from the first bytes: JPEG, PNG and PDF, and nothing else', () {
      expect(sniffMime(<int>[0xFF, 0xD8, 0xFF, 0xE0]), 'image/jpeg');
      expect(sniffMime(<int>[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0]), 'image/png');
      expect(sniffMime('%PDF-1.7'.codeUnits), 'application/pdf');
      expect(sniffMime('GIF89a'.codeUnits), isNull);
      expect(sniffMime(<int>[0xFF, 0xD8]), isNull);
      expect(sniffMime(<int>[]), isNull);
      expect(sniffMime('<script>'.codeUnits), isNull);
    });

    test('a missing file, an empty file and a file over 50 MiB are refused with their codes', () async {
      final UploaderRig rig = await UploaderRig.create();
      Future<String> codeOf(File file) async {
        try {
          await rig.uploader.add(file: file, ownerKind: 'report');
        } on AttachmentRefused catch (refused) {
          return refused.code;
        }
        return 'accepted';
      }

      expect(await codeOf(File('${rig.folder.path}/missing.pdf')), 'FILE_NOT_FOUND');
      expect(await codeOf(File('${rig.folder.path}/empty.pdf')..writeAsBytesSync(<int>[])), 'FILE_TYPE_NOT_ALLOWED');
      final File big = File('${rig.folder.path}/big.pdf');
      final RandomAccessFile handle = big.openSync(mode: FileMode.write)..setPositionSync(0)..writeFromSync('%PDF-'.codeUnits)..truncateSync(kMaxAttachmentBytes + 1);
      handle.closeSync();
      expect(await codeOf(big), 'FILE_TOO_LARGE');
      expect(rig.store.uploadsDirectory.existsSync(), isFalse, reason: 'a file that is too large is refused before it is copied');
      final File limit = File('${rig.folder.path}/limit.pdf');
      final RandomAccessFile exact = limit.openSync(mode: FileMode.write)..writeFromSync('%PDF-'.codeUnits)..truncateSync(kMaxAttachmentBytes);
      exact.closeSync();
      expect(await codeOf(limit), 'accepted', reason: '50 MiB exactly is allowed');
    });
  });

  group('TK-MOB-009-4 photos are made lighter, other files are kept, and a file is prepared once', () {
    test('a large JPEG is scaled down and recompressed, and the checksum is that of the prepared copy', () async {
      final UploaderRig rig = await UploaderRig.create();
      final img.Image photo = img.Image(width: 3000, height: 2000);
      for (int y = 0; y < 2000; y += 7) {
        for (int x = 0; x < 3000; x += 5) {
          photo.setPixelRgb(x, y, (x * 7 + y) % 256, (x + y * 3) % 256, (x * y) % 256);
        }
      }
      final File original = File('${rig.folder.path}/site.jpg')..writeAsBytesSync(img.encodeJpg(photo, quality: 100));
      final AttachmentUpload added = await rig.uploader.add(file: original, ownerKind: 'issue');
      final Uint8List prepared = File(added.sourcePath).readAsBytesSync();
      expect(added.mime, 'image/jpeg');
      expect(prepared.length, lessThan(original.lengthSync()));
      expect(img.decodeJpg(prepared)!.width, 2048);
      expect(added.sizeBytes, prepared.length);
      expect(added.sha256, sha256Of(prepared));
      expect(original.existsSync(), isTrue, reason: 'the original of the gallery is untouched');
      expect(added.fileName, 'site.jpg');
    });

    test('a small JPEG, a JPEG that cannot be decoded, a PNG and a PDF are kept as they are', () async {
      const PackageImageCompressor compressor = PackageImageCompressor();
      final Uint8List small = Uint8List.fromList(img.encodeJpg(img.Image(width: 40, height: 30), quality: 90));
      expect(await compressor.compress(small, 'image/jpeg'), small);
      final Uint8List broken = Uint8List.fromList(<int>[0xFF, 0xD8, 0xFF, 0, 1, 2, 3]);
      expect(await compressor.compress(broken, 'image/jpeg'), broken);
      final Uint8List png = Uint8List.fromList(img.encodePng(img.Image(width: 2500, height: 10)));
      expect(await compressor.compress(png, 'image/png'), png);
      final Uint8List pdf = Uint8List.fromList('%PDF-1.4 text'.codeUnits);
      expect(await compressor.compress(pdf, 'application/pdf'), pdf);
      final Uint8List wide = Uint8List.fromList(img.encodeJpg(img.Image(width: 2600, height: 20), quality: 100));
      final Uint8List scaled = await compressor.compress(wide, 'image/jpeg');
      expect(img.decodeJpg(scaled)!.width, 2048);
      final Uint8List tall = Uint8List.fromList(img.encodeJpg(img.Image(width: 20, height: 2600), quality: 100));
      expect(img.decodeJpg(await compressor.compress(tall, 'image/jpeg'))!.height, 2048);
    });

    test('a result that is not smaller than the original is dropped', () async {
      const PackageImageCompressor aggressive = PackageImageCompressor(thresholdBytes: 1, maxEdge: 4096, quality: 100);
      final Uint8List tiny = Uint8List.fromList(img.encodeJpg(img.Image(width: 8, height: 8), quality: 10));
      expect(await aggressive.compress(tiny, 'image/jpeg'), tiny);
    });
  });

  group('TK-MOB-009-4 who may upload, and what the uploader keeps', () {
    test('nothing is sent without a session of this tenant and user; without a device the file waits', () async {
      final UploaderRig signedOut = await UploaderRig.create(session: const SessionSnapshot.signedOut());
      final AttachmentUpload a = await signedOut.uploader.add(file: signedOut.pdf('a.pdf', 8), ownerKind: 'report');
      await signedOut.uploader.run(a.id);
      expect(signedOut.server.calls, isEmpty);
      expect(signedOut.uploader.upload(a.id)!.state, UploadState.pending);

      final UploaderRig noDevice = await UploaderRig.create(device: null);
      final AttachmentUpload b = await noDevice.uploader.add(file: noDevice.pdf('b.pdf', 8), ownerKind: 'report');
      await noDevice.uploader.run(b.id);
      expect(noDevice.uploader.upload(b.id)!.errorCode, 'NO_DEVICE');
      expect(noDevice.server.calls, isEmpty);
    });

    test('a prepared file that changed or went is not uploaded: the upload ends with FILE_CHANGED', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload a = await rig.uploader.add(file: rig.pdf('a.pdf', 8), ownerKind: 'report');
      File(a.sourcePath).writeAsBytesSync('%PDF-xx'.codeUnits);
      await rig.uploader.run(a.id);
      expect(rig.uploader.upload(a.id)!.errorCode, 'FILE_CHANGED');
      final AttachmentUpload b = await rig.uploader.add(file: rig.pdf('b.pdf', 8, seed: 3), ownerKind: 'report');
      File(b.sourcePath).deleteSync();
      await rig.uploader.run(b.id);
      expect(rig.uploader.upload(b.id)!.state, UploadState.failed);
      expect(rig.uploader.upload(b.id)!.errorCode, 'FILE_CHANGED');
    });

    test('an API that cannot be reached, a lapsed session and a busy server leave the file waiting; a refusal ends it', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload a = await rig.uploader.add(file: rig.pdf('a.pdf', 8), ownerKind: 'report');
      rig.server.offline = true;
      await rig.uploader.run(a.id);
      expect(rig.uploader.upload(a.id)!.state, UploadState.pending);
      expect(rig.uploader.upload(a.id)!.errorCode, networkErrorCode);
      rig.server.offline = false;
      await rig.uploader.run(a.id);
      expect(rig.uploader.upload(a.id)!.state, UploadState.clean);

      for (final ({int status, String code, UploadState state}) case_ in <({int status, String code, UploadState state})>[
        (status: 401, code: 'SESSION_EXPIRED', state: UploadState.pending),
        (status: 429, code: 'RATE_LIMIT', state: UploadState.pending),
        (status: 503, code: 'INTERNAL_ERROR', state: UploadState.pending),
        (status: 403, code: 'SCOPE_DENIED', state: UploadState.failed),
        (status: 422, code: 'VALIDATION_FAILED', state: UploadState.failed),
      ]) {
        final UploaderRig one = await UploaderRig.create(server: _RefusingServer(case_.status, case_.code));
        final AttachmentUpload upload = await one.uploader.add(file: one.pdf('a.pdf', 8), ownerKind: 'report');
        await one.uploader.run(upload.id);
        expect(one.uploader.upload(upload.id)!.state, case_.state, reason: case_.code);
        expect(one.uploader.upload(upload.id)!.errorCode, case_.code);
      }
    });

    test('purging the user removes the prepared files with the database', () async {
      final UploaderRig rig = await UploaderRig.create();
      final AttachmentUpload a = await rig.uploader.add(file: rig.pdf('a.pdf', 8), ownerKind: 'report');
      expect(File(a.sourcePath).existsSync(), isTrue);
      await rig.storage.storage.purge(tenantId: 'tenant-a', userId: 'user-1');
      expect(File(a.sourcePath).existsSync(), isFalse);
      expect(rig.store.uploadsDirectory.existsSync(), isFalse);
    });

    test('the uploads are announced to the list after every change, in the order they were added', () async {
      final UploaderRig rig = await UploaderRig.create();
      final List<int> counts = <int>[];
      final sub = rig.uploader.watch().listen((List<AttachmentUpload> list) => counts.add(list.length));
      await rig.uploader.add(file: rig.pdf('a.pdf', 8), ownerKind: 'report');
      await rig.uploader.add(file: rig.pdf('b.pdf', 8, seed: 2), ownerKind: 'report');
      await rig.uploader.resumeAll();
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();
      expect(counts.first, 0);
      expect(counts.last, 2);
      expect(rig.uploader.uploads().map((AttachmentUpload u) => u.state), <UploadState>[UploadState.clean, UploadState.clean]);
      expect(rig.uploader.uploads().map((AttachmentUpload u) => u.fileName), <String>['a.pdf', 'b.pdf']);
    });
  });
}

/// Storage that damages the first byte of every chunk, so the checksum never matches.
class _DamagingServer extends FakeAttachmentServer {
  @override
  Future<ChunkAnswer> put(Uri url, Uint8List bytes) {
    corruptNextChunk = true;
    return super.put(url, bytes);
  }
}

/// Storage that finds every link stale.
class _StaleServer extends FakeAttachmentServer {
  @override
  Future<ChunkAnswer> put(Uri url, Uint8List bytes) async => const ChunkAnswer(401, 'SIGNATURE_INVALID');
}

/// An API that refuses every call with one status and code.
class _RefusingServer extends FakeAttachmentServer {
  _RefusingServer(this.status, this.code);

  final int status;
  final String code;

  @override
  Future<HttpResult> send(HttpCall call) async => HttpResult(
        status: status,
        headers: const <String, String>{'content-type': 'application/problem+json'},
        body: '{"type":"about:blank","title":"$code","status":$status,"code":"$code"}',
      );
}
