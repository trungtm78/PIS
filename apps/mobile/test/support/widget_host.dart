import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:machvon_mobile/core/l10n/app_strings.dart';
import 'package:machvon_mobile/core/l10n/core_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/theme/app_theme.dart';

/// Hosts one widget the way the application does (theme, both languages, strings of the core) without a router, for the
/// tests of the shared widgets.
Widget hostWidget(Widget child, {Locale locale = const Locale('vi'), List<StringTable> tables = const <StringTable>[]}) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: buildAppTheme(),
    locale: locale,
    supportedLocales: const <Locale>[Locale('vi'), Locale('en')],
    localizationsDelegates: <LocalizationsDelegate<Object?>>[
      AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings, ...tables])),
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: Scaffold(body: child),
  );
}
