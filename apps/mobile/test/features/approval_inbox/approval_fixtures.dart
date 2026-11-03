import 'dart:convert';

import 'package:machvon_api_client/machvon_api_client.dart';

Map<String, Object?> approvalTask(
  String id, {
  int version = 4,
  String status = 'Pending',
  String businessType = 'report.accept',
  String step = 'Thẩm định báo cáo',
  String due = '2026-11-05T10:00:00Z',
  bool overdue = false,
  bool canDecide = true,
  String resourceId = 'rep-2',
}) =>
    <String, Object?>{
      'id': id,
      'version': version,
      'status': status,
      'business_type': businessType,
      'step_name': step,
      'due_at': due,
      'overdue': overdue,
      'assignee': <String, Object?>{'id': 'm-1', 'name': 'Lê Lãnh Đạo'},
      'resource': <String, Object?>{'type': 'report', 'id': resourceId},
      'instance': <String, Object?>{'id': 'i-$id', 'version': 2, 'status': 'Running', 'amount_vnd': '420000000', 'unit_id': 'u-bql1'},
      'actions': <String, Object?>{'decide': canDecide, 'reassign': false, 'cancel': false},
    };

Map<String, Object?> page(List<Object?> items) => <String, Object?>{'items': items, 'next_cursor': null, 'as_of': '2026-11-02T09:00:00Z'};

Map<String, Object?> unitsPage() => page(<Object?>[
      <String, Object?>{'id': 'u-bql1', 'name': 'Ban QLDA giao thông'},
    ]);

/// A revision of a report: the six cells in millions of dong (`bucket:level`), the total and the CTMTQG part.
Map<String, Object?> reportRevision(String id, int revision, Map<String, int> millions, {String? supersedes, String? amendment, List<Object?> attachments = const <Object?>[]}) {
  final int total = millions.values.fold(0, (int sum, int value) => sum + value);
  return <String, Object?>{
    'id': id,
    'revision': revision,
    'status': 'SUBMITTED',
    'project': <String, Object?>{'id': 'p-1', 'code': 'DA-001', 'name': 'Đường vành đai 1'},
    'period': <String, Object?>{'id': 'per-1', 'code': 'W44'},
    'funding_lines': <Object?>[
      for (final MapEntry<String, int> entry in millions.entries)
        <String, Object?>{'bucket': entry.key.split(':')[0], 'budget_level': entry.key.split(':')[1], 'cumulative_vnd': '${entry.value}000000'},
    ],
    'totals': <String, Object?>{'cumulative_vnd': '${total}000000', 'ctmtqg_vnd': '40000000'},
    'supersedes_id': supersedes,
    'amendment_reason': amendment,
    'attachments': attachments,
  };
}

/// FX-DIS-001: 100, 200, 30, 70, 0, 20 million, CTMTQG 40 inside them: 420 and never 460.
final Map<String, int> secondRevision = <String, int>{'CURRENT_YEAR:CENTRAL': 90, 'CURRENT_YEAR:LOCAL': 210, 'CARRYOVER:CENTRAL': 30, 'CARRYOVER:LOCAL': 70, 'OTHER:CENTRAL': 0, 'OTHER:LOCAL': 20};
final Map<String, int> firstRevision = <String, int>{'CURRENT_YEAR:CENTRAL': 100, 'CURRENT_YEAR:LOCAL': 200, 'CARRYOVER:CENTRAL': 30, 'CARRYOVER:LOCAL': 70, 'OTHER:CENTRAL': 0, 'OTHER:LOCAL': 0};

Map<String, Object?> attachment() => <String, Object?>{'id': 'f-1', 'file_name': 'bao-cao-tuan-44.pdf', 'content_type': 'application/pdf', 'size_bytes': 204800, 'file_sha256': 'a3f5c2d1e4b6978800aabbccddeeff00112233445566778899aabbccddeeff00'};

HttpResult problem(int status, String code, {Map<String, Object?> extra = const <String, Object?>{}}) => HttpResult(
      status: status,
      headers: <String, String>{'content-type': 'application/problem+json'},
      body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': code, 'status': status, 'code': code, ...extra}),
    );

HttpResult decided() => HttpResult(
      status: 200,
      headers: <String, String>{'content-type': 'application/json'},
      body: jsonEncode(<String, Object?>{'operation_id': '3f2b6c1e-0000-4000-8000-0000000000b1', 'status': 'DECIDED', 'resource_version': 5, 'resource_id': 't-1'}),
    );
