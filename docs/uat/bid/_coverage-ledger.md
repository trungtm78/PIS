# Sổ phủ — phân hệ BID

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 38 ca thiết kế của phân hệ BID (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-BID-01 | AC/Requirement | FR-BID-01: Danh sách nhà thầu | traceability.json / nonfunctional_requirements.json | TC-UI-BID-01, TC-UAT-AC446 | ✅ |
| COV-FR-BID-02 | AC/Requirement | FR-BID-02: Hồ sơ nhà thầu | traceability.json / nonfunctional_requirements.json | TC-UI-BID-02, TC-UAT-AC451 | ✅ |
| COV-FR-BID-03 | AC/Requirement | FR-BID-03: Gói thầu và đề án | traceability.json / nonfunctional_requirements.json | TC-UI-BID-03, TC-UAT-AC445 | ✅ |
| COV-FR-BID-04 | AC/Requirement | FR-BID-04: Tiêu chí đánh giá | traceability.json / nonfunctional_requirements.json | TC-UAT-AC17, TC-UI-BID-04, TC-UAT-AC447 | ✅ |
| COV-FR-BID-05 | AC/Requirement | FR-BID-05: Tiếp nhận hồ sơ | traceability.json / nonfunctional_requirements.json | TC-UI-BID-05, TC-UAT-AC446, TC-UAT-AC448 | ✅ |
| COV-FR-BID-06 | AC/Requirement | FR-BID-06: Kiểm tra OCR | traceability.json / nonfunctional_requirements.json | TC-UI-BID-06, TC-UAT-AC449 | ✅ |
| COV-FR-BID-07 | AC/Requirement | FR-BID-07: Cấu hình lượt phân tích | traceability.json / nonfunctional_requirements.json | TC-UAT-AC13, TC-UAT-AC15, TC-UI-BID-07 | ✅ |
| COV-FR-BID-08 | AC/Requirement | FR-BID-08: Tiến trình phân tích | traceability.json / nonfunctional_requirements.json | TC-UAT-AC15, TC-UI-BID-08, TC-UAT-AC449 | ✅ |
| COV-FR-BID-09 | AC/Requirement | FR-BID-09: Bàn phân tích có dẫn chứng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC13, TC-UAT-AC14, TC-UI-BID-09, TC-UAT-AC451 | ✅ |
| COV-FR-BID-10 | AC/Requirement | FR-BID-10: So sánh đề án | traceability.json / nonfunctional_requirements.json | TC-UAT-AC17, TC-UI-BID-10 | ✅ |
| COV-FR-BID-11 | AC/Requirement | FR-BID-11: Làm rõ hồ sơ | traceability.json / nonfunctional_requirements.json | TC-UI-BID-11, TC-UAT-AC452 | ✅ |
| COV-FR-BID-12 | AC/Requirement | FR-BID-12: Thẩm tra chuyên gia | traceability.json / nonfunctional_requirements.json | TC-UAT-AC16, TC-UI-BID-12, TC-UAT-AC450 | ✅ |
| COV-FR-BID-13 | AC/Requirement | FR-BID-13: Biên bản đánh giá | traceability.json / nonfunctional_requirements.json | TC-UI-BID-13, TC-UAT-AC453 | ✅ |
| COV-FR-BID-14 | AC/Requirement | FR-BID-14: Hợp đồng và thay đổi | traceability.json / nonfunctional_requirements.json | TC-UI-BID-14 | ✅ |
| COV-FR-BID-15 | AC/Requirement | FR-BID-15: Kế hoạch lựa chọn nhà thầu | traceability.json / nonfunctional_requirements.json | TC-UI-BID-15, TC-UAT-AC445 | ✅ |
| COV-FR-BID-16 | AC/Requirement | FR-BID-16: Lập và điều chỉnh kế hoạch thầu | traceability.json / nonfunctional_requirements.json | TC-UI-BID-16, TC-UAT-AC445 | ✅ |
| COV-FR-BID-17 | AC/Requirement | FR-BID-17: Theo dõi mời thầu và mốc lựa chọn | traceability.json / nonfunctional_requirements.json | TC-UI-BID-17, TC-UAT-AC454 | ✅ |
| COV-FR-BID-18 | AC/Requirement | FR-BID-18: Phê duyệt kết quả lựa chọn | traceability.json / nonfunctional_requirements.json | TC-UAT-AC16, TC-UI-BID-18, TC-UAT-AC455 | ✅ |
| COV-FR-BID-19 | AC/Requirement | FR-BID-19: Liên kết cổng đấu thầu và đối soát | traceability.json / nonfunctional_requirements.json | TC-UI-BID-19, TC-UAT-AC454 | ✅ |
| COV-FR-BID-20 | AC/Requirement | FR-BID-20: Kiến nghị và xung đột lợi ích | traceability.json / nonfunctional_requirements.json | TC-UI-BID-20, TC-UAT-AC450, TC-UAT-AC456 | ✅ |
| COV-FR-BID-21 | AC/Requirement | FR-BID-21: Hạn chế tham gia lựa chọn nhà thầu | traceability.json / nonfunctional_requirements.json | TC-UI-BID-21, TC-UAT-AC446 | ✅ |
| COV-FR-LLM-16 | AC/Requirement | FR-LLM-16: Tri thức và chỉ mục | traceability.json / nonfunctional_requirements.json | TC-UAT-AC14 | ✅ |

## Tổng

- Coverage item: 22, mỗi item có ít nhất một TC (22/22).
- TC: 38 (hợp đồng màn hình 21, nghiệp vụ và phi chức năng 17).
