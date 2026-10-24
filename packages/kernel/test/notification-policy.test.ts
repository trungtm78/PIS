import {
  CONSENT_CHANNELS,
  CONSENT_DECISION_TABLE,
  CONSENT_PURPOSES,
  PREFERENCE_CHANNELS,
  consentAllows,
  consentPurposeOf,
  consentRequirement,
  eventCategoryOf,
  isQuietHoursChannel,
  isValidTimeZone,
  parseClock,
  preferenceChannelOf,
  quietHoursAt,
} from '../src/notification-policy.ts';

const NIGHT = { start: '21:00', end: '07:00' };
const VIETNAM = { ...NIGHT, timeZone: 'Asia/Ho_Chi_Minh' };
const TOKYO = { ...NIGHT, timeZone: 'Asia/Tokyo' };

describe('the names of channels and purposes', () => {
  it('maps the delivery channels of the engine to the channels of a preference or a consent', () => {
    expect(['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH_FCM', 'PUSH_APNS', 'ZALO_OA', 'ZALO_ZNS'].map(preferenceChannelOf)).toEqual(['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH', 'PUSH', 'ZALO', 'ZALO']);
    expect(preferenceChannelOf('FAX')).toBeUndefined();
    expect(PREFERENCE_CHANNELS).toEqual(['IN_APP', 'EMAIL', 'PUSH', 'SMS', 'ZALO', 'WHATSAPP']);
    expect(CONSENT_CHANNELS).not.toContain('IN_APP');
  });

  it('takes the category of an event type from its first segment', () => {
    expect(['report.overdue', 'guarantee.expiring', 'deadline'].map(eventCategoryOf)).toEqual(['report', 'guarantee', 'deadline']);
  });

  it('says which channels quiet hours disturb: the ones that interrupt the person', () => {
    expect(['PUSH_FCM', 'PUSH_APNS', 'SMS', 'ZALO_OA', 'ZALO_ZNS', 'WHATSAPP'].every(isQuietHoursChannel)).toBe(true);
    expect(['IN_APP', 'EMAIL', 'FAX'].some(isQuietHoursChannel)).toBe(false);
  });

  it('covers a security or digest message with the consent of the purpose it belongs to', () => {
    expect(['OPERATIONAL', 'SECURITY', 'REMINDER', 'ANNOUNCEMENT', 'DIGEST', 'SUPPORT_CONVERSATION'].map(consentPurposeOf)).toEqual([
      'OPERATIONAL',
      'OPERATIONAL',
      'REMINDER',
      'ANNOUNCEMENT',
      'ANNOUNCEMENT',
      'SUPPORT_CONVERSATION',
    ]);
    expect(consentPurposeOf('MARKETING')).toBeUndefined();
    expect(CONSENT_PURPOSES).toHaveLength(4);
  });
});

describe('the consent decision table (BR-NOT-07)', () => {
  it('needs no consent for the inbox, whatever the purpose', () => {
    expect(['OPERATIONAL', 'ANNOUNCEMENT', 'SECURITY'].map((purpose) => consentRequirement('IN_APP', purpose))).toEqual(['NONE', 'NONE', 'NONE']);
  });

  it('needs no consent for the duty messages on a push but needs it for an announcement', () => {
    expect(['OPERATIONAL', 'REMINDER', 'SECURITY'].map((purpose) => consentRequirement('PUSH', purpose))).toEqual(['NONE', 'NONE', 'NONE']);
    expect(['ANNOUNCEMENT', 'DIGEST', 'SUPPORT_CONVERSATION'].map((purpose) => consentRequirement('PUSH', purpose))).toEqual(['CONSENT', 'CONSENT', 'CONSENT']);
  });

  it('needs consent for every purpose on e-mail, SMS, Zalo and WhatsApp', () => {
    for (const channel of ['EMAIL', 'SMS', 'ZALO', 'WHATSAPP'] as const) {
      expect(['OPERATIONAL', 'REMINDER', 'SECURITY', 'ANNOUNCEMENT', 'DIGEST'].map((purpose) => consentRequirement(channel, purpose))).toEqual(Array(5).fill('CONSENT'));
    }
  });

  it('needs consent for a channel nothing knows: a message the table does not cover is never sent on trust', () => {
    expect(consentRequirement(undefined, 'OPERATIONAL')).toBe('CONSENT');
    expect(consentRequirement('PUSH', 'SOMETHING_NEW')).toBe('CONSENT');
  });

  it('has a row for every channel a preference can name', () => {
    expect(new Set(CONSENT_DECISION_TABLE.map((row) => row.channel))).toEqual(new Set(PREFERENCE_CHANNELS));
  });

  it('lets the latest consent decide: only a Granted one allows, and no consent at all is none', () => {
    expect(consentAllows('NONE', undefined)).toBe(true);
    expect(consentAllows('CONSENT', undefined)).toBe(false);
    expect(consentAllows('CONSENT', { status: 'Granted' })).toBe(true);
    expect(consentAllows('CONSENT', { status: 'Withdrawn' })).toBe(false);
    expect(consentAllows('CONSENT', { status: 'Expired' })).toBe(false);
  });
});

describe('clock times and time zones', () => {
  it.each([
    ['00:00', 0],
    ['07:30', 450],
    ['23:59', 1439],
  ])('reads %s as %i minutes', (text, minutes) => {
    expect(parseClock(text)).toBe(minutes);
  });

  it.each(['24:00', '29:00', '7:00', '07:60', '', 'ab:cd', '07:00:00'])('rejects the clock time %p', (text) => {
    expect(parseClock(text)).toBeUndefined();
  });

  it('knows an IANA zone from anything else', () => {
    expect(['Asia/Ho_Chi_Minh', 'Asia/Tokyo', 'America/New_York', 'UTC'].every(isValidTimeZone)).toBe(true);
    expect(['', 'Mars/Olympus', 'GMT+7 please', 'x'.repeat(65)].some(isValidTimeZone)).toBe(false);
  });
});

describe('quiet hours on the wall clock of the person (BR-NOT-08)', () => {
  it('does not hold a message at 20:30 in Vietnam but holds it at 22:30 in Tokyo, until 07:00 there (UAT-AC185)', () => {
    const event = new Date('2026-10-22T13:30:00Z');
    expect(quietHoursAt(event, VIETNAM)).toEqual({ quiet: false });
    const tokyo = quietHoursAt(event, TOKYO);
    expect(tokyo.quiet).toBe(true);
    expect(tokyo.endsAt?.toISOString()).toBe('2026-10-22T22:00:00.000Z');
  });

  it('holds a message at 22:30 until 07:00 of the next morning (UAT-AC27)', () => {
    const verdict = quietHoursAt(new Date('2026-10-22T15:30:00Z'), VIETNAM);
    expect(verdict.quiet).toBe(true);
    expect(verdict.endsAt?.toISOString()).toBe('2026-10-23T00:00:00.000Z');
  });

  it('holds a message after midnight until the same morning', () => {
    const verdict = quietHoursAt(new Date('2026-10-22T20:30:00Z'), VIETNAM);
    expect(verdict.quiet).toBe(true);
    expect(verdict.endsAt?.toISOString()).toBe('2026-10-23T00:00:00.000Z');
  });

  it('starts at the start of the window and ends exactly at its end', () => {
    expect(quietHoursAt(new Date('2026-10-22T14:00:00Z'), VIETNAM).quiet).toBe(true);
    expect(quietHoursAt(new Date('2026-10-22T13:59:00Z'), VIETNAM).quiet).toBe(false);
    expect(quietHoursAt(new Date('2026-10-23T00:00:00Z'), VIETNAM).quiet).toBe(false);
    expect(quietHoursAt(new Date('2026-10-22T23:59:00Z'), VIETNAM).quiet).toBe(true);
  });

  it('holds a window inside one day', () => {
    const lunch = { start: '12:00', end: '13:30', timeZone: 'Asia/Ho_Chi_Minh' };
    expect(quietHoursAt(new Date('2026-10-22T05:30:00Z'), lunch).endsAt?.toISOString()).toBe('2026-10-22T06:30:00.000Z');
    expect(quietHoursAt(new Date('2026-10-22T06:30:00Z'), lunch).quiet).toBe(false);
    expect(quietHoursAt(new Date('2026-10-22T04:59:00Z'), lunch).quiet).toBe(false);
  });

  it('follows the change of the clock of a zone that has one', () => {
    // New York leaves summer time on 2026-11-01: 23:00 on the 31st is still EDT, 07:00 on the 1st is EST.
    const york = { start: '22:00', end: '07:00', timeZone: 'America/New_York' };
    const verdict = quietHoursAt(new Date('2026-11-01T03:00:00Z'), york);
    expect(verdict.quiet).toBe(true);
    expect(verdict.endsAt?.toISOString()).toBe('2026-11-01T12:00:00.000Z');
  });

  it('means no quiet hours when the window is empty, malformed or in an unknown zone', () => {
    const now = new Date('2026-10-22T15:30:00Z');
    expect(quietHoursAt(now, { start: '21:00', end: '21:00', timeZone: 'Asia/Tokyo' })).toEqual({ quiet: false });
    expect(quietHoursAt(now, { start: '29:00', end: '07:00', timeZone: 'Asia/Tokyo' })).toEqual({ quiet: false });
    expect(quietHoursAt(now, { start: '21:00', end: '07:00', timeZone: 'Mars/Olympus' })).toEqual({ quiet: false });
  });
});
