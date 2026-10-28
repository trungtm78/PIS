import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { effectLabel, formProblemMessage, methodLabel, problemMessage, roleLabel, statusLabel, weatherLabel } from './labels';
import {
  DIARY_STATUSES,
  NO_FILTER,
  SIGNATURE_METHODS,
  canWrite,
  contentOf,
  describeProblem,
  emptyDiary,
  emptySign,
  emptyResolve,
  filterQuery,
  formOf,
  otherContent,
  pendingConflicts,
  resolveBody,
  saveBody,
  signBody,
  signedRoles,
  toDiaryLine,
  toDiaryPage,
  validateResolve,
  validateDiary,
  validateReason,
  validateSign,
  vietnamToday,
} from './model';
import type { Problem } from './model';
import { contractId } from '../../ctr/test-support';
import { actions, copy, diary, signature } from './test-support';

const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });
const lineOf = (raw: unknown) => {
  const line = toDiaryLine(raw);
  if (line === undefined) throw new Error('not a diary');
  return line;
};
const translate = (key: string): string => (vi_ as Record<string, string>)[key] ?? `MISSING:${key}`;

describe('toDiaryLine', () => {
  it('reads a diary with its content, signatures, value of a signature and what the caller may do', () => {
    const line = lineOf(diary(1, { status: 'CONTRACTOR_SIGNED', signatures: [signature('CONTRACTOR', 'An Phát', { method: 'DIGITAL_CERT', legal_effect: 'LEGAL_E_SIGNATURE', cert_serial: 'SN-1' })], signable_roles: ['SUPERVISOR', 'NOPE'], actions: actions({ supervise: true }) }));
    expect(line).toMatchObject({
      diaryNo: 'NK-HD-A-002-20261021',
      recordDate: '2026-10-21',
      status: 'CONTRACTOR_SIGNED',
      weatherCode: 'SUNNY',
      workforceCount: 12,
      author: 'Nhà thầu An Phát',
      signableRoles: ['SUPERVISOR'],
      signatureValue: { cxn: 'CXN-EXE-05', awaitingConfirmation: true },
      actions: { supervise: true, revise: false },
      version: 2,
    });
    expect(line.signatures).toEqual([{ role: 'CONTRACTOR', signerName: 'An Phát', method: 'DIGITAL_CERT', legalEffect: 'LEGAL_E_SIGNATURE', certSerial: 'SN-1', signedAt: '2026-10-25T02:30:00.000Z', valid: true }]);
  });

  it('refuses what is not a diary, drops a signature that is not one, and never claims the value of a signature is settled unless told', () => {
    expect(toDiaryLine(null)).toBeUndefined();
    expect(toDiaryLine({ ...diary(1), status: 'WHATEVER' })).toBeUndefined();
    expect(toDiaryLine({ ...diary(1), record_date: '21/10/2026' })).toBeUndefined();
    expect(toDiaryLine({ ...diary(1), version: '2' })).toBeUndefined();
    expect(lineOf(diary(1, { signatures: [{ role: 'CONTRACTOR' }, 'x', signature('OWNER', 'Chủ đầu tư')] })).signatures.map((entry) => entry.role)).toEqual(['OWNER']);
    expect(lineOf(diary(1, { signature_value: undefined })).signatureValue.awaitingConfirmation).toBe(true);
    expect(lineOf(diary(1, { signature_value: { cxn: 'CXN-EXE-05', awaiting_confirmation: false } })).signatureValue.awaitingConfirmation).toBe(false);
  });

  it('reads a page, ignoring what is not a diary', () => {
    expect(toDiaryPage({ items: [diary(1), { id: 3 }], next_cursor: 'abc' })).toMatchObject({ lines: [{ recordDate: '2026-10-21' }], next: 'abc' });
    expect(toDiaryPage(undefined)).toEqual({ lines: [], next: undefined });
  });

  it('counts a signature that is void as not signed', () => {
    expect(signedRoles(lineOf(diary(1, { signatures: [signature('CONTRACTOR', 'a'), signature('SUPERVISOR', 'b', { valid: false })] })))).toEqual(['CONTRACTOR']);
  });
});

describe('the filter, the form and the commands', () => {
  it('asks the server only for what was chosen and is well formed', () => {
    expect(filterQuery(NO_FILTER)).toEqual({});
    expect(filterQuery({ contractId: '00000000-0000-4000-8000-000000000001', status: 'LOCKED', from: '2026-10-01', to: '2026-10-31', hasConflict: true })).toEqual({ contract_id: '00000000-0000-4000-8000-000000000001', status: 'LOCKED', from: '2026-10-01', to: '2026-10-31', has_conflict: 'true' });
    expect(filterQuery({ contractId: 'x', status: 'NOPE', from: '1/1/2026', to: '', hasConflict: false })).toEqual({});
  });

  it('validates the draft: the contract, a real day that has come, the work, the number and the weather', () => {
    const ok = { ...emptyDiary('2026-10-25'), contractId: '00000000-0000-4000-8000-000000000001', summary: 'Đổ bê tông' };
    expect(validateDiary(ok, '2026-10-25', true)).toEqual({});
    expect(validateDiary({ ...emptyDiary('2026-10-25') }, '2026-10-25', true)).toEqual({ contractId: 'required', summary: 'required' });
    expect(validateDiary({ ...ok, recordDate: '2026-10-26' }, '2026-10-25', true)).toEqual({ recordDate: 'futureDate' });
    expect(validateDiary({ ...ok, recordDate: '2026-02-30' }, '2026-10-25', true)).toEqual({ recordDate: 'invalidDate' });
    expect(validateDiary({ ...ok, recordDate: '' }, '2026-10-25', true)).toEqual({ recordDate: 'invalidDate' });
    expect(validateDiary({ ...ok, workforceCount: '-1', weatherCode: 'fog!', notes: 'x'.repeat(8001) }, '2026-10-25', true)).toEqual({ workforceCount: 'invalidNumber', weatherCode: 'invalidWeather', notes: 'tooLong' });
    expect(validateDiary({ ...ok, summary: 'x'.repeat(8001) }, '2026-10-25', true)).toEqual({ summary: 'tooLong' });
    // A diary that exists keeps its contract and day: they are not asked again.
    expect(validateDiary({ ...ok, contractId: '', recordDate: 'bad' }, '2026-10-25', false)).toEqual({});
  });

  it('builds the content from the form over what the diary held, taking out what was emptied', () => {
    const form = { ...emptyDiary('2026-10-25'), contractId: '00000000-0000-4000-8000-000000000001', summary: ' Đổ bê tông ', weatherCode: 'RAIN', workforceCount: ' 15 ', notes: '' };
    expect(contentOf(form, { notes: 'cũ', other: { a: 1 }, weather_code: 'SUNNY' })).toEqual({ summary: 'Đổ bê tông', weather_code: 'RAIN', workforce_count: 15, other: { a: 1 } });
    expect(contentOf({ ...form, weatherCode: '', workforceCount: '' }, { workforce_count: 3 })).toEqual({ summary: 'Đổ bê tông' });
    expect(saveBody(form, 'op')).toEqual({ contract_id: form.contractId, record_date: '2026-10-25', client_operation_id: 'op', content: { summary: 'Đổ bê tông', weather_code: 'RAIN', workforce_count: 15 } });
  });

  it('keeps the values of the content that the form cannot represent, and shows them', () => {
    const form = { ...emptyDiary('2026-10-25'), summary: 'Đổ bê tông' };
    const base = { summary: 'Cũ', notes: ['một', 'hai'], weather_code: 7, workforce_count: 1.5, equipment: [1] };
    expect(otherContent(base)).toEqual({ notes: ['một', 'hai'], weather_code: 7, workforce_count: 1.5, equipment: [1] });
    expect(contentOf(form, base)).toEqual({ summary: 'Đổ bê tông', notes: ['một', 'hai'], weather_code: 7, workforce_count: 1.5, equipment: [1] });
    // Whatever the form says replaces it.
    expect(contentOf({ ...form, notes: 'ghi chú', workforceCount: '3' }, base)).toMatchObject({ notes: 'ghi chú', workforce_count: 3 });
    expect(otherContent({ summary: 'a', notes: 'b', weather_code: 'RAIN', workforce_count: 3 })).toEqual({});
  });

  it('reads the copies that devices left, and what the caller may do about them', () => {
    const line = lineOf(diary(1, { conflicts: [copy(1), copy(2, { state: 'RESOLVED', resolution: 'MERGED', note: 'Ghép', discarded: { summary: 'cũ' }, resolved_at: '2026-10-25T05:00:00.000Z' }), { id: 'x' }], actions: actions({ resolveConflict: true }) }));
    expect(line.conflicts.map((entry) => [entry.diaryNo.slice(-2), entry.state, entry.resolution])).toEqual([
      ['C1', 'CONFLICT_PENDING', null],
      ['C2', 'RESOLVED', 'MERGED'],
    ]);
    expect(line.conflicts[0]).toMatchObject({ author: 'Kỹ sư B', deviceId: '00000000-0000-4000-8000-0000000000d1', content: { workforce_count: 30 } });
    expect(line.conflicts[1]).toMatchObject({ note: 'Ghép', discarded: { summary: 'cũ' } });
    expect(pendingConflicts(line).map((entry) => entry.id)).toEqual([copy(1).id]);
    expect(line.actions.resolveConflict).toBe(true);
    expect(lineOf(diary(1)).conflicts).toEqual([]);
  });

  it('validates the settling of a conflict and builds what is sent: the copy, the way, the reason, and the merged content for a merge', () => {
    const line = lineOf(diary(1, { conflicts: [copy(1)], content: { summary: 'Đổ bê tông', other_client: 1 } }));
    const form = emptyResolve(line);
    expect(form).toMatchObject({ conflictId: copy(1).id, resolution: '', note: '' });
    expect(validateResolve(form, line)).toEqual({ resolution: 'required', note: 'required' });
    expect(validateResolve({ ...form, conflictId: 'other', resolution: 'KEEP_PRIMARY', note: 'x' }, line)).toEqual({ conflictId: 'required' });
    expect(validateResolve({ ...form, resolution: 'KEEP_PRIMARY', note: 'x'.repeat(2001) }, line)).toEqual({ note: 'tooLong' });
    expect(validateResolve({ ...form, resolution: 'MERGED', note: 'x', merged: { ...form.merged, summary: '' } }, line)).toEqual({ merged: 'required' });
    expect(resolveBody({ ...form, resolution: 'ADOPT_CONFLICT', note: ' Vì sao ' }, line)).toEqual({ conflict_diary_id: copy(1).id, resolution: 'ADOPT_CONFLICT', note: 'Vì sao' });
    expect(resolveBody({ ...form, resolution: 'MERGED', note: 'Ghép', merged: { ...form.merged, summary: 'Cả hai', workforceCount: '9' } }, line)).toEqual({
      conflict_diary_id: copy(1).id,
      resolution: 'MERGED',
      merged_content: { summary: 'Cả hai', other_client: 1, workforce_count: 9, weather_code: 'SUNNY' },
      note: 'Ghép',
    });
  });

  it('reads a diary back into the form', () => {
    expect(formOf(lineOf(diary(1)))).toEqual({ contractId: contractId(2), recordDate: '2026-10-21', summary: 'Đổ bê tông móng đợt 1', weatherCode: 'SUNNY', workforceCount: '12', notes: 'Không có sự cố' });
    expect(formOf(lineOf(diary(1, { content: {}, weather_code: null, workforce_count: null })))).toMatchObject({ summary: '', weatherCode: '', workforceCount: '', notes: '' });
  });

  it('validates a signature: a way of signing, a serial for a certificate and none otherwise, and the words that are required', () => {
    const base = emptySign('op');
    expect(validateSign(base, false)).toEqual({ method: 'required' });
    expect(validateSign({ ...base, method: 'IN_APP_OTP' }, false)).toEqual({});
    expect(validateSign({ ...base, method: 'IN_APP_OTP', certSerial: 'SN' }, false)).toEqual({ certSerial: 'certSerial' });
    expect(validateSign({ ...base, method: 'DIGITAL_CERT' }, false)).toEqual({ certSerial: 'certSerial' });
    expect(validateSign({ ...base, method: 'DIGITAL_CERT', certSerial: 'SN' }, false)).toEqual({});
    expect(validateSign({ ...base, method: 'IN_APP_OTP' }, true)).toEqual({ words: 'required' });
    expect(validateSign({ ...base, method: 'IN_APP_OTP', words: 'x'.repeat(2001) }, true)).toEqual({ words: 'tooLong' });
    expect(signBody({ ...base, method: 'DIGITAL_CERT', certSerial: ' SN ' })).toEqual({ signature_method: 'DIGITAL_CERT', cert_serial: 'SN', client_operation_id: 'op' });
    expect(signBody({ ...base, method: 'IN_APP_WEBAUTHN' })).toEqual({ signature_method: 'IN_APP_WEBAUTHN', client_operation_id: 'op' });
  });

  it('validates a reason, required or not', () => {
    expect(validateReason('', true)).toBe('required');
    expect(validateReason('  ', false)).toBeUndefined();
    expect(validateReason('x'.repeat(2001), false)).toBe('tooLong');
  });

  it('lets whoever has the right to write, except in a read-only session', () => {
    expect(canWrite(['diary.write'], 'FULL')).toBe(true);
    expect(canWrite(undefined, undefined)).toBe(true);
    expect(canWrite(['site_diary.read'], 'FULL')).toBe(false);
    expect(canWrite(['diary.write'], 'READ_ONLY')).toBe(false);
  });

  it('keeps the day on the calendar of Vietnam', () => {
    expect(vietnamToday(new Date('2026-10-24T17:30:00Z'))).toBe('2026-10-25');
    expect(vietnamToday(new Date('2026-10-24T16:30:00Z'))).toBe('2026-10-24');
  });
});

describe('describeProblem', () => {
  it('words each refusal of the server', () => {
    const cases: Array<[unknown, Problem]> = [
      [problem('DIARY_STATE_INVALID', 409), 'diaryState'],
      [problem('DIARY_STATE_INVALID', 409, { reason: 'CORRECTION_OPEN' }), 'correctionOpen'],
      [problem('DIARY_STATE_INVALID', 409, { reason: 'CONTENT_CHANGED' }), 'contentChanged'],
      [problem('DIARY_DAY_EXISTS', 409), 'dayExists'],
      [problem('DIARY_SYNC_CONFLICT', 409), 'syncConflict'],
      [problem('ALREADY_SIGNED', 409), 'alreadySigned'],
      [problem('SIGNATURE_METHOD_NOT_ACCEPTED'), 'methodNotAccepted'],
      [problem('CONTRACT_STATE_INVALID', 409), 'contractState'],
      [problem('PERMIT_GATE_BLOCKED', 409), 'permitGate'],
      [problem('VERSION_CONFLICT', 409), 'versionConflict'],
      [problem('VALIDATION_FAILED'), 'validation'],
      [problem('FIELD_NOT_ALLOWED', 400), 'validation'],
      [problem('RESOURCE_NOT_FOUND', 404), 'notFound'],
      [problem('SCOPE_DENIED', 403, {}, 'signer_role'), 'notYourRole'],
      [problem('SCOPE_DENIED', 403), 'denied'],
      [problem('ENTITLEMENT_DENIED', 403), 'denied'],
      [problem('SESSION_EXPIRED', 401), 'session'],
      [problem('SOMETHING_ELSE', 500), 'general'],
      [new Error('x'), 'general'],
    ];
    for (const [error, expected] of cases) expect(describeProblem(error)).toBe(expected);
  });
});

describe('labels', () => {
  it('has words for every status, method, role, weather, form problem and refusal, and none missing in the language', () => {
    const words = [
      ...DIARY_STATUSES.map((status) => statusLabel(translate as never, status)),
      ...SIGNATURE_METHODS.map((method) => methodLabel(translate as never, method)),
      ...(['CONTRACTOR', 'SUPERVISOR', 'OWNER'] as const).map((role) => roleLabel(translate as never, role)),
      ...['SUNNY', 'CLOUDY', 'RAIN', 'HEAVY_RAIN', 'STORM', 'HOT', 'COLD'].map((code) => weatherLabel(translate as never, code)),
      ...(['required', 'tooLong', 'invalidDate', 'futureDate', 'invalidNumber', 'invalidWeather', 'certSerial'] as const).map((item) => formProblemMessage(translate as never, item)),
      ...(['diaryState', 'correctionOpen', 'contentChanged', 'dayExists', 'syncConflict', 'alreadySigned', 'methodNotAccepted', 'notYourRole', 'contractState', 'permitGate', 'versionConflict', 'validation', 'notFound', 'denied', 'session', 'general'] as const).map((item) =>
        problemMessage(translate as never, item),
      ),
    ];
    expect(words.filter((entry) => entry.startsWith('MISSING:'))).toEqual([]);
    expect(new Set(words).size).toBeGreaterThan(30);
    expect(weatherLabel(translate as never, 'FOG')).toBe('FOG');
  });

  it('does not call an in-app confirmation a digital signature (BR-QMS-03)', () => {
    expect(effectLabel(translate as never, 'INTERNAL_RECORD')).toBe(vi_['qms.diary.effect.internal']);
    expect(effectLabel(translate as never, 'LEGAL_E_SIGNATURE')).toBe(vi_['qms.diary.effect.legal']);
    expect(vi_['qms.diary.effect.internal']).toContain('không phải chữ ký số');
  });
});
