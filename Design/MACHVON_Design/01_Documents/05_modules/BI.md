# BI — BI động, chỉ tiêu là mã có phiên bản và drill có kiểm quyền

Phiên bản đặc tả M1 · 22/10/2026 · Nguồn dữ liệu máy: `work/staging/intelligence.json` (bảng sửa `metric_definition`, `dashboard_version`, `drill_context`; bảng mới `dashboard`, `dashboard_share`, `bi_dataset`, `bi_dataset_version`, `bi_access_policy`, `bi_query_run`, `bi_export_job`, `bi_export_schedule`, `bi_publication_request`, `bi_metric_sync_run`). Quy ước chung theo `04_Thiet_ke_co_ban.md` (Kiến trúc BI và drill down) và `05_Thiet_ke_chi_tiet.md` (DrillContext và query security). Baseline giữ nguyên: BI-01…BI-14, FRD UC10 (AC31–AC35), lệnh `post_dashboard_queries`, `post_dashboards_id_publish`, test BI01/BI02.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Lãnh đạo và chuyên viên cần dashboard tự dựng cho mọi chỉ tiêu (giải ngân, vốn, thanh toán, AI, thông báo, thuê bao), nhưng một số liệu chỉ đáng tin khi (a) định nghĩa rõ và có phiên bản, (b) gắn kỳ và ảnh chụp dữ liệu cụ thể, (c) tôn trọng quyền đọc của từng người kể cả khi drill hay xuất, (d) tỷ lệ được tính từ tử/mẫu chứ không cộng tỷ lệ. HOME dùng snapshot DIS cho trung tâm điều hành; BI là lớp ngữ nghĩa và công cụ phân tích dùng chung, chia sẻ **thư viện ký DrillContext** với HOME.

**Trong phạm vi:** chỉ tiêu là mã (định nghĩa nền tảng trong repo `metrics/*.metric.yaml`, review bằng PR + Codex, đồng bộ vào registry bằng CI; chỉ tiêu tenant qua UI) có phiên bản, tử/mẫu số, chính sách null; dataset ngữ nghĩa và ảnh chụp theo kỳ (`as_of_period` + snapshot) dựng từ PeriodSnapshot FROZEN của DIS hoặc fact khác; chính sách truy cập dòng/cột **đóng mặc định**; query compiler allowlist (không SQL tự do); drill có kiểm quyền lại tại đích; dashboard có phiên bản, chia sẻ đối tượng không cấp quyền dữ liệu; phê duyệt chứng nhận/công bố; xuất và lịch phân phối theo phạm vi từng người nhận; nhật ký truy vấn/hiệu năng; lineage tới nguồn; huy hiệu chất lượng từ DGV.

**Ngoài phạm vi:** tính số liệu nghiệp vụ gốc (DIS/CAP/PAY tự chốt); trung tâm điều hành HOME-09/10 (HOME, dùng chung thư viện); kiểm tra chất lượng dữ liệu (DGV); nhập SQL hoặc kết nối nguồn ngoài tùy ý.

**Phụ thuộc:** DIS (`period_snapshot`, `reporting_period`, sự kiện `snapshot.frozen.v1`), DGV (`dataset` catalog, `quality_run`, lineage), MDM (`glossary_term` — nguồn duy nhất cho thuật ngữ gắn chỉ tiêu), IAM/ADM (scope grant, membership hiện tại), NOT (phân phối), kernel (thư viện DrillContext, read replica `machvon_reporting`). Đồ thị: `BI → DGV`; BI ⇠ mọi module (projection).

**Căn cứ.** BRD BR-R06/BR-R10 (không công bố số không rõ grain/định nghĩa/nguồn/độ mới; drill giữ scope và snapshot); D03 (định nghĩa kỳ/YTD cần chủ nghiệp vụ ký — glossary MDM). Thị trường: dbt Semantic Layer/MetricFlow và Cube (metric as code, tử/mẫu số), Power BI RLS (đóng mặc định theo vai trò), Looker (LookML có version, PR review), Atlan/OpenMetadata (lineage).

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Được phép | Bị cấm |
|---|---|---|---|
| Nhà phân tích | Theo `bi_access_policy` ∩ scope grant | `post_dashboard_queries`, `explainBiMetric`, `createDashboard`, `saveDashboardVersion`, `shareDashboard`, `requestBiExport`, `createBiExportSchedule`, `createTenantMetricDefinition` | Truy vấn dataset không có chính sách ACTIVE; nhập SQL; sửa chỉ tiêu PLATFORM_CODE |
| Data owner chỉ tiêu | Domain | `decideBiPublication` (chứng nhận chỉ tiêu, công bố dashboard), duyệt chính sách | Duyệt đề nghị của chính mình |
| Quản trị dữ liệu (BI admin) | Toàn tenant | `createBiAccessPolicy`, `buildBiDatasetVersion`, `listBiQueryRuns` | Kích hoạt chính sách tự soạn; xem dữ liệu ngoài grant nghiệp vụ |
| CI/deploy (service principal) | Nền tảng | `syncMetricRegistry` | Ghi chỉ tiêu tenant |
| Lãnh đạo | Toàn tenant hoặc cây đơn vị | Xem dashboard được chia sẻ/thư viện, drill, xuất | — |
| Auditor | Đọc theo scope | Lineage, nhật ký, xuất có watermark | Command ghi |
| Nhà thầu (guest) | Hợp đồng | Không truy cập BI (404) | — |

Quyền dữ liệu hiệu lực = tenant RLS ∩ scope grant hiện tại ∩ `bi_access_policy` ACTIVE cho dataset ∩ classification. Chia sẻ dashboard chỉ cấp quyền với **đối tượng** dashboard.

## 3. Luồng nghiệp vụ

**F1 — Chỉ tiêu là mã (BI-05, BI-06, BI-15).** Chỉ tiêu nền tảng viết trong repo (YAML: `code`, `grain`, `aggregation_type` ∈ additive|semi_additive|ratio|distinct, `expression` AST, `numerator`/`denominator`, `dimensions`, `unit`, `null_policy`, `glossary_term`, `effective_from`), review bằng PR (Codex + data owner). Pipeline deploy gọi `syncMetricRegistry(commit, bundle_sha256)`: kiểm schema, so khác với registry, tạo revision mới bất biến `origin = PLATFORM_CODE`; cùng băm gói → NO_CHANGE; đổi nghĩa (grain, mẫu số, đơn vị) mà giữ `code` không có `effective_from` mới → `BREAKING_CHANGE_WITHOUT_NEW_CODE`. Chỉ tiêu tenant (`TENANT_UI`) soạn qua BI-06 rồi chứng nhận qua F5.

**F2 — Dataset và snapshot (BI-07, BI-18).** Khi DIS phát `snapshot.frozen.v1`, consumer dựng `bi_dataset_version` cho kỳ (`as_of_period`, `source_snapshot_id`), tính `checksum_sha256`, gắn `quality_run_id` mới nhất của DGV (không có → `NOT_ASSESSED`), loại dòng quarantine khỏi bản dùng cho chỉ tiêu certified (`excluded_quarantine_rows`). Dựng lại tạo bản mới, bản cũ SUPERSEDED nhưng vẫn phục vụ drill đang mở.

**F3 — Truy vấn (BI-02, BI-04, BI-09).** Baseline `POST /dashboard-queries` nhận **chỉ** id chỉ tiêu/chiều, bộ lọc AST, `as_of_period` (bắt buộc) và `snapshot_id` tùy chọn (mặc định bản FROZEN mới nhất của kỳ). Server: (1) tính quyền hiệu lực; không có chính sách ACTIVE → 403 `ACCESS_POLICY_MISSING`; (2) compiler tạo SQL tham số hóa trên read replica với join allowlist, tenant filter ở mọi bảng, `row_predicate_ast` AND scope; (3) ratio trả `numerator`, `denominator`, giá trị = Σ tử/Σ mẫu; mẫu 0 → `null_reason = NOT_APPLICABLE`; thiếu dữ liệu → `NO_DATA` (không 0); (4) mỗi phản hồi có `as_of_period`, `snapshot_id`, `scope_hash`, `quality_badge`, `served_from_cache`, `built_at`, `drill_token`; (5) ghi `bi_query_run`. Truy vấn vượt ngưỡng chi phí/thời gian → 202 job (ASYNC_JOB). Quota theo tenant chặn noisy neighbor (429 `RATE_LIMIT`).

**F4 — Drill (BI-09, BI-14).** `explainBiMetric(drill_token, child_dimension)`: thư viện DrillContext (kernel, dùng chung với HOME) kiểm chữ ký HMAC-SHA256 khóa theo tenant (`kid` để xoay khóa), TTL 30 phút, tenant khớp phiên; tải `drill_context` server-side; kiểm membership **hiện tại** và lấy scope = scope cũ ∩ scope hiện tại (thu hồi có hiệu lực ngay → 403 `SCOPE_DENIED` không lộ tên); giữ nguyên `snapshot_id`; trả children với `reconciles_to_parent` hoặc `non_additive_reason`; nhóm "Chưa phân loại" bảo đảm Σ con = cha cho additive. Hết hạn → 409 `SNAPSHOT_EXPIRED` (UI làm mới token cùng snapshot). `refreshBiQueryContext` tạo context mới trên snapshot mới nhất, `parent_context_id` trỏ context cũ.

**F5 — Chứng nhận và công bố (BI-03, BI-10, BI-11).** `submitBiPublication` chạy kiểm: công thức hợp lệ, chạy lại trên snapshot gần nhất cho cùng kết quả (tái tạo), chỉ tiêu trong dashboard đều CERTIFIED, chính sách không nới scope ngoài grant. `decideBiPublication` (≠ người đề nghị): METRIC → CERTIFIED; DASHBOARD → baseline `POST /dashboards/{id}/publish`; ACCESS_POLICY → ACTIVE. Revision đã PUBLISHED bất biến.

**F6 — Chia sẻ (BI-01, BI-17).** `shareDashboard` cấp VIEW/EDIT đối tượng; người nhận thấy layout nhưng số liệu theo quyền của chính họ (AC35). Thu hồi có hiệu lực ngay.

**F7 — Xuất và lịch (BI-12, BI-16).** `requestBiExport`: kiểm quyền khi tạo và **lại khi chạy**; tệp có đầu trang ghi phạm vi (`scope_description`), kỳ, snapshot, phiên bản chỉ tiêu, thời điểm; cột bị mask không xuất; trần 100.000 dòng [GIẢ ĐỊNH]; URL tải ≤ 300 giây và kiểm quyền lại khi cấp. Lịch: mỗi lần chạy tạo một job **cho từng người nhận** dưới phạm vi của họ; `LINK_ONLY` gửi liên kết yêu cầu đăng nhập; người nhận mất quyền → job DENIED.
**F8 — Chứng nhận chỉ tiêu và bộ dữ liệu (G3-1; BI-19).** Hai loại đối tượng mới đi qua cùng bốn trạng thái: chỉ tiêu của sổ KPI (khóa = mã, phiên bản = phiên bản quy tắc `KPI_DEFINITION`) và bộ dữ liệu (khóa = mã định danh bộ dữ liệu, phiên bản = phiên bản định nghĩa của nó). Nháp → Đã xác nhận (một người) → Đã chứng nhận (một người KHÁC, 403 `SELF_APPROVAL_DENIED`; ràng buộc cả trong mã lẫn trong bảng) → Lỗi thời; từ Đã xác nhận có thể trả về Nháp; trả về Nháp và đánh dấu Lỗi thời cần lý do ≥ 5 ký tự; nhảy bước là 409 `STAGE_TRANSITION_DENIED`; chỉ phiên bản đang hiệu lực mới được chứng nhận (phiên bản của bộ dữ liệu đổi thì chứng nhận cũ hết hiệu lực và màn hình nêu số phiên bản đã chứng nhận trước đó); phiên bản mặc định tích hợp của chỉ tiêu (v0) được chứng nhận bằng rà soát mã nguồn và không đi qua đây. Metric của registry giữ chứng nhận sẵn có của nó (đề nghị phát hành do người khác quyết, F5): danh sách đọc chúng bằng cùng bốn chữ (DRAFT, IN_REVIEW = Đã xác nhận, CERTIFIED, SUPERSEDED và RETIRED = Lỗi thời) và không chứng nhận thêm lần hai. Dashboard của lãnh đạo và trung tâm điều hành (HOME) chỉ dùng số của định nghĩa đã chứng nhận; số làm từ bộ dữ liệu chưa chứng nhận mang cờ chất lượng ngay trên con số, và không có dữ liệu thì không bao giờ là 0.

**F9 — Sổ KPI và nút "i" (G0-4; BI-20).** Mỗi chỉ tiêu một định nghĩa (tên, công thức bằng lời, tử số, mẫu số, khoản loại trừ, kỳ, nguồn, chủ sở hữu, độ trễ cho phép, mã ngưỡng RAG, số chữ số thập phân) là quy tắc `KPI_DEFINITION` có phiên bản của kho `governance_rule` (người soạn khác người duyệt); `getKpiRegister` liệt kê cùng chứng nhận. Con số trên BI-09 và HOME mang nút "i" mở định nghĩa, nguồn, ngày số liệu, chủ sở hữu, phiên bản; web, điện thoại và tệp Excel dùng cùng định nghĩa và cùng chữ số (`display_value`), có kiểm tra đối chiếu trong bộ kiểm thử.


## 4. State machine

```
metric_definition (giá trị status baseline giữ; bổ sung): DRAFT ─submit─► IN_REVIEW ─approve─► CERTIFIED ─(revision mới)─► SUPERSEDED ; CERTIFIED ─retire─► RETIRED
dashboard_version: DRAFT ─publication approved─► PUBLISHED ─(revision mới published)─► SUPERSEDED
bi_dataset_version: BUILDING ─► FROZEN ─(dựng lại)─► SUPERSEDED ; BUILDING ─► FAILED
bi_access_policy: DRAFT ─publication approved─► ACTIVE ─► RETIRED
bi_publication_request: PENDING ─decide─► DECIDED ; PENDING ─► WITHDRAWN
bi_export_job: QUEUED ─► RUNNING ─► READY ─(7 ngày)─► EXPIRED ; RUNNING ─► DENIED | FAILED
```

| Từ | Command | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|
| (mới) | `syncMetricRegistry` | PLATFORM_CODE CERTIFIED | CI | băm gói khớp; schema hợp lệ; không breaking giữ mã | `bi.metric_registry.synced.v1` |
| DRAFT/IN_REVIEW | `decideBiPublication` APPROVED (METRIC) | CERTIFIED | data owner ≠ người đề nghị | tái tạo đạt | `bi.publication.decided.v1` |
| DRAFT (dashboard_version) | `decideBiPublication` → publish baseline | PUBLISHED | data owner | chỉ tiêu CERTIFIED; dataset FROZEN | `bi.dashboard.published.v1` |
| DRAFT (policy) | `decideBiPublication` | ACTIVE | data owner ≠ người soạn | không nới scope | `bi.policy.activated.v1` |
| BUILDING | (system) | FROZEN | consumer | snapshot nguồn FROZEN; checksum | `bi.dataset_version.frozen.v1` |

Cấm: sửa revision CERTIFIED/PUBLISHED/FROZEN (409 `VERSION_IMMUTABLE`); dùng chỉ tiêu chưa CERTIFIED trong dashboard công bố; truy vấn không có `as_of_period` (400); drill đổi snapshot ngầm.

## 5. Quy tắc nghiệp vụ và công thức

- **BR-BI-01** Mọi truy vấn có `as_of_period` + `snapshot_id`; không hiển thị số không có as-of (BR-R06).
- **BR-BI-02** Additive: Σ con + "Chưa phân loại" = cha (cùng scope); ratio: `Σ numerator / Σ denominator` (numeric, làm tròn chỉ khi hiển thị, 2 chữ số %); semi-additive (số dư, lũy kế): lấy giá trị tại snapshot cuối phù hợp as-of, không SUM theo thời gian; distinct: không cộng, gắn `non_additive_reason`.
- **BR-BI-03 (null — theo CR-DGM-01 của tài liệu 08):** `NO_DATA` = không có dữ liệu nguồn để xác định giá trị (nhãn "Chưa có dữ liệu"); `NOT_APPLICABLE` = mẫu số 0/không áp dụng (nhãn "Chưa có cơ sở tính", cùng nhãn DIS); `RESTRICTED` = có dữ liệu nhưng ngoài quyền (chỉ ở mức tổng có nhãn, không lộ con); `NOT_YET_REPORTED` = kỳ chưa đến hạn. Không quy đổi về 0 (`null_policy = NULL_NOT_ZERO` mặc định). `NOT_ASSESSED` chỉ dùng cho huy hiệu chất lượng/trưởng thành; `UNKNOWN` dành riêng cho kết quả giao tin (NOT) và lệnh mobile (MOB).
- **BR-BI-04 (huy hiệu chất lượng):** `NOT_ASSESSED` khi dataset version chưa có `quality_run` (không phải lỗi, không phải đạt); `PASSED`/`WARNING`/`FAILED` theo kết quả DGV; `STALE` khi tuổi dữ liệu vượt `freshness_seconds` của contract.
- **BR-BI-05 (đóng mặc định):** không có `bi_access_policy` ACTIVE áp dụng cho người gọi trên dataset → 403 `ACCESS_POLICY_MISSING` (không trả tập rỗng); predicate luôn AND với tenant + scope grant; chính sách không được nới scope ngoài grant (`POLICY_WIDENS_SCOPE`).
- **BR-BI-06 (drill token):** HMAC-SHA256 với khóa per-tenant (`kid`), payload không PII: `{v, tid, ctx_id, scope_hash, metric_version_id, snapshot_id, as_of_period, iat, exp}`; TTL 30 phút; mỗi bước kiểm membership hiện tại; dùng chung thư viện `kernel/drill-context` với HOME (BR-HOME-08).
- **BR-BI-07** Cache khóa `t:{tenant}:bi:{metric_versions}:{filters_hash}:{snapshot_id}:{scope_hash}`; không chia sẻ cache giữa scope khác nhau; phản hồi luôn có `served_from_cache` + `built_at`.
- **BR-BI-08** Chỉ tiêu nền tảng chỉ đổi qua mã (PR + CI); tenant không sửa; tenant có thể tạo chỉ tiêu riêng với `code` không trùng không gian nền tảng (tiền tố `t_`).
- **BR-BI-09** Xuất: kiểm quyền 3 lần (tạo, chạy, cấp URL); watermark phạm vi; trần dòng; phân loại CONFIDENTIAL chỉ xuất được khi chính sách cho phép (`CLASSIFICATION_EXPORT_DENIED`); PERSONAL không xuất ở mức chi tiết.
- **BR-BI-10** Hiệu năng: dashboard toàn tỉnh đọc snapshot/materialized view trên read replica; p95 ≤ 2 s cho truy vấn trong ngân sách (NFR-PERFORMANCE-03); vượt ngưỡng → job bất đồng bộ.
- **BR-BI-11 (sổ đăng ký dataset, nền phân tích hợp đồng CA-1)** Dataset không còn gắn cứng `DS-DISB`: mỗi dataset là một bộ chuyển đổi (`DatasetAdapter` trong `packages/kernel/src/bi-query.ts`: mã, loại nguồn, hạt, các trường chỉ tiêu được đọc, các chiều được cắt, trường định danh, khả năng) và một bộ đọc nguồn (`QuerySource` trong `packages/db/src/bi-query-source.ts`). Bộ lập truy vấn, engine, kho truy vấn và kiểm tra xuất bản lấy danh sách cho phép từ bộ chuyển đổi của dataset mà bản chốt thuộc về. Loại nguồn chưa có bộ đọc trả 422 `DATASET_SOURCE_UNAVAILABLE`. Kết quả của `DS-DISB` không đổi.
- **BR-BI-12 (gộp hai tầng và chuỗi nhiều kỳ — R16)** Chỉ tiêu tỷ lệ có thể là phép gộp hai tầng: tầng một nhóm các dòng theo chiều của truy vấn và cộng một trường; tầng hai đọc các nhóm (`sum`, `sum_of_squares`, `top_n_sum`, bình phương tổng). Top N / tổng và HHI (= Σ bình phương / bình phương tổng × 10000) là hai cặp được phép. Kiểm thử đối chiếu theo loại chỉ tiêu: cộng được thì tổng = Σ dòng; tập trung thì tính lại từ dòng gốc. Chuỗi nhiều kỳ đọc phiên bản đóng băng của từng kỳ.
- **BR-BI-13 (dataset `DS-CTR`, CA-1 phần 2)** `DS-CTR` (loại nguồn `CONTRACT_FACT`, nhà sản xuất CTR) có hạt là **một hợp đồng cho mỗi bên đang hoạt động** của hợp đồng. Nguồn là các dòng `contract_fact_snapshot_line` của bản chốt dữ liệu hợp đồng đi cùng bản chốt kỳ của DIS; phiên bản của dataset lấy mã bản chốt DIS làm `source_snapshot_id`, số dòng và băm của bản chốt dữ liệu hợp đồng, và ở trạng thái `NOT_ASSESSED` cho đến khi có bộ quy tắc chất lượng của nhà sản xuất CTR. Tiền của hợp đồng đã được chia cho các bên theo `share_pct` bằng phần dư lớn nhất (đồng nguyên), nên mọi tổng trên dataset là đồng nguyên và các nhóm của mọi chiều cộng đúng bằng tổng; `SINGLE_BIDDER`, `BIDDER_KNOWN`, `DAYS_LATE` chỉ có trên dòng của bên đứng đầu. Trường: `CONTRACT_VALUE, ACTIVE_VALUE, ORIGINAL_VALUE, APPROVED_CHANGE_DELTA, WINNING_BID, BID_VARIANCE, REQUESTED, ACCEPTED, PAID, ADVANCE_PAID, ADVANCE_RECOVERED, ADVANCE_OUTSTANDING, RETENTION_WITHHELD, RETENTION_RELEASED, RETENTION_HELD, GUARANTEE_REQUIRED, GUARANTEE_VALID, SINGLE_BIDDER, BIDDER_KNOWN, DAYS_LATE, CONTRACT, CONTRACTOR`; chiều: `unit, project, fund_source, investor, contractor, contract_status, contract_type`. Mười bốn chỉ tiêu `metrics/ctr_*.metric.yaml` đọc dataset này. Bản chốt được dựng khi nhận `snapshot.frozen.v1` (consumer `ctr-fact-snapshot`); xu hướng theo kỳ của danh mục hợp đồng là chuỗi BI trên `DS-CTR`, không có điểm cuối riêng.

## 6. Dữ liệu

| Bảng | Trường chính | Ràng buộc | Classification | Retention |
|---|---|---|---|---|
| `metric_definition` (sửa) | + origin, source_commit, definition_sha256, numerator/denominator_ast, null_policy, dimension_codes, dataset_id, glossary_term_id, hiệu lực, chứng nhận | PLATFORM_CODE ⇒ commit + băm; SoD chứng nhận; unique (code, revision) | INTERNAL | Vĩnh viễn |
| `dashboard_version` (sửa) | + breakpoints, dataset_version_policy, pinned ids, published_by/at; FK dashboard_id → `dashboard` | unique (dashboard, revision); SoD | INTERNAL | Vĩnh viễn |
| `drill_context` (sửa) | + as_of_period, dimension_path, unit, currency, parent_context_id; FK metric/snapshot | expires > as_of | INTERNAL | 7 ngày |
| `dashboard`, `dashboard_share` | đối tượng, chia sẻ | unique grant ACTIVE | INTERNAL | Vĩnh viễn |
| `bi_dataset`, `bi_dataset_version` | nguồn, grain, join allowlist; kỳ, snapshot nguồn, checksum, quality | một FROZEN mỗi (dataset, kỳ); quality_run NULL ⇒ NOT_ASSESSED | INTERNAL | 10 năm |
| `bi_access_policy` | predicate, mask, trạng thái | ACTIVE ⇒ đã duyệt, SoD | INTERNAL | Vĩnh viễn |
| `bi_query_run`, `bi_export_job`, `bi_export_schedule` | nhật ký, xuất theo người nhận | READY ⇒ tệp + băm | INTERNAL | 1 năm / tệp 7 ngày |
| `bi_publication_request`, `bi_metric_sync_run` | đề nghị, đồng bộ mã | một PENDING/đối tượng; unique gói APPLIED | INTERNAL | Vĩnh viễn |

- `metric_definition` (sửa): id, code, revision, grain, aggregation_type, expression_ast, unit, owner_id, status, origin, source_commit, definition_sha256, numerator_ast, denominator_ast, null_policy, dimension_codes, dataset_id, glossary_term_id, legal_basis, effective_from, effective_until, supersedes_id, certified_by, certified_at, created_at, created_by, version
- `dashboard_version` (sửa): id, dashboard_id, revision, layout_json, metric_versions, filter_mappings, status, breakpoints, dataset_version_policy, pinned_dataset_version_ids, published_by, published_at, created_by, created_at
- `drill_context` (sửa): id, subject_scope_hash, metric_version_id, snapshot_id, filters_ast, path, as_of, expires_at, as_of_period, dimension_path, unit, currency, parent_context_id, created_by, created_at
- `dashboard` (mới): id, code, title, owner_user_id, current_version_id, audience, status, created_at, created_by, updated_at, updated_by, version
- `dashboard_share` (mới): id, dashboard_id, grantee_kind, grantee_ref_id, permission, status, revoked_at, created_at, created_by, updated_at, updated_by, version
- `bi_dataset` (mới): id, dataset_code, title, source_kind, grain, join_paths, dgv_dataset_id, classification, refresh_policy, owner_user_id, status, created_at, created_by, updated_at, updated_by, version
- `bi_dataset_version` (mới): id, dataset_id, as_of_period, reporting_period_id, source_snapshot_id, built_at, row_count, checksum_sha256, quality_run_id, quality_badge, excluded_quarantine_rows, status, supersedes_id, created_at, created_by, updated_at, updated_by, version
- `bi_access_policy` (mới): id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_at, created_by, updated_at, updated_by, version
- `bi_query_run` (mới): id, requested_by, dashboard_version_id, metric_version_ids, as_of_period, dataset_version_id, scope_hash, drill_context_id, mode, status, served_from_cache, duration_ms, row_count, cost_units, error_code, created_at
- `bi_export_job` (mới): id, requested_by, subject_user_id, schedule_id, query_spec, as_of_period, dataset_version_id, scope_hash, scope_description, format, row_count, row_cap, truncated, file_object_key, file_sha256, status, expires_at, created_at, created_by, updated_at, updated_by, version
- `bi_export_schedule` (mới): id, dashboard_id, query_spec, cron, timezone, format, recipients, status, owner_user_id, created_at, created_by, updated_at, updated_by, version
- `bi_publication_request` (mới): id, object_kind, object_id, requested_by, checks_json, decision, decided_by, decided_at, comment, status, created_at, created_by, updated_at, updated_by, version
- `bi_metric_sync_run` (mới): id, source_commit, bundle_sha256, bundle_object_key, added_count, revised_count, retired_count, status, error_json, triggered_by, created_at

**Bảng chứng nhận (V1810, khối GOV-6).** `analytics_certification` (chỉ thêm, RLS; `machvon_app` không UPDATE/DELETE): loại (KPI, DATASET), khóa, phiên bản, số thứ tự trong phiên bản, trạng thái, người ghi, người xác nhận, ghi chú; CHECK ở cơ sở dữ liệu: người chứng nhận khác người xác nhận, Nháp và Lỗi thời có lý do. Trạng thái hiện tại của một phiên bản là dòng mới nhất của nó; phiên bản chưa có dòng là Nháp. Lệnh chuyển được tuần tự hóa theo đối tượng bằng khóa tư vấn, mỗi lần chuyển có audit `bi.certification_moved` và sự kiện `bi.certification_moved.v1`.

## 7. API / command

| operationId | Method path | x-permission | Request DTO | Lỗi chính | Idem | If-Match |
|---|---|---|---|---|---|---|
| `syncMetricRegistry` | POST /bi/metric-registry-syncs | bi.metric.sync | `BiMetricSync` | BUNDLE_HASH_MISMATCH, METRIC_DEFINITION_INVALID, BREAKING_CHANGE_WITHOUT_NEW_CODE | ✔ | – |
| `createTenantMetricDefinition` | POST /bi/metric-definitions | bi.metric.manage | `BiMetricDraft` | EXPRESSION_NOT_ALLOWED, RATIO_REQUIRES_NUMERATOR_DENOMINATOR, PLATFORM_METRIC_READ_ONLY, DIMENSION_NOT_IN_DATASET | ✔ | – |
| `submitBiPublication` | POST /bi/publication-requests | bi.publish.request | `BiPublicationRequest` | PUBLICATION_ALREADY_PENDING, REPRODUCIBILITY_CHECK_FAILED | ✔ | – |
| `decideBiPublication` | POST /bi/publication-requests/{id}/decision | bi.publish | `BiPublicationDecision` | SELF_APPROVAL_DENIED | ✔ | ✔ |
| `listAnalyticsCertifications` | GET /bi/certifications | bi.admin.read | – | chỉ tiêu, bộ dữ liệu, metric với bốn trạng thái | – |
| `getAnalyticsCertificationLog` | GET /bi/certifications/{subject}/{key}/log | bi.admin.read | `subject` KPI\|DATASET, `key` | nhật ký mọi phiên bản | 422 |
| `transitionAnalyticsCertification` | POST /bi/certifications/transitions | analytics.certify | `AnalyticsCertificationTransition` | kết quả lệnh (trạng thái mới) | STAGE_TRANSITION_DENIED, SELF_APPROVAL_DENIED, VALIDATION_FAILED, RESOURCE_NOT_FOUND |
| `getKpiRegister` | GET /home/kpi-register | home.read | `as_of?` | định nghĩa và chứng nhận | 422 |
| `createDashboard` | POST /bi/dashboards | bi.dashboard.manage | `BiDashboardCreate` | DASHBOARD_CODE_DUPLICATE | ✔ | – |
| `saveDashboardVersion` | POST /bi/dashboards/{id}/versions | bi.dashboard.manage | `BiDashboardVersionDraft` | METRIC_NOT_CERTIFIED, DATASET_VERSION_NOT_FROZEN | ✔ | ✔ |
| `shareDashboard` | POST /bi/dashboards/{id}/shares | bi.dashboard.share | `BiShare` | GRANTEE_OUT_OF_TENANT | ✔ | ✔ |
| `revokeDashboardShare` | POST /bi/dashboard-shares/{id}/revocation | bi.dashboard.share | – | SHARE_STATE_INVALID | ✔ | ✔ |
| `createBiAccessPolicy` | POST /bi/access-policies | bi.policy.manage | `BiAccessPolicyDraft` | PREDICATE_NOT_ALLOWED, POLICY_WIDENS_SCOPE | ✔ | – |
| `buildBiDatasetVersion` | POST /bi/datasets/{id}/versions | bi.dataset.build | `BiDatasetVersionBuild` | SOURCE_SNAPSHOT_NOT_FROZEN, BUILD_ALREADY_RUNNING | ✔ | – |
| `refreshBiQueryContext` | POST /bi/query-contexts/refresh | bi.query | `BiContextRefresh` | DRILL_TOKEN_INVALID, SCOPE_DENIED | ✔ | – |
| `requestBiExport` | POST /bi/exports | bi.export | `BiExportRequest` | ACCESS_POLICY_MISSING, EXPORT_ROW_CAP_EXCEEDED, CLASSIFICATION_EXPORT_DENIED | ✔ | – |
| `createBiExportSchedule` | POST /bi/export-schedules | bi.export.schedule | `BiScheduleCreate` | RECIPIENT_OUT_OF_TENANT, CRON_INVALID | ✔ | – |
| `explainBiMetric` | GET /bi/drill | bi.query | – | DRILL_TOKEN_INVALID, SCOPE_DENIED, SNAPSHOT_EXPIRED | – | – |
| `getBiLineage` | GET /bi/metric-definitions/{id}/lineage | bi.lineage.read | – | – | – | – |
| `listBiQueryRuns` | GET /bi/query-runs | bi.admin.read | – | – | – | – |
| `getBiExport` | GET /bi/exports/{id} | bi.export | – | SCOPE_DENIED, EXPORT_EXPIRED | – | – |

Lệnh baseline giữ nguyên: `post_dashboard_queries` (POST /dashboard-queries, `bi.query`) — hành vi F3, lỗi `ACCESS_POLICY_MISSING`, `DIMENSION_NOT_IN_DATASET`, `FIELD_NOT_ALLOWED`, `SNAPSHOT_NOT_FOUND`; `post_dashboards_id_publish` (POST /dashboards/{id}/publish, `bi.publish`) — chỉ chạy khi `bi_publication_request` APPROVED. **Rà soát GET scaffold:** `metric_definition` giữ (metadata định nghĩa); `dashboard_version` dto (chỉ khi có share/thư viện); `drill_context` không expose (chỉ qua token).

## 8. UI/UX

Giữ BI-01…BI-14 (bổ sung field — CR §13); mới BI-15…BI-18. Component: MetricTile (luôn có as_of + huy hiệu), DrillDrawer (breadcrumb, tử/mẫu, công thức, "Σ con = cha ✔" hoặc lý do), FilterBar + FiscalPeriodPicker (as_of_period bắt buộc), DataTable, ComparePanel (BI-10), QualityBadge, NotificationPreview (lịch phân phối).

| ID | Tên | Kind | Phase | Nền tảng | Trường chính |
|---|---|---|---|---|---|
| BI-01 | Thư viện dashboard | cards | P1 | web | Chủ sở hữu; Vai trò; Công bố; Trạng thái chứng nhận chỉ tiêu |
| BI-02 | Dashboard của tôi | dashboard | P1 | web | Kỳ; Nguồn vốn; Đơn vị; Kỳ dữ liệu (as_of_period); Snapshot; Huy hiệu chất lượng |
| BI-03 | Trình dựng dashboard | builder | P1 | web | Lưới; Widget; Bộ lọc; Thiết bị; Chính sách phiên bản dữ liệu (mới nhất đã chốt/ghim) |
| BI-04 | Trình dựng biểu đồ | chart | P1 | web | Chiều phân tích; Chỉ tiêu; Loại biểu đồ; Định dạng; Tử số/mẫu số |
| BI-05 | Danh mục chỉ tiêu | table | P1 | web | Mã chỉ tiêu; Công thức; Đơn vị; Chủ sở hữu; Nguồn (mã nguồn/tenant); Commit; Thuật ngữ MDM |
| BI-06 | Định nghĩa chỉ tiêu | form | P1 | web | Công thức; Grain; Mẫu số; Null; Phiên bản; Tử số; Chính sách null (thiếu dữ liệu không phải 0); Loại cộng dồn; Hiệu lực |
| BI-07 | Nguồn và mô hình dữ liệu | tree | P1 | web | Nguồn; Bảng; Quan hệ; Lịch làm mới; Join đã duyệt; Catalog DGV |
| BI-08 | Phân quyền dòng và cột | policy | P1 | web | Vai trò; Phạm vi; Cột ẩn; Điều kiện; Trạng thái chính sách; Xem thử dưới vai người dùng |
| BI-09 | Trình phân tích dữ liệu | table | P1 | web | Chiều; Chỉ tiêu; Drill down; Bộ lọc; Kỳ dữ liệu; Snapshot; Σ con = cha; Lý do không cộng được |
| BI-10 | So sánh phiên bản dashboard | compare | P1 | web | Phiên bản cũ; Phiên bản mới; Khác biệt; Khác biệt chỉ tiêu (phiên bản) |
| BI-11 | Phê duyệt công bố | approval | P1 | web | Đối tượng; Phiên bản; Người duyệt; Kết quả kiểm tái tạo; Người đề nghị |
| BI-12 | Lịch xuất và phân phối | calendar | P1 | web | Lịch; Định dạng; Người nhận; Kênh; Phạm vi từng người nhận |
| BI-13 | Nhật ký truy vấn và hiệu năng | list | P1 | web | Truy vấn; Thời gian; Dung lượng; Trạng thái; Kỳ dữ liệu; Từ cache; Bị từ chối |
| BI-14 | Lineage và chất lượng dữ liệu | tree | P1 | web | Chỉ tiêu; Nguồn gốc; Kiểm tra; Độ mới; Lần chạy chất lượng (DGV); Số dòng quarantine bị loại |
| BI-15 | Đăng ký chỉ tiêu từ mã nguồn | table | P1 | web | Commit; Băm gói; Chỉ tiêu thêm; Chỉ tiêu sửa; Chỉ tiêu ngừng; Trạng thái; Lỗi |
| BI-16 | Xuất dữ liệu và phạm vi | list | P1 | web | Truy vấn; Kỳ và snapshot; Mô tả phạm vi; Định dạng; Số dòng/trần; Trạng thái; Tải xuống |
| BI-17 | Chia sẻ dashboard | form | P1 | web | Người/nhóm/đơn vị nhận; Quyền (xem/sửa); Cảnh báo quyền dữ liệu; Thu hồi |
| BI-18 | Bộ dữ liệu và ảnh chụp kỳ | table | P1 | web | Dataset; Kỳ; Snapshot nguồn (DIS); Thời điểm dựng; Số dòng; Huy hiệu chất lượng; Trạng thái |

Trạng thái riêng: "Có dữ liệu mới" (NewDataBanner, không tự đổi số), "Chưa có dữ liệu"/"Chưa có cơ sở tính" (không hiển thị 0), "Chưa đánh giá chất lượng" (NOT_ASSESSED), "Dữ liệu cũ" (STALE), "Theo phạm vi của bạn" (tổng bị giới hạn), "Không có chính sách truy cập" (403 có hướng dẫn liên hệ quản trị). Mobile: không có màn BI riêng; số liệu lãnh đạo qua HOME/MOB-07.

**BI-19 — Chứng nhận chỉ tiêu và bộ dữ liệu (G3-1)** và **BI-20 — Sổ KPI (G0-4).** BI-19: ba nhóm (chỉ tiêu, bộ dữ liệu, metric) với trạng thái bằng chữ Nháp / Đã xác nhận / Đã chứng nhận / Lỗi thời, phiên bản, người xác nhận, người chứng nhận, ngày, ghi chú; chỉ hiện hành động của bước hợp lệ kế tiếp (người đã xác nhận không có "Chứng nhận"); hộp xác nhận có lý do bắt buộc khi trả về Nháp hoặc đánh dấu Lỗi thời; metric chỉ đọc, dẫn tới luồng đề nghị phát hành (BI-11); bộ dữ liệu đổi định nghĩa nêu "cần chứng nhận lại"; nhật ký từng phiên bản; đọc lỗi là lỗi có thử lại, không bao giờ là danh sách rỗng. BI-20: bảng chỉ đọc 12 cột của sổ KPI kèm chi tiết từng dòng; giá trị khởi điểm chưa xác nhận được ghi rõ. BI-09/BI-04 và HOME thêm nút "i" và cờ chất lượng của bộ dữ liệu chưa chứng nhận ngay trên con số. Bảy trạng thái.

## 9. Sự kiện, job, tích hợp, quan sát

Events: `bi.metric_registry.synced.v1`, `bi.metric.drafted.v1`, `bi.publication.requested/decided.v1`, `bi.dashboard.created/version_saved/published/shared/share_revoked.v1`, `bi.policy.drafted/activated.v1`, `bi.dataset_version.frozen.v1 {dataset_id, as_of_period, snapshot_id, quality_badge}`, `bi.export.requested/ready/denied.v1`, `bi.export_schedule.created.v1`. Consumers: `snapshot.frozen.v1` (DIS) → F2; `dgv.quality_run.completed.v1` → cập nhật huy hiệu cho bản mới; `membership.revoked.v1`/`role_grant.revoked.v1` (ADM) → vô hiệu cache scope; `glossary.published.v1` (MDM) → cảnh báo chỉ tiêu liên kết thuật ngữ đổi. Job: `bi.export-schedule-runner` (theo cron, Temporal timer), `bi.export-expiry` (7 ngày), `bi.cache-evict-on-snapshot`. Telemetry: `bi_query_ms` p95 theo dashboard, `bi_access_policy_missing_total`, `bi_drill_denied_total`, `bi_export_denied_total`, `bi_reconcile_mismatch_total` (Σ con ≠ cha cho additive — phải = 0); log không chứa giá trị dữ liệu.

## 10. Kiểm thử

Ma trận: positive (AC31, AC471, AC474), negative (AC472, AC476), boundary (AC32, AC480), đồng thời/idempotency (AC482), bảo mật (AC33, AC35, AC473, AC475, AC479, AC481), hiệu năng (AC477), chất lượng (AC478). Baseline BI01 (NFR-PERFORMANCE-03) và BI02 (NFR-TENANCY-06) giữ nguyên.

| ID | Loại | Ưu tiên | Setup | Input/Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC31 | business | P1 | Dataset DS-DISB, kỳ 2026-10 có snapshot SV-10a (FROZEN, built 2026-11-05) và sau đó SV-10b (FROZEN, built 2026-11-12 do điều chỉnh); người dùng A-ana mở dashboard lúc SV-10a là bản mới nhất. | 1) POST /dashboard-queries {metric: GIAI_NGAN_LUY_KE, dimensions:[unit], as_of_period:"2026-10"} → nhận drill_token 2) Sau khi SV-10b được dựng, đổi chiều sang [funding_source] bằng GET /bi/drill?drill_token=…&child_dimension=funding_source 3) Đổi tiếp sang [project] | Mọi phản hồi trả snapshot_id=SV-10a và as_of_period=2026-10 (không nhảy sang SV-10b); tổng lũy kế theo unit = theo funding_source = theo project = 12.450.000.000 VND; phản hồi kèm cờ new_data_available=true để UI hiện NewDataBanner. | API response + bi_query_run |
| UAT-AC32 | business | P1 | Snapshot SV-10a: 3 đơn vị U1, U2, U3; giải ngân 4, 6, 0 tỷ; kế hoạch 10, 20, 0 tỷ; U4 ngoài scope người xem; dòng "Chưa phân loại" 0,5 tỷ giải ngân. | 1) Truy vấn GIAI_NGAN (additive) theo đơn vị 2) Truy vấn TY_LE_GIAI_NGAN (ratio) theo đơn vị 3) Đọc tổng | Additive: 4 + 6 + 0 + 0,5 (Chưa phân loại) = 10,5 tỷ, reconciles_to_parent=true; ratio tổng = 10,5/30 = 35,00% (tính lại từ Σ tử/Σ mẫu, không phải trung bình 40%/30%), U3 có null_reason=NOT_APPLICABLE (mẫu số 0) hiển thị "Chưa có cơ sở tính" không phải 0%; U4 không xuất hiện và tổng ghi nhãn "theo phạm vi của bạn". | API response |
| UAT-AC33 | business | P1 | A-ana (TNT-A) có drill_token hợp lệ cho context C-1; tenant TNT-B có context C-9. | 1) Sửa payload token đổi ctx id thành C-9 (giữ chữ ký cũ) 2) Dùng token hợp lệ của TNT-B (lấy từ người dùng TNT-B) trong phiên của A-ana 3) Đổi kid trong token sang khóa của TNT-B | Cả ba: 400 DRILL_TOKEN_INVALID (chữ ký/tenant không khớp), không trả dữ liệu hay xác nhận C-9 tồn tại; audit outcome=DENIED với lý do mã hóa; drill_context không đọc được qua GET scaffold (x-exposure internal). | API log + audit |
| UAT-AC34 | business | P1 | Kết quả truy vấn dashboard D-1 kỳ 2026-10 được cache lúc 08:00 từ SV-10a; 09:00 SV-10b FROZEN. | 1) 09:05 mở D-1 2) Bấm "Làm mới dữ liệu" (POST /bi/query-contexts/refresh) 3) Mở lại drill cũ bằng token cũ | Bước 1: served_from_cache=true, built_at=08:00, snapshot SV-10a, banner "Có dữ liệu mới (12/11/2026 09:00)"; bước 2: drill_context mới với snapshot SV-10b, parent_context_id = context cũ; bước 3: token cũ vẫn trả SV-10a (không trộn số) cho tới hết hạn 30 phút, sau đó 409 SNAPSHOT_EXPIRED. | API response + UI |
| UAT-AC35 | business | P1 | Dashboard D-2 của A-lead (scope toàn tenant); chia sẻ VIEW cho A-staff (scope U-BQL1); bi_access_policy của A-staff chỉ cho U-BQL1. | 1) POST /bi/dashboards/{D-2}/shares {grantee_kind:"USER", grantee_ref_id:A-staff, permission:"VIEW"} 2) A-staff mở D-2 3) A-lead thu hồi chia sẻ; A-staff mở lại | A-staff thấy layout D-2 nhưng số liệu chỉ của U-BQL1 (tổng khác tổng của A-lead, ghi nhãn phạm vi); không có dòng nào của đơn vị khác; sau thu hồi: 404 với D-2. | API response |
| UAT-AC471 | integration | P0 | Repo commit c1a2b3c có metrics/disbursement_rate.metric.yaml (ratio, tử GIAI_NGAN, mẫu KE_HOACH_TTG); gói băm B1. | 1) CI gọi POST /bi/metric-registry-syncs {source_commit:"c1a2b3c", bundle_sha256:B1} 2) Gọi lại cùng gói 3) Tenant admin sửa chỉ tiêu PLATFORM_CODE qua POST /bi/metric-definitions cùng code 4) Commit c4 đổi mẫu số nhưng giữ code | APPLIED: revision mới origin=PLATFORM_CODE, source_commit, definition_sha256; gọi lại: NO_CHANGE (không revision mới); tenant sửa: 422 PLATFORM_METRIC_READ_ONLY; đổi nghĩa giữ code: 422 BREAKING_CHANGE_WITHOUT_NEW_CODE (phải tạo code mới hoặc revision có effective_from mới kèm migration). | bi_metric_sync_run + metric_definition |
| UAT-AC472 | domain | P0 | Chỉ tiêu tenant "TL_DUNG_HAN" ratio thiếu denominator_ast; chỉ tiêu có AST chứa node "raw_sql". | 1) POST /bi/metric-definitions thiếu mẫu số 2) POST với node raw_sql 3) Truy vấn chỉ tiêu NULL_NOT_ZERO khi kỳ chưa có dữ liệu | 422 RATIO_REQUIRES_NUMERATOR_DENOMINATOR; 422 EXPRESSION_NOT_ALLOWED; giá trị null với null_reason=NO_DATA hiển thị "Chưa có dữ liệu", không bao giờ 0. | unit test |
| UAT-AC473 | security | P0 | Dataset DS-TREASURY (CONFIDENTIAL) chưa có bi_access_policy ACTIVE nào cho vai trò Chuyên viên; A-staff có quyền bi.query. | 1) A-staff truy vấn DS-TREASURY 2) Tạo chính sách cho vai trò Chuyên viên với row_predicate unit ∈ scope, column_masks {account_no: HIDE}; tự duyệt; người khác duyệt 3) A-staff truy vấn lại | Bước 1: 403 ACCESS_POLICY_MISSING (đóng mặc định, không trả rỗng giả); tự duyệt 403 SELF_APPROVAL_DENIED; sau ACTIVE: chỉ dòng thuộc scope, cột account_no không xuất hiện trong kết quả hay xuất. | API log |
| UAT-AC474 | domain | P1 | Dashboard D-3 revision 2 dùng chỉ tiêu M-7 chưa CERTIFIED. | 1) POST /bi/dashboards/{D-3}/versions với M-7 2) Chứng nhận M-7 rồi lưu và submit publication; người đề nghị tự duyệt 3) Người khác duyệt | 422 METRIC_NOT_CERTIFIED; tự duyệt 403; duyệt → dashboard_version PUBLISHED (publish baseline), revision cũ còn nguyên. | DB |
| UAT-AC475 | security | P0 | Lịch xuất S-1 hằng tuần cho A-lead (toàn tenant) và A-staff (U-BQL1); A-staff bị thu hồi scope U-BQL1 sau khi lịch tạo. | 1) Chạy lịch S-1 2) Đọc 2 bi_export_job và đầu tệp 3) A-staff yêu cầu xuất 150.000 dòng | Hai job riêng (subject_user_id khác nhau); job A-lead READY, đầu tệp ghi "Phạm vi: toàn tỉnh; Kỳ 2026-10; Snapshot SV-10b"; job A-staff DENIED (ACCESS_POLICY_MISSING/SCOPE_DENIED) vì quyền bị thu hồi, không tạo tệp; xuất 150.000 dòng: truncated=false, 422 EXPORT_ROW_CAP_EXCEEDED (trần 100.000). | bi_export_job + tệp |
| UAT-AC476 | security | P1 | Người dùng gửi truy vấn có trường "sql":"select * from payment_request" và dimension không có trong dataset. | 1) POST /dashboard-queries với trường sql 2) POST với dimension "contractor_tax_id" không thuộc DS-DISB | 400 FIELD_NOT_ALLOWED; 422 DIMENSION_NOT_IN_DATASET; không có câu SQL nào sinh ngoài compiler allowlist (log compiler). | API log |
| UAT-AC477 | performance | P1 | Tenant 5.000 dự án, snapshot kỳ đã materialized trên read replica; truy vấn toàn tỉnh 12 chỉ tiêu; truy vấn nặng (theo dự án × tháng × nguồn, 3 năm). | 1) Chạy truy vấn toàn tỉnh 20 lần 2) Chạy truy vấn nặng 3) Mở BI-13 | p95 ≤ 2 s (NFR-PERFORMANCE-03); truy vấn nặng trả 202 job (mode ASYNC_JOB) và thông báo khi xong; BI-13 hiển thị duration, row_count, served_from_cache, không hiển thị giá trị dữ liệu. | bi_query_run + metric |
| UAT-AC478 | integration | P0 | DIS phát snapshot.frozen.v1 cho kỳ 2026-10; DGV chưa có quality_run cho dataset (R1); sau đó DGV chạy QR-1 với 12 dòng quarantine. | 1) Dựng bi_dataset_version tự động 2) Mở dashboard 3) Sau QR-1 dựng lại | Bản 1: quality_badge=NOT_ASSESSED (không phải lỗi, không phải PASSED), excluded_quarantine_rows=0; bản 2: quality_run_id=QR-1, badge theo kết quả, excluded_quarantine_rows=12 và tổng certified không gồm 12 dòng đó; bản 1 SUPERSEDED nhưng drill đang mở vẫn dùng bản 1. | bi_dataset_version + DGV |
| UAT-AC479 | security (cách ly tenant) | P0 | TNT-A và TNT-B cùng có dashboard mã "GIAI-NGAN" và cache truy vấn giống hệt tham số. | 1) A-ana truy vấn 2) B-ana truy vấn cùng tham số 3) B-ana GET /bi/exports/{job của A} | Hai khóa cache khác nhau (t:{tenant}:bi:…:{scope_hash}), B không nhận kết quả của A; export của A: 404. | RLS + cache log |
| UAT-AC480 | domain | P1 | Chỉ tiêu SO_DU_AN_CO_VUONG_MAC (distinct) theo đơn vị; dự án P-9 thuộc 2 đơn vị (đồng chủ trì). | 1) Truy vấn theo đơn vị 2) Đọc tổng | Mỗi đơn vị đếm P-9; tổng toàn tỉnh đếm 1 lần; reconciles_to_parent=false với non_additive_reason="distinct count, nhóm chồng lấn". | API response |
| UAT-AC481 | security | P0 | A-staff mở drill lúc 10:00 với scope U-BQL1 + U-BQL2; 10:05 ADM thu hồi U-BQL2. | 1) 10:06 drill vào U-BQL2 bằng token cũ 2) 10:06 drill vào U-BQL1 | U-BQL2: 403 SCOPE_DENIED, không lộ tên dự án; U-BQL1: 200 với cùng snapshot; scope tính = scope cũ ∩ membership hiện tại (thư viện chung với HOME). | API log |
| UAT-AC482 | integration (idempotency) | P1 | snapshot.frozen.v1 cho kỳ 2026-10 đến hai lần. | 1) Consumer nhận lần 1 và lần 2 2) Gọi buildBiDatasetVersion thủ công khi bản đang BUILDING | Một bản FROZEN duy nhất cho (DS-DISB, 2026-10) (unique một phần); lần 2 bị inbox bỏ qua; build thủ công: 409 BUILD_ALREADY_RUNNING. | DB |

## 11. Tiêu chí nghiệm thu

- **AC-BI-01** (FRD AC31) Đổi chiều không đổi snapshot. → UAT-AC31
- **AC-BI-02** (FRD AC32) Nhóm con cộng lại tổng với additive cùng scope; ratio tính lại từ tử/mẫu. → UAT-AC32, UAT-AC480
- **AC-BI-03** (FRD AC33) Người tenant A không thể sửa drill token để xem B. → UAT-AC33, UAT-AC479
- **AC-BI-04** (FRD AC34) Cache cũ được phân biệt; làm mới tạo context mới có thông báo. → UAT-AC34
- **AC-BI-05** (FRD AC35) Chia sẻ dashboard không cấp quyền dữ liệu. → UAT-AC35
- **AC-BI-06** Given chỉ tiêu nền tảng, Then chỉ đổi qua mã và CI; gói trùng không tạo revision. → UAT-AC471
- **AC-BI-07** Given dataset không có chính sách ACTIVE, Then truy vấn bị 403 thay vì trả rỗng. → UAT-AC473
- **AC-BI-08** Given lịch xuất nhiều người nhận, Then mỗi người nhận dữ liệu theo phạm vi của mình và mất quyền thì không nhận. → UAT-AC475
- **AC-BI-09** Given quyền bị thu hồi giữa phiên, Then drill tới phần bị thu hồi bị 403 ngay. → UAT-AC481
- **AC-BI-10** Given chưa có kết quả DGV, Then huy hiệu NOT_ASSESSED; dòng quarantine không vào số certified. → UAT-AC478
- **AC-BI-11** (G3-1) Given bộ dữ liệu hoặc chỉ tiêu ở Nháp, Then HOME và dashboard lãnh đạo không đưa số (cờ NOT_CERTIFIED, không 0); người xác nhận không tự chứng nhận; định nghĩa đổi thì phải chứng nhận lại. → UAT-HOME-G04 (`apps/api/test/home/analytics-governance.test.ts`)
- **AC-BI-12** (G0-4) Given sổ KPI, Then mỗi con số có "i" với công thức, nguồn, giờ cập nhật; web, điện thoại, Excel cho cùng chữ số. → UAT-HOME-G04b

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1:** thư viện DrillContext dùng chung (cùng HOME), F2 cho dataset giải ngân từ PeriodSnapshot, F3/F4 trên chỉ tiêu nền tảng (metric as code + sync CI), chính sách đóng mặc định với chính sách mẫu theo vai trò, BI-02, BI-05, BI-06, BI-08, BI-09, BI-15, BI-18. **R2:** trình dựng dashboard/biểu đồ (BI-03/04), chia sẻ (BI-17), công bố (BI-11), xuất + lịch (BI-12/16), BI-13, BI-14 với DGV, dataset AI/thông báo/thuê bao. **R3:** chỉ tiêu tenant tự dựng nâng cao, nhúng dashboard công khai (OC4IDS qua MNE).
**Giờ review người:** định nghĩa chỉ tiêu và mẫu số với Chủ nghiệp vụ vốn (D03, 4 h); quyền/rò rỉ scope drill + xuất (Security, 4 h); hiệu năng snapshot (Platform, 2 h). Tổng ≈ 10 h.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| D03: định nghĩa kỳ/YTD/PTD và hai mẫu số giải ngân (glossary MDM) | Chủ nghiệp vụ vốn | Thuật ngữ PUBLISHED; chỉ tiêu nền tảng tham chiếu glossary |
| Cross-module: HOME + BI dùng chung thư viện `kernel/drill-context` (ký, TTL, giao scope) | Kernel owner + HOME owner | Một thư viện, một bộ test (UAT-AC33, UAT-AC267) |
| Cross-module: DIS phát `snapshot.frozen.v1` có `reporting_period_id`, `as_of_period` | DIS owner | Đã có trong DIS; xác nhận payload |
| Cross-module: DGV phát `dgv.quality_run.completed.v1` theo dataset version | DGV (cùng nhóm) | Đã đặc tả ở DGV |
| Trần xuất 100.000 dòng, ngưỡng job bất đồng bộ [GIẢ ĐỊNH] | Platform + PO | Đo ở D09 |
| Quy mô dữ liệu toàn tỉnh chưa rõ (D09) | PO | Hồ sơ năng lực pilot |

**Thay đổi bản ghi baseline (CR, baseline-first):**

| Bản ghi baseline | Thay đổi (cũ → mới) | Lý do |
|---|---|---|
| bảng metric_definition | thêm cột origin, source_commit, definition_sha256, numerator_ast, denominator_ast, null_policy, dimension_codes, dataset_id, glossary_term_id, legal_basis, effective_from, effective_until, supersedes_id, certified_by, certified_at, created_at, created_by, version; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK code_origin_chk, cert_sod_chk, range_chk | Đặc tả M1; quy ước RLS của 04 |
| bảng dashboard_version | thêm cột breakpoints, dataset_version_policy, pinned_dataset_version_ids, published_by, published_at, created_by, created_at; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK sod_chk | Đặc tả M1; quy ước RLS của 04 |
| bảng drill_context | thêm cột as_of_period, dimension_path, unit, currency, parent_context_id, created_by, created_at; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK expiry_chk | Đặc tả M1; quy ước RLS của 04 |
| GET /resources/metric_definition, /resources/metric_definition/{id} | thêm x-exposure=keep, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/dashboard_version, /resources/dashboard_version/{id} | thêm x-exposure=dto, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/drill_context, /resources/drill_context/{id} | thêm x-exposure=internal, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| BI-01 / BL-BI-01 / trace FR-BI-01 | fields: +Trạng thái chứng nhận chỉ tiêu; rule: nối thêm "Thư viện chỉ hiện dashboard được chia sẻ hoặc thuộc thư viện tenant; chia sẻ không cấp quyền dữ liệu."; test_ids (backlog, trace): +UAT-AC35 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-02 / BL-BI-02 / trace FR-BI-02 | fields: +Kỳ dữ liệu (as_of_period); Snapshot; Huy hiệu chất lượng; rule: nối thêm "Mọi ô số có as_of_period + snapshot; giá trị thiếu hiển thị "Chưa có dữ liệu" (NO_DATA), không hiển thị 0; NotAssessed chỉ dùng cho huy hiệu chất lượng (CR-DGM-01)."; test_ids (backlog, trace): +UAT-AC31, UAT-AC34 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-03 / BL-BI-03 / trace FR-BI-03 | fields: +Chính sách phiên bản dữ liệu (mới nhất đã chốt/ghim); rule: nối thêm "Chỉ dùng chỉ tiêu CERTIFIED; lưu tạo revision mới."; test_ids (backlog, trace): +UAT-AC474 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-04 / BL-BI-04 / trace FR-BI-04 | fields: +Tử số/mẫu số; rule: nối thêm "Chỉ tiêu tỷ lệ hiển thị tử và mẫu; không cộng/trung bình tỷ lệ từng hàng."; test_ids (backlog, trace): +UAT-AC32 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-05 / BL-BI-05 / trace FR-BI-05 | fields: +Nguồn (mã nguồn/tenant); Commit; Thuật ngữ MDM; rule: nối thêm "Chỉ tiêu PLATFORM_CODE chỉ đọc trong UI, đổi qua PR mã nguồn."; test_ids (backlog, trace): +UAT-AC471 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-06 / BL-BI-06 / trace FR-BI-06 | fields: +Tử số; Chính sách null (thiếu dữ liệu không phải 0); Loại cộng dồn; Hiệu lực; rule: nối thêm "Ratio bắt buộc tử/mẫu; người chứng nhận khác người soạn."; test_ids (backlog, trace): +UAT-AC471, UAT-AC472 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-07 / BL-BI-07 / trace FR-BI-07 | fields: +Join đã duyệt; Catalog DGV; rule: nối thêm "Nguồn chỉ qua dataset được quản trị cho phép; không nhập SQL."; test_ids (backlog, trace): +UAT-AC476 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-08 / BL-BI-08 / trace FR-BI-08 | fields: +Trạng thái chính sách; Xem thử dưới vai người dùng; rule: nối thêm "Đóng mặc định: không có chính sách ACTIVE áp dụng thì không truy vấn được dataset."; test_ids (backlog, trace): +UAT-AC473 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-09 / BL-BI-09 / trace FR-BI-09 | fields: +Kỳ dữ liệu; Snapshot; Σ con = cha; Lý do không cộng được; rule: nối thêm "Drill giữ snapshot và kiểm quyền lại ở đích; đổi chiều không đổi snapshot."; test_ids (backlog, trace): +UAT-AC31, UAT-AC32, UAT-AC33 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-10 / BL-BI-10 / trace FR-BI-10 | fields: +Khác biệt chỉ tiêu (phiên bản); rule: nối thêm "So sánh chỉ giữa revision cùng dashboard." | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-11 / BL-BI-11 / trace FR-BI-11 | fields: +Kết quả kiểm tái tạo; Người đề nghị; rule: nối thêm "Người duyệt khác người đề nghị."; test_ids (backlog, trace): +UAT-AC474 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-12 / BL-BI-12 / trace FR-BI-12 | fields: +Phạm vi từng người nhận; rule: nối thêm "Mỗi người nhận nhận dữ liệu theo phạm vi của chính họ; không đính kèm dữ liệu vượt phạm vi."; test_ids (backlog, trace): +UAT-AC475 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-13 / BL-BI-13 / trace FR-BI-13 | fields: +Kỳ dữ liệu; Từ cache; Bị từ chối; rule: nối thêm "Nhật ký không chứa giá trị dữ liệu."; test_ids (backlog, trace): +UAT-AC477 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BI-14 / BL-BI-14 / trace FR-BI-14 | fields: +Lần chạy chất lượng (DGV); Số dòng quarantine bị loại; rule: nối thêm "Huy hiệu NOT_ASSESSED khi chưa có lần chạy chất lượng; dòng quarantine không vào chỉ tiêu certified."; test_ids (backlog, trace): +UAT-AC478 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| UAT-AC31 | setup/steps: template 3 bước → cụ thể; expected: "đổi dimension không đổi snapshot." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-BI-09, FR-BI-02 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC32 | setup/steps: template 3 bước → cụ thể; expected: "nhóm con cộng lại tổng đối với additive metric cùng scope; ratio tái tính từ tử/mẫu." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-BI-09, FR-BI-04 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC33 | setup/steps: template 3 bước → cụ thể; expected: "người tenant A không thể sửa drill token để xem B." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-BI-09, FR-BI-08 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC34 | setup/steps: template 3 bước → cụ thể; expected: "stale cache bị phân biệt với nguồn mới; refresh tạo context mới có thông báo." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-BI-02, FR-BI-13 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC35 | setup/steps: template 3 bước → cụ thể; expected: "chia sẻ dashboard không tự cấp quyền dữ liệu." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-BI-01, FR-BI-17 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |

## 14. Phân tích điều hành G3-5 đến G3-11 (làn GOV-11b, màn BI-21 đến BI-30)

Mười màn và 26 thao tác thuộc FT-BI-08 (ST-BI-013 đến ST-BI-018). Nguyên tắc chung: mỗi con số có "i" (công thức, nguồn, ngày số liệu); tiền là số đồng nguyên dạng chuỗi, làm tròn nửa lên; số không tính được là N/A kèm mã lý do, không bao giờ là 0 bịa; mọi tham số lấy từ kho quy tắc quản trị và đánh dấu chưa xác nhận [CXN] cho đến khi chủ nghiệp vụ xác nhận.

| Màn | Thao tác | Quy tắc chính |
|---|---|---|
| BI-21 Dự báo giải ngân cuối năm | getDisbursementOutlook | Dải dự báo theo tốc độ 4 đến 8 tuần, đường mùa vụ năm trước, số cần mỗi tuần; là phép tính theo nhịp độ, không phải cam kết; thiếu kế hoạch hay lịch sử là N/A |
| BI-22 Nhật ký quyết định | recordAnalyticsDecision, listAnalyticsDecisions, getAnalyticsDecision, recordAnalyticsDecisionOutcome | Ghi quyết định cùng số liệu đóng băng (có mã băm); kết quả là bản ghi nối thêm so sánh số lúc quyết định với số sau đó; không sửa tại chỗ |
| BI-23 Độ tươi và thẻ điểm chất lượng | getDataFreshness, getDataTrustScorecard | SLA độ tươi theo bộ dữ liệu, cờ "dữ liệu cũ" tự hiện khi quá SLA; thẻ điểm theo mô-đun và đơn vị, chiều thiếu dữ liệu là N/A, điểm tổng cần đủ số chiều tối thiểu |
| BI-24 Truy nguồn số liệu | getMetricLineageGraph | Chỉ tiêu, bộ dữ liệu, bảng, mô-đun; khai báo từ kho đăng ký chứ không quan sát; khoảng trống được liệt kê |
| BI-25 Xếp hạng nhiều chỉ số | getMultiMetricRanking | Xếp trong nhóm quy mô, ghép tỷ lệ giải ngân với tiến độ vật lý; thiếu tiến độ vật lý là N/A |
| BI-26 Ghi chú và khiếu nại xếp hạng | proposeRankingAnnotation, listRankingAnnotations, decideRankingAnnotation, fileRankingComplaint, listRankingComplaints, resolveRankingComplaint | Người đề xuất ghi chú không tự duyệt; khiếu nại có vòng đời và lịch sử đầy đủ |
| BI-27 Điểm nghẽn | getBottleneckAnalysis | Số tiền bị giữ theo nguyên nhân chuẩn, tuổi nợ, bên giữ; khoản không có nguyên nhân hiện là "chưa ghi nguyên nhân" và vẫn được cộng |
| BI-28 Dự án dừng và kế hoạch khởi động lại | recordProjectHalt, listHaltedProjects, getHaltedProject, saveRestartPlan, decideRestartPlan, closeRestartStep, closeProjectHalt | Mỗi dự án một hồ sơ dừng đang mở; kế hoạch do người khác tác giả duyệt; chỉ đóng hồ sơ khi mọi bước đã đóng |
| BI-29 Bản đồ nhiệt giải ngân | getAnalyticsHeatmap | Đơn vị theo nguồn vốn; ô quá ít dự án không có tỷ lệ, không có dải màu và không vào tổng; chiều nhà thầu chờ dữ kiện hợp đồng |
| BI-30 Kiểm thử ngưỡng cảnh báo và xu hướng | getAnalyticsBacktest, getAnalyticsTrendRanking | Phát lại các tuần đã lưu, không tính độ chính xác khi quá ít cặp; xếp hạng theo thay đổi điểm trong bốn tuần |

Kiểm thử: UAT-PLAN-2580 đến UAT-PLAN-2593 và UI-BI-21 đến UI-BI-30. Các ngưỡng, trọng số, nhóm quy mô và SLA đều là quy tắc quản trị (ExecRuleType) chưa xác nhận.
