import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/api/problem.dart';
import 'package:machvon_mobile/core/state/empty_state_view.dart';
import 'package:machvon_mobile/core/state/problem_state_view.dart';

import '../support/harness.dart';
import '../support/widget_host.dart';

/// Goldens are drawn with the test font, so they do not depend on the fonts of the machine; the antialiasing of the
/// shapes still differs a little between operating systems, so a difference up to this share of the pixels is accepted.
const double _tolerance = 0.005;

class _TolerantComparator extends LocalFileComparator {
  _TolerantComparator(super.testFile);

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final ComparisonResult result = await GoldenFileComparator.compareLists(imageBytes, await getGoldenBytes(golden));
    if (result.passed || result.diffPercent <= _tolerance) return true;
    throw FlutterError(await generateFailureOutput(result, golden, basedir));
  }
}

ProblemView _problem() => ProblemView.from(
      const ApiError(status: 500, code: 'INTERNAL_ERROR', correlationId: '3f2b6c1e-0000-4000-8000-000000000003'),
    );

void main() {
  goldenFileComparator = _TolerantComparator(Uri.file('${Directory.current.path}/test/golden/states_golden_test.dart'));

  group('TK-MOB-001-7 UI-MOB-52 UI-MOB-53 golden images of the empty and error states', () {
    for (final Size size in kDeviceSizes) {
      final String name = '${size.width.toInt()}x${size.height.toInt()}';
      testWidgets('UI-MOB-52 empty state at $name', (WidgetTester tester) async {
        useDevice(tester, size);
        await tester.pumpWidget(hostWidget(EmptyStateView(activeFilters: const <String>['Đang thực hiện'], onClearFilters: () {})));
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/empty_$name.png'));
      });

      testWidgets('UI-MOB-53 error state at $name', (WidgetTester tester) async {
        useDevice(tester, size);
        await tester.pumpWidget(hostWidget(ProblemStateView(problem: _problem(), onRetry: () {})));
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/error_$name.png'));
      });
    }

    testWidgets('UI-MOB-53 error state at 360x800 with 200 percent text', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[0], textScale: 2.0);
      await tester.pumpWidget(hostWidget(ProblemStateView(problem: _problem(), onRetry: () {})));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/error_360x800_text200.png'));
    });

    testWidgets('UI-MOB-52 empty state at 360x800 with 200 percent text', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[0], textScale: 2.0);
      await tester.pumpWidget(hostWidget(EmptyStateView(activeFilters: const <String>['Đang thực hiện'], onClearFilters: () {})));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/empty_360x800_text200.png'));
    });
  });
}
