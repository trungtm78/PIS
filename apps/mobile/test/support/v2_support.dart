import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';

import 'harness.dart';
import 'widget_host.dart';

/// A scrolling column of widgets, the way a screen lays them out, for the tests of the shared widgets.
Widget gallery(List<Widget> children) => SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children));

/// Hosts [child] on a 390 by 844 phone (or [size]) at the given text scale, in the light or the dark mode, and lets it settle.
Future<void> pumpV2(
  WidgetTester tester,
  Widget child, {
  double scale = 1.0,
  Brightness brightness = Brightness.light,
  Locale locale = const Locale('vi'),
  Size size = const Size(390, 844),
  List<StringTable> tables = const <StringTable>[],
}) async {
  useDevice(tester, size, textScale: scale);
  await tester.pumpWidget(hostWidget(child, locale: locale, brightness: brightness, tables: tables));
  await tester.pumpAndSettle();
}

/// Goldens are drawn with the test font, so they do not depend on the fonts of the machine; the antialiasing of the shapes still differs a
/// little between operating systems, so a difference up to this share of the pixels is accepted (the same tolerance as the state goldens).
const double kGoldenTolerance = 0.005;

class TolerantComparator extends LocalFileComparator {
  TolerantComparator(super.testFile);

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final ComparisonResult result = await GoldenFileComparator.compareLists(imageBytes, await getGoldenBytes(golden));
    if (result.passed || result.diffPercent <= kGoldenTolerance) return true;
    throw FlutterError(await generateFailureOutput(result, golden, basedir));
  }
}

/// Makes the goldens of the calling test file tolerant; call it first in `main`.
void useTolerantGoldens(String testFile) {
  goldenFileComparator = TolerantComparator(Uri.file('${Directory.current.path}/$testFile'));
}
