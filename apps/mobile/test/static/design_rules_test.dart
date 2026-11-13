import 'package:flutter_test/flutter_test.dart';

import 'design_rules_scan.dart';

/// The ceiling of the allow-list, per rule: what the regenerated baseline holds today (MUX-3). Lower a number when the list gets shorter; never raise
/// one: a screen that needs what a rule forbids gets a shared widget, not an entry in the list. Every rule is at zero but the one use of a bare spacing
/// in the process tree screen; wave D of MUX-3 ends at zero everywhere.
const Map<String, int> kBaselineCeiling = <String, int>{
  'AppBar(': 0,
  'BoxDecoration(': 0,
  'Card(': 0,
  'Colors.': 0,
  'MachvonColors.': 0,
  'EdgeInsets-number': 1,
  'Scaffold(': 0,
  'TextStyle(': 0,
  'fontSize:': 0,
  'toStringAsFixed(': 0,
};

/// The rules for which the allow-list holds more than its ceiling gives, as messages (empty: the list is within the ceiling).
List<String> ceilingBreaches(Map<String, Map<String, int>> allowed, Map<String, int> ceiling) {
  final Map<String, int> totals = <String, int>{};
  for (final Map<String, int> counts in allowed.values) {
    counts.forEach((String rule, int count) => totals[rule] = (totals[rule] ?? 0) + count);
  }
  return <String>[
    for (final MapEntry<String, int> total in totals.entries)
      if (total.value > (ceiling[total.key] ?? 0)) 'the list allows ${total.value} uses of ${total.key}, the ceiling is ${ceiling[total.key] ?? 0}',
  ];
}

String _howToFix(String rule) {
  final DesignRule found = kDesignRules.firstWhere((DesignRule r) => r.id == rule);
  return 'use ${found.use}';
}

void main() {
  group('the scanner of the design rules (R38)', () {
    test('counts each forbidden pattern, nothing inside a comment, and the code after a URL on the same line', () {
      const String source = '''
// TextStyle( in a comment is not a use
/// Scaffold( in a doc comment is not a use either
Widget build() => Scaffold(
  appBar: AppBar(title: Text('x', style: TextStyle(fontSize: 12))),
  body: Card(child: DecoratedBox(decoration: BoxDecoration(color: Color(0xFF000000)))),
);
final pair = ('https://example.org', Card(child: x));
''';
      expect(scanSource(source), <String, int>{
        'TextStyle(': 1,
        'Color(': 1,
        'fontSize:': 1,
        'BoxDecoration(': 1,
        'Card(': 2,
        'AppBar(': 1,
        'Scaffold(': 1,
      });
    });

    test('does not mistake a longer name for a rule: DefaultTextStyle, FooCard, AppScaffold, MachvonV2Colors, BorderColor', () {
      const String source = '''
final a = DefaultTextStyle(child: x);
final b = FooCard(child: y);
final c = AppScaffold(body: z);
final d = MachvonV2Colors.light;
final e = BorderColor(1);
final f = EdgeInsets.all(MachvonSpace.space16);
final g = EdgeInsets.symmetric(horizontal: MachvonV2Space.s16);
''';
      expect(scanSource(source), isEmpty);
    });

    test('a light-only token of the old theme is a violation: it is unreadable in the dark mode', () {
      expect(scanSource('final a = MachvonColors.ink;'), <String, int>{'MachvonColors.': 1});
    });

    test('a spacing written as a bare number is a violation; a token is not', () {
      expect(scanSource('final a = EdgeInsets.all(16);'), <String, int>{'EdgeInsets-number': 1});
      expect(scanSource('final a = EdgeInsets.fromLTRB(MachvonSpace.space16, 4, 0, 0);'), <String, int>{'EdgeInsets-number': 1});
      expect(scanSource('final a = EdgeInsets.only(left: MachvonSpace.space16);'), isEmpty);
    });

    test('money and date formatting is the formatter of lib/core/format, not NumberFormat or a toStringAsFixed', () {
      expect(scanSource("final a = NumberFormat('#,###');"), <String, int>{'NumberFormat': 1});
      expect(scanSource('final a = x.toStringAsFixed(1);'), <String, int>{'toStringAsFixed(': 1});
    });
  });

  group('lib/features and lib/editions keep to the shared widgets, the theme and the one formatter (R38)', () {
    final Map<String, Map<String, int>> now = scanTree();
    final Map<String, Map<String, int>> allowed = readBaseline();

    test('no file has more violations than the allow-list gives it, and no new file has any', () {
      final List<String> grown = <String>[];
      now.forEach((String path, Map<String, int> counts) {
        counts.forEach((String rule, int count) {
          final int limit = allowed[path]?[rule] ?? 0;
          if (count > limit) grown.add('$path: $rule is used $count times, the list allows $limit; ${_howToFix(rule)}');
        });
      });
      expect(grown, isEmpty, reason: 'a screen must not add what the design rules forbid:\n${grown.join('\n')}');
    });

    test('the allow-list is tight: a file that got cleaner is lowered in the list, so the list only shrinks', () {
      final List<String> stale = <String>[];
      allowed.forEach((String path, Map<String, int> limits) {
        limits.forEach((String rule, int limit) {
          final int count = now[path]?[rule] ?? 0;
          if (count < limit) stale.add('$path: $rule is used $count times but the list still allows $limit (run: dart run tool/design_rules_baseline.dart)');
        });
      });
      expect(stale, isEmpty, reason: 'lower the entries that were fixed:\n${stale.join('\n')}');
    });

    test('the allow-list names files that exist and rules that exist', () {
      final Set<String> rules = <String>{for (final DesignRule rule in kDesignRules) rule.id};
      for (final MapEntry<String, Map<String, int>> entry in allowed.entries) {
        expect(now.containsKey(entry.key), isTrue, reason: '${entry.key} is listed but has no violation left or no longer exists: remove it');
        expect(rules.containsAll(entry.value.keys), isTrue, reason: '${entry.key} names an unknown rule');
        expect(entry.value.values.every((int count) => count > 0), isTrue, reason: '${entry.key} lists a zero');
      }
    });

    test('the list is not longer than its ceiling: raising a ceiling is not how a new violation gets in', () {
      expect(ceilingBreaches(allowed, kBaselineCeiling), isEmpty);
      final Set<String> used = <String>{for (final Map<String, int> counts in allowed.values) ...counts.keys};
      expect(kBaselineCeiling.keys.toSet().containsAll(kDesignRules.map((DesignRule rule) => rule.id).where(used.contains)), isTrue);
    });

    test('the ceiling ratchets: every rule is at zero but the one use the baseline holds, so a regenerated baseline with a new violation fails the check', () {
      expect(<String, int>{...kBaselineCeiling}..removeWhere((String rule, int limit) => limit == 0), <String, int>{'EdgeInsets-number': 1});
      final Map<String, int> held = <String, int>{};
      allowed.forEach((String path, Map<String, int> counts) => counts.forEach((String rule, int count) => held[rule] = (held[rule] ?? 0) + count));
      expect(held, <String, int>{'EdgeInsets-number': 1});
      // The baseline tool writes whatever the code holds: a new Card( in a screen, written into the list, is above its ceiling of zero.
      final Map<String, Map<String, int>> regenerated = <String, Map<String, int>>{
        ...allowed,
        'lib/features/example/new_screen.dart': <String, int>{'Card(': 1},
      };
      expect(ceilingBreaches(regenerated, kBaselineCeiling), <String>['the list allows 1 uses of Card(, the ceiling is 0']);
      // A second bare spacing is above the ceiling of one as well.
      final Map<String, Map<String, int>> spacing = <String, Map<String, int>>{
        ...allowed,
        'lib/features/example/other_screen.dart': <String, int>{'EdgeInsets-number': 1},
      };
      expect(ceilingBreaches(spacing, kBaselineCeiling), hasLength(1));
    });

    test('the baseline file is what the tool writes for the code as it is (sorted, with its totals)', () {
      expect(renderBaseline(allowed), contains('"totals"'));
      expect(renderBaseline(now).split('\n').length, greaterThan(10));
    });
  });
}
