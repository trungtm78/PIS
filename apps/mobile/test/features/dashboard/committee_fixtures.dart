import 'home_parity_fixtures.dart';

/// The fixtures of the committee workspace (`getCommitteeWorkspace`): the same shapes as the answer of the API, with figures read from the core.

const String kRateName = 'Tỷ lệ giải ngân toàn tỉnh';

/// A figure with its definition behind the "i".
Map<String, Object?> committeeFigure(
  String code,
  String name, {
  String? value,
  String? display,
  String unit = 'PERCENT',
  String? nullReason,
  List<String> flags = const <String>[],
  bool info = true,
}) =>
    <String, Object?>{
      'metric_code': code,
      'value': value,
      'display_value': display ?? value,
      'numerator': null,
      'denominator': null,
      'null_reason': value == null ? (nullReason ?? 'NO_DATA') : null,
      'unit': unit,
      'formula': 'Công thức của $name',
      'definition_status': 'PROPOSED_PENDING_SIGNOFF',
      'kpi': info ? kpi(code, name, formula: 'Công thức của $name', numerator: null, denominator: null, exclusions: const <String>['Dòng vốn chưa có số liệu'], source: 'Lõi dữ liệu dùng chung', owner: 'Văn phòng Ban chỉ đạo', unverified: true) : null,
      'certification': null,
      'flags': flags,
    };

List<Map<String, Object?>> committeeFigures({bool unknown = false, List<String> flags = const <String>[], String? nullReason}) => <Map<String, Object?>>[
      committeeFigure('COMMITTEE_PLAN_TOTAL', 'Kế hoạch vốn của tỉnh', value: unknown ? null : '1200000000000', unit: 'VND', nullReason: nullReason, flags: flags),
      committeeFigure('COMMITTEE_DISBURSED', 'Giải ngân của tỉnh', value: unknown ? null : '494400000000', unit: 'VND', nullReason: nullReason, flags: flags),
      committeeFigure('COMMITTEE_DISBURSEMENT_RATE', kRateName, value: unknown ? null : '41.2000', display: '41.20', nullReason: nullReason, flags: flags),
      committeeFigure('COMMITTEE_DISBURSED_LAST_YEAR', 'Giải ngân cùng kỳ năm trước', value: unknown ? null : '420000000000', unit: 'VND', nullReason: nullReason, flags: flags),
      committeeFigure('COMMITTEE_GAP_VS_CURVE', 'Chênh lệch so với đường kỳ vọng', value: unknown ? null : '-4.1000', display: '-4.10', nullReason: nullReason, flags: flags),
      committeeFigure('COMMITTEE_OUTLOOK_LOW', 'Dự báo cuối năm, mức thấp', value: unknown ? null : '1000000000000', unit: 'VND', nullReason: nullReason, flags: flags),
      committeeFigure('COMMITTEE_OUTLOOK_HIGH', 'Dự báo cuối năm, mức cao', value: unknown ? null : '1100000000000', unit: 'VND', nullReason: nullReason, flags: flags),
      committeeFigure('COMMITTEE_ATTENTION_PROJECTS', 'Dự án cần quan tâm', value: unknown ? null : '7', unit: 'COUNT', nullReason: nullReason, flags: flags),
      committeeFigure('COMMITTEE_UNITS_NOT_REPORTING', 'Đơn vị không báo cáo', value: unknown ? null : '2', unit: 'COUNT', nullReason: nullReason, flags: flags),
      committeeFigure('COMMITTEE_DIRECTIVES_OVERDUE', 'Chỉ đạo quá hạn', value: '1', unit: 'COUNT', flags: flags),
    ];

Map<String, Object?> committeeSignal(String reason) => <String, Object?>{'reason': reason, 'value': '90', 'threshold': 60, 'unit': 'DAYS', 'severity': 0.8, 'weight': 3};

Map<String, Object?> committeeAttentionItem(int rank, String code, String name, List<String> reasons) => <String, Object?>{
      'rank': rank,
      'project_id': '00000000-0000-4000-8000-00000000000$rank',
      'code': code,
      'name': name,
      'sector_code': 'GT',
      'sector_name': 'Giao thông',
      'district_name': 'Huyện A',
      'investor_unit_id': '00000000-0000-4000-8000-0000000000aa',
      'investor_name': 'Ban quản lý 1',
      'plan_vnd': '100000000000',
      'disbursed_vnd': '10000000000',
      'rate_pct': '10.00',
      'expected_pct': '45.30',
      'exposure_vnd': '90000000000',
      'score': '72.50',
      'signals': <Object?>[for (final String reason in reasons) committeeSignal(reason)],
      'decision': null,
    };

Map<String, Object?> committeeAlert(String id, String type, String severity, {String status = 'OPEN', String? label}) => <String, Object?>{
      'id': id,
      'alert_type': type,
      'subject_kind': 'PROVINCE',
      'subject_key': 'PROVINCE',
      'subject_label': label,
      'severity': severity,
      'value': '41.20',
      'threshold': '45.30',
      'detail': <String, Object?>{},
      'fiscal_year': 2026,
      'status': status,
      'opened_on': '2026-10-20',
      'last_seen_on': '2026-10-31',
      'resolved_on': null,
      'acknowledged_by_name': null,
      'acknowledged_at': null,
      'acknowledged_note': null,
      'owner': 'COMMITTEE_SECRETARIAT',
      'expected_action': null,
      'consequence': null,
      'response_hours': 48,
      'version': 1,
    };

Map<String, Object?> committeeProvince({String rag = 'AMBER', int known = 3, int total = 3, bool thin = false, String? outlookReason, bool band = true}) => <String, Object?>{
      'dimension': 'PROVINCE',
      'key': 'PROVINCE',
      'label': 'Toàn tỉnh',
      'projects': 12,
      'plan_share_pct': '100.00',
      'attention_projects': 7,
      'plan_vnd': '1200000000000',
      'disbursed_vnd': '494400000000',
      'rate_pct': '41.20',
      'last_year_vnd': '420000000000',
      'last_year_coverage': <String, Object?>{'known': known, 'total': total},
      'change_vs_last_year_vnd': '74400000000',
      'expected_pct': '45.30',
      'gap_points': '-4.10',
      'rag': rag,
      'outlook': <String, Object?>{
        'low_vnd': band ? '1000000000000' : null,
        'high_vnd': band ? '1100000000000' : null,
        'low_pct': band ? '83.33' : null,
        'high_pct': band ? '91.67' : null,
        'methods': <Object?>[],
        'thin': thin,
        'reason': outlookReason,
      },
      'unknown_lines': 0,
    };

/// A healthy workspace: four projects in the attention list (given out of order), three alerts of which one is resolved.
Map<String, Object?> committeeWorkspace({
  bool empty = false,
  List<Map<String, Object?>>? figures,
  Map<String, Object?>? province,
  List<Map<String, Object?>>? attention,
  List<Map<String, Object?>>? alerts,
  int attentionTotal = 7,
  String asOf = '2026-10-31',
}) =>
    <String, Object?>{
      'as_of': asOf,
      'fiscal_year': 2026,
      'feed': <String, Object?>{'basis': 'DIS_SNAPSHOT', 'reference': '3f2b6c1e-0000-4000-8000-0000000000a1', 'last_delivered_at': '2026-10-31T01:00:00.000Z', 'empty': empty, 'projects': 12, 'lines': 30},
      'policy': <String, Object?>{'code': 'COMMITTEE_POLICY', 'version': null, 'source': 'DEFAULT', 'unverified': true, 'formula': 'f', 'rule_source': 's', 'as_of': '2026-10-31', 'curve': <Object?>[], 'expected_pct': '45.30'},
      'figures': figures ?? committeeFigures(),
      'province': province ?? committeeProvince(),
      'by_sector': <Object?>[],
      'by_district': <Object?>[],
      'by_investor': <Object?>[],
      'by_fund_source': <Object?>[],
      'attention_total': attentionTotal,
      'attention': attention ??
          <Map<String, Object?>>[
            committeeAttentionItem(3, 'DA-003', 'Cầu vượt sông Hồng', <String>['DELAYED']),
            committeeAttentionItem(1, 'DA-001', 'Đường vành đai 3', <String>['DELAYED', 'STALLED_PROCEDURE']),
            committeeAttentionItem(4, 'DA-004', 'Trường học xã B', <String>['UNIT_NOT_REPORTING']),
            committeeAttentionItem(2, 'DA-002', 'Bệnh viện đa khoa', <String>['OVER_BUDGET_RISK', 'DISBURSEMENT_FAR_BELOW_PLAN']),
          ],
      'units': <Object?>[],
      'alerts': alerts ??
          <Map<String, Object?>>[
            committeeAlert('a1', 'COMMITTEE_PROVINCE_BEHIND', 'URGENT'),
            committeeAlert('a2', 'COMMITTEE_UNIT_NOT_REPORTING', 'WATCH', label: 'Sở Xây dựng'),
            committeeAlert('a3', 'COMMITTEE_DIRECTIVE_OVERDUE', 'ACTION', status: 'RESOLVED'),
          ],
      'changes': <String, Object?>{'lines': <Object?>[], 'previous_as_of': null, 'reason': null},
      'directives': <String, Object?>{},
      'filters': <String, Object?>{},
    };
