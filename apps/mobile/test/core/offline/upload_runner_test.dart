import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/attachments/upload_runner.dart';
import 'package:machvon_mobile/core/offline/offline_probe_policy.dart';

import '../../support/fake_attachment_server.dart';
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
    test('it uploads what waits when started and when the network is back, and the connectivity change resumes at once', () async {
      final UploaderRig rig = await UploaderRig.create();
      final _Timers timers = _Timers();
      final UploadRunner runner = UploadRunner(rig.uploader, timer: timers.make);
      final AttachmentUpload a = await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');
      rig.server.offline = true;
      runner.start();
      await runner.idle;
      expect(rig.uploader.upload(a.id)!.errorCode, 'NETWORK_ERROR');
      rig.server.offline = false;
      runner.trigger();
      await runner.idle;
      expect(rig.uploader.upload(a.id)!.state, UploadState.clean);
      expect(timers.active, isEmpty);
      runner.dispose();
    });

    test('a lost connection is probed again on its own, so a phone that stays on an idle screen recovers without any other request', () async {
      final UploaderRig rig = await UploaderRig.create();
      final _Timers timers = _Timers();
      final UploadRunner runner = UploadRunner(
        rig.uploader,
        timer: timers.make,
        offlineProbes: OfflineProbePolicy.standard.delays,
        maxOfflineProbes: OfflineProbePolicy.standard.maxProbes,
      );
      final AttachmentUpload a = await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');
      rig.server.offline = true;
      runner.start();
      await runner.idle;
      expect(rig.uploader.upload(a.id)!.errorCode, 'NETWORK_ERROR');
      expect(timers.active.single.delay, const Duration(seconds: 15));

      timers.active.single.run();
      await runner.idle;
      expect(rig.uploader.upload(a.id)!.errorCode, 'NETWORK_ERROR');
      expect(timers.active.single.delay, const Duration(seconds: 30), reason: 'a probe that finds it still lost waits longer');

      rig.server.offline = false;
      timers.active.single.run();
      await runner.idle;
      expect(rig.uploader.upload(a.id)!.state, UploadState.clean);
      expect(timers.active, isEmpty, reason: 'recovered: no further probe');
      runner.dispose();
    });

    test('the probes are bounded: the wait grows to a ceiling, they stop after the limit, and a trigger from outside starts the count over', () async {
      final UploaderRig rig = await UploaderRig.create();
      final _Timers timers = _Timers();
      final UploadRunner runner = UploadRunner(
        rig.uploader,
        timer: timers.make,
        offlineProbes: const <Duration>[Duration(seconds: 10), Duration(seconds: 20)],
        maxOfflineProbes: 4,
      );
      await rig.uploader.add(file: rig.pdf('a.pdf', 12), ownerKind: 'report');
      rig.server.offline = true;
      runner.start();
      await runner.idle;
      final List<Duration> delays = <Duration>[timers.active.single.delay];
      for (int i = 0; i < 3; i++) {
        timers.active.single.run();
        await runner.idle;
        delays.add(timers.active.single.delay);
      }
      expect(delays, const <Duration>[Duration(seconds: 10), Duration(seconds: 20), Duration(seconds: 20), Duration(seconds: 20)]);
      timers.active.single.run();
      await runner.idle;
      expect(timers.active, isEmpty, reason: 'after the limit the phone stops waking itself');

      runner.trigger();
      await runner.idle;
      expect(timers.active.single.delay, const Duration(seconds: 10), reason: 'the count started over');
      runner.dispose();
    });

    test('AC-ST-MOB-040-3 SYNC-01 a file added while the runner is already running goes up at once, without a network change or a trigger', () async {
      final UploaderRig rig = await UploaderRig.create();
      final UploadRunner runner = UploadRunner(rig.uploader, timer: _Timers().make);
      runner.start();
      await runner.idle;
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('late.pdf', 12), ownerKind: 'report');
      await pumpEventQueue(); // the arrival reaches the runner
      await runner.idle;
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
      await runner.idle;
      expect(rig.uploader.upload(a.id)!.state, UploadState.clean, reason: 'the trigger during the run made one more run, which finished it');
      expect(timers.active, isEmpty);

      rig.server.failNext = (status: 503, code: 'INTERNAL_ERROR');
      final AttachmentUpload b = await rig.uploader.add(file: rig.pdf('b.pdf', 12, seed: 5), ownerKind: 'report');
      await pumpEventQueue(); // the arrival reaches the runner
      await runner.idle;
      expect(rig.uploader.upload(b.id)!.errorCode, 'INTERNAL_ERROR');
      expect(timers.active.single.delay, const Duration(seconds: 9));
      timers.active.single.run();
      await runner.idle;
      expect(rig.uploader.upload(b.id)!.state, UploadState.clean);
      runner.dispose();
      runner.trigger();
    });

    test('REVIEW-m1-3 a file the scanner has not finished with is asked about again after the wait, until it is clean', () async {
      final FakeAttachmentServer server = FakeAttachmentServer()..scanPending = true;
      final UploaderRig rig = await UploaderRig.create(server: server);
      final _Timers timers = _Timers();
      final UploadRunner runner = UploadRunner(rig.uploader, timer: timers.make, retryAfter: const Duration(seconds: 11));
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('slow.pdf', 12), ownerKind: 'report');
      runner.start();
      await runner.idle;
      expect(rig.uploader.upload(added.id)!.state, UploadState.scanning);
      expect(timers.active.single.delay, const Duration(seconds: 11), reason: 'nothing else would ask the server for the verdict');

      timers.active.single.run();
      await runner.idle;
      expect(rig.uploader.upload(added.id)!.state, UploadState.scanning, reason: 'still being scanned');
      expect(timers.active.single.delay, const Duration(seconds: 11), reason: 'asked again later');

      server.finishScan(server.uploadIds.single);
      timers.active.single.run();
      await runner.idle;
      expect(rig.uploader.upload(added.id)!.state, UploadState.clean);
      expect(rig.uploader.linkableId(added.id), server.uploadIds.single);
      expect(timers.active, isEmpty, reason: 'a settled upload needs no more questions');
      runner.dispose();
    });

    test('REVIEW-m1-3 a scanning file on a phone without a network is not asked about at the pace of the scan: the connection is probed instead', () async {
      final FakeAttachmentServer server = FakeAttachmentServer()..scanPending = true;
      final UploaderRig rig = await UploaderRig.create(server: server);
      final _Timers timers = _Timers();
      final UploadRunner runner = UploadRunner(
        rig.uploader,
        timer: timers.make,
        offlineProbes: OfflineProbePolicy.standard.delays,
        maxOfflineProbes: OfflineProbePolicy.standard.maxProbes,
      );
      final AttachmentUpload added = await rig.uploader.add(file: rig.pdf('slow.pdf', 12), ownerKind: 'report');
      runner.start();
      await runner.idle;
      server.offline = true;
      timers.active.single.run();
      await runner.idle;
      expect(rig.uploader.upload(added.id)!.errorCode, 'NETWORK_ERROR');
      expect(timers.active.single.delay, const Duration(seconds: 15), reason: 'the probe of the lost connection, not the verdict wait');
      runner.dispose();
    });
  });
}
