import type { useTranslation } from '../../../i18n';
import type { AdvanceKind, AdvanceStatus, Problem, RecoveryBasis } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: AdvanceStatus): string {
  switch (status) {
    case 'PLANNED':
      return t('pay.advance.status.planned');
    case 'REQUESTED':
      return t('pay.advance.status.requested');
    case 'PAID':
      return t('pay.advance.status.paid');
    case 'RECOVERING':
      return t('pay.advance.status.recovering');
    case 'FULLY_RECOVERED':
      return t('pay.advance.status.fullyRecovered');
    case 'CANCELLED':
      return t('pay.advance.status.cancelled');
  }
}

export function kindLabel(t: Translate, kind: AdvanceKind): string {
  return kind === 'CONTRACT' ? t('pay.advance.kind.contract') : t('pay.advance.kind.gpmb');
}

export function basisLabel(t: Translate, basis: RecoveryBasis): string {
  switch (basis) {
    case 'COMPENSATION_PAYMENT':
      return t('pay.advance.basis.compensation');
    case 'REFUND':
      return t('pay.advance.basis.refund');
    case 'OTHER':
      return t('pay.advance.basis.other');
  }
}

/** What a refusal of a command says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'recoveryExceeded':
      return t('pay.advance.error.recoveryExceeded');
    case 'stateInvalid':
      return t('pay.advance.error.stateInvalid');
    case 'documentNotClean':
      return t('pay.advance.error.documentNotClean');
    case 'versionConflict':
      return t('pay.advance.error.versionConflict');
    case 'validation':
      return t('pay.advance.error.validation');
    case 'notFound':
      return t('pay.advance.error.notFound');
    case 'denied':
      return t('pay.advance.error.denied');
    case 'session':
      return t('pay.advance.error.session');
    case 'general':
      return t('pay.advance.error.general');
  }
}
