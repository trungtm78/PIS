import { randomUUID } from 'node:crypto';
import { AnaTrustController } from '../../src/modules/home/ana-trust.controller';
import { MEMBERS, TENANT_B, UNITS, createAnaFixture, memberId, unitId } from './ana-support';

jest.setTimeout(240_000);

const FAMILY = 0xb7;
const fx = createAnaFixture(FAMILY, new Date('2027-10-20T00:00:00Z'));
const HOUR = 3_600_000;

type Freshness = { status: string; age_hours: number | null; sla_hours: number; overdue_hours: number | null; null_reason: string | null };
type Dataset = { code: string; module: string; built_at: string | null; quality_badge: string | null; certification: string | null; freshness: Freshness; sla_version: string; unverified: boolean };
type Row = { composite: number | null; band: string | null; null_reason: string | null; used_dimensions: number; dimensions: Array<{ code: string; score: number | null; null_reason: string | null }> };

const hoursAgo = (hours: number): string => new Date(fx.clock.now.getTime() - hours * HOUR).toISOString();
const person = memberId(MEMBERS.LEADER);

async function dataset(code: string, builtHoursAgo: number | null, badge = 'PASSED'): Promise<string> {
  const id = await fx.insert('bi_dataset', { dataset_code: code, title: `${code} title`, source_kind: 'PERIOD_SNAPSHOT', grain: 'project', join_paths: {}, owner_user_id: person, created_by: person, updated_by: person });
  if (builtHoursAgo !== null) {
    await fx.insert('bi_dataset_version', { dataset_id: id, as_of_period: 'W42', built_at: hoursAgo(builtHoursAgo), row_count: 10, checksum_sha256: 'a'.repeat(64), quality_badge: badge, ...(badge === 'NOT_ASSESSED' ? {} : { quality_run_id: randomUUID() }), status: 'FROZEN', created_by: person, updated_by: person }, undefined, { replica: true });
  }
  return id;
}

describe('what the leader can trust, over HTTP (G3-7, G3-11)', () => {
  beforeAll(async () => {
    await fx.start({
      controllers: [AnaTrustController],
      roles: [
        { n: 1, name: 'TRUST_ALL', permissions: ['home.read', 'bi.query', 'bi.lineage.read'] },
        { n: 2, name: 'TRUST_BRANCH', permissions: ['home.read', 'bi.query'] },
      ],
      grants: [
        { n: 1, member: MEMBERS.LEADER, role: 1, kind: 'TENANT' },
        { n: 2, member: MEMBERS.BRANCH, role: 2, kind: 'UNIT_SUBTREE', unit: UNITS.NORTH },
      ],
    });
  }, 300_000);
  afterAll(() => fx.stop(), 60_000);
  beforeEach(async () => {
    fx.clock.now = new Date('2027-10-20T00:00:00Z');
    await fx.wipe(['bi_dataset_version', 'bi_dataset', 'metric_definition', 'early_warning_score']);
  });

  it('judges every registered dataset against its SLA: fresh, stale after the SLA, and no data for one that was never built', async () => {
    await dataset('DS-DISB', 200);
    const reply = await fx.get('/bi/data-freshness');
    expect(reply.status).toBe(200);
    const datasets = reply.json.datasets as Dataset[];
    const disb = datasets.find((one) => one.code === 'DS-DISB') as Dataset;
    const ctr = datasets.find((one) => one.code === 'DS-CTR') as Dataset;
    // 200 hours old against an SLA of 192: 8 hours late.
    expect(disb.freshness).toMatchObject({ status: 'STALE', age_hours: 200, sla_hours: 192, overdue_hours: 8 });
    expect(disb).toMatchObject({ module: 'DIS', sla_version: 'builtin', unverified: true, quality_badge: 'PASSED' });
    expect(ctr.freshness).toMatchObject({ status: 'NO_DATA', age_hours: null, null_reason: 'NEVER_BUILT' });
    expect(reply.json).toMatchObject({ stale_count: 1, no_data_count: 1 });
    expect((reply.json.info as { formula: string }).formula).toEqual(expect.any(String));
  });

  it('shows a dataset inside its SLA as fresh and one close to it as due', async () => {
    await dataset('DS-DISB', 10);
    const fresh = (await fx.get('/bi/data-freshness')).json.datasets as Dataset[];
    expect(fresh.find((one) => one.code === 'DS-DISB')?.freshness.status).toBe('FRESH');
    await fx.wipe(['bi_dataset_version', 'bi_dataset']);
    await dataset('DS-DISB', 160);
    const due = (await fx.get('/bi/data-freshness')).json.datasets as Dataset[];
    expect(due.find((one) => one.code === 'DS-DISB')?.freshness.status).toBe('DUE');
  });

  it('takes the SLA of a dataset from the rule the tenant approved, and names its version', async () => {
    await dataset('DS-DISB', 10);
    await fx.insert('governance_rule', {
      rule_type: 'FRESHNESS_SLA',
      code: 'DS_DISB',
      version: 1,
      status: 'APPROVED',
      params: { sla_hours: 6, due_after_pct: 50 },
      effective_from: '2027-01-01',
      reason: 'The province wants the figures every six hours',
      created_by: person,
      submitted_by: person,
      submitted_at: fx.clock.now.toISOString(),
      approved_by: memberId(MEMBERS.SECOND),
      approved_at: fx.clock.now.toISOString(),
    });
    const disb = ((await fx.get('/bi/data-freshness')).json.datasets as Dataset[]).find((one) => one.code === 'DS-DISB') as Dataset;
    expect(disb.freshness).toMatchObject({ status: 'STALE', sla_hours: 6 });
    expect(disb.sla_version).toBe('v1');
    await fx.wipe(['governance_rule']);
  });

  it('scores the modules from the freshness, the quality badge and the certification, and is N/A when too little is known', async () => {
    await dataset('DS-DISB', 10, 'PASSED');
    const reply = await fx.get('/home/quality-scorecard');
    expect(reply.status).toBe(200);
    const modules = reply.json.modules as Array<Row & { module: string; datasets: string[] }>;
    const dis = modules.find((one) => one.module === 'DIS') as Row & { module: string };
    // Fresh 100 and passed 100 stand; there is no certification line for a new dataset, which is a draft (20): (40*100 + 40*100 + 20*20) / 100 = 84.
    expect(dis.dimensions.map((one) => [one.code, one.score])).toEqual([['FRESHNESS', 100], ['QUALITY', 100], ['CERTIFICATION', 20]]);
    expect(dis).toMatchObject({ composite: 84, band: 'GOOD', used_dimensions: 3 });
    const ctr = modules.find((one) => one.module === 'CTR') as Row;
    expect(ctr).toMatchObject({ composite: null, null_reason: 'TOO_FEW_DIMENSIONS' });
    expect(ctr.dimensions[0]).toMatchObject({ score: null, null_reason: 'NEVER_BUILT' });
    expect((reply.json.module_info as { unverified: boolean }).unverified).toBe(true);
  });

  it('scores the units in the scope of the reader from the snapshot and says nothing of the others', async () => {
    const snapshot = await fx.snapshot({ asOf: '2027-10-12' });
    await fx.project(snapshot, UNITS.NORTH, '600000000000');
    await fx.project(snapshot, UNITS.NORTH, null);
    await fx.project(snapshot, UNITS.SOUTH, '600000000000');
    const all = (await fx.get('/home/quality-scorecard')).json as { units: Array<Row & { unit_id: string }>; snapshot_id: string };
    expect(all.snapshot_id).toBe(snapshot);
    const north = all.units.find((one) => one.unit_id === unitId(UNITS.NORTH)) as Row;
    // 1 of 2 projects with a Treasury figure: completeness 50; no weekly score was written, so coverage is not there; no overdue explanation: timeliness 100.
    expect(north.dimensions.map((one) => [one.code, one.score])).toEqual([['COMPLETENESS', 50], ['COVERAGE', null], ['TIMELINESS', 100]]);
    expect(north.dimensions[1]?.null_reason).toBe('NOT_SCORED');
    expect(north).toMatchObject({ composite: 66.7, band: 'FAIR' });
    const branch = (await fx.get('/home/quality-scorecard', MEMBERS.BRANCH)).json as { units: Array<{ unit_id: string }> };
    expect(branch.units.map((one) => one.unit_id)).toEqual([unitId(UNITS.NORTH)]);
    const other = (await fx.get('/home/quality-scorecard', 1, TENANT_B)).json as { units: unknown[]; snapshot_id: string | null };
    expect(other.units).toEqual([]);
    expect(other.snapshot_id).toBeNull();
  });

  it('draws the declared lineage and traces a figure of the command center up to the table and the module that owns it', async () => {
    const graph = await fx.get('/bi/lineage');
    expect(graph.status).toBe(200);
    expect((graph.json.counts as { nodes: number }).nodes).toBeGreaterThan(10);
    const catalogue = graph.json.catalogue as Array<{ kind: string; nodes: Array<{ id: string }> }>;
    expect(catalogue.find((one) => one.kind === 'KPI')?.nodes.map((node) => node.id)).toContain('KPI:OPEN_WARNINGS');
    const up = await fx.get('/bi/lineage?node=KPI:OPEN_WARNINGS&direction=UPSTREAM');
    expect((up.json.trace as { paths: string[][] }).paths).toEqual([['KPI:OPEN_WARNINGS', 'TABLE:early_warning', 'MODULE:DIS']]);
    const down = await fx.get('/bi/lineage?node=TABLE:project&direction=DOWNSTREAM');
    const ends = ((down.json.trace as { paths: string[][] }).paths).map((path) => path[path.length - 1]);
    expect(ends).toContain('DATASET:DS-DISB');
    expect(ends).toContain('DATASET:DS-CTR');
  });

  it('puts a metric of the registry under the dataset that serves its fields', async () => {
    const reader = person;
    await fx.insert('metric_definition', { code: 'ctr_paid_value', revision: 1, grain: 'contract_party', aggregation_type: 'ADDITIVE', expression_ast: { op: 'sum', args: [{ op: 'field', name: 'PAID' }] }, unit: 'vnd', owner_id: reader, status: 'CERTIFIED', certified_by: reader });
    const up = await fx.get('/bi/lineage?node=METRIC:ctr_paid_value&direction=UPSTREAM');
    expect(up.status).toBe(200);
    const paths = (up.json.trace as { paths: string[][] }).paths;
    expect(paths).toContainEqual(['METRIC:ctr_paid_value', 'DATASET:DS-CTR', 'TABLE:contract_fact_snapshot_line', 'MODULE:CTR']);
  });

  it('refuses an unknown node and a malformed query, and a reader without the right to see lineage', async () => {
    expect((await fx.get('/bi/lineage?node=METRIC:does_not_exist')).status).toBe(404);
    expect((await fx.get('/bi/lineage?node=bad')).status).toBe(422);
    expect((await fx.get('/bi/lineage?node=KPI:OPEN_WARNINGS&direction=SIDEWAYS')).status).toBe(422);
    expect((await fx.get('/bi/lineage?depth=9')).status).toBe(422);
    expect((await fx.get('/bi/lineage', MEMBERS.BRANCH)).status).toBe(403);
    expect((await fx.get('/bi/data-freshness', MEMBERS.NOBODY)).status).toBe(403);
  });
});
