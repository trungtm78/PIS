import { vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline, packDigest, sealPack } from '../src/master-baseline';
import type { BaselineEntry } from '../src/master-baseline';
import { MasterRules } from '../src/master-rules';
import { MasterStore } from '../src/master-store';
import type { MasterContent } from '../src/master-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new MasterStore();
const rules = new MasterRules();
const STEWARD = 1;
const CHECKER = 2;
const PUBLISHER = 3;
const WORKER = '00000000-0000-4000-8000-000000000000';
const TODAY = vietnamDateOf(new Date());
const DECISION_DOCUMENT = id(0x70, 1);

const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const asWorker = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, work);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const content = (overrides: Partial<MasterContent> = {}): MasterContent => ({
  label: 'Entry',
  attributes: {},
  parentRecordId: null,
  validFrom: '2024-01-01',
  validUntil: null,
  legalBasis: null,
  ...overrides,
});

describe('the catalogue types, the platform baseline and the rule port (ST-MDM-003)', () => {
  const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function inForce(masterType: string, key: string, overrides: Partial<MasterContent>, tenant = TENANT_A): Promise<{ recordId: string }> {
    const created = await as(STEWARD, (tx) => store.propose(tx, { masterType, businessKey: key, content: content(overrides), reason: 'Initial catalogue entry' }, memberId(STEWARD)), tenant);
    const submitted = await as(STEWARD, (tx) => store.submit(tx, created.changeRequestId, 1, memberId(STEWARD)), tenant);
    await as(CHECKER, (tx) => store.decide(tx, created.changeRequestId, submitted.version, 'approve', memberId(CHECKER)), tenant);
    const record = await as(PUBLISHER, (tx) => store.findRecord(tx, created.recordId), tenant);
    await as(PUBLISHER, (tx) => store.publish(tx, created.recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)), tenant);
    return { recordId: created.recordId };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      for (const n of [STEWARD, CHECKER, PUBLISHER]) await harness.seedMembership(tenant, n, 1);
      await harness.owner(tenant, [
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
           values ($1, $2, 'INCOMING', 'CV', 'Decision', 'INTERNAL', $3, $3)`,
          [tenant, DECISION_DOCUMENT, memberId(STEWARD)],
        ],
      ]);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('typed catalogue entries', () => {
    beforeAll(async () => {
      // These types belong to the platform or are extended from its entries by baseline; for these tests the tenant writes them itself.
      for (const type of ['FUND_SOURCE', 'DECISION_TYPE', 'PROJECT_STAGE']) {
        await owner("insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, $2, 'TENANT_ONLY', $3)", [TENANT_A, type, memberId(STEWARD)]);
      }
    });

    it('refuses an entry that lacks what its type requires and leaves nothing behind', async () => {
      const missing = await refusal(as(STEWARD, (tx) => store.propose(tx, { masterType: 'DECISION_TYPE', businessKey: 'NO-FIELDS', content: content(), reason: 'Initial entry' }, memberId(STEWARD))));
      expect(missing).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'attributes.required_fields' });
      expect(await owner("select count(*)::int as n from machvon.master_record where business_key = 'NO-FIELDS'")).toEqual([{ n: 0 }]);
    });

    it('keeps a national target programme inside its budget source: ADDITIVE is refused and the tree is unchanged (AC-ST-MDM-003-1)', async () => {
      const nstw = await inForce('FUND_SOURCE', 'NSTW', { label: 'Ngân sách trung ương', attributes: { category: 'NSTW', relation: 'ADDITIVE' } });
      const dtpt = await inForce('FUND_SOURCE', 'NSTW-DTPT', { label: 'NSTW đầu tư phát triển', attributes: { category: 'NSTW', relation: 'ADDITIVE' }, parentRecordId: nstw.recordId });
      const ntm = await inForce('FUND_SOURCE', 'CTMTQG-NTM', { label: 'CTMTQG nông thôn mới', attributes: { category: 'CTMTQG', relation: 'SUBSET_OF' }, parentRecordId: dtpt.recordId });
      const refused = await refusal(
        as(STEWARD, (tx) =>
          store.createChange(
            tx,
            { kind: 'UPDATE', masterType: 'FUND_SOURCE', masterRecordId: ntm.recordId, proposed: { attributes: { category: 'CTMTQG', relation: 'ADDITIVE' } }, effectiveFrom: '2025-06-01', reason: 'Counted beside the budget source' },
            memberId(STEWARD),
          ),
        ),
      );
      expect(refused).toEqual({ code: 'SUBSET_SOURCE_NOT_ADDITIVE', status: 422, detail: 'attributes.relation' });
      const versions = await owner<{ revision: number; attributes: Record<string, unknown> }>('select revision, attributes from machvon.master_record_version where master_record_id = $1 order by revision', [ntm.recordId]);
      expect(versions).toEqual([{ revision: 1, attributes: { category: 'CTMTQG', relation: 'SUBSET_OF' } }]);
      expect(await owner('select count(*)::int as n from machvon.master_change_request where master_record_id = $1', [ntm.recordId])).toEqual([{ n: 1 }]);
      // The same programme proposed as additive in the first place never gets a record.
      const created = await refusal(
        as(STEWARD, (tx) => store.propose(tx, { masterType: 'FUND_SOURCE', businessKey: 'CTMTQG-X', content: content({ attributes: { category: 'CTMTQG', relation: 'ADDITIVE' }, parentRecordId: dtpt.recordId }), reason: 'Initial entry' }, memberId(STEWARD))),
      );
      expect(created.code).toBe('SUBSET_SOURCE_NOT_ADDITIVE');
      expect(await owner("select count(*)::int as n from machvon.master_record where business_key = 'CTMTQG-X'")).toEqual([{ n: 0 }]);
    });

    it('checks the parent that the entry names against the relation it declares', async () => {
      const nstw = await inForce('FUND_SOURCE', 'NSTW-2', { attributes: { category: 'NSTW', relation: 'ADDITIVE' } });
      const refused = await refusal(
        as(STEWARD, (tx) => store.propose(tx, { masterType: 'FUND_SOURCE', businessKey: 'CTMTQG-2', content: content({ attributes: { category: 'CTMTQG', relation: 'SUBSET_OF' } }), reason: 'Initial entry' }, memberId(STEWARD))),
      );
      expect(refused).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'parent_record_id' });
      await expect(
        as(STEWARD, (tx) => store.propose(tx, { masterType: 'FUND_SOURCE', businessKey: 'CTMTQG-2', content: content({ attributes: { category: 'CTMTQG', relation: 'SUBSET_OF' }, parentRecordId: nstw.recordId }), reason: 'Initial entry' }, memberId(STEWARD))),
      ).resolves.toMatchObject({ version: 1 });
    });

    it('resolves the entries a stage points at in the tenant, and refuses one that is not there', async () => {
      await inForce('PROJECT_STAGE', 'S1', { attributes: { sequence: 1 } });
      const refused = await refusal(
        as(STEWARD, (tx) => store.propose(tx, { masterType: 'PROJECT_STAGE', businessKey: 'S0', content: content({ attributes: { sequence: 0, allowed_next: ['S1'] } }), reason: 'Initial entry' }, memberId(STEWARD))),
      );
      expect(refused.detail).toBe('attributes.sequence');
      await expect(
        as(STEWARD, (tx) => store.propose(tx, { masterType: 'PROJECT_STAGE', businessKey: 'S0', content: content({ attributes: { sequence: 2, allowed_next: ['S1'] } }), reason: 'Initial entry' }, memberId(STEWARD))),
      ).resolves.toMatchObject({ version: 1 });
      const unknown = await refusal(
        as(STEWARD, (tx) => store.propose(tx, { masterType: 'PROJECT_STAGE', businessKey: 'S9', content: content({ attributes: { sequence: 3, allowed_next: ['NOWHERE'] } }), reason: 'Initial entry' }, memberId(STEWARD))),
      );
      expect(unknown.detail).toBe('attributes.allowed_next');
    });
  });

  describe('rule data (BR-MDM-09)', () => {
    const legalBasis = 'Law 58/2024/QH15 (amended 90/2025)';
    const bands = [
      { sector_key: null, group_key: 'C', min_amount: '0', max_amount: '100000000000' },
      { sector_key: null, group_key: 'B', min_amount: '100000000000', max_amount: null },
    ];
    const rule = (overrides: Partial<MasterContent> = {}): MasterContent =>
      content({ label: 'Local thresholds', attributes: { owner_module: 'PRJ', bands }, legalBasis, ...overrides });

    beforeAll(async () => {
      await owner("insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, 'PROJECT_GROUP', 'TENANT_ONLY', $2), ($1, 'PROJECT_GROUP_THRESHOLDS', 'TENANT_ONLY', $2)", [TENANT_A, memberId(STEWARD)]);
      await inForce('PROJECT_GROUP', 'C', { attributes: { rank: 4 } });
      await inForce('PROJECT_GROUP', 'B', { attributes: { rank: 3 } });
    });

    it('refuses a rule without its legal basis or with a table that has a gap', async () => {
      const propose = (value: MasterContent) => as(STEWARD, (tx) => store.propose(tx, { masterType: 'PROJECT_GROUP_THRESHOLDS', businessKey: 'LOCAL', content: value, reason: 'Initial rule' }, memberId(STEWARD)));
      expect(await refusal(propose(rule({ legalBasis: null })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'legal_basis' });
      const gap = [{ ...bands[0], max_amount: '90000000000' }, bands[1]];
      expect(await refusal(propose(rule({ attributes: { owner_module: 'PRJ', bands: gap } })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'attributes.bands' });
    });

    it('is decided and published only by the owner of the module that applies it, and not at all when it has none', async () => {
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'PROJECT_GROUP_THRESHOLDS', businessKey: 'OWNED', content: rule(), reason: 'Initial rule' }, memberId(STEWARD)));
      const submitted = await as(STEWARD, (tx) => store.submit(tx, created.changeRequestId, 1, memberId(STEWARD)));
      const decide = () => as(CHECKER, (tx) => store.decide(tx, created.changeRequestId, submitted.version, 'approve', memberId(CHECKER)));
      expect(await refusal(decide())).toEqual({ code: 'SCOPE_DENIED', status: 403, detail: 'master_type' });
      await owner("insert into machvon.master_type_approver (tenant_id, master_type, membership_id, granted_by) values ($1, 'PROJECT_GROUP_THRESHOLDS', $2, $3)", [TENANT_A, memberId(CHECKER), memberId(STEWARD)]);
      await decide();
      const record = await as(PUBLISHER, (tx) => store.findRecord(tx, created.recordId));
      const publish = () => as(PUBLISHER, (tx) => store.publish(tx, created.recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)));
      expect(await refusal(publish())).toEqual({ code: 'SCOPE_DENIED', status: 403, detail: 'master_type' });
      await owner("insert into machvon.master_type_approver (tenant_id, master_type, membership_id, granted_by) values ($1, 'PROJECT_GROUP_THRESHOLDS', $2, $3)", [TENANT_A, memberId(PUBLISHER), memberId(STEWARD)]);
      await expect(publish()).resolves.toMatchObject({ active: true });
    });

    it('does not let the tenant plane name its own approver', async () => {
      await expect(
        as(STEWARD, (tx) => tx.query("insert into machvon.master_type_approver (tenant_id, master_type, membership_id, granted_by) values (current_setting('app.tenant_id')::uuid, 'X', $1::uuid, $1::uuid)", [memberId(STEWARD)])),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('the platform baseline', () => {
    it('writes the whole baseline once, in force and in the namespace of the platform, and a second run changes nothing', async () => {
      const first = await asWorker((tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
      expect(first).toEqual({ created: BASELINE_PACK.entries.length, superseded: 0, unchanged: 0 });
      const rows = await owner<{ n: number; effective: number }>("select count(*)::int as n, count(*) filter (where status = 'EFFECTIVE')::int as effective from machvon.master_record where namespace = 'PLATFORM'");
      expect(rows).toEqual([{ n: BASELINE_PACK.entries.length, effective: BASELINE_PACK.entries.length }]);
      const versions = await owner<{ n: number }>("select count(*)::int as n from machvon.master_record_version where namespace = 'PLATFORM' and source_system = 'PLATFORM_BASELINE' and published_at is not null and content_sha256 is not null");
      expect(versions).toEqual([{ n: BASELINE_PACK.entries.length }]);
      expect(await asWorker((tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY))).toEqual({ created: 0, superseded: 0, unchanged: BASELINE_PACK.entries.length });
      // Other tenants get their own copy; nothing leaks between them.
      expect(await owner("select count(*)::int as n from machvon.master_record where namespace = 'PLATFORM'", [], TENANT_B)).toEqual([{ n: 0 }]);
      expect(await asWorker((tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY), TENANT_B)).toMatchObject({ created: BASELINE_PACK.entries.length });
      expect(await owner("select count(*)::int as n from machvon.outbox_event where type = 'master.baseline_applied.v1'")).toEqual([{ n: 1 }]);
    });

    it('keeps the funding sources as a tree with the national target programmes inside their budget source', async () => {
      const tree = await owner<{ business_key: string; parent: string | null; attributes: { relation: string; category: string } }>(
        `select r.business_key, p.business_key as parent, v.attributes from machvon.master_record r
           join machvon.master_record_version v on v.id = r.current_version_id
           left join machvon.master_record p on p.id = v.parent_id
          where r.master_type = 'FUND_SOURCE' and r.namespace = 'PLATFORM' order by r.business_key`,
      );
      expect(tree.filter((row) => row.attributes.category === 'CTMTQG').map((row) => [row.business_key, row.parent, row.attributes.relation])).toEqual([
        ['CTMTQG-DTTS', 'NSTW-DTPT', 'SUBSET_OF'],
        ['CTMTQG-GNBV', 'NSTW-DTPT', 'SUBSET_OF'],
        ['CTMTQG-NTM', 'NSTW-DTPT', 'SUBSET_OF'],
      ]);
    });

    it('lists the entries with their attributes, parent and legal basis in one read', async () => {
      const stages = await as(STEWARD, (tx) => store.search(tx, { masterType: 'PROJECT_STAGE', namespace: 'PLATFORM', asOf: TODAY, limit: 50, after: undefined }));
      expect(stages).toHaveLength(11);
      expect(stages.find((row) => row.businessKey === 'APPRAISAL')).toMatchObject({
        revision: 1,
        parentRecordId: null,
        legalBasis: null,
        attributes: { sequence: 2, allowed_next: ['PIPELINE', 'REJECTED', 'CONCEPT', 'CANCELLED'] },
      });
      const sources = await as(STEWARD, (tx) => store.search(tx, { masterType: 'FUND_SOURCE', namespace: 'PLATFORM', asOf: TODAY, limit: 50, after: undefined }));
      const parent = sources.find((row) => row.businessKey === 'NSTW-DTPT');
      expect(sources.find((row) => row.businessKey === 'CTMTQG-NTM')).toMatchObject({ parentRecordId: parent?.id, attributes: { category: 'CTMTQG', relation: 'SUBSET_OF' } });
      const groups = await as(STEWARD, (tx) => store.search(tx, { masterType: 'PROJECT_GROUP', namespace: 'PLATFORM', asOf: TODAY, limit: 50, after: undefined }));
      expect(groups.find((row) => row.businessKey === 'A')?.legalBasis).toContain('58/2024');
    });

    it('refuses a pack that does not match its digest and one whose entries break the rules of their type', async () => {
      const tampered = { ...BASELINE_PACK, entries: BASELINE_PACK.entries.map((entry, index) => (index === 0 ? { ...entry, label: 'Changed on the way' } : entry)) };
      await expect(asWorker((tx) => applyBaseline(tx, tampered, WORKER, TODAY), TENANT_B)).rejects.toThrow('does not match its digest');
      const broken: BaselineEntry = { masterType: 'PROJECT_GROUP', businessKey: 'Z', label: 'Group Z', attributes: {}, validFrom: '2025-01-01' };
      expect(await refusal(asWorker((tx) => applyBaseline(tx, sealPack('BROKEN', [broken]), WORKER, TODAY), TENANT_B))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'attributes.rank' });
      const orphan: BaselineEntry = { masterType: 'PROJECT_GROUP', businessKey: 'Z', label: 'Group Z', parentKey: 'MISSING', attributes: { rank: 5 }, validFrom: '2025-01-01' };
      await expect(asWorker((tx) => applyBaseline(tx, sealPack('ORPHAN', [orphan]), WORKER, TODAY), TENANT_B)).rejects.toThrow('parent that is not in the pack');
      expect(packDigest(BASELINE_PACK.entries)).toBe(BASELINE_PACK.sha256);
    });

    it('gives an entry a later version without rewriting the one before it, and refuses a pack that would', async () => {
      const group = BASELINE_PACK.entries.find((entry) => entry.masterType === 'PROJECT_GROUP' && entry.businessKey === 'C') as BaselineEntry;
      const later = sealPack('LATER', [{ ...group, label: 'Dự án nhóm C (sửa)', validFrom: '2030-01-01' }]);
      expect(await asWorker((tx) => applyBaseline(tx, later, WORKER, TODAY), TENANT_B)).toEqual({ created: 0, superseded: 1, unchanged: 0 });
      const versions = await owner<{ revision: number; label: string; valid_from: string; valid_until: string | null; status: string }>(
        `select v.revision, v.label, v.valid_from::text, v.valid_until::text, v.status from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id
          where r.master_type = 'PROJECT_GROUP' and r.business_key = 'C' and r.namespace = 'PLATFORM' order by v.revision`,
        [],
        TENANT_B,
      );
      expect(versions).toEqual([
        { revision: 1, label: 'Dự án nhóm C', valid_from: '2025-01-01', valid_until: '2030-01-01', status: 'EFFECTIVE' },
        { revision: 2, label: 'Dự án nhóm C (sửa)', valid_from: '2030-01-01', valid_until: null, status: 'APPROVED' },
      ]);
      // The first pack applied again after the later one is still a no-op, and a pack that rewrites a version in force is refused.
      expect(await asWorker((tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY), TENANT_B)).toMatchObject({ created: 0, superseded: 0 });
      const rewrite = sealPack('REWRITE', [{ ...group, label: 'Rewritten', validFrom: '2025-01-01' }]);
      await expect(asWorker((tx) => applyBaseline(tx, rewrite, WORKER, TODAY), TENANT_B)).rejects.toThrow('already in force');
    });
  });

  describe('the rule port', () => {
    it('returns the national code rule with its legal basis and the confirmation it waits for (AC-ST-MDM-003-3)', async () => {
      const rule = await as(STEWARD, (tx) => rules.nationalCode(tx, TODAY));
      expect(rule).toMatchObject({ mode: 'BLOCK', fromStageKey: 'PIPELINE', format: { pattern: '^\\d{7}$', example: '7654321' } });
      expect(rule?.reading).toMatchObject({ ruleType: 'NATIONAL_CODE_REQUIRED', awaitingConfirmation: true, cxn: 'CXN-01', ownerModule: 'CAP', validFrom: '2025-01-01', revision: 1 });
      expect(rule?.reading.legalBasis).toContain('CXN-01');
      expect(await as(STEWARD, (tx) => rules.nationalCode(tx, '2024-12-31'))).toBeUndefined();
      expect(await as(STEWARD, (tx) => rules.read(tx, 'NATIONAL_CODE_REQUIRED', 'NOPE', TODAY))).toBeUndefined();
    });

    it('suggests the group from the table in force on the proposal date, the sector table first (AC-ST-MDM-003-2)', async () => {
      const suggest = (amount: string, sectorKey?: string, on = TODAY) => as(STEWARD, (tx) => rules.suggestGroup(tx, { totalInvestmentVnd: amount, sectorKey }, on));
      expect((await suggest('0'))?.groupKey).toBe('C');
      expect((await suggest('119999999999.99'))?.groupKey).toBe('C');
      expect((await suggest('120000000000'))?.groupKey).toBe('B');
      expect((await suggest('2300000000000'))?.groupKey).toBe('A');
      expect((await suggest('30000000000000'))?.groupKey).toBe('QTQG');
      expect((await suggest('500000000000', 'TRANSPORT'))).toMatchObject({ groupKey: 'B', sectorKey: null });
      expect((await suggest('500', undefined, '2024-12-31'))).toBeUndefined();
      expect(await refusal(suggest('-1'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'total_investment_vnd' });
      expect(await refusal(suggest('1.234'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'total_investment_vnd' });

      // r2 starts on 2031-01-01 with a lower ceiling for C and a table of its own for transport.
      const thresholds = BASELINE_PACK.entries.find((entry) => entry.masterType === 'PROJECT_GROUP_THRESHOLDS') as BaselineEntry;
      const band = (sector: string | null, group: string, min: string, max: string | null) => ({ sector_key: sector, group_key: group, min_amount: min, max_amount: max });
      const r2 = sealPack('R2', [
        {
          ...thresholds,
          validFrom: '2031-01-01',
          legalBasis: 'Resolution of 2030 (r2)',
          attributes: {
            ...thresholds.attributes,
            bands: [band(null, 'C', '0', '100000000000'), band(null, 'B', '100000000000', '2300000000000'), band(null, 'A', '2300000000000', null), band('TRANSPORT', 'C', '0', '50000000000'), band('TRANSPORT', 'B', '50000000000', null)],
          },
        },
      ]);
      await asWorker((tx) => applyBaseline(tx, r2, WORKER, TODAY));
      expect((await suggest('110000000000', undefined, '2030-12-31'))?.groupKey).toBe('C');
      const after = await suggest('110000000000', undefined, '2031-01-01');
      expect(after).toMatchObject({ groupKey: 'B' });
      expect(after?.reading).toMatchObject({ revision: 2, legalBasis: 'Resolution of 2030 (r2)', validFrom: '2031-01-01' });
      expect(await suggest('60000000000', 'TRANSPORT', '2031-06-01')).toMatchObject({ groupKey: 'B', sectorKey: 'TRANSPORT' });
      expect((await suggest('60000000000', 'TRANSPORT', '2030-06-01'))?.groupKey).toBe('C');
    });
  });
});
