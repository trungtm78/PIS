import type { useTranslation } from '../../../i18n';
import type { ExceptionStatus, FormProblem, IncidentStatus, Problem, Severity, WorkStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: IncidentStatus): string {
  switch (status) {
    case 'OPEN':
      return t('dgv.incident.status.open');
    case 'ASSIGNED':
      return t('dgv.incident.status.assigned');
    case 'ACKNOWLEDGED':
      return t('dgv.incident.status.acknowledged');
    case 'IN_PROGRESS':
      return t('dgv.incident.status.inProgress');
    case 'RESOLVED_PENDING_VERIFICATION':
      return t('dgv.incident.status.resolved');
    case 'CLOSED':
      return t('dgv.incident.status.closed');
    case 'REOPENED':
      return t('dgv.incident.status.reopened');
  }
}

export function severityLabel(t: Translate, severity: Severity): string {
  switch (severity) {
    case 'CRITICAL':
      return t('dgv.incident.severity.critical');
    case 'HIGH':
      return t('dgv.incident.severity.high');
    case 'MEDIUM':
      return t('dgv.incident.severity.medium');
    case 'LOW':
      return t('dgv.incident.severity.low');
  }
}

export function exceptionStatusLabel(t: Translate, status: ExceptionStatus): string {
  switch (status) {
    case 'OPEN':
      return t('dgv.incident.exception.status.open');
    case 'RESOLVED':
      return t('dgv.incident.exception.status.resolved');
    case 'WAIVED':
      return t('dgv.incident.exception.status.waived');
  }
}

/** The button that takes the incident one step on. */
export function advanceLabel(t: Translate, step: WorkStatus): string {
  switch (step) {
    case 'ACKNOWLEDGED':
      return t('dgv.incident.advance.acknowledge');
    case 'IN_PROGRESS':
      return t('dgv.incident.advance.start');
    case 'RESOLVED_PENDING_VERIFICATION':
      return t('dgv.incident.advance.resolve');
  }
}

/** What an event of the history says it was. */
export function eventLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'CREATED':
      return t('dgv.incident.event.created');
    case 'ASSIGNED':
      return t('dgv.incident.event.assigned');
    case 'STATUS_CHANGED':
      return t('dgv.incident.event.statusChanged');
    case 'COMMENTED':
      return t('dgv.incident.event.commented');
    case 'REOPENED':
      return t('dgv.incident.event.reopened');
    case 'VERIFIED':
      return t('dgv.incident.event.verified');
    case 'SLA_BREACHED':
      return t('dgv.incident.event.slaBreached');
    default:
      return kind;
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('dgv.incident.problem.required');
    case 'tooShort':
      return t('dgv.incident.problem.tooShort');
    case 'invalidId':
      return t('dgv.incident.problem.invalidId');
    case 'invalidDate':
      return t('dgv.incident.problem.invalidDate');
    case 'pastDate':
      return t('dgv.incident.problem.pastDate');
    case 'tooFar':
      return t('dgv.incident.problem.tooFar');
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'rootCause':
      return t('dgv.incident.error.rootCause');
    case 'rerunNotPassed':
      return t('dgv.incident.error.rerunNotPassed');
    case 'selfApproval':
      return t('dgv.incident.error.selfApproval');
    case 'stateInvalid':
      return t('dgv.incident.error.stateInvalid');
    case 'exceptionDecided':
      return t('dgv.incident.error.exceptionDecided');
    case 'notAssignee':
      return t('dgv.incident.error.notAssignee');
    case 'outOfScope':
      return t('dgv.incident.error.outOfScope');
    case 'versionConflict':
      return t('dgv.incident.error.versionConflict');
    case 'validation':
      return t('dgv.incident.error.validation');
    case 'notFound':
      return t('dgv.incident.error.notFound');
    case 'denied':
      return t('dgv.incident.error.denied');
    case 'general':
      return t('dgv.incident.error.general');
  }
}
