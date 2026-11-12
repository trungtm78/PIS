import type { Translator } from '../../i18n';
import type { AssignmentRole, Band, BandUnit, BlockerCode, DependencyKind, ExceptionKind, GateTarget, Priority, Problem, TaskBand, TaskKind, TaskStatus } from './model';
import type { FormProblem } from './model';

type T = Translator['t'];

// Each key is written out in a switch so that the i18n check can see it is in use.

export function bandWord(t: T, band: Band): string {
  switch (band) {
    case 'RED':
      return t('pwf.band.red.word');
    case 'YELLOW':
      return t('pwf.band.yellow.word');
    case 'GREEN':
      return t('pwf.band.green.word');
    case 'NONE':
      return t('pwf.band.none.word');
    case 'UNKNOWN':
      return t('pwf.band.unknown.word');
  }
}

export function unitWord(t: T, unit: BandUnit): string {
  return unit === 'WORKING' ? t('pwf.unit.working.word') : t('pwf.unit.calendar.word');
}

/** "2 working days left", "overdue 3 days": the figure of a band with its unit; a band with no day count says nothing. */
export function remainingText(t: T, band: TaskBand): string | undefined {
  if (band.remaining_days === null) return undefined;
  const unit = unitWord(t, band.unit);
  if (band.remaining_days < 0) return t('pwf.band.overdue.text', { days: Math.abs(band.remaining_days), unit });
  if (band.remaining_days === 0) return t('pwf.band.today.text');
  return t('pwf.band.remaining.text', { days: band.remaining_days, unit });
}

export function statusWord(t: T, status: TaskStatus): string {
  switch (status) {
    case 'NOT_STARTED':
      return t('pwf.status.notStarted.word');
    case 'IN_PROGRESS':
      return t('pwf.status.inProgress.word');
    case 'AWAITING_APPROVAL':
      return t('pwf.status.awaitingApproval.word');
    case 'DONE':
      return t('pwf.status.done.word');
    case 'ON_HOLD':
      return t('pwf.status.onHold.word');
    case 'CANCELLED':
      return t('pwf.status.cancelled.word');
  }
}

export function kindWord(t: T, kind: TaskKind): string {
  return kind === 'MILESTONE' ? t('pwf.kind.milestone.word') : t('pwf.kind.task.word');
}

export function priorityWord(t: T, priority: Priority): string {
  switch (priority) {
    case 'LOW':
      return t('pwf.priority.low.word');
    case 'NORMAL':
      return t('pwf.priority.normal.word');
    case 'HIGH':
      return t('pwf.priority.high.word');
    case 'CRITICAL':
      return t('pwf.priority.critical.word');
  }
}

export function dependencyWord(t: T, kind: DependencyKind): string {
  switch (kind) {
    case 'FS':
      return t('pwf.dependency.fs.word');
    case 'SS':
      return t('pwf.dependency.ss.word');
    case 'FF':
      return t('pwf.dependency.ff.word');
    case 'SF':
      return t('pwf.dependency.sf.word');
  }
}

export function gateWord(t: T, target: GateTarget): string {
  switch (target) {
    case 'submitProjectForAppraisal':
      return t('pwf.gate.submit.word');
    case 'decideProjectAppraisal':
      return t('pwf.gate.decide.word');
    case 'capital.plan_published.v1':
      return t('pwf.gate.capital.word');
    case 'startProjectImplementation':
      return t('pwf.gate.start.word');
    case 'suspendProject':
      return t('pwf.gate.suspend.word');
    case 'resumeProject':
      return t('pwf.gate.resume.word');
    case 'completeProject':
      return t('pwf.gate.complete.word');
    case 'settlement.closed.v1':
      return t('pwf.gate.settlement.word');
    case 'closeProject':
      return t('pwf.gate.close.word');
  }
}

export function exceptionWord(t: T, kind: ExceptionKind): string {
  switch (kind) {
    case 'WAIVE_REQUIREMENT':
      return t('pwf.exception.waive.word');
    case 'CANCEL_TASK':
      return t('pwf.exception.cancel.word');
    case 'PAUSE':
      return t('pwf.exception.pause.word');
    case 'EXTERNAL_DELAY':
      return t('pwf.exception.delay.word');
  }
}

export function roleWord(t: T, role: AssignmentRole): string {
  switch (role) {
    case 'RESPONSIBLE':
      return t('pwf.role.responsible.word');
    case 'ACCOUNTABLE':
      return t('pwf.role.accountable.word');
    case 'CONSULTED':
      return t('pwf.role.consulted.word');
    case 'INFORMED':
      return t('pwf.role.informed.word');
  }
}

export function blockerWord(t: T, code: BlockerCode, subject: string): string {
  switch (code) {
    case 'CHECKLIST_ITEM_OPEN':
      return t('pwf.blocker.checklist.text', { subject });
    case 'EVIDENCE_MISSING':
      return t('pwf.blocker.evidence.text', { subject });
    case 'LEGAL_DOC_MISSING':
      return t('pwf.blocker.legalDoc.text', { subject });
    case 'FORM_MISSING':
      return t('pwf.blocker.form.text', { subject });
    case 'APPROVER_REQUIRED':
      return t('pwf.blocker.approver.text', { subject });
    case 'MAKER_IS_APPROVER':
      return t('pwf.blocker.maker.text', { subject });
  }
}

export function missingReasonWord(t: T, reason: 'NO_STATE' | 'NOT_DONE' | 'COMPLETION_NOT_APPROVED' | 'CANCELLED_WITHOUT_APPROVAL'): string {
  switch (reason) {
    case 'NO_STATE':
      return t('pwf.missing.noState.text');
    case 'NOT_DONE':
      return t('pwf.missing.notDone.text');
    case 'COMPLETION_NOT_APPROVED':
      return t('pwf.missing.notApproved.text');
    case 'CANCELLED_WITHOUT_APPROVAL':
      return t('pwf.missing.cancelled.text');
  }
}

/** The sentence of a refusal, in the words of the module. */
export function problemText(t: T, problem: Problem): string {
  switch (problem.kind) {
    case 'versionConflict':
      return t('pwf.problem.versionConflict.error');
    case 'scheduleConflict':
      return t('pwf.problem.scheduleConflict.error');
    case 'selfApproval':
      return t('pwf.problem.selfApproval.error');
    case 'completionBlocked':
      return t('pwf.problem.completionBlocked.error');
    case 'gateClosed':
      return t('pwf.problem.gateClosed.error');
    case 'taskState':
      return t('pwf.problem.taskState.error');
    case 'workflowExists':
      return t('pwf.problem.workflowExists.error');
    case 'templateNotFound':
      return t('pwf.problem.templateNotFound.error');
    case 'factsRequired':
      return t('pwf.problem.factsRequired.error');
    case 'adoptInvalid':
      return t('pwf.problem.adoptInvalid.error');
    case 'scheduleInvalid':
      return t('pwf.problem.scheduleInvalid.error');
    case 'dependencyCycle':
      return t('pwf.problem.dependencyCycle.error');
    case 'calendarNotEffective':
      return t('pwf.problem.calendarNotEffective.error');
    case 'reschedulePending':
      return t('pwf.problem.reschedulePending.error');
    case 'exceptionInvalid':
      return t('pwf.problem.exceptionInvalid.error');
    case 'assignmentInvalid':
      return t('pwf.problem.assignmentInvalid.error');
    case 'legalDocUnknown':
      return t('pwf.problem.legalDocUnknown.error');
    case 'templateInvalid':
      return problem.field === undefined ? t('pwf.problem.templateInvalid.error') : t('pwf.problem.templateInvalidField.error', { field: problem.field });
    case 'bandThresholds':
      return t('pwf.problem.bandThresholds.error');
    case 'bandUnit':
      return t('pwf.problem.bandUnit.error');
    case 'validation':
      return problem.field === undefined ? t('pwf.problem.validation.error') : t('pwf.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('pwf.problem.notFound.error');
    case 'denied':
      return t('pwf.problem.denied.error');
    case 'general':
      return t('pwf.problem.general.error');
  }
}

/** A form problem found before anything is sent; `min` and `max` are the limits of the field being said. */
export function formProblemText(t: T, problem: FormProblem, limits: { min?: number; max?: number } = {}): string {
  switch (problem) {
    case 'required':
      return t('pwf.form.required.error');
    case 'tooShort':
      return t('pwf.form.tooShort.error', { min: limits.min ?? 0 });
    case 'tooLong':
      return t('pwf.form.tooLong.error', { max: limits.max ?? 0 });
    case 'invalidDay':
      return t('pwf.form.invalidDay.error');
    case 'invalidNumber':
      return t('pwf.form.invalidNumber.error', { min: limits.min ?? 0, max: limits.max ?? 0 });
    case 'pickOne':
      return t('pwf.form.pickOne.error');
  }
}
