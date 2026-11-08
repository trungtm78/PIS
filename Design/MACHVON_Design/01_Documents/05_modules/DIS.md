# DIS — Báo cáo giải ngân, kỳ báo cáo và số liệu điều hành

Phiên bản đặc tả M1 · 22/10/2026 · Nguồn dữ liệu máy: `work/staging/capital.json` (bảng `reporting_period`, `period_reopen`, `report_revision`, `funding_snapshot_line`, `progress_snapshot`, `report_narrative`, `report_import_batch`, `period_snapshot`, `period_snapshot_line`, `early_warning_rule`, `early_warning`, `disbursement_ranking`). Quy ước chung theo `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md` (giao dịch gửi báo cáo, công thức 420/150/14%).

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Đây là luồng duy nhất có bằng chứng nguồn sâu (PDF 6 trang SRC-01..06, video 86 s VID-01..07): chủ đầu tư nhập báo cáo tuần gồm khối lượng (thi công, nghiệm thu, đã gửi KBNN, hồ sơ đang hoàn thiện), lũy kế giải ngân theo 6 ô nguồn (vốn năm/kéo dài/khác × NSTW/NSĐP) với "trong đó CTMTQG", và đăng ký tháng sau; Sở Tài chính tổng hợp. M1 giữ nguyên cấu trúc nghiệp vụ đó và bổ sung: kỳ có trạng thái Open/SoftClosed/Locked với mở lại có lý do; revision bất biến sau gửi; **hai tỷ lệ giải ngân song song** (mẫu số kế hoạch TTg giao và mẫu số gồm phần địa phương giao thêm) [CXN-03]; giải ngân tính theo **ngày Kho bạc thanh toán** [CXN-03]; PeriodSnapshot đóng băng có as-of; cảnh báo sớm; xếp hạng đơn vị; dự báo dòng tiền/EAC; kế hoạch tuần theo CĐ 162 [CXN-33].

**Trong phạm vi:** DIS-01…DIS-25; lịch kỳ và khóa sổ; nháp/gửi/duyệt/trả lại/điều chỉnh/thu hồi; nhập tệp; xuất báo cáo; snapshot; quy tắc và vòng đời cảnh báo; xếp hạng; định nghĩa chỉ tiêu (đề xuất, CHỜ KÝ D03).
**Ngoài phạm vi:** số tiền kế hoạch (CAP); giao dịch Kho bạc gốc (PAY `treasury_transaction` — DIS chỉ đọc); trang điều hành (HOME đọc snapshot DIS); báo cáo giám sát pháp định (MNE dùng snapshot DIS); semantic layer/BI builder (BI).
**Phụ thuộc:** PRJ (dự án, giai đoạn, lãnh đạo phụ trách, giải trình), CAP (plan_version, appropriation origin, schedule), PAY (treasury_transaction + `treasury_paid_on`), MDM (FUND_SOURCE, CALENDAR, AGENCY lịch sử), IAM, NOT.

**Căn cứ:** TT 37/2025/TT-BTC (mẫu báo cáo giải ngân) và CV 3665/BTC-PTHT (2026) báo cáo nhanh tuần [CXN-11]; CV 16437/BTC-ĐTPT (thời điểm tính giải ngân, hai mẫu số) [CXN-03]; Công điện 162/CĐ-TTg [CXN-33]; định nghĩa kỳ/YTD/lũy kế dự án là quyết định D03 (Chủ nghiệp vụ vốn ký) — CHỜ KÝ.

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Cán bộ chủ đầu tư (maker) | Dự án thuộc đơn vị mình (cây) | `post_reports`, `post_reports_id_revisions`, `post_reports_id_submit`, `post_reports_id_corrections`, `withdrawReport`, `deleteDraftReport`, `restoreDraftReport`, `createReportImport`/`applyReportImport` (đơn vị mình), `requestPeriodReopen`, mobile MOB-13..22 | Duyệt báo cáo mình gửi; sửa bản đã gửi; xem dự án ngoài scope |
| Chuyên viên tổng hợp Sở TC (reviewer) | Đơn vị được phân công | `post_reports_id_decision` (approve/return/reject/request_amendment), `acknowledgeEarlyWarning`, `dismissEarlyWarning`, `createReportExport` | Sửa im lặng số của người gửi; tự duyệt khi là người gửi |
| Quản trị kỳ (period manager) | Toàn tenant | `generateReportingPeriods`, `softCloseReportingPeriod`, `lockReportingPeriod`, `buildPeriodSnapshot`, `freezePeriodSnapshot` | Mở lại kỳ không qua `period_reopen` |
| Người duyệt mở kỳ | `period.reopen.approve` | `decidePeriodReopen` | Duyệt đề nghị của chính mình |
| Quản trị quy tắc cảnh báo | `warning.rule.manage` / `.approve` | tạo/công bố rule (maker≠checker) | Sửa rule PUBLISHED (phải tạo revision) |
| Lãnh đạo | Đọc toàn bộ scope | đọc DIS-12/15/19/21/23/24, drill | Command nhập liệu |
| Auditor | Đọc | mọi GET, lịch sử revision | Command |
| System | Job | dựng snapshot theo lịch, mở/cập nhật cảnh báo, OVERDUE, hết hạn mở kỳ | – |

## 3. Luồng nghiệp vụ

**F1 — Lập báo cáo tuần (giữ nguyên luồng có bằng chứng; web DIS-01→07, mobile MOB-13→21).**
Tiền điều kiện: dự án trong scope và ở giai đoạn BUDGETED/IMPLEMENTATION/SUSPENDED/COMPLETED; kỳ OPEN hoặc SOFT_CLOSED (hoặc LOCKED có `period_reopen` APPROVED còn hạn bao gồm dự án); có `plan_version` PUBLISHED hiệu lực tại `period.end_date`.
1. DIS-01 (MOB-08/22): danh sách theo năm/tuần/kế hoạch năm/dự án, KPI có nhãn scope (SRC-01/02: tổng bảng lọc ≠ KPI toàn tenant).
2. DIS-02 (MOB-13): chọn kỳ + dự án → `post_reports` tạo DRAFT revision 1 (hoặc trả nháp hiện có: `DRAFT_EXISTS` kèm id), chụp `plan_version_id`, vốn giao theo 6 ô (`allocated_vnd` read-only), lũy kế kỳ trước để so sánh.
3. DIS-03 (MOB-14): khối lượng thi công, nghiệm thu, đã gửi KBNN, hồ sơ đang hoàn thiện + `measurement_basis` (mặc định YTD theo đề xuất D03) → `progress_snapshot`.
4. DIS-04 (MOB-15/16/17): lũy kế giải ngân 6 ô CURRENT_YEAR/CARRYOVER/OTHER × CENTRAL/LOCAL; "trong đó CTMTQG" cho CURRENT_YEAR và CARRYOVER (OTHER không có CTMTQG — CHECK).
5. DIS-05 (MOB-18): đăng ký tháng sau theo nhóm nguồn + CTMTQG.
6. MOB-19: đính kèm chứng từ (upload qua object storage, quét virus trước khi liên kết).
7. DIS-06 (MOB-20): rà soát — hệ thống hiện hard error và warning (BR-DIS-07); `post_reports_id_revisions` lưu nháp (If-Match).
8. `post_reports_id_submit`: giao dịch theo `05_Thiet_ke_chi_tiet.md` (SELECT … FOR UPDATE, kiểm kỳ/scope/version, validate, chuẩn hóa payload, `payload_hash` SHA-256, `submitted_at` giờ server, `is_late`, gắn `workflow_version_id`, audit, outbox `report.submitted.v1`) → DIS-07/DIS-18/MOB-21.
Nhánh: lưu nháp không gửi (DIS-18); mobile offline xếp hàng command với `client_operation_id` + Idempotency-Key, trường tiền read-only khi offline đối với dữ liệu server, gửi lại khi online (không last-write-wins). Lỗi: 422 `SUBSET_EXCEEDS_PARENT` (giữ nháp), 409 `PERIOD_LOCKED`, 409 `VERSION_CONFLICT` (trả current_version + diff an toàn), 422 `NEGATIVE_DELTA_EXPLANATION_REQUIRED`. Đồng thời: hai người gửi cùng version → một thắng; cùng key khác payload → 409 `IDEMPOTENCY_CONFLICT`.

**F2 — Duyệt, trả lại, điều chỉnh (DIS-07/08/11).** Reviewer `post_reports_id_decision`: approve → ACCEPTED, `is_current` chuyển sang revision này, revision ACCEPTED trước → SUPERSEDED; return → RETURNED (bắt buộc `return_items` + `due_at`); request_amendment (với ACCEPTED) → AMENDMENT_REQUESTED. Maker sửa bằng `post_reports_id_corrections` (revision mới DRAFT, `supersedes_id`, `amendment_reason` bắt buộc khi revision > 1). Bản đã gửi không bao giờ sửa (`REVISION_IMMUTABLE`). Dashboard/snapshot chỉ đổi khi revision mới ACCEPTED và snapshot mới được dựng.

**F3 — Thu hồi và xóa nháp (DIS-09).** `withdrawReport` chỉ khi SUBMITTED chưa UNDER_REVIEW và kỳ chưa LOCKED, lý do ≥ 20 ký tự → WITHDRAWN. `deleteDraftReport` soft-delete DRAFT (hộp thoại nêu mã, kỳ, dự án — khắc phục SRC-06); `restoreDraftReport` trong 30 ngày [GIẢ ĐỊNH], kiểm lại quyền hiện tại.

**F4 — Lịch kỳ, khóa sổ, mở lại (DIS-14, DIS-22).** `generateReportingPeriods` sinh kỳ từ CALENDAR (MDM-11) — tuần không mặc định ISO (A02), mặc định tenant: thứ Bảy→thứ Sáu, hạn thứ Sáu 10:00 giờ VN [GIẢ ĐỊNH, D03]. Hết hạn: job (hoặc người quản trị) `softCloseReportingPeriod` → SOFT_CLOSED (vẫn nhận gửi, `is_late=true`). `lockReportingPeriod` → LOCKED (`locked_at`, `locked_by`) — mặc định 3 ngày làm việc sau hạn [GIẢ ĐỊNH]. Mở lại: `requestPeriodReopen` (PERIOD hoặc danh sách dự án, lý do ≥ 20, thời hạn ≤ 168 h) → `decidePeriodReopen` bởi người khác → cửa sổ mở cho đúng phạm vi; hết `window_until` → EXPIRED (job), kỳ vẫn LOCKED với dự án khác.
**Giải quyết mâu thuẫn "Closed" vs `locked_at` (O11, CR-DIS-01):** `reporting_period.status` ∈ {OPEN, SOFT_CLOSED, LOCKED} là nguồn sự thật; "Closed" trong FRD UC02 = LOCKED; `locked_at` chỉ là dấu thời gian dẫn xuất, NOT NULL khi và chỉ khi status = LOCKED (CHECK `reporting_period_lock_chk`). Không có trạng thái "Closed" trong API.

**F5 — Nhập tệp (DIS-10).** `createReportImport` (tệp đã quét virus, `file_sha256`, `mapping_version`) → DRY_RUN với lỗi từng dòng (không bỏ dòng sai) → `applyReportImport` chỉ khi `error_rows = 0` → tạo/cập nhật nháp `source_kind = IMPORT` (không tự gửi). Cùng tệp đã APPLIED cho cùng kỳ → 409 `IMPORT_FILE_ALREADY_APPLIED` (A3).

**F6 — Chốt số liệu kỳ (DIS-21).** `buildPeriodSnapshot` (period, kind, `treasury_cutoff_date`) dựng `period_snapshot_line` theo dự án × bucket × budget_level: lấy revision `is_current` ACCEPTED (SUBMITTED chưa duyệt không vào số chính thức — hiển thị riêng "chờ duyệt"), kế hoạch từ `plan_version` hiệu lực tại `as_of_date` tách `plan_pm_assigned_vnd`/`plan_local_added_vnd` theo `appropriation.origin`, giải ngân Kho bạc Σ `treasury_transaction.amount` có `treasury_paid_on ≤ treasury_cutoff_date` (trừ reversal), tính tỷ lệ, delta kỳ, EAC, `treasury_coverage`. `freezePeriodSnapshot` → FROZEN (`payload_sha256`), snapshot FROZEN cùng (period, kind) trước đó → SUPERSEDED. Sau FROZEN: bất biến (409 `SNAPSHOT_FROZEN`), sửa sau chốt = snapshot mới. Snapshot mang `definition_status = PROPOSED_PENDING_SIGNOFF` cho tới khi D03 ký.

**F7 — Cảnh báo sớm (DIS-20, HOME-03/06).** Sau mỗi FROZEN, job đánh giá các rule PUBLISHED hiệu lực; với vi phạm: upsert `early_warning` theo `dedupe_key = rule_code|subject_id|plan_year[|period]` (một bản mở duy nhất); hết vi phạm ở snapshot sau → RESOLVED tự động (`resolution_reason = AUTO_CLEARED`). `auto_explanation` → phát `warning.opened.v1` để PRJ tạo giải trình.

**F6a — Kiểm tổng chéo (G4-5, DIS-26).** Cùng một số giải ngân của snapshot được cộng ba cách: theo đơn vị (các dòng `period_snapshot_line` như lúc dựng), theo nguồn vốn và theo dự án (sổ giao dịch Kho bạc đọc lại lúc kiểm, từ đầu năm tài chính đến ngày chốt, hoàn trả trừ đi; nguồn vốn là mã nguồn vốn của dòng phân bổ mà giao dịch nêu, không rõ thì khóa `UNMATCHED` nằm trong tổng và hiện riêng). Ba tổng phải **bằng nhau đến từng đồng**, nếu không chỉ tiêu không được công bố: `freezePeriodSnapshot` trả 422 `CROSS_TOTAL_MISMATCH` nêu chiều lệch (một chiều đứng riêng khi hai chiều kia khớp, cả ba khi không chiều nào khớp), các tổng và độ lệch; lần kiểm vẫn được ghi (`cross_total_check`, không đổi) cùng dòng kiểm toán, snapshot vẫn BUILDING. Cổng chỉ nói khi snapshot đóng băng được (phiên bản và trạng thái giữ câu trả lời riêng). Snapshot dựng trước một giao dịch muộn hay một khoản hoàn trả vì thế lệch với sổ và phải dựng lại. `getCrossTotalControl` đọc ngay (không ghi) kèm 20 dự án lệch nhiều nhất giữa snapshot và sổ; `evaluateCrossTotal` ghi một lần kiểm theo yêu cầu. Chỉ người có quyền bao trùm cả tenant đọc hoặc ghi. Loại cảnh báo: CROSS_TOTAL_MISMATCH (chủ: người quản lý dữ liệu giải ngân, hành động: sửa chiều đang lệch rồi dựng lại snapshot, hậu quả: chỉ tiêu chưa công bố).
**F8 — Xếp hạng (HOME-04) và dự báo (DIS-23), kế hoạch tuần (DIS-24).** Xếp hạng tính trên snapshot FROZEN cho từng `comparison_group` × `denominator_kind` (BR-DIS-10). EAC theo BR-DIS-11. DIS-24 so `disbursement_schedule_line` WEEKLY_COMMITMENT với giải ngân Kho bạc theo tuần.

**F9 — Xuất báo cáo (DIS-17).** `createReportExport` từ snapshot FROZEN; job áp quyền tại lúc chạy và lúc tải; tệp có header phạm vi, kỳ, snapshot id, đơn vị tính, thời điểm, `definition_status`; link TTL 15 phút [GIẢ ĐỊNH].

**Đối chiếu parity mobile (MOB-13..21):** MOB-13=DIS-02, MOB-14=DIS-03, MOB-15/16/17=DIS-04 (tách theo bucket), MOB-18=DIS-05, MOB-19=đính kèm (web dùng DIS-06), MOB-20=DIS-06, MOB-21=DIS-07/18. Cùng command, cùng DTO `ReportDraft`, cùng validation server; khác biệt duy nhất: hàng đợi offline + `client_operation_id`.

## 4. State machine

```
report_revision:
 DRAFT ──submit──► SUBMITTED ──(reviewer mở)──► UNDER_REVIEW ──approve──► ACCEPTED ──(revision mới ACCEPTED)──► SUPERSEDED
   ▲  │                │  │                         │  return                 │ request_amendment
   │  │delete(soft)    │  └──withdraw──► WITHDRAWN  └────────► RETURNED       └────────► AMENDMENT_REQUESTED
   │  ▼                │ return                                  │ corrections            │ corrections
   │ (deleted_at)      └────────────► RETURNED ──corrections──► DRAFT (revision n+1) ◄────┘
reporting_period:  OPEN ──soft-close──► SOFT_CLOSED ──lock──► LOCKED  (mở lại = period_reopen theo phạm vi, không đổi status)
period_snapshot:   BUILDING ──freeze──► FROZEN ──(freeze bản mới)──► SUPERSEDED ; BUILDING ──lỗi──► FAILED
early_warning:     OPEN ──ack──► ACKNOWLEDGED ──explanation──► EXPLANATION_REQUESTED ──(giải trình ACCEPTED | auto clear)──► RESOLVED ; OPEN/ACK ──dismiss(lý do)──► DISMISSED
period_reopen:     REQUESTED ──approve──► APPROVED ──(hết window)──► EXPIRED ; REQUESTED ──reject──► REJECTED
```

| Đối tượng | Từ | Command | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|---|
| report | DRAFT | `post_reports_id_submit` | SUBMITTED | maker scope | kỳ OPEN/SOFT_CLOSED hoặc reopen hợp lệ; validation; If-Match | `report.submitted.v1 {is_late, payload_hash}` |
| report | SUBMITTED/UNDER_REVIEW | `post_reports_id_decision` approve | ACCEPTED (+ prev SUPERSEDED) | reviewer ≠ submitter | maker-checker; lý do | `report.accepted.v1` |
| report | SUBMITTED/UNDER_REVIEW | decision return | RETURNED | reviewer | `return_items`, `due_at` | `report.returned.v1` |
| report | ACCEPTED | decision request_amendment | AMENDMENT_REQUESTED | reviewer | lý do | `report.returned.v1` |
| report | ACCEPTED/RETURNED/AMENDMENT_REQUESTED | `post_reports_id_corrections` | (revision mới DRAFT) | maker | `amendment_reason`; không có revision DRAFT khác | `report.correction_started.v1` |
| report | SUBMITTED | `withdrawReport` | WITHDRAWN | maker (chính sách) | chưa UNDER_REVIEW; kỳ chưa LOCKED | `report.withdrawn.v1` |
| period | OPEN | `softCloseReportingPeriod` | SOFT_CLOSED | period.manage | sau deadline | `period.soft_closed.v1` |
| period | SOFT_CLOSED | `lockReportingPeriod` | LOCKED | period.lock | – | `period.locked.v1` |
| snapshot | BUILDING | `freezePeriodSnapshot` | FROZEN | snapshot.freeze | build OK | `snapshot.frozen.v1` |

Bị cấm: sửa SUBMITTED/ACCEPTED (409 `REVISION_IMMUTABLE`), submit khi LOCKED không có reopen (409 `PERIOD_LOCKED`), xóa bản đã gửi (409 `REPORT_NOT_EDITABLE`), freeze lại snapshot FROZEN (409 `SNAPSHOT_FROZEN`), LOCKED → OPEN trực tiếp (chỉ qua period_reopen), tự duyệt (403 `SELF_APPROVAL_DENIED`).

## 5. Quy tắc nghiệp vụ và công thức

Mọi tiền: VND nguyên `numeric(24,0)`; tỷ lệ `numeric(9,4)` %, hiển thị 2 chữ số, làm tròn half-up chỉ khi hiển thị.

- **BR-DIS-01 (6 ô nguồn)** Tổng lũy kế revision = Σ `disbursed_cumulative_vnd` của 6 ô; CTMTQG là tập con, không cộng (FX-DIS-001: 100+200+30+70+0+20 = 420 triệu; CTMTQG 40 triệu → vẫn 420).
- **BR-DIS-02 (snapshot không cộng qua kỳ)** Lũy kế tại kỳ = giá trị của revision current ACCEPTED kỳ đó, không cộng các kỳ (FX-DIS-002: W39 100, W40 150 → 150).
- **BR-DIS-03 (delta kỳ)** `period_delta = cumulative(kỳ) − cumulative(kỳ so sánh trước cùng plan_year, cùng ô)`; âm → bắt buộc `negative_delta_explanation` (422 nếu thiếu), không ép 0.
- **BR-DIS-04 (tỷ lệ tổng hợp)** Tỷ lệ của nhóm = Σ tử số / Σ mẫu số × 100 trên cùng snapshot/scope; không trung bình các tỷ lệ (FX-DIS-003: 50/100 và 90/900 → 140/1000 = 14%).
- **BR-DIS-05 (hai tỷ lệ song song) [CXN-03] — CHỜ KÝ D03.**
  `D` = giải ngân vốn kế hoạch năm (bucket CURRENT_YEAR) tính theo ngày Kho bạc thanh toán ≤ `treasury_cutoff_date`;
  `rate_pm_pct = D / plan_pm_assigned_vnd × 100` (mẫu số: kế hoạch Thủ tướng Chính phủ giao — appropriation origin PM_ASSIGNED);
  `rate_total_pct = D / (plan_pm_assigned_vnd + plan_local_added_vnd) × 100` (mẫu số gồm phần địa phương giao thêm — LOCAL_ADDED; REVENUE_INCREASE/CENTRAL_SUPPORT theo cấu hình tenant).
  Cùng tử số cho cả hai; `rate_pm_pct` có thể > 100% khi địa phương giao thêm — hiển thị kèm chú thích. Vốn kéo dài (CARRYOVER) có tỷ lệ riêng `D_carryover / plan_carryover`, không trộn. FX-DIS-004: 600/1000 = 60.0000%, 600/1250 = 48.0000%.
- **BR-DIS-06 (thời điểm tính giải ngân) [CXN-03]** Một khoản được tính là đã giải ngân tại `treasury_paid_on` (ngày Kho bạc thanh toán), không phải ngày gửi hồ sơ hay ngày nhập tệp. Snapshot chỉ gồm giao dịch có `treasury_paid_on ≤ treasury_cutoff_date` (FX-DIS-005). Reversal trừ vào ngày của reversal.
- **BR-DIS-07 (validation)** Hard (chặn gửi): thiếu trường bắt buộc; âm; CTMTQG > ô cha; kỳ khóa; dự án ngoài scope; plan_version không hiệu lực; revision không current. Warning (cho gửi, có thể yêu cầu lý do theo policy): khối lượng > vốn giao (khác basis — VID 203,8%), lũy kế báo cáo lệch giải ngân Kho bạc > 5% [GIẢ ĐỊNH], đăng ký tháng sau = 0 khi còn vốn.
- **BR-DIS-08 (mẫu số 0/thiếu dữ liệu)** Mẫu số = 0 → `rate = null`, `rate_null_reason = ZERO_DENOMINATOR`, UI "Chưa có cơ sở tính"; không có báo cáo và không có dữ liệu Kho bạc → `NO_DATA` ("Chưa có dữ liệu", không phải 0); `treasury_coverage = NONE` → `TREASURY_COVERAGE_NONE`.
- **BR-DIS-09 (trễ hạn)** `is_late = submitted_at > deadline_at` của kỳ theo `calendar_version` gắn với kỳ (không theo lịch hiện hành).
- **BR-DIS-10 (xếp hạng)** Trong mỗi nhóm so sánh (loại đơn vị: Sở/Ban QLDA/UBND xã; cấu hình): loại đơn vị có `plan_vnd` < ngưỡng tối thiểu (mặc định 1.000.000.000 VND [GIẢ ĐỊNH]) hoặc mẫu số 0 (`excluded_reason`); sắp `rate_pct` giảm dần, hòa → `disbursed_vnd` lớn hơn, rồi mã đơn vị; hai bảng riêng cho hai mẫu số.
- **BR-DIS-11 (dự báo/EAC)** `EAC_năm = D (Kho bạc tới cutoff) + Σ FORECAST current các tháng sau tháng cutoff`; thiếu FORECAST tháng nào → dùng REGISTERED tháng đó; thiếu cả hai → dùng đường kỳ vọng lịch sử (R2). `gap = EAC − plan_total`. EAC < 80% plan_total → ứng viên điều chuyển (CAP-19) [GIẢ ĐỊNH].
- **BR-DIS-12 (định nghĩa basis — đề xuất, CHỜ KÝ D03)** PERIOD = phát sinh trong kỳ (= delta); YTD = lũy kế từ đầu năm kế hoạch tới cuối kỳ, theo plan_year của nguồn (CURRENT_YEAR) hoặc từ đầu năm kéo dài (CARRYOVER); PROJECT_TO_DATE = lũy kế từ khởi công tới cuối kỳ mọi năm. Ô "lũy kế" trên báo cáo tuần mặc định YTD. Thời gian giải ngân vốn năm kéo tới hết thời gian chỉnh lý [CXN-31]. Các định nghĩa lưu thành `glossary_term` (MDM-34) domain DISBURSEMENT, owner Chủ nghiệp vụ vốn.
- **BR-DIS-13 (cảnh báo — seed rule, dữ liệu có legal_basis)** EW-01 tỷ lệ YTD thấp hơn đường kỳ vọng (tuyến tính theo tháng hoặc theo đăng ký) ≥ 10 điểm % (WARNING) / ≥ 20 điểm (CRITICAL); EW-02 chưa gửi báo cáo sau hạn (CRITICAL, auto_explanation, hạn giải trình 3 ngày); EW-03 giải ngân tháng < 80% đăng ký; EW-04 vốn chưa phân bổ chi tiết sau hạn [CXN-33]; EW-05 dự án có vốn chưa có mã TTQG [CXN-01]; EW-06 vốn kéo dài còn > 0 và `extended_to` ≤ 60 ngày; EW-07 delta âm; EW-08 tạm ứng quá hạn (từ PAY); EW-09 kế hoạch tuần âm 2 tuần liên tiếp; EW-10 giải trình quá hạn; EW-11 không giải ngân N=4 tuần liên tiếp khi còn vốn. Ngưỡng [GIẢ ĐỊNH] tới khi ký.
- **BR-DIS-14 (giá trị thu được đóng băng theo kỳ, làn B1 G1-4)** Khi bản chụp loại `PERIOD_CLOSE` được đóng băng (`freezePeriodSnapshot`), trong **cùng giao dịch** kết quả EVM (PV, EV, AC, CPI, SPI, EAC theo đường cơ sở hiện hành và công thức của quy tắc `EVM_POLICY`) của mọi dự án có dòng trong bản chụp được ghi một lần vào `evm_frozen_result` (khóa `snapshot_id + project_id`, băm SHA-256 riêng, bất biến); dự án chưa có đường cơ sở được ghi là "chưa đủ dữ liệu `NO_BASELINE`". Số của kỳ đã đóng không bao giờ tính lại từ dữ liệu thay đổi sau kỳ (PRJ `getProjectEvm` với `snapshot_id` hoặc ngày xem = ngày bản chụp). Chỉ tiêu BI `prj_cpi`, `prj_spi`, `prj_eac` đọc các kết quả này.
- **FND-1 (mô hình vốn và kỳ tổng quát — tham chiếu, không đổi BR-DIS-01…13)** Sáu ô nguồn của BR-DIS-01 là gói phân loại `PUBLIC` của loại quy tắc `FUNDING_TAXONOMY`; bản doanh nghiệp dùng gói `ENTERPRISE` (vốn chủ sở hữu / vốn vay / khác). Mô hình mở rộng gồm các loại số (kế hoạch năm, điều chỉnh, quý, tháng; ước; thực; lũy kế năm và từ đầu dự án), mẫu số từng tỷ lệ, nguồn số thực từng bản (công: Kho bạc; doanh nghiệp: kế toán/ERP, quy tắc ưu tiên và giải trình chênh lệch), lịch sử chuyển số ước thành số thực và quy tắc kỳ đã chốt bất biến: xem `docs/fnd-funding-model.md`. Hai tỷ lệ BR-DIS-05, hash snapshot và mọi số công giữ nguyên từng byte (test golden ở mục 9 của tài liệu đó).

**Golden fixtures (ID cố định, synthetic):** FX-DIS-001 (6 ô → 420.000.000; CTMTQG 40.000.000), FX-DIS-002 (100.000.000 → 150.000.000), FX-DIS-003 (50/100 + 90/900 → 14%), FX-DIS-004 (PM 1.000.000.000, giao thêm 250.000.000, D 600.000.000 → 60%/48%), FX-DIS-005 (T1 500.000.000 paid 30/09 tính; T2 300.000.000 paid 01/10 không tính, cutoff 30/09), FX-DIS-006 (CTMTQG 120.000.000 > ô 100.000.000 → 422), FX-DIS-007 (xếp hạng 3 đơn vị, hòa tỷ lệ, một đơn vị dưới ngưỡng). Đề nghị owner test_fixtures bổ sung các ID này (§13).

## 6. Dữ liệu

| Bảng | Mới/sửa | Trường/ràng buộc chính | Classification | Retention |
|---|---|---|---|---|
| `reporting_period` | sửa | + `calendar_code`, `period_type`, `fiscal_year`, `status`, `soft_closed_at`, `locked_by`, audit; CHECK lock ⇔ locked_at; EXCLUDE không chồng lấn (calendar_code, period_type); UNIQUE code | INTERNAL | Vĩnh viễn |
| `period_reopen` | mới | scope PERIOD/PROJECTS, lý do ≥ 20, window_until, requested_by ≠ approved_by | INTERNAL | 10 năm |
| `report_revision` | sửa | + `report_type`, `supersedes_id`, `amendment_reason`, `source_kind`, `is_late`, `submitted_by`, `accepted_by`, `returned_reason`, `workflow_version_id`, `import_batch_id`, `client_operation_id`, `deleted_at/_reason`, audit; CHECK status/type/source/amend/SoD/delete; UNIQUE client_operation_id; giữ UNIQUE (project, period, revision) + partial current | INTERNAL | Vĩnh viễn (hồ sơ báo cáo) [CXN-05] |
| `funding_snapshot_line` | sửa | + `allocated_vnd`, `next_month_ctmtqg_subset_vnd`, `source_year`, `fund_source_version_id`, `allocation_line_id`, `source_reference`; CHECK bucket/level/tiền/tập con; OTHER không CTMTQG; UNIQUE ô/revision | INTERNAL | theo revision |
| `progress_snapshot` | sửa | + `as_of_date`, `physical_progress_pct`; CHECK basis/tiền/%; UNIQUE/revision | INTERNAL | theo revision |
| `report_narrative` | mới | kết quả/nguyên nhân/giải pháp/kiến nghị, `linked_issue_ids` | INTERNAL | theo revision |
| `report_import_batch` | mới | file sha256, mapping, đếm dòng, errors_json; APPLIED ⇒ 0 lỗi; unique APPLIED (period, sha) | INTERNAL | 5 năm [GIẢ ĐỊNH] |
| `period_snapshot` | mới | as_of, treasury_cutoff, status, metric_set_version, definition_status, payload_sha256, supersedes; unique một FROZEN/(period, kind) | INTERNAL | Vĩnh viễn |
| `period_snapshot_line` | mới | plan_pm/local/total (CHECK tổng), disbursed_treasury/reported (null ≠ 0), delta, registered, EAC, CTMTQG, 2 tỷ lệ + null_reason, coverage | INTERNAL | Vĩnh viễn |
| `early_warning_rule` | mới | rule data, legal_basis, hiệu lực, revision, maker ≠ checker | INTERNAL | Vĩnh viễn |
| `early_warning` | mới | dedupe_key unique khi mở; RESOLVED/DISMISSED ⇒ lý do + closed_at | INTERNAL | 10 năm |
| `disbursement_ranking` | mới | (snapshot, group, denominator, unit) unique; rank null ⇔ excluded_reason | INTERNAL | Vĩnh viễn |

Mọi `*_id` có index `(tenant_id, col)`; RLS + `tenant_guard`. Sync mobile (PowerSync, A1): bucket theo `tenant_id` + danh sách dự án trong scope membership; chỉ đồng bộ `reporting_period` OPEN/SOFT_CLOSED, nháp của chính user và revision gần nhất đã gửi; không đồng bộ `period_snapshot_line` của dự án ngoài scope; thu hồi membership làm rỗng bucket ở lần sync kế.

## 7. API / command

| operationId | Method path | x-permission | DTO | Lỗi chính | Idem | If-Match |
|---|---|---|---|---|---|---|
| `post_reports` | POST /reports | report.create | `ReportDraft` | 409 PERIOD_LOCKED/DRAFT_EXISTS; 422 PLAN_VERSION_NOT_EFFECTIVE/PROJECT_STAGE_INVALID | ✔ | – |
| `post_reports_id_revisions` | POST /reports/{id}/revisions | report.edit | `ReportDraft` | 409 REVISION_IMMUTABLE/VERSION_CONFLICT/PERIOD_LOCKED | ✔ | ✔ |
| `post_reports_id_submit` | POST /reports/{id}/submit | report.submit | – | 409 PERIOD_LOCKED/VERSION_CONFLICT/IDEMPOTENCY_CONFLICT; 422 SUBSET_EXCEEDS_PARENT/NEGATIVE_DELTA_EXPLANATION_REQUIRED/CORRECTION_REASON_REQUIRED | ✔ | ✔ |
| `post_reports_id_decision` | POST /reports/{id}/decision | report.review | `DisReportDecision` | 403 SELF_APPROVAL_DENIED; 409 REPORT_STATE_INVALID | ✔ | ✔ |
| `post_reports_id_corrections` | POST /reports/{id}/corrections | report.correct | `DisReportCorrection` | 422 CORRECTION_REASON_REQUIRED; 409 REVISION_PENDING_EXISTS | ✔ | ✔ |
| `withdrawReport` | POST /reports/{id}/withdrawal | report.withdraw | `DisWithdrawal` | 409 REPORT_STATE_INVALID/PERIOD_LOCKED | ✔ | ✔ |
| `deleteDraftReport` / `restoreDraftReport` | POST /reports/{id}/draft-deletion, /draft-restore | report.edit | `DisDraftDeletion` | 409 REPORT_NOT_EDITABLE; 422 RESTORE_WINDOW_EXPIRED | ✔ | ✔ |
| `createReportImport` / `applyReportImport` | POST /report-imports[/{id}/apply] | report.import | `DisImportRequest` | 409 IMPORT_FILE_ALREADY_APPLIED; 422 IMPORT_HAS_ERRORS | ✔ | ✔ (apply) |
| `createReportExport` | POST /report-exports | report.export | `DisExportRequest` | 422 SNAPSHOT_NOT_FROZEN | ✔ | – |
| `generateReportingPeriods` | POST /reporting-periods/generate | period.manage | `DisPeriodGenerate` | 409 PERIOD_OVERLAP | ✔ | – |
| `softCloseReportingPeriod` / `lockReportingPeriod` | POST /reporting-periods/{id}/soft-close, /lock | period.manage / period.lock | `DisPeriodTransition` | 409 PERIOD_STATE_INVALID | ✔ | ✔ |
| `requestPeriodReopen` / `decidePeriodReopen` | POST /reporting-periods/{id}/reopen-requests; /period-reopens/{id}/decision | period.reopen.request/approve | `DisReopenRequest` / `DisReopenDecision` | 422 REOPEN_REASON_REQUIRED; 403 SELF_APPROVAL_DENIED | ✔ | ✔ (decision) |
| `buildPeriodSnapshot` / `freezePeriodSnapshot` | POST /period-snapshots[/{id}/freeze] | snapshot.build / snapshot.freeze | `DisSnapshotRequest` | 409 SNAPSHOT_FROZEN/SNAPSHOT_BUILD_IN_PROGRESS | ✔ | ✔ (freeze) |
| `createEarlyWarningRuleVersion` / `publishEarlyWarningRule` | POST /early-warning-rules[/{id}/publish] | warning.rule.manage/approve | `DisWarningRule` | 422 METRIC_UNKNOWN; 403 SELF_APPROVAL_DENIED | ✔ | ✔ (publish) |
| `acknowledgeEarlyWarning` / `dismissEarlyWarning` | POST /early-warnings/{id}/acknowledge, /dismiss | warning.handle | `DisWarningAction` | 409 WARNING_STATE_INVALID | ✔ | ✔ |
| `getDisbursementRates` | GET /disbursement-rates | disbursement.read | → `DisRates` | 404 | – | – |
| `getDisbursementForecast`, `listPeriodSnapshotLines`, `listEarlyWarnings`, `getReportRevision`, `getSubmissionProgress` | GET | disbursement.read / warning.read / report.read | – | 404 | – | – |

DTO `FundingLine`/`ReportDraft` chuyển enum sang chữ hoa trùng DB (`CURRENT_YEAR|CARRYOVER|OTHER`, `CENTRAL|LOCAL`, `PERIOD|YTD|PROJECT_TO_DATE`) — CR-DIS-02. **GET scaffold:** `report_revision` → `dto`; `reporting_period` → `keep`; `funding_snapshot_line`, `progress_snapshot` → `internal` (chỉ trả kèm `getReportRevision`). Không có PATCH status.

## 8. UI/UX

Giữ DIS-01…DIS-18 (bố cục nguồn: KPI có nhãn scope, cột ghim, cấu hình cột thay vì cuộn ngang dài). Field thêm: DIS-12 + "Tỷ lệ theo KH TTg giao", "Tỷ lệ theo KH gồm địa phương giao thêm", "Ngày chốt Kho bạc" (FR-DIS-19); DIS-14 + "Trạng thái kỳ (Open/SoftClosed/Locked)", "Lịch sử mở lại" (FR-DIS-22); DIS-16 + hai cột tỷ lệ (FR-DIS-19).
Mới: **DIS-19** bảng hai tỷ lệ cạnh nhau (MetricTile cặp, không bao giờ hiển thị một tỷ lệ đơn lẻ; tooltip công thức + [CXN-03] + badge "CHỜ KÝ D03"; cột "Độ phủ Kho bạc"); **DIS-20** chính sách cảnh báo (policy editor có preview số cảnh báo sẽ mở trên snapshot gần nhất); **DIS-21** danh sách snapshot (trạng thái, cutoff, hash rút gọn, nút Freeze có xác nhận); **DIS-22** duyệt mở kỳ; **DIS-23** biểu đồ dòng tiền lũy kế (thực hiện liền, dự báo nét đứt, đường kế hoạch; dataviz tokens; bảng số đi kèm cho screen reader); **DIS-24** kế hoạch tuần (DataTable với cột lãnh đạo phụ trách); **DIS-25** định nghĩa chỉ tiêu + fixture golden (read-only cho tới khi ký).
**DIS-26** kiểm tổng chéo số giải ngân (G4-5): chọn snapshot; một câu kết luận ("Ba tổng khớp nhau đến từng đồng: chỉ tiêu được công bố" hoặc "CHƯA được công bố" kèm tên chiều lệch); ba KpiTile tổng theo đơn vị, nguồn vốn, dự án (đỏ khi lệch, ghi độ lệch so với hai chiều khớp nhau); tiền chưa rõ nguồn vốn; bảng tối đa 20 dự án lệch giữa snapshot và sổ Kho bạc; khóa lớn nhất của từng chiều; lịch sử các lần kiểm; nút "Ghi một lần kiểm" cho người có quyền; nút "i" nêu công thức, nguồn, ngày, phiên bản và nhãn chưa ký. Trạng thái: đang tải (khung xương, không hiện số 0), lỗi (thử lại), từ chối phạm vi, không có snapshot, chỉ đọc. DIS-21 khi đóng băng bị 422  nêu lý do và dẫn tới DIS-26.
FundingMatrix (6 ô + hàng "trong đó CTMTQG" thụt lề, nhãn "không cộng vào tổng"); MoneyInput VND; FiscalPeriodPicker theo calendar. Trạng thái riêng: "Kỳ đã khóa sổ" (+ nút đề nghị mở lại), "Đang mở lại tới hh:mm", "Gửi trễ hạn", "Chờ duyệt — chưa vào số chính thức", "Snapshot đã thay thế". Mobile: MOB-13..22 theo parity §3, offline/sync pending/conflict theo tài liệu 07.

## 9. Sự kiện, job, tích hợp, quan sát

Events: `report.submitted.v1`, `report.accepted.v1`, `report.returned.v1`, `report.withdrawn.v1`, `report.correction_started.v1`, `period.soft_closed.v1`, `period.locked.v1`, `period.reopened.v1`, `snapshot.built.v1`, `snapshot.frozen.v1 {snapshot_id, period_id, as_of_date, treasury_cutoff_date, definition_status}`, `warning.rule_published.v1`, `warning.opened.v1 {rule_code, severity, subject, auto_explanation}`, `warning.resolved.v1`.
Consumers: PAY `treasury.transaction_confirmed.v1`/`treasury.transaction_reversed.v1` → đánh dấu snapshot "có dữ liệu mới" (không sửa FROZEN); PRJ `explanation.reviewed.v1` → RESOLVED cảnh báo liên kết; CAP `capital.plan_published.v1` → nháp mở dùng plan_version mới (cảnh báo người nhập).
Jobs (Temporal): `dis.period-autoclose` (soft-close sau deadline, lock theo policy), `dis.reopen-expiry`, `dis.snapshot-weekly` (dựng + freeze sau lock, kind PERIOD_CLOSE), `dis.warning-evaluate` (sau `snapshot.frozen`), `dis.ranking-compute`, `dis.export` (hàng đợi, cap 200k dòng [GIẢ ĐỊNH]). Tích hợp: không gọi API Kho bạc; dữ liệu Kho bạc đến từ PAY (import sao kê, idempotent). Cache `t:{tenant}:dis:rates:{snapshot}:{scope_hash}`; vô hiệu khi snapshot mới FROZEN. Metric: `dis_submit_total{late}`, `dis_snapshot_build_seconds`, `dis_rate_null_total{reason}`, `dis_treasury_coverage_ratio`, `dis_warning_open_gauge{severity}`.

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Setup | Input/Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC01 | integration/idempotency | P0 | FX-DIS-001, kỳ OPEN | submit 2 lần cùng key | SUBMITTED; 1 audit; 1 outbox | DB |
| UAT-AC02 | domain | P0 | FX-DIS-006 | submit | 422 field CTMTQG, nháp giữ | API |
| UAT-AC03 | domain | P0 | kỳ LOCKED | submit | 409 PERIOD_LOCKED | API |
| UAT-AC04 | domain | P0 | mẫu số 0 | đọc tỷ lệ | "Chưa có cơ sở tính" | UI |
| UAT-AC05 | security | P0 | maker-checker | tự duyệt | 403 | audit |
| UAT-AC06 | business | P0 | ACCEPTED 420tr | điều chỉnh | dashboard đổi chỉ sau accept + snapshot | snapshot |
| UAT-AC07 | business | P0 | calendar_version 2 | gửi ±1 giây quanh hạn | is_late đúng | DB |
| UAT-AC240 | domain | P0 | FX-DIS-001 | nhập 6 ô | 420.000.000 | API |
| UAT-AC241 | domain | P0 | FX-DIS-002 | snapshot W40 | 150.000.000, delta 50.000.000 | DB |
| UAT-AC242 | domain | P0 | FX-DIS-003 | tỷ lệ đơn vị | 14% | API |
| UAT-AC243 | domain | P0 | FX-DIS-004 | hai tỷ lệ | 60/48 | API |
| UAT-AC244 | integration | P0 | FX-DIS-005 | cutoff 30/09 | 500.000.000 | DB |
| UAT-AC245 | business | P0 | W40 | soft-close, lock | is_late; PERIOD_LOCKED | API |
| UAT-AC246 | security/business | P0 | W39 LOCKED | mở lại phạm vi P-A-001 48h | chỉ P-A-001; hết hạn khóa lại | audit |
| UAT-AC247 | domain | P0 | SUBMITTED | sửa; return; corrections | REVISION_IMMUTABLE; rev2 | API |
| UAT-AC248 | concurrency | P0 | v7 | 2 submit song song | 1 thành công, 1 409 | log |
| UAT-AC249 | idempotency (mobile) | P0 | offline | replay | 1 revision | DB |
| UAT-AC250 | domain | P0 | lũy kế giảm | submit | 422 / 200 có giải thích | API |
| UAT-AC251 | business | P0 | S-40a FROZEN | correction + rebuild | S-40a giữ hash; S-40b | DB |
| UAT-AC252 | business | P0 | EW-01 | 2 snapshot | 1 warning (dedupe) | DB |
| UAT-AC253 | business | P0 | EW-02 | quá hạn | warning + giải trình | event |
| UAT-AC254 | domain | P0 | FX-DIS-007 | xếp hạng | thứ tự + loại trừ | API |
| UAT-AC255 | domain | P1 | dự báo | EAC | 650.000.000 | API |
| UAT-AC256 | business | P0 | kế hoạch tuần | so thực hiện | EW-09 | UI |
| UAT-AC257 | business | P0 | D03 OPEN | xem/xuất/ký | CHỜ KÝ; 403 ký | PDF |
| UAT-AC258 | integration | P0 | tệp 20 dòng | dry-run/apply/lặp | lỗi dòng; 409 | batch |
| UAT-AC259 | business | P1 | nháp/đã gửi | xóa mềm/khôi phục | đúng; 409 | API |
| UAT-AC260 | business | P1 | SUBMITTED | return thiếu mục | 422; RETURNED | API |
| UAT-AC261 | security | P1 | export | thu hồi quyền trước tải | 403 | log |
| UAT-AC262 | business | P1 | tháng 9 | thuyết minh | 422; SUBMITTED | API |
| UAT-AC263 | business | P1 | 10 dự án | tiến độ nộp | 7/2/1/3 | UI |
| UAT-AC264 | E2E | P0 | web + mobile | luồng đầy đủ | parity | video |
| UAT-AC265 | security (cách ly tenant) | P0 | B-maker | đọc report/snapshot/drill A | 404 | RLS log |
| UI-DIS-19…UI-DIS-25 | screen-contract | theo phase | synthetic | 7 trạng thái | đúng field/rule | screenshot |

## 11. Tiêu chí nghiệm thu

- **AC-DIS-01** Given kỳ mở và dữ liệu hợp lệ, When gửi (kể cả gửi lại cùng key), Then SUBMITTED, đúng 1 audit và 1 `report.submitted`. → UAT-AC01, UAT-AC249
- **AC-DIS-02** Given CTMTQG > ô cha, Then 422 `SUBSET_EXCEEDS_PARENT`, nháp giữ nguyên; tổng 6 ô FX-DIS-001 = 420.000.000. → UAT-AC02, UAT-AC240
- **AC-DIS-03** Given kỳ LOCKED không có mở lại hợp lệ, Then 409 `PERIOD_LOCKED`; mở lại chỉ áp dụng cho phạm vi và thời hạn đã duyệt. → UAT-AC03, UAT-AC245, UAT-AC246
- **AC-DIS-04** Given mẫu số 0 hoặc thiếu dữ liệu, Then tỷ lệ null với lý do, UI không hiện 0%/Infinity. → UAT-AC04
- **AC-DIS-05** Given cùng snapshot, Then hai tỷ lệ hiển thị song song với cùng tử số (FX-DIS-004: 60%/48%) và giải ngân tính theo ngày Kho bạc thanh toán (FX-DIS-005). → UAT-AC243, UAT-AC244
- **AC-DIS-06** Given báo cáo đã gửi, Then không sửa được; điều chỉnh tạo revision mới có lý do; số điều hành chỉ đổi sau khi revision mới ACCEPTED và snapshot mới FROZEN. → UAT-AC06, UAT-AC247, UAT-AC251
- **AC-DIS-07** Given báo cáo gửi sau hạn theo calendar_version của kỳ, Then `is_late=true` và DIS-15 đếm quá hạn đúng. → UAT-AC07, UAT-AC263
- **AC-DIS-08** Lũy kế không cộng qua kỳ (150 không 250); tỷ lệ tổng hợp là tỷ số tổng (14%). → UAT-AC241, UAT-AC242
- **AC-DIS-09** Cảnh báo không trùng qua nhiều snapshot; quá hạn báo cáo sinh giải trình tự động. → UAT-AC252, UAT-AC253
- **AC-DIS-10** Xếp hạng theo BR-DIS-10 với lý do loại trừ hiển thị. → UAT-AC254
- **AC-DIS-11** Định nghĩa chỉ tiêu chưa ký được gắn nhãn CHỜ KÝ trên snapshot và tệp xuất. → UAT-AC257
- **AC-DIS-12** Người tenant khác không đọc được báo cáo/snapshot/drill. → UAT-AC265

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1 (dùng thật, đúng số FX-DIS-001..007):** F1 web + mobile parity, F2, F3, F4 (đủ ba trạng thái + mở lại), F5, F6 (snapshot tuần + tháng), BR-DIS-05/06 hai tỷ lệ theo ngày Kho bạc (với dữ liệu Kho bạc từ PAY import), cảnh báo EW-01/02/05/07, xếp hạng một nhóm so sánh, DIS-01..22, 24, 25.
**R2:** dự báo/EAC (DIS-23) với đường kỳ vọng lịch sử, toàn bộ EW-03..11, xếp hạng nhiều nhóm, xuất theo mẫu TT 37/2025 qua DOC [CXN-11], đối chiếu báo cáo ↔ Kho bạc tự động.
**R3:** kênh dữ liệu Kho bạc theo hợp đồng (D05).
**Giờ review người:** đường tiền/công thức (BR-DIS-01..06, 11) 8 h + phiên ký D03 với Chủ nghiệp vụ vốn 4 h; quyền/maker-checker/mở kỳ 3 h; migration `report_revision`/enum 3 h; sync rules mobile 2 h. Tổng ≈ 20 h.

### 12.1 WF-1: duyệt báo cáo tuần trên bộ máy quy trình ADM

- **Quy tắc:** các bước duyệt là dữ liệu trong sổ quy tắc quản trị (loại `APPROVAL_WORKFLOW_DEFINITION`, mã `REPORT_ACCEPT`), có phiên bản, người đề xuất khác người duyệt. Mặc định là một quyết định của người duyệt đơn vị, đúng như hiện nay (chế độ `SINGLE_DECISION`, bộ máy không chạy).
- **Chế độ `STAGED`:** khi đơn vị phê duyệt, mỗi báo cáo gửi lên sinh một phiên chạy `report.accept` với các bước người duyệt đơn vị, Ban KHĐT rà soát, chốt kỳ, đẩy số; mỗi bước có hạn tính theo giờ làm việc trên lịch làm việc, nhắc ở 80% thời gian và nhắc mỗi ngày làm việc khi quá hạn. Báo cáo chỉ thành `ACCEPTED` ở bước cuối, bằng đúng bước mà lệnh `post_reports_id_decision` làm khi một quyết định.
- **Giữ nguyên (R4):** duyệt, trả lại có lý do, yêu cầu điều chỉnh, kỳ khóa, bản đã gửi không sửa, mã lỗi của mỗi trường hợp. Trả lại ở bất kỳ bước nào gửi báo cáo về người lập như quyết định đơn; rút báo cáo kết thúc phiên chạy; báo cáo gửi trước khi chế độ `STAGED` được duyệt vẫn được quyết định như cũ.
- **Điểm khác duy nhất:** các bước thêm; câu trả lời của `post_reports_id_decision` ở bước chưa cuối là `STEP_APPROVED` (báo cáo còn `SUBMITTED`), và `getReportWorkflow` cho biết từng bước, hạn, người được giao.
- **Lệnh cuối bắt buộc (R14):** `report.accept` có lệnh cuối thật; bản không phải bản test không có đối tượng giả, loại nghiệp vụ được bật mà thiếu lệnh cuối thật thì tiến trình không khởi động.
- **Kênh Microsoft Teams:** nhắc việc đi qua cổng kênh thông báo; bộ điều hợp chỉ ghi thẻ vào thư mục hộp đi (`MACHVON_TEAMS_OUTBOX_DIR`) cho bộ chuyển của đơn vị vận hành, không gọi mạng; ở nơi chạy dữ liệu thật trạng thái là PROPOSED cho tới khi có hợp đồng bộ chuyển.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| D03: basis kỳ/YTD/PTD, lịch tuần, hạn, thời điểm khóa — CHỜ KÝ | Chủ nghiệp vụ vốn | Ký glossary MDM-34 + bộ số golden FX-DIS-001..007 |
| [CXN-03] Tử số/mẫu số hai tỷ lệ, xử lý CENTRAL_SUPPORT/REVENUE_INCREASE, ngày Kho bạc | Chủ nghiệp vụ vốn | CV 16437/BTC-ĐTPT bản gốc |
| [CXN-11] Mẫu TT 37/2025 và CV 3665 cho xuất báo cáo | Chủ nghiệp vụ vốn | Văn bản gốc → template DOC |
| PAY phải cung cấp `treasury_transaction.treasury_paid_on date` (hiện chỉ có `confirmed_at`) và `allocation_line_id` | PAY owner | Thêm cột + index + sự kiện v2 |
| test_fixtures.json chưa có FX-DIS/FX-CAP/FX-PRJ/FX-MDM | QA owner | Bổ sung fixtures theo ID ở §5 |
| MOB-13..22 cần cập nhật field hai tỷ lệ/CTMTQG OTHER và `client_operation_id` | MOB owner | Cập nhật screen MOB |
| Ngưỡng cảnh báo, ngưỡng loại khỏi xếp hạng [GIẢ ĐỊNH] | Sở Tài chính | Rule dữ liệu được duyệt |
