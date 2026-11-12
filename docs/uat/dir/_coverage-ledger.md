# Sổ phủ — phân hệ DIR

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 15 ca thiết kế của phân hệ (`test_cases.json`, chuyển nguyên văn) và 33 ca sâu viết cho bản enterprise (ma trận quyền theo từng thao tác của openapi.json, idempotency, đường chuyển trạng thái sai, kiểm toán và outbox, cách ly tenant, hiệu năng theo ngân sách của khách, a11y, việc chờ khách PX-nn).
> Ca sâu đã được thêm vào `Design/MACHVON_Design/03_Engineering/test_cases.json` và `traceability.json` (nguồn "UAT enterprise (lane uatent)") để `npm run uat:run` và `npm run uat:evidence` nhận ra theo mã ca. Kết quả mong đợi của ca thiết kế là của thiết kế; ca sâu lấy kỳ vọng từ openapi.json (x-permission, mã lỗi), `screen_catalog.json` và quy tắc của màn hình, không lấy từ mã.
> Dòng HSKT: CN.03. Màn: DIR-01, DIR-02, DIR-03, DIR-04, DIR-05, DIR-06. Câu chuyện: ST-DIR-001, ST-DIR-002, ST-DIR-003, ST-DIR-004, ST-DIR-005.

## Bảng coverage item

| cov_id | Coverage item | TC phủ | Trạng thái |
|---|---|---|---|
| COV-FR-DIR-01 | FR-DIR-01 | TC-UAT-PLAN-132, TC-UAT-PLAN-133, TC-UI-DIR-01, TC-UAT-DIR-IDM-01, TC-UAT-DIR-IDM-02, TC-UAT-DIR-EDG-01, TC-UAT-DIR-A11-01, TC-UAT-DIR-SEC-01, TC-UAT-DIR-SEC-02, TC-UAT-DIR-SEC-04 | ✅ |
| COV-FR-DIR-02 | FR-DIR-02 | TC-UAT-PLAN-132, TC-UAT-PLAN-133, TC-UI-DIR-02, TC-UAT-DIR-EDG-01, TC-UAT-DIR-SEC-03, TC-UAT-DIR-SEC-05 | ✅ |
| COV-FR-DIR-03 | FR-DIR-03 | TC-UAT-PLAN-134, TC-UAT-PLAN-135, TC-UI-DIR-03, TC-UAT-DIR-E2E-01, TC-UAT-DIR-DAT-01, TC-UAT-DIR-SCP-01, TC-UAT-DIR-PRF-01, TC-UAT-DIR-A11-01, TC-UAT-DIR-SEC-07, TC-UAT-DIR-SEC-08, TC-UAT-DIR-SEC-10 | ✅ |
| COV-FR-DIR-04 | FR-DIR-04 | TC-UAT-PLAN-136, TC-UAT-PLAN-137, TC-UAT-PLAN-138, TC-UI-DIR-04, TC-UAT-DIR-E2E-01, TC-UAT-DIR-SOD-01, TC-UAT-DIR-STA-01, TC-UAT-DIR-STA-02, TC-UAT-DIR-ISO-01, TC-UAT-DIR-A11-01, TC-UAT-DIR-SEC-06, TC-UAT-DIR-SEC-11, TC-UAT-DIR-SEC-12, TC-UAT-DIR-SEC-13, TC-UAT-DIR-SEC-14, TC-UAT-DIR-SEC-15, TC-UAT-DIR-SEC-16, TC-UAT-DIR-SEC-17, TC-UAT-DIR-SEC-18, TC-UAT-DIR-SEC-19 | ✅ |
| COV-FR-DIR-05 | FR-DIR-05 | TC-UAT-PLAN-139, TC-UI-DIR-05, TC-UAT-DIR-DAT-01, TC-UAT-DIR-E2E-02, TC-UAT-DIR-SEC-09 | ✅ |
| COV-FR-DIR-06 | FR-DIR-06 | TC-UAT-PLAN-140, TC-UI-DIR-06, TC-UAT-DIR-PWA-01 | ✅ |

## Tổng

- Coverage item: 6, mỗi item có ít nhất một TC (6/6).
- TC: 48 (ca thiết kế 15, ca sâu 33). Theo loại: A11Y 1, DATA 3, E2E 10, EDGE 1, PERFORMANCE 1, PERMISSIONS 20, RED 2, SECURITY 1, STATE 2, UX 7.
- Có kịch bản chạy: 28 ca sâu (đặt tên theo mã ca nên `npm run uat:run` nhận): apps/api/test/uat/dir.uat.test.ts; apps/api/test/uat/enterprise-authz.uat.test.ts.
- Làm tay: 5 ca sâu và 15 ca thiết kế. Lý do từng ca ở trường `automation.reason` của `uat.json`.

## Ca sâu chưa có kịch bản và lý do

- UAT-DIR-SCP-01: Suite hiện dùng grant theo cả tenant; ca phạm vi đơn vị cần grant UNIT_ONLY (đã có ở apps/api/test/dir/directive.test.ts), chưa nối vào world của UAT
- UAT-DIR-E2E-02: Cần kỳ báo cáo và đồng hồ giả; suite hiện chưa dựng kỳ báo cáo cho DIR
- UAT-DIR-PWA-01: Cần trình duyệt di động giả lập trên bản enterprise; có sẵn apps/web/e2e/pwa-flows.spec.ts nhưng không đặt tên theo mã ca
- UAT-DIR-PRF-01: Cần bộ dữ liệu 2.000 chỉ đạo; chưa có bộ sinh
- UAT-DIR-A11-01: Chưa có đi bàn phím riêng; quét axe chung ở apps/web/e2e/a11y.spec.ts
