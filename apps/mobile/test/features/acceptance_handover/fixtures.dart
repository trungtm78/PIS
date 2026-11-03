import 'dart:convert';

import 'package:machvon_api_client/machvon_api_client.dart';

/// A refusal of the server: a problem document with the stable code and any members beyond the standard ones.
HttpResult problem(int status, String code, {String? detail, Map<String, Object?> extra = const <String, Object?>{}}) => HttpResult(
      status: status,
      headers: <String, String>{'content-type': 'application/problem+json'},
      body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': code, 'status': status, 'code': code, if (detail != null) 'detail': detail, ...extra}),
    );

/// The answer of a command that was recorded.
HttpResult recorded(String id, {int version = 4, String status = 'APPROVED'}) => HttpResult(
      status: 200,
      headers: <String, String>{'content-type': 'application/json'},
      body: jsonEncode(<String, Object?>{'operation_id': '3f2b6c1e-0000-4000-8000-0000000000b1', 'status': status, 'resource_version': version, 'resource_id': id}),
    );

Map<String, Object?> signature(String role, {String method = 'IN_APP_OTP', String name = 'Trần Giám Sát', bool valid = true, String? serial}) => <String, Object?>{
      'role': role,
      'membership_id': '00000000-0000-4000-8000-000000000001',
      'signer_name': name,
      'method': method,
      'legal_effect': method == 'DIGITAL_CERT' ? 'LEGAL_E_SIGNATURE' : 'INTERNAL_RECORD',
      'cert_serial': serial,
      'signed_at': '2026-11-02T03:00:00Z',
      'valid': valid,
    };

/// QMS acceptance minutes needing the three roles of the fixture regime (contractor, supervisor, owner); the contractor and the
/// supervisor signed, the owner has not.
Map<String, Object?> minutes({
  String id = 'qa-1',
  String recordNo = 'QA-W-001',
  String status = 'SIGNING',
  int version = 3,
  List<Map<String, Object?>>? signatures,
  List<String> missing = const <String>['OWNER'],
  List<String> signable = const <String>[],
  bool canSign = false,
  bool canApprove = true,
  bool canReject = true,
  int ncr = 0,
  String? note,
  String? boq = 'B02',
}) =>
    <String, Object?>{
      'id': id,
      'record_no': recordNo,
      'contract': <String, Object?>{'id': 'c-1', 'code': 'HD-A-001', 'status': 'ACTIVE'},
      'project_id': 'p-1',
      'inspection': <String, Object?>{'id': 'i-1', 'inspection_no': 'INS-A-001', 'inspection_type': 'CONCEALED_WORK', 'result': 'PASS'},
      'boq_item': boq == null ? null : <String, Object?>{'id': 'b-1', 'business_key': boq},
      'acceptance_scope': 'WORK_ITEM',
      'document_version_id': '9a1c3e55-2b7d-4c1a-8e0f-5d6c7b8a9e01',
      'status': status,
      'required_roles': <String>['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
      'signatures': signatures ?? <Map<String, Object?>>[signature('CONTRACTOR', name: 'Lê Nhà Thầu'), signature('SUPERVISOR')],
      'missing_roles': missing,
      'open_critical_ncr': ncr,
      'regime': <String, Object?>{'version_id': null, 'label': 'REG-FIX-1', 'legal_basis': null, 'awaiting_confirmation': false, 'cxn': null},
      'decision_note': note,
      'approved_by': null,
      'created_by': <String, Object?>{'membership_id': 'm-9', 'display_name': 'Phạm Chuyên Viên'},
      'signable_roles': signable,
      'actions': <String, Object?>{'sign': canSign, 'approve': canApprove, 'reject': canReject, 'revoke': false},
      'version': version,
    };

Map<String, Object?> minutesPage(List<Map<String, Object?>> items) => <String, Object?>{'items': items, 'as_of': '2026-11-03T02:30:00Z'};

Map<String, Object?> handover(
  String id, {
  String no = 'BG-001',
  String status = 'PUNCH_PENDING',
  String kind = 'COMPLETION',
  int items = 3,
  int critical = 1,
  String unit = 'Ban quản lý khai thác đường',
  String? reason,
}) =>
    <String, Object?>{
      'id': id,
      'handover_no': no,
      'handover_kind': kind,
      'status': status,
      'contract': <String, Object?>{'id': 'c-1', 'code': 'HD-A-001', 'status': 'ACTIVE'},
      'project_id': 'p-1',
      'recipient_unit': <String, Object?>{'id': 'u-9', 'code': 'BQLKT', 'name': unit},
      'planned_on': '2026-10-20',
      'handed_on': null,
      'accepted_at': null,
      'rejection_reason': reason,
      'open_critical_punch_count': critical,
      'punch_item_count': items,
      'version': 2,
    };

Map<String, Object?> warranty(String id, {String handoverId = 'h-1', String status = 'ACTIVE', String ends = '2028-10-20', int open = 1}) => <String, Object?>{
      'id': id,
      'contract': <String, Object?>{'id': 'c-1', 'code': 'HD-A-001'},
      'handover': <String, Object?>{'id': handoverId, 'handover_no': 'BG-001'},
      'scope_description': 'Mặt đường bê tông nhựa',
      'asset': <String, Object?>{'id': 'a-1', 'asset_code': 'TS-01', 'name': 'Đường ĐT.A1 km0-km12'},
      'starts_on': '2026-10-20',
      'ends_on': ends,
      'period_months': 24,
      'status': status,
      'open_claims': open,
      'total_claims': 2,
    };

Map<String, Object?> punchItem(String id, int no, {String severity = 'CRITICAL', String status = 'OPEN', bool overdue = false}) => <String, Object?>{
      'id': id,
      'item_no': no,
      'description': 'Nứt mặt đường đoạn km3',
      'severity': severity,
      'status': status,
      'location_text': 'km3+200',
      'responsible_contractor': <String, Object?>{'id': 'k-1', 'name': 'Công ty Minh An'},
      'due_on': '2026-11-15',
      'overdue': overdue,
    };

Map<String, Object?> trace(Map<String, Object?> handoverLine, List<Map<String, Object?>> items) =>
    <String, Object?>{'handover': handoverLine, 'items': items, 'assets': <Object?>[], 'documents': <Object?>[], 'quality_acceptance': null};

Map<String, Object?> page(List<Object?> items) => <String, Object?>{'items': items, 'next_cursor': null, 'as_of': '2026-11-02T09:00:00Z'};
