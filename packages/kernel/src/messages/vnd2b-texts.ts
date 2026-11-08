/**
 * The Vietnamese texts of the alerts of lane VND-2, slice beta (bid security and subcontracts; docs/vendor-controls-security-subcontract.md): a module (not the JSON catalogue) because the rules of the lane also run in
 * the browser. Each entry fills the title and the detail of an item of the alert centre.
 */
const fill = (template: string, params: Record<string, string | number>): string => template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));

export const VND2B_TEXT = {
  security_expiry_title: 'Bảo đảm dự thầu {no} của {name} sắp hết hạn',
  security_expiry_detail: 'Gói {package}, hiệu lực đến {until}, trạng thái {state}',
  subcontract_breach_title: 'Thầu phụ {name} của hợp đồng {contract} cần xem lại',
  subcontract_breach_detail: 'Lý do: {kind}, từ ngày {since}',
  sub_payment_title: 'Chưa ghi số đã trả thầu phụ {name} của hợp đồng {contract}',
  sub_payment_detail: 'Kỳ thanh toán đã trả ngày {paid}, hạn ghi theo quy tắc VENDOR_SUBCONTRACT',
  breach_kinds: { EXCEPTION: 'chấp thuận ngoại lệ vượt phần đã nêu', OVER_PAID: 'đã trả vượt giá trị thầu phụ', RESTRICTED: 'thầu phụ đang bị hạn chế' },
} as const;

export const vnd2bText = (template: string, params: Record<string, string | number>): string => fill(template, params);
