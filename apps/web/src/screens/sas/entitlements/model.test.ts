import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_OVERRIDE_FORM, describeOverrideProblem, instantOf, mayDecide, mayRevoke, overrideBody, toOverridePage, validateOverrideForm } from './model';
import type { OverrideEntry, OverrideForm } from './model';

const NOW = new Date('2026-10-25T06:00:00Z');
const ME = '00000000-0000-4000-8000-0000000000e9';
const OTHER = '00000000-0000-4000-8000-0000000000e8';

const entry = (extra: Partial<OverrideEntry> = {}): OverrideEntry => ({
  id: 'o1',
  featureCode: 'reporting',
  enabled: false,
  limitValue: undefined,
  reason: 'a reason of ten letters',
  validFrom: '2026-10-26T00:00:00.000Z',
  validUntil: '2026-11-26T00:00:00.000Z',
  status: 'PendingApproval',
  requestedBy: OTHER,
  approvedBy: undefined,
  version: 1,
  ...extra,
});

const valid: OverrideForm = { featureCode: 'ai.analysis', enabled: false, limitValue: '', validFrom: '2026-10-26T08:00', validUntil: '2026-11-25T08:00', reason: 'Tạm dừng do vượt ngân sách AI' };

describe('SAS-25 overrides model', () => {
  it('reads a page of overrides and drops what has no id', () => {
    const page = toOverridePage({
      items: [{ id: 'a', feature_code: 'export', enabled: true, limit_value: '5', reason: 'r', valid_from: 'f', valid_until: 'u', status: 'Active', requested_by: 'x', approved_by: 'y', version: 3 }, { feature_code: 'nope' }, 7],
      next_cursor: 'c',
    });
    expect(page.items).toEqual([{ id: 'a', featureCode: 'export', enabled: true, limitValue: '5', reason: 'r', validFrom: 'f', validUntil: 'u', status: 'Active', requestedBy: 'x', approvedBy: 'y', version: 3 }]);
    expect(page.nextCursor).toBe('c');
    expect(toOverridePage(undefined)).toEqual({ items: [], nextCursor: undefined });
    expect(toOverridePage({ items: [{ id: 'b', status: 'weird', version: 'x' }], next_cursor: null }).items[0]).toMatchObject({ status: 'PendingApproval', version: 0, enabled: false });
  });

  it('offers a decision only on a request that waits and that the person did not make (UAT-AC158)', () => {
    expect(mayDecide(entry(), ME)).toBe(true);
    expect(mayDecide(entry({ requestedBy: ME }), ME)).toBe(false);
    expect(mayDecide(entry({ requestedBy: ME.toUpperCase() }), ME)).toBe(false);
    expect(mayDecide(entry({ status: 'Active' }), ME)).toBe(false);
    expect(mayDecide(entry(), undefined)).toBe(false);
  });

  it('lets an override that waits or is in force be ended, and no other', () => {
    expect(mayRevoke(entry())).toBe(true);
    expect(mayRevoke(entry({ status: 'Active' }))).toBe(true);
    for (const status of ['Revoked', 'Expired', 'Rejected'] as const) expect(mayRevoke(entry({ status }))).toBe(false);
  });

  it('reads the wall-clock text of the browser as UTC and nothing else', () => {
    expect(instantOf('2026-10-26T08:00')).toBe(Date.parse('2026-10-26T08:00:00Z'));
    expect(instantOf('2026-10-26T08:00:30')).toBe(Date.parse('2026-10-26T08:00:30Z'));
    for (const bad of ['', '2026-10-26', '26/10/2026 08:00', '2026-13-40T99:99']) expect(Number.isNaN(instantOf(bad))).toBe(true);
  });

  it('accepts a request that the server accepts and builds its body', () => {
    expect(validateOverrideForm(valid, NOW)).toEqual({});
    expect(overrideBody(valid)).toEqual({ feature_code: 'ai.analysis', enabled: false, valid_from: '2026-10-26T08:00:00.000Z', valid_until: '2026-11-25T08:00:00.000Z', reason: 'Tạm dừng do vượt ngân sách AI' });
    expect(overrideBody({ ...valid, enabled: true, limitValue: ' 150.5 ', reason: '  Tăng hạn mức tạm thời  ' })).toMatchObject({ enabled: true, limit_value: '150.5', reason: 'Tăng hạn mức tạm thời' });
  });

  it('names every problem of the form, as the server does', () => {
    expect(validateOverrideForm(EMPTY_OVERRIDE_FORM, NOW)).toEqual({ featureCode: 'required', validFrom: 'required', validUntil: 'required', reason: 'reasonLength' });
    expect(validateOverrideForm({ ...valid, validFrom: 'x', validUntil: 'y' }, NOW)).toMatchObject({ validFrom: 'notDateTime', validUntil: 'notDateTime' });
    expect(validateOverrideForm({ ...valid, enabled: true, limitValue: '12,5' }, NOW).limitValue).toBe('notNumber');
    expect(validateOverrideForm({ ...valid, enabled: false, limitValue: '5' }, NOW).limitValue).toBe('limitNeedsEnabled');
    expect(validateOverrideForm({ ...valid, validUntil: valid.validFrom }, NOW).validUntil).toBe('windowInvalid');
    expect(validateOverrideForm({ ...valid, validFrom: '2026-10-01T00:00', validUntil: '2026-10-20T00:00' }, NOW).validUntil).toBe('alreadyEnded');
    expect(validateOverrideForm({ ...valid, validFrom: '2026-10-26T00:00', validUntil: '2027-12-01T00:00' }, NOW).validUntil).toBe('tooLong');
    expect(validateOverrideForm({ ...valid, validFrom: '2027-03-01T00:00', validUntil: '2027-04-01T00:00' }, NOW).validFrom).toBe('tooFarAhead');
    expect(validateOverrideForm({ ...valid, reason: 'short' }, NOW).reason).toBe('reasonLength');
    expect(validateOverrideForm({ ...valid, reason: ' '.repeat(20) }, NOW).reason).toBe('reasonLength');
  });

  it('sorts a refusal of the server by its code', () => {
    const refusal = (code: string, detail?: string) => describeOverrideProblem(new ApiError({ status: 400, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) }));
    expect(refusal('SELF_APPROVAL_DENIED').reason).toBe('selfApproval');
    expect(refusal('FEATURE_UNKNOWN').reason).toBe('featureUnknown');
    expect(refusal('STAGE_TRANSITION_DENIED').reason).toBe('stageDenied');
    expect(refusal('VERSION_CONFLICT').reason).toBe('conflict');
    expect(refusal('VALIDATION_FAILED', 'valid_until')).toEqual({ reason: 'invalid', field: 'valid_until' });
    expect(refusal('SCOPE_DENIED').reason).toBe('denied');
    expect(refusal('RESOURCE_NOT_FOUND').reason).toBe('notFound');
    expect(refusal('SESSION_EXPIRED').reason).toBe('session');
    expect(refusal('SOMETHING_ELSE').reason).toBe('general');
    expect(describeOverrideProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
  });
});
