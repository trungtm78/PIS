# Kịch bản sản xuất: Phần mềm quản lý đầu tư xây dựng

Tệp này được sinh từ dữ liệu kịch bản bằng `node scripts/clip-scripts-check.mjs book`. Không sửa tay: sửa tệp dữ liệu rồi sinh lại. Đoạn phim chỉ có tiếng Việt: lời đọc, phụ đề và chữ trên hình. Con số không được ghi ở đây, chúng được đọc từ dữ liệu thật lúc quay.

- Mã đoạn phim: `enterprise-phu-my`
- Bản: enterprise
- Video chính: 10:46 (44 cảnh)

Độ dài là ước tính theo số âm tiết; khi có âm thanh thật, độ dài đo được thay thế và cổng cuối là `scripts/clips/verify.mjs`.

## Các chương cắt riêng

| Chương | Số cảnh | Độ dài ước tính |
|---|---|---|
| Video chính (`main`) | 44 | 10:46 |
| Giới thiệu phần mềm (`intro`) | 4 | 1:07 |
| Tổng quan điều hành (`leader-home`) | 7 | 1:29 |
| Cơ cấu vốn và kế hoạch (`capital`) | 4 | 1:07 |
| Dự án đầu tư xây dựng (`projects`) | 5 | 1:15 |
| Báo cáo gửi Tập đoàn (`reports-pvn`) | 6 | 1:41 |
| Quy trình duyệt số liệu kỳ (`workflow`) | 4 | 1:01 |
| Đẩy số HPM và đối chiếu kế toán (`hpm-ebs`) | 5 | 1:26 |
| Chỉ đạo giao ban (`directives`) | 4 | 0:56 |
| Hồ sơ dự án và trợ lý AI (`docs-ai`) | 4 | 1:05 |
| Báo cáo phân tích và BI (`analytics`) | 9 | 2:18 |
| Cảnh báo (`alerts`) | 8 | 1:59 |
| Quản lý nhà thầu và nhà cung cấp (`contractors`) | 9 | 2:26 |
| Cây tiến độ (`process-tree`) | 9 | 2:09 |
| Ứng dụng điện thoại và PWA (`phone`) | 10 | 2:28 |
| Tin cậy và kết thúc (`close`) | 2 | 0:32 |

## Dữ liệu và độ sẵn sàng

Bộ dữ liệu: `enterprise` (docs/clip-data.md)

| Nhóm dữ liệu | Bằng chứng |
|---|---|
| `clip-ent-projects` | RUN_VERIFIED |
| `clip-ent-funding` | RUN_VERIFIED |
| `clip-ent-directives` | RUN_VERIFIED |
| `clip-ent-ebs` | RUN_VERIFIED |
| `clip-ent-reports` | WRITTEN_NOT_RUN |

| Chương | Chương cần nhóm nào | Khoảng trống |
|---|---|---|
| `intro` | - | - |
| `leader-home` | `clip-ent-projects`, `clip-ent-funding` | - |
| `capital` | `clip-ent-funding` | - |
| `projects` | `clip-ent-projects` | - |
| `reports-pvn` | `clip-ent-reports` | Sáu biểu mẫu là bản demo do hệ thống tự thiết kế, đóng dấu MẪU DEMO — chờ mẫu chính thức. |
| `workflow` | `clip-ent-reports` | - |
| `hpm-ebs` | `clip-ent-reports`, `clip-ent-ebs` | Bản demo không bao giờ được HPM chấp nhận: nhật ký đẩy có một lần ghi tệp và một lần bị từ chối kèm lý do. |
| `directives` | `clip-ent-directives` | - |
| `docs-ai` | - | Bộ dữ liệu doanh nghiệp chưa có nhóm cho kho hồ sơ dự án và trợ lý AI: cần nhóm bổ sung hoặc quay trên kho đã có. |
| `analytics` | `clip-ent-projects`, `clip-ent-funding` | Chưa nạp được gói chỉ tiêu BI; các chương dùng chung cần số liệu đủ dày trên bộ dữ liệu doanh nghiệp. |
| `alerts` | - | Bộ dữ liệu doanh nghiệp không có nhóm luật và cảnh báo; chạy các nhóm cảnh báo của bộ công khai trên bản doanh nghiệp hoặc quay chương dùng chung trên bộ công khai. |
| `contractors` | - | Bộ dữ liệu doanh nghiệp không có nhóm nhà thầu; cần nhóm bổ sung hoặc dùng cảnh quay chung. |
| `process-tree` | - | Bộ dữ liệu doanh nghiệp không có nhóm quy trình gói thầu; cần chạy nhóm quy trình trên bản doanh nghiệp hoặc dùng cảnh quay chung. |
| `phone` | `clip-ent-projects`, `clip-ent-directives` | Ứng dụng cài đặt (PWA) cho lãnh đạo đọc tổng quan, hàng chờ duyệt và chỉ đạo của cùng bộ dữ liệu. |
| `close` | - | - |

**Cảnh có nhóm dữ liệu chưa chạy trọn:** `reports-pvn`, `workflow`, `hpm-ebs`, `docs-ai`, `analytics`, `alerts`, `contractors`, `process-tree`, `phone`

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
| `ent-open` | `intro` | 0:00 | 0 dB | Vào dần trong hai giây, nhạc mở đầu trên thẻ tiêu đề và hoạt cảnh bài toán. |
| `ent-overview` | `leader-home`, `capital`, `projects` | 1:07 | 0 dB | Phần điều hành, cơ cấu vốn và dự án: nền ổn định. |
| `ent-reports` | `reports-pvn`, `workflow`, `hpm-ebs`, `directives` | 2:30 | -3 dB | Biểu mẫu báo cáo, luồng kỳ, đẩy HPM và đối chiếu kế toán: nhạc lùi. |
| `ent-docs` | `docs-ai`, `analytics`, `alerts`, `contractors` | 4:43 | -3 dB | Kho hồ sơ, trợ lý, phân tích, cảnh báo và nhà thầu: nhạc lùi. |
| `ent-tree-phone` | `process-tree`, `phone` | 8:07 | 2 dB | Chương có nhiều chuyển động trên hình và trên điện thoại: nhạc nhỉnh lên. |
| `ent-close` | `close` | 10:15 | 0 dB | Kết thúc: nhạc tắt dần trong bốn giây sau thẻ cuối. |

## Giới thiệu phần mềm (`intro`)

### `ent-intro-title`

Nền tảng: title; 19.1 giây; có trong video chính

**Lời đọc**

> Phần mềm quản lý đầu tư xây dựng của Đạm Phú Mỹ gồm nền tảng web và ứng dụng di động. Phần mềm theo dõi dự án từ kế hoạch vốn đến báo cáo gửi Tập đoàn. Dữ liệu trong đoạn phim là minh họa, và sáu biểu mẫu là mẫu demo, chờ mẫu chính thức.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Phần mềm quản lý đầu tư xây dựng của Đạm Phú Mỹ gồm nền tảng quép và ứng dụng di động. Phần mềm theo dõi dự án từ kế hoạch vốn đến báo cáo gửi Tập đoàn. Dữ liệu trong đoạn phim là minh họa, và sáu biểu mẫu là mẫu đê-mô, chờ mẫu chính thức.

**Phụ đề**

- Phần mềm quản lý đầu / tư xây dựng của Đạm Phú
- Mỹ gồm nền tảng web và ứng dụng di động.
- Phần mềm theo dõi dự án từ kế / hoạch vốn đến báo cáo gửi Tập đoàn.
- Dữ liệu trong đoạn phim là minh họa,
- và sáu biểu mẫu là mẫu / demo, chờ mẫu chính thức.

**Các bước quay**

- `do=animatic id=title-enterprise`

**Cần thấy trên hình**

- [ ] Thẻ tiêu đề title-enterprise có tên sản phẩm và dòng dữ liệu minh họa
- [ ] Chú thích "Dữ liệu minh họa" hiện từ giây 1, kéo dài 5 giây
- [ ] Chú thích "MẪU DEMO — chờ mẫu chính thức" hiện từ giây 6, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Dữ liệu minh họa"
- [ ] Dấu bắt buộc hiện rõ trên hình: "MẪU DEMO — chờ mẫu chính thức"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-intro-web-phone`

Nền tảng: animatic; 13.9 giây; có trong video chính

**Lời đọc**

> Phần mềm gồm hai phần dùng chung một nguồn số liệu và một bộ quyền. Nền tảng web chạy trên trình duyệt cho người điều hành. Ứng dụng di động chạy trên điện thoại cho người làm ở hiện trường.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Phần mềm gồm hai phần dùng chung một nguồn số liệu và một bộ quyền. Nền tảng quép chạy trên trình duyệt cho người điều hành. Ứng dụng di động chạy trên điện thoại cho người làm ở hiện trường.

**Phụ đề**

- Phần mềm gồm hai phần dùng chung / một nguồn số liệu và một bộ quyền.
- Nền tảng web chạy trên trình / duyệt cho người điều hành.
- Ứng dụng di động chạy trên điện / thoại cho người làm ở hiện trường.

**Các bước quay**

- `do=animatic id=platform-enterprise`

**Cần thấy trên hình**

- [ ] Hoạt cảnh platform-enterprise chạy hết thời lượng của lời đọc, chữ trên hình là tiếng Việt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-intro-problem`

Nền tảng: animatic; 18.1 giây; có trong video chính

**Lời đọc**

> Tổng công ty phải báo cáo tháng, quý cho Tập đoàn, đẩy số sang HPM và đối chiếu với kế toán Oracle EBS. Số liệu nằm ở nhiều bảng tính, vốn chủ sở hữu và vốn vay mỗi nơi tính một kiểu, báo cáo mất nhiều ngày để ghép.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Tổng công ty phải báo cáo tháng, quý cho Tập đoàn, đẩy số sang hát-pê-em và đối chiếu với kế toán ô-ra-cồ i-bi-ét. Số liệu nằm ở nhiều bảng tính, vốn chủ sở hữu và vốn vay mỗi nơi tính một kiểu, báo cáo mất nhiều ngày để ghép.

**Phụ đề**

- Tổng công ty phải báo cáo / tháng, quý cho Tập đoàn,
- đẩy số sang HPM và đối chiếu / với kế toán Oracle EBS.
- Số liệu nằm ở nhiều bảng tính, / vốn chủ sở hữu và vốn vay
- mỗi nơi tính một kiểu, báo / cáo mất nhiều ngày để ghép.

**Các bước quay**

- `do=animatic id=problem-enterprise`

**Cần thấy trên hình**

- [ ] Hoạt cảnh problem-enterprise chạy hết thời lượng của lời đọc, chữ trên hình là tiếng Việt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-intro-platform`

Nền tảng: animatic; 16.3 giây; có trong video chính

**Lời đọc**

> Đây là bản doanh nghiệp của cùng một nền tảng, riêng từ tên gọi, menu đến cơ cấu vốn và biểu mẫu. Nó nối với HPM, kế toán Oracle EBS, Lakehouse, Power BI và giao diện mở API.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Đây là bản doanh nghiệp của cùng một nền tảng, riêng từ tên gọi, mê-nu đến cơ cấu vốn và biểu mẫu. Nó nối với hát-pê-em, kế toán ô-ra-cồ i-bi-ét, lếch-hao, pao bi-ai và giao diện mở ây-pi-ai.

**Phụ đề**

- Đây là bản doanh nghiệp / của cùng một nền tảng,
- riêng từ tên gọi, menu đến / cơ cấu vốn và biểu mẫu.
- Nó nối với HPM, kế toán Oracle EBS,
- Lakehouse, Power BI và giao diện mở API.

**Các bước quay**

- `do=animatic id=platform-enterprise`

**Cần thấy trên hình**

- [ ] Hoạt cảnh platform-enterprise chạy hết thời lượng của lời đọc, chữ trên hình là tiếng Việt
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Tổng quan điều hành (`leader-home`)

### `ent-home`

Nền tảng: web; 13.5 giây; có trong video chính

Màn hình: `HOME-09` Trung tâm điều hành giải ngân (/home/home-09); `HOME-01` Tổng quan điều hành (/home/home-01)

**Lời đọc**

> Trang điều hành của Tổng công ty cho thấy tổng mức đầu tư {{figure:ent-total-investment}}, kế hoạch vốn năm {{figure:ent-plan-year}}, trên {{figure:ent-projects-total}} dự án.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trang điều hành của Tổng công ty cho thấy tổng mức đầu tư {{figure:ent-total-investment}}, kế hoạch vốn năm {{figure:ent-plan-year}}, trên {{figure:ent-projects-total}} dự án.

**Phụ đề**

- Trang điều hành của Tổng công
- ty cho thấy tổng mức
- đầu tư {n}, kế hoạch vốn / năm {n}, trên {n} dự án.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=HOME-09`
- `do=spot ref=home.context-bar`
- `do=spot ref=ent.home.kpi-strip`

**Cần thấy trên hình**

- [ ] Màn HOME-09 "Trung tâm điều hành giải ngân" mở được ở đường dẫn /home/home-09, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn HOME-01 "Tổng quan điều hành" mở được ở đường dẫn /home/home-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần home.context-bar đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ent.home.kpi-strip đúng lúc giọng đọc nói tới
- [ ] Chú thích "Dữ liệu minh họa" hiện từ giây 1, kéo dài 5 giây
- [ ] Con số ent-total-investment đọc từ dữ liệu thật qua getKpiRegister (kpis[code=ENT_TOTAL_INVESTMENT].value); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số ent-plan-year đọc từ dữ liệu thật qua getKpiRegister (kpis[code=ENT_PLAN_IN_FORCE].value); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số ent-projects-total đọc từ dữ liệu thật qua getKpiRegister (kpis[code=ENT_PROJECTS_TOTAL].value); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `home-drill`

Nền tảng: web; 11.5 giây; chỉ trong chương cắt riêng

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

## Cơ cấu vốn và kế hoạch (`capital`)

### `ent-capital`

Nền tảng: web; 18.5 giây; có trong video chính

Màn hình: `HOME-07` Cơ cấu các nguồn vốn (/home/home-07)

**Lời đọc**

> Vốn chia theo cơ cấu doanh nghiệp: vốn chủ sở hữu {{figure:ent-share-equity}}, vốn vay {{figure:ent-share-debt}} và vốn khác. Kế hoạch có bản giao đầu năm và bản hiện hành, chia theo quý và tháng. Số ước được thay bằng số thực khi có.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Vốn chia theo cơ cấu doanh nghiệp: vốn chủ sở hữu {{figure:ent-share-equity}}, vốn vay {{figure:ent-share-debt}} và vốn khác. Kế hoạch có bản giao đầu năm và bản hiện hành, chia theo quý và tháng. Số ước được thay bằng số thực khi có.

**Phụ đề**

- Vốn chia theo cơ cấu doanh nghiệp: vốn chủ
- sở hữu {n}, vốn vay {n} và vốn khác.
- Kế hoạch có bản giao đầu năm và
- bản hiện hành, chia theo quý và tháng.
- Số ước được thay bằng số thực khi có.

**Các bước quay**

- `do=open screen=HOME-07`
- `do=spot ref=ent.capital.structure-bar`
- `do=open screen=HOME-07`
- `do=spot ref=ent.capital.estimate-to-actual`

**Cần thấy trên hình**

- [ ] Màn HOME-07 "Cơ cấu các nguồn vốn" mở được ở đường dẫn /home/home-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần ent.capital.structure-bar đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ent.capital.estimate-to-actual đúng lúc giọng đọc nói tới
- [ ] Con số ent-share-equity đọc từ dữ liệu thật qua getKpiRegister (kpis[code=ENT_SHARE_EQUITY].value); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Con số ent-share-debt đọc từ dữ liệu thật qua getKpiRegister (kpis[code=ENT_SHARE_DEBT].value); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Vốn chủ sở hữu và vốn vay hiện cạnh nhau, tổng bằng kế hoạch năm
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-plan-versions`

Nền tảng: web; 17 giây; chỉ trong chương cắt riêng

Màn hình: `CAP-03` Kế hoạch năm (/cap/cap-03); `CAP-07` Điều chỉnh và điều chuyển (/cap/cap-07)

**Lời đọc**

> Mỗi năm có kế hoạch giao đầu năm, các bản điều chỉnh và bản đang hiệu lực. Bản nào cũng giữ người lập, người duyệt và lý do. Số lũy kế tính cả từ đầu năm lẫn từ khi khởi công, và không bao giờ vượt tổng mức đầu tư.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi năm có kế hoạch giao đầu năm, các bản điều chỉnh và bản đang hiệu lực. Bản nào cũng giữ người lập, người duyệt và lý do. Số lũy kế tính cả từ đầu năm lẫn từ khi khởi công, và không bao giờ vượt tổng mức đầu tư.

**Phụ đề**

- Mỗi năm có kế hoạch giao đầu năm, các / bản điều chỉnh và bản đang hiệu lực.
- Bản nào cũng giữ người / lập, người duyệt và lý do.
- Số lũy kế tính cả từ đầu / năm lẫn từ khi khởi công,
- và không bao giờ vượt tổng mức đầu tư.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=CAP-07`
- `do=spot ref=cap.versions.compare`

**Cần thấy trên hình**

- [ ] Màn CAP-03 "Kế hoạch năm" mở được ở đường dẫn /cap/cap-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-07 "Điều chỉnh và điều chuyển" mở được ở đường dẫn /cap/cap-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần cap.versions.compare đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-estimate-actual`

Nền tảng: web; 16 giây; chỉ trong chương cắt riêng

Màn hình: `CAP-12` Kế hoạch ước giải ngân (/cap/cap-12); `CAP-13` Nhập ước giải ngân (/cap/cap-13)

**Lời đọc**

> Số ước của kỳ được ghi trước, khi số thực về thì thay vào và giữ lại lịch sử chuyển đổi. Số kế toán và số báo cáo có thứ tự ưu tiên ghi trong quy tắc, và mọi con số trên biểu mẫu truy được về nguồn.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Số ước của kỳ được ghi trước, khi số thực về thì thay vào và giữ lại lịch sử chuyển đổi. Số kế toán và số báo cáo có thứ tự ưu tiên ghi trong quy tắc, và mọi con số trên biểu mẫu truy được về nguồn.

**Phụ đề**

- Số ước của kỳ được ghi / trước, khi số thực về
- thì thay vào và giữ / lại lịch sử chuyển đổi.
- Số kế toán và số báo cáo có thứ / tự ưu tiên ghi trong quy tắc,
- và mọi con số trên biểu / mẫu truy được về nguồn.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=CAP-12`
- `do=spot ref=cap.estimates.conversion-history`

**Cần thấy trên hình**

- [ ] Màn CAP-12 "Kế hoạch ước giải ngân" mở được ở đường dẫn /cap/cap-12, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn CAP-13 "Nhập ước giải ngân" mở được ở đường dẫn /cap/cap-13, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần cap.estimates.conversion-history đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-funding-pack`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `ADM-19` Kho quy tắc quản trị (/adm/adm-19); `ADM-20` Chi tiết loại quy tắc quản trị (/adm/adm-20)

**Lời đọc**

> Cơ cấu vốn là một quy tắc có phiên bản. Gói của đầu tư công giữ nguyên nguồn hiện có, gói doanh nghiệp là vốn chủ sở hữu, vốn vay và khác. Đổi sang gói khác không làm đổi một con số nào của bản công.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cơ cấu vốn là một quy tắc có phiên bản. Gói của đầu tư công giữ nguyên nguồn hiện có, gói doanh nghiệp là vốn chủ sở hữu, vốn vay và khác. Đổi sang gói khác không làm đổi một con số nào của bản công.

**Phụ đề**

- Cơ cấu vốn là một quy tắc có phiên bản.
- Gói của đầu tư công giữ / nguyên nguồn hiện có,
- gói doanh nghiệp là vốn chủ / sở hữu, vốn vay và khác.
- Đổi sang gói khác không làm đổi / một con số nào của bản công.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=ADM-20`
- `do=spot ref=adm.rules.funding-taxonomy`

**Cần thấy trên hình**

- [ ] Màn ADM-19 "Kho quy tắc quản trị" mở được ở đường dẫn /adm/adm-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-20 "Chi tiết loại quy tắc quản trị" mở được ở đường dẫn /adm/adm-20, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần adm.rules.funding-taxonomy đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Dự án đầu tư xây dựng (`projects`)

### `ent-gates`

Nền tảng: web; 13.9 giây; có trong video chính

Màn hình: `PRJ-14` Ngân hàng dự án và vòng đời PIMA (/prj/prj-14); `PRJ-15` Chấm điểm thẩm định (/prj/prj-15)

**Lời đọc**

> Dự án đi qua các cổng giai đoạn, từ chủ trương đến quyết toán. Thiếu hồ sơ thì không qua cổng, ngoại lệ phải có lý do và người duyệt. Thẩm định chấm điểm theo tiêu chí đã công bố.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Dự án đi qua các cổng giai đoạn, từ chủ trương đến quyết toán. Thiếu hồ sơ thì không qua cổng, ngoại lệ phải có lý do và người duyệt. Thẩm định chấm điểm theo tiêu chí đã công bố.

**Phụ đề**

- Dự án đi qua các cổng giai đoạn, / từ chủ trương đến quyết toán.
- Thiếu hồ sơ thì không qua cổng, ngoại / lệ phải có lý do và người duyệt.
- Thẩm định chấm điểm theo / tiêu chí đã công bố.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=PRJ-14`
- `do=spot ref=prj.lifecycle.gates`
- `do=open screen=PRJ-15`
- `do=spot ref=prj.appraisal.criteria-scores`

**Cần thấy trên hình**

- [ ] Màn PRJ-14 "Ngân hàng dự án và vòng đời PIMA" mở được ở đường dẫn /prj/prj-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-15 "Chấm điểm thẩm định" mở được ở đường dẫn /prj/prj-15, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần prj.lifecycle.gates đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.appraisal.criteria-scores đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-npv`

Nền tảng: web; 13.6 giây; có trong video chính

Màn hình: `PRJ-24` Bàn thẩm định hiệu quả đầu tư (/prj/prj-24); `PRJ-23` Thẩm định hiệu quả đầu tư (/prj/prj-23)

**Lời đọc**

> Phân tích khả thi tính NPV, IRR, thời gian hoàn vốn và TCO bằng hàm có kiểm chứng, kèm kịch bản và độ nhạy. Mô hình chỉ hỗ trợ, quyết định thuộc hội đồng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Phân tích khả thi tính en-pi-vi, ai-a-a, thời gian hoàn vốn và ti-xi-ô bằng hàm có kiểm chứng, kèm kịch bản và độ nhạy. Mô hình chỉ hỗ trợ, quyết định thuộc hội đồng.

**Phụ đề**

- Phân tích khả thi tính NPV, / IRR, thời gian hoàn vốn và
- TCO bằng hàm có kiểm chứng, / kèm kịch bản và độ nhạy.
- Mô hình chỉ hỗ trợ, quyết / định thuộc hội đồng.

**Các bước quay**

- `do=open screen=PRJ-24`
- `do=click ref=prj.feasibility.run-scenarios`
- `do=spot ref=prj.feasibility.sensitivity`

**Cần thấy trên hình**

- [ ] Màn PRJ-24 "Bàn thẩm định hiệu quả đầu tư" mở được ở đường dẫn /prj/prj-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-23 "Thẩm định hiệu quả đầu tư" mở được ở đường dẫn /prj/prj-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần prj.feasibility.run-scenarios đúng lúc giọng đọc nói tới
- [ ] Khung vào phần prj.feasibility.sensitivity đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-kinds`

Nền tảng: web; 16.6 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-01` Danh sách dự án (/prj/prj-01); `PRJ-26` Đường cơ sở, độ lệch và số lần dời mốc (/prj/prj-26)

**Lời đọc**

> Bốn loại hình cùng một quy trình: đầu tư xây dựng cơ bản, mua sắm tài sản, mua sắm tài sản cố định và sửa chữa lớn. Mỗi loại có nhóm riêng trên biểu mẫu báo cáo, và có chung đường cơ sở, rủi ro và giá trị thu được.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bốn loại hình cùng một quy trình: đầu tư xây dựng cơ bản, mua sắm tài sản, mua sắm tài sản cố định và sửa chữa lớn. Mỗi loại có nhóm riêng trên biểu mẫu báo cáo, và có chung đường cơ sở, rủi ro và giá trị thu được.

**Phụ đề**

- Bốn loại hình cùng một quy / trình: đầu tư xây dựng cơ bản,
- mua sắm tài sản, mua sắm tài / sản cố định và sửa chữa lớn.
- Mỗi loại có nhóm riêng / trên biểu mẫu báo cáo,
- và có chung đường cơ sở, / rủi ro và giá trị thu được.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=PRJ-01`
- `do=choose ref=prj.list.kind-filter option=first`

**Cần thấy trên hình**

- [ ] Màn PRJ-01 "Danh sách dự án" mở được ở đường dẫn /prj/prj-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-26 "Đường cơ sở, độ lệch và số lần dời mốc" mở được ở đường dẫn /prj/prj-26, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-post-investment`

Nền tảng: web; 15.1 giây; chỉ trong chương cắt riêng

Màn hình: `MNE-08` Đánh giá đầu tư (/mne/mne-08); `AST-07` Kích hoạt đánh giá sau đầu tư (/ast/ast-07)

**Lời đọc**

> Sau khi vận hành, hệ thống đặt chỉ tiêu mục tiêu lúc phê duyệt cạnh kết quả thực tế. Đánh giá sau đầu tư tự được lên lịch khi bàn giao tài sản, và bài học kinh nghiệm được ghi lại cho dự án sau.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sau khi vận hành, hệ thống đặt chỉ tiêu mục tiêu lúc phê duyệt cạnh kết quả thực tế. Đánh giá sau đầu tư tự được lên lịch khi bàn giao tài sản, và bài học kinh nghiệm được ghi lại cho dự án sau.

**Phụ đề**

- Sau khi vận hành, hệ / thống đặt chỉ tiêu mục
- tiêu lúc phê duyệt cạnh kết quả thực tế.
- Đánh giá sau đầu tư tự được / lên lịch khi bàn giao tài sản,
- và bài học kinh nghiệm / được ghi lại cho dự án sau.

**Các bước quay**

- `do=as persona=mneAdmin`
- `do=open screen=MNE-08`
- `do=spot ref=mne.evaluation.target-vs-actual`

**Cần thấy trên hình**

- [ ] Màn MNE-08 "Đánh giá đầu tư" mở được ở đường dẫn /mne/mne-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn AST-07 "Kích hoạt đánh giá sau đầu tư" mở được ở đường dẫn /ast/ast-07, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản mneAdmin
- [ ] Khung vào phần mne.evaluation.target-vs-actual đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-risks`

Nền tảng: web; 15.4 giây; chỉ trong chương cắt riêng

Màn hình: `PRJ-16` Sổ đăng ký rủi ro dự án (/prj/prj-16); `PRJ-22` Sổ dự phòng và dự trữ quản lý (/prj/prj-22)

**Lời đọc**

> Sổ rủi ro chấm điểm trước và sau phản ứng, và tự kích hoạt khi chỉ số chi phí hay tiến độ xấu đi. Dự phòng chỉ được rút gắn với một rủi ro hoặc một lệnh thay đổi, và mỗi lần rút đều bất biến.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Sổ rủi ro chấm điểm trước và sau phản ứng, và tự kích hoạt khi chỉ số chi phí hay tiến độ xấu đi. Dự phòng chỉ được rút gắn với một rủi ro hoặc một lệnh thay đổi, và mỗi lần rút đều bất biến.

**Phụ đề**

- Sổ rủi ro chấm điểm trước và sau phản ứng,
- và tự kích hoạt khi chỉ số / chi phí hay tiến độ xấu đi.
- Dự phòng chỉ được rút / gắn với một rủi ro hoặc
- một lệnh thay đổi, và / mỗi lần rút đều bất biến.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=PRJ-16`
- `do=spot ref=prj.risk.before-after-score`

**Cần thấy trên hình**

- [ ] Màn PRJ-16 "Sổ đăng ký rủi ro dự án" mở được ở đường dẫn /prj/prj-16, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn PRJ-22 "Sổ dự phòng và dự trữ quản lý" mở được ở đường dẫn /prj/prj-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần prj.risk.before-after-score đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Báo cáo gửi Tập đoàn (`reports-pvn`)

### `rpt-dictionary`

Nền tảng: web; 13.3 giây; có trong video chính

Màn hình: `IND-01` Từ điển chỉ tiêu (/ind/ind-01); `IND-02` Quy tắc nhập liệu (/ind/ind-02)

**Lời đọc**

> Từ điển chỉ tiêu định nghĩa mỗi con số một lần. Quy tắc nhập kiểm ngay khi gõ: lũy kế không vượt tổng mức, vốn chủ sở hữu cộng vốn vay bằng tổng, kỳ đã chốt không sửa được.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Từ điển chỉ tiêu định nghĩa mỗi con số một lần. Quy tắc nhập kiểm ngay khi gõ: lũy kế không vượt tổng mức, vốn chủ sở hữu cộng vốn vay bằng tổng, kỳ đã chốt không sửa được.

**Phụ đề**

- Từ điển chỉ tiêu định / nghĩa mỗi con số một lần.
- Quy tắc nhập kiểm ngay khi gõ: / lũy kế không vượt tổng mức,
- vốn chủ sở hữu cộng vốn vay bằng / tổng, kỳ đã chốt không sửa được.

**Các bước quay**

- `do=as persona=dgvSteward`
- `do=open screen=IND-01`
- `do=spot ref=ent.dictionary.indicator-row`
- `do=open screen=IND-02`
- `do=spot ref=ent.entry-rules.violation-hint`

**Cần thấy trên hình**

- [ ] Màn IND-01 "Từ điển chỉ tiêu" mở được ở đường dẫn /ind/ind-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn IND-02 "Quy tắc nhập liệu" mở được ở đường dẫn /ind/ind-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản dgvSteward
- [ ] Khung vào phần ent.dictionary.indicator-row đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ent.entry-rules.violation-hint đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rpt-generate`

Nền tảng: web; 19.1 giây; có trong video chính

Màn hình: `RPT-01` Danh mục biểu mẫu báo cáo và lập báo cáo (/rpt/rpt-01)

**Lời đọc**

> Bộ sinh báo cáo điền thẳng vào tệp Excel mẫu, giữ nguyên bố cục, hàng tổng là công thức thật. Phần thuyết minh sinh ra tệp Word, các con số trong lời văn lấy từ cùng chỉ tiêu nên không lệch với bảng. Sáu biểu mẫu là mẫu demo do hệ thống tự thiết kế.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bộ sinh báo cáo điền thẳng vào tệp ếch-xeo mẫu, giữ nguyên bố cục, hàng tổng là công thức thật. Phần thuyết minh sinh ra tệp oớt, các con số trong lời văn lấy từ cùng chỉ tiêu nên không lệch với bảng. Sáu biểu mẫu là mẫu đê-mô do hệ thống tự thiết kế.

**Phụ đề**

- Bộ sinh báo cáo điền / thẳng vào tệp Excel mẫu,
- giữ nguyên bố cục, hàng / tổng là công thức thật.
- Phần thuyết minh sinh ra / tệp Word, các con số trong
- lời văn lấy từ cùng chỉ tiêu / nên không lệch với bảng.
- Sáu biểu mẫu là mẫu demo / do hệ thống tự thiết kế.

**Các bước quay**

- `do=as persona=mneAdmin`
- `do=open screen=RPT-01`
- `do=choose ref=rpt.generate.form option=first`
- `do=click ref=rpt.generate.fill-template`
- `do=spot ref=rpt.generate.preview-sheet`

**Cần thấy trên hình**

- [ ] Màn RPT-01 "Danh mục biểu mẫu báo cáo và lập báo cáo" mở được ở đường dẫn /rpt/rpt-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản mneAdmin
- [ ] Khung vào phần rpt.generate.fill-template đúng lúc giọng đọc nói tới
- [ ] Khung vào phần rpt.generate.preview-sheet đúng lúc giọng đọc nói tới
- [ ] Chú thích "MẪU DEMO — chờ mẫu chính thức" hiện từ giây 2, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "MẪU DEMO — chờ mẫu chính thức"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rpt-six-forms`

Nền tảng: web; 16 giây; có trong video chính

Màn hình: `RPT-01` Danh mục biểu mẫu báo cáo và lập báo cáo (/rpt/rpt-01)

**Lời đọc**

> Có sáu biểu mẫu gửi Tập đoàn, HPM, ủy ban, giao ban và nhà máy Đạm Phú Mỹ. Cả sáu hiện là mẫu demo do hệ thống tự thiết kế, đóng dấu chờ mẫu chính thức, không bao giờ tính là nghiệm thu chính thức.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Có sáu biểu mẫu gửi Tập đoàn, hát-pê-em, ủy ban, giao ban và nhà máy Đạm Phú Mỹ. Cả sáu hiện là mẫu đê-mô do hệ thống tự thiết kế, đóng dấu chờ mẫu chính thức, không bao giờ tính là nghiệm thu chính thức.

**Phụ đề**

- Có sáu biểu mẫu gửi Tập đoàn, HPM, ủy / ban, giao ban và nhà máy Đạm Phú Mỹ.
- Cả sáu hiện là mẫu demo do hệ / thống tự thiết kế, đóng dấu chờ
- mẫu chính thức, không bao giờ / tính là nghiệm thu chính thức.

**Các bước quay**

- `do=open screen=RPT-01`
- `do=spot ref=rpt.forms.status-column`
- `do=spot ref=rpt.forms.demo-stamp`

**Cần thấy trên hình**

- [ ] Màn RPT-01 "Danh mục biểu mẫu báo cáo và lập báo cáo" mở được ở đường dẫn /rpt/rpt-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần rpt.forms.status-column đúng lúc giọng đọc nói tới
- [ ] Khung vào phần rpt.forms.demo-stamp đúng lúc giọng đọc nói tới
- [ ] Chú thích "MẪU DEMO — chờ mẫu chính thức" hiện từ giây 5, kéo dài 8 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "MẪU DEMO — chờ mẫu chính thức"
- [ ] Sáu biểu mẫu đều mang dấu MẪU DEMO — chờ mẫu chính thức ngay trên hình
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rpt-issue`

Nền tảng: web; 18.8 giây; có trong video chính

Màn hình: `RPT-03` Các bản báo cáo đã phát hành (/rpt/rpt-03)

**Lời đọc**

> Bản phát hành theo kỳ không sửa được và có mã băm. Người lập, người kiểm tra và người duyệt là ba người khác nhau. Sửa số đã phát hành phải tạo phiên bản mới có lý do, bản cũ vẫn giữ nguyên. Bản phát hành này là mẫu demo, chờ mẫu chính thức.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bản phát hành theo kỳ không sửa được và có mã băm. Người lập, người kiểm tra và người duyệt là ba người khác nhau. Sửa số đã phát hành phải tạo phiên bản mới có lý do, bản cũ vẫn giữ nguyên. Bản phát hành này là mẫu đê-mô, chờ mẫu chính thức.

**Phụ đề**

- Bản phát hành theo kỳ không / sửa được và có mã băm.
- Người lập, người kiểm tra và / người duyệt là ba người khác nhau.
- Sửa số đã phát hành phải tạo phiên bản / mới có lý do, bản cũ vẫn giữ nguyên.
- Bản phát hành này là mẫu / demo, chờ mẫu chính thức.

**Các bước quay**

- `do=as persona=mneAdmin`
- `do=open screen=RPT-03`
- `do=spot ref=rpt.issued.three-roles`
- `do=command operation=post_reports_id_decision as=capApprover`

**Cần thấy trên hình**

- [ ] Màn RPT-03 "Các bản báo cáo đã phát hành" mở được ở đường dẫn /rpt/rpt-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản mneAdmin
- [ ] Khung vào phần rpt.issued.three-roles đúng lúc giọng đọc nói tới
- [ ] Chạy thao tác thật post_reports_id_decision bằng tài khoản capApprover
- [ ] Chú thích "Lập ≠ kiểm ≠ duyệt" hiện từ giây 3, kéo dài 5 giây
- [ ] Chú thích "MẪU DEMO — chờ mẫu chính thức" hiện từ giây 9, kéo dài 5 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "MẪU DEMO — chờ mẫu chính thức"
- [ ] Lập, kiểm, duyệt là ba người khác nhau
- [ ] Bản đã phát hành mang dấu MẪU DEMO — chờ mẫu chính thức
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rpt-naming`

Nền tảng: web; 18.5 giây; chỉ trong chương cắt riêng

Màn hình: `RPT-03` Các bản báo cáo đã phát hành (/rpt/rpt-03)

**Lời đọc**

> Tên tệp tuân theo quy tắc đặt tên: mã biểu, kỳ, phiên bản và một đoạn mã băm của nội dung. Cùng đầu vào thì ra một tệp giống hệt, nên bên nhận kiểm được tệp mình nhận có đúng bản đã phát hành hay không. Đây là mẫu demo, chờ mẫu chính thức.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Tên tệp tuân theo quy tắc đặt tên: mã biểu, kỳ, phiên bản và một đoạn mã băm của nội dung. Cùng đầu vào thì ra một tệp giống hệt, nên bên nhận kiểm được tệp mình nhận có đúng bản đã phát hành hay không. Đây là mẫu đê-mô, chờ mẫu chính thức.

**Phụ đề**

- Tên tệp tuân theo quy / tắc đặt tên: mã biểu,
- kỳ, phiên bản và một / đoạn mã băm của nội dung.
- Cùng đầu vào thì ra một tệp / giống hệt, nên bên nhận kiểm
- được tệp mình nhận có đúng / bản đã phát hành hay không.
- Đây là mẫu demo, chờ mẫu chính thức.

**Các bước quay**

- `do=as persona=mneAdmin`
- `do=open screen=RPT-03`
- `do=spot ref=rpt.issued.file-name`

**Cần thấy trên hình**

- [ ] Màn RPT-03 "Các bản báo cáo đã phát hành" mở được ở đường dẫn /rpt/rpt-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản mneAdmin
- [ ] Khung vào phần rpt.issued.file-name đúng lúc giọng đọc nói tới
- [ ] Chú thích "MẪU DEMO — chờ mẫu chính thức" hiện từ giây 3, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "MẪU DEMO — chờ mẫu chính thức"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `rpt-word`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `RPT-01` Danh mục biểu mẫu báo cáo và lập báo cáo (/rpt/rpt-01)

**Lời đọc**

> Thuyết minh bằng Word có khung sẵn cho các biểu quý, ủy ban, giao ban và nhà máy. Phần máy điền là con số lấy từ chỉ tiêu, phần người viết là chỗ trống có ghi chú. Dấu mẫu demo in ở đầu mỗi trang.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Thuyết minh bằng oớt có khung sẵn cho các biểu quý, ủy ban, giao ban và nhà máy. Phần máy điền là con số lấy từ chỉ tiêu, phần người viết là chỗ trống có ghi chú. Dấu mẫu đê-mô in ở đầu mỗi trang.

**Phụ đề**

- Thuyết minh bằng Word có khung sẵn cho / các biểu quý, ủy ban, giao ban và nhà máy.
- Phần máy điền là con số lấy từ chỉ tiêu, / phần người viết là chỗ trống có ghi chú.
- Dấu mẫu demo in ở đầu mỗi trang.

**Các bước quay**

- `do=as persona=mneAdmin`
- `do=open screen=RPT-01`
- `do=click ref=rpt.generate.word-narrative`

**Cần thấy trên hình**

- [ ] Màn RPT-01 "Danh mục biểu mẫu báo cáo và lập báo cáo" mở được ở đường dẫn /rpt/rpt-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản mneAdmin
- [ ] Khung vào phần rpt.generate.word-narrative đúng lúc giọng đọc nói tới
- [ ] Chú thích "MẪU DEMO — chờ mẫu chính thức" hiện từ giây 4, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "MẪU DEMO — chờ mẫu chính thức"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Quy trình duyệt số liệu kỳ (`workflow`)

### `wf-flow`

Nền tảng: web; 17.5 giây; có trong video chính

Màn hình: `ADM-18` Theo dõi quy trình phê duyệt (/adm/adm-18); `RPT-02` Bản nháp báo cáo, xem trước và luồng kiểm tra, phê duyệt, phát hành (/rpt/rpt-02)

**Lời đọc**

> Số liệu kỳ đi qua một quy trình: đơn vị nhập, người duyệt đơn vị, Ban Kế hoạch đầu tư rà soát, chốt kỳ rồi đẩy số. Mỗi bước có hạn và nhắc việc, trả lại phải nêu lý do, và kênh Microsoft Teams báo tin cho người đến lượt.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Số liệu kỳ đi qua một quy trình: đơn vị nhập, người duyệt đơn vị, Ban Kế hoạch đầu tư rà soát, chốt kỳ rồi đẩy số. Mỗi bước có hạn và nhắc việc, trả lại phải nêu lý do, và kênh mai-cờ-rô-sốp tim báo tin cho người đến lượt.

**Phụ đề**

- Số liệu kỳ đi qua một quy trình: / đơn vị nhập, người duyệt đơn vị,
- Ban Kế hoạch đầu tư rà / soát, chốt kỳ rồi đẩy số.
- Mỗi bước có hạn và nhắc / việc, trả lại phải nêu lý do,
- và kênh Microsoft Teams / báo tin cho người đến lượt.

**Các bước quay**

- `do=as persona=unitAdmin`
- `do=open screen=RPT-02`
- `do=spot ref=wf.period.step-deadlines`
- `do=open screen=ADM-18`

**Cần thấy trên hình**

- [ ] Màn ADM-18 "Theo dõi quy trình phê duyệt" mở được ở đường dẫn /adm/adm-18, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn RPT-02 "Bản nháp báo cáo, xem trước và luồng kiểm tra, phê duyệt, phát hành" mở được ở đường dẫn /rpt/rpt-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản unitAdmin
- [ ] Khung vào phần wf.period.step-deadlines đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `wf-close`

Nền tảng: web; 14.2 giây; chỉ trong chương cắt riêng

Màn hình: `DIS-21` Chốt và đóng băng số liệu kỳ (/dis/dis-21); `DIS-22` Mở lại kỳ có lý do (/dis/dis-22)

**Lời đọc**

> Chốt kỳ đóng băng số liệu thành ảnh chụp bất biến. Sai sót sau chốt không sửa đè mà đi đường điều chỉnh, có lý do và người duyệt. Lãnh đạo duyệt ngay trên điện thoại hoặc PWA.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chốt kỳ đóng băng số liệu thành ảnh chụp bất biến. Sai sót sau chốt không sửa đè mà đi đường điều chỉnh, có lý do và người duyệt. Lãnh đạo duyệt ngay trên điện thoại hoặc pê-đắp-liu-a.

**Phụ đề**

- Chốt kỳ đóng băng số liệu / thành ảnh chụp bất biến.
- Sai sót sau chốt không sửa đè mà đi đường / điều chỉnh, có lý do và người duyệt.
- Lãnh đạo duyệt ngay trên / điện thoại hoặc PWA.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=DIS-21`
- `do=spot ref=dis.freeze.snapshot-hash`

**Cần thấy trên hình**

- [ ] Màn DIS-21 "Chốt và đóng băng số liệu kỳ" mở được ở đường dẫn /dis/dis-21, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-22 "Mở lại kỳ có lý do" mở được ở đường dẫn /dis/dis-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần dis.freeze.snapshot-hash đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `wf-warnings`

Nền tảng: web; 14.2 giây; chỉ trong chương cắt riêng

Màn hình: `DIS-06` Rà soát và gửi báo cáo (/dis/dis-06); `DIS-08` Sửa và bổ sung báo cáo (/dis/dis-08)

**Lời đọc**

> Người duyệt có thể gửi trả kèm cảnh báo: dòng nào vượt quy tắc nhập, dòng nào thiếu bằng chứng. Đơn vị sửa đúng chỗ được chỉ ra, rồi trình lại, và lịch sử trả lại và trình lại được giữ đủ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Người duyệt có thể gửi trả kèm cảnh báo: dòng nào vượt quy tắc nhập, dòng nào thiếu bằng chứng. Đơn vị sửa đúng chỗ được chỉ ra, rồi trình lại, và lịch sử trả lại và trình lại được giữ đủ.

**Phụ đề**

- Người duyệt có thể gửi trả kèm cảnh báo:
- dòng nào vượt quy tắc nhập, / dòng nào thiếu bằng chứng.
- Đơn vị sửa đúng chỗ được / chỉ ra, rồi trình lại,
- và lịch sử trả lại và / trình lại được giữ đủ.

**Các bước quay**

- `do=as persona=capApprover`
- `do=open screen=DIS-06`
- `do=spot ref=dis.review.warnings`

**Cần thấy trên hình**

- [ ] Màn DIS-06 "Rà soát và gửi báo cáo" mở được ở đường dẫn /dis/dis-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIS-08 "Sửa và bổ sung báo cáo" mở được ở đường dẫn /dis/dis-08, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản capApprover
- [ ] Khung vào phần dis.review.warnings đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `wf-teams`

Nền tảng: web; 14.8 giây; chỉ trong chương cắt riêng

Màn hình: `NOT-06` Dựng luồng thông báo (/not/not-06); `NOT-03` Tùy chọn nhận tin (/not/not-03)

**Lời đọc**

> Người đến lượt duyệt nhận tin ngay trong kênh Microsoft Teams của đơn vị, kèm đường dẫn mở đúng hồ sơ. Tin trên Teams không chứa số tiền, chỉ báo có việc chờ, và việc duyệt vẫn làm trong hệ thống.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Người đến lượt duyệt nhận tin ngay trong kênh mai-cờ-rô-sốp tim của đơn vị, kèm đường dẫn mở đúng hồ sơ. Tin trên tim không chứa số tiền, chỉ báo có việc chờ, và việc duyệt vẫn làm trong hệ thống.

**Phụ đề**

- Người đến lượt duyệt nhận / tin ngay trong kênh Microsoft
- Teams của đơn vị, kèm / đường dẫn mở đúng hồ sơ.
- Tin trên Teams không chứa số / tiền, chỉ báo có việc chờ,
- và việc duyệt vẫn làm trong hệ thống.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=NOT-06`
- `do=spot ref=not.workflow.teams-channel-step`

**Cần thấy trên hình**

- [ ] Màn NOT-06 "Dựng luồng thông báo" mở được ở đường dẫn /not/not-06, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn NOT-03 "Tùy chọn nhận tin" mở được ở đường dẫn /not/not-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần not.workflow.teams-channel-step đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Đẩy số HPM và đối chiếu kế toán (`hpm-ebs`)

### `hpm-push`

Nền tảng: web; 20 giây; có trong video chính

Màn hình: `HPM-01` Đẩy báo cáo lên HPM: kết nối, nhật ký đẩy, đẩy lại và biên nhận (/hpm/hpm-01)

**Lời đọc**

> Kỳ đã chốt được đẩy sang HPM. Mỗi lần đẩy có khóa theo tổ chức, kỳ và phiên bản báo cáo, nên gửi lại không bao giờ trùng. Hiện bộ ghi tệp chuẩn thay chỗ HPM, là giả định tạm chờ thông tin kỹ thuật chính thức. Biểu mẫu gửi đi là mẫu demo.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Kỳ đã chốt được đẩy sang hát-pê-em. Mỗi lần đẩy có khóa theo tổ chức, kỳ và phiên bản báo cáo, nên gửi lại không bao giờ trùng. Hiện bộ ghi tệp chuẩn thay chỗ hát-pê-em, là giả định tạm chờ thông tin kỹ thuật chính thức. Biểu mẫu gửi đi là mẫu đê-mô.

**Phụ đề**

- Kỳ đã chốt được đẩy sang HPM.
- Mỗi lần đẩy có khóa theo / tổ chức, kỳ và phiên
- bản báo cáo, nên gửi / lại không bao giờ trùng.
- Hiện bộ ghi tệp chuẩn thay chỗ HPM,
- là giả định tạm chờ thông / tin kỹ thuật chính thức.
- Biểu mẫu gửi đi là mẫu demo.

**Các bước quay**

- `do=as persona=mneAdmin`
- `do=open screen=HPM-01`
- `do=spot ref=hpm.push.idempotency-key`
- `do=click ref=hpm.push.retry`

**Cần thấy trên hình**

- [ ] Màn HPM-01 "Đẩy báo cáo lên HPM: kết nối, nhật ký đẩy, đẩy lại và biên nhận" mở được ở đường dẫn /hpm/hpm-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản mneAdmin
- [ ] Khung vào phần hpm.push.idempotency-key đúng lúc giọng đọc nói tới
- [ ] Khung vào phần hpm.push.retry đúng lúc giọng đọc nói tới
- [ ] Chú thích "Giả định tạm, chờ tài liệu chính thức của bên nhận" hiện từ giây 6, kéo dài 8 giây
- [ ] Chú thích "MẪU DEMO — chờ mẫu chính thức" hiện từ giây 15, kéo dài 4 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Giả định tạm, chờ tài liệu chính thức của bên nhận"
- [ ] Dấu bắt buộc hiện rõ trên hình: "MẪU DEMO — chờ mẫu chính thức"
- [ ] Nhật ký đẩy có một lần ghi tệp thành công và một lần bị từ chối kèm lý do
- [ ] Giả định tạm về bên nhận hiện trên hình
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `hpm-stale`

Nền tảng: web; 17.9 giây; chỉ trong chương cắt riêng

Màn hình: `HPM-01` Đẩy báo cáo lên HPM: kết nối, nhật ký đẩy, đẩy lại và biên nhận (/hpm/hpm-01); `ADM-11` Nhật ký kiểm toán (/adm/adm-11)

**Lời đọc**

> Bản báo cáo cũ hơn bản HPM đã nhận bị từ chối kèm lý do. Muốn ghi đè một kỳ đã được nhận, phải mở lại kỳ, có điều chỉnh được duyệt, và việc đó ghi vào nhật ký kiểm toán. Bản gửi là mẫu demo, chờ mẫu chính thức.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Bản báo cáo cũ hơn bản hát-pê-em đã nhận bị từ chối kèm lý do. Muốn ghi đè một kỳ đã được nhận, phải mở lại kỳ, có điều chỉnh được duyệt, và việc đó ghi vào nhật ký kiểm toán. Bản gửi là mẫu đê-mô, chờ mẫu chính thức.

**Phụ đề**

- Bản báo cáo cũ hơn bản HPM / đã nhận bị từ chối kèm lý do.
- Muốn ghi đè một kỳ đã / được nhận, phải mở lại kỳ,
- có điều chỉnh được duyệt, và việc / đó ghi vào nhật ký kiểm toán.
- Bản gửi là mẫu demo, chờ mẫu chính thức.

**Các bước quay**

- `do=open screen=HPM-01`
- `do=spot ref=hpm.push.stale-refusal`

**Cần thấy trên hình**

- [ ] Màn HPM-01 "Đẩy báo cáo lên HPM: kết nối, nhật ký đẩy, đẩy lại và biên nhận" mở được ở đường dẫn /hpm/hpm-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-11 "Nhật ký kiểm toán" mở được ở đường dẫn /adm/adm-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần hpm.push.stale-refusal đúng lúc giọng đọc nói tới
- [ ] Chú thích "MẪU DEMO — chờ mẫu chính thức" hiện từ giây 2, kéo dài 6 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "MẪU DEMO — chờ mẫu chính thức"
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ebs-reconcile`

Nền tảng: web; 13.6 giây; có trong video chính

Màn hình: `EBS-02` Đối chiếu Oracle EBS theo mã dự án và giải trình chênh lệch (/ebs/ebs-02)

**Lời đọc**

> Số kế toán từ Oracle EBS được nhập và đối chiếu theo mã dự án, hiện còn {{figure:ent-ebs-differences}} chênh lệch. Mỗi chênh lệch cần giải trình của người phụ trách. Mẫu tệp là giả định.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Số kế toán từ ô-ra-cồ i-bi-ét được nhập và đối chiếu theo mã dự án, hiện còn {{figure:ent-ebs-differences}} chênh lệch. Mỗi chênh lệch cần giải trình của người phụ trách. Mẫu tệp là giả định.

**Phụ đề**

- Số kế toán từ Oracle EBS được nhập và đối
- chiếu theo mã dự án, / hiện còn {n} chênh lệch.
- Mỗi chênh lệch cần giải / trình của người phụ trách.
- Mẫu tệp là giả định.

**Các bước quay**

- `do=as persona=dgvSteward`
- `do=open screen=EBS-02`
- `do=upload operation=importEbsFile fixture=ebs-ledger-sample`
- `do=spot ref=ebs.reconcile.difference-rows`

**Cần thấy trên hình**

- [ ] Màn EBS-02 "Đối chiếu Oracle EBS theo mã dự án và giải trình chênh lệch" mở được ở đường dẫn /ebs/ebs-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản dgvSteward
- [ ] Tải tệp mẫu ebs-ledger-sample lên thao tác importEbsFile
- [ ] Khung vào phần ebs.reconcile.difference-rows đúng lúc giọng đọc nói tới
- [ ] Chú thích "Giả định tạm, chờ tài liệu chính thức của bên nhận" hiện từ giây 5, kéo dài 8 giây
- [ ] Dấu bắt buộc hiện rõ trên hình: "Giả định tạm, chờ tài liệu chính thức của bên nhận"
- [ ] Con số ent-ebs-differences đọc từ dữ liệu thật qua listEbsDifferences (counts.open); không gõ tay, thiếu giá trị thì dừng quay
- [ ] Chênh lệch theo mã dự án: số báo cáo, số kế toán, chênh lệch và người giải trình
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-lake-api`

Nền tảng: web; 18.8 giây; chỉ trong chương cắt riêng

Màn hình: `INT-05` Nhật ký truy cập API mở (/int/int-05)

**Lời đọc**

> Cho kho dữ liệu Lakehouse và Power BI, mỗi tổ chức có một tài khoản chỉ đọc riêng trên các bảng xem đã chứng nhận. Tài khoản đó chỉ thấy dòng của tổ chức mình. Giao diện mở API có tài liệu, tài khoản máy, phạm vi và giới hạn tần suất.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Cho kho dữ liệu lếch-hao và pao bi-ai, mỗi tổ chức có một tài khoản chỉ đọc riêng trên các bảng xem đã chứng nhận. Tài khoản đó chỉ thấy dòng của tổ chức mình. Giao diện mở ây-pi-ai có tài liệu, tài khoản máy, phạm vi và giới hạn tần suất.

**Phụ đề**

- Cho kho dữ liệu Lakehouse và / Power BI, mỗi tổ chức có một
- tài khoản chỉ đọc riêng trên / các bảng xem đã chứng nhận.
- Tài khoản đó chỉ thấy / dòng của tổ chức mình.
- Giao diện mở API có tài liệu, tài khoản / máy, phạm vi và giới hạn tần suất.

**Các bước quay**

- `do=as persona=sysAdmin`
- `do=open screen=INT-05`
- `do=spot ref=int.open-api.machine-accounts`

**Cần thấy trên hình**

- [ ] Màn INT-05 "Nhật ký truy cập API mở" mở được ở đường dẫn /int/int-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản sysAdmin
- [ ] Khung vào phần int.open-api.machine-accounts đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-cross-code`

Nền tảng: web; 15.7 giây; chỉ trong chương cắt riêng

Màn hình: `BID-23` Ánh xạ mã hệ thống mạng đấu thầu quốc gia (/bid/bid-23); `MDM-35` Bản ghi chủ, crosswalk và tách/hợp nhất (/mdm/mdm-35)

**Lời đọc**

> Một dự án có thể mang nhiều mã ở nhiều hệ thống: kế toán, HPM, mạng đấu thầu. Bảng ánh xạ chung nối các mã đó, mỗi nối có hiệu lực theo ngày, người đề xuất khác người duyệt, và không bao giờ nối ngầm.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Một dự án có thể mang nhiều mã ở nhiều hệ thống: kế toán, hát-pê-em, mạng đấu thầu. Bảng ánh xạ chung nối các mã đó, mỗi nối có hiệu lực theo ngày, người đề xuất khác người duyệt, và không bao giờ nối ngầm.

**Phụ đề**

- Một dự án có thể mang nhiều mã ở nhiều / hệ thống: kế toán, HPM, mạng đấu thầu.
- Bảng ánh xạ chung nối các mã đó, / mỗi nối có hiệu lực theo ngày,
- người đề xuất khác người duyệt, / và không bao giờ nối ngầm.

**Các bước quay**

- `do=as persona=dgvSteward`
- `do=open screen=MDM-35`
- `do=spot ref=mdm.crosswalk.multi-system-codes`

**Cần thấy trên hình**

- [ ] Màn BID-23 "Ánh xạ mã hệ thống mạng đấu thầu quốc gia" mở được ở đường dẫn /bid/bid-23, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn MDM-35 "Bản ghi chủ, crosswalk và tách/hợp nhất" mở được ở đường dẫn /mdm/mdm-35, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản dgvSteward
- [ ] Khung vào phần mdm.crosswalk.multi-system-codes đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Chỉ đạo giao ban (`directives`)

### `dir-track`

Nền tảng: web; 15.1 giây; có trong video chính

Màn hình: `DIR-01` Các cuộc giao ban đầu tư (/dir/dir-01); `DIR-03` Bảng theo dõi chỉ đạo (/dir/dir-03); `DIR-04` Chi tiết chỉ đạo, dòng thời gian, gia hạn và đóng (/dir/dir-04)

**Lời đọc**

> Chỉ đạo giao ban được ghi từ cuộc họp: đơn vị thực hiện, hạn, tiến độ và bằng chứng. Chỉ đạo quá hạn nổi lên đầu bảng, gia hạn phải có lý do, và chỉ đạo của kỳ tự đưa vào báo cáo kỳ sau.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chỉ đạo giao ban được ghi từ cuộc họp: đơn vị thực hiện, hạn, tiến độ và bằng chứng. Chỉ đạo quá hạn nổi lên đầu bảng, gia hạn phải có lý do, và chỉ đạo của kỳ tự đưa vào báo cáo kỳ sau.

**Phụ đề**

- Chỉ đạo giao ban được ghi từ cuộc họp: đơn / vị thực hiện, hạn, tiến độ và bằng chứng.
- Chỉ đạo quá hạn nổi lên đầu / bảng, gia hạn phải có lý do,
- và chỉ đạo của kỳ tự / đưa vào báo cáo kỳ sau.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DIR-03`
- `do=click ref=dir.board.first-overdue`
- `do=spot ref=dir.detail.timeline`

**Cần thấy trên hình**

- [ ] Màn DIR-01 "Các cuộc giao ban đầu tư" mở được ở đường dẫn /dir/dir-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIR-03 "Bảng theo dõi chỉ đạo" mở được ở đường dẫn /dir/dir-03, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIR-04 "Chi tiết chỉ đạo, dòng thời gian, gia hạn và đóng" mở được ở đường dẫn /dir/dir-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần dir.board.first-overdue đúng lúc giọng đọc nói tới
- [ ] Khung vào phần dir.detail.timeline đúng lúc giọng đọc nói tới
- [ ] Chỉ đạo của ba cuộc giao ban, trong đó có chỉ đạo quá hạn
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `dir-meeting`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `DIR-01` Các cuộc giao ban đầu tư (/dir/dir-01); `DIR-02` Chi tiết cuộc giao ban và các chỉ đạo đã giao (/dir/dir-02)

**Lời đọc**

> Mỗi cuộc giao ban là một bản ghi: thành phần, nội dung và các chỉ đạo đã giao. Mỗi chỉ đạo giao cho một đơn vị với hạn rõ ràng, người được giao nhận việc rồi báo cáo tiến độ kèm bằng chứng.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Mỗi cuộc giao ban là một bản ghi: thành phần, nội dung và các chỉ đạo đã giao. Mỗi chỉ đạo giao cho một đơn vị với hạn rõ ràng, người được giao nhận việc rồi báo cáo tiến độ kèm bằng chứng.

**Phụ đề**

- Mỗi cuộc giao ban là một bản ghi: thành / phần, nội dung và các chỉ đạo đã giao.
- Mỗi chỉ đạo giao cho một / đơn vị với hạn rõ ràng,
- người được giao nhận việc rồi / báo cáo tiến độ kèm bằng chứng.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DIR-02`
- `do=spot ref=dir.meeting.directive-list`

**Cần thấy trên hình**

- [ ] Màn DIR-01 "Các cuộc giao ban đầu tư" mở được ở đường dẫn /dir/dir-01, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DIR-02 "Chi tiết cuộc giao ban và các chỉ đạo đã giao" mở được ở đường dẫn /dir/dir-02, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần dir.meeting.directive-list đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `dir-present`

Nền tảng: web; 14.5 giây; chỉ trong chương cắt riêng

Màn hình: `DIR-05` Chỉ đạo của kỳ làm đầu vào báo cáo kỳ sau (/dir/dir-05)

**Lời đọc**

> Dashboard có chế độ trình chiếu cho phòng họp: so với cùng kỳ, chỉ đạo quá hạn, dự án vướng thủ tục. Trên điện thoại, danh sách chỉ đạo cho phép người được giao cập nhật tiến độ ngay tại hiện trường.

**Lời gửi cho giọng đọc (đã phiên âm)**

> đát-bo có chế độ trình chiếu cho phòng họp: so với cùng kỳ, chỉ đạo quá hạn, dự án vướng thủ tục. Trên điện thoại, danh sách chỉ đạo cho phép người được giao cập nhật tiến độ ngay tại hiện trường.

**Phụ đề**

- Dashboard có chế độ trình / chiếu cho phòng họp:
- so với cùng kỳ, chỉ đạo quá / hạn, dự án vướng thủ tục.
- Trên điện thoại, danh sách / chỉ đạo cho phép người
- được giao cập nhật tiến / độ ngay tại hiện trường.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DIR-05`
- `do=click ref=dir.dashboard.presentation-mode`

**Cần thấy trên hình**

- [ ] Màn DIR-05 "Chỉ đạo của kỳ làm đầu vào báo cáo kỳ sau" mở được ở đường dẫn /dir/dir-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần dir.dashboard.presentation-mode đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `dir-feed`

Nền tảng: web; 11.5 giây; chỉ trong chương cắt riêng

Màn hình: `DIR-05` Chỉ đạo của kỳ làm đầu vào báo cáo kỳ sau (/dir/dir-05)

**Lời đọc**

> Chỉ đạo của kỳ trở thành đầu vào của báo cáo kỳ sau. Báo cáo tự liệt kê chỉ đạo đã hoàn thành, đang làm và quá hạn, không ai phải chép lại.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Chỉ đạo của kỳ trở thành đầu vào của báo cáo kỳ sau. Báo cáo tự liệt kê chỉ đạo đã hoàn thành, đang làm và quá hạn, không ai phải chép lại.

**Phụ đề**

- Chỉ đạo của kỳ trở thành / đầu vào của báo cáo kỳ sau.
- Báo cáo tự liệt kê chỉ đạo đã hoàn thành,
- đang làm và quá hạn, / không ai phải chép lại.

**Các bước quay**

- `do=as persona=owner`
- `do=open screen=DIR-05`
- `do=spot ref=dir.feed.next-period-input`

**Cần thấy trên hình**

- [ ] Màn DIR-05 "Chỉ đạo của kỳ làm đầu vào báo cáo kỳ sau" mở được ở đường dẫn /dir/dir-05, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản owner
- [ ] Khung vào phần dir.feed.next-period-input đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

## Hồ sơ dự án và trợ lý AI (`docs-ai`)

### `doc-repo`

Nền tảng: web; 18.2 giây; có trong video chính

Màn hình: `DOC-24` Kho hồ sơ dự án (/doc/doc-24)

**Lời đọc**

> Hồ sơ dự án nằm trong một kho: PDF, Word, Excel, có phân loại và ngày hiệu lực. Chữ trong ảnh quét được nhận dạng bằng OCR và dẫn nguồn về đúng trang. Mỗi phiên bản có góp ý riêng, so sánh được, và bản đã duyệt bị khóa.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hồ sơ dự án nằm trong một kho: pi-đi-ép, oớt, ếch-xeo, có phân loại và ngày hiệu lực. Chữ trong ảnh quét được nhận dạng bằng ô-xi-a và dẫn nguồn về đúng trang. Mỗi phiên bản có góp ý riêng, so sánh được, và bản đã duyệt bị khóa.

**Phụ đề**

- Hồ sơ dự án nằm trong một kho: PDF, Word, / Excel, có phân loại và ngày hiệu lực.
- Chữ trong ảnh quét được nhận dạng / bằng OCR và dẫn nguồn về đúng trang.
- Mỗi phiên bản có góp ý riêng, so / sánh được, và bản đã duyệt bị khóa.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=DOC-24`
- `do=click ref=doc.repo.first-file`
- `do=spot ref=doc.repo.ocr-citation`

**Cần thấy trên hình**

- [ ] Màn DOC-24 "Kho hồ sơ dự án" mở được ở đường dẫn /doc/doc-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần doc.repo.first-file đúng lúc giọng đọc nói tới
- [ ] Khung vào phần doc.repo.ocr-citation đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ai-assistant`

Nền tảng: web; 18.2 giây; có trong video chính

Màn hình: `LLM-22` Trợ lý AI: hỏi đáp, tóm tắt, dự thảo thuyết minh, khả thi (/llm/llm-22); `LLM-19` Chính sách phân loại dữ liệu và định tuyến AI (/llm/llm-19)

**Lời đọc**

> Trợ lý AI trả lời, tóm tắt và dự thảo thuyết minh, mỗi nhận định dẫn tới trang và đoạn. Ở bản doanh nghiệp, AI chạy trên mô hình tự đặt tại máy chủ của Tổng công ty, nhà cung cấp ngoài tắt mặc định. AI không quyết định thanh toán.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trợ lý ây-ai trả lời, tóm tắt và dự thảo thuyết minh, mỗi nhận định dẫn tới trang và đoạn. Ở bản doanh nghiệp, ây-ai chạy trên mô hình tự đặt tại máy chủ của Tổng công ty, nhà cung cấp ngoài tắt mặc định. ây-ai không quyết định thanh toán.

**Phụ đề**

- Trợ lý AI trả lời, tóm tắt / và dự thảo thuyết minh,
- mỗi nhận định dẫn tới trang và đoạn.
- Ở bản doanh nghiệp, AI chạy / trên mô hình tự đặt tại máy
- chủ của Tổng công ty, nhà / cung cấp ngoài tắt mặc định.
- AI không quyết định thanh toán.

**Các bước quay**

- `do=open screen=LLM-22`
- `do=click ref=ai.assistant.ask`
- `do=spot ref=ai.assistant.citations`

**Cần thấy trên hình**

- [ ] Màn LLM-22 "Trợ lý AI: hỏi đáp, tóm tắt, dự thảo thuyết minh, khả thi" mở được ở đường dẫn /llm/llm-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn LLM-19 "Chính sách phân loại dữ liệu và định tuyến AI" mở được ở đường dẫn /llm/llm-19, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần ai.assistant.ask đúng lúc giọng đọc nói tới
- [ ] Khung vào phần ai.assistant.citations đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ai-review`

Nền tảng: web; 15.4 giây; chỉ trong chương cắt riêng

Màn hình: `LLM-22` Trợ lý AI: hỏi đáp, tóm tắt, dự thảo thuyết minh, khả thi (/llm/llm-22)

**Lời đọc**

> Trước khi trình, AI rà soát hồ sơ: thiếu tài liệu nào, số nào lệch giữa thuyết minh và biểu mẫu. Kết quả là gợi ý có dẫn nguồn, người lập hồ sơ quyết định sửa hay không, và mọi gợi ý được ghi lại.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Trước khi trình, ây-ai rà soát hồ sơ: thiếu tài liệu nào, số nào lệch giữa thuyết minh và biểu mẫu. Kết quả là gợi ý có dẫn nguồn, người lập hồ sơ quyết định sửa hay không, và mọi gợi ý được ghi lại.

**Phụ đề**

- Trước khi trình, AI rà soát / hồ sơ: thiếu tài liệu nào,
- số nào lệch giữa thuyết minh và biểu mẫu.
- Kết quả là gợi ý có dẫn / nguồn, người lập hồ sơ quyết
- định sửa hay không, và / mọi gợi ý được ghi lại.

**Các bước quay**

- `do=open screen=LLM-22`
- `do=click ref=ai.assistant.review-dossier`

**Cần thấy trên hình**

- [ ] Màn LLM-22 "Trợ lý AI: hỏi đáp, tóm tắt, dự thảo thuyết minh, khả thi" mở được ở đường dẫn /llm/llm-22, có dữ liệu thật, không báo trống hay lỗi
- [ ] Khung vào phần ai.assistant.review-dossier đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `doc-flow`

Nền tảng: web; 13.3 giây; chỉ trong chương cắt riêng

Màn hình: `DOC-24` Kho hồ sơ dự án (/doc/doc-24); `DOC-04` Rà soát và trình ký (/doc/doc-04)

**Lời đọc**

> Hồ sơ trình duyệt đi theo giai đoạn, có thể song song, có bổ sung và trình lại. Mỗi lần bổ sung giữ phiên bản cũ, người duyệt thấy rõ phần nào đã thay đổi so với lần trước.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Hồ sơ trình duyệt đi theo giai đoạn, có thể song song, có bổ sung và trình lại. Mỗi lần bổ sung giữ phiên bản cũ, người duyệt thấy rõ phần nào đã thay đổi so với lần trước.

**Phụ đề**

- Hồ sơ trình duyệt đi theo giai đoạn, có / thể song song, có bổ sung và trình lại.
- Mỗi lần bổ sung giữ / phiên bản cũ, người duyệt
- thấy rõ phần nào đã thay / đổi so với lần trước.

**Các bước quay**

- `do=as persona=projectManager`
- `do=open screen=DOC-04`
- `do=spot ref=doc.review.stage-bar`

**Cần thấy trên hình**

- [ ] Màn DOC-24 "Kho hồ sơ dự án" mở được ở đường dẫn /doc/doc-24, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn DOC-04 "Rà soát và trình ký" mở được ở đường dẫn /doc/doc-04, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản projectManager
- [ ] Khung vào phần doc.review.stage-bar đúng lúc giọng đọc nói tới
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

### `ent-close-trust`

Nền tảng: web; 15.4 giây; có trong video chính

Màn hình: `ADM-11` Nhật ký kiểm toán (/adm/adm-11); `ADM-14` Cấu hình an toàn (/adm/adm-14)

**Lời đọc**

> Phần mềm cài đặt tại chỗ của Tổng công ty. Đăng nhập một lần qua AD kèm xác thực hai lớp, sao lưu có bản bất biến, và được kiểm thử bảo mật độc lập. Mọi thay đổi đều ghi nhật ký kiểm toán.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Phần mềm cài đặt tại chỗ của Tổng công ty. Đăng nhập một lần qua ây-đi kèm xác thực hai lớp, sao lưu có bản bất biến, và được kiểm thử bảo mật độc lập. Mọi thay đổi đều ghi nhật ký kiểm toán.

**Phụ đề**

- Phần mềm cài đặt tại chỗ của Tổng công ty.
- Đăng nhập một lần qua / AD kèm xác thực hai lớp,
- sao lưu có bản bất biến, và / được kiểm thử bảo mật độc lập.
- Mọi thay đổi đều ghi nhật ký kiểm toán.

**Các bước quay**

- `do=as persona=sysAdmin`
- `do=open screen=ADM-14`
- `do=spot ref=adm.security.sso-mfa`

**Cần thấy trên hình**

- [ ] Màn ADM-11 "Nhật ký kiểm toán" mở được ở đường dẫn /adm/adm-11, có dữ liệu thật, không báo trống hay lỗi
- [ ] Màn ADM-14 "Cấu hình an toàn" mở được ở đường dẫn /adm/adm-14, có dữ liệu thật, không báo trống hay lỗi
- [ ] Đăng nhập bằng tài khoản sysAdmin
- [ ] Khung vào phần adm.security.sso-mfa đúng lúc giọng đọc nói tới
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm

### `ent-close-outro`

Nền tảng: title; 16.3 giây; có trong video chính

**Lời đọc**

> Từ kế hoạch vốn đến báo cáo gửi Tập đoàn, một nền tảng web và ứng dụng di động, một bộ chỉ tiêu, mỗi con số có nguồn. Đội ngũ đầu tư ít chép số hơn, lãnh đạo thấy sớm hơn, và kiểm toán dựng lại được từng kỳ.

**Lời gửi cho giọng đọc (đã phiên âm)**

> Từ kế hoạch vốn đến báo cáo gửi Tập đoàn, một nền tảng quép và ứng dụng di động, một bộ chỉ tiêu, mỗi con số có nguồn. Đội ngũ đầu tư ít chép số hơn, lãnh đạo thấy sớm hơn, và kiểm toán dựng lại được từng kỳ.

**Phụ đề**

- Từ kế hoạch vốn đến báo cáo / gửi Tập đoàn, một nền tảng web
- và ứng dụng di động, một bộ / chỉ tiêu, mỗi con số có nguồn.
- Đội ngũ đầu tư ít chép số / hơn, lãnh đạo thấy sớm hơn,
- và kiểm toán dựng lại được từng kỳ.

**Các bước quay**

- `do=animatic id=outro-enterprise`

**Cần thấy trên hình**

- [ ] Thẻ tiêu đề outro-enterprise có tên sản phẩm và dòng dữ liệu minh họa
- [ ] Không hiện nhãn MÔ PHỎNG, tên nội bộ của sản phẩm hay chữ tiếng Anh ngoài tên riêng và từ viết tắt đã có trong bảng phiên âm
