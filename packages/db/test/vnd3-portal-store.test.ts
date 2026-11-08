import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PORTAL_CONTRACTOR_TABLES, PORTAL_DENIED_TABLES, enterPortalPath, leavePortalPath } from '../src/portal-boundary';
import { CLAIM_OUTCOMES, PETITION_OUTCOMES, VendorDisputeStore, VendorOcdsReader } from '../src/vnd-dispute-store';
import { VendorPortalPolicyReader } from '../src/vnd3-portal-policy';
import { VendorPortalStore } from '../src/vnd-portal-store';
import { VendorReconfirmationStore } from '../src/vnd-reconfirmation-store';
import { VendorRemediationStore } from '../src/vnd-remediation-store';
import { WorkCalendarStore } from '../src/work-calendar-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const portal = new VendorPortalStore();
const reconfirmations = new VendorReconfirmationStore();
const remediation = new VendorRemediationStore();
const disputes = new VendorDisputeStore();
const ocds = new VendorOcdsReader();
const policies = new VendorPortalPolicyReader();
const calendars = new WorkCalendarStore();

const [STAFF, STAFF2, GUEST_A, GUEST_B, GUEST_IDLE] = [1, 2, 3, 4, 5];
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = STAFF): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the database to refuse');
};

async function document(): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', 'EFFECTIVE', $3, $3)`,
    [TENANT_A, id, memberId(STAFF)],
  );
  return id;
}

let counter = 0;
async function contractor(name: string): Promise<string> {
  counter += 1;
  const id = randomUUID();
  await owner(
    `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis)
     values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $8, 'EVIDENCE_DOCUMENT')`,
    [TENANT_A, id, `05${String(counter).padStart(8, '0')}`, name, await document(), memberId(STAFF), memberId(STAFF2), await document()],
  );
  return id;
}

const bind = (member: number, contractorId: string): Promise<unknown[]> =>
  owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(member), contractorId]);

const NOW = new Date('2026-11-09T03:00:00Z');
const later = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);
const TODAY = '2026-11-09';

describe('the contractor portal, the re-confirmation, the plans of remediation, the disputes and the export of parties (VND-3)', () => {
  let a = '';
  let b = '';
  let idle = '';

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    for (const member of [STAFF, STAFF2, GUEST_A, GUEST_B, GUEST_IDLE]) await harness.seedMembership(TENANT_A, member, 1);
    for (const year of [2026, 2027, 2028]) {
      await as(async (tx) => {
        const draft = await calendars.createDraft(tx, { calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code' }, memberId(STAFF));
        const locked = await calendars.lockDraft(tx, draft.id, draft.version);
        await calendars.publish(tx, locked, memberId(STAFF));
      });
    }
    a = await contractor('Cty Cong Thong A');
    b = await contractor('Cty Cong Thong B');
    idle = await contractor('Cty Khong Co Tai Khoan');
    await bind(GUEST_A, a);
    await bind(GUEST_B, b);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the boundary of the portal path in the database', () => {
    beforeAll(async () => {
      const staff = memberId(STAFF);
      await as(async (tx) => {
        await portal.create(tx, a, { kind: 'INFORMATION', title: 'Request to A for the boundary' }, staff, NOW);
        await portal.create(tx, b, { kind: 'INFORMATION', title: 'Request to B for the boundary' }, staff, NOW);
      });
      await owner(
        `insert into machvon.contractor_qualification (tenant_id, id, contractor_id, kind, certificate_no, grade, issuer, issued_on, expires_on, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, 'CONSTRUCTION_ACTIVITY', 'BOUNDARY-A', 'II', 'Issuer', date '2025-01-01', date '2030-01-01', $4, $4), ($1, gen_random_uuid(), $3, 'CONSTRUCTION_ACTIVITY', 'BOUNDARY-B', 'II', 'Issuer', date '2025-01-01', date '2030-01-01', $4, $4)`,
        [TENANT_A, a, b, staff],
      );
    });

    it('answers a contractor its own rows only, in every table of one contractor, and none of another contractor', async () => {
      const seen = await as(async (tx) => {
        await enterPortalPath(tx, a);
        const out: Record<string, string[]> = {};
        for (const [table, column] of Object.entries(PORTAL_CONTRACTOR_TABLES)) out[table] = (await tx.query<{ owner: string }>(`select distinct ${column}::text as owner from machvon.${table}`)).map((row) => row.owner);
        return out;
      }, GUEST_A);
      for (const [table, owners] of Object.entries(seen)) {
        expect([table, owners.filter((id) => id === b || id === idle)]).toEqual([table, []]);
      }
      expect(seen.contractor).toEqual([a]);
      expect(seen.contractor_portal_request).toEqual([a]);
      expect(seen.contractor_qualification).toEqual([a]);
    });

    it('refuses the tables of the investigation, the register of bans, the accounts and the reputation to the portal path: nothing is read and nothing is written', async () => {
      const counts = await as(async (tx) => {
        await enterPortalPath(tx, a);
        const out: Record<string, number> = {};
        for (const table of PORTAL_DENIED_TABLES) out[table] = (await tx.query(`select 1 from machvon.${table}`)).length;
        return out;
      }, GUEST_A);
      for (const [table, count] of Object.entries(counts)) expect([table, count]).toEqual([table, 0]);
      for (const table of ['red_flag_finding', 'vendor_investigation_lead', 'contractor_party_link', 'screening_hit', 'proposal_submission_trace', 'contractor_bank_account', 'contractor_restriction']) {
        const message = await databaseRefusal(
          as(async (tx) => {
            await enterPortalPath(tx, a);
            await tx.query(`insert into machvon.${table} (tenant_id) values (nullif(current_setting('app.tenant_id', true), '')::uuid)`);
          }, GUEST_A),
        );
        expect([table, message]).toEqual([table, expect.stringMatching(/row-level security|violates/)]);
      }
    });

    it('holds the rows of the investigation for the staff path, which is not changed by the portal policy', async () => {
      const rows = await owner<{ n: string }>("select count(*)::text as n from machvon.contractor where id in ($1, $2)", [a, b]);
      expect(rows[0]?.n).toBe('2');
      const staffSees = await as(async (tx) => (await tx.query('select id from machvon.contractor where id = any($1::uuid[])', [[a, b]])).length);
      expect(staffSees).toBe(2);
      const cleared = await as(async (tx) => {
        await enterPortalPath(tx, a);
        const own = (await tx.query('select id from machvon.contractor where id = any($1::uuid[])', [[a, b]])).length;
        await leavePortalPath(tx);
        const all = (await tx.query('select id from machvon.contractor where id = any($1::uuid[])', [[a, b]])).length;
        return { own, all };
      }, GUEST_A);
      expect(cleared).toEqual({ own: 1, all: 2 });
    });

    it('refuses to enter the portal path with anything that is not a uuid, and refuses a caller who is not a guest contractor', async () => {
      await expect(as((tx) => enterPortalPath(tx, "x'; drop table machvon.contractor; --"))).rejects.toThrow();
      expect((await refusal(as((tx) => portal.enter(tx, memberId(STAFF))))).code).toBe('PORTAL_CONTRACTOR_REQUIRED');
      const caller = await as((tx) => portal.enter(tx, memberId(GUEST_A)), GUEST_A);
      expect(caller.contractorId).toBe(a);
    });
  });

  describe('the requests', () => {
    it('counts the limit by the rule of the kind on the working calendar, keeps the version of the rule, and needs a guest account bound to the contractor', async () => {
      const row = await as((tx) => portal.create(tx, a, { kind: 'INFORMATION', title: 'Please send the list of staff', body: 'The list as of today' }, memberId(STAFF), NOW));
      expect(row).toMatchObject({ status: 'OPEN', kind: 'INFORMATION', deadlinePolicyVersion: 'builtin', remindBeforeDays: 2, round: 1, clock: 'ON_TIME' });
      // Ten working days after Monday 9 November 2026, the end of the working day of Vietnam: Monday 23 November.
      expect(row.dueAt.slice(0, 10)).toBe('2026-11-23');
      expect((await refusal(as((tx) => portal.create(tx, idle, { kind: 'INFORMATION', title: 'Nobody can answer this' }, memberId(STAFF), NOW)))).code).toBe('CONTRACTOR_PORTAL_NOT_BOUND');
      expect((await refusal(as((tx) => portal.create(tx, randomUUID(), { kind: 'INFORMATION', title: 'Nobody can answer this' }, memberId(STAFF), NOW)))).code).toBe('RESOURCE_NOT_FOUND');
      expect((await refusal(as((tx) => portal.create(tx, a, { kind: 'INFORMATION', title: 'A day in the past', dueOn: '2026-11-01' }, memberId(STAFF), NOW)))).detail).toBe('due_on');
      expect((await refusal(as((tx) => portal.create(tx, a, { kind: 'INFORMATION', title: 'A subject of another', subjectType: 'QUALIFICATION', subjectId: randomUUID() }, memberId(STAFF), NOW)))).detail).toBe('subject_id');
    });

    it('lets the contractor answer, marks a late answer late and never refuses it, and keeps the history of the moves', async () => {
      const onTime = await as((tx) => portal.create(tx, a, { kind: 'INFORMATION', title: 'An answer on time', dueOn: '2026-11-20' }, memberId(STAFF), NOW));
      const answered = await as(async (tx) => portal.respond(tx, await portal.enter(tx, memberId(GUEST_A)), onTime.id, onTime.version, { text: 'Here is the answer' }, later(1)), GUEST_A);
      expect(answered).toMatchObject({ status: 'RESPONDED', responseLate: false, clock: 'ANSWERED', respondedBy: memberId(GUEST_A), version: 2 });
      const lateRow = await as((tx) => portal.create(tx, a, { kind: 'INFORMATION', title: 'An answer too late', dueOn: TODAY }, memberId(STAFF), NOW));
      const lateAnswered = await as(async (tx) => portal.respond(tx, await portal.enter(tx, memberId(GUEST_A)), lateRow.id, lateRow.version, { text: 'Sorry, here it is' }, later(3)), GUEST_A);
      expect(lateAnswered).toMatchObject({ status: 'RESPONDED', responseLate: true, clock: 'ANSWERED_LATE' });
      const events = await as((tx) => portal.events(tx, lateRow.id));
      expect(events.map((event) => event.move)).toEqual(['OPEN', 'RESPOND']);
      // The same request cannot be answered twice, an empty answer is refused and an old version is a conflict.
      expect((await refusal(as(async (tx) => portal.respond(tx, await portal.enter(tx, memberId(GUEST_A)), lateRow.id, 2, { text: 'Again' }, later(4)), GUEST_A))).code).toBe('PORTAL_REQUEST_STATE_INVALID');
      const fresh = await as((tx) => portal.create(tx, a, { kind: 'INFORMATION', title: 'An empty answer', dueOn: '2026-11-25' }, memberId(STAFF), NOW));
      expect((await refusal(as(async (tx) => portal.respond(tx, await portal.enter(tx, memberId(GUEST_A)), fresh.id, 1, {}, later(1)), GUEST_A))).detail).toBe('text');
      expect((await refusal(as(async (tx) => portal.respond(tx, await portal.enter(tx, memberId(GUEST_A)), fresh.id, 7, { text: 'x' }, later(1)), GUEST_A))).code).toBe('VERSION_CONFLICT');
    });

    it('is not found for a contractor that asks for the request of another contractor', async () => {
      const forB = await as((tx) => portal.create(tx, b, { kind: 'INFORMATION', title: 'A request to B only', dueOn: '2026-11-25' }, memberId(STAFF), NOW));
      expect((await refusal(as(async (tx) => portal.respond(tx, await portal.enter(tx, memberId(GUEST_A)), forB.id, forB.version, { text: 'Not mine' }, later(1)), GUEST_A))).code).toBe('RESOURCE_NOT_FOUND');
      const own = await as(async (tx) => portal.listOwn(tx, await portal.enter(tx, memberId(GUEST_A)), undefined, later(1)), GUEST_A);
      expect(own.some((row) => row.id === forB.id)).toBe(false);
      expect(own.every((row) => row.contractorId === a)).toBe(true);
    });

    it('is accepted by somebody other than the person who answered; returned with a reason it opens again for another round and keeps the last answer', async () => {
      const made = await as((tx) => portal.create(tx, a, { kind: 'INFORMATION', title: 'A round trip request', dueOn: '2026-11-25' }, memberId(STAFF), NOW));
      const answered = await as(async (tx) => portal.respond(tx, await portal.enter(tx, memberId(GUEST_A)), made.id, made.version, { text: 'First answer' }, later(1)), GUEST_A);
      expect((await refusal(as((tx) => portal.accept(tx, made.id, answered.version, memberId(GUEST_A), later(1))))).code).toBe('SELF_APPROVAL_DENIED');
      expect((await refusal(as((tx) => portal.returnRequest(tx, made.id, answered.version, 'no', memberId(STAFF), later(1))))).code).toBe('VALIDATION_FAILED');
      const returned = await as((tx) => portal.returnRequest(tx, made.id, answered.version, 'Please add the signed page', memberId(STAFF), later(1)));
      expect(returned).toMatchObject({ status: 'OPEN', round: 2, reviewNote: 'Please add the signed page', responseText: 'First answer' });
      const second = await as(async (tx) => portal.respond(tx, await portal.enter(tx, memberId(GUEST_A)), made.id, returned.version, { text: 'Second answer' }, later(2)), GUEST_A);
      const accepted = await as((tx) => portal.accept(tx, made.id, second.version, memberId(STAFF), later(2)));
      expect(accepted).toMatchObject({ status: 'ACCEPTED', reviewedBy: memberId(STAFF), responseText: 'Second answer' });
      expect((await as((tx) => portal.events(tx, made.id))).map((event) => event.move)).toEqual(['OPEN', 'RESPOND', 'RETURN', 'RESPOND', 'ACCEPT']);
      expect((await refusal(as((tx) => portal.cancel(tx, made.id, accepted.version, 'Too late to cancel', memberId(STAFF), later(3))))).code).toBe('PORTAL_REQUEST_STATE_INVALID');
    });

    it('cancels with a reason and reports the figures of the answers on time and late', async () => {
      const made = await as((tx) => portal.create(tx, a, { kind: 'OTHER', title: 'Asked by mistake', dueOn: '2026-11-25' }, memberId(STAFF), NOW));
      const cancelled = await as((tx) => portal.cancel(tx, made.id, made.version, 'Asked by mistake', memberId(STAFF), later(1)));
      expect(cancelled.status).toBe('CANCELLED');
      const figures = await as((tx) => portal.figures(tx, later(30)));
      expect(figures.answeredInTime).toBeGreaterThanOrEqual(2);
      expect(figures.answeredLate).toBeGreaterThanOrEqual(1);
      const waiting = await as((tx) => portal.alertable(tx, later(30)));
      expect(waiting.every((row) => row.status === 'RESPONDED' || row.clock === 'OVERDUE' || row.clock === 'DUE_SOON')).toBe(true);
    });

    it('takes a certificate from the contractor, unverified, entered by the guest and verified by somebody else only', async () => {
      const row = await as(async (tx) => portal.submitQualification(tx, await portal.enter(tx, memberId(GUEST_A)), { kind: 'TAX_CLEARANCE', certificateNo: 'TAX-2026-1', issuer: 'Tax department', issuedOn: '2026-10-01', expiresOn: '2027-10-01' }, undefined, NOW), GUEST_A);
      expect(row).toMatchObject({ contractorId: a, verifiedAt: null, createdBy: memberId(GUEST_A) });
      const held = await as(async (tx) => portal.ownQualifications(tx, await portal.enter(tx, memberId(GUEST_A)), TODAY), GUEST_A);
      expect(held.qualifications.find((entry) => entry.id === row.id)?.state).toBe('VALID');
      expect(held.qualifications.every((entry) => entry.contractorId === a)).toBe(true);
      const others = await as(async (tx) => portal.ownQualifications(tx, await portal.enter(tx, memberId(GUEST_B)), TODAY), GUEST_B);
      expect(others.qualifications.some((entry) => entry.id === row.id)).toBe(false);
    });

    it('shows the evaluations that were approved, of the contractor itself', async () => {
      const contract = randomUUID();
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query('set session_replication_role = replica');
        for (const [owner_, status] of [[a, 'APPROVED'], [a, 'DRAFT'], [b, 'APPROVED']] as const) {
          await client.query(
            `insert into machvon.contractor_performance (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, revision, score_quality, score_schedule, score_safety_env, score_cooperation, score_financial, overall_score, rating, status, evaluated_by, approved_by, approved_at, created_by, updated_by)
             values ($1, $2, $3, $4, 'PERIODIC', $5, 1, 70, 70, 70, 70, 70, 70, 'GOOD', $6, $7, $8, case when $6::text = 'APPROVED' then now() else null end, $7, $7)`,
            [TENANT_A, randomUUID(), contract, owner_, `2026-Q${status === 'DRAFT' ? 1 : 3}-${owner_.slice(0, 4)}`, status, memberId(STAFF), status === 'APPROVED' ? memberId(STAFF2) : null],
          );
        }
      } finally {
        await client.end();
      }
      const list = await as(async (tx) => portal.ownEvaluations(tx, await portal.enter(tx, memberId(GUEST_A))), GUEST_A);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ rating: 'GOOD', overallScore: 70 });
    });
  });

  describe('the re-confirmation', () => {
    it('is never confirmed at first, refuses a declaration that is not in force, and sets the next day when the contractor confirms', async () => {
      const view = await as(async (tx) => reconfirmations.current(tx, await portal.enter(tx, memberId(GUEST_A)), TODAY), GUEST_A);
      expect(view).toMatchObject({ state: 'NEVER', dueOn: null, declarationVersion: 'V1', intervalMonths: 12, policyVersion: 'builtin' });
      expect(view.declarationText.length).toBeGreaterThan(40);
      const confirm = (input: { declarationVersion: string; accepted: boolean }, when = NOW) => as(async (tx) => reconfirmations.confirm(tx, await portal.enter(tx, memberId(GUEST_A)), input, when), GUEST_A);
      expect((await refusal(confirm({ declarationVersion: 'V0', accepted: true }))).code).toBe('RECONFIRMATION_DECLARATION_STALE');
      expect((await refusal(confirm({ declarationVersion: 'V1', accepted: false }))).detail).toBe('accepted');
      const done = await confirm({ declarationVersion: 'V1', accepted: true });
      expect(done).toMatchObject({ contractorId: a, confirmedOn: TODAY, nextDueOn: '2027-11-09' });
      const [row] = await owner<{ next_review_due: string; profile_reviewed_at: string | null }>('select next_review_due::text, profile_reviewed_at::text from machvon.contractor where id = $1', [a]);
      expect(row?.next_review_due).toBe('2027-11-09');
      expect(row?.profile_reviewed_at).not.toBeNull();
      const after = await as(async (tx) => reconfirmations.current(tx, await portal.enter(tx, memberId(GUEST_A)), TODAY), GUEST_A);
      expect(after.state).toBe('CURRENT');
      const [saved] = await owner<{ declaration_sha256: string; profile_sha256: string; satisfied_due_on: string | null }>('select declaration_sha256, profile_sha256, satisfied_due_on::text from machvon.contractor_reconfirmation where id = $1', [done.id]);
      expect(saved?.declaration_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(saved?.profile_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(saved?.satisfied_due_on).toBeNull();
      // A confirmation is a record for good.
      expect(await databaseRefusal(owner('update machvon.contractor_reconfirmation set changes_note = $2 where id = $1', [done.id, 'rewritten']))).toMatch(/never changed|appended once/);
    });

    it('lists the verified contractors with the state of each, counts them, and measures how many are current', async () => {
      const listed = await as((tx) => reconfirmations.list(tx, {}, '2027-11-10'));
      const mine = listed.items.find((line) => line.contractorId === a);
      expect(mine?.state).toBe('OVERDUE');
      expect(listed.items.find((line) => line.contractorId === b)?.state).toBe('NEVER');
      expect(listed.counts.overdue).toBeGreaterThanOrEqual(1);
      const today = await as((tx) => reconfirmations.list(tx, { state: 'CURRENT' }, TODAY));
      expect(today.items.map((line) => line.contractorId)).toEqual([a]);
      expect(today.currentPct).not.toBeNull();
      const due = await as((tx) => reconfirmations.alertable(tx, '2027-11-10', { remind_days: 30, grace_days: 30 }));
      expect(due.find((line) => line.contractorId === a)?.facet).toBe('OVERDUE');
    });
  });

  describe('the plans of remediation', () => {
    it('runs a plan from the proposal to its completion with an agreement by the contractor, actions marked done and verified by somebody else', async () => {
      const staff = memberId(STAFF);
      const plan = await as((tx) => remediation.create(tx, a, { title: 'Quality of the works', objective: 'Bring the defects down to zero', triggerKind: 'POOR_EVALUATION', actions: [{ description: 'Repair the cracks', dueOn: '2026-12-01' }, { description: 'Retrain the site team', dueOn: '2026-12-15' }] }, staff, NOW));
      expect(plan).toMatchObject({ status: 'PROPOSED', actionCount: 2, verifiedCount: 0, overdueCount: 0, contractorId: a });
      // Another contractor cannot agree to it; the contractor itself can; staff cannot start before the agreement.
      expect((await refusal(as(async (tx) => remediation.agree(tx, await portal.enter(tx, memberId(GUEST_B)), plan.id, plan.version, NOW), GUEST_B))).code).toBe('RESOURCE_NOT_FOUND');
      expect((await refusal(as((tx) => remediation.start(tx, plan.id, plan.version, staff, NOW)))).code).toBe('REMEDIATION_STATE_INVALID');
      const agreed = await as(async (tx) => remediation.agree(tx, await portal.enter(tx, memberId(GUEST_A)), plan.id, plan.version, later(1)), GUEST_A);
      expect(agreed).toMatchObject({ status: 'AGREED', agreedBy: memberId(GUEST_A) });
      const [first, second] = await as((tx) => remediation.actions(tx, plan.id, TODAY));
      // An action is done only while the plan is in progress.
      expect((await refusal(as(async (tx) => remediation.markDone(tx, await portal.enter(tx, memberId(GUEST_A)), (first as { id: string }).id, 1, { note: 'Done early' }, later(1)), GUEST_A))).code).toBe('REMEDIATION_STATE_INVALID');
      const started = await as((tx) => remediation.start(tx, plan.id, agreed.version, staff, later(1)));
      expect(started.status).toBe('IN_PROGRESS');
      expect((await refusal(as((tx) => remediation.complete(tx, plan.id, started.version, staff, later(2))))).code).toBe('REMEDIATION_STATE_INVALID');
      const done = await as(async (tx) => remediation.markDone(tx, await portal.enter(tx, memberId(GUEST_A)), (first as { id: string }).id, 1, { note: 'The cracks were repaired' }, later(5)), GUEST_A);
      expect(done).toMatchObject({ status: 'DONE', doneBy: memberId(GUEST_A) });
      expect((await refusal(as((tx) => remediation.verify(tx, done.id, done.version, 'VERIFIED', undefined, memberId(GUEST_A), later(6)), GUEST_A))).code).toBe('SELF_APPROVAL_DENIED');
      const reopened = await as((tx) => remediation.verify(tx, done.id, done.version, 'REOPEN', 'The photos show the cracks again', staff, later(6)));
      expect(reopened).toMatchObject({ status: 'OPEN', doneAt: null, verifyNote: 'The photos show the cracks again' });
      const again = await as(async (tx) => remediation.markDone(tx, await portal.enter(tx, memberId(GUEST_A)), reopened.id, reopened.version, { note: 'Repaired again, with photos' }, later(8)), GUEST_A);
      const verified = await as((tx) => remediation.verify(tx, again.id, again.version, 'VERIFIED', 'Photos checked on site', staff, later(9)));
      expect(verified.status).toBe('VERIFIED');
      const secondDone = await as(async (tx) => remediation.markDone(tx, await portal.enter(tx, memberId(GUEST_A)), (second as { id: string }).id, 1, { note: 'Training given' }, later(10)), GUEST_A);
      const current = await as((tx) => remediation.findPlan(tx, plan.id, TODAY));
      // One action is still not verified: the plan cannot be completed.
      expect((await refusal(as((tx) => remediation.complete(tx, plan.id, (current as { version: number }).version, staff, later(11))))).code).toBe('REMEDIATION_STATE_INVALID');
      await as((tx) => remediation.verify(tx, secondDone.id, secondDone.version, 'VERIFIED', undefined, staff, later(11)));
      const completed = await as((tx) => remediation.complete(tx, plan.id, (current as { version: number }).version, staff, later(12)));
      expect(completed).toMatchObject({ status: 'COMPLETED', verifiedCount: 2 });
      const events = await as((tx) => remediation.events(tx, plan.id));
      expect(events.map((event) => event.move)).toEqual(['PROPOSE', 'ADD_ACTION', 'ADD_ACTION', 'AGREE', 'START', 'MARK_DONE', 'REOPEN_ACTION', 'MARK_DONE', 'VERIFY', 'MARK_DONE', 'VERIFY', 'COMPLETE']);
    });

    it('refuses an action beyond the longest plan, a contract of another contractor and a contractor with no account, and closes with a reason', async () => {
      const staff = memberId(STAFF);
      const base = { title: 'A plan that is too long', objective: 'An objective of ten characters', triggerKind: 'MANUAL' as const };
      expect((await refusal(as((tx) => remediation.create(tx, a, { ...base, actions: [{ description: 'Far away action', dueOn: '2030-01-01' }] }, staff, NOW)))).detail).toBe('due_on');
      expect((await refusal(as((tx) => remediation.create(tx, a, { ...base, actions: [{ description: 'An action in the past', dueOn: '2026-11-01' }] }, staff, NOW)))).detail).toBe('due_on');
      expect((await refusal(as((tx) => remediation.create(tx, a, { ...base, contractId: randomUUID(), actions: [{ description: 'An action of a contract', dueOn: '2026-12-01' }] }, staff, NOW)))).detail).toBe('contract_id');
      expect((await refusal(as((tx) => remediation.create(tx, idle, { ...base, actions: [{ description: 'Nobody can agree', dueOn: '2026-12-01' }] }, staff, NOW)))).code).toBe('CONTRACTOR_PORTAL_NOT_BOUND');
      const plan = await as((tx) => remediation.create(tx, a, { ...base, title: 'A plan to cancel', actions: [{ description: 'An action to drop', dueOn: '2026-12-01' }] }, staff, NOW));
      expect((await refusal(as((tx) => remediation.close(tx, plan.id, plan.version, 'CANCELLED', 'no', staff, NOW)))).code).toBe('VALIDATION_FAILED');
      const closed = await as((tx) => remediation.close(tx, plan.id, plan.version, 'CANCELLED', 'The evaluation was withdrawn', staff, later(1)));
      expect(closed).toMatchObject({ status: 'CANCELLED', closedReason: 'The evaluation was withdrawn' });
    });

    it('lists the plans of the contractor with their actions and raises the alert for an action that is due or late', async () => {
      const staff = memberId(STAFF);
      const plan = await as((tx) => remediation.create(tx, b, { title: 'A plan with a late action', objective: 'An objective of ten characters', triggerKind: 'MANUAL', actions: [{ description: 'An action that will be late', dueOn: '2026-11-12' }] }, staff, NOW));
      const agreed = await as(async (tx) => remediation.agree(tx, await portal.enter(tx, memberId(GUEST_B)), plan.id, plan.version, NOW), GUEST_B);
      const own = await as(async (tx) => remediation.ownPlans(tx, await portal.enter(tx, memberId(GUEST_B)), TODAY), GUEST_B);
      expect(own.every((entry) => entry.plan.contractorId === b)).toBe(true);
      expect(own.find((entry) => entry.plan.id === plan.id)?.actions).toHaveLength(1);
      expect(agreed.status).toBe('AGREED');
      const alerts = await as((tx) => remediation.alertable(tx, '2026-11-14'));
      expect(alerts.find((entry) => entry.planId === plan.id)).toMatchObject({ facet: 'REMEDIATION_OVERDUE', contractorName: 'Cty Cong Thong B' });
      const soon = await as((tx) => remediation.alertable(tx, '2026-11-10'));
      expect(soon.find((entry) => entry.planId === plan.id)?.facet).toBe('REMEDIATION_DUE');
    });
  });

  describe('the disputes and the export of parties', () => {
    it('folds the words of the sources to four outcomes and reports an empty register without inventing a figure', async () => {
      expect(PETITION_OUTCOMES.RECEIVED).toBe('OPEN');
      expect(PETITION_OUTCOMES.WITHDRAWN).toBe('WITHDRAWN');
      expect(CLAIM_OUTCOMES.SETTLED).toBe('UPHELD');
      expect(CLAIM_OUTCOMES.TIME_BARRED).toBe('REJECTED');
      expect(CLAIM_OUTCOMES.REFERRED).toBe('OPEN');
      const report = await as((tx) => disputes.report(tx, a));
      expect(report.stats).toEqual({ total: 0, open: 0, upheld: 0, rejected: 0, withdrawn: 0, upheldPct: null, meanDaysToClose: null });
      expect(report.portfolio.total).toBe(0);
    });

    it('exports the parties that bid with the tax code as identifier, and holds the owners and the contact back unless the rule says so', async () => {
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query('set session_replication_role = replica');
        await client.query(
          `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, bid_price_vnd, access_released_at, classification, created_by, version)
           values ($1, $2, $3, $4, $5, '[]'::jsonb, 1, 'RECEIVED', now(), 1000, now(), 'CONFIDENTIAL', $6, 1)`,
          [TENANT_A, randomUUID(), randomUUID(), randomUUID(), a, memberId(STAFF)],
        );
      } finally {
        await client.end();
      }
      await owner("update machvon.contractor set registered_address = '12 Le Loi, District 1', phone = '0912345678', phone_key = repeat('a', 64), phone_set_at = now(), legal_rep_name = 'Nguyen Van A' where id = $1", [a]);
      await owner(
        `insert into machvon.contractor_owner (tenant_id, id, contractor_id, owner_kind, owner_name, name_key, share_pct, beneficial_owner, created_by, updated_by) values ($1, gen_random_uuid(), $2, 'PERSON', 'Tran Van Owner', repeat('b', 64), 60, true, $3, $3)`,
        [TENANT_A, a, memberId(STAFF)],
      );
      const policy = await as((tx) => policies.ocds(tx, TODAY));
      expect(policy.value).toEqual({ include_owners: false, include_contact: false });
      expect(policy.unverified).toBe(true);
      const found = await as((tx) => ocds.parties(tx, {}, TODAY));
      const party = found.parties.find((entry) => entry.identifier.id.startsWith('05'));
      expect(party).toMatchObject({ roles: ['tenderer'], address: { streetAddress: '12 Le Loi, District 1', countryName: 'Viet Nam' } });
      expect(party?.id).toBe(`VN-MST-${party?.identifier.id}`);
      expect(party?.beneficialOwners).toBeUndefined();
      expect(party?.contactPoint).toBeUndefined();
      expect(found.parties.map((entry) => entry.identifier.id)).not.toContain((await owner<{ tax_identifier: string }>('select tax_identifier from machvon.contractor where id = $1', [idle]))[0]?.tax_identifier);
    });
  });
});
