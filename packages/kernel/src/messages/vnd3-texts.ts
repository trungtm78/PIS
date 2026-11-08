/**
 * The Vietnamese texts of the governance rules, alert types, indicators and alert rows of lane VND-3 (contractor investigation and portal): a module (not the JSON catalogue) because the pure rules of the lane also run
 * in the browser, where the catalogue cannot be read. `vnd3Text(key, params)` fills the `{name}` places.
 */
export const VND3_TEXT = {
  rules_source:
    'Điều 16 Luật Đấu thầu 22/2023 (hành vi bị cấm: thông thầu, gian lận, người thân đứng tên dự thầu), Điều 19, 20, 133 Nghị định 214/2025/NĐ-CP, đọc từ bản tóm tắt, chưa đối chiếu Luật 57/2024 và 90/2025; các dạng thông thầu theo kiến thức chung của cơ quan cạnh tranh (hướng dẫn OECD 2025 chưa mở được); ngưỡng là giá trị khởi điểm cần chốt với khách và kiểm toán.',
  formula: {
    link_rule:
      'Hai nhà thầu có liên kết khi dùng chung mã số thuế gốc, tài khoản, người đại diện, chủ sở hữu, địa chỉ, số điện thoại, thư điện tử, nguồn nộp hồ sơ, thiết bị hoặc tác giả tệp. Độ mạnh = 1 − tích của (1 − trọng số/100) của các bằng chứng; chỉ giữ liên kết từ ngưỡng link_from; khóa dùng chung bởi nhiều hơn max_group_size nhà thầu bị bỏ qua vì là nhiễu.',
    bid_rigging:
      'Tín hiệu thông thầu: nhóm nhà thầu quen thuộc thay phiên trúng (đủ rotation_min_packages gói, ít người ngoài thắng, không ai vượt rotation_max_share_pct); giá thấp nhất và nhì sát nhau dưới cover_close_gap_bp trong khi các giá còn lại cao hơn ít nhất cover_far_gap_bp; giá trùng hoặc cách đều nhau; cùng tác giả tệp; cùng nguồn hoặc thiết bị nộp trong cửa sổ origin_window_minutes; nhà thầu rút hồ sơ cho cùng một người trúng. Điểm = trọng số, cộng thêm khi mẫu rõ nét hơn; chỉ tín hiệu từ lead_from thành đầu mối.',
    investigation: 'Một đầu mối bị xóa sau khi hai kiểm toán viên xác nhận sẽ mở lại khi hạng của nó tăng ít nhất reopen_rise điểm hoặc có loại bằng chứng mới; lần quét đọc các gói đóng trong window_days ngày; đầu mối từ alert_from điểm sinh cảnh báo cho kiểm toán viên.',
    screening:
      'So khớp nhà thầu với danh sách bên bị cấm: trùng mã số thuế = weight_tax_code, trùng mã gốc (chi nhánh với trụ sở) = weight_tax_head, tên giống nhau từ name_similarity_from_pct phần trăm = weight_name nhân độ giống (không bao giờ đủ để tạm giữ một mình). Từ hit_from là kết quả khớp; từ hold_from và mục còn hiệu lực thì tạm giữ nhà thầu cho đến khi người có quyền quyết định; kết quả bị bác hỏi lại sau dismiss_valid_days ngày hoặc khi mục đổi.',
    portal:
      'Mỗi loại yêu cầu gửi nhà thầu có số ngày trả lời (ngày lịch hoặc ngày làm việc) và số ngày nhắc trước hạn; nhà thầu luôn được trả lời, trả lời muộn bị đánh dấu muộn chứ không bị từ chối. Đánh giá thực hiện hợp đồng: 20 ngày theo Điều 20 Nghị định 214/2025 (chưa đối chiếu).',
    reconfirmation:
      'Nhà thầu xác nhận lại hồ sơ mỗi interval_months tháng và ký cam kết liêm chính theo phiên bản của quy tắc; nhắc từ remind_days ngày trước hạn, quá hạn trong grace_days ngày là QUÁ HẠN, sau đó là LỖI THỜI. Chỉ hiển thị, không chặn giao dịch.',
    remediation: 'Kế hoạch khắc phục: nhân viên đề xuất, nhà thầu đồng ý; chỉ hoàn thành khi mọi hành động đã được xác minh; hành động quá hạn sinh cảnh báo trước remind_before_days ngày.',
    ocds_export: 'Xuất các bên theo OCDS (parties[]) với mã số thuế làm định danh; chủ sở hữu hưởng lợi và đầu mối liên hệ chỉ được xuất khi quy tắc bật (mặc định tắt vì căn cứ pháp lý chưa kiểm chứng).',
  },
  declaration_default:
    'Tôi, người đại diện hợp pháp của nhà thầu, cam kết: thông tin hồ sơ đã khai là đúng và đầy đủ; không thông đồng, dàn xếp giá, không để người thân của người có thẩm quyền đứng tên dự thầu, không đưa hối lộ hoặc có hành vi bị cấm khác theo Điều 16 Luật Đấu thầu; sẽ thông báo ngay khi thông tin thay đổi.',
  alert: {
    action: {
      vendor_link_lead: 'Mở đầu mối, xem các liên kết hoặc dấu hiệu thông thầu và nhận xem xét hoặc đề nghị xóa kèm lý do',
      vendor_screening_hit: 'Xác nhận kết quả khớp (mở hồ sơ cấm) hoặc bác bỏ kèm lý do để mở lại giao dịch với nhà thầu',
      vendor_reconfirm: 'Nhắc nhà thầu xác nhận lại hồ sơ và ký cam kết liêm chính, hoặc ghi lý do nếu nhà thầu không còn hoạt động',
      vendor_portal_request: 'Xem câu trả lời của nhà thầu và chấp nhận hoặc trả lại, hoặc nhắc nhà thầu khi quá hạn',
      vendor_remediation: 'Xác minh hành động khắc phục đã làm, hoặc làm việc với nhà thầu về hành động quá hạn',
    },
    consequence: {
      vendor_link_lead: 'Thông thầu hoặc người liên quan có thể không bị phát hiện, kết quả lựa chọn nhà thầu có thể bị hủy khi thanh tra',
      vendor_screening_hit: 'Nhà thầu đang bị tạm giữ không được nộp hồ sơ, trúng thầu, kích hoạt hợp đồng hay nhận thanh toán; giao dịch với bên bị cấm là vi phạm Điều 16',
      vendor_reconfirm: 'Hồ sơ nhà thầu lỗi thời, thông tin sở hữu và người đại diện không còn tin cậy khi xét thầu',
      vendor_portal_request: 'Quá thời hạn trả lời thì đánh giá hoặc yêu cầu bị chốt thiếu ý kiến nhà thầu, có thể bị khiếu nại',
      vendor_remediation: 'Rủi ro tiến độ và chất lượng của nhà thầu không được xử lý, đánh giá sau của nhà thầu thấp đi',
    },
    why: {
      vendor_link_lead: 'Kiểm toán cần biết đầu tiên nơi các dấu hiệu chồng lên nhau; tín hiệu chỉ để xem xét, không phải kết luận',
      vendor_screening_hit: 'Danh sách bên bị cấm đổi hằng ngày; hồ sơ nhà thầu đã đăng ký phải được so khớp liên tục chứ không chỉ khi đấu thầu',
      vendor_reconfirm: 'Cần tái xác nhận hằng năm để hồ sơ không cũ đi mà không ai biết',
      vendor_portal_request: 'Nhà thầu có quyền trả lời trong thời hạn luật định và hệ thống phải giữ đồng hồ đó',
      vendor_remediation: 'Kế hoạch khắc phục chỉ có ích khi từng hành động có hạn và có người xác minh',
    },
  },
  kpi: {
    source: 'Sổ đầu mối, kết quả sàng lọc, yêu cầu cổng nhà thầu và tái xác nhận của mô-đun VND; chỉ số khởi điểm theo báo cáo nghiên cứu nhà thầu, chưa kiểm chứng.',
    lead_precision: {
      name: 'Tỷ lệ đầu mối đúng',
      formula: 'Số đầu mối được xác nhận hoặc chuyển điều tra chia cho số đầu mối đã được quyết (xác nhận, chuyển, bị xóa)',
      numerator: 'Đầu mối được xác nhận hoặc chuyển điều tra',
      denominator: 'Đầu mối đã được quyết',
    },
    lead_open: { name: 'Đầu mối đang mở', formula: 'Số đầu mối ở trạng thái mới, đang xem xét hoặc đề nghị xóa', numerator: 'Đầu mối đang mở', denominator: 'Không có' },
    screening_in_time: {
      name: 'Kết quả khớp được quyết đúng hạn',
      formula: 'Số kết quả khớp được quyết trong decide_within_days ngày chia cho số kết quả khớp đã quyết cộng quá hạn chưa quyết',
      numerator: 'Kết quả khớp được quyết đúng hạn',
      denominator: 'Kết quả khớp đã quyết cộng quá hạn',
    },
    portal_response_in_time: {
      name: 'Yêu cầu được nhà thầu trả lời đúng hạn',
      formula: 'Số yêu cầu được trả lời trong hạn chia cho số yêu cầu đã trả lời cộng quá hạn chưa trả lời',
      numerator: 'Yêu cầu trả lời đúng hạn',
      denominator: 'Yêu cầu đã trả lời cộng quá hạn',
    },
    reconfirmation_current: {
      name: 'Nhà thầu có hồ sơ được xác nhận lại còn hạn',
      formula: 'Số nhà thầu đã xác minh có hạn xác nhận lại chưa quá hạn chia cho số nhà thầu đã xác minh',
      numerator: 'Nhà thầu có xác nhận còn hạn',
      denominator: 'Nhà thầu đã xác minh',
    },
  },
  home: {
    lead_title: 'Đầu mối {kind}: {count} nhà thầu, hạng {rank}',
    lead_detail: 'Phát hiện ngày {since}, trạng thái {status}',
    screening_title: 'Kết quả khớp danh sách {source} với nhà thầu {name}',
    screening_detail: 'Điểm {score}, căn cứ {basis}; {hold}',
    screening_hold: 'đang tạm giữ giao dịch',
    screening_no_hold: 'chưa tạm giữ',
    reconfirm_title: 'Nhà thầu {name} chưa xác nhận lại hồ sơ',
    reconfirm_detail: 'Hạn xác nhận {due}',
    request_title: 'Yêu cầu {kind} gửi nhà thầu {name}',
    request_detail: 'Hạn trả lời {due}, trạng thái {status}',
    remediation_title: 'Hành động khắc phục quá hạn của nhà thầu {name}',
    remediation_detail: 'Hạn {due}: {action}',
  },
} as const;

const PLACE = /\{([A-Za-z0-9_]+)\}/g;

/** Fills the `{name}` places of a text of this module; a place without a value is a mistake of the code and fails loudly. */
export function vnd3Fill(text: string, params: Readonly<Record<string, string | number>>): string {
  return text.replace(PLACE, (_place, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`vnd3 text needs ${name}`);
    return String(value);
  });
}
