# Ảnh chụp màn hình phần workflow dự án (PWF), bản công

Web: chụp lại ngày 14/11/2026 từ nhánh `lane/pwf6` (đã gộp `lane/pwf5`) trên ứng dụng chạy thật: API trên PostgreSQL nhúng, seed `clip-seed --dataset public` chạy trọn trên một stack sạch (gồm nhóm `clip-public-pwf-review`), web chạy ở chế độ development, Chromium của Playwright 1440×900, ảnh toàn trang. Không có ảnh mock.

**Điện thoại: thư mục `mobile/` vẫn là ảnh CŨ, chụp trước khi sửa và trước khi chia tab.** Lượt này chưa dựng APK và chưa chạy AVD, nên các thay đổi trên điện thoại (MOB-79 và MOB-81 theo tab, khối "Việc theo hạn của tôi" ở trang chủ, tên thay cho mã) chưa có ảnh; chúng mới được kiểm bằng `flutter test` và golden.

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

## Khiếm khuyết còn thấy hoặc còn biết

- Dải giai đoạn ở tab Tổng quan ghi "Đang ở đây" cho nhiều giai đoạn cùng lúc (`web/20`): theo cờ `open` của bản đọc.
- PWF-02: biểu mẫu soạn một việc vẫn dài; chưa chia tab con cho từng việc (`web/12`).
- Vai trò và mã văn bản do tỉnh tự đặt, không có trong danh mục tên, vẫn hiện mã.
- Bảng điểm: việc trùng tên chưa kèm mã dự án (bản đọc không trả dự án).
- Ô ngày trong ảnh hiện tháng/ngày/năm do Chromium của máy chụp; trên máy người dùng theo ngôn ngữ của trình duyệt.
- Ảnh điện thoại chưa chụp lại (xem trên).
- Các khiếm khuyết về logic đã nêu ở bản trước (tiếp nhận workflow, hạn bị đẩy lùi, bảng điểm có tài khoản khách) thuộc nhánh pwf5; lượt này không kiểm lại chúng trên ảnh.
