# Sổ phủ — phân hệ LND

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 29 ca thiết kế của phân hệ LND (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-ISS-11 | AC/Requirement | FR-ISS-11: Vướng mắc phát sinh từ GPMB, giấy phép, chất lượng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC384 | ✅ |
| COV-FR-LND-01 | AC/Requirement | FR-LND-01: Tổng quan GPMB theo dự án | traceability.json / nonfunctional_requirements.json | TC-UAT-AC386, TC-UAT-AC387, TC-UI-LND-01 | ✅ |
| COV-FR-LND-02 | AC/Requirement | FR-LND-02: Thửa đất và ranh giới | traceability.json / nonfunctional_requirements.json | TC-UAT-AC376, TC-UI-LND-02, TC-UAT-PLAN-28 | ✅ |
| COV-FR-LND-03 | AC/Requirement | FR-LND-03: Hộ bị ảnh hưởng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC379, TC-UAT-AC380, TC-UI-LND-03 | ✅ |
| COV-FR-LND-04 | AC/Requirement | FR-LND-04: Kiểm đếm | traceability.json / nonfunctional_requirements.json | TC-UAT-AC379, TC-UAT-AC382, TC-UI-LND-04, TC-UAT-PLAN-29 | ✅ |
| COV-FR-LND-05 | AC/Requirement | FR-LND-05: Phương án bồi thường, hỗ trợ, tái định cư | traceability.json / nonfunctional_requirements.json | TC-UAT-AC377, TC-UAT-AC382, TC-UI-LND-05, TC-UAT-PLAN-30 | ✅ |
| COV-FR-LND-06 | AC/Requirement | FR-LND-06: Niêm yết 30 ngày và ý kiến | traceability.json / nonfunctional_requirements.json | TC-UAT-AC376, TC-UAT-AC377, TC-UI-LND-06 | ✅ |
| COV-FR-LND-07 | AC/Requirement | FR-LND-07: Chi trả bồi thường | traceability.json / nonfunctional_requirements.json | TC-UAT-AC378, TC-UAT-AC383, TC-UI-LND-07 | ✅ |
| COV-FR-LND-08 | AC/Requirement | FR-LND-08: Khiếu nại | traceability.json / nonfunctional_requirements.json | TC-UAT-AC384, TC-UI-LND-08 | ✅ |
| COV-FR-LND-09 | AC/Requirement | FR-LND-09: Cưỡng chế | traceability.json / nonfunctional_requirements.json | TC-UAT-AC385, TC-UI-LND-09 | ✅ |
| COV-FR-LND-10 | AC/Requirement | FR-LND-10: Bàn giao mặt bằng theo đoạn/km | traceability.json / nonfunctional_requirements.json | TC-UAT-AC386, TC-UI-LND-10 | ✅ |
| COV-FR-LND-11 | AC/Requirement | FR-LND-11: Theo dõi tiến độ khi Trung tâm quỹ đất thực hiện | traceability.json / nonfunctional_requirements.json | TC-UAT-AC387, TC-UI-LND-11 | ✅ |
| COV-FR-LND-12 | AC/Requirement | FR-LND-12: Tái định cư | traceability.json / nonfunctional_requirements.json | TC-UI-LND-12, TC-UAT-PLAN-31 | ✅ |
| COV-FR-LND-13 | AC/Requirement | FR-LND-13: Yêu cầu của chủ thể dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC380, TC-UAT-AC381, TC-UI-LND-13 | ✅ |
| COV-FR-PAY-12 | AC/Requirement | FR-PAY-12: Cảnh báo tạm ứng quá hạn và thu hồi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC383 | ✅ |

## Tổng

- Coverage item: 15, mỗi item có ít nhất một TC (15/15).
- TC: 29 (hợp đồng màn hình 13, nghiệp vụ và phi chức năng 16).
