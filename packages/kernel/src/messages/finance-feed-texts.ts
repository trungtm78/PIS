/**
 * The Vietnamese words of the finance feed (lane FEED-1, `docs/finance-feed.md`): the names of the sectors, districts, investors and funds of the province, the
 * names of the milestones, the alert types and the data-quality indicators. A module (not the JSON catalogue) because the web build imports the kernel and cannot read a file.
 */

export const FEED_TEXT = {
  number_word: 'số',
  connection_name: 'Nguồn số liệu từ ứng dụng của Sở Tài chính',
  layout_note: 'Mẫu tệp là giả định làm việc, chờ mẫu chính thức từ Sở Tài chính (PENDING-EXTERNAL)',
  api_pending: 'Chờ tài khoản máy của cổng tích hợp (INT-1) và đặc tả giao diện của Sở Tài chính',

  // The rule that sets the figures of the feed.
  policy_formula:
    'Dung sai sai lệch = |số của nguồn cấp - số của ta| chia số của ta, so với dung sai tolerance_pct; sai lệch lớn khi vượt large_discrepancy_pct; đơn vị báo cáo trễ khi chưa có số liệu của tháng sau report_due_days ngày kể từ cuối tháng.',
  policy_source: 'Lựa chọn vận hành của hệ thống, chưa có văn bản pháp lý quy định; đơn vị tự phê duyệt phiên bản của mình',
  freshness_formula: 'Tuổi dữ liệu = thời điểm hiện tại trừ thời điểm lần nhận số liệu gần nhất của nguồn cấp từ Sở Tài chính; mới đến warn_after_hours, cũ dần đến max_age_hours, quá hạn khi vượt.',

  // The alert types.
  alert_stale_action: 'Kiểm tra kết nối với ứng dụng của Sở Tài chính, nhận lại số liệu mới nhất và ghi nguyên nhân',
  alert_stale_consequence: 'Số liệu toàn tỉnh cũ hơn mức cho phép: bảng điều hành tiến độ đầu tư công phải ghi rõ là chưa cập nhật',
  alert_stale_why: 'Trưởng Ban chỉ đạo điều hành theo số liệu từ Sở Tài chính; số cũ làm sai quyết định',
  alert_late_action: 'Nhắc đơn vị chủ đầu tư nộp báo cáo giải ngân tháng và ghi ngày hẹn nộp',
  alert_late_consequence: 'Số liệu của đơn vị thiếu: tỷ lệ giải ngân toàn tỉnh bị thấp giả, không đủ cơ sở xếp hạng đơn vị',
  alert_late_why: 'Một đơn vị chậm báo cáo làm lệch số toàn tỉnh mà không ai thấy nếu không có cảnh báo',
  alert_discrepancy_action: 'Chủ sở hữu sai lệch đối chiếu số của Sở Tài chính với số của ta và chọn một cách xử lý có lý do',
  alert_discrepancy_consequence: 'Hai nguồn số liệu mâu thuẫn nhau: báo cáo gửi lãnh đạo có thể sai và không thể bảo vệ được số liệu',
  alert_discrepancy_why: 'Sai lệch lớn giữa nguồn của Sở Tài chính và số của ta là dấu hiệu sớm của lỗi nhập hoặc báo cáo sai',

  // The data-quality indicators of the feed (KPI register).
  kpi_completeness_name: 'Độ đầy đủ của số liệu từ Sở Tài chính',
  kpi_completeness_formula: 'Số đơn vị chủ đầu tư đã báo cáo giải ngân của tháng chia số đơn vị phải báo cáo, nhân 100',
  kpi_completeness_numerator: 'Số đơn vị có ít nhất một dòng giải ngân của tháng, theo ngày số liệu',
  kpi_completeness_denominator: 'Số đơn vị chủ đầu tư có dự án đang thực hiện và có kế hoạch vốn năm',
  kpi_timeliness_name: 'Độ kịp thời của số liệu từ Sở Tài chính',
  kpi_timeliness_formula: 'Số đơn vị báo cáo đúng hạn chia số đơn vị đã báo cáo của tháng, nhân 100',
  kpi_timeliness_numerator: 'Số đơn vị có ngày báo cáo không sau hạn (cuối tháng cộng report_due_days)',
  kpi_timeliness_denominator: 'Số đơn vị đã báo cáo trong tháng',
  kpi_discrepancy_name: 'Tỷ lệ sai lệch của số liệu từ Sở Tài chính',
  kpi_discrepancy_formula: 'Số chỉ tiêu có sai lệch vượt dung sai chia số chỉ tiêu đã đối chiếu với số của ta, nhân 100',
  kpi_discrepancy_numerator: 'Số sai lệch đang mở hoặc đã xử lý trong kỳ đối chiếu',
  kpi_discrepancy_denominator: 'Số chỉ tiêu (dự án, năm, trường) đã đối chiếu',
  kpi_source: 'Bảng finance_feed_record và finance_feed_difference, tính khi đọc (docs/finance-feed.md)',

  // The findings of the feed itself.
  finding_cumulative_mismatch: 'Số lũy kế khác tổng các tháng',
  finding_over_plan: 'Số giải ngân lũy kế vượt kế hoạch vốn năm',
  finding_restated: 'Số của tháng đã được báo cáo lại với giá trị khác',
  finding_unknown_project: 'Dòng giải ngân của dự án chưa có trong danh mục dự án của nguồn cấp',

  // Milestones.
  ms_package_published: 'Đăng thông báo mời thầu',
  ms_package_awarded: 'Phê duyệt kết quả lựa chọn nhà thầu',
  ms_contract_signed: 'Ký hợp đồng',
  ms_site_handover: 'Bàn giao mặt bằng',
  ms_acceptance: 'Nghiệm thu',
  ms_settlement: 'Quyết toán',
} as const;

export const FEED_SECTORS: ReadonlyArray<{ code: string; name: string; weight: number; nouns: readonly string[] }> = [
  { code: 'GT', name: 'Giao thông', weight: 30, nouns: ['Đường tỉnh', 'Cầu', 'Đường liên huyện', 'Nâng cấp quốc lộ', 'Đường nối'] },
  { code: 'NN', name: 'Nông nghiệp và phát triển nông thôn', weight: 14, nouns: ['Hồ chứa nước', 'Kênh tưới', 'Đê kè', 'Trạm bơm'] },
  { code: 'GD', name: 'Giáo dục và đào tạo', weight: 12, nouns: ['Trường tiểu học', 'Trường THCS', 'Trường THPT', 'Ký túc xá'] },
  { code: 'YT', name: 'Y tế', weight: 9, nouns: ['Bệnh viện đa khoa', 'Trung tâm y tế', 'Trạm y tế'] },
  { code: 'VH', name: 'Văn hóa, thể thao và du lịch', weight: 7, nouns: ['Nhà văn hóa', 'Sân vận động', 'Khu du lịch'] },
  { code: 'MT', name: 'Tài nguyên và môi trường', weight: 8, nouns: ['Hệ thống thoát nước', 'Xử lý rác thải', 'Công viên cây xanh'] },
  { code: 'HT', name: 'Hạ tầng đô thị và cấp nước', weight: 12, nouns: ['Nhà máy nước', 'Điện chiếu sáng', 'Hạ tầng khu dân cư'] },
  { code: 'QL', name: 'Quản lý nhà nước, quốc phòng, an ninh', weight: 8, nouns: ['Trụ sở làm việc', 'Doanh trại', 'Trung tâm chỉ huy'] },
];

export const FEED_DISTRICTS: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'D01', name: 'Thành phố Trung Tâm' },
  { code: 'D02', name: 'Thị xã Đông Giang' },
  { code: 'D03', name: 'Huyện Tây Lĩnh' },
  { code: 'D04', name: 'Huyện Nam Cầu' },
  { code: 'D05', name: 'Huyện Bắc Hà Mới' },
  { code: 'D06', name: 'Huyện Phước Thịnh' },
  { code: 'D07', name: 'Huyện An Lạc Đông' },
  { code: 'D08', name: 'Huyện Hưng Điền' },
  { code: 'D09', name: 'Huyện Long Sơn Mới' },
  { code: 'D10', name: 'Huyện Vạn Xuân' },
  { code: 'D11', name: 'Huyện Thanh Bình Mới' },
  { code: 'D12', name: 'Huyện Minh Khai Mới' },
];

/** The investors of the province: a unit of the province for each sector and a project management board for each district. */
export const FEED_INVESTORS_PROVINCE: ReadonlyArray<{ code: string; sector: string; name: string }> = [
  { code: 'CDT-SGT', sector: 'GT', name: 'Sở Giao thông vận tải' },
  { code: 'CDT-BQL-GT', sector: 'GT', name: 'Ban quản lý dự án giao thông tỉnh' },
  { code: 'CDT-SNN', sector: 'NN', name: 'Sở Nông nghiệp và Phát triển nông thôn' },
  { code: 'CDT-SGD', sector: 'GD', name: 'Sở Giáo dục và Đào tạo' },
  { code: 'CDT-SYT', sector: 'YT', name: 'Sở Y tế' },
  { code: 'CDT-SVH', sector: 'VH', name: 'Sở Văn hóa, Thể thao và Du lịch' },
  { code: 'CDT-STN', sector: 'MT', name: 'Sở Tài nguyên và Môi trường' },
  { code: 'CDT-SXD', sector: 'HT', name: 'Sở Xây dựng' },
  { code: 'CDT-CAT', sector: 'QL', name: 'Công an tỉnh' },
  { code: 'CDT-BCH', sector: 'QL', name: 'Bộ chỉ huy quân sự tỉnh' },
];

export const FEED_FUND_NAMES: Readonly<Record<string, string>> = {
  NSTW: 'Ngân sách trung ương',
  NSDP: 'Ngân sách địa phương',
  ODA: 'Vốn vay nước ngoài (ODA)',
  TPCP: 'Trái phiếu Chính phủ',
  CTMTQG: 'Chương trình mục tiêu quốc gia',
  OTHER: 'Nguồn khác',
};

export const FEED_DISTRICT_INVESTOR_NAME = 'Ban quản lý dự án đầu tư xây dựng {district}';
