import type { Translator } from '../../i18n';
import type { AuthorityKind, CommandProblem, EngagementStatus, EngagementType, FormProblem, HoldStatus, ScopeKind } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function engagementStatusLabel(t: T, status: EngagementStatus): string {
  switch (status) {
    case 'PLANNED':
      return t('aud.engagementStatus.planned');
    case 'ONGOING':
      return t('aud.engagementStatus.ongoing');
    case 'AWAITING_CONCLUSION':
      return t('aud.engagementStatus.awaitingConclusion');
    case 'FOLLOW_UP':
      return t('aud.engagementStatus.followUp');
    case 'CLOSED':
      return t('aud.engagementStatus.closed');
    case 'CANCELLED':
      return t('aud.engagementStatus.cancelled');
  }
}

export function engagementTypeLabel(t: T, type: EngagementType): string {
  switch (type) {
    case 'ADMINISTRATIVE_INSPECTION':
      return t('aud.engagementType.administrativeInspection');
    case 'SPECIALIZED_INSPECTION':
      return t('aud.engagementType.specializedInspection');
    case 'STATE_AUDIT':
      return t('aud.engagementType.stateAudit');
    case 'INTERNAL_AUDIT':
      return t('aud.engagementType.internalAudit');
    case 'SUPERVISORY_CHECK':
      return t('aud.engagementType.supervisoryCheck');
  }
}

export function authorityKindLabel(t: T, kind: AuthorityKind): string {
  switch (kind) {
    case 'GOVERNMENT_INSPECTORATE':
      return t('aud.authorityKind.governmentInspectorate');
    case 'PROVINCIAL_INSPECTORATE':
      return t('aud.authorityKind.provincialInspectorate');
    case 'MINISTRY_INSPECTORATE':
      return t('aud.authorityKind.ministryInspectorate');
    case 'STATE_AUDIT_OFFICE':
      return t('aud.authorityKind.stateAuditOffice');
    case 'INTERNAL':
      return t('aud.authorityKind.internal');
  }
}

export function scopeKindLabel(t: T, kind: ScopeKind): string {
  switch (kind) {
    case 'UNIT':
      return t('aud.scopeKind.unit');
    case 'PROJECT':
      return t('aud.scopeKind.project');
    case 'CONTRACT':
      return t('aud.scopeKind.contract');
  }
}

/** The state of the legal hold of an engagement in words; an engagement that has none says so. */
export function holdStatusLabel(t: T, status: HoldStatus | null): string {
  if (status === null) return t('aud.holdStatus.none');
  return status === 'Active' ? t('aud.holdStatus.active') : t('aud.holdStatus.released');
}

export function formProblemMessage(t: T, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('aud.formProblem.required');
    case 'tooShort':
      return t('aud.formProblem.tooShort');
    case 'tooLong':
      return t('aud.formProblem.tooLong');
    case 'invalid':
      return t('aud.formProblem.invalid');
    case 'future':
      return t('aud.formProblem.future');
    case 'early':
      return t('aud.formProblem.early');
    case 'order':
      return t('aud.formProblem.order');
  }
}

export function commandProblemMessage(t: T, problem: CommandProblem): string {
  switch (problem) {
    case 'codeDuplicate':
      return t('aud.problem.codeDuplicate');
    case 'decisionNotEffective':
      return t('aud.problem.decisionNotEffective');
    case 'stateInvalid':
      return t('aud.problem.stateInvalid');
    case 'conclusionExists':
      return t('aud.problem.conclusionExists');
    case 'versionConflict':
      return t('aud.problem.versionConflict');
    case 'scopeDenied':
      return t('aud.problem.scopeDenied');
    case 'validation':
      return t('aud.problem.validation');
    case 'notFound':
      return t('aud.problem.notFound');
    case 'general':
      return t('aud.problem.general');
  }
}
