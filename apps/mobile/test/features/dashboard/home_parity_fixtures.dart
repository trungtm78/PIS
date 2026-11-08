import '../directives/directive_fixtures.dart';
import 'dashboard_fixtures.dart';

/// The fixtures of the parts the leader home has beside the command center (the "i" of a figure, the colours with their reasons, what changed since last
/// week, the steering directives): the same shapes as the answers of the API.

/// The definition of the register behind a figure, as the API serializes it (`kpi`, camelCase).
Map<String, Object?> kpi(
  String code,
  String name, {
  String formula = 'Tổng giải ngân của Kho bạc chia cho kế hoạch vốn được giao',
  String? numerator = 'Giải ngân lũy kế theo Kho bạc',
  String? denominator = 'Kế hoạch vốn được giao',
  List<String> exclusions = const <String>['Dự án đã đóng hồ sơ'],
  String source = 'Ảnh chụp số liệu đã chốt',
  String owner = 'Vụ Kế hoạch tài chính',
  int version = 2,
  String origin = 'RULE',
  bool unverified = false,
}) =>
    <String, Object?>{
      'code': code,
      'name': name,
      'formula': formula,
      'numerator': numerator,
      'denominator': denominator,
      'exclusions': exclusions,
      'unit': 'PERCENT',
      'period': 'YEAR',
      'source': source,
      'owner': owner,
      'allowedLagDays': 8,
      'version': version,
      'effectiveFrom': '2026-01-01',
      'effectiveTo': null,
      'origin': origin,
      'unverified': unverified,
      'asOf': '2026-10-31',
      'snapshotId': '3f2b6c1e-0000-4000-8000-0000000000a1',
    };

/// A tile with the definition behind it and the flags the server set.
Map<String, Object?> tileWithInfo(String metric, {String? value, String? displayValue, String? numerator, String? denominator, String unit = 'PERCENT', Map<String, Object?>? info, List<String> flags = const <String>[]}) =>
    <String, Object?>{
      ...tile(metric, value: value, displayValue: displayValue, numerator: numerator, denominator: denominator, unit: unit),
      'kpi': info,
      'flags': flags,
    };

Map<String, Object?> countTile(String metric, int value, {Map<String, Object?>? info}) => <String, Object?>{
      'metric_code': metric,
      'value': '$value',
      'display_value': '$value',
      'numerator': '$value',
      'denominator': null,
      'null_reason': null,
      'unit': 'COUNT',
      'formula': 'Số đã đếm',
      'definition_status': 'PROPOSED_PENDING_SIGNOFF',
      'kpi': info,
      'certification': null,
      'flags': <String>[],
    };

/// The command center as the register gives it: every figure with its definition, and the three counts as figures.
Map<String, Object?> commandCenterWithDefinitions() => <String, Object?>{
      ...commandCenter(
        tiles: <Map<String, Object?>>[
          tileWithInfo('DISBURSEMENT_RATE_PM', value: '14.0000', displayValue: '14,00', numerator: '140000000', denominator: '1000000000', info: kpi('DISBURSEMENT_RATE_PM', 'Tỷ lệ giải ngân theo kế hoạch Thủ tướng giao'), flags: <String>['UNVERIFIED_DEFINITION']),
          tileWithInfo('DISBURSEMENT_RATE_TOTAL', value: '12.5000', displayValue: '12,50', numerator: '140000000', denominator: '1120000000', info: kpi('DISBURSEMENT_RATE_TOTAL', 'Tỷ lệ giải ngân theo tổng kế hoạch vốn', origin: 'DEFAULT', unverified: true, version: 0)),
          tileWithInfo('DISBURSED_TREASURY', value: '140000000', unit: 'VND', info: kpi('DISBURSED_TREASURY', 'Giải ngân lũy kế theo Kho bạc', numerator: null, denominator: null, exclusions: <String>[])),
        ],
      ),
      'count_tiles': <Object?>[
        countTile('OPEN_WARNINGS', 3, info: kpi('OPEN_WARNINGS', 'Cảnh báo sớm đang mở', formula: 'Số cảnh báo sớm chưa đóng', numerator: null, denominator: null, exclusions: <String>[])),
        countTile('OVERDUE_EXPLANATIONS', 1),
        countTile('PENDING_REALLOCATIONS', 2),
      ],
    };

Map<String, Object?> ragFactor(String code, double? value, String band, double points, {String direction = 'HIGHER_IS_BETTER', double green = 0.9, double amber = 0.6, double weight = 0.4}) => <String, Object?>{
      'code': code,
      'value': value,
      'band': band,
      'points': points,
      'weight': weight,
      'direction': direction,
      'green': green,
      'amber': amber,
    };

Map<String, Object?> ragUnit(
  String id,
  String name, {
  String band = 'RED',
  String? ruleBand,
  double? score = 71.5,
  double? coverage = 100,
  List<Map<String, Object?>>? reasons,
  Map<String, Object?>? override,
  Map<String, Object?>? previous,
}) =>
    <String, Object?>{
      'unit_id': id,
      'code': 'U-$id',
      'name': name,
      'band': band,
      'rule_band': ruleBand ?? band,
      'overridden': override != null,
      'override': override,
      'score': score,
      'coverage_pct': coverage,
      'no_data_reason': band == 'NO_DATA' ? 'LOW_COVERAGE' : null,
      'factors': <Object?>[],
      'reasons': reasons ??
          <Map<String, Object?>>[
            ragFactor('EWS_RATE_VS_PACE', 0.55, 'RED', 40),
            ragFactor('EWS_CRITICAL_WARNINGS', 4, 'AMBER', 20, direction: 'LOWER_IS_BETTER', green: 1, amber: 3),
          ],
      'projects': 5,
      'previous': previous ?? <String, Object?>{'week_start': '2026-10-26', 'score': 60, 'band': 'AMBER'},
      'trend': <Object?>[],
    };

Map<String, Object?> ragReading({List<Map<String, Object?>>? units, bool unverified = true}) {
  final List<Map<String, Object?>> list = units ?? <Map<String, Object?>>[ragUnit('1', 'Sở Giao thông')];
  int of(String band) => list.where((Map<String, Object?> unit) => unit['band'] == band).length;
  return <String, Object?>{
    'snapshot_id': '3f2b6c1e-0000-4000-8000-0000000000a1',
    'as_of_date': '2026-10-31',
    'week_start': '2026-10-26',
    'model': <String, Object?>{'unverified': unverified, 'versions': <String, Object?>{}, 'min_coverage_pct': 60, 'score_green': 25, 'score_amber': 45, 'factors': <Object?>[]},
    'summary': <String, Object?>{'RED': of('RED'), 'AMBER': of('AMBER'), 'GREEN': of('GREEN'), 'NO_DATA': of('NO_DATA')},
    'units': list,
  };
}

Map<String, Object?> changeLine(String kind, String direction, Map<String, Object?> params, String link) =>
    <String, Object?>{'kind': kind, 'direction': direction, 'params': params, 'link': link, 'metric_code': null, 'context_token': null};

Map<String, Object?> homeChanges({List<Map<String, Object?>>? lines, String? reason, String previousWeek = '2026-10-19'}) => <String, Object?>{
      'snapshot_id': '3f2b6c1e-0000-4000-8000-0000000000a1',
      'as_of_date': '2026-10-31',
      'week_start': '2026-10-26',
      'previous_week_start': previousWeek,
      'previous_as_of_date': '2026-10-24',
      'reason': reason,
      'lines': lines ??
          <Map<String, Object?>>[
            changeLine('RATE_CHANGE', 'UP', <String, Object?>{'from': '10.00', 'to': '14.00', 'delta': '+4.00'}, 'DRILL'),
            changeLine('UNITS_TO_RED', 'UP', <String, Object?>{'count': 2}, 'RAG'),
            changeLine('WARNINGS_DELTA', 'DOWN', <String, Object?>{'from': 5, 'to': 3, 'delta': '-2'}, 'WARNINGS'),
            changeLine('OVERDUE_DELTA', 'UP', <String, Object?>{'from': 0, 'to': 1, 'delta': '+1'}, 'MY_WORK'),
            changeLine('DISBURSED_WEEK', 'UP', <String, Object?>{'amount_vnd': '+140000000'}, 'RANKING'),
          ],
    };

/// The widget of the directives of the dashboard: the counts and the oldest overdue ones.
Map<String, Object?> directiveWidget({List<Map<String, Object?>>? items, bool unverified = true, bool truncated = false}) => <String, Object?>{
      'counts': <String, Object?>{'overdue': 3, 'due_soon': 2, 'escalated': 1, 'open': 6},
      'items': items ?? threeDirectives.take(1).toList(),
      'truncated': truncated,
      'definitions': <String, Object?>{
        'overdue': 'Chỉ đạo đang mở mà hạn trước ngày hôm nay (giờ Việt Nam).',
        'due_soon': 'Chỉ đạo chưa xong có hạn trong 3 ngày tới.',
        'escalated': 'Chỉ đạo quá hạn từ 7 ngày trở lên.',
      },
      'policy': <String, Object?>{'code': 'DEFAULT', 'version': null, 'source': 'DEFAULT', 'unverified': unverified},
      'as_of': directivesAsOf,
    };
