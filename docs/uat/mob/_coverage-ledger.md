# Sổ phủ — phân hệ MOB

M2=0 · FP=0 · risk=STANDARD

> **Phạm vi:** 88 ca thiết kế của phân hệ MOB (`test_cases.json`), chuyển nguyên văn sang hợp đồng handoff bằng bộ quy tắc cố định. Mức rủi ro STANDARD do chức năng của phân hệ
> (tiền, cách ly tenant, danh tính: CRITICAL; dữ liệu nền và hồ sơ: HIGH; còn lại STANDARD/LOW). M2 (độ phức tạp chu trình) và FP (điểm chức năng) chưa đo: khai 0 để máy ghi nhận là KHÔNG ĐO.
> Sàn `TC_min` theo mức rủi ro là báo động "chưa đào đủ sâu" chứ không phải lý do để độn ca: ca thiết kế chưa phủ các phân vùng giá trị, biên, bảng quyết định và đường chuyển trạng thái sai thì thiếu hụt đó được ghi ở `docs/uat/INDEX.md`.

## Bảng coverage item

| cov_id | Kỹ thuật | Coverage item | Nguồn | TC phủ | Trạng thái |
|---|---|---|---|---|---|
| COV-FR-MOB-01 | AC/Requirement | FR-MOB-01: Chào mừng và nhận diện tenant | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-01 | ✅ |
| COV-FR-MOB-02 | AC/Requirement | FR-MOB-02: Đăng nhập SSO | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-02 | ✅ |
| COV-FR-MOB-03 | AC/Requirement | FR-MOB-03: Xác thực MFA | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-03 | ✅ |
| COV-FR-MOB-04 | AC/Requirement | FR-MOB-04: Chọn đơn vị và vai trò | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-04 | ✅ |
| COV-FR-MOB-05 | AC/Requirement | FR-MOB-05: Xin quyền thông báo | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-05 | ✅ |
| COV-FR-MOB-06 | AC/Requirement | FR-MOB-06: Xin quyền camera và vị trí | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-06 | ✅ |
| COV-FR-MOB-07 | AC/Requirement | FR-MOB-07: Trang chủ lãnh đạo | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-07 | ✅ |
| COV-FR-MOB-08 | AC/Requirement | FR-MOB-08: Trang chủ cán bộ | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-08 | ✅ |
| COV-FR-MOB-09 | AC/Requirement | FR-MOB-09: Danh sách dự án | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-09, TC-UAT-AC500 | ✅ |
| COV-FR-MOB-10 | AC/Requirement | FR-MOB-10: Chi tiết dự án | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-10 | ✅ |
| COV-FR-MOB-11 | AC/Requirement | FR-MOB-11: Bản đồ hiện trường | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-11 | ✅ |
| COV-FR-MOB-12 | AC/Requirement | FR-MOB-12: Kế hoạch vốn | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-12 | ✅ |
| COV-FR-MOB-13 | AC/Requirement | FR-MOB-13: Chọn kỳ báo cáo | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-13 | ✅ |
| COV-FR-MOB-14 | AC/Requirement | FR-MOB-14: Nhập khối lượng | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-14 | ✅ |
| COV-FR-MOB-15 | AC/Requirement | FR-MOB-15: Nhập vốn năm | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-15 | ✅ |
| COV-FR-MOB-16 | AC/Requirement | FR-MOB-16: Nhập vốn kéo dài | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-16 | ✅ |
| COV-FR-MOB-17 | AC/Requirement | FR-MOB-17: Nhập vốn khác | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-17 | ✅ |
| COV-FR-MOB-18 | AC/Requirement | FR-MOB-18: Đăng ký tháng sau | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-18 | ✅ |
| COV-FR-MOB-19 | AC/Requirement | FR-MOB-19: Đính kèm chứng từ | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-19, TC-UAT-AC506, TC-UAT-PLAN-34 | ✅ |
| COV-FR-MOB-20 | AC/Requirement | FR-MOB-20: Rà soát báo cáo | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-20, TC-UAT-AC502, TC-UAT-AC503, TC-UAT-AC507 | ✅ |
| COV-FR-MOB-21 | AC/Requirement | FR-MOB-21: Gửi báo cáo thành công | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-21, TC-UAT-PLAN-35 | ✅ |
| COV-FR-MOB-22 | AC/Requirement | FR-MOB-22: Danh sách nháp | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-22 | ✅ |
| COV-FR-MOB-23 | AC/Requirement | FR-MOB-23: Danh sách phê duyệt | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-23 | ✅ |
| COV-FR-MOB-24 | AC/Requirement | FR-MOB-24: Chi tiết phê duyệt | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-24, TC-UAT-PLAN-36 | ✅ |
| COV-FR-MOB-25 | AC/Requirement | FR-MOB-25: Xác nhận phê duyệt và ký | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-25 | ✅ |
| COV-FR-MOB-26 | AC/Requirement | FR-MOB-26: Trả lại bổ sung | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-26 | ✅ |
| COV-FR-MOB-27 | AC/Requirement | FR-MOB-27: Theo dõi thanh toán | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-27, TC-UAT-PLAN-40 | ✅ |
| COV-FR-MOB-28 | AC/Requirement | FR-MOB-28: Ghi nhận vướng mắc | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-28 | ✅ |
| COV-FR-MOB-29 | AC/Requirement | FR-MOB-29: Chụp ảnh và chú thích | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-29, TC-UAT-PLAN-38 | ✅ |
| COV-FR-MOB-30 | AC/Requirement | FR-MOB-30: Định vị và kiểm tra hiện trường | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-30 | ✅ |
| COV-FR-MOB-31 | AC/Requirement | FR-MOB-31: Chi tiết vướng mắc | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-31, TC-UAT-PLAN-37 | ✅ |
| COV-FR-MOB-32 | AC/Requirement | FR-MOB-32: Hộp thông báo | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-32 | ✅ |
| COV-FR-MOB-33 | AC/Requirement | FR-MOB-33: Chi tiết thông báo | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-33 | ✅ |
| COV-FR-MOB-34 | AC/Requirement | FR-MOB-34: Cài đặt thông báo | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-34 | ✅ |
| COV-FR-MOB-35 | AC/Requirement | FR-MOB-35: Hộp hội thoại | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-35 | ✅ |
| COV-FR-MOB-36 | AC/Requirement | FR-MOB-36: Trao đổi theo hồ sơ | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-36 | ✅ |
| COV-FR-MOB-37 | AC/Requirement | FR-MOB-37: AI hỏi đáp có nguồn | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-37 | ✅ |
| COV-FR-MOB-38 | AC/Requirement | FR-MOB-38: Tóm tắt phân tích nhà thầu | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-38, TC-UAT-PLAN-42 | ✅ |
| COV-FR-MOB-39 | AC/Requirement | FR-MOB-39: Xem dẫn chứng gốc | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-39, TC-UAT-PLAN-43 | ✅ |
| COV-FR-MOB-40 | AC/Requirement | FR-MOB-40: Dashboard BI cá nhân | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-40 | ✅ |
| COV-FR-MOB-41 | AC/Requirement | FR-MOB-41: Danh sách đồng bộ | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-41, TC-UAT-AC500, TC-UAT-AC501, TC-UAT-AC502, TC-UAT-AC507 | ✅ |
| COV-FR-MOB-42 | AC/Requirement | FR-MOB-42: Xử lý xung đột | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-42, TC-UAT-AC504 | ✅ |
| COV-FR-MOB-43 | AC/Requirement | FR-MOB-43: Mất kết nối | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-43 | ✅ |
| COV-FR-MOB-44 | AC/Requirement | FR-MOB-44: Hết phiên | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-44 | ✅ |
| COV-FR-MOB-45 | AC/Requirement | FR-MOB-45: Không đủ quyền | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-45, TC-UAT-AC501, TC-UAT-PLAN-32 | ✅ |
| COV-FR-MOB-46 | AC/Requirement | FR-MOB-46: License hết hạn | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-46 | ✅ |
| COV-FR-MOB-47 | AC/Requirement | FR-MOB-47: Tài khoản và sinh trắc học | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-47, TC-UAT-PLAN-33 | ✅ |
| COV-FR-MOB-48 | AC/Requirement | FR-MOB-48: Đổi tenant | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-48, TC-UAT-AC505 | ✅ |
| COV-FR-MOB-49 | AC/Requirement | FR-MOB-49: Thiết bị và đăng xuất | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-49 | ✅ |
| COV-FR-MOB-50 | AC/Requirement | FR-MOB-50: Trợ giúp và phản hồi | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-50 | ✅ |
| COV-FR-MOB-51 | AC/Requirement | FR-MOB-51: Tìm kiếm trên điện thoại | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-51, TC-UAT-PLAN-41 | ✅ |
| COV-FR-MOB-52 | AC/Requirement | FR-MOB-52: Trống không có dữ liệu | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-52 | ✅ |
| COV-FR-MOB-53 | AC/Requirement | FR-MOB-53: Lỗi dịch vụ và thử lại | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-53 | ✅ |
| COV-FR-MOB-54 | AC/Requirement | FR-MOB-54: Bảo trì và cập nhật bắt buộc | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-54 | ✅ |
| COV-FR-MOB-55 | AC/Requirement | FR-MOB-55: Thuyết minh tháng | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-55 | ✅ |
| COV-FR-MOB-56 | AC/Requirement | FR-MOB-56: Ước giải ngân cuối kỳ | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-56 | ✅ |
| COV-FR-MOB-57 | AC/Requirement | FR-MOB-57: Dự án chưa nộp báo cáo | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-57 | ✅ |
| COV-FR-MOB-58 | AC/Requirement | FR-MOB-58: Cơ cấu nguồn vốn | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-58 | ✅ |
| COV-FR-MOB-59 | AC/Requirement | FR-MOB-59: Vướng mắc theo tuần | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-59 | ✅ |
| COV-FR-MOB-60 | AC/Requirement | FR-MOB-60: Đối soát Kho bạc trên điện thoại | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-60 | ✅ |
| COV-FR-MOB-61 | AC/Requirement | FR-MOB-61: Hợp đồng và mốc hiện trường | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-61 | ✅ |
| COV-FR-MOB-62 | AC/Requirement | FR-MOB-62: Nhật ký công trường trên điện thoại | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-62 | ✅ |
| COV-FR-MOB-63 | AC/Requirement | FR-MOB-63: Ghi nhận khối lượng và bằng chứng | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-63 | ✅ |
| COV-FR-MOB-64 | AC/Requirement | FR-MOB-64: Kiểm tra chất lượng hiện trường | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-64 | ✅ |
| COV-FR-MOB-65 | AC/Requirement | FR-MOB-65: Duyệt nghiệm thu trên điện thoại | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-65, TC-UAT-PLAN-36 | ✅ |
| COV-FR-MOB-66 | AC/Requirement | FR-MOB-66: Bàn giao và bảo hành trên điện thoại | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-66 | ✅ |
| COV-FR-MOB-67 | AC/Requirement | FR-MOB-67: Văn bản chờ ký | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-67 | ✅ |
| COV-FR-MOB-68 | AC/Requirement | FR-MOB-68: Nhiệm vụ GPMB hiện trường | traceability.json / nonfunctional_requirements.json | TC-UI-MOB-68, TC-UAT-PLAN-39 | ✅ |

## Tổng

- Coverage item: 68, mỗi item có ít nhất một TC (68/68).
- TC: 88 (hợp đồng màn hình 68, nghiệp vụ và phi chức năng 20).
