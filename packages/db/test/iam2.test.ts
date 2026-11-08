import { ActingStore } from '../src/iam-acting-store';
import { PeriodScopeStore } from '../src/iam-period-scope-store';
import { StandingRequestStore } from '../src/iam-standing-store';
import { DelegationStore } from '../src/delegation-store';
import type { DelegationRecord } from '../src/delegation-store';
import type { ApprovalEffects } from '../src/approval-store';
import { loadAccessIn } from '../src/effective-access-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, grantId, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const delegations = new DelegationStore();
const requests = new StandingRequestStore();
const acting = new ActingStore();
const periodScopes = new PeriodScopeStore();
const LEADER = 1;
const DELEGATE = 2;
const APPROVER = 3;
const ADMIN = 4;
const SUBJECT = 5;
const ROOT = 1;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let NOW = new Date();

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = LEADER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
/** A statement as the application role runs it: the guards of the tables apply to it (the owner role, which migrations use, passes them). */
const app = (sql: string, params: unknown[] = [], member = LEADER): Promise<unknown> => as((tx) => tx.query(sql, params), member);
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number };
    return { code: e.code ?? '', status: e.status ?? 0 };
  }
  throw new Error('expected a refusal');
}

interface Recorded {
  audits: Array<{ action: string; diff?: unknown }>;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}
const effects = (recorded: Recorded = { audits: [], events: [] }): ApprovalEffects & { recorded: Recorded } => ({
  actor: memberId(ADMIN),
  audit: (entry) => {
    recorded.audits.push({ action: entry.action, diff: entry.diff });
    return Promise.resolve();
  },
  emit: (event) => {
    recorded.events.push({ type: event.type, payload: event.payload });
    return Promise.resolve();
  },
  recorded,
});

const asked = (overrides: Record<string, unknown> = {}) => ({
  delegatorId: memberId(LEADER),
  delegateId: memberId(DELEGATE),
  permissions: ['approval.decide'],
  scopeKind: 'UNIT_SUBTREE',
  scopeRefIds: [unitId(ROOT)],
  periodCodes: undefined as string[] | undefined,
  startsAt: NOW,
  reviewDueAt: later(180 * DAY),
  endConditionKind: 'UNTIL_EVENT',
  endConditionText: 'Until the deputy director is appointed.',
  endOn: undefined as Date | undefined,
  reason: 'Standing handover of the approval of reports.',
  legalBasisRef: undefined as string | undefined,
  ...overrides,
});

/** A permanent delegation as the approval of a request makes it. */
async function standing(overrides: Record<string, unknown> = {}, now: Date = NOW): Promise<{ request: string; delegation: DelegationRecord }> {
  const input = asked(overrides);
  const request = await as((tx) => requests.insert(tx, input as Parameters<StandingRequestStore['insert']>[1]));
  const delegation = await as(async (tx) => {
    const made = await delegations.insertStanding(tx, {
      delegatorId: input.delegatorId,
      delegateId: input.delegateId,
      permissions: input.permissions,
      scopeKind: input.scopeKind,
      scopeRefIds: input.scopeRefIds,
      validFrom: input.startsAt as Date,
      reviewDueAt: input.reviewDueAt as Date,
      reason: input.reason as string,
      legalBasisRef: undefined,
      periodCodes: input.periodCodes,
      endConditionKind: input.endConditionKind as string,
      endConditionText: input.endConditionText as string,
      endOn: input.endOn,
      requestId: request.id,
      now,
    });
    await requests.approve(tx, request.id, memberId(input.delegatorId === memberId(APPROVER) ? ADMIN : APPROVER), made.id, undefined, now);
    return made;
  });
  return { request: request.id, delegation };
}

describe('IAM-2: the permanent delegation, acting on behalf and the period scope (store and tables)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const member of [LEADER, DELEGATE, APPROVER, ADMIN, SUBJECT]) await harness.seedMembership(TENANT_A, member, ROOT);
    await harness.seedRole(TENANT_A, 1, 'REPORTER', ['dis.report.submit', 'dis.report.edit'], 10);
    await harness.seedGrants(TENANT_A, [{ n: 1, member: SUBJECT, role: 1, kind: 'TENANT' }]);
    NOW = new Date();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the permanent delegation', () => {
    it('is a delegation of kind PERMANENT that works until its review date, with the end condition and the request it came from', async () => {
      const { request, delegation } = await standing();
      expect(delegation).toMatchObject({ kind: 'PERMANENT', status: 'Active', endConditionKind: 'UNTIL_EVENT', endOn: null, reviewCount: 0, requestId: request, periodCodes: null });
      expect(new Date(delegation.validUntil).getTime()).toBe(later(180 * DAY).getTime());
      const approved = await as((tx) => requests.find(tx, request));
      expect(approved).toMatchObject({ status: 'Approved', decidedBy: memberId(APPROVER), delegationId: delegation.id, version: 2 });
    });

    it('keeps the period limit it was made with, and the time-boxed one has none', async () => {
      const { delegation } = await standing({ periodCodes: ['2026-Q3', '2026-Q4'] });
      expect(delegation.periodCodes).toEqual(['2026-Q3', '2026-Q4']);
      const timeBoxed = await as((tx) =>
        delegations.insert(tx, { delegatorId: memberId(LEADER), delegateId: memberId(ADMIN), permissions: ['approval.decide'], scopeKind: 'UNIT_SUBTREE', scopeRefIds: [unitId(ROOT)], validFrom: NOW, validUntil: later(7 * DAY), reason: 'A short handover.', legalBasisRef: undefined, now: NOW }),
      );
      expect(timeBoxed).toMatchObject({ kind: 'TIMEBOXED', periodCodes: null, endConditionKind: null, requestId: null });
    });

    it('the table keeps the rules: 90 days for a time-boxed delegation, an end condition for a permanent one, a review not after a fixed end', async () => {
      const row = (extra: { kind: string; days: number; condition?: string | null; text?: string | null; endDays?: number | null; request?: string | null }) =>
        owner(
          `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status, kind, end_condition_kind, end_condition_text, end_on, request_id)
           values ($1, gen_random_uuid(), $2, $3, '{approval.decide}', '{"kind":"UNIT_SUBTREE","ref_ids":[]}'::jsonb, now(), now() + ($4 || ' days')::interval, 'a long enough reason', 'Active', $5, $6, $7, case when $8::int is null then null else now() + ($8 || ' days')::interval end, $9::uuid)`,
          [TENANT_A, memberId(LEADER), memberId(DELEGATE), String(extra.days), extra.kind, extra.condition ?? null, extra.text ?? null, extra.endDays ?? null, extra.request ?? null],
        );
      const { request } = await standing();
      await expect(row({ kind: 'TIMEBOXED', days: 91 })).rejects.toThrow(/delegation_window_chk/);
      await expect(row({ kind: 'PERMANENT', days: 200, request })).rejects.toThrow(/delegation_standing_chk/);
      await expect(row({ kind: 'PERMANENT', days: 200, condition: 'UNTIL_EVENT', text: 'short', request })).rejects.toThrow(/delegation_standing_chk/);
      await expect(row({ kind: 'PERMANENT', days: 200, condition: 'UNTIL_EVENT', text: 'Until the post is filled.' })).rejects.toThrow(/delegation_standing_chk/);
      await expect(row({ kind: 'PERMANENT', days: 200, condition: 'UNTIL_DATE', text: 'Until the end of the year.', endDays: 100, request })).rejects.toThrow(/delegation_standing_chk/);
      await expect(row({ kind: 'PERMANENT', days: 200, condition: 'UNTIL_EVENT', text: 'Until the post is filled.', endDays: 300, request })).rejects.toThrow(/delegation_standing_chk/);
      await expect(row({ kind: 'TIMEBOXED', days: 5, condition: 'UNTIL_EVENT', text: 'Until the post is filled.' })).rejects.toThrow(/delegation_standing_chk/);
      await expect(row({ kind: 'PERMANENT', days: 200, condition: 'UNTIL_DATE', text: 'Until the end of the year.', endDays: 300, request })).resolves.toBeDefined();
    });

    it('the table keeps what a delegation grants: only the review of a permanent one moves its end, and only forward', async () => {
      const { delegation } = await standing();
      await expect(owner("update machvon.delegation_grant set permissions = '{doc.outgoing.sign}' where id = $1", [delegation.id])).rejects.toThrow(/not changed/);
      await expect(owner("update machvon.delegation_grant set end_condition_text = 'Until something else happens.' where id = $1", [delegation.id])).rejects.toThrow(/not changed/);
      await expect(owner("update machvon.delegation_grant set valid_until = valid_until - interval '1 day' where id = $1", [delegation.id])).rejects.toThrow(/not changed/);
      await expect(owner("update machvon.delegation_grant set valid_until = valid_until + interval '1 day' where id = $1", [delegation.id])).resolves.toBeDefined();
      const timeBoxed = await as((tx) =>
        delegations.insert(tx, { delegatorId: memberId(LEADER), delegateId: memberId(ADMIN), permissions: ['approval.decide'], scopeKind: 'UNIT_SUBTREE', scopeRefIds: [unitId(ROOT)], validFrom: NOW, validUntil: later(7 * DAY), reason: 'A short handover.', legalBasisRef: undefined, now: NOW }),
      );
      await expect(owner("update machvon.delegation_grant set valid_until = valid_until + interval '1 day' where id = $1", [timeBoxed.id])).rejects.toThrow(/not changed/);
    });

    it('is reviewed by moving the date it works until; the count, the reviewer and the reminder follow', async () => {
      const { delegation } = await standing();
      const { before, after } = await as((tx) => delegations.review(tx, delegation.id, delegation.version, memberId(LEADER), later(300 * DAY), later(HOUR)));
      expect(before.validUntil).toBe(delegation.validUntil);
      expect(after).toMatchObject({ reviewCount: 1, lastReviewedBy: memberId(LEADER), version: delegation.version + 1 });
      expect(new Date(after.validUntil).getTime()).toBe(later(300 * DAY).getTime());
    });

    it('refuses a review that is stale, not forward, too far, on a time-boxed delegation or on one that is over', async () => {
      const { delegation } = await standing();
      expect(await refusal(as((tx) => delegations.review(tx, delegation.id, delegation.version + 5, memberId(LEADER), later(200 * DAY), NOW)))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => delegations.review(tx, delegation.id, delegation.version, memberId(LEADER), later(100 * DAY), NOW)))).toMatchObject({ code: 'DELEGATION_INVALID', status: 422 });
      expect(await refusal(as((tx) => delegations.review(tx, delegation.id, delegation.version, memberId(LEADER), later(400 * DAY), NOW)))).toMatchObject({ code: 'DELEGATION_INVALID', status: 422 });
      const timeBoxed = await as((tx) =>
        delegations.insert(tx, { delegatorId: memberId(LEADER), delegateId: memberId(ADMIN), permissions: ['approval.decide'], scopeKind: 'UNIT_SUBTREE', scopeRefIds: [unitId(ROOT)], validFrom: NOW, validUntil: later(7 * DAY), reason: 'A short handover.', legalBasisRef: undefined, now: NOW }),
      );
      expect(await refusal(as((tx) => delegations.review(tx, timeBoxed.id, timeBoxed.version, memberId(LEADER), later(30 * DAY), NOW)))).toMatchObject({ code: 'DELEGATION_STATE_INVALID', status: 409 });
      await as((tx) => delegations.revoke(tx, delegation.id, delegation.version, memberId(LEADER), 'No longer needed.', NOW));
      expect(await refusal(as((tx) => delegations.review(tx, delegation.id, delegation.version + 1, memberId(LEADER), later(200 * DAY), NOW)))).toMatchObject({ code: 'DELEGATION_STATE_INVALID', status: 409 });
    });

    it('stops working at the review date: the pass ends it as REVIEW_LAPSED, or END_CONDITION_MET when its fixed end came', async () => {
      const lapsing = await standing({ startsAt: later(-30 * DAY), reviewDueAt: later(-1 * HOUR) }, later(-30 * DAY));
      const ended = await standing({ startsAt: later(-30 * DAY), reviewDueAt: later(-1 * HOUR), endConditionKind: 'UNTIL_DATE', endConditionText: 'Until the end of the quarter.', endOn: later(-1 * HOUR) }, later(-30 * DAY));
      const recorded = effects();
      const result = await as((tx) => delegations.sweep(tx, recorded, NOW, () => Promise.resolve(true)), ADMIN);
      expect(result.reviewLapsed).toBeGreaterThanOrEqual(2);
      const after = await as((tx) => Promise.all([delegations.find(tx, lapsing.delegation.id), delegations.find(tx, ended.delegation.id)]));
      expect(after[0]).toMatchObject({ status: 'Ended', endReason: 'REVIEW_LAPSED' });
      expect(after[1]).toMatchObject({ status: 'Ended', endReason: 'END_CONDITION_MET' });
      expect(recorded.recorded.audits.filter((entry) => entry.action === 'delegation.ended').length).toBeGreaterThanOrEqual(2);
    });

    it('tells the delegator once that a review falls due, and again after the review moves the date', async () => {
      const { delegation } = await standing({ reviewDueAt: later(10 * DAY) });
      const first = effects();
      expect((await as((tx) => delegations.sweep(tx, first, NOW, () => Promise.resolve(true)), ADMIN)).reviewReminded).toBeGreaterThanOrEqual(1);
      expect(first.recorded.events.filter((event) => event.type === 'iam.delegation.review_due.v1' && event.payload.delegation_id === delegation.id)).toHaveLength(1);
      const second = effects();
      await as((tx) => delegations.sweep(tx, second, NOW, () => Promise.resolve(true)), ADMIN);
      expect(second.recorded.events.filter((event) => event.payload.delegation_id === delegation.id && event.type === 'iam.delegation.review_due.v1')).toHaveLength(0);
      const reviewed = await as((tx) => delegations.review(tx, delegation.id, delegation.version, memberId(LEADER), later(12 * DAY), NOW));
      const third = effects();
      await as((tx) => delegations.sweep(tx, third, NOW, () => Promise.resolve(true)), ADMIN);
      expect(third.recorded.events.filter((event) => event.payload.delegation_id === delegation.id && event.type === 'iam.delegation.review_due.v1')).toHaveLength(1);
      expect(reviewed.after.reviewCount).toBe(1);
    });

    it('lists the delegations that work as edges between persons, for the loop check, and not the ones that are over', async () => {
      const { delegation } = await standing({ delegatorId: memberId(APPROVER), delegateId: memberId(SUBJECT), permissions: ['doc.outgoing.sign'] });
      const edges = await as((tx) => delegations.edges(tx, NOW));
      expect(edges.some((edge) => edge.permissions.includes('doc.outgoing.sign') && edge.delegatorUser !== edge.delegateUser)).toBe(true);
      await as((tx) => delegations.revoke(tx, delegation.id, delegation.version, memberId(APPROVER), 'No longer needed.', NOW), APPROVER);
      const after = await as((tx) => delegations.edges(tx, NOW));
      expect(after.filter((edge) => edge.permissions.includes('doc.outgoing.sign'))).toHaveLength(0);
    });
  });

  describe('the request for a permanent delegation', () => {
    it('is Pending, is Lapsed after its 7 days without a decision, and is read by the two parties only', async () => {
      const created = await as((tx) => requests.insert(tx, asked() as Parameters<StandingRequestStore['insert']>[1]));
      expect(created).toMatchObject({ status: 'Pending', decidedBy: null, delegationId: null, expiresAt: expect.any(String) });
      await owner("update machvon.standing_delegation_request set expires_at = now() - interval '1 minute' where id = $1", [created.id]);
      expect((await as((tx) => requests.find(tx, created.id)))?.status).toBe('Lapsed');
      expect(await refusal(as((tx) => requests.lockPending(tx, created.id, created.version)))).toMatchObject({ code: 'DELEGATION_STATE_INVALID', status: 409 });
      const page = { limit: 50, after: undefined };
      const own = await as((tx) => requests.list(tx, { membershipId: memberId(LEADER), all: false }, { id: created.id }, page));
      const stranger = await as((tx) => requests.list(tx, { membershipId: memberId(ADMIN), all: false }, { id: created.id }, page), ADMIN);
      const everyone = await as((tx) => requests.list(tx, { membershipId: memberId(ADMIN), all: true }, { id: created.id }, page), ADMIN);
      expect([own.length, stranger.length, everyone.length]).toEqual([1, 0, 1]);
    });

    it('is decided once; the version guards it; a decider who is a party is refused by the table', async () => {
      const created = await as((tx) => requests.insert(tx, asked() as Parameters<StandingRequestStore['insert']>[1]));
      expect(await refusal(as((tx) => requests.lockPending(tx, created.id, created.version + 3)))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await expect(as((tx) => requests.reject(tx, created.id, memberId(LEADER), 'A reason that is long enough.', NOW))).rejects.toThrow(/standing_request_parties_chk/);
      const rejected = await as((tx) => requests.reject(tx, created.id, memberId(APPROVER), 'A reason that is long enough.', NOW), APPROVER);
      expect(rejected).toMatchObject({ status: 'Rejected', decisionReason: 'A reason that is long enough.', delegationId: null });
      expect(await refusal(as((tx) => requests.lockPending(tx, created.id, rejected.version)))).toMatchObject({ code: 'DELEGATION_STATE_INVALID', status: 409 });
      await expect(app("update machvon.standing_delegation_request set status = 'Pending', decided_at = null, decided_by = null where id = $1", [created.id])).rejects.toThrow(/never changes/);
      await expect(app('update machvon.standing_delegation_request set reason = $2 where id = $1', [created.id, 'Another reason altogether.'])).rejects.toThrow(/never changes/);
      await expect(app('delete from machvon.standing_delegation_request where id = $1', [created.id])).rejects.toThrow(/permission denied/);
    });

    it('is cancelled by the delegator before it is decided', async () => {
      const created = await as((tx) => requests.insert(tx, asked() as Parameters<StandingRequestStore['insert']>[1]));
      const cancelled = await as((tx) => requests.cancel(tx, created.id, NOW));
      expect(cancelled).toMatchObject({ status: 'Cancelled', delegationId: null });
    });
  });

  describe('acting on behalf of a person', () => {
    const request = (overrides: Record<string, unknown> = {}) => ({ requesterId: memberId(ADMIN), subjectId: memberId(SUBJECT), permissions: ['dis.report.submit'], periodCodes: undefined as string[] | undefined, hours: 4, reason: 'The reporter is in hospital and the weekly report is due.', ...overrides });

    it('starts the window at the approval and is in force inside it only', async () => {
      const created = await as((tx) => acting.insert(tx, request(), NOW), ADMIN);
      expect(created).toMatchObject({ status: 'Pending', phase: 'PENDING', windowStart: null });
      expect(await as((tx) => acting.liveFor(tx, created.id, memberId(ADMIN), NOW), ADMIN)).toBeUndefined();
      const approved = await as((tx) => acting.approve(tx, created.id, memberId(APPROVER), undefined, NOW), APPROVER);
      expect(approved).toMatchObject({ status: 'Approved', phase: 'ACTIVE', decidedBy: memberId(APPROVER) });
      expect(new Date(approved.windowEnd as string).getTime() - new Date(approved.windowStart as string).getTime()).toBe(4 * HOUR);
      expect((await as((tx) => acting.liveFor(tx, created.id, memberId(ADMIN), later(HOUR)), ADMIN))?.id).toBe(created.id);
      expect(await as((tx) => acting.liveFor(tx, created.id, memberId(ADMIN), later(4 * HOUR + 1000)), ADMIN)).toBeUndefined();
      // Only the one who asked uses it.
      expect(await as((tx) => acting.liveFor(tx, created.id, memberId(APPROVER), later(HOUR)), APPROVER)).toBeUndefined();
    });

    it('stops at once when it is revoked, and is not in force for a person who is no longer an active member', async () => {
      const created = await as((tx) => acting.insert(tx, request(), NOW), ADMIN);
      const approved = await as((tx) => acting.approve(tx, created.id, memberId(APPROVER), undefined, NOW), APPROVER);
      const { after } = await as((tx) => acting.revoke(tx, created.id, approved.version, memberId(APPROVER), 'The reporter is back at work.', later(HOUR)), APPROVER);
      expect(after).toMatchObject({ status: 'Revoked', phase: 'REVOKED', revokedBy: memberId(APPROVER) });
      expect(await as((tx) => acting.liveFor(tx, created.id, memberId(ADMIN), later(2 * HOUR)), ADMIN)).toBeUndefined();
      expect(await refusal(as((tx) => acting.revoke(tx, created.id, after.version, memberId(APPROVER), 'Revoked a second time.', later(2 * HOUR)), APPROVER))).toMatchObject({ code: 'ACTING_STATE_INVALID', status: 409 });
      const second = await as((tx) => acting.insert(tx, request(), NOW), ADMIN);
      await as((tx) => acting.approve(tx, second.id, memberId(APPROVER), undefined, NOW), APPROVER);
      await owner("update machvon.membership set status = 'Suspended' where id = $1", [memberId(SUBJECT)]);
      try {
        expect(await as((tx) => acting.liveFor(tx, second.id, memberId(ADMIN), later(HOUR)), ADMIN)).toBeUndefined();
      } finally {
        await owner("update machvon.membership set status = 'Active' where id = $1", [memberId(SUBJECT)]);
      }
    });

    it('lets a request wait a day and no longer; a decided request is not decided again', async () => {
      const created = await as((tx) => acting.insert(tx, request(), later(-25 * HOUR)), ADMIN);
      expect((await as((tx) => acting.find(tx, created.id, NOW), ADMIN))?.phase).toBe('REQUEST_LAPSED');
      expect(await refusal(as((tx) => acting.lockPending(tx, created.id, created.version, NOW), APPROVER))).toMatchObject({ code: 'ACTING_STATE_INVALID', status: 409 });
      const fresh = await as((tx) => acting.insert(tx, request(), NOW), ADMIN);
      expect(await refusal(as((tx) => acting.lockPending(tx, fresh.id, fresh.version + 2, NOW), APPROVER))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await as((tx) => acting.reject(tx, fresh.id, memberId(APPROVER), 'Not needed, the report is in.', NOW), APPROVER);
      expect(await refusal(as((tx) => acting.lockPending(tx, fresh.id, 2, NOW), APPROVER))).toMatchObject({ code: 'ACTING_STATE_INVALID', status: 409 });
    });

    it('the table keeps the rules: data entry only, 8 hours at most, a reason, two other people', async () => {
      const row = (extra: { permissions?: string; hours?: number; reason?: string; subject?: number; decided?: number | null }) =>
        owner(
          `insert into machvon.acting_grant (tenant_id, id, requester_membership_id, subject_membership_id, permissions, hours, reason, status, decided_by, decided_at, decision_reason)
           values ($1, gen_random_uuid(), $2, $3, $4::text[], $5, $6, $7, $8::uuid, $9::timestamptz, $10)`,
          [TENANT_A, memberId(ADMIN), memberId(extra.subject ?? SUBJECT), extra.permissions ?? '{dis.report.submit}', extra.hours ?? 4, extra.reason ?? 'A reason that is long enough.', extra.decided === undefined ? 'Pending' : 'Rejected', extra.decided === undefined || extra.decided === null ? null : memberId(extra.decided), extra.decided === undefined ? null : NOW.toISOString(), extra.decided === undefined ? null : 'Declined by the approver.'],
        );
      await expect(row({ permissions: '{iam.role.grant}' })).rejects.toThrow(/acting_permissions_chk/);
      await expect(row({ permissions: '{approval.decide}' })).rejects.toThrow(/acting_permissions_chk/);
      await expect(row({ permissions: '{doc.outgoing.sign}' })).rejects.toThrow(/acting_permissions_chk/);
      await expect(row({ permissions: '{report.review}' })).rejects.toThrow(/acting_permissions_chk/);
      await expect(row({ permissions: '{dis.*}' })).rejects.toThrow(/acting_permissions_chk/);
      await expect(row({ hours: 9 })).rejects.toThrow(/acting_hours_chk/);
      await expect(row({ reason: 'too short' })).rejects.toThrow(/acting_reason_chk/);
      await expect(row({ subject: ADMIN })).rejects.toThrow(/acting_parties_chk/);
      await expect(row({ decided: ADMIN })).rejects.toThrow(/acting_parties_chk/);
      await expect(row({ decided: SUBJECT })).rejects.toThrow(/acting_parties_chk/);
      await expect(row({ decided: APPROVER })).resolves.toBeDefined();
    });

    it('the table keeps what was asked, and an approved grant can only be revoked', async () => {
      const created = await as((tx) => acting.insert(tx, request(), NOW), ADMIN);
      await expect(app("update machvon.acting_grant set permissions = '{dis.report.edit}' where id = $1", [created.id])).rejects.toThrow(/never changes/);
      await expect(app('update machvon.acting_grant set hours = 8 where id = $1', [created.id], ADMIN)).rejects.toThrow(/never changes/);
      const approved = await as((tx) => acting.approve(tx, created.id, memberId(APPROVER), undefined, NOW), APPROVER);
      await expect(app("update machvon.acting_grant set window_end = window_end + interval '1 hour', hours = hours where id = $1", [approved.id])).rejects.toThrow(/acting_window_chk|can only be revoked/);
      await expect(app("update machvon.acting_grant set status = 'Cancelled', decided_at = now() where id = $1", [approved.id])).rejects.toThrow(/can only be revoked/);
      await expect(app('delete from machvon.acting_grant where id = $1', [approved.id], ADMIN)).rejects.toThrow(/permission denied/);
    });

    it('is read by the administrator, the person, and the one who decided, and by everyone for one who runs it all', async () => {
      const created = await as((tx) => acting.insert(tx, request(), NOW), ADMIN);
      const page = { limit: 50, after: undefined };
      const seen = (member: number, all: boolean): Promise<number> => as((tx) => acting.list(tx, { membershipId: memberId(member), all }, { id: created.id }, page, NOW), member).then((rows) => rows.length);
      expect([await seen(ADMIN, false), await seen(SUBJECT, false), await seen(LEADER, false), await seen(LEADER, true)]).toEqual([1, 1, 0, 1]);
    });
  });

  describe('the limit of a role grant to report periods', () => {
    it('is joined into the access of the holder while it is Active and is gone when it is lifted, and each change raises the scope version', async () => {
      const before = Number((await owner<{ v: string }>('select scope_version::text as v from machvon.membership where id = $1', [memberId(SUBJECT)]))[0]?.v);
      expect((await as((tx) => loadAccessIn(tx, memberId(SUBJECT)))).grants[0]?.periodCodes).toBeUndefined();
      const set = await as((tx) => periodScopes.insert(tx, { roleGrantId: grantId(1), membershipId: memberId(SUBJECT), periodCodes: ['2026-Q3'], reason: 'The reporter covers the third quarter only.', setBy: memberId(ADMIN) }), ADMIN);
      expect(set).toMatchObject({ status: 'Active', roleCode: 'REPORTER', membershipId: memberId(SUBJECT), periodCodes: ['2026-Q3'] });
      expect((await as((tx) => loadAccessIn(tx, memberId(SUBJECT)))).grants[0]?.periodCodes).toEqual(['2026-Q3']);
      const lifted = await as((tx) => periodScopes.lift(tx, set.id, set.version, memberId(ADMIN), 'The reporter covers every period again.', NOW), ADMIN);
      expect(lifted.after).toMatchObject({ status: 'Lifted', liftedBy: memberId(ADMIN) });
      expect((await as((tx) => loadAccessIn(tx, memberId(SUBJECT)))).grants[0]?.periodCodes).toBeUndefined();
      const after = Number((await owner<{ v: string }>('select scope_version::text as v from machvon.membership where id = $1', [memberId(SUBJECT)]))[0]?.v);
      expect(after).toBe(before + 2);
    });

    it('is one at a time for a grant, final once lifted, and the version guards the lift', async () => {
      const first = await as((tx) => periodScopes.insert(tx, { roleGrantId: grantId(1), membershipId: memberId(SUBJECT), periodCodes: ['2026'], reason: 'The reporter covers the year 2026 only.', setBy: memberId(ADMIN) }), ADMIN);
      expect(await refusal(as((tx) => periodScopes.insert(tx, { roleGrantId: grantId(1), membershipId: memberId(SUBJECT), periodCodes: ['2027'], reason: 'The reporter covers the year 2027.', setBy: memberId(ADMIN) }), ADMIN))).toMatchObject({ code: 'PERIOD_SCOPE_STATE_INVALID', status: 409 });
      expect(await refusal(as((tx) => periodScopes.lift(tx, first.id, first.version + 4, memberId(ADMIN), 'The limit is not needed any more.', NOW), ADMIN))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const lifted = await as((tx) => periodScopes.lift(tx, first.id, first.version, memberId(ADMIN), 'The limit is not needed any more.', NOW), ADMIN);
      expect(await refusal(as((tx) => periodScopes.lift(tx, first.id, lifted.after.version, memberId(ADMIN), 'The limit is lifted a second time.', NOW), ADMIN))).toMatchObject({ code: 'PERIOD_SCOPE_STATE_INVALID', status: 409 });
      await expect(app("update machvon.role_grant_period_scope set status = 'Active', lifted_by = null, lifted_at = null, lift_reason = null where id = $1", [first.id])).rejects.toThrow(/never changes/);
    });

    it('the table keeps the form of the periods and a reason', async () => {
      const row = (periods: string, reason = 'A reason that is long enough.') =>
        owner('insert into machvon.role_grant_period_scope (tenant_id, id, role_grant_id, period_codes, reason, set_by) values ($1, gen_random_uuid(), $2, $3::text[], $4, $5)', [TENANT_A, grantId(1), periods, reason, memberId(ADMIN)]);
      await expect(row('{2026-Q5}')).rejects.toThrow(/period_scope_codes_chk/);
      await expect(row('{}')).rejects.toThrow(/period_scope_codes_chk/);
      await expect(row('{Q3-2026}')).rejects.toThrow(/period_scope_codes_chk/);
      await expect(row('{2026-Q3}', 'short')).rejects.toThrow(/period_scope_reason_chk/);
    });

    it('lists the limits, newest first, by status and by holder', async () => {
      const set = await as((tx) => periodScopes.insert(tx, { roleGrantId: grantId(1), membershipId: memberId(SUBJECT), periodCodes: ['2026-H2'], reason: 'The reporter covers the second half only.', setBy: memberId(ADMIN) }), ADMIN);
      const page = { limit: 50, after: undefined };
      const active = await as((tx) => periodScopes.list(tx, { status: 'Active', membershipId: memberId(SUBJECT) }, page));
      expect(active.map((row) => row.id)).toContain(set.id);
      expect(active.every((row) => row.status === 'Active')).toBe(true);
      expect(await as((tx) => periodScopes.list(tx, { membershipId: memberId(LEADER) }, page))).toEqual([]);
      await as((tx) => periodScopes.lift(tx, set.id, set.version, memberId(ADMIN), 'The limit is not needed any more.', NOW), ADMIN);
    });
  });
});
