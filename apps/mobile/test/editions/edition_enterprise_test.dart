import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/edition_seam.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/edition/edition.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/editions/enterprise/enterprise_profile.dart';
import 'package:machvon_mobile/editions/enterprise/enterprise_strings.dart';
import 'package:machvon_mobile/features/registry.generated.dart';

import '../support/harness.dart';

// This test names the enterprise folder, so its name ends in `enterprise_test.dart`: the edition check lets only such tests, the seam and the folder itself do so.
final RegExp _placeholder = RegExp(r'\{([a-zA-Z0-9]+)\}');

List<String> _placeholders(String text) =>
    _placeholder.allMatches(text).map((Match match) => match.group(1)!).toList()
      ..sort();

void main() {
  group('ENT-0 the enterprise edition on the phone (R20)', () {
    test('its profile is the enterprise edition, titled with the enterprise product name', () {
      expect(kEnterpriseEditionProfile.edition, Edition.enterprise);
      expect(
        kEnterpriseEditionProfile.appTitle,
        'Phần mềm quản lý đầu tư xây dựng',
      );
      expect(kEnterpriseEditionProfile.appTitle, kEnterpriseProductNameVi);
      expect(
        kEnterpriseEditionProfile.appTitle,
        isNot(kPublicEditionProfile.appTitle),
      );
      expect(kEnterpriseEditionProfile.overlay, same(kEnterpriseStrings));
    });

    test('the seam hands it over when a build carries it', () {
      expect(
        editionProfileFor(
          Edition.enterprise,
          enterprise: kEnterpriseEditionProfile,
        ),
        same(kEnterpriseEditionProfile),
      );
    });

    test('the overlay holds the same keys in both languages, each with the placeholders of the base and a text', () {
      expect(
        kEnterpriseStrings.vi.keys.toSet(),
        kEnterpriseStrings.en.keys.toSet(),
      );
      final ProviderContainer container = ProviderContainer(
        overrides: <Override>[appConfigProvider.overrideWithValue(testConfig)],
      );
      addTearDown(container.dispose);
      final StringCatalogue base = container.read(stringCatalogueProvider);
      for (final String key in kEnterpriseStrings.vi.keys) {
        expect(
          base.lookup('vi', key),
          isNotNull,
          reason: 'the base declares $key (vi)',
        );
        expect(
          base.lookup('en', key),
          isNotNull,
          reason: 'the base declares $key (en)',
        );
        expect(
          _placeholders(kEnterpriseStrings.vi[key]!),
          _placeholders(base.lookup('vi', key)!),
          reason: key,
        );
        expect(
          _placeholders(kEnterpriseStrings.en[key]!),
          _placeholders(base.lookup('en', key)!),
          reason: key,
        );
        expect(kEnterpriseStrings.vi[key]!.trim(), isNotEmpty);
        expect(kEnterpriseStrings.en[key]!.trim(), isNotEmpty);
        expect(
          kEnterpriseStrings.vi[key],
          isNot(base.lookup('vi', key)),
          reason: '$key must say something else than the public text',
        );
      }
    });

    test('the overlay says the enterprise name where the public strings say the public one', () {
      final StringCatalogue catalogue = StringCatalogue(
        <StringTable>[
          const StringTable(
            vi: <String, String>{
              'mob.welcome.title.text':
                  'Chào mừng đến Hệ thống quản lý đầu tư công',
            },
            en: <String, String>{
              'mob.welcome.title.text':
                  'Welcome to the Public Investment Management System',
            },
          ),
        ],
        overlay: const StringTable(
          vi: <String, String>{
            'mob.welcome.title.text':
                'Chào mừng đến Phần mềm quản lý đầu tư xây dựng',
          },
          en: <String, String>{
            'mob.welcome.title.text':
                'Welcome to the Construction Investment Management Software',
          },
        ),
      );
      expect(
        catalogue.lookup('vi', 'mob.welcome.title.text'),
        contains('Phần mềm quản lý đầu tư xây dựng'),
      );
      expect(
        catalogue.lookup('en', 'mob.welcome.title.text'),
        contains('Construction Investment Management Software'),
      );
    });

    testWidgets(
      'the application is titled with the enterprise name and speaks with the overlay, in both languages',
      (WidgetTester tester) async {
        // The real features: the overlay may only replace keys the base declares, and the features declare most of them.
        final ProviderContainer container = await pumpApp(
          tester,
          features: kAllFeatures,
          overrides: <Override>[
            editionProfileProvider.overrideWithValue(kEnterpriseEditionProfile),
          ],
        );
        expect(
          tester.widget<Title>(find.byType(Title)).title,
          'Phần mềm quản lý đầu tư xây dựng',
        );
        final StringCatalogue catalogue = container.read(
          stringCatalogueProvider,
        );
        expect(
          catalogue.lookup('vi', 'mob.welcome.title.text'),
          'Chào mừng đến Phần mềm quản lý đầu tư xây dựng',
        );
        expect(
          catalogue.lookup('en', 'mob.welcome.title.text'),
          'Welcome to the Construction Investment Management Software',
        );
        // A key the overlay does not hold is the base text.
        expect(catalogue.lookup('vi', 'mob.shell.tab.home'), 'Trang chủ');
      },
    );

    testWidgets(
      'the leader home and the project list say closed figures, not the Treasury, and the public edition keeps its words',
      (WidgetTester tester) async {
        const List<String> keys = <String>[
          'mob.home.context.cutoff.label',
          'mob.home.tile.metric.disbursed',
          'mob.home.tile.metric.planPm',
          'mob.home.tile.metric.ratePm',
          'mob.home.tile.nullReason.treasuryNone',
          'mob.alert.source.treasuryRecon.label',
          'mob.prj.list.work.treasury',
        ];
        final ProviderContainer enterprise = await pumpApp(
          tester,
          features: kAllFeatures,
          overrides: <Override>[
            editionProfileProvider.overrideWithValue(kEnterpriseEditionProfile),
          ],
        );
        final StringCatalogue overlaid = enterprise.read(stringCatalogueProvider);
        for (final String key in keys) {
          final String text = overlaid.lookup('vi', key)!;
          expect(text, isNot(contains('Kho bạc')), reason: key);
          expect(text, isNot(contains('Thủ tướng')), reason: key);
        }
        expect(overlaid.lookup('vi', 'mob.home.tile.metric.disbursed'), 'Giải ngân lũy kế');
        expect(overlaid.lookup('vi', 'mob.home.context.cutoff.label'), 'Số liệu chốt đến ngày');
        final ProviderContainer base = ProviderContainer(
          overrides: <Override>[appConfigProvider.overrideWithValue(testConfig)],
        );
        addTearDown(base.dispose);
        final StringCatalogue plain = base.read(stringCatalogueProvider);
        expect(plain.lookup('vi', 'mob.home.context.cutoff.label'), 'Kho bạc chốt đến ngày');
        expect(plain.lookup('vi', 'mob.home.tile.metric.disbursed'), 'Giải ngân lũy kế theo Kho bạc');
        expect(plain.lookup('vi', 'mob.prj.list.work.treasury'), 'Đối soát Kho bạc');
      },
    );
  });
}
