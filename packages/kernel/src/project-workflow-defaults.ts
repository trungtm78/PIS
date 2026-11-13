import { PWF_PROCESS_TEXT as P } from './messages/pwf-process-texts.ts';
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// PWF-4 (R44, R45): the steps of each phase, the legal grounds of the steps and of some tasks, and more items on the checklists. The grounds cite the catalogue `LEGAL_DOCUMENT` (legal-document.ts) by code and are all `UNVERIFIED`:
// an article is written only where the writers have read it named, and is left out everywhere else (never a guess); the legal officer of the agency confirms them. The items added to the checklists are not required, so that what
// a task needed to be completed before is what it needs now.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface StepSpec {
  code: string;
  name: string;
  phase: string;
  role?: string;
  basis?: readonly Params[];
  tasks: readonly string[];
}

const cite = (document: string, article?: string, note?: string): Params => ({ document, ...(article === undefined ? {} : { article }), ...(note === undefined ? {} : { note }), verification: 'UNVERIFIED' });
const optional = (code: string, name: string, evidence: readonly string[] = []): Params => ({ code, name, required: false, evidence_kinds: evidence });

const INVESTMENT_LAW = cite('LAW_58_2024_QH15', undefined, P.note_order);
const INVESTMENT_DECREE = cite('DECREE_85_2025_ND_CP', undefined, P.note_order);
const BIDDING_LAW = cite('LAW_22_2023_QH15', undefined, P.note_order);
const BIDDING_DECREE = cite('DECREE_214_2025_ND_CP', undefined, P.note_order);
const CONSTRUCTION_LAW = cite('LAW_50_2014_QH13', undefined, P.note_order);
const CONSTRUCTION_DECREE = cite('DECREE_175_2024_ND_CP', undefined, P.note_order);
const QUALITY_DECREE = cite('DECREE_06_2021_ND_CP', undefined, P.note_order);
const SETTLEMENT_DECREE = cite('DECREE_99_2021_ND_CP', undefined, P.note_order);
const ASSETS_LAW = cite('LAW_15_2017_QH14', undefined, P.note_order);

/** The legal grounds of single tasks (those of a step are on the step). */
const TASK_BASIS: Readonly<Record<string, readonly Params[]>> = {
  FEAS_APPRAISAL: [cite('DECREE_85_2025_ND_CP', P.article_appraisal_time, P.note_appraisal_time)],
};

/** Items added to the checklist of a task, none of them required. */
const TASK_CHECKS: Readonly<Record<string, readonly Params[]>> = {
  PREP_NEEDS: [optional('SCOPE_DEFINED', P.check_scope)],
  PREP_PROPOSAL: [optional('CAPITAL_SOURCE', P.check_capital_source)],
  FEAS_APPRAISAL: [optional('OPINIONS_COLLECTED', P.check_appraisal_opinions), optional('APPRAISAL_REPORT', P.check_appraisal_report, ['DOCUMENT'])],
  IMPL_DESIGN: [optional('ESTIMATE_REVIEWED', P.check_design_estimate)],
  IMPL_PROCUREMENT: [optional('NOTICE_POSTED', P.check_bid_notice), optional('EVALUATION_REPORT', P.check_bid_evaluation, ['DOCUMENT'])],
  IMPL_CONTRACT: [optional('PERFORMANCE_GUARANTEE', P.check_contract_guarantee)],
  IMPL_EXECUTION: [optional('SITE_DIARY', P.check_site_diary), optional('VOLUME_CONFIRMED', P.check_volume_confirmed)],
  IMPL_DELIVERY: [optional('DELIVERY_MINUTES', P.check_delivery_minutes, ['DOCUMENT'])],
  ACC_PREPARE: [optional('AS_BUILT', P.check_asbuilt)],
  SET_DOSSIER: [optional('SETTLEMENT_TABLES', P.check_settlement_tables), optional('DEBTS_RECONCILED', P.check_debts_reconciled)],
};

/** A template with its steps: every task is given the step that lists it, the legal grounds of its own and the added items of its checklist. A step that lists no task of the template is dropped, a task no step lists is a defect of this file. */
function withSteps(base: Params, steps: readonly StepSpec[]): Params {
  const tasks = base.tasks as Params[];
  const codes = new Set(tasks.map((one) => one.code as string));
  const used = steps.filter((step) => step.tasks.some((code) => codes.has(code)));
  return {
    ...base,
    steps: used.map((step) => ({ code: step.code, name: step.name, phase: step.phase, ...(step.role === undefined ? {} : { responsible_role: step.role }), ...(step.basis === undefined ? {} : { legal_basis: [...step.basis] }) })),
    tasks: tasks.map((one) => {
      const step = used.find((entry) => entry.tasks.includes(one.code as string));
      if (step === undefined) throw new Error(`project workflow defaults: task ${String(one.code)} belongs to no step`);
      const basis = TASK_BASIS[one.code as string];
      const checks = TASK_CHECKS[one.code as string] ?? [];
      return { ...one, step: step.code, ...(basis === undefined ? {} : { legal_basis: [...basis] }), checklist: [...(one.checklist as Params[]), ...checks] };
    }),
  };
}

const STEPS: readonly StepSpec[] = [
  { code: 'STEP_POLICY', name: P.step_policy, phase: 'PREPARATION', role: OWNER, basis: [INVESTMENT_LAW, INVESTMENT_DECREE], tasks: ['PREP_NEEDS', 'PREP_PRE_FEASIBILITY', 'PREP_POLICY_APPRAISAL', 'PREP_POLICY_DECISION'] },
  { code: 'STEP_PROPOSAL', name: P.step_proposal, phase: 'PREPARATION', role: 'PMB_PLANNER', basis: [INVESTMENT_LAW], tasks: ['PREP_PROPOSAL', 'PREP_DONE'] },
  { code: 'STEP_STUDY', name: P.step_study, phase: 'FEASIBILITY', role: 'PMB_PLANNER', basis: [INVESTMENT_LAW, CONSTRUCTION_LAW, CONSTRUCTION_DECREE], tasks: ['FEAS_STUDY', 'FEAS_ODA_AGREEMENT'] },
  { code: 'STEP_APPRAISAL', name: P.step_appraisal, phase: 'FEASIBILITY', role: 'DPI_APPRAISER', basis: [INVESTMENT_LAW, INVESTMENT_DECREE], tasks: ['FEAS_APPRAISAL', 'FEAS_FINANCE_CHECK', 'FEAS_DONE'] },
  { code: 'STEP_DECISION', name: P.step_decision, phase: 'APPROVAL', role: OWNER, basis: [INVESTMENT_LAW, INVESTMENT_DECREE], tasks: ['APPR_DOSSIER', 'APPR_DECISION'] },
  { code: 'STEP_CAPITAL', name: P.step_capital, phase: 'APPROVAL', role: 'PMB_PLANNER', basis: [INVESTMENT_LAW], tasks: ['APPR_CAPITAL_PLAN', 'APPR_DONE'] },
  { code: 'STEP_DESIGN', name: P.step_design, phase: 'IMPLEMENTATION', role: 'PMB_MANAGER', basis: [CONSTRUCTION_LAW, CONSTRUCTION_DECREE], tasks: ['IMPL_DESIGN'] },
  { code: 'STEP_BIDDING', name: P.step_bidding, phase: 'IMPLEMENTATION', role: 'PROCUREMENT_OFFICER', basis: [BIDDING_LAW, BIDDING_DECREE], tasks: ['IMPL_BID_PLAN', 'IMPL_PROCUREMENT', 'IMPL_CONTRACT'] },
  { code: 'STEP_EXECUTION', name: P.step_execution, phase: 'IMPLEMENTATION', role: 'PMB_MANAGER', basis: [QUALITY_DECREE, SETTLEMENT_DECREE], tasks: ['IMPL_SITE', 'IMPL_EXECUTION', 'IMPL_SUPERVISION', 'IMPL_PAYMENT', 'IMPL_DONE'] },
  { code: 'STEP_ACCEPTANCE', name: P.step_acceptance, phase: 'ACCEPTANCE', role: 'SUPERVISOR', basis: [QUALITY_DECREE], tasks: ['ACC_PREPARE', 'ACC_INSPECT'] },
  { code: 'STEP_HANDOVER', name: P.step_handover, phase: 'ACCEPTANCE', role: 'PMB_MANAGER', basis: [QUALITY_DECREE], tasks: ['ACC_HANDOVER', 'ACC_DONE'] },
  { code: 'STEP_SETTLEMENT', name: P.step_settlement, phase: 'SETTLEMENT', role: 'PMB_ACCOUNTANT', basis: [SETTLEMENT_DECREE], tasks: ['SET_DOSSIER', 'SET_AUDIT', 'SET_REVIEW', 'SET_APPROVE'] },
  { code: 'STEP_CLOSING', name: P.step_closing, phase: 'SETTLEMENT', role: OWNER, basis: [INVESTMENT_LAW], tasks: ['SET_EVALUATION', 'SET_CLOSED'] },
];

/** Purchase of assets: no design; delivery in place of construction, and the law on public assets beside the law on bidding. */
const PROCUREMENT_STEPS: readonly StepSpec[] = [
  { code: 'STEP_PROPOSAL', name: P.step_proposal, phase: 'PREPARATION', role: 'PMB_PLANNER', basis: [INVESTMENT_LAW, ASSETS_LAW], tasks: ['PREP_PROPOSAL', 'PREP_DONE'] },
  { code: 'STEP_STUDY', name: P.step_study, phase: 'FEASIBILITY', role: 'PMB_PLANNER', basis: [INVESTMENT_LAW], tasks: ['FEAS_STUDY'] },
  { code: 'STEP_APPRAISAL', name: P.step_appraisal, phase: 'FEASIBILITY', role: 'DPI_APPRAISER', basis: [INVESTMENT_LAW, INVESTMENT_DECREE], tasks: ['FEAS_APPRAISAL', 'FEAS_DONE'] },
  { code: 'STEP_DECISION', name: P.step_decision, phase: 'APPROVAL', role: OWNER, basis: [INVESTMENT_LAW, INVESTMENT_DECREE], tasks: ['APPR_DECISION'] },
  { code: 'STEP_CAPITAL', name: P.step_capital, phase: 'APPROVAL', role: 'PMB_PLANNER', basis: [INVESTMENT_LAW], tasks: ['APPR_CAPITAL_PLAN', 'APPR_DONE'] },
  { code: 'STEP_BIDDING', name: P.step_bidding, phase: 'IMPLEMENTATION', role: 'PROCUREMENT_OFFICER', basis: [BIDDING_LAW, BIDDING_DECREE], tasks: ['IMPL_BID_PLAN', 'IMPL_PROCUREMENT', 'IMPL_CONTRACT'] },
  { code: 'STEP_DELIVERY', name: P.step_delivery, phase: 'IMPLEMENTATION', role: 'PMB_MANAGER', basis: [SETTLEMENT_DECREE, ASSETS_LAW], tasks: ['IMPL_DELIVERY', 'IMPL_PAYMENT', 'IMPL_DONE'] },
  { code: 'STEP_ACCEPTANCE', name: P.step_acceptance, phase: 'ACCEPTANCE', role: 'PMB_MANAGER', basis: [ASSETS_LAW], tasks: ['ACC_INSPECT', 'ACC_DONE'] },
  { code: 'STEP_SETTLEMENT', name: P.step_settlement, phase: 'SETTLEMENT', role: 'PMB_ACCOUNTANT', basis: [SETTLEMENT_DECREE], tasks: ['SET_DOSSIER', 'SET_APPROVE', 'SET_CLOSED'] },
];

/** Major repair: a survey in place of the study, design and bidding as for construction. */
const REPAIR_STEPS: readonly StepSpec[] = [
  { code: 'STEP_PROPOSAL', name: P.step_proposal, phase: 'PREPARATION', role: 'PMB_PLANNER', basis: [INVESTMENT_LAW], tasks: ['PREP_NEEDS', 'PREP_DONE'] },
  { code: 'STEP_SURVEY', name: P.step_survey, phase: 'FEASIBILITY', role: 'SITE_ENGINEER', basis: [CONSTRUCTION_LAW, CONSTRUCTION_DECREE], tasks: ['FEAS_STUDY'] },
  { code: 'STEP_APPRAISAL', name: P.step_appraisal, phase: 'FEASIBILITY', role: 'DPI_APPRAISER', basis: [INVESTMENT_LAW, INVESTMENT_DECREE], tasks: ['FEAS_APPRAISAL', 'FEAS_DONE'] },
  { code: 'STEP_DECISION', name: P.step_decision, phase: 'APPROVAL', role: OWNER, basis: [INVESTMENT_LAW, INVESTMENT_DECREE], tasks: ['APPR_DECISION', 'APPR_DONE'] },
  { code: 'STEP_DESIGN', name: P.step_design, phase: 'IMPLEMENTATION', role: 'PMB_MANAGER', basis: [CONSTRUCTION_LAW, CONSTRUCTION_DECREE], tasks: ['IMPL_DESIGN'] },
  { code: 'STEP_BIDDING', name: P.step_bidding, phase: 'IMPLEMENTATION', role: 'PROCUREMENT_OFFICER', basis: [BIDDING_LAW, BIDDING_DECREE], tasks: ['IMPL_PROCUREMENT'] },
  { code: 'STEP_EXECUTION', name: P.step_execution, phase: 'IMPLEMENTATION', role: 'PMB_MANAGER', basis: [QUALITY_DECREE, SETTLEMENT_DECREE], tasks: ['IMPL_EXECUTION', 'IMPL_SUPERVISION', 'IMPL_DONE'] },
  { code: 'STEP_ACCEPTANCE', name: P.step_acceptance, phase: 'ACCEPTANCE', role: 'SUPERVISOR', basis: [QUALITY_DECREE], tasks: ['ACC_INSPECT', 'ACC_DONE'] },
  { code: 'STEP_SETTLEMENT', name: P.step_settlement, phase: 'SETTLEMENT', role: 'PMB_ACCOUNTANT', basis: [SETTLEMENT_DECREE], tasks: ['SET_DOSSIER', 'SET_APPROVE', 'SET_CLOSED'] },
];

/** The three templates as the rule type registers them: the tasks, links and days above, in three tiers (phase, step, task) with their legal grounds. */
export const PUBLIC_INVESTMENT_PROCESS: Params = withSteps(PUBLIC_INVESTMENT_TEMPLATE, STEPS);
export const PUBLIC_PROCUREMENT_PROCESS: Params = withSteps(PUBLIC_PROCUREMENT_TEMPLATE, PROCUREMENT_STEPS);
export const PUBLIC_REPAIR_PROCESS: Params = withSteps(PUBLIC_REPAIR_TEMPLATE, REPAIR_STEPS);
