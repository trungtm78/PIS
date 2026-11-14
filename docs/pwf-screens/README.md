# Ảnh chụp màn hình phần workflow dự án (PWF), có dữ liệu

Chụp lại toàn bộ đêm 14 rạng sáng 15/11/2026 từ nhánh `lane/shots3` (từ `main` cc1b5a6f8, sau làn fix10) trên ứng dụng chạy thật: API trên PostgreSQL nhúng, seed `clip-seed apply --dataset public` chạy trọn trên một stack sạch, web dựng ở chế độ development và chụp bằng Chromium của Playwright (1440×900, ảnh toàn trang; vài ảnh là khung nhìn khi mở hộp hoặc sau khi cuộn, và mười ảnh rộng 390 px); điện thoại là APK debug dựng từ nhánh với `--dart-define=MACHVON_ALLOW_SCREENSHOTS=true`, AVD `guide` (720×1560, cỡ chữ 100%), ảnh lấy bằng `adb exec-out screencap -p`. Không có ảnh mock và không có ảnh golden. Ảnh của các lượt trước đã xóa hết.

Tổng cộng 157 ảnh: 90 ảnh web, 67 ảnh điện thoại. Tôi đã mở xem 157 ảnh (cột cuối ghi từng ảnh). Với ảnh web, phần lớn được xem ở bản chụp ngay trước bản cuối: bản cuối chụp lại cả bộ sau các sửa cuối cùng (hộp "i", câu của băng số liệu cũ, bảng dạng thẻ), cùng bố cục; các ảnh bị các sửa đó đụng tới (hộp "i", mọi ảnh 390 px, PWF-12, PWF-14, PRJ-03 và PWF-03 tab đầu) đã được xem lại ở bản cuối. Ảnh web dài được xem ở cỡ thu nhỏ theo từng tờ hai ảnh, chỗ nghi ngờ thì cắt ra xem cỡ thật; ảnh điện thoại xem theo tờ năm ảnh ở nửa cỡ. Với mọi ảnh web, kịch bản chụp đo được: không có lỗi JavaScript, không có khóa dịch lộ ra, và trang không cuộn ngang.

Xem dạng lưới có mục lục theo màn rồi theo tab: [index.html](index.html).

## Kết quả xác nhận 11 mục của làn fix10 trên màn thật

| # | Mục | Kết quả | Ảnh |
|---|---|---|---|
| 1 | Điểm tạm tính giữa kỳ, phân bố điểm có nghĩa | ĐẠT sau khi sửa seed. Lượt seed đầu: cả đơn vị 21 đến 28 điểm, ai cũng "Cần cải thiện" (việc xong ít, việc trễ nhiều). Sau khi sửa: 3 người Tốt (86,27; 87,5; 79,78), 2 người Đạt (72,37; 63,5), 2 người Cần cải thiện (58,67; 55,04 điều chỉnh thành 58,04), 2 người chưa có điểm. Việc chưa đến hạn ghi "Chưa đến hạn, chưa chấm"; kỳ nháp ghi "Tạm tính đến ngày 14/11/2026"; kỳ chốt sớm ghi "Kỳ được chốt sớm, số liệu tính đến ngày..." | `web/54-PWF-12-bang-diem-don-vi`, `web/54-PWF-12-ky-tam-tinh-cua-so`, `web/57-PWF-14-ky-tam-tinh-cua-so`, `web/58-PWF-14-hop-chot-som-can-ly-do`, `web/52-...-2-theo-viec`, `mobile/50` |
| 2 | Tab KPI của PWF-04, ba trạng thái | ĐẠT HAI TRÊN BA. "Có kết quả" (việc đã xong) và "Chưa có kết quả" (việc đang làm) thấy trên màn. Trạng thái "không có quyền" KHÔNG dựng được trên stack thật: đọc việc và đọc KPI của việc cùng một quyền `pwf.read`, ai mở được việc thì đọc được KPI; trạng thái này chỉ có kiểm thử đơn vị | `web/35-PWF-04-viec-da-xong-tab-kpi`, `web/30-...-tab-6-kpi` |
| 3 | Tab "Đã xong" của Việc của tôi | ĐẠT trên web (6 việc của lãnh đạo, 13 việc của cán bộ, đúng hạn hoặc trễ hạn) và trên điện thoại (6 việc) | `web/49-PWF-15-viec-da-xong-gan-day`, `web/49-...-can-bo`, `mobile/34`, `mobile/35` |
| 4 | PWF-06 không còn báo thiếu lịch 2029 | ĐẠT: không còn băng cảnh báo, ngày kết thúc dự kiến 24/11/2028 | `web/39-PWF-06-doi-lich-de-nghi-dang-cho`, `web/62-ADM-07-lich-cong-tac` |
| 5 | Bảng deadline: "Đang hiện N trên M", "Xem thêm", xuất Excel | ĐẠT: 50 trên 137, sau "Xem thêm" 100 trên 137, "Còn 37 việc chưa hiện"; tệp xlsx mở ra có đúng 137 dòng dữ liệu. Còn thấy trong tệp: trang tính tên "DIS-export", hàng tiêu đề cột là khóa tiếng Anh | `web/40`, `web/43-PWF-07-sau-khi-xem-them-va-xuat-excel`, `web/43-PWF-07-cuoi-danh-sach-nut-xem-them` |
| 6 | Không còn mã lộ ở PWF-01, 02, 14, 16 và tab Kế hoạch | ĐẠT sau khi sửa seed. Lượt seed đầu PWF-01 vẫn hiện ROAD_REPAIR vì lệnh thêm loại dự án bị từ chối (403 POLICY_LOCKED: loại của tỉnh phải là mở rộng của một loại của hệ thống). PWF-02, 14, 16 và tab Kế hoạch đạt ngay | `web/10`, `web/12-PWF-02-tab-1-...`, `web/57-PWF-14-ky-cham-diem`, `web/38-PWF-16-so-phan-cong`, `web/22-PRJ-03-tab-ke-hoach` |
| 7 | PWF-09 bốn tab | ĐẠT. Tab Thang điểm còn dài hơn 5.000 px | `web/50-PWF-09-bo-kpi-tab-1` đến `tab-4` |
| 8 | Bảng dạng thẻ ở 390 px | ĐẠT SAU KHI SỬA MÃ. Lượt chụp đầu: các dòng trong mỗi thẻ chồng lên nhau ở PWF-01, PWF-07 và cây công việc (mọi ô bị ghim cao 44 px), thẻ của PWF-12 lấy dấu gạch làm tiêu đề. Đã sửa, chụp lại | `web/92`, `web/94`, `web/95`, `web/96`, `web/98`, `web/99` |
| 9 | Các sửa điện thoại | ĐẠT: câu cảnh báo hiện đủ, nhãn tab đáy một dòng, hàng Phê duyệt có người trình và ngày trình, câu rỗng riêng của Thông báo, chi tiết văn bản đến không còn thanh đáy, câu lỗi của MOB-20 hiện đủ | `mobile/01`, `mobile/02`, `mobile/70`, `mobile/71`, `mobile/75`, `mobile/81`, `mobile/86` |
| 10 | Trang chủ cán bộ khác trang chủ lãnh đạo | CHƯA ĐẠT trên bộ dữ liệu. Cán bộ Ban quản lý dự án (Phạm Quốc Dũng) vẫn nhận bố cục lãnh đạo vì vai trò của anh trong bộ dữ liệu mang quyền `committee.read`. Người không có quyền quyết định (kế toán Hoàng Thị Lan) nhận đúng tiêu đề "Việc hôm nay" nhưng thân màn là lỗi SCOPE_DENIED vì vai trò của chị không có `home.read`. Mã của R53 chạy đúng theo quyền; bộ dữ liệu không có người nào cho thấy trang chủ cán bộ có nội dung | `mobile/05-MOB-07-trang-chu-projectManager`, `mobile/06-MOB-07-trang-chu-treasuryMaker` |
| 11 | Hộp Phê duyệt bản công có hồ sơ chờ duyệt | ĐẠT sau khi sửa seed. Lượt seed đầu hộp vẫn rỗng: nhóm `clip-public-approvals` đọc `period_status` ở sai chỗ của câu trả lời nên không gửi phản hồi nào. Sau khi sửa: một hồ sơ "Phản hồi về điểm đánh giá" chờ chủ sở hữu | `mobile/75-MOB-23-hop-phe-duyet-ban-cong`, `mobile/76`, `mobile/77`, `mobile/78` |

## Cách dựng lại

- Stack và web: chạy `uat/run/.../tools/serve-edition.mjs public <thư mục> <cổng API> <cổng IdP> <cổng web>` (dựng web tĩnh ở chế độ development, chạy `npm run e2e:stack -w @machvon/api`, rồi `node scripts/clip-seed.mjs apply --dataset public`). Đăng nhập web bằng `?devUser=<người>`.
- Điện thoại: `flutter build apk --debug --dart-define=MACHVON_API_BASE_URL=http://127.0.0.1:<cổng API> --dart-define=MACHVON_OIDC_ISSUER=http://127.0.0.1:<cổng IdP>/realms/machvon --dart-define=MACHVON_OIDC_CLIENT_ID=machvon-web --dart-define=MACHVON_ALLOW_SCREENSHOTS=true` (bản doanh nghiệp thêm `--dart-define=MACHVON_EDITION=enterprise`); `adb root` trước, rồi `adb reverse` hai cổng; `adb shell cmd locale set-app-locales vn.machvon.app --locales vi-VN`; đăng nhập bằng `maestro test apps/mobile/qa/device/flows/06_sign_in_test_idp.yaml`. Muốn đăng nhập người khác người thứ nhất: ghi khóa của người đó (ví dụ `projectManager`) vào tệp `<stack-info.json>.user` trước khi đăng nhập (flow sẽ dừng ở bước chọn đơn vị vì người đó chỉ có một đơn vị, nhưng phiên đã mở).
- Chế độ tối: chọn "Tối" trong Cá nhân, mục Chế độ giao diện. Lệnh `cmd uimode night yes` của máy không đổi được khi ứng dụng đang đặt "Sáng".
- Cờ `MACHVON_ALLOW_SCREENSHOTS` chỉ có hiệu lực ở bản debug; bản release luôn chặn chụp màn Phê duyệt.

## Seed: kết quả chạy trên stack sạch và những gì đã sửa

- Bản công, lượt đầu (mã của `main`): 618 lệnh của nhóm `clip-public-pwf-review` chạy xong nhưng hai chỗ mới của làn fix10 KHÔNG có tác dụng: (a) `POST /master-records` cho loại dự án ROAD_REPAIR bị từ chối 403 `POLICY_LOCKED` (`parent_record_id`); (b) nhóm `clip-public-approvals` ghi "projectManager has no line in a locked scoring period" và không gửi phản hồi nào. Ngoài ra kỳ chấm điểm không có tín hiệu nào (việc được chuyển người còn trong hạn nên R50 bỏ qua), và điểm cả đơn vị từ 21 đến 28.
- Đã sửa trong làn này: loại dự án của tỉnh là mở rộng của một loại của hệ thống (ROAD_REPAIR dưới "Cải tạo, nâng cấp, mở rộng"; thêm SCHOOL_EQUIPMENT dưới "Mua sắm"); nhóm phê duyệt đọc đúng dòng điểm nằm trong từng mục (period, line); mỗi dự án có người làm, cán bộ phối hợp và kết cục từng việc ghi rõ trong seed (xong đúng ngày, xong trễ 1 đến 5 ngày làm việc, còn mở và trễ, trình hôm nay chờ duyệt, trình rồi bị trả lại); mốc mà mọi việc đứng trước đã xong được ghi nhận; việc trễ được chuyển người một ngày trước hạn (có tín hiệu "Đổi người sát hạn"); chính sách chấm điểm của tỉnh xếp loại từ 3 việc; thêm một kỳ nháp của Sở Kế hoạch và Đầu tư để có số "tạm tính"; nhóm e-GP mở nghĩa vụ đăng tải ở nhiều ngày hơn để luôn có một nghĩa vụ "sắp đến hạn" (`clip-seed verify` hỏng ở mục này khi chạy vào thứ Bảy).
- Bản công, lượt cuối trên stack sạch: cả bộ chạy trọn, thoát 0. Ba nhóm PWF (`clip-public-pwf-review` 729 lệnh, `clip-public-approvals`, `clip-public-phone-work`) không có lệnh nào bị từ chối. Còn 7 lệnh bị từ chối được seed bỏ qua ở các nhóm KHÁC, có từ trước và không sửa trong làn này: `clip-public-documents` (xác minh chữ ký 403 SCOPE_DENIED; bàn giao hồ sơ 422 `handed_over_at`), `clip-public-payments` và `clip-public-disbursement` (sinh kỳ báo cáo 409 PERIOD_OVERLAP, mỗi nhóm một lần), `clip-public-egp` (quyết định ánh xạ 409 CROSSWALK_DUPLICATE), `clip-public-bi` (hai yêu cầu công bố 403 SCOPE_DENIED).
- `clip-seed verify` bản công trên stack đó: 47 mục đạt, 1 mục hỏng ("egp obligations due soon: 0"). Seed e-GP đã sửa như trên nhưng CHƯA chạy lại `verify` trên một stack sạch sau khi sửa.
- Bản doanh nghiệp: CHƯA chạy lại trong làn này.
- Giới hạn còn lại của seed điểm: seed khai ngày hoàn thành lùi về quá khứ còn chứng từ nộp vào ngày chạy seed, nên KPI "Độ đầy đủ của chứng từ" của việc đã xong ra 0 (điểm việc đúng hạn là 80 thay vì 100). Phân bố điểm tính theo quý chứa ngày chạy seed; chạy đầu một quý thì kỳ gần như rỗng.


## PRJ-02 · Tạo dự án, mục "Loại quy trình xử lý"

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/01-PRJ-02-dang-ky-du-an-loai-quy-trinh.png`](web/01-PRJ-02-dang-ky-du-an-loai-quy-trinh.png) | PRJ-02 | Tạo dự án đã nhập đủ: đề xuất của hệ thống, lý do, bốn ô chọn, xem trước lịch (13 bước, 503 ngày làm việc) | Đã mở xem bản cuối. Loại dự án do tỉnh đặt nay hiện tên ("Sửa chữa đường giao thông", "Mua sắm thiết bị trường học") trong ô chọn. Còn thấy: hai nhóm trường có khung viền của trình duyệt; thẻ lồng thẻ; mã PUBLIC_INVESTMENT cạnh tên loại quy trình. |

## PWF-01, PWF-02, PWF-05 · Thư viện mẫu, trình soạn (từng tab và tab con), khởi tạo và tiếp nhận

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/10-PWF-01-thu-vien-mau.png`](web/10-PWF-01-thu-vien-mau.png) | PWF-01 | Thư viện mẫu: năm mẫu, phiên bản, hiệu lực, cờ | Đã mở xem bản cuối. Mục 6 ĐẠT: cột Loại dự án ghi tên, mã là dòng nhỏ bên dưới (cả hai loại do tỉnh đặt; lượt seed đầu của làn này bị từ chối nên vẫn hiện mã, đã sửa seed). |
| [`web/11-PWF-01-so-sanh-hai-phien-ban.png`](web/11-PWF-01-so-sanh-hai-phien-ban.png) | PWF-01 | So sánh phiên bản 1 và 2 của mẫu sửa chữa đường của tỉnh | Đã mở xem bản cuối. Bảng quy mô và hai thay đổi đọc rõ. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec.png) | PWF-02 | Trình soạn, tab Cấu trúc; khung soạn việc ở tab con Thông tin | Đã mở xem bản cuối. Mục 6 ĐẠT: tiêu đề khung soạn việc là tên việc "Lập hồ sơ sửa chữa và dự toán", mã RR_ESTIMATE ở dòng phụ. Còn thấy: ô "Loại dự án" của mẫu là ô nhập mã (ROAD_REPAIR); mỗi giai đoạn có một hàng ô đánh dấu dài. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-2-thoi-han-va-phu-thuoc.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-2-thoi-han-va-phu-thuoc.png) | PWF-02 | Tab con Thời hạn và phụ thuộc | Đã mở xem bản cuối. Còn thấy: nút "Bỏ liên kết" đứng thấp hơn các ô cùng hàng. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-3-chung-tu-va-bieu-mau.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-3-chung-tu-va-bieu-mau.png) | PWF-02 | Tab con Chứng từ và biểu mẫu: chọn biểu mẫu từ kho | Đã mở xem bản cuối. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-4-danh-muc-kiem.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-4-danh-muc-kiem.png) | PWF-02 | Tab con Danh mục kiểm | Đã mở xem bản cuối. Còn thấy: ô "Nội dung mục" hẹp nên chữ bị cắt trong ô. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-5-kpi.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-5-kpi.png) | PWF-02 | Tab con KPI: sáu KPI của workflow | Đã mở xem bản cuối. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-6-can-cu.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-6-can-cu.png) | PWF-02 | Tab con Căn cứ | Đã mở xem bản cuối. |
| [`web/12-PWF-02-tab-2-buoc-va-can-cu-phap-ly.png`](web/12-PWF-02-tab-2-buoc-va-can-cu-phap-ly.png) | PWF-02 | Tab Bước và căn cứ pháp lý | Đã mở xem bản cuối. Còn thấy: ô "Vai trò chịu trách nhiệm bước" có nhãn hai dòng nên lệch lên so với ba ô bên trái; vai trò là mã (SITE_ENGINEER). |
| [`web/12-PWF-02-tab-3-vai-tro.png`](web/12-PWF-02-tab-3-vai-tro.png) | PWF-02 | Tab Vai trò: chín mã vai trò và ô đặt tên | Đã mở xem bản cuối. Mỗi mã vai trò có tên trong danh mục của hệ thống ghi bên dưới. |
| [`web/12-PWF-02-tab-4-kiem-tra-va-xem-truoc-lich.png`](web/12-PWF-02-tab-4-kiem-tra-va-xem-truoc-lich.png) | PWF-02 | Tab Kiểm tra và xem trước lịch | Đã mở xem bản cuối. Còn thấy: chưa bấm xem trước nên khối lịch là lời nhắc; "Dấu vân tay của mẫu" là chuỗi kỹ thuật. |
| [`web/15-PWF-05-khoi-tao-workflow-xem-truoc-lich.png`](web/15-PWF-05-khoi-tao-workflow-xem-truoc-lich.png) | PWF-05 | Khởi tạo workflow cho DA-CN026, đã xem trước lịch | Đã mở xem bản cuối. |
| [`web/16-PWF-05-tiep-nhan-workflow-chay-thu.png`](web/16-PWF-05-tiep-nhan-workflow-chay-thu.png) | PWF-05 | Tiếp nhận workflow cho dự án đang chạy: kết quả chạy thử từng việc | Đã mở xem bản cuối. Còn thấy: bảng dài 34 dòng, mỗi dòng một ô chọn. |

## PRJ-03 · Không gian dự án, mọi tab; tab Workflow có năm tab con

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/20-PRJ-03-tab-tong-quan.png`](web/20-PRJ-03-tab-tong-quan.png) | PRJ-03 | DA-PWF-02, tab Tổng quan | Đã mở xem bản cuối. Còn thấy: nhiều dòng "Chưa có" (dự án ở giai đoạn Ý tưởng); khối "Cập nhật thông tin" bên phải bị cắt ở đáy, phải cuộn trong khung. |
| [`web/21-PRJ-03-tab-muc-tieu.png`](web/21-PRJ-03-tab-muc-tieu.png) | PRJ-03 | Tab Mục tiêu | Đã mở xem bản cuối. Còn thấy: bốn khối chỉ có lời nhắc "chưa có". |
| [`web/22-PRJ-03-tab-ke-hoach.png`](web/22-PRJ-03-tab-ke-hoach.png) | PRJ-03 | Tab Kế hoạch: mốc tiến độ lấy từ workflow | Đã mở xem bản cuối. Mục 6 ĐẠT: tên mốc đứng trước, mã ở dòng phụ, ngày dạng dd/mm/yyyy. Ba mốc đầu ghi "Hoàn thành" với ngày thực tế (seed nay ghi nhận mốc; trước đó mốc mà mọi việc đã xong vẫn hiện "Trễ 58 ngày"). Còn thấy: bốn khối dưới rỗng. |
| [`web/23-PRJ-03-tab-workflow-1-tong-quan.png`](web/23-PRJ-03-tab-workflow-1-tong-quan.png) | PRJ-03 | Tab Workflow, tab con Tổng quan | Đã mở xem bản cuối. Ba giai đoạn đầu "Xong", giai đoạn thứ tư "Đang ở đây". |
| [`web/23-PRJ-03-tab-workflow-2-cong-viec.png`](web/23-PRJ-03-tab-workflow-2-cong-viec.png) | PRJ-03 | Tab con Công việc: cây giai đoạn, bước, việc | Đã mở xem bản cuối. Mã việc là dòng nhỏ dưới tên; việc đã xong có người làm và ngày. |
| [`web/23-PRJ-03-tab-workflow-3-lich.png`](web/23-PRJ-03-tab-workflow-3-lich.png) | PRJ-03 | Tab con Lịch: Gantt | Đã mở xem bản cuối. Việc xong trễ một ngày có nhãn "+1 ngày". |
| [`web/23-PRJ-03-tab-workflow-4-moc-va-cong.png`](web/23-PRJ-03-tab-workflow-4-moc-va-cong.png) | PRJ-03 | Tab con Mốc và cổng | Đã mở xem bản cuối. |
| [`web/23-PRJ-03-tab-workflow-5-bang-cot.png`](web/23-PRJ-03-tab-workflow-5-bang-cot.png) | PRJ-03 | Tab con Bảng cột | Đã mở xem bản cuối. Còn thấy: sáu cột không vừa chiều ngang, phải cuộn trong khung. |
| [`web/24-PRJ-03-tab-giai-ngan.png`](web/24-PRJ-03-tab-giai-ngan.png) | PRJ-03 | Tab Giải ngân | Đã mở xem bản cuối. Còn thấy: ba khối rỗng (dự án chưa có kế hoạch vốn). |
| [`web/25-PRJ-03-tab-vuong-mac.png`](web/25-PRJ-03-tab-vuong-mac.png) | PRJ-03 | Tab Vướng mắc | Đã mở xem bản cuối. Còn thấy: bốn khối rỗng. |

## PWF-03 · Workflow của dự án theo mẫu của tỉnh

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/29-PWF-03-mau-cua-tinh-tab-1-tong-quan.png`](web/29-PWF-03-mau-cua-tinh-tab-1-tong-quan.png) | PWF-03 | DA-PWF-04, tab Tổng quan | Đã mở xem bản cuối. |
| [`web/29-PWF-03-mau-cua-tinh-tab-2-cong-viec.png`](web/29-PWF-03-mau-cua-tinh-tab-2-cong-viec.png) | PWF-03 | Tab Công việc | Đã mở xem bản cuối. Việc chờ duyệt hoàn thành, việc đỏ, việc đã xong cùng trong một cây. Còn thấy: cột cuối (Tiến độ) bị cắt ở mép phải khi tên việc dài. |
| [`web/29-PWF-03-mau-cua-tinh-tab-3-lich.png`](web/29-PWF-03-mau-cua-tinh-tab-3-lich.png) | PWF-03 | Tab Lịch | Đã mở xem bản cuối. |
| [`web/29-PWF-03-mau-cua-tinh-tab-4-moc-va-cong.png`](web/29-PWF-03-mau-cua-tinh-tab-4-moc-va-cong.png) | PWF-03 | Tab Mốc và cổng | Đã mở xem bản cuối. Còn thấy: mẫu của tỉnh không khai cổng nên khối cổng chỉ có một câu. |
| [`web/29-PWF-03-mau-cua-tinh-tab-5-bang-cot.png`](web/29-PWF-03-mau-cua-tinh-tab-5-bang-cot.png) | PWF-03 | Tab Bảng cột | Đã mở xem bản cuối. |

## PWF-04, PWF-16, PWF-06 · Chi tiết công việc (sáu tab), sổ phân công, dời lịch

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/30-PWF-04-viec-dang-lam-tab-1-viec-can-lam.png`](web/30-PWF-04-viec-dang-lam-tab-1-viec-can-lam.png) | PWF-04 | Việc đang làm và trễ, tab Việc cần làm | Đã mở xem bản cuối. Chứng từ ghi tên biểu mẫu. |
| [`web/30-PWF-04-viec-dang-lam-tab-2-can-cu-phap-ly.png`](web/30-PWF-04-viec-dang-lam-tab-2-can-cu-phap-ly.png) | PWF-04 | Tab Căn cứ pháp lý | Đã mở xem bản cuối. |
| [`web/30-PWF-04-viec-dang-lam-tab-3-lich-va-phan-cong.png`](web/30-PWF-04-viec-dang-lam-tab-3-lich-va-phan-cong.png) | PWF-04 | Tab Lịch và phân công: sổ phân công có ba người | Đã mở xem bản cuối. |
| [`web/30-PWF-04-viec-dang-lam-tab-4-ngoai-le.png`](web/30-PWF-04-viec-dang-lam-tab-4-ngoai-le.png) | PWF-04 | Tab Ngoại lệ: một đề nghị chờ duyệt | Đã mở xem bản cuối. |
| [`web/30-PWF-04-viec-dang-lam-tab-5-lich-su.png`](web/30-PWF-04-viec-dang-lam-tab-5-lich-su.png) | PWF-04 | Tab Lịch sử | Đã mở xem bản cuối. |
| [`web/30-PWF-04-viec-dang-lam-tab-6-kpi.png`](web/30-PWF-04-viec-dang-lam-tab-6-kpi.png) | PWF-04 | Tab KPI | Đã mở xem bản cuối. Mục 2 ĐẠT (trạng thái "chưa có kết quả"): "Chưa có kết quả KPI. Kết quả được tính khi công việc hoàn thành hoặc bị hủy." Không còn thẻ "không có quyền". |
| [`web/31-PWF-04-dau-trang-dinh-sau-khi-cuon.png`](web/31-PWF-04-dau-trang-dinh-sau-khi-cuon.png) | PWF-04 | Khung nhìn sau khi cuộn 520 px | Đã mở xem bản cuối. Đầu trang tóm tắt dính ở đầu khung nhìn. |
| [`web/32-PWF-04-viec-cho-duyet-nguoi-duyet-xem.png`](web/32-PWF-04-viec-cho-duyet-nguoi-duyet-xem.png) | PWF-04 | Việc chờ duyệt hoàn thành, nhìn bằng tài khoản lãnh đạo | Đã mở xem bản cuối. Có nút "Duyệt hoàn thành" và "Trả lại" (việc được trình hôm nay, còn trong hạn). |
| [`web/33-PWF-04-viec-da-xong-tab-lich-su.png`](web/33-PWF-04-viec-da-xong-tab-lich-su.png) | PWF-04 | Việc đã xong, tab Lịch sử | Đã mở xem bản cuối. |
| [`web/34-PWF-04-hop-thoai-hoan-thanh.png`](web/34-PWF-04-hop-thoai-hoan-thanh.png) | PWF-04 | Hộp thoại Hoàn thành công việc | Đã mở xem bản cuối. Còn thấy: nhãn "Công việc" trong hộp gãy hai dòng. |
| [`web/35-PWF-04-viec-da-xong-tab-kpi.png`](web/35-PWF-04-viec-da-xong-tab-kpi.png) | PWF-04 | Việc đã xong, tab KPI | Đã mở xem bản cuối. Mục 2 ĐẠT (trạng thái "có kết quả"): hai KPI của việc đã xong với giá trị, điểm, trọng số. Còn thấy: cột "Dữ kiện nguồn" là chuỗi JSON thô và bị cắt ở mép phải; "Độ đầy đủ của chứng từ" ra 0 vì seed khai ngày hoàn thành lùi về quá khứ còn chứng từ nộp hôm nay. |
| [`web/38-PWF-16-so-phan-cong.png`](web/38-PWF-16-so-phan-cong.png) | PWF-16 | Sổ phân công của việc được chuyển người trước hạn | Đã mở xem bản cuối. Mục 6 ĐẠT: tiêu đề là tên việc, mã PREP_NEEDS ở góc phải. Bốn dòng: người làm cũ (04/11 đến 08/11), người làm mới (từ 09/11, một ngày trước hạn), người chịu trách nhiệm, người tham vấn. |
| [`web/39-PWF-06-doi-lich-de-nghi-dang-cho.png`](web/39-PWF-06-doi-lich-de-nghi-dang-cho.png) | PWF-06 | Dời lịch của DA-PWF-01, có đề nghị đang chờ, nhìn bằng tài khoản lãnh đạo | Đã mở xem bản cuối. Mục 4 ĐẠT: không còn băng "thiếu lịch làm việc năm 2029"; "Dự án kết thúc dự kiến 24/11/2028" có ngày. Còn thấy: bảng trước/sau có cột cuối bị cắt ở mép phải. |

## PWF-07, PWF-08, PWF-15 · Bảng deadline (từng tab), chính sách ba màu, nhắc hạn

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/40-PWF-07-tab-danh-sach.png`](web/40-PWF-07-tab-danh-sach.png) | PWF-07 | Bảng deadline, tab Danh sách | Đã mở xem bản cuối. Mục 5 ĐẠT: "Đang hiện 50 trên 137 việc", nút "Xuất Excel (137 việc)"; không còn băng "Danh sách bị cắt". |
| [`web/41-PWF-07-loc-mau-do.png`](web/41-PWF-07-loc-mau-do.png) | PWF-07 | Lọc màu đỏ bằng thẻ đếm | Đã mở xem bản cuối. |
| [`web/42-PWF-07-hop-giai-thich-nut-i.png`](web/42-PWF-07-hop-giai-thich-nut-i.png) | PWF-07 | Hộp giải thích của nút "i" trên dải số đếm (khung nhìn) | Đã mở xem bản cuối. Hộp nằm trọn trong trang. |
| [`web/43-PWF-07-sau-khi-xem-them-va-xuat-excel.png`](web/43-PWF-07-sau-khi-xem-them-va-xuat-excel.png) | PWF-07 | Sau khi bấm "Xem thêm" và "Xuất Excel" | Đã mở xem bản cuối. Mục 5 ĐẠT: "Đang hiện 100 trên 137 việc"; dòng "Đã xuất tệp bang-deadline-2026-11-14.xlsx với đủ 137 việc". Tệp đã mở kiểm: 137 dòng dữ liệu. Còn thấy: tên trang tính là "DIS-export" và hàng tiêu đề cột là khóa tiếng Anh (project_code, task...). |
| [`web/43-PWF-07-cuoi-danh-sach-nut-xem-them.png`](web/43-PWF-07-cuoi-danh-sach-nut-xem-them.png) | PWF-07 | Cuối danh sách (khung nhìn): còn bao nhiêu việc chưa hiện | Đã mở xem bản cuối. Mục 5 ĐẠT: "Còn 37 việc chưa hiện trong tổng số 137." và nút "Xem thêm". |
| [`web/44-PWF-07-tab-lich-thang.png`](web/44-PWF-07-tab-lich-thang.png) | PWF-07 | Tab Lịch tháng | Đã mở xem bản cuối. |
| [`web/45-PWF-07-tab-moc-30-ngay.png`](web/45-PWF-07-tab-moc-30-ngay.png) | PWF-07 | Tab Mốc 30 ngày tới | Đã mở xem bản cuối. |
| [`web/46-PWF-07-tab-tai-cong-viec.png`](web/46-PWF-07-tab-tai-cong-viec.png) | PWF-07 | Tab Tải công việc theo người và tuần | Đã mở xem bản cuối. Còn thấy: chỉ hai người có việc ở vai trò người làm. |
| [`web/47-PWF-08-chinh-sach-ba-mau.png`](web/47-PWF-08-chinh-sach-ba-mau.png) | PWF-08 | Chính sách ba màu của tỉnh, phiên bản đã duyệt | Đã mở xem bản cuối. Còn thấy: dòng giải thích nêu ba mã nguồn cảnh báo (HOME_WORK...). |
| [`web/50-PWF-09-bo-kpi-tab-1-danh-muc-kpi.png`](web/50-PWF-09-bo-kpi-tab-1-danh-muc-kpi.png) | PWF-09 | Bộ KPI, tab Danh mục KPI: sáu KPI, ô tìm, "Đang hiện 6 trên 6 KPI" | Đã mở xem bản cuối. Mục 7 ĐẠT: bốn tab; trang cao 2.400 px (trước là một trang gần 9.000 px). |
| [`web/50-PWF-09-bo-kpi-tab-2-thang-diem.png`](web/50-PWF-09-bo-kpi-tab-2-thang-diem.png) | PWF-09 | Tab Thang điểm: thang và đường quy đổi của từng KPI | Đã mở xem bản cuối. Còn thấy: tab này vẫn dài hơn 5.000 px (sáu khối thang điểm xếp dọc). |
| [`web/50-PWF-09-bo-kpi-tab-3-ap-dung-cho-mau-va-viec.png`](web/50-PWF-09-bo-kpi-tab-3-ap-dung-cho-mau-va-viec.png) | PWF-09 | Tab Áp dụng cho mẫu và việc | Đã mở xem bản cuối. Còn thấy: ô "Giai đoạn", "Việc" nhập mã cách nhau bằng dấu phẩy. |
| [`web/50-PWF-09-bo-kpi-tab-4-phien-ban.png`](web/50-PWF-09-bo-kpi-tab-4-phien-ban.png) | PWF-09 | Tab Phiên bản: lưu bản nháp và lịch sử | Đã mở xem bản cuối.  |
| [`web/48-PWF-15-nhac-han-cua-toi.png`](web/48-PWF-15-nhac-han-cua-toi.png) | PWF-15 | Nhắc hạn của tôi: ngưỡng riêng, bảng xem trước, việc sắp tới | Đã mở xem bản cuối. |
| [`web/49-PWF-15-viec-da-xong-gan-day.png`](web/49-PWF-15-viec-da-xong-gan-day.png) | PWF-15 | Việc của tôi, nút "Đã xong gần đây" (Nguyễn Văn An) | Đã mở xem bản cuối. Mục 3 ĐẠT: 6 việc, mỗi việc ngày hoàn thành và "Đúng hạn" hoặc "Trễ hạn". |
| [`web/49-PWF-15-viec-da-xong-gan-day-can-bo.png`](web/49-PWF-15-viec-da-xong-gan-day-can-bo.png) | PWF-15 | Việc đã xong gần đây của cán bộ (Phạm Quốc Dũng) | Đã mở xem bản cuối. Mục 3 ĐẠT: 13 việc, 7 việc "Trễ hạn". Còn thấy: mốc do cán bộ ghi nhận cũng nằm trong danh sách như một việc. |

## PWF-09 đến PWF-14 · Bộ KPI, chính sách chấm điểm, bảng điểm, kỳ chấm điểm

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/51-PWF-10-chinh-sach-cham-diem.png`](web/51-PWF-10-chinh-sach-cham-diem.png) | PWF-10 | Chính sách chấm điểm, phiên bản 1 của tỉnh đang hiệu lực | Đã mở xem bản cuối. Phiên bản của tỉnh: số việc tối thiểu để xếp loại là 3. Còn thấy: mã dải xếp loại (EXCELLENT, GOOD...) là ô nhập. |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky.png`](web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky.png) | PWF-11 | Bảng điểm của tôi (Nguyễn Văn An), tab con Điểm | Đã mở xem bản cuối. Mục 1 ĐẠT: 86,27 điểm, "Tốt", 8 việc được chấm (dấu phẩy thập phân). |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-2-theo-viec.png`](web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-2-theo-viec.png) | PWF-11 | Tab con Theo việc: 13 việc | Đã mở xem bản cuối. Mục 1 ĐẠT: từng việc có điểm khác nhau (100, 80, 72, 70); cuối bảng "Việc không tính vào điểm: ... Chưa đến hạn, chưa chấm". Còn thấy: việc không tính vào điểm gọi bằng mã (PREP_PROPOSAL, FEAS_STUDY). |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png`](web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png) | PWF-11 | Tab con Điều chỉnh và phản hồi | Đã mở xem bản cuối. |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-2-so-sanh-ky.png`](web/52-PWF-11-bang-diem-cua-toi-tab-2-so-sanh-ky.png) | PWF-11 | Tab So sánh kỳ | Đã mở xem bản cuối. Còn thấy: chỉ có một kỳ nên chưa có gì để so. |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky.png) | PWF-11 | Bảng điểm của Phạm Quốc Dũng: điểm 5.9 được điều chỉnh thành 8.9 | Đã mở xem bản cuối. 55,04 được điều chỉnh thành 58,04, "Cần cải thiện". |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-2-theo-viec.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-2-theo-viec.png) | PWF-11 | Tab con Theo việc | Đã mở xem bản cuối. Việc trễ có điểm thấp dần theo số ngày trễ (90, 70, 60, 50, 48, 0); việc chuyển người có phần 37,5%. |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png) | PWF-11 | Tab con Điều chỉnh và phản hồi: một điều chỉnh đã duyệt, một phản hồi đã xử lý | Đã mở xem bản cuối. Một điều chỉnh đã duyệt, một phản hồi đã xử lý, một phản hồi "Chờ xử lý" (hồ sơ đang nằm trong hộp Phê duyệt). |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-2-so-sanh-ky.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-2-so-sanh-ky.png) | PWF-11 | Tab So sánh kỳ | Đã mở xem bản cuối. Còn thấy (lỗi): bảng có hai dòng cùng kỳ 01/10 đến 31/12, một "Đã chốt" 58,04 và một "Bản nháp" 55,04: kỳ nháp của Sở lọt vào bảng so sánh của chính người được chấm, không ghi đơn vị. |
| [`web/54-PWF-12-bang-diem-don-vi.png`](web/54-PWF-12-bang-diem-don-vi.png) | PWF-12 | Bảng điểm đơn vị: 9 người, 6 người có điểm | Đã mở xem bản cuối. Mục 1 ĐẠT: 3 người "Tốt" (86,27; 87,5; 79,78), 2 người "Đạt" (72,37; 63,5), 2 người "Cần cải thiện" (58,67; 55,04 điều chỉnh 58,04), 2 người "Chưa có điểm"; băng "Kỳ được chốt sớm, số liệu tính đến ngày 14/11/2026 ... 7 việc còn trong hạn chưa được chấm". Còn thấy: cột Thứ tự toàn dấu gạch (không xếp hạng khi mẫu chênh nhau, có lời giải thích). |
| [`web/54-PWF-12-ky-tam-tinh-cua-so.png`](web/54-PWF-12-ky-tam-tinh-cua-so.png) | PWF-12 | Bảng điểm của kỳ tạm tính (Sở Kế hoạch và Đầu tư, bản nháp) | Đã mở xem bản cuối. Mục 1 ĐẠT: "Tạm tính đến ngày 14/11/2026. Kỳ chưa kết thúc nên điểm còn thay đổi; chỉ chấm việc đã hoàn thành hoặc đã quá hạn tại ngày này. 7 việc còn trong hạn chưa được chấm và nằm ngoài mẫu số." |
| [`web/55-PWF-13-chi-tiet-diem-tab-1-diem.png`](web/55-PWF-13-chi-tiet-diem-tab-1-diem.png) | PWF-13 | Chi tiết điểm của Phạm Quốc Dũng, tab Điểm, có khối "Có cho người rà soát" | Đã mở xem bản cuối. Có khối "Cờ cho người rà soát": "Đổi người sát hạn". |
| [`web/55-PWF-13-chi-tiet-diem-tab-2-theo-viec.png`](web/55-PWF-13-chi-tiet-diem-tab-2-theo-viec.png) | PWF-13 | Tab Theo việc | Đã mở xem bản cuối. |
| [`web/55-PWF-13-chi-tiet-diem-tab-3-dieu-chinh-va-phan-hoi.png`](web/55-PWF-13-chi-tiet-diem-tab-3-dieu-chinh-va-phan-hoi.png) | PWF-13 | Tab Điều chỉnh và phản hồi | Đã mở xem bản cuối. |
| [`web/55-PWF-13-chi-tiet-diem-tab-4-so-sanh-ky.png`](web/55-PWF-13-chi-tiet-diem-tab-4-so-sanh-ky.png) | PWF-13 | Tab So sánh kỳ | Đã mở xem bản cuối. Còn thấy: hai dòng cùng kỳ (đã chốt và bản nháp) không ghi đơn vị. |
| [`web/56-PWF-13-hop-giai-thich-nut-i.png`](web/56-PWF-13-hop-giai-thich-nut-i.png) | PWF-13 | Hộp giải thích của nút "i" cạnh điểm kỳ (khung nhìn) | Đã mở xem bản cuối. Hộp nằm trọn trong khung nhìn, phần nội dung cuộn bên trong, nút "Đóng" thấy đủ (lượt chụp đầu của làn này nút Đóng bị khuất dưới mép khung nhìn; đã sửa). |
| [`web/57-PWF-14-ky-cham-diem.png`](web/57-PWF-14-ky-cham-diem.png) | PWF-14 | Kỳ chấm điểm đã chốt, có một tín hiệu cần rà soát | Đã mở xem bản cuối. Mục 1 và 6 ĐẠT: danh sách hai kỳ có cột Đơn vị; kỳ của tỉnh "Đã chốt" với băng chốt sớm; tín hiệu "Đổi người sát hạn" gọi việc bằng tên, mã ở dòng phụ. |
| [`web/57-PWF-14-ky-tam-tinh-cua-so.png`](web/57-PWF-14-ky-tam-tinh-cua-so.png) | PWF-14 | Kỳ tạm tính của Sở (bản nháp): nút "Tính lại bản nháp", "Chốt kỳ" | Đã mở xem bản cuối. Mục 1 ĐẠT: băng "Tạm tính đến ngày 14/11/2026". |
| [`web/58-PWF-14-hop-chot-som-can-ly-do.png`](web/58-PWF-14-hop-chot-som-can-ly-do.png) | PWF-14 | Hộp "Chốt kỳ chấm điểm" khi kỳ chưa hết (khung nhìn) | Đã mở xem bản cuối. Hộp nói kỳ kết thúc 31/12/2026, chốt trước đó là chốt sớm, và bắt buộc "Lý do chốt sớm" (ít nhất 20 ký tự). |

## ADM liên quan · Lịch sử phiên bản quy tắc, lịch làm việc

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/60-ADM-20-phien-ban-mau-cua-tinh.png`](web/60-ADM-20-phien-ban-mau-cua-tinh.png) | ADM-20 | Các phiên bản của mẫu workflow của tỉnh trong kho quy tắc | Đã mở xem bản cuối. Còn thấy: màn quản trị hiện tham số thô (đường dẫn trường, mã) như thiết kế của kho quy tắc. |
| [`web/61-ADM-20-phien-ban-bo-kpi.png`](web/61-ADM-20-phien-ban-bo-kpi.png) | ADM-20 | Phiên bản 1 của bộ KPI trong kho quy tắc: người soạn, người duyệt | Đã mở xem bản cuối. Còn thấy: như trên. |
| [`web/62-ADM-07-lich-cong-tac.png`](web/62-ADM-07-lich-cong-tac.png) | ADM-07 | Lịch công tác và ngày nghỉ (lịch mà hạn của workflow dựa vào) | Đã mở xem bản cuối. Bốn năm lịch đã công bố (2026 đến 2029). |

## Web ở 390 px

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/90-390-PRJ-03-workflow-tong-quan.png`](web/90-390-PRJ-03-workflow-tong-quan.png) | PRJ-03 | Tab Workflow, Tổng quan | Đã mở xem bản cuối. Không cuộn ngang; thẻ đếm xếp hai cột. Còn thấy: băng "Số liệu có thể đã cũ" (xem mục khiếm khuyết). |
| [`web/91-390-PWF-04-chi-tiet-viec.png`](web/91-390-PWF-04-chi-tiet-viec.png) | PWF-04 | Chi tiết việc | Đã mở xem bản cuối. Còn thấy: bảng "Chứng từ đã nộp" vẫn ép năm cột vào 390 px, chữ xuống dòng từng từ (bảng này chưa bật dạng thẻ). |
| [`web/92-390-PWF-07-bang-deadline.png`](web/92-390-PWF-07-bang-deadline.png) | PWF-07 | Bảng deadline | Đã mở xem bản cuối. Mục 8 ĐẠT sau khi sửa: mỗi việc một thẻ, nhãn bên trái, giá trị bên phải. Lượt chụp đầu của làn này các dòng trong thẻ chồng lên nhau (ô bị ghim 44 px); đã sửa. |
| [`web/93-390-PWF-11-bang-diem-cua-toi.png`](web/93-390-PWF-11-bang-diem-cua-toi.png) | PWF-11 | Bảng điểm của tôi | Đã mở xem bản cuối. |
| [`web/94-390-PWF-12-bang-diem-don-vi.png`](web/94-390-PWF-12-bang-diem-don-vi.png) | PWF-12 | Bảng điểm đơn vị | Đã mở xem bản cuối. Mục 8 ĐẠT sau khi sửa: thẻ mang tên người (trước đó tiêu đề thẻ là dấu gạch của cột Thứ tự). |
| [`web/95-390-PWF-01-thu-vien-mau.png`](web/95-390-PWF-01-thu-vien-mau.png) | PWF-01 | Thư viện mẫu | Đã mở xem bản cuối. Mục 8 ĐẠT sau khi sửa: thẻ từng mẫu đọc được, không còn chữ chồng nhau. |
| [`web/96-390-PWF-03-cong-viec.png`](web/96-390-PWF-03-cong-viec.png) | PWF-03 | Cây công việc của workflow ở 390 px | Đã mở xem bản cuối. Mục 8 ĐẠT sau khi sửa: mỗi việc một thẻ. Còn thấy: tên bước dài bị cắt ở mép phải ("... hồ sơ sử"); nhãn "Đường găng" cũng bị cắt. |
| [`web/97-390-PWF-13-chi-tiet-diem.png`](web/97-390-PWF-13-chi-tiet-diem.png) | PWF-13 | Chi tiết điểm ở 390 px | Đã mở xem bản cuối.  |
| [`web/98-390-PWF-14-ky-cham-diem.png`](web/98-390-PWF-14-ky-cham-diem.png) | PWF-14 | Kỳ chấm điểm ở 390 px | Đã mở xem bản cuối. Danh sách kỳ là thẻ, mã băm xuống dòng trong thẻ (trước khi sửa mã băm đẩy trang rộng thêm 319 px). |
| [`web/99-390-PWF-15-nhac-han.png`](web/99-390-PWF-15-nhac-han.png) | PWF-15 | Nhắc hạn của tôi ở 390 px | Đã mở xem bản cuối. Danh sách việc là thẻ. Còn thấy: bảng "Xem trước màu" mất cột thứ ba ("theo cài đặt của bạn") ở 390 px, phải cuộn ngang trong khung. |

## Điện thoại · Trang chủ (MOB-07) của ba người

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/01-MOB-07-trang-chu-lanh-dao.png`](mobile/01-MOB-07-trang-chu-lanh-dao.png) | MOB-07 | Trang chủ của Nguyễn Văn An (chủ sở hữu): dải điều hành, ba ô chỉ số, việc theo hạn | Đã mở xem bản cuối. Nhãn tab đáy một dòng cả năm tab ("Thông báo" không còn gãy). Còn thấy: ô "Cảnh báo đang mở" hai dòng, nhãn "Cần theo dõi" hai dòng. |
| [`mobile/02-MOB-07-trang-chu-lanh-dao-cuon-1.png`](mobile/02-MOB-07-trang-chu-lanh-dao-cuon-1.png) | MOB-07 | Cuộn xuống: "Cần bạn quyết định" | Đã mở xem bản cuối. Mục 9 ĐẠT: câu cảnh báo hiện đủ, không còn cắt ở dòng thứ ba. Còn thấy: hai hàng đầu cùng một câu dài năm dòng; hàng đầu là một MỐC "Hoàn thành bước chủ trương đầu tư ... quá hạn 42 ngày" của dự án có việc còn mở. |
| [`mobile/03-MOB-07-trang-chu-lanh-dao-cuon-2.png`](mobile/03-MOB-07-trang-chu-lanh-dao-cuon-2.png) | MOB-07 | Cuộn tiếp: hết danh sách, "Còn 146 việc nữa, xem trong mục Thông báo" | Đã mở xem bản cuối. |
| [`mobile/05-MOB-07-trang-chu-projectManager.png`](mobile/05-MOB-07-trang-chu-projectManager.png) | MOB-07 | Trang chủ của Phạm Quốc Dũng (cán bộ Ban quản lý dự án) | Đã mở xem bản cuối. Mục 10 CHƯA ĐẠT với người này: vẫn là bố cục lãnh đạo (dải giải ngân toàn tỉnh). Lý do đo được: vai trò CAN_BO_BAN_QLDA của bộ dữ liệu mang quyền committee.read, mà R53 coi người có quyền này là người quyết định cho một phạm vi. |
| [`mobile/05-MOB-07-trang-chu-projectManager-cuon-xuong.png`](mobile/05-MOB-07-trang-chu-projectManager-cuon-xuong.png) | MOB-07 | Trang chủ của Phạm Quốc Dũng, cuộn xuống | Đã mở xem bản cuối. Còn thấy: danh sách "Cần bạn quyết định" của cán bộ gồm cả việc của người khác. |
| [`mobile/06-MOB-07-trang-chu-treasuryMaker.png`](mobile/06-MOB-07-trang-chu-treasuryMaker.png) | MOB-07 | Trang chủ của Hoàng Thị Lan (kế toán thanh toán, không có quyền quyết định) | Đã mở xem bản cuối. Mục 10 ĐẠT MỘT NỬA: tiêu đề là "Việc hôm nay" (bố cục cán bộ, khác bố cục lãnh đạo), nhưng thân màn là lỗi "Bạn chưa có quyền truy cập ... SCOPE_DENIED": vai trò kế toán của bộ dữ liệu không có quyền home.read mà danh sách việc của tôi cần. Không có người nào trong bộ dữ liệu vừa đọc được việc của mình vừa không có quyền quyết định. |
| [`mobile/06-MOB-07-trang-chu-treasuryMaker-cuon-xuong.png`](mobile/06-MOB-07-trang-chu-treasuryMaker-cuon-xuong.png) | MOB-07 | Cùng màn sau khi vuốt | Đã mở xem bản cuối. Màn lỗi không cuộn. |

## Điện thoại · Dự án và chi tiết dự án, bốn tab (MOB-09, MOB-10)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/10-MOB-09-du-an.png`](mobile/10-MOB-09-du-an.png) | MOB-09 | Danh sách dự án | Đã mở xem bản cuối. |
| [`mobile/85-MOB-09-loi-tat.png`](mobile/85-MOB-09-loi-tat.png) | MOB-09 | Tấm Lối tắt của tab Dự án | Đã mở xem bản cuối. |
| [`mobile/11-MOB-10-chi-tiet-du-an-tab-tong-quan.png`](mobile/11-MOB-10-chi-tiet-du-an-tab-tong-quan.png) | MOB-10 | DA-PWF-02, tab Tổng quan | Đã mở xem bản cuối. Không còn thanh điều hướng đáy; "Mốc đã xong 3/6" (seed nay ghi nhận mốc). |
| [`mobile/12-MOB-10-tab-tong-quan-cuon-xuong.png`](mobile/12-MOB-10-tab-tong-quan-cuon-xuong.png) | MOB-10 | Tab Tổng quan sau khi cuộn | Đã mở xem bản cuối. Thanh tab dính dưới đầu màn. |
| [`mobile/13-MOB-10-tab-tien-do.png`](mobile/13-MOB-10-tab-tien-do.png) | MOB-10 | Tab Tiến độ: workflow của dự án | Đã mở xem bản cuối. Còn thấy: "Giai đoạn 1/6 · Ý tưởng" (giai đoạn của dự án) ngay trên "Giai đoạn 4/6 · Thực hiện đầu tư" (giai đoạn của workflow): hai thước đo giống nhau về hình thức mà khác số. |
| [`mobile/14-MOB-10-tab-tien-do-cuon-1.png`](mobile/14-MOB-10-tab-tien-do-cuon-1.png) | MOB-10 | Tab Tiến độ, cuộn: việc theo giai đoạn | Đã mở xem bản cuối. Còn thấy: ở đáy màn hai dòng chữ chồng lên nhau khi một hàng đang trượt dưới phần dính. |
| [`mobile/15-MOB-10-tab-tien-do-cuon-2.png`](mobile/15-MOB-10-tab-tien-do-cuon-2.png) | MOB-10 | Tab Tiến độ, cuộn tiếp: tới liên kết "Mở toàn bộ workflow" | Đã mở xem bản cuối. Còn thấy: băng "Bạn đang ngoại tuyến" hiện lên trong lúc chụp dù máy vẫn có mạng (trình giả lập chập chờn khi máy chủ bận); phải vuốt tám lần mới tới liên kết. |
| [`mobile/17-MOB-10-tab-von.png`](mobile/17-MOB-10-tab-von.png) | MOB-10 | Tab Vốn | Đã mở xem bản cuối. |
| [`mobile/18-MOB-10-tab-ho-so.png`](mobile/18-MOB-10-tab-ho-so.png) | MOB-10 | Tab Hồ sơ | Đã mở xem bản cuối. |

## Điện thoại · Workflow dự án, ba tab (MOB-78)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/20-MOB-78-workflow-tab-tong-quan.png`](mobile/20-MOB-78-workflow-tab-tong-quan.png) | MOB-78 | Tab Tổng quan | Đã mở xem bản cuối. |
| [`mobile/21-MOB-78-tab-tong-quan-cuon-xuong.png`](mobile/21-MOB-78-tab-tong-quan-cuon-xuong.png) | MOB-78 | Tab Tổng quan, cuộn: các giai đoạn | Đã mở xem bản cuối. Ba giai đoạn "Đã xong", một "Đang thực hiện", hai "Chưa tới". |
| [`mobile/22-MOB-78-tab-cong-viec.png`](mobile/22-MOB-78-tab-cong-viec.png) | MOB-78 | Tab Công việc | Đã mở xem bản cuối. Còn thấy: băng "Bạn đang ngoại tuyến" hiện trong lúc chụp (như ảnh 15); một hàng chồng chữ ở đáy. |
| [`mobile/23-MOB-78-tab-cong-viec-cuon-xuong.png`](mobile/23-MOB-78-tab-cong-viec-cuon-xuong.png) | MOB-78 | Tab Công việc, cuộn xuống | Đã mở xem bản cuối. |
| [`mobile/24-MOB-78-tab-moc.png`](mobile/24-MOB-78-tab-moc.png) | MOB-78 | Tab Mốc: mốc chưa xong, mốc đã xong | Đã mở xem bản cuối. |

## Điện thoại · Việc của tôi, ba tab (MOB-80)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/31-MOB-80-tab-can-lam-cuon-xuong.png`](mobile/31-MOB-80-tab-can-lam-cuon-xuong.png) | MOB-80 | Tab Cần làm, cuộn xuống | Đã mở xem bản cuối. |
| [`mobile/32-MOB-80-tab-can-lam-mau-chinh-thuc.png`](mobile/32-MOB-80-tab-can-lam-mau-chinh-thuc.png) | MOB-80 | Tab Cần làm, màu chính thức | Đã mở xem bản cuối. |
| [`mobile/33-MOB-80-tab-cho-duyet.png`](mobile/33-MOB-80-tab-cho-duyet.png) | MOB-80 | Tab Chờ duyệt: một việc trình hôm nay | Đã mở xem bản cuối. |
| [`mobile/34-MOB-80-tab-da-xong.png`](mobile/34-MOB-80-tab-da-xong.png) | MOB-80 | Tab Đã xong: sáu việc trong 90 ngày | Đã mở xem bản cuối. Mục 3 ĐẠT: "Việc bạn đã hoàn thành trong 90 ngày gần đây"; mỗi hàng "Hoàn thành dd/mm/yyyy · đúng hạn" hoặc "trễ hạn". Còn thấy: nhãn tab chỉ có số đếm sau khi mở tab (trước đó ghi "Đã xong" không số). |
| [`mobile/35-MOB-80-tab-da-xong-cuon-xuong.png`](mobile/35-MOB-80-tab-da-xong-cuon-xuong.png) | MOB-80 | Tab Đã xong, cuộn xuống: "Hiển thị 6 trên 6 việc" | Đã mở xem bản cuối. |

## Điện thoại · Chi tiết việc, bốn tab (MOB-79)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/40-MOB-79-chi-tiet-viec-tab-can-lam.png`](mobile/40-MOB-79-chi-tiet-viec-tab-can-lam.png) | MOB-79 | Tab Cần làm | Đã mở xem bản cuối. |
| [`mobile/41-MOB-79-tab-can-lam-cuon-xuong-thanh-tab-dinh.png`](mobile/41-MOB-79-tab-can-lam-cuon-xuong-thanh-tab-dinh.png) | MOB-79 | Tab Cần làm sau khi cuộn | Đã mở xem bản cuối. Thanh tab dính dưới đầu màn; chứng từ ghi tên mục kiểm. |
| [`mobile/43-MOB-79-tab-thong-tin.png`](mobile/43-MOB-79-tab-thong-tin.png) | MOB-79 | Tab Thông tin: Phân công | Đã mở xem bản cuối. Người chịu trách nhiệm và người phối hợp của dự án (seed mới: mỗi dự án một cán bộ phối hợp). |
| [`mobile/44-MOB-79-tab-thong-tin-cuon-xuong.png`](mobile/44-MOB-79-tab-thong-tin-cuon-xuong.png) | MOB-79 | Tab Thông tin, cuộn: vị trí trong quy trình | Đã mở xem bản cuối. Còn thấy: dòng "Mã việc RR_SURVEY" (cố ý, để đối chiếu với máy tính). |
| [`mobile/45-MOB-79-tab-can-cu.png`](mobile/45-MOB-79-tab-can-cu.png) | MOB-79 | Tab Căn cứ | Đã mở xem bản cuối. |
| [`mobile/46-MOB-79-tab-dien-bien.png`](mobile/46-MOB-79-tab-dien-bien.png) | MOB-79 | Tab Diễn biến | Đã mở xem bản cuối. |
| [`mobile/47-MOB-79-tab-dien-bien-cuon-xuong.png`](mobile/47-MOB-79-tab-dien-bien-cuon-xuong.png) | MOB-79 | Tab Diễn biến, cuộn: lịch sử | Đã mở xem bản cuối. |
| [`mobile/48-MOB-79-viec-cho-duyet.png`](mobile/48-MOB-79-viec-cho-duyet.png) | MOB-79 | Một việc chờ duyệt hoàn thành | Đã mở xem bản cuối. Còn thấy: biểu mẫu hiện bằng mã "PWF_QD_KE_HOACH_LCNT" ở dòng chứng từ (tên có ở dòng dưới). |

## Điện thoại · Điểm KPI (MOB-81) và nhắc hạn (MOB-82)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/50-MOB-81-diem-kpi-tab-theo-viec.png`](mobile/50-MOB-81-diem-kpi-tab-theo-viec.png) | MOB-81 | Điểm KPI của tôi, tab Theo việc: 86,27, xếp loại Tốt | Đã mở xem bản cuối. Mục 1 ĐẠT trên điện thoại: điểm có nghĩa, từng việc một điểm. |
| [`mobile/51-MOB-81-tab-dieu-chinh.png`](mobile/51-MOB-81-tab-dieu-chinh.png) | MOB-81 | Tab Điều chỉnh | Đã mở xem bản cuối. Còn thấy: chỉ một câu (người này không có điều chỉnh). |
| [`mobile/52-MOB-81-tab-cach-tinh.png`](mobile/52-MOB-81-tab-cach-tinh.png) | MOB-81 | Tab Cách tính | Đã mở xem bản cuối. |
| [`mobile/55-MOB-82-cai-dat-nhac-han.png`](mobile/55-MOB-82-cai-dat-nhac-han.png) | MOB-82 | Cài đặt nhắc hạn | Đã mở xem bản cuối. |
| [`mobile/56-MOB-82-cai-dat-nhac-han-cuon-xuong.png`](mobile/56-MOB-82-cai-dat-nhac-han-cuon-xuong.png) | MOB-82 | Cài đặt nhắc hạn, cuộn xuống | Đã mở xem bản cuối. |

## Điện thoại · Cá nhân (MOB-47), Thông báo (MOB-32)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/60-MOB-47-ca-nhan.png`](mobile/60-MOB-47-ca-nhan.png) | MOB-47 | Cá nhân: hồ sơ, công việc của tôi, nhắc hạn | Đã mở xem bản cuối. |
| [`mobile/61-MOB-47-ca-nhan-cuon-1.png`](mobile/61-MOB-47-ca-nhan-cuon-1.png) | MOB-47 | Cá nhân, cuộn: cài đặt, công cụ | Đã mở xem bản cuối. |
| [`mobile/62-MOB-47-ca-nhan-cuon-2.png`](mobile/62-MOB-47-ca-nhan-cuon-2.png) | MOB-47 | Cá nhân, cuộn tiếp: tài khoản, hỗ trợ | Đã mở xem bản cuối. |
| [`mobile/70-MOB-32-thong-bao-tab-su-kien.png`](mobile/70-MOB-32-thong-bao-tab-su-kien.png) | MOB-32 | Thông báo, tab Sự kiện (rỗng) | Đã mở xem bản cuối. Mục 9 ĐẠT: câu rỗng riêng "Chưa có thông báo nào. Thông báo về việc và hồ sơ của bạn sẽ hiện ở đây." Còn thấy: tab này vẫn rỗng trên bộ dữ liệu. |
| [`mobile/71-MOB-32-thong-bao-tab-viec-can-xu-ly.png`](mobile/71-MOB-32-thong-bao-tab-viec-can-xu-ly.png) | MOB-32 | Thông báo, tab Việc cần xử lý | Đã mở xem bản cuối. Mục 9 ĐẠT: tiêu đề hiện đủ. |

## Điện thoại · Phê duyệt (MOB-23, MOB-24) trên bản công

Bản công nay có hồ sơ chờ duyệt (nhóm seed clip-public-approvals), nên cả hộp và ba tab của chi tiết chụp trên bản công; lượt trước phải mượn ảnh của bản doanh nghiệp.

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/75-MOB-23-hop-phe-duyet-ban-cong.png`](mobile/75-MOB-23-hop-phe-duyet-ban-cong.png) | MOB-23 | Hộp phê duyệt của bản công: một hồ sơ chờ quyết định | Đã mở xem bản cuối. Mục 11 ĐẠT: "Phản hồi về điểm đánh giá", dòng "Người trình: Phạm Quốc Dũng · trình ngày 14/11/2026", hạn 18/11. Lượt seed đầu của làn này hộp vẫn rỗng (seed đọc sai trường), đã sửa. |
| [`mobile/76-MOB-24-chi-tiet-phe-duyet-tab-noi-dung.png`](mobile/76-MOB-24-chi-tiet-phe-duyet-tab-noi-dung.png) | MOB-24 | Chi tiết phê duyệt, tab Nội dung | Đã mở xem bản cuối. Còn thấy: màn không cho đọc NỘI DUNG phản hồi và không nêu điểm, kỳ hay người trình; người duyệt chỉ thấy loại hồ sơ, bước, đơn vị, hạn rồi hai nút quyết định. |
| [`mobile/77-MOB-24-tab-so-sanh.png`](mobile/77-MOB-24-tab-so-sanh.png) | MOB-24 | Tab So sánh | Đã mở xem bản cuối. Còn thấy: một câu "Loại hồ sơ này chưa có so sánh với bản trước trên điện thoại". |
| [`mobile/78-MOB-24-tab-bang-chung.png`](mobile/78-MOB-24-tab-bang-chung.png) | MOB-24 | Tab Bằng chứng | Đã mở xem bản cuối. Còn thấy: một câu "Hồ sơ không có tệp đính kèm". |

## Điện thoại · Văn bản đến (DOC-23, DOC-24) và xem lại báo cáo hiện trường (MOB-20), mỗi màn ba tab

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/80-DOC-23-van-ban-den.png`](mobile/80-DOC-23-van-ban-den.png) | DOC-23 | Văn bản đến cần xử lý | Đã mở xem bản cuối. |
| [`mobile/81-DOC-24-van-ban-den-tab-thong-tin.png`](mobile/81-DOC-24-van-ban-den-tab-thong-tin.png) | DOC-24 | Xử lý văn bản đến, tab Thông tin | Đã mở xem bản cuối. Mục 9 ĐẠT: màn chi tiết không còn thanh điều hướng đáy, chỉ còn nút hành động. |
| [`mobile/82-DOC-24-tab-tep.png`](mobile/82-DOC-24-tab-tep.png) | DOC-24 | Tab Tệp | Đã mở xem bản cuối. Còn thấy: chỉ có mã băm của tệp và lời giải thích; điện thoại không mở tệp. |
| [`mobile/83-DOC-24-tab-dien-bien.png`](mobile/83-DOC-24-tab-dien-bien.png) | DOC-24 | Tab Diễn biến | Đã mở xem bản cuối. |
| [`mobile/86-MOB-20-ra-soat-bao-cao-tab-kiem-tra.png`](mobile/86-MOB-20-ra-soat-bao-cao-tab-kiem-tra.png) | MOB-20 | Rà soát và gửi báo cáo, tab Kiểm tra | Đã mở xem bản cuối. Mục 9 ĐẠT: câu lỗi hiện đủ ba dòng. Còn thấy: cùng mục lỗi lặp lại ở nhóm "Máy chủ kiểm tra". |
| [`mobile/87-MOB-20-tab-so-lieu.png`](mobile/87-MOB-20-tab-so-lieu.png) | MOB-20 | Tab Số liệu | Đã mở xem bản cuối. Còn thấy: nhãn "Tổng lũy kế sáu ô" khó hiểu; báo cáo chưa nhập số nên toàn 0. |
| [`mobile/88-MOB-20-tab-thuyet-minh-tep.png`](mobile/88-MOB-20-tab-thuyet-minh-tep.png) | MOB-20 | Tab Thuyết minh, tệp | Đã mở xem bản cuối. |

## Điện thoại · Chế độ tối (đặt "Tối" trong Cá nhân)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/90-toi-MOB-07-trang-chu.png`](mobile/90-toi-MOB-07-trang-chu.png) | MOB-07 | Trang chủ | Đã mở xem bản cuối. Chữ, biểu tượng và ba màu hạn đọc rõ trên nền tối. |
| [`mobile/91-toi-MOB-09-du-an.png`](mobile/91-toi-MOB-09-du-an.png) | MOB-09 | Dự án (đang lọc DA-PWF-02) | Đã mở xem bản cuối. Đọc rõ. |
| [`mobile/92-toi-MOB-10-chi-tiet-du-an.png`](mobile/92-toi-MOB-10-chi-tiet-du-an.png) | MOB-10 | Chi tiết dự án | Đã mở xem bản cuối. Đọc rõ. |
| [`mobile/93-toi-MOB-78-workflow-tab-tong-quan.png`](mobile/93-toi-MOB-78-workflow-tab-tong-quan.png) | MOB-78 | Workflow, tab Tổng quan | Đã mở xem bản cuối. Đọc rõ. |
| [`mobile/94-toi-MOB-78-tab-cong-viec.png`](mobile/94-toi-MOB-78-tab-cong-viec.png) | MOB-78 | Workflow, tab Công việc | Đã mở xem bản cuối. Đọc rõ. |
| [`mobile/95-toi-MOB-47-ca-nhan.png`](mobile/95-toi-MOB-47-ca-nhan.png) | MOB-47 | Cá nhân | Đã mở xem bản cuối. Đọc rõ. |
| [`mobile/95a-toi-MOB-47-ca-nhan-che-do-giao-dien.png`](mobile/95a-toi-MOB-47-ca-nhan-che-do-giao-dien.png) | MOB-47 | Cá nhân: ô chọn chế độ giao diện đang ở "Tối" | Đã mở xem bản cuối. Đọc rõ. Lệnh đổi chế độ tối của máy không có tác dụng khi ứng dụng đang đặt "Sáng"; phải chọn "Tối" ở đây (lần chụp đầu của làn này ra ảnh sáng vì thế). |
| [`mobile/96-toi-MOB-80-viec-cua-toi.png`](mobile/96-toi-MOB-80-viec-cua-toi.png) | MOB-80 | Việc của tôi | Đã mở xem bản cuối. Đọc rõ. |
| [`mobile/97-toi-MOB-79-chi-tiet-viec.png`](mobile/97-toi-MOB-79-chi-tiet-viec.png) | MOB-79 | Chi tiết việc | Đã mở xem bản cuối. Đọc rõ. |
| [`mobile/98-toi-MOB-79-tab-thong-tin.png`](mobile/98-toi-MOB-79-tab-thong-tin.png) | MOB-79 | Chi tiết việc, tab Thông tin | Đã mở xem bản cuối. Đọc rõ. |
| [`mobile/99-toi-MOB-81-diem-kpi.png`](mobile/99-toi-MOB-81-diem-kpi.png) | MOB-81 | Điểm KPI của tôi | Đã mở xem bản cuối. Đọc rõ. |
| [`mobile/89-toi-MOB-23-hop-phe-duyet.png`](mobile/89-toi-MOB-23-hop-phe-duyet.png) | MOB-23 | Hộp phê duyệt | Đã mở xem bản cuối. Đọc rõ. |

## Khiếm khuyết còn lại, xếp theo mức nghiêm trọng

**Nghiêm trọng (logic hoặc dữ liệu, không sửa trong làn này)**

1. Trang chủ cán bộ (R53) không thấy được trên bộ dữ liệu: cán bộ Ban quản lý dự án vẫn nhận trang chủ lãnh đạo vì vai trò mang `committee.read`; người không có quyền quyết định nhận "Việc hôm nay" kèm lỗi SCOPE_DENIED vì thiếu `home.read` (`mobile/05`, `mobile/06`). Cần quyết định: hoặc đổi tiêu chí của R53 (quyền `committee.read` có đủ để coi là lãnh đạo không), hoặc cho bộ dữ liệu một vai trò cán bộ có `home.read` mà không có quyền quyết định.
2. Bảng So sánh kỳ của người được chấm (PWF-11, PWF-13) hiện cả kỳ NHÁP của đơn vị khác chứa người đó, hai dòng cùng khoảng ngày và không ghi đơn vị (`web/53-...-tab-2-so-sanh-ky`, `web/55-...-tab-4`). Danh sách "điểm của tôi" chỉ trả kỳ đã chốt, nhưng bảng so sánh thì không lọc; người được chấm thấy điểm nháp của mình.
3. Chi tiết phê duyệt trên điện thoại (MOB-24) không cho đọc nội dung phản hồi về điểm, không nêu điểm, kỳ hay người trình; người duyệt bấm "Phê duyệt" mà không thấy mình duyệt gì (`mobile/76`).
4. Băng "Số liệu có thể đã cũ" hiện ở đầu workflow trên stack này dù số liệu đúng (`web/90`, `web/96`): giờ của máy chủ thử nghiệm lệch so với đồng hồ thật sau khi seed dời đồng hồ. Trên máy chủ thật không có độ lệch này; chưa xác nhận được. Câu chữ đã sửa (giờ Việt Nam thay cho "giờ gốc").
5. Flow Maestro 20 (khởi động lạnh) không thể đạt trên bản công ở bất kỳ tốc độ nào: nó chờ tiêu đề "Cần bạn quyết định", mà trang chủ của người có việc workflow nay đẩy tiêu đề đó xuống dưới màn đầu (`mobile/01`).
6. Tab KPI của PWF-04: trạng thái "không có quyền" không dựng được trên màn thật (xem bảng 11 mục, mục 2).

**Trung bình (trình bày, còn lại)**

7. PWF-04 tab KPI: cột "Dữ kiện nguồn" là chuỗi JSON thô và bị cắt ở mép phải (`web/35`).
8. PWF-04 ở 390 px: bảng "Chứng từ đã nộp" vẫn ép năm cột (`web/91`); PWF-15 ở 390 px: bảng "Xem trước màu" mất cột thứ ba (`web/99`); cây công việc ở 390 px cắt tên bước dài và nhãn "Đường găng" (`web/96`).
9. Tệp Excel của bảng deadline: tên trang tính "DIS-export", tiêu đề cột là khóa tiếng Anh (`project_code`, `task`, ...) dù nội dung tiếng Việt.
10. PWF-09 tab Thang điểm dài hơn 5.000 px; tab Áp dụng nhập mã giai đoạn và mã việc bằng tay (`web/50-...-tab-2`, `tab-3`).
11. Mã còn lộ ở chỗ người dùng thường đọc: việc không tính vào điểm gọi bằng mã ở PWF-11 và PWF-13 (PREP_PROPOSAL...); ô "Loại dự án" và vai trò trong trình soạn PWF-02 là mã; mã biểu mẫu ở dòng chứng từ của MOB-79 (`mobile/48`); mã dải xếp loại ở PWF-10.
12. Điện thoại, trang chủ: hai hàng cảnh báo đầu cùng một câu dài năm dòng, và một MỐC bị báo "quá hạn 42 ngày" khi việc đứng trước nó còn mở (`mobile/02`).
13. Điện thoại, chi tiết dự án: phải vuốt tám lần ở tab Tiến độ mới tới "Mở toàn bộ workflow" (`mobile/15`); hai dòng "Giai đoạn 1/6" và "Giai đoạn 4/6" của hai thước đo khác nhau (`mobile/13`).
14. Điện thoại: băng "Bạn đang ngoại tuyến" hiện lên trong hai ảnh dù máy có mạng (`mobile/15`, `mobile/22`); chỉ thấy trên trình giả lập khi máy chủ bận, chưa biết có xảy ra trên điện thoại thật không.
15. Điện thoại: chữ của một hàng chồng lên hàng khác ở đáy danh sách khi đang cuộn dưới phần dính (`mobile/14`, `mobile/22`).
16. Hộp Phê duyệt của bản doanh nghiệp: các hàng cùng tiêu đề "Nhận báo cáo".

**Nhẹ**

17. PWF-06, PWF-03: cột cuối của bảng bị cắt ở mép phải khi tên dài (`web/39`, `web/29-...-tab-2`).
18. PRJ-03 tab Tổng quan: khối "Cập nhật thông tin" bị cắt ở đáy, phải cuộn trong khung (`web/20`).
19. Tab "Đã xong" của điện thoại chỉ có số đếm sau khi mở tab (`mobile/30` so với `mobile/34`).
20. PWF-02: ô "Vai trò chịu trách nhiệm bước" lệch so với ba ô cùng hàng; nút "Bỏ liên kết" thấp hơn hàng; ô "Nội dung mục" hẹp.
21. PRJ-02: hai nhóm trường có khung viền của trình duyệt; thẻ lồng thẻ (`web/01`).
22. Điện thoại, trang chủ: ô "Cảnh báo đang mở" và nhãn "Cần theo dõi" mỗi cái hai dòng (`mobile/01`).
23. Ô ngày trên web hiện theo ngôn ngữ của trình duyệt chụp.

## Lỗi đã sửa trong làn này (thấy trên ứng dụng chạy thật)

- Web, bảng dạng thẻ ở màn hẹp (`DataTable` có `stacked`, và cây công việc của workflow): mọi ô bị ghim cao 44 px bởi quy tắc chung của trang, nên ô có hai dòng tràn đè lên ô kế; nay ô cao theo nội dung, nhãn chiếm cột trái cho mọi phần của ô, nhãn trạng thái giữ bề rộng của nó.
- Web, `DataTable`: cột tiêu đề của thẻ chọn được (`stackedTitle`); PWF-12 lấy tên người làm tiêu đề thẻ thay cho dấu gạch của cột Thứ tự.
- Web, PWF-15: danh sách việc của tôi ở màn hẹp là thẻ "nhãn: giá trị" (trước ép năm cột, hai cột cuối rơi ra ngoài).
- Web, PWF-14: danh sách kỳ và chi tiết kỳ ghi đơn vị (hai đơn vị có kỳ cùng quý không phân biệt được); danh sách kỳ thành thẻ ở màn hẹp; mã băm xuống dòng thay vì đẩy trang rộng thêm 319 px.
- Web, PWF-11/12/13: trọng số và phần của người viết bằng dấu phẩy thập phân như điểm (trước "97.13", "62.5%").
- Web, hộp "i" của số liệu: hộp mở dưới nút và cao tới 70% khung nhìn nên vẫn vượt mép dưới, nút Đóng bị khuất; nay chiều cao giữ trong phần còn lại của cửa sổ dưới nút.
- Web, băng "Số liệu có thể đã cũ": giờ ghi theo giờ Việt Nam kèm ngày (trước là giờ UTC kèm chữ "giờ gốc").
- Seed: xem mục "Seed" ở trên (loại dự án, hộp phê duyệt, phân bố điểm, mốc, tín hiệu, kỳ nháp, nghĩa vụ e-GP).

Không sửa mã điện thoại trong làn này, nên không có golden nào đổi (`mobile-goldens-changed.txt` ghi rõ).

## Flow Maestro (trình giả lập `guide`, Android 15, bản debug)

- Bản công: flow 06 ĐẠT; flow 40 ĐẠT đến hết qua `run_40_project_workflow.sh` (41 giây; cổng API bị chặn rồi mở lại đúng lúc); flow 20 KHÔNG ĐẠT hai lần trên hai mẫu, dừng ở chờ "Cần bạn quyết định" (xem khiếm khuyết 5).
- Bản doanh nghiệp: chưa chạy.

