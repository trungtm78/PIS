# Sổ phủ — phân hệ NFR

M2=0 · FP=0 · risk=STANDARD

> **Phạm vi:** 69 ca thiết kế của phân hệ NFR (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro STANDARD do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-NFR-ACCESSIBILITY-01 | ISO 25010 · accessibility | NFR-ACCESSIBILITY-01: WCAG 2.2 AA cho luồng lõi web | traceability.json / nonfunctional_requirements.json | TC-UX01, TC-UAT-NFR-ACCESSIBILITY-01 | ✅ |
| COV-NFR-ACCESSIBILITY-02 | ISO 25010 · accessibility | NFR-ACCESSIBILITY-02: Khả năng tiếp cận ứng dụng Flutter | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-ACCESSIBILITY-02 | ✅ |
| COV-NFR-AI-01 | ISO 25010 · ai | NFR-AI-01: Định tuyến AI theo phân loại dữ liệu (R5) | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-AI-01 | ✅ |
| COV-NFR-AI-02 | ISO 25010 · ai | NFR-AI-02: Phòng chống prompt injection và giới hạn hành động AI | traceability.json / nonfunctional_requirements.json | TC-AI01, TC-UAT-NFR-AI-02 | ✅ |
| COV-NFR-AI-03 | ISO 25010 · ai | NFR-AI-03: Ngân sách và chi phí AI không vượt do đồng thời | traceability.json / nonfunctional_requirements.json | TC-AI02, TC-UAT-NFR-AI-03 | ✅ |
| COV-NFR-AI-04 | ISO 25010 · ai | NFR-AI-04: Eval trước khi bật profile AI | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-AI-04 | ✅ |
| COV-NFR-AVAILABILITY-01 | ISO 25010 · availability | NFR-AVAILABILITY-01: SLO dịch vụ lõi và ngân sách lỗi | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-AVAILABILITY-01 | ✅ |
| COV-NFR-AVAILABILITY-02 | ISO 25010 · availability | NFR-AVAILABILITY-02: RPO và RTO | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-AVAILABILITY-02 | ✅ |
| COV-NFR-AVAILABILITY-03 | ISO 25010 · availability | NFR-AVAILABILITY-03: Diễn tập khôi phục định kỳ và khôi phục một tenant | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-AVAILABILITY-03 | ✅ |
| COV-NFR-AVAILABILITY-04 | ISO 25010 · availability | NFR-AVAILABILITY-04: Suy giảm có kiểm soát khi provider lỗi | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-AVAILABILITY-04 | ✅ |
| COV-NFR-LEGAL-01 | ISO 25010 · legal | NFR-LEGAL-01: Lưu trú dữ liệu tại Việt Nam | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-LEGAL-01 | ✅ |
| COV-NFR-LEGAL-02 | ISO 25010 · legal | NFR-LEGAL-02: Quy tắc và mẫu pháp lý là dữ liệu có hiệu lực | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-LEGAL-02, TC-UAT-PLAN-13 | ✅ |
| COV-NFR-LEGAL-03 | ISO 25010 · legal | NFR-LEGAL-03: Hồ sơ cấp độ an toàn hệ thống thông tin và ứng cứu sự cố | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-LEGAL-03 | ✅ |
| COV-NFR-OBSERVABILITY-01 | ISO 25010 · observability | NFR-OBSERVABILITY-01: Telemetry có tenant_id, không PII | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-OBSERVABILITY-01 | ✅ |
| COV-NFR-OBSERVABILITY-02 | ISO 25010 · observability | NFR-OBSERVABILITY-02: Cảnh báo có owner và runbook, kênh vận hành độc lập | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-OBSERVABILITY-02 | ✅ |
| COV-NFR-OPERABILITY-01 | ISO 25010 · operability | NFR-OPERABILITY-01: Hạ tầng vào theo slice có điều kiện (R1) | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-OPERABILITY-01 | ✅ |
| COV-NFR-OPERABILITY-02 | ISO 25010 · operability | NFR-OPERABILITY-02: Gate CI/CD và ranh giới module | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-OPERABILITY-02 | ✅ |
| COV-NFR-OPERABILITY-03 | ISO 25010 · operability | NFR-OPERABILITY-03: Migration expand-contract và rollback an toàn | traceability.json / nonfunctional_requirements.json | TC-OPS02, TC-UAT-NFR-OPERABILITY-03 | ✅ |
| COV-NFR-OPERABILITY-04 | ISO 25010 · operability | NFR-OPERABILITY-04: Temporal là chủ điều phối duy nhất, domain là guard (R9) | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-OPERABILITY-04 | ✅ |
| COV-NFR-OPERABILITY-05 | ISO 25010 · operability | NFR-OPERABILITY-05: Outbox/inbox at-least-once với consumer idempotent | traceability.json / nonfunctional_requirements.json | TC-TX03, TC-NOT01, TC-UAT-NFR-OPERABILITY-05 | ✅ |
| COV-NFR-OPERABILITY-06 | ISO 25010 · operability | NFR-OPERABILITY-06: Import tệp idempotent và đối soát (A3) | traceability.json / nonfunctional_requirements.json | TC-DQ01, TC-UAT-NFR-OPERABILITY-06 | ✅ |
| COV-NFR-PERFORMANCE-01 | ISO 25010 · performance | NFR-PERFORMANCE-01: Ngân sách hiệu năng API đọc | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-PERFORMANCE-01 | ✅ |
| COV-NFR-PERFORMANCE-02 | ISO 25010 · performance | NFR-PERFORMANCE-02: Ngân sách hiệu năng màn hình nghiệp vụ và command | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-PERFORMANCE-02 | ✅ |
| COV-NFR-PERFORMANCE-03 | ISO 25010 · performance | NFR-PERFORMANCE-03: BI từ snapshot kỳ, truy vấn nặng bất đồng bộ | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-PERFORMANCE-03, TC-UAT-PLAN-11 | ✅ |
| COV-NFR-PERFORMANCE-04 | ISO 25010 · performance | NFR-PERFORMANCE-04: Quota theo tenant chống noisy neighbor | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-PERFORMANCE-04 | ✅ |
| COV-NFR-PRIVACY-01 | ISO 25010 · privacy | NFR-PRIVACY-01: Consent xử lý dữ liệu cá nhân | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-PRIVACY-01 | ✅ |
| COV-NFR-PRIVACY-02 | ISO 25010 · privacy | NFR-PRIVACY-02: Tối thiểu hóa và che dữ liệu cá nhân | traceability.json / nonfunctional_requirements.json | TC-NOT02, TC-UAT-NFR-PRIVACY-02 | ✅ |
| COV-NFR-PRIVACY-03 | ISO 25010 · privacy | NFR-PRIVACY-03: Yêu cầu của chủ thể dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-PRIVACY-03 | ✅ |
| COV-NFR-PRIVACY-04 | ISO 25010 · privacy | NFR-PRIVACY-04: Không chuyển dữ liệu ra nước ngoài khi chưa đánh giá | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-PRIVACY-04 | ✅ |
| COV-NFR-RETENTION-01 | ISO 25010 · retention | NFR-RETENTION-01: Chính sách lưu giữ là dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-RETENTION-01 | ✅ |
| COV-NFR-RETENTION-02 | ISO 25010 · retention | NFR-RETENTION-02: Legal hold | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-RETENTION-02 | ✅ |
| COV-NFR-RETENTION-03 | ISO 25010 · retention | NFR-RETENTION-03: Xuất dữ liệu và kết thúc dịch vụ tenant | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-RETENTION-03 | ✅ |
| COV-NFR-SECURITY-01 | ISO 25010 · security | NFR-SECURITY-01: Chống tự nâng quyền | traceability.json / nonfunctional_requirements.json | TC-SEC05, TC-UAT-NFR-SECURITY-01 | ✅ |
| COV-NFR-SECURITY-02 | ISO 25010 · security | NFR-SECURITY-02: Control plane System Admin tách biệt | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-SECURITY-02 | ✅ |
| COV-NFR-SECURITY-03 | ISO 25010 · security | NFR-SECURITY-03: MFA và quản lý phiên | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-SECURITY-03 | ✅ |
| COV-NFR-SECURITY-04 | ISO 25010 · security | NFR-SECURITY-04: Idempotency cho mọi command | traceability.json / nonfunctional_requirements.json | TC-TX02, TC-MOB01, TC-UAT-NFR-SECURITY-04 | ✅ |
| COV-NFR-SECURITY-05 | ISO 25010 · security | NFR-SECURITY-05: Khóa lạc quan bằng If-Match | traceability.json / nonfunctional_requirements.json | TC-MOB01, TC-UAT-NFR-SECURITY-05 | ✅ |
| COV-NFR-SECURITY-06 | ISO 25010 · security | NFR-SECURITY-06: Quản lý secret | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-SECURITY-06 | ✅ |
| COV-NFR-SECURITY-07 | ISO 25010 · security | NFR-SECURITY-07: Chuỗi cung ứng phần mềm (dependency audit) | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-SECURITY-07 | ✅ |
| COV-NFR-SECURITY-08 | ISO 25010 · security | NFR-SECURITY-08: Cấm ghi chung trạng thái, tenant, quyền và tiền đã chốt | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-SECURITY-08 | ✅ |
| COV-NFR-SECURITY-09 | ISO 25010 · security | NFR-SECURITY-09: Toàn vẹn số dư và tiền dưới đồng thời | traceability.json / nonfunctional_requirements.json | TC-TX01, TC-UAT-NFR-SECURITY-09 | ✅ |
| COV-NFR-SECURITY-10 | ISO 25010 · security | NFR-SECURITY-10: Callback provider xác thực và dedupe | traceability.json / nonfunctional_requirements.json | TC-TX03, TC-NOT01, TC-UAT-NFR-SECURITY-10 | ✅ |
| COV-NFR-SECURITY-11 | ISO 25010 · security | NFR-SECURITY-11: Audit bất biến | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-SECURITY-11 | ✅ |
| COV-NFR-SECURITY-12 | ISO 25010 · security | NFR-SECURITY-12: Kiểm tra tệp tải lên | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-SECURITY-12 | ✅ |
| COV-NFR-TENANCY-01 | ISO 25010 · tenancy | NFR-TENANCY-01: Cách ly tenant ở API (object-level) | traceability.json / nonfunctional_requirements.json | TC-SEC01, TC-NOT02, TC-UAT-NFR-TENANCY-01 | ✅ |
| COV-NFR-TENANCY-02 | ISO 25010 · tenancy | NFR-TENANCY-02: Cách ly tenant ở PostgreSQL bằng RLS | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-TENANCY-02 | ✅ |
| COV-NFR-TENANCY-03 | ISO 25010 · tenancy | NFR-TENANCY-03: Cách ly tenant ở cache | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-TENANCY-03 | ✅ |
| COV-NFR-TENANCY-04 | ISO 25010 · tenancy | NFR-TENANCY-04: Cách ly tenant ở search và vector | traceability.json / nonfunctional_requirements.json | TC-SEC01, TC-UAT-NFR-TENANCY-04 | ✅ |
| COV-NFR-TENANCY-05 | ISO 25010 · tenancy | NFR-TENANCY-05: Cách ly tenant ở object storage | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-TENANCY-05 | ✅ |
| COV-NFR-TENANCY-06 | ISO 25010 · tenancy | NFR-TENANCY-06: Cách ly tenant và scope ở export/BI job | traceability.json / nonfunctional_requirements.json | TC-SEC01, TC-UAT-NFR-TENANCY-06 | ✅ |
| COV-NFR-TENANCY-07 | ISO 25010 · tenancy | NFR-TENANCY-07: Cách ly tenant trong đồng bộ mobile PowerSync (A1) | traceability.json / nonfunctional_requirements.json | TC-MOB02, TC-UAT-NFR-TENANCY-07 | ✅ |
| COV-NFR-TENANCY-08 | ISO 25010 · tenancy | NFR-TENANCY-08: Tenant context ký cho job nền, outbox và Temporal | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-TENANCY-08 | ✅ |
| COV-NFR-TENANCY-09 | ISO 25010 · tenancy | NFR-TENANCY-09: Scope trong tenant theo cây đơn vị và guest nhà thầu (R6) | traceability.json / nonfunctional_requirements.json | TC-UAT-NFR-TENANCY-09 | ✅ |

## Tổng

- Coverage item: 53, mỗi item có ít nhất một TC (53/53).
- TC: 69 (hợp đồng màn hình 0, nghiệp vụ và phi chức năng 69).
