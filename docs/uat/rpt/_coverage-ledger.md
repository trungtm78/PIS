# Sổ phủ — phân hệ RPT

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 18 ca thiết kế của phân hệ (`test_cases.json`, chuyển nguyên văn) và 42 ca sâu viết cho bản enterprise (ma trận quyền theo từng thao tác của openapi.json, idempotency, đường chuyển trạng thái sai, kiểm toán và outbox, cách ly tenant, hiệu năng theo ngân sách của khách, a11y, việc chờ khách PX-nn).
> Ca sâu đã được thêm vào `Design/MACHVON_Design/03_Engineering/test_cases.json` và `traceability.json` (nguồn "UAT enterprise (lane uatent)") để `npm run uat:run` và `npm run uat:evidence` nhận ra theo mã ca. Kết quả mong đợi của ca thiết kế là của thiết kế; ca sâu lấy kỳ vọng từ openapi.json (x-permission, mã lỗi), `screen_catalog.json` và quy tắc của màn hình, không lấy từ mã.
> Dòng HSKT: BC.01. Màn: RPT-01, RPT-02, RPT-03, RPT-04, RPT-05, RPT-06, RPT-07, RPT-08, RPT-09, RML-01. Câu chuyện: ST-RPT-001, ST-RPT-121, ST-RPT-131, ST-RPT-141, ST-RML-001.

## Bảng coverage item

| cov_id | Coverage item | TC phủ | Trạng thái |
|---|---|---|---|
| COV-FR-HPM-02 | FR-HPM-02 | TC-UI-RML-01 | ✅ |
| COV-FR-RML-01 | FR-RML-01 | TC-UAT-RPT-RML-01, TC-UAT-RPT-SEC-21, TC-UAT-RPT-SEC-22, TC-UAT-RPT-SEC-23, TC-UAT-RPT-SEC-24 | ✅ |
| COV-FR-RPT-01 | FR-RPT-01 | TC-UI-RPT-01, TC-UAT-RPT-001, TC-UAT-RPT-003, TC-UAT-RPT-IDM-01, TC-UAT-RPT-EDG-01, TC-UAT-RPT-DEMO-01, TC-UAT-RPT-A11-01, TC-UAT-RPT-PX-01, TC-UAT-RPT-SEC-01, TC-UAT-RPT-SEC-03 | ✅ |
| COV-FR-RPT-02 | FR-RPT-02 | TC-UI-RPT-02, TC-UAT-RPT-001, TC-UAT-RPT-002, TC-UAT-RPT-E2E-01, TC-UAT-RPT-STA-01, TC-UAT-RPT-SOD-01, TC-UAT-RPT-A11-01, TC-UAT-RPT-SEC-02, TC-UAT-RPT-SEC-04, TC-UAT-RPT-SEC-05, TC-UAT-RPT-SEC-06, TC-UAT-RPT-SEC-07, TC-UAT-RPT-SEC-08, TC-UAT-RPT-SEC-12 | ✅ |
| COV-FR-RPT-03 | FR-RPT-03 | TC-UI-RPT-03, TC-UAT-RPT-001, TC-UAT-RPT-002, TC-UAT-RPT-003, TC-UAT-RPT-E2E-01, TC-UAT-RPT-IDM-01, TC-UAT-RPT-STA-02, TC-UAT-RPT-ISO-01, TC-UAT-RPT-PRF-01, TC-UAT-RPT-A11-01, TC-UAT-RPT-SEC-09, TC-UAT-RPT-SEC-10, TC-UAT-RPT-SEC-11 | ✅ |
| COV-FR-RPT-04 | FR-RPT-04 | TC-UI-RPT-04, TC-UAT-RPT-002, TC-UAT-RPT-003, TC-UAT-RPT-IDM-02, TC-UAT-RPT-EDG-01, TC-UAT-RPT-DEMO-01, TC-UAT-RPT-A11-01, TC-UAT-RPT-SEC-13, TC-UAT-RPT-SEC-14 | ✅ |
| COV-FR-RPT-05 | FR-RPT-05 | TC-UI-RPT-05, TC-UAT-PLAN-3001, TC-UAT-RPT-PX-01 | ✅ |
| COV-FR-RPT-06 | FR-RPT-06 | TC-UI-RPT-06, TC-UAT-PLAN-3001, TC-UAT-RPT-SIG-01, TC-UAT-RPT-SEC-15, TC-UAT-RPT-SEC-16, TC-UAT-RPT-SEC-17, TC-UAT-RPT-SEC-18, TC-UAT-RPT-SEC-19 | ✅ |
| COV-FR-RPT-07 | FR-RPT-07 | TC-UI-RPT-07, TC-UAT-PLAN-3410, TC-UAT-PLAN-3411 | ✅ |
| COV-FR-RPT-08 | FR-RPT-08 | TC-UI-RPT-08, TC-UAT-PLAN-3410, TC-UAT-PLAN-3411, TC-UAT-RPT-SEC-20 | ✅ |
| COV-FR-RPT-09 | FR-RPT-09 | TC-UI-RPT-09, TC-UAT-RPT-ENT4A-1, TC-UAT-RPT-ENT4A-2, TC-UAT-RPT-XCK-01, TC-UAT-RPT-SEC-25, TC-UAT-RPT-SEC-26, TC-UAT-RPT-SEC-27 | ✅ |

## Tổng

- Coverage item: 11, mỗi item có ít nhất một TC (11/11).
- TC: 60 (ca thiết kế 18, ca sâu 42). Theo loại: A11Y 1, DATA 2, E2E 11, EDGE 1, PERFORMANCE 1, PERMISSIONS 27, RED 3, SECURITY 1, STATE 3, UX 10.
- Có kịch bản chạy: 35 ca sâu (đặt tên theo mã ca nên `npm run uat:run` nhận): apps/api/test/uat/rpt.uat.test.ts; apps/api/test/uat/enterprise-authz.uat.test.ts.
- Làm tay: 7 ca sâu và 18 ca thiết kế. Lý do từng ca ở trường `automation.reason` của `uat.json`.

## Ca sâu chưa có kịch bản và lý do

- UAT-RPT-DEMO-01: Đã là ca thiết kế UAT-RPT-003; cần bật quy tắc REPORT_FORM_MODE bằng hai người và biểu mẫu DEMO có số liệu minh họa, suite RPT chưa dựng (kiểm bằng apps/api/test/reports/demo-forms.enterprise.test.ts)
- UAT-RPT-SIG-01: Cần cổng ký số của DOC và biểu mẫu Bộ Tài chính (mẫu chính thức là PX-01); suite UAT chưa dựng cổng ký
- UAT-RPT-RML-01: Cần việc gửi email của bản enterprise và nhà cung cấp email giả; SMTP/Teams thật chờ khách (PX-16)
- UAT-RPT-XCK-01: Cần hai biểu mẫu enterprise cùng kỳ lệch số; đã có ở apps/api/test/reports/crosscheck.enterprise.test.ts, chưa dựng trong suite UAT
- UAT-RPT-PRF-01: Cần bản phát hành thật và bộ 500 bản; đo trên phần cứng khách là PX-10
- UAT-RPT-A11-01: Chưa có đi bàn phím riêng; quét axe chung ở apps/web/e2e/a11y.spec.ts
- UAT-RPT-PX-01: Chờ khách cung cấp bố cục chính thức (PX-01, PX-15)
