import '../../core/format/format.dart';
import '../read_support/wire.dart';

/// What the phone reads of the workflow of procurement packages (PRC-1, BID-27..30 on the web): the process tree ("Progress tree"), the
/// packages of a node, and one package with its stepper, checklist and day-by-day timeline. The shapes are the DTOs of
/// `apps/api/src/modules/bid/workflow-view.ts`; an answer that lacks what makes a figure citable is refused as a whole (null).

/// The health of a node, always shown as an icon and a word. It is read from what the server counted, not from a colour: no late
/// package is "ok"; some late is "attention"; every package of the node late is "late"; a node on hold says so.
enum PrcHealth { ok, attention, late, hold, none }

enum PrcNodeKind { root, method, step, substate, terminal }

const Map<String, PrcNodeKind> _kinds = <String, PrcNodeKind>{
  'ROOT': PrcNodeKind.root,
  'METHOD': PrcNodeKind.method,
  'STEP': PrcNodeKind.step,
  'SUBSTATE': PrcNodeKind.substate,
  'TERMINAL': PrcNodeKind.terminal,
};

final class PrcNode {
  const PrcNode({
    required this.id,
    required this.parentId,
    required this.kind,
    required this.count,
    required this.valueVnd,
    required this.lateCount,
    this.method,
    this.stepCode,
    this.substate,
    this.terminal,
    this.label,
    this.order,
    this.shareCountBp = 0,
    this.medianDays,
    this.medianWorking = true,
  });

  final String id;
  final String? parentId;
  final PrcNodeKind kind;
  final String? method;
  final String? stepCode;

  /// ON_HOLD, LATE, RETURNED or ON_TRACK for a sub-state.
  final String? substate;

  /// NOT_STARTED, COMPLETED or CANCELLED for a terminal.
  final String? terminal;

  /// The name from the definition for a method or a step; null for the others.
  final String? label;
  final int? order;
  final int count;
  final String valueVnd;

  /// Share of all packages in ten-thousandths (1234 = 12,34 %).
  final int shareCountBp;
  final double? medianDays;
  final bool medianWorking;
  final int lateCount;

  /// The share as a fraction of the width of a bar, 0..1.
  double get shareFraction => (shareCountBp / 10000).clamp(0.0, 1.0);
}

final class PrcEdge {
  const PrcEdge({required this.from, required this.to, required this.kind, required this.count});

  final String from;
  final String to;
  final String kind;
  final int count;
}

final class PrcTree {
  const PrcTree({
    required this.nodes,
    required this.edges,
    required this.totalCount,
    required this.totalValueVnd,
    required this.running,
    required this.late,
    required this.stalled,
    required this.onHold,
    required this.noOwner,
    required this.periodFrom,
    required this.periodTo,
    required this.truncated,
    required this.asOf,
  });

  final List<PrcNode> nodes;
  final List<PrcEdge> edges;
  final int totalCount;
  final String totalValueVnd;
  final int running;
  final int late;
  final int stalled;
  final int onHold;
  final int noOwner;
  final String periodFrom;
  final String periodTo;
  final bool truncated;
  final String? asOf;

  /// The nodes under [parentId] in the order of the server (the order of the definition).
  List<PrcNode> childrenOf(String parentId) => nodes.where((PrcNode node) => node.parentId == parentId).toList();

  PrcNode? byId(String id) {
    for (final PrcNode node in nodes) {
      if (node.id == id) return node;
    }
    return null;
  }

  /// The methods (the first level of the tree).
  List<PrcNode> get methods => nodes.where((PrcNode node) => node.kind == PrcNodeKind.method).toList();

  /// How many packages moved into [nodeId] during the period (advances), as text for the outline.
  int movedInto(String nodeId) => edges.where((PrcEdge edge) => edge.to == nodeId && edge.kind == 'ADVANCE').fold(0, (int sum, PrcEdge edge) => sum + edge.count);

  /// How many packages were sent back from [nodeId] during the period.
  int returnedFrom(String nodeId) => edges.where((PrcEdge edge) => edge.from == nodeId && edge.kind == 'RETURN').fold(0, (int sum, PrcEdge edge) => sum + edge.count);
}

/// The health of a node: see [PrcHealth]. A node with no package has none; a package outside a step (not started, completed,
/// cancelled) is not judged.
PrcHealth healthOf(PrcNode node) {
  if (node.count == 0) return PrcHealth.none;
  if (node.kind == PrcNodeKind.terminal) return node.terminal == 'COMPLETED' ? PrcHealth.ok : PrcHealth.none;
  if (node.kind == PrcNodeKind.substate) {
    switch (node.substate) {
      case 'ON_HOLD':
        return PrcHealth.hold;
      case 'LATE':
        return PrcHealth.late;
      default:
        return PrcHealth.ok;
    }
  }
  if (node.lateCount == 0) return PrcHealth.ok;
  return node.lateCount >= node.count ? PrcHealth.late : PrcHealth.attention;
}

PrcNode? _parseNode(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final PrcNodeKind? kind = _kinds[row?['kind']];
  final String? value = unsignedDong(row?['value_vnd']);
  if (row == null || id == null || kind == null || value == null) return null;
  final Object? median = row['median_days'];
  return PrcNode(
    id: id,
    parentId: filled(row['parent_id']),
    kind: kind,
    method: filled(row['method']),
    stepCode: filled(row['step_code']),
    substate: filled(row['substate']),
    terminal: filled(row['terminal']),
    label: filled(row['label']),
    order: whole(row['order']),
    count: count(row['count']),
    valueVnd: value,
    shareCountBp: count(row['share_count_bp']),
    medianDays: median is num ? median.toDouble() : null,
    medianWorking: row['median_basis'] != 'CALENDAR_DAYS',
    lateCount: count(row['late_count']),
  );
}

PrcTree? parsePrcTree(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null) return null;
  final List<PrcNode> nodes = <PrcNode>[];
  for (final Object? item in listOf(body['nodes'])) {
    final PrcNode? node = _parseNode(item);
    if (node == null) return null;
    nodes.add(node);
  }
  final Json? total = asRecord(body['total']);
  final Json? period = asRecord(body['period']);
  final String? totalValue = unsignedDong(total?['value_vnd']);
  final String? from = day(period?['from']);
  final String? to = day(period?['to']);
  if (nodes.isEmpty || total == null || totalValue == null || from == null || to == null) return null;
  final List<PrcEdge> edges = <PrcEdge>[];
  for (final Object? item in listOf(body['edges'])) {
    final Json? edge = asRecord(item);
    final String? source = filled(edge?['from']);
    final String? target = filled(edge?['to']);
    final String? kind = filled(edge?['kind']);
    if (edge == null || source == null || target == null || kind == null) return null;
    edges.add(PrcEdge(from: source, to: target, kind: kind, count: count(edge['count'])));
  }
  final Json kpis = asRecord(body['kpis']) ?? const <String, Object?>{};
  return PrcTree(
    nodes: nodes,
    edges: edges,
    totalCount: count(total['count']),
    totalValueVnd: totalValue,
    running: count(kpis['running']),
    late: count(kpis['late']),
    stalled: count(kpis['stalled']),
    onHold: count(kpis['on_hold']),
    noOwner: count(kpis['no_owner']),
    periodFrom: from,
    periodTo: to,
    truncated: body['truncated'] == true,
    asOf: filled(body['as_of']),
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The packages of a node.
// ---------------------------------------------------------------------------------------------------------------------------------

const Set<String> _statuses = <String>{'NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'};

/// One package of a list: where it is, how long, who holds it, whether it is late.
final class PrcPackageRow {
  const PrcPackageRow({
    required this.packageId,
    required this.code,
    required this.valueVnd,
    required this.method,
    required this.projectCode,
    required this.status,
    required this.late,
    required this.lateDays,
    this.title,
    this.projectName,
    this.stepCode,
    this.stepName,
    this.stepOrder,
    this.stepsTotal,
    this.daysWorking,
    this.daysCalendar,
    this.dueOn,
    this.daysLeft,
    this.holdReason,
    this.ownerName,
    this.hasOwner = false,
    this.stalled = false,
    this.progressPercent,
    this.sparkline = const <PrcSparkPoint>[],
  });

  final String packageId;
  final String code;
  final String? title;
  final String valueVnd;
  final String method;
  final String projectCode;
  final String? projectName;
  final String status;
  final String? stepCode;
  final String? stepName;
  final int? stepOrder;
  final int? stepsTotal;
  final int? daysWorking;
  final int? daysCalendar;
  final String? dueOn;
  final int? daysLeft;
  final bool late;
  final int lateDays;
  final String? holdReason;
  final String? ownerName;
  final bool hasOwner;
  final bool stalled;
  final int? progressPercent;
  final List<PrcSparkPoint> sparkline;

  bool get held => status == 'ON_HOLD';
  bool get running => status == 'IN_PROGRESS' || status == 'ON_HOLD';
}

final class PrcSparkPoint {
  const PrcSparkPoint({required this.stepCode, required this.days});

  final String stepCode;
  final int days;
}

PrcPackageRow? parsePrcPackageRow(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['package_id']);
  final String? code = text(row?['package_code']);
  final String? value = unsignedDong(row?['value_vnd']);
  final String? method = filled(row?['method']);
  final String? status = row?['status'] is String && _statuses.contains(row?['status']) ? row!['status'] as String : null;
  final Json? project = asRecord(row?['project']);
  if (row == null || id == null || code == null || value == null || method == null || status == null || project == null) return null;
  final Json? step = asRecord(row['step']);
  final Json? days = asRecord(row['days_in_step']);
  final Json? countdown = asRecord(row['countdown']);
  final Json? owner = asRecord(row['owner']);
  return PrcPackageRow(
    packageId: id,
    code: code,
    title: filled(row['title']),
    valueVnd: value,
    method: method,
    projectCode: text(project['code']) ?? '',
    projectName: filled(project['name']),
    status: status,
    stepCode: filled(step?['code']),
    stepName: filled(step?['name']),
    stepOrder: whole(step?['order']),
    stepsTotal: whole(step?['of']),
    daysWorking: whole(days?['working_days']),
    daysCalendar: whole(days?['calendar_days']),
    dueOn: day(row['due_on']),
    daysLeft: whole(countdown?['days_left']),
    late: row['late'] == true,
    lateDays: count(row['late_days']),
    holdReason: filled(row['hold_reason']),
    ownerName: filled(owner?['name']),
    hasOwner: owner != null,
    stalled: row['stalled'] == true,
    progressPercent: whole(row['progress_percent']),
    sparkline: <PrcSparkPoint>[
      for (final Object? point in listOf(row['sparkline']))
        if (asRecord(point) case final Json item when filled(item['step_code']) != null) PrcSparkPoint(stepCode: item['step_code']! as String, days: count(item['days'])),
    ],
  );
}

/// One page of packages: the rows, the cursor of the next page and whether the server cut the read.
final class PrcRowPage {
  const PrcRowPage({required this.items, required this.nextCursor, required this.truncated, required this.asOf});

  final List<PrcPackageRow> items;
  final String? nextCursor;
  final bool truncated;
  final String? asOf;
}

PrcRowPage? parsePrcRowPage(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  final List<PrcPackageRow> items = <PrcPackageRow>[];
  for (final Object? item in listOf(body['items'])) {
    final PrcPackageRow? row = parsePrcPackageRow(item);
    if (row == null) return null;
    items.add(row);
  }
  return PrcRowPage(items: items, nextCursor: filled(body['next_cursor']), truncated: body['truncated'] == true, asOf: filled(body['as_of']));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// One package.
// ---------------------------------------------------------------------------------------------------------------------------------

final class PrcStepDef {
  const PrcStepDef({required this.code, required this.name, required this.order, required this.standardDays});

  final String code;
  final String name;
  final int order;
  final int standardDays;
}

final class PrcBlocker {
  const PrcBlocker({required this.reason, this.count, this.detail});

  final String reason;
  final int? count;
  final String? detail;
}

final class PrcEvidence {
  const PrcEvidence({required this.kind, this.milestoneKind, this.reference});

  final String kind;
  final String? milestoneKind;
  final String? reference;
}

final class PrcChecklistItem {
  const PrcChecklistItem({required this.code, required this.name, required this.required, required this.status, this.dueOn, this.ownerName, this.completedVia, this.evidence = const <PrcEvidence>[]});

  final String code;
  final String name;
  final bool required;
  final String status;
  final String? dueOn;
  final String? ownerName;
  final String? completedVia;
  final List<PrcEvidence> evidence;
}

final class PrcStepSummary {
  const PrcStepSummary({required this.stepCode, required this.days, required this.working, required this.standardDays, required this.daysOver, required this.current});

  final String stepCode;
  final int days;
  final bool working;
  final int standardDays;
  final int daysOver;
  final bool current;
}

final class PrcTimelineEntry {
  const PrcTimelineEntry({
    required this.id,
    required this.kind,
    required this.at,
    required this.day,
    required this.stateChange,
    this.fromStep,
    this.toStep,
    this.actorName,
    this.spentCalendarDays,
    this.spentWorkingDays,
    this.reason,
    this.evidence = const <PrcEvidence>[],
    this.subject,
  });

  final String id;
  final String kind;
  final String at;
  final String day;
  final bool stateChange;
  final String? fromStep;
  final String? toStep;
  final String? actorName;
  final int? spentCalendarDays;
  final int? spentWorkingDays;
  final String? reason;
  final List<PrcEvidence> evidence;
  final String? subject;
}

final class PrcTimelineDay {
  const PrcTimelineDay({required this.day, required this.entries});

  final String day;
  final List<PrcTimelineEntry> entries;

  int get stateChanges => entries.where((PrcTimelineEntry entry) => entry.stateChange).length;
}

final class PrcBar {
  const PrcBar({required this.stepCode, this.plannedFrom, this.plannedTo, this.actualFrom, this.actualTo});

  final String stepCode;
  final String? plannedFrom;
  final String? plannedTo;
  final String? actualFrom;
  final String? actualTo;
}

final class PrcWorkflow {
  const PrcWorkflow({
    required this.id,
    required this.status,
    required this.late,
    required this.percent,
    required this.stepsTotal,
    required this.stepsDone,
    required this.currentOrder,
    required this.steps,
    required this.blockers,
    required this.checklist,
    required this.summary,
    required this.timeline,
    this.stepCode,
    this.stepName,
    this.standardDays,
    this.ownerName,
    this.holdReason,
    this.endReason,
    this.enteredOn,
    this.dueOn,
    this.daysLeft,
    this.daysWorking,
    this.daysCalendar,
    this.startedAt,
    this.endedAt,
    this.bars = const <PrcBar>[],
    this.petitionsOpen = 0,
    this.petitionsTotal = 0,
    this.milestones = const <PrcMilestone>[],
    this.resultStatus,
    this.contractCode,
    this.itemsRequired = 0,
    this.itemsRequiredDone = 0,
  });

  final String id;
  final String status;
  final bool late;
  final int percent;
  final int stepsTotal;
  final int stepsDone;
  final int? currentOrder;
  final List<PrcStepDef> steps;
  final List<PrcBlocker> blockers;
  final List<PrcChecklistItem> checklist;
  final List<PrcStepSummary> summary;
  final List<PrcTimelineDay> timeline;
  final List<PrcBar> bars;
  final String? stepCode;
  final String? stepName;
  final int? standardDays;
  final String? ownerName;
  final String? holdReason;
  final String? endReason;
  final String? enteredOn;
  final String? dueOn;
  final int? daysLeft;
  final int? daysWorking;
  final int? daysCalendar;
  final String? startedAt;
  final String? endedAt;
  final int petitionsOpen;
  final int petitionsTotal;
  final List<PrcMilestone> milestones;
  final String? resultStatus;
  final String? contractCode;
  final int itemsRequired;
  final int itemsRequiredDone;

  bool get running => status == 'IN_PROGRESS' || status == 'ON_HOLD';

  String stepNameOf(String? code) {
    if (code == null) return '';
    for (final PrcStepDef step in steps) {
      if (step.code == code) return step.name;
    }
    return code;
  }

  PrcStepSummary? summaryOf(String? code) {
    for (final PrcStepSummary row in summary) {
      if (row.stepCode == code) return row;
    }
    return null;
  }

  /// Days the package has been in the current step: working days when the calendar is published, else calendar days.
  int? get daysInStep => daysWorking ?? daysCalendar;
}

final class PrcMilestone {
  const PrcMilestone({required this.kind, this.actualAt, this.source});

  final String kind;
  final String? actualAt;
  final String? source;
}

final class PrcDetail {
  const PrcDetail({
    required this.packageId,
    required this.code,
    required this.valueVnd,
    required this.method,
    required this.projectCode,
    required this.asOf,
    this.title,
    this.projectName,
    this.unitName,
    this.workflow,
    this.startable = false,
    this.definitionSteps = const <PrcStepDef>[],
  });

  final String packageId;
  final String code;
  final String? title;
  final String valueVnd;
  final String method;
  final String projectCode;
  final String? projectName;
  final String? unitName;
  final String asOf;
  final PrcWorkflow? workflow;
  final bool startable;
  final List<PrcStepDef> definitionSteps;
}

List<PrcEvidence> _evidenceOf(Object? raw) => <PrcEvidence>[
      for (final Object? item in listOf(raw))
        if (asRecord(item) case final Json one when filled(one['kind']) != null) PrcEvidence(kind: one['kind']! as String, milestoneKind: filled(one['milestone_kind']), reference: filled(one['reference'])),
    ];

String? _personName(Object? raw) => filled(asRecord(raw)?['name']);

PrcStepDef? _stepDef(Object? raw) {
  final Json? row = asRecord(raw);
  final String? code = filled(row?['code']);
  final String? name = text(row?['name']);
  final int? order = whole(row?['order']);
  if (row == null || code == null || name == null || order == null) return null;
  return PrcStepDef(code: code, name: name, order: order, standardDays: count(row['standard_working_days']));
}

PrcTimelineEntry? _entry(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? kind = filled(row?['kind']);
  final String? at = filled(row?['at']);
  final String? entryDay = day(row?['day']);
  if (row == null || id == null || kind == null || at == null || entryDay == null) return null;
  return PrcTimelineEntry(
    id: id,
    kind: kind,
    at: at,
    day: entryDay,
    stateChange: row['state_change'] == true,
    fromStep: filled(row['from_step']),
    toStep: filled(row['to_step']),
    actorName: _personName(row['actor']),
    spentCalendarDays: whole(row['spent_calendar_days']),
    spentWorkingDays: whole(row['spent_working_days']),
    reason: filled(row['reason']),
    evidence: _evidenceOf(row['evidence']),
    subject: filled(row['subject']),
  );
}

PrcWorkflow? _parseWorkflow(Json row) {
  final String? id = filled(row['id']);
  final String? status = filled(row['status']);
  final Json? progress = asRecord(row['progress']);
  final Json? timeline = asRecord(row['timeline']);
  if (id == null || status == null || progress == null || timeline == null) return null;
  final List<PrcStepDef> steps = <PrcStepDef>[];
  for (final Object? item in listOf(row['steps'])) {
    final PrcStepDef? step = _stepDef(item);
    if (step == null) return null;
    steps.add(step);
  }
  final List<PrcTimelineDay> days = <PrcTimelineDay>[];
  for (final Object? item in listOf(timeline['days'])) {
    final Json? group = asRecord(item);
    final String? groupDay = day(group?['day']);
    if (group == null || groupDay == null) return null;
    final List<PrcTimelineEntry> entries = <PrcTimelineEntry>[];
    for (final Object? entryRaw in listOf(group['entries'])) {
      final PrcTimelineEntry? entry = _entry(entryRaw);
      if (entry == null) return null;
      entries.add(entry);
    }
    days.add(PrcTimelineDay(day: groupDay, entries: entries));
  }
  final Json? step = asRecord(row['step']);
  final Json? dwell = asRecord(row['days_in_step']);
  final Json? countdown = asRecord(row['countdown']);
  final Json links = asRecord(row['links']) ?? const <String, Object?>{};
  final Json petitions = asRecord(links['petitions']) ?? const <String, Object?>{};
  return PrcWorkflow(
    id: id,
    status: status,
    late: row['late'] == true,
    percent: count(progress['percent']),
    stepsTotal: count(progress['steps_total']),
    stepsDone: count(progress['steps_done']),
    currentOrder: whole(progress['current_order']),
    itemsRequired: count(progress['items_required']),
    itemsRequiredDone: count(progress['items_required_done']),
    steps: steps,
    blockers: <PrcBlocker>[
      for (final Object? item in listOf(row['blockers']))
        if (asRecord(item) case final Json one when filled(one['reason']) != null) PrcBlocker(reason: one['reason']! as String, count: whole(one['count']), detail: filled(one['detail'])),
    ],
    checklist: <PrcChecklistItem>[
      for (final Object? item in listOf(row['checklist']))
        if (asRecord(item) case final Json one when filled(one['code']) != null && text(one['name']) != null)
          PrcChecklistItem(
            code: one['code']! as String,
            name: one['name']! as String,
            required: one['required'] == true,
            status: filled(one['status']) ?? 'OPEN',
            dueOn: day(one['due_on']),
            ownerName: _personName(one['owner']),
            completedVia: filled(one['completed_via']),
            evidence: _evidenceOf(one['evidence']),
          ),
    ],
    summary: <PrcStepSummary>[
      for (final Object? item in listOf(timeline['summary']))
        if (asRecord(item) case final Json one when filled(one['step_code']) != null)
          PrcStepSummary(stepCode: one['step_code']! as String, days: count(one['days']), working: one['basis'] != 'CALENDAR_DAYS', standardDays: count(one['standard_working_days']), daysOver: count(one['days_over']), current: one['current'] == true),
    ],
    bars: <PrcBar>[
      for (final Object? item in listOf(timeline['gantt']))
        if (asRecord(item) case final Json one when filled(one['step_code']) != null)
          PrcBar(
            stepCode: one['step_code']! as String,
            plannedFrom: day(asRecord(one['planned'])?['start_on']),
            plannedTo: day(asRecord(one['planned'])?['end_on']),
            actualFrom: day(asRecord(one['actual'])?['start_on']),
            actualTo: day(asRecord(one['actual'])?['end_on']),
          ),
    ],
    timeline: days,
    stepCode: filled(step?['code']),
    stepName: filled(step?['name']),
    standardDays: whole(step?['standard_working_days']),
    ownerName: _personName(row['owner']),
    holdReason: filled(row['hold_reason']),
    endReason: filled(row['end_reason']),
    enteredOn: day(row['entered_on']),
    dueOn: day(row['due_on']),
    daysLeft: whole(countdown?['days_left']),
    daysWorking: whole(dwell?['working_days']),
    daysCalendar: whole(dwell?['calendar_days']),
    startedAt: filled(row['started_at']),
    endedAt: filled(row['ended_at']),
    petitionsOpen: count(petitions['open']),
    petitionsTotal: count(petitions['total']),
    milestones: <PrcMilestone>[
      for (final Object? item in listOf(links['milestones']))
        if (asRecord(item) case final Json one when filled(one['kind']) != null) PrcMilestone(kind: one['kind']! as String, actualAt: filled(one['actual_at']), source: filled(one['source'])),
    ],
    resultStatus: filled(asRecord(links['result'])?['status']),
    contractCode: filled(asRecord(links['contract'])?['code']),
  );
}

PrcDetail? parsePrcDetail(Object? raw) {
  final Json? body = asRecord(raw);
  final Json? pack = asRecord(body?['package']);
  final Json? project = asRecord(body?['project']);
  final String? id = filled(pack?['id']);
  final String? code = text(pack?['code']);
  final String? value = unsignedDong(pack?['value_vnd']);
  final String? method = filled(pack?['method']);
  final String? asOf = filled(body?['as_of']);
  if (body == null || pack == null || id == null || code == null || value == null || method == null || asOf == null) return null;
  final Json? workflowRaw = asRecord(body['workflow']);
  PrcWorkflow? workflow;
  if (workflowRaw != null) {
    workflow = _parseWorkflow(workflowRaw);
    if (workflow == null) return null;
  } else if (body['workflow'] != null) {
    return null;
  }
  return PrcDetail(
    packageId: id,
    code: code,
    title: filled(pack['title']),
    valueVnd: value,
    method: method,
    projectCode: text(project?['code']) ?? '',
    projectName: filled(project?['name']),
    unitName: filled(body['unit_name']),
    asOf: asOf,
    workflow: workflow,
    startable: body['startable'] == true,
    definitionSteps: <PrcStepDef>[
      for (final Object? item in listOf(body['definition_steps']))
        if (_stepDef(item) case final PrcStepDef step) step,
    ],
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The stepper.
// ---------------------------------------------------------------------------------------------------------------------------------

enum PrcStepState { done, current, upcoming, hold, late }

final class PrcStepRow {
  const PrcStepRow({required this.step, required this.state, required this.plannedDays, this.actualDays, this.daysOver = 0});

  final PrcStepDef step;
  final PrcStepState state;
  final int plannedDays;

  /// Days spent in the step so far (null for a step not reached).
  final int? actualDays;
  final int daysOver;
}

/// The stepper of a workflow, one row per step of its frozen definition: the steps before the current one are done, the current one is
/// current (late when the server says the package is late, on hold when it is), the rest are upcoming. A completed workflow has every step
/// done; a cancelled one keeps the steps it never reached upcoming.
List<PrcStepRow> stepperOf(PrcWorkflow workflow) {
  final int current = workflow.currentOrder ?? (workflow.status == 'COMPLETED' ? workflow.steps.length + 1 : 0);
  return <PrcStepRow>[
    for (final PrcStepDef step in workflow.steps)
      () {
        final PrcStepSummary? spent = workflow.summaryOf(step.code);
        final PrcStepState state;
        if (workflow.status == 'COMPLETED' || step.order < current) {
          state = PrcStepState.done;
        } else if (workflow.currentOrder != null && step.order == current) {
          state = workflow.status == 'ON_HOLD' ? PrcStepState.hold : (workflow.late ? PrcStepState.late : PrcStepState.current);
        } else {
          state = PrcStepState.upcoming;
        }
        // A step that was left (a return makes it current again) counts every day spent in it, so the actual days of a past step are its summary.
        return PrcStepRow(step: step, state: state, plannedDays: step.standardDays, actualDays: spent?.days, daysOver: spent?.daysOver ?? 0);
      }(),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The timeline rows.
// ---------------------------------------------------------------------------------------------------------------------------------

sealed class PrcTimelineRow {
  const PrcTimelineRow();
}

final class PrcDayHeaderRow extends PrcTimelineRow {
  const PrcDayHeaderRow({required this.day, required this.changes});

  final String day;
  final int changes;
}

final class PrcEntryRow extends PrcTimelineRow {
  const PrcEntryRow(this.entry);

  final PrcTimelineEntry entry;
}

/// Days with no change between two days that have one, or between the last change and today: the wait the manager cares about.
final class PrcGapRow extends PrcTimelineRow {
  const PrcGapRow({required this.days, required this.quietDays, this.waitingStep});

  final int days;

  /// The quiet days themselves (`YYYY-MM-DD`), oldest first, for the row that is expanded.
  final List<String> quietDays;

  /// The step the package was waiting in (a code), when it is known.
  final String? waitingStep;
}

DateTime _utcDay(String value) => DateTime.utc(int.parse(value.substring(0, 4)), int.parse(value.substring(5, 7)), int.parse(value.substring(8, 10)));

String _dayText(DateTime value) => '${value.year.toString().padLeft(4, '0')}-${value.month.toString().padLeft(2, '0')}-${value.day.toString().padLeft(2, '0')}';

/// The days of the timeline as rows, newest first (the order of the screen): a header for each day, its entries newest first, and a gap row
/// for each run of quiet days. [today] is the Vietnam day the answer describes; [currentStep] is the step the package is waiting in now.
/// With [onlyStateChanges] only the changes of state are kept (a day with none disappears and the gaps are counted again).
List<PrcTimelineRow> timelineRowsOf(PrcWorkflow workflow, {required String today, required bool onlyStateChanges}) {
  final List<PrcTimelineDay> days = <PrcTimelineDay>[];
  for (final PrcTimelineDay group in workflow.timeline) {
    final List<PrcTimelineEntry> kept = onlyStateChanges ? group.entries.where((PrcTimelineEntry entry) => entry.stateChange).toList() : group.entries;
    if (kept.isNotEmpty) days.add(PrcTimelineDay(day: group.day, entries: kept));
  }
  days.sort((PrcTimelineDay left, PrcTimelineDay right) => right.day.compareTo(left.day));
  if (days.isEmpty) return const <PrcTimelineRow>[];

  List<String> quiet(String from, String to) {
    final List<String> result = <String>[];
    for (DateTime cursor = _utcDay(from).add(const Duration(days: 1)); cursor.isBefore(_utcDay(to)); cursor = cursor.add(const Duration(days: 1))) {
      result.add(_dayText(cursor));
    }
    return result;
  }

  /// The step in force after the latest change of state on or before [onDay] (the change a quiet run follows).
  String? stepAfter(int index) {
    for (int at = index; at < days.length; at += 1) {
      for (final PrcTimelineEntry entry in days[at].entries) {
        if (entry.stateChange && entry.toStep != null) return entry.toStep;
      }
    }
    return null;
  }

  final List<PrcTimelineRow> rows = <PrcTimelineRow>[];
  if (workflow.running && today.compareTo(days.first.day) > 0) {
    final List<String> gap = quiet(days.first.day, today);
    // Today itself is part of the wait: the quiet days are those after the last change up to and including today.
    final List<String> upToday = <String>[...gap, today];
    rows.add(PrcGapRow(days: upToday.length, quietDays: upToday, waitingStep: workflow.stepCode));
  }
  for (int index = 0; index < days.length; index += 1) {
    final PrcTimelineDay group = days[index];
    rows.add(PrcDayHeaderRow(day: group.day, changes: group.stateChanges));
    for (final PrcTimelineEntry entry in group.entries) {
      rows.add(PrcEntryRow(entry));
    }
    if (index + 1 < days.length) {
      final List<String> gap = quiet(days[index + 1].day, group.day);
      if (gap.isNotEmpty) rows.add(PrcGapRow(days: gap.length, quietDays: gap, waitingStep: stepAfter(index + 1)));
    }
  }
  return rows;
}

/// The Vietnam day of the answer (`as_of`).
String dayOfAnswer(String asOf) {
  final DateTime? parsed = DateTime.tryParse(asOf);
  return parsed == null ? asOf.substring(0, asOf.length < 10 ? asOf.length : 10) : vietnamDayOf(parsed);
}

/// The days between two days `YYYY-MM-DD` (`to` - `from`).
int daysBetween(String from, String to) => _utcDay(to).difference(_utcDay(from)).inDays;

/// ISO weekday (1 = Monday ... 7 = Sunday) of a day `YYYY-MM-DD`.
int weekdayOf(String value) => _utcDay(value).weekday;
