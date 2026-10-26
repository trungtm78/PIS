import type { Translator } from '../../../i18n';
import { formatVnd } from '../conclusion/model';
import type { ExceptionKind, RecoveryProblem, SourceKind } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function sourceKindLabel(t: T, kind: SourceKind): string {
  switch (kind) {
    case 'PAY_RECOVERY':
      return t('aud.recoverySource.payRecovery');
    case 'PAY_DEDUCTION':
      return t('aud.recoverySource.payDeduction');
    case 'TREASURY_REMITTANCE':
      return t('aud.recoverySource.treasuryRemittance');
    case 'MANUAL_EVIDENCE':
      return t('aud.recoverySource.manualEvidence');
  }
}

export function exceptionKindLabel(t: T, kind: ExceptionKind): string {
  switch (kind) {
    case 'OVER_RECOVERY':
      return t('aud.recoveryException.overRecovery');
    case 'UNMATCHED_REVERSAL':
      return t('aud.recoveryException.unmatchedReversal');
    case 'NOT_APPLICABLE':
      return t('aud.recoveryException.notApplicable');
  }
}

/** What a dialog says of a command that was refused; the amount says what is left to recover, in dong. */
export function recoveryProblemMessage(t: T, problem: RecoveryProblem, remainingVnd?: string): string {
  switch (problem) {
    case 'exceeds':
      return t('aud.recoveryProblem.exceeds', { remaining: formatVnd(remainingVnd ?? '0') });
    case 'sourceLinked':
      return t('aud.recoveryProblem.sourceLinked');
    case 'notFinancial':
      return t('aud.recoveryProblem.notFinancial');
    case 'evidenceRequired':
      return t('aud.recoveryProblem.evidenceRequired');
    case 'alreadyReversed':
      return t('aud.recoveryProblem.alreadyReversed');
    case 'recommendationState':
      return t('aud.recoveryProblem.recommendationState');
    case 'engagementState':
      return t('aud.recoveryProblem.engagementState');
    case 'versionConflict':
      return t('aud.recoveryProblem.versionConflict');
    case 'scopeDenied':
      return t('aud.recoveryProblem.scopeDenied');
    case 'validation':
      return t('aud.recoveryProblem.validation');
    case 'notFound':
      return t('aud.recoveryProblem.notFound');
    case 'general':
      return t('aud.recoveryProblem.general');
  }
}
