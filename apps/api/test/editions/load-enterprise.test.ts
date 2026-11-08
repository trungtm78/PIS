import { defaultGovernanceRule, isGovernanceRuleType, resolveGovernanceRule } from '@machvon/kernel';
import { loadEnterpriseManifest } from '../../src/editions/load-enterprise';
import { REPORT_FORMS } from '../../src/modules/reports/form-registry';

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

  it('adds the six demo forms to the catalogue of the process, as DEMO forms with illustrative data and no form reference (R18), once', async () => {
    await loadEnterpriseManifest();
    const demo = REPORT_FORMS.list().filter((form) => form.edition === 'enterprise');
    expect(demo.map((form) => form.layout.code).sort()).toEqual(['COMMITTEE-PERIODIC', 'HPM-MONTHLY', 'INVEST-STEERING', 'PLANT-PHU-MY', 'PVN-MONTHLY', 'PVN-QUARTERLY-F2']);
    for (const form of demo) expect([form.layout.status, form.layout.formRef, form.dataSource, form.provider]).toEqual(['DEMO', null, 'ILLUSTRATIVE', null]);
    // The template files are found and are workbooks; a second load adds nothing.
    const bytes = await (demo[0] as (typeof demo)[number]).templates();
    expect(Buffer.from(bytes.xlsx.slice(0, 2)).toString('latin1')).toBe('PK');
    await loadEnterpriseManifest();
    expect(REPORT_FORMS.list().filter((form) => form.edition === 'enterprise')).toHaveLength(6);
  });
});
