/**
 * The Vietnamese texts of the alert governance modules (escalation, coverage, notification profile, health of the alert system; roadmap G2-3, G2-5, G2-7, G2-10): a module, not the JSON catalogue, so that the kernel files that use them stay in
 * English and the lane keeps its words in one file. The words of a push are a closed list on purpose: nothing that comes from data can get into them.
 */

type Severity = 'URGENT' | 'ACTION' | 'WATCH';
type PushKind = 'ITEM' | 'ESCALATION' | 'DIGEST' | 'GROUP';

const PUSH_TITLE: Readonly<Record<PushKind, string>> = {
  ITEM: 'Có việc cần xử lý',
  ESCALATION: 'Có việc được chuyển lên bạn',
  DIGEST: 'Bản tin cảnh báo buổi sáng',
  GROUP: 'Có nhiều việc khẩn',
};

const PUSH_BODY: Readonly<Record<PushKind, (count: number) => string>> = {
  ITEM: (count) => `Bạn có ${count} việc cần xử lý. Mở ứng dụng để xem.`,
  ESCALATION: (count) => `Có ${count} việc được chuyển lên bạn. Mở ứng dụng để xem.`,
  DIGEST: (count) => `Bản tin hôm nay có ${count} việc. Mở ứng dụng để xem.`,
  GROUP: (count) => `Bạn có ${count} việc khẩn. Mở ứng dụng để xem.`,
};

const KPI_FORMULA: Readonly<Record<string, string>> = {
  MTTA: 'Trung bình số giờ làm việc từ lúc việc phát sinh đến lúc có người nhận xử lý lần đầu, theo mức; chỉ tính việc được nhận trong kỳ, trên lịch làm việc đã công bố.',
  MTTR: 'Trung bình số giờ làm việc từ lúc việc phát sinh đến lúc việc đóng (đã xử lý hoặc điều kiện nguồn hết), trừ thời gian đồng hồ bị tạm dừng; chỉ tính việc đóng trong kỳ.',
  ON_TIME: 'Số việc đóng trước hạn xử lý chia số việc đóng trong kỳ có hạn; việc không có hạn không tính.',
  ESCALATED: 'Số việc phát sinh trong kỳ đã bị leo ít nhất một cấp chia số việc phát sinh trong kỳ.',
  LAST_LEVEL: 'Số việc phát sinh trong kỳ đã leo tới cấp cuối của chuỗi chia số việc phát sinh trong kỳ.',
  ALERTS_PER_PERSON: 'Phân vị 90 của số cảnh báo mới một người nhận trong một ngày, tính trên các ngày người đó có ít nhất một cảnh báo; tách riêng mức Khẩn.',
  PUSH_PER_PERSON: 'Phân vị 90 của số thông báo gián đoạn (đẩy, SMS, Zalo) đã gửi cho một người trong một ngày của họ; thông báo gộp tính một.',
  OFF_HOURS: 'Số thông báo gián đoạn gửi trong giờ yên tĩnh của người nhận mà không có ngoại lệ của chính sách (Khẩn, loại cảnh báo được phép xuyên, quá hạn nhận).',
  STALE: 'Số việc đang mở không đổi trạng thái quá số ngày của ngưỡng thứ nhất chia số việc đang mở; ngưỡng thứ hai nêu riêng.',
  TOP10_SHARE: 'Số việc của mười loại cảnh báo nhiều nhất chia tổng số việc phát sinh trong kỳ.',
  SNOOZE_RATE: 'Số việc phát sinh trong kỳ đã bị hoãn ít nhất một lần chia số việc phát sinh trong kỳ, tính chung và theo loại có đủ mẫu.',
  ORPHAN: 'Tổng số cảnh báo đang không có người nhận hợp lệ (người nhận đã nghỉ, vắng không có người thay, chuỗi leo trống); kèm thời gian trung bình để chuyển cho người khác.',
  URGENT_DELIVERY: 'Số thông báo Khẩn được giao đến máy người nhận trong số phút của ngưỡng chia số thông báo Khẩn đã gửi.',
  DELEGATION_COVERAGE: 'Số chức danh (vai trò trong đơn vị, từ hạng lãnh đạo) có dự phòng hiệu lực (đủ số người đang làm hoặc có người thay đang có hiệu lực) chia tổng số chức danh.',
};

const KPI_SOURCE: Readonly<Record<string, string>> = {
  MTTA: 'Bảng alert_item_trace do job alert-escalation ghi mỗi 15 phút; lịch làm việc đã công bố của tổ chức; ngưỡng ALERT_HEALTH_TARGETS.',
  MTTR: 'Bảng alert_item_trace; các lần tạm dừng đồng hồ trong work_action; lịch làm việc đã công bố.',
  ON_TIME: 'Bảng alert_item_trace (thời điểm đóng và hạn xử lý của việc).',
  ESCALATED: 'Bảng alert_item_trace và alert_escalation (các cấp đã ghi).',
  LAST_LEVEL: 'Bảng alert_item_trace và chính sách ESCALATION_POLICY đang hiệu lực.',
  ALERTS_PER_PERSON: 'Bảng alert_item_trace (người nhận và thời điểm thấy lần đầu).',
  PUSH_PER_PERSON: 'Bảng alert_notification_log (quyết định gửi từng thông báo).',
  OFF_HOURS: 'Bảng alert_notification_log (cờ gửi trong giờ yên tĩnh và lý do xuyên).',
  STALE: 'Bảng alert_item_trace (lần đổi trạng thái gần nhất của việc đang mở).',
  TOP10_SHARE: 'Bảng alert_item_trace (loại cảnh báo của từng việc).',
  SNOOZE_RATE: 'Bảng alert_item_trace; chưa có phản hồi "cảnh báo này không đúng" (G2-9) nên chưa tính phần đó.',
  ORPHAN: 'Bảng alert_routing_gap (khoảng trống người nhận đang mở và đã đóng).',
  URGENT_DELIVERY: 'Chưa có biên nhận giao nhận cho thông báo cảnh báo (G2-6); chỉ số sẽ có khi biên nhận được ghi.',
  DELEGATION_COVERAGE: 'Bảng role_grant, alert_absence và alert_absence_cover (độ phủ chức danh tại thời điểm xem).',
};

export const ALERT_GOV_TEXT = {
  chain_hierarchical: (levels: number): string => `Lãnh đạo trực tiếp, bậc ${levels}`,
  chain_functional: (role: string): string => `Đơn vị chuyên môn, vai trò ${role}`,
  push_title: (kind: PushKind, severity: Severity): string => (severity === 'URGENT' ? `Khẩn: ${PUSH_TITLE[kind]}` : PUSH_TITLE[kind]),
  push_body: (kind: PushKind, count: number): string => PUSH_BODY[kind](count),
  kpi_formula: (code: string): string => KPI_FORMULA[code] ?? code,
  kpi_source: (code: string): string => KPI_SOURCE[code] ?? code,
  rules: {
    source: 'G2-3, G2-5, G2-7, G2-10 của lộ trình quản trị (docs/alert-governance.md): giá trị khởi điểm từ nghiên cứu PagerDuty, ITIL, Grafana IRM, Opsgenie, ISA-18.2 (qua tài liệu tóm tắt), cần chốt với khách hàng và kiểm toán sau 4 đến 6 tuần dữ liệu thật',
    escalation_formula: 'Mỗi cấp của chuỗi leo thang là chức năng (vai trò của đơn vị chuyên môn) hoặc thứ bậc (lãnh đạo trên chủ việc mấy bậc), kèm số giờ làm việc chờ sau cấp trước; việc cần theo dõi không leo tới người mà được nâng một bậc sau số ngày làm việc không ai động tới.',
    absence_formula: 'Người vắng mặt khai khoảng vắng; người thay nhận cảnh báo theo nguồn trong thời hạn tối đa, người cho phép là người thứ ba; chuỗi thay không vòng và không sâu quá mức cho phép; khoảng trống kéo dài quá số giờ làm việc thì thành cảnh báo cho người quản lý.',
    notify_formula: 'Mức khẩn quyết định kênh: chuông trong ứng dụng luôn đúng; kênh gián đoạn chỉ cho Khẩn và Cần xử lý, giữ giờ yên tĩnh trừ Khẩn đã quá hạn nhận của loại được phép xuyên, có trần mỗi ngày, việc cần theo dõi chỉ vào bản tin sáng; thông báo đẩy không có số tiền hay tên.',
    health_formula: 'Mười bốn chỉ số của chính hệ thống cảnh báo, mỗi chỉ số một công thức; mục tiêu là đề xuất khởi điểm để hiệu chỉnh bằng dữ liệu thật, không phải con số pháp lý.',
  },
  alert_types: {
    escalated_item: {
      action: 'Mở việc đã được chuyển lên, xác nhận đã nhận và xử lý hoặc giao lại cho người đúng chuyên môn.',
      consequence: 'Việc không ai xử lý ở cấp dưới đã được chuyển lên bạn; nếu bạn cũng không xử lý, nó sẽ lên cấp tiếp theo của chuỗi leo thang.',
      why: 'Chuỗi leo thang bảo đảm việc không ai xử lý không dừng lại ở một người; người nhận cấp trên phải nhìn thấy và xác nhận.',
    },
    coverage_gap: {
      action: 'Chỉ định người thay cho người vắng mặt hoặc xác nhận đề nghị thay đang chờ, để cảnh báo của họ có người nhận.',
      consequence: 'Cảnh báo của người vắng mặt không có người nhận hợp lệ và đang tự rơi lên lãnh đạo trực tiếp.',
      why: 'Mỗi cảnh báo cần có người còn hiện diện để nhận; khoảng trống người thay làm cảnh báo mồ côi và tăng nguy cơ bỏ sót.',
    },
  },
  source: {
    escalation_title: (title: string): string => `Được chuyển lên: ${title}`,
    escalation_detail_functional: 'Chuyển theo chức năng',
    escalation_detail_hierarchical: 'Chuyển theo thứ bậc',
    escalation_detail_orphan: 'Chuyển vì không có người nhận hợp lệ',
    coverage_absent: (name: string): string => `${name} vắng mặt và chưa có người thay`,
    coverage_starting: (name: string): string => `${name} sắp vắng mặt và chưa có đề nghị người thay`,
    coverage_owner_inactive: 'Người nhận đã nghỉ, cảnh báo chưa có người nhận',
    coverage_detail: (days: number): string => `Đã ${days} ngày`,
  },
} as const;
