import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/app_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/theme/machvon_semantic.dart';
import 'package:machvon_mobile/core/theme/typography.dart';
import 'package:machvon_mobile/core/widgets/action_bar.dart';
import 'package:machvon_mobile/core/widgets/app_scaffold.dart';
import 'package:machvon_mobile/features/command_support/field_widgets.dart';
import 'package:machvon_mobile/features/field_evidence/field_evidence_strings.dart';
import 'package:machvon_mobile/features/reporting/data/submit_flow.dart';
import 'package:machvon_mobile/features/reporting/model/report_review.dart';
import 'package:machvon_mobile/features/reporting/reporting_strings.dart';
import 'package:machvon_mobile/features/reporting/screens/drafts_screen.dart';
import 'package:machvon_mobile/features/reporting/screens/review_screen.dart';
import 'package:machvon_mobile/features/reporting/widgets/draft_host.dart';
import 'package:machvon_mobile/features/reporting/widgets/notices.dart';

import '../features/reporting/reporting_fixtures.dart';
import '../support/v2_support.dart';

/// Golden images of the weekly report screens in the phone design (MUX-3 wave C): the review and send screen (MOB-20) and the list of drafts
/// (MOB-22), in the light mode, the dark mode, at 200 percent text, with nothing in the list, and offline. The screens are hosted from their pure view
/// widgets (`ReviewList`, `SendOutcomePanel`, `DraftsList`, `DraftsEmpty`, with the real sticky bar and the real frame), because the screens themselves
/// open the encrypted store of the device, which a golden cannot. The pixels are compared with the goldens of the OS the test runs on (useOsGoldens); layout, sizes and tap
/// targets are proved by the widget tests next to them.
const List<StringTable> _tables = <StringTable>[reportingStrings, fieldEvidenceStrings];

QueuedCommand _command(CommandState state, {String? code}) => QueuedCommand(
      id: 'c1',
      tenantId: 't',
      userId: 'u',
      commandType: kSubmitCommand,
      payload: null,
      payloadBytes: 0,
      baseServerVersion: 1,
      idempotencyKey: 'key-1',
      state: state,
      createdAt: 0,
      updatedAt: 0,
      errorCode: code,
    );

const DraftContext _context = DraftContext(
  line: 'Dự án DA-2026-002 · Kỳ W2026-45',
  name: 'Đường vành đai 3',
  step: 'Bước 8/8',
  saved: 'Đã lưu nháp trên máy lúc 03/11/2026 10:20 · mã nháp 1a2b3c4d',
);

/// The review as the screen draws it: the frame, the context, the one strip, the list and the sticky bar. [blocked] leaves errors in the report.
Widget _review({required bool blocked, bool offline = false, SubmitStatus status = const SubmitStatus(SubmitStage.idle)}) {
  final List<Finding> findings = reviewForm(
    completeForm().copyWith(preparing: blocked ? '' : '300000000', construction: '2000000000', results: 'Hoàn thành 60% khối lượng móng cầu, đã nghiệm thu đợt 1.', causes: 'Mưa kéo dài làm chậm thi công.'),
    withReference(previous: const <String, String>{'CURRENT_YEAR:CENTRAL': '130000000', 'CURRENT_YEAR:LOCAL': '150000000'}),
  );
  return Builder(
    builder: (BuildContext context) {
      final bool large = largeText(context);
      final bool locked = blocked || status.isPending;
      return AppScaffold(
        title: context.t('mob.rep.review.title'),
        contextLine: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[if (!large) _context, DraftBanners(offline: offline, readOnlySession: false)],
        ),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Expanded(
              child: ReviewList(
                form: completeForm().copyWith(results: 'Hoàn thành 60% khối lượng móng cầu, đã nghiệm thu đợt 1.', causes: 'Mưa kéo dài làm chậm thi công.'),
                reportContext: withReference(previous: const <String, String>{'CURRENT_YEAR:CENTRAL': '130000000', 'CURRENT_YEAR:LOCAL': '150000000'}),
                errors: <Finding>[for (final Finding f in findings) if (f.isError) f],
                warnings: <Finding>[for (final Finding f in findings) if (!f.isError) f],
                files: const ReviewFiles(total: 2, clean: 1, waiting: 1, failed: 0),
                outcome: <Widget>[
                  if (large) _context,
                  SendOutcomePanel(status: status, busy: false, onCheck: () {}, onQueue: () {}, onCompare: () {}),
                ],
                onFix: (_) {},
                onManageFiles: () {},
              ),
            ),
            FieldSendBar(
              label: context.t('mob.rep.review.submit.action'),
              onSend: locked ? null : () {},
              offline: offline,
              why: blocked ? context.t('mob.rep.review.blocked.body') : null,
              secondary: ActionBarButton(label: context.t('mob.rep.step.back.action'), onPressed: () {}),
            ),
          ],
        ),
      );
    },
  );
}

/// What the outcome panel says in each state of the sending.
Widget _outcomes() => SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          for (final SubmitStatus status in <SubmitStatus>[
            SubmitStatus(SubmitStage.queued, _command(CommandState.queued)),
            SubmitStatus(SubmitStage.unknown, _command(CommandState.unknown)),
            SubmitStatus(SubmitStage.rejected, _command(CommandState.rejected, code: 'PERIOD_LOCKED')),
            SubmitStatus(SubmitStage.conflict, _command(CommandState.conflict, code: 'VERSION_CONFLICT')),
          ])
            SendOutcomePanel(status: status, busy: false, onCheck: () {}, onQueue: () {}, onCompare: () {}),
        ],
      ),
    );

List<DraftEntry> _entries() => <DraftEntry>[
      DraftEntry(
        id: 'a',
        title: 'Dự án DA-2026-002 · Kỳ W2026-45',
        projectName: 'Đường vành đai 3',
        standing: 'Đang soạn',
        tone: MachvonTone.neutral,
        saved: 'Lưu lúc 03/11/2026 10:20 · mã nháp 1a2b3c4d',
        total: '420 triệu đồng',
        pending: false,
        onOpen: () {},
        onDiscard: () {},
      ),
      DraftEntry(
        id: 'b',
        title: 'Dự án DA-2026-007 · Kỳ W2026-45',
        projectName: 'Cầu Thủ Thiêm 4',
        standing: 'Chờ gửi',
        tone: MachvonTone.info,
        saved: 'Lưu lúc 02/11/2026 16:05 · mã nháp 5e6f7a8b',
        total: '1,2 tỷ đồng',
        pending: true,
        onOpen: () {},
      ),
      DraftEntry(
        id: 'c',
        title: 'Dự án DA-2026-011 · Kỳ W2026-44',
        projectName: 'Trạm bơm Tân Hưng',
        standing: 'Cần xử lý',
        tone: MachvonTone.danger,
        saved: 'Lưu lúc 27/10/2026 09:12 · mã nháp 9c0d1e2f',
        total: '85 triệu đồng',
        pending: false,
        onOpen: () {},
        onDiscard: () {},
      ),
    ];

/// The list of drafts as the screen draws it: the frame, the strip when offline, the rows and the sticky bar that starts a report.
Widget _drafts({bool offline = false}) => Builder(
      builder: (BuildContext context) => AppScaffold(
        title: context.t('mob.rep.drafts.title'),
        contextLine: DraftBanners(offline: offline, readOnlySession: false),
        body: DraftsList(entries: _entries()),
        bottomBar: ActionBar(primary: ActionBarButton(label: context.t('mob.rep.drafts.new.action'), icon: Icons.add, onPressed: () {})),
      ),
    );

Widget _draftsEmpty() => Builder(
      builder: (BuildContext context) => AppScaffold(
        title: context.t('mob.rep.drafts.title'),
        body: DraftsEmpty(canStart: true, onStart: () {}),
      ),
    );

void main() {
  useOsGoldens('test/golden/reporting_golden_test.dart');

  final Map<String, Widget Function()> screens = <String, Widget Function()>{
    'review_blocked': () => _review(blocked: true),
    'drafts_list': _drafts,
    'review_outcomes': _outcomes,
  };

  for (final MapEntry<String, Widget Function()> screen in screens.entries) {
    testWidgets('golden ${screen.key} in the light mode', (WidgetTester tester) async {
      await pumpV2(tester, screen.value(), tables: _tables);
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/reporting_${screen.key}_light.png'));
    });

    testWidgets('golden ${screen.key} in the dark mode', (WidgetTester tester) async {
      await pumpV2(tester, screen.value(), brightness: Brightness.dark, tables: _tables);
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/reporting_${screen.key}_dark.png'));
    });

    testWidgets('golden ${screen.key} at 200 percent text', (WidgetTester tester) async {
      await pumpV2(tester, screen.value(), scale: 2.0, size: const Size(360, 800), tables: _tables);
      expect(tester.takeException(), isNull, reason: '${screen.key} must not overflow at 200 percent');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/reporting_${screen.key}_text200.png'));
    });
  }

  testWidgets('golden of the review offline: one strip, the report waiting in the queue, the bar locked and saying it saves for the network', (WidgetTester tester) async {
    await pumpV2(tester, _review(blocked: false, offline: true, status: SubmitStatus(SubmitStage.queued, _command(CommandState.queued))), tables: _tables);
    expect(tester.takeException(), isNull);
    expect(find.text('Lưu, gửi khi có mạng'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/reporting_review_offline_light.png'));
  });

  testWidgets('golden of the list of drafts offline: the one strip, the rows stay, a draft is still started', (WidgetTester tester) async {
    await pumpV2(tester, _drafts(offline: true), tables: _tables);
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/reporting_drafts_offline_light.png'));
  });

  testWidgets('golden of the empty list of drafts in the light and the dark mode', (WidgetTester tester) async {
    for (final Brightness brightness in Brightness.values) {
      await pumpV2(tester, _draftsEmpty(), brightness: brightness, tables: _tables);
      expect(tester.takeException(), isNull);
      expect(find.text('Bắt đầu báo cáo'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/reporting_drafts_empty_${brightness.name}.png'));
    }
  });
}
