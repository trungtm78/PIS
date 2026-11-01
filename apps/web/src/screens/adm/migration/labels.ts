import type { useTranslation } from '../../../i18n';
import type { BatchStatus, MigrationProblem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: BatchStatus): string {
  switch (status) {
    case 'Uploaded':
      return t('adm.migration.status.uploaded');
    case 'Validating':
      return t('adm.migration.status.validating');
    case 'Validated':
      return t('adm.migration.status.validated');
    case 'DryRunPassed':
      return t('adm.migration.status.passed');
    case 'DryRunFailed':
      return t('adm.migration.status.dryfailed');
    case 'PendingApproval':
      return t('adm.migration.status.pending');
    case 'Applying':
      return t('adm.migration.status.applying');
    case 'Applied':
      return t('adm.migration.status.applied');
    case 'Failed':
      return t('adm.migration.status.failed');
    case 'RolledBack':
      return t('adm.migration.status.rolledback');
  }
}

export function problemMessage(t: Translate, problem: MigrationProblem): string {
  switch (problem.reason) {
    case 'file':
      return t('adm.migration.problem.file');
    case 'duplicate':
      return t('adm.migration.problem.duplicate');
    case 'state':
      return t('adm.migration.problem.state');
    case 'applied':
      return t('adm.migration.problem.applied');
    case 'dependents':
      return t('adm.migration.problem.dependents');
    case 'self':
      return t('adm.migration.problem.self');
    case 'scope':
      return t('adm.migration.problem.scope');
    case 'stale':
      return t('adm.migration.problem.stale');
    case 'notFound':
      return t('adm.migration.problem.notfound');
    case 'validation':
      return t('adm.migration.problem.validation', { field: problem.detail });
    case 'general':
      return t('adm.migration.problem.general');
  }
}
