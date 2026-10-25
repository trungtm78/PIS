import type { useTranslation } from '../../../i18n';
import type { AcceptanceStatus, Decision, FormProblem, ProblemView } from './model';
import { signedAmountText } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: AcceptanceStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('ctr.acceptance.status.draft');
    case 'SUBMITTED':
      return t('ctr.acceptance.status.submitted');
    case 'APPROVED':
      return t('ctr.acceptance.status.approved');
    case 'REJECTED':
      return t('ctr.acceptance.status.rejected');
    case 'REVOKED':
      return t('ctr.acceptance.status.revoked');
  }
}

export function decisionLabel(t: Translate, decision: Decision): string {
  switch (decision) {
    case 'approve':
      return t('ctr.acceptance.decision.approve');
    case 'return':
      return t('ctr.acceptance.decision.return');
    case 'reject':
      return t('ctr.acceptance.decision.reject');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ctr.acceptance.problem.required');
    case 'tooLong':
      return t('ctr.acceptance.problem.tooLong');
    case 'uuid':
      return t('ctr.acceptance.problem.uuid');
    case 'tooMany':
      return t('ctr.acceptance.problem.tooMany');
  }
}

/** What a refusal of a command says; the one for a value above the contract says how much the contract can still accept. */
export function problemMessage(t: Translate, view: ProblemView, locale: string): string {
  switch (view.problem) {
    case 'measurementNotApproved':
      return t('ctr.acceptance.error.measurementNotApproved');
    case 'measurementAccepted':
      return t('ctr.acceptance.error.measurementAccepted');
    case 'qualityRequired':
      return t('ctr.acceptance.error.qualityRequired');
    case 'openNcr':
      return t('ctr.acceptance.error.openNcr');
    case 'exceedsContract':
      return view.remainingVnd === undefined ? t('ctr.acceptance.error.exceedsContract') : t('ctr.acceptance.error.exceedsContractLeft', { remaining: signedAmountText(view.remainingVnd, locale) ?? view.remainingVnd });
    case 'revisionNotEffective':
      return t('ctr.acceptance.error.revisionNotEffective');
    case 'claimed':
      return t('ctr.acceptance.error.claimed');
    case 'selfApproval':
      return t('ctr.acceptance.error.selfApproval');
    case 'contractState':
      return t('ctr.acceptance.error.contractState');
    case 'acceptanceState':
      return t('ctr.acceptance.error.acceptanceState');
    case 'versionConflict':
      return t('ctr.acceptance.error.versionConflict');
    case 'validation':
      return t('ctr.acceptance.error.validation');
    case 'notFound':
      return t('ctr.acceptance.error.notFound');
    case 'denied':
      return t('ctr.acceptance.error.denied');
    case 'session':
      return t('ctr.acceptance.error.session');
    case 'general':
      return t('ctr.acceptance.error.general');
  }
}
