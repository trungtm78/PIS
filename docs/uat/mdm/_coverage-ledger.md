# Sổ phủ — phân hệ MDM

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 58 ca thiết kế của phân hệ MDM (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-DIS-14 | AC/Requirement | FR-DIS-14: Lịch kỳ và khóa sổ | traceability.json / nonfunctional_requirements.json | TC-UAT-AC283 | ✅ |
| COV-FR-MDM-01 | AC/Requirement | FR-MDM-01: Trung tâm danh mục | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-01 | ✅ |
| COV-FR-MDM-02 | AC/Requirement | FR-MDM-02: Địa bàn và lịch sử sáp nhập | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-02, TC-UAT-AC277 | ✅ |
| COV-FR-MDM-03 | AC/Requirement | FR-MDM-03: Cơ quan và chủ đầu tư | traceability.json / nonfunctional_requirements.json | TC-UAT-AC47, TC-UI-MDM-03 | ✅ |
| COV-FR-MDM-04 | AC/Requirement | FR-MDM-04: Nguồn vốn và cây phân loại | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-04, TC-UAT-AC282 | ✅ |
| COV-FR-MDM-05 | AC/Requirement | FR-MDM-05: Chương trình và CTMTQG | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-05, TC-UAT-AC282 | ✅ |
| COV-FR-MDM-06 | AC/Requirement | FR-MDM-06: Lĩnh vực đầu tư | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-06 | ✅ |
| COV-FR-MDM-07 | AC/Requirement | FR-MDM-07: Nhóm và loại dự án | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-07, TC-UAT-AC284 | ✅ |
| COV-FR-MDM-08 | AC/Requirement | FR-MDM-08: Giai đoạn và trạng thái dự án | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-08 | ✅ |
| COV-FR-MDM-09 | AC/Requirement | FR-MDM-09: Cấp quyết định và thẩm quyền | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-09 | ✅ |
| COV-FR-MDM-10 | AC/Requirement | FR-MDM-10: Loại quyết định và văn bản | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-10 | ✅ |
| COV-FR-MDM-11 | AC/Requirement | FR-MDM-11: Năm ngân sách và lịch kỳ | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-11, TC-UAT-AC283 | ✅ |
| COV-FR-MDM-12 | AC/Requirement | FR-MDM-12: Đơn vị tính và tiền tệ | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-12 | ✅ |
| COV-FR-MDM-13 | AC/Requirement | FR-MDM-13: Loại hồ sơ và chứng từ | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-13 | ✅ |
| COV-FR-MDM-14 | AC/Requirement | FR-MDM-14: Loại hợp đồng và phụ lục | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-14 | ✅ |
| COV-FR-MDM-15 | AC/Requirement | FR-MDM-15: Loại thanh toán và tạm ứng | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-15 | ✅ |
| COV-FR-MDM-16 | AC/Requirement | FR-MDM-16: Cơ quan Kho bạc và mã liên kết | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-16 | ✅ |
| COV-FR-MDM-17 | AC/Requirement | FR-MDM-17: Nhóm vướng mắc và nguyên nhân | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-17 | ✅ |
| COV-FR-MDM-18 | AC/Requirement | FR-MDM-18: Mức độ ưu tiên và SLA | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-18 | ✅ |
| COV-FR-MDM-19 | AC/Requirement | FR-MDM-19: Tiêu chí đánh giá nhà thầu | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-19 | ✅ |
| COV-FR-MDM-20 | AC/Requirement | FR-MDM-20: Vai trò chuyên gia và năng lực | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-20 | ✅ |
| COV-FR-MDM-21 | AC/Requirement | FR-MDM-21: Loại sự kiện và mục đích liên hệ | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-21 | ✅ |
| COV-FR-MDM-22 | AC/Requirement | FR-MDM-22: Ngôn ngữ và nội dung dùng chung | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-22 | ✅ |
| COV-FR-MDM-23 | AC/Requirement | FR-MDM-23: Phân loại bảo mật và lưu trữ | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-23 | ✅ |
| COV-FR-MDM-24 | AC/Requirement | FR-MDM-24: Ánh xạ mã liên hệ thống | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-24, TC-UAT-AC273, TC-UAT-AC281 | ✅ |
| COV-FR-MDM-25 | AC/Requirement | FR-MDM-25: Thêm bản ghi danh mục | traceability.json / nonfunctional_requirements.json | TC-UAT-AC45, TC-UI-MDM-25 | ✅ |
| COV-FR-MDM-26 | AC/Requirement | FR-MDM-26: Sửa bản ghi và hiệu lực | traceability.json / nonfunctional_requirements.json | TC-UAT-AC46, TC-UI-MDM-26 | ✅ |
| COV-FR-MDM-27 | AC/Requirement | FR-MDM-27: Chi tiết và nơi đang sử dụng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC49, TC-UI-MDM-27 | ✅ |
| COV-FR-MDM-28 | AC/Requirement | FR-MDM-28: Lịch sử thay đổi danh mục | traceability.json / nonfunctional_requirements.json | TC-UAT-AC49, TC-UI-MDM-28 | ✅ |
| COV-FR-MDM-29 | AC/Requirement | FR-MDM-29: Nhập danh mục hàng loạt | traceability.json / nonfunctional_requirements.json | TC-UAT-AC48, TC-UI-MDM-29 | ✅ |
| COV-FR-MDM-30 | AC/Requirement | FR-MDM-30: Hợp nhất mã trùng | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-30, TC-UAT-AC274 | ✅ |
| COV-FR-MDM-31 | AC/Requirement | FR-MDM-31: Ngừng dùng danh mục | traceability.json / nonfunctional_requirements.json | TC-UAT-AC47, TC-UI-MDM-31, TC-UAT-AC280 | ✅ |
| COV-FR-MDM-32 | AC/Requirement | FR-MDM-32: Duyệt và công bố danh mục | traceability.json / nonfunctional_requirements.json | TC-UAT-AC49, TC-UI-MDM-32, TC-UAT-PLAN-53 | ✅ |
| COV-FR-MDM-33 | AC/Requirement | FR-MDM-33: Phạm vi danh mục toàn hệ thống và tenant | traceability.json / nonfunctional_requirements.json | TC-UI-MDM-33, TC-UAT-AC279 | ✅ |
| COV-FR-MDM-34 | AC/Requirement | FR-MDM-34: Thuật ngữ nghiệp vụ và phê duyệt | traceability.json / nonfunctional_requirements.json | TC-UAT-AC276, TC-UI-MDM-34, TC-UAT-PLAN-54 | ✅ |
| COV-FR-MDM-35 | AC/Requirement | FR-MDM-35: Bản ghi chủ, crosswalk và tách/hợp nhất | traceability.json / nonfunctional_requirements.json | TC-UAT-AC273, TC-UAT-AC274, TC-UAT-AC275, TC-UI-MDM-35, TC-UAT-PLAN-56 | ✅ |
| COV-FR-MDM-36 | AC/Requirement | FR-MDM-36: Quy tắc survivorship theo thuộc tính | traceability.json / nonfunctional_requirements.json | TC-UAT-AC274, TC-UI-MDM-36 | ✅ |
| COV-FR-MDM-37 | AC/Requirement | FR-MDM-37: Kế thừa đơn vị hành chính và cơ quan 2025 | traceability.json / nonfunctional_requirements.json | TC-UAT-AC277, TC-UAT-AC278, TC-UI-MDM-37, TC-UAT-PLAN-55 | ✅ |
| COV-FR-PRJ-02 | AC/Requirement | FR-PRJ-02: Tạo dự án | traceability.json / nonfunctional_requirements.json | TC-UAT-AC284 | ✅ |

## Tổng

- Coverage item: 39, mỗi item có ít nhất một TC (39/39).
- TC: 58 (hợp đồng màn hình 37, nghiệp vụ và phi chức năng 21).
