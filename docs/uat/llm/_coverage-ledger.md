# Sổ phủ — phân hệ LLM

M2=0 · FP=0 · risk=STANDARD

> **Phạm vi:** 39 ca thiết kế của phân hệ LLM (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro STANDARD do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-LLM-01 | AC/Requirement | FR-LLM-01: Tổng quan AI | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-01, TC-UAT-AC464 | ✅ |
| COV-FR-LLM-02 | AC/Requirement | FR-LLM-02: Nhà cung cấp | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-02, TC-UAT-AC457 | ✅ |
| COV-FR-LLM-03 | AC/Requirement | FR-LLM-03: Kho model và khả năng | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-03 | ✅ |
| COV-FR-LLM-04 | AC/Requirement | FR-LLM-04: Profile model theo tác vụ | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-04, TC-UAT-AC459 | ✅ |
| COV-FR-LLM-05 | AC/Requirement | FR-LLM-05: Routing và fallback | traceability.json / nonfunctional_requirements.json | TC-UAT-AC19, TC-UI-LLM-05, TC-UAT-AC458 | ✅ |
| COV-FR-LLM-06 | AC/Requirement | FR-LLM-06: Khóa ảo và bí mật | traceability.json / nonfunctional_requirements.json | TC-UAT-AC20, TC-UI-LLM-06 | ✅ |
| COV-FR-LLM-07 | AC/Requirement | FR-LLM-07: Ngân sách và quota | traceability.json / nonfunctional_requirements.json | TC-UAT-AC18, TC-UI-LLM-07, TC-UAT-AC460, TC-UAT-AC469, TC-UAT-AC470 | ✅ |
| COV-FR-LLM-08 | AC/Requirement | FR-LLM-08: Bảng giá và tỷ giá | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-08, TC-UAT-AC461 | ✅ |
| COV-FR-LLM-09 | AC/Requirement | FR-LLM-09: Chi tiết usage và đối soát | traceability.json / nonfunctional_requirements.json | TC-UAT-AC18, TC-UI-LLM-09, TC-UAT-AC461, TC-UAT-AC462, TC-UAT-AC470 | ✅ |
| COV-FR-LLM-10 | AC/Requirement | FR-LLM-10: Prompt và phiên bản | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-10, TC-UAT-AC463 | ✅ |
| COV-FR-LLM-11 | AC/Requirement | FR-LLM-11: Playground có kiểm soát | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-11 | ✅ |
| COV-FR-LLM-12 | AC/Requirement | FR-LLM-12: Bộ dữ liệu đánh giá | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-12, TC-UAT-AC459 | ✅ |
| COV-FR-LLM-13 | AC/Requirement | FR-LLM-13: So sánh đánh giá model | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-13, TC-UAT-AC459 | ✅ |
| COV-FR-LLM-14 | AC/Requirement | FR-LLM-14: Trace và lỗi | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-14, TC-UAT-AC465 | ✅ |
| COV-FR-LLM-15 | AC/Requirement | FR-LLM-15: Guardrail và dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC19, TC-UI-LLM-15, TC-UAT-AC466 | ✅ |
| COV-FR-LLM-16 | AC/Requirement | FR-LLM-16: Tri thức và chỉ mục | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-16, TC-UAT-AC467 | ✅ |
| COV-FR-LLM-17 | AC/Requirement | FR-LLM-17: Phê duyệt phát hành AI | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-17, TC-UAT-AC459 | ✅ |
| COV-FR-LLM-18 | AC/Requirement | FR-LLM-18: Sự cố và dừng khẩn cấp | traceability.json / nonfunctional_requirements.json | TC-UAT-AC21, TC-UI-LLM-18 | ✅ |
| COV-FR-LLM-19 | AC/Requirement | FR-LLM-19: Chính sách phân loại dữ liệu và định tuyến AI | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-19, TC-UAT-AC457, TC-UAT-AC458 | ✅ |
| COV-FR-LLM-20 | AC/Requirement | FR-LLM-20: Bản ghi quyết định của con người | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-20, TC-UAT-AC468 | ✅ |
| COV-FR-LLM-21 | AC/Requirement | FR-LLM-21: Nhật ký định tuyến AI | traceability.json / nonfunctional_requirements.json | TC-UI-LLM-21, TC-UAT-AC458, TC-UAT-AC465 | ✅ |

## Tổng

- Coverage item: 21, mỗi item có ít nhất một TC (21/21).
- TC: 39 (hợp đồng màn hình 21, nghiệp vụ và phi chức năng 18).
