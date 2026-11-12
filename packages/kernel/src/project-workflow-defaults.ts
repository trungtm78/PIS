import { PWF_TEXT as T } from './messages/pwf-texts.ts';

/**
 * The built-in templates of the project workflow for the public edition (PWF-1): data, not code. They are written in the params of the rule type `PROJECT_WORKFLOW_TEMPLATE` (snake_case, as the governance store keeps them) and carry
 * `legalStatus: UNVERIFIED` on the rule that registers them: the order follows the Public Investment Law 58/2024/QH15 and the Bidding Law 22/2023/QH15, the roles are those of a provincial agency (the investor, the project management board,
 * the departments of Planning and Investment and of Finance, the State Treasury), and every number of days is a starting value that the agency confirms. No template here is the content of one customer; an edition adds its own pack through the
 * rule store and its own catalogue of legal document types (`registerLegalDocTypeResolver`).
 */

type Params = Record<string, unknown>;

/** A type of legal document of the public edition and the class of project document (`doc-repository.ts`) it is filed in. */
export interface PublicLegalDocType {
  code: string;
  label: string;
  documentClass: string;
}

export const PUBLIC_LEGAL_DOC_TYPES: readonly PublicLegalDocType[] = [
  { code: 'INVESTMENT_POLICY_DECISION', label: T.doc_policy_decision, documentClass: 'INVESTMENT_DECISION' },
  { code: 'PRE_FEASIBILITY_REPORT', label: T.doc_pre_feasibility, documentClass: 'FEASIBILITY' },
  { code: 'FEASIBILITY_REPORT', label: T.doc_feasibility, documentClass: 'FEASIBILITY' },
  { code: 'APPRAISAL_REPORT', label: T.doc_appraisal, documentClass: 'FEASIBILITY' },
  { code: 'INVESTMENT_DECISION', label: T.doc_investment_decision, documentClass: 'INVESTMENT_DECISION' },
  { code: 'CAPITAL_PLAN_DECISION', label: T.doc_capital_plan, documentClass: 'LEGAL_BASIS' },
  { code: 'DESIGN_APPROVAL', label: T.doc_design_approval, documentClass: 'DESIGN' },
  { code: 'BIDDING_PLAN_DECISION', label: T.doc_bid_plan, documentClass: 'PROCUREMENT' },
  { code: 'BID_RESULT_DECISION', label: T.doc_bid_result, documentClass: 'PROCUREMENT' },
  { code: 'CONSTRUCTION_CONTRACT', label: T.doc_contract, documentClass: 'CONTRACT' },
  { code: 'ACCEPTANCE_MINUTES', label: T.doc_acceptance, documentClass: 'ACCEPTANCE' },
  { code: 'PAYMENT_REQUEST', label: T.doc_payment_request, documentClass: 'PAYMENT' },
  { code: 'TREASURY_CONTROL', label: T.doc_treasury_control, documentClass: 'PAYMENT' },
  { code: 'HANDOVER_MINUTES', label: T.doc_handover, documentClass: 'ACCEPTANCE' },
  { code: 'SETTLEMENT_REPORT', label: T.doc_settlement_report, documentClass: 'SETTLEMENT' },
  { code: 'SETTLEMENT_DECISION', label: T.doc_settlement_decision, documentClass: 'SETTLEMENT' },
  { code: 'POST_EVALUATION_REPORT', label: T.doc_post_evaluation, documentClass: 'REPORT' },
];

interface Dependency {
  task: string;
  kind: 'FS' | 'SS' | 'FF' | 'SF';
  lag_working_days: number;
}

interface TaskOptions {
  days?: number;
  milestone?: boolean;
  required?: boolean;
  role?: string;
  approver?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  after?: readonly Dependency[];
  docs?: readonly string[];
  checklist?: readonly Params[];
  kpi?: readonly string[];
  when?: readonly Params[];
}

const fs = (task: string, lag = 0): Dependency => ({ task, kind: 'FS', lag_working_days: lag });
const dependency = (task: string, kind: Dependency['kind'], lag = 0): Dependency => ({ task, kind, lag_working_days: lag });
const group = (...values: string[]): Params => ({ field: 'project_group', in: values });
const funding = (...values: string[]): Params => ({ field: 'funding_source', in: values });
const item = (code: string, name: string, evidence: readonly string[] = []): Params => ({ code, name, required: true, evidence_kinds: evidence });

const task = (code: string, name: string, phase: string, options: TaskOptions = {}): Params => ({
  code,
  name,
  phase,
  kind: options.milestone === true ? 'MILESTONE' : 'TASK',
  duration_working_days: options.milestone === true ? 0 : (options.days ?? 1),
  required: options.required ?? true,
  responsible_role: options.role ?? 'PMB_MANAGER',
  ...(options.approver === undefined ? {} : { approver_role: options.approver }),
  priority: options.priority ?? (options.milestone === true ? 'HIGH' : 'NORMAL'),
  predecessors: options.after ?? [],
  legal_doc_types: options.docs ?? [],
  form_templates: [],
  checklist: options.checklist ?? [],
  kpi_codes: options.kpi ?? [],
  when: options.when ?? [],
});

/** The gates tie the phases to the legal commands of the PIMA life cycle of the project (`prj-stage-machine.ts`). */
const phases = (): Params[] => [
  { code: 'PREPARATION', name: T.phase_preparation, gates: ['submitProjectForAppraisal'] },
  { code: 'FEASIBILITY', name: T.phase_feasibility, gates: ['decideProjectAppraisal'] },
  { code: 'APPROVAL', name: T.phase_approval, gates: ['startProjectImplementation'] },
  { code: 'IMPLEMENTATION', name: T.phase_implementation, gates: [] },
  { code: 'ACCEPTANCE', name: T.phase_acceptance, gates: ['completeProject'] },
  { code: 'SETTLEMENT', name: T.phase_settlement, gates: ['closeProject'] },
];

const DEVIATION = 'PWF_TASK_DEVIATION_DAYS';
const EVIDENCE = 'PWF_EVIDENCE_COMPLETENESS';
const AMOUNT = 'PWF_AMOUNT_VARIANCE_PCT';
const COMPLETE_ITEM = item('DOSSIER_COMPLETE', T.checklist_dossier_complete, ['DOCUMENT']);
const SIGNED_ITEM = item('SIGNED', T.checklist_signed, ['DECISION_DOCUMENT']);
const OWNER = 'INVESTOR_REP';
const DECIDER = 'DECISION_AUTHORITY';
const POLICY_GROUPS = group('QTQG', 'A', 'B');
const PRE_FEASIBILITY_GROUPS = group('QTQG', 'A');
const OVERSEAS = funding('ODA', 'FOREIGN_LOAN');

/** Public investment project, construction: the main template (groups QTQG, A, B, C; budget and foreign sources of capital). */
export const PUBLIC_INVESTMENT_TEMPLATE: Params = {
  name: T.investment_name,
  project_type: 'PUBLIC_INVESTMENT',
  phases: phases(),
  tasks: [
    task('PREP_NEEDS', T.prep_needs, 'PREPARATION', { days: 7, role: 'PMB_PLANNER', kpi: [DEVIATION] }),
    task('PREP_PRE_FEASIBILITY', T.prep_pre_feasibility, 'PREPARATION', { days: 40, role: 'PMB_PLANNER', approver: OWNER, after: [fs('PREP_NEEDS')], docs: ['PRE_FEASIBILITY_REPORT'], checklist: [COMPLETE_ITEM], kpi: [DEVIATION, EVIDENCE], when: [PRE_FEASIBILITY_GROUPS] }),
    task('PREP_POLICY_APPRAISAL', T.prep_policy_appraisal, 'PREPARATION', { days: 20, role: 'DPI_APPRAISER', approver: DECIDER, after: [fs('PREP_PRE_FEASIBILITY')], docs: ['APPRAISAL_REPORT'], kpi: [DEVIATION], when: [POLICY_GROUPS] }),
    task('PREP_POLICY_DECISION', T.prep_policy_decision, 'PREPARATION', { days: 15, role: OWNER, approver: DECIDER, priority: 'HIGH', after: [fs('PREP_POLICY_APPRAISAL')], docs: ['INVESTMENT_POLICY_DECISION'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE], when: [POLICY_GROUPS] }),
    task('PREP_PROPOSAL', T.prep_proposal, 'PREPARATION', { days: 10, role: 'PMB_PLANNER', approver: OWNER, after: [fs('PREP_NEEDS'), fs('PREP_POLICY_DECISION')], checklist: [COMPLETE_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('PREP_DONE', T.prep_done, 'PREPARATION', { milestone: true, after: [fs('PREP_PROPOSAL')] }),
    task('FEAS_STUDY', T.feas_study, 'FEASIBILITY', { days: 45, role: 'PMB_PLANNER', after: [fs('PREP_DONE')], docs: ['FEASIBILITY_REPORT'], checklist: [COMPLETE_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('FEAS_ODA_AGREEMENT', T.feas_oda_agreement, 'FEASIBILITY', { days: 30, role: 'PMB_PLANNER', after: [fs('FEAS_STUDY')], kpi: [DEVIATION], when: [OVERSEAS] }),
    task('FEAS_APPRAISAL', T.feas_appraisal, 'FEASIBILITY', { days: 30, role: 'DPI_APPRAISER', approver: DECIDER, priority: 'HIGH', after: [fs('FEAS_STUDY')], docs: ['APPRAISAL_REPORT'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('FEAS_FINANCE_CHECK', T.feas_finance_check, 'FEASIBILITY', { days: 15, role: 'FINANCE_APPRAISER', approver: DECIDER, after: [fs('FEAS_APPRAISAL')], kpi: [DEVIATION] }),
    task('FEAS_DONE', T.feas_done, 'FEASIBILITY', { milestone: true, after: [fs('FEAS_FINANCE_CHECK'), fs('FEAS_ODA_AGREEMENT')] }),
    task('APPR_DOSSIER', T.appr_dossier, 'APPROVAL', { days: 7, after: [fs('FEAS_DONE')], docs: ['FEASIBILITY_REPORT'], checklist: [COMPLETE_ITEM], kpi: [DEVIATION] }),
    task('APPR_DECISION', T.appr_decision, 'APPROVAL', { days: 15, role: OWNER, approver: DECIDER, priority: 'CRITICAL', after: [fs('APPR_DOSSIER')], docs: ['INVESTMENT_DECISION'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('APPR_CAPITAL_PLAN', T.appr_capital_plan, 'APPROVAL', { days: 20, role: 'PMB_PLANNER', approver: 'DPI_APPRAISER', priority: 'HIGH', after: [fs('APPR_DECISION')], docs: ['CAPITAL_PLAN_DECISION'], kpi: [DEVIATION] }),
    task('APPR_DONE', T.appr_done, 'APPROVAL', { milestone: true, after: [fs('APPR_CAPITAL_PLAN')] }),
    task('IMPL_DESIGN', T.impl_design, 'IMPLEMENTATION', { days: 45, role: 'PMB_MANAGER', approver: OWNER, after: [fs('APPR_DONE')], docs: ['DESIGN_APPROVAL'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('IMPL_BID_PLAN', T.impl_bid_plan, 'IMPLEMENTATION', { days: 10, role: 'PROCUREMENT_OFFICER', approver: OWNER, after: [fs('APPR_DONE')], docs: ['BIDDING_PLAN_DECISION'], kpi: [DEVIATION] }),
    task('IMPL_PROCUREMENT', T.impl_procurement, 'IMPLEMENTATION', { days: 45, role: 'PROCUREMENT_OFFICER', approver: OWNER, after: [fs('IMPL_DESIGN'), fs('IMPL_BID_PLAN')], docs: ['BID_RESULT_DECISION'], kpi: [DEVIATION, EVIDENCE] }),
    task('IMPL_CONTRACT', T.impl_contract, 'IMPLEMENTATION', { days: 10, role: 'LEGAL_OFFICER', approver: OWNER, after: [fs('IMPL_PROCUREMENT')], docs: ['CONSTRUCTION_CONTRACT'], kpi: [DEVIATION] }),
    task('IMPL_SITE', T.impl_site, 'IMPLEMENTATION', { days: 20, role: 'PMB_MANAGER', after: [fs('APPR_DONE')], required: false, kpi: [DEVIATION] }),
    task('IMPL_EXECUTION', T.impl_execution, 'IMPLEMENTATION', { days: 150, role: 'SITE_ENGINEER', priority: 'HIGH', after: [fs('IMPL_CONTRACT'), fs('IMPL_SITE')], kpi: [DEVIATION, AMOUNT] }),
    task('IMPL_SUPERVISION', T.impl_supervision, 'IMPLEMENTATION', { days: 150, role: 'SUPERVISOR', after: [dependency('IMPL_EXECUTION', 'SS'), dependency('IMPL_EXECUTION', 'FF', 2)], kpi: [DEVIATION] }),
    task('IMPL_PAYMENT', T.impl_payment, 'IMPLEMENTATION', { days: 130, role: 'PMB_ACCOUNTANT', approver: 'TREASURY_OFFICER', after: [dependency('IMPL_EXECUTION', 'SS', 20), dependency('IMPL_EXECUTION', 'FF', 5)], docs: ['PAYMENT_REQUEST', 'TREASURY_CONTROL'], kpi: [DEVIATION, AMOUNT, EVIDENCE] }),
    task('IMPL_DONE', T.impl_done, 'IMPLEMENTATION', { milestone: true, after: [fs('IMPL_EXECUTION'), fs('IMPL_SUPERVISION'), fs('IMPL_PAYMENT')] }),
    task('ACC_PREPARE', T.acc_prepare, 'ACCEPTANCE', { days: 7, role: 'SITE_ENGINEER', after: [fs('IMPL_DONE')], checklist: [COMPLETE_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('ACC_INSPECT', T.acc_inspect, 'ACCEPTANCE', { days: 10, role: 'SUPERVISOR', approver: OWNER, priority: 'HIGH', after: [fs('ACC_PREPARE')], docs: ['ACCEPTANCE_MINUTES'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('ACC_HANDOVER', T.acc_handover, 'ACCEPTANCE', { days: 7, role: 'PMB_MANAGER', approver: OWNER, after: [fs('ACC_INSPECT')], docs: ['HANDOVER_MINUTES'], kpi: [DEVIATION] }),
    task('ACC_DONE', T.acc_done, 'ACCEPTANCE', { milestone: true, after: [fs('ACC_HANDOVER')] }),
    task('SET_DOSSIER', T.set_dossier, 'SETTLEMENT', { days: 20, role: 'PMB_ACCOUNTANT', after: [fs('ACC_DONE')], docs: ['SETTLEMENT_REPORT'], checklist: [COMPLETE_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('SET_AUDIT', T.set_audit, 'SETTLEMENT', { days: 30, role: 'AUDITOR', after: [fs('SET_DOSSIER')], kpi: [DEVIATION], when: [group('QTQG', 'A', 'B')] }),
    task('SET_REVIEW', T.set_review, 'SETTLEMENT', { days: 25, role: 'FINANCE_APPRAISER', approver: DECIDER, after: [fs('SET_DOSSIER'), fs('SET_AUDIT')], kpi: [DEVIATION] }),
    task('SET_APPROVE', T.set_approve, 'SETTLEMENT', { days: 10, role: OWNER, approver: DECIDER, priority: 'HIGH', after: [fs('SET_REVIEW')], docs: ['SETTLEMENT_DECISION'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('SET_EVALUATION', T.set_evaluation, 'SETTLEMENT', { days: 20, role: OWNER, required: false, after: [fs('SET_APPROVE')], docs: ['POST_EVALUATION_REPORT'], kpi: [DEVIATION] }),
    task('SET_CLOSED', T.set_closed, 'SETTLEMENT', { milestone: true, after: [fs('SET_APPROVE')] }),
  ],
};

/** Public investment project, purchase of assets and equipment: no site, no design, delivery in place of construction. */
export const PUBLIC_PROCUREMENT_TEMPLATE: Params = {
  name: T.procurement_name,
  project_type: 'PUBLIC_PROCUREMENT',
  phases: phases(),
  tasks: [
    task('PREP_PROPOSAL', T.prep_proposal, 'PREPARATION', { days: 10, role: 'PMB_PLANNER', approver: OWNER, checklist: [COMPLETE_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('PREP_DONE', T.prep_done, 'PREPARATION', { milestone: true, after: [fs('PREP_PROPOSAL')] }),
    task('FEAS_STUDY', T.feas_study, 'FEASIBILITY', { days: 15, role: 'PMB_PLANNER', after: [fs('PREP_DONE')], docs: ['FEASIBILITY_REPORT'], checklist: [COMPLETE_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('FEAS_APPRAISAL', T.feas_appraisal, 'FEASIBILITY', { days: 15, role: 'DPI_APPRAISER', approver: DECIDER, after: [fs('FEAS_STUDY')], docs: ['APPRAISAL_REPORT'], kpi: [DEVIATION] }),
    task('FEAS_DONE', T.feas_done, 'FEASIBILITY', { milestone: true, after: [fs('FEAS_APPRAISAL')] }),
    task('APPR_DECISION', T.appr_decision, 'APPROVAL', { days: 10, role: OWNER, approver: DECIDER, priority: 'CRITICAL', after: [fs('FEAS_DONE')], docs: ['INVESTMENT_DECISION'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('APPR_CAPITAL_PLAN', T.appr_capital_plan, 'APPROVAL', { days: 15, role: 'PMB_PLANNER', approver: 'DPI_APPRAISER', after: [fs('APPR_DECISION')], docs: ['CAPITAL_PLAN_DECISION'], kpi: [DEVIATION] }),
    task('APPR_DONE', T.appr_done, 'APPROVAL', { milestone: true, after: [fs('APPR_CAPITAL_PLAN')] }),
    task('IMPL_BID_PLAN', T.impl_bid_plan, 'IMPLEMENTATION', { days: 7, role: 'PROCUREMENT_OFFICER', approver: OWNER, after: [fs('APPR_DONE')], docs: ['BIDDING_PLAN_DECISION'], kpi: [DEVIATION] }),
    task('IMPL_PROCUREMENT', T.impl_procurement, 'IMPLEMENTATION', { days: 35, role: 'PROCUREMENT_OFFICER', approver: OWNER, after: [fs('IMPL_BID_PLAN')], docs: ['BID_RESULT_DECISION'], kpi: [DEVIATION, EVIDENCE] }),
    task('IMPL_CONTRACT', T.impl_contract, 'IMPLEMENTATION', { days: 7, role: 'LEGAL_OFFICER', approver: OWNER, after: [fs('IMPL_PROCUREMENT')], docs: ['CONSTRUCTION_CONTRACT'], kpi: [DEVIATION] }),
    task('IMPL_DELIVERY', T.impl_delivery, 'IMPLEMENTATION', { days: 60, role: 'PMB_MANAGER', priority: 'HIGH', after: [fs('IMPL_CONTRACT')], kpi: [DEVIATION, AMOUNT] }),
    task('IMPL_PAYMENT', T.impl_payment, 'IMPLEMENTATION', { days: 50, role: 'PMB_ACCOUNTANT', approver: 'TREASURY_OFFICER', after: [dependency('IMPL_DELIVERY', 'SS', 10), dependency('IMPL_DELIVERY', 'FF', 5)], docs: ['PAYMENT_REQUEST', 'TREASURY_CONTROL'], kpi: [DEVIATION, AMOUNT, EVIDENCE] }),
    task('IMPL_DONE', T.impl_done, 'IMPLEMENTATION', { milestone: true, after: [fs('IMPL_DELIVERY'), fs('IMPL_PAYMENT')] }),
    task('ACC_INSPECT', T.acc_inspect, 'ACCEPTANCE', { days: 7, role: 'PMB_MANAGER', approver: OWNER, priority: 'HIGH', after: [fs('IMPL_DONE')], docs: ['ACCEPTANCE_MINUTES'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('ACC_DONE', T.acc_done, 'ACCEPTANCE', { milestone: true, after: [fs('ACC_INSPECT')] }),
    task('SET_DOSSIER', T.set_dossier, 'SETTLEMENT', { days: 15, role: 'PMB_ACCOUNTANT', after: [fs('ACC_DONE')], docs: ['SETTLEMENT_REPORT'], checklist: [COMPLETE_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('SET_APPROVE', T.set_approve, 'SETTLEMENT', { days: 20, role: OWNER, approver: DECIDER, priority: 'HIGH', after: [fs('SET_DOSSIER')], docs: ['SETTLEMENT_DECISION'], checklist: [SIGNED_ITEM], kpi: [DEVIATION] }),
    task('SET_CLOSED', T.set_closed, 'SETTLEMENT', { milestone: true, after: [fs('SET_APPROVE')] }),
  ],
};

/** Public investment project, major repair or refurbishment: a survey in place of a long feasibility study. */
export const PUBLIC_REPAIR_TEMPLATE: Params = {
  name: T.repair_name,
  project_type: 'PUBLIC_REPAIR',
  phases: phases(),
  tasks: [
    task('PREP_NEEDS', T.prep_needs, 'PREPARATION', { days: 5, role: 'PMB_PLANNER', kpi: [DEVIATION] }),
    task('PREP_DONE', T.prep_done, 'PREPARATION', { milestone: true, after: [fs('PREP_NEEDS')] }),
    task('FEAS_STUDY', T.impl_survey, 'FEASIBILITY', { days: 15, role: 'SITE_ENGINEER', after: [fs('PREP_DONE')], checklist: [COMPLETE_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('FEAS_APPRAISAL', T.feas_appraisal, 'FEASIBILITY', { days: 15, role: 'DPI_APPRAISER', approver: DECIDER, after: [fs('FEAS_STUDY')], docs: ['APPRAISAL_REPORT'], kpi: [DEVIATION] }),
    task('FEAS_DONE', T.feas_done, 'FEASIBILITY', { milestone: true, after: [fs('FEAS_APPRAISAL')] }),
    task('APPR_DECISION', T.appr_decision, 'APPROVAL', { days: 10, role: OWNER, approver: DECIDER, priority: 'CRITICAL', after: [fs('FEAS_DONE')], docs: ['INVESTMENT_DECISION'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('APPR_DONE', T.appr_done, 'APPROVAL', { milestone: true, after: [fs('APPR_DECISION')] }),
    task('IMPL_DESIGN', T.impl_design, 'IMPLEMENTATION', { days: 20, role: 'PMB_MANAGER', approver: OWNER, after: [fs('APPR_DONE')], docs: ['DESIGN_APPROVAL'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('IMPL_PROCUREMENT', T.impl_procurement, 'IMPLEMENTATION', { days: 30, role: 'PROCUREMENT_OFFICER', approver: OWNER, after: [fs('IMPL_DESIGN')], docs: ['BID_RESULT_DECISION'], kpi: [DEVIATION, EVIDENCE] }),
    task('IMPL_EXECUTION', T.impl_execution, 'IMPLEMENTATION', { days: 80, role: 'SITE_ENGINEER', priority: 'HIGH', after: [fs('IMPL_PROCUREMENT')], docs: ['CONSTRUCTION_CONTRACT'], kpi: [DEVIATION, AMOUNT] }),
    task('IMPL_SUPERVISION', T.impl_supervision, 'IMPLEMENTATION', { days: 80, role: 'SUPERVISOR', after: [dependency('IMPL_EXECUTION', 'SS'), dependency('IMPL_EXECUTION', 'FF', 2)], kpi: [DEVIATION] }),
    task('IMPL_DONE', T.impl_done, 'IMPLEMENTATION', { milestone: true, after: [fs('IMPL_EXECUTION'), fs('IMPL_SUPERVISION')] }),
    task('ACC_INSPECT', T.acc_inspect, 'ACCEPTANCE', { days: 7, role: 'SUPERVISOR', approver: OWNER, priority: 'HIGH', after: [fs('IMPL_DONE')], docs: ['ACCEPTANCE_MINUTES'], checklist: [SIGNED_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('ACC_DONE', T.acc_done, 'ACCEPTANCE', { milestone: true, after: [fs('ACC_INSPECT')] }),
    task('SET_DOSSIER', T.set_dossier, 'SETTLEMENT', { days: 15, role: 'PMB_ACCOUNTANT', after: [fs('ACC_DONE')], docs: ['SETTLEMENT_REPORT'], checklist: [COMPLETE_ITEM], kpi: [DEVIATION, EVIDENCE] }),
    task('SET_APPROVE', T.set_approve, 'SETTLEMENT', { days: 15, role: OWNER, approver: DECIDER, priority: 'HIGH', after: [fs('SET_DOSSIER')], docs: ['SETTLEMENT_DECISION'], checklist: [SIGNED_ITEM], kpi: [DEVIATION] }),
    task('SET_CLOSED', T.set_closed, 'SETTLEMENT', { milestone: true, after: [fs('SET_APPROVE')] }),
  ],
};
