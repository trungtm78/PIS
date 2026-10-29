import type { Translator } from '../../../i18n';
import type { AccessMode, GrantStatus, ProblemView } from './model';

type T = Translator['t'];

export function statusLabel(t: T, status: GrantStatus): string {
  switch (status) {
    case 'Requested':
      return t('sas.support.status.requested');
    case 'Approved':
      return t('sas.support.status.approved');
    case 'Active':
      return t('sas.support.status.active');
    case 'Expired':
      return t('sas.support.status.expired');
    case 'Revoked':
      return t('sas.support.status.revoked');
    case 'Rejected':
      return t('sas.support.status.rejected');
  }
}

export function statusTone(status: GrantStatus): 'ok' | 'warn' | 'red' | 'gray' {
  switch (status) {
    case 'Active':
      return 'ok';
    case 'Requested':
    case 'Approved':
      return 'warn';
    case 'Revoked':
    case 'Rejected':
      return 'red';
    case 'Expired':
      return 'gray';
  }
}

export function modeLabel(t: T, mode: AccessMode): string {
  return mode === 'READ_WRITE' ? t('sas.support.mode.readWrite') : t('sas.support.mode.readOnly');
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'selfApproval':
      return t('sas.support.problem.selfApproval');
    case 'grantState':
      return t('sas.support.problem.grantState');
    case 'ticket':
      return t('sas.support.problem.ticket');
    case 'conflict':
      return t('sas.support.problem.conflict');
    case 'invalid':
      return problem.field === undefined ? t('sas.support.problem.invalid') : t('sas.support.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('sas.support.problem.denied');
    case 'notFound':
      return t('sas.support.problem.notFound');
    case 'session':
      return t('sas.support.problem.session');
    case 'general':
      return t('sas.support.problem.general');
  }
}
