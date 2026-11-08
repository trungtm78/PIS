import { builtInCodes, builtInDefault, isGovernanceRuleType } from '@machvon/kernel';
import { ebsReconcileParamsOf } from './ebs-rules.ts';
import { hpmPolicyParamsOf } from './hpm-rules.ts';
import { integrationTexts, registerEnterpriseIntegrationRules } from './integration-rules.ts';

describe('the rules and alert types of the connections of the enterprise edition (ENT-2)', () => {
  beforeAll(() => registerEnterpriseIntegrationRules());

  it('registers once: a second call changes nothing', () => {
    expect(() => registerEnterpriseIntegrationRules()).not.toThrow();
    expect(isGovernanceRuleType('HPM_PUSH_POLICY')).toBe(true);
    expect(isGovernanceRuleType('EBS_RECONCILE_POLICY')).toBe(true);
  });

  it('gives the push policy a formula, a source and a day, and flags it unverified', () => {
    const policy = builtInDefault('HPM_PUSH_POLICY', 'DEFAULT');
    expect(policy?.unverified).toBe(true);
    expect(policy?.legalStatus).toBe('UNVERIFIED');
    expect(policy?.asOf).toBe('2026-11-08');
    expect(policy?.formula).toBe(integrationTexts().hpmPolicy.formula);
    expect(hpmPolicyParamsOf(policy?.params ?? {})).toEqual({ max_attempts: 5, warn_after_hours: 720, max_age_hours: 1080, stale_severity: 'ACTION' });
  });

  it('gives the reconciliation policy five working days, unverified', () => {
    const policy = builtInDefault('EBS_RECONCILE_POLICY', 'DEFAULT');
    expect(policy?.unverified).toBe(true);
    expect(ebsReconcileParamsOf(policy?.params ?? {})).toEqual({ due_in_working_days: 5 });
  });

  it('adds the freshness of the Oracle EBS file next to the one of the national procurement network', () => {
    expect(builtInCodes('CONNECTOR_FRESHNESS')).toEqual(expect.arrayContaining(['EGP_FILE', 'EBS_FILE']));
    const freshness = builtInDefault('CONNECTOR_FRESHNESS', 'EBS_FILE');
    expect(freshness?.params).toEqual({ max_age_hours: 168, warn_after_hours: 120, stale_severity: 'WATCH', figures_blocked_when_stale: false });
    expect(freshness?.unverified).toBe(true);
  });

  it('gives each alert type of a push an owner, an expected action and a consequence', () => {
    for (const code of ['HPM_PUSH_FAILED', 'HPM_PUSH_STALE']) {
      const type = builtInDefault('ALERT_TYPE', code);
      expect(type?.params.owner).toBe('INTEGRATION_ADMINISTRATOR');
      expect(String(type?.params.expected_action).length).toBeGreaterThan(20);
      expect(String(type?.params.consequence).length).toBeGreaterThan(20);
      expect(type?.params.source).toBe('CONNECTOR');
    }
  });
});
