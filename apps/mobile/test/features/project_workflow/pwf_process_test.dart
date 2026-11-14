import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_table.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/features/project_workflow/project_workflow_feature.dart' as pwf;
import 'package:machvon_mobile/features/project_workflow/pwf_models.dart';

import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'pwf_contract.dart';
import 'pwf_fixtures.dart';

/// PWF-4 on the phone: the steps of a phase with their progress, the checklist of each task, and the legal grounds of a step and of a task (read only).

String _at(String screenId, [String suffix = '']) => RouteTable(routes: kMobileRoutes, features: <MobileFeature>[pwf.feature]).locationOf(screenId) + suffix;

Map<String, Object?> basis(String code, {String kind = 'DECREE', String? number, String state = 'IN_FORCE', String? article, String? supersededBy, String verification = 'UNVERIFIED'}) => <String, Object?>{
      'document_code': code,
      'article': article,
      'note': null,
      'verification': verification,
      'doc_kind': kind,
      'number': number,
      'title': number == null ? null : 'Văn bản $number',
      'issuer': 'Chính phủ',
      'effective_from': '2025-04-08',
      'effective_to': null,
      'superseded_by': supersededBy,
      'document_verification': verification,
      'document_id': null,
      'url': null,
      'state': state,
    };

Map<String, Object?> step(String code, String name, String phase, int order, {String status = 'NOT_STARTED', int taskTotal = 1, int taskDone = 0, int checklistTotal = 0, int checklistDone = 0, int days = 10, List<Map<String, Object?>> legal = const <Map<String, Object?>>[]}) => <String, Object?>{
      'code': code,
      'name': name,
      'phase_code': phase,
      'order': order,
      'implicit': false,
      'responsible_role': 'PMB_MANAGER',
      'status': status,
      'standard_working_days': days,
      'planned_start': '2026-11-01',
      'planned_finish': '2026-11-20',
      'task_total': taskTotal,
      'task_done': taskDone,
      'required_total': taskTotal,
      'required_done': taskDone,
      'checklist_total': checklistTotal,
      'checklist_done': checklistDone,
      'legal_basis': legal,
    };

/// The workflow of the fixtures with its open phase (P2) in two steps: bidding (two tasks, one of them with a checklist) and contract (one milestone); one task of P2 belongs to no step.
Map<String, Object?> steppedWorkflow() {
  final Map<String, Object?> workflow = workflowJson();
  final List<Object?> tasks = <Object?>[
    for (final Object? raw in workflow['tasks']! as List<Object?>)
      <String, Object?>{
        ...raw! as Map<String, Object?>,
        ...switch ((raw as Map<String, Object?>)['id']) {
          '7f3a0000-0000-4000-8000-000000000011' => <String, Object?>{'step_code': 'S_BID', 'checklist_total': 2, 'checklist_done': 1},
          '7f3a0000-0000-4000-8000-000000000012' => <String, Object?>{'step_code': 'S_BID', 'checklist_total': 0, 'checklist_done': 0},
          '7f3a0000-0000-4000-8000-000000000013' => <String, Object?>{'step_code': 'S_CONTRACT', 'checklist_total': 0, 'checklist_done': 0},
          _ => <String, Object?>{'step_code': null, 'checklist_total': 0, 'checklist_done': 0},
        },
      },
  ];
  return <String, Object?>{
    ...workflow,
    'tasks': tasks,
    'standard_working_days': 330,
    'lapsed_legal_documents': <Object?>['DECREE_24_2024_ND_CP'],
    'steps': <Object?>[
      step('S_CONTRACT', 'Ký hợp đồng', 'P2', 2, days: 5),
      step('S_BID', 'Lựa chọn nhà thầu', 'P2', 1, status: 'IN_PROGRESS', taskTotal: 2, checklistTotal: 2, checklistDone: 1, days: 45, legal: <Map<String, Object?>>[
        basis('LAW_22_2023_QH15', kind: 'LAW', number: '22/2023/QH15', verification: 'VERIFIED', article: 'Điều 20'),
        basis('DECREE_24_2024_ND_CP', number: '24/2024/NĐ-CP', state: 'SUPERSEDED', supersededBy: 'DECREE_214_2025_ND_CP'),
      ]),
    ],
  };
}

Map<String, Object?> steppedTask() => <String, Object?>{
      ...taskDetailJson(TaskState()),
      'step': <String, Object?>{'code': 'S_BID', 'name': 'Lựa chọn nhà thầu', 'phase_code': 'P2', 'order': 1, 'implicit': false, 'responsible_role': 'PROCUREMENT_OFFICER'},
      'legal_basis': <Object?>[basis('DECREE_214_2025_ND_CP', number: '214/2025/NĐ-CP')],
      'step_legal_basis': <Object?>[basis('GONE_ONE', state: 'UNKNOWN')],
      'form_templates': <Object?>[
        <String, Object?>{'code': 'FORM_BID', 'satisfied': true, 'document_id': null, 'policy': 'LATEST_APPROVED', 'pinned_revision': null, 'current_revision': 3, 'current_title': 'Hồ sơ mời thầu', 'current_effective_from': '2026-11-01', 'used_revision': 2, 'used_sha256': 'ab', 'newer_available': true},
      ],
    };

void main() {
  group('the models: steps, legal grounds, form revisions', () {
    test('a workflow with steps is read with the steps of each phase in their order, the step and the checklist of every task', () {
      final PwfWorkflow workflow = (parsePwfWorkflowView(steppedWorkflow())! as PwfWorkflowPresent).workflow;
      expect(workflow.stepsOf('P2').map((PwfStep one) => one.code), <String>['S_BID', 'S_CONTRACT']);
      expect(workflow.stepsOf('P1'), isEmpty);
      final PwfStep bid = workflow.stepsOf('P2').first;
      expect((bid.status, bid.taskTotal, bid.checklistDone, bid.checklistTotal, bid.standardWorkingDays, bid.attention), (PwfStepStatus.inProgress, 2, 1, 2, 45, 1));
      expect(bid.legalBasis.map((PwfLegalBasis one) => (one.documentCode, one.state, one.verified, one.article)), <(String, PwfLegalState, bool, String?)>[
        ('LAW_22_2023_QH15', PwfLegalState.inForce, true, 'Điều 20'),
        ('DECREE_24_2024_ND_CP', PwfLegalState.superseded, false, null),
      ]);
      expect(workflow.tasksOfStep('P2', 'S_BID').map((PwfTaskRow task) => (task.code, task.checklistDone, task.checklistTotal)), <(String, int, int)>[('T-11', 1, 2), ('T-12', 0, 0)]);
      // The task of the phase that is in no step is kept apart, never dropped.
      expect(workflow.tasksOfStep('P2', null).map((PwfTaskRow task) => task.code), <String>['T-14']);
      expect(workflow.standardWorkingDays, 330);
      expect(workflow.lapsedLegalDocuments, <String>['DECREE_24_2024_ND_CP']);
    });

    test('an answer from before steps existed is read as it always was: no step, no legal ground, no checklist count', () {
      final PwfWorkflow workflow = (parsePwfWorkflowView(workflowJson())! as PwfWorkflowPresent).workflow;
      expect(workflow.steps, isEmpty);
      expect(workflow.lapsedLegalDocuments, isEmpty);
      expect(workflow.tasks.every((PwfTaskRow task) => task.stepCode == null && task.checklistTotal == 0), isTrue);
      final PwfTaskDetail detail = parsePwfTaskDetail(taskDetailJson(TaskState()))!;
      expect(detail.step, isNull);
      expect(detail.legalBasis, isEmpty);
      expect(detail.stepLegalBasis, isEmpty);
      expect(detail.formRevisions, isEmpty);
    });

    test('a state the phone does not know is never read as in force, and a ground without a document code is left out', () {
      expect(PwfLegalState.parse('SOMETHING_NEW'), PwfLegalState.unknown);
      expect(PwfLegalState.unknown.needsAttention, isTrue);
      expect(PwfLegalState.expired.isLapsed && PwfLegalState.superseded.isLapsed && !PwfLegalState.inForce.isLapsed, isTrue);
      expect(parsePwfLegalBasisList(<Object?>[<String, Object?>{'state': 'IN_FORCE'}, basis('LAW_X')]).map((PwfLegalBasis one) => one.documentCode), <String>['LAW_X']);
    });

    test('the detail of a task carries its step, the grounds of both and the revision of its forms', () {
      final PwfTaskDetail detail = parsePwfTaskDetail(steppedTask())!;
      expect((detail.step?.code, detail.step?.order, detail.step?.responsibleRole), ('S_BID', 1, 'PROCUREMENT_OFFICER'));
      expect(detail.legalBasis.single.number, '214/2025/NĐ-CP');
      expect(detail.stepLegalBasis.single.state, PwfLegalState.unknown);
      final PwfFormRevision form = detail.formRevisions.single;
      expect((form.code, form.pinned, form.currentRevision, form.usedRevision, form.newerAvailable, form.title), ('FORM_BID', false, 3, 2, true, 'Hồ sơ mời thầu'));
    });
  });

  group('MOB-78 the steps of the open phase', () {
    ScriptedServer server() => ScriptedServer()..on('GET', '/projects/:id/workflow', (_) => steppedWorkflow());
    Future<void> open(WidgetTester tester, {Locale locale = const Locale('vi')}) => pumpWithServer(tester, features: <MobileFeature>[pwf.feature], server: server(), location: _at('MOB-78', '/$kProjectId'), locale: locale);

    testWidgets('the tasks of the open phase are under their steps, each step with where it stands, its tasks, its checklist and its standard time', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await open(tester);
      // A document the procedure cites that lapsed is said above the tabs, on every one of them.
      expect(find.textContaining('1 văn bản pháp lý mà quy trình viện dẫn đã hết hiệu lực'), findsOneWidget);
      await tester.tap(find.textContaining('Công việc').first);
      await tester.pumpAndSettle();
      expect(find.text('Bước 1. Lựa chọn nhà thầu'), findsOneWidget);
      // The legal grounds of a step are a fact on its line (the row opens them), not an end column that squeezed the line.
      expect(find.text('Đang thực hiện · Việc 0/2 · Mục kiểm 1/2 · Chuẩn 45 ngày làm việc · 2 căn cứ pháp lý, 1 cần xem lại'), findsOneWidget);
      expect(find.text('Bước 2. Ký hợp đồng'), findsOneWidget);
      expect(find.text('Chưa bắt đầu · Việc 0/1 · Chuẩn 5 ngày làm việc'), findsOneWidget);
      // The checklist of the task itself is on its row.
      expect(find.textContaining('Mục kiểm 1/2'), findsNWidgets(2));
      expect(find.text('Việc riêng của dự án'), findsOneWidget);
      expect(find.text('Nghiệm thu giai đoạn 1'), findsOneWidget);
      // The step comes before the tasks of the next one.
      expect(tester.getTopLeft(find.text('Bước 1. Lựa chọn nhà thầu')).dy, lessThan(tester.getTopLeft(find.text('Lập hồ sơ mời thầu gói thầu xây lắp')).dy));
      expect(tester.getTopLeft(find.text('Lập hồ sơ mời thầu gói thầu xây lắp')).dy, lessThan(tester.getTopLeft(find.text('Bước 2. Ký hợp đồng')).dy));
    });

    testWidgets('tapping a step opens its legal grounds: the document, the article or that none is cited yet, the state in words and what replaced it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await open(tester);
      await tester.tap(find.textContaining('Công việc').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Bước 1. Lựa chọn nhà thầu'));
      await tester.pumpAndSettle();
      expect(find.text('Căn cứ pháp lý: Lựa chọn nhà thầu'), findsOneWidget);
      expect(find.text('Luật 22/2023/QH15'), findsOneWidget);
      // The state of a document is the first of its facts, in words.
      expect(find.textContaining('Còn hiệu lực · '), findsOneWidget);
      expect(find.textContaining('Điều 20'), findsOneWidget);
      expect(find.text('Nghị định 24/2024/NĐ-CP'), findsOneWidget);
      expect(find.textContaining('Đã bị thay thế · '), findsOneWidget);
      expect(find.textContaining('Thay bằng DECREE_214_2025_ND_CP'), findsOneWidget);
      expect(find.textContaining('Chưa ghi điều khoản, chờ pháp chế xác nhận'), findsOneWidget);
      expect(find.textContaining('Chưa kiểm chứng'), findsOneWidget);
    });

    testWidgets('a colour filter keeps the flat list of the tasks that match', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await open(tester);
      await tester.tap(find.textContaining('Công việc').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Quá hạn').last);
      await tester.pumpAndSettle();
      expect(find.text('Lập hồ sơ mời thầu gói thầu xây lắp'), findsOneWidget);
      expect(find.text('Bước 1. Lựa chọn nhà thầu'), findsNothing);
    });

    testWidgets('in English the steps read in English', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await open(tester, locale: const Locale('en'));
      await tester.tap(find.textContaining('Tasks').first);
      await tester.pumpAndSettle();
      expect(find.text('Step 1. Lựa chọn nhà thầu'), findsOneWidget);
      expect(find.textContaining('In progress · Tasks 0/2 · Checklist 1/2 · Standard 45 working days'), findsOneWidget);
    });

    testWidgets('the three devices and 200 percent text, with the steps on the screen', (WidgetTester tester) async {
      await expectScreenContractWithData(
        tester,
        open: (WidgetTester t, ScriptedServer scripted) => pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: scripted, location: _at('MOB-78', '/$kProjectId')),
        healthy: (ScriptedServer scripted) => scripted.on('GET', '/projects/:id/workflow', (_) => steppedWorkflow()),
      );
    });
  });

  group('MOB-79 the place of a task in the procedure', () {
    Future<void> open(WidgetTester tester) => pumpWithServer(
          tester,
          features: <MobileFeature>[pwf.feature],
          server: ScriptedServer()..on('GET', '/project-tasks/:id', (_) => steppedTask()),
          location: _at('MOB-79', '/$kTaskId'),
          overrides: <Override>[offlineStorageProvider.overrideWithValue(TestStorage.create().storage)],
        );

    testWidgets('the step of the task, its checklist, the legal grounds of the task and of its step, and a form that was revised since', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await open(tester);
      // The screen is in tabs. "Thông tin": the step of the task and the role that answers for it, by name.
      await tester.tap(find.textContaining('Thông tin'));
      await tester.pump();
      expect(find.text('Bước 1. Lựa chọn nhà thầu'), findsOneWidget);
      expect(find.text('Cán bộ đấu thầu'), findsOneWidget);
      // "Cần làm": the checklist of the task, item by item, and the revision of its forms.
      await tester.tap(find.textContaining('Cần làm'));
      await tester.pump();
      await tester.scrollUntilVisible(find.text('Dự thảo hồ sơ mời thầu'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('Biên bản họp tổ chuyên gia'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Phiên bản biểu mẫu'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('Hồ sơ mời thầu'), findsOneWidget);
      // A form revised since is said first on the line of the form.
      expect(find.text('Có bản mới · Dùng bản đã duyệt mới nhất · Đang hiệu lực: bản 3 · Đã dùng: bản 2'), findsOneWidget);
      // "Căn cứ": the legal grounds of the task and of its step.
      await tester.scrollUntilVisible(find.textContaining('Căn cứ'), -200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.textContaining('Căn cứ').first);
      await tester.pump();
      await tester.scrollUntilVisible(find.text('Căn cứ pháp lý của công việc'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('Nghị định 214/2025/NĐ-CP'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Căn cứ pháp lý của bước'), 200, scrollable: find.byType(Scrollable).first);
      // A document the catalogue no longer has is named by its code and said to be missing, never shown as in force.
      expect(find.text('GONE_ONE'), findsOneWidget);
      expect(find.textContaining('Không có trong danh mục · '), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(Duration.zero);
    });

    testWidgets('people and documents are named, the forecast stands beside the deadline, the log is in words, and the facts are in groups with a heading each', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Map<String, Object?> task = steppedTask()
        ..['forecast_finish'] = '2026-11-20'
        ..['evidence'] = <Object?>[
          <String, Object?>{'id': 'e1', 'item_code': null, 'evidence_kind': 'DOCUMENT', 'document_id': 'd1', 'legal_doc_type': null, 'form_template_code': null, 'external_ref': null, 'note': null, 'attached_by': '5f0c1c5e-0000-4000-8000-000000000001', 'attached_by_name': 'Nguyễn Văn An', 'attached_at': kAsOf, 'document_title': 'Tờ trình chủ trương đầu tư', 'document_symbol': '12/TTr-BQL'},
        ]
        ..['history'] = <Object?>[
          <String, Object?>{'id': 'h1', 'kind': 'EVIDENCE_ATTACHED', 'at': kAsOf, 'actor': '5f0c1c5e-0000-4000-8000-000000000001', 'actor_name': 'Nguyễn Văn An', 'reason': null},
          <String, Object?>{'id': 'h2', 'kind': 'SOMETHING_NEW', 'at': kAsOf, 'actor': null, 'actor_name': null, 'reason': null},
        ];
      await pumpWithServer(
        tester,
        features: <MobileFeature>[pwf.feature],
        server: ScriptedServer()..on('GET', '/project-tasks/:id', (_) => task),
        location: _at('MOB-79', '/$kTaskId'),
        overrides: <Override>[offlineStorageProvider.overrideWithValue(TestStorage.create().storage)],
      );
      // The head: the step of the task instead of its code, and the forecast beside the official deadline.
      expect(find.text('Dự báo xong 20/11'), findsOneWidget);
      expect(find.textContaining('Bước 1. Lựa chọn nhà thầu'), findsOneWidget);
      // The evidence is named by the title of its document and by the person who gave it, never by an id.
      await tester.scrollUntilVisible(find.text('Tờ trình chủ trương đầu tư'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.textContaining('12/TTr-BQL · Nguyễn Văn An'), findsOneWidget);
      expect(find.textContaining('5f0c1c5e'), findsNothing);
      // The facts are three groups with a heading each; the code of the task is one of them.
      await tester.scrollUntilVisible(find.textContaining('Thông tin'), -200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.textContaining('Thông tin').first);
      await tester.pump();
      expect(find.text('Phân công'), findsOneWidget);
      expect(find.text('Thời hạn'), findsOneWidget);
      expect(find.text('Vị trí trong quy trình'), findsOneWidget);
      expect(find.text('Dự báo xong'), findsOneWidget);
      // The log says what happened in words and who did it; a kind it has no word for is "Cập nhật", never the code.
      await tester.scrollUntilVisible(find.textContaining('Diễn biến'), -200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.textContaining('Diễn biến').first);
      await tester.pump();
      expect(find.text('Nộp chứng từ'), findsOneWidget);
      expect(find.text('Nguyễn Văn An'), findsOneWidget);
      expect(find.text('Cập nhật'), findsOneWidget);
      expect(find.textContaining('SOMETHING_NEW'), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(Duration.zero);
    });

    testWidgets('the three devices and 200 percent text, with the grounds on the screen', (WidgetTester tester) async {
      await expectScreenContractWithData(
        tester,
        open: (WidgetTester t, ScriptedServer scripted) => pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: scripted, location: _at('MOB-79', '/$kTaskId'), overrides: <Override>[offlineStorageProvider.overrideWithValue(TestStorage.create().storage)]),
        healthy: (ScriptedServer scripted) => scripted.on('GET', '/project-tasks/:id', (_) => steppedTask()),
      );
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(Duration.zero);
    });
  });
}
