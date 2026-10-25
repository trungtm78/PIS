import type { useTranslation } from '../../../i18n';
import type { FormProblem, Outcome, Problem, ResultStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function outcomeLabel(t: Translate, outcome: Outcome): string {
  switch (outcome) {
    case 'AWARDED':
      return t('bid.results.outcome.awarded');
    case 'NO_ACCEPTABLE_BID':
      return t('bid.results.outcome.noBid');
    case 'CANCELLED':
      return t('bid.results.outcome.cancelled');
  }
}

export function statusLabel(t: Translate, status: ResultStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('bid.results.status.draft');
    case 'SUBMITTED':
      return t('bid.results.status.submitted');
    case 'APPROVED':
      return t('bid.results.status.approved');
    case 'REJECTED':
      return t('bid.results.status.rejected');
    case 'CANCELLED':
      return t('bid.results.status.cancelled');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.results.problem.required');
    case 'price':
      return t('bid.results.problem.price');
    case 'uuid':
      return t('bid.results.problem.uuid');
    case 'tooLong':
      return t('bid.results.problem.tooLong');
    case 'notAllowed':
      return t('bid.results.problem.notAllowed');
  }
}

/** What a refusal of a command says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'priceExceeds':
      return t('bid.results.error.priceExceeds');
    case 'planNotApproved':
      return t('bid.results.error.planNotApproved');
    case 'restricted':
      return t('bid.results.error.restricted');
    case 'notVerified':
      return t('bid.results.error.notVerified');
    case 'reportNotIssued':
      return t('bid.results.error.reportNotIssued');
    case 'openResult':
      return t('bid.results.error.openResult');
    case 'resultState':
      return t('bid.results.error.resultState');
    case 'selfApproval':
      return t('bid.results.error.selfApproval');
    case 'delegation':
      return t('bid.results.error.delegation');
    case 'noRule':
      return t('bid.results.error.noRule');
    case 'decisionDocument':
      return t('bid.results.error.decisionDocument');
    case 'versionConflict':
      return t('bid.results.error.versionConflict');
    case 'validation':
      return t('bid.results.error.validation');
    case 'notFound':
      return t('bid.results.error.notFound');
    case 'denied':
      return t('bid.results.error.denied');
    case 'session':
      return t('bid.results.error.session');
    case 'general':
      return t('bid.results.error.general');
  }
}
