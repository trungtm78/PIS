import { AS_OF } from '../../test/fixtures';
import type { LegalBasis, Suggestion, SuggestionPreview, WorkflowStep } from '../model';

export const legalBasis = (over: Partial<LegalBasis> = {}): LegalBasis => ({
  document_code: 'DECREE_24_2024_ND_CP',
  article: null,
  note: null,
  verification: 'UNVERIFIED',
  doc_kind: 'DECREE',
  number: '24/2024/NĐ-CP',
  title: 'Nghị định quy định chi tiết Luật Đấu thầu về lựa chọn nhà thầu',
  issuer: 'Chính phủ',
  effective_from: '2024-02-27',
  effective_to: null,
  superseded_by: null,
  document_verification: 'UNVERIFIED',
  document_id: null,
  url: null,
  state: 'IN_FORCE',
  ...over,
});

export const step = (code: string, phase: string, order: number, over: Partial<WorkflowStep> = {}): WorkflowStep => ({
  code,
  name: `Bước ${code}`,
  phase_code: phase,
  order,
  implicit: false,
  responsible_role: 'PMB_MANAGER',
  status: 'NOT_STARTED',
  standard_working_days: 10,
  planned_start: '2026-12-01',
  planned_finish: '2026-12-14',
  task_total: 1,
  task_done: 0,
  required_total: 1,
  required_done: 0,
  checklist_total: 2,
  checklist_done: 1,
  legal_basis: [],
  ...over,
});

export const preview = (over: Partial<SuggestionPreview> = {}): SuggestionPreview => ({
  template_code: 'PUBLIC_INVESTMENT',
  template_version: 0,
  template_hash: 'd'.repeat(64),
  planned_start_date: '2026-12-01',
  project_start: '2026-12-01',
  project_finish: '2028-03-15',
  total_working_days: 330,
  standard_working_days: 330,
  phase_count: 6,
  step_count: 13,
  task_count: 31,
  excluded_tasks: ['PREP_PRE_FEASIBILITY'],
  missing_facts: [],
  findings: [],
  steps: [
    { code: 'STEP_POLICY', name: 'Quyết định chủ trương đầu tư', phase_code: 'PREPARATION', order: 1, implicit: false, start: '2026-12-01', finish: '2027-01-20', duration_working_days: 35, task_count: 3 },
    { code: 'STEP_PROPOSAL', name: 'Đề xuất dự án', phase_code: 'PREPARATION', order: 2, implicit: false, start: null, finish: null, duration_working_days: 0, task_count: 0 },
  ],
  ...over,
});

/** A suggestion of the built-in rule: the construction workflow by default. `preview` takes a partial that is laid over the standard preview (null: no preview). */
export const suggestion = (over: Omit<Partial<Suggestion>, 'preview'> & { preview?: Partial<SuggestionPreview> | null } = {}): Suggestion => {
  const { preview: previewOver, ...rest } = over;
  return {
    suggested_template_code: 'PUBLIC_INVESTMENT',
    basis: 'DEFAULT',
    line: null,
    rule: { rule_id: null, version: 0, unit_id: null, unverified: true },
    candidates: [{ template_code: 'PUBLIC_INVESTMENT', basis: 'DEFAULT', line: null }],
    unknown_templates: [],
    templates: [
      { code: 'PUBLIC_INVESTMENT', name: 'Dự án đầu tư công xây dựng', project_type: 'PUBLIC_INVESTMENT', version: 0, unverified: true, phase_count: 6, step_count: 13, task_count: 34, fact_fields: ['funding_source', 'project_group'] },
      { code: 'PUBLIC_REPAIR', name: 'Dự án đầu tư công sửa chữa, cải tạo lớn', project_type: 'PUBLIC_REPAIR', version: 2, unverified: false, phase_count: 6, step_count: 9, task_count: 17, fact_fields: [] },
    ],
    facts: {},
    preview: previewOver === null ? null : preview(previewOver ?? {}),
    can_start: true,
    as_of: AS_OF,
    ...rest,
  };
};
