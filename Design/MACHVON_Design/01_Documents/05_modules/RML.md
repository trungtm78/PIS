# RML — Gửi biểu mẫu báo cáo qua email theo lịch và bảng điều hành lãnh đạo (chỉ bản doanh nghiệp)

Đặc tả phân hệ của lane ENT-4d (HSKT BC.02: "hỗ trợ gửi báo cáo tự động qua email theo lịch", tỷ lệ giải ngân so kế hoạch năm theo Tổng công ty/đơn vị/dự án, so sánh cùng kỳ năm trước; CN.03: dự án vướng thủ tục, chỉ đạo quá hạn). Mã nằm ở `packages/edition-enterprise/src/{delivery,leader}`, `apps/api/src/editions/enterprise`, `apps/web/src/editions/enterprise/screens/{mail,leader}`; bản công khai từ chối mã phân hệ `RML` và `LDR` (`ENTERPRISE_ONLY_MODULES`).

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Lãnh đạo cần nhận biểu mẫu đã phát hành đúng lịch, kèm tệp phát hành thật và mã băm để đối chiếu; và cần thấy trên màn hình điều hành tỷ lệ giải ngân so với kế hoạch năm của bản chốt enterprise cùng so sánh cùng kỳ năm trước.

**Trong phạm vi.** Lịch gửi (cron múi giờ Việt Nam, định dạng XLSX/DOCX/PDF, 1 đến 50 thành viên, ghi chú); nhật ký gửi theo (lịch, bản phát hành, người nhận); kênh gửi là cổng kênh email chung (`ChannelAdapter`, adapter SMTP do ENT-4c); tỷ lệ theo Tổng công ty, đơn vị, dự án đọc qua `EnterpriseFigureReader`; ô "dự án vướng thủ tục"; chế độ trình chiếu của các bảng điều hành (thành phần web dùng chung).

**Ngoài phạm vi.** Bộ gửi SMTP (ENT-4c); dựng PDF của biểu mẫu (ENT-4b: không có thì lịch PDF bỏ qua bản phát hành với mã `FORMAT_UNAVAILABLE`); địa chỉ ngoài hệ thống.

## 2. Actor, tenant và phạm vi quyền

Người lập lịch (`rpt.mail.manage`) và người đọc (`rpt.mail.read`) có quyền trên toàn tenant; mỗi biểu mẫu còn chịu bộ bảo vệ riêng của biểu mẫu (`layoutReadable`). Bảng điều hành lãnh đạo đọc theo phạm vi dự án của người đọc (`home.read`). Một tenant, không tạo tenant theo đơn vị.

## 3. Luồng nghiệp vụ

Lập lịch, đến giờ job `report-mail-runner` gửi các bản phát hành mới, nhật ký ghi từng thư; người lập lịch xem nhật ký trên RML-01 và chấm dứt lịch khi không cần.

## 4. State machine

Lịch: ACTIVE rồi RETIRED (cuối cùng). Dòng nhật ký: SENDING rồi SENT, FAILED (thử lại), REFUSED, UNKNOWN hoặc SKIPPED; trạng thái cuối không đổi (trigger của cơ sở dữ liệu).

## 5. Quy tắc nghiệp vụ và công thức

1. Lịch không sửa được; muốn đổi thì chấm dứt (kèm lý do) và lập lịch khác. Người nhận phải là thành viên đang hoạt động của tenant; địa chỉ email được đọc khi gửi và không lưu.
2. Lịch chỉ gửi bản phát hành sau khi lịch được lập; mỗi (lịch, bản phát hành, người nhận) gửi tối đa một lần; bản dựng trên mẫu DEMO không bao giờ được gửi (R18).
3. Dòng nhật ký được ghi trước khi gọi kênh (SENDING) rồi chốt: SENT, FAILED (thử lại tối đa 3 lần), REFUSED, UNKNOWN (mất kết quả: không gửi lại tự động), SKIPPED. SENDING quá 15 phút chốt UNKNOWN.
4. Quyền của người nhận được xét lại ở mỗi lần gửi; tệp đính kèm là tệp phát hành, kiểm băm trước khi gửi; mã băm có trong nội dung thư.
5. Tỷ lệ của một nhóm là tổng đã giải ngân chia tổng kế hoạch của nhóm; chênh lệch tính bằng điểm phần trăm; số liệu không có thì nêu lý do, không bao giờ là 0. Bản công khai không có thao tác này nên tỷ lệ HOME-01/HOME-09 không đổi.
6. Dự án vướng thủ tục: giấy phép quá hạn quyết định (PMT), vướng mắc mức cao chưa xử lý quá hạn (ISS), đền bù đến hạn chưa chi (LND), gói thầu đứng yên từ 14 ngày (BID); đếm theo dự án. Định nghĩa là đề xuất chờ chủ quy trình ký.

## 6. Dữ liệu

Bảng `report_mail_schedule` và `report_mailing` (migration V2820, RLS bắt buộc, không xóa). Tỷ lệ và dự án vướng thủ tục không có bảng riêng: đọc từ bản chốt enterprise (ENT-3a) và sổ của PMT, ISS, LND, BID.

## 7. API / command

`listReportMailSchedules`, `listReportMailings` (`rpt.mail.read`), `createReportMailSchedule`, `retireReportMailSchedule` (`rpt.mail.manage`), `getLeaderRates`, `getBlockedProjects` (`home.read`). Việc `report-mail-runner` chạy mỗi phút.

## 8. UI/UX

RML-01: lịch gửi và nhật ký gửi. Bảng điều hành lãnh đạo là khe `leaderPanel` của bản doanh nghiệp trên HOME-09 và BAN-01.

## 9. Sự kiện, job, tích hợp, quan sát

Sự kiện `rpt.mail_schedule.created.v1`, `rpt.mail_schedule.retired.v1`; job `report-mail-runner`; số đo `report_mailing_sent_total`, `report_mailing_failed_total`, `report_mailing_blocked_total`, `leader_rate_null_total`.

## 10. Kiểm thử

Kiểm thử thuần ở `packages/edition-enterprise/src/{delivery,leader}`, kiểm thử màn hình ở `apps/web/src/editions/enterprise/screens`. 

## 11. Tiêu chí nghiệm thu (đo được)

Một thư cho mỗi (lịch, bản phát hành, người nhận) dù job chạy hai lần; bản DEMO bị bỏ qua có lý do; tỷ lệ nhóm bằng tổng trên tổng; số liệu không có không bao giờ hiển thị 0.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

R1: toàn bộ mục trên. R2+: thử trên máy chủ email thật, mẫu Sở/Ban/Ngành (ENT-4b), nhắc việc qua Teams (ENT-4c).

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

Thử trên máy chủ email thật của khách (PENDING-EXTERNAL); quyền `rpt.mail.*` gán vào vai trò qua bộ quyền của tenant.
