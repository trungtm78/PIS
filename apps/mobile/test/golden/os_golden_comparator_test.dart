import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/v2_support.dart';

/// A 4 by 4 PNG of one colour.
Future<Uint8List> _png(ui.Color color) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawRect(const ui.Rect.fromLTWH(0, 0, 4, 4), ui.Paint()..color = color);
  final ui.Image image = await recorder.endRecording().toImage(4, 4);
  final ByteData? data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}

void main() {
  late Directory dir;
  late Uri testFile;
  final List<String> reasons = <String>[];

  setUp(() {
    dir = Directory.systemTemp.createTempSync('os_goldens_');
    testFile = Uri.file('${dir.path}${Platform.pathSeparator}some_golden_test.dart');
    reasons.clear();
  });

  tearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });

  OsGoldenComparator comparator(String os) => OsGoldenComparator(testFile, os: os, notCompared: reasons.add);

  test('the baseline OS reads goldens/, another OS reads goldens-<os>/', () {
    expect(comparator('windows').baselineOf(Uri.parse('goldens/a.png')).path, 'goldens/a.png');
    expect(comparator('linux').baselineOf(Uri.parse('goldens/a.png')).path, 'goldens-linux/a.png');
    expect(comparator('macos').baselineOf(Uri.parse('goldens/sub/a.png')).path, 'goldens-macos/sub/a.png');
    expect(comparator('linux').baselineOf(Uri.parse('other/a.png')).path, 'other/a.png');
    expect(goldenFolderFor(kGoldenBaselineOs), 'goldens');
  });

  testWidgets('update writes the image of the OS it runs on, and a compare reads that one back', (WidgetTester tester) async {
    await tester.runAsync(() async {
      final Uint8List red = await _png(const ui.Color(0xFFFF0000));
      await comparator('linux').update(Uri.parse('goldens/a.png'), red);
      expect(File('${dir.path}/goldens-linux/a.png').existsSync(), isTrue);
      expect(File('${dir.path}/goldens/a.png').existsSync(), isFalse);
      expect(await comparator('linux').compare(red, Uri.parse('goldens/a.png')), isTrue);
      expect(reasons, isEmpty);
    });
  });

  testWidgets('another OS without goldens of its own does not compare and says why; it never passes in silence', (WidgetTester tester) async {
    await tester.runAsync(() async {
      final Uint8List red = await _png(const ui.Color(0xFFFF0000));
      final Uint8List blue = await _png(const ui.Color(0xFF0000FF));
      await comparator('windows').update(Uri.parse('goldens/a.png'), red);
      expect(await comparator('linux').compare(blue, Uri.parse('goldens/a.png')), isTrue);
      expect(reasons, hasLength(1));
      expect(reasons.single, contains('not compared on linux'));
      expect(reasons.single, contains('goldens-linux'));
    });
  });

  testWidgets('once the folder of the OS exists, a missing image and a different image both fail', (WidgetTester tester) async {
    await tester.runAsync(() async {
      final Uint8List red = await _png(const ui.Color(0xFFFF0000));
      final Uint8List blue = await _png(const ui.Color(0xFF0000FF));
      await comparator('linux').update(Uri.parse('goldens/a.png'), red);
      await expectLater(comparator('linux').compare(red, Uri.parse('goldens/b.png')), throwsA(isA<FlutterError>()));
      await expectLater(comparator('linux').compare(blue, Uri.parse('goldens/a.png')), throwsA(isA<FlutterError>()));
      expect(reasons, isEmpty);
    });
  });

  testWidgets('the baseline OS fails on a missing image and on a different one, with no tolerance between OS', (WidgetTester tester) async {
    await tester.runAsync(() async {
      final Uint8List red = await _png(const ui.Color(0xFFFF0000));
      final Uint8List blue = await _png(const ui.Color(0xFF0000FF));
      await expectLater(comparator('windows').compare(red, Uri.parse('goldens/a.png')), throwsA(isA<FlutterError>()));
      await comparator('windows').update(Uri.parse('goldens/a.png'), red);
      await expectLater(comparator('windows').compare(blue, Uri.parse('goldens/a.png')), throwsA(isA<FlutterError>()));
      expect(kGoldenTolerance, lessThanOrEqualTo(0.005));
      expect(reasons, isEmpty);
    });
  });
}
