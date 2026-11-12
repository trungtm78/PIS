# Sổ phủ — phân hệ IND

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 6 ca thiết kế của phân hệ (`test_cases.json`, chuyển nguyên văn) và 26 ca sâu viết cho bản enterprise (ma trận quyền theo từng thao tác của openapi.json, idempotency, đường chuyển trạng thái sai, kiểm toán và outbox, cách ly tenant, hiệu năng theo ngân sách của khách, a11y, việc chờ khách PX-nn).
> Ca sâu đã được thêm vào `Design/MACHVON_Design/03_Engineering/test_cases.json` và `traceability.json` (nguồn "UAT enterprise (lane uatent)") để `npm run uat:run` và `npm run uat:evidence` nhận ra theo mã ca. Kết quả mong đợi của ca thiết kế là của thiết kế; ca sâu lấy kỳ vọng từ openapi.json (x-permission, mã lỗi), `screen_catalog.json` và quy tắc của màn hình, không lấy từ mã.
> Dòng HSKT: DL.02. Màn: IND-01, IND-02, IND-03. Câu chuyện: ST-IND-001, ST-IND-002, ST-IND-003.

## Bảng coverage item

| cov_id | Coverage item | TC phủ | Trạng thái |
|---|---|---|---|
| COV-FR-IND-01 | FR-IND-01 | TC-UAT-PLAN-IND-1, TC-UAT-PLAN-IND-2, TC-UI-IND-01, TC-UAT-IND-E2E-01, TC-UAT-IND-IDM-01, TC-UAT-IND-EDG-01, TC-UAT-IND-STA-01, TC-UAT-IND-ISO-01, TC-UAT-IND-SCP-01, TC-UAT-IND-BND-01, TC-UAT-IND-PRF-01, TC-UAT-IND-A11-01, TC-UAT-IND-PX-01, TC-UAT-IND-SEC-01, TC-UAT-IND-SEC-02, TC-UAT-IND-SEC-04, TC-UAT-IND-SEC-07, TC-UAT-IND-SEC-08, TC-UAT-IND-SEC-09, TC-UAT-IND-SEC-10, TC-UAT-IND-SEC-12 | ✅ |
| COV-FR-IND-02 | FR-IND-02 | TC-UAT-PLAN-IND-1, TC-UAT-PLAN-IND-2, TC-UI-IND-02, TC-UAT-IND-DAT-01, TC-UAT-IND-A11-01, TC-UAT-IND-PX-01, TC-UAT-IND-SEC-03 | ✅ |
| COV-FR-IND-03 | FR-IND-03 | TC-UAT-PLAN-IND-3, TC-UI-IND-03, TC-UAT-IND-E2E-02, TC-UAT-IND-A11-01, TC-UAT-IND-SEC-05, TC-UAT-IND-SEC-06, TC-UAT-IND-SEC-11, TC-UAT-IND-SEC-13, TC-UAT-IND-SEC-14 | ✅ |

## Tổng

- Coverage item: 3, mỗi item có ít nhất một TC (3/3).
- TC: 32 (ca thiết kế 6, ca sâu 26). Theo loại: A11Y 1, BOUNDARY 1, DATA 2, E2E 6, EDGE 1, PERFORMANCE 1, PERMISSIONS 15, SECURITY 1, STATE 1, UX 3.
- Có kịch bản chạy: 21 ca sâu (đặt tên theo mã ca nên `npm run uat:run` nhận): apps/api/test/uat/ind.uat.test.ts; apps/api/test/uat/enterprise-authz.uat.test.ts.
- Làm tay: 5 ca sâu và 6 ca thiết kế. Lý do từng ca ở trường `automation.reason` của `uat.json`.

## Ca sâu chưa có kịch bản và lý do

- UAT-IND-SCP-01: Suite dùng grant theo cả tenant; phạm vi đơn vị đã có ở apps/api/test/ind/ind.test.ts, chưa nối vào world của UAT
- UAT-IND-BND-01: Chưa chốt bảng giá trị biên với Tổ chuẩn hóa dữ liệu (PX-02: từ điển chỉ tiêu và quy tắc nhập liệu do khách chốt)
- UAT-IND-PRF-01: Cần bộ dữ liệu; chưa có bộ sinh số liệu chỉ tiêu
- UAT-IND-A11-01: Chưa có đi bàn phím riêng; quét axe chung ở apps/web/e2e/a11y.spec.ts
- UAT-IND-PX-01: Chờ Tổ chuẩn hóa dữ liệu của khách thống nhất từ điển chỉ tiêu (PX-02)
