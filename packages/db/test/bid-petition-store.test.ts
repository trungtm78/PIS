import { randomUUID } from 'node:crypto';
import { BidPetitionDue } from '../src/bid-petition-due';
import { BidPetitionStore } from '../src/bid-petition-store';
import type { ReceiveInput } from '../src/bid-petition-store';
import { AuditWriter } from '../src/audit-writer';
import { BASELINE_PACK, applyBaseline, sealPack } from '../src/master-baseline';
import type { BaselineEntry } from '../src/master-baseline';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { WorkCalendarStore } from '../src/work-calendar-store';
import { AuthzHarness, TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { DEPARTMENT, PROVINCE, everything, nothing, seedAs, seedBidPackage, seedContractor } from './support/bid-proposal-fixtures';
import type { SeededPackage } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const petitions = new BidPetitionStore();
const calendars = new WorkCalendarStore();
const FAMILY = 0xb1;
const LOGGER = 1;
const HANDLER = 2;
const CONFLICTED = 3;
const JOB = 4;
const RECEIVED_ON = '2026-11-25';
const NOW = new Date('2026-11-25T03:00:00Z');
/** Seven working days after Wednesday 25 November 2026. */
const DUE_ON = '2026-12-04';
const day = (iso: string): Date => new Date(`${iso}T03:00:00Z`);

let counter = 0;
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = LOGGER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<{ message: string; sqlstate: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string };
    return { message: e.message, sqlstate: e.code ?? '' };
  }
  throw new Error('expected the database to refuse');
};

/** A document of the tenant (a petition, or the reply to one). */
async function paper(): Promise<string> {
  counter += 1;
  const documentId = randomUUID();
  await seedAs(harness, [
    [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'CV', $3, 'INTERNAL', $4, $4)`, [TENANT_A, documentId, `Paper ${counter}`, memberId(LOGGER)]],
  ]);
  return documentId;
}

interface Setup {
  seeded: SeededPackage;
  contractor: string;
}

const setup = async (): Promise<Setup> => ({ seeded: await seedBidPackage(harness), contractor: await seedContractor(harness) });

const receive = async (s: Setup, overrides: Partial<ReceiveInput> = {}, options: { scope?: ScopeBuilder; now?: Date; member?: number } = {}) =>
  as(
    async (tx) =>
      petitions.receive(tx, { packageId: s.seeded.packageId, contractorId: s.contractor, petitionKind: 'PROCESS', receivedOn: RECEIVED_ON, petitionDocumentId: overrides.petitionDocumentId ?? (await paper()), ...overrides }, memberId(options.member ?? LOGGER), options.scope ?? everything, options.now ?? NOW),
    options.member ?? LOGGER,
  );
const resolve = async (petitionId: string, version: number, overrides: Partial<{ outcome: string; resolutionDocumentId: string }> = {}, options: { scope?: ScopeBuilder; now?: Date; member?: number } = {}) =>
  as(
    async (tx) => petitions.resolve(tx, petitionId, version, { outcome: 'RESOLVED', resolutionDocumentId: overrides.resolutionDocumentId ?? (await paper()), ...overrides }, memberId(options.member ?? HANDLER), options.scope ?? everything, options.now ?? NOW),
    options.member ?? HANDLER,
  );
const row = async (petitionId: string) =>
  (
    await owner<{ status: string; due_on: string; received_on: string; days_applied: number; rule_version_id: string; handled_by: string | null; resolution_document_id: string | null; resolved_at: string | null; overdue_notified_at: string | null; version: string }>(
      'select status, due_on::text, received_on::text, days_applied, rule_version_id, handled_by, resolution_document_id, resolved_at::text, overdue_notified_at::text, version::text from machvon.procurement_petition where id = $1::uuid',
      [petitionId],
    )
  )[0];

/** A conflict of interest that a member declared against a contractor, or against the whole package, that nobody has decided yet. */
const declareConflict = (s: Setup, member: number, contractorId: string | null, decision: string | null = null) =>
  seedAs(harness, [
    [
      `insert into machvon.bid_conflict_declaration (tenant_id, id, package_id, user_id, has_conflict, relation_text, contractor_id, declared_at, decision, decided_by, decided_at, decision_reason, created_by, updated_by, version)
       values ($1, $2, $3, $4, true, 'A relative', $5, now(), $6, $7, case when $6::text is null then null else now() end, case when $6::text is null then null else 'Reviewed by the committee of the package' end, $4, $4, 1)`,
      [TENANT_A, randomUUID(), s.seeded.packageId, memberId(member), contractorId, decision, decision === null ? null : memberId(LOGGER)],
    ],
  ]);

const workingRule = (key: 'PROCESS' | 'RESULT', attributes: Record<string, unknown> = {}): BaselineEntry => ({
  masterType: 'BID_PETITION',
  businessKey: key,
  label: `Deadline of a petition (${key}) in working days`,
  attributes: { owner_module: 'BID', awaiting_confirmation: false, days: 7, day_count: 'WORKING', calendar_code: 'WORKDAY_VN', ...attributes },
  validFrom: '2026-06-01',
  legalBasis: 'Luật Đấu thầu 22/2023/QH15',
});

describe('the petitions of contractors (ST-BID-007)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
    ]);
    for (const n of [LOGGER, HANDLER, CONFLICTED, JOB]) await harness.seedMembership(TENANT_A, n, PROVINCE);
    await as((tx) => applyBaseline(tx, BASELINE_PACK, memberId(LOGGER), '2026-06-01'));
    // The working calendar of 2026: Monday to Friday, no holiday in the weeks the tests count through.
    await as(async (tx) => {
      const draft = await calendars.createDraft(tx, { calendar_code: 'WORKDAY_VN', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code' }, memberId(LOGGER));
      const locked = await calendars.lockDraft(tx, draft.id, draft.version);
      await calendars.publish(tx, locked, memberId(LOGGER));
    });
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the deadline is rule data', () => {
    it('counts calendar days with the rule of the baseline (waiting for confirmation), and keeps the version of the rule it used', async () => {
      const s = await setup();
      const done = await receive(s);
      expect(done).toMatchObject({ petitionKind: 'PROCESS', receivedOn: RECEIVED_ON, dueOn: '2026-12-02', daysApplied: 7, status: 'RECEIVED', fromStatus: null, version: 1, late: false });
      const [rule] = await owner<{ id: string }>("select v.id from machvon.master_record_version v where v.master_type = 'BID_PETITION' and v.code = 'PROCESS' order by v.revision desc limit 1");
      expect(await row(done.id)).toMatchObject({ status: 'RECEIVED', due_on: '2026-12-02', received_on: RECEIVED_ON, days_applied: 7, rule_version_id: rule?.id, handled_by: null, resolution_document_id: null, overdue_notified_at: null });
      expect(done.ruleVersionId).toBe(rule?.id);
    });

    it('AC-ST-BID-007-1, UAT-AC456: counts the working days of the calendar of the tenant (7 working days from 2026-11-25 end on 2026-12-04), shows the petition overdue the day after, and answers it only with a document', async () => {
      await as((tx) => applyBaseline(tx, sealPack('BID-PETITION-WORKING', [workingRule('PROCESS')]), memberId(LOGGER), '2026-06-01'));
      const s = await setup();
      const done = await receive(s);
      expect(done).toMatchObject({ dueOn: DUE_ON, daysApplied: 7 });
      expect((await row(done.id))?.due_on).toBe(DUE_ON);

      // The clock passes the deadline: on its last day the petition is not overdue, the day after it is.
      const onLastDay = await as((tx) => petitions.find(tx, done.id, everything, memberId(LOGGER), day(DUE_ON)));
      expect(onLastDay).toMatchObject({ overdue: false, daysOverdue: 0, status: 'RECEIVED' });
      const after = await as((tx) => petitions.find(tx, done.id, everything, memberId(LOGGER), day('2026-12-05')));
      expect(after).toMatchObject({ overdue: true, daysOverdue: 1, dueOn: DUE_ON });
      expect((await as((tx) => petitions.find(tx, done.id, everything, memberId(LOGGER), day('2026-12-10'))))?.daysOverdue).toBe(6);

      // The job finds it overdue on the first pass and says so once.
      const job = new BidPetitionDue(new AuditWriter(harness.tenants));
      // (The tenant holds the petitions of the other cases too: the pass on the last day settles the ones that are already late, and ours is not among them.)
      const before = await as((tx) => job.run(tx, memberId(JOB), day(DUE_ON)), JOB);
      expect((await row(done.id))?.overdue_notified_at).toBeNull();
      expect(await as((tx) => job.run(tx, memberId(JOB), day('2026-12-05')), JOB)).toEqual({ reminded: 1, overdue: before.overdue + 1 });
      expect(await as((tx) => job.run(tx, memberId(JOB), day('2026-12-05')), JOB)).toEqual({ reminded: 0, overdue: before.overdue + 1 });
      expect(await as((tx) => job.run(tx, memberId(JOB), day('2026-12-09')), JOB)).toEqual({ reminded: 0, overdue: before.overdue + 1 });
      expect((await row(done.id))?.overdue_notified_at).not.toBeNull();
      const [event] = await owner<{ payload: Record<string, unknown>; aggregate_version: string; type: string }>(
        "select payload, aggregate_version::text, type from machvon.outbox_event where aggregate_id = $1 and type = 'bid.petition.overdue.v1'",
        [done.id],
      );
      expect(event?.payload).toMatchObject({ petition_id: done.id, package_id: s.seeded.packageId, petition_kind: 'PROCESS', due_on: DUE_ON, days_overdue: 1, tenant_id: TENANT_A });
      expect((event?.payload.notification as { resource: Record<string, unknown>; deepLink: string }).resource).toMatchObject({ type: 'procurement_package', id: s.seeded.packageId });
      expect(JSON.stringify(event?.payload)).not.toContain(s.contractor);
      const [audit] = await owner<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'petition.overdue'", [done.id]);
      expect(audit?.safe_diff).toMatchObject({ days_overdue: 1, due_on: DUE_ON });
      expect(await owner("select 1 from machvon.outbox_event where aggregate_id = $1 and type = 'bid.petition.overdue.v1'", [done.id])).toHaveLength(1);
      expect((await row(done.id))?.version).toBe('1');

      // Answering without a document is refused; with one the petition is RESOLVED, late.
      expect(await refusal(resolve(done.id, 1, { resolutionDocumentId: '' }, { now: day('2026-12-09') }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'resolution_document_id' });
      expect(await refusal(resolve(done.id, 1, { resolutionDocumentId: randomUUID() }, { now: day('2026-12-09') }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'resolution_document_id' });
      expect((await row(done.id))?.status).toBe('RECEIVED');
      const reply = await paper();
      const answered = await resolve(done.id, 1, { resolutionDocumentId: reply }, { now: day('2026-12-09') });
      expect(answered).toMatchObject({ fromStatus: 'RECEIVED', status: 'RESOLVED', version: 2, resolutionDocumentId: reply, late: true });
      expect(await row(done.id)).toMatchObject({ status: 'RESOLVED', handled_by: memberId(HANDLER), resolution_document_id: reply, version: '2' });
      expect((await row(done.id))?.resolved_at).not.toBeNull();
      // Once answered it is no longer overdue and the job does not count it.
      expect(await as((tx) => petitions.find(tx, done.id, everything, memberId(LOGGER), day('2026-12-20')))).toMatchObject({ overdue: false, status: 'RESOLVED', handledBy: { membershipId: memberId(HANDLER) } });
      expect(await as((tx) => job.run(tx, memberId(JOB), day('2026-12-20')), JOB)).toMatchObject({ reminded: 0 });
    });

    it('answers in time without being late, and does not remind a petition that is answered before its last day', async () => {
      const s = await setup();
      const done = await receive(s);
      const answered = await resolve(done.id, 1, {}, { now: day('2026-12-01') });
      expect(answered).toMatchObject({ status: 'RESOLVED', late: false });
    });

    it('refuses with TIMER_RULE_UNCONFIRMED when no rule is in force on the day the petition is received, and with CALENDAR_NOT_EFFECTIVE when the calendar of a year the count passes through is missing', async () => {
      const s = await setup();
      // The count from 2026-12-28 passes into 2027, which has no published calendar.
      expect(await refusal(receive(s, { receivedOn: '2026-12-28' }, { now: day('2026-12-28') }))).toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422 });
      expect(await refusal(receive(s, { receivedOn: '2024-12-31' }, { now: day('2025-01-02') }))).toMatchObject({ code: 'TIMER_RULE_UNCONFIRMED', status: 422, detail: 'petition_kind' });
      expect(await owner('select 1 from machvon.procurement_petition where package_id = $1::uuid', [s.seeded.packageId])).toEqual([]);
    });
  });

  describe('receiving', () => {
    it('refuses a shape that is not one, a package outside the scope, a contractor or a paper that does not exist', async () => {
      const s = await setup();
      expect(await refusal(receive(s, { petitionKind: 'OTHER' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'petition_kind' });
      expect(await refusal(receive(s, { receivedOn: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'received_on' });
      expect(await refusal(receive(s, { receivedOn: '25/11/2026' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'received_on' });
      expect(await refusal(receive(s, { packageId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'package_id' });
      expect(await refusal(receive(s, { contractorId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contractor_id' });
      expect(await refusal(receive(s, { petitionDocumentId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'petition_document_id' });
      expect(await refusal(receive(s, {}, { scope: nothing }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(receive(s, { packageId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(receive(s, { contractorId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contractor_id' });
      expect(await refusal(receive(s, { petitionDocumentId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'petition_document_id' });
    });

    it('refuses a petition received on a day that has not come: PETITION_OUT_OF_TIME', async () => {
      const s = await setup();
      expect(await refusal(receive(s, { receivedOn: '2026-11-26' }))).toMatchObject({ code: 'PETITION_OUT_OF_TIME', status: 422, detail: 'received_on', extensions: { reason: 'FUTURE', today: RECEIVED_ON } });
      expect(await owner('select 1 from machvon.procurement_petition where package_id = $1::uuid', [s.seeded.packageId])).toEqual([]);
    });

    it('takes a petition about a result only after the result was approved, and within the days the rule gives from that day', async () => {
      const s = await setup();
      expect(await refusal(receive(s, { petitionKind: 'RESULT' }))).toMatchObject({ code: 'PETITION_OUT_OF_TIME', extensions: { reason: 'NO_RESULT' } });
      const winner = s.contractor;
      await seedAs(harness, [
        [
          `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, outcome, status, decision_document_id, submitted_by, approved_by, approved_at, created_by, updated_by, version)
           values ($1, $2, $3, $4, 1000, 'AWARDED', 'APPROVED', $5, $6, $7, '2026-11-20T03:00:00Z', $6, $6, 3)`,
          [TENANT_A, randomUUID(), s.seeded.packageId, winner, await paper(), memberId(LOGGER), memberId(HANDLER)],
        ],
      ]);
      expect(await refusal(receive(s, { petitionKind: 'RESULT', receivedOn: '2026-11-19' }, { now: day('2026-11-25') }))).toMatchObject({ code: 'PETITION_OUT_OF_TIME', extensions: { reason: 'BEFORE_RESULT', result_approved_on: '2026-11-20' } });
      // The rule of the baseline sets no limit: a petition about the result is taken from the day it is approved.
      expect(await receive(s, { petitionKind: 'RESULT' })).toMatchObject({ petitionKind: 'RESULT', dueOn: '2026-12-02' });
      // A rule that limits the days to lodge it: 3 working days after 2026-11-20 (Friday) end on Wednesday 25 November.
      await as((tx) => applyBaseline(tx, sealPack('BID-PETITION-FILING', [workingRule('RESULT', { filing_days: 3 })]), memberId(LOGGER), '2026-06-01'));
      expect(await receive(s, { petitionKind: 'RESULT' })).toMatchObject({ petitionKind: 'RESULT', dueOn: DUE_ON });
      expect(await refusal(receive(s, { petitionKind: 'RESULT', receivedOn: '2026-11-26' }, { now: day('2026-11-26') }))).toMatchObject({
        code: 'PETITION_OUT_OF_TIME',
        extensions: { reason: 'FILING_WINDOW_PASSED', result_approved_on: '2026-11-20', last_day_to_file: '2026-11-25' },
      });
    });

    it('takes one petition for each paper: logging the same paper twice is refused', async () => {
      const s = await setup();
      const documentId = await paper();
      await receive(s, { petitionDocumentId: documentId });
      expect(await refusal(receive(s, { petitionDocumentId: documentId }))).toMatchObject({ code: 'PETITION_STATE_INVALID', status: 409, extensions: { reason: 'DOCUMENT_ALREADY_LODGED' } });
      expect(await owner('select 1 from machvon.procurement_petition where package_id = $1::uuid', [s.seeded.packageId])).toHaveLength(1);
    });
  });

  describe('answering', () => {
    it('AC-ST-BID-007-2, UAT-AC450: a person with a conflict of interest against the contractor does not answer the petition, and a different person does', async () => {
      const s = await setup();
      const done = await receive(s, { petitionKind: 'PROCESS' });
      await declareConflict(s, CONFLICTED, s.contractor);
      const blocked = await refusal(resolve(done.id, 1, {}, { member: CONFLICTED }));
      expect(blocked).toMatchObject({ code: 'CONFLICT_OF_INTEREST_BLOCKED', status: 409, detail: 'actor', extensions: { contractor_id: s.contractor, conflict_of: 'HANDLER' } });
      expect(await row(done.id)).toMatchObject({ status: 'RECEIVED', handled_by: null, version: '1' });
      expect(await resolve(done.id, 1, {}, { member: HANDLER })).toMatchObject({ status: 'RESOLVED', version: 2 });
    });

    it('stops whoever declared a conflict with the whole package, unless somebody allowed it', async () => {
      const s = await setup();
      const done = await receive(s);
      await declareConflict(s, CONFLICTED, null);
      expect(await refusal(resolve(done.id, 1, {}, { member: CONFLICTED }))).toMatchObject({ code: 'CONFLICT_OF_INTEREST_BLOCKED' });
      const other = await setup();
      const second = await receive(other);
      await declareConflict(other, CONFLICTED, other.contractor, 'ALLOWED');
      expect(await resolve(second.id, 1, {}, { member: CONFLICTED })).toMatchObject({ status: 'RESOLVED' });
    });

    it('passes a petition on to the level above with a document, which is then answered by that level; an answered petition is not answered again', async () => {
      const s = await setup();
      const done = await receive(s);
      const escalated = await resolve(done.id, 1, { outcome: 'ESCALATED' });
      expect(escalated).toMatchObject({ fromStatus: 'RECEIVED', status: 'ESCALATED', version: 2 });
      // A petition passed on is no longer overdue at this level.
      expect(await as((tx) => petitions.find(tx, done.id, everything, memberId(LOGGER), day('2027-01-20')))).toMatchObject({ overdue: false, status: 'ESCALATED' });
      expect(await refusal(resolve(done.id, 2, { outcome: 'ESCALATED' }))).toMatchObject({ code: 'PETITION_STATE_INVALID', status: 409, extensions: { petition_status: 'ESCALATED' } });
      const resolved = await resolve(done.id, 2, { outcome: 'RESOLVED' });
      expect(resolved).toMatchObject({ fromStatus: 'ESCALATED', status: 'RESOLVED', version: 3 });
      expect(await refusal(resolve(done.id, 3))).toMatchObject({ code: 'PETITION_STATE_INVALID', extensions: { petition_status: 'RESOLVED' } });
    });

    it('refuses a stale version, an outcome that is not one, the paper of the petition as its own answer, and a petition outside the scope', async () => {
      const s = await setup();
      const documentId = await paper();
      const done = await receive(s, { petitionDocumentId: documentId });
      expect(await refusal(resolve(done.id, 4))).toMatchObject({ status: 409 });
      expect(await refusal(resolve(done.id, 1, { outcome: 'WITHDRAWN' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'outcome' });
      expect(await refusal(resolve(done.id, 1, { resolutionDocumentId: documentId }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'resolution_document_id' });
      expect(await refusal(resolve(done.id, 1, {}, { scope: nothing }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(resolve(randomUUID(), 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await row(done.id))?.status).toBe('RECEIVED');
    });
  });

  describe('the register', () => {
    it('lists the petitions of the packages in the scope, the ones that wait first and by their last day, optionally one package or only the overdue', async () => {
      const s = await setup();
      const first = await receive(s);
      const second = await receive(s, { receivedOn: '2026-11-26' }, { now: day('2026-11-26') });
      const third = await receive(s);
      await resolve(first.id, 1);
      const other = await setup();
      await receive(other);

      const all = await as((tx) => petitions.list(tx, everything, memberId(LOGGER), { packageId: s.seeded.packageId }, day('2026-12-01')));
      expect(all.map((line) => line.id)).toEqual([third.id, second.id, first.id]);
      expect(all.map((line) => line.status)).toEqual(['RECEIVED', 'RECEIVED', 'RESOLVED']);
      expect(all[0]).toMatchObject({
        package: { id: s.seeded.packageId, code: s.seeded.packageCode },
        projectId: s.seeded.projectId,
        contractor: { id: s.contractor },
        petitionKind: 'PROCESS',
        receivedOn: RECEIVED_ON,
        daysApplied: 7,
        overdue: false,
        createdBy: memberId(LOGGER),
        version: 1,
      });
      expect(all[2]).toMatchObject({ handledBy: { membershipId: memberId(HANDLER) }, resolutionDocumentId: expect.any(String) });
      expect((await as((tx) => petitions.list(tx, everything, memberId(LOGGER), {}, day('2026-12-01')))).length).toBeGreaterThanOrEqual(4);
      const late = await as((tx) => petitions.list(tx, everything, memberId(LOGGER), { packageId: s.seeded.packageId, overdueOnly: true }, day('2026-12-05')));
      expect(late.map((line) => [line.id, line.overdue, line.daysOverdue])).toEqual([[third.id, true, 1]]);
      expect((await as((tx) => petitions.list(tx, everything, memberId(LOGGER), { packageId: s.seeded.packageId, overdueOnly: true }, day('2026-12-08')))).map((line) => line.id)).toEqual([third.id, second.id]);
      expect(await as((tx) => petitions.list(tx, everything, memberId(LOGGER), { packageId: s.seeded.packageId, overdueOnly: true }, day('2026-12-01')))).toEqual([]);
      expect(await as((tx) => petitions.list(tx, nothing, memberId(LOGGER), {}, NOW))).toEqual([]);
      expect(await as((tx) => petitions.find(tx, randomUUID(), everything, memberId(LOGGER), NOW))).toBeUndefined();
      expect(await as((tx) => petitions.find(tx, third.id, nothing, memberId(LOGGER), NOW))).toBeUndefined();
      // The viewer is told of a conflict of their own that stands between them and the petition.
      await declareConflict(s, CONFLICTED, s.contractor);
      expect((await as((tx) => petitions.find(tx, third.id, everything, memberId(CONFLICTED), NOW)))?.viewerInConflict).toBe(true);
      expect((await as((tx) => petitions.find(tx, third.id, everything, memberId(LOGGER), NOW)))?.viewerInConflict).toBe(false);
      expect((await as((tx) => petitions.list(tx, everything, memberId(CONFLICTED), { packageId: s.seeded.packageId }, NOW))).map((line) => line.viewerInConflict)).toEqual([true, true, true]);
    });
  });

  describe('the guards of the database', () => {
    it('keeps what a petition says, its edges, and an answered petition as it is, and does not delete one', async () => {
      const s = await setup();
      const done = await receive(s);
      const update = (sql: string) => databaseRefusal(owner(`update machvon.procurement_petition set ${sql} where id = $1::uuid`, [done.id]));
      expect((await update(`due_on = date '2027-01-01'`)).message).toMatch(/never changes/);
      expect((await update(`package_id = gen_random_uuid()`)).sqlstate).toMatch(/23514|23503/);
      expect((await update(`days_applied = 30`)).message).toMatch(/never changes/);
      expect((await update(`status = 'RESOLVED'`)).message).toMatch(/procurement_petition_answered_chk|violates check/);
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.procurement_petition where id = $1::uuid', [done.id])))).sqlstate).toBe('42501');
      await resolve(done.id, 1);
      expect((await update(`status = 'RECEIVED', resolution_document_id = null, resolved_at = null, handled_by = null`)).message).toMatch(/is kept as it is/);
      expect((await update(`due_on = date '2027-01-01'`)).message).toMatch(/never changes/);
    });

    it('takes the deadline checks of the table: a last day before the day received, and a petition counted by nothing, are refused', async () => {
      const s = await setup();
      const insert = (due: string, days: number | null) =>
        databaseRefusal(
          owner(
            `insert into machvon.procurement_petition (tenant_id, id, package_id, contractor_id, petition_kind, received_on, due_on, petition_document_id, status, days_applied, rule_version_id, created_by, updated_by, version)
             values ($1, gen_random_uuid(), $2, $3, 'PROCESS', date '2026-11-25', $4::date, $5, 'RECEIVED', $6, gen_random_uuid(), $7, $7, 1)`,
            [TENANT_A, s.seeded.packageId, s.contractor, due, id(FAMILY, 1), days, memberId(LOGGER)],
          ),
        );
      expect((await insert('2026-11-24', 7)).message).toMatch(/procurement_petition_due_chk/);
      expect((await insert('2026-12-02', null)).message).toMatch(/procurement_petition_basis_chk/);
      expect((await insert('2026-12-02', 400)).message).toMatch(/procurement_petition_basis_chk/);
    });
  });
});
