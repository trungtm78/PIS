import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The Android identity of the application as text. The tests run from `apps/mobile`.
String _read(String path) => File(path).readAsStringSync();

String get _gradle => _read('android/app/build.gradle.kts');

String _gradleValue(String key) => RegExp('$key\\s*=\\s*"([^"]+)"').firstMatch(_gradle)!.group(1)!;

/// Every `res/values*/styles.xml` of the main source set, with the folder it is in.
List<File> get _styleFiles => Directory('android/app/src/main/res')
    .listSync()
    .whereType<Directory>()
    .where((Directory d) => d.uri.pathSegments.where((String s) => s.isNotEmpty).last.startsWith('values'))
    .map((Directory d) => File('${d.path}/styles.xml'))
    .where((File f) => f.existsSync())
    .toList();

/// The files under [root] whose name ends with one of [extensions].
List<File> _files(String root, List<String> extensions) => Directory(root)
    .listSync(recursive: true)
    .whereType<File>()
    .where((File f) => extensions.any(f.path.endsWith))
    .toList();

void main() {
  group('AC-ST-MOB-041-2 the biometric prompt of local_auth works on every supported Android', () {
    test('MainActivity is a FragmentActivity of the namespace of the build', () {
      final String namespace = _gradleValue('namespace');
      final String source = _read('android/app/src/main/kotlin/${namespace.replaceAll('.', '/')}/MainActivity.kt');
      expect(source, contains('package $namespace'));
      expect(source, contains('class MainActivity : FlutterFragmentActivity()'));
    });

    test('the launch and the normal theme, in every values folder (night included), descend from an AppCompat theme', () {
      final List<File> files = _styleFiles;
      expect(files.length, greaterThanOrEqualTo(2), reason: 'values and values-night');
      for (final File file in files) {
        final String xml = file.readAsStringSync();
        for (final String name in <String>['LaunchTheme', 'NormalTheme']) {
          final RegExpMatch? style = RegExp('<style name="$name" parent="([^"]+)"').firstMatch(xml);
          expect(style, isNotNull, reason: '${file.path} defines $name');
          expect(style!.group(1), startsWith('Theme.AppCompat'), reason: '${file.path} $name: the prompt on Android 8 and below needs an AppCompat theme');
          expect(style.group(1), isNot(startsWith('@android:')), reason: '${file.path} $name');
        }
      }
    });

    test('the AppCompat library the themes name is a direct dependency of the app, not only a transitive one', () {
      expect(_gradle, matches(RegExp(r'dependencies\s*\{[^}]*implementation\("androidx\.appcompat:appcompat:[0-9.]+"\)', dotAll: true)));
    });
  });

  group('AC-ST-MOB-041-5 the scripts, flows and documents name the application the way the build does', () {
    test('the activity that a script starts is written with its package: applicationId and namespace differ, so ".MainActivity" would resolve against the wrong one', () {
      final String applicationId = _gradleValue('applicationId');
      final String namespace = _gradleValue('namespace');
      expect(applicationId, isNot(namespace), reason: 'if they were the same the shorthand would be harmless; this test then needs no more than the first group');
      final String activity = '$namespace.MainActivity';
      expect(File('android/app/src/main/kotlin/${namespace.replaceAll('.', '/')}/MainActivity.kt').existsSync(), isTrue);

      final List<File> sources = <File>[
        ..._files('qa', <String>['.sh', '.yaml', '.md']),
        ..._files('tool', <String>['.dart', '.sh']),
        ..._files('../../docs', <String>['.md']).where((File f) => f.uri.pathSegments.last.startsWith('mob')),
      ];
      // `am start -n <package>/<activity>` and `-n <package>/<activity>` of any other adb call.
      final RegExp component = RegExp(r'(?:am\s+start(?:-activity)?|monkey)[^\n]*?-n\s+("?)([^\s"]+)\1');
      int found = 0;
      for (final File file in sources) {
        final String text = file.readAsStringSync();
        // a script keeps the pieces in shell variables: they are read from the same file
        String resolve(String value) => value.replaceAllMapped(RegExp(r'\$\{?(\w+)\}?'), (Match v) => RegExp('^${v.group(1)}="([^"]*)"', multiLine: true).firstMatch(text)?.group(1) ?? v.group(0)!);
        for (final RegExpMatch m in component.allMatches(text)) {
          found++;
          final String target = resolve(m.group(2)!);
          expect(target, '$applicationId/$activity', reason: '${file.path}: $target');
        }
      }
      expect(found, greaterThan(0), reason: 'the cold-start script starts the application with am start -n');
    });

    test('the package the scripts and the Maestro flows address is the applicationId', () {
      final String applicationId = _gradleValue('applicationId');
      for (final File file in _files('qa', <String>['.yaml'])) {
        final RegExpMatch? app = RegExp(r'^appId:\s*(\S+)', multiLine: true).firstMatch(file.readAsStringSync());
        if (app != null) expect(app.group(1), applicationId, reason: file.path);
      }
      final RegExpMatch script = RegExp(r'^package="([^"]+)"', multiLine: true).firstMatch(_read('qa/device/scripts/run_cold_start_samples.sh'))!;
      expect(script.group(1), applicationId);
    });
  });
}
