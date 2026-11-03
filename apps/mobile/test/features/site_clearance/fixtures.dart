export '../acceptance_handover/fixtures.dart' show page, problem, recorded;

/// What the server says about a household in a list: the masked name, identity number, telephone and address are all there, because the
/// tests must show that the phone does not keep them.
Map<String, Object?> household(
  String id, {
  String code = 'HH-A-001',
  String status = 'REGISTERED',
  String basis = 'PUBLIC_TASK_LAND_LAW',
  String? consent,
  bool restricted = false,
  bool anonymised = false,
  List<Map<String, Object?>>? parcels,
}) =>
    <String, Object?>{
      'id': id,
      'project_id': 'p-1',
      'owner_unit_id': 'u-1',
      'household_code': code,
      'head_name_masked': 'Nguyễn V** A',
      'national_id_masked': '•••••••0001',
      'phone_masked': '•••••••001',
      'address_masked': '***, Quận 1',
      'member_count': 4,
      'policy_beneficiary': true,
      'legal_basis': basis,
      'legal_basis_ref': 'QĐ-123/UBND',
      'consent_record_id': consent,
      'retention_until': '2030-01-01',
      'dsr_open': false,
      'processing_restricted': restricted,
      'anonymised': anonymised,
      'status': status,
      'parcels': parcels ??
          <Map<String, Object?>>[
            <String, Object?>{'id': 'hp-1', 'parcel_id': 'pa-1', 'parcel_code': 'TH-001', 'right_kind': 'OWNER', 'share_pct': '100'},
          ],
      'created_at': '2026-10-01T00:00:00Z',
      'version': 3,
    };

Map<String, Object?> parcel(String id, String code, {String right = 'OWNER'}) => <String, Object?>{'id': 'hp-$id', 'parcel_id': id, 'parcel_code': code, 'right_kind': right, 'share_pct': '50'};

Map<String, Object?> record(
  String id, {
  String status = 'DRAFT',
  String surveyedBy = 'mem-9',
  int version = 2,
  String kind = 'HOUSE',
  String description = 'Nhà cấp 4, tường gạch',
  String quantity = '80',
  String price = '4500000',
  String amount = '360000000',
  String? note,
}) =>
    <String, Object?>{
      'id': id,
      'household_id': 'h-1',
      'parcel_id': 'pa-1',
      'parcel_code': 'TH-001',
      'owner_unit_id': 'u-1',
      'item_kind': kind,
      'description': description,
      'quantity': quantity,
      'unit_code': 'm2',
      'unit_price_vnd': price,
      'amount_vnd': amount,
      'price_decision_ref': 'QD-GIA-2026',
      'price_decision_revision': 1,
      'surveyed_on': '2026-10-20',
      'surveyed_by': surveyedBy,
      'household_confirmed_on': null,
      'household_dispute': false,
      'confirmed_by': null,
      'note': note,
      'evidence_photo_id': null,
      'document_version_id': null,
      'status': status,
      'version': version,
    };

Map<String, Object?> project(String id, String code, String name) => <String, Object?>{
      'id': id,
      'code': code,
      'name': name,
      'status': 'IMPLEMENTATION',
      'owner_unit_name': 'Ban QLDA giao thông',
    };
