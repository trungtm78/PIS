# Kịch bản sản xuất: Hệ thống quản lý đầu tư công

Tệp này được sinh từ dữ liệu kịch bản bằng `node scripts/clip-scripts-check.mjs book`. Không sửa tay: sửa tệp dữ liệu rồi sinh lại. Đoạn phim chỉ có tiếng Việt: lời đọc, phụ đề và chữ trên hình. Con số không được ghi ở đây, chúng được đọc từ dữ liệu thật lúc quay.

- Mã đoạn phim: `public-investment`
- Bản: public
- Video chính: 11:05 (48 cảnh)

Độ dài là ước tính theo số âm tiết; khi có âm thanh thật, độ dài đo được thay thế và cổng cuối là `scripts/clips/verify.mjs`.

## Các chương cắt riêng

| Chương | Số cảnh | Độ dài ước tính |
|---|---|---|
| Video chính (`main`) | 48 | 11:05 |
| Giới thiệu hệ thống (`intro`) | 5 | 1:14 |
| Tổng quan điều hành (`leader-home`) | 7 | 1:36 |
| Giải ngân và kế hoạch vốn (`disbursement`) | 7 | 1:35 |
| Quản lý hợp đồng (`contracts`) | 5 | 1:10 |
| Báo cáo phân tích và BI (`analytics`) | 9 | 2:18 |
| Cảnh báo (`alerts`) | 8 | 1:59 |
| Quản lý nhà thầu và nhà cung cấp (`contractors`) | 9 | 2:26 |
| Quản lý kết nối muasamcong (`egp`) | 11 | 2:54 |
| Ban chỉ đạo cấp tỉnh (`province-committee`) | 9 | 2:26 |
| Cây tiến độ (`process-tree`) | 9 | 2:09 |
| Ứng dụng điện thoại và PWA (`phone`) | 10 | 2:28 |
| Tin cậy và kết thúc (`close`) | 2 | 0:26 |

## Dữ liệu và độ sẵn sàng

Bộ dữ liệu: `public` (docs/clip-data.md)

| Nhóm dữ liệu | Bằng chứng |
|---|---|
| `base` | RUN_VERIFIED |
| `capital` | RUN_VERIFIED |
| `clip-public-documents` | RUN_VERIFIED |
| `clip-public-procurement` | RUN_VERIFIED |
| `clip-public-contracts` | WRITTEN_NOT_RUN |
| `clip-public-payments` | WRITTEN_NOT_RUN |
| `clip-public-workflow` | RUN_VERIFIED |
| `clip-public-alerts` | WRITTEN_NOT_RUN |
| `clip-public-egp` | RUN_VERIFIED |
| `clip-public-disbursement` | RUN_VERIFIED |
| `clip-public-feed` | WRITTEN_NOT_RUN |
| `clip-public-bi` | WRITTEN_NOT_RUN |
| `clip-public-directives` | WRITTEN_NOT_RUN |
| `clip-public-committee` | RUN_VERIFIED |

| Chương | Chương cần nhóm nào | Khoảng trống |
|---|---|---|
| `intro` | - | - |
| `leader-home` | `capital`, `clip-public-disbursement` | - |
| `disbursement` | `capital`, `clip-public-disbursement` | Chưa có seed cho nghiệm thu khối lượng, thanh toán và tạm ứng, nên các cảnh điều kiện thanh toán và tạm ứng cần dữ liệu bổ sung. |
| `contracts` | `clip-public-procurement`, `clip-public-contracts` | Chưa có seed cho nghiệm thu, thanh toán và tạm ứng của hợp đồng. |
| `analytics` | `capital`, `clip-public-procurement`, `clip-public-contracts` | Chưa nạp được gói chỉ tiêu BI vì chưa có đường HTTP lưu tệp gói chỉ tiêu: các cảnh dashboard BI cần dữ liệu bổ sung. |
| `alerts` | `clip-public-alerts`, `clip-public-disbursement` | - |
| `contractors` | `clip-public-procurement`, `clip-public-contracts` | - |
| `egp` | `clip-public-egp`, `clip-public-workflow` | - |
| `province-committee` | `clip-public-committee`, `clip-public-disbursement`, `clip-public-feed`, `clip-public-directives` | Không gian làm việc của Ban chỉ đạo đọc ảnh chụp kỳ đã chốt, chưa đọc bản ghi nguồn cấp; nguồn cấp được quay qua các chỉ số chất lượng, sai lệch và cảnh báo của chính nó. |
| `process-tree` | `clip-public-workflow`, `clip-public-procurement` | - |
| `phone` | `clip-public-procurement`, `clip-public-alerts`, `clip-public-contracts` | Cảnh điện thoại quay bằng máy ảo; màn Phê duyệt bị hệ điều hành chặn quay nên dùng hình dựng lại. |
| `close` | - | - |

**Cảnh có nhóm dữ liệu chưa chạy trọn:** `disbursement`, `contracts`, `analytics`, `alerts`, `contractors`, `province-committee`, `phone`

## Bảng nhạc nền

Chỉ dùng bản nhạc CC0, chờ chủ sở hữu duyệt. Máy trộn hiện dùng một tệp nhạc cho cả đoạn phim; mức nhạc theo chương là hướng dẫn cho chủ sở hữu và cho bản trộn sau.

| Bản nhạc | Giấy phép | Duyệt |
|---|---|---|
| track-1: Classical Pop (Instrumental) (Pro Sensory) * | CC0, https://opengameart.org/content/classical-pop-instrumental | PENDING_OWNER |
| track-2: Chill Beats Collection (Holizna) | CC0, https://opengameart.org/content/chill-beats-collection | PENDING_OWNER |
| track-3: Music for the background (ghi trên trang) | CC0, https://opengameart.org/content/music-for-the-background | PENDING_OWNER |

| Điểm nhạc | Chương | Bắt đầu | Mức so với nền | Tính chất |
|---|---|---|---|---|
| `pub-open` | `intro` | 0:00 | 0 dB | Vào dần trong hai giây, nhạc mở đầu trên thẻ tiêu đề và hoạt cảnh bài toán. |
| `pub-overview` | `leader-home`, `disbursement`, `contracts` | 1:14 | 0 dB | Phần điều hành, vốn và hợp đồng: nền ổn định. |
| `pub-numbers` | `analytics`, `alerts`, `contractors` | 3:10 | -3 dB | Lời đọc dày chỉ tiêu và thuật ngữ: nhạc lùi. |
| `pub-egp` | `egp`, `province-committee` | 5:57 | -3 dB | Hai chương nhiều quy trình và số liệu: nhạc lùi. |
| `pub-tree-phone` | `process-tree`, `phone` | 8:32 | 2 dB | Chương có nhiều chuyển động trên hình và trên điện thoại: nhạc nhỉnh lên. |
| `pub-close` | `close` | 10:39 | 0 dB | Kết thúc: nhạc tắt dần trong bốn giây sau thẻ cuối. |

## Giới thiệu hệ thống (`intro`)

### `intro-title`

Nền tảng: title; 13.3 giây; có trong video chính

**Lời đọc**

> Hệ thống quản lý đầu tư công, gồm nền tảng web và ứng dụng di động, theo dõi một khoản vốn từ kế hoạch đến quyết toán. Dữ liệu trong đoạn phim là dữ liệu minh họa cấp tỉnh.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hệ thống quản lý đầu tư công, gồm nền tảng quép và ứng dụng di động, theo dõi một khoản vốn từ kế hoạch đến quyết toán. Dữ liệu trong đoạn phim là dữ liệu minh họa cấp tỉnh.

**Phụ đề**

- Hệ thống quản lý đầu tư công, gồm / nền tảng web và ứng dụng di động,
- theo dõi một khoản vốn từ / kế hoạch đến quyết toán.
- Dữ liệu trong đoạn phim là / dữ liệu minh họa cấp tỉnh.

**Các bước quay**

- `do=animatic id=title-public`

**Cần thấy trên hình**

- [ ] Thẻ tiêu đề title-public có tên sản phẩm và dòng dữ liệu minh họa
- [ ] Chú thích "Dữ liệu minh họa" hiện từ giây 1, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Dữ liệu minh họa"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `intro-web-phone`

Nền tảng: animatic; 13.9 giây; có trong video chính

**Lời đọc**

> Hệ thống gồm hai phần dùng chung một nguồn số liệu và một bộ quyền. Nền tảng web chạy trên trình duyệt cho người điều hành. Ứng dụng di động chạy trên điện thoại cho người làm ở hiện trường.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hệ thống gồm hai phần dùng chung một nguồn số liệu và một bộ quyền. Nền tảng quép chạy trên trình duyệt cho người điều hành. Ứng dụng di động chạy trên điện thoại cho người làm ở hiện trường.

**Phụ đề**

- Hệ thống gồm hai phần dùng chung / một nguồn số liệu và một bộ quyền.
- Nền tảng web chạy trên trình / duyệt cho người điều hành.
- Ứng dụng di động chạy trên điện / thoại cho người làm ở hiện trường.

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

Nền tảng: web; 12.7 giây; có trong video chính

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

Nền tảng: web; 10.5 giây; có trong video chính

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

Nền tảng: web; 16 giây; có trong video chính

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

- `do=as persona=projectManager`
- `do=open screen=PRJ-27`
- `do=spot ref=prj.evm.s-curve`
- `do=click ref=prj.evm.view-at-date`

**Cần thấy trên hình**

- [ ] Màn PRJ-27 "Giá trị thu được (EVM) và đường S" mở được ở đường dẫn /prj/prj-27, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-26 "Đường cơ sở, độ lệch và số lần dời mốc" mở được ở đường dẫn /prj/prj-26, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần prj.evm.s-curve đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.evm.view-at-date đúng lúc giọng đọc nói tới
- [ ] Chú thích "Giá trị thu được chỉ từ khối lượng đã nghiệm thu" hiện từ giây 1.5, kéo dài 5 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ana-bi-dashboard`

Nền tảng: web; 12.1 giây; có trong video chính

Màn hình: `BI-02` Dashboard của tôi (/bi/bi-02); `BI-04` Trình dựng biểu đồ (/bi/bi-04)

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
- `do=open screen=BI-02`
- `do=click ref=bi.dashboard.open-chart-builder`
- `do=choose ref=bi.chart-builder.dataset option=first`
- `do=click ref=bi.chart-builder.save`

**Cần thấy trên hình**

- [ ] Màn BI-02 "Dashboard của tôi" mở được ở đường dẫn /bi/bi-02, có dữ liệu thật, không báo trống hay lỗi
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

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-30`
- `do=spot ref=ctr.price-gap.table`
- `do=click ref=ctr.price-gap.sort-by-gap`

**Cần thấy trên hình**

- [ ] Màn CTR-30 "Chênh lệch giá trúng thầu và giá hợp đồng" mở được ở đường dẫn /ctr/ctr-30, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
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

- `do=as persona=dgvSteward`
- `do=open screen=BI-18`
- `do=spot ref=bi.datasets.state-column`
- `do=click ref=bi.datasets.certify-button`

**Cần thấy trên hình**

- [ ] Màn BI-18 "Bộ dữ liệu và ảnh chụp kỳ" mở được ở đường dẫn /bi/bi-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-19 "Chứng nhận chỉ tiêu và bộ dữ liệu" mở được ở đường dẫn /bi/bi-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản dgvSteward
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

- `do=as persona=dgvSteward`
- `do=open screen=BI-12`
- `do=click ref=bi.schedule.new`
- `do=spot ref=bi.schedule.recipients-scope`

**Cần thấy trên hình**

- [ ] Màn BI-12 "Lịch xuất và phân phối" mở được ở đường dẫn /bi/bi-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-16 "Xuất dữ liệu và phạm vi" mở được ở đường dẫn /bi/bi-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản dgvSteward
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

- `do=as persona=dgvSteward`
- `do=open screen=BI-11`
- `do=click ref=bi.publication.compare-versions`

**Cần thấy trên hình**

- [ ] Màn BI-11 "Phê duyệt công bố" mở được ở đường dẫn /bi/bi-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BI-10 "So sánh phiên bản dashboard" mở được ở đường dẫn /bi/bi-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản dgvSteward
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

- `do=as persona=owner`
- `do=open screen=HOME-01`
- `do=click ref=shell.alert-bell`
- `do=spot ref=alerts.drawer.consequence-line`

**Cần thấy trên hình**

- [ ] Màn HOME-01 "Tổng quan điều hành" mở được ở đường dẫn /home/home-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn HOME-02 "Việc của tôi" mở được ở đường dẫn /home/home-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần shell.alert-bell đúng lúc giọng đọc nói tới
- [ ] Khung vào phần alerts.drawer.consequence-line đúng lúc giọng đọc nói tới
- [ ] Chú thích "Khẩn · Cần xử lý · Theo dõi" hiện từ giây 2, kéo dài 5 giây
- [ ] Con số alerts-urgent đọc từ dữ liệu thật qua getMyWorkCounts (counts.urgent); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số alerts-action đọc từ dữ liệu thật qua getMyWorkCounts (counts.action); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số alerts-watch đọc từ dữ liệu thật qua getMyWorkCounts (counts.watch); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-actions`

Nền tảng: web; 13.7 giây; có trong video chính

Màn hình: `HOME-02` Việc của tôi (/home/home-02); `HOME-12` Việc đang bị hoãn (/home/home-12)

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
- [ ] Màn HOME-12 "Việc đang bị hoãn" mở được ở đường dẫn /home/home-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần alerts.item.claim đúng lúc giọng đọc nói tới
- [ ] Khung vào phần alerts.item.snooze đúng lúc giọng đọc nói tới
- [ ] Chạy thao tác thật snoozeWork bằng tài khoản projectManager
- [ ] Chú thích "Hoãn phải có lý do và có trần" hiện từ giây 3, kéo dài 5 giây
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `al-escalation`

Nền tảng: web; 12.1 giây; có trong video chính

Màn hình: `ADM-04` Ủy quyền có thời hạn (/adm/adm-04); `HOME-06` Hồ sơ cảnh báo (/home/home-06)

**Lời đọc**

> Cảnh báo không bao giờ mồ côi. Người nhận im lặng quá hạn thì việc tự leo lên cấp trên. Người đi vắng ủy quyền, và hệ thống kiểm tra độ phủ ủy quyền.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cảnh báo không bao giờ mồ côi. Người nhận im lặng quá hạn thì việc tự leo lên cấp trên. Người đi vắng ủy quyền, và hệ thống kiểm tra độ phủ ủy quyền.

**Phụ đề**

- Cảnh báo không bao giờ mồ côi.
- Người nhận im lặng quá hạn / thì việc tự leo lên cấp trên.
- Người đi vắng ủy quyền, và hệ / thống kiểm tra độ phủ ủy quyền.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=ADM-04`
- `do=spot ref=adm.delegation.coverage-check`
- `do=open screen=HOME-06`
- `do=spot ref=alerts.record.escalation-trail`

**Cần thấy trên hình**

- [ ] Màn ADM-04 "Ủy quyền có thời hạn" mở được ở đường dẫn /adm/adm-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn HOME-06 "Hồ sơ cảnh báo" mở được ở đường dẫn /home/home-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần adm.delegation.coverage-check đúng lúc giọng đọc nói tới
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

- `do=as persona=bidManager`
- `do=open screen=BID-01`
- `do=click ref=bid.contractors.first-row`
- `do=spot ref=bid.contractor.master-profile`
- `do=open screen=VND-04`
- `do=spot ref=vnd.bank-accounts.two-approvers`

**Cần thấy trên hình**

- [ ] Màn BID-01 "Danh sách nhà thầu" mở được ở đường dẫn /bid/bid-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-02 "Hồ sơ nhà thầu" mở được ở đường dẫn /bid/bid-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-04 "Tài khoản nhận tiền của nhà thầu" mở được ở đường dẫn /vnd/vnd-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
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

- `do=as persona=bidManager`
- `do=open screen=BID-21`
- `do=click ref=bid.restrictions.new`
- `do=type ref=bid.restrictions.reason textKey=restriction.reason`
- `do=command operation=recordContractorRestriction as=bidManager`

**Cần thấy trên hình**

- [ ] Màn BID-21 "Hạn chế tham gia lựa chọn nhà thầu" mở được ở đường dẫn /bid/bid-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
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

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-23`
- `do=click ref=ctr.scorecard.new-evaluation`
- `do=command operation=evaluateContractor as=ctrOfficer`
- `do=as persona=paymentApprover`
- `do=command operation=approveContractorEvaluation as=paymentApprover`

**Cần thấy trên hình**

- [ ] Màn CTR-23 "Bảng điểm nhà thầu và nhật ký vi phạm" mở được ở đường dẫn /ctr/ctr-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
- [ ] Khung vào phần ctr.scorecard.new-evaluation đúng lúc giọng đọc nói tới
- [ ] Chạy thao tác thật evaluateContractor bằng tài khoản ctrOfficer
- [ ] Đăng nhập bằng tài khoản paymentApprover
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

- `do=as persona=bidManager`
- `do=open screen=BID-22`
- `do=spot ref=bid.egp.connection-card`

**Cần thấy trên hình**

- [ ] Màn BID-22 "Kết nối hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn BID-24 "Các lần nhập tệp từ hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản bidManager
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

- `do=as persona=ctrOfficer`
- `do=open screen=VND-10`
- `do=spot ref=vnd.subcontracts.paid-confirmation`

**Cần thấy trên hình**

- [ ] Màn VND-10 "Nhà thầu phụ của hợp đồng" mở được ở đường dẫn /vnd/vnd-10, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CTR-25 "Thành viên liên danh và phạm vi" mở được ở đường dẫn /ctr/ctr-25, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
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

- `do=as persona=ctrOfficer`
- `do=open screen=CTR-05`
- `do=spot ref=ctr.guarantees.expiry-column`

**Cần thấy trên hình**

- [ ] Màn CTR-05 "Bảo lãnh và bảo hiểm" mở được ở đường dẫn /ctr/ctr-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn VND-08 "Tài chính và tải của nhà thầu" mở được ở đường dẫn /vnd/vnd-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản ctrOfficer
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

- `do=as persona=auditor`
- `do=open screen=BID-33`
- `do=click ref=bid.egp.recon.first-item`
- `do=choose ref=bid.egp.recon.resolution option=first`

**Cần thấy trên hình**

- [ ] Màn BID-33 "Đối chiếu từng trường với hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-33, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản auditor
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

- `do=as persona=docHead`
- `do=open screen=BAN-06`
- `do=spot ref=ban.roster.members`

**Cần thấy trên hình**

- [ ] Màn BAN-06 "Danh sách Ban chỉ đạo và vị trí" mở được ở đường dẫn /ban/ban-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản docHead
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

- `do=as persona=docHead`
- `do=open screen=BAN-01`
- `do=spot ref=ban.dashboard.context-bar`
- `do=spot ref=ban.dashboard.by-sector`
- `do=spot ref=ban.dashboard.forecast-band`

**Cần thấy trên hình**

- [ ] Màn BAN-01 "Bảng điều hành Ban chỉ đạo" mở được ở đường dẫn /ban/ban-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản docHead
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

- `do=open screen=BAN-02`
- `do=spot ref=ban.attention.first-row`
- `do=spot ref=ban.attention.decision`

**Cần thấy trên hình**

- [ ] Màn BAN-02 "Dự án cần Trưởng ban quan tâm" mở được ở đường dẫn /ban/ban-02, có dữ liệu thật, không báo trống hay lỗi
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

- `do=open screen=BAN-04`
- `do=spot ref=ban.tracker.units`
- `do=click ref=ban.tracker.first-overdue`

**Cần thấy trên hình**

- [ ] Màn BAN-04 "Theo dõi chỉ đạo của Ban chỉ đạo" mở được ở đường dẫn /ban/ban-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIR-04 "Chi tiết chỉ đạo, dòng thời gian, gia hạn và đóng" mở được ở đường dẫn /dir/dir-04, có dữ liệu thật, không báo trống hay lỗi
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

- `do=open screen=BAN-05`
- `do=spot ref=ban.alerts.first-row`
- `do=spot ref=ban.alerts.acknowledge`

**Cần thấy trên hình**

- [ ] Màn BAN-05 "Cảnh báo của Ban chỉ đạo" mở được ở đường dẫn /ban/ban-05, có dữ liệu thật, không báo trống hay lỗi
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

- `do=as persona=unitAdmin`
- `do=open screen=BAN-03`
- `do=spot ref=ban.pack.roles`

**Cần thấy trên hình**

- [ ] Màn BAN-03 "Hồ sơ họp Ban chỉ đạo" mở được ở đường dẫn /ban/ban-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
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

- `do=as persona=auditor`
- `do=open screen=BAN-07`
- `do=spot ref=ban.audit.latest`

**Cần thấy trên hình**

- [ ] Màn BAN-07 "Nhật ký xem màn hình nhạy cảm của Ban chỉ đạo" mở được ở đường dẫn /ban/ban-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản auditor
- [ ] Khung vào phần ban.audit.latest đúng lúc giọng đọc nói tới
- [ ] Mỗi dòng nhật ký có người xem, vị trí, màn hình, bộ lọc, ngày số liệu và mức xác thực
- [ ] Nhật ký có lần xem của Trưởng ban vừa quay ở các cảnh trước
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

Nền tảng: phone; 14.5 giây; có trong video chính

Màn hình: `MOB-23` Danh sách phê duyệt (tab approval); `MOB-24` Chi tiết phê duyệt (tab approval); `MOB-25` Xác nhận phê duyệt và ký (tab approval)

**Lời đọc**

> Lãnh đạo duyệt ngay trên điện thoại: xem hồ sơ, duyệt hoặc trả lại kèm lý do, xác thực lần hai rồi ký. Hiện có {{figure:phone-approvals-waiting}} việc chờ. Màn xác nhận bị hệ điều hành chặn quay nên dùng hình dựng lại.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Lãnh đạo duyệt ngay trên điện thoại: xem hồ sơ, duyệt hoặc trả lại kèm lý do, xác thực lần hai rồi ký. Hiện có {{figure:phone-approvals-waiting}} việc chờ. Màn xác nhận bị hệ điều hành chặn quay nên dùng hình dựng lại.

**Phụ đề**

- Lãnh đạo duyệt ngay trên / điện thoại: xem hồ sơ,
- duyệt hoặc trả lại kèm lý / do, xác thực lần hai rồi ký.
- Hiện có {n} việc chờ.
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
- [ ] Con số phone-approvals-waiting đọc từ dữ liệu thật qua get_resources_approval_task (items.length); không gõ tay, thiếu giá trị thì dừng quay
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

Nền tảng: pwa; 14.5 giây; có trong video chính

Màn hình: `PWA-01` PWA-01 (/m); `PWA-02` PWA-02 (/m/approvals); `PWA-03` PWA-03 (/m/dashboard); `PWA-04` PWA-04 (/m/directives)

**Lời đọc**

> Người không cài ứng dụng dùng PWA trên trình duyệt: hàng đợi phê duyệt, dashboard điều hành, theo dõi chỉ đạo. PWA chỉ lưu vỏ ứng dụng, không lưu dữ liệu, đăng xuất là xóa sạch.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Người không cài ứng dụng dùng pê-đắp-liu-a trên trình duyệt: hàng đợi phê duyệt, đát-bo điều hành, theo dõi chỉ đạo. pê-đắp-liu-a chỉ lưu vỏ ứng dụng, không lưu dữ liệu, đăng xuất là xóa sạch.

**Phụ đề**

- Người không cài ứng dụng / dùng PWA trên trình duyệt:
- hàng đợi phê duyệt, dashboard / điều hành, theo dõi chỉ đạo.
- PWA chỉ lưu vỏ ứng dụng, không lưu / dữ liệu, đăng xuất là xóa sạch.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=PWA-01`
- `do=open screen=PWA-02`
- `do=open screen=PWA-03`
- `do=open screen=PWA-04`

**Cần thấy trên hình**

- [ ] Màn PWA-01 của ứng dụng cài đặt (PWA) mở ở đường dẫn /m, trong khung điện thoại
- [ ] Màn PWA-02 của ứng dụng cài đặt (PWA) mở ở đường dẫn /m/approvals, trong khung điện thoại
- [ ] Màn PWA-03 của ứng dụng cài đặt (PWA) mở ở đường dẫn /m/dashboard, trong khung điện thoại
- [ ] Màn PWA-04 của ứng dụng cài đặt (PWA) mở ở đường dẫn /m/directives, trong khung điện thoại
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Chú thích "PWA: chỉ lưu vỏ ứng dụng, không lưu dữ liệu" hiện từ giây 4, kéo dài 6 giây
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

Nền tảng: title; 12.1 giây; có trong video chính

**Lời đọc**

> Một nền tảng web và ứng dụng di động, một bộ số liệu, mỗi con số có nguồn. Lãnh đạo thấy sớm, người làm đỡ chép số, kiểm toán dựng lại được từng quyết định.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Một nền tảng quép và ứng dụng di động, một bộ số liệu, mỗi con số có nguồn. Lãnh đạo thấy sớm, người làm đỡ chép số, kiểm toán dựng lại được từng quyết định.

**Phụ đề**

- Một nền tảng web và ứng dụng di động, / một bộ số liệu, mỗi con số có nguồn.
- Lãnh đạo thấy sớm, người làm đỡ chép số, / kiểm toán dựng lại được từng quyết định.

**Các bước quay**

- `do=animatic id=outro-public`

**Cần thấy trên hình**

- [ ] Thẻ tiêu đề outro-public có tên sản phẩm và dòng dữ liệu minh họa
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm
