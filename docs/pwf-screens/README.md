# Ảnh chụp màn hình phần workflow dự án (PWF), bản công

Web: chụp lại ngày 14/11/2026 từ nhánh `lane/pwf6` (đã gộp `lane/pwf5`) trên ứng dụng chạy thật: API trên PostgreSQL nhúng, seed `clip-seed --dataset public` chạy trọn trên một stack sạch (gồm nhóm `clip-public-pwf-review`), web chạy ở chế độ development, Chromium của Playwright 1440×900, ảnh toàn trang. Không có ảnh mock.

Điện thoại: chụp lại ngày 14/11/2026 từ nhánh `lane/mob7`, từng tab một, xem mục "Điện thoại" ở cuối tệp.

## Việc đã tự kiểm trên ảnh

Trong 37 ảnh web, tôi đã mở xem 10 ảnh (ghi ở cột cuối). Năm ảnh trong số đó tôi xem ở bản chụp trước lần sửa cuối, rồi sửa và chụp lại mà chưa mở xem lại; 27 ảnh còn lại chưa mở xem. Với cả 37 ảnh, kịch bản chụp đo được: trang không cuộn ngang ở 1440 px và không có lỗi JavaScript. Năm màn (ba tab của workflow, bảng deadline, chi tiết việc) được đo thêm ở 390 px: không cuộn ngang.

Kiểm tra seed: `clip-seed verify` báo FAILED vì một phép kiểm không thuộc PWF ("egp obligations due soon: 0 is below 1"); các phép kiểm khác đạt. Nhóm `clip-public-pwf-review` chạy trọn (496 lệnh, không lệnh nào bị từ chối).

## PRJ-02 · Đăng ký dự án, mục "Loại quy trình xử lý"

| Ảnh | Mã màn | Đang hiển thị | Ghi chú của lượt chụp và việc đã xem |
|---|---|---|---|
| [`web/01-PRJ-02-dang-ky-du-an-loai-quy-trinh.png`](web/01-PRJ-02-dang-ky-du-an-loai-quy-trinh.png) | PRJ-02 | Đăng ký dự án: mục "Loại quy trình xử lý" với đề xuất, lý do, và xem trước lịch sau khi nhập ngày dự định bắt đầu | Đã mở xem. Khối đề xuất, bốn ô chọn thẳng hàng, thẻ xem trước; bảng từng bước thu gọn nên thanh nút không còn che. Còn thấy: ô ngày hiện dạng tháng/ngày/năm (theo Chromium của máy chụp, không phải của sản phẩm); thẻ "Loại quy trình xử lý" lồng trong thẻ "Thông tin dự án". |

## PWF-01, PWF-02, PWF-05 · Thư viện mẫu, trình soạn (theo tab), khởi tạo workflow

| Ảnh | Mã màn | Đang hiển thị | Ghi chú của lượt chụp và việc đã xem |
|---|---|---|---|
| [`web/10-PWF-01-thu-vien-mau.png`](web/10-PWF-01-thu-vien-mau.png) | PWF-01 | Thư viện mẫu workflow | Chưa mở xem. |
| [`web/11-PWF-01-so-sanh-hai-phien-ban.png`](web/11-PWF-01-so-sanh-hai-phien-ban.png) | PWF-01 | So sánh có cấu trúc hai phiên bản của mẫu CB_ROAD_REPAIR | Đã mở xem bản chụp trước lần sửa cuối: bảng quy mô hai bản và từng thay đổi đọc được. Ở bản đó ô tiêu đề của bảng chi tiết bị nền đậm chữ mờ; đã sửa CSS rồi chụp lại, ảnh hiện tại chưa mở xem lại. |
| [`web/12-PWF-02-tab-cau-truc.png`](web/12-PWF-02-tab-cau-truc.png) | PWF-02 | Trình soạn, tab Cấu trúc: giai đoạn và cây Giai đoạn → Bước → Việc, đang chọn một việc | Đã mở xem (cỡ thu nhỏ). Cây Giai đoạn → Bước → Việc, chỉ còn 6 KPI của workflow, có khối chọn biểu mẫu từ kho. Còn thấy: biểu mẫu soạn một việc vẫn là một cột dài; các ô đánh dấu lệnh bị chặn của giai đoạn xếp chưa thẳng hàng. |
| [`web/13-PWF-02-tab-buoc-va-can-cu.png`](web/13-PWF-02-tab-buoc-va-can-cu.png) | PWF-02 | Trình soạn, tab Bước và căn cứ pháp lý | Chưa mở xem. |
| [`web/14-PWF-02-tab-kiem-tra-xem-truoc.png`](web/14-PWF-02-tab-kiem-tra-xem-truoc.png) | PWF-02 | Trình soạn, tab Kiểm tra và xem trước lịch (đã bấm xem trước) | Chưa mở xem. |
| [`web/15-PWF-05-khoi-tao-tiep-nhan-workflow.png`](web/15-PWF-05-khoi-tao-tiep-nhan-workflow.png) | PWF-05 | Khởi tạo hoặc tiếp nhận workflow cho dự án DA-CN026 | Chưa mở xem. |

## PRJ-03 (tab Workflow) và PWF-03 · Workflow của dự án, mỗi tab một ảnh

| Ảnh | Mã màn | Đang hiển thị | Ghi chú của lượt chụp và việc đã xem |
|---|---|---|---|
| [`web/20-PRJ-03-workflow-tab-tong-quan.png`](web/20-PRJ-03-workflow-tab-tong-quan.png) | PRJ-03 | Workflow của DA-PWF-02, tab Tổng quan | Đã mở xem. Còn thấy: dải giai đoạn ghi "Đang ở đây" cho ba giai đoạn cùng lúc (dữ liệu `open` của máy chủ, không phải bố cục). |
| [`web/21-PRJ-03-workflow-tab-cong-viec.png`](web/21-PRJ-03-workflow-tab-cong-viec.png) | PRJ-03 | Tab Công việc: cây Giai đoạn → Bước → Việc và quy trình theo bước | Đã mở xem bản chụp trước lần sửa cuối (cỡ thu nhỏ): bảng cây đủ ba tầng với tiến độ. Ở bản đó khối "Quy trình theo bước" bên dưới mở sẵn mọi giai đoạn làm tab dài; đã cho thu gọn mặc định rồi chụp lại, ảnh hiện tại chưa mở xem lại. |
| [`web/22-PRJ-03-workflow-tab-lich.png`](web/22-PRJ-03-workflow-tab-lich.png) | PRJ-03 | Tab Lịch: Gantt có trục thời gian | Đã mở xem bản chụp trước lần sửa cuối: trục tháng, nhãn cố định, đường hôm nay, đường cơ sở, phần trễ kèm số ngày. Ở bản đó nhãn tháng bị cắt ("Tháng 08/202"); đã đổi sang dạng ngắn khi cột hẹp rồi chụp lại, ảnh hiện tại chưa mở xem lại. |
| [`web/23-PRJ-03-workflow-tab-moc-va-cong.png`](web/23-PRJ-03-workflow-tab-moc-va-cong.png) | PRJ-03 | Tab Mốc và cổng | Chưa mở xem. |
| [`web/24-PRJ-03-workflow-tab-bang-cot.png`](web/24-PRJ-03-workflow-tab-bang-cot.png) | PRJ-03 | Tab Bảng cột | Chưa mở xem. |
| [`web/25-PWF-03-mau-cua-tinh-tab-cong-viec.png`](web/25-PWF-03-mau-cua-tinh-tab-cong-viec.png) | PWF-03 | Workflow của DA-PWF-04 (mẫu của tỉnh), tab Công việc | Chưa mở xem. |
| [`web/26-PWF-03-mau-cua-tinh-tab-lich.png`](web/26-PWF-03-mau-cua-tinh-tab-lich.png) | PWF-03 | Workflow của DA-PWF-04, tab Lịch | Đã mở xem bản cuối: nhãn tháng đủ chữ, nhãn việc cố định bên trái, đường hôm nay, phần trễ gạch đỏ kèm số ngày, đường găng viền đậm, chú giải. |

## PWF-04, PWF-16, PWF-06 · Chi tiết công việc (theo tab), sổ phân công, dời lịch

| Ảnh | Mã màn | Đang hiển thị | Ghi chú của lượt chụp và việc đã xem |
|---|---|---|---|
| [`web/30-PWF-04-viec-dang-lam-tab-viec-can-lam.png`](web/30-PWF-04-viec-dang-lam-tab-viec-can-lam.png) | PWF-04 | Việc đang làm, tab Việc cần làm (danh mục kiểm, chứng từ, biểu mẫu) | Đã mở xem bản chụp trước lần sửa cuối: đầu trang tóm tắt, tab, tên người và "Dự báo xong". Ở bản đó mã việc nằm cùng dòng với tên; đã cho xuống dòng rồi chụp lại, ảnh hiện tại chưa mở xem lại. |
| [`web/31-PWF-04-tab-can-cu-phap-ly.png`](web/31-PWF-04-tab-can-cu-phap-ly.png) | PWF-04 | Tab Căn cứ pháp lý | Chưa mở xem. |
| [`web/32-PWF-04-tab-lich-va-phan-cong.png`](web/32-PWF-04-tab-lich-va-phan-cong.png) | PWF-04 | Tab Lịch và phân công | Chưa mở xem. |
| [`web/33-PWF-04-tab-ngoai-le.png`](web/33-PWF-04-tab-ngoai-le.png) | PWF-04 | Tab Ngoại lệ | Chưa mở xem. |
| [`web/34-PWF-04-tab-lich-su.png`](web/34-PWF-04-tab-lich-su.png) | PWF-04 | Tab Lịch sử | Chưa mở xem. |
| [`web/38-PWF-16-so-phan-cong.png`](web/38-PWF-16-so-phan-cong.png) | PWF-16 | Sổ phân công của một việc | Chưa mở xem. |
| [`web/35-PWF-04-viec-cho-duyet-nguoi-duyet-xem.png`](web/35-PWF-04-viec-cho-duyet-nguoi-duyet-xem.png) | PWF-04 | Việc chờ duyệt hoàn thành, nhìn bằng tài khoản lãnh đạo | Đã mở xem bản cuối: tên việc, dòng mã và vị trí bên dưới, trạng thái, hạn đỏ kèm "Dự báo xong", người làm và người duyệt bằng tên, nút "Duyệt hoàn thành" và "Trả lại", năm tab; danh mục kiểm ghi tên người đánh dấu. |
| [`web/36-PWF-04-viec-da-xong-tab-lich-su.png`](web/36-PWF-04-viec-da-xong-tab-lich-su.png) | PWF-04 | Việc đã xong, tab Lịch sử | Chưa mở xem. |
| [`web/39-PWF-06-doi-lich.png`](web/39-PWF-06-doi-lich.png) | PWF-06 | Dời lịch của DA-PWF-01 (đề nghị đang chờ nếu có) | Chưa mở xem. |

## PWF-07, PWF-08, PWF-15 · Deadline ba màu (theo tab)

| Ảnh | Mã màn | Đang hiển thị | Ghi chú của lượt chụp và việc đã xem |
|---|---|---|---|
| [`web/40-PWF-07-tab-danh-sach.png`](web/40-PWF-07-tab-danh-sach.png) | PWF-07 | Bảng deadline, tab Danh sách | Đã mở xem (cỡ thu nhỏ): năm thẻ đếm một hàng, chip trạng thái, bảng không bị cắt, có dòng "Dự báo xong". |
| [`web/41-PWF-07-loc-mau-do.png`](web/41-PWF-07-loc-mau-do.png) | PWF-07 | Lọc màu đỏ bằng thẻ đếm | Chưa mở xem. |
| [`web/44-PWF-07-tab-lich-thang.png`](web/44-PWF-07-tab-lich-thang.png) | PWF-07 | Tab Lịch tháng | Chưa mở xem. |
| [`web/45-PWF-07-tab-moc-30-ngay.png`](web/45-PWF-07-tab-moc-30-ngay.png) | PWF-07 | Tab Mốc 30 ngày tới | Chưa mở xem. |
| [`web/46-PWF-07-tab-tai-cong-viec.png`](web/46-PWF-07-tab-tai-cong-viec.png) | PWF-07 | Tab Tải công việc | Chưa mở xem. |
| [`web/47-PWF-08-chinh-sach-ba-mau.png`](web/47-PWF-08-chinh-sach-ba-mau.png) | PWF-08 | Chính sách ba màu của đơn vị | Chưa mở xem. |
| [`web/48-PWF-15-nhac-han-cua-toi.png`](web/48-PWF-15-nhac-han-cua-toi.png) | PWF-15 | Nhắc hạn của tôi | Chưa mở xem. |

## PWF-09 đến PWF-14 · KPI và bảng điểm

| Ảnh | Mã màn | Đang hiển thị | Ghi chú của lượt chụp và việc đã xem |
|---|---|---|---|
| [`web/50-PWF-09-bo-kpi-workflow.png`](web/50-PWF-09-bo-kpi-workflow.png) | PWF-09 | Bộ KPI của workflow | Chưa mở xem. |
| [`web/51-PWF-10-chinh-sach-cham-diem.png`](web/51-PWF-10-chinh-sach-cham-diem.png) | PWF-10 | Chính sách chấm điểm | Chưa mở xem. |
| [`web/52-PWF-11-bang-diem-cua-toi.png`](web/52-PWF-11-bang-diem-cua-toi.png) | PWF-11 | Bảng điểm của tôi (Nguyễn Văn An) | Chưa mở xem. |
| [`web/53-PWF-11-bang-diem-cua-toi-co-dieu-chinh.png`](web/53-PWF-11-bang-diem-cua-toi-co-dieu-chinh.png) | PWF-11 | Bảng điểm của tôi (Phạm Quốc Dũng) | Chưa mở xem. |
| [`web/54-PWF-12-bang-diem-don-vi.png`](web/54-PWF-12-bang-diem-don-vi.png) | PWF-12 | Bảng điểm đơn vị | Chưa mở xem. |
| [`web/55-PWF-13-chi-tiet-diem.png`](web/55-PWF-13-chi-tiet-diem.png) | PWF-13 | Chi tiết điểm của một cán bộ | Chưa mở xem. |
| [`web/57-PWF-14-ky-cham-diem.png`](web/57-PWF-14-ky-cham-diem.png) | PWF-14 | Kỳ chấm điểm | Chưa mở xem. |

## Điện thoại (MOB-07, 09, 10, 32, 47, 78 đến 82), chụp lại theo tab

Chụp ngày 14/11/2026 từ nhánh `lane/mob7` trên ứng dụng chạy thật: API bản công trên PostgreSQL nhúng (cổng riêng), seed `clip-seed apply --dataset public` chạy trọn trên stack sạch (gồm nhóm `clip-public-pwf-review` và `clip-public-phone-work`), APK debug bản công dựng từ nhánh, AVD `guide` (720×1560, cỡ chữ 100%), đăng nhập bằng nhà cung cấp danh tính thử của stack (người thứ nhất: Nguyễn Văn An, chủ sở hữu, có việc được giao và có điểm), ảnh lấy bằng `adb exec-out screencap -p`. Không có ảnh mock và không có ảnh golden.

Cách dựng lại: `node uat/run/uat-2026-11-14-rerun/tools/start-public-stack.mjs <thư mục> <cổng API> <cổng IdP> <khóa phiên>` (chạy stack và seed); `flutter build apk --debug --dart-define=MACHVON_API_BASE_URL=http://127.0.0.1:<cổng API> --dart-define=MACHVON_OIDC_ISSUER=http://127.0.0.1:<cổng IdP>/realms/machvon --dart-define=MACHVON_OIDC_CLIENT_ID=machvon-web`; `emulator -avd guide`; `adb reverse` hai cổng; `adb install`; `adb shell cmd locale set-app-locales vn.machvon.app --locales vi-VN`; đăng nhập bằng `maestro test apps/mobile/qa/device/flows/06_sign_in_test_idp.yaml`; đi từng màn bằng `adb shell input` và chụp.

Trong 48 ảnh, tôi đã mở xem 31 ảnh, phần lớn ở bản chụp của một vòng trước (ghi rõ ở cột cuối: ứng dụng được dựng năm lần, mỗi lần sửa xong lại chụp lại cả bộ, và không phải ảnh nào của bộ cuối cũng được mở lại). Ảnh ghi "Chưa mở xem" là chưa mở ở vòng nào.

Không chụp được: tab Phê duyệt và chi tiết phê duyệt (MOB-23, 24). Hai màn này đặt cờ chặn chụp màn hình nên `screencap` trả ảnh đen; tài khoản đăng nhập cũng không có việc chờ duyệt. Chi tiết phê duyệt đã chia ba tab (Nội dung, So sánh, Bằng chứng) và mới được kiểm bằng widget test, chưa được nhìn trên thiết bị.

| Ảnh | Mã màn | Đang hiển thị | Việc đã xem và điều còn thấy |
|---|---|---|---|
| [`mobile/01-MOB-07-trang-chu.png`](mobile/01-MOB-07-trang-chu.png) | MOB-07 | Trang chủ: dải điều hành, ba ô chỉ số, khối "Việc theo hạn của tôi" ngay dưới | Đã mở xem. Khối việc theo hạn có ba số kèm hình của ba dải, nằm ngay dưới ô chỉ số (trước nằm cuối trang). Còn thấy: nhãn "Quá hạn, đến hạn" xuống hai dòng; ô "Cảnh báo đang mở" có nhãn "Cần theo dõi" xuống hai dòng (màn của làn khác). |
| [`mobile/02-MOB-07-trang-chu-viec-theo-han.png`](mobile/02-MOB-07-trang-chu-viec-theo-han.png) | MOB-07 | Trang chủ, cuộn tới khối việc theo hạn và danh sách "Cần bạn quyết định" | Đã mở xem bản chụp vòng trước (cùng bố cục). Hàng cảnh báo cho ba dòng tiêu đề và hai dòng ngữ cảnh. Còn thấy: câu cảnh báo của máy chủ dài nên vẫn bị cắt, và dòng ngữ cảnh của cảnh báo workflow chứa mã việc và mã giai đoạn (chữ do API soạn). |
| [`mobile/03-MOB-47-ca-nhan-cong-viec-cua-toi.png`](mobile/03-MOB-47-ca-nhan-cong-viec-cua-toi.png) | MOB-47 | Cá nhân: hồ sơ và nhóm "Công việc của tôi" | Đã mở xem bản chụp vòng trước (cùng bố cục): hồ sơ, rồi Việc của tôi, Điểm KPI của tôi, Ủy quyền và vắng mặt. |
| [`mobile/04-MOB-47-ca-nhan-nhac-han-cai-dat.png`](mobile/04-MOB-47-ca-nhan-nhac-han-cai-dat.png) | MOB-47 | Cá nhân: nhóm "Nhắc hạn việc" (xem trước ba mức) và nhóm "Cài đặt" | Đã mở xem bản chụp vòng trước. |
| [`mobile/05-MOB-47-ca-nhan-cong-cu.png`](mobile/05-MOB-47-ca-nhan-cong-cu.png) | MOB-47 | Cá nhân: nhóm "Công cụ" | Chưa mở xem. |
| [`mobile/06-MOB-47-ca-nhan-tai-khoan-ho-tro.png`](mobile/06-MOB-47-ca-nhan-tai-khoan-ho-tro.png) | MOB-47 | Cá nhân: nhóm "Tài khoản" và "Hỗ trợ" | Đã mở xem: hai nhóm ngắn có tiêu đề, phiên bản ở cuối. |
| [`mobile/10-MOB-80-viec-cua-toi-tab-can-lam.png`](mobile/10-MOB-80-viec-cua-toi-tab-can-lam.png) | MOB-80 | Việc của tôi, tab Cần làm: ba số theo dải, nhóm theo hạn | Đã mở xem bản chụp vòng trước (cùng bố cục): tên việc không bị cắt, hạn nằm một dòng riêng, không còn mã việc, có "Dự báo xong". |
| [`mobile/11-MOB-80-tab-can-lam-cuon-xuong.png`](mobile/11-MOB-80-tab-can-lam-cuon-xuong.png) | MOB-80 | Tab Cần làm, cuộn xuống | Chưa mở xem. |
| [`mobile/12-MOB-80-tab-can-lam-mau-chinh-thuc.png`](mobile/12-MOB-80-tab-can-lam-mau-chinh-thuc.png) | MOB-80 | Tab Cần làm, màu chính thức | Chưa mở xem. |
| [`mobile/13-MOB-80-tab-cho-duyet.png`](mobile/13-MOB-80-tab-cho-duyet.png) | MOB-80 | Tab Chờ duyệt | Đã mở xem: hai việc chờ duyệt, mỗi việc có hạn và dự báo. |
| [`mobile/14-MOB-80-tab-da-xong.png`](mobile/14-MOB-80-tab-da-xong.png) | MOB-80 | Tab Đã xong | Chưa mở xem. |
| [`mobile/20-MOB-79-chi-tiet-viec-tab-can-lam.png`](mobile/20-MOB-79-chi-tiet-viec-tab-can-lam.png) | MOB-79 | Chi tiết việc, tab Cần làm | Đã mở xem bản chụp vòng trước: điều kiện còn thiếu gọi tên mục kiểm (không còn mã), nút "Dời hạn" một dòng. Ảnh hiện tại chụp lại sau khi sửa màu biểu tượng, chưa mở xem lại. |
| [`mobile/21-MOB-79-tab-can-lam-cuon-xuong.png`](mobile/21-MOB-79-tab-can-lam-cuon-xuong.png) | MOB-79 | Tab Cần làm, cuộn xuống: danh mục kiểm, chứng từ đã nộp | Đã mở xem: mục kiểm ghi tên người đánh dấu và giờ, chứng từ ghi tiêu đề tài liệu và tên người nộp. |
| [`mobile/22-MOB-79-tab-thong-tin.png`](mobile/22-MOB-79-tab-thong-tin.png) | MOB-79 | Tab Thông tin: nhóm Phân công | Đã mở xem: giá trị thẳng lề phải, bốn tab vừa một hàng. |
| [`mobile/23-MOB-79-tab-thong-tin-cuon-xuong.png`](mobile/23-MOB-79-tab-thong-tin-cuon-xuong.png) | MOB-79 | Tab Thông tin, cuộn xuống: nhóm Thời hạn, Vị trí trong quy trình | Đã mở xem bản chụp vòng đầu (trước khi sửa lề phải). Ảnh hiện tại chưa mở xem lại. |
| [`mobile/24-MOB-79-tab-can-cu.png`](mobile/24-MOB-79-tab-can-cu.png) | MOB-79 | Tab Căn cứ | Đã mở xem bản chụp vòng đầu: trạng thái hiệu lực đứng đầu dòng, không còn cột phải. |
| [`mobile/25-MOB-79-tab-dien-bien.png`](mobile/25-MOB-79-tab-dien-bien.png) | MOB-79 | Tab Diễn biến: đề nghị đã gửi | Đã mở xem: đề nghị ghi tên người đề nghị. |
| [`mobile/26-MOB-79-tab-dien-bien-cuon-xuong.png`](mobile/26-MOB-79-tab-dien-bien-cuon-xuong.png) | MOB-79 | Tab Diễn biến, cuộn xuống: lịch sử | Đã mở xem bản chụp vòng đầu: sự kiện bằng tiếng Việt, kèm tên người thực hiện. |
| [`mobile/27-MOB-79-viec-cho-duyet.png`](mobile/27-MOB-79-viec-cho-duyet.png) | MOB-79 | Một việc đang chờ duyệt hoàn thành | Đã mở xem bản chụp vòng trước. Còn thấy: trạng thái "Chờ duyệt hoàn thành" hiện hai lần (dòng hạn và dòng Trạng thái). |
| [`mobile/30-MOB-81-diem-kpi-tab-theo-viec.png`](mobile/30-MOB-81-diem-kpi-tab-theo-viec.png) | MOB-81 | Điểm KPI, tab Theo việc | Đã mở xem bản chụp vòng trước: hai số ở đầu, xếp loại là một dòng. Còn thấy: việc trùng tên của hai dự án không phân biệt được (bản đọc không trả dự án). |
| [`mobile/31-MOB-81-tab-dieu-chinh.png`](mobile/31-MOB-81-tab-dieu-chinh.png) | MOB-81 | Tab Điều chỉnh | Chưa mở xem. |
| [`mobile/32-MOB-81-tab-cach-tinh.png`](mobile/32-MOB-81-tab-cach-tinh.png) | MOB-81 | Tab Cách tính | Đã mở xem: ba dòng, giá trị thẳng lề phải. |
| [`mobile/35-MOB-82-cai-dat-nhac-han.png`](mobile/35-MOB-82-cai-dat-nhac-han.png) | MOB-82 | Cài đặt nhắc hạn | Đã mở xem bản chụp vòng trước (màn không đổi trong làn này). |
| [`mobile/36-MOB-82-cai-dat-nhac-han-cuon-xuong.png`](mobile/36-MOB-82-cai-dat-nhac-han-cuon-xuong.png) | MOB-82 | Cài đặt nhắc hạn, cuộn xuống | Chưa mở xem. |
| [`mobile/40-MOB-09-du-an.png`](mobile/40-MOB-09-du-an.png) | MOB-09 | Danh sách dự án | Chưa mở xem. |
| [`mobile/41-MOB-10-chi-tiet-du-an-tab-tong-quan.png`](mobile/41-MOB-10-chi-tiet-du-an-tab-tong-quan.png) | MOB-10 | Chi tiết dự án DA-PWF-02, tab Tổng quan: nhóm Quy mô, Đơn vị và người phụ trách, Phân loại | Đã mở xem: dải giai đoạn thẳng lề với tiêu đề, giá trị thẳng lề phải. Còn thấy: nhãn "Tổng mức đầu tư" xuống hai dòng. |
| [`mobile/42-MOB-10-tab-tong-quan-cuon-xuong.png`](mobile/42-MOB-10-tab-tong-quan-cuon-xuong.png) | MOB-10 | Tab Tổng quan, cuộn xuống: Phân loại, Rủi ro | Chưa mở xem. |
| [`mobile/43-MOB-10-tab-tien-do.png`](mobile/43-MOB-10-tab-tien-do.png) | MOB-10 | Tab Tiến độ: workflow của dự án (dải giai đoạn, ba số theo dải) | Đã mở xem bản chụp vòng đầu (cùng bố cục). |
| [`mobile/44-MOB-10-tab-tien-do-cong-viec.png`](mobile/44-MOB-10-tab-tien-do-cong-viec.png) | MOB-10 | Tab Tiến độ: công việc theo giai đoạn, bước, việc | Đã mở xem bản chụp vòng đầu. |
| [`mobile/45-MOB-10-tab-tien-do-cuon-tiep.png`](mobile/45-MOB-10-tab-tien-do-cuon-tiep.png) | MOB-10 | Tab Tiến độ, cuộn tiếp | Chưa mở xem. |
| [`mobile/46-MOB-10-tab-tien-do-moc-cua-du-an.png`](mobile/46-MOB-10-tab-tien-do-moc-cua-du-an.png) | MOB-10 | Tab Tiến độ: lối mở toàn bộ workflow và mốc của dự án | Đã mở xem bản chụp vòng đầu. |
| [`mobile/47-MOB-10-tab-von.png`](mobile/47-MOB-10-tab-von.png) | MOB-10 | Tab Vốn | Đã mở xem: số chính ở đầu, số đầy đủ, ba lối xem thêm. |
| [`mobile/48-MOB-10-tab-ho-so.png`](mobile/48-MOB-10-tab-ho-so.png) | MOB-10 | Tab Hồ sơ | Chưa mở xem. |
| [`mobile/50-MOB-78-workflow-tab-tong-quan.png`](mobile/50-MOB-78-workflow-tab-tong-quan.png) | MOB-78 | Workflow dự án, tab Tổng quan | Đã mở xem bản chụp vòng đầu và bản tối. |
| [`mobile/51-MOB-78-tab-tong-quan-cac-giai-doan.png`](mobile/51-MOB-78-tab-tong-quan-cac-giai-doan.png) | MOB-78 | Tab Tổng quan, cuộn xuống: các giai đoạn | Đã mở xem bản chụp vòng trước: mỗi giai đoạn có trạng thái và số việc bắt buộc đã xong. |
| [`mobile/52-MOB-78-tab-cong-viec.png`](mobile/52-MOB-78-tab-cong-viec.png) | MOB-78 | Tab Công việc: giai đoạn, bước, việc theo màu hạn | Đã mở xem bản chụp vòng trước: dòng của bước đủ chữ, căn cứ pháp lý nằm trong dòng. |
| [`mobile/53-MOB-78-tab-cong-viec-cuon-xuong.png`](mobile/53-MOB-78-tab-cong-viec-cuon-xuong.png) | MOB-78 | Tab Công việc, cuộn xuống | Chưa mở xem. |
| [`mobile/54-MOB-78-tab-moc.png`](mobile/54-MOB-78-tab-moc.png) | MOB-78 | Tab Mốc | Đã mở xem: nhóm "Mốc chưa xong", hạn ngoài tầm ghi đủ năm. |
| [`mobile/60-MOB-32-thong-bao-tab-su-kien.png`](mobile/60-MOB-32-thong-bao-tab-su-kien.png) | MOB-32 | Thông báo, tab Sự kiện | Đã mở xem bản chụp vòng đầu: tài khoản này chưa có sự kiện nào nên là trạng thái rỗng. Còn thấy: câu của trạng thái rỗng nói "tạo bản ghi đầu tiên" (màn của làn khác). |
| [`mobile/61-MOB-32-thong-bao-tab-viec-can-xu-ly.png`](mobile/61-MOB-32-thong-bao-tab-viec-can-xu-ly.png) | MOB-32 | Thông báo, tab Việc cần xử lý | Đã mở xem bản chụp vòng trước. Còn thấy: tiêu đề cảnh báo vẫn bị cắt ở ba dòng, dòng ngữ cảnh chứa mã việc. |
| [`mobile/70-toi-MOB-07-trang-chu.png`](mobile/70-toi-MOB-07-trang-chu.png) | MOB-07 | Chế độ tối: trang chủ | Chưa mở xem. |
| [`mobile/71-toi-MOB-47-ca-nhan.png`](mobile/71-toi-MOB-47-ca-nhan.png) | MOB-47 | Chế độ tối: Cá nhân | Chưa mở xem. |
| [`mobile/72-toi-MOB-80-viec-cua-toi.png`](mobile/72-toi-MOB-80-viec-cua-toi.png) | MOB-80 | Chế độ tối: Việc của tôi | Chưa mở xem. |
| [`mobile/73-toi-MOB-79-chi-tiet-viec.png`](mobile/73-toi-MOB-79-chi-tiet-viec.png) | MOB-79 | Chế độ tối: chi tiết việc | Đã mở xem bản chụp lại sau khi sửa: biểu tượng của hàng "còn thiếu" đã đọc được trên nền tối (bản trước bị đen). |
| [`mobile/74-toi-MOB-79-tab-thong-tin.png`](mobile/74-toi-MOB-79-tab-thong-tin.png) | MOB-79 | Chế độ tối: chi tiết việc, tab Thông tin | Chưa mở xem. |
| [`mobile/75-toi-MOB-10-chi-tiet-du-an.png`](mobile/75-toi-MOB-10-chi-tiet-du-an.png) | MOB-10 | Chế độ tối: chi tiết dự án | Chưa mở xem. |
| [`mobile/76-toi-MOB-78-workflow-tab-tong-quan.png`](mobile/76-toi-MOB-78-workflow-tab-tong-quan.png) | MOB-78 | Chế độ tối: workflow, tab Tổng quan | Đã mở xem: ba dải, hàng việc và tab đọc rõ trên nền tối. |
| [`mobile/77-toi-MOB-78-tab-cong-viec.png`](mobile/77-toi-MOB-78-tab-cong-viec.png) | MOB-78 | Chế độ tối: workflow, tab Công việc | Chưa mở xem. |

## Khiếm khuyết còn thấy hoặc còn biết

- Dải giai đoạn ở tab Tổng quan ghi "Đang ở đây" cho nhiều giai đoạn cùng lúc (`web/20`): theo cờ `open` của bản đọc.
- PWF-02: biểu mẫu soạn một việc vẫn dài; chưa chia tab con cho từng việc (`web/12`).
- Vai trò và mã văn bản do tỉnh tự đặt, không có trong danh mục tên, vẫn hiện mã.
- Bảng điểm: việc trùng tên chưa kèm mã dự án (bản đọc không trả dự án).
- Ô ngày trong ảnh hiện tháng/ngày/năm do Chromium của máy chụp; trên máy người dùng theo ngôn ngữ của trình duyệt.
- Các khiếm khuyết về logic đã nêu ở bản trước (tiếp nhận workflow, hạn bị đẩy lùi, bảng điểm có tài khoản khách) thuộc nhánh pwf5; lượt này không kiểm lại chúng trên ảnh.

Riêng điện thoại (làn mob7):

- Câu cảnh báo và dòng ngữ cảnh của cảnh báo workflow ở trang chủ và tab Thông báo do API soạn: dài nên bị cắt ở ba dòng, và chứa mã việc, mã giai đoạn (`mobile/02`, `mobile/61`).
- Thanh tab của màn chi tiết nằm trong danh sách cuộn, không dính ở đầu màn: cuộn xuống thì phải cuộn lên mới đổi tab được.
- Màn chi tiết vẫn hiện thanh điều hướng năm tab ở dưới thanh hành động (hệ thiết kế v2 nói màn chi tiết ẩn thanh điều hướng).
- Vai trò, loại văn bản, biểu mẫu do tỉnh tự đặt, không có trong danh mục tên, vẫn hiện mã; mã việc còn ở nhóm "Vị trí trong quy trình" của tab Thông tin (cố ý, để đối chiếu với máy tính).
- Điểm KPI: việc trùng tên của hai dự án không phân biệt được.
- Nhãn hai dòng: "Quá hạn, đến hạn" ở ô chỉ số, "Tổng mức đầu tư" ở chi tiết dự án.
- Tab Phê duyệt không chụp được (cờ chặn chụp).

Golden Windows của điện thoại đổi trong làn mob7 (90 tệp, không thêm tệp mới): danh sách ở `mobile-goldens-changed.txt`; bản Linux (`goldens-linux`) của đúng các tệp đó cần CI dựng lại.
