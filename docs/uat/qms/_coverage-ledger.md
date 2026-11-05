# Sổ phủ — phân hệ QMS

M2=0 · FP=0 · risk=STANDARD

> **Phạm vi:** 25 ca thiết kế của phân hệ QMS (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro STANDARD do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-CTR-09 | AC/Requirement | FR-CTR-09: Nhật ký công trường | traceability.json / nonfunctional_requirements.json | TC-UAT-AC62 | ✅ |
| COV-FR-QMS-01 | AC/Requirement | FR-QMS-01: Danh mục nhật ký thi công điện tử | traceability.json / nonfunctional_requirements.json | TC-UAT-AC364, TC-UI-QMS-01 | ✅ |
| COV-FR-QMS-02 | AC/Requirement | FR-QMS-02: Lập và ký nhật ký ngày | traceability.json / nonfunctional_requirements.json | TC-UAT-AC62, TC-UAT-AC356, TC-UAT-AC357, TC-UAT-AC365, TC-UI-QMS-02 | ✅ |
| COV-FR-QMS-03 | AC/Requirement | FR-QMS-03: Ý kiến giám sát và xác nhận chủ đầu tư | traceability.json / nonfunctional_requirements.json | TC-UAT-AC356, TC-UAT-AC365, TC-UAT-AC366, TC-UI-QMS-03 | ✅ |
| COV-FR-QMS-04 | AC/Requirement | FR-QMS-04: Đề nghị kiểm tra, nghiệm thu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC360, TC-UAT-AC363, TC-UI-QMS-04 | ✅ |
| COV-FR-QMS-05 | AC/Requirement | FR-QMS-05: Biên bản nghiệm thu chất lượng | traceability.json / nonfunctional_requirements.json | TC-UAT-AC360, TC-UAT-AC361, TC-UAT-AC363, TC-UI-QMS-05, TC-UAT-PLAN-27 | ✅ |
| COV-FR-QMS-06 | AC/Requirement | FR-QMS-06: Thí nghiệm vật liệu | traceability.json / nonfunctional_requirements.json | TC-UAT-AC362, TC-UI-QMS-06 | ✅ |
| COV-FR-QMS-07 | AC/Requirement | FR-QMS-07: Không phù hợp và hành động khắc phục | traceability.json / nonfunctional_requirements.json | TC-UAT-AC361, TC-UAT-AC362, TC-UI-QMS-07 | ✅ |
| COV-FR-QMS-08 | AC/Requirement | FR-QMS-08: Kho ảnh hiện trường có định vị | traceability.json / nonfunctional_requirements.json | TC-UAT-AC359, TC-UI-QMS-08 | ✅ |
| COV-FR-QMS-09 | AC/Requirement | FR-QMS-09: Nhật ký thi công ngoại tuyến trên điện thoại | traceability.json / nonfunctional_requirements.json | TC-UAT-AC62, TC-UAT-AC358, TC-UAT-AC367, TC-UI-QMS-09 | ✅ |
| COV-FR-QMS-10 | AC/Requirement | FR-QMS-10: Chụp ảnh hiện trường kiểm EXIF và GPS | traceability.json / nonfunctional_requirements.json | TC-UAT-AC359, TC-UAT-AC367, TC-UI-QMS-10 | ✅ |
| COV-FR-QMS-11 | AC/Requirement | FR-QMS-11: Độ phủ nhật ký và cảnh báo thiếu nhật ký | traceability.json / nonfunctional_requirements.json | TC-UAT-AC364, TC-UI-QMS-11 | ✅ |

## Tổng

- Coverage item: 12, mỗi item có ít nhất một TC (12/12).
- TC: 25 (hợp đồng màn hình 11, nghiệp vụ và phi chức năng 14).
