# Sổ phủ — phân hệ IAM

M2=0 · FP=0 · risk=CRITICAL

> **Phạm vi:** 20 ca thiết kế của phân hệ IAM (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro CRITICAL do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-ADM-18 | AC/Requirement | FR-ADM-18: Theo dõi quy trình phê duyệt | traceability.json / nonfunctional_requirements.json | TC-UAT-AC121 | ✅ |
| COV-FR-IAM-01 | AC/Requirement | FR-IAM-01: Đăng nhập | traceability.json / nonfunctional_requirements.json | TC-UI-IAM-01, TC-UAT-AC124 | ✅ |
| COV-FR-IAM-02 | AC/Requirement | FR-IAM-02: Xác thực hai bước | traceability.json / nonfunctional_requirements.json | TC-UI-IAM-02, TC-UAT-AC121, TC-UAT-PLAN-44 | ✅ |
| COV-FR-IAM-03 | AC/Requirement | FR-IAM-03: Khôi phục truy cập | traceability.json / nonfunctional_requirements.json | TC-UI-IAM-03, TC-UAT-AC123 | ✅ |
| COV-FR-IAM-04 | AC/Requirement | FR-IAM-04: Chọn tổ chức | traceability.json / nonfunctional_requirements.json | TC-UI-IAM-04, TC-UAT-AC100, TC-UAT-AC101, TC-UAT-AC102 | ✅ |
| COV-FR-IAM-05 | AC/Requirement | FR-IAM-05: Hồ sơ cá nhân | traceability.json / nonfunctional_requirements.json | TC-UI-IAM-05, TC-UAT-AC122 | ✅ |
| COV-FR-IAM-06 | AC/Requirement | FR-IAM-06: Phiên và thiết bị | traceability.json / nonfunctional_requirements.json | TC-UI-IAM-06, TC-UAT-AC102, TC-UAT-AC120 | ✅ |
| COV-FR-IAM-07 | AC/Requirement | FR-IAM-07: Tìm kiếm toàn hệ thống | traceability.json / nonfunctional_requirements.json | TC-UI-IAM-07, TC-UAT-AC100 | ✅ |
| COV-FR-IAM-08 | AC/Requirement | FR-IAM-08: Trợ giúp và yêu cầu hỗ trợ | traceability.json / nonfunctional_requirements.json | TC-UI-IAM-08, TC-UAT-AC125 | ✅ |
| COV-FR-IAM-09 | AC/Requirement | FR-IAM-09: Phạm vi quyền hiệu lực của tôi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC119, TC-UI-IAM-09 | ✅ |
| COV-FR-SAS-19 | AC/Requirement | FR-SAS-19: Hỗ trợ truy cập có kiểm soát | traceability.json / nonfunctional_requirements.json | TC-UAT-AC125 | ✅ |

## Tổng

- Coverage item: 11, mỗi item có ít nhất một TC (11/11).
- TC: 20 (hợp đồng màn hình 9, nghiệp vụ và phi chức năng 11).
