import type { Translator } from '../../../i18n';
import { formProblemMessage } from '../labels';
import { formatVnd } from './model';
import type { ConclusionFormProblem, ConclusionKind, ConclusionProblem, ConclusionStatus, FindingCategory, FindingSeverity, RecommendationStatus, RecommendationType } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function conclusionKindLabel(t: T, kind: ConclusionKind): string {
  switch (kind) {
    case 'INSPECTION_CONCLUSION':
      return t('aud.conclusionKind.inspectionConclusion');
    case 'AUDIT_REPORT':
      return t('aud.conclusionKind.auditReport');
    case 'AUDIT_NOTICE':
      return t('aud.conclusionKind.auditNotice');
    case 'INTERNAL_REPORT':
      return t('aud.conclusionKind.internalReport');
  }
}

export function conclusionStatusLabel(t: T, status: ConclusionStatus): string {
  switch (status) {
    case 'RECEIVED':
      return t('aud.conclusionStatus.received');
    case 'ANALYSED':
      return t('aud.conclusionStatus.analysed');
    case 'SUPERSEDED':
      return t('aud.conclusionStatus.superseded');
    case 'CLOSED':
      return t('aud.conclusionStatus.closed');
  }
}

export function findingCategoryLabel(t: T, category: FindingCategory): string {
  switch (category) {
    case 'FINANCIAL':
      return t('aud.findingCategory.financial');
    case 'PROCEDURE':
      return t('aud.findingCategory.procedure');
    case 'PROCUREMENT':
      return t('aud.findingCategory.procurement');
    case 'QUALITY':
      return t('aud.findingCategory.quality');
    case 'LAND':
      return t('aud.findingCategory.land');
    case 'PLANNING':
      return t('aud.findingCategory.planning');
    case 'OTHER':
      return t('aud.findingCategory.other');
  }
}

export function findingSeverityLabel(t: T, severity: FindingSeverity): string {
  switch (severity) {
    case 'LOW':
      return t('aud.findingSeverity.low');
    case 'MEDIUM':
      return t('aud.findingSeverity.medium');
    case 'HIGH':
      return t('aud.findingSeverity.high');
    case 'CRITICAL':
      return t('aud.findingSeverity.critical');
  }
}

export function recommendationTypeLabel(t: T, type: RecommendationType): string {
  switch (type) {
    case 'FINANCIAL_RECOVERY':
      return t('aud.recommendationType.financialRecovery');
    case 'FINANCIAL_ADJUSTMENT':
      return t('aud.recommendationType.financialAdjustment');
    case 'PROCESS_CORRECTION':
      return t('aud.recommendationType.processCorrection');
    case 'ACCOUNTABILITY':
      return t('aud.recommendationType.accountability');
    case 'REFERRAL':
      return t('aud.recommendationType.referral');
    case 'POLICY_CHANGE':
      return t('aud.recommendationType.policyChange');
  }
}

export function recommendationStatusLabel(t: T, status: RecommendationStatus): string {
  switch (status) {
    case 'OPEN':
      return t('aud.recommendationStatus.open');
    case 'ASSIGNED':
      return t('aud.recommendationStatus.assigned');
    case 'IN_PROGRESS':
      return t('aud.recommendationStatus.inProgress');
    case 'PENDING_VERIFICATION':
      return t('aud.recommendationStatus.pendingVerification');
    case 'CLOSED':
      return t('aud.recommendationStatus.closed');
    case 'DISPUTED':
      return t('aud.recommendationStatus.disputed');
    case 'CANCELLED':
      return t('aud.recommendationStatus.cancelled');
  }
}

/** The problem with a field of these forms: the ones the engagement forms share, and an amount that does not fit in what is left of the total. */
export function conclusionFormProblemMessage(t: T, problem: ConclusionFormProblem): string {
  return problem === 'exceeds' ? t('aud.formProblem.exceeds') : formProblemMessage(t, problem);
}

/** What a dialog says of a command that was refused; the total says what is left, in dong. */
export function conclusionProblemMessage(t: T, problem: ConclusionProblem, remainingVnd?: string): string {
  switch (problem) {
    case 'decisionNotEffective':
      return t('aud.conclusionProblem.decisionNotEffective');
    case 'stateInvalid':
      return t('aud.conclusionProblem.stateInvalid');
    case 'revisionInvalid':
      return t('aud.conclusionProblem.revisionInvalid');
    case 'versionConflict':
      return t('aud.conclusionProblem.versionConflict');
    case 'scopeDenied':
      return t('aud.conclusionProblem.scopeDenied');
    case 'validation':
      return t('aud.conclusionProblem.validation');
    case 'notFound':
      return t('aud.conclusionProblem.notFound');
    case 'findingDuplicate':
      return t('aud.conclusionProblem.findingDuplicate');
    case 'recommendationDuplicate':
      return t('aud.conclusionProblem.recommendationDuplicate');
    case 'amountRequired':
      return t('aud.conclusionProblem.amountRequired');
    case 'totalMismatch':
      return t('aud.conclusionProblem.totalMismatch', { remaining: formatVnd(remainingVnd ?? '0') });
    case 'targetOutside':
      return t('aud.conclusionProblem.targetOutside');
    case 'general':
      return t('aud.conclusionProblem.general');
  }
}
