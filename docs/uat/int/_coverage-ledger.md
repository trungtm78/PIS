# Sổ phủ — phân hệ INT

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 8 ca thiết kế của phân hệ (`test_cases.json`, chuyển nguyên văn) và 34 ca sâu viết cho bản enterprise (ma trận quyền theo từng thao tác của openapi.json, idempotency, đường chuyển trạng thái sai, kiểm toán và outbox, cách ly tenant, hiệu năng theo ngân sách của khách, a11y, việc chờ khách PX-nn).
> Ca sâu đã được thêm vào `Design/MACHVON_Design/03_Engineering/test_cases.json` và `traceability.json` (nguồn "UAT enterprise (lane uatent)") để `npm run uat:run` và `npm run uat:evidence` nhận ra theo mã ca. Kết quả mong đợi của ca thiết kế là của thiết kế; ca sâu lấy kỳ vọng từ openapi.json (x-permission, mã lỗi), `screen_catalog.json` và quy tắc của màn hình, không lấy từ mã.
> Dòng HSKT: TH.02. Màn: INT-01, INT-02, INT-03, INT-04, INT-05. Câu chuyện: ST-INT-001.

## Bảng coverage item

| cov_id | Coverage item | TC phủ | Trạng thái |
|---|---|---|---|
| COV-FR-INT-01 | FR-INT-01 | TC-UI-INT-01, TC-UAT-INT-001, TC-UAT-INT-E2E-01, TC-UAT-INT-IDM-01, TC-UAT-INT-TKN-01, TC-UAT-INT-STA-01, TC-UAT-INT-EDG-01, TC-UAT-INT-ISO-01, TC-UAT-INT-A11-01, TC-UAT-INT-SEC-01, TC-UAT-INT-SEC-02, TC-UAT-INT-SEC-03 | ✅ |
| COV-FR-INT-02 | FR-INT-02 | TC-UI-INT-02, TC-UAT-INT-001, TC-UAT-INT-TKN-01, TC-UAT-INT-STA-01, TC-UAT-INT-EDG-01, TC-UAT-INT-RTL-01, TC-UAT-INT-A11-01, TC-UAT-INT-SEC-04, TC-UAT-INT-SEC-05, TC-UAT-INT-SEC-06 | ✅ |
| COV-FR-INT-03 | FR-INT-03 | TC-UI-INT-03, TC-UAT-INT-003, TC-UAT-INT-SOD-01, TC-UAT-INT-A11-01, TC-UAT-INT-SEC-15, TC-UAT-INT-SEC-16, TC-UAT-INT-SEC-17, TC-UAT-INT-SEC-18, TC-UAT-INT-SEC-19, TC-UAT-INT-SEC-20, TC-UAT-INT-SEC-21 | ✅ |
| COV-FR-INT-04 | FR-INT-04 | TC-UI-INT-04, TC-UAT-INT-002, TC-UAT-INT-DST-01, TC-UAT-INT-BI-01, TC-UAT-INT-A11-01, TC-UAT-INT-SEC-08, TC-UAT-INT-SEC-09, TC-UAT-INT-SEC-10, TC-UAT-INT-SEC-11, TC-UAT-INT-SEC-12, TC-UAT-INT-SEC-13, TC-UAT-INT-SEC-14 | ✅ |
| COV-FR-INT-05 | FR-INT-05 | TC-UI-INT-05, TC-UAT-INT-001, TC-UAT-INT-E2E-01, TC-UAT-INT-DAT-01, TC-UAT-INT-PRF-01, TC-UAT-INT-A11-01, TC-UAT-INT-SEC-07 | ✅ |

## Tổng

- Coverage item: 5, mỗi item có ít nhất một TC (5/5).
- TC: 42 (ca thiết kế 8, ca sâu 34). Theo loại: A11Y 1, DATA 2, E2E 4, EDGE 1, PERFORMANCE 1, PERMISSIONS 21, RED 2, SECURITY 3, STATE 2, UX 5.
- Có kịch bản chạy: 29 ca sâu (đặt tên theo mã ca nên `npm run uat:run` nhận): apps/api/test/uat/int.uat.test.ts; apps/api/test/uat/enterprise-authz.uat.test.ts.
- Làm tay: 5 ca sâu và 8 ca thiết kế. Lý do từng ca ở trường `automation.reason` của `uat.json`.

## Ca sâu chưa có kịch bản và lý do

- UAT-INT-RTL-01: Phụ thuộc đồng hồ phút của bộ giới hạn; chưa viết trong suite để tránh ca chập chờn, đã có trong apps/api/test/int/int.test.ts
- UAT-INT-DST-01: Cần sản phẩm dữ liệu và chứng nhận của DGV; suite UAT chưa dựng sản phẩm dữ liệu
- UAT-INT-BI-01: Cần mở kết nối CSDL thật bằng tài khoản BI (cổng Postgres), suite UAT chỉ đi qua HTTP; đã có trong apps/api/test/int/int.test.ts
- UAT-INT-PRF-01: Cần bộ dữ liệu lớn và đo trên phần cứng khách (PX-10)
- UAT-INT-A11-01: Chưa có đi bàn phím riêng; quét axe chung ở apps/web/e2e/a11y.spec.ts
