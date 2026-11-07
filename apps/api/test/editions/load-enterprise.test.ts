import { defaultGovernanceRule, isGovernanceRuleType, resolveGovernanceRule } from '@machvon/kernel';
import { loadEnterpriseManifest } from '../../src/editions/load-enterprise';

describe('the enterprise seam of the API', () => {
  it('loads the manifest and adds the enterprise indicator pack and the form mode rule to the rule registry of the process, once', async () => {
    const manifest = await loadEnterpriseManifest();
    expect(manifest.edition).toBe('enterprise');
    expect(defaultGovernanceRule('KPI_DEFINITION', 'ENT_RATE_DISBURSED_YTD')?.params.unit).toBe('PERCENT');
    expect(isGovernanceRuleType('REPORT_FORM_MODE')).toBe(true);
    // Demo forms are off until a tenant approves the rule or the environment says so.
    expect(resolveGovernanceRule([], 'REPORT_FORM_MODE', 'DEFAULT', '2026-11-08')?.params).toEqual({ demo_forms: false });
    await expect(loadEnterpriseManifest()).resolves.toBe(manifest);
  });
});
