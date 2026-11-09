# PWA — Ứng dụng cài đặt cho lãnh đạo: phê duyệt, bảng điều hành, chỉ đạo, cài đặt

Đặc tả phân hệ của lane PWA2 theo `_KHUNG_DAC_TA.md`, đáp ứng yêu cầu khách hàng **YCK.01** (ứng dụng cho lãnh đạo: (i) hàng đợi phê duyệt số liệu kỳ kèm tóm tắt, duyệt hoặc trả lại có ý kiến; (ii) bảng điều hành của lãnh đạo; (iii) theo dõi chỉ đạo; cài đặt được; thông báo đẩy; đăng nhập một lần có xác thực hai bước ngoài mạng nội bộ). Ứng dụng là cửa thứ hai của chính ứng dụng web (`apps/web`, đường dẫn `/m`) cho người không cài ứng dụng điện thoại; ứng dụng Flutter vẫn giữ. Các màn hình PWA không có thao tác nào mà màn hình web hoặc ứng dụng điện thoại tương ứng không có: cùng thao tác, cùng quyền, cùng số liệu.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Lãnh đạo cần quyết định và nắm tình hình ngay trên điện thoại, kể cả khi không cài ứng dụng điện thoại, mà không để số liệu nghiệp vụ nằm lại trong bộ nhớ của trình duyệt.

**Trong phạm vi.** Chín màn hình ở độ rộng 360 px, một cột: trang chủ (PWA-01), hàng đợi phê duyệt (PWA-02), bảng điều hành (PWA-03), theo dõi chỉ đạo (PWA-04), chi tiết phê duyệt (PWA-05), chi tiết chỉ đạo (PWA-06), cài đặt (PWA-07), chi tiết số liệu bảng điều hành (PWA-08, bản cho điện thoại của hướng đi sâu từ HOME-09), tiến độ đấu thầu (PWA-09, bản cho điện thoại của BID-27); trình phục vụ (service worker) chỉ giữ vỏ ứng dụng và tệp tĩnh, không giữ phản hồi API; thông báo đẩy chỉ mang tiêu đề chung và đường dẫn.

**Ngoài phạm vi.** Mở tệp bằng chứng trên điện thoại (hợp đồng API chưa có thao tác tải tệp báo cáo; màn hình liệt kê tên, loại, dung lượng và đầu của mã băm); ghi tiến độ, gia hạn, đóng chỉ đạo (ở DIR-04); xác nhận bằng thông báo (quyết định không bao giờ gửi từ thông báo).

**Phụ thuộc.** IAM (phiên, thiết bị, xác thực bước hai), ADM (nhiệm vụ phê duyệt), DIS (bản báo cáo kỳ), DIR (chỉ đạo), HOME (trung tâm điều hành), BID (tiến độ quy trình đấu thầu), NOT (tùy chọn nhận tin).

**Căn cứ.** Yêu cầu khách hàng YCK.01; `docs/pwa.md`; MOB-23, MOB-24 (nội dung chi tiết phê duyệt).

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Lãnh đạo, người phê duyệt | Phạm vi của thành viên | `approval_task.read` xem hàng đợi và chi tiết; `approval.decide` duyệt hoặc trả lại | Tự duyệt việc do mình lập (`SELF_APPROVAL_DENIED`); quyết định khi tổ chức ở chế độ chỉ đọc |
| Người đọc bảng điều hành | Phạm vi đơn vị | `home.read`, `bid.read` | Xem số liệu ngoài phạm vi (thẻ nói phạm vi bị ẩn, không nêu tên) |
| Người dùng đã đăng nhập | Của chính mình | Xem phiên, thiết bị, đổi ngôn ngữ, tùy chọn thông báo; kết thúc phiên khác, gỡ thiết bị | Kết thúc phiên hiện tại (đăng xuất) bằng thao tác thu hồi |

## 3. Luồng nghiệp vụ

### 3.1 Phê duyệt số liệu kỳ (UC-PWA-01) — PWA-02, PWA-05
1. Hàng đợi (`get_resources_approval_task`, `mine=true`, `status=Pending`): việc quá hạn trước; tên dự án và đơn vị thay cho mã.
2. Chi tiết (`get_resources_approval_task_id`, `getReportRevision`, bản báo cáo trước, `get_resources_approval_task?workflow_instance_id`): nội dung, so sánh với kế hoạch và kỳ trước theo sáu ô nguồn vốn, so sánh với lần báo cáo đã sửa, bằng chứng, lịch sử các bước. Mỗi phần là một quyền riêng: bị từ chối thì bỏ phần đó và nói rõ lý do, mất kết nối thì báo lỗi.
3. Quyết định (`decideApprovalTask`): một yêu cầu khi đang trực tuyến, kèm `If-Match` phiên bản việc, xác thực bước hai (aal2) hỏi ngay tại chỗ, khóa chống gửi lặp; trả lại bắt buộc có ý kiến; xung đột phiên bản hoặc việc đã có người quyết định thì tải lại rồi quyết định lại.

### 3.2 Bảng điều hành và hướng đi sâu (UC-PWA-02) — PWA-03, PWA-08, PWA-09
Cùng nguồn, cùng mô hình với HOME-09 và BID-27 (`getCommandCenter`, `getPackageProcessTree`, `listPackageProcessTreeNodePackages`); số liệu chưa có thì nói rõ, không hiện 0; số liệu thuộc về bản chốt đang xem, bản chốt mới được mời chứ không tự áp dụng.

### 3.3 Theo dõi chỉ đạo (UC-PWA-03) — PWA-04, PWA-06
`listDirectives` (lọc theo trạng thái, quá hạn, đơn vị; phân trang), `getDirectiveSummary`, `getDirective`. Đồng hồ (`phase`, `days_to_due`, `overdue_days`) do máy chủ tính; tiến độ lấy từ sự kiện tiến độ mới nhất của dòng thời gian, chưa báo cáo thì nói rõ, không hiện 0%. Nội dung chỉ đạo chỉ hiện trong ứng dụng, không đưa vào thông báo.

### 3.4 Cài đặt (UC-PWA-04) — PWA-07
`listMySessions`, `listMyDevices`, `revokeMySession`, `revokeMyDevice` (lý do tối thiểu 10 ký tự), `getMyProfile` và `updateMyProfile` (ngôn ngữ, kèm phiên bản hồ sơ), `getMyNotificationPreferences` và `updateMyNotificationPreferences` (kèm phiên bản; kênh bắt buộc của nhóm khẩn không tắt được; giờ yên lặng không được trùng nhau).

## 4. State machine
Không có máy trạng thái riêng: trạng thái của nhiệm vụ phê duyệt thuộc ADM, của chỉ đạo thuộc DIR.

## 5. Quy tắc nghiệp vụ và công thức
- Tỷ lệ so với kế hoạch = lũy kế kỳ này / kế hoạch giao, làm tròn đến 0,1%, tính bằng số nguyên lớn; kế hoạch bằng 0 thì không tính tỷ lệ.
- Thay đổi so với kỳ trước = lũy kế kỳ này trừ lũy kế kỳ trước của từng ô, có dấu; CTMTQG nằm trong các ô, không cộng thêm.
- Ngưỡng nhắc việc và leo thang của chỉ đạo là cấu hình mặc định chưa được khách hàng xác nhận; màn hình ghi rõ khi chính sách chưa xác nhận.

## 6. Dữ liệu
Không có bảng mới. Trình duyệt chỉ giữ vỏ ứng dụng và tệp tĩnh; đăng xuất hoặc hết phiên xóa mọi bộ nhớ đệm, hủy đăng ký thông báo và quên bản ghi thiết bị.

## 7. API / command
Chỉ dùng thao tác đã có (xem các mục 3.1 đến 3.4); không thêm thao tác. Thiết bị web là thiết bị nền tảng `web` của `registerDevice`.

## 8. UI/UX
Một cột, 360 px, không cuộn ngang; mọi điều khiển cao tối thiểu 44 px; tờ quyết định nằm ở đáy màn hình; màu không phải tín hiệu duy nhất (nhãn chữ cho quá hạn, đã leo thang); bảy trạng thái chuẩn của `design.md`; `aria` cho danh sách, tiến độ và hộp thoại.

## 9. Sự kiện, job, tích hợp, quan sát
Thông báo đẩy qua kênh `PUSH_FCM` (thiết bị `web`), tiêu đề chung và đường dẫn mờ `/r/{id}`; kênh vẫn là MOCK cho đến khi thử với dịch vụ đẩy thật.

## 10. Kiểm thử
Vitest từng màn hình (`apps/web/src/pwa/screens/*.test.tsx`): trạng thái, quyền, If-Match, khóa chống gửi lặp, so sánh số liệu, axe, mục tiêu chạm; kiểm hợp đồng CSS cho 360 px; `apps/web/e2e/pwa-flows.spec.ts` (viết, chưa chạy trong lane). Mã kiểm thử: UI-PWA-01 đến UI-PWA-09.

## 11. Tiêu chí nghiệm thu (đo được)
1. Mở một việc từ hàng đợi thấy tên dự án, kỳ, đơn vị, số liệu so với kế hoạch và kỳ trước, bằng chứng, lịch sử các bước, rồi duyệt hoặc trả lại trong một lần gửi.
2. Bộ lọc chỉ đạo theo trạng thái, quá hạn, đơn vị gửi đúng truy vấn tới máy chủ; số liệu tổng hợp lỗi được nói rõ.
3. Hai hướng đi sâu (PWA-08, PWA-09) dùng đúng số liệu của HOME-09 và BID-27.
4. Cài đặt thay đổi được ngôn ngữ, tùy chọn thông báo theo nhóm và kết thúc được phiên khác kèm lý do.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+
R2: toàn bộ chín màn hình. Sau R2: mở tệp bằng chứng trên điện thoại khi có thao tác tải tệp báo cáo; thử với dịch vụ đẩy thật (VERIFIED).

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba
- Chưa chạy trên trình duyệt thật ở 360 px (lane không có trình duyệt): bố cục được ghim bằng kiểm thử CSS, cần UAT trên máy thật.
- Lịch sử các bước chỉ gồm các nhiệm vụ mà máy chủ cho người đọc thấy.
- Dịch vụ đẩy của trình duyệt (FCM, Mozilla, Apple, Windows) cần thử nghiệm thật trước khi bật kênh.
