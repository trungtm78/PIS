import type { Translator } from '../../../i18n';

type T = Translator['t'];

/** The words of a scope of the open API; a scope the screen does not know is shown by its code. */
export function scopeLabel(t: T, code: string): string {
  switch (code) {
    case 'open.projects.read':
      return t('int.scope.projects');
    case 'open.project-codes.read':
      return t('int.scope.projectCodes');
    case 'open.disbursement.read':
      return t('int.scope.disbursement');
    case 'open.contracts.read':
      return t('int.scope.contracts');
    default:
      return code;
  }
}

export function accountStatusLabel(t: T, status: string): string {
  switch (status) {
    case 'ACTIVE':
      return t('int.accounts.status.active');
    case 'SUSPENDED':
      return t('int.accounts.status.suspended');
    case 'REVOKED':
      return t('int.accounts.status.revoked');
    default:
      return status;
  }
}

export function credentialStateLabel(t: T, state: string): string {
  switch (state) {
    case 'ACTIVE':
      return t('int.accounts.credential.active');
    case 'RETIRING':
      return t('int.accounts.credential.retiring');
    case 'EXPIRED':
      return t('int.accounts.credential.expired');
    case 'REVOKED':
      return t('int.accounts.credential.revoked');
    default:
      return state;
  }
}
