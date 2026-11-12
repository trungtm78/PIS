import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/theme/colors.dart';
import 'package:machvon_mobile/core/widgets/filter_chips.dart';
import 'package:machvon_mobile/core/widgets/glyph_square.dart';
import 'package:machvon_mobile/core/widgets/work_row.dart';

import '../../support/v2_support.dart';

void main() {
  group('GlyphSquare, the quiet WorkRow and the 48 high tap target of a filter chip (MUX-3 wave A)', () {
    testWidgets('a glyph square is the size of a deadline glyph, says nothing to a screen reader, and takes its tint from the palette of the mode', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      for (final Brightness brightness in Brightness.values) {
        await pumpV2(
          tester,
          const Row(children: <Widget>[GlyphSquare(icon: Icons.notifications_none), GlyphSquare(icon: Icons.warning_amber_rounded, tone: GlyphTone.attention), GlyphSquare(icon: Icons.drafts_outlined, tone: GlyphTone.neutral)]),
          brightness: brightness,
        );
        final MachvonV2 v2 = brightness == Brightness.dark ? MachvonV2.dark : MachvonV2.light;
        final List<Color> fills = <Color>[
          for (final Element element in find.byType(GlyphSquare).evaluate()) _fillOf(tester, element),
        ];
        expect(fills, <Color>[v2.palette.primarySoft, v2.palette.soonBg, v2.palette.sunken], reason: 'the three tones in the $brightness mode');
        expect(tester.getSize(find.byType(GlyphSquare).first), const Size(40, 40));
      }
      expect(find.bySemanticsLabel(RegExp('.')), findsNothing, reason: 'a glyph is decoration');
      semantics.dispose();
    });

    testWidgets('a quiet row draws its title in the body weight and the secondary ink, a loud one in the strong weight', (WidgetTester tester) async {
      await pumpV2(tester, gallery(const <Widget>[WorkRow(title: 'Mới', quiet: false), WorkRow(title: 'Đã đọc', quiet: true)]));
      final TextStyle loud = tester.widget<Text>(find.text('Mới')).style!;
      final TextStyle quiet = tester.widget<Text>(find.text('Đã đọc')).style!;
      expect(loud.fontWeight, FontWeight.w600);
      expect(quiet.fontWeight, FontWeight.w400);
      expect(quiet.color, MachvonV2.light.palette.ink2);
    });

    testWidgets('a filter chip is drawn 44 high and tapped 48 high (the Android minimum), and the row keeps the height it had', (WidgetTester tester) async {
      await pumpV2(tester, Column(mainAxisSize: MainAxisSize.min, children: <Widget>[FilterChips<int>(options: const <ChipOption<int>>[ChipOption<int>(value: 1, label: 'Tất cả', count: 4), ChipOption<int>(value: 2, label: 'Chưa đọc')], selected: 1, onChanged: (_) {})]));
      expect(tester.getSize(find.byType(FilterChips<int>)).height, 60, reason: '6 + 48 + 6, as the 8 + 44 + 8 of the first drawing');
      final Size tap = tester.getSize(find.ancestor(of: find.text('Tất cả 4'), matching: find.byType(InkWell)).first);
      expect(tap.height, greaterThanOrEqualTo(48));
    });
  });
}

Color _fillOf(WidgetTester tester, Element glyph) {
  final DecoratedBox box = tester.widget<DecoratedBox>(find.descendant(of: find.byWidget(glyph.widget), matching: find.byType(DecoratedBox)).first);
  return (box.decoration as BoxDecoration).color!;
}
