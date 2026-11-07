import { hasMessage } from '../../i18n';
import { reasonSuffix } from './format';

/** The server wants a note of at least this many characters (after trimming) when the reason asks for one. */
export const NOTE_MIN_LENGTH = 5;

/** The words of a reason of the snooze policy; a code this build has no words for is shown as it came. */
export function snoozeReasonLabel(t: (key: string) => string, code: string): string {
  const suffix = reasonSuffix(code);
  return hasMessage(`alerts.snooze.reason.${suffix}`) ? t(`alerts.snooze.reason.${suffix}`) : code;
}

/** The words of a reason to pause a clock; a code this build has no words for is shown as it came. */
export function pauseReasonLabel(t: (key: string) => string, code: string): string {
  const suffix = reasonSuffix(code);
  return hasMessage(`alerts.pause.reason.${suffix}`) ? t(`alerts.pause.reason.${suffix}`) : code;
}
