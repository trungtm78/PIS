import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { metricOfDocument } from '../src/bi-metric.ts';
import { CONTRACT_ADAPTER, measurePlanOf } from '../src/bi-query.ts';
import { INDICATOR_CODES } from '../src/ctr-analytics.ts';

const METRICS = resolve(__dirname, '..', '..', '..', 'metrics');
const files = existsSync(METRICS) ? readdirSync(METRICS).filter((name) => /^ctr_.*\.metric\.yaml$/.test(name)) : [];

describe('CA-1 the metric files of the contract portfolio are queryable over DS-CTR', () => {
  // The YAML library is the one the bundle script loads; the files are read the way it reads them.
  const yaml = createRequire(__filename)('js-yaml') as { load: (text: string) => unknown };

  it('has the metric files', () => {
    expect(files.length).toBeGreaterThanOrEqual(14);
    expect(files).toEqual(expect.arrayContaining(['ctr_portfolio_value.metric.yaml', 'ctr_paid_to_accepted.metric.yaml', 'ctr_change_growth.metric.yaml', 'ctr_top5_share.metric.yaml', 'ctr_hhi.metric.yaml']));
  });

  it.each(files)('%s is a valid metric, plans over the fields of DS-CTR and is cut only by dimensions DS-CTR offers', (name) => {
    const text = readFileSync(join(METRICS, name), 'utf8');
    const document = yaml.load(text);
    const checked = metricOfDocument(document);
    expect(checked).toMatchObject({ ok: true });
    if (!checked.ok) return;
    const metric = checked.value;
    expect(`${metric.code}.metric.yaml`).toBe(name);
    expect(metric.code.startsWith('ctr_')).toBe(true);
    expect(() => measurePlanOf(metric, CONTRACT_ADAPTER)).not.toThrow();
    for (const dimension of metric.dimensionCodes) expect(Object.keys(CONTRACT_ADAPTER.dimensions)).toContain(dimension);
    // The meaning of the number is written once, in ctr-analytics: a file that names an indicator names one that exists.
    const named = /\(indicator ([A-Z_]+)[ )]/.exec(text)?.[1];
    if (named !== undefined && !named.startsWith('none')) expect(INDICATOR_CODES as readonly string[]).toContain(named);
  });

  it('a metric of two stages needs the dimension it is grouped by, and the plain ones do not', () => {
    const plan = (name: string) => {
      const checked = metricOfDocument(yaml.load(readFileSync(join(METRICS, name), 'utf8')));
      if (!checked.ok) throw new Error(name);
      return measurePlanOf(checked.value, CONTRACT_ADAPTER);
    };
    expect(plan('ctr_hhi.metric.yaml').twoStage?.numerator).toEqual({ op: 'SUM_OF_SQUARES', n: null, multiplier: '100' });
    expect(plan('ctr_top5_share.metric.yaml').twoStage?.numerator).toEqual({ op: 'TOP_N_SUM', n: 5, multiplier: '1' });
    expect(plan('ctr_paid_to_accepted.metric.yaml')).toEqual({ kind: 'RATIO', numeratorColumn: 'paid_vnd', denominatorColumn: 'accepted_vnd', nullPolicy: 'NULL_NOT_ZERO' });
    expect(plan('ctr_portfolio_value.metric.yaml')).toMatchObject({ kind: 'ADDITIVE', numeratorColumn: 'active_value_vnd' });
    expect(plan('ctr_contract_count.metric.yaml')).toMatchObject({ kind: 'DISTINCT', numeratorColumn: 'contract_id', nullPolicy: 'ZERO_IF_NO_ROWS' });
  });
});
