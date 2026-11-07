import type { ExportColumn, ExportDocument } from './dis-export.ts';
import type { FinCriteriaResult } from './fin-criteria.ts';
import { FIN_LINE_KINDS, FIN_REASON_TEXT } from './fin-analysis.ts';
import type { FinHeadline, FinMeasure, FinReport } from './fin-analysis.ts';

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
  { key: 'section', label: 'Phần', numeric: false },
  { key: 'ref', label: 'Mã', numeric: false },
  { key: 'label', label: 'Nội dung', numeric: false },
  { key: 'value', label: 'Giá trị', numeric: true },
  { key: 'unit', label: 'ĐVT', numeric: false },
  { key: 'note', label: 'Ghi chú, nguồn, công thức', numeric: false },
];

const LINE_LABEL: Readonly<Record<string, string>> = { benefit: 'Lợi ích', capex: 'Vốn đầu tư', opex: 'Vận hành', maintenance: 'Bảo trì', residual: 'Giá trị thu hồi' };
const PARAMETER_LABEL: Readonly<Record<string, string>> = {
  discountRatePp: 'Tỷ lệ chiết khấu (điểm %)',
  benefitPct: 'Lợi ích (%)',
  capexPct: 'Vốn đầu tư (%)',
  opexPct: 'Vận hành (%)',
  maintenancePct: 'Bảo trì (%)',
  residualPct: 'Giá trị thu hồi (%)',
  benefitDelayPeriods: 'Chậm lợi ích (kỳ)',
};
const KIND_LABEL: Readonly<Record<string, string>> = { FINANCIAL: 'Hiệu quả tài chính', NON_FINANCIAL: 'Lợi ích phi tài chính (an toàn, tuân thủ, bảo trì)' };

type Row = [string, string, string, string, string, string];
const num = (value: string | null | undefined): string => (value === null || value === undefined ? '' : value);

function measureRows(measure: FinMeasure<unknown>, ref: string, label: string, value: string, unit: string): Row[] {
  const rows: Row[] = [['KẾT QUẢ', ref, label, value, unit, measure.status === 'OK' ? measure.formula : `${FIN_REASON_TEXT[measure.reason ?? 'NO_SIGN_CHANGE']} Công thức: ${measure.formula}`]];
  for (const [key, text] of Object.entries(measure.inputs)) rows.push(['ĐẦU VÀO CỦA KẾT QUẢ', ref, key, '', '', text]);
  for (const assumption of measure.assumptions) rows.push(['GIẢ ĐỊNH CỦA CÔNG THỨC', ref, assumption.code, '', '', assumption.text]);
  return rows;
}

function headlineRows(section: string, ref: string, label: string, headline: FinHeadline, currency: string): Row[] {
  const reason = (code: string | null): string => (code === null ? '' : FIN_REASON_TEXT[code as keyof typeof FIN_REASON_TEXT]);
  return [
    [section, ref, `${label}: NPV`, num(headline.npv), currency, ''],
    [section, ref, `${label}: IRR`, num(headline.irrPct), '%', reason(headline.irrReason)],
    [section, ref, `${label}: hoàn vốn`, num(headline.paybackPeriods), 'kỳ', reason(headline.paybackReason)],
    [section, ref, `${label}: hoàn vốn có chiết khấu`, num(headline.discountedPaybackPeriods), 'kỳ', reason(headline.discountedPaybackReason)],
    [section, ref, `${label}: lợi ích / chi phí`, num(headline.bcr), 'lần', reason(headline.bcrReason)],
    [section, ref, `${label}: PV tổng chi phí sở hữu`, num(headline.tcoPresentValue), currency, ''],
  ];
}

/** The document of an appraisal for the CSV and workbook writers; pure, so the same appraisal makes the same file. */
export function finExportDocument(input: FinExportInput): ExportDocument {
  const { report } = input;
  const unit = input.currencyUnit;
  const model = report.inputs.model;
  const rows: Row[] = [];
  rows.push(['THAM SỐ', 'discount_rate_pct', 'Tỷ lệ chiết khấu mỗi kỳ', model.discountRatePct, '%', 'Không đổi trong suốt thời gian phân tích']);
  rows.push(['THAM SỐ', 'convention', 'Quy ước thời điểm dòng tiền', '', '', model.convention === 'END' ? 'Cuối kỳ' : 'Giữa kỳ']);
  rows.push(['THAM SỐ', 'period_unit', 'Đơn vị của kỳ', '', '', model.periodUnit]);
  for (const line of model.lines) {
    for (const kind of FIN_LINE_KINDS) {
      const amount = line[kind];
      if (amount !== undefined && amount !== '') rows.push(['DÒNG TIỀN NHẬP', `t=${line.period}`, LINE_LABEL[kind] ?? kind, amount, unit, kind]);
    }
  }
  for (const assumption of input.assumptions) {
    rows.push(['GIẢ ĐỊNH ĐẦU VÀO', assumption.key, `Giá trị: ${assumption.value}`, '', assumption.unit, `Nguồn (${assumption.sourceKind}): ${assumption.source}; người chịu trách nhiệm: ${assumption.owner}`]);
  }
  for (const scenario of report.inputs.scenarios) {
    for (const [key, value] of Object.entries(scenario.deltas)) rows.push(['KỊCH BẢN', scenario.code, `${scenario.label}: ${PARAMETER_LABEL[key] ?? key}`, value ?? '', key === 'benefitDelayPeriods' ? 'kỳ' : '%', '']);
  }
  const analysis = report.analysis;
  rows.push(...measureRows(analysis.npv, 'NPV', 'Giá trị hiện tại ròng', num(analysis.npv.value), unit));
  rows.push(...measureRows(analysis.irr, 'IRR', 'Tỷ suất nội hoàn', num(analysis.irr.value), '%'));
  rows.push(...measureRows(analysis.payback, 'PAYBACK', 'Thời gian hoàn vốn', num(analysis.payback.value), 'kỳ'));
  rows.push(...measureRows(analysis.discountedPayback, 'DISCOUNTED_PAYBACK', 'Thời gian hoàn vốn có chiết khấu', num(analysis.discountedPayback.value), 'kỳ'));
  rows.push(...measureRows(analysis.bcr, 'BCR', 'Tỷ số lợi ích trên chi phí', num(analysis.bcr.value), 'lần'));
  rows.push(...measureRows(analysis.tco, 'TCO', 'Tổng chi phí sở hữu (giá trị hiện tại)', num(analysis.tco.value?.presentValueTotal), unit));
  if (analysis.tco.value !== null) {
    const tco = analysis.tco.value;
    rows.push(['TỔNG CHI PHÍ SỞ HỮU', 'TCO', 'Tổng danh nghĩa', tco.nominalTotal, unit, '']);
    rows.push(['TỔNG CHI PHÍ SỞ HỮU', 'TCO', 'Chi phí bình quân hằng kỳ', num(tco.equivalentPerPeriod), unit, '']);
    rows.push(['TỔNG CHI PHÍ SỞ HỮU', 'TCO', 'Tỷ trọng vốn đầu tư', num(tco.capexSharePct), '%', '']);
    for (const [kind, figures] of Object.entries(tco.byKind)) {
      rows.push(['TỔNG CHI PHÍ SỞ HỮU', kind, `${LINE_LABEL[kind] ?? kind}: danh nghĩa`, figures.nominal, unit, '']);
      rows.push(['TỔNG CHI PHÍ SỞ HỮU', kind, `${LINE_LABEL[kind] ?? kind}: giá trị hiện tại`, figures.presentValue, unit, '']);
    }
  }
  for (const row of analysis.table) {
    const ref = `t=${row.period}`;
    rows.push(['BẢNG DÒNG TIỀN', ref, 'Dòng tiền ròng', row.net, unit, 'lợi ích + giá trị thu hồi - vốn đầu tư - vận hành - bảo trì']);
    rows.push(['BẢNG DÒNG TIỀN', ref, 'Hệ số chiết khấu', num(row.factor), '', '']);
    rows.push(['BẢNG DÒNG TIỀN', ref, 'Giá trị hiện tại', num(row.presentValue), unit, '']);
    rows.push(['BẢNG DÒNG TIỀN', ref, 'Lũy kế dòng tiền ròng', row.cumulativeNet, unit, '']);
    rows.push(['BẢNG DÒNG TIỀN', ref, 'Lũy kế giá trị hiện tại', num(row.cumulativePresentValue), unit, '']);
  }
  for (const scenario of report.scenarios) rows.push(...headlineRows('KỊCH BẢN: KẾT QUẢ', scenario.code, scenario.label, scenario.headline, unit));
  for (const table of report.oneWay) {
    for (const point of table.points) rows.push(['ĐỘ NHẠY MỘT CHIỀU', `${table.parameter}=${point.delta}`, PARAMETER_LABEL[table.parameter] ?? table.parameter, num(point.headline.npv), unit, `IRR ${point.headline.irrPct ?? 'không áp dụng'}`]);
  }
  const two = report.twoWay;
  two.yPoints.forEach((y, row) => two.xPoints.forEach((x, column) => rows.push(['ĐỘ NHẠY HAI CHIỀU', `${two.x}=${x}; ${two.y}=${y}`, 'NPV', num(two.npv[row]?.[column]), unit, ''])));
  report.tornado.forEach((bar, index) => rows.push(['TORNADO', bar.parameter, `Thứ ${index + 1}: ${PARAMETER_LABEL[bar.parameter] ?? bar.parameter}`, num(bar.swing), unit, `NPV ở ${bar.low.delta}: ${bar.low.npv ?? 'không áp dụng'}; NPV ở ${bar.high.delta}: ${bar.high.npv ?? 'không áp dụng'}`]));
  for (const entry of report.switching) {
    rows.push(['GIÁ TRỊ CHUYỂN ĐỔI', entry.parameter, PARAMETER_LABEL[entry.parameter] ?? entry.parameter, num(entry.pct), '%', entry.reason === null ? 'Mức thay đổi làm NPV bằng 0, các yếu tố khác giữ nguyên' : FIN_REASON_TEXT[entry.reason]]);
  }
  if (input.criteria !== null) {
    for (const line of input.criteria.lines) rows.push(['TIÊU CHÍ PHI TÀI CHÍNH', line.key, line.label, String(line.score), 'điểm', `Trọng số ${line.weightPct}%; đóng góp ${line.contribution}; bằng chứng: ${line.evidence}`]);
    rows.push(['TIÊU CHÍ PHI TÀI CHÍNH', 'WEIGHTED_SCORE', 'Điểm có trọng số (1 đến 5)', input.criteria.weightedScore, 'điểm', input.criteria.formula]);
    rows.push(['TIÊU CHÍ PHI TÀI CHÍNH', 'INDEX', 'Chỉ số so với mức tối đa', input.criteria.indexPct, '%', input.criteria.formula]);
  }
  const approved = input.status === 'APPROVED';
  return {
    title: 'Thẩm định hiệu quả đầu tư: công thức và dữ liệu để kiểm tra chéo',
    header: [
      { key: 'code', label: 'Mã hồ sơ', value: `${input.code} (phiên bản ${input.revision})` },
      { key: 'title', label: 'Tên hồ sơ', value: input.title },
      { key: 'kind', label: 'Loại', value: KIND_LABEL[input.kind] ?? input.kind },
      { key: 'status', label: 'Trạng thái', value: input.status },
      { key: 'owner_unit', label: 'Đơn vị', value: input.ownerUnit },
      ...(input.link === null ? [] : [{ key: 'link', label: 'Gắn với', value: input.link }]),
      { key: 'currency_unit', label: 'ĐVT', value: unit },
      { key: 'computed_at', label: 'Tính lúc', value: input.computedAt },
      { key: 'formula_version', label: 'Phiên bản công thức', value: input.formulaVersion },
      { key: 'inputs_hash', label: 'Mã băm đầu vào', value: input.inputsHash },
      { key: 'result_hash', label: 'Mã băm kết quả', value: input.resultHash },
      ...(approved ? [{ key: 'approved_by', label: 'Người duyệt', value: input.approvedBy ?? '' }, { key: 'approved_at', label: 'Duyệt lúc', value: input.approvedAt ?? '' }] : []),
    ],
    columns: COLUMNS,
    rows,
    notice: approved
      ? `Kết quả đã đóng băng khi duyệt (mã băm ${input.resultHash}); tính lại từ cùng đầu vào bằng phiên bản công thức ${input.formulaVersion} phải cho cùng mã băm.`
      : 'Bản nháp: hồ sơ chưa được duyệt, kết quả có thể thay đổi và không dùng làm căn cứ quyết định.',
  };
}
