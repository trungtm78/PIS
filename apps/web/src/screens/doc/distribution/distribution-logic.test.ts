import { describe, expect, it } from 'vitest';
import { describeProblem } from './problems';
import { canAcknowledge, canRetry, channelsFor, defaultChannelOf, defaultReceiptTime, instantOf, localInputOf, overrideProblem, progressOf, rowOf } from './rules';
import { toDocument, toQueuePage } from './types';
import type { DistributionRow, DocumentRecipient } from './types';
import { ApiError } from '@machvon/api-client';

const unit: DocumentRecipient = { kind: 'INTERNAL_UNIT', name: 'Planning Division', code: null, unitId: 'u1' };
const agency: DocumentRecipient = { kind: 'EXTERNAL_AGENCY', name: 'Department of Finance', code: 'SKHDT', unitId: null };

const row = (overrides: Partial<DistributionRow> = {}): DistributionRow => ({
  id: 'd1',
  recipientKind: 'EXTERNAL_AGENCY',
  recipientName: 'Department of Finance',
  recipientCode: null,
  channel: 'PAPER_HANDOVER',
  status: 'SENT',
  acknowledgementRequired: true,
  sentAt: null,
  deliveredAt: null,
  acknowledgedAt: null,
  externalRef: null,
  attempts: 1,
  errorCode: null,
  version: 1,
  ...overrides,
});

describe('the reason for issuing with an unconfirmed template', () => {
  it('is needed only for a template that is not confirmed, at least twenty characters after trimming and at most a thousand', () => {
    expect(overrideProblem(false, '')).toBeUndefined();
    expect(overrideProblem(true, '   ')).toBe('required');
    expect(overrideProblem(true, `${'x'.repeat(10)}${' '.repeat(30)}`)).toBe('tooShort');
    expect(overrideProblem(true, 'x'.repeat(20))).toBeUndefined();
    expect(overrideProblem(true, 'x'.repeat(1001))).toBe('tooLong');
  });
});

describe('the channels of a recipient', () => {
  it('offers the inbox of a unit only for a unit of this system, and defaults to the channel that needs no transport', () => {
    expect(channelsFor(unit)).toEqual(['INTERNAL', 'EMAIL', 'PAPER_HANDOVER']);
    expect(channelsFor(agency)).toEqual(['EMAIL', 'PAPER_HANDOVER']);
    expect(channelsFor({ ...unit, unitId: null })).toEqual(['EMAIL', 'PAPER_HANDOVER']);
    expect(defaultChannelOf(unit)).toBe('INTERNAL');
    expect(defaultChannelOf(agency)).toBe('PAPER_HANDOVER');
  });

  it('finds the row a recipient already has on a channel, whatever the capitals', () => {
    const rows = [row()];
    expect(rowOf(rows, { ...agency, name: ' DEPARTMENT OF FINANCE ' }, 'PAPER_HANDOVER')?.id).toBe('d1');
    expect(rowOf(rows, agency, 'EMAIL')).toBeUndefined();
    expect(rowOf(rows, unit, 'PAPER_HANDOVER')).toBeUndefined();
  });
});

describe('what a row allows and how far the document is', () => {
  it('lets a receipt be recorded on a sent or delivered row and a failed row be sent again', () => {
    expect(['PENDING', 'SENT', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED', 'CANCELLED'].map((status) => canAcknowledge(row({ status: status as DistributionRow['status'] })))).toEqual([false, true, true, false, false, false]);
    expect(canRetry(row({ status: 'FAILED' }))).toBe(true);
    expect(canRetry(row())).toBe(false);
  });

  it('counts the rows reached, acknowledged and failed', () => {
    expect(progressOf([row(), row({ status: 'DELIVERED' }), row({ status: 'ACKNOWLEDGED' }), row({ status: 'FAILED' })])).toEqual({ total: 4, reached: 2, acknowledged: 1, failed: 1 });
    expect(progressOf([])).toEqual({ total: 0, reached: 0, acknowledged: 0, failed: 0 });
  });
});

describe('times', () => {
  it('turns a local date-time into an instant, and an instant into the value of the input', () => {
    expect(instantOf('')).toBeUndefined();
    expect(instantOf('not a time')).toBeUndefined();
    expect(instantOf('2026-10-23T10:30:15')).toMatch(/^2026-10-2[23]T/);
    const at = new Date(2026, 9, 23, 10, 30);
    expect(localInputOf(at)).toBe('2026-10-23T10:30:00');
    expect(new Date(instantOf(localInputOf(at)) ?? '').getTime()).toBe(at.getTime());
    // Rounded up, never down: a receipt typed at 10:30:00.400 is 10:30:01.
    expect(new Date(instantOf(localInputOf(new Date(at.getTime() + 400))) ?? '').getTime()).toBe(at.getTime() + 1000);
  });

  it('types a receipt as now at first, and never before the row was sent or delivered', () => {
    const now = new Date('2026-10-23T10:00:00.000Z');
    expect(defaultReceiptTime(row(), now)).toEqual(now);
    expect(defaultReceiptTime(row({ sentAt: '2026-10-23T09:00:00.000Z' }), now)).toEqual(now);
    expect(defaultReceiptTime(row({ sentAt: '2026-10-23T10:00:00.500Z', deliveredAt: '2026-10-23T10:00:00.700Z' }), now)).toEqual(new Date('2026-10-23T10:00:00.700Z'));
  });
});

describe('reading the answers of the server', () => {
  it('keeps what the screen needs and falls back on safe values for what is missing', () => {
    const empty = toDocument(undefined);
    expect(empty).toMatchObject({ id: '', status: 'OTHER', recipients: [], distributions: [], rendersWatermarked: false, overrideReason: null, documentNumber: null });
    const full = toDocument({
      id: 'x',
      status: 'DELIVERED',
      version: 6,
      document_number: 3,
      renders_watermarked: true,
      recipients: [{ kind: 'WHATEVER', name: 'A', code: 'C', unit_id: 'u' }],
      distributions: [{ id: 'd', recipient_kind: 'PERSON', channel: 'FAX', status: 'LOST', acknowledgement_required: false, attempts: 'x' }],
    });
    expect(full).toMatchObject({ status: 'DELIVERED', version: 6, documentNumber: 3, rendersWatermarked: true });
    expect(full.recipients[0]).toEqual({ kind: 'EXTERNAL_AGENCY', name: 'A', code: 'C', unitId: 'u' });
    expect(full.distributions[0]).toMatchObject({ recipientKind: 'PERSON', channel: 'PAPER_HANDOVER', status: 'PENDING', acknowledgementRequired: false, attempts: 0 });
    expect(toQueuePage({ items: [{ id: 'q', title: 'T', status: 'SEALED' }, 7], next_cursor: 'next' })).toMatchObject({ nextCursor: 'next', items: [{ id: 'q', status: 'SEALED' }, { id: '', status: 'OTHER' }] });
    expect(toQueuePage(null)).toEqual({ items: [], nextCursor: undefined });
  });

  it('reads a failure by its code and by the command it belongs to', () => {
    const error = (code: string, status: number, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });
    expect(describeProblem(new Error('x'), 'issue')).toEqual({ reason: 'general', field: undefined, findings: [] });
    expect(describeProblem(error('PROVIDER_UNAVAILABLE', 503), 'issue').reason).toBe('revocation');
    expect(describeProblem(error('PROVIDER_UNAVAILABLE', 503), 'retry').reason).toBe('channel');
    expect(describeProblem(error('VALIDATION_FAILED', 422, {}, 'acknowledged_at'), 'acknowledge').reason).toBe('receipt');
    expect(describeProblem(error('VALIDATION_FAILED', 422, {}, 'recipients'), 'dispatch').reason).toBe('invalid');
    expect(describeProblem(error('SIGNATURE_VERIFICATION_FAILED', 422, { findings: ['A', 3, 'B'] }), 'issue')).toEqual({ reason: 'signature', field: undefined, findings: ['A', 'B'] });
    expect(describeProblem(error('SOMETHING_NEW', 500), 'issue').reason).toBe('general');
  });
});
