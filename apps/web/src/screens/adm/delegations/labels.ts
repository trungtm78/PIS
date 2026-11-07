import type { useTranslation } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { FormProblem, Problem, Status } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: Status): string {
  switch (status) {
    case 'Scheduled':
      return t('adm.delegation.status.scheduled');
    case 'Active':
      return t('adm.delegation.status.active');
    case 'Ended':
      return t('adm.delegation.status.ended');
    case 'Revoked':
      return t('adm.delegation.status.revoked');
  }
}

export function statusTone(status: Status): 'green' | 'gray' | 'warn' {
  return status === 'Active' ? 'green' : status === 'Scheduled' ? 'warn' : 'gray';
}

export function endReasonLabel(t: Translate, reason: string | null): string {
  switch (reason) {
    case 'EXPIRED':
      return t('adm.delegation.end.expired');
    case 'SOURCE_ENDED':
      return t('adm.delegation.end.source');
    default:
      return '';
  }
}

export function scopeKindLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'UNIT_SUBTREE':
      return t('adm.delegation.scope.subtree');
    case 'UNIT_ONLY':
      return t('adm.delegation.scope.only');
    case 'PROJECT':
      return t('adm.delegation.scope.project');
    default:
      return kind;
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'delegateRequired':
      return t('adm.delegation.problem.delegate');
    case 'permissionsRequired':
      return t('adm.delegation.problem.permissions');
    case 'unitRequired':
      return t('adm.delegation.problem.unit');
    case 'datesInvalid':
      return t('adm.delegation.problem.dates');
    case 'tooLong':
      return t('adm.delegation.problem.tooLong');
    case 'inThePast':
      return t('adm.delegation.problem.past');
    case 'reasonShort':
      return t('adm.delegation.problem.reason');
  }
}

/** The words for a defect code of the server; a code this screen does not know is said as the code itself. */
export function defectLabel(t: Translate, code: string): string {
  switch (code) {
    case 'TOO_LONG':
      return t('adm.delegation.defect.tooLong');
    case 'BEFORE_START':
      return t('adm.delegation.defect.beforeStart');
    case 'IN_THE_PAST':
      return t('adm.delegation.defect.past');
    case 'ALREADY_ENDED':
      return t('adm.delegation.defect.ended');
    case 'ADMINISTRATIVE':
      return t('adm.delegation.defect.administrative');
    case 'WILDCARD':
      return t('adm.delegation.defect.wildcard');
    case 'DUPLICATE':
      return t('adm.delegation.defect.duplicate');
    case 'REQUIRED':
      return t('adm.delegation.defect.required');
    case 'MALFORMED':
      return t('adm.delegation.defect.malformed');
    case 'UNSUPPORTED':
      return t('adm.delegation.defect.unsupported');
    default:
      return code;
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'chain':
      return t('adm.delegation.error.chain');
    case 'escalation':
      return t('adm.delegation.error.escalation');
    case 'self':
      return t('adm.delegation.error.self');
    case 'invalid':
      return t('adm.delegation.error.invalid');
    case 'inactive':
      return t('adm.delegation.error.inactive');
    case 'notFound':
      return t('adm.delegation.error.notFound');
    case 'versionConflict':
      return t('adm.delegation.error.versionConflict');
    case 'notRevocable':
      return t('adm.delegation.error.notRevocable');
    case 'denied':
      return t('adm.delegation.error.denied');
    case 'general':
      return t('adm.delegation.error.general');
  }
}

/** The tone of the status pill of the kit: in force is green, scheduled amber, closed grey. */
export function statusKitTone(status: Status): Tone {
  return status === 'Active' ? 'success' : status === 'Scheduled' ? 'warning' : 'neutral';
}
