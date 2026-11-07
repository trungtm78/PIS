# DGV — Quản trị dữ liệu, chất lượng, lineage và trưởng thành

Phiên bản đặc tả M1 · 22/10/2026 · Nguồn dữ liệu máy: `work/staging/intelligence.json` (bảng sửa `dataset_contract`, `data_contract_version`, `quality_rule_version`, `quality_run`, `quality_exception`, `quality_incident`, `maturity_assessment`, `maturity_evidence`; bảng mới `dataset`, `contract_consumer_approval`, `quality_rule_result`, `quality_incident_event`, `lineage_node`, `lineage_edge`, `dataset_glossary_binding`, `dataset_source_mapping`, `reconciliation_run`, `maturity_rubric_version`, `maturity_milestone`, `data_product`). Quy ước chung theo `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md`, `08_Quan_tri_du_lieu_va_truong_thanh.md`. Baseline giữ nguyên: DGV-01…DGV-18, FRD UC14 (AC50–AC55), lệnh `post_quality_exceptions_id_decision`, `post_maturity_assessments_id_publish`, test DQ01.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Số liệu vốn, giải ngân, thanh toán chỉ dùng được để điều hành khi có chủ sở hữu, hợp đồng dữ liệu, kiểm tra chất lượng có kết quả, đường truy nguồn và bằng chứng. Tài liệu 08 đặt nguyên tắc; DGV biến chúng thành dữ liệu và lệnh có kiểm soát: catalog → hợp đồng ODCS → quy tắc → lần chạy → kết quả → ngoại lệ/sự cố có assignee → lineage → đối soát → trưởng thành có bằng chứng. DGV **không sửa dữ liệu nghiệp vụ**; việc sửa đi qua command của module sở hữu.

**Trong phạm vi:** catalog dataset (domain, grain, owner/steward, phân loại 5 mức, SLA độ mới); hợp đồng dữ liệu theo Open Data Contract Standard (ODCS) — bản làm việc `dataset_contract`, bản phát hành bất biến `data_contract_version`, chấp thuận consumer cho breaking change; quy tắc chất lượng có phiên bản (7 chiều), lần chạy trên snapshot, kết quả theo quy tắc, quarantine, ngoại lệ resolve/waive có hạn, sự cố có assignee và SLA; lineage nguồn → lô nhập → bản ghi → dataset version → metric version → dashboard/xuất; gắn thuật ngữ **MDM `glossary_term` (nguồn duy nhất)**; mapping nguồn D04; đối soát số kiểm soát; rubric trưởng thành (tham chiếu CMMI DMM/EDM DCAM) có bằng chứng, coverage, lộ trình; chứng nhận data product.

**Ngoài phạm vi:** thuật ngữ và workflow duyệt thuật ngữ (MDM-34, `proposeGlossaryTerm`…`publishGlossaryTerm` — DGV-02 là màn hình dùng chung hiển thị và gắn); merge/unmerge master (MDM); retention/legal hold (ADM `data_retention_policy`, `legal_hold`; DOC `doc_retention_rule`); tính số liệu (DIS/PAY/CAP); semantic metrics (BI).

**Phụ thuộc:** MDM (glossary_term, master), BI (dataset version, chỉ tiêu, nhận `dgv.quality_run.completed.v1`), DIS/PAY/CAP/MDM (sự kiện snapshot, lô nhập), ADM (retention, quyền, phê duyệt), NOT. Đồ thị: `DGV → MDM`; DGV ⇠ mọi module (metadata, DQ).

**Căn cứ.** Luật Dữ liệu 60/2024/QH15 + NĐ 165/2025 (phân loại dữ liệu, dữ liệu quan trọng/cốt lõi) [CXN-13]; Luật BVDLCN 91/2025; tài liệu 08 (mục tiêu chất lượng tài chính trọng yếu: completeness 100%, FK/key 100%, duplicate 0, sai tổng ngoài dung sai 0). Chuẩn/thị trường: Open Data Contract Standard (Bitol, Linux Foundation) — ghim phiên bản ODCS v3.0.x [GIẢ ĐỊNH, xác nhận ở spike R2]; CMMI Data Management Maturity (DMM) và EDM Council DCAM (tham chiếu, **không** tuyên bố chứng nhận); OpenMetadata/Atlan/Collibra (catalog, lineage, glossary có workflow); Great Expectations/Soda (quy tắc chất lượng dạng khai báo).

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Được phép | Bị cấm |
|---|---|---|---|
| Data owner (`data_owner`) | Domain được giao | `publishDatasetContract`, `approveQualityRuleVersion`, `decideSourceMapping`, `verifyQualityIncident`, `certifyDataProduct` (khác owner sản phẩm), `publishMaturityRubric` | Duyệt bản do mình soạn |
| Data steward (`data_steward`) | Domain | `registerDataset`, `createDatasetContractRevision`, `createQualityRuleVersion`, `runQualityChecks`, `assignQualityIncident`, `proposeSourceMapping`, `bindGlossaryTermToDataset`, `runReconciliation`, baseline quyết định ngoại lệ | Tự xác nhận mapping/quy tắc |
| Owner consumer | Consumer được đăng ký | `recordConsumerApproval` | Chấp thuận thay consumer khác |
| Kỹ sư dữ liệu / assignee | Sự cố được giao | `transitionQualityIncident` | Đóng sự cố mình xử lý |
| Người đánh giá / reviewer trưởng thành | Kỳ đánh giá | `recordMaturityEvidence` (assessor), `reviewMaturityEvidence` (reviewer ≠ assessor), baseline publish (≠ assessor) | Chấm điểm không bằng chứng |
| Pipeline/worker (service principal) | Module | `recordLineageBatch`, tạo run tự động | Ghi dữ liệu nghiệp vụ |
| Auditor | Đọc theo scope | catalog, lineage, scorecard, điểm trưởng thành | Command |

Mọi đọc (catalog search, lineage, evidence, xuất) áp RLS tenant + quyền dữ liệu gốc + phân loại (AC55): dataset ngoài quyền không xuất hiện kể cả trong số đếm; nút lineage ngoài quyền hiển thị "bị hạn chế".

## 3. Luồng nghiệp vụ

**F1 — Catalog và owner (DGV-03, DGV-04).** `registerDataset` (DRAFT → ACTIVE khi có hợp đồng phát hành); dataset trọng yếu (`is_critical`) bắt buộc owner ≠ steward. `assignDatasetOwnership` có lý do + audit.

**F2 — Hợp đồng dữ liệu ODCS (DGV-13, DGV-19).** `createDatasetContractRevision` nhận tài liệu ODCS (schema, kiểu, bắt buộc/null, khóa, đơn vị/tiền tệ, phân loại cột, quality expectations, `slaProperties` gồm freshness, retention; team/roles), kiểm theo JSON Schema của phiên bản ODCS được ghim; hệ thống so với bản phát hành hiện hành và tính `compatibility`: thêm trường tùy chọn → BACKWARD_COMPATIBLE; xóa/đổi tên/đổi kiểu/đổi grain/đổi đơn vị/đổi nghĩa → BREAKING. BREAKING sinh `contract_consumer_approval` PENDING cho mọi consumer đăng ký; `publishDatasetContract` (≠ người soạn) chỉ khi mọi consumer APPROVED và có `migration_window_until` (dual-run), tạo `data_contract_version` bất biến (`odcs_sha256`, `odcs_object_key`). Consumer REJECTED → không phát hành; producer tạo revision khác.

**F3 — Quy tắc, lần chạy, kết quả, quarantine (DGV-06, DGV-07, DGV-14).** Quy tắc khai báo bằng AST allowlist theo chiều (COMPLETENESS, VALIDITY, UNIQUENESS, CONSISTENCY, TIMELINESS, ACCURACY, INTEGRITY), ngưỡng, `action_on_fail`. Lần chạy tự động khi `snapshot.frozen.v1` (DIS), lô nhập được áp dụng (MDM/DIS/PAY), theo lịch, hoặc thủ công; mỗi quy tắc ghi `quality_rule_result`; vi phạm QUARANTINE tạo `quality_exception` theo bản ghi (record_reference mask), HARD_BLOCK chặn snapshot dùng cho chỉ tiêu certified; điểm tổng có trọng số criticality nhưng **một lỗi INTEGRITY (cross-tenant/orphan) hoặc sai tổng trọng yếu là hard fail** dù điểm cao. Phát `dgv.quality_run.completed.v1 {dataset_id, snapshot_id, overall_result, quarantined_count}` cho BI.

**F4 — Ngoại lệ và sự cố (DGV-08).** Kết quả FAIL/WARN theo mức độ mở `quality_incident` (rule → result → incident) với SLA theo severity (CRITICAL 4 giờ, HIGH 24 giờ, MEDIUM 3 ngày, LOW 10 ngày [GIẢ ĐỊNH]); `assignQualityIncident` → assignee; assignee `transitionQualityIncident` ACKNOWLEDGED → IN_PROGRESS → RESOLVED_PENDING_VERIFICATION (bắt buộc nguyên nhân + biện pháp, ưu tiên sửa upstream); người khác `verifyQualityIncident` CLOSE chỉ khi lần chạy lại PASS, hoặc REOPEN. Ngoại lệ theo bản ghi: baseline `POST /quality-exceptions/{id}/decision` RESOLVED hoặc WAIVED (hạn, lý do, người duyệt khác owner); waiver hết hạn → job mở lại ngoại lệ và sự cố có audit (AC54); waive không sửa số liệu, không xóa lịch sử lỗi.

**F5 — Lineage (DGV-05, BI-14).** Pipeline, builder snapshot BI, import và export ghi `recordLineageBatch` (node + edge có `run_id`, `transform_version`, `observed_at`), idempotent. `getLineageGraph` duyệt lên/xuống theo depth; mỗi nút kiểm quyền với đối tượng gốc; không quyền → nút ẩn danh.

**F6 — Thuật ngữ (DGV-02).** DGV-02 đọc `glossary_term` của MDM (đề xuất/duyệt/công bố bằng lệnh MDM); DGV chỉ `bindGlossaryTermToDataset` với thuật ngữ PUBLISHED; thuật ngữ bị DEPRECATED → cảnh báo binding và chỉ tiêu BI liên quan. Coverage glossary = số cột trọng yếu có binding / tổng cột trọng yếu.

**F7 — Mapping nguồn D04 và đối soát (DGV-09, DGV-20).** `proposeSourceMapping` → data owner `decideSourceMapping`; pipeline chỉ dùng mapping CONFIRMED (lô dùng mapping chưa xác nhận bị quarantine `MAPPING_NOT_CONFIRMED`). `runReconciliation` so số dòng và tổng tiền hai nguồn **cùng kỳ, tiền tệ, basis**; chênh lệch phân loại missing/timing/reversal/mapping/amount; vượt dung sai → incident có owner; không tự lấy bên lớn hơn, không cộng trộn hai nguồn (04: báo cáo accepted và giao dịch Kho bạc là hai nguồn riêng). Đối soát hằng ngày với Kho bạc (PAY-20, G4-4) không thay `runReconciliation`: DGV đối soát số kiểm soát của hai nguồn dữ liệu theo kỳ; PAY-20 đối soát từng ngày theo mã dự án và nguồn vốn, mở mục có chủ và hạn, và chia sẻ cùng nguyên tắc không tự chọn bên lớn hơn. Kiểm tổng chéo giải ngân (DIS-26, G4-5) là số kiểm soát thứ ba, chặn công bố chỉ tiêu.

**F8 — Trưởng thành (DGV-16, DGV-17, DGV-21).** Rubric có phiên bản: 8 trụ cột của tài liệu 08 (governance/ownership; master/metadata; quality; integration; security/privacy; lineage/BI; AI readiness/governance; cost/value operations), mỗi trụ cột 3–5 tiêu chí có mô tả mức 1–5, trọng số, ánh xạ tham chiếu DCAM/DMM, `min_coverage_pct`, `evidence_ttl_days`. `createMaturityAssessment` khởi tạo mọi tiêu chí NOT_ASSESSED; assessor ghi mức kèm bằng chứng (artifact, log, phỏng vấn, kiểm thử; mẫu; độ tin cậy); reviewer chấp nhận; bằng chứng hết hạn hoặc bị bác → NOT_ASSESSED. Baseline publish (`POST /maturity-assessments/{id}/publish`) tính điểm theo BR-DGV-08. Lộ trình: mốc theo trụ cột với mức mục tiêu, owner, tiêu chí thoát; ACHIEVED chỉ khi một kỳ đánh giá đã công bố chứng minh.

**F9 — Data product (DGV-18).** `certifyDataProduct` (≠ owner) yêu cầu hợp đồng PUBLISHED, lần chạy gần nhất PASSED, bằng chứng; chứng nhận có hạn; hết hạn → PROVISIONAL.

## 4. State machine

```
dataset:            DRAFT ─(contract published)─► ACTIVE ─► DEPRECATED ─► RETIRED
dataset_contract:   DRAFT ─submit─► IN_REVIEW ─publish (consumers ok)─► PUBLISHED ─(revision mới)─► SUPERSEDED   (giá trị baseline giữ; bổ sung)
quality_incident:   OPEN ─assign─► ASSIGNED ─ack─► ACKNOWLEDGED ─► IN_PROGRESS ─► RESOLVED_PENDING_VERIFICATION ─verify CLOSE─► CLOSED
                     ▲                                                                   │ verify REOPEN / waiver hết hạn
                     └────────────────────────────── REOPENED ◄─────────────────────────┘
quality_exception:  OPEN ─decision─► RESOLVED | WAIVED ─(hết hạn)─► OPEN (reopened_from_id)
maturity_evidence:  NOT_ASSESSED ─record + review accept─► ASSESSED ─(hết hạn/bác)─► NOT_ASSESSED ; ─► NOT_APPLICABLE (có lý do)
maturity_assessment: DRAFT ─► IN_REVIEW ─publish─► PUBLISHED (overall_state COMPUTED | NOT_COMPUTED)
contract_consumer_approval: PENDING ─► APPROVED | REJECTED
data_product:       NOT_ASSESSED ─► PROVISIONAL ─► CERTIFIED ─(hết hạn)─► PROVISIONAL ; CERTIFIED ─► REVOKED
```

| Từ | Command | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|
| IN_REVIEW (contract) | `publishDatasetContract` | PUBLISHED | data owner ≠ người soạn | BREAKING: mọi consumer APPROVED + migration window | `dgv.contract.published.v1` |
| ASSIGNED…IN_PROGRESS | `transitionQualityIncident` | trạng thái kế | assignee | RESOLVED cần nguyên nhân + biện pháp | `dgv.incident.status_changed.v1` |
| RESOLVED_PENDING_VERIFICATION | `verifyQualityIncident` CLOSE | CLOSED | người khác assignee | lần chạy lại PASS | `dgv.incident.closed.v1` |
| WAIVED (exception) | (job) | OPEN | system | `waiver_expires_at` đã qua | `dgv.exception.reopened.v1` |
| NOT_ASSESSED | `recordMaturityEvidence` + `reviewMaturityEvidence` ACCEPTED | ASSESSED | assessor + reviewer khác | bằng chứng còn hạn | `dgv.evidence.reviewed.v1` |
| IN_REVIEW (assessment) | baseline publish | PUBLISHED | người khác assessor | tính điểm BR-DGV-08 | `dgv.assessment.published.v1` |

Cấm: phát hành BREAKING khi còn PENDING/REJECTED (`CONSUMER_APPROVAL_PENDING`); đóng sự cố khi chạy lại chưa PASS (`RERUN_NOT_PASSED`); ASSESSED không có level/bằng chứng (CHECK); sửa `data_contract_version` đã phát hành.

## 5. Quy tắc nghiệp vụ và công thức

- **BR-DGV-01 (NotAssessed — thống nhất với CR-DGM-01 của tài liệu 08).** `NOT_ASSESSED` ("Chưa đánh giá") là **trạng thái đánh giá** duy nhất cho: dataset version chưa có lần chạy chất lượng, tiêu chí trưởng thành chưa có bằng chứng được chấp nhận/còn hạn, data product chưa chứng nhận. Nó bị loại khỏi trung bình và tử số coverage, không bao giờ thành 0 hay 1, không được coi là đạt. Giá trị **số liệu** thiếu không dùng NOT_ASSESSED mà dùng `null_reason` của BI: `NO_DATA` ("Chưa có dữ liệu") hoặc `NOT_APPLICABLE` ("Chưa có cơ sở tính"), cũng không đổi thành 0. `UNKNOWN` không được dùng trong DGV/BI (dành cho kết quả giao tin NOT và lệnh mobile MOB theo CR-DGM-01). Một ô chỉ tiêu có thể vừa có giá trị hợp lệ vừa mang huy hiệu chất lượng NOT_ASSESSED.
- **BR-DGV-02 (chiều chất lượng):** completeness = `required_present / required_expected` trên đúng scope (null "không áp dụng" theo contract không tính thiếu); validity = bản ghi qua rule/type/domain/temporal ÷ tổng; uniqueness = số va chạm khóa (mục tiêu 0); consistency (ví dụ CTMTQG ≤ dòng cha); timeliness = tuổi dữ liệu so với `freshness_seconds`; accuracy chỉ từ đối chiếu nguồn xác nhận hoặc lấy mẫu chuyên gia; integrity = orphan/cross-tenant phải 0. Giá trị numeric 6 chữ số thập phân, hiển thị %, 2 chữ số.
- **BR-DGV-03 (điểm lần chạy):** `score = 100 × Σ(w_r × pass_rate_r) / Σ w_r` với `w_r = criticality_weight`; `hard_fail = true` nếu bất kỳ quy tắc INTEGRITY FAIL hoặc quy tắc HARD_BLOCK FAIL trên dataset trọng yếu → `overall_result = FAILED` bất kể điểm.
- **BR-DGV-04 (huy hiệu cho BI/HOME):** NOT_ASSESSED (không có run) / PASSED / WARNING / FAILED theo `overall_result` / STALE khi `now − finished_at > freshness_slo_seconds`.
- **BR-DGV-05 (SLA sự cố):** CRITICAL 4 giờ, HIGH 24 giờ, MEDIUM 72 giờ, LOW 240 giờ [GIẢ ĐỊNH]; tính theo đồng hồ thực; vượt → `dgv.incident.sla_breached.v1` leo thang tới owner.
- **BR-DGV-06 (waiver):** có `waiver_expires_at` (tối đa 180 ngày [GIẢ ĐỊNH]), lý do, người duyệt ≠ owner; hết hạn tự mở lại.
- **BR-DGV-07 (breaking change ODCS):** BREAKING khi xóa/đổi tên/đổi kiểu không mở rộng/đổi `required` thành bắt buộc/đổi grain/đổi đơn vị-tiền tệ/đổi phân loại cao hơn; phát hành cần 100% consumer APPROVED + `migration_window_until ≥ effective_from + 30 ngày` [GIẢ ĐỊNH].
- **BR-DGV-08 (điểm trưởng thành):** `coverage = Σ w_i (ASSESSED) / Σ w_i (ASSESSED + NOT_ASSESSED)` (NOT_APPLICABLE loại khỏi cả tử và mẫu); `pillar_level = Σ(w_i × level_i)/Σ w_i` trên tiêu chí ASSESSED của trụ cột (không có → trụ cột NOT_ASSESSED); `overall_level` chỉ khi `coverage ≥ min_coverage_pct`, = trung bình có trọng số các trụ cột có điểm, làm tròn half-up 2 chữ số; ngược lại `overall_state = NOT_COMPUTED`. Công bố luôn kèm coverage, trọng số, liên kết bằng chứng.
- **BR-DGV-09 (đối soát):** chỉ so hai nguồn cùng kỳ, tiền tệ, basis; |Δ tổng| ≤ `tolerance_vnd` và Δ dòng = 0 → WITHIN_TOLERANCE/MATCHED; còn lại DIFFERENT + incident; không tự chọn bên nào đúng.
- **BR-DGV-10 (glossary):** chỉ bind thuật ngữ PUBLISHED của MDM; DGV không lưu định nghĩa thuật ngữ.
- **BR-DGV-11 (bảo mật metadata):** catalog/lineage/evidence/xuất áp RLS + quyền dữ liệu gốc + phân loại; sample_refs và record_reference luôn mask PII (CCCD/điện thoại/tài khoản).

## 6. Dữ liệu

| Bảng | Thay đổi/Trường chính | Ràng buộc | Classification | Retention |
|---|---|---|---|---|
| `dataset_contract` (sửa) | + dataset_id, odcs_version, odcs_json, producer_module, compatibility, effective_from, created/approved_by | unique (code, revision); SoD; freshness > 0 | INTERNAL | Vĩnh viễn |
| `data_contract_version` (sửa) | + contract_id, odcs_sha256, odcs_object_key, compatibility, published_*, supersedes_id, migration_window_until; FK dataset, retention policy | unique (dataset, revision); bất biến | INTERNAL | Vĩnh viễn |
| `quality_rule_version` (sửa) | + dimension, field_path, action_on_fail, criticality_weight, SoD | unique (contract, code, revision) | INTERNAL | Vĩnh viễn |
| `quality_run` (sửa) | + dataset_id, trigger, status, overall_result, score, hard_fail | counts ≥ 0 | INTERNAL | 5 năm |
| `quality_exception` (sửa) | + rule_version_id, incident_id, decision, waiver_reason, reopened_from_id | waiver cần hạn + lý do; SoD | INTERNAL (mask) | 5 năm |
| `quality_incident` (sửa) | + title, run_id, assignee, impact, root_cause, remediation, sla_hours, verified_*, reopened_count; FK rule | verifier ≠ assignee | INTERNAL | 5 năm |
| `maturity_assessment` (sửa) | + rubric_version_id, scope, assessor, overall_level/state, published_* | COMPUTED ⇔ có level; SoD | INTERNAL | Vĩnh viễn |
| `maturity_evidence` (sửa) | + assessment_state, assessed_by/on, sample_size, confidence, reviewer, evidence_expires_on, na_reason | ASSESSED ⇔ level; level 1–5; SoD; unique tiêu chí/kỳ | INTERNAL | Vĩnh viễn |
| bảng mới (12) | xem cột | như §5 | INTERNAL/PUBLIC (rubric) | Theo bảng |

`quality_incident.dataset_version_id` và `quality_run.snapshot_id` (baseline) là tham chiếu logic tới snapshot của module nguồn (DIS `period_snapshot`, BI `bi_dataset_version` hoặc lô nhập) — giữ nguyên, có index. Mọi cột `*_id` có index `(tenant_id, col)`.

- `dataset_contract` (sửa): id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id, odcs_version, odcs_json, producer_module, compatibility, effective_from, created_by, approved_by, created_at, version
- `data_contract_version` (sửa): id, dataset_id, revision, grain, schema_json, owner_id, quality_rules, retention_policy_id, status, contract_id, odcs_sha256, odcs_object_key, compatibility, published_by, published_at, supersedes_id, migration_window_until
- `quality_rule_version` (sửa): id, contract_id, code, revision, expression_ast, severity, threshold_json, status, dimension, field_path, action_on_fail, criticality_weight, created_by, approved_by, created_at
- `quality_run` (sửa): id, dataset_contract_id, snapshot_id, rule_version_ids, passed_count, failed_count, quarantined_count, finished_at, dataset_id, trigger, started_at, status, overall_result, score, hard_fail, triggered_by
- `quality_exception` (sửa): id, run_id, record_reference, owner_id, reason, status, waiver_expires_at, evidence, rule_version_id, incident_id, decision, decided_by, decided_at, waiver_reason, reopened_from_id, created_at, version
- `quality_incident` (sửa): id, rule_id, dataset_version_id, affected_refs, severity, owner_id, status, due_at, resolution, title, run_id, assignee_user_id, impact, root_cause, remediation, sla_hours, verified_by, verified_at, reopened_count, created_at, version
- `maturity_assessment` (sửa): id, period_code, rubric_version, coverage_percent, status, reviewer_id, rubric_version_id, scope_kind, scope_ref, assessor_user_id, overall_level, overall_state, published_by, published_at, created_at, version
- `maturity_evidence` (sửa): id, assessment_id, pillar_code, criterion_code, level, evidence_refs, review_status, assessment_state, assessed_by, assessed_on, sample_size, confidence, reviewer_user_id, evidence_expires_on, na_reason, created_at, version
- `dataset` (mới): id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, current_contract_version_id, retention_policy_id, status, created_at, created_by, updated_at, updated_by, version
- `contract_consumer_approval` (mới): id, contract_id, consumer_kind, consumer_ref, consumer_owner_user_id, decision, decided_by, decided_at, comment, created_at, created_by, updated_at, updated_by, version
- `quality_rule_result` (mới): id, run_id, rule_version_id, evaluated_count, passed_count, failed_count, quarantined_count, measured_value, threshold_snapshot, result, sample_refs, incident_id
- `quality_incident_event` (mới): id, incident_id, event_kind, actor_user_id, from_status, to_status, note, occurred_at
- `lineage_node` (mới): id, node_kind, ref_module, ref_id, ref_key, display_name, classification, created_at
- `lineage_edge` (mới): id, from_node_id, to_node_id, run_id, transform_version, observed_at
- `dataset_glossary_binding` (mới): id, dataset_id, column_name, glossary_term_id, bound_by, bound_at
- `dataset_source_mapping` (mới): id, dataset_id, source_system, source_field, target_field, transform_rule, unit, status, confirmed_by, confirmed_at, created_at, created_by, updated_at, updated_by, version
- `reconciliation_run` (mới): id, recon_code, source_a, source_b, as_of_period, basis, count_a, count_b, total_a_vnd, total_b_vnd, tolerance_vnd, differences_json, result, owner_user_id, incident_id, created_at, created_by, updated_at, updated_by, version
- `maturity_rubric_version` (mới): id, rubric_code, revision, framework_refs, pillars_json, min_coverage_pct, evidence_ttl_days, status, approved_by, created_at, created_by, updated_at, updated_by, version
- `maturity_milestone` (mới): id, rubric_version_id, pillar_code, target_level, due_on, owner_user_id, exit_criteria, evidence_required, status, achieved_assessment_id, created_at, created_by, updated_at, updated_by, version
- `data_product` (mới): id, code, title, dataset_ids, owner_user_id, certification_status, certified_by, certified_at, certification_expires_on, evidence_refs, revoke_reason, created_at, created_by, updated_at, updated_by, version

## 7. API / command

| operationId | Method path | x-permission | Request DTO | Lỗi chính | Idem | If-Match |
|---|---|---|---|---|---|---|
| `registerDataset` | POST /dgv/datasets | data.catalog.manage | `DgvDatasetRegister` | DATASET_CODE_DUPLICATE, OWNER_STEWARD_SAME | ✔ | – |
| `assignDatasetOwnership` | POST /dgv/datasets/{id}/ownership | data.catalog.manage | `DgvOwnership` | OWNER_STEWARD_SAME | ✔ | ✔ |
| `createDatasetContractRevision` | POST /dgv/dataset-contracts | data.contract.manage | `DgvContractDraft` | ODCS_SCHEMA_INVALID, CONTRACT_REVISION_OPEN | ✔ | – |
| `recordConsumerApproval` | POST /dgv/contract-consumer-approvals/{id}/decision | data.contract.consume | `DgvConsumerDecision` | NOT_CONSUMER_OWNER | ✔ | ✔ |
| `publishDatasetContract` | POST /dgv/dataset-contracts/{id}/publish | data.contract.approve | `DgvContractPublish` | CONSUMER_APPROVAL_PENDING, SELF_APPROVAL_DENIED, MIGRATION_WINDOW_REQUIRED | ✔ | ✔ |
| `createQualityRuleVersion` | POST /dgv/quality-rules | data.quality.manage | `DgvRuleDraft` | EXPRESSION_NOT_ALLOWED, THRESHOLD_INVALID | ✔ | – |
| `approveQualityRuleVersion` | POST /dgv/quality-rules/{id}/approval | data.quality.approve | – | SELF_APPROVAL_DENIED | ✔ | ✔ |
| `runQualityChecks` | POST /dgv/quality-runs | data.quality.run | `DgvRunRequest` | RUN_ALREADY_RUNNING, SNAPSHOT_NOT_FOUND | ✔ | – |
| `assignQualityIncident` | POST /dgv/quality-incidents/{id}/assignment | data.quality.triage | `DgvIncidentAssign` | ASSIGNEE_OUT_OF_SCOPE, INCIDENT_STATE_INVALID | ✔ | ✔ |
| `transitionQualityIncident` | POST /dgv/quality-incidents/{id}/transition | data.quality.remediate | `DgvIncidentTransition` | INCIDENT_STATE_INVALID, NOT_ASSIGNEE, ROOT_CAUSE_REQUIRED | ✔ | ✔ |
| `verifyQualityIncident` | POST /dgv/quality-incidents/{id}/verification | data.quality.triage | `DgvIncidentVerify` | SELF_APPROVAL_DENIED, RERUN_NOT_PASSED | ✔ | ✔ |
| `recordLineageBatch` | POST /dgv/lineage-batches | data.lineage.write | `DgvLineageBatch` | LINEAGE_NODE_INVALID | ✔ | – |
| `bindGlossaryTermToDataset` | POST /dgv/datasets/{id}/glossary-bindings | data.catalog.manage | `DgvGlossaryBind` | GLOSSARY_TERM_NOT_PUBLISHED | ✔ | – |
| `proposeSourceMapping` | POST /dgv/source-mappings | data.mapping.manage | `DgvMappingPropose` | MAPPING_DUPLICATE | ✔ | – |
| `decideSourceMapping` | POST /dgv/source-mappings/{id}/decision | data.mapping.approve | `DgvMappingDecision` | SELF_APPROVAL_DENIED | ✔ | ✔ |
| `runReconciliation` | POST /dgv/reconciliations | data.quality.run | `DgvReconRequest` | BASIS_MISMATCH | ✔ | – |
| `createMaturityRubricVersion` | POST /dgv/maturity-rubrics | data.maturity.manage | `DgvRubricDraft` | RUBRIC_WEIGHTS_INVALID | ✔ | – |
| `publishMaturityRubric` | POST /dgv/maturity-rubrics/{id}/publish | data.maturity.publish | – | SELF_APPROVAL_DENIED | ✔ | ✔ |
| `createMaturityAssessment` | POST /dgv/maturity-assessments | data.maturity.manage | `DgvAssessmentCreate` | RUBRIC_NOT_PUBLISHED, ASSESSOR_IS_REVIEWER | ✔ | – |
| `recordMaturityEvidence` | POST /dgv/maturity-assessments/{id}/evidence | data.maturity.assess | `DgvEvidenceRecord` | EVIDENCE_REQUIRED, LEVEL_OUT_OF_RANGE, EVIDENCE_EXPIRED | ✔ | ✔ |
| `reviewMaturityEvidence` | POST /dgv/maturity-evidence/{id}/review | data.maturity.review | `DgvEvidenceReview` | SELF_APPROVAL_DENIED | ✔ | ✔ |
| `createMaturityMilestone` | POST /dgv/maturity-milestones | data.maturity.manage | `DgvMilestone` | TARGET_BELOW_CURRENT | ✔ | – |
| `certifyDataProduct` | POST /dgv/data-products/{id}/certification | data.product.certify | `DgvProductCertify` | SELF_APPROVAL_DENIED, QUALITY_NOT_PASSED, CONTRACT_NOT_PUBLISHED | ✔ | ✔ |
| `searchCatalog` | GET /dgv/catalog | data.catalog.read | – | – | – | – |
| `getLineageGraph` | GET /dgv/lineage | data.lineage.read | – | – | – | – |
| `getQualityScorecard` | GET /dgv/datasets/{id}/quality-scorecard | data.quality.read | – | – | – | – |
| `getMaturityScore` | GET /dgv/maturity-assessments/{id}/score | data.maturity.read | – | – | – | – |

Lệnh baseline giữ nguyên: `post_quality_exceptions_id_decision` (POST /quality-exceptions/{id}/decision, `data.quality.review`) — RESOLVED/WAIVED theo BR-DGV-06; `post_maturity_assessments_id_publish` (POST /maturity-assessments/{id}/publish, `data.maturity.publish`) — tính điểm BR-DGV-08, người công bố ≠ assessor. **Rà soát GET scaffold:** `quality_incident` dto, `maturity_assessment` giữ, `dataset_contract` giữ, `quality_rule_version` giữ, `quality_run` dto, `quality_exception` dto (mask), `maturity_evidence` dto.

## 8. UI/UX

Giữ DGV-01…DGV-18 (bổ sung field/ranh giới — CR §13); mới DGV-19, DGV-20, DGV-21. Component: MetricTile + QualityBadge (5 trạng thái, chữ + icon), DataTable, FilterBar, MasterTree (lineage dạng cây/đồ thị), ComparePanel (diff schema hợp đồng), WorkflowCanvas (sự cố dạng kanban DGV-08, không kéo-thả đổi trạng thái), EvidenceViewer (bằng chứng trưởng thành).

| ID | Tên | Kind | Phase | Nền tảng | Trường chính |
|---|---|---|---|---|---|
| DGV-01 | Điều hành chất lượng dữ liệu | dashboard | P1 | web | Domain; Chất lượng; Độ mới; Sự cố; Huy hiệu (NOT_ASSESSED/PASSED/WARNING/FAILED/STALE); Incident quá SLA |
| DGV-02 | Business glossary | table | P1 | web | Thuật ngữ; Định nghĩa; Owner; Phiên bản; Trạng thái MDM (PUBLISHED/DEPRECATED); Dataset gắn |
| DGV-03 | Chủ sở hữu và steward | table | P1 | web | Domain; Owner; Steward; SLA; Dữ liệu trọng yếu |
| DGV-04 | Data catalogue | table | P1 | web | Dataset; Grain; Nguồn; Classification; Độ mới; Hợp đồng hiện hành; Owner/steward; Huy hiệu |
| DGV-05 | Lineage toàn hệ thống | tree | P1 | web | Chỉ tiêu; Transform; Dataset; Bản ghi nguồn; Run id; Phiên bản transform; Nút bị hạn chế |
| DGV-06 | Quy tắc chất lượng | form | P1 | web | Dataset; Trường; Loại kiểm tra; Ngưỡng; Hành động; Chiều chất lượng; Trọng số trọng yếu; Người duyệt |
| DGV-07 | Profiling và điểm chất lượng | chart | P1 | web | Completeness; Uniqueness; Validity; Consistency; Timeliness; Lần chạy; Integrity (cross-tenant/orphan) |
| DGV-08 | Sự cố dữ liệu | kanban | P1 | web | Domain; Mức độ; Owner; Hạn; Assignee; Nguyên nhân; Khắc phục; Người xác minh |
| DGV-09 | Đối soát và số kiểm soát | reconcile | P1 | web | Nguồn A; Nguồn B; Số dòng; Tổng tiền; Sai lệch; Basis; Dung sai; Phân loại chênh lệch |
| DGV-10 | Quản trị dữ liệu trùng | review | P1 | web | Ứng viên; Độ tương đồng; Golden record; Tác động |
| DGV-11 | Lưu trữ và legal hold | policy | P1 | web | Loại dữ liệu; Retention; Legal hold; Xóa |
| DGV-12 | Duyệt sửa dữ liệu trọng yếu | approval | P1 | web | Trước; Sau; Căn cứ; Người duyệt |
| DGV-13 | Data contract và schema | editor | P1 | web | Producer; Consumer; Schema; Version; Compatibility; Phiên bản ODCS; Băm bản phát hành; Chấp thuận consumer |
| DGV-14 | Pipeline và mapping | workflow | P1 | web | Nguồn; Mapping; Validation; Quarantine; Publish; Mapping đã xác nhận (D04) |
| DGV-15 | Phân loại và quyền dữ liệu | policy | P1 | web | Classification; PII; Row policy; Column policy; Phân loại 5 mức (gồm IMPORTANT_CORE) |
| DGV-16 | Đánh giá trưởng thành dữ liệu | criteria | P1 | web | Trụ cột; Mức hiện tại; Bằng chứng; Mục tiêu; Trạng thái đánh giá (ASSESSED/NOT_ASSESSED/NOT_APPLICABLE); Coverage; Người review |
| DGV-17 | Lộ trình trưởng thành | timeline | P1 | web | Mốc; Owner; Tiêu chí thoát; Bằng chứng; Trạng thái mốc |
| DGV-18 | Data product và chứng nhận | cards | P1 | web | Báo cáo vốn; Actual Kho bạc; Hồ sơ AI; Usage SaaS; Hạn chứng nhận; Người chứng nhận |
| DGV-19 | Chấp thuận thay đổi hợp đồng dữ liệu | approval | P1 | web | Hợp đồng; Mức tương thích; Consumer; Quyết định; Cửa sổ dual-run; Diff schema |
| DGV-20 | Mapping trường nguồn (D04) | table | P1 | web | Dataset; Hệ thống nguồn; Trường nguồn; Trường đích; Biến đổi; Đơn vị; Trạng thái |
| DGV-21 | Rubric trưởng thành dữ liệu | criteria | P1 | web | Trụ cột; Tiêu chí; Mô tả mức 1–5; Trọng số; Ánh xạ DCAM/DMM; Coverage tối thiểu; Hạn bằng chứng |

Trạng thái riêng: "Chưa đánh giá" (NOT_ASSESSED — màu trung tính, không đỏ/xanh), "Dữ liệu cũ" (STALE), "Hard fail" (kể cả khi điểm cao), "Chờ consumer chấp thuận", "Waiver hết hạn — đã mở lại", "Nút bị hạn chế". Điểm trưởng thành hiển thị kèm coverage và số tiêu chí chưa đánh giá; khi NOT_COMPUTED hiển thị "Chưa đủ bằng chứng để tính điểm tổng". Mobile: không có màn DGV.

## 9. Sự kiện, job, tích hợp, quan sát

Events: `dgv.dataset.registered/ownership_changed.v1`, `dgv.contract.drafted/consumer_decided/published.v1 {compatibility, odcs_sha256}`, `dgv.rule.drafted/approved.v1`, `dgv.quality_run.completed.v1 {dataset_id, snapshot_id, overall_result, score, hard_fail, quarantined_count}`, `dgv.incident.opened/assigned/status_changed/closed/reopened/sla_breached.v1`, `dgv.exception.reopened.v1`, `dgv.glossary.bound.v1`, `dgv.mapping.proposed/decided.v1`, `dgv.reconciliation.completed.v1`, `dgv.rubric.drafted/published.v1`, `dgv.assessment.created/published.v1`, `dgv.evidence.recorded/reviewed.v1`, `dgv.milestone.created/achieved/missed.v1`, `dgv.product.certified.v1`. Consumers: `snapshot.frozen.v1` (DIS), `master.import_applied.v1` (MDM), `dis.import_batch.applied.v1`, `pay.treasury_import.applied.v1` → chạy quy tắc; `glossary.published.v1`/`deprecated.v1` (MDM) → kiểm binding; `bi.dataset_version.frozen.v1` → lineage. Job: `dgv.waiver-expiry` (mỗi 15 phút), `dgv.incident-sla` (mỗi 15 phút), `dgv.freshness-check` (mỗi giờ → STALE), `dgv.evidence-expiry` (hằng ngày), `dgv.product-cert-expiry`, `dgv.milestone-due`. Telemetry: `dgv_quality_score{dataset}`, `dgv_hard_fail_total`, `dgv_incident_open_gauge{severity}`, `dgv_incident_sla_breach_total`, `dgv_not_assessed_datasets_gauge`, `dgv_cross_tenant_ref_total` (phải = 0, cảnh báo P1); log không chứa giá trị bản ghi.

## 10. Kiểm thử

Ma trận: positive (AC50, AC52, AC487), negative (AC483, AC484, AC491), boundary (AC53, AC486, AC488), đồng thời/idempotency (AC489), bảo mật/cách ly (AC55, AC492, AC496), job (AC54, AC494). Baseline DQ01 (NFR-OPERABILITY-06) giữ nguyên.

| ID | Loại | Ưu tiên | Setup | Input/Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC50 | business | P1 | Dataset DS-DISB hợp đồng r3 PUBLISHED có 3 consumer: BI_DATASET DS-DISB-BI, MODULE HOME, EXPORT MNE-07; r4 đổi kiểu cột amount từ numeric(24,0) sang numeric(24,2) và đổi tên cột unit_code → org_unit_code. | 1) POST /dgv/dataset-contracts r4 → compatibility tính ra 2) BI và HOME APPROVED, MNE-07 còn PENDING; POST publish 3) MNE-07 APPROVED; publish không có migration_window_until 4) Publish với migration_window_until 2026-12-31 | compatibility=BREAKING; publish lần 1: 409 CONSUMER_APPROVAL_PENDING (liệt kê MNE-07); lần 2: 422 MIGRATION_WINDOW_REQUIRED; lần 3: data_contract_version r4 bất biến với odcs_sha256, r3 vẫn phục vụ tới 2026-12-31 (dual-run); thêm cột tùy chọn ở r5: BACKWARD_COMPATIBLE, không cần chấp thuận. | DB + API log |
| UAT-AC51 | business | P1 | Lô nhập báo cáo tuần 1.000 dòng; quy tắc R-FK (INTEGRITY, QUARANTINE): 12 dòng có project_id không tồn tại; chỉ tiêu GIAI_NGAN CERTIFIED. | 1) Chạy kiểm chất lượng trên snapshot 2) Dựng bi_dataset_version kỳ 3) Mở dashboard và DGV-14 | quality_rule_result R-FK: evaluated 1.000, failed 12, quarantined 12, result FAIL; bi_dataset_version.excluded_quarantine_rows=12; tổng GIAI_NGAN certified không gồm 12 dòng; dashboard hiển thị "12 dòng bị loại (quarantine)" với link tới DGV-14; 12 quality_exception OPEN có owner. | quality_rule_result + bi_dataset_version |
| UAT-AC52 | business | P1 | Ô "Tỷ lệ giải ngân U-STC" trên dashboard D-1 (metric M-RATE r2, snapshot SV-10b) bắt nguồn từ report_revision RR-55 (DIS) qua lô nhập IB-7 và transform "snapshot_builder@1.4". | 1) GET /dgv/lineage?node_kind=METRIC_VERSION&ref_id=M-RATE-r2&direction=upstream&depth=6 bởi A-ana (có quyền U-STC) 2) Lặp lại bởi A-staff (không quyền U-STC) | A-ana: chuỗi DASHBOARD_VERSION D-1 → METRIC_VERSION M-RATE r2 → DATASET_VERSION SV-10b → TABLE period_snapshot_line → RECORD RR-55 → IMPORT_BATCH IB-7, mỗi cạnh có run_id và transform_version; A-staff: các nút RECORD/IMPORT_BATCH của U-STC hiển thị "nút bị hạn chế" không tên, không id. | lineage graph |
| UAT-AC53 | business | P1 | Rubric RB-1 r1 (8 trụ cột × 3 tiêu chí, trọng số đều, min_coverage 70%); kỳ 2026-H2: 14 tiêu chí ASSESSED (mức 2–4, đã review), 8 NOT_ASSESSED (thiếu bằng chứng), 2 NOT_APPLICABLE có lý do. | 1) GET /dgv/maturity-assessments/{id}/score 2) Ghi bằng chứng cho 3 tiêu chí nữa (ASSESSED, review chấp nhận) 3) GET score lại 4) Thử ghi level=1 với assessment_state NOT_ASSESSED | Lần 1: coverage = 14/22 = 63,64% < 70% → overall_state=NOT_COMPUTED, overall_level=null, not_assessed_count=8, trụ cột không có tiêu chí nào ASSESSED hiển thị NOT_ASSESSED (không 0, không 1); lần 2: coverage 17/22 = 77,27% → COMPUTED, overall_level = trung bình có trọng số chỉ trên 17 tiêu chí ASSESSED; ghi level với NOT_ASSESSED: 422 (CHECK state_level_chk). | getMaturityScore |
| UAT-AC54 | business | P1 | quality_exception QE-1 WAIVED với waiver_expires_at 2026-11-30 23:59 +07:00, liên kết incident QI-3 CLOSED; policy mở lại khi hết hạn. | 1) Chạy job dgv.waiver-expiry lúc 2026-12-01 00:05 2) Đọc QE-1, QI-3 và audit 3) Chạy job lần nữa | QE-1 → OPEN với reopened_from_id lưu lịch sử waiver cũ; QI-3 REOPENED (reopened_count=1), quality_incident_event REOPENED, thông báo assignee; audit ghi actor=system, lý do "waiver_expired"; chạy lại không mở lần hai; waive không sửa số liệu gốc. | job log + audit |
| UAT-AC55 | business | P1 | Dataset DS-LND-HOUSEHOLD (PERSONAL) chỉ cấp cho vai trò LND; A-ana không có quyền; quality_exception của dataset chứa record_reference số CCCD. | 1) A-ana GET /dgv/catalog?q=household 2) A-ana GET /dgv/lineage chứa nút dataset đó 3) A-ana GET /resources/quality_exception?… 4) A-ana xuất danh sách ngoại lệ từ DGV-08 | Catalog: 0 kết quả và total không đếm dataset ẩn; lineage: nút "bị hạn chế"; quality_exception: record_reference/evidence bị mask (CCCD hiển thị ***2345); xuất: không có dòng của dataset PERSONAL. | API log + export file |
| UAT-AC483 | domain | P1 | Đăng ký dataset trọng yếu DS-TREASURY với owner = steward = A-data. | 1) POST /dgv/datasets {is_critical:true, owner_user_id:A-data, steward_user_id:A-data} 2) Đăng ký với steward A-steward 3) Đăng ký trùng mã | 422 OWNER_STEWARD_SAME; 200 DRAFT; 409 DATASET_CODE_DUPLICATE. | API log |
| UAT-AC484 | domain | P1 | Quy tắc R-COMPLETE (COMPLETENESS, ngưỡng ≥ 99,5%, HARD_BLOCK) do A-steward soạn. | 1) A-steward tự duyệt 2) A-owner duyệt 3) Tạo quy tắc có node raw_sql | 403 SELF_APPROVAL_DENIED; APPROVED; 422 EXPRESSION_NOT_ALLOWED. | DB |
| UAT-AC485 | domain | P0 | Snapshot có 10 quy tắc: 9 PASS điểm cao; 1 quy tắc INTEGRITY phát hiện 1 dòng tham chiếu project của tenant khác (cross-tenant ref). | 1) POST /dgv/quality-runs 2) GET /dgv/datasets/{id}/quality-scorecard | score tính theo trọng số ≈ 95 nhưng hard_fail=true và overall_result=FAILED; huy hiệu FAILED; incident CRITICAL mở với SLA 4 giờ; bi_dataset_version kỳ đó không được dùng cho chỉ tiêu certified. | quality_run |
| UAT-AC486 | business | P0 | Dataset DS-AI-USAGE ACTIVE chưa có quality_run nào; DS-DISB có run 2 ngày trước với freshness_slo 1 ngày. | 1) Mở DGV-01 2) GET scorecard hai dataset | DS-AI-USAGE: huy hiệu NOT_ASSESSED "Chưa đánh giá", điểm null (không 0, không đạt); DS-DISB: STALE "Dữ liệu cũ 2 ngày (SLO 1 ngày)"; tổng điều hành không tính DS-AI-USAGE vào trung bình. | UI + API |
| UAT-AC487 | E2E | P0 | Run QR-9 FAIL quy tắc R-UNIQ (UNIQUENESS) trên DS-PAYMENT → incident QI-9 HIGH, SLA 24 giờ; A-steward triage; A-eng xử lý. | 1) assignQualityIncident {assignee:A-eng, due_at:+24h} 2) A-eng transition ACKNOWLEDGED → IN_PROGRESS → RESOLVED_PENDING_VERIFICATION thiếu root_cause rồi có 3) A-eng tự verify; A-steward verify CLOSE khi run lại vẫn FAIL; run lại PASS rồi CLOSE | Thiếu nguyên nhân: 422 ROOT_CAUSE_REQUIRED; tự verify: 403 SELF_APPROVAL_DENIED; run lại FAIL: 422 RERUN_NOT_PASSED; sau PASS: CLOSED, verified_by=A-steward; mỗi bước có quality_incident_event; quá hạn trước khi resolve phát dgv.incident.sla_breached.v1. | quality_incident_event |
| UAT-AC488 | domain | P0 | Kỳ 2026-10: PAY treasury_transaction confirmed 1.250 dòng, tổng 98.450.000.000; DIS report accepted 1.247 dòng, tổng 98.200.000.000; dung sai 0. | 1) POST /dgv/reconciliations {recon_code:"PAY_vs_DIS", as_of_period:"2026-10", basis:"VND, ngày Kho bạc thanh toán", tolerance_vnd:"0"} 2) Đọc differences_json | result=DIFFERENT, chênh 3 dòng và 250.000.000; differences phân loại (ví dụ 2 missing, 1 timing) — không tự lấy bên lớn; incident mở cho owner A-acct; hai bên giữ nguyên số (không cộng trộn nguồn). | reconciliation_run |
| UAT-AC489 | integration (idempotency) | P1 | snapshot.frozen.v1 đến hai lần; pipeline gửi lại cùng lô lineage. | 1) Consumer nhận hai lần 2) POST /dgv/lineage-batches hai lần cùng nội dung 3) POST /dgv/quality-runs khi run đang RUNNING | Một quality_run cho snapshot; cạnh lineage không trùng (unique from,to,transform_version); 409 RUN_ALREADY_RUNNING. | DB |
| UAT-AC490 | integration | P1 | Thuật ngữ MDM "GIAI_NGAN_LUY_KE" r2 IN_REVIEW, r1 PUBLISHED. | 1) bindGlossaryTermToDataset với r2 2) Bind với r1 3) MDM publish r2 (r1 DEPRECATED) | 422 GLOSSARY_TERM_NOT_PUBLISHED; bind r1 thành công; sau publish r2: DGV-02 cảnh báo binding trỏ thuật ngữ DEPRECATED và đề xuất bind r2; DGV không có bảng thuật ngữ riêng. | DB + MDM |
| UAT-AC491 | domain | P1 | Mapping "BC_TUAN.so_tien" → "funding_snapshot_line.amount_vnd" đơn vị "triệu đồng" do A-steward đề xuất. | 1) A-steward tự confirm 2) A-owner confirm 3) Pipeline nhập lô trước và sau confirm | 403 SELF_APPROVAL_DENIED; CONFIRMED; lô trước confirm bị quarantine với lý do MAPPING_NOT_CONFIRMED, lô sau dùng mapping với quy đổi ×1.000.000 về VND nguyên. | DB |
| UAT-AC492 | security | P0 | Kỳ đánh giá A-1: assessor A-as, reviewer A-rv; tiêu chí QUAL-2 có bằng chứng hết hạn (evidence_expires_on 2026-06-30) từ kỳ trước. | 1) A-as ghi QUAL-2 ASSESSED mức 4 không evidence_refs 2) Ghi với bằng chứng cũ hết hạn 3) A-as tự review bằng chứng hợp lệ 4) Publish (baseline POST /maturity-assessments/{id}/publish) bởi A-as | 422 EVIDENCE_REQUIRED; 422 EVIDENCE_EXPIRED (tiêu chí giữ NOT_ASSESSED); 403 SELF_APPROVAL_DENIED; publish bởi assessor: 403 SELF_APPROVAL_DENIED. | audit |
| UAT-AC493 | domain | P1 | Rubric RB-2 nháp với Σ trọng số trụ cột 90. | 1) createMaturityRubricVersion 2) Sửa Σ = 100 và publish bởi người soạn 3) Publish bởi người khác | 422 RUBRIC_WEIGHTS_INVALID; 403 SELF_APPROVAL_DENIED; PUBLISHED; framework_refs chỉ là ánh xạ tham chiếu (UI ghi "không phải chứng nhận DCAM/DMM"). | DB |
| UAT-AC494 | business | P1 | Mốc MS-1: trụ cột QUALITY mục tiêu mức 3 hạn 2026-12-31. | 1) Đánh dấu ACHIEVED không có assessment 2) Kỳ đánh giá công bố QUALITY = 2,7 3) Qua hạn job chạy | Không ACHIEVED khi thiếu achieved_assessment_id (CHECK); 2,7 < 3 không ACHIEVED; sau hạn: MISSED, thông báo owner. | DB |
| UAT-AC495 | domain | P1 | Data product "Actual Kho bạc" gồm DS-TREASURY (hợp đồng r2 PUBLISHED, run gần nhất FAILED). | 1) Owner tự certify 2) Người khác certify 3) Sau run PASSED certify với hạn 2027-06-30 | 403 SELF_APPROVAL_DENIED; 422 QUALITY_NOT_PASSED; CERTIFIED với certification_expires_on; hết hạn → PROVISIONAL tự động và BI hiển thị huy hiệu tương ứng. | DB |
| UAT-AC496 | security (cách ly tenant) | P0 | TNT-A và TNT-B cùng có dataset mã DS-DISB; B-data biết UUID lineage node của TNT-A. | 1) B-data GET /dgv/catalog?q=DS-DISB 2) B-data GET /dgv/lineage?ref_id=<node TNT-A> 3) B-data POST /dgv/lineage-batches có cạnh trỏ node TNT-A | Chỉ thấy DS-DISB của TNT-B; 404 với node TNT-A; lineage batch: 422 LINEAGE_NODE_INVALID (FK composite tenant chặn), không tạo cạnh. | RLS log |

## 11. Tiêu chí nghiệm thu

- **AC-DGV-01** (FRD AC50) Breaking change bị chặn khi consumer chưa chấp thuận. → UAT-AC50
- **AC-DGV-02** (FRD AC51) Bản ghi quarantine không vào chỉ tiêu certified; dashboard thể hiện phần bị loại. → UAT-AC51
- **AC-DGV-03** (FRD AC52) Từ KPI truy được metric version, snapshot, transform và bản ghi nguồn đúng quyền. → UAT-AC52
- **AC-DGV-04** (FRD AC53) Thiếu bằng chứng hiển thị NOT_ASSESSED và không tạo điểm tổng sai. → UAT-AC53, UAT-AC492
- **AC-DGV-05** (FRD AC54) Waiver hết hạn tự mở lại theo chính sách, có audit. → UAT-AC54
- **AC-DGV-06** (FRD AC55) RLS/mask áp dụng cho catalog, lineage, bằng chứng chất lượng và xuất. → UAT-AC55, UAT-AC496
- **AC-DGV-07** Given lỗi integrity, Then hard fail dù điểm cao. → UAT-AC485
- **AC-DGV-08** Given chưa có lần chạy, Then huy hiệu NOT_ASSESSED, không tính vào trung bình. → UAT-AC486
- **AC-DGV-09** Given sự cố, Then có assignee, SLA, nguyên nhân, xác minh bởi người khác sau khi chạy lại đạt. → UAT-AC487
- **AC-DGV-10** Given đối soát hai nguồn, Then chênh lệch được phân loại và mở incident, không tự chọn bên. → UAT-AC488

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1 (mềm theo HOME CR-HOME-01):** catalog cho dataset tài chính trọng yếu (DIS, PAY, CAP), quy tắc INTEGRITY/COMPLETENESS/UNIQUENESS chạy khi snapshot đóng băng, huy hiệu NOT_ASSESSED/PASSED/FAILED cho BI/HOME, ngoại lệ + sự cố có assignee, mapping D04 (DGV-20), đối soát PAY ↔ DIS (DGV-09); DGV-01, 04, 06, 07, 08, 09, 14, 20. **R2:** hợp đồng ODCS + chấp thuận consumer (DGV-13/19), lineage đầy đủ (DGV-05), glossary binding (DGV-02), trưởng thành (DGV-16/17/21), data product (DGV-18). **R3:** quy tắc accuracy theo mẫu chuyên gia, tự động hóa đề xuất quy tắc.
**Giờ review người:** định nghĩa NOT_ASSESSED, NO_DATA và huy hiệu với PO + Chủ nghiệp vụ (2 h); quy tắc chất lượng tài chính trọng yếu + dung sai đối soát (Kế toán + Data owner, 4 h); rubric và ngưỡng coverage (Data owner, 3 h); breaking change ODCS (Data/Platform, 2 h). Tổng ≈ 11 h.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| D04: source inventory và mapping từng trường | Data Owner | Mapping CONFIRMED trên DGV-20 cho nguồn pilot |
| Ghim phiên bản ODCS (v3.0.x) và JSON Schema [GIẢ ĐỊNH] | Data/Platform | Spike R2 |
| SLA sự cố, hạn waiver, cửa sổ dual-run, ngưỡng coverage 70% [GIẢ ĐỊNH] | Data Owner + PO | Quy chế quản trị dữ liệu của tenant |
| Thuật ngữ NotAssessed đã thống nhất ở tài liệu 08 (CR-DGM-01); BI dùng `NO_DATA`/`NOT_APPLICABLE` cho giá trị thiếu | Data owner | Đã đồng bộ |
| Cross-module: MDM `glossary_term` là nguồn thuật ngữ duy nhất; MDM phát `glossary.published/deprecated.v1` | MDM owner | Đã có trong MDM |
| Cross-module: DIS/PAY/MDM phát sự kiện lô nhập đã áp dụng để chạy quy tắc; BI nhận `dgv.quality_run.completed.v1` | Owner DIS/PAY/MDM; BI (cùng nhóm) | Hợp đồng sự kiện |
| [CXN-13] Danh mục dữ liệu quan trọng/cốt lõi để gán IMPORTANT_CORE | Pháp chế + DPO | Văn bản + đánh giá |

**Thay đổi bản ghi baseline (CR, baseline-first):**

| Bản ghi baseline | Thay đổi (cũ → mới) | Lý do |
|---|---|---|
| bảng dataset_contract | thêm cột dataset_id, odcs_version, odcs_json, producer_module, compatibility, effective_from, created_by, approved_by, created_at, version; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK sod_chk, freshness_chk | Đặc tả M1; quy ước RLS của 04 |
| bảng data_contract_version | thêm cột contract_id, odcs_sha256, odcs_object_key, compatibility, published_by, published_at, supersedes_id, migration_window_until; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE | Đặc tả M1; quy ước RLS của 04 |
| bảng quality_rule_version | thêm cột dimension, field_path, action_on_fail, criticality_weight, created_by, approved_by, created_at; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK sod_chk | Đặc tả M1; quy ước RLS của 04 |
| bảng quality_run | thêm cột dataset_id, trigger, started_at, status, overall_result, score, hard_fail, triggered_by; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK counts_chk | Đặc tả M1; quy ước RLS của 04 |
| bảng quality_exception | thêm cột rule_version_id, incident_id, decision, decided_by, decided_at, waiver_reason, reopened_from_id, created_at, version; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK waive_chk, sod_chk | Đặc tả M1; quy ước RLS của 04 |
| bảng quality_incident | thêm cột title, run_id, assignee_user_id, impact, root_cause, remediation, sla_hours, verified_by, verified_at, reopened_count, created_at, version; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK verify_sod_chk | Đặc tả M1; quy ước RLS của 04 |
| bảng maturity_assessment | thêm cột rubric_version_id, scope_kind, scope_ref, assessor_user_id, overall_level, overall_state, published_by, published_at, created_at, version; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK score_chk, not_computed_chk, sod_chk | Đặc tả M1; quy ước RLS của 04 |
| bảng maturity_evidence | thêm cột assessment_state, assessed_by, assessed_on, sample_size, confidence, reviewer_user_id, evidence_expires_on, na_reason, created_at, version; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK state_level_chk, level_chk, na_chk, sod_chk | Đặc tả M1; quy ước RLS của 04 |
| GET /resources/quality_incident, /resources/quality_incident/{id} | thêm x-exposure=dto, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/maturity_assessment, /resources/maturity_assessment/{id} | thêm x-exposure=keep, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/dataset_contract, /resources/dataset_contract/{id} | thêm x-exposure=keep, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/quality_rule_version, /resources/quality_rule_version/{id} | thêm x-exposure=keep, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/quality_run, /resources/quality_run/{id} | thêm x-exposure=dto, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/quality_exception, /resources/quality_exception/{id} | thêm x-exposure=dto, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/maturity_evidence, /resources/maturity_evidence/{id} | thêm x-exposure=dto, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| DGV-01 / BL-DGV-01 / trace FR-DGV-01 | fields: +Huy hiệu (NOT_ASSESSED/PASSED/WARNING/FAILED/STALE); Incident quá SLA; rule: nối thêm "Chưa có lần chạy = NOT_ASSESSED (không hiển thị 0 hay đạt)."; test_ids (backlog, trace): +UAT-AC486 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-02 / BL-DGV-02 / trace FR-DGV-02 | fields: +Trạng thái MDM (PUBLISHED/DEPRECATED); Dataset gắn; rule: nối thêm "Nguồn thuật ngữ duy nhất là MDM glossary_term; duyệt qua workflow MDM; DGV chỉ gắn thuật ngữ PUBLISHED."; test_ids (backlog, trace): +UAT-AC490 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-03 / BL-DGV-03 / trace FR-DGV-03 | fields: +Dữ liệu trọng yếu; rule: nối thêm "Dataset trọng yếu: owner khác steward."; test_ids (backlog, trace): +UAT-AC483 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-04 / BL-DGV-04 / trace FR-DGV-04 | fields: +Hợp đồng hiện hành; Owner/steward; Huy hiệu; rule: nối thêm "Tìm kiếm lọc tenant + quyền + phân loại; dataset ngoài quyền không lộ cả số đếm."; test_ids (backlog, trace): +UAT-AC55 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-05 / BL-DGV-05 / trace FR-DGV-05 | fields: +Run id; Phiên bản transform; Nút bị hạn chế; rule: nối thêm "Nút ngoài quyền hiển thị ẩn danh "bị hạn chế"."; test_ids (backlog, trace): +UAT-AC52, UAT-AC55 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-06 / BL-DGV-06 / trace FR-DGV-06 | fields: +Chiều chất lượng; Trọng số trọng yếu; Người duyệt; rule: nối thêm "Quy tắc dùng AST allowlist; người duyệt khác người soạn."; test_ids (backlog, trace): +UAT-AC484 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-07 / BL-DGV-07 / trace FR-DGV-07 | fields: +Lần chạy; Integrity (cross-tenant/orphan); rule: nối thêm "Một lỗi integrity hoặc sai tổng trọng yếu là hard fail dù điểm trung bình cao."; test_ids (backlog, trace): +UAT-AC485 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-08 / BL-DGV-08 / trace FR-DGV-08 | fields: +Assignee; Nguyên nhân; Khắc phục; Người xác minh; rule: nối thêm "Incident có assignee, SLA theo mức độ; đóng bởi người khác assignee sau lần chạy lại đạt."; test_ids (backlog, trace): +UAT-AC487 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-09 / BL-DGV-09 / trace FR-DGV-09 | fields: +Basis; Dung sai; Phân loại chênh lệch; rule: nối thêm "Chênh lệch phân loại missing/timing/reversal/mapping/amount, không tự lấy bên lớn hơn."; test_ids (backlog, trace): +UAT-AC488 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-10 / BL-DGV-10 / trace FR-DGV-10 | rule: nối thêm "Merge/unmerge do MDM thực hiện; DGV chỉ hiển thị ứng viên và tác động." | Làm rõ ranh giới DGV/MDM |
| DGV-11 / BL-DGV-11 / trace FR-DGV-11 | rule: nối thêm "Retention/legal hold dùng ADM data_retention_policy/legal_hold và DOC doc_retention_rule; DGV hiển thị theo dataset." | Làm rõ nguồn sự thật retention |
| DGV-12 / BL-DGV-12 / trace FR-DGV-12 | rule: nối thêm "Duyệt sửa dữ liệu trọng yếu đi qua command của module sở hữu dữ liệu (maker ≠ checker); DGV không ghi dữ liệu nghiệp vụ." | Làm rõ ranh giới DGV |
| DGV-13 / BL-DGV-13 / trace FR-DGV-13 | fields: +Phiên bản ODCS; Băm bản phát hành; Chấp thuận consumer; rule: nối thêm "Breaking change bị chặn khi còn consumer chưa chấp thuận."; test_ids (backlog, trace): +UAT-AC50 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-14 / BL-DGV-14 / trace FR-DGV-14 | fields: +Mapping đã xác nhận (D04); rule: nối thêm "Pipeline chỉ dùng mapping CONFIRMED; quarantine không vào báo cáo chính thức."; test_ids (backlog, trace): +UAT-AC51, UAT-AC491 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-15 / BL-DGV-15 / trace FR-DGV-15 | fields: +Phân loại 5 mức (gồm IMPORTANT_CORE); rule: nối thêm "Phân loại dataset là nguồn cho định tuyến AI (LLM) và chính sách BI."; test_ids (backlog, trace): +UAT-AC55 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-16 / BL-DGV-16 / trace FR-DGV-16 | fields: +Trạng thái đánh giá (ASSESSED/NOT_ASSESSED/NOT_APPLICABLE); Coverage; Người review; rule: nối thêm "Thiếu bằng chứng = NOT_ASSESSED, không tính vào trung bình; điểm tổng chỉ khi coverage ≥ ngưỡng rubric."; test_ids (backlog, trace): +UAT-AC53, UAT-AC492 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-17 / BL-DGV-17 / trace FR-DGV-17 | fields: +Trạng thái mốc; rule: nối thêm "Mốc ACHIEVED cần kỳ đánh giá đã công bố chứng minh mức mục tiêu."; test_ids (backlog, trace): +UAT-AC494 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| DGV-18 / BL-DGV-18 / trace FR-DGV-18 | fields: +Hạn chứng nhận; Người chứng nhận; rule: nối thêm "Chứng nhận cần hợp đồng đã phát hành + chất lượng PASSED + người khác owner."; test_ids (backlog, trace): +UAT-AC495 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| UAT-AC50 | setup/steps: template 3 bước → cụ thể; expected: "schema breaking change bị chặn nếu consumer chưa chấp thuận." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-DGV-13, FR-DGV-19 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC51 | setup/steps: template 3 bước → cụ thể; expected: "quarantine record không đi vào metric certified; dashboard thể hiện phần bị loại." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-DGV-14, FR-BI-14 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC52 | setup/steps: template 3 bước → cụ thể; expected: "từ KPI truy được metric version, snapshot, transform và record nguồn đúng quyền." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-DGV-05, FR-BI-14 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC53 | setup/steps: template 3 bước → cụ thể; expected: "maturity thiếu evidence hiển thị NotAssessed và không tạo điểm tổng sai." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-DGV-16, FR-DGV-21 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC54 | setup/steps: template 3 bước → cụ thể; expected: "waiver hết hạn tự mở lại issue theo policy, có audit." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-DGV-08, FR-DGV-06 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC55 | setup/steps: template 3 bước → cụ thể; expected: "RLS/masking vẫn áp dụng với catalog search, lineage, quality evidence và export." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-DGV-04, FR-DGV-05, FR-DGV-15 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
