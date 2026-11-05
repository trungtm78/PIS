# Sổ phủ — phân hệ ADM

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 55 ca thiết kế của phân hệ ADM (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-ADM-01 | AC/Requirement | FR-ADM-01: Cây tổ chức | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-01, TC-UAT-AC107, TC-UAT-AC110, TC-UAT-AC111 | ✅ |
| COV-FR-ADM-02 | AC/Requirement | FR-ADM-02: Người dùng và mời thành viên | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-02, TC-UAT-AC113, TC-UAT-AC114, TC-UAT-AC115, TC-UAT-AC118 | ✅ |
| COV-FR-ADM-03 | AC/Requirement | FR-ADM-03: Vai trò và quyền | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-03, TC-UAT-AC103, TC-UAT-AC104, TC-UAT-AC105, TC-UAT-AC106 | ✅ |
| COV-FR-ADM-04 | AC/Requirement | FR-ADM-04: Ủy quyền có thời hạn | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-04, TC-UAT-AC116, TC-UAT-AC117 | ✅ |
| COV-FR-ADM-05 | AC/Requirement | FR-ADM-05: Danh mục dùng chung | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-05 | ✅ |
| COV-FR-ADM-06 | AC/Requirement | FR-ADM-06: Dựng quy trình phê duyệt | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-06, TC-UAT-AC126, TC-UAT-AC129, TC-UAT-AC132, TC-UAT-AC133, TC-UAT-AC134, TC-UAT-PLAN-45 | ✅ |
| COV-FR-ADM-07 | AC/Requirement | FR-ADM-07: Lịch công tác và ngày nghỉ | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-07, TC-UAT-AC134, TC-UAT-AC135 | ✅ |
| COV-FR-ADM-08 | AC/Requirement | FR-ADM-08: Chữ ký số | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-08, TC-UAT-AC136 | ✅ |
| COV-FR-ADM-09 | AC/Requirement | FR-ADM-09: Tích hợp và ánh xạ | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-09, TC-UAT-AC137 | ✅ |
| COV-FR-ADM-10 | AC/Requirement | FR-ADM-10: Giám sát đồng bộ | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-10, TC-UAT-AC138, TC-UAT-PLAN-12 | ✅ |
| COV-FR-ADM-11 | AC/Requirement | FR-ADM-11: Nhật ký kiểm toán | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-11, TC-UAT-AC131, TC-UAT-AC139, TC-UAT-AC140 | ✅ |
| COV-FR-ADM-12 | AC/Requirement | FR-ADM-12: Chính sách lưu trữ | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-12, TC-UAT-AC141, TC-UAT-AC142 | ✅ |
| COV-FR-ADM-13 | AC/Requirement | FR-ADM-13: Nhập chuyển đổi dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-13, TC-UAT-AC143 | ✅ |
| COV-FR-ADM-14 | AC/Requirement | FR-ADM-14: Cấu hình an toàn | traceability.json / nonfunctional_requirements.json | TC-UI-ADM-14, TC-UAT-AC144 | ✅ |
| COV-FR-ADM-15 | AC/Requirement | FR-ADM-15: Ma trận thẩm quyền phê duyệt | traceability.json / nonfunctional_requirements.json | TC-UAT-AC126, TC-UAT-AC127, TC-UAT-AC128, TC-UI-ADM-15 | ✅ |
| COV-FR-ADM-16 | AC/Requirement | FR-ADM-16: Sắp xếp lại đơn vị | traceability.json / nonfunctional_requirements.json | TC-UAT-AC111, TC-UAT-AC112, TC-UI-ADM-16 | ✅ |
| COV-FR-ADM-17 | AC/Requirement | FR-ADM-17: Thành viên khách – nhà thầu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC108, TC-UAT-AC109, TC-UI-ADM-17 | ✅ |
| COV-FR-ADM-18 | AC/Requirement | FR-ADM-18: Theo dõi quy trình phê duyệt | traceability.json / nonfunctional_requirements.json | TC-UAT-AC117, TC-UAT-AC129, TC-UAT-AC130, TC-UAT-AC131, TC-UAT-AC133, TC-UI-ADM-18 | ✅ |
| COV-FR-IAM-09 | AC/Requirement | FR-IAM-09: Phạm vi quyền hiệu lực của tôi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC107 | ✅ |
| COV-FR-OMNI-11 | AC/Requirement | FR-OMNI-11: Hộp sự kiện webhook và đối soát | traceability.json / nonfunctional_requirements.json | TC-UAT-AC138 | ✅ |
| COV-FR-SAS-11 | AC/Requirement | FR-SAS-11: Đo mức sử dụng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC114 | ✅ |

## Tổng

- Coverage item: 21, mỗi item có ít nhất một TC (21/21).
- TC: 55 (hợp đồng màn hình 18, nghiệp vụ và phi chức năng 37).
