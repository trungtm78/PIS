import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/edition/edition.dart';
import 'package:machvon_mobile/core/l10n/core_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/dashboard/dashboard_strings.dart';
import 'package:machvon_mobile/features/directives/directives_strings.dart';
import 'package:machvon_mobile/features/registry.generated.dart';

import '../features/dashboard/dashboard_fixtures.dart';
import '../features/dashboard/home_parity_fixtures.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';

/// The phone acceptance matrix of the leader home (plan eng-review R20): the same sections, in both languages, in each edition. The public edition and the
/// enterprise edition share one code line, and the terminology overlay of an edition only renames the product; the sections the web leader home has (the "i"
/// of a figure, what changed since last week, the colours with their reasons, the steering directives) must be there, with the same words, in both.
///
/// A row of the matrix is a section: the words that say it in each language. The test files of the two editions call [defineHomeParityMatrix] with the
/// profile of their edition (the one that names the enterprise folder is `home_parity_matrix_enterprise_test.dart`, as the edition check requires).
class MatrixRow {
  const MatrixRow({required this.section, required this.vi, required this.en});

  final String section;
  final Finder vi;
  final Finder en;
}

final List<MatrixRow> kHomeParityRows = <MatrixRow>[
  MatrixRow(section: 'the "i" of a figure (G0-4)', vi: find.byTooltip('Công thức và nguồn của Tỷ lệ giải ngân theo kế hoạch Thủ tướng giao').first, en: find.byTooltip('Formula and source of Tỷ lệ giải ngân theo kế hoạch Thủ tướng giao').first),
  MatrixRow(section: 'what changed since last week (G3-4)', vi: find.text('Thay đổi từ tuần trước'), en: find.text('What changed since last week')),
  MatrixRow(section: 'the colours of the units with the reason (G3-2)', vi: find.text('Màu xanh vàng đỏ của các đơn vị'), en: find.text('Colours of the units')),
  MatrixRow(section: 'why a unit is red (G3-2)', vi: find.text('Vì sao'), en: find.text('Why')),
  MatrixRow(section: 'the steering directives (DIR-1)', vi: find.text('Chỉ đạo giao ban'), en: find.text('Steering directives')),
  MatrixRow(section: 'the oldest overdue directives (DIR-1)', vi: find.text('Chỉ đạo quá hạn lâu nhất'), en: find.text('Oldest overdue directives')),
];

/// The tables whose new keys the matrix holds equal in every edition: the core (the sheet of a definition), the home and the directives.
final Map<String, StringTable> _owners = <String, StringTable>{'mob.info.figure.': kCoreStrings, 'mob.home.': dashboardStrings, 'mob.dir.widget.': directivesStrings};

/// The keys this matrix covers: the sheet of a definition, the colours, the changes and the flags of the home, and the widget of the directives.
bool isHomeParityKey(String key) =>
    key.startsWith('mob.info.figure.') || key.startsWith('mob.home.rag.') || key.startsWith('mob.home.changes.') || key.startsWith('mob.home.flag.') || key.startsWith('mob.dir.widget.');

/// The real features, as the enterprise overlay may only replace keys the features declare; the support feature is added by the harness that serves the pages.
final List<MobileFeature> _features = <MobileFeature>[for (final MobileFeature feature in kAllFeatures) if (feature.id != 'read_support') feature];

void defineHomeParityMatrix(EditionProfile profile, {List<Override> overrides = const <Override>[]}) {
  group('R20 the phone acceptance matrix of the leader home, ${profile.edition.name} edition', () {
    for (final String language in <String>['vi', 'en']) {
      testWidgets('$language: every section of the web leader home is on the phone', (WidgetTester tester) async {
        useDevice(tester, const Size(390, 9000));
        final ScriptedServer server = ScriptedServer()
          ..on('GET', '/home/command-center', (_) => commandCenterWithDefinitions())
          ..on('GET', '/home/my-work', (_) => alertWork(<Map<String, Object?>>[]))
          ..on('GET', '/home/rag', (_) => ragReading())
          ..on('GET', '/home/changes', (_) => homeChanges())
          ..on('GET', '/directives/widget', (_) => directiveWidget());
        await pumpWithServer(
          tester,
          features: _features,
          server: server,
          location: '/home',
          locale: Locale(language),
          overrides: <Override>[editionProfileProvider.overrideWithValue(profile), ...overrides],
        );

        expect(tester.widget<Title>(find.byType(Title)).title, profile.appTitle, reason: 'the application is titled for its edition');
        for (final MatrixRow row in kHomeParityRows) {
          expect(language == 'vi' ? row.vi : row.en, findsOneWidget, reason: '${profile.edition.name}/$language: ${row.section}');
        }
        // The added parts cost one request each, and none is made twice.
        for (final String path in <String>['/home/command-center', '/home/rag', '/home/changes', '/directives/widget']) {
          expect(server.callsTo('GET', path), hasLength(1), reason: path);
        }
      });

      testWidgets('$language: the edition renames the product and nothing of these sections', (WidgetTester tester) async {
        useDevice(tester, kDeviceSizes[1]);
        final ProviderContainer container = await pumpApp(
          tester,
          features: kAllFeatures,
          locale: Locale(language),
          overrides: <Override>[editionProfileProvider.overrideWithValue(profile), ...overrides],
        );
        final StringCatalogue catalogue = container.read(stringCatalogueProvider);
        int checked = 0;
        for (final MapEntry<String, StringTable> owner in _owners.entries) {
          final Map<String, String> base = language == 'vi' ? owner.value.vi : owner.value.en;
          for (final MapEntry<String, String> entry in base.entries) {
            if (!entry.key.startsWith(owner.key) || !isHomeParityKey(entry.key)) continue;
            expect(catalogue.lookup(language, entry.key), entry.value, reason: '${profile.edition.name}/$language: ${entry.key}');
            checked += 1;
          }
        }
        expect(checked, greaterThanOrEqualTo(90), reason: 'the matrix reads every new key');
      });
    }
  });
}
