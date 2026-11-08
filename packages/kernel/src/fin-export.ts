import type { ExportColumn, ExportDocument } from './dis-export.ts';
import type { FinCriteriaResult } from './fin-criteria.ts';
import { FIN_LINE_KINDS, FIN_REASON_TEXT } from './fin-analysis.ts';
import type { FinHeadline, FinMeasure, FinReport } from './fin-analysis.ts';
import { message } from './messages.ts';

/**
 * The file that carries an appraisal out for cross-checking (lane FIN-1, customer requirement KT.02): the inputs with their sources and owners, the formula text of every measure with its assumptions, the
 * table of the cash flow with the discount factor and the present value of every period (so that anyone can redo the sums in a spreadsheet), the scenarios, the sensitivity tables, and the fingerprint of
 * the result. One long table of six columns, so that the CSV and the workbook of `dis-export` carry it unchanged: the `value` column holds numbers only (money, rates, ratios), words go to `note`.
 */

export type FinAppraisalStatusText = 'DRAFT' | 'SUBMITTED' | 'APPROVED';

export interface FinExportAssumption {
  key: string;
  value: string;
  unit: string;
  sourceKind: string;
  source: string;
  owner: string;
}

export interface FinExportInput {
  code: string;
  revision: number;
  title: string;
  status: FinAppraisalStatusText;
  kind: string;
  ownerUnit: string;
  link: string | null;
  currencyUnit: string;
  computedAt: string;
  inputsHash: string;
  resultHash: string;
  formulaVersion: string;
  approvedBy: string | null;
  approvedAt: string | null;
  assumptions: readonly FinExportAssumption[];
  report: FinReport;
  criteria: FinCriteriaResult | null;
}

const COLUMNS: readonly ExportColumn[] = [
  { key: 'section', label: message('fin.export.columns.label.section'), numeric: false },
  { key: 'ref', label: message('fin.export.columns.label.ref'), numeric: false },
  { key: 'label', label: message('fin.export.columns.label'), numeric: false },
  { key: 'value', label: message('fin.export.columns.label.value'), numeric: true },
  { key: 'unit', label: message('fin.export.columns.label.unit'), numeric: false },
  { key: 'note', label: message('fin.export.columns.label.note'), numeric: false },
];

const LINE_LABEL: Readonly<Record<string, string>> = { benefit: message('fin.export.line_label.benefit'), capex: message('fin.export.line_label.capex'), opex: message('fin.export.line_label.opex'), maintenance: message('fin.export.line_label.maintenance'), residual: message('fin.export.line_label.residual') };
const PARAMETER_LABEL: Readonly<Record<string, string>> = {
  discountRatePp: message('fin.export.parameter_label.discount_rate_pp'),
  benefitPct: message('fin.export.parameter_label.benefit_pct'),
  capexPct: message('fin.export.parameter_label.capex_pct'),
  opexPct: message('fin.export.parameter_label.opex_pct'),
  maintenancePct: message('fin.export.parameter_label.maintenance_pct'),
  residualPct: message('fin.export.parameter_label.residual_pct'),
  benefitDelayPeriods: message('fin.export.parameter_label.benefit_delay_periods'),
};
const KIND_LABEL: Readonly<Record<string, string>> = { FINANCIAL: message('fin.export.kind_label.financial'), NON_FINANCIAL: message('fin.export.kind_label.non_financial') };

type Row = [string, string, string, string, string, string];
const num = (value: string | null | undefined): string => (value === null || value === undefined ? '' : value);

function measureRows(measure: FinMeasure<unknown>, ref: string, label: string, value: string, unit: string): Row[] {
  const rows: Row[] = [[message('fin.export.measure_rows.rows'), ref, label, value, unit, measure.status === 'OK' ? measure.formula : message('fin.export.measure_rows.rows_2', { p0: FIN_REASON_TEXT[measure.reason ?? 'NO_SIGN_CHANGE'], formula: measure.formula })]];
  for (const [key, text] of Object.entries(measure.inputs)) rows.push([message('fin.export.measure_rows'), ref, key, '', '', text]);
  for (const assumption of measure.assumptions) rows.push([message('fin.export.measure_rows_2'), ref, assumption.code, '', '', assumption.text]);
  return rows;
}

function headlineRows(section: string, ref: string, label: string, headline: FinHeadline, currency: string): Row[] {
  const reason = (code: string | null): string => (code === null ? '' : FIN_REASON_TEXT[code as keyof typeof FIN_REASON_TEXT]);
  return [
    [section, ref, `${label}: NPV`, num(headline.npv), currency, ''],
    [section, ref, `${label}: IRR`, num(headline.irrPct), '%', reason(headline.irrReason)],
    [section, ref, message('fin.export.headline_rows', { label: label }), num(headline.paybackPeriods), message('fin.export.headline_rows_2'), reason(headline.paybackReason)],
    [section, ref, message('fin.export.headline_rows_3', { label: label }), num(headline.discountedPaybackPeriods), message('fin.export.headline_rows_2'), reason(headline.discountedPaybackReason)],
    [section, ref, message('fin.export.headline_rows_4', { label: label }), num(headline.bcr), message('fin.export.headline_rows_5'), reason(headline.bcrReason)],
    [section, ref, message('fin.export.headline_rows_6', { label: label }), num(headline.tcoPresentValue), currency, ''],
  ];
}

/** The document of an appraisal for the CSV and workbook writers; pure, so the same appraisal makes the same file. */

/** The document of an appraisal for the CSV and workbook writers; pure, so the same appraisal makes the same file. */
export function finExportDocument(input: FinExportInput): ExportDocument {
  const { report } = input;
  const unit = input.currencyUnit;
  const model = report.inputs.model;
  const rows: Row[] = [];
  rows.push([message('fin.export.fin_export_document'), 'discount_rate_pct', message('fin.export.fin_export_document_2'), model.discountRatePct, '%', message('fin.export.fin_export_document_3')]);
  rows.push([message('fin.export.fin_export_document'), 'convention', message('fin.export.fin_export_document_4'), '', '', model.convention === 'END' ? message('fin.export.fin_export_document_5') : message('fin.export.fin_export_document_6')]);
  rows.push([message('fin.export.fin_export_document'), 'period_unit', message('fin.export.fin_export_document_7'), '', '', model.periodUnit]);
  for (const line of model.lines) {
    for (const kind of FIN_LINE_KINDS) {
      const amount = line[kind];
      if (amount !== undefined && amount !== '') rows.push([message('fin.export.fin_export_document_8'), `t=${line.period}`, LINE_LABEL[kind] ?? kind, amount, unit, kind]);
    }
  }
  for (const assumption of input.assumptions) {
    rows.push([message('fin.export.fin_export_document_9'), assumption.key, message('fin.export.fin_export_document_10', { value: assumption.value }), '', assumption.unit, message('fin.export.fin_export_document_11', { sourceKind: assumption.sourceKind, source: assumption.source, owner: assumption.owner })]);
  }
  for (const scenario of report.inputs.scenarios) {
    for (const [key, value] of Object.entries(scenario.deltas)) rows.push([message('fin.export.fin_export_document_12'), scenario.code, `${scenario.label}: ${PARAMETER_LABEL[key] ?? key}`, value ?? '', key === 'benefitDelayPeriods' ? message('fin.export.headline_rows_2') : '%', '']);
  }
  const analysis = report.analysis;
  rows.push(...measureRows(analysis.npv, 'NPV', message('fin.export.fin_export_document_13'), num(analysis.npv.value), unit));
  rows.push(...measureRows(analysis.irr, 'IRR', message('fin.export.fin_export_document_14'), num(analysis.irr.value), '%'));
  rows.push(...measureRows(analysis.payback, 'PAYBACK', message('fin.export.fin_export_document_15'), num(analysis.payback.value), message('fin.export.headline_rows_2')));
  rows.push(...measureRows(analysis.discountedPayback, 'DISCOUNTED_PAYBACK', message('fin.export.fin_export_document_16'), num(analysis.discountedPayback.value), message('fin.export.headline_rows_2')));
  rows.push(...measureRows(analysis.bcr, 'BCR', message('fin.export.fin_export_document_17'), num(analysis.bcr.value), message('fin.export.headline_rows_5')));
  rows.push(...measureRows(analysis.tco, 'TCO', message('fin.export.fin_export_document_18'), num(analysis.tco.value?.presentValueTotal), unit));
  if (analysis.tco.value !== null) {
    const tco = analysis.tco.value;
    rows.push([message('fin.export.fin_export_document_19'), 'TCO', message('fin.export.fin_export_document_20'), tco.nominalTotal, unit, '']);
    rows.push([message('fin.export.fin_export_document_19'), 'TCO', message('fin.export.fin_export_document_21'), num(tco.equivalentPerPeriod), unit, '']);
    rows.push([message('fin.export.fin_export_document_19'), 'TCO', message('fin.export.fin_export_document_22'), num(tco.capexSharePct), '%', '']);
    for (const [kind, figures] of Object.entries(tco.byKind)) {
      rows.push([message('fin.export.fin_export_document_19'), kind, message('fin.export.fin_export_document_23', { p0: LINE_LABEL[kind] ?? kind }), figures.nominal, unit, '']);
      rows.push([message('fin.export.fin_export_document_19'), kind, message('fin.export.fin_export_document_24', { p0: LINE_LABEL[kind] ?? kind }), figures.presentValue, unit, '']);
    }
  }
  for (const row of analysis.table) {
    const ref = `t=${row.period}`;
    rows.push([message('fin.export.fin_export_document_25'), ref, message('fin.export.fin_export_document_26'), row.net, unit, message('fin.export.fin_export_document_27')]);
    rows.push([message('fin.export.fin_export_document_25'), ref, message('fin.export.fin_export_document_28'), num(row.factor), '', '']);
    rows.push([message('fin.export.fin_export_document_25'), ref, message('fin.export.fin_export_document_29'), num(row.presentValue), unit, '']);
    rows.push([message('fin.export.fin_export_document_25'), ref, message('fin.export.fin_export_document_30'), row.cumulativeNet, unit, '']);
    rows.push([message('fin.export.fin_export_document_25'), ref, message('fin.export.fin_export_document_31'), num(row.cumulativePresentValue), unit, '']);
  }
  for (const scenario of report.scenarios) rows.push(...headlineRows(message('fin.export.fin_export_document_32'), scenario.code, scenario.label, scenario.headline, unit));
  for (const table of report.oneWay) {
    for (const point of table.points) rows.push([message('fin.export.fin_export_document_33'), `${table.parameter}=${point.delta}`, PARAMETER_LABEL[table.parameter] ?? table.parameter, num(point.headline.npv), unit, `IRR ${point.headline.irrPct ?? message('fin.export.fin_export_document_34')}`]);
  }
  const two = report.twoWay;
  two.yPoints.forEach((y, row) => two.xPoints.forEach((x, column) => rows.push([message('fin.export.fin_export_document_35'), `${two.x}=${x}; ${two.y}=${y}`, 'NPV', num(two.npv[row]?.[column]), unit, ''])));
  report.tornado.forEach((bar, index) => rows.push(['TORNADO', bar.parameter, message('fin.export.fin_export_document_36', { p0: index + 1, p1: PARAMETER_LABEL[bar.parameter] ?? bar.parameter }), num(bar.swing), unit, message('fin.export.fin_export_document_37', { delta: bar.low.delta, p1: bar.low.npv ?? message('fin.export.fin_export_document_34'), delta2: bar.high.delta, p3: bar.high.npv ?? message('fin.export.fin_export_document_34') })]));
  for (const entry of report.switching) {
    rows.push([message('fin.export.fin_export_document_38'), entry.parameter, PARAMETER_LABEL[entry.parameter] ?? entry.parameter, num(entry.pct), '%', entry.reason === null ? message('fin.export.fin_export_document_39') : FIN_REASON_TEXT[entry.reason]]);
  }
  if (input.criteria !== null) {
    for (const line of input.criteria.lines) rows.push([message('fin.export.fin_export_document_40'), line.key, line.label, String(line.score), message('fin.export.fin_export_document_41'), message('fin.export.fin_export_document_42', { weightPct: line.weightPct, contribution: line.contribution, evidence: line.evidence })]);
    rows.push([message('fin.export.fin_export_document_40'), 'WEIGHTED_SCORE', message('fin.export.fin_export_document_43'), input.criteria.weightedScore, message('fin.export.fin_export_document_41'), input.criteria.formula]);
    rows.push([message('fin.export.fin_export_document_40'), 'INDEX', message('fin.export.fin_export_document_44'), input.criteria.indexPct, '%', input.criteria.formula]);
  }
  const approved = input.status === 'APPROVED';
  return {
    title: message('fin.export.fin_export_document.title'),
    header: [
      { key: 'code', label: message('fin.export.header.label.code'), value: message('fin.export.header.value.code', { code: input.code, revision: input.revision }) },
      { key: 'title', label: message('fin.export.header.label.title'), value: input.title },
      { key: 'kind', label: message('fin.export.header.label.kind'), value: KIND_LABEL[input.kind] ?? input.kind },
      { key: 'status', label: message('fin.export.header.label.status'), value: input.status },
      { key: 'owner_unit', label: message('fin.export.header.label.owner_unit'), value: input.ownerUnit },
      ...(input.link === null ? [] : [{ key: 'link', label: message('fin.export.header.label.link'), value: input.link }]),
      { key: 'currency_unit', label: message('fin.export.columns.label.unit'), value: unit },
      { key: 'computed_at', label: message('fin.export.header.label.computed_at'), value: input.computedAt },
      { key: 'formula_version', label: message('fin.export.header.label.formula_version'), value: input.formulaVersion },
      { key: 'inputs_hash', label: message('fin.export.header.label.inputs_hash'), value: input.inputsHash },
      { key: 'result_hash', label: message('fin.export.header.label.result_hash'), value: input.resultHash },
      ...(approved ? [{ key: 'approved_by', label: message('fin.export.header.label.approved_by'), value: input.approvedBy ?? '' }, { key: 'approved_at', label: message('fin.export.header.label.approved_at'), value: input.approvedAt ?? '' }] : []),
    ],
    columns: COLUMNS,
    rows,
    notice: approved
      ? message('fin.export.fin_export_document.notice', { resultHash: input.resultHash, formulaVersion: input.formulaVersion })
      : message('fin.export.fin_export_document.notice_2'),
  };
}
