# Sổ phủ — phân hệ MNE

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 27 ca thiết kế của phân hệ MNE (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-MNE-01 | AC/Requirement | FR-MNE-01: Lịch nghĩa vụ báo cáo giám sát | traceability.json / nonfunctional_requirements.json | TC-UAT-AC285, TC-UAT-AC299, TC-UI-MNE-01 | ✅ |
| COV-FR-MNE-02 | AC/Requirement | FR-MNE-02: Danh mục mẫu biểu giám sát | traceability.json / nonfunctional_requirements.json | TC-UAT-AC286, TC-UAT-AC296, TC-UI-MNE-02, TC-UAT-PLAN-73 | ✅ |
| COV-FR-MNE-03 | AC/Requirement | FR-MNE-03: Lập báo cáo giám sát tổng thể định kỳ | traceability.json / nonfunctional_requirements.json | TC-UAT-AC287, TC-UAT-AC295, TC-UI-MNE-03 | ✅ |
| COV-FR-MNE-04 | AC/Requirement | FR-MNE-04: Báo cáo giám sát theo dự án | traceability.json / nonfunctional_requirements.json | TC-UAT-AC288, TC-UI-MNE-04 | ✅ |
| COV-FR-MNE-05 | AC/Requirement | FR-MNE-05: Rà soát, phê duyệt và phát hành | traceability.json / nonfunctional_requirements.json | TC-UAT-AC289, TC-UAT-AC298, TC-UI-MNE-05 | ✅ |
| COV-FR-MNE-06 | AC/Requirement | FR-MNE-06: Xuất tệp và xác nhận nộp Hệ thống TTQG | traceability.json / nonfunctional_requirements.json | TC-UAT-AC290, TC-UAT-AC297, TC-UI-MNE-06 | ✅ |
| COV-FR-MNE-07 | AC/Requirement | FR-MNE-07: Báo cáo nhanh tuần | traceability.json / nonfunctional_requirements.json | TC-UAT-AC291, TC-UI-MNE-07 | ✅ |
| COV-FR-MNE-08 | AC/Requirement | FR-MNE-08: Đánh giá đầu tư | traceability.json / nonfunctional_requirements.json | TC-UAT-AC292, TC-UI-MNE-08, TC-UAT-PLAN-74 | ✅ |
| COV-FR-MNE-09 | AC/Requirement | FR-MNE-09: Tiến độ nộp báo cáo giám sát | traceability.json / nonfunctional_requirements.json | TC-UAT-AC293, TC-UAT-AC299, TC-UI-MNE-09 | ✅ |
| COV-FR-MNE-10 | AC/Requirement | FR-MNE-10: Lịch sử phiên bản và đính chính báo cáo | traceability.json / nonfunctional_requirements.json | TC-UAT-AC294, TC-UI-MNE-10 | ✅ |

## Tổng

- Coverage item: 10, mỗi item có ít nhất một TC (10/10).
- TC: 27 (hợp đồng màn hình 10, nghiệp vụ và phi chức năng 17).
