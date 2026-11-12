# Sổ phủ — phân hệ HUB

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 7 ca thiết kế của phân hệ (`test_cases.json`, chuyển nguyên văn) và 29 ca sâu viết cho bản enterprise (ma trận quyền theo từng thao tác của openapi.json, idempotency, đường chuyển trạng thái sai, kiểm toán và outbox, cách ly tenant, hiệu năng theo ngân sách của khách, a11y, việc chờ khách PX-nn).
> Ca sâu đã được thêm vào `Design/MACHVON_Design/03_Engineering/test_cases.json` và `traceability.json` (nguồn "UAT enterprise (lane uatent)") để `npm run uat:run` và `npm run uat:evidence` nhận ra theo mã ca. Kết quả mong đợi của ca thiết kế là của thiết kế; ca sâu lấy kỳ vọng từ openapi.json (x-permission, mã lỗi), `screen_catalog.json` và quy tắc của màn hình, không lấy từ mã.
> Dòng HSKT: TH.03. Màn: HUB-01, HUB-02, HUB-03. Câu chuyện: ST-HUB-001.

## Bảng coverage item

| cov_id | Coverage item | TC phủ | Trạng thái |
|---|---|---|---|
| COV-FR-HUB-01 | FR-HUB-01 | TC-UI-HUB-01, TC-UAT-HUB-001, TC-UAT-HUB-002, TC-UAT-HUB-E2E-01, TC-UAT-HUB-IDM-01, TC-UAT-HUB-EDG-01, TC-UAT-HUB-HLT-01, TC-UAT-HUB-PRF-01, TC-UAT-HUB-A11-01, TC-UAT-HUB-SEC-01, TC-UAT-HUB-SEC-02, TC-UAT-HUB-SEC-03, TC-UAT-HUB-SEC-04, TC-UAT-HUB-SEC-08, TC-UAT-HUB-SEC-13 | ✅ |
| COV-FR-HUB-02 | FR-HUB-02 | TC-UI-HUB-02, TC-UAT-HUB-002, TC-UAT-HUB-004, TC-UAT-HUB-DAT-01, TC-UAT-HUB-SOD-01, TC-UAT-HUB-STA-02, TC-UAT-HUB-AGT-01, TC-UAT-HUB-A11-01, TC-UAT-HUB-SEC-05, TC-UAT-HUB-SEC-09, TC-UAT-HUB-SEC-10, TC-UAT-HUB-SEC-11, TC-UAT-HUB-SEC-14, TC-UAT-HUB-SEC-15, TC-UAT-HUB-SEC-16, TC-UAT-HUB-SEC-17 | ✅ |
| COV-FR-HUB-03 | FR-HUB-03 | TC-UI-HUB-03, TC-UAT-HUB-003, TC-UAT-HUB-E2E-01, TC-UAT-HUB-STA-01, TC-UAT-HUB-ISO-01, TC-UAT-HUB-A11-01, TC-UAT-HUB-SEC-06, TC-UAT-HUB-SEC-07, TC-UAT-HUB-SEC-12 | ✅ |

## Tổng

- Coverage item: 3, mỗi item có ít nhất một TC (3/3).
- TC: 36 (ca thiết kế 7, ca sâu 29). Theo loại: A11Y 1, DATA 3, E2E 5, EDGE 1, PERFORMANCE 1, PERMISSIONS 17, RED 1, SECURITY 1, STATE 3, UX 3.
- Có kịch bản chạy: 25 ca sâu (đặt tên theo mã ca nên `npm run uat:run` nhận): apps/api/test/uat/hub.uat.test.ts; apps/api/test/uat/enterprise-authz.uat.test.ts.
- Làm tay: 4 ca sâu và 7 ca thiết kế. Lý do từng ca ở trường `automation.reason` của `uat.json`.

## Ca sâu chưa có kịch bản và lý do

- UAT-HUB-HLT-01: Cần dựng đúng hai bộ kết nối đã chạy trên tenant sạch; thứ tự các suite hiện làm tenant không sạch
- UAT-HUB-AGT-01: Cần đồng hồ giả để quá hạn nhịp tim; suite dùng đồng hồ thật
- UAT-HUB-PRF-01: Cần bộ dữ liệu lớn; chưa có bộ sinh
- UAT-HUB-A11-01: Chưa có đi bàn phím riêng; quét axe chung ở apps/web/e2e/a11y.spec.ts
