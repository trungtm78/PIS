import { buildLineage, traceLineage } from '../src/ana-lineage';
import type { LineageDataset, LineageKpi, LineageMetric } from '../src/ana-lineage';
import {
  FRESHNESS_DEFAULTS,
  SCORECARD_MODULE_DEFAULTS,
  SCORECARD_UNIT_DEFAULTS,
  compositeOf,
  freshnessRuleCodeOf,
  freshnessSlaOf,
  judgeFreshness,
  moduleScorecard,
  moduleScorecardPolicyOf,
  unitScorecard,
  unitScorecardPolicyOf,
} from '../src/ana-trust';

const sla = freshnessSlaOf(FRESHNESS_DEFAULTS.DEFAULT as Record<string, unknown>);
const NOW = new Date('2027-10-20T00:00:00Z');
const hoursBefore = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe('the freshness of a dataset (G3-7)', () => {
  it('reads the default SLA: 192 hours, due after 80 percent of it', () => {
    expect(sla).toEqual({ slaHours: 192, dueAfterPct: 80 });
    expect(freshnessRuleCodeOf('DS-DISB')).toBe('DS_DISB');
    expect(() => freshnessSlaOf({ sla_hours: 0, due_after_pct: 80 })).toThrow();
    expect(() => freshnessSlaOf({ sla_hours: 10 })).toThrow();
  });

  it('golden: fresh up to 80 percent of the SLA (153.6 hours), due up to the SLA, stale after it', () => {
    expect(judgeFreshness(hoursBefore(153.6), NOW, sla)).toMatchObject({ status: 'FRESH', ageHours: 153.6 });
    expect(judgeFreshness(hoursBefore(153.7), NOW, sla)).toMatchObject({ status: 'DUE', ageHours: 153.7 });
    // Exactly at the SLA is not yet late.
    expect(judgeFreshness(hoursBefore(192), NOW, sla)).toMatchObject({ status: 'DUE', overdueHours: null });
    expect(judgeFreshness(hoursBefore(192.1), NOW, sla)).toMatchObject({ status: 'STALE', overdueHours: 0.1 });
    expect(judgeFreshness(hoursBefore(240), NOW, sla)).toMatchObject({ status: 'STALE', ageHours: 240, overdueHours: 48 });
  });

  it('never calls a dataset that was never built fresh, and survives a clock that is behind', () => {
    expect(judgeFreshness(null, NOW, sla)).toEqual({ status: 'NO_DATA', ageHours: null, slaHours: 192, overdueHours: null, nullReason: 'NEVER_BUILT' });
    expect(judgeFreshness('not a time', NOW, sla).status).toBe('NO_DATA');
    expect(judgeFreshness(new Date(NOW.getTime() + 3_600_000).toISOString(), NOW, sla)).toMatchObject({ status: 'FRESH', ageHours: 0 });
  });
});

describe('the quality scorecard (G3-7)', () => {
  const module = moduleScorecardPolicyOf(SCORECARD_MODULE_DEFAULTS as Record<string, unknown>);
  const unit = unitScorecardPolicyOf(SCORECARD_UNIT_DEFAULTS as Record<string, unknown>);

  it('golden: a module with fresh data, a warning and a certification in draft is (40*100 + 40*60 + 20*20) / 100 = 68', () => {
    const row = moduleScorecard({ freshness: 'FRESH', quality: 'WARNING', certification: 'DRAFT' }, module);
    expect(row).toMatchObject({ composite: 68, band: 'FAIR', usedDimensions: 3, compositeNullReason: null });
    expect(row.dimensions.map((dimension) => [dimension.code, dimension.score])).toEqual([['FRESHNESS', 100], ['QUALITY', 60], ['CERTIFICATION', 20]]);
  });

  it('golden: a dimension that is not there does not count, and the composite stands on the others', () => {
    // No quality run: (40*100 + 20*100) / 60 = 100.
    const row = moduleScorecard({ freshness: 'FRESH', quality: 'NOT_ASSESSED', certification: 'CERTIFIED' }, module);
    expect(row).toMatchObject({ composite: 100, band: 'GOOD', usedDimensions: 2 });
    expect(row.dimensions[1]).toMatchObject({ score: null, nullReason: 'NOT_ASSESSED' });
  });

  it('is N/A below the minimum number of dimensions and never turns a missing signal into 0 or into good', () => {
    const row = moduleScorecard({ freshness: 'NO_DATA', quality: null, certification: 'CERTIFIED' }, module);
    expect(row).toMatchObject({ composite: null, compositeNullReason: 'TOO_FEW_DIMENSIONS', band: null, usedDimensions: 1 });
  });

  it('scores a stale or failed signal as zero (it is there, and it is bad)', () => {
    const row = moduleScorecard({ freshness: 'STALE', quality: 'FAILED', certification: 'OBSOLETE' }, module);
    expect(row).toMatchObject({ composite: 0, band: 'POOR' });
    expect(moduleScorecard({ freshness: 'DUE', quality: 'STALE', certification: 'CONFIRMED' }, module).composite).toBe(Math.round(((40 * 60 + 40 * 0 + 20 * 60) / 100) * 10) / 10);
  });

  it('golden: a unit with 8 of 10 projects with a Treasury figure, 90 percent coverage and one overdue explanation is (40*80 + 40*90 + 20*80) / 100 = 84', () => {
    const row = unitScorecard({ projects: 10, projectsWithoutData: 2, coveragePct: 90, overdueExplanations: 1 }, unit);
    expect(row).toMatchObject({ composite: 84, band: 'GOOD' });
    expect(row.dimensions.map((dimension) => dimension.score)).toEqual([80, 90, 80]);
  });

  it('lets a unit with no project and no explanation count be N/A with the reasons, and bounds the timeliness at zero', () => {
    expect(unitScorecard({ projects: 0, projectsWithoutData: 0, coveragePct: null, overdueExplanations: null }, unit)).toMatchObject({ composite: null, compositeNullReason: 'TOO_FEW_DIMENSIONS' });
    const row = unitScorecard({ projects: 4, projectsWithoutData: 0, coveragePct: 100, overdueExplanations: 9 }, unit);
    expect(row.dimensions[2]).toMatchObject({ score: 0 });
    expect(row.composite).toBe(80);
  });

  it('refuses a policy that is not whole', () => {
    expect(() => moduleScorecardPolicyOf({ ...SCORECARD_MODULE_DEFAULTS, fair_from: 90 })).toThrow();
    expect(() => moduleScorecardPolicyOf({ ...SCORECARD_MODULE_DEFAULTS, w_freshness: 0, w_quality: 0, w_certification: 0 })).toThrow();
    expect(() => unitScorecardPolicyOf({ ...SCORECARD_UNIT_DEFAULTS, good_from: 50 })).toThrow();
  });

  it('keeps a dimension of weight zero visible and out of the mean', () => {
    const row = compositeOf(
      [
        { code: 'A', weight: 0, score: 0, nullReason: null },
        { code: 'B', weight: 10, score: 50, nullReason: null },
        { code: 'C', weight: 10, score: 70, nullReason: null },
      ],
      { minDimensions: 2, goodFrom: 80, fairFrom: 60 },
    );
    expect(row).toMatchObject({ composite: 60, band: 'FAIR', usedDimensions: 2 });
    expect(row.dimensions).toHaveLength(3);
  });
});

describe('the declared lineage metric <- dataset <- table <- module (G3-11)', () => {
  const datasets: LineageDataset[] = [
    { code: 'DS-DISB', label: 'Disbursement', producerModule: 'DIS', fields: ['GIAI_NGAN', 'KE_HOACH_TTG', 'DU_AN'], tables: ['period_snapshot_line', 'project', 'organization_unit'] },
    { code: 'DS-CTR', label: 'Contracts', producerModule: 'CTR', fields: ['PAID', 'ACCEPTED'], tables: ['contract_fact_snapshot_line', 'project', 'mystery_table'] },
  ];
  const metrics: LineageMetric[] = [
    { code: 'disbursement_rate', label: 'Disbursement rate', fields: ['GIAI_NGAN', 'KE_HOACH_TTG'] },
    { code: 'ctr_paid_to_accepted', label: 'Paid to accepted', fields: ['PAID', 'ACCEPTED'] },
    { code: 'orphan_metric', label: 'Orphan', fields: ['NO_SUCH_FIELD'] },
  ];
  const kpis: LineageKpi[] = [{ code: 'OPEN_WARNINGS', label: 'Open warnings', tables: ['early_warning'] }];
  const graph = buildLineage({ metrics, datasets, kpis });

  it('builds nodes, edges and the gaps, sorted and without duplicates', () => {
    expect(graph.nodes.map((node) => node.id)).toEqual(
      [...graph.nodes.map((node) => node.id)].sort(),
    );
    expect(graph.nodes.find((node) => node.id === 'TABLE:project')?.module).toBe('PRJ');
    expect(graph.nodes.find((node) => node.id === 'TABLE:mystery_table')?.module).toBeNull();
    expect(graph.unresolved).toEqual(
      expect.arrayContaining([
        { kind: 'TABLE_WITHOUT_MODULE', key: 'mystery_table' },
        { kind: 'METRIC_WITHOUT_DATASET', key: 'orphan_metric' },
      ]),
    );
    const keys = graph.edges.map((edge) => `${edge.from}>${edge.to}>${edge.relation}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(buildLineage({ metrics, datasets, kpis })).toEqual(graph);
  });

  it('traces a metric upstream to its dataset, the tables and the modules that own them', () => {
    const trace = traceLineage(graph, 'METRIC:disbursement_rate', 'UPSTREAM');
    expect(trace?.paths).toEqual(
      expect.arrayContaining([
        ['METRIC:disbursement_rate', 'DATASET:DS-DISB', 'TABLE:period_snapshot_line', 'MODULE:DIS'],
        ['METRIC:disbursement_rate', 'DATASET:DS-DISB', 'TABLE:project', 'MODULE:PRJ'],
        ['METRIC:disbursement_rate', 'DATASET:DS-DISB', 'TABLE:organization_unit', 'MODULE:ADM'],
      ]),
    );
    expect(trace?.paths.every((path) => path[0] === 'METRIC:disbursement_rate')).toBe(true);
    expect(trace?.nodes.some((node) => node.id === 'DATASET:DS-CTR')).toBe(false);
  });

  it('traces a shared table downstream to everything that stands on it', () => {
    const trace = traceLineage(graph, 'TABLE:project', 'DOWNSTREAM');
    const ends = new Set(trace?.paths.map((path) => path[path.length - 1]));
    expect(ends).toEqual(new Set(['METRIC:disbursement_rate', 'METRIC:ctr_paid_to_accepted']));
    expect(traceLineage(graph, 'MODULE:DIS', 'DOWNSTREAM')?.nodes.map((node) => node.id)).toContain('METRIC:disbursement_rate');
  });

  it('shows a KPI that reads a table directly, honours the depth, and returns null for an unknown node', () => {
    expect(traceLineage(graph, 'KPI:OPEN_WARNINGS', 'UPSTREAM')?.paths).toEqual([['KPI:OPEN_WARNINGS', 'TABLE:early_warning', 'MODULE:DIS']]);
    expect(traceLineage(graph, 'METRIC:disbursement_rate', 'UPSTREAM', 1)?.paths.every((path) => path.length === 2)).toBe(true);
    expect(traceLineage(graph, 'METRIC:nope', 'UPSTREAM')).toBeNull();
  });
});
