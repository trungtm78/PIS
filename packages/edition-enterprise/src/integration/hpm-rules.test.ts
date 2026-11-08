import { DomainError, issueKeyOf } from '@machvon/kernel';
import type { IssuedCopyRef } from '@machvon/kernel';
import {
  HPM_PACKAGE_FORMAT,
  copyRefOf,
  decideHpmPush,
  hpmAcceptance,
  hpmConnectionMove,
  hpmCopyRequestOf,
  hpmCorrectionDecision,
  hpmCorrectionRequestOf,
  hpmHealthOf,
  hpmKeyOf,
  hpmPeriodRange,
  hpmPolicyParamsOf,
  hpmRangesTouch,
  hpmReasonOf,
  hpmReceiptMove,
  hpmReferenceOf,
  hpmRequestHash,
  isHpmPeriod,
} from './hpm-rules.ts';
import type { HpmCopyRequest, HpmLedgerEntry, HpmPushContext } from './hpm-rules.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const REOPEN_ID = '33333333-3333-4333-8333-333333333333';

const body = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ layout_code: 'HPM-MONTHLY', period: '2026-M10', revision: 1, sha256: SHA_A, file_object_key: 'tenants/t/report_export/x', ...patch });
const request = (patch: Record<string, unknown> = {}): HpmCopyRequest => hpmCopyRequestOf(body(patch), ORG);
const ref = (patch: Partial<IssuedCopyRef> = {}): IssuedCopyRef => ({ id: 'copy', orgId: ORG, layoutCode: 'HPM-MONTHLY', layoutVersion: '', period: '2026-M10', revision: 1, supersedes: null, sha256: SHA_A, snapshot: null, ...patch });

const failure = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('the request of a push', () => {
  it('reads a request and defaults the organisation to the tenant', () => {
    const read = request();
    expect(read).toMatchObject({ orgId: ORG, layoutCode: 'HPM-MONTHLY', period: '2026-M10', revision: 1, sha256: SHA_A, snapshot: null, marks: null, correctionId: null });
  });

  it('keeps the snapshot revision, the marks of a demo form and the correction', () => {
    const read = request({ snapshot: { snapshot_id: SNAPSHOT_ID, revision: 2, cutoff: '2026-10-31' }, marks: { form_status: 'DEMO', demo_mark: 'DEMO' }, correction_id: REOPEN_ID, org_unit_id: ORG.toUpperCase() });
    expect(read.snapshot).toEqual({ snapshotId: SNAPSHOT_ID, revision: 2, cutoff: '2026-10-31' });
    expect(read.marks).toEqual({ formStatus: 'DEMO', demoMark: 'DEMO' });
    expect(read.correctionId).toBe(REOPEN_ID);
    expect(read.orgId).toBe(ORG);
  });

  it.each([
    ['layout_code', { layout_code: 'bad code' }],
    ['period', { period: '2026-13' }],
    ['revision', { revision: 0 }],
    ['revision', { revision: 1.5 }],
    ['sha256', { sha256: 'xyz' }],
    ['file_object_key', { file_object_key: ' ' }],
    ['snapshot.revision', { snapshot: { snapshot_id: SNAPSHOT_ID, revision: 0, cutoff: '2026-10-31' } }],
    ['snapshot.cutoff', { snapshot: { snapshot_id: SNAPSHOT_ID, revision: 1, cutoff: 'soon' } }],
    ['marks.form_status', { marks: { form_status: 'OFFICIAL' } }],
    ['correction_id', { correction_id: 'nope' }],
    ['org_unit_id', { org_unit_id: 'nope' }],
  ])('refuses %s', (field, patch) => {
    const error = failure(() => request(patch));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.detail).toBe(field);
  });

  it('recognises the periods the kernel writes', () => {
    for (const period of ['2026', '2026-Q3', '2026-H2', '2026-M01', '2026-10-31']) expect(isHpmPeriod(period)).toBe(true);
    for (const period of ['26', '2026-M13', '2026-Q5', '2026-H3', '2026-13-01', 7]) expect(isHpmPeriod(period)).toBe(false);
  });

  it('says which days a period covers, leap years included', () => {
    expect(hpmPeriodRange('2026-M10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(hpmPeriodRange('2024-M02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(hpmPeriodRange('2026-M02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(hpmPeriodRange('2026-Q3')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(hpmPeriodRange('2026-H1')).toEqual({ from: '2026-01-01', to: '2026-06-30' });
    expect(hpmPeriodRange('2026-H2')).toEqual({ from: '2026-07-01', to: '2026-12-31' });
    expect(hpmPeriodRange('2026')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(hpmPeriodRange('2026-10-31')).toEqual({ from: '2026-01-01', to: '2026-10-31' });
    expect(hpmPeriodRange('nonsense')).toBeUndefined();
  });

  it('tells whether a reopened range touches the days of a report period', () => {
    const october = { from: '2026-10-01', to: '2026-10-31' };
    expect(hpmRangesTouch({ from: '2026-10-10', to: '2026-10-16' }, october)).toBe(true);
    expect(hpmRangesTouch({ from: '2026-09-28', to: '2026-10-04' }, october)).toBe(true);
    expect(hpmRangesTouch({ from: '2026-10-31', to: '2026-11-06' }, october)).toBe(true);
    expect(hpmRangesTouch({ from: '2026-09-01', to: '2026-09-30' }, october)).toBe(false);
    expect(hpmRangesTouch({ from: '2026-11-01', to: '2026-11-07' }, october)).toBe(false);
  });
});

describe('the key and the hash of a push', () => {
  it('is the key of the kernel for an issued copy: organisation, layout, period, revision', () => {
    const read = request();
    expect(hpmKeyOf(read)).toBe(issueKeyOf(read));
    expect(hpmKeyOf(read)).toBe(`${ORG}|HPM-MONTHLY|2026-M10|r1`);
  });

  it('changes with the content but never with the file key or the order of the fields', () => {
    const first = hpmRequestHash(request());
    expect(hpmRequestHash(request({ file_object_key: 'tenants/t/report_export/other' }))).toBe(first);
    expect(hpmRequestHash(request({ sha256: SHA_B }))).not.toBe(first);
    expect(hpmRequestHash(request({ snapshot: { snapshot_id: SNAPSHOT_ID, revision: 1, cutoff: '2026-10-31' } }))).not.toBe(first);
    expect(hpmRequestHash(request({ marks: { form_status: 'DEMO' } }))).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds the copy of the kernel from the request', () => {
    const read = request({ snapshot: { snapshot_id: SNAPSHOT_ID, revision: 3, cutoff: '2026-10-31' }, marks: { form_status: 'DEMO', demo_mark: 'D' } });
    const copy = copyRefOf(read, 'id-1', null);
    expect(copy).toMatchObject({ id: 'id-1', orgId: ORG, revision: 1, supersedes: null, sha256: SHA_A, snapshot: { revision: 3 }, marks: { formStatus: 'DEMO' } });
    expect(copyRefOf(request(), 'id-2', null).marks).toBeUndefined();
  });
});

const base = (patch: Partial<HpmPushContext> = {}): HpmPushContext => ({
  intent: 'SUBMIT',
  copy: ref(),
  head: ref(),
  accepted: null,
  existing: null,
  requestHash: hpmRequestHash(request()),
  overwrite: { periodReopened: false, correctionApproved: false },
  maxAttempts: 3,
  ...patch,
});

const entry = (patch: Partial<HpmLedgerEntry> = {}): HpmLedgerEntry => ({ requestHash: hpmRequestHash(request()), status: 'FAILED', attempts: 1, ...patch });

describe('what a push does (R8, R17)', () => {
  it('sends a first push as attempt 1 without overwriting anything', () => {
    expect(decideHpmPush(base())).toEqual({ action: 'SEND', attempt: 1, overwrites: false });
  });

  it('re-sends a failed push under the same key with the next attempt number', () => {
    expect(decideHpmPush(base({ intent: 'RETRY', existing: entry({ status: 'FAILED', attempts: 2 }) }))).toEqual({ action: 'SEND', attempt: 3, overwrites: false });
  });

  it('stops retrying at the cap', () => {
    expect(failure(() => decideHpmPush(base({ intent: 'RETRY', existing: entry({ status: 'FAILED', attempts: 3 }) }))).code).toBe('HPM_RETRY_EXHAUSTED');
  });

  it('refuses the same key with other content', () => {
    const error = failure(() => decideHpmPush(base({ existing: entry({ requestHash: 'f'.repeat(64) }) })));
    expect(error).toMatchObject({ code: 'HPM_KEY_REUSED', status: 409 });
  });

  it('answers ALREADY_DELIVERED for a repeat of a package that was written or accepted, without a new attempt', () => {
    expect(decideHpmPush(base({ existing: entry({ status: 'WRITTEN', attempts: 1 }) }))).toEqual({ action: 'ALREADY_DELIVERED' });
    expect(decideHpmPush(base({ existing: entry({ status: 'ACCEPTED', attempts: 1 }), accepted: ref() }))).toEqual({ action: 'ALREADY_DELIVERED' });
    expect(decideHpmPush(base({ existing: entry({ status: 'ACCEPTED', attempts: 1 }), accepted: ref(), intent: 'RETRY' }))).toEqual({ action: 'ALREADY_DELIVERED' });
  });

  it('refuses the repeat of a package a newer revision replaced, accepted or written, before it answers ALREADY_DELIVERED', () => {
    const newer = ref({ revision: 2, sha256: SHA_B });
    for (const status of ['ACCEPTED', 'WRITTEN'] as const) {
      const error = failure(() => decideHpmPush(base({ copy: ref(), head: newer, accepted: newer, existing: entry({ status, attempts: 1 }) })));
      expect(error).toMatchObject({ code: 'REPORT_OUT_OF_DATE', extensions: { current_revision: 2 } });
    }
  });

  it('lets a retry re-send a package that was written and waits for a receipt', () => {
    expect(decideHpmPush(base({ intent: 'RETRY', existing: entry({ status: 'WRITTEN', attempts: 1 }) }))).toEqual({ action: 'SEND', attempt: 2, overwrites: false });
  });

  it('never re-sends a push the receiver rejected: a correction is a new revision', () => {
    expect(failure(() => decideHpmPush(base({ existing: entry({ status: 'REJECTED' }) }))).code).toBe('HPM_PUSH_STATE_INVALID');
  });

  it('refuses a copy older than the newest copy of the series as out of date, naming the current revision', () => {
    const error = failure(() => decideHpmPush(base({ copy: ref({ revision: 1 }), head: ref({ revision: 2, sha256: SHA_B }) })));
    expect(error).toMatchObject({ code: 'REPORT_OUT_OF_DATE', status: 409 });
    expect(error.extensions).toEqual({ current_revision: 2 });
  });

  it('refuses a copy older than what the receiver accepted, even when nothing newer is known', () => {
    const accepted = ref({ revision: 3, sha256: SHA_C });
    const error = failure(() => decideHpmPush(base({ copy: ref({ revision: 2, sha256: SHA_B }), head: ref({ revision: 2, sha256: SHA_B }), accepted })));
    expect(error.code).toBe('REPORT_OUT_OF_DATE');
  });

  it('says ALREADY_DELIVERED for the same bytes as the accepted revision', () => {
    expect(decideHpmPush(base({ accepted: ref() }))).toEqual({ action: 'ALREADY_DELIVERED' });
  });

  it('refuses other bytes under the accepted revision as out of date (nothing is overwritten in place)', () => {
    const error = failure(() => decideHpmPush(base({ copy: ref({ sha256: SHA_B }), head: ref({ sha256: SHA_B }), accepted: ref() })));
    expect(error.code).toBe('REPORT_OUT_OF_DATE');
  });

  it('does not let a newer revision replace an accepted period without a reopened period and an approved correction, and names what is missing', () => {
    const newer = ref({ revision: 2, sha256: SHA_B });
    const none = failure(() => decideHpmPush(base({ copy: newer, head: newer, accepted: ref() })));
    expect(none.code).toBe('HPM_OVERWRITE_NOT_AUTHORISED');
    expect(none.extensions).toEqual({ missing: ['PERIOD_REOPENED', 'APPROVED_CORRECTION'], accepted_revision: 1 });
    const reopenedOnly = failure(() => decideHpmPush(base({ copy: newer, head: newer, accepted: ref(), overwrite: { periodReopened: true, correctionApproved: false } })));
    expect(reopenedOnly.extensions).toEqual({ missing: ['APPROVED_CORRECTION'], accepted_revision: 1 });
    const approvedOnly = failure(() => decideHpmPush(base({ copy: newer, head: newer, accepted: ref(), overwrite: { periodReopened: false, correctionApproved: true } })));
    expect(approvedOnly.extensions).toEqual({ missing: ['PERIOD_REOPENED'], accepted_revision: 1 });
  });

  it('lets a newer revision replace an accepted period with both', () => {
    const newer = ref({ revision: 2, sha256: SHA_B });
    expect(decideHpmPush(base({ copy: newer, head: newer, accepted: ref(), overwrite: { periodReopened: true, correctionApproved: true } }))).toEqual({ action: 'SEND', attempt: 1, overwrites: true });
  });

  it('does not count a copy made on a DEMO form as an acceptance: it holds nothing back and needs nothing to be replaced', () => {
    const demo = ref({ marks: { formStatus: 'DEMO', demoMark: 'DEMO' } });
    const newer = ref({ revision: 2, sha256: SHA_B });
    expect(decideHpmPush(base({ copy: newer, head: newer, accepted: demo }))).toEqual({ action: 'SEND', attempt: 1, overwrites: false });
  });
});

describe('the receipt of the receiver (R18)', () => {
  const written = { status: 'WRITTEN' as const, pushedBy: 'pusher', marks: null };

  it('is recorded by somebody other than the pusher', () => {
    expect(failure(() => hpmReceiptMove(written, { outcome: 'ACCEPTED', actorId: 'pusher', reference: 'HPM-1', note: null })).code).toBe('SELF_APPROVAL_DENIED');
    expect(hpmReceiptMove(written, { outcome: 'ACCEPTED', actorId: 'other', reference: ' HPM-1 ', note: null })).toEqual({ to: 'ACCEPTED', reference: 'HPM-1', note: null });
  });

  it('needs a package that was written', () => {
    for (const status of ['PENDING', 'FAILED', 'ACCEPTED', 'REJECTED'] as const) expect(failure(() => hpmReceiptMove({ ...written, status }, { outcome: 'ACCEPTED', actorId: 'other', reference: 'R', note: null })).code).toBe('HPM_PUSH_STATE_INVALID');
  });

  it('needs a reference, an outcome and, for a rejection, a note of ten characters', () => {
    expect(failure(() => hpmReceiptMove(written, { outcome: 'MAYBE', actorId: 'other', reference: 'R', note: null })).detail).toBe('outcome');
    expect(failure(() => hpmReceiptMove(written, { outcome: 'ACCEPTED', actorId: 'other', reference: '', note: null })).detail).toBe('reference');
    expect(failure(() => hpmReceiptMove(written, { outcome: 'REJECTED', actorId: 'other', reference: 'R', note: 'short' })).detail).toBe('note');
    expect(hpmReceiptMove(written, { outcome: 'REJECTED', actorId: 'other', reference: 'R', note: 'the totals do not add up' })).toEqual({ to: 'REJECTED', reference: 'R', note: 'the totals do not add up' });
  });

  it('never records a copy made on a DEMO form as accepted', () => {
    const demo = { ...written, marks: { formStatus: 'DEMO' as const, demoMark: 'DEMO' } };
    const error = failure(() => hpmReceiptMove(demo, { outcome: 'ACCEPTED', actorId: 'other', reference: 'R', note: null }));
    expect(error).toMatchObject({ code: 'TEMPLATE_UNCONFIRMED', detail: 'demo_not_acceptable' });
    expect(hpmReceiptMove(demo, { outcome: 'REJECTED', actorId: 'other', reference: 'R', note: 'this is only a demo form' }).to).toBe('REJECTED');
  });
});

describe('the correction that lets an accepted period be replaced', () => {
  const proposal = { layout_code: 'HPM-MONTHLY', period: '2026-M10', from_revision: 1, period_reopen_id: REOPEN_ID.toUpperCase(), reason: 'a late invoice changed the executed value' };

  it('reads a proposal', () => {
    expect(hpmCorrectionRequestOf(proposal)).toEqual({ layoutCode: 'HPM-MONTHLY', period: '2026-M10', fromRevision: 1, periodReopenId: REOPEN_ID, reason: 'a late invoice changed the executed value' });
  });

  it.each([
    ['layout_code', { layout_code: 'x' }],
    ['period', { period: 'later' }],
    ['from_revision', { from_revision: 0 }],
    ['period_reopen_id', { period_reopen_id: 'abc' }],
    ['reason', { reason: 'short' }],
  ])('refuses %s', (field, patch) => {
    expect(failure(() => hpmCorrectionRequestOf({ ...proposal, ...patch })).detail).toBe(field);
  });

  it('is decided by somebody other than the proposer, once, with a reason', () => {
    const proposed = { state: 'PROPOSED' as const, proposedBy: 'maker' };
    expect(failure(() => hpmCorrectionDecision(proposed, { decision: 'APPROVE', actorId: 'maker', reason: 'looks right to me' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(failure(() => hpmCorrectionDecision({ ...proposed, state: 'APPROVED' }, { decision: 'APPROVE', actorId: 'checker', reason: 'looks right to me' })).code).toBe('HPM_CORRECTION_STATE_INVALID');
    expect(failure(() => hpmCorrectionDecision(proposed, { decision: 'SHRUG', actorId: 'checker', reason: 'looks right to me' })).detail).toBe('decision');
    expect(failure(() => hpmCorrectionDecision(proposed, { decision: 'REJECT', actorId: 'checker', reason: 'no' })).detail).toBe('reason');
    expect(hpmCorrectionDecision(proposed, { decision: 'APPROVE', actorId: 'checker', reason: 'the invoice is attached' })).toEqual({ to: 'APPROVED', reason: 'the invoice is attached' });
    expect(hpmCorrectionDecision(proposed, { decision: 'REJECT', actorId: 'checker', reason: 'the period stays as accepted' }).to).toBe('REJECTED');
  });
});

describe('the connection and its health', () => {
  const params = { max_attempts: 5, warn_after_hours: 720, max_age_hours: 1080, stale_severity: 'ACTION' as const };
  const now = new Date('2026-11-08T00:00:00Z');
  const hoursAgo = (hours: number): Date => new Date(now.getTime() - hours * 3_600_000);
  const health = (patch: Partial<Parameters<typeof hpmHealthOf>[0]> = {}) => hpmHealthOf({ lastDeliveryAt: hoursAgo(10), now, params, failedPushes: 0, awaitingReceipt: 0, enabled: true, ...patch });

  it('switches with a reason and refuses a move to the state it is in', () => {
    expect(hpmConnectionMove({ enabled: true }, { enabled: false, reason: 'the platform is down for a week' })).toEqual({ enabled: false, reason: 'the platform is down for a week' });
    expect(failure(() => hpmConnectionMove({ enabled: true }, { enabled: true, reason: 'the platform is down' })).detail).toBe('enabled');
    expect(failure(() => hpmConnectionMove({ enabled: true }, { enabled: 'no', reason: 'the platform is down' })).detail).toBe('enabled');
    expect(failure(() => hpmConnectionMove({ enabled: true }, { enabled: false, reason: 'short' })).detail).toBe('reason');
  });

  it('is FRESH, AGING or STALE by the age of the last delivery, and always PENDING_EXTERNAL', () => {
    expect(health()).toMatchObject({ status: 'FRESH', alert: null, acceptance: 'PENDING_EXTERNAL' });
    expect(health({ lastDeliveryAt: hoursAgo(800) })).toMatchObject({ status: 'AGING', alert: null });
    expect(health({ lastDeliveryAt: hoursAgo(2000) })).toMatchObject({ status: 'STALE', alert: { code: 'HPM_PUSH_STALE', severity: 'ACTION' } });
  });

  it('raises the failed alert first when a push failed and nobody retried it', () => {
    expect(health({ failedPushes: 2 })).toMatchObject({ failedPushes: 2, alert: { code: 'HPM_PUSH_FAILED' } });
    expect(health({ lastDeliveryAt: hoursAgo(2000), failedPushes: 1 }).alert?.code).toBe('HPM_PUSH_FAILED');
  });

  it('does not nag a tenant that never pushed, nor one that switched the connection off', () => {
    expect(health({ lastDeliveryAt: null })).toMatchObject({ status: 'NEVER_PUSHED', ageHours: null, alert: null });
    expect(health({ lastDeliveryAt: null, failedPushes: 1 }).alert?.code).toBe('HPM_PUSH_FAILED');
    expect(health({ lastDeliveryAt: hoursAgo(2000), failedPushes: 3, enabled: false }).alert).toBeNull();
    expect(health({ lastDeliveryAt: null, failedPushes: 3, enabled: false }).alert).toBeNull();
  });

  it('says a working-assumption package format cannot be accepted yet', () => {
    expect(hpmAcceptance(HPM_PACKAGE_FORMAT)).toBe('PENDING_EXTERNAL');
    expect(hpmAcceptance('HPM-PACKAGE-2027.1')).toBe('ACCEPTABLE');
  });

  it('reads the numbers of the rule and refuses a malformed rule', () => {
    expect(hpmPolicyParamsOf({ max_attempts: 5, warn_after_hours: 720, max_age_hours: 1080, stale_severity: 'WATCH' })).toEqual({ max_attempts: 5, warn_after_hours: 720, max_age_hours: 1080, stale_severity: 'WATCH' });
    expect(() => hpmPolicyParamsOf({ max_attempts: 0, warn_after_hours: 1, max_age_hours: 2, stale_severity: 'WATCH' })).toThrow('max_attempts');
    expect(() => hpmPolicyParamsOf({ max_attempts: 1, warn_after_hours: 1, max_age_hours: 2, stale_severity: 'LOUD' })).toThrow('stale_severity');
  });

  it('judges reasons and references', () => {
    expect(hpmReasonOf('  a reason that is long enough  ')).toBe('a reason that is long enough');
    expect(failure(() => hpmReasonOf(7)).detail).toBe('reason');
    expect(failure(() => hpmReasonOf('control\u0007 characters here')).detail).toBe('reason');
    expect(hpmReferenceOf(' HPM/2026/1 ', 'reference')).toBe('HPM/2026/1');
    expect(failure(() => hpmReferenceOf('two\nlines', 'reference')).detail).toBe('reference');
    expect(failure(() => hpmReferenceOf(3, 'reference')).detail).toBe('reference');
  });
});
