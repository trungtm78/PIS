# Sổ phủ — phân hệ OMNI

M2=0 · FP=0 · risk=STANDARD

> **Phạm vi:** 23 ca thiết kế của phân hệ OMNI (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro STANDARD do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-OMNI-01 | AC/Requirement | FR-OMNI-01: Hộp thư hợp nhất | traceability.json / nonfunctional_requirements.json | TC-UI-OMNI-01, TC-UAT-AC199, TC-UAT-PLAN-51 | ✅ |
| COV-FR-OMNI-02 | AC/Requirement | FR-OMNI-02: Chi tiết hội thoại | traceability.json / nonfunctional_requirements.json | TC-UAT-AC22, TC-UAT-AC23, TC-UAT-AC24, TC-UAT-AC25, TC-UI-OMNI-02, TC-UAT-AC195 | ✅ |
| COV-FR-OMNI-03 | AC/Requirement | FR-OMNI-03: Danh bạ và liên kết danh tính | traceability.json / nonfunctional_requirements.json | TC-UI-OMNI-03, TC-UAT-AC197 | ✅ |
| COV-FR-OMNI-04 | AC/Requirement | FR-OMNI-04: Xác minh và đồng ý nhận tin | traceability.json / nonfunctional_requirements.json | TC-UAT-AC22, TC-UI-OMNI-04, TC-UAT-AC195 | ✅ |
| COV-FR-OMNI-05 | AC/Requirement | FR-OMNI-05: Kết nối kênh | traceability.json / nonfunctional_requirements.json | TC-UAT-AC24, TC-UI-OMNI-05, TC-UAT-AC196 | ✅ |
| COV-FR-OMNI-06 | AC/Requirement | FR-OMNI-06: Cấu hình kênh | traceability.json / nonfunctional_requirements.json | TC-UI-OMNI-06, TC-UAT-PLAN-50 | ✅ |
| COV-FR-OMNI-07 | AC/Requirement | FR-OMNI-07: Phân công và SLA | traceability.json / nonfunctional_requirements.json | TC-UI-OMNI-07, TC-UAT-AC199 | ✅ |
| COV-FR-OMNI-08 | AC/Requirement | FR-OMNI-08: Mẫu trả lời | traceability.json / nonfunctional_requirements.json | TC-UI-OMNI-08, TC-UAT-PLAN-52 | ✅ |
| COV-FR-OMNI-09 | AC/Requirement | FR-OMNI-09: Chuyển hội thoại thành việc | traceability.json / nonfunctional_requirements.json | TC-UI-OMNI-09, TC-UAT-AC198 | ✅ |
| COV-FR-OMNI-10 | AC/Requirement | FR-OMNI-10: Thống kê tương tác | traceability.json / nonfunctional_requirements.json | TC-UI-OMNI-10, TC-UAT-AC199 | ✅ |
| COV-FR-OMNI-11 | AC/Requirement | FR-OMNI-11: Hộp sự kiện webhook và đối soát | traceability.json / nonfunctional_requirements.json | TC-UAT-AC196, TC-UI-OMNI-11 | ✅ |

## Tổng

- Coverage item: 11, mỗi item có ít nhất một TC (11/11).
- TC: 23 (hợp đồng màn hình 11, nghiệp vụ và phi chức năng 12).
