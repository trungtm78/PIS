import { COMMITTEE_PERIODIC_NARRATIVE, HPM_MONTHLY_NARRATIVE, INVEST_STEERING_NARRATIVE, PLANT_PHU_MY_NARRATIVE, PVN_MONTHLY_NARRATIVE, PVN_QUARTERLY_NARRATIVE } from './narratives.ts';
import { buildTableForm, formTexts } from './common.ts';
import type { ColumnKey, DemoFormSpec, StripItem } from './common.ts';

/**
 * The six report forms of the first customer, designed by the system for the demo stage (RPT-1, owner decision of 2026-11-08): each is a `ReportLayout` with status DEMO, built from the dossier's description of
 * the five existing reports and the plant report. They carry the demo mark on every output, are issuable only while demo forms are on, and are never accepted as the official form (R18). To replace one by the
 * official template see docs/report-engine.md, "The six PVFCCo forms". The Vietnamese words (titles, group names, labels of the headline strip, notes) are in `messages/forms.vi.json`; the structure of each form
 * (its columns, groups and indicator bindings) is here.
 */

const texts = formTexts();

const group = (dataset: string): { dataset: string; title: string } => ({ dataset, title: texts.groups[dataset] as string });
const DTXDCB = group('dtxdcb');
const MSTB = group('mstb');
const MSTSCD = group('mstscd');
const SCL = group('scl');

const A3 = { paper: 'A3', orientation: 'landscape' } as const;

const strip = (label: string, code: string, basis: StripItem['basis']): StripItem => ({ label: texts.strip[label] as string, code, basis });
const PLAN = strip('planInForce', 'ENT_PLAN_IN_FORCE', 'FULL_YEAR');

const note = (key: string): string => texts.notes[key] as string;
const NOTE_RATE = note('rate');
const NOTE_CAPITAL = note('capital');
const NOTE_SCHEDULE = note('schedule');
const NOTE_DEMO = note('demo');

const titleOf = (code: string): string => texts.titles[code] as string;

const MONEY_AND_RATES: ColumnKey[] = ['tmdt', 'plan_year', 'plan_force'];
const TEXTS: ColumnKey[] = ['status', 'schedule'];

/** The monthly report of the plan for capital construction and the purchase of equipment, sent to the parent group. */
export const PVN_MONTHLY: DemoFormSpec = buildTableForm({
  code: 'PVN-MONTHLY',
  sheetName: 'Bao cao thang',
  title: titleOf('PVN-MONTHLY'),
  formNo: 'PVN-01/THANG',
  period: 'MONTH',
  keys: ['stt', 'code', 'name', 'grp', ...MONEY_AND_RATES, 'exec_p', 'disb_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'disb_start', 'rate_exec', 'rate_disb', 'cap_equity', 'cap_debt', 'cap_other', ...TEXTS, 'issues', 'next', 'proposal'],
  groups: [DTXDCB, MSTB, MSTSCD],
  strip: [
    PLAN,
    strip('executedMonth', 'ENT_EXECUTED_PERIOD', 'IN_PERIOD'),
    strip('disbursedMonth', 'ENT_DISBURSED_PERIOD', 'IN_PERIOD'),
    strip('executedYtd', 'ENT_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('disbursedYtd', 'ENT_DISBURSED_YTD', 'YEAR_TO_DATE'),
    strip('rateDisbursedYtd', 'ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, NOTE_CAPITAL, NOTE_SCHEDULE, NOTE_DEMO],
  narrative: PVN_MONTHLY_NARRATIVE,
  print: A3,
});

/** Form 2: the quarterly report to the parent group, with the estimate of the quarter and of the whole year. */
export const PVN_QUARTERLY_F2: DemoFormSpec = buildTableForm({
  code: 'PVN-QUARTERLY-F2',
  sheetName: 'Bieu 2',
  title: titleOf('PVN-QUARTERLY-F2'),
  formNo: 'PVN-02/QUY',
  period: 'QUARTER',
  keys: ['stt', 'code', 'name', 'grp', ...MONEY_AND_RATES, 'exec_p', 'disb_p', 'est_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'disb_start', 'outlook', 'rate_exec', 'rate_disb', 'rate_outlook', 'cap_equity', 'cap_debt', 'cap_other', ...TEXTS, 'cause', 'issues', 'next', 'proposal'],
  groups: [DTXDCB, MSTB, MSTSCD],
  strip: [
    PLAN,
    strip('executedQuarter', 'ENT_EXECUTED_PERIOD', 'IN_PERIOD'),
    strip('disbursedQuarter', 'ENT_DISBURSED_PERIOD', 'IN_PERIOD'),
    strip('outlookYear', 'ENT_OUTLOOK_YEAR', 'FULL_YEAR'),
    strip('rateOutlookYear', 'ENT_RATE_OUTLOOK_YEAR', 'FULL_YEAR'),
    strip('rateDisbursedYtd', 'ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, note('quarterEstimate'), NOTE_CAPITAL, NOTE_SCHEDULE, NOTE_DEMO],
  print: A3,
  narrative: PVN_QUARTERLY_NARRATIVE,
});

/** The monthly report in the format of the HPM system: one flat list, one line per project or item, with a kind column and one total line. */
export const HPM_MONTHLY: DemoFormSpec = buildTableForm({
  code: 'HPM-MONTHLY',
  sheetName: 'HPM thang',
  title: titleOf('HPM-MONTHLY'),
  formNo: 'HPM-01/THANG',
  period: 'MONTH',
  keys: ['stt', 'code', 'name', 'grp', 'kind', 'tmdt', 'plan_force', 'exec_p', 'disb_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'disb_start', 'rate_exec', 'rate_disb', 'cap_equity', 'cap_debt', 'cap_other', ...TEXTS],
  groups: [group('items')],
  flat: true,
  strip: [
    PLAN,
    strip('executedMonth', 'ENT_EXECUTED_PERIOD', 'IN_PERIOD'),
    strip('disbursedMonth', 'ENT_DISBURSED_PERIOD', 'IN_PERIOD'),
    strip('executedYtd', 'ENT_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('rateExecutedYtd', 'ENT_RATE_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('rateDisbursedYtd', 'ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, note('hpmKind'), NOTE_DEMO],
  narrative: HPM_MONTHLY_NARRATIVE,
  print: A3,
});

/** The periodic report to the committee for investment, development, science and technology of the parent group. */
export const COMMITTEE_PERIODIC: DemoFormSpec = buildTableForm({
  code: 'COMMITTEE-PERIODIC',
  sheetName: 'Bao cao dinh ky',
  title: titleOf('COMMITTEE-PERIODIC'),
  formNo: 'UB-01/QUY',
  period: 'QUARTER',
  keys: ['stt', 'code', 'name', 'grp', 'tmdt', 'plan_force', 'exec_p', 'disb_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'rate_exec', 'rate_disb', 'cap_equity', 'cap_debt', 'cap_other', 'schedule', 'issues', 'proposal'],
  groups: [DTXDCB, MSTB, MSTSCD, SCL],
  strip: [
    PLAN,
    strip('executedYtd', 'ENT_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('disbursedYtd', 'ENT_DISBURSED_YTD', 'YEAR_TO_DATE'),
    strip('executedSinceStart', 'ENT_EXECUTED_SINCE_START', 'AS_OF_END'),
    strip('rateSinceStart', 'ENT_RATE_SINCE_START', 'AS_OF_END'),
    strip('rateExecutedYtd', 'ENT_RATE_EXECUTED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, NOTE_CAPITAL, NOTE_SCHEDULE, NOTE_DEMO],
  print: A3,
  narrative: COMMITTEE_PERIODIC_NARRATIVE,
});

/** The monthly investment steering meeting report: focused on progress, obstacles and requests for direction. */
export const INVEST_STEERING: DemoFormSpec = buildTableForm({
  code: 'INVEST-STEERING',
  sheetName: 'Giao ban',
  title: titleOf('INVEST-STEERING'),
  formNo: 'GB-01/THANG',
  period: 'MONTH',
  keys: ['stt', 'code', 'name', 'grp', 'plan_force', 'exec_ytd', 'disb_ytd', 'rate_exec', 'rate_disb', 'schedule', 'status', 'cause', 'issues', 'next', 'proposal'],
  groups: [DTXDCB, MSTB, MSTSCD, SCL],
  strip: [
    strip('projectsTotal', 'ENT_PROJECTS_TOTAL', 'AS_OF_END'),
    strip('projectsOnTrack', 'ENT_PROJECTS_ON_TRACK', 'AS_OF_END'),
    strip('projectsDelayed', 'ENT_PROJECTS_DELAYED', 'AS_OF_END'),
    PLAN,
    strip('rateExecutedYtd', 'ENT_RATE_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('rateDisbursedYtd', 'ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, NOTE_SCHEDULE, NOTE_DEMO],
  print: A3,
  narrative: INVEST_STEERING_NARRATIVE,
});

/** The report of the Phu My fertiliser plant: capital construction and major repairs. */
export const PLANT_PHU_MY: DemoFormSpec = buildTableForm({
  code: 'PLANT-PHU-MY',
  sheetName: 'Nha may',
  title: titleOf('PLANT-PHU-MY'),
  formNo: 'NM-01/THANG',
  period: 'MONTH',
  keys: ['stt', 'code', 'name', 'grp', 'owner_unit', 'tmdt', 'plan_force', 'exec_p', 'disb_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'disb_start', 'rate_exec', 'rate_disb', 'cap_equity', 'cap_debt', 'cap_other', ...TEXTS, 'cause', 'issues', 'next', 'proposal'],
  groups: [DTXDCB, SCL],
  strip: [
    PLAN,
    strip('executedMonth', 'ENT_EXECUTED_PERIOD', 'IN_PERIOD'),
    strip('disbursedMonth', 'ENT_DISBURSED_PERIOD', 'IN_PERIOD'),
    strip('executedYtd', 'ENT_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('disbursedYtd', 'ENT_DISBURSED_YTD', 'YEAR_TO_DATE'),
    strip('rateDisbursedYtd', 'ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, NOTE_CAPITAL, NOTE_SCHEDULE, NOTE_DEMO],
  print: A3,
  narrative: PLANT_PHU_MY_NARRATIVE,
});

/** The six forms in the order of the catalogue. */
export const DEMO_FORMS: readonly DemoFormSpec[] = Object.freeze([PVN_MONTHLY, PVN_QUARTERLY_F2, HPM_MONTHLY, COMMITTEE_PERIODIC, INVEST_STEERING, PLANT_PHU_MY]);
