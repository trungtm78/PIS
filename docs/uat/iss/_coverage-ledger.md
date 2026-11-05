# Sổ phủ — phân hệ ISS

M2=0 · FP=0 · risk=STANDARD

> **Phạm vi:** 22 ca thiết kế của phân hệ ISS (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro STANDARD do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-ISS-01 | AC/Requirement | FR-ISS-01: Danh sách vướng mắc | traceability.json / nonfunctional_requirements.json | TC-UI-ISS-01, TC-UAT-AC350, TC-UAT-PLAN-23 | ✅ |
| COV-FR-ISS-02 | AC/Requirement | FR-ISS-02: Ghi nhận vướng mắc | traceability.json / nonfunctional_requirements.json | TC-UI-ISS-02, TC-UAT-AC354, TC-UAT-AC355 | ✅ |
| COV-FR-ISS-03 | AC/Requirement | FR-ISS-03: Không gian xử lý | traceability.json / nonfunctional_requirements.json | TC-UI-ISS-03, TC-UAT-AC351 | ✅ |
| COV-FR-ISS-04 | AC/Requirement | FR-ISS-04: Chuyển cấp và gia hạn | traceability.json / nonfunctional_requirements.json | TC-UI-ISS-04, TC-UAT-AC350, TC-UAT-AC352, TC-UAT-AC353 | ✅ |
| COV-FR-ISS-05 | AC/Requirement | FR-ISS-05: Kiểm tra hiện trường | traceability.json / nonfunctional_requirements.json | TC-UI-ISS-05, TC-UAT-AC355, TC-UAT-PLAN-26 | ✅ |
| COV-FR-ISS-06 | AC/Requirement | FR-ISS-06: Tiến độ xử lý theo tuần | traceability.json / nonfunctional_requirements.json | TC-UI-ISS-06 | ✅ |
| COV-FR-ISS-07 | AC/Requirement | FR-ISS-07: Xác nhận hoàn tất | traceability.json / nonfunctional_requirements.json | TC-UI-ISS-07, TC-UAT-AC351 | ✅ |
| COV-FR-ISS-08 | AC/Requirement | FR-ISS-08: Ma trận vướng mắc theo tuần | traceability.json / nonfunctional_requirements.json | TC-UI-ISS-08, TC-UAT-PLAN-25 | ✅ |
| COV-FR-ISS-09 | AC/Requirement | FR-ISS-09: Chính sách SLA theo loại và đơn vị | traceability.json / nonfunctional_requirements.json | TC-UAT-AC350, TC-UI-ISS-09, TC-UAT-PLAN-22 | ✅ |
| COV-FR-ISS-10 | AC/Requirement | FR-ISS-10: Leo thang và tổ công tác | traceability.json / nonfunctional_requirements.json | TC-UAT-AC352, TC-UI-ISS-10, TC-UAT-PLAN-24 | ✅ |
| COV-FR-ISS-11 | AC/Requirement | FR-ISS-11: Vướng mắc phát sinh từ GPMB, giấy phép, chất lượng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC354, TC-UI-ISS-11 | ✅ |

## Tổng

- Coverage item: 11, mỗi item có ít nhất một TC (11/11).
- TC: 22 (hợp đồng màn hình 11, nghiệp vụ và phi chức năng 11).
