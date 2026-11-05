# Sổ phủ — phân hệ PAY

M2=0 · FP=0 · risk=CRITICAL

> **Phạm vi:** 52 ca thiết kế của phân hệ PAY (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro CRITICAL do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-CTR-03 | AC/Requirement | FR-CTR-03: Không gian thực hiện hợp đồng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC67, TC-UAT-AC330 | ✅ |
| COV-FR-CTR-06 | AC/Requirement | FR-CTR-06: Tạm ứng và lịch thu hồi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC325 | ✅ |
| COV-FR-CTR-13 | AC/Requirement | FR-CTR-13: Bảng xác định giá trị thanh toán | traceability.json / nonfunctional_requirements.json | TC-UAT-AC323 | ✅ |
| COV-FR-CTR-22 | AC/Requirement | FR-CTR-22: Tạm dừng, tiếp tục và chấm dứt hợp đồng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC338, TC-UAT-AC344 | ✅ |
| COV-FR-CTR-25 | AC/Requirement | FR-CTR-25: Thành viên liên danh và phạm vi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC327 | ✅ |
| COV-FR-LND-03 | AC/Requirement | FR-LND-03: Hộ bị ảnh hưởng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC396 | ✅ |
| COV-FR-LND-07 | AC/Requirement | FR-LND-07: Chi trả bồi thường | traceability.json / nonfunctional_requirements.json | TC-UAT-AC328 | ✅ |
| COV-FR-PAY-01 | AC/Requirement | FR-PAY-01: Danh sách hồ sơ thanh toán | traceability.json / nonfunctional_requirements.json | TC-UI-PAY-01, TC-UAT-AC341, TC-UAT-AC396 | ✅ |
| COV-FR-PAY-02 | AC/Requirement | FR-PAY-02: Tạo đề nghị thanh toán | traceability.json / nonfunctional_requirements.json | TC-UI-PAY-02, TC-UAT-AC320, TC-UAT-AC323, TC-UAT-AC324, TC-UAT-AC330, TC-UAT-AC332, TC-UAT-AC338, TC-UAT-AC342, TC-UAT-AC344, TC-UAT-AC345, TC-UAT-AC399, TC-UAT-PLAN-19 | ✅ |
| COV-FR-PAY-03 | AC/Requirement | FR-PAY-03: Chi tiết và chứng từ | traceability.json / nonfunctional_requirements.json | TC-UI-PAY-03, TC-UAT-AC332 | ✅ |
| COV-FR-PAY-04 | AC/Requirement | FR-PAY-04: Theo dõi gửi Kho bạc | traceability.json / nonfunctional_requirements.json | TC-UAT-AC10, TC-UI-PAY-04, TC-UAT-AC331, TC-UAT-AC335, TC-UAT-PLAN-20 | ✅ |
| COV-FR-PAY-05 | AC/Requirement | FR-PAY-05: Đối soát giao dịch | traceability.json / nonfunctional_requirements.json | TC-UAT-AC10, TC-UAT-AC11, TC-UAT-AC12, TC-UI-PAY-05, TC-UAT-AC335, TC-UAT-AC336 | ✅ |
| COV-FR-PAY-06 | AC/Requirement | FR-PAY-06: Xử lý sai lệch | traceability.json / nonfunctional_requirements.json | TC-UAT-AC12, TC-UI-PAY-06, TC-UAT-AC334, TC-UAT-AC336 | ✅ |
| COV-FR-PAY-07 | AC/Requirement | FR-PAY-07: Tạm ứng và thu hồi | traceability.json / nonfunctional_requirements.json | TC-UI-PAY-07, TC-UAT-AC327, TC-UAT-AC329 | ✅ |
| COV-FR-PAY-08 | AC/Requirement | FR-PAY-08: Đảo và điều chỉnh giao dịch | traceability.json / nonfunctional_requirements.json | TC-UI-PAY-08, TC-UAT-AC322, TC-UAT-AC331 | ✅ |
| COV-FR-PAY-09 | AC/Requirement | FR-PAY-09: Theo dõi dự án Kho bạc | traceability.json / nonfunctional_requirements.json | TC-UI-PAY-09 | ✅ |
| COV-FR-PAY-10 | AC/Requirement | FR-PAY-10: Sổ lũy kế hợp đồng × dòng BOQ × nghiệm thu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC320, TC-UAT-AC321, TC-UAT-AC322, TC-UAT-AC341, TC-UAT-AC343, TC-UAT-AC399, TC-UI-PAY-10 | ✅ |
| COV-FR-PAY-11 | AC/Requirement | FR-PAY-11: Đề nghị tạm ứng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC325, TC-UAT-AC326, TC-UI-PAY-11 | ✅ |
| COV-FR-PAY-12 | AC/Requirement | FR-PAY-12: Cảnh báo tạm ứng quá hạn và thu hồi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC328, TC-UAT-AC329, TC-UI-PAY-12 | ✅ |
| COV-FR-PAY-13 | AC/Requirement | FR-PAY-13: Nhập sao kê Kho bạc | traceability.json / nonfunctional_requirements.json | TC-UAT-AC11, TC-UAT-AC333, TC-UAT-AC334, TC-UAT-AC341, TC-UI-PAY-13 | ✅ |
| COV-FR-PAY-14 | AC/Requirement | FR-PAY-14: Biểu mẫu thanh toán Kho bạc | traceability.json / nonfunctional_requirements.json | TC-UAT-AC337, TC-UI-PAY-14 | ✅ |
| COV-FR-PAY-15 | AC/Requirement | FR-PAY-15: Quyết toán niên độ và dự án hoàn thành | traceability.json / nonfunctional_requirements.json | TC-UAT-AC339, TC-UAT-AC340, TC-UI-PAY-15, TC-UAT-PLAN-21 | ✅ |
| COV-FR-PAY-16 | AC/Requirement | FR-PAY-16: Biểu mẫu quyết toán và hạn thẩm tra | traceability.json / nonfunctional_requirements.json | TC-UAT-AC339, TC-UAT-AC340, TC-UI-PAY-16 | ✅ |
| COV-FR-PAY-17 | AC/Requirement | FR-PAY-17: Truy vết chuỗi thanh toán | traceability.json / nonfunctional_requirements.json | TC-UAT-AC67, TC-UI-PAY-17 | ✅ |

## Tổng

- Coverage item: 24, mỗi item có ít nhất một TC (24/24).
- TC: 52 (hợp đồng màn hình 17, nghiệp vụ và phi chức năng 35).
