import type { Translator } from '../../../i18n';
import { toMismatch } from './model';
import type { ProblemView, RestoreStatus, RestoreTarget, TenantStatus } from './model';

type T = Translator['t'];

export function statusLabel(t: T, status: RestoreStatus): string {
  switch (status) {
    case 'Requested':
      return t('sas.restore.status.requested');
    case 'Approved':
      return t('sas.restore.status.approved');
    case 'Restoring':
      return t('sas.restore.status.restoring');
    case 'Verifying':
      return t('sas.restore.status.verifying');
    case 'Completed':
      return t('sas.restore.status.completed');
    case 'Failed':
      return t('sas.restore.status.failed');
    case 'Rejected':
      return t('sas.restore.status.rejected');
  }
}

export function statusTone(status: RestoreStatus): 'ok' | 'warn' | 'red' | 'gray' {
  switch (status) {
    case 'Completed':
      return 'ok';
    case 'Requested':
    case 'Approved':
    case 'Restoring':
    case 'Verifying':
      return 'warn';
    case 'Failed':
      return 'red';
    case 'Rejected':
      return 'gray';
  }
}

export function targetLabel(t: T, target: RestoreTarget): string {
  return target === 'SANDBOX' ? t('sas.restore.target.sandbox') : t('sas.restore.target.inPlace');
}

export function tenantStatusLabel(t: T, status: TenantStatus): string {
  switch (status) {
    case 'Requested':
      return t('sas.restore.tenant.requested');
    case 'Provisioning':
      return t('sas.restore.tenant.provisioning');
    case 'Active':
      return t('sas.restore.tenant.active');
    case 'Failed':
      return t('sas.restore.tenant.failed');
    case 'Suspended':
      return t('sas.restore.tenant.suspended');
    case 'Offboarding':
      return t('sas.restore.tenant.offboarding');
    case 'Archived':
      return t('sas.restore.tenant.archived');
  }
}

/** What one difference of the report says, in words. */
export function mismatchLabel(t: T, code: string): string {
  const mismatch = toMismatch(code);
  switch (mismatch.kind) {
    case 'rows':
      return t('sas.restore.mismatch.rows', { subject: mismatch.subject });
    case 'checksum':
      return t('sas.restore.mismatch.checksum', { subject: mismatch.subject });
    case 'money':
      return t('sas.restore.mismatch.money', { subject: mismatch.subject });
    case 'missing_table':
      return t('sas.restore.mismatch.missingTable', { subject: mismatch.subject });
    case 'unexpected_table':
      return t('sas.restore.mismatch.unexpectedTable', { subject: mismatch.subject });
    case 'foreign_rows':
      return t('sas.restore.mismatch.foreignRows');
    case 'other':
      return mismatch.subject;
  }
}

/** What a failed restore says of its failure: the class the server kept, in words where the screen knows it. */
export function failureLabel(t: T, code: string): string {
  switch (code) {
    case 'VERIFICATION_MISMATCH':
      return t('sas.restore.failure.mismatch');
    case 'TENANT_STATE_INVALID':
      return t('sas.restore.failure.state');
    case 'Stalled':
      return t('sas.restore.failure.stalled');
    case 'RestoreEngineUnbound':
      return t('sas.restore.failure.unbound');
    default:
      return t('sas.restore.failure.other', { code });
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'selfApproval':
      return t('sas.restore.problem.selfApproval');
    case 'conflict':
      return t('sas.restore.problem.conflict');
    case 'state':
      return t('sas.restore.problem.state');
    case 'notWaiting':
      return t('sas.restore.problem.notWaiting');
    case 'unavailable':
      return t('sas.restore.problem.unavailable');
    case 'inProgress':
      return t('sas.restore.problem.inProgress');
    case 'invalid':
      return problem.field === undefined ? t('sas.restore.problem.invalid') : t('sas.restore.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('sas.restore.problem.denied');
    case 'notFound':
      return t('sas.restore.problem.notFound');
    case 'session':
      return t('sas.restore.problem.session');
    case 'general':
      return t('sas.restore.problem.general');
  }
}
