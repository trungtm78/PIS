# MDM — Dữ liệu chủ, danh mục, thuật ngữ và kế thừa đơn vị

Phiên bản đặc tả M1 · 22/10/2026 · Nguồn dữ liệu máy: `work/staging/capital.json` (bảng `master_record`, `master_record_version`, `master_change_request`, `master_crosswalk`, `master_merge`, `survivorship_rule`, `glossary_term`, `master_import_batch`, `master_succession`, `integration_cursor`). Quy ước chung theo `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md`, `08_Quan_tri_du_lieu_va_truong_thanh.md`.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Mọi số liệu vốn, báo cáo và giám sát đều tham chiếu danh mục: địa bàn, cơ quan/chủ đầu tư, nguồn vốn (NSTW/NSĐP/CTMTQG/ODA), chương trình, lĩnh vực, nhóm/loại dự án, lịch kỳ, Kho bạc, tiêu chí thẩm định, nhóm rủi ro… Năm 2025 cơ cấu hành chính thay đổi lớn (sáp nhập tỉnh còn 34 đơn vị cấp tỉnh từ 01/7/2025, bỏ cấp huyện — chính quyền địa phương hai cấp, sắp xếp lại cấp xã, hợp nhất Bộ/Sở Kế hoạch và Đầu tư vào Tài chính, tổ chức lại Kho bạc theo khu vực) [CXN-34]. Báo cáo cũ phải giữ đúng tên/mã tại ngày nghiệp vụ, báo cáo mới phải theo cơ cấu mới, và có đường kế thừa giữa hai. MDM cung cấp bản ghi chủ có phiên bản hiệu lực theo thời gian, quy trình đề xuất–duyệt–công bố có impact preview, crosswalk mã liên hệ thống, hợp nhất/tách lại đảo được với survivorship theo thuộc tính, thuật ngữ nghiệp vụ có duyệt (nơi ký định nghĩa D03), nhập hàng loạt idempotent.

**Trong phạm vi:** MDM-01…MDM-37; namespace PLATFORM (baseline quốc gia do platform phát hành, có chữ ký phiên bản) và TENANT (mở rộng của tenant); `integration_cursor` cho connector dạng tệp.
**Ngoài phạm vi:** cây `organization_unit` và membership (IAM — MDM cung cấp danh mục cơ quan tham chiếu `AGENCY` và succession; IAM liên kết qua `agency_master_record_id`, xem §13); data catalog/lineage/quality (DGV); quy tắc pháp lý cụ thể của từng phân hệ (lưu như master_type dạng rule nhưng do owner phân hệ phê duyệt).
**Phụ thuộc:** IAM. **Được dùng bởi:** PRJ, CAP, DIS, MNE, PAY, CTR, ISS, BID, NOT, DGV.

**Căn cứ.** Luật Dữ liệu 60/2024 + NĐ 165/2025 [CXN-13]; Luật Tổ chức chính quyền địa phương 2025, nghị quyết sắp xếp đơn vị hành chính cấp tỉnh/xã năm 2025 [CXN-34]; FRD UC13 (AC45–AC49). Thị trường: Reltio/Informatica (crosswalk, survivorship theo thuộc tính, merge/unmerge đảo được), Collibra/Atlan (glossary có workflow duyệt), CMMI DMM/DCAM.

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Data steward (maker) | Loại danh mục được giao trong tenant | `proposeMasterRecord`, `createMasterChangeRequest`, `submitMasterChangeRequest`, `createMasterCrosswalk`, `retireMasterCrosswalk`, `stageMasterImport`, `applyMasterImport`, `recordMasterSuccession`, đề xuất survivorship/glossary | Tự duyệt; sửa namespace PLATFORM |
| Người duyệt danh mục (checker) | Loại danh mục được giao | `decideMasterChangeRequest`, `post_master_records_id_publish`, `post_master_records_id_merge`, `unmergeMasterRecords`, `publishSurvivorshipRule` | Duyệt đề nghị của chính mình (CHECK `master_cr_sod_chk`) |
| Owner domain thuật ngữ (vd Chủ nghiệp vụ vốn cho DISBURSEMENT) | Domain | `decideGlossaryTerm`, `publishGlossaryTerm` | Duyệt thuật ngữ domain khác |
| Tenant admin | Tenant | Gán steward/checker, cấu hình policy override | Ghi đè khóa chuẩn PLATFORM (`POLICY_LOCKED`) |
| Platform operator (control-plane) | PLATFORM namespace | Phát hành baseline quốc gia có chữ ký | Đọc dữ liệu nghiệp vụ tenant |
| Vận hành tích hợp | Tenant | `resetIntegrationCursor` (có lý do) | Sửa `cursor_json` không audit |
| Mọi user | Đọc | `searchMasterRecords`, as-of, successors, usages (trong quyền) | – |

## 3. Luồng nghiệp vụ

**F1 — Tạo/sửa bản ghi (MDM-25/26/27/32).** (1) Steward `proposeMasterRecord` (CREATE) hoặc `createMasterChangeRequest` (UPDATE/RETIRE/RESTRUCTURE/SUCCESSION) với `proposed_json`, lý do, căn cứ, `effective_from`. Kiểm sớm: khóa trùng trong (tenant, namespace, master_type) → 409 `DUPLICATE_KEY`; PLATFORM bị khóa → 403 `POLICY_LOCKED`. (2) `submitMasterChangeRequest`: server tính `impact_json` (đếm tham chiếu theo bảng: report_revision, allocation_line, project, dashboards/metric, crosswalk, workflow) — không có impact → không submit được (`IMPACT_NOT_COMPUTED`); audit `master.change_submitted`. (3) Checker `decideMasterChangeRequest`. (4) `post_master_records_id_publish`: trong transaction tạo `master_record_version` mới (revision+1) với `[valid_from, valid_until)`, đóng version trước tại `effective_from`, cập nhật `master_record.current_version_id` nếu đã hiệu lực, set `published_at`, outbox `master.published.v1`. EXCLUDE constraint chặn chồng khoảng (409 `EFFECTIVE_RANGE_OVERLAP`). Đổi tên giữ identity (cùng `master_record_id`).

**F2 — Ngừng dùng (MDM-31).** RETIRE với `successor_record_id` khi policy loại danh mục yêu cầu; có tham chiếu đang hoạt động mà không successor → 409 `MASTER_IN_USE`. Không xóa vật lý; version đóng `valid_until`; dữ liệu lịch sử giữ FK tới version cũ.

**F3 — Kế thừa đơn vị 2025 (MDM-37, MDM-02/03).** `recordMasterSuccession` (qua change request SUCCESSION được duyệt) ghi: MERGE (nhiều → một), SPLIT (một → nhiều, `share_pct` cho phân bổ số liệu lịch sử nếu cần), RENAME, RELEVEL (xã chuyển trực thuộc tỉnh khi bỏ cấp huyện), ABOLISH_LEVEL (huyện hết hiệu lực 30/6/2025). Seed baseline PLATFORM: danh mục tỉnh trước/sau 01/7/2025, danh mục xã mới, quan hệ kế thừa — phát hành bởi platform sau khi [CXN-34] xác nhận; tenant chỉ bổ sung cơ quan nội bộ (Ban QLDA khu vực…). Truy vấn `getMasterRecordAsOf?date` và `getMasterRecordSuccessors?date` cho phép báo cáo chọn "theo cơ cấu tại ngày chốt" (mặc định) hoặc "quy đổi về cơ cấu hiện hành" (gắn nhãn).

**F4 — Crosswalk (MDM-24, MDM-16).** `createMasterCrosswalk` ánh xạ mã ngoài (Kho bạc, Hệ thống TTQG về ĐTC, muasamcong, mã ngân sách) ↔ bản ghi chủ; mỗi `(source_system, external_type, external_code)` chỉ một ánh xạ ACTIVE (409 `CROSSWALK_DUPLICATE`). Import tệp từ hệ thống ngoài dịch mã qua crosswalk; mã không ánh xạ → dòng lỗi `CROSSWALK_MISSING` (không tự tạo master).

**F5 — Hợp nhất/tách lại (MDM-30, MDM-35, MDM-36).** Phát hiện trùng chỉ gợi ý (DGV-10 hoặc rule khớp mã định danh như MST — không khớp chỉ theo tên). Checker `post_master_records_id_merge {merged_record_id}`: (1) khóa cả hai `master_record` theo thứ tự id; (2) áp `survivorship_rule` PUBLISHED theo từng thuộc tính → `survivorship_json` (thuộc tính → nguồn được chọn + giá trị); thuộc tính STEWARD_DECISION hoặc thiếu rule cần `survivorship_overrides`, nếu không → 409 `MERGE_CONFLICT`; (3) tạo version mới cho survivor; merged → status MERGED, `merged_into_id`; (4) ghi `alias_json` (mã/tên cũ) và `repointed_refs_json` (danh sách tham chiếu được trỏ lại — tham chiếu lịch sử **không** bị sửa mà đọc qua alias; chỉ tham chiếu "đang hoạt động" như dự án mở, crosswalk ACTIVE được trỏ lại); (5) `master_merge` APPLIED, outbox `master.merged.v1`. `unmergeMasterRecords`: nếu survivor có version mới sau merge thay đổi thuộc tính đến từ merged → 409 `UNMERGE_CONFLICT` kèm danh sách, cần `steward_decisions`; ngược lại khôi phục merged về EFFECTIVE (version mới từ giá trị trước merge), trả lại tham chiếu theo `repointed_refs_json`, `master_merge` REVERTED.

**F6 — Thuật ngữ (MDM-34).** `proposeGlossaryTerm` → submit → `decideGlossaryTerm` bởi owner domain (≠ người đề xuất) → `publishGlossaryTerm` (bản PUBLISHED cũ → DEPRECATED). Thuật ngữ domain DISBURSEMENT (giải ngân, lũy kế YTD, delta kỳ, PTD, hai mẫu số) là nơi **ký D03**: DIS-25 hiển thị trạng thái; snapshot DIS đổi `definition_status = SIGNED` khi mọi term bắt buộc PUBLISHED.

**F7 — Nhập hàng loạt (MDM-29).** `stageMasterImport` (sha256, mapping, mode ATOMIC|PARTIAL) → kiểm schema, trùng trong tệp và với dữ liệu hiện có, FK cha, khoảng hiệu lực → errors_json theo dòng; `applyMasterImport` tạo change request theo batch (cần duyệt như F1) rồi publish atomic (ATOMIC cần 0 lỗi; PARTIAL bỏ dòng lỗi có danh sách rõ). Cùng tệp APPLIED → 409 `IMPORT_FILE_ALREADY_APPLIED`; retry cùng key → cùng kết quả.

**F8 — Phạm vi platform/tenant (MDM-33).** Mỗi master_type có policy: `PLATFORM_ONLY` (nguồn vốn chuẩn, đơn vị hành chính), `PLATFORM_WITH_TENANT_EXTENSION` (lĩnh vực: tenant thêm mã con), `TENANT_ONLY` (cơ quan nội bộ, nhóm vướng mắc). Tenant override chỉ trường được phép (nhãn hiển thị, thứ tự) qua alias/crosswalk TENANT, không đổi mã chuẩn.

**F9 — Con trỏ tích hợp.** `integration_cursor` theo (connector, scope) lưu vị trí đã xử lý tệp (vd `NATIONAL_PIM_FILE`, `TREASURY_STATEMENT_FILE`) + `adapter_status` (VERIFIED/PROPOSED/MOCK/MISSING); `resetIntegrationCursor` cần quyền riêng + lý do; MDM-24 hiển thị badge adapter.

## 4. State machine

```
master_change_request: DRAFT ─submit(impact)─► IN_REVIEW ─approve─► APPROVED ─publish─► APPLIED
                                   │  └─reject─► REJECTED ; return ─► DRAFT ; DRAFT ─cancel─► CANCELLED
master_record:  DRAFT ─► IN_REVIEW ─► APPROVED ─(valid_from tới)─► EFFECTIVE ─retire─► RETIRED ; EFFECTIVE ─merge─► MERGED ─unmerge─► EFFECTIVE
master_record_version: DRAFT ─► IN_REVIEW ─► APPROVED ─(valid_from)─► EFFECTIVE ─(valid_until)─► RETIRED
master_merge: APPLIED ─unmerge─► REVERTED
glossary_term: DRAFT ─submit─► IN_REVIEW ─approve─► APPROVED ─publish─► PUBLISHED ─(bản mới publish)─► DEPRECATED ; IN_REVIEW ─reject─► REJECTED
master_import_batch: STAGED ─validate─► VALIDATED ─apply(tạo CR)─► IN_REVIEW ─publish─► APPLIED ; lỗi ─► FAILED ; ─cancel─► CANCELLED
```

| Đối tượng | Từ | Command | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|---|
| change_request | DRAFT | `submitMasterChangeRequest` | IN_REVIEW | steward | impact_json tính xong | `master.change_submitted.v1` |
| change_request | IN_REVIEW | `decideMasterChangeRequest` | APPROVED/REJECTED/DRAFT | checker ≠ requester | lý do | – |
| change_request | APPROVED | `post_master_records_id_publish` | APPLIED | checker | không chồng khoảng; policy namespace | `master.published.v1` |
| master_record | EFFECTIVE | `post_master_records_id_merge` | MERGED (merged) | checker | survivorship đủ; không merge vòng | `master.merged.v1` |
| master_merge | APPLIED | `unmergeMasterRecords` | REVERTED | checker | không xung đột hoặc có steward_decisions | `master.unmerged.v1` |
| glossary_term | APPROVED | `publishGlossaryTerm` | PUBLISHED | owner domain | – | `glossary.published.v1` |

Bị cấm: xóa vật lý bản ghi đã tham chiếu; publish change request chưa APPROVED (`CHANGE_NOT_APPROVED`); tái sử dụng mã đã phát hành cho nghĩa khác; tenant sửa PLATFORM; unmerge hai lần (`MERGE_ALREADY_REVERTED`); succession tạo vòng (`SUCCESSION_CYCLE`).

## 5. Quy tắc nghiệp vụ và công thức

- **BR-MDM-01** Identity = (tenant, namespace, master_type, business_key); mã đã phát hành không tái sử dụng. Mã giống ở hai tenant là độc lập (RLS).
- **BR-MDM-02** Khoảng hiệu lực nửa mở `[valid_from, valid_until)`; các version APPROVED/EFFECTIVE/RETIRED của một bản ghi không chồng lấn (EXCLUDE gist). `recorded_at` (ngày ghi nhận) tách khỏi `valid_from` (ngày nghiệp vụ).
- **BR-MDM-03** Tham chiếu từ dữ liệu nghiệp vụ luôn trỏ `master_record_version_id` hiệu lực tại ngày nghiệp vụ (ví dụ `project.area_master_version_id`, `funding_snapshot_line.fund_source_version_id`), nên đổi tên/retire không đổi báo cáo đã gửi.
- **BR-MDM-04** Impact preview bắt buộc trước submit; publish ghi audit trước/sau.
- **BR-MDM-05** Survivorship theo thuộc tính: SOURCE_PRIORITY (thứ tự nguồn, vd NATIONAL > TREASURY > TENANT), MOST_RECENT (theo `recorded_at`), MOST_COMPLETE (ít null nhất, hòa → SOURCE_PRIORITY), STEWARD_DECISION. Rule có phiên bản và hiệu lực.
- **BR-MDM-06** Nguồn vốn: cây FUND_SOURCE có thuộc tính `relation ∈ {ADDITIVE, SUBSET_OF}`; CTMTQG (PROGRAM/CTMTQG) luôn `SUBSET_OF` nguồn cha NSTW/NSĐP; đặt ADDITIVE → 422 `SUBSET_SOURCE_NOT_ADDITIVE`. ODA là nguồn ADDITIVE riêng với thuộc tính `onlending`.
- **BR-MDM-07** Succession SPLIT: Σ `share_pct` của các successor của một predecessor tại cùng ngày = 100 (kiểm ở command); MERGE share null.
- **BR-MDM-08** Lịch kỳ (CALENDAR): định nghĩa tuần (ngày bắt đầu), giờ hạn, múi giờ Asia/Ho_Chi_Minh, `calendar_version`; DIS sinh kỳ từ phiên bản hiệu lực.
- **BR-MDM-09** Rule dạng dữ liệu (`PROJECT_GROUP_THRESHOLDS`, `NATIONAL_CODE_REQUIRED`, `APPRAISAL_CRITERIA`, …) bắt buộc có `legal_basis`, `effective_from/until` và người duyệt là owner phân hệ dùng rule.
- **BR-MDM-10** Import ATOMIC: hoặc toàn bộ, hoặc không; PARTIAL phải hiển thị dòng bị bỏ và lý do; retry cùng Idempotency-Key không nhân đôi.

## 6. Dữ liệu

| Bảng | Mới/sửa | Trường/ràng buộc chính | Classification | Retention |
|---|---|---|---|---|
| `master_record` | mới | namespace, master_type, business_key, status, steward, `current_version_id`, `merged_into_id`; UNIQUE identity; MERGED ⇔ merged_into_id | INTERNAL (PUBLIC cho baseline quốc gia) | Vĩnh viễn |
| `master_record_version` | sửa | + `master_record_id`, `namespace`, `source_system`, `supersedes_id`, `change_request_id`, `legal_basis`, `content_sha256`, `published_at`, `recorded_at`, audit; `parent_id` → `master_record`; CHECK status/khoảng; EXCLUDE không chồng; UNIQUE revision | theo master_type | Vĩnh viễn |
| `master_change_request` | mới | before/proposed/impact json, lý do, bằng chứng, batch; SoD; impact bắt buộc sau DRAFT | INTERNAL | 10 năm |
| `master_crosswalk` | mới | source_system, external_type/code, hiệu lực, match_method, confidence; unique ACTIVE | INTERNAL | Vĩnh viễn |
| `master_merge` | mới | survivor/merged, survivorship_json, alias_json, repointed_refs_json, revert info; unique một APPLIED/merged | INTERNAL | Vĩnh viễn |
| `survivorship_rule` | mới | master_type × attribute × revision; SOURCE_PRIORITY ⇒ danh sách nguồn | INTERNAL | Vĩnh viễn |
| `glossary_term` | mới | term_code × revision; một PUBLISHED; SoD; formula_ref | INTERNAL | Vĩnh viễn |
| `master_import_batch` | mới | sha256, mapping, mode, lỗi; unique APPLIED; ATOMIC ⇒ 0 lỗi | INTERNAL | 5 năm |
| `master_succession` | mới | predecessor/successor, kind, ngày, share, căn cứ; unique bộ ba | PUBLIC/INTERNAL | Vĩnh viễn |
| `integration_cursor` | sửa | + `adapter_status`, `status`, `last_file_sha256`, `last_error_code`, `reset_reason`, `updated_*`, `version`; UNIQUE (connector, scope) | INTERNAL | Theo connector |

Index cho mọi `*_id`; RLS + `tenant_guard`. Namespace PLATFORM được nhân bản vào từng tenant khi platform phát hành baseline (bản sao chỉ đọc có chữ ký `content_sha256`), giữ RLS đơn giản và cách ly. Migration: tạo `master_record` từ (master_type, code) hiện có, gán `master_record_id`, set NOT NULL.

## 7. API / command

| operationId | Method path | x-permission | DTO | Lỗi | Idem | If-Match |
|---|---|---|---|---|---|---|
| `proposeMasterRecord` | POST /master-records | master.propose | `MdmRecordProposal` | 409 DUPLICATE_KEY; 403 POLICY_LOCKED | ✔ | – |
| `createMasterChangeRequest` | POST /master-change-requests | master.propose | `MdmChangeRequest` | 403 POLICY_LOCKED; 409 MASTER_IN_USE/EFFECTIVE_RANGE_OVERLAP | ✔ | – |
| `submitMasterChangeRequest` | POST /master-change-requests/{id}/submit | master.propose | – | 422 IMPACT_NOT_COMPUTED | ✔ | ✔ |
| `decideMasterChangeRequest` | POST /master-change-requests/{id}/decision | master.review | `MdmDecision` | 403 SELF_APPROVAL_DENIED | ✔ | ✔ |
| `post_master_records_id_publish` | POST /master-records/{id}/publish | master.publish | `CapApplyDecision` (văn bản căn cứ) | 409 EFFECTIVE_RANGE_OVERLAP/CHANGE_NOT_APPROVED | ✔ | ✔ |
| `post_master_records_id_merge` | POST /master-records/{id}/merge | master.merge | `MdmMergeRequest` | 409 MERGE_CONFLICT; 403 POLICY_LOCKED | ✔ | ✔ |
| `unmergeMasterRecords` | POST /master-merges/{id}/unmerge | master.merge | `MdmUnmerge` | 409 UNMERGE_CONFLICT/MERGE_ALREADY_REVERTED | ✔ | ✔ |
| `createMasterCrosswalk` / `retireMasterCrosswalk` | POST /master-crosswalks; /{id}/retire | master.crosswalk.manage | `MdmCrosswalk` | 409 CROSSWALK_DUPLICATE | ✔ | ✔ (retire) |
| `createSurvivorshipRuleVersion` / `publishSurvivorshipRule` | POST /survivorship-rules; /{id}/publish | master.survivorship.manage/approve | `MdmSurvivorshipRule` | 403 SELF_APPROVAL_DENIED | ✔ | ✔ (publish) |
| `proposeGlossaryTerm`, `submitGlossaryTerm`, `decideGlossaryTerm`, `publishGlossaryTerm` | POST /glossary-terms[/{id}/submit\|decision\|publish] | glossary.propose/approve | `MdmGlossaryTerm`, `MdmDecision` | 409 GLOSSARY_TERM_DUPLICATE; 403 SELF_APPROVAL_DENIED/SCOPE_DENIED | ✔ | ✔ |
| `stageMasterImport` / `applyMasterImport` | POST /master-imports[/{id}/apply] | master.import | `MdmImportRequest` | 409 IMPORT_FILE_ALREADY_APPLIED; 422 IMPORT_HAS_ERRORS | ✔ | ✔ (apply) |
| `recordMasterSuccession` | POST /master-successions | master.propose | `MdmSuccession` | 422 SUCCESSION_CYCLE | ✔ | – |
| `resetIntegrationCursor` | POST /integration-cursors/{id}/reset | integration.cursor.reset | `MdmCursorReset` | 422 VALIDATION_FAILED | ✔ | ✔ |
| `searchMasterRecords`, `listMasterChangeRequests`, `listMasterTypePolicies`, `getMasterRecordUsages`, `getMasterRecordAsOf`, `getMasterRecordSuccessors`, `getMasterChangeRequest`, `listGlossaryTerms` | GET | master.read / glossary.read | – | 404 | – | – |

(Cập nhật — CR-MDM-03) Thêm `GET /master-type-policies` (`listMasterTypePolicies`, master.read): chính sách phạm vi từng loại danh mục và số bản ghi mỗi namespace cho MDM-33. Bảng `master_type_policy` (V1081) chỉ control-plane ghi; loại không có dòng theo baseline của platform trong mã.

(Cập nhật — CR-MDM-02) Thêm `GET /master-change-requests?status&master_type` (`listMasterChangeRequests`, master.read): hàng chờ duyệt và công bố của MDM-32.

(Cập nhật — CR-MDM-01) `GET /resources/master_record_version` nhận thêm tham số tùy chọn `master_record_id` để màn lịch sử (MDM-28) đọc các version của một bản ghi.

(Cập nhật — CR-MDM-04, CR-MDM-05) Nhập hàng loạt (MDM-29) thêm: `POST /master-imports/files` (`uploadMasterImportFile`, master.import: tải CSV hoặc XLSX qua đường tải chung, kiểm loại theo byte, quét mã độc, đọc tiêu đề cột và số dòng), `GET /master-imports` và `GET /master-imports/{id}` (`listMasterImports`, `getMasterImport`, master.read), `POST /master-imports/{id}/decision` (`decideMasterImport`, master.review) và `POST /master-imports/{id}/publish` (`publishMasterImport`, master.publish). `applyMasterImport` tạo mọi bản ghi và change request của lô trong một giao dịch rồi gửi duyệt; cả lô được duyệt và công bố cùng lúc (nguyên tử), người áp dụng không duyệt và không công bố lô của mình; sự kiện `master.import_submitted.v1` ở bước áp dụng và `master.import_applied.v1` khi lô được công bố.

**GET scaffold:** `/resources/master_record_version[/{id}]` → `dto` (version hiệu lực theo policy namespace; attributes lọc theo classification); `/resources/integration_cursor[/{id}]` → `internal` (vận hành nội bộ). Không endpoint ghi chung; mọi thay đổi qua change request.

## 8. UI/UX

Giữ MDM-01…MDM-33 (MasterTree, DataTable, ComparePanel, form có impact preview). Field thêm: MDM-02 + "Loại kế thừa", "Căn cứ cải cách 2025" (FR-MDM-37); MDM-03 + "Đơn vị kế thừa", "Hiệu lực đến" (FR-MDM-37); MDM-30 + "Quy tắc survivorship", "Có thể tách lại" (FR-MDM-35/36).
Mới: **MDM-34** thuật ngữ (danh sách + approval panel; badge "Định nghĩa D03" cho domain DISBURSEMENT); **MDM-35** bản ghi chủ & crosswalk (ComparePanel hai bản ghi, cột thuộc tính → nguồn được chọn, danh sách alias/mã ngoài, nút "Tách lại" với preview tham chiếu khôi phục); **MDM-36** survivorship (policy table theo thuộc tính, kéo thứ tự nguồn bằng bàn phím được); **MDM-37** cây kế thừa (MasterTree hai cột "trước 01/7/2025" ↔ "sau", đường nối có nhãn MERGE/SPLIT/RELEVEL, bộ chọn ngày "Xem cơ cấu tại").
Mọi form thay đổi bắt buộc bước "Tác động" (số hồ sơ/dashboards/tích hợp bị ảnh hưởng) trước nút Gửi duyệt. Trạng thái riêng: "Khóa chính sách (platform)", "Đang chờ duyệt", "Đã hợp nhất vào …", "Adapter: PROPOSED/MOCK".

## 9. Sự kiện, job, tích hợp, quan sát

Events: `master.change_submitted.v1`, `master.published.v1 {master_type, master_record_id, version_id, valid_from}`, `master.merged.v1`, `master.unmerged.v1`, `master.import_applied.v1`, `glossary.published.v1 {term_code, revision, domain}`. Consumers ngoài MDM: DIS (glossary DISBURSEMENT → `definition_status`), BI/DGV (cập nhật dimension SCD2), PRJ/CAP (cảnh báo master hết hiệu lực trên nháp).
Jobs: `mdm.effective-activation` (00:05 giờ VN: version APPROVED tới `valid_from` → EFFECTIVE, cập nhật `current_version_id`), `mdm.platform-baseline-sync` (nhận gói baseline có chữ ký từ control-plane, xác minh `content_sha256`, áp dụng như change request hệ thống có audit). Cache: `t:{tenant}:mdm:{type}:{key}:{date}` TTL 1 h, vô hiệu khi `master.published`. Telemetry: `mdm_change_pending_gauge`, `mdm_merge_total`, `mdm_unmerge_conflict_total`, `mdm_import_error_rows_total`.

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Setup | Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC45 | security | P1 | key NSDP-XS ở TNT-A | tạo trùng ở TNT-A, TNT-B | 409; TNT-B OK, không lộ | API |
| UAT-AC46 | domain | P1 | r1/r2 GT | version chồng khoảng | 409 EFFECTIVE_RANGE_OVERLAP | DB |
| UAT-AC47 | business | P1 | Ban QLDA Huyện X | retire + successor | báo cáo cũ giữ tên | PDF |
| UAT-AC48 | integration | P1 | tệp 10 dòng lỗi 1 | apply/sửa/retry | không đổi; 10 mới; không trùng | DB |
| UAT-AC49 | business | P1 | NSTW-DTPT dùng 12+3 | đổi label | impact trước publish; báo cáo cũ giữ r1 | audit |
| UAT-AC273 | domain | P1 | crosswalk "1234" | tạo trùng | 409 CROSSWALK_DUPLICATE | API |
| UAT-AC274 | business | P1 | A/A2 trùng MST | merge rồi unmerge | survivorship đúng; khôi phục 4 tham chiếu | DB |
| UAT-AC275 | domain | P1 | survivor sửa sau merge | unmerge | 409 UNMERGE_CONFLICT | API |
| UAT-AC276 | security | P0 | thuật ngữ YTD | tự duyệt; publish r2 | 403; r1 DEPRECATED | audit |
| UAT-AC277 | business | P0 | FX-MDM-001 | as-of trước/sau 01/7/2025 | tên đúng thời điểm | API |
| UAT-AC278 | business | P1 | tỉnh P+Q→P | báo cáo năm 2025 | tách trước, gộp sau | UI |
| UAT-AC279 | security | P1 | NSTW PLATFORM | tenant sửa | 403 POLICY_LOCKED | API |
| UAT-AC280 | domain | P1 | GT-CU dùng 5 | retire không/có successor | 409 / RETIRED | API |
| UAT-AC281 | security | P1 | cursor | reset thiếu quyền/lý do | 403/422/200 | audit |
| UAT-AC282 | domain | P1 | CTMTQG | đặt ADDITIVE | 422 | API |
| UAT-AC283 | integration | P1 | CALENDAR r2 | sinh kỳ 2027 | không chồng, hạn UTC đúng | DB |
| UAT-AC284 | domain | P1 | rule nhóm r1/r2 | dự án trước/sau | nhóm theo rule hiệu lực | API |
| UI-MDM-34…UI-MDM-37 | screen-contract | theo phase | synthetic | 7 trạng thái | đúng field/rule | screenshot |

Fixture **FX-MDM-001**: tỉnh TINH-P, huyện HUYEN-X (DISTRICT, tới 2025-06-30), xã XA-A, XA-B → XA-Y (MERGE, 2025-07-01), HUYEN-X ABOLISH_LEVEL; dự án P-A-001 địa bàn XA-A r1.

## 11. Tiêu chí nghiệm thu

- **AC-MDM-01** Given khóa đã tồn tại trong tenant/namespace, Then 409 `DUPLICATE_KEY`; khóa trùng ở tenant khác không lộ dữ liệu. → UAT-AC45
- **AC-MDM-02** Given hai version cùng bản ghi, Then khoảng hiệu lực không chồng lấn (DB chặn). → UAT-AC46
- **AC-MDM-03** Given retire/đổi tên/kế thừa, Then báo cáo đã gửi giữ tên/mã tại ngày nghiệp vụ; báo cáo mới theo cơ cấu mới có nhãn. → UAT-AC47, UAT-AC277, UAT-AC278
- **AC-MDM-04** Given import lỗi, Then dữ liệu hiệu lực không đổi; retry không nhân đôi. → UAT-AC48
- **AC-MDM-05** Given thay đổi, Then impact preview + audit trước publish; dữ liệu cũ truy được version gốc. → UAT-AC49
- **AC-MDM-06** Given merge theo survivorship, Then thuộc tính chọn đúng nguồn; unmerge khôi phục tham chiếu hoặc báo xung đột rõ. → UAT-AC274, UAT-AC275
- **AC-MDM-07** Given thuật ngữ, Then người đề xuất không tự duyệt; chỉ một bản PUBLISHED mỗi mã. → UAT-AC276
- **AC-MDM-08** Given baseline PLATFORM, Then tenant không ghi đè (403), chỉ alias. → UAT-AC279
- **AC-MDM-09** Crosswalk ACTIVE duy nhất theo mã ngoài; CTMTQG luôn là tập con. → UAT-AC273, UAT-AC282

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1:** F1, F2, F3 (baseline 2025 cho tỉnh/xã của tenant pilot + cơ quan nội bộ), F4 (Kho bạc, mã TTQG), F6 (domain DISBURSEMENT để ký D03), F7 ATOMIC, F8, F9; MDM-01..29, 31..34, 37.
**R2:** merge/unmerge + survivorship đầy đủ (MDM-30, 35, 36), PARTIAL import, gợi ý trùng từ DGV-10, baseline platform đầy đủ toàn quốc, SCD2 cho BI.
**Giờ review người:** baseline cải cách 2025 với Pháp chế/Data Owner 4 h [CXN-34]; quyền/SoD/namespace 2 h; migration master_record 3 h; phiên ký glossary D03 (tính trong DIS). Tổng ≈ 9 h.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| [CXN-34] (đề xuất thêm vào sổ) Văn bản cải cách 2025: sáp nhập tỉnh, bỏ cấp huyện, sắp xếp xã, hợp nhất KH&ĐT vào Tài chính, tổ chức lại Kho bạc khu vực — danh mục mã chính thức | Pháp chế / Data Owner | Danh mục mã đơn vị hành chính chính thức + nghị quyết gốc → baseline PLATFORM |
| IAM: `organization_unit` cần `agency_master_record_id` để nối danh mục cơ quan và kế thừa | IAM owner | Thêm cột + FK + index (cross-module) |
| DGV-02 glossary trùng chức năng `glossary_term` | DGV owner | DGV-02 đọc/ghi qua API MDM (`glossary_term` là nguồn duy nhất) |
| D04: mapping mã lịch sử, retention, legal hold | Data Owner | Mapping được đối soát |
| Platform baseline distribution (control-plane → tenant) | SAS/Platform owner | Cơ chế gói có chữ ký + job sync |
