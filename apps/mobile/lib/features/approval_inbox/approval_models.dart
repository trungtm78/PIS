import '../../core/format/format.dart';
import '../read_support/wire.dart';

/// The permission that decides an approval task; the server judges it again, and demands a fresh second factor for it.
const String decidePermission = 'approval.decide';

/// The business type whose tasks carry a report; its detail compares the report with the revision before it.
const String reportAcceptType = 'report.accept';

/// One approval task awaiting a decision of the person (`/resources/approval_task?mine=true`).
final class ApprovalTask {
  const ApprovalTask({
    required this.id,
    required this.version,
    required this.businessType,
    required this.resourceType,
    required this.resourceId,
    required this.stepName,
    required this.dueAt,
    required this.overdue,
    required this.escalated,
    required this.canDecide,
    required this.status,
    this.amountVnd,
    this.unitId,
    this.assigneeName,
  });

  final String id;

  /// The version the screen saw: the decision is sent under it (`If-Match`), so a task that moved meanwhile is a conflict.
  final int version;
  final String businessType;
  final String resourceType;
  final String resourceId;
  final String stepName;
  final String? amountVnd;
  final String? unitId;
  final String? assigneeName;

  /// The deadline of the step as an instant; shown in Vietnam time.
  final String dueAt;

  /// The server's word, not the phone's clock.
  final bool overdue;
  final bool escalated;

  /// The server says the person may decide this task (assigned to them or on behalf of the one who is).
  final bool canDecide;

  /// `Pending`, `Decided`, `Reassigned`, `Cancelled` or `Expired`, as the server says.
  final String status;

  bool get isPending => status == 'Pending';
}

ApprovalTask? parseApprovalTask(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? instance = asRecord(row?['instance']);
  final Json? resource = asRecord(row?['resource']);
  final Json? actions = asRecord(row?['actions']);
  final String? id = filled(row?['id']);
  final int? version = whole(row?['version']);
  final String? dueAt = filled(row?['due_at']);
  final String? status = filled(row?['status']);
  if (row == null || status == null || id == null || version == null || dueAt == null) return null;
  return ApprovalTask(
    id: id,
    version: version,
    businessType: text(row['business_type']) ?? '',
    resourceType: text(resource?['type']) ?? '',
    resourceId: text(resource?['id']) ?? '',
    stepName: text(row['step_name']) ?? text(row['step_id']) ?? '',
    amountVnd: unsignedDong(instance?['amount_vnd']),
    unitId: filled(instance?['unit_id']),
    assigneeName: filled(asRecord(row['assignee'])?['name']),
    dueAt: dueAt,
    overdue: row['overdue'] == true,
    escalated: filled(row['escalated_at']) != null,
    canDecide: actions?['decide'] == true,
    status: status,
  );
}

/// The tasks waiting for the person, the late ones first and then by deadline.
final class ApprovalInbox {
  const ApprovalInbox({required this.tasks, required this.unitNames, this.asOf});

  final List<ApprovalTask> tasks;

  /// The names of the units, by id; a unit the reader may not read is not in it and its id is never shown as a name.
  final Map<String, String> unitNames;
  final String? asOf;

  int get overdueCount => tasks.where((ApprovalTask task) => task.overdue).length;
}

/// The inbox from `{items: [task, ...], as_of, units: {items: [unit, ...]} | null}`, or null when it is not one.
ApprovalInbox? parseApprovalInbox(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  final List<ApprovalTask> tasks = <ApprovalTask>[
    for (final Object? item in listOf(body['items']))
      if (parseApprovalTask(item) case final ApprovalTask task when task.isPending) task,
  ];
  tasks.sort((ApprovalTask a, ApprovalTask b) {
    if (a.overdue != b.overdue) return a.overdue ? -1 : 1;
    final int byDue = a.dueAt.compareTo(b.dueAt);
    return byDue != 0 ? byDue : a.id.compareTo(b.id);
  });
  return ApprovalInbox(
    tasks: tasks,
    unitNames: <String, String>{
      for (final Object? unit in listOf(asRecord(body['units'])?['items']))
        if (filled(asRecord(unit)?['id']) case final String id when filled(asRecord(unit)?['name']) != null) id: asRecord(unit)!['name']! as String,
    },
    asOf: filled(body['as_of']),
  );
}

/// What narrows the inbox: a kind of record and the late ones only.
final class InboxFilter {
  const InboxFilter({this.businessType, this.onlyOverdue = false});

  final String? businessType;
  final bool onlyOverdue;

  bool get isEmpty => businessType == null && !onlyOverdue;
}

List<ApprovalTask> applyInboxFilter(List<ApprovalTask> tasks, InboxFilter filter) => <ApprovalTask>[
      for (final ApprovalTask task in tasks)
        if ((filter.businessType == null || task.businessType == filter.businessType) && (!filter.onlyOverdue || task.overdue)) task,
    ];

// ---- the comparison of a report with the revision before it ----------------------------------------------------------

/// The six cells of the funding form (`bucket:level`), in the order of the paper form.
const List<String> reportBuckets = <String>['CURRENT_YEAR', 'CARRYOVER', 'OTHER'];
const List<String> reportLevels = <String>['CENTRAL', 'LOCAL'];

/// A file attached to a report as evidence.
final class Evidence {
  const Evidence({required this.id, required this.fileName, required this.contentType, required this.sizeBytes, required this.sha256});

  final String id;
  final String fileName;
  final String contentType;
  final int sizeBytes;
  final String sha256;
}

/// A revision of a report with the figures a reviewer compares.
final class ReportFigures {
  const ReportFigures({required this.id, required this.revision, required this.projectCode, required this.projectName, required this.periodCode, required this.cells, required this.totalVnd, required this.ctmtqgVnd, required this.evidence, this.supersedesId, this.amendmentReason});

  final String id;
  final int revision;
  final String projectCode;
  final String projectName;
  final String periodCode;

  /// The cumulative amount of each cell, by `bucket:level`.
  final Map<String, String> cells;
  final String totalVnd;

  /// The part of the total that is CTMTQG: inside the cells, never added.
  final String ctmtqgVnd;
  final List<Evidence> evidence;
  final String? supersedesId;
  final String? amendmentReason;
}

ReportFigures? parseReportFigures(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? project = asRecord(row?['project']);
  final Json? period = asRecord(row?['period']);
  final Json? totals = asRecord(row?['totals']);
  final String? id = filled(row?['id']);
  final int? revision = whole(row?['revision']);
  final String? total = unsignedDong(totals?['cumulative_vnd']);
  final String? ctmtqg = unsignedDong(totals?['ctmtqg_vnd']);
  if (row == null || id == null || revision == null || total == null || ctmtqg == null || project == null || period == null) return null;
  final Map<String, String> cells = <String, String>{};
  for (final Object? item in listOf(row['funding_lines'])) {
    final Json? line = asRecord(item);
    final String? amount = unsignedDong(line?['cumulative_vnd']);
    if (line != null && amount != null) cells['${line['bucket']}:${line['budget_level']}'] = amount;
  }
  final List<Evidence> evidence = <Evidence>[];
  for (final Object? item in listOf(row['attachments'])) {
    final Json? file = asRecord(item);
    final String? fileId = filled(file?['id']);
    if (file == null || fileId == null) continue;
    evidence.add(Evidence(id: fileId, fileName: text(file['file_name']) ?? '', contentType: text(file['content_type']) ?? '', sizeBytes: count(file['size_bytes']), sha256: text(file['file_sha256']) ?? ''));
  }
  return ReportFigures(
    id: id,
    revision: revision,
    projectCode: text(project['code']) ?? '',
    projectName: text(project['name']) ?? '',
    periodCode: text(period['code']) ?? '',
    cells: cells,
    totalVnd: total,
    ctmtqgVnd: ctmtqg,
    evidence: evidence,
    supersedesId: filled(row['supersedes_id']),
    amendmentReason: filled(row['amendment_reason']),
  );
}

/// One cell of two revisions side by side: what each reported and what the later one changed (a fall is negative, never
/// shown as zero).
final class CellChange {
  const CellChange({required this.bucket, required this.level, required this.previousVnd, required this.currentVnd, required this.changeVnd});

  final String bucket;
  final String level;
  final String previousVnd;
  final String currentVnd;
  final String changeVnd;

  bool get changed => changeVnd != '0';
}

/// The six cells of the report against the six of the revision before it; a cell a revision does not hold reads zero.
List<CellChange> compareReports(ReportFigures previous, ReportFigures current) => <CellChange>[
      for (final String bucket in reportBuckets)
        for (final String level in reportLevels)
          CellChange(
            bucket: bucket,
            level: level,
            previousVnd: previous.cells['$bucket:$level'] ?? '0',
            currentVnd: current.cells['$bucket:$level'] ?? '0',
            changeVnd: differenceDong(current.cells['$bucket:$level'] ?? '0', previous.cells['$bucket:$level'] ?? '0'),
          ),
    ];

/// The task with what is needed to decide it: the record, and for a report the revision before it.
final class ApprovalDetail {
  const ApprovalDetail({required this.task, this.report, this.previous, this.unitName});

  final ApprovalTask task;

  /// The record the task is about, when it is a report that could be read.
  final ReportFigures? report;

  /// The revision the report corrects; null for a first revision.
  final ReportFigures? previous;
  final String? unitName;

  /// The comparison with the revision before it, when both revisions are there.
  List<CellChange>? get changes => report != null && previous != null ? compareReports(previous!, report!) : null;
}

/// The detail from `{task, report: <report> | null, previous: <report> | null, unit: <unit> | null}`, or null when the task
/// is not one.
ApprovalDetail? parseApprovalDetail(Object? raw) {
  final Json? body = asRecord(raw);
  final ApprovalTask? task = parseApprovalTask(body?['task']);
  if (body == null || task == null) return null;
  return ApprovalDetail(
    task: task,
    report: parseReportFigures(body['report']),
    previous: parseReportFigures(body['previous']),
    unitName: filled(asRecord(body['unit'])?['name']),
  );
}
