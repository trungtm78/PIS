import type { Translator } from '../../../i18n';
import type { DomainKind, DomainStatus, ProblemView, TlsStatus } from './model';

type T = Translator['t'];

export function statusLabel(t: T, status: DomainStatus): string {
  switch (status) {
    case 'PendingVerification':
      return t('sas.domain.status.pending');
    case 'Verified':
      return t('sas.domain.status.verified');
    case 'Active':
      return t('sas.domain.status.active');
    case 'Failed':
      return t('sas.domain.status.failed');
    case 'Revoked':
      return t('sas.domain.status.revoked');
  }
}

export function statusTone(status: DomainStatus): 'ok' | 'warn' | 'red' | 'gray' {
  switch (status) {
    case 'Active':
    case 'Verified':
      return 'ok';
    case 'PendingVerification':
      return 'warn';
    case 'Failed':
      return 'red';
    case 'Revoked':
      return 'gray';
  }
}

export function tlsLabel(t: T, status: TlsStatus): string {
  switch (status) {
    case 'Pending':
      return t('sas.domain.tls.pending');
    case 'Issued':
      return t('sas.domain.tls.issued');
    case 'Renewing':
      return t('sas.domain.tls.renewing');
    case 'Failed':
      return t('sas.domain.tls.failed');
  }
}

export function kindLabel(t: T, kind: DomainKind): string {
  return kind === 'CUSTOM' ? t('sas.domain.kind.custom') : t('sas.domain.kind.platform');
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'taken':
      return t('sas.domain.problem.taken');
    case 'reserved':
      return t('sas.domain.problem.reserved');
    case 'unverified':
      return t('sas.domain.problem.unverified');
    case 'conflict':
      return t('sas.domain.problem.conflict');
    case 'invalid':
      return problem.field === undefined ? t('sas.domain.problem.invalid') : t('sas.domain.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('sas.domain.problem.denied');
    case 'notFound':
      return t('sas.domain.problem.notFound');
    case 'session':
      return t('sas.domain.problem.session');
    case 'general':
      return t('sas.domain.problem.general');
  }
}
