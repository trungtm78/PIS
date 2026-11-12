# Sổ phủ — phân hệ ENT

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 28 ca thiết kế của phân hệ (`test_cases.json`, chuyển nguyên văn) và 40 ca sâu viết cho bản enterprise (ma trận quyền theo từng thao tác của openapi.json, idempotency, đường chuyển trạng thái sai, kiểm toán và outbox, cách ly tenant, hiệu năng theo ngân sách của khách, a11y, việc chờ khách PX-nn).
> Ca sâu đã được thêm vào `Design/MACHVON_Design/03_Engineering/test_cases.json` và `traceability.json` (nguồn "UAT enterprise (lane uatent)") để `npm run uat:run` và `npm run uat:evidence` nhận ra theo mã ca. Kết quả mong đợi của ca thiết kế là của thiết kế; ca sâu lấy kỳ vọng từ openapi.json (x-permission, mã lỗi), `screen_catalog.json` và quy tắc của màn hình, không lấy từ mã.
> Dòng HSKT: DL.03, BC.02, YCK.01, MD.01, MD.02, CN.01. Màn: ORG-01, IPF-01, BI-02, DOC-24, EQP-01, EQP-02, PWA-01, PWA-02, PWA-03, PWA-04, PWA-05, PWA-06, PWA-07, PWA-08, PWA-09, PWA-10. Câu chuyện: ST-ORG-001, ST-EQP-001, ST-IPF-001, ST-BI-004, ST-RML-002, ST-PWA-001, ST-PWA-002, ST-PWA-003, ST-PWA-004.

## Bảng coverage item

| cov_id | Coverage item | TC phủ | Trạng thái |
|---|---|---|---|
| COV-FR-ADM-31 | FR-ADM-31 | TC-UAT-DIS-ENT4C-1, TC-UAT-DIS-ENT4C-3 | ✅ |
| COV-FR-ADM-AUDIT-DETAIL | FR-ADM-AUDIT-DETAIL | TC-UAT-ADM-ENT4E-1 | ✅ |
| COV-FR-ADM-ENT3D | FR-ADM-ENT3D | TC-UI-ORG-01, TC-UAT-PLAN-ORG-1, TC-UAT-PLAN-ORG-2, TC-UAT-ENT-ORG-01, TC-UAT-ENT-PX-01, TC-UAT-ENT-SEC-01, TC-UAT-ENT-SEC-02 | ✅ |
| COV-FR-ADM-LOG-CAPACITY | FR-ADM-LOG-CAPACITY | TC-UAT-ADM-ENT4E-2 | ✅ |
| COV-FR-BI-02 | FR-BI-02 | TC-UAT-ENT-BI-01 | ✅ |
| COV-FR-DIS-32 | FR-DIS-32 | TC-UAT-DIS-ENT3A-1, TC-UAT-ENT-E2E-01, TC-UAT-ENT-IDM-01, TC-UAT-ENT-STA-01, TC-UAT-ENT-SEC-03, TC-UAT-ENT-SEC-04, TC-UAT-ENT-SEC-05, TC-UAT-ENT-SEC-06, TC-UAT-ENT-SEC-07 | ✅ |
| COV-FR-DIS-33 | FR-DIS-33 | TC-UAT-DIS-ENT3A-1, TC-UAT-ENT-E2E-01, TC-UAT-ENT-SOD-01, TC-UAT-ENT-DAT-01, TC-UAT-ENT-ISO-01, TC-UAT-ENT-SCP-01 | ✅ |
| COV-FR-DIS-34 | FR-DIS-34 | TC-UAT-DIS-ENT4C-1, TC-UAT-DIS-ENT4C-2, TC-UAT-DIS-ENT4C-3 | ✅ |
| COV-FR-DIS-35 | FR-DIS-35 | TC-UAT-DIS-ENT3B-1, TC-UAT-ENT-NAR-01, TC-UAT-ENT-SEC-14, TC-UAT-ENT-SEC-15, TC-UAT-ENT-SEC-16 | ✅ |
| COV-FR-EQP-01 | FR-EQP-01 | TC-UI-EQP-01, TC-UAT-EQP-ENT4E-1, TC-UAT-ENT-EQP-01, TC-UAT-ENT-SEC-10, TC-UAT-ENT-SEC-12 | ✅ |
| COV-FR-EQP-02 | FR-EQP-02 | TC-UI-EQP-02, TC-UAT-EQP-ENT4E-1, TC-UAT-ENT-EQP-01, TC-UAT-ENT-SEC-11, TC-UAT-ENT-SEC-13 | ✅ |
| COV-FR-IPF-01 | FR-IPF-01 | TC-UI-IPF-01, TC-UAT-ENT-IPF-01, TC-UAT-ENT-IPF-02, TC-UAT-ENT-IPF-03, TC-UAT-ENT-IPF-04, TC-UAT-ENT-IPF-05, TC-UAT-ENT-IPF-06, TC-UAT-ENT-SEC-17 | ✅ |
| COV-YCK.01 | YCK.01 | TC-UI-PWA-01, TC-UI-PWA-02, TC-UI-PWA-03, TC-UI-PWA-04, TC-UI-PWA-05, TC-UI-PWA-06, TC-UI-PWA-07, TC-UI-PWA-08, TC-UI-PWA-09, TC-UI-PWA-10, TC-UAT-PWA-01, TC-UAT-PWA-02, TC-UAT-PWA-03, TC-UAT-PWA-04, TC-UAT-ENT-DAT-01, TC-UAT-ENT-PWA-01, TC-UAT-ENT-PWA-02, TC-UAT-ENT-PWA-03, TC-UAT-ENT-PRF-01, TC-UAT-ENT-A11-01, TC-UAT-ENT-SEC-08, TC-UAT-ENT-SEC-09 | ✅ |

## Tổng

- Coverage item: 13, mỗi item có ít nhất một TC (13/13).
- TC: 68 (ca thiết kế 28, ca sâu 40). Theo loại: A11Y 1, DATA 2, E2E 22, PERFORMANCE 1, PERMISSIONS 19, RED 1, SECURITY 2, STATE 3, UX 17.
- Có kịch bản chạy: 28 ca sâu (đặt tên theo mã ca nên `npm run uat:run` nhận): apps/api/test/editions/investment-profile.enterprise.test.ts; apps/api/test/editions/project-document-legal-type.enterprise.test.ts; apps/api/test/uat/ent.uat.test.ts; apps/api/test/uat/enterprise-authz.uat.test.ts.
- Làm tay: 12 ca sâu và 28 ca thiết kế. Lý do từng ca ở trường `automation.reason` của `uat.json`.

## Ca sâu chưa có kịch bản và lý do

- UAT-ENT-SCP-01: Suite dùng grant theo cả tenant; ca phạm vi đơn vị đã có ở apps/api/test/fnd/enterprise-snapshot.test.ts, chưa nối vào world của UAT
- UAT-ENT-ORG-01: Cần lô nạp (applied batch) của tệp gói; ca tích hợp đã có ở apps/api/test/editions/org-pack.enterprise.test.ts, chưa dựng trong suite UAT; danh sách 09 đầu mối thật là PX-05
- UAT-ENT-EQP-01: Cần chuỗi kế hoạch, gói thầu, hợp đồng, thanh toán ở BID, CTR, PAY; chưa dựng trong suite; layout nhập tệp là PX-06
- UAT-ENT-PWA-01: Cần PWA trên bản enterprise trong trình duyệt di động; có sẵn apps/web/e2e/pwa-flows.spec.ts (không đặt tên theo mã ca) nhưng chưa có ca mất mạng khi duyệt
- UAT-ENT-PWA-02: Đã có kiểm khổ 360 và 390 px trong apps/web/e2e/pwa-targets.spec.ts; chưa đặt tên theo mã ca nên chưa vào kho kết quả
- UAT-ENT-PWA-03: Cần thiết bị hoặc giả lập đăng ký đẩy; nhà cung cấp đẩy thật là PX-11
- UAT-ENT-NAR-01: Cần báo cáo DIS có thuyết minh nhiều kỳ; ca tích hợp đã có ở apps/api/test/dis/report-decision.test.ts
- UAT-ENT-PRF-01: Cần bộ dữ liệu 22 dự án; đo trên phần cứng khách là PX-10
- UAT-ENT-A11-01: Đã có axe 111 màn và kiểm mục tiêu chạm 44 px (lượt UAT 2); chưa đặt tên theo mã ca
- UAT-ENT-PX-01: Chờ khách cung cấp danh sách 09 đầu mối (PX-05)
- UAT-ENT-IPF-06: Cần trình duyệt trên bản enterprise và bản công khai; vitest apps/web/src/editions/enterprise/screens/ipf/ProfileScreen.test.tsx và every-route.enterprise.test.tsx đã kiểm trạng thái, năm và hai bản, lượt chạy trình duyệt chưa làm
- UAT-ENT-BI-01: Cần trình duyệt và một bảng điều khiển đã qua bước đề nghị, kiểm tra và duyệt; vitest apps/web/src/screens/bi/BoardSignOff.test.tsx đã kiểm trang, trình chiếu và các trạng thái, lượt chạy trình duyệt chưa làm
