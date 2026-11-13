# Sổ phủ — phân hệ PWF

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 76 ca UAT của phân hệ PWF (workflow dự án, lập lịch, hạn ba màu, KPI và chấm điểm nhân viên), viết từ đặc tả `Design/MACHVON_Design/01_Documents/05_modules/PWF.md`:
> 15 ca `UAT-PWF-01..15` của mục 10 được khai triển đủ (tiền điều kiện, bước đánh số, kết quả mong đợi, vai, nền tảng, ưu tiên) cộng 61 ca âm tính, biên, đồng thời, idempotency, cách ly tenant, IDOR, tự duyệt, ngoại tuyến, quyền riêng tư và hồi quy.
> Mức rủi ro HIGH vì có cách ly tenant, dữ liệu cá nhân (bảng điểm) và quyền tách vai. M2 và FP chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.

> **Đã đăng ký ở danh mục thiết kế (lane pwfreg, 2026-11-13).** Màn PWF-01..16 và MOB-78..82 nằm trong `screen_catalog.json`; 20 câu chuyện ST-PWF-001..020 (epic EP-PWF) nằm trong `implementation_plan.json`; 21 ca T-PWF, 76 ca UAT-PWF và 21 ca màn hình UI-PWF/UI-MOB nằm trong `test_cases.json`; truy vết và backlog nằm trong `traceability.json`, `implementation_backlog.json` (bản đăng ký: `docs/plans/pwf-register.json`, chạy lại bằng `node scripts/contract-patch.mjs apply --spec docs/plans/pwf-register.json`). Vì vậy mỗi ca dùng `screen_id` (màn chính, màn đầu của các màn nó chạm), `story_ids` và `automation` theo chuẩn của các module khác; `linked_acs`, `linked_rules`, `linked_tests` giữ nguyên làm liên kết tới mục 5, 10 và 11 của đặc tả.
>
> **Tự động hóa:** trường `automation` của ca chưa có kịch bản mang `state: PLANNED` kèm `layer` và `note` (lớp dự kiến); ca đã có kịch bản mang `AUTOMATED` kèm `suite` (kiểm `HANDOFF_AUTOMATION_MISSING`); 1 ca là `MANUAL` có lý do. Lane tự động hóa đổi `PLANNED` thành `AUTOMATED` khi kịch bản đặt tên theo mã ca. Chưa ca nào có kịch bản đặt tên theo mã ca, chưa ca nào chạy và không có bằng chứng; sổ này không khẳng định ca nào đã tự động. Lõi thuần của kernel đã có test riêng (T-PWF-01..12 ở mục 10), các ca ở đây là phần UAT.

## Bảng coverage item (một mục cho mỗi câu chuyện)

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-ST-PWF-001 | AC/Requirement | ST-PWF-001: Soạn và duyệt mẫu workflow | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-01, TC-UAT-PWF-BND-12, TC-UAT-PWF-NEG-02, TC-UAT-PWF-SEC-07, TC-UAT-PWF-EDN-01 | ✅ |
| COV-ST-PWF-002 | AC/Requirement | ST-PWF-002: Khởi tạo workflow và hạn từng việc | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-02, TC-UAT-PWF-03, TC-UAT-PWF-BND-14, TC-UAT-PWF-NEG-01, TC-UAT-PWF-NEG-10, TC-UAT-PWF-CON-02, TC-UAT-PWF-IDM-01, TC-UAT-PWF-SEC-01, TC-UAT-PWF-UX-01 | ✅ |
| COV-ST-PWF-003 | AC/Requirement | ST-PWF-003: Tiếp nhận dự án đang chạy | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-04, TC-UAT-PWF-NEG-07, TC-UAT-PWF-STA-02 | ✅ |
| COV-ST-PWF-004 | AC/Requirement | ST-PWF-004: Cây tiến trình, Gantt và đường găng | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-SEC-01, TC-UAT-PWF-UX-01, TC-UAT-PWF-GAN-01 | ✅ |
| COV-ST-PWF-005 | AC/Requirement | ST-PWF-005: Nộp chứng từ và hoàn thành việc | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-05, TC-UAT-PWF-15, TC-UAT-PWF-NEG-03, TC-UAT-PWF-STA-01, TC-UAT-PWF-CON-04, TC-UAT-PWF-SEC-09, TC-UAT-PWF-OFF-01, TC-UAT-PWF-EDN-01 | ✅ |
| COV-ST-PWF-006 | AC/Requirement | ST-PWF-006: Duyệt hoặc trả lại việc | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-05, TC-UAT-PWF-BND-09, TC-UAT-PWF-NEG-04, TC-UAT-PWF-STA-01, TC-UAT-PWF-SEC-06 | ✅ |
| COV-ST-PWF-007 | AC/Requirement | ST-PWF-007: Tạm dừng, hủy, miễn, trì hoãn bên ngoài có duyệt | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-BND-09, TC-UAT-PWF-BND-13, TC-UAT-PWF-NEG-04, TC-UAT-PWF-NEG-08, TC-UAT-PWF-STA-02, TC-UAT-PWF-SEC-07, TC-UAT-PWF-KPI-01 | ✅ |
| COV-ST-PWF-008 | AC/Requirement | ST-PWF-008: Sổ phân công theo khoảng và tỷ lệ | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-BND-08, TC-UAT-PWF-SEC-09 | ✅ |
| COV-ST-PWF-009 | AC/Requirement | ST-PWF-009: Cổng giai đoạn | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-06, TC-UAT-PWF-SEC-09, TC-UAT-PWF-REG-02, TC-UAT-PWF-REG-03 | ✅ |
| COV-ST-PWF-010 | AC/Requirement | ST-PWF-010: Dời lịch có xem trước và duyệt | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-07, TC-UAT-PWF-NEG-05, TC-UAT-PWF-CON-01, TC-UAT-PWF-SEC-07 | ✅ |
| COV-ST-PWF-011 | AC/Requirement | ST-PWF-011: Ngưỡng ba màu theo ngày | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-08, TC-UAT-PWF-BND-01, TC-UAT-PWF-BND-02, TC-UAT-PWF-BND-03, TC-UAT-PWF-BND-04, TC-UAT-PWF-BND-05, TC-UAT-PWF-BND-06, TC-UAT-PWF-BND-07, TC-UAT-PWF-NEG-10, TC-UAT-PWF-A11-01, TC-UAT-PWF-REG-01 | ✅ |
| COV-ST-PWF-012 | AC/Requirement | ST-PWF-012: Bảng deadline toàn danh mục | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-09, TC-UAT-PWF-A11-01, TC-UAT-PWF-UX-01, TC-UAT-PWF-PERF-01, TC-UAT-PWF-BRD-01 | ✅ |
| COV-ST-PWF-013 | AC/Requirement | ST-PWF-013: Nhắc hạn đúng lúc, không trùng | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-IDM-02, TC-UAT-PWF-IDM-03, TC-UAT-PWF-OFF-01 | ✅ |
| COV-ST-PWF-014 | AC/Requirement | ST-PWF-014: Nhắc sớm hơn cho riêng mình | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-09, TC-UAT-PWF-NEG-06 | ✅ |
| COV-ST-PWF-015 | AC/Requirement | ST-PWF-015: Bộ KPI và chính sách chấm điểm | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-NEG-02, TC-UAT-PWF-KPI-01 | ✅ |
| COV-ST-PWF-016 | AC/Requirement | ST-PWF-016: Tính và chốt kỳ chấm điểm | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-10, TC-UAT-PWF-BND-13, TC-UAT-PWF-NEG-08, TC-UAT-PWF-NEG-09, TC-UAT-PWF-STA-03, TC-UAT-PWF-CON-03, TC-UAT-PWF-SEC-10, TC-UAT-PWF-LCK-01 | ✅ |
| COV-ST-PWF-017 | AC/Requirement | ST-PWF-017: Xem điểm của tôi và phản hồi | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-10, TC-UAT-PWF-11, TC-UAT-PWF-15, TC-UAT-PWF-BND-15, TC-UAT-PWF-SEC-04, TC-UAT-PWF-SEC-11, TC-UAT-PWF-OFF-02 | ✅ |
| COV-ST-PWF-018 | AC/Requirement | ST-PWF-018: Điểm đơn vị, điều chỉnh có duyệt, xuất tệp | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-12, TC-UAT-PWF-13, TC-UAT-PWF-14, TC-UAT-PWF-BND-10, TC-UAT-PWF-BND-11, TC-UAT-PWF-CON-03, TC-UAT-PWF-SEC-02, TC-UAT-PWF-SEC-03, TC-UAT-PWF-SEC-04, TC-UAT-PWF-SEC-05, TC-UAT-PWF-SEC-08, TC-UAT-PWF-SEC-11, TC-UAT-PWF-OFF-02, TC-UAT-PWF-RET-01 | ✅ |
| COV-ST-PWF-019 | AC/Requirement | ST-PWF-019: Theo dõi việc trên điện thoại | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-09, TC-UAT-PWF-15, TC-UAT-PWF-OFF-01, TC-UAT-PWF-OFF-02 | ✅ |
| COV-ST-PWF-020 | AC/Requirement | ST-PWF-020: Tải công việc theo người | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-PERF-01, TC-UAT-PWF-WRK-01 | ✅ |
| COV-ST-PWF-021 | AC/Requirement | ST-PWF-021: Loại quy trình ba tầng: giai đoạn, bước, công việc có danh mục kiểm | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-PRC-01, TC-UAT-PWF-PRC-02, TC-UAT-PWF-PRC-03 | ✅ |
| COV-ST-PWF-022 | AC/Requirement | ST-PWF-022: Căn cứ pháp lý của bước và công việc theo danh mục văn bản dùng chung | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-PRC-04, TC-UAT-PWF-PRC-05 | ✅ |
| COV-ST-PWF-023 | AC/Requirement | ST-PWF-023: Phiên bản biểu mẫu: mới nhất đã duyệt hoặc ghim, ghi vào bằng chứng | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-PRC-06 | ✅ |
| COV-ST-PWF-024 | AC/Requirement | ST-PWF-024: Chọn loại quy trình khi đăng ký dự án theo quy tắc ánh xạ | Design/MACHVON_Design/01_Documents/05_modules/PWF.md mục 14 | TC-UAT-PWF-PRC-07, TC-UAT-PWF-PRC-08, TC-UAT-PWF-PRC-09, TC-UAT-PWF-PRC-10 | ✅ |

## Tiêu chí nghiệm thu (mục 11) và ca phủ

| AC | TC phủ |
|---|---|
| AC-ST-PWF-001-1 | TC-UAT-PWF-01, TC-UAT-PWF-BND-12, TC-UAT-PWF-NEG-02, TC-UAT-PWF-EDN-01 |
| AC-ST-PWF-001-2 | TC-UAT-PWF-01, TC-UAT-PWF-SEC-07 |
| AC-ST-PWF-002-1 | TC-UAT-PWF-02, TC-UAT-PWF-BND-14, TC-UAT-PWF-NEG-01, TC-UAT-PWF-CON-02, TC-UAT-PWF-IDM-01, TC-UAT-PWF-SEC-01 |
| AC-ST-PWF-002-2 | TC-UAT-PWF-03, TC-UAT-PWF-NEG-10, TC-UAT-PWF-UX-01 |
| AC-ST-PWF-003-1 | TC-UAT-PWF-04, TC-UAT-PWF-NEG-07 |
| AC-ST-PWF-004-1 | TC-UAT-PWF-SEC-01, TC-UAT-PWF-GAN-01 |
| AC-ST-PWF-005-1 | TC-UAT-PWF-05, TC-UAT-PWF-NEG-03, TC-UAT-PWF-SEC-09, TC-UAT-PWF-EDN-01 |
| AC-ST-PWF-005-2 | TC-UAT-PWF-05, TC-UAT-PWF-15, TC-UAT-PWF-STA-01, TC-UAT-PWF-CON-04, TC-UAT-PWF-OFF-01 |
| AC-ST-PWF-006-1 | TC-UAT-PWF-05, TC-UAT-PWF-NEG-04, TC-UAT-PWF-SEC-06 |
| AC-ST-PWF-006-2 | TC-UAT-PWF-05, TC-UAT-PWF-BND-09 |
| AC-ST-PWF-007-1 | TC-UAT-PWF-BND-13, TC-UAT-PWF-NEG-04, TC-UAT-PWF-SEC-07, TC-UAT-PWF-KPI-01 |
| AC-ST-PWF-007-2 | TC-UAT-PWF-NEG-08, TC-UAT-PWF-STA-02 |
| AC-ST-PWF-008-1 | TC-UAT-PWF-BND-08, TC-UAT-PWF-SEC-09 |
| AC-ST-PWF-009-1 | TC-UAT-PWF-06, TC-UAT-PWF-SEC-09 |
| AC-ST-PWF-009-2 | TC-UAT-PWF-06, TC-UAT-PWF-REG-02, TC-UAT-PWF-REG-03 |
| AC-ST-PWF-010-1 | TC-UAT-PWF-07, TC-UAT-PWF-NEG-05, TC-UAT-PWF-CON-01, TC-UAT-PWF-SEC-07 |
| AC-ST-PWF-011-1 | TC-UAT-PWF-08, TC-UAT-PWF-BND-01, TC-UAT-PWF-BND-02, TC-UAT-PWF-BND-03, TC-UAT-PWF-BND-04, TC-UAT-PWF-BND-05, TC-UAT-PWF-BND-06, TC-UAT-PWF-BND-07, TC-UAT-PWF-NEG-10, TC-UAT-PWF-A11-01 |
| AC-ST-PWF-011-2 | TC-UAT-PWF-REG-01 |
| AC-ST-PWF-012-1 | TC-UAT-PWF-09, TC-UAT-PWF-A11-01, TC-UAT-PWF-UX-01, TC-UAT-PWF-PERF-01, TC-UAT-PWF-BRD-01 |
| AC-ST-PWF-013-1 | TC-UAT-PWF-IDM-02, TC-UAT-PWF-IDM-03, TC-UAT-PWF-OFF-01 |
| AC-ST-PWF-014-1 | TC-UAT-PWF-09, TC-UAT-PWF-NEG-06 |
| AC-ST-PWF-015-1 | TC-UAT-PWF-NEG-02, TC-UAT-PWF-KPI-01 |
| AC-ST-PWF-016-1 | TC-UAT-PWF-10, TC-UAT-PWF-BND-13, TC-UAT-PWF-NEG-08, TC-UAT-PWF-NEG-09, TC-UAT-PWF-STA-03, TC-UAT-PWF-CON-03, TC-UAT-PWF-SEC-10, TC-UAT-PWF-LCK-01 |
| AC-ST-PWF-017-1 | TC-UAT-PWF-10, TC-UAT-PWF-11, TC-UAT-PWF-BND-15, TC-UAT-PWF-SEC-04 |
| AC-ST-PWF-018-1 | TC-UAT-PWF-13, TC-UAT-PWF-SEC-02, TC-UAT-PWF-SEC-03, TC-UAT-PWF-SEC-04, TC-UAT-PWF-SEC-05, TC-UAT-PWF-SEC-11, TC-UAT-PWF-OFF-02, TC-UAT-PWF-RET-01 |
| AC-ST-PWF-018-2 | TC-UAT-PWF-12, TC-UAT-PWF-BND-10, TC-UAT-PWF-CON-03, TC-UAT-PWF-SEC-08 |
| AC-ST-PWF-018-3 | TC-UAT-PWF-14, TC-UAT-PWF-BND-11 |
| AC-ST-PWF-019-1 | TC-UAT-PWF-09, TC-UAT-PWF-15, TC-UAT-PWF-OFF-01, TC-UAT-PWF-OFF-02 |
| AC-ST-PWF-020-1 | TC-UAT-PWF-PERF-01, TC-UAT-PWF-WRK-01 |

## Tổng

- Coverage item: 20, mỗi item có ít nhất một TC (20/20); tiêu chí nghiệm thu: 29/29 có ít nhất một TC.
- TC: 76 (15 ca UAT-PWF của đặc tả, 61 ca bổ sung).

### Theo loại (type)

| type | ca |
|---|---|
| BOUNDARY | 16 |
| E2E | 13 |
| RED | 10 |
| SECURITY | 9 |
| INTEGRATION | 9 |
| STATE | 3 |
| GREEN | 3 |
| PERMISSIONS | 2 |
| OFFLINE | 2 |
| DECISION | 2 |
| EDGE | 2 |
| AUDIT | 1 |
| A11Y | 1 |
| UX | 1 |
| PERFORMANCE | 1 |
| LIFECYCLE | 1 |

### Theo nền tảng (platform; web, api, android; `platform_scope` ghi phạm vi web, mobile hay both của hành vi)

| platform | ca |
|---|---|
| api | 53 |
| web | 20 |
| android | 3 |

| platform_scope | ca |
|---|---|
| web | 65 |
| both | 8 |
| mobile | 3 |

### Theo nhóm (category)

| category | ca |
|---|---|
| negative | 17 |
| positive | 15 |
| boundary | 14 |
| self-approval | 4 |
| idor | 4 |
| concurrency | 4 |
| regression | 4 |
| idempotency | 3 |
| tenant-isolation | 2 |
| permissions | 2 |
| privacy | 2 |
| offline | 2 |
| accessibility | 2 |
| performance | 1 |
