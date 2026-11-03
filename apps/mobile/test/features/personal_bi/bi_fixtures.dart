import 'dart:convert';

import 'package:machvon_api_client/machvon_api_client.dart';

import '../support/scripted_server.dart';

const String dashD1 = 'd1000000-0000-4000-8000-000000000001';
const String dashShared = 'd1000000-0000-4000-8000-000000000002';
const String dashEmpty = 'd1000000-0000-4000-8000-000000000003';
const String dashPinned = 'd1000000-0000-4000-8000-000000000004';
const String versionD1 = 'e1000000-0000-4000-8000-000000000001';
const String versionPinned = 'e1000000-0000-4000-8000-000000000004';
const String metricRate = '3e000000-0000-4000-8000-000000000001';
const String metricPaid = '3e000000-0000-4000-8000-000000000002';
const String dataset = 'da000000-0000-4000-8000-000000000001';

/// SV-10a was frozen first; SV-10b, of the same period, was frozen later (UAT-AC34).
const String snapA = '10a00000-0000-4000-8000-000000000001';
const String snapB = '10b00000-0000-4000-8000-000000000002';

const String tokenA = 'token-of-the-query-over-sv-10a-0000000001';
const String tokenAUnit = 'token-of-the-unit-group-over-sv-10a-0001';
const String tokenAFund = 'token-of-the-fund-group-over-sv-10a-0001';
const String tokenB = 'token-of-the-query-over-sv-10b-0000000002';

Map<String, Object?> widgetJson(String id, String kind, String metric, {String? dimension, String? title, int y = 0}) => <String, Object?>{
      'id': id,
      'kind': kind,
      'metric_version_id': metric,
      if (title != null) 'title': title,
      if (dimension != null) 'dimension_code': dimension,
      'grid': <String, Object?>{'x': 0, 'y': y, 'w': 12, 'h': 4},
    };

Map<String, Object?> versionJson(String id, List<Map<String, Object?>> widgets, {String status = 'PUBLISHED', String policy = 'LATEST_FROZEN', List<String> pinned = const <String>[]}) => <String, Object?>{
      'id': id,
      'revision': 3,
      'layout_json': <String, Object?>{'columns': 12, 'widgets': widgets},
      'status': status,
      'dataset_version_policy': policy,
      'pinned_dataset_version_ids': pinned,
    };

Map<String, Object?> dashboardJson(
  String id, {
  String title = 'Giải ngân của tôi',
  bool mine = true,
  String? version,
  bool certified = true,
  List<Map<String, Object?>> versions = const <Map<String, Object?>>[],
  String? owner,
}) =>
    <String, Object?>{
      'id': id,
      'code': 'DASH-${id.substring(id.length - 2)}',
      'title': title,
      'owner': <String, Object?>{'id': 'u-1', 'name': owner ?? 'Chính tôi'},
      'audience': 'PRIVATE',
      'status': 'PUBLISHED',
      'current_version': version == null ? null : <String, Object?>{'id': version, 'revision': 3, 'status': 'PUBLISHED', 'metric_count': 2, 'metrics_certified': certified},
      'mine': mine,
      'permission': mine ? 'OWNER' : 'VIEW',
      'versions': versions,
    };

/// The standard dashboard: the rate of disbursement as a single figure, and the amount paid by unit as bars.
Map<String, Object?> standardDashboard({String id = dashD1, List<Map<String, Object?>>? widgets, String policy = 'LATEST_FROZEN', List<String> pinned = const <String>[], bool certified = true}) {
  final List<Map<String, Object?>> layout = widgets ??
      <Map<String, Object?>>[
        widgetJson('w-rate', 'KPI', metricRate, title: 'Tỷ lệ giải ngân'),
        widgetJson('w-paid', 'BAR', metricPaid, dimension: 'unit', title: 'Đã giải ngân theo đơn vị', y: 4),
      ];
  return dashboardJson(id, version: versionD1, certified: certified, versions: <Map<String, Object?>>[versionJson(versionD1, layout, policy: policy, pinned: pinned)]);
}

Map<String, Object?> figure(String? value, {String? numerator, String? denominator, String? nullReason}) => <String, Object?>{'value': value, 'numerator': numerator, 'denominator': denominator, 'null_reason': nullReason};

Map<String, Object?> groupJson(String key, String label, String? value, {String? token, String? numerator, String? denominator, String? nullReason}) => <String, Object?>{
      'key': key,
      'label': label,
      'unclassified': false,
      ...figure(value, numerator: numerator, denominator: denominator, nullReason: nullReason),
      'drill_token': token,
    };

/// The answer of a query, in the shape of `BiDrillExplanation` with the members BI adds (the metric, the scope, the new data).
Map<String, Object?> answer({
  String metric = metricPaid,
  String code = 'PAID_VND',
  String unit = 'VND',
  String aggregation = 'sum',
  String snapshot = snapA,
  String period = '2026-10',
  String? dimension,
  Map<String, Object?>? total,
  List<Map<String, Object?>> children = const <Map<String, Object?>>[],
  bool newData = false,
  String? newer,
  bool cached = false,
  String builtAt = '2026-11-12T01:00:00Z',
  String token = tokenA,
  String badge = 'PASSED',
  bool reconciles = true,
}) =>
    <String, Object?>{
      'metric': <String, Object?>{'id': metric, 'code': code, 'unit': unit, 'aggregation_type': aggregation},
      'metric_version_id': metric,
      'as_of_period': period,
      'snapshot_id': snapshot,
      'quality_badge': badge,
      'excluded_quarantine_rows': 0,
      'feeds_certified': true,
      'new_data_available': newData,
      'newer_snapshot_id': newer,
      'scope': <String, Object?>{'label': 'YOUR_SCOPE', 'full_tenant': false},
      'served_from_cache': cached,
      'built_at': builtAt,
      'dimension': dimension,
      'total': total ?? figure('0'),
      'reconciles_to_parent': reconciles,
      'non_additive_reason': null,
      'truncated': false,
      'children': children,
      'drill_token': token,
    };

/// The two tiles over [snapshot]: the rate (a ratio) and the amount paid by unit.
Map<String, Object?> rateAnswer({String snapshot = snapA, bool newData = false, String? newer, bool cached = false, String token = tokenA}) => answer(
      metric: metricRate,
      code: 'DISBURSEMENT_RATE',
      unit: 'percent',
      aggregation: 'ratio',
      snapshot: snapshot,
      total: figure('64.125', numerator: '480000000', denominator: '748000000'),
      newData: newData,
      newer: newer,
      cached: cached,
      token: token,
    );

Map<String, Object?> paidAnswer({String snapshot = snapA, bool newData = false, String? newer, bool cached = false, String token = tokenA}) => answer(
      snapshot: snapshot,
      dimension: 'unit',
      total: figure('480000000'),
      children: <Map<String, Object?>>[
        groupJson('u-1', 'Sở Giao thông', '300000000', token: tokenAUnit),
        groupJson('u-2', 'Sở Nông nghiệp', '180000000', token: tokenAFund),
        groupJson('u-3', 'Ban QLDA huyện', null, nullReason: 'NO_DATA'),
      ],
      newData: newData,
      newer: newer,
      cached: cached,
      token: token,
    );

/// The server of the dashboards. [over] says which snapshot the figures are of.
ScriptedServer biServer({Map<String, Object?>? dashboard, String snapshot = snapA, bool newData = false, String? newer, bool cached = false, List<String> frozen = const <String>[snapA]}) {
  final ScriptedServer server = ScriptedServer();
  final Map<String, Object?> one = dashboard ?? standardDashboard();
  server.on('GET', '/bi/dashboards', (_) => <String, Object?>{'items': <Object?>[one], 'next_cursor': null});
  server.on('GET', '/bi/dashboards/:id', (_) => one);
  server.on('GET', '/bi/datasets', (_) => <String, Object?>{
        'items': <Object?>[<String, Object?>{'id': dataset, 'source_kind': 'PERIOD_SNAPSHOT', 'dataset_code': 'disbursement'}],
        'next_cursor': null,
      });
  server.on('GET', '/bi/datasets/:id/versions', (_) => <String, Object?>{
        'items': <Object?>[for (final String id in frozen) <String, Object?>{'id': id, 'dataset_id': dataset, 'as_of_period': '2026-10', 'status': 'FROZEN'}],
        'next_cursor': null,
      });
  server.on('POST', '/dashboard-queries', (HttpCall call) {
    final Map<String, Object?> body = jsonDecode(call.body!) as Map<String, Object?>;
    final String snap = body['snapshot_id']! as String;
    return body['metric_version_id'] == metricRate
        ? rateAnswer(snapshot: snap, newData: newData && snap == snapA, newer: newer, cached: cached)
        : paidAnswer(snapshot: snap, newData: newData && snap == snapA, newer: newer, cached: cached);
  });
  return server;
}
