/**
 * The Vietnamese texts of the alerts of the risk grade and the performance of a contractor (lane VND-2, slice C; docs/vendor-controls-risk-performance.md): a module (not the JSON catalogue) because the lines of
 * the alert centre are written in the database package and the catalogue of messages is not read there for these lines. Placeholders are filled by `vnd2cText`.
 */
export const VND2C_TEXT = {
  publish_title: 'Đánh giá thực hiện hợp đồng {contract} của {name} chưa được công khai',
  publish_detail: 'Hạn công khai {due}; trạng thái {status}',
  response_title: 'Phản hồi của {name} về đánh giá hợp đồng {contract} chờ xem xét',
  response_detail: 'Nhận ngày {received}; hạn xem xét theo quy tắc, trạng thái {status}',
  streak_title: '{name} có {count} đánh giá kém liên tiếp',
  streak_detail: 'Gợi ý {suggestion}: kế hoạch khắc phục hoặc xem xét đề nghị hồ sơ hạn chế (không tự mở)',
  risk_pending_title: 'Hạng rủi ro {tier} của {name} chờ người thứ hai xác nhận',
  risk_pending_detail: 'Chấm ngày {assessed}; điểm {score}',
  risk_overdue_title: 'Hạng rủi ro {tier} của {name} đã quá ngày xem lại',
  risk_overdue_detail: 'Ngày xem lại {due}',
} as const;

/** Fills the placeholders of a text of `VND2C_TEXT`. */
export function vnd2cText(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}
