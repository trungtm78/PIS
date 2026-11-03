import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/attachments/upload_runner.dart';

import 'attachment_uploader_test.dart' show UploaderRig;

class _Timers {
  final List<({Duration delay, void Function() run, _Timer timer})> scheduled = <({Duration delay, void Function() run, _Timer timer})>[];

  Timer make(Duration delay, void Function() callback) {
    final _Timer timer = _Timer();
    scheduled.add((delay: delay, run: callback, timer: timer));
    return timer;
  }

  List<({Duration delay, void Function() run, _Timer timer})> get active => scheduled.where((e) => !e.timer.cancelled).toList();
}

class _Timer implements Timer {
  bool cancelled = false;

  @override
  void cancel() => cancelled = true;

  @override
  bool get isActive => !cancelled;

  @override
  int get tick => 0;
}

void main() {
  group('TK-MOB-009-4 the upload runner keeps the uploads moving', () {
    test('it uploads what waits when started and when the network is back, and does not wake itself without a network', () async {
      final UploaderRig rig = await UploaderRig.create();
      final _Timers timers = _Timers();
      final UploadRunner runner = UploadRunner(rig.uploader, timer: timers.make);
      final AttachmentUpload a = await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');
      rig.server.offline = true;
      runner.start();
      await pumpEventQueue();
      expect(rig.uploader.upload(a.id)!.errorCode, 'NETWORK_ERROR');
      expect(timers.active, isEmpty, reason: 'the connectivity change is what resumes');
      rig.server.offline = false;
      runner.trigger();
      await pumpEventQueue();
      expect(rig.uploader.upload(a.id)!.state, UploadState.clean);
      runner.dispose();
    });

    test('AC-ST-MOB-040-3 SYNC-01 a file added while the runner is already running goes up at once, without a network change or a trigger', () async {
      final UploaderRig rig = await UploaderRig.create();
      final UploadRunner runner = UploadRunner(rig.uploader, timer: _Timers().make);
      runner.start();
      await pumpEventQueue();
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('late.pdf', 12), ownerKind: 'report');
      await pumpEventQueue();
      expect(rig.uploader.upload(added.id)!.state, UploadState.clean);

      runner.dispose();
      final AttachmentUpload after = await rig.uploader.add(file: rig.pdf('after.pdf', 12, seed: 3), ownerKind: 'report');
      await pumpEventQueue();
      expect(rig.uploader.upload(after.id)!.state, UploadState.pending, reason: 'a runner that was disposed listens to nothing');
    });

    test('a file that waits for another reason (a busy server) is tried again after the wait; a trigger during a run runs once more', () async {
      final UploaderRig rig = await UploaderRig.create();
      final _Timers timers = _Timers();
      final UploadRunner runner = UploadRunner(rig.uploader, timer: timers.make, retryAfter: const Duration(seconds: 9));
      final AttachmentUpload a = await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');
      rig.server.failNext = (status: 503, code: 'INTERNAL_ERROR');
      runner.start();
      runner.trigger();
      await pumpEventQueue();
      expect(rig.uploader.upload(a.id)!.state, UploadState.clean, reason: 'the trigger during the run made one more run, which finished it');
      expect(timers.active, isEmpty);

      rig.server.failNext = (status: 503, code: 'INTERNAL_ERROR');
      final AttachmentUpload b = await rig.uploader.add(file: rig.pdf('b.pdf', 12, seed: 5), ownerKind: 'report');
      await pumpEventQueue();
      expect(rig.uploader.upload(b.id)!.errorCode, 'INTERNAL_ERROR');
      expect(timers.active.single.delay, const Duration(seconds: 9));
      timers.active.single.run();
      await pumpEventQueue();
      expect(rig.uploader.upload(b.id)!.state, UploadState.clean);
      runner.dispose();
      runner.trigger();
    });
  });
}
