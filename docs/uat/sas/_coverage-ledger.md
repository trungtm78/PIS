# Sổ phủ — phân hệ SAS

M2=0 · FP=0 · risk=CRITICAL

> **Phạm vi:** 79 ca thiết kế của phân hệ SAS (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro CRITICAL do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-ADM-03 | AC/Requirement | FR-ADM-03: Vai trò và quyền | traceability.json / nonfunctional_requirements.json | TC-UAT-AC43 | ✅ |
| COV-FR-ADM-12 | AC/Requirement | FR-ADM-12: Chính sách lưu trữ | traceability.json / nonfunctional_requirements.json | TC-UAT-AC39 | ✅ |
| COV-FR-IAM-04 | AC/Requirement | FR-IAM-04: Chọn tổ chức | traceability.json / nonfunctional_requirements.json | TC-UAT-AC153 | ✅ |
| COV-FR-IAM-08 | AC/Requirement | FR-IAM-08: Trợ giúp và yêu cầu hỗ trợ | traceability.json / nonfunctional_requirements.json | TC-UAT-AC38 | ✅ |
| COV-FR-SAS-01 | AC/Requirement | FR-SAS-01: Danh sách tenant | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-01, TC-UAT-AC174 | ✅ |
| COV-FR-SAS-02 | AC/Requirement | FR-SAS-02: Khởi tạo tenant | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-02, TC-UAT-AC145, TC-UAT-AC146, TC-UAT-AC147 | ✅ |
| COV-FR-SAS-03 | AC/Requirement | FR-SAS-03: Chi tiết tenant | traceability.json / nonfunctional_requirements.json | TC-UAT-AC37, TC-UI-SAS-03, TC-UAT-AC148, TC-UAT-AC149 | ✅ |
| COV-FR-SAS-04 | AC/Requirement | FR-SAS-04: Theme & thương hiệu tenant | traceability.json / nonfunctional_requirements.json | TC-SEC02, TC-SEC03, TC-SEC04, TC-TH01, TC-TH02, TC-TH03, TC-TH04, TC-TH05, TC-UI-SAS-04, TC-UAT-AC175, TC-UAT-PLAN-14 | ✅ |
| COV-FR-SAS-05 | AC/Requirement | FR-SAS-05: Tên miền và xác minh | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-05, TC-UAT-AC152, TC-UAT-AC153 | ✅ |
| COV-FR-SAS-06 | AC/Requirement | FR-SAS-06: Gói sản phẩm và tính năng | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-06, TC-UAT-AC154 | ✅ |
| COV-FR-SAS-07 | AC/Requirement | FR-SAS-07: Đăng ký và dùng thử | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-07 | ✅ |
| COV-FR-SAS-08 | AC/Requirement | FR-SAS-08: Nâng hạ gói | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-08, TC-UAT-AC155, TC-UAT-AC156 | ✅ |
| COV-FR-SAS-09 | AC/Requirement | FR-SAS-09: Thuê bao và kỳ thanh toán | traceability.json / nonfunctional_requirements.json | TC-UAT-AC37, TC-UI-SAS-09, TC-UAT-AC163 | ✅ |
| COV-FR-SAS-10 | AC/Requirement | FR-SAS-10: Hóa đơn và đối soát | traceability.json / nonfunctional_requirements.json | TC-UAT-AC36, TC-UI-SAS-10, TC-UAT-AC163, TC-UAT-AC164, TC-UAT-AC166, TC-UAT-AC167, TC-UAT-PLAN-48 | ✅ |
| COV-FR-SAS-11 | AC/Requirement | FR-SAS-11: Đo mức sử dụng | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-11, TC-UAT-AC156, TC-UAT-AC168 | ✅ |
| COV-FR-SAS-12 | AC/Requirement | FR-SAS-12: Cấp license | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-12, TC-UAT-AC159 | ✅ |
| COV-FR-SAS-13 | AC/Requirement | FR-SAS-13: Chi tiết license | traceability.json / nonfunctional_requirements.json | TC-UAT-AC40, TC-UAT-AC41, TC-UAT-AC42, TC-LIC01, TC-UI-SAS-13, TC-UAT-AC161 | ✅ |
| COV-FR-SAS-14 | AC/Requirement | FR-SAS-14: Gia hạn và thay đổi license | traceability.json / nonfunctional_requirements.json | TC-UAT-AC43, TC-LIC01, TC-UI-SAS-14, TC-UAT-AC160 | ✅ |
| COV-FR-SAS-15 | AC/Requirement | FR-SAS-15: Tạm khóa và thu hồi license | traceability.json / nonfunctional_requirements.json | TC-UAT-AC44, TC-UI-SAS-15, TC-UAT-AC162 | ✅ |
| COV-FR-SAS-16 | AC/Requirement | FR-SAS-16: Lịch sử license | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-16, TC-UAT-AC160 | ✅ |
| COV-FR-SAS-17 | AC/Requirement | FR-SAS-17: Xuất dữ liệu và kết thúc dịch vụ | traceability.json / nonfunctional_requirements.json | TC-UAT-AC39, TC-UI-SAS-17, TC-UAT-AC172 | ✅ |
| COV-FR-SAS-18 | AC/Requirement | FR-SAS-18: Sức khỏe toàn nền tảng | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-18, TC-UAT-AC173 | ✅ |
| COV-FR-SAS-19 | AC/Requirement | FR-SAS-19: Hỗ trợ truy cập có kiểm soát | traceability.json / nonfunctional_requirements.json | TC-UAT-AC38, TC-UI-SAS-19, TC-UAT-AC169 | ✅ |
| COV-FR-SAS-20 | AC/Requirement | FR-SAS-20: Cờ tính năng và phát hành | traceability.json / nonfunctional_requirements.json | TC-UI-SAS-20, TC-UAT-AC170 | ✅ |
| COV-FR-SAS-21 | AC/Requirement | FR-SAS-21: Sao lưu và khôi phục tenant | traceability.json / nonfunctional_requirements.json | TC-OPS01, TC-UI-SAS-21, TC-UAT-AC171 | ✅ |
| COV-FR-SAS-22 | AC/Requirement | FR-SAS-22: Tiến trình khởi tạo tenant | traceability.json / nonfunctional_requirements.json | TC-UAT-AC145, TC-UAT-AC146, TC-UI-SAS-22, TC-UAT-PLAN-47 | ✅ |
| COV-FR-SAS-23 | AC/Requirement | FR-SAS-23: Nâng cấp cách ly silo | traceability.json / nonfunctional_requirements.json | TC-UAT-AC150, TC-UAT-AC151, TC-UI-SAS-23 | ✅ |
| COV-FR-SAS-24 | AC/Requirement | FR-SAS-24: Hóa đơn điều chỉnh/thay thế | traceability.json / nonfunctional_requirements.json | TC-UAT-AC165, TC-UI-SAS-24 | ✅ |
| COV-FR-SAS-25 | AC/Requirement | FR-SAS-25: Quyền lợi hiệu lực và ghi đè | traceability.json / nonfunctional_requirements.json | TC-UAT-AC41, TC-UAT-AC157, TC-UAT-AC158, TC-UI-SAS-25, TC-UAT-PLAN-46 | ✅ |
| COV-NFR-AVAILABILITY-02 | ISO 25010 · availability | NFR-AVAILABILITY-02: RPO và RTO | traceability.json / nonfunctional_requirements.json | TC-OPS01 | ✅ |
| COV-NFR-AVAILABILITY-03 | ISO 25010 · availability | NFR-AVAILABILITY-03: Diễn tập khôi phục định kỳ và khôi phục một tenant | traceability.json / nonfunctional_requirements.json | TC-OPS01 | ✅ |
| COV-NFR-SECURITY-01 | ISO 25010 · security | NFR-SECURITY-01: Chống tự nâng quyền | traceability.json / nonfunctional_requirements.json | TC-SEC02 | ✅ |
| COV-NFR-SECURITY-02 | ISO 25010 · security | NFR-SECURITY-02: Control plane System Admin tách biệt | traceability.json / nonfunctional_requirements.json | TC-SEC02, TC-SEC03, TC-SEC04 | ✅ |
| COV-NFR-SECURITY-05 | ISO 25010 · security | NFR-SECURITY-05: Khóa lạc quan bằng If-Match | traceability.json / nonfunctional_requirements.json | TC-TH03 | ✅ |
| COV-NFR-SECURITY-11 | ISO 25010 · security | NFR-SECURITY-11: Audit bất biến | traceability.json / nonfunctional_requirements.json | TC-TH02 | ✅ |
| COV-NFR-SECURITY-12 | ISO 25010 · security | NFR-SECURITY-12: Kiểm tra tệp tải lên | traceability.json / nonfunctional_requirements.json | TC-TH04 | ✅ |
| COV-NFR-TENANCY-01 | ISO 25010 · tenancy | NFR-TENANCY-01: Cách ly tenant ở API (object-level) | traceability.json / nonfunctional_requirements.json | TC-TH01 | ✅ |
| COV-NFR-TENANCY-03 | ISO 25010 · tenancy | NFR-TENANCY-03: Cách ly tenant ở cache | traceability.json / nonfunctional_requirements.json | TC-TH05 | ✅ |

## Tổng

- Coverage item: 38, mỗi item có ít nhất một TC (38/38).
- TC: 79 (hợp đồng màn hình 26, nghiệp vụ và phi chức năng 53).
