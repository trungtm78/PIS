import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { vietnamDateOf } from '@machvon/kernel';
import { MasterStore } from '../src/master-store';
import type { MasterContent } from '../src/master-store';
import { MasterSuccessionStore } from '../src/master-succession-store';
import type { NewSuccession } from '../src/master-succession-store';
import { assertComplete, proposalOf, proposedJsonOf, shareHundredths, shareText } from '../src/master-succession';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const masters = new MasterStore();
const successions = new MasterSuccessionStore();
const STEWARD = 1;
const CHECKER = 2;
const PUBLISHER = 3;
const DECISION_DOCUMENT = id(0x70, 1);
const TODAY = vietnamDateOf(new Date());
const FUTURE = '2999-01-01';
const REFORM = '2025-07-01';
const BEFORE_REFORM = '2025-06-30';
const BASIS = 'Resolution 202/2025/QH15 (working assumption awaiting CXN-34)';
const REASON = 'Recorded after the 2025 administrative reform';

const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

const content = (overrides: Partial<MasterContent> = {}): MasterContent => ({
  label: 'Commune',
  attributes: { level: 'COMMUNE' },
  parentRecordId: null,
  validFrom: '2020-01-01',
  validUntil: null,
  legalBasis: null,
  ...overrides,
});

let counter = 0;
const nextKey = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${counter}`;
};

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    if (e.code !== undefined && e.status !== undefined) return { code: e.code, status: e.status, ...(e.detail === undefined ? {} : { detail: e.detail }) };
    throw error;
  }
  throw new Error('expected a refusal');
}

interface Entry {
  recordId: string;
  versionId: string;
  key: string;
}

describe('MasterSuccessionStore (administrative succession and the as-of reads, ST-MDM-009)', () => {
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

  /** An entry that is in force: proposed, submitted, approved by a second person and published by a third. */
  async function inForce(masterType: string, key: string, overrides: Partial<MasterContent> = {}): Promise<Entry> {
    const created = await as(STEWARD, (tx) => masters.propose(tx, { masterType, businessKey: key, content: content(overrides), reason: 'Initial catalogue entry' }, memberId(STEWARD)));
    const submitted = await as(STEWARD, (tx) => masters.submit(tx, created.changeRequestId, 1, memberId(STEWARD)));
    await as(CHECKER, (tx) => masters.decide(tx, created.changeRequestId, submitted.version, 'approve', memberId(CHECKER)));
    const record = await as(PUBLISHER, (tx) => masters.findRecord(tx, created.recordId));
    const published = await as(PUBLISHER, (tx) => masters.publish(tx, created.recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)));
    return { recordId: created.recordId, versionId: published.versionId, key };
  }

  const area = (key = nextKey('AREA'), overrides: Partial<MasterContent> = {}): Promise<Entry> => inForce('AREA', key, overrides);

  const input = (predecessor: string, successor: string, overrides: Partial<NewSuccession> = {}): NewSuccession => ({
    predecessorRecordId: predecessor,
    successorRecordId: successor,
    kind: 'MERGE',
    effectiveDate: REFORM,
    legalBasis: BASIS,
    reason: REASON,
    ...overrides,
  });
  const record = (data: NewSuccession, tenant = TENANT_A) => as(STEWARD, (tx) => successions.record(tx, data, memberId(STEWARD)), tenant);

  /** Submits, approves and publishes the open succession of an entry, as three different people. */
  async function putInForce(predecessor: string, changeRequestId: string, version: number): Promise<Awaited<ReturnType<MasterStore['publish']>>> {
    const submitted = await as(STEWARD, (tx) => masters.submit(tx, changeRequestId, version, memberId(STEWARD)));
    await as(CHECKER, (tx) => masters.decide(tx, changeRequestId, submitted.version, 'approve', memberId(CHECKER)));
    const found = await as(PUBLISHER, (tx) => masters.findRecord(tx, predecessor));
    return as(PUBLISHER, (tx) => masters.publish(tx, predecessor, found?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)));
  }

  /** Records one edge and puts it in force. */
  async function succeed(predecessor: Entry, successor: Entry, overrides: Partial<NewSuccession> = {}): Promise<void> {
    const recorded = await record(input(predecessor.recordId, successor.recordId, overrides));
    await putInForce(predecessor.recordId, recorded.changeRequestId, recorded.version);
  }

  const asOf = (recordId: string, on: string, tenant = TENANT_A) => as(STEWARD, (tx) => successions.asOf(tx, recordId, on), tenant);
  const successorsOf = (recordId: string, on: string) => as(STEWARD, (tx) => successions.successors(tx, recordId, on));

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      // The types these tests write are the tenant's own: a row of the control plane replaces the baseline of the platform for them.
      await harness.owner(tenant, [
        ...['AREA', 'AGENCY'].map((type): [string, unknown[]] => [
          "insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, $2, 'TENANT_ONLY', $3)",
          [tenant, type, memberId(STEWARD)],
        ]),
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
           values ($1, $2, 'INCOMING', 'CV', 'Decision', 'INTERNAL', $3, $3)`,
          [tenant, DECISION_DOCUMENT, memberId(STEWARD)],
        ],
      ]);
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      for (const n of [STEWARD, CHECKER, PUBLISHER]) await harness.seedMembership(tenant, n, 1);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the district abolished and two communes merged (FX-MDM-001)', () => {
    it('reads the district and the old communes before 2025-07-01 and the merged commune after, and a project keeps XA-A r1 (AC-ST-MDM-009-1, UAT-AC277)', async () => {
      const district = await area('HUYEN-X', { label: 'Huyen X', attributes: { level: 'DISTRICT' } });
      const province = await area('TINH-X', { label: 'Tinh X', attributes: { level: 'PROVINCE' } });
      const communeA = await area('XA-A', { label: 'Xa A', parentRecordId: district.recordId });
      const communeB = await area('XA-B', { label: 'Xa B', parentRecordId: district.recordId });
      const merged = await area('XA-Y', { label: 'Xa Y', parentRecordId: province.recordId, validFrom: REFORM });
      await admin([
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, sector_master_version_id, classification, total_investment_vnd, status, version)
           values ($1, $2, 'P-A-001', 'Project A', $3, $4, $5, 'INTERNAL', 1000, 'CONCEPT', 1)`,
          [TENANT_A, randomUUID(), id(0x10, 1), communeA.versionId, randomUUID()],
        ],
      ]);

      await succeed(communeA, merged);
      await succeed(communeB, merged);
      await succeed(district, province, { kind: 'ABOLISH_LEVEL' });

      // Before: the district and both communes, each as its own revision 1, all under their district.
      for (const entry of [district, communeA, communeB]) {
        const before = await asOf(entry.recordId, BEFORE_REFORM);
        expect(before).toMatchObject({ state: 'IN_FORCE', asOf: BEFORE_REFORM, version: { id: entry.versionId, revision: 1 } });
        expect(before?.targets.map((target) => target.businessKey)).toEqual([entry.key]);
      }
      expect((await asOf(communeA.recordId, BEFORE_REFORM))?.version?.parentRecordId).toBe(district.recordId);
      expect((await asOf(merged.recordId, BEFORE_REFORM))?.state).toBe('NOT_STARTED');

      // After: the communes and the district are succeeded; the merged commune is in force, under the province, and names both.
      const afterA = await asOf(communeA.recordId, REFORM);
      expect(afterA).toMatchObject({ state: 'SUCCEEDED', version: null, structureDate: REFORM });
      expect(afterA?.targets).toEqual([expect.objectContaining({ recordId: merged.recordId, businessKey: 'XA-Y', kind: 'MERGE', effectiveDate: REFORM, sharePct: '100.00' })]);
      expect(afterA?.targets[0]?.version).toMatchObject({ id: merged.versionId, label: 'Xa Y', parentRecordId: province.recordId });
      expect((await asOf(district.recordId, REFORM))?.targets.map((target) => [target.businessKey, target.kind])).toEqual([['TINH-X', 'ABOLISH_LEVEL']]);
      const afterY = await asOf(merged.recordId, REFORM);
      expect(afterY).toMatchObject({ state: 'IN_FORCE', structureDate: REFORM });
      expect(afterY?.predecessors.map((edge) => edge.predecessorKey).sort()).toEqual(['XA-A', 'XA-B']);
      expect(afterY?.predecessors.every((edge) => edge.sharePct === null && edge.legalBasis === BASIS)).toBe(true);

      // The conversion read from a later date names the same successor (the test case of FX-MDM-001: successors?date=2025-08-01).
      const converted = await successorsOf(communeA.recordId, '2025-08-01');
      expect(converted?.edges.map((edge) => [edge.predecessorKey, edge.successorKey, edge.kind])).toEqual([['XA-A', 'XA-Y', 'MERGE']]);
      expect(converted?.targets.map((target) => target.businessKey)).toEqual(['XA-Y']);
      // On a date before the reform nothing has been handed over yet.
      expect((await successorsOf(communeA.recordId, BEFORE_REFORM))?.edges).toEqual([]);

      // History is not rewritten: the project still points at revision 1 of XA-A, which is the only revision and was closed on the date.
      const versions = await owner<{ id: string; revision: number; valid_until: string | null }>(
        'select id, revision, valid_until::text as valid_until from machvon.master_record_version where master_record_id = $1::uuid order by revision',
        [communeA.recordId],
      );
      expect(versions).toEqual([{ id: communeA.versionId, revision: 1, valid_until: REFORM }]);
      const usage = await as(STEWARD, (tx) => masters.usage(tx, communeA.recordId, BEFORE_REFORM));
      expect(usage.counts['project.area_master_version_id']).toBe(1);
      const referenced = await owner<{ area_master_version_id: string }>("select area_master_version_id from machvon.project where code = 'P-A-001'");
      expect(referenced[0]?.area_master_version_id).toBe(communeA.versionId);
      expect(await as(STEWARD, (tx) => masters.findRecord(tx, communeA.recordId))).toMatchObject({ status: 'RETIRED' });
    });
  });

  describe('two provinces merged into one', () => {
    it('keeps the two provinces apart before the date and combines them after it, each tagged with its structure date (AC-ST-MDM-009-2, UAT-AC278)', async () => {
      const keep = await area('TINH-P', { label: 'Tinh P', attributes: { level: 'PROVINCE' } });
      const absorbed = await area('TINH-Q', { label: 'Tinh Q', attributes: { level: 'PROVINCE' } });
      // The surviving province is a new P from the date: its second revision, published as an ordinary change.
      const renamed = await as(STEWARD, (tx) =>
        masters.createChange(tx, { kind: 'UPDATE', masterType: 'AREA', masterRecordId: keep.recordId, proposed: { label: 'Tinh P moi' }, effectiveFrom: REFORM, reason: 'Merged province, new name' }, memberId(STEWARD)),
      );
      const submittedRename = await as(STEWARD, (tx) => masters.submit(tx, renamed.id, 1, memberId(STEWARD)));
      await as(CHECKER, (tx) => masters.decide(tx, renamed.id, submittedRename.version, 'approve', memberId(CHECKER)));
      const keepRecord = await as(PUBLISHER, (tx) => masters.findRecord(tx, keep.recordId));
      await as(PUBLISHER, (tx) => masters.publish(tx, keep.recordId, keepRecord?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)));
      await succeed(absorbed, keep);

      const pBefore = await asOf(keep.recordId, BEFORE_REFORM);
      const qBefore = await asOf(absorbed.recordId, BEFORE_REFORM);
      expect([pBefore?.state, qBefore?.state]).toEqual(['IN_FORCE', 'IN_FORCE']);
      expect([pBefore?.version?.label, qBefore?.version?.label]).toEqual(['Tinh P', 'Tinh Q']);
      expect([pBefore?.structureDate, qBefore?.structureDate]).toEqual(['2020-01-01', '2020-01-01']);
      expect(pBefore?.targets.map((target) => target.businessKey)).toEqual(['TINH-P']);
      expect(qBefore?.targets.map((target) => target.businessKey)).toEqual(['TINH-Q']);

      const pAfter = await asOf(keep.recordId, REFORM);
      const qAfter = await asOf(absorbed.recordId, REFORM);
      expect(pAfter).toMatchObject({ state: 'IN_FORCE', structureDate: REFORM, version: { label: 'Tinh P moi', revision: 2 } });
      expect(pAfter?.predecessors.map((edge) => edge.predecessorKey)).toEqual(['TINH-Q']);
      expect(qAfter).toMatchObject({ state: 'SUCCEEDED', structureDate: REFORM });
      // Both provinces convert to the one province of the new structure.
      expect(qAfter?.targets.map((target) => [target.businessKey, target.version?.label])).toEqual([['TINH-P', 'Tinh P moi']]);
      expect(pAfter?.targets.map((target) => target.businessKey)).toEqual(['TINH-P']);
    });
  });

  describe('a cycle and the shares of a split', () => {
    it('refuses a succession that would make a ring, and a split whose shares do not add up to 100 (AC-ST-MDM-009-3, UAT-PLAN-55)', async () => {
      const first = await area();
      const second = await area();
      await succeed(first, second);
      // The entry that took over cannot hand back to the one it took over from, nor to itself.
      expect(await refusal(record(input(second.recordId, first.recordId, { effectiveDate: '2025-08-01' })))).toEqual({ code: 'SUCCESSION_CYCLE', status: 422 });
      expect(await refusal(record(input(second.recordId, second.recordId, { effectiveDate: '2025-08-01' })))).toEqual({ code: 'SUCCESSION_CYCLE', status: 422 });
      // A ring through a request that is still waiting is a ring too.
      const third = await area();
      const fourth = await area();
      await record(input(third.recordId, fourth.recordId));
      expect(await refusal(record(input(fourth.recordId, third.recordId, { effectiveDate: '2025-08-01' })))).toEqual({ code: 'SUCCESSION_CYCLE', status: 422 });
      // ... and through a longer chain.
      const fifth = await area();
      const sixth = await area();
      await succeed(fifth, sixth);
      const seventh = await area();
      await succeed(sixth, seventh, { effectiveDate: '2025-09-01' });
      expect(await refusal(record(input(seventh.recordId, fifth.recordId, { effectiveDate: '2025-10-01' })))).toEqual({ code: 'SUCCESSION_CYCLE', status: 422 });

      // A split of 60 and 30 is refused when it goes to review; 60 and 50 is refused as soon as the second share is written.
      const source = await area();
      const left = await area();
      const right = await area();
      const open = await record(input(source.recordId, left.recordId, { kind: 'SPLIT', sharePct: '60' }));
      expect(open).toMatchObject({ version: 1, edges: 1 });
      expect(await refusal(record(input(source.recordId, right.recordId, { kind: 'SPLIT', sharePct: '50' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'share_pct' });
      const second30 = await record(input(source.recordId, right.recordId, { kind: 'SPLIT', sharePct: '30.00' }));
      expect(second30).toMatchObject({ changeRequestId: open.changeRequestId, version: 2, edges: 2 });
      expect(await refusal(as(STEWARD, (tx) => masters.submit(tx, open.changeRequestId, 2, memberId(STEWARD))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'share_pct' });
      // Adding the missing 10 makes it whole; it is put in force with the shares as written.
      const third10 = await area();
      const whole = await record(input(source.recordId, third10.recordId, { kind: 'SPLIT', sharePct: '10' }));
      await putInForce(source.recordId, whole.changeRequestId, whole.version);
      const stored = await owner<{ successor: string; share_pct: string }>(
        `select q.business_key as successor, s.share_pct::text from machvon.master_succession s join machvon.master_record q on q.id = s.successor_record_id
          where s.predecessor_record_id = $1::uuid order by s.share_pct desc`,
        [source.recordId],
      );
      expect(stored.map((row) => row.share_pct)).toEqual(['60.00', '30.00', '10.00']);
      expect(stored).toHaveLength(3);
    });
  });

  describe('rules of an edge', () => {
    it('allows a share only on a split, and a split only with one', async () => {
      const a = await area();
      const b = await area();
      expect(await refusal(record(input(a.recordId, b.recordId, { kind: 'MERGE', sharePct: '50' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'share_pct' });
      expect(await refusal(record(input(a.recordId, b.recordId, { kind: 'SPLIT' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'share_pct' });
      for (const bad of ['0', '100', '-5', '12.345', 'abc', '']) {
        expect(await refusal(record(input(a.recordId, b.recordId, { kind: 'SPLIT', sharePct: bad })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'share_pct' });
      }
      expect(await refusal(record(input(a.recordId, b.recordId, { legalBasis: ' x ' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'legal_basis' });
      expect(await refusal(record(input(a.recordId, b.recordId, { reason: 'no' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(record(input(a.recordId, b.recordId, { kind: 'WRONG' as never })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'succession_kind' });
    });

    it('needs entries that exist, of the same type, the predecessor the tenant\'s own and the successor in force on the date', async () => {
      const a = await area();
      const agency = await inForce('AGENCY', nextKey('AG'));
      const draft = await as(STEWARD, (tx) =>
        masters.propose(tx, { masterType: 'AREA', businessKey: nextKey('DRAFT'), content: content(), reason: 'Initial catalogue entry' }, memberId(STEWARD)),
      );
      const late = await area(nextKey('LATE'), { validFrom: '2026-01-01' });
      const b = await area();
      expect(await refusal(record(input(randomUUID(), b.recordId)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(record(input(a.recordId, randomUUID())))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'successor_record_id' });
      expect(await refusal(record(input(a.recordId, agency.recordId)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'successor_record_id' });
      expect(await refusal(record(input(a.recordId, draft.recordId)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'successor_record_id' });
      // The successor has to be in force on the date the predecessor hands over.
      expect(await refusal(record(input(a.recordId, late.recordId)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'successor_record_id' });
      // The predecessor exists in the tenant's namespace and is not still a draft.
      expect(await refusal(record(input(draft.recordId, b.recordId)))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'DRAFT->SUCCESSION' });
      await owner("update machvon.master_record set namespace = 'PLATFORM' where id = $1::uuid", [a.recordId]);
      expect(await refusal(record(input(a.recordId, b.recordId)))).toEqual({ code: 'POLICY_LOCKED', status: 403 });
      await owner("update machvon.master_record set namespace = 'TENANT' where id = $1::uuid", [a.recordId]);
      // An entry of another tenant is not there.
      expect(await refusal(record(input(a.recordId, b.recordId), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('needs a date after the predecessor began and not after it ended, and after the predecessor itself arrived', async () => {
      const a = await area();
      const b = await area();
      expect(await refusal(record(input(a.recordId, b.recordId, { effectiveDate: '2020-01-01' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_date' });
      const ended = await area(nextKey('END'), { validUntil: '2024-12-31' });
      expect(await refusal(record(input(ended.recordId, b.recordId)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_date' });
      // c arrives on 2025-07-01 (a hands over to it): it cannot hand over to d on an earlier date.
      const c = await area();
      const d = await area();
      await succeed(a, c);
      expect(await refusal(record(input(c.recordId, d.recordId, { effectiveDate: '2025-06-15' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_date' });
    });

    it('lets only a draft split take another successor, and one open request at a time', async () => {
      const a = await area();
      const b = await area();
      const c = await area();
      const first = await record(input(a.recordId, b.recordId, { kind: 'SPLIT', sharePct: '40' }));
      expect(await refusal(record(input(a.recordId, b.recordId, { kind: 'SPLIT', sharePct: '10' })))).toEqual({ code: 'DUPLICATE_KEY', status: 409 });
      expect(await refusal(record(input(a.recordId, c.recordId, { kind: 'SPLIT', sharePct: '10', effectiveDate: '2025-08-01' })))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'a change request is already open' });
      expect(await refusal(record(input(a.recordId, c.recordId, { kind: 'MERGE' })))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'a change request is already open' });
      expect(await refusal(record(input(a.recordId, c.recordId, { kind: 'SPLIT', sharePct: '10', legalBasis: 'Another decision' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'legal_basis' });
      // Once it is in review nothing is added to it.
      const second = await record(input(a.recordId, c.recordId, { kind: 'SPLIT', sharePct: '60' }));
      expect(second.changeRequestId).toBe(first.changeRequestId);
      await as(STEWARD, (tx) => masters.submit(tx, first.changeRequestId, second.version, memberId(STEWARD)));
      const d = await area();
      expect(await refusal(record(input(a.recordId, d.recordId, { kind: 'SPLIT', sharePct: '10' })))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'a change request is already open' });
    });
  });

  describe('four-eyes and publication', () => {
    it('is decided by someone other than the one who recorded it and published by a third person, and the impact names what refers to the entry', async () => {
      const a = await area();
      const b = await area();
      await admin([
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, sector_master_version_id, classification, total_investment_vnd, status, version)
           values ($1, $2, $3, 'Project', $4, $5, $6, 'INTERNAL', 1000, 'CONCEPT', 1)`,
          [TENANT_A, randomUUID(), nextKey('P'), id(0x10, 1), a.versionId, randomUUID()],
        ],
      ]);
      const recorded = await record(input(a.recordId, b.recordId));
      const detail = await as(STEWARD, (tx) => masters.findChangeDetail(tx, recorded.changeRequestId));
      expect(detail).toMatchObject({ changeKind: 'SUCCESSION', status: 'DRAFT', masterRecordId: a.recordId, effectiveFrom: REFORM, businessKey: a.key });
      expect(detail?.impact?.counts['project.area_master_version_id']).toBe(1);
      expect(proposalOf(detail?.proposed ?? {})).toEqual({ kind: 'MERGE', effectiveDate: REFORM, legalBasis: BASIS, edges: [{ successorRecordId: b.recordId, sharePct: null }] });

      const submitted = await as(STEWARD, (tx) => masters.submit(tx, recorded.changeRequestId, recorded.version, memberId(STEWARD)));
      expect(await refusal(as(STEWARD, (tx) => masters.decide(tx, recorded.changeRequestId, submitted.version, 'approve', memberId(STEWARD))))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      await as(CHECKER, (tx) => masters.decide(tx, recorded.changeRequestId, submitted.version, 'approve', memberId(CHECKER)));
      const found = await as(STEWARD, (tx) => masters.findRecord(tx, a.recordId));
      expect(await refusal(as(STEWARD, (tx) => masters.publish(tx, a.recordId, found?.version ?? 0, DECISION_DOCUMENT, memberId(STEWARD))))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      // Nothing is a fact before the publication.
      expect(await as(STEWARD, (tx) => successions.reachable(tx, a.recordId, TODAY))).toEqual([]);
      const published = await as(PUBLISHER, (tx) => masters.publish(tx, a.recordId, found?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)));
      expect(published).toMatchObject({ active: true, record: { status: 'RETIRED' }, change: { changeKind: 'SUCCESSION' } });
      const edges = await as(STEWARD, (tx) => successions.reachable(tx, a.recordId, TODAY));
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ predecessorKey: a.key, successorKey: b.key, kind: 'MERGE', effectiveDate: REFORM, sharePct: null, legalBasis: BASIS, changeRequestId: recorded.changeRequestId });
    });

    it('revalidates when the request is published: a ring made meanwhile, or a successor that has gone, stops it', async () => {
      const a = await area();
      const b = await area();
      const waiting = await record(input(a.recordId, b.recordId));
      const submitted = await as(STEWARD, (tx) => masters.submit(tx, waiting.changeRequestId, waiting.version, memberId(STEWARD)));
      await as(CHECKER, (tx) => masters.decide(tx, waiting.changeRequestId, submitted.version, 'approve', memberId(CHECKER)));
      // b hands over to a while a's request waits: the pending edge a->b is already in the graph, so this is refused.
      expect(await refusal(record(input(b.recordId, a.recordId, { effectiveDate: '2025-08-01' })))).toEqual({ code: 'SUCCESSION_CYCLE', status: 422 });
      // A ring planted behind the application's back is found by the publication.
      await owner(
        `insert into machvon.master_succession (tenant_id, id, predecessor_record_id, successor_record_id, succession_kind, effective_date, legal_basis, change_request_id, created_by, updated_by)
         values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 'MERGE', '2025-08-01', 'planted', $4::uuid, $5, $5)`,
        [TENANT_A, b.recordId, a.recordId, waiting.changeRequestId, memberId(STEWARD)],
      );
      const found = await as(PUBLISHER, (tx) => masters.findRecord(tx, a.recordId));
      expect(await refusal(as(PUBLISHER, (tx) => masters.publish(tx, a.recordId, found?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER))))).toEqual({ code: 'SUCCESSION_CYCLE', status: 422 });
      expect(await as(STEWARD, (tx) => masters.findRecord(tx, a.recordId))).toMatchObject({ status: 'EFFECTIVE' });
    });

    it('refuses to put an edge in force that already exists, as 409 DUPLICATE_KEY, and writes nothing of the request', async () => {
      const a = await area();
      const b = await area();
      const waiting = await record(input(a.recordId, b.recordId));
      await owner(
        `insert into machvon.master_succession (tenant_id, id, predecessor_record_id, successor_record_id, succession_kind, effective_date, legal_basis, change_request_id, created_by, updated_by)
         values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 'MERGE', '2025-07-01', 'planted', $4::uuid, $5, $5)`,
        [TENANT_A, a.recordId, b.recordId, waiting.changeRequestId, memberId(STEWARD)],
      );
      await expect(putInForce(a.recordId, waiting.changeRequestId, waiting.version)).rejects.toMatchObject({ code: 'DUPLICATE_KEY', status: 409 });
      expect(await as(STEWARD, (tx) => masters.findRecord(tx, a.recordId))).toMatchObject({ status: 'EFFECTIVE' });
    });

    it('closes the version on a date to come and leaves the entry in force until then', async () => {
      const a = await area();
      const b = await area(nextKey('B'), { validFrom: '2020-01-01' });
      await succeed(a, b, { effectiveDate: FUTURE });
      expect(await as(STEWARD, (tx) => masters.findRecord(tx, a.recordId))).toMatchObject({ status: 'EFFECTIVE' });
      expect((await asOf(a.recordId, TODAY))?.state).toBe('IN_FORCE');
      expect((await asOf(a.recordId, FUTURE))?.state).toBe('SUCCEEDED');
      expect((await asOf(a.recordId, FUTURE))?.targets.map((target) => target.businessKey)).toEqual([b.key]);
      // A later change of the entry waits for the date, as a retirement does.
      expect(await refusal(as(STEWARD, (tx) => masters.createChange(tx, { kind: 'UPDATE', masterType: 'AREA', masterRecordId: a.recordId, proposed: { label: 'x' }, effectiveFrom: '2998-01-01', reason: 'Rename before the date' }, memberId(STEWARD))))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
    });
  });

  describe('reading a structure', () => {
    it('multiplies the shares along a chain of splits and adds the paths that meet', async () => {
      const whole = await area();
      const left = await area();
      const right = await area();
      // A split is recorded edge by edge and put in force once whole.
      await record(input(whole.recordId, left.recordId, { kind: 'SPLIT', sharePct: '60' }));
      const split = await record(input(whole.recordId, right.recordId, { kind: 'SPLIT', sharePct: '40' }));
      await putInForce(whole.recordId, split.changeRequestId, split.version);
      const leftA = await area();
      const leftB = await area();
      await record(input(left.recordId, leftA.recordId, { kind: 'SPLIT', sharePct: '50', effectiveDate: '2025-08-01' }));
      const leftSplit = await record(input(left.recordId, leftB.recordId, { kind: 'SPLIT', sharePct: '50', effectiveDate: '2025-08-01' }));
      await putInForce(left.recordId, leftSplit.changeRequestId, leftSplit.version);
      // The right half and one half of the left merge into one entry later: that entry meets two paths.
      const merged = await area();
      await succeed(right, merged, { effectiveDate: '2025-09-01' });
      await succeed(leftA, merged, { effectiveDate: '2025-09-01' });

      const early = await successorsOf(whole.recordId, REFORM);
      expect(early?.targets.map((target) => [target.businessKey, target.sharePct]).sort()).toEqual([[left.key, '60.00'], [right.key, '40.00']].sort());
      const late = await successorsOf(whole.recordId, '2025-09-01');
      expect(late?.targets.map((target) => [target.businessKey, target.sharePct]).sort()).toEqual([[leftB.key, '30.00'], [merged.key, '70.00']].sort());
      expect(late?.edges.length).toBe(6);
      // The conversion is bounded by the date: before the second split only the first one counts.
      expect((await successorsOf(whole.recordId, '2025-07-31'))?.targets.map((target) => target.businessKey).sort()).toEqual([left.key, right.key].sort());
      // An entry names the edges that leave it, not the ones further down the chain.
      expect((await asOf(whole.recordId, '2025-09-01'))?.successors.map((edge) => edge.kind)).toEqual(['SPLIT', 'SPLIT']);
    });

    it('tells an entry that never began, one that ended without a successor and one that does not exist', async () => {
      const retired = await area(nextKey('GONE'), { validUntil: '2024-12-31' });
      const later = await area(nextKey('LATER'), { validFrom: FUTURE });
      expect((await asOf(retired.recordId, TODAY))?.state).toBe('ENDED');
      expect((await asOf(retired.recordId, '2023-01-01'))?.state).toBe('IN_FORCE');
      expect((await asOf(later.recordId, TODAY))?.state).toBe('NOT_STARTED');
      expect((await asOf(later.recordId, TODAY))?.targets.map((target) => target.businessKey)).toEqual([later.key]);
      expect(await asOf(randomUUID(), TODAY)).toBeUndefined();
      expect(await successorsOf(randomUUID(), TODAY)).toBeUndefined();
      expect(await asOf(retired.recordId, TODAY, TENANT_B)).toBeUndefined();
    });
  });

  describe('what the database holds', () => {
    it('does not let the runtime role change or remove an edge', async () => {
      const a = await area();
      const b = await area();
      await succeed(a, b);
      await expect(as(STEWARD, (tx) => tx.query('delete from machvon.master_succession where predecessor_record_id = $1::uuid', [a.recordId]))).rejects.toMatchObject({ code: '42501' });
      await expect(as(STEWARD, (tx) => tx.query("update machvon.master_succession set legal_basis = 'rewritten' where predecessor_record_id = $1::uuid", [a.recordId]))).rejects.toMatchObject({ code: '42501' });
      expect(await owner<{ legal_basis: string }>('select legal_basis from machvon.master_succession where predecessor_record_id = $1::uuid', [a.recordId])).toEqual([{ legal_basis: BASIS }]);
    });

    it('refuses a share on a kind that has none, a split without one, a second kind on the same date and a split that does not add up', async () => {
      const a = await area();
      const b = await area();
      const c = await area();
      const request = await record(input(a.recordId, b.recordId));
      const insert = (kind: string, share: string | null, successor: string, predecessor = a.recordId) =>
        owner(
          `insert into machvon.master_succession (tenant_id, id, predecessor_record_id, successor_record_id, succession_kind, effective_date, share_pct, legal_basis, change_request_id, created_by, updated_by)
           values ($1, gen_random_uuid(), $2::uuid, $3::uuid, $4, '2025-07-01', $5::numeric, 'direct', $6::uuid, $7, $7)`,
          [TENANT_A, predecessor, successor, kind, share, request.changeRequestId, memberId(STEWARD)],
        );
      await expect(insert('MERGE', '50', b.recordId)).rejects.toMatchObject({ constraint: 'master_succession_share_kind_chk' });
      await expect(insert('SPLIT', null, b.recordId)).rejects.toMatchObject({ constraint: 'master_succession_share_kind_chk' });
      await expect(insert('SPLIT', '100', b.recordId)).rejects.toMatchObject({ constraint: 'master_succession_share_range_chk' });
      await insert('MERGE', null, b.recordId);
      await expect(insert('MERGE', null, c.recordId)).rejects.toMatchObject({ constraint: 'master_succession_single_uq' });
      await expect(insert('SPLIT', '50', c.recordId)).rejects.toMatchObject({ message: expect.stringContaining('one kind of succession') });
      // A split of 50 alone is judged when the transaction ends.
      const d = await area();
      const e = await area();
      await expect(insert('SPLIT', '50', e.recordId, d.recordId)).rejects.toMatchObject({ message: expect.stringContaining('add up to 100') });
    });
  });

  describe('the proposal as data', () => {
    it('writes a proposal the way it reads it back, and reads shares without a float', () => {
      const proposal = { kind: 'SPLIT' as const, effectiveDate: REFORM, legalBasis: BASIS, edges: [{ successorRecordId: randomUUID(), sharePct: '33.30' }, { successorRecordId: randomUUID(), sharePct: '66.70' }] };
      expect(proposalOf(proposedJsonOf(proposal))).toEqual(proposal);
      expect(() => assertComplete(proposal)).not.toThrow();
      expect(shareHundredths('0.07')).toBe(7);
      expect(shareHundredths('99.99')).toBe(9999);
      expect(shareText(7)).toBe('0.07');
      expect(shareText(10000)).toBe('100.00');
      expect(() => proposalOf({})).toThrow();
      expect(() => proposalOf({ succession_kind: 'MERGE', effective_date: REFORM, legal_basis: 'x', edges: [{ successor_record_id: 1, share_pct: null }] })).toThrow();
      expect(() => assertComplete({ ...proposal, edges: [proposal.edges[0] as (typeof proposal.edges)[0], proposal.edges[0] as (typeof proposal.edges)[0]] })).toThrow();
      expect(() => assertComplete({ ...proposal, kind: 'MERGE' })).toThrow();
    });
  });
});
