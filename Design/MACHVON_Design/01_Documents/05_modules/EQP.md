# EQP — Mua sắm trang thiết bị của dự án (chỉ bản doanh nghiệp)

Đặc tả phân hệ của lane ENT-4e (HSKT CN.02: theo dõi mua sắm trang thiết bị của dự án từ kế hoạch, kết quả lựa chọn nhà thầu, hợp đồng đến giải ngân; kế hoạch ENT-3 khoảng trống G12; quyết định R21: một đường đọc). Mã nằm ở `packages/kernel/src/equipment-procurement.ts`, `packages/db/src/equipment-procurement-store.ts`, `apps/api/src/editions/enterprise/equipment.controller.ts`, `apps/web/src/editions/enterprise/screens/eqp`; bản công khai từ chối mã phân hệ `EQP` (`ENTERPRISE_ONLY_MODULES`).

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Ban Thương mại và đơn vị chủ quản dự án cần thấy, cho từng dòng kế hoạch được mua dưới dạng thiết bị, dòng ấy đang ở đâu: đã có gói thầu chưa, kết quả lựa chọn nhà thầu, giá trị hợp đồng, chênh lệch so với kế hoạch, đã giải ngân bao nhiêu, mà không có bản sao thứ hai của số liệu BID, CTR, PAY.

**Trong phạm vi.** Sổ dòng mua sắm thiết bị `equipment_procurement_item` (dự án, đơn vị chủ quản, tên, giá trị kế hoạch, liên kết gói thầu và hợp đồng); mô hình đọc ghép kết quả lựa chọn nhà thầu (`procurement_result`), giá trị hợp đồng đang hiệu lực (`contract_revision`), khoản đã trả (`payment_request` ở trạng thái PAID) và trạng thái nhập tệp e-GP (`procurement_external_link`); khung "Cách lấy dữ liệu".

**Ngoài phạm vi.** Kết nối trực tiếp tới mạng đấu thầu quốc gia (không mở kết nối; định dạng tệp là giả định làm việc, nghiệm thu là PENDING-EXTERNAL); sửa số liệu của BID, CTR, PAY; thiết bị ngoài kế hoạch đầu tư.

**Phụ thuộc.** BID (gói thầu, kết quả), CTR (hợp đồng), PAY (thanh toán), ADM (phạm vi đơn vị). Căn cứ: HSKT PVFCCo v0.3 CN.02; `docs/plans/ent4e.md` quyết định 6.

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Ban Thương mại, đơn vị chủ quản | Cây đơn vị của dự án (`bid.read`) | Xem danh sách và chi tiết | Xem dòng của đơn vị khác |
| Người lập kế hoạch mua sắm | `bid.plan.manage` trong phạm vi đơn vị | Lập dòng, gắn gói thầu và hợp đồng một lần, hủy dòng có lý do | Sửa dòng đã hủy; gắn gói thầu của dự án khác |
| Người đọc thiếu `contract.read` hoặc `payment_request.read` | Như trên | Thấy dòng | Thấy giá trị hợp đồng hoặc khoản đã trả (hiện là bị che, không phải 0) |

Một tenant, RLS theo `tenant_id`; không tạo tenant theo đơn vị.

## 3. Luồng nghiệp vụ

1. Người lập kế hoạch lập dòng (`createEquipmentProcurementItem`) với mã dòng, tên, dự án, giá trị kế hoạch.
2. Khi gói thầu và hợp đồng có, gắn một lần (`updateEquipmentProcurementItem`): gói cùng dự án, hợp đồng thuộc gói.
3. Người đọc xem danh sách (`listEquipmentProcurement`) và chi tiết (`getEquipmentProcurement`); giai đoạn, tỷ lệ giải ngân và chênh lệch được tính khi đọc.
4. Dòng không còn mua thì hủy kèm lý do; dòng đã hủy không đổi nữa.
Màn hình: EQP-01 (danh sách), EQP-02 (chi tiết).

## 4. State machine

Dòng sổ: ACTIVE rồi CANCELLED (cuối cùng). Giai đoạn đọc ra, không lưu: PLANNED, PACKAGED, SELECTED, NO_AWARD, CONTRACTED, DISBURSING, DISBURSED, CANCELLED.

| Từ | Command | Đến | Ai được làm | Guard | Audit/Event |
|---|---|---|---|---|---|
| ACTIVE | `updateEquipmentProcurementItem` (gắn) | ACTIVE | `bid.plan.manage` | Gói cùng dự án; hợp đồng thuộc gói; gắn một lần | Có |
| ACTIVE | `updateEquipmentProcurementItem` (hủy) | CANCELLED | `bid.plan.manage` | Có lý do | Có |
| CANCELLED | bất kỳ | không | không ai | `EQUIPMENT_LINE_STATE_INVALID` (409) | không |

## 5. Quy tắc nghiệp vụ và công thức

- BR-EQP-01: dòng đã hủy là CANCELLED dù có gì khác; chưa có gói là PLANNED; có gói chưa có kết quả được duyệt là PACKAGED; kết quả được duyệt không có nhà thầu đạt hoặc đã hủy là NO_AWARD; kết quả trúng chưa có hợp đồng là SELECTED; có hợp đồng chưa trả là CONTRACTED; trả một phần là DISBURSING; trả đủ giá trị hợp đồng trở lên là DISBURSED.
- BR-EQP-02: tỷ lệ giải ngân = đã trả x 100 / giá trị hợp đồng, một chữ số thập phân, làm tròn lên từ nửa; không có giá trị hợp đồng thì không có tỷ lệ.
- BR-EQP-03: chênh lệch so với kế hoạch = giá trị hợp đồng trừ giá trị kế hoạch (VND nguyên); âm là tiết kiệm, dương là vượt; chưa có hợp đồng thì trống.
- BR-EQP-04: số liệu hợp đồng và thanh toán chỉ hiện khi người đọc có `contract.read` và `payment_request.read` trong phạm vi; ngược lại là null kèm danh sách `masked`, không bao giờ là 0.
- BR-EQP-05: mã dòng duy nhất trong tenant (`EQUIPMENT_LINE_CODE_TAKEN`).

## 6. Dữ liệu

Bảng `equipment_procurement_item` (migration khối 2820, RLS bắt buộc, chỉ mục dẫn đầu bằng `tenant_id`): mã dòng, tên, dự án, đơn vị chủ quản, giá trị kế hoạch (VND nguyên), gói thầu, hợp đồng, trạng thái ACTIVE hoặc CANCELLED, lý do hủy, phiên bản. Phân loại: nội bộ. Không có bảng sao số liệu của BID, CTR, PAY.

## 7. API / command

| operationId | Method path | Quyền | Lỗi | Idempotency | If-Match |
|---|---|---|---|---|---|
| `listEquipmentProcurement` | GET /equipment-procurement | `bid.read` | 403 | không | không |
| `getEquipmentProcurement` | GET /equipment-procurement/{id} | `bid.read` | 404 RESOURCE_NOT_FOUND | không | không |
| `createEquipmentProcurementItem` | POST /equipment-procurement | `bid.plan.manage` | 422 VALIDATION_FAILED, 409 EQUIPMENT_LINE_CODE_TAKEN | có | không |
| `updateEquipmentProcurementItem` | PATCH /equipment-procurement/{id} | `bid.plan.manage` | 409 VERSION_CONFLICT, EQUIPMENT_LINE_STATE_INVALID, EQUIPMENT_LINK_INVALID | có | có |

Không có endpoint ghi chung cho trạng thái, `tenant_id` hay số liệu hợp đồng và thanh toán.

## 8. UI/UX

EQP-01: bảng các dòng, khung "Cách lấy dữ liệu" nêu trạng thái nhập tệp e-GP (chưa nhập, mới, cũ) và các bước tải, nạp thử, áp dụng, gắn gói. EQP-02: chi tiết một dòng, gắn gói thầu và hợp đồng, hủy. Bảy trạng thái chuẩn; số liệu bị che hiện là không có quyền. Tuân thủ bộ thành phần và token chung.

## 9. Sự kiện, job, tích hợp, quan sát

Không có job riêng. Ghi nhật ký cho lập, gắn, hủy. Trạng thái nhập tệp e-GP đọc từ `procurement_external_link` và sức khỏe bộ nối e-GP; không mở kết nối ra ngoài.

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Nội dung |
|---|---|---|---|
| UAT-EQP-ENT4E-1 | UAT | P1 | Giai đoạn, tỷ lệ, che số liệu, liên kết sai, mã trùng, dòng đã hủy |
| UI-EQP-01 | Màn hình | P1 | Trường, 7 trạng thái, quyền thao tác |
| UI-EQP-02 | Màn hình | P1 | Trường, gắn một lần, hủy có lý do |

Kiểm thử thuần ở `packages/kernel/src/equipment-procurement.test.ts`; cách ly tenant và phạm vi đơn vị ở lớp cơ sở dữ liệu và API.

## 11. Tiêu chí nghiệm thu (đo được)

- AC-EQP-01: dòng có hợp đồng 1000 và đã trả 250 (đơn vị VND) hiện DISBURSING và 25.0 phần trăm; người đọc thiếu quyền hợp đồng thấy giá trị bị che, không phải 0 (UAT-EQP-ENT4E-1).
- AC-EQP-02: gắn gói của dự án khác bị 422 `EQUIPMENT_LINK_INVALID`; mã dòng dùng lại bị 409 `EQUIPMENT_LINE_CODE_TAKEN`; dòng đã hủy bị 409 `EQUIPMENT_LINE_STATE_INVALID` (UAT-EQP-ENT4E-1).
- AC-EQP-03: EQP-01 và EQP-02 hiển thị đủ trường và bảy trạng thái (UI-EQP-01, UI-EQP-02).

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

Không thuộc R1 (chỉ bản doanh nghiệp). R3: toàn bộ mục trên. Sâu hóa sau: nạp tệp e-GP thật khi bên ngoài xác nhận định dạng. Hạng mục cần người duyệt: phân quyền (`bid.plan.manage`) và cách ly phạm vi đơn vị.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

- Định dạng tệp e-GP là giả định làm việc; nghiệm thu chờ bên cung cấp (PENDING-EXTERNAL), owner: Ban Thương mại.
- Phạm vi "dòng được mua dưới dạng thiết bị" do kế hoạch đầu tư của từng dự án quyết định; câu hỏi mở cho Ban Kế hoạch đầu tư.
