import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { vietnamDateOf } from '@machvon/kernel';
import { MASTER_REFERENCES, MasterStore, contentHashOf } from '../src/master-store';
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
      const other = await inForce({}, 'FUND_SOURCE');
      expect(
        await refusal(
          as(STEWARD, (tx) =>
            store.propose(tx, { masterType: 'SECTOR', businessKey: nextKey(), content: content({ parentRecordId: other.recordId }), reason: 'Initial catalogue entry' }, memberId(STEWARD)),
          ),
        ),
      ).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
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

    it('lists every referencing column of the schema, each of them a real table and column', async () => {
      for (const reference of MASTER_REFERENCES) {
        const columns = await owner<{ n: string }>(
          "select count(*)::text as n from information_schema.columns where table_schema = 'machvon' and table_name = $1 and column_name = $2",
          [reference.table, reference.column],
        );
        expect(Number(columns[0]?.n)).toBe(1);
      }
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
    it('refuses to retire an entry that is in use without a successor (409 MASTER_IN_USE), and retires it with one', async () => {
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
