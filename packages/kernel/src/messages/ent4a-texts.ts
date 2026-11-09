/**
 * The Vietnamese words of the cross-report comparison (lane ENT-4a, CN.04): a module (not the JSON catalogue) because the pure rules of the lane also run in the browser, where the catalogue cannot be read.
 * `{name}` places are filled by `fillCrosscheckText`.
 */
export const ENT4A_TEXT = {
  type_formula:
    'Hai hay nhiều báo cáo cùng kỳ của cùng một tổ chức phải cho cùng một số: ba tháng cộng lại bằng quý (số phát sinh) và tháng cuối bằng quý (số lũy kế), số của báo cáo bằng số của bản chốt kỳ đọc qua bộ đọc duy nhất, số của HPM bằng số của PVN cho cùng chỉ tiêu, lũy kế từ đầu dự án không vượt tổng mức đầu tư, tổng các dòng theo đơn vị bằng số toàn công ty và tỷ lệ bằng tử số trên mẫu số. Sai lệch được so bằng số nguyên đồng với dung sai làm tròn theo đơn vị tiền của báo cáo (nửa đơn vị cho mỗi số hạng) cộng dung sai tuyệt đối; tỷ lệ so theo điểm phần trăm. Lệch quá dung sai ở mức CHẶN thì không cho phát hành khi chưa có giải trình của người khác người lập.',
  type_source:
    'Yêu cầu CN.04 của hồ sơ kỹ thuật PVFCCo (so sánh chéo cùng kỳ giữa báo cáo tháng, quý, giao ban và HPM trước khi phát hành); bộ đọc số liệu duy nhất EnterpriseFigureReader (ENT-3a, R21); các dung sai và mức chặn là giá trị khởi đầu chưa được chủ nghiệp vụ xác nhận (D03)',
  rule_01_name: 'Ba tháng bằng quý',
  rule_01_formula: 'Số phát sinh của quý {code} = tổng số của {months} tháng trong kỳ; số lũy kế hoặc số tại thời điểm của quý {code} = số của tháng cuối quý.',
  rule_02_name: 'Báo cáo bằng bản chốt kỳ',
  rule_02_formula: 'Số {code} của báo cáo {role} = số {code} của bản chốt kỳ (snapshot) cùng kỳ, đọc qua bộ đọc duy nhất.',
  rule_03_name: 'Cùng chỉ tiêu, cùng số',
  rule_03_formula: 'Số {code} của báo cáo {left} = số {code} của báo cáo {right} cho cùng kỳ.',
  rule_04_name: 'Lũy kế không vượt tổng mức đầu tư',
  rule_04_formula: 'Số lũy kế từ đầu dự án {code} <= tổng mức đầu tư {total}, ở số toàn công ty và ở từng dự án.',
  rule_05_name: 'Tổng theo đơn vị bằng số toàn công ty',
  rule_05_formula: 'Số {code} toàn công ty = tổng số {code} của các dòng dự án, cộng theo từng đơn vị; dòng chưa có đơn vị không vào được tổng nào.',
  rule_06_name: 'Tỷ lệ bằng tử số trên mẫu số',
  rule_06_formula: 'Tỷ lệ {code} = {numerator} / {denominator} x 100, lệch tối đa {tolerance} điểm phần trăm.',
  source_figures: 'Số liệu đã điền vào báo cáo lúc lập (kỳ {period})',
  source_rows: 'Tổng các dòng dự án của báo cáo (kỳ {period})',
  source_snapshot: 'Bản chốt kỳ {snapshot} bản sửa {revision}',
  source_report_snapshot: 'Báo cáo lập từ bản chốt {snapshot} bản sửa {revision}',
  skip_no_figures: 'Báo cáo lập trước khi hệ thống ghi số liệu điền vào báo cáo: lập lại báo cáo để so sánh.',
  skip_illustrative: 'Báo cáo dùng số liệu minh họa (chưa có bản chốt kỳ), không đưa vào so sánh.',
  skip_missing_report: 'Chưa có báo cáo {role} cho kỳ {period}.',
  skip_no_value: 'Chưa có số {code} để so sánh.',
  skip_no_snapshot: 'Chưa có bản chốt kỳ {period} để đối chiếu.',
  skip_duplicate: 'Có nhiều hơn một báo cáo {role} cho kỳ {period}: chỉ dùng bản đầu tiên.',
  path_regenerate: 'Lập lại báo cáo {layout} từ bản chốt kỳ hiện hành rồi so sánh lại.',
  path_complete_month: 'Hoàn tất báo cáo của tháng còn thiếu rồi so sánh lại.',
  path_assign_unit: 'Gán đơn vị cho dòng dự án chưa có đơn vị.',
  path_check_source: 'Đối chiếu số liệu nguồn của từng số hạng (bản chốt kỳ, nhập liệu của đơn vị).',
  path_explain: 'Nếu số lệch có lý do chính đáng, người khác người lập ghi giải trình để cho phát hành.',
} as const;

export type Ent4aTextKey = keyof typeof ENT4A_TEXT;

/** Fills the `{name}` places of a text; a place with no value is left as it is so the gap is visible. */
export function fillCrosscheckText(key: Ent4aTextKey, values: Readonly<Record<string, string | number>> = {}): string {
  return ENT4A_TEXT[key].replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
