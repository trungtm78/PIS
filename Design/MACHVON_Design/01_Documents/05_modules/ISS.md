# ISS — Vướng mắc và hiện trường

Đặc tả phân hệ theo `_KHUNG_DAC_TA.md`, baseline 1.4 (22/10/2026). Quy ước chung ở `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md`. Baseline FRD UC05 (Open → Assigned → InProgress → PendingVerification → Closed; Reopened có lý do; Escalated không tự đóng việc gốc; giữ ngày quá hạn khi chuyển đơn vị; người kiểm tra khác người xử lý khi cấu hình yêu cầu; offline chỉ nháp; vị trí chỉ khi đồng ý) được giữ nguyên và chi tiết hóa.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Giải ngân chậm chủ yếu do vướng mắc (GPMB, giấy phép, chất lượng, thủ tục thanh toán) không có người chịu trách nhiệm, không có hạn và không được đẩy lên cấp có thẩm quyền. Công điện 162/CĐ-TTg yêu cầu phân công người đứng đầu và tổ công tác theo dõi, giải trình.

**Trong phạm vi.** Ghi nhận vướng mắc (thủ công, từ thiết bị di động, hoặc tự động từ LND/PMT/QMS/PAY/CTR/AST/AUD); phân công, xử lý, bằng chứng, xác nhận độc lập; SLA theo nhóm × mức độ × đơn vị trên lịch làm việc; leo thang 3 cấp (đơn vị chủ quản → lãnh đạo phụ trách → tổ công tác); gia hạn có giới hạn; chuyển đơn vị giữ số ngày quá hạn; ma trận tuần (ISS-06, ISS-08); kiểm tra hiện trường (ISS-05).

**Ngoài phạm vi.** Định nghĩa tổ công tác và người đứng đầu (PRJ sở hữu `task_force`, `task_force_member`, `project_accountability`); giải trình tiến độ giải ngân (PRJ `explanation_request`); thông báo (NOT); nội dung chi tiết của nguồn (ví dụ nội dung khiếu nại GPMB ở LND — ISS chỉ giữ mã tham chiếu).

**Phụ thuộc.** ISS → PRJ, ADM, MDM (nhóm vướng mắc `master_record_version`); nhận sự kiện từ LND, PMT, QMS, PAY, CTR, AST để tạo vướng mắc; phát sự kiện cho HOME/BI/NOT.

**Căn cứ.** Công điện 162/CĐ-TTg (kế hoạch tuần, cảnh báo sớm, giao trách nhiệm) [CXN-03 liên quan DIS]; Luật BVDLCN 91/2025 (vị trí là dữ liệu cá nhân → cần đồng ý); thực tiễn: Procore Issues/RFIs, Jira Service Management (SLA trên lịch làm việc, escalation policy).

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Người báo (Ban QLDA, chủ đầu tư, xã, nhà thầu khách) | UNIT_TREE / PROJECT / CONTRACT | `issue.create`, `issue.work` (bình luận, bằng chứng) trên vướng mắc mình báo | Đóng, gia hạn, leo thang thay người có quyền |
| Người xử lý (assignee) | Đơn vị được giao | `issue.work`, `request-verification` | Tự xác nhận đóng khi policy yêu cầu độc lập |
| Trưởng đơn vị / điều phối | UNIT_TREE | `issue.assign`, `issue.extend`, `issue.escalate`, `issue.close` | Gia hạn vướng mắc do chính mình đề xuất |
| Lãnh đạo phụ trách / tổ công tác | PROJECT hoặc phạm vi tổ | `issue.escalation.accept`, `issue.assign`, `issue.close` | Truy cập dữ liệu cá nhân nguồn (LND) không có quyền riêng |
| Quản trị SLA (Tenant Admin/Chủ nghiệp vụ) | TENANT | `issue.sla.manage` | Sửa phiên bản chính sách đang áp dụng |
| Hệ thống (job, consumer) | Service principal theo tenant | Tạo vướng mắc từ nguồn, leo thang tự động, ghi SLA_BREACHED | Đóng vướng mắc |

## 3. Luồng nghiệp vụ

### 3.1 Vòng đời và SLA (UC-ISS-01) — ISS-01, ISS-02, ISS-03, ISS-06, ISS-07, ISS-08, ISS-09, ISS-11
1. `createIssue` (web hoặc app; `client_operation_id` bắt buộc để idempotent khi offline). Hệ thống chọn `issue_sla_policy` ACTIVE theo (nhóm, mức độ, đơn vị) — ưu tiên chính sách của đơn vị, nếu không có thì mặc định tenant — và lưu `sla_policy_id`; tính `response_due_at` và `due_at` theo lịch `calendar_code`. Không có chính sách → 422 `SLA_POLICY_MISSING`.
2. `assignIssue` (OPEN/ASSIGNED/IN_PROGRESS/REOPENED → ASSIGNED); `startIssue` ghi `responded_at`.
3. Xử lý: `commentIssue` (ghi `issue_event`, tài liệu đã quét virus).
4. `requestIssueVerification` kèm bằng chứng (bắt buộc khi `require_evidence`) → PENDING_VERIFICATION.
5. `closeIssue` bởi người khác assignee khi `require_independent_verifier` → CLOSED (CHECK `issue_close_chk`, `issue_verifier_chk`). Từ chối xác nhận: người xác nhận gọi `assignIssue` lại cho người xử lý kèm lý do.
6. `reopenIssue` trong cửa sổ cấu hình (mặc định 30 ngày [GIẢ ĐỊNH]) → REOPENED, `reopen_count + 1`.
7. `transferIssueUnit` đổi `owner_unit_id`, giữ `due_at`, `overdue_since`; `extendIssueDeadline` đổi `due_at` (tối đa 2 lần mặc định [GIẢ ĐỊNH], người duyệt khác người đề xuất), `overdue_since` không bị xóa để báo cáo trung thực.
8. Nguồn tự động (ISS-11): consumer nhận sự kiện (`pmt.permit.expired.v1`, `lnd.complaint.filed.v1`, `lnd.deadline.breached.v1`, `qms.ncr.raised.v1` mức CRITICAL, `pay.advance.overdue.v1`, `pay.reconciliation.overdue.v1`, `ast.warranty_claim.overdue.v1`) và gọi `createIssue` với `source_module` + `source_ref_id`; nếu đã có vướng mắc mở cho cùng nguồn → bỏ qua (`DUPLICATE_SOURCE_OPEN`). Tiêu đề/mô tả chỉ chứa mã và nhóm, không chứa dữ liệu cá nhân.

### 3.2 Leo thang (UC-ISS-02) — ISS-04, ISS-10
Job `issue-sla` chạy mỗi 15 phút: khi thời gian làm việc đã trôi ≥ `escalate_l2_pct`% thời hạn xử lý → tạo `issue_escalation` cấp 2 tới đơn vị chủ quản (lãnh đạo phụ trách theo `project_accountability`), trạng thái ESCALATED; ≥ `escalate_l3_pct`% → cấp 3 tới tổ công tác ACTIVE có phạm vi dự án/đơn vị; ghi `SLA_BREACHED` và `overdue_since` khi vượt 100%. Leo thang thủ công `escalateIssue` theo cùng quy tắc. Bên nhận `acceptIssueEscalation` → IN_PROGRESS; vướng mắc gốc không bao giờ tự đóng. Đồng thời: unique `issue_escalation_open_uq` (một leo thang mở mỗi cấp).

## 4. State machine

```
OPEN ─assign─► ASSIGNED ─start─► IN_PROGRESS ─request-verification─► PENDING_VERIFICATION ─close─► CLOSED ─reopen─► REOPENED ─assign─► ASSIGNED
                  │  ▲                │  ▲                                  │ (từ chối: assign lại)
                  └──┴─ escalate ─► ESCALATED ─accept-escalation─► IN_PROGRESS
```

| Từ | Command | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|
| ∅ | `createIssue` | OPEN | `issue.create` | SLA policy tồn tại; vị trí cần đồng ý | `iss.issue.opened.v1` |
| OPEN/ASSIGNED/IN_PROGRESS/REOPENED | `assignIssue` | ASSIGNED | `issue.assign` | assignee trong scope | `iss.issue.assigned.v1` |
| ASSIGNED | `startIssue` | IN_PROGRESS | `issue.work` (assignee) | — | `iss.issue.started.v1` |
| ASSIGNED/IN_PROGRESS | `escalateIssue` / job | ESCALATED | `issue.escalate` / hệ thống | cấp 3 cần tổ công tác ACTIVE | `iss.issue.escalated.v1` |
| ESCALATED | `acceptIssueEscalation` | IN_PROGRESS | `issue.escalation.accept` | thuộc đơn vị/tổ nhận | `iss.issue.escalation_accepted.v1` |
| IN_PROGRESS | `requestIssueVerification` | PENDING_VERIFICATION | `issue.work` | bằng chứng khi policy yêu cầu | `iss.issue.verification_requested.v1` |
| PENDING_VERIFICATION | `closeIssue` | CLOSED | `issue.close` | khác assignee; CHECK DB | `iss.issue.closed.v1` |
| CLOSED | `reopenIssue` | REOPENED | `issue.reopen` | trong cửa sổ; lý do | `iss.issue.reopened.v1` |

Cấm (409 `ISSUE_STATE_INVALID`): OPEN→CLOSED, ESCALATED→CLOSED, IN_PROGRESS→CLOSED (bỏ xác nhận), CLOSED→IN_PROGRESS trực tiếp; mọi ghi `status` trực tiếp.

## 5. Quy tắc nghiệp vụ và công thức

- **BR-ISS-01 (thời gian làm việc).** `due(t0, h) = t0 + h giờ làm việc` theo lịch `calendar_code` (khung giờ, ngày nghỉ, ngày lễ theo `calendar_version`); thời điểm tạo ngoài giờ được dời tới đầu giờ làm việc kế tiếp. Ví dụ thứ Sáu 16:00, phản hồi 4 giờ, khung 07:30–17:00 → thứ Hai 10:30.
- **BR-ISS-02 (phiên bản SLA).** Vướng mắc giữ `sla_policy_id` tại thời điểm tạo; phiên bản mới chỉ áp cho vướng mắc tạo sau `valid_from`.
- **BR-ISS-03 (tỷ lệ SLA).** `elapsed_pct = giờ làm việc đã trôi / resolve_hours × 100`; cấp 2 khi ≥ `escalate_l2_pct`, cấp 3 khi ≥ `escalate_l3_pct` (mặc định 100/150).
- **BR-ISS-04 (quá hạn).** `overdue_since` = thời điểm đầu tiên `now > due_at`; không bị xóa khi gia hạn/chuyển đơn vị; `overdue_days` hiển thị = ngày làm việc từ `overdue_since` tới khi đóng.
- **BR-ISS-05 (đóng độc lập).** Khi `require_independent_verifier`: `verifier_id ≠ assignee_id` và `closed_by = verifier_id`.
- **BR-ISS-06 (vị trí).** Lưu `geo_*` chỉ khi `geo_consent = true`; độ chính xác thấp (> 50 m [GIẢ ĐỊNH]) hiển thị cảnh báo; không tạo vị trí giả.
- **BR-ISS-07 (không trùng nguồn).** Tối đa một vướng mắc chưa CLOSED cho mỗi `(source_module, source_ref_id)`.
- **BR-ISS-08 (ma trận tuần).** `tồn cuối = tồn đầu + phát sinh − đã xử lý` theo đơn vị × nhóm × tuần ISO; tồn đầu tuần N = tồn cuối tuần N−1; dùng snapshot tuần khi kỳ đã khóa.

## 6. Dữ liệu

Phân hệ ISS sở hữu 4 bảng (1 bảng hiện có được mở rộng, 3 bảng mới). Quy ước chung: khóa chính `(tenant_id, id)`, khóa ngoại tổng hợp `(tenant_id, x_id)`, tiền `numeric(24,0)` VND nguyên, mọi bảng ENABLE + FORCE RLS với policy RESTRICTIVE `tenant_boundary` và PERMISSIVE `tenant_access` (04 §PostgreSQL và RLS). Mọi cột `*_id` có chỉ mục `<bảng>_<cột>_idx ON (tenant_id, <cột>)`. Cột NOT NULL thêm vào bảng hiện có được thêm nullable hoặc có DEFAULT, backfill rồi mới SET NOT NULL (expand-contract).

#### Bảng `issue_sla_policy` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `code` | text | có |  |  |  |
| `revision` | integer | có | 1 | revision > 0 |  |
| `category_version_id` | uuid | có |  | FK master_record_version | Nhóm vướng mắc (MDM) |
| `severity` | text | có |  | ∈ {LOW, MEDIUM, HIGH, CRITICAL} |  |
| `owner_unit_id` | uuid | không |  | FK organization_unit | NULL = mặc định toàn tenant |
| `calendar_code` | text | có | 'WORKDAY_VN' |  | Lịch làm việc để tính hạn |
| `response_hours` | integer | có |  | response_hours > 0 |  |
| `resolve_hours` | integer | có |  | resolve_hours > 0 |  |
| `escalate_l2_pct` | smallint | có | 100 | escalate_l2_pct > 0 | % SLA để leo lên người đứng đầu đơn vị |
| `escalate_l3_pct` | smallint | có | 150 | escalate_l3_pct > escalate_l2_pct | % SLA để leo lên tổ công tác |
| `require_independent_verifier` | boolean | có | true |  |  |
| `require_evidence` | boolean | có | true |  |  |
| `valid_from` | date | có |  |  |  |
| `valid_until` | date | không |  |  |  |
| `status` | text | có | 'ACTIVE' | ∈ {DRAFT, ACTIVE, RETIRED} |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `issue_sla_policy_resolve_chk`: resolve_hours >= response_hours
- UNIQUE INDEX `issue_sla_policy_rev_uq` (tenant_id, code, revision)
- UNIQUE INDEX `issue_sla_policy_active_uq` (tenant_id, category_version_id, severity, owner_unit_id) NULLS NOT DISTINCT WHERE status = 'ACTIVE'
- Bổ sung khi triển khai ST-ISS-001 (migration V1060): cột `category_record_id` (uuid, trigger `issue_sla_policy_category` lấy từ phiên bản nhóm khi ghi, người ghi không tự cung cấp) — chính sách đi theo bản ghi nhóm chứ không theo một phiên bản của nó (đổi tên nhóm tạo phiên bản MDM mới, chính sách vẫn được tìm thấy), `category_version_id` giữ làm bằng chứng nhóm được gọi là gì lúc công bố; CHECK `issue_sla_policy_period_chk` (valid_until > valid_from) và `issue_sla_policy_status_period_chk` (RETIRED có ngày kết thúc, ACTIVE không có); EXCLUDE `issue_sla_policy_no_overlap` (không chồng khoảng hiệu lực theo nhóm × mức độ × đơn vị); trigger `issue_sla_policy_guard` (nội dung phiên bản không đổi, chỉ được kết thúc một lần) và không cấp DELETE. `valid_until` là ngày đầu tiên chính sách không còn áp dụng. Công bố cùng `code` là phiên bản kế tiếp, kết thúc phiên bản đang áp dụng đúng vào `valid_from` của nó; khác `code` mà chồng thời gian là 409 `SLA_POLICY_OVERLAP`.

Chỉ mục: `issue_sla_policy_category_version_id_idx`, `issue_sla_policy_owner_unit_id_idx`.

#### Bảng `issue` (hiện có, mở rộng)
Phân loại: Nội bộ (có thể chứa vị trí, cần đồng ý). Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `project_id`, `category_version_id`, `severity`, `assignee_id`, `due_at`, `status`, `version`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `code` | text | không |  |  | Mã VM-yyyy-nnnnnn theo tenant |
| `title` | text | không |  |  |  |
| `description` | text | không |  |  |  |
| `source_module` | text | có | 'MANUAL' | ∈ {MANUAL, LND, PMT, QMS, PAY, CTR, DIS, AST, AUD, PRJ} |  |
| `source_ref_id` | uuid | không |  |  | Đối tượng phát sinh (thửa, giấy phép, NCR…) |
| `contract_id` | uuid | không |  | FK contract |  |
| `owner_unit_id` | uuid | không |  | FK organization_unit | Đơn vị đang chịu trách nhiệm |
| `sla_policy_id` | uuid | không |  | FK issue_sla_policy | Phiên bản SLA áp dụng tại thời điểm tạo |
| `reported_by` | uuid | không |  |  |  |
| `opened_at` | timestamptz | không |  |  |  |
| `response_due_at` | timestamptz | không |  |  |  |
| `responded_at` | timestamptz | không |  |  |  |
| `resolved_at` | timestamptz | không |  |  |  |
| `closed_at` | timestamptz | không |  |  |  |
| `closed_by` | uuid | không |  |  |  |
| `verifier_id` | uuid | không |  |  | Người xác nhận hoàn tất (khác assignee khi policy yêu cầu) |
| `escalation_level` | smallint | có | 0 | escalation_level BETWEEN 0 AND 3 | 0 = chưa; 1 = đơn vị; 2 = lãnh đạo phụ trách; 3 = tổ công tác |
| `escalated_task_force_id` | uuid | không |  | FK task_force |  |
| `escalated_at` | timestamptz | không |  |  |  |
| `overdue_since` | timestamptz | không |  |  | Giữ nguyên khi chuyển đơn vị |
| `reopen_count` | integer | có | 0 |  |  |
| `geo_lat` | numeric(9,6) | không |  |  |  |
| `geo_lng` | numeric(9,6) | không |  |  |  |
| `geo_accuracy_m` | numeric(8,2) | không |  |  |  |
| `geo_consent` | boolean | có | false |  | Chỉ lưu vị trí khi người dùng đồng ý |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `issue_close_chk`: status <> 'CLOSED' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND verifier_id IS NOT NULL)
- CHECK `issue_verifier_chk`: verifier_id IS NULL OR assignee_id IS NULL OR verifier_id <> assignee_id
- CHECK `issue_geo_consent_chk`: geo_lat IS NULL OR geo_consent
- CHECK `issue_assignee_chk`: status = 'OPEN' OR assignee_id IS NOT NULL
- UNIQUE INDEX `issue_code_uq` (tenant_id, code) WHERE code IS NOT NULL

Chỉ mục: `issue_source_ref_id_idx`, `issue_contract_id_idx`, `issue_owner_unit_id_idx`, `issue_sla_policy_id_idx`, `issue_verifier_id_idx`, `issue_escalated_task_force_id_idx`, `issue_project_id_idx`, `issue_category_version_id_idx`, `issue_assignee_id_idx`, `issue_status_due_idx`, `issue_project_status_idx`, `issue_source_idx`.

#### Bảng `issue_event` (mới)
Phân loại: Nội bộ (có thể chứa vị trí, cần đồng ý). Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa. Bảng append-only: `REVOKE UPDATE, DELETE` cho runtime; sửa sai chỉ bằng bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `issue_id` | uuid | có |  | FK issue |  |
| `event_kind` | text | có |  | ∈ {CREATED, ASSIGNED, REASSIGNED, STARTED, COMMENTED, EVIDENCE_ADDED, EXTENSION_REQUESTED, EXTENDED, ESCALATED, ESCALATION_ACCEPTED, VERIFICATION_REQUESTED, CLOSED, REOPENED, SLA_BREACHED, SOURCE_UPDATED} |  |
| `from_status` | text | không |  |  |  |
| `to_status` | text | không |  |  |  |
| `from_assignee_id` | uuid | không |  | FK membership |  |
| `to_assignee_id` | uuid | không |  | FK membership |  |
| `note` | text | không |  |  |  |
| `document_version_id` | uuid | không |  | FK document_version |  |
| `payload` | jsonb | có | '{}'::jsonb |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |

Chỉ mục: `issue_event_issue_id_idx`, `issue_event_from_assignee_id_idx`, `issue_event_to_assignee_id_idx`, `issue_event_document_version_id_idx`, `issue_event_issue_time_idx`.

#### Bảng `issue_escalation` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `issue_id` | uuid | có |  | FK issue |  |
| `level` | smallint | có |  | level BETWEEN 1 AND 3 |  |
| `trigger` | text | có |  | ∈ {SLA_AUTO, MANUAL} |  |
| `target_unit_id` | uuid | không |  | FK organization_unit |  |
| `task_force_id` | uuid | không |  | FK task_force |  |
| `reason` | text | có |  |  |  |
| `due_at` | timestamptz | có |  |  | Hạn bên nhận phải xác nhận |
| `status` | text | có | 'OPEN' | ∈ {OPEN, ACCEPTED, RESOLVED, CANCELLED} |  |
| `accepted_by` | uuid | không |  |  |  |
| `accepted_at` | timestamptz | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `issue_escalation_target_chk`: target_unit_id IS NOT NULL OR task_force_id IS NOT NULL
- CHECK `issue_escalation_level3_chk`: level < 3 OR task_force_id IS NOT NULL
- UNIQUE INDEX `issue_escalation_open_uq` (tenant_id, issue_id, level) WHERE status IN ('OPEN','ACCEPTED')

Chỉ mục: `issue_escalation_issue_id_idx`, `issue_escalation_target_unit_id_idx`, `issue_escalation_task_force_id_idx`.


## 7. API / command

Mọi lệnh ghi: `Idempotency-Key` (≥16 ký tự) bắt buộc; `If-Match` bắt buộc khi đổi bản ghi có version (cột "If-Match" = có); lỗi trả RFC 7807 Problem với `code` ổn định; DTO là allowlist (trường thừa → 400 INVALID_REQUEST); không có endpoint ghi chung cho `status`, `tenant_id`, role hoặc số tiền đã chốt. Mã lỗi chung ngoài bảng: 401 SESSION_EXPIRED, 403 SCOPE_DENIED, 404 RESOURCE_NOT_FOUND, 409 IDEMPOTENCY_CONFLICT, 422 VALIDATION_FAILED, 429 RATE_LIMIT, 503 PROVIDER_UNAVAILABLE.

| operationId | Method path | Quyền (x-permission) | Request DTO (trường được phép; * = bắt buộc) | Response | Lỗi (HTTP + code) | Idempotency | If-Match |
|---|---|---|---|---|---|---|---|
| `createIssue` | `POST /issues` | `issue.create` | project_id*, category_version_id*, severity*, title*, description*, contract_id, owner_unit_id*, source_module, source_ref_id, geo_consent, geo_lat, geo_lng, geo_accuracy_m, client_operation_id* | CommandResult | 422 SLA_POLICY_MISSING; 403 SCOPE_DENIED; 409 DUPLICATE_SOURCE_OPEN; 422 VALIDATION_FAILED | bắt buộc | không |
| `assignIssue` | `POST /issues/{id}/assign` | `issue.assign` | assignee_id*, note | CommandResult | 409 ISSUE_STATE_INVALID; 422 ASSIGNEE_OUT_OF_SCOPE; 409 VERSION_CONFLICT | bắt buộc | có |
| `startIssue` | `POST /issues/{id}/start` | `issue.work` | note | CommandResult | 409 ISSUE_STATE_INVALID; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `commentIssue` | `POST /issues/{id}/comments` | `issue.work` | note*, document_version_id | CommandResult | 409 ISSUE_STATE_INVALID; 422 DOCUMENT_NOT_CLEAN; 403 SCOPE_DENIED | bắt buộc | không |
| `transferIssueUnit` | `POST /issues/{id}/transfer` | `issue.assign` | target_unit_id*, reason* | CommandResult | 409 ISSUE_STATE_INVALID; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `extendIssueDeadline` | `POST /issues/{id}/extend` | `issue.extend` | new_due_at*, reason* | CommandResult | 403 SELF_APPROVAL_DENIED; 422 EXTENSION_LIMIT_REACHED; 409 ISSUE_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `escalateIssue` | `POST /issues/{id}/escalate` | `issue.escalate` | level*, target_unit_id, task_force_id, reason* | CommandResult | 422 ESCALATION_LEVEL_INVALID; 422 TASK_FORCE_NOT_ACTIVE; 409 ISSUE_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `acceptIssueEscalation` | `POST /issue-escalations/{id}/accept` | `issue.escalation.accept` | note | CommandResult | 409 ESCALATION_STATE_INVALID; 403 SCOPE_DENIED | bắt buộc | không |
| `requestIssueVerification` | `POST /issues/{id}/request-verification` | `issue.work` | result_note*, evidence_document_version_ids* | CommandResult | 422 EVIDENCE_REQUIRED; 409 ISSUE_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `closeIssue` | `POST /issues/{id}/close` | `issue.close` | verification_note* | CommandResult | 403 SELF_APPROVAL_DENIED; 422 EVIDENCE_REQUIRED; 409 ISSUE_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `reopenIssue` | `POST /issues/{id}/reopen` | `issue.reopen` | reason* | CommandResult | 409 ISSUE_STATE_INVALID; 422 REOPEN_WINDOW_EXPIRED; 409 VERSION_CONFLICT | bắt buộc | có |
| `upsertIssueSlaPolicy` | `POST /issue-sla-policies` | `issue.sla.manage` | code*, category_version_id*, severity*, owner_unit_id, calendar_code*, response_hours*, resolve_hours*, escalate_l2_pct, escalate_l3_pct, require_independent_verifier, require_evidence, valid_from* | CommandResult | 409 SLA_POLICY_OVERLAP; 422 VALIDATION_FAILED | bắt buộc | không |
| `retireIssueSlaPolicy` | `POST /issue-sla-policies/{id}/retire` | `issue.sla.manage` | valid_until* | CommandResult | 409 SLA_POLICY_STATE_INVALID | bắt buộc | không |
| `getIssueWeeklyMatrix` | `GET /issues/weekly-matrix` | `issue.read` | week, unit_id | DTO đọc (read model) | — | — | không |
| `listIssueSlaBreaches` | `GET /issues/sla-breaches` | `issue.read` | level, cursor, limit | DTO đọc (read model) | — | — | không |

Mô tả ngắn từng lệnh (summary OpenAPI) và guard trạng thái nằm ở `openapi.json` (`x-state-guard`, `x-domain-events`, `x-error-codes`).

Rà soát GET scaffold (`x-contract-maturity: reference-scaffolding`) của tài nguyên thuộc phân hệ:

| Tài nguyên | Quyết định | Lý do |
|---|---|---|
| `/resources/issue` (list + get) | DTO riêng | Ẩn ghi chú nội bộ và nội dung có dữ liệu cá nhân (nguồn LND); lọc theo đơn vị và phạm vi dự án. |

## 8. UI/UX

Tuân thủ mockup (D-B11): kanban/bảng/biểu mẫu/bản đồ theo tài liệu 06. Màu trạng thái SLA dùng token cảnh báo (không dùng màu ruby cho trạng thái thành công).

| ID | Tên màn hình | Loại | Nền tảng | Phase | Trường chính | Command / API | Ghi chú nghiệp vụ |
|---|---|---|---|---|---|---|---|
| ISS-09 | Chính sách SLA theo loại và đơn vị | policy | web | P0 | Nhóm vướng mắc, Mức độ, Đơn vị, Lịch làm việc, Phản hồi (giờ), Xử lý (giờ), Ngưỡng leo thang, Hiệu lực | `upsertIssueSlaPolicy`, `retireIssueSlaPolicy` | Mỗi thay đổi tạo phiên bản mới; vướng mắc giữ SLA đã áp tại thời điểm tạo (UC-ISS-01) |
| ISS-10 | Leo thang và tổ công tác | board | web | P0 | Vướng mắc, Cấp leo thang, Đơn vị / tổ công tác, Hạn xác nhận, Trạng thái, Quá hạn từ | `escalateIssue`, `acceptIssueEscalation`, `listIssueSlaBreaches` | Leo thang không đóng vướng mắc gốc; cấp 3 phải đến tổ công tác đang hoạt động (UC-ISS-02) |
| ISS-11 | Vướng mắc phát sinh từ GPMB, giấy phép, chất lượng | list | web | P1 | Mã, Nguồn, Đối tượng nguồn, Mức độ, Hạn, Đơn vị | `createIssue` | Nội dung liên quan dữ liệu cá nhân không đưa vào vướng mắc; không tạo trùng cho cùng nguồn đang mở (UC-ISS-01) |

Màn hình hiện có được bổ sung (ID giữ nguyên, theo D-B11 được thêm trường):

- ISS-01: thêm trường "Cấp leo thang", "Nguồn phát sinh" (FR-ISS-01).
- ISS-02: thêm trường "Nguồn phát sinh", "Đồng ý lưu vị trí" (FR-ISS-02).

**Trạng thái.** 7 trạng thái chuẩn; riêng: “đã leo thang cấp n”, “quá hạn n ngày” (giữ khi chuyển đơn vị), “chờ xác nhận độc lập”, “nguồn tự động” (khóa sửa tiêu đề/nguồn). **Web/mobile.** Mobile (MOB-28…MOB-31, MOB-59 thuộc MOB) tạo nháp offline với `client_operation_id`, ảnh chờ đồng bộ, vị trí chỉ khi cấp quyền; đóng/gia hạn/leo thang chỉ online.

## 9. Sự kiện, job, tích hợp, quan sát

**Phát.** `iss.issue.opened/assigned/started/commented/transferred/extended/escalated/escalation_accepted/verification_requested/closed/reopened.v1` {issue_id, project_id, owner_unit_id, severity, status, escalation_level, due_at}; `iss.sla_policy.published/retired.v1`. HOME/BI dùng cho bảng điều hành; NOT gửi thông báo theo người nhận.
**Nhận.** Các sự kiện nguồn ở §3.1 bước 8 (consumer idempotent qua `inbox_record`).
**Job.** `issue-sla` mỗi 15 phút (Temporal timer theo vướng mắc khi số lượng lớn [GIẢ ĐỊNH]); `issue-weekly-snapshot` 23:55 Chủ nhật giờ VN.
**Cache.** `t:{tenant_id}:iss:matrix:{week}:{unit}` TTL 5 phút.
**Quan sát.** `iss_open_total{severity}`, `iss_sla_breach_total{level}`, `iss_escalation_pending`, `iss_source_dedupe_total`. Log không chứa nội dung mô tả/vị trí.

## 10. Kiểm thử

Bộ fixture synthetic dùng chung được định nghĩa tại `PAY.md` §10 (nhãn [EXE-FX]); mọi ID/người dùng trong bảng là dữ liệu giả. Các test dưới đây là nguồn của `test_cases.json` (ID `UAT-AC…`); loại: domain / integration / security / concurrency / performance / E2E.

| ID | Loại | Ưu tiên | Tình huống | Setup | Input | Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|---|---|
| UAT-AC350 | domain | P0 | Tính hạn SLA theo lịch làm việc và giữ số ngày quá hạn khi chuyển đơn vị | [EXE-FX] issue_sla_policy SLA-GPMB-HIGH rev1: nhóm GPMB, mức HIGH, response 4 giờ, resolve 72 giờ, lịch WORKDAY_VN (thứ Hai–thứ Sáu 07:30–17:00, nghỉ lễ theo calendar_version 2026); rev2 hiệu lực 2026-09-01 resolve 48 giờ; ngày 2026-07-10 là thứ Sáu. | createIssue lúc 2026-07-10 16:00 (giờ VN) nhóm GPMB HIGH; createIssue lúc 2026-09-02 09:00; transferIssueUnit sau khi quá hạn 2 ngày; extendIssueDeadline. | 1. Tạo vướng mắc lúc thứ Sáu 16:00; đọc response_due_at, due_at, sla_policy_id. 2. Tạo vướng mắc 2026-09-02 09:00; đọc sla_policy_id và due_at. 3. Với vướng mắc đầu, chuyển sang UBND-XA-A1 sau khi quá hạn 2 ngày; đọc due_at, overdue_since. 4. Gia hạn bởi người duyệt khác với new_due_at. | Vướng mắc 1: sla_policy_id = rev1; response_due_at = thứ Hai 2026-07-13 07:30 + 3 giờ làm việc → 2026-07-13 10:30 (1 giờ còn lại thứ Sáu 16:00–17:00 + 3 giờ thứ Hai); due_at tính 72 giờ làm việc theo lịch. Vướng mắc 2: sla_policy_id = rev2 (48 giờ). Sau chuyển đơn vị: owner_unit_id đổi, due_at và overdue_since KHÔNG đổi. Gia hạn: due_at mới, overdue_since vẫn giữ giá trị cũ, issue_event EXTENDED ghi người duyệt. | Bảng issue, issue_event, issue_sla_policy |
| UAT-AC351 | security | P0 | Đóng vướng mắc cần bằng chứng và người xác nhận độc lập | [EXE-FX] ISS-A-001 IN_PROGRESS, assignee u.cv.hd, policy require_independent_verifier=true, require_evidence=true; u.lanhdao là người xác nhận. | requestIssueVerification không bằng chứng; có bằng chứng; closeIssue bởi u.cv.hd; bởi u.lanhdao; UPDATE trực tiếp status=CLOSED. | 1. requestIssueVerification thiếu evidence_document_version_ids. 2. requestIssueVerification đầy đủ. 3. u.cv.hd gọi closeIssue. 4. u.lanhdao gọi closeIssue. 5. UPDATE issue SET status='CLOSED' bằng role machvon_app (verifier_id NULL). | Bước 1: 422 EVIDENCE_REQUIRED. Bước 2: PENDING_VERIFICATION. Bước 3: 403 SELF_APPROVAL_DENIED. Bước 4: CLOSED, closed_by=u.lanhdao, verifier_id=u.lanhdao, closed_at ≠ NULL. Bước 5: lỗi CHECK issue_close_chk. issue_event ghi 4 sự kiện theo thứ tự. | Response, issue_event, lỗi CHECK |
| UAT-AC352 | integration | P0 | Leo thang tự động theo SLA lên đơn vị và tổ công tác mà không đóng việc gốc | [EXE-FX] ISS-A-002 HIGH, due_at 2026-07-20 17:00, đơn vị CDT-A-01; TF-A-01 là tổ công tác ACTIVE (lead u.lanhdao) phạm vi CDT-A-01; policy escalate_l2_pct=100, escalate_l3_pct=150; thời gian xử lý đầy đủ = 72 giờ làm việc. | Chạy job leo thang với đồng hồ giả lập tại 100% SLA, 150% SLA; acceptIssueEscalation; closeIssue gốc. | 1. Chạy job lúc đạt 100% SLA; đọc issue.escalation_level và issue_escalation. 2. Chạy job lúc 150% SLA; đọc issue_escalation cấp 3. 3. Người nhận chấp nhận leo thang cấp 3. 4. Đọc issue.status trong từng bước; chạy lại job. | 100%: escalation_level=1→2, issue_escalation level 2 (target_unit_id = đơn vị chủ quản, due_at xác định), status ESCALATED nhưng issue vẫn mở (không CLOSED). 150%: level 3 với task_force_id=TF-A-01 (CHECK issue_escalation_level3_chk). Chấp nhận: status quay IN_PROGRESS, issue_escalation ACCEPTED. Chạy lại job không tạo escalation trùng (unique issue_escalation_open_uq). Thử level 3 với tổ công tác DISSOLVED: 422 TASK_FORCE_NOT_ACTIVE. | Bảng issue/issue_escalation theo bước |
| UAT-AC353 | domain | P1 | Gia hạn có giới hạn và người duyệt độc lập | [EXE-FX] ISS-A-003 đã gia hạn 2 lần (giới hạn policy = 2); người đề xuất u.cv.hd. | extendIssueDeadline lần 3; lần 1 của ISS-A-004 bởi chính người đề xuất. | 1. Gia hạn lần 3 cho ISS-A-003. 2. ISS-A-004: người đề xuất tự duyệt gia hạn. 3. ISS-A-004: u.lanhdao duyệt. | Lần 3: 422 EXTENSION_LIMIT_REACHED. Tự duyệt: 403 SELF_APPROVAL_DENIED. u.lanhdao: 200, due_at mới, issue_event EXTENDED có lý do; overdue_since không bị xóa. | Response, issue_event |
| UAT-AC354 | integration | P1 | Vướng mắc từ nguồn LND/PMT/QMS: không trùng và không lộ dữ liệu cá nhân | [EXE-FX] Khiếu nại LC-A-001 của hộ HH-A-001 (nội dung chứa họ tên và CCCD giả "079000000001"); giấy phép PMT-A-001 hết hạn. | fileLandComplaint tạo issue tự động; chạy job PMT hết hạn hai lần; xem issue bởi u.gs (không có quyền land.household.read). | 1. Nộp khiếu nại LC-A-001; đọc issue.source_module, title, description. 2. Chạy job PMT hết hạn lần 1 và lần 2; đếm vướng mắc source_module=PMT cho PMT-A-001. 3. u.gs GET /resources/issue/{id}. | issue.source_module=LND, source_ref_id=LC-A-001; title "Khiếu nại LC-A-001 chờ xử lý"; description không chứa họ tên/CCCD (không có chuỗi 079000000001 trong issue, issue_event, audit hay log). Job PMT: đúng 1 vướng mắc mở cho PMT-A-001 (lần 2: DUPLICATE_SOURCE_OPEN được bỏ qua êm). u.gs xem được vướng mắc nhưng không thấy nội dung khiếu nại. | Bảng issue, grep log/audit tìm CCCD |
| UAT-AC355 | integration | P1 | Vị trí chỉ lưu khi đồng ý; tạo offline idempotent | [EXE-FX] Ứng dụng di động offline tạo vướng mắc với client_operation_id=OP-AC355-1 (geo_lat 10.800000, geo_lng 106.700000, độ chính xác 12 m). | createIssue geo_consent=false có tọa độ; geo_consent=true; gửi lại OP-AC355-1 sau khi mạng trở lại. | 1. Gọi với geo_consent=false và có tọa độ. 2. Gọi với geo_consent=true. 3. Gửi lại cùng client_operation_id. 4. Đọc issue.geo_*. | Bước 1: 422 (tọa độ không kèm đồng ý) / CHECK issue_geo_consent_chk nếu bỏ qua ứng dụng. Bước 2: lưu geo_lat=10.800000, geo_lng=106.700000, geo_accuracy_m=12.00. Bước 3: trả lại đúng id cũ, không tạo thêm (đếm = 1). Bước 1 với tọa độ bỏ trống: 200, geo_* NULL. | Response, bảng issue |

## 11. Tiêu chí nghiệm thu

- **AC-ISS-01**: Given chính sách SLA, When tạo/chuyển/gia hạn vướng mắc, Then hạn tính theo lịch làm việc theo phiên bản chính sách tại thời điểm tạo, số ngày quá hạn được giữ khi chuyển đơn vị và gia hạn có giới hạn, người duyệt độc lập. Test: UAT-AC350, UAT-AC353.
- **AC-ISS-02**: Given vướng mắc cần xác nhận, When đóng, Then cần bằng chứng và người xác nhận khác người xử lý, CHECK DB chặn đóng không hợp lệ. Test: UAT-AC351.
- **AC-ISS-03**: Given vướng mắc quá SLA, When đạt 100% và 150%, Then leo thang đúng cấp (đơn vị rồi tổ công tác), không đóng việc gốc và không tạo leo thang trùng. Test: UAT-AC352.
- **AC-ISS-04**: Given nguồn LND/PMT/QMS/PAY/AST, When tạo vướng mắc tự động, Then không trùng cho cùng nguồn đang mở và không chứa dữ liệu cá nhân. Test: UAT-AC354.
- **AC-ISS-05**: Given vị trí và thiết bị di động, When tạo vướng mắc, Then chỉ lưu vị trí khi đồng ý và tạo offline idempotent. Test: UAT-AC355.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1 (P0).** Vòng đời đủ trạng thái, SLA theo lịch làm việc, đóng độc lập, gia hạn/chuyển đơn vị giữ quá hạn, leo thang cấp 2–3 tới tổ công tác, nguồn tự động từ PAY/PMT/LND; màn hình ISS-01…ISS-04, ISS-07, ISS-09, ISS-10. **R2.** Ma trận tuần nâng cao, kiểm tra hiện trường có checklist (ISS-05), ISS-11 đủ nguồn QMS/AST, báo cáo hiệu quả xử lý theo đơn vị.

| Hạng mục bắt buộc người duyệt | Giờ dự kiến | Người duyệt |
|---|---|---|
| Ma trận quyền đóng/gia hạn/leo thang | 2 | Chủ nghiệp vụ |
| Lịch làm việc và chính sách SLA mặc định | 2 | PO + Chủ nghiệp vụ vốn |
| Không đưa dữ liệu cá nhân từ nguồn vào vướng mắc | 1 | DPO |

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| ID | Rủi ro / câu hỏi | Owner | Điều kiện giải quyết |
|---|---|---|---|
| R-ISS-01 | Giới hạn số lần gia hạn và cửa sổ mở lại là [GIẢ ĐỊNH] | Chủ nghiệp vụ | Quy chế tenant pilot |
| R-ISS-02 | Lịch làm việc/ngày lễ và làm bù thay đổi hằng năm | Tenant Admin | Phát hành `calendar_version` hằng năm |
| R-ISS-03 | Tổ công tác do PRJ quản lý; leo thang cấp 3 phụ thuộc dữ liệu tổ hiện hành | Kiến trúc | PRJ công bố interface `activeTaskForce(project, unit, at)` |
