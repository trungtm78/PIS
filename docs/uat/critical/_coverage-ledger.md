# Sổ phủ — ca then chốt (money · isolation · restore)

M2=0 · FP=0 · risk=CRITICAL

> **Phạm vi:** 28 ca then chốt của `docs/uat-critical.json` (tiền, cách ly tenant, khôi phục), lấy nguyên từ ca thiết kế `test_cases.json`.
> Đây là lát cắt chặn phát hành, không phải bộ UAT đầy đủ (1.097 ca thiết kế). Sàn `TC_min` theo mức CRITICAL (120) áp cho cả bộ đầy đủ; lát này
> không độn thêm ca để đạt con số đó (độn ca là padding). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-BI-12 | AC/Requirement | FR-BI-12: FR-BI-12 | design/nonfunctional_requirements.json | TC-BI02 | ✅ |
| COV-FR-SAS-04 | AC/Requirement | FR-SAS-04: FR-SAS-04 | design/nonfunctional_requirements.json | TC-TH01, TC-TH05 | ✅ |
| COV-FR-SAS-21 | AC/Requirement | FR-SAS-21: FR-SAS-21 | design/nonfunctional_requirements.json | TC-OPS01 | ✅ |
| COV-NFR-AVAILABILITY-02 | ISO 25010 · availability | NFR-AVAILABILITY-02: RPO và RTO | design/nonfunctional_requirements.json | TC-OPS01, TC-UAT-NFR-AVAILABILITY-02 | ✅ |
| COV-NFR-AVAILABILITY-03 | ISO 25010 · availability | NFR-AVAILABILITY-03: Diễn tập khôi phục định kỳ và khôi phục một tenant | design/nonfunctional_requirements.json | TC-OPS01, TC-UAT-NFR-AVAILABILITY-03 | ✅ |
| COV-NFR-OPERABILITY-03 | ISO 25010 · operability | NFR-OPERABILITY-03: Migration expand-contract và rollback an toàn | design/nonfunctional_requirements.json | TC-OPS02, TC-UAT-NFR-OPERABILITY-03 | ✅ |
| COV-NFR-OPERABILITY-05 | ISO 25010 · operability | NFR-OPERABILITY-05: Outbox/inbox at-least-once với consumer idempotent | design/nonfunctional_requirements.json | TC-TX03, TC-NOT01 | ✅ |
| COV-NFR-PRIVACY-02 | ISO 25010 · privacy | NFR-PRIVACY-02: Tối thiểu hóa và che dữ liệu cá nhân | design/nonfunctional_requirements.json | TC-NOT02 | ✅ |
| COV-NFR-SECURITY-04 | ISO 25010 · security | NFR-SECURITY-04: Idempotency cho mọi command | design/nonfunctional_requirements.json | TC-TX02, TC-MOB01, TC-UAT-NFR-SECURITY-04 | ✅ |
| COV-NFR-SECURITY-05 | ISO 25010 · security | NFR-SECURITY-05: Khóa lạc quan bằng If-Match | design/nonfunctional_requirements.json | TC-MOB01 | ✅ |
| COV-NFR-SECURITY-09 | ISO 25010 · security | NFR-SECURITY-09: Toàn vẹn số dư và tiền dưới đồng thời | design/nonfunctional_requirements.json | TC-TX01, TC-UAT-NFR-SECURITY-09 | ✅ |
| COV-NFR-SECURITY-10 | ISO 25010 · security | NFR-SECURITY-10: Callback provider xác thực và dedupe | design/nonfunctional_requirements.json | TC-TX03, TC-NOT01, TC-UAT-NFR-SECURITY-10 | ✅ |
| COV-NFR-TENANCY-01 | ISO 25010 · tenancy | NFR-TENANCY-01: Cách ly tenant ở API (object-level) | design/nonfunctional_requirements.json | TC-SEC01, TC-TH01, TC-NOT02, TC-UAT-NFR-TENANCY-01 | ✅ |
| COV-NFR-TENANCY-02 | ISO 25010 · tenancy | NFR-TENANCY-02: Cách ly tenant ở PostgreSQL bằng RLS | design/nonfunctional_requirements.json | TC-UAT-NFR-TENANCY-02 | ✅ |
| COV-NFR-TENANCY-03 | ISO 25010 · tenancy | NFR-TENANCY-03: Cách ly tenant ở cache | design/nonfunctional_requirements.json | TC-TH05, TC-UAT-NFR-TENANCY-03 | ✅ |
| COV-NFR-TENANCY-04 | ISO 25010 · tenancy | NFR-TENANCY-04: Cách ly tenant ở search và vector | design/nonfunctional_requirements.json | TC-SEC01, TC-UAT-NFR-TENANCY-04 | ✅ |
| COV-NFR-TENANCY-05 | ISO 25010 · tenancy | NFR-TENANCY-05: Cách ly tenant ở object storage | design/nonfunctional_requirements.json | TC-UAT-NFR-TENANCY-05 | ✅ |
| COV-NFR-TENANCY-06 | ISO 25010 · tenancy | NFR-TENANCY-06: Cách ly tenant và scope ở export/BI job | design/nonfunctional_requirements.json | TC-SEC01, TC-BI02, TC-UAT-NFR-TENANCY-06 | ✅ |
| COV-NFR-TENANCY-07 | ISO 25010 · tenancy | NFR-TENANCY-07: Cách ly tenant trong đồng bộ mobile PowerSync (A1) | design/nonfunctional_requirements.json | TC-MOB02, TC-UAT-NFR-TENANCY-07 | ✅ |
| COV-NFR-TENANCY-08 | ISO 25010 · tenancy | NFR-TENANCY-08: Tenant context ký cho job nền, outbox và Temporal | design/nonfunctional_requirements.json | TC-UAT-NFR-TENANCY-08 | ✅ |
| COV-NFR-TENANCY-09 | ISO 25010 · tenancy | NFR-TENANCY-09: Scope trong tenant theo cây đơn vị và guest nhà thầu (R6) | design/nonfunctional_requirements.json | TC-UAT-NFR-TENANCY-09 | ✅ |

## Tổng

- Coverage item: 21, mỗi item có ít nhất một TC (21/21).
- TC: 28; chạy được trên máy này qua API/web thật: 20; cần hạ tầng/thiết bị: 8 (diễn tập khôi phục, rollback, ứng dụng di động).

## Completeness critic

1. Partition/boundary chưa có dòng: không áp dụng, đây là yêu cầu phi chức năng đo ở mức hệ thống, không phải một trường nhập.
2. Transition chưa phủ: các ca STATE (SECURITY-10, TX03, NOT01) phủ đường bất hợp lệ lùi trạng thái giao tin; đường lùi trạng thái khác của vốn chưa có ca then chốt.
3. Tổ hợp quyết định thiếu: ma trận vai × tenant của TENANCY-01/09 phủ A→B và đơn vị→đơn vị; chưa phủ vai quản trị hệ thống (cross-tenant có chủ đích).
4. Đặc tính 25010 áp dụng chưa có nhóm TC: hiệu năng, khả dụng truy cập không nằm trong lát then chốt.
5. Plan task / failure mode chưa map: không có plan đang thực thi gắn riêng cho lát này.
6. Nếu cố ý làm hỏng một dòng mã: bảng seeded-fault ở `_fault-seeding.md` (sinh sau khi chạy).
