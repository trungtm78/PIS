import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/core_strings.dart';
import 'package:machvon_mobile/core/widgets/figure_info.dart';
import 'package:machvon_mobile/core/widgets/kpi_tile.dart';

import '../features/dashboard/home_parity_fixtures.dart';
import '../support/harness.dart';
import '../support/widget_host.dart';

/// The "i" of a figure (G0-4) is a shared part: the definition it reads, the button, the sheet, and the tile that carries it.
void main() {
  group('the definition of a figure is read from the `kpi` of the API', () {
    test('every word of the register is kept; the name falls back to the code, the version to 0', () {
      final FigureInfo info = FigureInfo.parse(kpi('X', 'Một số', exclusions: <String>['A', 'B'], origin: 'DEFAULT', unverified: true, version: 0))!;
      expect(info.name, 'Một số');
      expect(info.formula, startsWith('Tổng giải ngân'));
      expect(info.numerator, 'Giải ngân lũy kế theo Kho bạc');
      expect(info.denominator, 'Kế hoạch vốn được giao');
      expect(info.exclusions, <String>['A', 'B']);
      expect(info.source, 'Ảnh chụp số liệu đã chốt');
      expect(info.asOf, '2026-10-31');
      expect(info.owner, 'Vụ Kế hoạch tài chính');
      expect(info.isDefault, isTrue);
      expect(info.unverified, isTrue);

      final FigureInfo bare = FigureInfo.parse(<String, Object?>{'code': 'C', 'formula': 'f'})!;
      expect(bare.name, 'C');
      expect(bare.version, 0);
      expect(bare.numerator, isNull);
      expect(bare.exclusions, isEmpty);
      expect(bare.isDefault, isFalse);
      expect(bare.unverified, isFalse);
    });

    test('without a code and a formula there is nothing to open: no definition, never an empty one', () {
      expect(FigureInfo.parse(null), isNull);
      expect(FigureInfo.parse('x'), isNull);
      expect(FigureInfo.parse(<String, Object?>{'code': 'C'}), isNull);
      expect(FigureInfo.parse(<String, Object?>{'formula': 'f'}), isNull);
      expect(FigureInfo.parse(<String, Object?>{'code': 'C', 'formula': '  '}), isNull);
    });

    test('both languages carry the same words for the sheet', () {
      final Iterable<String> vi = kCoreStrings.vi.keys.where((String key) => key.startsWith('mob.info.figure.'));
      expect(vi, isNotEmpty);
      expect(vi.toSet(), kCoreStrings.en.keys.where((String key) => key.startsWith('mob.info.figure.')).toSet());
    });
  });

  group('the tile that carries an "i"', () {
    FigureInfo info() => FigureInfo.parse(kpi('X', 'Số liệu thử'))!;

    testWidgets('a tile with a definition has the button beside its sentence; one without has none', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await tester.pumpWidget(hostWidget(Column(children: <Widget>[KpiTile(label: 'Có định nghĩa', value: '5', info: info()), const KpiTile(label: 'Không định nghĩa', value: '6')])));
      await tester.pumpAndSettle();

      expect(find.byType(FigureInfoButton), findsOneWidget);
      final Size size = tester.getSize(find.byType(IconButton));
      expect(size.width, greaterThanOrEqualTo(48));
      expect(size.height, greaterThanOrEqualTo(48));
      expect(find.bySemanticsLabel('Có định nghĩa: 5'), findsOneWidget, reason: 'the sentence of the tile is unchanged');
    });

    testWidgets('a tile that is still loading has no "i" (there is nothing to explain yet)', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await tester.pumpWidget(hostWidget(KpiTile(label: 'Đang tải', value: null, info: info())));
      await tester.pump();

      expect(find.byType(FigureInfoButton), findsNothing);
    });

    testWidgets('the button opens the sheet, the sheet shows only what the register said, and Close closes it', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await tester.pumpWidget(hostWidget(FigureInfoButton(info: FigureInfo.parse(kpi('X', 'Số liệu thử', numerator: null, denominator: null, exclusions: <String>[], source: '', owner: ''))!)));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Công thức và nguồn của Số liệu thử'));
      await tester.pumpAndSettle();
      final Finder sheet = find.byType(FigureInfoSheet);
      expect(find.descendant(of: sheet, matching: find.text('Tử số')), findsNothing);
      expect(find.descendant(of: sheet, matching: find.text('Mẫu số')), findsNothing);
      expect(find.descendant(of: sheet, matching: find.text('Không tính')), findsNothing);
      expect(find.descendant(of: sheet, matching: find.text('—')), findsNWidgets(2), reason: 'a source and an owner the register did not give are a dash, not a guess');

      await tester.tap(find.widgetWithText(OutlinedButton, 'Đóng'));
      await tester.pumpAndSettle();
      expect(sheet, findsNothing);
    });
  });
}
