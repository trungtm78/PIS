import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { CapAppropriationStore } from '../src/cap-appropriation-store';
import type { AppropriationInput, AppropriationOrigin } from '../src/cap-appropriation-store';
import { TenantDatabase, runInTransaction } from '../src/tenant-database';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new CapAppropriationStore();
const MAKER = 1;
const APPROVER = 2;
const BILLION = 1_000_000_000;
const TODAY = '2026-10-24';
let adminPool: Pool;
let appPool: Pool;
let tenants: TenantDatabase;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = MAKER): Promise<T> => tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const money = (billions: number): string => String(billions * BILLION);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

/** The SQL state of a statement the database refused. */
async function sqlState(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
}

const versions: Record<string, string> = {};
let counter = 0;
let yearCounter = 2100;

/** A year nobody else uses, so the lists of two tests never meet. */
const freshYear = (): number => {
  yearCounter -= 1;
  return yearCounter;
};

async function seedVersion(
  name: string,
  masterType: string,
  options: { attributes?: Record<string, unknown>; recordStatus?: string; versionStatus?: string; validFrom?: string; validUntil?: string | null; published?: boolean } = {},
  tenant = TENANT_A,
): Promise<string> {
  counter += 1;
  const recordId = randomUUID();
  const versionId = randomUUID();
  const key = `${name}-${counter}`;
  await harness.owner(tenant, [
    [
      `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
       values ($1, $2, 'TENANT', $3, $4, $5, $6, $6)`,
      [tenant, recordId, masterType, key, options.recordStatus ?? 'EFFECTIVE', memberId(MAKER)],
    ],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, $3, $4, 1, $5, $6::jsonb, $7::date, $8::date, $9, $10, case when $11::boolean then now() end, $12, $12)`,
      [tenant, versionId, masterType, key, `Label ${key}`, JSON.stringify(options.attributes ?? {}), options.validFrom ?? '2020-01-01', options.validUntil ?? null, options.versionStatus ?? 'EFFECTIVE', recordId, options.published ?? true, memberId(MAKER)],
    ],
  ]);
  return versionId;
}

async function document(options: { symbol?: string; status?: string } = {}, tenant = TENANT_A): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', $4, 'INTERNAL', $5, $5)`,
    [tenant, id, options.symbol ?? `QD-${id.slice(0, 8)}/2026`, options.status ?? 'EFFECTIVE', memberId(MAKER)],
    tenant,
  );
  return id;
}

async function input(overrides: Partial<AppropriationInput> = {}): Promise<AppropriationInput> {
  return {
    fundSourceVersionId: versions.nstw as string,
    planYear: 2026,
    origin: 'PM_ASSIGNED',
    budgetLevel: 'CENTRAL',
    amountVnd: money(10),
    decisionDocumentId: await document(),
    issuingAuthority: 'Thủ tướng Chính phủ',
    sourceYear: overrides.planYear ?? 2026,
    ...overrides,
  };
}

const register = async (overrides: Partial<AppropriationInput> = {}, tenant = TENANT_A) => as(async (tx) => store.register(tx, await input(overrides), memberId(MAKER), TODAY), tenant);
const decide = (id: string, version: number, decision: 'approve' | 'reject' | 'return' = 'approve', member = APPROVER, tenant = TENANT_A) =>
  as((tx) => store.decide(tx, id, version, decision, memberId(member), TODAY), tenant, member);
const find = (id: string, tenant = TENANT_A) => as((tx) => store.find(tx, id), tenant);

/** Registers and publishes. */
async function publish(overrides: Partial<AppropriationInput> = {}): Promise<{ id: string; version: number }> {
  const draft = await register(overrides);
  const done = await decide(draft.id, draft.version);
  return { id: draft.id, version: done.version };
}

/** The allocation command: it raises the setting that lets the allocated total change, in the same transaction as the change. */
const allocate = (id: string, total: string, tenant = TENANT_A) =>
  as(async (tx) => {
    await tx.query("select set_config('app.cap_allocation_write', 'on', true)");
    await tx.query('update machvon.appropriation set allocated_total_vnd = $2::numeric, version = version + 1 where id = $1::uuid', [id, total]);
  }, tenant);

const ledgerOf = (id: string) =>
  owner<{ entry_type: string; amount_vnd: string; appropriation_id: string; source_ref_id: string; reversal_of_id: string | null; plan_year: number }>(
    'select entry_type, amount_vnd::text as amount_vnd, appropriation_id, source_ref_id, reversal_of_id, plan_year from machvon.capital_ledger_entry where appropriation_id = $1::uuid or source_ref_id = $1::uuid order by posted_at, id',
    [id],
  );

describe('CapAppropriationStore (the appropriation register by origin, ST-CAP-001)', () => {
  beforeAll(async () => {
    await harness.start();
    appPool = new Pool({ connectionString: harness.database.urlFor('machvon_app'), max: 8 });
    adminPool = new Pool({ connectionString: harness.database.adminUrl, max: 4 });
    tenants = new TenantDatabase(appPool);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.seedMembership(tenant, MAKER, 1);
      await harness.seedMembership(tenant, APPROVER, 1);
    }
    versions.nstw = await seedVersion('NSTW-DTPT', 'FUND_SOURCE', { attributes: { category: 'NSTW', relation: 'ADDITIVE' } });
    versions.nsdp = await seedVersion('NSDP-DTPT', 'FUND_SOURCE', { attributes: { category: 'NSDP', relation: 'ADDITIVE' } });
    versions.oda = await seedVersion('ODA-WB', 'FUND_SOURCE', { attributes: { category: 'ODA', relation: 'ADDITIVE', onlending: true } });
    versions.subset = await seedVersion('CTMTQG-NTM', 'FUND_SOURCE', { attributes: { category: 'CTMTQG', relation: 'SUBSET_OF' } });
    versions.expired = await seedVersion('OLD-SOURCE', 'FUND_SOURCE', { attributes: { category: 'NSTW', relation: 'ADDITIVE' }, versionStatus: 'RETIRED', validUntil: '2024-01-01' });
    versions.unpublished = await seedVersion('DRAFT-SOURCE', 'FUND_SOURCE', { attributes: { category: 'NSTW', relation: 'ADDITIVE' }, versionStatus: 'DRAFT', published: false });
    versions.program = await seedVersion('NTM', 'PROGRAM');
    versions.program2 = await seedVersion('GNBV', 'PROGRAM');
    versions.programExpired = await seedVersion('OLD-PROGRAM', 'PROGRAM', { versionStatus: 'RETIRED', validUntil: '2024-01-01' });
    versions.sector = await seedVersion('TRANSPORT', 'SECTOR');
    versions.foreign = await seedVersion('NSTW-B', 'FUND_SOURCE', { attributes: { category: 'NSTW', relation: 'ADDITIVE' } }, TENANT_B);
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    await harness.stop();
  }, 60_000);

  describe('registering and publishing by origin', () => {
    it('lists a Prime Minister assigned and a local added appropriation separately with the remaining amount, once approved (AC-ST-CAP-001-1)', async () => {
      const year = freshYear();
      const gv01 = await document({ symbol: '1234/QD-TTg' });
      const gv02 = await document({ symbol: '45/NQ-HDND' });
      const assigned = await register({ planYear: year, origin: 'PM_ASSIGNED', budgetLevel: 'CENTRAL', fundSourceVersionId: versions.nstw as string, amountVnd: money(10), decisionDocumentId: gv01, issuingAuthority: ' Thủ tướng Chính phủ ' });
      const added = await register({ planYear: year, origin: 'LOCAL_ADDED', budgetLevel: 'LOCAL', fundSourceVersionId: versions.nsdp as string, amountVnd: money(4), decisionDocumentId: gv02, issuingAuthority: 'Hội đồng nhân dân tỉnh' });
      expect(assigned).toMatchObject({ version: 1, status: 'DRAFT', revision: 1 });
      // A draft is in the register for its approver, with nothing allocated yet.
      expect((await as((tx) => store.list(tx, { planYear: year }, { limit: 10, after: undefined }))).map((row) => row.status)).toEqual(['DRAFT', 'DRAFT']);

      expect(await decide(assigned.id, 1)).toMatchObject({ status: 'PUBLISHED', version: 2, supersededId: null, movedLines: 0 });
      await decide(added.id, 1);
      await allocate(assigned.id, money(6));

      const pm = await as((tx) => store.list(tx, { planYear: year, origin: 'PM_ASSIGNED' }, { limit: 10, after: undefined }));
      expect(pm).toHaveLength(1);
      expect(pm[0]).toMatchObject({
        id: assigned.id,
        origin: 'PM_ASSIGNED',
        budgetLevel: 'CENTRAL',
        planYear: year,
        sourceYear: year,
        amountVnd: money(10),
        allocatedTotalVnd: money(6),
        remainingVnd: money(4),
        status: 'PUBLISHED',
        revision: 1,
        supersedesId: null,
        issuingAuthority: 'Thủ tướng Chính phủ',
        decisionDocumentId: gv01,
        decisionSymbol: '1234/QD-TTg',
        decisionIssuedOn: '2026-01-15',
        isExtended: false,
        extendedTo: null,
      });
      expect(pm[0]?.fundSource).toMatchObject({ businessKey: expect.stringContaining('NSTW-DTPT'), category: 'NSTW', relation: 'ADDITIVE', onLending: null, validUntil: null });
      const local = await as((tx) => store.list(tx, { planYear: year, origin: 'LOCAL_ADDED', budgetLevel: 'LOCAL' }, { limit: 10, after: undefined }));
      expect(local.map((row) => [row.id, row.origin, row.remainingVnd, row.fundSource.category])).toEqual([[added.id, 'LOCAL_ADDED', money(4), 'NSDP']]);
      // The two are not merged: the other origin and the other level find nothing of them.
      expect(await as((tx) => store.list(tx, { planYear: year, origin: 'PM_ASSIGNED', budgetLevel: 'LOCAL' }, { limit: 10, after: undefined }))).toEqual([]);
      expect((await ledgerOf(assigned.id)).map((entry) => [entry.entry_type, entry.amount_vnd])).toEqual([['APPROPRIATE', money(10)]]);
      expect((await ledgerOf(added.id)).map((entry) => [entry.entry_type, entry.amount_vnd])).toEqual([['APPROPRIATE', money(4)]]);
    });

    it('keeps central support and revenue increase as source groups of their own, apart from the Prime Minister assigned capital (AC-ST-CAP-001-2)', async () => {
      const year = freshYear();
      const support = await publish({ planYear: year, origin: 'CENTRAL_SUPPORT', amountVnd: money(20), budgetLevel: 'CENTRAL' });
      const revenue = await publish({ planYear: year, origin: 'REVENUE_INCREASE', amountVnd: money(15), budgetLevel: 'LOCAL', fundSourceVersionId: versions.nsdp as string });
      const pm = await publish({ planYear: year, origin: 'PM_ASSIGNED', amountVnd: money(10) });
      await allocate(support.id, money(20));
      await allocate(revenue.id, money(15));

      const rows = await as((tx) => store.list(tx, { planYear: year }, { limit: 10, after: undefined }));
      const byOrigin = new Map<AppropriationOrigin, string[]>();
      for (const row of rows) byOrigin.set(row.origin, [...(byOrigin.get(row.origin) ?? []), `${row.amountVnd}/${row.allocatedTotalVnd}/${row.remainingVnd}`]);
      expect(Object.fromEntries(byOrigin)).toEqual({
        CENTRAL_SUPPORT: [`${money(20)}/${money(20)}/0`],
        REVENUE_INCREASE: [`${money(15)}/${money(15)}/0`],
        PM_ASSIGNED: [`${money(10)}/0/${money(10)}`],
      });
      expect(rows.find((row) => row.id === pm.id)?.origin).toBe('PM_ASSIGNED');
      expect((await ledgerOf(support.id)).map((entry) => entry.entry_type)).toEqual(['APPROPRIATE']);
    });

    it('registers an ODA source and a program, and shows the on-lending of the source and the program that was chosen', async () => {
      const year = freshYear();
      const draft = await register({ planYear: year, fundSourceVersionId: versions.oda as string, programMasterVersionId: versions.program as string, origin: 'CENTRAL_SUPPORT' });
      const row = await find(draft.id);
      expect(row?.fundSource).toMatchObject({ category: 'ODA', onLending: true });
      expect(row?.program).toMatchObject({ versionId: versions.program, label: expect.stringContaining('NTM') });
    });

    it('registers a carry-over with its extension document and the day the extension ends, and keeps it apart by the extension fields', async () => {
      const year = freshYear();
      const extension = await document();
      const draft = await register({ planYear: year, origin: 'CARRYOVER', sourceYear: year - 1, extensionDocumentId: extension, extendedTo: `${year}-12-31` });
      expect(await find(draft.id)).toMatchObject({ origin: 'CARRYOVER', sourceYear: year - 1, planYear: year, isExtended: true, extendedTo: `${year}-12-31`, extensionDocumentId: extension });
    });

    it('attaches a draft to an existing capital plan and refuses one that does not exist', async () => {
      const planId = randomUUID();
      await owner(
        `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, created_by, updated_by)
         values ($1, $2, 'CP-ATTACH', 'ANNUAL', 2026, 2026, 2026, $3, 1, 'DRAFT', $4, $4)`,
        [TENANT_A, planId, unitId(1), memberId(MAKER)],
      );
      const year = freshYear();
      const draft = await register({ planYear: year, capitalPlanId: planId });
      expect((await find(draft.id))?.capitalPlanId).toBe(planId);
      expect(await refusal(register({ planYear: year, capitalPlanId: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'capital_plan_id' });
    });
  });

  describe('revising an appropriation', () => {
    it('refuses to revise below the allocated total with 422 APPROPRIATION_BELOW_ALLOCATED and leaves the appropriation unchanged (AC-ST-CAP-001-3)', async () => {
      const year = freshYear();
      const published = await publish({ planYear: year, amountVnd: money(10) });
      await allocate(published.id, money(6));
      const before = await find(published.id);
      const entriesBefore = (await ledgerOf(published.id)).length;

      const refused = await refusal(register({ planYear: year, supersedesId: published.id, amountVnd: money(5) }));
      expect(refused).toEqual({ code: 'APPROPRIATION_BELOW_ALLOCATED', status: 422, detail: 'amount_vnd' });

      expect(await find(published.id)).toEqual(before);
      expect(before).toMatchObject({ status: 'PUBLISHED', amountVnd: money(10), allocatedTotalVnd: money(6) });
      expect(await as((tx) => store.list(tx, { planYear: year }, { limit: 10, after: undefined }))).toHaveLength(1);
      expect(await ledgerOf(published.id)).toHaveLength(entriesBefore);
      // The ceiling is the allocated total, not below it: exactly the allocated amount is accepted.
      expect((await register({ planYear: year, supersedesId: published.id, amountVnd: money(6) })).revision).toBe(2);
    });

    it('judges the ceiling again at the decision, when more has been allocated since the revision was registered', async () => {
      const year = freshYear();
      const published = await publish({ planYear: year, amountVnd: money(10) });
      const revision = await register({ planYear: year, supersedesId: published.id, amountVnd: money(7) });
      await allocate(published.id, money(8));
      expect(await refusal(decide(revision.id, 1))).toEqual({ code: 'APPROPRIATION_BELOW_ALLOCATED', status: 422, detail: 'amount_vnd' });
      expect(await find(revision.id)).toMatchObject({ status: 'DRAFT', version: 1, allocatedTotalVnd: '0' });
      expect(await find(published.id)).toMatchObject({ status: 'PUBLISHED', amountVnd: money(10), allocatedTotalVnd: money(8) });
    });

    it('publishes a revision: the replaced appropriation is superseded, the allocated total and the allocation lines move to the revision, the ledger nets to the new amount', async () => {
      const year = freshYear();
      const published = await publish({ planYear: year, amountVnd: money(10) });
      await allocate(published.id, money(6));
      const lineId = randomUUID();
      await runInTransaction(adminPool, TENANT_A, async (tx) => {
        await tx.query('set local session_replication_role = replica');
        await tx.query(
          `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, created_by)
           values ($1, $2, $3, $4, 'CURRENT_YEAR', $5, $6::numeric, 0, $7, $8)`,
          [TENANT_A, lineId, randomUUID(), versions.nstw, year, money(6), published.id, memberId(MAKER)],
        );
      });
      const revision = await register({ planYear: year, supersedesId: published.id, amountVnd: money(12), issuingAuthority: 'Ủy ban nhân dân tỉnh' });
      expect(revision).toMatchObject({ version: 1, status: 'DRAFT', revision: 2 });
      // Until it is decided the revision draws nothing and the published one stands.
      expect(await find(published.id)).toMatchObject({ status: 'PUBLISHED', amountVnd: money(10) });

      const decided = await decide(revision.id, 1);
      expect(decided).toMatchObject({ status: 'PUBLISHED', supersededId: published.id, movedLines: 1 });
      expect(decided.ledgerEntryIds).toHaveLength(2);
      expect(await find(revision.id)).toMatchObject({ status: 'PUBLISHED', revision: 2, supersedesId: published.id, amountVnd: money(12), allocatedTotalVnd: money(6), remainingVnd: money(6), approvedBy: memberId(APPROVER) });
      expect(await owner<{ status: string }>('select status from machvon.appropriation where id = $1', [published.id])).toEqual([{ status: 'SUPERSEDED' }]);
      expect(await owner<{ appropriation_id: string }>('select appropriation_id from machvon.allocation_line where id = $1', [lineId])).toEqual([{ appropriation_id: revision.id }]);
      expect((await as((tx) => store.list(tx, { planYear: year }, { limit: 10, after: undefined }))).map((row) => row.id)).toEqual([revision.id]);

      const entries = await owner<{ entry_type: string; amount: string; appropriation_id: string; reversal_of_id: string | null }>(
        `select entry_type, amount_vnd::text as amount, appropriation_id, reversal_of_id from machvon.capital_ledger_entry
          where appropriation_id in ($1::uuid, $2::uuid) order by (appropriation_id <> $1::uuid), entry_type`,
        [published.id, revision.id],
      );
      expect(entries.map((entry) => [entry.entry_type, entry.amount, entry.appropriation_id === published.id ? 'old' : 'new'])).toEqual([
        ['APPROPRIATE', money(10), 'old'],
        ['REVERSAL', money(10), 'old'],
        ['APPROPRIATE', money(12), 'new'],
      ]);
      const original = await owner<{ id: string }>("select id from machvon.capital_ledger_entry where appropriation_id = $1 and entry_type = 'APPROPRIATE'", [published.id]);
      expect(entries[1]?.reversal_of_id).toBe(original[0]?.id);
      const net = await owner<{ net: string }>(
        `select sum(case when entry_type = 'APPROPRIATE' then amount_vnd else -amount_vnd end)::text as net from machvon.capital_ledger_entry where appropriation_id in ($1::uuid, $2::uuid)`,
        [published.id, revision.id],
      );
      expect(net[0]?.net).toBe(money(12));
    });

    it('revises to a newer version of the same fund source, and refuses a revision that changes what identifies the appropriation', async () => {
      const year = freshYear();
      const own = await seedVersion('NSTW-OWN', 'FUND_SOURCE', { attributes: { category: 'NSTW', relation: 'ADDITIVE' } });
      const published = await publish({ planYear: year, fundSourceVersionId: own });
      // The entry is renamed from June: its first version ends there and the second one starts.
      const sameRecordNewVersion = randomUUID();
      const record = await owner<{ master_record_id: string }>('select master_record_id from machvon.master_record_version where id = $1', [own]);
      await owner("update machvon.master_record_version set valid_until = '2026-06-01' where id = $1", [own]);
      await owner(
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, 'FUND_SOURCE', 'NSTW-V2', 2, 'Next', '{"category":"NSTW","relation":"ADDITIVE"}'::jsonb, '2026-06-01', 'EFFECTIVE', $3, now(), $4, $4)`,
        [TENANT_A, sameRecordNewVersion, record[0]?.master_record_id, memberId(MAKER)],
      );
      const wrong = (overrides: Partial<AppropriationInput>) => refusal(register({ planYear: year, supersedesId: published.id, ...overrides }));
      const identity = { code: 'VALIDATION_FAILED', status: 422, detail: 'supersedes_id' };
      expect(await wrong({ fundSourceVersionId: versions.nsdp as string })).toEqual(identity);
      expect(await wrong({ origin: 'LOCAL_ADDED' })).toEqual(identity);
      expect(await wrong({ budgetLevel: 'LOCAL' })).toEqual(identity);
      expect(await wrong({ programMasterVersionId: versions.program as string })).toEqual(identity);
      expect(await wrong({ planYear: year - 1, sourceYear: year - 1 })).toEqual(identity);
      const accepted = await register({ planYear: year, supersedesId: published.id, fundSourceVersionId: sameRecordNewVersion, amountVnd: money(11) });
      expect(accepted.revision).toBe(2);
    });

    it('keeps one live revision of an appropriation, takes only a published one, and frees it when the revision is rejected', async () => {
      const year = freshYear();
      const published = await publish({ planYear: year });
      const first = await register({ planYear: year, supersedesId: published.id, amountVnd: money(11) });
      expect(await refusal(register({ planYear: year, supersedesId: published.id, amountVnd: money(12) }))).toEqual({ code: 'REVISION_PENDING_EXISTS', status: 409 });
      // A draft cannot itself be revised.
      expect(await refusal(register({ planYear: year, supersedesId: first.id, amountVnd: money(12) }))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'supersedes_id' });
      expect(await refusal(register({ planYear: year, supersedesId: randomUUID(), amountVnd: money(12) }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await decide(first.id, 1, 'reject');
      expect((await register({ planYear: year, supersedesId: published.id, amountVnd: money(12) })).revision).toBe(2);
    });

    it('refuses to publish a revision whose predecessor is no longer published', async () => {
      const year = freshYear();
      const published = await publish({ planYear: year });
      const revision = await register({ planYear: year, supersedesId: published.id, amountVnd: money(11) });
      await owner("update machvon.appropriation set status = 'SUPERSEDED' where id = $1", [published.id]);
      expect(await refusal(decide(revision.id, 1))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'supersedes_id' });
      expect((await find(revision.id))?.status).toBe('DRAFT');
    });
  });

  describe('what is refused when registering', () => {
    it('registers a decision line once, and frees it again when the draft is rejected', async () => {
      const year = freshYear();
      const doc = await document();
      const first = await register({ planYear: year, decisionDocumentId: doc });
      expect(await refusal(register({ planYear: year, decisionDocumentId: doc }))).toEqual({ code: 'APPROPRIATION_DUPLICATE', status: 409 });
      // The same document assigns another fund source, another program, another origin or another level without conflict.
      await register({ planYear: year, decisionDocumentId: doc, fundSourceVersionId: versions.nsdp as string });
      await register({ planYear: year, decisionDocumentId: doc, programMasterVersionId: versions.program as string });
      await register({ planYear: year, decisionDocumentId: doc, origin: 'LOCAL_ADDED' });
      await register({ planYear: year, decisionDocumentId: doc, budgetLevel: 'LOCAL' });
      await decide(first.id, 1, 'reject');
      await register({ planYear: year, decisionDocumentId: doc });
    });

    it.each([
      ['zero', '0'],
      ['negative', '-5'],
      ['with a fraction', '10.5'],
      ['with zero decimals', '10.00'],
      ['in exponent form', '1e3'],
      ['with a sign', '+5'],
      ['with grouping', '1,000'],
      ['empty', ''],
      ['of more than 24 digits', '1'.repeat(25)],
    ])('refuses an amount %s, naming the field', async (_label, amountVnd) => {
      expect(await refusal(register({ amountVnd }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'amount_vnd' });
    });

    it('takes the largest amount the column holds, exactly', async () => {
      const biggest = '9'.repeat(24);
      const draft = await register({ planYear: freshYear(), amountVnd: biggest });
      expect((await find(draft.id))?.amountVnd).toBe(biggest);
    });

    it.each([
      ['plan_year', { planYear: 1989 }],
      ['plan_year', { planYear: 2101 }],
      ['plan_year', { planYear: 2026.5 }],
      ['source_year', { sourceYear: 1989 }],
      ['issuing_authority', { issuingAuthority: ' ' }],
      ['issuing_authority', { issuingAuthority: 'x' }],
      ['issuing_authority', { issuingAuthority: 'x'.repeat(301) }],
      ['issuing_authority', { issuingAuthority: 'Bộ\u0000Tài chính' }],
    ] as Array<[string, Partial<AppropriationInput>]>)('refuses a malformed %s', async (field, overrides) => {
      expect(await refusal(register(overrides))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    });

    it('holds the source year to the plan year unless the capital is carried over, and the extension fields to a carry-over', async () => {
      const year = freshYear();
      const extension = await document();
      const refused = (overrides: Partial<AppropriationInput>) => refusal(register({ planYear: year, ...overrides }));
      expect(await refused({ sourceYear: year - 1 })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'source_year' });
      expect(await refused({ extendedTo: `${year}-12-31` })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'extended_to' });
      expect(await refused({ extensionDocumentId: extension })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'extension_document_id' });
      const carry = { origin: 'CARRYOVER' as const, sourceYear: year - 1, extensionDocumentId: extension, extendedTo: `${year}-12-31` };
      expect(await refused({ ...carry, sourceYear: year })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'source_year' });
      expect(await refused({ ...carry, sourceYear: year + 1 })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'source_year' });
      expect(await refused({ ...carry, extensionDocumentId: undefined })).toEqual({ code: 'EXTENSION_DOCUMENT_REQUIRED', status: 422, detail: 'extension_document_id' });
      expect(await refused({ ...carry, extensionDocumentId: randomUUID() })).toEqual({ code: 'EXTENSION_DOCUMENT_REQUIRED', status: 422, detail: 'extension_document_id' });
      expect(await refused({ ...carry, extendedTo: undefined })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'extended_to' });
      expect(await refused({ ...carry, extendedTo: `${year - 1}-12-31` })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'extended_to' });
      expect(await refused({ ...carry, extendedTo: `${year}-02-30` })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'extended_to' });
      expect(await refused({ ...carry, extendedTo: 'soon' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'extended_to' });
    });

    it('takes only entries of master data of the right type that are in force, and a fund source that adds to the others', async () => {
      const refused = (overrides: Partial<AppropriationInput>) => refusal(register({ planYear: freshYear(), ...overrides }));
      const fund = (detail: string, code = 'VALIDATION_FAILED') => ({ code, status: 422, detail });
      expect(await refused({ fundSourceVersionId: versions.program as string })).toEqual(fund('fund_source_version_id'));
      expect(await refused({ fundSourceVersionId: randomUUID() })).toEqual(fund('fund_source_version_id'));
      expect(await refused({ fundSourceVersionId: versions.foreign as string })).toEqual(fund('fund_source_version_id'));
      expect(await refused({ fundSourceVersionId: versions.expired as string })).toEqual(fund('fund_source_version_id', 'MASTER_NOT_EFFECTIVE'));
      expect(await refused({ fundSourceVersionId: versions.unpublished as string })).toEqual(fund('fund_source_version_id', 'MASTER_NOT_EFFECTIVE'));
      expect(await refused({ fundSourceVersionId: versions.subset as string })).toEqual(fund('fund_source_version_id', 'SUBSET_SOURCE_NOT_ADDITIVE'));
      expect(await refused({ programMasterVersionId: versions.sector as string })).toEqual(fund('program_master_version_id'));
      expect(await refused({ programMasterVersionId: versions.programExpired as string })).toEqual(fund('program_master_version_id', 'MASTER_NOT_EFFECTIVE'));
    });

    it('takes only a decision document of the tenant that is not recalled, replaced or expired', async () => {
      const refused = (decisionDocumentId: string) => refusal(register({ planYear: freshYear(), decisionDocumentId }));
      const required = { code: 'DECISION_REQUIRED', status: 422, detail: 'decision_document_id' };
      expect(await refused(randomUUID())).toEqual(required);
      expect(await refused(await document({}, TENANT_B))).toEqual(required);
      for (const status of ['RECALLED', 'REPLACED', 'EXPIRED']) expect(await refused(await document({ status }))).toEqual(required);
      for (const status of ['PENDING', 'EFFECTIVE', 'CORRECTED']) await register({ planYear: freshYear(), decisionDocumentId: await document({ status }) });
    });

    it('takes no new capital in a year that is locked, at registration or at the decision', async () => {
      const year = freshYear();
      const locked = freshYear();
      const draft = await register({ planYear: year });
      await owner(
        `insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4), ($1, $5, $6, 'OPEN', null, $4, $4)`,
        [TENANT_A, randomUUID(), locked, memberId(MAKER), randomUUID(), year],
      );
      expect(await refusal(register({ planYear: locked }))).toEqual({ code: 'FISCAL_YEAR_LOCKED', status: 409, detail: 'plan_year' });
      // A year with a control row that is not locked takes capital; it is locked after the draft was registered.
      await register({ planYear: year, decisionDocumentId: await document() });
      await owner("update machvon.fiscal_year_control set status = 'LOCKED', locked_at = now() where plan_year = $1", [year]);
      expect(await refusal(decide(draft.id, 1))).toEqual({ code: 'FISCAL_YEAR_LOCKED', status: 409, detail: 'plan_year' });
      expect((await find(draft.id))?.status).toBe('DRAFT');
    });
  });

  describe('deciding', () => {
    it('never lets the person who registered an appropriation decide on it, to approve or to reject (BR-CAP four-eyes)', async () => {
      const draft = await register({ planYear: freshYear() });
      expect(await refusal(decide(draft.id, 1, 'approve', MAKER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(draft.id, 1, 'reject', MAKER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await find(draft.id)).toMatchObject({ status: 'DRAFT', version: 1, approvedBy: null });
      expect(await sqlState(owner("update machvon.appropriation set status = 'PUBLISHED', approved_by = created_by where id = $1", [draft.id]))).toBe('23514');
    });

    it('answers a stale version with 409 VERSION_CONFLICT, a decided appropriation with 409 STAGE_TRANSITION_DENIED and an unknown one with 404', async () => {
      const draft = await register({ planYear: freshYear() });
      expect(await refusal(decide(draft.id, 7))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const done = await decide(draft.id, 1);
      expect(await refusal(decide(draft.id, done.version))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'status' });
      expect(await refusal(decide(randomUUID(), 1))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const other = await register({ planYear: freshYear() });
      expect(await refusal(decide(other.id, 1, 'approve', APPROVER, TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('rejects a draft for good without a ledger entry, and does not offer a return', async () => {
      const year = freshYear();
      const draft = await register({ planYear: year });
      expect(await refusal(decide(draft.id, 1, 'return'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision' });
      expect(await find(draft.id)).toMatchObject({ status: 'DRAFT', version: 1 });
      expect(await decide(draft.id, 1, 'reject')).toMatchObject({ status: 'REJECTED', version: 2, ledgerEntryIds: [] });
      expect(await ledgerOf(draft.id)).toEqual([]);
      expect(await as((tx) => store.list(tx, { planYear: year }, { limit: 10, after: undefined }))).toEqual([]);
      expect(await refusal(decide(draft.id, 2))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'status' });
    });

    it('judges the master data and the documents again at the decision, and publishes nothing when they no longer stand', async () => {
      const retired = await seedVersion('LATE-SOURCE', 'FUND_SOURCE', { attributes: { category: 'NSTW', relation: 'ADDITIVE' } });
      const late = await register({ planYear: freshYear(), fundSourceVersionId: retired });
      await owner("update machvon.master_record_version set status = 'RETIRED', valid_until = '2025-01-01' where id = $1", [retired]);
      expect(await refusal(decide(late.id, 1))).toEqual({ code: 'MASTER_NOT_EFFECTIVE', status: 422, detail: 'fund_source_version_id' });

      const program = await seedVersion('LATE-PROGRAM', 'PROGRAM');
      const withProgram = await register({ planYear: freshYear(), programMasterVersionId: program });
      await owner("update machvon.master_record_version set status = 'RETIRED', valid_until = '2025-01-01' where id = $1", [program]);
      expect(await refusal(decide(withProgram.id, 1))).toEqual({ code: 'MASTER_NOT_EFFECTIVE', status: 422, detail: 'program_master_version_id' });

      const doc = await document();
      const year = freshYear();
      const draft = await register({ planYear: year, decisionDocumentId: doc });
      await owner("update machvon.document set effect_status = 'RECALLED' where id = $1", [doc]);
      expect(await refusal(decide(draft.id, 1))).toEqual({ code: 'DECISION_REQUIRED', status: 422, detail: 'decision_document_id' });

      const extension = await document();
      const carryYear = freshYear();
      const carry = await register({ planYear: carryYear, origin: 'CARRYOVER', sourceYear: carryYear - 1, extensionDocumentId: extension, extendedTo: `${carryYear}-12-31` });
      await owner("update machvon.document set effect_status = 'EXPIRED' where id = $1", [extension]);
      expect(await refusal(decide(carry.id, 1))).toEqual({ code: 'EXTENSION_DOCUMENT_REQUIRED', status: 422, detail: 'extension_document_id' });
      for (const id of [late.id, withProgram.id, draft.id, carry.id]) expect(await find(id)).toMatchObject({ status: 'DRAFT', version: 1 });
      expect(await ledgerOf(draft.id)).toEqual([]);
    });

    it('lets exactly one of two approvers decide a draft, and posts the ledger entry once', async () => {
      const draft = await register({ planYear: freshYear() });
      const outcomes = await Promise.allSettled([decide(draft.id, 1), decide(draft.id, 1, 'approve', 3)]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const failure = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect((failure.reason as { code: string }).code).toBe('VERSION_CONFLICT');
      expect(await ledgerOf(draft.id)).toHaveLength(1);
      expect(await find(draft.id)).toMatchObject({ status: 'PUBLISHED', version: 2 });
    });
  });

  describe('what the database holds', () => {
    it('refuses to edit the content of an appropriation, to change its decision, to delete it or to move its state backwards', async () => {
      const published = await publish({ planYear: freshYear() });
      const update = (set: string) => as((tx) => tx.query(`update machvon.appropriation set ${set} where id = $1::uuid`, [published.id]));
      expect(await sqlState(update('amount_vnd = amount_vnd + 1'))).toBe('23514');
      expect(await sqlState(update("origin = 'LOCAL_ADDED'"))).toBe('23514');
      expect(await sqlState(update('supersedes_id = id'))).toBe('23514');
      expect(await sqlState(update("status = 'DRAFT'"))).toBe('23514');
      expect(await sqlState(update('approved_by = created_by'))).toBe('23514');
      expect(await sqlState(update("approved_by = '00000000-0000-4000-8000-0000000000ee'"))).toBe('23514');
      expect(await sqlState(as((tx) => tx.query('delete from machvon.appropriation where id = $1::uuid', [published.id])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query("update machvon.capital_ledger_entry set reason = 'x' where appropriation_id = $1::uuid", [published.id])))).toBe('42501');
      const superseded = await publish({ planYear: freshYear() });
      await owner("update machvon.appropriation set status = 'SUPERSEDED' where id = $1", [superseded.id]);
      expect(await sqlState(as((tx) => tx.query("update machvon.appropriation set updated_by = created_by where id = $1::uuid", [superseded.id])))).toBe('23514');
    });

    it('changes the allocated total only through the allocation setting, only on a published appropriation, and never above the amount (TK-CAP-001-5)', async () => {
      const draft = await register({ planYear: freshYear() });
      const published = await publish({ planYear: freshYear() });
      const write = (id: string, total: string, setting: string | null) =>
        as(async (tx) => {
          if (setting !== null) await tx.query("select set_config('app.cap_allocation_write', $1, true)", [setting]);
          await tx.query('update machvon.appropriation set allocated_total_vnd = $2::numeric where id = $1::uuid', [id, total]);
        });
      expect(await sqlState(write(published.id, money(1), null))).toBe('23514');
      expect(await sqlState(write(published.id, money(1), 'off'))).toBe('23514');
      expect(await sqlState(write(published.id, money(1), 'yes'))).toBe('23514');
      expect(await sqlState(write(draft.id, money(1), 'on'))).toBe('23514');
      expect(await sqlState(write(published.id, money(11), 'on'))).toBe('23514');
      await write(published.id, money(3), 'on');
      expect((await find(published.id))?.allocatedTotalVnd).toBe(money(3));
      // The setting does not outlive the transaction that raised it.
      expect(await sqlState(write(published.id, money(4), null))).toBe('23514');
    });

    it('holds the shape of an appropriation even against a writer that skips the store', async () => {
      const base = async () => {
        const id = randomUUID();
        return {
          id,
          sql: `insert into machvon.appropriation (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, decision_document_id, issuing_authority, source_year, revision, supersedes_id, status, approved_by, created_by, updated_by)
                values ($1, $2, $3, $4, $5, 'CENTRAL', $6::numeric, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
          params: (overrides: Record<number, unknown> = {}): unknown[] => {
            const values: unknown[] = [TENANT_A, id, versions.nstw, 2026, 'PM_ASSIGNED', money(1), null, 'Thủ tướng Chính phủ', 2026, 1, null, 'DRAFT', null, memberId(MAKER)];
            for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
            return values;
          },
        };
      };
      const attempt = async (overrides: Record<number, unknown>) => {
        const row = await base();
        const documentId = await document();
        return sqlState(owner(row.sql, row.params({ 6: documentId, ...overrides })));
      };
      expect(await attempt({ 5: '0' })).toBe('23514');
      expect(await attempt({ 7: ' Tên ' })).toBe('23514');
      expect(await attempt({ 3: 1989 })).toBe('23514');
      expect(await attempt({ 8: 2025 })).toBe('23514');
      expect(await attempt({ 9: 2 })).toBe('23514');
      expect(await attempt({ 10: randomUUID(), 9: 1 })).toBe('23514');
      expect(await attempt({ 11: 'PUBLISHED' })).toBe('23514');
      expect(await attempt({ 6: randomUUID() })).toBe('23503');
    });
  });

  describe('reading the register', () => {
    it('pages the register newest first with a keyset cursor, and shows a tenant only its own appropriations', async () => {
      const year = freshYear();
      const ids = [];
      for (let n = 0; n < 5; n += 1) ids.push((await register({ planYear: year })).id);
      const first = await as((tx) => store.list(tx, { planYear: year }, { limit: 2, after: undefined }));
      expect(first.map((row) => row.id)).toEqual(ids.slice().reverse().slice(0, 2));
      const last = first[1];
      const second = await as((tx) => store.list(tx, { planYear: year }, { limit: 10, after: { code: last?.createdAtKey ?? '', id: last?.id ?? '' } }));
      expect(second.map((row) => row.id)).toEqual(ids.slice().reverse().slice(2));
      expect(await as((tx) => store.list(tx, { planYear: year }, { limit: 10, after: undefined }), TENANT_B)).toEqual([]);
      expect(await find(ids[0] as string, TENANT_B)).toBeUndefined();
    });
  });
});
