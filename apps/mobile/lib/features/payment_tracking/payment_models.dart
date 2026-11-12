import '../../core/format/format.dart';
import '../read_support/wire.dart';

// Everything here is read from the server and shown. Money is a string of whole dong (never a number, never a float) and is shown
// exactly, in dong, so that 2.100.000.000 is never rounded to billions on a screen that an accountant checks against a voucher. Times are the
// server's instants; the clock of the phone is used for nothing on these screens.

const List<String> paymentStatuses = <String>['DRAFT', 'SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED', 'RETURNED', 'CANCELLED', 'REVERSED'];
const List<String> paymentKinds = <String>['ADVANCE', 'INTERIM', 'FINAL'];
const List<String> reconciliationKinds = <String>['AMOUNT_MISMATCH', 'UNMATCHED_TRANSACTION', 'MISSING_CONFIRMATION', 'DUPLICATE_CONFLICT', 'ADVANCE_OVERDUE'];
const List<String> reconciliationStatuses = <String>['OPEN', 'EXPLAINED', 'RESOLVED', 'WRITTEN_OFF_APPROVED'];

// ---- the chain of a project -----------------------------------------------------------------------------------------------------

/// One node of the chain of payments of a project (`getPaymentChain`): the record, its status, its code and its amount.
final class ChainNode {
  const ChainNode({required this.type, required this.id, required this.label, this.status, this.contractId, this.amountVnd, this.superseded = false, this.facts = const <String, Object?>{}});

  final String type;
  final String id;
  final String? status;
  final String label;
  final String? contractId;
  final String? amountVnd;
  final bool superseded;
  final Json facts;

  String? fact(String name) => filled(facts[name]);
}

ChainNode? parseChainNode(Object? raw) {
  final Json? row = asRecord(raw);
  final String? type = filled(row?['type']);
  final String? id = filled(row?['id']);
  if (row == null || type == null || id == null) return null;
  return ChainNode(
    type: type,
    id: id,
    label: text(row['label']) ?? id,
    status: filled(row['status']),
    contractId: filled(row['contract_id']),
    amountVnd: dong(row['amount_vnd']),
    superseded: row['superseded'] == true,
    facts: asRecord(row['facts']) ?? const <String, Object?>{},
  );
}

final class ChainEdge {
  const ChainEdge({required this.from, required this.to, required this.relation});

  final String from;
  final String to;
  final String relation;
}

/// The chain of a project: its contracts, its payment requests, the Treasury transactions of those and the settlements, with the totals
/// of the requests that count.
final class PaymentChain {
  const PaymentChain({required this.projectId, required this.nodes, required this.edges, required this.countedRequests, required this.countedGrossVnd, required this.settledGrossVnd, required this.truncated, this.asOf});

  final String projectId;
  final List<ChainNode> nodes;
  final List<ChainEdge> edges;
  final int countedRequests;
  final String countedGrossVnd;
  final String settledGrossVnd;

  /// The kinds of node of which the server holds more than it sent.
  final List<String> truncated;
  final String? asOf;

  List<ChainNode> nodesOf(String type) => <ChainNode>[
        for (final ChainNode node in nodes)
          if (node.type == type) node,
      ];

  ChainNode? nodeById(String id) {
    for (final ChainNode node in nodes) {
      if (node.id == id) return node;
    }
    return null;
  }

  /// The nodes a node leads to by [relation].
  List<ChainNode> linkedFrom(String id, String relation) => <ChainNode>[
        for (final ChainEdge edge in edges)
          if (edge.from == id && edge.relation == relation) ?nodeById(edge.to),
      ];

  /// The payment requests, in the order they were drawn up (the server gives them by creation time), optionally of one contract.
  List<ChainNode> requests({String? contractId}) => <ChainNode>[
        for (final ChainNode node in nodesOf('payment_request'))
          if (contractId == null || node.contractId == contractId) node,
      ];
}

PaymentChain? parseChain(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? totals = asRecord(row?['totals']);
  final String? projectId = filled(row?['project_id']);
  final String? counted = unsignedDong(totals?['counted_gross_vnd']);
  final String? settled = unsignedDong(totals?['settled_gross_vnd']);
  final int? requests = whole(totals?['counted_requests']);
  if (row == null || projectId == null || row['nodes'] is! List || counted == null || settled == null || requests == null) return null;
  return PaymentChain(
    projectId: projectId,
    nodes: <ChainNode>[for (final Object? item in listOf(row['nodes'])) ?parseChainNode(item)],
    edges: <ChainEdge>[
      for (final Object? item in listOf(row['edges']))
        if (filled(asRecord(item)?['from']) != null && filled(asRecord(item)?['to']) != null && filled(asRecord(item)?['relation']) != null)
          ChainEdge(from: asRecord(item)!['from']! as String, to: asRecord(item)!['to']! as String, relation: asRecord(item)!['relation']! as String),
    ],
    countedRequests: requests,
    countedGrossVnd: counted,
    settledGrossVnd: settled,
    truncated: <String>[
      for (final Object? type in listOf(row['truncated']))
        if (type is String) type,
    ],
    asOf: filled(row['as_of']),
  );
}

// ---- one payment request ----------------------------------------------------------------------------------------------------------

/// A payment request as `get_resources_payment_request_id` gives it: the figures and the moments the server recorded.
final class PaymentRequest {
  const PaymentRequest({
    required this.id,
    required this.requestNo,
    required this.kind,
    required this.status,
    required this.contractCode,
    required this.grossVnd,
    required this.netVnd,
    required this.advanceRecoveryVnd,
    required this.retentionVnd,
    this.taxAdjustmentVnd,
    this.advanceRecoveryExtraVnd,
    this.createdAt,
    this.submittedAt,
    this.treasurySubmittedOn,
    this.treasuryPaidOn,
    this.reversedAt,
    this.returnReason,
    this.cancelReason,
  });

  final String id;
  final String requestNo;
  final String kind;
  final String status;
  final String contractCode;
  final String grossVnd;
  final String netVnd;
  final String advanceRecoveryVnd;
  final String retentionVnd;
  final String? taxAdjustmentVnd;
  final String? advanceRecoveryExtraVnd;
  final String? createdAt;
  final String? submittedAt;

  /// The day the file went to the Treasury, and the day the Treasury paid.
  final String? treasurySubmittedOn;
  final String? treasuryPaidOn;
  final String? reversedAt;
  final String? returnReason;
  final String? cancelReason;
}

PaymentRequest? parsePaymentRequest(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? status = paymentStatuses.contains(row?['status']) ? row!['status'] as String : null;
  final String? kind = paymentKinds.contains(row?['request_kind']) ? row!['request_kind'] as String : null;
  final String? gross = unsignedDong(row?['gross_vnd']);
  final String? net = dong(row?['net_vnd']);
  if (row == null || id == null || status == null || kind == null || gross == null || net == null) return null;
  return PaymentRequest(
    id: id,
    requestNo: text(row['request_no']) ?? id,
    kind: kind,
    status: status,
    contractCode: text(asRecord(row['contract'])?['code']) ?? '',
    grossVnd: gross,
    netVnd: net,
    advanceRecoveryVnd: unsignedDong(row['advance_recovery_vnd']) ?? '0',
    retentionVnd: unsignedDong(row['retention_vnd']) ?? '0',
    taxAdjustmentVnd: dong(row['tax_adjustment_vnd']),
    advanceRecoveryExtraVnd: unsignedDong(row['advance_recovery_extra_vnd']),
    createdAt: filled(row['created_at']),
    submittedAt: filled(row['submitted_at']),
    treasurySubmittedOn: day(row['treasury_submitted_on']),
    treasuryPaidOn: day(row['treasury_paid_on']),
    reversedAt: filled(row['reversed_at']),
    returnReason: filled(row['return_reason']),
    cancelReason: filled(row['cancel_reason']),
  );
}

/// One thing that happened to a request, in the order of the process. A moment is an instant of the server or a day the server wrote.
final class TimelineEvent {
  const TimelineEvent({required this.kind, this.instant, this.day, this.amountVnd, this.label, this.detail});

  /// `created`, `submitted`, `sentTreasury`, `transaction`, `refund`, `paid`, `reversed`, `settlement`.
  final String kind;
  final String? instant;
  final String? day;
  final String? amountVnd;
  final String? label;
  final String? detail;
}

/// A request with what the chain knows around it: its Treasury transactions and the settlement it is part of.
final class PaymentTimeline {
  const PaymentTimeline({required this.request, required this.events, this.lastEventAt, this.asOf});

  final PaymentRequest request;
  final List<TimelineEvent> events;

  /// The latest instant the server gave for the request or its transactions.
  final String? lastEventAt;
  final String? asOf;
}

/// The timeline of a request: created, submitted, sent to the Treasury, the transactions the Treasury confirmed, paid, reversed, and the
/// settlement it belongs to. Only what the server recorded is on it; a step with no moment is left out, never guessed.
PaymentTimeline timelineOf(PaymentRequest request, PaymentChain chain) {
  final List<ChainNode> transactions = chain.linkedFrom(request.id, 'PAID_BY');
  final List<ChainNode> settlements = chain.linkedFrom(request.id, 'SETTLED_IN');
  final List<TimelineEvent> events = <TimelineEvent>[
    if (request.createdAt != null) TimelineEvent(kind: 'created', instant: request.createdAt, amountVnd: request.grossVnd),
    if (request.submittedAt != null) TimelineEvent(kind: 'submitted', instant: request.submittedAt),
    if (request.treasurySubmittedOn != null) TimelineEvent(kind: 'sentTreasury', day: request.treasurySubmittedOn),
    for (final ChainNode transaction in transactions)
      TimelineEvent(kind: transaction.fact('direction') == 'REFUND' ? 'refund' : 'transaction', instant: transaction.fact('confirmed_at'), amountVnd: transaction.amountVnd, label: transaction.label, detail: transaction.status),
    if (request.treasuryPaidOn != null) TimelineEvent(kind: 'paid', day: request.treasuryPaidOn, amountVnd: request.netVnd),
    if (request.reversedAt != null) TimelineEvent(kind: 'reversed', instant: request.reversedAt),
    for (final ChainNode settlement in settlements) TimelineEvent(kind: 'settlement', instant: settlement.fact('created_at'), amountVnd: settlement.amountVnd, label: settlement.label),
  ];
  String? latest;
  for (final TimelineEvent event in events) {
    final String? at = event.instant;
    final DateTime? when = at == null ? null : DateTime.tryParse(at);
    if (at != null && when != null && (latest == null || when.isAfter(DateTime.parse(latest)))) latest = at;
  }
  return PaymentTimeline(request: request, events: events, lastEventAt: latest, asOf: chain.asOf);
}

/// From `{chain, request}`: the request read in full and the chain around it.
PaymentTimeline? parsePaymentTimeline(Object? raw) {
  final Json? body = asRecord(raw);
  final PaymentChain? chain = parseChain(body?['chain']);
  final PaymentRequest? request = parsePaymentRequest(body?['request']);
  if (chain == null || request == null) return null;
  return timelineOf(request, chain);
}

// ---- Treasury reconciliation -------------------------------------------------------------------------------------------------------

/// What the server says the person may do with an item.
final class ItemActions {
  const ItemActions({required this.explain, required this.resolve});

  final bool explain;
  final bool resolve;
}

/// One difference between what the accountant's side recorded and what the Treasury confirmed (`listReconciliationItems`).
final class ReconciliationItem {
  const ReconciliationItem({
    required this.id,
    required this.version,
    required this.kind,
    required this.status,
    required this.projectCode,
    required this.dueAt,
    required this.overdue,
    required this.actions,
    this.contractCode,
    this.requestNo,
    this.documentNo,
    this.sourceFileName,
    this.internalVnd,
    this.confirmedVnd,
    this.differenceVnd,
    this.ownerName,
    this.resolutionNote,
    this.resolvedAt,
  });

  final String id;
  final int version;
  final String kind;
  final String status;
  final String projectCode;
  final String? contractCode;
  final String? requestNo;
  final String? documentNo;
  final String? sourceFileName;

  /// The amount on the side of the accountant, the amount the Treasury confirmed, and the difference the server worked out. The phone shows
  /// the three and chooses none of them.
  final String? internalVnd;
  final String? confirmedVnd;
  final String? differenceVnd;
  final String? ownerName;
  final String dueAt;

  /// The word of the server, never the clock of the phone.
  final bool overdue;
  final String? resolutionNote;
  final String? resolvedAt;
  final ItemActions actions;

  bool get isWaiting => status == 'OPEN' || status == 'EXPLAINED';

  /// Whether both figures are there to put side by side.
  bool get hasBothFigures => internalVnd != null && confirmedVnd != null;

  /// The difference as the server gave it; when it gave none, the confirmed figure less the internal one, worked out on whole dong.
  String? get shownDifference => differenceVnd ?? (hasBothFigures ? differenceDong(confirmedVnd!, internalVnd!) : null);
}

ReconciliationItem? parseReconciliationItem(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? actions = asRecord(row?['actions']);
  final String? id = filled(row?['id']);
  final int? version = whole(row?['version']);
  final String? kind = reconciliationKinds.contains(row?['kind']) ? row!['kind'] as String : null;
  final String? status = reconciliationStatuses.contains(row?['status']) ? row!['status'] as String : null;
  final String? dueAt = filled(row?['due_at']);
  if (row == null || id == null || version == null || kind == null || status == null || dueAt == null) return null;
  return ReconciliationItem(
    id: id,
    version: version,
    kind: kind,
    status: status,
    projectCode: text(row['project_code']) ?? '',
    contractCode: filled(row['contract_code']),
    requestNo: filled(row['request_no']),
    documentNo: filled(row['document_no']),
    sourceFileName: filled(row['source_file_name']),
    internalVnd: dong(row['internal_amount_vnd']),
    confirmedVnd: dong(row['confirmed_amount_vnd']),
    differenceVnd: dong(row['difference_vnd']),
    ownerName: filled(row['owner_name']),
    dueAt: dueAt,
    overdue: row['overdue'] == true,
    resolutionNote: filled(row['resolution_note']),
    resolvedAt: filled(row['resolved_at']),
    actions: ItemActions(explain: actions?['explain'] == true, resolve: actions?['resolve'] == true),
  );
}

/// The items in the scope of the person, with the server's own count of what waits.
final class ReconciliationBoard {
  const ReconciliationBoard({required this.items, required this.waiting, required this.overdue, required this.waitingDifferenceVnd, required this.more, this.asOf});

  final List<ReconciliationItem> items;
  final int waiting;
  final int overdue;
  final String waitingDifferenceVnd;
  final bool more;
  final String? asOf;
}

ReconciliationBoard? parseReconciliationBoard(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  final Json? summary = asRecord(body['summary']);
  final List<ReconciliationItem> items = <ReconciliationItem>[for (final Object? item in listOf(body['items'])) ?parseReconciliationItem(item)];
  // The late ones first, then by the day they are due.
  items.sort((ReconciliationItem a, ReconciliationItem b) {
    if (a.overdue != b.overdue) return a.overdue ? -1 : 1;
    final int byDue = a.dueAt.compareTo(b.dueAt);
    return byDue != 0 ? byDue : a.id.compareTo(b.id);
  });
  return ReconciliationBoard(
    items: items,
    waiting: count(summary?['waiting']),
    overdue: count(summary?['overdue']),
    waitingDifferenceVnd: dong(summary?['waiting_difference_vnd']) ?? '0',
    more: filled(body['next_cursor']) != null,
    asOf: filled(body['as_of']),
  );
}
