/// The two languages of the application.
const List<String> kSupportedLanguages = <String>['vi', 'en'];

/// The language used when the device language is not supported.
const String kFallbackLanguage = 'vi';

// module.screen.action.state: three to five segments, each starting with a letter, the first in lower case.
final RegExp _keyShape = RegExp(r'^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*){2,4}$');

/// Whether a string key follows the convention `module.screen.action.state`.
bool isValidStringKey(String key) => _keyShape.hasMatch(key);

/// The strings of one part of the application in both languages. A feature owns the keys it declares: they start with
/// the module of the feature (`mob.`, `dis.`, ...) and both languages carry exactly the same keys.
final class StringTable {
  const StringTable({required this.vi, required this.en});

  final Map<String, String> vi;
  final Map<String, String> en;
}

/// All string tables of the application merged. A key declared twice is a programming error and fails at start.
final class StringCatalogue {
  StringCatalogue(Iterable<StringTable> tables)
      : _vi = _merge(tables.map((StringTable table) => table.vi)),
        _en = _merge(tables.map((StringTable table) => table.en));

  final Map<String, String> _vi;
  final Map<String, String> _en;

  /// The text of a key in a language, or null when the key is not declared.
  String? lookup(String language, String key) => (language == 'en' ? _en : _vi)[key];

  Set<String> get viKeys => _vi.keys.toSet();
  Set<String> get enKeys => _en.keys.toSet();

  static Map<String, String> _merge(Iterable<Map<String, String>> maps) {
    final Map<String, String> merged = <String, String>{};
    for (final Map<String, String> map in maps) {
      for (final MapEntry<String, String> entry in map.entries) {
        if (merged.containsKey(entry.key)) {
          throw StateError('string key declared twice: ${entry.key}');
        }
        merged[entry.key] = entry.value;
      }
    }
    return merged;
  }
}
