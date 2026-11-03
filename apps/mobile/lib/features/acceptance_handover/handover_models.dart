import '../read_support/wire.dart';

const List<String> handoverKinds = <String>['PARTIAL', 'COMPLETION', 'ASSET_TRANSFER'];
const List<String> handoverStatuses = <String>['DRAFT', 'INSPECTING', 'PUNCH_PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'];
const List<String> punchSeverities = <String>['CRITICAL', 'MAJOR', 'MINOR'];
const List<String> punchStatuses = <String>['OPEN', 'FIXED', 'VERIFIED', 'WAIVED'];
const List<String> warrantyStatuses = <String>['ACTIVE', 'EXPIRED', 'CLOSED'];

/// One handover of a work to the unit that receives it (`/resources/handover`, AST-01).
final class HandoverLine {
  const HandoverLine({
    required this.id,
    required this.handoverNo,
    required this.kind,
    required this.status,
    required this.contractCode,
    required this.recipientName,
    required this.itemCount,
    required this.openCriticalCount,
    this.plannedOn,
    this.handedOn,
    this.acceptedAt,
    this.rejectionReason,
  });

  final String id;
  final String handoverNo;
  final String kind;
  final String status;
  final String contractCode;

  /// The unit that receives the work (the recipient), by name.
  final String recipientName;

  /// How many defects were put on the punch list, whatever their state.
  final int itemCount;

  /// The critical defects not yet verified: while one is open the handover cannot be accepted.
  final int openCriticalCount;
  final String? plannedOn;
  final String? handedOn;
  final String? acceptedAt;
  final String? rejectionReason;

  bool get isDecided => status == 'ACCEPTED' || status == 'REJECTED' || status == 'CANCELLED';
}

HandoverLine? parseHandover(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? contract = asRecord(row?['contract']);
  final Json? unit = asRecord(row?['recipient_unit']);
  final String? id = filled(row?['id']);
  final String? kind = handoverKinds.contains(row?['handover_kind']) ? row!['handover_kind'] as String : null;
  final String? status = handoverStatuses.contains(row?['status']) ? row!['status'] as String : null;
  if (row == null || id == null || kind == null || status == null) return null;
  return HandoverLine(
    id: id,
    handoverNo: text(row['handover_no']) ?? '',
    kind: kind,
    status: status,
    contractCode: text(contract?['code']) ?? '',
    recipientName: text(unit?['name']) ?? '',
    itemCount: count(row['punch_item_count']),
    openCriticalCount: count(row['open_critical_punch_count']),
    plannedOn: day(row['planned_on']),
    handedOn: day(row['handed_on']),
    acceptedAt: filled(row['accepted_at']),
    rejectionReason: filled(row['rejection_reason']),
  );
}

/// A warranty obligation of a handed over work (`/warranty-obligations`, AST-04). Its status is the server's word for the day:
/// an obligation whose last day has come is already `EXPIRED`, so the phone never counts days with its own clock.
final class WarrantyLine {
  const WarrantyLine({
    required this.id,
    required this.handoverId,
    required this.contractCode,
    required this.scope,
    required this.startsOn,
    required this.endsOn,
    required this.periodMonths,
    required this.status,
    required this.openClaims,
    required this.totalClaims,
    this.assetName,
  });

  final String id;
  final String handoverId;
  final String contractCode;
  final String scope;
  final String? assetName;
  final String startsOn;
  final String endsOn;
  final int periodMonths;
  final String status;
  final int openClaims;
  final int totalClaims;
}

WarrantyLine? parseWarranty(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? status = warrantyStatuses.contains(row?['status']) ? row!['status'] as String : null;
  final String? startsOn = day(row?['starts_on']);
  final String? endsOn = day(row?['ends_on']);
  final int? months = whole(row?['period_months']);
  if (row == null || id == null || status == null || startsOn == null || endsOn == null || months == null) return null;
  return WarrantyLine(
    id: id,
    handoverId: filled(asRecord(row['handover'])?['id']) ?? '',
    contractCode: text(asRecord(row['contract'])?['code']) ?? '',
    scope: text(row['scope_description']) ?? '',
    assetName: filled(asRecord(row['asset'])?['name']) ?? filled(asRecord(row['asset'])?['asset_code']),
    startsOn: startsOn,
    endsOn: endsOn,
    periodMonths: months,
    status: status,
    openClaims: count(row['open_claims']),
    totalClaims: count(row['total_claims']),
  );
}

/// The handovers and the warranty obligations in the scope of the reader. The warranties are a separate right (`warranty.read`):
/// a reader without it sees the handovers, and the screen says the warranties are not theirs to read (they are not shown as none).
final class HandoverRegister {
  const HandoverRegister({required this.handovers, required this.warranties, required this.warrantiesRefused, this.asOf});

  final List<HandoverLine> handovers;
  final List<WarrantyLine> warranties;
  final bool warrantiesRefused;
  final String? asOf;

  List<WarrantyLine> warrantiesOf(String handoverId) => <WarrantyLine>[
        for (final WarrantyLine warranty in warranties)
          if (warranty.handoverId == handoverId) warranty,
      ];
}

/// From `{handovers: {items, as_of}, warranties: {items} | null, warranties_refused: bool}`.
HandoverRegister? parseHandoverRegister(Object? raw) {
  final Json? body = asRecord(raw);
  final Json? handovers = asRecord(body?['handovers']);
  if (body == null || handovers == null || handovers['items'] is! List) return null;
  final List<HandoverLine> lines = <HandoverLine>[for (final Object? item in listOf(handovers['items'])) ?parseHandover(item)];
  // Open defects first, then the handovers still being worked on, the decided ones last; by number within each.
  lines.sort((HandoverLine a, HandoverLine b) {
    if ((a.openCriticalCount > 0) != (b.openCriticalCount > 0)) return a.openCriticalCount > 0 ? -1 : 1;
    if (a.isDecided != b.isDecided) return a.isDecided ? 1 : -1;
    return a.handoverNo.compareTo(b.handoverNo);
  });
  return HandoverRegister(
    handovers: lines,
    warranties: <WarrantyLine>[for (final Object? item in listOf(asRecord(body['warranties'])?['items'])) ?parseWarranty(item)],
    warrantiesRefused: body['warranties_refused'] == true,
    asOf: filled(handovers['as_of']),
  );
}

/// One defect on the punch list of a handover.
final class PunchItem {
  const PunchItem({required this.id, required this.itemNo, required this.description, required this.severity, required this.status, required this.overdue, this.dueOn, this.locationText, this.contractorName});

  final String id;
  final int itemNo;
  final String description;
  final String severity;
  final String status;
  final bool overdue;
  final String? dueOn;
  final String? locationText;
  final String? contractorName;

  /// Defects that stand between the handover and its acceptance: not yet verified or waived.
  bool get isOpen => status == 'OPEN' || status == 'FIXED';
}

PunchItem? parsePunchItem(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final int? itemNo = whole(row?['item_no']);
  final String? severity = punchSeverities.contains(row?['severity']) ? row!['severity'] as String : null;
  final String? status = punchStatuses.contains(row?['status']) ? row!['status'] as String : null;
  if (row == null || id == null || itemNo == null || severity == null || status == null) return null;
  return PunchItem(
    id: id,
    itemNo: itemNo,
    description: text(row['description']) ?? '',
    severity: severity,
    status: status,
    overdue: row['overdue'] == true,
    dueOn: day(row['due_on']),
    locationText: filled(row['location_text']),
    contractorName: filled(asRecord(row['responsible_contractor'])?['name']),
  );
}

/// A handover with its punch list and the warranties it gave rise to.
final class HandoverTrace {
  const HandoverTrace({required this.handover, required this.items, required this.warranties, required this.warrantiesRefused});

  final HandoverLine handover;
  final List<PunchItem> items;
  final List<WarrantyLine> warranties;
  final bool warrantiesRefused;

  int get openItems => items.where((PunchItem item) => item.isOpen).length;
}

/// From `{trace: <getHandoverTrace>, warranties: {items} | null, warranties_refused: bool}`.
HandoverTrace? parseHandoverTrace(Object? raw) {
  final Json? body = asRecord(raw);
  final Json? trace = asRecord(body?['trace']);
  final HandoverLine? handover = parseHandover(trace?['handover']);
  if (body == null || trace == null || handover == null) return null;
  return HandoverTrace(
    handover: handover,
    items: <PunchItem>[for (final Object? item in listOf(trace['items'])) ?parsePunchItem(item)],
    warranties: <WarrantyLine>[for (final Object? item in listOf(asRecord(body['warranties'])?['items'])) ?parseWarranty(item)],
    warrantiesRefused: body['warranties_refused'] == true,
  );
}
