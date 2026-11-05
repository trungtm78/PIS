# Sổ phủ — phân hệ AUD

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 23 ca thiết kế của phân hệ AUD (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-AUD-01 | AC/Requirement | FR-AUD-01: Tổng quan thanh tra, kiểm toán | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-01, TC-UAT-AC437 | ✅ |
| COV-FR-AUD-02 | AC/Requirement | FR-AUD-02: Danh sách cuộc thanh tra, kiểm toán | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-02, TC-UAT-AC433, TC-UAT-AC442 | ✅ |
| COV-FR-AUD-03 | AC/Requirement | FR-AUD-03: Hồ sơ cuộc thanh tra, kiểm toán | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-03, TC-UAT-AC433, TC-UAT-AC442, TC-UAT-AC443 | ✅ |
| COV-FR-AUD-04 | AC/Requirement | FR-AUD-04: Tiếp nhận kết luận, báo cáo kiểm toán | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-04, TC-UAT-AC434, TC-UAT-AC443 | ✅ |
| COV-FR-AUD-05 | AC/Requirement | FR-AUD-05: Phát hiện | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-05, TC-UAT-AC434 | ✅ |
| COV-FR-AUD-06 | AC/Requirement | FR-AUD-06: Kiến nghị và phân công | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-06, TC-UAT-AC435, TC-UAT-AC441 | ✅ |
| COV-FR-AUD-07 | AC/Requirement | FR-AUD-07: Theo dõi thực hiện kiến nghị | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-07, TC-UAT-AC436, TC-UAT-AC438, TC-UAT-AC441 | ✅ |
| COV-FR-AUD-08 | AC/Requirement | FR-AUD-08: Thu hồi tài chính và đối chiếu PAY | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-08, TC-UAT-AC437, TC-UAT-AC439, TC-UAT-AC444 | ✅ |
| COV-FR-AUD-09 | AC/Requirement | FR-AUD-09: Bằng chứng khắc phục | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-09, TC-UAT-AC436 | ✅ |
| COV-FR-AUD-10 | AC/Requirement | FR-AUD-10: Báo cáo kết quả thực hiện kiến nghị | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-10, TC-UAT-AC440 | ✅ |
| COV-FR-AUD-11 | AC/Requirement | FR-AUD-11: Cảnh báo quá hạn và leo thang | traceability.json / nonfunctional_requirements.json | TC-UI-AUD-11, TC-UAT-AC438 | ✅ |

## Tổng

- Coverage item: 11, mỗi item có ít nhất một TC (11/11).
- TC: 23 (hợp đồng màn hình 11, nghiệp vụ và phi chức năng 12).
