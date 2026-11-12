import type { Translator } from '../../../../i18n';
import { failureCode, failureExtension, failureList } from '../shared/format';
import { commonErrorText } from '../shared/parts';
import type { CorrectionMode, CorrectionState, PushStatus } from './model';

type T = Translator['t'];

export function pushStatusLabel(t: T, status: PushStatus): string {
  switch (status) {
    case 'PENDING':
      return t('hpm.push.status.pending');
    case 'WRITTEN':
      return t('hpm.push.status.written');
    case 'FAILED':
      return t('hpm.push.status.failed');
    case 'ACCEPTED':
      return t('hpm.push.status.accepted');
    case 'REJECTED':
      return t('hpm.push.status.rejected');
  }
}

export function correctionStateLabel(t: T, state: CorrectionState): string {
  switch (state) {
    case 'PROPOSED':
      return t('hpm.correction.state.proposed');
    case 'APPROVED':
      return t('hpm.correction.state.approved');
    case 'REJECTED':
      return t('hpm.correction.state.rejected');
    case 'APPLIED':
      return t('hpm.correction.state.applied');
    case 'CONSUMED':
      return t('hpm.correction.state.consumed');
  }
}

export function healthLabel(t: T, status: string): string {
  switch (status) {
    case 'FRESH':
      return t('hpm.health.state.fresh');
    case 'AGING':
      return t('hpm.health.state.aging');
    case 'STALE':
      return t('hpm.health.state.stale');
    default:
      return t('hpm.health.state.never');
  }
}

export function healthExplain(t: T, status: string): string {
  switch (status) {
    case 'FRESH':
      return t('hpm.health.explain.fresh');
    case 'AGING':
      return t('hpm.health.explain.aging');
    case 'STALE':
      return t('hpm.health.explain.stale');
    default:
      return t('hpm.health.explain.never');
  }
}

/** The code a failed try was recorded under, in words; a code this screen does not know is shown as the server wrote it. */
export function lastErrorLabel(t: T, code: string | null): string {
  if (code === null) return '–';
  return code === 'HPM_DELIVERY_FAILED' ? t('hpm.push.error.delivery') : code;
}

export function alertLabel(t: T, code: string): string {
  return code === 'HPM_PUSH_FAILED' ? t('hpm.alert.failed.name') : code === 'HPM_PUSH_STALE' ? t('hpm.alert.stale.name') : code;
}

function missingWord(t: T, item: string): string {
  switch (item) {
    case 'PERIOD_REOPENED':
      return t('hpm.error.missing.reopened');
    case 'APPROVED_CORRECTION':
      return t('hpm.error.missing.correction');
    default:
      return item;
  }
}

/** The outcome of a push that the server answered: written, repeated or failed (a failed delivery is an answer, not a refusal). */
export function outcomeText(t: T, status: string): string {
  switch (status) {
    case 'SENT':
      return t('hpm.push.outcome.sent.text');
    case 'ALREADY_DELIVERED':
      return t('hpm.push.outcome.already.text');
    case 'FAILED':
      return t('hpm.push.outcome.failed.text');
    default:
      return status;
  }
}

/** The refusal of a push, a retry, a receipt or a correction in the words of the person; the codes of the common ones come from the shared words. */
export function hpmErrorText(t: T, error: unknown): string {
  switch (failureCode(error)) {
    case 'REPORT_OUT_OF_DATE': {
      const current = failureExtension(error, 'current_revision');
      return t('hpm.error.outOfDate.text', { revision: typeof current === 'number' ? current : '?' });
    }
    case 'HPM_OVERWRITE_NOT_AUTHORISED': {
      const missing = failureList(error, 'missing');
      return t('hpm.error.overwrite.text', { missing: missing.length === 0 ? '–' : missing.map((item) => missingWord(t, item)).join(', ') });
    }
    case 'HPM_KEY_REUSED':
      return t('hpm.error.keyReused.text');
    case 'HPM_RETRY_EXHAUSTED':
      return t('hpm.error.retryExhausted.text');
    case 'HPM_CONNECTION_DISABLED':
      return t('hpm.error.disabled.text');
    case 'HPM_PUSH_STATE_INVALID':
      return t('hpm.error.pushState.text');
    case 'HPM_CORRECTION_STATE_INVALID':
      return t('hpm.error.correctionState.text');
    case 'TEMPLATE_UNCONFIRMED':
      return t('hpm.error.demoForm.text');
    default:
      return commonErrorText(t, error);
  }
}

/** The way a correction is made, in the words of the person. */
export const modeLabel = (t: T, mode: CorrectionMode): string => (mode === 'ADJUST_NEXT_PERIOD' ? t('hpm.correction.mode.adjust') : t('hpm.correction.mode.overwrite'));
