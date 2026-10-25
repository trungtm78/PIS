import type { useTranslation } from '../../../i18n';
import { amountText } from '../../ctr/model';
import type { AssetStatus, FormProblem, Problem, ProblemView, ValueBasis } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: AssetStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('ast.asset.status.draft');
    case 'REGISTERED':
      return t('ast.asset.status.registered');
    case 'TRANSFERRED':
      return t('ast.asset.status.transferred');
    case 'IN_OPERATION':
      return t('ast.asset.status.inOperation');
    case 'DISPOSED':
      return t('ast.asset.status.disposed');
  }
}

export function basisLabel(t: Translate, basis: ValueBasis): string {
  switch (basis) {
    case 'CONTRACT_VALUE':
      return t('ast.asset.basis.contractValue');
    case 'SETTLED_VALUE':
      return t('ast.asset.basis.settledValue');
    case 'APPRAISED_VALUE':
      return t('ast.asset.basis.appraisedValue');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ast.asset.problem.required');
    case 'date':
      return t('ast.asset.problem.date');
    case 'uuid':
      return t('ast.asset.problem.uuid');
    case 'tooLong':
      return t('ast.asset.problem.tooLong');
    case 'amount':
      return t('ast.asset.problem.amount');
    case 'future':
      return t('ast.asset.problem.future');
  }
}

function baseMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'handoverState':
      return t('ast.asset.error.handoverState');
    case 'valueExceeds':
      return t('ast.asset.error.valueExceeds');
    case 'duplicate':
      return t('ast.asset.error.duplicate');
    case 'assetState':
      return t('ast.asset.error.assetState');
    case 'handoverNotAccepted':
      return t('ast.asset.error.handoverNotAccepted');
    case 'notClean':
      return t('ast.asset.error.notClean');
    case 'versionConflict':
      return t('ast.asset.error.versionConflict');
    case 'validation':
      return t('ast.asset.error.validation');
    case 'notFound':
      return t('ast.asset.error.notFound');
    case 'denied':
      return t('ast.asset.error.denied');
    case 'session':
      return t('ast.asset.error.session');
    case 'general':
      return t('ast.asset.error.general');
  }
}

/** What a refusal of a command says; what the assets would come to and what the contract is worth follow the refusal of a value above the contract. */
export function problemMessage(t: Translate, view: ProblemView, locale: string): string {
  const base = baseMessage(t, view.problem);
  return view.detail === undefined ? base : `${base} ${t('ast.asset.error.amounts', { total: amountText(view.detail.total, locale), contract: amountText(view.detail.contract, locale) })}`;
}
