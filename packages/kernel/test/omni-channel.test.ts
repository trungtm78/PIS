import { assertChanges, assertConnectable, canDisableAccount, canVerifyAccount, displayNameOf, isUsable, unusableCodeOf } from '../src/omni-channel';

const base = { channel: 'WHATSAPP', externalAccountId: '104857600123', displayName: 'Hotline Zalo', credentialSecretRef: 'secret://omni/wa/token', webhookSecretRef: 'secret://omni/wa/webhook' };
const refusal = (run: () => unknown): { code: string; detail: string | undefined } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string };
    return { code: known.code, detail: known.detail };
  }
  throw new Error('it was allowed');
};

describe('connecting a channel account (ST-OMNI-001)', () => {
  it('takes references to secrets, a name and the id the provider gave, and trims them', () => {
    expect(assertConnectable({ ...base, externalAccountId: ' 104857600123 ', displayName: '  Hotline  ' })).toEqual({
      channel: 'WHATSAPP',
      externalAccountId: '104857600123',
      displayName: 'Hotline',
      credentialSecretRef: 'secret://omni/wa/token',
      webhookSecretRef: 'secret://omni/wa/webhook',
    });
  });

  it('refuses a secret written in place of its reference, so it cannot reach a log or a row', () => {
    for (const bad of ['EAAG1234token', 'https://example.test/secret', 'secret://', 'secret://with space', 'secret://' + 'a'.repeat(201), 3]) {
      expect(refusal(() => assertConnectable({ ...base, credentialSecretRef: bad }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'credential_secret_ref' });
    }
    expect(refusal(() => assertConnectable({ ...base, webhookSecretRef: 'plain-secret' }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'webhook_secret_ref' });
  });

  it('wants the webhook secret of a channel that has webhooks, gives none to a push channel, and never the same reference twice', () => {
    expect(refusal(() => assertConnectable({ ...base, webhookSecretRef: undefined })).detail).toBe('webhook_secret_ref');
    expect(refusal(() => assertConnectable({ ...base, webhookSecretRef: base.credentialSecretRef })).detail).toBe('webhook_secret_ref');
    expect(assertConnectable({ ...base, channel: 'PUSH_FCM', webhookSecretRef: undefined }).webhookSecretRef).toBeUndefined();
    expect(refusal(() => assertConnectable({ ...base, channel: 'PUSH_APNS' })).detail).toBe('webhook_secret_ref');
  });

  it('refuses a channel that does not exist, an id that is not one, and a name that is empty, long or on two lines', () => {
    expect(refusal(() => assertConnectable({ ...base, channel: 'FAX' })).detail).toBe('channel');
    for (const bad of ['', ' ', '-x', 'has space', 'a'.repeat(201), 7]) expect(refusal(() => assertConnectable({ ...base, externalAccountId: bad })).detail).toBe('external_account_id');
    for (const bad of ['', '   ', 'x'.repeat(121), 'two\nlines', 4]) expect(refusal(() => displayNameOf(bad)).detail).toBe('display_name');
  });
});

describe('changing a channel account', () => {
  it('takes the fields that were given, clears the auto reply and the calendar with an empty text, and refuses an empty change', () => {
    expect(assertChanges({ auto_reply_text: '  ', calendar_code: '' })).toEqual({ autoReplyText: null, calendarCode: null });
    expect(assertChanges({ display_name: ' New name ', auto_reply_text: 'We reply from 8:00.', calendar_code: 'VN-STD' })).toEqual({ displayName: 'New name', autoReplyText: 'We reply from 8:00.', calendarCode: 'VN-STD' });
    expect(assertChanges({ auto_reply_text: null, calendar_code: null })).toEqual({ autoReplyText: null, calendarCode: null });
    expect(refusal(() => assertChanges({}))).toEqual({ code: 'VALIDATION_FAILED', detail: 'display_name' });
  });

  it('refuses an auto reply that is longer than 500 characters, and a calendar code that is not one', () => {
    expect(refusal(() => assertChanges({ auto_reply_text: 'x'.repeat(501) })).detail).toBe('auto_reply_text');
    expect(assertChanges({ auto_reply_text: 'x'.repeat(500) }).autoReplyText).toHaveLength(500);
    expect(refusal(() => assertChanges({ calendar_code: 'has space' })).detail).toBe('calendar_code');
  });
});

describe('the life of a channel account', () => {
  it('verifies an account that is pending or whose credential expired, disables any that is not yet disabled, and uses only an Active one', () => {
    expect(['PendingVerification', 'Active', 'Disabled', 'CredentialExpired'].map((status) => canVerifyAccount(status as never))).toEqual([true, false, false, true]);
    expect(['PendingVerification', 'Active', 'Disabled', 'CredentialExpired'].map((status) => canDisableAccount(status as never))).toEqual([true, true, false, true]);
    expect(['PendingVerification', 'Active', 'Disabled', 'CredentialExpired'].map(isUsable)).toEqual([false, true, false, false]);
  });

  it('tells a closed account from one that is not verified', () => {
    expect(unusableCodeOf('Disabled')).toBe('CHANNEL_ACCOUNT_DISABLED');
    expect(unusableCodeOf('PendingVerification')).toBe('CHANNEL_UNVERIFIED');
    expect(unusableCodeOf('CredentialExpired')).toBe('CHANNEL_UNVERIFIED');
  });
});
