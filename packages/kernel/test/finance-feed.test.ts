import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { DomainError } from '../src/errors.ts';
import {
  FEED_ALERT_CODES,
  FEED_CHANNELS,
  FEED_KINDS,
  FEED_KPI_CODES,
  FEED_LAYOUT_VERSION,
  FEED_SEASONAL_CUMULATIVE,
  FINANCE_FEED_CONNECTION,
  FeedApiPushAdapter,
  FeedFileAdapter,
  FeedGeneratorAdapter,
  aggregateFeedFacts,
  assertFeedApplyAllowed,
  assertFeedLayoutKnown,
  builtInDefault,
  dryRunFeedFile,
  diffFeedFigures,
  feedAlertsFor,
  feedBatchOfRows,
  feedConnectionMove,
  feedConnectorHealth,
  feedFreshnessParamsOf,
  feedGeneratorMove,
  feedGeneratorParamsOf,
  feedInternalFindings,
  feedMappingMove,
  feedMappingRequestOf,
  feedPolicyOf,
  feedQuality,
  feedRecordOf,
  financeFeedPortFor,
  foldFeedFacts,
  generateFeedRecords,
  openFeedDifferences,
  resolveFeedDifference,
  validateFeedRecords,
} from '../src/index';
import type { FeedConnectionState, FeedDisbursementRecord, FeedGeneratorParams, FeedRecord, SourcedFeedRecord } from '../src/index';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};
const refusalAsync = async (run: () => Promise<unknown>): Promise<DomainError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const csv = (header: string[], rows: string[][]): Uint8Array => new TextEncoder().encode([header.join(','), ...rows.map((row) => row.join(','))].join('\n'));
const PROJECT_HEADER = ['feed_project_code', 'as_of', 'project_name', 'sector_code', 'district_code', 'investor_code'];
const DISBURSEMENT_HEADER = ['feed_project_code', 'fiscal_year', 'month', 'fund_code', 'disbursed_month', 'disbursed_cumulative', 'reported_on', 'as_of'];

const PARAMS: FeedGeneratorParams = { seed: 57, fiscalYear: 2026, currentMonth: 10, projectCount: 60, lateUnits: 4, delayedPct: 25, aheadPct: 15, discrepancies: 6 };
const sourced = (records: FeedRecord[], channel: SourcedFeedRecord['channel'] = 'GENERATOR'): SourcedFeedRecord[] => records.map((one) => ({ ...one, channel }));

describe('the layouts and the dry run of a file', () => {
  it('reads a valid project file row by row and writes nothing', () => {
    const run = dryRunFeedFile('PROJECT', csv(PROJECT_HEADER, [['P-1', '2026-01-10', 'Road one', 'GT', 'D01', 'CDT-1'], ['P-2', '10/01/2026', 'Road two', 'GT', 'D02', 'CDT-1']]));
    expect(run.counts).toEqual({ total: 2, valid: 2, errors: 0, duplicates: 0, conflicts: 0 });
    expect(run.acceptance).toBe('PENDING_EXTERNAL');
    expect(run.layoutVersion).toBe(FEED_LAYOUT_VERSION);
    expect(run.rows[1]?.record?.businessKey).toBe('P-2|2026-01-10');
  });

  it('says which row is wrong and why, with the field', () => {
    const run = dryRunFeedFile(
      'DISBURSEMENT',
      csv(DISBURSEMENT_HEADER, [
        ['P-1', '2026', '3', 'NSTW', '100', '300', '2026-04-02', '2026-04-02'],
        ['P-1', '2026', '13', 'NSTW', '100', '300', '2026-04-02', '2026-04-02'],
        ['P-1', '2026', '4', 'XYZ', '100', '300', '2026-05-02', '2026-05-02'],
        ['P-1', '2026', '5', 'NSTW', '500', '300', '2026-06-02', '2026-06-02'],
        ['P-1', '2026', '6', 'NSTW', '1.000', '3000', '2026-07-02', '2026-07-02'],
        ['P-1', '2026', '7', 'NSTW', '100', '300', '2026-08-09', '2026-08-02'],
      ]),
    );
    expect(run.rows.map((row) => [row.status, row.code, row.field])).toEqual([
      ['VALID', undefined, undefined],
      ['ERROR', 'MONTH_INVALID', 'month'],
      ['ERROR', 'ENUM_INVALID', 'fund_code'],
      ['ERROR', 'CUMULATIVE_BELOW_MONTH', 'disbursed_cumulative'],
      ['ERROR', 'MONEY_INVALID', 'disbursed_month'],
      ['ERROR', 'REPORTED_AFTER_AS_OF', 'reported_on'],
    ]);
  });

  it('tells a repeated row from a conflicting one, and the same day written two ways is one day', () => {
    const run = dryRunFeedFile('PROJECT', csv(PROJECT_HEADER, [['P-1', '2026-01-10', 'Road', 'GT', 'D01', 'C1'], ['P-1', '10/01/2026', 'Road', 'GT', 'D01', 'C1'], ['P-1', '2026-01-10', 'Other road', 'GT', 'D01', 'C1']]));
    expect(run.rows.map((row) => row.status)).toEqual(['VALID', 'DUPLICATE', 'CONFLICT']);
  });

  it('refuses a file without a required column, and a layout version it does not read', () => {
    expect(refusal(() => dryRunFeedFile('PLAN', csv(['feed_project_code', 'fiscal_year'], [['P-1', '2026']]))).extensions).toMatchObject({ missing_columns: ['fund_code', 'plan_amount', 'as_of'] });
    expect(refusal(() => assertFeedLayoutKnown('OFFICIAL-1')).code).toBe('FEED_LAYOUT_VERSION_UNKNOWN');
    expect(refusal(() => dryRunFeedFile('PROJECT', csv(PROJECT_HEADER, [['P-1', '2026-01-10', 'a', 'GT', 'D01', 'C1']]), 'OFFICIAL-1')).code).toBe('FEED_LAYOUT_VERSION_UNKNOWN');
  });

  it('rejects an end year before the start year and a milestone with no date', () => {
    const projects = dryRunFeedFile('PROJECT', csv([...PROJECT_HEADER, 'start_year', 'end_year'], [['P-1', '2026-01-10', 'a', 'GT', 'D01', 'C1', '2027', '2026']]));
    expect(projects.rows[0]?.code).toBe('YEARS_ORDER_INVALID');
    const milestones = dryRunFeedFile('MILESTONE', csv(['feed_project_code', 'milestone_kind', 'as_of'], [['P-1', 'CONTRACT_SIGNED', '2026-01-10']]));
    expect(milestones.rows[0]?.code).toBe('MILESTONE_DATE_REQUIRED');
  });
});

describe('the port and its three adapters', () => {
  it('reads a file through the port into a batch of typed records with a digest', async () => {
    const batch = await new FeedFileAdapter().read({ kind: 'PROJECT', file: csv(PROJECT_HEADER, [['P-1', '2026-01-10', 'Road', 'GT', 'D01', 'C1']]) });
    expect(batch.channel).toBe('FILE');
    expect(batch.records).toHaveLength(1);
    expect(batch.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(batch.acceptance).toBe('PENDING_EXTERNAL');
  });

  it('refuses the push with a named error until the machine account exists', async () => {
    const error = await refusalAsync(() => new FeedApiPushAdapter().read());
    expect([error.code, error.status]).toEqual(['FEED_API_UNAVAILABLE', 503]);
    expect(error.extensions).toMatchObject({ reason: 'MACHINE_ACCOUNT_PENDING' });
  });

  it('judges pushed rows with the very layouts a file uses', () => {
    const batch = feedBatchOfRows('PROJECT', [
      { feed_project_code: 'P-1', as_of: '2026-01-10', project_name: 'Road', sector_code: 'GT', district_code: 'D01', investor_code: 'C1' },
      { feed_project_code: 'P-1', as_of: '2026-01-10', project_name: 'Road', sector_code: 'GT', district_code: 'D01', investor_code: 'C1' },
      { feed_project_code: 'P-2', as_of: 'not a day', project_name: 'Road', sector_code: 'GT', district_code: 'D01', investor_code: 'C1' },
    ]);
    expect(batch.counts).toEqual({ total: 3, valid: 1, errors: 1, duplicates: 1, conflicts: 0 });
    expect(batch.rejected.map((row) => row.code)).toEqual(['ROW_DUPLICATE', 'DAY_INVALID']);
  });

  it('gives each channel its adapter, none of which opens a connection', () => {
    for (const channel of FEED_CHANNELS) {
      const port = financeFeedPortFor(channel);
      expect(port.channel).toBe(channel);
      expect(port.opensNetwork).toBe(false);
    }
    expect(new FeedGeneratorAdapter().adapterStatus).toBe('MOCK');
  });
});

describe('the data generator', () => {
  const records = generateFeedRecords(PARAMS);

  it('is deterministic: the same parameters give the same records, another seed gives others', async () => {
    expect(generateFeedRecords(PARAMS)).toEqual(records);
    const other = generateFeedRecords({ ...PARAMS, seed: 58 });
    expect(other).not.toEqual(records);
    const first = await new FeedGeneratorAdapter().read({ generator: PARAMS });
    const second = await new FeedGeneratorAdapter().read({ generator: PARAMS });
    expect(first.digest).toBe(second.digest);
  });

  it('produces only records that the layouts of a file accept, with unique business keys', () => {
    const verdict = validateFeedRecords(records);
    expect(verdict.rejected).toEqual([]);
    expect(new Set(records.map((one) => `${one.kind}|${one.businessKey}`)).size).toBe(records.length);
    for (const kind of FEED_KINDS) expect(records.some((one) => one.kind === kind)).toBe(true);
  });

  it('has the seasonal curve of the year: back-loaded, adding up to the whole', () => {
    expect(FEED_SEASONAL_CUMULATIVE[11]).toBe(1);
    expect(FEED_SEASONAL_CUMULATIVE[5] as number).toBeLessThan(0.4);
    expect(FEED_SEASONAL_CUMULATIVE[9] as number).toBeGreaterThan(0.65);
    const facts = foldFeedFacts(sourced(records), { fiscalYear: 2026 });
    const byMonth = aggregateFeedFacts(facts, 'month', 2026).groups;
    expect(BigInt(byMonth[11]?.disbursed ?? '0')).toBe(0n);
    expect(BigInt(byMonth[9]?.disbursed ?? '0')).toBeGreaterThan(BigInt(byMonth[0]?.disbursed ?? '0'));
  });

  it('has projects behind the curve and projects ahead of it, and units that did not report the latest month', () => {
    const facts = foldFeedFacts(sourced(records), { fiscalYear: 2026 });
    const pace = facts.map((fact) => Number((Object.values(fact.disbursedByFund).reduce((a, b) => a + b, 0n) * 1000n) / (Object.values(fact.planByFund).reduce((a, b) => a + b, 0n) || 1n)) / 1000);
    const curve = FEED_SEASONAL_CUMULATIVE[9] as number;
    expect(pace.filter((value) => value < curve * 0.75).length).toBeGreaterThan(5);
    expect(pace.filter((value) => value > curve * 1.1).length).toBeGreaterThan(2);
    const quality = feedQuality({ facts, disbursements: sourced(records), fiscalYear: 2026, month: 10, today: '2026-11-20', reportDueDays: 5, compared: 0, discrepancies: 0, findings: 0 });
    expect(quality.lateUnits.length + quality.units.filter((unit) => unit.status === 'REPORTED_LATE').length).toBeGreaterThanOrEqual(1);
    expect(quality.completeness.denominator).toBeGreaterThan(quality.completeness.numerator);
  });

  it('is stable across months: the run of the next month repeats every record of the month before and adds only what is new', () => {
    const nine = generateFeedRecords({ ...PARAMS, currentMonth: 9 });
    const ten = generateFeedRecords({ ...PARAMS, currentMonth: 10 });
    const held = new Map(ten.map((one) => [`${one.kind}|${one.businessKey}`, one.record]));
    for (const one of nine.filter((record) => record.kind !== 'MILESTONE')) expect(held.get(`${one.kind}|${one.businessKey}`)).toEqual(one.record);
    const added = ten.filter((one) => one.kind === 'DISBURSEMENT' && !nine.some((before) => before.businessKey === one.businessKey && before.kind === one.kind));
    expect(added.length).toBeGreaterThan(40);
  });

  it('plants the disagreements it was asked for and the internal check finds them', () => {
    const findings = feedInternalFindings(sourced(records), 2026);
    const codes = new Set(findings.map((finding) => finding.code));
    expect(codes.has('CUMULATIVE_MISMATCH') || codes.has('OVER_PLAN') || codes.has('RESTATED')).toBe(true);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.length).toBeLessThanOrEqual(PARAMS.discrepancies * 2);
    expect(feedInternalFindings(sourced(generateFeedRecords({ ...PARAMS, discrepancies: 0 })), 2026)).toEqual([]);
  });

  it('anchors a project on one of ours: our code, our plan, our figure, a few percent off for one in four', () => {
    const anchors = [0, 1, 2, 3].map((n) => ({ code: `OUR-${n}`, name: `Our project ${n}`, plan: '10000000000', disbursed: '4000000000' }));
    const anchored = generateFeedRecords({ ...PARAMS, projectCount: 12, discrepancies: 0, anchors });
    const facts = foldFeedFacts(sourced(anchored), { fiscalYear: 2026 })
      .filter((fact) => fact.ourProjectCode !== null)
      .sort((a, b) => ((a.ourProjectCode as string) < (b.ourProjectCode as string) ? -1 : 1));
    expect(facts.map((fact) => fact.ourProjectCode)).toEqual(['OUR-0', 'OUR-1', 'OUR-2', 'OUR-3']);
    const totals = facts.map((fact) => [Object.values(fact.planByFund).reduce((a, b) => a + b, 0n), Object.values(fact.disbursedByFund).reduce((a, b) => a + b, 0n)]);
    for (const [plan] of totals) expect(plan).toBe(1_000_000_000_000n);
    expect(totals[0]?.[1]).toBe(400_000_000_000n);
    expect(totals[3]?.[1]).toBe(424_000_000_000n);
  });

  it('validates its parameters and takes the previous month by default', () => {
    expect(feedGeneratorParamsOf({}, '2026-11-08')).toMatchObject({ fiscalYear: 2026, currentMonth: 10, projectCount: 120 });
    expect(feedGeneratorParamsOf({}, '2026-01-08')).toMatchObject({ fiscalYear: 2025, currentMonth: 12 });
    expect(refusal(() => feedGeneratorParamsOf({ current_month: 13 }, '2026-11-08')).detail).toBe('current_month');
    expect(refusal(() => feedGeneratorParamsOf({ delayed_pct: 70, ahead_pct: 40 }, '2026-11-08')).detail).toBe('ahead_pct');
  });
});

describe('the reader of the facts', () => {
  const rows = (): SourcedFeedRecord[] =>
    sourced([
      feedRecordOf('PROJECT', { feedProjectCode: 'P-1', asOf: '2026-01-10', projectName: 'One', sectorCode: 'GT', districtCode: 'D01', investorCode: 'C1', investorName: 'Investor one', totalInvestment: null, startYear: null, endYear: null, projectStatus: 'ACTIVE', ourProjectCode: null }),
      feedRecordOf('PROJECT', { feedProjectCode: 'P-2', asOf: '2026-01-10', projectName: 'Two', sectorCode: 'YT', districtCode: 'D02', investorCode: 'C2', investorName: 'Investor two', totalInvestment: null, startYear: null, endYear: null, projectStatus: 'ACTIVE', ourProjectCode: null }),
      feedRecordOf('PLAN', { feedProjectCode: 'P-1', fiscalYear: 2026, fundCode: 'NSTW', planAmount: '1000', asOf: '2026-01-20', decisionNo: null }),
      feedRecordOf('PLAN', { feedProjectCode: 'P-1', fiscalYear: 2026, fundCode: 'NSTW', planAmount: '1200', asOf: '2026-06-30', decisionNo: null }),
      feedRecordOf('PLAN', { feedProjectCode: 'P-2', fiscalYear: 2026, fundCode: 'NSDP', planAmount: '500.50', asOf: '2026-01-20', decisionNo: null }),
      feedRecordOf('DISBURSEMENT', { feedProjectCode: 'P-1', fiscalYear: 2026, month: 1, fundCode: 'NSTW', disbursedMonth: '100', disbursedCumulative: '100', reportedOn: '2026-02-03', asOf: '2026-02-03' }),
      feedRecordOf('DISBURSEMENT', { feedProjectCode: 'P-1', fiscalYear: 2026, month: 2, fundCode: 'NSTW', disbursedMonth: '200', disbursedCumulative: '300', reportedOn: '2026-03-03', asOf: '2026-03-03' }),
      feedRecordOf('DISBURSEMENT', { feedProjectCode: 'P-2', fiscalYear: 2026, month: 1, fundCode: 'NSDP', disbursedMonth: '50.25', disbursedCumulative: '50.25', reportedOn: '2026-02-08', asOf: '2026-02-08' }),
    ]);

  it('folds a later statement over an earlier one and keeps exact amounts', () => {
    const facts = foldFeedFacts(rows(), { fiscalYear: 2026 });
    const one = facts.find((fact) => fact.feedProjectCode === 'P-1');
    expect(one?.planByFund).toEqual({ NSTW: 120_000n });
    expect(one?.disbursedByFund).toEqual({ NSTW: 30_000n });
    expect(one?.latestMonth).toBe(2);
    const earlier = foldFeedFacts(rows(), { fiscalYear: 2026, asOf: '2026-03-01' }).find((fact) => fact.feedProjectCode === 'P-1');
    expect(earlier?.planByFund).toEqual({ NSTW: 100_000n });
    expect(earlier?.disbursedByFund).toEqual({ NSTW: 10_000n });
  });

  it('groups by sector, district, investor, fund and month with rates and the channel tag', () => {
    const facts = foldFeedFacts(rows(), { fiscalYear: 2026 });
    const bySector = aggregateFeedFacts(facts, 'sector', 2026);
    expect(bySector.groups.map((group) => [group.key, group.label, group.plan, group.disbursed, group.ratePct])).toEqual([
      ['GT', 'Giao thông', '1200', '300', '25.00'],
      ['YT', 'Y tế', '500.5', '50.25', '10.04'],
    ]);
    expect(bySector.totals.plan).toBe('1700.5');
    expect(bySector.channels).toEqual(['GENERATOR']);
    expect(aggregateFeedFacts(facts, 'fund', 2026).groups.map((group) => group.key)).toEqual(['NSDP', 'NSTW']);
    expect(aggregateFeedFacts(facts, 'investor', 2026).groups[0]?.label).toBe('Investor one');
    const months = aggregateFeedFacts(facts, 'month', 2026).groups;
    expect([months[0]?.disbursed, months[1]?.disbursed, months[1]?.cumulative]).toEqual(['150.25', '200', '350.25']);
    expect(foldFeedFacts(rows(), { fiscalYear: 2026, sector: 'YT' }).map((fact) => fact.feedProjectCode)).toEqual(['P-2']);
    expect(foldFeedFacts(rows(), { fiscalYear: 2026, fund: 'NSDP' }).map((fact) => fact.feedProjectCode)).toEqual(['P-2']);
  });

  it('tells apart records of different channels and carries the tag', () => {
    const mixed = [...sourced(rows().slice(0, 2), 'FILE'), ...rows().slice(2)];
    expect(aggregateFeedFacts(foldFeedFacts(mixed, { fiscalYear: 2026 }), 'sector', 2026).channels.sort()).toEqual(['FILE', 'GENERATOR']);
  });

  it('finds the disagreements inside the feed itself', () => {
    const more: SourcedFeedRecord[] = [
      ...rows(),
      ...sourced([feedRecordOf('DISBURSEMENT', { feedProjectCode: 'P-1', fiscalYear: 2026, month: 1, fundCode: 'NSTW', disbursedMonth: '150', disbursedCumulative: '150', reportedOn: '2026-03-10', asOf: '2026-03-10' } as FeedDisbursementRecord)]),
      ...sourced([feedRecordOf('DISBURSEMENT', { feedProjectCode: 'P-9', fiscalYear: 2026, month: 1, fundCode: 'NSTW', disbursedMonth: '10', disbursedCumulative: '10', reportedOn: '2026-02-03', asOf: '2026-02-03' })]),
    ];
    const codes = feedInternalFindings(more, 2026).map((finding) => `${finding.code}:${finding.feedProjectCode}`);
    expect(codes).toContain('RESTATED:P-1');
    expect(codes).toContain('UNKNOWN_PROJECT:P-9');
    expect(codes).toContain('CUMULATIVE_MISMATCH:P-1');
  });

  it('measures completeness, timeliness and who is late', () => {
    const facts = foldFeedFacts(rows(), { fiscalYear: 2026 });
    const quality = feedQuality({ facts, disbursements: rows(), fiscalYear: 2026, month: 1, today: '2026-02-20', reportDueDays: 5, compared: 4, discrepancies: 1, findings: 0 });
    expect(quality.dueOn).toBe('2026-02-05');
    expect(quality.units.map((unit) => [unit.investorCode, unit.status])).toEqual([['C1', 'REPORTED_ON_TIME'], ['C2', 'REPORTED_LATE']]);
    expect(quality.completeness.pct).toBe('100.00');
    expect(quality.timeliness).toMatchObject({ pct: '50.00', numerator: 1, denominator: 2 });
    expect(quality.discrepancy.pct).toBe('25.00');
    const march = feedQuality({ facts, disbursements: rows(), fiscalYear: 2026, month: 3, today: '2026-04-20', reportDueDays: 5, compared: 0, discrepancies: 0, findings: 0 });
    expect(march.lateUnits.map((unit) => unit.investorCode)).toEqual(['C1', 'C2']);
    expect(march.completeness.pct).toBe('0.00');
    const before = feedQuality({ facts, disbursements: rows(), fiscalYear: 2026, month: 3, today: '2026-04-02', reportDueDays: 5, compared: 0, discrepancies: 0, findings: 0 });
    expect(before.units.map((unit) => unit.status)).toEqual(['PENDING', 'PENDING']);
    expect(before.discrepancy.pct).toBeNull();
  });
});

describe('the rules of the connection and the generator', () => {
  const state = (over: Partial<FeedConnectionState> = {}): FeedConnectionState => ({ enabled: true, version: 1, generatorState: 'STOPPED', generatorEpoch: 0, generatorMonth: null, ...over });
  const REASON = 'A reason of enough length.';

  it('switches the connection with a reason and refuses a move to the state it is in', () => {
    expect(feedConnectionMove(state(), { enabled: false, reason: REASON })).toEqual({ enabled: false, reason: REASON });
    expect(refusal(() => feedConnectionMove(state(), { enabled: true, reason: REASON })).detail).toBe('enabled');
    expect(refusal(() => feedConnectionMove(state(), { enabled: false, reason: 'short' })).detail).toBe('reason');
    expect(refusal(() => assertFeedApplyAllowed({ enabled: false })).code).toBe('FEED_CONNECTION_DISABLED');
  });

  it('walks the life of the generator and refuses the moves out of order', () => {
    const start = feedGeneratorMove(state(), { action: 'START', reason: REASON, body: { seed: 5 }, today: '2026-11-08', stored: null });
    expect([start.state, start.epoch, start.params?.seed, start.params?.currentMonth]).toEqual(['RUNNING', 1, 5, 10]);
    expect(refusal(() => feedGeneratorMove(state({ generatorState: 'RUNNING' }), { action: 'START', reason: REASON, body: {}, today: '2026-11-08', stored: null })).code).toBe('FEED_GENERATOR_STATE_INVALID');
    expect(refusal(() => feedGeneratorMove(state(), { action: 'STOP', reason: REASON, body: {}, today: '2026-11-08', stored: null })).code).toBe('FEED_GENERATOR_STATE_INVALID');
    expect(refusal(() => feedGeneratorMove(state({ enabled: false }), { action: 'START', reason: REASON, body: {}, today: '2026-11-08', stored: null })).detail).toBe('connection');
    const running = state({ generatorState: 'RUNNING', generatorEpoch: 1 });
    const tick = feedGeneratorMove(running, { action: 'TICK', reason: REASON, body: {}, today: '2026-11-08', stored: PARAMS });
    expect(tick.params?.currentMonth).toBe(11);
    expect(refusal(() => feedGeneratorMove(running, { action: 'TICK', reason: REASON, body: {}, today: '2026-11-08', stored: { ...PARAMS, currentMonth: 12 } })).detail).toBe('year_complete');
    const reseed = feedGeneratorMove(running, { action: 'RESEED', reason: REASON, body: { seed: 99 }, today: '2026-11-08', stored: PARAMS });
    expect([reseed.state, reseed.epoch, reseed.params?.seed, reseed.params?.fiscalYear]).toEqual(['RUNNING', 2, 99, 2026]);
    expect(refusal(() => feedGeneratorMove(running, { action: 'RESEED', reason: REASON, body: {}, today: '2026-11-08', stored: PARAMS })).detail).toBe('seed');
    expect(feedGeneratorMove(running, { action: 'STOP', reason: REASON, body: {}, today: '2026-11-08', stored: PARAMS }).state).toBe('STOPPED');
  });

  it('keeps the maker apart from the checker on a mapping, and the states in order', () => {
    expect(feedMappingMove({ status: 'PROPOSED', proposedBy: 'a' }, { move: 'APPROVE', actorId: 'b', reason: REASON }).to).toBe('ACTIVE');
    expect(refusal(() => feedMappingMove({ status: 'PROPOSED', proposedBy: 'a' }, { move: 'APPROVE', actorId: 'a', reason: REASON })).code).toBe('SELF_APPROVAL_DENIED');
    expect(refusal(() => feedMappingMove({ status: 'ACTIVE', proposedBy: 'a' }, { move: 'APPROVE', actorId: 'b', reason: REASON })).code).toBe('FEED_MAPPING_STATE_INVALID');
    expect(feedMappingMove({ status: 'ACTIVE', proposedBy: 'a' }, { move: 'RETIRE', actorId: 'a', reason: REASON }).to).toBe('RETIRED');
    expect(feedMappingRequestOf({ our_code: ' PRJ-1 ', external_code: 'P-1' })).toMatchObject({ ourCode: 'PRJ-1', externalCode: 'P-1', method: 'MANUAL' });
    expect(refusal(() => feedMappingRequestOf({ our_code: 'PRJ-1', external_code: 'P-1', valid_from: '2026-02-01', valid_until: '2026-01-01' })).detail).toBe('valid_until');
  });

  it('computes the health against the freshness line', () => {
    const params = feedFreshnessParamsOf({ max_age_hours: 48, warn_after_hours: 24, stale_severity: 'ACTION', figures_blocked_when_stale: false });
    const now = new Date('2026-11-08T12:00:00Z');
    expect(feedConnectorHealth({ lastRunAt: null, now, params }).status).toBe('NEVER_RECEIVED');
    expect(feedConnectorHealth({ lastRunAt: new Date('2026-11-08T00:00:00Z'), now, params }).status).toBe('FRESH');
    expect(feedConnectorHealth({ lastRunAt: new Date('2026-11-07T00:00:00Z'), now, params }).status).toBe('AGING');
    const stale = feedConnectorHealth({ lastRunAt: new Date('2026-11-01T00:00:00Z'), now, params });
    expect([stale.status, stale.alert?.code, stale.alert?.severity]).toEqual(['STALE', 'FEED_STALE', 'ACTION']);
    expect(refusal(() => feedFreshnessParamsOf({ max_age_hours: 0 })).code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
  });

  it('raises the three alerts and none for a connection that was switched off', () => {
    const params = feedFreshnessParamsOf({ max_age_hours: 48, warn_after_hours: 24, stale_severity: 'WATCH', figures_blocked_when_stale: false });
    const health = feedConnectorHealth({ lastRunAt: new Date('2026-11-01T00:00:00Z'), now: new Date('2026-11-08T00:00:00Z'), params });
    const alerts = feedAlertsFor({ enabled: true, health, lateUnits: ['C1'], largeOpenDifferences: ['P-1|2026|PLAN_VS_DIS'] });
    expect(alerts.map((alert) => [alert.code, alert.severity])).toEqual([['FEED_STALE', 'WATCH'], ['FEED_UNIT_LATE', 'WATCH'], ['FEED_DISCREPANCY_LARGE', 'ACTION']]);
    expect(feedAlertsFor({ enabled: false, health, lateUnits: ['C1'], largeOpenDifferences: [] })).toEqual([]);
  });
});

describe('the comparison of the feed with our own figures', () => {
  const policy = { tolerance_pct: 0.5, large_discrepancy_pct: 5 };
  const feed = { plan: '1000000', disbursed: '400000' };

  it('finds only what is off by more than the tolerance and calls the large ones large', () => {
    const same = diffFeedFigures({ feed, ours: { planDis: '1000000', disbursedDis: '400000', disbursedTreasury: '399000' }, policy });
    expect(same.differences).toEqual([]);
    expect(same.compared).toBe(3);
    const off = diffFeedFigures({ feed, ours: { planDis: '1000000', disbursedDis: '380000', disbursedTreasury: '399000' }, policy });
    expect(off.differences).toEqual([{ field: 'DISBURSED_VS_DIS', kind: 'VALUE_MISMATCH', feed: '400000', ours: '380000', delta: '20000', deltaPct: '5.26', large: true }]);
    const small = diffFeedFigures({ feed, ours: { planDis: '1000000', disbursedDis: '397000', disbursedTreasury: null }, policy });
    expect(small.differences[0]).toMatchObject({ field: 'DISBURSED_VS_DIS', deltaPct: '0.76', large: false });
    expect(small.compared).toBe(2);
  });

  it('treats a plan we lack as a difference and a figure we lack as not compared', () => {
    const none = diffFeedFigures({ feed, ours: { planDis: null, disbursedDis: null, disbursedTreasury: null }, policy });
    expect(none.differences.map((one) => [one.field, one.kind])).toEqual([['PLAN_VS_DIS', 'MISSING_OURS']]);
    const zero = diffFeedFigures({ feed, ours: { planDis: '0', disbursedDis: null, disbursedTreasury: null }, policy });
    expect(zero.differences[0]).toMatchObject({ kind: 'VALUE_MISMATCH', deltaPct: null, large: true });
  });

  it('opens an item per difference for an owner who is not a maker, and settles it with a reason', () => {
    const differences = diffFeedFigures({ feed, ours: { planDis: '900000', disbursedDis: null, disbursedTreasury: null }, policy }).differences;
    const base = { feedProjectCode: 'P-1', fiscalYear: 2026, differences, ownerId: 'owner', makerIds: ['maker'], openedAt: new Date('2026-11-08T00:00:00Z'), dueAt: new Date('2026-11-15T00:00:00Z') };
    expect(refusal(() => openFeedDifferences({ ...base, ownerId: 'maker' })).detail).toBe('owner_id');
    expect(refusal(() => openFeedDifferences({ ...base, dueAt: base.openedAt })).detail).toBe('due_at');
    const [item] = openFeedDifferences(base);
    if (item === undefined) throw new Error('no item');
    const at = new Date('2026-11-09T00:00:00Z');
    expect(refusal(() => resolveFeedDifference(item, { kind: 'KEEP_OURS', resolvedById: 'maker', at, reason: 'Ours is right, checked.' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(refusal(() => resolveFeedDifference(item, { kind: 'DISPUTE', resolvedById: 'owner', at, reason: 'This is wrong and we say so now.' })).detail).toBe('evidence_ref');
    expect(refusal(() => resolveFeedDifference(item, { kind: 'WAIVE', resolvedById: 'owner', at, reason: 'Leave it for now, small amount.', reviewOn: '2026-11-09' })).detail).toBe('review_on');
    expect(refusal(() => resolveFeedDifference(item, { kind: 'ACCEPT_FEED', resolvedById: 'owner', at, reason: 'short' })).detail).toBe('reason');
    const done = resolveFeedDifference(item, { kind: 'WAIVE', resolvedById: 'owner', at, reason: 'Leave it for now, small amount.', reviewOn: '2026-12-01' });
    expect([done.state, done.resolution?.reviewOn]).toEqual(['RESOLVED', '2026-12-01']);
    expect(refusal(() => resolveFeedDifference(done, { kind: 'KEEP_OURS', resolvedById: 'owner', at, reason: 'Again, a second time.' })).code).toBe('FEED_DIFFERENCE_STATE_INVALID');
    expect(feedPolicyOf({ tolerance_pct: 0.5, large_discrepancy_pct: 5, report_due_days: 5, difference_due_days: 7 }).report_due_days).toBe(5);
    expect(refusal(() => feedPolicyOf({ tolerance_pct: 9, large_discrepancy_pct: 5, report_due_days: 5, difference_due_days: 7 })).code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
  });
});

describe('the rules registered for the feed', () => {
  it('registers the policy, the freshness line, the three indicators and the three alert types, each with its words', () => {
    expect(builtInDefault('FINANCE_FEED_POLICY', 'DEFAULT')?.params).toMatchObject({ report_due_days: 5 });
    expect(builtInDefault('CONNECTOR_FRESHNESS', 'FIN_FEED')?.params).toMatchObject({ max_age_hours: 48 });
    for (const code of Object.values(FEED_KPI_CODES)) {
      const kpi = builtInDefault('KPI_DEFINITION', code);
      expect(kpi?.params.formula).toEqual(expect.any(String));
      expect(kpi?.params.source).toEqual(expect.any(String));
      expect(kpi?.params.numerator).toEqual(expect.any(String));
      expect(kpi?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const code of FEED_ALERT_CODES) {
      const alert = builtInDefault('ALERT_TYPE', code);
      expect(alert?.params.owner).toEqual(expect.any(String));
      expect(String(alert?.params.expected_action).length).toBeGreaterThan(10);
      expect(String(alert?.params.consequence).length).toBeGreaterThan(10);
    }
  });

  it('describes the connection for the hub in one constant with no egress', () => {
    expect(FINANCE_FEED_CONNECTION).toMatchObject({ code: 'fin.sotaichinh', egressPolicy: 'NONE', transportModes: ['FILE', 'API_PUSH', 'GENERATOR'] });
    expect(FINANCE_FEED_CONNECTION.alertTypes).toEqual([...FEED_ALERT_CODES]);
  });
});

describe('no connection leaves the machine', () => {
  const attempts: string[] = [];
  const fail =
    (name: string) =>
    (): never => {
      attempts.push(name);
      throw new Error(`network call attempted: ${name}`);
    };
  const spies: jest.SpyInstance[] = [];
  const watch = (target: object, property: string, name: string): void => {
    spies.push(jest.spyOn(target as Record<string, (...args: unknown[]) => unknown>, property).mockImplementation(fail(name)));
  };
  beforeEach(() => {
    attempts.length = 0;
    watch(globalThis, 'fetch', 'fetch');
    watch(net, 'connect', 'net.connect');
    watch(net, 'createConnection', 'net.createConnection');
    watch(net.Socket.prototype, 'connect', 'net.Socket#connect');
    watch(tls, 'connect', 'tls.connect');
    watch(http, 'request', 'http.request');
    watch(http, 'get', 'http.get');
    watch(https, 'request', 'https.request');
    watch(https, 'get', 'https.get');
    watch(dns, 'lookup', 'dns.lookup');
    watch(dns, 'resolve', 'dns.resolve');
    watch(dgram, 'createSocket', 'dgram.createSocket');
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('proves the watch works', () => {
    expect(() => fetch('https://example.invalid/')).toThrow('network call attempted: fetch');
    expect(() => net.connect(443, 'example.invalid')).toThrow('network call attempted');
    expect(() => dns.lookup('example.invalid', () => undefined)).toThrow('network call attempted');
    expect(attempts).toEqual(['fetch', 'net.connect', 'dns.lookup']);
  });

  it('runs the three adapters, the layouts, the generator, the reader and the rules and opens none', async () => {
    await new FeedFileAdapter().read({ kind: 'PROJECT', file: csv(PROJECT_HEADER, [['P-1', '2026-01-10', 'Road', 'GT', 'D01', 'C1']]) });
    await refusalAsync(() => financeFeedPortFor('API_PUSH').read({}));
    const batch = await financeFeedPortFor('GENERATOR').read({ generator: PARAMS });
    const facts = foldFeedFacts(sourced(batch.records), { fiscalYear: 2026 });
    aggregateFeedFacts(facts, 'district', 2026);
    feedInternalFindings(sourced(batch.records), 2026);
    feedQuality({ facts, disbursements: sourced(batch.records), fiscalYear: 2026, month: 10, today: '2026-11-08', reportDueDays: 5, compared: 0, discrepancies: 0, findings: 0 });
    diffFeedFigures({ feed: { plan: '1', disbursed: '1' }, ours: { planDis: '2', disbursedDis: null, disbursedTreasury: null }, policy: { tolerance_pct: 0.5, large_discrepancy_pct: 5 } });
    expect(attempts).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('imports no module that can open a connection and calls no fetch: the sources say so', () => {
    for (const file of ['finance-feed.ts', 'finance-feed-model.ts', 'finance-feed-generator.ts', 'finance-feed-facts.ts', 'finance-feed-management.ts', 'finance-feed-connection.ts']) {
      const source = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/from\s+'node:(net|tls|http|https|http2|dns|dgram|child_process|cluster|worker_threads)'/);
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|require\s*\(|import\s*\(/);
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] as string);
      expect(imports.filter((specifier) => !specifier.startsWith('./'))).toEqual([]);
    }
  });
});
