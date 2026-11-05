# Sổ phủ — phân hệ BI

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 37 ca thiết kế của phân hệ BI (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-BI-01 | AC/Requirement | FR-BI-01: Thư viện dashboard | traceability.json / nonfunctional_requirements.json | TC-UAT-AC35, TC-UI-BI-01 | ✅ |
| COV-FR-BI-02 | AC/Requirement | FR-BI-02: Dashboard của tôi | traceability.json / nonfunctional_requirements.json | TC-UAT-AC31, TC-UAT-AC34, TC-UI-BI-02 | ✅ |
| COV-FR-BI-03 | AC/Requirement | FR-BI-03: Trình dựng dashboard | traceability.json / nonfunctional_requirements.json | TC-UI-BI-03, TC-UAT-AC474 | ✅ |
| COV-FR-BI-04 | AC/Requirement | FR-BI-04: Trình dựng biểu đồ | traceability.json / nonfunctional_requirements.json | TC-UAT-AC32, TC-UI-BI-04 | ✅ |
| COV-FR-BI-05 | AC/Requirement | FR-BI-05: Danh mục chỉ tiêu | traceability.json / nonfunctional_requirements.json | TC-UI-BI-05, TC-UAT-AC471 | ✅ |
| COV-FR-BI-06 | AC/Requirement | FR-BI-06: Định nghĩa chỉ tiêu | traceability.json / nonfunctional_requirements.json | TC-BI01, TC-UI-BI-06, TC-UAT-AC471, TC-UAT-AC472 | ✅ |
| COV-FR-BI-07 | AC/Requirement | FR-BI-07: Nguồn và mô hình dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UI-BI-07, TC-UAT-AC476 | ✅ |
| COV-FR-BI-08 | AC/Requirement | FR-BI-08: Phân quyền dòng và cột | traceability.json / nonfunctional_requirements.json | TC-UAT-AC33, TC-UI-BI-08, TC-UAT-AC473 | ✅ |
| COV-FR-BI-09 | AC/Requirement | FR-BI-09: Trình phân tích dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC31, TC-UAT-AC32, TC-UAT-AC33, TC-UI-BI-09, TC-UAT-AC473, TC-UAT-AC476, TC-UAT-AC477, TC-UAT-AC479, TC-UAT-AC480, TC-UAT-AC481 | ✅ |
| COV-FR-BI-10 | AC/Requirement | FR-BI-10: So sánh phiên bản dashboard | traceability.json / nonfunctional_requirements.json | TC-UI-BI-10 | ✅ |
| COV-FR-BI-11 | AC/Requirement | FR-BI-11: Phê duyệt công bố | traceability.json / nonfunctional_requirements.json | TC-UI-BI-11, TC-UAT-AC474 | ✅ |
| COV-FR-BI-12 | AC/Requirement | FR-BI-12: Lịch xuất và phân phối | traceability.json / nonfunctional_requirements.json | TC-BI02, TC-UI-BI-12, TC-UAT-AC475 | ✅ |
| COV-FR-BI-13 | AC/Requirement | FR-BI-13: Nhật ký truy vấn và hiệu năng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC34, TC-UI-BI-13, TC-UAT-AC477 | ✅ |
| COV-FR-BI-14 | AC/Requirement | FR-BI-14: Lineage và chất lượng dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UI-BI-14, TC-UAT-AC478 | ✅ |
| COV-FR-BI-15 | AC/Requirement | FR-BI-15: Đăng ký chỉ tiêu từ mã nguồn | traceability.json / nonfunctional_requirements.json | TC-UI-BI-15, TC-UAT-AC471 | ✅ |
| COV-FR-BI-16 | AC/Requirement | FR-BI-16: Xuất dữ liệu và phạm vi | traceability.json / nonfunctional_requirements.json | TC-UI-BI-16, TC-UAT-AC475, TC-UAT-AC479 | ✅ |
| COV-FR-BI-17 | AC/Requirement | FR-BI-17: Chia sẻ dashboard | traceability.json / nonfunctional_requirements.json | TC-UAT-AC35, TC-UI-BI-17 | ✅ |
| COV-FR-BI-18 | AC/Requirement | FR-BI-18: Bộ dữ liệu và ảnh chụp kỳ | traceability.json / nonfunctional_requirements.json | TC-UI-BI-18, TC-UAT-AC478, TC-UAT-AC482 | ✅ |
| COV-NFR-PERFORMANCE-03 | ISO 25010 · performance | NFR-PERFORMANCE-03: BI từ snapshot kỳ, truy vấn nặng bất đồng bộ | traceability.json / nonfunctional_requirements.json | TC-BI01 | ✅ |
| COV-NFR-TENANCY-06 | ISO 25010 · tenancy | NFR-TENANCY-06: Cách ly tenant và scope ở export/BI job | traceability.json / nonfunctional_requirements.json | TC-BI02 | ✅ |

## Tổng

- Coverage item: 20, mỗi item có ít nhất một TC (20/20).
- TC: 37 (hợp đồng màn hình 18, nghiệp vụ và phi chức năng 19).
