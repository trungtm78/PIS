# Sổ phủ — phân hệ CAP

M2=0 · FP=0 · risk=CRITICAL

> **Phạm vi:** 54 ca thiết kế của phân hệ CAP (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro CRITICAL do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-CAP-01 | AC/Requirement | FR-CAP-01: Kế hoạch trung hạn | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-01, TC-UAT-AC236 | ✅ |
| COV-FR-CAP-02 | AC/Requirement | FR-CAP-02: Lập phương án vốn | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-02, TC-UAT-AC236 | ✅ |
| COV-FR-CAP-03 | AC/Requirement | FR-CAP-03: Kế hoạch năm | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-03, TC-UAT-AC222 | ✅ |
| COV-FR-CAP-04 | AC/Requirement | FR-CAP-04: Nguồn vốn | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-04, TC-UAT-AC220, TC-UAT-AC222 | ✅ |
| COV-FR-CAP-05 | AC/Requirement | FR-CAP-05: Quyết định giao vốn | traceability.json / nonfunctional_requirements.json | TC-UAT-AC09, TC-UI-CAP-05, TC-UAT-AC223 | ✅ |
| COV-FR-CAP-06 | AC/Requirement | FR-CAP-06: Phân bổ vốn | traceability.json / nonfunctional_requirements.json | TC-UAT-AC08, TC-UI-CAP-06, TC-UAT-AC221, TC-UAT-AC237, TC-UAT-AC238 | ✅ |
| COV-FR-CAP-07 | AC/Requirement | FR-CAP-07: Điều chỉnh và điều chuyển | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-07, TC-UAT-AC224, TC-UAT-AC225, TC-UAT-PLAN-60 | ✅ |
| COV-FR-CAP-08 | AC/Requirement | FR-CAP-08: Đăng ký giải ngân tháng | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-08, TC-UAT-AC231, TC-UAT-PLAN-63 | ✅ |
| COV-FR-CAP-09 | AC/Requirement | FR-CAP-09: Mô phỏng phân bổ | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-09, TC-UAT-AC233, TC-UAT-PLAN-65 | ✅ |
| COV-FR-CAP-10 | AC/Requirement | FR-CAP-10: Phê duyệt kế hoạch | traceability.json / nonfunctional_requirements.json | TC-UAT-AC09, TC-UI-CAP-10, TC-UAT-AC223 | ✅ |
| COV-FR-CAP-11 | AC/Requirement | FR-CAP-11: Chuyển nguồn và khóa năm | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-11, TC-UAT-AC230, TC-UAT-PLAN-62 | ✅ |
| COV-FR-CAP-12 | AC/Requirement | FR-CAP-12: Kế hoạch ước giải ngân | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-12, TC-UAT-AC232 | ✅ |
| COV-FR-CAP-13 | AC/Requirement | FR-CAP-13: Nhập ước giải ngân | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-13, TC-UAT-AC232 | ✅ |
| COV-FR-CAP-14 | AC/Requirement | FR-CAP-14: Vốn hỗ trợ và tăng thu | traceability.json / nonfunctional_requirements.json | TC-UI-CAP-14, TC-UAT-AC235 | ✅ |
| COV-FR-CAP-15 | AC/Requirement | FR-CAP-15: Theo dõi kế hoạch vốn | traceability.json / nonfunctional_requirements.json | TC-UAT-AC09, TC-UI-CAP-15, TC-UAT-AC224, TC-UAT-AC237 | ✅ |
| COV-FR-CAP-16 | AC/Requirement | FR-CAP-16: Sổ dự toán và nguồn được giao | traceability.json / nonfunctional_requirements.json | TC-UAT-AC220, TC-UAT-AC239, TC-UI-CAP-16, TC-UAT-PLAN-59 | ✅ |
| COV-FR-CAP-17 | AC/Requirement | FR-CAP-17: Kiểm soát hạn mức khả dụng (AVC) | traceability.json / nonfunctional_requirements.json | TC-UAT-AC226, TC-UI-CAP-17, TC-UAT-PLAN-03 | ✅ |
| COV-FR-CAP-18 | AC/Requirement | FR-CAP-18: Giữ vốn trước cam kết | traceability.json / nonfunctional_requirements.json | TC-UAT-AC226, TC-UAT-AC227, TC-UI-CAP-18, TC-UAT-PLAN-10 | ✅ |
| COV-FR-CAP-19 | AC/Requirement | FR-CAP-19: Đề xuất điều chuyển vốn chậm sang nhanh | traceability.json / nonfunctional_requirements.json | TC-UAT-AC228, TC-UI-CAP-19, TC-UAT-PLAN-64 | ✅ |
| COV-FR-CAP-20 | AC/Requirement | FR-CAP-20: Kéo dài thời gian giải ngân vốn | traceability.json / nonfunctional_requirements.json | TC-UAT-AC229, TC-UAT-AC239, TC-UI-CAP-20, TC-UAT-PLAN-61 | ✅ |
| COV-FR-CAP-21 | AC/Requirement | FR-CAP-21: Sổ cái vốn và tra cứu theo thời điểm | traceability.json / nonfunctional_requirements.json | TC-UAT-AC227, TC-UAT-AC234, TC-UI-CAP-21, TC-UAT-PLAN-01, TC-UAT-PLAN-02 | ✅ |

## Tổng

- Coverage item: 21, mỗi item có ít nhất một TC (21/21).
- TC: 54 (hợp đồng màn hình 21, nghiệp vụ và phi chức năng 33).
