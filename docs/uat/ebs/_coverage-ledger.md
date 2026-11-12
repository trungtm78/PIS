# Sổ phủ — phân hệ EBS

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 6 ca thiết kế của phân hệ (`test_cases.json`, chuyển nguyên văn) và 24 ca sâu viết cho bản enterprise (ma trận quyền theo từng thao tác của openapi.json, idempotency, đường chuyển trạng thái sai, kiểm toán và outbox, cách ly tenant, hiệu năng theo ngân sách của khách, a11y, việc chờ khách PX-nn).
> Ca sâu đã được thêm vào `Design/MACHVON_Design/03_Engineering/test_cases.json` và `traceability.json` (nguồn "UAT enterprise (lane uatent)") để `npm run uat:run` và `npm run uat:evidence` nhận ra theo mã ca. Kết quả mong đợi của ca thiết kế là của thiết kế; ca sâu lấy kỳ vọng từ openapi.json (x-permission, mã lỗi), `screen_catalog.json` và quy tắc của màn hình, không lấy từ mã.
> Dòng HSKT: CN.04. Màn: EBS-01, EBS-02. Câu chuyện: ST-EBS-001, ST-EBS-002.

## Bảng coverage item

| cov_id | Coverage item | TC phủ | Trạng thái |
|---|---|---|---|
| COV-FR-EBS-01 | FR-EBS-01 | TC-UI-EBS-01, TC-UAT-PLAN-173, TC-UAT-PLAN-174, TC-UAT-EBS-E2E-01, TC-UAT-EBS-IDM-01, TC-UAT-EBS-IDM-02, TC-UAT-EBS-IDM-03, TC-UAT-EBS-EDG-01, TC-UAT-EBS-SOD-01, TC-UAT-EBS-DAT-01, TC-UAT-EBS-EDG-02, TC-UAT-EBS-A11-01, TC-UAT-EBS-PX-01, TC-UAT-EBS-SEC-01, TC-UAT-EBS-SEC-02, TC-UAT-EBS-SEC-03, TC-UAT-EBS-SEC-04, TC-UAT-EBS-SEC-05 | ✅ |
| COV-FR-EBS-02 | FR-EBS-02 | TC-UI-EBS-02, TC-UAT-PLAN-149, TC-UAT-PLAN-150, TC-UAT-EBS-E2E-02, TC-UAT-EBS-STA-01, TC-UAT-EBS-ISO-01, TC-UAT-EBS-E2E-03, TC-UAT-EBS-PRF-01, TC-UAT-EBS-A11-01, TC-UAT-EBS-SEC-06, TC-UAT-EBS-SEC-07, TC-UAT-EBS-SEC-08, TC-UAT-EBS-SEC-09 | ✅ |

## Tổng

- Coverage item: 2, mỗi item có ít nhất một TC (2/2).
- TC: 30 (ca thiết kế 6, ca sâu 24). Theo loại: A11Y 1, BOUNDARY 1, DATA 4, E2E 6, EDGE 1, PERFORMANCE 1, PERMISSIONS 9, RED 3, SECURITY 1, STATE 1, UX 2.
- Có kịch bản chạy: 19 ca sâu (đặt tên theo mã ca nên `npm run uat:run` nhận): apps/api/test/uat/ebs.uat.test.ts; apps/api/test/uat/enterprise-authz.uat.test.ts.
- Làm tay: 5 ca sâu và 6 ca thiết kế. Lý do từng ca ở trường `automation.reason` của `uat.json`.

## Ca sâu chưa có kịch bản và lý do

- UAT-EBS-E2E-03: Cần ánh xạ mã của INT-03 (cần hai người duyệt); chưa nối hai suite INT và EBS với nhau
- UAT-EBS-EDG-02: Chưa viết bảng giá trị biên; bố cục tệp là giả định nên biên cần được chốt với khách trước (PX-04)
- UAT-EBS-PRF-01: Cần bộ dữ liệu 5.000 mục; chưa có bộ sinh dữ liệu cho EBS
- UAT-EBS-A11-01: Chưa có đi bàn phím riêng cho hai màn này; quét axe chung nằm ở apps/web/e2e/a11y.spec.ts
- UAT-EBS-PX-01: Chờ khách cung cấp mẫu tệp sao kê EBS thật (PX-04)
