import type { useTranslation } from '../../../i18n';
import { formProblemMessage } from '../change/labels';
import type { Decision, DecisionProblem, LineChange, Standing } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function decisionLabel(t: Translate, decision: Decision): string {
  switch (decision) {
    case 'approve':
      return t('ctr.revision.decision.approve');
    case 'return':
      return t('ctr.revision.decision.return');
    case 'reject':
      return t('ctr.revision.decision.reject');
  }
}

export function decisionSubmitLabel(t: Translate, decision: Decision): string {
  switch (decision) {
    case 'approve':
      return t('ctr.revision.submit.approve');
    case 'return':
      return t('ctr.revision.submit.return');
    case 'reject':
      return t('ctr.revision.submit.reject');
  }
}

export function standingLabel(t: Translate, standing: Standing): string {
  switch (standing) {
    case 'IN_FORCE':
      return t('ctr.revision.standing.inForce');
    case 'WAITING':
      return t('ctr.revision.standing.waiting');
    case 'OVER':
      return t('ctr.revision.standing.over');
    case 'DRAFT':
      return t('ctr.revision.standing.draft');
    case 'REJECTED':
      return t('ctr.revision.standing.rejected');
  }
}

export function kindLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'BASE':
      return t('ctr.revision.kind.base');
    case 'AMENDMENT':
      return t('ctr.revision.kind.amendment');
    case 'CHANGE_ORDER':
      return t('ctr.revision.kind.changeOrder');
    default:
      return kind;
  }
}

export function lineChangeLabel(t: Translate, change: LineChange): string {
  switch (change) {
    case 'ADDED':
      return t('ctr.revision.line.added');
    case 'REMOVED':
      return t('ctr.revision.line.removed');
    case 'CHANGED':
      return t('ctr.revision.line.changed');
    case 'SAME':
      return t('ctr.revision.line.same');
  }
}

export function decisionProblemMessage(t: Translate, problem: DecisionProblem): string {
  switch (problem) {
    case 'choose':
      return t('ctr.revision.problem.choose');
    case 'date':
      return t('ctr.revision.problem.date');
    case 'past':
      return t('ctr.revision.problem.past');
    case 'evidence':
      return t('ctr.revision.problem.evidence');
    case 'json':
      return t('ctr.revision.problem.json');
    default:
      return formProblemMessage(t, problem);
  }
}
