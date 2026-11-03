import type { Translator } from '../../../i18n';
import type { MigrationStatus, PlacementView, ProblemView } from './model';

type T = Translator['t'];

export function statusLabel(t: T, status: MigrationStatus): string {
  switch (status) {
    case 'Planned':
      return t('sas.promotion.status.planned');
    case 'Copying':
      return t('sas.promotion.status.copying');
    case 'Verifying':
      return t('sas.promotion.status.verifying');
    case 'AwaitingCutover':
      return t('sas.promotion.status.awaiting');
    case 'CutoverFrozen':
      return t('sas.promotion.status.frozen');
    case 'Switched':
      return t('sas.promotion.status.switched');
    case 'Completed':
      return t('sas.promotion.status.completed');
    case 'Aborted':
      return t('sas.promotion.status.aborted');
    case 'RolledBack':
      return t('sas.promotion.status.rolledBack');
  }
}

export function statusTone(status: MigrationStatus): 'ok' | 'warn' | 'red' | 'gray' {
  switch (status) {
    case 'Completed':
    case 'Switched':
      return 'ok';
    case 'AwaitingCutover':
    case 'CutoverFrozen':
    case 'Planned':
    case 'Copying':
    case 'Verifying':
      return 'warn';
    case 'RolledBack':
      return 'red';
    case 'Aborted':
      return 'gray';
  }
}

export function placementLabel(t: T, placement: PlacementView): string {
  return t('sas.promotion.start.placement.option', { region: placement.region, id: placement.id.slice(0, 8), used: placement.tenantCount + placement.incomingMigrations, max: placement.maxTenants ?? 1 });
}

/** Why the platform will not use a placement, in words. */
function placementWhy(t: T, why: string | undefined): string {
  switch (why) {
    case 'NO_ROOM':
      return t('sas.promotion.problem.placement.noRoom');
    case 'OTHER_REGION':
      return t('sas.promotion.problem.placement.otherRegion');
    case 'NOT_ACTIVE':
      return t('sas.promotion.problem.placement.notActive');
    case 'NOT_SILO':
      return t('sas.promotion.problem.placement.notSilo');
    case 'SAME_PLACEMENT':
      return t('sas.promotion.problem.placement.same');
    default:
      return t('sas.promotion.problem.placement.other');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'selfApproval':
      return t('sas.promotion.problem.selfApproval');
    case 'mismatch':
      return problem.tables.length === 0 ? t('sas.promotion.problem.mismatch') : t('sas.promotion.problem.mismatchTables', { tables: problem.tables.join(', ') });
    case 'notVerified':
      return t('sas.promotion.problem.notVerified');
    case 'stale':
      return t('sas.promotion.problem.stale');
    case 'stateInvalid':
      return t('sas.promotion.problem.stateInvalid');
    case 'targetChanged':
      return t('sas.promotion.problem.targetChanged');
    case 'alreadyOpen':
      return t('sas.promotion.problem.alreadyOpen');
    case 'tenantState':
      return t('sas.promotion.problem.tenantState');
    case 'placementUnavailable':
      return placementWhy(t, problem.why);
    case 'conflict':
      return t('sas.promotion.problem.conflict');
    case 'invalid':
      return problem.field === undefined ? t('sas.promotion.problem.invalid') : t('sas.promotion.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('sas.promotion.problem.denied');
    case 'notFound':
      return t('sas.promotion.problem.notFound');
    case 'session':
      return t('sas.promotion.problem.session');
    case 'general':
      return t('sas.promotion.problem.general');
  }
}
