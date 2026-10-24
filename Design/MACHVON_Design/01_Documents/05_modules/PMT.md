# PMT — Hồ sơ pháp lý & giấy phép

Đặc tả phân hệ mới (D-B09; trong plan gọi là LGL) theo `_KHUNG_DAC_TA.md`, baseline 1.4 (22/10/2026). Quy ước chung ở `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md`.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Dự án đầu tư công phải có đủ thủ tục trước từng mốc: đánh giá tác động môi trường/giấy phép môi trường, thẩm định thiết kế, thẩm duyệt phòng cháy chữa cháy, giấy phép xây dựng hoặc căn cứ được miễn. Thiếu hoặc hết hạn giấy phép làm dừng thi công, không nghiệm thu được, gây chậm giải ngân; hiện chỉ theo dõi bằng bảng tính.

**Trong phạm vi.** Danh mục loại giấy phép là dữ liệu có căn cứ pháp lý, hiệu lực, điều kiện áp dụng, thời hạn xử lý/hiệu lực mặc định và khả năng miễn; hồ sơ pháp lý theo dự án/hợp phần; từng giấy phép với mốc xử lý (nộp, tiếp nhận, thẩm định, yêu cầu bổ sung, quyết định); cấp, từ chối, cấp lại (thay thế), thu hồi, miễn; quy tắc cổng chặn mốc (kích hoạt hợp đồng, khởi công, nghiệm thu hoàn thành, bàn giao, tạm ứng) và miễn trừ cổng có thời hạn; cảnh báo hết hạn.

**Ngoài phạm vi.** Nộp hồ sơ trực tuyến tới cơ quan cấp phép (không có API — ghi nhận thủ công/tệp); soạn văn bản đề nghị (DOC); quản lý đất đai/GPMB (LND).

**Phụ thuộc.** PMT → PRJ (dự án, hợp phần, `project_milestone`), DOC (văn bản, bản quét); cung cấp interface `evaluatePermitGates(project, gate_code, as_of)` cho CTR, QMS, PRJ, AST, PAY; phát sự kiện cho ISS và NOT.

**Căn cứ.** Luật Xây dựng 135/2025 (giấy phép xây dựng, trường hợp miễn) và nghị định hướng dẫn (NĐ 217/2026 thay NĐ 175/2024 — thẩm định dự án/thiết kế) [CXN-EXE-02]; Luật Bảo vệ môi trường 2020 (ĐTM, giấy phép môi trường); pháp luật phòng cháy chữa cháy (thẩm duyệt thiết kế PCCC) — danh mục và thời hạn cụ thể [CXN-EXE-03]. Tất cả lưu là dữ liệu `permit_type`/`permit_gate_rule` có `legal_basis`, `effective_from/until`, `cxn_ref`; đổi quy định là xuất bản phiên bản mới, không sửa mã.

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Chuyên viên pháp lý dự án (Ban QLDA) | PROJECT / UNIT_TREE | `permit.manage`, `permit.record` | Tự duyệt miễn giấy phép/miễn trừ cổng |
| Lãnh đạo phụ trách | PROJECT / UNIT_TREE | `permit.exempt`, `permit.gate.waive` | Cấp miễn trừ vượt thời hạn tối đa |
| Chủ nghiệp vụ / pháp chế tenant | TENANT | `permit.catalogue.manage`, `permit.gate.manage` | Sửa phiên bản đang được dùng |
| Phân hệ khác (CTR, QMS, PRJ, AST, PAY) | interface nội bộ | Gọi `evaluatePermitGates` | Ghi dữ liệu PMT |
| Auditor | Scope cấp | `permit.read` | Ghi |

## 3. Luồng nghiệp vụ

### 3.1 Hồ sơ và giấy phép (UC-PMT-01) — PMT-01, PMT-02, PMT-03
1. `createPermitDossier` cho dự án (hoặc hợp phần): hệ thống tạo danh sách giấy phép bắt buộc từ các `permit_type` PUBLISHED có `applies_to_rule` khớp (nhóm dự án, loại công trình, quy mô) tại ngày lập; loại có `cxn_ref` chưa xác nhận gắn cờ.
2. `addPermit` bổ sung loại tùy chọn; `recordPermitMilestone` ghi mốc (PLANNED → SUBMITTED → IN_APPRAISAL ⇄ SUPPLEMENT_REQUESTED).
3. `recordPermitDecision` ISSUED (số, ngày cấp, hiệu lực, bản quét bắt buộc) hoặc REJECTED (lý do).
4. `renewPermit` tạo giấy phép mới thay thế (bản cũ SUPERSEDED); `revokePermit` ghi thu hồi; `declarePermitExemption` khi loại cho phép miễn, có căn cứ và văn bản, người duyệt khác người đề xuất.
5. `readiness_pct` của hồ sơ = số giấy phép bắt buộc ISSUED còn hiệu lực hoặc EXEMPTED / tổng bắt buộc × 100.

### 3.2 Cổng chặn mốc và cảnh báo (UC-PMT-02) — PMT-04, PMT-05, PMT-06
1. Chủ nghiệp vụ xuất bản `permit_gate_rule` (cổng × loại giấy phép × yêu cầu VALID_PERMIT/VALID_OR_EXEMPT/SUBMITTED_ONLY × điều kiện áp dụng × hiệu lực).
2. `evaluatePermitGates(project, gate, as_of)`: với mỗi quy tắc hiệu lực tại `as_of` và áp dụng cho dự án, kiểm giấy phép hiện hành; trả PASSED / PASSED_WITH_WAIVER / BLOCKED kèm danh sách giấy phép chặn, phiên bản quy tắc và căn cứ.
3. Lệnh phụ thuộc gọi đánh giá trong transaction của mình: CTR `activate` (CONTRACT_ACTIVATION), CTR `recordMeasurement`, QMS `saveSiteDiaryDraft`/`requestInspection`, PRJ hoàn thành mốc `START_CONSTRUCTION` (START_CONSTRUCTION), AST `createHandover` (HANDOVER), PAY `requestAdvance` khi quy tắc ADVANCE_DISBURSEMENT tồn tại → 422 `PERMIT_GATE_BLOCKED`.
4. Miễn trừ cổng: `grantPermitGateWaiver` có lý do, văn bản, hạn ≤ tối đa theo rule (90 ngày [GIẢ ĐỊNH]), người duyệt khác người đề xuất; job hết hạn → EXPIRED.
5. Job `permit-expiry` 06:00 VN: cảnh báo T−60, T−30, T−15, T−0 (khử trùng bằng `alert_level_sent`); ngày sau `valid_until` → EXPIRED và tạo vướng mắc ISS; không tự gia hạn.

## 4. State machine

```
Permit: PLANNED ─milestone(SUBMITTED)─► SUBMITTED ─► IN_APPRAISAL ⇄ SUPPLEMENT_REQUESTED
        IN_APPRAISAL ─decision─► ISSUED | REJECTED ;  ISSUED ─job─► EXPIRED ;  ISSUED|EXPIRED ─renew─► SUPERSEDED (+ bản mới ISSUED)
        ISSUED ─revoke─► REVOKED ;  PLANNED|SUBMITTED ─exempt─► EXEMPTED
PermitType / PermitGateRule: DRAFT ─publish─► PUBLISHED ─retire─► RETIRED   (phiên bản mới, không sửa bản cũ)
PermitGateWaiver: ACTIVE ─job hết hạn─► EXPIRED ;  ACTIVE ─revoke─► REVOKED
```

| Từ | Command | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|
| IN_APPRAISAL | `recordPermitDecision(ISSUED)` | ISSUED | `permit.record` | số, ngày, hiệu lực, bản quét (CHECK `permit_issued_chk`); một bản hiện hành mỗi loại | `pmt.permit.issued.v1` |
| ISSUED | job | EXPIRED | hệ thống | `valid_until < hôm nay` | `pmt.permit.expired.v1` |
| ISSUED/EXPIRED | `renewPermit` | SUPERSEDED | `permit.record` | bản mới có số và hiệu lực | `pmt.permit.renewed.v1` |
| PLANNED/SUBMITTED | `declarePermitExemption` | EXEMPTED | `permit.exempt` | `exemption_allowed`; căn cứ + văn bản; khác người đề xuất | `pmt.permit.exempted.v1` |
| ISSUED | `revokePermit` | REVOKED | `permit.record` | lý do + văn bản | `pmt.permit.revoked.v1` |

Cấm (409 `PERMIT_STATE_INVALID`): ISSUED→PLANNED, REJECTED→ISSUED (phải lập bản mới), EXEMPTED→ISSUED, sửa `valid_until` trực tiếp.

## 5. Quy tắc nghiệp vụ và công thức

- **BR-PMT-01 (hiện hành).** Giấy phép hiện hành của loại L trong hồ sơ = bản ISSUED/EXEMPTED duy nhất (unique `permit_current_uq`); hợp lệ tại ngày d khi `valid_from ≤ d ≤ valid_until` hoặc `no_expiry`.
- **BR-PMT-02 (đánh giá cổng).** BLOCKED nếu tồn tại quy tắc PUBLISHED, hiệu lực tại `as_of`, áp dụng cho dự án, mà không thỏa yêu cầu: VALID_PERMIT (ISSUED hợp lệ), VALID_OR_EXEMPT (ISSUED hợp lệ hoặc EXEMPTED), SUBMITTED_ONLY (đã SUBMITTED trở đi); PASSED_WITH_WAIVER nếu có miễn trừ ACTIVE chưa quá hạn cho (dự án, cổng, loại).
- **BR-PMT-03 (hiệu lực dữ liệu pháp lý).** Phiên bản `permit_type`/`permit_gate_rule` không chồng hiệu lực cho cùng mã (`PERMIT_TYPE_OVERLAP`, `GATE_RULE_OVERLAP`); bản ghi lưu id phiên bản đã áp dụng.
- **BR-PMT-04 (thời hạn mặc định).** `expected_decision_on = submitted_on + default_processing_days` (ngày làm việc theo lịch tenant); `valid_until` mặc định = `valid_from + default_validity_months` nếu văn bản cấp không ghi khác.
- **BR-PMT-05 (miễn trừ).** `valid_until − approved_at ≤ max_waiver_days`; người duyệt ≠ người tạo (CHECK `permit_gate_waiver_maker_chk`).
- **BR-PMT-06 (cảnh báo).** Mức = 1 (≤ 60 ngày), 2 (≤ 30), 3 (≤ 15), 4 (đến hạn); gửi khi mức tăng.

Danh mục khởi tạo đề xuất (dữ liệu, chờ [CXN-EXE-03]): `ENV_EIA` (báo cáo ĐTM/quyết định phê duyệt), `ENV_PERMIT` (giấy phép môi trường), `DESIGN_APPRAISAL` (thẩm định thiết kế/dự án), `FIRE_DESIGN` (thẩm duyệt thiết kế PCCC), `BUILDING_PERMIT` (giấy phép xây dựng, cho phép miễn theo Luật Xây dựng 135/2025 [CXN-EXE-02]), `LAND_ALLOCATION` (quyết định giao/cho thuê đất), `TRAFFIC_CONNECTION`, `WATER_DISCHARGE`.

## 6. Dữ liệu

Phân hệ PMT sở hữu 6 bảng (0 bảng hiện có được mở rộng, 6 bảng mới). Quy ước chung: khóa chính `(tenant_id, id)`, khóa ngoại tổng hợp `(tenant_id, x_id)`, tiền `numeric(24,0)` VND nguyên, mọi bảng ENABLE + FORCE RLS với policy RESTRICTIVE `tenant_boundary` và PERMISSIVE `tenant_access` (04 §PostgreSQL và RLS). Mọi cột `*_id` có chỉ mục `<bảng>_<cột>_idx ON (tenant_id, <cột>)`. Cột NOT NULL thêm vào bảng hiện có được thêm nullable hoặc có DEFAULT, backfill rồi mới SET NOT NULL (expand-contract).

#### Bảng `permit_type` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `code` | text | có |  |  |  |
| `revision` | integer | có | 1 | revision > 0 |  |
| `name` | text | có |  |  |  |
| `category` | text | có |  | ∈ {ENVIRONMENT, DESIGN_APPRAISAL, FIRE_SAFETY, CONSTRUCTION_PERMIT, LAND, TRAFFIC, WATER_RESOURCES, OTHER} |  |
| `authority_text` | text | có |  |  | Cơ quan có thẩm quyền theo quy định |
| `legal_basis` | text | có |  |  | Căn cứ pháp lý (số văn bản, điều) |
| `cxn_ref` | text | không |  |  | Mã sổ xác nhận pháp lý [CXN-EXE-02/03] |
| `effective_from` | date | có |  |  |  |
| `effective_until` | date | không |  |  |  |
| `applies_to_rule` | jsonb | có |  |  | Điều kiện áp dụng: nhóm dự án, loại công trình, quy mô |
| `default_validity_months` | integer | không |  | default_validity_months > 0 |  |
| `default_processing_days` | integer | không |  | default_processing_days > 0 |  |
| `exemption_allowed` | boolean | có | false |  |  |
| `status` | text | có | 'DRAFT' | ∈ {DRAFT, PUBLISHED, RETIRED} |  |
| `supersedes_id` | uuid | không |  | FK permit_type |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `permit_type_dates_chk`: effective_until IS NULL OR effective_from < effective_until
- UNIQUE INDEX `permit_type_rev_uq` (tenant_id, code, revision)
- UNIQUE INDEX `permit_type_published_uq` (tenant_id, code) WHERE status = 'PUBLISHED'

Chỉ mục: `permit_type_supersedes_id_idx`.

#### Bảng `permit_dossier` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `project_id` | uuid | có |  | FK project |  |
| `project_component_id` | uuid | không |  | FK project_component |  |
| `owner_unit_id` | uuid | có |  | FK organization_unit |  |
| `owner_membership_id` | uuid | không |  | FK membership |  |
| `status` | text | có | 'OPEN' | ∈ {OPEN, COMPLETE, CLOSED} |  |
| `readiness_pct` | numeric(5,2) | có | 0 | readiness_pct BETWEEN 0 AND 100 | Cache: tỷ lệ giấy phép bắt buộc đạt điều kiện |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- UNIQUE INDEX `permit_dossier_scope_uq` (tenant_id, project_id, project_component_id) NULLS NOT DISTINCT

Chỉ mục: `permit_dossier_project_id_idx`, `permit_dossier_project_component_id_idx`, `permit_dossier_owner_unit_id_idx`, `permit_dossier_owner_membership_id_idx`.

#### Bảng `permit` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `dossier_id` | uuid | có |  | FK permit_dossier |  |
| `permit_type_id` | uuid | có |  | FK permit_type |  |
| `permit_no` | text | không |  |  |  |
| `status` | text | có | 'PLANNED' | ∈ {PLANNED, SUBMITTED, IN_APPRAISAL, SUPPLEMENT_REQUESTED, ISSUED, REJECTED, EXPIRED, REVOKED, SUPERSEDED, EXEMPTED} |  |
| `authority_name` | text | không |  |  |  |
| `submitted_on` | date | không |  |  |  |
| `expected_decision_on` | date | không |  |  |  |
| `issued_on` | date | không |  |  |  |
| `valid_from` | date | không |  |  |  |
| `valid_until` | date | không |  |  |  |
| `no_expiry` | boolean | có | false |  |  |
| `exemption_basis` | text | không |  |  |  |
| `exemption_decision_document_version_id` | uuid | không |  | FK document_version |  |
| `document_version_id` | uuid | không |  | FK document_version | Bản giấy phép đã quét |
| `supersedes_id` | uuid | không |  | FK permit |  |
| `responsible_membership_id` | uuid | không |  | FK membership |  |
| `alert_level_sent` | smallint | có | 0 | alert_level_sent BETWEEN 0 AND 4 | Ngưỡng cảnh báo hết hạn đã gửi (khử trùng) |
| `revoke_reason` | text | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `permit_issued_chk`: status <> 'ISSUED' OR (permit_no IS NOT NULL AND issued_on IS NOT NULL AND document_version_id IS NOT NULL AND valid_from IS NOT NULL AND (no_expiry OR valid_until IS NOT NULL))
- CHECK `permit_validity_chk`: valid_until IS NULL OR valid_from IS NULL OR valid_from <= valid_until
- CHECK `permit_exempt_chk`: status <> 'EXEMPTED' OR (exemption_basis IS NOT NULL AND exemption_decision_document_version_id IS NOT NULL)
- CHECK `permit_revoke_chk`: status <> 'REVOKED' OR revoke_reason IS NOT NULL
- UNIQUE INDEX `permit_type_no_uq` (tenant_id, permit_type_id, permit_no) WHERE permit_no IS NOT NULL
- UNIQUE INDEX `permit_current_uq` (tenant_id, dossier_id, permit_type_id) WHERE status IN ('ISSUED','EXEMPTED')

Chỉ mục: `permit_dossier_id_idx`, `permit_permit_type_id_idx`, `permit_exemption_decision_document_version_id_idx`, `permit_document_version_id_idx`, `permit_supersedes_id_idx`, `permit_responsible_membership_id_idx`, `permit_expiry_idx`.

#### Bảng `permit_milestone` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `permit_id` | uuid | có |  | FK permit |  |
| `step_code` | text | có |  | ∈ {SUBMITTED, ACKNOWLEDGED, APPRAISAL_MEETING, SUPPLEMENT_REQUESTED, SUPPLEMENT_SUBMITTED, DECISION, HANDED_OVER} |  |
| `planned_on` | date | không |  |  |  |
| `actual_on` | date | không |  |  |  |
| `note` | text | không |  |  |  |
| `document_version_id` | uuid | không |  | FK document_version |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |

Chỉ mục: `permit_milestone_permit_id_idx`, `permit_milestone_document_version_id_idx`, `permit_milestone_step_idx`.

#### Bảng `permit_gate_rule` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `gate_code` | text | có |  | ∈ {CONTRACT_ACTIVATION, START_CONSTRUCTION, ACCEPTANCE_COMPLETION, HANDOVER, ADVANCE_DISBURSEMENT} |  |
| `project_milestone_code` | text | không |  |  | Mã mốc PRJ bị chặn (project_milestone.code) |
| `permit_type_id` | uuid | có |  | FK permit_type |  |
| `requirement` | text | có | 'VALID_PERMIT' | ∈ {VALID_PERMIT, VALID_OR_EXEMPT, SUBMITTED_ONLY} |  |
| `applies_to_rule` | jsonb | có |  |  |  |
| `legal_basis` | text | có |  |  |  |
| `effective_from` | date | có |  |  |  |
| `effective_until` | date | không |  |  |  |
| `revision` | integer | có | 1 | revision > 0 |  |
| `status` | text | có | 'DRAFT' | ∈ {DRAFT, PUBLISHED, RETIRED} |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- UNIQUE INDEX `permit_gate_rule_rev_uq` (tenant_id, gate_code, permit_type_id, revision)
- UNIQUE INDEX `permit_gate_rule_published_uq` (tenant_id, gate_code, permit_type_id) WHERE status = 'PUBLISHED'

Chỉ mục: `permit_gate_rule_permit_type_id_idx`.

#### Bảng `permit_gate_waiver` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `project_id` | uuid | có |  | FK project |  |
| `gate_code` | text | có |  |  |  |
| `permit_type_id` | uuid | có |  | FK permit_type |  |
| `reason` | text | có |  |  |  |
| `decision_document_version_id` | uuid | có |  | FK document_version |  |
| `valid_until` | date | có |  |  |  |
| `approved_by` | uuid | có |  |  |  |
| `approved_at` | timestamptz | có | now() |  |  |
| `status` | text | có | 'ACTIVE' | ∈ {ACTIVE, EXPIRED, REVOKED} |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `permit_gate_waiver_maker_chk`: approved_by <> created_by

Chỉ mục: `permit_gate_waiver_project_id_idx`, `permit_gate_waiver_permit_type_id_idx`, `permit_gate_waiver_decision_document_version_id_idx`, `permit_gate_waiver_active_idx`.


## 7. API / command

Mọi lệnh ghi: `Idempotency-Key` (≥16 ký tự) bắt buộc; `If-Match` bắt buộc khi đổi bản ghi có version (cột "If-Match" = có); lỗi trả RFC 7807 Problem với `code` ổn định; DTO là allowlist (trường thừa → 400 INVALID_REQUEST); không có endpoint ghi chung cho `status`, `tenant_id`, role hoặc số tiền đã chốt. Mã lỗi chung ngoài bảng: 401 SESSION_EXPIRED, 403 SCOPE_DENIED, 404 RESOURCE_NOT_FOUND, 409 IDEMPOTENCY_CONFLICT, 422 VALIDATION_FAILED, 429 RATE_LIMIT, 503 PROVIDER_UNAVAILABLE.

| operationId | Method path | Quyền (x-permission) | Request DTO (trường được phép; * = bắt buộc) | Response | Lỗi (HTTP + code) | Idempotency | If-Match |
|---|---|---|---|---|---|---|---|
| `createPermitDossier` | `POST /projects/{id}/permit-dossiers` | `permit.manage` | project_component_id, owner_unit_id*, owner_membership_id | CommandResult | 409 DOSSIER_EXISTS; 422 PERMIT_TYPE_UNCONFIRMED; 403 SCOPE_DENIED | bắt buộc | không |
| `addPermit` | `POST /permit-dossiers/{id}/permits` | `permit.manage` | permit_type_id*, authority_name, expected_decision_on, responsible_membership_id | CommandResult | 422 PERMIT_TYPE_NOT_EFFECTIVE; 409 PERMIT_ALREADY_CURRENT; 422 VALIDATION_FAILED | bắt buộc | không |
| `recordPermitMilestone` | `POST /permits/{id}/milestones` | `permit.manage` | step_code*, planned_on, actual_on, note, document_version_id | CommandResult | 409 PERMIT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `recordPermitDecision` | `POST /permits/{id}/decision` | `permit.record` | outcome*, permit_no, issued_on, valid_from, valid_until, no_expiry, document_version_id, reason | CommandResult | 422 PERMIT_DOCUMENT_REQUIRED; 409 PERMIT_NO_DUPLICATE; 409 PERMIT_STATE_INVALID; 422 VALIDATION_FAILED; 409 VERSION_CONFLICT | bắt buộc | có |
| `renewPermit` | `POST /permits/{id}/renew` | `permit.record` | new_permit_no*, new_valid_until*, document_version_id* | CommandResult | 409 PERMIT_STATE_INVALID; 422 VALIDATION_FAILED; 409 VERSION_CONFLICT | bắt buộc | có |
| `revokePermit` | `POST /permits/{id}/revoke` | `permit.record` | reason*, decision_document_version_id* | CommandResult | 409 PERMIT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `declarePermitExemption` | `POST /permits/{id}/exempt` | `permit.exempt` | exemption_basis*, exemption_decision_document_version_id* | CommandResult | 422 EXEMPTION_NOT_ALLOWED; 403 SELF_APPROVAL_DENIED; 409 PERMIT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `publishPermitType` | `POST /permit-types` | `permit.catalogue.manage` | code*, name*, category*, authority_text*, legal_basis*, cxn_ref, effective_from*, effective_until, applies_to_rule*, default_validity_months, default_processing_days, exemption_allowed | CommandResult | 409 PERMIT_TYPE_OVERLAP; 422 LEGAL_BASIS_REQUIRED; 422 VALIDATION_FAILED | bắt buộc | không |
| `retirePermitType` | `POST /permit-types/{id}/retire` | `permit.catalogue.manage` | effective_until* | CommandResult | 422 PERMIT_TYPE_IN_USE; 422 VALIDATION_FAILED | bắt buộc | không |
| `publishPermitGateRule` | `POST /permit-gate-rules` | `permit.gate.manage` | gate_code*, project_milestone_code, permit_type_id*, requirement*, applies_to_rule*, legal_basis*, effective_from*, effective_until | CommandResult | 409 GATE_RULE_OVERLAP; 422 LEGAL_BASIS_REQUIRED; 422 VALIDATION_FAILED | bắt buộc | không |
| `retirePermitGateRule` | `POST /permit-gate-rules/{id}/retire` | `permit.gate.manage` | effective_until* | CommandResult | 422 VALIDATION_FAILED | bắt buộc | không |
| `grantPermitGateWaiver` | `POST /permit-gate-waivers` | `permit.gate.waive` | project_id*, gate_code*, permit_type_id*, reason*, decision_document_version_id*, valid_until* | CommandResult | 422 WAIVER_TOO_LONG; 403 SELF_APPROVAL_DENIED; 422 DECISION_DOCUMENT_REQUIRED; 422 VALIDATION_FAILED | bắt buộc | không |
| `revokePermitGateWaiver` | `POST /permit-gate-waivers/{id}/revoke` | `permit.gate.waive` | reason* | CommandResult | 409 WAIVER_STATE_INVALID | bắt buộc | không |
| `get_resources_permit_gate_waiver` | `GET /resources/permit_gate_waiver` | `permit.read` | project_id, gate_code, status, limit, cursor | danh sách miễn trừ cổng của các dự án trong phạm vi (không kèm người đề xuất, người duyệt) | 422 VALIDATION_FAILED | không | không |
| `evaluatePermitGates` | `GET /projects/{id}/permit-gates` | `permit.read` | gate_code, as_of | DTO đọc (read model) | — | — | không |
| `get_resources_permit_gate_rule` | `GET /resources/permit_gate_rule` | `permit.read` | cursor, limit | DTO đọc (mọi phiên bản quy tắc cổng) | — | — | không |
| `listExpiringPermits` | `GET /permits/expiring` | `permit.read` | within_days, cursor, limit | DTO đọc (read model) | — | — | không |

Mô tả ngắn từng lệnh (summary OpenAPI) và guard trạng thái nằm ở `openapi.json` (`x-state-guard`, `x-domain-events`, `x-error-codes`).

## 8. UI/UX

Tuân thủ mockup (D-B11): bảng, timeline, board, policy editor theo tài liệu 06. Trạng thái giấy phép có nhãn chữ + màu ngữ nghĩa; cờ CXN-* hiển thị bên cạnh loại giấy phép chưa xác nhận.

| ID | Tên màn hình | Loại | Nền tảng | Phase | Trường chính | Command / API | Ghi chú nghiệp vụ |
|---|---|---|---|---|---|---|---|
| PMT-01 | Hồ sơ pháp lý dự án | table | web | P1 | Dự án, Giấy phép bắt buộc, Đã cấp, Sắp hết hạn, Cổng bị chặn, Phụ trách | `createPermitDossier`, `addPermit`, `evaluatePermitGates` | Danh mục bắt buộc sinh theo loại giấy phép áp dụng; mục CXN-* chưa xác nhận có cờ cảnh báo (UC-PMT-01) |
| PMT-02 | Chi tiết giấy phép và mốc xử lý | timeline | web | P1 | Giấy phép, Số, Cơ quan, Mốc xử lý, Hiệu lực, Bản quét | `recordPermitMilestone`, `recordPermitDecision`, `renewPermit`, `revokePermit` | Một giấy phép hiện hành mỗi loại; cấp lại tạo bản mới thay thế (UC-PMT-01) |
| PMT-03 | Danh mục loại giấy phép | policy | web | P1 | Mã, Tên, Nhóm, Căn cứ pháp lý, Hiệu lực, Điều kiện áp dụng, Được miễn | `publishPermitType`, `retirePermitType` | Dữ liệu có legal_basis và hiệu lực; không sửa bản đang dùng (UC-PMT-01) |
| PMT-04 | Quy tắc cổng chặn mốc | policy | web | P1 | Cổng, Mốc PRJ bị chặn, Loại giấy phép, Yêu cầu, Điều kiện áp dụng, Hiệu lực | `publishPermitGateRule`, `retirePermitGateRule`, `evaluatePermitGates` | Cổng đánh giá theo quy tắc hiệu lực tại ngày; miễn trừ có thời hạn và văn bản (UC-PMT-02) |
| PMT-05 | Cảnh báo hết hạn giấy phép | board | web | P1 | Giấy phép, Dự án, Hết hạn, Còn lại (ngày), Mức cảnh báo, Phụ trách | `listExpiringPermits` | Cảnh báo 60/30/15/0 ngày khử trùng; hết hạn tự tạo vướng mắc; không tự gia hạn (UC-PMT-02) |
| PMT-06 | Miễn giấy phép và miễn trừ cổng | form | web | P1 | Giấy phép, Căn cứ miễn, Văn bản, Người duyệt, Miễn trừ cổng đến ngày | `declarePermitExemption`, `grantPermitGateWaiver`, `revokePermitGateWaiver` | Người duyệt khác người đề xuất; miễn trừ tối đa theo rule (UC-PMT-02) |


**Trạng thái riêng.** “Cổng đang chặn” (liệt kê mốc bị chặn và giấy phép cần), “miễn trừ còn n ngày”, “hết hạn”, “loại giấy phép chưa xác nhận”. **Web/mobile.** Web; mobile chỉ nhận cảnh báo qua NOT và xem trạng thái trong MOB-10 (chi tiết dự án).

## 9. Sự kiện, job, tích hợp, quan sát

**Phát.** `pmt.dossier.opened.v1`; `pmt.permit.planned/milestone_recorded/issued/rejected/renewed/revoked/exempted/expired.v1` {permit_id, project_id, permit_type_code, status, valid_until}; `pmt.permit_type.published/retired.v1`; `pmt.gate_rule.published/retired.v1`; `pmt.gate_waiver.granted/revoked/expired.v1`. Consumer: ISS (vướng mắc), CTR/QMS (đánh giá lại cổng hiển thị), NOT.
**Job.** `permit-expiry` (06:00 VN), `gate-waiver-expiry` (00:10 VN).
**Cache.** `t:{tenant_id}:pmt:gates:{project_id}:{as_of}` TTL 60 giây, vô hiệu khi có `pmt.*` của dự án.
**Quan sát.** `pmt_gate_blocked_total{gate}`, `pmt_permit_expiring{days}`, `pmt_waiver_active`.

## 10. Kiểm thử

Bộ fixture synthetic dùng chung được định nghĩa tại `PAY.md` §10 (nhãn [EXE-FX]); mọi ID/người dùng trong bảng là dữ liệu giả. Các test dưới đây là nguồn của `test_cases.json` (ID `UAT-AC…`); loại: domain / integration / security / concurrency / performance / E2E.

| ID | Loại | Ưu tiên | Tình huống | Setup | Input | Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|---|---|
| UAT-AC368 | domain | P0 | Cổng START_CONSTRUCTION theo giấy phép xây dựng hoặc miễn | [EXE-FX] Rule cổng GR-1: gate START_CONSTRUCTION, permit_type GPXD, requirement VALID_OR_EXEMPT, hiệu lực 2026-01-01, legal_basis fixture "Luật Xây dựng 135/2025 [CXN-EXE-02]"; dossier PD-A-001 cho PRJ-A-001 chưa có giấy phép; as_of 2026-08-01. | evaluatePermitGates; ghi GPXD ISSUED valid_until 2026-12-31; as_of 2027-01-02; declarePermitExemption cho dự án khác PRJ-A-002. | 1. evaluatePermitGates as_of 2026-08-01 khi chưa có giấy phép. 2. recordPermitDecision GPXD ISSUED (permit_no GP-0001, valid 2026-07-01..2026-12-31); đánh giá lại. 3. Đánh giá as_of 2027-01-02. 4. PRJ-A-002: declarePermitExemption với exemption_basis và quyết định; đánh giá. | Bước 1: gate START_CONSTRUCTION BLOCKED, blocking_permits=[GPXD], lý do "chưa có giấy phép". Bước 2: PASSED. Bước 3: BLOCKED (giấy phép hết hạn 2026-12-31). PRJ-A-002: PASSED với basis EXEMPTED. Kết quả luôn kèm rule revision và legal_basis đã dùng. | Response evaluatePermitGates qua từng mốc |
| UAT-AC369 | integration | P0 | Cổng giấy phép chặn lệnh ở CTR/QMS/PRJ | [EXE-FX] PRJ-A-001 gate START_CONSTRUCTION BLOCKED (chưa có GPXD); HD-A-001 construction ACTIVE; milestone PRJ "START_CONSTRUCTION" PLANNED. | recordMeasurement; saveSiteDiaryDraft; requestInspection; PRJ completeMilestone START_CONSTRUCTION; sau đó cấp waiver 30 ngày. | 1. Gọi bốn lệnh khi cổng BLOCKED. 2. u.lanhdao cấp grantPermitGateWaiver valid_until +30 ngày kèm văn bản. 3. Gọi lại recordMeasurement. 4. Chờ waiver hết hạn (đồng hồ giả lập) và gọi lại. | Bước 1: cả bốn trả 422 PERMIT_GATE_BLOCKED (details: gate_code, permit_type GPXD). Bước 3: recordMeasurement 200 (waiver ACTIVE), audit ghi waiver id. Bước 4: waiver EXPIRED theo job, lệnh bị chặn lại. | Response bốn lệnh, bảng permit_gate_waiver |
| UAT-AC370 | integration | P0 | Cảnh báo hết hạn giấy phép, hết hạn tự động và cấp lại không tự gia hạn | [EXE-FX] Permit PMT-A-001 GPXD ISSUED valid_until 2026-12-31; người phụ trách u.cv.hd; ngưỡng cảnh báo 60/30/15/0 ngày. | Chạy job với đồng hồ 2026-11-01, 2026-12-01, 2026-12-16, 2026-12-31, 2027-01-01; renewPermit. | 1. Chạy job các ngày giả lập; đọc alert_level_sent và thông báo. 2. Chạy lại job cùng ngày. 3. Chạy 2027-01-01 và đọc status. 4. renewPermit với new_permit_no GP-0002 valid_until 2027-12-31. | Thông báo gửi đúng 4 lần (T-60, T-30, T-15, T-0), alert_level_sent tăng 1→4, chạy lại không gửi trùng. 2027-01-01: status EXPIRED và tự tạo 1 vướng mắc ISS. renewPermit: PMT-A-001 SUPERSEDED, bản mới ISSUED GP-0002; unique permit_current_uq chỉ có 1 ISSUED; không bản nào tự thay đổi valid_until. | Bảng permit/notification/issue |
| UAT-AC371 | domain | P1 | Danh mục loại giấy phép có hiệu lực theo thời gian và căn cứ bắt buộc | [EXE-FX] permit_type GPXD rev1 PUBLISHED hiệu lực 2026-01-01; dossier PD-A-001 đã dùng rev1. | publishPermitType rev2 không legal_basis; có legal_basis hiệu lực 2027-01-01; hiệu lực chồng lấn; retirePermitType khi đang dùng. | 1. Xuất bản rev2 thiếu legal_basis. 2. Xuất bản rev2 hiệu lực 2027-01-01 với legal_basis. 3. Xuất bản rev3 hiệu lực 2026-06-01 (chồng lấn). 4. retirePermitType rev1 effective_until 2026-12-31 khi còn dossier mở. | Bước 1: 422 LEGAL_BASIS_REQUIRED. Bước 2: 200; permit đang có giữ permit_type_id rev1 (không đổi). Bước 3: 409 PERMIT_TYPE_OVERLAP. Bước 4: 422 PERMIT_TYPE_IN_USE nếu còn permit PLANNED/IN_APPRAISAL dùng rev1 sau ngày đó; nếu không có thì 200. | Bảng permit_type, response |
| UAT-AC372 | domain | P1 | Miễn giấy phép cần căn cứ, văn bản và người duyệt độc lập | [EXE-FX] permit PMT-A-010 loại GPXD (exemption_allowed=true) PLANNED; PMT-A-011 loại GPMT/ĐTM (exemption_allowed=false) PLANNED; u.cv.hd đề xuất. | declarePermitExemption PMT-A-010 không văn bản; bởi người đề xuất; bởi u.lanhdao; PMT-A-011. | 1. Gọi thiếu exemption_decision_document_version_id. 2. u.cv.hd tự duyệt. 3. u.lanhdao duyệt đủ căn cứ. 4. Gọi cho PMT-A-011. | Bước 1: CHECK permit_exempt_chk/422 DECISION_DOCUMENT_REQUIRED. Bước 2: 403 SELF_APPROVAL_DENIED. Bước 3: EXEMPTED, exemption_basis lưu; cổng VALID_OR_EXEMPT đạt. PMT-A-011: 422 EXEMPTION_NOT_ALLOWED. | Response, bảng permit |
| UAT-AC373 | security | P1 | Miễn trừ cổng có thời hạn tối đa và không tự duyệt | [EXE-FX] Rule waiver tối đa 90 ngày [GIẢ ĐỊNH]; u.cv.hd tạo đề xuất; u.lanhdao có permit.gate.waive. | grantPermitGateWaiver valid_until sau 120 ngày; bởi người đề xuất; hợp lệ 60 ngày; revoke. | 1. Cấp waiver 120 ngày. 2. Người đề xuất tự cấp. 3. u.lanhdao cấp 60 ngày. 4. revokePermitGateWaiver rồi đánh giá cổng. | Bước 1: 422 WAIVER_TOO_LONG. Bước 2: 403 SELF_APPROVAL_DENIED (CHECK permit_gate_waiver_maker_chk). Bước 3: ACTIVE, cổng PASSED_WITH_WAIVER hiển thị waiver id và hạn. Bước 4: REVOKED, cổng BLOCKED lại ngay. | Bảng permit_gate_waiver, response |
| UAT-AC374 | security | P1 | Cách ly tenant cho hồ sơ pháp lý | [EXE-FX] Dossier PD-B-001 của TNT-B; u.cv.hd thuộc TNT-A. | GET /projects/{PRJ-B-001}/permit-gates; POST /permit-dossiers/{PD-B-001}/permits; SQL không đặt tenant. | 1. Gọi hai endpoint với id TNT-B. 2. SELECT count(*) trên permit, permit_dossier khi chưa đặt app.tenant_id. | Hai endpoint: 404 RESOURCE_NOT_FOUND; SQL không tenant: 0 dòng; không tạo permit ở TNT-B. | Response và kết quả SQL |
| UAT-AC375 | domain | P1 | Một giấy phép hiện hành cho mỗi loại và số giấy phép không trùng | [EXE-FX] Dossier PD-A-001 đã có GPXD ISSUED số GP-0001; loại PCCC chưa có. | addPermit GPXD lần 2 ISSUED; recordPermitDecision số GP-0001 cho PCCC; cho cùng loại GPXD ở dossier khác. | 1. recordPermitDecision tạo GPXD thứ hai ISSUED trong cùng dossier. 2. Ghi số GP-0001 cho loại PCCC (loại khác). 3. Ghi số GP-0001 cho GPXD của dossier khác trong tenant. | Bước 1: 409 PERMIT_ALREADY_CURRENT (unique permit_current_uq). Bước 2: 200 (số chỉ duy nhất theo loại). Bước 3: 409 PERMIT_NO_DUPLICATE (unique permit_type_no_uq). | Response, lỗi unique |

## 11. Tiêu chí nghiệm thu

- **AC-PMT-01**: Given quy tắc cổng và giấy phép của dự án, When đánh giá cổng tại as_of, Then BLOCKED/PASSED theo quy tắc hiệu lực kèm căn cứ, và các lệnh CTR/QMS/PRJ/AST bị chặn bằng PERMIT_GATE_BLOCKED khi cổng chưa đạt (trừ miễn trừ còn hiệu lực). Test: UAT-AC368, UAT-AC369.
- **AC-PMT-02**: Given giấy phép có hạn, When tới 60/30/15/0 ngày, Then cảnh báo khử trùng, hết hạn tự tạo vướng mắc, cấp lại tạo bản thay thế và chỉ một giấy phép hiện hành mỗi loại. Test: UAT-AC370, UAT-AC375.
- **AC-PMT-03**: Given danh mục loại giấy phép, When xuất bản/ngừng, Then có căn cứ pháp lý và hiệu lực, không chồng lấn, không đổi bản ghi đang dùng. Test: UAT-AC371.
- **AC-PMT-04**: Given miễn giấy phép hoặc miễn trừ cổng, When duyệt, Then cần căn cứ, văn bản, người duyệt khác người đề xuất và thời hạn tối đa. Test: UAT-AC372, UAT-AC373.
- **AC-PMT-05**: Given hai tenant, When truy cập chéo, Then 404/0 dòng. Test: UAT-AC374.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1.** Danh mục loại giấy phép (dữ liệu), hồ sơ, giấy phép và mốc, cấp/cấp lại/miễn, cổng START_CONSTRUCTION và CONTRACT_ACTIVATION, cảnh báo hết hạn. Màn hình PMT-01…PMT-06. **R2.** Cổng ACCEPTANCE_COMPLETION/HANDOVER/ADVANCE_DISBURSEMENT, thời hạn xử lý theo ngày làm việc, báo cáo tiến độ thủ tục toàn tỉnh. **R3.** Liên thông dịch vụ công khi có hợp đồng.

| Hạng mục bắt buộc người duyệt | Giờ dự kiến | Người duyệt |
|---|---|---|
| Danh mục loại giấy phép, điều kiện áp dụng, căn cứ | 3 | Pháp chế [CXN-EXE-03] |
| Quy tắc miễn giấy phép xây dựng | 2 | Chủ nghiệp vụ xây dựng [CXN-EXE-02] |
| Quy tắc cổng và thời hạn miễn trừ | 2 | Chủ nghiệp vụ |

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| ID | Rủi ro / câu hỏi | Owner | Điều kiện giải quyết |
|---|---|---|---|
| R-PMT-01 | Danh mục giấy phép bắt buộc theo nhóm/loại dự án và thời hạn xử lý [CXN-EXE-03] | Pháp chế | Văn bản gốc; publish `permit_type` |
| R-PMT-02 | Điều kiện miễn GPXD theo Luật Xây dựng 135/2025 [CXN-EXE-02] | Chủ nghiệp vụ xây dựng | Văn bản gốc + hướng dẫn |
| R-PMT-03 | Thời hạn miễn trừ cổng tối đa là [GIẢ ĐỊNH] 90 ngày | Chủ nghiệp vụ | Quy chế tenant |
| R-PMT-04 | Không có API dịch vụ công cấp phép; trạng thái nhập tay có thể chậm | PO | Quy trình cập nhật tuần + cảnh báo `expected_decision_on` quá hạn |
