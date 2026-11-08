# MNE — Giám sát, đánh giá đầu tư (báo cáo pháp định)

Phiên bản đặc tả M1 · 22/10/2026 · Phân hệ **mới** (D-B09). Nguồn dữ liệu máy: `work/staging/capital.json` (bảng `mne_report_form`, `mne_obligation_rule`, `mne_report`, `mne_export_package`, `mne_evaluation`). Quy ước chung theo `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md`; dựng văn bản qua phân hệ DOC.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Chủ đầu tư, cơ quan chủ quản và UBND tỉnh phải lập báo cáo giám sát, đánh giá đầu tư theo NĐ 19/2026/NĐ-CP (sửa bởi NĐ 96/2026/NĐ-CP, thay NĐ 29/2021) [CXN-13] và mẫu biểu TT 44/2026/TT-BTC (mẫu 02–10) [CXN-10], đúng hạn (đề xuất: báo cáo 6 tháng trước 10/7, báo cáo năm trước 10/02 năm sau [CXN-10]), nộp lên Hệ thống TTQG về ĐTC và cơ quan cấp trên; ngoài ra báo cáo nhanh tuần theo CV 3665/BTC-PTHT (2026) [CXN-11]. Hiện các báo cáo này được tổng hợp tay từ nhiều bảng tính, số liệu lệch với báo cáo giải ngân. MNE sinh báo cáo **từ cùng PeriodSnapshot FROZEN của DIS**, dựng văn bản theo template DOC, quản lý lịch nghĩa vụ, phát hành, xuất tệp nộp và ghi nhận số tiếp nhận; quản lý đánh giá đầu tư (ban đầu, giữa kỳ, kết thúc, tác động, đột xuất).

**Trong phạm vi:** danh mục mẫu biểu dạng dữ liệu có hiệu lực; quy tắc nghĩa vụ/lịch báo cáo; báo cáo tổng thể định kỳ (6 tháng/năm), báo cáo theo dự án (khởi công, điều chỉnh, kết thúc, định kỳ), báo cáo nhanh tuần; rà soát–phê duyệt; yêu cầu DOC phát hành; xuất tệp; xác nhận nộp; đính chính; tiến độ nộp; đánh giá đầu tư.
**Ngoài phạm vi:** renderer, ký số, cấp số, sổ văn bản (DOC); số liệu tài chính gốc (DIS/CAP/PAY); API tới Hệ thống TTQG về ĐTC (không có API công khai — chỉ xuất tệp; adapter `NATIONAL_PIM_FILE` trạng thái PROPOSED); giám sát cộng đồng/cổng công khai OC4IDS (Should, R3 — đề xuất).
**Phụ thuộc:** DIS (period_snapshot FROZEN, hai tỷ lệ, cảnh báo), CAP (appropriation, kế hoạch), PRJ (dự án, giai đoạn, sự kiện stage_changed, rủi ro, giải trình), DOC (template, outgoing document, sự kiện `doc.issued`), MDM (CALENDAR, AGENCY), NOT (nhắc hạn), IAM.

**Căn cứ.** NĐ 19/2026 + NĐ 96/2026 [CXN-13]; TT 44/2026/TT-BTC mẫu 02–10 [CXN-10]; CV 3665/BTC-PTHT (2026) [CXN-11]; Luật ĐTC 58/2024 (sửa 90/2025) về giám sát, đánh giá; Luật Lưu trữ 33/2024 [CXN-05]. Thị trường: hệ thống M&E của World Bank/ADB (results framework, evaluation types), IMF PIMA (ex-post review).

**Ánh xạ mẫu đề xuất (toàn bộ chờ xác nhận [CXN-10]; mã/tiêu đề lấy từ nguồn thứ cấp, KHÔNG dùng để nộp chính thức trước khi xác nhận):** `TT44-M02` báo cáo giám sát, đánh giá tổng thể đầu tư 6 tháng; `TT44-M03` báo cáo tổng thể năm; `TT44-M04`…`TT44-M08` báo cáo giám sát dự án (khởi công, điều chỉnh, định kỳ, kết thúc) và tình hình thực hiện kế hoạch vốn; `TT44-M09` báo cáo đánh giá dự án; `TT44-M10` báo cáo theo yêu cầu/đột xuất; `CV3665-WEEKLY` báo cáo nhanh tuần [CXN-11]. Mỗi mẫu là một `mne_report_form` (`schema_json` mô tả bảng/chỉ tiêu và nguồn của từng ô) có `legal_confirmation_ref`.

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Cán bộ lập báo cáo (chủ đầu tư/cơ quan chủ quản/Sở TC) | Đơn vị `scope_unit_id` và dự án trong scope | `createMneReport`, `editMneReport`, `submitMneReport`, `correctMneReport`, `generateMneExportPackage`, `recordMneSubmissionReceipt`, `planMneEvaluation`, `submitMneEvaluation` | Sửa ô tài chính có nguồn (`FIELD_SOURCE_LOCKED`); tự duyệt; sửa báo cáo đã phát hành |
| Người duyệt (lãnh đạo đơn vị) | Đơn vị | `decideMneReport`, `requestMneReportIssue`, `decideMneEvaluation` | Duyệt báo cáo do mình lập |
| Quản trị mẫu biểu/lịch (Sở TC) | Tenant | `createMneFormVersion`, `createMneObligationRule`, `generateMneObligations` | Công bố bản do mình soạn (`publishMneForm`/`publishMneObligationRule` cần người khác) |
| Người duyệt mẫu biểu | Tenant | `publishMneForm`, `publishMneObligationRule` | – |
| Lãnh đạo UBND | Toàn tenant | Đọc MNE-01..10, tiến độ nộp | Command lập báo cáo đơn vị khác |
| Auditor | Đọc | mọi GET | Command |
| DOC (hệ thống) | Sự kiện | phát `doc.issued`/`doc.recalled` cho document liên kết | Sửa payload MNE |

## 3. Luồng nghiệp vụ

**F1 — Cấu hình mẫu và nghĩa vụ (MNE-02, MNE-01).** Quản trị `createMneFormVersion` (form_code, report_kind, `legal_basis`, `legal_confirmation_ref`, `effective_from/until`, `schema_json`, `doc_template_code`, `export_formats`) → `publishMneForm` (người khác). Khoảng hiệu lực các revision cùng form_code không chồng (`FORM_RANGE_OVERLAP`); template DOC phải tồn tại (`DOC_TEMPLATE_MISSING`). `createMneObligationRule` gắn form, vai trò báo cáo (INVESTOR / PROJECT_OWNER_AGENCY / PROVINCIAL_PEOPLE_COMMITTEE / PLANNING_AGENCY), nơi nhận, tần suất, `due_rule_json` (ví dụ `{"period":"H1","month":7,"day":10}`, `{"period":"YEAR","month":2,"day":10,"year_offset":1}`, `{"event":"PROJECT_START","days_after":30}`, `{"weekly":"FRI","time":"16:00"}` — giá trị [CXN-10]/[CXN-11]) → publish.

**F2 — Sinh nghĩa vụ (MNE-01, MNE-09).** `generateMneObligations {report_year}` (idempotent) tạo **vỏ báo cáo** `mne_report` DRAFT (`payload_json = {}`, `snapshot_id = null`, `due_date` tính theo BR-MNE-03, `obligation_rule_id`) cho mỗi đơn vị có vai trò tương ứng theo rule hiệu lực tại cuối kỳ; unique index ngăn sinh trùng. `listMneObligations` đọc các vỏ này để hiện lịch MNE-01 và tiến độ MNE-09. Sự kiện PRJ `project.stage_changed` (→IMPLEMENTATION, COMPLETED) và `project.revised` tạo vỏ EVENT (dedupe theo project + rule + sự kiện).

**F3 — Lập báo cáo tổng thể (MNE-03).** Hai đường: (a) mở vỏ đã sinh và gọi `editMneReport {snapshot_id}` để gắn PeriodSnapshot FROZEN (kind PERIOD_CLOSE hoặc MNE, `as_of_date` = cuối kỳ 30/6 hoặc 31/12; không FROZEN → 422 `SNAPSHOT_NOT_FROZEN`); (b) báo cáo ngoài lịch: `createMneReport` bắt buộc có `snapshot_id` (thiếu → 422 `SNAPSHOT_REQUIRED`; vỏ cùng khóa đã tồn tại → 409 `REPORT_EXISTS` kèm id). Server chọn revision form hiệu lực tại cuối kỳ (`FORM_NOT_EFFECTIVE` nếu không có) và điền `payload_json` theo `schema_json`: mỗi ô có `source` (snapshot metric, CAP appropriation, PRJ đếm theo giai đoạn/nhóm, cảnh báo/giải trình) — ô có nguồn bị khóa (`FIELD_SOURCE_LOCKED` khi sửa); ô thuyết minh (khó khăn, nguyên nhân, kiến nghị) nhập tay qua `editMneReport` (If-Match). `submitMneReport` → IN_REVIEW (chưa gắn snapshot → 422 `SNAPSHOT_REQUIRED`; kiểm ô bắt buộc).

**F4 — Báo cáo theo dự án (MNE-04).** Như F3 với `project_id`; nguồn: PRJ (QĐ đầu tư, mốc, revision điều chỉnh, rủi ro), CAP (vốn giao theo năm), DIS (lũy kế giải ngân theo ngày Kho bạc), CTR/PAY (giá trị hợp đồng, thanh toán — khi có).

**F5 — Báo cáo nhanh tuần (MNE-07).** Sau `snapshot.frozen` tuần, hệ thống tạo `mne_report` form `CV3665-WEEKLY` cho cấp tỉnh: hai tỷ lệ (cùng số DIS-19), giải ngân tuần, top dự án chậm (EW-01) kèm lãnh đạo phụ trách, kiến nghị (nhập tay). Hạn theo rule WEEKLY.

**F6 — Duyệt và phát hành qua DOC (MNE-05).** `decideMneReport` (người khác) → APPROVED. `requestMneReportIssue`: kiểm template, chốt `payload_sha256`, chuyển ISSUING, outbox `mne.report.issue_requested.v1 {mne_report_id, revision, form_code, doc_template_code, payload_ref, payload_sha256, signer_hint, recipients}`; DOC dựng văn bản theo NĐ 30/2020 (renderer DOC), trình ký PAdES, cấp số + ký số cơ quan (R8), phát hành → phát `doc.issued.v1 {document_id, source_ref}` → MNE ISSUED (`doc_document_id`). `doc.rejected`/`doc.recalled` → MNE về APPROVED (rejected) hoặc yêu cầu đính chính (recalled). MNE không tự đánh dấu ISSUED.

**F7 — Xuất tệp và xác nhận nộp (MNE-06).** `generateMneExportPackage {target_system, formats}` chỉ khi ISSUED: sinh XLSX theo cấu trúc mẫu (bảng/cột theo `schema_json`) và PDF bản đã ký từ DOC; lưu object storage key có tenant prefix, `file_sha256`; `adapter_status` lấy từ `integration_cursor`/connector `NATIONAL_PIM_FILE` (PROPOSED). **Không có lời gọi mạng ra hệ thống quốc gia** (egress allowlist không có host này). Người dùng tải tệp, nộp thủ công trên Hệ thống TTQG về ĐTC hoặc gửi cơ quan nhận (LGSP qua DOC nếu tenant có [CXN-06]), rồi `recordMneSubmissionReceipt {receipt_reference, submitted_at, receipt_document_id?}` → package SUBMISSION_CONFIRMED, báo cáo SUBMITTED_EXTERNAL; `is_late = submitted_at > due_date`. Sinh lại cùng nội dung trả package hiện có (unique theo hash).

**F8 — Đính chính (MNE-10).** `correctMneReport {correction_reason}` từ ISSUED/EXPORTED/SUBMITTED_EXTERNAL/RETURNED → revision mới DRAFT (`supersedes_id`), có thể chọn snapshot mới; khi revision mới ISSUED → bản cũ SUPERSEDED (vẫn tải được). Văn bản đính chính đi qua DOC như văn bản mới (DOC trạng thái CORRECTED/REPLACED theo đặc tả DOC).

**F9 — Đánh giá đầu tư (MNE-08).** `planMneEvaluation` (project, loại, đơn vị đánh giá, phạm vi, ngày dự kiến) → IN_PROGRESS → `submitMneEvaluation` (phát hiện, kết luận, kiến nghị, ngày hoàn thành, văn bản báo cáo) → `decideMneEvaluation` (người khác) APPROVED|RETURNED. Đánh giá APPROVED được liên kết vào báo cáo tổng thể kỳ kế tiếp (`mne_report_id`). Loại đánh giá hợp lệ theo giai đoạn PRJ: INITIAL (IMPLEMENTATION ≤ 12 tháng), MIDTERM (IMPLEMENTATION), FINAL (COMPLETED/SETTLED), IMPACT (CLOSED), AD_HOC (mọi giai đoạn) [CXN-13]; sai → 409 `STAGE_TRANSITION_DENIED`.

Đồng thời: hai người tạo cùng báo cáo (form, đơn vị, dự án, năm, kỳ, revision) → unique index chặn, người sau 409 `REPORT_EXISTS`; hai người sửa thuyết minh → If-Match.

## 4. State machine

```
mne_report:
 DRAFT ─submit─► IN_REVIEW ─approve─► APPROVED ─issue-request─► ISSUING ─(doc.issued)─► ISSUED ─export─► EXPORTED ─receipt─► SUBMITTED_EXTERNAL
   ▲               │ return                          │ (doc.rejected)                    │                              │
   └───────────────┴──► RETURNED ─(edit)─► DRAFT     └──────────► APPROVED              correct (mọi trạng thái từ ISSUED) ─► revision mới DRAFT; bản cũ ─► SUPERSEDED khi bản mới ISSUED
mne_export_package: GENERATED ─download─► DOWNLOADED ─receipt─► SUBMISSION_CONFIRMED ; ─(bên nhận từ chối, ghi tay)─► REJECTED ; (TTL 90 ngày) ─► EXPIRED
mne_evaluation: PLANNED ─start─► IN_PROGRESS ─submit─► SUBMITTED ─approve─► APPROVED ; SUBMITTED ─return─► RETURNED ─submit─► SUBMITTED
mne_report_form / mne_obligation_rule: DRAFT ─publish(checker)─► PUBLISHED ─(bản mới hoặc hết hiệu lực)─► RETIRED
```

| Từ | Command/Sự kiện | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|
| DRAFT | `submitMneReport` | IN_REVIEW | người lập | ô bắt buộc đủ; snapshot FROZEN | `mne.report.submitted.v1` |
| IN_REVIEW | `decideMneReport` approve/return | APPROVED/RETURNED | người duyệt ≠ người lập | lý do | `mne.report.decided.v1` |
| APPROVED | `requestMneReportIssue` | ISSUING | mne.report.issue | template tồn tại; hash chốt | `mne.report.issue_requested.v1` |
| ISSUING | `doc.issued.v1` | ISSUED | system | document khớp source_ref + hash | `mne.report.issued.v1` |
| ISSUED/EXPORTED | `generateMneExportPackage` | EXPORTED | người lập | định dạng hỗ trợ | `mne.export.generated.v1` |
| EXPORTED | `recordMneSubmissionReceipt` | SUBMITTED_EXTERNAL | người lập | `receipt_reference` | `mne.report.submitted_external.v1` |
| ISSUED…SUBMITTED_EXTERNAL, RETURNED | `correctMneReport` | (revision mới DRAFT) | người lập | lý do ≥ 10 | `mne.report.correction_started.v1` |

Bị cấm: sửa payload sau APPROVED (`REPORT_STATE_INVALID`); ISSUED không qua DOC; export khi chưa ISSUED (`REPORT_NOT_ISSUED`); xác nhận nộp không có số tiếp nhận (`RECEIPT_REQUIRED`); tự duyệt (403).

## 5. Quy tắc nghiệp vụ và công thức

- **BR-MNE-01** Mẫu biểu, nghĩa vụ, hạn nộp là dữ liệu có `legal_basis`, `legal_confirmation_ref`, `effective_from/until`; slice dùng mẫu chưa xác nhận [CXN-10] không được DONE (R4) và tệp xuất gắn watermark "Mẫu chờ xác nhận pháp lý".
- **BR-MNE-02** Revision form/nghĩa vụ dùng cho báo cáo = bản PUBLISHED hiệu lực tại **ngày cuối kỳ** báo cáo (với EVENT: ngày sự kiện). Retire mẫu không đổi báo cáo đã phát hành.
- **BR-MNE-03** Hạn nộp: `due_date` tính từ `due_rule_json` của rule hiệu lực; "trước ngày 10/7" lưu `due_date = 10/7` và quy ước nộp **trước hoặc trong ngày** [CXN-10]; ngày nghỉ không dời hạn trừ khi rule có `shift_on_holiday = true`.
- **BR-MNE-04** Trễ: `days_late = max(0, (submitted_at::date hoặc hôm nay) − due_date)`; `is_late` khi > 0; nghĩa vụ của rule đã hết hiệu lực trước kỳ không tính.
- **BR-MNE-05** Số liệu tài chính trong báo cáo = số của snapshot gắn kèm (cùng tử/mẫu số DIS BR-DIS-05/06); không nhập tay; mọi ô có `source` và hiển thị `as_of`. Đơn vị tính theo mẫu (thường triệu đồng): chuyển đổi = VND / 1.000.000 làm tròn half-up 0 chữ số **chỉ khi xuất**, tổng trong tệp tính lại từ VND rồi mới làm tròn (ghi chú chênh lệch làm tròn nếu có).
- **BR-MNE-06** Payload chuẩn hóa (JSON canonical, khóa sắp xếp) → `payload_sha256`; DOC phải dựng từ đúng hash này; hash khác → DOC từ chối.
- **BR-MNE-07** Đính chính bắt buộc lý do; bản cũ giữ nguyên, có thể tải; tệp xuất mới có hash khác.
- **BR-MNE-08** Đánh giá: loại hợp lệ theo giai đoạn PRJ (F9); nộp cần `conclusion` + `completed_date`.

## 6. Dữ liệu

| Bảng | Trường/ràng buộc chính | Owner | Classification | Retention |
|---|---|---|---|---|
| `mne_report_form` | form_code × revision unique; report_kind; legal_basis; legal_confirmation_ref; hiệu lực (until > from); schema_json; doc_template_code; export_formats | MNE | PUBLIC (cấu trúc mẫu) | Vĩnh viễn |
| `mne_obligation_rule` | rule_code × revision; form_id FK; vai trò, nơi nhận, tần suất, due_rule_json, hiệu lực | MNE | INTERNAL | Vĩnh viễn |
| `mne_report` | form_id, obligation_rule_id, report_year, period_label, period_id, scope_unit_id, project_id, snapshot_id, due_date, revision, status, is_late, payload_json, payload_sha256, doc_document_id, supersedes_id, correction_reason, approved_by; unique (form, unit, project, year, label, revision) NULLS NOT DISTINCT; ISSUED+ ⇒ doc + hash; SoD | MNE | INTERNAL | Vĩnh viễn (hồ sơ giám sát) [CXN-05] |
| `mne_export_package` | mne_report_id, target_system, format, object_key, file_sha256, adapter_status, status, receipt_*; confirmed ⇒ receipt; unique (report, target, format, hash) | MNE | INTERNAL | 10 năm [CXN-05] |
| `mne_evaluation` | project_id, loại, đơn vị đánh giá, phạm vi, findings_json, conclusion, kiến nghị, status, report_document_id, mne_report_id, ngày; SUBMITTED+ ⇒ conclusion + completed_date; SoD | MNE | INTERNAL | Vĩnh viễn |

Mọi bảng có `tenant_id` + RLS ENABLE/FORCE + `tenant_boundary` + `tenant_guard`; FK composite; index mọi `*_id`. Mẫu biểu baseline quốc gia phát hành từ platform (như MDM PLATFORM namespace) và nhân bản vào tenant; tenant không sửa bản platform, chỉ thêm form riêng (vd báo cáo nội bộ tỉnh).

## 7. API / command

| operationId | Method path | x-permission | DTO | Lỗi | Idem | If-Match |
|---|---|---|---|---|---|---|
| `createMneFormVersion` / `publishMneForm` | POST /mne-forms[/{id}/publish] | mne.form.manage / mne.form.approve | `MneFormVersion` | 409 FORM_RANGE_OVERLAP; 422 DOC_TEMPLATE_MISSING; 403 SELF_APPROVAL_DENIED | ✔ | ✔ (publish) |
| `createMneObligationRule` / `publishMneObligationRule` | POST /mne-obligation-rules[/{id}/publish] | mne.calendar.manage / mne.calendar.approve | `MneObligationRule` | 422 FORM_NOT_EFFECTIVE | ✔ | ✔ (publish) |
| `generateMneObligations` | POST /mne-obligations/generate | mne.calendar.manage | `MneObligationGenerate` | 422 NO_EFFECTIVE_RULE | ✔ | – |
| `createMneReport` | POST /mne-reports | mne.report.prepare | `MneReportCreate` | 422 FORM_NOT_EFFECTIVE/SNAPSHOT_REQUIRED; 409 REPORT_EXISTS; 404 | ✔ | – |
| `editMneReport` | POST /mne-reports/{id}/revisions | mne.report.prepare | `MneReportEdit` (narrative, attachments, snapshot_id) | 422 FIELD_SOURCE_LOCKED/SNAPSHOT_NOT_FROZEN; 409 REPORT_STATE_INVALID/VERSION_CONFLICT | ✔ | ✔ |
| `submitMneReport` | POST /mne-reports/{id}/submit | mne.report.prepare | – | 422 SNAPSHOT_REQUIRED/VALIDATION_FAILED | ✔ | ✔ |
| `decideMneReport` | POST /mne-reports/{id}/decision | mne.report.approve | `MneDecision` | 403 SELF_APPROVAL_DENIED | ✔ | ✔ |
| `requestMneReportIssue` | POST /mne-reports/{id}/issue-requests | mne.report.issue | – | 422 DOC_TEMPLATE_MISSING; 409 REPORT_STATE_INVALID | ✔ | ✔ |
| `generateMneExportPackage` | POST /mne-reports/{id}/export-packages | mne.report.export | `MneExportRequest` | 409 REPORT_NOT_ISSUED; 422 EXPORT_FORMAT_UNSUPPORTED | ✔ | ✔ |
| `recordMneSubmissionReceipt` | POST /mne-export-packages/{id}/submission-receipt | mne.report.export | `MneReceipt` | 422 RECEIPT_REQUIRED | ✔ | ✔ |
| `correctMneReport` | POST /mne-reports/{id}/corrections | mne.report.prepare | `MneCorrection` | 422 CORRECTION_REASON_REQUIRED | ✔ | ✔ |
| `planMneEvaluation` / `submitMneEvaluation` / `decideMneEvaluation` | POST /mne-evaluations[/{id}/submit\|decision] | mne.evaluation.manage / approve | `MneEvaluationInput/Submit`, `MneDecision` | 409 STAGE_TRANSITION_DENIED; 403 SELF_APPROVAL_DENIED | ✔ | ✔ |
| `listMneObligations`, `getMneReport`, `listMneForms` | GET | mne.read | – | 404 | – | – |

Không có GET scaffold cũ (phân hệ mới). Không endpoint ghi chung cho status/payload tài chính.

## 8. UI/UX

Màn hình mới MNE-01…MNE-10 theo style mockup (D-B11): **MNE-01** lịch (calendar component như DIS-14/MDM-11: mỗi ô nghĩa vụ có mẫu, cấp, hạn, nơi nhận, nhãn CXN-*); **MNE-02** danh mục mẫu (DataTable; cột hiệu lực; link xem template DOC); **MNE-03** lập báo cáo tổng thể (form nhiều bảng theo schema; ô có nguồn hiển thị khóa + icon nguồn mở DrillDrawer HOME-10; ô thuyết minh dùng editor văn bản; header "Snapshot … as_of …"); **MNE-04** báo cáo dự án; **MNE-05** duyệt/phát hành (approval panel + trạng thái DOC theo thời gian thực: Đang soạn → Chờ ký → Đã cấp số → Đã phát hành); **MNE-06** xuất & nộp (danh sách package, hash rút gọn, badge "Adapter: PROPOSED — nộp thủ công", form số tiếp nhận); **MNE-07** báo cáo nhanh tuần (bảng + cặp tỷ lệ như DIS-19); **MNE-08** đánh giá; **MNE-09** tiến độ nộp (DataTable đơn vị × mẫu, ô trễ có số ngày, không chỉ màu); **MNE-10** lịch sử phiên bản (ComparePanel).
Trạng thái riêng: "Mẫu chờ xác nhận pháp lý", "Chờ DOC phát hành", "Đã nộp — số tiếp nhận …", "Trễ N ngày". Mobile: không có màn MNE riêng ở R1; lãnh đạo xem tiến độ qua HOME-02/MOB-07 (đề xuất MOB owner).

## 9. Sự kiện, job, tích hợp, quan sát

Events phát: `mne.report.submitted.v1`, `mne.report.decided.v1`, `mne.report.issue_requested.v1`, `mne.report.issued.v1`, `mne.export.generated.v1`, `mne.report.submitted_external.v1`, `mne.report.correction_started.v1`, `mne.obligation.due_soon.v1` (NOT nhắc 7/3/1 ngày trước hạn). Consumers: `snapshot.frozen.v1` (DIS) → F5 báo cáo nhanh tuần + gắn snapshot kỳ cho báo cáo định kỳ; `project.stage_changed.v1`, `project.revised.v1` (PRJ) → nghĩa vụ EVENT; `doc.issued.v1`, `doc.rejected.v1`, `doc.recalled.v1` (DOC) → chuyển trạng thái. Mọi consumer idempotent qua inbox.
Jobs: `mne.obligation-window` (hằng ngày: tạo DRAFT 30 ngày trước hạn), `mne.due-reminder`, `mne.package-expiry` (90 ngày). Tích hợp: connector `NATIONAL_PIM_FILE` (PROPOSED, chỉ xuất tệp), LGSP qua DOC [CXN-06]. Telemetry: `mne_report_late_gauge`, `mne_issue_latency_seconds` (APPROVED→ISSUED), `mne_export_total{format}`; log không chứa payload.

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Setup | Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC285 | business | P0 | rule H1/YEAR | sinh nghĩa vụ 2026 | hạn 10/7/2026, 10/02/2027 | API |
| UAT-AC286 | domain | P0 | form r1/r2 | báo cáo năm 2026, H1-2027 | dùng r1/r2 | DB |
| UAT-AC287 | domain | P0 | S-H1 FROZEN | tạo không/có snapshot; sửa ô tiền | 422; điền đúng; 422 FIELD_SOURCE_LOCKED | API |
| UAT-AC288 | integration | P1 | khởi công P-A-001 | sự kiện | 1 nghĩa vụ, dedupe | inbox |
| UAT-AC289 | integration | P0 | MR-1 | duyệt, issue, doc.issued | ISSUED chỉ sau DOC | outbox |
| UAT-AC290 | integration/security | P0 | ISSUED | export, receipt | 2 package; không egress; 422 thiếu số | egress log |
| UAT-AC291 | business | P0 | S-W40 | báo cáo nhanh tuần | tỷ lệ = DIS-19 | API |
| UAT-AC292 | business | P1 | MIDTERM | submit/approve | 422; 403; APPROVED | API |
| UAT-AC293 | domain | P1 | 3 đơn vị | MNE-09 | trễ 0/2/5 | UI |
| UAT-AC294 | business | P1 | SUBMITTED_EXTERNAL | đính chính | rev2; rev1 SUPERSEDED | DB |
| UAT-AC295 | security (cách ly) | P0 | B-maker | đọc/xuất MR-1 | 404 | RLS log |
| UAT-AC296 | domain | P1 | form không hiệu lực 2025 | tạo | 422 FORM_NOT_EFFECTIVE | API |
| UAT-AC297 | idempotency | P1 | ISSUED | export lặp | không trùng | DB |
| UAT-AC298 | integration | P1 | template thiếu | issue | 422 DOC_TEMPLATE_MISSING | API |
| UAT-AC299 | domain | P1 | rule r1/r2 hạn khác | nộp 12/7 | theo rule hiệu lực | UI |
| UI-MNE-01…UI-MNE-10 | screen-contract | theo phase | synthetic | 7 trạng thái | đúng field/rule | screenshot |

Fixture đề xuất **FX-MNE-001**: snapshot S-H1 (as_of 2026-06-30) tổng KH TTg giao 1.000.000.000.000, giao thêm 250.000.000.000, giải ngân 600.000.000.000 → 60%/48%; 3 đơn vị U1/U2/U3 nộp 09/7, 12/7, chưa nộp.

## 11. Tiêu chí nghiệm thu

- **AC-MNE-01** Given rule nghĩa vụ hiệu lực, When sinh nghĩa vụ năm 2026, Then mỗi đơn vị có hạn H1 10/7/2026 và năm 10/02/2027 với nhãn [CXN-10]. → UAT-AC285, UAT-AC299
- **AC-MNE-02** Given nhiều phiên bản mẫu, Then báo cáo dùng bản hiệu lực tại cuối kỳ; không có bản hiệu lực → 422. → UAT-AC286, UAT-AC296
- **AC-MNE-03** Given snapshot FROZEN, Then số liệu tài chính điền sẵn đúng snapshot và không sửa tay được; thiếu snapshot → 422. → UAT-AC287, UAT-AC291
- **AC-MNE-04** Given báo cáo APPROVED, Then chỉ ISSUED khi DOC phát `doc.issued`; template thiếu → 422 và giữ APPROVED. → UAT-AC289, UAT-AC298
- **AC-MNE-05** Given báo cáo ISSUED, Then xuất tệp có hash, không gọi API ngoài; xác nhận nộp cần số tiếp nhận; xuất lặp không trùng. → UAT-AC290, UAT-AC297
- **AC-MNE-06** Given báo cáo đã nộp, Then đính chính tạo revision mới có lý do, bản cũ SUPERSEDED vẫn tải được. → UAT-AC294
- **AC-MNE-07** Tiến độ nộp tính trễ đúng theo rule hiệu lực. → UAT-AC293
- **AC-MNE-08** Người lập không tự duyệt báo cáo/đánh giá; tenant khác không đọc được. → UAT-AC292, UAT-AC295
- **AC-MNE-09** Sự kiện dự án tạo nghĩa vụ báo cáo dự án đúng một lần. → UAT-AC288

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1 (dùng thật):** F1 (seed mẫu đề xuất có watermark CXN), F2 định kỳ, F3, F5, F6 (qua DOC đường (ii) tải lên văn bản đã ký nếu ký trong hệ thống chưa sẵn — R8), F7, F8 cơ bản; MNE-01, 02, 03, 05, 06, 07, 09.
**R2:** báo cáo dự án EVENT (MNE-04), đánh giá đầu tư (MNE-08), lịch sử/so sánh (MNE-10), xuất XML khi có đặc tả hệ thống quốc gia, gửi LGSP qua DOC.
**R3:** cổng công khai/giám sát cộng đồng (OC4IDS) — đề xuất; adapter nộp tự động chỉ khi có hợp đồng/đặc tả chính thức (D05).
**Giờ review người:** mẫu biểu pháp lý TT 44/2026 + CV 3665 với Chủ nghiệp vụ vốn 6 h [CXN-10]/[CXN-11]; ánh xạ ô ↔ nguồn số liệu 4 h; quyền/SoD 2 h; hợp đồng sự kiện với DOC 2 h. Tổng ≈ 14 h.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| [CXN-10] Mã, tên, cấu trúc mẫu 02–10 TT 44/2026 và kỳ/hạn (6 tháng trước 10/7, năm trước 10/02) | Chủ nghiệp vụ vốn | Thông tư gốc → cập nhật `mne_report_form.schema_json`, rule hạn; bỏ watermark |
| [CXN-11] CV 3665/BTC-PTHT báo cáo nhanh tuần: chỉ tiêu, hạn, nơi nhận | Chủ nghiệp vụ vốn | Công văn gốc |
| [CXN-13] Hiệu lực NĐ 19/2026 sửa NĐ 96/2026; loại đánh giá theo giai đoạn | Pháp chế | Công báo |
| DOC: cần template `MNE-*`, API/sự kiện `doc.issue_requested` → `doc.issued/rejected/recalled` có `source_ref` + kiểm `payload_sha256` | DOC owner | Cross-module request (hợp đồng sự kiện) |
| Không có API Hệ thống TTQG về ĐTC; định dạng tệp nộp chưa có đặc tả | Integration Lead (D05) | Xin mẫu tệp chính thức; giữ adapter PROPOSED |
| Navigation: thêm nhóm MNE vào `navigation_architecture.json` + prototype (R10) | Owner điều hướng/prototype | Thêm route MNE-01..10 |
| Tạo DRAFT 30 ngày trước hạn [GIẢ ĐỊNH] | Sở Tài chính | Xác nhận quy trình nội bộ |

## 14. Hiệu quả sau đầu tư (MR.03 gộp G4-7; làn MR-1; MNE-11)

Chỉ tiêu mục tiêu của dự án là một bộ: một người lập nháp (mã, tên, đơn vị, chiều tốt, giá trị cơ sở và ngày, mục tiêu, nguồn số liệu, cách tính), người khác chốt khi phê duyệt đầu tư (người lập không tự chốt: 403 `SELF_APPROVAL_DENIED`); bộ đã chốt bất biến trong cơ sở dữ liệu, muốn đổi phải lập bản nháp mới nêu lý do và bộ cũ thành SUPERSEDED. Sau khi đưa vào vận hành, số đo thực tế chỉ thêm (cùng chỉ tiêu cùng ngày là 409 `EFFECT_MEASUREMENT_DUPLICATE`), sửa bằng dòng hiệu chỉnh có lý do. Chênh lệch tính trong lõi bằng số thập phân chính xác: thực tế trừ mục tiêu, phần trăm, mức đạt từ cơ sở tới mục tiêu; xếp loại đạt, một phần, chưa đạt theo quy tắc `EFFECT_POLICY` (chưa kiểm chứng, có nguồn và ngày); mỗi con số có nút i. Lịch đánh giá theo Điều 76-77 Luật Đầu tư công 58/2024/QH15 là quy tắc `EFFECT_EVALUATION_CALENDAR` theo nhóm dự án (nhóm A và quan trọng quốc gia đủ bốn loại, nhóm B và C hai loại), ghi rõ CHƯA KIỂM CHỨNG với văn bản gốc, sinh một lần từ lịch sử giai đoạn và biên bản bàn giao đã nghiệm thu. Hồ sơ đánh giá đóng băng chênh lệch của mọi chỉ tiêu theo ngày, kèm kết luận; người duyệt khác người trình; duyệt thì đóng mục lịch tương ứng. Tài liệu: `docs/prj-effectiveness.md`; migration `V2481`, `V2482`; story ST-MNE-014.
