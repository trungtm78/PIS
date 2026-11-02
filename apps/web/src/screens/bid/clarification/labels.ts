import type { useTranslation } from '../../../i18n';
import type { ClarificationStatus, FormProblem, Problem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: ClarificationStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('bid.clarifications.status.draft');
    case 'SENT':
      return t('bid.clarifications.status.sent');
    case 'ANSWERED':
      return t('bid.clarifications.status.answered');
    case 'EXPIRED':
      return t('bid.clarifications.status.expired');
    case 'WITHDRAWN':
      return t('bid.clarifications.status.withdrawn');
  }
}

/** The tone of the badge of a status: an answer is good news, an expired request is a failure, the rest wait. */
export function statusTone(status: ClarificationStatus): 'ok' | 'warning' | 'danger' {
  if (status === 'ANSWERED') return 'ok';
  return status === 'EXPIRED' ? 'danger' : 'warning';
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.clarifications.problem.required');
    case 'uuid':
      return t('bid.clarifications.problem.uuid');
    case 'tooShort':
      return t('bid.clarifications.problem.tooShort');
    case 'tooLong':
      return t('bid.clarifications.problem.tooLong');
    case 'moment':
      return t('bid.clarifications.problem.moment');
    case 'past':
      return t('bid.clarifications.problem.past');
  }
}

/** What a refusal of a command says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'dueInPast':
      return t('bid.clarifications.error.dueInPast');
    case 'proposalNotOpen':
      return t('bid.clarifications.error.proposalNotOpen');
    case 'undeclared':
      return t('bid.clarifications.error.undeclared');
    case 'expired':
      return t('bid.clarifications.error.expired');
    case 'answered':
      return t('bid.clarifications.error.answered');
    case 'versionConflict':
      return t('bid.clarifications.error.versionConflict');
    case 'documentUsed':
      return t('bid.clarifications.error.documentUsed');
    case 'validation':
      return t('bid.clarifications.error.validation');
    case 'notFound':
      return t('bid.clarifications.error.notFound');
    case 'denied':
      return t('bid.clarifications.error.denied');
    case 'session':
      return t('bid.clarifications.error.session');
    case 'general':
      return t('bid.clarifications.error.general');
  }
}
