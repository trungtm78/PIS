# Sổ phủ — phân hệ AST

M2=0 · FP=0 · risk=STANDARD

> **Phạm vi:** 15 ca thiết kế của phân hệ AST (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro STANDARD do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-AST-01 | AC/Requirement | FR-AST-01: Danh sách bàn giao | traceability.json / nonfunctional_requirements.json | TC-UAT-AC395, TC-UI-AST-01 | ✅ |
| COV-FR-AST-02 | AC/Requirement | FR-AST-02: Biên bản bàn giao và tồn tại | traceability.json / nonfunctional_requirements.json | TC-UAT-AC388, TC-UI-AST-02 | ✅ |
| COV-FR-AST-03 | AC/Requirement | FR-AST-03: Hồ sơ tài sản | traceability.json / nonfunctional_requirements.json | TC-UAT-AC389, TC-UAT-AC395, TC-UI-AST-03 | ✅ |
| COV-FR-AST-04 | AC/Requirement | FR-AST-04: Bảo hành và giữ lại | traceability.json / nonfunctional_requirements.json | TC-UAT-AC390, TC-UAT-AC392, TC-UI-AST-04 | ✅ |
| COV-FR-AST-05 | AC/Requirement | FR-AST-05: Yêu cầu bảo hành | traceability.json / nonfunctional_requirements.json | TC-UAT-AC390, TC-UAT-AC391, TC-UI-AST-05 | ✅ |
| COV-FR-AST-06 | AC/Requirement | FR-AST-06: Liên kết vận hành bảo trì | traceability.json / nonfunctional_requirements.json | TC-UAT-AC393, TC-UI-AST-06 | ✅ |
| COV-FR-AST-07 | AC/Requirement | FR-AST-07: Kích hoạt đánh giá sau đầu tư | traceability.json / nonfunctional_requirements.json | TC-UAT-AC394, TC-UI-AST-07 | ✅ |
| COV-FR-CTR-21 | AC/Requirement | FR-CTR-21: Giữ lại theo dòng BOQ và giải tỏa | traceability.json / nonfunctional_requirements.json | TC-UAT-AC392 | ✅ |

## Tổng

- Coverage item: 8, mỗi item có ít nhất một TC (8/8).
- TC: 15 (hợp đồng màn hình 7, nghiệp vụ và phi chức năng 8).
