import '../read_support/wire.dart';

/// The status of a directive as a reader sees it (OVERDUE is an open directive past its due day; the server computes it, the phone never
/// judges a day).
enum DirectiveStatus { open, inProgress, done, overdue, cancelled }

DirectiveStatus? directiveStatusOf(Object? value) {
  switch (value) {
    case 'OPEN':
      return DirectiveStatus.open;
    case 'IN_PROGRESS':
      return DirectiveStatus.inProgress;
    case 'DONE':
      return DirectiveStatus.done;
    case 'OVERDUE':
      return DirectiveStatus.overdue;
    case 'CANCELLED':
      return DirectiveStatus.cancelled;
  }
  return null;
}

/// Where a directive stands on its clock, as the server says it (`phase`).
enum DirectivePhase { dueLater, dueSoon, dueToday, overdue, escalated, ended }

DirectivePhase? directivePhaseOf(Object? value) {
  switch (value) {
    case 'DUE_LATER':
      return DirectivePhase.dueLater;
    case 'DUE_SOON':
      return DirectivePhase.dueSoon;
    case 'DUE_TODAY':
      return DirectivePhase.dueToday;
    case 'OVERDUE':
      return DirectivePhase.overdue;
    case 'ESCALATED':
      return DirectivePhase.escalated;
    case 'ENDED':
      return DirectivePhase.ended;
  }
  return null;
}

/// The three views of the list: what is given to the reader, what is late, and everything in the scope.
enum DirectiveFilter { mine, overdue, all }

/// The query of the list operation for a view.
Map<String, Object?> directiveQuery(DirectiveFilter filter) => <String, Object?>{
      'limit': 50,
      if (filter == DirectiveFilter.mine) 'assigned_to_me': 'true',
      if (filter == DirectiveFilter.overdue) 'overdue': 'true',
    };

/// A directive of the list.
final class DirectiveLine {
  const DirectiveLine({
    required this.id,
    required this.code,
    required this.text,
    required this.status,
    required this.phase,
    required this.dueOn,
    required this.assigneeUnit,
    this.assignee,
    this.projectCode,
    this.daysToDue,
    this.overdueDays,
    this.evidenceCount = 0,
    this.extensionPending = false,
  });

  final String id;
  final String code;
  final String text;
  final DirectiveStatus status;
  final DirectivePhase phase;
  final String dueOn;
  final String assigneeUnit;
  final String? assignee;
  final String? projectCode;

  /// Days to the due day (negative when past), as the server counted them; null once the directive has ended.
  final int? daysToDue;
  final int? overdueDays;
  final int evidenceCount;

  /// A request to move the due day waits for a decision.
  final bool extensionPending;

  /// Overdue by the escalation days or more: the head of the unit has been told.
  bool get escalated => phase == DirectivePhase.escalated;
}

/// A directive of the list, or null when the row is not one (the screen then shows a contract mismatch, never half a row).
DirectiveLine? parseDirectiveLine(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = filled(row?['code']);
  final String? body = text(row?['text']);
  final DirectiveStatus? status = directiveStatusOf(row?['status']);
  final DirectivePhase? phase = directivePhaseOf(row?['phase']);
  final String? due = day(row?['due_on']);
  final Json? unit = asRecord(row?['assignee_unit']);
  final String? unitName = text(unit?['name']);
  if (row == null || id == null || code == null || body == null || status == null || phase == null || due == null || unitName == null) return null;
  final Json? person = asRecord(row['assignee']);
  final Json? project = asRecord(row['project']);
  return DirectiveLine(
    id: id,
    code: code,
    text: body,
    status: status,
    phase: phase,
    dueOn: due,
    assigneeUnit: unitName,
    assignee: filled(person?['display_name']),
    projectCode: filled(project?['code']),
    daysToDue: whole(row['days_to_due']),
    overdueDays: whole(row['overdue_days']),
    evidenceCount: count(row['evidence_count']),
    extensionPending: asRecord(row['open_extension']) != null,
  );
}

/// The policy in force with where it came from: a built-in default is not confirmed with the client and the audit, and says so.
final class DirectivePolicyNote {
  const DirectivePolicyNote({required this.unverified});

  final bool unverified;
}

/// The counts of the header and the words of how each is counted, as the server gave them.
final class DirectiveSummary {
  const DirectiveSummary({required this.overdue, required this.dueSoon, required this.escalated, required this.open, required this.total, required this.policy, this.definitions = const <String, String>{}, this.truncated = false});

  final int overdue;
  final int dueSoon;
  final int escalated;

  /// Open and in progress, that is, not yet done and not cancelled and not yet late.
  final int open;
  final int total;
  final DirectivePolicyNote policy;

  /// The formula of each number (`by_status`, `due_soon`, `escalated`).
  final Map<String, String> definitions;
  final bool truncated;
}

DirectiveSummary? parseDirectiveSummary(Object? raw) {
  final Json? body = asRecord(raw);
  final Json? status = asRecord(body?['by_status']);
  if (body == null || status == null || whole(body['total']) == null || whole(body['due_soon']) == null || whole(body['escalated']) == null) return null;
  final Json? definitions = asRecord(body['definitions']);
  final Json? policy = asRecord(body['policy']);
  return DirectiveSummary(
    overdue: count(status['OVERDUE']),
    dueSoon: count(body['due_soon']),
    escalated: count(body['escalated']),
    open: count(status['OPEN']) + count(status['IN_PROGRESS']),
    total: count(body['total']),
    policy: DirectivePolicyNote(unverified: policy?['unverified'] != false),
    definitions: <String, String>{
      for (final String key in const <String>['by_status', 'due_soon', 'escalated'])
        if (filled(definitions?[key]) != null) key: definitions![key]! as String,
    },
    truncated: body['truncated'] == true,
  );
}

/// The directives on a dashboard (`getDirectiveWidget`): the three counts a leader looks at first, the oldest overdue directives, and the words of how each
/// count is made. Loading is never 0 and a failure is never "nothing is late": the dashboard says which.
final class DirectiveWidgetData {
  const DirectiveWidgetData({required this.overdue, required this.dueSoon, required this.escalated, required this.open, required this.items, required this.policy, required this.asOf, this.definitions = const <String, String>{}, this.truncated = false});

  final int overdue;
  final int dueSoon;
  final int escalated;
  final int open;

  /// The oldest overdue directives, each opening the directive.
  final List<DirectiveLine> items;
  final DirectivePolicyNote policy;

  /// The formula of each number (`overdue`, `due_soon`, `escalated`), in the words of the server.
  final Map<String, String> definitions;
  final bool truncated;

  /// The instant the server counted at.
  final String asOf;
}

/// The widget, or null when the answer is not one (the dashboard then shows a contract mismatch, never half a card).
DirectiveWidgetData? parseDirectiveWidget(Object? raw) {
  final Json? body = asRecord(raw);
  final Json? counts = asRecord(body?['counts']);
  final String? asOf = filled(body?['as_of']);
  if (body == null || counts == null || asOf == null || whole(counts['overdue']) == null || whole(counts['due_soon']) == null || whole(counts['escalated']) == null || body['items'] is! List) return null;
  final List<DirectiveLine> items = <DirectiveLine>[];
  for (final Object? row in listOf(body['items'])) {
    final DirectiveLine? line = parseDirectiveLine(row);
    if (line == null) return null;
    items.add(line);
  }
  final Json? definitions = asRecord(body['definitions']);
  final Json? policy = asRecord(body['policy']);
  return DirectiveWidgetData(
    overdue: count(counts['overdue']),
    dueSoon: count(counts['due_soon']),
    escalated: count(counts['escalated']),
    open: count(counts['open']),
    items: items,
    policy: DirectivePolicyNote(unverified: policy?['unverified'] != false),
    definitions: <String, String>{
      for (final String key in const <String>['overdue', 'due_soon', 'escalated'])
        if (filled(definitions?[key]) != null) key: definitions![key]! as String,
    },
    truncated: body['truncated'] == true,
    asOf: asOf,
  );
}

/// What one read of the screen holds: the list, and the counts when they could be read (a refusal of the counts does not take the list down; a
/// lost connection does).
final class DirectiveList {
  const DirectiveList({required this.lines, required this.summary, required this.summaryFailed, required this.more, this.asOf});

  final List<DirectiveLine> lines;
  final DirectiveSummary? summary;
  final bool summaryFailed;

  /// The list was cut at the pages the phone reads: there are more directives than shown.
  final bool more;
  final String? asOf;
}

DirectiveList? parseDirectiveList(Object? raw) {
  final Json? body = asRecord(raw);
  final Json? list = asRecord(body?['list']);
  if (body == null || list == null || list['items'] is! List) return null;
  final List<DirectiveLine> lines = <DirectiveLine>[];
  for (final Object? row in listOf(list['items'])) {
    final DirectiveLine? line = parseDirectiveLine(row);
    if (line == null) return null;
    lines.add(line);
  }
  final Object? summaryRaw = body['summary'];
  final DirectiveSummary? summary = summaryRaw == null ? null : parseDirectiveSummary(summaryRaw);
  return DirectiveList(
    lines: lines,
    summary: summary,
    summaryFailed: body['summary_failed'] == true || (summaryRaw != null && summary == null),
    more: filled(list['next_cursor']) != null,
    asOf: filled(asRecord(summaryRaw)?['as_of']) ?? filled(list['as_of']),
  );
}

/// The kinds of event of the timeline.
enum DirectiveEventKind { created, assigned, progress, extensionRequested, extensionApproved, extensionRejected, closed, cancelled, reopened }

DirectiveEventKind? directiveEventKindOf(Object? value) {
  switch (value) {
    case 'CREATED':
      return DirectiveEventKind.created;
    case 'ASSIGNED':
      return DirectiveEventKind.assigned;
    case 'PROGRESS':
      return DirectiveEventKind.progress;
    case 'EXTENSION_REQUESTED':
      return DirectiveEventKind.extensionRequested;
    case 'EXTENSION_APPROVED':
      return DirectiveEventKind.extensionApproved;
    case 'EXTENSION_REJECTED':
      return DirectiveEventKind.extensionRejected;
    case 'CLOSED':
      return DirectiveEventKind.closed;
    case 'CANCELLED':
      return DirectiveEventKind.cancelled;
    case 'REOPENED':
      return DirectiveEventKind.reopened;
  }
  return null;
}

final class DirectiveEvent {
  const DirectiveEvent({required this.kind, required this.actor, required this.at, this.note, this.progressPct, this.fromDueOn, this.toDueOn, this.toUnit});

  final DirectiveEventKind kind;
  final String actor;
  final String at;
  final String? note;
  final int? progressPct;
  final String? fromDueOn;
  final String? toDueOn;
  final String? toUnit;
}

enum ExtensionState { requested, approved, rejected }

final class DirectiveExtension {
  const DirectiveExtension({required this.state, required this.fromDueOn, required this.proposedDueOn, required this.reason, required this.requestedBy, this.decidedBy, this.decisionReason});

  final ExtensionState state;
  final String fromDueOn;
  final String proposedDueOn;
  final String reason;
  final String requestedBy;
  final String? decidedBy;
  final String? decisionReason;
}

final class DirectiveEvidence {
  const DirectiveEvidence({required this.title, required this.addedBy, required this.addedAt});

  final String? title;
  final String addedBy;
  final String addedAt;
}

/// One directive with its timeline, requests to move the due day and evidence (read only on the phone).
final class DirectiveDetail {
  const DirectiveDetail({required this.directive, required this.originalDueOn, required this.extensionCount, required this.meetingCode, required this.events, required this.extensions, required this.evidence, this.asOf});

  final DirectiveLine directive;
  final String originalDueOn;
  final int extensionCount;
  final String meetingCode;
  final List<DirectiveEvent> events;
  final List<DirectiveExtension> extensions;
  final List<DirectiveEvidence> evidence;
  final String? asOf;
}

DirectiveDetail? parseDirectiveDetail(Object? raw) {
  final Json? body = asRecord(raw);
  final Json? directive = asRecord(body?['directive']);
  final DirectiveLine? line = parseDirectiveLine(directive);
  final String? original = day(directive?['original_due_on']);
  if (body == null || line == null || original == null || body['timeline'] is! List) return null;
  final List<DirectiveEvent> events = <DirectiveEvent>[];
  for (final Object? row in listOf(body['timeline'])) {
    final Json? event = asRecord(row);
    final DirectiveEventKind? kind = directiveEventKindOf(event?['type']);
    final String? at = filled(event?['occurred_at']);
    if (event == null || kind == null || at == null) return null;
    events.add(
      DirectiveEvent(
        kind: kind,
        actor: filled(asRecord(event['actor'])?['display_name']) ?? '',
        at: at,
        note: filled(event['note']),
        progressPct: whole(event['progress_pct']),
        fromDueOn: day(event['from_due_on']),
        toDueOn: day(event['to_due_on']),
        toUnit: filled(asRecord(event['to_assignee_unit'])?['name']),
      ),
    );
  }
  final List<DirectiveExtension> extensions = <DirectiveExtension>[];
  for (final Object? row in listOf(body['extensions'])) {
    final Json? item = asRecord(row);
    final ExtensionState? state = _extensionState(item?['status']);
    final String? from = day(item?['from_due_on']);
    final String? proposed = day(item?['proposed_due_on']);
    final String? reason = text(item?['reason']);
    if (item == null || state == null || from == null || proposed == null || reason == null) return null;
    extensions.add(
      DirectiveExtension(
        state: state,
        fromDueOn: from,
        proposedDueOn: proposed,
        reason: reason,
        requestedBy: filled(asRecord(item['requested_by'])?['display_name']) ?? '',
        decidedBy: filled(asRecord(item['decided_by'])?['display_name']),
        decisionReason: filled(item['decision_reason']),
      ),
    );
  }
  final List<DirectiveEvidence> evidence = <DirectiveEvidence>[
    for (final Object? row in listOf(body['evidence']))
      DirectiveEvidence(title: filled(asRecord(row)?['title']), addedBy: filled(asRecord(asRecord(row)?['added_by'])?['display_name']) ?? '', addedAt: filled(asRecord(row)?['added_at']) ?? ''),
  ];
  return DirectiveDetail(
    directive: line,
    originalDueOn: original,
    extensionCount: count(directive?['extension_count']),
    meetingCode: filled(asRecord(directive?['meeting'])?['code']) ?? '',
    events: events,
    extensions: extensions,
    evidence: evidence,
    asOf: filled(body['as_of']),
  );
}

ExtensionState? _extensionState(Object? value) {
  switch (value) {
    case 'REQUESTED':
      return ExtensionState.requested;
    case 'APPROVED':
      return ExtensionState.approved;
    case 'REJECTED':
      return ExtensionState.rejected;
  }
  return null;
}
