# ADM — Quản trị tenant, phê duyệt theo thẩm quyền và dịch vụ nền tảng

Phiên bản đặc tả M1 · 22/10/2026 · Nguồn dữ liệu máy: `work/staging/platform.json` (bảng `organization_unit`, `unit_reorganization`, `organization_unit_succession`, `membership`, `membership_invitation`, `role_definition`, `role_grant`, `delegation_grant`, `doa_matrix_version`, `doa_rule`, `workflow_version`, `workflow_instance`, `approval_task`, `work_calendar_version`, `signing_certificate`, `integration_connector`, `integration_event_inbox`, `data_retention_policy`, `legal_hold`, `migration_batch`, `security_policy_version`, `audit_event`, `audit_seal`, `outbox_event`, `idempotency_record`). Mô hình tenant, vai trò, thuật toán quyền và chống tự nâng quyền nằm ở `IAM.md §5` — ADM là nơi các lệnh quản trị thực thi chúng.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Tenant Admin của tỉnh phải tự vận hành cơ cấu tổ chức (đang thay đổi mạnh 2025), cấp quyền cho hàng nghìn cán bộ và nhà thầu, và cấu hình "ai duyệt cái gì tới bao nhiêu tiền" mà không cần đội phát triển. Mọi cấu hình này là kiểm soát nội bộ: sai một quy tắc thẩm quyền có thể cho phép một người tự lập và tự duyệt thanh toán ngân sách. Vì vậy mọi cấu hình có hiệu lực tài chính/quyền đều có phiên bản, người lập ≠ người duyệt, và không làm đổi hồ sơ đang xử lý.

**Trong phạm vi:** cây đơn vị và tổ chức lại (ADM-01, ADM-16); thành viên nhân sự và khách nhà thầu (ADM-02, ADM-17); vai trò và grant (ADM-03); ủy quyền có thời hạn (ADM-04); ma trận thẩm quyền phê duyệt — DoA (ADM-15); quy trình phê duyệt cấu hình theo tenant chạy trên Temporal (ADM-06, ADM-18; R9); lịch làm việc/ngày nghỉ (ADM-07); kho quy tắc quản trị có phiên bản, phê duyệt và hiệu lực cùng sổ loại cảnh báo (ADM-19 đến ADM-23; G0-1, G0-3); sổ chứng thư số (ADM-08); connector tích hợp và hộp sự kiện vào (ADM-09, ADM-10); nhật ký kiểm toán (ADM-11); chính sách lưu trữ và legal hold (ADM-12); nhập chuyển đổi dữ liệu (ADM-13); cấu hình an toàn (ADM-14). **Dịch vụ nền tảng dùng chung** cho mọi phân hệ: audit bất biến, transactional outbox, idempotency, legal hold (§5.2).

**Ngoài phạm vi:** dữ liệu danh mục dùng chung (ADM-05 chỉ điều hướng sang MDM); trạng thái kỳ báo cáo Open/SoftClosed/Locked và mở khóa có lý do — **thuộc phân hệ sở hữu `reporting_period`/`period_reopen` (nhóm capital)**; ADM chỉ cung cấp quy trình phê duyệt `business_type = period.reopen` và lịch làm việc (yêu cầu liên phân hệ XM-ADM-01); ký số và cấp số văn bản (DOC — dùng `signing_certificate` để xác minh); con trỏ đồng bộ tích hợp `integration_cursor` (nhóm capital).

**Phụ thuộc:** IAM (PDP, BR-IAM-03..10), Temporal (chủ điều phối duy nhất luồng dài — R9; vào ở slice phê duyệt đầu tiên kèm runbook + restore test — R1), MDM (danh mục loại hồ sơ `DOCUMENT_TYPE`, ĐVHC), PRJ (`project_transfer` khi tổ chức lại), NOT (nhắc hạn, chuyển cấp), object storage (tệp chuyển đổi, export audit).

**Căn cứ.** NĐ 30/2020/NĐ-CP về công tác văn thư (ký thay "KT.", thừa lệnh "TL.", thừa ủy quyền "TUQ." — ngữ nghĩa ủy quyền); Luật Lưu trữ 33/2024/QH15 + NĐ 113/2025/NĐ-CP (hủy tài liệu hết giá trị phải qua hội đồng) [CXN-RET-02]; TT 10/2022/TT-BNV và TT 08/2025/TT-BNV về thời hạn lưu trữ [CXN-RET-03]; Luật Thanh tra 84/2025/QH15 (yêu cầu giữ hồ sơ khi thanh tra — nguồn legal hold); NĐ 23/2025/NĐ-CP chữ ký điện tử và dịch vụ tin cậy; Luật NSNN 89/2025/QH15 (phân định thẩm quyền chi). Thực tiễn: SAP/Oracle DoA (ngưỡng theo loại chứng từ × số tiền × đơn vị), COSO segregation of duties, Procore approval workflows, Temporal (durable timers, signals, versioning).

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| TENANT_OWNER (99) | TENANT | mọi lệnh ADM; duyệt cấu hình do TENANT_ADMIN lập | gán TENANT_OWNER khác (chỉ control plane) |
| TENANT_ADMIN (90) | TENANT | đơn vị, thành viên, vai trò rank < 90, DoA/quy trình/lịch/connector/chính sách (lập hoặc duyệt cái người khác lập) | duyệt cấu hình chính mình lập; đọc hồ sơ nghiệp vụ nếu không có grant nghiệp vụ |
| SECURITY_ADMIN (85) | TENANT | security policy, audit export, legal hold, verify seal | sửa audit |
| UNIT_ADMIN (70) | UNIT_SUBTREE quản trị | đơn vị con, thành viên, grant rank < 70 trong subtree | thao tác ngoài subtree; người rank ≥ 70 |
| LEGAL_OFFICER (vai trò tùy biến khuyến nghị, rank 60) | TENANT | đặt/giải tỏa legal hold | giải tỏa hold chính mình đặt |
| Người duyệt (LEADER, SPECIALIST…) | scope grant + ủy quyền | quyết định task được giao/ủy quyền | duyệt hồ sơ mình lập/gửi (maker ≠ checker) |
| Người lập hồ sơ (INVESTOR_OFFICER) | scope grant | khởi tạo phê duyệt qua command của phân hệ nghiệp vụ | chọn người duyệt; hủy instance |
| AUDITOR (25) | TENANT/subtree | đọc ADM-11, xuất audit | mọi lệnh ghi |
| Khách nhà thầu | CONTRACT | không có lệnh ADM | — |
| Temporal worker (service account) | tenant từ signed context | tạo/đóng task, gọi domain command với idempotency key | bỏ qua guard domain |

## 3. Luồng nghiệp vụ

### 3.1 Tạo/sửa/chuyển đơn vị (ADM-01)
`createOrganizationUnit` (parent bắt buộc, `valid_from`): tính `path = parent.path || id || '/'`, `depth = parent.depth + 1`; kiểm BR-IAM-09; 201 + `iam.org_unit.created.v1`. `updateOrganizationUnit` (If-Match) chỉ đổi tên/mã/cờ chủ đầu tư/căn cứ — đổi tên giữ lịch sử qua audit; báo cáo as-of hiển thị tên tại thời điểm. `moveOrganizationUnit` (If-Match, `effective_from`): kiểm không vòng; cập nhật `path` của toàn subtree trong **một transaction** khóa `organization_unit` gốc subtree `FOR UPDATE`; tăng `scope_version` của mọi membership có grant chạm subtree. Đồng thời: hai admin move cùng đơn vị → người sau 409 `VERSION_CONFLICT`.

### 3.2 Tổ chức lại đơn vị — sáp nhập/chia tách/giải thể (ADM-16)
Tiền điều kiện: văn bản căn cứ đã có (số/ngày). Hậu điều kiện: đơn vị cũ `Superseded/Dissolved` với `valid_until = effective_from`; thành viên, grant, dự án đã chuyển; lịch sử không đổi.
1. `proposeUnitReorganization`: kind, `effective_from`, `legal_basis_ref`, predecessor[], successors (đơn vị có sẵn hoặc tạo mới), mapping membership/dự án (hoặc `default_successor_unit_id`). Server tính danh sách membership Active + dự án chưa CLOSED của predecessor; thiếu mapping → 422 `REORG_MAPPING_INCOMPLETE` (errors liệt kê ID). Trạng thái Draft → PendingApproval.
2. `decideUnitReorganization` bởi người khác người đề xuất (403 `SELF_APPROVAL_DENIED`), If-Match → Approved; khởi chạy Temporal `UnitReorganizationWorkflow` (id `reorg:{tenant}:{reorg_id}`) → Applying.
3. Activities (mỗi activity idempotent, key `reorg:{id}:{step}:{item}`): (a) tạo successor mới nếu có; (b) ghi `organization_unit_succession`; (c) chuyển `membership.organization_id`; (d) tạo grant mới trên successor (copy role/scope_kind, `reorganization_id`), đặt grant cũ Expired; (e) gọi PRJ `requestProjectTransfer` + duyệt hệ thống cho từng dự án (cross-module XM-ADM-02); (f) đặt predecessor Superseded (MERGE/SPLIT) hoặc Dissolved (DISSOLVE), `successor_id` = successor mặc định; (g) phát `iam.org_unit.reorganization_applied.v1` + `iam.access.changed.v1` hàng loạt.
4. Lỗi một activity: retry theo policy Temporal (5 lần, backoff 10s→10m); vẫn lỗi → reorg Failed, `result_summary` ghi bước và ID lỗi; admin sửa nguyên nhân rồi `decide` lại (workflow tiếp tục từ bước lỗi, các bước xong bị bỏ qua nhờ idempotency).
5. Nếu `effective_from` ở tương lai: workflow chờ timer tới 00:00 ngày hiệu lực (giờ tenant) rồi mới chạy (c)–(g).

### 3.3 Thành viên và khách (ADM-02, ADM-17)
`inviteMember`: tạo membership Invited + `membership_invitation` (token 32 byte, hạn 7 ngày) + grant đề xuất (kiểm anti-escalation ngay lúc mời, Active khi chấp nhận); gửi email qua NOT (purpose SECURITY). `inviteGuestContractor`: như trên với `membership_type=GUEST_CONTRACTOR`, `contractor_id`, grant CONTRACT cho từng hợp đồng (CTR xác nhận hợp đồng Active và thuộc `contractor_id`; không → 422 `CONTRACT_NOT_ACTIVE`/`GUEST_SCOPE_INVALID`). Suspend/reactivate/end: If-Match, lý do, BR-IAM-07; suspend/end thu hồi phiên ngay.
(Cập nhật 1.6 — CR-ADM-07) Màn ADM-02 và ADM-17 đọc danh sách qua `get_resources_membership` (thêm tham số `membership_type` = STAFF / GUEST_CONTRACTOR / SERVICE_ACCOUNT; mỗi dòng có thêm `version` (giá trị If-Match của suspend/reactivate/end), `role_codes` (vai trò đang hiệu lực), `invitation_status` (lời mời mới nhất), và với khách `contractor_id`, `contractor_name`, `contracts` [{id, code}] — chỉ các hợp đồng thuộc đơn vị chủ quản nằm trong scope đọc của người xem). `inviteGuestContractor` yêu cầu người mời có cả `iam.guest.invite` và `iam.role.grant` trên các hợp đồng (BR-IAM-05 áp dụng cho vai trò khách); membership của khách thuộc đơn vị chủ quản của hợp đồng đầu tiên (theo id) và grant CONTRACT hết hiệu lực cùng `valid_until`. Giả định (BR-IAM-08): `valid_until` ≤ `completion_due` xa nhất của các hợp đồng + 365 ngày, tính từ hôm nay nếu hợp đồng chưa có hoặc đã qua ngày hoàn thành. Bộ chọn hợp đồng của ADM-17 đọc `get_resources_contract` (quyền `contract.read`): bản tối thiểu của CTR (R1) gồm `id`, `code`, `status`, `contractor_id`, `contractor_name`, `project_id`, `owner_unit_id`, `completion_due`, chỉ các hợp đồng có đơn vị chủ quản nằm trong scope đọc của người xem (scope PROJECT/CONTRACT không thêm gì, như các lần đọc có scope khác). Giá trị `membership_type` không hợp lệ → 422 `VALIDATION_FAILED`.

### 3.4 Vai trò và grant (ADM-03)
`grantRole`/`revokeRoleGrant`/`createCustomRole`/`updateCustomRole` thực thi BR-IAM-05/06 trong transaction: khóa membership người nhận `FOR UPDATE` → tính Effective của người cấp → kiểm → ghi → tăng `scope_version` → audit + outbox. Đồng thời: hai admin gán cùng vai trò cùng scope cho cùng người → bản thứ hai 409 `ROLE_GRANT_EXISTS` (unique logic trên grant Active trùng role+scope).
(Cập nhật 1.6 — CR-ADM-06) ADM-08 và ADM-14 liệt kê dữ liệu nên cần thao tác đọc: thêm get_resources_signing_certificate (_id) với quyền adm.signature.read và get_resources_security_policy_version (_id) với quyền adm.security.read, cùng cách đọc như CR-ADM-05; cả hai áp trên toàn tenant. Chứng thư chỉ trả dữ kiện công khai (số sê-ri, DN, hiệu lực, vân tay SHA-256), không bao giờ có khóa riêng.

(Cập nhật 1.5 — CR-ADM-05) Danh sách vai trò cho bộ chọn vai trò của ADM-03 đọc qua `get_resources_role_definition` (và `_id`): chủ tenant (grant TENANT có `iam.role.manage`) thấy mọi vai trò của tenant; người khác chỉ thấy vai trò họ cấp được trong scope của mình (rank thấp hơn rank cao nhất của họ trong scope, mọi permission của vai trò nằm trong quyền hiệu lực của họ) — bộ chọn không bao giờ liệt kê vai trò mà `grantRole` sẽ từ chối; `TENANT_OWNER` không bao giờ hiện với người không phải chủ tenant.

### 3.5 Ủy quyền có thời hạn (ADM-04)
`createDelegation` bởi chính người giao (hoặc TENANT_ADMIN thay mặt khi người giao vắng, kèm văn bản): quyền ủy ⊆ quyền người giao trên scope ủy; ≤ 90 ngày; không ủy quyền lại (người nhận không tạo được delegation từ quyền được ủy — 403 `DELEGATION_CHAIN_DENIED`); người nhận ≠ người giao. Khi grant gốc của người giao bị thu hồi/hết hạn → delegation tự Ended (job mỗi phút). Task duyệt bởi người được ủy ghi `decided_by` = người nhận, `on_behalf_of_id` = người giao, `delegation_id`; văn bản do DOC sinh dùng tiền tố "TUQ." [CXN-DOC-01].

### 3.5a Ủy quyền vĩnh viễn, quản trị làm thay và phạm vi theo kỳ báo cáo (ADM-25, ADM-26, ADM-27; IAM-2)
**Ủy quyền vĩnh viễn (ADM-25).** Khác ủy quyền có thời hạn (≤ 90 ngày), ủy quyền vĩnh viễn không có ngày hết hạn riêng nhưng phải nêu điều kiện kết thúc bằng lời (`SOURCE_HOLDS`: khi người giao hết quyền; `UNTIL_EVENT`: đến khi có sự kiện, người giao hoặc quản trị thu hồi và ghi sự kiện làm lý do; `UNTIL_DATE`: đến ngày cố định ≤ 5 năm) và có ngày rà soát ≤ 365 ngày. Ngày rà soát chính là ngày ủy quyền có hiệu lực đến (`valid_until`): quá ngày mà người giao chưa rà soát thì ủy quyền ngừng ngay (job đóng với `REVIEW_LAPSED`, hoặc `END_CONDITION_MET` khi đã đến ngày kết thúc cố định) nên mọi nơi đọc `delegation_grant` (engine phê duyệt, cửa quyết định, thẩm quyền ký) đều tôn trọng mà không đổi. Người giao chỉ **đề nghị** (`createStandingDelegationRequest`); người thứ hai có quyền `iam.delegation.approve`, khác người giao và khác người nhận theo người (không theo tư cách thành viên), duyệt hoặc từ chối (`decideStandingDelegationRequest`, bước tăng cường aal2); duyệt thì tạo delegation loại `PERMANENT` kèm `request_id`. Người giao rà soát bằng `reviewDelegation` (lùi ngày rà soát: tiến lên, trong 365 ngày kể từ nay, không quá ngày kết thúc cố định; không cứu được ủy quyền đã ngừng). Còn 14 ngày đến hạn rà soát thì job phát `iam.delegation.review_due.v1` một lần cho mỗi ngày rà soát. Quyền ủy vẫn chỉ gồm các quyền nghiệp vụ đọc được (`approval.decide`, `doc.outgoing.sign`), không bao giờ `iam.*`, `adm.*`. Ngày rà soát tối đa, số ngày cảnh báo và hạn 7 ngày chờ duyệt là cấu hình ghi rõ chưa kiểm chứng.

**Không khép vòng ủy quyền.** Mọi ủy quyền mới (cả hai loại) bị từ chối `403 DELEGATION_CYCLE_DENIED` nếu khép thành vòng giữa các **người** (A→B rồi B→A, hoặc qua người khác) với quyền trùng nhau; ủy quyền cho chính mình dưới tư cách thành viên khác cũng là vòng. Mọi lần dùng quyền được ủy ghi cả hai danh tính (ADM-11): dòng nhật ký quyết định phê duyệt và ký ghi người nhận là tác nhân, người giao ở `on_behalf_of_id`, kèm `delegation_id`.

**Quản trị làm thay (ADM-26).** Quản trị đề nghị (`requestActing`) làm thay một người trong ≤ 8 giờ, nêu lý do (≥ 20 ký tự) và các quyền của người đó cần dùng; chỉ nhập liệu: quyền quyết định, ký, duyệt (`approve`, `decide`, `sign`, `certify`, `accept`, `reject`, `return`, `issue`) và mọi `iam.*`, `adm.*`, `system.*` bị từ chối (`422 ACTING_INVALID`), không làm thay chính mình (`403 ACTING_SELF_DENIED`). Người thứ hai có quyền `iam.acting.approve`, khác người đề nghị và người được làm thay, duyệt (`decideActingRequest`, aal2); cửa sổ tính từ lúc duyệt. Trong cửa sổ, người đề nghị gửi `X-Acting-As: <mã phiên>`: cửa của API đọc phiên ở mỗi yêu cầu (hết giờ, thu hồi, người được làm thay không còn hoạt động hay mã của người khác đều `403 ACTING_NOT_LIVE`, không bao giờ rơi về quyền của quản trị) và xét yêu cầu trên quyền của người được làm thay, thu hẹp vào các quyền đã liệt kê. Mọi dòng nhật ký của yêu cầu ghi quản trị là tác nhân, người được làm thay ở `on_behalf_of_id` và phiên trong `acting_as` của diff; mỗi yêu cầu (kể cả đọc) còn có một dòng `acting.used`. Người đề nghị tự kết thúc hoặc người duyệt thu hồi (`revokeActing`).

**Phạm vi theo kỳ báo cáo (ADM-27).** Vai trò được giao (`createPeriodScope`, `liftPeriodScope`) hoặc ủy quyền (`period_codes` khi tạo) có thể giới hạn vào các kỳ (`2026-M03`, `2026-Q3`, `2026-H1`, `2026`; một kỳ gồm mọi kỳ nằm trong nó). Không có giới hạn thì hành vi như trước. Các lệnh của báo cáo tuần (tạo, sửa, nộp, quyết định, nhập, xuất) hỏi cổng kỳ trước khi ghi (`403 PERIOD_SCOPE_DENIED`); với ủy quyền, task phê duyệt của tài nguyên không có kỳ nằm ngoài tầm. Đặt và gỡ giới hạn được xét như cấp vai trò (người làm giữ đủ quyền của vai trò trên phạm vi, hơn bậc người được giao, không phải chính người đó) và nâng `scope_version` của người được giao.

### 3.6 Ma trận thẩm quyền — DoA (ADM-15)
1. `createDoaMatrixDraft` → Draft (revision = max + 1) với danh sách quy tắc `{document_type, unit_id, include_subtree, [amount_min_vnd, amount_max_vnd), approver_role_id, approval_levels, requires_distinct_approvers}`.
2. `updateDoaMatrixDraft` (chỉ Draft, If-Match). `submitDoaMatrix` kiểm BR-ADM-04 → PendingApproval.
3. `decideDoaMatrix` (≠ người lập): approve → Published, bản Published cũ Superseded (`effective_until` = `effective_from` mới); return → Draft; reject → Rejected.
Instance đang chạy giữ `doa_matrix_version_id` đã ghim; chỉ instance mới dùng bản mới.

### 3.7 Thực thi quy trình phê duyệt (ADM-06, ADM-18; HOME-02, MOB-23..25 bind)
Hợp đồng nội bộ (in-process, modular monolith) mà phân hệ nghiệp vụ gọi trong transaction gửi hồ sơ:
`ApprovalService.start({resource_type, resource_id, resource_version, document_type, amount_vnd|null, unit_id, initiator_membership_id, business_type})`.
1. Chọn `workflow_version` Published của `(kind=APPROVAL, business_type)`; không có → 422 `WORKFLOW_NOT_CONFIGURED`.
2. Nếu bước dùng `assignee_rule.type = DOA`: resolve DoA (BR-ADM-03) tại ngày nghiệp vụ; không có quy tắc → 422 `DOA_RULE_NOT_FOUND` — transaction gửi hồ sơ rollback, hồ sơ giữ Draft.
3. Ghi `workflow_instance` Running (ghim version + DoA) + outbox `adm.workflow_instance.started.v1` **trong transaction của phân hệ nghiệp vụ**; consumer khởi chạy Temporal `ApprovalWorkflow` với workflow id = `appr:{tenant}:{instance_id}` (idempotent — start trùng bị Temporal bỏ qua).
4. Workflow diễn giải định nghĩa: mỗi bước → activity `CreateApprovalTasks` (loại người lập, người đã duyệt bước trước nếu `requires_distinct_approvers`, membership không Active) → NOT gửi thông báo → chờ signal `TaskDecided` hoặc timer SLA (80% nhắc, 100% `on_timeout`: REMIND lặp mỗi 1 ngày làm việc hoặc ESCALATE giao thêm `escalate_to`).
5. `decideApprovalTask` (HTTP): khóa task `FOR UPDATE`; kiểm task Pending (409 `TASK_ALREADY_DECIDED`), người gọi là assignee hoặc người được ủy quyền hợp lệ, BR-ADM-02 (403 `SELF_APPROVAL_DENIED`), quyền + DoA (403 `APPROVER_NOT_AUTHORIZED`), aal2; ghi quyết định + audit + outbox `adm.approval_task.decided.v1`; consumer gửi signal tới Temporal (idempotent theo task id).
6. Kết thúc: APPROVED → activity gọi command domain (ví dụ `acceptReport`, `publishPlan`, `approvePaymentRequest`) với Idempotency-Key `wf:{instance}:final:{decision_seq}`; RETURNED → command trả lại; REJECTED → command từ chối. Domain transition table là guard bắt buộc: domain từ chối → instance `Completed/GUARD_REJECTED`, cảnh báo vận hành, không thay đổi hồ sơ (BR-ADM-07).
7. Hủy: phân hệ nghiệp vụ gọi `ApprovalService.cancel` khi hồ sơ bị rút; quản trị gọi `cancelWorkflowInstance` (ADM-18) → signal Cancel → task mở Cancelled.
8. `reassignApprovalTask`: người mới phải thỏa DoA/quyền, ≠ người lập; task cũ Reassigned, task mới Pending cùng `due_at`.
Đồng thời: hai người cùng quyết định một task (min_approvals 1) → một 200, một 409; quyết định trùng key → replay. Temporal mất kết nối DB → activity retry, không có quyết định nào bị ghi hai lần (DB unique task + idempotency).

### 3.8 Lịch làm việc (ADM-07)
`createWorkCalendarVersion` (calendar_code, năm, ngày làm việc trong tuần, ngày nghỉ lễ có căn cứ, ngày làm bù) → `publishWorkCalendar`. Ngày nghỉ lễ theo Bộ luật Lao động 2019 Điều 112 và thông báo hằng năm của Bộ Nội vụ/Thủ tướng [CXN-CAL-01]. Bản Published mới áp dụng cho task/hội thoại **tạo sau** thời điểm công bố; hạn đã tính không tự đổi (tránh dời hạn ngược). Kỳ báo cáo và hạn nộp do phân hệ sở hữu `reporting_period` tính bằng cùng hàm `addWorkingTime(calendar_version, start, duration)` mà ADM cung cấp (XM-ADM-01).

### 3.9 Cấu hình an toàn (ADM-14)
`createSecurityPolicyVersion` (mfa_required_roles, session_idle_minutes 5..240, session_max_hours 1..24, ip_allowlist CIDR, download_ttl_minutes, export_watermark) → `publishSecurityPolicy` (≠ người lập) → đồng bộ Keycloak (required actions, session timeouts) qua activity idempotent; lỗi đồng bộ → bản vẫn Published nhưng cảnh báo "chưa áp dụng ở IdP" cho tới khi đồng bộ thành công.

### 3.10 Nhập chuyển đổi dữ liệu (ADM-13)
`registerMigrationBatch` (tệp đã quét virus; `file_sha256` + `target_entity` unique → 409 `MIGRATION_FILE_ALREADY_REGISTERED`) → `dryRunMigrationBatch` (worker: schema, FK, khóa trùng, tổng kiểm soát; ghi báo cáo lỗi từng dòng; không ghi dữ liệu đích) → DryRunPassed/DryRunFailed → `applyMigrationBatch` (≠ người đăng ký; chỉ từ DryRunPassed; Temporal `MigrationApplyWorkflow` theo lô 1.000 dòng, mỗi lô một transaction, khóa nghiệp vụ để chạy lại không nhân đôi) → Applied, `control_totals` so với nguồn → `rollbackMigrationBatch` tạo bản ghi đảo/đánh dấu `migrated_batch_id` không hiệu lực (409 `MIGRATION_DEPENDENTS_EXIST` nếu đã có giao dịch phát sinh trên dữ liệu nhập).

### 3.11 Nhật ký kiểm toán (ADM-11)
Đọc theo scope (AUDITOR/TENANT_ADMIN); lọc theo actor, action, resource, outcome, thời gian. `exportAuditLog` (≤ 366 ngày mỗi lần; vượt → 422 `EXPORT_RANGE_TOO_LARGE`) tạo tệp CSV/JSONL kèm danh sách `audit_seal` bao phủ khoảng seq để bên nhận tự kiểm chuỗi.

### 3.12 Chính sách lưu trữ và legal hold (ADM-12)
`createRetentionPolicyVersion` theo lớp hồ sơ (`project_dossier`, `payment_dossier`, `report_revision`, `audit_event`, `delivery_attempt`, `idempotency_record`…) → `publishRetentionPolicy` (≠ người lập). Job retention hằng ngày: lớp nghiệp vụ hết hạn → đưa vào danh sách "chờ hội đồng xác định giá trị" (không tự xóa); lớp kỹ thuật `AUTO_PURGE_TECHNICAL` → xóa vật lý. `placeLegalHold` (authority_reference bắt buộc) / `releaseLegalHold` (≠ người đặt, lý do ≥ 10 ký tự). Mọi job xóa/purge (retention, offboarding tenant, xóa tệp tạm) gọi `LegalHoldService.isHeld(scope)` trước từng bản ghi.

### 3.13 Connector và hộp sự kiện vào (ADM-09, ADM-10)
`createIntegrationConnector`/`updateIntegrationConnector`: `adapter_status` bắt buộc trung thực — Kho bạc/Hệ thống TTQG về ĐTC/muasamcong không có API công khai → `mode=FILE_IMPORT|FILE_EXPORT`, `adapter_status=PROPOSED` cho tới khi có hợp đồng; connector PROPOSED/MISSING không Active (422 `CONNECTOR_NOT_ACTIVATABLE`); MOCK chỉ Active ở môi trường không phải production. `replayInboxEvent` cho FAILED/DEAD (409 `INBOX_STATE_INVALID` nếu khác).

### 3.14 Tách bạch nhiệm vụ khi ghi lệnh (ADM-24; G4-1)
Ma trận các cặp nhiệm vụ một người không được giữ cùng lúc là quy tắc `SOD_MATRIX` của kho quy tắc quản trị (ADM-19), đọc qua `GovernancePolicyPort`: mỗi cặp có `action_a`, `action_b`, phạm vi tính (`SAME_RECORD`, `SAME_PROJECT`, `SAME_CONTRACT`, `SAME_PACKAGE`), mức xử lý (`BLOCK` chặn lệnh, `WARN` chỉ để lại dấu vết cho kiểm toán) và `exception_max_days` (0: không có ngoại lệ); `exception_approvers` là số người duyệt ngoại lệ, không bao giờ dưới 2. Mặc định là giá trị khởi điểm ghi rõ "chưa kiểm chứng". Màn ADM-24 hiện ma trận kèm công thức, nguồn, ngày, phiên bản, và sổ ngoại lệ.
Mỗi lệnh của CTR (ký, kích hoạt hợp đồng; quyết định đo đạc; quyết định nghiệm thu), PAY (gửi, kiểm tra đề nghị thanh toán; chuyển Kho bạc) và BID (đánh giá, ký biên bản đánh giá, đề xuất và duyệt kết quả) làm xong việc của mình rồi hỏi `SodGuard` trong cùng giao dịch: người thực hiện đã giữ nhiệm vụ kia của cặp trong cùng phạm vi hay chưa (đọc từ cột đã có: ai lập, ai gửi, ai duyệt; không cần dữ liệu lịch sử). Cặp `BLOCK` không có ngoại lệ dùng được → 422 `SOD_VIOLATION` nêu hai nhiệm vụ của cặp (`action_a`, `action_b`, `taking`, `held`, `scope`), không nêu người hay hồ sơ; lệnh hoàn tác toàn bộ, còn lần thử bị chặn được ghi ở `sod_exception_use` (BLOCKED) và nhật ký kiểm toán (DENIED) trong giao dịch riêng. Cặp `WARN` và lần dùng ngoại lệ ghi `sod_exception_use` (WARNED, EXCEPTION_USED) cùng giao dịch với lệnh. Không đọc được ma trận hay cột nhiệm vụ → 503 `SOD_CHECK_UNAVAILABLE`, không bao giờ coi là "không có xung đột". Kiểm tra "người lập khác người duyệt" sẵn có của từng lệnh (`SELF_APPROVAL_DENIED`) là nền, không ngoại lệ nào gỡ được.
Ngoại lệ (`requestSodException`, `approveSodException`, `rejectSodException`, `revokeSodException`): cho một người, một cặp và một đối tượng (hồ sơ, dự án, hợp đồng hoặc gói thầu), từ hôm nay trở đi, không dài hơn `exception_max_days` của cặp (422 `SOD_EXCEPTION_WINDOW_INVALID`), có lý do 10 đến 500 ký tự. Có hiệu lực khi đủ số người duyệt, mỗi người khác nhau và khác cả người xin lẫn người được áp dụng (403 `SELF_APPROVAL_DENIED`; trigger của cơ sở dữ liệu kiểm lại); một người từ chối là chấm dứt; quản trị viên thu hồi có lý do, hiệu lực ngay. Hết ngày cuối tự hết hiệu lực (`EXPIRED` do bộ đọc suy ra, không có ghi). Mỗi người, cặp, đối tượng chỉ có một ngoại lệ sống tại một ngày (409 `SOD_EXCEPTION_STATE_INVALID`). Quyền: `adm.sod.read`, `adm.sod.exception.request`, `adm.sod.exception.approve`, `adm.sod.exception.revoke` (trên toàn tổ chức); kiểm toán đọc `sod_exception` và `sod_exception_use` bằng `aud.sod.read` (AUD-13). Loại cảnh báo: `SOD_EXCEPTION_EXPIRING` (ACTION, chủ ADM administrator) và `SOD_EXCEPTION_USED` (WATCH, chủ AUD). Chi tiết: docs/gov-d-sod.md.

### 3.15 Kho quy tắc quản trị và sổ loại cảnh báo (ADM-19 đến ADM-23; G0-1, G0-3)
Mọi ngưỡng, định nghĩa và chính sách của hệ thống (30 loại quy tắc: loại cảnh báo, đèn xanh vàng đỏ, định nghĩa chỉ tiêu, tầng lệnh thay đổi, tách bạch nhiệm vụ, hạn đăng tải, tiêu chí tài chính, quy trình lựa chọn nhà thầu…) là dữ liệu, không phải hằng số trong mã. Mỗi **loại** (`rule_type`) có một đơn vị sở hữu, lược đồ tham số, công thức, căn cứ, ngày lấy số và trạng thái kiểm chứng (`VERIFIED`/`UNVERIFIED`); mỗi **mã** (`code`) dưới loại có thể có **mặc định có sẵn** của nền tảng (con số khởi điểm của nghiên cứu, chưa xác nhận với luật hoặc khách hàng thì ghi "chưa kiểm chứng" trên mọi màn hình hiện số đó). Tenant ghi đè bằng **phiên bản** của mình; chưa có phiên bản được duyệt thì dùng mặc định.
1. **ADM-19 Kho quy tắc quản trị** (`getGovernanceRuleCatalog`): mỗi loại với đơn vị sở hữu, số mã, số mã đang dùng quy tắc riêng và số mã còn dùng mặc định, trạng thái kiểm chứng, căn cứ, ngày lấy số, công thức; lọc theo đơn vị sở hữu, chỉ loại chưa kiểm chứng. Một loại còn bản đã lưu nhưng nền tảng không còn đăng ký thì vẫn được liệt kê và đánh dấu, không bị ẩn.
2. **ADM-20 Chi tiết loại quy tắc**: mở bằng loại thì liệt kê các mã (đang dùng quy tắc riêng phiên bản nào hay mặc định); mở bằng loại và mã thì đặt **quy tắc đang áp dụng cạnh mặc định có sẵn** (`getEffectiveGovernanceRule`, mặc định đọc tại một ngày trước mọi quy tắc), mỗi tham số một hàng, hàng khác mặc định ghi chữ "khác mặc định", số có đơn vị theo tên trường (đồng, %, giờ, ngày). Bên dưới là **lịch sử phiên bản** (`listGovernanceRuleVersions`, mới nhất trước) và dòng thời gian các thao tác (lập, trình, duyệt, ngừng, ai làm, lúc nào), mỗi phiên bản có liên kết so sánh (ADM-22) và "soạn phiên bản mới từ bản này" (ADM-21).
3. **ADM-21 Soạn phiên bản quy tắc** (`createGovernanceRuleDraft`): biểu mẫu **sinh từ lược đồ tham số** của loại — số nguyên/số thực kèm khoảng cho phép, văn bản kèm độ dài, ngày, giờ, lựa chọn, danh sách thêm/bỏ mục, nhóm lồng nhau; bắt đầu từ quy tắc đang áp dụng hoặc phiên bản được chọn để sửa chút ít; mỗi trường sai có thông báo ngay cạnh trường và tóm tắt đầu trang; tham số tiền ghi "ĐVT: đồng". Hiệu lực từ ngày (không ở quá khứ) và đến ngày (không bắt buộc); **cảnh báo chồng hiệu lực trước khi lưu**: phiên bản sẽ thay thế một phiên bản bắt đầu sớm hơn và được bao trùm (báo "phiên bản N kết thúc ngày …"), hay chồng lên phiên bản đã duyệt mà không thay thế được (báo trước là sẽ bị từ chối), hay bắt đầu ở quá khứ. Lý do bắt buộc 5 đến 500 ký tự. Lưu bản nháp chưa đổi gì trên quy tắc đang áp dụng. Loại cảnh báo không có hành động mong đợi thì chỉ được mức Theo dõi (form báo trước khi gửi).
4. **Trình – duyệt – ngừng** (`submitGovernanceRule`, `withdrawGovernanceRule`, `approveGovernanceRule`, `retireGovernanceRule`; trên ADM-20): mỗi thao tác mở hộp xác nhận nêu **đối tượng, phiên bản, hiệu lực, lý do của phiên bản, người lập và người trình** và nguyên tắc của thao tác, rồi hỏi lý do 5 đến 500 ký tự. Duyệt phải do **người thứ ba**: không phải người lập và không phải người trình (403 `SELF_APPROVAL_DENIED`); nút Duyệt tắt kèm lời giải thích cho người lập hoặc người trình, và nếu máy chủ vẫn từ chối thì lời giải thích hiện ngay trong hộp xác nhận. Phiên bản có ngày bắt đầu đã qua không duyệt được (giải thích, không chờ máy chủ từ chối). Ngừng một phiên bản đang hiệu lực hoặc chờ đến ngày hiệu lực cần **cả quyền soạn lẫn quyền duyệt**; có thể chọn ngày ngừng; bản nháp và bản đã trình thì chỉ cần quyền soạn để bỏ. Duyệt xong, phiên bản có hiệu lực từ ngày bắt đầu và phiên bản đang áp dụng của cùng mã và đơn vị kết thúc đúng ngày đó. Phiên bản đã ghi không bao giờ sửa; đổi là một phiên bản mới.
5. **ADM-22 So sánh phiên bản quy tắc** (`getGovernanceRuleDiff`): so với bản trước, bản được chọn hoặc mặc định có sẵn; mỗi tham số thêm, bỏ hoặc đổi là một hàng với giá trị trước và sau (có đơn vị); loại thay đổi là chữ kèm biểu tượng (＋ thêm, － bỏ, ≠ đổi), không chỉ dựa vào màu.
6. **ADM-23 Sổ loại cảnh báo** (`listAlertTypes`; `getAlertType`): mỗi loại cảnh báo có **chủ sở hữu, hành động mong đợi, hậu quả nếu không làm, thời hạn đáp ứng (giờ), mức mặc định, lý do tồn tại và ngày xét lại**, kèm phiên bản và nguồn quy tắc đang áp dụng (quy tắc của tenant hay mặc định) và nhãn "chưa kiểm chứng". Loại không có hành động mong đợi mang nhãn "chỉ ở mức Theo dõi" (nếu dữ liệu lại để mức khác thì đánh dấu "sai quy tắc"); loại quá ngày xét lại được đánh dấu "quá hạn xét lại N ngày" và đếm riêng, loại trong 30 ngày tới đánh dấu "sắp đến hạn xét lại". Lọc theo nguồn, chủ sở hữu, chỉ loại cần xét lại, chỉ loại chưa có hành động mong đợi; mở một loại sang ADM-20 để xem phiên bản. Mỗi cảnh báo mới của mọi phân hệ phải có một loại trong sổ này (chủ sở hữu, hành động mong đợi, hậu quả).
Mọi trạng thái: đang tải (khung xám, không bao giờ hiện số 0), rỗng chỉ khi máy chủ nói không có, lỗi đọc nêu rõ và thử lại tại chỗ (không bao giờ hiện thành "không có quy tắc"), không đủ quyền (không lộ tên), đang gửi (khóa nút, không gửi hai lần), thành công (biên nhận: phiên bản, thời điểm, bước tiếp theo), xung đột phiên bản (tải lại rồi làm lại).

## 4. State machine

```
DoA / retention / security policy / workflow_version:
 Draft ──submit──► PendingApproval ──decide approve (≠ người lập)──► Published ──(bản mới Published)──► Superseded
   ▲                    │ return                                         │ (workflow_version) retire
   └────────────────────┘           decide reject ──► Rejected            ▼
                                                                        Retired
workflow_instance:  Running ──(bước cuối APPROVED/REJECTED/RETURNED, guard ok)──► Completed
                    Running ──guard từ chối──► Completed(outcome GUARD_REJECTED)
                    Running ──cancel──► Cancelled ;  Running ──lỗi kỹ thuật vượt retry──► Failed (vận hành xử lý)
approval_task:      Pending ──decide──► Decided ; Pending ──reassign──► Reassigned ; Pending ──instance cancel──► Cancelled ; Pending ──hết hạn + on_timeout=EXPIRE──► Expired
unit_reorganization: Draft→PendingApproval→Approved→Applying→Applied ; Applying→Failed→(decide lại)→Applying ; Draft/PendingApproval→Cancelled
migration_batch:    Uploaded→Validating→DryRunPassed|DryRunFailed ; DryRunPassed→PendingApproval→Applying→Applied|Failed ; Applied→RolledBack
delegation_grant:   Scheduled→Active→Ended ; Scheduled/Active→Revoked
legal_hold:         Active→Released
governance_rule:    Draft ──submit──► Submitted ──approve (≠ người lập, ≠ người trình)──► Approved ──retire (soạn + duyệt)──► Retired ; Submitted ──withdraw──► Draft ; Draft/Submitted ──retire (bỏ, chỉ cần quyền soạn)──► Retired
```

| Từ | Command | Đến | Ai | Guard | Audit/Event |
|---|---|---|---|---|---|
| Draft | `submitDoaMatrix` | PendingApproval | `adm.doa.manage` | BR-ADM-04 phủ dải, không chồng | `doa.submitted` |
| PendingApproval | `decideDoaMatrix` approve | Published | `adm.doa.approve`, ≠ created_by | If-Match | `doa.decided`, `adm.doa_matrix.published.v1` |
| Draft (workflow) | `publishWorkflowVersion` | Published | `adm.workflow.publish`, ≠ created_by | DSL hợp lệ (BR-ADM-05) | `adm.workflow_version.published.v1` |
| Running | `decideApprovalTask` (bước cuối) | Completed | assignee/delegate | BR-ADM-02, DoA, aal2 | `adm.approval_task.decided.v1`, `adm.workflow_instance.completed.v1` |
| Running | `cancelWorkflowInstance` | Cancelled | `adm.workflow.operate` | lý do | `adm.workflow_instance.cancelled.v1` |
| Pending (task) | `reassignApprovalTask` | Reassigned | `adm.workflow.operate` | người mới đủ thẩm quyền | `adm.approval_task.reassigned.v1` |
| PendingApproval (reorg) | `decideUnitReorganization` | Approved→Applying | `iam.unit.reorganize.approve`, ≠ requested_by | mapping đủ | `iam.org_unit.reorganization_approved.v1` |
| DryRunPassed | `applyMigrationBatch` | Applying | `adm.migration.approve`, ≠ created_by | — | `adm.migration_batch.applied.v1` |
| Active (hold) | `releaseLegalHold` | Released | `legal_hold.manage`, ≠ placed_by | lý do ≥ 10 | `platform.legal_hold.released.v1` |
| Draft | `submitGovernanceRule` | Submitted | `adm.governance.manage` | tham số kiểm lại theo lược đồ | `governance_rule.submitted` |
| Submitted | `withdrawGovernanceRule` | Draft | `adm.governance.manage` | If-Match | `governance_rule.withdrawn` |
| Submitted | `approveGovernanceRule` | Approved | `adm.governance.approve`, ≠ người lập, ≠ người trình | ngày bắt đầu ≥ hôm nay; chồng hiệu lực phải là kế nhiệm; phiên bản đang áp dụng kết thúc đúng ngày bắt đầu | `governance_rule.approved`, `adm.governance_rule.approved.v1` |
| Draft/Submitted | `retireGovernanceRule` | Retired | `adm.governance.manage` | lý do 5–500 ký tự; không có ngày ngừng | `governance_rule.retired` |
| Approved | `retireGovernanceRule` | Retired | `adm.governance.manage` **và** `adm.governance.approve` | ngày ngừng không ở quá khứ, không sau ngày vốn có | `governance_rule.retired`, `adm.governance_rule.retired.v1` |

Chuyển bị cấm: sửa bản Published/Superseded (409 `DOA_MATRIX_NOT_DRAFT`/`WORKFLOW_NOT_DRAFT`); quyết định task không Pending (409 `TASK_ALREADY_DECIDED`); apply từ DryRunFailed (409 `MIGRATION_STATE_INVALID`); apply lại batch Applied (409 `MIGRATION_FILE_ALREADY_APPLIED`); release hold đã Released (409 `LEGAL_HOLD_STATE_INVALID`). Quy tắc quản trị: sửa phiên bản đã ghi (đổi là phiên bản mới); trình phiên bản không phải Draft, rút hoặc duyệt phiên bản không phải Submitted, ngừng phiên bản đã Retired (409 `GOVERNANCE_RULE_STATE_INVALID`); duyệt chồng hiệu lực mà không phải kế nhiệm (409 `GOVERNANCE_RULE_PERIOD_OVERLAP`); duyệt phiên bản bắt đầu ở quá khứ (422 `VALIDATION_FAILED` trường `effective_from`); tham số sai lược đồ (422 `GOVERNANCE_RULE_PARAMS_INVALID`, nêu trường, không nêu giá trị).

## 5. Quy tắc nghiệp vụ và công thức

### 5.1 Quy tắc quản trị
- **BR-ADM-01 Bốn mắt cho cấu hình.** Mọi bản cấu hình có hiệu lực quyền/tiền/dữ liệu (DoA, workflow, retention, security policy, reorg, migration apply, legal hold release) phải được duyệt/công bố bởi người khác người lập; DB CHECK `approved_by <> created_by` là hàng rào thứ hai.
- **BR-ADM-02 Maker ≠ checker cho hồ sơ.** Người quyết định task (kể cả qua ủy quyền) ≠ `initiator_user_id` của instance và ≠ người tạo/gửi phiên bản tài nguyên; nếu `requires_distinct_approvers` thì ≠ mọi người đã duyệt bước trước của cùng instance. So sánh theo `user_account.id` (không theo membership — một người hai membership vẫn là một người). Vi phạm → 403 `SELF_APPROVAL_DENIED`; resolver không giao task cho các người này ngay từ đầu.
- **BR-ADM-03 Resolve DoA.** Với `(document_type, amount_vnd, unit_id, business_date)`: lấy matrix Published có `effective_from ≤ business_date < effective_until`; lọc quy tắc cùng `document_type` có `unit_id = u` hoặc (`include_subtree` và `u.path` bắt đầu bằng `rule_unit.path`); chọn quy tắc của đơn vị **gần nhất** (path dài nhất); trong đó chọn dải `amount_min_vnd ≤ amount < amount_max_vnd` (NULL = ∞). Hồ sơ không có số tiền dùng dải chứa 0. Kết quả: `approver_role_id` × `approval_levels`. Không có → 422 `DOA_RULE_NOT_FOUND`. Ví dụ FX: 4.999.999.999 VND → LEADER_BQLGT; 5.000.000.000 → LEADER_STC; 25.000.000.000 → LEADER_UBND × 2 cấp (UAT-AC126). Ngưỡng là dữ liệu tenant tự cấu hình theo quy chế nội bộ, không mã hóa cứng [CXN-DOA-01].
- **BR-ADM-04 Hợp lệ DoA.** Với mỗi `(document_type, unit_id)`: các dải sắp theo `amount_min_vnd` phải liên tục từ 0 tới ∞ (`max_i = min_{i+1}`, dải cuối `max = NULL`) và không chồng lấn (EXCLUDE gist trên `numrange`). Lỗi trả `errors[{field:"rules[i].amount_min_vnd", code: GAP|OVERLAP|NOT_FROM_ZERO|NOT_TO_INFINITY}]`.
- **BR-ADM-05 DSL quy trình.** `definition` gồm `steps[]` có `id` duy nhất, `assignee_rule.type ∈ {DOA, ROLE_IN_UNIT, SPECIFIC}`, `min_approvals ≥ 1`, `sla_working_hours > 0`, `on_timeout ∈ {REMIND, ESCALATE, EXPIRE}`, `allow_return_to` trỏ bước trước; đồ thị không vòng ngoài cạnh return; mọi kết thúc ánh xạ tới command domain đã đăng ký cho `business_type`. Sai → 422 `WORKFLOW_DEFINITION_INVALID` với đường dẫn JSON.
- **BR-ADM-06 Ủy quyền.** Như §3.5; tối đa 90 ngày (DB CHECK); delegation không cấp quyền quản trị `iam.*`/`adm.*` [GIẢ ĐỊNH — chỉ quyền nghiệp vụ được ủy].
- **BR-ADM-07 Guard domain.** Temporal không bao giờ ghi trạng thái hồ sơ trực tiếp; mọi chuyển trạng thái đi qua command domain có transition table. Command từ chối → `GUARD_REJECTED` (không retry vô hạn: lỗi 4xx dừng ngay; 5xx retry 5 lần).
- **BR-ADM-08 Thời gian làm việc.** `addWorkingTime(cal, start, h)`: duyệt từng khoảng làm việc (mặc định 08:00–12:00, 13:00–17:00 giờ tenant) của ngày làm việc (không phải T7/CN trừ ngày làm bù, không phải ngày nghỉ) và cộng dồn tới đủ `h` giờ; nếu `start` ngoài giờ thì bắt đầu từ đầu khoảng kế tiếp. Ví dụ: 2026-04-29 15:00 + 8h, nghỉ 30/4–1/5, T7–CN 2–3/5 → 2026-05-04 15:00 (+07) (UAT-AC134). Nhắc ở 80% thời lượng làm việc.
- **BR-ADM-09 Chứng thư.** Chỉ nhận chứng thư X.509 công khai (PEM/DER); từ chối tệp chứa khóa riêng (422 `CERTIFICATE_INVALID`, không lưu, không log); hết hạn → 422 `CERTIFICATE_EXPIRED`; trùng fingerprint → 409 `CERTIFICATE_DUPLICATE`; job hằng ngày chuyển Expired khi quá `valid_until`, cảnh báo trước 30 ngày.
- **BR-ADM-10 Connector trung thực.** `status=Active` chỉ khi `adapter_status ∈ {VERIFIED, MOCK}` (DB CHECK) và MOCK bị chặn ở production bằng cấu hình môi trường.
- **BR-ADM-11 Lưu trữ.** Lớp hồ sơ nghiệp vụ (`*_dossier`, `report_revision`, `contract*`, `payment*`, `audit_event`) chỉ được `REVIEW_FOR_DESTRUCTION` hoặc `ARCHIVE_TRANSFER`; `AUTO_PURGE_TECHNICAL` chỉ cho lớp kỹ thuật (`idempotency_record` sau `expires_at`: 72 giờ, hoặc 7 ngày với lệnh tiền và lệnh hàng đợi offline, `outbox_event` đã publish 30 ngày, `integration_event_inbox` payload 90 ngày, `user_session` 180 ngày, `delivery_attempt` chi tiết 365 ngày) → ngược lại 422 `RETENTION_POLICY_INVALID`. `PERMANENT` ⇔ `retention_years IS NULL`.
- **BR-ADM-12 Chuyển đổi idempotent.** Khóa `(tenant, target_entity, file_sha256)`; mỗi dòng mang khóa nghiệp vụ nguồn → upsert theo khóa này, chạy lại một lô không nhân đôi; `control_totals` (số dòng, tổng tiền numeric(24,0)) phải khớp tệp nguồn, lệch → Failed.
- **BR-ADM-13 Quy tắc là dữ liệu có phiên bản.** Không ngưỡng, định nghĩa hay chính sách nào là hằng số trong mã hay trong màn hình: mã đọc qua `GovernancePolicyPort` (quy tắc đã duyệt của tenant đang hiệu lực, hoặc mặc định có sẵn) và lưu phiên bản đã dùng cùng quyết định. Mỗi loại và mỗi mặc định có công thức, căn cứ, ngày lấy số, trạng thái kiểm chứng (`npm run governance:check`); con số pháp lý hoặc của nghiên cứu chưa xác nhận là `UNVERIFIED` và mọi màn hình hiện nó ghi "chưa kiểm chứng". Phiên bản không bao giờ sửa; hiệu lực của cùng (loại, mã, đơn vị) không chồng lấn (EXCLUDE trên khoảng ngày), phiên bản mới thay phiên bản đang áp dụng đúng ngày nó bắt đầu; ghi đè theo đơn vị áp dụng cho đơn vị đó và các đơn vị con, đơn vị gần nhất thắng.
- **BR-ADM-14 Ba người cho quy tắc.** Người duyệt phiên bản quy tắc ≠ người lập và ≠ người trình (403 `SELF_APPROVAL_DENIED`); ngừng phiên bản đang hiệu lực cần cả quyền soạn lẫn quyền duyệt; mọi bước ghi nhật ký (ADM-11) kèm lý do 5–500 ký tự và, khi duyệt hoặc ngừng phiên bản đã duyệt, phát `adm.governance_rule.approved.v1`/`adm.governance_rule.retired.v1` để nơi đọc quy tắc làm mới.
- **BR-ADM-15 Sổ loại cảnh báo.** Mỗi loại cảnh báo (`ALERT_TYPE`) có chủ sở hữu, hành động mong đợi, hậu quả, thời hạn đáp ứng (1–8760 giờ), mức mặc định, lý do tồn tại và ngày xét lại; **loại không có hành động mong đợi chỉ được mức `WATCH`** (422 `GOVERNANCE_RULE_PARAMS_INVALID` trường `default_severity`); loại quá ngày xét lại được đánh dấu và đếm. Cảnh báo mới không có loại trong sổ là lỗi của làn thêm nguồn.

### 5.2 Dịch vụ nền tảng dùng chung (mọi phân hệ dùng, ADM sở hữu)
- **BR-PLT-01 Audit bất biến.** Mỗi command ghi `audit_event` trong **cùng transaction** với thay đổi (outcome SUCCESS) gồm actor, `impersonator_id` (support), `on_behalf_of_id` (ủy quyền), action, resource, `safe_diff` (đã redact theo classification; không tiền mật, không nội dung đề án, không secret), reason, correlation/request id, classification. Lệnh bị từ chối ở PDP/guard ghi outcome DENIED bằng transaction riêng. Runtime role chỉ INSERT/SELECT; trigger chặn UPDATE/DELETE. Job seal mỗi 5 phút: Merkle root theo `seq` tăng dần, `seal_hash = sha256(prev_seal_hash || merkle_root || to_seq)`; `verifyAuditSeals` hằng giờ — lệch → cảnh báo P1 (UAT-AC139).
- **BR-PLT-02 Idempotency.** Mọi POST/PUT/PATCH/DELETE bắt buộc `Idempotency-Key` 16–128 ký tự; khóa duy nhất `(tenant_id, subject_id, operation, key_hash)` với `key_hash = sha256(key)`; `request_hash = sha256(canonical JSON body + path params + If-Match)`. Lần đầu: INSERT IN_PROGRESS (`locked_until = now+30s`) trước khi xử lý; xong ghi COMPLETED + response (2xx/4xx nghiệp vụ). Cùng key + cùng hash → trả lại response với header `Idempotency-Replayed: true`; khác hash → 409 `IDEMPOTENCY_CONFLICT`; đang IN_PROGRESS → 409 `IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 2`; lỗi 5xx → FAILED_RETRYABLE (cho phép gửi lại cùng key). TTL tối thiểu 72 giờ cho mọi lệnh; lệnh tiền (chuyển tiền, ghi sổ tài chính) và lệnh từ hàng đợi offline mobile 7 ngày (DB CHECK 72 giờ ≤ TTL ≤ 7 ngày); quy tắc duy nhất ở `04_Thiet_ke_co_ban.md` (Cập nhật 1.4 — CR-04-37).
- **BR-PLT-03 Outbox.** Sự kiện ghi `outbox_event` cùng transaction, `event_key` duy nhất theo tenant (ví dụ `report.submitted:{report_id}:{version}`) để chống phát logic trùng; relay (role `machvon_outbox_relay`, không BYPASSRLS, chỉ có policy trên outbox) poll `FOR UPDATE SKIP LOCKED` 100 dòng/lần, publish, đánh dấu PUBLISHED; lỗi → `attempts+1`, `next_attempt_at` backoff 1s·2^n tối đa 10 phút; 20 lần → DEAD + cảnh báo. Consumer idempotent theo `(consumer, event_id)` (bảng inbox nội bộ của consumer hoặc ràng buộc unique nghiệp vụ). Thứ tự chỉ đảm bảo theo `aggregate_id` (`aggregate_version` tăng dần).
- **BR-PLT-04 Legal hold.** `LegalHoldService.isHeld(resource)` = tồn tại hold Active có `resource_scope` chứa tài nguyên (TENANT ⊇ UNIT subtree ⊇ PROJECT ⊇ CONTRACT ⊇ RESOURCE). Hold không chặn đọc/ghi nghiệp vụ (đã có phiên bản), chỉ chặn mọi xóa/purge/ẩn danh và chặn archive purge khi offboarding.
- **BR-PLT-05 Problem.** Lỗi trả `application/problem+json` với `code` ổn định trong danh mục mã của 5 phân hệ (xem `x-error-codes` từng operation); không lộ tồn tại tài nguyên tenant khác.

## 6. Dữ liệu

| Bảng | Trường chính | Ràng buộc / index | Phân loại | Lưu giữ |
|---|---|---|---|---|
| `unit_reorganization` (mới) | kind, effective_from, legal_basis_ref, mapping_json, status, requested_by, approved_by, temporal_workflow_id, result_summary, version | CHECK approved_by ≠ requested_by | INTERNAL | vĩnh viễn |
| `organization_unit_succession` (mới) | reorganization_id, predecessor_unit_id, successor_unit_id, effective_from, mapping_note | UNIQUE (tenant, pred, succ); FK ×3 | INTERNAL | vĩnh viễn |
| `delegation_grant` (mới) | delegator/delegate_membership_id, permissions[], scope_json, valid_from/until, reason, legal_basis_ref, status | CHECK ≠, ≤ 90 ngày | INTERNAL | 10 năm |
| `doa_matrix_version` (mới) | revision, status, effective_from/until, legal_basis_ref, created_by, approved_by | UNIQUE (tenant, revision); CHECK bốn mắt | INTERNAL | vĩnh viễn |
| `doa_rule` (mới) | matrix_version_id, document_type, unit_id, include_subtree, amount_min/max_vnd numeric(24,0), approver_role_id, approval_levels, requires_distinct_approvers | EXCLUDE gist chồng dải; CHECK min ≥ 0, max > min | INTERNAL | vĩnh viễn |
| `workflow_version` (sửa) | + kind APPROVAL/NOTIFICATION, event_type, created_by, published_at, effective_from, supersedes_id, definition_hash, version | UNIQUE (tenant, kind, business_type, revision); 1 Published/loại; CHECK publisher ≠ creator | INTERNAL | vĩnh viễn |
| `workflow_instance` (sửa) | + temporal_workflow_id/run_id, initiator_membership_id/user_id, document_type, amount_vnd, unit_id, doa_matrix_version_id, outcome, ended_at, version | UNIQUE temporal id; 1 Running/tài nguyên | INTERNAL | theo lớp hồ sơ của tài nguyên |
| `approval_task` (sửa) | + step_id, status, required_role_id, decided_by, on_behalf_of_id, delegation_id, signature_ref, version | CHECK decided ⇔ decision; lý do ≥ 10 ký tự khi return/reject; UNIQUE task mở/bước/người | INTERNAL | như trên |
| `work_calendar_version` (mới) | calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status | 1 Published/(code, năm) | PUBLIC | vĩnh viễn |
| `signing_certificate` (mới) | kind, holder_membership_id/organization_unit_id, serial, issuer/subject DN, provider_code, valid_from/until, fingerprint_sha256, status | UNIQUE fingerprint; CHECK kind↔holder | INTERNAL | 10 năm sau hết hạn |
| `integration_connector` (mới) | connector_code, adapter_status, mode, config_json (không secret), credential_secret_ref, mapping_version, status | CHECK Active ⇒ VERIFIED/MOCK | INTERNAL | vĩnh viễn |
| `integration_event_inbox` (sửa) | + provider_event_type, channel_account_id, signature_key_id, provider_timestamp, attempts, next_attempt_at, processed_at, error_code | UNIQUE (tenant, provider, event_key) có sẵn; CHECK status | INTERNAL | payload 90 ngày, metadata 2 năm |
| `data_retention_policy` (mới) | record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status | CHECK PERMANENT ⇔ years NULL; bốn mắt | PUBLIC | vĩnh viễn |
| `legal_hold` (sửa) | + hold_kind, status, placed_by, released_by, release_reason, version | CHECK release đủ trường; released_by ≠ placed_by | CONFIDENTIAL | vĩnh viễn |
| `migration_batch` (mới) | source_system, target_entity, file_sha256, file_storage_key, mapping_version, row/error_count, status, dry_run_report_ref, control_totals, created_by, approved_by | UNIQUE (tenant, entity, sha); bốn mắt | INTERNAL | 10 năm |
| `security_policy_version` (mới) | revision, policy_json, status, created_by, approved_by | bốn mắt | INTERNAL | vĩnh viễn |
| `governance_rule` (mới, V1850) | rule_type, code, version, unit_id, status (DRAFT/SUBMITTED/APPROVED/RETIRED), params jsonb, effective_from, effective_to, reason, created_by, submitted_by, approved_by, retired_by, retire_reason, row_version | UNIQUE (tenant, rule_type, code, unit, version); EXCLUDE khoảng ngày của bản đã duyệt cùng (loại, mã, đơn vị); CHECK lý do 5–500 ký tự, mẫu `rule_type`/`code`; trigger không sửa phiên bản đã ghi; RLS theo tenant | INTERNAL | vĩnh viễn |
| `audit_event` (sửa) | + seq, impersonator_id, on_behalf_of_id, request_id, outcome, classification, ip_hash, schema_version | UNIQUE (tenant, seq); index (tenant, resource_type, resource_id, occurred_at); append-only | INTERNAL/CONFIDENTIAL | 10 năm [CXN-RET-03] |
| `audit_seal` (mới) | from_seq, to_seq, merkle_root, prev_seal_hash, seal_hash | UNIQUE (tenant, to_seq) | INTERNAL | như audit |
| `outbox_event` (sửa) | + aggregate_type/version, event_key, correlation_id, causation_id, status, attempts, next_attempt_at, last_error | UNIQUE (tenant, event_key); partial index PENDING | INTERNAL | 30 ngày sau publish |
| `idempotency_record` (sửa) | + http_status, resource_type/id, locked_until, created_at, completed_at | UNIQUE có sẵn; CHECK 72 giờ ≤ TTL ≤ 7 ngày | INTERNAL | theo expires_at |

## 7. API / command

| operationId | Method path | x-permission | Request DTO | Lỗi chính | If-Match |
|---|---|---|---|---|---|
| createOrganizationUnit | POST /org-units | iam.unit.manage | OrgUnitCreate | 409 UNIT_CODE_TAKEN; 422 UNIT_PARENT_INVALID, UNIT_DEPTH_EXCEEDED, UNIT_VALIDITY_INVALID | không |
| updateOrganizationUnit | PUT /org-units/{unitId} | iam.unit.manage | OrgUnitUpdate | 409 UNIT_CODE_TAKEN, VERSION_CONFLICT | có |
| moveOrganizationUnit | POST /org-units/{unitId}/move | iam.unit.manage | OrgUnitMove | 422 UNIT_CYCLE, UNIT_DEPTH_EXCEEDED | có |
| proposeUnitReorganization | POST /unit-reorganizations | iam.unit.reorganize | UnitReorganizationCreate | 422 REORG_MAPPING_INCOMPLETE | không |
| decideUnitReorganization | POST /unit-reorganizations/{reorgId}/decision | iam.unit.reorganize.approve | Decision | 403 SELF_APPROVAL_DENIED; 409 REORG_STATE_INVALID | có |
| inviteMember / inviteGuestContractor | POST /memberships/invitations, /guest-memberships | iam.member.invite / iam.guest.invite | MemberInvite / GuestInvite | 403 QUOTA_EXCEEDED, ROLE_ESCALATION_DENIED; 422 GUEST_SCOPE_INVALID, CONTRACT_NOT_ACTIVE | không |
| suspend/reactivate/endMembership | POST /memberships/{id}/suspend\|reactivate\|end | iam.member.manage | ReasonOnly | 403 SELF_ACTION_DENIED; 409 LAST_TENANT_OWNER, MEMBERSHIP_STATE_INVALID | có |
| createCustomRole / updateCustomRole | POST /roles, PUT /roles/{roleId} | iam.role.manage | RoleCreate / RoleUpdate | 403 ROLE_ESCALATION_DENIED; 422 SYSTEM_PERMISSION_NOT_GRANTABLE; 409 SYSTEM_ROLE_IMMUTABLE | PUT có |
| grantRole / revokeRoleGrant | POST /role-grants, /role-grants/{grantId}/revoke | iam.role.grant (aal2) | RoleGrantCreate / ReasonOnly | 403 ROLE_ESCALATION_DENIED, SELF_GRANT_DENIED, SCOPE_OUT_OF_GRANTOR_RANGE | revoke có |
| get_resources_role_definition (_id) | GET /resources/role_definition, /resources/role_definition/{id} | role_grant.read | RoleDefinitionView (đọc) | 404 RESOURCE_NOT_FOUND ngoài scope (CR-ADM-05) | không |
| get_resources_signing_certificate (_id) | GET /resources/signing_certificate, /resources/signing_certificate/{id} | adm.signature.read | SigningCertificateView (đọc; chỉ dữ kiện công khai) | 404 RESOURCE_NOT_FOUND | không |
| get_resources_security_policy_version (_id) | GET /resources/security_policy_version, /resources/security_policy_version/{id} | adm.security.read | SecurityPolicyView (đọc) | 404 RESOURCE_NOT_FOUND | không |
| createDelegation / revokeDelegation | POST /delegations, /delegations/{id}/revoke | iam.delegation.create | DelegationCreate / ReasonOnly | 422 DELEGATION_INVALID; 403 DELEGATION_CHAIN_DENIED | revoke có |
| createDoaMatrixDraft / updateDoaMatrixDraft / submitDoaMatrix / decideDoaMatrix | /doa-matrices… | adm.doa.manage / adm.doa.approve | DoaMatrixDraft / ReasonOnly / Decision | 422 DOA_MATRIX_INVALID; 403 SELF_APPROVAL_DENIED; 409 DOA_MATRIX_NOT_DRAFT | trừ create |
| createWorkflowDraft / updateWorkflowDraft / publishWorkflowVersion | /workflow-definitions… | adm.workflow.manage / adm.workflow.publish | WorkflowDraft / ReasonOnly | 422 WORKFLOW_DEFINITION_INVALID; 403 SELF_APPROVAL_DENIED | trừ create |
| cancelWorkflowInstance | POST /workflow-instances/{instanceId}/cancel | adm.workflow.operate | ReasonOnly | 409 WORKFLOW_STATE_INVALID | có |
| decideApprovalTask | POST /approval-tasks/{taskId}/decision | approval.decide (aal2) | ApprovalDecision | 403 SELF_APPROVAL_DENIED, APPROVER_NOT_AUTHORIZED, MFA_REQUIRED; 409 TASK_ALREADY_DECIDED | có |
| reassignApprovalTask | POST /approval-tasks/{taskId}/reassign | adm.workflow.operate | TaskReassign | 403 APPROVER_NOT_AUTHORIZED | có |
| createWorkCalendarVersion / publishWorkCalendar | /work-calendars… | adm.calendar.manage | WorkCalendarDraft / ReasonOnly | 422 CALENDAR_INVALID | publish có |
| registerSigningCertificate / revokeSigningCertificate | /signing-certificates… | adm.signature.manage | SigningCertificateRegister / ReasonOnly | 422 CERTIFICATE_INVALID, CERTIFICATE_EXPIRED; 409 CERTIFICATE_DUPLICATE | revoke có |
| createIntegrationConnector / updateIntegrationConnector | /integration-connectors… | adm.integration.manage | ConnectorCreate / ConnectorUpdate | 422 CONNECTOR_NOT_ACTIVATABLE | PUT có |
| replayInboxEvent | POST /integration-inbox/{inboxEventId}/replay | adm.integration.operate | ReasonOnly | 409 INBOX_STATE_INVALID | có |
| exportAuditLog | POST /audit-exports | audit.export | AuditExportRequest | 422 EXPORT_RANGE_TOO_LARGE | không |
| createRetentionPolicyVersion / publishRetentionPolicy | /retention-policies… | adm.retention.manage / adm.retention.approve | RetentionPolicyDraft / ReasonOnly | 422 RETENTION_POLICY_INVALID; 403 SELF_APPROVAL_DENIED | publish có |
| placeLegalHold / releaseLegalHold | /legal-holds… | legal_hold.manage | LegalHoldCreate / ReasonOnly | 403 SELF_APPROVAL_DENIED; 409 LEGAL_HOLD_STATE_INVALID | release có |
| register/dryRun/apply/rollbackMigrationBatch | /migration-batches… | adm.migration.manage / adm.migration.approve | MigrationBatchRegister / ReasonOnly | 409 MIGRATION_FILE_ALREADY_REGISTERED, MIGRATION_STATE_INVALID, MIGRATION_DEPENDENTS_EXIST; 403 SELF_APPROVAL_DENIED | trừ register |
| createSecurityPolicyVersion / publishSecurityPolicy | /security-policies… | adm.security.manage / adm.security.approve | SecurityPolicyDraft / ReasonOnly | 422 POLICY_INVALID; 403 SELF_APPROVAL_DENIED | publish có |
| createGovernanceRuleDraft | POST /governance-rules | adm.governance.manage | GovernanceRuleDraft | 422 GOVERNANCE_RULE_PARAMS_INVALID, VALIDATION_FAILED | không |
| submitGovernanceRule / withdrawGovernanceRule | POST /governance-rules/{ruleId}/submit \| withdraw | adm.governance.manage | GovernanceRuleReason | 409 GOVERNANCE_RULE_STATE_INVALID, VERSION_CONFLICT | có |
| approveGovernanceRule | POST /governance-rules/{ruleId}/approve | adm.governance.approve | GovernanceRuleReason | 403 SELF_APPROVAL_DENIED; 409 GOVERNANCE_RULE_STATE_INVALID, GOVERNANCE_RULE_PERIOD_OVERLAP | có |
| retireGovernanceRule | POST /governance-rules/{ruleId}/retire | adm.governance.manage (+ adm.governance.approve nếu đã duyệt) | GovernanceRuleRetire | 409 GOVERNANCE_RULE_STATE_INVALID | có |
| listGovernanceRules / listGovernanceRuleVersions / getGovernanceRule / getGovernanceRuleDiff | GET /governance-rules… | adm.governance.read | — | 404 RESOURCE_NOT_FOUND | — |
| getGovernanceRuleCatalog / getEffectiveGovernanceRule | GET /governance-rules/catalog \| effective | adm.governance.read | — | 404 GOVERNANCE_RULE_NOT_FOUND | — |
| listAlertTypes / getAlertType | GET /alert-types[/{code}] | adm.governance.read | — | 404 GOVERNANCE_RULE_NOT_FOUND | — |

Mọi lệnh có Idempotency-Key (BR-PLT-02). Rà soát GET scaffold: `workflow_version` **giữ** (nháp chỉ cho `adm.workflow.manage`), `workflow_instance` **DTO riêng** (resource_ref chỉ khi đọc được tài nguyên đích), `approval_task` **DTO riêng** (task của mình/được ủy hoặc `adm.workflow.operate`), `audit_event` **DTO riêng** (safe_diff đã redact), `legal_hold` **DTO riêng** (che authority_reference mật), `outbox_event` **không expose**, `role_grant`/`membership`/`organization_unit` theo IAM §7. Không có endpoint ghi chung đổi status/tenant/role.

## 8. UI/UX

| Màn hình | Field thêm / mới | Quy tắc hiển thị |
|---|---|---|
| ADM-01 | Loại đơn vị, Mã ĐVHC, Là chủ đầu tư, Căn cứ pháp lý, Trạng thái | cây có lọc "xem tại ngày"; đơn vị Superseded mờ + liên kết kế thừa |
| ADM-02 | Loại thành viên, Lời mời, Hiệu lực đến | nút thao tác ẩn với người rank ≥ mình; quota ghế hiển thị "đã dùng/giới hạn" |
| ADM-03 | Mã vai trò, Hạng (rank), Cho khách, Loại scope, Người cấp, Lý do | bộ chọn vai trò chỉ liệt kê vai trò người dùng được cấp (rank thấp hơn); quyền `system.*` không xuất hiện |
| ADM-04 | Quyền ủy, Lý do, Căn cứ, Trạng thái | thanh thời gian ≤ 90 ngày |
| ADM-06 | Loại nghiệp vụ, Quy tắc người duyệt, Số người duyệt, Trả lại về bước, Phiên bản | trình dựng bước (workflow component doc 06); diff giữa phiên bản |
| ADM-07 | Năm, Ngày làm bù, Căn cứ, Phiên bản | lịch tháng |
| ADM-08 | Loại, Vân tay, Trạng thái | cảnh báo hết hạn 30 ngày |
| ADM-09/10 | Trạng thái adapter, Chế độ; Sự kiện inbox, Trạng thái xử lý, Phát lại | nhãn MOCK đỏ, PROPOSED vàng |
| ADM-11 | Kết quả, Người mạo danh/thay mặt, Seal hash | dải cảnh báo nếu seal lỗi |
| ADM-12 | Lớp hồ sơ, Căn cứ, Hành động khi hết hạn, Legal hold đang hiệu lực | |
| ADM-13 | SHA-256, Dry-run, Tổng kiểm soát, Người duyệt | bảng lỗi theo dòng, tải CSV lỗi |
| ADM-14 | Vai trò bắt buộc MFA, Thời hạn phiên, TTL tải xuống, Watermark | |
| ADM-15 (mới) | Loại hồ sơ, Đơn vị áp dụng, Gồm đơn vị con, Từ/Đến (VND), Vai trò duyệt, Số cấp, Hiệu lực, Căn cứ | bảng policy; biểu đồ dải tiền phát hiện khe hở/chồng lấn trước khi gửi; số tiền định dạng VND nguyên |
| ADM-16 (mới) | Loại, Đơn vị cũ, Đơn vị kế thừa, Ngày hiệu lực, Căn cứ, Ánh xạ thành viên/dự án, Kết quả áp dụng | wizard 4 bước (chọn → ánh xạ → xem trước tác động → trình duyệt); tiến trình saga dạng timeline |
| ADM-17 (mới) | Nhà thầu, Email, Hợp đồng, Vai trò khách, Hiệu lực đến, Trạng thái | danh sách; hợp đồng chọn từ CTR theo nhà thầu |
| ADM-18 (mới) | Hồ sơ, Loại, Số tiền, Bước hiện tại, Người xử lý, Hạn SLA, Phiên bản quy trình, Trạng thái | bảng; quá hạn đỏ; hành động hủy/chuyển người xử lý |
| ADM-19 (mới) | Loại quy tắc, Đơn vị sở hữu, Số mã, Mã dùng quy tắc riêng, Mã dùng mặc định, Trạng thái kiểm chứng, Căn cứ, Ngày lấy số | bảng; nhãn "chưa kiểm chứng" bằng chữ kèm biểu tượng; lọc theo đơn vị sở hữu; loại không còn đăng ký được đánh dấu |
| ADM-20 (mới) | Mã, Quy tắc đang áp dụng, Mặc định có sẵn, Công thức và căn cứ, Lịch sử phiên bản, Trạng thái và hiệu lực, Người lập/trình/duyệt, Lý do | quy tắc đang áp dụng cạnh mặc định, hàng khác mặc định ghi chữ; dòng thời gian thao tác; nút Duyệt tắt kèm giải thích cho người lập/trình; hộp xác nhận nêu đối tượng, phiên bản, hiệu lực, lý do |
| ADM-21 (mới) | Loại và mã, Đơn vị áp dụng, Tham số theo lược đồ, Đơn vị tính, Hiệu lực từ/đến, Cảnh báo chồng hiệu lực, Lý do | biểu mẫu sinh từ lược đồ; lỗi từng trường + tóm tắt; cảnh báo chồng hiệu lực/quá khứ trước khi lưu; khóa sau khi lưu |
| ADM-22 (mới) | Phiên bản gốc, Phiên bản so sánh, Tham số thêm/bỏ/đổi, Trước, Sau | bảng; thêm/bỏ/đổi bằng chữ và biểu tượng (＋ － ≠) |
| ADM-23 (mới) | Mã loại, Nguồn, Chủ sở hữu, Hành động mong đợi, Hậu quả, Thời hạn đáp ứng, Mức mặc định, Lý do tồn tại, Ngày xét lại, Quy tắc áp dụng | bảng có lọc nguồn/chủ sở hữu; "chỉ ở mức Theo dõi" khi không có hành động mong đợi; "quá hạn xét lại"/"sắp đến hạn" bằng chữ kèm biểu tượng |

7 trạng thái chuẩn cho mọi màn hình; trạng thái riêng: `pending-approval` (cấu hình chờ duyệt — khóa sửa), `applying` (saga đang chạy — chỉ đọc). Chỉ web; MOB-23..25 dùng `decideApprovalTask`.

## 9. Sự kiện, job, tích hợp, quan sát

- Event: `iam.org_unit.created|updated|moved|reorganization_approved|reorganization_applied.v1`; `adm.doa_matrix.published.v1 {matrix_id, revision, effective_from}`; `adm.workflow_version.published.v1`; `adm.workflow_instance.started|completed|cancelled.v1 {instance_id, resource_type, resource_id, outcome}`; `adm.approval_task.created|decided|reassigned.v1 {task_id, assignee, due_at, decision}`; `adm.work_calendar.published.v1`; `adm.signing_certificate.registered|revoked.v1`; `adm.retention_policy.published.v1`; `platform.legal_hold.placed|released.v1`; `adm.migration_batch.applied.v1`; `adm.security_policy.published.v1`.
- Event của kho quy tắc: `adm.governance_rule.approved.v1 {rule_id, rule_type, code, version, unit_id, effective_from, effective_to, superseded_id}` và `adm.governance_rule.retired.v1 {rule_id, rule_type, code, version, unit_id, effective_to}` (khóa `governance_rule:{id}:approved|retired:{row_version}`); audit `governance_rule.drafted|submitted|withdrawn|approved|retired`.
- Temporal workflow: `ApprovalWorkflow` (task queue `approvals`, id `appr:{tenant}:{instance}`; signals TaskDecided/Cancel; timers SLA; định nghĩa ghim theo `workflow_version_id`, thay đổi code dùng `workflow.patched` — R9), `UnitReorganizationWorkflow`, `MigrationApplyWorkflow`, `KeycloakPolicySyncWorkflow`. Temporal namespace theo môi trường, tenant trong search attribute `TenantId`; payload mã hóa (codec) không chứa PII.
- Job: seal audit 5 phút; verify seal hằng giờ; retention hằng ngày 01:00; hết hạn delegation/grant mỗi phút; cảnh báo chứng thư hằng ngày; dọn idempotency_record hết hạn mỗi giờ.
- Cache: `doa:{tenant}:{matrix_version}` (bất biến); `wf:{tenant}:{business_type}` xóa khi publish.
- Telemetry: `approval_task_open_total{business_type}`, `approval_sla_breach_total`, `workflow_guard_rejected_total`, `audit_seal_failures_total`, `outbox_oldest_pending_seconds`, `idempotency_conflict_total{operation}`; cảnh báo: guard_rejected > 0, seal failure > 0, outbox oldest > 300 s.

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Setup | Input/Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC110 | domain | P0 | cây 3 cấp | move tạo vòng; cấp 9; mã trùng | 422 UNIT_CYCLE; 422 UNIT_DEPTH_EXCEEDED; 409 | API log |
| UAT-AC111 | E2E | P0 | A-SKHDT 3 thành viên/5 grant/4 dự án | đề xuất → tự duyệt → owner duyệt | 403; Applied; grant mới + cũ Expired; tên lịch sử giữ | DB + báo cáo |
| UAT-AC112 | domain | P0 | huyện 6 dự án | mapping 5/6; đủ 6 | 422 REORG_MAPPING_INCOMPLETE; Draft | API log |
| UAT-AC113 | security | P0 | UNIT_ADMIN | khóa mình; LEADER khóa; khóa maker | 403; 403; phiên chết ≤60s | audit |
| UAT-AC114 | integration | P1 | seats 3 | mời người 4; mời khách | 403 QUOTA_EXCEEDED; 201 | API log |
| UAT-AC116 | security | P0 | ủy quyền 7 ngày | duyệt thay; ủy tiếp; 91 ngày | 200 on_behalf_of; 403; 422 | audit |
| UAT-AC117 | security | P0 | người được ủy là maker | duyệt | 403 SELF_APPROVAL_DENIED | audit |
| UAT-AC118 | domain | P1 | 1 owner | kết thúc owner | 403/409 LAST_TENANT_OWNER | API log |
| UAT-AC126 | domain | P0 | DoA 3 dải | 4.999.999.999 / 5e9 / 25e9 | đúng vai trò, 2 cấp distinct | DB |
| UAT-AC127 | domain | P0 | DoA nháp | khe hở; chồng; tự duyệt; owner duyệt | 422 GAP; 422 OVERLAP; 403; Published | DB |
| UAT-AC128 | domain | P1 | thiếu quy tắc | khởi tạo | 422 DOA_RULE_NOT_FOUND | API log |
| UAT-AC129 | security | P0 | maker là người duyệt | duyệt | 403; giao lại người khác | audit |
| UAT-AC130 | integration | P0 | task 2 người | quyết định đồng thời | 1×200, 1×409; 1 signal | Temporal history |
| UAT-AC131 | integration | P0 | task Pending | cùng key/khác body/đang xử lý | replay; 409 IDEMPOTENCY_CONFLICT; 409 IN_PROGRESS | DB idempotency_record |
| UAT-AC132 | integration | P0 | v3 đang chạy | công bố v4 | I-1 theo v3, I-2 theo v4 | Temporal history |
| UAT-AC133 | integration | P1 | hồ sơ đã rút | duyệt bước cuối | GUARD_REJECTED, hồ sơ không đổi | cảnh báo |
| UAT-AC134 | domain | P0 | lịch VN-STD 2026 | task 29/4 15:00, 8h | due 04/5 15:00 +07 | unit test + DB |
| UAT-AC135 | domain | P1 | lịch 2027 | ngày ngoài năm | 422 CALENDAR_INVALID | API log |
| UAT-AC136 | security | P1 | PEM | hết hạn; có khóa riêng; trùng | 422; 422 không lưu; 409 | log scan |
| UAT-AC137 | domain | P1 | connector PROPOSED | Active | 422 CONNECTOR_NOT_ACTIVATABLE | API log |
| UAT-AC138 | integration | P1 | inbox FAILED | replay 2 lần | PROCESSED; 409 | DB |
| UAT-AC139 | security | P0 | 1.000 audit | UPDATE; sửa bằng owner; verify | denied; phát hiện seal lệch | cảnh báo |
| UAT-AC140 | security | P1 | khách | grantRole | 403 + audit DENIED tồn tại | DB |
| UAT-AC141 | integration | P0 | hold trên P-01 | retention; tự giải tỏa; người khác | bỏ qua; 403; Released | job log |
| UAT-AC142 | domain | P1 | lớp nghiệp vụ | AUTO_PURGE; PERMANENT+10 năm | 422 ×2 | API log |
| UAT-AC143 | E2E | P0 | tệp 120 dòng 2 lỗi | đăng ký lại; dry-run; apply sai người; apply đúng | 409; lỗi dòng 17/42; 403; Applied tổng khớp | báo cáo dry-run |
| UAT-AC144 | integration | P1 | policy v2 | tự công bố; owner công bố | 403; MFA bắt buộc với LEADER | Keycloak |
| UI-ADM-15..18 | screen-contract | P0 | route mới | 7 trạng thái | đúng trường, denied khi thiếu quyền | ảnh chụp |
| UAT-G0-01 | domain | P0 | bản nháp do A lập, A trình | A duyệt; B (khác) duyệt | 403 SELF_APPROVAL_DENIED; Approved, phiên bản cũ kết thúc đúng ngày bắt đầu | audit + DB |
| UAT-G0-02 | domain | P0 | phiên bản đang hiệu lực | ngừng bằng người chỉ có quyền soạn; bằng người có cả hai quyền | 403; Retired, mặc định hoặc bản trước áp dụng lại | audit |
| UAT-G0-03 | domain | P1 | hai phiên bản chồng hiệu lực không kế nhiệm | duyệt | 409 GOVERNANCE_RULE_PERIOD_OVERLAP; biểu mẫu đã cảnh báo trước | API log |
| UAT-G0-04 | domain | P1 | lược đồ có khoảng và tiền | gửi giá trị ngoài khoảng, sai kiểu | 422 GOVERNANCE_RULE_PARAMS_INVALID nêu trường; biểu mẫu báo ngay cạnh trường | ảnh chụp |
| UAT-G0-05 | domain | P0 | loại cảnh báo không có hành động mong đợi | mức ACTION; mức WATCH | 422 trường default_severity; chấp nhận | API log |
| UAT-G0-06 | screen-contract | P0 | mặc định chưa kiểm chứng | mở ADM-19, ADM-20, ADM-23 | chữ "chưa kiểm chứng" ở mọi nơi hiện con số; loại quá ngày xét lại được đánh dấu | ảnh chụp |
| UI-ADM-19..23 | screen-contract | P0 | route mới | 7 trạng thái; không đủ quyền | đúng trường, denied khi thiếu quyền, lỗi đọc không hiện thành "không có quy tắc" | ảnh chụp |

## 11. Tiêu chí nghiệm thu (đo được)

- AC-ADM-01: Given DoA Published, When gửi hồ sơ với số tiền ở biên dải, Then người duyệt đúng dải `[min,max)` và instance ghim phiên bản DoA (UAT-AC126).
- AC-ADM-02: Given bản nháp DoA có khe hở/chồng lấn, When trình, Then 422 kèm vị trí; người lập không tự công bố được (UAT-AC127).
- AC-ADM-03: Given người lập hồ sơ là người duyệt tiềm năng hoặc người được ủy quyền, When quyết định, Then 403 SELF_APPROVAL_DENIED (UAT-AC129, UAT-AC117).
- AC-ADM-04: Given hai quyết định đồng thời/trùng key, Then đúng một hiệu lực, một audit, một signal (UAT-AC130, UAT-AC131, TX02).
- AC-ADM-05: Given công bố phiên bản quy trình mới, Then instance đang chạy không đổi bước (UAT-AC132).
- AC-ADM-06: Given hồ sơ bị rút, When workflow kết thúc, Then không có chuyển trạng thái ngoài transition table (UAT-AC133).
- AC-ADM-07: Given lịch có ngày nghỉ, Then hạn SLA tính theo giờ làm việc đúng ví dụ chuẩn (UAT-AC134).
- AC-ADM-08: Given sáp nhập/chia tách 2025, Then 100% thành viên/grant/dự án của đơn vị cũ chuyển sang đơn vị kế thừa và báo cáo lịch sử giữ tên cũ (UAT-AC111, UAT-AC112).
- AC-ADM-09: Given legal hold Active, Then không job nào xóa/purge tài nguyên trong scope (UAT-AC141, UAT-AC39).
- AC-ADM-10: Given audit bị sửa ngoài ứng dụng, Then verify seal phát hiện trong ≤ 1 giờ (UAT-AC139).
- AC-ADM-11: Given tệp chuyển đổi đã đăng ký, Then không nhập lại; dry-run không ghi dữ liệu; tổng kiểm soát khớp (UAT-AC143).
- AC-ADM-12: Given phiên bản quy tắc do A lập hoặc trình, When A duyệt, Then 403 SELF_APPROVAL_DENIED và màn hình đã tắt nút kèm giải thích; người thứ ba duyệt được và phiên bản cũ kết thúc đúng ngày phiên bản mới bắt đầu (UAT-G0-01).
- AC-ADM-13: Given quy tắc chưa kiểm chứng, Then mọi màn hình hiện con số của nó ghi "chưa kiểm chứng" bằng chữ và biểu tượng, và mỗi con số có công thức, căn cứ, ngày lấy số (UAT-G0-06).
- AC-ADM-14: Given loại cảnh báo không có hành động mong đợi, Then chỉ được mức Theo dõi; loại quá ngày xét lại được đánh dấu và đếm trên sổ (UAT-G0-05, UAT-G0-06).

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

- **R0 (nền tảng):** audit + seal, outbox + relay role, idempotency (BR-PLT-01..03), legal hold service, cây đơn vị + thành viên + vai trò + grant (ADM-01/02/03/17), security policy tối thiểu (MFA vai trò).
- **R1 (dùng thật):** DoA (ADM-15) + ApprovalWorkflow trên Temporal cho các business_type: report.accept, plan.publish, payment.approve, contract.change, period.reopen; ADM-04, ADM-06, ADM-07, ADM-11, ADM-12, ADM-16 (tỉnh pilot cần ngay do sắp xếp 2025), ADM-18.
- **R2:** ADM-13 chuyển đổi dữ liệu theo lô lớn (R1 chỉ nhập danh mục qua MDM), ADM-08 tích hợp kiểm tra OCSP/CRL, ADM-09/10 connector LGSP, access review định kỳ.
- **Giờ review người (R2-D5):** 24 giờ — **quyền** (BR-ADM-01/02/06), **tiền** (BR-ADM-03/04: DoA và biên số tiền), **migration** (backfill workflow_instance/approval_task cũ, saga tổ chức lại), **mẫu pháp lý** (lịch nghỉ, chính sách lưu trữ).

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| XM-ADM-01 Trạng thái kỳ Open/SoftClosed/Locked + mở khóa có lý do thuộc nhóm capital (`reporting_period`, `period_reopen`) | Tech Lead capital + ADM | Capital gọi `ApprovalService.start(business_type="period.reopen")` và dùng `addWorkingTime` của ADM; không nhân bản bảng kỳ ở ADM |
| XM-ADM-02 PRJ cung cấp `requestProjectTransfer` với cờ hệ thống cho saga tổ chức lại | Tech Lead capital | Command PRJ chấp nhận actor service account + `reorganization_id` |
| [CXN-DOA-01] Ngưỡng thẩm quyền phê duyệt theo quy chế nội bộ tỉnh pilot | Chủ nghiệp vụ vốn | Quy chế được ký, nhập vào DoA v1 |
| [CXN-RET-02]/[CXN-RET-03] Thời hạn lưu trữ hồ sơ dự án, audit theo TT 10/2022, TT 08/2025, Luật Lưu trữ 2024 | Pháp chế + Văn thư | Bảng thời hạn được duyệt → `data_retention_policy` v1 |
| [CXN-CAL-01] Lịch nghỉ lễ 2026–2027 và ngày làm bù | Văn phòng UBND | Thông báo chính thức → lịch VN-STD |
| [CXN-DOC-01] Thể thức "TUQ." khi ký theo ủy quyền trong văn bản sinh tự động | Văn thư + DOC | DOC xác nhận mapping `on_behalf_of` → tiền tố |
| Temporal là thành phần tự host mới (R1) | Tech Lead hạ tầng | Runbook + backup/restore namespace đã thử + cảnh báo trước khi slice phê duyệt đầu tiên DONE |
| Rủi ro cấu hình DoA sai làm tắc hồ sơ | Chủ nghiệp vụ | HOME cảnh báo `DOA_RULE_NOT_FOUND`; chế độ xem trước "hồ sơ X sẽ do ai duyệt" trên ADM-15 |

## 14. Vắng mặt, người thay và độ phủ người nhận cảnh báo (làn GOV-9a, G2-7)

**ADM-25 Vắng mặt, người thay và độ phủ người nhận cảnh báo** (`listAlertAbsences`, `declareAlertAbsence`, `endAlertAbsence`, `proposeAlertCover`, `decideAlertCover`, `revokeAlertCover`, `getAlertCoverageReport`): người vắng khai khoảng vắng (nghỉ phép, ốm, công tác, đào tạo, khác; không quá `max_absence_days`); người thay nhận cảnh báo của người vắng theo mọi nguồn hoặc theo một số nguồn, không quá `max_cover_days` (mặc định 90 ngày như ủy quyền thẩm quyền), nằm trong khoảng vắng, hạng không thấp hơn người vắng, không tự thay mình, không vòng (A thay B trong khi B thay A), không sâu quá `max_chain_depth`. **Người cho phép là người thứ ba**: không phải người đề nghị, người vắng hay người thay (403 `SELF_APPROVAL_DENIED`); người đề nghị là người vắng hoặc người quản lý trong phạm vi `home.alert.cover.manage`. Đề nghị chưa được cho phép thì chưa phải là người thay. **Người thay chỉ nhận cảnh báo, không nhận thẩm quyền**: việc phê duyệt vẫn cần ủy quyền ADM-14; người thay thấy việc của người vắng trong phạm vi đọc của chính mình, nhận xử lý, hoãn, giao lại như việc của mình (cờ `on_behalf_of`).

Người vắng không có người thay cho mọi nguồn quá `uncovered_after_working_hours` (mặc định 8 giờ làm việc) là khoảng trống `ABSENT_NO_COVER`; cảnh báo của họ leo ngay lên lãnh đạo (`ORPHANED`) và vào chỉ số mồ côi; khoảng vắng sắp bắt đầu mà chưa có đề nghị là `ABSENCE_STARTING_UNCOVERED`; chủ việc đã nghỉ mà còn việc mở là `OWNER_INACTIVE` (việc leo lên lãnh đạo nơi họ làm); chức danh lãnh đạo không ai có mặt và chưa có người thay là `POSITION_UNCOVERED`. Báo cáo độ phủ: mỗi chức danh (vai trò trong đơn vị, từ hạng `position_min_rank`) là PEER_BACKED, COVERED, SINGLE_POINT hoặc UNCOVERED; chỉ số độ phủ không lấy 100 phần trăm của không có chức danh nào. Mọi thay đổi ghi nhật ký ADM-11 và có sự kiện `home.alert_absence_declared.v1`, `home.alert_cover_proposed.v1`, `home.alert_cover_decided.v1`, `home.alert_cover_revoked.v1`, `home.alert_absence_ended.v1`. Lỗi: `ALERT_ABSENCE_INVALID`, `ALERT_ABSENCE_OVERLAP`, `ALERT_ABSENCE_STATE_INVALID`, `ALERT_COVER_INVALID`, `ALERT_COVER_STATE_INVALID`.
