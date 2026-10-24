STATUS: IN_PROGRESS

# PROGRESS
Cập nhật: 2026-10-24T14:00+07:00 | Milestone: M3/6 | Task: MDM-1 — ST-MDM-001 xong, ST-MDM-002 một phần, ST-MDM-003 xong; kế tiếp ST-MDM-004

Spec gốc: `Design/MACHVON_Design` (baseline v1.3, commit 82a707f). Kế hoạch đã duyệt: `C:\Users\PNE_AI_01\.claude\plans\pasted-content-id-f8fb-h-y-s-unified-brook.md` (sổ quyết định D-B01..D-B12, ledger R1..R11, task T1..T12).
Luật vận hành: `AUTONOMOUS_EXECUTION_PROTOCOL.md`. Quy tắc làm việc trong deliverable: `Design/MACHVON_Design/AGENTS.md` (sửa tại chỗ, giữ ID màn hình/yêu cầu, không tạo bản sao/ZIP).

## Milestone map
- M1 — Thiết kế triển khai + kế hoạch (cập nhật tài liệu O1–O11, chưa viết code sản phẩm)
- M2 — R0 nền tảng (tenant/RLS/IAM/audit/outbox/entitlement/theme/shell/DOC engine) — lập plan bằng writing-plans sau M1
- M3 — R1 lát rộng 25 phân hệ "mức tối thiểu dùng thật"
- M4 — R2 sâu hóa (tài chính, GPMB, văn bản, BI drill)
- M5 — R3 tích hợp ngoài (khi D05–D07 có hợp đồng)
- M6 — R4 hardening + UAT 100% (`UAT-COVERAGE.md`)

## Đã hoàn thành
- [x] M1-T1 Dọn khung Java khỏi git + baseline v1.3 vào git — commit 82a707f — n/a (tài liệu)
- [x] M1-T1b CI/CD theo protocol: ci/ (6 cổng), .github/workflows/ci.yml, PR template, hook pre-push — commit 9bdc5a8, b129f44 — 26 test PASS, line coverage 98% — GitHub Actions success
- [x] M1-T3..T9 (một phần) Đặc tả phân hệ: platform (IAM, ADM, SAS, NOT, OMNI), capital (MDM, PRJ, CAP, DIS, HOME, MNE), MOB (Flutter) — commit c6b66c3, 07083b0, 05ee036 — 0 lỗi nhất quán trong phạm vi mỗi nhóm
- [x] M1-T11/T12 Kế hoạch triển khai (09) và kế hoạch kiểm thử/chuyển đổi (10) viết lại — commit f80fbde, 4007310
- [x] M1-A Bảo toàn baseline: tag baseline-v1.3 (82a707f), cổng baseline-cli (change_log.json, ID/cột mất, đoạn tài liệu bị xóa không ánh xạ) — commit 9388823 — 69 test, coverage 96%
- [x] M1-B (một phần) 09 và 10 dựng lại trên nền baseline, giữ nguyên mọi đoạn gốc, thêm ánh xạ G0–G5→R0–R4 và bảng sản phẩm baseline→công việc triển khai — commit 85288b2
- [x] M1-C Đồng bộ mã lỗi (error_codes.json, kiểm alias), RLS một quy ước cho mọi bảng tenant, sổ CR 1165 thay đổi, sổ pháp lý 58 mục, design-check và baseline-preservation bắt buộc trong CI — commit trong phiên 22/10
- [x] M1-T2 Công cụ thiết kế node: check (8f02510), sinh HTML/PDF (860a4ee), gộp fragment (efa7fb7) — 45 test PASS — line coverage 98.8%
- [x] M1-T13/T14 Kế hoạch epic→story→task (26 epic, 138 feature, 401 story, ~2.200 task), Codex review (25 phát hiện đã sửa), builder check, sổ mã lỗi 629 mã, ERD 291 bảng, schema chạy được trên PostgreSQL 18 thật (sql-verify), prototype 478 màn hình có điều hướng + ảnh — commit 43578c7, bd8c17f, e94043e, 047221e, 461c528 — 217 test công cụ, coverage 98,3% — CI gate sql-verify đạt
- [x] M1 hoàn tất (tài liệu + kế hoạch); còn lại chỉ là mục chờ người dùng/chủ nghiệp vụ trong TODOS.md mục E
- [x] Đổi viết tắt DTC → PIS (Public Investment System): nội dung repo (commit 704691e), repo GitHub `trungtm78/PIS`, bộ nhớ Claude; còn việc người dùng đổi tên thư mục `C:DTC` → `C:PIS` (xem TODOS.md mục E)
- [x] M2a (10 task): monorepo + cổng merge + cổng nhãn review (độc lập, gắn với commit), harness PostgreSQL thật, migration V001/V002 sinh từ schema thiết kế (vai trò, GRANT/REVOKE theo bảng control-plane và append-only), test RLS catalog, TenantDatabase, ngữ cảnh tenant ký cho worker, Problem+JSON/allowlist/lint mã lỗi, khóa cache theo tenant, contracts lint/generate, API shell + bộ test cách ly tenant (API + DB) — commit 3fd31fd..e7351d1 — kernel 126, db 71, api 95, contracts 37, ci 73 test; Codex review từng task (nhiều vòng sửa)
- [x] M2b (8 task): migration V003 viết tay (trigger append-only audit_event/audit_seal, grant relay, policy outbox_event cho relay), primitive kernel (canonical JSON, Idempotency-Key, If-Match, Merkle seal, backoff, redact), IdempotencyStore (claim/takeover có rào), outbox + relay SKIP LOCKED + consumer inbox (test kill giữa chừng: đúng 100 hiệu ứng), AuditWriter + AuditSealJob (niêm phong và xác minh, 6 kiểu giả mạo), CommandInterceptor (@Command/@Scope: idempotent, If-Match, audit cùng transaction, DENIED transaction riêng), bộ sinh ca conformance từ openapi.json (574 thao tác ghi, 384 có If-Match) + cổng commands:check trong lint, sửa TenantDatabase khi backend bị kill — commit 3bbd767..020cb39 — kernel 198, db 147, api 115, contracts 37, scripts 20, ci 84 test; Codex review 3 vòng (4 + 2 phát hiện đã sửa, vòng cuối sạch)
- [x] M2c (8 task): V004/V006 viết tay (membership.scope_version, CHECK rank tùy biến ≤ 89, role_grant không xóa, unique grant Active), 14 vai trò hệ thống seed theo bảng IAM.md, PDP thuần trong kernel (permission pattern, scope theo đoạn đường dẫn, effective access, decide với plane/step-up/phiên thu hồi/sv cũ) + property test fast-check, EffectiveAccessStore + cache theo scope_version + predicate SQL theo scope, PolicyGuard (STEP_UP và PLANES sinh từ openapi, khởi động thất bại nếu route thiếu chính sách), lệnh cây đơn vị (khóa cây, ghi lại path một lệnh, UNIT_CYCLE/DEPTH/CODE/VALIDITY, đua hai lệnh ngược chiều) và vai trò/grant chống leo thang (BR-IAM-05..08), ma trận từ chối sinh tự động 100 ca + đo độ trễ thu hồi p95, bộ cách ly tenant phủ lệnh ghi, cổng commands:check yêu cầu hàng ma trận, giảm bộ nhớ PostgreSQL test — commit 577f3f5..3639f87 — kernel 278, db 259, api 214, contracts 42, scripts 23, ci 84 test; Codex review 2 vòng trên từng commit rủi ro cao (vòng 1: 16 phát hiện đã sửa; vòng 2 sạch)
- [x] M2d (10 task): workspace web React + Vite (i18n khóa module.screen.action.state, lint chuỗi cứng), packages/design-tokens (CSS và TS từ design_tokens.json, kiểm tra tương phản, overlay theme tenant), packages/api-client (lệnh idempotent, If-Match, Problem+JSON, kiểu theo contract), bảng route 406 màn từ navigation_architecture.json, shell theo mockup (sidebar, breadcrumb, thư viện ứng dụng, 7 trạng thái UI, theme tenant), màn ADM-01 (cây tổ chức) và ADM-03 (vai trò, grant, step-up), đọc role_definition (CR-ADM-05), harness trình duyệt (route walk 406 route x 2 độ rộng = 812 trang 0 lỗi; 8 flow với API và PostgreSQL thật; so khớp ảnh: khung shell và các vùng khung ADM-01/03 sai khác 0 pixel, 6 thẻ trạng thái khớp baseline) — commit 31ac8f2..b23fabd — kernel 278, db 308, api 228, contracts 51, client 39, tokens 85, web 26 file, scripts 52, ci 84 test; Codex review 5 vòng
- [x] M2e (12 task): truy cập control-plane (V008, ControlDatabase, UserSessionStore, view tenant_user_directory có security_barrier), kernel entitlement và vai trò control, cổng xác thực (TokenVerifier, OIDC/JWKS, TenantTokenIssuer, AuthGuard; aal2 chỉ khi đa yếu tố), chọn tenant gắn phiên + thu hồi + READ_ONLY, registry tenant và saga bước 1-5 qua port MOCK, entitlement (V009, cache, truyền thay đổi, ENTITLEMENT_DENIED), lõi thông báo (inbox, dedupe, đọc/xác nhận), web OIDC + IAM-04, NOT-01/02, SAS-01/02/25, bộ sinh Flutter ThemeData (Dart 16 test), kit K0 (một máy chủ PostgreSQL cho cả lượt test, làn test), K1 (khối số migration theo slice, registry module), K2 (450 validator body sinh từ OpenAPI) — Codex review 14 commit (11 P1 + 31 P2 đã sửa), route walk bền (812 trang 0 lỗi), 18 flow e2e, so khớp ảnh 15 ca

- [x] M2f (23 task, 5 lane, đã hợp nhất): vòng đời tenant (SAS-001/003/004/005/006: license ký, saga 11 bước, owner, theme), thành viên/khách (ADM-006/007, IAM-005, IAM-09), quản trị và runtime (legal hold ADM-003, chứng thư ADM-008, chính sách bảo mật ADM-009, bootstrap API thật, telemetry, cảnh báo, scheduler + relay + alert sink chạy trong tiến trình API — N1), tài liệu (DOC-001..005: số văn bản, PDF xác định, kiểm chữ ký PAdES, ký/đóng dấu), nền tảng (search/files/cache isolation, supply chain, SBOM, deploy canary, test data platform, spike R0), Task 22 (uat-trace: 156/196 tiêu chí có tên test, 37/37 của story DONE; browser.yml; gói duyệt baseline R10 24 màn), Task 23 (cổng milestone). Codex review từng commit M2f (61 commit, ~130 phát hiện) + vòng 2 trên các commit sửa (30 commit, 27 phát hiện): mọi phát hiện thật đã sửa kèm test hồi quy, phần còn lại ghi TODOS.md.
- [x] Cổng milestone M2 (docs/m2-alignment-review.md mục 1 và 7): R0 57 story = 21 DONE, 2 DONE_UNCONFIRMED (DOC-001, DOC-003: CXN-DOC), 19 DONE_PENDING_ENV (môi trường ngoài: CA, Keycloak, Temporal, Redis, cloud, PowerSync, mô hình AI), 15 PARTIAL (DOC-002, KERNEL-013/014/025/026/027/030/031, IAM-002/005, ADM-006/007/009, SAS-001/003; phần thiếu nêu cụ thể), 0 NOT STARTED.
- [x] M3 · MDM-1 · ST-MDM-001: bản ghi chủ có phiên bản hiệu lực, đề xuất–duyệt–công bố bốn mắt (đề xuất ≠ duyệt ≠ công bố), impact preview bắt buộc, công bố theo ngày + job master-activation; migration V1080/V1082, MasterStore, API (ghi + đọc), màn MDM-01/25/26/27/28/32, luồng trình duyệt và visual — commit 3d22352, sửa theo Codex vòng 1 commit 9b440a1
- [x] M3 · MDM-1 · ST-MDM-002 (một phần): chính sách phạm vi theo loại (V1081), MDM-31 ngừng dùng với successor, MDM-33 phạm vi; còn alias của tenant qua crosswalk (chờ ST-MDM-007)
- [x] M3 · MDM-1 · ST-MDM-003: định nghĩa loại và validator cho FUND_SOURCE (CTMTQG luôn là tập con: SUBSET_SOURCE_NOT_ADDITIVE), PROGRAM, SECTOR, PROJECT_GROUP/TYPE/STAGE, DECISION_TYPE/AUTHORITY và 4 loại rule (BR-MDM-09); gói baseline nền tảng có digest + job master-baseline-sync (6 giờ); cổng đọc rule MasterRules (nhóm dự án theo bảng ngưỡng hiệu lực tại ngày đề xuất, mã TTQG, cờ chờ xác nhận); người duyệt rule theo loại (V1083, đóng khi không có); MDM-04..10 trên một CatalogueScreen; form thuộc tính theo loại ở MDM-25/26 — migration V1083, 3 AC có test

## Đang làm dở
Task: M3 · MDM-1 — ST-MDM-001 DONE, ST-MDM-002 PARTIAL, ST-MDM-003 DONE (chưa push; chờ Codex review của ST-MDM-003 rồi đẩy một lần sau khi qua cổng đầy đủ). Kế tiếp ST-MDM-004 (lịch kỳ và đơn vị đo), rồi 005..009.
Đã làm: M2a..M2f; R0 57 story = 21 DONE / 2 DONE_UNCONFIRMED / 19 DONE_PENDING_ENV / 15 PARTIAL / 0 NOT STARTED; 24 màn hình web đã cài (ADM 6, DOC 5, IAM 2, NOT 2, SAS 9), 382 web + 72 mobile chưa làm.
BƯỚC TIẾP THEO: M3 theo docs/superpowers/plans/2026-10-23-m3-r1-breadth-roadmap.md, lát đầu KERNEL-1, MDM-1, ISS-1 (viết plan bằng writing-plans trước). Trước lát M3 đầu tiên: quy tắc đồ thị module trong .dependency-cruiser.cjs (F9), wiring hạ tầng thật của Task 20 khi có môi trường.
File liên quan: docs/m2-alignment-review.md (mục 1 và 7), docs/UAT-COVERAGE.md, docs/r10-baseline-approvals.md, docs/runbooks/{test-lanes,web-e2e,jobs,api-runtime,release-checklist}.md, TODOS.md

## Hàng đợi task kế tiếp (M1)
1. M1-T3 O2 research → `01_Documents/01_Nghien_cuu_va_phan_tich_nguon.md` + `03_Engineering/Market_Research.html` (pháp lý VN, thị trường, văn bản nhà nước, khoảng trống chức năng)
2. M1-T4 O3 `04_Thiet_ke_co_ban.md`: tenant = cơ quan chủ quản (R6), stack D-B07/D-B12, Temporal chủ duy nhất (R9), AI theo phân loại dữ liệu (R5), hạ tầng theo slice (R1)
3. M1-T5 O4–O6 lõi: IAM/tenant, MDM, PRJ, CAP, DIS (05, openapi, sql, data_dictionary, index P1)
4. M1-T6 O4–O6 kiểm soát: CTR/PAY sổ lũy kế (R7), ISS, NOT/OMNI, BI/DGV, import idempotent (A3)
5. M1-T7 O4–O6 AI/SaaS: BID, LLM, SAS (entitlement, billing, theme)
6. M1-T8 Phân hệ mới DOC (R8), LND, PMT, QMS, AUD, AST, MNE
7. M1-T9 Mobile Flutter + sync rules PowerSync (A1) — `07_Smartphone_iOS_Android.md`
8. M1-T10 Prototype màn hình mới + field mới theo mockup (R10, D-B11)
9. M1-T11 O7 backlog epic→story→task + O8 kế hoạch `09` (giờ review, WIP≤2 — R2)
10. M1-T12 O9 QA/migration/fixtures (`10`, test_cases, test_fixtures, mapping)
11. M1-T13 O10 truy vết + O1 readiness/quyết định + sổ xác nhận pháp lý (R4) + O11 mâu thuẫn
12. M1-T14 Sinh HTML/PDF, chạy check, builder check, Codex review, /plan-eng-review

## Quyết định kiến trúc
| Ngày | Quyết định | Lý do | Ảnh hưởng |
|---|---|---|---|
| 2026-10-22 | Stack: NestJS modular monolith + React/Vite + Flutter + PostgreSQL RLS + Redis + Keycloak + Temporal + LiteLLM/Langfuse + PowerSync, cloud VN | D-B07 (Claude quyết), D-B12 Flutter (người dùng chốt), D-B03 | Thay kế hoạch Java cũ |
| 2026-10-22 | `Design/MACHVON_Design` vào git (trừ `work/` lịch sử 194 MB, ZIP, bản v1.2, PDF/MP4 nguồn) | Protocol yêu cầu commit theo task; cần diff tài liệu | `.gitignore` |
| 2026-10-22 | Tài liệu danh mục: JSON/SQL/OpenAPI là nguồn duy nhất; HTML/PDF sinh bằng script node | D3 (người dùng chốt), máy không có Python | `work/tools/` |

## Assumption đã tự quyết
| Ma trận quyền của 14 vai trò hệ thống | Chỉ các pattern IAM.md nêu tên; phần còn lại để trống ghi CHỜ KÝ (SPECIALIST, INVESTOR_OFFICER rỗng); TENANT_OWNER = mọi quyền tenant-plane trừ system.* | IAM.md mục 2, ngoại lệ D-B04 |
| Hạng người cấp/thu hồi | Hạng cao nhất trong số mọi grant Active bao phủ phạm vi (BR-IAM-05 b), kể cả grant ở đơn vị sở hữu của dự án/hợp đồng; Codex đánh dấu "mượn hạng" nhưng khớp văn bản | IAM.md BR-IAM-05 |
| Trạng thái hợp đồng được coi là hiệu lực cho grant khách | SIGNED, ACTIVE, SUSPENDED, COMPLETED; DRAFT/CLOSED bị từ chối | BR-IAM-08, chờ chủ nghiệp vụ xác nhận |
| Lịch việc theo múi giờ | Ngày nghiệp vụ = Asia/Ho_Chi_Minh, không phụ thuộc múi giờ máy chủ | Codex vòng 1 |
| Audit seal: định vị dòng bị sửa | Báo theo cửa sổ seal (from_seq..to_seq), không theo từng dòng vì thiết kế không lưu hash từng dòng; muốn chính xác cần CR cho audit_event | ST-KERNEL-023 AC-2, ADM-002 |
| Replay trả status của route hiện hành, không phải status đã lưu | Nest áp status route sau interceptor; status gốc vẫn lưu trong idempotency_record. Đổi @HttpCode của lệnh đang chạy là đổi hợp đồng | Codex P2 vòng 1 |
| 14 vai trò hệ thống (plan nói 13) | Hàng "NOTIFICATION_ADMIN / OMNI_SUPERVISOR" của IAM.md tách thành hai vai trò rank 50 | IAM.md §2 |
| Ma trận quyền vai trò hệ thống | Lấy nguyên văn mẫu quyền trong IAM.md; vai trò chưa nêu quyền để rỗng, CHỜ KÝ | D-B04 |
| Bảng inbox cho consumer nội bộ | Dùng lại integration_event_inbox (provider=consumer:<tên>) | bảo toàn baseline |
| Ký license | Ed25519 qua Node `crypto`; khóa riêng từ port `LicenseKeyStore` (biến môi trường khi phát triển, KMS sau), không vào CSDL hay log | SAS.md, KERNEL-012 |
| PDF xác định và PAdES | `pdf-lib` (MIT) metadata cố định, hash vàng theo profile; `pkijs`/`asn1js` kiểm CMS; chứng thư test sinh trong test; CA thật = DONE_PENDING_ENV | DOC-001, DOC-004 |
| Cổng supply chain | `rangePolicy=lockfile`: khoảng `^`/`~` được chấp nhận khi lockfile ghim; audit mức high phạm vi production; lỗi dev dependency (tinypool qua vitest 4) ghi TODOS | KERNEL-013 |
| Worker trong tiến trình API | `WORKERS_ENABLED` mặc định bật: scheduler (6 job, advisory lock một chủ), outbox relay + consumer, alert sink; tắt khi chạy test HTTP thuần | N1, KERNEL-022/051, ADM-002 |
| Lịch job | Cổng `Scheduler` + CLI `npm run jobs:run -- <job>`; Temporal thay sau (KERNEL-044) | F8 |
| Hạ tầng | YAML khai báo dưới `infra/` + kiểm bằng Node (`npm run infra:check`); không áp lên cloud | không có Docker/Terraform |
| Đọc outbox | Không cài `get_resources_outbox_event*` (ADM.md mục 7: outbox không lộ ra ngoài); chờ change request | ADM.md |
| Khách chung hợp đồng | Lời mời khách cấp thêm grant MEMBER cùng hợp đồng/hạn để dùng self-service; vượt ADM.md nên ghi TODOS cho chủ nghiệp vụ xác nhận | triage Codex vòng 1 |
| Trạng thái story | DONE / DONE_PENDING_ENV / DONE_UNCONFIRMED / PARTIAL; cổng `uat-trace` ép các story ba trạng thái đầu có tên test cho mọi tiêu chí (trừ kiểm tra ngoài đã khai trong `docs/story-status.json`) | KERNEL-090 phần R0 |
| Điểm mơ hồ | Diễn giải đã chọn | Căn cứ trong spec |
|---|---|---|
| Loại nào tenant được ghi (MDM F8) | Nguồn vốn, nhóm và giai đoạn dự án, 4 loại rule chỉ nền tảng ghi (pháp luật và quy trình của nền tảng); lĩnh vực, chương trình, loại dự án, địa bàn, loại và thẩm quyền quyết định: tenant thêm mục con dưới mục của nền tảng; còn lại của tenant. Dòng master_type_policy do control-plane ghi thay baseline | MDM.md BR-MDM-06, F8 |
| Ai là "owner phân hệ" duyệt rule (BR-MDM-09) | Bảng master_type_approver (control-plane ghi, tenant chỉ đọc); loại rule chưa có approver thì không ai duyệt được (đóng mặc định) | MDM.md BR-MDM-09; chưa có UI gán |
| Giá trị seed của rule | Ngưỡng nhóm dự án (120 tỷ / 2.300 tỷ / 30.000 tỷ), tiêu chí thẩm định 5 mục tổng 100 điểm ngưỡng 60, mã TTQG 7 chữ số chặn từ PIPELINE: đều là giả định gắn cờ chờ xác nhận (CXN-32, CXN-01, ASSUMPTION-APPRAISAL-60), không phải khẳng định pháp lý | PRJ.md [CXN-01][CXN-32], story AC-ST-MDM-003 |
| Thuộc tính loại thẩm quyền quyết định | agency_key, decision_type_key (phải có), scope ∈ {NATIONAL, MINISTRY, PROVINCE, COMMUNE}; khung do mình chọn vì catalogue chỉ nêu cột "Cơ quan, Loại quyết định, Phạm vi" | screen_catalog MDM-09 |
| Gói baseline | Nhúng trong mã, có digest SHA-256 kiểm trước khi áp; mục có sẵn không đổi, bản mới của một mục thêm version mới bắt đầu từ ngày của nó và không viết lại lịch sử; gói ký từ control-plane thay sau | MDM.md §9 mdm.platform-baseline-sync |
| Tenant là gì | Cơ quan chủ quản ký hợp đồng (UBND tỉnh/bộ); đơn vị con là organization_unit | R6 (người dùng chốt D9) |
| Định nghĩa kỳ/YTD, golden data (D03), mapping nguồn (D04) | Soạn đề xuất, trạng thái CHỜ KÝ; không tự chốt | D-B04 ngoại lệ |
| Căn cứ pháp lý thứ cấp [CXN] | Vào sổ xác nhận; slice dùng chưa được DONE khi chưa xác nhận | R4 |

## Trạng thái test
Full suite: `npm test` (api 1486, web 1166, db 810, kernel 599, contracts 133, design-tokens 106, api-client 46, scripts 247) + `cd ci && npm test` 90 + làn trình duyệt `npm run e2e -w @machvon/web` | Mọi cổng (lint, typecheck, architecture, commands:check, contracts:check/compat, db:check, migrations:check, tokens:check, i18n:check, alerts:check, infra:check, routes:check, uat-trace) đạt | Test fail: không

## Nợ kỹ thuật / rủi ro
- Cổng milestone M2 để lại (ghi chi tiết ở TODOS.md): 15 story PARTIAL; 19 DONE_PENDING_ENV và 2 DONE_UNCONFIRMED chờ môi trường ngoài hoặc xác nhận pháp lý; 24 baseline hình ảnh R10 chờ chủ sản phẩm (docs/r10-baseline-approvals.md); công cụ UI screen-contract (UI-ADM-01/03...) chưa có; provisioning chạy trên adapter MOCK (DNS, realm, storage, mailer), khóa public license chưa đăng ký; tín hiệu job_runs_total chưa có exporter; browser.yml chưa chạy trên runner thật (font Windows vs Ubuntu).
- Chưa quyết: ai.review và ai.cancel chưa gắn feature entitlement (SAS.md BR-SAS-10); phạm vi PII iam.member.read_pii không có trong catalogue (dùng iam.member.manage); SAS-003 phải xác nhận cách đánh dấu license Superseded.
- Hạ tầng ngoài (Keycloak, Temporal, Redis, Docker, cloud VN, CA sandbox, PowerSync): chưa có trên máy; mọi tích hợp đi qua port có adapter MOCK và bộ contract test.
- Làn trình duyệt (route walk, flow, visual) chạy bằng npm run e2e -w @machvon/web dưới khóa e2e/.run-lock; đã có .github/workflows/browser.yml (chưa chạy trên runner thật).
- Máy Windows này cạn commit memory khi chạy nhiều PostgreSQL nhúng và trình duyệt cùng lúc: tối đa một làn trình duyệt, một bộ test DB tại một thời điểm; subagent không push.
- `C:\PIS\backend` và `C:\PIS\.tools` (khung Java cũ) còn trên đĩa vì `.claude/settings.json` chặn `rm -rf`; đã gitignore. Người dùng xóa tay khi tiện.
- Đã bật required=true cho design-check và baseline-preservation trong ci/config.json (22/10).
- Sổ pháp lý: 58 mục [CXN] chưa xác nhận (owner mặc định Pháp chế); cần legal_confirmation_register.json khi có chủ nghiệp vụ.
- Mã lỗi chuẩn: IDEMPOTENCY_CONFLICT, SELF_APPROVAL_DENIED (error_codes.json).
- Stop hook `.claude/hooks/stop-guard.bat` chặn kết thúc lượt tới khi có STATUS cuối; không ghi trạng thái giả.
- 10 quyết định D01–D10 trong spec cần owner thật cho D03/D04/D05–D10.
- ST-KERNEL-030 follow-up: còn thiếu test hợp đồng Dart (đổi tên trường phản hồi); phát hiện breaking change N so với N-1 đã có (contracts:compat).
