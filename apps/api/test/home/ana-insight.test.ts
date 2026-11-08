import { AnaInsightController } from '../../src/modules/home/ana-insight.controller';
import { MEMBERS, TENANT_A, TENANT_B, UNITS, createAnaFixture, memberId, unitId } from './ana-support';

jest.setTimeout(240_000);

const FAMILY = 0xba;
const fx = createAnaFixture(FAMILY, new Date('2027-10-06T03:00:00Z'));
const M = 1_000_000_000;
const MONDAYS = ['2027-08-02', '2027-08-09', '2027-08-16', '2027-08-23', '2027-08-30', '2027-09-06', '2027-09-13', '2027-09-20', '2027-09-27', '2027-10-04'];

type Cell = { row_key: string; col_key: string; rate_pct: string | null; band: string | null; null_reason: string | null; count: number | null };
type Heat = { view: string; null_reason: string | null; pace_pct: number | null; hidden_cells: number; cells: Cell[]; rows: Array<{ key: string; label: string }>; cols: Array<{ key: string; code: string | null; none: boolean }>; row_totals: Array<{ key: string; rate_pct: string | null; hidden: number }>; col_totals: Array<{ key: string; rate_pct: string | null }>; info: { unverified: boolean } };
type Back = { null_reason: string | null; pairs: number; positives: number; lines: { amber_from: number; red_from: number }; candidates: Array<{ line: string; threshold: number; is_current: boolean; tp: number; fp: number; fn: number; precision_pct: string | null; recall_pct: string | null; null_reason: string | null }> };
type Trend = { null_reason: string | null; improving: Array<{ unit_id: string; rank: number; delta: number }>; worsening: Array<{ unit_id: string; rank: number; delta: number }>; units: Array<{ unit_id: string; rank: number | null; delta: number | null; direction: string | null; null_reason: string | null; series: Array<number | null> }> };

async function scores(unit: number, values: number[], bands: string[], snapshot: string): Promise<void> {
  for (const [index, score] of values.entries()) {
    await fx.insert('early_warning_score', { week_start: MONDAYS[index], unit_id: unitId(unit), snapshot_id: snapshot, as_of_date: MONDAYS[index], score, band: bands[index], coverage_pct: 100, breakdown: {}, rule_versions: {}, computed_by: memberId(MEMBERS.LEADER) }, TENANT_A, { replica: true });
  }
}

describe('the heat-map, the back-test and the trend over HTTP (G3-10, G3-11)', () => {
  beforeAll(async () => {
    await fx.start({
      controllers: [AnaInsightController],
      roles: [
        { n: 1, name: 'INSIGHT_ALL', permissions: ['home.read', 'bi.admin.read'] },
        { n: 2, name: 'INSIGHT_BRANCH', permissions: ['home.read'] },
      ],
      grants: [
        { n: 1, member: MEMBERS.LEADER, role: 1, kind: 'TENANT' },
        { n: 2, member: MEMBERS.BRANCH, role: 2, kind: 'UNIT_SUBTREE', unit: UNITS.NORTH },
      ],
    });
  }, 300_000);
  afterAll(() => fx.stop(), 60_000);
  beforeEach(async () => {
    fx.clock.now = new Date('2027-10-06T03:00:00Z');
    await fx.wipe(['early_warning_score']);
  });

  it('draws units against fund sources: the rate as a text, the band, the totals of the cells shown, and the small cell hidden', async () => {
    const stateFund = await fx.fundSource('NSTW', 'State budget');
    const localFund = await fx.fundSource('NSDP', 'Local budget');
    const snapshot = await fx.snapshot({ asOf: '2027-10-04' });
    // North: three projects of the state fund (600 of 1,000 each) and one of the local fund (a small cell); south: three projects of the local fund (300 of 1,000 each).
    for (let index = 0; index < 3; index += 1) await fx.project(snapshot, UNITS.NORTH, String(600 * M), { fundSourceVersionId: stateFund, planPm: String(1000 * M), planLocal: '0' });
    await fx.project(snapshot, UNITS.NORTH, String(900 * M), { fundSourceVersionId: localFund, planPm: String(1000 * M), planLocal: '0' });
    for (let index = 0; index < 3; index += 1) await fx.project(snapshot, UNITS.SOUTH, String(300 * M), { fundSourceVersionId: localFund, planPm: String(1000 * M), planLocal: '0' });
    const reply = await fx.get('/home/insight/heatmap');
    expect(reply.status).toBe(200);
    const map = reply.json as unknown as Heat;
    expect(map).toMatchObject({ view: 'UNIT_FUND', null_reason: null, hidden_cells: 1 });
    expect(map.info.unverified).toBe(true);
    expect(map.pace_pct).toBeGreaterThan(70);
    const find = (row: number, fund: string): Cell => map.cells.find((cell) => cell.row_key === unitId(row) && cell.col_key === (map.cols.find((col) => col.code === fund)?.key ?? '')) as Cell;
    expect(find(UNITS.NORTH, 'NSTW')).toMatchObject({ rate_pct: '60.0', count: 3, null_reason: null });
    expect(find(UNITS.SOUTH, 'NSDP')).toMatchObject({ rate_pct: '30.0', count: 3, band: 'RED' });
    // The cell of the north in the local fund has one project: no figure and no band, and the totals leave it out.
    expect(find(UNITS.NORTH, 'NSDP')).toMatchObject({ rate_pct: null, band: null, null_reason: 'SMALL_CELL', count: null });
    expect(map.row_totals.find((total) => total.key === unitId(UNITS.NORTH))).toMatchObject({ rate_pct: '60.0', hidden: 1 });
    expect(map.col_totals.find((total) => total.key === map.cols.find((col) => col.code === 'NSDP')?.key)?.rate_pct).toBe('30.0');
  });

  it('keeps a reader in the scope of their projects and shows no data of another tenant', async () => {
    const snapshot = await fx.snapshot({ asOf: '2027-10-04' });
    for (let index = 0; index < 3; index += 1) await fx.project(snapshot, UNITS.NORTH, String(600 * M), { planPm: String(1000 * M), planLocal: '0' });
    for (let index = 0; index < 3; index += 1) await fx.project(snapshot, UNITS.SOUTH, String(300 * M), { planPm: String(1000 * M), planLocal: '0' });
    const branch = (await fx.get('/home/insight/heatmap', MEMBERS.BRANCH)).json as unknown as Heat;
    expect(branch.rows.map((row) => row.key)).toEqual([unitId(UNITS.NORTH)]);
    const other = (await fx.get('/home/insight/heatmap', 1, TENANT_B)).json as unknown as Heat;
    expect(other).toMatchObject({ null_reason: 'NO_SNAPSHOT', cells: [] });
  });

  it('says there is no contract fact for the contractor views instead of drawing an empty table, and refuses a view it does not know', async () => {
    const map = (await fx.get('/home/insight/heatmap?view=CONTRACTOR_UNIT')).json as unknown as Heat;
    expect(map).toMatchObject({ view: 'CONTRACTOR_UNIT', null_reason: 'NO_SNAPSHOT', cells: [] });
    expect((await fx.get('/home/insight/heatmap?view=OTHER')).status).toBe(422);
  });

  it('replays the stored weeks against what came after, for the candidate thresholds', async () => {
    const snapshot = await fx.snapshot({ asOf: '2027-10-04' });
    await scores(UNITS.NORTH, [10, 20, 30, 40, 50, 60, 30, 20, 10, 5], ['GREEN', 'GREEN', 'AMBER', 'AMBER', 'RED', 'RED', 'AMBER', 'GREEN', 'GREEN', 'GREEN'], snapshot);
    await scores(UNITS.SOUTH, Array(10).fill(5) as number[], Array(10).fill('GREEN') as string[], snapshot);
    const back = (await fx.get('/home/insight/backtest')).json as unknown as Back;
    // The lines in force are the defaults of the score: amber from 25, red from 45 (a lower score is healthier).
    expect(back.lines).toMatchObject({ amber_from: 25, red_from: 45 });
    expect(back.pairs).toBeGreaterThanOrEqual(8);
    expect(back.positives).toBeGreaterThanOrEqual(1);
    const current = back.candidates.find((candidate) => candidate.is_current) as Back['candidates'][number];
    expect(current).toMatchObject({ line: 'AMBER', threshold: 25 });
    expect(current.tp + current.fn).toBe(back.positives);
    expect(back.candidates.length).toBe(10);
    // The back-test is for governance readers.
    expect((await fx.get('/home/insight/backtest', MEMBERS.BRANCH)).status).toBe(403);
  });

  it('gives no precision when the sample is too small', async () => {
    const snapshot = await fx.snapshot({ asOf: '2027-10-04' });
    await scores(UNITS.NORTH, [10, 20, 30, 40, 50, 60, 30, 20, 10, 5].slice(0, 5), ['GREEN', 'GREEN', 'AMBER', 'AMBER', 'RED'], snapshot);
    const back = (await fx.get('/home/insight/backtest')).json as unknown as Back;
    expect(back).toMatchObject({ null_reason: 'TOO_FEW_PAIRS' });
    expect(back.candidates.every((candidate) => candidate.precision_pct === null && candidate.recall_pct === null)).toBe(true);
    const none = (await fx.get('/home/insight/backtest', MEMBERS.LEADER, TENANT_B)).json as unknown as Back;
    expect(none.null_reason).toBe('NO_SNAPSHOT');
  });

  it('ranks the units by the change of their score over four weeks, the most improving first', async () => {
    const snapshot = await fx.snapshot({ asOf: '2027-10-04' });
    await scores(UNITS.NORTH, [10, 20, 30, 40, 50, 60, 30, 20, 10, 5], ['GREEN', 'GREEN', 'AMBER', 'AMBER', 'RED', 'RED', 'AMBER', 'GREEN', 'GREEN', 'GREEN'], snapshot);
    await scores(UNITS.SOUTH, [5, 5, 5, 5, 5, 5, 5, 5, 5, 40], ['GREEN', 'GREEN', 'GREEN', 'GREEN', 'GREEN', 'GREEN', 'GREEN', 'GREEN', 'GREEN', 'AMBER'], snapshot);
    const trend = (await fx.get('/home/insight/trend-ranking')).json as unknown as Trend;
    // North: 5 now against 60 four weeks before: -55, improving. South: 40 against 5: +35, worsening.
    expect(trend.improving).toEqual([{ unit_id: unitId(UNITS.NORTH), code: expect.any(String), name: expect.any(String), rank: 1, delta: -55, direction: 'IMPROVING', score_now: 5, score_before: 60, null_reason: null, series: [60, 30, 20, 10, 5] }]);
    expect(trend.worsening.map((row) => [row.unit_id, row.delta])).toEqual([[unitId(UNITS.SOUTH), 35]]);
    expect(trend.units.map((row) => row.rank)).toEqual([1, 2]);
    const branch = (await fx.get('/home/insight/trend-ranking', MEMBERS.BRANCH)).json as unknown as Trend;
    expect(branch.units.map((row) => row.unit_id)).toEqual([unitId(UNITS.NORTH)]);
    const empty = (await fx.get('/home/insight/trend-ranking', 1, TENANT_B)).json as unknown as Trend;
    expect(empty).toMatchObject({ null_reason: 'NO_SNAPSHOT', units: [] });
  });
});
