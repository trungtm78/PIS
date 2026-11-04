import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The other hardening tests read the native sources as text, so they cannot see a source that does not compile. These tests read
/// them for the one failure that text can show: a symbol used without the import that declares it (the build of the application
/// says "cannot find ... in scope" and the whole target fails, which no Dart test notices). They do not replace a build on a
/// device; they stop the mistake that reached review once (`_dyld_image_count` without `import MachO`).

/// A symbol the Swift sources use, and the modules that declare it. A module that re-exports another is listed beside it
/// (`UIKit` and `Foundation` bring in Darwin; `UIKit` brings in Foundation); `MachO` is brought in by none of them.
const List<({String symbol, String description, Set<String> modules})> _swiftSymbols = <({String symbol, String description, Set<String> modules})>[
  (symbol: r'\b_dyld_\w+|\b_NSGetMachExecuteHeader\b|\bmach_header\w*|\bgetsectbyname\b', description: 'dyld and Mach-O image functions', modules: <String>{'MachO'}),
  (symbol: r'\bsysctl\b|\bkinfo_proc\b|\bgetpid\(|\bCTL_KERN\b|\bKERN_PROC\w*|\bP_TRACED\b', description: 'sysctl and process information', modules: <String>{'Darwin', 'Foundation', 'UIKit'}),
  (symbol: r'\bUI[A-Z]\w+', description: 'UIKit types', modules: <String>{'UIKit'}),
  (symbol: r'\bFlutter[A-Z]\w+', description: 'Flutter types', modules: <String>{'Flutter'}),
  (symbol: r'\bFileManager\b|\bNotificationCenter\b|\bURLResourceValues\b|\bNSObjectProtocol\b|\bProcessInfo\b|\bUserDefaults\b|\bJSONSerialization\b', description: 'Foundation types', modules: <String>{'Foundation', 'UIKit'}),
  (symbol: r'\bXCT\w+', description: 'XCTest', modules: <String>{'XCTest'}),
];

/// The names a Kotlin file may use without importing: the language's own and the ones it declares itself.
const Set<String> _kotlinBuiltIns = <String>{
  'Any',
  'Array',
  'Boolean',
  'Exception',
  'Int',
  'Long',
  'Nothing',
  'Pair',
  'Sequence',
  'String',
  'Throwable',
  'Unit',
  'List',
  'Map',
  'Set',
};

String _withoutCommentsAndStrings(String source) {
  final String noBlock = source.replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '');
  final String noLine = noBlock.replaceAll(RegExp(r'//[^\n]*'), '');
  return noLine.replaceAll(RegExp(r'"(?:\\.|[^"\\\n])*"'), '""');
}

Set<String> _swiftImports(String source) =>
    RegExp(r'^\s*import\s+(?:(?:typealias|struct|class|enum|protocol|func|var|let)\s+)?([A-Za-z_][\w.]*)', multiLine: true).allMatches(source).map((RegExpMatch m) => m.group(1)!).toSet();

/// What a Swift file uses without importing the module that declares it, as readable lines.
List<String> swiftMissingImports(String source) {
  final String code = _withoutCommentsAndStrings(source);
  final Set<String> imported = _swiftImports(code);
  final List<String> missing = <String>[];
  for (final ({String symbol, String description, Set<String> modules}) rule in _swiftSymbols) {
    final RegExpMatch? use = RegExp(rule.symbol).firstMatch(code);
    if (use != null && imported.intersection(rule.modules).isEmpty) {
      missing.add('${use.group(0)} (${rule.description}) needs import ${rule.modules.first}');
    }
  }
  return missing;
}

/// The names a Kotlin package declares in its sources.
Set<String> _kotlinDeclared(String source) =>
    RegExp(r'\b(?:class|object|interface|typealias)\s+([A-Z]\w*)').allMatches(_withoutCommentsAndStrings(source)).map((RegExpMatch m) => m.group(1)!).toSet();

/// The types a Kotlin file uses that it neither imports, nor declares, nor gets from the language.
List<String> kotlinMissingImports(String source, {Set<String> samePackage = const <String>{}}) {
  final String code = _withoutCommentsAndStrings(source);
  final Set<String> imported = RegExp(r'^\s*import\s+[\w.]*\.(\w+)\s*$', multiLine: true).allMatches(code).map((RegExpMatch m) => m.group(1)!).toSet();
  final String body = code.replaceAll(RegExp(r'^\s*(?:import|package)\s+.*$', multiLine: true), '');
  final Set<String> known = <String>{..._kotlinBuiltIns, ..._kotlinDeclared(source), ...samePackage, ...imported};
  final Set<String> missing = <String>{};
  // A capitalised name that is not a member of something (`WindowManager.LayoutParams`) and not a constant (`FLAG_SECURE`).
  for (final RegExpMatch use in RegExp(r'(?<![\w.])([A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*)\b').allMatches(body)) {
    final String name = use.group(1)!;
    if (!known.contains(name)) missing.add(name);
  }
  return missing.toList()..sort();
}

String _read(String path) => File(path).readAsStringSync();

List<File> _sources(String directory, String extension) => Directory(directory)
    .listSync(recursive: true)
    .whereType<File>()
    .where((File f) => f.path.endsWith(extension))
    .where((File f) => !f.path.contains('${Platform.pathSeparator}ephemeral${Platform.pathSeparator}'))
    .toList();

void main() {
  group('REVIEW-m1-7 INTEG-01 SEC-04 the native sources import what they use (a Dart test only reads their text)', () {
    test('every Swift file of the iOS target imports the module of each symbol it uses', () {
      final List<File> files = <File>[..._sources('ios/Runner', '.swift'), ..._sources('ios/RunnerTests', '.swift')];
      expect(files.map((File f) => f.uri.pathSegments.last), containsAll(<String>['AppDelegate.swift', 'SceneDelegate.swift']));
      for (final File file in files) {
        expect(swiftMissingImports(file.readAsStringSync()), isEmpty, reason: file.path);
      }
    });

    test('the dyld calls of the hooking check are declared by MachO, which the app delegate imports', () {
      final String source = _read('ios/Runner/AppDelegate.swift');
      expect(source, contains('_dyld_image_count()'));
      expect(source, contains('_dyld_get_image_name('));
      expect(_swiftImports(source), contains('MachO'));
    });

    test('the check sees the failure it exists for: the app delegate without the MachO import', () {
      final String source = _read('ios/Runner/AppDelegate.swift');
      final String broken = source.replaceAll(RegExp(r'^import MachO\r?\n', multiLine: true), '');
      expect(broken, isNot(source));
      expect(swiftMissingImports(broken), contains(startsWith('_dyld_image_count (dyld and Mach-O image functions) needs import MachO')));
      expect(swiftMissingImports(source.replaceAll(RegExp(r'^import UIKit\r?\n', multiLine: true), '')), isNotEmpty, reason: 'UIKit is needed too');
    });

    test('a symbol named in a comment or a string needs no import', () {
      expect(swiftMissingImports('import Flutter\n// _dyld_image_count() is declared by MachO\nlet note = "UIView and _dyld_image_count"\n'), isEmpty);
    });

    test('every Kotlin file imports the types it uses', () {
      final List<File> files = _sources('android/app/src/main', '.kt');
      expect(files.map((File f) => f.uri.pathSegments.last), contains('MainActivity.kt'));
      final Set<String> samePackage = files.expand((File f) => _kotlinDeclared(f.readAsStringSync())).toSet();
      for (final File file in files) {
        expect(kotlinMissingImports(file.readAsStringSync(), samePackage: samePackage), isEmpty, reason: file.path);
      }
    });

    test('the Kotlin check sees an import that was removed', () {
      final String source = _read('android/app/src/main/kotlin/vn/machvon/machvon_mobile/MainActivity.kt');
      for (final String type in <String>['Build', 'Debug', 'WindowManager', 'MethodChannel', 'FlutterEngine', 'File']) {
        final String broken = source.replaceAll(RegExp('^import [\\w.]*\\.$type\\r?\\n', multiLine: true), '');
        expect(broken, isNot(source), reason: type);
        expect(kotlinMissingImports(broken), contains(type));
      }
    });
  });
}
