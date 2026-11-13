import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'design_rules_scan.dart';

Iterable<File> _dartFiles(String root) => Directory(root).listSync(recursive: true).whereType<File>().where((File file) => file.path.endsWith('.dart'));

String _relative(File file) => file.path.replaceAll('\\', '/').substring(file.path.replaceAll('\\', '/').indexOf('lib/'));

void main() {
  // UAT 2026-11-13 (emulator, MOB-02 to 04 and the cold start): `Semantics(header: true)` without a node of its own merges its flag and its text
  // into the nearest node above it (a child of a list is one), together with the texts next to it. The chooser was announced as one heading
  // "Chọn đơn vị và vai trò\nBạn có thể làm việc ở nhiều đơn vị...", and the heading of the alerts of the home was never a text of its own.
  test('every heading annotation of the application is a semantics node of its own (container: true), so it never swallows the text next to it', () {
    final List<String> found = <String>[];
    for (final File file in _dartFiles('lib')) {
      final String code = stripComments(file.readAsStringSync());
      for (final Match header in RegExp(r'header:\s*true').allMatches(code)) {
        // The arguments of that Semantics: from its name to its child.
        final int open = code.lastIndexOf('Semantics(', header.start);
        final int child = code.indexOf('child:', header.end);
        if (open < 0 || child < 0 || !code.substring(open, child).contains('container: true')) {
          found.add('${_relative(file)} at offset ${header.start}');
        }
      }
    }
    expect(found, isEmpty, reason: 'a heading without container: true merges into its parent node');
  });
}
