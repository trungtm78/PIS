import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { metricOfDocument } from '../src/bi-metric';
import { measurePlanOf } from '../src/bi-query';
import type { DatasetAdapter } from '../src/bi-query';
import { ENTERPRISE_BI_DATASET_DEFINITIONS } from '../src/open-api';

const METRICS = resolve(__dirname, '..', '..', '..', 'metrics');
const files = readdirSync(METRICS).filter((name) => /^ent_.*\.metric\.yaml$/.test(name));

/** The view the metrics of the enterprise period are made of, and the field and dimension names a metric file uses for its columns. */
const VIEW = ENTERPRISE_BI_DATASET_DEFINITIONS['DS-ENT'].views.find((one) => one.view === 'v_enterprise_plan_actual') as { columns: readonly string[] };
const FIELDS: Readonly<Record<string, string>> = { PLAN_IN_FORCE: 'plan_in_force_vnd', PLAN_TO_DATE: 'plan_to_date_vnd', ACTUAL: 'actual_vnd', CUMULATIVE_YTD: 'cumulative_ytd_vnd' };
const DIMENSIONS: Readonly<Record<string, string>> = { unit: 'unit_id', project: 'project_id', class: 'class_code', tier: 'tier_code', measure: 'measure' };
const ADAPTER: DatasetAdapter = {
  code: 'DS-ENT',
  sourceKind: 'PERIOD_SNAPSHOT',
  grain: 'project_class',
  fields: FIELDS,
  dimensions: Object.fromEntries(Object.entries(DIMENSIONS).map(([name, column]) => [name, { column, kind: name === 'unit' || name === 'project' ? ('uuid' as const) : ('text' as const) }])),
  identifierFields: [],
  capabilities: { twoStage: false, periodSeries: false },
};

describe('INT-2 the metric files of the enterprise period snapshot are made of the columns of the certified view', () => {
  // The YAML library is the one the bundle script loads; the files are read the way it reads them.
  const yaml = createRequire(__filename)('js-yaml') as { load: (text: string) => unknown };
  const planOf = (name: string) => {
    const checked = metricOfDocument(yaml.load(readFileSync(join(METRICS, name), 'utf8')));
    if (!checked.ok) throw new Error(name);
    return { metric: checked.value, plan: measurePlanOf(checked.value, ADAPTER) };
  };

  it('has the five metric files', () => {
    expect(files).toEqual(['ent_cumulative_ytd.metric.yaml', 'ent_period_actual.metric.yaml', 'ent_plan_in_force.metric.yaml', 'ent_rate_in_force.metric.yaml', 'ent_rate_to_date.metric.yaml']);
  });

  it.each(files)('%s is a valid metric whose fields and dimensions are columns of v_enterprise_plan_actual', (name) => {
    const { metric, plan } = planOf(name);
    expect(`${metric.code}.metric.yaml`).toBe(name);
    expect(metric.nullPolicy).toBe('NULL_NOT_ZERO');
    for (const dimension of metric.dimensionCodes) expect(VIEW.columns).toContain(DIMENSIONS[dimension]);
    const columns = plan.kind === 'RATIO' ? [plan.numeratorColumn, plan.denominatorColumn] : [plan.numeratorColumn];
    for (const column of columns) expect(VIEW.columns).toContain(column);
  });

  it('makes the rates from sums over the right plan, and the stocks from one sum each', () => {
    expect(planOf('ent_rate_in_force.metric.yaml').plan).toEqual({ kind: 'RATIO', numeratorColumn: 'cumulative_ytd_vnd', denominatorColumn: 'plan_in_force_vnd', nullPolicy: 'NULL_NOT_ZERO' });
    expect(planOf('ent_rate_to_date.metric.yaml').plan).toEqual({ kind: 'RATIO', numeratorColumn: 'cumulative_ytd_vnd', denominatorColumn: 'plan_to_date_vnd', nullPolicy: 'NULL_NOT_ZERO' });
    expect(planOf('ent_cumulative_ytd.metric.yaml').plan).toMatchObject({ kind: 'ADDITIVE', numeratorColumn: 'cumulative_ytd_vnd' });
    expect(planOf('ent_plan_in_force.metric.yaml').metric.aggregationType).toBe('semi_additive');
    expect(planOf('ent_period_actual.metric.yaml').metric.aggregationType).toBe('additive');
  });
});
