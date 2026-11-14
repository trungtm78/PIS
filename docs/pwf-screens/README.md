# Ảnh chụp màn hình phần workflow dự án (PWF), có dữ liệu

Chụp lại toàn bộ ngày 15/11/2026 từ nhánh `lane/shots2` (từ `main` 75cd9f52b, sau các làn fix8 và fix9) trên ứng dụng chạy thật: API trên PostgreSQL nhúng, seed `clip-seed apply --dataset public` chạy trọn trên một stack sạch, web dựng ở chế độ development và chụp bằng Chromium của Playwright (1440×900, ảnh toàn trang; vài ảnh là khung nhìn sau khi cuộn hoặc khi mở hộp, và sáu ảnh rộng 390 px); điện thoại là APK debug dựng từ nhánh với `--dart-define=MACHVON_ALLOW_SCREENSHOTS=true`, AVD `guide` (720×1560, cỡ chữ 100%), ảnh lấy bằng `adb exec-out screencap -p`. Không có ảnh mock và không có ảnh golden. Ảnh của các lượt trước đã xóa hết.

Tổng cộng 146 ảnh: 76 ảnh web, 70 ảnh điện thoại. Tôi đã mở xem 144 ảnh (cột cuối ghi từng ảnh; ảnh ghi "bản chụp ngay trước" là ảnh được chụp lại lần nữa sau khi tôi xem, vì một lỗi ở chỗ khác được sửa). Ảnh web dài được xem ở cỡ thu nhỏ, chỗ nghi ngờ thì cắt ra xem cỡ thật. Với mọi ảnh web, kịch bản chụp đo được: không có lỗi JavaScript, không có khóa dịch lộ ra, và trang không cuộn ngang (trừ ảnh hộp giải thích ở lượt chụp đầu, đã sửa rồi chụp lại).

Xem dạng lưới có mục lục: [index.html](index.html).

## Cách dựng lại

- Stack và web: chạy `uat/run/.../tools/serve-edition.mjs public <thư mục> <cổng API> <cổng IdP> <cổng web>` (dựng web tĩnh ở chế độ development, chạy `npm run e2e:stack -w @machvon/api`, rồi `node scripts/clip-seed.mjs apply --dataset public`). Đăng nhập web bằng `?devUser=<người>`.
- Điện thoại: `flutter build apk --debug --dart-define=MACHVON_API_BASE_URL=http://127.0.0.1:<cổng API> --dart-define=MACHVON_OIDC_ISSUER=http://127.0.0.1:<cổng IdP>/realms/machvon --dart-define=MACHVON_OIDC_CLIENT_ID=machvon-web --dart-define=MACHVON_ALLOW_SCREENSHOTS=true` (bản doanh nghiệp thêm `--dart-define=MACHVON_EDITION=enterprise`); `adb reverse` hai cổng; `adb shell cmd locale set-app-locales vn.machvon.app --locales vi-VN`; đăng nhập bằng `maestro test apps/mobile/qa/device/flows/06_sign_in_test_idp.yaml`. Muốn đăng nhập người khác người thứ nhất: ghi khóa của người đó (ví dụ `projectManager`) vào tệp `<stack-info.json>.user` trước khi đăng nhập.
- Cờ `MACHVON_ALLOW_SCREENSHOTS` chỉ có hiệu lực ở bản debug; bản release luôn chặn chụp màn Phê duyệt.

## Seed đã thêm trong làn này

- Bản công, nhóm `clip-public-pwf-review`: mỗi việc được bắt đầu có thêm tổ công tác trong sổ phân công (lãnh đạo chịu trách nhiệm, một cán bộ tham vấn), nên bảng điểm đơn vị có 6 trên 9 người có điểm (trước là 2); một việc được chuyển người hai ngày trước hạn, nên kỳ chấm điểm có một tín hiệu cần rà soát; bộ KPI và chính sách chấm điểm có phiên bản của tỉnh đã duyệt (người soạn và người duyệt khác nhau); chứng từ nộp kèm ghi tên biểu mẫu, tên mục kiểm thay cho mã. Đã chạy trọn hai lần trên stack sạch (615 lệnh của nhóm, không lệnh nào bị từ chối) và đọc lại bằng API.
- Cả hai bản, nhóm `clip-public-phone-work` / `clip-ent-phone-work`: khi người dùng điện thoại chưa có điểm ở kỳ nào (bản doanh nghiệp) thì hoàn thành một việc của người đó, ghi tổ công tác, bù lại hai việc đang làm, tính và chốt kỳ của quý. Trên bản doanh nghiệp: lần áp dụng đầu của cả bộ dừng ở bước này vì một lỗi của chính bước (đã sửa), rồi nhóm được áp dụng lại trên stack đó và chạy trọn; CHƯA chạy lại cả bộ doanh nghiệp từ đầu trên stack sạch sau khi sửa. Kết quả đọc lại: người dùng điện thoại có điểm 34,16 với 4 việc (mẫu nhỏ, chưa xếp loại) và còn hai việc đang làm.
- Bản công không có việc chờ phê duyệt nào (hộp Phê duyệt của điện thoại rỗng với mọi người); ảnh hộp Phê duyệt và chi tiết ba tab chụp trên bản doanh nghiệp, nơi seed sẵn có sáu báo cáo tuần chờ lãnh đạo duyệt. Không thêm seed phê duyệt cho bản công vì cách duy nhất là đổi quy tắc nhận báo cáo của tỉnh sang nhiều bước, ảnh hưởng các kịch bản khác.

## PRJ-02 · Tạo dự án, mục "Loại quy trình xử lý"

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/01-PRJ-02-dang-ky-du-an-loai-quy-trinh.png`](web/01-PRJ-02-dang-ky-du-an-loai-quy-trinh.png) | PRJ-02 | Tạo dự án đã nhập đủ: đề xuất của hệ thống, lý do, bốn ô chọn, xem trước lịch (13 bước, 503 ngày làm việc) | Đã mở xem bản cuối. Thanh nút Hủy/Tạo dự án không còn che biểu mẫu. Còn thấy: hai nhóm trường phía trên có khung viền đậm của trình duyệt; thẻ "Loại quy trình xử lý" lồng trong thẻ "Thông tin dự án"; mã PUBLIC_INVESTMENT cạnh tên loại quy trình. |

## PWF-01, PWF-02, PWF-05 · Thư viện mẫu, trình soạn (từng tab và tab con), khởi tạo và tiếp nhận

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/10-PWF-01-thu-vien-mau.png`](web/10-PWF-01-thu-vien-mau.png) | PWF-01 | Thư viện mẫu: năm mẫu, phiên bản, hiệu lực, cờ | Đã mở xem bản cuối. Bảng vừa trang, cột Thao tác hiện đủ hai nút (trước bị cắt mất). Còn thấy: loại dự án do tỉnh tự đặt hiện mã (ROAD_REPAIR, SCHOOL_EQUIPMENT). |
| [`web/11-PWF-01-so-sanh-hai-phien-ban.png`](web/11-PWF-01-so-sanh-hai-phien-ban.png) | PWF-01 | So sánh phiên bản 1 và 2 của mẫu sửa chữa đường của tỉnh | Đã mở xem bản cuối. Bảng quy mô và hai thay đổi đọc rõ. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec.png) | PWF-02 | Trình soạn, tab Cấu trúc; khung soạn việc ở tab con Thông tin | Đã mở xem bản cuối. Ô đánh dấu đứng cùng dòng với nhãn (trước mỗi ô chiếm một dòng riêng, rộng cả hàng); hàng việc trong cây gọn một dòng. Còn thấy: tiêu đề khung là "Việc RR_ESTIMATE" (mã). |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-2-thoi-han-va-phu-thuoc.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-2-thoi-han-va-phu-thuoc.png) | PWF-02 | Tab con Thời hạn và phụ thuộc | Đã mở xem bản cuối. Còn thấy: nút "Bỏ liên kết" đứng thấp hơn các ô cùng hàng. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-3-chung-tu-va-bieu-mau.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-3-chung-tu-va-bieu-mau.png) | PWF-02 | Tab con Chứng từ và biểu mẫu: chọn biểu mẫu từ kho | Đã mở xem bản cuối. Danh sách biểu mẫu là các dòng có ô đánh dấu, đọc được. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-4-danh-muc-kiem.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-4-danh-muc-kiem.png) | PWF-02 | Tab con Danh mục kiểm | Đã mở xem bản cuối. Còn thấy: ô "Nội dung mục" hẹp nên chữ bị cắt trong ô. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-5-kpi.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-5-kpi.png) | PWF-02 | Tab con KPI: sáu KPI của workflow | Đã mở xem bản cuối. Mỗi KPI một dòng, kèm mã. |
| [`web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-6-can-cu.png`](web/12-PWF-02-tab-1-cau-truc-giai-doan-va-cong-viec-6-can-cu.png) | PWF-02 | Tab con Căn cứ | Đã mở xem bản cuối. Ô chọn văn bản hiện loại và số. |
| [`web/12-PWF-02-tab-2-buoc-va-can-cu-phap-ly.png`](web/12-PWF-02-tab-2-buoc-va-can-cu-phap-ly.png) | PWF-02 | Tab Bước và căn cứ pháp lý | Đã mở xem bản cuối. Còn thấy: ở mỗi hàng bước, ô "Vai trò chịu trách nhiệm bước" có nhãn hai dòng và dòng gợi ý nên đứng lệch lên so với ba ô bên trái; vai trò hiện mã (SITE_ENGINEER). |
| [`web/12-PWF-02-tab-3-vai-tro.png`](web/12-PWF-02-tab-3-vai-tro.png) | PWF-02 | Tab Vai trò: chín mã vai trò và ô đặt tên | Đã mở xem bản cuối. Mỗi mã có tên trong danh mục của hệ thống ghi bên dưới. |
| [`web/12-PWF-02-tab-4-kiem-tra-va-xem-truoc-lich.png`](web/12-PWF-02-tab-4-kiem-tra-va-xem-truoc-lich.png) | PWF-02 | Tab Kiểm tra và xem trước lịch | Đã mở xem bản cuối. Còn thấy: chưa bấm xem trước nên khối lịch là lời nhắc; dòng "Dấu vân tay của mẫu" là chuỗi kỹ thuật. |
| [`web/15-PWF-05-khoi-tao-workflow-xem-truoc-lich.png`](web/15-PWF-05-khoi-tao-workflow-xem-truoc-lich.png) | PWF-05 | Khởi tạo workflow cho DA-CN026, đã xem trước lịch | Đã mở xem bản cuối. Hai lựa chọn "Cách bắt đầu" nằm một hàng, nút tròn đứng cạnh chữ (trước là hai thanh rộng cả trang). |
| [`web/16-PWF-05-tiep-nhan-workflow-chay-thu.png`](web/16-PWF-05-tiep-nhan-workflow-chay-thu.png) | PWF-05 | Tiếp nhận workflow cho dự án đang chạy: kết quả chạy thử từng việc | Đã mở xem bản cuối. Năm số đếm tách nhau. Còn thấy: bảng dài 34 dòng, mỗi dòng một ô chọn. |

## PRJ-03 · Không gian dự án, mọi tab; tab Workflow có năm tab con

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/20-PRJ-03-tab-tong-quan.png`](web/20-PRJ-03-tab-tong-quan.png) | PRJ-03 | DA-PWF-02, tab Tổng quan | Đã mở xem bản cuối. Số 28.000.000.000 nằm một dòng (trước gãy giữa số). Còn thấy: nhiều dòng "Chưa có" vì dự án mới ở giai đoạn Ý tưởng. |
| [`web/21-PRJ-03-tab-muc-tieu.png`](web/21-PRJ-03-tab-muc-tieu.png) | PRJ-03 | Tab Mục tiêu | Đã mở xem bản cuối. Còn thấy: năm khối chỉ có lời nhắc "chưa có" (dự án chưa có dữ liệu các phần này). |
| [`web/22-PRJ-03-tab-ke-hoach.png`](web/22-PRJ-03-tab-ke-hoach.png) | PRJ-03 | Tab Kế hoạch: mốc tiến độ lấy từ workflow | Đã mở xem bản cuối. Còn thấy: mã mốc (APPR_DONE...) đứng trước tên mốc, ngày viết dạng 2026-11-13, bốn khối dưới rỗng. |
| [`web/23-PRJ-03-tab-workflow-1-tong-quan.png`](web/23-PRJ-03-tab-workflow-1-tong-quan.png) | PRJ-03 | Tab Workflow, tab con Tổng quan | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn). Chỉ một giai đoạn ghi "Trễ", các giai đoạn sau ghi "Đã bắt đầu". |
| [`web/23-PRJ-03-tab-workflow-2-cong-viec.png`](web/23-PRJ-03-tab-workflow-2-cong-viec.png) | PRJ-03 | Tab con Công việc: cây giai đoạn, bước, việc | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn). Mã việc là dòng nhỏ dưới tên. |
| [`web/23-PRJ-03-tab-workflow-3-lich.png`](web/23-PRJ-03-tab-workflow-3-lich.png) | PRJ-03 | Tab con Lịch: Gantt | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn). Nhãn tháng đủ chữ, phần trễ gạch đỏ kèm số ngày. |
| [`web/23-PRJ-03-tab-workflow-4-moc-va-cong.png`](web/23-PRJ-03-tab-workflow-4-moc-va-cong.png) | PRJ-03 | Tab con Mốc và cổng | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn).  |
| [`web/23-PRJ-03-tab-workflow-5-bang-cot.png`](web/23-PRJ-03-tab-workflow-5-bang-cot.png) | PRJ-03 | Tab con Bảng cột | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn). Còn thấy: sáu cột không vừa chiều ngang, phải cuộn trong khung. |
| [`web/24-PRJ-03-tab-giai-ngan.png`](web/24-PRJ-03-tab-giai-ngan.png) | PRJ-03 | Tab Giải ngân | Đã mở xem bản cuối. Còn thấy: ba khối rỗng (dự án chưa có kế hoạch vốn). |
| [`web/25-PRJ-03-tab-vuong-mac.png`](web/25-PRJ-03-tab-vuong-mac.png) | PRJ-03 | Tab Vướng mắc | Đã mở xem bản cuối. Còn thấy: bốn khối rỗng. |

## PWF-03 · Workflow của dự án theo mẫu của tỉnh

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/29-PWF-03-mau-cua-tinh-tab-1-tong-quan.png`](web/29-PWF-03-mau-cua-tinh-tab-1-tong-quan.png) | PWF-03 | DA-PWF-04, tab Tổng quan | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn).  |
| [`web/29-PWF-03-mau-cua-tinh-tab-2-cong-viec.png`](web/29-PWF-03-mau-cua-tinh-tab-2-cong-viec.png) | PWF-03 | Tab Công việc | Đã mở xem bản cuối.  |
| [`web/29-PWF-03-mau-cua-tinh-tab-3-lich.png`](web/29-PWF-03-mau-cua-tinh-tab-3-lich.png) | PWF-03 | Tab Lịch | Đã mở xem bản cuối.  |
| [`web/29-PWF-03-mau-cua-tinh-tab-4-moc-va-cong.png`](web/29-PWF-03-mau-cua-tinh-tab-4-moc-va-cong.png) | PWF-03 | Tab Mốc và cổng | Đã mở xem bản cuối. Còn thấy: mẫu của tỉnh không khai cổng nên khối cổng chỉ có một câu. |
| [`web/29-PWF-03-mau-cua-tinh-tab-5-bang-cot.png`](web/29-PWF-03-mau-cua-tinh-tab-5-bang-cot.png) | PWF-03 | Tab Bảng cột | Đã mở xem bản cuối.  |

## PWF-04, PWF-16, PWF-06 · Chi tiết công việc (sáu tab), sổ phân công, dời lịch

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/30-PWF-04-viec-dang-lam-tab-1-viec-can-lam.png`](web/30-PWF-04-viec-dang-lam-tab-1-viec-can-lam.png) | PWF-04 | Việc đang làm và trễ, tab Việc cần làm | Đã mở xem bản cuối. Chứng từ ghi tên biểu mẫu (trước ghi mã). |
| [`web/30-PWF-04-viec-dang-lam-tab-2-can-cu-phap-ly.png`](web/30-PWF-04-viec-dang-lam-tab-2-can-cu-phap-ly.png) | PWF-04 | Tab Căn cứ pháp lý | Đã mở xem bản cuối.  |
| [`web/30-PWF-04-viec-dang-lam-tab-3-lich-va-phan-cong.png`](web/30-PWF-04-viec-dang-lam-tab-3-lich-va-phan-cong.png) | PWF-04 | Tab Lịch và phân công: sổ phân công có ba người | Đã mở xem bản cuối.  |
| [`web/30-PWF-04-viec-dang-lam-tab-4-ngoai-le.png`](web/30-PWF-04-viec-dang-lam-tab-4-ngoai-le.png) | PWF-04 | Tab Ngoại lệ: một đề nghị chờ duyệt | Đã mở xem bản cuối.  |
| [`web/30-PWF-04-viec-dang-lam-tab-5-lich-su.png`](web/30-PWF-04-viec-dang-lam-tab-5-lich-su.png) | PWF-04 | Tab Lịch sử | Đã mở xem bản cuối.  |
| [`web/30-PWF-04-viec-dang-lam-tab-6-kpi.png`](web/30-PWF-04-viec-dang-lam-tab-6-kpi.png) | PWF-04 | Tab KPI | Đã mở xem bản cuối. Còn thấy: chủ sở hữu của đơn vị vẫn nhận thẻ "Bạn không có quyền xem KPI của công việc này" (xem mục khiếm khuyết). |
| [`web/31-PWF-04-dau-trang-dinh-sau-khi-cuon.png`](web/31-PWF-04-dau-trang-dinh-sau-khi-cuon.png) | PWF-04 | Khung nhìn sau khi cuộn 520 px | Đã mở xem bản cuối. Đầu trang tóm tắt (tên việc, trạng thái, điều kiện còn thiếu) dính ở đầu khung nhìn, nội dung cuộn bên dưới. |
| [`web/32-PWF-04-viec-cho-duyet-nguoi-duyet-xem.png`](web/32-PWF-04-viec-cho-duyet-nguoi-duyet-xem.png) | PWF-04 | Việc chờ duyệt hoàn thành, nhìn bằng tài khoản lãnh đạo | Đã mở xem bản cuối. Có nút "Duyệt hoàn thành" và "Trả lại". |
| [`web/33-PWF-04-viec-da-xong-tab-lich-su.png`](web/33-PWF-04-viec-da-xong-tab-lich-su.png) | PWF-04 | Việc đã xong, tab Lịch sử | Đã mở xem bản cuối.  |
| [`web/34-PWF-04-hop-thoai-hoan-thanh.png`](web/34-PWF-04-hop-thoai-hoan-thanh.png) | PWF-04 | Hộp thoại Hoàn thành công việc | Đã mở xem bản cuối. Còn thấy: nhãn "Công việc" trong hộp gãy hai dòng. |
| [`web/35-PWF-04-viec-da-xong-tab-kpi.png`](web/35-PWF-04-viec-da-xong-tab-kpi.png) | PWF-04 | Việc đã xong, tab KPI | Đã mở xem bản cuối. Còn thấy: cũng là thẻ "không có quyền", dù việc đã có kết quả KPI. |
| [`web/38-PWF-16-so-phan-cong.png`](web/38-PWF-16-so-phan-cong.png) | PWF-16 | Sổ phân công của việc được chuyển người trước hạn | Đã mở xem bản cuối. Bốn dòng: người làm cũ (đến 13/11), người làm mới (từ 14/11), người chịu trách nhiệm, người tham vấn. Còn thấy: tiêu đề trang chứa mã việc PREP_NEEDS. |
| [`web/39-PWF-06-doi-lich-de-nghi-dang-cho.png`](web/39-PWF-06-doi-lich-de-nghi-dang-cho.png) | PWF-06 | Dời lịch của DA-PWF-01, có đề nghị đang chờ, nhìn bằng tài khoản lãnh đạo | Đã mở xem bản cuối. Còn thấy: băng cảnh báo "thiếu lịch làm việc năm 2029" và ô "Dự án kết thúc dự kiến" trống; bảng trước/sau có cột cuối bị cắt. |

## PWF-07, PWF-08, PWF-15 · Bảng deadline (từng tab), chính sách ba màu, nhắc hạn

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/40-PWF-07-tab-danh-sach.png`](web/40-PWF-07-tab-danh-sach.png) | PWF-07 | Bảng deadline, tab Danh sách | Đã mở xem bản cuối. Còn thấy: 152 việc nhưng máy chủ chỉ đưa 50 (có băng báo "Danh sách bị cắt"). |
| [`web/41-PWF-07-loc-mau-do.png`](web/41-PWF-07-loc-mau-do.png) | PWF-07 | Lọc màu đỏ bằng thẻ đếm | Đã mở xem bản cuối.  |
| [`web/42-PWF-07-hop-giai-thich-nut-i.png`](web/42-PWF-07-hop-giai-thich-nut-i.png) | PWF-07 | Hộp giải thích của nút "i" trên dải số đếm (khung nhìn) | Đã mở xem bản cuối. Hộp mở về bên trái, nằm trọn trong trang (trước tràn ra ngoài mép phải). |
| [`web/44-PWF-07-tab-lich-thang.png`](web/44-PWF-07-tab-lich-thang.png) | PWF-07 | Tab Lịch tháng | Đã mở xem bản cuối.  |
| [`web/45-PWF-07-tab-moc-30-ngay.png`](web/45-PWF-07-tab-moc-30-ngay.png) | PWF-07 | Tab Mốc 30 ngày tới | Đã mở xem bản cuối.  |
| [`web/46-PWF-07-tab-tai-cong-viec.png`](web/46-PWF-07-tab-tai-cong-viec.png) | PWF-07 | Tab Tải công việc theo người và tuần | Đã mở xem bản cuối. Còn thấy: chỉ hai người có việc ở vai trò người làm. |
| [`web/47-PWF-08-chinh-sach-ba-mau.png`](web/47-PWF-08-chinh-sach-ba-mau.png) | PWF-08 | Chính sách ba màu của tỉnh, phiên bản đã duyệt | Đã mở xem bản cuối. Còn thấy: dòng giải thích nêu ba mã nguồn cảnh báo (HOME_WORK...). |
| [`web/48-PWF-15-nhac-han-cua-toi.png`](web/48-PWF-15-nhac-han-cua-toi.png) | PWF-15 | Nhắc hạn của tôi: ngưỡng riêng, bảng xem trước, việc sắp tới | Đã mở xem bản cuối.  |

## PWF-09 đến PWF-14 · Bộ KPI, chính sách chấm điểm, bảng điểm, kỳ chấm điểm

Điểm trong bộ dữ liệu rất thấp (3 đến 14 trên 100, ai cũng "Cần cải thiện"): kỳ được tính khi quý chưa hết, và sản phẩm đọc việc còn mở tại ngày cuối kỳ nên mọi việc còn mở bị coi là trễ và nhận 0 điểm. Đây là cách tính, không phải lỗi trình bày; xem mục khiếm khuyết.

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/50-PWF-09-bo-kpi-workflow.png`](web/50-PWF-09-bo-kpi-workflow.png) | PWF-09 | Bộ KPI của workflow, phiên bản 1 của tỉnh đang hiệu lực | Đã mở xem bản cuối. Xem phần đầu và bốn KPI đầu ở cỡ thu nhỏ; ô đánh dấu đứng cạnh nhãn. Còn thấy: trang rất dài (sáu KPI, mỗi KPI một khối cao), chưa chia tab. |
| [`web/51-PWF-10-chinh-sach-cham-diem.png`](web/51-PWF-10-chinh-sach-cham-diem.png) | PWF-10 | Chính sách chấm điểm, phiên bản 1 của tỉnh đang hiệu lực | Đã mở xem bản cuối. Còn thấy: mã dải xếp loại (EXCELLENT, GOOD...) là ô nhập. |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky.png`](web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky.png) | PWF-11 | Bảng điểm của tôi (Nguyễn Văn An), tab con Điểm | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn). Còn thấy: điểm viết 8.06 (dấu chấm), điện thoại viết 8,06. |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-2-theo-viec.png`](web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-2-theo-viec.png) | PWF-11 | Tab con Theo việc: 13 việc | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn). Tên dự án là dòng riêng dưới tên việc. |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png`](web/52-PWF-11-bang-diem-cua-toi-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png) | PWF-11 | Tab con Điều chỉnh và phản hồi | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn).  |
| [`web/52-PWF-11-bang-diem-cua-toi-tab-2-so-sanh-ky.png`](web/52-PWF-11-bang-diem-cua-toi-tab-2-so-sanh-ky.png) | PWF-11 | Tab So sánh kỳ | Đã mở xem bản cuối. Xếp loại ghi "Cần cải thiện" (trước ghi mã WEAK). Còn thấy: chỉ có một kỳ nên chưa có gì để so. |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky.png) | PWF-11 | Bảng điểm của Phạm Quốc Dũng: điểm 5.9 được điều chỉnh thành 8.9 | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn).  |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-2-theo-viec.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-2-theo-viec.png) | PWF-11 | Tab con Theo việc | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn).  |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-1-diem-theo-ky-3-dieu-chinh-va-phan-hoi.png) | PWF-11 | Tab con Điều chỉnh và phản hồi: một điều chỉnh đã duyệt, một phản hồi đã xử lý | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn).  |
| [`web/53-PWF-11-can-bo-co-dieu-chinh-tab-2-so-sanh-ky.png`](web/53-PWF-11-can-bo-co-dieu-chinh-tab-2-so-sanh-ky.png) | PWF-11 | Tab So sánh kỳ | Chưa mở xem bản cuối (bản trước ghi mã WEAK; đã sửa, ảnh cùng loại 52-...-so-sanh-ky đã xem). |
| [`web/54-PWF-12-bang-diem-don-vi.png`](web/54-PWF-12-bang-diem-don-vi.png) | PWF-12 | Bảng điểm đơn vị: 9 người, 6 người có điểm | Đã mở xem bản cuối. Còn thấy: cột Thứ tự toàn dấu gạch (không xếp hạng khi mẫu chênh nhau, có lời giải thích). |
| [`web/55-PWF-13-chi-tiet-diem-tab-1-diem.png`](web/55-PWF-13-chi-tiet-diem-tab-1-diem.png) | PWF-13 | Chi tiết điểm của Phạm Quốc Dũng, tab Điểm, có khối "Có cho người rà soát" | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn).  |
| [`web/55-PWF-13-chi-tiet-diem-tab-2-theo-viec.png`](web/55-PWF-13-chi-tiet-diem-tab-2-theo-viec.png) | PWF-13 | Tab Theo việc | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn).  |
| [`web/55-PWF-13-chi-tiet-diem-tab-3-dieu-chinh-va-phan-hoi.png`](web/55-PWF-13-chi-tiet-diem-tab-3-dieu-chinh-va-phan-hoi.png) | PWF-13 | Tab Điều chỉnh và phản hồi | Đã mở xem bản chụp ngay trước lần chụp lại cuối (cùng bố cục; lần chụp lại chỉ đổi một chỗ khác trên màn).  |
| [`web/55-PWF-13-chi-tiet-diem-tab-4-so-sanh-ky.png`](web/55-PWF-13-chi-tiet-diem-tab-4-so-sanh-ky.png) | PWF-13 | Tab So sánh kỳ | Chưa mở xem bản cuối (cùng thành phần với 52-...-so-sanh-ky đã xem). |
| [`web/56-PWF-13-hop-giai-thich-nut-i.png`](web/56-PWF-13-hop-giai-thich-nut-i.png) | PWF-13 | Hộp giải thích của nút "i" cạnh điểm kỳ (khung nhìn) | Đã mở xem bản cuối. Công thức, nguồn, ngày tính, phiên bản đọc được. Còn thấy: hộp dài hơn khung nhìn 900 px nên nút "Đóng" ở đáy bị khuất, phải cuộn. |
| [`web/57-PWF-14-ky-cham-diem.png`](web/57-PWF-14-ky-cham-diem.png) | PWF-14 | Kỳ chấm điểm đã chốt, có một tín hiệu cần rà soát | Đã mở xem bản cuối. Tín hiệu "Việc trễ được chuyển người ngay trước hạn cơ sở" của Phạm Quốc Dũng. Còn thấy: tín hiệu gọi việc bằng mã PREP_NEEDS. |

## ADM liên quan · Lịch sử phiên bản quy tắc, lịch làm việc

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/60-ADM-20-phien-ban-mau-cua-tinh.png`](web/60-ADM-20-phien-ban-mau-cua-tinh.png) | ADM-20 | Các phiên bản của mẫu workflow của tỉnh trong kho quy tắc | Đã mở xem bản cuối. Còn thấy: màn quản trị hiện tham số thô (đường dẫn trường, mã) như thiết kế của kho quy tắc. |
| [`web/61-ADM-20-phien-ban-bo-kpi.png`](web/61-ADM-20-phien-ban-bo-kpi.png) | ADM-20 | Phiên bản 1 của bộ KPI trong kho quy tắc: người soạn, người duyệt | Đã mở xem bản cuối. Còn thấy: như trên. |
| [`web/62-ADM-07-lich-cong-tac.png`](web/62-ADM-07-lich-cong-tac.png) | ADM-07 | Lịch công tác và ngày nghỉ (lịch mà hạn của workflow dựa vào) | Đã mở xem bản cuối. Còn thấy: năm 2029 có bản nhưng workflow dài vẫn báo thiếu lịch 2029 ở PWF-06 (chưa tìm nguyên nhân). |

## Web ở 390 px

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`web/90-390-PRJ-03-workflow-tong-quan.png`](web/90-390-PRJ-03-workflow-tong-quan.png) | PRJ-03 | Tab Workflow, Tổng quan | Đã mở xem bản cuối. Không cuộn ngang; thẻ đếm xếp hai cột. |
| [`web/91-390-PWF-04-chi-tiet-viec.png`](web/91-390-PWF-04-chi-tiet-viec.png) | PWF-04 | Chi tiết việc | Đã mở xem bản cuối. Còn thấy: bảng "Chứng từ đã nộp" ép năm cột vào 390 px, chữ xuống dòng từng từ. |
| [`web/92-390-PWF-07-bang-deadline.png`](web/92-390-PWF-07-bang-deadline.png) | PWF-07 | Bảng deadline | Đã mở xem bản cuối. Còn thấy: bảng danh sách ép cột, tên việc xuống dòng từng từ; trang dài hơn 14.000 px. |
| [`web/93-390-PWF-11-bang-diem-cua-toi.png`](web/93-390-PWF-11-bang-diem-cua-toi.png) | PWF-11 | Bảng điểm của tôi | Đã mở xem bản cuối.  |
| [`web/94-390-PWF-12-bang-diem-don-vi.png`](web/94-390-PWF-12-bang-diem-don-vi.png) | PWF-12 | Bảng điểm đơn vị | Đã mở xem bản cuối. Còn thấy: bảng phải cuộn ngang trong khung, cột xếp loại nằm ngoài tầm nhìn. |
| [`web/95-390-PWF-01-thu-vien-mau.png`](web/95-390-PWF-01-thu-vien-mau.png) | PWF-01 | Thư viện mẫu | Đã mở xem bản cuối. Còn thấy: bảng cuộn ngang trong khung. |

## Điện thoại · Trang chủ (MOB-07)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/01-MOB-07-trang-chu-lanh-dao.png`](mobile/01-MOB-07-trang-chu-lanh-dao.png) | MOB-07 | Trang chủ lãnh đạo (Nguyễn Văn An): dải điều hành, ba ô chỉ số, việc theo hạn | Đã mở xem bản cuối. "Quá, đến hạn" một dòng. Còn thấy: nhãn tab "Thông báo" ở thanh đáy gãy hai dòng; ô "Cảnh báo đang mở" và "Cần theo dõi" mỗi cái hai dòng. |
| [`mobile/02-MOB-07-trang-chu-lanh-dao-cuon-1.png`](mobile/02-MOB-07-trang-chu-lanh-dao-cuon-1.png) | MOB-07 | Cuộn xuống: "Cần bạn quyết định" | Đã mở xem bản cuối. Câu cảnh báo workflow ngắn, dòng phụ là tên dự án, không còn mã. Còn thấy: tiêu đề vẫn bị cắt ở dòng thứ ba ("quá hạn 58 ngày làm vi..."). |
| [`mobile/03-MOB-07-trang-chu-lanh-dao-cuon-2.png`](mobile/03-MOB-07-trang-chu-lanh-dao-cuon-2.png) | MOB-07 | Cuộn tiếp: bảng điều hành Ban chỉ đạo | Đã mở xem bản cuối.  |
| [`mobile/05-MOB-07-trang-chu-can-bo.png`](mobile/05-MOB-07-trang-chu-can-bo.png) | MOB-07 | Trang chủ cán bộ (Phạm Quốc Dũng, cán bộ Ban quản lý dự án) | Đã mở xem bản cuối. Còn thấy: cán bộ Ban quản lý dự án nhận đúng bố cục trang chủ của lãnh đạo (dải giải ngân toàn tỉnh, ba ô chỉ số), chỉ khác số việc; ứng dụng không có trang chủ riêng cho cán bộ. |
| [`mobile/06-MOB-07-trang-chu-can-bo-cuon-xuong.png`](mobile/06-MOB-07-trang-chu-can-bo-cuon-xuong.png) | MOB-07 | Trang chủ cán bộ, cuộn xuống | Đã mở xem bản cuối. Còn thấy: danh sách "Cần bạn quyết định" của cán bộ có 167 mục, gồm cả việc của người khác. |

## Điện thoại · Dự án và chi tiết dự án, bốn tab (MOB-09, MOB-10)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/10-MOB-09-du-an.png`](mobile/10-MOB-09-du-an.png) | MOB-09 | Danh sách dự án | Đã mở xem bản cuối.  |
| [`mobile/85-MOB-09-loi-tat.png`](mobile/85-MOB-09-loi-tat.png) | MOB-09 | Tấm Lối tắt của tab Dự án | Đã mở xem bản cuối.  |
| [`mobile/11-MOB-10-chi-tiet-du-an-tab-tong-quan.png`](mobile/11-MOB-10-chi-tiet-du-an-tab-tong-quan.png) | MOB-10 | DA-PWF-02, tab Tổng quan | Đã mở xem bản cuối. "Tổng mức đầu tư" một dòng; không còn thanh điều hướng đáy. |
| [`mobile/12-MOB-10-tab-tong-quan-cuon-xuong.png`](mobile/12-MOB-10-tab-tong-quan-cuon-xuong.png) | MOB-10 | Tab Tổng quan sau khi cuộn | Đã mở xem bản cuối. Thanh tab dính dưới đầu màn. |
| [`mobile/13-MOB-10-tab-tien-do.png`](mobile/13-MOB-10-tab-tien-do.png) | MOB-10 | Tab Tiến độ: workflow của dự án | Đã mở xem bản cuối. Còn thấy: đầu màn ghi "Giai đoạn 1/6 · Ý tưởng, Mốc đã xong 0/6" (giai đoạn của dự án) ngay trên dòng "Giai đoạn 1/6 · Chuẩn bị đầu tư: chủ trương" (giai đoạn của workflow): hai thước đo giống nhau về hình thức. |
| [`mobile/14-MOB-10-tab-tien-do-cuon-1.png`](mobile/14-MOB-10-tab-tien-do-cuon-1.png) | MOB-10 | Tab Tiến độ, cuộn: việc theo giai đoạn | Đã mở xem bản cuối.  |
| [`mobile/15-MOB-10-tab-tien-do-cuon-2.png`](mobile/15-MOB-10-tab-tien-do-cuon-2.png) | MOB-10 | Tab Tiến độ, cuộn tiếp: mốc của dự án | Đã mở xem bản cuối. Còn thấy: dòng "Kế hoạch 13/11/2026, trễ 3..." bị cắt vì nhãn "Trễ 3 ngày" bên phải. |
| [`mobile/17-MOB-10-tab-von.png`](mobile/17-MOB-10-tab-von.png) | MOB-10 | Tab Vốn | Đã mở xem bản cuối.  |
| [`mobile/18-MOB-10-tab-ho-so.png`](mobile/18-MOB-10-tab-ho-so.png) | MOB-10 | Tab Hồ sơ | Đã mở xem bản cuối.  |

## Điện thoại · Workflow dự án, ba tab (MOB-78)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/20-MOB-78-workflow-tab-tong-quan.png`](mobile/20-MOB-78-workflow-tab-tong-quan.png) | MOB-78 | Tab Tổng quan | Đã mở xem bản cuối.  |
| [`mobile/21-MOB-78-tab-tong-quan-cuon-xuong.png`](mobile/21-MOB-78-tab-tong-quan-cuon-xuong.png) | MOB-78 | Tab Tổng quan, cuộn: các giai đoạn | Đã mở xem bản cuối. Một giai đoạn "Đang thực hiện", ba giai đoạn "Đã bắt đầu". |
| [`mobile/22-MOB-78-tab-cong-viec.png`](mobile/22-MOB-78-tab-cong-viec.png) | MOB-78 | Tab Công việc | Đã mở xem bản cuối.  |
| [`mobile/23-MOB-78-tab-cong-viec-cuon-xuong.png`](mobile/23-MOB-78-tab-cong-viec-cuon-xuong.png) | MOB-78 | Tab Công việc, cuộn xuống | Đã mở xem bản cuối.  |
| [`mobile/24-MOB-78-tab-moc.png`](mobile/24-MOB-78-tab-moc.png) | MOB-78 | Tab Mốc | Đã mở xem bản cuối.  |

## Điện thoại · Việc của tôi, ba tab (MOB-80)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/30-MOB-80-viec-cua-toi-tab-can-lam.png`](mobile/30-MOB-80-viec-cua-toi-tab-can-lam.png) | MOB-80 | Tab Cần làm, màu của bạn | Đã mở xem bản cuối.  |
| [`mobile/31-MOB-80-tab-can-lam-cuon-xuong.png`](mobile/31-MOB-80-tab-can-lam-cuon-xuong.png) | MOB-80 | Tab Cần làm, cuộn xuống | Đã mở xem bản cuối.  |
| [`mobile/32-MOB-80-tab-can-lam-mau-chinh-thuc.png`](mobile/32-MOB-80-tab-can-lam-mau-chinh-thuc.png) | MOB-80 | Tab Cần làm, màu chính thức | Đã mở xem bản cuối.  |
| [`mobile/33-MOB-80-tab-cho-duyet.png`](mobile/33-MOB-80-tab-cho-duyet.png) | MOB-80 | Tab Chờ duyệt: hai việc | Đã mở xem bản cuối.  |
| [`mobile/34-MOB-80-tab-da-xong.png`](mobile/34-MOB-80-tab-da-xong.png) | MOB-80 | Tab Đã xong | Đã mở xem bản cuối. Còn thấy: rỗng ("Không có việc nào ở mục này") dù người này đã xong nhiều việc: danh sách việc của tôi của máy chủ không trả việc đã xong. |

## Điện thoại · Chi tiết việc, bốn tab (MOB-79)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/40-MOB-79-chi-tiet-viec-tab-can-lam.png`](mobile/40-MOB-79-chi-tiet-viec-tab-can-lam.png) | MOB-79 | Tab Cần làm | Đã mở xem bản cuối. Không còn thanh điều hướng đáy, chỉ còn thanh hành động. |
| [`mobile/41-MOB-79-tab-can-lam-cuon-xuong-thanh-tab-dinh.png`](mobile/41-MOB-79-tab-can-lam-cuon-xuong-thanh-tab-dinh.png) | MOB-79 | Tab Cần làm sau khi cuộn | Đã mở xem bản cuối. Thanh tab dính dưới đầu màn; chứng từ ghi tên mục kiểm (trước ghi mã). |
| [`mobile/43-MOB-79-tab-thong-tin.png`](mobile/43-MOB-79-tab-thong-tin.png) | MOB-79 | Tab Thông tin: Phân công | Đã mở xem bản cuối. Có người chịu trách nhiệm và người phối hợp từ seed mới. |
| [`mobile/44-MOB-79-tab-thong-tin-cuon-xuong.png`](mobile/44-MOB-79-tab-thong-tin-cuon-xuong.png) | MOB-79 | Tab Thông tin, cuộn: vị trí trong quy trình | Đã mở xem bản cuối. Còn thấy: dòng "Mã việc RR_SURVEY" (cố ý, để đối chiếu với máy tính). |
| [`mobile/45-MOB-79-tab-can-cu.png`](mobile/45-MOB-79-tab-can-cu.png) | MOB-79 | Tab Căn cứ | Đã mở xem bản cuối.  |
| [`mobile/46-MOB-79-tab-dien-bien.png`](mobile/46-MOB-79-tab-dien-bien.png) | MOB-79 | Tab Diễn biến | Đã mở xem bản cuối.  |
| [`mobile/47-MOB-79-tab-dien-bien-cuon-xuong.png`](mobile/47-MOB-79-tab-dien-bien-cuon-xuong.png) | MOB-79 | Tab Diễn biến, cuộn: lịch sử | Đã mở xem bản cuối.  |
| [`mobile/48-MOB-79-viec-cho-duyet.png`](mobile/48-MOB-79-viec-cho-duyet.png) | MOB-79 | Một việc chờ duyệt hoàn thành | Đã mở xem bản cuối. Trạng thái chỉ ghi một lần. |

## Điện thoại · Điểm KPI (MOB-81) và nhắc hạn (MOB-82)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/50-MOB-81-diem-kpi-tab-theo-viec.png`](mobile/50-MOB-81-diem-kpi-tab-theo-viec.png) | MOB-81 | Điểm KPI của tôi, tab Theo việc | Đã mở xem bản cuối. Tên dự án dưới tên việc. |
| [`mobile/51-MOB-81-tab-dieu-chinh.png`](mobile/51-MOB-81-tab-dieu-chinh.png) | MOB-81 | Tab Điều chỉnh | Đã mở xem bản cuối. Còn thấy: chỉ một câu (người này không có điều chỉnh). |
| [`mobile/52-MOB-81-tab-cach-tinh.png`](mobile/52-MOB-81-tab-cach-tinh.png) | MOB-81 | Tab Cách tính | Đã mở xem bản cuối.  |
| [`mobile/55-MOB-82-cai-dat-nhac-han.png`](mobile/55-MOB-82-cai-dat-nhac-han.png) | MOB-82 | Cài đặt nhắc hạn | Đã mở xem bản cuối.  |
| [`mobile/56-MOB-82-cai-dat-nhac-han-cuon-xuong.png`](mobile/56-MOB-82-cai-dat-nhac-han-cuon-xuong.png) | MOB-82 | Cài đặt nhắc hạn, cuộn xuống | Đã mở xem bản cuối.  |

## Điện thoại · Cá nhân (MOB-47), Thông báo (MOB-32)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/60-MOB-47-ca-nhan.png`](mobile/60-MOB-47-ca-nhan.png) | MOB-47 | Cá nhân: hồ sơ, công việc của tôi, nhắc hạn | Đã mở xem bản cuối.  |
| [`mobile/61-MOB-47-ca-nhan-cuon-1.png`](mobile/61-MOB-47-ca-nhan-cuon-1.png) | MOB-47 | Cá nhân, cuộn: cài đặt, công cụ | Đã mở xem bản cuối.  |
| [`mobile/62-MOB-47-ca-nhan-cuon-2.png`](mobile/62-MOB-47-ca-nhan-cuon-2.png) | MOB-47 | Cá nhân, cuộn tiếp: tài khoản, hỗ trợ | Đã mở xem bản cuối.  |
| [`mobile/70-MOB-32-thong-bao-tab-su-kien.png`](mobile/70-MOB-32-thong-bao-tab-su-kien.png) | MOB-32 | Thông báo, tab Sự kiện | Đã mở xem bản cuối. Còn thấy: rỗng, và câu trạng thái rỗng nói "tạo bản ghi đầu tiên" (không hợp với thông báo). |
| [`mobile/71-MOB-32-thong-bao-tab-viec-can-xu-ly.png`](mobile/71-MOB-32-thong-bao-tab-viec-can-xu-ly.png) | MOB-32 | Thông báo, tab Việc cần xử lý | Đã mở xem bản cuối. Còn thấy: tiêu đề cắt ở dòng thứ ba. |

## Điện thoại · Phê duyệt (MOB-23, MOB-24): bản công rỗng, bản doanh nghiệp có việc

Lần đầu chụp được nhờ cờ MACHVON_ALLOW_SCREENSHOTS. Bản công không có việc chờ duyệt nên ba tab của chi tiết chụp trên bản doanh nghiệp (cùng mã nguồn màn).

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/75-MOB-23-phe-duyet-ban-cong-chua-co-viec.png`](mobile/75-MOB-23-phe-duyet-ban-cong-chua-co-viec.png) | MOB-23 | Hộp phê duyệt, bản công | Đã mở xem bản cuối. Còn thấy: rỗng; câu trạng thái rỗng nói "tạo bản ghi đầu tiên". |
| [`mobile/e10-MOB-23-hop-phe-duyet.png`](mobile/e10-MOB-23-hop-phe-duyet.png) | MOB-23 | Hộp phê duyệt, bản doanh nghiệp: sáu báo cáo tuần chờ quyết định | Đã mở xem bản cuối. Còn thấy: sáu hàng cùng tiêu đề "Nhận báo cáo", chỉ khác số tiền; tên dự án không hiện ở hàng. |
| [`mobile/e11-MOB-24-chi-tiet-phe-duyet-tab-1.png`](mobile/e11-MOB-24-chi-tiet-phe-duyet-tab-1.png) | MOB-24 | Chi tiết phê duyệt, tab Nội dung | Đã mở xem bản cuối.  |
| [`mobile/e14-MOB-24-tab-noi-dung-cuon-xuong.png`](mobile/e14-MOB-24-tab-noi-dung-cuon-xuong.png) | MOB-24 | Tab Nội dung sau khi cuộn | Đã mở xem bản cuối.  |
| [`mobile/e12-MOB-24-tab-so-sanh.png`](mobile/e12-MOB-24-tab-so-sanh.png) | MOB-24 | Tab So sánh | Đã mở xem bản cuối. Còn thấy: gần như trống (báo cáo tuần không có bản trước để so). |
| [`mobile/e13-MOB-24-tab-bang-chung.png`](mobile/e13-MOB-24-tab-bang-chung.png) | MOB-24 | Tab Bằng chứng | Đã mở xem bản cuối. Còn thấy: gần như trống (báo cáo không kèm tệp). |

## Điện thoại · Văn bản đến (DOC-23, DOC-24) và xem lại báo cáo hiện trường (MOB-20), mỗi màn ba tab

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/80-DOC-23-van-ban-den.png`](mobile/80-DOC-23-van-ban-den.png) | DOC-23 | Văn bản đến cần xử lý | Đã mở xem bản cuối.  |
| [`mobile/81-DOC-24-van-ban-den-tab-thong-tin.png`](mobile/81-DOC-24-van-ban-den-tab-thong-tin.png) | DOC-24 | Xử lý văn bản đến, tab Thông tin | Đã mở xem bản cuối. Còn thấy: màn chi tiết này vẫn có thanh điều hướng đáy dưới nút hành động (các màn chi tiết của workflow thì không). |
| [`mobile/82-DOC-24-tab-tep.png`](mobile/82-DOC-24-tab-tep.png) | DOC-24 | Tab Tệp | Đã mở xem bản cuối. Còn thấy: chỉ có mã băm của tệp và lời giải thích; điện thoại không mở tệp. |
| [`mobile/83-DOC-24-tab-dien-bien.png`](mobile/83-DOC-24-tab-dien-bien.png) | DOC-24 | Tab Diễn biến | Đã mở xem bản cuối.  |
| [`mobile/86-MOB-20-ra-soat-bao-cao-tab-kiem-tra.png`](mobile/86-MOB-20-ra-soat-bao-cao-tab-kiem-tra.png) | MOB-20 | Rà soát và gửi báo cáo, tab Kiểm tra | Đã mở xem bản cuối. Còn thấy: câu lỗi cắt ở hai dòng ("Chưa nhập khối lượng thi công, ng..."); cùng hai mục lặp lại ở nhóm "Máy chủ kiểm tra". |
| [`mobile/87-MOB-20-tab-so-lieu.png`](mobile/87-MOB-20-tab-so-lieu.png) | MOB-20 | Tab Số liệu | Đã mở xem bản cuối. Còn thấy: nhãn "Tổng lũy kế sáu ô" khó hiểu; báo cáo chưa nhập số nên toàn 0. |
| [`mobile/88-MOB-20-tab-thuyet-minh-tep.png`](mobile/88-MOB-20-tab-thuyet-minh-tep.png) | MOB-20 | Tab Thuyết minh, tệp | Đã mở xem bản cuối.  |

## Điện thoại · Bản doanh nghiệp (Đạm Phú Mỹ)

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/e01-MOB-07-trang-chu.png`](mobile/e01-MOB-07-trang-chu.png) | MOB-07 | Trang chủ | Đã mở xem bản cuối.  |
| [`mobile/e02-MOB-07-trang-chu-cuon-xuong.png`](mobile/e02-MOB-07-trang-chu-cuon-xuong.png) | MOB-07 | Trang chủ, cuộn xuống | Đã mở xem bản cuối.  |
| [`mobile/e20-MOB-80-viec-cua-toi.png`](mobile/e20-MOB-80-viec-cua-toi.png) | MOB-80 | Việc của tôi: hai việc đang làm | Đã mở xem bản cuối.  |
| [`mobile/e30-MOB-81-diem-kpi-tab-theo-viec.png`](mobile/e30-MOB-81-diem-kpi-tab-theo-viec.png) | MOB-81 | Điểm KPI của tôi: 34,16, bốn việc | Đã mở xem bản cuối. Màn không còn rỗng. Còn thấy: mẫu nhỏ nên không có xếp loại. |
| [`mobile/e31-MOB-81-tab-cach-tinh.png`](mobile/e31-MOB-81-tab-cach-tinh.png) | MOB-81 | Tab Cách tính | Đã mở xem bản cuối.  |

## Điện thoại · Chế độ tối

| Ảnh | Mã màn | Đang hiển thị | Đã tự xem chưa, và điều còn thấy |
|---|---|---|---|
| [`mobile/90-toi-MOB-07-trang-chu.png`](mobile/90-toi-MOB-07-trang-chu.png) | MOB-07 | Trang chủ | Đã mở xem bản cuối. Chữ, biểu tượng và ba dải màu đọc rõ trên nền tối. |
| [`mobile/91-toi-MOB-09-du-an.png`](mobile/91-toi-MOB-09-du-an.png) | MOB-09 | Dự án | Đã mở xem bản cuối. Chữ, biểu tượng và ba dải màu đọc rõ trên nền tối. |
| [`mobile/92-toi-MOB-10-chi-tiet-du-an.png`](mobile/92-toi-MOB-10-chi-tiet-du-an.png) | MOB-10 | Chi tiết dự án | Đã mở xem bản cuối. Chữ, biểu tượng và ba dải màu đọc rõ trên nền tối. |
| [`mobile/93-toi-MOB-78-workflow-tab-tong-quan.png`](mobile/93-toi-MOB-78-workflow-tab-tong-quan.png) | MOB-78 | Workflow, tab Tổng quan | Đã mở xem bản cuối. Chữ, biểu tượng và ba dải màu đọc rõ trên nền tối. |
| [`mobile/94-toi-MOB-78-tab-cong-viec.png`](mobile/94-toi-MOB-78-tab-cong-viec.png) | MOB-78 | Workflow, tab Công việc | Đã mở xem bản cuối. Chữ, biểu tượng và ba dải màu đọc rõ trên nền tối. |
| [`mobile/95-toi-MOB-47-ca-nhan.png`](mobile/95-toi-MOB-47-ca-nhan.png) | MOB-47 | Cá nhân | Đã mở xem bản cuối. Chữ, biểu tượng và ba dải màu đọc rõ trên nền tối. |
| [`mobile/96-toi-MOB-80-viec-cua-toi.png`](mobile/96-toi-MOB-80-viec-cua-toi.png) | MOB-80 | Việc của tôi | Đã mở xem bản cuối. Chữ, biểu tượng và ba dải màu đọc rõ trên nền tối. |
| [`mobile/97-toi-MOB-79-chi-tiet-viec.png`](mobile/97-toi-MOB-79-chi-tiet-viec.png) | MOB-79 | Chi tiết việc | Đã mở xem bản cuối. Chữ, biểu tượng và ba dải màu đọc rõ trên nền tối. |
| [`mobile/98-toi-MOB-79-tab-thong-tin.png`](mobile/98-toi-MOB-79-tab-thong-tin.png) | MOB-79 | Chi tiết việc, tab Thông tin | Đã mở xem bản cuối. Chữ, biểu tượng và ba dải màu đọc rõ trên nền tối. |
| [`mobile/99-toi-MOB-81-diem-kpi.png`](mobile/99-toi-MOB-81-diem-kpi.png) | MOB-81 | Điểm KPI của tôi | Đã mở xem bản cuối. Chữ, biểu tượng và ba dải màu đọc rõ trên nền tối. |

## Khiếm khuyết còn lại, xếp theo mức nghiêm trọng

**Nghiêm trọng (logic hoặc dữ liệu, không sửa trong làn này)**

1. Điểm chấm quá thấp và vô nghĩa khi kỳ được tính giữa quý: việc còn mở được đọc tại ngày cuối kỳ nên bị coi là trễ và nhận 0 điểm. Cả đơn vị từ 3 đến 14 điểm trên 100, ai cũng "Cần cải thiện" (`web/54`, `web/52`, `mobile/50`). Tính thử kỳ quý trước cũng ra toàn 0. Cần quyết định nghiệp vụ: việc chưa đến hạn tại ngày tính có được chấm không.
2. Tab KPI của chi tiết việc (PWF-04) luôn báo "Bạn không có quyền xem KPI của công việc này", kể cả với chủ sở hữu đơn vị và với việc đã có kết quả KPI (`web/30-...-6-kpi`, `web/35`). Bản đọc chi tiết việc không trả trường `kpi_results`, trong khi `GET /project-tasks/{id}/kpi-results` trả 200 cho cùng người; màn hiểu thiếu trường là thiếu quyền.
3. Bản công không có việc chờ phê duyệt nào: hộp Phê duyệt của điện thoại rỗng với mọi người (`mobile/75`).
4. Tab "Đã xong" của Việc của tôi trên điện thoại luôn rỗng (`mobile/34`): danh sách việc của tôi của máy chủ chỉ nhận bốn trạng thái còn mở.
5. PWF-06 báo "thiếu lịch làm việc năm 2029" và để trống ngày kết thúc dự kiến, dù ADM-07 có lịch 2029 (`web/39`, `web/62`). Chưa tìm nguyên nhân.
6. Flow Maestro 40 trên bản doanh nghiệp: chạy một lần sau khi có điểm, dừng ở bước chờ băng "Bạn đang ngoại tuyến" sau khi bật chế độ máy bay (trước bước điểm), nên CHƯA xác nhận được flow đi hết. Màn điểm thì đã có dữ liệu (`mobile/e30`).

**Trung bình (trình bày, còn lại)**

7. Bảng deadline có 152 việc nhưng chỉ hiện 50, kèm băng "Danh sách bị cắt" (`web/40`).
8. Ở 390 px các bảng nhiều cột bị ép: chữ xuống dòng từng từ (`web/91`, `web/92`) hoặc phải cuộn ngang trong khung (`web/94`, `web/95`).
9. PWF-09 là một trang rất dài (gần 9.000 px), chưa chia tab theo từng KPI (`web/50`).
10. Mã còn lộ ở chỗ người dùng thường đọc: loại dự án do tỉnh đặt ở PWF-01 (ROAD_REPAIR), tiêu đề "Việc RR_ESTIMATE" ở PWF-02, tiêu đề PWF-16 và tín hiệu ở PWF-14 (PREP_NEEDS), mã mốc và ngày dạng 2026-11-13 ở tab Kế hoạch của PRJ-03, vai trò do tỉnh đặt.
11. Điện thoại: tiêu đề cảnh báo cắt ở dòng thứ ba (`mobile/02`, `mobile/71`); câu lỗi của MOB-20 cắt ở hai dòng (`mobile/86`).
12. Điện thoại: câu trạng thái rỗng dùng chung "Điều chỉnh bộ lọc hoặc tạo bản ghi đầu tiên" không hợp với Thông báo và Phê duyệt (`mobile/70`, `mobile/75`).
13. Điện thoại: hàng của hộp Phê duyệt không phân biệt được nhau, sáu hàng cùng tiêu đề (`mobile/e10`); hai tab So sánh và Bằng chứng gần như trống với báo cáo tuần (`mobile/e12`, `mobile/e13`).
14. Hộp giải thích của nút "i" ở PWF-13 dài hơn khung nhìn 900 px, nút Đóng bị khuất (`web/56`).

**Nhẹ**

15. Điểm viết dấu chấm trên web (8.06) và dấu phẩy trên điện thoại (8,06).
16. Nhãn tab "Thông báo" ở thanh đáy điện thoại gãy hai dòng; ô "Cảnh báo đang mở" và nhãn "Cần theo dõi" ở trang chủ mỗi cái hai dòng (`mobile/01`).
17. PWF-02: ô "Vai trò chịu trách nhiệm bước" đứng lệch so với ba ô cùng hàng (`web/12-...-tab-2`); nút "Bỏ liên kết" thấp hơn hàng; ô "Nội dung mục" hẹp.
18. PRJ-02: hai nhóm trường có khung viền đậm của trình duyệt; thẻ lồng thẻ (`web/01`).
19. Màn chi tiết văn bản đến trên điện thoại còn thanh điều hướng đáy, khác các màn chi tiết của workflow (`mobile/81`).
20. Chi tiết dự án trên điện thoại hiện hai dòng "Giai đoạn 1/6" của hai thước đo khác nhau (`mobile/13`).
21. Ô ngày trên web hiện theo ngôn ngữ của trình duyệt chụp (ở lượt này là ngày/tháng/năm).

## Lỗi trình bày đã sửa trong làn này

- Web, mọi màn PWF: ô đánh dấu và nút tròn bị bảng kiểu chung kéo rộng cả hàng, đứng một dòng riêng phía trên nhãn; nay đứng cạnh nhãn (thấy rõ nhất ở PWF-02 và PWF-05).
- Web, PWF-01: bảng thư viện tràn ngang ở 1440 px, cột Thao tác bị cắt; nay vừa trang, hai nút xếp dọc.
- Web, PWF-02: hàng việc trong cây cao bất thường; các ô của một hàng lệch nhau khi một ô có dòng gợi ý; khung nhóm dùng viền mặc định của trình duyệt.
- Web, PWF-05: năm số đếm của kết quả chạy thử dính liền nhau.
- Web, PWF-07: hộp của nút "i" trên dải số đếm tràn ra ngoài mép phải, làm trang cuộn ngang.
- Web, PRJ-03: tổng mức đầu tư gãy giữa số trong ô chỉ số.
- Web, PWF-11/13: tên dự án dính liền tên việc; bảng So sánh kỳ ghi mã WEAK thay cho "Cần cải thiện".
- Web, chữ: "kernel" trong hai nhãn (PWF-02, PWF-09) đổi thành "hệ thống".
- Seed: chứng từ nộp kèm ghi mã mục kiểm và mã biểu mẫu trong tên; nay ghi tên.

Không sửa mã điện thoại trong làn này, nên không có golden nào đổi (`mobile-goldens-changed.txt` ghi rõ).
