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

/// The operating system the committed goldens (the folders `goldens`) were drawn on.
const String kGoldenBaselineOs = 'windows';

/// Share of the pixels a golden may differ from the baseline of its own operating system: the goldens use the test font, and a later
/// version of the same OS may still antialias an edge of a shape or a glyph a little differently.
///
/// It is not a tolerance between operating systems. Text cannot match across them: the glyph boxes of the test font are rasterised
/// with the hinting and antialiasing of the font engine of each OS, so the edges of every line of text land on other pixels, and the
/// share grows with the amount of text, not with any change of the screen. The run of CI Mobile on the merge of PR 2 (37c2c9014,
/// 2026-11-13) measured 3.05 to 5.59 percent on 26 text-heavy screens against the Windows images (an earlier run 0.9 to 1.9 percent on
/// the widget galleries), while a real change of one label is a fraction of a percent: no share can tell the two apart.
/// So each OS compares with baselines of its own, the decision of the web visual cases (docs/runbooks/web-e2e.md, "Baselines of another OS").
const double kGoldenTolerance = 0.005;

/// The folder of the goldens of [os], next to the test file: `goldens` for the OS of the committed baselines, `goldens-<os>` for another.
String goldenFolderFor(String os) => os == kGoldenBaselineOs ? 'goldens' : 'goldens-$os';

/// Compares a golden with the baseline of the operating system the test runs on (see [kGoldenTolerance] for why).
///
/// - On the baseline OS it reads `goldens/<name>.png`.
/// - On another OS it reads `goldens-<os>/<name>.png`. While that folder does not exist, the pixels are not compared: the test is
///   marked skipped with the reason (never reported as passed), its other expectations still run, and the run on the baseline OS
///   (the pre-push gate) is the pixel gate. Once the folder exists, a missing image fails.
/// - `flutter test --update-goldens` writes the images of the OS it runs on: `goldens` on Windows, `goldens-linux` on the CI runner
///   (the workflow Mobile started by hand with `update_goldens`, docs/mobile-foundation.md, "Goldens of another OS").
class OsGoldenComparator extends LocalFileComparator {
  OsGoldenComparator(super.testFile, {String? os, this.tolerance = kGoldenTolerance, void Function(String reason)? notCompared})
      : os = os ?? Platform.operatingSystem,
        notCompared = notCompared ?? markTestSkipped;

  /// The operating system whose baselines are read and written.
  final String os;

  final double tolerance;

  /// Says why a golden was not compared; by default it marks the running test skipped with that reason.
  final void Function(String reason) notCompared;

  /// [golden] (always `goldens/<name>.png` in this application) moved to the folder of [os].
  Uri baselineOf(Uri golden) {
    final List<String> segments = golden.pathSegments;
    if (segments.length < 2 || segments.first != 'goldens') return golden;
    return Uri(pathSegments: <String>[goldenFolderFor(os), ...segments.skip(1)]);
  }

  File _file(Uri relative) => File.fromUri(basedir.resolveUri(relative));

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final Uri own = baselineOf(golden);
    final File file = _file(own);
    if (!file.existsSync()) {
      final Directory folder = file.parent;
      if (os != kGoldenBaselineOs && !folder.existsSync()) {
        notCompared('golden "$golden" not compared on $os: there are no goldens of this OS yet (${folder.path}). '
            'The goldens were drawn on $kGoldenBaselineOs, whose run is the pixel gate; render these with the workflow Mobile and update_goldens.');
        return true;
      }
      throw FlutterError('There is no golden "$own" for $os. Render it with `flutter test --update-goldens` on $os '
          '(for linux: the workflow Mobile started by hand with update_goldens) and commit it.');
    }
    final ComparisonResult result = await GoldenFileComparator.compareLists(imageBytes, await file.readAsBytes());
    if (result.passed || result.diffPercent <= tolerance) {
      result.dispose();
      return true;
    }
    final String error = await generateFailureOutput(result, own, basedir);
    result.dispose();
    throw FlutterError(error);
  }

  @override
  Future<void> update(Uri golden, Uint8List imageBytes) async {
    final File file = _file(baselineOf(golden));
    await file.parent.create(recursive: true);
    await file.writeAsBytes(imageBytes, flush: true);
  }
}

/// Compares the goldens of the calling test file with the baselines of the OS it runs on; call it first in `main`.
void useOsGoldens(String testFile) {
  goldenFileComparator = OsGoldenComparator(Uri.file('${Directory.current.path}/$testFile'));
}
