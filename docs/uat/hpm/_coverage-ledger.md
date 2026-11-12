# Sổ phủ — phân hệ HPM

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 6 ca thiết kế của phân hệ (`test_cases.json`, chuyển nguyên văn) và 26 ca sâu viết cho bản enterprise (ma trận quyền theo từng thao tác của openapi.json, idempotency, đường chuyển trạng thái sai, kiểm toán và outbox, cách ly tenant, hiệu năng theo ngân sách của khách, a11y, việc chờ khách PX-nn).
> Ca sâu đã được thêm vào `Design/MACHVON_Design/03_Engineering/test_cases.json` và `traceability.json` (nguồn "UAT enterprise (lane uatent)") để `npm run uat:run` và `npm run uat:evidence` nhận ra theo mã ca. Kết quả mong đợi của ca thiết kế là của thiết kế; ca sâu lấy kỳ vọng từ openapi.json (x-permission, mã lỗi), `screen_catalog.json` và quy tắc của màn hình, không lấy từ mã.
> Dòng HSKT: TH.01. Màn: HPM-01, HPM-02. Câu chuyện: ST-HPM-001, ST-HPM-002.

## Bảng coverage item

| cov_id | Coverage item | TC phủ | Trạng thái |
|---|---|---|---|
| COV-FR-HPM-01 | FR-HPM-01 | TC-UI-HPM-01, TC-UAT-PLAN-169, TC-UAT-PLAN-170, TC-UAT-HPM-E2E-01, TC-UAT-HPM-IDM-01, TC-UAT-HPM-IDM-02, TC-UAT-HPM-IDM-03, TC-UAT-HPM-IDM-04, TC-UAT-HPM-STA-01, TC-UAT-HPM-STA-02, TC-UAT-HPM-SOD-01, TC-UAT-HPM-DAT-01, TC-UAT-HPM-ISO-01, TC-UAT-HPM-STA-03, TC-UAT-HPM-EDG-01, TC-UAT-HPM-DEMO-01, TC-UAT-HPM-PRF-01, TC-UAT-HPM-A11-01, TC-UAT-HPM-PX-01, TC-UAT-HPM-SEC-01, TC-UAT-HPM-SEC-02, TC-UAT-HPM-SEC-03, TC-UAT-HPM-SEC-04, TC-UAT-HPM-SEC-05, TC-UAT-HPM-SEC-06 | ✅ |
| COV-FR-HPM-02 | FR-HPM-02 | TC-UI-HPM-02, TC-UAT-PLAN-171, TC-UAT-PLAN-172, TC-UAT-HPM-E2E-02, TC-UAT-HPM-A11-01, TC-UAT-HPM-SEC-07, TC-UAT-HPM-SEC-08, TC-UAT-HPM-SEC-09 | ✅ |

## Tổng

- Coverage item: 2, mỗi item có ít nhất một TC (2/2).
- TC: 32 (ca thiết kế 6, ca sâu 26). Theo loại: A11Y 1, BOUNDARY 1, DATA 4, E2E 5, PERFORMANCE 1, PERMISSIONS 9, RED 5, SECURITY 1, STATE 3, UX 2.
- Có kịch bản chạy: 19 ca sâu (đặt tên theo mã ca nên `npm run uat:run` nhận): apps/api/test/uat/hpm.uat.test.ts; apps/api/test/uat/enterprise-authz.uat.test.ts.
- Làm tay: 7 ca sâu và 6 ca thiết kế. Lý do từng ca ở trường `automation.reason` của `uat.json`.

## Ca sâu chưa có kịch bản và lý do

- UAT-HPM-STA-03: Cần bơm lỗi vào bộ ghi tệp (giả đĩa đầy), cổng tải bộ ghi chỉ có ở bài jest tích hợp apps/api/test/editions/hpm.enterprise.test.ts, không đạt được qua HTTP của bản đang chạy
- UAT-HPM-E2E-02: Cần kỳ mở lại thật của DIS (cổng HPM_PERIOD_REOPEN); jest tích hợp dùng bản giả của cổng, UAT cần chạy trên bản đã gộp có DIS thật
- UAT-HPM-EDG-01: Chưa viết kịch bản; có thể thêm vào hpm.uat.test.ts, không đòi hỏi thêm hạ tầng
- UAT-HPM-DEMO-01: Cần một bản phát hành từ động cơ báo cáo trên biểu mẫu DEMO (RPT làm trước); suite RPT chưa phát hành biểu mẫu DEMO
- UAT-HPM-PRF-01: Cần bộ dữ liệu 1.000 lượt đẩy; chưa có bộ sinh dữ liệu cho HPM
- UAT-HPM-A11-01: Đã có quét axe 111 màn trong apps/web/e2e/a11y.spec.ts nhưng không đặt tên theo mã ca; chưa có đi bàn phím riêng cho hai màn này
- UAT-HPM-PX-01: Chờ khách cung cấp giao diện kỹ thuật HPM (PX-03); không thể chạy trước khi có tài liệu
