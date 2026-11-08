/**
 * The Vietnamese texts of the governance rule of lane PORTAL-2 (access of a contractor to the portal through the registry, and the limits of a portal upload). A module (not the JSON catalogue) because the pure rules are
 * imported by the browser, where the catalogue cannot be read.
 */
export const PORTAL2_TEXT = {
  rules_source:
    'Điều 16 Luật Đấu thầu 22/2023 (hành vi bị cấm), Điều 19, 20 Nghị định 214/2025/NĐ-CP (quyền của nhà thầu được biết và phản hồi), kiểm soát truy cập và hai người phê duyệt của hệ thống; các con số là lựa chọn khởi đầu của chúng tôi, chưa được đối chiếu với văn bản pháp luật',
  formula: {
    portal_access:
      'Lời mời vào cổng nhà thầu gắn với hồ sơ nhà thầu đã được xác minh, không gắn với hợp đồng: một người đề xuất kèm bằng chứng đầu mối thuộc nhà thầu (địa chỉ thư điện tử trong hồ sơ hoặc số hiệu giấy tờ), người khác phê duyệt; đề xuất hết hạn sau proposal_days ngày, quyền truy cập hết hạn sau access_days ngày, mỗi nhà thầu có tối đa max_live_accounts tài khoản đang hiệu lực; tệp tải lên không quá max_upload_bytes byte',
  },
} as const;
