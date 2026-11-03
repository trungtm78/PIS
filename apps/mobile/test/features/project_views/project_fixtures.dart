/// The golden fixture of the project screens: unit U-BQL1 with two projects in the scope of the reader.
const String asOfInstant = '2026-10-31T09:00:00Z';

Map<String, Object?> page(List<Object?> items, {String? next, String? asOf = asOfInstant}) => <String, Object?>{'items': items, 'next_cursor': next, if (asOf != null) 'as_of': asOf};

Map<String, Object?> projectLine(String id, String code, String name, {String status = 'IMPLEMENTATION', String? leader = 'Nguyễn Văn An', String unit = 'Ban QLDA giao thông', String? national, String? group}) => <String, Object?>{
      'id': id,
      'code': code,
      'name': name,
      'owner_unit_id': 'u-bql1',
      'owner_unit_name': unit,
      'investor_unit_id': null,
      'investor_unit_name': null,
      'project_group': group,
      'status': status,
      'national_project_code': national,
      'leader_in_charge': leader == null ? null : <String, Object?>{'membership_id': 'm-1', 'display_name': leader},
      'version': 3,
    };

Map<String, Object?> projectView(String id, String code, String name, {String? area = 'Huyện Hòa Bình', String? areaKey = 'HB', String? sector = 'Giao thông', String status = 'IMPLEMENTATION', String total = '420000000'}) => <String, Object?>{
      ...projectLine(id, code, name, status: status),
      'area': area == null ? null : <String, Object?>{'version_id': 'v-$areaKey', 'business_key': areaKey, 'label': area},
      'sector': sector == null ? null : <String, Object?>{'version_id': 'v-s', 'business_key': 'GT', 'label': sector},
      'classification': 'INTERNAL',
      'total_investment_vnd': total,
      'start_year': 2025,
      'end_year': 2027,
    };

final List<Map<String, Object?>> twoProjects = <Map<String, Object?>>[
  projectLine('p-1', 'DA-001', 'Đường vành đai 1', national: 'QG-9', group: 'B'),
  projectLine('p-2', 'DA-002', 'Cầu Sông Cầu', status: 'APPRAISAL', leader: null),
];

Map<String, Object?> planVersion(String id, String code, {int year = 2026, int revision = 1, String status = 'PUBLISHED'}) => <String, Object?>{
      'id': id,
      'plan_code': code,
      'plan_kind': 'ANNUAL',
      'plan_year': year,
      'revision': revision,
      'status': status,
      'version': 1,
    };

Map<String, Object?> planLine(String id, String project, String source, String amount, {String ctmtqg = '0', String? disbursed}) => <String, Object?>{
      'id': id,
      'project': <String, Object?>{'id': 'p-$project', 'code': 'DA-$project', 'name': 'Dự án $project'},
      'fund_source': <String, Object?>{'version_id': 'v-$source', 'business_key': source, 'label': 'Nguồn $source'},
      'bucket': 'CURRENT_YEAR',
      'source_year': 2026,
      'amount_vnd': amount,
      'ctmtqg_subset_vnd': ctmtqg,
      'disbursed_vnd': disbursed,
      'version': 1,
    };

Map<String, Object?> planLines(Map<String, Object?> plan, List<Object?> items, {String? next}) => <String, Object?>{'plan': plan, 'items': items, 'next_cursor': next, 'totals': <String, Object?>{'line_count': items.length}};

Map<String, Object?> period(String id, String code, String start, String end, String deadline) => <String, Object?>{
      'id': id,
      'code': code,
      'start_date': start,
      'end_date': end,
      'deadline_at': deadline,
      'status': 'OPEN',
    };

Map<String, Object?> progressProject(String id, String code, String state, {String unit = 'u-bql1', bool overdue = false, bool late = false}) => <String, Object?>{
      'project': <String, Object?>{'id': id, 'code': code, 'name': 'Dự án $code'},
      'unit': <String, Object?>{'id': unit, 'code': unit.toUpperCase(), 'name': 'Đơn vị $unit'},
      'state': state,
      'is_late': late,
      'overdue': overdue,
      'report': null,
    };

Map<String, Object?> progress(String periodId, List<Map<String, Object?>> projects, {bool passed = false, String deadline = '2026-11-02T10:00:00Z'}) => <String, Object?>{
      'period': <String, Object?>{'id': periodId, 'code': 'W44', 'period_type': 'WEEKLY', 'start_date': '2026-10-26', 'end_date': '2026-11-01', 'deadline_at': deadline},
      'deadline_passed': passed,
      'as_of': asOfInstant,
      'total': <String, Object?>{'must_report': projects.length, 'submitted': 0, 'submitted_late': 0, 'draft': 0, 'not_started': 0, 'overdue': 0},
      'units': <Object?>[
        <String, Object?>{'unit': <String, Object?>{'id': 'u-bql1', 'code': 'U-BQL1', 'name': 'Đơn vị u-bql1'}, 'must_report': projects.length},
      ],
      'state': 'MUST_REPORT',
      'projects': projects,
      'next_cursor': null,
    };

Map<String, Object?> issueTotals({int opening = 12, int opened = 5, int resolved = 7, int closing = 10, int overdue = 2}) => <String, Object?>{'opening': opening, 'opened': opened, 'resolved': resolved, 'closing': closing, 'overdue': overdue, 'by_status': <String, Object?>{}};

Map<String, Object?> issueMatrix(String week) => <String, Object?>{
      'week': week,
      'from': '2026-10-26',
      'to': '2026-11-01',
      'statuses': <Object?>[],
      'rows': <Object?>[
        <String, Object?>{'unit': <String, Object?>{'id': 'u-bql1', 'code': 'U-BQL1', 'name': 'Ban QLDA giao thông'}, 'category': <String, Object?>{'version_id': 'c-1', 'code': 'GPMB', 'label': 'Giải phóng mặt bằng'}, ...issueTotals()},
        <String, Object?>{'unit': <String, Object?>{'id': 'u-bql1', 'code': 'U-BQL1', 'name': 'Ban QLDA giao thông'}, 'category': <String, Object?>{'version_id': 'c-2', 'code': 'VL', 'label': 'Vật liệu'}, ...issueTotals(opening: 3, opened: 1, resolved: 2, closing: 2, overdue: 0)},
      ],
      'units': <Object?>[],
      'totals': issueTotals(opening: 15, opened: 6, resolved: 9, closing: 12, overdue: 2),
      'as_of': asOfInstant,
    };
