import { absencePolicyDefaults } from '@machvon/kernel';
import type { OrgPack, PackEntry, PackRole, PackSeat, PackStep, PackUnit } from '@machvon/kernel';
import { textsOf } from '../report-forms/texts.ts';

/**
 * The PVFCCo configuration pack (ENT-3d), as TEMPLATE data. It follows the customer spec HSKT v0.3 (HT.02, HT.03, MD.03, QT.01): seven boards and units and two project teams are the nine input points (each with one person to
 * enter and one to approve), the Board of Planning and Investment (KHDT) aggregates, reviews and closes, the Board of Directors and the Board of Management read, the digital transformation and IT board administers.
 * It is labelled `PVFCCO-TEMPLATE`: illustrative until the customer confirms it. It holds no person, no account and no grant; the names of the two project teams are placeholders until the customer names them.
 * The Vietnamese names are in `messages/org-pack.vi.json` (keyed in English).
 */
export const PVFCCO_PACK_LABEL = 'PVFCCO-TEMPLATE';
export const PVFCCO_DIRECTORY_PREFIX = 'MACHVON-PVFCCO';

interface Texts {
  label: string;
  unit: Record<string, string>;
  role: Record<string, string>;
  step: Record<string, string>;
  entry: Record<string, Record<string, string>>;
}
const texts = (): Texts => textsOf<Texts>('org-pack');

export const ROOT_UNIT = 'PVFCCO';
export const PLANNING_UNIT = 'KHDT';
/** The nine input points of the customer's agreement: seven boards and units and two project teams. */
export const INPUT_POINT_CODES = ['CN_QLPTDA', 'NM_DPM', 'TM', 'KTAT', 'TH', 'TCKT', 'TT_NCUD', 'TDA_1', 'TDA_2'] as const;
export const LEADERSHIP_UNIT_CODES = ['BTGD', 'HDQT'] as const;
export const ADMIN_UNIT = 'CDS_CNTT';
export const PVFCCO_PLACEHOLDER_UNITS: readonly string[] = ['TDA_1', 'TDA_2'];

export const ROLE_ENTRY = 'ENT_DATA_ENTRY';
export const ROLE_APPROVER = 'ENT_UNIT_APPROVER';
export const ROLE_PLANNER = 'ENT_PLANNING_REVIEWER';
export const ROLE_VIEWER = 'ENT_LEADERSHIP_VIEWER';
export const ROLE_ADMIN = 'ENT_EDITION_ADMIN';

/** What a person who enters can do: prepare the figures of the unit, import the indicator file, write and hand in the report of the unit, hand the work over (HT.03). Nothing that decides. */
const ENTRY_PERMISSIONS: readonly string[] = [
  'ind.entry',
  'ind.import',
  'ind.import.preview',
  'ind.read',
  'funding.figure.prepare',
  'funding.read',
  'report.create',
  'report.edit',
  'report.import',
  'report.submit',
  'report.withdraw',
  'report.read',
  'project.read',
  'home.read',
  'iam.delegation.create',
  'iam.delegation.read',
  'iam.acting.request',
];
/** What the approver of the unit can do: decide on what the unit entered, read it, hand the approval over (HT.03). Not enter, not close the period, not push. */
const APPROVER_PERMISSIONS: readonly string[] = [
  'approval.decide',
  'approval_task.read',
  'workflow_instance.read',
  'report.review',
  'report.read',
  'report_revision.read',
  'funding.figure.accept',
  'funding.read',
  'ind.read',
  'project.read',
  'home.read',
  'iam.delegation.create',
  'iam.delegation.read',
  'iam.acting.request',
];
/** What the planning reviewer can do: the approver's decisions across the tenant, close and reopen the period, push to HPM and record the receipt, reconcile with EBS, work the report engine. Not enter. */
const PLANNER_PERMISSIONS: readonly string[] = [
  ...APPROVER_PERMISSIONS.filter((name) => !name.startsWith('iam.delegation.create') && name !== 'iam.acting.request'),
  'period.manage',
  'period.lock',
  'period.reopen.approve',
  'hpm.read',
  'hpm.push',
  'hpm.receipt',
  'ebs.read',
  'ebs.reconcile',
  'rpt.read',
  'rpt.generate',
  'rpt.check',
  'directive.read',
  'directive.manage',
  'capital.read',
  'master.read',
  'reporting_period.read',
];
/** What leadership can do: read and ask. */
const VIEWER_PERMISSIONS: readonly string[] = [
  'home.read',
  'report.read',
  'report_revision.read',
  'rpt.read',
  'directive.read',
  'bi.query',
  'capital.read',
  'funding.read',
  'ind.read',
  'project.read',
  'hpm.read',
  'ebs.read',
  'reporting_period.read',
];
/** What the administrators can do: people, roles, units, the loader of this pack and its approval, rules, the matrix of authority, the calendar, the connections, the shared catalogues. Not decide on data. */
const ADMIN_PERMISSIONS: readonly string[] = [
  'iam.member.invite',
  'iam.member.manage',
  'iam.role.grant',
  'iam.role.manage',
  'iam.unit.manage',
  'iam.delegation.read',
  'adm.migration.read',
  'adm.migration.manage',
  'adm.migration.approve',
  'adm.governance.read',
  'adm.governance.manage',
  'adm.governance.approve',
  'adm.workflow.manage',
  'adm.workflow.publish',
  'adm.doa.read',
  'adm.doa.manage',
  'adm.doa.approve',
  'adm.calendar.read',
  'adm.calendar.manage',
  'adm.integration.read',
  'adm.integration.manage',
  'adm.security.read',
  'master.read',
  'master.propose',
  'master.review',
  'master.publish',
  'ebs.admin',
  'hpm.admin',
  'home.read',
];

function units(): PackUnit[] {
  const names = texts().unit;
  const name = (code: string): string => names[code] ?? code;
  const point = (code: string): PackUnit => ({ code, name: name(code), parentCode: ROOT_UNIT, function: 'INPUT_POINT', placeholder: PVFCCO_PLACEHOLDER_UNITS.includes(code) });
  return [
    { code: ROOT_UNIT, name: name(ROOT_UNIT), parentCode: null, function: 'ROOT', placeholder: false },
    { code: PLANNING_UNIT, name: name(PLANNING_UNIT), parentCode: ROOT_UNIT, function: 'AGGREGATOR', placeholder: false },
    ...INPUT_POINT_CODES.map(point),
    ...LEADERSHIP_UNIT_CODES.map((code): PackUnit => ({ code, name: name(code), parentCode: ROOT_UNIT, function: 'LEADERSHIP', placeholder: false })),
    { code: ADMIN_UNIT, name: name(ADMIN_UNIT), parentCode: ROOT_UNIT, function: 'ADMINISTRATION', placeholder: false },
  ];
}

function roles(): PackRole[] {
  const names = texts().role;
  const role = (code: string, kind: PackRole['kind'], rank: number, permissions: readonly string[]): PackRole => ({ code, name: names[code] ?? code, kind, rank, permissions });
  return [
    role(ROLE_ENTRY, 'ENTRY', 30, ENTRY_PERMISSIONS),
    role(ROLE_APPROVER, 'UNIT_APPROVER', 45, APPROVER_PERMISSIONS),
    role(ROLE_PLANNER, 'PLANNING_REVIEWER', 55, PLANNER_PERMISSIONS),
    role(ROLE_VIEWER, 'LEADERSHIP_VIEWER', 35, VIEWER_PERMISSIONS),
    role(ROLE_ADMIN, 'ADMINISTRATOR', 85, ADMIN_PERMISSIONS),
  ];
}

const seat = (roleCode: string, unitCode: string, scope: PackSeat['scope'], minHolders = 1, maxHolders = 1): PackSeat => ({ roleCode, unitCode, scope, minHolders, maxHolders });

function seats(): PackSeat[] {
  return [
    // Each input point: one person to enter, one to approve; both for the unit alone (HT.02: a unit sees and enters the projects it is responsible for).
    ...INPUT_POINT_CODES.flatMap((code) => [seat(ROLE_ENTRY, code, 'UNIT_ONLY'), seat(ROLE_APPROVER, code, 'UNIT_ONLY')]),
    // Planning reviews and closes over the whole tenant, with at least two people so that review, close and push are not one person's.
    seat(ROLE_PLANNER, PLANNING_UNIT, 'TENANT', 2, 4),
    // Leadership reads everything.
    ...LEADERSHIP_UNIT_CODES.map((code) => seat(ROLE_VIEWER, code, 'TENANT', 1, 10)),
    // Administration: two at least, because the loader of the pack is applied by somebody other than who registered it.
    seat(ROLE_ADMIN, ADMIN_UNIT, 'TENANT', 2, 4),
  ];
}

/** The chain of QT.01 (minutes 43/BBH-KHDT): the approver at the input point, KHDT checks, the period is closed, the figures go to HPM; each with a deadline in working hours (8 a day). */
function steps(): PackStep[] {
  const names = texts().step;
  const planning = (id: string, kind: PackStep['kind'], slaWorkingHours: number): PackStep => ({
    id,
    kind,
    name: names[id] ?? id,
    assignee: 'ROLE_IN_UNIT',
    roleCode: ROLE_PLANNER,
    unitCode: PLANNING_UNIT,
    slaWorkingHours,
    onTimeout: 'REMIND',
  });
  return [
    { id: 'unit-approver', kind: 'UNIT_APPROVER', name: names['unit-approver'] ?? 'unit-approver', assignee: 'DOA', slaWorkingHours: 24, onTimeout: 'REMIND' },
    planning('planning-review', 'PLANNING_REVIEW', 24),
    planning('period-close', 'PERIOD_CLOSE', 8),
    planning('push', 'PUSH', 8),
  ];
}

function entries(): PackEntry[] {
  const names = texts().entry;
  const label = (type: string, key: string): string => names[type]?.[key] ?? key;
  const entry = (masterType: string, key: string, attributes: Record<string, unknown>, parentKey: string | null = null): PackEntry => ({ masterType, key, label: label(masterType, key), parentKey, attributes });
  const period = (key: string, grain: string, months: number, days: number): PackEntry => entry('REPORTING_PERIOD_KIND', key, { grain, months, entry_deadline_working_days: days });
  const reportType = (key: string, periodKind: string, audience: string, formCode?: string): PackEntry =>
    entry('REPORT_TYPE', key, { period_kind_key: periodKind, audience, ...(formCode === undefined ? {} : { form_code: formCode }) });
  const agency = (key: string, kind: string, channel: string, reportTypes: string[]): PackEntry => entry('RECEIVING_AGENCY', key, { agency_kind: kind, report_type_keys: reportTypes, channel });
  const source = (key: string, repayable: boolean): PackEntry => entry('CAPITAL_SOURCE', key, { fnd_class_code: key, repayable });
  const unit = (key: string, kind: string, factor: string, scale: number): PackEntry =>
    entry('REPORT_UNIT', key, { kind, symbol: names.REPORT_UNIT_SYMBOL?.[key] ?? key, factor, scale, rounding: 'HALF_UP' });
  const cause = (key: string, handler: string): PackEntry => entry('ISSUE_CATEGORY', key, { handler_unit_key: handler }, 'DELAY_CAUSE');
  return [
    period('MONTH', 'MONTH', 1, 5),
    period('QUARTER', 'QUARTER', 3, 7),
    period('YEAR', 'YEAR', 12, 10),
    period('MEETING', 'MEETING', 0, 2),
    reportType('PVN_MONTHLY', 'MONTH', 'PARENT_GROUP', 'PVN-MONTHLY'),
    reportType('PVN_QUARTERLY', 'QUARTER', 'PARENT_GROUP', 'PVN-QUARTERLY-F2'),
    reportType('HPM_MONTHLY', 'MONTH', 'PARENT_GROUP', 'HPM-MONTHLY'),
    reportType('COMMITTEE_PERIODIC', 'QUARTER', 'EXTERNAL_AGENCY', 'COMMITTEE-PERIODIC'),
    // The form for departments waits for the customer's sample (ENT-4b); the type exists so the agency can be named.
    reportType('DEPARTMENT_PERIODIC', 'YEAR', 'EXTERNAL_AGENCY'),
    reportType('INVEST_STEERING', 'MEETING', 'INTERNAL', 'INVEST-STEERING'),
    reportType('PLANT_PHU_MY', 'MONTH', 'INTERNAL', 'PLANT-PHU-MY'),
    agency('PVN', 'PARENT_GROUP', 'FILE', ['PVN_MONTHLY', 'PVN_QUARTERLY']),
    agency('HPM', 'PARENT_GROUP', 'HPM', ['HPM_MONTHLY']),
    agency('UB_DTPT_KHCN', 'COMMITTEE', 'FILE', ['COMMITTEE_PERIODIC']),
    agency('SO_BAN_NGANH', 'DEPARTMENT', 'EMAIL', ['DEPARTMENT_PERIODIC']),
    agency('GIAO_BAN', 'INTERNAL_MEETING', 'MEETING', ['INVEST_STEERING', 'PLANT_PHU_MY']),
    source('EQUITY', false),
    source('LOAN', true),
    source('OTHER', false),
    unit('VND', 'MONEY', '1', 0),
    unit('MILLION_VND', 'MONEY', '1000000', 1),
    unit('BILLION_VND', 'MONEY', '1000000000', 2),
    unit('PERCENT', 'RATIO', '1', 2),
    unit('PROJECT', 'COUNT', '1', 0),
    unit('ITEM', 'COUNT', '1', 0),
    unit('HECTARE', 'AREA', '10000', 2),
    entry('ISSUE_CATEGORY', 'DELAY_CAUSE', { handler_unit_key: PLANNING_UNIT }),
    cause('DC_SITE_CLEARANCE', 'CN_QLPTDA'),
    cause('DC_PROCEDURES', PLANNING_UNIT),
    cause('DC_FUNDING', 'TCKT'),
    cause('DC_DESIGN_CHANGE', 'KTAT'),
    cause('DC_PROCUREMENT', 'TM'),
    cause('DC_CONTRACTOR', 'CN_QLPTDA'),
    cause('DC_EQUIPMENT_SUPPLY', 'TM'),
    cause('DC_WEATHER', 'KTAT'),
    cause('DC_FORCE_MAJEURE', PLANNING_UNIT),
    cause('DC_OTHER', PLANNING_UNIT),
  ];
}

/** The template pack. A new object on each call, so that nobody changes the template by changing what this returns. */
export function pvfccoTemplatePack(): OrgPack {
  return {
    label: PVFCCO_PACK_LABEL,
    directoryPrefix: PVFCCO_DIRECTORY_PREFIX,
    units: units(),
    roles: roles(),
    seats: seats(),
    steps: steps(),
    // HT.03: entry and approval can be handed over for a time (at most 90 days) or, on a change of staff, permanently with a review at least twice a year.
    delegation: { delegableRoles: [ROLE_ENTRY, ROLE_APPROVER], maxDays: 90, standingReviewDays: 180 },
    // Each seat has one holder by the agreement, so a position needs only that one, and approvers (rank 45) and reviewers count as positions that must be covered.
    absence: { ...absencePolicyDefaults(), min_role_holders: 1, position_min_rank: 40 },
    doa: { documentType: 'REPORT_ACCEPT', unitCode: ROOT_UNIT, roleCode: ROLE_APPROVER, approvalLevels: 1 },
    entries: entries(),
  };
}
