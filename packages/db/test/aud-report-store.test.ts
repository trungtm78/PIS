import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { holdKindOf, reportSourceRef, reportTotals } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { AudEngagementStore, engagementScope } from '../src/aud-engagement-store';
import { recommendationScope } from '../src/aud-recommendation-store';
import { AudRecoveryStore } from '../src/aud-recovery-store';
import { AudReportStore, reportPayloadRef } from '../src/aud-report-store';
import type { NewReport } from '../src/aud-report-store';
import { LegalHoldStore } from '../src/legal-hold-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const reports = new AudReportStore();
const engagements = new AudEngagementStore();
const recoveries = new AudRecoveryStore();
const holds = new LegalHoldStore();

const OFFICER = 1;
const SIGNER = 2;
const FAMILY = 0x98;
const DECISION = id(FAMILY, 10);
const EVIDENCE = id(FAMILY, 11);
const ROOT = 1;
const DEPARTMENT = 2;
const TODAY = '2026-10-26';
const NOW = new Date('2026-10-26T03:00:00Z');
const WORKER = '00000000-0000-4000-8000-000000000000';

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = OFFICER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const accessOf = (permissions: readonly string[], scope: Scope): EffectiveAccess => ({
  membershipId: memberId(OFFICER),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'AUD', rank: 30, permissions, scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const all = accessOf(['aud.read', 'aud.recommendation.execute', 'aud.recovery.record', 'aud.engagement.close'], { kind: 'TENANT' });
const everything = engagementScope(all, 'aud.read', NOW);
const seeAll = recommendationScope(all, 'aud.read', 'aud.recommendation.execute', NOW);

let counter = 0;
interface Seeded {
  engagementId: string;
  conclusionId: string;
  holdId: string | null;
  recommendations: string[];
}

interface RecommendationSeed {
  type?: string;
  amount?: string | null;
  status?: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'CLOSED' | 'CANCELLED';
  /** Recovered through the ledger, on this day. */
  recovered?: string;
  recoveredOn?: string;
}

/** An engagement being followed up, its conclusion and the recommendations asked for (the rows are written as the owner of the database; the statuses are walked as the system would). */
async function seed(items: RecommendationSeed[], options: { withHold?: boolean; startedOn?: string } = {}): Promise<Seeded> {
  counter += 1;
  const engagementId = randomUUID();
  const conclusionId = randomUUID();
  let holdId: string | null = null;
  if (options.withHold === true) {
    holdId = (
      await as((tx) =>
        holds.place(tx, { holdKind: holdKindOf('STATE_AUDIT'), scope: { kind: 'UNIT', ids: [unitId(DEPARTMENT)] }, authorityReference: `RP-${counter}`, reason: 'The engagement was started.' }, memberId(OFFICER)),
      )
    ).id;
  }
  await owner(
    `insert into machvon.audit_engagement (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on, legal_hold_id, classification, created_by, updated_by, version)
     values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'State Audit Office', $4, 'Audit of the bridge', date '2025-01-01', date '2025-12-31', $5, 'FOLLOW_UP', date '${options.startedOn ?? '2026-10-01'}', $6::uuid, 'CONFIDENTIAL', $5, $5, 3)`,
    [TENANT_A, engagementId, `RP-${counter}`, DECISION, memberId(OFFICER), holdId],
  );
  await owner("insert into machvon.audit_scope_item (tenant_id, id, engagement_id, scope_kind, organization_unit_id, added_by) values ($1, gen_random_uuid(), $2, 'UNIT', $3, $4)", [
    TENANT_A,
    engagementId,
    unitId(DEPARTMENT),
    memberId(OFFICER),
  ]);
  await owner(
    `insert into machvon.audit_conclusion (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, summary, total_financial_vnd, status, created_by, updated_by, version)
     values ($1, $2, $3, 'AUDIT_REPORT', $4, 1, date '2026-10-10', date '2026-10-15', 'The audit found payments above the approved volumes.', 5000000000, 'RECEIVED', $5, $5, 1)`,
    [TENANT_A, conclusionId, engagementId, DECISION, memberId(OFFICER)],
  );
  const ids: string[] = [];
  for (const [index, item] of items.entries()) {
    const recommendationId = randomUUID();
    ids.push(recommendationId);
    const amount = item.amount === undefined ? '500000000' : item.amount;
    await owner(
      `insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, status, owner_unit_id, due_on, created_by, updated_by, version, created_at)
       values ($1, $2, $3, $4, $5, 'Recover what was paid above the volume.', $6::numeric, 'OPEN', null, null, $7, $7, 1, timestamptz '2026-10-16T03:00:00Z')`,
      [TENANT_A, recommendationId, conclusionId, `R-${counter}-${index + 1}`, item.type ?? 'FINANCIAL_RECOVERY', amount, memberId(OFFICER)],
    );
    const status = item.status ?? 'OPEN';
    if (status !== 'OPEN' && status !== 'CANCELLED') await owner("update machvon.audit_recommendation set status = 'ASSIGNED', owner_unit_id = $2, due_on = date '2026-12-01' where id = $1", [recommendationId, unitId(DEPARTMENT)]);
    if (status === 'IN_PROGRESS' || status === 'CLOSED') await owner("update machvon.audit_recommendation set status = 'IN_PROGRESS' where id = $1", [recommendationId]);
    if (item.recovered !== undefined) {
      await owner(
        `insert into machvon.audit_recovery_link (tenant_id, id, recommendation_id, source_kind, source_id, amount_vnd, recorded_on, recorded_by)
         values ($1, gen_random_uuid(), $2::uuid, 'PAY_RECOVERY', gen_random_uuid(), $3::numeric, $4::date, $5::uuid)`,
        [TENANT_A, recommendationId, item.recovered, item.recoveredOn ?? '2026-10-20', memberId(OFFICER)],
      );
    }
    if (status === 'CLOSED') {
      await owner("update machvon.audit_recommendation set status = 'PENDING_VERIFICATION', submitted_by = $2 where id = $1", [recommendationId, memberId(SIGNER)]);
      await owner("update machvon.audit_recommendation set status = 'CLOSED', verified_by = $2, verified_at = timestamptz '2026-12-20T03:00:00Z' where id = $1", [recommendationId, memberId(OFFICER)]);
    }
    if (status === 'CANCELLED') await owner("update machvon.audit_recommendation set status = 'CANCELLED' where id = $1", [recommendationId]);
  }
  return { engagementId, conclusionId, holdId, recommendations: ids };
}

const newReport = (made: Seeded, extra: Partial<NewReport> = {}): NewReport => ({
  engagementId: made.engagementId,
  conclusionId: made.conclusionId,
  asOfDate: '2027-01-04',
  totals: reportTotals('2027-01-04', []),
  draftingUnitId: unitId(DEPARTMENT),
  payloadSha256: 'a'.repeat(64),
  issueEventId: randomUUID(),
  ...extra,
});
const create = (made: Seeded, extra: Partial<NewReport> = {}, member = OFFICER) => as((tx) => reports.create(tx, newReport(made, extra), memberId(member)), TENANT_A, member);
const head = (reportId: string) => as((tx) => reports.lockHead(tx, reportId));
const row = async (reportId: string) =>
  (
    await owner<{ status: string; revision: number; approved_by: string | null; report_document_id: string | null; reject_code: string | null; issued_at: string | null; version: string }>(
      'select status, revision, approved_by, report_document_id, reject_code, issued_at::text as issued_at, version::text as version from machvon.audit_follow_up_report where id = $1',
      [reportId],
    )
  )[0] as { status: string; revision: number; approved_by: string | null; report_document_id: string | null; reject_code: string | null; issued_at: string | null; version: string };

async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (documents) are seeded with the foreign keys they have to other modules switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

describe('AudReportStore (the report of results and the closure, ST-AUD-005)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
      ]);
    }
    for (const n of [OFFICER, SIGNER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await seedReplica([
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to audit the bridge', '12/KL-KTNN', '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4),
                ($1, $3, 'REFERENCE', 'BC', 'The report DOC issued', '07/BC-UBND', '2027-01-05', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
        [TENANT_A, DECISION, EVIDENCE, memberId(OFFICER)],
      ],
    ]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the figures as of a day', () => {
    it('AC-ST-AUD-005-1: reads each recommendation with when it was closed and what the ledger had recovered of it by the day', async () => {
      const made = await seed([
        { status: 'CLOSED', amount: '500000000', recovered: '500000000' },
        { status: 'IN_PROGRESS', amount: '400000000', recovered: '300000000' },
        { status: 'CLOSED', amount: '300000000', recovered: '300000000', recoveredOn: '2027-01-10' },
        { status: 'CANCELLED', amount: '999' },
        { status: 'OPEN', type: 'PROCESS_CORRECTION', amount: null },
      ]);
      const rows = await as((tx) => reports.recommendationsAsOf(tx, made.conclusionId, '2027-01-04'));
      expect(rows.map((item) => [item.type, item.status, item.amountVnd, item.createdOn, item.closedOn, item.recoveredVnd])).toEqual([
        ['FINANCIAL_RECOVERY', 'CLOSED', '500000000', '2026-10-16', '2026-12-20', '500000000'],
        ['FINANCIAL_RECOVERY', 'IN_PROGRESS', '400000000', '2026-10-16', null, '300000000'],
        ['FINANCIAL_RECOVERY', 'CLOSED', '300000000', '2026-10-16', '2026-12-20', '0'],
        ['FINANCIAL_RECOVERY', 'CANCELLED', '999', '2026-10-16', null, '0'],
        ['PROCESS_CORRECTION', 'OPEN', null, '2026-10-16', null, '0'],
      ]);
      const later = await as((tx) => reports.recommendationsAsOf(tx, made.conclusionId, '2027-01-10'));
      expect(later[2]?.recoveredVnd).toBe('300000000');
    });

    it('gives the engagement, the conclusion with its symbol and the units of the scope, and nothing for a conclusion of another engagement', async () => {
      const made = await seed([{}]);
      const other = await seed([{}]);
      const context = await as((tx) => reports.context(tx, made.engagementId, made.conclusionId));
      expect(context).toEqual({
        engagement: { id: made.engagementId, code: `RP-${counter - 1}`, title: 'Audit of the bridge', authorityName: 'State Audit Office', status: 'FOLLOW_UP' },
        conclusion: { id: made.conclusionId, status: 'RECEIVED', receivedOn: '2026-10-15', issuedOn: '2026-10-10', symbol: '12/KL-KTNN' },
        scopeUnitIds: [unitId(DEPARTMENT)],
      });
      expect(await as((tx) => reports.context(tx, made.engagementId, other.conclusionId))).toBeUndefined();
      expect(await as((tx) => reports.context(tx, made.engagementId, randomUUID()))).toBeUndefined();
    });

    it('gives the name of a unit of the tenant, and nothing for one that is not there', async () => {
      expect(await as((tx) => reports.unitName(tx, unitId(DEPARTMENT)))).toEqual(expect.any(String));
      expect(await as((tx) => reports.unitName(tx, randomUUID()))).toBeUndefined();
    });
  });

  describe('asking for a report', () => {
    it('AC-ST-AUD-005-1: writes it ISSUE_REQUESTED with the frozen figures, the hash and the key of the payload, in revision 1', async () => {
      const made = await seed([{ status: 'CLOSED', recovered: '500000000' }]);
      const totals = reportTotals('2027-01-04', await as((tx) => reports.recommendationsAsOf(tx, made.conclusionId, '2027-01-04')));
      const created = await create(made, { totals, payloadSha256: 'b'.repeat(64) });
      expect(created.revision).toBe(1);
      expect(created.payloadRef).toBe(reportPayloadRef(TENANT_A, created.id, 1));
      const line = await as((tx) => reports.findLine(tx, created.id));
      expect(line).toMatchObject({
        id: created.id,
        engagementId: made.engagementId,
        conclusionId: made.conclusionId,
        conclusionSymbol: '12/KL-KTNN',
        asOfDate: '2027-01-04',
        revision: 1,
        status: 'ISSUE_REQUESTED',
        payloadSha256: 'b'.repeat(64),
        sourceRef: reportSourceRef(created.id, 1),
        reportDocumentId: null,
        rejectCode: null,
        approvedBy: null,
        issuedAt: null,
        version: 1,
      });
      expect(line?.totals).toMatchObject({ total: 1, closed: 1, amount: '500000000', recovered: '500000000' });
      expect(line?.requestedBy.id).toBe(memberId(OFFICER));
    });

    it('refuses a second report of the same conclusion and day while one is waiting for DOC or issued, and says which (409 FOLLOW_UP_REPORT_EXISTS)', async () => {
      const made = await seed([{}]);
      const first = await create(made);
      const refused = await refusal(create(made));
      expect(refused).toMatchObject({ code: 'FOLLOW_UP_REPORT_EXISTS', status: 409, detail: 'as_of_date', extensions: { report_id: first.id, revision: 1, report_status: 'ISSUE_REQUESTED' } });
      const another = await create(made, { asOfDate: '2027-01-05' });
      expect(another.revision).toBe(1);
    });

    it('lets one of two requests made at once win and refuses the other', async () => {
      const made = await seed([{}]);
      const settled = await Promise.allSettled([create(made), create(made, {}, SIGNER)]);
      expect(settled.filter((item) => item.status === 'fulfilled').length).toBe(1);
      const failure = settled.find((item) => item.status === 'rejected') as PromiseRejectedResult;
      expect(failure.reason).toMatchObject({ code: 'FOLLOW_UP_REPORT_EXISTS', status: 409 });
    });

    it('AC-ST-AUD-005-2: follows a rejected report with revision 2 of the same day, and a recalled one too', async () => {
      const made = await seed([{}]);
      const first = await create(made);
      await as((tx) => reports.lockHead(tx, first.id).then((found) => reports.markRejected(tx, found!, 'TEMPLATE_NOT_EFFECTIVE')));
      const second = await create(made);
      expect(second.revision).toBe(2);
      expect(second.payloadRef).toBe(reportPayloadRef(TENANT_A, second.id, 2));
      await as((tx) => reports.lockHead(tx, second.id).then((found) => reports.markIssued(tx, found!, { documentId: EVIDENCE, approvedBy: memberId(SIGNER), issuedAt: '2027-01-05T03:00:00Z' })));
      await as((tx) => reports.lockHead(tx, second.id).then((found) => reports.markRecalled(tx, found!)));
      expect((await create(made)).revision).toBe(3);
    });

    it('lists the reports of an engagement, the newest day and revision first, with who asked and who approved', async () => {
      const made = await seed([{}]);
      const first = await create(made, { asOfDate: '2027-01-04' });
      await create(made, { asOfDate: '2027-01-06' });
      await as((tx) => reports.lockHead(tx, first.id).then((found) => reports.markIssued(tx, found!, { documentId: EVIDENCE, approvedBy: memberId(SIGNER), issuedAt: '2027-01-05T03:00:00Z' })));
      const lines = await as((tx) => reports.list(tx, made.engagementId));
      expect(lines.map((line) => [line.asOfDate, line.revision, line.status])).toEqual([
        ['2027-01-06', 1, 'ISSUE_REQUESTED'],
        ['2027-01-04', 1, 'ISSUED'],
      ]);
      expect(lines[1]).toMatchObject({ reportDocumentId: EVIDENCE, approvedBy: { id: memberId(SIGNER) } });
      expect(await as((tx) => reports.list(tx, randomUUID()))).toEqual([]);
      expect(await as((tx) => reports.findLine(tx, randomUUID()))).toBeUndefined();
    });
  });

  describe('what DOC answers', () => {
    it('AC-ST-AUD-005-1: ISSUED keeps the document and the approver, and the instant; the approver is the signer when that is not the person who asked', async () => {
      const made = await seed([{}]);
      const created = await create(made);
      const done = await as((tx) => reports.lockHead(tx, created.id).then((found) => reports.markIssued(tx, found!, { documentId: EVIDENCE, approvedBy: memberId(SIGNER), issuedAt: '2027-01-05T03:00:00Z' })));
      expect(done).toEqual({ version: 2, approved: true });
      expect(await row(created.id)).toMatchObject({ status: 'ISSUED', approved_by: memberId(SIGNER), report_document_id: EVIDENCE, version: '2' });
      expect((await row(created.id)).issued_at).not.toBeNull();
    });

    it('issues the report all the same when the signer is the person who asked, without an approver (the table keeps the two apart)', async () => {
      const made = await seed([{}]);
      const created = await create(made);
      const done = await as((tx) => reports.lockHead(tx, created.id).then((found) => reports.markIssued(tx, found!, { documentId: EVIDENCE, approvedBy: memberId(OFFICER), issuedAt: '2027-01-05T03:00:00Z' })));
      expect(done.approved).toBe(false);
      expect(await row(created.id)).toMatchObject({ status: 'ISSUED', approved_by: null });
      const unsigned = await create(made, { asOfDate: '2027-01-05' });
      expect((await as((tx) => reports.lockHead(tx, unsigned.id).then((found) => reports.markIssued(tx, found!, { documentId: EVIDENCE, approvedBy: null, issuedAt: '2027-01-05T03:00:00Z' })))).approved).toBe(false);
    });

    it('AC-ST-AUD-005-2: REJECTED keeps the reason DOC gave, and a rejected report is never issued afterwards (409 REPORT_STATE_INVALID)', async () => {
      const made = await seed([{}]);
      const created = await create(made);
      const done = await as((tx) => reports.lockHead(tx, created.id).then((found) => reports.markRejected(tx, found!, 'PAYLOAD_SCHEMA_INVALID')));
      expect(done.version).toBe(2);
      expect(await row(created.id)).toMatchObject({ status: 'REJECTED', reject_code: 'PAYLOAD_SCHEMA_INVALID' });
      const rejected = (await head(created.id))!;
      for (const work of [
        as((tx) => reports.markIssued(tx, rejected, { documentId: EVIDENCE, approvedBy: null, issuedAt: '2027-01-05T03:00:00Z' })),
        as((tx) => reports.markRejected(tx, rejected, 'PAYLOAD_SCHEMA_INVALID')),
        as((tx) => reports.markRecalled(tx, rejected)),
      ]) {
        expect(await refusal(work)).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409 });
      }
    });

    it('recalls only a report that was issued', async () => {
      const made = await seed([{}]);
      const created = await create(made);
      expect(await refusal(as((tx) => reports.lockHead(tx, created.id).then((found) => reports.markRecalled(tx, found!))))).toMatchObject({ code: 'REPORT_STATE_INVALID' });
      await as((tx) => reports.lockHead(tx, created.id).then((found) => reports.markIssued(tx, found!, { documentId: EVIDENCE, approvedBy: memberId(SIGNER), issuedAt: '2027-01-05T03:00:00Z' })));
      const done = await as((tx) => reports.lockHead(tx, created.id).then((found) => reports.markRecalled(tx, found!)));
      expect(done.version).toBe(3);
      expect((await row(created.id)).status).toBe('RECALLED');
      expect(await as((tx) => reports.lockHead(tx, randomUUID()))).toBeUndefined();
    });
  });

  describe('the table', () => {
    it('freezes what the report was asked to issue, whoever writes', async () => {
      const made = await seed([{}]);
      const created = await create(made);
      for (const [set, value] of [
        ['totals_json', `'{"total": 9}'::jsonb`],
        ['payload_sha256', `'${'c'.repeat(64)}'`],
        ['as_of_date', `date '2027-02-01'`],
        ['revision', '5'],
        ['payload_ref', `'tenants/x/y.json'`],
        ['issue_event_id', `'${randomUUID()}'`],
        ['drafting_unit_id', `'${unitId(ROOT)}'`],
      ] as const) {
        await expect(owner(`update machvon.audit_follow_up_report set ${set} = ${value} where id = $1`, [created.id])).rejects.toMatchObject({ code: '23514', constraint: 'audit_follow_up_report_frozen_guard' });
      }
      expect((await row(created.id)).status).toBe('ISSUE_REQUESTED');
    });

    it('keeps the edges of the kernel, never deletes a report, and wants a document for ISSUED and a reason for REJECTED', async () => {
      const made = await seed([{}]);
      const created = await create(made);
      await expect(owner("update machvon.audit_follow_up_report set status = 'RECALLED', issued_at = now() where id = $1", [created.id])).rejects.toMatchObject({ code: '23514', constraint: 'audit_follow_up_report_edges_guard' });
      await expect(owner("update machvon.audit_follow_up_report set status = 'ISSUED', issued_at = now() where id = $1", [created.id])).rejects.toMatchObject({ code: '23514', constraint: 'audit_follow_up_report_issued_chk' });
      await expect(owner("update machvon.audit_follow_up_report set status = 'REJECTED' where id = $1", [created.id])).rejects.toMatchObject({ code: '23514', constraint: 'audit_follow_up_report_reject_chk' });
      await expect(owner('delete from machvon.audit_follow_up_report where id = $1', [created.id])).rejects.toMatchObject({ code: '23514', constraint: 'audit_follow_up_report_guard' });
    });

    it('never lets the approver be the person who asked, and makes one request of one event', async () => {
      const made = await seed([{}]);
      const created = await create(made);
      await expect(
        owner("update machvon.audit_follow_up_report set status = 'ISSUED', report_document_id = $2, issued_at = now(), approved_by = created_by where id = $1", [created.id, EVIDENCE]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'audit_follow_up_report_sod_chk' });
      const event = randomUUID();
      await create(made, { asOfDate: '2027-01-07', issueEventId: event });
      await expect(create(made, { asOfDate: '2027-01-08', issueEventId: event })).rejects.toMatchObject({ code: '23505', constraint: 'audit_follow_up_report_event_uq' });
    });

    it('is invisible to another tenant', async () => {
      const made = await seed([{}]);
      const created = await create(made);
      expect(await as((tx) => reports.findLine(tx, created.id), TENANT_B)).toBeUndefined();
      expect(await as((tx) => reports.list(tx, made.engagementId), TENANT_B)).toEqual([]);
    });
  });

  describe('closing an engagement (AC-ST-AUD-005-1, BR-AUD-04, BR-AUD-10)', () => {
    const lockIn = (tx: TenantTx, engagementId: string, version = 3) => engagements.lock(tx, engagementId, everything, everything, version);
    const facts = (engagementId: string) => as((tx) => reports.closureFacts(tx, engagementId));
    const issue = async (made: Seeded, asOf = '2027-01-04') => {
      const created = await create(made, { asOfDate: asOf });
      await as((tx) => reports.lockHead(tx, created.id).then((found) => reports.markIssued(tx, found!, { documentId: EVIDENCE, approvedBy: memberId(SIGNER), issuedAt: '2027-01-05T03:00:00Z' })));
      return created;
    };
    const close = (engagementId: string, extra: Partial<{ onDate: string; releasedBy: string }> = {}, version = 3) =>
      as((tx) => lockIn(tx, engagementId, version).then(async (locked) => engagements.close(tx, locked, { onDate: '2027-01-05', today: '2027-01-06', releasedBy: WORKER, facts: await reports.closureFacts(tx, engagementId), ...extra }, memberId(OFFICER))));

    it('counts the recommendations that are not over and the conclusions that stand without an issued report', async () => {
      const made = await seed([{ status: 'CLOSED' }, { status: 'IN_PROGRESS' }, { status: 'CANCELLED' }]);
      expect(await facts(made.engagementId)).toEqual({ openRecommendations: 1, conclusionsWithoutReport: 1 });
      await create(made);
      expect((await facts(made.engagementId)).conclusionsWithoutReport).toBe(1);
      await owner("update machvon.audit_conclusion set status = 'SUPERSEDED' where id = $1", [made.conclusionId]);
      expect(await facts(made.engagementId)).toEqual({ openRecommendations: 1, conclusionsWithoutReport: 0 });
    });

    it('AC-ST-AUD-005-1: refuses to close while a recommendation is open, even with a report issued (409 OPEN_RECOMMENDATIONS_REMAIN)', async () => {
      const made = await seed([{ status: 'CLOSED' }, { status: 'IN_PROGRESS' }, { status: 'CLOSED' }]);
      await issue(made);
      expect(await refusal(close(made.engagementId))).toMatchObject({ code: 'OPEN_RECOMMENDATIONS_REMAIN', status: 409, extensions: { open_recommendations: 1 } });
      expect(await owner<{ status: string }>('select status from machvon.audit_engagement where id = $1', [made.engagementId])).toEqual([{ status: 'FOLLOW_UP' }]);
    });

    it('asks for a report DOC issued once nothing is open, and a report that is only requested, rejected or recalled does not count (422 FOLLOW_UP_REPORT_MISSING)', async () => {
      const made = await seed([{ status: 'CLOSED' }]);
      expect(await refusal(close(made.engagementId))).toMatchObject({ code: 'FOLLOW_UP_REPORT_MISSING', status: 422, extensions: { conclusions_without_report: 1 } });
      const requested = await create(made);
      expect(await refusal(close(made.engagementId))).toMatchObject({ code: 'FOLLOW_UP_REPORT_MISSING' });
      await as((tx) => reports.lockHead(tx, requested.id).then((found) => reports.markRejected(tx, found!, 'DOC_TEMPLATE_MISSING')));
      expect(await refusal(close(made.engagementId))).toMatchObject({ code: 'FOLLOW_UP_REPORT_MISSING' });
    });

    it('closes on a day from the start to today, releases the hold as the system, and keeps the day', async () => {
      const made = await seed([{ status: 'CLOSED' }], { withHold: true });
      await issue(made);
      for (const onDate of ['2026-09-30', '2027-01-07']) {
        expect(await refusal(close(made.engagementId, { onDate }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'on_date' });
      }
      const done = await close(made.engagementId);
      expect(done).toEqual({ version: 4, holdReleased: true });
      expect(await owner<{ status: string; closed_on: string }>('select status, closed_on::text as closed_on from machvon.audit_engagement where id = $1', [made.engagementId])).toEqual([{ status: 'CLOSED', closed_on: '2027-01-05' }]);
      const [hold] = await owner<{ status: string; released_by: string }>('select status, released_by from machvon.legal_hold where id = $1', [made.holdId]);
      expect(hold).toMatchObject({ status: 'Released', released_by: WORKER });
      expect(await refusal(close(made.engagementId, {}, 4))).toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID', status: 409 });
    });

    it('closes an engagement with no hold, and one whose hold someone released already', async () => {
      const bare = await seed([{ status: 'CLOSED' }]);
      await issue(bare);
      expect(await close(bare.engagementId)).toEqual({ version: 4, holdReleased: false });
      const released = await seed([{ status: 'CLOSED' }], { withHold: true });
      await issue(released);
      await owner("update machvon.legal_hold set status = 'Released', released_by = $2, released_at = now(), release_reason = 'Released by hand.' where id = $1", [released.holdId, WORKER]);
      expect((await close(released.engagementId)).holdReleased).toBe(false);
    });

    it('refuses a stale version of the engagement (409 VERSION_CONFLICT) and an engagement that is not being followed up', async () => {
      const made = await seed([{ status: 'CLOSED' }]);
      await issue(made);
      expect(await refusal(close(made.engagementId, {}, 2))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await owner("update machvon.audit_engagement set status = 'ONGOING' where id = $1", [made.engagementId]);
      expect(await refusal(close(made.engagementId))).toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID' });
    });

    it('a reversal that reopens a recommendation waits for the closure, and a closure that comes after counts what the reversal reopened', async () => {
      // Closed and fully recovered, in an engagement that is being followed up: a reversal takes it back to work, so the engagement cannot close.
      const made = await seed([{ status: 'CLOSED', amount: '500000000', recovered: '500000000' }]);
      await issue(made);
      const [link] = await owner<{ id: string }>('select id from machvon.audit_recovery_link where recommendation_id = $1', [made.recommendations[0]]);
      await as((tx) =>
        recoveries.lockLink(tx, (link as { id: string }).id, seeAll, everything).then((target) => recoveries.reverse(tx, target, { reason: 'The voucher was entered twice.', today: TODAY }, memberId(OFFICER))),
      );
      expect(await refusal(close(made.engagementId))).toMatchObject({ code: 'OPEN_RECOMMENDATIONS_REMAIN', extensions: { open_recommendations: 1 } });
      // Once the engagement is closed a reversal writes its line and reopens nothing.
      const closed = await seed([{ status: 'CLOSED', amount: '500000000', recovered: '500000000' }]);
      await issue(closed);
      await close(closed.engagementId);
      const [second] = await owner<{ id: string }>('select id from machvon.audit_recovery_link where recommendation_id = $1', [closed.recommendations[0]]);
      const reversal = await as((tx) =>
        recoveries.lockLink(tx, (second as { id: string }).id, seeAll, everything).then((target) => recoveries.reverse(tx, target, { reason: 'The voucher was entered twice.', today: TODAY }, memberId(OFFICER))),
      );
      expect(reversal.reopened).toBe(false);
      expect((await owner<{ status: string }>('select status from machvon.audit_recommendation where id = $1', [closed.recommendations[0]]))[0]?.status).toBe('CLOSED');
    });
  });
});

