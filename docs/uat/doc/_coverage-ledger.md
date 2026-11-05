# Sổ phủ — phân hệ DOC

M2=0 · FP=0 · risk=HIGH

> **Phạm vi:** 56 ca thiết kế của phân hệ DOC (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro HIGH do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-DOC-01 | AC/Requirement | FR-DOC-01: Tổng quan văn bản | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-01, TC-UAT-AC419 | ✅ |
| COV-FR-DOC-02 | AC/Requirement | FR-DOC-02: Soạn thảo văn bản đi | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-02, TC-UAT-AC407, TC-UAT-AC408, TC-UAT-AC409, TC-UAT-AC410, TC-UAT-AC415, TC-UAT-AC423, TC-UAT-AC429 | ✅ |
| COV-FR-DOC-03 | AC/Requirement | FR-DOC-03: Danh sách văn bản đi | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-03, TC-UAT-AC413, TC-UAT-AC432 | ✅ |
| COV-FR-DOC-04 | AC/Requirement | FR-DOC-04: Rà soát và trình ký | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-04, TC-UAT-AC414, TC-UAT-AC418, TC-UAT-AC428 | ✅ |
| COV-FR-DOC-05 | AC/Requirement | FR-DOC-05: Ký số lãnh đạo | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-05, TC-UAT-AC403, TC-UAT-AC406, TC-UAT-AC414, TC-UAT-AC426, TC-UAT-AC430 | ✅ |
| COV-FR-DOC-06 | AC/Requirement | FR-DOC-06: Cấp số và ký số cơ quan | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-06, TC-UAT-AC400, TC-UAT-AC401, TC-UAT-AC402, TC-UAT-AC403, TC-UAT-AC414, TC-UAT-AC427, TC-UAT-AC430 | ✅ |
| COV-FR-DOC-07 | AC/Requirement | FR-DOC-07: Xác minh chữ ký và chứng thư | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-07, TC-UAT-AC403, TC-UAT-AC404, TC-UAT-AC405, TC-UAT-AC406, TC-UAT-AC430 | ✅ |
| COV-FR-DOC-08 | AC/Requirement | FR-DOC-08: Phát hành và phân phối | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-08, TC-UAT-AC410, TC-UAT-AC425, TC-UAT-AC432 | ✅ |
| COV-FR-DOC-09 | AC/Requirement | FR-DOC-09: Tải lên văn bản đã ký bên ngoài | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-09, TC-UAT-AC406, TC-UAT-AC417 | ✅ |
| COV-FR-DOC-10 | AC/Requirement | FR-DOC-10: Sổ đăng ký văn bản đi | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-10, TC-UAT-AC400, TC-UAT-AC413, TC-UAT-AC417, TC-UAT-AC427, TC-UAT-AC431 | ✅ |
| COV-FR-DOC-11 | AC/Requirement | FR-DOC-11: Tiếp nhận văn bản đến | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-11, TC-UAT-AC419, TC-UAT-AC429 | ✅ |
| COV-FR-DOC-12 | AC/Requirement | FR-DOC-12: Sổ văn bản đến và phân công | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-12, TC-UAT-AC419, TC-UAT-AC420 | ✅ |
| COV-FR-DOC-13 | AC/Requirement | FR-DOC-13: Xử lý văn bản đến | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-13, TC-UAT-AC419, TC-UAT-AC420 | ✅ |
| COV-FR-DOC-14 | AC/Requirement | FR-DOC-14: Thư viện mẫu văn bản | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-14, TC-UAT-AC407, TC-UAT-AC408, TC-UAT-AC423, TC-UAT-AC424 | ✅ |
| COV-FR-DOC-15 | AC/Requirement | FR-DOC-15: Chi tiết và phiên bản mẫu | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-15, TC-UAT-AC423, TC-UAT-AC424 | ✅ |
| COV-FR-DOC-16 | AC/Requirement | FR-DOC-16: Thể thức và bố cục theo Phụ lục I NĐ 30/2020 | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-16, TC-UAT-AC415, TC-UAT-AC416 | ✅ |
| COV-FR-DOC-17 | AC/Requirement | FR-DOC-17: Hồ sơ và lưu trữ | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-17, TC-UAT-AC421, TC-UAT-AC422 | ✅ |
| COV-FR-DOC-18 | AC/Requirement | FR-DOC-18: Quy tắc bảo quản tài liệu | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-18, TC-UAT-AC421, TC-UAT-AC422 | ✅ |
| COV-FR-DOC-19 | AC/Requirement | FR-DOC-19: Thu hồi, thay thế và đính chính | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-19, TC-UAT-AC411, TC-UAT-AC412 | ✅ |
| COV-FR-DOC-20 | AC/Requirement | FR-DOC-20: Liên thông văn bản qua LGSP | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-20, TC-UAT-AC425 | ✅ |
| COV-FR-DOC-21 | AC/Requirement | FR-DOC-21: Cấu hình sổ cấp số và loại văn bản | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-21, TC-UAT-AC402 | ✅ |
| COV-FR-DOC-22 | AC/Requirement | FR-DOC-22: Duyệt và ký văn bản (di động) | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-22, TC-UAT-AC426 | ✅ |
| COV-FR-DOC-23 | AC/Requirement | FR-DOC-23: Văn bản đến cần xử lý (di động) | traceability.json / nonfunctional_requirements.json | TC-UI-DOC-23, TC-UAT-AC420 | ✅ |

## Tổng

- Coverage item: 23, mỗi item có ít nhất một TC (23/23).
- TC: 56 (hợp đồng màn hình 23, nghiệp vụ và phi chức năng 33).
