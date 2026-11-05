# Sổ phủ — phân hệ HOME

M2=0 · FP=0 · risk=LOW

> **Phạm vi:** 19 ca thiết kế của phân hệ HOME (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro LOW do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-DIS-21 | AC/Requirement | FR-DIS-21: Chốt và đóng băng số liệu kỳ | traceability.json / nonfunctional_requirements.json | TC-UAT-AC254 | ✅ |
| COV-FR-HOME-01 | AC/Requirement | FR-HOME-01: Tổng quan điều hành | traceability.json / nonfunctional_requirements.json | TC-UI-HOME-01, TC-UAT-AC266, TC-UAT-AC268, TC-UAT-AC270 | ✅ |
| COV-FR-HOME-02 | AC/Requirement | FR-HOME-02: Việc của tôi | traceability.json / nonfunctional_requirements.json | TC-UI-HOME-02, TC-UAT-AC272 | ✅ |
| COV-FR-HOME-03 | AC/Requirement | FR-HOME-03: Cảnh báo sớm | traceability.json / nonfunctional_requirements.json | TC-UI-HOME-03, TC-UAT-AC271 | ✅ |
| COV-FR-HOME-04 | AC/Requirement | FR-HOME-04: Xếp hạng giải ngân | traceability.json / nonfunctional_requirements.json | TC-UI-HOME-04, TC-UAT-AC254 | ✅ |
| COV-FR-HOME-05 | AC/Requirement | FR-HOME-05: Bản đồ dự án | traceability.json / nonfunctional_requirements.json | TC-UI-HOME-05 | ✅ |
| COV-FR-HOME-06 | AC/Requirement | FR-HOME-06: Hồ sơ cảnh báo | traceability.json / nonfunctional_requirements.json | TC-UI-HOME-06, TC-UAT-AC271 | ✅ |
| COV-FR-HOME-07 | AC/Requirement | FR-HOME-07: Cơ cấu các nguồn vốn | traceability.json / nonfunctional_requirements.json | TC-UI-HOME-07, TC-UAT-AC269 | ✅ |
| COV-FR-HOME-08 | AC/Requirement | FR-HOME-08: Chi tiết nguồn và phạm vi tính | traceability.json / nonfunctional_requirements.json | TC-UI-HOME-08, TC-UAT-AC268, TC-UAT-AC269 | ✅ |
| COV-FR-HOME-09 | AC/Requirement | FR-HOME-09: Trung tâm điều hành giải ngân | traceability.json / nonfunctional_requirements.json | TC-UAT-AC266, TC-UAT-AC270, TC-UI-HOME-09 | ✅ |
| COV-FR-HOME-10 | AC/Requirement | FR-HOME-10: Ngữ cảnh số liệu và truy nguồn | traceability.json / nonfunctional_requirements.json | TC-UAT-AC266, TC-UAT-AC267, TC-UI-HOME-10, TC-UAT-PLAN-72 | ✅ |

## Tổng

- Coverage item: 11, mỗi item có ít nhất một TC (11/11).
- TC: 19 (hợp đồng màn hình 10, nghiệp vụ và phi chức năng 9).
