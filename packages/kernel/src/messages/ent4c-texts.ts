/**
 * The Vietnamese words of the reporting schedule rule and of its alert types (lane ENT-4c, QT.02): a module (not the JSON catalogue) because the pure rules of the lane also run in the browser, where the catalogue cannot be read.
 */
export const ENT4C_TEXT = {
  schedule_formula:
    'Hạn của từng bước (nhập liệu, đơn vị duyệt, Ban KHĐT rà soát, chốt kỳ, đẩy hệ thống) bằng ngày cuối của kỳ (ngày họp với giao ban) cộng số ngày của bước, lúc giờ của bước (không ghi thì theo giờ hạn của lịch kỳ), theo múi giờ của lịch. Nhắc trước hạn theo các mốc số ngày đã ghi, nhắc quá hạn cách nhau số ngày đã ghi tối đa số lần đã ghi, và báo lãnh đạo đơn vị một lần khi quá hạn đủ số ngày quy định.',
  schedule_source:
    'Yêu cầu QT.02 của hồ sơ kỹ thuật PVFCCo (thiết lập lịch kỳ tháng, quý, năm, giao ban với thời hạn từng bước; nhắc việc và cảnh báo quá hạn); các con số là giá trị khởi đầu chưa được chủ nghiệp vụ xác nhận (D03)',
  alert_source: 'Lịch kỳ báo cáo (QT.02, ENT-4c)',
  due_soon_action: 'Hoàn thành bước của kỳ báo cáo trước hạn: nhập, duyệt, rà soát, chốt hoặc đẩy số liệu theo bước được nhắc.',
  due_soon_consequence: 'Quá hạn, đầu mối bị đánh dấu chậm kỳ, báo cáo kỳ có thể phải gửi muộn và lãnh đạo đơn vị sẽ được báo.',
  due_soon_why: 'Người giữ bước cần biết trước hạn còn bao lâu để hoàn thành mà không phải chạy gấp.',
  overdue_action: 'Hoàn thành ngay bước đã quá hạn của kỳ báo cáo, hoặc ghi lý do chậm cho người phụ trách.',
  overdue_consequence: 'Các bước sau của kỳ bị dồn lại, kỳ không chốt đúng hạn và báo cáo tổng hợp thiếu số liệu của đầu mối.',
  overdue_why: 'Một bước chậm làm chậm cả chuỗi chốt kỳ; nhắc lặp lại cho tới khi bước xong hoặc có lý do.',
  escalated_action: 'Lãnh đạo đơn vị làm việc với người giữ bước đã quá hạn nhiều ngày và quyết định cách xử lý.',
  escalated_consequence: 'Kỳ báo cáo không thể chốt khi thiếu số liệu của đầu mối; Ban KHĐT sẽ ghi nhận đầu mối chậm.',
  escalated_why: 'Quá hạn kéo dài cần người có thẩm quyền của đơn vị can thiệp.',
} as const;
