import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/edition/edition.dart';
import 'package:machvon_mobile/core/edition/edition_brand.g.dart';
import 'package:machvon_mobile/core/l10n/app_strings.dart';
import 'package:machvon_mobile/core/l10n/core_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/theme/app_theme.dart';
import 'package:machvon_mobile/core/widgets/brand_logo.dart';
import 'package:machvon_mobile/features/session/session_strings.dart';

/// The public edition shows no code name: the generated names (the launcher name, the logo label, the tagline) and the sign-in head say the product alone.
final RegExp _codeName = RegExp('MACHVON|Mạch Vốn|Mạch vốn|Mach Von', caseSensitive: false);

void main() {
  group('the names of the public edition (generated from its manifest)', () {
    test('name the product by its public name and carry no code name', () {
      const List<String> names = <String>[
        kPublicProductNameVi,
        kPublicProductNameEn,
        kPublicLauncherNameVi,
        kPublicLauncherNameEn,
        kPublicShortNameVi,
        kPublicShortNameEn,
        kPublicLogoAltVi,
        kPublicLogoAltEn,
        kPublicTaglineVi,
        kPublicTaglineEn,
      ];
      for (final String name in names) {
        expect(name.trim(), isNotEmpty);
        expect(_codeName.hasMatch(name), isFalse, reason: name);
      }
      expect(kPublicProductNameVi, 'Hệ thống quản lý đầu tư công');
      expect(kPublicProductNameEn, 'Public Investment Management System');
      expect(kPublicLauncherNameVi, 'Đầu tư công');
      expect(kPublicLauncherNameEn, 'Public Investment');
      expect(kPublicEditionProfile.appTitle, kPublicProductNameVi);
    });

    test('are what the sign-in strings say in both languages, with no code name in any string of the table', () {
      expect(sessionStrings.vi['mob.signIn.logo.label'], kPublicLogoAltVi);
      expect(sessionStrings.en['mob.signIn.logo.label'], kPublicLogoAltEn);
      expect(sessionStrings.vi['mob.signIn.tagline.public.text'], kPublicTaglineVi);
      expect(sessionStrings.en['mob.signIn.tagline.public.text'], kPublicTaglineEn);
      for (final Map<String, String> language in <Map<String, String>>[sessionStrings.vi, sessionStrings.en]) {
        for (final MapEntry<String, String> entry in language.entries) {
          expect(_codeName.hasMatch(entry.value), isFalse, reason: entry.key);
        }
      }
    });
  });

  group('the head of the sign-in screens in the public edition', () {
    Future<void> pump(WidgetTester tester, Locale locale) async {
      final ProviderContainer container = ProviderContainer(overrides: <Override>[editionProfileProvider.overrideWithValue(kPublicEditionProfile)]);
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: buildAppTheme(),
            locale: locale,
            supportedLocales: const <Locale>[Locale('vi'), Locale('en')],
            localizationsDelegates: <LocalizationsDelegate<Object?>>[
              AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings, sessionStrings])),
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            home: const Scaffold(body: BrandHeader()),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('names the logo and shows the tagline in Vietnamese, with no code name', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pump(tester, const Locale('vi'));
      expect(find.bySemanticsLabel(kPublicLogoAltVi), findsOneWidget);
      expect(find.text(kPublicTaglineVi), findsOneWidget);
      expect(find.textContaining(_codeName), findsNothing);
      semantics.dispose();
    });

    testWidgets('names the logo and shows the tagline in English, with no code name', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pump(tester, const Locale('en'));
      expect(find.bySemanticsLabel(kPublicLogoAltEn), findsOneWidget);
      expect(find.text(kPublicTaglineEn), findsOneWidget);
      expect(find.textContaining(_codeName), findsNothing);
      semantics.dispose();
    });
  });
}
