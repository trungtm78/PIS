import { COMMITTEE_KPI_DEFAULTS } from './committee-policy.ts';
import type { AggregateRow, AttentionItem, CommitteeWorkspace } from './committee.ts';
import { COMMITTEE_PACK_TEXT as TEXT } from './messages/committee-texts.ts';
import type { LayoutCell, LayoutColumn, LayoutRow, ReportLayout, ReportScalar } from './report-layout.ts';

/**
 * The meeting pack of the committee as a form of the report engine (lane BAN-1, docs/committee-workspace.md): one sheet (and a Word document of the same figures) with the headline figures bound to the KPI register and one
 * block of rows for each of the sections: the province, the sectors, the districts, the investors, the funding sources, the projects that need the head, and the directives that are overdue per unit. The figures are
 * those of the workspace screen (same reader, same rules), so the file and the screen cannot give two numbers for one indicator. The form is the system's own report: READY, no mark, issued by the three people of the engine.
 */
export const COMMITTEE_PACK_CODE = 'BAN-MEETING-PACK';
export const COMMITTEE_PACK_VERSION = '2026.1';
export const COMMITTEE_PACK_FORM_REF = 'spec:BAN ST-BAN-001 meeting pack';
export const COMMITTEE_PACK_SHEET = 'BAN-PACK';

/** The headline indicators of the pack, in the order of the table: the register code and the unit word of the column. */
export const COMMITTEE_PACK_INDICATORS = Object.freeze([
  { code: 'COMMITTEE_PLAN_TOTAL', unit: TEXT.unit_vnd },
  { code: 'COMMITTEE_DISBURSED', unit: TEXT.unit_vnd },
  { code: 'COMMITTEE_DISBURSEMENT_RATE', unit: TEXT.unit_percent },
  { code: 'COMMITTEE_DISBURSED_LAST_YEAR', unit: TEXT.unit_vnd },
  { code: 'COMMITTEE_GAP_VS_CURVE', unit: TEXT.unit_points },
  { code: 'COMMITTEE_OUTLOOK_LOW', unit: TEXT.unit_vnd },
  { code: 'COMMITTEE_OUTLOOK_HIGH', unit: TEXT.unit_vnd },
  { code: 'COMMITTEE_ATTENTION_PROJECTS', unit: TEXT.unit_count },
  { code: 'COMMITTEE_UNITS_NOT_REPORTING', unit: TEXT.unit_count },
  { code: 'COMMITTEE_DIRECTIVES_OVERDUE', unit: TEXT.unit_count },
] as const);

const nameOf = (code: string): string => {
  const name = COMMITTEE_KPI_DEFAULTS[code]?.params.name;
  if (typeof name !== 'string' || name === '') throw new Error(`committee-pack-form: the register has no name for ${code}`);
  return name;
};

const text = (col: number, value: string, extra: Partial<LayoutCell> = {}): LayoutCell => ({ col, binding: { kind: 'TEXT', text: value }, ...extra });
const meta = (col: number, key: string, extra: Partial<LayoutCell> = {}): LayoutCell => ({ col, binding: { kind: 'META', key }, ...extra });
const wide = (cell: LayoutCell): LayoutCell => ({ ...cell, colSpan: 10 });
const field = (col: number, key: string, kind: 'money' | 'percent' | 'text' | 'count'): LayoutCell => ({
  col,
  binding: { kind: 'ROW_FIELD', field: key },
  format: kind === 'money' ? { money: true } : kind === 'percent' ? { kind: 'NUMBER', decimals: 2 } : kind === 'count' ? { kind: 'NUMBER', decimals: 0 } : { kind: 'TEXT' },
});

const COLUMNS: LayoutColumn[] = [
  { col: 1, key: 'no', header: [TEXT.col_no], width: 6 },
  { col: 2, key: 'name', header: [TEXT.col_group], width: 46 },
  { col: 3, key: 'plan', header: [TEXT.col_plan], width: 22 },
  { col: 4, key: 'disbursed', header: [TEXT.col_disbursed], width: 22 },
  { col: 5, key: 'rate', header: [TEXT.col_rate], width: 12 },
  { col: 6, key: 'last_year', header: [TEXT.col_last_year], width: 22 },
  { col: 7, key: 'gap', header: [TEXT.col_gap], width: 14 },
  { col: 8, key: 'outlook_low', header: [TEXT.col_outlook, TEXT.col_low], width: 22 },
  { col: 9, key: 'outlook_high', header: [TEXT.col_outlook, TEXT.col_high], width: 22 },
  { col: 10, key: 'reasons', header: [TEXT.col_reasons], width: 40 },
];

const indicatorRow = (index: number, code: string, unit: string): LayoutRow => ({
  kind: 'NOTE',
  cells: [text(1, String(index + 1)), text(2, nameOf(code)), { col: 3, binding: { kind: 'INDICATOR', code } }, text(4, unit)],
});

const sectionRows = (title: string, dataset: string, kind: 'rows' | 'attention' | 'directives'): LayoutRow[] => {
  const captions =
    kind === 'attention'
      ? [TEXT.col_no, TEXT.col_group, TEXT.col_plan, TEXT.col_disbursed, TEXT.col_rate, TEXT.col_exposure, TEXT.col_score, '', '', TEXT.col_reasons]
      : kind === 'directives'
        ? [TEXT.col_no, TEXT.col_unit, TEXT.col_open, TEXT.col_overdue, TEXT.col_escalated, '', '', '', '', '']
        : [TEXT.col_no, TEXT.col_group, TEXT.col_plan, TEXT.col_disbursed, TEXT.col_rate, TEXT.col_last_year, TEXT.col_gap, TEXT.col_outlook, '', ''];
  const cells: LayoutCell[] =
    kind === 'attention'
      ? [{ col: 1, binding: { kind: 'ROW_NUMBER' } }, field(2, 'name', 'text'), field(3, 'plan', 'money'), field(4, 'disbursed', 'money'), field(5, 'rate', 'percent'), field(6, 'exposure', 'money'), field(7, 'score', 'percent'), field(10, 'reasons', 'text')]
      : kind === 'directives'
        ? [{ col: 1, binding: { kind: 'ROW_NUMBER' } }, field(2, 'name', 'text'), field(3, 'open', 'count'), field(4, 'overdue', 'count'), field(5, 'escalated', 'count')]
        : [
            { col: 1, binding: { kind: 'ROW_NUMBER' } },
            field(2, 'name', 'text'),
            field(3, 'plan', 'money'),
            field(4, 'disbursed', 'money'),
            field(5, 'rate', 'percent'),
            field(6, 'last_year', 'money'),
            field(7, 'gap', 'percent'),
            field(8, 'outlook_low', 'money'),
            field(9, 'outlook_high', 'money'),
          ];
  return [
    { kind: 'NOTE', cells: [wide(text(1, title))] },
    { kind: 'NOTE', cells: captions.flatMap((caption, index) => (caption === '' ? [] : [text(index + 1, caption)])) },
    { kind: 'DATA', dataset, cells },
  ];
};

/** The meeting pack of the committee. */
export const COMMITTEE_PACK_LAYOUT: ReportLayout = Object.freeze({
  code: COMMITTEE_PACK_CODE,
  name: TEXT.name,
  version: COMMITTEE_PACK_VERSION,
  status: 'READY',
  formRef: COMMITTEE_PACK_FORM_REF,
  sheetName: COMMITTEE_PACK_SHEET,
  moneyScale: 'VND',
  headerMode: 'WRITE',
  columns: COLUMNS,
  preface: [
    { kind: 'TITLE', cells: [wide(text(1, TEXT.title))] },
    { kind: 'TITLE', cells: [wide(meta(1, 'ORG_NAME'))] },
    { kind: 'TITLE', cells: [wide(meta(1, 'PERIOD_LABEL'))] },
    { kind: 'TITLE', cells: [wide(meta(1, 'FEED_LINE'))] },
  ],
  body: [
    ...COMMITTEE_PACK_INDICATORS.map((one, index) => indicatorRow(index, one.code, one.unit)),
    ...sectionRows(TEXT.section_province, 'province', 'rows'),
    ...sectionRows(TEXT.section_sector, 'sectors', 'rows'),
    ...sectionRows(TEXT.section_district, 'districts', 'rows'),
    ...sectionRows(TEXT.section_investor, 'investors', 'rows'),
    ...sectionRows(TEXT.section_fund, 'funds', 'rows'),
    ...sectionRows(TEXT.section_attention, 'attention', 'attention'),
    ...sectionRows(TEXT.section_directives, 'directives', 'directives'),
    { kind: 'NOTE', cells: [wide(text(1, TEXT.note))] },
    { kind: 'NOTE', cells: [text(2, TEXT.sign_preparer), text(3, TEXT.sign_checker), text(4, TEXT.sign_approver)] },
  ],
}) as ReportLayout;

const asRecord = (row: AggregateRow, name: string): Record<string, ReportScalar> => ({
  name,
  plan: row.planVnd,
  disbursed: row.disbursedVnd,
  rate: row.ratePct,
  last_year: row.lastYearVnd,
  gap: row.gapPoints,
  outlook_low: row.outlook.lowVnd,
  outlook_high: row.outlook.highVnd,
});

const reasonsOf = (item: AttentionItem): string => item.signals.map((signal) => TEXT[`reason_${signal.reason}` as keyof typeof TEXT] as string).join('; ');

export interface PackDirectiveUnit {
  unitName: string;
  open: number;
  overdue: number;
  escalated: number;
}

/** The datasets of the pack from the workspace and the directive units: the same rows the screen shows, in the same order (unknown values stay null, so the file leaves the cell empty and reports it). */
export function packDatasetsOf(workspace: CommitteeWorkspace, units: readonly PackDirectiveUnit[], attention: readonly AttentionItem[]): Record<string, Array<Record<string, ReportScalar>>> {
  return {
    province: [asRecord(workspace.province, TEXT.section_province)],
    sectors: workspace.bySector.map((row) => asRecord(row, row.label)),
    districts: workspace.byDistrict.map((row) => asRecord(row, row.label)),
    investors: workspace.byInvestor.map((row) => asRecord(row, row.label)),
    funds: workspace.byFundSource.map((row) => asRecord(row, row.label)),
    attention: attention.map((item) => ({ name: `${item.code} - ${item.name}`, plan: item.planVnd, disbursed: item.disbursedVnd, rate: item.ratePct, exposure: item.exposureVnd, score: item.score, reasons: reasonsOf(item) })),
    directives: units.map((unit) => ({ name: unit.unitName, open: unit.open, overdue: unit.overdue, escalated: unit.escalated })),
  };
}

/** The line under the title: where the figures stand (what day, what snapshot); a province with no facts says so. */
export const packFeedLine = (day: string | null, basis: string, reference: string | null): string =>
  day === null ? TEXT.no_facts : `${TEXT.as_of_line.replace('{day}', day.split('-').reverse().join('/'))} ${TEXT.feed_line.replace('{basis}', basis).replace('{reference}', reference ?? '-')}`;
