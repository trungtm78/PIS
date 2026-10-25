import type { useTranslation } from '../../../i18n';
import type { FormProblem, Outcome, PetitionKind, PetitionStatus, ProblemView } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function kindLabel(t: Translate, kind: PetitionKind): string {
  switch (kind) {
    case 'PROCESS':
      return t('bid.petitions.kind.process');
    case 'RESULT':
      return t('bid.petitions.kind.result');
  }
}

export function statusLabel(t: Translate, status: PetitionStatus): string {
  switch (status) {
    case 'RECEIVED':
      return t('bid.petitions.status.received');
    case 'PROCESSING':
      return t('bid.petitions.status.processing');
    case 'RESOLVED':
      return t('bid.petitions.status.resolved');
    case 'ESCALATED':
      return t('bid.petitions.status.escalated');
    case 'WITHDRAWN':
      return t('bid.petitions.status.withdrawn');
  }
}

export function outcomeLabel(t: Translate, outcome: Outcome): string {
  switch (outcome) {
    case 'RESOLVED':
      return t('bid.petitions.outcome.resolved');
    case 'ESCALATED':
      return t('bid.petitions.outcome.escalated');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.petitions.problem.required');
    case 'date':
      return t('bid.petitions.problem.date');
    case 'future':
      return t('bid.petitions.problem.future');
    case 'uuid':
      return t('bid.petitions.problem.uuid');
  }
}

/** What a refusal of a command says. */
export function problemMessage(t: Translate, view: ProblemView): string {
  switch (view.problem) {
    case 'outOfTimeFuture':
      return t('bid.petitions.error.outOfTimeFuture');
    case 'outOfTimeNoResult':
      return t('bid.petitions.error.outOfTimeNoResult');
    case 'outOfTimeBeforeResult':
      return t('bid.petitions.error.outOfTimeBeforeResult');
    case 'outOfTimeFiling':
      return view.lastDayToFile === undefined ? t('bid.petitions.error.outOfTimeFiling') : t('bid.petitions.error.outOfTimeFilingUntil', { day: view.lastDayToFile });
    case 'documentLodged':
      return t('bid.petitions.error.documentLodged');
    case 'petitionState':
      return t('bid.petitions.error.petitionState');
    case 'conflict':
      return t('bid.petitions.error.conflict');
    case 'ruleUnconfirmed':
      return t('bid.petitions.error.ruleUnconfirmed');
    case 'calendar':
      return t('bid.petitions.error.calendar');
    case 'versionConflict':
      return t('bid.petitions.error.versionConflict');
    case 'validation':
      return t('bid.petitions.error.validation');
    case 'notFound':
      return t('bid.petitions.error.notFound');
    case 'denied':
      return t('bid.petitions.error.denied');
    case 'session':
      return t('bid.petitions.error.session');
    case 'general':
      return t('bid.petitions.error.general');
  }
}
