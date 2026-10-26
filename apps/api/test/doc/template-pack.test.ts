import { validateTemplateContent } from '@machvon/db';
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
    expect(loaded.templates).toHaveLength(23);
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
