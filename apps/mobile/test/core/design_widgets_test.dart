import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/theme/app_theme.dart';
import 'package:machvon_mobile/core/theme/machvon_semantic.dart';
import 'package:machvon_mobile/core/widgets/command_hero.dart';
import 'package:machvon_mobile/core/widgets/context_line.dart';
import 'package:machvon_mobile/core/widgets/kpi_tile.dart';
import 'package:machvon_mobile/core/widgets/status_pill.dart';
import 'package:machvon_mobile/features/read_support/widgets.dart' show SectionCard;
import 'package:machvon_tokens/machvon_tokens.dart';

import '../support/widget_host.dart';

void main() {
  group('the theme "Xanh dầu điều hành"', () {
    final ThemeData theme = buildAppTheme(platform: TargetPlatform.android);

    // MUX-1: the app bar is the slim bar of the phone design (surface colour, ink text, no shadow); the dark navy anchor is the command band.
    test('the app bar is the slim bar of the phone design: surface colour, ink 16 px titles, left aligned', () {
      expect(theme.appBarTheme.backgroundColor, MachvonV2Colors.light.surface);
      expect(theme.appBarTheme.foregroundColor, MachvonV2Colors.light.ink);
      expect(theme.appBarTheme.centerTitle, isFalse);
      expect(theme.appBarTheme.elevation, 0);
      expect(theme.appBarTheme.titleTextStyle?.fontSize, MachvonV2Type.heading.size);
      expect(theme.appBarTheme.titleTextStyle?.fontWeight, FontWeight.w600);
    });

    test('the bottom navigation is white with a soft teal indicator and 12 px labels', () {
      expect(theme.navigationBarTheme.backgroundColor, MachvonColors.surface);
      expect(theme.navigationBarTheme.indicatorColor, MachvonColors.primarySoft);
      final TextStyle selected = theme.navigationBarTheme.labelTextStyle!.resolve(<WidgetState>{WidgetState.selected})!;
      expect(selected.fontSize, 12);
      expect(selected.color, MachvonColors.primary);
    });

    test('the filled button is teal, 8 px radius and as high as a touch target', () {
      final ButtonStyle style = theme.filledButtonTheme.style!;
      expect(style.backgroundColor!.resolve(<WidgetState>{}), MachvonColors.primary);
      expect(style.minimumSize!.resolve(<WidgetState>{}), const Size(48, 48));
      final OutlinedBorder border = style.shape!.resolve(<WidgetState>{})!;
      expect(border, isA<RoundedRectangleBorder>());
      expect((border as RoundedRectangleBorder).borderRadius, BorderRadius.circular(MachvonRadius.control));
    });

    test('the card has a 14 px radius, a 1 px border and no shadow', () {
      final RoundedRectangleBorder shape = theme.cardTheme.shape! as RoundedRectangleBorder;
      expect(shape.borderRadius, BorderRadius.circular(MachvonRadius.card));
      expect(shape.side, const BorderSide(color: MachvonColors.border));
      expect(theme.cardTheme.elevation, 0);
    });

    test('the type scale uses only 12, 14, 16, 20, 28 and 32 and the digits of the numbers are tabular', () {
      final TextTheme text = theme.textTheme;
      expect(<double?>[text.bodySmall?.fontSize, text.labelMedium?.fontSize, text.labelSmall?.fontSize], everyElement(12));
      expect(text.bodyMedium?.fontSize, 16);
      expect(text.titleMedium?.fontSize, 16);
      expect(text.headlineSmall?.fontSize, 20);
      expect(text.titleLarge?.fontSize, 28);
      expect(text.displaySmall?.fontSize, 32);
      expect(text.displaySmall?.fontFeatures, contains(const FontFeature.tabularFigures()));
      expect(text.headlineMedium?.fontFeatures, contains(const FontFeature.tabularFigures()));
      expect(theme.textTheme.bodyMedium?.fontFamily, MachvonFont.family);
    });

    test('the semantic colours are an extension of the theme and keep their text contrast on their soft fill', () {
      final MachvonSemantic semantic = theme.extension<MachvonSemantic>()!;
      for (final MachvonTone tone in MachvonTone.values) {
        expect(contrastRatio(semantic.onSoft(tone), semantic.soft(tone)), greaterThanOrEqualTo(kMinTextContrast), reason: tone.name);
        expect(contrastRatio(semantic.strong(tone), MachvonColors.surface), greaterThanOrEqualTo(kMinTextContrast), reason: tone.name);
      }
    });

    test('a tenant theme changes the command band and the selected colour, never the semantic colours or the three deadline bands', () {
      final ThemeData tenant = buildAppTheme(
        platform: TargetPlatform.android,
        tenantOverlay: const <String, String>{'primary': '#0a4d8c', 'menu': '#0a2540'},
      );
      expect(tenant.extension<MachvonV2>()!.palette.header, const Color(0xFF0A2540));
      expect(tenant.extension<MachvonV2>()!.palette.primary, const Color(0xFF0A4D8C));
      expect(tenant.extension<MachvonV2>()!.palette.lateFg, MachvonV2Colors.light.lateFg);
      expect(tenant.extension<MachvonV2>()!.palette.okMark, MachvonV2Colors.light.okMark);
      expect(tenant.filledButtonTheme.style!.backgroundColor!.resolve(<WidgetState>{}), const Color(0xFF0A4D8C));
      expect(tenant.extension<MachvonSemantic>()!.danger, MachvonColors.danger);
    });
  });

  group('the shared widgets of the design', () {
    testWidgets('StatusPill says its tone with an icon and a text for every tone', (WidgetTester tester) async {
      await tester.pumpWidget(
        hostWidget(
          Wrap(
            children: <Widget>[
              for (final MachvonTone tone in MachvonTone.values) StatusPill(label: 'Trạng thái ${tone.name}', tone: tone),
              const StatusPill(label: 'Cũ', warn: true),
            ],
          ),
        ),
      );
      for (final MachvonTone tone in MachvonTone.values) {
        expect(find.text('Trạng thái ${tone.name}'), findsOneWidget);
      }
      expect(find.byType(Icon), findsNWidgets(MachvonTone.values.length + 1));
      expect(find.byIcon(Icons.warning_amber_rounded), findsNWidgets(2));
    });

    testWidgets('CommandHero shows the value in 32 px with its unit and never a 0 while it loads', (WidgetTester tester) async {
      await tester.pumpWidget(hostWidget(const CommandHero(eyebrow: 'Nhịp đầu tư', value: '214,71', unit: 'tỷ đồng', caption: 'Đã giải ngân.', ratio: 0.62, ratioLabel: '62%')));
      expect(tester.widget<Text>(find.text('214,71')).style?.fontSize, 32);
      expect(find.text('NHỊP ĐẦU TƯ'), findsOneWidget);
      expect(find.text('tỷ đồng'), findsOneWidget);

      await tester.pumpWidget(hostWidget(const CommandHero(eyebrow: 'Nhịp đầu tư', value: null)));
      expect(find.text('0'), findsNothing);
      expect(find.text('214,71'), findsNothing);
      expect(find.bySemanticsLabel(RegExp('Đang tải')), findsOneWidget);
    });

    testWidgets('KpiTile reads as one sentence and shows a skeleton, not a 0, while it loads', (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(hostWidget(const KpiTile(label: 'Giải ngân', value: '1.234,5', unit: 'tỷ đồng', note: '+4,2% so với kế hoạch', noteTone: MachvonTone.success)));
      expect(find.bySemanticsLabel('Giải ngân: 1.234,5 tỷ đồng, +4,2% so với kế hoạch'), findsOneWidget);
      await tester.pumpWidget(hostWidget(const KpiTile(label: 'Giải ngân', value: null)));
      expect(find.text('0'), findsNothing);
      expect(find.bySemanticsLabel('Giải ngân: Đang tải'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('SectionCard shows the ĐVT chip next to its heading', (WidgetTester tester) async {
      await tester.pumpWidget(hostWidget(const SectionCard(title: 'Cơ cấu vốn', unit: 'tỷ đồng', children: <Widget>[Text('nội dung')])));
      expect(find.text('ĐVT: tỷ đồng'), findsOneWidget);
      await tester.pumpWidget(hostWidget(const SectionCard(title: 'Cơ cấu vốn', children: <Widget>[Text('nội dung')])));
      expect(find.text('Cơ cấu vốn'), findsOneWidget);
      expect(find.textContaining('ĐVT'), findsNothing);
    });

    for (final double scale in <double>[1.0, 2.0]) {
      testWidgets('the shared widgets keep contrast and touch targets, and do not overflow at text scale $scale', (WidgetTester tester) async {
        final SemanticsHandle handle = tester.ensureSemantics();
        tester.view.physicalSize = const Size(360, 800);
        tester.view.devicePixelRatio = 1;
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        await tester.pumpWidget(
          hostWidget(
            SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  ContextLine(parts: const <String>['Toàn công ty · Năm 2026', 'Chốt số liệu 30/10/2026', 'Số liệu tại 07/11/2026 08:00'], stale: true, onRefresh: () {}, refreshLabel: 'Làm mới'),
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: CommandHero(
                      eyebrow: 'Nhịp đầu tư / tháng 10.2026',
                      value: '214,71',
                      unit: 'tỷ đồng',
                      caption: 'Đã giải ngân trong phạm vi được chọn.',
                      ratio: 0.62,
                      ratioLabel: '62%',
                      actions: <CommandHeroAction>[
                        CommandHeroAction(label: 'Khám phá dòng vốn', onPressed: () {}),
                        CommandHeroAction(label: '03 quyết định cần xử lý', onPressed: () {}),
                      ],
                    ),
                  ),
                  const Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: KpiTile(label: 'Giải ngân', value: '1.234,5', unit: 'tỷ đồng', note: '+4,2% so với kế hoạch', noteTone: MachvonTone.success)),
                  const SectionCard(title: 'Cơ cấu vốn', unit: 'tỷ đồng', uppercase: true, children: <Widget>[StatusPill(label: 'Số liệu cũ', tone: MachvonTone.warning)]),
                ],
              ),
            ),
          ),
        );
        final Object? thrown = tester.takeException();
        if (thrown is FlutterError) debugPrint(thrown.toStringDeep());
        expect(thrown, isNull);
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        handle.dispose();
      });
    }
  });
}
