/** The Vietnamese words of the generic forms of the public edition (`report-public-forms.ts`): a module (not the JSON catalogue) so that the layout stays plain TypeScript and the web bundle never reads a file. */
export const PUBLIC_REPORT_TEXT = {
  weekly_name: 'Báo cáo tuần giải ngân (DIS)',
  weekly_title: 'BÁO CÁO TUẦN VỀ GIẢI NGÂN VỐN ĐẦU TƯ CÔNG',
  weekly_snapshot_line: 'Số liệu lấy từ bản chụp DIS đã chốt, tính đến ngày {day}.',
  weekly_snapshot_missing: 'Chưa có bản chụp DIS đã chốt: các chỉ tiêu theo bản chụp để trống.',
  weekly_note: 'Mỗi chỉ tiêu theo định nghĩa trong sổ chỉ tiêu; số chưa được chứng nhận hoặc chưa kiểm chứng được ghi chú kèm bản phát hành.',
  col_no: 'STT',
  col_indicator: 'Chỉ tiêu',
  col_value: 'Giá trị',
  col_unit: 'Đơn vị tính',
  unit_percent: '%',
  unit_vnd: 'đồng',
  unit_count: 'số lượng',
  sign_preparer: 'Người lập biểu',
  sign_checker: 'Người kiểm tra',
  sign_approver: 'Người phê duyệt',
  org_fallback: 'Đơn vị báo cáo',
} as const;
