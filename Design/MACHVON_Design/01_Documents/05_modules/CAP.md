# CAP — Kế hoạch và nguồn vốn

Phiên bản đặc tả M1 · 22/10/2026 · Nguồn dữ liệu máy: `work/staging/capital.json` (bảng `capital_plan`, `plan_version`, `appropriation`, `allocation_line`, `allocation_balance`, `capital_ledger_entry`, `fund_reservation`, `avc_policy`, `reallocation_proposal`, `reallocation_line`, `allocation_extension`, `fiscal_year_control`, `disbursement_schedule_line`, `allocation_scenario`). Quy ước chung theo `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md`.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Sở Tài chính (sau hợp nhất Sở KH&ĐT vào Sở Tài chính năm 2025 [CXN-34]) phải quản lý vốn từ lúc được giao tới lúc tiêu: vốn Thủ tướng Chính phủ giao, vốn địa phương giao thêm, vốn kéo dài, vốn hỗ trợ/tăng thu; phân bổ cho dự án theo kế hoạch có quyết định; điều chỉnh, điều chuyển từ dự án chậm sang dự án nhanh; không bao giờ phân bổ quá nguồn, không giảm dưới số đã cam kết; tra lại kế hoạch tại mọi thời điểm. Mô hình học từ SAP PSM/Oracle Unifier: **FundSource → Appropriation → FundAssignment** (= `allocation_line`) với sổ cái, kiểm soát hạn mức khả dụng (AVC) có ngưỡng warn/block và giữ vốn (earmark).

**Trong phạm vi:** kế hoạch trung hạn và năm (capital_plan có revision, vòng DRAFT→IN_REVIEW→APPROVED→PUBLISHED→SUPERSEDED, văn bản quyết định); sổ appropriation theo nguồn (NSTW/NSĐP/CTMTQG/ODA), năm kế hoạch, loại giao; dòng phân bổ theo dự án (plan_version × allocation_line); sổ cái vốn append-only; số dư dòng vốn (allocated/reserved/committed/disbursed); AVC; earmark; đề xuất điều chuyển chậm→nhanh dựa trên snapshot DIS; kéo dài thời gian giải ngân có văn bản (`is_extended`, `extended_to`); khóa/mở năm kế hoạch; đăng ký giải ngân tháng, dự báo, kế hoạch tuần theo CĐ 162 [CXN-33]; mô phỏng phân bổ (không ghi ledger).

**Ngoài phạm vi:** soạn/ký văn bản giao vốn (DOC); thanh toán và giao dịch Kho bạc (PAY — CAP chỉ nhận sự kiện để ghi COMMIT/DISBURSE); báo cáo tuần (DIS); dự án (PRJ); danh mục nguồn vốn/CTMTQG (MDM).

**Phụ thuộc:** MDM (FUND_SOURCE, PROGRAM/CTMTQG, CALENDAR), PRJ (giai đoạn dự án, mã TTQG), DOC (văn bản), PAY (sự kiện `payment.submitted/cancelled`, `treasury.transaction_confirmed`), DIS (PeriodSnapshot làm căn cứ điều chuyển và EAC), IAM.

**Căn cứ.** Luật ĐTC 58/2024 (sửa 90/2025): kế hoạch trung hạn/năm, điều chỉnh, kéo dài thời gian thực hiện và giải ngân [CXN-31]; NĐ 85/2025 (sửa 275/2025) [CXN-13]; Luật NSNN 89/2025; NĐ 254/2025 + TT 91/2025 về thanh toán gắn năm kế hoạch nguồn [CXN-08]; Công điện 162/CĐ-TTg (kế hoạch giải ngân từng dự án, điều chuyển vốn dự án chậm) [CXN-33]; CV 16437/BTC-ĐTPT (hai mẫu số tỷ lệ) [CXN-03].

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Chuyên viên kế hoạch (planner, maker) | Đơn vị kế hoạch của tenant (Sở Tài chính) hoặc đơn vị cấp dưới được ủy quyền lập kế hoạch | `createCapitalPlan`, `draftCapitalAllocation`, `submitCapitalPlan`, `createCapitalPlanRevision`, `registerAppropriation`, `draftReallocationProposal`, `requestAllocationExtension`, `createAllocationScenario` | Tự duyệt bất kỳ đối tượng nào; sửa revision đã APPROVED/PUBLISHED; ghi ledger trực tiếp |
| Lãnh đạo phê duyệt (approver/checker) | Cấp phê duyệt theo DoA (ADM) | `decideCapitalPlan`, `post_plans_id_publish`, `decideAppropriation`, `decideReallocationProposal`, `applyReallocationProposal`, `decideAllocationExtension`, `publishAvcPolicy` | Duyệt hồ sơ chính mình soạn (CHECK `*_sod_chk` + 403) |
| Chủ đầu tư | Dự án thuộc scope | `registerDisbursementSchedule` (đăng ký tháng, dự báo, kế hoạch tuần), `createFundReservation` cho dự án mình, đọc kế hoạch/số dư dự án mình | Đọc dòng vốn dự án ngoài scope; điều chuyển |
| Người khóa năm | `capital.year.close` / `capital.year.reopen` | `closeFiscalYear`, `reopenFiscalYear` (người duyệt mở ≠ người đề nghị) | Mở lại không lý do/không thời hạn |
| Quản trị chính sách AVC | `capital.avc.manage` | `createAvcPolicyVersion` | Đặt `block_pct` > 100 |
| Auditor | Đọc toàn bộ theo scope + `capital.ledger.read` | Đọc ledger, as-of | Mọi command |
| PAY/treasury consumer (system) | Theo sự kiện | Ghi COMMIT/UNCOMMIT/DISBURSE/REVERSAL | Mọi thay đổi kế hoạch |

## 3. Luồng nghiệp vụ

**F1 — Ghi nguồn được giao (CAP-16, CAP-14).** Planner `registerAppropriation` với `fund_source_version_id`, `plan_year`, `origin` (PM_ASSIGNED = Thủ tướng giao; LOCAL_ADDED = HĐND/UBND giao thêm; CARRYOVER = kéo dài; CENTRAL_SUPPORT; REVENUE_INCREASE), `budget_level`, `amount_vnd`, `decision_document_id`. Approver `decideAppropriation` → PUBLISHED, ledger APPROPRIATE. Điều chỉnh giá trị giao = revision mới `supersedes_id`; nếu `amount_vnd` mới < `allocated_total_vnd` → 422 `APPROPRIATION_BELOW_ALLOCATED`.

**F2 — Lập và công bố kế hoạch (CAP-01/02/03/06/10/05).** (1) `createCapitalPlan` (ANNUAL hoặc MEDIUM_TERM) revision 1 DRAFT. (2) `draftCapitalAllocation` thêm/sửa dòng theo dự án: trong 1 transaction, khóa `appropriation` liên quan `FOR UPDATE` theo thứ tự id tăng dần, kiểm `allocated_total_vnd + Δ ≤ amount_vnd` (BR-CAP-02), CTMTQG ≤ dòng (BR-CAP-03), dự án ở PIPELINE/BUDGETED/IMPLEMENTATION/SUSPENDED (khác → `PROJECT_STAGE_INVALID`), năm chưa LOCKED. Cập nhật `allocated_total_vnd` (CHECK DB `appropriation_ceiling_chk`). (3) `submitCapitalPlan` → IN_REVIEW. (4) `decideCapitalPlan` approve → APPROVED (người khác). (5) `post_plans_id_publish` với `decision_document_id`: revision trước → SUPERSEDED, `plan_version` của dự án tạo/cập nhật theo revision, `allocation_balance.allocated_vnd` cập nhật, ledger ALLOCATE/REDUCE theo chênh lệch so với revision trước, kiểm BR-CAP-05 (revised ≥ committed + disbursed) và rule mã TTQG [CXN-01]. Outbox `capital.plan_published.v1` (PRJ chuyển BUDGETED; DIS dùng plan_version mới cho kỳ sau `effective_at`).
Lỗi: thiếu văn bản → 422 `DECISION_REQUIRED`; dòng dưới cam kết → 422 `REVISED_BELOW_COMMITTED` (liệt kê dòng); đồng thời hai planner trên cùng appropriation → một thắng, một `APPROPRIATION_EXCEEDED` hoặc 409 `VERSION_CONFLICT` (If-Match trên capital_plan).

**F3 — Điều chỉnh kế hoạch (CAP-07, CAP-15).** `createCapitalPlanRevision` copy dòng (gắn `previous_line_id`) thành DRAFT; đi lại F2 bước 2–5. CAP-15 so "Giao đầu năm / Điều chỉnh / Hiện hành / Giải ngân".

**F4 — Giữ vốn và AVC (CAP-17/18, CAP-06).** `createFundReservation` tính `consumption = (reserved + committed + disbursed + amount_mới) / allocated` theo policy hiệu lực (ưu tiên PROJECT_GROUP > UNIT > FUND_SOURCE > TENANT). ≥ `warn_pct` và chưa `avc_acknowledged` → 422 `AVC_WARNING_ACK_REQUIRED`; > `block_pct` → 422 `AVC_BLOCKED`. Thành công: ledger RESERVE, `reserved_vnd` tăng. Hết `expires_at`: job RELEASE (dedupe theo source_ref). Khi PAY gửi đề nghị gắn reservation: CONSUMED + RELEASE + COMMIT trong cùng transaction.

**F5 — Điều chuyển chậm→nhanh (CAP-19).** Planner chọn snapshot DIS FROZEN; hệ thống gợi ý dự án giảm (EAC < 80% kế hoạch hoặc rate dưới đường kỳ vọng ≥ 15 điểm) và dự án tăng (rate ≥ đường kỳ vọng và có nhu cầu đăng ký vượt vốn) [GIẢ ĐỊNH ngưỡng, dữ liệu]. `draftReallocationProposal` kiểm: cùng `appropriation` (cùng nguồn + cấp ngân sách + năm, khác → `TRANSFER_UNBALANCED`), dòng giảm còn ≥ committed+disbursed+reserved. Submit → decide (người khác) → `applyReallocationProposal` với văn bản: tạo capital_plan revision mới PUBLISHED trong 1 transaction, ledger TRANSFER_OUT/TRANSFER_IN cùng `source_ref_id = proposal.id`; nếu kế hoạch nguồn đã có revision mới sau khi lập đề xuất → 409 `PLAN_CHANGED_SINCE_PROPOSAL`.

**F6 — Kéo dài (CAP-20) và chuyển năm/khóa năm (CAP-11).** `requestAllocationExtension` cho phần chưa giải ngân của dòng năm Y (≤ allocated − disbursed − committed, ngược lại `AMOUNT_EXCEEDS_UNDISBURSED`). `decideAllocationExtension` approve cần `approving_document_id` (thiếu → `EXTENSION_DOCUMENT_REQUIRED`): tạo appropriation CARRYOVER năm Y+1 (`is_extended=true`, `extended_to`, `source_year=Y`) nếu chưa có, dòng mới bucket CARRYOVER trong kế hoạch Y+1, ledger EXTEND_OUT (Y) / EXTEND_IN (Y+1). Đóng năm: `closeFiscalYear` SOFT_CLOSED (chỉ còn nhận DISBURSE trong thời gian chỉnh lý [CXN-31]) → LOCKED (mọi command kế hoạch năm đó 409 `FISCAL_YEAR_LOCKED`; phần không kéo dài → LAPSE). Mở lại có lý do ≥ 20 ký tự, thời hạn ≤ 168 h, người duyệt khác.

**F7 — Đăng ký tháng, dự báo, kế hoạch tuần (CAP-08/12/13, DIS-24).** `registerDisbursementSchedule` tạo revision mới, revision cũ `is_current=false` (unique partial). REGISTERED (đăng ký tháng; DIS-05 cũng sinh từ báo cáo tuần qua `source_report_revision_id`), FORECAST (ước giải ngân, cần `assumption`), WEEKLY_COMMITMENT (kế hoạch tuần CĐ 162). Không bản nào là actual.

**F8 — Mô phỏng (CAP-09).** `createAllocationScenario` + `runAllocationScenario` lưu input snapshot, ràng buộc, giả định, kết quả; không ghi `capital_ledger_entry`/`allocation_line`. `promoteAllocationScenario` tạo `reallocation_proposal` DRAFT.

**F9 — Tra cứu theo thời điểm (CAP-21, AC09).** `getCapitalPlanAsOf?at=` chọn revision PUBLISHED/SUPERSEDED có `effective_at ≤ at` lớn nhất; trả dòng + văn bản. Báo cáo DIS luôn giữ `plan_version_id` đã chụp.

## 4. State machine

```
capital_plan:  DRAFT ──submit──► IN_REVIEW ──decide approve──► APPROVED ──publish(+văn bản)──► PUBLISHED ──(revision mới publish)──► SUPERSEDED
                 ▲                   │ decide return                                     
                 └───────────────────┘          IN_REVIEW ──decide reject──► REJECTED
fiscal_year_control:  OPEN ──close SOFT──► SOFT_CLOSED ──close LOCK──► LOCKED ──reopen(lý do, hạn, checker)──► OPEN ──(hết hạn, job)──► LOCKED
fund_reservation:     ACTIVE ──consume──► CONSUMED | ACTIVE ──release──► RELEASED | ACTIVE ──expire(job)──► EXPIRED
reallocation_proposal: DRAFT ─submit─► SUBMITTED ─decide─► APPROVED ─apply(+văn bản)─► APPLIED ; SUBMITTED ─► REJECTED ; DRAFT/SUBMITTED ─► WITHDRAWN
allocation_extension: REQUESTED ─approve(+văn bản)─► APPROVED ─apply─► APPLIED ; REQUESTED ─► REJECTED ; APPROVED quá extended_to chưa dùng ─► LAPSED
```

| Đối tượng | Từ | Command | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|---|
| capital_plan | DRAFT | `submitCapitalPlan` | IN_REVIEW | planner | ≥1 dòng; mọi dòng hợp lệ | `capital.plan_submitted.v1` |
| capital_plan | IN_REVIEW | `decideCapitalPlan` approve/return/reject | APPROVED/DRAFT/REJECTED | approver ≠ submitter | lý do | `capital.plan_decided.v1` |
| capital_plan | APPROVED | `post_plans_id_publish` | PUBLISHED (+ prev SUPERSEDED) | approver | văn bản; BR-CAP-05; mã TTQG [CXN-01]; năm không LOCKED | `capital.plan_published.v1` |
| capital_plan | PUBLISHED | `createCapitalPlanRevision` | (tạo revision DRAFT mới) | planner | không có revision DRAFT/IN_REVIEW khác | – |
| appropriation | DRAFT | `decideAppropriation` | PUBLISHED | approver ≠ creator | văn bản; CARRYOVER cần văn bản kéo dài | `capital.appropriation_published.v1` |
| fiscal_year | OPEN/SOFT_CLOSED | `closeFiscalYear` | SOFT_CLOSED/LOCKED | year.close | không có plan IN_REVIEW năm đó | `capital.fiscal_year_closed.v1` |
| fiscal_year | LOCKED | `reopenFiscalYear` | OPEN (tới `reopened_until`) | year.reopen ≠ người đề nghị | lý do ≥ 20; giờ ≤ 168 | `capital.fiscal_year_reopened.v1` |
| reallocation | APPROVED | `applyReallocationProposal` | APPLIED | reallocation.apply | văn bản; kế hoạch nguồn chưa đổi; BR-CAP-05 | `capital.reallocation_applied.v1` |
| extension | REQUESTED | `decideAllocationExtension` | APPROVED→APPLIED | extension.approve ≠ requester | văn bản | `capital.allocation_extended.v1` |

Bị cấm: sửa dòng của revision ≠ DRAFT (409 `PLAN_NOT_DRAFT`); publish từ DRAFT/IN_REVIEW (409 `PLAN_NOT_APPROVED`); hai revision PUBLISHED cùng `plan_code` (unique partial); UPDATE/DELETE ledger (REVOKE); áp dụng đề xuất REJECTED/WITHDRAWN.

## 5. Quy tắc nghiệp vụ và công thức

- **BR-CAP-01** Tiền VND nguyên `numeric(24,0)`; tỷ lệ numeric, làm tròn khi hiển thị (2 chữ số %).
- **BR-CAP-02 (trần nguồn)** Với mỗi appropriation: `Σ amount_vnd của allocation_line thuộc revision DRAFT/IN_REVIEW/APPROVED/PUBLISHED hiện hành ≤ amount_vnd` — duy trì bằng `allocated_total_vnd` dưới khóa hàng + CHECK. Vượt → 422 `APPROPRIATION_EXCEEDED` kèm `available_vnd`.
- **BR-CAP-03 (CTMTQG là tập con)** `0 ≤ ctmtqg_subset_vnd ≤ amount_vnd`; tổng vốn = Σ `amount_vnd`, **không** cộng `ctmtqg_subset_vnd`. Ví dụ 1 tỷ (trong đó CTMTQG 400 triệu) + 500 triệu NSĐP = 1,5 tỷ.
- **BR-CAP-04 (năm nguồn và kéo dài)** Mỗi dòng có `source_year` (niên độ gốc). `bucket = CARRYOVER` ⇔ `is_extended = true` và có `extension_document_id`; `extended_to` là hạn cuối giải ngân. Thanh toán (PAY) phải chọn dòng theo năm kế hoạch nguồn; quá `extended_to` phần còn lại → LAPSE khi khóa năm [CXN-31].
- **BR-CAP-05 (revised ≥ committed)** Với mỗi dòng: `allocated_vnd_mới ≥ committed_vnd + disbursed_vnd` (CHECK `allocation_balance_revised_ge_committed_chk`). Giữ vốn (reserved) không chặn ở DB mà qua AVC. Vi phạm → 422 `REVISED_BELOW_COMMITTED`.
- **BR-CAP-06 (AVC)** `consumption_pct = (reserved [nếu include_reservations] + committed + disbursed) / allocated × 100`; allocated = 0 → BLOCK mọi tiêu dùng (`AVC_BLOCKED`, lý do ZERO_ALLOCATION). OK nếu < warn; WARN nếu warn ≤ x ≤ block (cần xác nhận, lưu `avc_warning_acknowledged` + audit); BLOCK nếu > block. `warn_pct ≤ block_pct ≤ 100`; mặc định tenant 90/100 [GIẢ ĐỊNH].
- **BR-CAP-07 (điều chuyển cân bằng)** Mỗi `reallocation_line` chuyển nguyên số tiền từ một dòng sang một dự án khác cùng appropriation; tổng appropriation không đổi; NSTW↔NSĐP hoặc khác năm → `TRANSFER_UNBALANCED`.
- **BR-CAP-08 (đăng ký ≠ thực hiện)** REGISTERED/FORECAST/WEEKLY_COMMITMENT không bao giờ cộng vào disbursed. Tỷ lệ đạt đăng ký tháng = disbursed_treasury_tháng / registered_tháng; registered = 0 hoặc null → "Chưa có đăng ký".
- **BR-CAP-09 (trung hạn)** Σ kế hoạch năm (đã giao + dự kiến) của dự án trong giai đoạn > trần trung hạn → cảnh báo `MEDIUM_TERM_CEILING_EXCEEDED` (không chặn) [GIẢ ĐỊNH, CXN-13].
- **BR-CAP-10 (as-of)** Kế hoạch tại thời điểm t = revision PUBLISHED/SUPERSEDED có `effective_at ≤ t` lớn nhất; không bao giờ xóa revision cũ.
- **BR-CAP-11 (hai mẫu số)** Kế hoạch TTg giao = Σ appropriation origin PM_ASSIGNED (+ CENTRAL_SUPPORT nếu chính sách tenant tính vào, [CXN-03]); kế hoạch gồm giao thêm = PM_ASSIGNED + LOCAL_ADDED (+ REVENUE_INCREASE theo chính sách). CAP cung cấp `plan_pm_assigned_vnd` và `plan_local_added_vnd` cho snapshot DIS theo dòng.

## 6. Dữ liệu

| Bảng | Vai trò | Ràng buộc chính | Classification | Retention |
|---|---|---|---|---|
| `capital_plan` (mới) | Kế hoạch trung hạn/năm, mỗi dòng = một revision bất biến sau APPROVED | UNIQUE (tenant, plan_code, revision); unique partial một PUBLISHED; PUBLISHED ⇒ văn bản + effective_at; approved_by ≠ submitted_by | INTERNAL | Vĩnh viễn |
| `plan_version` (sửa) | Kế hoạch của một dự án trong một revision; + `capital_plan_id`, `superseded_by_id`, `approved_by`, `published_at`, audit | UNIQUE (tenant, capital_plan_id, project_id); CHECK status | INTERNAL | Vĩnh viễn |
| `appropriation` (mới) | Nguồn được giao theo nguồn/năm/loại giao/cấp ngân sách | `allocated_total_vnd ≤ amount_vnd`; kéo dài nhất quán; CARRYOVER ⇒ source_year < plan_year | INTERNAL | Vĩnh viễn |
| `allocation_line` (sửa) = FundAssignment | + `appropriation_id`, `project_id`, `budget_level`, `origin`, `is_extended`, `extended_to`, `extension_document_id`, `program_master_version_id`, `previous_line_id`, audit | CHECK bucket/level/kéo dài; UNIQUE (plan_version, appropriation, bucket, source_year); CTMTQG ≤ amount (đã có) | INTERNAL | Vĩnh viễn |
| `allocation_balance` (mới) | Số dư khóa hàng cho mỗi dòng PUBLISHED hiện hành | UNIQUE dòng; `allocated ≥ committed + disbursed` | INTERNAL | Theo dòng |
| `capital_ledger_entry` (mới) | Sổ cái append-only | dedupe (source_ref_kind, source_ref_id, entry_type, allocation_line_id); REVERSAL ⇔ reversal_of_id; REVOKE UPDATE/DELETE | INTERNAL | Vĩnh viễn |
| `fund_reservation` (mới) | Earmark | RELEASED ⇒ lý do | INTERNAL | 10 năm |
| `avc_policy` (mới) | Ngưỡng warn/block, dữ liệu có legal_basis + hiệu lực | warn ≤ block ≤ 100; maker ≠ checker | INTERNAL | Vĩnh viễn (phiên bản) |
| `reallocation_proposal`, `reallocation_line` (mới) | Điều chuyển | from ≠ to project; APPLIED ⇒ văn bản + kế hoạch kết quả | INTERNAL | Vĩnh viễn |
| `allocation_extension` (mới) | Kéo dài | APPROVED/APPLIED ⇒ văn bản | INTERNAL | Vĩnh viễn |
| `fiscal_year_control` (mới) | Trạng thái năm | UNIQUE năm; LOCKED ⇔ locked_at | INTERNAL | Vĩnh viễn |
| `disbursement_schedule_line` (mới) | Đăng ký/dự báo/kế hoạch tuần | CTMTQG ≤ amount; MONTH ⇒ month, WEEK ⇒ period_id; một current/khóa | INTERNAL | 10 năm |
| `allocation_scenario` (mới) | Mô phỏng | – | INTERNAL | 2 năm sau ARCHIVED [GIẢ ĐỊNH] |

Mọi `*_id` có index `(tenant_id, col)`; FK composite; RLS ENABLE+FORCE + `tenant_boundary` + `tenant_guard` RESTRICTIVE. Migration: backfill `capital_plan` từ cặp (fiscal_year, decision_id) của `plan_version` cũ; `allocation_line.appropriation_id` gán theo (nguồn, năm, cấp) với appropriation tạo từ văn bản giao cũ; sau backfill SET NOT NULL.

## 7. API / command

| operationId | Method path | x-permission | DTO | Lỗi chính | Idem | If-Match |
|---|---|---|---|---|---|---|
| `createCapitalPlan` | POST /capital-plans | capital.plan.draft | `CapCapitalPlanCreate` | 409 PLAN_CODE_DUPLICATE, FISCAL_YEAR_LOCKED | ✔ | – |
| `draftCapitalAllocation` | POST /capital-plans/{id}/allocations | capital.plan.draft | `CapAllocationDraft` (lines: project, appropriation, bucket, source_year, amount, ctmtqg) | 422 APPROPRIATION_EXCEEDED/SUBSET_EXCEEDS_PARENT/PROJECT_STAGE_INVALID; 409 PLAN_NOT_DRAFT/VERSION_CONFLICT/IDEMPOTENCY_CONFLICT | ✔ | ✔ |
| `submitCapitalPlan` | POST /capital-plans/{id}/submit | capital.plan.submit | – | 409 PLAN_NOT_DRAFT | ✔ | ✔ |
| `decideCapitalPlan` | POST /capital-plans/{id}/decision | capital.plan.approve | `MdmDecision` | 403 SELF_APPROVAL_DENIED | ✔ | ✔ |
| `post_plans_id_publish` | POST /plans/{id}/publish | plan.publish | `CapPublish` | 422 DECISION_REQUIRED/REVISED_BELOW_COMMITTED/NATIONAL_CODE_REQUIRED; 409 PLAN_NOT_APPROVED | ✔ | ✔ |
| `createCapitalPlanRevision` | POST /capital-plans/{id}/revisions | capital.plan.draft | `CapPlanRevision` | 409 PLAN_NOT_PUBLISHED/REVISION_PENDING_EXISTS | ✔ | ✔ |
| `registerAppropriation` / `decideAppropriation` | POST /appropriations; /appropriations/{id}/decision | capital.appropriation.manage/approve | `CapAppropriation` / `MdmDecision` | 422 DECISION_REQUIRED/EXTENSION_DOCUMENT_REQUIRED/APPROPRIATION_BELOW_ALLOCATED | ✔ | ✔ (decision) |
| `createFundReservation` / `releaseFundReservation` | POST /fund-reservations; /{id}/release | capital.reservation.manage | `CapReservation` / `CapReservationRelease` | 422 AVC_WARNING_ACK_REQUIRED/AVC_BLOCKED; 409 RESERVATION_NOT_ACTIVE | ✔ | ✔ (release) |
| `createAvcPolicyVersion` / `publishAvcPolicy` | POST /avc-policies; /{id}/publish | capital.avc.manage/approve | `CapAvcPolicy` | 422 AVC_THRESHOLD_INVALID; 403 SELF_APPROVAL_DENIED | ✔ | ✔ (publish) |
| `draftReallocationProposal`, `submitReallocationProposal`, `decideReallocationProposal`, `applyReallocationProposal` | POST /reallocation-proposals[/{id}/submit\|decision\|apply] | capital.reallocation.propose/approve/apply | `CapReallocationProposal`, `MdmDecision`, `CapApplyDecision` | 422 TRANSFER_UNBALANCED/REVISED_BELOW_COMMITTED/SNAPSHOT_NOT_FROZEN; 409 PLAN_CHANGED_SINCE_PROPOSAL | ✔ | ✔ |
| `requestAllocationExtension` / `decideAllocationExtension` | POST /allocation-lines/{id}/extensions; /allocation-extensions/{id}/decision | capital.extension.request/approve | `CapExtensionRequest` / `CapExtensionDecision` | 422 EXTENSION_NOT_ALLOWED/AMOUNT_EXCEEDS_UNDISBURSED/EXTENSION_DOCUMENT_REQUIRED | ✔ | ✔ (decision) |
| `closeFiscalYear` / `reopenFiscalYear` | POST /fiscal-years/{year}/close, /reopen | capital.year.close/reopen | `CapYearClose` / `CapYearReopen` | 409 YEAR_STATE_INVALID; 403 SELF_APPROVAL_DENIED; 422 REOPEN_REASON_REQUIRED | ✔ | ✔ |
| `registerDisbursementSchedule` | POST /disbursement-schedules | capital.schedule.register | `CapScheduleInput` | 422 SUBSET_EXCEEDS_PARENT; 409 PERIOD_LOCKED | ✔ | – (revision mới) |
| `listDisbursementSchedules` | GET /disbursement-schedules | capital.read | – | 404 ngoài scope | – | – (bản hiện hành mỗi khóa; đăng ký tháng kèm giải ngân và tỷ lệ đạt) |
| `createAllocationScenario`, `runAllocationScenario`, `promoteAllocationScenario` | POST /allocation-scenarios[/{id}/run\|promote] | capital.scenario.run / capital.reallocation.propose | `CapScenario` | 422 SCENARIO_CONSTRAINT_INFEASIBLE; 409 SCENARIO_NOT_RUN | ✔ | ✔ |
| `getCapitalAvailability` | GET /capital/availability | capital.read | – | – | – | – |
| `getCapitalPlanAsOf`, `listCapitalPlanLines`, `listAppropriations`, `listCapitalLedger`, `listReallocationProposals` | GET | capital.read / capital.ledger.read | – | 404 ngoài scope | – | – |

**GET scaffold:** `/resources/plan_version[/{id}]` → `dto` (DRAFT chỉ cho người soạn/duyệt); `/resources/allocation_line[/{id}]` → `dto` (tiền chuỗi decimal, theo scope; UI dùng `listCapitalPlanLines`). Không có endpoint ghi chung cho status/số tiền đã PUBLISHED; ledger không có command ghi trực tiếp.

## 8. UI/UX

Giữ CAP-01…CAP-15. Field thêm: CAP-03 + "Năm nguồn", "Kéo dài đến", "Văn bản cho phép kéo dài", "Trong đó CTMTQG" (FR-CAP-03/20); CAP-04 + "ODA" (FR-CAP-04); CAP-06 + "Đã cam kết", "Đã giữ vốn", "Ngưỡng AVC" (FR-CAP-06/17); CAP-10 + "Văn bản quyết định" (FR-CAP-10).

Mới: **CAP-16** sổ appropriation (DataTable cột ghim nguồn/năm; "Còn lại" = amount − allocated; badge loại giao); **CAP-17** chính sách AVC (policy editor: hai thanh ngưỡng warn/block có số %, preview số dòng đang WARN/BLOCK); **CAP-18** giữ vốn (DataTable + đếm ngược hết hạn); **CAP-19** điều chuyển (ComparePanel: trái dự án giảm — tỷ lệ, EAC, cam kết; phải dự án tăng; footer cân bằng tổng = 0, nút "Áp dụng" chỉ khi APPROVED + văn bản); **CAP-20** kéo dài (form + kiểm phần chưa giải ngân); **CAP-21** sổ cái + bộ chọn thời điểm (FiscalPeriodPicker "Xem tại ngày").
MoneyInput hiển thị triệu đồng nhưng gửi VND nguyên (chia chính xác 1.000.000, không float). Trạng thái riêng: "Năm đã khóa sổ" (banner đỏ, mọi nút ghi disabled), "AVC cảnh báo" (hộp xác nhận nêu % và ngưỡng), "Kế hoạch đã bị thay thế" (nhãn trên revision SUPERSEDED). Mobile: MOB-12 đọc kế hoạch vốn dự án (không command).

## 9. Sự kiện, job, tích hợp, quan sát

Events: `capital.plan_submitted.v1`, `capital.plan_decided.v1`, `capital.plan_published.v1 {capital_plan_id, revision, plan_year, effective_at, decision_document_id, project_ids[]}`, `capital.appropriation_published.v1`, `capital.reservation_created.v1`, `capital.reservation_released.v1`, `capital.avc_policy_published.v1`, `capital.reallocation_applied.v1`, `capital.allocation_extended.v1`, `capital.fiscal_year_closed.v1`, `capital.fiscal_year_reopened.v1`, `capital.schedule_registered.v1`.
Consumers: PAY `payment.submitted.v1` → COMMIT (+ CONSUMED reservation), `payment.cancelled.v1` → UNCOMMIT, `treasury.transaction_confirmed.v1` → UNCOMMIT + DISBURSE theo `treasury_paid_on` (cần PAY bổ sung trường, §13), reversal → REVERSAL; DIS `report.accepted.v1` → upsert REGISTERED tháng sau từ `next_month_registered_vnd`. Mọi consumer dedupe qua unique ledger.
Jobs: `capital.reservation-expiry` (15 phút), `capital.year-reopen-expiry` (15 phút), `capital.balance-reconcile` (đêm: Σ ledger = allocation_balance; lệch → incident DGV + cảnh báo). Cache `t:{tenant}:cap:avail:{line}` vô hiệu khi ledger ghi. Metric: `cap_avc_block_total`, `cap_balance_drift_vnd` (phải = 0), `cap_publish_latency_ms`.

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Setup | Input/Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC08 | integration (đồng thời) | P0 | FX-CAP-001 (10 tỷ, đã 9 tỷ) | 2 phân bổ 800 triệu song song | 1 thành công, 1 APPROPRIATION_EXCEEDED | DB + ledger |
| UAT-AC09 | business | P0 | rev1/rev2 PUBLISHED | as-of 30/6 và 2/7 | 5 tỷ / 4,2 tỷ | API |
| UAT-AC220 | business | P0 | văn bản giao | 2 appropriation | CAP-16, HOME-07 tách | UI |
| UAT-AC221 | domain | P0 | còn 5 tỷ | thêm 6 tỷ | 422 + available | API |
| UAT-AC222 | domain | P0 | FX-CAP-002 | CTMTQG > dòng; tổng | 422; 1,5 tỷ | API |
| UAT-AC223 | security | P0 | DRAFT | tự duyệt; publish thiếu văn bản | 403; 422; PUBLISHED | audit |
| UAT-AC224 | business | P0 | r1 PUBLISHED | revision −0,8/+0,8 tỷ | CAP-15 đúng | UI |
| UAT-AC225 | domain | P0 | FX-CAP-003 | giảm còn 8,5 / 9 tỷ | 422 / 200 | DB CHECK |
| UAT-AC226 | domain | P0 | AVC 90/100 | giữ 150tr, 60tr | ACK required; BLOCK | API |
| UAT-AC227 | integration (idempotency) | P1 | RS-1 | job hết hạn 2 lần | 1 RELEASE | ledger |
| UAT-AC228 | business | P0 | S-40 FROZEN | điều chuyển 2 tỷ; NSTW→NSĐP | APPLIED; 422 | ledger |
| UAT-AC229 | business | P0 | dòng 2025 | kéo dài | CARRYOVER 2026 is_extended | DB |
| UAT-AC230 | security | P0 | 2025 LOCKED | ghi; mở lại tự duyệt | 409; 403; mở 24h | audit |
| UAT-AC231 | business | P1 | đăng ký 800tr | so thực hiện | không cộng vào actual | DIS-19 |
| UAT-AC232 | business | P1 | dự báo | sửa dự báo | EAC 650→700tr | API |
| UAT-AC233 | domain | P1 | đếm ledger | chạy mô phỏng | không đổi | DB count |
| UAT-AC234 | security | P0 | E1 | UPDATE trực tiếp | permission denied | DB log |
| UAT-AC235 | business | P1 | hỗ trợ/tăng thu | phân bổ | CAP-14/HOME-07 | UI |
| UAT-AC236 | business | P1 | trung hạn 20 tỷ | năm 2028 | warning | API |
| UAT-AC237 | security | P0 | scope U-BQL1 | đọc/ghi dòng U-BQL2 | lọc; 404 | API |
| UAT-AC238 | idempotency | P0 | DRAFT v5 | lặp key; key khác payload | cùng kết quả; 409 | idempotency_record |
| UAT-AC239 | domain | P1 | CARRYOVER sai | thiếu văn bản; năm sai | 422 | DB CHECK |
| UI-CAP-16…UI-CAP-21 | screen-contract | theo phase | synthetic | 7 trạng thái | đúng field/rule | screenshot |

Fixture: **FX-CAP-001** appropriation 10.000.000.000, đã phân bổ 9.000.000.000, hai yêu cầu 800.000.000; **FX-CAP-002** dòng 1.000.000.000 (CTMTQG 400.000.000) + 500.000.000 NSĐP → 1.500.000.000; **FX-CAP-003** allocated 10.000.000.000, committed 6.000.000.000, disbursed 3.000.000.000.

## 11. Tiêu chí nghiệm thu

- **AC-CAP-01** Given còn 200 triệu khả dụng, When hai phân bổ 800 triệu đồng thời, Then đúng một thành công và `allocated_total_vnd ≤ amount_vnd`. → UAT-AC08, UAT-AC221
- **AC-CAP-02** Given revision đã bị thay thế, When tra as-of ngày cũ, Then trả đúng số và văn bản của revision cũ. → UAT-AC09, UAT-AC224
- **AC-CAP-03** Given CTMTQG > dòng cha, Then 422 `SUBSET_EXCEEDS_PARENT`; tổng không cộng CTMTQG. → UAT-AC222
- **AC-CAP-04** Given kế hoạch do A soạn, When A duyệt, Then 403; publish thiếu văn bản → 422 `DECISION_REQUIRED`. → UAT-AC223
- **AC-CAP-05** Given cam kết + giải ngân 9 tỷ, When giảm dòng xuống 8,5 tỷ, Then 422 `REVISED_BELOW_COMMITTED`. → UAT-AC225
- **AC-CAP-06** Given AVC 90/100, When tiêu dùng 95% chưa xác nhận / 101%, Then 422 ACK_REQUIRED / BLOCKED. → UAT-AC226, UAT-AC227
- **AC-CAP-07** Given đề xuất NSTW→NSĐP, Then 422 `TRANSFER_UNBALANCED`; đề xuất hợp lệ áp dụng tạo revision mới với tổng không đổi. → UAT-AC228
- **AC-CAP-08** Given kéo dài có văn bản, Then dòng CARRYOVER năm sau `is_extended=true`, `source_year` gốc, vốn năm không tăng. → UAT-AC229, UAT-AC239
- **AC-CAP-09** Given năm LOCKED, Then mọi command kế hoạch 409 `FISCAL_YEAR_LOCKED`; mở lại cần người duyệt khác và tự hết hạn. → UAT-AC230
- **AC-CAP-10** Given mô phỏng chạy, Then không có bút toán ledger mới; ledger không thể UPDATE. → UAT-AC233, UAT-AC234
- **AC-CAP-11** Given cùng Idempotency-Key khác payload, Then 409 `IDEMPOTENCY_CONFLICT`. → UAT-AC238

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1:** F1, F2, F3, F9 (as-of), F7 REGISTERED; AVC với một policy TENANT; ledger + balance + consumer PAY; khóa năm cơ bản; CAP-01..08, 10, 11, 14, 15, 16, 17, 19, 20. Đúng số với FX-CAP-001..003.
**R2:** earmark đầy đủ (CAP-18), AVC nhiều phạm vi, điều chuyển gợi ý tự động, mô phỏng (CAP-09), dự báo/EAC (CAP-12/13), sổ cái UI (CAP-21), trung hạn nhiều năm.
**R3:** đối chiếu với dữ liệu Kho bạc/TABMIS qua tệp khi có mẫu thật (D05).
**Giờ review người:** đường tiền (ledger, balance, AVC, khóa) 8 h; maker-checker và quyền 3 h; migration plan_version/allocation_line 4 h; quy tắc pháp lý kéo dài/hai mẫu số [CXN-31]/[CXN-03] 3 h. Tổng ≈ 18 h.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| [CXN-31] (đề xuất thêm vào sổ) Thời hạn kéo dài, thẩm quyền cho phép, thời gian chỉnh lý quyết toán năm | Chủ nghiệp vụ vốn / Pháp chế | Văn bản gốc Luật 58/2024 sửa 90/2025 + NĐ hướng dẫn; seed rule |
| [CXN-03] Hai mẫu số: có tính CENTRAL_SUPPORT/REVENUE_INCREASE vào "KH TTg giao" không | Chủ nghiệp vụ vốn | CV 16437/BTC-ĐTPT gốc; cấu hình chính sách tenant |
| Ngưỡng AVC 90/100 và ngưỡng gợi ý điều chuyển [GIẢ ĐỊNH] | Sở Tài chính | Ban hành chính sách tenant (dữ liệu) |
| PAY cần phát `treasury_paid_on` và liên kết `allocation_line_id` trong sự kiện thanh toán | PAY owner | Bổ sung trường + event version (cross-module) |
| DoA (ai duyệt kế hoạch theo giá trị) | ADM owner | Ma trận DoA cấu hình theo tenant |
| Migration dữ liệu kế hoạch cũ (D04) | Data Owner | Mapping văn bản giao vốn ↔ appropriation |
