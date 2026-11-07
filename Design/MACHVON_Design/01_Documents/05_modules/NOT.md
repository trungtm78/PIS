# NOT — Notification Center: sự kiện → luồng → đồng ý → gửi đa kênh

Phiên bản đặc tả M1 · 22/10/2026 · Nguồn dữ liệu máy: `work/staging/platform.json` (bảng `notification_event_type`, `workflow_version` kind NOTIFICATION, `notification_template_version`, `notification_instance`, `delivery_attempt`, `notification_preference`, `contact_consent`, `notification_campaign`, `device_registration`, `channel_account`, `integration_event_inbox`). OMNI dùng chung mẫu, consent, tài khoản kênh và inbox webhook; hội thoại hai chiều đặc tả ở `OMNI.md`.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Giải ngân chậm thường do việc bị bỏ quên: hạn báo cáo tuần, hồ sơ chờ duyệt, bảo lãnh sắp hết hạn, yêu cầu giải trình. Cán bộ cần được nhắc đúng người, đúng kênh, không trùng, không làm phiền ngoài giờ, và tin quan trọng phải có xác nhận đã nhận. Nhắn qua Zalo/WhatsApp/SMS tới số cá nhân là xử lý dữ liệu cá nhân, cần đồng ý theo từng mục đích (Luật BVDLCN 2025). Bản v1.3 có ba định nghĩa khóa chống trùng khác nhau, lịch retry 4 mốc nhưng "cap 5 lần", và nhập nhằng giữa "đã đọc" và "đã xác nhận".

**Trong phạm vi:** NOT-01..17 — hộp thông báo cá nhân và xác nhận (NOT-01/02), tùy chọn kênh/giờ yên lặng/digest (NOT-03), đồng ý và rút đồng ý (NOT-17), vận hành và chi phí (NOT-04/11/12/13/15), danh mục sự kiện (NOT-05), dựng luồng (NOT-06), mẫu đa kênh và duyệt mẫu nhà cung cấp (NOT-07/08), chiến dịch diện rộng có maker-checker (NOT-09/10/16), thiết bị push (NOT-14). Kênh: IN_APP, EMAIL, PUSH (FCM/APNs), SMS, ZALO_ZNS, ZALO_OA (gửi chủ động theo mẫu), WHATSAPP (mẫu ngoài cửa sổ 24h).

**Ngoài phạm vi:** hội thoại hai chiều, gán người xử lý, SLA hội thoại (OMNI); nội dung nghiệp vụ của sự kiện (phân hệ phát sự kiện); kênh vận hành sự cố nền tảng (pager độc lập, không qua NOT — 04 §Triển khai).

**Phụ thuộc:** outbox của mọi phân hệ (nguồn sự kiện), IAM (người nhận, quyền đọc tài nguyên), ADM (lịch làm việc, quy trình phê duyệt chiến dịch), SAS (entitlement `notification.campaign`, meter `notification.<channel>`), MOB (đăng ký thiết bị, MOB-05/32/33/34), adapter kênh (MOCK → PROPOSED tới khi có hợp đồng D06).

**Căn cứ.** Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 và NĐ 356/2025/NĐ-CP (hiệu lực 01/01/2026): đồng ý phải cụ thể theo mục đích, tự nguyện, rút được bất kỳ lúc nào; ghi nhận bằng chứng đồng ý [CXN-PDP-01 điều khoản cụ thể]; NĐ 91/2020/NĐ-CP về chống tin nhắn rác (tin quảng cáo cần đồng ý; giờ gửi) [CXN-SPAM-01]; chính sách Zalo Notification Service (mẫu được Zalo duyệt, nội dung bất biến, gửi theo số điện thoại) [CXN-ZNS-01]; WhatsApp Business Platform (opt-in bắt buộc, cửa sổ chăm sóc 24 giờ, ngoài cửa sổ chỉ mẫu đã duyệt). Thực tiễn: Novu/Knock/Courier (workflow → preference → digest → delivery), RFC 8058 (one-click unsubscribe email).

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Người nhận (mọi membership) | thông báo của chính mình | đọc, xác nhận, tùy chọn, đồng ý/rút đồng ý, đăng ký thiết bị | đọc thông báo người khác; tắt IN_APP của tin CRITICAL |
| NOTIFICATION_ADMIN (50) | tenant/subtree | dựng luồng, mẫu, gửi thử, chiến dịch (lập), hạn mức kênh, phát lại DLQ | duyệt chiến dịch/mẫu do chính mình lập; xem nội dung thông báo của người khác (chỉ metadata) |
| NOTIFICATION_APPROVER (vai trò tùy biến, ≥ 50) | tenant | duyệt chiến dịch, duyệt mẫu | duyệt cái mình lập |
| Phân hệ phát sự kiện (service) | tenant từ outbox | phát domain event | gửi thông báo trực tiếp bỏ qua NOT |
| Nhà cung cấp kênh | webhook | gửi delivery receipt có chữ ký | — |

## 3. Luồng nghiệp vụ

### 3.1 Sự kiện → thông báo (đường chính)
Tiền điều kiện: `notification_event_type` Active; có `workflow_version` kind NOTIFICATION Published cho `event_type`. Hậu điều kiện: ≤ 1 `notification_instance` cho mỗi (sự kiện, người nhận, mục đích).
1. Consumer NOT nhận event từ outbox (at-least-once). Validate payload theo `payload_schema` của event type (sai → DEAD + cảnh báo phân hệ nguồn).
2. Recipient resolver (định nghĩa trong workflow: vai trò trong scope tài nguyên, người được giao task, người theo dõi, danh sách cụ thể) chạy **trong tenant của event**; loại người nhận không còn membership Active hoặc **không có quyền đọc tài nguyên** (PDP IAM) → không tạo (log `suppressed_no_access`).
3. Với mỗi người nhận: tính `dedupe_key` (BR-NOT-01); `INSERT … ON CONFLICT (tenant_id, dedupe_key) DO NOTHING` — trùng → kết thúc (UAT-AC26).
4. Đặt `priority`, `ack_required`, `expires_at = event_time + expires_after_minutes`, `channel_plan` (danh sách kênh theo workflow ∩ tùy chọn người nhận; IN_APP luôn có với CRITICAL/HIGH).
5. Với mỗi kênh trong plan: kiểm **consent** (BR-NOT-07) → không đạt: attempt Suppressed (`NO_CONSENT`); kiểm **giờ yên lặng** (BR-NOT-08) → hoãn `scheduled_for`; kiểm **digest** (BR-NOT-09) → đưa vào bucket; còn lại → attempt Queued `attempt_no=1`.
6. Worker gửi: tại **thời điểm gửi** kiểm lại membership/quyền/consent/`expires_at`/hạn mức kênh (BR-NOT-13); render mẫu (biến theo `variable_schema`; push/ZNS chỉ biến được phép — BR-NOT-11); gọi adapter với idempotency key `{notification_id}:{channel}:{attempt_no}` khi provider hỗ trợ.
7. Kết quả adapter → reducer trạng thái (BR-NOT-06); lỗi → retry/fallback (BR-NOT-03); IN_APP Delivered ngay khi ghi hộp thư.
Đồng thời: hai replica consumer xử lý cùng event → unique dedupe_key chặn; hai worker lấy cùng attempt → `FOR UPDATE SKIP LOCKED`.

### 3.2 Đọc và xác nhận (NOT-01, NOT-02, MOB-32/33)
`listMyNotifications` trả thông báo của membership phiên (nội dung render lại theo quyền **hiện tại**; mất quyền → hiển thị "Nội dung không còn khả dụng"). Mở chi tiết → `markNotificationRead` (Read, `read_at`). Tin `ack_required` hiển thị nút "Xác nhận đã nhận" → `acknowledgeNotification` (`acknowledged_at ≥ read_at`, ghi bình luận tùy chọn) — chỉ hành động này mới là "đã xác nhận" nghiệp vụ; ack trên tin không yêu cầu → 422 `ACK_NOT_REQUIRED`. Push ProviderAccepted/Delivered **không** đặt read (NOT02). Deep link mang opaque id; mở link kiểm quyền hiện tại.

### 3.3 Tùy chọn và đồng ý (NOT-03, NOT-17, MOB-34)
`updateMyNotificationPreferences` (If-Match): bật/tắt theo `event_category × channel`, digest_mode, giờ yên lặng, múi giờ IANA; không tắt được IN_APP cho CRITICAL (422 `MANDATORY_CHANNEL_LOCKED`). `grantMyConsent` cho kênh cá nhân (ZALO, WHATSAPP, SMS, EMAIL cá nhân) × mục đích (OPERATIONAL, REMINDER, ANNOUNCEMENT) với `consent_text_version` và cách thu thập; kênh cần định danh đã xác minh (số điện thoại OTP) — chưa có → 422 `CHANNEL_IDENTITY_UNVERIFIED`. `withdrawMyConsent` có hiệu lực ngay: attempt Queued/Scheduled của kênh×mục đích đó bị Suppressed tại lần kiểm gửi (UAT-AC184). Tin "STOP"/"HUY" trên kênh hoặc link hủy email (RFC 8058) = rút đồng ý tự động.

### 3.4 Dựng luồng, mẫu, gửi thử (NOT-05..08)
- `createNotificationWorkflowDraft` (event_type phải đăng ký — 422 `EVENT_TYPE_UNKNOWN`) → `post_notification_workflows_id_publish` (người công bố ≠ người soạn; `quiet_hours_override=true` chỉ khi priority CRITICAL và có lý do). Workflow Published cũ → Superseded; thông báo đã tạo giữ `workflow_version_id` cũ.
- `createTemplateRevision` (code × channel × locale × revision) → `submitTemplateRevision`: IN_APP/EMAIL/PUSH/SMS → InReview; ZALO_ZNS/WHATSAPP → PendingProvider (adapter đăng ký mẫu, nhận `provider_template_id` và kết quả duyệt qua webhook) → `decideTemplateRevision` (≠ người soạn; ZNS/WhatsApp chưa được nhà cung cấp duyệt → 409 `TEMPLATE_PROVIDER_PENDING`) → Active; revision Active trước của cùng code×channel×locale → Retired. Mọi sửa nội dung revision không phải Draft → 409 `TEMPLATE_IMMUTABLE`.
- `sendTestNotification`: tối đa 10 người trong danh sách thử của tenant (422 `TEST_RECIPIENT_NOT_ALLOWED`), tiền tố "[TEST]", `is_test=true`, không tính chỉ số.

### 3.5 Chiến dịch diện rộng (NOT-09, NOT-10, NOT-16)
`createCampaign` (Draft) → `previewCampaignRecipients` (resolve segment trong scope người tạo; loại trừ opt-out, không consent, inactive, trùng; trả `preview_hash = sha256(sorted recipient ids || template_version_id || scheduled_at)`) → `submitCampaign` với hash hiện hành (409 `PREVIEW_STALE` nếu tập người nhận đã đổi) → `decideCampaign` (NOTIFICATION_APPROVER ≠ người tạo) → Approved/Scheduled → tới `scheduled_at` (giờ người nhận nếu chọn "theo múi giờ người nhận") tạo notification với `source_event_id = campaign_id` → Sending → Completed. `cancelCampaign` trước Completed: attempt chưa gửi → Cancelled. Entitlement `notification.campaign` bắt buộc (grace → DENY).

### 3.6 Vận hành: hàng đợi, DLQ, phát lại (NOT-11..13)
Failed sau hết retry và fallback → DLQ (NOT-13) lưu payload reference tối thiểu, lỗi, số lần. `post_notifications_id_replay` (If-Match): kiểm lại consent, quyền, `expires_at` (hết hạn → 409 `NOTIFICATION_EXPIRED`), trạng thái Unknown phải đối soát trước (409 `RECONCILE_REQUIRED`); tạo attempt mới tiếp số thứ tự nhưng **không vượt cap 5** — nếu đã 5 lần, replay tạo một chuỗi mới có `attempt_no` reset trong bản ghi replay (`notification_instance` mới với dedupe `n1:` của `replay:{id}:{n}`) [GIẢ ĐỊNH — giữ bất biến cap]. `cancelNotification` trước ProviderAccepted → Cancelled; sau đó chỉ ghi `cancel_requested` trong audit.

### 3.7 Thiết bị push (NOT-14)
`registerDevice` idempotent theo `(membership, device_public_id)`; token chỉ lưu vault ref + `token_fingerprint`; lỗi vĩnh viễn (UNREGISTERED/BadDeviceToken) → revoke thiết bị; đăng xuất/đổi tenant → revoke (IAM §3.5).

## 4. State machine

```
notification_instance (trạng thái logic, đơn điệu):
 Created ─► Scheduled ─► Queued ─► Sending ─► ProviderAccepted ─► Delivered ─► Read
    │           │           │          │              │
    └───────────┴───────────┴──────────┴──► Suppressed | Expired | Cancelled | Failed | Unknown(─reconcile─► Delivered|Failed)
 acknowledged_at: thuộc tính riêng, chỉ đặt được khi ack_required và read_at ≠ NULL
delivery_attempt: Queued ─► Sending ─► ProviderAccepted ─► Delivered ─► Read ; Sending ─► Failed(RETRYABLE→attempt mới | PERMANENT) | Unknown ; Queued ─► Suppressed | Cancelled
template: Draft ─► InReview ─► Active ─► Retired ; Draft ─► PendingProvider ─► (provider duyệt) ─► InReview… ; InReview|PendingProvider ─► Rejected
campaign: Draft ─► Previewed ─► PendingApproval ─► Approved ─► Scheduled ─► Sending ─► Completed ; PendingApproval ─► Rejected ; *(trước Completed) ─► Cancelled
consent: Granted ─► Withdrawn ; Granted ─► Expired (consent có hạn)
```
| Từ | Command/sự kiện | Đến | Ai | Guard | Audit/Event |
|---|---|---|---|---|---|
| — | domain event | Created | NOT consumer | dedupe chưa có | — (log) |
| Created | lập lịch | Scheduled/Queued | system | quiet hours/digest | — |
| Delivered | `markNotificationRead` | Read | người nhận | là recipient | `notification.read` (audit nhẹ) |
| Read | `acknowledgeNotification` | (acknowledged_at) | người nhận | ack_required | `not.notification.acknowledged.v1` |
| Failed/Unknown | `post_notifications_id_replay` | Queued | NOTIFICATION_ADMIN | consent, quyền, TTL, reconcile | `notification.replayed` |
| Queued/Scheduled | `cancelNotification` | Cancelled | NOTIFICATION_ADMIN | chưa ProviderAccepted | `notification.cancelled` |
| PendingApproval (campaign) | `decideCampaign` | Approved | APPROVER ≠ created_by | preview_hash khớp | `not.campaign.approved.v1` |
| PendingProvider (template) | webhook provider + `decideTemplateRevision` | Active | APPROVER ≠ created_by | provider_status APPROVED | `not.template.activated.v1` |

Chuyển bị cấm: mọi bước lùi hạng (Delivered→ProviderAccepted, Read→Delivered) bị reducer bỏ qua (không lỗi, ghi metric `out_of_order_callbacks`); replay Delivered/Read → 409 `NOTIFICATION_STATE_INVALID`; sửa template Active → 409 `TEMPLATE_IMMUTABLE`.

## 5. Quy tắc nghiệp vụ và công thức

- **BR-NOT-01 Khóa chống trùng duy nhất (giải quyết 3 định nghĩa v1.3 — CR-NOT-01).** `dedupe_key = 'n1:' || hex(sha256(tenant_id || '|' || source_event_id || '|' || recipient_id || '|' || purpose))`, UNIQUE `(tenant_id, dedupe_key)`. Lý do: (a) FRD dùng `logical_notification_id + recipient + channel + template_version` — đưa `template_version` vào khóa làm replay sau khi đổi mẫu sinh tin trùng (UAT-AC176), và kênh là chiều của **attempt**, không phải của thông báo logic; (b) Module_Implementation_Contracts dùng `event + recipient + purpose` — được giữ, bổ sung tenant; (c) `05` dùng `tenant/provider/event_id` — đó là khóa **inbox webhook vào** (`integration_event_inbox`), đổi tên rõ ràng, không phải khóa thông báo. Chiều kênh: UNIQUE `delivery_attempt (tenant, notification_id, channel, attempt_no)`. Digest: `source_event_id = uuid_v5(recipient || category || window_start)`; chiến dịch: `source_event_id = campaign_id`.
- **BR-NOT-02 Mục đích.** `purpose ∈ {OPERATIONAL, SECURITY, REMINDER, ANNOUNCEMENT, DIGEST, SUPPORT_CONVERSATION}`; event type khai báo `allowed_purposes`; workflow chỉ chọn trong đó.
- **BR-NOT-03 Retry có giới hạn (giải quyết "4 mốc vs cap 5" — CR-NOT-02).** Tối đa **5 lần gửi mỗi kênh** = 1 lần đầu + 4 lần thử lại sau 30 s, 2 phút, 10 phút, 30 phút tính từ lần trước, mỗi khoảng nhân hệ số jitter ngẫu nhiên [0,8; 1,2]; nếu provider trả `Retry-After` lớn hơn thì dùng giá trị đó; không lên lịch lần nào có thời điểm ≥ `expires_at` (khi đó Expired). Chỉ retry lỗi RETRYABLE (timeout kết nối trước khi gửi, 408, 429, 5xx); PERMANENT (4xx khác, địa chỉ/token sai) dừng ngay, token sai → revoke thiết bị. Hết 5 lần → kênh Failed → fallback sang kênh kế tiếp trong `channel_plan` (attempt_no bắt đầu 1) → hết kênh → notification Failed → DLQ.
- **BR-NOT-04 Unknown.** Timeout **sau khi** request đã tới provider (không biết có gửi chưa) → Unknown; không tự gửi lại kênh tính phí (SMS, ZNS, WhatsApp); job reconcile hỏi trạng thái theo `provider_message_id`/idempotency key (nếu provider hỗ trợ) mỗi 5 phút trong 24 giờ; hết hạn vẫn Unknown → chờ quyết định người vận hành (replay = rủi ro gửi đôi, ghi rõ trên NOT-13).
- **BR-NOT-05 Đọc ≠ xác nhận.** Read = người nhận mở chi tiết trong ứng dụng (hoặc provider báo read cho kênh hỗ trợ, ghi `delivery_attempt.read_at` — không đặt `notification_instance.read_at`). Acknowledged = hành động nghiệp vụ chủ động, chỉ với `ack_required`; email opened không phải biên nhận.
- **BR-NOT-06 Reducer đơn điệu.** Hạng: Queued 1 < Sending 2 < ProviderAccepted 3 < Delivered 4 < Read 5; cập nhật chỉ khi hạng mới > hạng hiện tại; trạng thái kết thúc (Failed/Suppressed/Cancelled/Expired) chỉ được ghi đè bởi Delivered/Read nếu provider báo muộn (giao thực tế thắng). Callback trùng bị inbox dedupe; callback có `provider_message_id` chưa biết → giữ PENDING_MAPPING 1 giờ rồi DEAD.
- **BR-NOT-07 Đồng ý theo người × kênh × mục đích.** Bảng quyết định:

| Kênh | OPERATIONAL/REMINDER (công vụ) | SECURITY | ANNOUNCEMENT | Ghi chú |
|---|---|---|---|---|
| IN_APP | không cần (căn cứ thực hiện nhiệm vụ — `legal_basis=PUBLIC_DUTY`) | không cần | không cần | luôn khả dụng |
| EMAIL công vụ (domain cơ quan) | không cần (PUBLIC_DUTY) | không cần | cần (có link hủy) | |
| PUSH (thiết bị đã đăng ký) | quyền OS + tùy chọn | không cần | cần | permission_state = granted |
| EMAIL cá nhân, SMS, ZALO_ZNS/OA, WHATSAPP | **cần consent Granted** | cần | cần | định danh đã xác minh |

Liên hệ ngoài (khách, nhà thầu) luôn cần consent cho mọi kênh trừ phản hồi trong hội thoại họ khởi tạo (OMNI BR-OMNI-03). Kiểm tại lúc tạo và lúc gửi [CXN-PDP-01].
- **BR-NOT-08 Giờ yên lặng.** Theo `notification_preference.time_zone` của người nhận (mặc định Asia/Ho_Chi_Minh; mặc định 21:00–07:00 [GIẢ ĐỊNH]); áp cho PUSH, SMS, ZALO, WHATSAPP; không áp cho IN_APP và EMAIL (không gây gián đoạn). Trong giờ yên lặng → `scheduled_for` = thời điểm kết thúc giờ yên lặng kế tiếp (tính theo múi giờ, đúng cả khi khoảng vắt qua nửa đêm). CRITICAL với workflow `quiet_hours_override=true` gửi ngay, mỗi lần ghi audit `notification.quiet_hours_override` (AC27). Ví dụ: sự kiện 2026-10-22T13:30Z → người VN (20:30) gửi ngay; người ở Asia/Tokyo (22:30) → 2026-10-22T22:00Z (UAT-AC185).
- **BR-NOT-09 Digest.** `digest_mode` HOURLY (phút 00 mỗi giờ) hoặc DAILY (07:30 giờ người nhận [GIẢ ĐỊNH]) cho priority NORMAL/LOW; CRITICAL/HIGH không digest. Thông báo gốc ở Scheduled với `digest_bucket_key`; tới giờ tạo 1 notification DIGEST liệt kê ≤ 50 mục (phần còn lại "và N mục khác"), gốc → Delivered (qua digest).
- **BR-NOT-10 Mẫu nhà cung cấp bất biến.** ZNS/WhatsApp: nội dung + tham số khớp mẫu đã duyệt; sửa = revision mới + đăng ký lại; Active chỉ khi `provider_status = PROVIDER_APPROVED` và có `provider_template_id` (DB CHECK).
- **BR-NOT-11 An toàn màn hình khóa và nội dung nhạy cảm.** Biến trong `variable_schema` có `type` và `classification`; PUSH, SMS, ZALO, WHATSAPP chỉ dùng biến PUBLIC/INTERNAL không phải `money`; tham chiếu tài nguyên CONFIDENTIAL chỉ bằng deep link opaque (`/r/{opaque_id}`, không token truy cập) → vi phạm 422 `TEMPLATE_VARIABLE_CLASSIFIED`. Template PUSH bắt buộc `lockscreen_safe=true` (DB CHECK) (AC28, AC25).
- **BR-NOT-12 Chiến dịch.** Preview bắt buộc; `preview_hash` phải khớp khi trình và khi duyệt; người duyệt ≠ người tạo (DB CHECK); mọi chiến dịch (không phụ thuộc số người) đều qua duyệt [Claude quyết — quản trị sâu nhất].
- **BR-NOT-13 Hạn mức và chi phí kênh.** `daily_send_cap` và `monthly_budget_vnd` theo `channel_account`; chi phí ước tính = đơn giá meter × số tin; vượt → tin NORMAL/LOW Scheduled sang kỳ kế tiếp hoặc fallback kênh không tính phí; CRITICAL IN_APP không bao giờ bị chặn. Meter `notification.<channel>` ghi vào SAS (BR-SAS-15).
- **BR-NOT-14 Chỉ số giao.** `delivered_rate = |{Delivered, Read}| / (|attempt kết thúc trong kỳ| − |Suppressed|)`; Unknown nằm ở mẫu số và hiển thị riêng; cutoff = thời điểm chốt kỳ (UAT-AC193).
- **BR-NOT-15 Danh mục sự kiện.** Chỉ event type Active mới dùng được; schema có version; phân hệ nguồn sở hữu đăng ký (seed theo migration của phân hệ).
- **BR-NOT-16 Không chặn giao dịch nghiệp vụ.** Gửi thông báo luôn sau commit qua outbox; provider lỗi không làm lỗi lệnh nghiệp vụ (AC29); circuit breaker theo `channel_account` (mở sau 20 lỗi/1 phút, half-open sau 2 phút).
- **BR-NOT-17 Nhắc việc và thông báo lên cấp trên của trung tâm cảnh báo (G2-4, G2-1, G2-2).** NOT nhận ba sự kiện từ HOME: `home.work_reminder.v1` (nhắc người đang chịu trách nhiệm theo nhịp của quy tắc `REMINDER_POLICY` tính bằng giờ làm việc), `home.work_reclaim_notice.v1` (việc đã nhận xử lý rồi im lặng, hoặc vừa được nhận lại) và `home.work_snooze_final.v1` (lần hoãn cuối cùng được phép). Sự kiện chỉ nêu việc, người, loại và mức độ, không mang lời của người dùng; hai loại sau dành cho cấp trên của người đó (audience `NEXT_LEVEL`), việc xác định cấp trên và gộp tin, giờ yên lặng, hạn mức mỗi ngày thuộc hồ sơ thông báo từng người (G2-5, G2-6). Mỗi lần nhắc đã có dòng `work_reminder` ở HOME; NOT không tự sinh nhắc.

## 6. Dữ liệu

| Bảng | Trường chính (mới/sửa) | Ràng buộc | Phân loại | Lưu giữ |
|---|---|---|---|---|
| `notification_event_type` (control plane, mới) | event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status | UNIQUE (event_type, schema_version) | PUBLIC | vĩnh viễn |
| `workflow_version` (dùng chung với ADM, kind NOTIFICATION) | + event_type, definition (resolver, conditions, channel_plan, fallback, delay, digest_allowed, priority, quiet_hours_override, expires_after_minutes, ack_required, escalation) | 1 Published/(kind, business_type); CHECK event_type khi NOTIFICATION | INTERNAL | vĩnh viễn |
| `notification_template_version` (sửa) | + purpose, lockscreen_safe, provider_status, provider_reviewed_at, content_hash, created_by, approved_by, supersedes_id, version | UNIQUE (tenant, code, channel, locale, revision); CHECK provider/push/bốn mắt | INTERNAL | vĩnh viễn |
| `notification_instance` (sửa) | + recipient_kind, source_event_type, event_version, priority, channel_plan, scheduled_for, digest_bucket_key, campaign_id, ack_required, read_at, acknowledged_at, is_test, suppression_reason, created_at, version | UNIQUE (tenant, dedupe_key) + CHECK định dạng `n1:`; CHECK ack; index hộp thư | INTERNAL (nội dung render theo quyền, không lưu nội dung mật) | 2 năm; tin ack_required 5 năm |
| `delivery_attempt` (sửa) | + channel, template_version_id, failure_class, next_retry_at, accepted_at, read_at, cost_currency, created_at | UNIQUE (tenant, notification, channel, attempt_no); attempt_no 1..5; UNIQUE provider_message_id/kênh | INTERNAL | chi tiết 365 ngày, tổng hợp 5 năm |
| `notification_preference` (mới) | membership_id, event_category, channel, enabled, digest_mode, quiet_start/end, time_zone, version | UNIQUE (tenant, membership, category, channel) | PERSONAL | đến khi membership Ended + 1 năm |
| `contact_consent` (sửa — dùng chung OMNI) | + membership_id (contact_id nullable), legal_basis, consent_text_version, capture_method, withdrawn_reason, version | đúng một chủ thể; 1 Granted/(chủ thể, kênh, mục đích); CHECK withdraw | PERSONAL | 5 năm sau rút/hết hạn (bằng chứng) [CXN-PDP-02] |
| `notification_campaign` (mới) | name, purpose, template_version_id, segment_json, scheduled_at, preview_*, status, created_by, approved_by | bốn mắt; Approved ⇒ có preview_hash | INTERNAL | 5 năm |
| `device_registration` (sửa) | + token_fingerprint, permission_state, app_version, locale, revoke_reason | 1 thiết bị sống/(membership, device_public_id) | PERSONAL | 180 ngày sau revoke |
| `channel_account` (sửa — dùng chung OMNI) | + display_name, webhook_secret_ref, verified_at, daily_send_cap, monthly_budget_vnd, version | CHECK kênh, trạng thái, Active ⇒ verified | CONFIDENTIAL (secret ref) | vĩnh viễn |

## 7. API / command

| operationId | Method path | x-permission | DTO | Lỗi chính | If-Match |
|---|---|---|---|---|---|
| listMyNotifications | GET /me/notifications | notification.self | → NotificationPage (dto) | — | — |
| markNotificationRead | POST /notifications/{notificationId}/read | notification.self | ReadReceipt | 404 | không |
| acknowledgeNotification | POST /notifications/{notificationId}/acknowledge | notification.self | AckRequest | 422 ACK_NOT_REQUIRED; 409 NOTIFICATION_EXPIRED | không |
| updateMyNotificationPreferences | PUT /me/notification-preferences | notification.self | PreferenceSet | 422 MANDATORY_CHANNEL_LOCKED | có |
| listMyConsents / grantMyConsent / withdrawMyConsent | GET/POST /me/consents, POST /me/consents/{consentId}/withdraw | notification.self | ConsentGrant / ReasonOnly | 409 CONSENT_ALREADY_GRANTED, CONSENT_STATE_INVALID; 422 CHANNEL_IDENTITY_UNVERIFIED | withdraw có |
| createTemplateRevision / submitTemplateRevision / decideTemplateRevision | POST /notification-templates, …/{templateId}/submit\|decision | notification.template.manage / notification.template.approve | TemplateRevisionCreate / ReasonOnly / Decision | 422 TEMPLATE_INVALID, TEMPLATE_VARIABLE_CLASSIFIED; 409 TEMPLATE_IMMUTABLE, TEMPLATE_PROVIDER_PENDING; 403 SELF_APPROVAL_DENIED | trừ create |
| sendTestNotification | POST /notification-templates/{templateId}/test-sends | notification.template.manage | TestSendRequest | 422 TEST_RECIPIENT_NOT_ALLOWED | không |
| createNotificationWorkflowDraft / post_notification_workflows_id_publish | POST /notification-workflows, /notification-workflows/{id}/publish | notification.publish | NotificationWorkflowDraft / Decision | 422 EVENT_TYPE_UNKNOWN, WORKFLOW_DEFINITION_INVALID; 403 SELF_APPROVAL_DENIED | publish có |
| createCampaign / previewCampaignRecipients / submitCampaign / decideCampaign / cancelCampaign | /notification-campaigns… | notification.campaign.manage / notification.campaign.approve | CampaignCreate / → CampaignPreview / CampaignSubmit / Decision / ReasonOnly | 409 PREVIEW_STALE, CAMPAIGN_STATE_INVALID; 403 SELF_APPROVAL_DENIED, ENTITLEMENT_DENIED | trừ create |
| post_notifications_id_replay | POST /notifications/{id}/replay | notification.replay | Decision | 409 NOTIFICATION_EXPIRED, RECONCILE_REQUIRED, NOTIFICATION_STATE_INVALID; 422 CONSENT_DENIED | có |
| cancelNotification | POST /notifications/{notificationId}/cancel | notification.operate | ReasonOnly | 409 NOTIFICATION_STATE_INVALID | có |
| registerDevice | POST /devices | notification.self | DeviceRegister | 422 | không |
| setChannelLimits | PUT /channel-accounts/{channelAccountId}/limits | notification.channel.manage | ChannelLimits | 422 | có |
| receiveChannelWebhook | POST /webhooks/channels/{provider} | webhook.provider (x-public, chữ ký) | ProviderWebhook → WebhookAck | 401 SIGNATURE_INVALID, REPLAY_WINDOW_EXCEEDED | — |

Rà soát GET scaffold: `notification_instance` **DTO riêng** (người nhận qua `/me/notifications`; vận hành chỉ metadata), `delivery_attempt` **DTO riêng** (không payload, địa chỉ che), `notification_template_version` **giữ**, `device_registration` **DTO riêng** (không token), `channel_account` **DTO riêng** (không secret), `contact_consent` **DTO riêng**. Không endpoint nào sửa trực tiếp status thông báo/attempt.

## 8. UI/UX

| Màn hình | Field thêm/mới | Ghi chú |
|---|---|---|
| NOT-01 | Đã đọc lúc, Cần xác nhận | badge "Cần xác nhận" khác "Chưa đọc" |
| NOT-02 | Xác nhận lúc | nút "Xác nhận đã nhận" chỉ khi ack_required; trạng thái riêng `content-unavailable` khi mất quyền |
| NOT-03 | Múi giờ, Kênh bắt buộc (khóa) | toggle khóa có tooltip lý do |
| NOT-04 | Tỷ lệ giao (mẫu số/cutoff), Unknown cần đối soát | hiển thị công thức BR-NOT-14 |
| NOT-05 | Mục đích cho phép, Phân loại dữ liệu | chỉ đọc với tenant |
| NOT-06 | Ưu tiên, Ghi đè giờ yên lặng, Hết hạn sau, Cần xác nhận, Kênh dự phòng | |
| NOT-07 | Mã mẫu nhà cung cấp, Trạng thái duyệt nhà cung cấp, An toàn màn hình khóa | editor khóa khi không phải Draft |
| NOT-08 | Nhãn TEST | |
| NOT-09/10/16 | Gồm khách nhà thầu, Loại trừ theo lý do; Mã xem trước, Trạng thái chiến dịch; Số loại trừ, Mã xem trước, Người tạo | preview hiển thị số theo từng lý do loại trừ |
| NOT-11..15 | Kênh dự phòng, Hết hạn; Lần thử, Mã nhà cung cấp, Lý do loại trừ; Cần đối soát; Quyền thông báo, Phiên bản ứng dụng; Hạn mức/ngày, Ngân sách VND/tháng | timeline NOT-12 hiển thị 5 mốc retry |
| NOT-17 (mới) | Kênh, Mục đích, Trạng thái, Thời điểm, Phiên bản điều khoản, Rút đồng ý | danh sách; nút rút đồng ý có xác nhận; liên kết điều khoản theo version |

Mobile: MOB-05 (xin quyền push → `registerDevice`), MOB-32/33 (= NOT-01/02 API), MOB-34 (= NOT-03 + NOT-17). 7 trạng thái chuẩn.

## 9. Sự kiện, job, tích hợp, quan sát

- Consume: mọi `*.v1` có trong `notification_event_type`; `iam.access.changed.v1` (gỡ người nhận mất quyền khỏi hàng đợi); `not.consent.changed.v1` (cập nhật cache consent `consent:{tenant}:{subject}`).
- Produce: `not.notification.acknowledged.v1 {notification_id, source_event_id, recipient}` (phân hệ nguồn dùng làm bằng chứng đã nhận chỉ đạo); `not.consent.changed.v1`; `not.template.activated.v1`; `not.workflow.published.v1`; `not.campaign.approved.v1`.
- Job/worker: scheduler (Scheduled đến hạn — partial index), dispatcher theo kênh (bulkhead riêng), retry (index `next_retry_at`), digest (mỗi phút kiểm bucket đến giờ), reconcile Unknown (5 phút), dọn attempt > 365 ngày.
- Adapter (K8): `EmailPort` (SMTP relay nội địa — MOCK/PROPOSED), `SmsPort` (brandname — PROPOSED), `ZaloZnsPort`/`ZaloOaPort` (PROPOSED [CXN-ZNS-01]), `WhatsAppPort` (Cloud API qua BSP — PROPOSED), `FcmPort`/`ApnsPort` (VERIFIED theo tài liệu công khai của Google/Apple sau spike). Webhook vào: xác minh chữ ký theo provider trên raw body trước khi lưu (WhatsApp `X-Hub-Signature-256` HMAC-SHA256 app secret; Zalo theo tài liệu OA/ZNS [CXN-ZNS-02]); cửa sổ replay 5 phút; inbox unique `(tenant, provider, event_key)`; ACK sau khi persist.
- Cache: `pref:{tenant}:{membership}` TTL 5 phút; `consent:{tenant}:{subject}` xóa theo event.
- Telemetry: `notification_created_total{event_type}`, `notification_dedupe_hits_total`, `delivery_latency_seconds{channel}` (p95 IN_APP < 5 s, PUSH < 60 s), `delivery_attempts_total{channel,outcome}`, `out_of_order_callbacks_total`, `quiet_hours_override_total`, `channel_budget_utilization`; cảnh báo: DLQ > 50, Unknown > 1 giờ, circuit open > 10 phút, budget > 90%. Log không chứa số điện thoại/email/nội dung — chỉ id.

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Setup | Input/Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC26 | integration | P0 | WF v3 | event E-26 giao 3 lần | 1 instance, dedupe hits 2 | DB + metric |
| UAT-AC27 | integration | P1 | quiet 21–07 | NORMAL + CRITICAL lúc 22:30 | PUSH hoãn 07:00; CRITICAL gửi + audit | DB |
| UAT-AC28 | security | P1 | biến money | mẫu push có số tiền; gửi | 422; payload không có số tiền | FCM mock |
| UAT-AC29 | integration | P1 | provider 503 | gửi báo cáo | 200 < 2 s; tin gửi sau | API log |
| UAT-AC30 | UAT | P1 | segment 130 | preview, tự duyệt, owner duyệt | 120/loại trừ đúng; 403; 120 tin | DB |
| UAT-AC176 | integration | P0 | đổi template/workflow | replay E-76 | 1 instance | DB |
| UAT-AC177 | integration | P0 | ZNS 503 | chạy 60 phút | 5 attempt đúng mốc; fallback EMAIL | DB |
| UAT-AC178 | integration | P1 | TTL 5 phút, Retry-After 600 | — | Expired, không attempt 2 | DB |
| UAT-AC179 | integration | P1 | UNREGISTERED | gửi | PERMANENT, revoke thiết bị | DB |
| UAT-AC180 | integration | P0 | SMS timeout | replay; reconcile | 409 RECONCILE_REQUIRED; 1 SMS | provider log |
| UAT-AC181 | E2E | P0 | ack/không ack | đọc, xác nhận | read ≠ ack; 422 ACK_NOT_REQUIRED | DB |
| UAT-AC182 | integration | P0 | attempt Accepted | callback đảo thứ tự | không lùi | DB |
| UAT-AC183 | integration | P0 | không consent ZALO | event; cấp consent; event | Suppressed rồi gửi | DB |
| UAT-AC184 | integration | P0 | attempt hẹn | rút consent trước giờ gửi | Suppressed, 0 lời gọi | adapter log |
| UAT-AC185 | domain | P1 | 2 múi giờ | event 13:30Z | VN gửi; Tokyo hoãn 22:00Z | DB |
| UAT-AC186 | domain | P1 | DAILY | 3 NORMAL + 1 HIGH | 1 digest 07:30; HIGH ngay | DB |
| UAT-AC187 | integration | P0 | ZNS Active | sửa; rev2; duyệt sớm; provider duyệt | 409; PendingProvider; 409; Active | DB |
| UAT-AC188 | security | P1 | biến CONFIDENTIAL | mẫu ZNS; DB push | 422; CHECK | DB |
| UAT-AC189 | domain | P1 | danh sách thử | ngoài/trong | 422; [TEST] | DB |
| UAT-AC190 | domain | P1 | preview H1 | opt-out rồi submit | 409 PREVIEW_STALE | API log |
| UAT-AC191 | integration | P1 | budget 999.900/1.000.000 | NORMAL ZNS + CRITICAL | hoãn; CRITICAL giao | DB |
| UAT-AC192 | integration | P1 | thiết bị | đăng ký 2 lần; logout | 1 bản; revoked | DB |
| UAT-AC193 | domain | P1 | 100 attempt | NOT-04 | 84,21% mẫu 95 | ảnh chụp |
| UAT-AC194 | domain | P1 | event chưa đăng ký | tạo workflow | 422 EVENT_TYPE_UNKNOWN | API log |
| NOT01, NOT02, TX03 | cross-cutting | P0 | | | | |
| UI-NOT-17 | screen-contract | P0 | route | 7 trạng thái | đúng trường | ảnh chụp |

## 11. Tiêu chí nghiệm thu (đo được)

- AC-NOT-01: Given một sự kiện được giao lại hoặc mẫu/luồng đổi phiên bản, Then mỗi (sự kiện, người nhận, mục đích) có đúng 1 thông báo (UAT-AC26, UAT-AC176).
- AC-NOT-02: Given lỗi tạm thời liên tục, Then đúng 5 lần gửi mỗi kênh theo lịch 30s/2m/10m/30m ±20% và không vượt expires_at, rồi fallback (UAT-AC177, UAT-AC178).
- AC-NOT-03: Given push/email accepted, Then không đánh dấu đã đọc; xác nhận chỉ khi người nhận bấm và tin yêu cầu (UAT-AC181, NOT02).
- AC-NOT-04: Given callback đảo thứ tự/trùng, Then trạng thái không lùi và không ghi trùng (UAT-AC182, NOT01).
- AC-NOT-05: Given không có/rút đồng ý kênh cá nhân cho mục đích, Then không có lời gọi adapter cho kênh đó (UAT-AC183, UAT-AC184, UAT-AC22).
- AC-NOT-06: Given giờ yên lặng theo múi giờ người nhận, Then PUSH/SMS/ZALO hoãn đúng giờ kết thúc; CRITICAL được phép ghi đè có audit (UAT-AC27, UAT-AC185).
- AC-NOT-07: Given mẫu ZNS/WhatsApp, Then không gửi bằng mẫu chưa được nhà cung cấp duyệt; mẫu đã duyệt bất biến (UAT-AC187).
- AC-NOT-08: Given biến tiền/mật, Then không xuất hiện trên push/SMS/ZNS (UAT-AC28, UAT-AC188).
- AC-NOT-09: Given chiến dịch, Then có preview số người/loại trừ và người duyệt khác người tạo; tập người nhận đổi thì phải preview lại (UAT-AC30, UAT-AC190).
- AC-NOT-10: Given provider sập, Then lệnh nghiệp vụ vẫn thành công trong < 2 s (UAT-AC29).

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

- **R1 (dùng thật):** IN_APP + EMAIL công vụ + PUSH; dedupe BR-NOT-01; retry/fallback BR-NOT-03; reducer; read/ack; tùy chọn + giờ yên lặng; consent (NOT-17) cho kênh cá nhân; NOT-05/06/07 (không ZNS/WhatsApp); NOT-01/02/03/11/12/13/14/17; event type cho report.*, approval.*, guarantee.expiring, explanation.requested, deadline.near.
- **R2:** digest; chiến dịch NOT-09/10/16; hạn mức chi phí NOT-15; dashboard NOT-04 đầy đủ; SMS.
- **R3:** ZNS/Zalo OA/WhatsApp thật khi có hợp đồng (D06) — R1/R2 chạy adapter MOCK với hợp đồng contract-test.
- **Giờ review người (R2-D5):** 12 giờ — **quyền/pháp lý** (BR-NOT-07 bảng consent theo Luật 91/2025, BR-NOT-11), **migration** (định dạng dedupe_key mới, backfill attempt_no ≤ 5).

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| [CXN-PDP-01] Căn cứ xử lý không cần đồng ý cho thông báo công vụ (thực hiện nhiệm vụ cơ quan nhà nước) theo Luật 91/2025 + NĐ 356/2025 | DPO + Pháp chế | Văn bản đánh giá tác động xử lý DLCN; nếu yêu cầu đồng ý cả kênh công vụ → đổi bảng BR-NOT-07 (dữ liệu, không đổi code) |
| [CXN-PDP-02] Thời hạn lưu bằng chứng đồng ý | DPO | Ghi vào `data_retention_policy` |
| [CXN-SPAM-01] NĐ 91/2020 áp dụng cho tin công vụ qua SMS brandname | Pháp chế | Ý kiến; cấu hình giờ gửi SMS |
| [CXN-ZNS-01]/[CXN-ZNS-02] Chính sách ZNS (điều kiện gửi, giá, chữ ký webhook) | Tech Lead + Mua sắm (D06) | Hợp đồng Zalo + tài liệu API; adapter PROPOSED → VERIFIED |
| [GIẢ ĐỊNH] giờ yên lặng mặc định 21:00–07:00, digest 07:30, chiến dịch luôn qua duyệt | PO | Xác nhận ở UAT |
| Rủi ro gửi đôi khi Unknown trên kênh tính phí | Vận hành | BR-NOT-04: không tự gửi lại; quyết định người vận hành có audit |
| Rủi ro một tỉnh dùng email cá nhân (gmail) cho cán bộ | Chủ nghiệp vụ | Email không thuộc domain cơ quan được coi là kênh cá nhân → cần consent |
