import {
  ANOMALY_CODES,
  advanceWhileOpen,
  builtInDefault,
  contractClockDefaults,
  contractClockFindings,
  contractEndOn,
  dataFreshnessDefaults,
  dataFreshnessFacet,
  docReviewDefaults,
  docReviewFacet,
  periodEndRush,
  periodEndWindowStart,
  repeatedReallocation,
  validateRuleParams,
} from '../src/index';

const active = { contractStatus: 'ACTIVE', dueDate: '2026-12-31', extensionDays: 0, completedOn: null, acceptedVnd: '0', requestedVnd: '0', lastAcceptanceOn: null };

describe('contract clocks', () => {
  it('moves the end by the approved extension days', () => {
    expect(contractEndOn('2026-12-31', 10)).toBe('2027-01-10');
  });

  it('says nothing about a contract that is not active, completed, or far from its end', () => {
    expect(contractClockFindings({ ...active, contractStatus: 'SUSPENDED' }, '2026-12-30', contractClockDefaults(), 14)).toEqual([]);
    expect(contractClockFindings({ ...active, completedOn: '2026-12-01' }, '2026-12-30', contractClockDefaults(), 14)).toEqual([]);
    expect(contractClockFindings(active, '2026-10-01', contractClockDefaults(), 14)).toEqual([]);
  });

  it('watches the end inside the warning days, makes it urgent inside the urgent days, and urgent once it is past', () => {
    const params = contractClockDefaults();
    expect(contractClockFindings(active, '2026-12-01', params, 14)).toEqual([{ facet: 'END_NEAR', dueOn: '2026-12-31', daysLeft: 30, severity: 'WATCH' }]);
    expect(contractClockFindings(active, '2026-12-24', params, 14)[0]).toMatchObject({ facet: 'END_NEAR', daysLeft: 7, severity: 'URGENT' });
    expect(contractClockFindings(active, '2027-01-03', params, 14)[0]).toMatchObject({ facet: 'END_PASSED', daysLeft: -3, severity: 'URGENT' });
    // The extension moves the end: the same day is still near, not passed.
    expect(contractClockFindings({ ...active, extensionDays: 10 }, '2027-01-03', params, 14)[0]).toMatchObject({ facet: 'END_NEAR' });
  });

  it('flags accepted work that nobody asked payment for once the payment clock has run out, and only then', () => {
    const fact = { ...active, dueDate: null, acceptedVnd: '500000000', requestedVnd: '200000000', lastAcceptanceOn: '2026-11-01' };
    expect(contractClockFindings(fact, '2026-11-15', contractClockDefaults(), 14)).toEqual([]);
    expect(contractClockFindings(fact, '2026-11-16', contractClockDefaults(), 14)).toEqual([{ facet: 'PAYMENT_UNREQUESTED', dueOn: '2026-11-15', daysLeft: -1, severity: 'ACTION' }]);
    expect(contractClockFindings({ ...fact, requestedVnd: '500000000' }, '2026-12-30', contractClockDefaults(), 14)).toEqual([]);
  });
});

describe('document review', () => {
  it('has no clock without a review day, is overdue past it and due soon within the warning days', () => {
    const params = docReviewDefaults();
    expect(docReviewFacet(null, '2026-11-08', params)).toBeNull();
    expect(docReviewFacet('2026-11-07', '2026-11-08', params)).toBe('OVERDUE');
    expect(docReviewFacet('2026-11-10', '2026-11-08', params)).toBe('DUE_SOON');
    expect(docReviewFacet('2026-11-11', '2026-11-08', params)).toBeNull();
  });
});

describe('freshness of a dataset', () => {
  it('reports a stale dataset, and a critical one that was never assessed only when the rule says so', () => {
    const params = dataFreshnessDefaults();
    expect(dataFreshnessFacet('STALE', false, params)).toBe('STALE');
    expect(dataFreshnessFacet('NOT_ASSESSED', true, params)).toBe('NEVER_ASSESSED');
    expect(dataFreshnessFacet('NOT_ASSESSED', false, params)).toBeNull();
    expect(dataFreshnessFacet('NOT_ASSESSED', true, { ...params, flag_never_assessed_critical: false })).toBeNull();
    expect(dataFreshnessFacet('PASSED', true, params)).toBeNull();
  });
});

describe('anomalies of the money', () => {
  it('finds payments pressed into the last days of the year', () => {
    const rule = { threshold_pct: 50, min_amount_vnd: '1000000000' };
    expect(periodEndRush({ paidInWindowVnd: '600000000', paidInYearVnd: '1000000000' }, rule)).toEqual({ share: 60 });
    expect(periodEndRush({ paidInWindowVnd: '400000000', paidInYearVnd: '1000000000' }, rule)).toBeNull();
    expect(periodEndRush({ paidInWindowVnd: '90', paidInYearVnd: '100' }, rule)).toBeNull();
    expect(periodEndRush({ paidInWindowVnd: '0', paidInYearVnd: '0' }, rule)).toBeNull();
    expect(periodEndWindowStart(2026, 10)).toBe('2026-12-22');
  });

  it('finds a new advance while an earlier one is still open, and repeated adjustments', () => {
    expect(advanceWhileOpen('1', { min_amount_vnd: '1' })).toBe(true);
    expect(advanceWhileOpen('0', { min_amount_vnd: '1' })).toBe(false);
    expect(advanceWhileOpen('500', { min_amount_vnd: '1000' })).toBe(false);
    expect(repeatedReallocation(3, { threshold_count: 3 })).toBe(true);
    expect(repeatedReallocation(2, { threshold_count: 3 })).toBe(false);
  });

  it('registers one built-in default per code, each passing its own schema and flagged as not confirmed', () => {
    for (const code of ANOMALY_CODES) {
      const found = builtInDefault('ANOMALY_RULE', code);
      expect(found?.unverified).toBe(true);
      expect(validateRuleParams('ANOMALY_RULE', found?.params)).toEqual(found?.params);
    }
    expect(builtInDefault('CONTRACT_CLOCK_RULE', 'DEFAULT')?.params).toEqual(contractClockDefaults());
    expect(builtInDefault('DOC_REVIEW_RULE', 'DEFAULT')?.params).toEqual(docReviewDefaults());
    expect(builtInDefault('DATA_FRESHNESS_RULE', 'DEFAULT')?.params).toEqual(dataFreshnessDefaults());
  });

  it('registers an alert type, with owner, action, consequence and review day, for each new source kind', () => {
    for (const code of ['CONTRACT_END_NEAR', 'CONTRACT_PAYMENT_UNREQUESTED', 'DOC_REVIEW_OVERDUE', 'DATA_STALE', 'ANOMALY_SIGNAL', 'RED_FLAG_NEW', 'ALERT_FEEDBACK_REVIEW']) {
      const params = builtInDefault('ALERT_TYPE', code)?.params as Record<string, unknown>;
      expect(String(params.owner).length).toBeGreaterThan(0);
      expect(String(params.expected_action).length).toBeGreaterThan(0);
      expect(String(params.consequence).length).toBeGreaterThan(0);
      expect(params.review_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
