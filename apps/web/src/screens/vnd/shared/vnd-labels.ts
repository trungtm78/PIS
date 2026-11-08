import { ApiError } from '@machvon/api-client';
import { hasMessage } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { InfoFormulaLabels } from '../../../ui';
import { camel, failureCode, failureDetail, failureStatus } from './vnd-model';

type T = Translator['t'];

// The names of the closed lists of the contract. A key is `head.<code in camel case>.tail`, so one line covers a list and a test walks the list (vnd-labels.test.ts) to prove that every code has its words in both languages.
export const kindLabel = (t: T, code: string): string => t(`vnd.kind.${camel(code)}.name`);
export const staffRoleLabel = (t: T, code: string): string => t(`vnd.staffRole.${camel(code)}.name`);
export const certificateStateLabel = (t: T, code: string): string => t(`vnd.certState.${camel(code)}.name`);
export const behaviourLabel = (t: T, code: string): string => t(`vnd.behaviour.${camel(code)}.name`);
export const gradeLabel = (t: T, code: string): string => t(`vnd.grade.${camel(code)}.name`);
export const gapLabel = (t: T, code: string): string => t(`vnd.gap.${camel(code)}.name`);
export const gateActionLabel = (t: T, code: string): string => t(`vnd.gateAction.${camel(code)}.name`);
export const gateCheckLabel = (t: T, code: string): string => t(`vnd.gateCheck.${camel(code)}.name`);
export const clockLabel = (t: T, code: string): string => t(`vnd.clock.${camel(code)}.name`);
export const caseStatusLabel = (t: T, code: string): string => t(`vnd.caseStatus.${camel(code)}.name`);
export const scopeLabel = (t: T, code: string): string => t(`vnd.scope.${camel(code)}.name`);
export const signalLabel = (t: T, code: string): string => t(`vnd.signal.${camel(code)}.name`);
/** The violation groups are named by the rule of the tenant, so a group this screen has no words for is shown as the server wrote it. */
export const groupLabel = (t: T, code: string): string => (hasMessage(`vnd.group.${camel(code)}.name`) ? t(`vnd.group.${camel(code)}.name`) : code);
export const profileFieldLabel = (t: T, code: string): string => t(`vnd.profileField.${camel(code)}.name`);
export const verificationLabel = (t: T, code: string): string => t(`vnd.verification.${camel(code)}.name`);
export const payeeReasonLabel = (t: T, code: string): string => t(`vnd.payeeReason.${camel(code)}.text`);
export const changeStatusLabel = (t: T, code: string): string => t(`vnd.changeStatus.${camel(code)}.name`);
export const changeStepLabel = (t: T, code: string): string => t(`vnd.changeStep.${camel(code)}.name`);
export const basisLabel = (t: T, code: string): string => t(`vnd.basis.${camel(code)}.name`);
export const ownerKindLabel = (t: T, code: string): string => t(`vnd.ownerKind.${camel(code)}.name`);
export const suggestionLabel = (t: T, code: string): string => t(`vnd.suggestion.${camel(code)}.name`);
export const taxFormatLabel = (t: T, code: string): string => t(`vnd.taxFormat.${camel(code)}.name`);
export const taxChecksumLabel = (t: T, code: string): string => t(`vnd.taxChecksum.${camel(code)}.name`);
export const subjectLabel = (t: T, code: string): string => t(`vnd.subject.${camel(code)}.name`);
export const ventureStatusLabel = (t: T, code: string): string => t(`vnd.ventureStatus.${camel(code)}.name`);
export const eventStatusLabel = (t: T, code: string): string => t(`vnd.eventStatus.${camel(code)}.name`);
export const duplicateStatusLabel = (t: T, code: string): string => t(`vnd.duplicateStatus.${camel(code)}.name`);
export const callbackOutcomeLabel = (t: T, code: string): string => t(`vnd.callbackOutcome.${camel(code)}.name`);

/** What started a case or moved it: the words of the catalogue when it has them (the server may add a trigger or a move later), else the code as the server wrote it. */
export const triggerLabel = (t: T, code: string): string => (hasMessage(`vnd.trigger.${camel(code)}.name`) ? t(`vnd.trigger.${camel(code)}.name`) : code);
export const moveLabel = (t: T, code: string): string => (hasMessage(`vnd.move.${camel(code)}.name`) ? t(`vnd.move.${camel(code)}.name`) : code);

export const warningLabel = (t: T, code: string): string => (hasMessage(`vnd.warning.${camel(code)}.name`) ? t(`vnd.warning.${camel(code)}.name`) : code);

/** What a gate refuses with, in words; a code this screen does not know is shown as it came. */
export function refusalLabel(t: T, code: string | null): string {
  switch (code) {
    case null:
      return t('vnd.gate.refusal.none.text');
    case 'CONTRACTOR_RESTRICTED':
      return t('vnd.gate.refusal.restricted.text');
    case 'CONTRACTOR_NOT_VERIFIED':
      return t('vnd.gate.refusal.notVerified.text');
    case 'CONTRACTOR_PROFILE_INCOMPLETE':
      return t('vnd.gate.refusal.profile.text');
    case 'CONTRACTOR_QUALIFICATION_MISSING':
      return t('vnd.gate.refusal.qualification.text');
    case 'PAYEE_ACCOUNT_NOT_VALID':
      return t('vnd.gate.refusal.payee.text');
    default:
      return code;
  }
}

export function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('vnd.info.open.label', { name }),
    close: t('vnd.info.close.label'),
    formula: t('vnd.info.formula.label'),
    numerator: t('vnd.info.numerator.label'),
    denominator: t('vnd.info.denominator.label'),
    exclusions: t('vnd.info.exclusions.label'),
    source: t('vnd.info.source.label'),
    asOf: t('vnd.info.asOf.label'),
    owner: t('vnd.info.owner.label'),
    version: t('vnd.info.version.label'),
    unverified: t('vnd.info.unverified.text'),
  };
}

const numberOf = (error: unknown, name: string): number | string => {
  const value = error instanceof ApiError ? error.extensions[name] : undefined;
  return typeof value === 'number' || typeof value === 'string' ? value : '?';
};

/**
 * Why a command was refused, said in place: the server's code and its field detail, never a bare "error". A changed version asks for a reload, the same person on both sides of a check or a decision says so, a field the server named
 * is repeated with its words. The text is the screen's own; nothing the server wrote beyond the detail of a field is shown.
 */
export function errorText(t: T, error: unknown): string {
  const code = failureCode(error);
  switch (code) {
    case 'VERSION_CONFLICT':
      return t('vnd.error.conflict.text');
    case 'SELF_APPROVAL_DENIED':
      return t('vnd.error.selfApproval.text');
    case 'RESTRICTION_BAN_PERIOD_INVALID':
      return t('vnd.error.banPeriod.text', { min: numberOf(error, 'min_months'), max: numberOf(error, 'max_months') });
    case 'RESTRICTION_CASE_TIME_BARRED':
      return t('vnd.error.timeBarred.text', { day: numberOf(error, 'limit_on') });
    case 'RESTRICTION_CASE_STATE_INVALID':
    case 'BANK_CHANGE_STATE_INVALID':
      return t('vnd.error.stateInvalid.text');
    case 'RESTRICTION_CASE_DUPLICATE':
      return t('vnd.error.caseDuplicate.text');
    case 'RESTRICTION_RESPONSE_WINDOW_OPEN':
      return t('vnd.error.windowOpen.text');
    case 'RESTRICTION_NOT_YET_EFFECTIVE':
      return t('vnd.error.notYetEffective.text');
    case 'RESTRICTION_NOT_YET_ENDED':
      return t('vnd.error.notYetEnded.text');
    case 'BANK_CHANGE_CALLBACK_INVALID':
      return t('vnd.error.callbackInvalid.text');
    case 'PAYEE_ACCOUNT_NAME_MISMATCH':
      return t('vnd.error.nameMismatch.text');
    case 'JOINT_VENTURE_SHARES_INVALID':
      return t('vnd.error.shares.text');
    case 'IDEMPOTENCY_CONFLICT':
      return t('vnd.error.idempotency.text');
    default:
      break;
  }
  const status = failureStatus(error);
  if (code === 'VALIDATION_FAILED' || status === 422) {
    const detail = failureDetail(error);
    return detail === undefined ? t('vnd.error.validationBare.text') : t('vnd.error.validation.text', { detail });
  }
  if (status === 403) return t('vnd.error.forbidden.text');
  if (status === 404) return t('vnd.error.notFound.text');
  if (status === 409) return t('vnd.error.stateInvalid.text');
  return t('vnd.error.unknown.text');
}
