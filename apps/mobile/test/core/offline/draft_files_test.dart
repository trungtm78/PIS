import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_files.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:path/path.dart' as p;

import '../../support/queue_rig.dart';

File _file(Directory folder, String name) {
  folder.createSync(recursive: true);
  return File(p.join(folder.path, name))..writeAsBytesSync(<int>[0xFF, 0xD8, 0xFF, 0xE0]);
}

void main() {
  group('AC-ST-MOB-041-1 UAT-NFR-TENANCY-07 SEC-03 the plain copies of the photographs of a draft the server accepted are retired', () {
    late Directory evidence;
    late Directory elsewhere;

    setUp(() {
      final Directory root = Directory.systemTemp.createTempSync('machvon-draft-files-');
      addTearDown(() => root.deleteSync(recursive: true));
      evidence = Directory(p.join(root.path, 'evidence'));
      elsewhere = Directory(p.join(root.path, 'documents'));
    });

    test('the files a draft names under path and original_path are found at any depth, and only those inside the folder', () {
      final File prepared = _file(evidence, 'a.jpg');
      final File original = _file(evidence, 'a-original.jpg');
      final File mine = _file(elsewhere, 'contract.pdf');
      final Object fields = <String, Object?>{
        'photos': <Object?>[
          <String, Object?>{'path': prepared.path, 'original_path': original.path, 'mime': 'image/jpeg'},
          <String, Object?>{'path': mine.path},
        ],
        'nested': <String, Object?>{
          'deeper': <Object?>[
            <String, Object?>{'original_path': p.join(evidence.path, '..', 'documents', 'contract.pdf')},
          ],
        },
        'title': prepared.path,
        'path': 42,
      };

      final List<String> found = draftFilesInside(evidence, fields).map((File f) => f.path).toList();

      expect(found, <String>[prepared.path, original.path]);
      expect(retireDraftFiles(evidence, fields), 2);
      expect(prepared.existsSync(), isFalse);
      expect(original.existsSync(), isFalse);
      expect(mine.existsSync(), isTrue, reason: 'a path that points outside the private folder is never touched, even when it climbs out of it');
      expect(retireDraftFiles(evidence, fields), 0, reason: 'what is gone is not an error');
    });

    test('fields without any file, and values that are not paths, are walked without error', () {
      expect(draftFilesInside(evidence, <String, Object?>{'n': 1, 'list': <Object?>[1, 'x', null], 'path': ''}), isEmpty);
      expect(retireDraftFiles(evidence, null), 0);
    });

    for (final bool release in <bool>[false, true]) {
      test('the queue retires them when the command that carries the draft is accepted (the draft ${release ? 'is released' : 'stays as synced'})', () async {
        final QueueRig rig = await QueueRig.create();
        final File prepared = _file(rig.store.evidenceDirectory, 'p.jpg');
        final File original = _file(rig.store.evidenceDirectory, 'p-original.jpg');
        final File keep = _file(rig.store.uploadsDirectory, 'chunks-in-flight');
        rig.store.drafts.upsert(LocalDraft(
          id: 'draft-0000000000000001',
          tenantId: 'tenant-a',
          userId: 'user-1',
          kind: 'issue',
          fields: <String, Object?>{
            'photos': <Object?>[
              <String, Object?>{'path': prepared.path, 'original_path': original.path},
            ],
          },
          baseServerVersion: 0,
          status: DraftStatus.editing,
          createdAt: 1,
          updatedAt: 1,
        ));
        final QueuedCommand command = rig.queue.enqueue(
          commandType: 'report.submit',
          payload: <String, Object?>{'report_id': '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a01'},
          baseServerVersion: 3,
          draftId: 'draft-0000000000000001',
          releaseDraft: release,
        );
        expect(prepared.existsSync(), isTrue, reason: 'the draft is still the person\'s work while the command waits');

        final FlushResult result = await rig.queue.flush();

        expect(result.accepted, 1);
        expect(rig.queue.command(command.id)!.state, CommandState.accepted);
        expect(prepared.existsSync(), isFalse);
        expect(original.existsSync(), isFalse);
        expect(keep.existsSync(), isTrue, reason: 'only the files a draft names are retired');
      });
    }

    test('a command that is refused keeps the files: the draft is still the person\'s work', () async {
      final QueueRig rig = await QueueRig.create();
      final File prepared = _file(rig.store.evidenceDirectory, 'p.jpg');
      rig.store.drafts.upsert(LocalDraft(
        id: 'draft-0000000000000002',
        tenantId: 'tenant-a',
        userId: 'user-1',
        kind: 'issue',
        fields: <String, Object?>{
          'photos': <Object?>[
            <String, Object?>{'path': prepared.path},
          ],
        },
        baseServerVersion: 0,
        status: DraftStatus.editing,
        createdAt: 1,
        updatedAt: 1,
      ));
      rig.server.failNext = (status: 422, code: 'LICENSE_EXPIRED');
      rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'report_id': 'r'}, baseServerVersion: 3, draftId: 'draft-0000000000000002');
      await rig.queue.flush();
      expect(prepared.existsSync(), isTrue);
    });
  });
}
