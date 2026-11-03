import '../read_support/wire.dart';

const List<String> kIssueStatuses = <String>[
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'ESCALATED',
  'PENDING_VERIFICATION',
  'CLOSED',
  'REOPENED',
];

const List<String> kEventKinds = <String>[
  'CREATED',
  'ASSIGNED',
  'REASSIGNED',
  'TRANSFERRED',
  'STARTED',
  'COMMENTED',
  'EVIDENCE_ADDED',
  'EXTENSION_REQUESTED',
  'EXTENDED',
  'ESCALATED',
  'ESCALATION_ACCEPTED',
  'VERIFICATION_REQUESTED',
  'CLOSED',
  'REOPENED',
  'SLA_BREACHED',
  'SOURCE_UPDATED',
];

/// One line of the timeline of an issue: what happened, who did it and the words they wrote (a reader who may not see the
/// notes gets none: the server leaves them out).
final class IssueEvent {
  const IssueEvent({
    required this.id,
    required this.kind,
    required this.createdAt,
    this.note,
    this.actor,
    this.toAssignee,
  });

  final String id;
  final String kind;
  final String createdAt;
  final String? note;
  final String? actor;
  final String? toAssignee;
}

/// The position stored with an issue; the server gives it to staff only and only when the reporter consented.
final class IssuePosition {
  const IssuePosition({
    required this.latitude,
    required this.longitude,
    required this.lowAccuracy,
    this.accuracyMetres,
  });

  final String latitude;
  final String longitude;
  final String? accuracyMetres;
  final bool lowAccuracy;
}

/// The issue as MOB-31 shows it: where it stands, who handles it, the deadlines the server counted on its working calendar, and
/// the exchange so far.
final class IssueFollowUp {
  const IssueFollowUp({
    required this.id,
    required this.code,
    required this.title,
    required this.status,
    required this.severity,
    required this.openedAt,
    required this.responseDueAt,
    required this.dueAt,
    required this.version,
    required this.events,
    required this.geoConsent,
    this.projectName,
    this.categoryLabel,
    this.unitName,
    this.assignee,
    this.respondedAt,
    this.overdueSince,
    this.closedAt,
    this.description,
    this.policyCode,
    this.responseHours,
    this.resolveHours,
    this.position,
  });

  final String id;
  final String code;
  final String title;
  final String status;
  final String severity;
  final String openedAt;
  final String responseDueAt;
  final String dueAt;
  final int version;
  final List<IssueEvent> events;
  final bool geoConsent;
  final String? projectName;
  final String? categoryLabel;
  final String? unitName;
  final String? assignee;
  final String? respondedAt;
  final String? overdueSince;
  final String? closedAt;
  final String? description;
  final String? policyCode;
  final int? responseHours;
  final int? resolveHours;
  final IssuePosition? position;

  bool get isClosed => status == 'CLOSED';
  bool get isOverdue => overdueSince != null;

  /// Comments are taken while the issue is open; the server judges the right to comment again.
  bool get acceptsComments => !isClosed;
}

IssueEvent? _event(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? kind = filled(row?['kind']);
  final String? createdAt = filled(row?['created_at']);
  if (row == null ||
      id == null ||
      kind == null ||
      !kEventKinds.contains(kind) ||
      createdAt == null)
    return null;
  return IssueEvent(
    id: id,
    kind: kind,
    createdAt: createdAt,
    note: filled(row['note']),
    actor: filled(asRecord(row['actor'])?['display_name']),
    toAssignee: filled(asRecord(row['to_assignee'])?['display_name']),
  );
}

/// The issue, or null when the answer lacks what makes it citable: its identity, its state and the deadlines.
IssueFollowUp? parseIssueFollowUp(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = filled(row?['code']);
  final String? title = filled(row?['title']);
  final String? status = filled(row?['status']);
  final String? severity = filled(row?['severity']);
  final String? openedAt = filled(row?['opened_at']);
  final String? responseDueAt = filled(row?['response_due_at']);
  final String? dueAt = filled(row?['due_at']);
  final int? version = whole(row?['version']);
  if (row == null ||
      id == null ||
      code == null ||
      title == null ||
      status == null ||
      !kIssueStatuses.contains(status) ||
      severity == null)
    return null;
  if (openedAt == null ||
      responseDueAt == null ||
      dueAt == null ||
      version == null)
    return null;
  final Json? sla = asRecord(row['sla']);
  final Json? geo = asRecord(row['geo']);
  final String? lat = filled(geo?['lat']);
  final String? lng = filled(geo?['lng']);
  return IssueFollowUp(
    id: id,
    code: code,
    title: title,
    status: status,
    severity: severity,
    openedAt: openedAt,
    responseDueAt: responseDueAt,
    dueAt: dueAt,
    version: version,
    events: <IssueEvent>[
      for (final Object? item in listOf(row['events']))
        if (_event(item) case final IssueEvent event) event,
    ],
    geoConsent: row['geo_consent'] == true,
    projectName: filled(row['project_name']),
    categoryLabel: filled(row['category_label']),
    unitName: filled(row['owner_unit_name']),
    assignee: filled(asRecord(row['assignee'])?['display_name']),
    respondedAt: filled(row['responded_at']),
    overdueSince: filled(row['overdue_since']),
    closedAt: filled(row['closed_at']),
    description: filled(row['description']),
    policyCode: filled(sla?['policy_code']),
    responseHours: whole(sla?['response_hours']),
    resolveHours: whole(sla?['resolve_hours']),
    position: lat == null || lng == null
        ? null
        : IssuePosition(
            latitude: lat,
            longitude: lng,
            accuracyMetres: filled(geo?['accuracy_m']),
            lowAccuracy: geo?['low_accuracy'] == true,
          ),
  );
}
