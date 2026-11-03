import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../../support/queue_rig.dart';
import 'offline_harness.dart';

void main() {
  group('REVIEW-m1-2 UI-MOB-41 a command whose result cannot be verified is never offered for sending again', () {
    testWidgets('an ordinary refusal can be sent again; an unverifiable one can only be dropped', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final QueueRig rig = await realClockRig(server: FakeSyncServer(decide: (Map<String, Object?> item) => const ServerOutcome.rejected('PERIOD_LOCKED')));
      final QueuedCommand refused = rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'n': 1}, baseServerVersion: 1);
      final QueuedCommand unverifiable = rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'n': 2}, baseServerVersion: 2);
      await rig.queue.flush();
      rig.store.commands.update(unverifiable.id, (QueuedCommand c) => c.copyWith(errorCode: 'RESULT_UNVERIFIABLE'));
      expect(rig.queue.command(refused.id)!.state, CommandState.rejected);
      expect(rig.queue.command(unverifiable.id)!.state, CommandState.rejected);

      await openOfflineApp(tester, rig, location: '/projects/mob-41');
      await tester.pumpAndSettle();
      expect(find.text('Gửi lại'), findsOneWidget, reason: 'only the ordinary refusal');
      expect(find.text('Bỏ'), findsNWidgets(2), reason: 'both can be dropped');
    });
  });
}
