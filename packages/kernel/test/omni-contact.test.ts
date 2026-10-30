import { OTP_LOCK_MS, OTP_MAX_FAILURES, OTP_TTL_MS, assertContactDraft, assertMergeRequest, assertMergeable, assertVerification, generateOtp, identityHash, judgeOtp, maskIdentity, normaliseIdentity, otpHashOf } from '../src/omni-contact';
import type { MergeCase, MergeIdentity, OtpState } from '../src/omni-contact';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const NOW = new Date('2026-10-30T10:00:00.000Z');
const ID = '00000000-0000-4000-8000-0000000000a1';

describe('the contact directory (ST-OMNI-002, BR-OMNI-05)', () => {
  it('takes a name, a class and the channel the person likes best, and refuses what is not one', () => {
    expect(assertContactDraft({ display_name: '  Nguyễn Văn A ', classification: 'CITIZEN', preferred_channel: 'ZALO' })).toEqual({ displayName: 'Nguyễn Văn A', classification: 'CITIZEN', preferredChannel: 'ZALO' });
    expect(assertContactDraft({ display_name: 'B', classification: 'OTHER' }).preferredChannel).toBeUndefined();
    expect(refusal(() => assertContactDraft({ display_name: '', classification: 'CITIZEN' })).detail).toBe('display_name');
    expect(refusal(() => assertContactDraft({ display_name: 'B', classification: 'VIP' })).detail).toBe('classification');
    expect(refusal(() => assertContactDraft({ display_name: 'B', classification: 'OTHER', preferred_channel: 'FAX' })).detail).toBe('preferred_channel');
  });

  it('brings a phone number to one form whichever way it is written, and the same number gives the same hash on the phone and on WhatsApp', () => {
    for (const written of ['0900000001', '+84 900 000 001', '84900000001', '0084900000001', '(090) 000-0001']) expect(normaliseIdentity('PHONE', written)).toBe('+84900000001');
    expect(identityHash(normaliseIdentity('WHATSAPP', '0900000001'))).toBe(identityHash(normaliseIdentity('PHONE', '+84900000001')));
    expect(identityHash('+84900000001')).toMatch(/^[0-9a-f]{64}$/);
    expect(refusal(() => normaliseIdentity('PHONE', '12345'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'external_id', status: 422 });
    expect(refusal(() => normaliseIdentity('PHONE', 900000001)).detail).toBe('external_id');
  });

  it('lowercases an e-mail address, keeps a Zalo id as it is and refuses what has not the shape', () => {
    expect(normaliseIdentity('EMAIL', '  Nguyen.Van.A@Example.COM ')).toBe('nguyen.van.a@example.com');
    expect(normaliseIdentity('ZALO', 'u_123-ABC')).toBe('u_123-ABC');
    expect(refusal(() => normaliseIdentity('EMAIL', 'not-an-address')).detail).toBe('external_id');
    expect(refusal(() => normaliseIdentity('ZALO', 'has space')).detail).toBe('external_id');
  });

  it('masks an identity so that it can be recognised and not used', () => {
    expect(maskIdentity('PHONE', '+84900000001')).toBe('+84*******01');
    expect(maskIdentity('EMAIL', 'nguyen@example.com')).toBe('n***@example.com');
    expect(maskIdentity('ZALO', 'u123456789')).toBe('u1***89');
    expect(maskIdentity('PHONE', '+84900000001')).not.toContain('900000');
    // Short values do not show themselves: stars between the same characters would hide nothing.
    expect(maskIdentity('ZALO', 'abcd')).toBe('***');
    expect(maskIdentity('ZALO', 'abcde')).toBe('a***e');
    expect(maskIdentity('ZALO', 'abcdefgh')).toBe('ab***gh');
    expect(maskIdentity('EMAIL', 'a@example.com')).toBe('***@example.com');
    expect(maskIdentity('EMAIL', 'ab@example.com')).toBe('a***@example.com');
  });

  it('makes a code of six digits, with the zeros it starts with', () => {
    expect(generateOtp(() => 42)).toBe('000042');
    expect(generateOtp(() => 999_999)).toBe('999999');
  });

  describe('the code', () => {
    const fresh = (): OtpState => ({ hash: otpHashOf(ID, '123456'), expiresAt: new Date(NOW.getTime() + OTP_TTL_MS), failures: 0, lockedUntil: null });

    it('accepts the right code inside its ten minutes and refuses another, a late one and one for another identity', () => {
      expect(judgeOtp(fresh(), '123456', ID, NOW)).toEqual({ kind: 'OK' });
      expect(judgeOtp(fresh(), '654321', ID, NOW)).toEqual({ kind: 'INVALID', failures: 1, lockedUntil: undefined });
      expect(judgeOtp(fresh(), '123456', ID, new Date(NOW.getTime() + OTP_TTL_MS))).toMatchObject({ kind: 'INVALID' });
      expect(judgeOtp(fresh(), '123456', '00000000-0000-4000-8000-0000000000a2', NOW)).toMatchObject({ kind: 'INVALID' });
      expect(judgeOtp({ hash: null, expiresAt: null, failures: 0, lockedUntil: null }, '123456', ID, NOW)).toMatchObject({ kind: 'INVALID' });
    });

    it('locks the identity for 30 minutes at the fifth wrong code, answers locked whatever is sent, and starts counting again once the lock has run out', () => {
      const almost: OtpState = { ...fresh(), failures: OTP_MAX_FAILURES - 1 };
      const locked = judgeOtp(almost, '000000', ID, NOW);
      expect(locked).toEqual({ kind: 'INVALID', failures: OTP_MAX_FAILURES, lockedUntil: new Date(NOW.getTime() + OTP_LOCK_MS) });
      const until = new Date(NOW.getTime() + OTP_LOCK_MS);
      const state: OtpState = { ...fresh(), failures: OTP_MAX_FAILURES, lockedUntil: until };
      // The right code does not open a lock, and a wrong one does not extend it.
      expect(judgeOtp(state, '123456', ID, new Date(NOW.getTime() + 60_000))).toEqual({ kind: 'LOCKED', until });
      // After the lock a wrong code is the first of a new count, and the right one passes.
      const later = new Date(until.getTime() + 1);
      expect(judgeOtp({ ...state, expiresAt: new Date(later.getTime() + 60_000) }, '000000', ID, later)).toEqual({ kind: 'INVALID', failures: 1, lockedUntil: undefined });
      expect(judgeOtp({ ...state, expiresAt: new Date(later.getTime() + 60_000) }, '123456', ID, later)).toEqual({ kind: 'OK' });
    });
  });

  it('takes a verification only with what its method needs: a code of six digits, a document reference, or nothing', () => {
    expect(assertVerification({ method: 'OTP', otp: '123456' })).toEqual({ method: 'OTP', otp: '123456', documentRef: undefined });
    expect(assertVerification({ method: 'ADMIN_DOCUMENT', document_ref: ' decision-17 ' })).toEqual({ method: 'ADMIN_DOCUMENT', otp: undefined, documentRef: 'decision-17' });
    expect(assertVerification({ method: 'PROVIDER_VERIFIED' })).toEqual({ method: 'PROVIDER_VERIFIED', otp: undefined, documentRef: undefined });
    expect(refusal(() => assertVerification({ method: 'SMS' })).detail).toBe('method');
    expect(refusal(() => assertVerification({ method: 'OTP', otp: '12345' })).detail).toBe('otp');
    expect(refusal(() => assertVerification({ method: 'OTP', otp: '123456', document_ref: 'x' })).detail).toBe('document_ref');
    expect(refusal(() => assertVerification({ method: 'ADMIN_DOCUMENT' })).detail).toBe('document_ref');
    expect(refusal(() => assertVerification({ method: 'ADMIN_DOCUMENT', otp: '123456', document_ref: 'x' })).detail).toBe('otp');
    expect(refusal(() => assertVerification({ method: 'PROVIDER_VERIFIED', document_ref: 'x' })).detail).toBe('document_ref');
  });

  describe('the merge', () => {
    const identity = (id: string, contactId: string, channel: string, hash: string, status = 'Verified'): MergeIdentity => ({ id, contactId, channel, hash, status });
    const base = (): MergeCase => ({
      survivor: { id: 'A', status: 'Verified' },
      merged: { id: 'B', status: 'Verified' },
      named: identity('i1', 'A', 'PHONE', 'h1'),
      identities: [identity('i1', 'A', 'PHONE', 'h1'), identity('i2', 'B', 'WHATSAPP', 'h1'), identity('i3', 'B', 'EMAIL', 'h2')],
    });

    it('lets two contacts merge when each holds a verified identity with the same hash, whichever of them the named one belongs to', () => {
      expect(() => assertMergeable(base())).not.toThrow();
      expect(() => assertMergeable({ ...base(), named: identity('i2', 'B', 'WHATSAPP', 'h1') })).not.toThrow();
    });

    it('refuses with RECIPIENT_AMBIGUOUS when they share nothing verified, however alike their names are', () => {
      const none = { ...base(), identities: [identity('i1', 'A', 'PHONE', 'h1'), identity('i3', 'B', 'EMAIL', 'h2')] };
      expect(refusal(() => assertMergeable(none))).toEqual({ code: 'RECIPIENT_AMBIGUOUS', detail: 'shared_verified_identity_id', status: 422 });
      // The other holds the hash but has not verified it.
      const pending = { ...base(), identities: [identity('i1', 'A', 'PHONE', 'h1'), identity('i2', 'B', 'WHATSAPP', 'h1', 'Pending')] };
      expect(refusal(() => assertMergeable(pending)).code).toBe('RECIPIENT_AMBIGUOUS');
      // The identity named is not one of the two, or is not there.
      expect(refusal(() => assertMergeable({ ...base(), named: identity('i9', 'C', 'PHONE', 'h1') })).code).toBe('RECIPIENT_AMBIGUOUS');
      expect(refusal(() => assertMergeable({ ...base(), named: undefined })).code).toBe('RECIPIENT_AMBIGUOUS');
    });

    it('refuses with IDENTITY_UNVERIFIED when the identity named is not verified, and does not merge a contact into itself or one that is not live', () => {
      expect(refusal(() => assertMergeable({ ...base(), named: identity('i1', 'A', 'PHONE', 'h1', 'Pending') })).code).toBe('IDENTITY_UNVERIFIED');
      expect(refusal(() => assertMergeable({ ...base(), merged: { id: 'A', status: 'Verified' } })).detail).toBe('merged_contact_id');
      expect(refusal(() => assertMergeable({ ...base(), merged: { id: 'B', status: 'Merged' } })).code).toBe('CONTACT_STATE_INVALID');
      expect(refusal(() => assertMergeable({ ...base(), survivor: { id: 'A', status: 'Blocked' } })).code).toBe('CONTACT_STATE_INVALID');
    });

    it('takes a request with the three ids and a reason of 10 to 2000 characters', () => {
      const request = { survivor_contact_id: ID.toUpperCase(), merged_contact_id: '00000000-0000-4000-8000-0000000000a2', shared_verified_identity_id: '00000000-0000-4000-8000-0000000000a3', reason: '  the same person, two threads ' };
      expect(assertMergeRequest(request)).toEqual({ survivorId: ID, mergedId: '00000000-0000-4000-8000-0000000000a2', identityId: '00000000-0000-4000-8000-0000000000a3', reason: 'the same person, two threads' });
      expect(refusal(() => assertMergeRequest({ ...request, reason: 'short' })).detail).toBe('reason');
      expect(refusal(() => assertMergeRequest({ ...request, merged_contact_id: 'x' })).detail).toBe('merged_contact_id');
    });
  });
});
