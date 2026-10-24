# SAS — Control plane: vòng đời tenant, gói, quyền lợi, license, hóa đơn và vận hành

Phiên bản đặc tả M1 · 22/10/2026 · Nguồn dữ liệu máy: `work/staging/platform.json` (bảng `tenant`, `placement`, `tenant_provisioning_run`, `tenant_placement_migration`, `tenant_domain`, `product_plan_version`, `plan_feature`, `subscription`, `entitlement_version`, `entitlement_override`, `usage_meter_event`, `usage_counter`, `invoice`, `invoice_line`, `billing_payment`, `license_revision`, `license_signing_key`, `support_access_grant`, `tenant_export_job`, `tenant_restore_request`, `feature_flag`, `tenant_theme_*`). Theme SAS-04 giữ nguyên đặc tả tại `03_Engineering/Tenant_Theme_Specification.html` và `Command_Contracts_and_QA.html`; tài liệu này chỉ chốt mã lỗi review (BR-SAS-17). Mô hình tenant (R6) theo `IAM.md §1`.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Nhà cung cấp phải đưa một tỉnh/bộ mới vào vận hành trong vài giờ mà không thao tác tay trên DB/IdP; quản lý hợp đồng thuê dịch vụ (thường thanh toán theo năm từ ngân sách), quyền lợi theo gói và license có chữ ký; xuất hóa đơn điện tử đúng NĐ 123/2020 (sửa bởi NĐ 70/2025) — **không hủy hóa đơn đã phát hành, chỉ điều chỉnh/thay thế**; và trả lại toàn bộ dữ liệu khi hết hợp đồng. Bản v1.3 có hai bộ trạng thái tenant mâu thuẫn (FRD: Requested→Provisioning→Active/Failed; 05: Provisioning/Active/Suspended/Offboarding/Archived) và thiếu toàn bộ lệnh ghi cho provisioning, subscription, entitlement, billing.

**Trong phạm vi:** SAS-01..25 — danh sách/chi tiết tenant, saga khởi tạo (SAS-02, SAS-22), vòng đời Suspended/Offboarding/Archived (SAS-03, SAS-17), nâng cấp cách ly silo (SAS-23), tên miền (SAS-05), gói và feature (SAS-06), thuê bao, đổi gói, proration (SAS-07..09), hóa đơn điện tử và đối soát thanh toán (SAS-10, SAS-24), đo mức sử dụng (SAS-11), quyền lợi hiệu lực và ghi đè (SAS-25), license cấp/gia hạn/tạm khóa/thu hồi (SAS-12..16), truy cập hỗ trợ có kiểm soát (SAS-19), cờ phát hành (SAS-20), khôi phục tenant (SAS-21), sức khỏe nền tảng (SAS-18), theme (SAS-04).

**Ngoài phạm vi:** quản trị nội bộ tenant (ADM); quyết định quyền runtime (IAM PDP — SAS cung cấp entitlement); giá LLM theo token (`pricing_version` thuộc LLM — SAS chỉ tham chiếu khi lập dòng hóa đơn usage AI); tích hợp thật với nhà cung cấp hóa đơn điện tử/cổng thanh toán (adapter MOCK ở R1, PROPOSED cho tới khi có hợp đồng D05/D06).

**Phụ thuộc:** IAM/ADM (role seed, owner, audit/outbox/idempotency), Temporal (saga provisioning, silo promotion, restore), Keycloak Admin API, DNS/TLS (ACME), object storage, PostgreSQL placements, KMS/HSM (khóa ký license), adapter e-invoice/payment, NOT (thông báo vòng đời), LLM (meter AI).

**Căn cứ.** NĐ 123/2020/NĐ-CP sửa đổi bởi NĐ 70/2025/NĐ-CP (hiệu lực 01/6/2025) về hóa đơn, chứng từ — xử lý sai sót bằng hóa đơn điều chỉnh/thay thế, bỏ thủ tục hủy hóa đơn đã có mã [CXN-INV-02]; Luật Thuế GTGT 48/2024/QH15 (phần mềm/dịch vụ phần mềm thuộc đối tượng không chịu thuế) [CXN-INV-01]; quy định thuê dịch vụ CNTT sử dụng NSNN (NĐ 73/2019/NĐ-CP và văn bản sửa đổi) [CXN-PROC-01]; Luật Dữ liệu 60/2024/QH15 + NĐ 165/2025/NĐ-CP (dữ liệu lưu tại Việt Nam — region chỉ `vn-*`); Luật BVDLCN 91/2025/QH15 (truy cập hỗ trợ là xử lý dữ liệu cá nhân cần căn cứ). Thực tiễn: Stripe Billing/Chargebee (entitlement tách subscription, proration preview), AWS SaaS Factory (pool→silo, tenant onboarding saga), Atlassian Cloud (support access consent, data export).

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| System Admin (`SystemAdmin`, aal2 WebAuthn) | control plane, mọi tenant | provisioning, vòng đời, placement, domain, gói, thuê bao, override (đề nghị hoặc duyệt cái người khác đề nghị), license, billing, theme, restore | duyệt chính đề nghị của mình (override, cutover, restore); đọc dữ liệu nghiệp vụ tenant không qua support grant |
| Platform Operator | control plane | đọc SAS-01/03/18/22 | mọi lệnh ghi |
| Billing Operator | control plane | gói, thuê bao, hóa đơn, ghép thanh toán | license, vòng đời tenant |
| Support Operator | control plane | xin truy cập hỗ trợ theo ticket | truy cập khi chưa được tenant chấp thuận |
| TENANT_OWNER | tenant của mình (tenant-plane) | xem thuê bao/hóa đơn/license/entitlement của mình, chấp thuận/thu hồi support access, yêu cầu xuất dữ liệu | gia hạn/cấp license, đổi gói, sửa theme (AC43) |
| TENANT_ADMIN | tenant của mình | xem theme đã công bố, chấp thuận support access | như trên |
| BILLING_VIEWER | tenant của mình | đọc thuê bao, hóa đơn, usage tổng hợp | đọc hồ sơ nghiệp vụ |
| Hệ thống (service account) | internal | ghi usage meter, chạy job license/billing | — |

## 3. Luồng nghiệp vụ

### 3.1 Khởi tạo tenant — saga Temporal (SAS-02, SAS-22)
Tiền điều kiện: plan version Published; placement đích Active còn chỗ; mã tenant và subdomain chưa dùng. Hậu điều kiện: tenant Active, chủ sở hữu ban đầu nhận lời mời.
1. `requestTenantProvisioning` (Idempotency-Key): trong một transaction control-plane ghi `tenant` status **Requested** (`requested_at`), `tenant_provisioning_run` attempt 1 Running, audit `tenant.requested`, outbox `sas.tenant.requested.v1`; trả 202 `{tenant_id, status, provisioning_run_id}`. Cùng key → replay; cùng mã khác key → 409 `TENANT_CODE_TAKEN`.
2. Consumer khởi chạy `TenantProvisioningWorkflow` (id `prov:{tenant_id}:{attempt}`); activity đầu đặt tenant **Provisioning**.
3. Mười một bước, mỗi bước idempotent theo khóa tự nhiên và ghi vào `steps_json[step] = {status, attempts, error_code, started_at, finished_at}`:

| # | Bước | Hành động | Khóa idempotent | Bù trừ khi hủy |
|---|---|---|---|---|
| 1 | IDP_ORG | tạo Keycloak organization (silo: realm riêng) | `org alias = tenant.code` | xóa organization |
| 2 | DNS_SUBDOMAIN | tạo `<subdomain>.machvon.vn` + TLS | hostname | thu hồi bản ghi |
| 3 | STORAGE_PREFIX | tạo prefix `<tenant_id>/` + policy | prefix | xóa prefix rỗng |
| 4 | DB_PLACEMENT | gán `placement_id`; silo: tạo database từ template | placement × tenant | tách placement |
| 5 | RLS_SEED | chạy kiểm tra RLS (truy vấn với tenant khác trả 0 dòng) | — | — |
| 6 | ENTITLEMENT_V1 | `subscription` Trialing/Active + `entitlement_version` 1 | (tenant, version_no 1) | — |
| 7 | LICENSE_PILOT | license edition theo gói, ký bằng khóa Active | (tenant, serial, rev 1) | revoke |
| 8 | ROLE_SEED | 13 vai trò hệ thống (IAM §2) | (tenant, code) | — |
| 9 | ROOT_UNIT | `organization_unit` GOVERNING_BODY tên `root_unit_name` | (tenant, code ROOT) | — |
| 10 | THEME_V1 | `tenant_theme_version` 1 + pointer (Command_Contracts: cùng transaction) | (tenant, version 1) | — |
| 11 | OWNER_INVITE | membership Invited + grant TENANT_OWNER (control plane) + email | (tenant, email) | thu hồi lời mời |

4. Thành công: tenant **Active** (`activated_at`), run Succeeded, outbox `sas.tenant.status_changed.v1`, `sas.entitlement.changed.v1`.
5. Lỗi: activity retry 3 lần (backoff 10 s, 1 m, 5 m); vẫn lỗi → run Failed (`current_step`, `error_code`), tenant **Failed**, thông báo System Admin. `retryTenantProvisioning` (If-Match) tạo run attempt n+1 bắt đầu tại bước lỗi; bước DONE bỏ qua (khóa idempotent). Bỏ khởi tạo: `archiveTenant` từ Failed → chạy bù trừ ngược thứ tự → Archived.

### 3.2 Vòng đời sau khởi tạo (SAS-03, SAS-17)
- `suspendTenant` (Active → Suspended): reason_code ∈ {NON_PAYMENT, SECURITY_INCIDENT, CUSTOMER_REQUEST, LICENSE_REVOKED, LEGAL_ORDER}, `access_policy` READ_ONLY_EXPORT (mặc định) hoặc NO_ACCESS (sự cố bảo mật). Phát EntitlementChanged; lệnh ghi tenant-plane → 403 `TENANT_SUSPENDED`. Thanh toán quá hạn **không** tự Suspend (BR-SAS-04).
- `resumeTenant` (Suspended → Active).
- `startTenantOffboarding` (Active|Suspended → Offboarding): `contract_end_date`, `export_window_days` 30..180 (mặc định 90 [GIẢ ĐỊNH]); tenant chỉ đọc + xuất; thông báo Tenant Owner ở ngày 0, 30, 60, cửa sổ −7.
- `archiveTenant` (Offboarding → Archived): yêu cầu một `tenant_export_job` Delivered **hoặc** đã hết cửa sổ xuất (409 `EXPORT_NOT_CONFIRMED`); đăng nhập tenant bị chặn; job purge chạy theo `data_retention_policy` và **bỏ qua mọi scope dưới legal hold** (BR-PLT-04); hostname giữ 90 ngày.
- Offboarding → Active nếu gia hạn hợp đồng trong cửa sổ (`resumeTenant`).

### 3.3 Nâng cấp pool → silo (SAS-23)
1. `startSiloPromotion` (tenant Active, không có migration mở): Planned → Copying (logical replication bảng của tenant với filter `tenant_id`, object storage copy theo prefix) → Verifying (so row count từng bảng, checksum theo khóa chính, **tổng mọi cột numeric(24,0) tiền** theo bảng) → AwaitingCutover.
2. `approvePlacementCutover` bởi System Admin khác người khởi tạo (403 `SELF_APPROVAL_DENIED`); verify chưa khớp → 422 `MIGRATION_VERIFICATION_FAILED`.
3. CutoverFrozen: `tenant.write_frozen_until = now + write_freeze_max_minutes` (lệnh ghi trả 503 `TENANT_WRITE_FROZEN`, retryable); đồng bộ phần chênh cuối; verify lại; cập nhật routing (`tenant.placement_id`, `isolation_mode=SILO`) → Switched; quan sát 24 giờ → Completed; nguồn cũ xóa sau 30 ngày (trừ legal hold).
4. `abortPlacementMigration` trước Completed → RolledBack: routing cũ, gỡ đóng băng, dữ liệu đích hủy. Vượt `write_freeze_max_minutes` khi CutoverFrozen → workflow tự abort.

### 3.4 Tên miền (SAS-05)
`addTenantDomain` trả TXT `_machvon-verify.<host>` = token (lưu hash) → `verifyTenantDomain` (DNS mock/thật) → Verified → cấp TLS → Active. Hostname duy nhất toàn nền tảng (index unique lower(hostname)) → 409 `DOMAIN_TAKEN`. `removeTenantDomain` → Revoked, giữ chỗ 90 ngày (không cấp cho tenant khác). Hostname chỉ chọn tenant mặc định trên trang đăng nhập; vẫn phải có membership (BR-SAS-06).

### 3.5 Gói, thuê bao, đổi gói (SAS-06..09)
- `createPlanVersion` → `publishPlanVersion` (Published bất biến; sửa = revision mới — 409 `PLAN_VERSION_IMMUTABLE`). `plan_feature` khai báo `limit_kind` BOOLEAN/QUOTA/METERED, `grace_behavior`, `expired_behavior`.
- `createSubscription` (mỗi tenant 1 thuê bao sống — unique partial; 409 `SUBSCRIPTION_EXISTS`): cycle MONTHLY/QUARTERLY/ANNUAL/CONTRACT_TERM, `procurement_contract_ref`, điều khoản thanh toán; tạo entitlement_version mới.
- `previewPlanChange` → `{preview_hash, proration_vnd, quota_violations[], effective_at}`; `changeSubscriptionPlan` bắt buộc `preview_hash` khớp trạng thái hiện tại (409 `PREVIEW_STALE`). Nâng gói NOW hoặc NEXT_CYCLE; hạ gói chỉ NEXT_CYCLE [GIẢ ĐỊNH — không hoàn tiền giữa kỳ].
- `cancelSubscription`: `cancel_at_period_end = true`; tới hạn → Cancelled; tenant không tự Offboarding (System Admin quyết).

### 3.6 Quyền lợi hiệu lực, ghi đè và lan truyền (SAS-25)
1. Entitlement hiệu lực = features của plan version thuê bao + override Active (ghi đè theo `feature_code`) ⊗ trạng thái license (grace/expired behavior) ⊗ trạng thái tenant.
2. Mỗi thay đổi nguồn (thuê bao đổi gói có hiệu lực, override duyệt/thu hồi/hết hạn, license đổi trạng thái, tenant đổi trạng thái) tạo `entitlement_version` mới (version_no + 1, `entitlements_hash = sha256(canonical features_json)`, `cause`) và outbox `sas.entitlement.changed.v1 {tenant_id, version_no, entitlements_hash}` trong cùng transaction.
3. Consumer: xóa Redis `ent:{tenant_id}` và `authz:{tenant_id}:*`; đẩy `entitlements.changed` qua kênh SSE/WebSocket `tenant:{id}` tới phiên web; silent push (data message) tới mobile; client gọi `GET /me/entitlements` và so hash. Lệnh rủi ro cao (license, tiền, AI, campaign) kiểm entitlement **trực tiếp DB**, không qua cache. SLO: p95 commit → từ chối ≤ 60 giây (AC44).
4. Override: `requestEntitlementOverride` (lý do ≥ 10 ký tự, `valid_until` bắt buộc) → `decideEntitlementOverride` bởi System Admin khác (403 `SELF_APPROVAL_DENIED`) → Active; hết hạn → Expired (job mỗi phút) → entitlement_version mới.

### 3.7 Hóa đơn điện tử và thanh toán (SAS-09, SAS-10, SAS-24)
1. `runBillingCycle` (hằng ngày với các thuê bao tới kỳ, hoặc tay): mỗi `(subscription, period)` tối đa một invoice ORIGINAL (khóa logic; chạy lại trả bản có sẵn). Dòng: SUBSCRIPTION (giá gói theo kỳ), USAGE (meter vượt hạn mức × đơn giá), ADJUSTMENT (proration). Tiền VND nguyên; thuế theo `vat_category` từng dòng (BR-SAS-14).
2. Draft → `issueEInvoice` → PendingIssue: activity gọi `EInvoiceProviderPort.issue(invoice)` với khóa tham chiếu = `invoice.id`; provider trả số, ký hiệu mẫu số, ký hiệu, mã CQT, mã tra cứu → **Issued** (bất biến) → gửi người mua (email + link tra cứu) → Sent. Provider lỗi tạm thời → retry 5 lần trong 24 giờ; vẫn lỗi → IssueFailed (gửi lại bằng `issueEInvoice` với cùng provider_ref — provider phải từ chối trùng hoặc trả lại số cũ [CXN-INV-03]).
3. Thanh toán: chuyển khoản ngân hàng (nhập sao kê tệp hoặc webhook ngân hàng/cổng thanh toán) — `receivePaymentWebhook` xác minh chữ ký trên raw body → inbox `(tenant, provider, event_key)` → ACK 200 → worker ghép theo `invoice_code` trong nội dung chuyển khoản → `billing_payment` (UNIQUE provider × provider_txn_ref) → invoice PartiallyPaid/Paid. Không ghép được → Unmatched → `matchBillingPayment` (Billing Operator; số tiền phải khớp số còn phải thu, lệch → 422 `AMOUNT_MISMATCH`). Webhook trước khi biết tenant: inbox ghi dưới tenant `PLATFORM_OPERATOR`, chuyển sang tenant đích khi ghép.
4. Sai sót sau phát hành (SAS-24): **không có lệnh hủy**. `createAdjustmentInvoice` (điều chỉnh tăng/giảm, dòng âm cho giảm) hoặc `createReplacementInvoice` (thay thế toàn bộ, một lần cho mỗi hóa đơn gốc — unique partial; lần 2 409 `EINVOICE_ALREADY_REPLACED`), kèm `correction_reason` và `agreement_document_ref` (văn bản thỏa thuận với người mua khi pháp luật yêu cầu [CXN-INV-02]); hóa đơn mới đi lại bước 2; khi Issued: gốc chuyển Adjusted/Replaced. Số phải thu = Σ total các hóa đơn ORIGINAL chưa Replaced + Σ ADJUSTMENT + REPLACEMENT − Σ đã thu.
5. Quá hạn: `due_at` qua → Overdue; thuê bao PastDue (`past_due_since`); nhắc Tenant Owner ở 1/15/30 ngày; sau 30 ngày cảnh báo SAS-09 "đề xuất tạm ngừng" — chỉ System Admin quyết `suspendTenant` có lý do.

### 3.8 License (SAS-12..16)
- `post_licenses`: chỉ audience control plane; kiểm BR-SAS-11; tạo revision 1 Issued, ký payload `{iss, tenant_id, license_id, serial, revision, edition, valid_from, valid_until, grace_until, entitlements_hash, seats, quota, deployment_binding?, offline_lease_until?, kid}` bằng khóa Active (EdDSA, private key trong KMS/HSM — chỉ gọi sign, không xuất khóa).
- Job trạng thái mỗi phút (đồng hồ server UTC): Issued → Active khi `now ≥ valid_from`; Active → Grace khi `now ≥ valid_until` (nếu `grace_until > valid_until`, ngược lại Expired); Grace → Expired khi `now ≥ grace_until`. Biên `[from, until)` (AC40). "Expiring" là nhãn UI khi `valid_until − now ≤ 30 ngày`, không đổi quyền.
- `renewLicense`: revision n+1 Issued (supersedes_id = n), bản n → Superseded (chỉ đổi status); hiệu lực liền mạch nếu `valid_from` mới = `valid_until` cũ.
- `suspendLicense`/`reinstateLicense` (Suspended ⇄ trạng thái thời gian tương ứng), `post_licenses_id_revoke` (terminal). Lý do ≥ 10 ký tự (DB CHECK). Mọi chuyển → EntitlementChanged.
(Cập nhật — CR-SAS-14) Chỉ license đang sống (Issued|Active|Grace, chưa quá `grace_until` theo đồng hồ server) mới tạm khóa được; reinstate chỉ áp dụng cho Suspended và đưa revision về trạng thái theo đồng hồ (Active nếu đã tới `valid_from`, ngược lại Issued; quá hạn thì Expired), mặc định không lưu lại lý do tạm khóa (audit giữ lý do của từng lần). Hai thao tác đọc phía control plane `getSystemLicense` (`GET /system/licenses/{id}`) và `listSystemTenantLicenses` (`GET /system/tenants/{tenantId}/licenses`, keyset theo serial và revision) cấp quyền `system.tenant.read` (System Admin, Platform Operator, Billing Operator — SAS-12/13/15 ghi "Platform Operator chỉ đọc"), trả `SystemLicense`: toàn bộ revision, kết quả kiểm chữ ký với khóa công khai đã đăng ký (`signature_check`) và `version` dùng cho If-Match; payload `signed_claims` không nằm trong DTO này, màn hình chỉ cần kết quả kiểm. Các lệnh vẫn cần `system.license.manage` (System Admin). Hai thao tác `get_resources_license_revision*` của tenant giữ nguyên, không có signed claims. `getTenantEntitlements` trả thêm `version_id` (id phiên bản quyền hiện hành, chỉ mặt phẳng điều khiển) để form cấp license (SAS-12) ký đúng phiên bản đó.
- Private deployment: offline lease ≤ 30 ngày và ≤ grace_until; xoay khóa có chồng lấn (khóa Retiring vẫn verify tới `not_after`); danh sách kid bị thu hồi phân phối cùng bản cập nhật.

### 3.9 Truy cập hỗ trợ có kiểm soát (SAS-19)
`requestSupportAccess` (ticket bắt buộc tồn tại, scope module/tài nguyên, READ_ONLY|READ_WRITE, ≤ 480 phút) → Requested → `post_support_access_id_approve` bởi TENANT_OWNER/TENANT_ADMIN (≠ operator) → Approved/Active tại `starts_at`; READ_WRITE cần người duyệt thứ hai khác người duyệt thứ nhất (DB CHECK). Mỗi request của operator trong grant: token đặc biệt `act=support`, audit `impersonator_id`; banner thông báo cho Tenant Admin; `revokeSupportAccess` bất kỳ lúc nào; hết hạn → Expired (job mỗi phút).

### 3.10 Xuất dữ liệu tenant (SAS-17)
`post_tenants_id_export` (TENANT_OWNER hoặc System Admin): worker xuất từng bảng tenant-plane thành JSONL/CSV + tệp đính kèm theo prefix; `manifest.json` gồm `schema_version`, danh sách tệp `{path, bytes, sha256}`, `row_counts` theo bảng, thời điểm snapshot (REPEATABLE READ); tùy chọn mã hóa bằng public key khách cung cấp; link tải TTL 72 giờ, kiểm quyền lại khi tải; tải xong → Delivered.

### 3.11 Cờ phát hành (SAS-20) và khôi phục (SAS-21)
`updateFeatureFlag` (If-Match): status Off/Rollout/On/Retired, cohort tenant/danh sách tenant/%; cờ quyết định đường code, **không** thay entitlement thương mại. `requestTenantRestore` → `decideTenantRestore` (≠ người yêu cầu): SANDBOX (mặc định) dựng bản sao tại recovery point trong placement cách ly; IN_PLACE chỉ khi tenant Suspended (409 `TENANT_STATE_INVALID`), có bước đối chiếu row count + tổng tiền trước khi mở lại.

### 3.12 Theme & thương hiệu (SAS-04)
Giữ nguyên đặc tả: chỉ System Admin; nháp tách tenant; review gắn actor/tenant/hash/base version, hạn 15 phút; publish nguyên tử khóa pointer → review → draft; 403/409/422/413. Chốt mã lỗi (BR-SAS-17).
(Cập nhật — CR-SAS-13) Sáu thao tác theme của System Admin (`getSystemTenantThemeDraft`, `putSystemTenantThemeDraft`, `listSystemTenantThemeVersions`, `reviewSystemTenantTheme`, `publishSystemTenantTheme`, `uploadSystemTenantThemeAsset`) thuộc mặt phẳng điều khiển (`x-plane: control`) như mọi thao tác `/system/tenants/*`; thiếu khai báo này thì quyết định chính sách coi chúng là thao tác tenant và từ chối token điều khiển. Review của lần rollback lưu kèm lý do (cột `reason` của `tenant_theme_review`) vì yêu cầu publish chỉ mang token. Quy tắc maker-checker "người duyệt khác người soạn" không áp dụng: review gắn với chính actor yêu cầu (BR-SAS-17).

## 4. State machine

```
Tenant (hợp nhất hai bộ trạng thái v1.3 — CR-SAS-01):
 Requested ──saga start──► Provisioning ──11 bước DONE──► Active ──suspend──► Suspended
                               │                            ▲  │                  │
                               └──bước lỗi vượt retry──► Failed │ resume ◄─────────┘
                                   │ retry ──► Provisioning     │
                                   └ archive(bù trừ) ──► Archived
 Active|Suspended ──offboard──► Offboarding ──archive (export Delivered | hết cửa sổ)──► Archived
 Offboarding ──resume (gia hạn)──► Active
```
| Từ | Command | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|
| — | `requestTenantProvisioning` | Requested | System Admin | mã/subdomain chưa dùng; plan Published | `sas.tenant.requested.v1` |
| Requested | (saga) | Provisioning | system | — | `sas.tenant.status_changed.v1` |
| Provisioning | (saga xong) | Active | system | 11 bước DONE | như trên + `sas.entitlement.changed.v1` |
| Provisioning | (saga lỗi) | Failed | system | vượt retry | như trên |
| Failed | `retryTenantProvisioning` | Provisioning | System Admin | If-Match | như trên |
| Failed | `archiveTenant` | Archived | System Admin | bù trừ xong | như trên |
| Active | `suspendTenant` | Suspended | System Admin | reason_code + lý do | như trên + entitlement |
| Suspended | `resumeTenant` | Active | System Admin | — | như trên |
| Active/Suspended | `startTenantOffboarding` | Offboarding | System Admin | contract_end_date | như trên |
| Offboarding | `archiveTenant` | Archived | System Admin | BR-SAS-03 | như trên |
| Offboarding | `resumeTenant` | Active | System Admin | trong cửa sổ | như trên |

Ánh xạ v1.3: FRD "Requested/Provisioning/Active/Failed" và 05 "Provisioning/Active/Suspended/Offboarding/Archived" → hợp nhất 7 trạng thái trên. Chuyển bị cấm → 409 `TENANT_STATE_INVALID` (ví dụ Active→Archived, Archived→bất kỳ, Requested→Active bỏ qua saga).

```
License: Draft→Issued ──[valid_from]──► Active ──[valid_until]──► Grace ──[grace_until]──► Expired
         Issued|Active|Grace ──suspend──► Suspended ──reinstate──► (trạng thái theo thời gian)
         Issued|Active|Grace|Suspended ──revoke──► Revoked (cuối) ; mọi trạng thái sống ──renew (revision mới Issued)──► Superseded
Subscription: Trialing→Active→PastDue→Active (thanh toán) ; Active|PastDue→Paused ; *→Cancelled (cuối kỳ) ; CONTRACT_TERM hết hạn→Expired
Invoice: Draft→PendingIssue→Issued→Sent→PartiallyPaid→Paid ; Sent→Overdue→Paid ; PendingIssue→IssueFailed→PendingIssue ; Draft→Discarded ;
         Issued|Sent|Overdue|Paid ──(điều chỉnh Issued)──► Adjusted ; ──(thay thế Issued)──► Replaced   [không có trạng thái Cancelled]
Placement migration: Planned→Copying→Verifying→AwaitingCutover→CutoverFrozen→Switched→Completed ; *(trước Completed)→Aborted|RolledBack
Support grant: Requested→Approved→Active→Expired ; Requested→Rejected ; Approved|Active→Revoked
Domain: PendingVerification→Verified→Active→Revoked ; PendingVerification→Failed
Export job: Requested→Running→Ready→Delivered ; Running→Failed ; Ready→Expired
```
Chuyển bị cấm chính: reinstate license Revoked (409 `LICENSE_STATE_INVALID`); issue hóa đơn không Draft/IssueFailed (409 `EINVOICE_STATE_INVALID`); sửa hóa đơn Issued (409 `EINVOICE_IMMUTABLE`); cutover khi verify lệch (422 `MIGRATION_VERIFICATION_FAILED`).

## 5. Quy tắc nghiệp vụ và công thức

- **BR-SAS-01 Mã tenant.** `code` `^[a-z][a-z0-9-]{2,30}$`, duy nhất vĩnh viễn (kể cả Archived); `region ∈ {vn-north, vn-south}` (dữ liệu tại VN — D-B03).
- **BR-SAS-02 Saga idempotent.** Mỗi bước có khóa tự nhiên; chạy lại không tạo bản thứ hai; bù trừ chỉ khi hủy khởi tạo, chạy ngược thứ tự.
- **BR-SAS-03 Lưu trữ tenant.** Archive cần export Delivered hoặc hết cửa sổ; không xóa dữ liệu dưới legal hold; purge theo retention policy.
- **BR-SAS-04 Thanh toán không phải thu hồi.** PastDue/Overdue không đổi trạng thái tenant/license; chỉ System Admin quyết tạm ngừng với `reason_code=NON_PAYMENT` (AC37).
- **BR-SAS-05 Silo.** Cutover chỉ khi row count, checksum PK và Σ tiền numeric(24,0) từng bảng khớp 100%; đóng băng ghi ≤ `write_freeze_max_minutes` (5..240).
- **BR-SAS-06 Hostname.** Duy nhất toàn nền tảng, giữ chỗ 90 ngày sau gỡ; không cấp membership.
- **BR-SAS-07 Gói bất biến.** Published không sửa.
- **BR-SAS-08 Proration.** Nâng gói NOW trong kỳ `[period_start, period_end]` có `D` ngày (tính cả hai đầu): `used = today − period_start` (số ngày đã qua, không tính hôm nay), `remaining = D − used` (tính cả hôm nay), `proration_vnd = floor((new_price − old_price) × remaining / D)` (VND nguyên, làm tròn xuống). Ví dụ: kỳ 2026-01-01..2026-12-31 (D = 365), hôm nay 2026-02-15 → used = 45, remaining = 320, (730.000.000 − 365.000.000) × 320/365 = 320.000.000 VND (UAT-AC155). Hạ gói chỉ NEXT_CYCLE, proration = 0.
- **BR-SAS-09 Quota.** QUOTA kiểm trong transaction với `usage_counter` khóa hàng (`FOR UPDATE`): `used + delta ≤ limit` ngược lại 403 `QUOTA_EXCEEDED`; hạ quota không thu hồi tài nguyên đang dùng, chỉ chặn tạo mới. Ghế `seats` = số membership STAFF Active (không tính SERVICE_ACCOUNT); khách đếm `guest_seats` riêng [GIẢ ĐỊNH].
- **BR-SAS-10 Entitlement.** Hàm `allowed(feature) = plan ⊕ override` với chế độ theo license: Active → FULL; Grace → `grace_behavior`; Expired → `expired_behavior`; Suspended/Revoked license → DENY (trừ đọc/xuất khi tenant policy READ_ONLY_EXPORT). Mặc định STANDARD: reporting ALLOW/READ_ONLY, export ALLOW/EXPORT_ONLY, ai.analysis DENY/DENY, notification.campaign DENY/DENY, member.invite DENY/DENY (AC41, AC42). Override cần bốn mắt và hạn.
- **BR-SAS-11 Cấp license.** `valid_from < valid_until ≤ grace_until` (422 `LICENSE_RANGE_INVALID`), `seats ≥ 1`, `entitlement_version.tenant_id = tenant_id` (422 `LICENSE_TENANT_MISMATCH`), tenant không Archived/Requested (409 `TENANT_STATE_INVALID`), có khóa ký Active (503 `SIGNING_KEY_UNAVAILABLE`).
- **BR-SAS-12 License bất biến.** Revision đã ký không sửa; gia hạn = revision mới; client gửi claims bị bỏ qua — server luôn dùng entitlement của mình.
- **BR-SAS-13 Lập hóa đơn idempotent.** Một ORIGINAL cho mỗi (subscription, period); usage lấy từ `usage_meter_event` theo `occurred_at` trong kỳ, đóng băng khi Issued.
- **BR-SAS-14 Thuế và tiền.** `amount_vnd` nguyên; `vat_vnd = round_half_up(amount_vnd × rate)` theo dòng (rate: NOT_SUBJECT = 0 và ghi "KCT", VAT_0 = 0, VAT_5 = 0,05, VAT_8 = 0,08, VAT_10 = 0,10); `subtotal = Σ amount`, `vat = Σ vat_vnd`, `total = subtotal + vat` (DB CHECK). Mặc định dịch vụ phần mềm `NOT_SUBJECT` [CXN-INV-01]. Không hủy hóa đơn Issued; điều chỉnh/thay thế phải có lý do + văn bản (DB CHECK).
- **BR-SAS-15 Usage bất biến.** `usage_meter_event` chỉ INSERT, unique `(tenant, meter, external_event_key)`; sửa sai bằng sự kiện bù (quantity âm không cho phép — dùng meter `*_correction`) [GIẢ ĐỊNH].
- **BR-SAS-16 Support access.** Ticket + chấp thuận của tenant + ≤ 8 giờ + audit mạo danh; đọc-ghi cần hai người duyệt khác nhau phía tenant; operator không tự gia hạn (request mới).
- **BR-SAS-17 Mã lỗi theme (giải quyết mâu thuẫn v1.3).** Review không hợp lệ vì hết hạn, đã dùng, khác actor, khác tenant hoặc hash draft/asset đã đổi → **409 `REVIEW_INVALID`** (duy nhất; `REVIEW_STALE` trong Module_Implementation_Contracts v1.3 là bí danh bỏ — CR-SAS-02). `baseVersion` ≠ pointer hiện hành khi publish → **409 `VERSION_CONFLICT`**. Không lộ actor khác trong `detail`.

## 6. Dữ liệu

| Bảng | Trường chính (mới/sửa) | Ràng buộc | Phân loại | Lưu giữ |
|---|---|---|---|---|
| `tenant` (control plane, sửa) | + governing_body_type, administrative_code, isolation_mode, lifecycle_reason, write_frozen_until, requested/activated/suspended/offboarding_started/archived_at, version | CHECK status 7 giá trị; FK placement | INTERNAL | vĩnh viễn |
| `placement` (control plane, mới) | kind POOL/SILO, region, db_cluster_ref, kms_key_ref, status, max_tenants | — | CONFIDENTIAL (hạ tầng) | vĩnh viễn |
| `tenant_provisioning_run` (mới) | attempt, temporal_workflow_id, status, current_step, steps_json, error_code | UNIQUE (tenant, attempt) | INTERNAL | 5 năm |
| `tenant_placement_migration` (mới) | from/to_placement_id, status, write_freeze_max_minutes, verification_report_ref, checksum_match, requested_by, cutover_approved_by | 1 migration mở/tenant; bốn mắt | INTERNAL | 5 năm |
| `tenant_domain` (mới) | hostname, kind, txt_token_hash, status, tls_status, tls_expires_at | UNIQUE lower(hostname) trừ Revoked | INTERNAL | 2 năm sau Revoked |
| `product_plan_version`, `plan_feature` (control plane, mới) | plan_code, revision, giá VND, vat_category, features (limit_kind, grace/expired behavior) | UNIQUE (code, revision); UNIQUE (plan, feature) | INTERNAL | vĩnh viễn |
| `subscription` (sửa) | + started_at, trial_ends_at, current_period_start/end, cancel_at_period_end, pending_plan_version_id, pending_effective_at, past_due_since, procurement_contract_ref, version | 1 thuê bao sống/tenant; FK product_plan_version | INTERNAL | 10 năm (chứng từ) |
| `entitlement_version` (mới) | version_no, subscription_id, plan_version_id, features_json, entitlements_hash, cause, effective_from | UNIQUE (tenant, version_no); chỉ INSERT | INTERNAL | vĩnh viễn |
| `entitlement_override` (mới) | feature_code, enabled, limit_value, reason, valid_from/until, status, requested_by, approved_by | bốn mắt; lý do ≥ 10 | INTERNAL | 10 năm |
| `usage_meter_event` (sửa) | + unit, recorded_at | UNIQUE (tenant, meter, external_event_key); quantity ≥ 0 | INTERNAL | 10 năm |
| `usage_counter` (mới) | feature_code, window_start/end, used_value, limit_value, version | UNIQUE (tenant, feature, window_start) | INTERNAL | 2 năm |
| `invoice` (mới) | subscription_id, invoice_code, kỳ, kind, related_invoice_id, correction_reason, agreement_document_ref, status, subtotal/vat/total_vnd numeric(24,0), buyer_snapshot, einvoice_provider/template_code/series/number, tax_authority_code, lookup_code, provider_ref, issued_at, due_at | CHECK total = subtotal + vat; điều chỉnh cần related + lý do; unique số HĐĐT; 1 thay thế/gốc | INTERNAL | 10 năm (Luật Kế toán) [CXN-INV-04] |
| `invoice_line` (sửa) | + line_kind, description, amount_vnd, vat_category, vat_vnd | FK invoice, pricing_version | INTERNAL | như invoice |
| `billing_payment` (mới) | invoice_id, provider, provider_txn_ref, amount_vnd, method, received_at, match_status, matched_by, inbox_event_id, reversal_of_id | UNIQUE (provider, txn_ref) | CONFIDENTIAL | 10 năm |
| `license_revision` (sửa) | + edition, seats, quota_json, issuer, issued_by/at, status_reason, deployment_binding, offline_lease_until, version | CHECK window, lease, lý do; 1 revision sống/serial; FK entitlement_version, signing key | INTERNAL | vĩnh viễn |
| `license_signing_key` (control plane, mới) | id (kid), algorithm, public_key_pem, kms_key_ref, status, not_before/after | — | INTERNAL (public key) | vĩnh viễn |
| `support_access_grant` (sửa) | + request_reason, access_mode, status, requested_at, starts_at, second_approver_id, revoke_reason, version | ≤ 8 giờ; owner ≠ operator; RW cần người thứ hai | CONFIDENTIAL | 5 năm |
| `tenant_export_job` (mới) | scope_json, format, status, manifest_storage_key/sha256, file_count, total_bytes, row_counts, encryption_key_fingerprint, expires_at | Ready ⇒ manifest đủ | INTERNAL | metadata 10 năm, tệp 72 giờ |
| `tenant_restore_request` (mới) | recovery_point, target, reason, status, requested_by, approved_by, verification_report_ref | bốn mắt | INTERNAL | 5 năm |
| `feature_flag` (control plane, mới) | flag_key, rollout_json, status, revision, version | UNIQUE flag_key | INTERNAL | vĩnh viễn |
| `tenant_theme_*` | giữ nguyên; thêm index `tenant_theme_review (tenant_id, actor_id)` | — | PUBLIC/INTERNAL | theo đặc tả theme |

Bảng control plane chạy dưới role `machvon_control` (audience control); bảng có `tenant_id` vẫn bật RLS và control plane `SET LOCAL app.tenant_id` theo tenant đích đã xác thực trong từng transaction (giống theme).

## 7. API / command

| operationId | Method path | x-permission (role) | DTO | Lỗi chính | If-Match |
|---|---|---|---|---|---|
| requestTenantProvisioning | POST /system/tenants | system.tenant.manage (SystemAdmin) | TenantProvisionRequest → 202 TenantLifecycleResult | 409 TENANT_CODE_TAKEN, DOMAIN_TAKEN; 422 PLAN_NOT_PUBLISHED, PLACEMENT_UNAVAILABLE | không |
| retryTenantProvisioning | POST /system/tenants/{tenantId}/provisioning/retry | system.tenant.manage | ReasonOnly | 409 TENANT_STATE_INVALID | có |
| suspendTenant / resumeTenant | POST /system/tenants/{tenantId}/suspend\|resume | system.tenant.manage | TenantSuspend / ReasonOnly | 409 TENANT_STATE_INVALID | có |
| startTenantOffboarding / archiveTenant | POST …/offboard\|archive | system.tenant.manage | TenantOffboard / ReasonOnly | 409 TENANT_STATE_INVALID, EXPORT_NOT_CONFIRMED | có |
| assignTenantOwner | POST /system/tenants/{tenantId}/owners | system.tenant.manage | TenantOwnerAssign | 422 VALIDATION_FAILED | không |
| startSiloPromotion / approvePlacementCutover / abortPlacementMigration | /system/tenants/{tenantId}/placement-migrations, /system/placement-migrations/{migrationId}/cutover\|abort | system.tenant.manage | PlacementMigrationStart / ReasonOnly | 403 SELF_APPROVAL_DENIED; 422 MIGRATION_VERIFICATION_FAILED; 409 MIGRATION_ALREADY_OPEN | trừ start |
| addTenantDomain / verifyTenantDomain / removeTenantDomain | /system/tenants/{tenantId}/domains, /system/tenant-domains/{domainId}/verify\|remove | system.tenant.manage | DomainAdd → DomainChallenge / ReasonOnly | 409 DOMAIN_TAKEN; 422 DOMAIN_UNVERIFIED | trừ add |
| createPlanVersion / publishPlanVersion | /system/plans, /system/plans/{planVersionId}/publish | system.billing.manage | PlanVersionDraft / ReasonOnly | 409 PLAN_VERSION_IMMUTABLE; 422 PLAN_INVALID | publish |
| listPlanVersions | GET /system/plans | system.billing.manage | PlanVersionPage (plan_code, status, cursor, limit) | 422 VALIDATION_FAILED | — |
| createSubscription | POST /system/tenants/{tenantId}/subscriptions | system.billing.manage | SubscriptionCreate | 409 SUBSCRIPTION_EXISTS | không |
| previewPlanChange / changeSubscriptionPlan / cancelSubscription | /system/subscriptions/{subscriptionId}/plan-change-previews\|plan-change\|cancel | system.billing.manage | PlanChange → PlanChangePreview / PlanChangeApply / ReasonOnly | 409 PREVIEW_STALE, SUBSCRIPTION_STATE_INVALID | trừ preview |
| requestEntitlementOverride / decideEntitlementOverride / revokeEntitlementOverride | /system/tenants/{tenantId}/entitlement-overrides, /system/entitlement-overrides/{overrideId}/decision\|revoke | system.billing.manage | EntitlementOverrideRequest / Decision / ReasonOnly | 403 SELF_APPROVAL_DENIED; 422 FEATURE_UNKNOWN | trừ request |
| post_licenses | POST /licenses | system.license.manage (SystemAdmin) | LicenseIssue | 422 LICENSE_RANGE_INVALID, LICENSE_TENANT_MISMATCH; 409 TENANT_STATE_INVALID; 503 SIGNING_KEY_UNAVAILABLE | không |
| renewLicense / suspendLicense / reinstateLicense / post_licenses_id_revoke | POST /licenses/{id}/renew\|suspend\|reinstate\|revoke | system.license.manage | LicenseRenew / ReasonOnly | 409 LICENSE_STATE_INVALID | có |
| runBillingCycle | POST /system/billing-runs | system.billing.manage | BillingRunRequest → 202 | 422 BILLING_PERIOD_INVALID | không |
| issueEInvoice | POST /system/invoices/{invoiceId}/issue | system.billing.manage | ReasonOnly → 202 | 409 EINVOICE_STATE_INVALID; 503 EINVOICE_PROVIDER_UNAVAILABLE | có |
| createAdjustmentInvoice / createReplacementInvoice | POST /system/invoices/{invoiceId}/adjustments\|replacements | system.billing.manage | InvoiceCorrection | 422 EINVOICE_ADJUSTMENT_INVALID; 409 EINVOICE_ALREADY_REPLACED | không |
| matchBillingPayment | POST /system/payments/{paymentId}/match | system.billing.manage | PaymentMatch | 422 AMOUNT_MISMATCH | có |
| receivePaymentWebhook / receiveEInvoiceWebhook | POST /webhooks/payments/{provider}, /webhooks/einvoice/{provider} | webhook.provider (x-public, chữ ký) | ProviderWebhook → WebhookAck | 401 SIGNATURE_INVALID, REPLAY_WINDOW_EXCEEDED | — |
| recordUsageEvent | POST /internal/usage-events | internal.usage.write | UsageEventRecord | 422 METER_UNKNOWN | không |
| post_tenants_id_export | POST /tenants/{id}/export | tenant.export | TenantExportRequest → 202 | 409 EXPORT_ALREADY_RUNNING | có |
| requestSupportAccess / post_support_access_id_approve / revokeSupportAccess | POST /support-access, /support-access/{id}/approve\|revoke | system.support.request / tenant.support.approve | SupportAccessRequest / SupportAccessApproval / ReasonOnly | 403 SELF_APPROVAL_DENIED; 409 SUPPORT_GRANT_INVALID | trừ request |
| updateFeatureFlag | PUT /system/feature-flags/{flagKey} | system.release.manage | FeatureFlagUpdate | 422 FLAG_RULE_INVALID; 409 VERSION_CONFLICT | có |
| requestTenantRestore / decideTenantRestore | POST /system/tenants/{tenantId}/restore-requests, /system/restore-requests/{restoreId}/decision | system.tenant.manage | TenantRestoreRequest / Decision | 403 SELF_APPROVAL_DENIED; 409 TENANT_STATE_INVALID | decision |
| publishSystemTenantTheme (+ 6 lệnh theme có sẵn) | /system/tenants/{tenantId}/theme/* | system.theme.manage | như v1.3 | 409 REVIEW_INVALID, VERSION_CONFLICT; 422; 413 | như v1.3 |
| listSystemTenants / getSystemTenant / getTenantEntitlements / getMyEntitlements | GET | system.tenant.read / session.self | — | — | — |

Rà soát GET scaffold: `tenant` **không expose** tenant-plane (thay bằng `/system/tenants`); `license_revision` **DTO riêng** (tenant thấy edition/hiệu lực/trạng thái, signed_claims chỉ System Admin); `subscription`, `usage_meter_event`, `invoice_line` **DTO riêng** (tenant xem của mình, usage chi tiết chỉ control plane); `support_access_grant` **DTO riêng** (tenant thấy ai, khi nào, phạm vi). Không endpoint nào ghi trực tiếp `status`, `tenant_id`, số tiền hóa đơn đã phát hành.

## 8. UI/UX

| Màn hình | Field thêm / mới | Ghi chú |
|---|---|---|
| SAS-01 | Loại cơ quan chủ quản, Mô hình cách ly, Trạng thái license | P0 |
| SAS-02 | Mã, Loại cơ quan, Mã ĐVHC, Tên đơn vị gốc, Tên miền con | P0; sau gửi chuyển SAS-22 |
| SAS-03 | Vòng đời, Lý do trạng thái, Owner | P0; nút theo state machine |
| SAS-04 | không đổi field; thông điệp lỗi `REVIEW_INVALID` "Bản xem trước không còn hợp lệ — tạo review mới" | P0 |
| SAS-05..11 | xem `screen_catalog.json` (fields thêm có FR nguồn) | SAS-10 thêm ký hiệu, số, mã CQT, loại hóa đơn, trạng thái đối soát |
| SAS-12..16 | Ấn bản, kid, offline lease; Revision, Supersedes, `[from,until)`; Grace mới; hành động + SLO lan truyền; mã sự kiện | SAS-12/13/15 nâng P0 (nền R0) |
| SAS-17..21 | manifest/legal hold; chỉ số vận hành; chế độ truy cập; rollout; báo cáo xác minh | |
| SAS-22 (mới) | Bước, Trạng thái bước, Số lần thử, Mã lỗi, Bù trừ | timeline; nút "Chạy lại từ bước lỗi" |
| SAS-23 (mới) | Placement đích, Cửa sổ đóng băng, Kết quả đối chiếu, Người duyệt cutover, Trạng thái | workflow; bảng đối chiếu từng bảng (đếm/tổng tiền) |
| SAS-24 (mới) | Hóa đơn gốc, Loại xử lý, Lý do, Văn bản thỏa thuận, Dòng điều chỉnh, Tổng sau điều chỉnh | form; không có nút "Hủy hóa đơn" |
| SAS-25 (mới) | Tính năng, Nguồn, Hạn mức, Đã dùng, Chế độ khi grace, Hiệu lực ghi đè, Người duyệt | bảng; hash entitlement hiện hành |

Tenant-plane (Tenant Owner/BILLING_VIEWER) xem bản chỉ đọc của SAS-07/09/10/13/25 qua `getMyEntitlements` và DTO thuê bao; không có nút ghi. Web only. 7 trạng thái chuẩn; trạng thái riêng `provisioning`, `frozen` (đóng băng ghi), `pending-provider` (chờ nhà cung cấp hóa đơn).

## 9. Sự kiện, job, tích hợp, quan sát

- Event: `sas.tenant.requested|status_changed.v1 {tenant_id, from, to, reason_code}`; `sas.placement_migration.started|switched.v1`; `sas.domain.verified|revoked.v1`; `sas.subscription.changed.v1`; `sas.entitlement.changed.v1 {tenant_id, version_no, entitlements_hash, cause}`; `sas.license.issued|renewed|suspended|reinstated|revoked|status_changed.v1`; `sas.invoice.issued.v1`; `sas.payment.matched.v1`; `sas.support_access.requested|approved|revoked.v1`; `sas.tenant_export.ready.v1`; `sas.feature_flag.changed.v1`; `sas.tenant_restore.completed.v1`.
- Temporal: `TenantProvisioningWorkflow`, `PlacementMigrationWorkflow`, `TenantRestoreWorkflow`, `EInvoiceIssueWorkflow` (retry 24 giờ), `TenantOffboardingWorkflow` (nhắc + timer cửa sổ).
- Job (cron): license status mỗi phút; override/support grant hết hạn mỗi phút; billing hằng ngày 02:00; nhắc PastDue hằng ngày; kiểm TLS hằng ngày (gia hạn trước 30 ngày); domain recheck TXT hằng tuần.
- Adapter (K8, trạng thái contract): `EInvoiceProviderPort` — MOCK (R1), nhà cung cấp VN cụ thể **PROPOSED** cho tới khi có hợp đồng (không giả định API); `PaymentGatewayPort` — MOCK; ngân hàng: nhập sao kê tệp (VERIFIED format nội bộ) R1; `DnsPort`/`AcmePort`; `KeycloakAdminPort`; `KmsSignPort`.
- Cache: `ent:{tenant_id}` TTL 60 s; `license:{tenant_id}` TTL 60 s; xóa qua EntitlementChanged.
- Telemetry/SLO: `license_propagation_lag_seconds` p95 ≤ 60; `provisioning_duration_seconds` (mục tiêu < 15 phút); `einvoice_issue_failures_total`; `payment_unmatched_total`; cảnh báo: tenant Failed, IssueFailed, Unmatched > 3 ngày, khóa ký sắp hết hạn 60 ngày.

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Setup | Input/Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC145 | E2E | P0 | control plane sạch | khởi tạo "minh-ha" | Active, 11 bước DONE, đúng dữ liệu seed | Temporal history + DB |
| UAT-AC146 | integration | P0 | DNS lỗi 3 lần | khởi tạo, retry | Failed tại DNS; retry không lặp bước | SAS-22 |
| UAT-AC147 | integration | P0 | key k-147-1 | gửi lại; khác key cùng mã | replay; 409 TENANT_CODE_TAKEN | API log |
| UAT-AC148 | domain | P1 | Active | resume/archive/retry | 409 ×3 | API log |
| UAT-AC149 | integration | P0 | Active | suspend → đọc/ghi/xuất → resume | 200/403/202/ghi lại | audit |
| UAT-AC150 | E2E | P0 | pool → silo | lệch 1 dòng; tự duyệt; duyệt đúng | 422; 403; Completed, tổng khớp | báo cáo đối chiếu |
| UAT-AC151 | integration | P1 | CutoverFrozen | abort | RolledBack, ghi được | DB |
| UAT-AC152 | integration | P1 | DNS mock | add/verify/trùng/giữ chỗ | 201/422/Verified/409/409 | API log |
| UAT-AC153 | security | P0 | domain B | user A | 403 TENANT_SELECTION_INVALID | API log |
| UAT-AC154 | domain | P1 | plan v1 | publish lại; revision 2 | 409; 201 | DB |
| UAT-AC155 | domain | P0 | 365tr → 730tr ngày 46 | preview; stale; apply | 320.000.000; 409; 200 | DB |
| UAT-AC156 | domain | P1 | 120/100 ghế | hạ gói | violation; chặn mời; không xóa | API log |
| UAT-AC157 | integration | P0 | AI enabled | override tắt AI | ≤60s; 403 ENTITLEMENT_DENIED | đo thời gian |
| UAT-AC158 | security | P1 | override chờ | tự duyệt | 403 SELF_APPROVAL_DENIED | DB CHECK |
| UAT-AC159 | domain | P0 | EV-B1 | sai khoảng; khác tenant; seats 0 | 422/422/400 | API log |
| UAT-AC160 | domain | P1 | rev1 | renew | rev2 supersedes; rev1 Superseded | DB + verify chữ ký |
| UAT-AC161 | security | P1 | claims sửa | verify; gửi header | thất bại; bỏ qua | log |
| UAT-AC162 | domain | P1 | Active | suspend/reinstate/revoke/reinstate | 403 khi suspended; 409 sau revoke | API log |
| UAT-AC163 | integration | P1 | 3 thuê bao | billing run ×2 | 3 hóa đơn | DB |
| UAT-AC164 | integration | P0 | Draft | issue ×2; tìm lệnh hủy | Issued; 409; không có | OpenAPI + DB |
| UAT-AC165 | domain | P0 | 365tr Issued | điều chỉnh −36,5tr; thay thế ×2 | Adjusted; 328,5tr; 409 | DB |
| UAT-AC166 | integration | P1 | provider 503 ×2 | issue | 1 hóa đơn bên provider | mock log |
| UAT-AC167 | domain | P1 | Unmatched | ghép sai/đúng | 422; Matched | audit |
| UAT-AC168 | integration | P1 | counter 100 | ghi 2 lần cùng key | 101 | DB |
| UAT-AC169 | security | P1 | ticket | 600 phút; RW thiếu người 2; đủ | 400; ghi 403; Active | audit |
| UAT-AC170 | integration | P1 | cờ Off | rollout pilot; If-Match cũ | A thấy, B không; 409 | API log |
| UAT-AC171 | integration | P1 | recovery point | sandbox; in-place khi Active | Completed; 409 | báo cáo |
| UAT-AC172 | domain | P1 | Offboarding | archive sớm; sau export | 409; Archived | DB |
| UAT-AC173 | UAT | P1 | Platform Operator | mở SAS-18 | chỉ chỉ số vận hành | ảnh chụp |
| UAT-AC174 | security | P1 | Platform Operator | GET/POST tenants | 200/403 | API log |
| UAT-AC175 | security | P0 | theme v4 | review hết hạn; base lệch | REVIEW_INVALID; VERSION_CONFLICT | API log |
| UAT-AC36..AC44 | (viết lại) | P0/P1 | xem `test_cases.json` | webhook trùng, quá hạn, support, export, biên license, grace, expired, AC43, thu hồi ≤60s | | |
| SEC02..05, TH01..05, LIC01, OPS01 | cross-cutting | P0 | | | | |

## 11. Tiêu chí nghiệm thu (đo được)

- AC-SAS-01: Given yêu cầu khởi tạo hợp lệ, Then tenant Active với 11 bước DONE trong < 15 phút; lỗi một bước → Failed, retry không lặp bước đã xong (UAT-AC145, UAT-AC146, UAT-AC147).
- AC-SAS-02: Given tenant ở bất kỳ trạng thái, When gọi chuyển trạng thái không có trong bảng §4, Then 409 TENANT_STATE_INVALID (UAT-AC148).
- AC-SAS-03: Given thanh toán quá hạn, Then tenant và license không tự đổi, dữ liệu không bị xóa (UAT-AC37).
- AC-SAS-04: Given promotion silo, Then cutover chỉ khi đối chiếu khớp, người duyệt ≠ người khởi tạo, đóng băng ≤ giới hạn (UAT-AC150).
- AC-SAS-05: Given đổi gói, Then proration đúng công thức BR-SAS-08 và preview cũ bị từ chối (UAT-AC155).
- AC-SAS-06: Given thay đổi entitlement/license, Then mọi phiên bị áp dụng trong p95 ≤ 60 giây (UAT-AC44, UAT-AC157).
- AC-SAS-07: Given license, Then trạng thái đúng biên `[from,until)` theo đồng hồ server (UAT-AC40, LIC01); grace/expired theo plan_feature (UAT-AC41, UAT-AC42).
- AC-SAS-08: Given Tenant Admin/Owner, Then mọi lệnh license/billing/theme ghi bị 403 (UAT-AC43, SEC02).
- AC-SAS-09: Given hóa đơn đã phát hành, Then không có cách hủy; sai sót tạo hóa đơn điều chỉnh/thay thế có liên kết, tổng phải thu đúng (UAT-AC164, UAT-AC165).
- AC-SAS-10: Given webhook thanh toán trùng/đồng thời, Then đúng một payment (UAT-AC36).
- AC-SAS-11: Given support access, Then cần ticket + chấp thuận tenant + thời hạn + audit mạo danh (UAT-AC38, UAT-AC169).
- AC-SAS-12: Given export, Then manifest checksum khớp 100% và legal hold được tôn trọng khi lưu trữ (UAT-AC39, UAT-AC172).
- AC-SAS-13: Given review theme không hợp lệ, Then mã lỗi duy nhất REVIEW_INVALID (UAT-AC175).

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

- **R0 (nền):** SAS-01/02/03/22 (saga khởi tạo trên Temporal, vòng đời Active/Suspended), SAS-04 theme, entitlement tối thiểu (plan + entitlement_version + EntitlementChanged + cache 60 s — SAS-25 chỉ đọc), license SAS-12/13/15 (issue/status job/revoke), audit.
- **R1:** thuê bao + đổi gói + proration (SAS-07/08/09), hóa đơn điện tử qua adapter MOCK với đầy đủ điều chỉnh/thay thế (SAS-10/24), usage meter (SAS-11), override (SAS-25 ghi), support access (SAS-19), export/offboarding (SAS-17), domain (SAS-05).
- **R2:** silo promotion (SAS-23 — khi có tenant yêu cầu), restore in-place (SAS-21), cờ phát hành cohort (SAS-20), adapter e-invoice/payment thật (khi có hợp đồng — R3), SAS-18 SLO dashboard đầy đủ.
- **Giờ review người (R2-D5):** 20 giờ — **tiền** (BR-SAS-08/13/14, điều chỉnh/thay thế hóa đơn), **quyền** (BR-SAS-10/11/16, AC43), **migration** (hợp nhất trạng thái tenant cũ, `branding_version_id` → pointer theo đặc tả theme), **mẫu pháp lý** (hóa đơn theo NĐ 70/2025).

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| [CXN-INV-01] Dịch vụ phần mềm SaaS thuộc đối tượng không chịu thuế GTGT theo Luật 48/2024/QH15 | Kế toán + Pháp chế | Ý kiến tư vấn thuế; cập nhật `vat_category` mặc định của plan |
| [CXN-INV-02] Điều kiện văn bản thỏa thuận khi điều chỉnh/thay thế và việc bỏ mẫu 04/SS-HĐĐT theo NĐ 70/2025 + TT 32/2025/TT-BTC | Kế toán | Đọc văn bản gốc; chốt trường bắt buộc của `InvoiceCorrection` |
| [CXN-INV-03] Nhà cung cấp hóa đơn điện tử hỗ trợ khóa tham chiếu chống phát hành trùng | Tech Lead + Mua sắm (D05) | Hợp đồng + tài liệu API thật; adapter PROPOSED → VERIFIED |
| [CXN-INV-04] Thời hạn lưu chứng từ kế toán điện tử | Kế toán | Ghi vào `data_retention_policy` |
| [CXN-PROC-01] Mô hình thuê dịch vụ CNTT bằng NSNN (thanh toán theo năm/kỳ, nghiệm thu dịch vụ) ảnh hưởng `cycle`, `due_at` | Chủ nghiệp vụ + Mua sắm | Hợp đồng mẫu tỉnh pilot |
| [GIẢ ĐỊNH] cửa sổ xuất 90 ngày, PastDue 30 ngày, hạ gói chỉ cuối kỳ, khách không tính ghế | PO | Chốt trong hợp đồng mẫu |
| Rủi ro: khóa ký license bị lộ | Security Officer | KMS/HSM, xoay khóa có chồng lấn, danh sách kid thu hồi |
| Rủi ro: logical replication khi silo trên cloud VN chưa xác nhận | Tech Lead hạ tầng | Spike R2 trên nhà cung cấp cloud đã chọn (D02) |
