import { DIARY_SIGNATURE_VALUE, DIARY_SIGNING_ROLE, assertDiaryContent, assertDiaryTransition, assertSignatureMethod, diaryCanonical, diaryHashOf } from '../src/index.ts';
import type { DomainError } from '../src/index.ts';

const thrown = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('did not throw');
};

const base = { contractId: '3F9A1C2E-0B4D-4D3A-9C1E-7A2C5D6E8F10', recordDate: '2026-10-20', correctionOfId: null };

describe('the content of a diary and the hash that the signatures bind (ST-QMS-001, BR-QMS-02)', () => {
  it('AC-ST-QMS-001-1: UAT-AC356 gives the same hash whatever the order the content was written in, and another hash for any change of the content, the day, the contract or the revision', () => {
    const one = diaryHashOf({ ...base, content: { b: 2, a: [1, { y: 1, x: 2 }], note: 'text' } });
    const two = diaryHashOf({ ...base, content: { note: 'text', a: [1, { x: 2, y: 1 }], b: 2 } });
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(diaryHashOf({ ...base, content: { b: 2, a: [1, { y: 1, x: 2 }], note: 'other' } })).not.toBe(one);
    expect(diaryHashOf({ ...base, recordDate: '2026-10-21', content: { b: 2, a: [1, { y: 1, x: 2 }], note: 'text' } })).not.toBe(one);
    expect(diaryHashOf({ ...base, contractId: '00000000-0000-4000-8000-000000000001', content: { b: 2, a: [1, { y: 1, x: 2 }], note: 'text' } })).not.toBe(one);
    expect(diaryHashOf({ ...base, correctionOfId: '00000000-0000-4000-8000-000000000002', content: { b: 2, a: [1, { y: 1, x: 2 }], note: 'text' } })).not.toBe(one);
    // The ids are the same ids whatever the case they were written in.
    expect(diaryHashOf({ ...base, contractId: base.contractId.toLowerCase(), content: { b: 2, a: [1, { y: 1, x: 2 }], note: 'text' } })).toBe(one);
  });

  it('writes numbers as strings, so that a number is the same number whether it came as 12 or 12.0, and a string of digits is not a number', () => {
    expect(diaryCanonical({ ...base, content: { n: 12 } })).toContain('"n":"12"');
    expect(diaryHashOf({ ...base, content: { n: 12 } })).toBe(diaryHashOf({ ...base, content: { n: 12.0 } }));
    expect(diaryCanonical({ ...base, content: { n: '12' } })).toBe(diaryCanonical({ ...base, content: { n: 12 } }));
    expect(diaryCanonical({ ...base, content: { missing: undefined, nothing: null } })).toContain('"nothing":null');
  });

  it('takes an object of at most 64 KiB, with a weather code and a workforce count when it has them, and nothing else is judged', () => {
    expect(assertDiaryContent({ summary: 'x' })).toEqual({ weatherCode: null, workforceCount: null });
    expect(assertDiaryContent({ weather_code: 'SUNNY', workforce_count: 12, equipment: ['crane'] })).toEqual({ weatherCode: 'SUNNY', workforceCount: 12 });
    expect(assertDiaryContent({ weather_code: null, workforce_count: null, note: 'x' })).toEqual({ weatherCode: null, workforceCount: null });
    for (const bad of [null, [], 'text', 5, {}, { weather_code: 'sunny' }, { weather_code: 5 }, { workforce_count: -1 }, { workforce_count: 1.5 }, { workforce_count: '12' }, { workforce_count: 2_000_000 }, { note: 'x'.repeat(70_000) }]) {
      expect([JSON.stringify(bad)?.slice(0, 30), thrown(() => assertDiaryContent(bad)).code]).toEqual([JSON.stringify(bad)?.slice(0, 30), 'VALIDATION_FAILED']);
    }
  });
});

describe('the turns of a diary (ST-QMS-001, QMS 4)', () => {
  it('AC-ST-QMS-001-1: UAT-AC356 lets each command act on the status it follows and refuses the others, so that a signed diary is not edited and a role does not sign out of its turn', () => {
    expect(assertDiaryTransition('revise', 'DRAFT')).toBe('DRAFT');
    expect(assertDiaryTransition('contractorSign', 'DRAFT')).toBe('CONTRACTOR_SIGNED');
    expect(assertDiaryTransition('supervise', 'CONTRACTOR_SIGNED')).toBe('SUPERVISED');
    expect(assertDiaryTransition('ownerConfirm', 'SUPERVISED')).toBe('OWNER_CONFIRMED');
    expect(assertDiaryTransition('lock', 'SUPERVISED')).toBe('LOCKED');
    expect(assertDiaryTransition('lock', 'OWNER_CONFIRMED')).toBe('LOCKED');
    const refused: Array<['revise' | 'contractorSign' | 'supervise' | 'ownerConfirm' | 'lock', Parameters<typeof assertDiaryTransition>[1]]> = [
      ['revise', 'CONTRACTOR_SIGNED'],
      ['revise', 'LOCKED'],
      ['contractorSign', 'CONTRACTOR_SIGNED'],
      ['contractorSign', 'SUPERSEDED'],
      ['supervise', 'DRAFT'],
      ['supervise', 'SUPERVISED'],
      ['ownerConfirm', 'CONTRACTOR_SIGNED'],
      ['ownerConfirm', 'OWNER_CONFIRMED'],
      ['lock', 'DRAFT'],
      ['lock', 'CONTRACTOR_SIGNED'],
      ['lock', 'LOCKED'],
    ];
    for (const [command, status] of refused) {
      const error = thrown(() => assertDiaryTransition(command, status));
      expect([command, status, error.code, error.status]).toEqual([command, status, 'DIARY_STATE_INVALID', 409]);
      expect(error.extensions).toMatchObject({ diary_status: status });
    }
  });

  it('knows which role signs with which command, and what an in-app signature is worth until the business confirms it', () => {
    expect(DIARY_SIGNING_ROLE).toEqual({ contractorSign: 'CONTRACTOR', supervise: 'SUPERVISOR', ownerConfirm: 'OWNER' });
    expect(DIARY_SIGNATURE_VALUE).toEqual({ cxn: 'CXN-EXE-05', awaitingConfirmation: true });
  });

  it('AC-ST-QMS-001-2: UAT-AC357 takes a certificate only with its serial, and an in-app method only without one', () => {
    expect(() => assertSignatureMethod('IN_APP_OTP', null)).not.toThrow();
    expect(() => assertSignatureMethod('IN_APP_WEBAUTHN', null)).not.toThrow();
    expect(() => assertSignatureMethod('DIGITAL_CERT', 'SN-1')).not.toThrow();
    expect(thrown(() => assertSignatureMethod('DIGITAL_CERT', null)).code).toBe('SIGNATURE_METHOD_NOT_ACCEPTED');
    expect(thrown(() => assertSignatureMethod('IN_APP_OTP', 'SN-1')).code).toBe('SIGNATURE_METHOD_NOT_ACCEPTED');
  });
});
