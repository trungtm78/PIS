import type { Translator } from '../../../i18n';
import { errorText } from '../shared/vnd-labels';
import { camel, failureCode } from '../shared/vnd-model';

type T = Translator['t'];

// The names of the closed lists of the contract (a key is `head.<code in camel case>.tail`, so one line covers a list and a test walks the list).
export const requestKindLabel = (t: T, code: string): string => t(`vnp.requestKind.${camel(code)}.name`);
export const requestStatusLabel = (t: T, code: string): string => t(`vnp.requestStatus.${camel(code)}.name`);
export const requestClockLabel = (t: T, code: string): string => t(`vnp.requestClock.${camel(code)}.name`);
export const reconfirmStateLabel = (t: T, code: string): string => t(`vnp.reconfirmState.${camel(code)}.name`);
export const planStatusLabel = (t: T, code: string): string => t(`vnp.planStatus.${camel(code)}.name`);
export const actionStatusLabel = (t: T, code: string): string => t(`vnp.actionStatus.${camel(code)}.name`);
export const ratingLabel = (t: T, code: string): string => t(`vnp.rating.${camel(code)}.name`);
export const subjectTypeLabel = (t: T, code: string): string => t(`vnp.subjectType.${camel(code)}.name`);
export const triggerKindLabel = (t: T, code: string): string => t(`vnp.trigger.${camel(code)}.name`);
export const profileFactLabel = (t: T, code: string): string => t(`vnp.profileFact.${camel(code)}.name`);
export const ownershipLabel = (t: T, code: string): string => t(`vnp.ownership.${camel(code)}.name`);

/** The words of a refusal on the portal: the codes of the portal first, then the common words of the register. */
export function portalErrorText(t: T, error: unknown): string {
  switch (failureCode(error)) {
    case 'PORTAL_CONTRACTOR_REQUIRED':
      return t('vnp.error.contractorRequired.text');
    case 'PORTAL_REQUEST_STATE_INVALID':
      return t('vnp.error.requestState.text');
    case 'REMEDIATION_STATE_INVALID':
      return t('vnp.error.planState.text');
    case 'RECONFIRMATION_DECLARATION_STALE':
      return t('vnp.error.declarationStale.text');
    case 'CONTRACTOR_PORTAL_NOT_BOUND':
      return t('vnp.error.notBound.text');
    case 'CALENDAR_NOT_EFFECTIVE':
      return t('vnp.error.calendar.text');
    default:
      return errorText(t, error);
  }
}
