import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex, vietnamDateOf } from '@machvon/kernel';
import { DisWarningStore } from './dis-warning-store.ts';
import { GlossaryStore } from './glossary-store.ts';
import { IntegrationCursorStore } from './integration-cursor-store.ts';
import { contentHashOf } from './master-store.ts';
import type { MasterContent } from './master-store.ts';
import { tenantLookup, validateMasterContent } from './master-types.ts';
import type { EntryRef, TypeLookup } from './master-types.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';
import { vietnameseData } from './vietnamese-data.ts';

/** The Vietnamese text of the baseline (names of categories, legal citations) is master data of the platform: it lives in a resource, keyed in English. */
const vi = (key: string): string => {
  const text = vietnameseData<Readonly<Record<string, string>>>('master-baseline')[key];
  if (text === undefined) throw new Error(`master baseline text ${key} is not in master-baseline.vi.json`);
  return text;
};

export const BASELINE_SOURCE = 'PLATFORM_BASELINE';
export const BASELINE_EVENT = 'master.baseline_applied.v1';

/** One entry of the baseline that the platform publishes to every tenant. */
export interface BaselineEntry {
  masterType: string;
  businessKey: string;
  label: string;
  /** The key of the parent entry of the same type, which comes earlier in the pack. */
  parentKey?: string;
  attributes: Record<string, unknown>;
  validFrom: string;
  validUntil?: string;
  legalBasis?: string;
}

/** A signed pack: the entries and the digest of their canonical form, which the receiver verifies before it applies anything. */
export interface BaselinePack {
  id: string;
  entries: readonly BaselineEntry[];
  sha256: string;
}

export const packDigest = (entries: readonly BaselineEntry[]): string => sha256Hex(canonicalJson(entries));
export const sealPack = (id: string, entries: readonly BaselineEntry[]): BaselinePack => ({ id, entries, sha256: packDigest(entries) });

const SINCE = '2025-01-01';
const LAW = vi('legal.public_investment_law');
const entry = (masterType: string, businessKey: string, label: string, attributes: Record<string, unknown> = {}, rest: Partial<BaselineEntry> = {}): BaselineEntry => ({
  masterType,
  businessKey,
  label,
  attributes,
  validFrom: SINCE,
  ...rest,
});
const fund = (key: string, label: string, category: string, relation: string, parentKey?: string, extra: Record<string, unknown> = {}): BaselineEntry =>
  entry('FUND_SOURCE', key, label, { category, relation, ...extra }, parentKey === undefined ? {} : { parentKey });
const stage = (key: string, label: string, sequence: number, next: string[], terminal = false): BaselineEntry =>
  entry('PROJECT_STAGE', key, label, { sequence, allowed_next: next, ...(terminal ? { terminal: true } : {}) });
const band = (sector: string | null, group: string, min: string, max: string | null) => ({ sector_key: sector, group_key: group, min_amount: min, max_amount: max });
const decisionType = (key: string, label: string, requiredFields: string[]): BaselineEntry => entry('DECISION_TYPE', key, label, { required_fields: requiredFields }, { legalBasis: LAW });
const authority = (key: string, label: string, agency: string, decision: string, scope: string): BaselineEntry =>
  entry('DECISION_AUTHORITY', key, label, { agency_key: agency, decision_type_key: decision, scope }, { legalBasis: LAW });

const unit = (key: string, label: string, dimension: string, factor: string, scale: number): BaselineEntry =>
  entry('UNIT', key, label, { dimension, factor, scale, rounding: 'HALF_UP' });
const currency = (code: string, label: string, scale: number): BaselineEntry => entry('CURRENCY', code, label, { iso_code: code, scale, rounding: 'HALF_UP' });

const PDF = 'application/pdf';
const documentType = (key: string, label: string, checklist: string[]): BaselineEntry =>
  entry('DOCUMENT_TYPE', key, label, { checklist, mime_types: [PDF, 'image/png', 'image/jpeg'], max_size_mb: 50 });
const contractType = (key: string, label: string, versionPolicy: string, isAnnex = false): BaselineEntry =>
  entry('CONTRACT_TYPE', key, label, { required_fields: ['number', 'signed_on', 'contractor', 'value'], version_policy: versionPolicy, ...(isAnnex ? { is_annex: true } : {}) });
const paymentType = (key: string, label: string, kind: string, conditions: string[]): BaselineEntry => entry('PAYMENT_TYPE', key, label, { kind, conditions });
const priority = (key: string, label: string, rank: number, response: number, resolution: number, calendar: string, escalate: number): BaselineEntry =>
  entry('PRIORITY', key, label, { rank, response_hours: response, resolution_hours: resolution, working_calendar: calendar, escalate_after_hours: escalate });
const criterion = (key: string, label: string, category: string, evidence: boolean): BaselineEntry =>
  entry('CONTRACTOR_CRITERION', key, label, { category, scale_max: 10, evidence_required: evidence });
const purpose = (key: string, label: string, consent: string, level: string): BaselineEntry => entry('CONTACT_PURPOSE', key, label, { consent, security_level: level });
const retention = (key: string, label: string, classification: string, years: number | undefined, hold: boolean): BaselineEntry =>
  entry(
    'RETENTION_POLICY',
    key,
    label,
    {
      owner_module: 'DGV',
      awaiting_confirmation: true,
      cxn: 'CXN-05',
      data_class: key,
      classification,
      ...(years === undefined ? { permanent: true } : { retention_years: years }),
      legal_hold_allowed: hold,
    },
    { legalBasis: vi('legal.retention_policy') },
  );

/**
 * The operational catalogues that the other modules select from (ST-MDM-005): document, contract and payment types, priorities and their
 * response times, criteria to evaluate contractors, expert roles, contact purposes with their consent, languages and the retention of
 * each class of data. The response times and retention periods are working assumptions until the owners confirm them (CXN-05 for the
 * retention); a change is a new version through a change request, never an edit.
 */
const OPERATIONAL_CATALOGUES: readonly BaselineEntry[] = [
  documentType('DECISION', vi('document_type.DECISION.label'), ['number', 'issued_on', 'signature']),
  documentType('OFFICIAL_LETTER', vi('document_type.OFFICIAL_LETTER.label'), ['number', 'issued_on']),
  documentType('CONTRACT_FILE', vi('document_type.CONTRACT_FILE.label'), ['signed_copy', 'annexes']),
  documentType('PAYMENT_VOUCHER', vi('document_type.PAYMENT_VOUCHER.label'), ['request', 'acceptance', 'invoice']),
  documentType('ACCEPTANCE_MINUTES', vi('document_type.ACCEPTANCE_MINUTES.label'), ['signatures', 'quantities']),
  contractType('CONSTRUCTION', vi('contract_type.CONSTRUCTION.label'), 'NEW_REVISION'),
  contractType('SUPPLY', vi('contract_type.SUPPLY.label'), 'NEW_REVISION'),
  contractType('CONSULTING', vi('contract_type.CONSULTING.label'), 'NEW_REVISION'),
  contractType('ANNEX', vi('contract_type.ANNEX.label'), 'ANNEX_ONLY', true),
  paymentType('ADVANCE', vi('payment_type.ADVANCE.label'), 'ADVANCE', ['guarantee_in_place', 'contract_signed']),
  paymentType('INTERIM', vi('payment_type.INTERIM.label'), 'PAYMENT', ['acceptance_signed', 'within_contract_value']),
  paymentType('FINAL', vi('payment_type.FINAL.label'), 'PAYMENT', ['final_acceptance', 'advance_recovered']),
  paymentType('RETENTION_RELEASE', vi('payment_type.RETENTION_RELEASE.label'), 'RETENTION_RELEASE', ['warranty_period_ended']),
  priority('URGENT', vi('priority.URGENT.label'), 1, 4, 24, 'ALL_DAYS', 12),
  priority('HIGH', 'Cao', 2, 8, 72, 'WORKING_DAYS', 48),
  priority('NORMAL', vi('priority.NORMAL.label'), 3, 24, 168, 'WORKING_DAYS', 120),
  priority('LOW', vi('priority.LOW.label'), 4, 72, 336, 'WORKING_DAYS', 240),
  criterion('QUALITY_OF_WORK', vi('contractor_criterion.QUALITY_OF_WORK.label'), 'QUALITY', true),
  criterion('SCHEDULE_ADHERENCE', vi('contractor_criterion.SCHEDULE_ADHERENCE.label'), 'SCHEDULE', true),
  criterion('SAFETY_RECORD', vi('contractor_criterion.SAFETY_RECORD.label'), 'SAFETY', true),
  criterion('COST_DISCIPLINE', vi('contractor_criterion.COST_DISCIPLINE.label'), 'COST', false),
  criterion('LEGAL_COMPLIANCE', vi('contractor_criterion.LEGAL_COMPLIANCE.label'), 'COMPLIANCE', true),
  entry('EXPERT_ROLE', 'PROJECT_MANAGER', vi('expert_role.PROJECT_MANAGER.label'), { specialty: 'project_management', conditions: ['certificate_in_force'] }),
  entry('EXPERT_ROLE', 'SUPERVISION_ENGINEER', vi('expert_role.SUPERVISION_ENGINEER.label'), { specialty: 'construction_supervision', conditions: ['certificate_in_force'] }),
  entry('EXPERT_ROLE', 'COST_ESTIMATOR', vi('expert_role.COST_ESTIMATOR.label'), { specialty: 'cost_estimation' }),
  purpose('SERVICE_NOTICE', vi('contact_purpose.SERVICE_NOTICE.label'), 'NOT_REQUIRED', 'INTERNAL'),
  purpose('SATISFACTION_SURVEY', vi('contact_purpose.SATISFACTION_SURVEY.label'), 'EXPLICIT', 'INTERNAL'),
  purpose('SENSITIVE_FOLLOW_UP', vi('contact_purpose.SENSITIVE_FOLLOW_UP.label'), 'EXPLICIT', 'CONFIDENTIAL'),
  entry('LANGUAGE', 'vi', vi('language.vi.label'), { native_name: vi('language.vi.native_name') }),
  entry('LANGUAGE', 'en', vi('language.en.label'), { native_name: 'English' }),
  retention('FINANCIAL_RECORD', vi('retention_policy.FINANCIAL_RECORD.label'), 'CONFIDENTIAL', 10, true),
  retention('CONTRACT_RECORD', vi('retention_policy.CONTRACT_RECORD.label'), 'CONFIDENTIAL', 10, true),
  retention('CHANGE_REQUEST', vi('retention_policy.CHANGE_REQUEST.label'), 'INTERNAL', 10, false),
  retention('IMPORT_BATCH', vi('retention_policy.IMPORT_BATCH.label'), 'INTERNAL', 5, false),
  retention('MASTER_DATA', vi('retention_policy.MASTER_DATA.label'), 'INTERNAL', undefined, false),
];

/**
 * The reporting calendar, the units and the currencies (ST-MDM-004). The calendar is the D03 working assumption (weeks from Saturday to
 * Friday, due on Friday at 10:00 in Vietnam) until the owner of the capital business signs it: it is data, so another decision is a new
 * version and no code change.
 */
const CALENDAR_AND_UNITS: readonly BaselineEntry[] = [
  entry(
    'CALENDAR',
    'DEFAULT',
    vi('calendar.DEFAULT.label'),
    {
      owner_module: 'DIS',
      awaiting_confirmation: true,
      cxn: 'ASSUMPTION-D03',
      week_starts_on: 'SATURDAY',
      deadline_weekday: 'FRIDAY',
      deadline_time: '10:00',
      timezone: 'Asia/Ho_Chi_Minh',
    },
    { legalBasis: vi('legal.calendar_default') },
  ),
  unit('M', vi('unit.M.label'), 'LENGTH', '1', 2),
  unit('KM', vi('unit.KM.label'), 'LENGTH', '1000', 3),
  unit('M2', vi('unit.M2.label'), 'AREA', '1', 2),
  unit('HA', vi('unit.HA.label'), 'AREA', '10000', 4),
  unit('M3', vi('unit.M3.label'), 'VOLUME', '1', 2),
  unit('KG', vi('unit.KG.label'), 'MASS', '1', 3),
  unit('TON', vi('unit.TON.label'), 'MASS', '1000', 3),
  unit('PCS', vi('unit.PCS.label'), 'COUNT', '1', 0),
  currency('VND', vi('currency.VND.label'), 0),
  currency('USD', vi('currency.USD.label'), 2),
  currency('EUR', 'Euro', 2),
  currency('JPY', vi('currency.JPY.label'), 0),
];

/**
 * The first baseline (MDM 3.1 F8, ST-MDM-003): the funding source tree with the national target programmes inside their budget
 * source, the sectors, the project groups, types and stages (the stage graph of PRJ 3.1), the decision types and authorities, and the
 * rule data. A rule that waits for a confirmation says which one; until it arrives the rule is a working assumption that the screens
 * that apply it label as such. An entry comes before every entry that refers to it.
 */
const ENTRIES: readonly BaselineEntry[] = [
  fund('NSTW', vi('fund_source.NSTW.label'), 'NSTW', 'ADDITIVE'),
  fund('NSTW-DTPT', vi('fund_source.NSTW-DTPT.label'), 'NSTW', 'ADDITIVE', 'NSTW'),
  fund('NSDP', vi('fund_source.NSDP.label'), 'NSDP', 'ADDITIVE'),
  fund('NSDP-DTPT', vi('fund_source.NSDP-DTPT.label'), 'NSDP', 'ADDITIVE', 'NSDP'),
  fund('ODA-NONLEND', vi('fund_source.ODA-NONLEND.label'), 'ODA', 'ADDITIVE', undefined, { onlending: false }),
  fund('ODA-ONLEND', vi('fund_source.ODA-ONLEND.label'), 'ODA', 'ADDITIVE', undefined, { onlending: true }),
  fund('CTMTQG-NTM', vi('fund_source.CTMTQG-NTM.label'), 'CTMTQG', 'SUBSET_OF', 'NSTW-DTPT'),
  fund('CTMTQG-GNBV', vi('fund_source.CTMTQG-GNBV.label'), 'CTMTQG', 'SUBSET_OF', 'NSTW-DTPT'),
  fund('CTMTQG-DTTS', vi('fund_source.CTMTQG-DTTS.label'), 'CTMTQG', 'SUBSET_OF', 'NSTW-DTPT'),
  entry('PROGRAM', 'NTM', vi('program.NTM.label'), { kind: 'CTMTQG', period_from: 2021, period_to: 2025, fund_source_key: 'CTMTQG-NTM' }),
  entry('PROGRAM', 'GNBV', vi('program.GNBV.label'), { kind: 'CTMTQG', period_from: 2021, period_to: 2025, fund_source_key: 'CTMTQG-GNBV' }),
  entry('PROGRAM', 'DTTS', vi('program.DTTS.label'), { kind: 'CTMTQG', period_from: 2021, period_to: 2025, fund_source_key: 'CTMTQG-DTTS' }),
  ...[
    ['TRANSPORT', vi('sector.TRANSPORT.label')],
    ['AGRICULTURE', vi('sector.AGRICULTURE.label')],
    ['EDUCATION', vi('sector.EDUCATION.label')],
    ['HEALTH', vi('sector.HEALTH.label')],
    ['CULTURE_SPORT', vi('sector.CULTURE_SPORT.label')],
    ['ENVIRONMENT', vi('sector.ENVIRONMENT.label')],
    ['ICT', vi('sector.ICT.label')],
    ['URBAN', vi('sector.URBAN.label')],
  ].map(([key, label], index) => entry('SECTOR', key as string, label as string, { sort_order: (index + 1) * 10 })),
  entry('PROJECT_GROUP', 'QTQG', vi('project_group.QTQG.label'), { rank: 1 }, { legalBasis: LAW }),
  entry('PROJECT_GROUP', 'A', vi('project_group.A.label'), { rank: 2 }, { legalBasis: LAW }),
  entry('PROJECT_GROUP', 'B', vi('project_group.B.label'), { rank: 3 }, { legalBasis: LAW }),
  entry('PROJECT_GROUP', 'C', vi('project_group.C.label'), { rank: 4 }, { legalBasis: LAW }),
  entry('PROJECT_TYPE', 'NEW_BUILD', vi('project_type.NEW_BUILD.label'), { kind: 'CAPITAL_WORKS' }),
  entry('PROJECT_TYPE', 'UPGRADE', vi('project_type.UPGRADE.label'), { kind: 'CAPITAL_WORKS' }),
  entry('PROJECT_TYPE', 'PROCUREMENT', vi('project_type.PROCUREMENT.label'), { kind: 'PROCUREMENT' }),
  entry('PROJECT_TYPE', 'PREPARATION', vi('project_type.PREPARATION.label'), { kind: 'PREPARATION' }),
  stage('CONCEPT', vi('project_stage.CONCEPT.label'), 1, ['APPRAISAL', 'CANCELLED']),
  stage('APPRAISAL', vi('project_stage.APPRAISAL.label'), 2, ['PIPELINE', 'REJECTED', 'CONCEPT', 'CANCELLED']),
  stage('PIPELINE', vi('project_stage.PIPELINE.label'), 3, ['BUDGETED', 'CANCELLED']),
  stage('BUDGETED', vi('project_stage.BUDGETED.label'), 4, ['IMPLEMENTATION', 'CANCELLED']),
  stage('IMPLEMENTATION', vi('project_stage.IMPLEMENTATION.label'), 5, ['SUSPENDED', 'COMPLETED']),
  stage('SUSPENDED', vi('project_stage.SUSPENDED.label'), 6, ['IMPLEMENTATION']),
  stage('COMPLETED', vi('project_stage.COMPLETED.label'), 7, ['SETTLED']),
  stage('SETTLED', vi('project_stage.SETTLED.label'), 8, ['CLOSED']),
  stage('CLOSED', vi('project_stage.CLOSED.label'), 9, [], true),
  stage('REJECTED', vi('project_stage.REJECTED.label'), 10, [], true),
  stage('CANCELLED', vi('project_stage.CANCELLED.label'), 11, [], true),
  decisionType('INVESTMENT_POLICY', vi('decision_type.INVESTMENT_POLICY.label'), ['number', 'issued_on', 'issuing_authority', 'total_investment']),
  decisionType('INVESTMENT_DECISION', vi('decision_type.INVESTMENT_DECISION.label'), ['number', 'issued_on', 'issuing_authority', 'total_investment']),
  decisionType('PLAN_ASSIGNMENT', vi('decision_type.PLAN_ASSIGNMENT.label'), ['number', 'issued_on', 'issuing_authority', 'plan_year']),
  decisionType('SETTLEMENT_APPROVAL', vi('decision_type.SETTLEMENT_APPROVAL.label'), ['number', 'issued_on', 'issuing_authority', 'settled_amount']),
  authority('NA-POLICY', vi('decision_authority.NA-POLICY.label'), 'NATIONAL_ASSEMBLY', 'INVESTMENT_POLICY', 'NATIONAL'),
  authority('PM-POLICY', vi('decision_authority.PM-POLICY.label'), 'PRIME_MINISTER', 'INVESTMENT_POLICY', 'NATIONAL'),
  authority('PC-POLICY', vi('decision_authority.PC-POLICY.label'), 'PROVINCIAL_PEOPLES_COUNCIL', 'INVESTMENT_POLICY', 'PROVINCE'),
  authority('PCOM-DECISION', vi('decision_authority.PCOM-DECISION.label'), 'PROVINCIAL_PEOPLES_COMMITTEE', 'INVESTMENT_DECISION', 'PROVINCE'),
  authority('CCOM-DECISION', vi('decision_authority.CCOM-DECISION.label'), 'COMMUNE_PEOPLES_COMMITTEE', 'INVESTMENT_DECISION', 'COMMUNE'),
  entry(
    'PROJECT_GROUP_THRESHOLDS',
    'DEFAULT',
    vi('project_group_thresholds.DEFAULT.label'),
    {
      owner_module: 'PRJ',
      awaiting_confirmation: true,
      cxn: 'CXN-32',
      bands: [band(null, 'C', '0', '120000000000'), band(null, 'B', '120000000000', '2300000000000'), band(null, 'A', '2300000000000', '30000000000000'), band(null, 'QTQG', '30000000000000', null)],
    },
    { legalBasis: `${LAW} ${vi('legal.project_group_thresholds')}` },
  ),
  entry(
    'NATIONAL_CODE_REQUIRED',
    'DEFAULT',
    vi('national_code_required.DEFAULT.label'),
    { owner_module: 'CAP', awaiting_confirmation: true, cxn: 'CXN-01', mode: 'BLOCK', from_stage_key: 'PIPELINE' },
    { legalBasis: vi('legal.national_code') },
  ),
  entry(
    'NATIONAL_CODE_FORMAT',
    'DEFAULT',
    vi('national_code_format.DEFAULT.label'),
    { owner_module: 'CAP', awaiting_confirmation: true, cxn: 'CXN-01', pattern: '^\\d{7}$', example: '7654321' },
    { legalBasis: vi('legal.national_code') },
  ),
  entry(
    'APPRAISAL_CRITERIA',
    'APPR-CRIT-2026r1',
    vi('appraisal_criteria.APPR-CRIT-2026r1.label'),
    {
      owner_module: 'PRJ',
      awaiting_confirmation: true,
      cxn: 'ASSUMPTION-APPRAISAL-60',
      criteria: [
        { code: 'POLICY_ALIGNMENT', name: vi('appraisal_criteria.criteria.POLICY_ALIGNMENT'), max_score: 25 },
        { code: 'FEASIBILITY', name: vi('appraisal_criteria.criteria.FEASIBILITY'), max_score: 25 },
        { code: 'EFFECTIVENESS', name: vi('appraisal_criteria.criteria.EFFECTIVENESS'), max_score: 20 },
        { code: 'CAPITAL_READINESS', name: vi('appraisal_criteria.criteria.CAPITAL_READINESS'), max_score: 20 },
        { code: 'RISK', name: vi('appraisal_criteria.criteria.RISK'), max_score: 10 },
      ],
      pass_threshold: 60,
    },
    { legalBasis: vi('legal.appraisal_criteria') },
  ),
];

const LAND_LAW = vi('legal.land_law');
const landTimer = (key: string, label: string, days: number): BaselineEntry =>
  entry('LND_TIMER', key, label, { owner_module: 'LND', awaiting_confirmation: true, cxn: 'CXN-12', days, day_count: 'CALENDAR' }, { legalBasis: LAND_LAW });

/** The timers of land clearance (BR-LND-01): calendar days, flagged with the confirmation they wait for. */
const LAND_TIMERS: readonly BaselineEntry[] = [
  landTimer('NOTICE_AGRICULTURAL_90', vi('lnd_timer.NOTICE_AGRICULTURAL_90.label'), 90),
  landTimer('NOTICE_NON_AGRICULTURAL_180', vi('lnd_timer.NOTICE_NON_AGRICULTURAL_180.label'), 180),
  landTimer('PLAN_POSTING_30', vi('lnd_timer.PLAN_POSTING_30.label'), 30),
  landTimer('PAYMENT_30', vi('lnd_timer.PAYMENT_30.label'), 30),
  landTimer('COMPLAINT_RESOLUTION', vi('lnd_timer.COMPLAINT_RESOLUTION.label'), 30),
];

const PETITION_LAW = vi('legal.petition_law');
const petitionDeadline = (key: string, label: string, days: number): BaselineEntry =>
  entry('BID_PETITION', key, label, { owner_module: 'BID', awaiting_confirmation: true, cxn: 'CXN-BID-02', days, day_count: 'CALENDAR' }, { legalBasis: PETITION_LAW });

/** The deadlines to answer a petition of a contractor (BR-BID-14): calendar days, the stricter reading, flagged with the confirmation they wait for. A tenant that counts working days publishes a version that names its calendar. */
const PETITION_DEADLINES: readonly BaselineEntry[] = [
  petitionDeadline('PROCESS', vi('bid_petition.PROCESS.label'), 7),
  petitionDeadline('RESULT', vi('bid_petition.RESULT.label'), 7),
];

const REGIME_LAW = vi('legal.regime_law');
const checklist = (inspectionType: string, items: Array<[string, string]>) => ({ inspection_type: inspectionType, items: items.map(([code, label]) => ({ code, label })) });
/** The checklists of the working assumption: what the supervisor checks for each kind of inspection, until the owner of the construction business signs the regime. */
const REGIME_CHECKLISTS = [
  checklist('MATERIAL_ENTRY', [['ORIGIN', vi('qms_regime.checklist.MATERIAL_ENTRY.ORIGIN')], ['SAMPLE', vi('qms_regime.checklist.MATERIAL_ENTRY.SAMPLE')]]),
  checklist('CONCEALED_WORK', [['DRAWING', vi('qms_regime.checklist.CONCEALED_WORK.DRAWING')], ['QUALITY', vi('qms_regime.checklist.CONCEALED_WORK.QUALITY')], ['RECORD', vi('qms_regime.checklist.CONCEALED_WORK.RECORD')]]),
  checklist('CONSTRUCTION_STAGE', [['DRAWING', vi('qms_regime.checklist.CONSTRUCTION_STAGE.DRAWING')], ['QUALITY', vi('qms_regime.checklist.CONSTRUCTION_STAGE.QUALITY')]]),
  checklist('PART_ACCEPTANCE', [['DRAWING', vi('qms_regime.checklist.PART_ACCEPTANCE.DRAWING')], ['QUALITY', vi('qms_regime.checklist.PART_ACCEPTANCE.QUALITY')]]),
  checklist('COMPLETION', [['DRAWING', vi('qms_regime.checklist.COMPLETION.DRAWING')], ['QUALITY', vi('qms_regime.checklist.COMPLETION.QUALITY')], ['DOSSIER', vi('qms_regime.checklist.COMPLETION.DOSSIER')]]),
  checklist('SAFETY', [['MEASURES', vi('qms_regime.checklist.SAFETY.MEASURES')], ['EQUIPMENT', vi('qms_regime.checklist.SAFETY.EQUIPMENT')]]),
  checklist('OTHER', [['CONTENT', vi('qms_regime.checklist.OTHER.CONTENT')]]),
];
const regime = (key: string, label: string, requiredRoles: string[], validFrom: string, validUntil?: string): BaselineEntry =>
  entry(
    'QMS_REGIME',
    key,
    label,
    { owner_module: 'QMS', awaiting_confirmation: true, cxn: 'CXN-07', required_roles: requiredRoles, completion_required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'], checklists: REGIME_CHECKLISTS },
    { legalBasis: REGIME_LAW, validFrom, ...(validUntil === undefined ? {} : { validUntil }) },
  );

/** The regimes of quality management (BR-QMS-04): the current decree until the end of 2026 and the one that replaces it from 2027, both flagged with the confirmation they wait for. */
const QMS_REGIMES: readonly BaselineEntry[] = [
  regime('ND-06-2021', vi('qms_regime.ND-06-2021.label'), ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], SINCE, '2027-01-01'),
  regime('ND-207-2026', vi('qms_regime.ND-207-2026.label'), ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'], '2027-01-01'),
];

const WARRANTY_LAW = vi('legal.warranty_law');
const warrantyMinimum = (grade: string, label: string, months: number): BaselineEntry =>
  entry('AST_WARRANTY', grade, label, { owner_module: 'AST', awaiting_confirmation: true, cxn: 'CXN-EXE-04', min_months: months }, { legalBasis: WARRANTY_LAW });

/** The shortest warranty of a work by its grade (BR-AST-03): the fixture of the acceptance tests, flagged as such — 24 months for a special work or a work of grade I, 12 months for the others. */
const WARRANTY_MINIMUMS: readonly BaselineEntry[] = [
  warrantyMinimum('SPECIAL', vi('ast_warranty.SPECIAL.label'), 24),
  warrantyMinimum('I', vi('ast_warranty.I.label'), 24),
  warrantyMinimum('II', vi('ast_warranty.II.label'), 12),
  warrantyMinimum('III', vi('ast_warranty.III.label'), 12),
  warrantyMinimum('IV', vi('ast_warranty.IV.label'), 12),
];

const ADVANCE_LAW = vi('legal.advance_law');
const advanceCap = (key: string, label: string, tiers: Array<{ min_value_vnd: string; cap_pct: string }>): BaselineEntry =>
  entry('PAY_ADVANCE_CAP', key, label, { owner_module: 'PAY', awaiting_confirmation: true, cxn: 'CXN-02', tiers, recovery_threshold_pct: '80' }, { legalBasis: ADVANCE_LAW });

/** The caps of the advance (BR-PAY-10): the fixture of the acceptance tests, flagged as such. A category with no row cannot be advanced until its owner publishes one. */
const ADVANCE_CAPS: readonly BaselineEntry[] = [
  advanceCap('CONSTRUCTION', vi('pay_advance_cap.CONSTRUCTION.label'), [{ min_value_vnd: '10000000000', cap_pct: '20' }]),
  advanceCap('CONSULTING', vi('pay_advance_cap.CONSULTING.label'), [{ min_value_vnd: '0', cap_pct: '30' }]),
  entry('PAY_ADVANCE_GPMB', 'GPMB', vi('pay_advance_gpmb.GPMB.label'), { owner_module: 'PAY', awaiting_confirmation: true, cxn: 'CXN-12', recovery_days: 30 }, { legalBasis: vi('legal.pay_advance_gpmb') }),
];

/** The days the verification of a settlement may take (BR-PAY-15): the numbers are the fixture of the acceptance tests (UAT-AC339), not a regulation, and wait for the confirmation named by CXN-09. */
/**
 * The areas the platform publishes: the 34 provinces and cities in force since the arrangement of 2025. A tenant extends them with entries of its own (a ward, a commune)
 * under the province they belong to; with none published, a new tenant could not name the area of its first project.
 */
const PROVINCES: readonly string[] = ['HA-NOI', 'HUE', 'LAI-CHAU', 'DIEN-BIEN', 'SON-LA', 'LANG-SON', 'QUANG-NINH', 'THANH-HOA', 'NGHE-AN', 'HA-TINH', 'CAO-BANG', 'TUYEN-QUANG', 'LAO-CAI', 'THAI-NGUYEN', 'PHU-THO', 'BAC-NINH', 'HUNG-YEN', 'HAI-PHONG', 'NINH-BINH', 'QUANG-TRI', 'DA-NANG', 'QUANG-NGAI', 'GIA-LAI', 'KHANH-HOA', 'LAM-DONG', 'DAK-LAK', 'HO-CHI-MINH', 'DONG-NAI', 'TAY-NINH', 'CAN-THO', 'VINH-LONG', 'DONG-THAP', 'CA-MAU', 'AN-GIANG'];
const AREAS: readonly BaselineEntry[] = PROVINCES.map((key) => entry('AREA', key, vi(`area.${key}.label`), {}, { validFrom: '2025-07-01', legalBasis: vi('legal.province_arrangement') }));

const SETTLEMENT_DEADLINES: readonly BaselineEntry[] = [
  entry(
    'PAY_SETTLEMENT_DEADLINE',
    'VERIFY_DEADLINE',
    vi('pay_settlement_deadline.VERIFY_DEADLINE.label'),
    {
      owner_module: 'PAY',
      awaiting_confirmation: true,
      cxn: 'CXN-09',
      days_by_group: [
        { project_group: 'QTQG', days: 270 },
        { project_group: 'A', days: 270 },
        { project_group: 'B', days: 180 },
        { project_group: 'C', days: 120 },
      ],
    },
    { legalBasis: vi('legal.settlement_deadline') },
  ),
];

export const BASELINE_PACK: BaselinePack = sealPack('PLATFORM-2026.1', [...ENTRIES, ...CALENDAR_AND_UNITS, ...OPERATIONAL_CATALOGUES, ...LAND_TIMERS, ...PETITION_DEADLINES, ...QMS_REGIMES, ...WARRANTY_MINIMUMS, ...ADVANCE_CAPS, ...SETTLEMENT_DEADLINES, ...AREAS]);

const EDITION_PACKS = new Map<string, BaselinePack>();

/**
 * Adds a signed pack of an edition to the baselines the sync job applies after the platform pack (ENT-3e: the project types of the enterprise edition). Idempotent for the same pack; a different pack under a used id is a
 * defect of the caller. A public process registers none, so its job applies exactly the platform pack as before.
 */
export function registerEditionBaseline(pack: BaselinePack): void {
  const known = EDITION_PACKS.get(pack.id);
  if (known !== undefined) {
    if (known.sha256 !== pack.sha256) throw new Error(`baseline pack ${pack.id} is already registered with other content`);
    return;
  }
  EDITION_PACKS.set(pack.id, pack);
}

/** The packs of the edition the process serves, in the order they were registered. */
export const editionBaselines = (): BaselinePack[] => [...EDITION_PACKS.values()];

export interface BaselineResult {
  created: number;
  /** Entries that gained a version because the pack carries a later one. */
  superseded: number;
  unchanged: number;
}

const contentOf = (item: BaselineEntry, parentRecordId: string | null): MasterContent => ({
  label: item.label,
  attributes: item.attributes,
  parentRecordId,
  validFrom: item.validFrom,
  validUntil: item.validUntil ?? null,
  legalBasis: item.legalBasis ?? null,
});

/**
 * Gives an entry that the tenant already has the version the pack carries, when it is a new one: false when some version of the entry
 * has this very content (a pack applied twice, or an older pack applied after a newer one).
 */
async function supersede(tx: TenantTx, recordId: string, item: BaselineEntry, content: MasterContent, actor: string, on: string): Promise<boolean> {
  const hash = contentHashOf(item.masterType, item.businessKey, content);
  const versions = await tx.query<{ id: string; revision: number; valid_from: string; valid_until: string | null; content_sha256: string | null }>(
    'select id, revision, valid_from::text as valid_from, valid_until::text as valid_until, content_sha256 from machvon.master_record_version where master_record_id = $1::uuid order by revision desc',
    [recordId],
  );
  if (versions.some((version) => version.content_sha256 === hash)) return false;
  const latest = versions[0];
  if (latest === undefined || item.validFrom <= latest.valid_from) throw new Error(`baseline entry ${item.masterType}/${item.businessKey} would change a version that is already in force`);
  if (latest.valid_until === null || latest.valid_until > item.validFrom) {
    await tx.query('update machvon.master_record_version set valid_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [latest.id, item.validFrom, actor]);
  }
  const inForce = item.validFrom <= on;
  const created = await tx.query<{ id: string }>(
    `insert into machvon.master_record_version
       (tenant_id, id, master_record_id, master_type, code, revision, label, parent_id, attributes, valid_from, valid_until, status, namespace, source_system, supersedes_id,
        legal_basis, content_sha256, approved_by, published_at, created_by, updated_by)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $8::date, $9::date, $10, 'PLATFORM', $11,
        $12::uuid, $13, $14, $15::uuid, now(), $15::uuid, $15::uuid)
     returning id`,
    [
      recordId,
      item.masterType,
      item.businessKey,
      latest.revision + 1,
      item.label,
      content.parentRecordId,
      JSON.stringify(item.attributes),
      item.validFrom,
      item.validUntil ?? null,
      inForce ? 'EFFECTIVE' : 'APPROVED',
      BASELINE_SOURCE,
      latest.id,
      item.legalBasis ?? null,
      hash,
      actor,
    ],
  );
  if (inForce) {
    // Every earlier version ends here, one that never became active too: the activation job would otherwise put it back in force.
    await tx.query("update machvon.master_record_version set status = 'RETIRED' where master_record_id = $1::uuid and revision < $2 and status in ('EFFECTIVE', 'APPROVED')", [recordId, latest.revision + 1]);
    await tx.query('update machvon.master_record set current_version_id = $2::uuid, status = $3, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid', [
      recordId,
      (created[0] as { id: string }).id,
      'EFFECTIVE',
      actor,
    ]);
  }
  return true;
}

/**
 * Applies a signed baseline pack to the tenant (job `master-baseline-sync`, MDM 3.1 §9): the digest is verified first, every entry
 * meets the rules of its type (the pack may refer to its own entries), and an entry the tenant already has is left alone. The entries
 * are written in the namespace PLATFORM, in force from their date, and carry the digest of their content; a tenant never edits them.
 * A later pack may carry a newer version of an entry: it starts at its own date and the version before it ends there, so the history
 * is never rewritten. A pack that would change a version already in force from a date at or before it is refused.
 */
export async function applyBaseline(tx: TenantTx, pack: BaselinePack, actor: string, on: string = vietnamDateOf(new Date())): Promise<BaselineResult> {
  if (packDigest(pack.entries) !== pack.sha256) throw new Error(`baseline pack ${pack.id} does not match its digest`);
  const database = tenantLookup(tx);
  const inPack = new Map<string, EntryRef>(pack.entries.map((item) => [`${item.masterType}:${item.businessKey}`, { masterType: item.masterType, businessKey: item.businessKey, attributes: item.attributes }]));
  const lookup: TypeLookup = { entry: async (masterType, businessKey) => inPack.get(`${masterType}:${businessKey}`) ?? (await database.entry(masterType, businessKey)) };
  const recordIds = new Map<string, string>();
  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  for (const item of pack.entries) {
    const existing = await tx.query<{ id: string }>("select id from machvon.master_record where namespace = 'PLATFORM' and master_type = $1 and business_key = $2 for update", [item.masterType, item.businessKey]);
    const parentRecordId = item.parentKey === undefined ? null : (recordIds.get(`${item.masterType}:${item.parentKey}`) ?? null);
    if (item.parentKey !== undefined && parentRecordId === null) throw new Error(`baseline entry ${item.masterType}/${item.businessKey} names a parent that is not in the pack before it`);
    const content = contentOf(item, parentRecordId);
    await validateMasterContent({
      masterType: item.masterType,
      businessKey: item.businessKey,
      content,
      parent: item.parentKey === undefined ? undefined : inPack.get(`${item.masterType}:${item.parentKey}`),
      lookup,
    });
    if (existing[0] !== undefined) {
      recordIds.set(`${item.masterType}:${item.businessKey}`, existing[0].id);
      if (await supersede(tx, existing[0].id, item, content, actor, on)) superseded += 1;
      else unchanged += 1;
      continue;
    }
    const inForce = item.validFrom <= on;
    const recordId = randomUUID();
    const versionId = randomUUID();
    await tx.query(
      `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, 'PLATFORM', $2, $3, $4, $5::uuid, $5::uuid)`,
      [recordId, item.masterType, item.businessKey, inForce ? 'EFFECTIVE' : 'APPROVED', actor],
    );
    await tx.query(
      `insert into machvon.master_record_version
         (tenant_id, id, master_record_id, master_type, code, revision, label, parent_id, attributes, valid_from, valid_until, status, namespace, source_system,
          legal_basis, content_sha256, approved_by, published_at, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, 1, $5, $6::uuid, $7::jsonb, $8::date, $9::date, $10, 'PLATFORM', $11,
          $12, $13, $14::uuid, now(), $14::uuid, $14::uuid)`,
      [
        versionId,
        recordId,
        item.masterType,
        item.businessKey,
        item.label,
        parentRecordId,
        JSON.stringify(item.attributes),
        item.validFrom,
        item.validUntil ?? null,
        inForce ? 'EFFECTIVE' : 'APPROVED',
        BASELINE_SOURCE,
        item.legalBasis ?? null,
        contentHashOf(item.masterType, item.businessKey, content),
        actor,
      ],
    );
    if (inForce) await tx.query('update machvon.master_record set current_version_id = $2::uuid where id = $1::uuid', [recordId, versionId]);
    recordIds.set(`${item.masterType}:${item.businessKey}`, recordId);
    created += 1;
  }
  // The connectors that feed master data exist for every tenant, with their adapter still PROPOSED.
  await new IntegrationCursorStore().ensureDefaults(tx, actor);
  // The definitions of the disbursement figures wait for the signature of the capital business owner (D03): in review, never published here.
  await new GlossaryStore().ensureDisbursementTerms(tx, actor);
  // The early-warning rules of DIS wait as drafts for the finance office (BR-DIS-13): published by someone other than the platform, once the thresholds are signed.
  await new DisWarningStore().ensureSeedRules(tx, actor);
  if (created + superseded > 0) {
    await enqueueOutbox(tx, {
      aggregateType: 'master_baseline',
      aggregateId: randomUUID(),
      aggregateVersion: 1,
      type: BASELINE_EVENT,
      schemaVersion: 1,
      payload: { pack_id: pack.id, sha256: pack.sha256, created, superseded, unchanged },
      eventKey: `master_baseline:${pack.id}:${pack.sha256}`,
      correlationId: randomUUID(),
    });
  }
  return { created, superseded, unchanged };
}
