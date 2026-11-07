import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/read_support/widgets.dart';

import '../../support/widget_host.dart';

Future<void> _pump(WidgetTester tester, {required double scale, int columns = 2}) async {
  tester.view.physicalSize = const Size(360, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    hostWidget(
      MediaQuery(
        data: MediaQueryData(size: const Size(360, 800), textScaler: TextScaler.linear(scale)),
        child: SingleChildScrollView(
          child: SectionCard(
            title: 'Tổng',
            children: <Widget>[
              KpiGroup(
                columns: columns,
                tiles: const <Widget>[
                  KpiTile(label: 'Mở đầu tuần', value: '12'),
                  KpiTile(label: 'Phát sinh', value: '3'),
                  KpiTile(label: 'Tồn cuối tuần', value: '15'),
                ],
              ),
            ],
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  group('KpiGroup: the headline figures of a block', () {
    testWidgets('two to a line at the normal text size, an odd last one alone, and each figure reads as one sentence', (WidgetTester tester) async {
      await _pump(tester, scale: 1);
      expect(find.byType(KpiTile), findsNWidgets(3));
      expect(tester.getTopLeft(find.text('Phát sinh')).dy, tester.getTopLeft(find.text('Mở đầu tuần')).dy, reason: 'the first two share a line');
      expect(tester.getTopLeft(find.text('Tồn cuối tuần')).dy, greaterThan(tester.getBottomLeft(find.text('Mở đầu tuần')).dy));
      expect(find.bySemanticsLabel('Tồn cuối tuần: 15'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('at 200 percent the figures are stacked one under the other and nothing overflows', (WidgetTester tester) async {
      await _pump(tester, scale: 2);
      expect(tester.getTopLeft(find.text('Phát sinh')).dy, greaterThan(tester.getBottomLeft(find.text('Mở đầu tuần')).dy));
      expect(tester.takeException(), isNull);
    });

    testWidgets('one column is used for amounts, which need the whole width', (WidgetTester tester) async {
      await _pump(tester, scale: 1, columns: 1);
      expect(tester.getTopLeft(find.text('Phát sinh')).dy, greaterThan(tester.getBottomLeft(find.text('Mở đầu tuần')).dy));
      expect(tester.takeException(), isNull);
    });
  });
}
