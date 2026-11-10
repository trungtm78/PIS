# Kịch bản sản xuất: Hệ thống quản lý đầu tư công

Tệp này được sinh từ dữ liệu kịch bản bằng `node scripts/clip-scripts-check.mjs book`. Không sửa tay: sửa tệp dữ liệu rồi sinh lại. Đoạn phim chỉ có tiếng Việt: lời đọc, phụ đề và chữ trên hình. Con số không được ghi ở đây, chúng được đọc từ dữ liệu thật lúc quay.

- Mã đoạn phim: `public-investment`
- Bản: public
- Video chính: 11:14 (46 cảnh)

Độ dài là ước tính theo số âm tiết; khi có âm thanh thật, độ dài đo được thay thế và cổng cuối là `scripts/clips/verify.mjs`.

## Các chương cắt riêng

| Chương | Số cảnh | Độ dài ước tính |
|---|---|---|
| Video chính (`main`) | 46 | 11:14 |
| Giới thiệu hệ thống (`intro`) | 5 | 1:20 |
| Tổng quan điều hành (`leader-home`) | 7 | 1:36 |
| Giải ngân và kế hoạch vốn (`disbursement`) | 7 | 1:35 |
| Quản lý hợp đồng (`contracts`) | 5 | 1:10 |
| Báo cáo phân tích và BI (`analytics`) | 9 | 2:18 |
| Cảnh báo (`alerts`) | 8 | 1:59 |
| Quản lý nhà thầu và nhà cung cấp (`contractors`) | 9 | 2:26 |
| Quản lý kết nối muasamcong (`egp`) | 11 | 2:54 |
| Ban chỉ đạo cấp tỉnh (`province-committee`) | 10 | 2:40 |
| Cây tiến độ (`process-tree`) | 9 | 2:09 |
| Ứng dụng điện thoại và PWA (`phone`) | 10 | 2:38 |
| Quản lý nhà thầu nâng cao (`contractors-plus`) | 9 | 2:44 |
| Cổng nhà thầu (`contractor-portal`) | 6 | 1:28 |
| Claim và cảnh báo sớm hợp đồng (`claims-warnings`) | 5 | 1:30 |
| Cảnh báo nâng cao và leo thang (`alerts-plus`) | 5 | 1:20 |
| Ủy quyền, làm thay và vắng mặt (`delegation`) | 4 | 1:02 |
| Thanh tra, kiểm toán và tín hiệu rủi ro (`audit-controls`) | 6 | 1:22 |
| Dự báo, rủi ro và hiệu quả đầu tư (`risk-forecast`) | 10 | 2:43 |
| Vòng đời dự án đầu tư (`project-life`) | 4 | 0:58 |
| Kế hoạch và kiểm soát vốn (`capital-control`) | 5 | 1:13 |
| Thanh toán và Kho bạc (`payments`) | 6 | 1:31 |
| Báo cáo biểu mẫu và chốt kỳ (`reports-close`) | 8 | 2:03 |
| Báo cáo giám sát và nộp lên hệ thống quốc gia (`monitoring`) | 4 | 0:58 |
| Lựa chọn nhà thầu và phân tích hồ sơ dự thầu (`procurement-desk`) | 5 | 1:10 |
| Thực hiện hợp đồng và nghiệm thu (`contract-delivery`) | 4 | 0:57 |
| Hiện trường, chất lượng và giải phóng mặt bằng (`field-ops`) | 11 | 2:36 |
| Hồ sơ và AI nâng cao (`docs-ai-plus`) | 8 | 2:07 |
| Văn thư và ký số (`correspondence`) | 5 | 1:15 |
| Tích hợp: Hub, API mở và dữ liệu (`integration`) | 8 | 2:10 |
| Cổng công khai và giám sát cộng đồng (`portal-public`) | 3 | 0:52 |
| Nền tảng, dữ liệu chủ và quản trị (`platform`) | 11 | 2:55 |
| Điện thoại và PWA nâng cao (`phone-plus`) | 14 | 3:29 |
| Các chức năng khác của hệ thống (`features-tour`) | 1 | 0:29 |
| Tin cậy và kết thúc (`close`) | 2 | 0:29 |

## Dữ liệu và độ sẵn sàng

Bộ dữ liệu: `public` (docs/clip-data.md)

| Nhóm dữ liệu | Bằng chứng |
|---|---|
| `base` | RUN_VERIFIED |
| `capital` | RUN_VERIFIED |
| `clip-public-documents` | RUN_VERIFIED |
| `clip-public-procurement` | RUN_VERIFIED |
| `clip-public-contracts` | RUN_VERIFIED |
| `clip-public-payments` | RUN_VERIFIED |
| `clip-public-workflow` | RUN_VERIFIED |
| `clip-public-alerts` | RUN_VERIFIED |
| `clip-public-egp` | RUN_VERIFIED |
| `clip-public-disbursement` | RUN_VERIFIED |
| `clip-public-feed` | RUN_VERIFIED |
| `clip-public-bi` | RUN_VERIFIED |
| `clip-public-directives` | RUN_VERIFIED |
| `clip-public-committee` | RUN_VERIFIED |
| `clip-public-extras` | RUN_VERIFIED |

**Nhóm dữ liệu cần viết thêm (chưa có trong bộ dữ liệu)**

| Nhóm dữ liệu | Nhóm phải tạo |
|---|---|
| `clip-public-vendor-controls` | Kỳ tài chính đã xác minh cho vài nhà thầu, kể cả liên danh. Khai quan hệ cá nhân để có một phát hiện độc lập mạnh chưa quyết định và một phát hiện đã người khác quyết định. Sổ bảo đảm dự thầu: thư đã nhận, đã xác nhận bởi người thứ hai, một đề xuất tịch thu. Chạy hạng rủi ro nhà thầu, đề xuất xếp hạng thực hiện hợp đồng có điểm AI, chứng chỉ sắp hết hạn, sự kiện uy tín và một hồ sơ cấm. |
| `clip-public-vendor-investigation` | Một số nhà thầu dùng chung mã số thuế đầu, địa chỉ hoặc điện thoại; dấu vết nộp hồ sơ của từng đề xuất. Đầu mối điều tra ở trạng thái mới và đang rà soát. Danh sách bên bị cấm nạp qua đường nhập tệp, một lần sàng lọc và một kết quả tạm giữ. |
| `clip-public-contractor-portal` | Tài khoản thành viên khách tên contractorUser gắn với một nhà thầu (thêm vào docs-people). Thư mời, yêu cầu mở và đã trả lời, chứng chỉ tải lên chờ xác minh, đánh giá có kế hoạch khắc phục, thống kê kiến nghị. |
| `clip-public-claims` | Điều khoản claim đã duyệt cho vài hợp đồng và một hợp đồng chưa có điều khoản. Claim của cả hai bên ở nhiều trạng thái, có dòng thời gian. Cảnh báo sớm có đánh giá tác động, biện pháp, một cuộc họp rà soát, một cảnh báo chưa có người phụ trách; đồng hồ quyết toán hợp đồng. |
| `clip-public-alert-governance` | Cảnh báo bị leo thang qua chính sách, người vắng mặt có người thay đã được cho phép. Thiết lập nhận cảnh báo cá nhân, thang kênh có biên nhận, phản hồi cảnh báo sai, cảnh báo đã đóng rồi mở lại, một nhóm cảnh báo dồn dập, việc bị hoãn. |
| `clip-public-audit-controls` | Cuộc thanh tra có phát hiện, kiến nghị phân công, thu hồi tài chính đối chiếu thanh toán, bằng chứng khắc phục. Chạy quét red flag và có sổ chỉ báo; một tố giác ẩn danh và vài dòng sổ quà tặng. |
| `clip-public-fund-forecast` | Lô số liệu vốn theo kỳ: kế hoạch phân kỳ, số ước, số thực, điều chỉnh muộn, do người khác duyệt. Dự báo tới mốc chỉ đạo, độ chính xác dự báo vài tháng, nhật ký quyết định, một dự án dừng có kế hoạch khởi động lại, ghi chú và khiếu nại xếp hạng. |
| `clip-public-risk-lookahead` | Chạy chấm lại rủi ro dự án để có tín hiệu và lịch sử điểm. Kế hoạch nhìn trước đã công bố có ràng buộc, bài học kinh nghiệm, bộ chỉ tiêu hiệu quả đã chốt kèm số thực. |
| `clip-public-docs-ai` | Tài liệu dự án có nhiều phiên bản, luồng duyệt có bước song song, phiếu chuyển giao có hạn. Lượt hỏi trợ lý AI có trích dẫn và quyết định của người, danh mục kiểm đã chạy, một ngoại lệ nhà cung cấp ngoài đã duyệt. |
| `clip-public-correspondence` | Văn bản đi ở các bước soạn, ký, cấp số; văn bản đến đã phân công; quy tắc bảo quản; một văn bản bị thu hồi hoặc đính chính. |
| `clip-public-integration` | Bộ kết nối đã chạy, có một sự cố đã mở; tài khoản máy và tài khoản BI; mục đối chiếu mã dự án; hợp đồng dữ liệu, đường ống và sản phẩm dữ liệu. |
| `clip-public-field` | Vướng mắc đủ loại có chính sách thời hạn và tổ công tác; nhật ký thi công có ngày thiếu; biên bản chất lượng, thí nghiệm, điểm không phù hợp; hai ảnh giống nhau ở hai dự án. Thửa đất, hộ, kiểm đếm, phương án bồi thường, giấy phép có quy tắc cổng; bàn giao tài sản và yêu cầu bảo hành. |
| `clip-public-lifecycle` | Đề xuất chủ trương và thẩm định có quyết định; cấu trúc công việc, điều chỉnh, phân công lãnh đạo, yêu cầu giải trình, chuyển đơn vị. |
| `clip-public-capital-control` | Dự toán được giao, hạn mức khả dụng, khoản giữ vốn trước cam kết, sổ cái tra theo ngày, đề xuất điều chuyển theo hiệu suất. |
| `clip-public-payments-extra` | Hồ sơ thanh toán có sai lệch, bút toán đảo, đồng hồ Kho bạc có hồ sơ trả lại với lý do chuẩn, một ngoại lệ vượt trần, quyết toán niên độ. |
| `clip-public-reports-close` | Một kỳ đã chốt có chữ ký số, một lần mở lại có lý do; tệp Excel nhập qua bảng ánh xạ; báo cáo giám sát đã phát hành, đã nộp và một lần đính chính; biểu mẫu Bộ Tài chính đã giao. |
| `clip-public-bid-analysis` | Gói thầu có hồ sơ dự thầu nhiều tệp đã qua OCR, một lượt phân tích AI có dẫn chứng, biên bản đánh giá. |
| `clip-public-contract-site` | Hợp đồng có yêu cầu thay đổi và phụ lục, khối lượng, kiểm tra chất lượng và nghiệm thu đã ghi, một yêu cầu bồi hoàn chậm tiến độ. |
| `clip-public-portal` | Hồ sơ giám sát cộng đồng có phản ánh và phản hồi; bản ghi công khai đã công bố qua danh sách trường cho phép. |
| `clip-public-platform` | Giao diện thương hiệu mới của đơn vị, mã trùng chờ hợp nhất, sự cố chất lượng dữ liệu, mẫu thông báo và một yêu cầu gửi diện rộng, lịch sử sao lưu. |
| `clip-public-phone-extra` | Tài khoản cán bộ và lãnh đạo có dữ liệu cho các màn điện thoại còn lại; phim quay trên máy ảo theo tên cảnh trong thư mục phone. |

| Chương | Chương cần nhóm nào | Khoảng trống |
|---|---|---|
| `intro` | - | - |
| `leader-home` | `capital`, `clip-public-disbursement` | - |
| `disbursement` | `capital`, `clip-public-disbursement` | - |
| `contracts` | `clip-public-procurement`, `clip-public-contracts` | - |
| `analytics` | `capital`, `clip-public-procurement`, `clip-public-contracts` | - |
| `alerts` | `clip-public-alerts`, `clip-public-disbursement` | - |
| `contractors` | `clip-public-procurement`, `clip-public-contracts` | - |
| `egp` | `clip-public-egp`, `clip-public-workflow` | - |
| `province-committee` | `clip-public-committee`, `clip-public-disbursement`, `clip-public-feed`, `clip-public-directives` | - |
| `process-tree` | `clip-public-workflow`, `clip-public-procurement` | - |
| `phone` | `clip-public-procurement`, `clip-public-alerts`, `clip-public-contracts` | - |
| `contractors-plus` | `clip-public-vendor-controls`, `clip-public-vendor-investigation`, `clip-public-procurement`, `clip-public-contracts` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `contractor-portal` | `clip-public-contractor-portal`, `clip-public-procurement` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `claims-warnings` | `clip-public-claims`, `clip-public-contracts` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `alerts-plus` | `clip-public-alert-governance`, `clip-public-alerts` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `delegation` | `clip-public-alert-governance`, `clip-public-extras` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `audit-controls` | `clip-public-audit-controls` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `risk-forecast` | `clip-public-fund-forecast`, `clip-public-risk-lookahead`, `clip-public-bi`, `clip-public-disbursement` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `project-life` | `base`, `clip-public-lifecycle` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `capital-control` | `capital`, `clip-public-capital-control` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `payments` | `clip-public-payments`, `clip-public-payments-extra` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `reports-close` | `clip-public-disbursement`, `clip-public-reports-close` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `monitoring` | `clip-public-reports-close` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `procurement-desk` | `clip-public-procurement`, `clip-public-bid-analysis` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `contract-delivery` | `clip-public-contracts`, `clip-public-contract-site` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `field-ops` | `clip-public-field` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `docs-ai-plus` | `clip-public-docs-ai` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `correspondence` | `clip-public-correspondence` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `integration` | `clip-public-integration` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `portal-public` | `clip-public-portal` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `platform` | `clip-public-platform` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `phone-plus` | `clip-public-phone-extra`, `clip-public-procurement` | Chương cần nhóm dữ liệu chưa viết: các tác nhân quay viết nhóm trong scripts/clip-seed-lib.mjs theo mục "Nhóm phải tạo" rồi chuyển sang groups. |
| `features-tour` | - | - |
| `close` | - | - |

**Cảnh có nhóm dữ liệu chưa chạy trọn:** `contractors-plus`, `contractor-portal`, `claims-warnings`, `alerts-plus`, `delegation`, `audit-controls`, `risk-forecast`, `project-life`, `capital-control`, `payments`, `reports-close`, `monitoring`, `procurement-desk`, `contract-delivery`, `field-ops`, `docs-ai-plus`, `correspondence`, `integration`, `portal-public`, `platform`, `phone-plus`

## Bảng nhạc nền

Chỉ dùng bản nhạc CC0, chờ chủ sở hữu duyệt. Máy trộn hiện dùng một tệp nhạc cho cả đoạn phim; mức nhạc theo chương là hướng dẫn cho chủ sở hữu và cho bản trộn sau.

| Bản nhạc | Giấy phép | Duyệt |
|---|---|---|
| track-0: Calm Track (loop version) (pmiller) * | CC0, https://opengameart.org/content/calm-track | PROPOSED |
| track-1: Classical Pop (Instrumental) (Pro Sensory) | CC0, https://opengameart.org/content/classical-pop-instrumental | PENDING_OWNER |
| track-2: Chill Beats Collection (Holizna) | CC0, https://opengameart.org/content/chill-beats-collection | PENDING_OWNER |
| track-3: Music for the background (ghi trên trang) | CC0, https://opengameart.org/content/music-for-the-background | PENDING_OWNER |

| Điểm nhạc | Chương | Bắt đầu | Mức so với nền | Tính chất |
|---|---|---|---|---|
| `pub-open` | `intro` | 0:00 | 0 dB | Vào dần trong hai giây, nhạc mở đầu trên thẻ tiêu đề và hoạt cảnh bài toán. |
| `pub-overview` | `leader-home`, `disbursement`, `contracts` | 1:20 | 0 dB | Phần điều hành, vốn và hợp đồng: nền ổn định. |
| `pub-numbers` | `analytics`, `alerts`, `contractors` | 3:03 | -3 dB | Lời đọc dày chỉ tiêu và thuật ngữ: nhạc lùi. |
| `pub-egp` | `egp`, `province-committee` | 5:25 | -3 dB | Hai chương nhiều quy trình và số liệu: nhạc lùi. |
| `pub-tree-phone` | `process-tree`, `phone` | 7:59 | 2 dB | Chương có nhiều chuyển động trên hình và trên điện thoại: nhạc nhỉnh lên. |
| `pub-more` | `features-tour`, `contractors-plus`, `contractor-portal`, `claims-warnings`, `alerts-plus`, `delegation`, `audit-controls`, `risk-forecast`, `project-life`, `capital-control`, `payments`, `reports-close`, `monitoring`, `procurement-desk`, `contract-delivery`, `field-ops`, `docs-ai-plus`, `correspondence`, `integration`, `portal-public`, `platform`, `phone-plus` | 10:17 | -3 dB | Phần các chức năng bổ sung: lời đọc dày thuật ngữ nên nhạc lùi, hoạt cảnh tổng hợp mở đầu phần này. |
| `pub-close` | `close` | 10:46 | 0 dB | Kết thúc: nhạc tắt dần trong bốn giây sau thẻ cuối. |

## Giới thiệu hệ thống (`intro`)

### `intro-title`

Nền tảng: title; 14.5 giây; có trong video chính

**Lời đọc**

> Hệ thống quản lý đầu tư công, gồm nền tảng web, ứng dụng di động và PWA, theo dõi một khoản vốn từ kế hoạch đến quyết toán. Dữ liệu trong đoạn phim là dữ liệu minh họa cấp tỉnh.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hệ thống quản lý đầu tư công, gồm nền tảng quép, ứng dụng di động và pê-đắp-liu-a, theo dõi một khoản vốn từ kế hoạch đến quyết toán. Dữ liệu trong đoạn phim là dữ liệu minh họa cấp tỉnh.

**Phụ đề**

- Hệ thống quản lý đầu tư công, / gồm nền tảng web, ứng dụng di
- động và PWA, theo dõi một khoản / vốn từ kế hoạch đến quyết toán.
- Dữ liệu trong đoạn phim là / dữ liệu minh họa cấp tỉnh.

**Các bước quay**

- `do=animatic id=title-public`

**Cần thấy trên hình**

- [ ] Thẻ tiêu đề title-public có tên sản phẩm và dòng dữ liệu minh họa
- [ ] Chú thích "Dữ liệu minh họa" hiện từ giây 1, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Dữ liệu minh họa"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `intro-web-phone`

Nền tảng: animatic; 19.1 giây; có trong video chính

**Lời đọc**

> Hệ thống gồm ba kênh dùng chung một nguồn số liệu và một bộ quyền. Nền tảng web chạy trên trình duyệt cho người điều hành. Ứng dụng di động chạy trên điện thoại cho người làm ở hiện trường. PWA là ứng dụng web cài vào màn hình chính cho lãnh đạo.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hệ thống gồm ba kênh dùng chung một nguồn số liệu và một bộ quyền. Nền tảng quép chạy trên trình duyệt cho người điều hành. Ứng dụng di động chạy trên điện thoại cho người làm ở hiện trường. pê-đắp-liu-a là ứng dụng quép cài vào màn hình chính cho lãnh đạo.

**Phụ đề**

- Hệ thống gồm ba kênh dùng chung / một nguồn số liệu và một bộ quyền.
- Nền tảng web chạy trên trình / duyệt cho người điều hành.
- Ứng dụng di động chạy trên điện / thoại cho người làm ở hiện trường.
- PWA là ứng dụng web cài vào / màn hình chính cho lãnh đạo.

**Các bước quay**

- `do=animatic id=platform-map`

**Cần thấy trên hình**

- [ ] Hoạt cảnh platform-map chạy hết thời lượng của lời đọc, chữ trên hình là tiếng Việt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `intro-problem`

Nền tảng: animatic; 14.2 giây; có trong video chính

**Lời đọc**

> Đầu tư công đi qua nhiều tay: vốn, dự án, giải ngân, hợp đồng, đấu thầu. Mỗi nơi giữ một bảng tính, số liệu lệch nhau và đến muộn. Lãnh đạo hỏi một con số thì không biết số nào đúng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đầu tư công đi qua nhiều tay: vốn, dự án, giải ngân, hợp đồng, đấu thầu. Mỗi nơi giữ một bảng tính, số liệu lệch nhau và đến muộn. Lãnh đạo hỏi một con số thì không biết số nào đúng.

**Phụ đề**

- Đầu tư công đi qua nhiều tay: vốn, / dự án, giải ngân, hợp đồng, đấu thầu.
- Mỗi nơi giữ một bảng tính, số / liệu lệch nhau và đến muộn.
- Lãnh đạo hỏi một con số / thì không biết số nào đúng.

**Các bước quay**

- `do=animatic id=problem-scattered`

**Cần thấy trên hình**

- [ ] Hoạt cảnh problem-scattered chạy hết thời lượng của lời đọc, chữ trên hình là tiếng Việt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `intro-platform`

Nền tảng: animatic; 14.8 giây; có trong video chính

**Lời đọc**

> Một nền tảng gom kế hoạch vốn, dự án, giải ngân, thanh toán, hợp đồng, đấu thầu, phân tích, cảnh báo và ứng dụng điện thoại. Mọi mô-đun dùng chung một danh mục, một bộ quy tắc và một nhật ký kiểm toán.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Một nền tảng gom kế hoạch vốn, dự án, giải ngân, thanh toán, hợp đồng, đấu thầu, phân tích, cảnh báo và ứng dụng điện thoại. Mọi mô-đun dùng chung một danh mục, một bộ quy tắc và một nhật ký kiểm toán.

**Phụ đề**

- Một nền tảng gom kế hoạch vốn, / dự án, giải ngân, thanh toán,
- hợp đồng, đấu thầu, phân tích, / cảnh báo và ứng dụng điện thoại.
- Mọi mô-đun dùng chung một danh mục, một / bộ quy tắc và một nhật ký kiểm toán.

**Các bước quay**

- `do=animatic id=platform-map`

**Cần thấy trên hình**

- [ ] Hoạt cảnh platform-map chạy hết thời lượng của lời đọc, chữ trên hình là tiếng Việt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `intro-services`

Nền tảng: animatic; 17.3 giây; có trong video chính

**Lời đọc**

> Người dùng vào bằng trình duyệt hoặc điện thoại, đăng nhập một lần. Mỗi thao tác đi qua máy chủ nghiệp vụ, ghi vào cơ sở dữ liệu phân quyền theo dòng, rồi phát sự kiện cho thông báo và phân tích. Kho bạc và mạng đấu thầu nối bằng tệp.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Người dùng vào bằng trình duyệt hoặc điện thoại, đăng nhập một lần. Mỗi thao tác đi qua máy chủ nghiệp vụ, ghi vào cơ sở dữ liệu phân quyền theo dòng, rồi phát sự kiện cho thông báo và phân tích. Kho bạc và mạng đấu thầu nối bằng tệp.

**Phụ đề**

- Người dùng vào bằng trình duyệt / hoặc điện thoại, đăng nhập một lần.
- Mỗi thao tác đi qua máy chủ nghiệp / vụ, ghi vào cơ sở dữ liệu phân
- quyền theo dòng, rồi phát sự / kiện cho thông báo và phân tích.
- Kho bạc và mạng đấu thầu nối bằng tệp.

**Các bước quay**

- `do=animatic id=service-flow`

**Cần thấy trên hình**

- [ ] Hoạt cảnh service-flow chạy hết thời lượng của lời đọc, chữ trên hình là tiếng Việt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Tổng quan điều hành (`leader-home`)

### `home-command`

Nền tảng: web; 20.9 giây; có trong video chính

Màn hình: `HOME-09` Trung tâm điều hành giải ngân (/home/home-09); `HOME-01` Tổng quan điều hành (/home/home-01)

**Lời đọc**

> Trung tâm điều hành đặt hai tỷ lệ giải ngân cạnh nhau: {{figure:disb-rate-pm}} theo kế hoạch Thủ tướng giao, {{figure:disb-rate-total}} theo toàn bộ kế hoạch. Đã giải ngân {{figure:disbursed-treasury}}. Phạm vi, ngày chốt và mã số liệu luôn hiện trên cùng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trung tâm điều hành đặt hai tỷ lệ giải ngân cạnh nhau: {{figure:disb-rate-pm}} theo kế hoạch Thủ tướng giao, {{figure:disb-rate-total}} theo toàn bộ kế hoạch. Đã giải ngân {{figure:disbursed-treasury}}. Phạm vi, ngày chốt và mã số liệu luôn hiện trên cùng.

**Phụ đề**

- Trung tâm điều hành đặt hai / tỷ lệ giải ngân cạnh nhau:
- {n} theo kế hoạch Thủ tướng / giao, {n} theo toàn bộ kế hoạch.
- Đã giải ngân {n}.
- Phạm vi, ngày chốt và mã số / liệu luôn hiện trên cùng.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=HOME-09`
- `do=spot ref=home.context-bar`
- `do=spot ref=home.rate-tiles`

**Cần thấy trên hình**

- [ ] Màn HOME-09 "Trung tâm điều hành giải ngân" mở được ở đường dẫn /home/home-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn HOME-01 "Tổng quan điều hành" mở được ở đường dẫn /home/home-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần home.context-bar đúng lúc giọng đọc nói tới
- [ ] Khung vào phần home.rate-tiles đúng lúc giọng đọc nói tới
- [ ] Chú thích "Hai tỷ lệ cùng một tử số" hiện từ giây 3, kéo dài 5 giây
- [ ] Con số disb-rate-pm đọc từ dữ liệu thật qua getCommandCenter (tiles[code=DISBURSEMENT_RATE_PM].value); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số disb-rate-total đọc từ dữ liệu thật qua getCommandCenter (tiles[code=DISBURSEMENT_RATE_TOTAL].value); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số disbursed-treasury đọc từ dữ liệu thật qua getCommandCenter (tiles[code=DISBURSED_TREASURY].value); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `home-drill`

Nền tảng: web; 11.5 giây; có trong video chính

Màn hình: `HOME-10` Ngữ cảnh số liệu và truy nguồn (/home/home-10)

**Lời đọc**

> Bấm vào một con số để truy nguồn ba bước: chỉ tiêu, đơn vị hoặc dự án, hồ sơ gốc. Bộ lọc được giữ nguyên, và phạm vi ngoài quyền không lộ tên.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bấm vào một con số để truy nguồn ba bước: chỉ tiêu, đơn vị hoặc dự án, hồ sơ gốc. Bộ lọc được giữ nguyên, và phạm vi ngoài quyền không lộ tên.

**Phụ đề**

- Bấm vào một con số để truy nguồn ba bước: / chỉ tiêu, đơn vị hoặc dự án, hồ sơ gốc.
- Bộ lọc được giữ nguyên, và phạm / vi ngoài quyền không lộ tên.

**Các bước quay**

- `do=click ref=home.rate-tiles.drill-link`
- `do=click ref=home.drill.first-unit`
- `do=spot ref=home.drill.record-link`

**Cần thấy trên hình**

- [ ] Màn HOME-10 "Ngữ cảnh số liệu và truy nguồn" mở được ở đường dẫn /home/home-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần home.rate-tiles.drill-link đúng lúc giọng đọc nói tới
- [ ] Khung vào phần home.drill.first-unit đúng lúc giọng đọc nói tới
- [ ] Khung vào phần home.drill.record-link đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `home-why-red`

Nền tảng: web; 11.1 giây; có trong video chính

Màn hình: `HOME-11` Màu xanh vàng đỏ có giải thích (/home/home-11)

**Lời đọc**

> Màu xanh, vàng, đỏ luôn kèm lời giải thích: vì sao đỏ, do một đến ba yếu tố nào, dữ liệu phủ bao nhiêu. Ghi đè một màu phải có lý do.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Màu xanh, vàng, đỏ luôn kèm lời giải thích: vì sao đỏ, do một đến ba yếu tố nào, dữ liệu phủ bao nhiêu. Ghi đè một màu phải có lý do.

**Phụ đề**

- Màu xanh, vàng, đỏ luôn kèm / lời giải thích: vì sao đỏ,
- do một đến ba yếu tố nào, / dữ liệu phủ bao nhiêu.
- Ghi đè một màu phải có lý do.

**Các bước quay**

- `do=open screen=HOME-11`
- `do=click ref=home.rag.first-red-row`
- `do=spot ref=home.rag.why-factors`

**Cần thấy trên hình**

- [ ] Màn HOME-11 "Màu xanh vàng đỏ có giải thích" mở được ở đường dẫn /home/home-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần home.rag.first-red-row đúng lúc giọng đọc nói tới
- [ ] Khung vào phần home.rag.why-factors đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `home-changes`

Nền tảng: web; 11.8 giây; có trong video chính

Màn hình: `HOME-09` Trung tâm điều hành giải ngân (/home/home-09); `DIS-23` Dự báo dòng tiền và ước cuối năm (EAC) (/dis/dis-23)

**Lời đọc**

> Khối thay đổi từ tuần trước tự sinh theo quy tắc, tối đa năm dòng. Dự báo cuối năm hiện thành một dải, và cho biết mỗi tuần cần giải ngân thêm bao nhiêu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Khối thay đổi từ tuần trước tự sinh theo quy tắc, tối đa năm dòng. Dự báo cuối năm hiện thành một dải, và cho biết mỗi tuần cần giải ngân thêm bao nhiêu.

**Phụ đề**

- Khối thay đổi từ tuần trước tự / sinh theo quy tắc, tối đa năm dòng.
- Dự báo cuối năm hiện thành một dải,
- và cho biết mỗi tuần cần / giải ngân thêm bao nhiêu.

**Các bước quay**

- `do=open screen=HOME-09`
- `do=spot ref=home.changes.list`
- `do=open screen=DIS-23`
- `do=spot ref=dis.forecast.band`

**Cần thấy trên hình**

- [ ] Màn HOME-09 "Trung tâm điều hành giải ngân" mở được ở đường dẫn /home/home-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-23 "Dự báo dòng tiền và ước cuối năm (EAC)" mở được ở đường dẫn /dis/dis-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần home.changes.list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.forecast.band đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `home-ranking`

Nền tảng: web; 15.4 giây; chỉ trong chương cắt riêng

Màn hình: `HOME-04` Xếp hạng giải ngân (/home/home-04)

**Lời đọc**

> Xếp hạng giải ngân dùng nhiều chỉ số, chuẩn hóa theo quy mô, và ghép tỷ lệ giải ngân với tiến độ vật lý. Đơn vị vướng ngoài tầm kiểm soát được ghi chú có người duyệt, và có quyền khiếu nại số liệu của mình.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Xếp hạng giải ngân dùng nhiều chỉ số, chuẩn hóa theo quy mô, và ghép tỷ lệ giải ngân với tiến độ vật lý. Đơn vị vướng ngoài tầm kiểm soát được ghi chú có người duyệt, và có quyền khiếu nại số liệu của mình.

**Phụ đề**

- Xếp hạng giải ngân dùng nhiều / chỉ số, chuẩn hóa theo quy mô,
- và ghép tỷ lệ giải ngân / với tiến độ vật lý.
- Đơn vị vướng ngoài tầm / kiểm soát được ghi chú có
- người duyệt, và có quyền / khiếu nại số liệu của mình.

**Các bước quay**

- `do=open screen=HOME-04`
- `do=spot ref=home.ranking.table`

**Cần thấy trên hình**

- [ ] Màn HOME-04 "Xếp hạng giải ngân" mở được ở đường dẫn /home/home-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần home.ranking.table đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `home-map`

Nền tảng: web; 11.8 giây; chỉ trong chương cắt riêng

Màn hình: `HOME-05` Bản đồ dự án (/home/home-05)

**Lời đọc**

> Bản đồ dự án đặt từng dự án đúng vị trí, tô màu theo mức giải ngân và tình trạng vướng mắc. Chạm vào một điểm để xem hồ sơ và người phụ trách.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bản đồ dự án đặt từng dự án đúng vị trí, tô màu theo mức giải ngân và tình trạng vướng mắc. Chạm vào một điểm để xem hồ sơ và người phụ trách.

**Phụ đề**

- Bản đồ dự án đặt từng dự án đúng vị trí,
- tô màu theo mức giải ngân / và tình trạng vướng mắc.
- Chạm vào một điểm để xem / hồ sơ và người phụ trách.

**Các bước quay**

- `do=open screen=HOME-05`
- `do=click ref=home.map.first-marker`

**Cần thấy trên hình**

- [ ] Màn HOME-05 "Bản đồ dự án" mở được ở đường dẫn /home/home-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần home.map.first-marker đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `home-directives`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `DIR-03` Bảng theo dõi chỉ đạo (/dir/dir-03); `DIR-04` Chi tiết chỉ đạo, dòng thời gian, gia hạn và đóng (/dir/dir-04)

**Lời đọc**

> Chỉ đạo giao ban được theo dõi đến cùng: ai giao, đơn vị thực hiện, hạn, tiến độ và bằng chứng. Chỉ đạo quá hạn nổi lên đầu bảng, và chỉ đạo của kỳ tự đưa vào báo cáo kỳ sau.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chỉ đạo giao ban được theo dõi đến cùng: ai giao, đơn vị thực hiện, hạn, tiến độ và bằng chứng. Chỉ đạo quá hạn nổi lên đầu bảng, và chỉ đạo của kỳ tự đưa vào báo cáo kỳ sau.

**Phụ đề**

- Chỉ đạo giao ban được theo / dõi đến cùng: ai giao,
- đơn vị thực hiện, hạn, / tiến độ và bằng chứng.
- Chỉ đạo quá hạn nổi lên đầu bảng, và chỉ / đạo của kỳ tự đưa vào báo cáo kỳ sau.

**Các bước quay**

- `do=open screen=DIR-03`
- `do=click ref=dir.board.first-overdue`
- `do=spot ref=dir.detail.timeline`

**Cần thấy trên hình**

- [ ] Màn DIR-03 "Bảng theo dõi chỉ đạo" mở được ở đường dẫn /dir/dir-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIR-04 "Chi tiết chỉ đạo, dòng thời gian, gia hạn và đóng" mở được ở đường dẫn /dir/dir-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần dir.board.first-overdue đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dir.detail.timeline đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Giải ngân và kế hoạch vốn (`disbursement`)

### `dis-weekly`

Nền tảng: web; 13 giây; có trong video chính

Màn hình: `DIS-03` Nhập khối lượng (/dis/dis-03); `DIS-04` Nhập giải ngân theo nguồn (/dis/dis-04); `DIS-06` Rà soát và gửi báo cáo (/dis/dis-06)

**Lời đọc**

> Chủ đầu tư nhập báo cáo giải ngân tuần theo từng nguồn vốn, rà soát rồi gửi. Người gửi khác người duyệt. Báo cáo bị trả lại phải có lý do, bản đã duyệt không sửa được.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chủ đầu tư nhập báo cáo giải ngân tuần theo từng nguồn vốn, rà soát rồi gửi. Người gửi khác người duyệt. Báo cáo bị trả lại phải có lý do, bản đã duyệt không sửa được.

**Phụ đề**

- Chủ đầu tư nhập báo cáo giải ngân tuần / theo từng nguồn vốn, rà soát rồi gửi.
- Người gửi khác người duyệt.
- Báo cáo bị trả lại phải có lý / do, bản đã duyệt không sửa được.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=DIS-04`
- `do=spot ref=dis.funding.matrix`
- `do=open screen=DIS-06`
- `do=click ref=dis.review.submit`

**Cần thấy trên hình**

- [ ] Màn DIS-03 "Nhập khối lượng" mở được ở đường dẫn /dis/dis-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-04 "Nhập giải ngân theo nguồn" mở được ở đường dẫn /dis/dis-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-06 "Rà soát và gửi báo cáo" mở được ở đường dẫn /dis/dis-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần dis.funding.matrix đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.review.submit đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `dis-freeze`

Nền tảng: web; 11.5 giây; có trong video chính

Màn hình: `DIS-21` Chốt và đóng băng số liệu kỳ (/dis/dis-21); `DIS-22` Mở lại kỳ có lý do (/dis/dis-22)

**Lời đọc**

> Cuối kỳ, số liệu được chốt kèm mã băm, nên báo cáo hôm nay và ba tháng sau cho cùng một kết quả. Mở lại kỳ phải có lý do và người duyệt.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cuối kỳ, số liệu được chốt kèm mã băm, nên báo cáo hôm nay và ba tháng sau cho cùng một kết quả. Mở lại kỳ phải có lý do và người duyệt.

**Phụ đề**

- Cuối kỳ, số liệu được chốt kèm mã băm,
- nên báo cáo hôm nay và ba / tháng sau cho cùng một kết quả.
- Mở lại kỳ phải có lý do và người duyệt.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=DIS-21`
- `do=spot ref=dis.freeze.snapshot-hash`
- `do=open screen=DIS-22`

**Cần thấy trên hình**

- [ ] Màn DIS-21 "Chốt và đóng băng số liệu kỳ" mở được ở đường dẫn /dis/dis-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-22 "Mở lại kỳ có lý do" mở được ở đường dẫn /dis/dis-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần dis.freeze.snapshot-hash đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `dis-treasury`

Nền tảng: web; 11.5 giây; có trong video chính

Màn hình: `PAY-20` Đối soát Kho bạc hằng ngày theo dự án và nguồn vốn (/pay/pay-20); `PAY-05` Đối soát giao dịch (/pay/pay-05)

**Lời đọc**

> Mỗi ngày hệ thống đối soát số giải ngân với Kho bạc theo dự án và nguồn vốn. Chênh lệch vượt ngưỡng thành hạng mục có người chịu trách nhiệm, khác người lập.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi ngày hệ thống đối soát số giải ngân với Kho bạc theo dự án và nguồn vốn. Chênh lệch vượt ngưỡng thành hạng mục có người chịu trách nhiệm, khác người lập.

**Phụ đề**

- Mỗi ngày hệ thống đối soát số giải ngân / với Kho bạc theo dự án và nguồn vốn.
- Chênh lệch vượt ngưỡng thành hạng mục có / người chịu trách nhiệm, khác người lập.

**Các bước quay**

- `do=as persona=treasuryMaker`
- `do=open screen=PAY-20`
- `do=spot ref=pay.daily-recon.difference-rows`
- `do=click ref=pay.daily-recon.assign-owner`

**Cần thấy trên hình**

- [ ] Màn PAY-20 "Đối soát Kho bạc hằng ngày theo dự án và nguồn vốn" mở được ở đường dẫn /pay/pay-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-05 "Đối soát giao dịch" mở được ở đường dẫn /pay/pay-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản treasuryMaker
- [ ] Khung vào phần pay.daily-recon.difference-rows đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.daily-recon.assign-owner đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `cap-realloc`

Nền tảng: web; 12.7 giây; chỉ trong chương cắt riêng

Màn hình: `CAP-19` Đề xuất điều chuyển vốn chậm sang nhanh (/cap/cap-19); `CAP-09` Mô phỏng phân bổ (/cap/cap-09)

**Lời đọc**

> Dự án giải ngân chậm có thể được đề xuất chuyển vốn sang dự án nhanh. Hệ thống mô phỏng tác động lên tỷ lệ toàn tỉnh trước khi duyệt, và ghi bất biến mọi quyết định.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Dự án giải ngân chậm có thể được đề xuất chuyển vốn sang dự án nhanh. Hệ thống mô phỏng tác động lên tỷ lệ toàn tỉnh trước khi duyệt, và ghi bất biến mọi quyết định.

**Phụ đề**

- Dự án giải ngân chậm có thể được đề / xuất chuyển vốn sang dự án nhanh.
- Hệ thống mô phỏng tác / động lên tỷ lệ toàn tỉnh
- trước khi duyệt, và ghi / bất biến mọi quyết định.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=CAP-19`
- `do=click ref=cap.realloc.simulate`
- `do=spot ref=cap.realloc.impact-on-rate`

**Cần thấy trên hình**

- [ ] Màn CAP-19 "Đề xuất điều chuyển vốn chậm sang nhanh" mở được ở đường dẫn /cap/cap-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-09 "Mô phỏng phân bổ" mở được ở đường dẫn /cap/cap-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần cap.realloc.simulate đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.realloc.impact-on-rate đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pay-conditions`

Nền tảng: web; 17.9 giây; chỉ trong chương cắt riêng

Màn hình: `PAY-19` Điều kiện giải ngân của dự án (/pay/pay-19)

**Lời đọc**

> Dự án chưa có danh mục và kế hoạch vốn trên hệ thống thì không lập được đề nghị thanh toán. Hệ thống nói đúng nguyên nhân cùng cách xử lý. Số trên hệ thống thắng số trên giấy. Căn cứ pháp lý của quy tắc này còn ghi chưa kiểm chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Dự án chưa có danh mục và kế hoạch vốn trên hệ thống thì không lập được đề nghị thanh toán. Hệ thống nói đúng nguyên nhân cùng cách xử lý. Số trên hệ thống thắng số trên giấy. Căn cứ pháp lý của quy tắc này còn ghi chưa kiểm chứng.

**Phụ đề**

- Dự án chưa có danh mục / và kế hoạch vốn trên hệ
- thống thì không lập / được đề nghị thanh toán.
- Hệ thống nói đúng nguyên / nhân cùng cách xử lý.
- Số trên hệ thống thắng số trên giấy.
- Căn cứ pháp lý của quy tắc / này còn ghi chưa kiểm chứng.

**Các bước quay**

- `do=as persona=paymentApprover`
- `do=open screen=PAY-19`
- `do=spot ref=pay.conditions.blocking-reason`

**Cần thấy trên hình**

- [ ] Màn PAY-19 "Điều kiện giải ngân của dự án" mở được ở đường dẫn /pay/pay-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản paymentApprover
- [ ] Khung vào phần pay.conditions.blocking-reason đúng lúc giọng đọc nói tới
- [ ] Chú thích "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng" hiện từ giây 4, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pay-advance`

Nền tảng: web; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `PAY-18` Bảng thu hồi tạm ứng: kế hoạch và thực tế (/pay/pay-18); `PAY-12` Cảnh báo tạm ứng quá hạn và thu hồi (/pay/pay-12)

**Lời đọc**

> Tạm ứng có trần theo chính sách có hiệu lực theo ngày. Bảng thu hồi đặt kế hoạch cạnh thực tế, và dư nợ vượt giá trị còn lại của hợp đồng thì báo Khẩn tới người chịu trách nhiệm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Tạm ứng có trần theo chính sách có hiệu lực theo ngày. Bảng thu hồi đặt kế hoạch cạnh thực tế, và dư nợ vượt giá trị còn lại của hợp đồng thì báo Khẩn tới người chịu trách nhiệm.

**Phụ đề**

- Tạm ứng có trần theo chính / sách có hiệu lực theo ngày.
- Bảng thu hồi đặt kế hoạch cạnh / thực tế, và dư nợ vượt giá trị
- còn lại của hợp đồng thì báo / Khẩn tới người chịu trách nhiệm.

**Các bước quay**

- `do=as persona=paymentApprover`
- `do=open screen=PAY-18`
- `do=spot ref=pay.advance.plan-vs-actual`

**Cần thấy trên hình**

- [ ] Màn PAY-18 "Bảng thu hồi tạm ứng: kế hoạch và thực tế" mở được ở đường dẫn /pay/pay-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-12 "Cảnh báo tạm ứng quá hạn và thu hồi" mở được ở đường dẫn /pay/pay-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản paymentApprover
- [ ] Khung vào phần pay.advance.plan-vs-actual đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `dis-warnings`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `DIS-20` Quy tắc cảnh báo sớm (/dis/dis-20); `HOME-03` Cảnh báo sớm (/home/home-03)

**Lời đọc**

> Quy tắc cảnh báo sớm là dữ liệu có phiên bản. Mỗi cảnh báo ghi công thức, ngưỡng, người được báo và hậu quả nếu bỏ qua. Đổi ngưỡng phải qua người duyệt và có hiệu lực từ một ngày xác định.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Quy tắc cảnh báo sớm là dữ liệu có phiên bản. Mỗi cảnh báo ghi công thức, ngưỡng, người được báo và hậu quả nếu bỏ qua. Đổi ngưỡng phải qua người duyệt và có hiệu lực từ một ngày xác định.

**Phụ đề**

- Quy tắc cảnh báo sớm là / dữ liệu có phiên bản.
- Mỗi cảnh báo ghi công thức, ngưỡng, / người được báo và hậu quả nếu bỏ qua.
- Đổi ngưỡng phải qua người duyệt và / có hiệu lực từ một ngày xác định.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DIS-20`
- `do=spot ref=dis.warning-rules.version-column`

**Cần thấy trên hình**

- [ ] Màn DIS-20 "Quy tắc cảnh báo sớm" mở được ở đường dẫn /dis/dis-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn HOME-03 "Cảnh báo sớm" mở được ở đường dẫn /home/home-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần dis.warning-rules.version-column đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Quản lý hợp đồng (`contracts`)

### `ctr-portfolio`

Nền tảng: web; 12.1 giây; có trong video chính

Màn hình: `CTR-01` Danh mục hợp đồng (/ctr/ctr-01); `CTR-03` Không gian thực hiện hợp đồng (/ctr/ctr-03)

**Lời đọc**

> Danh mục hợp đồng lấy tổng từ máy chủ. Mỗi hợp đồng có không gian thực hiện: khối lượng, nghiệm thu, thanh toán, tạm ứng, giữ lại và bảo lãnh, khớp với sổ lũy kế.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Danh mục hợp đồng lấy tổng từ máy chủ. Mỗi hợp đồng có không gian thực hiện: khối lượng, nghiệm thu, thanh toán, tạm ứng, giữ lại và bảo lãnh, khớp với sổ lũy kế.

**Phụ đề**

- Danh mục hợp đồng lấy tổng từ máy chủ.
- Mỗi hợp đồng có không gian thực / hiện: khối lượng, nghiệm thu,
- thanh toán, tạm ứng, giữ lại và / bảo lãnh, khớp với sổ lũy kế.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-01`
- `do=spot ref=ctr.portfolio.server-totals`
- `do=click ref=ctr.portfolio.first-row`

**Cần thấy trên hình**

- [ ] Màn CTR-01 "Danh mục hợp đồng" mở được ở đường dẫn /ctr/ctr-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-03 "Không gian thực hiện hợp đồng" mở được ở đường dẫn /ctr/ctr-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.portfolio.server-totals đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.portfolio.first-row đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ctr-change-chain`

Nền tảng: web; 15.4 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-19` Chuỗi thay đổi ChangeEvent → PCO → CO (/ctr/ctr-19); `CTR-27` Bậc của lệnh thay đổi và kiểm tra điều chỉnh dự án (/ctr/ctr-27)

**Lời đọc**

> Thay đổi hợp đồng đi theo chuỗi: sự kiện thay đổi, lệnh thay đổi tạm tính, rồi lệnh thay đổi chính thức. Có nhiều tầng duyệt theo ngưỡng và ủy quyền, giá trị cộng dồn so với giá gốc, và hệ thống chặn khi hết vốn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Thay đổi hợp đồng đi theo chuỗi: sự kiện thay đổi, lệnh thay đổi tạm tính, rồi lệnh thay đổi chính thức. Có nhiều tầng duyệt theo ngưỡng và ủy quyền, giá trị cộng dồn so với giá gốc, và hệ thống chặn khi hết vốn.

**Phụ đề**

- Thay đổi hợp đồng đi theo / chuỗi: sự kiện thay đổi,
- lệnh thay đổi tạm tính, rồi / lệnh thay đổi chính thức.
- Có nhiều tầng duyệt / theo ngưỡng và ủy quyền,
- giá trị cộng dồn so với giá gốc, / và hệ thống chặn khi hết vốn.

**Các bước quay**

- `do=open screen=CTR-19`
- `do=spot ref=ctr.change-chain.board`
- `do=open screen=CTR-27`

**Cần thấy trên hình**

- [ ] Màn CTR-19 "Chuỗi thay đổi ChangeEvent → PCO → CO" mở được ở đường dẫn /ctr/ctr-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-27 "Bậc của lệnh thay đổi và kiểm tra điều chỉnh dự án" mở được ở đường dẫn /ctr/ctr-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần ctr.change-chain.board đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ctr-three-way`

Nền tảng: web; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `PAY-10` Sổ lũy kế hợp đồng × dòng BOQ × nghiệm thu (/pay/pay-10); `CTR-21` Giữ lại theo dòng BOQ và giải tỏa (/ctr/ctr-21)

**Lời đọc**

> Khớp ba bên đặt khối lượng đo, nghiệm thu và thanh toán lên cùng một sổ lũy kế. Hệ thống chặn giải phóng khoản giữ lại khi còn tồn đọng chất lượng, bảo hành hoặc khiếu nại chưa xử lý.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Khớp ba bên đặt khối lượng đo, nghiệm thu và thanh toán lên cùng một sổ lũy kế. Hệ thống chặn giải phóng khoản giữ lại khi còn tồn đọng chất lượng, bảo hành hoặc khiếu nại chưa xử lý.

**Phụ đề**

- Khớp ba bên đặt khối lượng đo, nghiệm / thu và thanh toán lên cùng một sổ lũy kế.
- Hệ thống chặn giải phóng / khoản giữ lại khi còn tồn
- đọng chất lượng, bảo hành / hoặc khiếu nại chưa xử lý.

**Các bước quay**

- `do=as persona=paymentApprover`
- `do=open screen=PAY-10`
- `do=spot ref=pay.three-way.mismatch`

**Cần thấy trên hình**

- [ ] Màn PAY-10 "Sổ lũy kế hợp đồng × dòng BOQ × nghiệm thu" mở được ở đường dẫn /pay/pay-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-21 "Giữ lại theo dòng BOQ và giải tỏa" mở được ở đường dẫn /ctr/ctr-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản paymentApprover
- [ ] Khung vào phần pay.three-way.mismatch đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ctr-integrity`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `AUD-12` Phát hiện toàn vẹn thanh toán (/aud/aud-12); `ADM-24` Tách bạch nhiệm vụ (/adm/adm-24)

**Lời đọc**

> Kiểm toàn vẹn thanh toán phát hiện khoản trùng, đơn giá bất thường, thanh toán vượt hợp đồng và khối lượng lệch nhật ký. Ma trận tách bạch nhiệm vụ được kiểm ngay lúc ghi, và ngoại lệ phải có hạn cùng hai người duyệt.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kiểm toàn vẹn thanh toán phát hiện khoản trùng, đơn giá bất thường, thanh toán vượt hợp đồng và khối lượng lệch nhật ký. Ma trận tách bạch nhiệm vụ được kiểm ngay lúc ghi, và ngoại lệ phải có hạn cùng hai người duyệt.

**Phụ đề**

- Kiểm toàn vẹn thanh toán phát hiện / khoản trùng, đơn giá bất thường,
- thanh toán vượt hợp đồng / và khối lượng lệch nhật ký.
- Ma trận tách bạch nhiệm / vụ được kiểm ngay lúc ghi,
- và ngoại lệ phải có hạn / cùng hai người duyệt.

**Các bước quay**

- `do=as persona=auditor`
- `do=open screen=AUD-12`
- `do=spot ref=aud.integrity.findings`

**Cần thấy trên hình**

- [ ] Màn AUD-12 "Phát hiện toàn vẹn thanh toán" mở được ở đường dẫn /aud/aud-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-24 "Tách bạch nhiệm vụ" mở được ở đường dẫn /adm/adm-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản auditor
- [ ] Khung vào phần aud.integrity.findings đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ctr-closure`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-17` Quyết toán hợp đồng và dự án (/ctr/ctr-17); `AST-04` Bảo hành và giữ lại (/ast/ast-04); `AST-07` Kích hoạt đánh giá sau đầu tư (/ast/ast-07)

**Lời đọc**

> Cuối vòng đời, hợp đồng đi qua nghiệm thu, bàn giao, bảo hành và quyết toán. Hồ sơ tài sản chuyển sang đơn vị vận hành, và việc kích hoạt đánh giá sau đầu tư nằm ngay trong bước bàn giao.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cuối vòng đời, hợp đồng đi qua nghiệm thu, bàn giao, bảo hành và quyết toán. Hồ sơ tài sản chuyển sang đơn vị vận hành, và việc kích hoạt đánh giá sau đầu tư nằm ngay trong bước bàn giao.

**Phụ đề**

- Cuối vòng đời, hợp đồng đi qua nghiệm / thu, bàn giao, bảo hành và quyết toán.
- Hồ sơ tài sản chuyển sang / đơn vị vận hành, và việc kích
- hoạt đánh giá sau đầu tư nằm / ngay trong bước bàn giao.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-17`
- `do=spot ref=ctr.closure.checklist`

**Cần thấy trên hình**

- [ ] Màn CTR-17 "Quyết toán hợp đồng và dự án" mở được ở đường dẫn /ctr/ctr-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AST-04 "Bảo hành và giữ lại" mở được ở đường dẫn /ast/ast-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AST-07 "Kích hoạt đánh giá sau đầu tư" mở được ở đường dẫn /ast/ast-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.closure.checklist đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Báo cáo phân tích và BI (`analytics`)

### `ana-hub`

Nền tảng: web; 19.1 giây; có trong video chính

Màn hình: `CTR-28` Trung tâm báo cáo phân tích hợp đồng (/ctr/ctr-28); `CTR-29` Danh mục và trạng thái hợp đồng (phân tích) (/ctr/ctr-29)

**Lời đọc**

> Trung tâm báo cáo hợp đồng gom 19 báo cáo phân tích. Bộ lọc và tổng cộng do máy chủ tính, nên số trên màn hình, trong Excel và trên điện thoại luôn khớp. Hiện có {{figure:ctr-count}} hợp đồng, giá trị {{figure:ctr-value}}.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trung tâm báo cáo hợp đồng gom 19 báo cáo phân tích. Bộ lọc và tổng cộng do máy chủ tính, nên số trên màn hình, trong ếch-xeo và trên điện thoại luôn khớp. Hiện có {{figure:ctr-count}} hợp đồng, giá trị {{figure:ctr-value}}.

**Phụ đề**

- Trung tâm báo cáo hợp đồng / gom 19 báo cáo phân tích.
- Bộ lọc và tổng cộng do máy chủ / tính, nên số trên màn hình,
- trong Excel và trên điện thoại luôn khớp.
- Hiện có {n} hợp đồng, giá trị {n}.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=CTR-28`
- `do=spot ref=ctr.report-hub.cards`
- `do=click ref=ctr.report-hub.export-xlsx`

**Cần thấy trên hình**

- [ ] Màn CTR-28 "Trung tâm báo cáo phân tích hợp đồng" mở được ở đường dẫn /ctr/ctr-28, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-29 "Danh mục và trạng thái hợp đồng (phân tích)" mở được ở đường dẫn /ctr/ctr-29, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ctr.report-hub.cards đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.report-hub.export-xlsx đúng lúc giọng đọc nói tới
- [ ] Chú thích "19 báo cáo · một định nghĩa số liệu" hiện từ giây 1.5, kéo dài 4 giây
- [ ] Con số ctr-count đọc từ dữ liệu thật qua getContractPortfolio (totals.contract_count); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số ctr-value đọc từ dữ liệu thật qua getContractPortfolio (totals.contract_value_billion); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ana-kpi-info`

Nền tảng: web; 10.5 giây; chỉ trong chương cắt riêng

Màn hình: `BI-20` Sổ chỉ tiêu (/bi/bi-20); `BI-19` Chứng nhận chỉ tiêu và bộ dữ liệu (/bi/bi-19)

**Lời đọc**

> Mỗi con số có nút i: bấm vào để xem công thức, nguồn, giờ cập nhật và ngày chốt. Chỉ tiêu có một định nghĩa, một người chịu trách nhiệm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi con số có nút i: bấm vào để xem công thức, nguồn, giờ cập nhật và ngày chốt. Chỉ tiêu có một định nghĩa, một người chịu trách nhiệm.

**Phụ đề**

- Mỗi con số có nút i: bấm vào để xem công / thức, nguồn, giờ cập nhật và ngày chốt.
- Chỉ tiêu có một định nghĩa, / một người chịu trách nhiệm.

**Các bước quay**

- `do=as persona=dgvSteward`
- `do=open screen=BI-20`
- `do=click ref=bi.kpi-register.info-button`
- `do=spot ref=bi.kpi-register.formula-panel`

**Cần thấy trên hình**

- [ ] Màn BI-20 "Sổ chỉ tiêu" mở được ở đường dẫn /bi/bi-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-19 "Chứng nhận chỉ tiêu và bộ dữ liệu" mở được ở đường dẫn /bi/bi-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản dgvSteward
- [ ] Khung vào phần bi.kpi-register.info-button đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.kpi-register.formula-panel đúng lúc giọng đọc nói tới
- [ ] Chú thích "Công thức · nguồn · giờ cập nhật · ngày chốt" hiện từ giây 2, kéo dài 5 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ana-evm`

Nền tảng: web; 16 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-27` Giá trị thu được (EVM) và đường S (/prj/prj-27); `PRJ-26` Đường cơ sở, độ lệch và số lần dời mốc (/prj/prj-26)

**Lời đọc**

> Báo cáo giá trị thu được tính đủ chỉ số chi phí và tiến độ, kèm đường S so với đường cơ sở. Chỉ khối lượng đã nghiệm thu mới tạo giá trị. Thiếu đường cơ sở thì ghi chưa đủ dữ liệu, không ghi số không.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Báo cáo giá trị thu được tính đủ chỉ số chi phí và tiến độ, kèm đường ét so với đường cơ sở. Chỉ khối lượng đã nghiệm thu mới tạo giá trị. Thiếu đường cơ sở thì ghi chưa đủ dữ liệu, không ghi số không.

**Phụ đề**

- Báo cáo giá trị thu được / tính đủ chỉ số chi phí
- và tiến độ, kèm đường / S so với đường cơ sở.
- Chỉ khối lượng đã nghiệm / thu mới tạo giá trị.
- Thiếu đường cơ sở thì ghi chưa / đủ dữ liệu, không ghi số không.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=PRJ-27`
- `do=spot ref=prj.evm.s-curve`
- `do=click ref=prj.evm.view-at-date`

**Cần thấy trên hình**

- [ ] Màn PRJ-27 "Giá trị thu được (EVM) và đường S" mở được ở đường dẫn /prj/prj-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-26 "Đường cơ sở, độ lệch và số lần dời mốc" mở được ở đường dẫn /prj/prj-26, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần prj.evm.s-curve đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.evm.view-at-date đúng lúc giọng đọc nói tới
- [ ] Chú thích "Giá trị thu được chỉ từ khối lượng đã nghiệm thu" hiện từ giây 1.5, kéo dài 5 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ana-bi-dashboard`

Nền tảng: web; 12.1 giây; có trong video chính

Màn hình: `BI-01` Thư viện dashboard (/bi/bi-01); `BI-04` Trình dựng biểu đồ (/bi/bi-04)

**Lời đọc**

> Dashboard lãnh đạo chỉ dùng chỉ tiêu đã chứng nhận. Người dùng tự dựng biểu đồ từ bộ dữ liệu phân quyền theo dòng và cột, rồi lưu, chia sẻ hoặc đặt lịch gửi.

**Lời gửi cho giọng đọc (đã phiên âm)**

> đát-bo lãnh đạo chỉ dùng chỉ tiêu đã chứng nhận. Người dùng tự dựng biểu đồ từ bộ dữ liệu phân quyền theo dòng và cột, rồi lưu, chia sẻ hoặc đặt lịch gửi.

**Phụ đề**

- Dashboard lãnh đạo chỉ dùng / chỉ tiêu đã chứng nhận.
- Người dùng tự dựng biểu đồ / từ bộ dữ liệu phân quyền
- theo dòng và cột, rồi lưu, / chia sẻ hoặc đặt lịch gửi.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-01`
- `do=click ref=bi.dashboard.open-chart-builder`
- `do=choose ref=bi.chart-builder.dataset option=first`
- `do=click ref=bi.chart-builder.save`

**Cần thấy trên hình**

- [ ] Màn BI-01 "Thư viện dashboard" mở được ở đường dẫn /bi/bi-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-04 "Trình dựng biểu đồ" mở được ở đường dẫn /bi/bi-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.dashboard.open-chart-builder đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.chart-builder.save đúng lúc giọng đọc nói tới
- [ ] Chú thích "Chỉ tiêu đã chứng nhận · phân quyền dòng và cột" hiện từ giây 2, kéo dài 5 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ana-gap`

Nền tảng: web; 17 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-30` Chênh lệch giá trúng thầu và giá hợp đồng (/ctr/ctr-30)

**Lời đọc**

> Báo cáo chênh lệch giá cho thấy giá trúng thầu so với giá hợp đồng ở từng gói. Chênh lệch bình quân toàn danh mục là {{figure:price-gap-pct}}. Báo cáo cũng ghi tăng trưởng của các thay đổi so với giá gốc, theo từng tầng phê duyệt.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Báo cáo chênh lệch giá cho thấy giá trúng thầu so với giá hợp đồng ở từng gói. Chênh lệch bình quân toàn danh mục là {{figure:price-gap-pct}}. Báo cáo cũng ghi tăng trưởng của các thay đổi so với giá gốc, theo từng tầng phê duyệt.

**Phụ đề**

- Báo cáo chênh lệch giá cho thấy giá trúng / thầu so với giá hợp đồng ở từng gói.
- Chênh lệch bình quân toàn danh mục là {n}.
- Báo cáo cũng ghi tăng / trưởng của các thay đổi
- so với giá gốc, theo từng tầng phê duyệt.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=CTR-30`
- `do=spot ref=ctr.price-gap.table`
- `do=click ref=ctr.price-gap.sort-by-gap`

**Cần thấy trên hình**

- [ ] Màn CTR-30 "Chênh lệch giá trúng thầu và giá hợp đồng" mở được ở đường dẫn /ctr/ctr-30, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ctr.price-gap.table đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.price-gap.sort-by-gap đúng lúc giọng đọc nói tới
- [ ] Con số price-gap-pct đọc từ dữ liệu thật qua getContractReport (rows[code=PRICE_GAP].summary.average_gap_pct); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ana-bi-datasets`

Nền tảng: web; 16.6 giây; chỉ trong chương cắt riêng

Màn hình: `BI-18` Bộ dữ liệu và ảnh chụp kỳ (/bi/bi-18); `BI-19` Chứng nhận chỉ tiêu và bộ dữ liệu (/bi/bi-19)

**Lời đọc**

> Mỗi bộ dữ liệu có trạng thái: nháp, đã xác nhận, đã chứng nhận hoặc lỗi thời. Dashboard lãnh đạo chỉ đọc bộ dữ liệu đã chứng nhận. Khi dữ liệu quá hạn làm mới, chữ số liệu cũ tự hiện, kèm giờ cập nhật tốt gần nhất.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi bộ dữ liệu có trạng thái: nháp, đã xác nhận, đã chứng nhận hoặc lỗi thời. đát-bo lãnh đạo chỉ đọc bộ dữ liệu đã chứng nhận. Khi dữ liệu quá hạn làm mới, chữ số liệu cũ tự hiện, kèm giờ cập nhật tốt gần nhất.

**Phụ đề**

- Mỗi bộ dữ liệu có trạng thái: nháp, đã / xác nhận, đã chứng nhận hoặc lỗi thời.
- Dashboard lãnh đạo chỉ đọc / bộ dữ liệu đã chứng nhận.
- Khi dữ liệu quá hạn làm mới, chữ số liệu / cũ tự hiện, kèm giờ cập nhật tốt gần nhất.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-18`
- `do=spot ref=bi.datasets.state-column`
- `do=click ref=bi.datasets.certify-button`

**Cần thấy trên hình**

- [ ] Màn BI-18 "Bộ dữ liệu và ảnh chụp kỳ" mở được ở đường dẫn /bi/bi-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-19 "Chứng nhận chỉ tiêu và bộ dữ liệu" mở được ở đường dẫn /bi/bi-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.datasets.state-column đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.datasets.certify-button đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ana-bi-schedule`

Nền tảng: web; 16.6 giây; chỉ trong chương cắt riêng

Màn hình: `BI-12` Lịch xuất và phân phối (/bi/bi-12); `BI-16` Xuất dữ liệu và phạm vi (/bi/bi-16)

**Lời đọc**

> Lịch xuất và phân phối cho phép gửi một báo cáo đúng giờ tới đúng người. Tệp xuất giữ phạm vi quyền của người nhận, ghi băm của tệp và nhật ký mỗi lần gửi. Người không đủ quyền không nhận được dòng nào ngoài phạm vi của mình.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Lịch xuất và phân phối cho phép gửi một báo cáo đúng giờ tới đúng người. Tệp xuất giữ phạm vi quyền của người nhận, ghi băm của tệp và nhật ký mỗi lần gửi. Người không đủ quyền không nhận được dòng nào ngoài phạm vi của mình.

**Phụ đề**

- Lịch xuất và phân phối cho phép gửi / một báo cáo đúng giờ tới đúng người.
- Tệp xuất giữ phạm vi quyền của người nhận, / ghi băm của tệp và nhật ký mỗi lần gửi.
- Người không đủ quyền không nhận được / dòng nào ngoài phạm vi của mình.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-12`
- `do=click ref=bi.schedule.new`
- `do=spot ref=bi.schedule.recipients-scope`

**Cần thấy trên hình**

- [ ] Màn BI-12 "Lịch xuất và phân phối" mở được ở đường dẫn /bi/bi-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-16 "Xuất dữ liệu và phạm vi" mở được ở đường dẫn /bi/bi-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.schedule.new đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.schedule.recipients-scope đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ana-bi-publication`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `BI-11` Phê duyệt công bố (/bi/bi-11); `BI-10` So sánh phiên bản dashboard (/bi/bi-10)

**Lời đọc**

> Dashboard muốn công bố rộng phải qua phê duyệt: người lập khác người duyệt, mỗi phiên bản được so sánh với bản trước. Bản đã công bố không sửa trực tiếp, mọi thay đổi là một phiên bản mới có lý do.

**Lời gửi cho giọng đọc (đã phiên âm)**

> đát-bo muốn công bố rộng phải qua phê duyệt: người lập khác người duyệt, mỗi phiên bản được so sánh với bản trước. Bản đã công bố không sửa trực tiếp, mọi thay đổi là một phiên bản mới có lý do.

**Phụ đề**

- Dashboard muốn công bố rộng / phải qua phê duyệt: người lập
- khác người duyệt, mỗi phiên / bản được so sánh với bản trước.
- Bản đã công bố không sửa trực tiếp, mọi / thay đổi là một phiên bản mới có lý do.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-11`
- `do=click ref=bi.publication.compare-versions`

**Cần thấy trên hình**

- [ ] Màn BI-11 "Phê duyệt công bố" mở được ở đường dẫn /bi/bi-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-10 "So sánh phiên bản dashboard" mở được ở đường dẫn /bi/bi-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.publication.compare-versions đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ana-lineage`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `BI-14` Lineage và chất lượng dữ liệu (/bi/bi-14); `DGV-05` Lineage toàn hệ thống (/dgv/dgv-05)

**Lời đọc**

> Từ một chỉ tiêu, người kiểm tra lần ngược về bộ dữ liệu, bảng nguồn và mô-đun sinh ra nó. Điểm chất lượng dữ liệu theo từng mô-đun và đơn vị nằm cùng màn hình, nên biết ngay con số nào đáng tin đến đâu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Từ một chỉ tiêu, người kiểm tra lần ngược về bộ dữ liệu, bảng nguồn và mô-đun sinh ra nó. Điểm chất lượng dữ liệu theo từng mô-đun và đơn vị nằm cùng màn hình, nên biết ngay con số nào đáng tin đến đâu.

**Phụ đề**

- Từ một chỉ tiêu, người / kiểm tra lần ngược về
- bộ dữ liệu, bảng nguồn / và mô-đun sinh ra nó.
- Điểm chất lượng dữ liệu theo / từng mô-đun và đơn vị nằm
- cùng màn hình, nên biết ngay / con số nào đáng tin đến đâu.

**Các bước quay**

- `do=as persona=dgvSteward`
- `do=open screen=BI-14`
- `do=click ref=bi.lineage.trace-metric`

**Cần thấy trên hình**

- [ ] Màn BI-14 "Lineage và chất lượng dữ liệu" mở được ở đường dẫn /bi/bi-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DGV-05 "Lineage toàn hệ thống" mở được ở đường dẫn /dgv/dgv-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản dgvSteward
- [ ] Khung vào phần bi.lineage.trace-metric đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Cảnh báo (`alerts`)

### `al-bell`

Nền tảng: web; 13.6 giây; có trong video chính

Màn hình: `HOME-01` Tổng quan điều hành (/home/home-01); `HOME-02` Việc của tôi (/home/home-02)

**Lời đọc**

> Chuông Cần xử lý gom mọi việc vào một ngăn kéo, theo ba mức: Khẩn, Cần xử lý, Theo dõi. Hôm nay có {{figure:alerts-urgent}} mục Khẩn, {{figure:alerts-action}} Cần xử lý, {{figure:alerts-watch}} Theo dõi, mỗi mục nói rõ hậu quả.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chuông Cần xử lý gom mọi việc vào một ngăn kéo, theo ba mức: Khẩn, Cần xử lý, Theo dõi. Hôm nay có {{figure:alerts-urgent}} mục Khẩn, {{figure:alerts-action}} Cần xử lý, {{figure:alerts-watch}} Theo dõi, mỗi mục nói rõ hậu quả.

**Phụ đề**

- Chuông Cần xử lý gom mọi / việc vào một ngăn kéo,
- theo ba mức: Khẩn, Cần xử lý, Theo dõi.
- Hôm nay có {n} mục Khẩn, {n} Cần xử lý, / {n} Theo dõi, mỗi mục nói rõ hậu quả.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=HOME-01`
- `do=click ref=shell.alert-bell`
- `do=spot ref=alerts.drawer.consequence-line`

**Cần thấy trên hình**

- [ ] Màn HOME-01 "Tổng quan điều hành" mở được ở đường dẫn /home/home-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn HOME-02 "Việc của tôi" mở được ở đường dẫn /home/home-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần shell.alert-bell đúng lúc giọng đọc nói tới
- [ ] Khung vào phần alerts.drawer.consequence-line đúng lúc giọng đọc nói tới
- [ ] Chú thích "Khẩn · Cần xử lý · Theo dõi" hiện từ giây 2, kéo dài 5 giây
- [ ] Con số alerts-urgent đọc từ dữ liệu thật qua getMyWorkCounts (counts.urgent); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số alerts-action đọc từ dữ liệu thật qua getMyWorkCounts (counts.action); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số alerts-watch đọc từ dữ liệu thật qua getMyWorkCounts (counts.watch); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-actions`

Nền tảng: web; 13.7 giây; có trong video chính

Màn hình: `HOME-02` Việc của tôi (/home/home-02)

**Lời đọc**

> Người nhận có thể nhận việc, giao cho người khác hoặc hoãn. Hoãn phải có lý do và có trần số ngày. Mục Khẩn thì máy chủ từ chối hoãn. Mọi thao tác ghi nhật ký kiểm toán.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Người nhận có thể nhận việc, giao cho người khác hoặc hoãn. Hoãn phải có lý do và có trần số ngày. Mục Khẩn thì máy chủ từ chối hoãn. Mọi thao tác ghi nhật ký kiểm toán.

**Phụ đề**

- Người nhận có thể nhận việc, / giao cho người khác hoặc hoãn.
- Hoãn phải có lý do và có trần số ngày.
- Mục Khẩn thì máy chủ từ chối hoãn.
- Mọi thao tác ghi nhật ký kiểm toán.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=HOME-02`
- `do=click ref=alerts.item.claim`
- `do=click ref=alerts.item.snooze`
- `do=type ref=alerts.snooze.reason textKey=snooze.reason`
- `do=command operation=snoozeWork as=projectManager`

**Cần thấy trên hình**

- [ ] Màn HOME-02 "Việc của tôi" mở được ở đường dẫn /home/home-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần alerts.item.claim đúng lúc giọng đọc nói tới
- [ ] Khung vào phần alerts.item.snooze đúng lúc giọng đọc nói tới
- [ ] Chạy thao tác thật snoozeWork bằng tài khoản projectManager
- [ ] Chú thích "Hoãn phải có lý do và có trần" hiện từ giây 3, kéo dài 5 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-escalation`

Nền tảng: web; 12.1 giây; có trong video chính

Màn hình: `HOME-06` Hồ sơ cảnh báo (/home/home-06)

**Lời đọc**

> Cảnh báo không bao giờ mồ côi. Người nhận im lặng quá hạn thì việc tự leo lên cấp trên. Người đi vắng ủy quyền, và hệ thống kiểm tra độ phủ ủy quyền.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cảnh báo không bao giờ mồ côi. Người nhận im lặng quá hạn thì việc tự leo lên cấp trên. Người đi vắng ủy quyền, và hệ thống kiểm tra độ phủ ủy quyền.

**Phụ đề**

- Cảnh báo không bao giờ mồ côi.
- Người nhận im lặng quá hạn / thì việc tự leo lên cấp trên.
- Người đi vắng ủy quyền, và hệ / thống kiểm tra độ phủ ủy quyền.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=HOME-06`
- `do=spot ref=alerts.record.escalation-trail`

**Cần thấy trên hình**

- [ ] Màn HOME-06 "Hồ sơ cảnh báo" mở được ở đường dẫn /home/home-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần alerts.record.escalation-trail đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-health`

Nền tảng: web; 12.4 giây; có trong video chính

Màn hình: `HOME-13` Sức khỏe hệ thống cảnh báo (/home/home-13)

**Lời đọc**

> Chính hệ thống cảnh báo cũng được đo. Trang sức khỏe theo dõi 14 chỉ số, như thời gian nhận, thời gian xử lý, tỷ lệ đúng hạn, leo thang và cảnh báo mồ côi.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chính hệ thống cảnh báo cũng được đo. Trang sức khỏe theo dõi 14 chỉ số, như thời gian nhận, thời gian xử lý, tỷ lệ đúng hạn, leo thang và cảnh báo mồ côi.

**Phụ đề**

- Chính hệ thống cảnh báo cũng được đo.
- Trang sức khỏe theo dõi 14 / chỉ số, như thời gian nhận,
- thời gian xử lý, tỷ lệ đúng hạn, / leo thang và cảnh báo mồ côi.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=HOME-13`
- `do=spot ref=alerts.health.kpi-grid`

**Cần thấy trên hình**

- [ ] Màn HOME-13 "Sức khỏe hệ thống cảnh báo" mở được ở đường dẫn /home/home-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần alerts.health.kpi-grid đúng lúc giọng đọc nói tới
- [ ] Chú thích "14 chỉ số sức khỏe hệ thống cảnh báo" hiện từ giây 2, kéo dài 5 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-clocks`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `HOME-06` Hồ sơ cảnh báo (/home/home-06)

**Lời đọc**

> Mỗi cảnh báo chạy hai đồng hồ: từ lúc đến tới lúc nhận, và từ lúc đến tới lúc xử lý. Đã nhận mà im lặng thì chuyển sang trạng thái cần nhận lại. Tạm dừng đồng hồ phải có lý do và người cho phép.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi cảnh báo chạy hai đồng hồ: từ lúc đến tới lúc nhận, và từ lúc đến tới lúc xử lý. Đã nhận mà im lặng thì chuyển sang trạng thái cần nhận lại. Tạm dừng đồng hồ phải có lý do và người cho phép.

**Phụ đề**

- Mỗi cảnh báo chạy hai đồng hồ: từ lúc đến / tới lúc nhận, và từ lúc đến tới lúc xử lý.
- Đã nhận mà im lặng thì chuyển / sang trạng thái cần nhận lại.
- Tạm dừng đồng hồ phải có / lý do và người cho phép.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=HOME-06`
- `do=spot ref=alerts.record.two-clocks`
- `do=click ref=alerts.record.pause-clock`

**Cần thấy trên hình**

- [ ] Màn HOME-06 "Hồ sơ cảnh báo" mở được ở đường dẫn /home/home-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần alerts.record.two-clocks đúng lúc giọng đọc nói tới
- [ ] Khung vào phần alerts.record.pause-clock đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-types`

Nền tảng: web; 16.6 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-23` Sổ loại cảnh báo (/adm/adm-23); `ADM-19` Kho quy tắc quản trị (/adm/adm-19)

**Lời đọc**

> Sổ loại cảnh báo là nơi duy nhất sinh ra cảnh báo. Mỗi loại ghi chủ sở hữu, hành động mong đợi, hậu quả, thời hạn đáp ứng, lý do tồn tại và ngày xét lại. Loại nào thiếu một trong các mục đó thì không được đăng ký.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sổ loại cảnh báo là nơi duy nhất sinh ra cảnh báo. Mỗi loại ghi chủ sở hữu, hành động mong đợi, hậu quả, thời hạn đáp ứng, lý do tồn tại và ngày xét lại. Loại nào thiếu một trong các mục đó thì không được đăng ký.

**Phụ đề**

- Sổ loại cảnh báo là nơi / duy nhất sinh ra cảnh báo.
- Mỗi loại ghi chủ sở hữu, / hành động mong đợi, hậu quả,
- thời hạn đáp ứng, lý do / tồn tại và ngày xét lại.
- Loại nào thiếu một trong các / mục đó thì không được đăng ký.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=ADM-23`
- `do=click ref=adm.alert-types.first-row`
- `do=spot ref=adm.alert-types.required-fields`

**Cần thấy trên hình**

- [ ] Màn ADM-23 "Sổ loại cảnh báo" mở được ở đường dẫn /adm/adm-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-19 "Kho quy tắc quản trị" mở được ở đường dẫn /adm/adm-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần adm.alert-types.first-row đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.alert-types.required-fields đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-channels`

Nền tảng: web; 18.2 giây; chỉ trong chương cắt riêng

Màn hình: `NOT-03` Tùy chọn nhận tin (/not/not-03); `NOT-12` Chi tiết hành trình gửi (/not/not-12)

**Lời đọc**

> Thông báo đi theo thang kênh: trong ứng dụng, đẩy lên điện thoại, rồi tin nhắn hoặc Zalo. Mỗi lần gửi có biên nhận giao nhận. Giờ yên tĩnh được tôn trọng, trừ mục Khẩn quá hạn nhận. Nội dung đẩy không chứa số tiền hay tên người, chỉ có đường dẫn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Thông báo đi theo thang kênh: trong ứng dụng, đẩy lên điện thoại, rồi tin nhắn hoặc da-lô. Mỗi lần gửi có biên nhận giao nhận. Giờ yên tĩnh được tôn trọng, trừ mục Khẩn quá hạn nhận. Nội dung đẩy không chứa số tiền hay tên người, chỉ có đường dẫn.

**Phụ đề**

- Thông báo đi theo thang / kênh: trong ứng dụng,
- đẩy lên điện thoại, / rồi tin nhắn hoặc Zalo.
- Mỗi lần gửi có biên nhận giao nhận.
- Giờ yên tĩnh được tôn trọng, / trừ mục Khẩn quá hạn nhận.
- Nội dung đẩy không chứa số tiền / hay tên người, chỉ có đường dẫn.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=NOT-03`
- `do=spot ref=not.preferences.quiet-hours`
- `do=open screen=NOT-12`
- `do=spot ref=not.journey.delivery-receipts`

**Cần thấy trên hình**

- [ ] Màn NOT-03 "Tùy chọn nhận tin" mở được ở đường dẫn /not/not-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn NOT-12 "Chi tiết hành trình gửi" mở được ở đường dẫn /not/not-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần not.preferences.quiet-hours đúng lúc giọng đọc nói tới
- [ ] Khung vào phần not.journey.delivery-receipts đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-feedback`

Nền tảng: web; 16.3 giây; chỉ trong chương cắt riêng

Màn hình: `HOME-06` Hồ sơ cảnh báo (/home/home-06)

**Lời đọc**

> Khi một cảnh báo không đúng, người nhận bấm nút cảnh báo này không đúng và chọn lý do. Phản hồi đi vào hàng đợi của chủ loại cảnh báo để chỉnh quy tắc. Nhờ vậy cảnh báo ngày càng ít nhiễu mà không bỏ sót việc thật.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Khi một cảnh báo không đúng, người nhận bấm nút cảnh báo này không đúng và chọn lý do. Phản hồi đi vào hàng đợi của chủ loại cảnh báo để chỉnh quy tắc. Nhờ vậy cảnh báo ngày càng ít nhiễu mà không bỏ sót việc thật.

**Phụ đề**

- Khi một cảnh báo không / đúng, người nhận bấm
- nút cảnh báo này không đúng và chọn lý do.
- Phản hồi đi vào hàng đợi của chủ / loại cảnh báo để chỉnh quy tắc.
- Nhờ vậy cảnh báo ngày càng ít / nhiễu mà không bỏ sót việc thật.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=HOME-06`
- `do=click ref=alerts.record.report-wrong`
- `do=choose ref=alerts.record.wrong-reason option=first`

**Cần thấy trên hình**

- [ ] Màn HOME-06 "Hồ sơ cảnh báo" mở được ở đường dẫn /home/home-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần alerts.record.report-wrong đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Quản lý nhà thầu và nhà cung cấp (`contractors`)

### `vnd-registry`

Nền tảng: web; 14.2 giây; có trong video chính

Màn hình: `BID-01` Danh sách nhà thầu (/bid/bid-01); `BID-02` Hồ sơ nhà thầu (/bid/bid-02); `VND-04` Tài khoản nhận tiền của nhà thầu (/vnd/vnd-04)

**Lời đọc**

> Mỗi nhà thầu có một hồ sơ chủ: kiểm mã số thuế, gợi ý hợp nhất hồ sơ trùng. Tài khoản nhận tiền cần hai người duyệt và gọi xác nhận lại. Tài khoản chưa hiệu lực thì chặn thanh toán.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi nhà thầu có một hồ sơ chủ: kiểm mã số thuế, gợi ý hợp nhất hồ sơ trùng. Tài khoản nhận tiền cần hai người duyệt và gọi xác nhận lại. Tài khoản chưa hiệu lực thì chặn thanh toán.

**Phụ đề**

- Mỗi nhà thầu có một hồ sơ chủ: kiểm mã / số thuế, gợi ý hợp nhất hồ sơ trùng.
- Tài khoản nhận tiền cần hai / người duyệt và gọi xác nhận lại.
- Tài khoản chưa hiệu lực / thì chặn thanh toán.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=BID-01`
- `do=click ref=bid.contractors.first-row`
- `do=spot ref=bid.contractor.master-profile`
- `do=open screen=VND-04`
- `do=spot ref=vnd.bank-accounts.two-approvers`

**Cần thấy trên hình**

- [ ] Màn BID-01 "Danh sách nhà thầu" mở được ở đường dẫn /bid/bid-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-02 "Hồ sơ nhà thầu" mở được ở đường dẫn /bid/bid-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-04 "Tài khoản nhận tiền của nhà thầu" mở được ở đường dẫn /vnd/vnd-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần bid.contractors.first-row đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.contractor.master-profile đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.bank-accounts.two-approvers đúng lúc giọng đọc nói tới
- [ ] Chú thích "Một hồ sơ chủ · tài khoản nhận tiền hai người duyệt" hiện từ giây 2, kéo dài 6 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd-restrictions`

Nền tảng: web; 13.3 giây; có trong video chính

Màn hình: `BID-21` Hạn chế tham gia lựa chọn nhà thầu (/bid/bid-21)

**Lời đọc**

> Hạn chế tham gia đấu thầu đi đủ thủ tục: đề nghị, thông báo, phản hồi, quyết định, hiệu lực. Có hiệu lực thì chặn cả liên danh ở khâu dự thầu, hợp đồng, thầu phụ và thanh toán.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hạn chế tham gia đấu thầu đi đủ thủ tục: đề nghị, thông báo, phản hồi, quyết định, hiệu lực. Có hiệu lực thì chặn cả liên danh ở khâu dự thầu, hợp đồng, thầu phụ và thanh toán.

**Phụ đề**

- Hạn chế tham gia đấu thầu / đi đủ thủ tục: đề nghị,
- thông báo, phản hồi, quyết định, hiệu lực.
- Có hiệu lực thì chặn cả liên danh ở khâu / dự thầu, hợp đồng, thầu phụ và thanh toán.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=BID-21`
- `do=click ref=bid.restrictions.new`
- `do=type ref=bid.restrictions.reason textKey=restriction.reason`
- `do=command operation=recordContractorRestriction as=bidManager`

**Cần thấy trên hình**

- [ ] Màn BID-21 "Hạn chế tham gia lựa chọn nhà thầu" mở được ở đường dẫn /bid/bid-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần bid.restrictions.new đúng lúc giọng đọc nói tới
- [ ] Chạy thao tác thật recordContractorRestriction bằng tài khoản bidManager
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd-scorecard`

Nền tảng: web; 12.7 giây; có trong video chính

Màn hình: `CTR-23` Bảng điểm nhà thầu và nhật ký vi phạm (/ctr/ctr-23)

**Lời đọc**

> Bảng điểm chấm năm tiêu chí theo trọng số của quy tắc. Người chấm khác người duyệt. Vi phạm do một người ghi, người khác xác nhận, và hình phạt phải có văn bản quyết định.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bảng điểm chấm năm tiêu chí theo trọng số của quy tắc. Người chấm khác người duyệt. Vi phạm do một người ghi, người khác xác nhận, và hình phạt phải có văn bản quyết định.

**Phụ đề**

- Bảng điểm chấm năm tiêu chí / theo trọng số của quy tắc.
- Người chấm khác người duyệt.
- Vi phạm do một người / ghi, người khác xác nhận,
- và hình phạt phải có văn bản quyết định.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=CTR-23`
- `do=choose ref=ctr.scorecard.contractor option=Công ty Cổ phần Xây dựng Giao thông Cao Bằng`
- `do=click ref=ctr.scorecard.view`
- `do=command operation=evaluateContractor as=ctrOfficer`
- `do=as persona=owner`
- `do=command operation=approveContractorEvaluation as=paymentApprover`

**Cần thấy trên hình**

- [ ] Màn CTR-23 "Bảng điểm nhà thầu và nhật ký vi phạm" mở được ở đường dẫn /ctr/ctr-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ctr.scorecard.view đúng lúc giọng đọc nói tới
- [ ] Chạy thao tác thật evaluateContractor bằng tài khoản ctrOfficer
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Chạy thao tác thật approveContractorEvaluation bằng tài khoản paymentApprover
- [ ] Chú thích "Người chấm ≠ người duyệt" hiện từ giây 3, kéo dài 5 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd-concentration`

Nền tảng: web; 18.1 giây; có trong video chính

Màn hình: `CTR-31` Tập trung và tải của nhà thầu (/ctr/ctr-31)

**Lời đọc**

> Chỉ số tập trung HHI là {{figure:hhi}} trên thang không đến mười nghìn, năm nhà thầu lớn nhất giữ {{figure:top5-share}} giá trị, gói chỉ một nhà thầu chiếm {{figure:single-bid-rate}}. Giá trị liên danh chia theo phần góp.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chỉ số tập trung hát-hát-ai là {{figure:hhi}} trên thang không đến mười nghìn, năm nhà thầu lớn nhất giữ {{figure:top5-share}} giá trị, gói chỉ một nhà thầu chiếm {{figure:single-bid-rate}}. Giá trị liên danh chia theo phần góp.

**Phụ đề**

- Chỉ số tập trung HHI là {n} / trên thang không đến mười nghìn,
- năm nhà thầu lớn nhất giữ {n} giá
- trị, gói chỉ một nhà thầu chiếm {n}.
- Giá trị liên danh chia theo phần góp.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=CTR-31`
- `do=spot ref=ctr.concentration.hhi-tile`
- `do=click ref=ctr.concentration.top5-table`

**Cần thấy trên hình**

- [ ] Màn CTR-31 "Tập trung và tải của nhà thầu" mở được ở đường dẫn /ctr/ctr-31, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ctr.concentration.hhi-tile đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.concentration.top5-table đúng lúc giọng đọc nói tới
- [ ] Con số hhi đọc từ dữ liệu thật qua getContractReport (rows[code=CONCENTRATION].summary.hhi); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số top5-share đọc từ dữ liệu thật qua getContractReport (rows[code=CONCENTRATION].summary.top5_share_pct); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số single-bid-rate đọc từ dữ liệu thật qua getContractReport (rows[code=CONCENTRATION].summary.single_bidder_pct); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd-egp-link`

Nền tảng: web; 21.9 giây; chỉ trong chương cắt riêng

Màn hình: `BID-22` Kết nối hệ thống mạng đấu thầu quốc gia (/bid/bid-22); `BID-24` Các lần nhập tệp từ hệ thống mạng đấu thầu quốc gia (/bid/bid-24)

**Lời đọc**

> Quản lý nhà thầu nối với mạng đấu thầu quốc gia qua nhập và xuất tệp. Hệ thống nhận danh sách hạn chế và đăng tải đánh giá thực hiện hợp đồng trong thời hạn. Từng trường giữa số của mình và số trên mạng được đối chiếu. Hệ thống không quét trang web. Mẫu tệp là giả định, chờ đặc tả chính thức.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Quản lý nhà thầu nối với mạng đấu thầu quốc gia qua nhập và xuất tệp. Hệ thống nhận danh sách hạn chế và đăng tải đánh giá thực hiện hợp đồng trong thời hạn. Từng trường giữa số của mình và số trên mạng được đối chiếu. Hệ thống không quét trang quép. Mẫu tệp là giả định, chờ đặc tả chính thức.

**Phụ đề**

- Quản lý nhà thầu nối với mạng đấu / thầu quốc gia qua nhập và xuất tệp.
- Hệ thống nhận danh sách / hạn chế và đăng tải
- đánh giá thực hiện hợp / đồng trong thời hạn.
- Từng trường giữa số của mình / và số trên mạng được đối chiếu.
- Hệ thống không quét trang web.
- Mẫu tệp là giả định, / chờ đặc tả chính thức.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=BID-22`
- `do=spot ref=bid.egp.connection-card`

**Cần thấy trên hình**

- [ ] Màn BID-22 "Kết nối hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-24 "Các lần nhập tệp từ hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần bid.egp.connection-card đúng lúc giọng đọc nói tới
- [ ] Chú thích "Chỉ nhập và xuất tệp, không quét trang web" hiện từ giây 3, kéo dài 5 giây
- [ ] Chú thích "Mẫu tệp là giả định, chờ đặc tả chính thức" hiện từ giây 9, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Mẫu tệp là giả định, chờ đặc tả chính thức"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd-redflag`

Nền tảng: web; 20 giây; chỉ trong chương cắt riêng

Màn hình: `AUD-14` Tín hiệu rủi ro mua sắm (red flag) (/aud/aud-14)

**Lời đọc**

> Cho kiểm toán, hệ thống tính 12 chỉ báo đáng ngờ trong mua sắm từ dữ liệu có sẵn. Ví dụ chỉ một nhà thầu tham gia hay một nhà thầu thắng lặp lại. Chỉ kiểm toán viên mới xem được. Xếp hạng chỉ để điều tra, không phải kết luận, và người liên quan bị chặn xem.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cho kiểm toán, hệ thống tính 12 chỉ báo đáng ngờ trong mua sắm từ dữ liệu có sẵn. Ví dụ chỉ một nhà thầu tham gia hay một nhà thầu thắng lặp lại. Chỉ kiểm toán viên mới xem được. Xếp hạng chỉ để điều tra, không phải kết luận, và người liên quan bị chặn xem.

**Phụ đề**

- Cho kiểm toán, hệ thống tính 12 chỉ báo / đáng ngờ trong mua sắm từ dữ liệu có sẵn.
- Ví dụ chỉ một nhà thầu tham gia / hay một nhà thầu thắng lặp lại.
- Chỉ kiểm toán viên mới xem được.
- Xếp hạng chỉ để điều tra, không phải kết / luận, và người liên quan bị chặn xem.

**Các bước quay**

- `do=as persona=auditor`
- `do=open screen=AUD-14`
- `do=spot ref=aud.red-flags.indicator-list`

**Cần thấy trên hình**

- [ ] Màn AUD-14 "Tín hiệu rủi ro mua sắm (red flag)" mở được ở đường dẫn /aud/aud-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản auditor
- [ ] Khung vào phần aud.red-flags.indicator-list đúng lúc giọng đọc nói tới
- [ ] Chú thích "Tín hiệu để điều tra, không phải kết luận" hiện từ giây 3, kéo dài 5 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd-portal`

Nền tảng: web; 15.4 giây; chỉ trong chương cắt riêng

Màn hình: `VND-16` Cổng nhà thầu: hồ sơ của tôi (/vnd/vnd-16)

**Lời đọc**

> Nhà thầu có cổng riêng: xem hồ sơ và đánh giá của chính mình, phản hồi trong thời hạn, tải chứng chỉ mới và tái xác nhận hằng năm. Nhà thầu không thấy chỉ báo đáng ngờ và không thấy dữ liệu của nhà thầu khác.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Nhà thầu có cổng riêng: xem hồ sơ và đánh giá của chính mình, phản hồi trong thời hạn, tải chứng chỉ mới và tái xác nhận hằng năm. Nhà thầu không thấy chỉ báo đáng ngờ và không thấy dữ liệu của nhà thầu khác.

**Phụ đề**

- Nhà thầu có cổng riêng: xem hồ / sơ và đánh giá của chính mình,
- phản hồi trong thời hạn, tải chứng / chỉ mới và tái xác nhận hằng năm.
- Nhà thầu không thấy chỉ báo đáng ngờ và / không thấy dữ liệu của nhà thầu khác.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=VND-16`
- `do=spot ref=vnd.portal.my-evaluations`

**Cần thấy trên hình**

- [ ] Màn VND-16 "Cổng nhà thầu: hồ sơ của tôi" mở được ở đường dẫn /vnd/vnd-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần vnd.portal.my-evaluations đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd-subcontract`

Nền tảng: web; 13.3 giây; chỉ trong chương cắt riêng

Màn hình: `VND-10` Nhà thầu phụ của hợp đồng (/vnd/vnd-10); `CTR-25` Thành viên liên danh và phạm vi (/ctr/ctr-25)

**Lời đọc**

> Nhà thầu phụ được đăng ký trên hợp đồng, và nhà thầu chính phải xác nhận đã trả tiền cho thầu phụ. Chứng chỉ và nhân sự chủ chốt có hạn, hết hạn thì cảnh báo tới đúng người.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Nhà thầu phụ được đăng ký trên hợp đồng, và nhà thầu chính phải xác nhận đã trả tiền cho thầu phụ. Chứng chỉ và nhân sự chủ chốt có hạn, hết hạn thì cảnh báo tới đúng người.

**Phụ đề**

- Nhà thầu phụ được đăng ký trên hợp đồng,
- và nhà thầu chính phải xác / nhận đã trả tiền cho thầu phụ.
- Chứng chỉ và nhân sự chủ chốt có hạn, / hết hạn thì cảnh báo tới đúng người.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=VND-10`
- `do=spot ref=vnd.subcontracts.paid-confirmation`

**Cần thấy trên hình**

- [ ] Màn VND-10 "Nhà thầu phụ của hợp đồng" mở được ở đường dẫn /vnd/vnd-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-25 "Thành viên liên danh và phạm vi" mở được ở đường dẫn /ctr/ctr-25, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần vnd.subcontracts.paid-confirmation đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd-bonds`

Nền tảng: web; 17.3 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-05` Bảo lãnh và bảo hiểm (/ctr/ctr-05); `VND-08` Tài chính và tải của nhà thầu (/vnd/vnd-08)

**Lời đọc**

> Bảo lãnh dự thầu, bảo lãnh thực hiện và bảo lãnh tạm ứng được theo dõi đến ngày hết hạn. Khi nhà thầu vi phạm, việc tịch thu bảo đảm đi theo quyết định có người duyệt. Tải đồng thời của từng nhà thầu hiện ngay để tránh giao quá sức.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bảo lãnh dự thầu, bảo lãnh thực hiện và bảo lãnh tạm ứng được theo dõi đến ngày hết hạn. Khi nhà thầu vi phạm, việc tịch thu bảo đảm đi theo quyết định có người duyệt. Tải đồng thời của từng nhà thầu hiện ngay để tránh giao quá sức.

**Phụ đề**

- Bảo lãnh dự thầu, bảo / lãnh thực hiện và bảo
- lãnh tạm ứng được theo / dõi đến ngày hết hạn.
- Khi nhà thầu vi phạm, việc tịch thu bảo / đảm đi theo quyết định có người duyệt.
- Tải đồng thời của từng nhà thầu / hiện ngay để tránh giao quá sức.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=CTR-05`
- `do=spot ref=ctr.guarantees.expiry-column`

**Cần thấy trên hình**

- [ ] Màn CTR-05 "Bảo lãnh và bảo hiểm" mở được ở đường dẫn /ctr/ctr-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-08 "Tài chính và tải của nhà thầu" mở được ở đường dẫn /vnd/vnd-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần ctr.guarantees.expiry-column đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Quản lý kết nối muasamcong (`egp`)

### `egp-why`

Nền tảng: animatic; 17.8 giây; có trong video chính

**Lời đọc**

> Chủ đầu tư phải đăng tải kế hoạch, thông báo, kết quả, hợp đồng và đánh giá nhà thầu lên mạng đấu thầu quốc gia. Hệ thống không quét trang web, không mở kết nối ra ngoài: nhập tệp đã tải về, chuẩn bị gói cho người đăng, và quản lý cả vòng đời.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chủ đầu tư phải đăng tải kế hoạch, thông báo, kết quả, hợp đồng và đánh giá nhà thầu lên mạng đấu thầu quốc gia. Hệ thống không quét trang quép, không mở kết nối ra ngoài: nhập tệp đã tải về, chuẩn bị gói cho người đăng, và quản lý cả vòng đời.

**Phụ đề**

- Chủ đầu tư phải đăng tải kế / hoạch, thông báo, kết quả,
- hợp đồng và đánh giá nhà thầu / lên mạng đấu thầu quốc gia.
- Hệ thống không quét trang web, / không mở kết nối ra ngoài:
- nhập tệp đã tải về, chuẩn bị gói cho / người đăng, và quản lý cả vòng đời.

**Các bước quay**

- `do=animatic id=egp-obligations`

**Cần thấy trên hình**

- [ ] Hoạt cảnh egp-obligations chạy hết thời lượng của lời đọc, chữ trên hình là tiếng Việt
- [ ] Chú thích "Không quét trang web · chỉ nhập và xuất tệp" hiện từ giây 6, kéo dài 6 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `egp-connection`

Nền tảng: web; 16.7 giây; có trong video chính

Màn hình: `BID-22` Kết nối hệ thống mạng đấu thầu quốc gia (/bid/bid-22)

**Lời đọc**

> Màn kết nối cho biết trạng thái, độ mới của dữ liệu và các hạng mục còn chờ bên ngoài. Lần nhập gần nhất cách đây {{figure:egp-age-hours}} giờ. Dữ liệu quá hạn báo là cũ, không báo là không có. Mẫu tệp hiện là giả định.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Màn kết nối cho biết trạng thái, độ mới của dữ liệu và các hạng mục còn chờ bên ngoài. Lần nhập gần nhất cách đây {{figure:egp-age-hours}} giờ. Dữ liệu quá hạn báo là cũ, không báo là không có. Mẫu tệp hiện là giả định.

**Phụ đề**

- Màn kết nối cho biết / trạng thái, độ mới của
- dữ liệu và các hạng mục còn chờ bên ngoài.
- Lần nhập gần nhất cách đây {n} giờ.
- Dữ liệu quá hạn báo là / cũ, không báo là không có.
- Mẫu tệp hiện là giả định.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-22`
- `do=spot ref=bid.egp.connection-card`
- `do=spot ref=bid.egp.pending-external-list`
- `do=command operation=getEgpConnection as=bidManager`

**Cần thấy trên hình**

- [ ] Màn BID-22 "Kết nối hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.egp.connection-card đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.egp.pending-external-list đúng lúc giọng đọc nói tới
- [ ] Chạy thao tác thật getEgpConnection bằng tài khoản bidManager
- [ ] Chú thích "Mẫu tệp là giả định, chờ đặc tả chính thức" hiện từ giây 5, kéo dài 7 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Mẫu tệp là giả định, chờ đặc tả chính thức"
- [ ] Con số egp-age-hours đọc từ dữ liệu thật qua getEgpConnection (health.age_hours); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Trạng thái kết nối, độ tuổi dữ liệu và phiên bản mẫu tệp hiện cùng nhau
- [ ] Dấu mẫu tệp là giả định hiện trên hình
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `egp-import`

Nền tảng: web; 18.5 giây; có trong video chính

Màn hình: `BID-24` Các lần nhập tệp từ hệ thống mạng đấu thầu quốc gia (/bid/bid-24)

**Lời đọc**

> Nhập tệp kế hoạch, thông báo, kết quả, nhà thầu hoặc hạn chế. Chạy thử trước, chưa ghi gì: có {{figure:egp-rows-valid}} dòng hợp lệ và {{figure:egp-rows-error}} dòng lỗi, báo theo cột. Áp dụng xong, nhập lại đúng tệp đó bị từ chối. Mẫu tệp là giả định, chờ đặc tả chính thức.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Nhập tệp kế hoạch, thông báo, kết quả, nhà thầu hoặc hạn chế. Chạy thử trước, chưa ghi gì: có {{figure:egp-rows-valid}} dòng hợp lệ và {{figure:egp-rows-error}} dòng lỗi, báo theo cột. Áp dụng xong, nhập lại đúng tệp đó bị từ chối. Mẫu tệp là giả định, chờ đặc tả chính thức.

**Phụ đề**

- Nhập tệp kế hoạch, thông báo, / kết quả, nhà thầu hoặc hạn chế.
- Chạy thử trước, chưa ghi gì: có {n} dòng / hợp lệ và {n} dòng lỗi, báo theo cột.
- Áp dụng xong, nhập lại / đúng tệp đó bị từ chối.
- Mẫu tệp là giả định, / chờ đặc tả chính thức.

**Các bước quay**

- `do=open screen=BID-24`
- `do=upload operation=uploadEgpFile fixture=egp-khlcnt-sample`
- `do=click ref=bid.egp.import.dry-run`
- `do=spot ref=bid.egp.import.row-errors`
- `do=click ref=bid.egp.import.apply`
- `do=expect ref=bid.egp.import.already-applied`

**Cần thấy trên hình**

- [ ] Màn BID-24 "Các lần nhập tệp từ hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Tải tệp mẫu egp-khlcnt-sample lên thao tác uploadEgpFile
- [ ] Khung vào phần bid.egp.import.dry-run đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.egp.import.row-errors đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.egp.import.apply đúng lúc giọng đọc nói tới
- [ ] Chú thích "Mẫu tệp là giả định, chờ đặc tả chính thức" hiện từ giây 3, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Mẫu tệp là giả định, chờ đặc tả chính thức"
- [ ] Con số egp-rows-valid đọc từ dữ liệu thật qua previewEgpFile (counts.valid); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số egp-rows-error đọc từ dữ liệu thật qua previewEgpFile (counts.errors); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Kết quả chạy thử liệt kê dòng lỗi (sai mã số thuế, sai ngày, trùng) trước khi áp dụng
- [ ] Nhập lại cùng một tệp bị từ chối với thông báo rõ ràng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `egp-mapping`

Nền tảng: web; 13 giây; có trong video chính

Màn hình: `BID-23` Ánh xạ mã hệ thống mạng đấu thầu quốc gia (/bid/bid-23)

**Lời đọc**

> Ánh xạ nối mã trên mạng đấu thầu với mã nội bộ. Hệ thống đề xuất, người thứ hai duyệt. Nhà thầu chỉ ánh xạ theo mã số thuế, xung đột được nêu ra, không nối ngầm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Ánh xạ nối mã trên mạng đấu thầu với mã nội bộ. Hệ thống đề xuất, người thứ hai duyệt. Nhà thầu chỉ ánh xạ theo mã số thuế, xung đột được nêu ra, không nối ngầm.

**Phụ đề**

- Ánh xạ nối mã trên mạng / đấu thầu với mã nội bộ.
- Hệ thống đề xuất, người thứ hai duyệt.
- Nhà thầu chỉ ánh xạ theo mã số thuế, / xung đột được nêu ra, không nối ngầm.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-23`
- `do=click ref=bid.egp.mapping.first-suggestion`
- `do=as persona=auditor`
- `do=click ref=bid.egp.mapping.approve`

**Cần thấy trên hình**

- [ ] Màn BID-23 "Ánh xạ mã hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.egp.mapping.first-suggestion đúng lúc giọng đọc nói tới
- [ ] Đăng nhập bằng tài khoản auditor
- [ ] Khung vào phần bid.egp.mapping.approve đúng lúc giọng đọc nói tới
- [ ] Chú thích "Người đề xuất ≠ người duyệt" hiện từ giây 4, kéo dài 5 giây
- [ ] Một đề xuất ánh xạ chờ người duyệt thứ hai, người đề xuất không tự duyệt được
- [ ] Một xung đột ánh xạ được tô riêng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `egp-obligations`

Nền tảng: web; 12.7 giây; có trong video chính

Màn hình: `BID-32` Nghĩa vụ đăng tải lên hệ thống mạng đấu thầu quốc gia (/bid/bid-32)

**Lời đọc**

> Mỗi nghĩa vụ đăng tải có đồng hồ. Sắp hết hạn thì cảnh báo Cần xử lý, quá hạn thì Khẩn, biên nhận đóng cảnh báo. Thời hạn là cấu hình mặc định, chưa kiểm chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi nghĩa vụ đăng tải có đồng hồ. Sắp hết hạn thì cảnh báo Cần xử lý, quá hạn thì Khẩn, biên nhận đóng cảnh báo. Thời hạn là cấu hình mặc định, chưa kiểm chứng.

**Phụ đề**

- Mỗi nghĩa vụ đăng tải có đồng hồ.
- Sắp hết hạn thì cảnh báo Cần xử lý, quá / hạn thì Khẩn, biên nhận đóng cảnh báo.
- Thời hạn là cấu hình mặc / định, chưa kiểm chứng.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-32`
- `do=spot ref=bid.egp.obligations.clock-column`
- `do=click ref=bid.egp.obligations.record-receipt`

**Cần thấy trên hình**

- [ ] Màn BID-32 "Nghĩa vụ đăng tải lên hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-32, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.egp.obligations.clock-column đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.egp.obligations.record-receipt đúng lúc giọng đọc nói tới
- [ ] Chú thích "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng" hiện từ giây 5, kéo dài 7 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng"
- [ ] Đồng hồ nghĩa vụ có một dòng sắp đến hạn và một dòng quá hạn, kèm mức Khẩn hoặc Cần xử lý
- [ ] Biên nhận dùng để đóng cảnh báo
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `egp-reconcile`

Nền tảng: web; 14.2 giây; có trong video chính

Màn hình: `BID-33` Đối chiếu từng trường với hệ thống mạng đấu thầu quốc gia (/bid/bid-33)

**Lời đọc**

> Đối chiếu từng trường giữa số của mình và số trên mạng. Mỗi chênh lệch có người xử lý, không phải người lập, với bốn cách giải quyết: chấp nhận, sửa, tranh chấp có bằng chứng, hoặc miễn có hạn xét lại.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đối chiếu từng trường giữa số của mình và số trên mạng. Mỗi chênh lệch có người xử lý, không phải người lập, với bốn cách giải quyết: chấp nhận, sửa, tranh chấp có bằng chứng, hoặc miễn có hạn xét lại.

**Phụ đề**

- Đối chiếu từng trường giữa / số của mình và số trên mạng.
- Mỗi chênh lệch có người xử lý, không / phải người lập, với bốn cách giải quyết:
- chấp nhận, sửa, tranh chấp có bằng / chứng, hoặc miễn có hạn xét lại.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BID-33`
- `do=click ref=bid.egp.recon.first-item`
- `do=choose ref=bid.egp.recon.resolution option=first`

**Cần thấy trên hình**

- [ ] Màn BID-33 "Đối chiếu từng trường với hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-33, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bid.egp.recon.first-item đúng lúc giọng đọc nói tới
- [ ] Mỗi chênh lệch hiện số của mình, số trên mạng đấu thầu, người xử lý và kết quả
- [ ] Có đủ các cách giải quyết: chấp nhận, sửa, tranh chấp, miễn có hạn xét lại
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `egp-tree-evidence`

Nền tảng: web; 8.4 giây; có trong video chính

Màn hình: `BID-29` Tiến trình một gói thầu (/bid/bid-29); `BID-17` Theo dõi mời thầu và mốc lựa chọn (/bid/bid-17)

**Lời đọc**

> Mốc nhập từ mạng đấu thầu trở thành bằng chứng của bước trong cây tiến độ, và được ghi rõ là nhập từ tệp.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mốc nhập từ mạng đấu thầu trở thành bằng chứng của bước trong cây tiến độ, và được ghi rõ là nhập từ tệp.

**Phụ đề**

- Mốc nhập từ mạng đấu thầu / trở thành bằng chứng của
- bước trong cây tiến độ, và / được ghi rõ là nhập từ tệp.

**Các bước quay**

- `do=open screen=BID-29`
- `do=wait ms=4500`
- `do=spot ref=bid.package.timeline-import-entry`

**Cần thấy trên hình**

- [ ] Màn BID-29 "Tiến trình một gói thầu" mở được ở đường dẫn /bid/bid-29, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-17 "Theo dõi mời thầu và mốc lựa chọn" mở được ở đường dẫn /bid/bid-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần bid.package.timeline-import-entry đúng lúc giọng đọc nói tới
- [ ] Mốc nhập từ mạng đấu thầu hiện làm bằng chứng của một bước trong tiến trình gói thầu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `egp-file-kinds`

Nền tảng: web; 20.3 giây; chỉ trong chương cắt riêng

Màn hình: `BID-24` Các lần nhập tệp từ hệ thống mạng đấu thầu quốc gia (/bid/bid-24)

**Lời đọc**

> Có năm loại tệp: kế hoạch, thông báo mời thầu, kết quả, hồ sơ nhà thầu và danh sách hạn chế. Mỗi loại có cột bắt buộc, kiểu ngày, số tiền và mã số thuế được kiểm chặt. Số tiền viết nguyên số để không hiểu nhầm dấu phân cách, và bố cục tệp hiện là giả định có phiên bản.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Có năm loại tệp: kế hoạch, thông báo mời thầu, kết quả, hồ sơ nhà thầu và danh sách hạn chế. Mỗi loại có cột bắt buộc, kiểu ngày, số tiền và mã số thuế được kiểm chặt. Số tiền viết nguyên số để không hiểu nhầm dấu phân cách, và bố cục tệp hiện là giả định có phiên bản.

**Phụ đề**

- Có năm loại tệp: kế / hoạch, thông báo mời thầu,
- kết quả, hồ sơ nhà thầu / và danh sách hạn chế.
- Mỗi loại có cột bắt buộc, kiểu ngày, / số tiền và mã số thuế được kiểm chặt.
- Số tiền viết nguyên số để / không hiểu nhầm dấu phân cách,
- và bố cục tệp hiện là / giả định có phiên bản.

**Các bước quay**

- `do=open screen=BID-24`
- `do=choose ref=bid.egp.import.kind option=first`
- `do=spot ref=bid.egp.import.layout-version`

**Cần thấy trên hình**

- [ ] Màn BID-24 "Các lần nhập tệp từ hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần bid.egp.import.layout-version đúng lúc giọng đọc nói tới
- [ ] Chú thích "Mẫu tệp là giả định, chờ đặc tả chính thức" hiện từ giây 5, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Mẫu tệp là giả định, chờ đặc tả chính thức"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `egp-health`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `BID-22` Kết nối hệ thống mạng đấu thầu quốc gia (/bid/bid-22); `HOME-02` Việc của tôi (/home/home-02)

**Lời đọc**

> Độ mới của kết nối có bốn mức: mới, cũ dần, quá hạn và chưa nhập lần nào. Quá hạn thì sinh cảnh báo kết nối quá hạn cho người quản trị tích hợp, và số liệu dựa trên tệp ngoài phải ghi là chưa cập nhật.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Độ mới của kết nối có bốn mức: mới, cũ dần, quá hạn và chưa nhập lần nào. Quá hạn thì sinh cảnh báo kết nối quá hạn cho người quản trị tích hợp, và số liệu dựa trên tệp ngoài phải ghi là chưa cập nhật.

**Phụ đề**

- Độ mới của kết nối có bốn mức: mới, / cũ dần, quá hạn và chưa nhập lần nào.
- Quá hạn thì sinh cảnh báo kết nối / quá hạn cho người quản trị tích hợp,
- và số liệu dựa trên tệp ngoài / phải ghi là chưa cập nhật.

**Các bước quay**

- `do=open screen=BID-22`
- `do=spot ref=bid.egp.connection-freshness`

**Cần thấy trên hình**

- [ ] Màn BID-22 "Kết nối hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn HOME-02 "Việc của tôi" mở được ở đường dẫn /home/home-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần bid.egp.connection-freshness đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `egp-no-egress`

Nền tảng: animatic; 20 giây; chỉ trong chương cắt riêng

**Lời đọc**

> Cam kết không kết nối ra ngoài được chứng minh bằng kiểm thử. Mọi đường ra khỏi máy bị thay bằng bộ đếm. Hệ thống chạy toàn bộ thao tác nhập, ánh xạ, đối chiếu và đồng hồ, và kết quả là không lần thử kết nối nào. Mã nguồn cũng bị quét để không có lời gọi mạng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cam kết không kết nối ra ngoài được chứng minh bằng kiểm thử. Mọi đường ra khỏi máy bị thay bằng bộ đếm. Hệ thống chạy toàn bộ thao tác nhập, ánh xạ, đối chiếu và đồng hồ, và kết quả là không lần thử kết nối nào. Mã nguồn cũng bị quét để không có lời gọi mạng.

**Phụ đề**

- Cam kết không kết nối ra ngoài / được chứng minh bằng kiểm thử.
- Mọi đường ra khỏi máy bị thay bằng bộ đếm.
- Hệ thống chạy toàn bộ / thao tác nhập, ánh xạ,
- đối chiếu và đồng hồ, và kết quả / là không lần thử kết nối nào.
- Mã nguồn cũng bị quét để / không có lời gọi mạng.

**Các bước quay**

- `do=animatic id=egp-no-egress-proof`

**Cần thấy trên hình**

- [ ] Hoạt cảnh egp-no-egress-proof chạy hết thời lượng của lời đọc, chữ trên hình là tiếng Việt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `egp-restrictions`

Nền tảng: web; 16.9 giây; chỉ trong chương cắt riêng

Màn hình: `BID-21` Hạn chế tham gia lựa chọn nhà thầu (/bid/bid-21); `BID-24` Các lần nhập tệp từ hệ thống mạng đấu thầu quốc gia (/bid/bid-24)

**Lời đọc**

> Danh sách hạn chế nhập từ mạng không tự trở thành hạn chế pháp lý khi mẫu tệp còn là giả định. Nó thành một chênh lệch để người có thẩm quyền ghi theo quyết định, vì một hạn chế pháp lý không được ghi từ tệp chưa ai xác nhận.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Danh sách hạn chế nhập từ mạng không tự trở thành hạn chế pháp lý khi mẫu tệp còn là giả định. Nó thành một chênh lệch để người có thẩm quyền ghi theo quyết định, vì một hạn chế pháp lý không được ghi từ tệp chưa ai xác nhận.

**Phụ đề**

- Danh sách hạn chế nhập từ / mạng không tự trở thành
- hạn chế pháp lý khi mẫu / tệp còn là giả định.
- Nó thành một chênh lệch để người / có thẩm quyền ghi theo quyết định,
- vì một hạn chế pháp lý không / được ghi từ tệp chưa ai xác nhận.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-21`
- `do=spot ref=bid.restrictions.from-file-difference`

**Cần thấy trên hình**

- [ ] Màn BID-21 "Hạn chế tham gia lựa chọn nhà thầu" mở được ở đường dẫn /bid/bid-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-24 "Các lần nhập tệp từ hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.restrictions.from-file-difference đúng lúc giọng đọc nói tới
- [ ] Chú thích "Mẫu tệp là giả định, chờ đặc tả chính thức" hiện từ giây 4, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Mẫu tệp là giả định, chờ đặc tả chính thức"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Ban chỉ đạo cấp tỉnh (`province-committee`)

### `ban-roster`

Nền tảng: web; 17 giây; chỉ trong chương cắt riêng

Màn hình: `BAN-06` Danh sách Ban chỉ đạo và vị trí (/ban/ban-06)

**Lời đọc**

> Ban chỉ đạo cấp tỉnh điều hành tiến độ đầu tư công của cả tỉnh. Danh sách ghi rõ Trưởng ban, Phó ban, thành viên và thư ký, cơ quan của từng người và quyết định bổ nhiệm. Mọi thành viên chỉ đọc số liệu, không sửa số tài chính.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Ban chỉ đạo cấp tỉnh điều hành tiến độ đầu tư công của cả tỉnh. Danh sách ghi rõ Trưởng ban, Phó ban, thành viên và thư ký, cơ quan của từng người và quyết định bổ nhiệm. Mọi thành viên chỉ đọc số liệu, không sửa số tài chính.

**Phụ đề**

- Ban chỉ đạo cấp tỉnh điều hành / tiến độ đầu tư công của cả tỉnh.
- Danh sách ghi rõ Trưởng ban, / Phó ban, thành viên và thư ký,
- cơ quan của từng người / và quyết định bổ nhiệm.
- Mọi thành viên chỉ đọc số / liệu, không sửa số tài chính.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BAN-06`
- `do=spot ref=ban.roster.members`

**Cần thấy trên hình**

- [ ] Màn BAN-06 "Danh sách Ban chỉ đạo và vị trí" mở được ở đường dẫn /ban/ban-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ban.roster.members đúng lúc giọng đọc nói tới
- [ ] Chú thích "Trưởng ban, Phó ban, thành viên, thư ký" hiện từ giây 3, kéo dài 5 giây
- [ ] Danh sách có đủ bốn vị trí Trưởng ban, Phó ban, thành viên, thư ký, kèm cơ quan của từng người và quyết định bổ nhiệm
- [ ] Tài khoản đang đăng nhập là Trưởng ban và màn hình không có nút sửa số tài chính
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ban-dashboard`

Nền tảng: web; 19.4 giây; có trong video chính

Màn hình: `BAN-01` Bảng điều hành Ban chỉ đạo (/ban/ban-01)

**Lời đọc**

> Bảng điều hành Ban chỉ đạo cho Trưởng ban thấy kế hoạch, số đã giải ngân và dải dự báo cuối năm. Số liệu chia theo ngành, địa bàn, chủ đầu tư và nguồn vốn. Hiện có {{figure:committee-projects}} dự án trong nguồn cấp dữ liệu. Ngày chốt và nguồn số liệu luôn nằm trên cùng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bảng điều hành Ban chỉ đạo cho Trưởng ban thấy kế hoạch, số đã giải ngân và dải dự báo cuối năm. Số liệu chia theo ngành, địa bàn, chủ đầu tư và nguồn vốn. Hiện có {{figure:committee-projects}} dự án trong nguồn cấp dữ liệu. Ngày chốt và nguồn số liệu luôn nằm trên cùng.

**Phụ đề**

- Bảng điều hành Ban chỉ đạo / cho Trưởng ban thấy kế hoạch,
- số đã giải ngân và dải dự báo cuối năm.
- Số liệu chia theo ngành, địa / bàn, chủ đầu tư và nguồn vốn.
- Hiện có {n} dự án trong nguồn cấp dữ liệu.
- Ngày chốt và nguồn số / liệu luôn nằm trên cùng.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BAN-01`
- `do=spot ref=ban.dashboard.context-bar`
- `do=spot ref=ban.dashboard.by-sector`
- `do=spot ref=ban.dashboard.forecast-band`

**Cần thấy trên hình**

- [ ] Màn BAN-01 "Bảng điều hành Ban chỉ đạo" mở được ở đường dẫn /ban/ban-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ban.dashboard.context-bar đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ban.dashboard.by-sector đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ban.dashboard.forecast-band đúng lúc giọng đọc nói tới
- [ ] Chú thích "Ngày chốt và nguồn số liệu" hiện từ giây 4, kéo dài 5 giây
- [ ] Con số committee-projects đọc từ dữ liệu thật qua getCommitteeWorkspace (feed.projects); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Thanh ngữ cảnh trên cùng ghi ngày chốt, kỳ và nguồn số liệu
- [ ] Bảng theo ngành có cột kế hoạch, đã giải ngân và tỷ lệ
- [ ] Dải dự báo cuối năm hiện thành một dải, không phải một con số
- [ ] Không có nhãn MÔ PHỎNG ở bất kỳ góc nào của màn hình
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ban-attention`

Nền tảng: web; 18.8 giây; có trong video chính

Màn hình: `BAN-02` Dự án cần Trưởng ban quan tâm (/ban/ban-02)

**Lời đọc**

> Danh sách dự án cần Trưởng ban quan tâm xếp theo mức tác động. Mỗi dòng nêu lý do: chậm tiến độ, vướng thủ tục, giải ngân thấp hoặc đơn vị không báo cáo. Hiện có {{figure:committee-attention-total}} dự án cần chú ý. Trưởng ban ghi quyết định và ra chỉ đạo ngay tại đây.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Danh sách dự án cần Trưởng ban quan tâm xếp theo mức tác động. Mỗi dòng nêu lý do: chậm tiến độ, vướng thủ tục, giải ngân thấp hoặc đơn vị không báo cáo. Hiện có {{figure:committee-attention-total}} dự án cần chú ý. Trưởng ban ghi quyết định và ra chỉ đạo ngay tại đây.

**Phụ đề**

- Danh sách dự án cần Trưởng ban / quan tâm xếp theo mức tác động.
- Mỗi dòng nêu lý do: chậm / tiến độ, vướng thủ tục,
- giải ngân thấp hoặc đơn vị không báo cáo.
- Hiện có {n} dự án cần chú ý.
- Trưởng ban ghi quyết định / và ra chỉ đạo ngay tại đây.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BAN-02`
- `do=spot ref=ban.attention.first-row`
- `do=spot ref=ban.attention.decision`

**Cần thấy trên hình**

- [ ] Màn BAN-02 "Dự án cần Trưởng ban quan tâm" mở được ở đường dẫn /ban/ban-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ban.attention.first-row đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ban.attention.decision đúng lúc giọng đọc nói tới
- [ ] Con số committee-attention-total đọc từ dữ liệu thật qua getCommitteeWorkspace (attention_total); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Mỗi dòng dự án có lý do bằng chữ, không chỉ bằng màu
- [ ] Khung ghi quyết định của Trưởng ban hiện cùng nút ra chỉ đạo
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ban-directives`

Nền tảng: web; 14.8 giây; có trong video chính

Màn hình: `BAN-04` Theo dõi chỉ đạo của Ban chỉ đạo (/ban/ban-04); `DIR-04` Chi tiết chỉ đạo, dòng thời gian, gia hạn và đóng (/dir/dir-04)

**Lời đọc**

> Theo dõi chỉ đạo cho biết mỗi đơn vị còn bao nhiêu chỉ đạo đang mở, quá hạn và đã leo thang. Hiện có {{figure:committee-directives-overdue}} chỉ đạo quá hạn. Bấm vào một chỉ đạo để xem dòng thời gian và lần gia hạn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Theo dõi chỉ đạo cho biết mỗi đơn vị còn bao nhiêu chỉ đạo đang mở, quá hạn và đã leo thang. Hiện có {{figure:committee-directives-overdue}} chỉ đạo quá hạn. Bấm vào một chỉ đạo để xem dòng thời gian và lần gia hạn.

**Phụ đề**

- Theo dõi chỉ đạo cho / biết mỗi đơn vị còn bao
- nhiêu chỉ đạo đang mở, / quá hạn và đã leo thang.
- Hiện có {n} chỉ đạo quá hạn.
- Bấm vào một chỉ đạo để xem / dòng thời gian và lần gia hạn.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BAN-04`
- `do=spot ref=ban.tracker.units`
- `do=click ref=ban.tracker.first-overdue`

**Cần thấy trên hình**

- [ ] Màn BAN-04 "Theo dõi chỉ đạo của Ban chỉ đạo" mở được ở đường dẫn /ban/ban-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIR-04 "Chi tiết chỉ đạo, dòng thời gian, gia hạn và đóng" mở được ở đường dẫn /dir/dir-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ban.tracker.units đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ban.tracker.first-overdue đúng lúc giọng đọc nói tới
- [ ] Con số committee-directives-overdue đọc từ dữ liệu thật qua getCommitteeDirectiveTracker (totals.overdue); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Bảng đơn vị có ba cột: đang mở, quá hạn, đã leo thang
- [ ] Màn chi tiết chỉ đạo mở được từ một dòng quá hạn và hiện dòng thời gian
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ban-alerts`

Nền tảng: web; 16 giây; chỉ trong chương cắt riêng

Màn hình: `BAN-05` Cảnh báo của Ban chỉ đạo (/ban/ban-05)

**Lời đọc**

> Cảnh báo của Ban chỉ đạo gồm toàn tỉnh chậm, ngành chậm, đơn vị không báo cáo và chỉ đạo quá hạn. Mỗi cảnh báo có chủ sở hữu, việc cần làm, hậu quả và hạn phản hồi. Trưởng ban xác nhận đã nhận kèm ghi chú.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cảnh báo của Ban chỉ đạo gồm toàn tỉnh chậm, ngành chậm, đơn vị không báo cáo và chỉ đạo quá hạn. Mỗi cảnh báo có chủ sở hữu, việc cần làm, hậu quả và hạn phản hồi. Trưởng ban xác nhận đã nhận kèm ghi chú.

**Phụ đề**

- Cảnh báo của Ban chỉ / đạo gồm toàn tỉnh chậm,
- ngành chậm, đơn vị không / báo cáo và chỉ đạo quá hạn.
- Mỗi cảnh báo có chủ sở hữu, việc / cần làm, hậu quả và hạn phản hồi.
- Trưởng ban xác nhận đã nhận kèm ghi chú.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BAN-05`
- `do=spot ref=ban.alerts.first-row`
- `do=spot ref=ban.alerts.acknowledge`

**Cần thấy trên hình**

- [ ] Màn BAN-05 "Cảnh báo của Ban chỉ đạo" mở được ở đường dẫn /ban/ban-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ban.alerts.first-row đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ban.alerts.acknowledge đúng lúc giọng đọc nói tới
- [ ] Ít nhất một cảnh báo hiện đủ chủ sở hữu, việc cần làm, hậu quả và hạn phản hồi
- [ ] Ô ghi chú khi Trưởng ban xác nhận đã nhận
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ban-pack`

Nền tảng: web; 13 giây; chỉ trong chương cắt riêng

Màn hình: `BAN-03` Hồ sơ họp Ban chỉ đạo (/ban/ban-03)

**Lời đọc**

> Hồ sơ họp định kỳ được lập thành tệp Word và Excel qua bộ sinh báo cáo. Người lập, người kiểm và người duyệt là ba người khác nhau, và bản đã phát hành không sửa được.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hồ sơ họp định kỳ được lập thành tệp oớt và ếch-xeo qua bộ sinh báo cáo. Người lập, người kiểm và người duyệt là ba người khác nhau, và bản đã phát hành không sửa được.

**Phụ đề**

- Hồ sơ họp định kỳ được lập thành tệp / Word và Excel qua bộ sinh báo cáo.
- Người lập, người kiểm và / người duyệt là ba người
- khác nhau, và bản đã / phát hành không sửa được.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BAN-03`
- `do=spot ref=ban.pack.roles`

**Cần thấy trên hình**

- [ ] Màn BAN-03 "Hồ sơ họp Ban chỉ đạo" mở được ở đường dẫn /ban/ban-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ban.pack.roles đúng lúc giọng đọc nói tới
- [ ] Ba vai lập, kiểm, duyệt hiện ba tên khác nhau
- [ ] Danh sách bản đã phát hành có tệp Word và tệp Excel
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ban-feed`

Nền tảng: web; 14.2 giây; chỉ trong chương cắt riêng

Màn hình: `FEED-01` Kết nối số liệu từ ứng dụng của Sở Tài chính (/feed/feed-01); `FEED-02` Các lần nhận số liệu và chạy thử tệp (/feed/feed-02)

**Lời đọc**

> Số liệu từ ứng dụng của Sở Tài chính vào hệ thống qua đúng đường nhập thật. Tệp được chạy thử trước, lỗi hiện theo từng dòng, rồi mới áp dụng. Mẫu tệp là giả định, chờ đặc tả chính thức.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Số liệu từ ứng dụng của Sở Tài chính vào hệ thống qua đúng đường nhập thật. Tệp được chạy thử trước, lỗi hiện theo từng dòng, rồi mới áp dụng. Mẫu tệp là giả định, chờ đặc tả chính thức.

**Phụ đề**

- Số liệu từ ứng dụng của Sở Tài chính / vào hệ thống qua đúng đường nhập thật.
- Tệp được chạy thử trước, lỗi hiện / theo từng dòng, rồi mới áp dụng.
- Mẫu tệp là giả định, / chờ đặc tả chính thức.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=FEED-01`
- `do=spot ref=feed.connection.health`
- `do=open screen=FEED-02`
- `do=spot ref=feed.runs.dry-run`

**Cần thấy trên hình**

- [ ] Màn FEED-01 "Kết nối số liệu từ ứng dụng của Sở Tài chính" mở được ở đường dẫn /feed/feed-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn FEED-02 "Các lần nhận số liệu và chạy thử tệp" mở được ở đường dẫn /feed/feed-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần feed.connection.health đúng lúc giọng đọc nói tới
- [ ] Khung vào phần feed.runs.dry-run đúng lúc giọng đọc nói tới
- [ ] Chú thích "Mẫu tệp là giả định, chờ đặc tả chính thức" hiện từ giây 6, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Mẫu tệp là giả định, chờ đặc tả chính thức"
- [ ] Dấu giả định của mẫu tệp hiện trên hình, không chỉ nằm trong lời đọc
- [ ] Kết quả chạy thử có dòng bị từ chối kèm lý do từng dòng
- [ ] Các chỉ số độ tuổi, độ đầy đủ và độ kịp thời của nguồn cấp dữ liệu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ban-reconcile`

Nền tảng: web; 16 giây; chỉ trong chương cắt riêng

Màn hình: `FEED-03` Ánh xạ mã dự án của Sở Tài chính (/feed/feed-03); `FEED-04` Sai lệch giữa số của Sở Tài chính và số của ta (/feed/feed-04)

**Lời đọc**

> Mã dự án của Sở được ánh xạ sang mã của ta, mã chưa ánh xạ hiện riêng. Sai lệch giữa số của Sở và số của ta được đối chiếu từng trường. Mỗi chênh lệch có chủ sở hữu, hạn xử lý và cách xử lý.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mã dự án của Sở được ánh xạ sang mã của ta, mã chưa ánh xạ hiện riêng. Sai lệch giữa số của Sở và số của ta được đối chiếu từng trường. Mỗi chênh lệch có chủ sở hữu, hạn xử lý và cách xử lý.

**Phụ đề**

- Mã dự án của Sở được ánh xạ sang mã / của ta, mã chưa ánh xạ hiện riêng.
- Sai lệch giữa số của Sở và số của / ta được đối chiếu từng trường.
- Mỗi chênh lệch có chủ sở / hữu, hạn xử lý và cách xử lý.

**Các bước quay**

- `do=open screen=FEED-03`
- `do=spot ref=feed.mapping.pending`
- `do=open screen=FEED-04`
- `do=spot ref=feed.diff.owner-column`

**Cần thấy trên hình**

- [ ] Màn FEED-03 "Ánh xạ mã dự án của Sở Tài chính" mở được ở đường dẫn /feed/feed-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn FEED-04 "Sai lệch giữa số của Sở Tài chính và số của ta" mở được ở đường dẫn /feed/feed-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần feed.mapping.pending đúng lúc giọng đọc nói tới
- [ ] Khung vào phần feed.diff.owner-column đúng lúc giọng đọc nói tới
- [ ] Danh sách mã chưa ánh xạ hiện riêng
- [ ] Cột chủ sở hữu và hạn xử lý của từng chênh lệch có giá trị
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ban-audit`

Nền tảng: web; 16.6 giây; chỉ trong chương cắt riêng

Màn hình: `BAN-07` Nhật ký xem màn hình nhạy cảm của Ban chỉ đạo (/ban/ban-07)

**Lời đọc**

> Mọi lần xem màn hình nhạy cảm của Ban chỉ đạo đều được ghi lại. Nhật ký cho biết ai xem, giữ vị trí nào, xem màn hình nào, bộ lọc gì, số liệu ngày nào và phiên xác thực ra sao. Kiểm toán viên đọc nhật ký này.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mọi lần xem màn hình nhạy cảm của Ban chỉ đạo đều được ghi lại. Nhật ký cho biết ai xem, giữ vị trí nào, xem màn hình nào, bộ lọc gì, số liệu ngày nào và phiên xác thực ra sao. Kiểm toán viên đọc nhật ký này.

**Phụ đề**

- Mọi lần xem màn hình nhạy cảm / của Ban chỉ đạo đều được ghi lại.
- Nhật ký cho biết ai xem, giữ / vị trí nào, xem màn hình nào,
- bộ lọc gì, số liệu ngày nào / và phiên xác thực ra sao.
- Kiểm toán viên đọc nhật ký này.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BAN-07`
- `do=spot ref=ban.audit.latest`

**Cần thấy trên hình**

- [ ] Màn BAN-07 "Nhật ký xem màn hình nhạy cảm của Ban chỉ đạo" mở được ở đường dẫn /ban/ban-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần ban.audit.latest đúng lúc giọng đọc nói tới
- [ ] Mỗi dòng nhật ký có người xem, vị trí, màn hình, bộ lọc, ngày số liệu và mức xác thực
- [ ] Nhật ký có lần xem của Trưởng ban vừa quay ở các cảnh trước
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ban-phone`

Nền tảng: phone; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-72` Bảng điều hành Ban chỉ đạo tỉnh trên điện thoại (tab home)

**Lời đọc**

> Trưởng ban chỉ đạo xem bảng điều hành của Ban chỉ đạo ngay trên điện thoại: tỷ lệ giải ngân, dự án cần quan tâm và chỉ đạo quá hạn. Mỗi lần xem màn nhạy cảm đều ghi vào nhật ký của Ban.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trưởng ban chỉ đạo xem bảng điều hành của Ban chỉ đạo ngay trên điện thoại: tỷ lệ giải ngân, dự án cần quan tâm và chỉ đạo quá hạn. Mỗi lần xem màn nhạy cảm đều ghi vào nhật ký của Ban.

**Phụ đề**

- Trưởng ban chỉ đạo xem bảng điều hành / của Ban chỉ đạo ngay trên điện thoại:
- tỷ lệ giải ngân, dự án cần / quan tâm và chỉ đạo quá hạn.
- Mỗi lần xem màn nhạy cảm / đều ghi vào nhật ký của Ban.

**Các bước quay**

- `do=as persona=docHead`
- `do=phone-open screen=MOB-72`
- `do=spot ref=mob.committee.dashboard-phone`

**Cần thấy trên hình**

- [ ] Màn MOB-72 "Bảng điều hành Ban chỉ đạo tỉnh trên điện thoại" trên điện thoại (tab home) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản docHead
- [ ] Khung vào phần mob.committee.dashboard-phone đúng lúc giọng đọc nói tới
- [ ] Bảng điều hành Ban chỉ đạo hiện đầy đủ trên điện thoại
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Cây tiến độ (`process-tree`)

### `tree-overview`

Nền tảng: web; 16 giây; có trong video chính

Màn hình: `BID-27` Tiến độ theo quy trình (cây tiến độ) (/bid/bid-27)

**Lời đọc**

> Cây tiến độ cho thấy mọi gói thầu thành một cây trạng thái có số lượng. Mỗi nút ghi số gói, giá trị, ngày trung vị và số gói trễ, cạnh ghi số gói chuyển trong kỳ. Hiện có {{figure:tree-packages-total}} gói, {{figure:tree-packages-late}} gói trễ hạn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cây tiến độ cho thấy mọi gói thầu thành một cây trạng thái có số lượng. Mỗi nút ghi số gói, giá trị, ngày trung vị và số gói trễ, cạnh ghi số gói chuyển trong kỳ. Hiện có {{figure:tree-packages-total}} gói, {{figure:tree-packages-late}} gói trễ hạn.

**Phụ đề**

- Cây tiến độ cho thấy mọi gói thầu / thành một cây trạng thái có số lượng.
- Mỗi nút ghi số gói, giá / trị, ngày trung vị và
- số gói trễ, cạnh ghi / số gói chuyển trong kỳ.
- Hiện có {n} gói, {n} gói trễ hạn.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-27`
- `do=spot ref=bid.tree.canvas`
- `do=point ref=bid.tree.edge-label`

**Cần thấy trên hình**

- [ ] Màn BID-27 "Tiến độ theo quy trình (cây tiến độ)" mở được ở đường dẫn /bid/bid-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.tree.canvas đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.tree.edge-label đúng lúc giọng đọc nói tới
- [ ] Chú thích "Cây tiến độ · số gói ở từng trạng thái" hiện từ giây 1.5, kéo dài 5 giây
- [ ] Con số tree-packages-total đọc từ dữ liệu thật qua getPackageProcessTree (total.count); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số tree-packages-late đọc từ dữ liệu thật qua getPackageProcessTree (kpis.late); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Cây trạng thái có số gói ở từng nút
- [ ] Có đồng thời nút trễ, nút tạm dừng và nút trả lại
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `tree-node`

Nền tảng: web; 10.2 giây; có trong video chính

Màn hình: `BID-27` Tiến độ theo quy trình (cây tiến độ) (/bid/bid-27)

**Lời đọc**

> Bấm vào một nút, bảng bên phải hiện ngày trung vị {{figure:tree-median-days}}, mục danh mục kiểm hay bỏ dở, người giữ nhiều gói và danh sách gói của nút.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bấm vào một nút, bảng bên phải hiện ngày trung vị {{figure:tree-median-days}}, mục danh mục kiểm hay bỏ dở, người giữ nhiều gói và danh sách gói của nút.

**Phụ đề**

- Bấm vào một nút, bảng bên phải / hiện ngày trung vị {n}, mục danh
- mục kiểm hay bỏ dở, người giữ / nhiều gói và danh sách gói của nút.

**Các bước quay**

- `do=click ref=bid.tree.node-busiest`
- `do=spot ref=bid.tree.panel-overview`
- `do=click ref=bid.tree.panel-tab-packages`

**Cần thấy trên hình**

- [ ] Màn BID-27 "Tiến độ theo quy trình (cây tiến độ)" mở được ở đường dẫn /bid/bid-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần bid.tree.node-busiest đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.tree.panel-overview đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.tree.panel-tab-packages đúng lúc giọng đọc nói tới
- [ ] Con số tree-median-days đọc từ dữ liệu thật qua getPackageProcessTreeNode (node.median_days); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `tree-package`

Nền tảng: web; 14.2 giây; có trong video chính

Màn hình: `BID-29` Tiến trình một gói thầu (/bid/bid-29)

**Lời đọc**

> Bấm vào một gói để đi sâu: thanh tiến trình cho biết bước hiện tại, chuẩn mấy ngày, thực mấy ngày, ai giữ, điều gì đang chặn. Dòng thời gian ghi từng ngày: đổi trạng thái, ai làm, lý do, bằng chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bấm vào một gói để đi sâu: thanh tiến trình cho biết bước hiện tại, chuẩn mấy ngày, thực mấy ngày, ai giữ, điều gì đang chặn. Dòng thời gian ghi từng ngày: đổi trạng thái, ai làm, lý do, bằng chứng.

**Phụ đề**

- Bấm vào một gói để đi sâu: thanh / tiến trình cho biết bước hiện tại,
- chuẩn mấy ngày, thực mấy ngày, / ai giữ, điều gì đang chặn.
- Dòng thời gian ghi từng ngày: đổi / trạng thái, ai làm, lý do, bằng chứng.

**Các bước quay**

- `do=click ref=bid.tree.panel-first-package`
- `do=spot ref=bid.package.stepper`
- `do=scroll through=voice`
- `do=spot ref=bid.package.timeline`

**Cần thấy trên hình**

- [ ] Màn BID-29 "Tiến trình một gói thầu" mở được ở đường dẫn /bid/bid-29, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần bid.tree.panel-first-package đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.package.stepper đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.package.timeline đúng lúc giọng đọc nói tới
- [ ] Chú thích "Dòng thời gian theo từng ngày" hiện từ giây 5, kéo dài 5 giây
- [ ] Dòng thời gian từng ngày của một gói, bước quá hạn được tô riêng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `tree-board`

Nền tảng: web; 11.1 giây; có trong video chính

Màn hình: `BID-28` Bảng gói thầu theo bước (/bid/bid-28)

**Lời đọc**

> Nhìn theo công đoạn là bảng cột theo bước, mỗi thẻ là một gói. Lọc theo đơn vị, hình thức hay chỉ gói trễ thì số lượng và giá trị đổi theo.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Nhìn theo công đoạn là bảng cột theo bước, mỗi thẻ là một gói. Lọc theo đơn vị, hình thức hay chỉ gói trễ thì số lượng và giá trị đổi theo.

**Phụ đề**

- Nhìn theo công đoạn là bảng cột / theo bước, mỗi thẻ là một gói.
- Lọc theo đơn vị, hình thức hay chỉ gói / trễ thì số lượng và giá trị đổi theo.

**Các bước quay**

- `do=open screen=BID-28`
- `do=click ref=bid.board.filter-late-only`
- `do=spot ref=bid.board.column-totals`

**Cần thấy trên hình**

- [ ] Màn BID-28 "Bảng gói thầu theo bước" mở được ở đường dẫn /bid/bid-28, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần bid.board.filter-late-only đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.board.column-totals đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `tree-bottleneck`

Nền tảng: web; 9.6 giây; có trong video chính

Màn hình: `BID-30` Phân tích nút nghẽn và báo cáo tiến độ lựa chọn nhà thầu (/bid/bid-30)

**Lời đọc**

> Phân tích nút nghẽn chỉ ra bước làm chậm cả quy trình và gói kẹt lâu nhất, hiện {{figure:tree-stuck-days}}. Báo cáo xuất ra Excel.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Phân tích nút nghẽn chỉ ra bước làm chậm cả quy trình và gói kẹt lâu nhất, hiện {{figure:tree-stuck-days}}. Báo cáo xuất ra ếch-xeo.

**Phụ đề**

- Phân tích nút nghẽn / chỉ ra bước làm chậm cả
- quy trình và gói kẹt lâu nhất, hiện {n}.
- Báo cáo xuất ra Excel.

**Các bước quay**

- `do=open screen=BID-30`
- `do=spot ref=bid.bottleneck.step-medians`
- `do=click ref=bid.bottleneck.export-xlsx`

**Cần thấy trên hình**

- [ ] Màn BID-30 "Phân tích nút nghẽn và báo cáo tiến độ lựa chọn nhà thầu" mở được ở đường dẫn /bid/bid-30, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần bid.bottleneck.step-medians đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.bottleneck.export-xlsx đúng lúc giọng đọc nói tới
- [ ] Con số tree-stuck-days đọc từ dữ liệu thật qua getPackageWorkflowStatistics (stuck[0].days); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Bảng nút nghẽn xếp theo ngày trung vị
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `tree-phone`

Nền tảng: phone; 12.4 giây; có trong video chính

Màn hình: `MOB-71` Cây tiến độ trên điện thoại (tab projects); `MOB-70` Tiến trình một gói thầu trên điện thoại (tab projects); `MOB-69` Gói thầu theo bước trên điện thoại (tab projects)

**Lời đọc**

> Trên điện thoại, cây tiến độ là danh sách thụt vào, chạm một dòng để xem gói, chạm tiếp để xem tiến trình từng ngày. PWA của lãnh đạo hiện thành thẻ phễu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trên điện thoại, cây tiến độ là danh sách thụt vào, chạm một dòng để xem gói, chạm tiếp để xem tiến trình từng ngày. pê-đắp-liu-a của lãnh đạo hiện thành thẻ phễu.

**Phụ đề**

- Trên điện thoại, cây tiến / độ là danh sách thụt vào,
- chạm một dòng để xem gói, chạm / tiếp để xem tiến trình từng ngày.
- PWA của lãnh đạo hiện thành thẻ phễu.

**Các bước quay**

- `do=phone-open screen=MOB-71`
- `do=phone-tap ref=mob.tree.first-node`
- `do=phone-open screen=MOB-70`
- `do=phone-scroll through=voice`

**Cần thấy trên hình**

- [ ] Màn MOB-71 "Cây tiến độ trên điện thoại" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-70 "Tiến trình một gói thầu trên điện thoại" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-69 "Gói thầu theo bước trên điện thoại" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `tree-definition`

Nền tảng: web; 22.8 giây; chỉ trong chương cắt riêng

Màn hình: `BID-31` Định nghĩa quy trình lựa chọn nhà thầu (/bid/bid-31)

**Lời đọc**

> Quy trình lựa chọn nhà thầu là dữ liệu có phiên bản, cấu hình theo từng hình thức. Đó là đấu thầu rộng rãi, hạn chế, chỉ định thầu, chào hàng cạnh tranh và các hình thức khác. Mỗi bước có điều kiện vào, điều kiện ra, người chịu trách nhiệm, thời hạn chuẩn và bằng chứng. Các bước theo Luật Đấu thầu còn ghi chưa kiểm chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Quy trình lựa chọn nhà thầu là dữ liệu có phiên bản, cấu hình theo từng hình thức. Đó là đấu thầu rộng rãi, hạn chế, chỉ định thầu, chào hàng cạnh tranh và các hình thức khác. Mỗi bước có điều kiện vào, điều kiện ra, người chịu trách nhiệm, thời hạn chuẩn và bằng chứng. Các bước theo Luật Đấu thầu còn ghi chưa kiểm chứng.

**Phụ đề**

- Quy trình lựa chọn nhà thầu là dữ liệu có / phiên bản, cấu hình theo từng hình thức.
- Đó là đấu thầu rộng rãi, / hạn chế, chỉ định thầu,
- chào hàng cạnh tranh / và các hình thức khác.
- Mỗi bước có điều kiện vào, điều kiện ra,
- người chịu trách nhiệm, thời / hạn chuẩn và bằng chứng.
- Các bước theo Luật Đấu thầu / còn ghi chưa kiểm chứng.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-31`
- `do=choose ref=bid.definition.method option=first`
- `do=spot ref=bid.definition.step-list`

**Cần thấy trên hình**

- [ ] Màn BID-31 "Định nghĩa quy trình lựa chọn nhà thầu" mở được ở đường dẫn /bid/bid-31, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.definition.step-list đúng lúc giọng đọc nói tới
- [ ] Chú thích "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng" hiện từ giây 5, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `tree-checklist`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `BID-29` Tiến trình một gói thầu (/bid/bid-29)

**Lời đọc**

> Trong mỗi bước có danh mục kiểm: mục nào có người, hạn và bằng chứng. Mục bắt buộc chưa xong thì chặn việc qua bước. Ngoại lệ phải có lý do và người duyệt, và được ghi vào nhật ký kiểm toán.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trong mỗi bước có danh mục kiểm: mục nào có người, hạn và bằng chứng. Mục bắt buộc chưa xong thì chặn việc qua bước. Ngoại lệ phải có lý do và người duyệt, và được ghi vào nhật ký kiểm toán.

**Phụ đề**

- Trong mỗi bước có danh mục kiểm: / mục nào có người, hạn và bằng chứng.
- Mục bắt buộc chưa xong / thì chặn việc qua bước.
- Ngoại lệ phải có lý do và người duyệt, / và được ghi vào nhật ký kiểm toán.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-29`
- `do=click ref=bid.package.tab-checklist`
- `do=spot ref=bid.package.required-items`

**Cần thấy trên hình**

- [ ] Màn BID-29 "Tiến trình một gói thầu" mở được ở đường dẫn /bid/bid-29, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.package.tab-checklist đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.package.required-items đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `tree-alerts`

Nền tảng: web; 18.5 giây; chỉ trong chương cắt riêng

Màn hình: `HOME-02` Việc của tôi (/home/home-02); `BID-27` Tiến độ theo quy trình (cây tiến độ) (/bid/bid-27)

**Lời đọc**

> Quy trình tự sinh cảnh báo. Đó là bước quá hạn, mục bắt buộc sát hạn mà chưa xong và gói đứng yên quá lâu. Còn có gói thiếu người phụ trách và thứ tự đăng tải sai trên mạng đấu thầu. Mỗi cảnh báo có chủ, hành động mong đợi và hậu quả.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Quy trình tự sinh cảnh báo. Đó là bước quá hạn, mục bắt buộc sát hạn mà chưa xong và gói đứng yên quá lâu. Còn có gói thiếu người phụ trách và thứ tự đăng tải sai trên mạng đấu thầu. Mỗi cảnh báo có chủ, hành động mong đợi và hậu quả.

**Phụ đề**

- Quy trình tự sinh cảnh báo.
- Đó là bước quá hạn, mục bắt buộc sát hạn / mà chưa xong và gói đứng yên quá lâu.
- Còn có gói thiếu người phụ trách và / thứ tự đăng tải sai trên mạng đấu thầu.
- Mỗi cảnh báo có chủ, hành / động mong đợi và hậu quả.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=HOME-02`
- `do=spot ref=alerts.item.package-overdue`

**Cần thấy trên hình**

- [ ] Màn HOME-02 "Việc của tôi" mở được ở đường dẫn /home/home-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-27 "Tiến độ theo quy trình (cây tiến độ)" mở được ở đường dẫn /bid/bid-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần alerts.item.package-overdue đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Ứng dụng điện thoại và PWA (`phone`)

### `ph-home`

Nền tảng: phone; 14.5 giây; có trong video chính

Màn hình: `MOB-07` Trang chủ lãnh đạo (tab home)

**Lời đọc**

> Trang chủ lãnh đạo trên điện thoại mở bằng khối chỉ huy với hai tỷ lệ giải ngân, thẻ cảnh báo Cần xử lý ngay ở trên cùng. Mỗi số có nút i, thanh độ mới nói số liệu cập nhật lúc nào.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trang chủ lãnh đạo trên điện thoại mở bằng khối chỉ huy với hai tỷ lệ giải ngân, thẻ cảnh báo Cần xử lý ngay ở trên cùng. Mỗi số có nút i, thanh độ mới nói số liệu cập nhật lúc nào.

**Phụ đề**

- Trang chủ lãnh đạo trên điện / thoại mở bằng khối chỉ huy với
- hai tỷ lệ giải ngân, thẻ cảnh / báo Cần xử lý ngay ở trên cùng.
- Mỗi số có nút i, thanh độ mới / nói số liệu cập nhật lúc nào.

**Các bước quay**

- `do=as persona=owner`
- `do=phone-open screen=MOB-07`
- `do=phone-tap ref=mob.home.alert-card`
- `do=phone-tap ref=mob.home.figure-info`

**Cần thấy trên hình**

- [ ] Màn MOB-07 "Trang chủ lãnh đạo" trên điện thoại (tab home) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Chú thích "Thẻ cảnh báo ở đầu trang chủ" hiện từ giây 2, kéo dài 4 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ph-inbox`

Nền tảng: phone; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-32` Hộp thông báo (tab inbox); `MOB-33` Chi tiết thông báo (tab inbox)

**Lời đọc**

> Hộp thông báo gom mọi việc đến từ hệ thống. Thông báo đẩy chỉ mang một đường dẫn, không mang số tiền hay tên người, nên màn hình khóa không lộ thông tin. Chạm vào, ứng dụng mở đúng hồ sơ cần xử lý.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hộp thông báo gom mọi việc đến từ hệ thống. Thông báo đẩy chỉ mang một đường dẫn, không mang số tiền hay tên người, nên màn hình khóa không lộ thông tin. Chạm vào, ứng dụng mở đúng hồ sơ cần xử lý.

**Phụ đề**

- Hộp thông báo gom mọi / việc đến từ hệ thống.
- Thông báo đẩy chỉ mang một / đường dẫn, không mang số tiền
- hay tên người, nên màn hình / khóa không lộ thông tin.
- Chạm vào, ứng dụng mở / đúng hồ sơ cần xử lý.

**Các bước quay**

- `do=phone-open screen=MOB-32`
- `do=phone-tap ref=mob.inbox.first-item`
- `do=phone-open screen=MOB-33`

**Cần thấy trên hình**

- [ ] Màn MOB-32 "Hộp thông báo" trên điện thoại (tab inbox) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-33 "Chi tiết thông báo" trên điện thoại (tab inbox) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ph-approval`

Nền tảng: phone; 12.7 giây; có trong video chính

Màn hình: `MOB-23` Danh sách phê duyệt (tab approval); `MOB-24` Chi tiết phê duyệt (tab approval); `MOB-25` Xác nhận phê duyệt và ký (tab approval)

**Lời đọc**

> Lãnh đạo duyệt ngay trên điện thoại: xem hồ sơ, duyệt hoặc trả lại kèm lý do, xác thực lần hai rồi ký. Màn xác nhận bị hệ điều hành chặn quay nên dùng hình dựng lại.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Lãnh đạo duyệt ngay trên điện thoại: xem hồ sơ, duyệt hoặc trả lại kèm lý do, xác thực lần hai rồi ký. Màn xác nhận bị hệ điều hành chặn quay nên dùng hình dựng lại.

**Phụ đề**

- Lãnh đạo duyệt ngay trên / điện thoại: xem hồ sơ,
- duyệt hoặc trả lại kèm lý / do, xác thực lần hai rồi ký.
- Màn xác nhận bị hệ điều hành / chặn quay nên dùng hình dựng lại.

**Các bước quay**

- `do=phone-open screen=MOB-23`
- `do=phone-tap ref=mob.approvals.first-task`
- `do=phone-open screen=MOB-24`
- `do=still id=approval-sheet-reconstructed`

**Cần thấy trên hình**

- [ ] Màn MOB-23 "Danh sách phê duyệt" trên điện thoại (tab approval) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-24 "Chi tiết phê duyệt" trên điện thoại (tab approval) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-25 "Xác nhận phê duyệt và ký" trên điện thoại (tab approval) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Chú thích "Hình dựng lại: hệ điều hành chặn quay màn này" hiện từ giây 6, kéo dài 6 giây
- [ ] Màn xác nhận phê duyệt bị hệ điều hành chặn quay nên dùng hình dựng lại, ghi rõ đó là hình dựng lại
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ph-field`

Nền tảng: phone; 10.2 giây; có trong video chính

Màn hình: `MOB-28` Ghi nhận vướng mắc (tab projects); `MOB-29` Chụp ảnh và chú thích (tab projects); `MOB-30` Định vị và kiểm tra hiện trường (tab projects)

**Lời đọc**

> Cán bộ hiện trường chụp ảnh, chú thích và đính kèm vị trí. Mất mạng thì hồ sơ nằm trong hàng đợi, tự gửi khi có kết nối lại.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cán bộ hiện trường chụp ảnh, chú thích và đính kèm vị trí. Mất mạng thì hồ sơ nằm trong hàng đợi, tự gửi khi có kết nối lại.

**Phụ đề**

- Cán bộ hiện trường chụp ảnh, / chú thích và đính kèm vị trí.
- Mất mạng thì hồ sơ nằm trong hàng / đợi, tự gửi khi có kết nối lại.

**Các bước quay**

- `do=as persona=projectManager`
- `do=phone-open screen=MOB-28`
- `do=phone-tap ref=mob.issue.take-photo`
- `do=phone-open screen=MOB-30`
- `do=phone-tap ref=mob.issue.submit`

**Cần thấy trên hình**

- [ ] Màn MOB-28 "Ghi nhận vướng mắc" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-29 "Chụp ảnh và chú thích" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-30 "Định vị và kiểm tra hiện trường" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ph-pwa`

Nền tảng: pwa; 26.7 giây; có trong video chính

Màn hình: `PWA-01` PWA-01 (/m); `PWA-02` PWA-02 (/m/approvals); `PWA-03` PWA-03 (/m/dashboard)

**Lời đọc**

> Người không cài ứng dụng dùng PWA, ứng dụng web cài thẳng vào màn hình chính. Chạm Cài đặt ứng dụng, rồi mở như một ứng dụng thật, không có thanh địa chỉ. Thông báo đẩy chỉ mang đường dẫn, không mang số liệu. Bên trong có hàng đợi phê duyệt, bảng điều hành và theo dõi chỉ đạo. PWA chỉ lưu vỏ ứng dụng, không lưu dữ liệu, đăng xuất là xóa sạch.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Người không cài ứng dụng dùng pê-đắp-liu-a, ứng dụng quép cài thẳng vào màn hình chính. Chạm Cài đặt ứng dụng, rồi mở như một ứng dụng thật, không có thanh địa chỉ. Thông báo đẩy chỉ mang đường dẫn, không mang số liệu. Bên trong có hàng đợi phê duyệt, bảng điều hành và theo dõi chỉ đạo. pê-đắp-liu-a chỉ lưu vỏ ứng dụng, không lưu dữ liệu, đăng xuất là xóa sạch.

**Phụ đề**

- Người không cài ứng dụng dùng PWA, ứng / dụng web cài thẳng vào màn hình chính.
- Chạm Cài đặt ứng dụng, rồi mở như một / ứng dụng thật, không có thanh địa chỉ.
- Thông báo đẩy chỉ mang đường / dẫn, không mang số liệu.
- Bên trong có hàng đợi phê duyệt, / bảng điều hành và theo dõi chỉ đạo.
- PWA chỉ lưu vỏ ứng dụng, không lưu / dữ liệu, đăng xuất là xóa sạch.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=PWA-01`
- `do=click ref=pwa.install.button`
- `do=open screen=PWA-02`
- `do=spot ref=pwa.approvals.queue`
- `do=open screen=PWA-03`
- `do=spot ref=pwa.dashboard.cards`

**Cần thấy trên hình**

- [ ] Màn PWA-01 của ứng dụng cài đặt (PWA) mở ở đường dẫn /m, trong khung điện thoại
- [ ] Màn PWA-02 của ứng dụng cài đặt (PWA) mở ở đường dẫn /m/approvals, trong khung điện thoại
- [ ] Màn PWA-03 của ứng dụng cài đặt (PWA) mở ở đường dẫn /m/dashboard, trong khung điện thoại
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần pwa.install.button đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pwa.approvals.queue đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pwa.dashboard.cards đúng lúc giọng đọc nói tới
- [ ] Chú thích "PWA: chỉ lưu vỏ ứng dụng, không lưu dữ liệu" hiện từ giây 14, kéo dài 6 giây
- [ ] Ứng dụng cài đặt chạy trong khung điện thoại, không thấy thanh địa chỉ của trình duyệt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ph-lists`

Nền tảng: phone; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-09` Danh sách dự án (tab projects); `MOB-61` Hợp đồng và mốc hiện trường (tab projects); `MOB-62` Nhật ký công trường trên điện thoại (tab projects)

**Lời đọc**

> Danh sách dự án và hợp đồng trên điện thoại có chi tiết, bản đồ hiện trường và các mốc gần hạn. Cán bộ ngoài công trường mở được nhật ký thi công, ghi khối lượng và kiểm tra chất lượng, rồi đồng bộ khi có mạng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Danh sách dự án và hợp đồng trên điện thoại có chi tiết, bản đồ hiện trường và các mốc gần hạn. Cán bộ ngoài công trường mở được nhật ký thi công, ghi khối lượng và kiểm tra chất lượng, rồi đồng bộ khi có mạng.

**Phụ đề**

- Danh sách dự án và hợp đồng / trên điện thoại có chi tiết,
- bản đồ hiện trường và các mốc gần hạn.
- Cán bộ ngoài công trường / mở được nhật ký thi công,
- ghi khối lượng và kiểm tra chất / lượng, rồi đồng bộ khi có mạng.

**Các bước quay**

- `do=phone-open screen=MOB-09`
- `do=phone-tap ref=mob.projects.first-item`
- `do=phone-open screen=MOB-61`

**Cần thấy trên hình**

- [ ] Màn MOB-09 "Danh sách dự án" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-61 "Hợp đồng và mốc hiện trường" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-62 "Nhật ký công trường trên điện thoại" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ph-report`

Nền tảng: phone; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-13` Chọn kỳ báo cáo (tab projects); `MOB-20` Rà soát báo cáo (tab projects); `MOB-21` Gửi báo cáo thành công (tab projects)

**Lời đọc**

> Báo cáo giải ngân tuần làm được trên điện thoại: chọn kỳ, nhập khối lượng và vốn theo nguồn, đính kèm chứng từ, rà soát rồi gửi. Gửi xong có biên nhận ghi mã, giờ, người nhận và bước kế tiếp.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Báo cáo giải ngân tuần làm được trên điện thoại: chọn kỳ, nhập khối lượng và vốn theo nguồn, đính kèm chứng từ, rà soát rồi gửi. Gửi xong có biên nhận ghi mã, giờ, người nhận và bước kế tiếp.

**Phụ đề**

- Báo cáo giải ngân tuần làm / được trên điện thoại: chọn kỳ,
- nhập khối lượng và vốn theo nguồn, / đính kèm chứng từ, rà soát rồi gửi.
- Gửi xong có biên nhận ghi mã, / giờ, người nhận và bước kế tiếp.

**Các bước quay**

- `do=as persona=projectManager`
- `do=phone-open screen=MOB-13`
- `do=phone-open screen=MOB-20`
- `do=phone-tap ref=mob.report.submit`
- `do=phone-open screen=MOB-21`

**Cần thấy trên hình**

- [ ] Màn MOB-13 "Chọn kỳ báo cáo" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-20 "Rà soát báo cáo" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-21 "Gửi báo cáo thành công" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ph-offline`

Nền tảng: phone; 16.6 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-43` Mất kết nối (tab projects); `MOB-41` Danh sách đồng bộ (tab projects); `MOB-42` Xử lý xung đột (tab projects)

**Lời đọc**

> Khi mất kết nối, ứng dụng chuyển sang chế độ chỉ đọc kèm giờ đồng bộ gần nhất. Việc ghi nhận nằm trong hàng đợi đồng bộ. Nếu hai người sửa cùng một hồ sơ, màn xử lý xung đột cho so sánh hai bản và chọn bản đúng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Khi mất kết nối, ứng dụng chuyển sang chế độ chỉ đọc kèm giờ đồng bộ gần nhất. Việc ghi nhận nằm trong hàng đợi đồng bộ. Nếu hai người sửa cùng một hồ sơ, màn xử lý xung đột cho so sánh hai bản và chọn bản đúng.

**Phụ đề**

- Khi mất kết nối, ứng dụng chuyển sang / chế độ chỉ đọc kèm giờ đồng bộ gần nhất.
- Việc ghi nhận nằm trong hàng đợi đồng bộ.
- Nếu hai người sửa cùng / một hồ sơ, màn xử lý
- xung đột cho so sánh hai / bản và chọn bản đúng.

**Các bước quay**

- `do=phone-open screen=MOB-43`
- `do=phone-open screen=MOB-41`
- `do=phone-open screen=MOB-42`

**Cần thấy trên hình**

- [ ] Màn MOB-43 "Mất kết nối" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-41 "Danh sách đồng bộ" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-42 "Xử lý xung đột" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ph-security`

Nền tảng: phone; 18.2 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-02` Đăng nhập SSO (tab stack); `MOB-03` Xác thực MFA (tab stack); `MOB-47` Tài khoản và sinh trắc học (tab account); `MOB-49` Thiết bị và đăng xuất (tab account)

**Lời đọc**

> Đăng nhập một lần qua tài khoản của tổ chức, xác thực hai lớp, và có thể mở khóa bằng sinh trắc học. Người dùng thấy và thu hồi được từng thiết bị của mình. Hết phiên hay hết giấy phép sử dụng, ứng dụng nói rõ lý do chứ không treo im lặng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đăng nhập một lần qua tài khoản của tổ chức, xác thực hai lớp, và có thể mở khóa bằng sinh trắc học. Người dùng thấy và thu hồi được từng thiết bị của mình. Hết phiên hay hết giấy phép sử dụng, ứng dụng nói rõ lý do chứ không treo im lặng.

**Phụ đề**

- Đăng nhập một lần qua / tài khoản của tổ chức,
- xác thực hai lớp, và có thể / mở khóa bằng sinh trắc học.
- Người dùng thấy và thu hồi / được từng thiết bị của mình.
- Hết phiên hay hết giấy phép sử dụng, ứng / dụng nói rõ lý do chứ không treo im lặng.

**Các bước quay**

- `do=phone-open screen=MOB-02`
- `do=phone-open screen=MOB-03`
- `do=phone-open screen=MOB-47`
- `do=phone-open screen=MOB-49`

**Cần thấy trên hình**

- [ ] Màn MOB-02 "Đăng nhập SSO" trên điện thoại (tab stack) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-03 "Xác thực MFA" trên điện thoại (tab stack) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-47 "Tài khoản và sinh trắc học" trên điện thoại (tab account) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-49 "Thiết bị và đăng xuất" trên điện thoại (tab account) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ph-ai`

Nền tảng: phone; 14.8 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-37` AI hỏi đáp có nguồn (tab projects); `MOB-39` Xem dẫn chứng gốc (tab projects)

**Lời đọc**

> Trợ lý AI trên điện thoại trả lời kèm nguồn: mỗi nhận định dẫn tới trang và đoạn trong hồ sơ gốc, tách rõ nguồn, giả định và suy luận. AI hỗ trợ đọc và tóm tắt, không quyết định thanh toán.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trợ lý ây-ai trên điện thoại trả lời kèm nguồn: mỗi nhận định dẫn tới trang và đoạn trong hồ sơ gốc, tách rõ nguồn, giả định và suy luận. ây-ai hỗ trợ đọc và tóm tắt, không quyết định thanh toán.

**Phụ đề**

- Trợ lý AI trên điện thoại trả lời / kèm nguồn: mỗi nhận định dẫn tới
- trang và đoạn trong hồ sơ gốc, tách / rõ nguồn, giả định và suy luận.
- AI hỗ trợ đọc và tóm tắt, / không quyết định thanh toán.

**Các bước quay**

- `do=phone-open screen=MOB-37`
- `do=phone-tap ref=mob.ai.first-citation`
- `do=phone-open screen=MOB-39`

**Cần thấy trên hình**

- [ ] Màn MOB-37 "AI hỏi đáp có nguồn" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-39 "Xem dẫn chứng gốc" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Quản lý nhà thầu nâng cao (`contractors-plus`)

### `vnd2-independence`

Nền tảng: web; 17.9 giây; chỉ trong chương cắt riêng

Màn hình: `VND-07` Kiểm soát gói thầu: độc lập, bảo đảm, tài chính (/vnd/vnd-07)

**Lời đọc**

> Trước khi chấm thầu, hệ thống kiểm tính độc lập giữa nhà thầu với hội đồng, cán bộ dự án và chủ đầu tư. Quan hệ họ hàng, cổ phần hay nơi làm việc cũ đều là căn cứ. Phát hiện mạnh chưa có người khác quyết định thì chặn bước trao thầu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trước khi chấm thầu, hệ thống kiểm tính độc lập giữa nhà thầu với hội đồng, cán bộ dự án và chủ đầu tư. Quan hệ họ hàng, cổ phần hay nơi làm việc cũ đều là căn cứ. Phát hiện mạnh chưa có người khác quyết định thì chặn bước trao thầu.

**Phụ đề**

- Trước khi chấm thầu, hệ / thống kiểm tính độc lập giữa
- nhà thầu với hội đồng, cán / bộ dự án và chủ đầu tư.
- Quan hệ họ hàng, cổ phần hay / nơi làm việc cũ đều là căn cứ.
- Phát hiện mạnh chưa có người khác / quyết định thì chặn bước trao thầu.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=VND-07`
- `do=spot ref=vnd.package-controls.independence-findings`
- `do=spot ref=vnd.package-controls.decision-column`

**Cần thấy trên hình**

- [ ] Màn VND-07 "Kiểm soát gói thầu: độc lập, bảo đảm, tài chính" mở được ở đường dẫn /vnd/vnd-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần vnd.package-controls.independence-findings đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.package-controls.decision-column đúng lúc giọng đọc nói tới
- [ ] Chú thích "Tín hiệu, không phải kết luận · người khác quyết định" hiện từ giây 3, kéo dài 6 giây
- [ ] Mỗi phát hiện có mức mạnh hay yếu và lý do bằng chữ
- [ ] Cột quyết định hiện tên người khác với người chạy kiểm tra
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd2-finance-load`

Nền tảng: web; 20.3 giây; chỉ trong chương cắt riêng

Màn hình: `VND-08` Tài chính và tải của nhà thầu (/vnd/vnd-08); `VND-07` Kiểm soát gói thầu: độc lập, bảo đảm, tài chính (/vnd/vnd-07)

**Lời đọc**

> Mỗi năm nhà thầu có một kỳ tài chính đã xác minh. Từ đó hệ thống tính tỷ số thanh toán hiện hành, nợ trên tài sản, khả năng trả lãi và doanh thu bình quân. Liên danh được xét theo phần của từng thành viên. Tải đồng thời so với doanh thu cho biết có giao quá sức không.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi năm nhà thầu có một kỳ tài chính đã xác minh. Từ đó hệ thống tính tỷ số thanh toán hiện hành, nợ trên tài sản, khả năng trả lãi và doanh thu bình quân. Liên danh được xét theo phần của từng thành viên. Tải đồng thời so với doanh thu cho biết có giao quá sức không.

**Phụ đề**

- Mỗi năm nhà thầu có một / kỳ tài chính đã xác minh.
- Từ đó hệ thống tính tỷ / số thanh toán hiện hành,
- nợ trên tài sản, khả năng trả / lãi và doanh thu bình quân.
- Liên danh được xét theo / phần của từng thành viên.
- Tải đồng thời so với doanh thu / cho biết có giao quá sức không.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=VND-08`
- `do=spot ref=vnd.finance.ratios`
- `do=spot ref=vnd.finance.load-signal`
- `do=open screen=VND-07`
- `do=spot ref=vnd.package-controls.finance-check`

**Cần thấy trên hình**

- [ ] Màn VND-08 "Tài chính và tải của nhà thầu" mở được ở đường dẫn /vnd/vnd-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-07 "Kiểm soát gói thầu: độc lập, bảo đảm, tài chính" mở được ở đường dẫn /vnd/vnd-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần vnd.finance.ratios đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.finance.load-signal đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.package-controls.finance-check đúng lúc giọng đọc nói tới
- [ ] Chú thích "Mỗi con số có giải thích" hiện từ giây 3, kéo dài 5 giây
- [ ] Bảng tỷ số hiện giá trị, ngưỡng của quy tắc và kết quả đạt hay không
- [ ] Tín hiệu tải hiện rõ khi vượt bội số của quy tắc
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd2-bid-security`

Nền tảng: web; 19.4 giây; chỉ trong chương cắt riêng

Màn hình: `VND-09` Sổ bảo đảm dự thầu (/vnd/vnd-09)

**Lời đọc**

> Sổ bảo đảm dự thầu theo dõi từng thư bảo lãnh. Thư đã nhận được nơi phát hành xác nhận bởi người thứ hai, rồi hoàn trả, hết hạn hoặc tịch thu. Một người đề xuất tịch thu, người khác quyết định trên văn bản. Nhà thầu có sự kiện uy tín phải bảo đảm cao hơn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sổ bảo đảm dự thầu theo dõi từng thư bảo lãnh. Thư đã nhận được nơi phát hành xác nhận bởi người thứ hai, rồi hoàn trả, hết hạn hoặc tịch thu. Một người đề xuất tịch thu, người khác quyết định trên văn bản. Nhà thầu có sự kiện uy tín phải bảo đảm cao hơn.

**Phụ đề**

- Sổ bảo đảm dự thầu theo / dõi từng thư bảo lãnh.
- Thư đã nhận được nơi phát / hành xác nhận bởi người
- thứ hai, rồi hoàn trả, / hết hạn hoặc tịch thu.
- Một người đề xuất tịch thu, người / khác quyết định trên văn bản.
- Nhà thầu có sự kiện uy / tín phải bảo đảm cao hơn.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=VND-09`
- `do=spot ref=vnd.bid-security.register`
- `do=spot ref=vnd.bid-security.forfeit-proposal`

**Cần thấy trên hình**

- [ ] Màn VND-09 "Sổ bảo đảm dự thầu" mở được ở đường dẫn /vnd/vnd-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần vnd.bid-security.register đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.bid-security.forfeit-proposal đúng lúc giọng đọc nói tới
- [ ] Chú thích "Đề xuất ≠ quyết định tịch thu" hiện từ giây 3, kéo dài 5 giây
- [ ] Sổ có các trạng thái đã nhận, đã xác nhận, hoàn trả, hết hạn, tịch thu
- [ ] Dòng đề xuất tịch thu chờ người thứ hai
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd2-risk-grade`

Nền tảng: web; 17.3 giây; chỉ trong chương cắt riêng

Màn hình: `VND-11` Hạng rủi ro nhà thầu (/vnd/vnd-11)

**Lời đọc**

> Mỗi nhà thầu có một hạng rủi ro tính từ tín hiệu có giải thích: chậm tiến độ, vi phạm, tài chính và tải. Hạng đang tính khác hạng đã xác nhận, và người xác nhận khác người chạy. Hạng giúp chọn việc kiểm tra, không loại nhà thầu một mình.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi nhà thầu có một hạng rủi ro tính từ tín hiệu có giải thích: chậm tiến độ, vi phạm, tài chính và tải. Hạng đang tính khác hạng đã xác nhận, và người xác nhận khác người chạy. Hạng giúp chọn việc kiểm tra, không loại nhà thầu một mình.

**Phụ đề**

- Mỗi nhà thầu có một hạng / rủi ro tính từ tín hiệu có
- giải thích: chậm tiến độ, / vi phạm, tài chính và tải.
- Hạng đang tính khác hạng đã xác nhận, / và người xác nhận khác người chạy.
- Hạng giúp chọn việc kiểm tra, / không loại nhà thầu một mình.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=VND-11`
- `do=spot ref=vnd.risk-grade.tier-column`
- `do=spot ref=vnd.risk-grade.signal-lines`

**Cần thấy trên hình**

- [ ] Màn VND-11 "Hạng rủi ro nhà thầu" mở được ở đường dẫn /vnd/vnd-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần vnd.risk-grade.tier-column đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.risk-grade.signal-lines đúng lúc giọng đọc nói tới
- [ ] Chú thích "Hạng rủi ro: đang tính và đã xác nhận" hiện từ giây 3, kéo dài 5 giây
- [ ] Cột hạng hiện cả hạng đã xác nhận và hạng đang tính
- [ ] Mỗi tín hiệu có lời giải thích
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd2-performance`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-37` Đề xuất xếp hạng thực hiện hợp đồng và phản hồi của nhà thầu (/ctr/ctr-37); `VND-12` Kết quả thực hiện hợp đồng và công khai (/vnd/vnd-12); `LLM-25` Đề xuất đánh giá thực hiện hợp đồng (/llm/llm-25)

**Lời đọc**

> Kết quả thực hiện hợp đồng được chấm theo bộ tiêu chí có trọng số. Trợ lý AI chỉ đề xuất điểm kèm dẫn chứng, người chấm quyết định, nhà thầu được phản hồi. Kết quả đủ điều kiện thì công khai theo quy định.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kết quả thực hiện hợp đồng được chấm theo bộ tiêu chí có trọng số. Trợ lý ây-ai chỉ đề xuất điểm kèm dẫn chứng, người chấm quyết định, nhà thầu được phản hồi. Kết quả đủ điều kiện thì công khai theo quy định.

**Phụ đề**

- Kết quả thực hiện hợp đồng được / chấm theo bộ tiêu chí có trọng số.
- Trợ lý AI chỉ đề xuất điểm kèm dẫn chứng,
- người chấm quyết định, / nhà thầu được phản hồi.
- Kết quả đủ điều kiện thì / công khai theo quy định.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-37`
- `do=spot ref=ctr.performance.proposal`
- `do=open screen=VND-12`
- `do=spot ref=vnd.performance.disclosure`
- `do=open screen=LLM-25`
- `do=spot ref=llm.performance.ai-suggestion`

**Cần thấy trên hình**

- [ ] Màn CTR-37 "Đề xuất xếp hạng thực hiện hợp đồng và phản hồi của nhà thầu" mở được ở đường dẫn /ctr/ctr-37, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-12 "Kết quả thực hiện hợp đồng và công khai" mở được ở đường dẫn /vnd/vnd-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-25 "Đề xuất đánh giá thực hiện hợp đồng" mở được ở đường dẫn /llm/llm-25, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.performance.proposal đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.performance.disclosure đúng lúc giọng đọc nói tới
- [ ] Khung vào phần llm.performance.ai-suggestion đúng lúc giọng đọc nói tới
- [ ] Chú thích "AI đề xuất, người quyết định" hiện từ giây 3, kéo dài 5 giây
- [ ] Đề xuất xếp hạng có dẫn chứng và ô phản hồi của nhà thầu
- [ ] Điểm AI nằm cạnh điểm người chấm, không thay thế
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd2-credentials`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `VND-05` Chứng chỉ và nhân sự chủ chốt (/vnd/vnd-05)

**Lời đọc**

> Chứng chỉ hành nghề và nhân sự chủ chốt của nhà thầu đều có ngày hết hạn. Sắp hết hạn thì cảnh báo tới đúng người phụ trách. Hồ sơ dự thầu dùng chứng chỉ đã hết hạn bị nêu rõ ngay khi chấm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chứng chỉ hành nghề và nhân sự chủ chốt của nhà thầu đều có ngày hết hạn. Sắp hết hạn thì cảnh báo tới đúng người phụ trách. Hồ sơ dự thầu dùng chứng chỉ đã hết hạn bị nêu rõ ngay khi chấm.

**Phụ đề**

- Chứng chỉ hành nghề và nhân sự chủ / chốt của nhà thầu đều có ngày hết hạn.
- Sắp hết hạn thì cảnh báo / tới đúng người phụ trách.
- Hồ sơ dự thầu dùng chứng chỉ đã / hết hạn bị nêu rõ ngay khi chấm.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=VND-05`
- `do=spot ref=vnd.credentials.expiry-column`
- `do=spot ref=vnd.credentials.key-staff`

**Cần thấy trên hình**

- [ ] Màn VND-05 "Chứng chỉ và nhân sự chủ chốt" mở được ở đường dẫn /vnd/vnd-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần vnd.credentials.expiry-column đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.credentials.key-staff đúng lúc giọng đọc nói tới
- [ ] Cột hạn hiện màu theo mức sắp hết hạn
- [ ] Danh sách nhân sự chủ chốt gắn với chứng chỉ
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd2-reputation`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `VND-06` Sự kiện uy tín dự thầu và liên danh (/vnd/vnd-06); `VND-03` Hồ sơ cấm tham gia đấu thầu (/vnd/vnd-03)

**Lời đọc**

> Sự kiện uy tín như bỏ thầu, từ chối ký hợp đồng hay vi phạm được ghi thành sổ, kể cả khi đi theo liên danh. Hồ sơ cấm tham gia đấu thầu đi đủ thủ tục. Có hiệu lực thì cổng chặn ở mọi khâu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sự kiện uy tín như bỏ thầu, từ chối ký hợp đồng hay vi phạm được ghi thành sổ, kể cả khi đi theo liên danh. Hồ sơ cấm tham gia đấu thầu đi đủ thủ tục. Có hiệu lực thì cổng chặn ở mọi khâu.

**Phụ đề**

- Sự kiện uy tín như bỏ thầu, / từ chối ký hợp đồng hay vi
- phạm được ghi thành sổ, kể / cả khi đi theo liên danh.
- Hồ sơ cấm tham gia đấu thầu đi đủ thủ tục.
- Có hiệu lực thì cổng chặn ở mọi khâu.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=VND-06`
- `do=spot ref=vnd.reputation.events`
- `do=open screen=VND-03`
- `do=spot ref=vnd.debarment.procedure`

**Cần thấy trên hình**

- [ ] Màn VND-06 "Sự kiện uy tín dự thầu và liên danh" mở được ở đường dẫn /vnd/vnd-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-03 "Hồ sơ cấm tham gia đấu thầu" mở được ở đường dẫn /vnd/vnd-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần vnd.reputation.events đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.debarment.procedure đúng lúc giọng đọc nói tới
- [ ] Sổ sự kiện có loại sự kiện và nhà thầu liên quan
- [ ] Hồ sơ cấm hiện các bước đề nghị, phản hồi, quyết định, hiệu lực
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd3-link-graph`

Nền tảng: web; 19.4 giây; chỉ trong chương cắt riêng

Màn hình: `VND-13` Đầu mối điều tra nhà thầu (/vnd/vnd-13); `VND-14` Chi tiết đầu mối và đồ thị liên kết (/vnd/vnd-14)

**Lời đọc**

> Cho kiểm toán viên, đồ thị liên kết nối các nhà thầu. Căn cứ là mã số thuế, địa chỉ, điện thoại, người đại diện, chủ sở hữu và dấu vết nộp hồ sơ. Hiện có {{figure:leads-new}} đầu mối mới. Đầu mối chỉ là tín hiệu điều tra, và người từng dự gói thầu bị chặn xem.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cho kiểm toán viên, đồ thị liên kết nối các nhà thầu. Căn cứ là mã số thuế, địa chỉ, điện thoại, người đại diện, chủ sở hữu và dấu vết nộp hồ sơ. Hiện có {{figure:leads-new}} đầu mối mới. Đầu mối chỉ là tín hiệu điều tra, và người từng dự gói thầu bị chặn xem.

**Phụ đề**

- Cho kiểm toán viên, đồ thị / liên kết nối các nhà thầu.
- Căn cứ là mã số thuế, địa chỉ, điện thoại,
- người đại diện, chủ sở / hữu và dấu vết nộp hồ sơ.
- Hiện có {n} đầu mối mới.
- Đầu mối chỉ là tín hiệu điều tra, và / người từng dự gói thầu bị chặn xem.

**Các bước quay**

- `do=as persona=auditor`
- `do=open screen=VND-13`
- `do=spot ref=vnd.leads.ranked-list`
- `do=open screen=VND-14`
- `do=spot ref=vnd.link-graph.graph`
- `do=spot ref=vnd.link-graph.table-fallback`

**Cần thấy trên hình**

- [ ] Màn VND-13 "Đầu mối điều tra nhà thầu" mở được ở đường dẫn /vnd/vnd-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-14 "Chi tiết đầu mối và đồ thị liên kết" mở được ở đường dẫn /vnd/vnd-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản auditor
- [ ] Khung vào phần vnd.leads.ranked-list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.link-graph.graph đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.link-graph.table-fallback đúng lúc giọng đọc nói tới
- [ ] Chú thích "Tín hiệu để điều tra, không phải kết luận" hiện từ giây 3, kéo dài 6 giây
- [ ] Con số leads-new đọc từ dữ liệu thật qua listVendorLeads (counts.new); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Đồ thị và bảng thay thế cùng hiện
- [ ] Bằng chứng chỉ hiện dấu vân tay ngắn, không hiện dữ liệu gốc
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `vnd3-screening`

Nền tảng: web; 23.4 giây; chỉ trong chương cắt riêng

Màn hình: `VND-15` Sàng lọc liên tục danh sách bên bị cấm (/vnd/vnd-15)

**Lời đọc**

> Hệ thống sàng lọc liên tục nhà thầu với danh sách bên bị cấm: mỗi đêm, khi hồ sơ đổi và sau mỗi lần nhập tệp. Trùng mã số thuế là căn cứ quyết định, chỉ trùng tên thì mới là có thể. Hiện có {{figure:screening-pending}} kết quả chờ xử lý. Kết quả cao đặt nhà thầu vào diện tạm giữ cho đến khi người khác xác nhận hoặc bác.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hệ thống sàng lọc liên tục nhà thầu với danh sách bên bị cấm: mỗi đêm, khi hồ sơ đổi và sau mỗi lần nhập tệp. Trùng mã số thuế là căn cứ quyết định, chỉ trùng tên thì mới là có thể. Hiện có {{figure:screening-pending}} kết quả chờ xử lý. Kết quả cao đặt nhà thầu vào diện tạm giữ cho đến khi người khác xác nhận hoặc bác.

**Phụ đề**

- Hệ thống sàng lọc liên tục nhà / thầu với danh sách bên bị cấm:
- mỗi đêm, khi hồ sơ đổi / và sau mỗi lần nhập tệp.
- Trùng mã số thuế là căn cứ quyết / định, chỉ trùng tên thì mới là có thể.
- Hiện có {n} kết quả chờ xử lý.
- Kết quả cao đặt nhà thầu vào diện tạm giữ
- cho đến khi người khác xác nhận hoặc bác.

**Các bước quay**

- `do=as persona=auditor`
- `do=open screen=VND-15`
- `do=spot ref=vnd.screening.hits`
- `do=spot ref=vnd.screening.runs`

**Cần thấy trên hình**

- [ ] Màn VND-15 "Sàng lọc liên tục danh sách bên bị cấm" mở được ở đường dẫn /vnd/vnd-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản auditor
- [ ] Khung vào phần vnd.screening.hits đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.screening.runs đúng lúc giọng đọc nói tới
- [ ] Chú thích "Tạm giữ chờ người thứ hai xác nhận" hiện từ giây 4, kéo dài 6 giây
- [ ] Con số screening-pending đọc từ dữ liệu thật qua getVendorScreening (counts.pending); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Bảng kết quả có điểm khớp và căn cứ khớp
- [ ] Các lần chạy sàng lọc hiện thời gian và nguồn danh sách
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Cổng nhà thầu (`contractor-portal`)

### `portal-home`

Nền tảng: web; 18.2 giây; chỉ trong chương cắt riêng

Màn hình: `VND-16` Cổng nhà thầu: hồ sơ của tôi (/vnd/vnd-16)

**Lời đọc**

> Nhà thầu có cổng riêng và chỉ thấy hồ sơ của chính mình. Trang đầu nêu việc cần làm: yêu cầu chờ trả lời, chứng chỉ sắp hết hạn và tái xác nhận hằng năm. Dữ liệu của nhà thầu khác, chỉ báo đáng ngờ và đầu mối điều tra không bao giờ hiện.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Nhà thầu có cổng riêng và chỉ thấy hồ sơ của chính mình. Trang đầu nêu việc cần làm: yêu cầu chờ trả lời, chứng chỉ sắp hết hạn và tái xác nhận hằng năm. Dữ liệu của nhà thầu khác, chỉ báo đáng ngờ và đầu mối điều tra không bao giờ hiện.

**Phụ đề**

- Nhà thầu có cổng riêng và chỉ / thấy hồ sơ của chính mình.
- Trang đầu nêu việc cần / làm: yêu cầu chờ trả lời,
- chứng chỉ sắp hết hạn và / tái xác nhận hằng năm.
- Dữ liệu của nhà thầu / khác, chỉ báo đáng ngờ
- và đầu mối điều tra không bao giờ hiện.

**Các bước quay**

- `do=as persona=contractorUser`
- `do=open screen=VND-16`
- `do=spot ref=vnd.portal.my-profile`
- `do=spot ref=vnd.portal.reconfirmation`

**Cần thấy trên hình**

- [ ] Màn VND-16 "Cổng nhà thầu: hồ sơ của tôi" mở được ở đường dẫn /vnd/vnd-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản contractorUser
- [ ] Khung vào phần vnd.portal.my-profile đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.portal.reconfirmation đúng lúc giọng đọc nói tới
- [ ] Chú thích "Chỉ thấy dữ liệu của chính mình" hiện từ giây 3, kéo dài 5 giây
- [ ] Tài khoản đăng nhập là thành viên khách gắn với một nhà thầu
- [ ] Không có dữ liệu của nhà thầu khác trên màn hình
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `portal-requests`

Nền tảng: web; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `VND-17` Cổng nhà thầu: yêu cầu và trả lời (/vnd/vnd-17)

**Lời đọc**

> Bên mời thầu hỏi, nhà thầu trả lời ngay trên cổng và trong thời hạn. Mỗi yêu cầu có đồng hồ, tệp đính kèm và lịch sử. Tỷ lệ trả lời đúng hạn được tính cho cả hai phía.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bên mời thầu hỏi, nhà thầu trả lời ngay trên cổng và trong thời hạn. Mỗi yêu cầu có đồng hồ, tệp đính kèm và lịch sử. Tỷ lệ trả lời đúng hạn được tính cho cả hai phía.

**Phụ đề**

- Bên mời thầu hỏi, nhà thầu trả lời / ngay trên cổng và trong thời hạn.
- Mỗi yêu cầu có đồng hồ, / tệp đính kèm và lịch sử.
- Tỷ lệ trả lời đúng hạn / được tính cho cả hai phía.

**Các bước quay**

- `do=as persona=contractorUser`
- `do=open screen=VND-17`
- `do=spot ref=vnd.portal.requests-list`
- `do=click ref=vnd.portal.reply`

**Cần thấy trên hình**

- [ ] Màn VND-17 "Cổng nhà thầu: yêu cầu và trả lời" mở được ở đường dẫn /vnd/vnd-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản contractorUser
- [ ] Khung vào phần vnd.portal.requests-list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.portal.reply đúng lúc giọng đọc nói tới
- [ ] Mỗi yêu cầu hiện hạn trả lời còn lại
- [ ] Ô trả lời đính kèm được tệp
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `portal-certificates`

Nền tảng: web; 11.5 giây; chỉ trong chương cắt riêng

Màn hình: `VND-18` Cổng nhà thầu: chứng chỉ (/vnd/vnd-18); `VND-24` Tệp đính kèm trên cổng nhà thầu (/vnd/vnd-24)

**Lời đọc**

> Nhà thầu tự tải chứng chỉ mới lên cổng. Tệp có giới hạn loại và dung lượng. Cán bộ của bên mời thầu xác minh, rồi chứng chỉ mới có hiệu lực.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Nhà thầu tự tải chứng chỉ mới lên cổng. Tệp có giới hạn loại và dung lượng. Cán bộ của bên mời thầu xác minh, rồi chứng chỉ mới có hiệu lực.

**Phụ đề**

- Nhà thầu tự tải chứng chỉ mới lên cổng.
- Tệp có giới hạn loại và dung lượng.
- Cán bộ của bên mời thầu xác minh, / rồi chứng chỉ mới có hiệu lực.

**Các bước quay**

- `do=as persona=contractorUser`
- `do=open screen=VND-18`
- `do=spot ref=vnd.portal.certificates`
- `do=open screen=VND-24`
- `do=spot ref=vnd.portal.attachments-limits`

**Cần thấy trên hình**

- [ ] Màn VND-18 "Cổng nhà thầu: chứng chỉ" mở được ở đường dẫn /vnd/vnd-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-24 "Tệp đính kèm trên cổng nhà thầu" mở được ở đường dẫn /vnd/vnd-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản contractorUser
- [ ] Khung vào phần vnd.portal.certificates đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.portal.attachments-limits đúng lúc giọng đọc nói tới
- [ ] Danh sách chứng chỉ có trạng thái chờ xác minh
- [ ] Giới hạn tệp hiện trên màn hình
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `portal-evaluations`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `VND-19` Cổng nhà thầu: đánh giá và kế hoạch khắc phục (/vnd/vnd-19); `VND-21` Kế hoạch khắc phục của nhà thầu (/vnd/vnd-21)

**Lời đọc**

> Nhà thầu xem đánh giá thực hiện hợp đồng của mình và phản hồi trong thời hạn. Khi bị xếp thấp, nhà thầu nộp kế hoạch khắc phục. Bên mời thầu theo dõi từng bước cho đến khi hoàn tất.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Nhà thầu xem đánh giá thực hiện hợp đồng của mình và phản hồi trong thời hạn. Khi bị xếp thấp, nhà thầu nộp kế hoạch khắc phục. Bên mời thầu theo dõi từng bước cho đến khi hoàn tất.

**Phụ đề**

- Nhà thầu xem đánh giá thực hiện hợp đồng / của mình và phản hồi trong thời hạn.
- Khi bị xếp thấp, nhà thầu / nộp kế hoạch khắc phục.
- Bên mời thầu theo dõi từng / bước cho đến khi hoàn tất.

**Các bước quay**

- `do=as persona=contractorUser`
- `do=open screen=VND-19`
- `do=spot ref=vnd.portal.my-evaluations`
- `do=open screen=VND-21`
- `do=spot ref=vnd.portal.remediation-plan`

**Cần thấy trên hình**

- [ ] Màn VND-19 "Cổng nhà thầu: đánh giá và kế hoạch khắc phục" mở được ở đường dẫn /vnd/vnd-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-21 "Kế hoạch khắc phục của nhà thầu" mở được ở đường dẫn /vnd/vnd-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản contractorUser
- [ ] Khung vào phần vnd.portal.my-evaluations đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.portal.remediation-plan đúng lúc giọng đọc nói tới
- [ ] Đánh giá có ô phản hồi của nhà thầu
- [ ] Kế hoạch khắc phục hiện các bước và hạn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `portal-petitions`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `VND-22` Kiến nghị, claim và xuất OCDS của nhà thầu (/vnd/vnd-22); `BID-34` Kết quả giải quyết kiến nghị của nhà thầu (/bid/bid-34)

**Lời đọc**

> Kiến nghị và claim của nhà thầu có thống kê riêng: số kiến nghị, kết quả giải quyết và thời gian xử lý. Danh sách các bên của hợp đồng xuất được theo chuẩn dữ liệu mở về hợp đồng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kiến nghị và cờ-lêm của nhà thầu có thống kê riêng: số kiến nghị, kết quả giải quyết và thời gian xử lý. Danh sách các bên của hợp đồng xuất được theo chuẩn dữ liệu mở về hợp đồng.

**Phụ đề**

- Kiến nghị và claim của nhà / thầu có thống kê riêng:
- số kiến nghị, kết quả giải / quyết và thời gian xử lý.
- Danh sách các bên của hợp đồng xuất / được theo chuẩn dữ liệu mở về hợp đồng.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=VND-22`
- `do=spot ref=vnd.petitions.statistics`
- `do=open screen=BID-34`
- `do=spot ref=bid.petitions.outcomes`

**Cần thấy trên hình**

- [ ] Màn VND-22 "Kiến nghị, claim và xuất OCDS của nhà thầu" mở được ở đường dẫn /vnd/vnd-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-34 "Kết quả giải quyết kiến nghị của nhà thầu" mở được ở đường dẫn /bid/bid-34, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần vnd.petitions.statistics đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.petitions.outcomes đúng lúc giọng đọc nói tới
- [ ] Thống kê kiến nghị theo kết quả và thời gian xử lý
- [ ] Nút xuất danh sách các bên
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `portal-admin`

Nền tảng: web; 16.6 giây; chỉ trong chương cắt riêng

Màn hình: `VND-20` Quản lý cổng nhà thầu (/vnd/vnd-20); `VND-23` Lời mời vào cổng nhà thầu (/vnd/vnd-23)

**Lời đọc**

> Phía quản trị mời nhà thầu bằng thư mời có hạn, bật hoặc khóa cổng và đặt giới hạn tệp. Nhà thầu là thành viên khách gắn với đúng một nhà thầu. Mọi thao tác lấy nhà thầu từ tài khoản, không bao giờ từ nội dung yêu cầu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Phía quản trị mời nhà thầu bằng thư mời có hạn, bật hoặc khóa cổng và đặt giới hạn tệp. Nhà thầu là thành viên khách gắn với đúng một nhà thầu. Mọi thao tác lấy nhà thầu từ tài khoản, không bao giờ từ nội dung yêu cầu.

**Phụ đề**

- Phía quản trị mời nhà / thầu bằng thư mời có hạn,
- bật hoặc khóa cổng và đặt giới hạn tệp.
- Nhà thầu là thành viên khách / gắn với đúng một nhà thầu.
- Mọi thao tác lấy nhà thầu từ tài khoản, / không bao giờ từ nội dung yêu cầu.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=VND-20`
- `do=spot ref=vnd.portal.settings`
- `do=open screen=VND-23`
- `do=spot ref=vnd.portal.invitations`

**Cần thấy trên hình**

- [ ] Màn VND-20 "Quản lý cổng nhà thầu" mở được ở đường dẫn /vnd/vnd-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-23 "Lời mời vào cổng nhà thầu" mở được ở đường dẫn /vnd/vnd-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần vnd.portal.settings đúng lúc giọng đọc nói tới
- [ ] Khung vào phần vnd.portal.invitations đúng lúc giọng đọc nói tới
- [ ] Danh sách thư mời có hạn dùng
- [ ] Công tắc bật hoặc khóa cổng của từng nhà thầu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Claim và cảnh báo sớm hợp đồng (`claims-warnings`)

### `claims-register`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-32` Sổ claim hợp đồng (/ctr/ctr-32)

**Lời đọc**

> Sổ claim ghi mọi claim của chủ đầu tư và của nhà thầu: loại, ngày xảy ra, ngày biết, số tiền và số ngày yêu cầu. Hiện có {{figure:claims-open}} claim đang mở. Mỗi claim có dòng thời gian chỉ thêm, không sửa.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sổ cờ-lêm ghi mọi cờ-lêm của chủ đầu tư và của nhà thầu: loại, ngày xảy ra, ngày biết, số tiền và số ngày yêu cầu. Hiện có {{figure:claims-open}} cờ-lêm đang mở. Mỗi cờ-lêm có dòng thời gian chỉ thêm, không sửa.

**Phụ đề**

- Sổ claim ghi mọi claim của / chủ đầu tư và của nhà thầu:
- loại, ngày xảy ra, ngày biết, / số tiền và số ngày yêu cầu.
- Hiện có {n} claim đang mở.
- Mỗi claim có dòng thời / gian chỉ thêm, không sửa.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-32`
- `do=spot ref=ctr.claims.register`
- `do=spot ref=ctr.claims.timeline`

**Cần thấy trên hình**

- [ ] Màn CTR-32 "Sổ claim hợp đồng" mở được ở đường dẫn /ctr/ctr-32, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.claims.register đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.claims.timeline đúng lúc giọng đọc nói tới
- [ ] Con số claims-open đọc từ dữ liệu thật qua listClaims (totals.open); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Sổ có bên yêu cầu, loại claim, trạng thái và hạn gần nhất
- [ ] Tổng hợp trên đầu bảng khớp với số dòng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `claims-limitation`

Nền tảng: web; 18.2 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-33` Hồ sơ claim và đồng hồ thời hiệu (/ctr/ctr-33); `CTR-34` Điều khoản thời hiệu claim của hợp đồng (/ctr/ctr-34)

**Lời đọc**

> Thời hiệu của claim lấy từ điều khoản đã duyệt của chính hợp đồng, một người đề xuất và người khác duyệt. Hợp đồng chưa có điều khoản thì ghi rõ là chưa có đồng hồ, hiện có {{figure:claims-no-term}} trường hợp. Các mốc thông báo là cấu hình mặc định, chưa kiểm chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Thời hiệu của cờ-lêm lấy từ điều khoản đã duyệt của chính hợp đồng, một người đề xuất và người khác duyệt. Hợp đồng chưa có điều khoản thì ghi rõ là chưa có đồng hồ, hiện có {{figure:claims-no-term}} trường hợp. Các mốc thông báo là cấu hình mặc định, chưa kiểm chứng.

**Phụ đề**

- Thời hiệu của claim lấy / từ điều khoản đã duyệt của
- chính hợp đồng, một người / đề xuất và người khác duyệt.
- Hợp đồng chưa có điều khoản thì ghi rõ là / chưa có đồng hồ, hiện có {n} trường hợp.
- Các mốc thông báo là cấu hình / mặc định, chưa kiểm chứng.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-33`
- `do=spot ref=ctr.claims.limitation-clock`
- `do=open screen=CTR-34`
- `do=spot ref=ctr.claims.term-approval`

**Cần thấy trên hình**

- [ ] Màn CTR-33 "Hồ sơ claim và đồng hồ thời hiệu" mở được ở đường dẫn /ctr/ctr-33, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-34 "Điều khoản thời hiệu claim của hợp đồng" mở được ở đường dẫn /ctr/ctr-34, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.claims.limitation-clock đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.claims.term-approval đúng lúc giọng đọc nói tới
- [ ] Chú thích "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng" hiện từ giây 3, kéo dài 7 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng"
- [ ] Con số claims-no-term đọc từ dữ liệu thật qua listClaims (totals.without_term); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Đồng hồ thời hiệu hiện số ngày còn lại hoặc nhãn chưa có điều khoản
- [ ] Dấu chưa kiểm chứng hiện trên hình
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `warnings-register`

Nền tảng: web; 21.5 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-35` Sổ cảnh báo sớm hợp đồng (/ctr/ctr-35); `CTR-36` Hồ sơ cảnh báo sớm (/ctr/ctr-36)

**Lời đọc**

> Sổ cảnh báo sớm hợp đồng khác với cảnh báo giải ngân. Bên nào cũng được nêu rủi ro, rồi đánh giá tác động bằng một con số hoặc ghi rõ là không tác động. Có {{figure:warnings-open}} cảnh báo mở, trong đó {{figure:warnings-no-owner}} chưa có người phụ trách. Mỗi biện pháp có người và ngày, và cuộc họp phải rà từng cảnh báo mở.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sổ cảnh báo sớm hợp đồng khác với cảnh báo giải ngân. Bên nào cũng được nêu rủi ro, rồi đánh giá tác động bằng một con số hoặc ghi rõ là không tác động. Có {{figure:warnings-open}} cảnh báo mở, trong đó {{figure:warnings-no-owner}} chưa có người phụ trách. Mỗi biện pháp có người và ngày, và cuộc họp phải rà từng cảnh báo mở.

**Phụ đề**

- Sổ cảnh báo sớm hợp đồng / khác với cảnh báo giải ngân.
- Bên nào cũng được nêu rủi / ro, rồi đánh giá tác động
- bằng một con số hoặc ghi / rõ là không tác động.
- Có {n} cảnh báo mở, trong đó / {n} chưa có người phụ trách.
- Mỗi biện pháp có người và ngày, và / cuộc họp phải rà từng cảnh báo mở.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-35`
- `do=spot ref=ctr.warnings.register`
- `do=open screen=CTR-36`
- `do=spot ref=ctr.warnings.assessment`

**Cần thấy trên hình**

- [ ] Màn CTR-35 "Sổ cảnh báo sớm hợp đồng" mở được ở đường dẫn /ctr/ctr-35, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-36 "Hồ sơ cảnh báo sớm" mở được ở đường dẫn /ctr/ctr-36, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.warnings.register đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.warnings.assessment đúng lúc giọng đọc nói tới
- [ ] Con số warnings-open đọc từ dữ liệu thật qua listContractEarlyWarnings (summary.open); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số warnings-no-owner đọc từ dữ liệu thật qua listContractEarlyWarnings (summary.without_owner); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Cảnh báo có phân loại, bên nêu và mức tác động
- [ ] Danh sách biện pháp có người phụ trách và hạn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `contract-settlement-clocks`

Nền tảng: web; 19.4 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-38` Đồng hồ quyết toán hợp đồng 5 tháng và 4 tháng (/ctr/ctr-38); `CTR-39` Liên kết hợp đồng với dự án, gói thầu, nhà thầu và phiên bản điều chỉnh (/ctr/ctr-39)

**Lời đọc**

> Đồng hồ quyết toán hợp đồng cho biết còn bao nhiêu ngày đến hạn, và đã đạt hạn hay chưa. Liên kết hợp đồng với dự án, gói thầu, nhà thầu và phiên bản điều chỉnh cho thấy một thay đổi ảnh hưởng đến đâu. Thời hạn trong quy định là cấu hình mặc định, chưa kiểm chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đồng hồ quyết toán hợp đồng cho biết còn bao nhiêu ngày đến hạn, và đã đạt hạn hay chưa. Liên kết hợp đồng với dự án, gói thầu, nhà thầu và phiên bản điều chỉnh cho thấy một thay đổi ảnh hưởng đến đâu. Thời hạn trong quy định là cấu hình mặc định, chưa kiểm chứng.

**Phụ đề**

- Đồng hồ quyết toán hợp / đồng cho biết còn bao
- nhiêu ngày đến hạn, và / đã đạt hạn hay chưa.
- Liên kết hợp đồng với dự án, / gói thầu, nhà thầu và phiên
- bản điều chỉnh cho thấy một / thay đổi ảnh hưởng đến đâu.
- Thời hạn trong quy định là cấu / hình mặc định, chưa kiểm chứng.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-38`
- `do=spot ref=ctr.settlement.clock-list`
- `do=open screen=CTR-39`
- `do=spot ref=ctr.links.contract-map`

**Cần thấy trên hình**

- [ ] Màn CTR-38 "Đồng hồ quyết toán hợp đồng 5 tháng và 4 tháng" mở được ở đường dẫn /ctr/ctr-38, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-39 "Liên kết hợp đồng với dự án, gói thầu, nhà thầu và phiên bản điều chỉnh" mở được ở đường dẫn /ctr/ctr-39, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.settlement.clock-list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.links.contract-map đúng lúc giọng đọc nói tới
- [ ] Chú thích "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng" hiện từ giây 3, kéo dài 7 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng"
- [ ] Cột trạng thái đồng hồ: còn hạn, sắp đến, quá hạn, đã đạt
- [ ] Sơ đồ liên kết hợp đồng mở được từng liên kết
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `protests`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `BID-20` Kiến nghị và xung đột lợi ích (/bid/bid-20); `BID-34` Kết quả giải quyết kiến nghị của nhà thầu (/bid/bid-34)

**Lời đọc**

> Kiến nghị trong lựa chọn nhà thầu đi theo thủ tục và có hạn giải quyết. Kết quả giải quyết được ghi lại và tính thống kê. Người dự gói thầu khai xung đột lợi ích trước, và việc khai được kiểm khi chấm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kiến nghị trong lựa chọn nhà thầu đi theo thủ tục và có hạn giải quyết. Kết quả giải quyết được ghi lại và tính thống kê. Người dự gói thầu khai xung đột lợi ích trước, và việc khai được kiểm khi chấm.

**Phụ đề**

- Kiến nghị trong lựa chọn nhà thầu đi / theo thủ tục và có hạn giải quyết.
- Kết quả giải quyết được / ghi lại và tính thống kê.
- Người dự gói thầu khai xung đột lợi ích / trước, và việc khai được kiểm khi chấm.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-20`
- `do=spot ref=bid.protests.list`
- `do=open screen=BID-34`
- `do=spot ref=bid.protests.outcome`

**Cần thấy trên hình**

- [ ] Màn BID-20 "Kiến nghị và xung đột lợi ích" mở được ở đường dẫn /bid/bid-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-34 "Kết quả giải quyết kiến nghị của nhà thầu" mở được ở đường dẫn /bid/bid-34, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.protests.list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.protests.outcome đúng lúc giọng đọc nói tới
- [ ] Kiến nghị có hạn giải quyết và người xử lý
- [ ] Khai xung đột lợi ích gắn với gói thầu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Cảnh báo nâng cao và leo thang (`alerts-plus`)

### `al-escalation-policy`

Nền tảng: web; 16.3 giây; chỉ trong chương cắt riêng

Màn hình: `NOT-19` Leo thang cảnh báo (/not/not-19)

**Lời đọc**

> Cảnh báo không ai xử lý sẽ leo thang theo chính sách: trước hết lên người phụ trách chức năng, rồi lên lãnh đạo trực tiếp theo cây tổ chức. Quyền duyệt vẫn theo ma trận thẩm quyền. Leo thang chỉ chuyển sự chú ý, không chuyển quyền.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cảnh báo không ai xử lý sẽ leo thang theo chính sách: trước hết lên người phụ trách chức năng, rồi lên lãnh đạo trực tiếp theo cây tổ chức. Quyền duyệt vẫn theo ma trận thẩm quyền. Leo thang chỉ chuyển sự chú ý, không chuyển quyền.

**Phụ đề**

- Cảnh báo không ai xử lý sẽ leo / thang theo chính sách: trước hết lên
- người phụ trách chức năng, rồi lên / lãnh đạo trực tiếp theo cây tổ chức.
- Quyền duyệt vẫn theo ma trận thẩm quyền.
- Leo thang chỉ chuyển sự / chú ý, không chuyển quyền.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=NOT-19`
- `do=spot ref=not.escalation.levels`
- `do=spot ref=not.escalation.promoted-list`

**Cần thấy trên hình**

- [ ] Màn NOT-19 "Leo thang cảnh báo" mở được ở đường dẫn /not/not-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần not.escalation.levels đúng lúc giọng đọc nói tới
- [ ] Khung vào phần not.escalation.promoted-list đúng lúc giọng đọc nói tới
- [ ] Chú thích "Leo thang chuyển chú ý, không chuyển quyền" hiện từ giây 3, kéo dài 5 giây
- [ ] Các mức leo thang hiện thời gian chờ từng mức
- [ ] Danh sách cảnh báo đã được đẩy lên mức cao hơn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-channel-ladder`

Nền tảng: web; 19.1 giây; chỉ trong chương cắt riêng

Màn hình: `NOT-30` Thang kênh và biên nhận cảnh báo (/not/not-30); `NOT-12` Chi tiết hành trình gửi (/not/not-12)

**Lời đọc**

> Kênh gửi đi theo thang: trước trong ứng dụng, rồi thông báo đẩy, thư điện tử và tin nhắn khi quá hạn. Mỗi lần gửi có biên nhận và người nhận xác nhận đã đọc. Thông báo đẩy chỉ mang một câu cố định, một con số và một đường dẫn, không mang nội dung nhạy cảm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kênh gửi đi theo thang: trước trong ứng dụng, rồi thông báo đẩy, thư điện tử và tin nhắn khi quá hạn. Mỗi lần gửi có biên nhận và người nhận xác nhận đã đọc. Thông báo đẩy chỉ mang một câu cố định, một con số và một đường dẫn, không mang nội dung nhạy cảm.

**Phụ đề**

- Kênh gửi đi theo thang: / trước trong ứng dụng,
- rồi thông báo đẩy, thư điện / tử và tin nhắn khi quá hạn.
- Mỗi lần gửi có biên nhận và / người nhận xác nhận đã đọc.
- Thông báo đẩy chỉ mang một câu cố định,
- một con số và một đường dẫn, / không mang nội dung nhạy cảm.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=NOT-30`
- `do=spot ref=not.ladder.steps`
- `do=spot ref=not.ladder.receipts`
- `do=open screen=NOT-12`
- `do=spot ref=not.delivery.journey`

**Cần thấy trên hình**

- [ ] Màn NOT-30 "Thang kênh và biên nhận cảnh báo" mở được ở đường dẫn /not/not-30, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn NOT-12 "Chi tiết hành trình gửi" mở được ở đường dẫn /not/not-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần not.ladder.steps đúng lúc giọng đọc nói tới
- [ ] Khung vào phần not.ladder.receipts đúng lúc giọng đọc nói tới
- [ ] Khung vào phần not.delivery.journey đúng lúc giọng đọc nói tới
- [ ] Thang kênh hiện thứ tự và thời gian chờ
- [ ] Hành trình gửi của một thông báo có biên nhận
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-my-profile`

Nền tảng: web; 13 giây; chỉ trong chương cắt riêng

Màn hình: `NOT-18` Hồ sơ thông báo cảnh báo của tôi (/not/not-18); `NOT-03` Tùy chọn nhận tin (/not/not-03)

**Lời đọc**

> Mỗi người đặt cách nhận cảnh báo của mình: mức độ, kênh, giờ yên lặng và bản tóm tắt hằng ngày. Loại cảnh báo khẩn có thể được phép xuyên giờ yên lặng nếu quy tắc cho phép.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi người đặt cách nhận cảnh báo của mình: mức độ, kênh, giờ yên lặng và bản tóm tắt hằng ngày. Loại cảnh báo khẩn có thể được phép xuyên giờ yên lặng nếu quy tắc cho phép.

**Phụ đề**

- Mỗi người đặt cách nhận / cảnh báo của mình: mức độ,
- kênh, giờ yên lặng và / bản tóm tắt hằng ngày.
- Loại cảnh báo khẩn có thể được phép / xuyên giờ yên lặng nếu quy tắc cho phép.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=NOT-18`
- `do=spot ref=not.profile.settings`
- `do=open screen=NOT-03`
- `do=spot ref=not.profile.quiet-hours`

**Cần thấy trên hình**

- [ ] Màn NOT-18 "Hồ sơ thông báo cảnh báo của tôi" mở được ở đường dẫn /not/not-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn NOT-03 "Tùy chọn nhận tin" mở được ở đường dẫn /not/not-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần not.profile.settings đúng lúc giọng đọc nói tới
- [ ] Khung vào phần not.profile.quiet-hours đúng lúc giọng đọc nói tới
- [ ] Cài đặt giờ yên lặng và kênh
- [ ] Bản tóm tắt hằng ngày
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-wrong-feedback`

Nền tảng: web; 17 giây; chỉ trong chương cắt riêng

Màn hình: `HOME-30` Phản hồi cảnh báo không đúng (/home/home-30); `HOME-31` Cảnh báo đã đóng, mở lại và lũ cảnh báo (/home/home-31)

**Lời đọc**

> Cảnh báo sai thì người nhận bấm là không đúng, kèm lý do. Hàng chờ rà soát xem xét và chỉnh ngưỡng. Cảnh báo tự đóng khi điều kiện hết và mở lại nếu tái phát. Cảnh báo dồn dập được gộp lại để không làm ngập người nhận.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cảnh báo sai thì người nhận bấm là không đúng, kèm lý do. Hàng chờ rà soát xem xét và chỉnh ngưỡng. Cảnh báo tự đóng khi điều kiện hết và mở lại nếu tái phát. Cảnh báo dồn dập được gộp lại để không làm ngập người nhận.

**Phụ đề**

- Cảnh báo sai thì người nhận / bấm là không đúng, kèm lý do.
- Hàng chờ rà soát xem xét và chỉnh ngưỡng.
- Cảnh báo tự đóng khi điều kiện / hết và mở lại nếu tái phát.
- Cảnh báo dồn dập được gộp lại / để không làm ngập người nhận.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=HOME-30`
- `do=spot ref=home.feedback.queue`
- `do=open screen=HOME-31`
- `do=spot ref=home.lifecycle.closed-reopened`
- `do=spot ref=home.lifecycle.flood-group`

**Cần thấy trên hình**

- [ ] Màn HOME-30 "Phản hồi cảnh báo không đúng" mở được ở đường dẫn /home/home-30, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn HOME-31 "Cảnh báo đã đóng, mở lại và lũ cảnh báo" mở được ở đường dẫn /home/home-31, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần home.feedback.queue đúng lúc giọng đọc nói tới
- [ ] Khung vào phần home.lifecycle.closed-reopened đúng lúc giọng đọc nói tới
- [ ] Khung vào phần home.lifecycle.flood-group đúng lúc giọng đọc nói tới
- [ ] Hàng chờ phản hồi có lý do của người nhận
- [ ] Nhóm cảnh báo bị gộp vì dồn dập
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-deferred`

Nền tảng: web; 14.8 giây; chỉ trong chương cắt riêng

Màn hình: `HOME-12` Việc đang bị hoãn (/home/home-12); `HOME-03` Cảnh báo sớm (/home/home-03)

**Lời đọc**

> Việc bị hoãn không biến mất. Màn riêng liệt kê việc đã hoãn kèm lý do và ngày xem lại. Quy tắc cảnh báo sớm hiện ngưỡng đang áp dụng và nguồn của ngưỡng, để người xem biết vì sao hệ thống báo.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Việc bị hoãn không biến mất. Màn riêng liệt kê việc đã hoãn kèm lý do và ngày xem lại. Quy tắc cảnh báo sớm hiện ngưỡng đang áp dụng và nguồn của ngưỡng, để người xem biết vì sao hệ thống báo.

**Phụ đề**

- Việc bị hoãn không biến mất.
- Màn riêng liệt kê việc đã hoãn / kèm lý do và ngày xem lại.
- Quy tắc cảnh báo sớm hiện / ngưỡng đang áp dụng và nguồn
- của ngưỡng, để người xem / biết vì sao hệ thống báo.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=HOME-12`
- `do=spot ref=home.deferred.list`
- `do=open screen=HOME-03`
- `do=spot ref=home.early-warning.rules`

**Cần thấy trên hình**

- [ ] Màn HOME-12 "Việc đang bị hoãn" mở được ở đường dẫn /home/home-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn HOME-03 "Cảnh báo sớm" mở được ở đường dẫn /home/home-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần home.deferred.list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần home.early-warning.rules đúng lúc giọng đọc nói tới
- [ ] Việc hoãn có ngày xem lại
- [ ] Mỗi quy tắc có công thức, nguồn và ngày hiệu lực
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Ủy quyền, làm thay và vắng mặt (`delegation`)

### `del-permanent`

Nền tảng: web; 19.4 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-04` Ủy quyền có thời hạn (/adm/adm-04); `ADM-25` Ủy quyền vĩnh viễn (/adm/adm-25)

**Lời đọc**

> Ủy quyền vĩnh viễn là một yêu cầu. Người ủy quyền đề nghị, người thứ ba duyệt, không phải người ủy quyền cũng không phải người được ủy quyền. Ngày xem xét lại là hạn hiệu lực, quá hạn mà không xem xét thì ủy quyền dừng ngay. Vòng ủy quyền giữa các người bị từ chối.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Ủy quyền vĩnh viễn là một yêu cầu. Người ủy quyền đề nghị, người thứ ba duyệt, không phải người ủy quyền cũng không phải người được ủy quyền. Ngày xem xét lại là hạn hiệu lực, quá hạn mà không xem xét thì ủy quyền dừng ngay. Vòng ủy quyền giữa các người bị từ chối.

**Phụ đề**

- Ủy quyền vĩnh viễn là một yêu cầu.
- Người ủy quyền đề nghị, / người thứ ba duyệt,
- không phải người ủy quyền cũng / không phải người được ủy quyền.
- Ngày xem xét lại là hạn hiệu lực, quá hạn / mà không xem xét thì ủy quyền dừng ngay.
- Vòng ủy quyền giữa các người bị từ chối.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=ADM-04`
- `do=spot ref=adm.delegation.temporary`
- `do=open screen=ADM-25`
- `do=spot ref=adm.delegation.permanent-request`

**Cần thấy trên hình**

- [ ] Màn ADM-04 "Ủy quyền có thời hạn" mở được ở đường dẫn /adm/adm-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-25 "Ủy quyền vĩnh viễn" mở được ở đường dẫn /adm/adm-25, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần adm.delegation.temporary đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.delegation.permanent-request đúng lúc giọng đọc nói tới
- [ ] Chú thích "Người thứ ba duyệt · quá hạn xem xét thì dừng" hiện từ giây 3, kéo dài 6 giây
- [ ] Yêu cầu có người ủy quyền, người được ủy quyền, quyền và ngày xem xét lại
- [ ] Tên người duyệt khác cả hai người kia
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `del-acting`

Nền tảng: web; 13 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-26` Làm thay có người duyệt (/adm/adm-26)

**Lời đọc**

> Làm thay chỉ dành cho nhập liệu, không dành cho quyết định. Cần người duyệt thứ hai, tối đa tám giờ. Mọi dòng nhật ký ghi cả hai danh tính, người làm thay và người được thay.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Làm thay chỉ dành cho nhập liệu, không dành cho quyết định. Cần người duyệt thứ hai, tối đa tám giờ. Mọi dòng nhật ký ghi cả hai danh tính, người làm thay và người được thay.

**Phụ đề**

- Làm thay chỉ dành cho nhập / liệu, không dành cho quyết định.
- Cần người duyệt thứ hai, tối đa tám giờ.
- Mọi dòng nhật ký ghi cả hai danh tính, / người làm thay và người được thay.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=ADM-26`
- `do=spot ref=adm.acting.request`
- `do=spot ref=adm.acting.limits`

**Cần thấy trên hình**

- [ ] Màn ADM-26 "Làm thay có người duyệt" mở được ở đường dẫn /adm/adm-26, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần adm.acting.request đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.acting.limits đúng lúc giọng đọc nói tới
- [ ] Danh sách quyền được làm thay không có động từ quyết định
- [ ] Nhật ký ghi hai danh tính
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `del-period-scope`

Nền tảng: web; 12.4 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-27` Phạm vi theo kỳ báo cáo (/adm/adm-27)

**Lời đọc**

> Quyền theo kỳ báo cáo giới hạn người dùng vào những kỳ được phép khi nhập hoặc gửi báo cáo tuần. Không đặt giới hạn thì hệ thống chạy như trước, không có gì thay đổi.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Quyền theo kỳ báo cáo giới hạn người dùng vào những kỳ được phép khi nhập hoặc gửi báo cáo tuần. Không đặt giới hạn thì hệ thống chạy như trước, không có gì thay đổi.

**Phụ đề**

- Quyền theo kỳ báo cáo / giới hạn người dùng vào
- những kỳ được phép khi / nhập hoặc gửi báo cáo tuần.
- Không đặt giới hạn thì hệ thống chạy / như trước, không có gì thay đổi.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=ADM-27`
- `do=spot ref=adm.period-scope.grants`
- `do=spot ref=adm.period-scope.period-codes`

**Cần thấy trên hình**

- [ ] Màn ADM-27 "Phạm vi theo kỳ báo cáo" mở được ở đường dẫn /adm/adm-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần adm.period-scope.grants đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.period-scope.period-codes đúng lúc giọng đọc nói tới
- [ ] Danh sách quyền có cột kỳ được phép
- [ ] Hàng không giới hạn ghi rõ là mọi kỳ
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `del-absence-cover`

Nền tảng: web; 17.6 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-28` Vắng mặt, người thay và độ phủ người nhận cảnh báo (/adm/adm-28)

**Lời đọc**

> Người nhận cảnh báo vắng mặt thì người thay được khai và được người thứ ba cho phép. Người thay đọc việc của người vắng trong phạm vi quyền của chính mình. Báo cáo độ phủ chỉ ra vị trí còn trống và cảnh báo mồ côi khi chủ đã rời đi.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Người nhận cảnh báo vắng mặt thì người thay được khai và được người thứ ba cho phép. Người thay đọc việc của người vắng trong phạm vi quyền của chính mình. Báo cáo độ phủ chỉ ra vị trí còn trống và cảnh báo mồ côi khi chủ đã rời đi.

**Phụ đề**

- Người nhận cảnh báo / vắng mặt thì người thay
- được khai và được người thứ ba cho phép.
- Người thay đọc việc của người vắng / trong phạm vi quyền của chính mình.
- Báo cáo độ phủ chỉ ra vị trí còn trống / và cảnh báo mồ côi khi chủ đã rời đi.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=ADM-28`
- `do=spot ref=adm.absence.cover-list`
- `do=spot ref=adm.absence.coverage-gaps`

**Cần thấy trên hình**

- [ ] Màn ADM-28 "Vắng mặt, người thay và độ phủ người nhận cảnh báo" mở được ở đường dẫn /adm/adm-28, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần adm.absence.cover-list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.absence.coverage-gaps đúng lúc giọng đọc nói tới
- [ ] Chú thích "Thay là chuyển chú ý, không chuyển thẩm quyền" hiện từ giây 3, kéo dài 6 giây
- [ ] Khoảng trống độ phủ hiện theo vị trí
- [ ] Cảnh báo mồ côi có chủ cũ
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Thanh tra, kiểm toán và tín hiệu rủi ro (`audit-controls`)

### `aud-list`

Nền tảng: web; 10.5 giây; chỉ trong chương cắt riêng

Màn hình: `AUD-01` Tổng quan thanh tra, kiểm toán (/aud/aud-01); `AUD-02` Danh sách cuộc thanh tra, kiểm toán (/aud/aud-02)

**Lời đọc**

> Cán bộ thanh tra, kiểm toán theo dõi mọi cuộc thanh tra trong một danh sách. Mỗi cuộc có trạng thái và hạn, từ lập kế hoạch đến kết luận.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cán bộ thanh tra, kiểm toán theo dõi mọi cuộc thanh tra trong một danh sách. Mỗi cuộc có trạng thái và hạn, từ lập kế hoạch đến kết luận.

**Phụ đề**

- Cán bộ thanh tra, kiểm toán theo dõi / mọi cuộc thanh tra trong một danh sách.
- Mỗi cuộc có trạng thái và hạn, / từ lập kế hoạch đến kết luận.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=AUD-01`
- `do=spot ref=aud.overview.tiles`
- `do=open screen=AUD-02`
- `do=spot ref=aud.inspections.list`

**Cần thấy trên hình**

- [ ] Màn AUD-01 "Tổng quan thanh tra, kiểm toán" mở được ở đường dẫn /aud/aud-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AUD-02 "Danh sách cuộc thanh tra, kiểm toán" mở được ở đường dẫn /aud/aud-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần aud.overview.tiles đúng lúc giọng đọc nói tới
- [ ] Khung vào phần aud.inspections.list đúng lúc giọng đọc nói tới
- [ ] Danh sách có trạng thái và hạn từng cuộc
- [ ] Ô tổng quan khớp với danh sách
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `aud-findings`

Nền tảng: web; 11.8 giây; chỉ trong chương cắt riêng

Màn hình: `AUD-03` Hồ sơ cuộc thanh tra, kiểm toán (/aud/aud-03); `AUD-04` Tiếp nhận kết luận, báo cáo kiểm toán (/aud/aud-04); `AUD-05` Phát hiện (/aud/aud-05)

**Lời đọc**

> Hồ sơ cuộc kiểm toán tiếp nhận kết luận và báo cáo, rồi ghi từng phát hiện kèm căn cứ. Mỗi phát hiện về sau trở thành kiến nghị có người chịu trách nhiệm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hồ sơ cuộc kiểm toán tiếp nhận kết luận và báo cáo, rồi ghi từng phát hiện kèm căn cứ. Mỗi phát hiện về sau trở thành kiến nghị có người chịu trách nhiệm.

**Phụ đề**

- Hồ sơ cuộc kiểm toán tiếp / nhận kết luận và báo cáo,
- rồi ghi từng phát hiện kèm căn cứ.
- Mỗi phát hiện về sau trở thành kiến / nghị có người chịu trách nhiệm.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=AUD-03`
- `do=spot ref=aud.case.header`
- `do=open screen=AUD-04`
- `do=spot ref=aud.conclusion.intake`
- `do=open screen=AUD-05`
- `do=spot ref=aud.findings.list`

**Cần thấy trên hình**

- [ ] Màn AUD-03 "Hồ sơ cuộc thanh tra, kiểm toán" mở được ở đường dẫn /aud/aud-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AUD-04 "Tiếp nhận kết luận, báo cáo kiểm toán" mở được ở đường dẫn /aud/aud-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AUD-05 "Phát hiện" mở được ở đường dẫn /aud/aud-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần aud.case.header đúng lúc giọng đọc nói tới
- [ ] Khung vào phần aud.conclusion.intake đúng lúc giọng đọc nói tới
- [ ] Khung vào phần aud.findings.list đúng lúc giọng đọc nói tới
- [ ] Mỗi phát hiện có căn cứ và liên kết tài liệu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `aud-recommendations`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `AUD-06` Kiến nghị và phân công (/aud/aud-06); `AUD-07` Theo dõi thực hiện kiến nghị (/aud/aud-07); `AUD-17` Thứ tự theo dõi kiến nghị kiểm toán của chủ đầu tư (/aud/aud-17)

**Lời đọc**

> Kiến nghị được phân công cho đơn vị và theo dõi đến khi thực hiện xong. Kiến nghị chưa thực hiện được xếp thứ tự theo hồ sơ của từng chủ đầu tư, và đi vào xếp hạng chủ đầu tư.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kiến nghị được phân công cho đơn vị và theo dõi đến khi thực hiện xong. Kiến nghị chưa thực hiện được xếp thứ tự theo hồ sơ của từng chủ đầu tư, và đi vào xếp hạng chủ đầu tư.

**Phụ đề**

- Kiến nghị được phân công cho đơn vị / và theo dõi đến khi thực hiện xong.
- Kiến nghị chưa thực hiện / được xếp thứ tự theo hồ sơ
- của từng chủ đầu tư, và đi / vào xếp hạng chủ đầu tư.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=AUD-06`
- `do=spot ref=aud.recommendations.assignment`
- `do=open screen=AUD-07`
- `do=spot ref=aud.recommendations.progress`
- `do=open screen=AUD-17`
- `do=spot ref=aud.recommendations.investor-order`

**Cần thấy trên hình**

- [ ] Màn AUD-06 "Kiến nghị và phân công" mở được ở đường dẫn /aud/aud-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AUD-07 "Theo dõi thực hiện kiến nghị" mở được ở đường dẫn /aud/aud-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AUD-17 "Thứ tự theo dõi kiến nghị kiểm toán của chủ đầu tư" mở được ở đường dẫn /aud/aud-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần aud.recommendations.assignment đúng lúc giọng đọc nói tới
- [ ] Khung vào phần aud.recommendations.progress đúng lúc giọng đọc nói tới
- [ ] Khung vào phần aud.recommendations.investor-order đúng lúc giọng đọc nói tới
- [ ] Kiến nghị có đơn vị, hạn và tiến độ
- [ ] Thứ tự theo chủ đầu tư
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `aud-remediation`

Nền tảng: web; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `AUD-08` Thu hồi tài chính và đối chiếu PAY (/aud/aud-08); `AUD-09` Bằng chứng khắc phục (/aud/aud-09); `AUD-10` Báo cáo kết quả thực hiện kiến nghị (/aud/aud-10); `AUD-11` Cảnh báo quá hạn và leo thang (/aud/aud-11)

**Lời đọc**

> Thu hồi tài chính được đối chiếu với thanh toán. Đơn vị đính kèm bằng chứng khắc phục, rồi báo cáo kết quả thực hiện kiến nghị. Quá hạn thì cảnh báo và leo thang lên cấp cao hơn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Thu hồi tài chính được đối chiếu với thanh toán. Đơn vị đính kèm bằng chứng khắc phục, rồi báo cáo kết quả thực hiện kiến nghị. Quá hạn thì cảnh báo và leo thang lên cấp cao hơn.

**Phụ đề**

- Thu hồi tài chính được / đối chiếu với thanh toán.
- Đơn vị đính kèm bằng chứng khắc phục, / rồi báo cáo kết quả thực hiện kiến nghị.
- Quá hạn thì cảnh báo và / leo thang lên cấp cao hơn.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=AUD-08`
- `do=spot ref=aud.recovery.payment-match`
- `do=open screen=AUD-09`
- `do=spot ref=aud.evidence.upload`
- `do=open screen=AUD-10`
- `do=open screen=AUD-11`
- `do=spot ref=aud.overdue.escalation`

**Cần thấy trên hình**

- [ ] Màn AUD-08 "Thu hồi tài chính và đối chiếu PAY" mở được ở đường dẫn /aud/aud-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AUD-09 "Bằng chứng khắc phục" mở được ở đường dẫn /aud/aud-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AUD-10 "Báo cáo kết quả thực hiện kiến nghị" mở được ở đường dẫn /aud/aud-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AUD-11 "Cảnh báo quá hạn và leo thang" mở được ở đường dẫn /aud/aud-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần aud.recovery.payment-match đúng lúc giọng đọc nói tới
- [ ] Khung vào phần aud.evidence.upload đúng lúc giọng đọc nói tới
- [ ] Khung vào phần aud.overdue.escalation đúng lúc giọng đọc nói tới
- [ ] Dòng thu hồi có số thanh toán đối chiếu
- [ ] Bằng chứng khắc phục gắn với kiến nghị
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `aud-redflag-detail`

Nền tảng: web; 17.6 giây; chỉ trong chương cắt riêng

Màn hình: `AUD-15` Chi tiết tín hiệu rủi ro mua sắm (/aud/aud-15); `AUD-16` Sổ chỉ báo red flag (/aud/aud-16)

**Lời đọc**

> Mỗi tín hiệu rủi ro mua sắm có trang chi tiết: chỉ báo nào kích hoạt, dữ liệu nào làm căn cứ, ai đang xem xét. Sổ chỉ báo ghi từng chỉ báo cùng công thức, nguồn và ngày hiệu lực. Tỷ lệ báo nhầm được đo để chỉnh lại chỉ báo.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi tín hiệu rủi ro mua sắm có trang chi tiết: chỉ báo nào kích hoạt, dữ liệu nào làm căn cứ, ai đang xem xét. Sổ chỉ báo ghi từng chỉ báo cùng công thức, nguồn và ngày hiệu lực. Tỷ lệ báo nhầm được đo để chỉnh lại chỉ báo.

**Phụ đề**

- Mỗi tín hiệu rủi ro mua / sắm có trang chi tiết:
- chỉ báo nào kích hoạt, dữ liệu / nào làm căn cứ, ai đang xem xét.
- Sổ chỉ báo ghi từng chỉ báo cùng / công thức, nguồn và ngày hiệu lực.
- Tỷ lệ báo nhầm được đo / để chỉnh lại chỉ báo.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=AUD-15`
- `do=spot ref=aud.red-flag.detail`
- `do=open screen=AUD-16`
- `do=spot ref=aud.red-flag.indicator-ledger`

**Cần thấy trên hình**

- [ ] Màn AUD-15 "Chi tiết tín hiệu rủi ro mua sắm" mở được ở đường dẫn /aud/aud-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AUD-16 "Sổ chỉ báo red flag" mở được ở đường dẫn /aud/aud-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần aud.red-flag.detail đúng lúc giọng đọc nói tới
- [ ] Khung vào phần aud.red-flag.indicator-ledger đúng lúc giọng đọc nói tới
- [ ] Chú thích "Tín hiệu để điều tra, không phải kết luận" hiện từ giây 3, kéo dài 5 giây
- [ ] Chi tiết tín hiệu nêu chỉ báo và dữ liệu căn cứ
- [ ] Sổ chỉ báo có công thức và ngày hiệu lực
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `aud-whistle-gifts`

Nền tảng: web; 14.2 giây; chỉ trong chương cắt riêng

Màn hình: `AUD-18` Tố giác ẩn danh (/aud/aud-18); `AUD-19` Sổ quà tặng (/aud/aud-19)

**Lời đọc**

> Kênh tố giác ẩn danh có xác nhận đã nhận và hạn xử lý, người xử lý không thấy danh tính người tố giác. Sổ quà tặng ghi quà nhận và quà từ chối, có ngưỡng giá trị bắt buộc phải khai.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kênh tố giác ẩn danh có xác nhận đã nhận và hạn xử lý, người xử lý không thấy danh tính người tố giác. Sổ quà tặng ghi quà nhận và quà từ chối, có ngưỡng giá trị bắt buộc phải khai.

**Phụ đề**

- Kênh tố giác ẩn danh có xác / nhận đã nhận và hạn xử lý,
- người xử lý không thấy / danh tính người tố giác.
- Sổ quà tặng ghi quà nhận và quà từ chối, / có ngưỡng giá trị bắt buộc phải khai.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=AUD-18`
- `do=spot ref=aud.whistle.channel`
- `do=open screen=AUD-19`
- `do=spot ref=aud.gifts.register`

**Cần thấy trên hình**

- [ ] Màn AUD-18 "Tố giác ẩn danh" mở được ở đường dẫn /aud/aud-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AUD-19 "Sổ quà tặng" mở được ở đường dẫn /aud/aud-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần aud.whistle.channel đúng lúc giọng đọc nói tới
- [ ] Khung vào phần aud.gifts.register đúng lúc giọng đọc nói tới
- [ ] Tố giác hiện mã theo dõi, không hiện danh tính
- [ ] Sổ quà tặng có giá trị và người khai
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Dự báo, rủi ro và hiệu quả đầu tư (`risk-forecast`)

### `fc-milestones`

Nền tảng: web; 18.2 giây; chỉ trong chương cắt riêng

Màn hình: `DIS-30` Dự báo tới các mốc chỉ đạo của giải ngân (/dis/dis-30); `DIS-31` Độ chính xác dự báo giải ngân của từng chủ đầu tư (/dis/dis-31); `DIS-24` Kế hoạch giải ngân tuần theo dự án (/dis/dis-24)

**Lời đọc**

> Dự báo giải ngân tính tới từng mốc chỉ đạo, và kế hoạch giải ngân tuần theo dự án cho biết cần bao nhiêu mỗi tuần. Sau mỗi tháng, độ chính xác dự báo của từng chủ đầu tư được đo. Chủ đầu tư hay dự báo lệch được đánh dấu để rà lại.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Dự báo giải ngân tính tới từng mốc chỉ đạo, và kế hoạch giải ngân tuần theo dự án cho biết cần bao nhiêu mỗi tuần. Sau mỗi tháng, độ chính xác dự báo của từng chủ đầu tư được đo. Chủ đầu tư hay dự báo lệch được đánh dấu để rà lại.

**Phụ đề**

- Dự báo giải ngân tính tới / từng mốc chỉ đạo, và kế hoạch
- giải ngân tuần theo dự án cho / biết cần bao nhiêu mỗi tuần.
- Sau mỗi tháng, độ chính xác dự / báo của từng chủ đầu tư được đo.
- Chủ đầu tư hay dự báo lệch / được đánh dấu để rà lại.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DIS-30`
- `do=spot ref=dis.forecast.milestones`
- `do=open screen=DIS-31`
- `do=spot ref=dis.forecast.accuracy`
- `do=open screen=DIS-24`
- `do=spot ref=dis.forecast.weekly-plan`

**Cần thấy trên hình**

- [ ] Màn DIS-30 "Dự báo tới các mốc chỉ đạo của giải ngân" mở được ở đường dẫn /dis/dis-30, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-31 "Độ chính xác dự báo giải ngân của từng chủ đầu tư" mở được ở đường dẫn /dis/dis-31, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-24 "Kế hoạch giải ngân tuần theo dự án" mở được ở đường dẫn /dis/dis-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần dis.forecast.milestones đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.forecast.accuracy đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.forecast.weekly-plan đúng lúc giọng đọc nói tới
- [ ] Bảng mốc chỉ đạo có số dự báo và số cần
- [ ] Bảng độ chính xác theo chủ đầu tư
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `fc-year-band`

Nền tảng: web; 16 giây; chỉ trong chương cắt riêng

Màn hình: `BI-21` Dự báo giải ngân cuối năm (/bi/bi-21); `BI-30` Kiểm thử ngưỡng cảnh báo và xu hướng (/bi/bi-30)

**Lời đọc**

> Dự báo cuối năm hiện thành một dải chứ không phải một con số. Dải tính từ tốc độ bốn đến tám tuần gần nhất, kèm số cần giải ngân mỗi tuần. Ngưỡng cảnh báo được kiểm lại trên dữ liệu quá khứ trước khi tin dùng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Dự báo cuối năm hiện thành một dải chứ không phải một con số. Dải tính từ tốc độ bốn đến tám tuần gần nhất, kèm số cần giải ngân mỗi tuần. Ngưỡng cảnh báo được kiểm lại trên dữ liệu quá khứ trước khi tin dùng.

**Phụ đề**

- Dự báo cuối năm hiện thành một / dải chứ không phải một con số.
- Dải tính từ tốc độ bốn đến tám tuần gần / nhất, kèm số cần giải ngân mỗi tuần.
- Ngưỡng cảnh báo được kiểm lại trên / dữ liệu quá khứ trước khi tin dùng.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-21`
- `do=spot ref=bi.forecast.year-end-band`
- `do=open screen=BI-30`
- `do=spot ref=bi.forecast.backtest`

**Cần thấy trên hình**

- [ ] Màn BI-21 "Dự báo giải ngân cuối năm" mở được ở đường dẫn /bi/bi-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-30 "Kiểm thử ngưỡng cảnh báo và xu hướng" mở được ở đường dẫn /bi/bi-30, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.forecast.year-end-band đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.forecast.backtest đúng lúc giọng đọc nói tới
- [ ] Dải dự báo có cận trên và cận dưới
- [ ] Kết quả kiểm lại ngưỡng trên dữ liệu quá khứ
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `fc-ranking`

Nền tảng: web; 14.8 giây; chỉ trong chương cắt riêng

Màn hình: `BI-25` Xếp hạng nhiều chỉ số (/bi/bi-25); `BI-26` Ghi chú và khiếu nại xếp hạng (/bi/bi-26)

**Lời đọc**

> Xếp hạng nhiều chỉ số, chuẩn hóa theo quy mô, đặt tỷ lệ giải ngân cạnh tiến độ thực tế. Đơn vị bị vướng vì nguyên nhân bên ngoài được ghi chú có duyệt. Số liệu bị khiếu nại có hàng chờ riêng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Xếp hạng nhiều chỉ số, chuẩn hóa theo quy mô, đặt tỷ lệ giải ngân cạnh tiến độ thực tế. Đơn vị bị vướng vì nguyên nhân bên ngoài được ghi chú có duyệt. Số liệu bị khiếu nại có hàng chờ riêng.

**Phụ đề**

- Xếp hạng nhiều chỉ số, / chuẩn hóa theo quy mô,
- đặt tỷ lệ giải ngân cạnh tiến độ thực tế.
- Đơn vị bị vướng vì nguyên nhân / bên ngoài được ghi chú có duyệt.
- Số liệu bị khiếu nại có hàng chờ riêng.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-25`
- `do=spot ref=bi.ranking.multi-metric`
- `do=open screen=BI-26`
- `do=spot ref=bi.ranking.annotations`

**Cần thấy trên hình**

- [ ] Màn BI-25 "Xếp hạng nhiều chỉ số" mở được ở đường dẫn /bi/bi-25, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-26 "Ghi chú và khiếu nại xếp hạng" mở được ở đường dẫn /bi/bi-26, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.ranking.multi-metric đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.ranking.annotations đúng lúc giọng đọc nói tới
- [ ] Cột tiến độ thực tế cạnh tỷ lệ giải ngân
- [ ] Ghi chú đã duyệt gắn với đơn vị
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `fc-bottleneck`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `BI-27` Điểm nghẽn (/bi/bi-27); `BI-28` Dự án dừng và kế hoạch khởi động lại (/bi/bi-28)

**Lời đọc**

> Phân tích điểm nghẽn cho biết số tiền đang bị giữ, nguyên nhân chuẩn, tuổi của khoản nợ và đơn vị đang giữ. Dự án dừng có hồ sơ lý do và kế hoạch khởi động lại, không bị bỏ quên.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Phân tích điểm nghẽn cho biết số tiền đang bị giữ, nguyên nhân chuẩn, tuổi của khoản nợ và đơn vị đang giữ. Dự án dừng có hồ sơ lý do và kế hoạch khởi động lại, không bị bỏ quên.

**Phụ đề**

- Phân tích điểm nghẽn cho / biết số tiền đang bị giữ,
- nguyên nhân chuẩn, tuổi của / khoản nợ và đơn vị đang giữ.
- Dự án dừng có hồ sơ lý do và kế hoạch / khởi động lại, không bị bỏ quên.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-27`
- `do=spot ref=bi.bottleneck.held-amount`
- `do=open screen=BI-28`
- `do=spot ref=bi.bottleneck.halted-projects`

**Cần thấy trên hình**

- [ ] Màn BI-27 "Điểm nghẽn" mở được ở đường dẫn /bi/bi-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-28 "Dự án dừng và kế hoạch khởi động lại" mở được ở đường dẫn /bi/bi-28, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.bottleneck.held-amount đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.bottleneck.halted-projects đúng lúc giọng đọc nói tới
- [ ] Bảng điểm nghẽn có tuổi nợ và đơn vị giữ
- [ ] Dự án dừng có kế hoạch khởi động lại
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `fc-heatmap-decisions`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `BI-29` Bản đồ nhiệt giải ngân (/bi/bi-29); `BI-22` Nhật ký quyết định (/bi/bi-22)

**Lời đọc**

> Bản đồ nhiệt giải ngân theo đơn vị, nguồn vốn và nhà thầu cho thấy chỗ nóng nhất. Mỗi quyết định của lãnh đạo gắn với cảnh báo hoặc con số lúc ra quyết định, được đóng băng trong nhật ký quyết định.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bản đồ nhiệt giải ngân theo đơn vị, nguồn vốn và nhà thầu cho thấy chỗ nóng nhất. Mỗi quyết định của lãnh đạo gắn với cảnh báo hoặc con số lúc ra quyết định, được đóng băng trong nhật ký quyết định.

**Phụ đề**

- Bản đồ nhiệt giải ngân theo đơn vị, nguồn / vốn và nhà thầu cho thấy chỗ nóng nhất.
- Mỗi quyết định của lãnh đạo / gắn với cảnh báo hoặc con số
- lúc ra quyết định, được đóng / băng trong nhật ký quyết định.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-29`
- `do=spot ref=bi.heatmap.grid`
- `do=open screen=BI-22`
- `do=spot ref=bi.decisions.log`

**Cần thấy trên hình**

- [ ] Màn BI-29 "Bản đồ nhiệt giải ngân" mở được ở đường dẫn /bi/bi-29, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-22 "Nhật ký quyết định" mở được ở đường dẫn /bi/bi-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.heatmap.grid đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.decisions.log đúng lúc giọng đọc nói tới
- [ ] Bản đồ nhiệt có chú thích thang màu
- [ ] Nhật ký quyết định có số liệu đóng băng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `fc-trust`

Nền tảng: web; 16.3 giây; chỉ trong chương cắt riêng

Màn hình: `BI-23` Độ tươi và thẻ điểm chất lượng số liệu (/bi/bi-23); `BI-24` Truy nguồn số liệu (/bi/bi-24)

**Lời đọc**

> Mỗi số có độ tươi theo từng bộ dữ liệu, dữ liệu quá hạn bị đánh dấu là cũ. Thẻ điểm chất lượng chấm theo từng phân hệ và đơn vị. Truy nguồn đi từ chỉ tiêu về bộ dữ liệu, bảng và phân hệ sinh ra nó.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi số có độ tươi theo từng bộ dữ liệu, dữ liệu quá hạn bị đánh dấu là cũ. Thẻ điểm chất lượng chấm theo từng phân hệ và đơn vị. Truy nguồn đi từ chỉ tiêu về bộ dữ liệu, bảng và phân hệ sinh ra nó.

**Phụ đề**

- Mỗi số có độ tươi theo từng bộ dữ liệu, / dữ liệu quá hạn bị đánh dấu là cũ.
- Thẻ điểm chất lượng chấm / theo từng phân hệ và đơn vị.
- Truy nguồn đi từ chỉ tiêu về bộ dữ / liệu, bảng và phân hệ sinh ra nó.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-23`
- `do=spot ref=bi.freshness.scorecard`
- `do=open screen=BI-24`
- `do=spot ref=bi.trace.source-path`

**Cần thấy trên hình**

- [ ] Màn BI-23 "Độ tươi và thẻ điểm chất lượng số liệu" mở được ở đường dẫn /bi/bi-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-24 "Truy nguồn số liệu" mở được ở đường dẫn /bi/bi-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.freshness.scorecard đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.trace.source-path đúng lúc giọng đọc nói tới
- [ ] Cờ dữ liệu cũ hiện ở bộ dữ liệu quá hạn
- [ ] Đường truy nguồn từ chỉ tiêu về phân hệ
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `risk-board`

Nền tảng: web; 19.4 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-28` Bảng rủi ro chấm từ tín hiệu và lịch sử điểm (/prj/prj-28); `PRJ-16` Sổ đăng ký rủi ro dự án (/prj/prj-16)

**Lời đọc**

> Bảng rủi ro dự án chấm từ tín hiệu thật: chậm tiến độ, toàn vẹn thanh toán, claim và cảnh báo sớm, thiếu vốn, mua sắm chậm. Số không biết được thì ghi là chưa có, không bao giờ ghi là số không. Điểm tăng qua ngưỡng mới báo, mỗi ngày một lần cho mỗi vấn đề.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bảng rủi ro dự án chấm từ tín hiệu thật: chậm tiến độ, toàn vẹn thanh toán, cờ-lêm và cảnh báo sớm, thiếu vốn, mua sắm chậm. Số không biết được thì ghi là chưa có, không bao giờ ghi là số không. Điểm tăng qua ngưỡng mới báo, mỗi ngày một lần cho mỗi vấn đề.

**Phụ đề**

- Bảng rủi ro dự án chấm từ / tín hiệu thật: chậm tiến độ,
- toàn vẹn thanh toán, claim và cảnh / báo sớm, thiếu vốn, mua sắm chậm.
- Số không biết được thì ghi là chưa / có, không bao giờ ghi là số không.
- Điểm tăng qua ngưỡng mới báo, / mỗi ngày một lần cho mỗi vấn đề.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=PRJ-28`
- `do=spot ref=prj.risk.signal-lines`
- `do=spot ref=prj.risk.score-history`
- `do=open screen=PRJ-16`
- `do=spot ref=prj.risk.register`

**Cần thấy trên hình**

- [ ] Màn PRJ-28 "Bảng rủi ro chấm từ tín hiệu và lịch sử điểm" mở được ở đường dẫn /prj/prj-28, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-16 "Sổ đăng ký rủi ro dự án" mở được ở đường dẫn /prj/prj-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần prj.risk.signal-lines đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.risk.score-history đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.risk.register đúng lúc giọng đọc nói tới
- [ ] Chú thích "Không biết thì ghi chưa có, không ghi số không" hiện từ giây 4, kéo dài 6 giây
- [ ] Mỗi dòng tín hiệu có điểm và lời giải thích
- [ ] Lịch sử điểm của dự án
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `look-ahead`

Nền tảng: web; 16.6 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-30` Kế hoạch nhìn trước 2 đến 6 tuần của công trường (/prj/prj-30)

**Lời đọc**

> Kế hoạch nhìn trước hai đến sáu tuần của công trường liệt kê hạng mục sắp làm, ràng buộc và người gỡ ràng buộc. Công trường công bố mỗi tuần một kế hoạch. Ràng buộc quá hạn được nêu rõ, và người công bố là chủ của kế hoạch.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kế hoạch nhìn trước hai đến sáu tuần của công trường liệt kê hạng mục sắp làm, ràng buộc và người gỡ ràng buộc. Công trường công bố mỗi tuần một kế hoạch. Ràng buộc quá hạn được nêu rõ, và người công bố là chủ của kế hoạch.

**Phụ đề**

- Kế hoạch nhìn trước hai đến / sáu tuần của công trường liệt
- kê hạng mục sắp làm, ràng / buộc và người gỡ ràng buộc.
- Công trường công bố mỗi tuần một kế hoạch.
- Ràng buộc quá hạn được nêu rõ, và / người công bố là chủ của kế hoạch.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=PRJ-30`
- `do=spot ref=prj.look-ahead.items`
- `do=spot ref=prj.look-ahead.constraints`

**Cần thấy trên hình**

- [ ] Màn PRJ-30 "Kế hoạch nhìn trước 2 đến 6 tuần của công trường" mở được ở đường dẫn /prj/prj-30, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần prj.look-ahead.items đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.look-ahead.constraints đúng lúc giọng đọc nói tới
- [ ] Bảng hạng mục theo tuần
- [ ] Ràng buộc có người gỡ và hạn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `lessons-closure`

Nền tảng: web; 14.2 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-29` Bài học kinh nghiệm và cổng đóng dự án (/prj/prj-29)

**Lời đọc**

> Cổng đóng dự án có phần bài học kinh nghiệm. Bài học được ghi lại với nguyên nhân và đề xuất, rồi dùng khi chuẩn bị các dự án sau. Dự án chưa qua cổng thì chưa được coi là đóng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cổng đóng dự án có phần bài học kinh nghiệm. Bài học được ghi lại với nguyên nhân và đề xuất, rồi dùng khi chuẩn bị các dự án sau. Dự án chưa qua cổng thì chưa được coi là đóng.

**Phụ đề**

- Cổng đóng dự án có phần / bài học kinh nghiệm.
- Bài học được ghi lại với / nguyên nhân và đề xuất,
- rồi dùng khi chuẩn bị các dự án sau.
- Dự án chưa qua cổng thì / chưa được coi là đóng.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=PRJ-29`
- `do=spot ref=prj.lessons.closing-gate`
- `do=spot ref=prj.lessons.entries`

**Cần thấy trên hình**

- [ ] Màn PRJ-29 "Bài học kinh nghiệm và cổng đóng dự án" mở được ở đường dẫn /prj/prj-29, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần prj.lessons.closing-gate đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.lessons.entries đúng lúc giọng đọc nói tới
- [ ] Danh sách bài học có nguyên nhân và đề xuất
- [ ] Trạng thái cổng đóng dự án
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `effectiveness`

Nền tảng: web; 19.1 giây; chỉ trong chương cắt riêng

Màn hình: `MNE-11` Hiệu quả sau đầu tư: chỉ tiêu mục tiêu và thực tế (/mne/mne-11); `AST-07` Kích hoạt đánh giá sau đầu tư (/ast/ast-07)

**Lời đọc**

> Hiệu quả sau đầu tư có bộ chỉ tiêu mục tiêu do một người soạn, người khác chốt rồi không sửa nữa. Số thực đo theo từng kỳ, độ lệch tính chính xác. Người ngoài người trình quyết định kết luận. Lịch đánh giá theo nhóm dự án là cấu hình mặc định, chưa kiểm chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hiệu quả sau đầu tư có bộ chỉ tiêu mục tiêu do một người soạn, người khác chốt rồi không sửa nữa. Số thực đo theo từng kỳ, độ lệch tính chính xác. Người ngoài người trình quyết định kết luận. Lịch đánh giá theo nhóm dự án là cấu hình mặc định, chưa kiểm chứng.

**Phụ đề**

- Hiệu quả sau đầu tư có bộ / chỉ tiêu mục tiêu do một
- người soạn, người khác / chốt rồi không sửa nữa.
- Số thực đo theo từng kỳ, / độ lệch tính chính xác.
- Người ngoài người trình / quyết định kết luận.
- Lịch đánh giá theo nhóm dự án là / cấu hình mặc định, chưa kiểm chứng.

**Các bước quay**

- `do=as persona=mneAdmin`
- `do=open screen=MNE-11`
- `do=spot ref=mne.effectiveness.target-set`
- `do=spot ref=mne.effectiveness.variance`
- `do=open screen=AST-07`
- `do=spot ref=ast.effectiveness.trigger`

**Cần thấy trên hình**

- [ ] Màn MNE-11 "Hiệu quả sau đầu tư: chỉ tiêu mục tiêu và thực tế" mở được ở đường dẫn /mne/mne-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AST-07 "Kích hoạt đánh giá sau đầu tư" mở được ở đường dẫn /ast/ast-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản mneAdmin
- [ ] Khung vào phần mne.effectiveness.target-set đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mne.effectiveness.variance đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ast.effectiveness.trigger đúng lúc giọng đọc nói tới
- [ ] Chú thích "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng" hiện từ giây 4, kéo dài 7 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng"
- [ ] Bộ mục tiêu đã chốt không có nút sửa
- [ ] Độ lệch giữa mục tiêu và thực tế từng kỳ
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Vòng đời dự án đầu tư (`project-life`)

### `prj-proposal`

Nền tảng: web; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-09` Đề xuất chủ trương (/prj/prj-09); `PRJ-10` Thẩm định và quyết định (/prj/prj-10); `PRJ-02` Tạo dự án (/prj/prj-02); `PRJ-03` Không gian dự án (/prj/prj-03)

**Lời đọc**

> Dự án bắt đầu từ đề xuất chủ trương, qua thẩm định và quyết định, rồi mới được tạo. Không gian dự án gom hồ sơ, vốn, tiến độ, hợp đồng và trao đổi của dự án vào một chỗ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Dự án bắt đầu từ đề xuất chủ trương, qua thẩm định và quyết định, rồi mới được tạo. Không gian dự án gom hồ sơ, vốn, tiến độ, hợp đồng và trao đổi của dự án vào một chỗ.

**Phụ đề**

- Dự án bắt đầu từ đề xuất chủ trương, qua / thẩm định và quyết định, rồi mới được tạo.
- Không gian dự án gom hồ sơ, vốn, tiến độ,
- hợp đồng và trao đổi / của dự án vào một chỗ.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=PRJ-09`
- `do=spot ref=prj.project.proposal`
- `do=open screen=PRJ-10`
- `do=spot ref=prj.project.appraisal-decision`
- `do=open screen=PRJ-02`
- `do=spot ref=prj.project.create`
- `do=open screen=PRJ-03`
- `do=spot ref=prj.project.workspace`

**Cần thấy trên hình**

- [ ] Màn PRJ-09 "Đề xuất chủ trương" mở được ở đường dẫn /prj/prj-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-10 "Thẩm định và quyết định" mở được ở đường dẫn /prj/prj-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-02 "Tạo dự án" mở được ở đường dẫn /prj/prj-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-03 "Không gian dự án" mở được ở đường dẫn /prj/prj-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần prj.project.proposal đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.appraisal-decision đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.create đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.workspace đúng lúc giọng đọc nói tới
- [ ] Dòng quyết định chủ trương
- [ ] Không gian dự án có các thẻ chính
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `prj-structure`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-04` Hồ sơ pháp lý (/prj/prj-04); `PRJ-05` Cấu phần và WBS (/prj/prj-05); `PRJ-06` Điều chỉnh dự án (/prj/prj-06); `PRJ-07` Tiến độ và mốc (/prj/prj-07); `PRJ-08` Nhóm thực hiện (/prj/prj-08)

**Lời đọc**

> Hồ sơ pháp lý, cấu trúc phân rã công việc, tiến độ và mốc của dự án được quản trong cùng một nơi. Điều chỉnh dự án đi qua thủ tục có lý do. Nhóm thực hiện ghi rõ vai trò của từng người.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hồ sơ pháp lý, cấu trúc phân rã công việc, tiến độ và mốc của dự án được quản trong cùng một nơi. Điều chỉnh dự án đi qua thủ tục có lý do. Nhóm thực hiện ghi rõ vai trò của từng người.

**Phụ đề**

- Hồ sơ pháp lý, cấu trúc phân rã công việc,
- tiến độ và mốc của dự án / được quản trong cùng một nơi.
- Điều chỉnh dự án đi qua thủ tục có lý do.
- Nhóm thực hiện ghi rõ / vai trò của từng người.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=PRJ-04`
- `do=spot ref=prj.project.legal-file`
- `do=open screen=PRJ-05`
- `do=spot ref=prj.project.wbs`
- `do=open screen=PRJ-06`
- `do=spot ref=prj.project.adjustment`
- `do=open screen=PRJ-07`
- `do=spot ref=prj.project.milestones`
- `do=open screen=PRJ-08`
- `do=spot ref=prj.project.team`

**Cần thấy trên hình**

- [ ] Màn PRJ-04 "Hồ sơ pháp lý" mở được ở đường dẫn /prj/prj-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-05 "Cấu phần và WBS" mở được ở đường dẫn /prj/prj-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-06 "Điều chỉnh dự án" mở được ở đường dẫn /prj/prj-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-07 "Tiến độ và mốc" mở được ở đường dẫn /prj/prj-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-08 "Nhóm thực hiện" mở được ở đường dẫn /prj/prj-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần prj.project.legal-file đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.wbs đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.adjustment đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.milestones đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.team đúng lúc giọng đọc nói tới
- [ ] Cây công việc của dự án
- [ ] Lịch sử điều chỉnh có lý do
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `prj-leadership`

Nền tảng: web; 16.3 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-17` Phân công lãnh đạo phụ trách (/prj/prj-17); `PRJ-18` Tổ công tác đôn đốc giải ngân (/prj/prj-18); `PRJ-19` Yêu cầu và phản hồi giải trình (/prj/prj-19); `PRJ-20` Chuyển dự án giữa đơn vị (/prj/prj-20); `PRJ-21` Mã dự án trên Hệ thống TTQG về ĐTC (/prj/prj-21)

**Lời đọc**

> Mỗi dự án có lãnh đạo phụ trách. Tổ công tác đôn đốc giải ngân gửi yêu cầu giải trình và nhận phản hồi có hạn. Dự án chuyển giữa các đơn vị có hồ sơ, và mã dự án trên hệ thống quốc gia được gắn vào.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi dự án có lãnh đạo phụ trách. Tổ công tác đôn đốc giải ngân gửi yêu cầu giải trình và nhận phản hồi có hạn. Dự án chuyển giữa các đơn vị có hồ sơ, và mã dự án trên hệ thống quốc gia được gắn vào.

**Phụ đề**

- Mỗi dự án có lãnh đạo phụ trách.
- Tổ công tác đôn đốc giải ngân gửi yêu / cầu giải trình và nhận phản hồi có hạn.
- Dự án chuyển giữa các đơn vị có hồ sơ,
- và mã dự án trên hệ thống / quốc gia được gắn vào.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=PRJ-17`
- `do=spot ref=prj.project.leader-assignment`
- `do=open screen=PRJ-18`
- `do=spot ref=prj.project.task-force`
- `do=open screen=PRJ-19`
- `do=spot ref=prj.project.explanation-requests`
- `do=open screen=PRJ-20`
- `do=spot ref=prj.project.unit-transfer`
- `do=open screen=PRJ-21`
- `do=spot ref=prj.project.national-code`

**Cần thấy trên hình**

- [ ] Màn PRJ-17 "Phân công lãnh đạo phụ trách" mở được ở đường dẫn /prj/prj-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-18 "Tổ công tác đôn đốc giải ngân" mở được ở đường dẫn /prj/prj-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-19 "Yêu cầu và phản hồi giải trình" mở được ở đường dẫn /prj/prj-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-20 "Chuyển dự án giữa đơn vị" mở được ở đường dẫn /prj/prj-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-21 "Mã dự án trên Hệ thống TTQG về ĐTC" mở được ở đường dẫn /prj/prj-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần prj.project.leader-assignment đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.task-force đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.explanation-requests đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.unit-transfer đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.national-code đúng lúc giọng đọc nói tới
- [ ] Lãnh đạo phụ trách theo dự án
- [ ] Yêu cầu giải trình có hạn phản hồi
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `prj-closure`

Nền tảng: web; 13 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-13` Theo dõi dự án tháng (/prj/prj-13); `PRJ-11` Bàn giao tài sản (/prj/prj-11); `PRJ-12` Quyết toán dự án (/prj/prj-12)

**Lời đọc**

> Theo dõi dự án hằng tháng cho thấy tiến độ và giải ngân. Khi hoàn thành, dự án bàn giao tài sản rồi quyết toán. Mỗi bước sau chỉ mở khi bước trước đã đủ hồ sơ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Theo dõi dự án hằng tháng cho thấy tiến độ và giải ngân. Khi hoàn thành, dự án bàn giao tài sản rồi quyết toán. Mỗi bước sau chỉ mở khi bước trước đã đủ hồ sơ.

**Phụ đề**

- Theo dõi dự án hằng tháng cho / thấy tiến độ và giải ngân.
- Khi hoàn thành, dự án bàn / giao tài sản rồi quyết toán.
- Mỗi bước sau chỉ mở khi / bước trước đã đủ hồ sơ.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=PRJ-13`
- `do=spot ref=prj.project.monthly-follow-up`
- `do=open screen=PRJ-11`
- `do=spot ref=prj.project.asset-handover`
- `do=open screen=PRJ-12`
- `do=spot ref=prj.project.settlement`

**Cần thấy trên hình**

- [ ] Màn PRJ-13 "Theo dõi dự án tháng" mở được ở đường dẫn /prj/prj-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-11 "Bàn giao tài sản" mở được ở đường dẫn /prj/prj-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-12 "Quyết toán dự án" mở được ở đường dẫn /prj/prj-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần prj.project.monthly-follow-up đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.asset-handover đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.project.settlement đúng lúc giọng đọc nói tới
- [ ] Bảng theo dõi tháng
- [ ] Trạng thái bàn giao và quyết toán
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Kế hoạch và kiểm soát vốn (`capital-control`)

### `cc-plan`

Nền tảng: web; 15.4 giây; chỉ trong chương cắt riêng

Màn hình: `CAP-01` Kế hoạch trung hạn (/cap/cap-01); `CAP-02` Lập phương án vốn (/cap/cap-02); `CAP-04` Nguồn vốn (/cap/cap-04); `CAP-05` Quyết định giao vốn (/cap/cap-05); `CAP-06` Phân bổ vốn (/cap/cap-06)

**Lời đọc**

> Kế hoạch vốn bắt đầu từ trung hạn, qua phương án vốn, nguồn vốn và quyết định giao vốn, rồi phân bổ xuống từng dự án. Mỗi bước có người lập và người duyệt khác nhau, và con số ở bước sau không vượt bước trước.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kế hoạch vốn bắt đầu từ trung hạn, qua phương án vốn, nguồn vốn và quyết định giao vốn, rồi phân bổ xuống từng dự án. Mỗi bước có người lập và người duyệt khác nhau, và con số ở bước sau không vượt bước trước.

**Phụ đề**

- Kế hoạch vốn bắt đầu từ / trung hạn, qua phương án vốn,
- nguồn vốn và quyết định giao vốn, / rồi phân bổ xuống từng dự án.
- Mỗi bước có người lập và / người duyệt khác nhau,
- và con số ở bước sau / không vượt bước trước.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=CAP-01`
- `do=spot ref=cap.capital.mid-term`
- `do=open screen=CAP-02`
- `do=spot ref=cap.capital.option`
- `do=open screen=CAP-04`
- `do=spot ref=cap.capital.sources`
- `do=open screen=CAP-05`
- `do=spot ref=cap.capital.allocation-decisions`
- `do=open screen=CAP-06`
- `do=spot ref=cap.capital.allocation`

**Cần thấy trên hình**

- [ ] Màn CAP-01 "Kế hoạch trung hạn" mở được ở đường dẫn /cap/cap-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-02 "Lập phương án vốn" mở được ở đường dẫn /cap/cap-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-04 "Nguồn vốn" mở được ở đường dẫn /cap/cap-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-05 "Quyết định giao vốn" mở được ở đường dẫn /cap/cap-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-06 "Phân bổ vốn" mở được ở đường dẫn /cap/cap-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần cap.capital.mid-term đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.capital.option đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.capital.sources đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.capital.allocation-decisions đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.capital.allocation đúng lúc giọng đọc nói tới
- [ ] Phân bổ không vượt quyết định giao vốn
- [ ] Nguồn vốn theo cây phân loại
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `cc-approve-close`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `CAP-08` Đăng ký giải ngân tháng (/cap/cap-08); `CAP-10` Phê duyệt kế hoạch (/cap/cap-10); `CAP-11` Chuyển nguồn và khóa năm (/cap/cap-11); `CAP-14` Vốn hỗ trợ và tăng thu (/cap/cap-14); `CAP-15` Theo dõi kế hoạch vốn (/cap/cap-15)

**Lời đọc**

> Đăng ký giải ngân tháng, phê duyệt kế hoạch, chuyển nguồn và khóa năm đều đi qua luồng duyệt. Vốn hỗ trợ và tăng thu được theo dõi riêng. Màn theo dõi kế hoạch vốn so sánh kế hoạch với thực hiện suốt năm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đăng ký giải ngân tháng, phê duyệt kế hoạch, chuyển nguồn và khóa năm đều đi qua luồng duyệt. Vốn hỗ trợ và tăng thu được theo dõi riêng. Màn theo dõi kế hoạch vốn so sánh kế hoạch với thực hiện suốt năm.

**Phụ đề**

- Đăng ký giải ngân tháng, / phê duyệt kế hoạch,
- chuyển nguồn và khóa năm / đều đi qua luồng duyệt.
- Vốn hỗ trợ và tăng thu / được theo dõi riêng.
- Màn theo dõi kế hoạch vốn so sánh / kế hoạch với thực hiện suốt năm.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=CAP-08`
- `do=spot ref=cap.capital.monthly-registration`
- `do=open screen=CAP-10`
- `do=spot ref=cap.capital.plan-approval`
- `do=open screen=CAP-11`
- `do=spot ref=cap.capital.carry-over`
- `do=open screen=CAP-14`
- `do=open screen=CAP-15`
- `do=spot ref=cap.capital.plan-tracking`

**Cần thấy trên hình**

- [ ] Màn CAP-08 "Đăng ký giải ngân tháng" mở được ở đường dẫn /cap/cap-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-10 "Phê duyệt kế hoạch" mở được ở đường dẫn /cap/cap-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-11 "Chuyển nguồn và khóa năm" mở được ở đường dẫn /cap/cap-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-14 "Vốn hỗ trợ và tăng thu" mở được ở đường dẫn /cap/cap-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-15 "Theo dõi kế hoạch vốn" mở được ở đường dẫn /cap/cap-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần cap.capital.monthly-registration đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.capital.plan-approval đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.capital.carry-over đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.capital.plan-tracking đúng lúc giọng đọc nói tới
- [ ] Trạng thái phê duyệt kế hoạch
- [ ] Chuyển nguồn hiện số dư từng nguồn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `cc-limit-control`

Nền tảng: web; 14.2 giây; chỉ trong chương cắt riêng

Màn hình: `CAP-16` Sổ dự toán và nguồn được giao (/cap/cap-16); `CAP-17` Kiểm soát hạn mức khả dụng (AVC) (/cap/cap-17); `CAP-18` Giữ vốn trước cam kết (/cap/cap-18)

**Lời đọc**

> Sổ dự toán ghi nguồn được giao. Kiểm soát hạn mức khả dụng chặn cam kết vượt phần còn lại. Giữ vốn trước cam kết đặt chỗ trước cho gói thầu sắp ký, nên hai nơi không cùng tiêu một đồng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sổ dự toán ghi nguồn được giao. Kiểm soát hạn mức khả dụng chặn cam kết vượt phần còn lại. Giữ vốn trước cam kết đặt chỗ trước cho gói thầu sắp ký, nên hai nơi không cùng tiêu một đồng.

**Phụ đề**

- Sổ dự toán ghi nguồn được giao.
- Kiểm soát hạn mức khả dụng / chặn cam kết vượt phần còn lại.
- Giữ vốn trước cam kết đặt chỗ / trước cho gói thầu sắp ký,
- nên hai nơi không cùng tiêu một đồng.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=CAP-16`
- `do=spot ref=cap.control.estimate-ledger`
- `do=open screen=CAP-17`
- `do=spot ref=cap.control.available-limit`
- `do=open screen=CAP-18`
- `do=spot ref=cap.control.hold-before-commitment`

**Cần thấy trên hình**

- [ ] Màn CAP-16 "Sổ dự toán và nguồn được giao" mở được ở đường dẫn /cap/cap-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-17 "Kiểm soát hạn mức khả dụng (AVC)" mở được ở đường dẫn /cap/cap-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-18 "Giữ vốn trước cam kết" mở được ở đường dẫn /cap/cap-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần cap.control.estimate-ledger đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.control.available-limit đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.control.hold-before-commitment đúng lúc giọng đọc nói tới
- [ ] Chú thích "Không cam kết vượt hạn mức khả dụng" hiện từ giây 3, kéo dài 5 giây
- [ ] Hạn mức khả dụng sau khi trừ phần giữ
- [ ] Chặn cam kết vượt hạn mức
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `cc-ledger-extension`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `CAP-21` Sổ cái vốn và tra cứu theo thời điểm (/cap/cap-21); `CAP-20` Kéo dài thời gian giải ngân vốn (/cap/cap-20); `CAP-22` Kiểm soát vốn theo hợp đồng và dự báo hoàn thành (/cap/cap-22)

**Lời đọc**

> Sổ cái vốn tra cứu được theo bất kỳ thời điểm nào trong quá khứ. Kéo dài thời gian giải ngân phải có lý do và người duyệt. Kiểm soát vốn theo hợp đồng dự báo chi phí đến khi hoàn thành.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sổ cái vốn tra cứu được theo bất kỳ thời điểm nào trong quá khứ. Kéo dài thời gian giải ngân phải có lý do và người duyệt. Kiểm soát vốn theo hợp đồng dự báo chi phí đến khi hoàn thành.

**Phụ đề**

- Sổ cái vốn tra cứu được theo bất / kỳ thời điểm nào trong quá khứ.
- Kéo dài thời gian giải ngân / phải có lý do và người duyệt.
- Kiểm soát vốn theo hợp đồng dự / báo chi phí đến khi hoàn thành.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=CAP-21`
- `do=spot ref=cap.control.ledger-as-of`
- `do=open screen=CAP-20`
- `do=spot ref=cap.control.extension`
- `do=open screen=CAP-22`
- `do=spot ref=cap.control.contract-cost-forecast`

**Cần thấy trên hình**

- [ ] Màn CAP-21 "Sổ cái vốn và tra cứu theo thời điểm" mở được ở đường dẫn /cap/cap-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-20 "Kéo dài thời gian giải ngân vốn" mở được ở đường dẫn /cap/cap-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-22 "Kiểm soát vốn theo hợp đồng và dự báo hoàn thành" mở được ở đường dẫn /cap/cap-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần cap.control.ledger-as-of đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.control.extension đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.control.contract-cost-forecast đúng lúc giọng đọc nói tới
- [ ] Ô chọn ngày để tra sổ cái
- [ ] Dự báo hoàn thành theo hợp đồng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `cc-performance-transfer`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `CAP-23` Điều chuyển vốn theo hiệu suất và mô phỏng tác động (/cap/cap-23)

**Lời đọc**

> Đề xuất điều chuyển vốn theo hiệu suất đi cùng mô phỏng tác động: dự án nhận thêm bao nhiêu, dự án nhường giảm bao nhiêu. Việc phê duyệt có thể ủy quyền, nhưng người duyệt luôn khác người đề xuất.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đề xuất điều chuyển vốn theo hiệu suất đi cùng mô phỏng tác động: dự án nhận thêm bao nhiêu, dự án nhường giảm bao nhiêu. Việc phê duyệt có thể ủy quyền, nhưng người duyệt luôn khác người đề xuất.

**Phụ đề**

- Đề xuất điều chuyển vốn theo hiệu / suất đi cùng mô phỏng tác động:
- dự án nhận thêm bao nhiêu, / dự án nhường giảm bao nhiêu.
- Việc phê duyệt có thể ủy quyền, nhưng / người duyệt luôn khác người đề xuất.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=CAP-23`
- `do=spot ref=cap.transfer.performance-proposal`
- `do=spot ref=cap.transfer.impact-simulation`

**Cần thấy trên hình**

- [ ] Màn CAP-23 "Điều chuyển vốn theo hiệu suất và mô phỏng tác động" mở được ở đường dẫn /cap/cap-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần cap.transfer.performance-proposal đúng lúc giọng đọc nói tới
- [ ] Khung vào phần cap.transfer.impact-simulation đúng lúc giọng đọc nói tới
- [ ] Mô phỏng tác động trước và sau điều chuyển
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Thanh toán và Kho bạc (`payments`)

### `pay-request-file`

Nền tảng: web; 12.1 giây; chỉ trong chương cắt riêng

Màn hình: `PAY-01` Danh sách hồ sơ thanh toán (/pay/pay-01); `PAY-02` Tạo đề nghị thanh toán (/pay/pay-02); `PAY-03` Chi tiết và chứng từ (/pay/pay-03)

**Lời đọc**

> Hồ sơ thanh toán được tạo từ khối lượng đã nghiệm thu, đính chứng từ và kiểm điều kiện trước khi trình. Danh sách cho kế toán thấy hồ sơ nào đang ở bước nào.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hồ sơ thanh toán được tạo từ khối lượng đã nghiệm thu, đính chứng từ và kiểm điều kiện trước khi trình. Danh sách cho kế toán thấy hồ sơ nào đang ở bước nào.

**Phụ đề**

- Hồ sơ thanh toán được tạo / từ khối lượng đã nghiệm thu,
- đính chứng từ và kiểm / điều kiện trước khi trình.
- Danh sách cho kế toán thấy / hồ sơ nào đang ở bước nào.

**Các bước quay**

- `do=as persona=treasuryMaker`
- `do=open screen=PAY-01`
- `do=spot ref=pay.payment.list`
- `do=open screen=PAY-02`
- `do=spot ref=pay.payment.create`
- `do=open screen=PAY-03`
- `do=spot ref=pay.payment.documents`

**Cần thấy trên hình**

- [ ] Màn PAY-01 "Danh sách hồ sơ thanh toán" mở được ở đường dẫn /pay/pay-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-02 "Tạo đề nghị thanh toán" mở được ở đường dẫn /pay/pay-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-03 "Chi tiết và chứng từ" mở được ở đường dẫn /pay/pay-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản treasuryMaker
- [ ] Khung vào phần pay.payment.list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.payment.create đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.payment.documents đúng lúc giọng đọc nói tới
- [ ] Danh sách hồ sơ theo trạng thái
- [ ] Chứng từ gắn với từng hồ sơ
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pay-treasury-forms`

Nền tảng: web; 17 giây; chỉ trong chương cắt riêng

Màn hình: `PAY-04` Theo dõi gửi Kho bạc (/pay/pay-04); `PAY-13` Nhập sao kê Kho bạc (/pay/pay-13); `PAY-14` Biểu mẫu thanh toán Kho bạc (/pay/pay-14); `PAY-09` Theo dõi dự án Kho bạc (/pay/pay-09)

**Lời đọc**

> Theo dõi gửi Kho bạc, nhập sao kê, và các biểu mẫu thanh toán của Kho bạc. Các biểu mẫu hiện là mẫu demo, vì mẫu chính thức của Kho bạc chưa được cung cấp. Theo dõi dự án Kho bạc cho biết mỗi dự án đang ở đâu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Theo dõi gửi Kho bạc, nhập sao kê, và các biểu mẫu thanh toán của Kho bạc. Các biểu mẫu hiện là mẫu đê-mô, vì mẫu chính thức của Kho bạc chưa được cung cấp. Theo dõi dự án Kho bạc cho biết mỗi dự án đang ở đâu.

**Phụ đề**

- Theo dõi gửi Kho bạc, nhập sao kê, và / các biểu mẫu thanh toán của Kho bạc.
- Các biểu mẫu hiện là mẫu demo, vì mẫu / chính thức của Kho bạc chưa được cung cấp.
- Theo dõi dự án Kho bạc cho / biết mỗi dự án đang ở đâu.

**Các bước quay**

- `do=as persona=treasuryMaker`
- `do=open screen=PAY-04`
- `do=spot ref=pay.treasury.tracking`
- `do=open screen=PAY-13`
- `do=spot ref=pay.treasury.statement-import`
- `do=open screen=PAY-14`
- `do=spot ref=pay.treasury.forms`
- `do=open screen=PAY-09`
- `do=spot ref=pay.treasury.project-tracking`

**Cần thấy trên hình**

- [ ] Màn PAY-04 "Theo dõi gửi Kho bạc" mở được ở đường dẫn /pay/pay-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-13 "Nhập sao kê Kho bạc" mở được ở đường dẫn /pay/pay-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-14 "Biểu mẫu thanh toán Kho bạc" mở được ở đường dẫn /pay/pay-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-09 "Theo dõi dự án Kho bạc" mở được ở đường dẫn /pay/pay-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản treasuryMaker
- [ ] Khung vào phần pay.treasury.tracking đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.treasury.statement-import đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.treasury.forms đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.treasury.project-tracking đúng lúc giọng đọc nói tới
- [ ] Chú thích "MẪU DEMO — chờ mẫu chính thức" hiện từ giây 5, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "MẪU DEMO — chờ mẫu chính thức"
- [ ] Nhãn mẫu demo hiện trên biểu mẫu
- [ ] Sao kê nhập có số dòng khớp
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pay-mismatch-trace`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `PAY-06` Xử lý sai lệch (/pay/pay-06); `PAY-08` Đảo và điều chỉnh giao dịch (/pay/pay-08); `PAY-17` Truy vết chuỗi thanh toán (/pay/pay-17)

**Lời đọc**

> Sai lệch được xử lý có lý do. Đảo và điều chỉnh giao dịch không xóa giao dịch cũ mà thêm bút toán mới. Truy vết chuỗi thanh toán đi từ khối lượng, nghiệm thu, đề nghị đến giao dịch Kho bạc.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sai lệch được xử lý có lý do. Đảo và điều chỉnh giao dịch không xóa giao dịch cũ mà thêm bút toán mới. Truy vết chuỗi thanh toán đi từ khối lượng, nghiệm thu, đề nghị đến giao dịch Kho bạc.

**Phụ đề**

- Sai lệch được xử lý có lý do.
- Đảo và điều chỉnh giao dịch không xóa / giao dịch cũ mà thêm bút toán mới.
- Truy vết chuỗi thanh / toán đi từ khối lượng,
- nghiệm thu, đề nghị đến giao dịch Kho bạc.

**Các bước quay**

- `do=as persona=treasuryMaker`
- `do=open screen=PAY-06`
- `do=spot ref=pay.mismatch.handling`
- `do=open screen=PAY-08`
- `do=spot ref=pay.mismatch.reverse-adjust`
- `do=open screen=PAY-17`
- `do=spot ref=pay.mismatch.chain-trace`

**Cần thấy trên hình**

- [ ] Màn PAY-06 "Xử lý sai lệch" mở được ở đường dẫn /pay/pay-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-08 "Đảo và điều chỉnh giao dịch" mở được ở đường dẫn /pay/pay-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-17 "Truy vết chuỗi thanh toán" mở được ở đường dẫn /pay/pay-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản treasuryMaker
- [ ] Khung vào phần pay.mismatch.handling đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.mismatch.reverse-adjust đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.mismatch.chain-trace đúng lúc giọng đọc nói tới
- [ ] Chuỗi truy vết từ khối lượng đến Kho bạc
- [ ] Bút toán đảo có tham chiếu giao dịch gốc
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pay-treasury-clocks`

Nền tảng: web; 22.5 giây; chỉ trong chương cắt riêng

Màn hình: `PAY-22` Đồng hồ xử lý của Kho bạc: thanh toán 2 ngày, tạm ứng 1 ngày (/pay/pay-22); `PAY-21` Ngoại lệ vượt trần giải ngân (/pay/pay-21)

**Lời đọc**

> Đồng hồ xử lý của Kho bạc đo hạn thanh toán và hạn tạm ứng theo ngày làm việc. Tỷ lệ xử lý đúng hạn là {{figure:pay-in-time}}, có {{figure:pay-breached}} hồ sơ hết hạn. Lý do trả lại theo danh mục chuẩn, và ngoại lệ vượt trần giải ngân có người duyệt. Số ngày là cấu hình mặc định, chưa kiểm chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đồng hồ xử lý của Kho bạc đo hạn thanh toán và hạn tạm ứng theo ngày làm việc. Tỷ lệ xử lý đúng hạn là {{figure:pay-in-time}}, có {{figure:pay-breached}} hồ sơ hết hạn. Lý do trả lại theo danh mục chuẩn, và ngoại lệ vượt trần giải ngân có người duyệt. Số ngày là cấu hình mặc định, chưa kiểm chứng.

**Phụ đề**

- Đồng hồ xử lý của Kho bạc đo hạn thanh
- toán và hạn tạm ứng theo ngày làm việc.
- Tỷ lệ xử lý đúng hạn là / {n}, có {n} hồ sơ hết hạn.
- Lý do trả lại theo danh mục chuẩn,
- và ngoại lệ vượt trần / giải ngân có người duyệt.
- Số ngày là cấu hình mặc / định, chưa kiểm chứng.

**Các bước quay**

- `do=as persona=treasuryMaker`
- `do=open screen=PAY-22`
- `do=spot ref=pay.clocks.treasury`
- `do=open screen=PAY-21`
- `do=spot ref=pay.clocks.ceiling-exception`

**Cần thấy trên hình**

- [ ] Màn PAY-22 "Đồng hồ xử lý của Kho bạc: thanh toán 2 ngày, tạm ứng 1 ngày" mở được ở đường dẫn /pay/pay-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-21 "Ngoại lệ vượt trần giải ngân" mở được ở đường dẫn /pay/pay-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản treasuryMaker
- [ ] Khung vào phần pay.clocks.treasury đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.clocks.ceiling-exception đúng lúc giọng đọc nói tới
- [ ] Chú thích "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng" hiện từ giây 4, kéo dài 7 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng"
- [ ] Con số pay-in-time đọc từ dữ liệu thật qua listPaymentClocks (summary.in_time_rate_pct); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số pay-breached đọc từ dữ liệu thật qua listPaymentClocks (summary.breached); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Đồng hồ hiện giờ làm việc còn lại
- [ ] Lý do trả lại theo danh mục chuẩn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pay-advance-settlement`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `PAY-11` Đề nghị tạm ứng (/pay/pay-11); `PAY-07` Tạm ứng và thu hồi (/pay/pay-07); `PAY-15` Quyết toán niên độ và dự án hoàn thành (/pay/pay-15); `PAY-16` Biểu mẫu quyết toán và hạn thẩm tra (/pay/pay-16)

**Lời đọc**

> Đề nghị tạm ứng, thu hồi tạm ứng theo lịch, rồi quyết toán niên độ và quyết toán dự án hoàn thành. Biểu mẫu quyết toán có hạn thẩm tra. Tạm ứng quá hạn thu hồi bị cảnh báo đến đúng người.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đề nghị tạm ứng, thu hồi tạm ứng theo lịch, rồi quyết toán niên độ và quyết toán dự án hoàn thành. Biểu mẫu quyết toán có hạn thẩm tra. Tạm ứng quá hạn thu hồi bị cảnh báo đến đúng người.

**Phụ đề**

- Đề nghị tạm ứng, thu / hồi tạm ứng theo lịch,
- rồi quyết toán niên độ và / quyết toán dự án hoàn thành.
- Biểu mẫu quyết toán có hạn thẩm tra.
- Tạm ứng quá hạn thu hồi bị / cảnh báo đến đúng người.

**Các bước quay**

- `do=as persona=treasuryMaker`
- `do=open screen=PAY-11`
- `do=spot ref=pay.advance.request`
- `do=open screen=PAY-07`
- `do=spot ref=pay.advance.recovery`
- `do=open screen=PAY-15`
- `do=spot ref=pay.settlement.annual`
- `do=open screen=PAY-16`
- `do=spot ref=pay.settlement.forms-deadlines`

**Cần thấy trên hình**

- [ ] Màn PAY-11 "Đề nghị tạm ứng" mở được ở đường dẫn /pay/pay-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-07 "Tạm ứng và thu hồi" mở được ở đường dẫn /pay/pay-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-15 "Quyết toán niên độ và dự án hoàn thành" mở được ở đường dẫn /pay/pay-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PAY-16 "Biểu mẫu quyết toán và hạn thẩm tra" mở được ở đường dẫn /pay/pay-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản treasuryMaker
- [ ] Khung vào phần pay.advance.request đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.advance.recovery đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.settlement.annual đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pay.settlement.forms-deadlines đúng lúc giọng đọc nói tới
- [ ] Lịch thu hồi tạm ứng
- [ ] Hạn thẩm tra quyết toán
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pay-phone-treasury`

Nền tảng: phone; 10.2 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-60` Đối soát Kho bạc trên điện thoại (tab projects); `MOB-27` Theo dõi thanh toán (tab projects)

**Lời đọc**

> Kế toán đối soát Kho bạc và theo dõi thanh toán ngay trên điện thoại. Việc xử lý tiếp vẫn làm ở máy tính với đầy đủ chứng từ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kế toán đối soát Kho bạc và theo dõi thanh toán ngay trên điện thoại. Việc xử lý tiếp vẫn làm ở máy tính với đầy đủ chứng từ.

**Phụ đề**

- Kế toán đối soát Kho bạc và theo / dõi thanh toán ngay trên điện thoại.
- Việc xử lý tiếp vẫn làm ở / máy tính với đầy đủ chứng từ.

**Các bước quay**

- `do=as persona=treasuryMaker`
- `do=phone-open screen=MOB-60`
- `do=spot ref=mob.treasury.reconcile`
- `do=phone-open screen=MOB-27`
- `do=spot ref=mob.treasury.payment-tracking`

**Cần thấy trên hình**

- [ ] Màn MOB-60 "Đối soát Kho bạc trên điện thoại" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-27 "Theo dõi thanh toán" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản treasuryMaker
- [ ] Khung vào phần mob.treasury.reconcile đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.treasury.payment-tracking đúng lúc giọng đọc nói tới
- [ ] Màn đối soát Kho bạc trên điện thoại
- [ ] Dòng lệch được đánh dấu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Báo cáo biểu mẫu và chốt kỳ (`reports-close`)

### `rc-period-figures`

Nền tảng: web; 17.3 giây; chỉ trong chương cắt riêng

Màn hình: `DIS-27` Số liệu vốn theo kỳ: kế hoạch gốc và điều chỉnh, số ước, số thực, lũy kế và các tỷ lệ (/dis/dis-27); `DIS-28` Lập và duyệt lô số liệu vốn: kế hoạch phân kỳ, số ước, số thực, điều chỉnh muộn (/dis/dis-28); `DIS-29` Lịch sử chuyển đổi của một kỳ: các lần ước rồi số thực thay thế (/dis/dis-29)

**Lời đọc**

> Số liệu vốn theo kỳ gồm kế hoạch gốc và điều chỉnh, số ước, số thực, lũy kế và các tỷ lệ. Lô số liệu do một người lập, người khác duyệt. Mỗi kỳ giữ lịch sử các lần ước rồi số thực thay thế, nên không ai sửa lặng lẽ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Số liệu vốn theo kỳ gồm kế hoạch gốc và điều chỉnh, số ước, số thực, lũy kế và các tỷ lệ. Lô số liệu do một người lập, người khác duyệt. Mỗi kỳ giữ lịch sử các lần ước rồi số thực thay thế, nên không ai sửa lặng lẽ.

**Phụ đề**

- Số liệu vốn theo kỳ gồm kế / hoạch gốc và điều chỉnh,
- số ước, số thực, lũy kế và các tỷ lệ.
- Lô số liệu do một người / lập, người khác duyệt.
- Mỗi kỳ giữ lịch sử các lần ước rồi số / thực thay thế, nên không ai sửa lặng lẽ.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=DIS-27`
- `do=spot ref=dis.figures.period-table`
- `do=open screen=DIS-28`
- `do=spot ref=dis.figures.batch-approval`
- `do=open screen=DIS-29`
- `do=spot ref=dis.figures.conversion-history`

**Cần thấy trên hình**

- [ ] Màn DIS-27 "Số liệu vốn theo kỳ: kế hoạch gốc và điều chỉnh, số ước, số thực, lũy kế và các tỷ lệ" mở được ở đường dẫn /dis/dis-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-28 "Lập và duyệt lô số liệu vốn: kế hoạch phân kỳ, số ước, số thực, điều chỉnh muộn" mở được ở đường dẫn /dis/dis-28, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-29 "Lịch sử chuyển đổi của một kỳ: các lần ước rồi số thực thay thế" mở được ở đường dẫn /dis/dis-29, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần dis.figures.period-table đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.figures.batch-approval đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.figures.conversion-history đúng lúc giọng đọc nói tới
- [ ] Chú thích "Người lập ≠ người duyệt lô số liệu" hiện từ giây 3, kéo dài 5 giây
- [ ] Bảng số liệu kỳ có cột gốc, điều chỉnh, ước, thực
- [ ] Lịch sử chuyển đổi của một kỳ
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rc-definitions`

Nền tảng: web; 16.3 giây; chỉ trong chương cắt riêng

Màn hình: `DIS-25` Định nghĩa chỉ tiêu kỳ/YTD/lũy kế và bộ số golden (/dis/dis-25); `DIS-26` Kiểm tổng chéo số giải ngân theo đơn vị, nguồn vốn, dự án (/dis/dis-26); `DIS-19` Hai tỷ lệ giải ngân song song (/dis/dis-19)

**Lời đọc**

> Định nghĩa chỉ tiêu kỳ, từ đầu năm và lũy kế được viết một lần và có bộ số kiểm. Hai tỷ lệ giải ngân chạy song song để so sánh. Kiểm tổng chéo giữa đơn vị, nguồn vốn và dự án phát hiện ngay số bị lệch.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Định nghĩa chỉ tiêu kỳ, từ đầu năm và lũy kế được viết một lần và có bộ số kiểm. Hai tỷ lệ giải ngân chạy song song để so sánh. Kiểm tổng chéo giữa đơn vị, nguồn vốn và dự án phát hiện ngay số bị lệch.

**Phụ đề**

- Định nghĩa chỉ tiêu kỳ, từ đầu năm và lũy / kế được viết một lần và có bộ số kiểm.
- Hai tỷ lệ giải ngân chạy / song song để so sánh.
- Kiểm tổng chéo giữa đơn vị, nguồn vốn / và dự án phát hiện ngay số bị lệch.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=DIS-25`
- `do=spot ref=dis.definitions.golden`
- `do=open screen=DIS-26`
- `do=spot ref=dis.definitions.cross-check`
- `do=open screen=DIS-19`
- `do=spot ref=dis.definitions.two-rates`

**Cần thấy trên hình**

- [ ] Màn DIS-25 "Định nghĩa chỉ tiêu kỳ/YTD/lũy kế và bộ số golden" mở được ở đường dẫn /dis/dis-25, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-26 "Kiểm tổng chéo số giải ngân theo đơn vị, nguồn vốn, dự án" mở được ở đường dẫn /dis/dis-26, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-19 "Hai tỷ lệ giải ngân song song" mở được ở đường dẫn /dis/dis-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần dis.definitions.golden đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.definitions.cross-check đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.definitions.two-rates đúng lúc giọng đọc nói tới
- [ ] Bộ số kiểm hiện kết quả khớp
- [ ] Bảng kiểm tổng chéo có dòng lệch tô màu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rc-calendar-board`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `DIS-14` Lịch kỳ và khóa sổ (/dis/dis-14); `DIS-15` Tiến độ nộp báo cáo (/dis/dis-15); `DIS-12` Tổng hợp theo chủ đầu tư (/dis/dis-12)

**Lời đọc**

> Lịch kỳ và khóa sổ cho biết kỳ nào mở, kỳ nào đã đóng và hạn nộp. Bảng tiến độ nộp báo cáo cho thấy đơn vị nào đã nộp, đơn vị nào còn thiếu. Tổng hợp theo chủ đầu tư lên số cho lãnh đạo.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Lịch kỳ và khóa sổ cho biết kỳ nào mở, kỳ nào đã đóng và hạn nộp. Bảng tiến độ nộp báo cáo cho thấy đơn vị nào đã nộp, đơn vị nào còn thiếu. Tổng hợp theo chủ đầu tư lên số cho lãnh đạo.

**Phụ đề**

- Lịch kỳ và khóa sổ cho biết kỳ / nào mở, kỳ nào đã đóng và hạn nộp.
- Bảng tiến độ nộp báo cáo cho thấy đơn / vị nào đã nộp, đơn vị nào còn thiếu.
- Tổng hợp theo chủ đầu / tư lên số cho lãnh đạo.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=DIS-14`
- `do=spot ref=dis.calendar.periods`
- `do=open screen=DIS-15`
- `do=spot ref=dis.calendar.submission-board`
- `do=open screen=DIS-12`
- `do=spot ref=dis.calendar.investor-total`

**Cần thấy trên hình**

- [ ] Màn DIS-14 "Lịch kỳ và khóa sổ" mở được ở đường dẫn /dis/dis-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-15 "Tiến độ nộp báo cáo" mở được ở đường dẫn /dis/dis-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-12 "Tổng hợp theo chủ đầu tư" mở được ở đường dẫn /dis/dis-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần dis.calendar.periods đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.calendar.submission-board đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.calendar.investor-total đúng lúc giọng đọc nói tới
- [ ] Lịch kỳ có trạng thái mở hoặc đóng
- [ ] Bảng nộp có đơn vị còn thiếu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rc-lock-sign`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `RPT-06` Khóa kỳ và chữ ký số báo cáo (/rpt/rpt-06); `RPT-02` Bản nháp báo cáo, xem trước và luồng kiểm tra, phê duyệt, phát hành (/rpt/rpt-02)

**Lời đọc**

> Chốt kỳ khóa số liệu, báo cáo phát hành được ký số. Mở lại kỳ đã chốt phải có lý do và để lại vết. Bản nháp báo cáo xem trước được, rồi đi qua luồng kiểm tra, phê duyệt, phát hành.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chốt kỳ khóa số liệu, báo cáo phát hành được ký số. Mở lại kỳ đã chốt phải có lý do và để lại vết. Bản nháp báo cáo xem trước được, rồi đi qua luồng kiểm tra, phê duyệt, phát hành.

**Phụ đề**

- Chốt kỳ khóa số liệu, báo / cáo phát hành được ký số.
- Mở lại kỳ đã chốt phải / có lý do và để lại vết.
- Bản nháp báo cáo xem trước được, rồi đi / qua luồng kiểm tra, phê duyệt, phát hành.

**Các bước quay**

- `do=as persona=docHead`
- `do=open screen=RPT-06`
- `do=spot ref=rpt.lock.period-lock`
- `do=spot ref=rpt.lock.digital-signature`
- `do=open screen=RPT-02`
- `do=spot ref=rpt.lock.draft-review`

**Cần thấy trên hình**

- [ ] Màn RPT-06 "Khóa kỳ và chữ ký số báo cáo" mở được ở đường dẫn /rpt/rpt-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn RPT-02 "Bản nháp báo cáo, xem trước và luồng kiểm tra, phê duyệt, phát hành" mở được ở đường dẫn /rpt/rpt-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản docHead
- [ ] Khung vào phần rpt.lock.period-lock đúng lúc giọng đọc nói tới
- [ ] Khung vào phần rpt.lock.digital-signature đúng lúc giọng đọc nói tới
- [ ] Khung vào phần rpt.lock.draft-review đúng lúc giọng đọc nói tới
- [ ] Dòng kỳ đã khóa có người chốt
- [ ] Chữ ký số trên báo cáo đã phát hành
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rc-workflow-builder`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-06` Dựng quy trình phê duyệt (/adm/adm-06); `ADM-15` Ma trận thẩm quyền phê duyệt (/adm/adm-15)

**Lời đọc**

> Quản trị dựng luồng phê duyệt bằng giao diện, không cần lập trình: bước, người duyệt song song, hạn xử lý. Ma trận thẩm quyền xác định ai duyệt đến mức nào. Luồng dùng chung cho báo cáo, hồ sơ, tài liệu và lô số liệu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Quản trị dựng luồng phê duyệt bằng giao diện, không cần lập trình: bước, người duyệt song song, hạn xử lý. Ma trận thẩm quyền xác định ai duyệt đến mức nào. Luồng dùng chung cho báo cáo, hồ sơ, tài liệu và lô số liệu.

**Phụ đề**

- Quản trị dựng luồng phê / duyệt bằng giao diện,
- không cần lập trình: bước, người / duyệt song song, hạn xử lý.
- Ma trận thẩm quyền xác / định ai duyệt đến mức nào.
- Luồng dùng chung cho báo cáo, / hồ sơ, tài liệu và lô số liệu.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=ADM-06`
- `do=spot ref=adm.workflow.builder`
- `do=open screen=ADM-15`
- `do=spot ref=adm.workflow.authority-matrix`

**Cần thấy trên hình**

- [ ] Màn ADM-06 "Dựng quy trình phê duyệt" mở được ở đường dẫn /adm/adm-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-15 "Ma trận thẩm quyền phê duyệt" mở được ở đường dẫn /adm/adm-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần adm.workflow.builder đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.workflow.authority-matrix đúng lúc giọng đọc nói tới
- [ ] Trình dựng luồng hiện các bước và hạn
- [ ] Ma trận thẩm quyền theo mức giá trị
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rc-excel-entry`

Nền tảng: web; 15.4 giây; chỉ trong chương cắt riêng

Màn hình: `IND-03` Bảng ánh xạ nhập Excel (/ind/ind-03); `DIS-10` Nhập dữ liệu hàng loạt (/dis/dis-10); `DIS-16` Bảng số liệu đầy đủ và cấu hình cột (/dis/dis-16)

**Lời đọc**

> Đơn vị nhập từ tệp Excel qua bảng ánh xạ đã được duyệt, nên cột nào vào chỉ tiêu nào đã cố định. Nhập hàng loạt chạy thử trước khi áp dụng. Bảng số liệu đầy đủ cho cấu hình cột theo nhu cầu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đơn vị nhập từ tệp ếch-xeo qua bảng ánh xạ đã được duyệt, nên cột nào vào chỉ tiêu nào đã cố định. Nhập hàng loạt chạy thử trước khi áp dụng. Bảng số liệu đầy đủ cho cấu hình cột theo nhu cầu.

**Phụ đề**

- Đơn vị nhập từ tệp Excel qua / bảng ánh xạ đã được duyệt,
- nên cột nào vào chỉ tiêu nào đã cố định.
- Nhập hàng loạt chạy thử trước khi áp dụng.
- Bảng số liệu đầy đủ cho / cấu hình cột theo nhu cầu.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=IND-03`
- `do=spot ref=ind.entry.excel-mapping`
- `do=open screen=DIS-10`
- `do=spot ref=dis.entry.bulk`
- `do=open screen=DIS-16`
- `do=spot ref=dis.entry.full-table`

**Cần thấy trên hình**

- [ ] Màn IND-03 "Bảng ánh xạ nhập Excel" mở được ở đường dẫn /ind/ind-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-10 "Nhập dữ liệu hàng loạt" mở được ở đường dẫn /dis/dis-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-16 "Bảng số liệu đầy đủ và cấu hình cột" mở được ở đường dẫn /dis/dis-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần ind.entry.excel-mapping đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.entry.bulk đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.entry.full-table đúng lúc giọng đọc nói tới
- [ ] Bảng ánh xạ có phiên bản đã duyệt
- [ ] Kết quả chạy thử hiện dòng lỗi
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rc-history-narrative`

Nền tảng: web; 14.2 giây; chỉ trong chương cắt riêng

Màn hình: `DIS-11` Lịch sử và so sánh (/dis/dis-11); `DIS-13` Báo cáo thuyết minh tháng (/dis/dis-13)

**Lời đọc**

> Lịch sử và so sánh đặt báo cáo kỳ này cạnh các kỳ trước. Báo cáo thuyết minh tháng nêu tình hình, nguyên nhân và đề xuất của từng dự án, nên lãnh đạo đọc được câu chuyện đằng sau con số.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Lịch sử và so sánh đặt báo cáo kỳ này cạnh các kỳ trước. Báo cáo thuyết minh tháng nêu tình hình, nguyên nhân và đề xuất của từng dự án, nên lãnh đạo đọc được câu chuyện đằng sau con số.

**Phụ đề**

- Lịch sử và so sánh đặt báo / cáo kỳ này cạnh các kỳ trước.
- Báo cáo thuyết minh tháng nêu / tình hình, nguyên nhân và đề xuất
- của từng dự án, nên lãnh đạo đọc / được câu chuyện đằng sau con số.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=DIS-11`
- `do=spot ref=dis.history.compare`
- `do=open screen=DIS-13`
- `do=spot ref=dis.history.monthly-narrative`

**Cần thấy trên hình**

- [ ] Màn DIS-11 "Lịch sử và so sánh" mở được ở đường dẫn /dis/dis-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-13 "Báo cáo thuyết minh tháng" mở được ở đường dẫn /dis/dis-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần dis.history.compare đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.history.monthly-narrative đúng lúc giọng đọc nói tới
- [ ] So sánh hai kỳ cạnh nhau
- [ ] Thuyết minh của một dự án
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rc-export-formats`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `DIS-17` Xem trước xuất báo cáo (/dis/dis-17)

**Lời đọc**

> Mọi bảng số liệu xuất được ra Excel, Word, PDF hoặc CSV. Xem trước xuất cho thấy đúng những gì sẽ có trong tệp. Quyền và nhật ký của mọi định dạng giống hệt nhau.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mọi bảng số liệu xuất được ra ếch-xeo, oớt, pi-đi-ép hoặc xi-ét-vi. Xem trước xuất cho thấy đúng những gì sẽ có trong tệp. Quyền và nhật ký của mọi định dạng giống hệt nhau.

**Phụ đề**

- Mọi bảng số liệu xuất được / ra Excel, Word, PDF hoặc CSV.
- Xem trước xuất cho thấy đúng / những gì sẽ có trong tệp.
- Quyền và nhật ký của mọi / định dạng giống hệt nhau.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=DIS-17`
- `do=spot ref=dis.export.preview`
- `do=spot ref=dis.export.formats`

**Cần thấy trên hình**

- [ ] Màn DIS-17 "Xem trước xuất báo cáo" mở được ở đường dẫn /dis/dis-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần dis.export.preview đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dis.export.formats đúng lúc giọng đọc nói tới
- [ ] Hộp chọn định dạng xuất
- [ ] Bản xem trước khớp với bảng đang xem
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Báo cáo giám sát và nộp lên hệ thống quốc gia (`monitoring`)

### `mon-calendar`

Nền tảng: web; 13 giây; chỉ trong chương cắt riêng

Màn hình: `MNE-01` Lịch nghĩa vụ báo cáo giám sát (/mne/mne-01); `MNE-02` Danh mục mẫu biểu giám sát (/mne/mne-02)

**Lời đọc**

> Lịch nghĩa vụ báo cáo giám sát liệt kê báo cáo nào phải nộp, cho ai, vào ngày nào. Danh mục mẫu biểu giám sát giữ phiên bản của từng mẫu. Hạn nộp nhắc trước khi đến.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Lịch nghĩa vụ báo cáo giám sát liệt kê báo cáo nào phải nộp, cho ai, vào ngày nào. Danh mục mẫu biểu giám sát giữ phiên bản của từng mẫu. Hạn nộp nhắc trước khi đến.

**Phụ đề**

- Lịch nghĩa vụ báo cáo giám sát liệt kê báo / cáo nào phải nộp, cho ai, vào ngày nào.
- Danh mục mẫu biểu giám sát / giữ phiên bản của từng mẫu.
- Hạn nộp nhắc trước khi đến.

**Các bước quay**

- `do=as persona=mneAdmin`
- `do=open screen=MNE-01`
- `do=spot ref=mne.monitoring.duty-calendar`
- `do=open screen=MNE-02`
- `do=spot ref=mne.monitoring.form-catalogue`

**Cần thấy trên hình**

- [ ] Màn MNE-01 "Lịch nghĩa vụ báo cáo giám sát" mở được ở đường dẫn /mne/mne-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MNE-02 "Danh mục mẫu biểu giám sát" mở được ở đường dẫn /mne/mne-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản mneAdmin
- [ ] Khung vào phần mne.monitoring.duty-calendar đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mne.monitoring.form-catalogue đúng lúc giọng đọc nói tới
- [ ] Lịch nghĩa vụ có hạn nộp
- [ ] Mẫu biểu có phiên bản
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `mon-draft`

Nền tảng: web; 13 giây; chỉ trong chương cắt riêng

Màn hình: `MNE-03` Lập báo cáo giám sát tổng thể định kỳ (/mne/mne-03); `MNE-04` Báo cáo giám sát theo dự án (/mne/mne-04); `MNE-07` Báo cáo nhanh tuần (/mne/mne-07)

**Lời đọc**

> Báo cáo giám sát tổng thể định kỳ và báo cáo theo từng dự án được lập từ số liệu có sẵn, không nhập lại. Báo cáo nhanh tuần giúp lãnh đạo nắm tình hình giữa hai kỳ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Báo cáo giám sát tổng thể định kỳ và báo cáo theo từng dự án được lập từ số liệu có sẵn, không nhập lại. Báo cáo nhanh tuần giúp lãnh đạo nắm tình hình giữa hai kỳ.

**Phụ đề**

- Báo cáo giám sát tổng thể / định kỳ và báo cáo theo từng
- dự án được lập từ số liệu / có sẵn, không nhập lại.
- Báo cáo nhanh tuần giúp lãnh / đạo nắm tình hình giữa hai kỳ.

**Các bước quay**

- `do=as persona=mneAdmin`
- `do=open screen=MNE-03`
- `do=spot ref=mne.monitoring.periodic-report`
- `do=open screen=MNE-04`
- `do=spot ref=mne.monitoring.project-report`
- `do=open screen=MNE-07`
- `do=spot ref=mne.monitoring.weekly-quick`

**Cần thấy trên hình**

- [ ] Màn MNE-03 "Lập báo cáo giám sát tổng thể định kỳ" mở được ở đường dẫn /mne/mne-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MNE-04 "Báo cáo giám sát theo dự án" mở được ở đường dẫn /mne/mne-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MNE-07 "Báo cáo nhanh tuần" mở được ở đường dẫn /mne/mne-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản mneAdmin
- [ ] Khung vào phần mne.monitoring.periodic-report đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mne.monitoring.project-report đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mne.monitoring.weekly-quick đúng lúc giọng đọc nói tới
- [ ] Báo cáo lập từ số liệu của hệ thống
- [ ] Báo cáo nhanh tuần
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `mon-issue`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `MNE-05` Rà soát, phê duyệt và phát hành (/mne/mne-05); `MNE-06` Xuất tệp và xác nhận nộp Hệ thống TTQG (/mne/mne-06); `MNE-09` Tiến độ nộp báo cáo giám sát (/mne/mne-09); `MNE-10` Lịch sử phiên bản và đính chính báo cáo (/mne/mne-10)

**Lời đọc**

> Báo cáo được rà soát, phê duyệt và phát hành. Hệ thống xuất tệp để nộp lên hệ thống quốc gia và ghi xác nhận đã nộp. Tiến độ nộp theo dõi từng đơn vị, và đính chính để lại lịch sử phiên bản.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Báo cáo được rà soát, phê duyệt và phát hành. Hệ thống xuất tệp để nộp lên hệ thống quốc gia và ghi xác nhận đã nộp. Tiến độ nộp theo dõi từng đơn vị, và đính chính để lại lịch sử phiên bản.

**Phụ đề**

- Báo cáo được rà soát, / phê duyệt và phát hành.
- Hệ thống xuất tệp để nộp lên hệ thống / quốc gia và ghi xác nhận đã nộp.
- Tiến độ nộp theo dõi từng đơn vị, và / đính chính để lại lịch sử phiên bản.

**Các bước quay**

- `do=as persona=mneAdmin`
- `do=open screen=MNE-05`
- `do=spot ref=mne.monitoring.review-approve-issue`
- `do=open screen=MNE-06`
- `do=spot ref=mne.monitoring.export-confirm`
- `do=open screen=MNE-09`
- `do=spot ref=mne.monitoring.submission-progress`
- `do=open screen=MNE-10`
- `do=spot ref=mne.monitoring.corrections`

**Cần thấy trên hình**

- [ ] Màn MNE-05 "Rà soát, phê duyệt và phát hành" mở được ở đường dẫn /mne/mne-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MNE-06 "Xuất tệp và xác nhận nộp Hệ thống TTQG" mở được ở đường dẫn /mne/mne-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MNE-09 "Tiến độ nộp báo cáo giám sát" mở được ở đường dẫn /mne/mne-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MNE-10 "Lịch sử phiên bản và đính chính báo cáo" mở được ở đường dẫn /mne/mne-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản mneAdmin
- [ ] Khung vào phần mne.monitoring.review-approve-issue đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mne.monitoring.export-confirm đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mne.monitoring.submission-progress đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mne.monitoring.corrections đúng lúc giọng đọc nói tới
- [ ] Xác nhận nộp có ngày và người nộp
- [ ] Lịch sử phiên bản của báo cáo đính chính
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `mon-mof-forms`

Nền tảng: web; 17.3 giây; chỉ trong chương cắt riêng

Màn hình: `RPT-05` Biểu mẫu báo cáo gửi Bộ Tài chính (/rpt/rpt-05); `RPT-04` Nhật ký giao báo cáo cho bên nhận (/rpt/rpt-04)

**Lời đọc**

> Biểu mẫu báo cáo gửi Bộ Tài chính do công cụ sinh báo cáo lập từ số liệu đã chốt. Nhật ký giao báo cáo cho bên nhận ghi ai gửi, gửi cho ai, lúc nào, và tệp nào. Mẫu theo quy định là cấu hình mặc định, chưa kiểm chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Biểu mẫu báo cáo gửi Bộ Tài chính do công cụ sinh báo cáo lập từ số liệu đã chốt. Nhật ký giao báo cáo cho bên nhận ghi ai gửi, gửi cho ai, lúc nào, và tệp nào. Mẫu theo quy định là cấu hình mặc định, chưa kiểm chứng.

**Phụ đề**

- Biểu mẫu báo cáo gửi Bộ Tài chính do công / cụ sinh báo cáo lập từ số liệu đã chốt.
- Nhật ký giao báo cáo cho bên nhận ghi / ai gửi, gửi cho ai, lúc nào, và tệp nào.
- Mẫu theo quy định là cấu hình / mặc định, chưa kiểm chứng.

**Các bước quay**

- `do=as persona=docHead`
- `do=open screen=RPT-05`
- `do=spot ref=rpt.mof.form`
- `do=open screen=RPT-04`
- `do=spot ref=rpt.mof.delivery-log`

**Cần thấy trên hình**

- [ ] Màn RPT-05 "Biểu mẫu báo cáo gửi Bộ Tài chính" mở được ở đường dẫn /rpt/rpt-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn RPT-04 "Nhật ký giao báo cáo cho bên nhận" mở được ở đường dẫn /rpt/rpt-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản docHead
- [ ] Khung vào phần rpt.mof.form đúng lúc giọng đọc nói tới
- [ ] Khung vào phần rpt.mof.delivery-log đúng lúc giọng đọc nói tới
- [ ] Chú thích "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng" hiện từ giây 3, kéo dài 7 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Con số pháp lý là cấu hình mặc định, chưa kiểm chứng"
- [ ] Biểu mẫu điền từ số liệu đã chốt
- [ ] Nhật ký giao có tệp và thời điểm
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Lựa chọn nhà thầu và phân tích hồ sơ dự thầu (`procurement-desk`)

### `bid-plan`

Nền tảng: web; 16.6 giây; chỉ trong chương cắt riêng

Màn hình: `BID-15` Kế hoạch lựa chọn nhà thầu (/bid/bid-15); `BID-16` Lập và điều chỉnh kế hoạch thầu (/bid/bid-16); `BID-17` Theo dõi mời thầu và mốc lựa chọn (/bid/bid-17); `BID-18` Phê duyệt kết quả lựa chọn (/bid/bid-18); `BID-19` Liên kết cổng đấu thầu và đối soát (/bid/bid-19)

**Lời đọc**

> Kế hoạch lựa chọn nhà thầu được lập và điều chỉnh có lý do. Mỗi mốc mời thầu được theo dõi, và kết quả lựa chọn được phê duyệt trước khi sang hợp đồng. Liên kết với cổng đấu thầu quốc gia và đối soát nằm cùng một chỗ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kế hoạch lựa chọn nhà thầu được lập và điều chỉnh có lý do. Mỗi mốc mời thầu được theo dõi, và kết quả lựa chọn được phê duyệt trước khi sang hợp đồng. Liên kết với cổng đấu thầu quốc gia và đối soát nằm cùng một chỗ.

**Phụ đề**

- Kế hoạch lựa chọn nhà thầu được / lập và điều chỉnh có lý do.
- Mỗi mốc mời thầu được / theo dõi, và kết quả lựa
- chọn được phê duyệt / trước khi sang hợp đồng.
- Liên kết với cổng đấu thầu quốc / gia và đối soát nằm cùng một chỗ.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-15`
- `do=spot ref=bid.plan.selection-plan`
- `do=open screen=BID-16`
- `do=spot ref=bid.plan.adjust`
- `do=open screen=BID-17`
- `do=spot ref=bid.plan.milestones`
- `do=open screen=BID-18`
- `do=spot ref=bid.plan.result-approval`
- `do=open screen=BID-19`

**Cần thấy trên hình**

- [ ] Màn BID-15 "Kế hoạch lựa chọn nhà thầu" mở được ở đường dẫn /bid/bid-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-16 "Lập và điều chỉnh kế hoạch thầu" mở được ở đường dẫn /bid/bid-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-17 "Theo dõi mời thầu và mốc lựa chọn" mở được ở đường dẫn /bid/bid-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-18 "Phê duyệt kết quả lựa chọn" mở được ở đường dẫn /bid/bid-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-19 "Liên kết cổng đấu thầu và đối soát" mở được ở đường dẫn /bid/bid-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.plan.selection-plan đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.plan.adjust đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.plan.milestones đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.plan.result-approval đúng lúc giọng đọc nói tới
- [ ] Kế hoạch có lịch sử điều chỉnh
- [ ] Mốc mời thầu có ngày dự kiến và thực tế
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `bid-package`

Nền tảng: web; 11.5 giây; chỉ trong chương cắt riêng

Màn hình: `BID-03` Gói thầu và đề án (/bid/bid-03); `BID-04` Tiêu chí đánh giá (/bid/bid-04); `BID-05` Tiếp nhận hồ sơ (/bid/bid-05)

**Lời đọc**

> Mỗi gói thầu có đề án và bộ tiêu chí đánh giá, khai trước khi mở hồ sơ. Hồ sơ dự thầu được tiếp nhận, ghi lại thời điểm nộp và người nhận.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi gói thầu có đề án và bộ tiêu chí đánh giá, khai trước khi mở hồ sơ. Hồ sơ dự thầu được tiếp nhận, ghi lại thời điểm nộp và người nhận.

**Phụ đề**

- Mỗi gói thầu có đề án và bộ tiêu chí / đánh giá, khai trước khi mở hồ sơ.
- Hồ sơ dự thầu được tiếp nhận, ghi / lại thời điểm nộp và người nhận.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-03`
- `do=spot ref=bid.package.setup`
- `do=open screen=BID-04`
- `do=spot ref=bid.package.criteria`
- `do=open screen=BID-05`
- `do=spot ref=bid.package.intake`

**Cần thấy trên hình**

- [ ] Màn BID-03 "Gói thầu và đề án" mở được ở đường dẫn /bid/bid-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-04 "Tiêu chí đánh giá" mở được ở đường dẫn /bid/bid-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-05 "Tiếp nhận hồ sơ" mở được ở đường dẫn /bid/bid-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.package.setup đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.package.criteria đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.package.intake đúng lúc giọng đọc nói tới
- [ ] Bộ tiêu chí có trọng số
- [ ] Danh sách hồ sơ nhận kèm thời điểm
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `bid-ocr`

Nền tảng: web; 14.2 giây; chỉ trong chương cắt riêng

Màn hình: `BID-06` Kiểm tra OCR (/bid/bid-06); `BID-07` Cấu hình lượt phân tích (/bid/bid-07); `BID-08` Tiến trình phân tích (/bid/bid-08)

**Lời đọc**

> Hồ sơ dạng ảnh được đọc bằng OCR, người kiểm tra lại chỗ đọc chưa chắc. Lượt phân tích được cấu hình trước, và tiến trình chạy hiện từng bước. Chạy lại bao nhiêu lần cũng được lưu đủ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hồ sơ dạng ảnh được đọc bằng ô-xi-a, người kiểm tra lại chỗ đọc chưa chắc. Lượt phân tích được cấu hình trước, và tiến trình chạy hiện từng bước. Chạy lại bao nhiêu lần cũng được lưu đủ.

**Phụ đề**

- Hồ sơ dạng ảnh được đọc bằng OCR, / người kiểm tra lại chỗ đọc chưa chắc.
- Lượt phân tích được cấu hình trước, / và tiến trình chạy hiện từng bước.
- Chạy lại bao nhiêu lần cũng được lưu đủ.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-06`
- `do=spot ref=bid.analysis.ocr-check`
- `do=open screen=BID-07`
- `do=spot ref=bid.analysis.run-config`
- `do=open screen=BID-08`
- `do=spot ref=bid.analysis.progress`

**Cần thấy trên hình**

- [ ] Màn BID-06 "Kiểm tra OCR" mở được ở đường dẫn /bid/bid-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-07 "Cấu hình lượt phân tích" mở được ở đường dẫn /bid/bid-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-08 "Tiến trình phân tích" mở được ở đường dẫn /bid/bid-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.analysis.ocr-check đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.analysis.run-config đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.analysis.progress đúng lúc giọng đọc nói tới
- [ ] Màn kiểm tra OCR có chỗ chưa chắc tô màu
- [ ] Tiến trình phân tích theo bước
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `bid-evidence-bench`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `BID-09` Bàn phân tích có dẫn chứng (/bid/bid-09); `BID-10` So sánh đề án (/bid/bid-10)

**Lời đọc**

> Bàn phân tích có dẫn chứng: mỗi nhận định chỉ ra đoạn gốc trong hồ sơ. So sánh các đề án đặt cạnh nhau theo tiêu chí. AI chỉ gợi ý, người chấm quyết định và ghi lý do.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bàn phân tích có dẫn chứng: mỗi nhận định chỉ ra đoạn gốc trong hồ sơ. So sánh các đề án đặt cạnh nhau theo tiêu chí. ây-ai chỉ gợi ý, người chấm quyết định và ghi lý do.

**Phụ đề**

- Bàn phân tích có dẫn chứng: mỗi nhận / định chỉ ra đoạn gốc trong hồ sơ.
- So sánh các đề án đặt / cạnh nhau theo tiêu chí.
- AI chỉ gợi ý, người chấm / quyết định và ghi lý do.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-09`
- `do=spot ref=bid.analysis.evidence-bench`
- `do=open screen=BID-10`
- `do=spot ref=bid.analysis.compare-bids`

**Cần thấy trên hình**

- [ ] Màn BID-09 "Bàn phân tích có dẫn chứng" mở được ở đường dẫn /bid/bid-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-10 "So sánh đề án" mở được ở đường dẫn /bid/bid-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.analysis.evidence-bench đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.analysis.compare-bids đúng lúc giọng đọc nói tới
- [ ] Chú thích "AI gợi ý, người chấm quyết định" hiện từ giây 4, kéo dài 5 giây
- [ ] Mỗi nhận định có dẫn chứng bấm được
- [ ] Bảng so sánh các đề án theo tiêu chí
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `bid-evaluation`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `BID-11` Làm rõ hồ sơ (/bid/bid-11); `BID-12` Thẩm tra chuyên gia (/bid/bid-12); `BID-13` Biên bản đánh giá (/bid/bid-13); `BID-14` Hợp đồng và thay đổi (/bid/bid-14)

**Lời đọc**

> Làm rõ hồ sơ đi theo câu hỏi và trả lời có hạn. Chuyên gia thẩm tra độc lập, rồi biên bản đánh giá được lập. Kết quả đi tiếp sang hợp đồng và các thay đổi của hợp đồng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Làm rõ hồ sơ đi theo câu hỏi và trả lời có hạn. Chuyên gia thẩm tra độc lập, rồi biên bản đánh giá được lập. Kết quả đi tiếp sang hợp đồng và các thay đổi của hợp đồng.

**Phụ đề**

- Làm rõ hồ sơ đi theo câu / hỏi và trả lời có hạn.
- Chuyên gia thẩm tra độc lập, / rồi biên bản đánh giá được lập.
- Kết quả đi tiếp sang hợp đồng / và các thay đổi của hợp đồng.

**Các bước quay**

- `do=as persona=bidManager`
- `do=open screen=BID-11`
- `do=spot ref=bid.evaluation.clarification`
- `do=open screen=BID-12`
- `do=spot ref=bid.evaluation.expert-review`
- `do=open screen=BID-13`
- `do=spot ref=bid.evaluation.minutes`
- `do=open screen=BID-14`
- `do=spot ref=bid.evaluation.contract-handover`

**Cần thấy trên hình**

- [ ] Màn BID-11 "Làm rõ hồ sơ" mở được ở đường dẫn /bid/bid-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-12 "Thẩm tra chuyên gia" mở được ở đường dẫn /bid/bid-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-13 "Biên bản đánh giá" mở được ở đường dẫn /bid/bid-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-14 "Hợp đồng và thay đổi" mở được ở đường dẫn /bid/bid-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
- [ ] Khung vào phần bid.evaluation.clarification đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.evaluation.expert-review đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.evaluation.minutes đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bid.evaluation.contract-handover đúng lúc giọng đọc nói tới
- [ ] Câu hỏi làm rõ có hạn trả lời
- [ ] Biên bản đánh giá có chữ ký các thành viên
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Thực hiện hợp đồng và nghiệm thu (`contract-delivery`)

### `ctr-draft`

Nền tảng: web; 14 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-02` Soạn và ký kết hợp đồng (/ctr/ctr-02); `CTR-04` BOQ và mốc thanh toán (/ctr/ctr-04); `CTR-06` Tạm ứng và lịch thu hồi (/ctr/ctr-06); `CTR-26` Phiên bản hợp đồng và hiệu lực (/ctr/ctr-26)

**Lời đọc**

> Hợp đồng được soạn và ký theo từng bước. Bảng khối lượng gắn với các mốc thanh toán. Tạm ứng có lịch thu hồi. Mỗi lần điều chỉnh là một phiên bản có hiệu lực từ ngày rõ ràng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hợp đồng được soạn và ký theo từng bước. Bảng khối lượng gắn với các mốc thanh toán. Tạm ứng có lịch thu hồi. Mỗi lần điều chỉnh là một phiên bản có hiệu lực từ ngày rõ ràng.

**Phụ đề**

- Hợp đồng được soạn và ký theo từng bước.
- Bảng khối lượng gắn / với các mốc thanh toán.
- Tạm ứng có lịch thu hồi.
- Mỗi lần điều chỉnh là một phiên / bản có hiệu lực từ ngày rõ ràng.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-02`
- `do=spot ref=ctr.contract.drafting-signing`
- `do=open screen=CTR-04`
- `do=spot ref=ctr.contract.boq-milestones`
- `do=open screen=CTR-06`
- `do=spot ref=ctr.contract.advance-schedule`
- `do=open screen=CTR-26`
- `do=spot ref=ctr.contract.versions`

**Cần thấy trên hình**

- [ ] Màn CTR-02 "Soạn và ký kết hợp đồng" mở được ở đường dẫn /ctr/ctr-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-04 "BOQ và mốc thanh toán" mở được ở đường dẫn /ctr/ctr-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-06 "Tạm ứng và lịch thu hồi" mở được ở đường dẫn /ctr/ctr-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-26 "Phiên bản hợp đồng và hiệu lực" mở được ở đường dẫn /ctr/ctr-26, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.contract.drafting-signing đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.contract.boq-milestones đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.contract.advance-schedule đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.contract.versions đúng lúc giọng đọc nói tới
- [ ] Bảng khối lượng và mốc thanh toán
- [ ] Danh sách phiên bản hợp đồng có ngày hiệu lực
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ctr-change`

Nền tảng: web; 14.8 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-07` Yêu cầu thay đổi và phát sinh (/ctr/ctr-07); `CTR-08` So sánh và duyệt phụ lục (/ctr/ctr-08); `CTR-20` Cấu hình số tầng thay đổi của dự án (/ctr/ctr-20); `CTR-22` Tạm dừng, tiếp tục và chấm dứt hợp đồng (/ctr/ctr-22)

**Lời đọc**

> Yêu cầu thay đổi và phát sinh đi qua so sánh phụ lục trước khi duyệt. Số tầng thay đổi cấu hình theo từng dự án. Tạm dừng, tiếp tục và chấm dứt hợp đồng đều có lý do và người quyết định.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Yêu cầu thay đổi và phát sinh đi qua so sánh phụ lục trước khi duyệt. Số tầng thay đổi cấu hình theo từng dự án. Tạm dừng, tiếp tục và chấm dứt hợp đồng đều có lý do và người quyết định.

**Phụ đề**

- Yêu cầu thay đổi và phát sinh đi / qua so sánh phụ lục trước khi duyệt.
- Số tầng thay đổi cấu hình theo từng dự án.
- Tạm dừng, tiếp tục và chấm dứt hợp / đồng đều có lý do và người quyết định.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-07`
- `do=spot ref=ctr.change.request`
- `do=open screen=CTR-08`
- `do=spot ref=ctr.change.addendum-compare`
- `do=open screen=CTR-20`
- `do=spot ref=ctr.change.tier-config`
- `do=open screen=CTR-22`
- `do=spot ref=ctr.change.suspend-terminate`

**Cần thấy trên hình**

- [ ] Màn CTR-07 "Yêu cầu thay đổi và phát sinh" mở được ở đường dẫn /ctr/ctr-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-08 "So sánh và duyệt phụ lục" mở được ở đường dẫn /ctr/ctr-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-20 "Cấu hình số tầng thay đổi của dự án" mở được ở đường dẫn /ctr/ctr-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-22 "Tạm dừng, tiếp tục và chấm dứt hợp đồng" mở được ở đường dẫn /ctr/ctr-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.change.request đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.change.addendum-compare đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.change.tier-config đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.change.suspend-terminate đúng lúc giọng đọc nói tới
- [ ] So sánh phụ lục hai cột
- [ ] Quyết định tạm dừng có lý do
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ctr-site`

Nền tảng: web; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-09` Nhật ký công trường (/ctr/ctr-09); `CTR-10` Ghi nhận khối lượng thực hiện (/ctr/ctr-10); `CTR-11` Kiểm tra chất lượng và NCR (/ctr/ctr-11); `CTR-12` Nghiệm thu khối lượng (/ctr/ctr-12); `CTR-13` Bảng xác định giá trị thanh toán (/ctr/ctr-13)

**Lời đọc**

> Khối lượng thực hiện được ghi từ nhật ký công trường, kiểm tra chất lượng, rồi nghiệm thu. Bảng xác định giá trị thanh toán lấy đúng khối lượng đã nghiệm thu, nên không thanh toán vượt phần đã làm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Khối lượng thực hiện được ghi từ nhật ký công trường, kiểm tra chất lượng, rồi nghiệm thu. Bảng xác định giá trị thanh toán lấy đúng khối lượng đã nghiệm thu, nên không thanh toán vượt phần đã làm.

**Phụ đề**

- Khối lượng thực hiện được / ghi từ nhật ký công trường,
- kiểm tra chất lượng, rồi nghiệm thu.
- Bảng xác định giá trị thanh / toán lấy đúng khối lượng
- đã nghiệm thu, nên không / thanh toán vượt phần đã làm.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-09`
- `do=spot ref=ctr.site.diary`
- `do=open screen=CTR-10`
- `do=spot ref=ctr.site.quantities`
- `do=open screen=CTR-11`
- `do=spot ref=ctr.site.quality-ncr`
- `do=open screen=CTR-12`
- `do=spot ref=ctr.site.acceptance`
- `do=open screen=CTR-13`
- `do=spot ref=ctr.site.payment-value`

**Cần thấy trên hình**

- [ ] Màn CTR-09 "Nhật ký công trường" mở được ở đường dẫn /ctr/ctr-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-10 "Ghi nhận khối lượng thực hiện" mở được ở đường dẫn /ctr/ctr-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-11 "Kiểm tra chất lượng và NCR" mở được ở đường dẫn /ctr/ctr-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-12 "Nghiệm thu khối lượng" mở được ở đường dẫn /ctr/ctr-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-13 "Bảng xác định giá trị thanh toán" mở được ở đường dẫn /ctr/ctr-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.site.diary đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.site.quantities đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.site.quality-ncr đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.site.acceptance đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.site.payment-value đúng lúc giọng đọc nói tới
- [ ] Khối lượng nghiệm thu khớp bảng giá trị thanh toán
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ctr-closeout`

Nền tảng: web; 14.8 giây; chỉ trong chương cắt riêng

Màn hình: `CTR-14` Chậm tiến độ và yêu cầu bồi hoàn (/ctr/ctr-14); `CTR-15` Hoàn thành và bàn giao (/ctr/ctr-15); `CTR-16` Bảo hành và khắc phục tồn tại (/ctr/ctr-16); `CTR-18` Hồ sơ tài sản và chuyển giao vận hành (/ctr/ctr-18); `CTR-24` Xuất hồ sơ nhà thầu cho cơ sở dữ liệu quốc gia (/ctr/ctr-24)

**Lời đọc**

> Chậm tiến độ có yêu cầu bồi hoàn. Hoàn thành thì bàn giao, rồi vào giai đoạn bảo hành và khắc phục tồn tại. Hồ sơ nhà thầu xuất được cho cơ sở dữ liệu quốc gia từ đúng dữ liệu đã có.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chậm tiến độ có yêu cầu bồi hoàn. Hoàn thành thì bàn giao, rồi vào giai đoạn bảo hành và khắc phục tồn tại. Hồ sơ nhà thầu xuất được cho cơ sở dữ liệu quốc gia từ đúng dữ liệu đã có.

**Phụ đề**

- Chậm tiến độ có yêu cầu bồi hoàn.
- Hoàn thành thì bàn giao, rồi vào giai / đoạn bảo hành và khắc phục tồn tại.
- Hồ sơ nhà thầu xuất được cho cơ sở dữ / liệu quốc gia từ đúng dữ liệu đã có.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-14`
- `do=spot ref=ctr.closeout.delay-compensation`
- `do=open screen=CTR-15`
- `do=spot ref=ctr.closeout.completion-handover`
- `do=open screen=CTR-16`
- `do=spot ref=ctr.closeout.warranty`
- `do=open screen=CTR-18`
- `do=open screen=CTR-24`
- `do=spot ref=ctr.closeout.contractor-export`

**Cần thấy trên hình**

- [ ] Màn CTR-14 "Chậm tiến độ và yêu cầu bồi hoàn" mở được ở đường dẫn /ctr/ctr-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-15 "Hoàn thành và bàn giao" mở được ở đường dẫn /ctr/ctr-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-16 "Bảo hành và khắc phục tồn tại" mở được ở đường dẫn /ctr/ctr-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-18 "Hồ sơ tài sản và chuyển giao vận hành" mở được ở đường dẫn /ctr/ctr-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-24 "Xuất hồ sơ nhà thầu cho cơ sở dữ liệu quốc gia" mở được ở đường dẫn /ctr/ctr-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.closeout.delay-compensation đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.closeout.completion-handover đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.closeout.warranty đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ctr.closeout.contractor-export đúng lúc giọng đọc nói tới
- [ ] Yêu cầu bồi hoàn có số ngày chậm
- [ ] Nút xuất hồ sơ nhà thầu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Hiện trường, chất lượng và giải phóng mặt bằng (`field-ops`)

### `iss-register`

Nền tảng: web; 13 giây; chỉ trong chương cắt riêng

Màn hình: `ISS-01` Danh sách vướng mắc (/iss/iss-01); `ISS-02` Ghi nhận vướng mắc (/iss/iss-02); `ISS-03` Không gian xử lý (/iss/iss-03)

**Lời đọc**

> Vướng mắc được ghi nhận từ web hoặc điện thoại, có loại, mức độ, hạn và người xử lý. Không gian xử lý gom trao đổi, tài liệu và nhiệm vụ của một vướng mắc vào một chỗ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Vướng mắc được ghi nhận từ quép hoặc điện thoại, có loại, mức độ, hạn và người xử lý. Không gian xử lý gom trao đổi, tài liệu và nhiệm vụ của một vướng mắc vào một chỗ.

**Phụ đề**

- Vướng mắc được ghi nhận / từ web hoặc điện thoại,
- có loại, mức độ, hạn và người xử lý.
- Không gian xử lý gom trao đổi, tài liệu / và nhiệm vụ của một vướng mắc vào một chỗ.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=ISS-01`
- `do=spot ref=iss.issues.list`
- `do=open screen=ISS-02`
- `do=spot ref=iss.issues.new`
- `do=open screen=ISS-03`
- `do=spot ref=iss.issues.workspace`

**Cần thấy trên hình**

- [ ] Màn ISS-01 "Danh sách vướng mắc" mở được ở đường dẫn /iss/iss-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ISS-02 "Ghi nhận vướng mắc" mở được ở đường dẫn /iss/iss-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ISS-03 "Không gian xử lý" mở được ở đường dẫn /iss/iss-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần iss.issues.list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần iss.issues.new đúng lúc giọng đọc nói tới
- [ ] Khung vào phần iss.issues.workspace đúng lúc giọng đọc nói tới
- [ ] Danh sách vướng mắc có mức độ và hạn
- [ ] Không gian xử lý có trao đổi và nhiệm vụ
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `iss-escalate`

Nền tảng: web; 16.3 giây; chỉ trong chương cắt riêng

Màn hình: `ISS-04` Chuyển cấp và gia hạn (/iss/iss-04); `ISS-09` Chính sách SLA theo loại và đơn vị (/iss/iss-09); `ISS-10` Leo thang và tổ công tác (/iss/iss-10); `ISS-11` Vướng mắc phát sinh từ GPMB, giấy phép, chất lượng (/iss/iss-11)

**Lời đọc**

> Chuyển cấp và gia hạn đều cần lý do. Chính sách thời hạn xử lý đặt theo loại vướng mắc và đơn vị. Leo thang lập tổ công tác, và vướng mắc phát sinh từ giải phóng mặt bằng, giấy phép hay chất lượng đi thẳng vào đây.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chuyển cấp và gia hạn đều cần lý do. Chính sách thời hạn xử lý đặt theo loại vướng mắc và đơn vị. Leo thang lập tổ công tác, và vướng mắc phát sinh từ giải phóng mặt bằng, giấy phép hay chất lượng đi thẳng vào đây.

**Phụ đề**

- Chuyển cấp và gia hạn đều cần lý do.
- Chính sách thời hạn xử lý đặt / theo loại vướng mắc và đơn vị.
- Leo thang lập tổ công tác, và / vướng mắc phát sinh từ giải
- phóng mặt bằng, giấy phép hay / chất lượng đi thẳng vào đây.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=ISS-04`
- `do=spot ref=iss.issues.escalate-extend`
- `do=open screen=ISS-09`
- `do=spot ref=iss.issues.sla-policy`
- `do=open screen=ISS-10`
- `do=spot ref=iss.issues.task-force`
- `do=open screen=ISS-11`
- `do=spot ref=iss.issues.origins`

**Cần thấy trên hình**

- [ ] Màn ISS-04 "Chuyển cấp và gia hạn" mở được ở đường dẫn /iss/iss-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ISS-09 "Chính sách SLA theo loại và đơn vị" mở được ở đường dẫn /iss/iss-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ISS-10 "Leo thang và tổ công tác" mở được ở đường dẫn /iss/iss-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ISS-11 "Vướng mắc phát sinh từ GPMB, giấy phép, chất lượng" mở được ở đường dẫn /iss/iss-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần iss.issues.escalate-extend đúng lúc giọng đọc nói tới
- [ ] Khung vào phần iss.issues.sla-policy đúng lúc giọng đọc nói tới
- [ ] Khung vào phần iss.issues.task-force đúng lúc giọng đọc nói tới
- [ ] Khung vào phần iss.issues.origins đúng lúc giọng đọc nói tới
- [ ] Chính sách thời hạn theo loại
- [ ] Tổ công tác gắn với vướng mắc leo thang
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `iss-weekly`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `ISS-05` Kiểm tra hiện trường (/iss/iss-05); `ISS-06` Tiến độ xử lý theo tuần (/iss/iss-06); `ISS-07` Xác nhận hoàn tất (/iss/iss-07); `ISS-08` Ma trận vướng mắc theo tuần (/iss/iss-08)

**Lời đọc**

> Kiểm tra hiện trường ghi kết quả ngay tại chỗ. Tiến độ xử lý theo tuần và ma trận vướng mắc theo tuần cho lãnh đạo thấy việc nào kéo dài. Một vướng mắc chỉ đóng sau khi xác nhận hoàn tất.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kiểm tra hiện trường ghi kết quả ngay tại chỗ. Tiến độ xử lý theo tuần và ma trận vướng mắc theo tuần cho lãnh đạo thấy việc nào kéo dài. Một vướng mắc chỉ đóng sau khi xác nhận hoàn tất.

**Phụ đề**

- Kiểm tra hiện trường ghi / kết quả ngay tại chỗ.
- Tiến độ xử lý theo tuần / và ma trận vướng mắc
- theo tuần cho lãnh đạo / thấy việc nào kéo dài.
- Một vướng mắc chỉ đóng / sau khi xác nhận hoàn tất.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=ISS-05`
- `do=spot ref=iss.issues.site-check`
- `do=open screen=ISS-06`
- `do=spot ref=iss.issues.weekly-progress`
- `do=open screen=ISS-07`
- `do=open screen=ISS-08`
- `do=spot ref=iss.issues.weekly-matrix`

**Cần thấy trên hình**

- [ ] Màn ISS-05 "Kiểm tra hiện trường" mở được ở đường dẫn /iss/iss-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ISS-06 "Tiến độ xử lý theo tuần" mở được ở đường dẫn /iss/iss-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ISS-07 "Xác nhận hoàn tất" mở được ở đường dẫn /iss/iss-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ISS-08 "Ma trận vướng mắc theo tuần" mở được ở đường dẫn /iss/iss-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần iss.issues.site-check đúng lúc giọng đọc nói tới
- [ ] Khung vào phần iss.issues.weekly-progress đúng lúc giọng đọc nói tới
- [ ] Khung vào phần iss.issues.weekly-matrix đúng lúc giọng đọc nói tới
- [ ] Ma trận vướng mắc theo tuần
- [ ] Bước xác nhận hoàn tất
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `qms-diary`

Nền tảng: web; 13 giây; chỉ trong chương cắt riêng

Màn hình: `QMS-01` Danh mục nhật ký thi công điện tử (/qms/qms-01); `QMS-02` Lập và ký nhật ký ngày (/qms/qms-02); `QMS-03` Ý kiến giám sát và xác nhận chủ đầu tư (/qms/qms-03); `QMS-11` Độ phủ nhật ký và cảnh báo thiếu nhật ký (/qms/qms-11)

**Lời đọc**

> Nhật ký thi công điện tử được lập và ký theo ngày. Giám sát ghi ý kiến, chủ đầu tư xác nhận. Màn độ phủ nhật ký cảnh báo những ngày làm việc còn thiếu nhật ký.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Nhật ký thi công điện tử được lập và ký theo ngày. Giám sát ghi ý kiến, chủ đầu tư xác nhận. Màn độ phủ nhật ký cảnh báo những ngày làm việc còn thiếu nhật ký.

**Phụ đề**

- Nhật ký thi công điện tử / được lập và ký theo ngày.
- Giám sát ghi ý kiến, chủ đầu tư xác nhận.
- Màn độ phủ nhật ký cảnh báo những / ngày làm việc còn thiếu nhật ký.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=QMS-01`
- `do=open screen=QMS-02`
- `do=spot ref=qms.diary.daily-sign`
- `do=open screen=QMS-03`
- `do=spot ref=qms.diary.supervisor-opinion`
- `do=open screen=QMS-11`
- `do=spot ref=qms.diary.coverage`

**Cần thấy trên hình**

- [ ] Màn QMS-01 "Danh mục nhật ký thi công điện tử" mở được ở đường dẫn /qms/qms-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn QMS-02 "Lập và ký nhật ký ngày" mở được ở đường dẫn /qms/qms-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn QMS-03 "Ý kiến giám sát và xác nhận chủ đầu tư" mở được ở đường dẫn /qms/qms-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn QMS-11 "Độ phủ nhật ký và cảnh báo thiếu nhật ký" mở được ở đường dẫn /qms/qms-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần qms.diary.daily-sign đúng lúc giọng đọc nói tới
- [ ] Khung vào phần qms.diary.supervisor-opinion đúng lúc giọng đọc nói tới
- [ ] Khung vào phần qms.diary.coverage đúng lúc giọng đọc nói tới
- [ ] Nhật ký có chữ ký của hai bên
- [ ] Ngày thiếu nhật ký tô màu cảnh báo
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `qms-quality`

Nền tảng: web; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `QMS-04` Đề nghị kiểm tra, nghiệm thu (/qms/qms-04); `QMS-05` Biên bản nghiệm thu chất lượng (/qms/qms-05); `QMS-06` Thí nghiệm vật liệu (/qms/qms-06); `QMS-07` Không phù hợp và hành động khắc phục (/qms/qms-07)

**Lời đọc**

> Đề nghị kiểm tra và nghiệm thu đi thành biên bản chất lượng. Kết quả thí nghiệm vật liệu gắn với hạng mục. Điểm không phù hợp có hành động khắc phục, người chịu trách nhiệm và hạn đóng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đề nghị kiểm tra và nghiệm thu đi thành biên bản chất lượng. Kết quả thí nghiệm vật liệu gắn với hạng mục. Điểm không phù hợp có hành động khắc phục, người chịu trách nhiệm và hạn đóng.

**Phụ đề**

- Đề nghị kiểm tra và nghiệm thu / đi thành biên bản chất lượng.
- Kết quả thí nghiệm vật / liệu gắn với hạng mục.
- Điểm không phù hợp có hành động khắc / phục, người chịu trách nhiệm và hạn đóng.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=QMS-04`
- `do=spot ref=qms.quality.inspection-request`
- `do=open screen=QMS-05`
- `do=open screen=QMS-06`
- `do=spot ref=qms.quality.material-tests`
- `do=open screen=QMS-07`
- `do=spot ref=qms.quality.nonconformity`

**Cần thấy trên hình**

- [ ] Màn QMS-04 "Đề nghị kiểm tra, nghiệm thu" mở được ở đường dẫn /qms/qms-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn QMS-05 "Biên bản nghiệm thu chất lượng" mở được ở đường dẫn /qms/qms-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn QMS-06 "Thí nghiệm vật liệu" mở được ở đường dẫn /qms/qms-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn QMS-07 "Không phù hợp và hành động khắc phục" mở được ở đường dẫn /qms/qms-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần qms.quality.inspection-request đúng lúc giọng đọc nói tới
- [ ] Khung vào phần qms.quality.material-tests đúng lúc giọng đọc nói tới
- [ ] Khung vào phần qms.quality.nonconformity đúng lúc giọng đọc nói tới
- [ ] Biên bản chất lượng có chữ ký
- [ ] Điểm không phù hợp có hạn đóng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `qms-photos`

Nền tảng: web; 11.1 giây; chỉ trong chương cắt riêng

Màn hình: `QMS-08` Kho ảnh hiện trường có định vị (/qms/qms-08); `QMS-12` Ảnh hiện trường cần giải trình giữa các dự án (/qms/qms-12)

**Lời đọc**

> Kho ảnh hiện trường lưu ảnh có định vị và thời điểm chụp. Hệ thống tìm ảnh giống nhau giữa các dự án và đưa ra danh sách ảnh cần giải trình.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kho ảnh hiện trường lưu ảnh có định vị và thời điểm chụp. Hệ thống tìm ảnh giống nhau giữa các dự án và đưa ra danh sách ảnh cần giải trình.

**Phụ đề**

- Kho ảnh hiện trường lưu ảnh / có định vị và thời điểm chụp.
- Hệ thống tìm ảnh giống nhau giữa các dự / án và đưa ra danh sách ảnh cần giải trình.

**Các bước quay**

- `do=as persona=auditor`
- `do=open screen=QMS-08`
- `do=spot ref=qms.photos.geotagged-store`
- `do=open screen=QMS-12`
- `do=spot ref=qms.photos.cross-project-check`

**Cần thấy trên hình**

- [ ] Màn QMS-08 "Kho ảnh hiện trường có định vị" mở được ở đường dẫn /qms/qms-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn QMS-12 "Ảnh hiện trường cần giải trình giữa các dự án" mở được ở đường dẫn /qms/qms-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản auditor
- [ ] Khung vào phần qms.photos.geotagged-store đúng lúc giọng đọc nói tới
- [ ] Khung vào phần qms.photos.cross-project-check đúng lúc giọng đọc nói tới
- [ ] Ảnh có tọa độ và thời điểm
- [ ] Danh sách ảnh cần giải trình cho thấy hai dự án có ảnh giống nhau
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `lnd-survey`

Nền tảng: web; 11.8 giây; chỉ trong chương cắt riêng

Màn hình: `LND-01` Tổng quan GPMB theo dự án (/lnd/lnd-01); `LND-02` Thửa đất và ranh giới (/lnd/lnd-02); `LND-03` Hộ bị ảnh hưởng (/lnd/lnd-03); `LND-04` Kiểm đếm (/lnd/lnd-04)

**Lời đọc**

> Giải phóng mặt bằng theo dõi từng dự án: thửa đất và ranh giới, hộ bị ảnh hưởng, kiểm đếm. Tổng quan cho biết bao nhiêu thửa đã kiểm đếm, bao nhiêu còn vướng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Giải phóng mặt bằng theo dõi từng dự án: thửa đất và ranh giới, hộ bị ảnh hưởng, kiểm đếm. Tổng quan cho biết bao nhiêu thửa đã kiểm đếm, bao nhiêu còn vướng.

**Phụ đề**

- Giải phóng mặt bằng theo dõi từng dự án:
- thửa đất và ranh giới, hộ / bị ảnh hưởng, kiểm đếm.
- Tổng quan cho biết bao nhiêu thửa / đã kiểm đếm, bao nhiêu còn vướng.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=LND-01`
- `do=spot ref=lnd.land.overview`
- `do=open screen=LND-02`
- `do=spot ref=lnd.land.parcels`
- `do=open screen=LND-03`
- `do=open screen=LND-04`
- `do=spot ref=lnd.land.inventory`

**Cần thấy trên hình**

- [ ] Màn LND-01 "Tổng quan GPMB theo dự án" mở được ở đường dẫn /lnd/lnd-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LND-02 "Thửa đất và ranh giới" mở được ở đường dẫn /lnd/lnd-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LND-03 "Hộ bị ảnh hưởng" mở được ở đường dẫn /lnd/lnd-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LND-04 "Kiểm đếm" mở được ở đường dẫn /lnd/lnd-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần lnd.land.overview đúng lúc giọng đọc nói tới
- [ ] Khung vào phần lnd.land.parcels đúng lúc giọng đọc nói tới
- [ ] Khung vào phần lnd.land.inventory đúng lúc giọng đọc nói tới
- [ ] Bản đồ hoặc danh sách thửa đất
- [ ] Tổng quan theo trạng thái thửa
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `lnd-compensation`

Nền tảng: web; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `LND-05` Phương án bồi thường, hỗ trợ, tái định cư (/lnd/lnd-05); `LND-06` Niêm yết 30 ngày và ý kiến (/lnd/lnd-06); `LND-07` Chi trả bồi thường (/lnd/lnd-07); `LND-08` Khiếu nại (/lnd/lnd-08); `LND-09` Cưỡng chế (/lnd/lnd-09)

**Lời đọc**

> Phương án bồi thường, hỗ trợ và tái định cư được niêm yết lấy ý kiến, rồi chi trả cho từng hộ. Khiếu nại được ghi và xử lý. Cưỡng chế chỉ là bước cuối, có hồ sơ đầy đủ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Phương án bồi thường, hỗ trợ và tái định cư được niêm yết lấy ý kiến, rồi chi trả cho từng hộ. Khiếu nại được ghi và xử lý. Cưỡng chế chỉ là bước cuối, có hồ sơ đầy đủ.

**Phụ đề**

- Phương án bồi thường, hỗ / trợ và tái định cư được
- niêm yết lấy ý kiến, / rồi chi trả cho từng hộ.
- Khiếu nại được ghi và xử lý.
- Cưỡng chế chỉ là bước / cuối, có hồ sơ đầy đủ.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=LND-05`
- `do=spot ref=lnd.land.compensation-plan`
- `do=open screen=LND-06`
- `do=spot ref=lnd.land.posting`
- `do=open screen=LND-07`
- `do=spot ref=lnd.land.payments`
- `do=open screen=LND-08`
- `do=spot ref=lnd.land.complaints`
- `do=open screen=LND-09`

**Cần thấy trên hình**

- [ ] Màn LND-05 "Phương án bồi thường, hỗ trợ, tái định cư" mở được ở đường dẫn /lnd/lnd-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LND-06 "Niêm yết 30 ngày và ý kiến" mở được ở đường dẫn /lnd/lnd-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LND-07 "Chi trả bồi thường" mở được ở đường dẫn /lnd/lnd-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LND-08 "Khiếu nại" mở được ở đường dẫn /lnd/lnd-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LND-09 "Cưỡng chế" mở được ở đường dẫn /lnd/lnd-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần lnd.land.compensation-plan đúng lúc giọng đọc nói tới
- [ ] Khung vào phần lnd.land.posting đúng lúc giọng đọc nói tới
- [ ] Khung vào phần lnd.land.payments đúng lúc giọng đọc nói tới
- [ ] Khung vào phần lnd.land.complaints đúng lúc giọng đọc nói tới
- [ ] Phương án có trạng thái niêm yết
- [ ] Khiếu nại có hạn xử lý
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `lnd-handover`

Nền tảng: web; 17 giây; chỉ trong chương cắt riêng

Màn hình: `LND-10` Bàn giao mặt bằng theo đoạn/km (/lnd/lnd-10); `LND-11` Theo dõi tiến độ khi Trung tâm quỹ đất thực hiện (/lnd/lnd-11); `LND-12` Tái định cư (/lnd/lnd-12); `LND-13` Yêu cầu của chủ thể dữ liệu (/lnd/lnd-13)

**Lời đọc**

> Mặt bằng được bàn giao theo từng đoạn hoặc từng ki lô mét cho nhà thầu. Khi Trung tâm quỹ đất thực hiện, tiến độ vẫn được theo dõi. Tái định cư và yêu cầu của chủ thể dữ liệu về thông tin cá nhân đều có chỗ xử lý.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mặt bằng được bàn giao theo từng đoạn hoặc từng ki lô mét cho nhà thầu. Khi Trung tâm quỹ đất thực hiện, tiến độ vẫn được theo dõi. Tái định cư và yêu cầu của chủ thể dữ liệu về thông tin cá nhân đều có chỗ xử lý.

**Phụ đề**

- Mặt bằng được bàn giao theo từng đoạn / hoặc từng ki lô mét cho nhà thầu.
- Khi Trung tâm quỹ đất thực / hiện, tiến độ vẫn được theo dõi.
- Tái định cư và yêu cầu của chủ thể dữ liệu / về thông tin cá nhân đều có chỗ xử lý.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=LND-10`
- `do=spot ref=lnd.land.segment-handover`
- `do=open screen=LND-11`
- `do=spot ref=lnd.land.land-fund-progress`
- `do=open screen=LND-12`
- `do=spot ref=lnd.land.resettlement`
- `do=open screen=LND-13`

**Cần thấy trên hình**

- [ ] Màn LND-10 "Bàn giao mặt bằng theo đoạn/km" mở được ở đường dẫn /lnd/lnd-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LND-11 "Theo dõi tiến độ khi Trung tâm quỹ đất thực hiện" mở được ở đường dẫn /lnd/lnd-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LND-12 "Tái định cư" mở được ở đường dẫn /lnd/lnd-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LND-13 "Yêu cầu của chủ thể dữ liệu" mở được ở đường dẫn /lnd/lnd-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần lnd.land.segment-handover đúng lúc giọng đọc nói tới
- [ ] Khung vào phần lnd.land.land-fund-progress đúng lúc giọng đọc nói tới
- [ ] Khung vào phần lnd.land.resettlement đúng lúc giọng đọc nói tới
- [ ] Bảng bàn giao mặt bằng theo đoạn
- [ ] Danh sách tái định cư
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pmt-permits`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `PMT-01` Hồ sơ pháp lý dự án (/pmt/pmt-01); `PMT-02` Chi tiết giấy phép và mốc xử lý (/pmt/pmt-02); `PMT-04` Quy tắc cổng chặn mốc (/pmt/pmt-04); `PMT-05` Cảnh báo hết hạn giấy phép (/pmt/pmt-05); `PMT-06` Miễn giấy phép và miễn trừ cổng (/pmt/pmt-06)

**Lời đọc**

> Hồ sơ pháp lý và giấy phép của dự án có hạn hiệu lực. Quy tắc cổng chặn một mốc khi còn thiếu giấy phép bắt buộc. Giấy phép sắp hết hạn tạo cảnh báo, và miễn trừ phải có lý do được duyệt.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hồ sơ pháp lý và giấy phép của dự án có hạn hiệu lực. Quy tắc cổng chặn một mốc khi còn thiếu giấy phép bắt buộc. Giấy phép sắp hết hạn tạo cảnh báo, và miễn trừ phải có lý do được duyệt.

**Phụ đề**

- Hồ sơ pháp lý và giấy phép / của dự án có hạn hiệu lực.
- Quy tắc cổng chặn một mốc khi / còn thiếu giấy phép bắt buộc.
- Giấy phép sắp hết hạn tạo cảnh báo, / và miễn trừ phải có lý do được duyệt.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=PMT-01`
- `do=spot ref=pmt.permits.legal-file`
- `do=open screen=PMT-02`
- `do=open screen=PMT-04`
- `do=spot ref=pmt.permits.gate-rules`
- `do=open screen=PMT-05`
- `do=spot ref=pmt.permits.expiry-alerts`
- `do=open screen=PMT-06`
- `do=spot ref=pmt.permits.waiver`

**Cần thấy trên hình**

- [ ] Màn PMT-01 "Hồ sơ pháp lý dự án" mở được ở đường dẫn /pmt/pmt-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PMT-02 "Chi tiết giấy phép và mốc xử lý" mở được ở đường dẫn /pmt/pmt-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PMT-04 "Quy tắc cổng chặn mốc" mở được ở đường dẫn /pmt/pmt-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PMT-05 "Cảnh báo hết hạn giấy phép" mở được ở đường dẫn /pmt/pmt-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PMT-06 "Miễn giấy phép và miễn trừ cổng" mở được ở đường dẫn /pmt/pmt-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần pmt.permits.legal-file đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pmt.permits.gate-rules đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pmt.permits.expiry-alerts đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pmt.permits.waiver đúng lúc giọng đọc nói tới
- [ ] Quy tắc cổng chặn mốc
- [ ] Miễn trừ có lý do và người duyệt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ast-handover`

Nền tảng: web; 16.3 giây; chỉ trong chương cắt riêng

Màn hình: `AST-01` Danh sách bàn giao (/ast/ast-01); `AST-02` Biên bản bàn giao và tồn tại (/ast/ast-02); `AST-03` Hồ sơ tài sản (/ast/ast-03); `AST-04` Bảo hành và giữ lại (/ast/ast-04); `AST-05` Yêu cầu bảo hành (/ast/ast-05); `AST-06` Liên kết vận hành bảo trì (/ast/ast-06)

**Lời đọc**

> Bàn giao tài sản có biên bản kèm danh sách tồn tại. Bảo hành và tiền giữ lại được theo dõi cho đến khi hết hạn, yêu cầu bảo hành có trạng thái xử lý. Hồ sơ tài sản nối sang đơn vị vận hành và bảo trì.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bàn giao tài sản có biên bản kèm danh sách tồn tại. Bảo hành và tiền giữ lại được theo dõi cho đến khi hết hạn, yêu cầu bảo hành có trạng thái xử lý. Hồ sơ tài sản nối sang đơn vị vận hành và bảo trì.

**Phụ đề**

- Bàn giao tài sản có biên / bản kèm danh sách tồn tại.
- Bảo hành và tiền giữ lại / được theo dõi cho đến khi
- hết hạn, yêu cầu bảo / hành có trạng thái xử lý.
- Hồ sơ tài sản nối sang đơn / vị vận hành và bảo trì.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=AST-01`
- `do=spot ref=ast.assets.handover-list`
- `do=open screen=AST-02`
- `do=spot ref=ast.assets.minutes-defects`
- `do=open screen=AST-03`
- `do=open screen=AST-04`
- `do=spot ref=ast.assets.warranty-retention`
- `do=open screen=AST-05`
- `do=spot ref=ast.assets.warranty-claims`
- `do=open screen=AST-06`

**Cần thấy trên hình**

- [ ] Màn AST-01 "Danh sách bàn giao" mở được ở đường dẫn /ast/ast-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AST-02 "Biên bản bàn giao và tồn tại" mở được ở đường dẫn /ast/ast-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AST-03 "Hồ sơ tài sản" mở được ở đường dẫn /ast/ast-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AST-04 "Bảo hành và giữ lại" mở được ở đường dẫn /ast/ast-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AST-05 "Yêu cầu bảo hành" mở được ở đường dẫn /ast/ast-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AST-06 "Liên kết vận hành bảo trì" mở được ở đường dẫn /ast/ast-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần ast.assets.handover-list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ast.assets.minutes-defects đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ast.assets.warranty-retention đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ast.assets.warranty-claims đúng lúc giọng đọc nói tới
- [ ] Biên bản bàn giao có danh sách tồn tại
- [ ] Yêu cầu bảo hành có trạng thái
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Hồ sơ và AI nâng cao (`docs-ai-plus`)

### `doc-viewer`

Nền tảng: web; 16 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-25` Hồ sơ và trình xem có dẫn nguồn (/doc/doc-25)

**Lời đọc**

> Màn xem hồ sơ có dẫn nguồn cho đọc văn bản, ghi chú vào đúng đoạn. Mỗi đoạn trích có mã cố định, nên người và trợ lý AI cùng trỏ được tới một chỗ. Tệp tải về qua đường dẫn ký sẵn sống năm phút.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Màn xem hồ sơ có dẫn nguồn cho đọc văn bản, ghi chú vào đúng đoạn. Mỗi đoạn trích có mã cố định, nên người và trợ lý ây-ai cùng trỏ được tới một chỗ. Tệp tải về qua đường dẫn ký sẵn sống năm phút.

**Phụ đề**

- Màn xem hồ sơ có dẫn nguồn cho đọc / văn bản, ghi chú vào đúng đoạn.
- Mỗi đoạn trích có mã cố định, nên người / và trợ lý AI cùng trỏ được tới một chỗ.
- Tệp tải về qua đường dẫn / ký sẵn sống năm phút.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DOC-25`
- `do=spot ref=doc.viewer.document`
- `do=spot ref=doc.viewer.citation-id`

**Cần thấy trên hình**

- [ ] Màn DOC-25 "Hồ sơ và trình xem có dẫn nguồn" mở được ở đường dẫn /doc/doc-25, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần doc.viewer.document đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.viewer.citation-id đúng lúc giọng đọc nói tới
- [ ] Văn bản hiện cùng cột ghi chú
- [ ] Mã trích dẫn cố định cạnh đoạn trích
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `doc-review-board`

Nền tảng: web; 15.4 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-26` Bảng luồng duyệt hồ sơ (/doc/doc-26)

**Lời đọc**

> Luồng duyệt hồ sơ chạy trên quy trình phê duyệt chung: các bước, người duyệt song song và trả lại để bổ sung. Bản đã duyệt bị khóa, thay đổi tiếp theo là một bản mới. Bình luận vẫn được thêm vào bản đã khóa.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Luồng duyệt hồ sơ chạy trên quy trình phê duyệt chung: các bước, người duyệt song song và trả lại để bổ sung. Bản đã duyệt bị khóa, thay đổi tiếp theo là một bản mới. Bình luận vẫn được thêm vào bản đã khóa.

**Phụ đề**

- Luồng duyệt hồ sơ chạy trên / quy trình phê duyệt chung:
- các bước, người duyệt song / song và trả lại để bổ sung.
- Bản đã duyệt bị khóa, thay / đổi tiếp theo là một bản mới.
- Bình luận vẫn được thêm vào bản đã khóa.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DOC-26`
- `do=spot ref=doc.review-board.stages`
- `do=spot ref=doc.review-board.return`

**Cần thấy trên hình**

- [ ] Màn DOC-26 "Bảng luồng duyệt hồ sơ" mở được ở đường dẫn /doc/doc-26, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần doc.review-board.stages đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.review-board.return đúng lúc giọng đọc nói tới
- [ ] Bảng có các bước và người duyệt song song
- [ ] Bản đã duyệt hiện biểu tượng khóa
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `doc-compare`

Nền tảng: web; 11.1 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-27` So sánh hai phiên bản hồ sơ (/doc/doc-27)

**Lời đọc**

> So sánh hai phiên bản hồ sơ cho thấy đoạn nào thêm, xóa hay sửa. Người duyệt biết bản mới khác bản cũ ở đâu mà không phải đọc lại từ đầu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> So sánh hai phiên bản hồ sơ cho thấy đoạn nào thêm, xóa hay sửa. Người duyệt biết bản mới khác bản cũ ở đâu mà không phải đọc lại từ đầu.

**Phụ đề**

- So sánh hai phiên bản hồ sơ cho / thấy đoạn nào thêm, xóa hay sửa.
- Người duyệt biết bản mới khác bản cũ / ở đâu mà không phải đọc lại từ đầu.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DOC-27`
- `do=spot ref=doc.compare.diff-view`
- `do=spot ref=doc.compare.versions`

**Cần thấy trên hình**

- [ ] Màn DOC-27 "So sánh hai phiên bản hồ sơ" mở được ở đường dẫn /doc/doc-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần doc.compare.diff-view đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.compare.versions đúng lúc giọng đọc nói tới
- [ ] Hai phiên bản cạnh nhau với đoạn khác biệt tô màu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `doc-transmittal`

Nền tảng: web; 13 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-28` Tài liệu dự án theo trạng thái và transmittal (/doc/doc-28); `DOC-29` Chi tiết transmittal tài liệu (/doc/doc-29)

**Lời đọc**

> Tài liệu dự án đi qua bốn trạng thái: đang soạn, đã chia sẻ, đã phát hành, lưu trữ. Phiếu chuyển giao tài liệu gửi cho từng người nhận kèm hạn xem xét, và biết ai đã xem.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Tài liệu dự án đi qua bốn trạng thái: đang soạn, đã chia sẻ, đã phát hành, lưu trữ. Phiếu chuyển giao tài liệu gửi cho từng người nhận kèm hạn xem xét, và biết ai đã xem.

**Phụ đề**

- Tài liệu dự án đi qua bốn trạng thái: đang / soạn, đã chia sẻ, đã phát hành, lưu trữ.
- Phiếu chuyển giao tài / liệu gửi cho từng người
- nhận kèm hạn xem xét, và biết ai đã xem.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DOC-28`
- `do=spot ref=doc.transmittal.state-board`
- `do=open screen=DOC-29`
- `do=spot ref=doc.transmittal.review-deadline`

**Cần thấy trên hình**

- [ ] Màn DOC-28 "Tài liệu dự án theo trạng thái và transmittal" mở được ở đường dẫn /doc/doc-28, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-29 "Chi tiết transmittal tài liệu" mở được ở đường dẫn /doc/doc-29, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần doc.transmittal.state-board đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.transmittal.review-deadline đúng lúc giọng đọc nói tới
- [ ] Bảng bốn trạng thái tài liệu
- [ ] Phiếu chuyển giao có hạn xem xét từng người nhận
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ai-grounded`

Nền tảng: web; 16.3 giây; chỉ trong chương cắt riêng

Màn hình: `LLM-22` Trợ lý AI: hỏi đáp, tóm tắt, dự thảo thuyết minh, khả thi (/llm/llm-22); `LLM-23` Chi tiết lượt hỏi của trợ lý AI và quyết định của người (/llm/llm-23)

**Lời đọc**

> Trợ lý AI gắn nhãn từng câu: nguồn, giả định hay suy luận. Trích dẫn ngoài quyền đọc của người hỏi bị loại bỏ, chỉ được đếm. Mỗi lượt hỏi là một bản ghi riêng không sửa được, và quyết định của người là dòng ghi riêng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trợ lý ây-ai gắn nhãn từng câu: nguồn, giả định hay suy luận. Trích dẫn ngoài quyền đọc của người hỏi bị loại bỏ, chỉ được đếm. Mỗi lượt hỏi là một bản ghi riêng không sửa được, và quyết định của người là dòng ghi riêng.

**Phụ đề**

- Trợ lý AI gắn nhãn từng câu: / nguồn, giả định hay suy luận.
- Trích dẫn ngoài quyền đọc của / người hỏi bị loại bỏ, chỉ được đếm.
- Mỗi lượt hỏi là một bản / ghi riêng không sửa được,
- và quyết định của người là dòng ghi riêng.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=LLM-22`
- `do=spot ref=llm.assistant.statements-labels`
- `do=open screen=LLM-23`
- `do=spot ref=llm.assistant.run-record`
- `do=spot ref=llm.assistant.human-decision`

**Cần thấy trên hình**

- [ ] Màn LLM-22 "Trợ lý AI: hỏi đáp, tóm tắt, dự thảo thuyết minh, khả thi" mở được ở đường dẫn /llm/llm-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-23 "Chi tiết lượt hỏi của trợ lý AI và quyết định của người" mở được ở đường dẫn /llm/llm-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần llm.assistant.statements-labels đúng lúc giọng đọc nói tới
- [ ] Khung vào phần llm.assistant.run-record đúng lúc giọng đọc nói tới
- [ ] Khung vào phần llm.assistant.human-decision đúng lúc giọng đọc nói tới
- [ ] Chú thích "AI đề xuất, người quyết định" hiện từ giây 4, kéo dài 5 giây
- [ ] Câu trả lời có nhãn nguồn, giả định, suy luận
- [ ] Bản ghi quyết định của người tách khỏi lượt hỏi
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ai-review-checklist`

Nền tảng: web; 17 giây; chỉ trong chương cắt riêng

Màn hình: `LLM-24` Rà soát hồ sơ trước khi trình (/llm/llm-24); `LLM-26` Danh mục rà soát và bộ tiêu chí đánh giá (/llm/llm-26)

**Lời đọc**

> Trước khi trình, hồ sơ được rà bằng danh mục kiểm: một phần là quy tắc chạy bằng mã, một phần là câu hỏi cho AI. Kết luận chỉ là lời khuyên, không chặn cũng không thay người duyệt. Bộ tiêu chí có trọng số do quản trị soạn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trước khi trình, hồ sơ được rà bằng danh mục kiểm: một phần là quy tắc chạy bằng mã, một phần là câu hỏi cho ây-ai. Kết luận chỉ là lời khuyên, không chặn cũng không thay người duyệt. Bộ tiêu chí có trọng số do quản trị soạn.

**Phụ đề**

- Trước khi trình, hồ sơ / được rà bằng danh mục kiểm:
- một phần là quy tắc chạy bằng / mã, một phần là câu hỏi cho AI.
- Kết luận chỉ là lời khuyên, không / chặn cũng không thay người duyệt.
- Bộ tiêu chí có trọng số do quản trị soạn.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=LLM-24`
- `do=spot ref=llm.review.dossier-verdict`
- `do=open screen=LLM-26`
- `do=spot ref=llm.review.checklists`

**Cần thấy trên hình**

- [ ] Màn LLM-24 "Rà soát hồ sơ trước khi trình" mở được ở đường dẫn /llm/llm-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-26 "Danh mục rà soát và bộ tiêu chí đánh giá" mở được ở đường dẫn /llm/llm-26, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần llm.review.dossier-verdict đúng lúc giọng đọc nói tới
- [ ] Khung vào phần llm.review.checklists đúng lúc giọng đọc nói tới
- [ ] Danh mục kiểm có mục quy tắc và mục AI
- [ ] Kết luận ghi rõ là lời khuyên
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ai-data-policy`

Nền tảng: web; 20.6 giây; chỉ trong chương cắt riêng

Màn hình: `LLM-19` Chính sách phân loại dữ liệu và định tuyến AI (/llm/llm-19); `LLM-20` Bản ghi quyết định của con người (/llm/llm-20); `LLM-21` Nhật ký định tuyến AI (/llm/llm-21); `LLM-27` Ngoại lệ nhà cung cấp ngoài và cam kết dữ liệu (/llm/llm-27)

**Lời đọc**

> Chính sách phân loại dữ liệu quyết định bản ghi nào được đi đâu: dữ liệu mật chỉ chạy trên máy chủ của đơn vị. Nhà cung cấp bên ngoài chỉ qua ngoại lệ do hai người duyệt, tối đa chín mươi ngày, mỗi lần dùng đều được ghi. Nhật ký định tuyến và bản ghi quyết định đều xem lại được.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chính sách phân loại dữ liệu quyết định bản ghi nào được đi đâu: dữ liệu mật chỉ chạy trên máy chủ của đơn vị. Nhà cung cấp bên ngoài chỉ qua ngoại lệ do hai người duyệt, tối đa chín mươi ngày, mỗi lần dùng đều được ghi. Nhật ký định tuyến và bản ghi quyết định đều xem lại được.

**Phụ đề**

- Chính sách phân loại dữ liệu quyết / định bản ghi nào được đi đâu:
- dữ liệu mật chỉ chạy / trên máy chủ của đơn vị.
- Nhà cung cấp bên ngoài chỉ qua / ngoại lệ do hai người duyệt,
- tối đa chín mươi ngày, / mỗi lần dùng đều được ghi.
- Nhật ký định tuyến và bản ghi / quyết định đều xem lại được.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=LLM-19`
- `do=spot ref=llm.policy.data-classes`
- `do=open screen=LLM-20`
- `do=open screen=LLM-21`
- `do=spot ref=llm.policy.routing-log`
- `do=open screen=LLM-27`
- `do=spot ref=llm.policy.exceptions`

**Cần thấy trên hình**

- [ ] Màn LLM-19 "Chính sách phân loại dữ liệu và định tuyến AI" mở được ở đường dẫn /llm/llm-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-20 "Bản ghi quyết định của con người" mở được ở đường dẫn /llm/llm-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-21 "Nhật ký định tuyến AI" mở được ở đường dẫn /llm/llm-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-27 "Ngoại lệ nhà cung cấp ngoài và cam kết dữ liệu" mở được ở đường dẫn /llm/llm-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần llm.policy.data-classes đúng lúc giọng đọc nói tới
- [ ] Khung vào phần llm.policy.routing-log đúng lúc giọng đọc nói tới
- [ ] Khung vào phần llm.policy.exceptions đúng lúc giọng đọc nói tới
- [ ] Ngoại lệ có hai người duyệt và ngày hết hạn
- [ ] Nhật ký định tuyến ghi từng lần gọi
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ai-admin`

Nền tảng: web; 17.8 giây; chỉ trong chương cắt riêng

Màn hình: `LLM-01` Tổng quan AI (/llm/llm-01); `LLM-05` Routing và fallback (/llm/llm-05); `LLM-07` Ngân sách và quota (/llm/llm-07); `LLM-15` Guardrail và dữ liệu (/llm/llm-15); `LLM-18` Sự cố và dừng khẩn cấp (/llm/llm-18)

**Lời đọc**

> Quản trị AI gồm nhà cung cấp, kho model, hồ sơ model theo tác vụ, định tuyến và dự phòng, khóa ảo, ngân sách và hạn mức. Có bộ dữ liệu đánh giá để so sánh model, rào chắn dữ liệu, và nút dừng khẩn cấp khi có sự cố.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Quản trị ây-ai gồm nhà cung cấp, kho mô-đen, hồ sơ mô-đen theo tác vụ, định tuyến và dự phòng, khóa ảo, ngân sách và hạn mức. Có bộ dữ liệu đánh giá để so sánh mô-đen, rào chắn dữ liệu, và nút dừng khẩn cấp khi có sự cố.

**Phụ đề**

- Quản trị AI gồm nhà cung cấp, kho / model, hồ sơ model theo tác vụ,
- định tuyến và dự phòng, khóa / ảo, ngân sách và hạn mức.
- Có bộ dữ liệu đánh giá để so sánh model,
- rào chắn dữ liệu, và nút / dừng khẩn cấp khi có sự cố.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=LLM-01`
- `do=spot ref=llm.admin.overview`
- `do=open screen=LLM-05`
- `do=spot ref=llm.admin.routing-fallback`
- `do=open screen=LLM-07`
- `do=spot ref=llm.admin.budget`
- `do=open screen=LLM-15`
- `do=spot ref=llm.admin.guardrails`
- `do=open screen=LLM-18`
- `do=spot ref=llm.admin.emergency-stop`

**Cần thấy trên hình**

- [ ] Màn LLM-01 "Tổng quan AI" mở được ở đường dẫn /llm/llm-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-05 "Routing và fallback" mở được ở đường dẫn /llm/llm-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-07 "Ngân sách và quota" mở được ở đường dẫn /llm/llm-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-15 "Guardrail và dữ liệu" mở được ở đường dẫn /llm/llm-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-18 "Sự cố và dừng khẩn cấp" mở được ở đường dẫn /llm/llm-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần llm.admin.overview đúng lúc giọng đọc nói tới
- [ ] Khung vào phần llm.admin.routing-fallback đúng lúc giọng đọc nói tới
- [ ] Khung vào phần llm.admin.budget đúng lúc giọng đọc nói tới
- [ ] Khung vào phần llm.admin.guardrails đúng lúc giọng đọc nói tới
- [ ] Khung vào phần llm.admin.emergency-stop đúng lúc giọng đọc nói tới
- [ ] Trang tổng quan AI có chi phí và lượt gọi
- [ ] Nút dừng khẩn cấp có xác nhận
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Văn thư và ký số (`correspondence`)

### `doc-draft`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-02` Soạn thảo văn bản đi (/doc/doc-02); `DOC-14` Thư viện mẫu văn bản (/doc/doc-14); `DOC-16` Thể thức và bố cục theo Phụ lục I NĐ 30/2020 (/doc/doc-16)

**Lời đọc**

> Văn bản đi được soạn từ thư viện mẫu, mỗi mẫu có phiên bản. Thể thức và bố cục theo quy định về công tác văn thư được kiểm tự động, nên văn bản sai thể thức bị báo trước khi trình ký.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Văn bản đi được soạn từ thư viện mẫu, mỗi mẫu có phiên bản. Thể thức và bố cục theo quy định về công tác văn thư được kiểm tự động, nên văn bản sai thể thức bị báo trước khi trình ký.

**Phụ đề**

- Văn bản đi được soạn từ thư / viện mẫu, mỗi mẫu có phiên bản.
- Thể thức và bố cục theo quy định về / công tác văn thư được kiểm tự động,
- nên văn bản sai thể thức / bị báo trước khi trình ký.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DOC-02`
- `do=spot ref=doc.outgoing.draft`
- `do=open screen=DOC-14`
- `do=spot ref=doc.templates.library`
- `do=open screen=DOC-16`
- `do=spot ref=doc.templates.layout-rules`

**Cần thấy trên hình**

- [ ] Màn DOC-02 "Soạn thảo văn bản đi" mở được ở đường dẫn /doc/doc-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-14 "Thư viện mẫu văn bản" mở được ở đường dẫn /doc/doc-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-16 "Thể thức và bố cục theo Phụ lục I NĐ 30/2020" mở được ở đường dẫn /doc/doc-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần doc.outgoing.draft đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.templates.library đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.templates.layout-rules đúng lúc giọng đọc nói tới
- [ ] Thư viện mẫu có phiên bản
- [ ] Báo lỗi thể thức hiện ngay trên bản soạn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `doc-sign`

Nền tảng: web; 14.8 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-04` Rà soát và trình ký (/doc/doc-04); `DOC-05` Ký số lãnh đạo (/doc/doc-05); `DOC-06` Cấp số và ký số cơ quan (/doc/doc-06); `DOC-07` Xác minh chữ ký và chứng thư (/doc/doc-07)

**Lời đọc**

> Văn bản đi qua rà soát, trình ký, ký số lãnh đạo, rồi cấp số và ký số cơ quan. Màn xác minh cho biết chữ ký và chứng thư còn hiệu lực hay không. Người soạn không tự ký thay lãnh đạo.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Văn bản đi qua rà soát, trình ký, ký số lãnh đạo, rồi cấp số và ký số cơ quan. Màn xác minh cho biết chữ ký và chứng thư còn hiệu lực hay không. Người soạn không tự ký thay lãnh đạo.

**Phụ đề**

- Văn bản đi qua rà soát, trình ký, ký số / lãnh đạo, rồi cấp số và ký số cơ quan.
- Màn xác minh cho biết chữ ký và / chứng thư còn hiệu lực hay không.
- Người soạn không tự ký thay lãnh đạo.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DOC-04`
- `do=spot ref=doc.signing.review`
- `do=open screen=DOC-05`
- `do=spot ref=doc.signing.leader-sign`
- `do=open screen=DOC-06`
- `do=spot ref=doc.signing.number-and-seal`
- `do=open screen=DOC-07`
- `do=spot ref=doc.signing.verify`

**Cần thấy trên hình**

- [ ] Màn DOC-04 "Rà soát và trình ký" mở được ở đường dẫn /doc/doc-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-05 "Ký số lãnh đạo" mở được ở đường dẫn /doc/doc-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-06 "Cấp số và ký số cơ quan" mở được ở đường dẫn /doc/doc-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-07 "Xác minh chữ ký và chứng thư" mở được ở đường dẫn /doc/doc-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần doc.signing.review đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.signing.leader-sign đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.signing.number-and-seal đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.signing.verify đúng lúc giọng đọc nói tới
- [ ] Các bước rà soát, ký lãnh đạo, cấp số, ký cơ quan
- [ ] Màn xác minh chữ ký hiện kết quả hợp lệ
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `doc-issue`

Nền tảng: web; 17.3 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-08` Phát hành và phân phối (/doc/doc-08); `DOC-09` Tải lên văn bản đã ký bên ngoài (/doc/doc-09); `DOC-10` Sổ đăng ký văn bản đi (/doc/doc-10); `DOC-19` Thu hồi, thay thế và đính chính (/doc/doc-19); `DOC-20` Liên thông văn bản qua LGSP (/doc/doc-20)

**Lời đọc**

> Phát hành và phân phối văn bản, tải lên văn bản đã ký bên ngoài khi cần. Sổ đăng ký văn bản đi ghi số và ngày. Thu hồi, thay thế hay đính chính đều để lại vết, và văn bản liên thông được với hệ thống văn bản quốc gia.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Phát hành và phân phối văn bản, tải lên văn bản đã ký bên ngoài khi cần. Sổ đăng ký văn bản đi ghi số và ngày. Thu hồi, thay thế hay đính chính đều để lại vết, và văn bản liên thông được với hệ thống văn bản quốc gia.

**Phụ đề**

- Phát hành và phân phối văn bản, tải / lên văn bản đã ký bên ngoài khi cần.
- Sổ đăng ký văn bản đi ghi số và ngày.
- Thu hồi, thay thế hay / đính chính đều để lại vết,
- và văn bản liên thông được / với hệ thống văn bản quốc gia.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DOC-08`
- `do=spot ref=doc.issue.distribution`
- `do=open screen=DOC-09`
- `do=open screen=DOC-10`
- `do=spot ref=doc.issue.outgoing-register`
- `do=open screen=DOC-19`
- `do=spot ref=doc.issue.recall-correct`
- `do=open screen=DOC-20`
- `do=spot ref=doc.issue.interconnect`

**Cần thấy trên hình**

- [ ] Màn DOC-08 "Phát hành và phân phối" mở được ở đường dẫn /doc/doc-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-09 "Tải lên văn bản đã ký bên ngoài" mở được ở đường dẫn /doc/doc-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-10 "Sổ đăng ký văn bản đi" mở được ở đường dẫn /doc/doc-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-19 "Thu hồi, thay thế và đính chính" mở được ở đường dẫn /doc/doc-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-20 "Liên thông văn bản qua LGSP" mở được ở đường dẫn /doc/doc-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần doc.issue.distribution đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.issue.outgoing-register đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.issue.recall-correct đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.issue.interconnect đúng lúc giọng đọc nói tới
- [ ] Sổ đăng ký có số, ngày và nơi nhận
- [ ] Dòng thu hồi hoặc đính chính có lý do
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `doc-incoming`

Nền tảng: web; 13.3 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-11` Tiếp nhận văn bản đến (/doc/doc-11); `DOC-12` Sổ văn bản đến và phân công (/doc/doc-12); `DOC-13` Xử lý văn bản đến (/doc/doc-13)

**Lời đọc**

> Văn bản đến được tiếp nhận, vào sổ, phân công người xử lý và theo dõi đến khi có kết quả. Việc chờ xử lý hiện trong danh sách việc của người nhận, và quá hạn thì cảnh báo.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Văn bản đến được tiếp nhận, vào sổ, phân công người xử lý và theo dõi đến khi có kết quả. Việc chờ xử lý hiện trong danh sách việc của người nhận, và quá hạn thì cảnh báo.

**Phụ đề**

- Văn bản đến được tiếp nhận, vào sổ,
- phân công người xử lý và / theo dõi đến khi có kết quả.
- Việc chờ xử lý hiện trong danh sách việc / của người nhận, và quá hạn thì cảnh báo.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DOC-11`
- `do=spot ref=doc.incoming.intake`
- `do=open screen=DOC-12`
- `do=spot ref=doc.incoming.register-assign`
- `do=open screen=DOC-13`
- `do=spot ref=doc.incoming.handling`

**Cần thấy trên hình**

- [ ] Màn DOC-11 "Tiếp nhận văn bản đến" mở được ở đường dẫn /doc/doc-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-12 "Sổ văn bản đến và phân công" mở được ở đường dẫn /doc/doc-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-13 "Xử lý văn bản đến" mở được ở đường dẫn /doc/doc-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần doc.incoming.intake đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.incoming.register-assign đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.incoming.handling đúng lúc giọng đọc nói tới
- [ ] Sổ văn bản đến có người được phân công
- [ ] Hạn xử lý hiện trên từng dòng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `doc-archive`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-01` Tổng quan văn bản (/doc/doc-01); `DOC-17` Hồ sơ và lưu trữ (/doc/doc-17); `DOC-18` Quy tắc bảo quản tài liệu (/doc/doc-18); `DOC-21` Cấu hình sổ cấp số và loại văn bản (/doc/doc-21)

**Lời đọc**

> Hồ sơ được lập và lưu trữ theo quy tắc bảo quản, mỗi loại tài liệu có thời hạn giữ riêng. Sổ cấp số và loại văn bản cấu hình được. Màn tổng quan cho biết khối lượng văn bản và việc đang tồn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hồ sơ được lập và lưu trữ theo quy tắc bảo quản, mỗi loại tài liệu có thời hạn giữ riêng. Sổ cấp số và loại văn bản cấu hình được. Màn tổng quan cho biết khối lượng văn bản và việc đang tồn.

**Phụ đề**

- Hồ sơ được lập và lưu trữ / theo quy tắc bảo quản,
- mỗi loại tài liệu có thời hạn giữ riêng.
- Sổ cấp số và loại văn bản cấu hình được.
- Màn tổng quan cho biết khối / lượng văn bản và việc đang tồn.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DOC-01`
- `do=spot ref=doc.archive.overview`
- `do=open screen=DOC-17`
- `do=spot ref=doc.archive.files`
- `do=open screen=DOC-18`
- `do=spot ref=doc.archive.retention-rules`
- `do=open screen=DOC-21`
- `do=spot ref=doc.archive.numbering-books`

**Cần thấy trên hình**

- [ ] Màn DOC-01 "Tổng quan văn bản" mở được ở đường dẫn /doc/doc-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-17 "Hồ sơ và lưu trữ" mở được ở đường dẫn /doc/doc-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-18 "Quy tắc bảo quản tài liệu" mở được ở đường dẫn /doc/doc-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-21 "Cấu hình sổ cấp số và loại văn bản" mở được ở đường dẫn /doc/doc-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần doc.archive.overview đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.archive.files đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.archive.retention-rules đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.archive.numbering-books đúng lúc giọng đọc nói tới
- [ ] Quy tắc bảo quản có thời hạn giữ theo loại
- [ ] Tổng quan văn bản có số việc tồn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Tích hợp: Hub, API mở và dữ liệu (`integration`)

### `hub-catalogue`

Nền tảng: web; 17.9 giây; chỉ trong chương cắt riêng

Màn hình: `HUB-01` Danh mục bộ kết nối và sức khỏe tích hợp (/hub/hub-01)

**Lời đọc**

> Trung tâm tích hợp quản mọi bộ kết nối trong một danh mục. Có {{figure:hub-total}} bộ kết nối, {{figure:hub-healthy-pct}} đang khỏe. Trạng thái gồm khỏe, cũ, lỗi, tắt, chờ bên ngoài và chưa từng chạy. Bộ nào chưa ai dùng không bị coi là ổn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trung tâm tích hợp quản mọi bộ kết nối trong một danh mục. Có {{figure:hub-total}} bộ kết nối, {{figure:hub-healthy-pct}} đang khỏe. Trạng thái gồm khỏe, cũ, lỗi, tắt, chờ bên ngoài và chưa từng chạy. Bộ nào chưa ai dùng không bị coi là ổn.

**Phụ đề**

- Trung tâm tích hợp quản mọi / bộ kết nối trong một danh mục.
- Có {n} bộ kết nối, {n} đang khỏe.
- Trạng thái gồm khỏe, cũ, lỗi, tắt, / chờ bên ngoài và chưa từng chạy.
- Bộ nào chưa ai dùng không bị coi là ổn.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=HUB-01`
- `do=spot ref=hub.catalogue.connector-list`
- `do=spot ref=hub.catalogue.health-summary`

**Cần thấy trên hình**

- [ ] Màn HUB-01 "Danh mục bộ kết nối và sức khỏe tích hợp" mở được ở đường dẫn /hub/hub-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần hub.catalogue.connector-list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần hub.catalogue.health-summary đúng lúc giọng đọc nói tới
- [ ] Chú thích "Chưa từng chạy ≠ khỏe" hiện từ giây 4, kéo dài 5 giây
- [ ] Con số hub-total đọc từ dữ liệu thật qua getHubHealthSummary (summary.total); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số hub-healthy-pct đọc từ dữ liệu thật qua getHubHealthSummary (summary.healthy_percent); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Danh mục có sáu trạng thái
- [ ] Bộ chưa từng chạy hiện nhãn riêng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `hub-detail`

Nền tảng: web; 18.2 giây; chỉ trong chương cắt riêng

Màn hình: `HUB-02` Chi tiết bộ kết nối (/hub/hub-02); `HUB-03` Nhật ký sự cố tích hợp (/hub/hub-03)

**Lời đọc**

> Chi tiết một bộ kết nối có bảy thẻ: giao thức, đường ống, ánh xạ, thông tin xác thực, ngoại lệ ra ngoài, tác nhân thu thập và xu hướng. Sự cố tự mở sổ nhật ký. Kết nối ra máy chủ ngoài chỉ chạy khi đã có ngoại lệ do đơn vị duyệt.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chi tiết một bộ kết nối có bảy thẻ: giao thức, đường ống, ánh xạ, thông tin xác thực, ngoại lệ ra ngoài, tác nhân thu thập và xu hướng. Sự cố tự mở sổ nhật ký. Kết nối ra máy chủ ngoài chỉ chạy khi đã có ngoại lệ do đơn vị duyệt.

**Phụ đề**

- Chi tiết một bộ kết nối có bảy / thẻ: giao thức, đường ống, ánh xạ,
- thông tin xác thực, ngoại lệ ra / ngoài, tác nhân thu thập và xu hướng.
- Sự cố tự mở sổ nhật ký.
- Kết nối ra máy chủ ngoài chỉ chạy / khi đã có ngoại lệ do đơn vị duyệt.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=HUB-02`
- `do=spot ref=hub.connector.tabs`
- `do=spot ref=hub.connector.freshness-rule`
- `do=open screen=HUB-03`
- `do=spot ref=hub.incidents.log`

**Cần thấy trên hình**

- [ ] Màn HUB-02 "Chi tiết bộ kết nối" mở được ở đường dẫn /hub/hub-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn HUB-03 "Nhật ký sự cố tích hợp" mở được ở đường dẫn /hub/hub-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần hub.connector.tabs đúng lúc giọng đọc nói tới
- [ ] Khung vào phần hub.connector.freshness-rule đúng lúc giọng đọc nói tới
- [ ] Khung vào phần hub.incidents.log đúng lúc giọng đọc nói tới
- [ ] Bảy thẻ của bộ kết nối
- [ ] Nhật ký sự cố có thời điểm mở và đóng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `int-machine-accounts`

Nền tảng: web; 15.8 giây; chỉ trong chương cắt riêng

Màn hình: `INT-01` Tài khoản máy (/int/int-01); `INT-02` Phạm vi và khóa (/int/int-02)

**Lời đọc**

> Hệ thống khác gọi API mở bằng tài khoản máy. Khóa bí mật chỉ hiện một lần, lưu dạng băm. Tạm khóa có hiệu lực ngay ở lần gọi kế tiếp. Phạm vi xác định đúng dữ liệu được đọc, không rộng hơn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hệ thống khác gọi ây-pi-ai mở bằng tài khoản máy. Khóa bí mật chỉ hiện một lần, lưu dạng băm. Tạm khóa có hiệu lực ngay ở lần gọi kế tiếp. Phạm vi xác định đúng dữ liệu được đọc, không rộng hơn.

**Phụ đề**

- Hệ thống khác gọi API / mở bằng tài khoản máy.
- Khóa bí mật chỉ hiện / một lần, lưu dạng băm.
- Tạm khóa có hiệu lực / ngay ở lần gọi kế tiếp.
- Phạm vi xác định đúng dữ liệu / được đọc, không rộng hơn.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=INT-01`
- `do=spot ref=int.accounts.list`
- `do=open screen=INT-02`
- `do=spot ref=int.accounts.scopes-keys`

**Cần thấy trên hình**

- [ ] Màn INT-01 "Tài khoản máy" mở được ở đường dẫn /int/int-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn INT-02 "Phạm vi và khóa" mở được ở đường dẫn /int/int-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần int.accounts.list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần int.accounts.scopes-keys đúng lúc giọng đọc nói tới
- [ ] Khóa chỉ hiện một lần khi tạo
- [ ] Danh sách phạm vi theo tài khoản
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `int-bi-accounts`

Nền tảng: web; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `INT-04` Tài khoản BI và tập dữ liệu chứng nhận (/int/int-04); `BI-19` Chứng nhận chỉ tiêu và bộ dữ liệu (/bi/bi-19)

**Lời đọc**

> Tài khoản BI đọc các bộ dữ liệu đã chứng nhận qua đường riêng, mỗi đơn vị một đăng nhập, chỉ thấy ảnh chụp kỳ đã chốt. Power BI nối được vào mà không chạm tới bảng nguồn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Tài khoản bi-ai đọc các bộ dữ liệu đã chứng nhận qua đường riêng, mỗi đơn vị một đăng nhập, chỉ thấy ảnh chụp kỳ đã chốt. pao bi-ai nối được vào mà không chạm tới bảng nguồn.

**Phụ đề**

- Tài khoản BI đọc các bộ dữ liệu / đã chứng nhận qua đường riêng,
- mỗi đơn vị một đăng nhập, / chỉ thấy ảnh chụp kỳ đã chốt.
- Power BI nối được vào mà / không chạm tới bảng nguồn.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=INT-04`
- `do=spot ref=int.bi.accounts`
- `do=open screen=BI-19`
- `do=spot ref=bi.bi.certified-datasets`

**Cần thấy trên hình**

- [ ] Màn INT-04 "Tài khoản BI và tập dữ liệu chứng nhận" mở được ở đường dẫn /int/int-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-19 "Chứng nhận chỉ tiêu và bộ dữ liệu" mở được ở đường dẫn /bi/bi-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần int.bi.accounts đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.bi.certified-datasets đúng lúc giọng đọc nói tới
- [ ] Bộ dữ liệu có nhãn đã chứng nhận
- [ ] Đăng nhập BI gắn với một đơn vị
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `int-crosswalk`

Nền tảng: web; 16.9 giây; chỉ trong chương cắt riêng

Màn hình: `INT-03` Ánh xạ mã dự án đa hệ thống (/int/int-03); `MDM-35` Bản ghi chủ, crosswalk và tách/hợp nhất (/mdm/mdm-35)

**Lời đọc**

> Mã dự án ở các hệ thống khác nhau được ánh xạ qua bảng đối chiếu có hai người duyệt và thời hạn hiệu lực. Mã đã là mã của dự án khác bị từ chối, nên lịch sử đối chiếu không bao giờ đổi dự án một cách âm thầm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mã dự án ở các hệ thống khác nhau được ánh xạ qua bảng đối chiếu có hai người duyệt và thời hạn hiệu lực. Mã đã là mã của dự án khác bị từ chối, nên lịch sử đối chiếu không bao giờ đổi dự án một cách âm thầm.

**Phụ đề**

- Mã dự án ở các hệ thống khác / nhau được ánh xạ qua bảng
- đối chiếu có hai người / duyệt và thời hạn hiệu lực.
- Mã đã là mã của dự án khác / bị từ chối, nên lịch sử
- đối chiếu không bao giờ / đổi dự án một cách âm thầm.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=INT-03`
- `do=spot ref=int.crosswalk.project-codes`
- `do=open screen=MDM-35`
- `do=spot ref=mdm.crosswalk.records`

**Cần thấy trên hình**

- [ ] Màn INT-03 "Ánh xạ mã dự án đa hệ thống" mở được ở đường dẫn /int/int-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MDM-35 "Bản ghi chủ, crosswalk và tách/hợp nhất" mở được ở đường dẫn /mdm/mdm-35, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần int.crosswalk.project-codes đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mdm.crosswalk.records đúng lúc giọng đọc nói tới
- [ ] Đề xuất ánh xạ chờ người duyệt thứ hai
- [ ] Mã trùng với dự án khác bị từ chối
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `int-access-log`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `INT-05` Nhật ký truy cập API mở (/int/int-05)

**Lời đọc**

> Nhật ký truy cập API mở ghi từng lần gọi: tài khoản, phạm vi, kết quả và thời điểm. Giới hạn tần suất áp dụng cho từng tài khoản, nên một hệ thống gọi quá dày không làm chậm các hệ thống khác.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Nhật ký truy cập ây-pi-ai mở ghi từng lần gọi: tài khoản, phạm vi, kết quả và thời điểm. Giới hạn tần suất áp dụng cho từng tài khoản, nên một hệ thống gọi quá dày không làm chậm các hệ thống khác.

**Phụ đề**

- Nhật ký truy cập API mở ghi từng lần gọi: / tài khoản, phạm vi, kết quả và thời điểm.
- Giới hạn tần suất áp / dụng cho từng tài khoản,
- nên một hệ thống gọi quá dày / không làm chậm các hệ thống khác.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=INT-05`
- `do=spot ref=int.open-api.access-log`
- `do=spot ref=int.open-api.rate-limit`

**Cần thấy trên hình**

- [ ] Màn INT-05 "Nhật ký truy cập API mở" mở được ở đường dẫn /int/int-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần int.open-api.access-log đúng lúc giọng đọc nói tới
- [ ] Khung vào phần int.open-api.rate-limit đúng lúc giọng đọc nói tới
- [ ] Mỗi dòng nhật ký có tài khoản và kết quả
- [ ] Cột giới hạn tần suất
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `dgv-contracts`

Nền tảng: web; 15.8 giây; chỉ trong chương cắt riêng

Màn hình: `DGV-13` Data contract và schema (/dgv/dgv-13); `DGV-14` Pipeline và mapping (/dgv/dgv-14); `DGV-18` Data product và chứng nhận (/dgv/dgv-18); `DGV-19` Chấp thuận thay đổi hợp đồng dữ liệu (/dgv/dgv-19)

**Lời đọc**

> Hợp đồng dữ liệu mô tả lược đồ mà nguồn hứa giữ. Đường ống và ánh xạ nối nguồn với bảng đích. Thay đổi hợp đồng phải được chấp thuận. Sản phẩm dữ liệu chỉ được chứng nhận khi qua các kiểm tra chất lượng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hợp đồng dữ liệu mô tả lược đồ mà nguồn hứa giữ. Đường ống và ánh xạ nối nguồn với bảng đích. Thay đổi hợp đồng phải được chấp thuận. Sản phẩm dữ liệu chỉ được chứng nhận khi qua các kiểm tra chất lượng.

**Phụ đề**

- Hợp đồng dữ liệu mô tả / lược đồ mà nguồn hứa giữ.
- Đường ống và ánh xạ nối / nguồn với bảng đích.
- Thay đổi hợp đồng phải được chấp thuận.
- Sản phẩm dữ liệu chỉ được chứng nhận / khi qua các kiểm tra chất lượng.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DGV-13`
- `do=spot ref=dgv.data-contract.schema`
- `do=open screen=DGV-14`
- `do=spot ref=dgv.pipeline.mapping`
- `do=open screen=DGV-18`
- `do=spot ref=dgv.data-product.certification`
- `do=open screen=DGV-19`
- `do=spot ref=dgv.data-contract.change-approval`

**Cần thấy trên hình**

- [ ] Màn DGV-13 "Data contract và schema" mở được ở đường dẫn /dgv/dgv-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DGV-14 "Pipeline và mapping" mở được ở đường dẫn /dgv/dgv-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DGV-18 "Data product và chứng nhận" mở được ở đường dẫn /dgv/dgv-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DGV-19 "Chấp thuận thay đổi hợp đồng dữ liệu" mở được ở đường dẫn /dgv/dgv-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần dgv.data-contract.schema đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dgv.pipeline.mapping đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dgv.data-product.certification đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dgv.data-contract.change-approval đúng lúc giọng đọc nói tới
- [ ] Hợp đồng dữ liệu có phiên bản lược đồ
- [ ] Sản phẩm dữ liệu hiện nhãn chứng nhận
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `bi-registry-share`

Nền tảng: web; 16.3 giây; chỉ trong chương cắt riêng

Màn hình: `BI-15` Đăng ký chỉ tiêu từ mã nguồn (/bi/bi-15); `BI-16` Xuất dữ liệu và phạm vi (/bi/bi-16); `BI-17` Chia sẻ dashboard (/bi/bi-17)

**Lời đọc**

> Chỉ tiêu được đăng ký từ mã nguồn nên định nghĩa chỉ có một nơi. Xuất dữ liệu bị giới hạn theo phạm vi quyền của người xuất. Dashboard chia sẻ cho từng người hoặc nhóm, và người nhận chỉ thấy phần dữ liệu mình được xem.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chỉ tiêu được đăng ký từ mã nguồn nên định nghĩa chỉ có một nơi. Xuất dữ liệu bị giới hạn theo phạm vi quyền của người xuất. đát-bo chia sẻ cho từng người hoặc nhóm, và người nhận chỉ thấy phần dữ liệu mình được xem.

**Phụ đề**

- Chỉ tiêu được đăng ký từ mã nguồn / nên định nghĩa chỉ có một nơi.
- Xuất dữ liệu bị giới hạn theo / phạm vi quyền của người xuất.
- Dashboard chia sẻ cho / từng người hoặc nhóm,
- và người nhận chỉ thấy / phần dữ liệu mình được xem.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-15`
- `do=spot ref=bi.registry.from-code`
- `do=open screen=BI-16`
- `do=spot ref=bi.export.scope`
- `do=open screen=BI-17`
- `do=spot ref=bi.sharing.dashboard`

**Cần thấy trên hình**

- [ ] Màn BI-15 "Đăng ký chỉ tiêu từ mã nguồn" mở được ở đường dẫn /bi/bi-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-16 "Xuất dữ liệu và phạm vi" mở được ở đường dẫn /bi/bi-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-17 "Chia sẻ dashboard" mở được ở đường dẫn /bi/bi-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.registry.from-code đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.export.scope đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.sharing.dashboard đúng lúc giọng đọc nói tới
- [ ] Danh sách chỉ tiêu có mã nguồn
- [ ] Hộp chia sẻ dashboard theo người hoặc nhóm
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Cổng công khai và giám sát cộng đồng (`portal-public`)

### `portal-community`

Nền tảng: web; 20.9 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-31` Hồ sơ giám sát cộng đồng (/prj/prj-31); `PRJ-32` Chi tiết hồ sơ giám sát cộng đồng (/prj/prj-32)

**Lời đọc**

> Hồ sơ giám sát cộng đồng ghi ý kiến của người dân và ban giám sát cộng đồng về từng dự án. Có hạn thông báo, và mỗi phản ánh có phản hồi kèm thời hạn trả lời. Phản hồi của chính quyền được công khai cùng với phản ánh, nên người dân thấy việc của mình có được giải quyết hay không.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hồ sơ giám sát cộng đồng ghi ý kiến của người dân và ban giám sát cộng đồng về từng dự án. Có hạn thông báo, và mỗi phản ánh có phản hồi kèm thời hạn trả lời. Phản hồi của chính quyền được công khai cùng với phản ánh, nên người dân thấy việc của mình có được giải quyết hay không.

**Phụ đề**

- Hồ sơ giám sát cộng đồng / ghi ý kiến của người
- dân và ban giám sát / cộng đồng về từng dự án.
- Có hạn thông báo, và mỗi phản ánh / có phản hồi kèm thời hạn trả lời.
- Phản hồi của chính quyền được / công khai cùng với phản ánh,
- nên người dân thấy việc của mình / có được giải quyết hay không.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=PRJ-31`
- `do=spot ref=prj.community.files`
- `do=open screen=PRJ-32`
- `do=spot ref=prj.community.feedback-responses`

**Cần thấy trên hình**

- [ ] Màn PRJ-31 "Hồ sơ giám sát cộng đồng" mở được ở đường dẫn /prj/prj-31, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-32 "Chi tiết hồ sơ giám sát cộng đồng" mở được ở đường dẫn /prj/prj-32, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần prj.community.files đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.community.feedback-responses đúng lúc giọng đọc nói tới
- [ ] Hồ sơ có hạn thông báo
- [ ] Phản ánh có phản hồi và hạn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `portal-governance`

Nền tảng: web; 17 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-33` Quản trị cổng công khai (/prj/prj-33)

**Lời đọc**

> Quản trị cổng công khai chọn trường nào được phép công bố. Cổng không bao giờ đọc bảng nguồn. Người công bố ghi các bản ghi đã cắt theo danh sách trường cho phép. Danh sách ấy được áp dụng hai lần, khi công bố và khi trả ra.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Quản trị cổng công khai chọn trường nào được phép công bố. Cổng không bao giờ đọc bảng nguồn. Người công bố ghi các bản ghi đã cắt theo danh sách trường cho phép. Danh sách ấy được áp dụng hai lần, khi công bố và khi trả ra.

**Phụ đề**

- Quản trị cổng công khai chọn / trường nào được phép công bố.
- Cổng không bao giờ đọc bảng nguồn.
- Người công bố ghi các bản ghi đã / cắt theo danh sách trường cho phép.
- Danh sách ấy được áp dụng hai / lần, khi công bố và khi trả ra.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=PRJ-33`
- `do=spot ref=prj.portal.allow-list`
- `do=spot ref=prj.portal.publish`

**Cần thấy trên hình**

- [ ] Màn PRJ-33 "Quản trị cổng công khai" mở được ở đường dẫn /prj/prj-33, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần prj.portal.allow-list đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.portal.publish đúng lúc giọng đọc nói tới
- [ ] Chú thích "Chỉ trường được phép mới ra cổng" hiện từ giây 4, kéo dài 5 giây
- [ ] Danh sách trường cho phép
- [ ] Bản ghi đã công bố có thời điểm
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `portal-open-data`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-34` Cổng công khai đầu tư (/prj/prj-34)

**Lời đọc**

> Cổng công khai đầu tư cho người dân xem dự án, tiến độ và nhà thầu mà không cần đăng nhập. Phản hồi không mang mã người dùng hay đơn vị. Dữ liệu xuất theo chuẩn dữ liệu mở về hạ tầng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cổng công khai đầu tư cho người dân xem dự án, tiến độ và nhà thầu mà không cần đăng nhập. Phản hồi không mang mã người dùng hay đơn vị. Dữ liệu xuất theo chuẩn dữ liệu mở về hạ tầng.

**Phụ đề**

- Cổng công khai đầu tư / cho người dân xem dự án,
- tiến độ và nhà thầu mà / không cần đăng nhập.
- Phản hồi không mang mã / người dùng hay đơn vị.
- Dữ liệu xuất theo chuẩn / dữ liệu mở về hạ tầng.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=PRJ-34`
- `do=spot ref=prj.portal.public-projects`
- `do=spot ref=prj.portal.open-data-export`

**Cần thấy trên hình**

- [ ] Màn PRJ-34 "Cổng công khai đầu tư" mở được ở đường dẫn /prj/prj-34, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần prj.portal.public-projects đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.portal.open-data-export đúng lúc giọng đọc nói tới
- [ ] Cổng công khai mở không cần đăng nhập
- [ ] Nút xuất dữ liệu mở
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Nền tảng, dữ liệu chủ và quản trị (`platform`)

### `pl-access`

Nền tảng: web; 16.6 giây; chỉ trong chương cắt riêng

Màn hình: `IAM-04` Chọn tổ chức (/iam/iam-04); `IAM-05` Hồ sơ cá nhân (/iam/iam-05); `IAM-06` Phiên và thiết bị (/iam/iam-06); `IAM-07` Tìm kiếm toàn hệ thống (/iam/iam-07); `IAM-09` Phạm vi quyền hiệu lực của tôi (/iam/iam-09)

**Lời đọc**

> Người dùng chọn tổ chức khi thuộc nhiều đơn vị, quản hồ sơ, xem các phiên và thiết bị đang đăng nhập, và tìm kiếm trên toàn hệ thống. Màn phạm vi quyền hiệu lực cho biết chính xác mình được làm gì, theo vai trò, ủy quyền và kỳ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Người dùng chọn tổ chức khi thuộc nhiều đơn vị, quản hồ sơ, xem các phiên và thiết bị đang đăng nhập, và tìm kiếm trên toàn hệ thống. Màn phạm vi quyền hiệu lực cho biết chính xác mình được làm gì, theo vai trò, ủy quyền và kỳ.

**Phụ đề**

- Người dùng chọn tổ chức khi / thuộc nhiều đơn vị, quản hồ sơ,
- xem các phiên và thiết bị đang đăng / nhập, và tìm kiếm trên toàn hệ thống.
- Màn phạm vi quyền hiệu / lực cho biết chính xác
- mình được làm gì, theo / vai trò, ủy quyền và kỳ.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=IAM-04`
- `do=spot ref=iam.access.choose-organisation`
- `do=open screen=IAM-05`
- `do=open screen=IAM-06`
- `do=spot ref=iam.access.sessions-devices`
- `do=open screen=IAM-07`
- `do=spot ref=iam.access.global-search`
- `do=open screen=IAM-09`
- `do=spot ref=iam.access.effective-scope`

**Cần thấy trên hình**

- [ ] Màn IAM-04 "Chọn tổ chức" mở được ở đường dẫn /iam/iam-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn IAM-05 "Hồ sơ cá nhân" mở được ở đường dẫn /iam/iam-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn IAM-06 "Phiên và thiết bị" mở được ở đường dẫn /iam/iam-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn IAM-07 "Tìm kiếm toàn hệ thống" mở được ở đường dẫn /iam/iam-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn IAM-09 "Phạm vi quyền hiệu lực của tôi" mở được ở đường dẫn /iam/iam-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần iam.access.choose-organisation đúng lúc giọng đọc nói tới
- [ ] Khung vào phần iam.access.sessions-devices đúng lúc giọng đọc nói tới
- [ ] Khung vào phần iam.access.global-search đúng lúc giọng đọc nói tới
- [ ] Khung vào phần iam.access.effective-scope đúng lúc giọng đọc nói tới
- [ ] Danh sách phiên và thiết bị có nút đăng xuất
- [ ] Phạm vi quyền hiệu lực liệt kê vai trò và ủy quyền
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pl-organisation`

Nền tảng: web; 14.8 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-01` Cây tổ chức (/adm/adm-01); `ADM-02` Người dùng và mời thành viên (/adm/adm-02); `ADM-03` Vai trò và quyền (/adm/adm-03); `ADM-16` Sắp xếp lại đơn vị (/adm/adm-16); `ADM-17` Thành viên khách – nhà thầu (/adm/adm-17)

**Lời đọc**

> Quản trị dựng cây tổ chức, mời người dùng, gán vai trò và quyền theo phạm vi. Sắp xếp lại đơn vị giữ nguyên lịch sử. Thành viên khách như nhà thầu gắn với đúng một bên và chỉ thấy phần của mình.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Quản trị dựng cây tổ chức, mời người dùng, gán vai trò và quyền theo phạm vi. Sắp xếp lại đơn vị giữ nguyên lịch sử. Thành viên khách như nhà thầu gắn với đúng một bên và chỉ thấy phần của mình.

**Phụ đề**

- Quản trị dựng cây tổ chức, mời người / dùng, gán vai trò và quyền theo phạm vi.
- Sắp xếp lại đơn vị giữ nguyên lịch sử.
- Thành viên khách như nhà thầu gắn với / đúng một bên và chỉ thấy phần của mình.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=ADM-01`
- `do=spot ref=adm.org.tree`
- `do=open screen=ADM-02`
- `do=spot ref=adm.org.users-invite`
- `do=open screen=ADM-03`
- `do=spot ref=adm.org.roles-permissions`
- `do=open screen=ADM-16`
- `do=spot ref=adm.org.reorganise`
- `do=open screen=ADM-17`
- `do=spot ref=adm.org.guest-members`

**Cần thấy trên hình**

- [ ] Màn ADM-01 "Cây tổ chức" mở được ở đường dẫn /adm/adm-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-02 "Người dùng và mời thành viên" mở được ở đường dẫn /adm/adm-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-03 "Vai trò và quyền" mở được ở đường dẫn /adm/adm-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-16 "Sắp xếp lại đơn vị" mở được ở đường dẫn /adm/adm-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-17 "Thành viên khách – nhà thầu" mở được ở đường dẫn /adm/adm-17, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần adm.org.tree đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.org.users-invite đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.org.roles-permissions đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.org.reorganise đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.org.guest-members đúng lúc giọng đọc nói tới
- [ ] Cây tổ chức nhiều cấp
- [ ] Ma trận vai trò và quyền
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pl-calendar-signature`

Nền tảng: web; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-05` Danh mục dùng chung (/adm/adm-05); `ADM-07` Lịch công tác và ngày nghỉ (/adm/adm-07); `ADM-08` Chữ ký số (/adm/adm-08)

**Lời đọc**

> Danh mục dùng chung và lịch công tác kèm ngày nghỉ được khai một lần. Mọi đồng hồ làm việc đều đọc cùng một lịch. Chữ ký số được cấu hình ở đây cho văn bản và báo cáo.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Danh mục dùng chung và lịch công tác kèm ngày nghỉ được khai một lần. Mọi đồng hồ làm việc đều đọc cùng một lịch. Chữ ký số được cấu hình ở đây cho văn bản và báo cáo.

**Phụ đề**

- Danh mục dùng chung và lịch công / tác kèm ngày nghỉ được khai một lần.
- Mọi đồng hồ làm việc / đều đọc cùng một lịch.
- Chữ ký số được cấu hình ở / đây cho văn bản và báo cáo.

**Các bước quay**

- `do=as persona=sysAdmin`
- `do=open screen=ADM-05`
- `do=spot ref=adm.common.catalogues`
- `do=open screen=ADM-07`
- `do=spot ref=adm.common.working-calendar`
- `do=open screen=ADM-08`
- `do=spot ref=adm.common.digital-signature`

**Cần thấy trên hình**

- [ ] Màn ADM-05 "Danh mục dùng chung" mở được ở đường dẫn /adm/adm-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-07 "Lịch công tác và ngày nghỉ" mở được ở đường dẫn /adm/adm-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-08 "Chữ ký số" mở được ở đường dẫn /adm/adm-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản sysAdmin
- [ ] Khung vào phần adm.common.catalogues đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.common.working-calendar đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.common.digital-signature đúng lúc giọng đọc nói tới
- [ ] Lịch công tác có ngày nghỉ của năm
- [ ] Cấu hình chữ ký số
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pl-sync-migration`

Nền tảng: web; 16.3 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-09` Tích hợp và ánh xạ (/adm/adm-09); `ADM-10` Giám sát đồng bộ (/adm/adm-10); `ADM-13` Nhập chuyển đổi dữ liệu (/adm/adm-13); `ADM-12` Chính sách lưu trữ (/adm/adm-12)

**Lời đọc**

> Tích hợp và ánh xạ, giám sát đồng bộ cho thấy từng đường dữ liệu có chạy không. Nhập chuyển đổi dữ liệu đi theo lô: đăng ký, chạy thử, người khác áp dụng, và hoàn tác được. Chính sách lưu trữ đặt thời hạn giữ theo loại.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Tích hợp và ánh xạ, giám sát đồng bộ cho thấy từng đường dữ liệu có chạy không. Nhập chuyển đổi dữ liệu đi theo lô: đăng ký, chạy thử, người khác áp dụng, và hoàn tác được. Chính sách lưu trữ đặt thời hạn giữ theo loại.

**Phụ đề**

- Tích hợp và ánh xạ, giám sát đồng bộ cho / thấy từng đường dữ liệu có chạy không.
- Nhập chuyển đổi dữ liệu / đi theo lô: đăng ký,
- chạy thử, người khác áp / dụng, và hoàn tác được.
- Chính sách lưu trữ đặt / thời hạn giữ theo loại.

**Các bước quay**

- `do=as persona=sysAdmin`
- `do=open screen=ADM-09`
- `do=spot ref=adm.sync.integration-mapping`
- `do=open screen=ADM-10`
- `do=spot ref=adm.sync.monitoring`
- `do=open screen=ADM-13`
- `do=spot ref=adm.sync.migration-batch`
- `do=open screen=ADM-12`
- `do=spot ref=adm.sync.retention`

**Cần thấy trên hình**

- [ ] Màn ADM-09 "Tích hợp và ánh xạ" mở được ở đường dẫn /adm/adm-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-10 "Giám sát đồng bộ" mở được ở đường dẫn /adm/adm-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-13 "Nhập chuyển đổi dữ liệu" mở được ở đường dẫn /adm/adm-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-12 "Chính sách lưu trữ" mở được ở đường dẫn /adm/adm-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản sysAdmin
- [ ] Khung vào phần adm.sync.integration-mapping đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.sync.monitoring đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.sync.migration-batch đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.sync.retention đúng lúc giọng đọc nói tới
- [ ] Lô chuyển đổi có bước chạy thử và áp dụng
- [ ] Chính sách lưu trữ theo loại dữ liệu
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pl-rules`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-21` Soạn phiên bản quy tắc (/adm/adm-21); `ADM-22` So sánh phiên bản quy tắc (/adm/adm-22)

**Lời đọc**

> Mọi ngưỡng đều là quy tắc có phiên bản, công thức, nguồn và ngày hiệu lực. Soạn bản mới, so sánh với bản đang chạy, rồi một người khác phê duyệt. Giá trị chưa ai xác nhận mang dấu chưa kiểm chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mọi ngưỡng đều là quy tắc có phiên bản, công thức, nguồn và ngày hiệu lực. Soạn bản mới, so sánh với bản đang chạy, rồi một người khác phê duyệt. Giá trị chưa ai xác nhận mang dấu chưa kiểm chứng.

**Phụ đề**

- Mọi ngưỡng đều là quy tắc có phiên / bản, công thức, nguồn và ngày hiệu lực.
- Soạn bản mới, so sánh với bản đang / chạy, rồi một người khác phê duyệt.
- Giá trị chưa ai xác nhận / mang dấu chưa kiểm chứng.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=ADM-21`
- `do=spot ref=adm.rules.draft-version`
- `do=open screen=ADM-22`
- `do=spot ref=adm.rules.compare-versions`

**Cần thấy trên hình**

- [ ] Màn ADM-21 "Soạn phiên bản quy tắc" mở được ở đường dẫn /adm/adm-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-22 "So sánh phiên bản quy tắc" mở được ở đường dẫn /adm/adm-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần adm.rules.draft-version đúng lúc giọng đọc nói tới
- [ ] Khung vào phần adm.rules.compare-versions đúng lúc giọng đọc nói tới
- [ ] So sánh hai phiên bản quy tắc
- [ ] Dấu chưa kiểm chứng ở quy tắc mặc định
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pl-master-data`

Nền tảng: web; 19.1 giây; chỉ trong chương cắt riêng

Màn hình: `MDM-01` Trung tâm danh mục (/mdm/mdm-01); `MDM-02` Địa bàn và lịch sử sáp nhập (/mdm/mdm-02); `MDM-04` Nguồn vốn và cây phân loại (/mdm/mdm-04); `MDM-30` Hợp nhất mã trùng (/mdm/mdm-30); `MDM-36` Quy tắc survivorship theo thuộc tính (/mdm/mdm-36); `MDM-37` Kế thừa đơn vị hành chính và cơ quan 2025 (/mdm/mdm-37)

**Lời đọc**

> Trung tâm danh mục quản địa bàn và lịch sử sáp nhập, cơ quan, nguồn vốn, lĩnh vực và hàng chục danh mục khác. Mã trùng được hợp nhất, thuộc tính nào thắng khi hai bản ghi khác nhau do quy tắc quyết định. Đơn vị hành chính sau sáp nhập kế thừa đúng dữ liệu cũ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trung tâm danh mục quản địa bàn và lịch sử sáp nhập, cơ quan, nguồn vốn, lĩnh vực và hàng chục danh mục khác. Mã trùng được hợp nhất, thuộc tính nào thắng khi hai bản ghi khác nhau do quy tắc quyết định. Đơn vị hành chính sau sáp nhập kế thừa đúng dữ liệu cũ.

**Phụ đề**

- Trung tâm danh mục quản địa / bàn và lịch sử sáp nhập,
- cơ quan, nguồn vốn, lĩnh vực / và hàng chục danh mục khác.
- Mã trùng được hợp nhất, / thuộc tính nào thắng khi
- hai bản ghi khác nhau / do quy tắc quyết định.
- Đơn vị hành chính sau sáp / nhập kế thừa đúng dữ liệu cũ.

**Các bước quay**

- `do=as persona=dgvSteward`
- `do=open screen=MDM-01`
- `do=spot ref=mdm.mdm.catalogue-hub`
- `do=open screen=MDM-02`
- `do=spot ref=mdm.mdm.merger-history`
- `do=open screen=MDM-04`
- `do=open screen=MDM-30`
- `do=spot ref=mdm.mdm.merge-duplicates`
- `do=open screen=MDM-36`
- `do=spot ref=mdm.mdm.survivorship`
- `do=open screen=MDM-37`
- `do=spot ref=mdm.mdm.inheritance`

**Cần thấy trên hình**

- [ ] Màn MDM-01 "Trung tâm danh mục" mở được ở đường dẫn /mdm/mdm-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MDM-02 "Địa bàn và lịch sử sáp nhập" mở được ở đường dẫn /mdm/mdm-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MDM-04 "Nguồn vốn và cây phân loại" mở được ở đường dẫn /mdm/mdm-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MDM-30 "Hợp nhất mã trùng" mở được ở đường dẫn /mdm/mdm-30, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MDM-36 "Quy tắc survivorship theo thuộc tính" mở được ở đường dẫn /mdm/mdm-36, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MDM-37 "Kế thừa đơn vị hành chính và cơ quan 2025" mở được ở đường dẫn /mdm/mdm-37, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản dgvSteward
- [ ] Khung vào phần mdm.mdm.catalogue-hub đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mdm.mdm.merger-history đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mdm.mdm.merge-duplicates đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mdm.mdm.survivorship đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mdm.mdm.inheritance đúng lúc giọng đọc nói tới
- [ ] Lịch sử sáp nhập địa bàn
- [ ] Hàng chờ hợp nhất mã trùng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pl-data-quality`

Nền tảng: web; 17.6 giây; chỉ trong chương cắt riêng

Màn hình: `DGV-01` Điều hành chất lượng dữ liệu (/dgv/dgv-01); `DGV-02` Business glossary (/dgv/dgv-02); `DGV-06` Quy tắc chất lượng (/dgv/dgv-06); `DGV-07` Profiling và điểm chất lượng (/dgv/dgv-07); `DGV-08` Sự cố dữ liệu (/dgv/dgv-08)

**Lời đọc**

> Điều hành chất lượng dữ liệu có thuật ngữ nghiệp vụ, quy tắc chất lượng và điểm chất lượng cho từng bộ dữ liệu. Sự cố dữ liệu được ghi, phân người xử lý và đóng khi sửa xong. Chủ sở hữu và người quản lý từng dữ liệu được nêu rõ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Điều hành chất lượng dữ liệu có thuật ngữ nghiệp vụ, quy tắc chất lượng và điểm chất lượng cho từng bộ dữ liệu. Sự cố dữ liệu được ghi, phân người xử lý và đóng khi sửa xong. Chủ sở hữu và người quản lý từng dữ liệu được nêu rõ.

**Phụ đề**

- Điều hành chất lượng dữ / liệu có thuật ngữ nghiệp vụ,
- quy tắc chất lượng và điểm / chất lượng cho từng bộ dữ liệu.
- Sự cố dữ liệu được ghi, phân / người xử lý và đóng khi sửa xong.
- Chủ sở hữu và người quản lý / từng dữ liệu được nêu rõ.

**Các bước quay**

- `do=as persona=dgvSteward`
- `do=open screen=DGV-01`
- `do=spot ref=dgv.quality.control-room`
- `do=open screen=DGV-02`
- `do=spot ref=dgv.quality.glossary`
- `do=open screen=DGV-06`
- `do=spot ref=dgv.quality.rules`
- `do=open screen=DGV-07`
- `do=open screen=DGV-08`
- `do=spot ref=dgv.quality.incidents`

**Cần thấy trên hình**

- [ ] Màn DGV-01 "Điều hành chất lượng dữ liệu" mở được ở đường dẫn /dgv/dgv-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DGV-02 "Business glossary" mở được ở đường dẫn /dgv/dgv-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DGV-06 "Quy tắc chất lượng" mở được ở đường dẫn /dgv/dgv-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DGV-07 "Profiling và điểm chất lượng" mở được ở đường dẫn /dgv/dgv-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DGV-08 "Sự cố dữ liệu" mở được ở đường dẫn /dgv/dgv-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản dgvSteward
- [ ] Khung vào phần dgv.quality.control-room đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dgv.quality.glossary đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dgv.quality.rules đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dgv.quality.incidents đúng lúc giọng đọc nói tới
- [ ] Điểm chất lượng theo bộ dữ liệu
- [ ] Sự cố dữ liệu có người xử lý
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pl-dashboard-builder`

Nền tảng: web; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `BI-03` Trình dựng dashboard (/bi/bi-03); `BI-05` Danh mục chỉ tiêu (/bi/bi-05); `BI-08` Phân quyền dòng và cột (/bi/bi-08); `BI-09` Trình phân tích dữ liệu (/bi/bi-09)

**Lời đọc**

> Người dùng tự dựng dashboard từ danh mục chỉ tiêu có định nghĩa. Quyền theo dòng và cột bảo đảm mỗi người chỉ thấy dữ liệu của mình. Trình phân tích cho khoan từ tổng xuống chi tiết.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Người dùng tự dựng đát-bo từ danh mục chỉ tiêu có định nghĩa. Quyền theo dòng và cột bảo đảm mỗi người chỉ thấy dữ liệu của mình. Trình phân tích cho khoan từ tổng xuống chi tiết.

**Phụ đề**

- Người dùng tự dựng dashboard từ / danh mục chỉ tiêu có định nghĩa.
- Quyền theo dòng và cột bảo đảm mỗi / người chỉ thấy dữ liệu của mình.
- Trình phân tích cho khoan / từ tổng xuống chi tiết.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=BI-03`
- `do=spot ref=bi.builder.dashboard`
- `do=open screen=BI-05`
- `do=spot ref=bi.builder.metric-catalogue`
- `do=open screen=BI-08`
- `do=spot ref=bi.builder.row-column-security`
- `do=open screen=BI-09`
- `do=spot ref=bi.builder.explorer`

**Cần thấy trên hình**

- [ ] Màn BI-03 "Trình dựng dashboard" mở được ở đường dẫn /bi/bi-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-05 "Danh mục chỉ tiêu" mở được ở đường dẫn /bi/bi-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-08 "Phân quyền dòng và cột" mở được ở đường dẫn /bi/bi-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-09 "Trình phân tích dữ liệu" mở được ở đường dẫn /bi/bi-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần bi.builder.dashboard đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.builder.metric-catalogue đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.builder.row-column-security đúng lúc giọng đọc nói tới
- [ ] Khung vào phần bi.builder.explorer đúng lúc giọng đọc nói tới
- [ ] Danh mục chỉ tiêu có định nghĩa
- [ ] Cấu hình quyền theo dòng và cột
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pl-notification-ops`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `NOT-04` Tổng quan vận hành thông báo (/not/not-04); `NOT-07` Soạn mẫu đa kênh (/not/not-07); `NOT-10` Lịch gửi và chiến dịch (/not/not-10); `NOT-15` Hạn mức và chi phí kênh (/not/not-15); `NOT-16` Phê duyệt gửi diện rộng (/not/not-16); `OMNI-01` Hộp thư hợp nhất (/omni/omni-01)

**Lời đọc**

> Vận hành thông báo gồm mẫu đa kênh, lịch gửi, hạn mức và chi phí từng kênh. Gửi diện rộng cần người khác phê duyệt. Hộp thư hợp nhất gom trao đổi từ các kênh vào một chỗ và chuyển thành việc khi cần.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Vận hành thông báo gồm mẫu đa kênh, lịch gửi, hạn mức và chi phí từng kênh. Gửi diện rộng cần người khác phê duyệt. Hộp thư hợp nhất gom trao đổi từ các kênh vào một chỗ và chuyển thành việc khi cần.

**Phụ đề**

- Vận hành thông báo gồm mẫu đa kênh, / lịch gửi, hạn mức và chi phí từng kênh.
- Gửi diện rộng cần người khác phê duyệt.
- Hộp thư hợp nhất gom trao đổi từ các kênh / vào một chỗ và chuyển thành việc khi cần.

**Các bước quay**

- `do=as persona=sysAdmin`
- `do=open screen=NOT-04`
- `do=spot ref=not.notify.ops-overview`
- `do=open screen=NOT-07`
- `do=spot ref=not.notify.templates`
- `do=open screen=NOT-10`
- `do=spot ref=not.notify.schedule`
- `do=open screen=NOT-15`
- `do=open screen=NOT-16`
- `do=spot ref=not.notify.broadcast-approval`
- `do=open screen=OMNI-01`
- `do=spot ref=omni.notify.unified-inbox`

**Cần thấy trên hình**

- [ ] Màn NOT-04 "Tổng quan vận hành thông báo" mở được ở đường dẫn /not/not-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn NOT-07 "Soạn mẫu đa kênh" mở được ở đường dẫn /not/not-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn NOT-10 "Lịch gửi và chiến dịch" mở được ở đường dẫn /not/not-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn NOT-15 "Hạn mức và chi phí kênh" mở được ở đường dẫn /not/not-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn NOT-16 "Phê duyệt gửi diện rộng" mở được ở đường dẫn /not/not-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn OMNI-01 "Hộp thư hợp nhất" mở được ở đường dẫn /omni/omni-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản sysAdmin
- [ ] Khung vào phần not.notify.ops-overview đúng lúc giọng đọc nói tới
- [ ] Khung vào phần not.notify.templates đúng lúc giọng đọc nói tới
- [ ] Khung vào phần not.notify.schedule đúng lúc giọng đọc nói tới
- [ ] Khung vào phần not.notify.broadcast-approval đúng lúc giọng đọc nói tới
- [ ] Khung vào phần omni.notify.unified-inbox đúng lúc giọng đọc nói tới
- [ ] Hạn mức và chi phí theo kênh
- [ ] Hộp thư hợp nhất có hội thoại từ nhiều kênh
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pl-branding`

Nền tảng: web; 18.2 giây; chỉ trong chương cắt riêng

Màn hình: `SAS-04` Theme & thương hiệu tenant (/sas/sas-04); `SAS-06` Gói sản phẩm và tính năng (/sas/sas-06)

**Lời đọc**

> Mỗi đơn vị sử dụng có chủ đề và thương hiệu riêng: tên, màu và biểu trưng. Biểu trưng và bộ nhận diện mới của sản phẩm xuất hiện nhất quán trên web, ứng dụng điện thoại và biểu tượng PWA. Gói sản phẩm quyết định tính năng nào được bật.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi đơn vị sử dụng có chủ đề và thương hiệu riêng: tên, màu và biểu trưng. Biểu trưng và bộ nhận diện mới của sản phẩm xuất hiện nhất quán trên quép, ứng dụng điện thoại và biểu tượng pê-đắp-liu-a. Gói sản phẩm quyết định tính năng nào được bật.

**Phụ đề**

- Mỗi đơn vị sử dụng có chủ đề và thương / hiệu riêng: tên, màu và biểu trưng.
- Biểu trưng và bộ nhận diện mới / của sản phẩm xuất hiện nhất
- quán trên web, ứng dụng điện / thoại và biểu tượng PWA.
- Gói sản phẩm quyết định / tính năng nào được bật.

**Các bước quay**

- `do=as persona=sysAdmin`
- `do=open screen=SAS-04`
- `do=spot ref=sas.branding.theme-logo`
- `do=open screen=SAS-06`
- `do=spot ref=sas.branding.feature-package`

**Cần thấy trên hình**

- [ ] Màn SAS-04 "Theme & thương hiệu tenant" mở được ở đường dẫn /sas/sas-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn SAS-06 "Gói sản phẩm và tính năng" mở được ở đường dẫn /sas/sas-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản sysAdmin
- [ ] Khung vào phần sas.branding.theme-logo đúng lúc giọng đọc nói tới
- [ ] Khung vào phần sas.branding.feature-package đúng lúc giọng đọc nói tới
- [ ] Chú thích "Một bộ nhận diện trên web, điện thoại và PWA" hiện từ giây 4, kéo dài 6 giây
- [ ] Biểu trưng mới trên màn hình cấu hình
- [ ] Xem trước giao diện theo chủ đề của đơn vị
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pl-platform-health`

Nền tảng: web; 15.4 giây; chỉ trong chương cắt riêng

Màn hình: `SAS-18` Sức khỏe toàn nền tảng (/sas/sas-18); `SAS-20` Cờ tính năng và phát hành (/sas/sas-20); `SAS-21` Sao lưu và khôi phục tenant (/sas/sas-21)

**Lời đọc**

> Sức khỏe nền tảng cho thấy dịch vụ nào đang chậm hay lỗi. Cờ tính năng bật hoặc tắt từng tính năng khi phát hành. Sao lưu và khôi phục theo từng đơn vị có lịch sử, và mọi khôi phục đều qua phê duyệt.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sức khỏe nền tảng cho thấy dịch vụ nào đang chậm hay lỗi. Cờ tính năng bật hoặc tắt từng tính năng khi phát hành. Sao lưu và khôi phục theo từng đơn vị có lịch sử, và mọi khôi phục đều qua phê duyệt.

**Phụ đề**

- Sức khỏe nền tảng cho thấy / dịch vụ nào đang chậm hay lỗi.
- Cờ tính năng bật hoặc tắt / từng tính năng khi phát hành.
- Sao lưu và khôi phục theo / từng đơn vị có lịch sử,
- và mọi khôi phục đều qua phê duyệt.

**Các bước quay**

- `do=as persona=sysAdmin`
- `do=open screen=SAS-18`
- `do=spot ref=sas.ops.platform-health`
- `do=open screen=SAS-20`
- `do=spot ref=sas.ops.feature-flags`
- `do=open screen=SAS-21`
- `do=spot ref=sas.ops.backup-restore`

**Cần thấy trên hình**

- [ ] Màn SAS-18 "Sức khỏe toàn nền tảng" mở được ở đường dẫn /sas/sas-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn SAS-20 "Cờ tính năng và phát hành" mở được ở đường dẫn /sas/sas-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn SAS-21 "Sao lưu và khôi phục tenant" mở được ở đường dẫn /sas/sas-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản sysAdmin
- [ ] Khung vào phần sas.ops.platform-health đúng lúc giọng đọc nói tới
- [ ] Khung vào phần sas.ops.feature-flags đúng lúc giọng đọc nói tới
- [ ] Khung vào phần sas.ops.backup-restore đúng lúc giọng đọc nói tới
- [ ] Bảng sức khỏe các dịch vụ
- [ ] Lịch sử sao lưu và khôi phục
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Điện thoại và PWA nâng cao (`phone-plus`)

### `pp-staff-home`

Nền tảng: phone; 12.1 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-08` Trang chủ cán bộ (tab home); `MOB-10` Chi tiết dự án (tab projects); `MOB-11` Bản đồ hiện trường (tab projects); `MOB-12` Kế hoạch vốn (tab projects)

**Lời đọc**

> Trang chủ cán bộ gom việc của tôi, dự án đang phụ trách và cảnh báo. Chạm vào dự án thấy chi tiết, bản đồ hiện trường và kế hoạch vốn ngay trên điện thoại.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trang chủ cán bộ gom việc của tôi, dự án đang phụ trách và cảnh báo. Chạm vào dự án thấy chi tiết, bản đồ hiện trường và kế hoạch vốn ngay trên điện thoại.

**Phụ đề**

- Trang chủ cán bộ gom việc của tôi, / dự án đang phụ trách và cảnh báo.
- Chạm vào dự án thấy chi tiết, bản đồ hiện
- trường và kế hoạch vốn / ngay trên điện thoại.

**Các bước quay**

- `do=as persona=projectManager`
- `do=phone-open screen=MOB-08`
- `do=spot ref=mob.home.staff`
- `do=phone-open screen=MOB-10`
- `do=phone-tap ref=mob.home.project-detail`
- `do=phone-open screen=MOB-11`
- `do=spot ref=mob.home.field-map`
- `do=phone-open screen=MOB-12`
- `do=spot ref=mob.home.capital-plan`

**Cần thấy trên hình**

- [ ] Màn MOB-08 "Trang chủ cán bộ" trên điện thoại (tab home) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-10 "Chi tiết dự án" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-11 "Bản đồ hiện trường" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-12 "Kế hoạch vốn" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần mob.home.staff đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.home.field-map đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.home.capital-plan đúng lúc giọng đọc nói tới
- [ ] Trang chủ cán bộ có việc của tôi
- [ ] Bản đồ hiện trường có vị trí dự án
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-weekly-entry`

Nền tảng: phone; 13.3 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-14` Nhập khối lượng (tab projects); `MOB-15` Nhập vốn năm (tab projects); `MOB-16` Nhập vốn kéo dài (tab projects); `MOB-17` Nhập vốn khác (tab projects); `MOB-18` Đăng ký tháng sau (tab projects); `MOB-19` Đính kèm chứng từ (tab projects)

**Lời đọc**

> Báo cáo tuần nhập ngay trên điện thoại: khối lượng, vốn năm, vốn kéo dài, vốn khác và đăng ký tháng sau. Chứng từ đính kèm bằng ảnh chụp. Bản nháp lưu lại, mất mạng cũng không mất.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Báo cáo tuần nhập ngay trên điện thoại: khối lượng, vốn năm, vốn kéo dài, vốn khác và đăng ký tháng sau. Chứng từ đính kèm bằng ảnh chụp. Bản nháp lưu lại, mất mạng cũng không mất.

**Phụ đề**

- Báo cáo tuần nhập ngay trên / điện thoại: khối lượng,
- vốn năm, vốn kéo dài, vốn / khác và đăng ký tháng sau.
- Chứng từ đính kèm bằng ảnh chụp.
- Bản nháp lưu lại, mất mạng cũng không mất.

**Các bước quay**

- `do=as persona=projectManager`
- `do=phone-open screen=MOB-14`
- `do=spot ref=mob.entry.quantities`
- `do=phone-open screen=MOB-15`
- `do=spot ref=mob.entry.year-capital`
- `do=phone-open screen=MOB-16`
- `do=phone-open screen=MOB-17`
- `do=phone-open screen=MOB-18`
- `do=spot ref=mob.entry.next-month`
- `do=phone-open screen=MOB-19`
- `do=spot ref=mob.entry.attachments`

**Cần thấy trên hình**

- [ ] Màn MOB-14 "Nhập khối lượng" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-15 "Nhập vốn năm" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-16 "Nhập vốn kéo dài" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-17 "Nhập vốn khác" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-18 "Đăng ký tháng sau" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-19 "Đính kèm chứng từ" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần mob.entry.quantities đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.entry.year-capital đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.entry.next-month đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.entry.attachments đúng lúc giọng đọc nói tới
- [ ] Các màn nhập khối lượng và vốn
- [ ] Màn đính chứng từ bằng ảnh
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-monthly`

Nền tảng: phone; 16 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-55` Thuyết minh tháng (tab projects); `MOB-56` Ước giải ngân cuối kỳ (tab projects); `MOB-57` Dự án chưa nộp báo cáo (tab projects); `MOB-58` Cơ cấu nguồn vốn (tab home); `MOB-59` Vướng mắc theo tuần (tab projects)

**Lời đọc**

> Lãnh đạo đọc ngay trên điện thoại thuyết minh tháng, ước giải ngân cuối kỳ và danh sách dự án chưa nộp báo cáo. Cơ cấu nguồn vốn và vướng mắc theo tuần cũng có ở đó. Mỗi số vẫn có nguồn và thời điểm cập nhật.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Lãnh đạo đọc ngay trên điện thoại thuyết minh tháng, ước giải ngân cuối kỳ và danh sách dự án chưa nộp báo cáo. Cơ cấu nguồn vốn và vướng mắc theo tuần cũng có ở đó. Mỗi số vẫn có nguồn và thời điểm cập nhật.

**Phụ đề**

- Lãnh đạo đọc ngay trên điện / thoại thuyết minh tháng,
- ước giải ngân cuối kỳ và danh / sách dự án chưa nộp báo cáo.
- Cơ cấu nguồn vốn và vướng / mắc theo tuần cũng có ở đó.
- Mỗi số vẫn có nguồn và thời điểm cập nhật.

**Các bước quay**

- `do=as persona=owner`
- `do=phone-open screen=MOB-55`
- `do=spot ref=mob.monthly.narrative`
- `do=phone-open screen=MOB-56`
- `do=spot ref=mob.monthly.end-estimate`
- `do=phone-open screen=MOB-57`
- `do=spot ref=mob.monthly.not-submitted`
- `do=phone-open screen=MOB-58`
- `do=spot ref=mob.monthly.funding-structure`
- `do=phone-open screen=MOB-59`
- `do=spot ref=mob.monthly.weekly-issues`

**Cần thấy trên hình**

- [ ] Màn MOB-55 "Thuyết minh tháng" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-56 "Ước giải ngân cuối kỳ" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-57 "Dự án chưa nộp báo cáo" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-58 "Cơ cấu nguồn vốn" trên điện thoại (tab home) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-59 "Vướng mắc theo tuần" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần mob.monthly.narrative đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.monthly.end-estimate đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.monthly.not-submitted đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.monthly.funding-structure đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.monthly.weekly-issues đúng lúc giọng đọc nói tới
- [ ] Cơ cấu nguồn vốn có biểu đồ
- [ ] Danh sách dự án chưa nộp
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-field-contract`

Nền tảng: phone; 12.1 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-63` Ghi nhận khối lượng và bằng chứng (tab projects); `MOB-64` Kiểm tra chất lượng hiện trường (tab projects); `MOB-65` Duyệt nghiệm thu trên điện thoại (tab approval); `MOB-66` Bàn giao và bảo hành trên điện thoại (tab projects)

**Lời đọc**

> Ghi nhận khối lượng kèm bằng chứng, kiểm tra chất lượng, duyệt nghiệm thu, bàn giao và bảo hành đều làm được ngay ở hiện trường. Người duyệt xem đúng bằng chứng rồi mới duyệt.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Ghi nhận khối lượng kèm bằng chứng, kiểm tra chất lượng, duyệt nghiệm thu, bàn giao và bảo hành đều làm được ngay ở hiện trường. Người duyệt xem đúng bằng chứng rồi mới duyệt.

**Phụ đề**

- Ghi nhận khối lượng kèm bằng / chứng, kiểm tra chất lượng,
- duyệt nghiệm thu, bàn giao và bảo / hành đều làm được ngay ở hiện trường.
- Người duyệt xem đúng / bằng chứng rồi mới duyệt.

**Các bước quay**

- `do=as persona=ctrOfficer`
- `do=phone-open screen=MOB-63`
- `do=spot ref=mob.field.quantity-evidence`
- `do=phone-open screen=MOB-64`
- `do=spot ref=mob.field.quality-check`
- `do=phone-open screen=MOB-65`
- `do=spot ref=mob.field.acceptance-approval`
- `do=phone-open screen=MOB-66`
- `do=spot ref=mob.field.handover-warranty`

**Cần thấy trên hình**

- [ ] Màn MOB-63 "Ghi nhận khối lượng và bằng chứng" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-64 "Kiểm tra chất lượng hiện trường" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-65 "Duyệt nghiệm thu trên điện thoại" trên điện thoại (tab approval) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-66 "Bàn giao và bảo hành trên điện thoại" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần mob.field.quantity-evidence đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.field.quality-check đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.field.acceptance-approval đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.field.handover-warranty đúng lúc giọng đọc nói tới
- [ ] Khối lượng có ảnh bằng chứng
- [ ] Màn duyệt nghiệm thu có xác nhận
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-diary-photos`

Nền tảng: phone; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `QMS-09` Nhật ký thi công ngoại tuyến trên điện thoại (tab projects); `QMS-10` Chụp ảnh hiện trường kiểm EXIF và GPS (tab projects); `MOB-68` Nhiệm vụ GPMB hiện trường (tab projects)

**Lời đọc**

> Nhật ký thi công viết được khi ngoại tuyến và tự đồng bộ. Ảnh chụp được kiểm thông tin ảnh và vị trí, ảnh không khớp bị đánh dấu. Nhiệm vụ giải phóng mặt bằng hiện trường cũng nằm trên điện thoại.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Nhật ký thi công viết được khi ngoại tuyến và tự đồng bộ. Ảnh chụp được kiểm thông tin ảnh và vị trí, ảnh không khớp bị đánh dấu. Nhiệm vụ giải phóng mặt bằng hiện trường cũng nằm trên điện thoại.

**Phụ đề**

- Nhật ký thi công viết được / khi ngoại tuyến và tự đồng bộ.
- Ảnh chụp được kiểm thông tin ảnh và / vị trí, ảnh không khớp bị đánh dấu.
- Nhiệm vụ giải phóng mặt bằng hiện / trường cũng nằm trên điện thoại.

**Các bước quay**

- `do=as persona=projectManager`
- `do=phone-open screen=QMS-09`
- `do=spot ref=qms.diary.offline`
- `do=phone-open screen=QMS-10`
- `do=spot ref=qms.diary.photo-checks`
- `do=phone-open screen=MOB-68`
- `do=spot ref=mob.diary.land-tasks`

**Cần thấy trên hình**

- [ ] Màn QMS-09 "Nhật ký thi công ngoại tuyến trên điện thoại" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn QMS-10 "Chụp ảnh hiện trường kiểm EXIF và GPS" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-68 "Nhiệm vụ GPMB hiện trường" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần qms.diary.offline đúng lúc giọng đọc nói tới
- [ ] Khung vào phần qms.diary.photo-checks đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.diary.land-tasks đúng lúc giọng đọc nói tới
- [ ] Nhật ký ngoại tuyến có nhãn chờ đồng bộ
- [ ] Ảnh kiểm vị trí hiện kết quả
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-sign-directives`

Nền tảng: phone; 13.6 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-22` Duyệt và ký văn bản (di động) (tab approval); `DOC-23` Văn bản đến cần xử lý (di động) (tab approval); `MOB-67` Văn bản chờ ký (tab approval); `DIR-06` Chỉ đạo giao ban trên điện thoại (tab projects)

**Lời đọc**

> Lãnh đạo duyệt và ký văn bản, xem văn bản đến cần xử lý và theo dõi chỉ đạo giao ban trên điện thoại. Việc ký luôn qua màn xác nhận, và có dấu vết đầy đủ trên hệ thống.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Lãnh đạo duyệt và ký văn bản, xem văn bản đến cần xử lý và theo dõi chỉ đạo giao ban trên điện thoại. Việc ký luôn qua màn xác nhận, và có dấu vết đầy đủ trên hệ thống.

**Phụ đề**

- Lãnh đạo duyệt và ký văn / bản, xem văn bản đến cần
- xử lý và theo dõi chỉ đạo / giao ban trên điện thoại.
- Việc ký luôn qua màn xác nhận, và / có dấu vết đầy đủ trên hệ thống.

**Các bước quay**

- `do=as persona=owner`
- `do=phone-open screen=DOC-22`
- `do=spot ref=doc.sign.documents`
- `do=phone-open screen=DOC-23`
- `do=spot ref=doc.sign.incoming`
- `do=phone-open screen=MOB-67`
- `do=phone-open screen=DIR-06`
- `do=spot ref=dir.sign.directives`

**Cần thấy trên hình**

- [ ] Màn DOC-22 "Duyệt và ký văn bản (di động)" trên điện thoại (tab approval) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn DOC-23 "Văn bản đến cần xử lý (di động)" trên điện thoại (tab approval) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-67 "Văn bản chờ ký" trên điện thoại (tab approval) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn DIR-06 "Chỉ đạo giao ban trên điện thoại" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần doc.sign.documents đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.sign.incoming đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dir.sign.directives đúng lúc giọng đọc nói tới
- [ ] Danh sách văn bản chờ ký
- [ ] Chỉ đạo giao ban và hạn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-risk-bi`

Nền tảng: phone; 13.9 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-73` Xếp hạng rủi ro nhà thầu trên điện thoại (tab projects); `MOB-74` Rủi ro và kết quả thực hiện của một nhà thầu trên điện thoại (tab projects); `MOB-38` Tóm tắt phân tích nhà thầu (tab projects); `MOB-40` Dashboard BI cá nhân (tab home)

**Lời đọc**

> Xếp hạng rủi ro nhà thầu và kết quả thực hiện của từng nhà thầu xem được trên điện thoại. Tóm tắt phân tích nhà thầu và dashboard BI cá nhân đi theo người dùng, đúng quyền của họ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Xếp hạng rủi ro nhà thầu và kết quả thực hiện của từng nhà thầu xem được trên điện thoại. Tóm tắt phân tích nhà thầu và đát-bo bi-ai cá nhân đi theo người dùng, đúng quyền của họ.

**Phụ đề**

- Xếp hạng rủi ro nhà thầu / và kết quả thực hiện
- của từng nhà thầu xem / được trên điện thoại.
- Tóm tắt phân tích nhà / thầu và dashboard BI cá
- nhân đi theo người / dùng, đúng quyền của họ.

**Các bước quay**

- `do=as persona=owner`
- `do=phone-open screen=MOB-73`
- `do=spot ref=mob.risk.contractor-ranking`
- `do=phone-open screen=MOB-74`
- `do=spot ref=mob.risk.contractor-detail`
- `do=phone-open screen=MOB-38`
- `do=spot ref=mob.risk.analysis-summary`
- `do=phone-open screen=MOB-40`
- `do=spot ref=mob.risk.my-dashboard`

**Cần thấy trên hình**

- [ ] Màn MOB-73 "Xếp hạng rủi ro nhà thầu trên điện thoại" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-74 "Rủi ro và kết quả thực hiện của một nhà thầu trên điện thoại" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-38 "Tóm tắt phân tích nhà thầu" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-40 "Dashboard BI cá nhân" trên điện thoại (tab home) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần mob.risk.contractor-ranking đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.risk.contractor-detail đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.risk.analysis-summary đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.risk.my-dashboard đúng lúc giọng đọc nói tới
- [ ] Xếp hạng nhà thầu theo hạng rủi ro
- [ ] Dashboard cá nhân
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-conversation`

Nền tảng: phone; 11.5 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-35` Hộp hội thoại (tab inbox); `MOB-36` Trao đổi theo hồ sơ (tab inbox); `MOB-34` Cài đặt thông báo (tab inbox); `MOB-51` Tìm kiếm trên điện thoại (tab account); `MOB-50` Trợ giúp và phản hồi (tab account)

**Lời đọc**

> Hộp hội thoại và trao đổi theo từng hồ sơ nằm ngay trong ứng dụng. Cài đặt thông báo, tìm kiếm trên điện thoại, trợ giúp và gửi phản hồi đều có sẵn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hộp hội thoại và trao đổi theo từng hồ sơ nằm ngay trong ứng dụng. Cài đặt thông báo, tìm kiếm trên điện thoại, trợ giúp và gửi phản hồi đều có sẵn.

**Phụ đề**

- Hộp hội thoại và trao đổi theo / từng hồ sơ nằm ngay trong ứng dụng.
- Cài đặt thông báo, tìm / kiếm trên điện thoại,
- trợ giúp và gửi phản hồi đều có sẵn.

**Các bước quay**

- `do=as persona=projectManager`
- `do=phone-open screen=MOB-35`
- `do=spot ref=mob.chat.inbox`
- `do=phone-open screen=MOB-36`
- `do=spot ref=mob.chat.record-thread`
- `do=phone-open screen=MOB-34`
- `do=spot ref=mob.chat.notification-settings`
- `do=phone-open screen=MOB-51`
- `do=spot ref=mob.chat.search`
- `do=phone-open screen=MOB-50`

**Cần thấy trên hình**

- [ ] Màn MOB-35 "Hộp hội thoại" trên điện thoại (tab inbox) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-36 "Trao đổi theo hồ sơ" trên điện thoại (tab inbox) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-34 "Cài đặt thông báo" trên điện thoại (tab inbox) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-51 "Tìm kiếm trên điện thoại" trên điện thoại (tab account) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-50 "Trợ giúp và phản hồi" trên điện thoại (tab account) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần mob.chat.inbox đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.chat.record-thread đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.chat.notification-settings đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.chat.search đúng lúc giọng đọc nói tới
- [ ] Trao đổi gắn với hồ sơ
- [ ] Cài đặt thông báo trên điện thoại
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-system-states`

Nền tảng: phone; 18.2 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-44` Hết phiên (tab projects); `MOB-45` Không đủ quyền (tab projects); `MOB-46` License hết hạn (tab projects); `MOB-52` Trống không có dữ liệu (tab account); `MOB-53` Lỗi dịch vụ và thử lại (tab account); `MOB-54` Bảo trì và cập nhật bắt buộc (tab account); `MOB-48` Đổi tenant (tab account)

**Lời đọc**

> Ứng dụng xử lý rõ mọi trạng thái: hết phiên, không đủ quyền, giấy phép hết hạn, danh sách trống, lỗi dịch vụ và bảo trì cần cập nhật. Mỗi trạng thái nói đúng chuyện gì xảy ra và làm gì tiếp. Người thuộc nhiều đơn vị đổi đơn vị ngay trong ứng dụng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Ứng dụng xử lý rõ mọi trạng thái: hết phiên, không đủ quyền, giấy phép hết hạn, danh sách trống, lỗi dịch vụ và bảo trì cần cập nhật. Mỗi trạng thái nói đúng chuyện gì xảy ra và làm gì tiếp. Người thuộc nhiều đơn vị đổi đơn vị ngay trong ứng dụng.

**Phụ đề**

- Ứng dụng xử lý rõ mọi trạng / thái: hết phiên, không đủ quyền,
- giấy phép hết hạn, danh sách trống, / lỗi dịch vụ và bảo trì cần cập nhật.
- Mỗi trạng thái nói đúng chuyện / gì xảy ra và làm gì tiếp.
- Người thuộc nhiều đơn vị đổi / đơn vị ngay trong ứng dụng.

**Các bước quay**

- `do=as persona=owner`
- `do=phone-open screen=MOB-44`
- `do=spot ref=mob.states.session-expired`
- `do=phone-open screen=MOB-45`
- `do=spot ref=mob.states.no-permission`
- `do=phone-open screen=MOB-46`
- `do=phone-open screen=MOB-52`
- `do=phone-open screen=MOB-53`
- `do=spot ref=mob.states.service-error`
- `do=phone-open screen=MOB-54`
- `do=spot ref=mob.states.maintenance`
- `do=phone-open screen=MOB-48`

**Cần thấy trên hình**

- [ ] Màn MOB-44 "Hết phiên" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-45 "Không đủ quyền" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-46 "License hết hạn" trên điện thoại (tab projects) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-52 "Trống không có dữ liệu" trên điện thoại (tab account) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-53 "Lỗi dịch vụ và thử lại" trên điện thoại (tab account) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-54 "Bảo trì và cập nhật bắt buộc" trên điện thoại (tab account) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-48 "Đổi tenant" trên điện thoại (tab account) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần mob.states.session-expired đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.states.no-permission đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.states.service-error đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.states.maintenance đúng lúc giọng đọc nói tới
- [ ] Màn không đủ quyền nêu lý do
- [ ] Màn lỗi dịch vụ có nút thử lại
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-first-run`

Nền tảng: phone; 14.8 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-01` Chào mừng và nhận diện tenant (tab stack); `MOB-04` Chọn đơn vị và vai trò (tab stack); `MOB-05` Xin quyền thông báo (tab stack); `MOB-06` Xin quyền camera và vị trí (tab stack)

**Lời đọc**

> Lần đầu mở ứng dụng, người dùng thấy màn chào mang tên đơn vị, rồi chọn đơn vị và vai trò. Sau đó mới được hỏi quyền thông báo, máy ảnh và vị trí. Mỗi quyền có lời giải thích vì sao cần.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Lần đầu mở ứng dụng, người dùng thấy màn chào mang tên đơn vị, rồi chọn đơn vị và vai trò. Sau đó mới được hỏi quyền thông báo, máy ảnh và vị trí. Mỗi quyền có lời giải thích vì sao cần.

**Phụ đề**

- Lần đầu mở ứng dụng, / người dùng thấy màn chào
- mang tên đơn vị, rồi / chọn đơn vị và vai trò.
- Sau đó mới được hỏi quyền / thông báo, máy ảnh và vị trí.
- Mỗi quyền có lời giải thích vì sao cần.

**Các bước quay**

- `do=as persona=owner`
- `do=phone-open screen=MOB-01`
- `do=spot ref=mob.first-run.welcome`
- `do=phone-open screen=MOB-04`
- `do=spot ref=mob.first-run.choose-unit-role`
- `do=phone-open screen=MOB-05`
- `do=spot ref=mob.first-run.notification-permission`
- `do=phone-open screen=MOB-06`
- `do=spot ref=mob.first-run.camera-location-permission`

**Cần thấy trên hình**

- [ ] Màn MOB-01 "Chào mừng và nhận diện tenant" trên điện thoại (tab stack) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-04 "Chọn đơn vị và vai trò" trên điện thoại (tab stack) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-05 "Xin quyền thông báo" trên điện thoại (tab stack) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-06 "Xin quyền camera và vị trí" trên điện thoại (tab stack) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần mob.first-run.welcome đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.first-run.choose-unit-role đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.first-run.notification-permission đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.first-run.camera-location-permission đúng lúc giọng đọc nói tới
- [ ] Màn chào mang tên và biểu trưng của đơn vị
- [ ] Lời giải thích trước mỗi lần xin quyền
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pwa-approval-detail`

Nền tảng: pwa; 19.1 giây; chỉ trong chương cắt riêng

Màn hình: `PWA-02` PWA-02 (/m/approvals)

**Lời đọc**

> Trong ứng dụng cài đặt, hàng chờ duyệt dữ liệu kỳ cho mở từng việc. Duyệt thì ghi chú là tùy chọn. Trả lại để sửa thì bắt buộc có ghi chú. Mỗi quyết định cần xác thực hai lớp và chỉ ghi khi phiên bản việc còn đúng, nên hai người không duyệt chồng nhau.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trong ứng dụng cài đặt, hàng chờ duyệt dữ liệu kỳ cho mở từng việc. Duyệt thì ghi chú là tùy chọn. Trả lại để sửa thì bắt buộc có ghi chú. Mỗi quyết định cần xác thực hai lớp và chỉ ghi khi phiên bản việc còn đúng, nên hai người không duyệt chồng nhau.

**Phụ đề**

- Trong ứng dụng cài đặt, hàng chờ / duyệt dữ liệu kỳ cho mở từng việc.
- Duyệt thì ghi chú là tùy chọn.
- Trả lại để sửa thì bắt buộc có ghi chú.
- Mỗi quyết định cần xác thực / hai lớp và chỉ ghi khi phiên
- bản việc còn đúng, nên hai / người không duyệt chồng nhau.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=PWA-02`
- `do=spot ref=pwa.approvals.queue-item`
- `do=click ref=pwa.approvals.approve`
- `do=click ref=pwa.approvals.return-comment`

**Cần thấy trên hình**

- [ ] Màn PWA-02 của ứng dụng cài đặt (PWA) mở ở đường dẫn /m/approvals, trong khung điện thoại
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần pwa.approvals.queue-item đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pwa.approvals.approve đúng lúc giọng đọc nói tới
- [ ] Khung vào phần pwa.approvals.return-comment đúng lúc giọng đọc nói tới
- [ ] Chú thích "Trả lại bắt buộc có ghi chú" hiện từ giây 6, kéo dài 5 giây
- [ ] Hàng chờ có ít nhất một việc đang chờ duyệt
- [ ] Ô ghi chú trả lại báo bắt buộc khi để trống
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-alert-routing`

Nền tảng: phone; 17 giây; chỉ trong chương cắt riêng

Màn hình: `MOB-32` Hộp thông báo (tab inbox); `MOB-33` Chi tiết thông báo (tab inbox); `MOB-34` Cài đặt thông báo (tab inbox)

**Lời đọc**

> Cảnh báo tới điện thoại theo thang kênh của đơn vị. Chạm vào thông báo là mở đúng màn hình có việc cần làm, không phải đi tìm. Người dùng đặt kênh và giờ yên lặng cho mình. Cảnh báo chưa ai nhận sẽ leo thang lên cấp trên.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cảnh báo tới điện thoại theo thang kênh của đơn vị. Chạm vào thông báo là mở đúng màn hình có việc cần làm, không phải đi tìm. Người dùng đặt kênh và giờ yên lặng cho mình. Cảnh báo chưa ai nhận sẽ leo thang lên cấp trên.

**Phụ đề**

- Cảnh báo tới điện thoại / theo thang kênh của đơn vị.
- Chạm vào thông báo là mở đúng màn hình / có việc cần làm, không phải đi tìm.
- Người dùng đặt kênh và / giờ yên lặng cho mình.
- Cảnh báo chưa ai nhận sẽ / leo thang lên cấp trên.

**Các bước quay**

- `do=as persona=owner`
- `do=phone-open screen=MOB-32`
- `do=spot ref=mob.alerts.inbox`
- `do=phone-tap ref=mob.MOB-33>alerts.open-from-notice`
- `do=phone-open screen=MOB-33`
- `do=phone-open screen=MOB-34`
- `do=spot ref=mob.alerts.channel-settings`

**Cần thấy trên hình**

- [ ] Màn MOB-32 "Hộp thông báo" trên điện thoại (tab inbox) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-33 "Chi tiết thông báo" trên điện thoại (tab inbox) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Màn MOB-34 "Cài đặt thông báo" trên điện thoại (tab inbox) hiện đủ nội dung, không bị hệ điều hành che
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần mob.alerts.inbox đúng lúc giọng đọc nói tới
- [ ] Khung vào phần mob.alerts.channel-settings đúng lúc giọng đọc nói tới
- [ ] Thông báo mở đúng màn của cảnh báo
- [ ] Cài đặt kênh và giờ yên lặng
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-push-devices`

Nền tảng: web; 17.9 giây; chỉ trong chương cắt riêng

Màn hình: `NOT-14` Thiết bị push (/not/not-14)

**Lời đọc**

> Thông báo đẩy chỉ gửi tới thiết bị đã đăng ký của đúng người. Quản trị xem được danh sách thiết bị và thu hồi một thiết bị mất. Đăng xuất là xóa đăng ký ngay. Nội dung đẩy chỉ có một câu cố định, một con số và một đường dẫn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Thông báo đẩy chỉ gửi tới thiết bị đã đăng ký của đúng người. Quản trị xem được danh sách thiết bị và thu hồi một thiết bị mất. Đăng xuất là xóa đăng ký ngay. Nội dung đẩy chỉ có một câu cố định, một con số và một đường dẫn.

**Phụ đề**

- Thông báo đẩy chỉ gửi tới thiết / bị đã đăng ký của đúng người.
- Quản trị xem được danh sách thiết / bị và thu hồi một thiết bị mất.
- Đăng xuất là xóa đăng ký ngay.
- Nội dung đẩy chỉ có một câu cố / định, một con số và một đường dẫn.

**Các bước quay**

- `do=as persona=sysAdmin`
- `do=open screen=NOT-14`
- `do=spot ref=not.push.devices`
- `do=spot ref=not.push.revoke`

**Cần thấy trên hình**

- [ ] Màn NOT-14 "Thiết bị push" mở được ở đường dẫn /not/not-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản sysAdmin
- [ ] Khung vào phần not.push.devices đúng lúc giọng đọc nói tới
- [ ] Khung vào phần not.push.revoke đúng lúc giọng đọc nói tới
- [ ] Danh sách thiết bị đẩy theo người dùng
- [ ] Nút thu hồi thiết bị
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `pp-pwa-directives`

Nền tảng: pwa; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `PWA-04` PWA-04 (/m/directives)

**Lời đọc**

> Ứng dụng cài đặt PWA có thêm màn theo dõi chỉ đạo giao ban: chỉ đạo đang mở, quá hạn và đã leo thang. Lãnh đạo mở thẳng từ thông báo đẩy, chỉ mang đường dẫn, không mang số liệu.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Ứng dụng cài đặt pê-đắp-liu-a có thêm màn theo dõi chỉ đạo giao ban: chỉ đạo đang mở, quá hạn và đã leo thang. Lãnh đạo mở thẳng từ thông báo đẩy, chỉ mang đường dẫn, không mang số liệu.

**Phụ đề**

- Ứng dụng cài đặt PWA có thêm / màn theo dõi chỉ đạo giao ban:
- chỉ đạo đang mở, quá hạn và đã leo thang.
- Lãnh đạo mở thẳng từ thông báo đẩy, / chỉ mang đường dẫn, không mang số liệu.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=PWA-04`
- `do=spot ref=pwa.directives.tracking`

**Cần thấy trên hình**

- [ ] Màn PWA-04 của ứng dụng cài đặt (PWA) mở ở đường dẫn /m/directives, trong khung điện thoại
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần pwa.directives.tracking đúng lúc giọng đọc nói tới
- [ ] Màn chỉ đạo hiện số liệu thật, không báo chưa bật
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Các chức năng khác của hệ thống (`features-tour`)

### `tour-more`

Nền tảng: animatic; 29.2 giây; có trong video chính

**Lời đọc**

> Hệ thống còn nhiều chức năng khác, mỗi chức năng có một đoạn phim riêng. Về nhà thầu có quản lý nâng cao và cổng nhà thầu. Về hợp đồng có claim, cảnh báo sớm và nghiệm thu. Về giám sát có thanh tra kiểm toán, dự báo và rủi ro. Về vốn có kiểm soát vốn và thanh toán Kho bạc. Còn có báo cáo, văn thư ký số, hồ sơ và AI, tích hợp, điện thoại và PWA nâng cao.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hệ thống còn nhiều chức năng khác, mỗi chức năng có một đoạn phim riêng. Về nhà thầu có quản lý nâng cao và cổng nhà thầu. Về hợp đồng có cờ-lêm, cảnh báo sớm và nghiệm thu. Về giám sát có thanh tra kiểm toán, dự báo và rủi ro. Về vốn có kiểm soát vốn và thanh toán Kho bạc. Còn có báo cáo, văn thư ký số, hồ sơ và ây-ai, tích hợp, điện thoại và pê-đắp-liu-a nâng cao.

**Phụ đề**

- Hệ thống còn nhiều chức năng khác, / mỗi chức năng có một đoạn phim riêng.
- Về nhà thầu có quản lý / nâng cao và cổng nhà thầu.
- Về hợp đồng có claim, cảnh / báo sớm và nghiệm thu.
- Về giám sát có thanh tra / kiểm toán, dự báo và rủi ro.
- Về vốn có kiểm soát vốn / và thanh toán Kho bạc.
- Còn có báo cáo, văn thư ký số, hồ sơ và / AI, tích hợp, điện thoại và PWA nâng cao.

**Các bước quay**

- `do=animatic id=features-more`

**Cần thấy trên hình**

- [ ] Hoạt cảnh features-more chạy hết thời lượng của lời đọc, chữ trên hình là tiếng Việt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Tin cậy và kết thúc (`close`)

### `close-trust`

Nền tảng: web; 14.2 giây; có trong video chính

Màn hình: `ADM-11` Nhật ký kiểm toán (/adm/adm-11); `ADM-19` Kho quy tắc quản trị (/adm/adm-19)

**Lời đọc**

> Mọi thay đổi cấu hình, ủy quyền hay hoãn cảnh báo đều ghi nhật ký kiểm toán. Quy tắc nằm trong kho có phiên bản, người lập khác người duyệt. AI chỉ hỗ trợ đọc, không quyết định thanh toán.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mọi thay đổi cấu hình, ủy quyền hay hoãn cảnh báo đều ghi nhật ký kiểm toán. Quy tắc nằm trong kho có phiên bản, người lập khác người duyệt. ây-ai chỉ hỗ trợ đọc, không quyết định thanh toán.

**Phụ đề**

- Mọi thay đổi cấu hình, ủy quyền hay / hoãn cảnh báo đều ghi nhật ký kiểm toán.
- Quy tắc nằm trong kho có phiên / bản, người lập khác người duyệt.
- AI chỉ hỗ trợ đọc, không / quyết định thanh toán.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=ADM-11`
- `do=spot ref=adm.audit-log.latest-rows`
- `do=open screen=ADM-19`

**Cần thấy trên hình**

- [ ] Màn ADM-11 "Nhật ký kiểm toán" mở được ở đường dẫn /adm/adm-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-19 "Kho quy tắc quản trị" mở được ở đường dẫn /adm/adm-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần adm.audit-log.latest-rows đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `close-outro`

Nền tảng: title; 14.5 giây; có trong video chính

**Lời đọc**

> Một nền tảng với ba kênh là web, ứng dụng di động và PWA, một bộ số liệu, mỗi con số có nguồn. Lãnh đạo thấy sớm, người làm đỡ chép số, kiểm toán dựng lại được từng quyết định.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Một nền tảng với ba kênh là quép, ứng dụng di động và pê-đắp-liu-a, một bộ số liệu, mỗi con số có nguồn. Lãnh đạo thấy sớm, người làm đỡ chép số, kiểm toán dựng lại được từng quyết định.

**Phụ đề**

- Một nền tảng với ba kênh là / web, ứng dụng di động và PWA,
- một bộ số liệu, mỗi con số có nguồn.
- Lãnh đạo thấy sớm, người làm đỡ chép số, / kiểm toán dựng lại được từng quyết định.

**Các bước quay**

- `do=animatic id=outro-public`

**Cần thấy trên hình**

- [ ] Thẻ tiêu đề outro-public có tên sản phẩm và dòng dữ liệu minh họa
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm
