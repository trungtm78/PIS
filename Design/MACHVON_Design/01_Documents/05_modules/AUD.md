# AUD — Thanh tra, kiểm toán và theo dõi thực hiện kiến nghị

Phiên bản đặc tả M1 · 22/10/2026 · Phân hệ **mới** (D-B09). Nguồn dữ liệu máy: `work/staging/intelligence.json` (bảng `audit_engagement`, `audit_scope_item`, `audit_conclusion`, `audit_finding`, `audit_recommendation`, `audit_remediation_action`, `audit_recovery_link`, `audit_evidence`, `audit_follow_up_report`). Quy ước chung theo `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md`; văn bản đi/đến qua DOC.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Dự án đầu tư công thường xuyên là đối tượng của thanh tra (Thanh tra Chính phủ, thanh tra tỉnh, thanh tra bộ/ngành), Kiểm toán nhà nước và kiểm tra nội bộ. Kết luận và báo cáo kiểm toán sinh ra hàng chục kiến nghị: thu hồi nộp ngân sách, giảm trừ thanh toán/quyết toán, chấn chỉnh quy trình, xem xét trách nhiệm. Hiện việc theo dõi nằm trong bảng tính rời, không nối với số tiền đã thu hồi thực tế ở thanh toán, không có owner và hạn rõ ràng, nên báo cáo kết quả thực hiện gửi cơ quan tiến hành thường chậm và sai số liệu. AUD quản lý **cuộc → kết luận → phát hiện → kiến nghị → hành động khắc phục → bằng chứng → thu hồi tài chính → báo cáo kết quả**, với số tiền thu hồi nối sổ PAY và legal hold trên phạm vi cuộc.

**Trong phạm vi:** ghi nhận cuộc thanh tra/kiểm toán/kiểm tra và phạm vi (đơn vị, dự án, hợp đồng); đặt/nhả legal hold qua ADM; ghi kết luận (có revision sửa đổi) là văn bản đến của DOC; phát hiện; kiến nghị tài chính (số tiền, lũy kế thu hồi nối với khoản thu hồi/giảm trừ của PAY) và phi tài chính (quy trình, trách nhiệm, chuyển cơ quan khác, chính sách); phân công owner, hạn, nhắc và leo thang; giải trình/đề nghị xem xét lại; xác minh hoàn thành bởi người khác; báo cáo kết quả thực hiện phát hành qua DOC; tổng hợp toàn tenant.

**Ngoài phạm vi:** tiến hành thanh tra/kiểm toán (đó là việc của cơ quan bên ngoài; AUD là phía đơn vị được thanh tra/kiểm toán); thu hồi tiền (PAY ghi chứng từ, giảm trừ và nộp NSNN — AUD chỉ liên kết); xử lý kỷ luật cán bộ (ngoài hệ thống, chỉ lưu văn bản); đánh giá sau đầu tư (MNE `mne_evaluation`); xử lý vướng mắc chung (ISS — AUD có thể tạo vướng mắc liên kết).

**Phụ thuộc:** DOC (quyết định, kết luận, bằng chứng, báo cáo — `document` EFFECTIVE), PRJ (dự án), CTR (hợp đồng), PAY (sự kiện thu hồi/giảm trừ), ISS (vướng mắc cho kiến nghị quy trình), ADM (legal hold, cây đơn vị, lịch làm việc), NOT (nhắc hạn). Theo đồ thị L5: `AUD → PAY, CTR, ISS, PRJ, DOC`.

**Căn cứ.** Luật Thanh tra 84/2025/QH15 (thực hiện, theo dõi, đôn đốc kết luận thanh tra; công khai kết luận) [CXN-AUD-01, CXN-AUD-03]; Luật Kiểm toán nhà nước 81/2015/QH13 (sửa 55/2019/QH14) về trách nhiệm thực hiện và báo cáo kết quả thực hiện kiến nghị kiểm toán [CXN-AUD-02]; Luật Đầu tư công 58/2024 về thanh tra, kiểm tra đầu tư công; Luật NSNN 89/2025 về thu hồi nộp ngân sách; Luật Lưu trữ 33/2024 (lưu hồ sơ). Hạn thực hiện và hạn báo cáo là **dữ liệu nhập từ kết luận**, không mã hóa cứng. Thị trường: AuditBoard, TeamMate+ (issue tracking với owner, due date, evidence, verification), Oracle Unifier (audit findings), ISO 19011 (theo dõi hành động khắc phục).

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Đầu mối thanh tra/kiểm toán (Văn phòng UBND, Sở TC, Ban QLDA) | Cây đơn vị được cấp | `createAuditEngagement`, `startAuditEngagement`, `endAuditFieldwork`, `cancelAuditEngagement`, `recordAuditConclusion`, `recordAuditFinding`, `createAuditRecommendation`, `requestAuditFollowUpReport` | Đóng kiến nghị (cần `aud.recommendation.verify`); ghi kiến nghị ngoài phạm vi cuộc |
| Lãnh đạo giao việc | Cây đơn vị | `assignAuditRecommendation` | Giao cho đơn vị ngoài scope (422) hoặc tenant khác (404) |
| Owner kiến nghị (đơn vị/người được giao) | Kiến nghị được giao | `planRemediationAction`, `completeRemediationAction`, `attachAuditEvidence`, `submitRecommendationForVerification`, `disputeAuditRecommendation` | Tự xác minh/đóng (`SELF_APPROVAL_DENIED`) |
| Người kiểm tra (verifier, thường Thanh tra sở/Phòng pháp chế) | Toàn tenant hoặc cây đơn vị | `verifyAuditRecommendation`, `recordAuditDisputeDecision` | Đóng kiến nghị chính mình báo hoàn thành |
| Kế toán | Dự án/hợp đồng trong scope | `linkAuditRecovery`, `reverseAuditRecovery` | Xóa/sửa dòng thu hồi (chỉ đảo) |
| Lãnh đạo tỉnh/bộ | Toàn tenant | `closeAuditEngagement`, xem AUD-01 | Sửa số liệu kiến nghị đã ghi |
| Auditor (vai trò hệ thống, chỉ đọc) | Scope được cấp | GET, xuất | Mọi command |
| System actor | Consumer | ghi/đảo khoản từ `pay.recovery.*`, đặt `is_overdue`, mở lại kiến nghị khi khoản thu hồi bị đảo | Chuyển trạng thái khác |

Dữ liệu AUD mặc định **CONFIDENTIAL**: chỉ người có grant AUD và scope giao với `audit_scope_item` mới thấy cuộc; người ngoài nhận 404. Nhà thầu (guest) không truy cập AUD.

## 3. Luồng nghiệp vụ

**F1 — Ghi nhận cuộc (AUD-02, AUD-03).** Tiền điều kiện: quyết định thanh tra/kiểm toán đã đăng ký ở DOC (văn bản đến hoặc REFERENCE, EFFECTIVE). (1) `createAuditEngagement` với loại, cơ quan tiến hành, thời kỳ, phạm vi (đơn vị/dự án/hợp đồng cùng tenant; khác tenant → 404) → PLANNED. (2) `startAuditEngagement` → ONGOING; nếu `place_legal_hold` thì gọi interface ADM `placeLegalHold` (hold_kind `INSPECTION` hoặc `AUDIT`, resource_scope = phạm vi cuộc) trong cùng saga Temporal; lưu `legal_hold_id`. Hồ sơ trong phạm vi không thể bị đề nghị hủy (DOC `LEGAL_HOLD_ACTIVE`). (3) `endAuditFieldwork` → AWAITING_CONCLUSION. Hủy (`cancelAuditEngagement`) chỉ khi chưa có kết luận; nhả legal hold. Đồng thời: hai người tạo cùng mã → unique `(tenant, engagement_code)`, người sau 409.

**F2 — Tiếp nhận kết luận (AUD-04, AUD-05, AUD-06).** (1) Văn thư nhận kết luận ở DOC (F10). (2) `recordAuditConclusion` gắn `conclusion_document_id`, ngày ban hành/nhận, hạn thực hiện và hạn báo cáo đọc từ kết luận, `total_financial_vnd` → cuộc FOLLOW_UP. Kết luận sửa đổi: revision mới `supersedes_id`, revision cũ SUPERSEDED; kiến nghị của revision cũ được giữ, đầu mối chuyển/hủy từng kiến nghị có lý do. (3) `recordAuditFinding` cho từng phát hiện; (4) `createAuditRecommendation`: kiến nghị tài chính bắt buộc `amount_vnd > 0`; Σ kiến nghị tài chính của một kết luận không được vượt `total_financial_vnd` (422 `FINANCIAL_TOTAL_MISMATCH`); nhỏ hơn thì UI cảnh báo phần lệch cho tới khi đầu mối xác nhận.

**F3 — Phân công và thực hiện (AUD-06, AUD-07, AUD-09).** `assignAuditRecommendation` (owner trong scope người giao; hạn ≤ hạn thực hiện của kết luận trừ khi có lý do và quyết định gia hạn) → ASSIGNED; tùy chọn tạo vướng mắc ISS cho kiến nghị quy trình (`linked_issue_id`). Owner `planRemediationAction` → IN_PROGRESS; `completeRemediationAction` bắt buộc bằng chứng là `document` EFFECTIVE hoặc tệp ATTACHMENT đã quét sạch. `submitRecommendationForVerification` khi mọi hành động DONE/CANCELLED và (với kiến nghị tài chính) đã thu hồi đủ → PENDING_VERIFICATION. Verifier (≠ người báo) `verifyAuditRecommendation` CLOSE (có văn bản căn cứ nếu cần) hoặc RETURN → IN_PROGRESS.

**F4 — Thu hồi tài chính và đối chiếu PAY (AUD-08).** Nguồn chính là sự kiện PAY `pay.recovery.recorded.v1 {recovery_id, audit_recommendation_id, amount_vnd, kind (RECOVERY|DEDUCTION), recorded_on}` khi kế toán ghi khoản thu hồi nộp NSNN hoặc giảm trừ thanh toán/quyết toán có tham chiếu kiến nghị. Consumer: khóa hàng `audit_recommendation FOR UPDATE`, kiểm `recovered_vnd + amount ≤ amount_vnd` (vượt → ghi exception "OVER_RECOVERY" cho kế toán xử lý, không ghi link), chèn `audit_recovery_link`, cập nhật `recovered_vnd`, trong một transaction. Nhập tay (`linkAuditRecovery`) cho khoản ngoài PAY (ví dụ nộp trực tiếp Kho bạc) bắt buộc chứng từ. Sửa sai bằng `reverseAuditRecovery` (dòng âm, `reversal_of_id`) hoặc sự kiện `pay.recovery.reversed.v1`; nếu kiến nghị đã CLOSED mà lũy kế giảm dưới số kiến nghị → tự mở lại IN_PROGRESS và cảnh báo. Đồng thời: hai kế toán ghi hai khoản cùng lúc → khóa hàng serial hóa, một khoản có thể bị 409 `RECOVERY_EXCEEDS_RECOMMENDATION` (UAT-AC439).

**F5 — Giải trình (AUD-06).** Owner `disputeAuditRecommendation` với văn bản giải trình → DISPUTED (hạn tạm dừng tính quá hạn). Ý kiến của cơ quan tiến hành ghi bằng `recordAuditDisputeDecision` kèm văn bản: chấp nhận → kiến nghị được đóng theo phần đã thu hồi (CHECK `fin_close_chk` cho phép); bác → IN_PROGRESS và tiếp tục tính hạn cũ.

**F6 — Báo cáo kết quả thực hiện (AUD-10).** `requestAuditFollowUpReport(as_of_date)`: tổng hợp số kiến nghị theo trạng thái, tiền kiến nghị/đã thu hồi/còn lại (số liệu tại as-of, không đổi sau đó), chuẩn hóa payload, băm, gọi `DocumentIssuePort` với mẫu `AUD-BC-KET-QUA-THUC-HIEN-KIEN-NGHI` → ISSUE_REQUESTED; `doc.issued.v1` khớp `source_ref`/băm → ISSUED; `doc.rejected.v1` → REJECTED (lập revision mới). Hạn báo cáo lấy từ `report_due_on`.

**F7 — Đóng cuộc.** `closeAuditEngagement` khi mọi kiến nghị CLOSED/CANCELLED và có ít nhất một báo cáo ISSUED sau lần đóng kiến nghị cuối; nhả legal hold (trừ khi hold khác còn hiệu lực); → CLOSED.

## 4. State machine

```
audit_engagement:  PLANNED ─start─► ONGOING ─fieldwork-end─► AWAITING_CONCLUSION ─conclusion─► FOLLOW_UP ─close─► CLOSED
                      └──────────── cancel (chưa có kết luận) ──────────────┘──► CANCELLED
audit_recommendation: OPEN ─assign─► ASSIGNED ─plan action─► IN_PROGRESS ─submit─► PENDING_VERIFICATION ─verify CLOSE─► CLOSED
                                                   ▲   │ dispute                │ verify RETURN                 │ (system) reversal làm thiếu tiền
                                                   │   ▼                        ▼                               ▼
                                                   └─ DISPUTED ─(bác)──────► IN_PROGRESS ◄───────────────────────┘
                      DISPUTED ─(chấp nhận + verify)─► CLOSED ;  OPEN|ASSIGNED ─cancel (kết luận sửa đổi)─► CANCELLED
```

| Từ | Command | Đến | Ai được làm | Guard | Audit/Event |
|---|---|---|---|---|---|
| PLANNED | `startAuditEngagement` | ONGOING | đầu mối | quyết định EFFECTIVE; hold đặt thành công nếu yêu cầu | `aud.engagement.started.v1` |
| ONGOING | `endAuditFieldwork` | AWAITING_CONCLUSION | đầu mối | – | `aud.engagement.fieldwork_ended.v1` |
| ONGOING, AWAITING_CONCLUSION | `recordAuditConclusion` | FOLLOW_UP | đầu mối | văn bản kết luận EFFECTIVE | `aud.conclusion.recorded.v1` |
| PLANNED, ONGOING | `cancelAuditEngagement` | CANCELLED | đầu mối | chưa có kết luận; lý do | `aud.engagement.cancelled.v1` |
| FOLLOW_UP | `closeAuditEngagement` | CLOSED | lãnh đạo (`aud.engagement.close`) | mọi kiến nghị CLOSED/CANCELLED; báo cáo ISSUED | `aud.engagement.closed.v1` |
| OPEN, ASSIGNED | `assignAuditRecommendation` | ASSIGNED | lãnh đạo giao việc | owner trong scope; hạn hợp lệ | `aud.recommendation.assigned.v1` |
| ASSIGNED | `planRemediationAction` | IN_PROGRESS | owner | – | `aud.action.planned.v1` |
| IN_PROGRESS | `submitRecommendationForVerification` | PENDING_VERIFICATION | owner | hành động xong; tài chính đủ tiền | `aud.recommendation.submitted.v1` |
| PENDING_VERIFICATION | `verifyAuditRecommendation` CLOSE | CLOSED | verifier ≠ người báo | tài chính: `recovered = amount` hoặc giải trình được chấp nhận | `aud.recommendation.closed.v1` |
| PENDING_VERIFICATION | `verifyAuditRecommendation` RETURN | IN_PROGRESS | verifier | lý do | `aud.recommendation.returned.v1` |
| ASSIGNED, IN_PROGRESS | `disputeAuditRecommendation` | DISPUTED | owner | văn bản giải trình | `aud.recommendation.disputed.v1` |
| DISPUTED | `recordAuditDisputeDecision` | IN_PROGRESS hoặc PENDING_VERIFICATION | verifier | văn bản ý kiến cơ quan tiến hành | `aud.recommendation.dispute_decided.v1` |
| CLOSED | (system) đảo khoản thu hồi | IN_PROGRESS | system actor | `recovered < amount` sau đảo | `aud.recommendation.reopened.v1` |

Chuyển bị cấm (409 `ENGAGEMENT_STATE_INVALID` / `RECOMMENDATION_STATE_INVALID`): ghi kết luận khi PLANNED; đóng cuộc khi còn kiến nghị mở (`OPEN_RECOMMENDATIONS_REMAIN`); OPEN→CLOSED; tự xác minh; CANCELLED/CLOSED (cuộc) → bất kỳ. `audit_follow_up_report`: DRAFT→ISSUE_REQUESTED→ISSUED|REJECTED, ISSUED→RECALLED (khi DOC thu hồi). `audit_remediation_action`: PLANNED→DONE|CANCELLED.

## 5. Quy tắc nghiệp vụ và công thức

- **BR-AUD-01** Tiền là `numeric(24,0)` VND; API chuỗi decimal. `recovered_vnd = Σ audit_recovery_link.amount_vnd` (gồm dòng âm) của kiến nghị — duy trì trong transaction có khóa hàng; job đối soát hằng ngày so lại tổng (lệch → cảnh báo P1).
- **BR-AUD-02** `0 ≤ recovered_vnd ≤ amount_vnd` (CHECK DB); khoản làm vượt bị từ chối (`RECOVERY_EXCEEDS_RECOMMENDATION`) và ghi exception cho kế toán.
- **BR-AUD-03** Một khoản PAY (`source_kind`, `source_id`) chỉ gắn một lần khi dương (unique một phần); sự kiện PAY dedupe theo `source_event_id`.
- **BR-AUD-04** Tỷ lệ hoàn thành tài chính = `Σ recovered_vnd / Σ amount_vnd` trên tập kiến nghị tài chính trong scope, numeric, làm tròn hiển thị 2 chữ số %; mẫu số 0 → "không áp dụng" (không hiển thị 0%). Tỷ lệ hoàn thành số lượng = kiến nghị CLOSED / (tổng − CANCELLED). Luôn trả tử và mẫu.
- **BR-AUD-05** Σ `amount_vnd` các kiến nghị tài chính của một revision kết luận ≤ `total_financial_vnd`; nhỏ hơn được phép nhưng hiển thị lệch.
- **BR-AUD-06** Hạn kiến nghị mặc định = `implementation_due_on` của kết luận; hạn riêng không được sau hạn kết luận trừ khi có văn bản gia hạn của cơ quan tiến hành (ghi `closure_basis_document_id`/bằng chứng) [CXN-AUD-01]. Quá hạn khi `today > due_on` theo lịch tenant và trạng thái ∉ {CLOSED, CANCELLED, DISPUTED}.
- **BR-AUD-07** Nhắc 7/3/1 ngày trước hạn; quá hạn leo thang lên lãnh đạo đơn vị owner, sau 15 ngày lên lãnh đạo tenant [GIẢ ĐỊNH]; dedupe theo (kiến nghị, ngày, mức).
- **BR-AUD-08** Người báo hoàn thành (`submitted_by`) ≠ người xác minh (`verified_by`) — CHECK `close_chk`.
- **BR-AUD-09** Bằng chứng phải là `document` EFFECTIVE (qua `DocumentReferencePort`) hoặc ATTACHMENT quét sạch; không lưu tệp trong AUD.
- **BR-AUD-10** Khi cuộc bắt đầu, legal hold bao phủ phạm vi; DOC/PAY/CTR không cho hủy hồ sơ/tài liệu trong phạm vi; nhả khi CLOSED/CANCELLED nếu không có hold khác.
- **BR-AUD-11** Dữ liệu AUD là CONFIDENTIAL; không gửi tới mô hình AI quốc tế; báo cáo tổng hợp lên cấp trên chỉ qua DOC (R6). Kết luận đã công khai (`is_public`) có thể hiển thị ở cổng công khai MNE sau khi duyệt [CXN-AUD-03].
- **BR-AUD-12** Báo cáo kết quả thực hiện dùng số liệu as-of đóng băng; payload chuẩn hóa + băm theo BR-DOC-11.

### Kiểm toán tách bạch nhiệm vụ (AUD-13; G4-1)
Kiểm toán (`aud.sod.read`, chỉ đọc) xem `sod_exception` (ngoại lệ đã xin, đang hiệu lực, bị từ chối, thu hồi, hết hạn, kèm số người duyệt và số lần dùng) và `sod_exception_use` (mỗi lần một lệnh gặp xung đột nhiệm vụ: đi qua bằng ngoại lệ, đi qua vì cặp chỉ cảnh báo, hoặc bị chặn; không sửa, không xóa). Lọc theo kết quả, người, ngoại lệ. Loại cảnh báo `SOD_EXCEPTION_USED` (WATCH) nhắc kiểm toán xem lại các hồ sơ đã đi qua ngoại lệ. Ma trận và luật: ADM.md 3.14.

### Phát hiện toàn vẹn thanh toán (AUD-12; G4-2)
Kiểm toán nội bộ (`payment.integrity.audit.read`, chỉ đọc) xem mọi phát hiện của các lượt kiểm đề nghị thanh toán trong phạm vi của mình: `DUPLICATE_CLAIM`, `UNIT_PRICE_OUTLIER`, `QUANTITY_VS_DIARY`, `EXCEEDS_CONTRACT`, `EXCEEDS_PLAN`, `EXCEEDS_ACCEPTED`. Phát hiện chặn (INVARIANT, đã dừng tiền) tách khỏi tín hiệu (SIGNAL, chỉ nhờ người duyệt xem lại); mỗi dòng nêu ngày, đề nghị, hợp đồng, dự án, phiên bản quy tắc đã quyết (0 là mặc định chưa xác nhận) và việc có ngoại lệ che hay không. `payment_integrity_run` và `payment_integrity_finding` chỉ thêm, không sửa, không xóa; phát hiện của đề nghị bị chặn vẫn được giữ dù đề nghị không được gửi. Lọc theo mã, mức, hợp đồng, ngày; phân trang theo con trỏ. Màn AUD-12; chi tiết ở PAY 3.3b.

## 6. Dữ liệu

| Bảng | Trường chính | Ràng buộc/Index | Owner | Classification | Retention |
|---|---|---|---|---|---|
| `audit_engagement` | mã, loại, cơ quan, `decision_document_id`, thời kỳ, đầu mối, trạng thái, `legal_hold_id` | UNIQUE mã; CHECK thời kỳ/đóng/hủy | AUD | CONFIDENTIAL | Vĩnh viễn [CXN-05] |
| `audit_scope_item` | đơn vị/dự án/hợp đồng | CHECK đúng loại; UNIQUE | AUD | CONFIDENTIAL | Cùng cuộc |
| `audit_conclusion` | loại, văn bản, revision, hạn, tổng tài chính, công khai | UNIQUE (cuộc, loại, revision); revision>1 ⇒ supersedes | AUD | CONFIDENTIAL | Vĩnh viễn |
| `audit_finding` | nhóm, dự án/hợp đồng/đơn vị, mô tả, số tiền, mức độ | UNIQUE mã/kết luận | AUD | CONFIDENTIAL | Vĩnh viễn |
| `audit_recommendation` | loại, số tiền, `recovered_vnd`, owner, hạn, trạng thái, giải trình, xác minh | CHECK tài chính cần tiền; `recovered ≤ amount`; SoD đóng; index `(status, due_on)` | AUD | CONFIDENTIAL | Vĩnh viễn |
| `audit_remediation_action` | hành động, ngày, bằng chứng | DONE ⇒ ngày + bằng chứng | AUD | CONFIDENTIAL | Vĩnh viễn |
| `audit_recovery_link` | nguồn PAY, số tiền ±, đảo | Chỉ INSERT; âm ⇔ đảo; unique nguồn/sự kiện | AUD | CONFIDENTIAL | Vĩnh viễn |
| `audit_evidence` | đối tượng, `document_id` | UNIQUE bộ ba | AUD | CONFIDENTIAL | Vĩnh viễn |
| `audit_follow_up_report` | as-of, totals, băm, trạng thái, `report_document_id` | ISSUED ⇒ có văn bản; SoD | AUD | CONFIDENTIAL | Vĩnh viễn |

FK composite tới `document`, `project`, `contract`, `organization_unit`, `legal_hold`; `audit_recovery_link.source_id` là tham chiếu logic tới bảng thu hồi của PAY (FK thêm khi PAY công bố bảng — §13). Mọi cột `*_id` có index `(tenant_id, col)`.

- `audit_engagement` (mới): id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on, fieldwork_ended_on, closed_on, legal_hold_id, classification, cancel_reason, created_at, created_by, updated_at, updated_by, version
- `audit_scope_item` (mới): id, engagement_id, scope_kind, organization_unit_id, project_id, contract_id, added_by, added_at
- `audit_conclusion` (mới): id, engagement_id, conclusion_kind, conclusion_document_id, revision, supersedes_id, issued_on, received_on, implementation_due_on, report_due_on, summary, total_financial_vnd, is_public, status, created_at, created_by, updated_at, updated_by, version
- `audit_finding` (mới): id, conclusion_id, finding_code, category, project_id, contract_id, organization_unit_id, description, legal_basis_cited, amount_vnd, severity, created_at, created_by, updated_at, updated_by, version
- `audit_recommendation` (mới): id, conclusion_id, finding_id, rec_code, rec_type, description, amount_vnd, recovered_vnd, project_id, owner_unit_id, owner_user_id, due_on, status, is_overdue, linked_issue_id, dispute_reason, dispute_document_id, dispute_outcome, closure_basis_document_id, submitted_by, verified_by, verified_at, created_at, created_by, updated_at, updated_by, version
- `audit_remediation_action` (mới): id, recommendation_id, action_code, description, planned_on, completed_on, status, evidence_document_id, reported_by, created_at, created_by, updated_at, updated_by, version
- `audit_recovery_link` (mới): id, recommendation_id, source_kind, source_id, source_event_id, amount_vnd, recorded_on, evidence_document_id, reversal_of_id, recorded_by, recorded_at
- `audit_evidence` (mới): id, owner_kind, owner_id, document_id, note, attached_by, attached_at
- `audit_follow_up_report` (mới): id, engagement_id, conclusion_id, as_of_date, revision, totals_json, payload_sha256, status, report_document_id, approved_by, created_at, created_by, updated_at, updated_by, version

## 7. API / command

| operationId | Method path | x-permission | Request DTO | Lỗi chính | Idem | If-Match |
|---|---|---|---|---|---|---|
| `createAuditEngagement` | POST /audit-engagements | aud.engagement.manage | `AudEngagementCreate` | ENGAGEMENT_CODE_DUPLICATE, DECISION_DOCUMENT_NOT_EFFECTIVE, SCOPE_OUT_OF_TENANT | ✔ | – |
| `startAuditEngagement` | POST /audit-engagements/{id}/start | aud.engagement.manage | `AudEngagementStart` | ENGAGEMENT_STATE_INVALID | ✔ | ✔ |
| `endAuditFieldwork` | POST /audit-engagements/{id}/fieldwork-end | aud.engagement.manage | `AudStatusNote` | ENGAGEMENT_STATE_INVALID | ✔ | ✔ |
| `cancelAuditEngagement` | POST /audit-engagements/{id}/cancellation | aud.engagement.manage | `AudStatusNote` | ENGAGEMENT_STATE_INVALID, CONCLUSION_EXISTS | ✔ | ✔ |
| `recordAuditConclusion` | POST /audit-engagements/{id}/conclusions | aud.conclusion.record | `AudConclusionRecord` | ENGAGEMENT_STATE_INVALID, DECISION_DOCUMENT_NOT_EFFECTIVE, CONCLUSION_REVISION_INVALID | ✔ | ✔ |
| `recordAuditFinding` | POST /audit-conclusions/{id}/findings | aud.conclusion.record | `AudFindingRecord` | FINDING_CODE_DUPLICATE, SCOPE_OUT_OF_TENANT | ✔ | – |
| `createAuditRecommendation` | POST /audit-conclusions/{id}/recommendations | aud.conclusion.record | `AudRecommendationCreate` | REC_CODE_DUPLICATE, AMOUNT_REQUIRED, FINANCIAL_TOTAL_MISMATCH | ✔ | – |
| `assignAuditRecommendation` | POST /audit-recommendations/{id}/assignment | aud.recommendation.assign | `AudAssign` | RECOMMENDATION_STATE_INVALID, OWNER_OUT_OF_SCOPE, DUE_AFTER_CONCLUSION_DEADLINE | ✔ | ✔ |
| `planRemediationAction` | POST /audit-recommendations/{id}/actions | aud.recommendation.execute | `AudActionPlan` | RECOMMENDATION_STATE_INVALID, NOT_OWNER | ✔ | ✔ |
| `completeRemediationAction` | POST /audit-remediation-actions/{id}/completion | aud.recommendation.execute | `AudActionComplete` | ACTION_STATE_INVALID, EVIDENCE_REQUIRED, NOT_OWNER | ✔ | ✔ |
| `linkAuditRecovery` | POST /audit-recommendations/{id}/recoveries | aud.recovery.record | `AudRecoveryLink` | RECOVERY_EXCEEDS_RECOMMENDATION, RECOVERY_SOURCE_ALREADY_LINKED, RECOMMENDATION_NOT_FINANCIAL, EVIDENCE_REQUIRED | ✔ | ✔ |
| `reverseAuditRecovery` | POST /audit-recovery-links/{id}/reversal | aud.recovery.record | `AudRecoveryReversal` | RECOVERY_ALREADY_REVERSED | ✔ | – |
| `submitRecommendationForVerification` | POST /audit-recommendations/{id}/verification-request | aud.recommendation.execute | – | RECOMMENDATION_STATE_INVALID, OPEN_ACTIONS_REMAIN, RECOVERY_INCOMPLETE | ✔ | ✔ |
| `verifyAuditRecommendation` | POST /audit-recommendations/{id}/verification | aud.recommendation.verify | `AudVerification` | SELF_APPROVAL_DENIED, RECOMMENDATION_STATE_INVALID, RECOVERY_INCOMPLETE | ✔ | ✔ |
| `disputeAuditRecommendation` | POST /audit-recommendations/{id}/dispute | aud.recommendation.execute | `AudDispute` | RECOMMENDATION_STATE_INVALID | ✔ | ✔ |
| `recordAuditDisputeDecision` | POST /audit-recommendations/{id}/dispute-decision | aud.recommendation.verify | `AudDisputeDecision` | RECOMMENDATION_STATE_INVALID, DECISION_DOCUMENT_NOT_EFFECTIVE | ✔ | ✔ |
| `attachAuditEvidence` | POST /audit-evidence | aud.recommendation.execute | `AudEvidenceAttach` | DOCUMENT_NOT_EFFECTIVE, OWNER_NOT_FOUND | ✔ | – |
| `requestAuditFollowUpReport` | POST /audit-engagements/{id}/follow-up-reports | aud.report.issue | `AudFollowUpReport` | DOC_TEMPLATE_MISSING, ENGAGEMENT_STATE_INVALID | ✔ | ✔ |
| `closeAuditEngagement` | POST /audit-engagements/{id}/closure | aud.engagement.close | `AudStatusNote` | OPEN_RECOMMENDATIONS_REMAIN, FOLLOW_UP_REPORT_MISSING, ENGAGEMENT_STATE_INVALID | ✔ | ✔ |
| `listAuditEngagements` | GET /audit-engagements | aud.read | – | – | – | – |
| `getAuditEngagement` | GET /audit-engagements/{id} | aud.read | – | – | – | – |
| `listAuditRecommendations` | GET /audit-recommendations | aud.read | – | – | – | – |
| `getAuditRecoverySummary` | GET /audit-engagements/{id}/recovery-summary | aud.read | – | – | – | – |

Consumer nội bộ (không REST): `pay.recovery.recorded.v1`, `pay.recovery.reversed.v1` → F4; `doc.issued.v1`, `doc.rejected.v1`, `doc.recalled.v1` → F6. AUD không có GET scaffold baseline; mọi đọc qua query ở bảng trên với DTO và lọc theo phạm vi cuộc. Không có endpoint ghi chung cho `status`, `recovered_vnd`, `amount_vnd` sau khi kiến nghị đã ASSIGNED (đổi số tiền cần kết luận sửa đổi).

## 8. UI/UX

Màn hình mới **AUD-01…AUD-11** (D-B11; component families: MetricTile, DataTable, FilterBar, WorkflowCanvas dạng board cho AUD-07, EvidenceViewer cho bằng chứng, ComparePanel cho kết luận sửa đổi, DrillDrawer từ ô tiền tới dòng thu hồi PAY):

| ID | Tên | Kind | Phase | Nền tảng | Trường chính |
|---|---|---|---|---|---|
| AUD-01 | Tổng quan thanh tra, kiểm toán | dashboard | P0 | web | Cuộc đang diễn ra; Kiến nghị mở; Kiến nghị quá hạn; Tiền kiến nghị; Đã thu hồi; Tỷ lệ hoàn thành (tử/mẫu) |
| AUD-02 | Danh sách cuộc thanh tra, kiểm toán | table | P0 | web | Mã cuộc; Loại; Cơ quan tiến hành; Thời kỳ; Trạng thái; Đầu mối; Legal hold |
| AUD-03 | Hồ sơ cuộc thanh tra, kiểm toán | detail | P0 | web | Quyết định; Phạm vi (đơn vị/dự án/hợp đồng); Thời kỳ; Mốc; Legal hold; Tài liệu làm việc |
| AUD-04 | Tiếp nhận kết luận, báo cáo kiểm toán | form | P0 | web | Loại kết luận; Văn bản kết luận (DOC); Ngày ban hành/nhận; Hạn thực hiện; Hạn báo cáo; Tổng kiến nghị tài chính; Công khai |
| AUD-05 | Phát hiện | table | P0 | web | Mã phát hiện; Nhóm; Dự án/hợp đồng; Đơn vị; Số tiền; Mức độ; Căn cứ bị vi phạm |
| AUD-06 | Kiến nghị và phân công | table | P0 | web | Mã kiến nghị; Loại; Số tiền; Owner; Hạn; Trạng thái; Vướng mắc liên kết |
| AUD-07 | Theo dõi thực hiện kiến nghị | board | P0 | web | Cột trạng thái; Thẻ kiến nghị; Hạn và số ngày trễ; Hành động khắc phục; Bằng chứng |
| AUD-08 | Thu hồi tài chính và đối chiếu PAY | reconcile | P0 | web | Kiến nghị; Nguồn (PAY/Kho bạc/thủ công); Số tiền; Ngày; Lũy kế; Còn lại; Đảo |
| AUD-09 | Bằng chứng khắc phục | documents | P1 | web | Đối tượng; Tài liệu (DOC); Ghi chú; Người gắn; Thời điểm |
| AUD-10 | Báo cáo kết quả thực hiện kiến nghị | approval | P0 | web | As-of; Số liệu tổng hợp; Băm payload; Trạng thái DOC; Người duyệt |
| AUD-11 | Cảnh báo quá hạn và leo thang | list | P1 | web | Kiến nghị; Owner; Hạn; Số ngày trễ; Mức leo thang; Đã thông báo |

Trạng thái riêng: "Đang giải trình" (tạm dừng tính hạn), "Quá hạn N ngày (hạn dd/mm/yyyy)", "Thu hồi lệch tổng kết luận", "Đã mở lại do đảo thu hồi", "Chờ DOC phát hành". Tiền hiển thị VND nguyên có phân tách nghìn; tỷ lệ luôn kèm tử/mẫu; không chỉ dùng màu. Board AUD-07 không cho kéo-thả đổi trạng thái. Mobile: không có màn AUD ở R1; lãnh đạo xem chỉ số qua HOME (đề xuất ô "Kiến nghị quá hạn" cho HOME owner).

## 9. Sự kiện, job, tích hợp, quan sát

Events: `aud.engagement.created.v1`, `aud.engagement.started.v1 {scope, legal_hold_id}`, `aud.engagement.fieldwork_ended.v1`, `aud.engagement.cancelled.v1`, `aud.engagement.closed.v1`, `aud.conclusion.recorded.v1`, `aud.finding.recorded.v1`, `aud.recommendation.created.v1`, `aud.recommendation.assigned.v1 {owner_unit_id, due_on}`, `aud.recommendation.submitted.v1`, `aud.recommendation.closed.v1`, `aud.recommendation.returned.v1`, `aud.recommendation.reopened.v1`, `aud.recommendation.disputed.v1`, `aud.recommendation.dispute_decided.v1`, `aud.recommendation.due_soon.v1`, `aud.recommendation.overdue.v1`, `aud.action.planned.v1`, `aud.action.completed.v1`, `aud.recovery.linked.v1`, `aud.recovery.reversed.v1`, `aud.report.issue_requested.v1` (DOC nhận như `doc.issue_requested.v1`). Consumers: PAY `pay.recovery.recorded.v1`/`pay.recovery.reversed.v1`; DOC `doc.issued/rejected/recalled.v1`; ADM `legal_hold.placed/released.v1` (đồng bộ trạng thái hold). Temporal: `AudEngagementHoldSaga` (đặt/nhả hold có bù trừ). Job: `aud.recommendation-overdue` (06:00 hằng ngày), `aud.recovery-reconcile` (02:00: so `recovered_vnd` với Σ link). Cache: `t:{tenant}:aud:summary:{scope_hash}` TTL 120 s, vô hiệu khi `aud.recovery.*`/`aud.recommendation.*`. Telemetry: `aud_recommendation_overdue_gauge`, `aud_recovery_reconcile_mismatch_total` (phải = 0), `aud_followup_report_late_total`; log không chứa nội dung kết luận/tên cá nhân.

## 10. Kiểm thử

Ma trận: positive (AC433, AC436, AC437, AC440), negative (AC434, AC443), boundary (AC438), đồng thời (AC439), bảo mật/cách ly (AC435, AC442), idempotency (AC437, AC444).

| ID | Loại | Ưu tiên | Setup | Input/Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC433 | integration | P0 | TNT-A; văn bản QĐ thanh tra QĐ-TT-01 đã đăng ký ở DOC (EFFECTIVE); dự án P-A-001 và hợp đồng C-01 thuộc TNT-A; A-coord có aud.engagement.manage. | 1) POST /audit-engagements {engagement_code:"TT-2026-01", engagement_type:"ADMINISTRATIVE_INSPECTION", authority_kind:"PROVINCIAL_INSPECTORATE", decision_document_id:QĐ-TT-01, period_from:"2024-01-01", period_to:"2025-12-31", scope:[{PROJECT:P-A-001},{CONTRACT:C-01}]} 2) POST /audit-engagements/{id}/start {started_on:"2026-10-22", place_legal_hold:true} 3) Thử POST /dossiers/{hồ sơ P-A-001}/disposal-proposals 4) Tạo cuộc khác cùng mã TT-2026-01 | Bước 1: 200 PLANNED, 2 audit_scope_item; bước 2: ONGOING, legal_hold_id khác null, ADM legal_hold hold_kind=INSPECTION Active trên P-A-001/C-01; bước 3: 409 LEGAL_HOLD_ACTIVE; bước 4: 409 ENGAGEMENT_CODE_DUPLICATE. | DB + legal_hold |
| UAT-AC434 | domain | P0 | Cuộc TT-2026-01 AWAITING_CONCLUSION; kết luận KL-01 (văn bản đến DOC) ghi tổng kiến nghị tài chính 1.250.000.000 VND. | 1) POST /audit-engagements/{id}/conclusions {conclusion_kind:"INSPECTION_CONCLUSION", conclusion_document_id:KL-01, issued_on:"2026-11-05", received_on:"2026-11-06", total_financial_vnd:"1250000000", report_due_on:"2027-01-05"} 2) POST findings F1 (FINANCIAL, P-A-001, 800000000) và F2 (PROCEDURE) 3) POST recommendations R1 FINANCIAL_RECOVERY 800000000 (F1), R2 FINANCIAL_ADJUSTMENT 400000000, rồi R3 PROCESS_CORRECTION 4) Kiểm tổng: tạo thêm R4 FINANCIAL_RECOVERY 100000000 | Cuộc → FOLLOW_UP; conclusion RECEIVED revision 1; R1/R2/R3 OPEN; Σ tài chính = 1.200.000.000 ≠ 1.250.000.000 nên AUD-04 hiển thị cảnh báo "lệch 50.000.000"; R4 làm Σ = 1.300.000.000 > tổng kết luận → 422 FINANCIAL_TOTAL_MISMATCH; R1 không có amount → 422 AMOUNT_REQUIRED khi thử. | DB |
| UAT-AC435 | security | P0 | R1 OPEN; A-coord có scope U-STC và con; U-BQL9 thuộc tenant nhưng ngoài scope; U-X thuộc TNT-B. | 1) POST /audit-recommendations/{R1}/assignment {owner_unit_id:U-BQL1, owner_user_id:A-owner, due_on:"2026-12-31"} 2) Gán cho U-BQL9 3) Gán cho U-X 4) Gán due_on 2027-02-01 (sau hạn thực hiện kết luận 2027-01-05) | Bước 1: 200 ASSIGNED; bước 2: 422 OWNER_OUT_OF_SCOPE; bước 3: 404 (không lộ đơn vị tenant khác); bước 4: 422 DUE_AFTER_CONCLUSION_DEADLINE. | API log |
| UAT-AC436 | E2E | P0 | R3 (PROCESS_CORRECTION) ASSIGNED cho A-owner; văn bản quy trình mới QĐ-QT-07 EFFECTIVE ở DOC; A-verifier có aud.recommendation.verify. | 1) A-owner POST /audit-recommendations/{R3}/actions {action_code:"A1", planned_on:"2026-11-30"} 2) POST /audit-remediation-actions/{A1}/completion không kèm evidence, rồi kèm evidence QĐ-QT-07 3) A-owner POST verification-request 4) A-owner tự POST /verification {decision:CLOSE} 5) A-verifier POST /verification {decision:CLOSE, closure_basis_document_id:QĐ-QT-07} | IN_PROGRESS sau bước 1; thiếu evidence: 422 EVIDENCE_REQUIRED, có evidence: DONE; PENDING_VERIFICATION; tự đóng: 403 SELF_APPROVAL_DENIED; A-verifier: CLOSED, verified_by=A-verifier, sự kiện aud.recommendation.closed.v1. | outbox + DB |
| UAT-AC437 | domain | P0 | R1 FINANCIAL_RECOVERY amount 800.000.000 ASSIGNED; PAY có khoản thu hồi PR-1 = 500.000.000 và PR-2 = 300.000.000 nộp NSNN. | 1) Consumer nhận pay.recovery.recorded.v1 {recovery_id:PR-1, audit_recommendation_id:R1, amount_vnd:"500000000"} 2) Nhận lại cùng sự kiện (event_id trùng) 3) POST /audit-recommendations/{R1}/recoveries {source_kind:PAY_RECOVERY, source_id:PR-2, amount_vnd:"300000000"} 4) GET /audit-engagements/{id}/recovery-summary | Sau bước 1: recovered_vnd=500.000.000; bước 2: bỏ qua (inbox, unique source_event_id), vẫn 500.000.000; bước 3: recovered_vnd=800.000.000; summary: amount 800.000.000 (chỉ R1 trong ví dụ), recovered 800.000.000, remaining 0, completion_rate "1.0000" với tử=800000000, mẫu=800000000. | DB + AUD-01 |
| UAT-AC438 | business | P1 | R2 ASSIGNED hạn 2026-12-31 cho U-BQL1 (lãnh đạo A-lead-BQL1); job aud.recommendation-overdue chạy 06:00 hằng ngày. | 1) Chạy job các ngày 2026-12-24, 12-28, 12-30 2) Chạy job ngày 2027-01-02 3) Mở AUD-07 và AUD-11 | Nhắc trước hạn 7/3/1 ngày (3 sự kiện aud.recommendation.due_soon.v1); ngày 2027-01-02: is_overdue=true, nhãn "Quá hạn 2 ngày (hạn 31/12/2026)", leo thang tới A-lead-BQL1; job chạy lại cùng ngày không phát trùng (dedupe key rec+ngày). | job log + NOT |
| UAT-AC439 | concurrency | P0 | R2 FINANCIAL_ADJUSTMENT amount 400.000.000, recovered 300.000.000; hai kế toán ghi đồng thời 2 khoản giảm trừ PD-1 = 80.000.000 và PD-2 = 80.000.000 (khóa khác nhau). | 1) Đồng thời POST /audit-recommendations/{R2}/recoveries cho PD-1 và PD-2 2) POST /audit-recovery-links/{PD-1 link}/reversal {reason:"Nhập nhầm chứng từ"} 3) Ghi lại PD-2 | Một lệnh 200 (recovered 380.000.000), lệnh còn lại 409 RECOVERY_EXCEEDS_RECOMMENDATION (380 + 80 > 400); đảo tạo dòng âm -80.000.000, recovered 300.000.000; ghi lại PD-2 thành công 380.000.000; không có dòng nào bị xóa; CHECK recovery_chk không bao giờ vi phạm. | DB constraint + API log |
| UAT-AC440 | integration | P0 | Cuộc TT-2026-01 FOLLOW_UP; mẫu DOC AUD-BC-KET-QUA-THUC-HIEN-KIEN-NGHI PUBLISHED (chờ xác nhận, watermark); R1 CLOSED, R2 IN_PROGRESS, R3 CLOSED. | 1) POST /audit-engagements/{id}/follow-up-reports {conclusion_id:KL-01, as_of_date:"2027-01-04"} 2) DOC phát doc.issued.v1 với source_ref "AUD:audit_follow_up_report:<id>:r1" 3) POST /audit-engagements/{id}/closure | Báo cáo ISSUE_REQUESTED với totals_json {closed:2, in_progress:1, amount:1200000000, recovered:1100000000} và payload_sha256; sau doc.issued: ISSUED, report_document_id set; đóng cuộc: 409 OPEN_RECOMMENDATIONS_REMAIN (R2 còn mở). | outbox + DOC |
| UAT-AC441 | domain | P1 | R2 IN_PROGRESS; đơn vị gửi giải trình GT-01 (DOC) đề nghị miễn giảm trừ 100.000.000. | 1) POST /audit-recommendations/{R2}/dispute {dispute_reason:"Khối lượng đã được nghiệm thu bổ sung theo phụ lục 03", dispute_document_id:GT-01} 2) POST /dispute-decision {outcome:REJECTED_BY_AUTHORITY, authority_document_id:CV-TT-05} 3) Lặp lại với outcome ACCEPTED_BY_AUTHORITY rồi verification CLOSE khi recovered 300.000.000 < 400.000.000 | DISPUTED rồi trở lại IN_PROGRESS khi bị bác; khi được chấp nhận: dispute_outcome=ACCEPTED_BY_AUTHORITY và đóng được dù recovered 300.000.000 < 400.000.000 (CHECK fin_close_chk cho phép); không có văn bản cơ quan → 422 DECISION_DOCUMENT_NOT_EFFECTIVE. | DB + audit |
| UAT-AC442 | security (cách ly tenant) | P0 | Cuộc TT-2026-01 thuộc TNT-A (CONFIDENTIAL); B-coord thuộc TNT-B; A-viewer thuộc TNT-A nhưng scope U-BQL9 không giao phạm vi cuộc. | 1) B-coord GET /audit-engagements/{id} và /recovery-summary 2) A-viewer GET /audit-engagements/{id} 3) A-viewer GET /audit-recommendations?overdue=true | B-coord: 404; A-viewer: 404 với chi tiết cuộc; danh sách kiến nghị trả 0 dòng của TT-2026-01; truy vấn không đặt app.tenant_id trả 0 dòng. | RLS log |
| UAT-AC443 | domain (negative) | P1 | Cuộc PLANNED; kết luận chưa có. | 1) POST /audit-engagements/{id}/conclusions khi PLANNED 2) POST /closure khi PLANNED 3) Hủy cuộc PLANNED với lý do rồi start | 409 ENGAGEMENT_STATE_INVALID cho hai lệnh đầu; hủy: CANCELLED, legal hold (nếu có) nhả; start sau hủy: 409 ENGAGEMENT_STATE_INVALID. | API log |
| UAT-AC444 | integration (idempotency) | P1 | R1 recovered 800.000.000 = amount; PAY phát pay.recovery.reversed.v1 cho PR-2 (300.000.000) do chứng từ bị hủy ở Kho bạc. | 1) Consumer nhận pay.recovery.reversed.v1 {recovery_id:PR-2} 2) Nhận lại sự kiện 3) Xem R1 (đã CLOSED trước đó) | Một dòng đảo -300.000.000 (reversal_of_id = link PR-2), recovered_vnd=500.000.000; sự kiện lặp bị bỏ qua; R1 tự mở lại IN_PROGRESS với audit "reopened_by_reversal" và cảnh báo cho đầu mối. | DB |

Test màn hình `UI-AUD-01…UI-AUD-11` nằm trong `test_cases.json`.

## 11. Tiêu chí nghiệm thu

- **AC-AUD-01** Given quyết định thanh tra EFFECTIVE, When bắt đầu cuộc, Then legal hold có hiệu lực trên phạm vi và hồ sơ trong phạm vi không thể đề nghị hủy. → UAT-AC433
- **AC-AUD-02** Given kết luận có tổng tài chính, When ghi kiến nghị vượt tổng, Then 422 và không lưu. → UAT-AC434
- **AC-AUD-03** Given owner ngoài scope/tenant hoặc hạn sau hạn kết luận, When giao, Then 422/404. → UAT-AC435
- **AC-AUD-04** Given kiến nghị quy trình, When owner hoàn thành có bằng chứng, Then chỉ người khác mới đóng được. → UAT-AC436
- **AC-AUD-05** Given khoản thu hồi từ PAY, Then lũy kế đúng, sự kiện lặp không cộng hai lần, tỷ lệ trả tử/mẫu. → UAT-AC437, UAT-AC444
- **AC-AUD-06** Given hai khoản đồng thời làm vượt số kiến nghị, Then đúng một khoản bị 409 và lũy kế không vượt. → UAT-AC439
- **AC-AUD-07** Given kiến nghị sắp và đã quá hạn, Then nhắc 7/3/1 ngày và leo thang một lần mỗi ngày. → UAT-AC438
- **AC-AUD-08** Given báo cáo kết quả thực hiện, Then phát hành qua DOC với số liệu as-of; cuộc chỉ đóng khi hết kiến nghị mở. → UAT-AC440, UAT-AC443
- **AC-AUD-09** Given giải trình được cơ quan tiến hành chấp nhận, Then kiến nghị tài chính đóng được theo phần đã thu hồi. → UAT-AC441
- **AC-AUD-10** Given người ngoài scope hoặc tenant khác, Then 404 ở mọi đường. → UAT-AC442

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1 (dùng thật):** F1 (không bắt buộc legal hold tự động nếu ADM chưa sẵn: đặt thủ công), F2, F3, F4 (nhập tay + consumer PAY khi PAY phát sự kiện), F5, F6 qua DOC (đường (ii) nếu ký trong hệ thống chưa sẵn), F7; AUD-01…AUD-08, AUD-10. **R2:** AUD-09, AUD-11, tự tạo vướng mắc ISS, kết luận sửa đổi đầy đủ, ô HOME, đối soát tự động với sổ PAY. **R3:** nhập kết luận từ hệ thống của cơ quan thanh tra/KTNN nếu có đặc tả (hiện MISSING).
**Giờ review người:** quy tắc hạn và công khai [CXN-AUD-01/02/03] với Pháp chế/Thanh tra sở 4 h; đường tiền thu hồi và đối chiếu PAY 4 h; quyền/SoD/CONFIDENTIAL 2 h. Tổng ≈ 10 h.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| [CXN-AUD-01] Luật Thanh tra 84/2025: thời hạn thực hiện kết luận, trách nhiệm báo cáo, theo dõi đôn đốc | Pháp chế + Thanh tra sở | Văn bản gốc; cập nhật mặc định BR-AUD-06/07 |
| [CXN-AUD-02] Luật KTNN 81/2015 (sửa 55/2019): hạn và hình thức báo cáo kết quả thực hiện kiến nghị kiểm toán | Pháp chế | Văn bản gốc; mẫu báo cáo DOC |
| [CXN-AUD-03] Công khai kết luận thanh tra (phạm vi, hình thức) | Pháp chế | Văn bản gốc; quy tắc hiển thị cổng công khai |
| Cross-module: PAY phát `pay.recovery.recorded.v1`/`reversed.v1` có `audit_recommendation_id` và công bố bảng thu hồi để thêm FK | PAY owner | Hợp đồng sự kiện + tên bảng |
| Cross-module: ADM interface `placeLegalHold/releaseLegalHold` gọi được từ saga AUD | ADM owner | Interface public |
| Cross-module: DOC mẫu `AUD-BC-KET-QUA-THUC-HIEN-KIEN-NGHI` | DOC owner (cùng nhóm) | Đã có trong gói mẫu, chờ xác nhận |
| Cross-module: HOME ô "Kiến nghị quá hạn" | HOME owner | Read model `listAuditRecommendations?overdue=true` |
| Ngưỡng leo thang 15 ngày [GIẢ ĐỊNH] | Lãnh đạo tenant | Quy chế nội bộ |

**Thay đổi bản ghi baseline (CR, baseline-first):**

Không có thay đổi bản ghi baseline.


## Làn GOV-12: thứ tự theo dõi kiến nghị, tố giác ẩn danh, sổ quà tặng (G4-10, G4-12)

**Thứ tự theo dõi kiến nghị của chủ đầu tư (AUD-17).** Điểm theo dõi cộng quá hạn, đang tranh luận, còn mở và số tiền còn phải thu nhân trọng số của quy tắc `AUDIT_STANDING_RULE` (chưa kiểm chứng); vị trí trong xếp hạng giải ngân mới nhất đã chốt được đọc bên cạnh và không bị đổi; không chứa tín hiệu rủi ro mua sắm.

**Tố giác ẩn danh (AUD-18).** Người tố giác gửi qua trang công khai, không để lại địa chỉ, thiết bị hay danh tính, nhận mã truy cập 160 bit một lần (chỉ lưu mã băm), và đọc trả lời bằng mã. Hai đồng hồ theo quy tắc `WHISTLE_RULE` (7 và 90 ngày, chưa kiểm chứng) lấy từ thiết lập cổng. Người thuộc đơn vị được nêu không thấy báo cáo. Nội dung tố giác là CONFIDENTIAL trong nhật ký và không có trong sự kiện.

**Sổ quà tặng (AUD-19).** Quà kê khai trong 5 ngày kể từ ngày nhận; trên 200.000 đồng phải có người thứ hai xem xét; trên 1.000.000 đồng không được giữ (trả lại hoặc nộp đơn vị); người xem xét khác người nhận; quy tắc `GIFT_RULE`, chưa kiểm chứng.
