import '../read_support/wire.dart';

/// The roles that sign quality acceptance minutes (QMS 3.2). The server names the ones a set of minutes requires.
const List<String> signerRoles = <String>['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'];

/// How a signature is made. Only a digital certificate is a legal electronic signature; an in-app confirmation is an internal
/// record (BR-QMS-03), and the screens never call it a digital signature.
const List<String> signatureMethods = <String>['IN_APP_OTP', 'IN_APP_WEBAUTHN', 'DIGITAL_CERT'];

const List<String> acceptanceScopes = <String>['WORK_ITEM', 'STAGE', 'PART', 'COMPLETION'];

/// DRAFT and SIGNING minutes are those that still wait for signatures or a decision.
const List<String> acceptanceStatuses = <String>['DRAFT', 'SIGNING', 'APPROVED', 'REJECTED', 'REVOKED'];

/// `INTERNAL_RECORD` or `LEGAL_E_SIGNATURE`: what a signature is worth (BR-QMS-03).
String legalEffectOf(String method) => method == 'DIGITAL_CERT' ? 'LEGAL_E_SIGNATURE' : 'INTERNAL_RECORD';

List<String> _roles(Object? value) => <String>[
      for (final Object? role in listOf(value))
        if (role is String && signerRoles.contains(role)) role,
    ];

/// One signature on a set of minutes.
final class MinutesSignature {
  const MinutesSignature({required this.role, required this.signerName, required this.method, required this.legalEffect, required this.signedAt, required this.valid, this.certSerial});

  final String role;
  final String signerName;
  final String method;
  final String legalEffect;
  final String signedAt;
  final String? certSerial;

  /// Whether it is over the hash the minutes carry now; one that is not is void.
  final bool valid;
}

MinutesSignature? _signature(Object? raw) {
  final Json? row = asRecord(raw);
  final String? role = signerRoles.contains(row?['role']) ? row!['role'] as String : null;
  final String? method = signatureMethods.contains(row?['method']) ? row!['method'] as String : null;
  final String? effect = row?['legal_effect'] == 'LEGAL_E_SIGNATURE' || row?['legal_effect'] == 'INTERNAL_RECORD' ? row!['legal_effect'] as String : null;
  final String? at = filled(row?['signed_at']);
  if (row == null || role == null || method == null || effect == null || at == null) return null;
  return MinutesSignature(role: role, signerName: text(row['signer_name']) ?? '', method: method, legalEffect: effect, signedAt: at, certSerial: filled(row['cert_serial']), valid: row['valid'] == true);
}

/// One set of quality acceptance minutes as MOB-65 shows it (`listQualityAcceptances`, `getQualityAcceptance`).
final class Minutes {
  const Minutes({
    required this.id,
    required this.version,
    required this.recordNo,
    required this.status,
    required this.scope,
    required this.contractCode,
    required this.inspectionNo,
    required this.requiredRoles,
    required this.signatures,
    required this.missingRoles,
    required this.openCriticalNcr,
    required this.awaitingConfirmation,
    required this.signableRoles,
    required this.canSign,
    required this.canApprove,
    required this.canReject,
    this.inspectionType,
    this.boqItemKey,
    this.documentVersionId,
    this.regimeLabel,
    this.regimeCxn,
    this.decisionNote,
    this.approvedBy,
    this.createdBy,
    this.asOf,
  });

  final String id;

  /// The version the screen saw: a command is sent under it (`If-Match`), so minutes that moved meanwhile are a conflict.
  final int version;
  final String recordNo;
  final String status;
  final String scope;
  final String contractCode;
  final String inspectionNo;
  final String? inspectionType;

  /// The bill-of-quantities item the minutes accept; null for minutes that accept a stage, a part or the completion.
  final String? boqItemKey;

  /// The paper of the minutes (a clean file version); its number is shown, the file itself is not opened on the phone.
  final String? documentVersionId;
  final List<String> requiredRoles;
  final List<MinutesSignature> signatures;
  final List<String> missingRoles;
  final int openCriticalNcr;
  final bool awaitingConfirmation;
  final String? regimeLabel;
  final String? regimeCxn;
  final String? decisionNote;
  final String? approvedBy;
  final String? createdBy;
  final List<String> signableRoles;
  final bool canSign;
  final bool canApprove;
  final bool canReject;
  final String? asOf;

  /// Minutes that still wait for signatures or for the decision.
  bool get isOpen => status == 'DRAFT' || status == 'SIGNING';

  /// The signature of a role, when it signed over the minutes as they are.
  MinutesSignature? signatureOf(String role) {
    for (final MinutesSignature signature in signatures) {
      if (signature.role == role && signature.valid) return signature;
    }
    return null;
  }
}

Minutes? parseMinutes(Object? raw, {String? asOf}) {
  final Json? row = asRecord(raw);
  final Json? contract = asRecord(row?['contract']);
  final Json? inspection = asRecord(row?['inspection']);
  final String? id = filled(row?['id']);
  final int? version = whole(row?['version']);
  final String? status = acceptanceStatuses.contains(row?['status']) ? row!['status'] as String : null;
  final String? scope = acceptanceScopes.contains(row?['acceptance_scope']) ? row!['acceptance_scope'] as String : null;
  final String? contractId = filled(contract?['id']);
  final String? inspectionId = filled(inspection?['id']);
  if (row == null || id == null || version == null || status == null || scope == null || contractId == null || inspectionId == null) return null;
  final Json? regime = asRecord(row['regime']);
  final Json? actions = asRecord(row['actions']);
  return Minutes(
    id: id,
    version: version,
    recordNo: text(row['record_no']) ?? '',
    status: status,
    scope: scope,
    contractCode: text(contract?['code']) ?? '',
    inspectionNo: text(inspection?['inspection_no']) ?? '',
    inspectionType: filled(inspection?['inspection_type']),
    boqItemKey: filled(asRecord(row['boq_item'])?['business_key']),
    documentVersionId: filled(row['document_version_id']),
    requiredRoles: _roles(row['required_roles']),
    signatures: <MinutesSignature>[for (final Object? item in listOf(row['signatures'])) ?_signature(item)],
    missingRoles: _roles(row['missing_roles']),
    openCriticalNcr: count(row['open_critical_ncr']),
    awaitingConfirmation: regime?['awaiting_confirmation'] == true,
    regimeLabel: filled(regime?['label']),
    regimeCxn: filled(regime?['cxn']),
    decisionNote: filled(row['decision_note']),
    approvedBy: filled(asRecord(row['approved_by'])?['display_name']),
    createdBy: filled(asRecord(row['created_by'])?['display_name']),
    signableRoles: _roles(row['signable_roles']),
    canSign: actions?['sign'] == true,
    canApprove: actions?['approve'] == true,
    canReject: actions?['reject'] == true,
    asOf: asOf ?? filled(row['as_of']),
  );
}

/// The minutes in the scope of the person that still wait for signatures or a decision, those the person can act on first.
final class MinutesList {
  const MinutesList({required this.items, this.asOf});

  final List<Minutes> items;
  final String? asOf;
}

MinutesList? parseMinutesList(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  final String? asOf = filled(body['as_of']);
  final List<Minutes> open = <Minutes>[
    for (final Object? item in listOf(body['items']))
      if (parseMinutes(item, asOf: asOf) case final Minutes minutes when minutes.isOpen) minutes,
  ];
  open.sort((Minutes a, Minutes b) {
    final bool aMine = a.canSign || a.canApprove || a.canReject;
    final bool bMine = b.canSign || b.canApprove || b.canReject;
    if (aMine != bMine) return aMine ? -1 : 1;
    return a.recordNo.compareTo(b.recordNo);
  });
  return MinutesList(items: open, asOf: asOf);
}
