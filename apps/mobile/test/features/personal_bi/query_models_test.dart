import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/personal_bi/charts.dart';
import 'package:machvon_mobile/features/personal_bi/dashboard_models.dart';
import 'package:machvon_mobile/features/personal_bi/query_models.dart';

import 'bi_fixtures.dart';

String _text(Figure figure, {String unit = 'VND', String language = 'vi'}) =>
    figureText(figure, unit: unit, language: language, noData: 'NO_DATA', notApplicable: 'NOT_APPLICABLE', restricted: 'RESTRICTED', notYetReported: 'NOT_YET_REPORTED');

Group _cell(String? value, {String? numerator, String? denominator}) => Group(figure: Figure(value: value, numerator: numerator, denominator: denominator), label: 'Sở Giao thông', unclassified: false, key: 'u-1', drillToken: tokenAUnit);

QueryResult _result({String snapshot = snapA, String? value = '300000000', String aggregation = 'sum', String? numerator, String? denominator}) =>
    parseQueryResult(answer(snapshot: snapshot, aggregation: aggregation, total: figure(value, numerator: numerator, denominator: denominator)))!;

void main() {
  group('AC-ST-MOB-027-1 UAT-AC34 the drill is checked against the cell it started from', () {
    test('the total of the drill is the value of the cell, from the same snapshot: they agree, and an equal decimal is equal whatever its zeros', () {
      expect(drillCheck(cell: _cell('300000000'), from: _result(), drill: _result(value: '300000000')), DrillCheck.agrees);
      expect(drillCheck(cell: _cell('300000000'), from: _result(), drill: _result(value: '300000000.00')), DrillCheck.agrees);
    });

    test('a total that is not the value of the cell is a difference, shown and never hidden', () {
      expect(drillCheck(cell: _cell('300000000'), from: _result(), drill: _result(value: '299999999')), DrillCheck.differs);
    });

    test('a ratio must agree in its numerator and denominator as well as in its value', () {
      final QueryResult from = _result(aggregation: 'ratio', value: '60', numerator: '3', denominator: '5');
      expect(drillCheck(cell: _cell('60', numerator: '3', denominator: '5'), from: from, drill: _result(aggregation: 'ratio', value: '60', numerator: '3', denominator: '5')), DrillCheck.agrees);
      expect(drillCheck(cell: _cell('60', numerator: '3', denominator: '5'), from: from, drill: _result(aggregation: 'ratio', value: '60', numerator: '6', denominator: '10')), DrillCheck.differs);
    });

    test('a drill from another snapshot than the cell is never compared with it', () {
      expect(drillCheck(cell: _cell('300000000'), from: _result(), drill: _result(snapshot: snapB)), DrillCheck.otherSnapshot);
    });

    test('a cell with no figure can only be compared with a total with none', () {
      expect(drillCheck(cell: _cell(null), from: _result(), drill: _result(value: null)), DrillCheck.agrees);
      expect(drillCheck(cell: _cell(null), from: _result(), drill: _result(value: '5')), DrillCheck.notComparable);
      expect(drillCheck(cell: _cell('5'), from: _result(), drill: _result(value: null)), DrillCheck.notComparable);
    });
  });

  group('AC-ST-MOB-027-1 a figure is written exactly, and a figure that is missing is never 0', () {
    test('money is whole dong with the digits of the language, never through a float', () {
      expect(_text(const Figure(value: '480000000')), '480.000.000 ₫');
      expect(_text(const Figure(value: '480000000'), language: 'en'), '480,000,000 ₫');
      expect(_text(const Figure(value: '9007199254740993')), '9.007.199.254.740.993 ₫', reason: 'more digits than a float holds');
    });

    test('a ratio is a percentage with two decimals, rounded half up on the exact decimal', () {
      expect(_text(const Figure(value: '64.125'), unit: 'percent'), '64,13%');
      expect(_text(const Figure(value: '64.124'), unit: 'percent'), '64,12%');
      expect(_text(const Figure(value: '64.125'), unit: 'percent', language: 'en'), '64.13%');
      expect(_text(const Figure(value: '100'), unit: 'percent'), '100,00%');
      expect(_text(const Figure(value: '0.004'), unit: 'percent'), '0,00%');
      expect(_text(const Figure(value: '-12.345'), unit: 'percent'), '-12,35%');
      expect(_text(const Figure(value: '1234.5'), unit: 'percent'), '1.234,50%');
      expect(_text(const Figure(value: 'abc'), unit: 'percent'), 'abc', reason: 'text that is not a number is returned as it came');
    });

    test('a count is a number with the digits of the language', () {
      expect(_text(const Figure(value: '1234567'), unit: 'count'), '1.234.567');
      expect(_text(const Figure(value: '12.5'), unit: 'count', language: 'en'), '12.5');
      expect(_text(const Figure(value: 'x'), unit: 'count'), 'x');
    });

    test('a figure with no value says why it has none', () {
      expect(_text(const Figure()), 'NO_DATA');
      expect(_text(const Figure(nullReason: NullReason.noData)), 'NO_DATA');
      expect(_text(const Figure(nullReason: NullReason.notApplicable), unit: 'percent'), 'NOT_APPLICABLE');
      expect(_text(const Figure(nullReason: NullReason.restricted)), 'RESTRICTED');
      expect(_text(const Figure(nullReason: NullReason.notYetReported)), 'NOT_YET_REPORTED');
    });

    test('a ratio whatever its metric calls its unit is shown as a percentage', () {
      expect(_result(aggregation: 'ratio').shownUnit, 'percent');
      expect(_result().shownUnit, 'VND');
    });
  });

  group('AC-ST-MOB-027-1 an answer is read only as far as the screen can rely on it', () {
    test('an answer without its period, snapshot, badge, token or children is not drawn', () {
      final Map<String, Object?> good = paidAnswer();
      expect(parseQueryResult(good), isNotNull);
      for (final String missing in <String>['as_of_period', 'snapshot_id', 'quality_badge', 'drill_token', 'children', 'total', 'metric']) {
        expect(parseQueryResult(<String, Object?>{...good}..remove(missing)), isNull, reason: missing);
      }
      expect(parseQueryResult(<String, Object?>{...good, 'quality_badge': 'SPLENDID'}), isNull);
      expect(parseQueryResult('text'), isNull);
    });

    test('a group that is not an object makes the answer unusable', () {
      expect(parseQueryResult(<String, Object?>{...paidAnswer(), 'children': <Object?>['x']}), isNull);
    });

    test('the labels every number carries are read: scope, cache, new data, quarantine', () {
      final QueryResult result = parseQueryResult(<String, Object?>{
        ...paidAnswer(newData: true, newer: snapB, cached: true),
        'scope': <String, Object?>{'label': 'FULL_TENANT'},
        'excluded_quarantine_rows': 4,
        'feeds_certified': false,
      })!;
      expect(result.newDataAvailable, isTrue);
      expect(result.newerSnapshotId, snapB);
      expect(result.servedFromCache, isTrue);
      expect(result.yourScope, isFalse);
      expect(result.excludedQuarantineRows, 4);
      expect(result.feedsCertified, isFalse);
      expect(result.children.map((Group g) => g.label), <String>['Sở Giao thông', 'Sở Nông nghiệp', 'Ban QLDA huyện']);
      expect(result.children.last.figure.nullReason, NullReason.noData);
    });

    test('a snapshot is named by the first eight characters of its id', () {
      expect(shortId(snapA), '10a00000');
      expect(shortId('abc'), 'abc');
    });
  });

  group('AC-ST-MOB-027-4 UI-MOB-40 the dashboards and their versions are read as the web reads them', () {
    test('the library lists the reader\'s own dashboards first, then the others, each in the order the server gave', () {
      final DashboardLibrary library = parseDashboardLibrary(<String, Object?>{
        'items': <Object?>[
          dashboardJson(dashShared, title: 'Chung', mine: false, owner: 'Nguyễn Văn An'),
          dashboardJson(dashD1, version: versionD1),
          <String, Object?>{'id': dashEmpty},
        ],
        'next_cursor': 'more',
      })!;
      expect(library.items.map((DashboardSummary d) => d.id), <String>[dashD1, dashShared]);
      expect(library.more, isTrue);
      expect(library.items.last.ownerName, 'Nguyễn Văn An');
      expect(library.items.first.hasVersion, isTrue);
      expect(library.items.last.hasVersion, isFalse);
      expect(parseDashboardLibrary(<String, Object?>{'next_cursor': null}), isNull);
    });

    test('the dashboard points to its current version, whose tiles are laid out top to bottom, left to right', () {
      final DashboardDefinition definition = parseDashboardDefinition(standardDashboard(widgets: <Map<String, Object?>>[
        widgetJson('w-c', 'LINE', metricPaid, dimension: 'unit', y: 8),
        widgetJson('w-a', 'KPI', metricRate),
        widgetJson('w-b', 'PIE', metricPaid, dimension: 'bucket', y: 4),
        <String, Object?>{'id': 'broken', 'kind': 'HOLOGRAM', 'metric_version_id': metricPaid},
      ]))!;
      expect(definition.version!.widgets.map((DashboardWidget w) => w.id), <String>['w-a', 'w-b', 'w-c']);
      expect(definition.version!.widgets.map((DashboardWidget w) => w.kind), <WidgetKind>[WidgetKind.kpi, WidgetKind.pie, WidgetKind.line]);
      expect(definition.version!.state, VersionState.published);
      expect(definition.version!.revision, 3);
    });

    test('a dashboard whose current version is not among its versions has none', () {
      final Map<String, Object?> one = dashboardJson(dashD1, version: versionD1);
      expect(parseDashboardDefinition(one)!.version, isNull);
      expect(parseDashboardDefinition(<String, Object?>{'title': 'no id'}), isNull);
    });

    test('the snapshot a dashboard is read over: the first pinned version, or the newest frozen one', () {
      final DashboardVersion latest = parseDashboardDefinition(standardDashboard())!.version!;
      final DashboardVersion pinned = parseDashboardDefinition(standardDashboard(policy: 'PINNED', pinned: <String>[snapA, snapB]))!.version!;
      const List<DatasetVersion> frozen = <DatasetVersion>[DatasetVersion(id: snapB, period: '2026-10'), DatasetVersion(id: snapA, period: '2026-10')];
      expect(snapshotFor(latest, frozen), snapB);
      expect(snapshotFor(latest, const <DatasetVersion>[]), isNull, reason: 'no period has a frozen version yet');
      expect(snapshotFor(pinned, frozen), snapA);
      expect(snapshotFor(parseDashboardDefinition(standardDashboard(policy: 'PINNED'))!.version!, frozen), isNull);
    });

    test('the dataset of the disbursement figures is the one built from the period snapshots; only frozen versions are read', () {
      expect(periodSnapshotDatasetId(<String, Object?>{'items': <Object?>[<String, Object?>{'id': 'x', 'source_kind': 'OTHER'}, <String, Object?>{'id': dataset, 'source_kind': 'PERIOD_SNAPSHOT'}]}), dataset);
      expect(periodSnapshotDatasetId(<String, Object?>{'items': <Object?>[]}), isNull);
      final List<DatasetVersion> frozen = frozenVersions(<String, Object?>{
        'items': <Object?>[
          <String, Object?>{'id': snapB, 'status': 'FROZEN', 'as_of_period': '2026-10'},
          <String, Object?>{'id': 'building', 'status': 'BUILDING'},
          <String, Object?>{'id': snapA, 'status': 'FROZEN', 'as_of_period': '2026-10'},
        ],
      });
      expect(frozen.map((DatasetVersion v) => v.id), <String>[snapB, snapA]);
    });
  });

  group('AC-ST-MOB-027-3 UI-MOB-40 what the charts draw', () {
    test('a group with no figure is left out of a chart, never drawn as zero', () {
      final QueryResult result = parseQueryResult(paidAnswer())!;
      expect(chartValues(result.children), <double>[300000000, 180000000]);
    });

    test('a bar fills the share of the widest value, by size without sign, and nothing when there is nothing to compare', () {
      expect(fractionOf(150, 300), 0.5);
      expect(fractionOf(-300, 300), 1.0);
      expect(fractionOf(5, 0), 0);
      expect(fractionOf(900, 300), 1.0, reason: 'never wider than the bar');
      expect(widestOf(<double>[3, -9, 4]), 9);
      expect(widestOf(const <double>[]), 0);
    });
  });
}
