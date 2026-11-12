import 'dart:convert';
import 'dart:io';

/// One rule of the design (R38): a pattern a screen of `lib/features` or `lib/editions` must not use, because the shared widgets, the theme
/// and `lib/core/format` own it. `lib/core` (the widgets, the theme, the format) is where these are allowed.
class DesignRule {
  const DesignRule(this.id, this.pattern, this.use);

  final String id;
  final RegExp pattern;

  /// What a screen uses instead.
  final String use;
}

final List<DesignRule> kDesignRules = <DesignRule>[
  DesignRule('TextStyle(', RegExp(r'(?<![A-Za-z0-9_])TextStyle\('), 'the text of the theme: context.v2text or Theme.of(context).textTheme'),
  DesignRule('Color(', RegExp(r'(?<![A-Za-z0-9_])Color\('), 'a colour of the theme: context.v2 or the semantic extension'),
  DesignRule('Colors.', RegExp(r'(?<![A-Za-z0-9_])Colors\.'), 'a colour of the theme: context.v2 or the semantic extension'),
  DesignRule('MachvonColors.', RegExp(r'\bMachvonColors\.'), 'a colour of the theme: context.v2 (a light-only token is unreadable in the dark mode)'),
  DesignRule('fontSize:', RegExp(r'\bfontSize:'), 'a step of the type scale: context.v2text'),
  DesignRule('BoxDecoration(', RegExp(r'\bBoxDecoration\('), 'a shared widget: WorkRow, StatStrip, InfoRow, StateView'),
  DesignRule('Card(', RegExp(r'(?<![A-Za-z0-9_])Card\('), 'a shared widget: a list is rows, a card is a StatCell or a sheet'),
  DesignRule('AppBar(', RegExp(r'(?<![A-Za-z0-9_])AppBar\('), 'AppScaffold with AppTopBar'),
  DesignRule('Scaffold(', RegExp(r'(?<![A-Za-z0-9_])Scaffold\('), 'AppScaffold'),
  DesignRule('NumberFormat', RegExp(r'\b(NumberFormat|DateFormat)\b'), 'lib/core/format: moneyLabel, formatDay, formatMoment'),
  DesignRule('EdgeInsets-number', RegExp(r'EdgeInsets\.(all|symmetric|only|fromLTRB)\([^)]*\b\d'), 'a spacing step: MachvonV2Space or MachvonSpace'),
  DesignRule('toStringAsFixed(', RegExp(r'\.toStringAsFixed\('), 'lib/core/format: moneyParts, formatPercent, formatBytes'),
];

/// The directories whose files are held to the rules; `lib/core` is where the rules are kept, so it is left out.
const List<String> kScannedRoots = <String>['lib/features', 'lib/editions'];

final RegExp _lineComment = RegExp(r'(?<!:)//.*$');

/// [source] without the text of its `//` comments (a URL in a string, `https://`, is kept), so a rule named in a doc comment is not a use.
String stripComments(String source) => source.split('\n').map((String line) => line.replaceFirst(_lineComment, '')).join('\n');

/// How many times each rule is broken by [source]; rules that are not broken are left out.
Map<String, int> scanSource(String source) {
  final String code = stripComments(source);
  final Map<String, int> counts = <String, int>{};
  for (final DesignRule rule in kDesignRules) {
    final int found = rule.pattern.allMatches(code).length;
    if (found > 0) counts[rule.id] = found;
  }
  return counts;
}

/// The violations of every Dart file under [roots], by path (forward slashes, relative to the application directory).
Map<String, Map<String, int>> scanTree({String base = '.', List<String> roots = kScannedRoots}) {
  final Map<String, Map<String, int>> result = <String, Map<String, int>>{};
  for (final String root in roots) {
    final Directory directory = Directory('$base/$root');
    if (!directory.existsSync()) continue;
    for (final FileSystemEntity entity in directory.listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      final Map<String, int> counts = scanSource(entity.readAsStringSync());
      if (counts.isEmpty) continue;
      final String relative = entity.path.replaceAll('\\', '/').substring(entity.path.replaceAll('\\', '/').indexOf(root));
      result[relative] = counts;
    }
  }
  return result;
}

const String kBaselinePath = 'test/static/design_rules_baseline.json';

/// The allow-list: for each file, the violations it is allowed to still have. It only shrinks (see `design_rules_test.dart`).
Map<String, Map<String, int>> readBaseline({String base = '.'}) {
  final Object? decoded = jsonDecode(File('$base/$kBaselinePath').readAsStringSync());
  final Map<String, Object?> files = (decoded! as Map<String, Object?>)['files']! as Map<String, Object?>;
  return <String, Map<String, int>>{
    for (final MapEntry<String, Object?> entry in files.entries)
      entry.key: <String, int>{for (final MapEntry<String, Object?> rule in (entry.value! as Map<String, Object?>).entries) rule.key: rule.value! as int},
  };
}

/// The text of a baseline for [files]: sorted, two spaces, a total per rule on top.
String renderBaseline(Map<String, Map<String, int>> files) {
  final Map<String, int> totals = <String, int>{};
  for (final Map<String, int> counts in files.values) {
    counts.forEach((String rule, int count) => totals[rule] = (totals[rule] ?? 0) + count);
  }
  final List<String> paths = files.keys.toList()..sort();
  final Map<String, Object?> document = <String, Object?>{
    'note': 'The allow-list of the design rules (R38): today\'s violations in lib/features and lib/editions, per file. It only shrinks: a file that gets cleaner is lowered here (dart run tool/design_rules_baseline.dart), and a new violation is not added here, it is fixed with a shared widget. MUX-3 wave D ends at an empty list and deletes this file.',
    'totals': <String, int>{for (final String rule in (totals.keys.toList()..sort())) rule: totals[rule]!},
    'files': <String, Object?>{
      for (final String path in paths) path: <String, int>{for (final String rule in (files[path]!.keys.toList()..sort())) rule: files[path]![rule]!},
    },
  };
  return '${const JsonEncoder.withIndent('  ').convert(document)}\n';
}
