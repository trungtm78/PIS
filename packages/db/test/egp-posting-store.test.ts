import { randomUUID } from 'node:crypto';
import { fileSha256 } from '@machvon/kernel';
import { EgpImportAdapter } from '../src/egp-import';
import { EgpMilestoneHook } from '../src/egp-milestone-hook';
import { EgpObligationStore, clockOfRow } from '../src/egp-posting-store';
import { EgpReconciliationStore } from '../src/egp-reconciliation-store';
import { EgpMappingStore } from '../src/egp-store';
import { FileImportStore } from '../src/file-import-store';
import { HomeEgpPostingSources } from '../src/home-egp-posting-sources';
import { DEFAULT_SEVERITY_RULES } from '../src/home-work-rules';
import type { SourceContext } from '../src/home-work-sources';
import type { TenantTx } from '../src/tenant-database';
import { next, seedAs, seedBidPackage } from './support/bid-proposal-fixtures';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const obligations = new EgpObligationStore();
const reconciliations = new EgpReconciliationStore();
const hook = new EgpMilestoneHook();
const mappings = new EgpMappingStore();
const imports = new FileImportStore();
const PREPARER = 1;
const SUBMITTER = 2;
const THIRD = 3;
const NOW = new Date('2026-11-08T03:00:00Z');

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = PREPARER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const bytes = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

type Kind = 'KHLCNT' | 'TBMT' | 'RESULT' | 'CONTRACTOR' | 'RESTRICTION';
async function apply(kind: Kind, file: Uint8Array, member = PREPARER): Promise<{ importId: string }> {
  const result = await as(
    (tx) =>
      imports.run(tx, {
        adapter: new EgpImportAdapter(kind, { actor: memberId(member), now: NOW }),
        bytes: file,
        fileObjectKey: `tenants/${TENANT_A}/import/${randomUUID()}`,
        expectedSha256: fileSha256(file),
        importedBy: memberId(member),
        fallbackOwnerId: memberId(member),
        correlationId: randomUUID(),
        cursorScope: 'DEFAULT',
        now: NOW,
      }),
    member,
  );
  return { importId: result.importId };
}

const KHLCNT_HEADER = 'plan_code,package_external_code,package_name,estimated_price,selection_method,approved_on,decision_no,project_code,package_code';
const TBMT_HEADER = 'notice_code,notice_version,notice_kind,package_external_code,plan_code,published_at,bid_closing_at,bid_opening_at,estimated_price,bid_security_amount,project_code,package_code';
const RESULT_HEADER = 'result_code,notice_code,package_external_code,result_kind,published_at,approved_on,contractor_tax_code,award_price,contractor_name,project_code,package_code';

/** Approves every mapping of the subject (a person other than the one who loaded the file), by the way the screen does. */
async function approveMappings(packageId: string): Promise<void> {
  const rows = await owner<{ id: string; version: string }>(`select id, version::text as version from machvon.master_crosswalk where subject_id = $1 and status = 'PROPOSED' order by id`, [packageId]);
  for (const row of rows) await as((tx) => mappings.decide(tx, row.id, Number(row.version), { move: 'APPROVE', reason: 'Đã đối chiếu với thông báo mời thầu' }, memberId(SUBMITTER), NOW), SUBMITTER);
}

const sourceContext = (tx: TenantTx, now: Date, options: { member?: number; holds?: boolean } = {}): SourceContext => ({
  tx,
  membershipId: memberId(options.member ?? THIRD),
  now,
  today: now.toISOString().slice(0, 10),
  view: 'scope',
  unitScope: () => ({ sql: 'true', params: [] }),
  projectScope: () => ({ sql: 'true', params: [] }),
  rules: DEFAULT_SEVERITY_RULES,
  counting: false,
  holds: () => options.holds === true,
});

let counter = 0;

describe('the duties of posting to the national procurement network, the reconciliation and the milestones (EGP-2)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      for (const member of [PREPARER, SUBMITTER, THIRD, 4]) await harness.seedMembership(tenant, member, 1);
    }
    await harness.seedRole(TENANT_A, 7, 'RECONCILER', ['bid.egp.reconcile', 'bid.egp.post.prepare'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 71, member: SUBMITTER, role: 7, kind: 'TENANT' },
      { n: 72, member: 4, role: 7, kind: 'TENANT' },
    ]);
    // Tenant A has the published working calendar of two years; tenant B has none (a deadline is never guessed).
    await owner(
      `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
       select $1, gen_random_uuid(), 'WORKDAY_VN', y, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $2, $2, now() from unnest(array[2026, 2027]) as y`,
      [TENANT_A, memberId(PREPARER)],
    );
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the obligations', () => {
    const openPlan = async (day = '2026-11-02T03:00:00Z'): Promise<{ planId: string; projectCode: string }> => {
      const seeded = await seedBidPackage(harness, { status: 'PLANNED' });
      const planId = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.procurement_plan (tenant_id, id, project_id, revision, title, total_value_vnd, legal_basis, decision_document_id, status, submitted_by, submitted_at, approved_by, approved_at, created_by, updated_by)
           values ($1, $2, $3, 1, 'Plan', 1000, 'Luat Dau thau', $4, 'APPROVED', $8, $6::timestamptz, $5, $6::timestamptz, $7, $7)`,
          [TENANT_A, planId, seeded.projectId, randomUUID(), memberId(SUBMITTER), day, memberId(PREPARER), memberId(THIRD)],
        ],
      ]);
      return { planId, projectCode: seeded.projectCode };
    };

    it('opens from the facts the register states, from the cutover day, with the deadline of the rule on the working calendar, once however often the sweep runs', async () => {
      const { planId, projectCode } = await openPlan();
      const early = await openPlan('2026-06-02T03:00:00Z');
      const first = await as((tx) => obligations.sweep(tx, { since: '2026-10-01', ownerId: memberId(PREPARER), kinds: ['PLAN'] }, memberId(PREPARER), NOW));
      expect(first.outcomes).toEqual([{ fact: 'PLAN_APPROVED', kind: 'PLAN', opened: 1, existing: 0, truncated: false }]);
      const row = first.opened[0];
      expect(row).toMatchObject({ kind: 'PLAN', subjectType: 'PLAN', subjectId: planId, subjectCode: `${projectCode}-R1`, state: 'DUE', ownerId: memberId(PREPARER), triggerEvent: 'DECISION_APPROVED', ruleCode: 'PLAN', ruleVersion: 0, ruleSource: 'DEFAULT', legalStatus: 'UNVERIFIED', remindBeforeDays: 2, version: 1 });
      // Monday 2 November 2026: five working days later is Monday 9 November, the end of the working window (17:00 in Vietnam).
      expect(row?.dueAt).toBe('2026-11-09T10:00:00.000Z');
      const second = await as((tx) => obligations.sweep(tx, { since: '2026-10-01', ownerId: memberId(PREPARER), kinds: ['PLAN'] }, memberId(PREPARER), NOW));
      expect(second.outcomes[0]).toMatchObject({ opened: 0, existing: 1 });
      // A plan approved before the cutover is not a duty of this system.
      expect(await owner('select count(*)::int as n from machvon.egp_posting_obligation where source_ref = $1', [early.planId])).toEqual([{ n: 0 }]);
      expect(await as((tx) => obligations.history(tx, (row as { id: string }).id))).toMatchObject([{ action: 'OPENED', stateAfter: 'DUE', version: 1, actorId: memberId(PREPARER) }]);
    });

    it('opens by hand for a fact the register does not state, names an active member as owner, and refuses a tenant that has no calendar rather than guess a deadline', async () => {
      const subject = randomUUID();
      const context = await as((tx) => obligations.contextOf(tx, 'NOTICE', NOW));
      const opened = await as((tx) => obligations.open(tx, { kind: 'NOTICE', subjectType: 'NOTICE', subjectId: subject, subjectCode: 'GT-HAND-1', sourceRef: subject, triggeredAt: new Date('2026-11-04T03:00:00Z'), ownerId: memberId(PREPARER) }, context, memberId(PREPARER)));
      expect(opened.created).toBe(true);
      expect(opened.row.dueAt).toBe('2026-11-11T10:00:00.000Z');
      expect(await refusal(as((tx) => obligations.open(tx, { kind: 'NOTICE', subjectType: 'NOTICE', subjectId: subject, subjectCode: 'GT-HAND-2', sourceRef: randomUUID(), triggeredAt: new Date('2026-11-04T03:00:00Z'), ownerId: randomUUID() }, context, memberId(PREPARER))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owner_id' });
      expect(await refusal(as((tx) => obligations.open(tx, { kind: 'NOTICE', subjectType: 'CONTRACT', subjectId: subject, subjectCode: 'x', sourceRef: randomUUID(), triggeredAt: NOW, ownerId: memberId(PREPARER) }, context, memberId(PREPARER))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'subject_type' });
      expect(await refusal(as((tx) => obligations.contextOf(tx, 'NOTICE', NOW), PREPARER, TENANT_B))).toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422 });
    });

    it('moves DUE, PREPARED, SUBMITTED, RECEIPTED by two different people, keeps each move in the history, and refuses a stale version', async () => {
      const { planId } = await openPlan('2026-11-03T03:00:00Z');
      const [row] = (await as((tx) => obligations.sweep(tx, { since: '2026-10-01', ownerId: memberId(PREPARER), kinds: ['PLAN'] }, memberId(PREPARER), NOW))).opened.filter((entry) => entry.subjectId === planId);
      const id = (row as { id: string }).id;
      expect(await refusal(as((tx) => obligations.prepare(tx, id, 1, { fields: { plan_name: 'Kế hoạch' }, batch: undefined }, memberId(PREPARER), NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'fields.decision_no' });
      expect(await refusal(as((tx) => obligations.submit(tx, id, 1, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'EGP_OBLIGATION_STATE_INVALID', status: 409 });
      const prepared = await as((tx) => obligations.prepare(tx, id, 1, { fields: { plan_name: 'Kế hoạch lựa chọn nhà thầu', decision_no: '123/QĐ-UBND', approved_on: '2026-11-03' }, batch: undefined }, memberId(PREPARER), NOW));
      expect(prepared.row).toMatchObject({ state: 'PREPARED', preparedBy: memberId(PREPARER), version: 2 });
      expect(prepared.row.packetSha256).toMatch(/^[0-9a-f]{64}$/);
      expect((prepared.row.packet as { fields: Record<string, string> }).fields.decision_no).toBe('123/QĐ-UBND');
      expect(await refusal(as((tx) => obligations.submit(tx, id, 2, memberId(PREPARER), NOW)))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => obligations.submit(tx, id, 1, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'VERSION_CONFLICT' });
      // The database holds the same rule: the person who prepared cannot be written down as the one who submitted.
      expect(await databaseRefusal(owner(`update machvon.egp_posting_obligation set state = 'SUBMITTED', submitted_by = prepared_by, submitted_at = now(), version = version + 1 where id = $1`, [id]))).toContain('egp_posting_maker_checker_chk');
      const submitted = await as((tx) => obligations.submit(tx, id, 2, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(submitted.row).toMatchObject({ state: 'SUBMITTED', submittedBy: memberId(SUBMITTER), version: 3 });
      expect(await refusal(as((tx) => obligations.receipt(tx, id, 3, { receiptRef: '', receiptedAt: NOW }, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'receipt_ref' });
      expect(await refusal(as((tx) => obligations.receipt(tx, id, 3, { receiptRef: 'BN-1', receiptedAt: new Date(NOW.getTime() - 86_400_000) }, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'receipted_at' });
      expect(await refusal(as((tx) => obligations.receipt(tx, id, 3, { receiptRef: 'BN-1', receiptedAt: new Date(NOW.getTime() + 3 * 3_600_000) }, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'receipted_at' });
      const receipted = await as((tx) => obligations.receipt(tx, id, 3, { receiptRef: 'BN-2026-0001', receiptedAt: NOW }, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(receipted.row).toMatchObject({ state: 'RECEIPTED', receiptRef: 'BN-2026-0001', receiptRecordedBy: memberId(SUBMITTER), version: 4 });
      expect((await as((tx) => obligations.history(tx, id))).map((entry) => entry.action)).toEqual(['OPENED', 'PREPARED', 'SUBMITTED', 'RECEIPTED']);
      // A receipted obligation is final, for the application and for the database; a receipt is never changed or deleted.
      expect(await refusal(as((tx) => obligations.cancel(tx, id, 4, 'Không còn gì để đăng vì gói thầu đã hủy', memberId(PREPARER), NOW)))).toMatchObject({ code: 'EGP_OBLIGATION_STATE_INVALID' });
      expect(await databaseRefusal(owner(`update machvon.egp_posting_obligation set version = version + 1 where id = $1`, [id]))).toContain('final');
      expect(await databaseRefusal(as((tx) => tx.query(`update machvon.egp_posting_receipt set receipt_ref = 'X' where obligation_id = $1`, [id])))).toMatch(/permission denied|append-only/);
      expect(await databaseRefusal(owner(`delete from machvon.egp_posting_receipt where obligation_id = $1`, [id]))).toContain('append-only');
    });

    it('takes a receipt reference once in the tenant, a rejection that puts the clock back and clears the submission, and a cancellation that needs a sentence', async () => {
      const opened: string[] = [];
      for (const day of ['2026-11-04T03:00:00Z', '2026-11-05T03:00:00Z']) {
        counter += 1;
        const subject = randomUUID();
        const context = await as((tx) => obligations.contextOf(tx, 'CONTRACT_INFO', NOW));
        const row = (await as((tx) => obligations.open(tx, { kind: 'CONTRACT_INFO', subjectType: 'CONTRACT', subjectId: subject, subjectCode: `HD-${counter}`, sourceRef: subject, triggeredAt: new Date(day), ownerId: memberId(PREPARER) }, context, memberId(PREPARER)))).row;
        opened.push(row.id);
      }
      const fields = { contract_no: 'HD-1', signed_on: '2026-11-04', contractor_tax_code: '0101234567', contract_price: '1000000000' };
      const [one, two] = opened as [string, string];
      for (const id of opened) {
        await as((tx) => obligations.prepare(tx, id, 1, { fields, batch: undefined }, memberId(PREPARER), NOW));
        await as((tx) => obligations.submit(tx, id, 2, memberId(SUBMITTER), NOW), SUBMITTER);
      }
      await as((tx) => obligations.receipt(tx, one, 3, { receiptRef: 'BN-DUP-1', receiptedAt: NOW }, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(await refusal(as((tx) => obligations.receipt(tx, two, 3, { receiptRef: 'BN-DUP-1', receiptedAt: NOW }, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'EGP_RECEIPT_DUPLICATE', status: 409 });
      expect(await refusal(as((tx) => obligations.reject(tx, two, 3, 'Sai', memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const rejected = await as((tx) => obligations.reject(tx, two, 3, 'Hệ thống mạng từ chối vì thiếu mã số thuế', memberId(SUBMITTER), NOW), SUBMITTER);
      expect(rejected.row).toMatchObject({ state: 'REJECTED', rejectionReason: 'Hệ thống mạng từ chối vì thiếu mã số thuế', submittedBy: SUBMITTER === 2 ? memberId(SUBMITTER) : null });
      // The clock of a rejected posting is the clock of an open one: the submission did not count.
      expect(clockOfRow(rejected.row, new Date('2027-01-01T00:00:00Z'), { urgent_within_hours: 24 }).clock.status).toBe('OVERDUE');
      const again = await as((tx) => obligations.prepare(tx, two, 4, { fields, batch: undefined }, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(again.row).toMatchObject({ state: 'PREPARED', preparedBy: memberId(SUBMITTER), submittedBy: null, submittedAt: null, rejectionReason: null, version: 5 });
      expect(await refusal(as((tx) => obligations.cancel(tx, two, 5, 'Quá ngắn', memberId(PREPARER), NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const cancelled = await as((tx) => obligations.cancel(tx, two, 5, 'Hợp đồng đã được đăng bằng bản khác nên không đăng lại', memberId(PREPARER), NOW));
      expect(cancelled.row).toMatchObject({ state: 'CANCELLED', cancelledBy: memberId(PREPARER) });
      expect(clockOfRow(cancelled.row, NOW, { urgent_within_hours: 24 }).clock.status).toBe('CANCELLED');
    });

    it('takes a batch of the contractor export as the packet of an evaluation or a violation, and its receipt is the receipt of the batch', async () => {
      const batchId = randomUUID();
      const sha = 'b'.repeat(64);
      await seedAs(harness, [
        [
          `insert into machvon.contractor_export_batch (tenant_id, id, scope, period_from, period_to, format, file_sha256, file_object_key, row_count, status, created_by, version) values ($1, $2, 'VIOLATION', '2026-01-01', '2026-10-31', 'CSV', $3, 'k', 4, 'GENERATED', $4, 1)`,
          [TENANT_A, batchId, sha, memberId(PREPARER)],
        ],
      ]);
      const subject = randomUUID();
      const context = await as((tx) => obligations.contextOf(tx, 'VIOLATION', NOW));
      const row = (await as((tx) => obligations.open(tx, { kind: 'VIOLATION', subjectType: 'CONTRACTOR', subjectId: subject, subjectCode: '0101234567', sourceRef: randomUUID(), triggeredAt: new Date('2026-11-04T03:00:00Z'), ownerId: memberId(PREPARER) }, context, memberId(PREPARER)))).row;
      const batch = { id: batchId, fileSha256: sha, rowCount: 4, scope: 'VIOLATION', periodFrom: '2026-01-01', periodTo: '2026-10-31' };
      expect(await refusal(as((tx) => obligations.prepare(tx, row.id, 1, { fields: undefined, batch: { ...batch, scope: 'PERFORMANCE' } }, memberId(PREPARER), NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'export_batch_id' });
      const prepared = await as((tx) => obligations.prepare(tx, row.id, 1, { fields: undefined, batch }, memberId(PREPARER), NOW));
      expect(prepared.row).toMatchObject({ exportBatchId: batchId, packetSha256: sha });
      await as((tx) => obligations.submit(tx, row.id, 2, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(await as((tx) => obligations.find(tx, row.id))).toMatchObject({ state: 'SUBMITTED' });
      // A posting that is not of the contractor export cannot take a batch.
      const plan = (await as((tx) => obligations.open(tx, { kind: 'NOTICE', subjectType: 'NOTICE', subjectId: subject, subjectCode: 'n', sourceRef: randomUUID(), triggeredAt: NOW, ownerId: memberId(PREPARER) }, { ...context, rule: { ...context.rule, code: 'NOTICE' } }, memberId(PREPARER)))).row;
      expect(await refusal(as((tx) => obligations.prepare(tx, plan.id, 1, { fields: undefined, batch }, memberId(PREPARER), NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'export_batch_id' });
    });

    it('counts by state and by clock, filters the list, and names the holders of a right over the whole tenant', async () => {
      const counts = await as((tx) => obligations.counts(tx, NOW));
      expect(counts.total).toBeGreaterThanOrEqual(5);
      expect(counts.byState.RECEIPTED).toBeGreaterThanOrEqual(2);
      expect(counts.met + counts.metLate).toBeGreaterThanOrEqual(2);
      const open = await as((tx) => obligations.list(tx, { group: 'OPEN' }, { limit: 50, after: undefined }, NOW));
      expect(open.every((row) => ['DUE', 'PREPARED', 'REJECTED'].includes(row.state))).toBe(true);
      expect(open.map((row) => row.dueAt)).toEqual([...open.map((row) => row.dueAt)].sort());
      const later = new Date('2026-12-30T00:00:00Z');
      const overdue = await as((tx) => obligations.list(tx, { clock: 'OVERDUE' }, { limit: 50, after: undefined }, later));
      expect(overdue.length).toBeGreaterThanOrEqual(1);
      const page = await as((tx) => obligations.list(tx, { group: 'OPEN' }, { limit: 1, after: undefined }, NOW));
      const rest = await as((tx) => obligations.list(tx, { group: 'OPEN' }, { limit: 50, after: { key: (page[0] as { dueAtKey: string }).dueAtKey, id: (page[0] as { id: string }).id } }, NOW));
      expect(rest.map((row) => row.id)).not.toContain((page[0] as { id: string }).id);
      expect(await as((tx) => obligations.holdersOf(tx, 'bid.egp.reconcile', NOW))).toEqual([memberId(SUBMITTER), memberId(4)].sort());
      expect(await as((tx) => obligations.holdersOf(tx, 'bid.egp.nothing', NOW))).toEqual([]);
    });

    it('is a source of the alert centre: due soon is to be acted on, urgent with little time left, overdue is urgent, nothing once submitted, and each reader sees what is theirs or what their role covers', async () => {
      const sources = new HomeEgpPostingSources();
      const { planId } = await openPlan('2026-11-05T03:00:00Z');
      const [fresh] = (await as((tx) => obligations.sweep(tx, { since: '2026-10-01', ownerId: memberId(PREPARER), kinds: ['PLAN'] }, memberId(PREPARER), NOW))).opened.filter((entry) => entry.subjectId === planId);
      const due = new Date(Date.parse((fresh as { dueAt: string }).dueAt));
      const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id);
      const soon = new Date(due.getTime() - 40 * 3_600_000);
      const found = await as((tx) => sources.items(sourceContext(tx, soon, { member: PREPARER })));
      const one = found.find((row) => row.id === fresh?.id);
      expect(one).toMatchObject({ kind: 'EGP_POSTING_DUE', source: 'EGP_POSTING', severity: 'ACTION', status: 'DUE', target: { screen: 'BID-32' }, lifecycle: 'NEW' });
      expect(one?.consequence).toContain('vi phạm');
      expect(one?.title).toContain(fresh?.subjectCode);
      const urgent = await as((tx) => sources.items(sourceContext(tx, new Date(due.getTime() - 5 * 3_600_000), { member: PREPARER })));
      expect(urgent.find((row) => row.id === fresh?.id)).toMatchObject({ kind: 'EGP_POSTING_DUE', severity: 'URGENT' });
      const late = await as((tx) => sources.items(sourceContext(tx, new Date(due.getTime() + 3_600_000), { member: PREPARER })));
      expect(late.find((row) => row.id === fresh?.id)).toMatchObject({ kind: 'EGP_POSTING_OVERDUE', severity: 'URGENT', startedAt: due.toISOString() });
      // A person who is not the owner sees it only with the role of the procurement officers over the whole tenant.
      expect(ids(await as((tx) => sources.items(sourceContext(tx, soon, { member: THIRD, holds: false }))))).not.toContain(fresh?.id);
      expect(ids(await as((tx) => sources.items(sourceContext(tx, soon, { member: THIRD, holds: true }))))).toContain(fresh?.id);
      // Long before the reminder window nothing is raised; once submitted nothing is raised, late or not.
      expect(ids(await as((tx) => sources.items(sourceContext(tx, new Date(due.getTime() - 30 * 86_400_000), { member: PREPARER }))))).not.toContain(fresh?.id);
      const id = (fresh as { id: string }).id;
      await as((tx) => obligations.prepare(tx, id, 1, { fields: { plan_name: 'Kế hoạch', decision_no: '1/QĐ', approved_on: '2026-11-05' }, batch: undefined }, memberId(PREPARER), NOW));
      await as((tx) => obligations.submit(tx, id, 2, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(ids(await as((tx) => sources.items(sourceContext(tx, new Date(due.getTime() + 3_600_000), { member: PREPARER }))))).not.toContain(id);
    });

    it('shows the rules the figures come from: the deadline and the severity, each with its version, source and the flag UNVERIFIED', async () => {
      const deadline = await as((tx) => obligations.deadlineRule(tx, 'CONTRACTOR_PERFORMANCE', NOW));
      expect(deadline).toMatchObject({ version: 0, source: 'DEFAULT', unverified: true, legalStatus: 'UNVERIFIED', params: { due_in: 6, due_unit: 'MONTHS' } });
      expect(deadline.formula).toContain('due_in');
      const severity = await as((tx) => obligations.severityRule(tx, NOW));
      expect(severity).toMatchObject({ params: { urgent_within_hours: 24 }, source: 'DEFAULT', unverified: true });
    });
  });

  describe('the reconciliation', () => {
    async function mappedPackage(price: string, name: string, theirPrice: string, theirName: string): Promise<{ packageId: string; packageCode: string; projectCode: string; external: string; importId: string }> {
      counter += 1;
      const seeded = await seedBidPackage(harness, { budgetVnd: price });
      await seedAs(harness, [['update machvon.procurement_package set title = $2 where id = $1', [seeded.packageId, name]]]);
      const external = `PK-R${counter}-${randomUUID().slice(0, 4)}`;
      const loaded = await apply('KHLCNT', bytes(KHLCNT_HEADER, `PL-R${counter},${external},${theirName},${theirPrice},OPEN_BIDDING,2026-10-20,12/QD,${seeded.projectCode},${seeded.packageCode}`));
      await approveMappings(seeded.packageId);
      return { packageId: seeded.packageId, packageCode: seeded.packageCode, projectCode: seeded.projectCode, external, importId: loaded.importId };
    }

    it('opens one item for each field that differs, with an owner who is not a maker, a due time from the rule, and nothing for a field that is equal or that the file leaves empty', async () => {
      const mapped = await mappedPackage('1000000000', 'Xây dựng đường số 1', '1200000000', 'Xây dựng đường số 1');
      const result = await as((tx) => reconciliations.reconcile(tx, { subjectType: 'PACKAGE', ownerId: memberId(PREPARER), holders: [memberId(SUBMITTER), memberId(4)] }, memberId(THIRD), NOW), THIRD);
      expect(result).toMatchObject({ examined: 1, opened: 1, differences: 1, unchanged: 0, noOwner: 0 });
      const item = result.rows[0];
      expect(item).toMatchObject({ subjectType: 'PACKAGE', subjectId: mapped.packageId, subjectCode: mapped.packageCode, externalCode: mapped.external, field: 'estimated_price', differenceKind: 'VALUE_MISMATCH', ours: '1000000000', theirs: '1200000000', delta: '200000000', state: 'OPEN', version: 1 });
      // The loader of the file and the maker of the package (the first member) are makers: the owner is the first holder who is not.
      expect(item?.makerIds).toContain(memberId(PREPARER));
      expect(item?.ownerId).toBe(memberId(SUBMITTER));
      // Ten working days after Sunday 8 November 2026 (the day itself is not counted): Friday 20 November, end of the working window.
      expect(item?.dueAt).toBe('2026-11-20T10:00:00.000Z');
      expect(item?.sourceRecordId).not.toBeNull();
      expect(await as((tx) => reconciliations.dueRule(tx, NOW))).toMatchObject({ days: 10, source: 'DEFAULT', unverified: true, legalStatus: 'UNVERIFIED' });
    });

    it('is idempotent: reading the same records again opens nothing, and a difference nobody may answer for is counted and opens nothing', async () => {
      const again = await as((tx) => reconciliations.reconcile(tx, { subjectType: 'PACKAGE', ownerId: memberId(PREPARER), holders: [memberId(SUBMITTER)] }, memberId(THIRD), NOW), THIRD);
      expect(again).toMatchObject({ opened: 0, unchanged: expect.any(Number) });
      expect(again.unchanged).toBeGreaterThanOrEqual(1);
      const lonely = await mappedPackage('500000000', 'Cầu A', '600000000', 'Cầu A');
      const none = await as((tx) => reconciliations.reconcile(tx, { subjectType: 'PACKAGE', ownerId: memberId(PREPARER), holders: [memberId(PREPARER)] }, memberId(THIRD), NOW), THIRD);
      expect(none.noOwner).toBeGreaterThanOrEqual(1);
      expect(await owner('select count(*)::int as n from machvon.egp_reconciliation_item where subject_id = $1', [lonely.packageId])).toEqual([{ n: 0 }]);
    });

    it('settles an item with the four resolutions: the owner is not a maker, the reason and the evidence and the review day are judged, and a settled item never changes', async () => {
      const mapped = await mappedPackage('2000000000', 'Trường học B', '2100000000', 'Trường học B');
      const [item] = (await as((tx) => reconciliations.reconcile(tx, { subjectType: 'PACKAGE', ownerId: memberId(PREPARER), holders: [memberId(SUBMITTER)] }, memberId(THIRD), NOW), THIRD)).rows.filter((row) => row.subjectId === mapped.packageId);
      const id = (item as { id: string }).id;
      // The people who made the record (the maker of the package, the loader of the file) never settle it.
      expect(await refusal(as((tx) => reconciliations.resolve(tx, id, 1, { kind: 'ACCEPT_EXTERNAL', reason: 'Số trên mạng đúng' }, memberId(PREPARER), NOW)))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => reconciliations.resolve(tx, id, 9, { kind: 'ACCEPT_EXTERNAL', reason: 'Số trên mạng đúng theo biên bản' }, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(as((tx) => reconciliations.resolve(tx, id, 1, { kind: 'ACCEPT_EXTERNAL', reason: 'ngắn' }, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(as((tx) => reconciliations.resolve(tx, id, 1, { kind: 'DISPUTE', reason: 'Số trên mạng sai so với quyết định phê duyệt' }, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_ref' });
      expect(await refusal(as((tx) => reconciliations.resolve(tx, id, 1, { kind: 'WAIVE', reason: 'Để lại đến khi có biên bản xác nhận của chủ đầu tư', reviewOn: '2026-11-08' }, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'review_on' });
      expect(await refusal(as((tx) => reconciliations.resolve(tx, id, 1, { kind: 'WAIVE', reason: 'Để lại đến khi có biên bản xác nhận của chủ đầu tư', reviewOn: '2028-01-01' }, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'review_on' });
      // The database holds the same rule: an owner who is a maker cannot be written, nor a resolver.
      expect(await databaseRefusal(owner(`update machvon.egp_reconciliation_item set state = 'RESOLVED', resolution_kind = 'ACCEPT_EXTERNAL', resolved_by = maker_ids[1], resolved_at = now(), reason = 'Số trên mạng đúng', version = version + 1 where id = $1`, [id]))).toContain('egp_reconciliation_resolution_chk');
      const done = await as((tx) => reconciliations.resolve(tx, id, 1, { kind: 'DISPUTE', reason: 'Số trên mạng sai so với quyết định phê duyệt', evidenceRef: 'CV-123/SKHDT ngày 05/11/2026' }, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(done.row).toMatchObject({ state: 'RESOLVED', resolutionKind: 'DISPUTE', resolvedBy: memberId(SUBMITTER), evidenceRef: 'CV-123/SKHDT ngày 05/11/2026', version: 2 });
      expect(done.followUp).toBe('ESCALATE_TO_OPERATOR');
      expect(await refusal(as((tx) => reconciliations.resolve(tx, id, 2, { kind: 'ACCEPT_EXTERNAL', reason: 'Đổi ý sau khi đã khiếu nại' }, memberId(SUBMITTER), NOW), SUBMITTER))).toMatchObject({ code: 'EGP_RECONCILIATION_STATE_INVALID', status: 409 });
      expect(await databaseRefusal(owner(`update machvon.egp_reconciliation_item set reason = 'Sửa lại lý do sau khi đã giải quyết xong' where id = $1`, [id]))).toContain('never changes');
      // A settled difference does not come back while both figures stand.
      const next_ = await as((tx) => reconciliations.reconcile(tx, { subjectType: 'PACKAGE', ownerId: memberId(PREPARER), holders: [memberId(SUBMITTER)] }, memberId(THIRD), NOW), THIRD);
      expect(next_.settledAlready).toBeGreaterThanOrEqual(1);
      expect(next_.rows.filter((row) => row.subjectId === mapped.packageId)).toEqual([]);
    });

    it('brings a waived difference back on its review day, and a settled one back when a figure moved', async () => {
      const mapped = await mappedPackage('3000000000', 'Bệnh viện C', '3300000000', 'Bệnh viện C');
      const [item] = (await as((tx) => reconciliations.reconcile(tx, { subjectType: 'PACKAGE', ownerId: memberId(PREPARER), holders: [memberId(SUBMITTER)] }, memberId(THIRD), NOW), THIRD)).rows.filter((row) => row.subjectId === mapped.packageId);
      const waived = await as((tx) => reconciliations.resolve(tx, (item as { id: string }).id, 1, { kind: 'WAIVE', reason: 'Chờ chủ đầu tư điều chỉnh dự toán rồi xem lại', reviewOn: '2026-12-01' }, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(waived.row).toMatchObject({ resolutionKind: 'WAIVE', reviewOn: '2026-12-01' });
      expect(waived.followUp).toBe('REVIEW_ON_DAY');
      expect(await as((tx) => reconciliations.counts(tx, new Date('2026-12-02T03:00:00Z')))).toMatchObject({ waiversDue: expect.any(Number) });
      const before = await as((tx) => reconciliations.reconcile(tx, { subjectType: 'PACKAGE', ownerId: memberId(PREPARER), holders: [memberId(SUBMITTER)] }, memberId(THIRD), new Date('2026-11-20T03:00:00Z')), THIRD);
      expect(before.rows.filter((row) => row.subjectId === mapped.packageId)).toEqual([]);
      const after = await as((tx) => reconciliations.reconcile(tx, { subjectType: 'PACKAGE', ownerId: memberId(PREPARER), holders: [memberId(SUBMITTER)] }, memberId(THIRD), new Date('2026-12-02T03:00:00Z')), THIRD);
      expect(after.rows.filter((row) => row.subjectId === mapped.packageId)).toHaveLength(1);
      // A figure moved on our side: the same field now differs by another value and is a new item once the open one is settled.
      await seedAs(harness, [['update machvon.procurement_package set budget_vnd = 3100000000 where id = $1', [mapped.packageId]]]);
      const open = (after.rows.find((row) => row.subjectId === mapped.packageId) as { id: string; version: number });
      await as((tx) => reconciliations.resolve(tx, open.id, open.version, { kind: 'CORRECT_OURS', reason: 'Số của đơn vị đúng theo dự toán' }, memberId(SUBMITTER), new Date('2026-12-02T03:00:00Z')), SUBMITTER);
      const moved = await as((tx) => reconciliations.reconcile(tx, { subjectType: 'PACKAGE', ownerId: memberId(PREPARER), holders: [memberId(SUBMITTER)] }, memberId(THIRD), new Date('2026-12-02T04:00:00Z')), THIRD);
      expect(moved.rows.find((row) => row.subjectId === mapped.packageId)).toMatchObject({ ours: '3100000000', theirs: '3300000000', delta: '200000000' });
    });

    it('reads the notice, the result and the contractor against the register: dates by their Vietnam day, the winner by tax code, and a field only when we hold it', async () => {
      counter += 1;
      const seeded = await seedBidPackage(harness, { budgetVnd: '4000000000' });
      const tax = String(1_300_000_000 + counter);
      const contractorId = randomUUID();
      await seedAs(harness, [
        [`insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by) values ($1, $2, $3, 'Công ty Xây dựng An Phát', 'VERIFIED', $4, $5)`, [TENANT_A, contractorId, tax, randomUUID(), memberId(PREPARER)]],
        [
          `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, outcome, status, submitted_by, approved_by, approved_at, decision_document_id, created_by, updated_by)
           values ($1, $2, $3, $4, 3900000000, 'AWARDED', 'APPROVED', $5, $6, '2026-10-30T03:00:00Z', $7, $5, $5)`,
          [TENANT_A, randomUUID(), seeded.packageId, contractorId, memberId(PREPARER), memberId(SUBMITTER), randomUUID()],
        ],
      ]);
      const notice = `TB-${counter}`;
      const result = `KQ-${counter}`;
      const external = `PK-N${counter}`;
      await apply('TBMT', bytes(TBMT_HEADER, `${notice},0,INVITATION,${external},PL-N,2026-10-05,2026-10-25,2026-10-25,4000000000,,${seeded.projectCode},${seeded.packageCode}`));
      await apply('RESULT', bytes(RESULT_HEADER, `${result},${notice},${external},AWARDED,2026-11-01,2026-10-29,${tax},3950000000,Công ty Xây dựng An Phát,${seeded.projectCode},${seeded.packageCode}`));
      await apply('CONTRACTOR', bytes('contractor_tax_code,contractor_name,external_contractor_code,legal_status,registered_address,violation_count,as_of', `${tax},Công ty Xây dựng An Phát,,ACTIVE,Hà Nội,0,2026-11-01`));
      await approveMappings(seeded.packageId);
      await approveMappings(contractorId);
      // Our milestones: the notice was published on the day of the file, the bids closed a day earlier than the network says.
      await seedAs(harness, [
        [`insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, actual_at, source, created_by, updated_by, version) values ($1, gen_random_uuid(), $2, 'INVITATION_PUBLISHED', '2026-10-04T17:30:00Z', 'MANUAL', $3, $3, 1)`, [TENANT_A, seeded.packageId, memberId(PREPARER)]],
        [`insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, actual_at, source, created_by, updated_by, version) values ($1, gen_random_uuid(), $2, 'BID_CLOSING', '2026-10-23T08:00:00Z', 'MANUAL', $3, $3, 1)`, [TENANT_A, seeded.packageId, memberId(PREPARER)]],
      ]);
      const read = await as((tx) => reconciliations.reconcile(tx, { ownerId: memberId(SUBMITTER), holders: [memberId(4)] }, memberId(THIRD), NOW), THIRD);
      const mine = read.rows.filter((row) => [seeded.packageId, contractorId].includes(row.subjectId));
      const byField = (subject: string, field: string) => mine.find((row) => row.subjectType === subject && row.field === field);
      // The day the invitation was published is the same Vietnam day (the instant differs); the closing day differs; the opening day is missing on our side.
      expect(byField('NOTICE', 'published_at')).toBeUndefined();
      expect(byField('NOTICE', 'bid_closing_at')).toMatchObject({ differenceKind: 'VALUE_MISMATCH' });
      expect(byField('NOTICE', 'bid_opening_at')).toMatchObject({ differenceKind: 'MISSING_OURS', ours: null });
      // The result: the price differs, the winner and the kind agree, the publication day is missing on our side.
      expect(byField('RESULT', 'award_price')).toMatchObject({ ours: '3900000000', theirs: '3950000000', delta: '50000000' });
      expect(byField('RESULT', 'contractor_tax_code')).toBeUndefined();
      expect(byField('RESULT', 'result_kind')).toBeUndefined();
      expect(byField('RESULT', 'published_at')).toMatchObject({ differenceKind: 'MISSING_OURS' });
      // The contractor: the name agrees; the register keeps no legal status or address, so none is compared.
      expect(mine.filter((row) => row.subjectType === 'CONTRACTOR')).toEqual([]);
      expect(mine.every((row) => !row.makerIds.includes(row.ownerId))).toBe(true);
    });
  });

  describe('the dates of the notice and the result become the milestones of the package', () => {
    async function mappedNotice(options: { status?: string } = {}): Promise<{ packageId: string; notice: string; result: string; importId: string }> {
      counter += 1;
      const seeded = await seedBidPackage(harness, { ...(options.status === undefined ? {} : { status: options.status }) });
      const notice = `TB-H${counter}`;
      const result = `KQ-H${counter}`;
      const external = `PK-H${counter}`;
      const tbmt = await apply('TBMT', bytes(TBMT_HEADER, `${notice},0,INVITATION,${external},PL-H,2026-10-05,2026-10-25,2026-10-26,4000000000,,${seeded.projectCode},${seeded.packageCode}`));
      await apply('RESULT', bytes(RESULT_HEADER, `${result},${notice},${external},NO_QUALIFIED_BID,2026-11-01,2026-10-30,,,,${seeded.projectCode},${seeded.packageCode}`));
      await approveMappings(seeded.packageId);
      return { packageId: seeded.packageId, notice, result, importId: tbmt.importId };
    }

    it('fills the dates a package has none of, from the notice and the result that a person approved for it, as IMPORT milestones with the proof of the file, once', async () => {
      const mapped = await mappedNotice();
      const done = await as((tx) => hook.applyToPackage(tx, mapped.packageId, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(done?.fills.map((fill) => [fill.kind, fill.outcome])).toEqual([
        ['INVITATION_PUBLISHED', 'FILLED'],
        ['BID_CLOSING', 'FILLED'],
        ['BID_OPENING', 'FILLED'],
        ['RESULT_APPROVED', 'FILLED'],
        ['RESULT_PUBLISHED', 'FILLED'],
      ]);
      const held = await owner<{ milestone_kind: string; actual_at: string; source: string; import_batch_id: string | null }>(
        `select milestone_kind, to_char(actual_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as actual_at, source, import_batch_id from machvon.procurement_milestone where package_id = $1 order by milestone_kind`,
        [mapped.packageId],
      );
      expect(held).toHaveLength(5);
      expect(held.every((row) => row.source === 'IMPORT' && row.import_batch_id !== null)).toBe(true);
      expect(held.find((row) => row.milestone_kind === 'BID_CLOSING')?.actual_at).toBe('2026-10-25');
      expect(held.find((row) => row.milestone_kind === 'RESULT_APPROVED')?.actual_at).toBe('2026-10-30');
      // The batch is the proof of the file: its hash is the hash of the e-GP import.
      const batch = await owner<{ file_sha256: string; mode: string; status: string }>('select b.file_sha256, b.mode, b.status from machvon.procurement_import_batch b where b.id = $1', [held[0]?.import_batch_id]);
      const file = await owner<{ file_sha256: string }>('select file_sha256 from machvon.file_import where id = $1', [mapped.importId]);
      expect(batch[0]).toMatchObject({ mode: 'APPLY', status: 'APPLIED', file_sha256: file[0]?.file_sha256 });
      const again = await as((tx) => hook.applyToPackage(tx, mapped.packageId, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(again?.fills.every((fill) => fill.outcome === 'SAME_DAY')).toBe(true);
      expect(await owner('select count(*)::int as n from machvon.procurement_milestone where package_id = $1', [mapped.packageId])).toEqual([{ n: 5 }]);
    });

    it('never overwrites a date a person recorded, never writes a date out of the order of the milestones, a date in the future or one for a package that takes none', async () => {
      const mapped = await mappedNotice();
      await seedAs(harness, [
        [`insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, actual_at, source, created_by, updated_by, version) values ($1, gen_random_uuid(), $2, 'INVITATION_PUBLISHED', '2026-10-06T03:00:00Z', 'MANUAL', $3, $3, 1)`, [TENANT_A, mapped.packageId, memberId(PREPARER)]],
        [`insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, actual_at, source, created_by, updated_by, version) values ($1, gen_random_uuid(), $2, 'EVALUATION_DONE', '2026-10-25T10:00:00Z', 'MANUAL', $3, $3, 1)`, [TENANT_A, mapped.packageId, memberId(PREPARER)]],
      ]);
      const done = await as((tx) => hook.applyToPackage(tx, mapped.packageId, memberId(SUBMITTER), NOW), SUBMITTER);
      const outcome = (kind: string): string | undefined => done?.fills.find((fill) => fill.kind === kind)?.outcome;
      expect(outcome('INVITATION_PUBLISHED')).toBe('KEPT_OURS');
      expect(outcome('BID_CLOSING')).toBe('FILLED');
      // The bids open on 26 October in the file, after the evaluation that a person recorded on 25 October: the order of the milestones refuses it.
      expect(outcome('BID_OPENING')).toBe('ORDER_REFUSED');
      expect(await owner(`select source from machvon.procurement_milestone where package_id = $1 and milestone_kind = 'INVITATION_PUBLISHED'`, [mapped.packageId])).toEqual([{ source: 'MANUAL' }]);
      const closed = await mappedNotice({ status: 'CANCELLED' });
      const none = await as((tx) => hook.applyToPackage(tx, closed.packageId, memberId(SUBMITTER), NOW), SUBMITTER);
      expect(none?.fills.every((fill) => fill.outcome === 'PACKAGE_CLOSED')).toBe(true);
      expect(await owner('select count(*)::int as n from machvon.procurement_milestone where package_id = $1', [closed.packageId])).toEqual([{ n: 0 }]);
      // A moment that is still to come is not a milestone that has happened.
      const future = await mappedNotice();
      const early = await as((tx) => hook.applyToPackage(tx, future.packageId, memberId(SUBMITTER), new Date('2026-10-10T03:00:00Z')), SUBMITTER);
      expect(early?.fills.find((fill) => fill.kind === 'BID_CLOSING')?.outcome).toBe('IN_THE_FUTURE');
      expect(early?.fills.find((fill) => fill.kind === 'INVITATION_PUBLISHED')?.outcome).toBe('FILLED');
    });

    it('finds the package of an approved mapping and the packages an import gives dates to, and none for a mapping that is not ACTIVE or not about a notice, a result or a package', async () => {
      const mapped = await mappedNotice();
      const mapping = await owner<{ id: string }>(`select id from machvon.master_crosswalk where subject_id = $1 and subject_type = 'NOTICE'`, [mapped.packageId]);
      expect(await as((tx) => hook.packageOfMapping(tx, (mapping[0] as { id: string }).id))).toEqual({ packageId: mapped.packageId, subjectType: 'NOTICE' });
      expect(await as((tx) => hook.packageOfMapping(tx, randomUUID()))).toBeUndefined();
      expect(await as((tx) => hook.packagesOfImport(tx, mapped.importId))).toEqual([mapped.packageId]);
      expect(await as((tx) => hook.applyToPackage(tx, randomUUID(), memberId(SUBMITTER), NOW), SUBMITTER)).toBeUndefined();
      expect(next('x')).toMatch(/^x-/);
    });
  });
});
