import type { useTranslation } from '../../../i18n';
import type { FormProblem, Group, Outcome, Problem, Scope, Status, Urgency } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: Status): string {
  switch (status) {
    case 'DRAFT':
      return t('pay.settlement.status.draft');
    case 'SUBMITTED':
      return t('pay.settlement.status.submitted');
    case 'VERIFYING':
      return t('pay.settlement.status.verifying');
    case 'VERIFIED':
      return t('pay.settlement.status.verified');
    case 'CLOSED':
      return t('pay.settlement.status.closed');
    case 'RETURNED':
      return t('pay.settlement.status.returned');
    case 'SUPERSEDED':
      return t('pay.settlement.status.superseded');
  }
}

export function scopeLabel(t: Translate, scope: Scope): string {
  switch (scope) {
    case 'ANNUAL':
      return t('pay.settlement.scope.annual');
    case 'PROJECT':
      return t('pay.settlement.scope.project');
    case 'CONTRACT':
      return t('pay.settlement.scope.contract');
  }
}

export function groupLabel(t: Translate, group: Group): string {
  switch (group) {
    case 'QTQG':
      return t('pay.settlement.group.qtqg');
    case 'A':
      return t('pay.settlement.group.a');
    case 'B':
      return t('pay.settlement.group.b');
    case 'C':
      return t('pay.settlement.group.c');
  }
}

export function outcomeLabel(t: Translate, outcome: Outcome): string {
  switch (outcome) {
    case 'VERIFYING':
      return t('pay.settlement.outcome.verifying');
    case 'VERIFIED':
      return t('pay.settlement.outcome.verified');
    case 'RETURNED':
      return t('pay.settlement.outcome.returned');
  }
}

export function urgencyLabel(t: Translate, urgency: Urgency, days: number): string {
  switch (urgency) {
    case 'late':
      return t('pay.settlement.deadline.late', { days: Math.abs(days) });
    case 'near':
      return t('pay.settlement.deadline.near', { days });
    case 'later':
      return t('pay.settlement.deadline.later', { days });
  }
}

export function problemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('pay.settlement.problem.required');
    case 'tooLong':
      return t('pay.settlement.problem.tooLong');
    case 'uuid':
      return t('pay.settlement.problem.uuid');
    case 'uuids':
      return t('pay.settlement.problem.uuids');
    case 'day':
      return t('pay.settlement.problem.day');
    case 'future':
      return t('pay.settlement.problem.future');
    case 'year':
      return t('pay.settlement.problem.year');
    case 'tooMany':
      return t('pay.settlement.problem.tooMany');
  }
}

/** What a refusal says. */
export function refusalMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'openExists':
      return t('pay.settlement.error.openExists');
    case 'stageInvalid':
      return t('pay.settlement.error.stageInvalid');
    case 'groupMissing':
      return t('pay.settlement.error.groupMissing');
    case 'ruleUnconfirmed':
      return t('pay.settlement.error.ruleUnconfirmed');
    case 'stateInvalid':
      return t('pay.settlement.error.stateInvalid');
    case 'noOutstanding':
      return t('pay.settlement.error.noOutstanding');
    case 'hasOutstanding':
      return t('pay.settlement.error.hasOutstanding');
    case 'decisionRequired':
      return t('pay.settlement.error.decisionRequired');
    case 'approvalRequired':
      return t('pay.settlement.error.approvalRequired');
    case 'notClean':
      return t('pay.settlement.error.notClean');
    case 'selfApproval':
      return t('pay.settlement.error.selfApproval');
    case 'versionConflict':
      return t('pay.settlement.error.versionConflict');
    case 'validation':
      return t('pay.settlement.error.validation');
    case 'notFound':
      return t('pay.settlement.error.notFound');
    case 'denied':
      return t('pay.settlement.error.denied');
    case 'session':
      return t('pay.settlement.error.session');
    case 'general':
      return t('pay.settlement.error.general');
  }
}
