# Sổ phủ — phân hệ CTR

M2=0 · FP=0 · risk=CRITICAL

> **Phạm vi:** 60 ca thiết kế của phân hệ CTR (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro CRITICAL do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-AST-02 | AC/Requirement | FR-AST-02: Biên bản bàn giao và tồn tại | traceability.json / nonfunctional_requirements.json | TC-UAT-AC65 | ✅ |
| COV-FR-AST-03 | AC/Requirement | FR-AST-03: Hồ sơ tài sản | traceability.json / nonfunctional_requirements.json | TC-UAT-AC65 | ✅ |
| COV-FR-CTR-01 | AC/Requirement | FR-CTR-01: Danh mục hợp đồng | traceability.json / nonfunctional_requirements.json | TC-UI-CTR-01, TC-UAT-AC301 | ✅ |
| COV-FR-CTR-02 | AC/Requirement | FR-CTR-02: Soạn và ký kết hợp đồng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC56, TC-UAT-AC57, TC-UI-CTR-02, TC-UAT-AC300, TC-UAT-AC302, TC-UAT-AC306, TC-UAT-AC316, TC-UAT-AC317 | ✅ |
| COV-FR-CTR-03 | AC/Requirement | FR-CTR-03: Không gian thực hiện hợp đồng | traceability.json / nonfunctional_requirements.json | TC-UI-CTR-03, TC-UAT-AC300, TC-UAT-AC301, TC-UAT-AC305, TC-UAT-AC398 | ✅ |
| COV-FR-CTR-04 | AC/Requirement | FR-CTR-04: BOQ và mốc thanh toán | traceability.json / nonfunctional_requirements.json | TC-UI-CTR-04, TC-UAT-AC309, TC-UAT-AC312, TC-UAT-PLAN-15, TC-UAT-PLAN-16 | ✅ |
| COV-FR-CTR-05 | AC/Requirement | FR-CTR-05: Bảo lãnh và bảo hiểm | traceability.json / nonfunctional_requirements.json | TC-UAT-AC59, TC-UI-CTR-05, TC-UAT-AC302, TC-UAT-AC304, TC-UAT-AC310 | ✅ |
| COV-FR-CTR-06 | AC/Requirement | FR-CTR-06: Tạm ứng và lịch thu hồi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC61, TC-UI-CTR-06 | ✅ |
| COV-FR-CTR-07 | AC/Requirement | FR-CTR-07: Yêu cầu thay đổi và phát sinh | traceability.json / nonfunctional_requirements.json | TC-UI-CTR-07 | ✅ |
| COV-FR-CTR-08 | AC/Requirement | FR-CTR-08: So sánh và duyệt phụ lục | traceability.json / nonfunctional_requirements.json | TC-UAT-AC58, TC-UI-CTR-08, TC-UAT-AC308 | ✅ |
| COV-FR-CTR-09 | AC/Requirement | FR-CTR-09: Nhật ký công trường | traceability.json / nonfunctional_requirements.json | TC-UI-CTR-09 | ✅ |
| COV-FR-CTR-10 | AC/Requirement | FR-CTR-10: Ghi nhận khối lượng thực hiện | traceability.json / nonfunctional_requirements.json | TC-UAT-AC60, TC-UAT-AC63, TC-UI-CTR-10, TC-UAT-AC303, TC-UAT-AC311, TC-UAT-AC312 | ✅ |
| COV-FR-CTR-11 | AC/Requirement | FR-CTR-11: Kiểm tra chất lượng và NCR | traceability.json / nonfunctional_requirements.json | TC-UI-CTR-11 | ✅ |
| COV-FR-CTR-12 | AC/Requirement | FR-CTR-12: Nghiệm thu khối lượng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC63, TC-UI-CTR-12, TC-UAT-AC313, TC-UAT-AC314, TC-UAT-AC397 | ✅ |
| COV-FR-CTR-13 | AC/Requirement | FR-CTR-13: Bảng xác định giá trị thanh toán | traceability.json / nonfunctional_requirements.json | TC-UAT-AC64, TC-UI-CTR-13 | ✅ |
| COV-FR-CTR-14 | AC/Requirement | FR-CTR-14: Chậm tiến độ và yêu cầu bồi hoàn | traceability.json / nonfunctional_requirements.json | TC-UI-CTR-14 | ✅ |
| COV-FR-CTR-15 | AC/Requirement | FR-CTR-15: Hoàn thành và bàn giao | traceability.json / nonfunctional_requirements.json | TC-UAT-AC65, TC-UI-CTR-15, TC-UAT-AC305 | ✅ |
| COV-FR-CTR-16 | AC/Requirement | FR-CTR-16: Bảo hành và khắc phục tồn tại | traceability.json / nonfunctional_requirements.json | TC-UI-CTR-16 | ✅ |
| COV-FR-CTR-17 | AC/Requirement | FR-CTR-17: Quyết toán hợp đồng và dự án | traceability.json / nonfunctional_requirements.json | TC-UAT-AC66, TC-UI-CTR-17 | ✅ |
| COV-FR-CTR-18 | AC/Requirement | FR-CTR-18: Hồ sơ tài sản và chuyển giao vận hành | traceability.json / nonfunctional_requirements.json | TC-UI-CTR-18 | ✅ |
| COV-FR-CTR-19 | AC/Requirement | FR-CTR-19: Chuỗi thay đổi ChangeEvent → PCO → CO | traceability.json / nonfunctional_requirements.json | TC-UAT-AC58, TC-UAT-AC307, TC-UAT-AC308, TC-UI-CTR-19 | ✅ |
| COV-FR-CTR-20 | AC/Requirement | FR-CTR-20: Cấu hình số tầng thay đổi của dự án | traceability.json / nonfunctional_requirements.json | TC-UAT-AC307, TC-UI-CTR-20 | ✅ |
| COV-FR-CTR-21 | AC/Requirement | FR-CTR-21: Giữ lại theo dòng BOQ và giải tỏa | traceability.json / nonfunctional_requirements.json | TC-UAT-AC309, TC-UI-CTR-21 | ✅ |
| COV-FR-CTR-22 | AC/Requirement | FR-CTR-22: Tạm dừng, tiếp tục và chấm dứt hợp đồng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC300, TC-UAT-AC303, TC-UAT-AC304, TC-UI-CTR-22 | ✅ |
| COV-FR-CTR-23 | AC/Requirement | FR-CTR-23: Bảng điểm nhà thầu và nhật ký vi phạm | traceability.json / nonfunctional_requirements.json | TC-UAT-AC315, TC-UI-CTR-23, TC-UAT-PLAN-17 | ✅ |
| COV-FR-CTR-24 | AC/Requirement | FR-CTR-24: Xuất hồ sơ nhà thầu cho cơ sở dữ liệu quốc gia | traceability.json / nonfunctional_requirements.json | TC-UAT-AC315, TC-UI-CTR-24, TC-UAT-PLAN-18 | ✅ |
| COV-FR-CTR-25 | AC/Requirement | FR-CTR-25: Thành viên liên danh và phạm vi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC306, TC-UI-CTR-25 | ✅ |
| COV-FR-CTR-26 | AC/Requirement | FR-CTR-26: Phiên bản hợp đồng và hiệu lực | traceability.json / nonfunctional_requirements.json | TC-UAT-AC58, TC-UAT-AC308, TC-UI-CTR-26 | ✅ |
| COV-FR-ISS-01 | AC/Requirement | FR-ISS-01: Danh sách vướng mắc | traceability.json / nonfunctional_requirements.json | TC-UAT-AC397 | ✅ |
| COV-FR-LND-07 | AC/Requirement | FR-LND-07: Chi trả bồi thường | traceability.json / nonfunctional_requirements.json | TC-UAT-AC397 | ✅ |
| COV-FR-PAY-02 | AC/Requirement | FR-PAY-02: Tạo đề nghị thanh toán | traceability.json / nonfunctional_requirements.json | TC-UAT-AC60, TC-UAT-AC64, TC-UAT-AC397 | ✅ |
| COV-FR-PAY-03 | AC/Requirement | FR-PAY-03: Chi tiết và chứng từ | traceability.json / nonfunctional_requirements.json | TC-UAT-AC60 | ✅ |
| COV-FR-PAY-07 | AC/Requirement | FR-PAY-07: Tạm ứng và thu hồi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC61 | ✅ |
| COV-FR-PAY-10 | AC/Requirement | FR-PAY-10: Sổ lũy kế hợp đồng × dòng BOQ × nghiệm thu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC398 | ✅ |
| COV-FR-PAY-15 | AC/Requirement | FR-PAY-15: Quyết toán niên độ và dự án hoàn thành | traceability.json / nonfunctional_requirements.json | TC-UAT-AC66 | ✅ |

## Tổng

- Coverage item: 35, mỗi item có ít nhất một TC (35/35).
- TC: 60 (hợp đồng màn hình 26, nghiệp vụ và phi chức năng 34).
