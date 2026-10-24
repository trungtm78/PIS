import { randomUUID } from 'node:crypto';
import { IssIssueClosure, ISSUE_MAX_EXTENSIONS, ISSUE_REOPEN_WINDOW_DAYS } from '../src/iss-issue-closure';
import type { CreatedIssue } from '../src/iss-issue-store';
import { DOCUMENT_CLEAN, DOCUMENT_PENDING, IssWorld, NOW, PEOPLE, TENANT_A, UNIT_1, memberId } from './support/iss-fixtures';

const world = new IssWorld();
const closure = new IssIssueClosure(world.issues, world.deadlines);
const { as, owner, refusal, sqlRefusal } = world;

const DAY_MS = 86_400_000;
let mediumCategory = '';

const assignScope = () => world.everything('issue.assign', PEOPLE.ASSIGNER);
const workScope = (member: number = PEOPLE.WORKER_U1) => world.scopesOf('issue.work', world.subtree(1), member);
const closeScope = (member: number = PEOPLE.VERIFIER) => world.everything('issue.close', member);
const reopenScope = () => world.everything('issue.reopen', PEOPLE.VERIFIER);
const extendScope = (member: number = PEOPLE.EXTENDER) => world.everything('issue.extend', member);
/** A caller who reads every issue but may act in unit 2 only: the issues of unit 1 are theirs to see and not to move (403, not 404). */
const readerOfOtherUnit = (permission: string, member: number) => ({ act: world.scopesOf(permission, world.subtree(2), member).act, read: world.everything(permission, member).read });

const versionOf = async (issueId: string): Promise<number> => Number((await world.row(issueId)).version);

/** Opens an issue and takes it through the commands to IN_PROGRESS under WORKER_U1. */
async function working(severity = 'HIGH', at: Date = NOW): Promise<CreatedIssue> {
  const created = await world.open(world.request({ severity, ...(severity === 'MEDIUM' ? { categoryVersionId: mediumCategory } : {}) }), at);
  await as((tx) => world.issues.assign(tx, created.id, 1, { assigneeId: memberId(PEOPLE.WORKER_U1) }, memberId(PEOPLE.ASSIGNER), assignScope(), at), TENANT_A, PEOPLE.ASSIGNER);
  await as((tx) => world.issues.start(tx, created.id, 2, undefined, memberId(PEOPLE.WORKER_U1), workScope(), at), TENANT_A, PEOPLE.WORKER_U1);
  return created;
}

const requestVerification = async (issueId: string, evidence: string[] = [DOCUMENT_CLEAN], at: Date = NOW, member: number = PEOPLE.WORKER_U1) =>
  as((tx) => closure.requestVerification(tx, issueId, 3, { resultNote: 'The handover was signed', evidenceDocumentVersionIds: evidence }, memberId(member), workScope(member), at), TENANT_A, member);

async function pendingVerification(severity = 'HIGH', at: Date = NOW): Promise<CreatedIssue> {
  const created = await working(severity, at);
  await requestVerification(created.id, severity === 'MEDIUM' ? [] : [DOCUMENT_CLEAN], at);
  return created;
}

const close = (issueId: string, version: number, member: number = PEOPLE.VERIFIER, at: Date = NOW) =>
  as((tx) => closure.close(tx, issueId, version, { verificationNote: 'Checked on the site' }, memberId(member), closeScope(member), at), TENANT_A, member);

const extend = (issueId: string, version: number, newDueAt: string, member: number = PEOPLE.EXTENDER, at: Date = NOW) =>
  as((tx) => closure.extend(tx, issueId, version, { newDueAt, reason: 'The landowner asked for time' }, memberId(member), extendScope(member), at), TENANT_A, member);

describe('IssIssueClosure (verification, closure, reopening and the bounded extension, ST-ISS-003)', () => {
  beforeAll(async () => {
    await world.start();
    // The policy of the MEDIUM issues of another category asks for no evidence.
    mediumCategory = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', 'ROAD');
    await as((tx) =>
      world.policies.publish(
        tx,
        { code: 'SLA-ROAD-MED', categoryVersionId: mediumCategory, severity: 'MEDIUM', calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, validFrom: '2026-08-05', requireEvidence: false, requireIndependentVerifier: false },
        memberId(PEOPLE.REPORTER),
      ),
    );
  }, 300_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('asking for the verification', () => {
    it('AC-ST-ISS-003-1: needs the evidence the policy asks for, scanned clean, from the handler only; it moves the issue to PENDING_VERIFICATION and writes the event', async () => {
      const created = await working();
      expect(await refusal(requestVerification(created.id, [DOCUMENT_CLEAN], NOW, PEOPLE.WORKER_ALL))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(requestVerification(created.id, []))).toEqual({ code: 'EVIDENCE_REQUIRED', status: 422 });
      expect(await refusal(requestVerification(created.id, [DOCUMENT_PENDING]))).toEqual({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(requestVerification(created.id, [randomUUID()]))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'evidence_document_version_ids' });
      expect(await refusal(requestVerification(created.id, ['not-a-uuid']))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'evidence_document_version_ids' });
      expect(await refusal(requestVerification(created.id, Array.from({ length: 21 }, () => randomUUID())))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'evidence_document_version_ids' });
      expect(await refusal(as((tx) => closure.requestVerification(tx, created.id, 3, { resultNote: ' ', evidenceDocumentVersionIds: [DOCUMENT_CLEAN] }, memberId(PEOPLE.WORKER_U1), workScope(), NOW), TENANT_A, PEOPLE.WORKER_U1))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'result_note',
      });
      expect((await refusal(as((tx) => closure.requestVerification(tx, created.id, 2, { resultNote: 'Done', evidenceDocumentVersionIds: [DOCUMENT_CLEAN] }, memberId(PEOPLE.WORKER_U1), workScope(), NOW), TENANT_A, PEOPLE.WORKER_U1))).code).toBe('VERSION_CONFLICT');

      const asked = await requestVerification(created.id, [DOCUMENT_CLEAN, DOCUMENT_CLEAN.toUpperCase()]);
      expect(asked).toMatchObject({ status: 'PENDING_VERIFICATION', version: 4, evidenceCount: 1 });
      const stored = await world.row(created.id);
      expect(stored).toMatchObject({ status: 'PENDING_VERIFICATION', closed_at: null, verifier_id: null });
      expect((stored.resolved_at as Date).toISOString()).toBe(NOW.toISOString());
      const last = (await world.events(created.id)).at(-1);
      expect(last).toMatchObject({ event_kind: 'VERIFICATION_REQUESTED', from_status: 'IN_PROGRESS', to_status: 'PENDING_VERIFICATION', note: 'The handover was signed', created_by: memberId(PEOPLE.WORKER_U1) });
      expect(last?.payload).toEqual({ evidence_document_version_ids: [DOCUMENT_CLEAN] });
      // Asked twice: the issue is no longer in the state that asks (state comes before the version).
      expect(await refusal(requestVerification(created.id, [DOCUMENT_CLEAN]))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
    });

    it('takes no evidence when the policy of the issue asks for none', async () => {
      const created = await working('MEDIUM');
      expect((await requestVerification(created.id, [])).status).toBe('PENDING_VERIFICATION');
      expect((await world.events(created.id)).at(-1)?.payload).toEqual({ evidence_document_version_ids: [] });
    });
  });

  describe('closing', () => {
    it('AC-ST-ISS-003-1: the person who worked the issue cannot close it; a different verifier closes it with the evidence on file, and the timeline keeps the order', async () => {
      const created = await pendingVerification();
      await owner(
        `insert into machvon.issue_escalation (tenant_id, id, issue_id, level, trigger, target_unit_id, reason, due_at, created_by, updated_by)
         values ($1::uuid, gen_random_uuid(), $2::uuid, 2, 'SLA_AUTO', $3::uuid, 'SLA_L2_THRESHOLD_REACHED', now(), $4::uuid, $4::uuid)`,
        [TENANT_A, created.id, UNIT_1, memberId(PEOPLE.SYSTEM)],
      );
      // The handler is refused, whatever scope they hold (X gets 403).
      expect(await refusal(close(created.id, 4, PEOPLE.WORKER_U1))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => closure.close(tx, created.id, 4, { verificationNote: ' ' }, memberId(PEOPLE.VERIFIER), closeScope(), NOW), TENANT_A, PEOPLE.VERIFIER))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'verification_note',
      });
      expect((await refusal(close(created.id, 3, PEOPLE.VERIFIER))).code).toBe('VERSION_CONFLICT');
      expect(await refusal(as((tx) => closure.close(tx, created.id, 4, { verificationNote: 'Checked' }, memberId(PEOPLE.VERIFIER), readerOfOtherUnit('issue.close', PEOPLE.VERIFIER), NOW), TENANT_A, PEOPLE.VERIFIER))).toEqual({
        code: 'SCOPE_DENIED',
        status: 403,
      });

      const later = new Date(NOW.getTime() + 3_600_000);
      const closed = await close(created.id, 4, PEOPLE.VERIFIER, later);
      expect(closed).toMatchObject({ status: 'CLOSED', version: 5, verifierId: memberId(PEOPLE.VERIFIER), closedAt: later.toISOString() });
      const stored = await world.row(created.id);
      expect(stored).toMatchObject({ status: 'CLOSED', closed_by: memberId(PEOPLE.VERIFIER), verifier_id: memberId(PEOPLE.VERIFIER), version: '5' });
      expect((stored.closed_at as Date).toISOString()).toBe(later.toISOString());
      expect((await world.events(created.id)).map((event) => event.event_kind)).toEqual(['CREATED', 'ASSIGNED', 'STARTED', 'VERIFICATION_REQUESTED', 'CLOSED']);
      expect((await owner<{ status: string }>('select status from machvon.issue_escalation where issue_id = $1::uuid', [created.id])).map((row) => row.status)).toEqual(['RESOLVED']);
    });

    it('AC-ST-ISS-003-3: a close sent again under a new key is an invalid state, not a second closing', async () => {
      const created = await pendingVerification();
      await close(created.id, 4);
      const before = await world.events(created.id);
      expect(await refusal(close(created.id, 5))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
      // Even with the version it was sent with the first time.
      expect(await refusal(close(created.id, 4))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
      expect(await world.events(created.id)).toEqual(before);
    });

    it('refuses the closing of an issue whose latest request named no evidence although the policy asks for it', async () => {
      const created = await working();
      await owner("update machvon.issue set status = 'PENDING_VERIFICATION', version = version + 1 where id = $1::uuid", [created.id]);
      await owner(
        `insert into machvon.issue_event (tenant_id, id, issue_id, event_kind, from_status, to_status, payload, created_by)
         values ($1::uuid, gen_random_uuid(), $2::uuid, 'VERIFICATION_REQUESTED', 'IN_PROGRESS', 'PENDING_VERIFICATION', '{"evidence_document_version_ids":[]}'::jsonb, $3::uuid)`,
        [TENANT_A, created.id, memberId(PEOPLE.WORKER_U1)],
      );
      expect(await refusal(close(created.id, 4))).toEqual({ code: 'EVIDENCE_REQUIRED', status: 422 });
    });

    it('closes an issue whose policy asks for no evidence and no independent verifier, and the verifier is still not the handler (issue_verifier_chk)', async () => {
      const created = await pendingVerification('MEDIUM');
      expect(await refusal(close(created.id, 4, PEOPLE.WORKER_U1))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await close(created.id, 4)).status).toBe('CLOSED');
    });

    it('refuses to close an issue that is not waiting for verification', async () => {
      const created = await working();
      expect(await refusal(close(created.id, 3))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
      const open = await world.open();
      expect(await refusal(close(open.id, 1))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
    });
  });

  describe('giving the result back', () => {
    it('lets the verifier refuse the result with assignIssue and the reason, which withdraws the handler\'s claim of being done', async () => {
      const created = await pendingVerification();
      const scope = world.everything('issue.assign', PEOPLE.VERIFIER);
      expect(
        await refusal(as((tx) => world.issues.assign(tx, created.id, 4, { assigneeId: memberId(PEOPLE.WORKER_U1) }, memberId(PEOPLE.VERIFIER), scope, NOW), TENANT_A, PEOPLE.VERIFIER)),
      ).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'note' });
      const given = await as((tx) => world.issues.assign(tx, created.id, 4, { assigneeId: memberId(PEOPLE.WORKER_U1), note: 'The photos do not show the fence' }, memberId(PEOPLE.VERIFIER), scope, NOW), TENANT_A, PEOPLE.VERIFIER);
      expect(given).toMatchObject({ status: 'ASSIGNED', previousStatus: 'PENDING_VERIFICATION' });
      expect(await world.row(created.id)).toMatchObject({ status: 'ASSIGNED', resolved_at: null });
      const last = (await world.events(created.id)).at(-1);
      expect(last).toMatchObject({ event_kind: 'REASSIGNED', from_status: 'PENDING_VERIFICATION', to_status: 'ASSIGNED', note: 'The photos do not show the fence', payload: { outcome: 'VERIFICATION_REFUSED' } });
    });
  });

  describe('what the database holds whatever the application did (UAT-AC351)', () => {
    const closeRaw = (issueId: string, extra = ''): Promise<unknown> =>
      as((tx) => tx.query(`update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = $2::uuid, verifier_id = $2::uuid${extra} where id = $1::uuid`, [issueId, memberId(PEOPLE.VERIFIER)]));

    it('AC-ST-ISS-003-1: refuses a closing without evidence, without a request for verification, without the closer and the verifier, and by someone who is not the verifier', async () => {
      const noRequest = await working();
      await owner("update machvon.issue set status = 'PENDING_VERIFICATION' where id = $1::uuid", [noRequest.id]);
      const noRequestRefusal = await sqlRefusal(closeRaw(noRequest.id));
      expect(noRequestRefusal.sqlstate).toBe('23514');
      expect(noRequestRefusal.message).toContain('only after a request for verification');

      const noEvidence = await working();
      await owner("update machvon.issue set status = 'PENDING_VERIFICATION' where id = $1::uuid", [noEvidence.id]);
      await owner(
        `insert into machvon.issue_event (tenant_id, id, issue_id, event_kind, from_status, to_status, payload, created_by)
         values ($1::uuid, gen_random_uuid(), $2::uuid, 'VERIFICATION_REQUESTED', 'IN_PROGRESS', 'PENDING_VERIFICATION', '{}'::jsonb, $3::uuid)`,
        [TENANT_A, noEvidence.id, memberId(PEOPLE.WORKER_U1)],
      );
      const noEvidenceRefusal = await sqlRefusal(closeRaw(noEvidence.id));
      expect(noEvidenceRefusal.sqlstate).toBe('23514');
      expect(noEvidenceRefusal.message).toContain('asks for evidence');

      const pending = await pendingVerification();
      // A closing that names no closer and no verifier is the CHECK's to refuse (UAT-AC351 step 5).
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue set status = 'CLOSED' where id = $1::uuid", [pending.id])))).message).toContain('issue_close_chk');
      expect(
        (await sqlRefusal(as((tx) => tx.query("update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = assignee_id, verifier_id = assignee_id where id = $1::uuid", [pending.id])))).message,
      ).toContain('issue_verifier_chk');
      expect(
        (await sqlRefusal(as((tx) => tx.query("update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = $3::uuid, verifier_id = $2::uuid where id = $1::uuid", [pending.id, memberId(PEOPLE.VERIFIER), memberId(PEOPLE.EXTENDER)])))).message,
      ).toContain('issue_closer_chk');
      // The statement that is right closes it.
      await closeRaw(pending.id);
      expect((await world.row(pending.id)).status).toBe('CLOSED');
      // Only a closed issue carries a closure.
      const open = await world.open();
      expect((await sqlRefusal(as((tx) => tx.query('update machvon.issue set closed_at = now() where id = $1::uuid', [open.id])))).message).toContain('issue_closed_fields_chk');
    });
  });

  describe('reopening', () => {
    it('reopens a closed issue within the window with the reason, counts it, gives the closure back and lets it be assigned again', async () => {
      const created = await pendingVerification();
      const closedAt = new Date(NOW.getTime() + 3_600_000);
      await close(created.id, 4, PEOPLE.VERIFIER, closedAt);
      const reopenAt = new Date(closedAt.getTime() + ISSUE_REOPEN_WINDOW_DAYS * DAY_MS);
      expect(await refusal(as((tx) => closure.reopen(tx, created.id, 5, { reason: ' ' }, memberId(PEOPLE.VERIFIER), reopenScope(), reopenAt), TENANT_A, PEOPLE.VERIFIER))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(as((tx) => closure.reopen(tx, created.id, 5, { reason: 'Late' }, memberId(PEOPLE.VERIFIER), reopenScope(), new Date(reopenAt.getTime() + 1)), TENANT_A, PEOPLE.VERIFIER))).toEqual({
        code: 'REOPEN_WINDOW_EXPIRED',
        status: 422,
      });
      expect((await refusal(as((tx) => closure.reopen(tx, created.id, 4, { reason: 'Stale' }, memberId(PEOPLE.VERIFIER), reopenScope(), reopenAt), TENANT_A, PEOPLE.VERIFIER))).code).toBe('VERSION_CONFLICT');
      const reopened = await as((tx) => closure.reopen(tx, created.id, 5, { reason: 'The fence fell again' }, memberId(PEOPLE.VERIFIER), reopenScope(), reopenAt), TENANT_A, PEOPLE.VERIFIER);
      expect(reopened).toMatchObject({ status: 'REOPENED', version: 6, reopenCount: 1, closedAt: closedAt.toISOString() });
      expect(await world.row(created.id)).toMatchObject({ status: 'REOPENED', reopen_count: 1, closed_at: null, closed_by: null, verifier_id: null, resolved_at: null });
      const last = (await world.events(created.id)).at(-1);
      expect(last).toMatchObject({ event_kind: 'REOPENED', from_status: 'CLOSED', to_status: 'REOPENED', note: 'The fence fell again', payload: { reopen_count: 1, closed_at: closedAt.toISOString() } });
      // The state is checked before the version, so a second reopening is an invalid state.
      expect(await refusal(as((tx) => closure.reopen(tx, created.id, 5, { reason: 'Again' }, memberId(PEOPLE.VERIFIER), reopenScope(), reopenAt), TENANT_A, PEOPLE.VERIFIER))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
      // REOPENED to ASSIGNED is the way back to work.
      const again = await as((tx) => world.issues.assign(tx, created.id, 6, { assigneeId: memberId(PEOPLE.WORKER_U1) }, memberId(PEOPLE.ASSIGNER), assignScope(), reopenAt), TENANT_A, PEOPLE.ASSIGNER);
      expect(again.status).toBe('ASSIGNED');
    });

    it('refuses to reopen an issue that is not closed, and a reopening counted by anything but the move', async () => {
      const created = await working();
      expect(await refusal(as((tx) => closure.reopen(tx, created.id, 3, { reason: 'Why' }, memberId(PEOPLE.VERIFIER), reopenScope(), NOW), TENANT_A, PEOPLE.VERIFIER))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
      expect((await sqlRefusal(as((tx) => tx.query('update machvon.issue set reopen_count = 5 where id = $1::uuid', [created.id])))).message).toContain('a reopening is counted only by the move');
      const closed = await pendingVerification();
      await close(closed.id, 4);
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue set status = 'REOPENED', reopen_count = reopen_count + 2, closed_at = null, closed_by = null, verifier_id = null where id = $1::uuid", [closed.id])))).message).toContain('a reopening is counted');
    });
  });

  describe('extending the deadline', () => {
    // The issue is opened on Monday 10 August 09:00; its deadline is Tuesday 11 August 15:30 (16 working hours from 07:30 window).
    const DUE = '2026-08-11T08:30:00.000Z';
    // Wednesday 12 August 09:00, a day after the deadline.
    const WEDNESDAY = new Date('2026-08-12T02:00:00Z');
    // Sixteen working hours after the deadline: Thursday 12:30.
    const CAP = '2026-08-13T05:30:00.000Z';

    it('AC-ST-ISS-003-2: an independent approver extends it twice, the third time is refused, and each extension is counted on the working calendar', async () => {
      const created = await working();
      expect(created.dueAt).toBe(DUE);
      // The longest extension is the resolution time of the policy counted on the working calendar: 16 working hours (07:30 to 17:00) from the
      // deadline, Tuesday 15:30, end Thursday 12:30 (13 August 05:30 UTC).
      const first = await extend(created.id, 3, CAP);
      expect(first).toMatchObject({ status: 'IN_PROGRESS', version: 4, previousDueAt: DUE, dueAt: CAP, extensionCount: 1, overdueSince: null });
      expect(await world.row(created.id)).toMatchObject({ extension_count: 1, overdue_since: null });
      const [event] = (await world.events(created.id)).slice(-1);
      expect(event).toMatchObject({ event_kind: 'EXTENDED', from_status: 'IN_PROGRESS', to_status: 'IN_PROGRESS', note: 'The landowner asked for time', created_by: memberId(PEOPLE.EXTENDER) });
      expect(event?.payload).toEqual({ previous_due_at: DUE, new_due_at: CAP, extension_number: 1, extension_limit: ISSUE_MAX_EXTENSIONS });
      const second = await extend(created.id, 4, '2026-08-14T08:30:00.000Z');
      expect(second).toMatchObject({ dueAt: '2026-08-14T08:30:00.000Z', extensionCount: 2, version: 5 });
      expect(await refusal(extend(created.id, 5, '2026-08-17T08:30:00.000Z'))).toEqual({ code: 'EXTENSION_LIMIT_REACHED', status: 422 });
      expect((await world.events(created.id)).filter((row) => row.event_kind === 'EXTENDED')).toHaveLength(2);
    });

    it('AC-ST-ISS-003-2: the handler cannot approve the extension of their own deadline; an independent person can', async () => {
      const created = await working();
      expect(await refusal(extend(created.id, 3, CAP, PEOPLE.WORKER_U1))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await versionOf(created.id)).toBe(3);
      expect((await extend(created.id, 3, CAP, PEOPLE.EXTENDER)).extensionCount).toBe(1);
    });

    it('AC-ST-ISS-003-2: keeps the day the issue became overdue, and records it when the old deadline had passed unnoticed (BR-ISS-04)', async () => {
      const created = await working();
      // Wednesday 09:00: the deadline of Tuesday has passed and no job has written overdue_since.
      const extended = await extend(created.id, 3, '2026-08-13T08:30:00.000Z', PEOPLE.EXTENDER, WEDNESDAY);
      expect(extended.overdueSince).toBe(DUE);
      expect(((await world.row(created.id)).overdue_since as Date).toISOString()).toBe(DUE);
      // The second extension keeps it.
      expect((await extend(created.id, 4, '2026-08-14T08:30:00.000Z', PEOPLE.EXTENDER, WEDNESDAY)).overdueSince).toBe(DUE);
      expect((await sqlRefusal(as((tx) => tx.query('update machvon.issue set overdue_since = null where id = $1::uuid', [created.id])))).message).toContain('BR-ISS-04');
    });

    it('bounds one extension by the resolution time of the policy on the working calendar, and refuses a date that does not move the deadline later or is in the past', async () => {
      const created = await working();
      // From the deadline, 16 working hours end Thursday 15:30; one millisecond more is refused.
      expect(await refusal(extend(created.id, 3, '2026-08-13T05:30:00.001Z'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_due_at' });
      expect(await refusal(extend(created.id, 3, DUE))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_due_at' });
      expect(await refusal(extend(created.id, 3, '2026-08-11T01:00:00.000Z'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_due_at' });
      expect(await refusal(extend(created.id, 3, 'tomorrow'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_due_at' });
      expect(await refusal(extend(created.id, 3, '2026-08-11T09:00:00.000Z', PEOPLE.EXTENDER, WEDNESDAY))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_due_at' });
      // An issue that is already late is counted from the day of the extension: 16 working hours from Wednesday 09:00 end Thursday 15:30.
      expect((await extend(created.id, 3, '2026-08-13T08:30:00.000Z', PEOPLE.EXTENDER, WEDNESDAY)).dueAt).toBe('2026-08-13T08:30:00.000Z');
      expect(await refusal(extend(created.id, 4, '2026-08-13T08:30:00.000Z'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_due_at' });
      expect(await refusal(as((tx) => closure.extend(tx, created.id, 4, { newDueAt: '2026-08-14T08:30:00.000Z', reason: ' ' }, memberId(PEOPLE.EXTENDER), extendScope(), NOW), TENANT_A, PEOPLE.EXTENDER))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'reason',
      });
    });

    it('refuses the extension of a closed issue or one that waits for its verification, and a stale version', async () => {
      const pending = await pendingVerification();
      expect(await refusal(extend(pending.id, 4, CAP))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
      const working1 = await working();
      expect((await refusal(extend(working1.id, 2, CAP))).code).toBe('VERSION_CONFLICT');
      expect(await refusal(as((tx) => closure.extend(tx, working1.id, 3, { newDueAt: CAP, reason: 'Out of scope' }, memberId(PEOPLE.EXTENDER), readerOfOtherUnit('issue.extend', PEOPLE.EXTENDER), NOW), TENANT_A, PEOPLE.EXTENDER))).toEqual({
        code: 'SCOPE_DENIED',
        status: 403,
      });
    });

    it('is held by the database: the deadline moves only later, with its extension counted', async () => {
      const created = await working();
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue set due_at = due_at + interval '1 day' where id = $1::uuid", [created.id])))).message).toContain('moves only later, by a counted extension');
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue set due_at = due_at - interval '1 day', extension_count = 1 where id = $1::uuid", [created.id])))).sqlstate).toBe('23514');
      expect((await sqlRefusal(as((tx) => tx.query('update machvon.issue set extension_count = 1 where id = $1::uuid', [created.id])))).message).toContain('counted only with the deadline');
      expect((await world.row(created.id)).extension_count).toBe(0);
    });

    it('reports how many extensions an issue has had', async () => {
      const created = await working();
      await extend(created.id, 3, CAP);
      expect(await as((tx) => closure.extensionsOf(tx, created.id))).toEqual({ used: 1, limit: ISSUE_MAX_EXTENSIONS });
    });
  });
});
