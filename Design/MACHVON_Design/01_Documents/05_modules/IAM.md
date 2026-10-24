# IAM — Định danh, phiên, mô hình tenant và quyền hiệu lực

Phiên bản đặc tả M1 · 22/10/2026 · Nguồn dữ liệu máy: `work/staging/platform.json` (bảng `user_account`, `membership`, `membership_invitation`, `role_definition`, `role_grant`, `organization_unit`, `user_session`, `support_ticket`; lệnh quản trị thuộc ADM). Quy ước chung (RLS, idempotency, audit/outbox, Problem, i18n, 7 trạng thái UI) theo `04_Thiet_ke_co_ban.md` và `05_Thiet_ke_chi_tiet.md`; dịch vụ nền tảng audit/outbox/idempotency/legal hold đặc tả tại `ADM.md §5.2`. Tài liệu này là nguồn chuẩn của **mô hình tenant R6** và **thuật toán quyết định quyền**; ADM, SAS, mọi phân hệ nghiệp vụ tham chiếu, không chép lại.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Một tỉnh có hàng chục sở/ban, hàng trăm chủ đầu tư và xã, cộng nhà thầu bên ngoài, cùng làm việc trên một danh mục dự án. Tỉnh cần tổng hợp, xếp hạng và điều chuyển vốn toàn tỉnh (nên dữ liệu phải ở **một** ranh giới), nhưng mỗi cán bộ chỉ được thấy/ghi đúng phần việc của đơn vị mình, và nhà thầu chỉ thấy hợp đồng của họ. Cơ cấu tổ chức vừa thay đổi lớn năm 2025 (chính quyền hai cấp tỉnh–xã, bỏ cấp huyện; Sở KH&ĐT hợp nhất vào Sở Tài chính) nên phân quyền phải theo **cây đơn vị có hiệu lực theo thời gian và đơn vị kế thừa**, không gắn cứng cấp hành chính.

**Mô hình tenant (R6 — quyết định đã duyệt D9).**

| Khái niệm | Định nghĩa | Ví dụ |
|---|---|---|
| Tenant | Cơ quan chủ quản ký hợp đồng dịch vụ: UBND tỉnh/thành phố trực thuộc TW (`PROVINCE`) hoặc bộ/cơ quan ngang bộ (`MINISTRY`), cơ quan TW khác (`CENTRAL_AGENCY`). Là ranh giới cách ly dữ liệu (RLS) và ranh giới thương mại (gói, license). Tenant kỹ thuật `PLATFORM_OPERATOR` duy nhất giữ bản ghi control-plane chưa xác định tenant | "UBND tỉnh Minh Hà" |
| Organization unit | Đơn vị trong tenant, tạo cây ≤ 8 cấp: `GOVERNING_BODY` (gốc), `DEPARTMENT` (sở), `PROJECT_MANAGEMENT_BOARD` (Ban QLDA), `INVESTOR` (chủ đầu tư không phải ban), `COMMUNE` (xã/phường/đặc khu), `DIVISION` (phòng), `OTHER`. Cờ `is_investor` cho đơn vị đứng tên chủ đầu tư | A-STC "Sở Tài chính", A-BQLGT "Ban QLDA giao thông", A-XA-AP "xã An Phú" |
| Membership | Quan hệ người dùng ↔ tenant tại một đơn vị: `STAFF` (cán bộ), `GUEST_CONTRACTOR` (khách nhà thầu, bắt buộc `contractor_id` + hạn), `SERVICE_ACCOUNT` (tích hợp) | u.maker @ A-BQLGT |
| Role grant | Vai trò × scope × khoảng hiệu lực: `TENANT`, `UNIT_SUBTREE`, `UNIT_ONLY`, `PROJECT`, `CONTRACT` | SPECIALIST @ UNIT_SUBTREE[A-BQLGT] |
| Control plane | System Admin và các operator nền tảng: realm/audience riêng, **không có membership** trong tenant; vào dữ liệu tenant chỉ qua support access (SAS-19) | sa.root |

Hệ quả bắt buộc: tổng hợp toàn tỉnh nằm trong một tenant; báo cáo lên cơ quan cấp trên đi qua DOC/export, **không đọc chéo tenant**; chuyển dự án giữa đơn vị là command trong tenant (PRJ `project_transfer`), giữa tenant là export/import có audit (SAS); người dùng có thể có membership ở nhiều tenant (ví dụ nhân viên nhà thầu làm cho hai tỉnh) và chọn tenant cho từng phiên.

**Trong phạm vi IAM:** đăng nhập OIDC (Keycloak), MFA và step-up, khôi phục truy cập, chọn tenant/membership cho phiên, hồ sơ cá nhân, phiên & thiết bị, tìm kiếm toàn hệ thống theo quyền, yêu cầu hỗ trợ, màn hình "phạm vi quyền hiệu lực" (IAM-09), **Policy Decision Point** (PDP) dùng chung cho mọi API.

**Ngoài phạm vi:** lệnh quản trị cây đơn vị, thành viên, vai trò, ủy quyền, DoA (ADM); vòng đời tenant, gói, license, entitlement (SAS); dữ liệu danh mục địa bàn/ĐVHC (MDM — IAM chỉ lưu `administrative_code` tham chiếu); sync rules mobile (MOB — IAM cung cấp tham số scope).

**Phụ thuộc:** Keycloak (realm `machvon` dùng Keycloak Organizations ánh xạ 1:1 tenant; realm `machvon-platform` cho control plane; tenant silo có thể dùng realm riêng — K7), SAS (trạng thái tenant + entitlement), ADM (security policy, lịch), CTR (sự kiện `contract.closed` làm hết hạn khách), Redis (deny-list phiên, cache quyền).

**Căn cứ.** Luật Tổ chức chính quyền địa phương 2025 (Luật 72/2025/QH15, hiệu lực 01/7/2025 — hai cấp tỉnh/xã) [CXN-ORG-02]; Nghị quyết 202/2025/QH15 sắp xếp đơn vị hành chính cấp tỉnh [CXN-ORG-03]; NĐ 45/2025/NĐ-CP tổ chức cơ quan chuyên môn thuộc UBND tỉnh (Sở Tài chính tiếp nhận Sở KH&ĐT từ 01/3/2025) [CXN-ORG-01]; Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 + NĐ 356/2025/NĐ-CP (dữ liệu `user_account` là dữ liệu cá nhân cơ bản); Luật An ninh mạng 116/2025/QH15 (hiệu lực 01/7/2026) và hồ sơ cấp độ ATTT dự kiến cấp 3 [CXN-SEC-01]. Thực tiễn: Procore/Aconex (công ty khách giới hạn theo dự án/hợp đồng), Oracle Unifier (phân quyền theo shell/cây), NIST SP 800-63B (AAL2 cho thao tác quản trị).

## 2. Actor, tenant và phạm vi quyền

Danh mục vai trò hệ thống (seed khi provisioning, `is_system=true`, bất biến; tenant tạo thêm vai trò tùy biến rank ≤ 89):

| Mã vai trò | Rank | Cho khách | Quyền tiêu biểu | Ghi chú |
|---|---|---|---|---|
| TENANT_OWNER | 99 | không | toàn bộ quyền tenant-plane, `tenant.support.approve`, `tenant.export` | chỉ System Admin gán (SAS `assignTenantOwner`) theo văn bản đề nghị |
| TENANT_ADMIN | 90 | không | `iam.*` (trừ gán rank ≥ 90), `adm.*`, `audit.read` | không tự có quyền đọc hồ sơ nghiệp vụ (FRD ma trận kiểm soát) |
| SECURITY_ADMIN | 85 | không | `adm.security.*`, `audit.*`, `legal_hold.manage` | |
| UNIT_ADMIN | 70 | không | `iam.member.*`, `iam.role.grant`, `iam.unit.manage` trong subtree | |
| LEADER | 60 | không | `approval.decide`, đọc nghiệp vụ trong scope | MFA bắt buộc |
| NOTIFICATION_ADMIN / OMNI_SUPERVISOR | 50 | không | `notification.*` / `omni.*` | |
| SPECIALIST | 40 | không | thẩm định, return/accept | |
| OMNI_AGENT | 35 | không | `omni.conversation.*` | |
| INVESTOR_OFFICER | 30 | không | tạo/sửa/gửi hồ sơ (maker) | |
| AUDITOR | 25 | không | đọc/xuất, `audit.read` | không mutate |
| BILLING_VIEWER | 20 | không | đọc thuê bao/hóa đơn của tenant | không đọc hồ sơ nghiệp vụ |
| GUEST_CONTRACTOR | 10 | có | đọc hợp đồng được giao, gửi nhật ký/khối lượng/hồ sơ thanh toán | scope chỉ CONTRACT |
| MEMBER | 5 | có | hộp thông báo, hồ sơ cá nhân | mặc định khi chấp nhận lời mời |

| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Người dùng nhân sự | membership STAFF Active trong tenant đã chọn | đăng nhập, chọn tenant, sửa hồ sơ, xem/thu hồi phiên của mình, tìm kiếm trong scope, tạo ticket | dùng `tenant_id`/role từ client làm bằng chứng; xem grant của người khác |
| Khách nhà thầu | membership GUEST_CONTRACTOR, grant CONTRACT[hợp đồng được giao] | như trên trong hợp đồng của mình | thấy dự án/hợp đồng khác (kể cả của cùng nhà thầu chưa được mời); nhận grant UNIT_* |
| TENANT_ADMIN/UNIT_ADMIN | subtree quản trị | (lệnh ở ADM) | gán vai trò rank ≥ rank mình; tự cấp; cấp quyền `system.*` |
| System Admin | control plane, audience `machvon-control` | provisioning, license, theme, gán TENANT_OWNER | đăng nhập tenant-plane bằng tài khoản control plane; đọc dữ liệu tenant không qua support grant |
| Support Operator | control plane | đọc ticket metadata; dữ liệu tenant chỉ qua `support_access_grant` Active | ghi khi grant READ_ONLY |
| Hệ thống (service account) | membership SERVICE_ACCOUNT, scope cấu hình | gọi API nội bộ có `x-plane: internal` | đăng nhập tương tác |

## 3. Luồng nghiệp vụ

### 3.1 Đăng nhập và MFA (IAM-01, IAM-02)
Tiền điều kiện: `user_account.status = Active`. Hậu điều kiện: phiên OIDC hợp lệ, chưa gắn tenant.
1. Web/mobile mở Authorization Code + PKCE tới Keycloak; brute-force: 5 lần sai trong 15 phút → khóa tạm 15 phút (BR-IAM-12).
2. Keycloak trả token `aal1`; nếu `security_policy_version` hiện hành yêu cầu MFA cho bất kỳ vai trò nào người dùng đang giữ → required action TOTP/WebAuthn → `aal2`.
3. Client chuyển IAM-04 (nếu > 1 membership) hoặc gọi thẳng `selectTenantContext` (1 membership).
Lỗi: tài khoản Disabled/Locked → thông điệp chung "Không đăng nhập được, liên hệ quản trị" (không phân biệt lý do). Hủy: người dùng đóng trang → không tạo `user_session`.

### 3.2 Chọn tenant cho phiên (IAM-04) — `selectTenantContext`
1. Client gửi `{tenant_id, membership_id}` + Idempotency-Key.
2. Server (control plane lookup theo `user_account.id` lấy từ `sub`): membership phải thuộc chính subject → nếu không: 403 `TENANT_SELECTION_INVALID` (không nói membership thuộc ai).
3. Kiểm `membership.status = Active` và `valid_from ≤ now < valid_until` → nếu không: 403 `MEMBERSHIP_INACTIVE`. Kiểm tenant `Active|Suspended` (Suspended → phiên chế độ chỉ đọc theo `access_policy`); tenant khác → 403 `TENANT_SUSPENDED`.
4. Kiểm MFA theo vai trò của membership đích; thiếu → 403 `MFA_REQUIRED`.
5. Token exchange Keycloak lấy access token gắn claim `tid`, `mid`, `sv` (scope_version), TTL 5 phút [GIẢ ĐỊNH]; tạo `user_session` (tenant_id = tenant đích); thu hồi token tenant cũ; audit `session.tenant_selected`.
6. Mobile: xóa DB cục bộ PowerSync của tenant cũ trước khi đồng bộ tenant mới (A1); bucket tham số `(tid, mid, sv)`.
(Cập nhật 1.5 — CR-IAM-13) Trong bản triển khai không có Keycloak, API tự phát hành access token tenant (ES256, TTL 5 phút) qua cổng `TenantTokenIssuer`; câu trả lời của `selectTenantContext` (`SessionContext`) bổ sung các trường tùy chọn `access_token`, `token_type`, `expires_in` và `mode` (`FULL` | `READ_ONLY`). Token không bao giờ được lưu trong `idempotency_record`: replay cùng Idempotency-Key trả lại cùng phiên (`sid`) với token mới. Một phiên IdP chọn lại cùng tenant bằng cùng membership dùng lại `user_session` đang sống (hai tab, hai token, một phiên); chọn tenant khác hoặc membership khác thu hồi phiên cũ ngay (deny-list trong tiến trình, tối đa 5 giây ở tiến trình khác).
(Cập nhật 1.5 — CR-IAM-14) Màn chọn tenant (IAM-04) lấy danh sách từ `GET /me/session/tenant-selection/candidates` (`listTenantSelectionCandidates`, xác thực bằng token định danh): chỉ các membership của chính người gọi, kèm tên và trạng thái tenant, không có dữ liệu cá nhân; thiết kế gốc chỉ có `get_resources_membership` (trong phạm vi một tenant) nên không đủ để liệt kê các tenant có thể chọn.
Đồng thời: chọn tenant từ hai tab cùng lúc → mỗi tab nhận token riêng; tab cũ nhận 401 ở lần gọi kế tiếp sau khi token cũ hết hạn/deny-list.

### 3.3 Chấp nhận lời mời — `acceptInvitation`
Lời mời tạo ở ADM (`inviteMember`, `inviteGuestContractor`) với token 32 byte, chỉ lưu `token_hash`, hạn 7 ngày.
1. Người được mời đăng nhập (tạo tài khoản Keycloak nếu chưa có); gửi token.
2. Server so `sha256(email_normalized)` của phiên với `email_hash`; khác → 403 `INVITATION_EMAIL_MISMATCH`.
3. Hết hạn → 409 `INVITATION_EXPIRED`, invitation Expired, membership Expired. Đã dùng → 409 `INVITATION_EXPIRED`.
4. Kiểm quota ghế (SAS entitlement `seats`, khách đếm `guest_seats`) → vượt: 403 `QUOTA_EXCEEDED`.
5. Membership Invited → Active; grant ban đầu (do người mời đề xuất, đã qua kiểm anti-escalation lúc mời) chuyển Active; audit + `iam.membership.activated.v1`.

### 3.4 Quyết định quyền (PDP) cho mọi request
Áp dụng tại API gateway/BFF trước truy vấn; với đọc danh sách, điều kiện scope được biên dịch thành predicate SQL (không lọc sau phân trang).
1. Xác thực token: chữ ký, `aud` (tenant-plane `machvon-api` hoặc control `machvon-control` — lệnh `x-plane: control` từ chối token tenant-plane bằng 403 `SCOPE_DENIED`), `exp`, deny-list `sess:revoked:{sid}`.
2. `SET LOCAL app.tenant_id = tid` trong transaction (RLS ranh giới tenant).
3. Nạp `EffectiveAccess(tid, mid)` từ cache `authz:{tid}:{mid}:{sv}` (TTL 60 giây); cache miss → tính từ DB (BR-IAM-03). Nếu claim `sv` < `scope_version` hiện hành → dùng bản DB mới (quyền bị thu hồi có hiệu lực ngay cả khi token còn hạn).
4. Kiểm `x-permission` của operation ∈ permissions hiệu lực **trên scope chứa tài nguyên đích** (BR-IAM-04); kiểm entitlement feature của operation (SAS, BR-SAS-10); kiểm classification (AI/OMNI).
5. Với lệnh có `x-step-up: aal2` (phê duyệt, cấp quyền, lệnh tiền): token phải aal2 → nếu không 403 `MFA_REQUIRED`.
6. Kết quả: allow → handler; deny → 403 `SCOPE_DENIED`/`ENTITLEMENT_DENIED` (hoặc 404 `RESOURCE_NOT_FOUND` khi tài nguyên ngoài scope đọc, để không lộ tồn tại) + audit outcome DENIED cho lệnh ghi.

### 3.5 Phiên và thiết bị (IAM-06)
`revokeMySession`: ghi `revoked_at`, đẩy `sid` vào deny-list Redis (TTL = thời hạn refresh token), gọi backchannel logout Keycloak; nếu phiên có `device_registration_id` → gỡ push token. Hiệu lực ≤ 60 giây (cùng SLO với thu hồi quyền). Đăng xuất từ mobile = revoke phiên + xóa DB cục bộ + gỡ token push.

### 3.6 Yêu cầu hỗ trợ (IAM-08)
`createSupportTicket` tạo `support_ticket` (mã `SUP-YYYY-NNNNNN`, SLA theo priority: P1 4 giờ, P2 1 ngày làm việc, P3 3 ngày, P4 10 ngày [GIẢ ĐỊNH]). Operator thấy metadata ticket ở control plane; muốn xem dữ liệu phải xin `support_access_grant` (SAS-19) — ticket là điều kiện cần, không đủ.

### 3.7 Tìm kiếm (IAM-07)
`searchGlobal` đọc projection (OpenSearch/pg_trgm) có trường `tenant_id`, `scope_paths[]`, `classification`; truy vấn luôn thêm filter tenant + giao với scope paths của EffectiveAccess; không trả `total` khi có phần bị lọc; mở kết quả gọi lại API chi tiết (kiểm quyền lần hai).

## 4. State machine

Membership (lệnh ở ADM, IAM áp dụng khi quyết định quyền):
```
 Invited ──accept──► Active ──suspend──► Suspended ──reactivate──► Active
   │                   │                     │
   │expire/revoke      └──end/contract.closed┴──end──► Ended
   ▼
 Expired
```
| Từ | Command | Đến | Ai | Guard | Audit/Event |
|---|---|---|---|---|---|
| Invited | `acceptInvitation` | Active | người được mời | token đúng, email khớp, chưa hạn, còn ghế | `membership.invitation_accepted`, `iam.membership.activated.v1` |
| Invited | (job hết hạn) / `endMembership` | Expired | system / UNIT_ADMIN | quá 7 ngày | `iam.membership.ended.v1` |
| Active | `suspendMembership` | Suspended | `iam.member.manage` trong subtree, rank > rank người bị khóa | không phải chính mình | `iam.membership.suspended.v1`, `iam.access.changed.v1` |
| Suspended | `reactivateMembership` | Active | như trên | còn ghế | `iam.membership.activated.v1` |
| Active/Suspended | `endMembership` / `contract.closed` (khách) | Ended | như trên / system | không phải TENANT_OWNER cuối | `iam.membership.ended.v1` |

Phiên (`user_session`): `Active → Revoked` (revoke/đổi tenant/khóa membership) hoặc `Active → Expired` (quá `session_max_hours` của security policy). Chuyển bị cấm: Ended/Expired → bất kỳ (409 `MEMBERSHIP_STATE_INVALID`; muốn quay lại phải mời mới); Revoked → Active.

`user_account`: `Active ⇄ Locked` (Keycloak brute-force/Tenant Admin yêu cầu), `Active → Disabled` (System Admin, khi người dùng không còn membership nào 180 ngày [GIẢ ĐỊNH]).

## 5. Quy tắc nghiệp vụ và công thức

- **BR-IAM-01 Ranh giới tenant.** Mọi bảng tenant-plane có `tenant_id` + RLS ENABLE/FORCE; `app.tenant_id` chỉ lấy từ claim `tid` đã xác thực; header `X-Tenant-ID` chỉ là đề nghị khi chọn tenant. Đọc tài nguyên ngoài tenant → 404, không bao giờ 403 có tên tenant.
- **BR-IAM-02 Chọn tenant.** Chỉ membership của chính subject, Active, trong khoảng hiệu lực `[valid_from, valid_until)`.
- **BR-IAM-03 Quyền hiệu lực.** `Effective(m, r) = ⋃ { perms(role) | grant g của m, g.status=Active, g.effective_from ≤ now < g.effective_until, r ∈ scope(g) } ∪ ⋃ { d.permissions | delegation d tới m Active, r ∈ scope(d) }`, sau đó `∩ entitlement(tenant) ∩ feature_policy(license_state)`. Membership không Active → tập rỗng. `scope_version` của membership tăng mỗi khi grant/delegation/membership/đơn vị trong scope thay đổi.
- **BR-IAM-04 Scope theo cây.** `organization_unit.path` dạng `/<root>/<…>/<id>/`. `UNIT_SUBTREE[u]` chứa tài nguyên có `owner_unit.path LIKE u.path || '%'` tại ngày nghiệp vụ (mặc định hôm nay; báo cáo as-of dùng cây tại as-of). `UNIT_ONLY[u]` chỉ đúng `u`. `PROJECT[p]` chứa dự án p và tài nguyên con. `CONTRACT[c]` chứa hợp đồng c và tài nguyên con (nghiệm thu, khối lượng, thanh toán, nhật ký) cùng dự án cha ở chế độ tóm tắt (che kế hoạch vốn). `TENANT` = toàn tenant (chỉ TENANT_OWNER/TENANT_ADMIN/AUDITOR được cấp).
- **BR-IAM-05 Chống tự nâng quyền.** Grant (hoặc tạo/sửa vai trò) hợp lệ khi đồng thời: (a) người cấp có `iam.role.grant` trên scope S_g ⊇ scope yêu cầu (ngược lại 403 `SCOPE_OUT_OF_GRANTOR_RANGE`); (b) `rank(role) < max rank của người cấp trong S_g` — **không ai cấp vai trò bằng hoặc cao hơn vai trò cao nhất của chính mình** (403 `ROLE_ESCALATION_DENIED`); (c) `perms(role) ⊆ Effective(người cấp, S_g)` (403 `ROLE_ESCALATION_DENIED`); (d) người nhận ≠ người cấp (403 `SELF_GRANT_DENIED`); (e) vai trò không chứa quyền `system.*` — kiểm ở API (422 `SYSTEM_PERMISSION_NOT_GRANTABLE`) và DB (CHECK `role_definition`). TENANT_OWNER (99) vì vậy chỉ được gán từ control plane. Thao tác lên người khác (khóa/kết thúc/thu hồi) cũng yêu cầu rank người thao tác > rank cao nhất của người bị tác động.
- **BR-IAM-06 Vai trò hệ thống bất biến.** `is_system=true` không sửa được (409 `SYSTEM_ROLE_IMMUTABLE`); vai trò tùy biến rank 1..89; đổi permissions của vai trò tùy biến tăng `scope_version` của mọi membership đang giữ.
- **BR-IAM-07 Không tự thao tác.** Không tự khóa/kết thúc/hạ quyền chính mình (403 `SELF_ACTION_DENIED`); không kết thúc/thu hồi TENANT_OWNER cuối cùng (409 `LAST_TENANT_OWNER`).
- **BR-IAM-08 Khách nhà thầu.** `membership_type=GUEST_CONTRACTOR` ⇒ `contractor_id` bắt buộc, `valid_until` bắt buộc (≤ ngày kết thúc hợp đồng xa nhất + 365 ngày [GIẢ ĐỊNH]); chỉ nhận vai trò `guest_allowed`, scope `CONTRACT` với hợp đồng thuộc đúng `contractor_id` và đang hiệu lực (422 `GUEST_SCOPE_INVALID` / `CONTRACT_NOT_ACTIVE`). Sự kiện `contract.closed`/`contract.terminated` → grant CONTRACT tương ứng Expired; hết grant → membership Ended.
- **BR-IAM-09 Cây đơn vị.** Không vòng (422 `UNIT_CYCLE`), độ sâu ≤ 8 (422 `UNIT_DEPTH_EXCEEDED`), mã duy nhất trong đơn vị Planned/Active (409 `UNIT_CODE_TAKEN`), `valid_from < valid_until`, hiệu lực con nằm trong hiệu lực cha (422 `UNIT_VALIDITY_INVALID`). Không xóa đơn vị; kết thúc bằng tổ chức lại (BR-IAM-10).
- **BR-IAM-10 Kế thừa đơn vị.** Sáp nhập/chia tách/giải thể (ADM-16) ghi `organization_unit_succession` (n–n) và `successor_id` (kế thừa mặc định). Saga áp dụng: membership chuyển đơn vị theo mapping; grant trên đơn vị cũ được **tạo mới** trên đơn vị kế thừa (`reorganization_id`) và grant cũ Expired — không sửa grant cũ; dự án chuyển qua command PRJ `project_transfer`. Mapping phải phủ 100% membership Active và dự án chưa CLOSED của đơn vị cũ (422 `REORG_MAPPING_INCOMPLETE`). Ví dụ 2025: A-SKHDT `valid_until=2025-03-01`, `successor_id=A-STC` [CXN-ORG-01]; A-HUYEN-HB giải thể 2025-07-01, chia về A-XA-AP và A-XA-BM [CXN-ORG-02]. Báo cáo có as-of trước ngày hiệu lực hiển thị tên đơn vị cũ.
- **BR-IAM-11 MFA/step-up.** Vai trò trong `security_policy_version.mfa_required_roles` (mặc định LEADER, SECURITY_ADMIN, TENANT_ADMIN, TENANT_OWNER) phải aal2 khi chọn tenant; mọi lệnh có `x-step-up: aal2` (decideApprovalTask, grantRole, revokeRoleGrant, lệnh tiền PAY) yêu cầu aal2 trong 15 phút gần nhất [GIẢ ĐỊNH]. System Admin luôn aal2 (WebAuthn).
- **BR-IAM-12 Chống dò tài khoản.** Đăng nhập/khôi phục trả cùng thông điệp, cùng status, chênh p50 < 100 ms giữa email có và không có; khóa 15 phút sau 5 lần sai.
- **BR-IAM-13 Thu hồi lan truyền.** Từ commit thu hồi (grant, membership, delegation, license, tenant suspend) tới lần từ chối đầu tiên ở mọi phiên: p95 ≤ 60 giây (event `iam.access.changed.v1` xóa `authz:{tid}:{mid}:*`; token mang `sv` cũ bị so với DB).

## 6. Dữ liệu

| Bảng | Trường chính (mới/sửa) | Ràng buộc / index | Owner | Phân loại | Lưu giữ |
|---|---|---|---|---|---|
| `user_account` (control plane, mới) | id, idp_subject, email_normalized, display_name, phone_e164, locale, time_zone, status, version | UNIQUE idp_subject, email_normalized; không tenant_id, không grant data-plane; tenant đọc qua view `tenant_user_directory` (security_invoker, join membership) | IAM | PERSONAL | đến 5 năm sau membership cuối kết thúc [GIẢ ĐỊNH] rồi ẩn danh |
| `organization_unit` (sửa) | + unit_type, administrative_code, is_investor, path, depth, status (Planned/Active/Superseded/Dissolved), legal_basis_ref, version | CHECK validity, no-self; FK successor; UNIQUE (tenant,code) partial Active; index path text_pattern_ops | IAM/ADM | INTERNAL | vĩnh viễn (lịch sử tổ chức) |
| `membership` (sửa) | + membership_type, contractor_id, valid_from, invited_by, ended_reason, version | CHECK guest⇔contractor_id; guest cần valid_until; FK user_account, contractor; UNIQUE live (tenant,user,unit) | IAM/ADM | PERSONAL (liên kết người) | 10 năm sau Ended (bằng chứng trách nhiệm) [CXN-RET-01] |
| `role_definition` (mới) | code, name, permissions text[], rank 1..99, is_system, guest_allowed, status | UNIQUE (tenant,code); CHECK không chứa `system.*` | IAM/ADM | INTERNAL | vĩnh viễn |
| `role_grant` (sửa) | + scope_kind, scope_ref_ids uuid[], status, granted_by, grant_reason, reorganization_id, revoked_by/at/reason, version | CHECK window, scope cardinality 1..200, revoke⇔revoked_at; FK role_definition, unit_reorganization; GIN scope_ref_ids | IAM/ADM | INTERNAL | 10 năm |
| `membership_invitation` (mới) | membership_id, email_hash, token_hash, invited_by, expires_at, status | UNIQUE token_hash | IAM | PERSONAL (hash) | 1 năm |
| `user_session` (mới) | user_account_id, membership_id, idp_session_id, device_registration_id, assurance_level, ip_hash, user_agent_summary, last_seen_at, revoked_at | UNIQUE (tenant, idp_session_id) | IAM | PERSONAL | 180 ngày (AUTO_PURGE_TECHNICAL) |
| `support_ticket` (mới) | ticket_code, requester_membership_id, category, subject, description_ref, priority, status, sla_due_at | UNIQUE (tenant, ticket_code) | IAM/SAS | INTERNAL | 5 năm |

Bất biến DB: grant không xóa (chỉ Revoked/Expired); `scope_json` giữ bản chuẩn `{kind, ref_ids, path_prefixes}` đồng bộ với `scope_kind/scope_ref_ids` (backfill khi expand). Index cho mọi cột `*_id` theo `(tenant_id, col)` có trong SQL fragment.

## 7. API / command

| operationId | Method path | x-permission | Request DTO | Response | Lỗi | Idem | If-Match |
|---|---|---|---|---|---|---|---|
| selectTenantContext | POST /me/session/tenant-selection | session.self | TenantSelection {tenant_id, membership_id} | SessionContext | 403 TENANT_SELECTION_INVALID, MEMBERSHIP_INACTIVE, TENANT_SUSPENDED, MFA_REQUIRED | có | không |
| updateMyProfile | PUT /me/profile | profile.self | ProfileUpdate {display_name, locale, time_zone, phone_e164} | UserProfile | 422 VALIDATION_FAILED, 409 VERSION_CONFLICT, 428 | có | có |
| revokeMySession | POST /me/sessions/{sessionId}/revoke | session.self | ReasonOnly | CommandResult | 404 | có | không |
| revokeMyDevice | POST /me/devices/{deviceId}/revoke | session.self | ReasonOnly | CommandResult | 404 | có | không |
| acceptInvitation | POST /memberships/invitations/{invitationId}/accept | invitation.accept | InvitationAccept {token} | SessionContext | 403 INVITATION_EMAIL_MISMATCH, QUOTA_EXCEEDED; 409 INVITATION_EXPIRED | có | không |
| createSupportTicket | POST /support-tickets | support.ticket.create | SupportTicketCreate | CommandResult 201 | 422 | có | không |
| get_resources_support_ticket | GET /resources/support_ticket | support.ticket.read | status, limit, cursor | danh sách yêu cầu hỗ trợ: của chính người gọi, hoặc của cả tenant với người giữ `support.ticket.manage`; không kèm nội dung mô tả | 422 | không | không |
| getMyEffectiveAccess | GET /me/effective-access | session.self | — | EffectiveAccess (x-exposure dto) | 401 | — | — |
| searchGlobal | GET /search?q= | search.use | — | SearchPage (dto) | 401, 403 | — | — |

Đăng nhập, MFA, khôi phục là luồng Keycloak (không có API nghiệp vụ). Rà soát GET scaffold: `organization_unit` **giữ** (DTO đọc theo subtree), `membership` **DTO riêng** (che email/điện thoại trừ `iam.member.read_pii`), `role_grant` **DTO riêng** (chỉ grant trong subtree người đọc quản trị), `tenant` **không expose** ở tenant-plane (thay bằng `GET /system/tenants`). Không có endpoint ghi chung cho status, tenant_id hay role — đổi quyền chỉ qua lệnh ADM.

## 8. UI/UX

| Màn hình | Thay đổi | Ghi chú |
|---|---|---|
| IAM-01 | + "Nhà cung cấp định danh (OIDC)", "Thông báo phiên hết hạn" | form auth của doc 06; trạng thái riêng `locked` (đếm ngược 15 phút, không nói lý do) |
| IAM-02 | + "Phương thức (TOTP/WebAuthn)", "Thiết bị tin cậy" | step-up dạng dialog giữ form đang nhập |
| IAM-03 | + "Kênh nhận mã" | thông điệp trung tính BR-IAM-12 |
| IAM-04 | + "Loại membership (nhân sự/khách)", "Trạng thái tenant" | thẻ (cards); tenant Suspended có badge cảnh báo và chế độ chỉ đọc |
| IAM-05 | + "Số điện thoại", "Phiên bản" | 409 hiển thị so sánh và giữ dữ liệu nhập |
| IAM-06 | + "Mức xác thực", "Thu hồi phiên" | phiên hiện tại không có nút thu hồi (dùng đăng xuất) |
| IAM-07 | + "Kết quả theo quyền" | không hiển thị tổng số khi bị lọc |
| IAM-08 | + "Mã yêu cầu", "Hạn SLA", "Cho phép truy cập hỗ trợ" | liên kết sang yêu cầu support access đang chờ duyệt |
| IAM-09 (mới) | Vai trò, Phạm vi, Hiệu lực, Ủy quyền nhận, Quyền lợi gói | trang detail; mỗi scope hiển thị breadcrumb cây đơn vị; trạng thái `stale` khi `scope_version` đổi (banner "quyền vừa thay đổi — tải lại") |

Đủ 7 trạng thái chuẩn (loading, empty, error, denied, stale, offline, success). Mobile: IAM-01/02/04/06 có biến thể Flutter (MOB) dùng cùng API; đổi tenant trên mobile luôn hiển thị cảnh báo mất nháp chưa đồng bộ. Component theo doc 06 (form auth, card list, detail panel), token từ `design_tokens.json`.

## 9. Sự kiện, job, tích hợp, quan sát

- Event (outbox, schema v1): `iam.session.tenant_selected.v1 {tenant_id, membership_id, session_id}`; `iam.session.revoked.v1`; `iam.membership.invited|activated|suspended|ended.v1 {membership_id, type, unit_id}`; `iam.role_grant.created|revoked.v1 {grant_id, membership_id, role_code, scope_kind}`; `iam.access.changed.v1 {membership_id, scope_version}` — consumer: cache authz, PowerSync (đổi bucket), NOT (gỡ người nhận), search projection.
- Consumer IAM: `contract.closed.v1`/`contract.terminated.v1` (CTR) → hết hạn grant khách; `sas.tenant.status_changed.v1` → deny-list toàn tenant khi Suspended NO_ACCESS; `sas.entitlement.changed.v1` → xóa `authz:{tid}:*`.
- Job: hết hạn lời mời (mỗi giờ); hết hạn grant/delegation theo `effective_until` (mỗi phút, phát `iam.access.changed.v1`); khóa tài khoản không dùng 180 ngày (hằng ngày, chỉ đề xuất).
- Cache: `authz:{tid}:{mid}:{sv}` TTL 60 giây; `sess:revoked:{sid}` TTL = refresh token lifetime; key luôn có tenant prefix.
- PowerSync (A1): bucket parameter `(tid, mid, sv)`; sync rules dùng cùng predicate scope BR-IAM-04; khi `sv` tăng, bucket cũ bị bỏ ở lần sync kế.
- Telemetry: `authz_decision_total{outcome,reason}`, `access_revocation_lag_seconds` (p95 ≤ 60), `tenant_selection_failures_total{code}`; log không chứa email/điện thoại (chỉ user_id).

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Setup | Input/Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC100 | security | P0 | P-B1 của tenant B | GET project/search/unit của B từ phiên A | 404; search rỗng không total | API log + SQL log |
| UAT-AC101 | security | P0 | membership Suspended ở B | chọn membership người khác; Suspended; của mình | 403 TENANT_SELECTION_INVALID; 403 MEMBERSHIP_INACTIVE; 200 | API log + audit |
| UAT-AC102 | security/E2E | P0 | mobile đã sync 15 dòng A | đổi sang B; dùng token cũ | 401; DB cục bộ không còn A | thiết bị + bucket |
| UAT-AC103 | security | P0 | TENANT_ADMIN rank 90 | gán TENANT_ADMIN; gán UNIT_ADMIN | 403 ROLE_ESCALATION_DENIED; 201 | audit |
| UAT-AC104 | security | P0 | UNIT_ADMIN | tự gán LEADER | 403 SELF_GRANT_DENIED | audit DENIED |
| UAT-AC105 | security | P0 | UNIT_ADMIN subtree BQLGT | gán scope A-STC; scope PKT | 403 SCOPE_OUT_OF_GRANTOR_RANGE; 201 | audit |
| UAT-AC106 | security | P0 | — | vai trò chứa system.*, quyền không có, rank 95 | 422; 403; 400 | DB CHECK |
| UAT-AC107 | security | P0 | SPECIALIST subtree BQLGT | đọc P-01, P-02 | 200; 404 | API log |
| UAT-AC108 | security | P0 | khách HD-001 | đọc HD-001/HD-002; gán UNIT_SUBTREE | 200/404; 422 GUEST_SCOPE_INVALID | API log |
| UAT-AC109 | integration | P1 | grant khách | contract.closed | grant Expired ≤60s | outbox + API |
| UAT-AC115 | security | P1 | lời mời 7 ngày | sai email; quá hạn | 403; 409 INVITATION_EXPIRED | DB |
| UAT-AC119 | UAT | P1 | grant + ủy quyền | thu hồi grant | scope_version tăng | IAM-09 ảnh chụp |
| UAT-AC120 | security | P1 | 2 phiên | revoke S2 | S2 401, S1 200 | Keycloak log |
| UAT-AC121 | security | P0 | LEADER aal1 | phê duyệt; step-up | 403 MFA_REQUIRED; 200 | audit |
| UAT-AC122 | domain | P1 | profile v4 | không If-Match; "3"; "4" | 428; 409; 200 | API log |
| UAT-AC123 | security | P1 | email có/không | 20 lần mỗi loại | cùng body; Δp50 < 100 ms | đo thời gian |
| UAT-AC124 | security | P1 | Keycloak lockout | 5 lần sai | khóa 15 phút | audit |
| UAT-AC125 | security | P1 | ticket | operator đọc dữ liệu | 403 SCOPE_DENIED | audit |
| UAT-AC153 | security | P0 | domain B đã xác minh | user A vào domain B | 403 TENANT_SELECTION_INVALID | API log |
| UI-IAM-09 | screen-contract | P0 | route IAM-09 | mở, 7 trạng thái | đúng trường; denied khi không phiên | ảnh chụp |

Kiểm thử bổ sung tự động (không phải UAT): property-based cho BR-IAM-05 (sinh ngẫu nhiên cây ≤ 8 cấp, 50 vai trò, 200 grant; bất biến "không có chuỗi grant nào làm người cấp nhận được quyền mới"); test RLS trên mọi bảng của fragment với `app.tenant_id` rỗng/khác.

## 11. Tiêu chí nghiệm thu (đo được)

- AC-IAM-01: Given người dùng tenant A, When truy cập bất kỳ ID tài nguyên của tenant B qua API/search/export, Then 404 và không có dòng B rời DB (UAT-AC100, SEC01).
- AC-IAM-02: Given membership không phải của mình hoặc không Active, When chọn tenant, Then 403 với mã tương ứng và không cấp token (UAT-AC101).
- AC-IAM-03: Given đổi tenant trên mobile, When đồng bộ, Then dữ liệu tenant cũ bị xóa cục bộ và token cũ bị từ chối trong ≤ 60 giây (UAT-AC102).
- AC-IAM-04: Given người cấp rank R, When gán vai trò rank ≥ R, tự cấp, vượt scope hoặc chứa quyền system.*, Then 403/422 và không có grant mới (UAT-AC103..106).
- AC-IAM-05: Given grant UNIT_SUBTREE, When đọc tài nguyên ngoài subtree, Then 404 (UAT-AC107).
- AC-IAM-06: Given khách nhà thầu, When đọc hợp đồng chưa được mời, Then 404; When hợp đồng đóng, Then quyền mất trong ≤ 60 giây (UAT-AC108, UAT-AC109).
- AC-IAM-07: Given LEADER chưa step-up, When phê duyệt, Then 403 MFA_REQUIRED (UAT-AC121).
- AC-IAM-08: Given thu hồi quyền, When đo từ commit, Then p95 thời gian tới lần từ chối đầu ≤ 60 giây (UAT-AC119, UAT-AC120, UAT-AC44).
- AC-IAM-09: Given email tồn tại hoặc không, When khôi phục/đăng nhập sai, Then phản hồi không phân biệt được (UAT-AC123, UAT-AC124).

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

- **R0/R1 (dùng thật):** Keycloak realm + Organizations, đăng nhập/MFA/khôi phục, chọn tenant, PDP với scope TENANT/UNIT_SUBTREE/UNIT_ONLY/PROJECT/CONTRACT, anti-escalation BR-IAM-05 đầy đủ, khách nhà thầu, phiên/thiết bị, thu hồi ≤ 60 giây, IAM-09, audit mọi quyết định ghi.
- **R2:** tìm kiếm toàn hệ thống trên projection riêng (R1 dùng tìm kiếm theo phân hệ); SSO liên kết IdP của tỉnh/VNeID (đang chờ D02); ẩn danh `user_account` tự động; báo cáo truy cập định kỳ (access review) cho Security Admin.
- **Giờ review người (R2-D5):** 10 giờ — hạng mục bắt buộc người duyệt: **quyền** (BR-IAM-03..08, ma trận vai trò seed), **migration** (backfill `path`, `scope_kind` từ `scope_json`, gán `user_account` cho membership cũ).

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner (vai trò) | Điều kiện giải quyết |
|---|---|---|
| [CXN-ORG-01] NĐ 45/2025/NĐ-CP và quyết định của từng tỉnh về hợp nhất Sở KH&ĐT vào Sở Tài chính (ngày hiệu lực thực tế từng tỉnh) | Chủ nghiệp vụ tỉnh pilot + Pháp chế | Văn bản gốc của tỉnh pilot đính kèm vào `unit_reorganization.legal_basis_ref` |
| [CXN-ORG-02]/[CXN-ORG-03] Luật 72/2025/QH15 và NQ 202/2025/QH15 — danh mục xã/phường mới và mã ĐVHC | Chủ nghiệp vụ + MDM steward | MDM nạp danh mục ĐVHC chính thức; `administrative_code` đối chiếu 100% |
| [CXN-SEC-01] Văn bản thay NĐ 85/2016 về cấp độ ATTT; yêu cầu MFA với cấp độ 3 | Security Officer | Hồ sơ cấp độ được duyệt; cập nhật `mfa_required_roles` mặc định |
| [CXN-RET-01] Thời hạn lưu membership/grant làm bằng chứng trách nhiệm | Pháp chế | Ghi vào `data_retention_policy` |
| [GIẢ ĐỊNH] Access token 5 phút, step-up 15 phút, khách valid_until ≤ hợp đồng + 365 ngày | Security Officer | Xác nhận trong ADM-14 trước UAT |
| Keycloak Organizations đủ ổn định cho multi-tenant (bản ≥ 26) | Tech Lead | Spike R0: 2 tenant, 1 user ở cả hai, token exchange gắn `tid` |
| Rủi ro hiệu năng predicate subtree khi cây lớn | Tech Lead | Benchmark 5.000 đơn vị, 50.000 grant; p95 PDP < 20 ms với cache |
