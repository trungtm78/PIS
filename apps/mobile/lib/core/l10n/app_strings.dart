import 'package:flutter/foundation.dart' show SynchronousFuture;
import 'package:flutter/widgets.dart';

import 'string_table.dart';

final RegExp _placeholder = RegExp(r'\{([a-zA-Z0-9]+)\}');

/// The strings of the application in the language of the current locale.
///
/// Keys are written out as literals at the call site (`context.t('mob.states.retry.action')`), so a test can read
/// every key in use and check it exists in both languages; a key built from parts is not allowed. A placeholder is
/// written `{name}` in the text and passed in the second argument.
final class AppStrings {
  const AppStrings(this.language, this.catalogue);

  final String language;
  final StringCatalogue catalogue;

  /// The text of [key]. A key that is not declared is returned as it is, so the gap is visible instead of blank.
  String t(String key, [Map<String, Object> values = const <String, Object>{}]) {
    final String text = catalogue.lookup(language, key) ?? key;
    if (values.isEmpty) return text;
    return text.replaceAllMapped(_placeholder, (Match match) {
      final Object? value = values[match.group(1)];
      return value == null ? match.group(0)! : value.toString();
    });
  }

  static AppStrings of(BuildContext context) {
    final AppStrings? strings = Localizations.of<AppStrings>(context, AppStrings);
    assert(strings != null, 'AppStringsDelegate is not installed above this context');
    return strings!;
  }
}

/// `context.t(key)` for every widget.
extension AppStringsContext on BuildContext {
  String t(String key, [Map<String, Object> values = const <String, Object>{}]) => AppStrings.of(this).t(key, values);
}

/// Loads [AppStrings] for the supported languages.
final class AppStringsDelegate extends LocalizationsDelegate<AppStrings> {
  const AppStringsDelegate(this.catalogue);

  final StringCatalogue catalogue;

  @override
  bool isSupported(Locale locale) => kSupportedLanguages.contains(locale.languageCode);

  @override
  Future<AppStrings> load(Locale locale) => SynchronousFuture<AppStrings>(AppStrings(locale.languageCode, catalogue));

  @override
  bool shouldReload(AppStringsDelegate old) => old.catalogue != catalogue;
}
