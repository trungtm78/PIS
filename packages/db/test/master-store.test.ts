import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { vietnamDateOf } from '@machvon/kernel';
import { BASELINE_POLICIES, MASTER_REFERENCES, MasterStore, contentHashOf } from '../src/master-store';
import type { MasterContent } from '../src/master-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new MasterStore();
const STEWARD = 1;
const CHECKER = 2;
const PUBLISHER = 3;
const TODAY = vietnamDateOf(new Date());
const FUTURE = '2999-01-01';
const DECISION_DOCUMENT = id(0x70, 1);

const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

const content = (overrides: Partial<MasterContent> = {}): MasterContent => ({
  label: 'Giao thông',
  attributes: { group: 'infrastructure' },
  parentRecordId: null,
  validFrom: '2024-01-01',
  validUntil: null,
  legalBasis: null,
  ...overrides,
});

let counter = 0;
const nextKey = (prefix = 'GT'): string => {
  counter += 1;
  return `${prefix}-${counter}`;
};

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number };
    if (e.code !== undefined && e.status !== undefined) return { code: e.code, status: e.status };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('MasterStore (versioned master data, ST-MDM-001)', () => {
  const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  /** Statements that need the superuser: referential checks are switched off to plant a row that refers to a version. */
  async function admin(statements: Array<[string, unknown[]?]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [text, params] of statements) await client.query(text, params);
    } finally {
      await client.end();
    }
  }

  const insertProject = (code: string, versionId: string): [string, unknown[]] => [
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, sector_master_version_id, classification, total_investment_vnd, status, version)
     values ($1, $2, $3, 'Project', $4, $5, $6, 'INTERNAL', 1000, 'CONCEPT', 1)`,
    [TENANT_A, randomUUID(), code, id(0x10, 1), randomUUID(), versionId],
  ];

  /** A record that is in force: proposed, submitted, approved by a second person and published by a third. */
  async function inForce(overrides: Partial<MasterContent> = {}, masterType = 'SECTOR', key = nextKey()): Promise<{ recordId: string; versionId: string; key: string }> {
    const created = await as(STEWARD, (tx) => store.propose(tx, { masterType, businessKey: key, content: content(overrides), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
    const submitted = await as(STEWARD, (tx) => store.submit(tx, created.changeRequestId, 1, memberId(STEWARD)));
    await as(CHECKER, (tx) => store.decide(tx, created.changeRequestId, submitted.version, 'approve', memberId(CHECKER)));
    const record = await as(PUBLISHER, (tx) => store.findRecord(tx, created.recordId));
    const published = await as(PUBLISHER, (tx) => store.publish(tx, created.recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)));
    return { recordId: created.recordId, versionId: published.versionId, key };
  }

  async function change(
    recordId: string,
    kind: 'UPDATE' | 'RETIRE',
    proposed: Record<string, unknown>,
    effectiveFrom: string,
    extra: { successorRecordId?: string } = {},
  ): Promise<{ id: string; version: number }> {
    return as(STEWARD, (tx) =>
      store.createChange(tx, { kind, masterType: 'SECTOR', masterRecordId: recordId, proposed, effectiveFrom, reason: 'Rename after the 2025 decision', ...extra }, memberId(STEWARD)),
    );
  }

  async function approve(changeId: string): Promise<void> {
    const submitted = await as(STEWARD, (tx) => store.submit(tx, changeId, 1, memberId(STEWARD)));
    await as(CHECKER, (tx) => store.decide(tx, changeId, submitted.version, 'approve', memberId(CHECKER)));
  }

  async function publishChange(recordId: string): Promise<Awaited<ReturnType<MasterStore['publish']>>> {
    const record = await as(PUBLISHER, (tx) => store.findRecord(tx, recordId));
    return as(PUBLISHER, (tx) => store.publish(tx, recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)));
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      // The types these tests write are the tenant's own: a row of the control plane replaces the baseline of the platform for them.
      await harness.owner(tenant, [
        ...['SECTOR', 'FUND_SOURCE'].map((type): [string, unknown[]] => [
          "insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, $2, 'TENANT_ONLY', $3)",
          [tenant, type, memberId(STEWARD)],
        ]),
      ]);
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

  describe('proposing a record', () => {
    it('creates the record, its draft version and its CREATE change request with the content hash, and nothing is in force yet', async () => {
      const key = nextKey();
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: key, content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      const record = await as(STEWARD, (tx) => store.findRecord(tx, created.recordId));
      expect(record).toMatchObject({ namespace: 'TENANT', masterType: 'SECTOR', businessKey: key, status: 'DRAFT', currentVersionId: null });
      const version = await as(STEWARD, (tx) => store.findVersion(tx, created.versionId));
      expect(version).toMatchObject({ revision: 1, status: 'DRAFT', label: 'Giao thông', validFrom: '2024-01-01', validUntil: null });
      expect(version?.contentSha256).toBe(contentHashOf('SECTOR', key, content()));
      const request = await as(STEWARD, (tx) => store.findChange(tx, created.changeRequestId));
      expect(request).toMatchObject({ changeKind: 'CREATE', status: 'DRAFT', createdBy: memberId(STEWARD), version: 1, impact: { total: 0, counts: {} } });
      expect(await as(STEWARD, (tx) => store.versionInForce(tx, created.recordId, TODAY))).toBeUndefined();
    });

    it('refuses the same key in the same tenant with 409 DUPLICATE_KEY and lets another tenant use it without seeing the first (AC-ST-MDM-001-1)', async () => {
      const key = nextKey();
      await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: key, content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      expect(await refusal(as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: key, content: content(), reason: 'Again' }, memberId(STEWARD))))).toEqual({
        code: 'DUPLICATE_KEY',
        status: 409,
      });
      await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: key, content: content(), reason: 'Other tenant' }, memberId(STEWARD)), TENANT_B);
      const seenByB = await as(STEWARD, (tx) => store.search(tx, { businessKey: key, asOf: TODAY, limit: 10, after: undefined }), TENANT_B);
      expect(seenByB).toHaveLength(1);
      const seenByA = await as(STEWARD, (tx) => store.search(tx, { businessKey: key, asOf: TODAY, limit: 10, after: undefined }));
      expect(seenByA.map((row) => row.id)).not.toContain(seenByB[0]?.id);
    });

    it('refuses an end date that is not after the start, and a parent of another type', async () => {
      const bad = content({ validFrom: '2025-01-01', validUntil: '2025-01-01' });
      expect(await refusal(as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: bad, reason: 'Initial catalogue entry' }, memberId(STEWARD))))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
      });
      const other = await inForce({ attributes: { category: 'NSTW', relation: 'ADDITIVE' } }, 'FUND_SOURCE');
      expect(
        await refusal(
          as(STEWARD, (tx) =>
            store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content({ parentRecordId: other.recordId }), reason: 'Initial catalogue entry' }, memberId(STEWARD)),
          ),
        ),
      ).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
    });
  });

  describe('what approval alone does not do', () => {
    it('does not put an approved record that is not published in force, nor let the activation job do it', async () => {
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      await approve(created.changeRequestId);
      expect(await as(STEWARD, (tx) => store.findRecord(tx, created.recordId))).toMatchObject({ status: 'APPROVED', currentVersionId: null });
      expect(await as(STEWARD, (tx) => store.versionInForce(tx, created.recordId, TODAY))).toBeUndefined();
      const found = await as(STEWARD, (tx) => store.search(tx, { masterType: 'SECTOR', asOf: TODAY, limit: 500, after: undefined }));
      expect(found.find((row) => row.id === created.recordId)).toMatchObject({ status: 'APPROVED', label: null, versionId: null });
      await as(STEWARD, (tx) => store.activateDue(tx, memberId(STEWARD), TODAY));
      await as(STEWARD, (tx) => store.activateDue(tx, memberId(STEWARD), FUTURE));
      expect(await as(STEWARD, (tx) => store.findRecord(tx, created.recordId))).toMatchObject({ status: 'APPROVED', currentVersionId: null });
      await publishChange(created.recordId);
      expect(await as(STEWARD, (tx) => store.findRecord(tx, created.recordId))).toMatchObject({ status: 'EFFECTIVE' });
    });
  });

  describe('a change is judged again when it is published', () => {
    it('refuses a retirement that something started to use after it was requested, and one whose successor was retired meanwhile', async () => {
      const entry = await inForce();
      const heir = await inForce();
      const plain = await change(entry.recordId, 'RETIRE', {}, TODAY);
      await approve(plain.id);
      await admin([insertProject(`LATE-${counter}`, (await as(STEWARD, (tx) => store.findRecord(tx, entry.recordId)))?.currentVersionId ?? '')]);
      const record = await as(PUBLISHER, (tx) => store.findRecord(tx, entry.recordId));
      expect(await refusal(as(PUBLISHER, (tx) => store.publish(tx, entry.recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER))))).toEqual({ code: 'MASTER_IN_USE', status: 409 });
      expect((await as(STEWARD, (tx) => store.findRecord(tx, entry.recordId)))?.status).toBe('EFFECTIVE');

      const other = await inForce();
      const withHeir = await change(other.recordId, 'RETIRE', {}, TODAY, { successorRecordId: heir.recordId });
      await approve(withHeir.id);
      await owner("update machvon.master_record set status = 'RETIRED' where id = $1", [heir.recordId]);
      const otherRecord = await as(PUBLISHER, (tx) => store.findRecord(tx, other.recordId));
      expect(await refusal(as(PUBLISHER, (tx) => store.publish(tx, other.recordId, otherRecord?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER))))).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
    });

    it('moves the version of the record with every publication, also one that waits for its date, so each has an identity', async () => {
      const entry = await inForce();
      const before = await as(STEWARD, (tx) => store.findRecord(tx, entry.recordId));
      const opened = await change(entry.recordId, 'UPDATE', { label: 'From a later date' }, FUTURE);
      await approve(opened.id);
      const published = await publishChange(entry.recordId);
      expect(published.active).toBe(false);
      expect(published.version).toBeGreaterThan(before?.version ?? 0);
      expect(published.record.currentVersionId).toBe(before?.currentVersionId);
    });
  });

  describe('the end date of a version', () => {
    it('is kept by a change that does not name it, and removed only when the change says null', async () => {
      const entry = await inForce({ validUntil: '2031-01-01' });
      const rename = await change(entry.recordId, 'UPDATE', { label: 'Renamed, same end' }, '2025-06-01');
      await approve(rename.id);
      const first = await publishChange(entry.recordId);
      expect(await as(STEWARD, (tx) => store.findVersion(tx, first.versionId))).toMatchObject({ validFrom: '2025-06-01', validUntil: '2031-01-01' });
      const open = await change(entry.recordId, 'UPDATE', { label: 'Renamed, no end', validUntil: null }, '2025-07-01');
      await approve(open.id);
      const second = await publishChange(entry.recordId);
      expect(await as(STEWARD, (tx) => store.findVersion(tx, second.versionId))).toMatchObject({ validUntil: null });
    });

    it('refuses a kept end date that the new start has already passed', async () => {
      const entry = await inForce({ validFrom: '2024-01-01', validUntil: '2030-01-01' });
      expect(await refusal(change(entry.recordId, 'UPDATE', { label: 'Too late' }, '2031-01-01'))).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
    });
  });

  describe('the policy of the types (ST-MDM-002)', () => {
    /** A record with a version in force in tenant A: for the platform namespace, a read-only copy of what the platform published. */
    async function platformRecord(masterType: string, namespace: 'PLATFORM' | 'TENANT' = 'PLATFORM'): Promise<string> {
      const recordId = randomUUID();
      const versionId = randomUUID();
      const key = nextKey('PL');
      await owner(
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
         values ($1, $2, $6, $3, $4, 'EFFECTIVE', $5, $5)`,
        [TENANT_A, recordId, masterType, key, memberId(STEWARD), namespace],
      );
      await owner(
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 1, 'Seeded entry', '{}', '2024-01-01', 'EFFECTIVE', $7, $6, $6)`,
        [TENANT_A, versionId, recordId, masterType, key, memberId(STEWARD), namespace],
      );
      await owner('update machvon.master_record set current_version_id = $2 where id = $1', [recordId, versionId]);
      return recordId;
    }

    const proposeOf = (masterType: string, parentRecordId: string | null = null): Promise<unknown> =>
      as(STEWARD, (tx) => store.propose(tx, { masterType, businessKey: nextKey('PO'), content: content({ parentRecordId, attributes: masterType === 'PROGRAM' ? { kind: 'LOCAL', period_from: 2021, period_to: 2025 } : { group: 'infrastructure' } }), reason: 'Initial catalogue entry' }, memberId(STEWARD)));

    it('keeps a type that only the platform publishes closed to a tenant, naming the field that locks it (AC-ST-MDM-002-2)', async () => {
      const refused = await refusal(proposeOf('ADMIN_UNIT'));
      expect(refused).toEqual({ code: 'POLICY_LOCKED', status: 403 });
      const detail = await as(STEWARD, async (tx) => store.policyOf(tx, 'ADMIN_UNIT'));
      expect(detail).toEqual({ masterType: 'ADMIN_UNIT', scope: 'PLATFORM_ONLY', retireRequiresSuccessor: true, source: 'BASELINE' });
      expect(await owner("select count(*)::text as n from machvon.master_record where master_type = 'ADMIN_UNIT'")).toEqual([{ n: '0' }]);
    });

    it('lets a tenant extend a platform type only with a child entry under an entry of the platform (AC-ST-MDM-002-2)', async () => {
      expect(await refusal(proposeOf('PROGRAM'))).toEqual({ code: 'POLICY_LOCKED', status: 403 });
      const own = await platformRecord('PROGRAM', 'TENANT');
      expect(await refusal(proposeOf('PROGRAM', own))).toEqual({ code: 'POLICY_LOCKED', status: 403 });
      const platform = await platformRecord('PROGRAM');
      await expect(proposeOf('PROGRAM', platform)).resolves.toMatchObject({ version: 1 });
    });

    it('refuses to change an entry of the platform, whatever the type policy says (AC-ST-MDM-002-2)', async () => {
      const platform = await platformRecord('SECTOR');
      expect(
        await refusal(
          as(STEWARD, (tx) =>
            store.createChange(tx, { kind: 'UPDATE', masterType: 'SECTOR', masterRecordId: platform, proposed: { label: 'Tampered' }, effectiveFrom: '2025-06-01', reason: 'Tenant edit of a platform entry' }, memberId(STEWARD)),
          ),
        ),
      ).toEqual({ code: 'POLICY_LOCKED', status: 403 });
    });

    it('lets a row of the control plane replace the baseline, and reads the tenant row before the baseline', async () => {
      expect(await as(STEWARD, (tx) => store.policyOf(tx, 'SECTOR'))).toEqual({ masterType: 'SECTOR', scope: 'TENANT_ONLY', retireRequiresSuccessor: false, source: 'TENANT' });
      expect(await as(STEWARD, (tx) => store.policyOf(tx, 'NO_SUCH_TYPE'))).toEqual({ masterType: 'NO_SUCH_TYPE', scope: 'TENANT_ONLY', retireRequiresSuccessor: false, source: 'BASELINE' });
      expect(Object.keys(BASELINE_POLICIES).sort()).toEqual([
        'ADMIN_UNIT',
        'APPRAISAL_CRITERIA',
        'AREA',
        'AST_WARRANTY',
        'BID_PETITION',
        'CALENDAR',
        'CONTACT_PURPOSE',
        'CONTRACTOR_CRITERION',
        'CONTRACT_TYPE',
        'CURRENCY',
        'DECISION_AUTHORITY',
        'DECISION_TYPE',
        'DOCUMENT_TYPE',
        'EXPERT_ROLE',
        'FUND_SOURCE',
        'FX_RATE',
        'LANGUAGE',
        'LND_PRICE_DECISION',
        'LND_TIMER',
        'NATIONAL_CODE_FORMAT',
        'NATIONAL_CODE_REQUIRED',
        'PAYMENT_TYPE',
        'PAY_ADVANCE_CAP',
        'PAY_ADVANCE_GPMB',
        'PAY_SETTLEMENT_DEADLINE',
        'PROGRAM',
        'PROJECT_GROUP',
        'PROJECT_GROUP_THRESHOLDS',
        'PROJECT_STAGE',
        'PROJECT_TYPE',
        'QMS_REGIME',
        'RETENTION_POLICY',
        'SECTOR',
        'TREASURY_OFFICE',
        'UNIT',
      ]);
      // The law and the process of the platform are its own; the rule data is never a tenant's to write by default.
      for (const type of ['PROJECT_GROUP', 'PROJECT_STAGE', 'PROJECT_GROUP_THRESHOLDS', 'NATIONAL_CODE_REQUIRED', 'NATIONAL_CODE_FORMAT', 'APPRAISAL_CRITERIA', 'LND_TIMER', 'BID_PETITION', 'AST_WARRANTY', 'QMS_REGIME', 'PAY_ADVANCE_CAP', 'PAY_ADVANCE_GPMB']) {
        expect(BASELINE_POLICIES[type]?.scope).toBe('PLATFORM_ONLY');
      }
    });

    it('lists every type the tenant holds or the platform governs with its policy and the number of entries of each namespace', async () => {
      await platformRecord('SECTOR');
      const summary = await as(STEWARD, (tx) => store.listPolicies(tx));
      const sector = summary.find((row) => row.masterType === 'SECTOR');
      expect(sector).toMatchObject({ scope: 'TENANT_ONLY', source: 'TENANT' });
      expect(sector?.platformRecords).toBeGreaterThanOrEqual(1);
      expect(sector?.tenantRecords).toBeGreaterThanOrEqual(1);
      expect(summary.find((row) => row.masterType === 'ADMIN_UNIT')).toMatchObject({ scope: 'PLATFORM_ONLY', platformRecords: 0, tenantRecords: 0 });
      expect([...summary.map((row) => row.masterType)]).toEqual([...summary.map((row) => row.masterType)].sort());
      // Another tenant sees its own counts and its own rows only.
      const other = await as(STEWARD, (tx) => store.listPolicies(tx), TENANT_B);
      expect(other.find((row) => row.masterType === 'SECTOR')).toMatchObject({ platformRecords: 0 });
    });

    it('does not let the tenant plane write its own policy', async () => {
      await expect(as(STEWARD, (tx) => tx.query("insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values (current_setting('app.tenant_id')::uuid, 'X', 'TENANT_ONLY', $1::uuid)", [memberId(STEWARD)]))).rejects.toMatchObject({
        code: '42501',
      });
      await expect(as(STEWARD, (tx) => tx.query("update machvon.master_type_policy set scope = 'TENANT_ONLY'"))).rejects.toMatchObject({ code: '42501' });
    });

    it('requires a successor for a type whose history is kept by succession, even when nothing uses the entry', async () => {
      await owner("insert into machvon.master_type_policy (tenant_id, master_type, scope, retire_requires_successor, updated_by) values ($1, 'KEPT', 'TENANT_ONLY', true, $2)", [TENANT_A, memberId(STEWARD)]);
      const kept = await inForce({}, 'KEPT');
      const heir = await inForce({}, 'KEPT');
      const retire = (successor?: string) =>
        as(STEWARD, (tx) =>
          store.createChange(tx, { kind: 'RETIRE', masterType: 'KEPT', masterRecordId: kept.recordId, proposed: {}, effectiveFrom: TODAY, reason: 'No longer needed', ...(successor === undefined ? {} : { successorRecordId: successor }) }, memberId(STEWARD)),
        );
      expect(await refusal(retire())).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
      await expect(retire(heir.recordId)).resolves.toMatchObject({ version: 1 });
    });

    it('reads the old name of an agency for the date of a report accepted before it was renamed and retired (AC-ST-MDM-002-3)', async () => {
      const agency = await inForce({ label: 'Ban QLDA Huyện X', validFrom: '2024-01-01' }, 'AGENCY');
      const rename = await as(STEWARD, (tx) =>
        store.createChange(tx, { kind: 'UPDATE', masterType: 'AGENCY', masterRecordId: agency.recordId, proposed: { label: 'Ban QLDA Khu vực X' }, effectiveFrom: '2025-06-01', reason: 'Renamed by decision 12' }, memberId(STEWARD)),
      );
      await approve(rename.id);
      await publishChange(agency.recordId);
      const retire = await as(STEWARD, (tx) =>
        store.createChange(tx, { kind: 'RETIRE', masterType: 'AGENCY', masterRecordId: agency.recordId, proposed: {}, effectiveFrom: TODAY, reason: 'Merged into a regional board' }, memberId(STEWARD)),
      );
      await approve(retire.id);
      expect((await publishChange(agency.recordId)).record.status).toBe('RETIRED');
      expect((await as(STEWARD, (tx) => store.versionInForce(tx, agency.recordId, '2025-03-01')))?.label).toBe('Ban QLDA Huyện X');
      expect((await as(STEWARD, (tx) => store.versionInForce(tx, agency.recordId, '2025-07-01')))?.label).toBe('Ban QLDA Khu vực X');
      expect(await as(STEWARD, (tx) => store.versionInForce(tx, agency.recordId, TODAY))).toBeUndefined();
    });
  });

  describe('maker-checker', () => {
    it('refuses the proposer as the reviewer with 403 SELF_APPROVAL_DENIED and keeps the request in review', async () => {
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      const submitted = await as(STEWARD, (tx) => store.submit(tx, created.changeRequestId, 1, memberId(STEWARD)));
      expect(await refusal(as(STEWARD, (tx) => store.decide(tx, created.changeRequestId, submitted.version, 'approve', memberId(STEWARD))))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await as(STEWARD, (tx) => store.findChange(tx, created.changeRequestId)))?.status).toBe('IN_REVIEW');
    });

    it('refuses the proposer as the publisher, and a publisher without an approved request', async () => {
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      const submitted = await as(STEWARD, (tx) => store.submit(tx, created.changeRequestId, 1, memberId(STEWARD)));
      const record = await as(STEWARD, (tx) => store.findRecord(tx, created.recordId));
      expect(await refusal(as(PUBLISHER, (tx) => store.publish(tx, created.recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER))))).toEqual({ code: 'CHANGE_NOT_APPROVED', status: 409 });
      await as(CHECKER, (tx) => store.decide(tx, created.changeRequestId, submitted.version, 'approve', memberId(CHECKER)));
      const approved = await as(STEWARD, (tx) => store.findRecord(tx, created.recordId));
      expect(await refusal(as(STEWARD, (tx) => store.publish(tx, created.recordId, approved?.version ?? 0, DECISION_DOCUMENT, memberId(STEWARD))))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    });

    it('keeps the proposer from deciding even when the database trigger is the only guard (master_cr_sod_chk)', async () => {
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      await expect(owner("update machvon.master_change_request set reviewed_by = created_by where id = $1", [created.changeRequestId])).rejects.toMatchObject({ code: '23514' });
    });

    it('returns a request to its author, who can then submit it again, and a rejected request cannot go on', async () => {
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      const first = await as(STEWARD, (tx) => store.submit(tx, created.changeRequestId, 1, memberId(STEWARD)));
      const returned = await as(CHECKER, (tx) => store.decide(tx, created.changeRequestId, first.version, 'return', memberId(CHECKER)));
      expect(returned.status).toBe('DRAFT');
      const again = await as(STEWARD, (tx) => store.submit(tx, created.changeRequestId, returned.version, memberId(STEWARD)));
      const rejected = await as(CHECKER, (tx) => store.decide(tx, created.changeRequestId, again.version, 'reject', memberId(CHECKER)));
      expect(rejected.status).toBe('REJECTED');
      expect(await refusal(as(STEWARD, (tx) => store.submit(tx, created.changeRequestId, rejected.version, memberId(STEWARD))))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      expect(await refusal(as(CHECKER, (tx) => store.decide(tx, created.changeRequestId, rejected.version, 'approve', memberId(CHECKER))))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
    });

    it('answers a stale version with 409 VERSION_CONFLICT', async () => {
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      expect(await refusal(as(STEWARD, (tx) => store.submit(tx, created.changeRequestId, 7, memberId(STEWARD))))).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
    });
  });

  describe('the impact preview', () => {
    it('is stored when the change request is made and recomputed when it is submitted (AC-ST-MDM-001-3)', async () => {
      const entry = await inForce();
      await admin([insertProject(`P-${counter}-a`, entry.versionId), insertProject(`P-${counter}-b`, entry.versionId)]);
      const opened = await change(entry.recordId, 'UPDATE', { label: 'Giao thông vận tải' }, '2025-06-01');
      const stored = await as(STEWARD, (tx) => store.findChange(tx, opened.id));
      expect(stored?.impact).toMatchObject({ counts: { 'project.sector_master_version_id': 2 }, total: 2 });
      expect(stored?.before).toMatchObject({ label: 'Giao thông' });
      expect(stored?.proposed).toMatchObject({ label: 'Giao thông vận tải', valid_from: '2025-06-01' });
      const usage = await as(STEWARD, (tx) => store.usage(tx, entry.recordId));
      expect(usage).toMatchObject({ total: 2, counts: { 'project.sector_master_version_id': 2 } });
      expect(usage.samples).toHaveLength(2);

      await admin([['delete from machvon.project where sector_master_version_id = $1', [entry.versionId]]]);
      const submitted = await as(STEWARD, (tx) => store.submit(tx, opened.id, 1, memberId(STEWARD)));
      expect(submitted.impact).toMatchObject({ total: 0, counts: {} });
    });

    it('counts the references to the version that was in force on the date asked, and to every version without a date', async () => {
      const entry = await inForce();
      await admin([insertProject(`U-${counter}`, entry.versionId)]);
      const opened = await change(entry.recordId, 'UPDATE', { label: 'Renamed' }, '2025-06-01');
      await approve(opened.id);
      await publishChange(entry.recordId);
      expect((await as(STEWARD, (tx) => store.usage(tx, entry.recordId, '2025-01-01'))).total).toBe(1);
      expect((await as(STEWARD, (tx) => store.usage(tx, entry.recordId, TODAY))).total).toBe(0);
      expect((await as(STEWARD, (tx) => store.usage(tx, entry.recordId))).total).toBe(1);
      expect(await as(STEWARD, (tx) => store.usage(tx, entry.recordId, '2023-01-01'))).toMatchObject({ total: 0, asOf: '2023-01-01' });
    });

    it('refuses to submit a request that has no computed impact with 422 IMPACT_NOT_COMPUTED and keeps it a draft (AC-ST-MDM-001-4)', async () => {
      const entry = await inForce();
      const opened = await change(entry.recordId, 'UPDATE', { label: 'Renamed' }, '2025-06-01');
      await owner('update machvon.master_change_request set impact_json = null where id = $1', [opened.id]);
      expect(await refusal(as(STEWARD, (tx) => store.submit(tx, opened.id, 1, memberId(STEWARD))))).toEqual({ code: 'IMPACT_NOT_COMPUTED', status: 422 });
      expect((await as(STEWARD, (tx) => store.findChange(tx, opened.id)))?.status).toBe('DRAFT');
    });

    it('lists every referencing column of the schema, each of them a real table and column with an id to sample', async () => {
      for (const reference of MASTER_REFERENCES) {
        const columns = await owner<{ n: string }>(
          "select count(*)::text as n from information_schema.columns where table_schema = 'machvon' and table_name = $1 and column_name in ($2, 'id')",
          [reference.table, reference.column],
        );
        expect(Number(columns[0]?.n)).toBe(2);
      }
    });

    it('lists exactly the foreign keys that point at a master record or one of its versions from outside the master data tables', async () => {
      const keys = await owner<{ key: string }>(
        `select distinct c.conrelid::regclass::text || '.' || a.attname as key
           from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey) and a.attname <> 'tenant_id'
          where c.contype = 'f' and c.confrelid in ('machvon.master_record'::regclass, 'machvon.master_record_version'::regclass)
            and c.conrelid not in ('machvon.master_change_request'::regclass)
            and not (c.conrelid = 'machvon.master_record_version'::regclass and a.attname in ('master_record_id', 'supersedes_id'))
            and not (c.conrelid = 'machvon.master_record'::regclass and a.attname = 'current_version_id')`,
      );
      const found = keys.map((row) => row.key.replace(/^machvon\./, '')).sort();
      expect(found).toEqual(MASTER_REFERENCES.map((reference) => reference.key).sort());
    });
  });

  describe('publishing and history', () => {
    it('closes the version in force at the effective date and starts the new one there, so old business dates still read the old label (AC-ST-MDM-001-3)', async () => {
      const entry = await inForce();
      const opened = await change(entry.recordId, 'UPDATE', { label: 'Giao thông vận tải', attributes: { group: 'transport' } }, '2025-06-01');
      await approve(opened.id);
      const published = await publishChange(entry.recordId);
      expect(published.active).toBe(true);
      expect(published.record).toMatchObject({ status: 'EFFECTIVE', currentVersionId: published.versionId });
      const old = await as(STEWARD, (tx) => store.versionInForce(tx, entry.recordId, '2025-01-01'));
      expect(old).toMatchObject({ id: entry.versionId, label: 'Giao thông', revision: 1, validUntil: '2025-06-01' });
      const current = await as(STEWARD, (tx) => store.versionInForce(tx, entry.recordId, TODAY));
      expect(current).toMatchObject({ id: published.versionId, label: 'Giao thông vận tải', revision: 2, validFrom: '2025-06-01', validUntil: null, status: 'EFFECTIVE' });
      expect(current?.attributes).toEqual({ group: 'transport' });
      const applied = await as(STEWARD, (tx) => store.findChange(tx, opened.id));
      expect(applied).toMatchObject({ status: 'APPLIED', publishedBy: memberId(PUBLISHER), decisionDocumentId: DECISION_DOCUMENT });
      const found = await as(STEWARD, (tx) => store.search(tx, { businessKey: entry.key, asOf: '2025-01-01', limit: 5, after: undefined }));
      expect(found[0]).toMatchObject({ label: 'Giao thông', openChangeRequestId: null });
    });

    it('refuses a second open change request on the same record, and a change that changes nothing', async () => {
      const entry = await inForce();
      await change(entry.recordId, 'UPDATE', { label: 'First' }, '2025-06-01');
      expect(await refusal(change(entry.recordId, 'UPDATE', { label: 'Second' }, '2025-07-01'))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      const other = await inForce();
      expect(await refusal(change(other.recordId, 'UPDATE', { label: 'Giao thông' }, '2025-07-01'))).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
    });

    it('refuses an effective date that is not after the start of the version in force', async () => {
      const entry = await inForce();
      expect(await refusal(change(entry.recordId, 'UPDATE', { label: 'Early' }, '2024-01-01'))).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
    });

    it('refuses a version that overlaps another published version of the record with 409 EFFECTIVE_RANGE_OVERLAP and changes nothing (AC-ST-MDM-001-2)', async () => {
      // r1 [2024-01-01, 2026-01-01) is in force; a published version [2026-02-01, 2027-01-01) exists beyond the gap.
      const entry = await inForce({ validFrom: '2024-01-01', validUntil: '2026-01-01' });
      const opened = await change(entry.recordId, 'UPDATE', { label: 'Overlapping', validUntil: null }, '2025-06-01');
      await approve(opened.id);
      await owner(
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, valid_until, status, namespace, created_by, updated_by)
         values ($1, $2, $3, 'SECTOR', $4, 9, 'Rogue', '{}', '2026-02-01', '2027-01-01', 'APPROVED', 'TENANT', $5, $5)`,
        [TENANT_A, randomUUID(), entry.recordId, entry.key, memberId(STEWARD)],
      );
      const record = await as(PUBLISHER, (tx) => store.findRecord(tx, entry.recordId));
      expect(await refusal(as(PUBLISHER, (tx) => store.publish(tx, entry.recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER))))).toEqual({ code: 'EFFECTIVE_RANGE_OVERLAP', status: 409 });
      expect((await as(STEWARD, (tx) => store.findChange(tx, opened.id)))?.status).toBe('APPROVED');
      expect((await as(STEWARD, (tx) => store.findVersion(tx, entry.versionId)))?.validUntil).toBe('2026-01-01');
    });

    it('refuses a decision document that does not exist', async () => {
      const entry = await inForce();
      const opened = await change(entry.recordId, 'UPDATE', { label: 'Renamed' }, '2025-06-01');
      await approve(opened.id);
      const record = await as(PUBLISHER, (tx) => store.findRecord(tx, entry.recordId));
      expect(await refusal(as(PUBLISHER, (tx) => store.publish(tx, entry.recordId, record?.version ?? 0, randomUUID(), memberId(PUBLISHER))))).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
    });

    it('waits for a future date: the version is approved but not in force until the activation job runs, which is idempotent', async () => {
      await as(STEWARD, (tx) => store.activateDue(tx, memberId(STEWARD), TODAY));
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content({ validFrom: FUTURE }), reason: 'Starts later' }, memberId(STEWARD)));
      await approve(created.changeRequestId);
      const published = await publishChange(created.recordId);
      expect(published.active).toBe(false);
      expect(published.record).toMatchObject({ status: 'APPROVED', currentVersionId: null });
      expect(await as(STEWARD, (tx) => store.activateDue(tx, memberId(STEWARD), TODAY))).toBe(0);
      expect(await as(STEWARD, (tx) => store.findRecord(tx, created.recordId))).toMatchObject({ status: 'APPROVED', currentVersionId: null });
      expect(await as(STEWARD, (tx) => store.activateDue(tx, memberId(STEWARD), FUTURE))).toBeGreaterThanOrEqual(1);
      expect(await as(STEWARD, (tx) => store.findRecord(tx, created.recordId))).toMatchObject({ status: 'EFFECTIVE', currentVersionId: created.versionId });
      expect(await as(STEWARD, (tx) => store.activateDue(tx, memberId(STEWARD), FUTURE))).toBe(0);
    });
  });

  describe('retirement', () => {
    it('refuses to retire an entry that is in use without a successor (409 MASTER_IN_USE), and retires it with one (AC-ST-MDM-002-1)', async () => {
      const entry = await inForce();
      const successor = await inForce();
      await admin([insertProject(`R-${counter}`, entry.versionId)]);
      expect(await refusal(change(entry.recordId, 'RETIRE', {}, TODAY))).toEqual({ code: 'MASTER_IN_USE', status: 409 });
      const opened = await change(entry.recordId, 'RETIRE', {}, TODAY, { successorRecordId: successor.recordId });
      await approve(opened.id);
      const published = await publishChange(entry.recordId);
      expect(published.record.status).toBe('RETIRED');
      expect(await as(STEWARD, (tx) => store.findVersion(tx, entry.versionId))).toMatchObject({ status: 'RETIRED', validUntil: TODAY });
      // The 1 project still refers to the version it always did.
      expect(Number((await owner<{ n: string }>('select count(*)::text as n from machvon.project where sector_master_version_id = $1', [entry.versionId]))[0]?.n)).toBe(1);
    });

    it('retires an entry that nothing uses without a successor, and refuses a successor of another type or one that is not in force', async () => {
      const unused = await inForce();
      const draft = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      expect(await refusal(change(unused.recordId, 'RETIRE', {}, TODAY, { successorRecordId: draft.recordId }))).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
      const opened = await change(unused.recordId, 'RETIRE', {}, TODAY);
      await approve(opened.id);
      expect((await publishChange(unused.recordId)).record.status).toBe('RETIRED');
    });

    it('retires a record whose retirement date is in the future when the activation job runs on that date', async () => {
      const entry = await inForce();
      const opened = await change(entry.recordId, 'RETIRE', {}, FUTURE);
      await approve(opened.id);
      const published = await publishChange(entry.recordId);
      expect(published.record.status).toBe('EFFECTIVE');
      expect(await as(STEWARD, (tx) => store.activateDue(tx, memberId(STEWARD), TODAY))).toBe(0);
      expect(await as(STEWARD, (tx) => store.activateDue(tx, memberId(STEWARD), FUTURE))).toBeGreaterThanOrEqual(1);
      expect(await as(STEWARD, (tx) => store.findRecord(tx, entry.recordId))).toMatchObject({ status: 'RETIRED' });
    });
  });

  describe('namespaces and tenants', () => {
    it('refuses a change to a record of the PLATFORM namespace with 403 POLICY_LOCKED', async () => {
      const entry = await inForce();
      await owner("update machvon.master_record set namespace = 'PLATFORM' where id = $1", [entry.recordId]);
      expect(await refusal(change(entry.recordId, 'UPDATE', { label: 'Tampered' }, '2025-06-01'))).toEqual({ code: 'POLICY_LOCKED', status: 403 });
    });

    it('does not show a record, a change request or a version of one tenant to another', async () => {
      const entry = await inForce();
      const opened = await change(entry.recordId, 'UPDATE', { label: 'Renamed' }, '2025-06-01');
      expect(await as(STEWARD, (tx) => store.findRecord(tx, entry.recordId), TENANT_B)).toBeUndefined();
      expect(await as(STEWARD, (tx) => store.findChange(tx, opened.id), TENANT_B)).toBeUndefined();
      expect(await as(STEWARD, (tx) => store.findVersion(tx, entry.versionId), TENANT_B)).toBeUndefined();
      expect(await refusal(as(STEWARD, (tx) => store.submit(tx, opened.id, 1, memberId(STEWARD)), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('listing', () => {
    it('pages through the versions and the records in a stable order, with the cursor of the last row', async () => {
      const seen: string[] = [];
      let after: { code: string; id: string } | undefined;
      for (let guard = 0; guard < 200; guard += 1) {
        const page = await as(STEWARD, (tx) => store.search(tx, { asOf: TODAY, limit: 5, after }));
        seen.push(...page.map((row) => row.id));
        const last = page[page.length - 1];
        if (page.length < 5 || last === undefined) break;
        after = { code: `${last.masterType}:${last.businessKey}`, id: last.id };
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBeGreaterThan(10);
      const versions = await as(STEWARD, (tx) => store.listVersions(tx, { limit: 3, after: undefined }));
      expect(versions).toHaveLength(3);
    });

    it('lists the history of one entry only, oldest revision first', async () => {
      const entry = await inForce();
      const opened = await change(entry.recordId, 'UPDATE', { label: 'Renamed once' }, '2025-06-01');
      await approve(opened.id);
      await publishChange(entry.recordId);
      const history = await as(STEWARD, (tx) => store.listVersions(tx, { limit: 10, after: undefined, masterRecordId: entry.recordId }));
      expect(history.map((version) => [version.revision, version.label])).toEqual([
        [1, 'Giao thông'],
        [2, 'Renamed once'],
      ]);
      // The reviewer and the request that made each version are known, for the history screen.
      expect(history[0]?.approvedBy).toBe(memberId(CHECKER));
      expect(history[1]).toMatchObject({ approvedBy: memberId(CHECKER), changeRequestId: opened.id });
    });

    it('lists the change requests oldest first, by status and type, in pages that follow the cursor', async () => {
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'LISTED', businessKey: nextKey('LI'), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      const second = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'LISTED', businessKey: nextKey('LI'), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      await as(STEWARD, (tx) => store.submit(tx, second.changeRequestId, 1, memberId(STEWARD)));
      const drafts = await as(STEWARD, (tx) => store.listChanges(tx, { status: 'DRAFT', masterType: 'LISTED', limit: 10, after: undefined }));
      expect(drafts.map((row) => row.id)).toEqual([created.changeRequestId]);
      // The entry the request is about comes with it: the key, and the record version a publication names in If-Match.
      expect(drafts[0]).toMatchObject({ businessKey: expect.stringMatching(/^LI-/), recordVersion: 1, recordStatus: 'DRAFT' });
      expect(await as(STEWARD, (tx) => store.findChangeDetail(tx, created.changeRequestId))).toMatchObject({ id: created.changeRequestId, recordVersion: 1 });
      expect(await as(STEWARD, (tx) => store.findChangeDetail(tx, randomUUID()))).toBeUndefined();
      const all = await as(STEWARD, (tx) => store.listChanges(tx, { masterType: 'LISTED', limit: 10, after: undefined }));
      expect(all.map((row) => row.id)).toEqual([created.changeRequestId, second.changeRequestId]);
      const first = all[0];
      const next = await as(STEWARD, (tx) => store.listChanges(tx, { masterType: 'LISTED', limit: 10, after: { code: first?.createdAtKey ?? '', id: first?.id ?? '' } }));
      expect(next.map((row) => row.id)).toEqual([second.changeRequestId]);
      expect(await as(STEWARD, (tx) => store.listChanges(tx, { masterType: 'LISTED', limit: 10, after: undefined }), TENANT_B)).toEqual([]);
    });

    it('counts the requests that wait for a reviewer', async () => {
      const before = await as(STEWARD, (tx) => store.pendingReviews(tx));
      const created = await as(STEWARD, (tx) => store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
      await as(STEWARD, (tx) => store.submit(tx, created.changeRequestId, 1, memberId(STEWARD)));
      expect(await as(STEWARD, (tx) => store.pendingReviews(tx))).toBe(before + 1);
    });
  });
});
