import { MneFormStore, MneObligationRuleStore } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { loadFormPack, loadMnePack, parseFormPack } from '../../src/modules/mne/form-pack';
import { loadPlatformTemplates } from '../../src/modules/doc/template-pack';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';

jest.setTimeout(120_000);

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  form_code: 'PACK-A',
  title: 'A form',
  report_kind: 'OVERALL_SEMIANNUAL',
  legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
  watermark_text: 'WAITING [CXN-10]',
  effective_from: '2026-01-01',
  schema_json: { tables: [] },
  doc_template_code: 'MNE-TT44-M02',
  export_formats: ['XLSX'],
  ...overrides,
});
const rule = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  rule_code: 'RULE-A',
  form_code: 'PACK-A',
  reporting_role: 'INVESTOR',
  recipient: 'Department of Finance',
  frequency: 'SEMIANNUAL',
  due_rule_json: { period: 'H1', month: 7, day: 10 },
  legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
  effective_from: '2026-01-01',
  ...overrides,
});

describe('the platform pack of report forms and obligation rules (ST-MNE-001, BR-MNE-01, TK-MNE-001-3)', () => {
  const pack = loadFormPack();

  it('is data with a version: every form and rule has its legal basis, a start date and a CXN label, and every form a watermark that says it waits', () => {
    expect(pack.packVersion).toBe('2026.10.1');
    expect(pack.forms.map((form) => form.formCode)).toEqual(['TT44-M02', 'TT44-M03', 'TT44-M04', 'TT44-M05', 'TT44-M06', 'TT44-M07', 'TT44-M08', 'TT44-M09', 'TT44-M10', 'CV3665-WEEKLY']);
    for (const form of pack.forms) {
      expect(form.legalBasis).toMatch(/\[CXN-1[013]\]/);
      expect(form.watermarkText).toContain('Mẫu chờ xác nhận pháp lý');
      expect(form.effectiveFrom).toBe('2026-01-01');
      expect(form.legalConfirmationRef).toBeUndefined();
    }
    for (const rule of pack.rules) expect(rule.legalBasis).toMatch(/\[CXN-1[01]\]/);
    expect(pack.rules.map((rule) => [rule.ruleCode, rule.dueRuleJson])).toEqual([
      ['OVERALL_SEMIANNUAL', { period: 'H1', month: 7, day: 10 }],
      ['OVERALL_ANNUAL', { period: 'YEAR', month: 2, day: 10, year_offset: 1 }],
      ['WEEKLY_QUICK', { weekly: 'FRI', time: '16:00' }],
    ]);
  });

  it('refuses a pack that is not well formed', () => {
    expect(() => parseFormPack(null)).toThrow('no forms or no rules');
    expect(() => parseFormPack({ pack_version: '1', forms: [], rules: [] })).not.toThrow();
    expect(() => parseFormPack({ forms: [], rules: [] })).toThrow('needs pack_version');
    expect(() => parseFormPack({ pack_version: '1', forms: [7], rules: [] })).toThrow('form 1 is not an object');
    expect(() => parseFormPack({ pack_version: '1', forms: [], rules: [7] })).toThrow('rule 1 is not an object');
    expect(() => parseFormPack({ pack_version: '1', forms: [entry({ title: '' })], rules: [] })).toThrow('form 1 needs title');
    expect(() => parseFormPack({ pack_version: '1', forms: [entry({ export_formats: 'XLSX' })], rules: [] })).toThrow('needs export_formats');
    expect(() => parseFormPack({ pack_version: '1', forms: [entry(), entry()], rules: [] })).toThrow('a form code appears twice');
    expect(() => parseFormPack({ pack_version: '1', forms: [], rules: [rule(), rule()] })).toThrow('a rule code appears twice');
    const parsed = parseFormPack({ pack_version: '1', forms: [entry({ legal_confirmation_ref: 'CXN-10-OK', effective_until: '2027-01-01' })], rules: [rule({ effective_until: '2027-01-01' })] });
    expect(parsed.forms[0]).toMatchObject({ legalConfirmationRef: 'CXN-10-OK', effectiveUntil: '2027-01-01' });
    expect(parsed.rules[0]).toMatchObject({ effectiveUntil: '2027-01-01' });
  });

  it('cannot be found from a directory that is not the repository: the load says so', () => {
    expect(() => loadFormPack('/')).toThrow('MNE form pack not found');
  });

  describe('loaded into a tenant', () => {
    const harness = new AuthzHarness();
    const forms = new MneFormStore();
    const rules = new MneObligationRuleStore();
    const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(1)), work);

    beforeAll(async () => {
      await harness.start();
      for (const tenant of [TENANT_A, TENANT_B]) {
        await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
        await harness.seedMembership(tenant, 1, 1);
      }
      await as((tx) => loadPlatformTemplates(tx, memberId(1)));
    }, 180_000);

    afterAll(async () => {
      await harness.stop();
    }, 60_000);

    it('publishes the forms whose DOC template exists, as working assumptions, and leaves the weekly one out until DOC has its template', async () => {
      const result = await as((tx) => loadMnePack(tx, memberId(1)));
      expect(result.forms.inserted).toEqual(['TT44-M02', 'TT44-M03', 'TT44-M04', 'TT44-M05', 'TT44-M06', 'TT44-M07', 'TT44-M08', 'TT44-M09', 'TT44-M10']);
      expect(result.forms.skipped).toEqual([{ formCode: 'CV3665-WEEKLY', reason: 'DOC_TEMPLATE_MISSING' }]);
      expect(result.rules.inserted).toEqual(['OVERALL_SEMIANNUAL', 'OVERALL_ANNUAL']);
      expect(result.rules.skipped).toEqual([{ ruleCode: 'WEEKLY_QUICK', reason: 'FORM_NOT_EFFECTIVE' }]);
      const listed = await as((tx) => forms.list(tx, {}, { limit: 50 }));
      expect(listed).toHaveLength(9);
      for (const form of listed) {
        expect(form).toMatchObject({ status: 'PUBLISHED', origin: 'PLATFORM_PACK', packVersion: '2026.10.1', legalConfirmationRef: null, approvedBy: null, effectiveFrom: '2026-01-01' });
        expect(form.watermarkText).toBe('Mẫu chờ xác nhận pháp lý [CXN-10]');
        expect(form.docTemplateId).not.toBeNull();
      }
      const half = await as((tx) => rules.inWindow(tx, { from: '2026-01-01', until: '2027-01-01' }));
      expect(half.map((row) => [row.ruleCode, row.formCode, row.reportingRole, row.dueRuleJson])).toEqual([
        ['OVERALL_ANNUAL', 'TT44-M03', 'INVESTOR', { period: 'YEAR', month: 2, day: 10, year_offset: 1 }],
        ['OVERALL_SEMIANNUAL', 'TT44-M02', 'INVESTOR', { period: 'H1', month: 7, day: 10 }],
      ]);
    });

    it('changes nothing when it is loaded again', async () => {
      const again = await as((tx) => loadMnePack(tx, memberId(1)));
      expect(again.forms.inserted).toEqual([]);
      expect(again.forms.unchanged).toHaveLength(9);
      expect(again.rules.unchanged).toEqual(['OVERALL_SEMIANNUAL', 'OVERALL_ANNUAL']);
    });

    it('gives another tenant nothing it was not given', async () => {
      expect(await as((tx) => forms.list(tx, {}, { limit: 50 }), TENANT_B)).toEqual([]);
    });
  });
});
