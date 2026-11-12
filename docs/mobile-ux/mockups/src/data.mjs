// Illustrative content shared by both directions, so the two are compared on design and not on wording.
// Public edition ("Hệ thống quản lý đầu tư công", launcher "Đầu tư công"): state agencies only. Every name, code and figure is made up for
// the mockups. Today in the mockups: Thursday 12/11/2026.

export const SYSTEM = 'Hệ thống quản lý đầu tư công';
export const LAUNCHER = 'Đầu tư công';
export const TODAY = '12/11/2026';

/** One money formatter: the biggest unit whose whole part is at least 1; Vietnamese marks (. thousands, , decimals). */
export function vnd(n) {
  const abs = Math.abs(n);
  const fmt = (v, digits) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v);
  if (abs >= 1e9) return { value: fmt(n / 1e9, 1), unit: 'tỷ đồng' };
  if (abs >= 1e6) return { value: fmt(n / 1e6, 1), unit: 'triệu đồng' };
  return { value: fmt(n, 0), unit: 'đồng' };
}
export const money = (n) => { const m = vnd(n); return `${m.value} ${m.unit}`; };

/** Deadline band from the days left (calendar days in the mockups): below 1 = red (late or today), 1 to 3 = amber, above 3 = green. */
export function band(days) {
  if (days < 0) return { key: 'late', text: `Trễ ${-days} ngày`, icon: 'alertOctagon', name: 'Quá hạn' };
  if (days === 0) return { key: 'late', text: 'Hôm nay', icon: 'alertOctagon', name: 'Đến hạn hôm nay' };
  if (days <= 3) return { key: 'soon', text: days === 1 ? 'Ngày mai' : `Còn ${days} ngày`, icon: 'alertTriangle', name: 'Sắp đến hạn' };
  return { key: 'ok', text: `Còn ${days} ngày`, icon: 'clock', name: 'Còn thời gian' };
}

export const people = {
  leader: { name: 'Nguyễn Văn Hòa', role: 'Phó Giám đốc Sở Kế hoạch và Đầu tư', short: 'Hòa' },
  officer: { name: 'Lê Thị Mai', role: 'Cán bộ Ban QLDA đầu tư xây dựng giao thông', short: 'Mai' },
};

export const projects = {
  P017: { code: 'DA-CB-017', name: 'Đường tỉnh ĐT.206, đoạn Km12 đến Km28', group: 'Nhóm B', stage: 'Thực hiện', investor: 'Ban QLDA đầu tư xây dựng các công trình giao thông', total: 186.4e9, plan: 82e9, paid: 51.7e9, progress: 58 },
  P023: { code: 'DA-CB-023', name: 'Cầu bê tông bắc qua sông Bằng Giang', group: 'Nhóm B', stage: 'Thực hiện', progress: 41 },
  P031: { code: 'DA-CB-031', name: 'Nâng cấp hồ chứa nước Khuổi Mụn', group: 'Nhóm B', stage: 'Quyết định', progress: 20 },
  P044: { code: 'DA-CB-044', name: 'Cải tạo Bệnh viện đa khoa huyện Hòa An', group: 'Nhóm C', stage: 'Thực hiện', progress: 74 },
  P052: { code: 'DA-CB-052', name: 'Trường THPT dân tộc nội trú, xây mới', group: 'Nhóm C', stage: 'Chủ trương', progress: 12 },
};

// Officer (cán bộ chủ đầu tư): "Việc hôm nay", sorted by deadline. days = due minus today.
export const tasks = [
  { id: 'T-2041', title: 'Nộp hồ sơ thiết kế bản vẽ thi công cho Sở Xây dựng thẩm định', project: 'P017', due: '10/11', days: -2, docs: [3, 4] },
  { id: 'T-2057', title: 'Ký phụ lục hợp đồng gói thầu XL-02', project: 'P017', due: '12/11', days: 0, docs: [2, 2] },
  { id: 'T-2063', title: 'Báo cáo khối lượng và giải ngân tháng 11 gửi Sở Tài chính', project: 'P023', due: '13/11', days: 1, docs: [1, 2] },
  { id: 'T-2071', title: 'Thẩm tra dự toán gói thầu thiết bị y tế', project: 'P044', due: '15/11', days: 3, docs: [0, 2] },
  { id: 'T-2088', title: 'Lập hồ sơ mời thầu gói thiết bị phòng học', project: 'P052', due: '20/11', days: 8, docs: [0, 3] },
  { id: 'T-2092', title: 'Nghiệm thu giai đoạn 1 hạng mục kè hồ chứa', project: 'P031', due: '28/11', days: 16, docs: [0, 5] },
];

// Leader (lãnh đạo Sở): items that wait for a decision.
export const decisions = [
  { id: 'AP-8812', kind: 'Điều chỉnh kế hoạch vốn', title: 'Điều chỉnh kế hoạch vốn 2026 lần 3: chuyển 12 tỷ giữa hai dự án', amount: 12e9, from: 'Nguyễn Thị Lan · Phòng Tổng hợp', sent: '11/11 09:20', days: 1, attach: 3, checks: 'Đủ 3/3 chứng từ, tổng vốn không đổi' },
  { id: 'AP-8807', kind: 'Báo cáo giải ngân', title: 'Báo cáo giải ngân tháng 10/2026 gửi Sở Tài chính', from: 'Trần Văn Hùng · P. Kế hoạch - Tài chính', sent: '10/11 16:05', days: 0, attach: 2, checks: 'Khớp số liệu Kho bạc, không còn số lệch' },
  { id: 'AP-8798', kind: 'Điều chỉnh dự án', title: 'Tăng tổng mức đầu tư dự án ĐT.206 thêm 4,2 tỷ đồng', amount: 4.2e9, from: 'Ban QLDA xây dựng giao thông', sent: '09/11 14:40', days: 4, attach: 4, checks: 'Có kết quả thẩm định của Sở Xây dựng' },
  { id: 'AP-8790', kind: 'Gia hạn thực hiện', title: 'Gia hạn 60 ngày hợp đồng gói thầu XL-02', from: 'Lê Minh Cường · Chủ đầu tư', sent: '08/11 10:12', days: 8, attach: 1, checks: 'Có đề nghị nhà thầu và ý kiến tư vấn' },
];

// Notifications.
export const notices = [
  { group: 'Hôm nay', kind: 'late', icon: 'alertOctagon', title: 'Việc T-2041 đã trễ 2 ngày', body: 'Nộp hồ sơ thiết kế bản vẽ thi công · DA-CB-017', time: '07:30', unread: true, tag: 'Hạn việc' },
  { group: 'Hôm nay', kind: 'soon', icon: 'alertTriangle', title: 'Việc T-2063 đến hạn ngày mai', body: 'Báo cáo khối lượng và giải ngân tháng 11 · DA-CB-023', time: '07:30', unread: true, tag: 'Hạn việc' },
  { group: 'Hôm nay', kind: 'info', icon: 'clipcheck', title: 'Có 4 hồ sơ chờ bạn phê duyệt', body: 'Sớm nhất đến hạn hôm nay: báo cáo giải ngân tháng 10', time: '07:05', unread: true, tag: 'Phê duyệt' },
  { group: 'Hôm qua', kind: 'late', icon: 'undo', title: 'Hồ sơ DOC-5521 bị trả lại', body: 'Lý do: thiếu chữ ký của Giám đốc Ban QLDA', time: '16:48', unread: false, tag: 'Phê duyệt' },
  { group: 'Hôm qua', kind: 'ok', icon: 'checkCircle', title: 'Kế hoạch vốn năm 2026 bản 2 đã công bố', body: 'Tổng 1.820 tỷ đồng, 48 dòng vốn', time: '11:20', unread: false, tag: 'Hệ thống' },
  { group: 'Hôm qua', kind: 'info', icon: 'calendar', title: 'Kỳ số liệu tháng 10 đã khóa', body: 'Bản chốt 31/10/2026 do Sở Tài chính xác nhận', time: '09:02', unread: false, tag: 'Hệ thống' },
];

// Project detail (DA-CB-017): workflow stages (Luật Đầu tư công: chuẩn bị, quyết định, thực hiện, kết thúc) and the tasks of the current one.
export const stages = [
  { name: 'Chuẩn bị', done: 5, of: 5 },
  { name: 'Chủ trương', done: 4, of: 4 },
  { name: 'Quyết định', done: 3, of: 3 },
  { name: 'Thực hiện', done: 7, of: 12, current: true },
  { name: 'Nghiệm thu', done: 0, of: 4 },
  { name: 'Quyết toán', done: 0, of: 3 },
];
export const stageTasks = [
  { title: 'Nộp hồ sơ thiết kế bản vẽ thi công', who: 'Lê Thị Mai', due: '10/11', days: -2 },
  { title: 'Ký phụ lục hợp đồng gói thầu XL-02', who: 'Lê Thị Mai', due: '12/11', days: 0 },
  { title: 'Nghiệm thu khối lượng đợt 3', who: 'Hoàng Văn Hải', due: '14/11', days: 2 },
  { title: 'Thanh toán đợt 3 cho nhà thầu XL-02', who: 'Đỗ Thị Lan', due: '21/11', days: 9 },
  { title: 'Thi công lớp móng cấp phối đoạn Km20 đến Km28', who: 'Nhà thầu XL-02', due: '05/12', days: 23 },
  { title: 'Hoàn thành khối lượng thi công đợt 2', who: 'Hoàng Văn Hải', done: '04/11' },
];

// Task detail (T-2041).
export const taskDetail = {
  id: 'T-2041', title: 'Nộp hồ sơ thiết kế bản vẽ thi công cho Sở Xây dựng thẩm định', project: 'P017', stage: 'Thực hiện', owner: 'Lê Thị Mai',
  start: '03/11', due: '10/11', days: -2, base: '10/11', approver: 'Hoàng Văn Hải (Giám đốc Ban QLDA)',
  docs: [
    { name: 'Hồ sơ thiết kế bản vẽ thi công', meta: 'PDF · 2,4 MB · tải lên 11/11', ok: true },
    { name: 'Báo cáo kết quả thẩm tra của tư vấn', meta: 'PDF · 640 KB · tải lên 11/11', ok: true },
    { name: 'Dự toán xây dựng công trình', meta: 'XLSX · 1,1 MB · tải lên 10/11', ok: true },
    { name: 'Quyết định phê duyệt thiết kế của chủ đầu tư', meta: 'Bắt buộc · chưa có tệp', ok: false },
  ],
  form: 'Tờ trình đề nghị thẩm định (mẫu TT-03)',
};

// Funding by source for the leader home: central and local budget (illustrative).
export const sources = [
  { name: 'Ngân sách trung ương', paid: 412e9, plan: 760e9 },
  { name: 'Ngân sách địa phương', paid: 646.3e9, plan: 1060e9 },
];
export const kpi = { paid: 1058.3e9, plan: 1820e9, late: 6, of: 32, overdue: 5 };

export const month = 'Số liệu chốt 31/10/2026';
export const scope = 'Toàn tỉnh · 32 dự án';
