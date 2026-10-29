import type { useTranslation } from '../../../i18n';
import type { FormProblem, Problem, Status, WizardStep, stepKind } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function kindLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'MERGE':
      return t('adm.reorg.kind.merge');
    case 'SPLIT':
      return t('adm.reorg.kind.split');
    case 'DISSOLVE':
      return t('adm.reorg.kind.dissolve');
    case 'RENAME':
      return t('adm.reorg.kind.rename');
    default:
      return kind;
  }
}

export function wizardStepLabel(t: Translate, step: WizardStep): string {
  switch (step) {
    case 'choose':
      return t('adm.reorg.wizard.step.choose');
    case 'map':
      return t('adm.reorg.wizard.step.map');
    case 'preview':
      return t('adm.reorg.wizard.step.preview');
    case 'submit':
      return t('adm.reorg.wizard.step.submit');
  }
}

export function decisionLabel(t: Translate, decision: 'approve' | 'return' | 'reject'): string {
  switch (decision) {
    case 'approve':
      return t('adm.reorg.decide.approve');
    case 'return':
      return t('adm.reorg.decide.return');
    case 'reject':
      return t('adm.reorg.decide.reject');
  }
}

export function statusLabel(t: Translate, status: Status): string {
  switch (status) {
    case 'Draft':
      return t('adm.reorg.status.draft');
    case 'PendingApproval':
      return t('adm.reorg.status.pending');
    case 'Approved':
      return t('adm.reorg.status.approved');
    case 'Applying':
      return t('adm.reorg.status.applying');
    case 'Applied':
      return t('adm.reorg.status.applied');
    case 'Failed':
      return t('adm.reorg.status.failed');
    case 'Cancelled':
      return t('adm.reorg.status.cancelled');
  }
}

export function statusTone(status: Status): 'green' | 'red' | 'warn' | 'gray' {
  return status === 'Applied' ? 'green' : status === 'Failed' ? 'red' : status === 'Applying' || status === 'PendingApproval' || status === 'Approved' ? 'warn' : 'gray';
}

export function stepLabel(t: Translate, kind: ReturnType<typeof stepKind>, count: number): string {
  switch (kind) {
    case 'create-successor':
      return t('adm.reorg.timeline.create', { count });
    case 'activate-successor':
      return t('adm.reorg.timeline.activate', { count });
    case 'succession':
      return t('adm.reorg.timeline.succession', { count });
    case 'membership':
      return t('adm.reorg.timeline.membership', { count });
    case 'grant':
      return t('adm.reorg.timeline.grant', { count });
    case 'project':
      return t('adm.reorg.timeline.project', { count });
    case 'retire':
      return t('adm.reorg.timeline.retire', { count });
    case 'other':
      return t('adm.reorg.timeline.other', { count });
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'predecessorsRequired':
      return t('adm.reorg.problem.predecessors');
    case 'mergeNeedsTwo':
      return t('adm.reorg.problem.mergeTwo');
    case 'onePredecessor':
      return t('adm.reorg.problem.onePredecessor');
    case 'successorRequired':
      return t('adm.reorg.problem.successor');
    case 'oneSuccessor':
      return t('adm.reorg.problem.oneSuccessor');
    case 'splitNeedsTwo':
      return t('adm.reorg.problem.splitTwo');
    case 'successorIsPredecessor':
      return t('adm.reorg.problem.successorIsOld');
    case 'newUnitIncomplete':
      return t('adm.reorg.problem.newUnit');
    case 'dateInvalid':
      return t('adm.reorg.problem.date');
    case 'basisShort':
      return t('adm.reorg.problem.basis');
    case 'defaultRequired':
      return t('adm.reorg.problem.default');
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'mappingIncomplete':
      return t('adm.reorg.error.mapping');
    case 'invalid':
      return t('adm.reorg.error.invalid');
    case 'unitInvalid':
      return t('adm.reorg.error.unit');
    case 'busy':
      return t('adm.reorg.error.busy');
    case 'selfApproval':
      return t('adm.reorg.error.self');
    case 'stateInvalid':
      return t('adm.reorg.error.state');
    case 'versionConflict':
      return t('adm.reorg.error.version');
    case 'notFound':
      return t('adm.reorg.error.notFound');
    case 'denied':
      return t('adm.reorg.error.denied');
    case 'general':
      return t('adm.reorg.error.general');
  }
}
