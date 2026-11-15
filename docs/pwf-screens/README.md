# Ảnh chụp màn hình phần workflow dự án (PWF), có dữ liệu

Chụp lại toàn bộ ngày 15/11/2026 từ nhánh `lane/fix12` (từ `main` 233a2fadf, sau làn fix11) trên ứng dụng chạy thật: API trên PostgreSQL nhúng, `clip-seed apply --dataset public` chạy trọn trên một stack sạch (xem mục Seed), web dựng ở chế độ development và chụp bằng Chromium của Playwright (1440×900, ảnh toàn trang; vài ảnh là khung nhìn, và mười một ảnh rộng 390 px); điện thoại là APK debug dựng từ nhánh với `--dart-define=MACHVON_ALLOW_SCREENSHOTS=true`, AVD `guide` (720×1560, Android 15), ảnh lấy bằng `adb exec-out screencap -p`. Không có ảnh mock và không có ảnh golden.

Tổng cộng 167 ảnh: 91 ảnh web, 76 ảnh điện thoại. Cách tôi xem: các ảnh ghi "cỡ đầy đủ" ở cột cuối được mở ở cỡ đọc được từng chữ; phần còn lại tôi xem trong tờ ghép thu nhỏ (web 8 ảnh một tờ ở bề rộng 300 px, điện thoại 6 ảnh một tờ ở 330 px), đủ để thấy bố cục, màu và chỗ vỡ, KHÔNG đủ để đọc từng chữ nhỏ. Với mọi ảnh web, kịch bản chụp đo được: không có lỗi JavaScript và trang không cuộn ngang. Điện thoại: ảnh DOC-24 (ba tab của văn bản đến) không có trong lượt này (xem "Chưa làm").

Xem dạng lưới có mục lục theo màn rồi theo tab: [index.html](index.html).


## Xác nhận từng mục của fix11 và fix12 trên màn thật

Bản công, stack sạch (xem "Seed"). "ĐẠT" nghĩa là tôi thấy đúng điều mục đòi trên ảnh hoặc trên số đo của kịch bản; điều chưa thấy được ghi là chưa.

| # | Mục | Kết quả | Ảnh hoặc số đo |
|---|---|---|---|
| 1 | Hộp phê duyệt hợp nhất (fix12, R54): năm loại, người quyết định đúng, nút gọi đúng lệnh | ĐẠT trên web và điện thoại: chủ sở hữu thấy năm hồ sơ (phản hồi về điểm của bộ máy phê duyệt; duyệt hoàn thành việc, ngoại lệ, dời lịch, điều chỉnh điểm của PWF). Huy hiệu tab Phê duyệt là 5; số "Cần xử lý" của chuông gồm các hồ sơ này (nguồn APPROVAL). Quyết định thật (bấm Duyệt) được kiểm bằng test API và widget, KHÔNG bấm trên stack chụp để không đổi dữ liệu của ảnh | `web/63-PWA-02-hop-phe-duyet-hop-nhat`, `web/63-PWA-02-hop-quyet-dinh-ho-so-pwf`, `web/65-390-...`, `mobile/72` đến `mobile/75`, `mobile/79` |
| 2 | Vai nhân viên mặc định (fix12, R55) | ĐẠT: cán bộ Bùi Thị Mai chỉ có vai STAFF_MEMBER; `getMyTasks` trả 4 việc của chị (`clip-seed verify`), trang chủ "Việc hôm nay" có nội dung | `mobile/06-MOB-07-trang-chu-projectViewer`, số đo `verify`: "the officer with only the role of the staff has tasks of their own: 4" |
| 3 | Trang chủ cán bộ khác trang chủ lãnh đạo, đúng vai (fix11 mục 10) | ĐẠT: ba ảnh khác nhau. Lãnh đạo (Nguyễn Văn An): "Tổng quan" với dải giải ngân; cán bộ Ban QLDA (Phạm Quốc Dũng): xem ảnh; cán bộ chỉ có vai nhân viên: "Việc hôm nay" | `mobile/01`, `mobile/05-...-projectManager`, `mobile/06-...-projectViewer` |
| 4 | So sánh kỳ có cột đơn vị, không lộ kỳ nháp cho người được chấm | ĐẠT: một dòng (kỳ đã chốt) với cột Đơn vị và Trạng thái | `web/53-PWF-11-can-bo-co-dieu-chinh-tab-2-so-sanh-ky` |
| 5 | Chi tiết phê duyệt đọc được nội dung, cả năm loại | ĐẠT: web (thẻ hồ sơ và trang chi tiết) và điện thoại (tấm quyết định, MOB-24 của phản hồi điểm) | `web/63`, `web/64`, `mobile/73`, `mobile/76`, `mobile/79` |
| 6 | Băng "Số liệu có thể đã cũ" không còn hiện sai | ĐẠT: đo bằng kịch bản, không có băng ở PRJ-03 (workflow), PWF-03 và PWF-07 trên stack này | số đo của kịch bản (không có ảnh của một điều vắng mặt) |
| 7 | Dữ kiện nguồn của KPI có cấu trúc | ĐẠT | `web/35-PWF-04-viec-da-xong-tab-kpi` |
| 8 | Ba bảng thành thẻ ở 390 px (chứng từ đã nộp, xem trước màu, cây công việc) | ĐẠT cho thẻ; còn một chỗ: dòng cuối bảng "Xem trước màu" bị cắt ở khung cuộn của bảng | `web/91`, `web/99`, `web/96` |
| 9 | Tệp Excel của bảng deadline bằng tiếng Việt | ĐẠT: tên trang tính "Bảng deadline", đầu tệp nêu ngày xuất, số việc, bộ lọc; hàng tiêu đề "Mã dự án, Dự án, Công việc, ..."; 137 dòng dữ liệu, trạng thái và màu bằng chữ ("Đang thực hiện", "Đỏ, quá hạn") | tệp xuất khi chụp `web/43-...`, đọc lại bằng openpyxl |
| 10 | Mốc không trùng việc quá hạn | ĐẠT: `/home/my-work` của chủ sở hữu có 12 mục PWF (3 việc quá hạn, 6 sắp đến hạn, 3 mốc rủi ro), không có hai mục cùng đích | số đo; `mobile/02`, `mobile/03` |
| 11 | PWF-09 mở một thang | ĐẠT: tab Thang điểm cao 1.720 px (trước hơn 5.000 px) | `web/50-PWF-09-bo-kpi-tab-2-thang-diem` |
| 12 | Nhãn "Cần theo dõi" một dòng (mục nhỏ) | ĐẠT: đổi thành "Lưu ý", một dòng | `mobile/01` |
| 13 | Mục nhỏ 17, 18, 23 | 18: không tái hiện, thêm khoảng cách hàng ô (12 px). 17 (cột cuối bị cắt ở PWF-06 và PWF-03): KHÔNG sửa mã và chưa kiểm lại ở cỡ đọc; hai bảng cuộn trong khung của chúng (ScrollRegion), nên ảnh toàn trang vẫn có thể cắt cột cuối. 23 (ô ngày theo ngôn ngữ trình duyệt): chưa làm | `web/20`, `web/39`, `web/29-...-tab-2` |
| 14 | Maestro: flow 06, 20, 40 trên cả hai bản | 06 và 40 ĐẠT trên cả hai bản; 20 KHÔNG ĐẠT ngân sách 2,5 giây trên trình giả lập (2 mẫu mỗi bản) | mục "Flow Maestro" |

## Cách dựng lại

- Stack và web: `node uat/run/.../tools/serve-edition.mjs <public|enterprise> <thư mục> <cổng API> <cổng IdP> <cổng web>` (dựng web ở chế độ development, chạy `npm run e2e:stack -w @machvon/api`, rồi `node scripts/clip-seed.mjs apply --dataset <bản>`). Đăng nhập web bằng `?devUser=<người>`.
- Điện thoại: `flutter build apk --debug --dart-define=MACHVON_API_BASE_URL=http://127.0.0.1:<cổng API> --dart-define=MACHVON_OIDC_ISSUER=http://127.0.0.1:<cổng IdP>/realms/machvon --dart-define=MACHVON_OIDC_CLIENT_ID=machvon-web --dart-define=MACHVON_ALLOW_SCREENSHOTS=true` (bản doanh nghiệp thêm `--dart-define=MACHVON_EDITION=enterprise`); `adb root`, `adb reverse` hai cổng, `adb install`, `adb shell cmd locale set-app-locales vn.machvon.app --locales vi-VN`; đăng nhập bằng `maestro test apps/mobile/qa/device/flows/06_sign_in_test_idp.yaml`. Người khác người thứ nhất: ghi khóa của người đó vào `<stack-info.json>.user` trước khi đăng nhập.
- Chế độ tối: chọn "Tối" ở mục Chế độ giao diện của tab Cá nhân. Cờ `MACHVON_ALLOW_SCREENSHOTS` chỉ có hiệu lực ở bản debug.
- Máy chụp cần RAM: emulator (4,3 GB) cùng stack và Maestro làm JVM của Maestro hết bộ nhớ (xem Flow Maestro); tắt `vite preview` trước khi chạy flow.

## PRJ-02 · Tạo dự án, mục "Loại quy trình xử lý"

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/01-PRJ-02-dang-ky-du-an-loai-quy-trinh.png`](web/01-PRJ-02-dang-ky-du-an-loai-quy-trinh.png) | PRJ-02 | Tạo dự án đã nhập đủ: đề xuất của hệ thống, lý do, bốn ô chọn, xem trước lịch (13 bước, 503 ngày làm việc) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## PWF-01, PWF-02, PWF-05 · Thư viện mẫu, trình soạn (từng tab và tab con), khởi tạo và tiếp nhận

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/10-PWF-01-thu-vien-mau.png`](web/10-PWF-01-thu-vien-mau.png) | PWF-01 | Thư viện mẫu: năm mẫu, phiên bản, hiệu lực, cờ | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/11-PWF-01-so-sanh-hai-phien-ban.png`](web/11-PWF-01-so-sanh-hai-phien-ban.png) | PWF-01 | So sánh phiên bản 1 và 2 của mẫu sửa chữa đường của tỉnh | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec.png) | PWF-02 | Trình soạn, tab Cấu trúc; khung soạn việc ở tab con Thông tin | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-2-thoi-han-va-phu-thuoc.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-2-thoi-han-va-phu-thuoc.png) | PWF-02 | Tab con Thời hạn và phụ thuộc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-3-chung-tu-va-bieu-mau.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-3-chung-tu-va-bieu-mau.png) | PWF-02 | Tab con Chứng từ và biểu mẫu: chọn biểu mẫu từ kho | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-4-danh-muc-kiem.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-4-danh-muc-kiem.png) | PWF-02 | Tab con Danh mục kiểm | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-5-kpi.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-5-kpi.png) | PWF-02 | Tab con KPI: sáu KPI của workflow | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-6-can-cu.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-6-can-cu.png) | PWF-02 | Tab con Căn cứ | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/12-PWF-02-tab-2-buoc-va-can-cu-phap-ly.png`](web/12-PWF-02-tab-2-buoc-va-can-cu-phap-ly.png) | PWF-02 | Tab Bước và căn cứ pháp lý | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/12-PWF-02-tab-3-vai-tro.png`](web/12-PWF-02-tab-3-vai-tro.png) | PWF-02 | Tab Vai trò: chín mã vai trò và ô đặt tên | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/12-PWF-02-tab-4-kiem-tra-va-xem-truoc-lich.png`](web/12-PWF-02-tab-4-kiem-tra-va-xem-truoc-lich.png) | PWF-02 | Tab Kiểm tra và xem trước lịch | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/15-PWF-05-khoi-tao-workflow-xem-truoc-lich.png`](web/15-PWF-05-khoi-tao-workflow-xem-truoc-lich.png) | PWF-05 | Khởi tạo workflow cho DA-CN026, đã xem trước lịch | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/16-PWF-05-tiep-nhan-workflow-chay-thu.png`](web/16-PWF-05-tiep-nhan-workflow-chay-thu.png) | PWF-05 | Tiếp nhận workflow cho dự án đang chạy: kết quả chạy thử từng việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## PRJ-03 · Không gian dự án, mọi tab; tab Workflow có năm tab con

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/20-PRJ-03-tab-tong-quan.png`](web/20-PRJ-03-tab-tong-quan.png) | PRJ-03 | DA-PWF-02, tab Tổng quan | Đã mở xem cỡ đầy đủ. Khối "Cập nhật thông tin" hiện đủ trong ảnh toàn trang (mục 18 không tái hiện); sửa trong lượt: hai hàng ô của khối cách nhau 12 px. |
| [`web/21-PRJ-03-tab-muc-tieu.png`](web/21-PRJ-03-tab-muc-tieu.png) | PRJ-03 | Tab Mục tiêu | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/22-PRJ-03-tab-ke-hoach.png`](web/22-PRJ-03-tab-ke-hoach.png) | PRJ-03 | Tab Kế hoạch: mốc tiến độ lấy từ workflow | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/23-PRJ-03-tab-workflow-1-tong-quan.png`](web/23-PRJ-03-tab-workflow-1-tong-quan.png) | PRJ-03 | Tab Workflow, tab con Tổng quan | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/23-PRJ-03-tab-workflow-2-cong-viec.png`](web/23-PRJ-03-tab-workflow-2-cong-viec.png) | PRJ-03 | Tab con Công việc: cây giai đoạn, bước, việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/23-PRJ-03-tab-workflow-3-lich.png`](web/23-PRJ-03-tab-workflow-3-lich.png) | PRJ-03 | Tab con Lịch: Gantt | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/23-PRJ-03-tab-workflow-4-moc-va-cong.png`](web/23-PRJ-03-tab-workflow-4-moc-va-cong.png) | PRJ-03 | Tab con Mốc và cổng | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/23-PRJ-03-tab-workflow-5-bang-cot.png`](web/23-PRJ-03-tab-workflow-5-bang-cot.png) | PRJ-03 | Tab con Bảng cột | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/24-PRJ-03-tab-giai-ngan.png`](web/24-PRJ-03-tab-giai-ngan.png) | PRJ-03 | Tab Giải ngân | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/25-PRJ-03-tab-vuong-mac.png`](web/25-PRJ-03-tab-vuong-mac.png) | PRJ-03 | Tab Vướng mắc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## PWF-03 · Workflow của dự án theo mẫu của tỉnh

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/29-PWF-03-mau-cua-tinh-tab-1-tong-quan.png`](web/29-PWF-03-mau-cua-tinh-tab-1-tong-quan.png) | PWF-03 | DA-PWF-04, tab Tổng quan | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/29-PWF-03-mau-cua-tinh-tab-2-cong-viec.png`](web/29-PWF-03-mau-cua-tinh-tab-2-cong-viec.png) | PWF-03 | Tab Công việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/29-PWF-03-mau-cua-tinh-tab-3-lich.png`](web/29-PWF-03-mau-cua-tinh-tab-3-lich.png) | PWF-03 | Tab Lịch | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/29-PWF-03-mau-cua-tinh-tab-4-moc-va-cong.png`](web/29-PWF-03-mau-cua-tinh-tab-4-moc-va-cong.png) | PWF-03 | Tab Mốc và cổng | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/29-PWF-03-mau-cua-tinh-tab-5-bang-cot.png`](web/29-PWF-03-mau-cua-tinh-tab-5-bang-cot.png) | PWF-03 | Tab Bảng cột | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## PWF-04, PWF-16, PWF-06 · Chi tiết công việc (sáu tab), sổ phân công, dời lịch

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/30-PWF-04-viec-dang-lam-tab-1-viec-can-lam.png`](web/30-PWF-04-viec-dang-lam-tab-1-viec-can-lam.png) | PWF-04 | Việc đang làm và trễ, tab Việc cần làm | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/30-PWF-04-viec-dang-lam-tab-2-can-cu-phap-ly.png`](web/30-PWF-04-viec-dang-lam-tab-2-can-cu-phap-ly.png) | PWF-04 | Tab Căn cứ pháp lý | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/30-PWF-04-viec-dang-lam-tab-3-lich-va-phan-cong.png`](web/30-PWF-04-viec-dang-lam-tab-3-lich-va-phan-cong.png) | PWF-04 | Tab Lịch và phân công: sổ phân công có ba người | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/30-PWF-04-viec-dang-lam-tab-4-ngoai-le.png`](web/30-PWF-04-viec-dang-lam-tab-4-ngoai-le.png) | PWF-04 | Tab Ngoại lệ: một đề nghị chờ duyệt | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/30-PWF-04-viec-dang-lam-tab-5-lich-su.png`](web/30-PWF-04-viec-dang-lam-tab-5-lich-su.png) | PWF-04 | Tab Lịch sử | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/30-PWF-04-viec-dang-lam-tab-6-kpi.png`](web/30-PWF-04-viec-dang-lam-tab-6-kpi.png) | PWF-04 | Tab KPI | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/31-PWF-04-dau-trang-dinh-sau-khi-cuon.png`](web/31-PWF-04-dau-trang-dinh-sau-khi-cuon.png) | PWF-04 | Khung nhìn sau khi cuộn 520 px | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/32-PWF-04-viec-cho-duyet-nguoi-duyet-xem.png`](web/32-PWF-04-viec-cho-duyet-nguoi-duyet-xem.png) | PWF-04 | Việc chờ duyệt hoàn thành, nhìn bằng tài khoản lãnh đạo | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/33-PWF-04-viec-da-xong-tab-lich-su.png`](web/33-PWF-04-viec-da-xong-tab-lich-su.png) | PWF-04 | Việc đã xong, tab Lịch sử | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/34-PWF-04-hop-thoai-hoan-thanh.png`](web/34-PWF-04-hop-thoai-hoan-thanh.png) | PWF-04 | Hộp thoại Hoàn thành công việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/35-PWF-04-viec-da-xong-tab-kpi.png`](web/35-PWF-04-viec-da-xong-tab-kpi.png) | PWF-04 | Việc đã xong, tab KPI | Đã mở xem cỡ đầy đủ. ĐẠT: dữ kiện nguồn là từng dòng "tên: giá trị" (ngày dd/mm/yyyy, "Đã xong", "năm 2026 (phiên bản 1)"); JSON chỉ nằm trong "Xem dữ liệu đầy đủ (JSON)", đóng sẵn. |
| [`web/38-PWF-16-so-phan-cong.png`](web/38-PWF-16-so-phan-cong.png) | PWF-16 | Sổ phân công của việc được chuyển người trước hạn | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/39-PWF-06-doi-lich-de-nghi-dang-cho.png`](web/39-PWF-06-doi-lich-de-nghi-dang-cho.png) | PWF-06 | Dời lịch của DA-PWF-01, có đề nghị đang chờ, nhìn bằng tài khoản lãnh đạo | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## PWF-07, PWF-08, PWF-15 · Bảng deadline (từng tab), chính sách ba màu, nhắc hạn

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/40-PWF-07-tab-danh-sach.png`](web/40-PWF-07-tab-danh-sach.png) | PWF-07 | Bảng deadline, tab Danh sách | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/41-PWF-07-loc-mau-do.png`](web/41-PWF-07-loc-mau-do.png) | PWF-07 | Lọc màu đỏ bằng thẻ đếm | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/42-PWF-07-hop-giai-thich-nut-i.png`](web/42-PWF-07-hop-giai-thich-nut-i.png) | PWF-07 | Hộp giải thích của nút "i" trên dải số đếm (khung nhìn) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/43-PWF-07-sau-khi-xem-them-va-xuat-excel.png`](web/43-PWF-07-sau-khi-xem-them-va-xuat-excel.png) | PWF-07 | Sau khi bấm "Xem thêm" và "Xuất Excel" | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/43-PWF-07-cuoi-danh-sach-nut-xem-them.png`](web/43-PWF-07-cuoi-danh-sach-nut-xem-them.png) | PWF-07 | Cuối danh sách (khung nhìn): còn bao nhiêu việc chưa hiện | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/44-PWF-07-tab-lich-thang.png`](web/44-PWF-07-tab-lich-thang.png) | PWF-07 | Tab Lịch tháng | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/45-PWF-07-tab-moc-30-ngay.png`](web/45-PWF-07-tab-moc-30-ngay.png) | PWF-07 | Tab Mốc 30 ngày tới | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/46-PWF-07-tab-tai-cong-viec.png`](web/46-PWF-07-tab-tai-cong-viec.png) | PWF-07 | Tab Tải công việc theo người và tuần | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/47-PWF-08-chinh-sach-ba-mau.png`](web/47-PWF-08-chinh-sach-ba-mau.png) | PWF-08 | Chính sách ba màu của tỉnh, phiên bản đã duyệt | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/50-PWF-09-bo-kpi-tab-1-danh-muc-kpi.png`](web/50-PWF-09-bo-kpi-tab-1-danh-muc-kpi.png) | PWF-09 | Bộ KPI, tab Danh mục KPI: sáu KPI, ô tìm, "Đang hiện 6 trên 6 KPI" | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/50-PWF-09-bo-kpi-tab-2-thang-diem.png`](web/50-PWF-09-bo-kpi-tab-2-thang-diem.png) | PWF-09 | Tab Thang điểm: thang và đường quy đổi của từng KPI | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/50-PWF-09-bo-kpi-tab-3-ap-dung-cho-mau-va-viec.png`](web/50-PWF-09-bo-kpi-tab-3-ap-dung-cho-mau-va-viec.png) | PWF-09 | Tab Áp dụng cho mẫu và việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/50-PWF-09-bo-kpi-tab-4-phien-ban.png`](web/50-PWF-09-bo-kpi-tab-4-phien-ban.png) | PWF-09 | Tab Phiên bản: lưu bản nháp và lịch sử | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/48-PWF-15-nhac-han-cua-toi.png`](web/48-PWF-15-nhac-han-cua-toi.png) | PWF-15 | Nhắc hạn của tôi: ngưỡng riêng, bảng xem trước, việc sắp tới | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/49-PWF-15-viec-da-xong-gan-day.png`](web/49-PWF-15-viec-da-xong-gan-day.png) | PWF-15 | Việc của tôi, nút "Đã xong gần đây" (Nguyễn Văn An) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/49-PWF-15-viec-da-xong-gan-day-can-bo.png`](web/49-PWF-15-viec-da-xong-gan-day-can-bo.png) | PWF-15 | Việc đã xong gần đây của cán bộ (Phạm Quốc Dũng) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## PWF-09 đến PWF-14 · Bộ KPI, chính sách chấm điểm, bảng điểm, kỳ chấm điểm

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/51-PWF-10-chinh-sach-cham-diem.png`](web/51-PWF-10-chinh-sach-cham-diem.png) | PWF-10 | Chính sách chấm điểm, phiên bản 1 của tỉnh đang hiệu lực | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky.png`](web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky.png) | PWF-11 | Bảng điểm của tôi (Nguyễn Văn An), tab con Điểm | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-2-theo-viec.png`](web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-2-theo-viec.png) | PWF-11 | Tab con Theo việc: 13 việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png`](web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png) | PWF-11 | Tab con Điều chỉnh và phản hồi | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-2-so-sanh-ky.png`](web/52-PWF-11-bang-diem-cua-toi-tab-2-so-sanh-ky.png) | PWF-11 | Tab So sánh kỳ | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky.png) | PWF-11 | Bảng điểm của Phạm Quốc Dũng: điểm 5.9 được điều chỉnh thành 8.9 | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-2-theo-viec.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-2-theo-viec.png) | PWF-11 | Tab con Theo việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png) | PWF-11 | Tab con Điều chỉnh và phản hồi: một điều chỉnh đã duyệt, một phản hồi đã xử lý | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-2-so-sanh-ky.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-2-so-sanh-ky.png) | PWF-11 | Tab So sánh kỳ | Đã mở xem cỡ đầy đủ. ĐẠT: một dòng (kỳ đã chốt), có cột Đơn vị và Trạng thái; kỳ nháp của Sở không lọt vào bảng của người được chấm. Sửa trong lượt: "trọng số 77,88" dùng dấu phẩy. |
| [`web/54-PWF-12-bang-diem-don-vi.png`](web/54-PWF-12-bang-diem-don-vi.png) | PWF-12 | Bảng điểm đơn vị: 9 người, 6 người có điểm | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/55-PWF-13-chi-tiet-diem-tab-1-diem.png`](web/55-PWF-13-chi-tiet-diem-tab-1-diem.png) | PWF-13 | Chi tiết điểm của Phạm Quốc Dũng, tab Điểm, có khối "Có cho người rà soát" | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/55-PWF-13-chi-tiet-diem-tab-2-theo-viec.png`](web/55-PWF-13-chi-tiet-diem-tab-2-theo-viec.png) | PWF-13 | Tab Theo việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/55-PWF-13-chi-tiet-diem-tab-3-dieu-chinh-va-phan-hoi.png`](web/55-PWF-13-chi-tiet-diem-tab-3-dieu-chinh-va-phan-hoi.png) | PWF-13 | Tab Điều chỉnh và phản hồi | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/55-PWF-13-chi-tiet-diem-tab-4-so-sanh-ky.png`](web/55-PWF-13-chi-tiet-diem-tab-4-so-sanh-ky.png) | PWF-13 | Tab So sánh kỳ | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/56-PWF-13-hop-giai-thich-nut-i.png`](web/56-PWF-13-hop-giai-thich-nut-i.png) | PWF-13 | Hộp giải thích của nút "i" cạnh điểm kỳ (khung nhìn) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/57-PWF-14-ky-cham-diem.png`](web/57-PWF-14-ky-cham-diem.png) | PWF-14 | Kỳ chấm điểm đã chốt, có một tín hiệu cần rà soát | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## ADM liên quan · Lịch sử phiên bản quy tắc, lịch làm việc

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/60-ADM-20-phien-ban-mau-cua-tinh.png`](web/60-ADM-20-phien-ban-mau-cua-tinh.png) | ADM-20 | Các phiên bản của mẫu workflow của tỉnh trong kho quy tắc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/61-ADM-20-phien-ban-bo-kpi.png`](web/61-ADM-20-phien-ban-bo-kpi.png) | ADM-20 | Phiên bản 1 của bộ KPI trong kho quy tắc: người soạn, người duyệt | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/62-ADM-07-lich-cong-tac.png`](web/62-ADM-07-lich-cong-tac.png) | ADM-07 | Lịch công tác và ngày nghỉ (lịch mà hạn của workflow dựa vào) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Web ở 390 px

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/90-390-PRJ-03-workflow-tong-quan.png`](web/90-390-PRJ-03-workflow-tong-quan.png) | PRJ-03 | Tab Workflow, Tổng quan | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/91-390-PWF-04-chi-tiet-viec.png`](web/91-390-PWF-04-chi-tiet-viec.png) | PWF-04 | Chi tiết việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/92-390-PWF-07-bang-deadline.png`](web/92-390-PWF-07-bang-deadline.png) | PWF-07 | Bảng deadline | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/93-390-PWF-11-bang-diem-cua-toi.png`](web/93-390-PWF-11-bang-diem-cua-toi.png) | PWF-11 | Bảng điểm của tôi | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/94-390-PWF-12-bang-diem-don-vi.png`](web/94-390-PWF-12-bang-diem-don-vi.png) | PWF-12 | Bảng điểm đơn vị | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/95-390-PWF-01-thu-vien-mau.png`](web/95-390-PWF-01-thu-vien-mau.png) | PWF-01 | Thư viện mẫu | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/96-390-PWF-03-cong-viec.png`](web/96-390-PWF-03-cong-viec.png) | PWF-03 | Cây công việc của workflow ở 390 px | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/97-390-PWF-13-chi-tiet-diem.png`](web/97-390-PWF-13-chi-tiet-diem.png) | PWF-13 | Chi tiết điểm ở 390 px | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/98-390-PWF-14-ky-cham-diem.png`](web/98-390-PWF-14-ky-cham-diem.png) | PWF-14 | Kỳ chấm điểm ở 390 px | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/99-390-PWF-15-nhac-han.png`](web/99-390-PWF-15-nhac-han.png) | PWF-15 | Nhắc hạn của tôi ở 390 px | Đã mở xem cỡ đầy đủ. Bảng "Xem trước màu" là thẻ "nhãn: giá trị", đủ ba dòng, không cuộn ngang. Còn thấy: dòng cuối của bảng xem trước ("Còn 3 ngày làm việc") bị cắt ở mép khung cuộn của bảng. |

## Điện thoại · Trang chủ (MOB-07) của ba người

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/01-MOB-07-trang-chu-lanh-dao.png`](mobile/01-MOB-07-trang-chu-lanh-dao.png) | MOB-07 | Trang chủ của Nguyễn Văn An (chủ sở hữu): dải điều hành, ba ô chỉ số, việc theo hạn | Đã mở xem. Nhãn "Lưu ý" một dòng (thay "Cần theo dõi" hai dòng, không trùng chữ "Theo dõi" của thẻ Ban chỉ đạo); ô "Cảnh báo mở" một dòng. |
| [`mobile/02-MOB-07-trang-chu-lanh-dao-cuon-1.png`](mobile/02-MOB-07-trang-chu-lanh-dao-cuon-1.png) | MOB-07 | Cuộn xuống: "Cần bạn quyết định" | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/03-MOB-07-trang-chu-lanh-dao-cuon-2.png`](mobile/03-MOB-07-trang-chu-lanh-dao-cuon-2.png) | MOB-07 | Cuộn tiếp: hết danh sách, "Còn 146 việc nữa, xem trong mục Thông báo" | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/05-MOB-07-trang-chu-projectManager.png`](mobile/05-MOB-07-trang-chu-projectManager.png) | MOB-07 | Trang chủ của Phạm Quốc Dũng (cán bộ Ban quản lý dự án) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/05-MOB-07-trang-chu-projectManager-cuon-xuong.png`](mobile/05-MOB-07-trang-chu-projectManager-cuon-xuong.png) | MOB-07 | Trang chủ của Phạm Quốc Dũng, cuộn xuống | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/06-MOB-07-trang-chu-projectViewer.png`](mobile/06-MOB-07-trang-chu-projectViewer.png) | MOB-07 | Trang chủ của Bùi Thị Mai, cán bộ chỉ có vai nhân viên (STAFF_MEMBER) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/06-MOB-07-trang-chu-projectViewer-cuon-xuong.png`](mobile/06-MOB-07-trang-chu-projectViewer-cuon-xuong.png) | MOB-07 | Cùng màn sau khi vuốt | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Điện thoại · Dự án và chi tiết dự án, bốn tab (MOB-09, MOB-10)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/10-MOB-09-du-an.png`](mobile/10-MOB-09-du-an.png) | MOB-09 | Danh sách dự án | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/85-MOB-09-loi-tat.png`](mobile/85-MOB-09-loi-tat.png) | MOB-09 | Tấm Lối tắt của tab Dự án | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/11-MOB-10-chi-tiet-du-an-tab-tong-quan.png`](mobile/11-MOB-10-chi-tiet-du-an-tab-tong-quan.png) | MOB-10 | DA-PWF-02, tab Tổng quan | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/12-MOB-10-tab-tong-quan-cuon-xuong.png`](mobile/12-MOB-10-tab-tong-quan-cuon-xuong.png) | MOB-10 | Tab Tổng quan sau khi cuộn | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/13-MOB-10-tab-tien-do.png`](mobile/13-MOB-10-tab-tien-do.png) | MOB-10 | Tab Tiến độ: workflow của dự án | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/14-MOB-10-tab-tien-do-cuon-1.png`](mobile/14-MOB-10-tab-tien-do-cuon-1.png) | MOB-10 | Tab Tiến độ, cuộn: việc theo giai đoạn | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/15-MOB-10-tab-tien-do-cuon-2.png`](mobile/15-MOB-10-tab-tien-do-cuon-2.png) | MOB-10 | Tab Tiến độ, cuộn tiếp: tới liên kết "Mở toàn bộ workflow" | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/17-MOB-10-tab-von.png`](mobile/17-MOB-10-tab-von.png) | MOB-10 | Tab Vốn | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/18-MOB-10-tab-ho-so.png`](mobile/18-MOB-10-tab-ho-so.png) | MOB-10 | Tab Hồ sơ | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Điện thoại · Workflow dự án, ba tab (MOB-78)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/20-MOB-78-workflow-tab-tong-quan.png`](mobile/20-MOB-78-workflow-tab-tong-quan.png) | MOB-78 | Tab Tổng quan | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/21-MOB-78-tab-tong-quan-cuon-xuong.png`](mobile/21-MOB-78-tab-tong-quan-cuon-xuong.png) | MOB-78 | Tab Tổng quan, cuộn: các giai đoạn | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/22-MOB-78-tab-cong-viec.png`](mobile/22-MOB-78-tab-cong-viec.png) | MOB-78 | Tab Công việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/23-MOB-78-tab-cong-viec-cuon-xuong.png`](mobile/23-MOB-78-tab-cong-viec-cuon-xuong.png) | MOB-78 | Tab Công việc, cuộn xuống | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/24-MOB-78-tab-moc.png`](mobile/24-MOB-78-tab-moc.png) | MOB-78 | Tab Mốc: mốc chưa xong, mốc đã xong | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Điện thoại · Việc của tôi, ba tab (MOB-80)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/31-MOB-80-tab-can-lam-cuon-xuong.png`](mobile/31-MOB-80-tab-can-lam-cuon-xuong.png) | MOB-80 | Tab Cần làm, cuộn xuống | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/32-MOB-80-tab-can-lam-mau-chinh-thuc.png`](mobile/32-MOB-80-tab-can-lam-mau-chinh-thuc.png) | MOB-80 | Tab Cần làm, màu chính thức | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/33-MOB-80-tab-cho-duyet.png`](mobile/33-MOB-80-tab-cho-duyet.png) | MOB-80 | Tab Chờ duyệt: một việc trình hôm nay | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/34-MOB-80-tab-da-xong.png`](mobile/34-MOB-80-tab-da-xong.png) | MOB-80 | Tab Đã xong: sáu việc trong 90 ngày | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/35-MOB-80-tab-da-xong-cuon-xuong.png`](mobile/35-MOB-80-tab-da-xong-cuon-xuong.png) | MOB-80 | Tab Đã xong, cuộn xuống: "Hiển thị 6 trên 6 việc" | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/30-MOB-80-viec-cua-toi-tab-can-lam.png`](mobile/30-MOB-80-viec-cua-toi-tab-can-lam.png) | MOB-80 | Việc của tôi, tab Cần làm (ảnh đầu của tab) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Điện thoại · Chi tiết việc, bốn tab (MOB-79)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/40-MOB-79-chi-tiet-viec-tab-can-lam.png`](mobile/40-MOB-79-chi-tiet-viec-tab-can-lam.png) | MOB-79 | Tab Cần làm | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/41-MOB-79-tab-can-lam-cuon-xuong-thanh-tab-dinh.png`](mobile/41-MOB-79-tab-can-lam-cuon-xuong-thanh-tab-dinh.png) | MOB-79 | Tab Cần làm sau khi cuộn | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/43-MOB-79-tab-thong-tin.png`](mobile/43-MOB-79-tab-thong-tin.png) | MOB-79 | Tab Thông tin: Phân công | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/44-MOB-79-tab-thong-tin-cuon-xuong.png`](mobile/44-MOB-79-tab-thong-tin-cuon-xuong.png) | MOB-79 | Tab Thông tin, cuộn: vị trí trong quy trình | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/45-MOB-79-tab-can-cu.png`](mobile/45-MOB-79-tab-can-cu.png) | MOB-79 | Tab Căn cứ | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/46-MOB-79-tab-dien-bien.png`](mobile/46-MOB-79-tab-dien-bien.png) | MOB-79 | Tab Diễn biến | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/47-MOB-79-tab-dien-bien-cuon-xuong.png`](mobile/47-MOB-79-tab-dien-bien-cuon-xuong.png) | MOB-79 | Tab Diễn biến, cuộn: lịch sử | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/48-MOB-79-viec-cho-duyet.png`](mobile/48-MOB-79-viec-cho-duyet.png) | MOB-79 | Một việc chờ duyệt hoàn thành | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Điện thoại · Điểm KPI (MOB-81) và nhắc hạn (MOB-82)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/50-MOB-81-diem-kpi-tab-theo-viec.png`](mobile/50-MOB-81-diem-kpi-tab-theo-viec.png) | MOB-81 | Điểm KPI của tôi, tab Theo việc: 86,27, xếp loại Tốt | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/51-MOB-81-tab-dieu-chinh.png`](mobile/51-MOB-81-tab-dieu-chinh.png) | MOB-81 | Tab Điều chỉnh | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/52-MOB-81-tab-cach-tinh.png`](mobile/52-MOB-81-tab-cach-tinh.png) | MOB-81 | Tab Cách tính | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/55-MOB-82-cai-dat-nhac-han.png`](mobile/55-MOB-82-cai-dat-nhac-han.png) | MOB-82 | Cài đặt nhắc hạn | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/56-MOB-82-cai-dat-nhac-han-cuon-xuong.png`](mobile/56-MOB-82-cai-dat-nhac-han-cuon-xuong.png) | MOB-82 | Cài đặt nhắc hạn, cuộn xuống | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Điện thoại · Cá nhân (MOB-47), Thông báo (MOB-32)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/60-MOB-47-ca-nhan.png`](mobile/60-MOB-47-ca-nhan.png) | MOB-47 | Cá nhân: hồ sơ, công việc của tôi, nhắc hạn | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/61-MOB-47-ca-nhan-cuon-1.png`](mobile/61-MOB-47-ca-nhan-cuon-1.png) | MOB-47 | Cá nhân, cuộn: cài đặt, công cụ | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/62-MOB-47-ca-nhan-cuon-2.png`](mobile/62-MOB-47-ca-nhan-cuon-2.png) | MOB-47 | Cá nhân, cuộn tiếp: tài khoản, hỗ trợ | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/70-MOB-32-thong-bao-tab-su-kien.png`](mobile/70-MOB-32-thong-bao-tab-su-kien.png) | MOB-32 | Thông báo, tab Sự kiện (rỗng) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/71-MOB-32-thong-bao-tab-viec-can-xu-ly.png`](mobile/71-MOB-32-thong-bao-tab-viec-can-xu-ly.png) | MOB-32 | Thông báo, tab Việc cần xử lý | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Điện thoại · Phê duyệt (MOB-23, MOB-24) trên bản công

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/75-MOB-23-hop-phe-duyet-ban-cong.png`](mobile/75-MOB-23-hop-phe-duyet-ban-cong.png) | MOB-23 | Hộp phê duyệt của bản công: một hồ sơ chờ quyết định | Đã mở xem. Đếm "5 việc chờ quyết định, 0 quá hạn"; chip "Tất cả 5" và "Phản hồi về điểm đánh giá 1"; nhóm "Chờ quyết định" có hồ sơ phản hồi điểm. |
| [`mobile/76-MOB-24-chi-tiet-phe-duyet-tab-noi-dung.png`](mobile/76-MOB-24-chi-tiet-phe-duyet-tab-noi-dung.png) | MOB-24 | Chi tiết phê duyệt, tab Nội dung | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/72-MOB-23-hop-phe-duyet-nhom-viec-khac.png`](mobile/72-MOB-23-hop-phe-duyet-nhom-viec-khac.png) | MOB-23 | Hộp phê duyệt cuộn xuống: nhóm "Việc khác chờ bạn quyết định" (bốn loại của PWF) | Đã mở xem. ĐẠT: nhóm riêng, mỗi hàng ghi loại hồ sơ, dự án hoặc người, người đề nghị và ngày gửi; huy hiệu tab Phê duyệt là 5. |
| [`mobile/73-MOB-23-tam-quyet-dinh-duyet-hoan-thanh.png`](mobile/73-MOB-23-tam-quyet-dinh-duyet-hoan-thanh.png) | MOB-23 | Tấm quyết định của một hồ sơ duyệt hoàn thành việc | Đã mở xem. ĐẠT: đọc đủ người trình, ngày, dự án, việc, hạn, ngày hoàn thành khai báo trước khi quyết. |
| [`mobile/74-MOB-23-tam-quyet-dinh-cuon-xuong.png`](mobile/74-MOB-23-tam-quyet-dinh-cuon-xuong.png) | MOB-23 | Tấm quyết định cuộn xuống: ô ý kiến, nút Duyệt và Trả lại | Đã mở xem. Ô ý kiến ghi "(bắt buộc khi trả lại)", hai nút Duyệt và Trả lại. |
| [`mobile/79-MOB-23-tam-quyet-dinh-dieu-chinh-diem.png`](mobile/79-MOB-23-tam-quyet-dinh-dieu-chinh-diem.png) | MOB-23 | Tấm quyết định của một đề nghị điều chỉnh điểm | Đã mở xem. ĐẠT: người được chấm, kỳ và trạng thái kỳ, số điểm điều chỉnh, điểm tính được, điểm sau điều chỉnh, xếp loại, lý do. |

## Điện thoại · Văn bản đến (DOC-23, DOC-24) và xem lại báo cáo hiện trường (MOB-20), mỗi màn ba tab

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/80-DOC-23-van-ban-den.png`](mobile/80-DOC-23-van-ban-den.png) | DOC-23 | Văn bản đến cần xử lý | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/86-MOB-20-ra-soat-bao-cao-tab-kiem-tra.png`](mobile/86-MOB-20-ra-soat-bao-cao-tab-kiem-tra.png) | MOB-20 | Rà soát và gửi báo cáo, tab Kiểm tra | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/87-MOB-20-tab-so-lieu.png`](mobile/87-MOB-20-tab-so-lieu.png) | MOB-20 | Tab Số liệu | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/88-MOB-20-tab-thuyet-minh-tep.png`](mobile/88-MOB-20-tab-thuyet-minh-tep.png) | MOB-20 | Tab Thuyết minh, tệp | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Điện thoại · Bản doanh nghiệp (Đạm Phú Mỹ)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/e01-MOB-07-trang-chu.png`](mobile/e01-MOB-07-trang-chu.png) | MOB-07 | Trang chủ điều hành | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/e02-MOB-07-trang-chu-cuon-xuong.png`](mobile/e02-MOB-07-trang-chu-cuon-xuong.png) | MOB-07 | Trang chủ, cuộn xuống | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/e10-MOB-23-hop-phe-duyet.png`](mobile/e10-MOB-23-hop-phe-duyet.png) | MOB-23 | Hộp phê duyệt: sáu báo cáo tuần chờ quyết định | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/e20-MOB-80-viec-cua-toi.png`](mobile/e20-MOB-80-viec-cua-toi.png) | MOB-80 | Việc của tôi: chín việc, đều chưa vào tầm | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/e21-MOB-80-tab-da-xong.png`](mobile/e21-MOB-80-tab-da-xong.png) | MOB-80 | Việc của tôi, tab Đã xong: hai việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/e30-MOB-81-diem-kpi-tab-theo-viec.png`](mobile/e30-MOB-81-diem-kpi-tab-theo-viec.png) | MOB-81 | Điểm KPI của tôi: 70, hai việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/e31-MOB-81-tab-cach-tinh.png`](mobile/e31-MOB-81-tab-cach-tinh.png) | MOB-81 | Tab Cách tính | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/e40-MOB-47-ca-nhan.png`](mobile/e40-MOB-47-ca-nhan.png) | MOB-47 | Cá nhân | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/e50-MOB-32-thong-bao.png`](mobile/e50-MOB-32-thong-bao.png) | MOB-32 | Thông báo, tab Sự kiện (rỗng) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Điện thoại · Chế độ tối (đặt "Tối" trong Cá nhân)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/90-toi-MOB-07-trang-chu.png`](mobile/90-toi-MOB-07-trang-chu.png) | MOB-07 | Trang chủ | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/91-toi-MOB-09-du-an.png`](mobile/91-toi-MOB-09-du-an.png) | MOB-09 | Dự án (đang lọc DA-PWF-02) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/92-toi-MOB-10-chi-tiet-du-an.png`](mobile/92-toi-MOB-10-chi-tiet-du-an.png) | MOB-10 | Chi tiết dự án | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/93-toi-MOB-78-workflow-tab-tong-quan.png`](mobile/93-toi-MOB-78-workflow-tab-tong-quan.png) | MOB-78 | Workflow, tab Tổng quan | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/94-toi-MOB-78-tab-cong-viec.png`](mobile/94-toi-MOB-78-tab-cong-viec.png) | MOB-78 | Workflow, tab Công việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/95-toi-MOB-47-ca-nhan.png`](mobile/95-toi-MOB-47-ca-nhan.png) | MOB-47 | Cá nhân | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/95a-toi-MOB-47-ca-nhan-che-do-giao-dien.png`](mobile/95a-toi-MOB-47-ca-nhan-che-do-giao-dien.png) | MOB-47 | Cá nhân: ô chọn chế độ giao diện đang ở "Tối" | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/96-toi-MOB-80-viec-cua-toi.png`](mobile/96-toi-MOB-80-viec-cua-toi.png) | MOB-80 | Việc của tôi | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/97-toi-MOB-79-chi-tiet-viec.png`](mobile/97-toi-MOB-79-chi-tiet-viec.png) | MOB-79 | Chi tiết việc | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/98-toi-MOB-79-tab-thong-tin.png`](mobile/98-toi-MOB-79-tab-thong-tin.png) | MOB-79 | Chi tiết việc, tab Thông tin | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/99-toi-MOB-81-diem-kpi.png`](mobile/99-toi-MOB-81-diem-kpi.png) | MOB-81 | Điểm KPI của tôi | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`mobile/89-toi-MOB-23-hop-phe-duyet.png`](mobile/89-toi-MOB-23-hop-phe-duyet.png) | MOB-23 | Hộp phê duyệt | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## PWA-02, PWA-03 · Hàng đợi phê duyệt hợp nhất trên web (R54)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/63-PWA-02-hop-phe-duyet-hop-nhat.png`](web/63-PWA-02-hop-phe-duyet-hop-nhat.png) | PWA-02 | Hàng đợi phê duyệt của chủ sở hữu: một hồ sơ của bộ máy phê duyệt (phản hồi về điểm) và bốn loại hồ sơ của PWF | Đã mở xem cỡ đầy đủ. ĐẠT: năm hồ sơ chờ chủ sở hữu, đếm "5 việc chờ duyệt"; mỗi hồ sơ nêu dự án, việc, hạn, lý do, người đề nghị, ngày gửi, kỳ. Sửa trong lượt: tên loại "Phản hồi về điểm đánh giá" thay cho mã score.response, bỏ dòng "Số mục được miễn: Chưa có". |
| [`web/63-PWA-02-hop-quyet-dinh-ho-so-pwf.png`](web/63-PWA-02-hop-quyet-dinh-ho-so-pwf.png) | PWA-02 | Hộp quyết định khi bấm "Duyệt" ở một hồ sơ của PWF (khung nhìn) | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/64-PWA-03-chi-tiet-phan-hoi-ve-diem.png`](web/64-PWA-03-chi-tiet-phan-hoi-ve-diem.png) | PWA-03 | Chi tiết một việc của bộ máy phê duyệt: phản hồi về điểm đọc được nội dung | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |
| [`web/65-390-PWA-02-hop-phe-duyet-hop-nhat.png`](web/65-390-PWA-02-hop-phe-duyet-hop-nhat.png) | PWA-02 | Hàng đợi phê duyệt hợp nhất ở 390 px | Đã mở xem trong tờ ảnh thu nhỏ của lượt fix12; không thấy khác lượt trước (mức tờ ảnh, không phải cỡ đủ đọc từng chữ). |

## Seed: kết quả trên stack sạch

- **Bản công**: `clip-seed apply --dataset public` trên stack sạch, thoát 0, KHÔNG có dòng cảnh báo nào (lượt trước 7 lệnh bị bỏ qua). `clip-seed verify --dataset public`: 54 mục đạt (48 cũ và 6 mới: bốn loại hồ sơ PWF chờ chủ sở hữu, phản hồi điểm chờ trong bộ máy phê duyệt, cán bộ vai nhân viên có việc). Chạy vào Chủ nhật 15/11/2026 nên cũng là bằng chứng cho lần chạy cuối tuần (nghĩa vụ e-GP "sắp đến hạn" vẫn có).
- Đã sửa (7 lệnh của bản công): xác minh chữ ký văn bản do chủ sở hữu làm (quyền `doc.signature.verify`, cán bộ Ban không có); bàn giao hồ sơ ghi `handed_over_at` đúng lúc lệnh (trước đó sớm hơn thời điểm đóng hồ sơ, 422); sinh kỳ báo cáo tháng chỉ khi năm đó chưa có kỳ (nhóm thanh toán và giải ngân cùng sinh, lần sau bị 409 PERIOD_OVERLAP); yêu cầu công bố bảng điều khiển do cán bộ (người làm) gửi, vì quyền `bi.publish.request` là bước của người làm (vai CAN_BO_BAN_QLDA của stack nay có quyền này), lãnh đạo công bố là xử lý yêu cầu đó; ánh xạ e-GP và các nhóm còn lại không bị từ chối ở lượt này.
- Thêm: cán bộ Bùi Thị Mai (khóa `projectViewer`, vai STAFF_MEMBER) có 4 việc; một việc đang chờ chủ sở hữu duyệt hoàn thành; một điều chỉnh điểm chờ; vai kế toán không còn mang quyền "của tôi" riêng (vai STAFF_MEMBER thay).
- **Bản doanh nghiệp**: cả bộ chạy sạch từ đầu trên một stack mới, thoát 0; `verify --dataset enterprise` 30 trên 30 mục. Lượt sạch này còn 2 cảnh báo (lời mời cổng nhà thầu `PORTAL_CONTACT_UNPROVEN`: email của người liên hệ không khớp email trong sổ nhà thầu); đã sửa (cơ sở là thư của người đại diện, kèm tham chiếu) và áp dụng lại riêng nhóm `clip-ent-vendor` trên stack đó: không còn cảnh báo ở lời mời. CHƯA chạy lại cả bộ bản doanh nghiệp sau sửa đó, và lần áp dụng lại nhóm cho thấy hai chỗ chưa idempotent khi chạy lại (đánh giá hiệu quả hợp đồng trùng `EVALUATION_DUPLICATE`; công bố xếp hạng trùng, đã sửa sau đó). 29 việc bỏ qua có chủ đích: kế hoạch vốn chưa hiệu lực ở các tuần của DA-PMDT105 và DA-PMDT130 (10), dossier pháp lý có điều chỉnh chờ quyết định (1), yêu cầu cổng và kế hoạch khắc phục của nhà thầu chưa có tài khoản cổng (6), kênh thông báo chưa xác minh vì stack không có bộ tiêu thụ xác minh của nhà cung cấp (10), vai CAN_BO_BAN_QLDA trong hai lời mời (2: vai mang quyền mà người mời không có).
- Cơ chế mới `ctx.skip`: việc bỏ qua CÓ CHỦ ĐÍCH, kèm lý do, in riêng và không tính là cảnh báo. đã sửa: lời mời cổng nhà thầu (cơ sở REGISTRY_EMAIL không được kèm tham chiếu, và email phải khớp sổ) và công bố xếp hạng do người khác người chấp thuận (SELF_APPROVAL_DENIED).


## Flow Maestro (trình giả lập `guide`, Android 15, bản debug)

- **Bản công**: flow 06 ĐẠT (30 giây); flow 40 ĐẠT đến hết (44 giây; script chặn cổng API 08:22:22 và mở lại 08:22:32); flow 20 KHÔNG ĐẠT 2 mẫu trên 2: dòng "Tổng quan|Việc hôm nay" không hiện trong 2,5 giây sau khởi động nguội trên trình giả lập đồ họa phần mềm (tiêu đề có hiện ngay sau đó, ảnh `mobile/01`); đây là mốc thời gian, không phải chữ sai, và không nói gì về điện thoại thật (verdict vẫn là chưa chạy trên máy của ma trận).
- **Bản doanh nghiệp**: flow 06 ĐẠT; flow 40 ĐẠT; flow 20 KHÔNG ĐẠT 2 mẫu trên 2 (cùng lý do).
- Flow 06 với người khác người thứ nhất (`projectManager`, `projectViewer`) dừng ở bước chờ "Chọn đơn vị và vai trò" (exit 1) vì mỗi người chỉ có một đơn vị; phiên đã mở và trang chủ hiện, ảnh `mobile/05-...` và `mobile/06-...` chụp ở đó.
- Lượt chạy đầu của flow 20 và 40 (chạy ngay sau khi chụp, cùng lúc với stack và trình giả lập 4,3 GB) làm JVM của Maestro hết bộ nhớ (`hs_err_pid*.log`, exit 124 và 139), kèm một lần trình giả lập treo; đã giải phóng bộ nhớ, khởi động lại trình giả lập và chạy lại tuần tự: các số ở trên là của lượt này.

## Khiếm khuyết còn lại, xếp theo mức nghiêm trọng

**Nghiêm trọng**

(không có mục nghiêm trọng mới trong lượt này)

**Trung bình**

1. Hộp phê duyệt hợp nhất: các loại của PWF không có đồng hồ riêng nên không có "quá hạn" và không có nhắc việc theo bộ máy đồng hồ (quyết định ghi ở PWF.md 21.1); chủ nghiệp vụ cần quy định hạn xử lý nếu muốn.
2. Số liệu "Cần xử lý" và huy hiệu tab dùng cùng một đường đọc, nhưng số đếm toàn tenant của trung tâm cảnh báo (88 trên chuông ở bản chụp) gộp nhiều nguồn khác ngoài phê duyệt; chưa có màn nào tách riêng "phần phê duyệt" trong con số đó.
3. Dòng cuối bảng "Xem trước màu" ở 390 px (PWF-15) bị cắt ở khung cuộn của bảng.
4. Ô ngày trên web hiện theo ngôn ngữ của trình duyệt (mục 23 của lượt trước, chưa làm).
5. Người được giao việc ở dự án của đơn vị khác chỉ thao tác được khi quyền `pwf.task.work` của họ phủ dự án đó: vai STAFF_MEMBER cấp phạm vi cả tenant nên đã phủ; vai tùy biến thì không.

**Nhẹ**

6. Hồ sơ trên hộp hợp nhất của web chỉ có nút "Mở hồ sơ đầy đủ" tới màn của PWF, không có màn chi tiết riêng cho từng loại.
7. Khoảng trắng nhỏ giữa dòng "Gửi ngày ..." và danh sách dữ kiện trong thẻ hồ sơ của web.

## Chưa làm trong lượt này

- Ảnh điện thoại của văn bản đến (DOC-24, ba tab): màn DOC-23 chụp được (một văn bản "Giấy mời họp giao ban"), nhưng bước mở văn bản của kịch bản tìm sai tên nên ba tab DOC-24 chưa chụp lại; MOB-20 (rà soát báo cáo) chụp được cả ba tab.
- Mục 23 (ô ngày theo ngôn ngữ trình duyệt).
- Bấm quyết định thật trên stack chụp: không làm, để ảnh giữ nguyên dữ liệu; luồng quyết định được kiểm bằng test API (`pending-decisions.test.ts`), widget (`PendingDecisionsSection.test.tsx`, `pending_decisions_test.dart`).
- Xóa khóa i18n cũ: danh sách ở báo cáo của làn.
