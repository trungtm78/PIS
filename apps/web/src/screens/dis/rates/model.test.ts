import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { describeRates, passesWhole, ratesQueryOf, toRates, totalOf } from './model';
import type { RateGroup } from './model';
import { SNAPSHOT, groupRecord, ratesRecord } from './rates-test-support';

describe('the two disbursement rates (DIS-19, DIS-12, DIS-16)', () => {
  it('reads the answer with its groups, a figure nobody has as null and a reason that is one of the three', () => {
    const rates = toRates(ratesRecord({ groups: [groupRecord('P-1'), groupRecord('P-2', { numerator_disbursed_vnd: null, rate_pm_pct: null, rate_total_pct: null, rate_null_reason: 'ZERO_DENOMINATOR' })] }));
    expect(rates).toMatchObject({ snapshotId: SNAPSHOT, definition: 'PROPOSED_PENDING_SIGNOFF', basis: 'CURRENT_YEAR', numeratorVnd: '600000000', ratePmPct: '60.0000', rateTotalPct: '48.0000', nullReason: null, coverage: 'COMPLETE', cutoffDate: '2027-01-10' });
    expect(rates?.groups).toHaveLength(2);
    expect(rates?.groups[1]).toMatchObject({ code: 'P-2', numeratorVnd: null, ratePmPct: null, nullReason: 'ZERO_DENOMINATOR' });
    expect(toRates(ratesRecord({ rate_null_reason: 'SOMETHING' }))?.nullReason).toBeNull();
  });

  it('refuses an answer that lacks what the screens need or names a definition, a basis or a coverage it does not know', () => {
    for (const bad of [{ snapshot_id: undefined }, { definition_status: 'MAYBE' }, { basis: 'OTHER' }, { treasury_cutoff_date: undefined }, { treasury_coverage: 'ALMOST' }, { plan_pm_assigned_vnd: undefined }, { projects: -1 }]) {
      expect(toRates(ratesRecord(bad))).toBeUndefined();
    }
    expect(toRates(null)).toBeUndefined();
    expect(toRates([])).toBeUndefined();
    expect(toRates(ratesRecord({ groups: [{ id: 'x' }, groupRecord('P-1')] }))?.groups).toHaveLength(1);
  });

  it('asks in the words of the contract and sends nothing that was not asked for', () => {
    expect(ratesQueryOf({ basis: 'CURRENT_YEAR' })).toEqual({ bucket: 'CURRENT_YEAR' });
    expect(ratesQueryOf({ snapshotId: '', unitId: '', projectId: '', basis: 'CARRYOVER', groupBy: 'UNIT' })).toEqual({ bucket: 'CARRYOVER', group_by: 'UNIT' });
    expect(ratesQueryOf({ snapshotId: 's', unitId: 'u', projectId: 'p', basis: 'CURRENT_YEAR', groupBy: 'PROJECT' })).toEqual({ snapshot_id: 's', unit_id: 'u', project_id: 'p', bucket: 'CURRENT_YEAR', group_by: 'PROJECT' });
  });

  it('says a rate passes 100% only when it does', () => {
    expect(passesWhole('100.0000')).toBe(false);
    expect(passesWhole('100.0001')).toBe(true);
    expect(passesWhole(null)).toBe(false);
  });

  it('adds up the rows the way a total row is made: the sums, with a numerator that is null only when no row has one', () => {
    const rows = [groupRecord('A', { numerator_disbursed_vnd: null }), groupRecord('B')].map((raw) => toRates({ ...ratesRecord({ groups: [raw] }) })?.groups[0]) as RateGroup[];
    expect(totalOf(rows)).toEqual({ numeratorVnd: '600000000', planPmVnd: '2000000000', planLocalVnd: '500000000', projects: 2 });
    expect(totalOf([rows[0] as RateGroup]).numeratorVnd).toBeNull();
    expect(totalOf([])).toEqual({ numeratorVnd: null, planPmVnd: '0', planLocalVnd: '0', projects: 0 });
  });

  it('puts a refusal of the server into the sentence of the screen', () => {
    const refuse = (code: string) => describeRates(new ApiError({ status: 404, code, correlationId: 'c' }));
    expect([refuse('RESOURCE_NOT_FOUND'), refuse('VALIDATION_FAILED'), refuse('SCOPE_DENIED'), refuse('OTHER'), describeRates(new Error('x'))]).toEqual(['notFound', 'validation', 'scopeDenied', 'general', 'general']);
  });
});
