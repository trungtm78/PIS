import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'design_rules_scan.dart';

/// The static part of the performance budget of the phone (R41, `docs/qa/perf-budget.json`, table `mobile`): what a screen is not allowed to
/// draw because it costs a frame on a mid-range phone. The measured part (cold start, frame times of a long list) needs a device and is not
/// claimed here.
const List<String> _costly = <String>['LinearGradient(', 'RadialGradient(', 'SweepGradient(', 'BackdropFilter(', 'ImageFiltered(', 'ShaderMask(', 'Opacity('];

/// The only shared widgets that may cast a shadow: the action bar, the sheet and the floating button (design-system-v2 section 3.3).
const Set<String> _mayCastAShadow = <String>{'lib/core/widgets/action_bar.dart', 'lib/core/widgets/sheets.dart'};

Iterable<File> _dartFiles(String root) => Directory(root).listSync(recursive: true).whereType<File>().where((File file) => file.path.endsWith('.dart'));

String _relative(File file) => file.path.replaceAll('\\', '/').substring(file.path.replaceAll('\\', '/').indexOf('lib/'));

void main() {
  group('the performance budget of the phone: what the shared widgets never draw (R41)', () {
    test('no gradient, blur, filter or opacity layer in the shared widgets, the state widgets or the shell', () {
      final List<String> found = <String>[];
      for (final String root in <String>['lib/core/widgets', 'lib/core/state', 'lib/core/navigation']) {
        for (final File file in _dartFiles(root)) {
          final String code = stripComments(file.readAsStringSync());
          for (final String pattern in _costly) {
            if (code.contains(pattern)) found.add('${_relative(file)} uses $pattern');
          }
        }
      }
      expect(found, isEmpty, reason: found.join('\n'));
    });

    test('a shadow is cast only by the action bar, the sheet and the floating button, and nowhere in a list row', () {
      final List<String> found = <String>[];
      for (final File file in _dartFiles('lib/core/widgets')) {
        final String code = stripComments(file.readAsStringSync());
        final bool shadow = code.contains('boxShadow:') || code.contains('BoxShadow(') || code.contains('.e1') || code.contains('.e2') || RegExp(r'\belevation:\s*[1-9]').hasMatch(code);
        if (shadow && !_mayCastAShadow.contains(_relative(file))) found.add(_relative(file));
      }
      expect(found, isEmpty, reason: 'these shared widgets cast a shadow: ${found.join(', ')}');
    });

    test('the skeleton is not animated: no controller, no ticker, no shimmer', () {
      for (final String path in <String>['lib/core/widgets/skeleton.dart', 'lib/core/widgets/work_row.dart']) {
        final String code = stripComments(File(path).readAsStringSync());
        expect(code, isNot(contains('AnimationController')), reason: path);
        expect(code, isNot(contains('TickerProvider')), reason: path);
        expect(code.toLowerCase(), isNot(contains('shimmer')), reason: path);
      }
    });

    test('no illustration of a screen is over 150 KB, and the shared widgets draw their glyphs as icons, not images', () {
      final Directory assets = Directory('assets');
      for (final File file in assets.listSync(recursive: true).whereType<File>()) {
        final String name = file.path.toLowerCase();
        if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp') || name.endsWith('.gif')) {
          expect(file.lengthSync(), lessThanOrEqualTo(150 * 1024), reason: '${file.path} is over 150 KB');
        }
      }
      for (final File file in _dartFiles('lib/core/widgets')) {
        // The brand logo is the one image the shared widgets draw (a 9 KB file); it is not an illustration.
        if (_relative(file) == 'lib/core/widgets/brand_logo.dart') continue;
        final String code = stripComments(file.readAsStringSync());
        expect(code, isNot(contains('Image.asset')), reason: '${_relative(file)} draws an image');
        expect(code, isNot(contains('Image.network')), reason: '${_relative(file)} draws an image');
      }
    });

    test('the budget table of the phone is in perf-budget.json with the figures of the design system', () {
      final Map<String, Object?> budget = jsonDecode(File('../../docs/qa/perf-budget.json').readAsStringSync()) as Map<String, Object?>;
      final Map<String, Object?> mobile = budget['mobile']! as Map<String, Object?>;
      final Map<String, Object?> cold = mobile['coldStart']! as Map<String, Object?>;
      final Map<String, Object?> frames = mobile['scrollFrames']! as Map<String, Object?>;
      final Map<String, Object?> rules = mobile['staticRules']! as Map<String, Object?>;
      expect(cold['budgetMs'], 2500);
      expect(cold['stat'], 'p75');
      expect(frames['slowFramePercentMax'], 1);
      expect(frames['slowFrameOverMs'], 16);
      expect(frames['frozenFramesMax'], 0);
      expect(frames['frozenFrameOverMs'], 700);
      expect(rules['shadowsAndGradientsInLists'], 0);
      expect(rules['illustrationKbPerScreenMax'], 150);
      expect(cold['measured'], isNull, reason: 'a figure that was not measured is null, never an estimate');
      expect(frames['measured'], isNull);
    });
  });
}
