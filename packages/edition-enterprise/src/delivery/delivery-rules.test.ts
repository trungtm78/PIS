import { DELIVERY_BATCH, DELIVERY_MAX_ATTEMPTS, decideDelivery, deliveryDue, deliveryMessage, outcomeOf, scheduleRequestOf } from './delivery-rules.ts';
import type { IssuedHead } from './delivery-rules.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const request = (over: Record<string, unknown> = {}) => ({ layout_code: 'PVN-MONTHLY', cron: '0 8 6 * *', format: 'XLSX', recipients: [ID], note: null, ...over });
const head = (over: Partial<IssuedHead> = {}): IssuedHead => ({ id: 'issue-1', layoutCode: 'PVN-MONTHLY', periodCode: '2026-10', revision: 1, countsAsAccepted: true, issuedAt: '2026-11-07T03:00:00.000Z', xlsxSha256: 'a'.repeat(64), docxSha256: null, ...over });
const SCHEDULE_AT = '2026-11-01T00:00:00.000Z';
const decide = (over: Partial<Parameters<typeof decideDelivery>[0]> = {}) => decideDelivery({ copy: head(), format: 'XLSX', scheduleCreatedAt: SCHEDULE_AT, held: undefined, pdfAvailable: true, ...over });

describe('scheduleRequestOf', () => {
  it('takes a schedule with a form, a cron, a format, distinct recipients and a note', () => {
    expect(scheduleRequestOf(request({ recipients: [ID, ID2.toUpperCase()], note: '  Gui ban lanh dao.  ' }))).toEqual({ layoutCode: 'PVN-MONTHLY', cron: '0 8 6 * *', format: 'XLSX', recipients: [ID, ID2], note: 'Gui ban lanh dao.' });
  });

  it('names the field it refuses', () => {
    const field = (over: Record<string, unknown>): string | undefined => {
      try {
        scheduleRequestOf(request(over));
        return undefined;
      } catch (error) {
        return (error as { field?: string; details?: unknown; message?: string }).field ?? (error as Error).message;
      }
    };
    expect(field({ layout_code: 'x' })).toBeDefined();
    expect(field({ format: 'CSV' })).toBeDefined();
    expect(field({ recipients: [] })).toBeDefined();
    expect(field({ recipients: [ID, ID] })).toBeDefined();
    expect(field({ recipients: ['nobody'] })).toBeDefined();
    expect(field({ recipients: Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`) })).toBeDefined();
    expect(field({ note: '' })).toBeDefined();
    expect(field({ note: 'a'.repeat(1001) })).toBeDefined();
    expect(field({ note: 'bell\u0007' })).toBeDefined();
    expect(field({ cron: '0 8 6 *' })).toBeDefined();
    expect(field({ cron: ' 0 8 6 * *' })).toBeDefined();
  });

  it('refuses a cron the kernel cannot read as CRON_INVALID', () => {
    expect(() => scheduleRequestOf(request({ cron: '99 8 6 * *' }))).toThrow(expect.objectContaining({ code: 'CRON_INVALID' }));
  });
});

describe('deliveryDue', () => {
  const schedule = { cron: '0 8 6 * *', timezone: 'Asia/Ho_Chi_Minh', lastRunAt: null, createdAt: '2026-11-01T00:00:00.000Z' };
  it('is due once the next fire after the last run has come, in the time zone of Vietnam', () => {
    expect(deliveryDue(schedule, new Date('2026-11-05T23:59:00Z'))).toBe(false);
    expect(deliveryDue(schedule, new Date('2026-11-06T01:00:00Z'))).toBe(true);
  });

  it('is not due again after a run that took the fire', () => {
    expect(deliveryDue({ ...schedule, lastRunAt: '2026-11-06T01:00:30.000Z' }, new Date('2026-11-06T02:00:00Z'))).toBe(false);
    expect(deliveryDue({ ...schedule, lastRunAt: '2026-11-06T01:00:30.000Z' }, new Date('2026-12-06T01:00:00Z'))).toBe(true);
  });
});

describe('decideDelivery', () => {
  it('sends a copy issued after the schedule was made that nobody has been sent yet', () => {
    expect(decide()).toEqual({ kind: 'SEND' });
  });

  it('does not send the history: a copy issued before the schedule was made is done and nothing is written', () => {
    expect(decide({ copy: head({ issuedAt: '2026-10-31T23:59:59.000Z' }) })).toEqual({ kind: 'DONE' });
  });

  it('skips a copy of a DEMO form with the reason, and never sends it (R18)', () => {
    expect(decide({ copy: head({ countsAsAccepted: false }) })).toEqual({ kind: 'SKIP', reason: 'DEMO_FORM' });
  });

  it('skips a format the copy does not have: no Word narrative, no PDF made', () => {
    expect(decide({ format: 'DOCX' })).toEqual({ kind: 'SKIP', reason: 'FORMAT_UNAVAILABLE' });
    expect(decide({ format: 'DOCX', copy: head({ docxSha256: 'b'.repeat(64) }) })).toEqual({ kind: 'SEND' });
    expect(decide({ format: 'PDF', pdfAvailable: false })).toEqual({ kind: 'SKIP', reason: 'FORMAT_UNAVAILABLE' });
  });

  it('is done for a delivery that was sent, refused, skipped or is in doubt, and tries a failed one again until the attempts are used', () => {
    for (const status of ['SENDING', 'SENT', 'REFUSED', 'SKIPPED', 'UNKNOWN'] as const) expect(decide({ held: { status, attempts: 1 } })).toEqual({ kind: 'DONE' });
    expect(decide({ held: { status: 'FAILED', attempts: 1 } })).toEqual({ kind: 'SEND' });
    expect(decide({ held: { status: 'FAILED', attempts: DELIVERY_MAX_ATTEMPTS } })).toEqual({ kind: 'DONE' });
  });

  it('a correction (a later revision) is a new copy and is sent as one', () => {
    expect(decide({ copy: head({ id: 'issue-2', revision: 2 }), held: undefined })).toEqual({ kind: 'SEND' });
    expect(DELIVERY_BATCH).toBeGreaterThan(0);
  });
});

describe('outcomeOf the channel', () => {
  it('accepted is sent, with what the provider will name it by', () => {
    expect(outcomeOf({ kind: 'ACCEPTED', providerMessageId: 'm-1' })).toEqual({ status: 'SENT', errorCode: null, providerMessageId: 'm-1' });
  });

  it('a failure that may pass is failed (tried again), one for good is refused, a lost answer is unknown', () => {
    expect(outcomeOf({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'SMTP_4XX' }).status).toBe('FAILED');
    expect(outcomeOf({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'SMTP_5XX' })).toEqual({ status: 'REFUSED', errorCode: 'SMTP_5XX', providerMessageId: null });
    expect(outcomeOf({ kind: 'UNKNOWN', errorCode: 'ADAPTER_TIMEOUT' })).toEqual({ status: 'UNKNOWN', errorCode: 'ADAPTER_TIMEOUT', providerMessageId: null });
  });
});

describe('deliveryMessage', () => {
  const input = { formName: 'PVN-MONTHLY', periodCode: '2026-10', revision: 1, issuedOn: '07/11/2026', fileName: 'PVN-MONTHLY_2026-10_v1.xlsx', fileSha256: 'c'.repeat(64), note: null };

  it('carries the SHA-256 of the attached file and its name, in the subject the form, the period and the revision', () => {
    const message = deliveryMessage(input);
    expect(message.subject).toContain('PVN-MONTHLY');
    expect(message.subject).toContain('2026-10');
    expect(message.text).toContain('c'.repeat(64));
    expect(message.text).toContain('PVN-MONTHLY_2026-10_v1.xlsx');
    expect(message.text).toContain('07/11/2026');
  });

  it('says a correction replaces the earlier revision, and carries the note of the maker of the schedule', () => {
    expect(deliveryMessage(input).text).not.toContain('thay thế phiên bản trước');
    const corrected = deliveryMessage({ ...input, revision: 2, note: 'Gửi Ban lãnh đạo.' });
    expect(corrected.text).toContain('thay thế phiên bản trước');
    expect(corrected.text).toContain('Gửi Ban lãnh đạo.');
  });
});
