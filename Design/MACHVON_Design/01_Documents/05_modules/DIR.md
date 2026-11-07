# DIR — Chỉ đạo giao ban đầu tư

Phiên bản đặc tả · 08/11/2026 · Phân hệ **mới** (lộ trình quản trị sâu, làn DIR-1). Yêu cầu khách hàng: **CN.03** và **QT.02** ("theo dõi chỉ đạo giao ban"). Quy ước chung theo `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md`; khung theo `_KHUNG_DAC_TA.md`. Khối migration **DIR-1 = V2120–V2139** (đã dùng V2120, V2121).

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Trong các cuộc giao ban đầu tư, lãnh đạo đưa ra chỉ đạo bằng lời hoặc ghi trong biên bản; sau đó không ai biết chỉ đạo nào giao cho ai, hạn nào, đã làm đến đâu, có bằng chứng hay chưa, và báo cáo kỳ sau không có số liệu về chỉ đạo của kỳ trước. DIR ghi nhận cuộc giao ban, từng chỉ đạo, đơn vị và người thực hiện, hạn, tiến độ, gia hạn có lý do, đóng bằng bằng chứng bởi người khác người ghi, và đưa chỉ đạo vào trung tâm cảnh báo cũng như đầu vào thuyết minh báo cáo kỳ sau.

**Trong phạm vi:** cuộc giao ban (ngày, loại, đơn vị chủ trì, biên bản); chỉ đạo về một dự án hoặc một đơn vị; giao lại; ghi tiến độ kèm tài liệu; đề nghị gia hạn và quyết định; đóng, hủy, mở lại; đồng hồ hạn (nhắc T-3/T-1/T+0, nâng cấp sau 7 ngày quá hạn) làm nguồn `DIRECTIVE` của trung tâm cảnh báo; bảng theo dõi theo trạng thái và đơn vị; số liệu tổng hợp; dữ liệu ô dashboard; `directivesForReport(kỳ)`; màn hình điện thoại chỉ đọc.
**Ngoài phạm vi:** soạn biên bản (DOC), xử lý văn bản đến (DOC), ô dashboard hiển thị trên HOME (làn C, DIR chỉ cấp dữ liệu và component `DirectiveWidget`), ô "dự án vướng thủ tục" (dùng nguồn ISS/PMT/LND, làm sau), ghi chỉ đạo từ điện thoại (vòng sau).
**Phụ thuộc:** ADM (đơn vị, quyền, cây phạm vi), PRJ (dự án, đơn vị chủ quản), DOC (phiên bản tệp: biên bản và bằng chứng), HOME (`work_action`, nguồn cảnh báo `DIRECTIVE`), DIS và MNE (đọc `getDirectivesForReport`), governance (`DIRECTIVE_POLICY`, xem BR-DIR-09).

**Căn cứ.** Yêu cầu khách hàng CN.03, QT.02; thực tiễn các hệ thống theo dõi chỉ đạo của cơ quan nhà nước và ban quản lý dự án (sổ chỉ đạo, quá hạn, gia hạn có người duyệt). Mọi con số ngày/số lần (T-3, T-1, T+0, 7 ngày, 3 lần, 60 ngày) là **giá trị khởi đầu chưa kiểm chứng**, không phải quy định pháp luật: cấu hình được, mọi màn hình ghi rõ.

## 2. Actor, tenant và phạm vi quyền

| Actor | Quyền (x-permission) | Phạm vi | Hành động | Bị cấm |
|---|---|---|---|---|
| Thư ký giao ban / văn phòng lãnh đạo | `directive.meeting.manage`, `directive.manage` | Đơn vị chủ trì, dự án và đơn vị trong cây phạm vi của grant | `createSteeringMeeting`, `attachMeetingMinutes`, `addDirective`, `assignDirective`, `cancelDirective`, `reopenDirective` | Đóng chỉ đạo do chính mình ghi |
| Đơn vị / người thực hiện | `directive.progress` | Đơn vị thực hiện hoặc dự án | `recordDirectiveProgress`, `requestDirectiveExtension` | Tự đóng chỉ đạo giao cho mình; tự duyệt gia hạn mình đề nghị |
| Người đóng (lãnh đạo đơn vị, bên thứ ba) | `directive.close` | Như trên | `closeDirective` (có bằng chứng) | Đóng khi là người ghi chỉ đạo hoặc người thực hiện (`SELF_APPROVAL_DENIED`) |
| Người duyệt gia hạn | `directive.extension.decide` | Như trên | `decideDirectiveExtension` | Duyệt đề nghị do mình lập |
| Người đọc (lãnh đạo, kiểm toán, lập báo cáo) | `directive.read` | Như trên | mọi GET | Mọi command |

Một chỉ đạo nằm trong phạm vi khi đơn vị mà nó nói về, đơn vị thực hiện, hoặc dự án (đơn vị chủ quản, đơn vị đầu tư, hoặc grant gọi tên dự án) nằm trong phạm vi grant mang quyền tương ứng. Một cuộc giao ban nằm trong phạm vi khi đơn vị chủ trì nằm trong phạm vi, hoặc khi người đọc với tới ít nhất một chỉ đạo của nó. Ngoài phạm vi hoặc tenant khác: 404, không phân biệt với không tồn tại.

## 3. Luồng nghiệp vụ

**F1 — Ghi nhận cuộc giao ban (DIR-01).** `createSteeringMeeting {meeting_date, meeting_type, title, summary?, unit_id, minutes_document_version_id?}`: ngày không ở tương lai (422 `VALIDATION_FAILED` `meeting_date`); đơn vị chủ trì thuộc phạm vi (403 `SCOPE_DENIED`); biên bản là phiên bản tệp của tenant, không nhiễm mã độc (422 `DECISION_DOCUMENT_REQUIRED`). Mã `GB-<năm>-<số>` đánh theo năm dưới khóa tư vấn của tenant và năm, nên hai người cùng ghi không trùng mã. `attachMeetingMinutes` (If-Match) gắn hoặc thay biên bản.

**F2 — Giao chỉ đạo (DIR-02).** `addDirective {scope_kind: PROJECT|UNIT, project_id|unit_id, text, assignee_unit_id, assignee_membership_id?, due_on}` trong một cuộc giao ban: đúng một trong dự án hoặc đơn vị; hạn không trước ngày họp; dự án và đơn vị thuộc phạm vi (403 `SCOPE_DENIED`). Đơn vị "nói về" của chỉ đạo dự án là đơn vị chủ quản của dự án tại thời điểm giao. Mã `<mã cuộc họp>/CD-<số>`. Ghi sự kiện `CREATED`. Nội dung chỉ đạo không sửa được (trigger).

**F3 — Thực hiện (DIR-04).** `recordDirectiveProgress` (ghi chú bắt buộc, phần trăm, tài liệu) — ghi chú đầu tiên đưa OPEN sang IN_PROGRESS. `assignDirective` (If-Match) giao lại cho đơn vị/người khác, ghi người cũ và người mới. Không bắt If-Match cho ghi tiến độ và đề nghị gia hạn (nhiều người ghi đồng thời); mỗi lệnh vẫn tăng version của chỉ đạo.

**F4 — Gia hạn (DIR-04).** `requestDirectiveExtension {proposed_due_on, reason}`: hạn đề nghị sau hạn hiện tại và không quá `max_extension_days` ngày một lần (422 `DIRECTIVE_EXTENSION_INVALID`), chưa dùng hết `max_extensions` lần (422 `DIRECTIVE_EXTENSION_LIMIT`), mỗi chỉ đạo một đề nghị mở (409 `DIRECTIVE_EXTENSION_PENDING`). `decideDirectiveExtension {decision: approve|reject, reason}` với If-Match là version của đề nghị: người quyết định khác người đề nghị (403 `SELF_APPROVAL_DENIED`); duyệt thì dời `due_on`, tăng `extension_count`, giữ `original_due_on`; từ chối giữ nguyên hạn.

**F5 — Đóng, hủy, mở lại (DIR-04).** `closeDirective {note, evidence_document_version_ids?}`: người đóng khác người ghi chỉ đạo và khác người thực hiện (403 `SELF_APPROVAL_DENIED`); cần ít nhất một bằng chứng (đã có hoặc gửi kèm) khi chính sách yêu cầu (422 `DIRECTIVE_EVIDENCE_REQUIRED`); không có đề nghị gia hạn đang mở (409 `DIRECTIVE_EXTENSION_PENDING`). `cancelDirective {reason}` tương tự về đề nghị đang mở. `reopenDirective {reason}`: DONE → IN_PROGRESS, CANCELLED → OPEN, xóa người đóng. Mọi lệnh có If-Match.

**F6 — Cảnh báo (HOME).** Nguồn `DIRECTIVE` của trung tâm cảnh báo: xem mục 9.

**F7 — Báo cáo kỳ (DIR-05).** `getDirectivesForReport {from, to, project_id?, unit_id?}` trả số theo trạng thái cuối kỳ và danh sách; DIS và MNE đưa vào đầu vào thuyết minh báo cáo kỳ sau; công thức ở BR-DIR-07.

Đồng thời: hai người ghi cùng lúc vào một cuộc giao ban nhận số thứ tự khác nhau nhờ khóa dòng cuộc họp; hai người đóng cùng một chỉ đạo — người sau nhận 409 `VERSION_CONFLICT` hoặc `DIRECTIVE_STATE_INVALID`.

## 4. State machine

```
OPEN ─progress─► IN_PROGRESS ─close─► DONE ─reopen─► IN_PROGRESS
  │                  │                  
  └────cancel────────┴─► CANCELLED ─reopen─► OPEN          (OVERDUE không lưu: OPEN/IN_PROGRESS mà due_on < hôm nay)
```

| Từ | Command | Đến | Ai | Guard | Audit / Event |
|---|---|---|---|---|---|
| OPEN, IN_PROGRESS | `assignDirective` | (giữ) | `directive.manage` | If-Match; có thay đổi | `directive.assigned.v1` |
| OPEN | `recordDirectiveProgress` | IN_PROGRESS | `directive.progress` | ghi chú; tài liệu hợp lệ | `directive.progress_recorded.v1` |
| IN_PROGRESS | `recordDirectiveProgress` | IN_PROGRESS | `directive.progress` | như trên | như trên |
| OPEN, IN_PROGRESS | `requestDirectiveExtension` | (giữ) | `directive.progress` | BR-DIR-05 | `directive.extension_requested.v1` |
| OPEN, IN_PROGRESS | `decideDirectiveExtension` | (giữ) | `directive.extension.decide` ≠ người đề nghị | If-Match của đề nghị | `directive.extension_decided.v1` |
| OPEN, IN_PROGRESS | `closeDirective` | DONE | `directive.close` ≠ người ghi ≠ người thực hiện | bằng chứng; không có đề nghị mở | `directive.closed.v1` |
| OPEN, IN_PROGRESS | `cancelDirective` | CANCELLED | `directive.manage` | không có đề nghị mở | `directive.cancelled.v1` |
| DONE | `reopenDirective` | IN_PROGRESS | `directive.manage` | If-Match | `directive.reopened.v1` |
| CANCELLED | `reopenDirective` | OPEN | `directive.manage` | If-Match | như trên |

Chuyển trạng thái khác: 409 `DIRECTIVE_STATE_INVALID` (kèm `status`, `move`).

## 5. Quy tắc nghiệp vụ và công thức

- **BR-DIR-01.** Mã cuộc họp `GB-<năm họp>-<số 3 chữ số>` duy nhất theo (tenant, năm); mã chỉ đạo `<mã họp>/CD-<số 2 chữ số>` duy nhất theo cuộc họp.
- **BR-DIR-02.** Trạng thái lưu: OPEN, IN_PROGRESS, DONE, CANCELLED. Người đọc thấy thêm OVERDUE = trạng thái lưu OPEN hoặc IN_PROGRESS và `due_on` < ngày hôm nay (giờ Việt Nam). Không có job giữ OVERDUE nên không thể sai.
- **BR-DIR-03.** Người đóng ≠ người ghi (`created_by`) và ≠ người thực hiện (`assignee_membership_id`); ràng buộc cũng nằm ở DB (`directive_closer_chk`). Người duyệt gia hạn ≠ người đề nghị (`directive_extension_maker_checker_chk`).
- **BR-DIR-04 (đồng đồng hồ).** `daysToDue = due_on − hôm nay`. Giai đoạn: `DUE_LATER` nếu `daysToDue > max(reminder_days_before)`; `DUE_SOON` nếu `0 < daysToDue ≤ max`; `DUE_TODAY` nếu `daysToDue = 0`; `OVERDUE` nếu quá hạn dưới `escalate_after_overdue_days`; `ESCALATED` từ `escalate_after_overdue_days` ngày quá hạn. Ngày nhắc là đúng các ngày trong `reminder_days_before` (mặc định T-3, T-1, T+0). Chỉ đạo đã đóng hoặc hủy không có đồng hồ. Nguồn: bảng `directive`; thời điểm: ngày đọc.
- **BR-DIR-05.** Gia hạn: `proposed_due_on > due_on` và `proposed_due_on − due_on ≤ max_extension_days`; `extension_count < max_extensions`; kiểm tra lại khi duyệt. `original_due_on` không đổi; `due_on ≥ original_due_on` (CHECK).
- **BR-DIR-06.** Đóng cần `evidence_count(đã có + gửi kèm, không trùng) ≥ 1` khi `close_requires_evidence`. Bằng chứng là phiên bản tệp của tenant không nhiễm mã độc; bảng bằng chứng chỉ thêm.
- **BR-DIR-07 (chỉ đạo của kỳ).** Với kỳ `[from, to]`: một chỉ đạo thuộc kỳ nếu đã tồn tại đến cuối ngày `to` (ngày họp ≤ `to`) và không kết thúc trước `from` mà không có sự kiện trong kỳ. Trạng thái cuối kỳ dựng lại từ dòng thời gian (sự kiện PROGRESS, EXTENSION_APPROVED, CLOSED, CANCELLED, REOPENED có ngày ≤ `to`), hạn cuối kỳ gồm gia hạn đã duyệt đến hết `to`. Quá hạn cuối kỳ = chưa đóng/hủy và hạn ≤ `to` (hết ngày `to` mà chưa xong). `raised` = ngày họp trong kỳ; `closed` = có sự kiện CLOSED trong kỳ; `extended` = có EXTENSION_APPROVED trong kỳ; `open_at_end` = OPEN hoặc IN_PROGRESS cuối kỳ. Mỗi chỉ đạo của kỳ nằm đúng một trạng thái nên tổng `by_status` = `total` = số dòng danh sách. Đọc tối đa 5.000 chỉ đạo; vượt thì `truncated: true`.
- **BR-DIR-08.** Phạm vi đọc và ghi theo mục 2; danh sách lọc theo phạm vi trước phân trang; con trỏ là vị trí (đang quá hạn, hạn, id) của dòng cuối.
- **BR-DIR-09 (chính sách là dữ liệu).** Ngưỡng nằm trong `DIRECTIVE_POLICY` (mã `DEFAULT`): `reminder_days_before [3,1,0]`, `escalate_after_overdue_days 7`, `max_extensions 3`, `max_extension_days 60`, `close_requires_evidence true`. Đọc qua `DirectivePolicyReader` (cùng chữ ký `GovernancePolicyPort.get`): hiện trả mặc định có nguồn "DEFAULT, chưa kiểm chứng"; khi làn A1 mở danh sách loại quy tắc thì truyền `GovernancePolicyPort.get` vào hàm tạo, không đổi gì khác. Mọi quyết định dùng chính sách ghi `policy_version` vào audit.

## 6. Dữ liệu

| Bảng | Nội dung | Bất biến DB |
|---|---|---|
| `steering_meeting` | mã, năm, số, ngày, loại, tiêu đề, tóm tắt, `unit_id`, `minutes_document_version_id`, version | unique (tenant, mã), (tenant, năm, số); FK tới đơn vị, phiên bản tệp, thành viên |
| `directive` | cuộc họp, số, mã, `scope_kind`, `project_id`, `scope_unit_id`, `directive_text`, đơn vị và người thực hiện, `original_due_on`, `due_on`, `extension_count`, `status` (4 giá trị), `closed_by/at`, version | `directive_scope_chk`, `directive_due_chk`, `directive_ended_chk`, `directive_closer_chk`; trigger bảo vệ cột không đổi và buộc tăng version; không xóa |
| `directive_extension` | `from_due_on`, `proposed_due_on`, lý do, trạng thái REQUESTED/APPROVED/REJECTED, người đề nghị và quyết định, version | unique một đề nghị mở cho một chỉ đạo; `directive_extension_maker_checker_chk` |
| `directive_event` | loại sự kiện, người, thời điểm, ghi chú, phần trăm, người/đơn vị giao cũ và mới, hạn cũ và mới, đề nghị, người duyệt, version chỉ đạo | chỉ thêm (trigger, REVOKE, no truncate); `directive_event_shape_chk` |
| `directive_evidence` | tài liệu của chỉ đạo, sự kiện mang nó | chỉ thêm; unique (chỉ đạo, phiên bản tệp) |

Tất cả có RLS khóa tenant (RESTRICTIVE + PERMISSIVE, FORCE). Phân loại INTERNAL. Giữ vĩnh viễn (hồ sơ điều hành); audit ADM-11 và outbox cho mọi command.

## 7. API / command

| operationId | Method path | x-permission | Lỗi chính | If-Match |
|---|---|---|---|---|
| `createSteeringMeeting` | POST /steering-meetings | directive.meeting.manage | VALIDATION_FAILED, SCOPE_DENIED, DECISION_DOCUMENT_REQUIRED | – |
| `attachMeetingMinutes` | POST /steering-meetings/{id}/minutes | directive.meeting.manage | VERSION_CONFLICT, DECISION_DOCUMENT_REQUIRED | có |
| `addDirective` | POST /steering-meetings/{id}/directives | directive.manage | VALIDATION_FAILED, SCOPE_DENIED | – |
| `assignDirective` | POST /directives/{id}/assignment | directive.manage | VERSION_CONFLICT, DIRECTIVE_STATE_INVALID | có |
| `recordDirectiveProgress` | POST /directives/{id}/progress | directive.progress | DIRECTIVE_STATE_INVALID, DECISION_DOCUMENT_REQUIRED | – |
| `requestDirectiveExtension` | POST /directives/{id}/extension-requests | directive.progress | DIRECTIVE_EXTENSION_INVALID / LIMIT / PENDING | – |
| `decideDirectiveExtension` | POST /directive-extensions/{id}/decision | directive.extension.decide | SELF_APPROVAL_DENIED, DIRECTIVE_EXTENSION_STATE_INVALID | có (version đề nghị) |
| `closeDirective` | POST /directives/{id}/closure | directive.close | SELF_APPROVAL_DENIED, DIRECTIVE_EVIDENCE_REQUIRED, DIRECTIVE_EXTENSION_PENDING | có |
| `cancelDirective` | POST /directives/{id}/cancellation | directive.manage | DIRECTIVE_EXTENSION_PENDING | có |
| `reopenDirective` | POST /directives/{id}/reopening | directive.manage | DIRECTIVE_STATE_INVALID | có |
| `listSteeringMeetings`, `getSteeringMeeting` | GET /steering-meetings, /steering-meetings/{id} | directive.read | | |
| `listDirectives`, `listOverdueDirectives`, `listProjectDirectives`, `getDirective` | GET /directives, /directives/overdue, /projects/{id}/directives, /directives/{id} | directive.read | | |
| `getDirectiveSummary`, `getDirectivesForReport`, `getDirectiveWidget` | GET /directives/summary, /directives/for-report, /directives/widget | directive.read | | |

Mã lỗi mới: `DIRECTIVE_STATE_INVALID` 409, `DIRECTIVE_EVIDENCE_REQUIRED` 422, `DIRECTIVE_EXTENSION_INVALID` 422, `DIRECTIVE_EXTENSION_LIMIT` 422, `DIRECTIVE_EXTENSION_PENDING` 409, `DIRECTIVE_EXTENSION_STATE_INVALID` 409. Mọi GET là DTO riêng (allowlist, trạng thái người đọc thấy, `as_of`, `definitions`, `policy`); `actions` trên chi tiết là các lệnh người gọi được phép trong trạng thái hiện tại và không vi phạm tách nhiệm. Không có endpoint ghi chung cho trạng thái, hạn, người đóng.

## 8. UI/UX

| Mã | Màn hình | Nội dung |
|---|---|---|
| DIR-01 | Các cuộc giao ban đầu tư | Danh sách (lọc đơn vị, loại, ngày), số chỉ đạo theo trạng thái, hộp thoại ghi nhận cuộc giao ban |
| DIR-02 | Chi tiết cuộc giao ban | Biên bản, các chỉ đạo đã giao, hộp thoại giao chỉ đạo (dự án hoặc đơn vị) |
| DIR-03 | Bảng theo dõi chỉ đạo | Cột theo trạng thái (quá hạn trước), chế độ theo đơn vị, bộ lọc, các ô số có công thức, nguồn, thời điểm |
| DIR-04 | Chi tiết chỉ đạo | Đồng hồ, dòng thời gian, đề nghị gia hạn, bằng chứng; hộp thoại xác nhận có ngữ cảnh cho tiến độ, gia hạn, duyệt gia hạn, đóng, hủy, mở lại, giao lại |
| DIR-05 | Chỉ đạo của kỳ | Chọn kỳ, số theo trạng thái cuối kỳ, danh sách, ghi chú mới nhất |
| DIR-06 | Chỉ đạo giao ban (điện thoại) | Chỉ đọc: số đầu trang, danh sách Giao cho tôi / Quá hạn / Tất cả, chi tiết dòng thời gian |

Đủ 7 trạng thái chuẩn (đang tải bằng khung, rỗng phân biệt "chưa có chỉ đạo" với "nguồn không đọc được", lỗi có thử lại, một phần, cũ, bị từ chối, đang gửi); nút thao tác chỉ hiện theo `actions`; điện thoại không có command trong vòng này.

## 9. Sự kiện, job, tích hợp, quan sát

Outbox: `directive.meeting_created.v1`, `directive.meeting_minutes_attached.v1`, `directive.created.v1`, `directive.assigned.v1`, `directive.progress_recorded.v1`, `directive.extension_requested.v1`, `directive.extension_decided.v1`, `directive.closed.v1`, `directive.cancelled.v1`, `directive.reopened.v1` (payload: id, trạng thái, hạn, đơn vị, version, người, thời điểm; không chép nội dung chỉ đạo).

**Nguồn cảnh báo `DIRECTIVE`** (`packages/db/src/home-directive-sources.ts`, nối vào `HomeWorkStore` bằng một dòng; `work_action.source` thêm giá trị qua V2121). Loại việc `DIRECTIVE_DUE` (sắp đến hạn, đến hạn hôm nay) và `DIRECTIVE_OVERDUE` (quá hạn). Mức độ: Cần xử lý khi sắp đến hạn, đến hạn và quá hạn; **Khẩn** từ ngày thứ `escalate_after_overdue_days` quá hạn, kèm leo thang tới lãnh đạo đơn vị thực hiện (chuỗi: người thực hiện → lãnh đạo đơn vị). Của người được giao; chỉ đạo đã leo thang là của mọi người mà phạm vi đọc `home.read` phủ đơn vị thực hiện (lãnh đạo đơn vị trở lên). Mô tả `ALERT_TYPE` (chủ sở hữu, hành động mong đợi, hậu quả) ở `CONSEQUENCES.DIRECTIVE_*` và trong báo cáo của làn.

## 10. Kiểm thử

| ID | Loại | Nội dung |
|---|---|---|
| T-DIR-01 | domain (`packages/kernel/test/directive.test.ts`) | đồng hồ T-3/T-1/T+0/7 ngày, chuyển trạng thái, tách nhiệm, gia hạn, chính sách, dựng lại trạng thái theo kỳ |
| T-DIR-02 | integration (`packages/db/test/dir-directive-store.test.ts`) | cuộc họp, giao chỉ đạo, giao lại, tiến độ, gia hạn, đóng, hủy, mở lại, bất biến DB, đọc, phân trang, phạm vi, báo cáo kỳ, nguồn cảnh báo |
| T-DIR-03 | integration HTTP (`apps/api/test/dir/directive.test.ts`) | idempotency, audit, outbox, quyền, tách nhiệm, If-Match, từ chối từng mã, đọc có phạm vi |
| T-DIR-04 | security | ma trận từ chối quyền (`negative-matrix`) cho 10 command |
| T-DIR-05 | UI | vitest cho DIR-01..05 và `DirectiveWidget`; flutter test cho DIR-06 |

## 11. Tiêu chí nghiệm thu

- **AC-DIR-01.** Cho một chỉ đạo giao cho X, khi người ghi chỉ đạo hoặc X đóng thì 403 `SELF_APPROVAL_DENIED`; người thứ ba có `directive.close` kèm bằng chứng đóng được (T-DIR-02, T-DIR-03).
- **AC-DIR-02.** Cho chỉ đạo đến hạn ngày D, từ D-3 nó nằm trong danh sách việc của người thực hiện, qua D+1 là quá hạn, từ D+7 là Khẩn và lãnh đạo đơn vị thấy (T-DIR-01, T-DIR-02).
- **AC-DIR-03.** Gia hạn quá số ngày hoặc số lần chính sách cho phép bị từ chối bằng mã riêng; người đề nghị không duyệt được (T-DIR-02, T-DIR-03).
- **AC-DIR-04.** Chỉ đạo của kỳ: tổng theo trạng thái cuối kỳ bằng số dòng danh sách; chỉ đạo đóng sau kỳ vẫn là "chưa xong" trong kỳ (T-DIR-01, T-DIR-02, T-DIR-03).
- **AC-DIR-05.** Lịch sử của chỉ đạo không sửa hoặc xóa được, kể cả bằng câu lệnh trực tiếp (T-DIR-02).

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

R1 dùng thật: toàn bộ mục trên. R2: ô "dự án vướng thủ tục" (nguồn ISS/PMT/LND), chế độ trình chiếu và so cùng kỳ của dashboard (làn C), nhắc qua kênh NOT theo ngày T-3/T-1/T+0, ghi tiến độ từ điện thoại, nhập chỉ đạo từ biên bản qua OCR, người duyệt gia hạn theo bậc. Hạng mục bắt buộc người duyệt: ngưỡng chính sách (lãnh đạo văn phòng và kiểm toán nội bộ).

## 13. Rủi ro, câu hỏi mở, phụ thuộc

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| Ngưỡng T-3/T-1/T+0, 7 ngày, 3 lần, 60 ngày là giá trị khởi đầu chưa kiểm chứng `[GIẢ ĐỊNH]` | Văn phòng lãnh đạo, kiểm toán nội bộ | Xác nhận với khách hàng, nhập thành `DIRECTIVE_POLICY` được duyệt |
| Loại quy tắc `DIRECTIVE_POLICY` chưa có trong `GovernancePolicyPort` (danh sách đóng) | Làn A1 | Mở danh sách loại quy tắc, truyền `GovernancePolicyPort.get` vào `DirectivePolicyReader` |
| "Lãnh đạo đơn vị" chưa có trường riêng trong tổ chức; leo thang đến người có phạm vi `home.read` phủ đơn vị | ADM | Khi có vai trò trưởng đơn vị trong ADM thì thu hẹp theo vai trò |
| Bằng chứng chọn bằng mã phiên bản tệp (chưa có bộ chọn tài liệu trong bộ thành phần) | DOC, web | Bộ chọn tài liệu |
