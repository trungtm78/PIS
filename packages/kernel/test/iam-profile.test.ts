import { DomainError } from '../src/errors';
import { isTimeZone, maskEmail, parseProfilePatch } from '../src/iam-profile';

const refusal = (run: () => unknown): [string, number, string | undefined] | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof DomainError ? [error.code, error.status, error.detail] : undefined;
  }
  return undefined;
};

describe('the profile a person edits (ST-IAM-006)', () => {
  it('reads the fields that are present and leaves the others out', () => {
    expect(parseProfilePatch({ display_name: '  Nguyễn Văn An ' })).toEqual({ displayName: 'Nguyễn Văn An' });
    expect(parseProfilePatch({ locale: 'en-US', time_zone: 'Asia/Bangkok', phone_e164: '+84901234567' })).toEqual({ locale: 'en-US', timeZone: 'Asia/Bangkok', phoneE164: '+84901234567' });
  });

  it('writes the name in NFC, so that the same name typed two ways is one name', () => {
    const decomposed = 'Nguyễn';
    expect(parseProfilePatch({ display_name: decomposed }).displayName).toBe('Nguyễn');
  });

  it('refuses what is not acceptable, naming the field, and a body that changes nothing', () => {
    expect(refusal(() => parseProfilePatch({ display_name: 'A' }))).toEqual(['VALIDATION_FAILED', 422, 'display_name']);
    expect(refusal(() => parseProfilePatch({ display_name: ' ' }))).toEqual(['VALIDATION_FAILED', 422, 'display_name']);
    expect(refusal(() => parseProfilePatch({ display_name: 'x'.repeat(121) }))).toEqual(['VALIDATION_FAILED', 422, 'display_name']);
    expect(refusal(() => parseProfilePatch({ display_name: 'An\u0007' }))).toEqual(['VALIDATION_FAILED', 422, 'display_name']);
    expect(refusal(() => parseProfilePatch({ display_name: 7 }))).toEqual(['VALIDATION_FAILED', 422, 'display_name']);
    expect(refusal(() => parseProfilePatch({ locale: 'fr-FR' }))).toEqual(['VALIDATION_FAILED', 422, 'locale']);
    expect(refusal(() => parseProfilePatch({ time_zone: 'Mars/Olympus' }))).toEqual(['VALIDATION_FAILED', 422, 'time_zone']);
    expect(refusal(() => parseProfilePatch({ time_zone: 7 }))).toEqual(['VALIDATION_FAILED', 422, 'time_zone']);
    for (const phone of ['0901234567', '+0123456789', '+84 901 234 567', '+8490123', '+849012345678901234', 7]) expect([phone, refusal(() => parseProfilePatch({ phone_e164: phone }))]).toEqual([phone, ['VALIDATION_FAILED', 422, 'phone_e164']]);
    expect(refusal(() => parseProfilePatch({}))).toEqual(['VALIDATION_FAILED', 422, 'body']);
  });

  it('knows the time zones of the database and refuses anything else', () => {
    for (const zone of ['Asia/Ho_Chi_Minh', 'UTC', 'Europe/Paris']) expect(isTimeZone(zone)).toBe(true);
    for (const zone of ['', 'Nowhere/Land', 'Asia/Ho Chi Minh', 'x'.repeat(65), "Asia/Ho_Chi_Minh'; drop table"]) expect([zone, isTimeZone(zone)]).toEqual([zone, false]);
  });

  it('masks an email down to its first letter and its domain', () => {
    expect(maskEmail('an.nguyen@example.vn')).toBe('a***@example.vn');
    expect(maskEmail('x@example.vn')).toBe('x***@example.vn');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('@example.vn')).toBe('***');
  });
});
