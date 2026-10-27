import { describe, expect, it } from 'vitest';
import { NSDP, NSTW, ODA, line } from '../cap/test-support';
import { billionsText, ctmtqgAmounts, fundingOf, fundingYears, isSubsetSource, toFundingRow } from './funding-model';
import type { FundingRow } from './funding-model';

const BILLION = 1_000_000_000;
const vnd = (billions: number): string => String(billions * BILLION);
const row = (n: number, overrides: Record<string, unknown> = {}): FundingRow => toFundingRow(line(n, overrides)) as FundingRow;
const NO_LINES = ctmtqgAmounts([], undefined);
const planLine = (appropriation: string, part: number, overrides: Record<string, unknown> = {}) => ({ plan_status: 'PUBLISHED', appropriation: { id: appropriation }, amount_vnd: vnd(part * 2), ctmtqg_subset_vnd: vnd(part), ...overrides });

describe('the funding structure of a year (HOME 3 F6)', () => {
  it('AC-ST-HOME-005-1: UAT-AC269 gives 500 billion to NSTW with 40 billion of it CTMTQG, and the 40 billion is in no total', () => {
    const nstw = row(1, { amount_vnd: vnd(500) });
    const rows = [nstw, row(2, { fund_source: NSDP, amount_vnd: vnd(100), origin: 'LOCAL_ADDED', budget_level: 'LOCAL' })];
    const subsets = ctmtqgAmounts(rows, [planLine(nstw.id, 40)]);
    const funding = fundingOf(rows, 2026, subsets);
    const card = funding.sources.find((source) => source.category === 'NSTW');
    expect(card).toMatchObject({ vnd: vnd(500), count: 1, subset: { vnd: vnd(40), partial: false } });
    expect(funding.totalVnd).toBe(vnd(600));
    expect(funding.origins.find((origin) => origin.origin === 'PM_ASSIGNED')?.vnd).toBe(vnd(500));
    // The detail says the part is a part of NSTW, under the appropriation it is inside, and counts only the appropriations.
    expect(funding.rows.map((detail) => [detail.category, detail.vnd, detail.subsetOf])).toEqual([
      ['NSTW', vnd(500), null],
      ['CTMTQG', vnd(40), 'NSTW'],
      ['NSDP', vnd(100), null],
    ]);
    expect(funding.rows.filter((detail) => detail.subsetOf === null).reduce((sum, detail) => sum + BigInt(detail.vnd), 0n)).toBe(BigInt(funding.totalVnd ?? '0'));
  });

  it('AC-ST-HOME-005-2: says there is no data where nothing is published or the plan is not read, and never zero', () => {
    const none = fundingOf([], 2026, NO_LINES);
    expect(none.totalVnd).toBeNull();
    expect(none.sources.map((source) => [source.category, source.vnd])).toEqual([['NSTW', null], ['NSDP', null], ['ODA', null]]);
    expect(none.origins.every((origin) => origin.vnd === null && origin.count === 0)).toBe(true);
    expect(none.sources[0]?.subset).toEqual({ vnd: null, partial: false });
    // The lines could not be read: the part is not known, and is not said to be zero.
    const unknown = fundingOf([row(1, { amount_vnd: vnd(500) })], 2026, NO_LINES);
    expect(unknown.sources[0]).toMatchObject({ vnd: vnd(500), subset: { vnd: null, partial: false } });
    // The lines were read and none of them draws on the appropriation: the part is known, and it is zero.
    const rows = [row(1)];
    expect(fundingOf(rows, 2026, ctmtqgAmounts(rows, [])).sources[0]?.subset).toEqual({ vnd: '0', partial: false });
  });

  it('AC-ST-HOME-005-1: reads the part from the lines of every published plan that draws on the appropriation, whether or not the register names a plan', () => {
    // The register form never names a plan: the lines are what say which plans draw on the appropriation, and there can be several.
    const nstw = row(1, { amount_vnd: vnd(300), capital_plan_id: null });
    const other = row(2, { amount_vnd: vnd(200), origin: 'CARRYOVER' });
    const subsets = ctmtqgAmounts([nstw, other], [planLine(nstw.id, 25), planLine(nstw.id, 10), planLine(other.id, 7), planLine('00000000-0000-4000-8000-0000000000ff', 99)]);
    expect(subsets.get(nstw.id)).toBe(vnd(35));
    expect(subsets.get(other.id)).toBe(vnd(7));
    expect(subsets.has('00000000-0000-4000-8000-0000000000ff')).toBe(false);
    expect(fundingOf([nstw, other], 2026, subsets).sources[0]?.subset).toEqual({ vnd: vnd(42), partial: false });
  });

  it('counts only published capital of the year, and only the lines of a published plan for the part that is CTMTQG', () => {
    const published = row(1);
    const draft = row(2, { status: 'DRAFT', amount_vnd: vnd(7) });
    const superseded = row(3, { status: 'SUPERSEDED', amount_vnd: vnd(8) });
    const other = row(4, { plan_year: 2025, amount_vnd: vnd(9) });
    const funding = fundingOf([published, draft, superseded, other], 2026, ctmtqgAmounts([published], [planLine(published.id, 3, { plan_status: 'DRAFT' }), planLine(published.id, 4), planLine(published.id, 5, { plan_status: 'SUPERSEDED' }), planLine(published.id, 6, { ctmtqg_subset_vnd: 'x' })]));
    expect(funding.totalVnd).toBe(vnd(10));
    expect(funding.sources[0]?.subset?.vnd).toBe(vnd(4));
    expect(fundingYears([published, draft, superseded, other])).toEqual([2026, 2025]);
    expect(fundingYears([draft])).toEqual([]);
  });

  it('shows a fund source that is a part of another as a part of NSTW and adds it to nothing', () => {
    const ctmtqg = { ...NSTW, business_key: 'CTMTQG-NTM', label: 'CTMTQG xây dựng nông thôn mới', category: 'CTMTQG', relation: 'SUBSET_OF' };
    const parts = row(3, { fund_source: ctmtqg, amount_vnd: vnd(40) });
    expect(isSubsetSource(parts)).toBe(true);
    const funding = fundingOf([row(1, { amount_vnd: vnd(500) }), parts], 2026, NO_LINES);
    expect(funding.totalVnd).toBe(vnd(500));
    expect(funding.sources.map((source) => source.category)).not.toContain('CTMTQG');
    expect(funding.sources[0]?.subset).toEqual({ vnd: vnd(40), partial: true });
    expect(funding.rows.at(-1)).toMatchObject({ category: 'CTMTQG', vnd: vnd(40), subsetOf: 'NSTW' });
  });

  it('draws ODA and the other sources and the five origins, each card with the capital of its own and none shared between sources', () => {
    const rows = [row(1, { fund_source: ODA, amount_vnd: vnd(50), origin: 'PM_ASSIGNED' }), row(2, { fund_source: { ...NSDP, category: 'OTHER' }, amount_vnd: vnd(5), origin: 'REVENUE_INCREASE' }), row(3, { origin: 'CENTRAL_SUPPORT', amount_vnd: vnd(12) })];
    const funding = fundingOf(rows, 2026, NO_LINES);
    expect(funding.sources.map((source) => [source.category, source.vnd])).toEqual([['NSTW', vnd(12)], ['NSDP', null], ['ODA', vnd(50)], ['OTHER', vnd(5)]]);
    expect(funding.origins.map((origin) => [origin.origin, origin.vnd])).toEqual([['PM_ASSIGNED', vnd(50)], ['LOCAL_ADDED', null], ['CARRYOVER', null], ['CENTRAL_SUPPORT', vnd(12)], ['REVENUE_INCREASE', vnd(5)]]);
    expect(funding.totalVnd).toBe(vnd(67));
  });

  it('leaves out an entry the register would not accept, and reads the plan of the others', () => {
    expect(toFundingRow({ id: 'x' })).toBeUndefined();
    expect(row(1).id).toBeTruthy();
  });
});

describe('an amount in billions, exactly and never rounded up', () => {
  it('writes whole VND as billions with two decimals at most, the grouping and the mark of the language', () => {
    expect(billionsText('500000000000', 'vi')).toBe('500');
    expect(billionsText('40000000000', 'en')).toBe('40');
    expect(billionsText('1234567890123', 'vi')).toBe('1.234,56');
    expect(billionsText('1234567890123', 'en')).toBe('1,234.56');
    expect(billionsText('999999999', 'vi')).toBe('0,99');
    expect(billionsText('0', 'vi')).toBe('0');
    expect(billionsText('not an amount', 'vi')).toBe('not an amount');
  });
});
