export '../acceptance_handover/fixtures.dart' show page, problem, recorded;

Map<String, Object?> node(String type, String id, String label, {String? status, String? contract = 'c-1', String? amount, bool superseded = false, Map<String, Object?> facts = const <String, Object?>{}}) => <String, Object?>{
      'type': type,
      'id': id,
      'version': 3,
      'revision': null,
      'status': status,
      'label': label,
      'contract_id': contract,
      'amount_vnd': amount,
      'superseded': superseded,
      'facts': facts,
    };

/// FX: PR-A-001 (gross 2.350.000.000, net 2.100.000.000) is with the Treasury; PR-A-002 was paid and settled.
Map<String, Object?> chain({List<Map<String, Object?>>? extraNodes, List<String> truncated = const <String>[]}) => <String, Object?>{
      'project_id': 'p-1',
      'contract_id': null,
      'nodes': <Object?>[
        node('project', 'p-1', 'DA-001', status: 'IMPLEMENTATION', contract: null, facts: <String, Object?>{'name': 'Đường vành đai 1', 'created_at': '2026-01-01T00:00:00Z'}),
        node('contract', 'c-1', 'HD-A-001', status: 'ACTIVE', contract: null),
        node('contract', 'c-2', 'HD-A-002', status: 'ACTIVE', contract: null),
        node('payment_request', 'pr-1', 'PR-A-001', status: 'SENT_TREASURY', amount: '2350000000', facts: <String, Object?>{'request_kind': 'INTERIM', 'net_vnd': '2100000000', 'treasury_paid_on': null, 'created_at': '2026-10-05T09:00:00.000000Z'}),
        node('payment_request', 'pr-2', 'PR-A-002', status: 'SETTLED', amount: '1000000000', facts: <String, Object?>{'request_kind': 'ADVANCE', 'net_vnd': '1000000000', 'treasury_paid_on': '2026-10-20', 'created_at': '2026-09-01T02:00:00.000000Z'}),
        node('payment_request', 'pr-3', 'PR-B-001', status: 'DRAFT', contract: 'c-2', amount: '50000000', facts: <String, Object?>{'request_kind': 'FINAL', 'net_vnd': '45000000', 'treasury_paid_on': null, 'created_at': '2026-10-30T02:00:00.000000Z'}),
        node('treasury_transaction', 't-1', 'CT-0201', status: 'MATCHED', amount: '1000000000', facts: <String, Object?>{'direction': 'PAYMENT', 'confirmed_at': '2026-10-20T03:30:00.000000Z', 'created_at': '2026-10-20T04:00:00.000000Z'}),
        node('settlement_revision', 's-1', 'FINAL 2026', status: 'ACTIVE', amount: '1000000000', facts: <String, Object?>{'created_at': '2026-10-25T08:00:00.000000Z'}),
        ...?extraNodes,
      ],
      'edges': <Object?>[
        <String, Object?>{'from': 'p-1', 'to': 'c-1', 'relation': 'HAS_CONTRACT'},
        <String, Object?>{'from': 'pr-2', 'to': 't-1', 'relation': 'PAID_BY'},
        <String, Object?>{'from': 'pr-2', 'to': 's-1', 'relation': 'SETTLED_IN'},
      ],
      'totals': <String, Object?>{'counted_requests': 2, 'counted_gross_vnd': '3350000000', 'settled_gross_vnd': '1000000000'},
      'truncated': truncated,
      'as_of': '2026-11-02T09:00:00Z',
    };

/// The payment request as the detail operation gives it. The `actions` say the caller may do everything: the phone must offer none of it.
Map<String, Object?> paymentRequest(String id, {String no = 'PR-A-001', String status = 'SENT_TREASURY', String kind = 'INTERIM', String gross = '2350000000', String net = '2100000000', String? paidOn, String? reversedAt, String? returnReason}) => <String, Object?>{
      'id': id,
      'request_no': no,
      'request_kind': kind,
      'status': status,
      'contract': <String, Object?>{'id': 'c-1', 'code': 'HD-A-001', 'status': 'ACTIVE'},
      'project_id': 'p-1',
      'gross_vnd': gross,
      'advance_recovery_vnd': '150000000',
      'retention_vnd': '100000000',
      'tax_adjustment_vnd': '0',
      'advance_recovery_extra_vnd': '0',
      'net_vnd': net,
      'return_reason': returnReason,
      'cancel_reason': null,
      'submitted_at': '2026-10-05T10:00:00.000000Z',
      'treasury_submitted_on': '2026-10-06',
      'treasury_paid_on': paidOn,
      'reversed_at': reversedAt,
      'created_at': '2026-10-05T09:00:00.000000Z',
      'updated_at': '2026-10-06T09:00:00.000000Z',
      'actions': <String, Object?>{'revise': true, 'attach_document': true, 'cancel': true, 'submit': true, 'verify': true, 'return': true, 'generate_forms': true, 'send_treasury': true},
      'version': 7,
    };

Map<String, Object?> item(
  String id, {
  String kind = 'AMOUNT_MISMATCH',
  String status = 'OPEN',
  String? internal = '1000000000',
  String? confirmed = '990000000',
  String? difference = '-10000000',
  bool overdue = false,
  bool explain = true,
  bool resolve = true,
  String due = '2026-11-10T03:00:00Z',
  int version = 4,
  String? note,
}) =>
    <String, Object?>{
      'id': id,
      'kind': kind,
      'status': status,
      'project_id': 'p-1',
      'project_code': 'DA-001',
      'contract_id': 'c-1',
      'contract_code': 'HD-A-001',
      'payment_request_id': 'pr-2',
      'request_no': 'PR-A-002',
      'treasury_transaction_id': 't-1',
      'document_no': 'CT-0201',
      'source_file_name': 'sao-ke-2026-10.csv',
      'source_file_sha256': null,
      'internal_amount_vnd': internal,
      'confirmed_amount_vnd': confirmed,
      'difference_vnd': difference,
      'owner_membership_id': 'm-1',
      'owner_name': 'Trần Kế Toán Trưởng',
      'due_at': due,
      'overdue': overdue,
      'resolution_note': note,
      'resolved_by': null,
      'resolved_at': null,
      'approval_document_version_id': null,
      'issue_id': null,
      'version': version,
      'actions': <String, Object?>{'assign': true, 'explain': explain, 'resolve': resolve, 'write_off': true},
    };

Map<String, Object?> board(List<Map<String, Object?>> items, {int waiting = 2, int overdue = 1, String difference = '-10000000', String? next}) => <String, Object?>{
      'items': items,
      'next_cursor': next,
      'as_of': '2026-11-02T09:00:00Z',
      'summary': <String, Object?>{'waiting': waiting, 'overdue': overdue, 'waiting_difference_vnd': difference},
    };

Map<String, Object?> project(String id, String code, String name) => <String, Object?>{'id': id, 'code': code, 'name': name, 'status': 'IMPLEMENTATION', 'owner_unit_name': 'Ban QLDA giao thông'};
