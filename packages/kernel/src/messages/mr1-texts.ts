/**
 * The Vietnamese texts of the governance rules and alert types of lane MR-1 (the risk register scored from live signals, MR.02; the post-investment effectiveness, MR.03): a module (not the JSON catalogue) because the
 * pure rules of the lane also run in the browser, where the catalogue cannot be read.
 */
export const TEXT = {
  risk_policy_formula:
    "Mỗi chỉ báo của một loại tín hiệu (độ trễ tiến độ, toàn vẹn thanh toán, khiếu nại và cảnh báo sớm, thiếu vốn, chậm đấu thầu) được so với bốn ngưỡng tăng dần: dưới ngưỡng 1 thì khả năng bằng 1, đạt ngưỡng 1 đến 4 thì khả năng bằng 2 đến 5. Khả năng của loại tín hiệu là mức cao nhất trong các chỉ báo đã biết (chỉ báo chưa biết không tính là 0). Điểm bằng khả năng nhân tác động (tác động cố định theo loại, thang 1 đến 5). Dòng rủi ro mở khi khả năng đạt mức mở từ; cảnh báo phát khi điểm vượt ngưỡng nghiêm trọng hoặc tăng nhanh bằng số điểm quy định trong một lần chấm.",
  risk_policy_source:
    "Thang 5x5 của sổ rủi ro dự án (PRJ-16, BR-PRJ-07) và nghiên cứu nội bộ về tín hiệu sớm của dự án; các ngưỡng là giá trị khởi đầu chưa được chủ nghiệp vụ xác nhận",
  effect_policy_formula:
    "Mức đạt bằng (thực tế trừ cơ sở) chia (mục tiêu trừ cơ sở) nhân 100 khi chỉ tiêu có giá trị cơ sở; không có cơ sở thì lấy thực tế chia mục tiêu nhân 100 (chỉ tiêu càng thấp càng tốt thì lấy mục tiêu chia thực tế nhân 100). Đạt khi mức đạt từ ngưỡng đạt, đạt một phần khi từ ngưỡng một phần, còn lại là chưa đạt. Chênh lệch bằng thực tế trừ mục tiêu; chênh lệch phần trăm bằng chênh lệch chia giá trị tuyệt đối của mục tiêu nhân 100.",
  effect_policy_source:
    "Theo dõi hiệu quả sau đầu tư (MR.03, G4-7): chỉ tiêu mục tiêu được chốt khi phê duyệt đầu tư và so với số đo thực tế sau khi đưa vào vận hành; các ngưỡng là giá trị khởi đầu chưa được chủ nghiệp vụ xác nhận",
  calendar_formula:
    "Ngày đến hạn của mỗi lần đánh giá bằng ngày mốc (bắt đầu thực hiện, hoàn thành hoặc bàn giao đã nghiệm thu) cộng số tháng của quy tắc theo nhóm dự án. Dự án quan trọng quốc gia và nhóm A có đủ bốn loại đánh giá (ban đầu, giữa kỳ, kết thúc, tác động); nhóm B và C có đánh giá kết thúc và đánh giá tác động.",
  calendar_source:
    "Luật Đầu tư công số 58/2024/QH15, Điều 76 và Điều 77 (theo lộ trình quản trị G4-7); số tháng là giá trị mặc định CHƯA KIỂM CHỨNG với văn bản gốc, cần chủ nghiệp vụ xác nhận trước khi dùng làm căn cứ pháp lý",
  alert_source: "Sổ rủi ro chấm từ tín hiệu thật của hệ thống (MR-1, MR.02)",
  alert_critical_action: "Xem tín hiệu rủi ro của dự án, ghi nhận phản ứng (giảm nhẹ, chuyển cấp hoặc chấp nhận có lý do) và xác nhận cảnh báo",
  alert_critical_consequence: "Dự án có điểm rủi ro ở mức nghiêm trọng mà chưa ai phản ứng; cảnh báo còn nguyên cho đến khi điểm xuống dưới ngưỡng",
  alert_critical_why: "Điểm rủi ro đã vượt ngưỡng nghiêm trọng của quy tắc từ tín hiệu thật của hệ thống, không phải từ ý kiến chủ quan",
  alert_jump_action: "Xem điều gì làm điểm rủi ro tăng nhanh và quyết định có cần nâng mức theo dõi không",
  alert_jump_consequence: "Điểm tăng nhanh mà không ai xem có thể thành nghiêm trọng trước kỳ báo cáo kế tiếp",
  alert_jump_why: "Điểm tăng nhanh trong một lần chấm báo hiệu một thay đổi đột ngột của dự án",
} as const;
