import type { AdoptResult } from '../../model';
import { AS_OF, PROJECT_ID, schedulePreview, scheduleTask, templateParams, uuid } from '../../test/fixtures';

export const AREA = { version_id: uuid(5001), business_key: 'TINH-P', label: 'Tỉnh P' };

/** The raw answer of the read of one project (`get_resources_project_id`). */
export const projectBody = (over: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  code: 'DA-2026-001',
  name: 'Dự án đường tỉnh',
  owner_unit_id: uuid(5002),
  owner_unit_name: 'Sở Giao thông',
  investor_unit_id: null,
  investor_unit_name: null,
  project_group: 'B',
  status: 'IMPLEMENTATION',
  national_project_code: null,
  leader_in_charge: null,
  version: 3,
  decision_authority_unit_id: null,
  decision_authority_unit_name: null,
  area: AREA,
  sector: null,
  project_type: { version_id: uuid(5003), business_key: 'CONSTRUCTION', label: 'Xây dựng' },
  program: null,
  classification: 'INTERNAL',
  total_investment_vnd: '500000000000',
  start_year: 2026,
  end_year: 2028,
  appraisal_score: null,
  status_changed_at: '2026-10-24T01:00:00.000Z',
  created_at: '2026-10-24T01:00:00.000Z',
  proposed_on: '2026-10-24',
  group_suggestion: null,
  ...over,
});

const provenance = { formula: 'Mẫu đóng băng khi khởi tạo', source: 'Quy tắc quản trị', as_of: '2026-11-08', legal_status: 'UNVERIFIED' };

/** The catalogue of rule types with the template type and two codes in force and one that governs nothing. */
export const catalogueBody = () => ({
  items: [
    {
      rule_type: 'PROJECT_WORKFLOW_TEMPLATE',
      registered: true,
      owner_module: 'PWF',
      modules: ['PWF', 'PRJ'],
      formula: 'Mẫu workflow theo loại dự án',
      source: 'Thiết kế PWF',
      as_of: '2026-11-08',
      legal_status: 'UNVERIFIED',
      schema: {},
      codes: [
        { code: 'PUBLIC_INVESTMENT', has_default: true, unverified: true, provenance, stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 },
        { code: 'PUBLIC_REPAIR', has_default: true, unverified: false, provenance, stored_versions: 2, in_force: 'RULE', in_force_version: 2 },
        { code: 'OLD_TEMPLATE', has_default: false, unverified: false, provenance: null, stored_versions: 1, in_force: 'NONE', in_force_version: 0 },
      ],
    },
  ],
});

export const effectiveBody = (code: string, over: Record<string, unknown> = {}) => ({
  rule_type: 'PROJECT_WORKFLOW_TEMPLATE',
  code,
  as_of: '2026-11-12',
  params: templateParams({ name: `Mẫu ${code}` }),
  version: code === 'PUBLIC_INVESTMENT' ? 0 : 2,
  source: code === 'PUBLIC_INVESTMENT' ? 'DEFAULT' : 'RULE',
  rule_id: code === 'PUBLIC_INVESTMENT' ? null : uuid(5100),
  unit_id: null,
  unverified: code === 'PUBLIC_INVESTMENT',
  provenance,
  ...over,
});

export const adoptResult = (over: Partial<AdoptResult> = {}): AdoptResult => ({
  dry_run: true,
  applied: false,
  workflow_id: null,
  template_code: 'PUBLIC_INVESTMENT',
  template_hash: 'c'.repeat(64),
  effective_date: '2026-11-01',
  tasks: [
    { task_code: 'T1', name: 'Lập báo cáo nghiên cứu khả thi', treatment: 'TRACKED', planned_start: '2026-01-05', planned_finish: '2026-02-02', needs_decision: true },
    { task_code: 'T2', name: 'Thẩm định', treatment: 'TRACKED', planned_start: '2026-11-02', planned_finish: '2026-11-20', needs_decision: false },
    { task_code: 'T3', name: 'Nhánh không áp dụng', treatment: 'EXCLUDED', planned_start: null, planned_finish: null, needs_decision: false },
  ],
  schedule: schedulePreview({ tasks: [scheduleTask('T1'), scheduleTask('T2', { state: 'CALENDAR_UNAVAILABLE', missing_year: 2028, start: null, finish: null })] }),
  findings: [{ code: 'ACTUAL_DATES_MISSING', task: 'T1' }],
  as_of: AS_OF,
  ...over,
});
