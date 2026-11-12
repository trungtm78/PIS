import type { Translator } from '../../../i18n';

type T = Translator['t'];

export function datasetLabel(t: T, code: string): string {
  switch (code) {
    case 'DS-DISB':
      return t('int.bi.dataset.name.disbursement');
    case 'DS-CTR':
      return t('int.bi.dataset.name.contracts');
    case 'DS-ENT':
      return t('int.bi.dataset.name.enterprise');
    default:
      return code;
  }
}

/** Why a dataset is closed, in words. */
export function gateReasonLabel(t: T, reason: string | null): string {
  switch (reason) {
    case 'DISABLED':
      return t('int.bi.gate.disabled');
    case 'NOT_CERTIFIED':
      return t('int.bi.gate.notCertified');
    case 'EXPIRED':
      return t('int.bi.gate.expired');
    default:
      return t('int.bi.gate.unknown');
  }
}

export function readerStatusLabel(t: T, status: string): string {
  switch (status) {
    case 'ACTIVE':
      return t('int.bi.status.active');
    case 'SUSPENDED':
      return t('int.bi.status.suspended');
    case 'RETIRED':
      return t('int.bi.status.retired');
    default:
      return status;
  }
}

export function eventLabel(t: T, action: string): string {
  switch (action) {
    case 'PROVISIONED':
      return t('int.bi.event.provisioned');
    case 'PASSWORD_ROTATED':
      return t('int.bi.event.rotated');
    case 'SUSPENDED':
      return t('int.bi.event.suspended');
    case 'REACTIVATED':
      return t('int.bi.event.reactivated');
    case 'RETIRED':
      return t('int.bi.event.retired');
    default:
      return action;
  }
}
