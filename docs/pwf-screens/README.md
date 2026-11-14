# Ảnh chụp màn hình phần workflow dự án (PWF), bản công

Chụp ngày 14/11/2026 trên ứng dụng chạy thật: stack bản công dựng từ nhánh `lane/shots` (API thật trên PostgreSQL nhúng, seed `clip-seed --dataset public`), web dựng tĩnh ở chế độ development, điện thoại là APK debug bản công trên AVD "guide". Không có ảnh mock hay ảnh golden. Mở `index.html` để xem theo nhóm.

## Dữ liệu trong ảnh lấy từ đâu

- Seed công sẵn có (45 dự án, kho biểu mẫu, người dùng) và nhóm `clip-public-phone-work`.
- Nhóm seed mới `clip-public-pwf-review` (`apps/web/e2e/hdsd/seed/clip/pwf-review.ts`, đã đăng ký vào dataset public), chỉ gọi lệnh thật của sản phẩm: ba biểu mẫu của workflow (một biểu mẫu có hai bản), mẫu của tỉnh CB_ROAD_REPAIR (bản 1 đã duyệt, bản 2 chờ duyệt), bản nháp CB_SCHOOL_EQUIPMENT, quy tắc ánh xạ loại quy trình và chính sách ba màu của tỉnh (An soạn, Bích duyệt), tám dự án DA-PWF-01 đến 08 đăng ký kèm workflow, việc ở các trạng thái, ngoại lệ, dời lịch, ngưỡng nhắc cá nhân, kỳ chấm điểm quý đã chốt kèm điều chỉnh và phản hồi. Chạy lại: `node --experimental-strip-types e2e/hdsd/seed/run.ts --groups clip-public-pwf-review` (từ `apps/web`, cần `E2E_STACK_INFO` và `E2E_SESSION_KEY`).
- Thao tác tay trên giao diện khi chụp: hai dự án DA-PWF-A01, DA-PWF-B02 (PRJ-02), khởi tạo workflow cho DA-MT619 (PWF-05), đánh dấu mục kiểm, nộp bằng chứng, hoàn thành việc ở DA-CN162.
- Trong lúc dựng seed, bốn dự án DA-PWF-A01, B02, C03, D04 và DA-CN162, DA-MT619 đã nhận thêm việc từ bản seed đầu (đã thay); chúng vẫn nằm trong danh mục khi chụp. Trên stack sạch nhóm seed chỉ tạo DA-PWF-01 đến 08.

## Lưu ý về cách chụp

- Web: Chromium của Playwright, 1440×900, vi-VN; ảnh toàn trang trừ khi tên ảnh ghi khung nhìn. Trong ảnh toàn trang, thanh bên trái chỉ cao 900 px: do cách chụp, không phải lỗi. Các ảnh `21` đến `28`, `14` đến `18`, `31` là ảnh cắt theo từng khối của một trang dài.
- Ảnh đã giảm xuống 128 màu để nhẹ (tổng khoảng 6 MB); màu có thể lệch rất nhẹ so với màn thật.
- Tôi đã mở từng ảnh để soát. 30 ảnh web và 8 ảnh điện thoại xem ở cỡ gốc hoặc gần gốc; số còn lại (web 02, 04, 05, 07, 09, 10, 14, 16, 22, 30, 31, 34, 35, 37, 38, 41, 42, 43, 45, 47, 50, 51, 53 và phần lớn ảnh điện thoại) xem trên tờ ghép thu nhỏ, nên nhận xét về chúng chỉ ở mức bố cục, có thể sót lỗi chữ nhỏ.

## 1. PRJ-02 · Đăng ký dự án, mục "Loại quy trình xử lý"

Thao tác thật trên giao diện bằng tài khoản Nguyễn Văn An (owner). Khung nhìn kéo cao 1440×2400 để cả biểu mẫu nằm trong một ảnh (thanh nút dính đáy che bảng khi chụp ở 900).

| Ảnh | Mã màn | Đang hiển thị | Dữ liệu từ đâu | Điểm chưa ổn nhìn thấy trong ảnh |
|---|---|---|---|---|
| [`web/01-PRJ-02-dang-ky-du-an-loai-quy-trinh-de-xuat-tu-dong-xem-truoc-lich.png`](web/01-PRJ-02-dang-ky-du-an-loai-quy-trinh-de-xuat-tu-dong-xem-truoc-lich.png) | PRJ-02 | Đề xuất tự động PUBLIC_INVESTMENT (quy tắc ánh xạ phiên bản 1 của tỉnh), xem trước lịch: hoàn thành 24/01/2029, 568 ngày làm việc, 6 giai đoạn, 13 bước, 32 công việc, bảng thời gian từng bước. | Nhập tay trên form, chưa lưu (mã DA-PWF-XEM). | Cột "Bước" của bảng xem trước tô nền đậm như tiêu đề (th hàng), nặng và lệch kiểu so với các bảng khác. Ô chọn "Loại quy trình" cắt chữ "Theo đề xuất của quy t…". Nhãn "Ngày dự định bắt đầu" lệch hàng với ba nhãn còn lại. "phiên bản 0" của mẫu mặc định dễ hiểu lầm. |
| [`web/02-PRJ-02-khung-nhin-1440x900-muc-loai-quy-trinh.png`](web/02-PRJ-02-khung-nhin-1440x900-muc-loai-quy-trinh.png) | PRJ-02 | Cùng màn ở đúng khung nhìn 1440×900, cuộn tới mục loại quy trình. | Như trên. | Thanh "Hủy / Tạo dự án" dính đáy che mất các dòng cuối của bảng xem trước; phải cuộn trong khung con mới đọc hết. |
| [`web/03-PRJ-02-doi-loai-quy-trinh-thieu-ly-do-bi-chan.png`](web/03-PRJ-02-doi-loai-quy-trinh-thieu-ly-do-bi-chan.png) | PRJ-02 | Chọn PUBLIC_PROCUREMENT khác đề xuất, bấm "Tạo dự án" khi chưa có lý do: hệ thống chặn, yêu cầu lý do từ 10 ký tự. | Thao tác thật (dự án DA-PWF-B02). | Thông báo chặn nằm giữa form, xa nút bấm; ô lý do không tô viền lỗi. |
| [`web/04-PRJ-02-doi-loai-quy-trinh-co-ly-do-xem-truoc-lich.png`](web/04-PRJ-02-doi-loai-quy-trinh-co-ly-do-xem-truoc-lich.png) | PRJ-02 | Đã nhập lý do đổi loại; xem trước lịch của PUBLIC_PROCUREMENT (221 ngày làm việc, 9 bước, 19 việc). | Thao tác thật. | Như ảnh 01. |
| [`web/05-PRJ-02-da-tao-du-an-kem-workflow.png`](web/05-PRJ-02-da-tao-du-an-kem-workflow.png) | PRJ-02 | Sau khi tạo dự án DA-PWF-A01 theo đề xuất: thẻ "Đã tạo dự án", quy trình đã khởi tạo cùng dự án. | Lệnh thật `POST /projects` qua giao diện. | "Mở quy trình" chỉ là chữ thường cạnh câu, trong khi "Mở không gian dự án" là nút: liên kết chính bị chìm. Ngày hiện dạng 2026-11-14 (ISO) trong câu "Nhóm gợi ý". |
| [`web/06-PRJ-02-da-tao-du-an-loai-quy-trinh-khac-de-xuat.png`](web/06-PRJ-02-da-tao-du-an-loai-quy-trinh-khac-de-xuat.png) | PRJ-02 | Sau khi tạo DA-PWF-B02 với loại quy trình khác đề xuất, lý do được giữ trên form đã khóa. | Lệnh thật qua giao diện. | Như ảnh 05. |

## 2. PWF-05 · Khởi tạo và tiếp nhận workflow

Dự án đang chạy DA-DT205 (tiếp nhận) và dự án ý tưởng DA-TT015 (khởi tạo).

| Ảnh | Mã màn | Đang hiển thị | Dữ liệu từ đâu | Điểm chưa ổn nhìn thấy trong ảnh |
|---|---|---|---|---|
| [`web/07-PWF-05-tiep-nhan-workflow-du-an-dang-chay-de-xuat-tu-dong.png`](web/07-PWF-05-tiep-nhan-workflow-du-an-dang-chay-de-xuat-tu-dong.png) | PWF-05 | Chế độ "Dự án đang chạy: tiếp nhận workflow": đề xuất tự động, tóm tắt mẫu (6 giai đoạn, 34 việc), dữ kiện chọn nhánh. | Dự án DA-DT205 của seed `capital`. | Hai lựa chọn "Cách bắt đầu" xếp lệch (nút radio cách xa nhãn, nhãn gãy 3 dòng). Dữ kiện là ô gõ mã tự do (STATE_BUDGET, UPGRADE) thay vì danh sách chọn. Nút chính "Chạy thử tiếp nhận" không có khung nút, trông như chữ thường. |
| [`web/08-PWF-05-chay-thu-tiep-nhan-bao-loi.png`](web/08-PWF-05-chay-thu-tiep-nhan-bao-loi.png) | PWF-05 | Bấm "Chạy thử tiếp nhận": màn báo "Không thực hiện được. Hãy thử lại sau." | Lệnh thật `POST /projects/{id}/workflow/adopt` (dry_run). | LỖI CHỨC NĂNG: máy chủ trả 500 ("command adoptProjectWorkflow wrote no audit entry"). Không chạy thử được nên không có bước "Áp dụng": tiếp nhận workflow cho dự án đang chạy không làm được trên giao diện. |
| [`web/09-PWF-05-khoi-tao-workflow-xem-truoc-lich-mau-mac-dinh-bao-loi.png`](web/09-PWF-05-khoi-tao-workflow-xem-truoc-lich-mau-mac-dinh-bao-loi.png) | PWF-05 | Khởi tạo với mẫu mặc định, bấm "Xem trước lịch của mẫu": báo "Dữ liệu chưa hợp lệ ở mục params.tasks.approver_role". | Lệnh thật `POST /project-workflow/templates/preview`. | LỖI CHỨC NĂNG: xem trước lịch ở PWF-05 luôn bị từ chối 400 (cả mẫu mặc định lẫn mẫu của tỉnh); thông báo lộ tên trường kỹ thuật. (Xem trước ở PRJ-02 và PWF-02 thì chạy.) |
| [`web/10-PWF-05-khoi-tao-workflow-mau-cua-tinh-xem-truoc-lich-bao-loi.png`](web/10-PWF-05-khoi-tao-workflow-mau-cua-tinh-xem-truoc-lich-bao-loi.png) | PWF-05 | Chọn mẫu của tỉnh CB_ROAD_REPAIR (khác đề xuất, có ô lý do), xem trước lịch vẫn báo lỗi như trên. | Mẫu do nhóm seed `clip-public-pwf-review` tạo. | Như ảnh 09. Danh sách mẫu hiện mã trần "CB_ROAD_REPAIR" không kèm tên. |

## 3. PWF-01, PWF-02 · Thư viện mẫu và trình soạn mẫu

Mẫu của tỉnh CB_ROAD_REPAIR: phiên bản 1 đã duyệt (An soạn, Bích duyệt), phiên bản 2 đã trình chờ duyệt; CB_SCHOOL_EQUIPMENT là bản nháp; ba mẫu mặc định.

| Ảnh | Mã màn | Đang hiển thị | Dữ liệu từ đâu | Điểm chưa ổn nhìn thấy trong ảnh |
|---|---|---|---|---|
| [`web/11-PWF-01-thu-vien-mau-workflow-va-so-sanh-hai-phien-ban.png`](web/11-PWF-01-thu-vien-mau-workflow-va-so-sanh-hai-phien-ban.png) | PWF-01 | Thư viện: 5 mẫu, trạng thái từng phiên bản, mẫu đang hiệu lực, quy mô; khối so sánh hai phiên bản liệt kê việc thay đổi. | nhóm seed `clip-public-pwf-review` (lệnh quy tắc quản trị: soạn, trình, duyệt bởi người thứ hai). | Bảng bị cắt bên phải: cột "Quy mô" gãy từng chữ, cột "Thao tác" chỉ còn "Thao", các liên kết bị cụt. Dòng cuối (PUBLIC_REPAIR) bị cắt ngang ở đáy khung. So sánh hiện tên trường tiếng Anh "duration_working_days, checklist". |
| [`web/12-PWF-01-so-sanh-chi-tiet-hai-phien-ban-mau-cua-tinh.png`](web/12-PWF-01-so-sanh-chi-tiet-hai-phien-ban-mau-cua-tinh.png) | ADM-22 | Màn "So sánh phiên bản quy tắc" mở từ liên kết "Xem so sánh từng tham số". | Hai phiên bản của CB_ROAD_REPAIR. | KHÔNG ĐỌC ĐƯỢC: cả mảng tasks hiện thành một khối JSON thô gạch ngang; cột "Tham số" và "Loại thay đổi" trống; "(APPROVED)" tiếng Anh. |
| [`web/14-PWF-02-buoc-cua-giai-doan-va-can-cu-phap-ly.png`](web/14-PWF-02-buoc-cua-giai-doan-va-can-cu-phap-ly.png) | PWF-02 | Bước của từng giai đoạn với vai trò chịu trách nhiệm và căn cứ pháp lý (mã văn bản, điều khoản, ghi chú, trạng thái kiểm chứng). | Mẫu CB_ROAD_REPAIR. | Vai trò và mã văn bản là mã trần (SITE_ENGINEER, LAW_50_2014_QH13); form rất dài, mọi bước đều mở sẵn. |
| [`web/15-PWF-02-cay-cong-viec-checklist-can-cu-bieu-mau.png`](web/15-PWF-02-cay-cong-viec-checklist-can-cu-bieu-mau.png) | PWF-02 | Cây công việc, đang chọn RR_ESTIMATE: thời lượng, vai, việc làm trước, chứng từ/biểu mẫu/KPI, căn cứ pháp lý, chính sách phiên bản biểu mẫu, danh mục kiểm. | Mẫu CB_ROAD_REPAIR. | Khối "Chọn KPI từ sổ KPI" liệt kê khoảng 65 mã KPI của mọi module (COMMITTEE_…, VENDOR_…, HUB_…) bằng mã tiếng Anh, đẩy phần danh mục kiểm xuống rất xa. Ảnh cắt ở 9000 px. |
| [`web/16-PWF-02-kiem-tra-mau.png`](web/16-PWF-02-kiem-tra-mau.png) | PWF-02 | Kết quả "Kiểm tra ngay": hợp lệ, số việc, số giai đoạn, chuỗi phụ thuộc dài nhất. | Lệnh `templates/validate`. | Không thấy lỗi bố cục. |
| [`web/17-PWF-02-xem-truoc-lich.png`](web/17-PWF-02-xem-truoc-lich.png) | PWF-02 | Xem trước lịch của mẫu: ngày bắt đầu, kết thúc, đường găng, bảng từng việc. | Lệnh `templates/preview` từ trình soạn. | Mọi việc đều gắn nhãn "Găng" (chuỗi nối tiếp) nên nhãn mất ý nghĩa; ba ô dữ kiện là ô gõ tự do. |
| [`web/18-PWF-02-lich-su-phien-ban-hai-nguoi-soan-duyet.png`](web/18-PWF-02-lich-su-phien-ban-hai-nguoi-soan-duyet.png) | PWF-02 | Lịch sử phiên bản: bản 2 chờ người duyệt, bản 1 đang hiệu lực, lý do từng bản. | nhóm seed `clip-public-pwf-review`. | "Người duyệt: 00000000" là mảnh mã định danh, không phải tên người. Nút "Duyệt" mờ nằm chen giữa dòng chú thích. |

## 4. PRJ-03 (tab Workflow) và PWF-03 · Workflow của dự án

Dự án DA-PWF-02 (mua sắm, khởi tạo cách đây 68 ngày làm việc, có một lần dời lịch đã duyệt) và DA-PWF-04 (mẫu của tỉnh).

| Ảnh | Mã màn | Đang hiển thị | Dữ liệu từ đâu | Điểm chưa ổn nhìn thấy trong ảnh |
|---|---|---|---|---|
| [`web/21-PRJ-03-workflow-tong-quan-lich-va-so-lieu.png`](web/21-PRJ-03-workflow-tong-quan-lich-va-so-lieu.png) | PRJ-03 | Đầu tab: mẫu đã đóng băng, ngày bắt đầu, kết thúc dự kiến, việc trên đường găng, trễ nhiều nhất so với đường cơ sở; đếm đỏ 6, vàng 0, xanh 1, chưa vào tầm 10. | nhóm seed `clip-public-pwf-review`. | Thẻ thứ năm "Chưa tính được hạn" rớt xuống hàng riêng. Các nút "i" chiếm một dòng dưới mỗi con số. |
| [`web/22-PRJ-03-dai-giai-doan.png`](web/22-PRJ-03-dai-giai-doan.png) | PRJ-03 | Dải sáu giai đoạn với số việc bắt buộc đã xong. | nhóm seed `clip-public-pwf-review`. | Không thấy lỗi lớn. |
| [`web/23-PRJ-03-giai-doan-buoc-cong-viec.png`](web/23-PRJ-03-giai-doan-buoc-cong-viec.png) | PRJ-03 | Giai đoạn → bước → công việc: thời hạn chuẩn, vai trò, thanh tiến độ việc và mục kiểm, màu hạn từng việc, lý do chọn loại quy trình khác đề xuất. | nhóm seed `clip-public-pwf-review`. | Trạng thái, nhãn màu, số ngày và "Mục kiểm 2/2" viết liền một dòng không ngăn cách. Vai trò là mã trần (PMB_PLANNER). Việc có hạn 13/11 hiện "Đến hạn hôm nay" trong khi hôm nay là 14/11 (thứ Bảy). |
| [`web/24-PRJ-03-cay-tien-trinh.png`](web/24-PRJ-03-cay-tien-trinh.png) | PRJ-03 | Cây tiến trình ở khung nhìn 1440×900. | nhóm seed `clip-public-pwf-review`. | VỠ BỐ CỤC NẶNG: mọi nút của cây chồng lên nhau trong một khung cao 164 px; chỉ thấy giai đoạn cuối và việc cuối, nhãn trạng thái bị cắt. Cây không dùng được. |
| [`web/25-PRJ-03-gantt-duong-gang-duong-co-so.png`](web/25-PRJ-03-gantt-duong-gang-duong-co-so.png) | PRJ-03 | Lịch ngày và Gantt: thanh hiện hành, nét đứt đường cơ sở, phần trễ gạch đỏ kèm "+80 ngày", đường găng. | nhóm seed `clip-public-pwf-review`. | Nhãn việc bị cắt đầu ("EAS_APPRAISAL", "_CAPITAL_PLAN", "MPL_CONTRACT"). Gantt không có trục thời gian. Lưới ngày phía trên liệt kê từng ngày của nhiều tháng rồi bị cắt ngang. Chỉ có mã việc, không có tên. |
| [`web/26-PRJ-03-cac-moc-theo-ngay.png`](web/26-PRJ-03-cac-moc-theo-ngay.png) | PRJ-03 | Các mốc theo ngày. | nhóm seed `clip-public-pwf-review`. | Dùng lại khuôn nhật ký: "00:00", "HT Hệ thống", "3 thay đổi", "158 ngày không có thay đổi", biểu tượng bút chì: sai ngữ cảnh với mốc kế hoạch. |
| [`web/27-PRJ-03-bang-cot-cong-viec-theo-giai-doan.png`](web/27-PRJ-03-bang-cot-cong-viec-theo-giai-doan.png) | PRJ-03 | Bảng cột công việc theo giai đoạn, lọc theo giai đoạn, màu, trạng thái, người phụ trách. | nhóm seed `clip-public-pwf-review`. | Sáu cột xếp 4 + 2, cột cao thấp lệch nhiều để lại khoảng trắng lớn. Thẻ nào cũng có nhãn "Đường găng". |
| [`web/28-PRJ-03-cong-giai-doan.png`](web/28-PRJ-03-cong-giai-doan.png) | PRJ-03 | Cổng giai đoạn của các lệnh dự án và việc còn thiếu. | nhóm seed `clip-public-pwf-review`. | Mọi cổng đều đỏ "Đóng: lệnh chưa chạy được", kể cả cổng của giai đoạn còn xa. |
| [`web/30-PWF-03-workflow-du-an-theo-mau-cua-tinh-toan-trang.png`](web/30-PWF-03-workflow-du-an-theo-mau-cua-tinh-toan-trang.png) | PWF-03 | Toàn trang workflow của DA-PWF-04 theo mẫu của tỉnh (3 giai đoạn, 5 bước). | nhóm seed `clip-public-pwf-review`. | Thanh bên trái chỉ cao 900 px trong ảnh toàn trang (do cách chụp). Cây tiến trình vỡ như ảnh 24. |
| [`web/31-PWF-03-cay-tien-trinh-dang-bang.png`](web/31-PWF-03-cay-tien-trinh-dang-bang.png) | PWF-03 | Khối "Cây tiến trình" của DA-PWF-04. | nhóm seed `clip-public-pwf-review`. | Cùng lỗi chồng nút như ảnh 24. |

## 5. PWF-04, PWF-16, PWF-06 · Chi tiết công việc, sổ phân công, dời lịch

Các việc của DA-PWF-04, DA-PWF-D04, DA-PWF-08 và đề nghị dời lịch của DA-PWF-01.

| Ảnh | Mã màn | Đang hiển thị | Dữ liệu từ đâu | Điểm chưa ổn nhìn thấy trong ảnh |
|---|---|---|---|---|
| [`web/32-PWF-04-viec-cho-duyet-hoan-thanh-nguoi-duyet-xem-bieu-mau-revision.png`](web/32-PWF-04-viec-cho-duyet-hoan-thanh-nguoi-duyet-xem-bieu-mau-revision.png) | PWF-04 | Việc chờ duyệt hoàn thành, nhìn bằng tài khoản lãnh đạo (Trần Thị Bích): nút "Duyệt hoàn thành / Trả lại", căn cứ pháp lý của việc và của bước, biểu mẫu và phiên bản (bản đang hiệu lực, bản đã dùng kèm mã băm), danh mục kiểm đã xong, bằng chứng, lịch sử. | nhóm seed `clip-public-pwf-review`. | Lịch sử lộ mã sự kiện tiếng Anh (CHECKLIST_DONE, EVIDENCE_ATTACHED, ASSIGNED) và luôn ghi người làm là "HT Hệ thống". Cột "Tài liệu" hiện mã UUID. Loại bằng chứng "DOCUMENT". Vai trò mã trần. "KPI của công việc: Bạn không có quyền xem". |
| [`web/33-PWF-04-viec-dang-lam-checklist-bieu-mau-ngoai-le-cho-quyet-dinh.png`](web/33-PWF-04-viec-dang-lam-checklist-bieu-mau-ngoai-le-cho-quyet-dinh.png) | PWF-04 | Việc đang làm chưa đủ điều kiện hoàn thành: mục kiểm chưa xong, thiếu chứng từ pháp lý (nút "Xin miễn"), biểu mẫu bản 2, đề nghị ngoại lệ "Trì hoãn do bên ngoài" đang chờ quyết định. | nhóm seed `clip-public-pwf-review`. | Như ảnh 32; thêm EXCEPTION_REQUESTED trong lịch sử. Việc này bắt đầu thực tế 06/11 nhưng kế hoạch hiện 27/11 đến 01/12 và "Chưa vào tầm" (xem mục khiếm khuyết về tính lại lịch). |
| [`web/34-PWF-04-viec-bi-tra-lai-chung-tu-phap-ly-can-cu-cua-viec.png`](web/34-PWF-04-viec-bi-tra-lai-chung-tu-phap-ly-can-cu-cua-viec.png) | PWF-04 | Việc bị trả lại (số lần bị trả lại 1), có chứng từ pháp lý APPRAISAL_REPORT và căn cứ pháp lý riêng của việc (Điều 22). | nhóm seed `clip-public-pwf-review`. | Như ảnh 32. |
| [`web/35-PWF-04-viec-da-xong-lich-su.png`](web/35-PWF-04-viec-da-xong-lich-su.png) | PWF-04 | Việc đã xong: lịch sử đủ các bước giao, bắt đầu, nộp bằng chứng, đánh dấu mục kiểm, hoàn thành. | nhóm seed `clip-public-pwf-review`. | Như ảnh 32. |
| [`web/36-PWF-04-viec-da-xong-bieu-mau-co-revision-moi-hon.png`](web/36-PWF-04-viec-da-xong-bieu-mau-co-revision-moi-hon.png) | PWF-04 | Việc đã xong dùng biểu mẫu bản 1, nay biểu mẫu đã có bản 2: cảnh báo "Kiểm tra xem tài liệu có cần lập lại theo bản mới". | nhóm seed `clip-public-pwf-review` (biểu mẫu PWF_QD_PHE_DUYET_SUA_CHUA có hai bản). | Cảnh báo rõ ràng. Các điểm chung như ảnh 32. |
| [`web/37-PWF-04-hop-thoai-hoan-thanh-viec-han-vang.png`](web/37-PWF-04-hop-thoai-hoan-thanh-viec-han-vang.png) | PWF-04 | Hộp thoại "Hoàn thành công việc" (chưa bấm xác nhận). | Việc RR_SURVEY của DA-PWF-08. | Không thấy lỗi bố cục. |
| [`web/38-PWF-16-so-phan-cong-cua-cong-viec.png`](web/38-PWF-16-so-phan-cong-cua-cong-viec.png) | PWF-16 | Sổ phân công của một việc và form thêm phân công. | nhóm seed `clip-public-pwf-review`. | Màn chỉ có một dòng; form thêm chiếm phần lớn màn. |
| [`web/39-PWF-06-xem-truoc-va-duyet-doi-lich-de-nghi-dang-cho.png`](web/39-PWF-06-xem-truoc-va-duyet-doi-lich-de-nghi-dang-cho.png) | PWF-06 | Đề nghị dời lịch đang chờ, nhìn bằng tài khoản lãnh đạo: lịch trước và sau của từng việc, độ lệch, khối quyết định. | nhóm seed `clip-public-pwf-review` (`POST …/workflow/reschedules`). | Cột "Công việc" quá hẹp, mã việc gãy giữa chừng ("PREP_POLICY_A/PPRAISAL"). Cột "Dịch" ghi "bắt đầu -87, kết thúc -87" khó hiểu. Nút chính "Duyệt và phát hành lịch mới" không có khung nút. Phải thêm `&proposal=` vào địa chỉ mới thấy đề nghị; mở từ menu thì không thấy. |

## 6. PWF-07, PWF-08, PWF-15 · Deadline ba màu

Toàn danh mục: 11 đỏ, 3 vàng, 8 xanh, 258 chưa vào tầm.

| Ảnh | Mã màn | Đang hiển thị | Dữ liệu từ đâu | Điểm chưa ổn nhìn thấy trong ảnh |
|---|---|---|---|---|
| [`web/40-PWF-07-bang-deadline-toan-danh-muc-danh-sach.png`](web/40-PWF-07-bang-deadline-toan-danh-muc-danh-sach.png) | PWF-07 | Bảng deadline toàn danh mục, dạng danh sách. | nhóm seed `clip-public-pwf-review` và `clip-public-phone-work`. | Khối lọc vỡ: nút "Bỏ lọc" bị kéo cao 215 px, các ô lọc dồn về nửa trái. Thẻ thứ năm rớt hàng. Cột "Giai đoạn" là mã (PREPARATION, APPROVAL). Bảng bị cắt ngang ở đáy khung. "Đến hạn hôm nay" cho hạn 13/11 khi hôm nay 14/11. |
| [`web/41-PWF-07-loc-mau-do.png`](web/41-PWF-07-loc-mau-do.png) | PWF-07 | Lọc màu đỏ. | Như trên. | Như ảnh 40. |
| [`web/42-PWF-07-loc-mau-vang.png`](web/42-PWF-07-loc-mau-vang.png) | PWF-07 | Lọc màu vàng (3 việc). | Như trên. | Như ảnh 40. |
| [`web/43-PWF-07-loc-mau-xanh.png`](web/43-PWF-07-loc-mau-xanh.png) | PWF-07 | Lọc màu xanh. | Như trên. | Như ảnh 40. |
| [`web/44-PWF-07-lich-thang.png`](web/44-PWF-07-lich-thang.png) | PWF-07 | Lịch tháng 11/2026: số việc đỏ, vàng, xanh theo ngày. | Như trên. | Hàng tên thứ (T2…CN) gần như vô hình (chữ trắng trên nền nhạt). Ô có việc nền trắng số ở giữa, ô không có việc nền xám số ở góc: hai kiểu lẫn lộn. Không có ký hiệu riêng cho mốc. |
| [`web/45-PWF-07-moc-30-ngay-toi.png`](web/45-PWF-07-moc-30-ngay-toi.png) | PWF-07 | Mốc 30 ngày tới. | Như trên. | Cột dự án hẹp, mã dự án gãy dòng. |
| [`web/46-PWF-07-tai-cong-viec.png`](web/46-PWF-07-tai-cong-viec.png) | PWF-07 | Tải công việc theo người và tuần. | Như trên. | Cột cuối bị cắt ("Tuần t…"). Con số không có đơn vị (75 là ngày công hay số việc). |
| [`web/47-PWF-08-chinh-sach-ba-mau-cua-don-vi.png`](web/47-PWF-08-chinh-sach-ba-mau-cua-don-vi.png) | PWF-08 | Chính sách ba màu của đơn vị: ngưỡng 5/2/0, xem trước, mốc nhắc, phiên bản 1 đang hiệu lực trong lịch sử. | nhóm seed `clip-public-pwf-review` (quy tắc DEADLINE_BAND_POLICY do An soạn, Bích duyệt). | Câu ví dụ lặp hai lần liền nhau. Ba ô ngưỡng lệch hàng do chú thích dài ngắn khác nhau. |
| [`web/48-PWF-15-nhac-han-cua-toi-nguong-ca-nhan-xem-truoc-mau.png`](web/48-PWF-15-nhac-han-cua-toi-nguong-ca-nhan-xem-truoc-mau.png) | PWF-15 | Nhắc hạn của tôi: ngưỡng cá nhân 8/4/1, mốc nhắc 5, 3, 1, 0, bảng xem trước màu chính thức và màu cá nhân, danh sách việc sắp tới. | nhóm seed `clip-public-pwf-review` (`PUT /me/deadline-preference`). | Trong danh sách việc, dòng chữ "theo cài đặt của bạn" nằm giữa hai nhãn màu nên không rõ nhãn nào là chính thức. Cột đầu bảng xem trước tô nền đậm. |

## 7. PWF-09 đến PWF-14 · KPI và bảng điểm

Kỳ quý IV/2026 của toàn tỉnh, đã chốt: Phạm Quốc Dũng 71,22 → 74,22 (có điều chỉnh +3 đã duyệt và một phản hồi đã xử lý), Nguyễn Văn An 47,65.

| Ảnh | Mã màn | Đang hiển thị | Dữ liệu từ đâu | Điểm chưa ổn nhìn thấy trong ảnh |
|---|---|---|---|---|
| [`web/50-PWF-09-bo-kpi-workflow.png`](web/50-PWF-09-bo-kpi-workflow.png) | PWF-09 | Bộ KPI của workflow: từng KPI với phép tính, đơn vị, đường quy đổi điểm. | Mặc định của hệ thống (chưa có phiên bản của tỉnh). | Trang dài 8200 px, các KPI mở hết; mã KPI tiếng Anh. |
| [`web/51-PWF-10-chinh-sach-cham-diem.png`](web/51-PWF-10-chinh-sach-cham-diem.png) | PWF-10 | Chính sách chấm điểm: hệ số vai, trọng số ưu tiên, ngưỡng mẫu nhỏ, bậc xếp loại, hiệu chỉnh, cửa sổ phản hồi. | Mặc định của hệ thống. | Bậc xếp loại là mã EXCELLENT/GOOD/FAIR/WEAK. |
| [`web/52-PWF-11-bang-diem-cua-toi.png`](web/52-PWF-11-bang-diem-cua-toi.png) | PWF-11 | Bảng điểm của tôi (An): 47,65, 11 việc được chấm, điểm đến từ việc nào, ô gửi phản hồi, so sánh các kỳ. | nhóm seed `clip-public-pwf-review` (`POST /staff-score-periods`, chốt kỳ). | Xếp loại hiện "WEAK" tiếng Anh và mang dấu tích xanh. Bảng việc bị cắt ngang ở đáy khung. Việc trùng tên không kèm mã dự án (hai dòng PREP_NEEDS). Nút "Gửi phản hồi" không có khung nút. |
| [`web/53-PWF-11-bang-diem-cua-toi-can-bo-co-dieu-chinh-va-phan-hoi.png`](web/53-PWF-11-bang-diem-cua-toi-can-bo-co-dieu-chinh-va-phan-hoi.png) | PWF-11 | Bảng điểm của tôi (Dũng): 71,22 → 74,22, điều chỉnh đã duyệt, phản hồi đã xử lý. | nhóm seed `clip-public-pwf-review`. | Như ảnh 52 ("FAIR"). |
| [`web/54-PWF-12-bang-diem-don-vi.png`](web/54-PWF-12-bang-diem-don-vi.png) | PWF-12 | Bảng điểm đơn vị: 11 người, 2 người có điểm, nhãn "Có điều chỉnh". | nhóm seed `clip-public-pwf-review`. | Ô chọn kỳ ghi "đơn vị 00000000". "Đặng Minh Tuấn" (tài khoản khách nhà thầu) xuất hiện hai lần trong bảng điểm cán bộ. Xếp loại tiếng Anh. |
| [`web/55-PWF-13-chi-tiet-diem.png`](web/55-PWF-13-chi-tiet-diem.png) | PWF-13 | Chi tiết điểm của Dũng: truy tới từng việc, điều chỉnh +3 đã duyệt kèm lý do và bằng chứng, phản hồi và kết luận. | nhóm seed `clip-public-pwf-review`. | "Đơn vị tại thời điểm của kỳ" hiện nguyên mã UUID. Nút "Đề nghị điều chỉnh" không có khung nút. Việc không kèm mã dự án. |
| [`web/57-PWF-14-ky-cham-diem-da-chot.png`](web/57-PWF-14-ky-cham-diem-da-chot.png) | PWF-14 | Kỳ chấm điểm đã chốt: chính sách, mã băm ảnh chụp, hạn phản hồi, số người; khối tín hiệu thao túng (không có tín hiệu). | nhóm seed `clip-public-pwf-review`. | Form tính nháp bắt gõ "Mã đơn vị" và ngày dạng chữ "Năm-tháng-ngày" (không có ô chọn ngày, không có danh sách đơn vị). Nút "Tính nháp", "Chính thức hóa" không có khung nút. |

## 8. Điện thoại (Android, AVD "guide", bản công)

APK debug bản công, đăng nhập bằng Nguyễn Văn An qua nhà cung cấp danh tính thử của stack; chụp bằng `adb exec-out screencap -p`. Mã màn thật trong mã nguồn: MOB-78 workflow dự án, MOB-79 chi tiết việc, MOB-80 việc của tôi theo hạn, MOB-81 điểm KPI của tôi, MOB-82 cài đặt nhắc hạn.

| Ảnh | Mã màn | Đang hiển thị | Dữ liệu từ đâu | Điểm chưa ổn nhìn thấy trong ảnh |
|---|---|---|---|---|
| [`mobile/01-MOB-07-trang-chu.png`](mobile/01-MOB-07-trang-chu.png) | MOB-07 | Trang chủ. | Seed công. | Trang chủ không có khối việc theo hạn của workflow. Nhãn tab "Thông báo" gãy hai dòng. |
| [`mobile/02-MOB-07-trang-chu-cuon-xuong.png`](mobile/02-MOB-07-trang-chu-cuon-xuong.png) | MOB-07 | Trang chủ, cuộn xuống. | Seed công. | Không liên quan PWF. |
| [`mobile/03-MOB-ca-nhan.png`](mobile/03-MOB-ca-nhan.png) | Cá nhân | Tab Cá nhân: khối "Nhắc hạn việc" xem trước ba mức theo cài đặt 8/4/1. | nhóm seed `clip-public-pwf-review`. | Không thấy lỗi. |
| [`mobile/04-MOB-ca-nhan-nhom-cong-cu.png`](mobile/04-MOB-ca-nhan-nhom-cong-cu.png) | Cá nhân | Nhóm "Công cụ": Việc của tôi theo hạn, Điểm KPI của tôi. |  | Hai mục này nằm sâu dưới màn Cá nhân, phải cuộn mới thấy. |
| [`mobile/05-MOB-80-viec-cua-toi-theo-han-mau-cua-ban.png`](mobile/05-MOB-80-viec-cua-toi-theo-han-mau-cua-ban.png) | MOB-80 | Việc của tôi, màu của bạn: nhóm "Trễ hạn" 4 việc. | nhóm seed `clip-public-pwf-review`. | Cột phải quá chật: "Theo cài đặt của bạn / Chính thức: Còn 1 ngày làm việc" gãy 4 đến 5 dòng, tên việc và mã bị cắt. Việc "Còn 1 ngày làm việc" nằm trong nhóm tên "Trễ hạn". "Hôm nay, hạn 13/11" trong khi hôm nay 14/11. Dòng cuối bị thanh tab che. |
| [`mobile/06-MOB-80-viec-cua-toi-cuon-xuong-vang-xanh.png`](mobile/06-MOB-80-viec-cua-toi-cuon-xuong-vang-xanh.png) | MOB-80 | Cuộn xuống: nhóm "Sắp đến hạn" (vàng). | nhóm seed `clip-public-pwf-review`. | Như ảnh 05. |
| [`mobile/07-MOB-80-viec-cua-toi-cuon-tiep.png`](mobile/07-MOB-80-viec-cua-toi-cuon-tiep.png) | MOB-80 | Cuộn tiếp: nhóm "Còn thời gian" (xanh). | nhóm seed `clip-public-pwf-review`. | Như ảnh 05. |
| [`mobile/08-MOB-80-viec-cua-toi-mau-chinh-thuc.png`](mobile/08-MOB-80-viec-cua-toi-mau-chinh-thuc.png) | MOB-80 | Chuyển sang "Màu chính thức". | nhóm seed `clip-public-pwf-review`. | Gọn hơn; việc chờ duyệt không hiện ngày hạn. |
| [`mobile/09-MOB-79-chi-tiet-viec.png`](mobile/09-MOB-79-chi-tiet-viec.png) | MOB-79 | Chi tiết việc RR_SURVEY (vàng, còn 1 ngày): trạng thái, người phụ trách, các ngày. | nhóm seed `clip-public-pwf-review`. | "Vai thực hiện: SITE_ENGINEER" mã trần. |
| [`mobile/10-MOB-79-chi-tiet-viec-checklist.png`](mobile/10-MOB-79-chi-tiet-viec-checklist.png) | MOB-79 | Cuộn: hạn, đường găng, bước. | nhóm seed `clip-public-pwf-review`. | Như ảnh 09. |
| [`mobile/11-MOB-79-chi-tiet-viec-can-cu-phap-ly.png`](mobile/11-MOB-79-chi-tiet-viec-can-cu-phap-ly.png) | MOB-79 | Danh mục kiểm (một mục xong, một chưa) và căn cứ pháp lý của bước. | nhóm seed `clip-public-pwf-review`. | Tên văn bản bị cắt một dòng. |
| [`mobile/12-MOB-79-chi-tiet-viec-bang-chung.png`](mobile/12-MOB-79-chi-tiet-viec-bang-chung.png) | MOB-79 | Chứng từ đã nộp, nộp chứng từ, đính kèm tệp, lịch sử. | nhóm seed `clip-public-pwf-review`. | Chứng từ hiện "DOCUMENT / DOCUMENT · …" thay cho tên. |
| [`mobile/13-MOB-79-viec-co-bieu-mau.png`](mobile/13-MOB-79-viec-co-bieu-mau.png) | MOB-79 | Việc có biểu mẫu: "Phiên bản biểu mẫu: Dùng bản đã duyệt mới nhất · Đang hiệu lực: bản 1". | nhóm seed `clip-public-pwf-review`. | Dòng phiên bản bị cắt bằng dấu ba chấm, không đọc được "Đã dùng: bản …". Mã biểu mẫu trần. |
| [`mobile/14-MOB-82-cai-dat-nhac-han.png`](mobile/14-MOB-82-cai-dat-nhac-han.png) | MOB-82 | Cài đặt nhắc hạn: ngưỡng 8/4/1, mốc nhắc. | nhóm seed `clip-public-pwf-review`. | Không thấy lỗi. |
| [`mobile/15-MOB-82-cai-dat-nhac-han-xem-truoc-mau.png`](mobile/15-MOB-82-cai-dat-nhac-han-xem-truoc-mau.png) | MOB-82 | Cuộn: xem trước ba mức, nút "Lưu cài đặt", "Dùng mức của đơn vị". | nhóm seed `clip-public-pwf-review`. | Không thấy lỗi. |
| [`mobile/16-MOB-81-diem-kpi-cua-toi.png`](mobile/16-MOB-81-diem-kpi-cua-toi.png) | MOB-81 | Điểm KPI của tôi: 47,65, WEAK, 11 việc, điểm từng việc. | nhóm seed `clip-public-pwf-review`. | "WEAK" tiếng Anh. "Chính sách DEFAULT, phiên bản 0". Việc không kèm dự án; "tỷ lệ 1" khó hiểu. |
| [`mobile/17-MOB-81-diem-kpi-cua-toi-cuon-xuong.png`](mobile/17-MOB-81-diem-kpi-cua-toi-cuon-xuong.png) | MOB-81 | Cuộn: điểm theo từng việc. | nhóm seed `clip-public-pwf-review`. | Như ảnh 16. |
| [`mobile/18-MOB-78-workflow-du-an-tab-tien-do.png`](mobile/18-MOB-78-workflow-du-an-tab-tien-do.png) | MOB-78 | Chi tiết dự án DA-PWF-02, tab "Tiến độ": mốc cần chú ý. | nhóm seed `clip-public-pwf-review`. | Mốc ghi "Trễ 81 ngày" cạnh "Kế hoạch 13/11/2026" (hai con số mâu thuẫn khi đọc). Đầu màn vẫn ghi "Giai đoạn 1/6 · Ý tưởng, Mốc đã xong 0/6". |
| [`mobile/19-MOB-78-workflow-giai-doan-buoc.png`](mobile/19-MOB-78-workflow-giai-doan-buoc.png) | MOB-78 | Cuộn: mốc sắp tới, ghi chú mẫu mặc định. | nhóm seed `clip-public-pwf-review`. | Nhãn "Theo kế hoạch" gãy hai dòng. |
| [`mobile/20-MOB-78-workflow-viec-theo-mau-han.png`](mobile/20-MOB-78-workflow-viec-theo-mau-han.png) | MOB-78 | Đếm quá hạn 6, sắp đến hạn 0, còn thời gian 1; bộ lọc; giai đoạn và bước. | nhóm seed `clip-public-pwf-review`. | Nhãn dưới ba con số gãy dòng; hàng nút lọc tràn phải. |
| [`mobile/21-MOB-78-workflow-cuon-tiep.png`](mobile/21-MOB-78-workflow-cuon-tiep.png) | MOB-78 | Các giai đoạn thu gọn. | nhóm seed `clip-public-pwf-review`. | Không thấy lỗi. |
| [`mobile/22-MOB-78-workflow-mo-giai-doan-co-viec-do.png`](mobile/22-MOB-78-workflow-mo-giai-doan-co-viec-do.png) | MOB-78 | Mở giai đoạn có việc đỏ: bước, căn cứ pháp lý, việc theo màu hạn. | nhóm seed `clip-public-pwf-review`. | Tên bước bị cắt để nhường chỗ cho "2 căn cứ pháp lý". |

## Màn không chụp được hoặc không có dữ liệu

- **PWF-05, kết quả chạy thử tiếp nhận và bước "Áp dụng"**: không có, vì lệnh chạy thử trả lỗi 500 (ảnh `web/08`). Gọi thẳng API không chạy thử thì bị từ chối 422 `PWF_ADOPT_INVALID` (đòi xử lý từng việc đã qua), tức phải qua bước chạy thử đang hỏng.
- **PWF-05, xem trước lịch**: chỉ có ảnh báo lỗi (`web/09`, `web/10`).
- **PWF-13, hộp giải thích của nút "i"**: không chụp được: nút "i" có trên màn (cạnh "Chính sách DEFAULT, phiên bản 0", ảnh `web/55`) nhưng kịch bản chụp không bấm trúng, và stack đã tắt trước khi tôi phát hiện.
- **PWF-04, tài liệu sinh từ biểu mẫu qua kho văn bản**: bằng chứng của biểu mẫu trong ảnh là tham chiếu ngoài kèm mã biểu mẫu; hệ thống tự ghi bản đang hiệu lực. Chưa có tài liệu do module DOC sinh từ biểu mẫu gắn vào việc (nhóm seed chưa gọi lệnh soạn văn bản từ biểu mẫu).
- **PWF-09, PWF-10**: chỉ có giá trị mặc định của hệ thống, chưa có phiên bản của tỉnh (nhóm seed không tạo).
- **PWF-14, tín hiệu thao túng**: khối trống ("Không có tín hiệu nào"), dữ liệu không sinh ra tín hiệu.
- **MOB-78 như một màn riêng**: chỉ mở được từ cảnh báo; ảnh chụp là tab "Tiến độ" của chi tiết dự án, dùng chung phần thân với MOB-78.
- **Trang chủ điện thoại**: không có khối việc theo hạn của workflow để chụp.
- **Bảng điểm**: 9 trong 11 người "Chưa có điểm" vì seed chỉ giao việc cho hai người.

## Khiếm khuyết nhìn thấy, xếp theo mức nghiêm trọng

### A. Hỏng chức năng

1. **PWF-05 chạy thử tiếp nhận trả lỗi 500** (`web/08`): `command adoptProjectWorkflow wrote no audit entry`. Tiếp nhận workflow cho dự án đang chạy không làm được trên giao diện.
2. **PWF-05 "Xem trước lịch của mẫu" luôn bị từ chối 400** `params.tasks.approver_role` (`web/09`, `web/10`), với cả mẫu mặc định và mẫu của tỉnh.
3. **Cây tiến trình vỡ bố cục** (`web/24`, `web/31`): mọi nút chồng lên nhau trong khung 164 px, chỉ còn thấy giai đoạn cuối và việc cuối.
4. **Mẫu workflow không gọi tên được biểu mẫu của kho văn bản**: mã biểu mẫu trong mẫu chỉ nhận chữ hoa, số và gạch dưới, còn toàn bộ biểu mẫu của kho dùng gạch nối (DOC-QD-PHE-DUYET-DU-AN). Các việc của mẫu mặc định mà tôi đã đọc đều không có biểu mẫu nào; nhóm seed phải tạo biểu mẫu riêng mã PWF_… mới có dữ liệu.
5. **Hạn bị đẩy lùi sau mỗi lần hoàn thành việc**: khi một việc được hoàn thành, lịch tính lại từ hôm nay và hạn của các việc đang mở, kể cả việc đang trễ, bị dời về tương lai; việc đang đỏ thành "Chưa vào tầm" (ví dụ `web/33`: bắt đầu thực tế 06/11, kế hoạch hiện 27/11 đến 01/12). Màu ba mức so với hạn đã tính lại chứ không so với đường cơ sở. Cần chủ quy trình xác nhận đây có phải ý định không; nếu không, bảng deadline sẽ che việc trễ.
6. **PWF-06 không tự mở đề nghị đang chờ**: phải có `&proposal=<mã>` trên địa chỉ.

### B. Sai hoặc gây hiểu lầm về nội dung

7. **"Đến hạn hôm nay" / "Hôm nay" cho hạn 13/11 khi hôm nay là 14/11** (web và điện thoại): đếm theo ngày làm việc nên ngày thứ Bảy coi như còn 0 ngày.
8. **So sánh phiên bản (ADM-22) không đọc được** (`web/12`): JSON thô, hai cột trống.
9. **Tên người và đơn vị hiện thành mã**: "Người duyệt: 00000000" (`web/18`), "đơn vị 00000000" (`web/54`), UUID đơn vị (`web/55`), UUID tài liệu trong bảng bằng chứng (`web/32`).
10. **Lịch sử việc lộ mã sự kiện tiếng Anh và ghi "HT Hệ thống" cho mọi thao tác của người** (`web/32` đến `web/36`).
11. **Bảng điểm đơn vị có tài khoản khách nhà thầu và trùng tên** (`web/54`: Đặng Minh Tuấn hai lần).
12. **Xếp loại WEAK/FAIR tiếng Anh, WEAK mang dấu tích xanh** (web và điện thoại).
13. **Điện thoại: việc "Còn 1 ngày làm việc" nằm trong nhóm "Trễ hạn"; mốc "Trễ 81 ngày" cạnh "Kế hoạch 13/11/2026"** (`mobile/05`, `mobile/18`).
14. **Mốc theo ngày dùng khuôn nhật ký** (`web/26`): "00:00", "HT Hệ thống", "158 ngày không có thay đổi".
15. **Cổng giai đoạn đỏ hết** (`web/28`), kể cả giai đoạn chưa tới.

### C. Bố cục và chữ tràn

16. **PWF-07 khối lọc vỡ**: nút "Bỏ lọc" cao 215 px (`web/40` đến `web/46`).
17. **Bảng bị cắt**: thư viện mẫu mất cột "Thao tác" (`web/11`); tải công việc mất cột cuối (`web/46`); bảng deadline và bảng điểm bị cắt ngang dòng cuối (`web/40`, `web/52`).
18. **Gantt cắt đầu nhãn việc, không có trục thời gian; lưới ngày dài và bị cắt** (`web/25`).
19. **Lịch tháng: hàng tên thứ gần như vô hình, hai kiểu ô lẫn lộn** (`web/44`).
20. **Nút chính không có khung nút** ở PWF-05, PWF-06, PWF-11, PWF-13, PWF-14 ("Khởi tạo workflow", "Chạy thử tiếp nhận", "Duyệt và phát hành lịch mới", "Gửi phản hồi", "Đề nghị điều chỉnh", "Tính nháp", "Chính thức hóa").
21. **PWF-02 khối chọn KPI liệt kê khoảng 65 mã của mọi module** (`web/15`).
22. **PRJ-02: thanh nút dính đáy che bảng xem trước; cột đầu bảng tô đậm; ô chọn cắt chữ; "Mở quy trình" chỉ là chữ thường** (`web/01`, `web/02`, `web/05`).
23. **Điện thoại MOB-80: cột phải gãy 4 đến 5 dòng, tên việc và mã bị cắt, dòng cuối bị thanh tab che** (`mobile/05` đến `mobile/07`).
24. **Thẻ đếm thứ năm rớt hàng** (`web/21`, `web/40`); **bảng cột cao thấp lệch** (`web/27`); **PWF-06 cột việc quá hẹp** (`web/39`).

### D. Nhãn kỹ thuật, tiếng Anh

25. Mã vai trò (PMB_PLANNER, SITE_ENGINEER, INVESTOR_REP), mã giai đoạn (PREPARATION, APPROVAL), mã văn bản (LAW_58_2024_QH15), loại bằng chứng (DOCUMENT), mã chứng từ (APPRAISAL_REPORT), tên trường (duration_working_days) hiện nguyên trên hầu hết các màn web và điện thoại.
26. Dữ kiện chọn nhánh ở PWF-05 và PWF-02 là ô gõ mã tự do (STATE_BUDGET, NEW_BUILD); PWF-14 bắt gõ mã đơn vị và ngày dạng chữ.
27. "phiên bản 0" cho mẫu, quy tắc và chính sách mặc định.

Không thấy khóa i18n nào lộ nguyên dạng (kiểu `pwf.xxx.yyy`) trong các ảnh đã xem.
