import type { TemplateValidation } from '../../model';
import { effectiveBody, uuid, version } from '../../../adm/governance/test/fixtures';
import { templateParams } from '../../test/fixtures';

export { uuid };

const TYPE = 'PROJECT_WORKFLOW_TEMPLATE';
const provenance = (legal: 'VERIFIED' | 'UNVERIFIED') => ({ formula: 'Mẫu khởi đầu của đầu tư công', source: 'Khảo sát quy trình 2026', as_of: '2026-11-08', legal_status: legal });

/** The catalogue of the rule store with the rule type of the workflow templates: one code governed by a rule of the tenant, one still the shipped, unconfirmed template. */
export const templateCatalogue = (over: Record<string, unknown> = {}) => ({
  items: [
    {
      rule_type: TYPE,
      registered: true,
      owner_module: 'PWF',
      modules: ['PWF'],
      formula: 'Mẫu workflow theo loại dự án',
      source: 'Khảo sát quy trình 2026',
      as_of: '2026-11-08',
      legal_status: 'UNVERIFIED',
      schema: undefined,
      codes: [
        { code: 'PUBLIC_INVESTMENT', has_default: true, unverified: false, provenance: provenance('VERIFIED'), stored_versions: 2, in_force: 'RULE', in_force_version: 2 },
        { code: 'PUBLIC_REPAIR', has_default: true, unverified: true, provenance: provenance('UNVERIFIED'), stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 },
      ],
      ...over,
    },
    { rule_type: 'ALERT_TYPE', registered: true, owner_module: 'ADM', modules: [], formula: null, source: null, as_of: null, legal_status: 'VERIFIED', schema: undefined, codes: [] },
  ],
});

export const templateVersion = (n: number, over: Record<string, unknown> = {}) =>
  version(n, { rule_type: TYPE, code: 'PUBLIC_INVESTMENT', params: templateParams({ name: `Mẫu bản ${n}` }), status: 'APPROVED', phase: 'IN_FORCE', effective_from: '2026-12-01', ...over });

export const templateEffective = (over: Record<string, unknown> = {}) => effectiveBody({ rule_type: TYPE, code: 'PUBLIC_INVESTMENT', params: templateParams({ name: 'Mẫu bản 2' }), version: 2, source: 'RULE', rule_id: uuid(102), ...over });

export const shippedEffective = (code = 'PUBLIC_REPAIR', over: Record<string, unknown> = {}) =>
  effectiveBody({ rule_type: TYPE, code, params: templateParams({ name: 'Sửa chữa lớn', project_type: 'REPAIR' }), version: 0, source: 'DEFAULT', rule_id: null, unverified: true, ...over });

export const validation = (over: Partial<TemplateValidation> = {}): TemplateValidation => ({
  valid: true,
  findings: [],
  quality_flags: [],
  task_count: 2,
  phase_count: 1,
  longest_chain: 2,
  template_hash: 'c'.repeat(64),
  as_of: '2026-11-12T03:00:00.000Z',
  ...over,
});
