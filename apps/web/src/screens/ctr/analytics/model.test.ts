import { describe, expect, it } from 'vitest';
import { PORTFOLIO_COLUMNS, concentrationBody, curveBody, evmBody, portfolioBody, snapshot } from './test-support';
import {
  DEFAULT_QUERY,
  EMPTY_ANALYTICS_FILTER,
  REPORT_CODES,
  REPORT_PATHS,
  barLength,
  billionsOf,
  breakdownPoints,
  bytesOfBase64,
  camel,
  chartColumn,
  dateText,
  decimalText,
  filterCount,
  healthTone,
  isReportCode,
  levelTone,
  moneyText,
  percentText,
  queryParams,
  toConcentrationView,
  toCurveView,
  toContext,
  toReportFile,
  toReportView,
  toSnapshotRef,
} from './model';

describe('the words of the catalogue', () => {
  it('turns a catalogue word into the segment of an i18n key', () => {
    expect([camel('TWO_THREE'), camel('bid-variance'), camel('D91_180'), camel('LATE_1_30'), camel('contract_status'), camel('ONE'), camel('portfolio-status')]).toEqual(['twoThree', 'bidVariance', 'd91180', 'late130', 'contractStatus', 'one', 'portfolioStatus']);
  });

  it('knows the fourteen reports and gives each a path: three screens of their own, the others opened in the hub by name', () => {
    expect(REPORT_CODES).toHaveLength(14);
    expect(REPORT_CODES.every(isReportCode)).toBe(true);
    expect(isReportCode('nope')).toBe(false);
    expect(REPORT_PATHS['portfolio-status']).toBe('/ctr/ctr-29');
    expect(REPORT_PATHS['bid-variance']).toBe('/ctr/ctr-30');
    expect(REPORT_PATHS['contractor-concentration']).toBe('/ctr/ctr-31');
    for (const code of ['schedule-delay', 'payment-three-way', 'advance-ageing', 'retention-guarantee', 'change-growth', 'claims-limitation', 'quality-defects', 'obstacles', 'audit-findings', 'performance-rating', 'contract-health'] as const) expect(REPORT_PATHS[code]).toBe(`/ctr/ctr-28?report=${code}`);
  });
});

describe('the query of a read', () => {
  it('sends only what is chosen, with the sort and the page', () => {
    expect(queryParams(DEFAULT_QUERY)).toEqual({ sort: 'code', dir: 'asc', limit: '50' });
    const filter = { ...EMPTY_ANALYTICS_FILTER, status: 'ACTIVE', q: '  cầu ', unit: 'u1' };
    expect(queryParams({ ...DEFAULT_QUERY, filter, cursor: 'c1', limit: 20 })).toEqual({ status: 'ACTIVE', q: 'cầu', unit: 'u1', sort: 'code', dir: 'asc', limit: '20', cursor: 'c1' });
    expect(queryParams({ ...DEFAULT_QUERY, filter }, false)).not.toHaveProperty('limit');
  });

  it('makes the period and the day exclusive: a frozen period has its own day', () => {
    const both = queryParams({ ...DEFAULT_QUERY, filter: { ...EMPTY_ANALYTICS_FILTER, period: '2026-09', asOf: '2026-10-01' } });
    expect(both).toMatchObject({ period: '2026-09' });
    expect(both).not.toHaveProperty('as_of');
    expect(queryParams({ ...DEFAULT_QUERY, filter: { ...EMPTY_ANALYTICS_FILTER, asOf: '2026-10-01' } })).toMatchObject({ as_of: '2026-10-01' });
  });

  it('counts the conditions applied', () => {
    expect(filterCount(EMPTY_ANALYTICS_FILTER)).toBe(0);
    expect(filterCount({ ...EMPTY_ANALYTICS_FILTER, status: 'ACTIVE', q: 'x', fund: '  ' })).toBe(2);
  });
});

describe('reading the answer', () => {
  it('reads the portfolio: the rows, the totals the server made, the breakdown, the definitions', () => {
    const view = toReportView(portfolioBody());
    expect(view?.code).toBe('portfolio-status');
    expect(view?.items).toHaveLength(2);
    expect(view?.items[0]?.health).toEqual({ level: 'AMBER', drivers: ['DAYS_LATE'] });
    expect(view?.items[1]?.na).toEqual({ title: 'NO_ROWS' });
    expect(view?.totals.cells.contract_value_vnd).toBe('77777777777');
    expect(view?.totals.indicators.map((one) => one.code)).toEqual(['CHANGE_GROWTH', 'PAID_TO_ACCEPTED']);
    expect(view?.breakdown?.groups.map((group) => group.key)).toEqual(['DRAFT', 'ACTIVE']);
    expect(view?.definitions[0]).toMatchObject({ code: 'CHANGE_GROWTH', sourceTables: ['contract', 'change_request'] });
    expect(view?.context.freshness).toEqual({ kind: 'LIVE', stale: false, snapshot: null, latest: null });
    expect(view?.columns).toHaveLength(PORTFOLIO_COLUMNS.length);
  });

  it('refuses a body that is not what the contract says, so that a screen shows an error and never an empty table', () => {
    expect(toReportView(undefined)).toBeUndefined();
    expect(toReportView({})).toBeUndefined();
    expect(toReportView({ ...portfolioBody(), items: undefined })).toBeUndefined();
    expect(toReportView({ ...portfolioBody(), totals: { cells: {} } })).toBeUndefined();
    expect(toReportView({ ...portfolioBody(), context: { scope: 'PROVINCE' } })).toBeUndefined();
    expect(toConcentrationView({ ...concentrationBody(), rule: undefined })).toBeUndefined();
    expect(toConcentrationView({ ...concentrationBody(), dimensions: 'x' })).toBeUndefined();
    expect(toReportFile({ file_name: 'x' })).toBeUndefined();
  });

  it('leaves out a row that cannot be read instead of reading it as nothing', () => {
    const view = toReportView(portfolioBody({ items: [{ nonsense: true }, portfolioBody().items[0]] }));
    expect(view?.items).toHaveLength(1);
  });

  it('reads the context and a snapshot with its revision and the newest one', () => {
    const context = toContext({
      scope: 'GRANTED',
      as_of: '2026-11-08',
      cutoff_date: '2026-09-30',
      currency_unit: 'VND',
      freshness: { kind: 'SNAPSHOT', stale: true, snapshot: snapshot({ revision: 1, latest_revision: 2, stale: true }), latest_snapshot: snapshot({ revision: 2, latest_revision: 2 }) },
      rows: 5,
      ledger_rows: 3,
    });
    expect(context).toMatchObject({ scope: 'GRANTED', cutoffDate: '2026-09-30', rows: 5, ledgerRows: 3 });
    expect(context?.freshness).toMatchObject({ kind: 'SNAPSHOT', stale: true, snapshot: { revision: 1, latestRevision: 2, periodCode: '2026-09' }, latest: { revision: 2 } });
    expect(toSnapshotRef({ id: 'x' })).toBeNull();
  });

  it('reads the concentration with its rule, groups and the load of the contractors', () => {
    const view = toConcentrationView(concentrationBody());
    expect(view?.rule).toMatchObject({ version: 0, source: 'DEFAULT', params: { top_n: 5, hhi_red: 1800 } });
    expect(view?.dimensions[0]).toMatchObject({ dimension: 'contractor', level: 'RED', shareAnomalies: ['00000000-0000-4000-8000-001000000009'] });
    expect(view?.dimensions[1]?.topShare).toMatchObject({ value: null, reason: 'NO_ACTIVE_CONTRACT' });
    expect(view?.singleBidder).toMatchObject({ value: '33.33', level: 'AMBER' });
    expect(view?.contractors.map((load) => [load.contractorId, load.activeContracts, load.pendingAwardVnd])).toEqual([
      ['k1', 2, '0'],
      ['k3', 0, '400000000'],
    ]);
  });

  it('reads the file of an export and decodes its bytes', () => {
    const file = toReportFile({ report: 'bid-variance', format: 'csv', file_name: 'a.csv', media_type: 'text/csv', size_bytes: 3, file_sha256: 'x', row_count: 2, stale: true, content_base64: 'aGk=' });
    expect(file).toMatchObject({ fileName: 'a.csv', rowCount: 2, stale: true });
    expect(Array.from(bytesOfBase64(file?.contentBase64 ?? ''))).toEqual([104, 105]);
  });
});

describe('figures', () => {
  it('writes whole dong with the grouping of the language, sign included, and never turns text that is not whole dong into a number', () => {
    expect(moneyText('10200000000', 'vi')).toBe('10.200.000.000');
    expect(moneyText('-80000000', 'vi')).toBe('-80.000.000');
    expect(moneyText('123456789012345678901234', 'en')).toBe('123,456,789,012,345,678,901,234');
    expect(moneyText('1.5', 'vi')).toBe('1.5');
  });

  it('writes a percent with the decimal mark of the language, and a date as day, month, year', () => {
    expect(percentText('12.34', 'vi')).toBe('12,34%');
    expect(percentText('12.34', 'en')).toBe('12.34%');
    expect(dateText('2026-09-30')).toBe('30/09/2026');
    expect(dateText('soon')).toBe('soon');
  });

  it('gives the tone of a level and leaves a contract with no colour neutral, not green', () => {
    expect([healthTone('GREEN'), healthTone('AMBER'), healthTone('RED'), healthTone(null)]).toEqual(['success', 'warning', 'danger', 'neutral']);
    expect([levelTone('GREEN'), levelTone('NOT_ENOUGH_DATA')]).toEqual(['success', 'neutral']);
  });

  it('draws only the groups that have a figure: a group with none is not a bar of zero', () => {
    const view = toReportView(
      portfolioBody({
        breakdown: {
          dimension: 'contract_status',
          groups: [
            { key: 'DRAFT', totals: { rows: 1, ledger_rows: 1, cells: { contract_value_vnd: '500' }, na: {}, indicators: [] } },
            { key: 'ACTIVE', totals: { rows: 0, ledger_rows: 0, cells: { contract_value_vnd: null }, na: {}, indicators: [] } },
          ],
        },
      }),
    );
    expect(view).toBeDefined();
    if (view === undefined) return;
    expect(chartColumn(view)?.key).toBe('contract_value_vnd');
    expect(breakdownPoints(view, 'contract_value_vnd').map((point) => point.key)).toEqual(['DRAFT']);
    expect(barLength(null)).toBe(0);
  });
});

describe('the money reports of CA-2 as the screens read them', () => {
  const view = (over: Record<string, unknown>) => toReportView(portfolioBody({ code: 'schedule-delay', ...over }));

  it('reads the earned value block with its coverage and the reason of a block that has none', () => {
    const read = view({ evm: evmBody() });
    expect(read?.evm).toMatchObject({ status: 'OK', coverage: { contracts: 3, covered: 2, missing: { NO_CONTRACT_LINK: 1 }, v0Contracts: 2 }, figures: { bacVnd: '4000000000', ragSpi: 'RED' } });
    expect(read?.evm?.figures?.spi).toMatchObject({ code: 'SPI', value: '0.8000' });
    expect(view({ evm: { status: 'UNAVAILABLE', reason: 'NOT_IN_SNAPSHOT' } })?.evm).toMatchObject({ status: 'UNAVAILABLE', reason: 'NOT_IN_SNAPSHOT', figures: null, coverage: null });
    expect(view({})?.evm).toBeNull();
  });

  it('reads every breakdown and the rules, and falls back to the one breakdown of the older answer', () => {
    const many = view({ breakdowns: [{ dimension: 'a', groups: [] }, 'bad', { dimension: 'b', groups: [] }], rules: [{ type: 'CONTRACT_THREE_WAY_MATCH', version: 2, source: 'RULE', unverified: false, params: { tolerance_pct: 2, tolerance_vnd: 1, junk: null } }, 'bad'] });
    expect(many?.breakdowns.map((one) => one.dimension)).toEqual(['a', 'b']);
    expect(many?.rules).toEqual([{ type: 'CONTRACT_THREE_WAY_MATCH', version: 2, source: 'RULE', unverified: false, params: { tolerance_pct: 2, tolerance_vnd: 1 } }]);
    expect(toReportView(portfolioBody())?.breakdowns.map((one) => one.dimension)).toEqual(['contract_status']);
  });

  it('reads the tier split and the ladders, and treats a body that is neither as absent rather than as empty', () => {
    expect(view({ tier_split: { original_value_vnd: '10', total_delta_vnd: '1', total_count: 1, groups: [{ key: 'TIER_1', count: 1, delta_vnd: '1', growth: { code: 'CHANGE_TIER_GROWTH', value: '10.00' }, share_of_growth_pct: '100.00', max_cumulative_variation_pct: null }, 'bad'] } })?.tierSplit?.groups).toHaveLength(1);
    expect(view({ tier_split: { status: 'UNAVAILABLE', reason: 'NOT_IN_SNAPSHOT' } })?.tierSplit).toMatchObject({ status: 'UNAVAILABLE', reason: 'NOT_IN_SNAPSHOT' });
    expect(view({ tier_split: { groups: 'x' } })?.tierSplit).toBeNull();
    expect(view({ ladders: { retention: [{ key: 'DUE_NOW', count: 1, amount_vnd: '5' }], guarantee: [] } })?.ladders).toMatchObject({ status: 'OK', retention: [{ key: 'DUE_NOW', count: 1, amountVnd: '5' }] });
    expect(view({ ladders: { retention: 'x' } })?.ladders).toBeNull();
  });

  it('reads the S-curve answer, point by point, and refuses a body that is not one', () => {
    const read = toCurveView(curveBody());
    expect(read?.points).toHaveLength(3);
    expect(read?.points[2]).toMatchObject({ evVnd: null, acVnd: null, pvCurrentVnd: '4000000000' });
    expect(read?.v0Complete).toBe(true);
    expect(toCurveView({ evm: evmBody(), curve: { points: [{ day: '2026-01-01' }, 'bad'] } })?.points).toEqual([]);
    expect(toCurveView({ curve: { points: [] } })).toBeUndefined();
    expect(toCurveView(null)).toBeUndefined();
  });

  it('draws a breakdown by the column the report says tells its story, and writes an index with the decimal mark of the language', () => {
    const read = view({
      columns: [{ key: 'code', kind: 'TEXT', ledger: false, indicator: null, total: null }, { key: 'advance_outstanding_vnd', kind: 'MONEY', ledger: true, indicator: null, total: 'SUM' }, { key: 'advance_paid_vnd', kind: 'MONEY', ledger: true, indicator: null, total: 'SUM' }],
      code: 'advance-ageing',
    }) as NonNullable<ReturnType<typeof toReportView>>;
    expect(chartColumn(read, 'age_bucket')?.key).toBe('advance_outstanding_vnd');
    expect(chartColumn(read, 'unknown_dimension')?.key).toBe('advance_outstanding_vnd');
    expect(decimalText('0.9091', 'vi')).toBe('0,9091');
    expect(decimalText('0.9091', 'en')).toBe('0.9091');
    expect(billionsOf('2500000000')).toBe(2.5);
    expect(billionsOf(null)).toBeNull();
    expect(billionsOf('1.5')).toBeNull();
  });
});
