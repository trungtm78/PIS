import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/di/providers.dart';
import '../core/l10n/app_strings.dart';
import '../core/l10n/string_table.dart';
import '../core/theme/app_theme.dart';
import 'session_services.dart';

/// The application: Material app on the router, the theme of the tokens (and the tenant) in the light and the dark mode, the two languages.
///
/// The text scale of the device is honoured as it is (no clamp): every shared widget scrolls, and the tests run the shell
/// and the states at 200 percent (NFR-ACCESSIBILITY-02).
class MachvonApp extends ConsumerWidget {
  const MachvonApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      onGenerateTitle: (BuildContext context) => ref.read(editionProfileProvider).appTitle,
      debugShowCheckedModeBanner: false,
      theme: ref.watch(appThemeProvider),
      darkTheme: ref.watch(darkAppThemeProvider),
      themeMode: ref.watch(themeModeProvider),
      routerConfig: ref.watch(routerProvider),
      locale: ref.watch(localeProvider),
      supportedLocales: <Locale>[for (final String language in kSupportedLanguages) Locale(language)],
      localeResolutionCallback: _resolveLocale,
      builder: (BuildContext context, Widget? child) => SessionServices(child: child ?? const SizedBox.shrink()),
      localizationsDelegates: <LocalizationsDelegate<Object?>>[
        AppStringsDelegate(ref.watch(stringCatalogueProvider)),
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
    );
  }

  Locale _resolveLocale(Locale? device, Iterable<Locale> supported) {
    for (final Locale locale in supported) {
      if (locale.languageCode == device?.languageCode) return locale;
    }
    return const Locale(kFallbackLanguage);
  }
}
