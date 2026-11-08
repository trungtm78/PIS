# QMS — Chất lượng, nhật ký thi công, nghiệm thu

Đặc tả phân hệ mới (D-B09) theo `_KHUNG_DAC_TA.md`, baseline 1.4 (22/10/2026). Quy ước chung ở `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md`. Bảng `site_diary` và `quality_nonconformance` có từ baseline v1.3 được giữ nguyên cột, chỉ mở rộng.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Nhật ký thi công giấy dễ ghi bù, sửa lùi, thiếu chữ ký giám sát; nghiệm thu chất lượng không gắn được với khối lượng thanh toán; ảnh hiện trường không kiểm được thời điểm/vị trí; NCR không có người chịu trách nhiệm và bằng chứng đóng. QMS số hóa các hồ sơ này với chữ ký gắn băm nội dung và phát sự kiện “nghiệm thu chất lượng đạt” cho CTR.

**Trong phạm vi.** Nhật ký thi công điện tử theo hợp đồng × ngày (lập, ký nhà thầu, ý kiến và chữ ký giám sát, xác nhận chủ đầu tư, khóa, điều chỉnh có lý do, xung đột đồng bộ); đề nghị kiểm tra → lịch → kết quả theo checklist; biên bản nghiệm thu chất lượng (công việc, giai đoạn, bộ phận, hoàn thành) với vai trò ký theo quy chế; thí nghiệm vật liệu; NCR → hành động khắc phục → xác nhận độc lập; ảnh hiện trường có kiểm EXIF/GPS/thời gian/trùng lặp; độ phủ nhật ký.

**Ngoài phạm vi.** Khối lượng và nghiệm thu khối lượng dùng thanh toán (CTR); bàn giao (AST); GIS đầy đủ (R2+); AI kiểm ảnh tiến độ (Could, R3); ký số văn bản phát hành (DOC — QMS chỉ ghi phương thức và số serial chứng thư cho chữ ký trên hồ sơ).

**Phụ thuộc.** QMS → CTR (hợp đồng, BOQ), PRJ, DOC; dùng cổng PMT `START_CONSTRUCTION`; phát sự kiện cho CTR, ISS, AST, NOT. App Flutter (MOB-62, MOB-64, QMS-09, QMS-10) gọi command QMS.

**Căn cứ.** NĐ 06/2021/NĐ-CP (quản lý chất lượng, thi công xây dựng, bảo trì — nhật ký thi công, nghiệm thu công việc/giai đoạn/hoàn thành) và văn bản thay thế dự kiến NĐ 207/2026 [CXN-07]; Luật Xây dựng 135/2025; giá trị pháp lý của chữ ký điện tử trên nhật ký điện tử [CXN-EXE-05]; Luật BVDLCN 91/2025 (vị trí là dữ liệu cá nhân). Quy chế áp dụng được lưu là rule `QMS.REGIME` có `legal_basis` và hiệu lực: bản ghi kiểm tra/biên bản chụp `regime_rule_version_id` và danh sách vai trò phải ký tại thời điểm tạo. Thực tiễn: Procore Daily Log/Inspections/Observations, Autodesk Build quality.

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Nhà thầu (khách) | CONTRACT | `diary.write`, `diary.sign.contractor`, `diary.correct`, `inspection.request`, `photo.upload`, `ncr.respond`, `material.manage` (đăng ký mẫu) | Ký vai trò giám sát/chủ đầu tư; xem hợp đồng khác |
| Tư vấn giám sát (khách hoặc nội bộ) | CONTRACT | `diary.sign.supervisor`, `inspection.manage/record`, `qacceptance.sign`, `ncr.raise`, `ncr.verify`, `material.record` | Xác nhận khắc phục do chính mình làm |
| Chủ đầu tư/Ban QLDA | UNIT_TREE / PROJECT | `diary.sign.owner`, `diary.lock`, `qacceptance.manage/sign/approve/revoke`, `ncr.manage/close` | Duyệt biên bản thiếu chữ ký bắt buộc |
| Thiết kế, phòng thí nghiệm (khách) | CONTRACT | `qacceptance.sign` với vai trò DESIGNER/TESTING_LAB | Ký vai trò khác |
| Auditor | Scope cấp | `diary.read`, `photo.read` | Ghi |

## 3. Luồng nghiệp vụ

### 3.1 Nhật ký thi công điện tử (UC-QMS-01) — QMS-01, QMS-02, QMS-03, QMS-09, QMS-11, CTR-09
1. `saveSiteDiaryDraft` (web hoặc app offline) với `client_operation_id`, `base_server_version`; cổng `START_CONSTRUCTION` phải đạt với hợp đồng xây dựng. Đã có nhật ký chính cho (hợp đồng, ngày): nếu `base_server_version` khớp → cập nhật nháp; nếu không → lưu bản xung đột `conflict_of_id`, `CONFLICT_PENDING`, trả 409 `DIARY_SYNC_CONFLICT` — không ghi đè.
2. `signSiteDiaryByContractor`: tính `content_hash = SHA-256(JSON chuẩn hóa của content)`, ghi `qms_signature` (append-only) với phương thức; sau ký không sửa được (`DIARY_STATE_INVALID`).
3. `addSupervisorRemark` ghi ý kiến và ký vai trò SUPERVISOR (If-Match chống ghi đè); `confirmSiteDiaryByOwner` (tuỳ quy chế); `lockSiteDiary` khi đã xác nhận hoặc hết hạn chỉnh sửa (rule, mặc định 3 ngày làm việc [GIẢ ĐỊNH]).
4. Sau LOCKED: `correctSiteDiary` tạo bản điều chỉnh (`correction_of_id`, lý do) cũng phải ký lại; bản gốc giữ nguyên.
5. `resolveDiaryConflict`: người có quyền chọn KEEP_PRIMARY / ADOPT_CONFLICT / MERGED; nội dung bị loại lưu trong `issue_event`/audit; bản xung đột → RESOLVED.
6. `getDiaryCoverage`: tổng ngày làm việc, có nhật ký, đã ký, DRAFT, thiếu, ký muộn, xung đột.

### 3.2 Kiểm tra và nghiệm thu chất lượng (UC-QMS-02) — QMS-04, QMS-05, CTR-11, CTR-12
1. `requestInspection` (loại: vật liệu đầu vào, công việc che khuất, giai đoạn, bộ phận, hoàn thành, an toàn); chọn rule quy chế theo `requested_for`; trùng đề nghị mở cho cùng hạng mục/ngày → `INSPECTION_DUPLICATE`.
2. `scheduleInspection` → `recordInspectionResult` (checklist đủ mục bắt buộc; FAIL tạo NCR tự động).
3. `createQualityAcceptance` từ kiểm tra PASS/CONDITIONAL; `required_roles` chụp từ rule.
4. `signQualityAcceptance` theo từng vai trò (mỗi vai trò một chữ ký cho cùng băm nội dung).
5. `decideQualityAcceptance`: đủ chữ ký (`SIGNATURES_INCOMPLETE`), không NCR CRITICAL mở (`OPEN_CRITICAL_NCR`), người duyệt khác người lập → APPROVED; phát `qms.quality_acceptance.approved.v1` (CTR gắn vào nghiệm thu khối lượng). Thu hồi chỉ khi CTR chưa dùng cho nghiệm thu APPROVED.

### 3.3 Thí nghiệm và NCR (UC-QMS-03) — QMS-06, QMS-07
Đăng ký mẫu → kết quả có báo cáo; FAIL tự tạo NCR (`source_kind=MATERIAL_TEST`). NCR: OPEN → giao hành động khắc phục (người, hạn) → nộp bằng chứng (tài liệu/ảnh geotag) → xác nhận độc lập → NCR VERIFIED → đóng; tái phát → REOPENED. CRITICAL đặt `blocks_acceptance = true`. Quá hạn khắc phục tạo vướng mắc ISS; vi phạm chất lượng nghiêm trọng gợi ý ghi `contractor_violation` (CTR).

### 3.4 Ảnh hiện trường (UC-QMS-04) — QMS-08, QMS-10
Ứng dụng tải tệp lên object storage (presigned, key `tenants/{tenant_id}/qms/{uuid}`), sau đó gọi `registerSitePhoto`. Máy chủ quét virus, so SHA-256, đọc EXIF và chạy 4 kiểm tra (§5.6) thành cờ rà soát; vị trí chỉ lưu khi `geo_consent`. Ảnh dùng làm bằng chứng cho nhật ký, kiểm tra, NCR, vướng mắc, tồn tại bàn giao, bảo hành.

## 4. State machine

```
SiteDiary: DRAFT ─contractor-sign─► CONTRACTOR_SIGNED ─supervisor-remark─► SUPERVISED ─owner-confirm─► OWNER_CONFIRMED ─lock─► LOCKED
                                                                      └──────────── lock ───────────────────────────────┘
           LOCKED ─corrections─► (bản mới DRAFT, correction_of_id)   bản xung đột: CONFLICT_PENDING ─resolve─► RESOLVED
Inspection: REQUESTED ─schedule─► SCHEDULED ─result─► RESULT_RECORDED ;  REQUESTED|SCHEDULED ─cancel─► CANCELLED
QualityAcceptance: DRAFT ─sign─► SIGNING ─decision(approve)─► APPROVED ─revoke─► REVOKED ;  SIGNING ─decision(reject)─► REJECTED
NCR: OPEN ─assign-action─► ACTION_ASSIGNED ─(action SUBMITTED)─► ACTION_SUBMITTED ─(mọi action VERIFIED)─► VERIFIED ─close─► CLOSED ─reopen─► REOPENED
CorrectiveAction: ASSIGNED ─evidence─► SUBMITTED ─verify─► VERIFIED | REJECTED ─evidence─► SUBMITTED
MaterialTest: REGISTERED ─result─► RESULT_RECORDED ─► ACCEPTED | REJECTED
```

| Từ | Command | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|
| ∅/DRAFT | `saveSiteDiaryDraft` / `reviseSiteDiaryDraft` | DRAFT | `diary.write` | hợp đồng ACTIVE; cổng PMT; base version | `qms.site_diary.drafted/revised.v1` |
| DRAFT | `signSiteDiaryByContractor` | CONTRACTOR_SIGNED | `diary.sign.contractor` | phương thức được chấp nhận | `qms.site_diary.contractor_signed.v1` |
| CONTRACTOR_SIGNED | `addSupervisorRemark` | SUPERVISED | `diary.sign.supervisor` | If-Match | `qms.site_diary.supervised.v1` |
| SUPERVISED | `confirmSiteDiaryByOwner` | OWNER_CONFIRMED | `diary.sign.owner` | — | `qms.site_diary.owner_confirmed.v1` |
| SUPERVISED/OWNER_CONFIRMED | `lockSiteDiary` | LOCKED | `diary.lock` / job | — | `qms.site_diary.locked.v1` |
| SIGNING | `decideQualityAcceptance(approve)` | APPROVED | `qacceptance.approve` | đủ chữ ký; không NCR CRITICAL; khác người lập | `qms.quality_acceptance.approved.v1` |
| VERIFIED | `closeNonconformance` | CLOSED | `ncr.close` | mọi hành động VERIFIED; khác người khắc phục | `qms.ncr.closed.v1` |

Cấm (409 `*_STATE_INVALID`): sửa nhật ký đã ký, ký lại cùng vai trò cùng băm (`ALREADY_SIGNED`), đóng NCR khi còn hành động chưa VERIFIED (`CORRECTIVE_ACTION_OPEN`), thu hồi biên bản đã dùng cho nghiệm thu APPROVED (`ACCEPTANCE_ALREADY_USED`).

## 5. Quy tắc nghiệp vụ và công thức

- **BR-QMS-01 (một nhật ký chính mỗi ngày).** Unique `(contract_id, record_date)` cho bản chính (không điều chỉnh, không xung đột, không SUPERSEDED).
- **BR-QMS-02 (băm và chữ ký).** `content_hash = SHA-256` của nội dung chuẩn hóa (khóa sắp xếp, số dạng chuỗi); `qms_signature.signed_content_hash` phải bằng băm hiện hành; đổi nội dung sau ký là bất hợp lệ.
- **BR-QMS-03 (hiệu lực chữ ký).** `IN_APP_OTP`/`IN_APP_WEBAUTHN` → `INTERNAL_RECORD` (xác nhận nội bộ, có audit danh tính MFA); `DIGITAL_CERT` → `LEGAL_E_SIGNATURE` (cần `cert_serial`, xác minh chứng thư qua DOC adapter). Loại chữ ký nào đủ giá trị pháp lý cho nhật ký điện tử: [CXN-EXE-05].
- **BR-QMS-04 (quy chế theo ngày).** Phiên bản `QMS.REGIME` = phiên bản có `effective_from ≤ ngày đề nghị < effective_until`; NĐ 06/2021 và NĐ 207/2026 là hai phiên bản dữ liệu; khi [CXN-07] chưa xác nhận hiển thị cảnh báo và slice không DONE.
- **BR-QMS-05 (vai trò ký).** `required_roles` mặc định: công việc/giai đoạn: CONTRACTOR, SUPERVISOR, OWNER; hoàn thành: thêm DESIGNER khi quy chế yêu cầu [CXN-07].
- **BR-QMS-06 (kiểm ảnh).** `check_time`: OK nếu |EXIF − ngày nhật ký/đối tượng| ≤ 24 giờ và EXIF ≤ received_at; SKEW nếu vượt; MISSING nếu không có EXIF. `check_geofence`: INSIDE nếu khoảng cách Haversine tới vùng công trường ≤ bán kính (500 m mặc định [GIẢ ĐỊNH]) và độ chính xác ≤ 50 m; LOW_ACCURACY nếu độ chính xác > 50 m; OUTSIDE nếu ngoài; MISSING nếu không có tọa độ. `check_duplicate`: trùng SHA-256 hoặc pHash (Hamming ≤ 6 [GIẢ ĐỊNH]) với ảnh cùng dự án/khác dự án. `check_exif`: CONSISTENT/STRIPPED/INCONSISTENT (ví dụ thời gian GPS lệch thời gian chụp > 1 giờ). `check_summary`: PASS khi cả 4 tốt; WARN khi có cờ; FAIL khi INFECTED hoặc hash không khớp. Không kết luận “thật/giả”.
- **BR-QMS-07 (NCR).** CRITICAL ⇒ `blocks_acceptance`; xác nhận khắc phục ≠ người khắc phục; NCR quá hạn ⇒ vướng mắc ISS.
- **BR-QMS-08 (độ phủ).** `thiếu = ngày làm việc − ngày có nhật ký chính`; ký muộn = số ngày làm việc từ `record_date` đến chữ ký nhà thầu > 1.

## 6. Dữ liệu

Phân hệ QMS sở hữu 8 bảng (2 bảng hiện có được mở rộng, 6 bảng mới). Quy ước chung: khóa chính `(tenant_id, id)`, khóa ngoại tổng hợp `(tenant_id, x_id)`, tiền `numeric(24,0)` VND nguyên, mọi bảng ENABLE + FORCE RLS với policy RESTRICTIVE `tenant_boundary` và PERMISSIVE `tenant_access` (04 §PostgreSQL và RLS). Mọi cột `*_id` có chỉ mục `<bảng>_<cột>_idx ON (tenant_id, <cột>)`. Cột NOT NULL thêm vào bảng hiện có được thêm nullable hoặc có DEFAULT, backfill rồi mới SET NOT NULL (expand-contract).

#### Bảng `site_diary` (hiện có, mở rộng)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `project_id`, `contract_id`, `record_date`, `client_operation_id`, `content`, `author_id`, `version`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `diary_no` | text | không |  |  | Số nhật ký (hợp đồng/ngày) |
| `status` | text | có | 'DRAFT' | ∈ {DRAFT, CONTRACTOR_SIGNED, SUPERVISED, OWNER_CONFIRMED, LOCKED, SUPERSEDED} |  |
| `content_hash` | char(64) | không |  |  | SHA-256 của content tại lần ký gần nhất |
| `supervisor_remark` | text | không |  |  |  |
| `weather_code` | text | không |  |  |  |
| `workforce_count` | integer | không |  | workforce_count >= 0 |  |
| `correction_of_id` | uuid | không |  | FK site_diary | Bản điều chỉnh sau khi LOCKED |
| `correction_reason` | text | không |  |  |  |
| `conflict_of_id` | uuid | không |  | FK site_diary | Bản xung đột đồng bộ trỏ về bản chính |
| `conflict_state` | text | có | 'NONE' | ∈ {NONE, CONFLICT_PENDING, RESOLVED} |  |
| `device_id` | uuid | không |  |  | Thiết bị tạo bản ghi |
| `locked_at` | timestamptz | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `site_diary_signed_hash_chk`: status = 'DRAFT' OR content_hash IS NOT NULL
- CHECK `site_diary_correction_chk`: (correction_of_id IS NULL) = (correction_reason IS NULL)
- CHECK `site_diary_conflict_chk`: (conflict_of_id IS NULL) = (conflict_state = 'NONE')
- CHECK `site_diary_locked_chk`: status <> 'LOCKED' OR locked_at IS NOT NULL
- UNIQUE INDEX `site_diary_day_uq` (tenant_id, contract_id, record_date) WHERE correction_of_id IS NULL AND conflict_of_id IS NULL AND status <> 'SUPERSEDED'

Chỉ mục: `site_diary_correction_of_id_idx`, `site_diary_conflict_of_id_idx`, `site_diary_device_id_idx`, `site_diary_project_id_idx`, `site_diary_contract_id_idx`, `site_diary_client_operation_id_idx`, `site_diary_author_id_idx`, `site_diary_contract_date_idx`.

#### Bảng `qms_signature` (mới)
Phân loại: Cá nhân (tên người ký) / nội bộ. Lưu giữ: Bất biến; giữ theo RetentionPolicy hồ sơ dự án [CXN-05]. Bảng append-only: `REVOKE UPDATE, DELETE` cho runtime; sửa sai chỉ bằng bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `subject_kind` | text | có |  | ∈ {SITE_DIARY, INSPECTION, QUALITY_ACCEPTANCE, MATERIAL_TEST, CORRECTIVE_ACTION} |  |
| `subject_id` | uuid | có |  |  | Đối tượng được ký (logical, kiểm theo subject_kind) |
| `signer_role` | text | có |  | ∈ {CONTRACTOR, SUPERVISOR, OWNER, DESIGNER, TESTING_LAB, OTHER} |  |
| `membership_id` | uuid | có |  | FK membership |  |
| `signer_name_snapshot` | text | có |  |  | Họ tên tại thời điểm ký (PERSONAL, mask khi xuất) |
| `method` | text | có |  | ∈ {IN_APP_OTP, IN_APP_WEBAUTHN, DIGITAL_CERT} |  |
| `legal_effect` | text | có |  | ∈ {INTERNAL_RECORD, LEGAL_E_SIGNATURE} | DIGITAL_CERT = chữ ký số hợp lệ; còn lại = xác nhận nội bộ [CXN-EXE-05] |
| `cert_serial` | text | không |  |  |  |
| `signed_content_hash` | char(64) | có |  |  |  |
| `signed_at` | timestamptz | có |  |  |  |
| `device_id` | uuid | không |  |  |  |
| `client_operation_id` | uuid | có |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |

Bất biến DB:
- CHECK `qms_signature_cert_chk`: method <> 'DIGITAL_CERT' OR cert_serial IS NOT NULL
- CHECK `qms_signature_effect_chk`: (method = 'DIGITAL_CERT') = (legal_effect = 'LEGAL_E_SIGNATURE')
- UNIQUE INDEX `qms_signature_once_uq` (tenant_id, subject_kind, subject_id, signer_role, signed_content_hash)
- UNIQUE INDEX `qms_signature_op_uq` (tenant_id, client_operation_id)

Chỉ mục: `qms_signature_subject_id_idx`, `qms_signature_membership_id_idx`, `qms_signature_device_id_idx`, `qms_signature_client_operation_id_idx`, `qms_signature_subject_idx`.

#### Bảng `site_photo` (mới)
Phân loại: Nội bộ (có thể chứa vị trí, cần đồng ý). Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `project_id` | uuid | có |  | FK project |  |
| `contract_id` | uuid | không |  | FK contract |  |
| `site_diary_id` | uuid | không |  | FK site_diary |  |
| `inspection_id` | uuid | không |  | FK inspection |  |
| `nonconformance_id` | uuid | không |  | FK quality_nonconformance |  |
| `issue_id` | uuid | không |  | FK issue |  |
| `client_operation_id` | uuid | có |  |  | Khóa chống nhân đôi khi tải lại |
| `object_key` | text | có |  |  | tenants/{tenant_id}/qms/{uuid} |
| `file_sha256` | char(64) | có |  |  |  |
| `scan_status` | text | có | 'PENDING' | ∈ {PENDING, CLEAN, INFECTED} |  |
| `taken_at_exif` | timestamptz | không |  |  | DateTimeOriginal từ EXIF (không phải bằng chứng tuyệt đối) |
| `received_at` | timestamptz | có | now() |  | Thời điểm máy chủ nhận |
| `gps_lat` | numeric(9,6) | không |  |  |  |
| `gps_lng` | numeric(9,6) | không |  |  |  |
| `gps_accuracy_m` | numeric(8,2) | không |  |  |  |
| `gps_source` | text | có | 'NONE' | ∈ {EXIF, DEVICE_AT_CAPTURE, MANUAL, NONE} |  |
| `geo_consent` | boolean | có | false |  |  |
| `device_id` | uuid | không |  |  |  |
| `device_model` | text | không |  |  |  |
| `check_time` | text | có | 'MISSING' | ∈ {OK, SKEW, MISSING} | So taken_at_exif với received_at và ngày nhật ký |
| `check_geofence` | text | có | 'MISSING' | ∈ {INSIDE, OUTSIDE, LOW_ACCURACY, MISSING} | So GPS với vùng công trường của dự án |
| `check_duplicate` | text | có | 'UNIQUE' | ∈ {UNIQUE, DUPLICATE_SAME_SITE, DUPLICATE_OTHER_SITE} | Trùng hash/pHash với ảnh đã có |
| `check_exif` | text | có | 'STRIPPED' | ∈ {CONSISTENT, STRIPPED, INCONSISTENT} | EXIF còn nguyên/bị xóa/mâu thuẫn |
| `check_summary` | text | có | 'WARN' | ∈ {PASS, WARN, FAIL} | Tổng hợp cờ; chỉ là cờ rà soát, không phải kết luận xác thực |
| `caption` | text | không |  |  |  |
| `uploaded_by` | uuid | có |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |

Bất biến DB:
- CHECK `site_photo_geo_consent_chk`: gps_lat IS NULL OR geo_consent OR gps_source = 'EXIF'
- UNIQUE INDEX `site_photo_op_uq` (tenant_id, client_operation_id)

Chỉ mục: `site_photo_project_id_idx`, `site_photo_contract_id_idx`, `site_photo_site_diary_id_idx`, `site_photo_inspection_id_idx`, `site_photo_nonconformance_id_idx`, `site_photo_issue_id_idx`, `site_photo_client_operation_id_idx`, `site_photo_device_id_idx`, `site_photo_hash_idx`, `site_photo_project_time_idx`.

#### Bảng `inspection` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `project_id` | uuid | có |  | FK project |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `boq_item_id` | uuid | không |  | FK boq_item |  |
| `inspection_no` | text | có |  |  |  |
| `inspection_type` | text | có |  | ∈ {MATERIAL_ENTRY, CONCEALED_WORK, CONSTRUCTION_STAGE, PART_ACCEPTANCE, COMPLETION, SAFETY, OTHER} |  |
| `title` | text | có |  |  |  |
| `location_text` | text | không |  |  |  |
| `requested_by` | uuid | có |  |  |  |
| `requested_for` | date | có |  |  | Ngày đề nghị kiểm tra/nghiệm thu |
| `scheduled_at` | timestamptz | không |  |  |  |
| `status` | text | có | 'REQUESTED' | ∈ {REQUESTED, SCHEDULED, RESULT_RECORDED, CANCELLED} |  |
| `result` | text | không |  | ∈ {PASS, FAIL, CONDITIONAL} |  |
| `result_note` | text | không |  |  |  |
| `result_recorded_by` | uuid | không |  |  |  |
| `result_recorded_at` | timestamptz | không |  |  |  |
| `checklist` | jsonb | có | '[]'::jsonb |  | Danh mục kiểm tra theo rule version |
| `regime_rule_version_id` | uuid | không |  |  | rule registry QMS.REGIME (NĐ 06/2021 \| NĐ 207/2026) [CXN-07] |
| `site_diary_id` | uuid | không |  | FK site_diary | Nhật ký ngày ghi nhận việc kiểm tra |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `inspection_result_chk`: status <> 'RESULT_RECORDED' OR (result IS NOT NULL AND result_recorded_by IS NOT NULL AND result_recorded_at IS NOT NULL)
- UNIQUE INDEX `inspection_no_uq` (tenant_id, contract_id, inspection_no)

Chỉ mục: `inspection_project_id_idx`, `inspection_contract_id_idx`, `inspection_boq_item_id_idx`, `inspection_regime_rule_version_id_idx`, `inspection_site_diary_id_idx`, `inspection_contract_status_idx`.

#### Bảng `quality_acceptance` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `project_id` | uuid | có |  | FK project |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `inspection_id` | uuid | có |  | FK inspection |  |
| `record_no` | text | có |  |  |  |
| `acceptance_scope` | text | có |  | ∈ {WORK_ITEM, STAGE, PART, COMPLETION} |  |
| `document_version_id` | uuid | không |  | FK document_version | Biên bản nghiệm thu |
| `status` | text | có | 'DRAFT' | ∈ {DRAFT, SIGNING, APPROVED, REJECTED, REVOKED} |  |
| `required_roles` | jsonb | có |  |  | Ảnh chụp vai trò phải ký theo rule version |
| `decision_note` | text | không |  |  |  |
| `approved_at` | timestamptz | không |  |  |  |
| `approved_by` | uuid | không |  |  |  |
| `regime_rule_version_id` | uuid | không |  |  | QMS.REGIME [CXN-07] |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `quality_acceptance_approved_chk`: status <> 'APPROVED' OR (document_version_id IS NOT NULL AND approved_at IS NOT NULL AND approved_by IS NOT NULL)
- UNIQUE INDEX `quality_acceptance_no_uq` (tenant_id, contract_id, record_no)

Chỉ mục: `quality_acceptance_project_id_idx`, `quality_acceptance_contract_id_idx`, `quality_acceptance_inspection_id_idx`, `quality_acceptance_document_version_id_idx`, `quality_acceptance_regime_rule_version_id_idx`, `quality_acceptance_inspection_status_idx`.

#### Bảng `material_test` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `project_id` | uuid | có |  | FK project |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `boq_item_id` | uuid | không |  | FK boq_item |  |
| `sample_code` | text | có |  |  |  |
| `material_kind` | text | có |  |  |  |
| `lab_name` | text | có |  |  |  |
| `standard_ref` | text | có |  |  | Tiêu chuẩn/quy chuẩn áp dụng |
| `sampled_on` | date | có |  |  |  |
| `sampled_by` | uuid | có |  |  |  |
| `tested_on` | date | không |  |  |  |
| `result` | text | có | 'PENDING' | ∈ {PENDING, PASS, FAIL} |  |
| `result_values` | jsonb | có | '{}'::jsonb |  |  |
| `report_document_version_id` | uuid | không |  | FK document_version |  |
| `status` | text | có | 'REGISTERED' | ∈ {REGISTERED, RESULT_RECORDED, ACCEPTED, REJECTED} |  |
| `nonconformance_id` | uuid | không |  | FK quality_nonconformance | NCR tự tạo khi FAIL |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `material_test_result_chk`: status = 'REGISTERED' OR (result <> 'PENDING' AND tested_on IS NOT NULL AND report_document_version_id IS NOT NULL)
- UNIQUE INDEX `material_test_sample_uq` (tenant_id, contract_id, sample_code)

Chỉ mục: `material_test_project_id_idx`, `material_test_contract_id_idx`, `material_test_boq_item_id_idx`, `material_test_report_document_version_id_idx`, `material_test_nonconformance_id_idx`.

#### Bảng `quality_nonconformance` (hiện có, mở rộng)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `project_id`, `contract_id`, `measurement_id`, `severity`, `action_owner_id`, `due_at`, `status`, `closure_evidence`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `ncr_no` | text | không |  |  | Số NCR theo hợp đồng |
| `title` | text | không |  |  |  |
| `description` | text | không |  |  |  |
| `source_kind` | text | không |  | ∈ {INSPECTION, MATERIAL_TEST, SUPERVISOR_REMARK, SELF_REPORT, AUDIT} |  |
| `inspection_id` | uuid | không |  | FK inspection |  |
| `material_test_id` | uuid | không |  | FK material_test |  |
| `site_diary_id` | uuid | không |  | FK site_diary |  |
| `detected_on` | date | không |  |  |  |
| `root_cause` | text | không |  |  |  |
| `blocks_acceptance` | boolean | có | false |  | NCR nghiêm trọng chặn nghiệm thu chất lượng |
| `verified_by` | uuid | không |  |  |  |
| `verified_at` | timestamptz | không |  |  |  |
| `closed_by` | uuid | không |  |  |  |
| `closed_at` | timestamptz | không |  |  |  |
| `version` | bigint | có | 1 |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `ncr_critical_blocks_chk`: severity <> 'CRITICAL' OR blocks_acceptance
- CHECK `ncr_verifier_chk`: verified_by IS NULL OR verified_by <> action_owner_id
- CHECK `ncr_closed_chk`: status <> 'CLOSED' OR (verified_by IS NOT NULL AND closed_by IS NOT NULL AND closed_at IS NOT NULL)
- UNIQUE INDEX `ncr_no_uq` (tenant_id, contract_id, ncr_no) WHERE ncr_no IS NOT NULL

Chỉ mục: `quality_nonconformance_inspection_id_idx`, `quality_nonconformance_material_test_id_idx`, `quality_nonconformance_site_diary_id_idx`, `quality_nonconformance_project_id_idx`, `quality_nonconformance_contract_id_idx`, `quality_nonconformance_measurement_id_idx`, `quality_nonconformance_action_owner_id_idx`, `ncr_status_due_idx`.

#### Bảng `corrective_action` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `nonconformance_id` | uuid | có |  | FK quality_nonconformance |  |
| `description` | text | có |  |  |  |
| `owner_membership_id` | uuid | có |  | FK membership |  |
| `due_at` | timestamptz | có |  |  |  |
| `status` | text | có | 'ASSIGNED' | ∈ {ASSIGNED, SUBMITTED, REJECTED, VERIFIED} |  |
| `evidence_document_version_id` | uuid | không |  | FK document_version |  |
| `evidence_photo_id` | uuid | không |  | FK site_photo |  |
| `submitted_at` | timestamptz | không |  |  |  |
| `verified_by` | uuid | không |  |  |  |
| `verified_at` | timestamptz | không |  |  |  |
| `verification_note` | text | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `corrective_action_verify_chk`: status <> 'VERIFIED' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND (evidence_document_version_id IS NOT NULL OR evidence_photo_id IS NOT NULL))
- CHECK `corrective_action_independent_chk`: verified_by IS NULL OR verified_by <> owner_membership_id

Chỉ mục: `corrective_action_nonconformance_id_idx`, `corrective_action_owner_membership_id_idx`, `corrective_action_evidence_document_version_id_idx`, `corrective_action_evidence_photo_id_idx`.


## 7. API / command

Mọi lệnh ghi: `Idempotency-Key` (≥16 ký tự) bắt buộc; `If-Match` bắt buộc khi đổi bản ghi có version (cột "If-Match" = có); lỗi trả RFC 7807 Problem với `code` ổn định; DTO là allowlist (trường thừa → 400 INVALID_REQUEST); không có endpoint ghi chung cho `status`, `tenant_id`, role hoặc số tiền đã chốt. Mã lỗi chung ngoài bảng: 401 SESSION_EXPIRED, 403 SCOPE_DENIED, 404 RESOURCE_NOT_FOUND, 409 IDEMPOTENCY_CONFLICT, 422 VALIDATION_FAILED, 429 RATE_LIMIT, 503 PROVIDER_UNAVAILABLE.

| operationId | Method path | Quyền (x-permission) | Request DTO (trường được phép; * = bắt buộc) | Response | Lỗi (HTTP + code) | Idempotency | If-Match |
|---|---|---|---|---|---|---|---|
| `saveSiteDiaryDraft` | `POST /site-diaries` | `diary.write` | contract_id*, record_date*, client_operation_id*, base_server_version, content*, device_id | CommandResult | 409 DIARY_DAY_EXISTS; 409 DIARY_SYNC_CONFLICT; 409 CONTRACT_STATE_INVALID; 409 PERMIT_GATE_BLOCKED; 422 VALIDATION_FAILED | bắt buộc | không |
| `reviseSiteDiaryDraft` | `POST /site-diaries/{id}/draft` | `diary.write` | content*, client_operation_id* | CommandResult | 409 DIARY_STATE_INVALID; 409 DIARY_SYNC_CONFLICT; 409 VERSION_CONFLICT | bắt buộc | có |
| `signSiteDiaryByContractor` | `POST /site-diaries/{id}/contractor-sign` | `diary.sign.contractor` | signature_method*, cert_serial, client_operation_id* | CommandResult | 409 DIARY_STATE_INVALID; 422 SIGNATURE_METHOD_NOT_ACCEPTED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `addSupervisorRemark` | `POST /site-diaries/{id}/supervisor-remark` | `diary.sign.supervisor` | remark*, signature_method*, cert_serial, client_operation_id* | CommandResult | 409 DIARY_STATE_INVALID; 422 SIGNATURE_METHOD_NOT_ACCEPTED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `confirmSiteDiaryByOwner` | `POST /site-diaries/{id}/owner-confirm` | `diary.sign.owner` | note, signature_method*, cert_serial, client_operation_id* | CommandResult | 409 DIARY_STATE_INVALID; 422 SIGNATURE_METHOD_NOT_ACCEPTED; 409 VERSION_CONFLICT | bắt buộc | có |
| `lockSiteDiary` | `POST /site-diaries/{id}/lock` | `diary.lock` | reason | CommandResult | 409 DIARY_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `correctSiteDiary` | `POST /site-diaries/{id}/corrections` | `diary.correct` | content*, correction_reason*, client_operation_id* | CommandResult | 409 DIARY_STATE_INVALID; 422 VALIDATION_FAILED | bắt buộc | không |
| `resolveDiaryConflict` | `POST /site-diaries/{id}/resolve-conflict` | `diary.write` | conflict_diary_id*, resolution*, merged_content, note* | CommandResult | 409 DIARY_STATE_INVALID; 422 VALIDATION_FAILED; 409 VERSION_CONFLICT | bắt buộc | có |
| `registerSitePhoto` | `POST /site-photos` | `photo.upload` | client_operation_id*, project_id*, contract_id, site_diary_id, inspection_id, nonconformance_id, issue_id, object_key*, file_sha256*, device_id, device_model, device_gps_lat, device_gps_lng, device_gps_accuracy_m, geo_consent, caption | CommandResult | 422 FILE_NOT_CLEAN; 422 HASH_MISMATCH; 422 GEO_CONSENT_REQUIRED; 422 VALIDATION_FAILED | bắt buộc | không |
| `requestInspection` | `POST /inspections` | `inspection.request` | contract_id*, boq_item_id, inspection_type*, title*, location_text, requested_for*, site_diary_id | CommandResult | 409 CONTRACT_STATE_INVALID; 422 PERMIT_GATE_BLOCKED; 409 INSPECTION_DUPLICATE; 422 REGIME_NOT_EFFECTIVE; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | không |
| `scheduleInspection` | `POST /inspections/{id}/schedule` | `inspection.manage` | scheduled_at*, participant_membership_ids* | CommandResult | 409 INSPECTION_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `recordInspectionResult` | `POST /inspections/{id}/result` | `inspection.record` | result*, result_note*, checklist* | CommandResult | 409 INSPECTION_STATE_INVALID; 422 CHECKLIST_INCOMPLETE; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `cancelInspection` | `POST /inspections/{id}/cancel` | `inspection.manage` | reason* | CommandResult | 409 INSPECTION_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `createQualityAcceptance` | `POST /inspections/{id}/quality-acceptances` | `qacceptance.manage` | acceptance_scope*, record_no*, document_version_id* | CommandResult | 422 INSPECTION_NOT_PASSED; 422 OPEN_CRITICAL_NCR; 409 CONTRACT_STATE_INVALID; 409 QUALITY_ACCEPTANCE_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | không |
| `signQualityAcceptance` | `POST /quality-acceptances/{id}/sign` | `qacceptance.sign` | signer_role*, signature_method*, cert_serial, client_operation_id* | CommandResult | 422 ROLE_NOT_REQUIRED; 409 ALREADY_SIGNED; 422 SIGNATURE_METHOD_NOT_ACCEPTED; 409 QUALITY_ACCEPTANCE_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `decideQualityAcceptance` | `POST /quality-acceptances/{id}/decision` | `qacceptance.approve` | decision*, reason* | CommandResult | 422 SIGNATURES_INCOMPLETE; 422 OPEN_CRITICAL_NCR; 403 SELF_APPROVAL_DENIED; 409 CONTRACT_STATE_INVALID; 409 QUALITY_ACCEPTANCE_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `revokeQualityAcceptance` | `POST /quality-acceptances/{id}/revoke` | `qacceptance.revoke` | reason* | CommandResult | 409 ACCEPTANCE_ALREADY_USED; 409 QUALITY_ACCEPTANCE_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `registerMaterialTest` | `POST /material-tests` | `material.manage` | contract_id*, boq_item_id, sample_code*, material_kind*, lab_name*, standard_ref*, sampled_on* | CommandResult | 409 SAMPLE_CODE_DUPLICATE; 422 VALIDATION_FAILED | bắt buộc | không |
| `recordMaterialTestResult` | `POST /material-tests/{id}/result` | `material.record` | result*, tested_on*, result_values*, report_document_version_id* | CommandResult | 409 MATERIAL_TEST_STATE_INVALID; 422 DOCUMENT_NOT_CLEAN; 409 VERSION_CONFLICT | bắt buộc | có |
| `raiseNonconformance` | `POST /nonconformances` | `ncr.raise` | contract_id*, measurement_id, severity*, title*, description*, source_kind*, inspection_id, material_test_id, site_diary_id, action_owner_id*, due_at* | CommandResult | 409 CONTRACT_STATE_INVALID; 422 VALIDATION_FAILED | bắt buộc | không |
| `assignCorrectiveAction` | `POST /nonconformances/{id}/corrective-actions` | `ncr.manage` | description*, owner_membership_id*, due_at* | CommandResult | 409 NCR_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `submitCorrectiveEvidence` | `POST /corrective-actions/{id}/evidence` | `ncr.respond` | evidence_document_version_id, evidence_photo_id, note* | CommandResult | 422 EVIDENCE_REQUIRED; 409 CORRECTIVE_ACTION_STATE_INVALID; 403 SCOPE_DENIED | bắt buộc | không |
| `verifyCorrectiveAction` | `POST /corrective-actions/{id}/verify` | `ncr.verify` | outcome*, verification_note* | CommandResult | 403 SELF_APPROVAL_DENIED; 409 CORRECTIVE_ACTION_STATE_INVALID | bắt buộc | không |
| `closeNonconformance` | `POST /nonconformances/{id}/close` | `ncr.close` | closure_note* | CommandResult | 422 CORRECTIVE_ACTION_OPEN; 403 SELF_APPROVAL_DENIED; 409 NCR_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `reopenNonconformance` | `POST /nonconformances/{id}/reopen` | `ncr.close` | reason* | CommandResult | 409 NCR_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `getDiaryCoverage` | `GET /contracts/{id}/site-diaries/coverage` | `diary.read` | from, to | DTO đọc (read model) | — | — | không |
| `getSitePhotoChecks` | `GET /site-photos/{id}/checks` | `photo.read` | (không) | DTO đọc (read model) | — | — | không |

Mô tả ngắn từng lệnh (summary OpenAPI) và guard trạng thái nằm ở `openapi.json` (`x-state-guard`, `x-domain-events`, `x-error-codes`).

Rà soát GET scaffold (`x-contract-maturity: reference-scaffolding`) của tài nguyên thuộc phân hệ:

| Tài nguyên | Quyết định | Lý do |
|---|---|---|
| `/resources/site_diary` (list + get) | DTO riêng | Trả nội dung nhật ký theo vai trò; ẩn định danh cá nhân người ghi khi xuất ngoài phạm vi hợp đồng. |
| `/resources/quality_nonconformance` (list + get) | DTO riêng | Ẩn phân tích nguyên nhân nội bộ với nhà thầu khách; giữ trạng thái và hạn khắc phục. |

## 8. UI/UX

Tuân thủ mockup (D-B11). Nhãn chữ ký phân biệt “xác nhận nội bộ” và “chữ ký số”. Cờ kiểm ảnh dùng biểu tượng + chữ (không chỉ màu).

| ID | Tên màn hình | Loại | Nền tảng | Phase | Trường chính | Command / API | Ghi chú nghiệp vụ |
|---|---|---|---|---|---|---|---|
| QMS-01 | Danh mục nhật ký thi công điện tử | table | web | P1 | Ngày, Hợp đồng, Trạng thái ký, Ý kiến giám sát, Xung đột đồng bộ, Số ảnh | `getDiaryCoverage` | Một nhật ký chính mỗi hợp đồng mỗi ngày; điều chỉnh sau khóa bằng bản điều chỉnh (UC-QMS-01) |
| QMS-02 | Lập và ký nhật ký ngày | form | web | P1 | Ngày, Thời tiết, Nhân lực, Thiết bị, Công việc theo BOQ, Sự kiện, Ảnh, Chữ ký nhà thầu | `saveSiteDiaryDraft`, `reviseSiteDiaryDraft`, `signSiteDiaryByContractor`, `correctSiteDiary` | Ký băm nội dung; sửa sau khi ký bị chặn; phân biệt xác nhận nội bộ và chữ ký số (UC-QMS-01) |
| QMS-03 | Ý kiến giám sát và xác nhận chủ đầu tư | review | web | P1 | Nhật ký, Ý kiến giám sát, Chữ ký giám sát, Xác nhận chủ đầu tư, Khóa | `addSupervisorRemark`, `confirmSiteDiaryByOwner`, `lockSiteDiary`, `resolveDiaryConflict` | Mỗi vai trò ký đúng một lần theo hash nội dung; If-Match chống ghi đè (UC-QMS-01) |
| QMS-04 | Đề nghị kiểm tra, nghiệm thu | form | web | P1 | Hợp đồng, Hạng mục BOQ, Loại kiểm tra, Vị trí, Ngày đề nghị, Nhật ký liên quan | `requestInspection`, `scheduleInspection`, `recordInspectionResult`, `cancelInspection` | Hợp đồng ACTIVE và cổng giấy phép đạt; quy chế áp dụng theo ngày đề nghị (UC-QMS-02) |
| QMS-05 | Biên bản nghiệm thu chất lượng | approval | web | P1 | Biên bản, Phạm vi, Vai trò phải ký, Đã ký, NCR nghiêm trọng, Quyết định | `createQualityAcceptance`, `signQualityAcceptance`, `decideQualityAcceptance`, `revokeQualityAcceptance` | Duyệt cần đủ chữ ký theo quy chế và không còn NCR nghiêm trọng; duyệt phát sự kiện cho CTR (UC-QMS-02) |
| QMS-06 | Thí nghiệm vật liệu | table | web | P1 | Mẫu, Vật liệu, Phòng thí nghiệm, Tiêu chuẩn, Kết quả, Báo cáo, NCR | `registerMaterialTest`, `recordMaterialTestResult` | Không đạt tự tạo NCR; kết quả cần báo cáo đính kèm (UC-QMS-03) |
| QMS-07 | Không phù hợp và hành động khắc phục | board | web | P1 | NCR, Mức độ, Chủ khắc phục, Hạn, Bằng chứng, Người xác nhận, Trạng thái | `raiseNonconformance`, `assignCorrectiveAction`, `submitCorrectiveEvidence`, `verifyCorrectiveAction`, `closeNonconformance`, `reopenNonconformance` | NCR CRITICAL chặn nghiệm thu; xác nhận khác người khắc phục (UC-QMS-03) |
| QMS-08 | Kho ảnh hiện trường có định vị | map | web | P1 | Ảnh, Thời gian chụp (EXIF), Thời gian nhận, Vị trí, Độ chính xác, Cờ kiểm tra, Liên kết | `registerSitePhoto`, `getSitePhotoChecks` | Cờ EXIF/GPS/thời gian/trùng lặp chỉ để rà soát, không kết luận xác thực; vị trí chỉ khi có đồng ý (UC-QMS-04) |
| QMS-09 | Nhật ký thi công ngoại tuyến trên điện thoại | offline | mobile | P1 | Ngày, Nội dung nháp, Hàng đợi chưa gửi, Xung đột đồng bộ, Ký nhà thầu | `saveSiteDiaryDraft`, `signSiteDiaryByContractor`, `resolveDiaryConflict` | Chỉ xếp hàng lệnh với client_operation_id; xung đột không ghi đè im lặng; đổi tenant chặn khi còn hàng đợi (UC-QMS-01) |
| QMS-10 | Chụp ảnh hiện trường kiểm EXIF và GPS | form | mobile | P1 | Ảnh, Chú thích, Hợp đồng / nhật ký, Vị trí (khi đồng ý), Cờ kiểm tra | `registerSitePhoto` | Chỉ lưu vị trí khi người dùng đồng ý; hiển thị cờ trước khi gửi (UC-QMS-04) |
| QMS-11 | Độ phủ nhật ký và cảnh báo thiếu nhật ký | calendar | web | P1 | Ngày làm việc, Có nhật ký, Đã ký, Thiếu, Ký muộn, Xung đột | `getDiaryCoverage` | Tính theo lịch làm việc; ký bù hiển thị số ngày muộn (UC-QMS-01) |


**Trạng thái riêng.** “Xung đột đồng bộ” (so sánh hai bản cạnh nhau, chọn/ghép), “đã ký – chỉ đọc”, “thiếu chữ ký: …”, “NCR nghiêm trọng đang chặn”, “quy chế chưa xác nhận [CXN-07]”. **Web/mobile.** Mobile: nhật ký nháp offline, ảnh có hàng đợi tải, ký nhà thầu bằng OTP/WebAuthn khi online; giám sát duyệt trên MOB-64/MOB-65 chỉ online; đổi tenant bị chặn khi còn hàng đợi.

## 9. Sự kiện, job, tích hợp, quan sát

**Phát.** `qms.site_diary.drafted/revised/contractor_signed/supervised/owner_confirmed/locked/corrected/conflict_resolved.v1`; `qms.site_photo.registered.v1` {photo_id, project_id, check_summary}; `qms.inspection.requested/scheduled/result_recorded/cancelled.v1`; `qms.quality_acceptance.drafted/signed/approved/revoked.v1` {quality_acceptance_id, contract_id, inspection_id, acceptance_scope, boq_item_id}; `qms.material_test.*.v1`; `qms.ncr.raised/closed/reopened.v1` {ncr_id, contract_id, severity, blocks_acceptance}; `qms.corrective_action.*.v1`.
**Nhận.** `pmt.permit.*` (đánh giá cổng), `ctr.contract.suspended/terminated.v1` (chặn ghi nhật ký mới).
**Job.** `diary-auto-lock` (01:00 VN), `diary-coverage` (06:00 VN, cảnh báo thiếu nhật ký), `ncr-overdue` (mỗi giờ). Pipeline ảnh: quét virus → EXIF → kiểm tra (worker, idempotent theo `client_operation_id`).
**Đồng bộ mobile.** Hợp đồng sync: `site_diary` (id, contract_id, record_date, status, version, content — chỉ hợp đồng trong scope), `inspection` (trạng thái), không sync `qms_signature.signer_name_snapshot` ngoài người ký.
**Quan sát.** `qms_diary_missing_days`, `qms_sync_conflict_total`, `qms_photo_check{result}`, `qms_ncr_open{severity}`. Log không chứa tọa độ, tên người ký.

## 10. Kiểm thử

Bộ fixture synthetic dùng chung được định nghĩa tại `PAY.md` §10 (nhãn [EXE-FX]); mọi ID/người dùng trong bảng là dữ liệu giả. Các test dưới đây là nguồn của `test_cases.json` (ID `UAT-AC…`); loại: domain / integration / security / concurrency / performance / E2E.

| ID | Loại | Ưu tiên | Tình huống | Setup | Input | Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|---|---|
| UAT-AC62 | business | P1 | Hai thiết bị đồng bộ cùng nhật ký không nhân đôi; xung đột không ghi đè im lặng | [EXE-FX] Thiết bị D1 (u.nt) và D2 (u.gs hỗ trợ, cùng hợp đồng) ngoại tuyến cùng soạn nhật ký HD-A-001 ngày 2026-06-10; D1 client_operation_id=OP-D1-001 nội dung công việc "Đào đất B01: 120 m3", nhân lực 25; D2 client_operation_id=OP-D2-001 nội dung "Đào đất B01: 150 m3", nhân lực 30; base_server_version=0 cả hai. | D1 đồng bộ trước; D2 đồng bộ sau; D1 gửi lại OP-D1-001; resolveDiaryConflict. | 1. D1 gọi saveSiteDiaryDraft. 2. D2 gọi saveSiteDiaryDraft (cùng contract_id + record_date). 3. D1 gửi lại OP-D1-001. 4. Đọc site_diary theo hợp đồng + ngày. 5. u.cv.hd gọi resolveDiaryConflict chọn MERGED với nội dung 150 m3 kèm ghi chú. | hai thiết bị sync cùng nhật ký không nhân đôi; conflict không ghi đè silent. Cụ thể: D1: 200 tạo bản chính. D2: 409 DIARY_SYNC_CONFLICT và lưu bản xung đột (conflict_of_id = bản chính, conflict_state=CONFLICT_PENDING) — không ghi đè bản chính (nội dung vẫn 120 m3). Gửi lại OP-D1-001: trả lại đúng bản chính, tổng bản ghi không tăng. Truy vấn theo hợp đồng+ngày: 1 bản chính + 1 bản xung đột (unique site_diary_day_uq không vi phạm). Sau resolve: bản chính version tăng, nội dung theo kết quả đã chọn, bản xung đột RESOLVED, không mất nội dung của D2 (lưu trong issue_event/audit). | Bảng site_diary, response từng thiết bị |
| UAT-AC356 | domain | P0 | Luồng ký nhật ký: nhà thầu → giám sát → chủ đầu tư → khóa; băm nội dung | [EXE-FX] Nhật ký D-A-0610 DRAFT ngày 2026-06-10 HD-A-001; u.nt ký nhà thầu, u.gs là giám sát, u.cv.hd đại diện chủ đầu tư. | signSiteDiaryByContractor; sửa nội dung sau ký; addSupervisorRemark; confirmSiteDiaryByOwner; lockSiteDiary; correctSiteDiary. | 1. u.nt ký (IN_APP_OTP); đọc content_hash và qms_signature. 2. u.nt gọi reviseSiteDiaryDraft sau khi ký. 3. u.gs ghi ý kiến + ký. 4. u.cv.hd xác nhận; lock. 5. u.nt gọi correctSiteDiary với lý do; đọc site_diary. | Bước 1: status CONTRACTOR_SIGNED, content_hash = SHA-256(content) khớp signed_content_hash. Bước 2: 409 DIARY_STATE_INVALID. Bước 3: SUPERVISED, supervisor_remark lưu. Bước 4: OWNER_CONFIRMED rồi LOCKED (locked_at ≠ NULL). Bước 5: tạo bản điều chỉnh mới correction_of_id = bản gốc, correction_reason lưu, bản gốc giữ nguyên nội dung và chữ ký (không bị sửa); mỗi chữ ký ghi vào qms_signature bất biến. | Bảng site_diary, qms_signature |
| UAT-AC357 | domain | P0 | Phương thức ký và hiệu lực pháp lý của chữ ký điện tử trong nhật ký | [EXE-FX] Rule QMS.SIGNATURE fixture: chấp nhận IN_APP_OTP/IN_APP_WEBAUTHN như xác nhận nội bộ; DIGITAL_CERT là chữ ký số hợp lệ [CXN-EXE-05 chưa xác nhận]; nhật ký D-A-0611 DRAFT. | signSiteDiaryByContractor với DIGITAL_CERT không cert_serial; với cert_serial=SN-0099; với IN_APP_OTP; chèn trực tiếp qms_signature method=DIGITAL_CERT legal_effect=INTERNAL_RECORD. | 1. Ký với DIGITAL_CERT thiếu cert_serial. 2. Ký với DIGITAL_CERT cert_serial=SN-0099. 3. Ký D-A-0612 với IN_APP_OTP. 4. INSERT trực tiếp bản ghi sai hiệu lực. | Bước 1: 422 SIGNATURE_METHOD_NOT_ACCEPTED. Bước 2: legal_effect=LEGAL_E_SIGNATURE, cert_serial=SN-0099. Bước 3: legal_effect=INTERNAL_RECORD (hiển thị "xác nhận nội bộ", không khẳng định chữ ký số). Bước 4: lỗi CHECK qms_signature_effect_chk. Màn hình QMS-02 hiển thị nhãn phân biệt hai loại. | Bảng qms_signature, ảnh QMS-02 |
| UAT-AC358 | integration | P1 | Gửi lại nhật ký offline cùng client_operation_id không nhân đôi | [EXE-FX] Thiết bị D1 có hàng đợi lệnh: OP-D1-010 (saveSiteDiaryDraft ngày 2026-06-11), OP-D1-011 (contractor-sign); mạng đứt giữa chừng. | Đồng bộ batch 3 lần với mạng chập chờn; sau lần 2 server đã commit nhưng ứng dụng không nhận phản hồi. | 1. Gửi batch lần 1 (thành công nhưng mất phản hồi). 2. Gửi lại cả batch với cùng client_operation_id. 3. Gửi lại lần 3. 4. Đếm site_diary, qms_signature và outbox. | Lần 2 và 3 trả lại kết quả của lần 1 theo từng mục (accepted); chỉ có 1 site_diary cho ngày 2026-06-11, 1 qms_signature, 1 outbox qms.site_diary.contractor_signed.v1. Không mục nào bị đánh dấu conflict. | Response batch từng lần, số bản ghi |
| UAT-AC359 | domain | P1 | Kiểm EXIF/GPS/thời gian/trùng lặp ảnh hiện trường (cờ rà soát) | [EXE-FX] Vùng công trường PRJ-A-001 đoạn km0 tâm (10.800000, 106.700000) bán kính 500 m [GIẢ ĐỊNH ngưỡng]; ngưỡng lệch thời gian 24 giờ; ngưỡng độ chính xác GPS 50 m; nhật ký ngày 2026-06-10; ảnh P1..P6 như mô tả bên dưới. | registerSitePhoto cho: P1 EXIF 2026-06-10 08:15, GPS (10.8002,106.7003) accuracy 8 m, nhận 2026-06-10 17:00; P2 EXIF 2026-06-05; P3 GPS (10.9000,106.8000); P4 accuracy 120 m; P5 không EXIF; P6 trùng SHA-256 với P1. | 1. Đăng ký P1..P6 (geo_consent=true). 2. Đọc check_time, check_geofence, check_duplicate, check_exif, check_summary từng ảnh. 3. Đăng ký P1 lần 2 với cùng client_operation_id. 4. Đăng ký P7 có GPS nhưng geo_consent=false. | P1: OK/INSIDE/UNIQUE/CONSISTENT → PASS. P2: SKEW → WARN (lệch > 24 giờ). P3: OUTSIDE → WARN. P4: LOW_ACCURACY → WARN. P5: MISSING/STRIPPED → WARN. P6: DUPLICATE_SAME_SITE → WARN. Không ảnh nào bị gán nhãn "xác thực/giả mạo" — chỉ là cờ rà soát. Đăng ký lại cùng client_operation_id trả ảnh cũ (không nhân đôi). P7: 422 GEO_CONSENT_REQUIRED hoặc lưu không có tọa độ theo gps_source=NONE. | Bảng site_photo, getSitePhotoChecks |
| UAT-AC360 | integration | P0 | Đề nghị kiểm tra → nghiệm thu chất lượng → sự kiện cho CTR | [EXE-FX] HD-A-001 ACTIVE; rule QMS.REGIME fixture REG-FIX-1 yêu cầu ký: CONTRACTOR, SUPERVISOR, OWNER; inspection INS-A-001 loại CONCEALED_WORK B02 đã SCHEDULED. | recordInspectionResult PASS; createQualityAcceptance; signQualityAcceptance bởi hai vai trò rồi đủ ba; decideQualityAcceptance. | 1. Ghi kết quả PASS với checklist đủ. 2. Tạo biên bản QA-W-001 và ký bởi CONTRACTOR, SUPERVISOR. 3. Gọi decision approve khi thiếu OWNER. 4. OWNER ký, rồi decision approve; đọc outbox. | required_roles lưu [CONTRACTOR, SUPERVISOR, OWNER] (ảnh chụp rule REG-FIX-1). Thiếu OWNER: 422 SIGNATURES_INCOMPLETE. Sau đủ ba chữ ký: APPROVED, outbox qms.quality_acceptance.approved.v1 chứa quality_acceptance_id, contract_id, boq_item_id, acceptance_scope; CTR nhận sự kiện (inbox ghi 1 bản, idempotent). Ký lặp bởi cùng vai trò cùng hash: 409 ALREADY_SIGNED. | Bảng quality_acceptance/qms_signature, outbox, inbox_record |
| UAT-AC361 | domain | P0 | NCR nghiêm trọng chặn nghiệm thu; đóng cần hành động khắc phục được xác nhận độc lập | [EXE-FX] INS-A-002 FAIL tạo NCR-100 mức CRITICAL (action_owner u.nt); QA-W-002 DRAFT cho cùng hạng mục. | decideQualityAcceptance approve khi NCR-100 mở; assignCorrectiveAction; submitCorrectiveEvidence thiếu bằng chứng và đủ; verify bởi người khắc phục và bởi u.gs; closeNonconformance. | 1. Duyệt QA-W-002. 2. Giao hành động khắc phục cho u.nt hạn 2026-07-15. 3. Nộp bằng chứng thiếu rồi đủ (ảnh geotag P1). 4. u.nt tự verify; u.gs verify VERIFIED. 5. Đóng NCR-100; duyệt lại QA-W-002. | Bước 1: 422 OPEN_CRITICAL_NCR (blocks_acceptance=true bắt buộc cho CRITICAL — CHECK ncr_critical_blocks_chk). Bước 3 thiếu bằng chứng: 422 EVIDENCE_REQUIRED. Bước 4: tự verify 403 SELF_APPROVAL_DENIED; u.gs: corrective_action VERIFIED. Bước 5: NCR CLOSED với verified_by=u.gs; QA-W-002 duyệt thành công. | Bảng quality_nonconformance/corrective_action, response |
| UAT-AC362 | integration | P1 | Thí nghiệm vật liệu không đạt tự tạo NCR | [EXE-FX] material_test MT-A-001 mẫu bê tông B02 sample_code BT-0601, tiêu chuẩn fixture "STD-BT-30", chưa có kết quả. | recordMaterialTestResult FAIL không báo cáo; có báo cáo; PASS cho mẫu khác; đăng ký trùng sample_code. | 1. Ghi FAIL thiếu report_document_version_id. 2. Ghi FAIL kèm báo cáo. 3. Đọc nonconformance_id của mẫu. 4. registerMaterialTest trùng BT-0601. | Bước 1: 422 VALIDATION_FAILED (CHECK material_test_result_chk). Bước 2: RESULT_RECORDED, result=FAIL, tự tạo 1 NCR (source_kind=MATERIAL_TEST, severity theo rule) và gán nonconformance_id. Mẫu PASS: không NCR. Đăng ký trùng: 409 SAMPLE_CODE_DUPLICATE. | Bảng material_test/quality_nonconformance |
| UAT-AC363 | domain | P1 | Chọn quy chế NĐ 06/2021 hay NĐ 207/2026 theo ngày hiệu lực và bảng xác nhận | [EXE-FX] Rule QMS.REGIME: REG-FIX-1 (ghi chú: gói NĐ 06/2021 hợp nhất) hiệu lực đến 2026-12-31; REG-FIX-2 (ghi chú: gói NĐ 207/2026) hiệu lực từ 2027-01-01 [CXN-07 chưa xác nhận → cờ cảnh báo]; REG-FIX-2 yêu cầu ký thêm DESIGNER. | requestInspection requested_for 2026-12-31 và 2027-01-01; createQualityAcceptance cho mỗi cái; đổi hiệu lực rule sau khi tạo. | 1. Tạo inspection ngày 2026-12-31; đọc regime_rule_version_id. 2. Tạo inspection ngày 2027-01-01. 3. Tạo QA cho cả hai; đọc required_roles. 4. Sửa effective_from của REG-FIX-2 sang 2027-02-01 (phiên bản mới); đọc lại inspection cũ. | Ngày 2026-12-31 → REG-FIX-1, required_roles [CONTRACTOR, SUPERVISOR, OWNER]; 2027-01-01 → REG-FIX-2, thêm DESIGNER. Cả hai đều hiển thị cảnh báo "[CXN-07] chưa xác nhận" và không cho đánh dấu slice DONE. Đổi hiệu lực bằng phiên bản mới không làm thay đổi regime_rule_version_id/required_roles của bản ghi cũ. | Bảng inspection/quality_acceptance, rule versions |
| UAT-AC364 | domain | P1 | Độ phủ nhật ký theo ngày làm việc | [EXE-FX] Tháng 2026-06 HD-A-001: 22 ngày làm việc theo lịch WORKDAY_VN; có nhật ký chính 18 ngày (15 ngày đã ký, 3 ngày mới DRAFT), trong đó 2 ngày còn bản phụ CONFLICT_PENDING; 4 ngày thiếu. | getDiaryCoverage from=2026-06-01 to=2026-06-30. | 1. Gọi getDiaryCoverage. 2. Đọc số liệu: tổng ngày làm việc, đã ký, DRAFT, xung đột, thiếu. 3. Ký bù nhật ký cho 1 ngày thiếu (ngày làm việc trong quá khứ) và đọc lại. | Tổng 22 ngày làm việc = 15 đã ký (CONTRACTOR_SIGNED trở lên) + 3 DRAFT + 4 thiếu; số ngày có bản xung đột = 2 (đếm riêng, không cộng vào tổng). Nhật ký bù hiển thị cờ "ký muộn" với số ngày muộn; thiếu giảm còn 3; ngày thiếu liệt kê ngày cụ thể. | Response getDiaryCoverage |
| UAT-AC365 | security | P1 | Nhà thầu khách chỉ tạo nhật ký cho hợp đồng của mình và không ký thay vai trò khác | [EXE-FX] u.nt (NT-A-01) có scope CONTRACT HD-A-001; HD-A-002 của nhà thầu khác. | saveSiteDiaryDraft cho HD-A-002; addSupervisorRemark bởi u.nt; confirmSiteDiaryByOwner bởi u.nt. | 1. u.nt tạo nhật ký HD-A-002. 2. u.nt gọi supervisor-remark trên nhật ký HD-A-001. 3. u.nt gọi owner-confirm. | HD-A-002: 404 RESOURCE_NOT_FOUND. supervisor-remark và owner-confirm: 403 SCOPE_DENIED (thiếu quyền diary.sign.supervisor/diary.sign.owner). Không có qms_signature nào được tạo. | Response, bảng qms_signature |
| UAT-AC366 | concurrency | P1 | Hai giám sát ghi ý kiến đồng thời: If-Match chặn ghi đè | [EXE-FX] D-A-0613 CONTRACTOR_SIGNED version 5; hai giám sát u.gs1 và u.gs2 cùng đọc version 5. | Hai addSupervisorRemark đồng thời If-Match "5". | 1. Gửi đồng thời hai request (barrier), 20 vòng. 2. Đọc site_diary.version và supervisor_remark. | Mỗi vòng: một 200 (version → 6) và một 409 VERSION_CONFLICT kèm current_version=6; supervisor_remark là của bên thắng, không bị trộn; qms_signature có đúng 1 dòng SUPERVISOR. | Kết quả 20 vòng |
| UAT-AC367 | security | P1 | Ứng dụng di động: không lưu vị trí khi chưa đồng ý và xóa dữ liệu khi đổi tenant | [EXE-FX] App Flutter đăng nhập TNT-A, có hàng đợi 2 ảnh chưa gửi; quyền vị trí bị từ chối. | Chụp ảnh với quyền vị trí tắt; thử đổi sang TNT-B khi còn hàng đợi; hủy hàng đợi rồi đổi. | 1. Chụp ảnh với quyền vị trí tắt; đồng bộ. 2. Đổi tenant khi còn 2 ảnh trong hàng đợi. 3. Chọn hủy hàng đợi và đổi tenant; kiểm SQLite cục bộ. | Ảnh gửi lên có gps_source=NONE, gps_lat/lng NULL, geo_consent=false. Đổi tenant khi còn hàng đợi: bị chặn với thông báo phải gửi xong hoặc hủy. Sau hủy và đổi: SQLite cục bộ và cache file của TNT-A bị xóa; không có lệnh nào gửi dưới tenant B. | Ảnh chụp app, nội dung SQLite, log đồng bộ |

## 11. Tiêu chí nghiệm thu

- **AC-QMS-01**: Given nhật ký thi công điện tử, When nhà thầu, giám sát, chủ đầu tư ký, Then mỗi chữ ký gắn băm nội dung, sửa sau ký bị chặn, điều chỉnh sau khóa là bản mới, và loại chữ ký (xác nhận nội bộ/chữ ký số) được ghi rõ [CXN-EXE-05]. Test: UAT-AC356, UAT-AC357.
- **AC-QMS-02**: Given hai thiết bị đồng bộ cùng nhật ký, When gửi, Then không nhân đôi (client_operation_id), xung đột được lưu và giải quyết có chủ đích, không ghi đè im lặng. Test: UAT-AC62, UAT-AC358.
- **AC-QMS-03**: Given ảnh hiện trường, When đăng ký, Then chạy kiểm EXIF/GPS/thời gian/trùng lặp thành cờ rà soát, vị trí chỉ lưu khi đồng ý, và app xóa dữ liệu khi đổi tenant. Test: UAT-AC359, UAT-AC367.
- **AC-QMS-04**: Given đề nghị kiểm tra, When ghi kết quả, lập và ký biên bản, Then biên bản APPROVED chỉ khi đủ chữ ký theo quy chế và phát sự kiện cho CTR đúng một lần. Test: UAT-AC360.
- **AC-QMS-05**: Given NCR nghiêm trọng, When còn mở, Then chặn nghiệm thu chất lượng; NCR đóng sau khi hành động khắc phục được xác nhận bởi người khác. Test: UAT-AC361.
- **AC-QMS-06**: Given thí nghiệm vật liệu không đạt, When ghi kết quả, Then tự tạo NCR và kết quả cần báo cáo đính kèm. Test: UAT-AC362.
- **AC-QMS-07**: Given quy chế NĐ 06/2021 hoặc NĐ 207/2026, When tạo kiểm tra theo ngày, Then chọn phiên bản rule đúng hiệu lực, lưu ảnh chụp vai trò phải ký và cảnh báo khi [CXN-07] chưa xác nhận. Test: UAT-AC363.
- **AC-QMS-08**: Given lịch làm việc, When xem độ phủ nhật ký, Then số ngày có/thiếu/ký/xung đột đúng và ký bù hiển thị số ngày muộn. Test: UAT-AC364.
- **AC-QMS-09**: Given nhà thầu khách và giám sát, When ký, Then chỉ ký đúng vai trò trong scope và If-Match chặn ghi đè đồng thời. Test: UAT-AC365, UAT-AC366.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1.** Nhật ký (lập, ký ba vai trò, khóa, điều chỉnh, xung đột đồng bộ), kiểm tra → biên bản → sự kiện cho CTR, NCR và khắc phục, ảnh có kiểm EXIF/GPS cơ bản (thời gian, vùng, trùng SHA-256). Màn hình QMS-01…QMS-05, QMS-07, QMS-08, QMS-09, QMS-10. **R2.** Thí nghiệm vật liệu (QMS-06), độ phủ (QMS-11), pHash, GIS dự án, chữ ký số qua adapter CA (sau spike R0, R8). **R3.** AI kiểm ảnh tiến độ.

| Hạng mục bắt buộc người duyệt | Giờ dự kiến | Người duyệt |
|---|---|---|
| Quy chế NĐ 06/2021 vs NĐ 207/2026, vai trò ký | 3 | Chủ nghiệp vụ xây dựng [CXN-07] |
| Giá trị chữ ký điện tử trong nhật ký | 2 | Pháp chế [CXN-EXE-05] |
| Ngưỡng kiểm ảnh, đồng ý vị trí | 2 | DPO + PO |

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| ID | Rủi ro / câu hỏi | Owner | Điều kiện giải quyết |
|---|---|---|---|
| R-QMS-01 | NĐ 207/2026 thay NĐ 06/2021: hiệu lực và nội dung nhật ký/nghiệm thu [CXN-07] | Chủ nghiệp vụ xây dựng | Văn bản gốc; publish rule QMS.REGIME |
| R-QMS-02 | Chữ ký trong app có đủ giá trị pháp lý cho nhật ký [CXN-EXE-05] | Pháp chế | Ý kiến pháp chế; nếu không đủ, R1 dùng chữ ký số qua DOC adapter |
| R-QMS-03 | Ngưỡng GPS/EXIF/pHash là [GIẢ ĐỊNH]; EXIF không là bằng chứng tuyệt đối | PO | Đo trên ảnh pilot; ghi rõ là cờ rà soát |
| R-QMS-04 | Vùng công trường (geofence) cần dữ liệu ranh giới dự án | PRJ | PRJ cung cấp tâm + bán kính hoặc polygon |


## Làn GOV-12: ảnh hiện trường giữa các dự án (G4-12)

Lớp rà soát thứ hai trên cờ của từng ảnh (QMS-08): cùng tệp (SHA-256) ở hai dự án, cùng nơi (trong 30 m) cùng lúc (trong 10 phút) ở hai dự án, hoặc cùng tệp ở hai ngày nhật ký của một dự án; ngưỡng đọc từ quy tắc `PHOTO_INTEGRITY_RULE` (chưa kiểm chứng). Mỗi cặp ghi một lần; người chụp một trong hai ảnh không tự giải trình; là tín hiệu để người giải trình, không kết luận ảnh giả. Màn hình QMS-12.
