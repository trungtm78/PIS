import { randomUUID } from 'node:crypto';
import { DgvDatasetStore } from '../src/dgv-dataset-store';
import type { DatasetInput, DatasetViewer } from '../src/dgv-dataset-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const datasets = new DgvDatasetStore();
const REGISTRAR = 1;
const OWNER = 2;
const READER = 3;
const SERVICE_ACCOUNT = 4;
const SUSPENDED = 5;
const OTHER_TENANT_MEMBER = 6; // of tenant B only

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = REGISTRAR, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const viewer = (member: number, ...roleCodes: string[]): DatasetViewer => ({ membershipId: memberId(member), roleCodes });

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

let counter = 0;
const input = (extra: Partial<DatasetInput> = {}): DatasetInput => {
  counter += 1;
  return {
    datasetCode: `DS-${counter}-${randomUUID().slice(0, 6)}`.toUpperCase(),
    title: `Dataset ${counter}`,
    domain: 'TREASURY',
    grain: 'one row per payment order',
    producerModule: 'PAY',
    ownerId: memberId(OWNER),
    stewardId: memberId(REGISTRAR),
    classification: 'INTERNAL',
    isCritical: false,
    freshnessSloSeconds: 86_400,
    ...extra,
  };
};
const register = (data: DatasetInput, member = REGISTRAR, tenant = TENANT_A) => as((tx) => datasets.register(tx, data, memberId(member)), member, tenant);
const search = (who: DatasetViewer, filter: Parameters<DgvDatasetStore['search']>[2] = {}, limit = 100, after?: { code: string; id: string }, tenant = TENANT_A, member = REGISTRAR) =>
  as((tx) => datasets.search(tx, who, filter, { limit, after }), member, tenant);

/** A completed quality run of the dataset, with the contract it runs under. */
async function seedRun(datasetId: string, code: string, overall: 'PASSED' | 'WARNING' | 'FAILED', finishedAt: string): Promise<void> {
  const contractId = randomUUID();
  await owner(
    `insert into machvon.dataset_contract (tenant_id, id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id)
     values ($1, $2, $3, $6, $4, '{}'::jsonb, '{}'::jsonb, 86400, 'INTERNAL', 'PUBLISHED', $5)`,
    [TENANT_A, contractId, code, memberId(OWNER), datasetId, ++counter],
  );
  await owner(
    `insert into machvon.quality_run (tenant_id, id, dataset_contract_id, snapshot_id, rule_version_ids, passed_count, failed_count, quarantined_count, finished_at, dataset_id, status, overall_result)
     values ($1, $2, $3, $4, '[]'::jsonb, 1, 0, 0, $5::timestamptz, $6, 'COMPLETED', $7)`,
    [TENANT_A, randomUUID(), contractId, randomUUID(), finishedAt, datasetId, overall],
  );
}

describe('DgvDatasetStore (dataset catalogue with owner and steward, ST-DGV-001)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
    for (const member of [REGISTRAR, OWNER, READER, SERVICE_ACCOUNT]) await harness.seedMembership(TENANT_A, member, 1);
    await harness.seedMembership(TENANT_A, SUSPENDED, 1, { status: 'Suspended' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_MEMBER, 1);
    await owner("update machvon.membership set membership_type = 'SERVICE_ACCOUNT' where id = $1", [memberId(SERVICE_ACCOUNT)]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('registration', () => {
    it('refuses a critical dataset whose owner is its steward, registers a valid pair as DRAFT, and refuses a duplicate code (AC-ST-DGV-001-1)', async () => {
      const same = input({ datasetCode: 'DS-TREASURY', isCritical: true, ownerId: memberId(REGISTRAR), stewardId: memberId(REGISTRAR) });
      expect(await refusal(register(same))).toEqual({ code: 'OWNER_STEWARD_SAME', status: 422, detail: 'steward_user_id' });
      expect(await owner('select id from machvon.dataset where dataset_code = $1', ['DS-TREASURY'])).toEqual([]);

      const created = await register({ ...same, stewardId: memberId(OWNER), ownerId: memberId(REGISTRAR) });
      expect(created.version).toBe(1);
      const row = await as((tx) => datasets.find(tx, created.id, viewer(REGISTRAR)));
      expect(row).toMatchObject({
        id: created.id,
        datasetCode: 'DS-TREASURY',
        status: 'DRAFT',
        isCritical: true,
        classification: 'INTERNAL',
        ownerId: memberId(REGISTRAR),
        stewardId: memberId(OWNER),
        contractRevision: null,
        qualityBadge: 'NOT_ASSESSED',
        freshnessSloSeconds: 86_400,
        version: 1,
      });

      expect(await refusal(register({ ...same, stewardId: memberId(OWNER), ownerId: memberId(REGISTRAR) }))).toEqual({ code: 'DATASET_CODE_DUPLICATE', status: 409, detail: 'dataset_code' });
      // The code is one code whatever the case it is written in.
      expect(await refusal(register({ ...same, datasetCode: 'ds-treasury', stewardId: memberId(OWNER), ownerId: memberId(REGISTRAR) }))).toMatchObject({ code: 'DATASET_CODE_DUPLICATE' });
      expect(Number((await owner<{ n: string }>('select count(*)::text as n from machvon.dataset where lower(dataset_code) = $1', ['ds-treasury']))[0]?.n)).toBe(1);
    });

    it('lets a dataset that is not critical have one person as owner and steward', async () => {
      const created = await register(input({ ownerId: memberId(OWNER), stewardId: memberId(OWNER) }));
      expect(await as((tx) => datasets.find(tx, created.id, viewer(REGISTRAR)))).toMatchObject({ ownerId: memberId(OWNER), stewardId: memberId(OWNER), isCritical: false });
    });

    it('keeps the database CHECK as the last word on a critical pair', async () => {
      const created = await register(input({ isCritical: true }));
      await expect(owner('update machvon.dataset set steward_user_id = owner_user_id where id = $1', [created.id])).rejects.toMatchObject({ constraint: 'dataset_owner_chk' });
    });

    it.each([
      ['a blank code', { datasetCode: '   ' }, 'dataset_code'],
      ['a code with a control character', { datasetCode: 'DS-\u0007' }, 'dataset_code'],
      ['a title over 300 characters', { title: 'x'.repeat(301) }, 'title'],
      ['a blank domain', { domain: '' }, 'domain'],
      ['a blank grain', { grain: ' ' }, 'grain'],
      ['a producer module that is not a module code', { producerModule: 'pay' }, 'producer_module'],
      ['a freshness SLO of zero', { freshnessSloSeconds: 0 }, 'freshness_slo_seconds'],
      ['a freshness SLO that is not a whole number', { freshnessSloSeconds: 1.5 }, 'freshness_slo_seconds'],
      ['an owner who is not a member', { ownerId: randomUUID() }, 'owner_user_id'],
      ['a steward who is a service account', { stewardId: memberId(SERVICE_ACCOUNT) }, 'steward_user_id'],
      ['an owner whose membership is suspended', { ownerId: memberId(SUSPENDED) }, 'owner_user_id'],
      ['an owner of another tenant', { ownerId: memberId(OTHER_TENANT_MEMBER) }, 'owner_user_id'],
      ['a retention policy that does not exist', { retentionPolicyId: randomUUID() }, 'retention_policy_id'],
    ])('refuses %s with 422 VALIDATION_FAILED naming the field', async (_name, extra, field) => {
      expect(await refusal(register(input(extra as Partial<DatasetInput>)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    });

    it('registers with a retention policy of the tenant', async () => {
      const policyId = randomUUID();
      await owner(
        `insert into machvon.data_retention_policy (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by)
         values ($1, $2, 'DATASET_TEST', 1, 10, 'FROM_CREATED', 'test', 'REVIEW_FOR_DESTRUCTION', '2026-01-01', 'Published', $3)`,
        [TENANT_A, policyId, memberId(REGISTRAR)],
      );
      const created = await register(input({ retentionPolicyId: policyId }));
      expect((await owner<{ retention_policy_id: string }>('select retention_policy_id from machvon.dataset where id = $1', [created.id]))[0]?.retention_policy_id).toBe(policyId);
    });

    it('does not let the application delete a dataset', async () => {
      const created = await register(input());
      await expect(as((tx) => tx.query('delete from machvon.dataset where id = $1::uuid', [created.id]))).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('visibility by classification and role', () => {
    const personal = { classification: 'PERSONAL' as const, producerModule: 'LND' };

    it('shows a PERSONAL dataset allowed only to the LND role to nobody else, and does not count it (AC-ST-DGV-001-2)', async () => {
      const created = await register(input({ ...personal, datasetCode: 'DS-LND-HOUSEHOLD', ownerId: memberId(OWNER), stewardId: memberId(OWNER) }), REGISTRAR);
      await owner("update machvon.dataset set allowed_role_codes = array['LND'] where id = $1", [created.id]);

      const other = viewer(READER);
      expect(await search(other, { query: 'household' })).toEqual([]);
      expect(await as((tx) => datasets.count(tx, other, { query: 'household' }), READER)).toBe(0);
      expect(await as((tx) => datasets.find(tx, created.id, other), READER)).toBeUndefined();

      const lnd = viewer(READER, 'LND');
      expect((await search(lnd, { query: 'household' })).map((row) => row.datasetCode)).toEqual(['DS-LND-HOUSEHOLD']);
      expect(await as((tx) => datasets.count(tx, lnd, { query: 'household' }), READER)).toBe(1);
    });

    it('keeps the totals of a reader free of the datasets the reader may not see', async () => {
      const before = await as((tx) => datasets.count(tx, viewer(READER), {}), READER);
      const hidden = await register(input({ classification: 'CONFIDENTIAL' }));
      const open = await register(input({ classification: 'PUBLIC' }));
      expect(await as((tx) => datasets.count(tx, viewer(READER), {}), READER)).toBe(before + 1);
      const ids = (await search(viewer(READER))).map((row) => row.id);
      expect(ids).toContain(open.id);
      expect(ids).not.toContain(hidden.id);
    });

    it('shows PUBLIC and INTERNAL to every reader and every other class to the owner, the steward and the registrant only', async () => {
      const cases = await Promise.all((['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'] as const).map((classification) => register(input({ classification, ownerId: memberId(OWNER), stewardId: memberId(OWNER) }))));
      const seenBy = async (member: number): Promise<string[]> => {
        const visible = new Set((await search(viewer(member))).map((row) => row.id));
        return cases.map((created, index) => (visible.has(created.id) ? ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'][index] ?? '' : '')).filter((name) => name !== '');
      };
      expect(await seenBy(READER)).toEqual(['PUBLIC', 'INTERNAL']);
      // The registrant (member 1) wrote all five and sees all five; the owner and steward (member 2) too.
      expect(await seenBy(REGISTRAR)).toHaveLength(5);
      expect(await seenBy(OWNER)).toHaveLength(5);
    });

    it('lets a list of allowed roles narrow a PUBLIC dataset and lets the owner and the registrant keep seeing it', async () => {
      const created = await register(input({ classification: 'PUBLIC', ownerId: memberId(OWNER), stewardId: memberId(OWNER) }));
      await owner("update machvon.dataset set allowed_role_codes = array['DATA_STEWARD'] where id = $1", [created.id]);
      expect((await search(viewer(READER, 'MEMBER'))).map((row) => row.id)).not.toContain(created.id);
      expect((await search(viewer(READER, 'DATA_STEWARD'))).map((row) => row.id)).toContain(created.id);
      expect((await search(viewer(OWNER))).map((row) => row.id)).toContain(created.id);
      expect((await search(viewer(REGISTRAR))).map((row) => row.id)).toContain(created.id);
    });
  });

  describe('isolation between tenants', () => {
    it('gives each tenant its own dataset under the same code and treats the dataset of another tenant as unknown (AC-ST-DGV-001-3)', async () => {
      const a = await register(input({ datasetCode: 'DS-SHARED', classification: 'PUBLIC' }));
      const b = await register(input({ datasetCode: 'DS-SHARED', classification: 'PUBLIC', ownerId: memberId(OTHER_TENANT_MEMBER), stewardId: memberId(OTHER_TENANT_MEMBER) }), OTHER_TENANT_MEMBER, TENANT_B);
      expect(b.id).not.toBe(a.id);

      const seenByB = await search(viewer(OTHER_TENANT_MEMBER), { query: 'DS-SHARED' }, 100, undefined, TENANT_B, OTHER_TENANT_MEMBER);
      expect(seenByB.map((row) => row.id)).toEqual([b.id]);
      expect(await as((tx) => datasets.find(tx, a.id, viewer(OTHER_TENANT_MEMBER)), OTHER_TENANT_MEMBER, TENANT_B)).toBeUndefined();
      expect(await as((tx) => datasets.count(tx, viewer(OTHER_TENANT_MEMBER), { query: 'DS-SHARED' }), OTHER_TENANT_MEMBER, TENANT_B)).toBe(1);
      const attempt = as((tx) => datasets.assignOwnership(tx, a.id, 1, { ownerId: memberId(OTHER_TENANT_MEMBER), stewardId: memberId(OTHER_TENANT_MEMBER) }, viewer(OTHER_TENANT_MEMBER)), OTHER_TENANT_MEMBER, TENANT_B);
      expect(await refusal(attempt)).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await owner<{ owner_user_id: string }>('select owner_user_id from machvon.dataset where id = $1', [a.id]))[0]?.owner_user_id).toBe(memberId(OWNER));
    });
  });

  describe('search', () => {
    it('finds by text without treating % and _ as wildcards, by domain and by classification, and pages by code', async () => {
      const prefix = `SRCH${randomUUID().slice(0, 4).toUpperCase()}`;
      const codes = [`${prefix}-A`, `${prefix}-B`, `${prefix}-C`];
      for (const [index, code] of codes.entries()) await register(input({ datasetCode: code, title: index === 1 ? '100% of orders_total' : `Plain ${index}`, domain: index === 2 ? 'LAND' : 'TREASURY', classification: index === 0 ? 'PUBLIC' : 'INTERNAL' }));

      expect((await search(viewer(REGISTRAR), { query: prefix })).map((row) => row.datasetCode)).toEqual(codes);
      expect((await search(viewer(REGISTRAR), { query: '100% of' })).map((row) => row.datasetCode)).toEqual([codes[1]]);
      expect(await search(viewer(REGISTRAR), { query: '%' })).toHaveLength(1);
      expect((await search(viewer(REGISTRAR), { query: `${prefix.toLowerCase()}-b` })).map((row) => row.datasetCode)).toEqual([codes[1]]);
      expect((await search(viewer(REGISTRAR), { query: prefix, domain: 'LAND' })).map((row) => row.datasetCode)).toEqual([codes[2]]);
      expect((await search(viewer(REGISTRAR), { query: prefix, classification: 'PUBLIC' })).map((row) => row.datasetCode)).toEqual([codes[0]]);
      expect(await as((tx) => datasets.count(tx, viewer(REGISTRAR), { query: prefix }))).toBe(3);

      const first = await search(viewer(REGISTRAR), { query: prefix }, 2);
      expect(first.map((row) => row.datasetCode)).toEqual([codes[0], codes[1]]);
      const last = first[1];
      const second = await search(viewer(REGISTRAR), { query: prefix }, 2, { code: last?.datasetCode ?? '', id: last?.id ?? '' });
      expect(second.map((row) => row.datasetCode)).toEqual([codes[2]]);
    });

    it('shows the readable names of the owner and the steward', async () => {
      const created = await register(input({ datasetCode: 'DS-NAMES', classification: 'PUBLIC' }));
      expect(await as((tx) => datasets.find(tx, created.id, viewer(READER)), READER)).toMatchObject({ ownerName: 'User 2', stewardName: 'User 1' });
    });

    it('shows the quality badge of the last completed run: PASSED, FAILED, and STALE when the run is older than the freshness SLO', async () => {
      const fresh = await register(input({ datasetCode: 'DS-BADGE-FRESH', classification: 'PUBLIC' }));
      const failing = await register(input({ datasetCode: 'DS-BADGE-FAILED', classification: 'PUBLIC' }));
      const stale = await register(input({ datasetCode: 'DS-BADGE-STALE', classification: 'PUBLIC', freshnessSloSeconds: 3_600 }));
      await seedRun(fresh.id, 'DS-BADGE-FRESH', 'PASSED', new Date(Date.now() - 60_000).toISOString());
      await seedRun(failing.id, 'DS-BADGE-FAILED', 'WARNING', new Date(Date.now() - 3_600_000).toISOString());
      await seedRun(failing.id, 'DS-BADGE-FAILED', 'FAILED', new Date(Date.now() - 1_000).toISOString());
      await seedRun(stale.id, 'DS-BADGE-STALE', 'PASSED', new Date(Date.now() - 2 * 3_600_000).toISOString());
      const badges = Object.fromEntries((await search(viewer(REGISTRAR), { query: 'DS-BADGE' })).map((row) => [row.datasetCode, row.qualityBadge]));
      expect(badges).toEqual({ 'DS-BADGE-FAILED': 'FAILED', 'DS-BADGE-FRESH': 'PASSED', 'DS-BADGE-STALE': 'STALE' });
    });

    it('shows the revision of the contract in force', async () => {
      const created = await register(input({ datasetCode: 'DS-CONTRACTED', classification: 'PUBLIC' }));
      const contractId = randomUUID();
      const policyId = randomUUID();
      await owner(
        `insert into machvon.data_retention_policy (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by)
         values ($1, $2, 'DATASET_CONTRACT_TEST', 1, 10, 'FROM_CREATED', 'test', 'REVIEW_FOR_DESTRUCTION', '2026-01-01', 'Published', $3)`,
        [TENANT_A, policyId, memberId(REGISTRAR)],
      );
      await owner(
        `insert into machvon.data_contract_version (tenant_id, id, dataset_id, revision, grain, schema_json, owner_id, quality_rules, retention_policy_id, status)
         values ($1, $2, $3, 3, 'one row per order', '{}'::jsonb, $4, '[]'::jsonb, $5, 'PUBLISHED')`,
        [TENANT_A, contractId, created.id, memberId(OWNER), policyId],
      );
      await owner('update machvon.dataset set current_contract_version_id = $2 where id = $1', [created.id, contractId]);
      expect(await as((tx) => datasets.find(tx, created.id, viewer(READER)), READER)).toMatchObject({ contractRevision: 3 });
    });
  });

  describe('changing the owner and the steward', () => {
    it('gives the dataset a new pair, raises its version and keeps the pair of a critical dataset distinct', async () => {
      const created = await register(input({ isCritical: true }));
      const done = await as((tx) => datasets.assignOwnership(tx, created.id, 1, { ownerId: memberId(READER), stewardId: memberId(OWNER) }, viewer(REGISTRAR)));
      expect(done).toMatchObject({ version: 2, isCritical: true, status: 'DRAFT', before: { ownerId: memberId(OWNER), stewardId: memberId(REGISTRAR) }, after: { ownerId: memberId(READER), stewardId: memberId(OWNER) } });
      const row = await owner<{ owner_user_id: string; steward_user_id: string; version: string; updated_by: string }>('select owner_user_id, steward_user_id, version::text as version, updated_by from machvon.dataset where id = $1', [created.id]);
      expect(row[0]).toEqual({ owner_user_id: memberId(READER), steward_user_id: memberId(OWNER), version: '2', updated_by: memberId(REGISTRAR) });
      expect(await refusal(as((tx) => datasets.assignOwnership(tx, created.id, 2, { ownerId: memberId(OWNER), stewardId: memberId(OWNER) }, viewer(REGISTRAR))))).toEqual({
        code: 'OWNER_STEWARD_SAME',
        status: 422,
        detail: 'steward_user_id',
      });
    });

    it('refuses a stale version with 409 VERSION_CONFLICT and changes nothing', async () => {
      const created = await register(input());
      const stale = as((tx) => datasets.assignOwnership(tx, created.id, 7, { ownerId: memberId(READER), stewardId: memberId(OWNER) }, viewer(REGISTRAR)));
      expect(await refusal(stale)).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect((await owner<{ version: string }>('select version::text as version from machvon.dataset where id = $1', [created.id]))[0]?.version).toBe('1');
    });

    it('serialises two changes of one dataset: the second one sees the new version', async () => {
      const created = await register(input());
      const results = await Promise.allSettled([
        as((tx) => datasets.assignOwnership(tx, created.id, 1, { ownerId: memberId(READER), stewardId: memberId(OWNER) }, viewer(REGISTRAR))),
        as((tx) => datasets.assignOwnership(tx, created.id, 1, { ownerId: memberId(OWNER), stewardId: memberId(READER) }, viewer(REGISTRAR))),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
    });

    it('refuses a pair that does not change, a person who is not active staff, a retired dataset and a dataset the person may not see', async () => {
      const created = await register(input());
      expect(await refusal(as((tx) => datasets.assignOwnership(tx, created.id, 1, { ownerId: memberId(OWNER), stewardId: memberId(REGISTRAR) }, viewer(REGISTRAR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_user_id' });
      expect(await refusal(as((tx) => datasets.assignOwnership(tx, created.id, 1, { ownerId: memberId(SUSPENDED), stewardId: memberId(REGISTRAR) }, viewer(REGISTRAR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_user_id' });

      await owner("update machvon.dataset set status = 'RETIRED' where id = $1", [created.id]);
      expect(await refusal(as((tx) => datasets.assignOwnership(tx, created.id, 1, { ownerId: memberId(READER), stewardId: memberId(REGISTRAR) }, viewer(REGISTRAR))))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'status' });

      const hidden = await register(input({ classification: 'PERSONAL' }));
      expect(await refusal(as((tx) => datasets.assignOwnership(tx, hidden.id, 1, { ownerId: memberId(READER), stewardId: memberId(REGISTRAR) }, viewer(READER)), READER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });
});
