import { ApiError } from '@machvon/api-client';
import type { Translator } from '../../i18n';

export type WorkCommand = 'snooze' | 'pause' | 'resume';

type T = Translator['t'];

function snoozeSentence(t: T, code: string): string {
  switch (code) {
    case 'VALIDATION_FAILED':
      return t('alerts.snooze.error.validation');
    case 'WORK_SNOOZE_NOT_ALLOWED':
      return t('alerts.snooze.error.notAllowed');
    case 'WORK_SNOOZE_TOO_LONG':
      return t('alerts.snooze.error.tooLong');
    case 'WORK_SNOOZE_LIMIT':
      return t('alerts.snooze.error.limit');
    default:
      return t('alerts.snooze.error.generic');
  }
}

function pauseSentence(t: T, code: string): string {
  switch (code) {
    case 'VALIDATION_FAILED':
      return t('alerts.pause.error.validation');
    case 'WORK_CLOCK_PAUSE_TOO_LONG':
      return t('alerts.pause.error.tooLong');
    case 'WORK_CLOCK_ALLOWER_INVALID':
      return t('alerts.pause.error.allower');
    case 'WORK_CLOCK_ALREADY_PAUSED':
      return t('alerts.pause.error.already');
    default:
      return t('alerts.pause.error.generic');
  }
}

function resumeSentence(t: T, code: string): string {
  return code === 'WORK_CLOCK_NOT_PAUSED' ? t('alerts.resume.error.notPaused') : t('alerts.resume.error.generic');
}

/**
 * The sentence for the failure of a command: a specific one for a refusal the server names, a general one for anything else (a lost answer, a 5xx). Undefined when there is no failure.
 * The server decides; the screen only says why in words.
 */
export function refusalText(t: T, command: WorkCommand, failure: unknown): string | undefined {
  if (failure === null || failure === undefined) return undefined;
  const code = failure instanceof ApiError ? failure.code : '';
  if (command === 'snooze') return snoozeSentence(t, code);
  if (command === 'pause') return pauseSentence(t, code);
  return resumeSentence(t, code);
}
