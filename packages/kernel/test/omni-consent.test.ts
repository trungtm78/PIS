import { assertContactConsent, identityChannelOf } from '../src/omni-consent';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const grant = (change: Record<string, unknown> = {}) => ({ channel: 'SMS', purpose: 'SUPPORT_CONVERSATION', consent_text_version: ' v2 ', capture_method: 'IN_APP', ...change });

describe('the consent of a contact (ST-OMNI-003, BR-NOT-07)', () => {
  it('takes a channel with an identity to rest on, a purpose, the version of the terms and how it was taken, and trims what it keeps', () => {
    expect(assertContactConsent(grant())).toEqual({ channel: 'SMS', purpose: 'SUPPORT_CONVERSATION', consentTextVersion: 'v2', captureMethod: 'IN_APP', evidenceReference: undefined });
    expect(assertContactConsent(grant({ channel: 'EMAIL', purpose: 'REMINDER', capture_method: 'WEB_FORM', evidence_reference: ' form-12 ' })).evidenceReference).toBe('form-12');
  });

  it('rests each channel on the identity that carries it, and takes no consent for a push, which a contact outside the tenant has no device for', () => {
    expect(identityChannelOf('EMAIL')).toBe('EMAIL');
    expect(identityChannelOf('SMS')).toBe('PHONE');
    expect(identityChannelOf('ZALO')).toBe('ZALO');
    expect(identityChannelOf('WHATSAPP')).toBe('WHATSAPP');
    expect(identityChannelOf('PUSH')).toBeUndefined();
    expect(refusal(() => assertContactConsent(grant({ channel: 'PUSH' })))).toEqual({ code: 'VALIDATION_FAILED', detail: 'channel', status: 422 });
  });

  it('refuses a channel, a purpose or a way of capture that does not exist, and a version of the terms that is empty or too long', () => {
    expect(refusal(() => assertContactConsent(grant({ channel: 'FAX' }))).detail).toBe('channel');
    expect(refusal(() => assertContactConsent(grant({ purpose: 'MARKETING' }))).detail).toBe('purpose');
    expect(refusal(() => assertContactConsent(grant({ capture_method: 'PHONE_CALL' }))).detail).toBe('capture_method');
    expect(refusal(() => assertContactConsent(grant({ consent_text_version: '   ' }))).detail).toBe('consent_text_version');
    expect(refusal(() => assertContactConsent(grant({ consent_text_version: 'v'.repeat(51) }))).detail).toBe('consent_text_version');
    expect(refusal(() => assertContactConsent(grant({ consent_text_version: 2 }))).detail).toBe('consent_text_version');
  });

  it('wants the reference of the proof when what was taken leaves a proof (an opt-in message, a scanned form), and refuses a reference that is empty or too long', () => {
    for (const method of ['CHANNEL_OPT_IN', 'PAPER_SCANNED']) {
      expect(refusal(() => assertContactConsent(grant({ capture_method: method }))).detail).toBe('evidence_reference');
      expect(assertContactConsent(grant({ capture_method: method, evidence_reference: 'minutes-3' })).evidenceReference).toBe('minutes-3');
    }
    expect(refusal(() => assertContactConsent(grant({ evidence_reference: '  ' }))).detail).toBe('evidence_reference');
    expect(refusal(() => assertContactConsent(grant({ evidence_reference: 'e'.repeat(501) }))).detail).toBe('evidence_reference');
  });
});
