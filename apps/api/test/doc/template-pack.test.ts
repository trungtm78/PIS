import { validateTemplateContent } from '@machvon/db';
import { formPayload } from '@machvon/kernel';
import { loadTemplatePack, parseTemplatePack } from '../../src/modules/doc/template-pack';

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  template_code: 'PACK-A',
  group_code: 'DECISION',
  doc_type_code: 'QD',
  form_code: null,
  title: 'Decision',
  source_module: 'PRJ',
  layout_profile_code: 'ND30_A4_STANDARD',
  body_blocks: [{ kind: 'heading', text: '{{title}}' }],
  placeholder_schema: { required: ['title'] },
  legal_basis: 'Decree 30/2020',
  watermark_text: 'WAITING',
  effective_from: '2026-01-01',
  ...overrides,
});
const pack = (...templates: unknown[]): unknown => ({ pack_version: '1', templates });

describe('the platform template pack (ST-DOC-006, TK-DOC-006-3)', () => {
  const loaded = loadTemplatePack();

  it('is data with a version: every template has its legal basis, a watermark that says it waits for confirmation, a start date and a body the renderer can fill', () => {
    expect(loaded.packVersion).toBe('2026.10.1');
    expect(loaded.templates).toHaveLength(25);
    expect(loadTemplatePack(undefined, { demoForms: false }).templates).toHaveLength(25);
    for (const template of loaded.templates) {
      expect(template.legalBasis.length).toBeGreaterThan(5);
      expect(template.watermarkText).toContain('CHƯA XÁC NHẬN PHÁP LÝ');
      expect(template.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(template.layoutProfileCode).toBe('ND30_A4_STANDARD');
      expect(() => validateTemplateContent(template.bodyBlocks, template.placeholderSchema)).not.toThrow();
    }
  });

  it('has no template code or form code twice, and the monitoring reports M02 to M10 of Circular 44/2026 with their confirmation label', () => {
    const codes = loaded.templates.map((template) => template.templateCode);
    expect(new Set(codes).size).toBe(codes.length);
    const forms = loaded.templates.flatMap((template) => (template.formCode === undefined ? [] : [template.formCode]));
    expect(new Set(forms).size).toBe(forms.length);
    const weekly = loaded.templates.find((template) => template.templateCode === 'MNE-CV3665-WEEKLY');
    expect(weekly).toMatchObject({ formCode: 'CV3665-WEEKLY', groupCode: 'REPORT_MONITORING', docTypeCode: 'BC', sourceModule: 'MNE', watermarkText: 'CHƯA XÁC NHẬN PHÁP LÝ [CXN-11]' });
    expect(weekly?.legalBasis).toContain('[CXN-11]');
    const reports = loaded.templates.filter((template) => template.templateCode.startsWith('MNE-TT44-'));
    expect(reports.map((template) => template.formCode)).toEqual(['M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10']);
    for (const report of reports) {
      expect(report.watermarkText).toBe('CHƯA XÁC NHẬN PHÁP LÝ [CXN-10]');
      expect(report.legalBasis).toContain('[CXN-10]');
      expect(report.groupCode).toBe('REPORT_MONITORING');
    }
    expect(loaded.templates.filter((template) => template.groupCode === 'DECISION')).toHaveLength(9);
    expect(loaded.templates.filter((template) => template.groupCode === 'OFFICIAL_LETTER')).toHaveLength(4);
  });

  it('adds the demo forms of the payment only where the demo forms are on: four Treasury forms, stamped as demo, drawn from fields the payment form really fills', () => {
    const demo = loadTemplatePack(undefined, { demoForms: true });
    expect(demo.templates).toHaveLength(29);
    expect(demo.packVersion).toBe(loaded.packVersion);
    const forms = demo.templates.filter((template) => template.groupCode === 'TREASURY_FORM');
    expect(forms.map((template) => template.formCode)).toEqual(['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']);
    const facts = { agency: 'a', place: 'p', requestNo: 'n', requestKind: 'INTERIM', contractCode: 'c', contractTitle: 't', contractorName: 'k', projectCode: 'j', projectName: 'm', planYear: 2026, grossVnd: '10', advanceRecoveryVnd: '1', retentionVnd: '1', taxAdjustmentVnd: '0', netVnd: '8' };
    const fields = new Set(Object.keys(formPayload(facts, '03.a/TT')));
    for (const form of forms) {
      expect(form.watermarkText).toContain('MẪU DEMO');
      expect(form.watermarkText).toContain('CHƯA XÁC NHẬN PHÁP LÝ');
      expect(form.title).toContain('demo');
      expect(() => validateTemplateContent(form.bodyBlocks, form.placeholderSchema)).not.toThrow();
      const used = JSON.stringify(form.bodyBlocks).match(/\{\{(\w+)\}\}/g)?.map((placeholder) => placeholder.slice(2, -2)) ?? [];
      expect(used.length).toBeGreaterThan(0);
      for (const field of used) expect(fields.has(field)).toBe(true);
    }
    const codes = demo.templates.map((template) => template.templateCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('reads a null form code as none and keeps optional fields optional', () => {
    const [first] = parseTemplatePack(pack(entry({ source_module: undefined, effective_until: '2027-01-01' }))).templates;
    expect(first).toMatchObject({ formCode: undefined, sourceModule: undefined, effectiveUntil: '2027-01-01' });
  });

  it('refuses a pack that is broken, naming what is wrong', () => {
    expect(() => parseTemplatePack(null)).toThrow('no templates');
    expect(() => parseTemplatePack({ pack_version: '1' })).toThrow('no templates');
    expect(() => parseTemplatePack({ templates: [] })).toThrow('the pack needs pack_version');
    expect(() => parseTemplatePack(pack('text'))).toThrow('not an object');
    expect(() => parseTemplatePack(pack(entry({ group_code: 'NOPE' })))).toThrow('unknown group');
    expect(() => parseTemplatePack(pack(entry({ legal_basis: ' ' })))).toThrow('needs legal_basis');
    expect(() => parseTemplatePack(pack(entry({ watermark_text: undefined })))).toThrow('needs watermark_text');
    expect(() => parseTemplatePack(pack(entry({ effective_until: 5 })))).toThrow('needs effective_until');
    expect(() => parseTemplatePack(pack(entry(), entry()))).toThrow('appears twice');
  });
});
