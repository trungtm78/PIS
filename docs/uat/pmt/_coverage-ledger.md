# Sổ phủ — phân hệ PMT

M2=0 · FP=0 · risk=STANDARD

> **Phạm vi:** 14 ca thiết kế của phân hệ PMT (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro STANDARD do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-PMT-01 | AC/Requirement | FR-PMT-01: Hồ sơ pháp lý dự án | traceability.json / nonfunctional_requirements.json | TC-UAT-AC368, TC-UAT-AC374, TC-UAT-AC375, TC-UI-PMT-01 | ✅ |
| COV-FR-PMT-02 | AC/Requirement | FR-PMT-02: Chi tiết giấy phép và mốc xử lý | traceability.json / nonfunctional_requirements.json | TC-UAT-AC368, TC-UAT-AC370, TC-UAT-AC375, TC-UI-PMT-02 | ✅ |
| COV-FR-PMT-03 | AC/Requirement | FR-PMT-03: Danh mục loại giấy phép | traceability.json / nonfunctional_requirements.json | TC-UAT-AC371, TC-UI-PMT-03 | ✅ |
| COV-FR-PMT-04 | AC/Requirement | FR-PMT-04: Quy tắc cổng chặn mốc | traceability.json / nonfunctional_requirements.json | TC-UAT-AC368, TC-UAT-AC369, TC-UAT-AC373, TC-UI-PMT-04 | ✅ |
| COV-FR-PMT-05 | AC/Requirement | FR-PMT-05: Cảnh báo hết hạn giấy phép | traceability.json / nonfunctional_requirements.json | TC-UAT-AC369, TC-UAT-AC370, TC-UI-PMT-05 | ✅ |
| COV-FR-PMT-06 | AC/Requirement | FR-PMT-06: Miễn giấy phép và miễn trừ cổng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC372, TC-UAT-AC373, TC-UI-PMT-06 | ✅ |

## Tổng

- Coverage item: 6, mỗi item có ít nhất một TC (6/6).
- TC: 14 (hợp đồng màn hình 6, nghiệp vụ và phi chức năng 8).
