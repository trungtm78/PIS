import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/app/edition_seam.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/edition/edition.dart';
import 'package:machvon_mobile/core/l10n/core_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';

import '../support/harness.dart';

const bool _enterpriseBuild =
    String.fromEnvironment('MACHVON_EDITION') == 'enterprise';

void main() {
  group('ENT-0 the edition switch of the phone', () {
    test('nothing set, or blank, is the public edition', () {
      expect(parseEdition(''), Edition.public);
      expect(parseEdition('   '), Edition.public);
      expect(parseEdition('public'), Edition.public);
    });

    test('enterprise is read, trimmed', () {
      expect(parseEdition('enterprise'), Edition.enterprise);
      expect(parseEdition(' enterprise '), Edition.enterprise);
    });

    test('a value that is not an edition fails at start, naming the variable and not the value', () {
      for (final String raw in <String>[
        'Enterprise',
        'PUBLIC',
        'ent',
        'both',
        '1',
        'public,enterprise',
      ]) {
        expect(
          () => parseEdition(raw),
          throwsA(
            isA<FormatException>().having(
              (FormatException error) => error.message,
              'message',
              'MACHVON_EDITION must be one of public, enterprise',
            ),
          ),
          reason: raw,
        );
      }
    });

    test('the configuration carries the edition, public by default, and the default build define is public', () {
      expect(
        AppConfig.parse(
          'https://api.test/v1',
          allowInsecureLoopback: false,
        ).edition,
        Edition.public,
      );
      expect(
        AppConfig.parse(
          'https://api.test/v1',
          allowInsecureLoopback: false,
          edition: Edition.enterprise,
        ).edition,
        Edition.enterprise,
      );
      expect(
        AppConfig(apiBaseUrl: Uri.parse('https://api.test/v1')).edition,
        Edition.public,
      );
    });

    test('the public profile is the name the application always had, with no overlay', () {
      expect(kPublicEditionProfile.edition, Edition.public);
      expect(kPublicEditionProfile.appTitle, 'Hệ thống quản lý đầu tư công');
      expect(kPublicEditionProfile.overlay, isNull);
    });

    test('the seam follows the build: the enterprise profile only in an enterprise build, and public always', () {
      expect(editionProfileFor(Edition.public), same(kPublicEditionProfile));
      if (_enterpriseBuild) {
        // `flutter test --dart-define=MACHVON_EDITION=enterprise`: this build carries the enterprise profile.
        expect(kBuildEnterpriseProfile, isNotNull);
        expect(
          editionProfileFor(Edition.enterprise).edition,
          Edition.enterprise,
        );
      } else {
        // A public build carries no enterprise profile, so asking for one fails, naming the edition.
        expect(kBuildEnterpriseProfile, isNull);
        expect(
          () => editionProfileFor(Edition.enterprise),
          throwsA(
            isA<StateError>().having(
              (StateError error) => error.message,
              'message',
              contains('enterprise'),
            ),
          ),
        );
      }
    });

    test(
      'the configuration read from the build defines names the edition of the build',
      () {
        const Edition expected = _enterpriseBuild
            ? Edition.enterprise
            : Edition.public;
        expect(AppConfig.fromEnvironment().edition, expected);
      },
      // Needs `--dart-define=MACHVON_API_BASE_URL=https://api.test/v1` as well; the matrix of the CI passes both.
      skip: const String.fromEnvironment('MACHVON_API_BASE_URL').isEmpty
          ? 'run with --dart-define=MACHVON_API_BASE_URL'
          : false,
    );

    test('the seam gives the enterprise profile a build brings, and the public one regardless', () {
      const EditionProfile brought = EditionProfile(
        edition: Edition.enterprise,
        appTitle: 'Sản phẩm thử',
      );
      expect(
        editionProfileFor(Edition.enterprise, enterprise: brought),
        same(brought),
      );
      expect(
        editionProfileFor(Edition.public, enterprise: brought),
        same(kPublicEditionProfile),
      );
    });
  });

  group('ENT-0 the terminology overlay of the strings', () {
    const StringTable base = StringTable(
      vi: <String, String>{'mob.a.b.c': 'Một', 'mob.a.b.d': 'Hai {x}'},
      en: <String, String>{'mob.a.b.c': 'One', 'mob.a.b.d': 'Two {x}'},
    );

    test('an overlay replaces the texts of its keys in both languages and leaves the others', () {
      final StringCatalogue catalogue = StringCatalogue(
        <StringTable>[base],
        overlay: const StringTable(
          vi: <String, String>{'mob.a.b.c': 'Một khác'},
          en: <String, String>{'mob.a.b.c': 'Another one'},
        ),
      );
      expect(catalogue.lookup('vi', 'mob.a.b.c'), 'Một khác');
      expect(catalogue.lookup('en', 'mob.a.b.c'), 'Another one');
      expect(catalogue.lookup('vi', 'mob.a.b.d'), 'Hai {x}');
      expect(catalogue.lookup('en', 'mob.a.b.d'), 'Two {x}');
    });

    test('the keys of the catalogue are the keys of the base: an overlay adds none', () {
      final StringCatalogue plain = StringCatalogue(<StringTable>[base]);
      final StringCatalogue overlaid = StringCatalogue(
        <StringTable>[base],
        overlay: const StringTable(
          vi: <String, String>{'mob.a.b.c': 'x'},
          en: <String, String>{'mob.a.b.c': 'y'},
        ),
      );
      expect(overlaid.viKeys, plain.viKeys);
      expect(overlaid.enKeys, plain.enKeys);
    });

    test(
      'a key the base does not declare fails at start, in either language',
      () {
        expect(
          () => StringCatalogue(
            <StringTable>[base],
            overlay: const StringTable(
              vi: <String, String>{'mob.a.b.zzz': 'x'},
              en: <String, String>{},
            ),
          ),
          throwsA(
            isA<StateError>().having(
              (StateError error) => error.message,
              'message',
              contains('mob.a.b.zzz'),
            ),
          ),
        );
        expect(
          () => StringCatalogue(
            <StringTable>[base],
            overlay: const StringTable(
              vi: <String, String>{},
              en: <String, String>{'mob.a.b.zzz': 'x'},
            ),
          ),
          throwsStateError,
        );
      },
    );

    test('no overlay, or an empty one, is the catalogue as it was', () {
      final StringCatalogue withNone = StringCatalogue(<StringTable>[
        kCoreStrings,
      ]);
      final StringCatalogue withEmpty = StringCatalogue(
        <StringTable>[kCoreStrings],
        overlay: const StringTable(
          vi: <String, String>{},
          en: <String, String>{},
        ),
      );
      expect(withEmpty.viKeys, withNone.viKeys);
      expect(
        withEmpty.lookup('vi', 'mob.shell.tab.home'),
        withNone.lookup('vi', 'mob.shell.tab.home'),
      );
    });
  });

  group('ENT-0 the public edition runs exactly as before', () {
    testWidgets(
      'the title of the application is the public name, and the strings carry no overlay',
      (WidgetTester tester) async {
        final ProviderContainer container = await pumpApp(tester);
        expect(
          container.read(editionProfileProvider),
          same(kPublicEditionProfile),
        );
        expect(
          tester.widget<Title>(find.byType(Title)).title,
          'Hệ thống quản lý đầu tư công',
        );
        final StringCatalogue catalogue = container.read(
          stringCatalogueProvider,
        );
        expect(catalogue.lookup('vi', 'mob.shell.tab.home'), 'Trang chủ');
        expect(catalogue.lookup('en', 'mob.shell.tab.home'), 'Home');
      },
    );
  });
}
