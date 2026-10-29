import type { Translator } from '../../../i18n';
import type { ExportScope, ExportStatus, ProblemView, TenantStatus } from './model';

type T = Translator['t'];

export function statusLabel(t: T, status: ExportStatus): string {
  switch (status) {
    case 'Requested':
      return t('sas.exit.status.requested');
    case 'Running':
      return t('sas.exit.status.running');
    case 'Ready':
      return t('sas.exit.status.ready');
    case 'Delivered':
      return t('sas.exit.status.delivered');
    case 'Failed':
      return t('sas.exit.status.failed');
    case 'Expired':
      return t('sas.exit.status.expired');
  }
}

export function statusTone(status: ExportStatus): 'ok' | 'warn' | 'red' | 'gray' {
  switch (status) {
    case 'Delivered':
    case 'Ready':
      return 'ok';
    case 'Requested':
    case 'Running':
      return 'warn';
    case 'Failed':
      return 'red';
    case 'Expired':
      return 'gray';
  }
}

export function scopeLabel(t: T, scope: ExportScope): string {
  return scope === 'FULL' ? t('sas.exit.scope.full') : t('sas.exit.scope.business');
}

export function tenantStatusLabel(t: T, status: TenantStatus): string {
  switch (status) {
    case 'Requested':
      return t('sas.exit.tenant.requested');
    case 'Provisioning':
      return t('sas.exit.tenant.provisioning');
    case 'Active':
      return t('sas.exit.tenant.active');
    case 'Failed':
      return t('sas.exit.tenant.failed');
    case 'Suspended':
      return t('sas.exit.tenant.suspended');
    case 'Offboarding':
      return t('sas.exit.tenant.offboarding');
    case 'Archived':
      return t('sas.exit.tenant.archived');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'running':
      return t('sas.exit.problem.running');
    case 'conflict':
      return t('sas.exit.problem.conflict');
    case 'notConfirmed':
      return t('sas.exit.problem.notConfirmed');
    case 'state':
      return t('sas.exit.problem.state');
    case 'expired':
      return t('sas.exit.problem.expired');
    case 'key':
      return t('sas.exit.problem.key');
    case 'invalid':
      return problem.field === undefined ? t('sas.exit.problem.invalid') : t('sas.exit.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('sas.exit.problem.denied');
    case 'notFound':
      return t('sas.exit.problem.notFound');
    case 'session':
      return t('sas.exit.problem.session');
    case 'general':
      return t('sas.exit.problem.general');
  }
}
