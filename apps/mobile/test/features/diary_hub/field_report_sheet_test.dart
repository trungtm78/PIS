import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/command_support/field_contract.dart';
import 'package:machvon_mobile/features/diary_hub/field_report_sheet.dart';
import 'package:machvon_mobile/features/diary_hub/hub_models.dart';
import 'package:machvon_mobile/features/diary_hub/hub_strings.dart';
import 'package:machvon_mobile/features/field_evidence/field_evidence_strings.dart';

import '../../support/harness.dart';
import '../../support/widget_host.dart';

LocalDiary _diary(String? contract) => LocalDiary(key: 'd', state: LocalState.queued, summary: 's', contractId: contract);

void main() {
  group('the contract the quick report starts from', () {
    test('the one worked on last wins, then the newest diary on the phone, then the only contract', () {
      expect(recentFieldContract(last: 'c9', diaries: <LocalDiary>[_diary('c1')], codes: const <String, String>{'c1': 'A'}), 'c9');
      expect(recentFieldContract(last: null, diaries: <LocalDiary>[_diary(null), _diary('c1')], codes: const <String, String>{'c2': 'B'}), 'c1');
      expect(recentFieldContract(last: null, diaries: const <LocalDiary>[], codes: const <String, String>{'c2': 'B'}), 'c2');
      expect(recentFieldContract(last: null, diaries: const <LocalDiary>[], codes: const <String, String>{'c2': 'B', 'c3': 'C'}), isNull);
    });

    test('another tenant or user starts with no contract: the one of the previous session is never offered', () {
      final FakeSession session = FakeSession();
      final ProviderContainer container = ProviderContainer(overrides: <Override>[sessionProvider.overrideWith(() => session)]);
      addTearDown(container.dispose);
      container.listen<String?>(lastFieldContractProvider, (String? previous, String? next) {});
      container.read(lastFieldContractProvider.notifier).remember('c1');
      expect(container.read(lastFieldContractProvider), 'c1');
      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-2'));
      expect(container.read(lastFieldContractProvider), isNull);
    });

    test('a screen of a contract remembers it, and an empty id is ignored', () {
      final ProviderContainer container = ProviderContainer();
      addTearDown(container.dispose);
      container.read(lastFieldContractProvider.notifier).remember('');
      expect(container.read(lastFieldContractProvider), isNull);
      container.read(lastFieldContractProvider.notifier).remember('c1');
      expect(container.read(lastFieldContractProvider), 'c1');
    });
  });

  group('the quick Report sheet: the kind of report in one tap', () {
    Future<List<(FieldReportKind, String?)>> open(WidgetTester tester, {String? last, double scale = 1.0}) async {
      final List<(FieldReportKind, String?)> chosen = <(FieldReportKind, String?)>[];
      useDevice(tester, const Size(390, 844), textScale: scale);
      await tester.pumpWidget(
        ProviderScope(
          overrides: <Override>[
            if (last != null) lastFieldContractProvider.overrideWith(() => _Remembered(last)),
          ],
          child: hostWidget(
            Scaffold(body: SingleChildScrollView(child: FieldReportSheet(onChosen: (FieldReportKind kind, String? contract) => chosen.add((kind, contract))))),
            tables: <StringTable>[fieldEvidenceStrings, diaryHubStrings],
          ),
        ),
      );
      await tester.pump();
      return chosen;
    }

    testWidgets('four kinds are there, and a tap on one hands back the kind with the contract worked on last', (WidgetTester tester) async {
      final List<(FieldReportKind, String?)> chosen = await open(tester, last: 'c1');
      for (final String title in <String>['Chụp ảnh công trình', 'Ghi nhận vướng mắc', 'Viết nhật ký công trường', 'Ghi khối lượng']) {
        expect(find.text(title), findsOneWidget);
      }
      await tester.tap(find.text('Ghi khối lượng'));
      await tester.pump();
      expect(chosen, <(FieldReportKind, String?)>[(FieldReportKind.quantity, 'c1')]);
    });

    testWidgets('no contract known: the sheet says to choose one in the next step and still hands back the kind', (WidgetTester tester) async {
      final List<(FieldReportKind, String?)> chosen = await open(tester);
      expect(find.text('Chọn hợp đồng'), findsOneWidget);
      await tester.tap(find.text('Ghi nhận vướng mắc'));
      await tester.pump();
      expect(chosen.single, (FieldReportKind.issue, null));
    });

    testWidgets('at 200 percent text nothing overflows', (WidgetTester tester) async {
      await open(tester, scale: 2.0);
      expect(tester.takeException(), isNull);
    });
  });
}

class _Remembered extends LastFieldContract {
  _Remembered(this._id);

  final String _id;

  @override
  String? build() => _id;
}
