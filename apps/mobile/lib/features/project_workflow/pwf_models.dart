import '../read_support/wire.dart';

/// What the phone reads of the workflow of a project (PWF, MOB-78 to MOB-82). Every figure and every day comes from the server: the phone
/// never counts a deadline from its own clock. An answer that lacks what makes a row citable is refused as a whole (null), and the screen shows
/// the contract mismatch instead of half a page.

/// The colour of a deadline as the server counted it. [none] is "not in range yet" (or no date) and [unknown] is "cannot be counted" (the calendar
/// of a year is missing): neither is ever drawn as green.
enum PwfBandKind {
  none,
  green,
  yellow,
  red,
  unknown;

  static PwfBandKind? parse(Object? value) => switch (value) {
        'NONE' => none,
        'GREEN' => green,
        'YELLOW' => yellow,
        'RED' => red,
        'UNKNOWN' => unknown,
        _ => null,
      };
}

/// The deadline of a task in one band: the colour, the days left (negative when passed) and the unit the server counted them in.
final class PwfBand {
  const PwfBand({required this.kind, required this.unit, this.remainingDays, this.overdue = false, this.reason});

  final PwfBandKind kind;
  final int? remainingDays;

  /// `CALENDAR` or `WORKING`: the words of the label follow it ("3 working days left").
  final String unit;
  final bool overdue;

  /// `NO_DUE`, `FAR` or `CALENDAR_UNAVAILABLE` when the band is none or unknown.
  final String? reason;

  bool get isWorking => unit == 'WORKING';
}

PwfBand? parsePwfBand(Object? raw) {
  final Json? record = asRecord(raw);
  if (record == null) return null;
  final PwfBandKind? kind = PwfBandKind.parse(record['band']);
  final String? unit = text(record['unit']);
  if (kind == null || (unit != 'CALENDAR' && unit != 'WORKING')) return null;
  return PwfBand(kind: kind, unit: unit!, remainingDays: whole(record['remaining_days']), overdue: record['overdue'] == true, reason: filled(record['reason']));
}

/// The state of a task as the workflow words it.
enum PwfTaskStatus {
  notStarted,
  inProgress,
  awaitingApproval,
  done,
  onHold,
  cancelled;

  static PwfTaskStatus? parse(Object? value) => switch (value) {
        'NOT_STARTED' => notStarted,
        'IN_PROGRESS' => inProgress,
        'AWAITING_APPROVAL' => awaitingApproval,
        'DONE' => done,
        'ON_HOLD' => onHold,
        'CANCELLED' => cancelled,
        _ => null,
      };

  /// A task that is over: it has no colour and no deadline label.
  bool get isFinal => this == done || this == cancelled;
}

/// One task of the workflow in a list (the stage list of MOB-78).
final class PwfTaskRow {
  const PwfTaskRow({
    required this.id,
    required this.code,
    required this.name,
    required this.phaseCode,
    required this.isMilestone,
    required this.mandatory,
    required this.status,
    required this.excluded,
    required this.critical,
    required this.band,
    required this.version,
    this.plannedFinish,
    this.missingYear,
    this.assignee,
    this.returnCount = 0,
  });

  final String id;
  final String code;
  final String name;
  final String phaseCode;
  final bool isMilestone;

  /// The workflow requires this task before the stage can close.
  final bool mandatory;
  final PwfTaskStatus status;

  /// A branch the project does not have: kept for the order, never shown as work.
  final bool excluded;
  final bool critical;

  /// The official band: the one every shared screen shows (R40).
  final PwfBand band;
  final int version;
  final String? plannedFinish;
  final int? missingYear;
  final String? assignee;
  final int returnCount;
}

PwfTaskRow? parsePwfTaskRow(Object? raw) {
  final Json? record = asRecord(raw);
  if (record == null) return null;
  final String? id = filled(record['id']);
  final String? code = filled(record['task_code']);
  final String? name = filled(record['name']);
  final String? phase = filled(record['phase_code']);
  final PwfTaskStatus? status = PwfTaskStatus.parse(record['status']);
  final PwfBand? band = parsePwfBand(record['band']);
  final int? version = whole(record['version']);
  if (id == null || code == null || name == null || phase == null || status == null || band == null || version == null) return null;
  return PwfTaskRow(
    id: id,
    code: code,
    name: name,
    phaseCode: phase,
    isMilestone: record['kind'] == 'MILESTONE',
    mandatory: record['required'] == true,
    status: status,
    excluded: record['excluded'] == true,
    critical: record['critical'] == true,
    band: band,
    version: version,
    plannedFinish: day(record['planned_finish']),
    missingYear: whole(record['missing_year']),
    assignee: filled(asRecord(record['assignee'])?['display_name']),
    returnCount: count(record['return_count']),
  );
}

/// A stage of the workflow: the phases are the strip of MOB-78.
final class PwfPhase {
  const PwfPhase({required this.code, required this.name, required this.order, required this.requiredTotal, required this.requiredDone, required this.open});

  final String code;
  final String name;
  final int order;
  final int requiredTotal;
  final int requiredDone;
  final bool open;
}

PwfPhase? parsePwfPhase(Object? raw) {
  final Json? record = asRecord(raw);
  if (record == null) return null;
  final String? code = filled(record['code']);
  final String? name = filled(record['name']);
  final int? order = whole(record['order']);
  if (code == null || name == null || order == null) return null;
  return PwfPhase(code: code, name: name, order: order, requiredTotal: count(record['required_total']), requiredDone: count(record['required_done']), open: record['open'] == true);
}

/// The workflow of one project as `getProjectWorkflow` answers.
final class PwfWorkflow {
  const PwfWorkflow({
    required this.status,
    required this.templateCode,
    required this.unverified,
    required this.phases,
    required this.tasks,
    required this.countsByBand,
    required this.asOf,
    this.openPhase,
    this.plannedStart,
  });

  final String status;
  final String templateCode;

  /// The template is a default that the customer has not confirmed: the screen says so.
  final bool unverified;
  final List<PwfPhase> phases;
  final List<PwfTaskRow> tasks;

  /// The exact count per official colour (not the length of [tasks]).
  final Map<PwfBandKind, int> countsByBand;
  final String asOf;
  final String? openPhase;
  final String? plannedStart;

  /// The tasks that are work to do or done: a branch the project does not have is not one.
  List<PwfTaskRow> get visibleTasks => <PwfTaskRow>[for (final PwfTaskRow task in tasks) if (!task.excluded) task];

  List<PwfTaskRow> tasksOf(String phaseCode) => <PwfTaskRow>[for (final PwfTaskRow task in visibleTasks) if (task.phaseCode == phaseCode) task];

  int get requiredTotal => phases.fold<int>(0, (int sum, PwfPhase phase) => sum + phase.requiredTotal);
  int get requiredDone => phases.fold<int>(0, (int sum, PwfPhase phase) => sum + phase.requiredDone);

  /// The place of the open phase on the strip, 1-based; the last when every phase is finished, 0 when there is no phase.
  int get currentIndex {
    if (phases.isEmpty) return 0;
    final int index = phases.indexWhere((PwfPhase phase) => phase.open || phase.code == openPhase);
    return index < 0 ? phases.length : index + 1;
  }

  PwfPhase? get currentPhase => currentIndex == 0 ? null : phases[currentIndex - 1];

  /// The milestones still ahead, the nearest first.
  List<PwfTaskRow> upcomingMilestones({int limit = 3}) {
    final List<PwfTaskRow> ahead = <PwfTaskRow>[for (final PwfTaskRow task in visibleTasks) if (task.isMilestone && !task.status.isFinal && task.plannedFinish != null) task]
      ..sort((PwfTaskRow a, PwfTaskRow b) => a.plannedFinish!.compareTo(b.plannedFinish!));
    return ahead.take(limit).toList();
  }
}

/// What the tab and MOB-78 show: the workflow, or the fact that the project has none.
sealed class PwfWorkflowView {
  const PwfWorkflowView();
}

final class PwfWorkflowPresent extends PwfWorkflowView {
  const PwfWorkflowPresent(this.workflow);

  final PwfWorkflow workflow;
}

final class PwfWorkflowAbsent extends PwfWorkflowView {
  const PwfWorkflowAbsent(this.asOf);

  /// When the phone asked; the project had no workflow then.
  final String asOf;
}

/// Reads the answer of `getProjectWorkflow`; the read function turns a 404 into `{'absent': true, 'as_of': ...}`.
PwfWorkflowView? parsePwfWorkflowView(Object? raw) {
  final Json? record = asRecord(raw);
  if (record == null) return null;
  if (record['absent'] == true) return PwfWorkflowAbsent(text(record['as_of']) ?? '');
  final String? status = filled(record['status']);
  final String? template = filled(record['template_code']);
  final String? asOf = filled(record['as_of']);
  final List<PwfPhase> phases = <PwfPhase>[for (final Object? item in listOf(record['phases'])) ?parsePwfPhase(item)]..sort((PwfPhase a, PwfPhase b) => a.order.compareTo(b.order));
  final List<PwfTaskRow> tasks = <PwfTaskRow>[];
  for (final Object? item in listOf(record['tasks'])) {
    final PwfTaskRow? task = parsePwfTaskRow(item);
    if (task == null) return null;
    tasks.add(task);
  }
  if (status == null || template == null || asOf == null) return null;
  final Json counts = asRecord(record['counts_by_band']) ?? const <String, Object?>{};
  return PwfWorkflowPresent(
    PwfWorkflow(
      status: status,
      templateCode: template,
      unverified: record['unverified'] == true,
      phases: phases,
      tasks: tasks,
      asOf: asOf,
      openPhase: filled(record['open_phase']),
      plannedStart: day(record['planned_start_date']),
      countsByBand: <PwfBandKind, int>{
        PwfBandKind.none: count(counts['NONE']),
        PwfBandKind.green: count(counts['GREEN']),
        PwfBandKind.yellow: count(counts['YELLOW']),
        PwfBandKind.red: count(counts['RED']),
        PwfBandKind.unknown: count(counts['UNKNOWN']),
      },
    ),
  );
}

// ---- My tasks (MOB-80) -----------------------------------------------------------------------------------------------------------

/// One task of the person, with the official band and the band of their own settings (R40): the personal band is shown only on the screen of
/// their own tasks, with its label and the real date.
final class PwfMyTask {
  const PwfMyTask({
    required this.taskId,
    required this.code,
    required this.name,
    required this.projectId,
    required this.projectCode,
    required this.status,
    required this.official,
    required this.personal,
    required this.critical,
    required this.version,
    this.dueDate,
  });

  final String taskId;
  final String code;
  final String name;
  final String projectId;
  final String projectCode;
  final PwfTaskStatus status;
  final String? dueDate;
  final PwfBand official;
  final PwfBand personal;
  final bool critical;
  final int version;

  /// The personal setting gives another colour than the official rule does.
  bool get personalDiffers => personal.kind != official.kind;
}

final class PwfMyTasks {
  const PwfMyTasks({required this.items, required this.total, required this.asOf, this.nextCursor});

  final List<PwfMyTask> items;
  final int total;
  final String asOf;
  final String? nextCursor;
}

PwfMyTasks? parsePwfMyTasks(Object? raw) {
  final Json? record = asRecord(raw);
  final String? asOf = filled(record?['as_of']);
  if (record == null || asOf == null) return null;
  final List<PwfMyTask> items = <PwfMyTask>[];
  for (final Object? entry in listOf(record['items'])) {
    final Json? item = asRecord(entry);
    final String? id = filled(item?['task_id']);
    final String? code = filled(item?['task_code']);
    final String? name = filled(item?['name']);
    final String? projectId = filled(item?['project_id']);
    final PwfTaskStatus? status = PwfTaskStatus.parse(item?['status']);
    final PwfBand? official = parsePwfBand(item?['official_band']);
    final PwfBand? personal = parsePwfBand(item?['personal_band']);
    final int? version = whole(item?['version']);
    if (item == null || id == null || code == null || name == null || projectId == null || status == null || official == null || personal == null || version == null) return null;
    items.add(
      PwfMyTask(
        taskId: id,
        code: code,
        name: name,
        projectId: projectId,
        projectCode: filled(item['project_code']) ?? '',
        status: status,
        dueDate: day(item['due_date']),
        official: official,
        personal: personal,
        critical: item['critical'] == true,
        version: version,
      ),
    );
  }
  return PwfMyTasks(items: items, total: count(record['total']), asOf: asOf, nextCursor: filled(record['next_cursor']));
}

// ---- A task (MOB-79) -------------------------------------------------------------------------------------------------------------

final class PwfChecklistItem {
  const PwfChecklistItem({required this.code, required this.name, required this.mandatory, required this.done, this.evidenceKinds = const <String>[]});

  final String code;
  final String name;
  final bool mandatory;
  final bool done;
  final List<String> evidenceKinds;
}

/// A legal document type or a form the task needs, and whether it is already attached.
final class PwfRequirement {
  const PwfRequirement({required this.code, required this.satisfied});

  final String code;
  final bool satisfied;
}

final class PwfEvidence {
  const PwfEvidence({required this.id, required this.kind, required this.attachedAt, this.itemCode, this.legalDocType, this.formTemplateCode, this.externalRef, this.note});

  final String id;
  final String kind;
  final String attachedAt;
  final String? itemCode;
  final String? legalDocType;
  final String? formTemplateCode;
  final String? externalRef;
  final String? note;
}

/// What stops the task from being completed: the code of the rule and what it is about (an item, a document type, a form).
final class PwfBlocker {
  const PwfBlocker({required this.code, required this.subject});

  final String code;
  final String subject;
}

final class PwfException {
  const PwfException({required this.id, required this.kind, required this.status, required this.reason, this.validFrom, this.validTo, this.decisionNote});

  final String id;

  /// `WAIVE_REQUIREMENT`, `CANCEL_TASK`, `PAUSE` or `EXTERNAL_DELAY`.
  final String kind;

  /// `REQUESTED`, `APPROVED`, `REJECTED` or `USED`.
  final String status;
  final String reason;
  final String? validFrom;
  final String? validTo;
  final String? decisionNote;
}

final class PwfHistoryEntry {
  const PwfHistoryEntry({required this.id, required this.kind, required this.at, this.reason});

  final String id;
  final String kind;
  final String at;
  final String? reason;
}

/// The task with everything the person needs to work on it, and what they may do now (the server decides every `can_*`).
final class PwfTaskDetail {
  const PwfTaskDetail({
    required this.id,
    required this.code,
    required this.name,
    required this.phaseCode,
    required this.isMilestone,
    required this.mandatory,
    required this.status,
    required this.band,
    required this.version,
    required this.asOf,
    required this.checklist,
    required this.legalDocTypes,
    required this.formTemplates,
    required this.evidence,
    required this.blockers,
    required this.exceptions,
    required this.history,
    required this.canStart,
    required this.canComplete,
    required this.canApprove,
    required this.canReturn,
    required this.canRequestException,
    required this.canResume,
    this.responsibleRole,
    this.approverRole,
    this.assignee,
    this.plannedStart,
    this.plannedFinish,
    this.baselineFinish,
    this.actualStart,
    this.actualFinish,
    this.finishVarianceDays,
    this.critical = false,
    this.returnCount = 0,
    this.missingYear,
    this.percentComplete,
  });

  final String id;
  final String code;
  final String name;
  final String phaseCode;
  final bool isMilestone;
  final bool mandatory;
  final PwfTaskStatus status;

  /// The official band, the only one a shared screen shows.
  final PwfBand band;
  final int version;
  final String asOf;
  final List<PwfChecklistItem> checklist;
  final List<PwfRequirement> legalDocTypes;
  final List<PwfRequirement> formTemplates;
  final List<PwfEvidence> evidence;
  final List<PwfBlocker> blockers;
  final List<PwfException> exceptions;
  final List<PwfHistoryEntry> history;
  final bool canStart;
  final bool canComplete;
  final bool canApprove;
  final bool canReturn;
  final bool canRequestException;
  final bool canResume;
  final String? responsibleRole;
  final String? approverRole;
  final String? assignee;
  final String? plannedStart;
  final String? plannedFinish;
  final String? baselineFinish;
  final String? actualStart;
  final String? actualFinish;
  final int? finishVarianceDays;
  final bool critical;
  final int returnCount;
  final int? missingYear;
  final int? percentComplete;

  bool get hasPendingException => exceptions.any((PwfException e) => e.status == 'REQUESTED');
}

PwfTaskDetail? parsePwfTaskDetail(Object? raw) {
  final Json? record = asRecord(raw);
  if (record == null) return null;
  final String? id = filled(record['id']);
  final String? code = filled(record['task_code']);
  final String? name = filled(record['name']);
  final String? phase = filled(record['phase_code']);
  final PwfTaskStatus? status = PwfTaskStatus.parse(record['status']);
  final PwfBand? band = parsePwfBand(record['band']);
  final int? version = whole(record['version']);
  final String? asOf = filled(record['as_of']);
  if (id == null || code == null || name == null || phase == null || status == null || band == null || version == null || asOf == null) return null;
  final List<PwfChecklistItem> checklist = <PwfChecklistItem>[];
  for (final Object? entry in listOf(record['checklist'])) {
    final Json? item = asRecord(entry);
    final String? itemCode = filled(item?['item_code']);
    final String? itemName = filled(item?['name']);
    if (item == null || itemCode == null || itemName == null) return null;
    checklist.add(
      PwfChecklistItem(
        code: itemCode,
        name: itemName,
        mandatory: item['required'] == true,
        done: item['done'] == true,
        evidenceKinds: <String>[for (final Object? kind in listOf(item['evidence_kinds'])) ?filled(kind)],
      ),
    );
  }
  List<PwfRequirement> requirements(Object? value) => <PwfRequirement>[
        for (final Object? entry in listOf(value))
          if (asRecord(entry) case final Json item when filled(item['code']) != null) PwfRequirement(code: filled(item['code'])!, satisfied: item['satisfied'] == true),
      ];
  final Json completion = asRecord(record['completion']) ?? const <String, Object?>{};
  return PwfTaskDetail(
    id: id,
    code: code,
    name: name,
    phaseCode: phase,
    isMilestone: record['kind'] == 'MILESTONE',
    mandatory: record['required'] == true,
    status: status,
    band: band,
    version: version,
    asOf: asOf,
    checklist: checklist,
    legalDocTypes: requirements(record['legal_doc_types']),
    formTemplates: requirements(record['form_templates']),
    evidence: <PwfEvidence>[
      for (final Object? entry in listOf(record['evidence']))
        if (asRecord(entry) case final Json item when filled(item['id']) != null && filled(item['evidence_kind']) != null && filled(item['attached_at']) != null)
          PwfEvidence(
            id: filled(item['id'])!,
            kind: filled(item['evidence_kind'])!,
            attachedAt: filled(item['attached_at'])!,
            itemCode: filled(item['item_code']),
            legalDocType: filled(item['legal_doc_type']),
            formTemplateCode: filled(item['form_template_code']),
            externalRef: filled(item['external_ref']),
            note: filled(item['note']),
          ),
    ],
    blockers: <PwfBlocker>[
      for (final Object? entry in listOf(completion['blockers']))
        if (asRecord(entry) case final Json item when filled(item['code']) != null) PwfBlocker(code: filled(item['code'])!, subject: text(item['subject']) ?? ''),
    ],
    exceptions: <PwfException>[
      for (final Object? entry in listOf(record['exceptions']))
        if (asRecord(entry) case final Json item when filled(item['id']) != null && filled(item['kind']) != null && filled(item['status']) != null)
          PwfException(
            id: filled(item['id'])!,
            kind: filled(item['kind'])!,
            status: filled(item['status'])!,
            reason: text(item['reason']) ?? '',
            validFrom: day(item['valid_from']),
            validTo: day(item['valid_to']),
            decisionNote: filled(item['decision_note']),
          ),
    ],
    history: <PwfHistoryEntry>[
      for (final Object? entry in listOf(record['history']))
        if (asRecord(entry) case final Json item when filled(item['id']) != null && filled(item['kind']) != null && filled(item['at']) != null)
          PwfHistoryEntry(id: filled(item['id'])!, kind: filled(item['kind'])!, at: filled(item['at'])!, reason: filled(item['reason'])),
    ],
    canStart: record['can_start'] == true,
    canComplete: record['can_complete'] == true,
    canApprove: record['can_approve'] == true,
    canReturn: record['can_return'] == true,
    canRequestException: record['can_request_exception'] == true,
    canResume: record['can_resume'] == true,
    responsibleRole: filled(record['responsible_role']),
    approverRole: filled(record['approver_role']),
    assignee: filled(asRecord(record['assignee'])?['display_name']),
    plannedStart: day(record['planned_start']),
    plannedFinish: day(record['planned_finish']),
    baselineFinish: day(record['baseline_finish']),
    actualStart: day(record['actual_start']),
    actualFinish: day(record['actual_finish']),
    finishVarianceDays: whole(record['finish_variance_days']),
    critical: record['critical'] == true,
    returnCount: count(record['return_count']),
    missingYear: whole(record['missing_year']),
    percentComplete: whole(record['percent_complete']),
  );
}

// ---- The personal deadline settings (MOB-82) -------------------------------------------------------------------------------------

/// The three thresholds of the official rule: red up to `red`, yellow up to `yellow`, green up to `green` (null: every larger count is green).
final class PwfThresholds {
  const PwfThresholds({required this.yellow, required this.red, this.green});

  final int? green;
  final int yellow;
  final int red;
}

final class PwfPreference {
  const PwfPreference({required this.reminderDays, required this.version, this.green, this.yellow, this.red, this.official, this.clamped = const <String>[]});

  /// The person's own thresholds; null where they have set none (the official one applies).
  final int? green;
  final int? yellow;
  final int? red;
  final List<int> reminderDays;
  final PwfThresholds? official;

  /// The thresholds the server raised to the official level because they were later than it (a personal setting can only be earlier).
  final List<String> clamped;
  final int version;
}

PwfPreference? parsePwfPreference(Object? raw) {
  final Json? record = asRecord(raw);
  if (record == null) return null;
  final Json? official = asRecord(record['official']);
  final int? yellow = whole(official?['yellow_days']);
  final int? red = whole(official?['red_days']);
  return PwfPreference(
    green: whole(record['green_days']),
    yellow: whole(record['yellow_days']),
    red: whole(record['red_days']),
    reminderDays: <int>[for (final Object? entry in listOf(record['reminder_days'])) ?whole(entry)],
    official: yellow == null || red == null ? null : PwfThresholds(green: whole(official?['green_days']), yellow: yellow, red: red),
    clamped: <String>[for (final Object? name in listOf(record['clamped'])) ?filled(name)],
    version: whole(record['version']) ?? 0,
  );
}

// ---- My score (MOB-81) -----------------------------------------------------------------------------------------------------------

final class PwfScoreContribution {
  const PwfScoreContribution({required this.taskCode, required this.name, required this.fraction, required this.weight, required this.score});

  final String taskCode;
  final String name;
  final num fraction;
  final num weight;
  final num score;
}

final class PwfScoreAdjustment {
  const PwfScoreAdjustment({required this.points, required this.reason, required this.status});

  final num points;
  final String reason;
  final String status;
}

final class PwfScoreResponse {
  const PwfScoreResponse({required this.body, required this.status, required this.submittedAt, this.conclusion});

  final String body;
  final String status;
  final String submittedAt;
  final String? conclusion;
}

/// The score of the person for one period, with the working of it: only the person's own line is ever read here (R33).
final class PwfScoreLine {
  const PwfScoreLine({
    required this.id,
    required this.periodId,
    required this.periodFrom,
    required this.periodTo,
    required this.periodStatus,
    required this.state,
    required this.ratedTaskCount,
    required this.contributions,
    required this.excluded,
    required this.adjustments,
    required this.responses,
    required this.canRespond,
    required this.version,
    this.scoreComputed,
    this.scoreAdjusted,
    this.rating,
    this.responseUntil,
    this.policyCode,
    this.policyVersion,
  });

  final String id;
  final String periodId;
  final String periodFrom;
  final String periodTo;

  /// `DRAFT`, `LOCKED` or `OFFICIAL`.
  final String periodStatus;

  /// `RATED`, `NOT_RATED` or `SMALL_SAMPLE`: with a small sample the score is shown with its number of tasks and no rating.
  final String state;
  final int ratedTaskCount;
  final num? scoreComputed;
  final num? scoreAdjusted;
  final String? rating;
  final String? responseUntil;
  final List<PwfScoreContribution> contributions;
  final List<({String taskCode, String reason})> excluded;
  final List<PwfScoreAdjustment> adjustments;
  final List<PwfScoreResponse> responses;
  final bool canRespond;
  final int version;
  final String? policyCode;
  final int? policyVersion;

  /// The score the person is shown first: the adjusted one when an approved adjustment changed it, else the computed one.
  num? get shownScore => scoreAdjusted ?? scoreComputed;
}

final class PwfMyScores {
  const PwfMyScores({required this.lines, required this.asOf});

  final List<PwfScoreLine> lines;
  final String asOf;
}

num? _number(Object? value) => value is num ? value : null;

PwfMyScores? parsePwfMyScores(Object? raw) {
  final Json? record = asRecord(raw);
  final String? asOf = filled(record?['as_of']);
  if (record == null || asOf == null) return null;
  final List<PwfScoreLine> lines = <PwfScoreLine>[];
  for (final Object? entry in listOf(record['items'])) {
    final Json? item = asRecord(entry);
    final Json? period = asRecord(item?['period']);
    final Json? line = asRecord(item?['line']);
    final String? id = filled(line?['id']);
    final String? periodId = filled(line?['period_id']);
    final String? from = day(period?['period_from']);
    final String? to = day(period?['period_to']);
    final String? state = filled(line?['state']);
    final int? version = whole(line?['version']);
    if (period == null || line == null || id == null || periodId == null || from == null || to == null || state == null || version == null) return null;
    final Json basis = asRecord(line['basis']) ?? const <String, Object?>{};
    lines.add(
      PwfScoreLine(
        id: id,
        periodId: periodId,
        periodFrom: from,
        periodTo: to,
        periodStatus: filled(line['period_status']) ?? filled(period['status']) ?? 'DRAFT',
        state: state,
        ratedTaskCount: count(line['rated_task_count']),
        scoreComputed: _number(line['score_computed']),
        scoreAdjusted: _number(line['score_adjusted']),
        rating: filled(line['rating']),
        responseUntil: day(period['response_until']),
        contributions: <PwfScoreContribution>[
          for (final Object? c in listOf(line['contributions']))
            if (asRecord(c) case final Json row when filled(row['task_code']) != null && _number(row['score']) != null)
              PwfScoreContribution(taskCode: filled(row['task_code'])!, name: text(row['name']) ?? '', fraction: _number(row['fraction']) ?? 0, weight: _number(row['weight']) ?? 0, score: _number(row['score'])!),
        ],
        excluded: <({String taskCode, String reason})>[
          for (final Object? e in listOf(line['excluded']))
            if (asRecord(e) case final Json row when filled(row['task_code']) != null) (taskCode: filled(row['task_code'])!, reason: text(row['reason']) ?? ''),
        ],
        adjustments: <PwfScoreAdjustment>[
          for (final Object? a in listOf(line['adjustments']))
            if (asRecord(a) case final Json row when _number(row['points']) != null) PwfScoreAdjustment(points: _number(row['points'])!, reason: text(row['reason']) ?? '', status: text(row['status']) ?? ''),
        ],
        responses: <PwfScoreResponse>[
          for (final Object? r in listOf(line['responses']))
            if (asRecord(r) case final Json row when filled(row['body']) != null) PwfScoreResponse(body: filled(row['body'])!, status: text(row['status']) ?? '', submittedAt: text(row['submitted_at']) ?? '', conclusion: filled(row['conclusion'])),
        ],
        canRespond: line['can_respond'] == true,
        version: version,
        policyCode: filled(basis['policy_code']),
        policyVersion: whole(basis['policy_version']),
      ),
    );
  }
  return PwfMyScores(lines: lines, asOf: asOf);
}
