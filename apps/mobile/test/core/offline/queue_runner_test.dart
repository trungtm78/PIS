import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queue_runner.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';

import '../../support/fake_sync_server.dart';
import '../../support/queue_rig.dart';

/// Timers that fire when a test says so.
class FakeTimers {
  final List<({Duration delay, void Function() run, FakeTimer timer})> scheduled = <({Duration delay, void Function() run, FakeTimer timer})>[];

  Timer make(Duration delay, void Function() callback) {
    final FakeTimer timer = FakeTimer();
    scheduled.add((delay: delay, run: callback, timer: timer));
    return timer;
  }

  List<({Duration delay, void Function() run, FakeTimer timer})> get active => scheduled.where((e) => !e.timer.cancelled).toList();
}

class FakeTimer implements Timer {
  bool cancelled = false;

  @override
  void cancel() => cancelled = true;

  @override
  bool get isActive => !cancelled;

  @override
  int get tick => 0;
}

void main() {
  group('TK-MOB-005-4 the runner keeps the queue moving', () {
    test('it sends what is queued when started and what is made afterwards, without waiting for a connectivity change', () async {
      final QueueRig rig = await QueueRig.create();
      final FakeTimers timers = FakeTimers();
      final QueueRunner runner = QueueRunner(rig.queue, timer: timers.make, clock: rig.clock.call);
      final QueuedCommand early = rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});
      runner.start();
      await pumpEventQueue();
      expect(rig.queue.command(early.id)!.state, CommandState.accepted);
      final QueuedCommand later = rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 2});
      await pumpEventQueue();
      expect(rig.queue.command(later.id)!.state, CommandState.accepted);
      expect(runner.lastResult!.accepted, 1);
      expect(timers.active, isEmpty, reason: 'nothing waits, so nothing is scheduled');
      runner.dispose();
    });

    test('a command that comes back with a wait is sent again when the wait ends', () async {
      final QueueRig rig = await QueueRig.create(server: FakeSyncServer(decide: (Map<String, Object?> item) => const ServerOutcome.transient()));
      final FakeTimers timers = FakeTimers();
      final QueueRunner runner = QueueRunner(rig.queue, timer: timers.make, clock: rig.clock.call);
      final QueuedCommand command = rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{});
      runner.start();
      await pumpEventQueue();
      expect(rig.queue.command(command.id)!.state, CommandState.queued);
      expect(timers.active.single.delay, const Duration(seconds: 2));
      rig.server.decide = (Map<String, Object?> item) => const ServerOutcome.accepted();
      rig.clock.advance(const Duration(seconds: 2));
      timers.active.single.run();
      await pumpEventQueue();
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      runner.dispose();
    });

    test('a phone without a network does not wake itself: the connectivity change is what sends', () async {
      final QueueRig rig = await QueueRig.create();
      final FakeTimers timers = FakeTimers();
      final QueueRunner runner = QueueRunner(rig.queue, timer: timers.make, clock: rig.clock.call);
      rig.server.offline = true;
      final QueuedCommand command = rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{});
      runner.start();
      await pumpEventQueue();
      expect(runner.lastResult!.blocker, FlushBlocker.offline);
      expect(rig.queue.command(command.id)!.state, CommandState.unknown);
      expect(timers.active, isEmpty);
      rig.server.offline = false;
      runner.trigger();
      await pumpEventQueue();
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      expect(rig.server.effectsOf(rig.queue.command(command.id)!.idempotencyKey), 1);
      runner.dispose();
    });

    test('a trigger during a flush runs one more flush; a refused device or a lapsed session schedules nothing', () async {
      final QueueRig rig = await QueueRig.create();
      final FakeTimers timers = FakeTimers();
      final QueueRunner runner = QueueRunner(rig.queue, timer: timers.make, clock: rig.clock.call);
      rig.server.failNext = (status: 403, code: 'SCOPE_DENIED');
      rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{});
      runner.start();
      runner.trigger();
      runner.trigger();
      await pumpEventQueue();
      expect(runner.lastResult!.blocker, isNull, reason: 'the second flush went through');
      expect(rig.server.batchPosts, 2);
      rig.server.failNext = (status: 401, code: 'SESSION_EXPIRED');
      rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 2});
      await pumpEventQueue();
      expect(runner.lastResult!.blocker, FlushBlocker.sessionExpired);
      expect(timers.active, isEmpty);
      runner.dispose();
    });

    test('a failure of the server, or of the flush itself, is kept in the runner and tried again later', () async {
      final QueueRig rig = await QueueRig.create();
      final FakeTimers timers = FakeTimers();
      final QueueRunner runner = QueueRunner(rig.queue, timer: timers.make, clock: rig.clock.call, errorRetry: const Duration(seconds: 7));
      final QueuedCommand command = rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{});
      rig.server.failNext = (status: 500, code: 'INTERNAL_ERROR');
      runner.start();
      await pumpEventQueue();
      expect(runner.lastResult!.blocker, FlushBlocker.serverError);
      expect(timers.active.single.delay, const Duration(seconds: 7));
      timers.active.single.run();
      await pumpEventQueue();
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);

      final QueueRig broken = await QueueRig.create();
      final FakeTimers other = FakeTimers();
      final QueueRunner failing = QueueRunner(broken.queue, timer: other.make, clock: broken.clock.call, errorRetry: const Duration(seconds: 9));
      broken.store.close();
      failing.start();
      await pumpEventQueue();
      expect(failing.lastError, isNotNull);
      expect(other.active.single.delay, const Duration(seconds: 9));
      runner.dispose();
      failing.dispose();
    });

    test('after dispose nothing is scheduled or sent', () async {
      final QueueRig rig = await QueueRig.create();
      final FakeTimers timers = FakeTimers();
      final QueueRunner runner = QueueRunner(rig.queue, timer: timers.make, clock: rig.clock.call);
      runner.start();
      await pumpEventQueue();
      runner.dispose();
      rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{});
      runner.trigger();
      await pumpEventQueue();
      expect(rig.server.batchPosts, 0);
    });
  });
}
