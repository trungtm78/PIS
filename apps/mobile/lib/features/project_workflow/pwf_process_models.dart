import '../read_support/wire.dart';

/// What the phone reads of the procedure of a project (PWF-4): the steps of each phase, the legal grounds of a step and of a task, and the
/// revision of a form. All of it is read, never written here; an answer kept from before these facts existed simply has none of them, and the
/// screens then stay as they were.

/// Whether a legal document may be cited today, as the shared catalogue says. [unknown] is "the catalogue no longer has the code": it is
/// never drawn as in force.
enum PwfLegalState {
  inForce,
  notYetInForce,
  expired,
  superseded,
  unknown;

  static PwfLegalState parse(Object? value) => switch (value) {
        'IN_FORCE' => inForce,
        'NOT_YET_IN_FORCE' => notYetInForce,
        'EXPIRED' => expired,
        'SUPERSEDED' => superseded,
        _ => unknown,
      };

  /// The document must not be cited any more.
  bool get isLapsed => this == expired || this == superseded;

  /// Something a person should look at: lapsed, not yet in force, or not in the catalogue.
  bool get needsAttention => this != inForce;
}

/// One legal ground of a step or of a task: the document as the catalogue names it and what the template cites of it.
final class PwfLegalBasis {
  const PwfLegalBasis({
    required this.documentCode,
    required this.state,
    required this.verified,
    this.docKind,
    this.number,
    this.title,
    this.article,
    this.issuer,
    this.effectiveFrom,
    this.effectiveTo,
    this.supersededBy,
    this.note,
  });

  final String documentCode;
  final PwfLegalState state;

  /// A legal officer confirmed both the document and the citation; anything else is shown as not verified.
  final bool verified;

  /// `LAW`, `DECREE`, `CIRCULAR`...
  final String? docKind;
  final String? number;
  final String? title;

  /// The article as cited; null when nobody is sure of it yet (the screen says so, it never guesses).
  final String? article;
  final String? issuer;
  final String? effectiveFrom;
  final String? effectiveTo;
  final String? supersededBy;
  final String? note;
}

PwfLegalBasis? parsePwfLegalBasis(Object? raw) {
  final Json? record = asRecord(raw);
  final String? code = filled(record?['document_code']);
  if (record == null || code == null) return null;
  return PwfLegalBasis(
    documentCode: code,
    state: PwfLegalState.parse(record['state']),
    verified: record['verification'] == 'VERIFIED' && record['document_verification'] == 'VERIFIED',
    docKind: filled(record['doc_kind']),
    number: filled(record['number']),
    title: filled(record['title']),
    article: filled(record['article']),
    issuer: filled(record['issuer']),
    effectiveFrom: day(record['effective_from']),
    effectiveTo: day(record['effective_to']),
    supersededBy: filled(record['superseded_by']),
    note: filled(record['note']),
  );
}

List<PwfLegalBasis> parsePwfLegalBasisList(Object? raw) => <PwfLegalBasis>[for (final Object? item in listOf(raw)) ?parsePwfLegalBasis(item)];

/// Where a step stands, counted by the server from its tasks.
enum PwfStepStatus {
  notApplicable,
  notStarted,
  inProgress,
  done;

  static PwfStepStatus parse(Object? value) => switch (value) {
        'DONE' => done,
        'IN_PROGRESS' => inProgress,
        'NOT_APPLICABLE' => notApplicable,
        _ => notStarted,
      };
}

/// A step of a phase: the unit of the procedure, made of tasks, each with its own checklist.
final class PwfStep {
  const PwfStep({
    required this.code,
    required this.name,
    required this.phaseCode,
    required this.order,
    required this.implicit,
    required this.status,
    required this.standardWorkingDays,
    required this.taskTotal,
    required this.taskDone,
    required this.checklistTotal,
    required this.checklistDone,
    required this.legalBasis,
    this.responsibleRole,
    this.plannedStart,
    this.plannedFinish,
  });

  final String code;
  final String name;
  final String phaseCode;

  /// 1-based place in its phase.
  final int order;

  /// The phase names no steps: this one stands for the whole phase.
  final bool implicit;
  final PwfStepStatus status;

  /// The standard time of the step, which the server reads from the schedule of its tasks.
  final int standardWorkingDays;
  final int taskTotal;
  final int taskDone;
  final int checklistTotal;
  final int checklistDone;
  final List<PwfLegalBasis> legalBasis;
  final String? responsibleRole;
  final String? plannedStart;
  final String? plannedFinish;

  /// How many of its legal grounds a person should look at.
  int get attention => legalBasis.where((PwfLegalBasis basis) => basis.state.needsAttention).length;
}

PwfStep? parsePwfStep(Object? raw) {
  final Json? record = asRecord(raw);
  if (record == null) return null;
  final String? code = filled(record['code']);
  final String? name = filled(record['name']);
  final String? phase = filled(record['phase_code']);
  final int? order = whole(record['order']);
  if (code == null || name == null || phase == null || order == null) return null;
  return PwfStep(
    code: code,
    name: name,
    phaseCode: phase,
    order: order,
    implicit: record['implicit'] == true,
    status: PwfStepStatus.parse(record['status']),
    standardWorkingDays: count(record['standard_working_days']),
    taskTotal: count(record['task_total']),
    taskDone: count(record['task_done']),
    checklistTotal: count(record['checklist_total']),
    checklistDone: count(record['checklist_done']),
    legalBasis: parsePwfLegalBasisList(record['legal_basis']),
    responsibleRole: filled(record['responsible_role']),
    plannedStart: day(record['planned_start']),
    plannedFinish: day(record['planned_finish']),
  );
}

/// The steps of a workflow in the order of the answer; a step that cannot be read is left out (the tasks then stay under their phase).
List<PwfStep> parsePwfSteps(Object? raw) => <PwfStep>[for (final Object? item in listOf(raw)) ?parsePwfStep(item)]..sort((PwfStep a, PwfStep b) => a.order.compareTo(b.order));

/// The step a task belongs to, as the detail of the task names it.
final class PwfTaskStep {
  const PwfTaskStep({required this.code, required this.name, required this.order, this.responsibleRole});

  final String code;
  final String name;
  final int order;
  final String? responsibleRole;
}

PwfTaskStep? parsePwfTaskStep(Object? raw) {
  final Json? record = asRecord(raw);
  final String? code = filled(record?['code']);
  final String? name = filled(record?['name']);
  if (record == null || code == null || name == null) return null;
  return PwfTaskStep(code: code, name: name, order: whole(record['order']) ?? 1, responsibleRole: filled(record['responsible_role']));
}

/// The revision of a form of a task: the one in force today, the one the evidence of the task was made from, and whether a newer one exists
/// since the task made its document.
final class PwfFormRevision {
  const PwfFormRevision({required this.code, required this.pinned, required this.newerAvailable, this.title, this.pinnedRevision, this.currentRevision, this.usedRevision});

  final String code;

  /// The template pins one revision; otherwise the newest approved revision is used.
  final bool pinned;
  final bool newerAvailable;
  final String? title;
  final int? pinnedRevision;
  final int? currentRevision;
  final int? usedRevision;
}

/// The revisions of the forms of a task; a form the answer says nothing of (an answer from before revisions were kept) is not listed.
List<PwfFormRevision> parsePwfFormRevisions(Object? raw) => <PwfFormRevision>[
      for (final Object? entry in listOf(raw))
        if (asRecord(entry) case final Json item when filled(item['code']) != null && filled(item['policy']) != null)
          PwfFormRevision(
            code: filled(item['code'])!,
            pinned: item['policy'] == 'PINNED',
            newerAvailable: item['newer_available'] == true,
            title: filled(item['current_title']),
            pinnedRevision: whole(item['pinned_revision']),
            currentRevision: whole(item['current_revision']),
            usedRevision: whole(item['used_revision']),
          ),
    ];
