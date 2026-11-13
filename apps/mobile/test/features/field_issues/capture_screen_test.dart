import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_store.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/field_issues/issue_draft.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'field_world.dart';

Future<FieldWorld> _open(WidgetTester tester, {ScriptedServer? api, String location = '/projects/mob-28', FakeSession? session, List<Override> overrides = const <Override>[]}) async {
  final FieldWorld world = FieldWorld.create(server: FieldServer(api: api ?? (ScriptedServer()..let(answerLookups))));
  await world.open(tester, location, session: session, overrides: overrides);
  await settleReal(tester, rounds: 6);
  return world;
}

extension on ScriptedServer {
  void let(void Function(ScriptedServer server) body) => body(this);
}

Future<void> _choose(WidgetTester tester, int dropdown, String option) async {
  await tester.tap(find.byType(DropdownButtonFormField<String>).at(dropdown));
  await tester.pumpAndSettle();
  await tester.tap(find.text(option).last);
  await tester.pumpAndSettle();
}

Future<void> _chip(WidgetTester tester, String label) async {
  await tester.tap(find.widgetWithText(InkWell, label));
  await tester.pumpAndSettle();
}

Future<void> _fillForm(WidgetTester tester) async {
  await _choose(tester, 0, 'PRJ-A-001 · Đường tỉnh ĐT.A1');
  await _choose(tester, 1, 'CDT-A-01 · Ban QLDA giao thông A');
  await _chip(tester, 'MAT_BANG · Mặt bằng');
  await _chip(tester, 'Cao');
  await tester.enterText(find.widgetWithText(TextField, 'Tiêu đề'), 'Sạt lở taluy km3');
  await tester.enterText(find.widgetWithText(TextField, 'Mô tả'), 'Đất đá đổ ra mặt đường, xe tải không qua được.');
  await settleReal(tester, rounds: 6);
}

Future<List<LocalDraft>> _drafts(WidgetTester tester, FieldWorld world) async {
  final DraftStore store = (await tester.runAsync(() => world.container.read(draftStoreProvider.future)))!;
  return store.list(kind: kIssueDraftKind);
}

void main() {
  group('AC-ST-MOB-014-5 UI-MOB-28 the capture form of an obstacle', () {
    testWidgets('offers the projects, the units and the categories of the server and keeps what is typed as a draft on the phone', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);

      await _fillForm(tester);

      final List<LocalDraft> drafts = await _drafts(tester, world);
      expect(drafts, hasLength(1), reason: 'typing does not need the Send button to keep the work');
      final IssueDraft draft = IssueDraft.fromJson(drafts.single.fields)!;
      expect(draft.projectId, 'p-1');
      expect(draft.ownerUnitId, 'u-1');
      expect(draft.categoryVersionId, 'c-1');
      expect(draft.severity, 'HIGH');
      expect(draft.title, 'Sạt lở taluy km3');
      expect(draft.description, 'Đất đá đổ ra mặt đường, xe tải không qua được.');
      expect(draft.clientOperationId, isNotEmpty, reason: 'the identity of the report exists from the first word');
      expect(world.server.api.callsTo('POST', '/issues'), isEmpty, reason: 'nothing is sent by typing');
    });

    testWidgets('does not go on to the check until the required fields are filled, and says which are missing', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);

      await tapText(tester, 'Xem lại và gửi');
      expect(find.text('Bắt buộc nhập.'), findsNWidgets(5), reason: 'project, unit, category, title and description');
      expect(find.text('Vị trí và kiểm tra'), findsNothing, reason: 'MOB-30 did not open');
      expect(await _drafts(tester, world), isEmpty, reason: 'a form nobody touched is not a draft');

      await _choose(tester, 0, 'PRJ-A-001 · Đường tỉnh ĐT.A1');
      expect(find.text('Bắt buộc nhập.'), findsNothing, reason: 'the errors go away at the next change');
    });

    testWidgets('a draft left half written is offered again and opens with what was written', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _fillForm(tester);

      world.container.read(routerProvider).go('/account/mob-41');
      await settleReal(tester, rounds: 6);
      world.container.read(routerProvider).go('/projects/mob-28');
      await settleReal(tester, rounds: 8);

      expect(find.text('Chưa hoàn tất trên máy này'), findsOneWidget);
      await tapText(tester, 'Sạt lở taluy km3');

      expect(find.widgetWithText(TextField, 'Sạt lở taluy km3'), findsOneWidget);
      expect(find.textContaining('Đất đá đổ ra mặt đường'), findsOneWidget);
    });

    testWidgets('works without a network from the copy of the lists kept on the phone, and says it is a copy', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      expect(find.text('Dự án'), findsWidgets);

      world.server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await settleReal(tester, rounds: 8);

      expect(find.text('Dự án'), findsWidgets, reason: 'the form stays');
      expect(find.textContaining('dữ liệu đã lưu trên máy'), findsWidgets);
      await _fillForm(tester);
      expect((await _drafts(tester, world)).single.fields['title'], 'Sạt lở taluy km3');
    });

    testWidgets('a read-only system lets the draft be written and says it cannot be sent yet', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(
        tester,
        session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)),
      );
      expect(find.text('Hệ thống đang ở chế độ chỉ đọc: có thể soạn nháp nhưng chưa gửi được.'), findsOneWidget);
    });

    testWidgets('lists the reports waiting for the network and opens one in MOB-31', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, overrides: idleRunners);
      final CommandQueue queue = (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;
      final String id = queue.enqueue(commandType: kIssueCreateCommand, payload: <String, Object?>{'title': 'Cọc tiêu bị gãy', 'client_operation_id': 'op-1'}).id;
      await settleReal(tester, rounds: 4);

      expect(find.text('Cọc tiêu bị gãy'), findsOneWidget);
      await tapText(tester, 'Cọc tiêu bị gãy');
      expect(currentLocation(world.container), '/projects/mob-31/$id');
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) async {
        await FieldWorld.create(server: FieldServer(api: server)).open(tester, '/projects/mob-28');
        await settleReal(tester, rounds: 4);
      }

      await expectEveryState(
        tester,
        open: open,
        script: StateScript(healthy: answerLookups, content: find.text('Thông tin vướng mắc'), empty: (ScriptedServer server) => answerLookups(server, empty: true)),
      );
      await expectScreenContract(tester, open: open, healthy: answerLookups);
    });
  });
}
