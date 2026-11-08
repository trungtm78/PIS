import type { Translator } from '../../../i18n';
import { errorText } from '../../vnd/shared/vnd-labels';
import { camel, failureCode } from '../../vnd/shared/vnd-model';

type T = Translator['t'];

export const decisionLabel = (t: T, code: string): string => t(`bid34.decision.${camel(code)}.name`);
export const outcomeStatusLabel = (t: T, code: string): string => t(`bid34.status.${camel(code)}.name`);

/** The words of a refusal of the outcome commands: the codes of the outcome first, then the common words of the contractor module. */
export function outcomeErrorText(t: T, error: unknown): string {
  switch (failureCode(error)) {
    case 'PETITION_OUTCOME_STATE_INVALID':
      return t('bid34.error.state.text');
    case 'PETITION_OUTCOME_NOT_ALLOWED':
      return t('bid34.error.notAllowed.text');
    case 'CONFLICT_OF_INTEREST_BLOCKED':
      return t('bid34.error.conflict.text');
    default:
      return errorText(t, error);
  }
}
