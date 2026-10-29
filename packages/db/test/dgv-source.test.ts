import { randomUUID } from 'node:crypto';
import { DgvDatasetStore } from '../src/dgv-dataset-store';
import type { DatasetViewer } from '../src/dgv-dataset-store';
import { DgvIncidentStore } from '../src/dgv-incident-store';
import { DgvMappingStore, DgvReconciliationStore } from '../src/dgv-source-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';
import { dropSnapshotFixtureKeys, seedSnapshot } from './support/dgv-quality-fixtures';

const harness = new AuthzHarness();
const datasets = new DgvDatasetStore();
const mappings = new DgvMappingStore();
const recons = new DgvReconciliationStore();
const incidents = new DgvIncidentStore();
const STEWARD = 1;
const OWNER = 2;
const READER = 3;
const OTHER_TENANT_MEMBER = 4;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = STEWARD, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
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

async function newDataset(extra: { allowedRoles?: string[] } = {}): Promise<{ id: string; code: string }> {
  counter += 1;
  const code = `DS-SRC-${counter}-${randomUUID().slice(0, 5)}`.toUpperCase();
  const created = await as((tx) =>
    datasets.register(
      tx,
      { datasetCode: code, title: `Source dataset ${counter}`, domain: 'DISBURSEMENT', grain: 'one row per project', producerModule: 'DIS', ownerId: memberId(OWNER), stewardId: memberId(STEWARD), classification: 'INTERNAL', isCritical: true, freshnessSloSeconds: 86_400 },
      memberId(STEWARD),
    ),
  );
  if (extra.allowedRoles !== undefined) await owner('update machvon.dataset set allowed_role_codes = $2 where id = $1', [created.id, extra.allowedRoles]);
  return { id: created.id, code };
}

const proposal = (datasetId: string, extra: Partial<{ sourceSystem: string; sourceField: string; targetField: string; unit: string | undefined; transformRule: string | undefined }> = {}) => ({
  datasetId,
  sourceSystem: 'PAY',
  sourceField: 'so_tien',
  targetField: 'amount_vnd',
  transformRule: undefined as string | undefined,
  unit: 'triệu đồng' as string | undefined,
  ...extra,
});

const SETUP = async (): Promise<void> => {
  await harness.start();
  for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
  for (const member of [STEWARD, OWNER, READER]) await harness.seedMembership(TENANT_A, member, 1);
  await harness.seedMembership(TENANT_B, OTHER_TENANT_MEMBER, 1);
  await dropSnapshotFixtureKeys(harness, TENANT_A);
  // A period of the fixtures needs no calendar of the master data behind it.
  await harness.owner(TENANT_A, [['alter table machvon.reporting_period drop constraint reporting_period_calendar_version_fk']]);
};

beforeAll(SETUP, 180_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

describe('source mappings and the gate of a batch (ST-DGV-004)', () => {
  describe('a mapping (proposeSourceMapping, decideSourceMapping)', () => {
    it('is proposed in a unit the system knows, waits for somebody else and is confirmed at the version read', async () => {
      const dataset = await newDataset();
      const created = await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id)));
      const proposed = await as((tx) => mappings.find(tx, created.id, viewer(STEWARD)));
      expect(proposed).toMatchObject({ status: 'PROPOSED', version: 1, unit: 'triệu đồng', proposedBy: memberId(STEWARD), decidedBy: null, datasetCode: dataset.code });
      // The pipeline reads nothing from a mapping that is only proposed.
      expect(await as((tx) => mappings.confirmedFor(tx, dataset.id, 'PAY'))).toEqual([]);
      const at = new Date('2026-10-20T03:00:00Z');
      const decided = await as((tx) => mappings.decide(tx, viewer(OWNER), { id: created.id, expectedVersion: 1, decision: 'CONFIRMED', note: 'đơn vị đã kiểm với KBNN', at }), OWNER);
      expect(decided).toMatchObject({ status: 'CONFIRMED', version: 2, decidedBy: memberId(OWNER), decisionNote: 'đơn vị đã kiểm với KBNN' });
      expect(await owner('select status, decided_by, confirmed_by, decided_at = $2::timestamptz as at_ok, version::text from machvon.dataset_source_mapping where id = $1', [created.id, at.toISOString()])).toEqual([
        { status: 'CONFIRMED', decided_by: memberId(OWNER), confirmed_by: memberId(OWNER), at_ok: true, version: '2' },
      ]);
      expect(await as((tx) => mappings.confirmedFor(tx, dataset.id, 'PAY'))).toEqual([{ id: created.id, sourceField: 'so_tien', targetField: 'amount_vnd', unit: 'triệu đồng' }]);
    });

    it('refuses a unit it does not know, a duplicate that is live, a dataset the proposer may not see, and lets a rejected one be proposed again', async () => {
      const dataset = await newDataset();
      expect(await refusal(as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id, { unit: 'đô la' }))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'unit' });
      const first = await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id)));
      expect(await refusal(as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id))))).toEqual({ code: 'MAPPING_DUPLICATE', status: 409, detail: 'target_field' });
      // The same field into another field of the dataset is another mapping.
      await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id, { targetField: 'amount_original' })));
      await as((tx) => mappings.decide(tx, viewer(OWNER), { id: first.id, expectedVersion: 1, decision: 'REJECTED', note: undefined, at: new Date() }), OWNER);
      const again = await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id)));
      expect(again.id).not.toBe(first.id);
      const hidden = await newDataset({ allowedRoles: ['SOME_OTHER_ROLE'] });
      expect(await refusal(as((tx) => mappings.propose(tx, viewer(READER), proposal(hidden.id)), READER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(randomUUID()))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('is changed by proposing another for the same fields: confirming it retires the old one, so the pipeline reads one', async () => {
      const dataset = await newDataset();
      const old = await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id)));
      const at = new Date();
      await as((tx) => mappings.decide(tx, viewer(OWNER), { id: old.id, expectedVersion: 1, decision: 'CONFIRMED', note: undefined, at }), OWNER);
      // The same thing again is nothing new; another unit is a correction.
      expect(await refusal(as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id))))).toMatchObject({ code: 'MAPPING_DUPLICATE', status: 409 });
      const fixed = await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id, { unit: 'tỷ đồng' })));
      expect(await refusal(as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id, { unit: 'nghìn đồng' }))))).toMatchObject({ code: 'MAPPING_DUPLICATE', status: 409 });
      // Until it is confirmed the old one is in force.
      expect((await as((tx) => mappings.confirmedFor(tx, dataset.id, 'PAY'))).map((entry) => entry.id)).toEqual([old.id]);
      const decided = await as((tx) => mappings.decide(tx, viewer(OWNER), { id: fixed.id, expectedVersion: 1, decision: 'CONFIRMED', note: undefined, at }), OWNER);
      expect(decided.retiredIds).toEqual([old.id]);
      expect(await as((tx) => mappings.confirmedFor(tx, dataset.id, 'PAY'))).toEqual([{ id: fixed.id, sourceField: 'so_tien', targetField: 'amount_vnd', unit: 'tỷ đồng' }]);
      expect(await as((tx) => mappings.find(tx, old.id, viewer(STEWARD)))).toMatchObject({ status: 'RETIRED', version: 3, decidedBy: memberId(OWNER) });
      // A retired mapping stays retired.
      await expect(owner("update machvon.dataset_source_mapping set status = 'CONFIRMED' where id = $1", [old.id])).rejects.toThrow(/does not go from RETIRED to CONFIRMED/);
    });

    it('is not confirmed by the one who proposed it, at a stale version, twice, or by a reader who may not see the dataset', async () => {
      const dataset = await newDataset();
      const created = await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id)));
      const at = new Date();
      expect(await refusal(as((tx) => mappings.decide(tx, viewer(STEWARD), { id: created.id, expectedVersion: 1, decision: 'CONFIRMED', note: undefined, at })))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => mappings.decide(tx, viewer(OWNER), { id: created.id, expectedVersion: 7, decision: 'CONFIRMED', note: undefined, at }), OWNER))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => mappings.decide(tx, viewer(OWNER), { id: randomUUID(), expectedVersion: 1, decision: 'CONFIRMED', note: undefined, at }), OWNER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await as((tx) => mappings.decide(tx, viewer(OWNER), { id: created.id, expectedVersion: 1, decision: 'CONFIRMED', note: undefined, at }), OWNER);
      expect(await refusal(as((tx) => mappings.decide(tx, viewer(OWNER), { id: created.id, expectedVersion: 2, decision: 'REJECTED', note: undefined, at }), OWNER))).toEqual({ code: 'MAPPING_STATE_INVALID', status: 409, detail: 'status' });
      const hidden = await newDataset({ allowedRoles: ['SOME_OTHER_ROLE'] });
      const other = await as((tx) => mappings.propose(tx, viewer(STEWARD, 'SOME_OTHER_ROLE'), proposal(hidden.id)));
      expect(await refusal(as((tx) => mappings.decide(tx, viewer(READER), { id: other.id, expectedVersion: 1, decision: 'CONFIRMED', note: undefined, at }), READER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('is kept as it was written: what it says is not changed, a decision is written once, nothing is deleted, a tenant does not see another', async () => {
      const dataset = await newDataset();
      const created = await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id)));
      await as((tx) => mappings.decide(tx, viewer(OWNER), { id: created.id, expectedVersion: 1, decision: 'CONFIRMED', note: undefined, at: new Date() }), OWNER);
      await expect(owner("update machvon.dataset_source_mapping set unit = 'VND' where id = $1", [created.id])).rejects.toThrow(/not changed/);
      await expect(owner("update machvon.dataset_source_mapping set status = 'PROPOSED', decided_by = null where id = $1", [created.id])).rejects.toThrow(/does not go from CONFIRMED to PROPOSED/);
      await expect(owner("update machvon.dataset_source_mapping set decision_note = 'x' where id = $1", [created.id])).rejects.toThrow(/written once/);
      await expect(as((tx) => tx.query('delete from machvon.dataset_source_mapping where id = $1', [created.id]))).rejects.toThrow();
      expect(await as((tx) => mappings.find(tx, created.id, viewer(OTHER_TENANT_MEMBER)), OTHER_TENANT_MEMBER, TENANT_B)).toBeUndefined();
    });

    it('is listed newest first, by dataset, status and source, only for the datasets the viewer may see, a page at a time', async () => {
      const dataset = await newDataset();
      const ids: string[] = [];
      for (const field of ['a', 'b', 'c']) ids.push((await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id, { sourceField: field })))).id);
      await as((tx) => mappings.decide(tx, viewer(OWNER), { id: ids[0] as string, expectedVersion: 1, decision: 'CONFIRMED', note: undefined, at: new Date() }), OWNER);
      const all = await as((tx) => mappings.list(tx, viewer(STEWARD), { datasetId: dataset.id }, { limit: 10, after: undefined }));
      expect(all.map((row) => row.id)).toEqual([ids[2], ids[1], ids[0]]);
      expect((await as((tx) => mappings.list(tx, viewer(STEWARD), { datasetId: dataset.id, status: 'CONFIRMED' }, { limit: 10, after: undefined }))).map((row) => row.id)).toEqual([ids[0]]);
      expect(await as((tx) => mappings.list(tx, viewer(STEWARD), { datasetId: dataset.id, sourceSystem: 'DIS' }, { limit: 10, after: undefined }))).toEqual([]);
      const first = await as((tx) => mappings.list(tx, viewer(STEWARD), { datasetId: dataset.id }, { limit: 2, after: undefined }));
      const next = await as((tx) => mappings.list(tx, viewer(STEWARD), { datasetId: dataset.id }, { limit: 2, after: { code: (first[1] as { sortKey: string }).sortKey, id: (first[1] as { id: string }).id } }));
      expect(next.map((row) => row.id)).toEqual([ids[0]]);
      const hidden = await newDataset({ allowedRoles: ['SOME_OTHER_ROLE'] });
      await as((tx) => mappings.propose(tx, viewer(STEWARD, 'SOME_OTHER_ROLE'), proposal(hidden.id)));
      expect(await as((tx) => mappings.list(tx, viewer(READER), { datasetId: hidden.id }, { limit: 10, after: undefined }), READER)).toEqual([]);
    });
  });

  describe('the gate of a batch', () => {
    it('AC-ST-DGV-004-2, UAT-AC491: keeps a batch out in quarantine while a field has no confirmed mapping, naming it, then applies it with the factor of the unit once it is confirmed', async () => {
      const dataset = await newDataset();
      const batch = { datasetId: dataset.id, sourceSystem: 'PAY', batchRef: `B-${randomUUID().slice(0, 6)}`, rowCount: 120, sourceFields: ['so_tien', 'ma_du_an'], actor: memberId(STEWARD) };
      const kept = await as((tx) => mappings.gate(tx, batch));
      expect(kept).toMatchObject({ outcome: 'QUARANTINED', reason: 'MAPPING_NOT_CONFIRMED', missing: ['so_tien', 'ma_du_an'] });
      const amount = await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id)));
      // A mapping that is only proposed does not let the batch through.
      expect((await as((tx) => mappings.gate(tx, { ...batch, batchRef: `${batch.batchRef}-2` }))).outcome).toBe('QUARANTINED');
      await as((tx) => mappings.decide(tx, viewer(OWNER), { id: amount.id, expectedVersion: 1, decision: 'CONFIRMED', note: undefined, at: new Date() }), OWNER);
      const project = await as((tx) => mappings.propose(tx, viewer(STEWARD), proposal(dataset.id, { sourceField: 'ma_du_an', targetField: 'project_code', unit: undefined })));
      await as((tx) => mappings.decide(tx, viewer(OWNER), { id: project.id, expectedVersion: 1, decision: 'CONFIRMED', note: undefined, at: new Date() }), OWNER);
      const applied = await as((tx) => mappings.gate(tx, { ...batch, batchRef: `${batch.batchRef}-3` }));
      expect(applied).toMatchObject({ outcome: 'APPLIED', fields: [{ sourceField: 'so_tien', targetField: 'amount_vnd', factor: 1_000_000n }, { sourceField: 'ma_du_an', targetField: 'project_code', factor: 1n }] });
      const gates = await as((tx) => mappings.listGates(tx, viewer(STEWARD), { datasetId: dataset.id }, { limit: 10, after: undefined }));
      expect(gates.map((gate) => [gate.batchRef, gate.outcome, gate.reason, gate.rowCount])).toEqual([
        [`${batch.batchRef}-3`, 'APPLIED', null, 120],
        [`${batch.batchRef}-2`, 'QUARANTINED', 'MAPPING_NOT_CONFIRMED', 120],
        [batch.batchRef, 'QUARANTINED', 'MAPPING_NOT_CONFIRMED', 120],
      ]);
      expect((await as((tx) => mappings.listGates(tx, viewer(STEWARD), { datasetId: dataset.id, outcome: 'APPLIED' }, { limit: 10, after: undefined }))).map((gate) => gate.outcome)).toEqual(['APPLIED']);
      // What happened to a batch is written once.
      await expect(as((tx) => tx.query("update machvon.dataset_batch_gate set outcome = 'APPLIED', reason = null where id = $1", [kept.gateId]))).rejects.toThrow();
      await expect(as((tx) => tx.query('delete from machvon.dataset_batch_gate where id = $1', [kept.gateId]))).rejects.toThrow();
      // A dataset the viewer may not see has no gates for them.
      const hidden = await newDataset({ allowedRoles: ['SOME_OTHER_ROLE'] });
      await as((tx) => mappings.gate(tx, { ...batch, datasetId: hidden.id }));
      expect(await as((tx) => mappings.listGates(tx, viewer(READER), { datasetId: hidden.id }, { limit: 10, after: undefined }), READER)).toEqual([]);
    });
  });
});

describe('the reconciliation of the Treasury with the accepted report (ST-DGV-004)', () => {
  const PERIOD = '2026-06';
  const CUTOFF = '2026-06-25';
  const projects: string[] = [];

  interface Seeded {
    snapshotId: string;
    projectIds: string[];
  }

  /** A closed month: a frozen snapshot of the period with one line per project, reporting what each project disbursed; the cut-off of the Treasury is 25 June. */
  async function closedMonth(reported: Array<string | null>, period = PERIOD): Promise<Seeded> {
    const periodId = randomUUID();
    const snapshot = await seedSnapshot(harness, TENANT_A, STEWARD, { status: 'BUILDING', lines: reported.map(() => ({ ctmtqg: '0' })) });
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, ($4::date + interval '1 month - 1 day')::date, now(), 'CAL-N', 'MONTH', 2026, 'OPEN', gen_random_uuid(), $5, $5)`,
        [TENANT_A, periodId, period, `${period}-01`, memberId(STEWARD)],
      ],
      // The snapshot is born with a period of its own and today as the cut-off; the guard that keeps them is off for this one statement.
      ['alter table machvon.period_snapshot disable trigger period_snapshot_guard'],
      ['update machvon.period_snapshot set period_id = $2, treasury_cutoff_date = $3::date where id = $1', [snapshot.id, periodId, CUTOFF]],
      ['alter table machvon.period_snapshot enable trigger period_snapshot_guard'],
    ]);
    for (const [n, projectId] of snapshot.projectIds.entries()) {
      await harness.owner(TENANT_A, [
        ['alter table machvon.period_snapshot_line disable trigger period_snapshot_line_guard'],
        ['update machvon.period_snapshot_line set disbursed_reported_vnd = $2::numeric where snapshot_id = $1 and project_id = $3', [snapshot.id, reported[n], projectId]],
        ['alter table machvon.period_snapshot_line enable trigger period_snapshot_line_guard'],
      ]);
    }
    await harness.owner(TENANT_A, [["update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('c', 64), frozen_by = $2, frozen_at = now() where id = $1", [snapshot.id, memberId(STEWARD)]]]);
    projects.push(...snapshot.projectIds);
    return { snapshotId: snapshot.id, projectIds: snapshot.projectIds };
  }

  /** A payment the Treasury confirmed (or, with `refundOf`, a refund of an earlier one); returns its id. */
  async function paid(projectId: string, amount: string, at: string, refundOf: string | null = null): Promise<string> {
    const id = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, source_kind, provider_event_id, direction, reversal_of_id)
         values ($1, $2, $3, $4, 'TREASURY', $5::numeric, $6::timestamptz, repeat('d', 64), 'CALLBACK_MOCK', $4, $7, $8)`,
        [TENANT_A, id, projectId, `EXT-${id}`, amount, at, refundOf === null ? 'PAYMENT' : 'REFUND', refundOf],
      ],
    ]);
    return id;
  }

  const request = (code: string, extra: Partial<{ sourceA: string; sourceB: string; asOfPeriod: string; basis: string; toleranceVnd: string; datasetId: string | undefined }> = {}) => ({
    reconCode: code,
    sourceA: 'PAY.treasury_transaction',
    sourceB: 'DIS.report_accepted',
    asOfPeriod: PERIOD,
    basis: 'VND, ngày Kho bạc thanh toán',
    toleranceVnd: '0',
    datasetId: undefined as string | undefined,
    at: new Date(),
    ...extra,
  });

  it('AC-ST-DGV-004-1, UAT-AC488: classifies each difference, keeps both totals apart, and opens one HIGH incident for the owner of the dataset', async () => {
    const dataset = await newDataset();
    // P0 agrees (130 million: 150 paid, 20 refunded); P1 differs in amount; P2 was paid after the cut-off of the report; P3 the Treasury never paid but the report says so; P4 is in the Treasury only.
    const month = await closedMonth(['130000000', '100000000', '0', '70000000', null]);
    const [p0, p1, p2, p3, p4] = month.projectIds as [string, string, string, string, string];
    const first = await paid(p0, '100000000', '2026-06-10T09:00:00+07:00');
    await paid(p0, '50000000', '2026-06-12T09:00:00+07:00');
    await paid(p0, '20000000', '2026-06-14T09:00:00+07:00', first);
    await paid(p1, '200000000', '2026-06-11T09:00:00+07:00');
    await paid(p2, '40000000', '2026-06-28T09:00:00+07:00');
    await paid(p4, '15000000', '2026-06-09T09:00:00+07:00');
    // A payment of July is not in the month.
    await paid(p0, '999', '2026-07-01T09:00:00+07:00');
    const recon = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-MONTH', { datasetId: dataset.id })));
    expect(recon).toMatchObject({ result: 'DIFFERENT', countA: 4, countB: 3, totalAVnd: '385000000', totalBVnd: '300000000', differenceVnd: '85000000', ownerId: memberId(OWNER), datasetId: dataset.id, asOfPeriod: PERIOD });
    const byKey = Object.fromEntries(recon.differences.map((entry) => [entry.key, entry]));
    expect(byKey[p1]).toMatchObject({ kind: 'AMOUNT', side: 'BOTH', amount_a_vnd: '200000000', amount_b_vnd: '100000000', difference_vnd: '100000000' });
    expect(byKey[p2]).toMatchObject({ kind: 'TIMING', side: 'BOTH', amount_a_vnd: '40000000', amount_b_vnd: '0' });
    expect(byKey[p3]).toMatchObject({ kind: 'MISSING', side: 'B_ONLY', difference_vnd: '-70000000' });
    expect(byKey[p4]).toMatchObject({ kind: 'MISSING', side: 'A_ONLY' });
    expect(byKey[p0]).toBeUndefined();
    expect(recon.byKind).toEqual({ MISSING: 2, TIMING: 1, REVERSAL: 0, MAPPING: 0, AMOUNT: 1 });
    // The incident: HIGH, 24 hours, the owner of the dataset, about the frozen report and this reconciliation.
    expect(recon.incidentId).not.toBeNull();
    expect(await owner('select severity, sla_hours, status, owner_id, rule_id, run_id, reconciliation_id, dataset_version_id, title from machvon.quality_incident where id = $1', [recon.incidentId])).toEqual([
      { severity: 'HIGH', sla_hours: 24, status: 'OPEN', owner_id: memberId(OWNER), rule_id: null, run_id: null, reconciliation_id: recon.id, dataset_version_id: month.snapshotId, title: `PAY-DIS-MONTH / ${PERIOD}` },
    ]);
    const seen = await as((tx) => incidents.find(tx, recon.incidentId as string, viewer(STEWARD)));
    expect(seen).toMatchObject({ ruleCode: 'PAY-DIS-MONTH', dimension: 'RECONCILIATION', runId: null, reconciliationId: recon.id, datasetId: dataset.id });
    // The stored figure is read back as it was.
    expect(await as((tx) => recons.find(tx, viewer(STEWARD), recon.id))).toMatchObject({ id: recon.id, result: 'DIFFERENT', totalAVnd: '385000000', incidentId: recon.incidentId, differencesTruncated: false });
    // The dataset counts the incident of a reconciliation as it counts the ones of a run, late ones included.
    expect(await as((tx) => datasets.find(tx, dataset.id, viewer(STEWARD)))).toMatchObject({ openIncidents: 1, overdueIncidents: 0 });
    await owner("update machvon.quality_incident set due_at = now() - interval '1 hour' where id = $1", [recon.incidentId]);
    expect(await as((tx) => datasets.find(tx, dataset.id, viewer(STEWARD)))).toMatchObject({ openIncidents: 1, overdueIncidents: 1 });
    await owner("update machvon.quality_incident set due_at = now() + interval '1 day' where id = $1", [recon.incidentId]);
    // The same difference again is the same problem: the open incident is reused.
    const again = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-MONTH', { datasetId: dataset.id })));
    expect(again.incidentId).toBe(recon.incidentId);
    expect(again.id).not.toBe(recon.id);
    expect(await owner('select count(*)::int as total from machvon.quality_incident where reconciliation_id is not null and id = $1', [recon.incidentId])).toEqual([{ total: 1 }]);
    // Another reconciliation code on the same month is another problem.
    const other = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-OTHER', { datasetId: dataset.id })));
    expect(other.incidentId).not.toBe(recon.incidentId);
  });

  it('is MATCHED with no incident when the two agree, and WITHIN_TOLERANCE when every project is on both sides within the tolerance', async () => {
    const dataset = await newDataset();
    const month = await closedMonth(['500', '1000'], '2026-05');
    const [a, b] = month.projectIds as [string, string];
    await paid(a, '500', '2026-05-10T09:00:00+07:00');
    await paid(b, '1000', '2026-05-11T09:00:00+07:00');
    const matched = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-MAY', { datasetId: dataset.id, asOfPeriod: '2026-05' })));
    expect(matched).toMatchObject({ result: 'MATCHED', incidentId: null, differences: [], differenceVnd: '0' });
    await paid(a, '3', '2026-05-12T09:00:00+07:00');
    const close = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-MAY', { datasetId: dataset.id, asOfPeriod: '2026-05', toleranceVnd: '5' })));
    expect(close).toMatchObject({ result: 'WITHIN_TOLERANCE', incidentId: null, toleranceVnd: '5' });
    expect(close.differences.map((entry) => [entry.key, entry.kind])).toEqual([[a, 'AMOUNT']]);
    const strict = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-MAY', { datasetId: dataset.id, asOfPeriod: '2026-05', toleranceVnd: '2' })));
    expect(strict.result).toBe('DIFFERENT');
  });

  it('refuses sources or a basis that cannot be compared, a month that is not closed, and a dataset it cannot name', async () => {
    const dataset = await newDataset();
    const run = (extra: Parameters<typeof request>[1]) => as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-BAD', { datasetId: dataset.id, ...extra })));
    expect(await refusal(run({ basis: 'VND, ngày báo cáo' }))).toEqual({ code: 'BASIS_MISMATCH', status: 422, detail: 'basis' });
    expect(await refusal(run({ sourceA: 'DIS.report_accepted' }))).toEqual({ code: 'BASIS_MISMATCH', status: 422, detail: 'source_a' });
    expect(await refusal(run({ sourceB: 'PAY.treasury_transaction' }))).toEqual({ code: 'BASIS_MISMATCH', status: 422, detail: 'source_b' });
    expect(await refusal(run({ asOfPeriod: '2026-13' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'as_of_period' });
    expect(await refusal(run({ asOfPeriod: '2031-01' }))).toEqual({ code: 'SNAPSHOT_NOT_FOUND', status: 422, detail: 'as_of_period' });
    expect(await refusal(run({ datasetId: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'dataset_id' });
    const hidden = await newDataset({ allowedRoles: ['SOME_OTHER_ROLE'] });
    expect(await refusal(as((tx) => recons.run(tx, viewer(READER), request('PAY-DIS-BAD', { datasetId: hidden.id })), READER))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'dataset_id' });
    // Without a dataset named, more than one dataset of DIS in view is not guessed at.
    expect(await refusal(run({ datasetId: undefined }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'dataset_id' });
    // Nothing was written by the refusals.
    expect(await owner("select count(*)::int as total from machvon.reconciliation_run where recon_code = 'PAY-DIS-BAD'")).toEqual([{ total: 0 }]);
  });

  it('is a measurement: not changed, not erased, listed newest first for the datasets the viewer may see, and not seen by another tenant', async () => {
    const dataset = await newDataset();
    const month = await closedMonth(['10'], '2026-04');
    await paid(month.projectIds[0] as string, '10', '2026-04-10T09:00:00+07:00');
    const first = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-APR', { datasetId: dataset.id, asOfPeriod: '2026-04' })));
    const second = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-APR', { datasetId: dataset.id, asOfPeriod: '2026-04', toleranceVnd: '1' })));
    await expect(owner("update machvon.reconciliation_run set result = 'DIFFERENT' where id = $1", [first.id])).rejects.toThrow(/not changed/);
    await expect(owner('update machvon.reconciliation_run set total_a_vnd = 1 where id = $1', [first.id])).rejects.toThrow(/not changed/);
    await expect(as((tx) => tx.query('delete from machvon.reconciliation_run where id = $1', [first.id]))).rejects.toThrow();
    const listed = await as((tx) => recons.list(tx, viewer(STEWARD), { reconCode: 'PAY-DIS-APR' }, { limit: 10, after: undefined }));
    expect(listed.map((row) => row.id)).toEqual([second.id, first.id]);
    expect((await as((tx) => recons.list(tx, viewer(STEWARD), { period: '2026-04', result: 'MATCHED' }, { limit: 1, after: undefined }))).map((row) => row.id)).toEqual([second.id]);
    expect(await as((tx) => recons.list(tx, viewer(STEWARD), { reconCode: 'PAY-DIS-APR', result: 'DIFFERENT' }, { limit: 10, after: undefined }))).toEqual([]);
    const hidden = await newDataset({ allowedRoles: ['SOME_OTHER_ROLE'] });
    const private_ = await as((tx) => recons.run(tx, viewer(STEWARD, 'SOME_OTHER_ROLE'), request('PAY-DIS-HIDDEN', { datasetId: hidden.id, asOfPeriod: '2026-04' })), STEWARD);
    expect(await as((tx) => recons.find(tx, viewer(READER), private_.id), READER)).toBeUndefined();
    expect((await as((tx) => recons.list(tx, viewer(READER), { reconCode: 'PAY-DIS-HIDDEN' }, { limit: 10, after: undefined }), READER))).toEqual([]);
    expect(await as((tx) => recons.find(tx, viewer(OTHER_TENANT_MEMBER), first.id), OTHER_TENANT_MEMBER, TENANT_B)).toBeUndefined();
  });

  it('closes an incident of a reconciliation only after a later reconciliation of the same code, month and dataset that is not different', async () => {
    const dataset = await newDataset();
    const other = await newDataset();
    const month = await closedMonth(['10'], '2026-03');
    const first = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-MAR', { datasetId: dataset.id, asOfPeriod: '2026-03' })));
    expect(first).toMatchObject({ result: 'DIFFERENT', differences: [{ kind: 'MISSING', side: 'B_ONLY' }] });
    const incidentId = first.incidentId as string;
    // The handler works the incident to the resolution (the chain the database keeps).
    const steps: Array<[string, string]> = [['ASSIGNED', ''], ['ACKNOWLEDGED', ''], ['IN_PROGRESS', ''], ['RESOLVED_PENDING_VERIFICATION', ", root_cause = 'Kho bạc chưa nhận khoản chi.', remediation = 'Nhập lại giao dịch Kho bạc.', resolved_at = now()"]];
    for (const [status, extra] of steps) await owner(`update machvon.quality_incident set status = '${status}', assignee_user_id = $2${extra}, version = version + 1 where id = $1`, [incidentId, memberId(READER)]);
    const evidence = async () => as((tx) => incidents.find(tx, incidentId, viewer(STEWARD)).then((found) => incidents.rerunEvidence(tx, found as NonNullable<typeof found>)));
    expect((await evidence()).rerun).toBeUndefined();
    // A reconciliation of another dataset, or of another code, is not evidence for this one.
    await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-MAR', { datasetId: other.id, asOfPeriod: '2026-03', toleranceVnd: '0' })));
    await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-OTHER-CODE', { datasetId: dataset.id, asOfPeriod: '2026-03' })));
    expect((await evidence()).rerun).toBeUndefined();
    // The same one again, still different: the incident is not closed on it.
    await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-MAR', { datasetId: dataset.id, asOfPeriod: '2026-03' })));
    expect((await evidence()).rerun).toMatchObject({ result: 'FAIL' });
    // The Treasury pays what the report says: the next one matches, and that is a pass.
    await paid(month.projectIds[0] as string, '10', '2026-03-05T09:00:00+07:00');
    const fixed = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-MAR', { datasetId: dataset.id, asOfPeriod: '2026-03' })));
    expect(fixed).toMatchObject({ result: 'MATCHED', incidentId: null });
    expect((await evidence()).rerun).toMatchObject({ result: 'PASS' });
  });

  it('compares the Treasury of the fiscal year of the report only, and keeps the whole count of the differences', async () => {
    const dataset = await newDataset();
    const month = await closedMonth(['40', '0'], '2026-02');
    const [p0, p1] = month.projectIds as [string, string];
    // What was paid in an earlier year is not in a report that is cumulative within its year.
    await paid(p0, '40', '2026-02-10T09:00:00+07:00');
    await paid(p0, '900', '2025-12-31T23:30:00+07:00');
    await paid(p1, '5', '2025-06-01T09:00:00+07:00');
    const made = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-FEB', { datasetId: dataset.id, asOfPeriod: '2026-02' })));
    expect(made).toMatchObject({ result: 'MATCHED', totalAVnd: '40', totalBVnd: '40', countA: 1, differencesCount: 0, incidentId: null });
    // The count by kind and the whole count are stored with the reconciliation, not worked out from the part that is kept.
    expect(await owner('select differences_count, by_kind from machvon.reconciliation_run where id = $1', [made.id])).toEqual([{ differences_count: 0, by_kind: { MISSING: 0, TIMING: 0, REVERSAL: 0, MAPPING: 0, AMOUNT: 0 } }]);
    await paid(p1, '7', '2026-02-12T09:00:00+07:00');
    const different = await as((tx) => recons.run(tx, viewer(STEWARD), request('PAY-DIS-FEB', { datasetId: dataset.id, asOfPeriod: '2026-02' })));
    expect(different).toMatchObject({ result: 'DIFFERENT', differencesCount: 1, byKind: { MISSING: 0, TIMING: 0, REVERSAL: 0, MAPPING: 0, AMOUNT: 1 } });
    await owner('update machvon.reconciliation_run set differences_json = $2::jsonb where id = $1', [different.id, '[]']).then(
      () => {
        throw new Error('expected the guard to refuse');
      },
      (error: Error) => expect(error.message).toMatch(/not changed/),
    );
    expect(await as((tx) => recons.find(tx, viewer(STEWARD), different.id))).toMatchObject({ differencesCount: 1, byKind: { AMOUNT: 1 } });
  });
});
