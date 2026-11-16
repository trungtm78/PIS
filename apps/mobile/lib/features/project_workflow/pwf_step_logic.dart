import '../read_support/wire.dart';
import 'pwf_models.dart';

/// The rules of the step table that need no screen (PWF-5): what a step waits for, the rows of a phase, what a person may do on a row, and the second
/// read of MOB-78 (the schedule: the step that drives another and how far the whole file stands behind its baseline). Nothing here decides a colour or a
/// deadline: those are the server's (R73); this only picks, groups and names what the answers already say.

// ---- The schedule hints ----------------------------------------------------------------------------------------------------------------

/// What the phone takes from `getProjectSchedule`: for each task by code the task that drives its start, and how many working days its finish stands behind its first baseline.
/// It is read after the workflow, only to say "Đang chặn bởi" and the slip of the whole file; an answer that cannot be read leaves both unsaid (nothing is guessed).
final class PwfScheduleHints {
  const PwfScheduleHints({this.drivingPredecessor = const <String, String>{}, this.finishVariance = const <String, int>{}});

  static const PwfScheduleHints none = PwfScheduleHints();

  final Map<String, String> drivingPredecessor;
  final Map<String, int> finishVariance;
}

PwfScheduleHints? parsePwfScheduleHints(Object? raw) {
  final Json? record = asRecord(raw);
  if (record == null || record['tasks'] is! List) return null;
  final Map<String, String> driving = <String, String>{};
  final Map<String, int> variance = <String, int>{};
  for (final Object? entry in listOf(record['tasks'])) {
    final Json? item = asRecord(entry);
    final String? code = filled(item?['task_code']);
    if (item == null || code == null) continue;
    final String? before = filled(item['driving_predecessor']);
    if (before != null) driving[code] = before;
    final int? slip = whole(item['finish_variance_days']);
    if (slip != null) variance[code] = slip;
  }
  return PwfScheduleHints(drivingPredecessor: driving, finishVariance: variance);
}

/// How many working days the deadline of the whole file stands behind its first baseline, as the schedule counts them; null when it is not read.
int? pwfOverallSlip(PwfWorkflow workflow, PwfScheduleHints? hints) {
  final PwfOverallDeadline? overall = workflow.overallDeadline;
  final String? code = overall?.taskCode;
  if (hints == null || code == null) return null;
  return hints.finishVariance[code];
}

// ---- What a step waits for -------------------------------------------------------------------------------------------------------------

enum PwfWaitKind { approval, evidence, step }

/// One thing a step waits for: the approver of its completion, evidence still to be handed in, or the step that drives its start.
final class PwfWaitingFor {
  const PwfWaitingFor(this.kind, {this.count = 0, this.name});

  final PwfWaitKind kind;
  final int count;
  final String? name;

  @override
  bool operator ==(Object other) => other is PwfWaitingFor && other.kind == kind && other.count == count && other.name == name;

  @override
  int get hashCode => Object.hash(kind, count, name);
}

/// What a task waits for, from the answers the screen already holds: no request per row. A task that is over, left out or not followed waits for nothing.
List<PwfWaitingFor> pwfWaitingFor(PwfTaskRow task, {PwfScheduleHints? hints, Map<String, PwfTaskRow> byCode = const <String, PwfTaskRow>{}}) {
  if (task.status.isFinal || task.excluded || !task.tracked) return const <PwfWaitingFor>[];
  final List<PwfWaitingFor> found = <PwfWaitingFor>[];
  if (task.status == PwfTaskStatus.awaitingApproval) found.add(const PwfWaitingFor(PwfWaitKind.approval));
  final int open = task.checklistTotal - task.checklistDone;
  if (task.status == PwfTaskStatus.inProgress && open > 0) found.add(PwfWaitingFor(PwfWaitKind.evidence, count: open));
  if (task.status == PwfTaskStatus.notStarted) {
    final String? driving = hints?.drivingPredecessor[task.code];
    final PwfTaskRow? before = driving == null ? null : byCode[driving];
    if (before != null && !before.status.isFinal && !before.excluded) found.add(PwfWaitingFor(PwfWaitKind.step, name: before.name));
  }
  return found;
}

// ---- The rows of a phase ---------------------------------------------------------------------------------------------------------------

/// A line of the step list: a step with the tasks that belong to it (one task is ONE row; several are a step header with its tasks under it), or a task
/// the project added itself, which belongs to no step.
final class PwfStepEntry {
  const PwfStepEntry({required this.tasks, this.step});

  final PwfStep? step;
  final List<PwfTaskRow> tasks;

  /// The step names several tasks: it gets its own header line.
  bool get hasHeader => step != null && tasks.length > 1;
}

final class PwfPhaseRows {
  const PwfPhaseRows({required this.phase, required this.entries});

  final PwfPhase phase;
  final List<PwfStepEntry> entries;

  List<PwfTaskRow> get tasks => <PwfTaskRow>[for (final PwfStepEntry entry in entries) ...entry.tasks];
}

/// The phases of the workflow with their steps in the order of the template (the order is the process, not a ranking), then the tasks of the phase that
/// belong to no step. A workflow read from before steps existed has no step: every task is then a row of its phase.
List<PwfPhaseRows> pwfPhaseRows(PwfWorkflow workflow) {
  return <PwfPhaseRows>[
    for (final PwfPhase phase in workflow.phases)
      PwfPhaseRows(
        phase: phase,
        entries: <PwfStepEntry>[
          for (final PwfStep step in workflow.stepsOf(phase.code))
            if (workflow.tasksOfStep(phase.code, step.code) case final List<PwfTaskRow> tasks when tasks.isNotEmpty) PwfStepEntry(step: step, tasks: tasks),
          for (final PwfTaskRow task in workflow.tasksOfStep(phase.code, null)) PwfStepEntry(tasks: <PwfTaskRow>[task]),
        ],
      ),
  ];
}

// ---- The head of the workflow ----------------------------------------------------------------------------------------------------------

/// How far the workflow is: the steps done of the steps that apply; a workflow with no steps counts its tasks (those left out of the project or cancelled are not counted).
({int done, int total, bool ofSteps}) pwfProgress(PwfWorkflow workflow) {
  final List<PwfStep> steps = <PwfStep>[for (final PwfStep step in workflow.steps) if (step.status != PwfStepStatus.notApplicable) step];
  if (steps.isNotEmpty) return (done: steps.where((PwfStep step) => step.status == PwfStepStatus.done).length, total: steps.length, ofSteps: true);
  final List<PwfTaskRow> tasks = <PwfTaskRow>[for (final PwfTaskRow task in workflow.visibleTasks) if (task.status != PwfTaskStatus.cancelled) task];
  return (done: tasks.where((PwfTaskRow task) => task.status == PwfTaskStatus.done).length, total: tasks.length, ofSteps: false);
}

/// The row of the task that carries the deadline of the whole file, when the workflow says which one it is and the row is in the answer.
PwfTaskRow? pwfOverallTask(PwfWorkflow workflow) {
  final PwfOverallDeadline? overall = workflow.overallDeadline;
  if (overall == null) return null;
  for (final PwfTaskRow task in workflow.tasks) {
    if (task.id == overall.taskId) return task;
  }
  return null;
}

// ---- What a person may do on a row -----------------------------------------------------------------------------------------------------

/// The extension a row may be asked for: how much of the limit is used (the server's count) and whether a limit is reached.
final class PwfExtensionOffer {
  const PwfExtensionOffer(this.extension);

  final PwfExtension extension;

  bool get capped => extension.capped;
}

/// The actions of the sheet of a row, by what the server says the person may do and by the state of the task. The server decides again on every command and
/// says why not; this only keeps a button from being drawn that could never work.
final class PwfRowActions {
  const PwfRowActions({this.claim = false, this.submit = false, this.complete = false, this.extend, this.pendingRequirements = 0});

  /// "Nhận việc": the person is eligible and nobody holds the task.
  final bool claim;

  /// "Nộp hồ sơ": the task is theirs and still lacks something before it can be completed; the many fields are on MOB-79.
  final bool submit;

  /// "Hoàn thành": the task is theirs and nothing blocks it.
  final bool complete;

  /// "Xin gia hạn": the frozen template allows it for a step that is still to be done, for a person who may propose a change of the schedule.
  final PwfExtensionOffer? extend;

  /// How many requirements still stand before the completion (for the hint of "Nộp hồ sơ").
  final int pendingRequirements;

  bool get any => claim || submit || complete || extend != null;
}

PwfRowActions pwfRowActions(PwfTaskDetail detail, {required bool canPropose, PwfExtension? extension}) {
  if (detail.status.isFinal) return const PwfRowActions();
  final bool working = detail.status == PwfTaskStatus.inProgress && detail.canComplete;
  final PwfExtension? rule = extension ?? detail.facts.extension;
  return PwfRowActions(
    claim: detail.canClaim,
    submit: working && detail.blockers.isNotEmpty,
    complete: working && detail.blockers.isEmpty,
    extend: rule != null && rule.allowed && canPropose ? PwfExtensionOffer(rule) : null,
    pendingRequirements: detail.blockers.length,
  );
}
