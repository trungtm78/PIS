# HPM — Đẩy báo cáo lên HPM (chỉ bản doanh nghiệp)

Đặc tả phân hệ của lane ENT-2 theo `_KHUNG_DAC_TA.md`. HPM là nền tảng báo cáo của khách hàng; giao diện kỹ thuật của HPM chưa được cung cấp nên mọi thứ dựng trên nó là giả định, ghi **PENDING-EXTERNAL** (eng-review R18) và không được nghiệm thu khi chưa có thông tin kỹ thuật chính thức và xác nhận của bên nhận. Phân hệ chỉ tồn tại trong bản doanh nghiệp: mã nằm ở `packages/edition-enterprise`, `apps/api/src/editions/enterprise`, `apps/web/src/editions/enterprise`; bản công khai từ chối mã phân hệ `HPM` ở bản kê của bản (`ENTERPRISE_ONLY_MODULES`).

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Báo cáo đã phát hành (RPT-1) phải đến nơi nhận là HPM, đúng một lần cho mỗi kỳ và phiên bản, không gửi trùng khi thử lại sau lỗi, không gửi bản cũ hơn bản nơi nhận đã nhận, và không ghi đè một kỳ đã được nhận nếu không có lý do được duyệt.

**Trong phạm vi.** Cổng `HpmPort` với bộ ghi tệp thay HPM (không bao giờ gọi mạng); nhật ký đẩy theo khóa chống trùng (tổ chức, mẫu, kỳ, phiên bản báo cáo) có băm yêu cầu, phản hồi và số lần thử; đẩy lại với đúng khóa cũ; biên nhận của nơi nhận do người khác người đẩy ghi; đính chính cho phép thay một kỳ đã được nhận (kỳ mở lại và đính chính được duyệt); kết nối `hpm.reports` có độ mới và cảnh báo.

**Ngoài phạm vi.** Gọi API của HPM (chờ khách hàng cung cấp giao diện); dựng báo cáo (RPT-1); mở lại kỳ (DIS).

**Phụ thuộc.** RPT-1 (bản phát hành, nhật ký giao nhận `report_delivery`, kênh `HPM_PUSH`); DIS (`period_reopen`); ADM (sổ đăng ký kết nối, ADM-11 kiểm toán, quy tắc quản trị); trung tâm cảnh báo (nguồn `CONNECTOR`).

**Căn cứ.** Kế hoạch ENT-2; eng-review R8 (khóa chống trùng), R17 (phiên bản và dòng dõi), R18 (PENDING-EXTERNAL).

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Quản trị tích hợp | TENANT | `hpm.admin` bật/tắt kết nối kèm lý do | Đẩy hộ người khác |
| Người đẩy báo cáo | TENANT | `hpm.push` đẩy, đẩy lại | Ghi biên nhận của lần đẩy mình làm |
| Người ghi biên nhận | TENANT | `hpm.receipt` | Ghi biên nhận cho bản mẫu DEMO là đã nhận |
| Người đề nghị đính chính | TENANT | `hpm.correction.propose` | Tự duyệt |
| Người duyệt đính chính | TENANT | `hpm.correction.decide` | Duyệt đề nghị của mình |
| Người đọc | TENANT | `hpm.read` | Ghi |

Mọi lệnh đòi quyền trên toàn tenant: báo cáo không thuộc một đơn vị.

## 3. Luồng nghiệp vụ

### 3.1 Đẩy một báo cáo (UC-HPM-01) — HPM-01
1. `submitHpmPush` nêu `issue_id` của bản phát hành RPT-1 (hoặc tệp trong kho đối tượng); tệp, ảnh chụp và dấu của mẫu lấy từ bản phát hành; mẫu, kỳ, phiên bản, băm phải khớp bản phát hành.
2. Khóa = tổ chức, mẫu, kỳ, phiên bản. Khóa đã có với nội dung khác: 409 `HPM_KEY_REUSED`; bản cũ hơn bản mới nhất hoặc bản nơi nhận đã nhận: 409 `REPORT_OUT_OF_DATE`; trùng nội dung: `ALREADY_DELIVERED`.
3. Bộ ghi tệp ghi gói (bản kê, báo cáo) và trả vị trí và băm; lỗi ghi được ghi lại là lần thử `FAILED`, không làm lệnh thất bại.
4. `retryHpmPush` gửi lại đúng khóa cũ với số lần thử kế tiếp, tới mức `max_attempts` của quy tắc `HPM_PUSH_POLICY`.
5. `recordHpmReceipt` do người khác ghi: `ACCEPTED` hoặc `REJECTED` (bắt buộc ghi chú); bản DEMO không bao giờ được ghi là đã nhận (`TEMPLATE_UNCONFIRMED`).

### 3.2 Ghi đè một kỳ đã được nhận (UC-HPM-02) — HPM-02
1. `proposeHpmCorrection` nêu kỳ, phiên bản đã nhận, yêu cầu mở lại kỳ của DIS đang có hiệu lực và lý do.
2. `decideHpmCorrection` do người khác duyệt; duyệt cần kỳ vẫn đang mở.
3. Lần đẩy phiên bản mới dùng đính chính một lần; thiếu một trong hai điều kiện: 409 `HPM_OVERWRITE_NOT_AUTHORISED` nêu điều còn thiếu. Mọi bước ghi ADM-11.

## 4. State machine

```
Push: PENDING -> WRITTEN | FAILED ; FAILED -> WRITTEN | FAILED ; WRITTEN -> ACCEPTED | REJECTED | FAILED(gửi lại) ; ACCEPTED, REJECTED cuối
Correction: PROPOSED -> APPROVED | REJECTED ; APPROVED -> CONSUMED
```

## 5. Quy tắc nghiệp vụ và công thức

Quyết định đẩy (`decideHpmPush`): khóa lạ; băm khác thì từ chối; bản đã bị thay thì `REPORT_OUT_OF_DATE`; bản đã ghi hoặc đã nhận thì `ALREADY_DELIVERED`; đã hết lần thử thì `HPM_RETRY_EXHAUSTED`; thay kỳ đã nhận cần kỳ mở lại và đính chính được duyệt. Độ mới = bây giờ trừ lần giao gần nhất; `FRESH` đến `warn_after_hours`, `AGING` đến `max_age_hours`, `STALE` sau đó. Số liệu quy tắc `HPM_PUSH_POLICY` (5 lần, 720 giờ, 1080 giờ) là mặc định chưa kiểm chứng, có công thức, nguồn, ngày chốt.

## 6. Dữ liệu

`ent_connection`, `ent_connection_event` (V2240); `hpm_push`, `hpm_push_attempt` (V2241, khóa duy nhất theo tenant và khóa, thử chỉ thêm); `hpm_correction` (V2242). RLS bắt buộc và ép buộc, mọi cột `*_id` có chỉ mục dẫn đầu bằng `tenant_id`, trigger giữ bất biến và đường chuyển trạng thái, ràng buộc người ghi biên nhận khác người đẩy.

## 7. API / command

`getHpmConnection`, `setHpmConnectionState`, `listHpmPushes`, `submitHpmPush`, `retryHpmPush`, `recordHpmReceipt`, `listHpmCorrections`, `proposeHpmCorrection`, `decideHpmCorrection`. Mọi lệnh idempotent theo `Idempotency-Key`, lệnh theo phiên bản dùng `If-Match`. Mã lỗi: `HPM_OVERWRITE_NOT_AUTHORISED`, `HPM_CONNECTION_DISABLED`, `HPM_KEY_REUSED`, `HPM_PUSH_STATE_INVALID`, `HPM_RETRY_EXHAUSTED`, `HPM_CORRECTION_STATE_INVALID`, cùng `REPORT_OUT_OF_DATE`.

## 8. UI/UX

HPM-01 (kết nối, độ mới, nhật ký đẩy, đẩy lại, biên nhận, hạng mục chờ bên ngoài) và HPM-02 (đính chính): bộ thành phần chung, bảy trạng thái, mọi con số có công thức, nguồn, thời điểm; dải PENDING-EXTERNAL luôn hiện; thao tác chỉ hiện khi người gọi có quyền và không vi phạm tách quyền.

## 9. Sự kiện, job, tích hợp, quan sát

Sự kiện: `ent.connection.changed.v1`, `hpm.push.sent.v1`, `hpm.push.receipt.recorded.v1`, `hpm.correction.proposed.v1`, `hpm.correction.decided.v1` (chỉ mã, băm, số; không nội dung báo cáo). Cảnh báo `HPM_PUSH_FAILED`, `HPM_PUSH_STALE` ở nguồn `CONNECTOR` (chủ: quản trị tích hợp). Đẩy chỉ ghi tệp, không có lời gọi mạng; telemetry `hpm_push_total`. Mô tả cho Integration Hub nằm ở một tệp `hpm-connection.ts`.

## 10. Kiểm thử

Quy tắc thuần (`hpm-rules.test.ts`, `hpm-port.test.ts`); API với cơ sở dữ liệu thật (`hpm.enterprise.test.ts`): khóa, đẩy lại, bản cũ, ghi đè, biên nhận, bản DEMO, cách ly tenant, không có socket ra ngoài, ràng buộc ở cơ sở dữ liệu; màn hình bằng vitest.

## 11. Tiêu chí nghiệm thu (đo được)

AC-1: đẩy lại sau lỗi cho đúng một dòng nhật ký và hai lần thử cùng khóa. AC-2: bản cũ hơn bản đã nhận bị từ chối `REPORT_OUT_OF_DATE` kèm phiên bản hiện hành. AC-3: ghi đè kỳ đã nhận không có kỳ mở lại và đính chính được duyệt bị từ chối. AC-4: người đẩy không ghi được biên nhận của mình. AC-5: không có kết nối mạng ra ngoài. Hạng mục dựng trên giả định (bộ ghi tệp thay HPM) không được nghiệm thu khi chưa có xác nhận của nơi nhận.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

Tối thiểu: bộ ghi tệp, nhật ký, khóa, đẩy lại, biên nhận. Sâu hóa khi có giao diện HPM: bộ chuyển API thay `HpmPort`, đối chiếu biên nhận tự động, tải gói từ màn hình.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

Giao diện kỹ thuật của HPM (nền tảng, API, cấu trúc dữ liệu): chủ Ban Chuyển đổi số và Công nghệ thông tin; chưa có thì lần đẩy chỉ ghi ra tệp và không được nghiệm thu (PENDING-EXTERNAL). Gói tệp là giả định `HPM-FILE-WORKING-ASSUMPTION-2026.1`. Con số của quy tắc chưa được khách hàng xác nhận.
