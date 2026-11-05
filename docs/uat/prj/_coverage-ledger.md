# Sổ phủ — phân hệ PRJ

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 43 ca thiết kế của phân hệ PRJ (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-CAP-10 | AC/Requirement | FR-CAP-10: Phê duyệt kế hoạch | traceability.json / nonfunctional_requirements.json | TC-UAT-AC219 | ✅ |
| COV-FR-PRJ-01 | AC/Requirement | FR-PRJ-01: Danh sách dự án | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-01, TC-UAT-AC217 | ✅ |
| COV-FR-PRJ-02 | AC/Requirement | FR-PRJ-02: Tạo dự án | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-02, TC-UAT-AC200, TC-UAT-AC201, TC-UAT-AC208 | ✅ |
| COV-FR-PRJ-03 | AC/Requirement | FR-PRJ-03: Không gian dự án | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-03, TC-UAT-AC201 | ✅ |
| COV-FR-PRJ-04 | AC/Requirement | FR-PRJ-04: Hồ sơ pháp lý | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-04 | ✅ |
| COV-FR-PRJ-05 | AC/Requirement | FR-PRJ-05: Cấu phần và WBS | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-05, TC-UAT-AC218 | ✅ |
| COV-FR-PRJ-06 | AC/Requirement | FR-PRJ-06: Điều chỉnh dự án | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-06, TC-UAT-AC214, TC-UAT-PLAN-57 | ✅ |
| COV-FR-PRJ-07 | AC/Requirement | FR-PRJ-07: Tiến độ và mốc | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-07, TC-UAT-AC218, TC-UAT-PLAN-58 | ✅ |
| COV-FR-PRJ-08 | AC/Requirement | FR-PRJ-08: Nhóm thực hiện | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-08 | ✅ |
| COV-FR-PRJ-09 | AC/Requirement | FR-PRJ-09: Đề xuất chủ trương | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-09, TC-UAT-AC202 | ✅ |
| COV-FR-PRJ-10 | AC/Requirement | FR-PRJ-10: Thẩm định và quyết định | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-10, TC-UAT-AC202, TC-UAT-AC208 | ✅ |
| COV-FR-PRJ-11 | AC/Requirement | FR-PRJ-11: Bàn giao tài sản | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-11 | ✅ |
| COV-FR-PRJ-12 | AC/Requirement | FR-PRJ-12: Quyết toán dự án | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-12, TC-UAT-AC216 | ✅ |
| COV-FR-PRJ-13 | AC/Requirement | FR-PRJ-13: Theo dõi dự án tháng | traceability.json / nonfunctional_requirements.json | TC-UI-PRJ-13 | ✅ |
| COV-FR-PRJ-14 | AC/Requirement | FR-PRJ-14: Ngân hàng dự án và vòng đời PIMA | traceability.json / nonfunctional_requirements.json | TC-UAT-AC202, TC-UAT-AC205, TC-UAT-AC206, TC-UAT-AC215, TC-UAT-AC216, TC-UAT-AC219, TC-UI-PRJ-14 | ✅ |
| COV-FR-PRJ-15 | AC/Requirement | FR-PRJ-15: Chấm điểm thẩm định | traceability.json / nonfunctional_requirements.json | TC-UAT-AC203, TC-UAT-AC204, TC-UI-PRJ-15 | ✅ |
| COV-FR-PRJ-16 | AC/Requirement | FR-PRJ-16: Sổ đăng ký rủi ro dự án | traceability.json / nonfunctional_requirements.json | TC-UAT-AC209, TC-UI-PRJ-16 | ✅ |
| COV-FR-PRJ-17 | AC/Requirement | FR-PRJ-17: Phân công lãnh đạo phụ trách | traceability.json / nonfunctional_requirements.json | TC-UAT-AC210, TC-UI-PRJ-17 | ✅ |
| COV-FR-PRJ-18 | AC/Requirement | FR-PRJ-18: Tổ công tác đôn đốc giải ngân | traceability.json / nonfunctional_requirements.json | TC-UAT-AC211, TC-UI-PRJ-18 | ✅ |
| COV-FR-PRJ-19 | AC/Requirement | FR-PRJ-19: Yêu cầu và phản hồi giải trình | traceability.json / nonfunctional_requirements.json | TC-UAT-AC212, TC-UI-PRJ-19 | ✅ |
| COV-FR-PRJ-20 | AC/Requirement | FR-PRJ-20: Chuyển dự án giữa đơn vị | traceability.json / nonfunctional_requirements.json | TC-UAT-AC213, TC-UI-PRJ-20 | ✅ |
| COV-FR-PRJ-21 | AC/Requirement | FR-PRJ-21: Mã dự án trên Hệ thống TTQG về ĐTC | traceability.json / nonfunctional_requirements.json | TC-UAT-AC206, TC-UAT-AC207, TC-UI-PRJ-21 | ✅ |

## Tổng

- Coverage item: 22, mỗi item có ít nhất một TC (22/22).
- TC: 43 (hợp đồng màn hình 21, nghiệp vụ và phi chức năng 22).
