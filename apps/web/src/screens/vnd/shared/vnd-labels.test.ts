import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import {
  basisLabel,
  behaviourLabel,
  callbackOutcomeLabel,
  caseStatusLabel,
  certificateStateLabel,
  changeStatusLabel,
  changeStepLabel,
  clockLabel,
  duplicateStatusLabel,
  errorText,
  eventStatusLabel,
  gapLabel,
  gateActionLabel,
  gateCheckLabel,
  gradeLabel,
  groupLabel,
  infoLabels,
  kindLabel,
  moveLabel,
  ownerKindLabel,
  payeeReasonLabel,
  profileFieldLabel,
  refusalLabel,
  scopeLabel,
  signalLabel,
  staffRoleLabel,
  subjectLabel,
  suggestionLabel,
  taxChecksumLabel,
  taxFormatLabel,
  triggerLabel,
  verificationLabel,
  ventureStatusLabel,
  warningLabel,
} from './vnd-labels';
import {
  BEHAVIOURS,
  CASE_STATUSES,
  CERTIFICATE_KINDS,
  CERTIFICATE_STATES,
  CHANGE_STATUSES,
  CHANGE_STEPS,
  CLOCKS,
  CONTROL_BASES,
  DUPLICATE_SIGNALS,
  GAPS,
  GATE_ACTIONS,
  GATE_CHECKS,
  GRADES,
  PAYEE_REASONS,
  PROFILE_FIELDS,
  SCOPES,
  STAFF_ROLES,
  TRIGGER_KINDS,
  VERIFICATIONS,
  VIOLATION_GROUPS,
} from './vnd-model';

const catalogue = (source: object): Record<string, string> => source as Record<string, string>;
const hasKey = (source: object, key: string): boolean => typeof catalogue(source)[key] === 'string' && catalogue(source)[key] !== '';

/** Every code of a closed list of the contract must have its words in both languages: the keys are written as templates, so the i18n lint cannot see a missing one. */
function keysOf(label: (t: (key: string) => string, code: string) => string, codes: readonly string[]): string[] {
  const seen: string[] = [];
  for (const code of codes) label((key) => (seen.push(key), key), code);
  return seen;
}

const LISTS: Array<[string, (t: never, code: string) => string, readonly string[]]> = [
  ['kind', kindLabel as never, CERTIFICATE_KINDS],
  ['staff role', staffRoleLabel as never, STAFF_ROLES],
  ['certificate state', certificateStateLabel as never, CERTIFICATE_STATES],
  ['behaviour', behaviourLabel as never, BEHAVIOURS],
  ['grade', gradeLabel as never, GRADES],
  ['gap', gapLabel as never, GAPS],
  ['gate action', gateActionLabel as never, GATE_ACTIONS],
  ['gate check', gateCheckLabel as never, GATE_CHECKS],
  ['clock', clockLabel as never, CLOCKS],
  ['case status', caseStatusLabel as never, CASE_STATUSES],
  ['scope', scopeLabel as never, SCOPES],
  ['signal', signalLabel as never, DUPLICATE_SIGNALS],
  ['violation group', groupLabel as never, VIOLATION_GROUPS],
  ['profile field', profileFieldLabel as never, PROFILE_FIELDS],
  ['verification', verificationLabel as never, VERIFICATIONS],
  ['payee reason', payeeReasonLabel as never, PAYEE_REASONS],
  ['change status', changeStatusLabel as never, CHANGE_STATUSES],
  ['change step', changeStepLabel as never, CHANGE_STEPS],
  ['control basis', basisLabel as never, CONTROL_BASES],
  ['owner kind', ownerKindLabel as never, ['PERSON', 'ORGANISATION']],
  ['suggestion', suggestionLabel as never, ['NONE', 'PROVINCE', 'NATIONWIDE']],
  ['tax format', taxFormatLabel as never, ['VALID', 'INVALID']],
  ['tax checksum', taxChecksumLabel as never, ['MATCH', 'MISMATCH', 'NOT_CHECKED']],
  ['subject', subjectLabel as never, ['QUALIFICATION', 'KEY_STAFF']],
  ['venture status', ventureStatusLabel as never, ['ACTIVE', 'ENDED']],
  ['event status', eventStatusLabel as never, ['RECORDED', 'POSTED', 'RETRACTED']],
  ['duplicate status', duplicateStatusLabel as never, ['OPEN', 'DISMISSED', 'MERGE_REQUESTED']],
  ['callback outcome', callbackOutcomeLabel as never, ['CONFIRMED', 'NOT_CONFIRMED']],
];

describe('the words of the closed lists of the contract', () => {
  it.each(LISTS)('has Vietnamese and English words for every code of the list of %s', (_name, label, codes) => {
    const keys = keysOf(label as never, codes);
    expect(keys).toHaveLength(codes.length);
    for (const key of keys) {
      expect(hasKey(vi, key), `vi ${key}`).toBe(true);
      expect(hasKey(en, key), `en ${key}`).toBe(true);
    }
  });

  it('has words for the triggers, the moves of a case and the warnings the server names, and falls back to the code of one it does not know', () => {
    translator.setLocale('vi');
    for (const code of [...TRIGGER_KINDS, 'EGP_IMPORT']) expect(triggerLabel(translator.t, code)).not.toBe(code);
    for (const code of ['PROPOSE', 'SEND_NOTICE', 'RECORD_RESPONSE', 'CLOSE_NO_RESPONSE', 'WITHDRAW', 'DECIDE', 'EFFECT', 'LIFT', 'EXPIRE']) expect(moveLabel(translator.t, code)).not.toBe(code);
    for (const code of ['PROFILE_INCOMPLETE', 'QUALIFICATION_GAP', 'PAYEE_ACCOUNT_NOT_REGISTERED', 'PAYEE_CHANGE_PENDING']) expect(warningLabel(translator.t, code)).not.toBe(code);
    expect(triggerLabel(translator.t, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(moveLabel(translator.t, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(warningLabel(translator.t, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
    for (const code of ['investorProposal', 'inspectionConclusion', 'auditConclusion', 'petitionResolution', 'egpImport', 'ownInitiative']) expect(hasKey(en, `vnd.trigger.${code}.name`)).toBe(true);
  });

  it('writes a refusal of the gate in words, and a code it does not know as it came', () => {
    translator.setLocale('vi');
    expect(refusalLabel(translator.t, null)).toBe(vi['vnd.gate.refusal.none.text' as keyof typeof vi]);
    for (const code of ['CONTRACTOR_RESTRICTED', 'CONTRACTOR_NOT_VERIFIED', 'CONTRACTOR_PROFILE_INCOMPLETE', 'CONTRACTOR_QUALIFICATION_MISSING', 'PAYEE_ACCOUNT_NOT_VALID']) expect(refusalLabel(translator.t, code)).not.toBe(code);
    expect(refusalLabel(translator.t, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('gives the figure its eleven labels', () => {
    translator.setLocale('vi');
    const labels = infoLabels(translator.t, 'Độ phủ');
    expect(Object.values(labels).filter((value) => value !== '')).toHaveLength(11);
    expect(labels.open).toContain('Độ phủ');
  });
});

const problem = (status: number, code: string, detail?: string, extensions?: Record<string, unknown>) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), ...(extensions === undefined ? {} : { extensions }) });

describe('errorText', () => {
  translator.setLocale('vi');
  const say = (error: unknown): string => errorText(translator.t, error);

  it('says a changed version, the same person on both sides and a field of the server in words', () => {
    expect(say(problem(409, 'VERSION_CONFLICT'))).toBe(vi['vnd.error.conflict.text' as keyof typeof vi]);
    expect(say(problem(403, 'SELF_APPROVAL_DENIED'))).toBe(vi['vnd.error.selfApproval.text' as keyof typeof vi]);
    expect(say(problem(422, 'VALIDATION_FAILED', 'reason: too short'))).toContain('reason: too short');
    expect(say(problem(422, 'VALIDATION_FAILED'))).toBe(vi['vnd.error.validationBare.text' as keyof typeof vi]);
  });

  it('repeats the numbers the server names in the refusal of a ban period and a time bar', () => {
    expect(say(problem(422, 'RESTRICTION_BAN_PERIOD_INVALID', undefined, { min_months: 12, max_months: 36 }))).toMatch(/12.*36/);
    expect(say(problem(422, 'RESTRICTION_CASE_TIME_BARRED', undefined, { limit_on: '2026-09-15' }))).toContain('2026-09-15');
  });

  it('has its own words for the refusals of the workflow codes', () => {
    const codes = ['RESTRICTION_CASE_STATE_INVALID', 'BANK_CHANGE_STATE_INVALID', 'RESTRICTION_CASE_DUPLICATE', 'RESTRICTION_RESPONSE_WINDOW_OPEN', 'RESTRICTION_NOT_YET_EFFECTIVE', 'RESTRICTION_NOT_YET_ENDED', 'BANK_CHANGE_CALLBACK_INVALID', 'PAYEE_ACCOUNT_NAME_MISMATCH', 'JOINT_VENTURE_SHARES_INVALID', 'IDEMPOTENCY_CONFLICT'];
    const words = new Set(codes.map((code) => say(problem(code === 'IDEMPOTENCY_CONFLICT' ? 409 : 422, code))));
    expect(words.size).toBeGreaterThanOrEqual(8);
    for (const text of words) expect(text).not.toBe(vi['vnd.error.unknown.text' as keyof typeof vi]);
  });

  it('falls back by the status, and to a plain refusal for anything else', () => {
    expect(say(problem(403, 'SCOPE_DENIED'))).toBe(vi['vnd.error.forbidden.text' as keyof typeof vi]);
    expect(say(problem(404, 'RESOURCE_NOT_FOUND'))).toBe(vi['vnd.error.notFound.text' as keyof typeof vi]);
    expect(say(problem(409, 'SOMETHING'))).toBe(vi['vnd.error.stateInvalid.text' as keyof typeof vi]);
    expect(say(problem(500, 'INTERNAL_ERROR'))).toBe(vi['vnd.error.unknown.text' as keyof typeof vi]);
    expect(say(new Error('boom'))).toBe(vi['vnd.error.unknown.text' as keyof typeof vi]);
  });
});
