import 'dart:io';

import '../test/static/design_rules_scan.dart';

/// Rewrites the allow-list of the design rules from the code as it is now: `dart run tool/design_rules_baseline.dart`. Run it after a file
/// got cleaner, so the list shrinks with it. `test/static/design_rules_test.dart` refuses a list that is larger than its ceiling, so this
/// cannot be used to let new violations in.
void main() {
  File(kBaselinePath).writeAsStringSync(renderBaseline(scanTree()));
  stdout.writeln('wrote $kBaselinePath');
}
