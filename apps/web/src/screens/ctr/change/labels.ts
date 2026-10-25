import type { useTranslation } from '../../../i18n';
import type { ChangeStatus, EventKind, FormProblem, Problem, ProblemView, Stage } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function stageLabel(t: Translate, stage: Stage): string {
  switch (stage) {
    case 'EVENT':
      return t('ctr.change.stage.event');
    case 'PCO':
      return t('ctr.change.stage.pco');
    case 'CO':
      return t('ctr.change.stage.co');
  }
}

export function statusLabel(t: Translate, status: ChangeStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('ctr.change.status.draft');
    case 'SUBMITTED':
      return t('ctr.change.status.submitted');
    case 'EVALUATED':
      return t('ctr.change.status.evaluated');
    case 'APPROVED':
      return t('ctr.change.status.approved');
    case 'REJECTED':
      return t('ctr.change.status.rejected');
    case 'WITHDRAWN':
      return t('ctr.change.status.withdrawn');
    case 'PROMOTED':
      return t('ctr.change.status.promoted');
  }
}

export function eventKindLabel(t: Translate, kind: EventKind): string {
  switch (kind) {
    case 'OWNER_INSTRUCTION':
      return t('ctr.change.kind.ownerInstruction');
    case 'DESIGN_CHANGE':
      return t('ctr.change.kind.designChange');
    case 'SITE_CONDITION':
      return t('ctr.change.kind.siteCondition');
    case 'FORCE_MAJEURE':
      return t('ctr.change.kind.forceMajeure');
    case 'LEGAL_CHANGE':
      return t('ctr.change.kind.legalChange');
    case 'QUANTITY_VARIANCE':
      return t('ctr.change.kind.quantityVariance');
    case 'OTHER':
      return t('ctr.change.kind.other');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ctr.change.problem.required');
    case 'tooLong':
      return t('ctr.change.problem.tooLong');
    case 'amount':
      return t('ctr.change.problem.amount');
    case 'days':
      return t('ctr.change.problem.days');
    case 'uuid':
      return t('ctr.change.problem.uuid');
  }
}

function baseMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'selfApproval':
      return t('ctr.change.error.selfApproval');
    case 'retroactive':
      return t('ctr.change.error.retroactive');
    case 'floor':
      return t('ctr.change.error.floor');
    case 'decisionDocument':
      return t('ctr.change.error.decisionDocument');
    case 'boqMismatch':
      return t('ctr.change.error.boqMismatch');
    case 'delegation':
      return t('ctr.change.error.delegation');
    case 'onlyCo':
      return t('ctr.change.error.onlyCo');
    case 'tiersLocked':
      return t('ctr.change.error.tiersLocked');
    case 'notConfigured':
      return t('ctr.change.error.notConfigured');
    case 'wrongStage':
      return t('ctr.change.error.wrongStage');
    case 'lastTier':
      return t('ctr.change.error.lastTier');
    case 'notEvaluated':
      return t('ctr.change.error.notEvaluated');
    case 'stateInvalid':
      return t('ctr.change.error.stateInvalid');
    case 'contractState':
      return t('ctr.change.error.contractState');
    case 'lineRequired':
      return t('ctr.change.error.lineRequired');
    case 'allocation':
      return t('ctr.change.error.allocation');
    case 'versionConflict':
      return t('ctr.change.error.versionConflict');
    case 'validation':
      return t('ctr.change.error.validation');
    case 'notFound':
      return t('ctr.change.error.notFound');
    case 'denied':
      return t('ctr.change.error.denied');
    case 'session':
      return t('ctr.change.error.session');
    case 'general':
      return t('ctr.change.error.general');
  }
}

/** The refusal of the server in words; where it said the tier the chain starts at, the sentence names it. */
export function problemMessage(t: Translate, view: ProblemView): string {
  const message = baseMessage(t, view.problem);
  return view.problem === 'wrongStage' && view.stage !== undefined ? `${message} ${t('ctr.change.error.startsAt', { stage: stageLabel(t, view.stage) })}` : message;
}
