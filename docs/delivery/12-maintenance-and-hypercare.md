# 12. Bảo hành, bảo trì, hypercare, lịch hỗ trợ kỳ chốt và mẫu báo cáo bảo trì định kỳ

Giai đoạn 7 (bảo hành, bảo trì). Dòng ma trận: GD.7; liên quan SP.10, YCK.06, YCK.07, HT.05. PVFCCo phê duyệt: không áp dụng cho giai đoạn 7 (mục II.5 không liệt kê báo cáo bảo trì thành sản phẩm đánh số); báo cáo bảo trì định kỳ được PVFCCo xác nhận theo mục 9 của tệp này.

Tệp này cụ thể hóa các cam kết của giai đoạn 7 ghi ở [10](10-handover-checklist.md) mục 9 và [09](09-acceptance-minutes-template.md) mục 4: mô hình hỗ trợ và trực, kế hoạch hypercare, lịch hỗ trợ trong kỳ chốt, quy tắc đóng băng thay đổi, và mẫu báo cáo bảo trì định kỳ. Mọi con số lấy từ kho mã hoặc thiết kế và có dẫn nguồn; chỗ thiết kế chưa chốt thì ghi rõ chưa chốt và để `[khách điền: ...]`. Không có họ tên, số điện thoại hay thời hạn nào được bịa.

Nguồn: `Design/MACHVON_Design/01_Documents/09_Ke_hoach_trien_khai.md` (mục "Vận hành, hỗ trợ, đào tạo và bàn giao": lịch trực, escalation, runbook từng thành phần, phân loại P0 đến P3 theo tài liệu 10, hypercare; quyết định D10); `Design/MACHVON_Design/01_Documents/10_Ke_hoach_kiem_thu_va_chuyen_doi.md` (định nghĩa P0 đến P3, mục "Defect và điều kiện nghiệm thu", cập nhật CR-TEST-07, CR-TEST-08); câu chuyện ST-KERNEL-105 trong `Design/MACHVON_Design/03_Engineering/implementation_plan.json` (mô hình hỗ trợ, trực, hypercare); `docs/slo-error-budget.md`; `docs/alert-governance.md`; `docs/runbooks/alerts/README.md`; `docs/runbooks/jobs.md`; `docs/runbooks/notification-delivery.md`; `docs/runbooks/outbox-relay-lag.md`; `docs/runbooks/release-checklist.md`; `docs/runbooks/infra/onprem-upgrade-rollback.md`; `docs/runbooks/infra/backup-immutable.md`; `docs/runbooks/infra/restore-drill.md`; `docs/runbooks/infra/security-scanning.md`; `docs/runbooks/infra/sizing-uat-prod.md`; `docs/security/pentest-readiness.md`; `docs/qa/performance.md`; `docs/hpm-ebs-connectors.md`; `docs/integration-hub.md`; `docs/sas-support-access.md`; `packages/kernel/src/reporting-schedule.ts`; `packages/kernel/src/log-capacity.ts`; `infra/policies/operations.json`; `infra/backup/backup-policy.json`.

Trạng thái tệp: v0.1, khung lập ngày 2026-11-12. Phần có thể sinh từ thiết kế và mã nguồn đã điền; phần cần họ tên, điện thoại, thời hạn hợp đồng và quyết định của PVFCCo để trống dạng `[khách điền: ...]`. Giai đoạn 7 chỉ bắt đầu sau khi biên bản nghiệm thu được ký (PX-12); trước đó tệp này là kế hoạch, không phải cam kết đã có hiệu lực.

---

## 1. Phạm vi và cam kết của giai đoạn 7

Các giá trị trong ngoặc vuông là của hồ sơ kỹ thuật PVFCCo (mục II.6.3 và II.8), giữ nguyên như hồ sơ ghi; hợp đồng có thể đặt giá trị khác và khi đó thay ở đây.

| Cam kết theo hồ sơ kỹ thuật | Giá trị theo hồ sơ | Cách thực hiện trong tệp này | Tình trạng |
|---|---|---|---|
| Bảo hành, bảo trì, hỗ trợ vận hành sau nghiệm thu | [12] tháng kể từ ngày ký biên bản nghiệm thu ([09](09-acceptance-minutes-template.md) mục 3, mục 7 của biên bản) | Toàn bộ tệp này | Giá trị ngoặc vuông chưa chốt trong hợp đồng; ngày bắt đầu chờ PX-12 |
| Hỗ trợ trực tiếp hoặc trực tuyến trong kỳ chốt tháng và quý | Không có số cụ thể | Mục 5 (lịch hỗ trợ kỳ chốt, cả kỳ năm và giao ban) | Khung có; người trực: [khách điền] |
| Khắc phục sự cố | Trong vòng 24 giờ kể từ khi nhận thông báo | Mục 2 (mô hình P0 đến P3, thời hạn) | 24 giờ là cam kết của hồ sơ; phân loại mức sự cố nào chịu đồng hồ 24 giờ và tính giờ làm việc hay liên tục: [khách điền] |
| Điều chỉnh biểu mẫu khi PVN hoặc Tổng công ty đổi mẫu | Không phát sinh chi phí ở mức cấu hình | Mục 6.3 (thay mẫu bằng RPT-07, RPT-08, quy tắc `REPORT_LAYOUT`; `docs/report-engine.md`) | Công cụ có; mẫu chính thức chờ PX-01, PX-15 |
| Kiểm tra bảo trì trên UAT trước khi áp dụng | Bắt buộc | Mục 6 (UAT trước, rồi Production trong cửa sổ bảo trì) | Quy trình có; cần môi trường UAT của PVFCCo (PX-11) |
| Chạy lại pentest khi có thay đổi lớn | Khi có thay đổi lớn | Mục 8 (tiêu chí thay đổi lớn đề xuất) | Chờ đơn vị độc lập (PX-09) |
| Khắc phục lỗ hổng mức Critical hoặc High | Trong [07] ngày | Mục 8 (đối chiếu với chính sách xử lý nội bộ) | Có mâu thuẫn thời hạn cần chốt, xem mục 8 |
| Báo cáo bảo trì định kỳ | Không có số cụ thể | Mục 7 (mẫu) | Mẫu có; tần suất và người nhận: [khách điền] |

Không thuộc phạm vi cam kết của tệp này: video hướng dẫn (không thuộc đợt giao này, xem [07](07-training-plan.md) mục 5); ứng dụng điện thoại native iOS và Android ngoài giai đoạn 1; kết nối HPM, EBS, eProcurement và văn thư thật khi PVFCCo chưa cung cấp đặc tả (PX-03, PX-04, PX-06, PX-07): các kết nối đó vận hành theo bộ giả định gắn nhãn PENDING-EXTERNAL.

## 2. Mô hình hỗ trợ

### 2.1 Mức sự cố P0 đến P3

Định nghĩa lấy từ kế hoạch kiểm thử và chuyển đổi của nền tảng (CR-TEST-07), dùng chung cho lỗi và sự cố vận hành.

| Mức | Định nghĩa | Ví dụ trong bối cảnh PVFCCo (đề xuất, PVFCCo xác nhận) |
|---|---|---|
| P0 | Rò dữ liệu giữa các đơn vị hoặc tenant, sai tiền đã công bố, mất dữ liệu, vượt quyền, hoặc tác động ra ngoài không kiểm soát; dừng phát hành | Đầu mối đơn vị A thấy dự án của đơn vị B; số trên báo cáo đã phát hành khác bản chốt; bản chốt kỳ bị mất; đẩy HPM sai nội dung |
| P1 | Luồng lõi không hoàn thành và không có cách xử lý chấp nhận được; chặn cổng | Không đăng nhập được; không nhập hoặc không gửi báo cáo được vào ngày hạn nhập; không chốt kỳ được; không đẩy HPM được khi tới hạn |
| P2 | Có chủ xử lý, cách xử lý tạm và hạn do chủ sản phẩm duyệt | Một biểu mẫu tải PDF lỗi nhưng Excel dùng được; nhắc việc qua email chậm |
| P3 | Như P2, tác động thấp | Lỗi chính tả, hiển thị; trợ giúp trên màn hình chưa rõ |

### 2.2 Thời hạn phản hồi và xử lý

| Mức | Trang tới người trực | Phản hồi đầu tiên | Khắc phục |
|---|---|---|---|
| P0 | Tối đa 5 phút qua kênh vận hành độc lập với mô-đun thông báo (tiêu chí AC-ST-KERNEL-105-1, ca UAT-NFR-OBSERVABILITY-02) | Không dài hơn thời hạn phản hồi P0 của quyết định D10: [khách điền: quyết định D10] | Cam kết hợp đồng 24 giờ kể từ khi nhận thông báo (mục 1); mục tiêu phục hồi khi tuyên bố thảm họa: RPO không quá 15 phút, RTO không quá 4 giờ (`infra/backup/backup-policy.json`) |
| P1 | Cùng kênh | [khách điền: quyết định D10] | [khách điền: quyết định D10]; nằm trong cam kết 24 giờ nếu hợp đồng tính |
| P2 | Hàng đợi hỗ trợ trong giờ làm việc | [khách điền: quyết định D10] | Hạn do chủ sản phẩm duyệt cho từng lỗi |
| P3 | Hàng đợi hỗ trợ | [khách điền: quyết định D10] | Theo kế hoạch phát hành |

Thiết kế nêu rõ thời hạn phản hồi theo mức do quyết định D10 (người quyết: Operations và chủ sản phẩm, hạn go-live) chốt và chưa chốt: tài liệu `Design/MACHVON_Design/01_Documents/09_Ke_hoach_trien_khai.md` ghi "thời gian phản hồi chốt ở D10" và ST-KERNEL-105 ghi "response times and rota depend on D10". Tệp này vì vậy không đặt số cho P1 đến P3. Ràng buộc đã có của thiết kế: SLA thương mại (D10) không được cao hơn mục tiêu nội bộ 99,9% mỗi 30 ngày, tức ngân sách lỗi 43,2 phút (`docs/slo-error-budget.md`); thời gian diễn tập khôi phục tính vào cùng ngân sách. Sau sự cố P0 hoặc P1, nhà cung cấp lập biên bản sau sự cố trong không quá 5 ngày làm việc (mức tối đa của chính sách vận hành, `infra/policies/operations.json`, khóa `maxPostMortemWorkingDays`).

### 2.3 Đường leo thang

| Bậc | Ai | Việc | Họ tên, điện thoại |
|---|---|---|---|
| 1 | Người dùng và người quản trị đơn vị (đầu mối) | Báo sự cố cho đầu mối hỗ trợ của Ban CĐS&CNTT; ghi mã màn hình, giờ, ảnh chụp | [khách điền] |
| 2 | Ban CĐS&CNTT của PVFCCo (hạ tầng, tài khoản, AD) cùng đầu mối hỗ trợ của nhà cung cấp | Phân loại P0 đến P3, xử lý theo runbook của cảnh báo (`docs/runbooks/alerts/`) hoặc của hạ tầng (`docs/runbooks/infra/`) | [khách điền] |
| 3 | Kỹ sư nền tảng và cơ sở dữ liệu của nhà cung cấp (trực) | Sửa, khôi phục, quay lui; đọc nhật ký kiểm toán (ADM-11) | [khách điền] |
| 4 | Tổ chuẩn hóa dữ liệu, Trưởng Ban KHĐT (nghiệp vụ); Phó Ban phụ trách Ban CĐS&CNTT (hạ tầng); chủ sản phẩm của nhà cung cấp | Quyết định mở lại kỳ, hoãn đẩy HPM, chấp nhận giảm thiểu, thông báo lên Tổng Giám đốc | [khách điền] |

Trong sản phẩm, một cảnh báo không ai nhận cũng tự leo thang theo chính sách `ESCALATION_POLICY` (giờ làm việc giữa các bậc, tính trên lịch làm việc đã công bố; giá trị mặc định UNVERIFIED, `docs/alert-governance.md`). Cảnh báo vận hành (OUTBOX_LAG, SLO_FAST_BURN, AUDIT_CHAIN_BROKEN, cảnh báo hạ tầng) đi qua kênh trực vận hành độc lập với mô-đun thông báo, chủ xử lý `platform-oncall` hoặc `security-oncall` (`docs/runbooks/alerts/README.md`); cảnh báo nghiệp vụ (nhắc kỳ, đẩy HPM, độ mới kết nối) đi qua trung tâm cảnh báo tới người giữ vai trò.

### 2.4 Kênh liên lạc

| Kênh | Dùng cho | Thông tin của PVFCCo |
|---|---|---|
| Đường dây trực vận hành (ops-pager, độc lập với mô-đun thông báo) | Trang P0 và P1 cho người trực | [khách điền: tên kênh, số điện thoại hoặc địa chỉ nhận; cần cấu hình đích trang khi cài, PX-11] |
| Hộp thư hoặc phiếu hỗ trợ | Báo sự cố P2, P3, yêu cầu thay đổi, câu hỏi | [khách điền: địa chỉ, giờ nhận] |
| Điện thoại đường dây nóng | Báo P0, P1 ngoài giờ | [khách điền] |
| Teams hoặc email nhắc việc của hệ thống | Nhắc việc kỳ, thông báo; không dùng làm kênh trang sự cố | Chờ bộ chuyển tiếp của PVFCCo (PX-16) |
| Truy cập hỗ trợ có kiểm soát (SAS-19) | Khi nhà cung cấp cần đọc dữ liệu của PVFCCo để xử lý sự cố: cần phiếu, đồng ý của chủ tenant hoặc quản trị tenant, tối đa 8 giờ, ghi nhật ký như mạo danh (`docs/sas-support-access.md`) | Người chấp thuận phía PVFCCo: [khách điền] |

### 2.5 Mẫu lịch trực

Giờ hỗ trợ thường: [khách điền: ngày, giờ]. Giờ hỗ trợ mở rộng (hypercare và các ngày hạn của mục 5): [khách điền: ngày, giờ].

| Tuần hoặc ngày | Người trực chính (nhà cung cấp) | Người dự phòng | Người trực phía PVFCCo (Ban CĐS&CNTT) | Người trực nghiệp vụ (Ban KHĐT) |
|---|---|---|---|---|
| [khách điền] | [họ tên, điện thoại] | [họ tên, điện thoại] | [họ tên, điện thoại] | [họ tên, điện thoại] |

Quy tắc đề xuất: luôn có người dự phòng; không để một người trực hai ca liền khi có P0; thay ca có bàn giao bằng văn bản; danh sách trực của kỳ chốt (mục 5) công bố trước hạn nhập ít nhất 5 ngày làm việc.

### 2.6 Sổ sự cố

Mỗi sự cố ghi: mã, mức, giờ nhận, giờ phản hồi đầu, giờ khắc phục, người xử lý, nguyên nhân gốc, cách sửa, mã lỗi hay thay đổi liên quan, đã báo cho ai. Sổ là nguồn của bảng sự cố trong báo cáo bảo trì (mục 7.3).

## 3. Kế hoạch hypercare

Thiết kế (TK-KERNEL-105-3) nêu hypercare là giai đoạn hỗ trợ mở rộng sau go-live: giờ hỗ trợ kéo dài, rà soát hằng ngày, tiêu chí thoát. Thiết kế không nêu thời lượng; các điểm dưới đây về thời lượng là đề xuất của nhà cung cấp, PVFCCo quyết định.

### 3.1 Thời lượng

| Mục | Nội dung |
|---|---|
| Bắt đầu | Ngày PVFCCo đưa hệ thống vào sử dụng chính thức, sau biên bản nghiệm thu (PX-12) |
| Kết thúc | Khi đạt đủ tiêu chí thoát ở 3.4; không sớm hơn hết kỳ chốt thứ hai sau go-live (đề xuất, vì hồ sơ đã yêu cầu chạy song song hai kỳ trước nghiệm thu) |
| Số tuần hoặc tháng | [khách điền: quyết định của PVFCCo] |
| Giờ hỗ trợ | Mở rộng so với giờ thường ở 2.5: [khách điền] |

### 3.2 Điểm kiểm

| Chu kỳ | Việc | Người làm |
|---|---|---|
| Hằng ngày (trong hypercare) | Họp ngắn rà soát 24 giờ: cảnh báo đã bắn và đã nhận; sự cố mở; tuổi bản sao lưu đầy đủ (dưới 26 giờ); độ trễ outbox; hàng đợi gửi lỗi; sức khỏe kết nối ở HUB-01; lần đẩy HPM chờ biên nhận; số người đăng nhập và lỗi đăng nhập | Nhà cung cấp, Ban CĐS&CNTT |
| Hằng tuần | Tổng hợp P0 đến P3 mở và đã đóng; câu hỏi lặp của người dùng (bổ sung trợ giúp trên màn hình); kiểm kho sao lưu (kiểm tra kho chạy sáng Chủ nhật); số kỳ và đầu mối còn thiếu ở DIS-34 | Nhà cung cấp, Ban KHĐT |
| Mỗi kỳ chốt | Theo bảng ở mục 5; kết thúc bằng một dòng tóm tắt gửi Ban KHĐT | Nhà cung cấp |
| Cuối hypercare | Họp thoát, ký xác nhận (mục 3.4) | Ban CĐS&CNTT, Ban KHĐT, nhà cung cấp |

### 3.3 Những gì được theo dõi

| Đối tượng | Chỉ báo và cảnh báo | Nơi xem hoặc runbook |
|---|---|---|
| Khả dụng | Ngân sách lỗi 30 ngày (43,2 phút), `slo_error_budget_remaining_percent`; cảnh báo `SLO_FAST_BURN`, `SLO_SLOW_BURN`, `SLO_BUDGET_EXHAUSTED` | `docs/slo-error-budget.md`; SAS-18 (sức khỏe toàn nền tảng) |
| Sao lưu | `pg-backup-age` (bản đầy đủ quá 26 giờ), `pg-wal-archive-failure` (lưu WAL lỗi hoặc cũ quá 120 giây), lần kiểm kho hằng tuần | ADM-32; `docs/runbooks/infra/backup-immutable.md`; `infra/alerts/postgres.json` |
| Độ trễ outbox | `OUTBOX_LAG` (sự kiện cũ nhất quá 300 giây), `OUTBOX_EVENT_DEAD` | `docs/runbooks/outbox-relay-lag.md` |
| Công việc nền | `JOB_FAILED`; các job `dis-period-autoclose`, `calendar-reminder`, `retention-purge`, `report-mail-runner` | `docs/runbooks/jobs.md` |
| Gửi thông báo | `NOTIFICATION_DLQ_BACKLOG`, `NOTIFICATION_UNKNOWN_STALE`, `CHANNEL_CIRCUIT_OPEN` | NOT-11, NOT-13; `docs/runbooks/notification-delivery.md` |
| Sức khỏe kết nối (hub) | Mỗi bộ kết nối `FRESH`, `AGING`, `STALE` hoặc `NEVER_PUSHED`; `CONNECTOR_FAILING`, `CONNECTOR_STALE`; hộp thư sự kiện chết `INTEGRATION_INBOX_DEAD` | HUB-01 đến HUB-03; `docs/integration-hub.md` |
| Độ mới của lần đẩy HPM | `HPM_PUSH_FAILED` (đẩy lỗi chưa ai thử lại), `HPM_PUSH_STALE` (lần giao gần nhất quá hạn quy tắc `HPM_PUSH_POLICY`); biên nhận chờ ghi | HPM-01; `docs/hpm-ebs-connectors.md` |
| Độ mới tệp EBS | Quy tắc `CONNECTOR_FRESHNESS` mã `EBS_FILE` | EBS-01, HUB-01 |
| Toàn vẹn nhật ký | `AUDIT_CHAIN_BROKEN` | `docs/runbooks/audit-tamper-drill.md` |
| Dung lượng log | `LOG_CAPACITY_NEAR`, `LOG_CAPACITY_EXCEEDED` | ADM-30; `docs/runbooks/retention.md` |
| Giấy phép | `LICENSE_EXPIRING` | `docs/runbooks/alerts/LICENSE_EXPIRING.md` |
| Hiệu năng | p95 so với ngân sách 5 giây và 20 giây (82 thao tác, 20 mẫu) | `node scripts/perf-budget.mjs`; `docs/qa/performance.md`; BI-13 cho truy vấn BI |
| Lịch kỳ | Bảng trạng thái nhập theo đầu mối, bước quá hạn, kỳ sắp tự chốt | DIS-34, DIS-15, DIS-14 |
| Bản vá và lỗ hổng | Kiểm thư viện hằng ngày, quét ảnh, SBOM | `docs/runbooks/supply-chain.md`; `docs/runbooks/infra/security-scanning.md` |

### 3.4 Tiêu chí thoát (đề xuất)

1. Không còn P0 hoặc P1 mở; P2, P3 mở đều có chủ, cách xử lý tạm và hạn.
2. Hai kỳ chốt liên tiếp sau go-live (một kỳ tháng, một kỳ gồm cả kỳ quý nếu rơi vào) chạy đúng lịch ở mục 5: kỳ khóa đúng hạn, bản chốt đủ, mọi lần đẩy HPM có biên nhận hoặc lý do ghi rõ.
3. Ngân sách lỗi 30 ngày không cạn; không cảnh báo mức critical chưa xử lý quá hạn trong 14 ngày liền (ngưỡng đề xuất: [khách điền]).
4. Sao lưu đầy đủ hằng ngày thành công, và lần kiểm kho hằng tuần cuối cùng đạt; sổ diễn tập khôi phục (`infra/backup/restore-drill-ledger.json`) có ít nhất một dòng, lần diễn tập đầu thực hiện trước hạn ghi trong sổ (2027-01-31), tại PVFCCo (PX-11).
5. Người dùng của các đầu mối tự xử lý được tác vụ lõi không cần trợ giúp tại chỗ (mục tiêu của nền tảng: từ 90% tác vụ, [07](07-training-plan.md) mục 6).
6. Biên bản thoát hypercare có chữ ký (mục 9).

## 4. Bảo trì thường kỳ

| Chu kỳ | Việc | Nguồn, lệnh |
|---|---|---|
| Hằng ngày | Đọc cảnh báo; kiểm tuổi bản sao lưu; kiểm thư viện và lỗ hổng (nhà cung cấp, tự động hằng ngày 02:17 UTC) | `docs/runbooks/supply-chain.md` |
| Hằng tuần | Kiểm kho sao lưu (Chủ nhật 03:30); sao lưu gia tăng sự khác biệt (differential) chạy Chủ nhật 12:30; quét an ninh ứng dụng bằng ZAP trên máy thử | `infra/backup/backup-policy.json`; `docs/runbooks/infra/security-scanning.md` |
| Hằng tháng | Sao lưu đầy đủ vào kho lưu trữ thứ hai ngày mùng 1 lúc 03:00 (giữ 12 bản); sao chép ngoại tuyến do hai người giữ khóa thực hiện sau đó; báo cáo bảo trì (mục 7) nếu tần suất là tháng | `docs/runbooks/infra/backup-immutable.md` |
| Hằng quý | Diễn tập khôi phục (tối đa 92 ngày giữa hai lần, `node scripts/backup-verify.mjs drill-status` báo tuổi lần diễn tập gần nhất); rà soát vai trò và ủy quyền; xoay bí mật không quá 90 ngày một lần (`maxRotationDays`) | `docs/runbooks/infra/restore-drill.md`; `docs/runbooks/infra/secrets-rotation.md` |
| Mỗi lần có bản phát hành | Quy trình ở mục 6 | `docs/runbooks/release-checklist.md` |
| Đầu năm | Công bố lịch làm việc `WORKDAY_VN` của năm mới (job tự khóa kỳ cần lịch này: năm chưa có lịch thì kỳ chốt mềm giữ nguyên trạng thái chốt mềm) và rà soát hạn từng bước của lịch kỳ ở ADM-31 | `docs/runbooks/jobs.md`; DIS-34 |

## 5. Lịch hỗ trợ kỳ chốt

### 5.1 Nguyên tắc

Hạn của từng bước lấy từ quy tắc quản trị `REPORTING_SCHEDULE` đang hiệu lực (mỗi loại kỳ một mã: `MONTH`, `QUARTER`, `YEAR`, `MEETING`, `PLAN_ADJUSTMENT`; đổi ở ADM-31; xem ở DIS-34); mặc định của mã là hạn nhập ngày mùng 5 của tháng sau cho kỳ tháng (`MONTHLY_DEADLINE_DAY = 5`). Các hạn mặc định là giá trị khởi đầu gắn UNVERIFIED chờ Tổ chuẩn hóa dữ liệu xác nhận (D03; mục 4 của sổ [11](11-pending-external-register.md)). Khi PVFCCo đổi hạn bằng ADM-31, bảng 5.2 phải sinh lại từ DIS-34; không sửa tay con số ở đây mà không đổi quy tắc.

### 5.2 Hạn mặc định theo loại kỳ

Số ngày tính sau ngày cuối kỳ (giao ban: sau ngày họp), theo `packages/kernel/src/reporting-schedule.ts`. Tự khóa kỳ: job `dis-period-autoclose` chốt mềm kỳ khi quá hạn nhập và khóa kỳ 3 ngày làm việc sau hạn nhập (giả định D03, lịch `WORKDAY_VN`); riêng bản doanh nghiệp, kỳ tháng, quý, năm chỉ khóa sau khi bước rà soát Ban KHĐT và bước chốt kỳ đã xong (INT-2; `docs/runbooks/jobs.md`).

| Loại kỳ | Nhập liệu (hạn nhập) | Duyệt đơn vị | Ban KHĐT rà soát | Chốt kỳ | Đẩy hệ thống Tập đoàn | Tự khóa kỳ |
|---|---|---|---|---|---|---|
| Tháng | 5 | 7 | 10 | 12 | 15 | 3 ngày làm việc sau hạn nhập, và không trước khi rà soát và chốt kỳ xong |
| Quý | 10 | 13 | 17 | 20 | 25 | như trên |
| Năm | 20 | 30 | 40 | 45 | 60 | như trên |
| Giao ban (tính từ ngày họp) | 2 | 4 | 6 | 8 | 10 | như trên |
| Điều chỉnh kế hoạch trong năm (tính từ cuối quý) | 10 | 15 | 20 | 25 | 30 | như trên |

Quy tắc tự khóa kỳ đã được chốt theo hướng quản trị chặt nhất (INT-2, bản doanh nghiệp): kỳ không tự khóa trước khi Ban KHĐT rà soát (ngày 10 của kỳ tháng) và bước chốt kỳ (ngày 12) xong, dù 3 ngày làm việc kể từ hạn nhập (khoảng ngày 8 đến 10) đã qua; bước có dữ kiện duyệt theo tầng thì chờ mọi hồ sơ của kỳ qua bước, bước chưa có dữ kiện thì chờ qua hạn trong lịch ([08](08-parallel-run-plan.md) mục 3, `docs/runbooks/jobs.md`). Kỳ bị giữ hiện ở kết quả job `dis-period-autoclose` (`held`) và ở bộ đếm `dis_period_lock_held_total`; người có quyền vẫn khóa tay được. Số ngày của lịch và số 3 ngày làm việc vẫn là giả định D03 để PVFCCo xác nhận, không tự đổi con số.

### 5.3 Việc của hỗ trợ theo mốc

Ký hiệu: T0 là hạn nhập của kỳ (bước `ENTRY`); T-3 và T-1 là ba ngày và một ngày trước T0; các bước sau lấy số ngày ở 5.2. Ví dụ kỳ tháng mặc định: T-3 là ngày 2, T0 là ngày 5, duyệt đơn vị ngày 7, rà soát ngày 10, chốt ngày 12, đẩy HPM ngày 15 của tháng sau.

| Mốc | Việc của hỗ trợ | Người trực | Công cụ |
|---|---|---|---|
| T-3 (trùng nhắc việc đầu tiên của hệ thống, ba ngày trước hạn) | Kiểm trước kỳ: bản sao lưu đầy đủ dưới 26 giờ; kho sao lưu kiểm tuần gần nhất đạt; không còn bản nâng cấp đang chờ; lịch làm việc của năm đã công bố; ủy quyền và vắng mặt của người nhập và người duyệt (ADM-25, ADM-28); kết nối HPM và EBS (HUB-01); danh sách trực công bố; bắt đầu giờ hỗ trợ mở rộng | Nhà cung cấp, Ban CĐS&CNTT | HUB-01, DIS-34, ADM-32 |
| T-1 (nhắc việc thứ hai) | Gọi hoặc nhắn đầu mối chưa bắt đầu nhập (bảng trạng thái nhập theo đầu mối); kiểm tải và hàng đợi; chuẩn bị xử lý tệp nhập Excel lỗi (IND-03); không thay đổi cấu hình nào | Hỗ trợ nghiệp vụ, Ban KHĐT | DIS-34, DIS-15 |
| T0 (hạn nhập) | Trực cả ngày giờ mở rộng; xử lý lỗi nhập, lỗi quy tắc, tài khoản khóa; theo dõi tải (giả định cấu hình 40 người dùng đồng thời giờ cao điểm, `docs/runbooks/infra/sizing-uat-prod.md` mục 1) và hàng đợi gửi; báo Ban KHĐT đầu mối nào chưa nộp cuối ngày | Nhà cung cấp, Ban CĐS&CNTT | DIS-34, NOT-11, các cảnh báo mục 3.3 |
| Sau hạn nhập | Kỳ tự chốt mềm (job quét mỗi 15 phút); báo cáo nộp trễ được đánh dấu trễ nhưng vẫn nhận; nếu đầu mối thiếu số: Ban KHĐT đề nghị mở lại, người duyệt khác người đề nghị | Hỗ trợ nghiệp vụ | DIS-14, DIS-22 |
| Hạn duyệt đơn vị | Theo dõi hàng đợi duyệt; nhắc người duyệt chưa xử lý (job `approval-sla` nhắc ở 80% hạn); xử lý ủy quyền khi người duyệt vắng | Hỗ trợ nghiệp vụ | ADM-18, ADM-26 |
| Hạn Ban KHĐT rà soát | Hỗ trợ Ban KHĐT dựng và rà soát bản chốt doanh nghiệp (DIS-32, DIS-33), chạy so sánh chéo báo cáo (RPT-09) và hướng dẫn giải trình chênh lệch; không để kỳ khóa khi còn đơn vị thiếu số liệu | Nhà cung cấp, Ban KHĐT | DIS-32, DIS-33, RPT-09 |
| Hạn chốt kỳ (bước `PERIOD_CLOSE`) | Chốt kỳ và đóng băng số liệu (DIS-21), chốt bản chốt doanh nghiệp (người chốt khác người dựng); ghi băm SHA-256 và số bản của bản chốt vào báo cáo bảo trì; từ đây mọi sửa phải qua mở lại kỳ có lý do | Ban KHĐT, nhà cung cấp | DIS-21, DIS-33 |
| Hạn đẩy HPM (bước `PUSH`) | Đẩy báo cáo đã phát hành (HPM-01), theo dõi biên nhận; lỗi thì đẩy lại cùng khóa; biên nhận do người khác người đẩy ghi; xử lý `HPM_PUSH_FAILED` và `HPM_PUSH_STALE`; hiện chạy trên bộ ghi tệp giả định cho tới khi có PX-03 | Quản trị tích hợp, Ban KHĐT | HPM-01, HUB-03 |
| Sau hạn đẩy (ngày làm việc kế tiếp; nhận biên nhận và đính chính) | Nhận biên nhận; nếu HPM đã nhận mà số phải sửa: đính chính (HPM-02) cần kỳ đã mở lại và hai người; kiểm lại outbox, bản sao lưu đầy đủ đêm đó, nhật ký chốt kỳ, mở lại kỳ và đẩy HPM đủ người, giờ, lý do; kết thúc giờ hỗ trợ mở rộng; ghi tóm tắt kỳ | Nhà cung cấp, Ban KHĐT | HPM-02, ADM-11 |

Lưu ý: hai bước Ban KHĐT rà soát và đẩy hiện hiển thị CHƯA THEO DÕI trên DIS-34 vì chưa có dữ kiện hoàn thành nối từ quy trình duyệt ([08](08-parallel-run-plan.md) mục 3); người hỗ trợ theo dõi hai bước này bằng RPT-03, HPM-01 và ADM-18, và không đọc "CHƯA THEO DÕI" là đã xong hay còn mở.

### 5.4 Người trực theo vai trò

| Vai trò | Trách nhiệm trong kỳ chốt | Họ tên, điện thoại |
|---|---|---|
| Đầu mối hỗ trợ của nhà cung cấp | Nhận và phân loại sự cố, điều phối, liên lạc với Ban KHĐT | [khách điền: họ tên, điện thoại] |
| Kỹ sư nền tảng trực | Sửa lỗi, quay lui, khôi phục, đọc nhật ký | [khách điền: họ tên, điện thoại] |
| Ban CĐS&CNTT của PVFCCo | Hạ tầng, tài khoản, AD, SMTP và Teams của PVFCCo | [khách điền: họ tên, điện thoại] |
| Chuyên viên tổng hợp Ban KHĐT | Nghiệp vụ kỳ: rà soát, trả về, chốt, mở lại, đẩy HPM | [khách điền: họ tên, điện thoại] |
| Quản trị tích hợp | Kết nối HPM, EBS; xử lý sự cố ở HUB-03 | [khách điền: họ tên, điện thoại] |
| Người ghi biên nhận HPM | Ghi biên nhận (khác người đẩy) | [khách điền: họ tên, điện thoại] |
| Người quyết định mở lại kỳ | Duyệt đề nghị mở lại (khác người đề nghị) | [khách điền: họ tên, điện thoại] |

### 5.5 Quy tắc đóng băng trong kỳ chốt

Cửa sổ đóng băng (đề xuất): từ T-3 của kỳ đến hết ngày đẩy HPM cộng một ngày làm việc; ngày bắt đầu và kết thúc do PVFCCo xác nhận: [khách điền]. Với kỳ quý và năm cửa sổ dài hơn theo bảng 5.2; hai kỳ giao nhau thì đóng băng liền nhau.

1. Không nâng cấp phiên bản, không chạy migration, không đổi cấu hình hạ tầng, không bảo trì kho sao lưu trong cửa sổ.
2. Không đổi quy tắc nhập liệu, công thức chỉ tiêu, bố cục biểu mẫu, hạn từng bước của lịch kỳ trong cửa sổ, trừ khi sửa P0 hoặc P1 và có đồng ý của Tổ chuẩn hóa dữ liệu; mọi thay đổi vẫn qua soạn, trình, duyệt khác người.
3. Ngoại lệ khẩn (bản vá bảo mật Critical hoặc sửa P0): theo quy trình nâng cấp có sao lưu đầy đủ và kiểm trước, rollback trong 15 phút (`docs/runbooks/infra/onprem-upgrade-rollback.md`), ghi vào báo cáo bảo trì; có xác nhận bằng văn bản của Phó Ban phụ trách Ban CĐS&CNTT.
4. Bản nâng cấp đã chuẩn bị được áp dụng sau cửa sổ, vào cửa sổ bảo trì đã thông báo, sau khi chạy trên UAT (mục 6).

## 6. Thay đổi, phát hành và bản vá

### 6.1 Quy trình

1. Mọi bản phát hành qua `docs/runbooks/release-checklist.md` (các cổng tự động, cổng người, bằng chứng đính kèm) và mang đủ: phiên bản, ghi chú phát hành, danh sách migration, bí mật và biến môi trường mới, SBOM.
2. Cài trên UAT của PVFCCo trước, chạy bộ kiểm tra sau cài, rồi mới vào Production trong cửa sổ bảo trì (bản cài tại chỗ là một khách: tương đương canary là UAT trước, Production sau; `docs/runbooks/infra/onprem-upgrade-rollback.md`).
3. Trước nâng cấp: bản sao lưu đầy đủ dưới 26 giờ và có diễn tập khôi phục trong quý; sau nâng cấp: đăng nhập có MFA, mở một màn hình mỗi mô-đun đang dùng, `/api/health/ready` trả 200, kênh cảnh báo yên lặng 15 phút.
4. Quay lui bản ứng dụng trong 15 phút bằng tệp rollback của gói cũ (mẫu: `infra/onprem/bundle/rollback.sh`); cơ sở dữ liệu không quay lui (migration theo kiểu mở rộng rồi thu hẹp, bản N-1 chạy được với lược đồ bản N); lỗi dữ liệu dùng khôi phục.
5. Mỗi thay đổi ghi vào bảng 7.4 của báo cáo bảo trì, kèm việc đã thử quay lui hay chưa.

### 6.2 Phân loại thay đổi

| Loại | Ví dụ | Thử trên UAT | Báo trước PVFCCo |
|---|---|---|---|
| Khẩn | Bản vá bảo mật Critical, sửa P0 | Bản thử tối thiểu | Ngay khi áp dụng, kèm biên bản |
| Thường | Sửa lỗi, bản phát hành định kỳ | Đầy đủ | [khách điền: số ngày làm việc báo trước] |
| Cấu hình | Đổi hạn lịch kỳ, quy tắc, danh mục, bố cục | Theo quy trình soạn, trình, duyệt khác người | Theo quy trình duyệt của PVFCCo |

### 6.3 Điều chỉnh biểu mẫu khi mẫu đổi

PVN hoặc Tổng công ty đổi mẫu: soạn bố cục mới bằng RPT-07, RPT-08 (quy tắc `REPORT_LAYOUT` có phiên bản, người duyệt khác người soạn); xem trước, so với tệp mẫu chính thức; áp dụng từ kỳ nào do PVFCCo chọn; mẫu cũ giữ để xuất lại cho kỳ đã phát hành. Không cần phát hành phần mềm nếu bố cục nằm trong phạm vi cấu hình. Bố cục chính thức của sáu biểu mẫu chưa có (PX-01, PX-15); sáu biểu mẫu hiện mang dấu MẪU DEMO.

## 7. Mẫu báo cáo bảo trì định kỳ

Tần suất: [khách điền: hằng tháng hoặc theo thỏa thuận]. Người nhận: [khách điền: Ban CĐS&CNTT, Ban KHĐT]. Mỗi báo cáo gồm các bảng dưới đây. Cột "Từ hệ thống" cho biết ô có thể điền từ hệ thống: Có (đọc được ở màn hình hay xuất được, nêu mã), Một phần (cần thêm nguồn ngoài ứng dụng như máy chủ hoặc kho đối tượng) hoặc Không (nhập tay). Mã màn hình đã đối chiếu với `Design/MACHVON_Design/03_Engineering/screen_catalog.json`, tên thao tác với `Design/MACHVON_Design/03_Engineering/openapi.json` ngày 2026-11-12.

### 7.1 Đầu báo cáo

| Trường | Nội dung | Từ hệ thống |
|---|---|---|
| Số báo cáo, ngày lập | [điền khi lập] | Không |
| Kỳ báo cáo (từ ngày, đến ngày) | [điền khi lập] | Không |
| Người lập (nhà cung cấp), người nhận (PVFCCo) | [họ tên, chức danh] | Không |
| Phiên bản phần mềm đang chạy và đã chạy trong kỳ, lược đồ cơ sở dữ liệu | Ghi từ bản phát hành đã cài (tệp manifest của gói, ghi chú phát hành) | Một phần: gói cài và `/var/lib/machvon/previous-version` trên máy chủ |
| Môi trường | UAT hoặc Production; tên máy chủ chính thức | Không (chờ PX-11) |

### 7.2 Khả dụng, hiệu năng và vận hành

| Chỉ tiêu | Mục tiêu | Nguồn dữ liệu | Từ hệ thống |
|---|---|---|---|
| Khả dụng 30 ngày, phút ngân sách lỗi đã dùng và còn | 99,9% mỗi 30 ngày, ngân sách 43,2 phút | Gauge `slo_error_budget_consumed_minutes`, `slo_error_budget_remaining_percent` (`docs/slo-error-budget.md`); SAS-18 | Có |
| Cảnh báo vận hành đã bắn, theo mức, đã nhận và đóng | Không critical mở quá hạn | Kênh vận hành (`docs/runbooks/alerts/README.md`); sổ loại cảnh báo ADM-23 cho loại cảnh báo nghiệp vụ | Một phần |
| Thời gian phản hồi p95 các thao tác chính | Dưới 5 giây (chức năng), dưới 20 giây (báo cáo) | `node scripts/perf-budget.mjs --base-url ... --out báo-cáo.json` (82 thao tác trong `docs/qa/perf-budget.json`: 67 chức năng, 15 báo cáo); BI-13 cho truy vấn BI | Một phần: chạy bằng lệnh với mã truy cập |
| Số lần sao lưu thành công và thất bại; tuổi bản sao lưu đầy đủ gần nhất | Dưới 26 giờ; thành công mỗi ngày | ADM-32 (lần sao lưu gần nhất theo loại, lần kiểm gần nhất); cảnh báo `pg-backup-age`; `listBackupRequests` cho yêu cầu thủ công | Có |
| Ngày diễn tập khôi phục gần nhất và kết quả | Không quá 92 ngày giữa hai lần | `infra/backup/restore-drill-ledger.json`; `node scripts/backup-verify.mjs drill-status` | Một phần: sổ tệp trên kho mã của nhà cung cấp |
| Độ trễ outbox: cũ nhất, số sự kiện chết | Dưới 300 giây; 0 sự kiện chết | Gauge `outbox_oldest_pending_seconds`, `outbox_dead_total` (`docs/runbooks/outbox-relay-lag.md`) | Có (qua giám sát) |
| Sức khỏe kết nối: số bộ kết nối FRESH, AGING, STALE, NEVER_PUSHED; sự cố mở | Không STALE quá hạn | HUB-01, HUB-03 (`listHubConnectors`, `getHubHealthSummary`) | Có |
| Tóm tắt đẩy HPM: số lần đẩy, thành công, đẩy lại, chờ biên nhận, từ chối, đính chính | Mọi lần đẩy có biên nhận hoặc lý do | HPM-01, HPM-02 (`listHpmPushes`, `listHpmCorrections`) | Có |
| Công việc nền lỗi | 0 `JOB_FAILED` chưa xử lý | Cảnh báo `JOB_FAILED`; `docs/runbooks/jobs.md` | Có |
| Hàng đợi gửi lỗi, thông báo không rõ kết quả | Không quá ngưỡng cảnh báo | NOT-11, NOT-13 | Có |

### 7.3 Sự cố

| Mã | Mức (P0 đến P3) | Mở lúc | Phản hồi lúc | Đóng lúc | Nguyên nhân gốc | Cách sửa | Biên bản sau sự cố |
|---|---|---|---|---|---|---|---|
| [điền khi có] | | | | | | | Trong 5 ngày làm việc với P0, P1 |

Nguồn: sổ sự cố (mục 2.6) và nhật ký kiểm toán (ADM-11, xuất `exportAuditLog` dạng CSV hoặc JSONL để kiểm chứng). Từ hệ thống: Một phần (các sự cố do cảnh báo bắn có dấu vết; sự cố do người dùng báo ghi tay).

### 7.4 Thay đổi và phát hành

| Phiên bản | Ngày áp dụng | Nội dung (ghi chú phát hành) | Migration | Thử trên UAT | Đã thử quay lui | Người duyệt phía PVFCCo |
|---|---|---|---|---|---|---|
| [điền khi có] | | | Có hoặc không; danh sách | Có hoặc không | Có hoặc không, thời gian | [khách điền] |

Nguồn: bản phát hành đã cài (tệp CHANGELOG do `node scripts/release.mjs cut` sinh, `docs/runbooks/release-checklist.md` mục 7), danh mục `db/migrations/`. Từ hệ thống: Một phần.

### 7.5 An toàn thông tin và bản vá

| Chỉ tiêu | Nguồn | Từ hệ thống |
|---|---|---|
| Kết quả kiểm thư viện và SBOM của bản đang chạy (số lỗ hổng theo mức Critical, High, Medium, Low) | `npm run sbom`, `npm run supply-chain:check -- --audit`; quét ảnh Trivy (`docs/runbooks/infra/security-scanning.md`) | Một phần: do nhà cung cấp chạy trên bản phát hành |
| Lỗ hổng đã phát hiện, ngày phát hiện, ngày sửa, số ngày xử lý so với hạn ở mục 8 | Sổ lỗ hổng của nhà cung cấp (mỗi dòng: chủ, hạn, lý do); ngoại lệ có thời hạn không quá 90 ngày trong `supply-chain.json` | Không |
| Pentest và retest: lần gần nhất, kết quả, lỗ hổng mở | Báo cáo của đơn vị độc lập (PX-09) | Không (chờ PX-09) |
| Bí mật đã xoay trong kỳ (tên, ngày; không ghi giá trị) | Sổ xoay bí mật (`docs/runbooks/infra/secrets-rotation.md`) | Không |
| Số lần truy cập hỗ trợ có kiểm soát của nhà cung cấp: ai, phiếu nào, bao lâu | SAS-19 (`support_access_grant`) | Có |

### 7.6 Sửa số liệu và nhật ký

| Chỉ tiêu | Nguồn | Từ hệ thống |
|---|---|---|
| Số lần đề nghị mở lại kỳ, được duyệt, từ chối, hết hạn; lý do; kỳ và dự án liên quan | DIS-22 (`requestPeriodReopen`, `decidePeriodReopen`); nhật ký ADM-11 | Có |
| Số lần đính chính kỳ đã được HPM nhận (HPM-02) | `listHpmCorrections` | Có |
| Số lần bản chốt doanh nghiệp được chốt lại (bản mới, băm cũ không đổi) | DIS-33 (`listEnterpriseSnapshots`) | Có |
| Loại đối tượng bật nhật ký giá trị trước và sau, thay đổi chính sách trong kỳ | ADM-29 (`listAuditDetailPolicies`) | Có |
| Xuất nhật ký kiểm toán để đối chiếu hoặc kiểm toán nội bộ, kết quả kiểm chứng toàn vẹn | ADM-11 (`exportAuditLog`; kiểm chứng `verifyAuditExport`, `docs/runbooks/audit-export.md`) | Có |

### 7.7 Dung lượng

| Chỉ tiêu | Mức tham chiếu | Nguồn | Từ hệ thống |
|---|---|---|---|
| Dung lượng cơ sở dữ liệu | Giả định cấu hình: 20 GB khi vận hành, tăng 10 GB mỗi năm; cảnh báo đĩa 80% (`pg-disk`) | Máy chủ cơ sở dữ liệu; `docs/runbooks/infra/sizing-uat-prod.md` mục 1 | Một phần |
| Dung lượng tệp đính kèm | Giả định: 200 GB, tăng 100 GB mỗi năm | Kho đối tượng | Không (đo ở kho đối tượng) |
| Dung lượng và số dòng từng lớp log so với giới hạn của PVFCCo; số lớp ở mức NEAR hoặc OVER | Giới hạn `max_rows`, `max_bytes` do PVFCCo đặt ở ADM-30, cảnh báo mặc định ở 80% (`DEFAULT_WARN_PCT` trong `packages/kernel/src/log-capacity.ts`); lớp nhật ký kiểm toán chỉ theo dõi, không bao giờ bị xóa tự động | ADM-30 (`getLogCapacity`, `saveLogCapacityPolicy`) | Có |
| Số người dùng có tên, đồng thời giờ cao điểm | Giả định: 150 và 40 (chờ PX-17) | Thành viên (ADM); số phiên đăng nhập | Một phần |

### 7.8 Yêu cầu đã xử lý

| Loại | Mã yêu cầu | Ngày nhận | Ngày xong | Ghi chú |
|---|---|---|---|---|
| Đổi biểu mẫu, bố cục (RPT-07, RPT-08) | [điền khi có] | | | Theo mục 6.3 |
| Đổi hạn lịch kỳ, quy tắc, danh mục | | | | Phiên bản quy tắc ở ADM-19 |
| Thêm, bớt người dùng, vai trò, ủy quyền | | | | Nhật ký ADM-11 |
| Trợ giúp, hướng dẫn sử dụng | | | | Câu hỏi lặp đưa vào trợ giúp trên màn hình |

### 7.9 Việc còn mở và kế hoạch kỳ tới

| Mã | Việc | Chủ | Hạn | Phụ thuộc (mã PX nếu chờ khách) |
|---|---|---|---|---|
| [điền khi có] | | | | |

### 7.10 Khối ký

| Vai trò | Họ tên | Chức danh | Ngày | Chữ ký |
|---|---|---|---|---|
| Người lập (nhà cung cấp) | [khách điền] | | | |
| Giám sát kỹ thuật Ban CĐS&CNTT | [khách điền] | | | |
| Đại diện Ban KHĐT (khi báo cáo có nội dung kỳ chốt) | [khách điền] | | | |

## 8. Bản vá bảo mật và chạy lại pentest

| Mức | Hạn xử lý nội bộ hiện có (`docs/runbooks/infra/security-scanning.md`) | Hồ sơ kỹ thuật |
|---|---|---|
| Critical, khai thác được hoặc lộ bí mật | Phản hồi trong 1 ngày làm việc (xoay bí mật trước); sửa trong 7 ngày | Critical hoặc High: trong [07] ngày |
| High | Phản hồi trong 2 ngày làm việc; sửa trong 30 ngày | Như trên |
| Medium | Phản hồi trong 5 ngày làm việc; sửa trong 90 ngày | Không nêu (nghiệm thu đòi Medium đã khắc phục hoặc có biện pháp giảm thiểu được chấp thuận bằng văn bản, [09](09-acceptance-minutes-template.md) mục 3) |

Mâu thuẫn cần chốt: hạn nội bộ cho mức High là 30 ngày, dài hơn giá trị [07] ngày của hồ sơ kỹ thuật cho Critical hoặc High. Nếu hợp đồng đặt [07] ngày đúng như hồ sơ, hạn sửa mức High của chính sách nội bộ phải rút xuống không quá 07 ngày và ngoại lệ tối đa 90 ngày (`docs/runbooks/supply-chain.md`) không được áp dụng cho Critical hoặc High của PVFCCo. Quyết định: [khách điền: giá trị hợp đồng của số ngày].

Chạy lại pentest khi có thay đổi lớn (đề xuất cách hiểu thay đổi lớn, PVFCCo xác nhận): đổi cơ chế xác thực hoặc phân quyền; thêm kết nối ra ngoài hoặc đường vào mới; đổi hạ tầng mạng hoặc kho sao lưu; nâng cấp phiên bản lớn của nền tảng; sau sự cố an ninh. Việc thuê đơn vị độc lập do hai bên thỏa thuận (PX-09); gói đầu vào là `docs/security/pentest-readiness.md`.

## 9. PVFCCo xác nhận báo cáo bảo trì

1. Nhà cung cấp gửi báo cáo (mục 7) trong [khách điền: số ngày làm việc] sau khi kỳ báo cáo kết thúc.
2. PVFCCo xem xét trong [khách điền: số ngày làm việc]: đối chiếu các ô "Có" với màn hình và xuất của hệ thống; hỏi lại các ô nhập tay.
3. Kết quả: [ ] Chấp nhận  [ ] Chấp nhận có điều kiện (kèm yêu cầu bổ sung)  [ ] Không chấp nhận (kèm lý do).
4. Báo cáo được chấp nhận không thay thế phê duyệt giai đoạn, nghiệm thu hay xác nhận mục chờ khách; các mục PENDING-EXTERNAL còn lại vẫn ghi trong sổ [11](11-pending-external-register.md).
5. Ghi nhận ngày chấp nhận và người ký vào mục 7.10; khi PVFCCo đổi nội dung mẫu, sửa ở đây và ghi vào lịch sử sửa.

## 10. Điều chờ khách và quyết định chưa chốt

| Điều cần | Ai cung cấp | Liên quan | Mã PX |
|---|---|---|---|
| Họ tên, điện thoại, hộp thư, kênh trang sự cố cho các bậc ở 2.3 và lịch trực ở 2.5, 5.4 | Ban CĐS&CNTT, Ban KHĐT | Mục 2, 5 | Chưa có mã PX riêng; ghi vào phiếu phê duyệt giai đoạn 7 (PX-12) |
| Đích nhận trang sự cố trên kênh vận hành khi cài (số điện thoại, bộ chuyển tiếp) | Ban CĐS&CNTT | Mục 2.4 | PX-11 |
| Bộ chuyển tiếp email và địa chỉ Teams để gửi nhắc việc | Ban CĐS&CNTT | Mục 2.4, 5 | PX-16 |
| Quyết định D10: thời hạn phản hồi và khắc phục theo mức P0 đến P3; hợp đồng tính 24 giờ liên tục hay giờ làm việc; bắt đầu và kết thúc bảo hành [12] tháng | PVFCCo cùng nhà cung cấp | Mục 1, 2.2 | PX-12 |
| Hypercare kéo dài bao lâu, giờ mở rộng | PVFCCo | Mục 3 | PX-12 |
| Giá trị [07] ngày cho lỗ hổng Critical hoặc High | PVFCCo cùng nhà cung cấp | Mục 8 | PX-12 |
| Hạn từng bước của lịch kỳ (kể cả mốc tự khóa kỳ) và cửa sổ đóng băng | Tổ chuẩn hóa dữ liệu, Ban KHĐT | Mục 5 | Mục 4 của sổ [11](11-pending-external-register.md); PX-12 |
| Số người dùng thật để chốt cấu hình và ngưỡng dung lượng | Tổ chuẩn hóa dữ liệu | Mục 7.7 | PX-17 |
| Số đo hiệu năng trên phần cứng của PVFCCo | Ban CĐS&CNTT | Mục 7.2 | PX-10 |
| Đơn vị pentest độc lập và lần chạy lại | PVFCCo (chấp thuận), nhà cung cấp (thuê) | Mục 8 | PX-09 |
| Tần suất, người nhận báo cáo bảo trì; số ngày xem xét | PVFCCo | Mục 7, 9 | PX-12 |

Lịch sử sửa: v0.1 khung ngày 2026-11-12, lập bởi làn aud4 từ thiết kế (ST-KERNEL-105, kế hoạch triển khai, kế hoạch kiểm thử), `docs/runbooks`, `infra/policies`, `infra/backup` và mã lịch kỳ (`packages/kernel/src/reporting-schedule.ts`); chưa có số liệu hay họ tên của PVFCCo.
