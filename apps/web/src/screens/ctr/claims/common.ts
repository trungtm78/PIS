import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';

type T = Translator['t'];

/** The words the claim register (CTR-32 to CTR-34) and the early-warning register (CTR-35, CTR-36) of a contract share: the form of a day, an amount and a refusal. */
export type RuleBasis = components['schemas']['CtrRuleBasis'];

/** `EXTENSION_OF_TIME` as the word a catalogue key can carry (`extensionOfTime`): keys are lower camel segments, the codes of the server are not. */
export const camel = (code: string): string => code.toLowerCase().replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

const VIETNAM_OFFSET_MS = 7 * 3_600_000;

/** `dd/MM/yyyy` for a day or an instant (an instant is read as its Vietnam day); the empty text for nothing. */
export function dayText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
  const moment = Date.parse(value);
  if (Number.isNaN(moment)) return value;
  const text = new Date(moment + VIETNAM_OFFSET_MS).toISOString();
  return `${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)}`;
}

/** `dd/MM/yyyy HH:mm` in Vietnam time. */
export function stampText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const moment = Date.parse(value);
  if (Number.isNaN(moment)) return value;
  const text = new Date(moment + VIETNAM_OFFSET_MS).toISOString();
  return `${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)} ${text.slice(11, 16)}`;
}

/** Whole dong from a decimal string, the digits grouped by the language; a text that is not whole digits is left as it came (money is never a float). */
export function vnd(amount: string | null | undefined, locale: string): string {
  if (amount === null || amount === undefined || amount === '') return '';
  return /^\d+$/.test(amount) ? new Intl.NumberFormat(locale).format(BigInt(amount)) : amount;
}

export const isWholeAmount = (value: string): boolean => /^\d{1,23}$/.test(value);
export const isDay = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
};
export const isUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Today in Vietnam (`YYYY-MM-DD`), the day a form offers first. */
export const todayInVietnam = (now: Date = new Date()): string => new Date(now.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

/** Holds a permission, or the session does not say what is held (the server decides then); a frozen (read-only) session holds none that writes. */
export const can = (permissions: readonly string[] | undefined, permission: string, frozen: boolean): boolean => !frozen && (permissions === undefined || permissions.includes(permission));

/** The tone of a deadline or limitation state: missed is danger, approaching is warning, met is success, a clock that cannot run is neutral. */
export function stateTone(state: string): Tone {
  switch (state) {
    case 'MISSED':
    case 'BARRED':
      return 'danger';
    case 'APPROACHING':
    case 'MET_LATE':
    case 'CALENDAR_UNAVAILABLE':
      return 'warning';
    case 'MET':
      return 'success';
    case 'RUNNING':
      return 'info';
    default:
      return 'neutral';
  }
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------------------------------------------------------

export type ProblemKind =
  | 'versionConflict'
  | 'selfApproval'
  | 'claimState'
  | 'termPending'
  | 'barNotDue'
  | 'settlementExceeds'
  | 'warningState'
  | 'actionsOpen'
  | 'contractState'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

export interface Problem {
  kind: ProblemKind;
  /** The field the server named for a validation. */
  field: string | undefined;
}

const KIND_BY_CODE: Readonly<Record<string, ProblemKind>> = {
  VERSION_CONFLICT: 'versionConflict',
  SELF_APPROVAL_DENIED: 'selfApproval',
  CTR_CLAIM_STATE_INVALID: 'claimState',
  CLAIM_TERM_PENDING: 'termPending',
  CLAIM_BAR_NOT_DUE: 'barNotDue',
  CLAIM_SETTLEMENT_EXCEEDS_CLAIM: 'settlementExceeds',
  EARLY_WARNING_STATE_INVALID: 'warningState',
  EARLY_WARNING_ACTIONS_OPEN: 'actionsOpen',
  CONTRACT_STATE_INVALID: 'contractState',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** What a refused command was refused for; anything the screen has no word for is `general`. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return { kind: 'general', field: undefined };
  return { kind: KIND_BY_CODE[error.code] ?? 'general', field: error.detail };
}

/** The sentence of a refusal, in the words of the register (each key written out so that the i18n check sees it is in use). */
export function problemText(t: T, problem: Problem): string {
  switch (problem.kind) {
    case 'versionConflict':
      return t('ctrReg.problem.versionConflict.error');
    case 'selfApproval':
      return t('ctrReg.problem.selfApproval.error');
    case 'claimState':
      return t('ctrReg.problem.claimState.error');
    case 'termPending':
      return t('ctrReg.problem.termPending.error');
    case 'barNotDue':
      return t('ctrReg.problem.barNotDue.error');
    case 'settlementExceeds':
      return t('ctrReg.problem.settlementExceeds.error');
    case 'warningState':
      return t('ctrReg.problem.warningState.error');
    case 'actionsOpen':
      return t('ctrReg.problem.actionsOpen.error');
    case 'contractState':
      return t('ctrReg.problem.contractState.error');
    case 'validation':
      return problem.field === undefined ? t('ctrReg.problem.validation.error') : t('ctrReg.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('ctrReg.problem.notFound.error');
    case 'denied':
      return t('ctrReg.problem.denied.error');
    case 'general':
      return t('ctrReg.problem.general.error');
  }
}

/** A form problem found before anything is sent. */
export type FormProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidAmount' | 'invalidDay' | 'invalidNumber' | 'invalidId' | 'pickOne';

export function formProblemText(t: T, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ctrReg.form.required.error');
    case 'tooShort':
      return t('ctrReg.form.tooShort.error');
    case 'tooLong':
      return t('ctrReg.form.tooLong.error');
    case 'invalidAmount':
      return t('ctrReg.form.invalidAmount.error');
    case 'invalidDay':
      return t('ctrReg.form.invalidDay.error');
    case 'invalidNumber':
      return t('ctrReg.form.invalidNumber.error');
    case 'invalidId':
      return t('ctrReg.form.invalidId.error');
    case 'pickOne':
      return t('ctrReg.form.pickOne.error');
  }
}

/** The text of a field: at least `min` and at most `max` characters once trimmed. */
export function textProblem(value: string, min: number, max: number): FormProblem | undefined {
  const size = value.trim().length;
  if (size === 0) return 'required';
  if (size < min) return 'tooShort';
  return size > max ? 'tooLong' : undefined;
}

/** An optional whole number of days, 0 to `max`; the empty text is nothing. */
export function daysProblem(value: string, min: number, max: number): FormProblem | undefined {
  if (value.trim() === '') return undefined;
  return /^\d{1,4}$/.test(value.trim()) && Number(value) >= min && Number(value) <= max ? undefined : 'invalidNumber';
}

export const optionalNumber = (value: string): number | undefined => (value.trim() === '' ? undefined : Number(value.trim()));
export const optionalText = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());
