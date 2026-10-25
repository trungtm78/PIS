import type { useTranslation } from '../../../i18n';
import type { ActionStatus, FormProblem, Lane, NcrStatus, Problem, Severity, SourceKind, Verification } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function severityLabel(t: Translate, severity: Severity): string {
  switch (severity) {
    case 'MINOR':
      return t('qms.ncr.severity.minor');
    case 'MAJOR':
      return t('qms.ncr.severity.major');
    case 'CRITICAL':
      return t('qms.ncr.severity.critical');
  }
}

export function sourceLabel(t: Translate, source: SourceKind): string {
  switch (source) {
    case 'INSPECTION':
      return t('qms.ncr.source.inspection');
    case 'MATERIAL_TEST':
      return t('qms.ncr.source.materialTest');
    case 'SUPERVISOR_REMARK':
      return t('qms.ncr.source.supervisorRemark');
    case 'SELF_REPORT':
      return t('qms.ncr.source.selfReport');
    case 'AUDIT':
      return t('qms.ncr.source.audit');
  }
}

export function statusLabel(t: Translate, status: NcrStatus): string {
  switch (status) {
    case 'OPEN':
      return t('qms.ncr.status.open');
    case 'ACTION_ASSIGNED':
      return t('qms.ncr.status.actionAssigned');
    case 'ACTION_SUBMITTED':
      return t('qms.ncr.status.actionSubmitted');
    case 'VERIFIED':
      return t('qms.ncr.status.verified');
    case 'CLOSED':
      return t('qms.ncr.status.closed');
    case 'REOPENED':
      return t('qms.ncr.status.reopened');
  }
}

export function actionStatusLabel(t: Translate, status: ActionStatus): string {
  switch (status) {
    case 'ASSIGNED':
      return t('qms.ncr.action.status.assigned');
    case 'SUBMITTED':
      return t('qms.ncr.action.status.submitted');
    case 'REJECTED':
      return t('qms.ncr.action.status.rejected');
    case 'VERIFIED':
      return t('qms.ncr.action.status.verified');
  }
}

export function laneLabel(t: Translate, lane: Lane): string {
  switch (lane) {
    case 'OPEN':
      return t('qms.ncr.lane.open');
    case 'ACTION_ASSIGNED':
      return t('qms.ncr.lane.actionAssigned');
    case 'ACTION_SUBMITTED':
      return t('qms.ncr.lane.actionSubmitted');
    case 'VERIFIED':
      return t('qms.ncr.lane.verified');
    case 'CLOSED':
      return t('qms.ncr.lane.closed');
  }
}

export function verificationLabel(t: Translate, outcome: Verification): string {
  switch (outcome) {
    case 'VERIFIED':
      return t('qms.ncr.verification.verified');
    case 'REJECTED':
      return t('qms.ncr.verification.rejected');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('qms.ncr.problem.required');
    case 'date':
      return t('qms.ncr.problem.date');
    case 'uuid':
      return t('qms.ncr.problem.uuid');
    case 'tooLong':
      return t('qms.ncr.problem.tooLong');
    case 'past':
      return t('qms.ncr.problem.past');
    case 'sourceReference':
      return t('qms.ncr.problem.sourceReference');
    case 'evidenceRequired':
      return t('qms.ncr.problem.evidenceRequired');
  }
}

/** What a refusal of a command says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'contractState':
      return t('qms.ncr.error.contractState');
    case 'ncrState':
      return t('qms.ncr.error.ncrState');
    case 'actionState':
      return t('qms.ncr.error.actionState');
    case 'actionsOpen':
      return t('qms.ncr.error.actionsOpen');
    case 'evidenceRequired':
      return t('qms.ncr.error.evidenceRequired');
    case 'notClean':
      return t('qms.ncr.error.notClean');
    case 'selfApproval':
      return t('qms.ncr.error.selfApproval');
    case 'versionConflict':
      return t('qms.ncr.error.versionConflict');
    case 'validation':
      return t('qms.ncr.error.validation');
    case 'notFound':
      return t('qms.ncr.error.notFound');
    case 'denied':
      return t('qms.ncr.error.denied');
    case 'session':
      return t('qms.ncr.error.session');
    case 'general':
      return t('qms.ncr.error.general');
  }
}
