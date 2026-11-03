import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/personal_bi/charts.dart';

void main() {
  group('AC-ST-MOB-027-4 UI-MOB-40 the marks of a tile', () {
    testWidgets('a line is redrawn when its values change and is drawn only with two points or more', (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: LineSketch(values: <double>[1, 3, 2], area: false))));
      expect(find.byType(CustomPaint), findsWidgets);
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: LineSketch(values: <double>[1, 3, 2, 5], area: true))));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: LineSketch(values: <double>[4], area: false))));
      expect(find.byType(LineSketch), findsOneWidget);
      expect(find.descendant(of: find.byType(LineSketch), matching: find.byType(CustomPaint)), findsNothing, reason: 'one point is not a line');
    });

    testWidgets('a bar is a mark for the eye only: a screen reader does not read it', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: ProportionBar(fraction: 0.5, negative: true))));
      expect(find.byType(ProportionBar), findsOneWidget);
      expect(tester.getSemantics(find.byType(ProportionBar)).label, isEmpty);
      semantics.dispose();
    });
  });
}
