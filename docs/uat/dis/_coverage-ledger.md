# Sổ phủ — phân hệ DIS

M2=0 · FP=0 · risk=CRITICAL

> **Phạm vi:** 69 ca thiết kế của phân hệ DIS (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro CRITICAL do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-DIS-01 | AC/Requirement | FR-DIS-01: Danh sách báo cáo tuần | traceability.json / nonfunctional_requirements.json | TC-UI-DIS-01, TC-UAT-AC264, TC-UAT-PLAN-06 | ✅ |
| COV-FR-DIS-02 | AC/Requirement | FR-DIS-02: Chọn kỳ và dự án | traceability.json / nonfunctional_requirements.json | TC-UI-DIS-02, TC-UAT-AC260, TC-UAT-PLAN-67 | ✅ |
| COV-FR-DIS-03 | AC/Requirement | FR-DIS-03: Nhập khối lượng | traceability.json / nonfunctional_requirements.json | TC-UI-DIS-03, TC-UAT-AC249, TC-UAT-AC264 | ✅ |
| COV-FR-DIS-04 | AC/Requirement | FR-DIS-04: Nhập giải ngân theo nguồn | traceability.json / nonfunctional_requirements.json | TC-UAT-AC02, TC-UI-DIS-04, TC-UAT-AC240, TC-UAT-AC250, TC-UAT-PLAN-07 | ✅ |
| COV-FR-DIS-05 | AC/Requirement | FR-DIS-05: Đăng ký tháng sau | traceability.json / nonfunctional_requirements.json | TC-UI-DIS-05, TC-UAT-AC264 | ✅ |
| COV-FR-DIS-06 | AC/Requirement | FR-DIS-06: Rà soát và gửi báo cáo | traceability.json / nonfunctional_requirements.json | TC-UAT-AC01, TC-UAT-AC03, TC-UI-DIS-06, TC-UAT-AC248, TC-UAT-AC249, TC-UAT-AC250, TC-UAT-PLAN-08 | ✅ |
| COV-FR-DIS-07 | AC/Requirement | FR-DIS-07: Chi tiết báo cáo | traceability.json / nonfunctional_requirements.json | TC-UAT-AC01, TC-UAT-AC05, TC-UI-DIS-07, TC-UAT-AC260, TC-UAT-AC265 | ✅ |
| COV-FR-DIS-08 | AC/Requirement | FR-DIS-08: Sửa và bổ sung báo cáo | traceability.json / nonfunctional_requirements.json | TC-UAT-AC06, TC-UI-DIS-08, TC-UAT-AC247 | ✅ |
| COV-FR-DIS-09 | AC/Requirement | FR-DIS-09: Xác nhận xóa nháp | traceability.json / nonfunctional_requirements.json | TC-UI-DIS-09, TC-UAT-AC259, TC-UAT-PLAN-68 | ✅ |
| COV-FR-DIS-10 | AC/Requirement | FR-DIS-10: Nhập dữ liệu hàng loạt | traceability.json / nonfunctional_requirements.json | TC-UI-DIS-10, TC-UAT-AC258 | ✅ |
| COV-FR-DIS-11 | AC/Requirement | FR-DIS-11: Lịch sử và so sánh | traceability.json / nonfunctional_requirements.json | TC-UAT-AC06, TC-UI-DIS-11, TC-UAT-AC247 | ✅ |
| COV-FR-DIS-12 | AC/Requirement | FR-DIS-12: Tổng hợp theo chủ đầu tư | traceability.json / nonfunctional_requirements.json | TC-UAT-AC04, TC-UI-DIS-12, TC-UAT-AC241, TC-UAT-AC242 | ✅ |
| COV-FR-DIS-13 | AC/Requirement | FR-DIS-13: Báo cáo thuyết minh tháng | traceability.json / nonfunctional_requirements.json | TC-UI-DIS-13, TC-UAT-AC262 | ✅ |
| COV-FR-DIS-14 | AC/Requirement | FR-DIS-14: Lịch kỳ và khóa sổ | traceability.json / nonfunctional_requirements.json | TC-UAT-AC03, TC-UAT-AC07, TC-UI-DIS-14, TC-UAT-AC245, TC-UAT-PLAN-66 | ✅ |
| COV-FR-DIS-15 | AC/Requirement | FR-DIS-15: Tiến độ nộp báo cáo | traceability.json / nonfunctional_requirements.json | TC-UAT-AC07, TC-UI-DIS-15, TC-UAT-AC253, TC-UAT-AC263 | ✅ |
| COV-FR-DIS-16 | AC/Requirement | FR-DIS-16: Bảng số liệu đầy đủ và cấu hình cột | traceability.json / nonfunctional_requirements.json | TC-UI-DIS-16, TC-UAT-AC240 | ✅ |
| COV-FR-DIS-17 | AC/Requirement | FR-DIS-17: Xem trước xuất báo cáo | traceability.json / nonfunctional_requirements.json | TC-UI-DIS-17, TC-UAT-AC261, TC-UAT-PLAN-71 | ✅ |
| COV-FR-DIS-18 | AC/Requirement | FR-DIS-18: Lưu nháp thành công | traceability.json / nonfunctional_requirements.json | TC-UI-DIS-18, TC-UAT-AC259 | ✅ |
| COV-FR-DIS-19 | AC/Requirement | FR-DIS-19: Hai tỷ lệ giải ngân song song | traceability.json / nonfunctional_requirements.json | TC-UAT-AC04, TC-UAT-AC243, TC-UAT-AC244, TC-UI-DIS-19, TC-UAT-PLAN-05, TC-UAT-PLAN-09 | ✅ |
| COV-FR-DIS-20 | AC/Requirement | FR-DIS-20: Quy tắc cảnh báo sớm | traceability.json / nonfunctional_requirements.json | TC-UAT-AC252, TC-UAT-AC253, TC-UI-DIS-20, TC-UAT-PLAN-70 | ✅ |
| COV-FR-DIS-21 | AC/Requirement | FR-DIS-21: Chốt và đóng băng số liệu kỳ | traceability.json / nonfunctional_requirements.json | TC-UAT-AC244, TC-UAT-AC251, TC-UAT-AC265, TC-UI-DIS-21, TC-UAT-PLAN-69 | ✅ |
| COV-FR-DIS-22 | AC/Requirement | FR-DIS-22: Mở lại kỳ có lý do | traceability.json / nonfunctional_requirements.json | TC-UAT-AC246, TC-UI-DIS-22 | ✅ |
| COV-FR-DIS-23 | AC/Requirement | FR-DIS-23: Dự báo dòng tiền và ước cuối năm (EAC) | traceability.json / nonfunctional_requirements.json | TC-UAT-AC255, TC-UI-DIS-23 | ✅ |
| COV-FR-DIS-24 | AC/Requirement | FR-DIS-24: Kế hoạch giải ngân tuần theo dự án | traceability.json / nonfunctional_requirements.json | TC-UAT-AC256, TC-UI-DIS-24 | ✅ |
| COV-FR-DIS-25 | AC/Requirement | FR-DIS-25: Định nghĩa chỉ tiêu kỳ/YTD/lũy kế và bộ số golden | traceability.json / nonfunctional_requirements.json | TC-UAT-AC257, TC-UI-DIS-25, TC-UAT-PLAN-04 | ✅ |
| COV-FR-HOME-01 | AC/Requirement | FR-HOME-01: Tổng quan điều hành | traceability.json / nonfunctional_requirements.json | TC-UAT-AC06 | ✅ |
| COV-FR-HOME-03 | AC/Requirement | FR-HOME-03: Cảnh báo sớm | traceability.json / nonfunctional_requirements.json | TC-UAT-AC252 | ✅ |
| COV-FR-HOME-04 | AC/Requirement | FR-HOME-04: Xếp hạng giải ngân | traceability.json / nonfunctional_requirements.json | TC-UAT-AC04, TC-UAT-AC242 | ✅ |
| COV-FR-PRJ-13 | AC/Requirement | FR-PRJ-13: Theo dõi dự án tháng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC262 | ✅ |
| COV-FR-PRJ-19 | AC/Requirement | FR-PRJ-19: Yêu cầu và phản hồi giải trình | traceability.json / nonfunctional_requirements.json | TC-UAT-AC253 | ✅ |

## Tổng

- Coverage item: 30, mỗi item có ít nhất một TC (30/30).
- TC: 69 (hợp đồng màn hình 25, nghiệp vụ và phi chức năng 44).
