# Sổ phủ — phân hệ NOT

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 42 ca thiết kế của phân hệ NOT (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-NOT-01 | AC/Requirement | FR-NOT-01: Hộp thông báo cá nhân | traceability.json / nonfunctional_requirements.json | TC-UI-NOT-01, TC-UAT-AC181 | ✅ |
| COV-FR-NOT-02 | AC/Requirement | FR-NOT-02: Chi tiết thông báo | traceability.json / nonfunctional_requirements.json | TC-UI-NOT-02, TC-UAT-AC181 | ✅ |
| COV-FR-NOT-03 | AC/Requirement | FR-NOT-03: Tùy chọn nhận tin | traceability.json / nonfunctional_requirements.json | TC-UAT-AC27, TC-UI-NOT-03, TC-UAT-AC183, TC-UAT-AC185, TC-UAT-AC186 | ✅ |
| COV-FR-NOT-04 | AC/Requirement | FR-NOT-04: Tổng quan vận hành thông báo | traceability.json / nonfunctional_requirements.json | TC-UI-NOT-04, TC-UAT-AC193 | ✅ |
| COV-FR-NOT-05 | AC/Requirement | FR-NOT-05: Danh mục sự kiện | traceability.json / nonfunctional_requirements.json | TC-UI-NOT-05, TC-UAT-AC194 | ✅ |
| COV-FR-NOT-06 | AC/Requirement | FR-NOT-06: Dựng luồng thông báo | traceability.json / nonfunctional_requirements.json | TC-UAT-AC26, TC-UAT-AC27, TC-UI-NOT-06, TC-UAT-AC176 | ✅ |
| COV-FR-NOT-07 | AC/Requirement | FR-NOT-07: Soạn mẫu đa kênh | traceability.json / nonfunctional_requirements.json | TC-UAT-AC28, TC-UI-NOT-07, TC-UAT-AC187, TC-UAT-AC188, TC-UAT-PLAN-49 | ✅ |
| COV-FR-NOT-08 | AC/Requirement | FR-NOT-08: Xem trước và gửi thử | traceability.json / nonfunctional_requirements.json | TC-UI-NOT-08, TC-UAT-AC189 | ✅ |
| COV-FR-NOT-09 | AC/Requirement | FR-NOT-09: Nhóm người nhận | traceability.json / nonfunctional_requirements.json | TC-UAT-AC30, TC-UI-NOT-09, TC-UAT-AC190 | ✅ |
| COV-FR-NOT-10 | AC/Requirement | FR-NOT-10: Lịch gửi và chiến dịch | traceability.json / nonfunctional_requirements.json | TC-UAT-AC30, TC-UI-NOT-10, TC-UAT-AC186, TC-UAT-AC190 | ✅ |
| COV-FR-NOT-11 | AC/Requirement | FR-NOT-11: Hàng đợi gửi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC29, TC-UI-NOT-11, TC-UAT-AC177, TC-UAT-AC178 | ✅ |
| COV-FR-NOT-12 | AC/Requirement | FR-NOT-12: Chi tiết hành trình gửi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC26, TC-UI-NOT-12, TC-UAT-AC176, TC-UAT-AC182 | ✅ |
| COV-FR-NOT-13 | AC/Requirement | FR-NOT-13: Hàng đợi lỗi và phát lại | traceability.json / nonfunctional_requirements.json | TC-UI-NOT-13, TC-UAT-AC177, TC-UAT-AC180 | ✅ |
| COV-FR-NOT-14 | AC/Requirement | FR-NOT-14: Thiết bị push | traceability.json / nonfunctional_requirements.json | TC-UAT-AC28, TC-UI-NOT-14, TC-UAT-AC179, TC-UAT-AC192 | ✅ |
| COV-FR-NOT-15 | AC/Requirement | FR-NOT-15: Hạn mức và chi phí kênh | traceability.json / nonfunctional_requirements.json | TC-UI-NOT-15, TC-UAT-AC191 | ✅ |
| COV-FR-NOT-16 | AC/Requirement | FR-NOT-16: Phê duyệt gửi diện rộng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC30, TC-UI-NOT-16, TC-UAT-AC190 | ✅ |
| COV-FR-NOT-17 | AC/Requirement | FR-NOT-17: Lịch sử đồng ý nhận tin | traceability.json / nonfunctional_requirements.json | TC-UAT-AC183, TC-UAT-AC184, TC-UI-NOT-17 | ✅ |

## Tổng

- Coverage item: 17, mỗi item có ít nhất một TC (17/17).
- TC: 42 (hợp đồng màn hình 17, nghiệp vụ và phi chức năng 25).
