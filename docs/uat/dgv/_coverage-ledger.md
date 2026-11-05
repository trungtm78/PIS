# Sổ phủ — phân hệ DGV

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 41 ca thiết kế của phân hệ DGV (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-BI-14 | AC/Requirement | FR-BI-14: Lineage và chất lượng dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC51, TC-UAT-AC52 | ✅ |
| COV-FR-DGV-01 | AC/Requirement | FR-DGV-01: Điều hành chất lượng dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-01, TC-UAT-AC485, TC-UAT-AC486 | ✅ |
| COV-FR-DGV-02 | AC/Requirement | FR-DGV-02: Business glossary | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-02, TC-UAT-AC490 | ✅ |
| COV-FR-DGV-03 | AC/Requirement | FR-DGV-03: Chủ sở hữu và steward | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-03, TC-UAT-AC483 | ✅ |
| COV-FR-DGV-04 | AC/Requirement | FR-DGV-04: Data catalogue | traceability.json / nonfunctional_requirements.json | TC-UAT-AC55, TC-UI-DGV-04, TC-UAT-AC483, TC-UAT-AC496 | ✅ |
| COV-FR-DGV-05 | AC/Requirement | FR-DGV-05: Lineage toàn hệ thống | traceability.json / nonfunctional_requirements.json | TC-UAT-AC52, TC-UAT-AC55, TC-UI-DGV-05, TC-UAT-AC489, TC-UAT-AC496 | ✅ |
| COV-FR-DGV-06 | AC/Requirement | FR-DGV-06: Quy tắc chất lượng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC54, TC-UI-DGV-06, TC-UAT-AC484 | ✅ |
| COV-FR-DGV-07 | AC/Requirement | FR-DGV-07: Profiling và điểm chất lượng | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-07, TC-UAT-AC485, TC-UAT-AC489 | ✅ |
| COV-FR-DGV-08 | AC/Requirement | FR-DGV-08: Sự cố dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC54, TC-UI-DGV-08, TC-UAT-AC487 | ✅ |
| COV-FR-DGV-09 | AC/Requirement | FR-DGV-09: Đối soát và số kiểm soát | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-09, TC-UAT-AC488 | ✅ |
| COV-FR-DGV-10 | AC/Requirement | FR-DGV-10: Quản trị dữ liệu trùng | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-10 | ✅ |
| COV-FR-DGV-11 | AC/Requirement | FR-DGV-11: Lưu trữ và legal hold | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-11 | ✅ |
| COV-FR-DGV-12 | AC/Requirement | FR-DGV-12: Duyệt sửa dữ liệu trọng yếu | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-12 | ✅ |
| COV-FR-DGV-13 | AC/Requirement | FR-DGV-13: Data contract và schema | traceability.json / nonfunctional_requirements.json | TC-UAT-AC50, TC-UI-DGV-13 | ✅ |
| COV-FR-DGV-14 | AC/Requirement | FR-DGV-14: Pipeline và mapping | traceability.json / nonfunctional_requirements.json | TC-UAT-AC51, TC-UI-DGV-14, TC-UAT-AC491 | ✅ |
| COV-FR-DGV-15 | AC/Requirement | FR-DGV-15: Phân loại và quyền dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC55, TC-UI-DGV-15 | ✅ |
| COV-FR-DGV-16 | AC/Requirement | FR-DGV-16: Đánh giá trưởng thành dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC53, TC-UI-DGV-16, TC-UAT-AC492 | ✅ |
| COV-FR-DGV-17 | AC/Requirement | FR-DGV-17: Lộ trình trưởng thành | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-17, TC-UAT-AC494 | ✅ |
| COV-FR-DGV-18 | AC/Requirement | FR-DGV-18: Data product và chứng nhận | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-18, TC-UAT-AC495 | ✅ |
| COV-FR-DGV-19 | AC/Requirement | FR-DGV-19: Chấp thuận thay đổi hợp đồng dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC50, TC-UI-DGV-19 | ✅ |
| COV-FR-DGV-20 | AC/Requirement | FR-DGV-20: Mapping trường nguồn (D04) | traceability.json / nonfunctional_requirements.json | TC-UI-DGV-20, TC-UAT-AC491 | ✅ |
| COV-FR-DGV-21 | AC/Requirement | FR-DGV-21: Rubric trưởng thành dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC53, TC-UI-DGV-21, TC-UAT-AC493 | ✅ |

## Tổng

- Coverage item: 22, mỗi item có ít nhất một TC (22/22).
- TC: 41 (hợp đồng màn hình 21, nghiệp vụ và phi chức năng 20).
