import { KPI_HOME_DEFAULTS } from './analytics-rule-defaults.ts';
import { PUBLIC_REPORT_TEXT as TEXT } from './messages/report-public-texts.ts';
import type { LayoutCell, LayoutColumn, LayoutRow, ReportLayout } from './report-layout.ts';

/**
 * The generic forms of the public edition (RPT-1 part 2). They are the system's own reports, not forms a receiver prescribed, so they are READY (they match what the system itself defines, which a receiver has not
 * changed); `formRef` names the module that specifies them. The enterprise edition adds its six PVFCCo forms through the server seam of its package, never here (`npm run edition:check`).
 *
 * `DIS-WEEKLY` is the weekly disbursement report: the figures of the command center (the rates against the plan, the amount the Treasury paid, the two plans) and the three counts of early warnings, explanations and
 * reallocations, each bound to its code in the KPI register, so the table and the screen of the leader can never give two numbers for one indicator. The period is the AS_OF kind: the cut-off day is the last day of the week.
 */
export const DIS_WEEKLY_CODE = 'DIS-WEEKLY';
export const DIS_WEEKLY_VERSION = '2026.1';
export const DIS_WEEKLY_FORM_REF = 'spec:DIS ST-DIS-007 weekly report';
export const DIS_WEEKLY_SHEET = 'DIS-WEEKLY';

/** The indicators of the weekly report, in the order of the table: the register code and the unit word the column prints. */
export const DIS_WEEKLY_INDICATORS = Object.freeze([
  { code: 'DISBURSEMENT_RATE_PM', unit: TEXT.unit_percent },
  { code: 'DISBURSEMENT_RATE_TOTAL', unit: TEXT.unit_percent },
  { code: 'DISBURSED_TREASURY', unit: TEXT.unit_vnd },
  { code: 'PLAN_PM_ASSIGNED', unit: TEXT.unit_vnd },
  { code: 'PLAN_TOTAL', unit: TEXT.unit_vnd },
  { code: 'OPEN_WARNINGS', unit: TEXT.unit_count },
  { code: 'OVERDUE_EXPLANATIONS', unit: TEXT.unit_count },
  { code: 'PENDING_REALLOCATIONS', unit: TEXT.unit_count },
] as const);

const nameOf = (code: string): string => {
  const name = KPI_HOME_DEFAULTS[code]?.params.name;
  if (typeof name !== 'string' || name === '') throw new Error(`report-public-forms: the register has no name for ${code}`);
  return name;
};

const text = (col: number, value: string, extra: Partial<LayoutCell> = {}): LayoutCell => ({ col, binding: { kind: 'TEXT', text: value }, ...extra });
const meta = (col: number, key: string, extra: Partial<LayoutCell> = {}): LayoutCell => ({ col, binding: { kind: 'META', key }, ...extra });
const wide = (cell: LayoutCell): LayoutCell => ({ ...cell, colSpan: 4 });

const COLUMNS: LayoutColumn[] = [
  { col: 1, key: 'no', header: [TEXT.col_no], width: 6 },
  { col: 2, key: 'indicator', header: [TEXT.col_indicator], width: 52 },
  { col: 3, key: 'value', header: [TEXT.col_value], width: 24 },
  { col: 4, key: 'unit', header: [TEXT.col_unit], width: 16 },
];

const indicatorRow = (index: number, code: string, unit: string): LayoutRow => ({
  kind: 'NOTE',
  cells: [text(1, String(index + 1)), text(2, nameOf(code)), { col: 3, binding: { kind: 'INDICATOR', code } }, text(4, unit)],
});

/** The weekly report of the public edition. */
export const DIS_WEEKLY_LAYOUT: ReportLayout = Object.freeze({
  code: DIS_WEEKLY_CODE,
  name: TEXT.weekly_name,
  version: DIS_WEEKLY_VERSION,
  status: 'READY',
  formRef: DIS_WEEKLY_FORM_REF,
  sheetName: DIS_WEEKLY_SHEET,
  moneyScale: 'VND',
  headerMode: 'WRITE',
  columns: COLUMNS,
  preface: [
    { kind: 'TITLE', cells: [wide(text(1, TEXT.weekly_title))] },
    { kind: 'TITLE', cells: [wide(meta(1, 'ORG_NAME'))] },
    { kind: 'TITLE', cells: [wide(meta(1, 'PERIOD_LABEL'))] },
    { kind: 'TITLE', cells: [wide(meta(1, 'SNAPSHOT_LINE'))] },
  ],
  body: [
    ...DIS_WEEKLY_INDICATORS.map((one, index) => indicatorRow(index, one.code, one.unit)),
    { kind: 'NOTE', cells: [wide(text(1, TEXT.weekly_note))] },
    { kind: 'NOTE', cells: [text(2, TEXT.sign_preparer), text(3, TEXT.sign_checker), text(4, TEXT.sign_approver)] },
  ],
}) as ReportLayout;

/** The words the weekly report needs outside the layout: the snapshot line (with its day), what is printed when there is no snapshot, and the fallback name of the organisation. */
export const weeklySnapshotLine = (day: string | null): string => (day === null ? TEXT.weekly_snapshot_missing : TEXT.weekly_snapshot_line.replace('{day}', day.split('-').reverse().join('/')));
export const WEEKLY_ORG_FALLBACK = TEXT.org_fallback;
