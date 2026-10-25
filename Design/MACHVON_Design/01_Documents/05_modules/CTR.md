# CTR — Hợp đồng và thực hiện

Đặc tả phân hệ theo `_KHUNG_DAC_TA.md`, baseline 1.4 (22/10/2026). Quy ước chung ở `04_Thiet_ke_co_ban.md` và `05_Thiet_ke_chi_tiet.md`. [CXN-nn]/[CXN-EXE-nn] là căn cứ chờ xác nhận (R4); [GIẢ ĐỊNH] là lựa chọn theo D-B04. Nội dung baseline v1.3 của 18 màn hình CTR-01…CTR-18 được giữ nguyên ID, trường và quy tắc; thay đổi có chủ đích được ghi CR.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Sau lựa chọn nhà thầu, chủ đầu tư/Ban QLDA quản lý hợp đồng qua nhiều phiên bản (phụ lục, thay đổi), khối lượng thực hiện, nghiệm thu, bảo lãnh, khoản giữ lại và đánh giá nhà thầu. Lỗi thường gặp: dùng đơn giá của phụ lục chưa hiệu lực để thanh toán, giảm giá trị hợp đồng dưới khối lượng đã nghiệm thu, nghiệm thu khối lượng chưa duyệt, bảo lãnh hết hạn mà không ai biết, giải tỏa giữ lại khi còn khiếm khuyết, không có dữ liệu năng lực nhà thầu để cung cấp cơ sở dữ liệu quốc gia.

**Trong phạm vi.** Vòng đời hợp đồng DRAFT→IN_REVIEW→SIGNED→ACTIVE→COMPLETED→CLOSED với SUSPENDED/TERMINATED/CANCELLED có guard; phiên bản hợp đồng có hiệu lực theo ngày; BOQ (dòng ổn định `boq_item` + dòng giá theo phiên bản `boq_line`); liên danh (`contract_party`); chuỗi thay đổi ChangeEvent→PCO→CO với số tầng cố định theo dự án sau lần dùng đầu; khối lượng (`measurement`) và nghiệm thu khối lượng (`acceptance`, `acceptance_line`) dùng cho thanh toán; bảo lãnh/bảo hiểm và cảnh báo hết hạn; giữ lại theo dòng BOQ và giải tỏa có quyền riêng; đánh giá thực hiện hợp đồng, nhật ký vi phạm và xuất tệp cho cơ sở dữ liệu quốc gia về nhà thầu.

**Ngoài phạm vi / ranh giới.** Lựa chọn nhà thầu, khai báo xung đột lợi ích (BID); biên bản nghiệm thu chất lượng, nhật ký thi công, NCR (QMS — CTR chỉ nhận sự kiện `qms.quality_acceptance.approved.v1`); sổ lũy kế, tạm ứng, thanh toán, quyết toán (PAY); bàn giao, tài sản, bảo hành (AST); giấy phép và cổng (PMT); văn bản và ký số (DOC). Màn hình CTR-09, CTR-11, CTR-15, CTR-16, CTR-18 trở thành màn hình tổng hợp chỉ đọc của QMS/AST (CR ghi trong báo cáo).

**Phụ thuộc.** CTR → PRJ (dự án, giai đoạn IMPLEMENTATION), MDM (nhà thầu, đơn vị tính), CAP (cam kết vốn COMMIT, AVC), BID (kết quả gói thầu, xung đột lợi ích), DOC (văn bản quyết định); nhận sự kiện từ QMS; phát sự kiện cho PAY, CAP, AST, ISS, NOT.

**Căn cứ.** Luật Đấu thầu 22/2023 (sửa 90/2025) và NĐ 214/2025 (Điều 19–20: đánh giá nhà thầu, cung cấp thông tin lên Hệ thống mạng đấu thầu quốc gia) [CXN-EXE-01]; Luật Xây dựng 135/2025 và NĐ 06/2021 → NĐ 207/2026 (bảo hành, nghiệm thu) [CXN-07, CXN-EXE-04]; NĐ 254/2025 (điều kiện tạm ứng, bảo lãnh tạm ứng) [CXN-02]. Thực tiễn: Procore/Primavera Unifier (Change Event → Potential Change Order → Change Order, số tầng cấu hình), SAP PSM (retention theo dòng), Aconex (bảo lãnh có cảnh báo). Mức giữ lại, thời hạn bảo hành, trọng số bảng điểm là dữ liệu rule có `legal_basis` + hiệu lực.

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Được phép | Bị cấm |
|---|---|---|---|
| Chuyên viên hợp đồng (Ban QLDA) | UNIT_TREE của chủ đầu tư; PROJECT | `contract.create/update`, `contract.review.submit`, `boq.manage`, `guarantee.manage`, `change.manage`, `acceptance.create/submit`, `contractor.violation.record`, `contractor.performance.evaluate` | Tự duyệt (sign/approve) hồ sơ mình lập; ghi chung `status`; ghi tổng lũy kế |
| Lãnh đạo/người duyệt theo DoA | UNIT_TREE, hạn mức theo DoA matrix (ADM) | `contract.sign`, `contract.activate`, `contract.suspend/terminate/complete/close`, `contract.change.approve`, `acceptance.approve/revoke`, `measurement.approve`, `contractor.performance.approve`, `contractor.violation.confirm` | Duyệt vượt hạn mức DoA; duyệt khi có xung đột lợi ích chưa xử lý |
| Kế toán trưởng | UNIT_TREE | `retention.release`, `guarantee.verify`, `guarantee.release` | Giải tỏa khi điều kiện chưa đạt |
| Chuyên viên kỹ thuật / tư vấn giám sát (khách) | CONTRACT | `measurement.record/submit`, đọc BOQ | Duyệt khối lượng, xem giá trị lũy kế tài chính |
| Nhà thầu (khách) | CONTRACT (guest membership) | `measurement.record/submit`, xem hợp đồng/BOQ/trạng thái của mình | Mọi hợp đồng khác; số liệu nội bộ (ledger, đánh giá đang soạn) |
| Chủ nghiệp vụ / pháp chế | TENANT | `change.tiers.configure`, `change.retroactive.approve`, `contractor.export` | Sửa bản ghi nghiệp vụ đã duyệt |
| Auditor | Scope cấp, chỉ đọc | `contract.read`, `change.read`, `contractor.performance.read` | Mọi lệnh ghi |

## 3. Luồng nghiệp vụ

### 3.1 Lập – ký – hiệu lực (UC-CTR-01) — CTR-01, CTR-02, CTR-03, CTR-04, CTR-25
Tiền điều kiện: gói thầu có kết quả lựa chọn (BID), dự án ở IMPLEMENTATION (PRJ), kế hoạch vốn APPROVED (CAP). Hậu điều kiện: hợp đồng ACTIVE, phiên bản 1 EFFECTIVE, cam kết vốn COMMIT ghi ở CAP.
1. `createContract`: kiểm `contract_value_vnd ≤ ceiling` (giá gói thầu/dự toán duyệt) → `CONTRACT_VALUE_EXCEEDS_CEILING`; kế hoạch vốn chưa duyệt → `CAPITAL_PLAN_NOT_APPROVED`; nhà thầu chưa xác minh → `CONTRACTOR_NOT_VERIFIED`. Tạo `contract_revision` 1 (DRAFT).
2. `importBoqLines` (REPLACE/APPEND; idempotent theo `file_sha256`) tạo `boq_item` và `boq_line`; `replaceContractParties` khi liên danh.
3. `submitContractForReview`: Σ `boq_line.amount_vnd` = giá trị phiên bản (`BOQ_TOTAL_MISMATCH`), tổng tỷ lệ liên danh = 100 (`JV_SHARE_NOT_100`), kiểm xung đột lợi ích người thẩm định với nhà thầu qua interface BID (`CONFLICT_OF_INTEREST_BLOCKED`).
4. `recordContractSigning` bởi người có thẩm quyền khác người lập; tài liệu đã ký đã quét virus; nếu có xung đột đã được xử lý bằng quyết định thì ghi `conflict_decision_ref`.
5. `post_contracts_id_activate`: bảo lãnh thực hiện ACTIVE+VERIFIED (khi rule yêu cầu), cổng PMT `CONTRACT_ACTIVATION` đạt, CAP chấp nhận COMMIT; phiên bản 1 → EFFECTIVE; phát `ctr.contract.activated.v1`, `ctr.commitment.changed.v1`.

### 3.2 Tạm dừng, chấm dứt, hoàn thành, đóng (UC-CTR-02) — CTR-14, CTR-22, CTR-15, CTR-17
- Tạm dừng: lý do + văn bản + ngày; chặn khối lượng mới, tạm ứng mới; thanh toán theo ma trận PAY BR-PAY-09. Tiếp tục: văn bản; gia hạn tiến độ không tự động — chỉ qua CO.
- Chấm dứt: không đảo ngược; chọn xử lý bảo lãnh (CALL/RELEASE/HOLD); tạo gợi ý vi phạm; tạm ứng còn lại giữ nguyên cho quyết toán.
- Hoàn thành: biên bản nghiệm thu hoàn thành (QMS, phạm vi COMPLETION) APPROVED, không còn NCR CRITICAL, không còn khối lượng SUBMITTED chưa quyết; phát `ctr.contract.completed.v1` (AST khởi tạo bảo hành).
- Đóng: quyết toán hợp đồng CLOSED (PAY), tạm ứng đã thu hồi hết hoặc ngoại lệ, giữ lại đã giải tỏa hoặc chuyển nghĩa vụ bảo hành.

### 3.3 Chuỗi thay đổi (UC-CTR-03) — CTR-07, CTR-08, CTR-19, CTR-20, CTR-26
1. Chủ nghiệp vụ đặt `tier_count` cho dự án (`setChangeChainTiers`); lần tạo yêu cầu đầu tiên khóa cấu hình (`locked_at`, trigger DB).
2. `createChangeRequest` ở tầng đầu cho phép: 3 tầng → EVENT; 2 tầng → PCO; 1 tầng → CO. Tầng khác → `CHANGE_STAGE_NOT_ALLOWED`.
3. `promoteChangeRequest` chuyển EVENT→PCO→CO (tầng trước PROMOTED); `evaluateChangeRequest` thẩm định chi phí, tiến độ, phạm vi, nguồn vốn (kiểm AVC ở CAP cho phần tăng).
4. `post_contract_changes_id_decision` (người khác người lập): approve tạo `contract_revision` PENDING_EFFECTIVE với BOQ mới; giá trị mới không được nhỏ hơn `accepted_total_vnd` (`ACCEPTANCE_VALUE_EXCEEDS_CONTRACT`); `effective_on` < ngày duyệt mà không qua quy trình hồi tố → `RETROACTIVE_NOT_ALLOWED`.
5. Job `revision-effective` 00:05 giờ VN: phiên bản đến ngày → EFFECTIVE, phiên bản trước SUPERSEDED, cập nhật `contract_value_vnd`, `current_revision_id`, phát `ctr.commitment.changed.v1`.
6. Hồi tố: `approveRetroactiveAdjustment` có quyết định, liệt kê nghiệm thu bị ảnh hưởng; tạo bút toán điều chỉnh ở PAY, không sửa `acceptance_line` đã duyệt; bị chặn khi quyết toán đã duyệt.

### 3.4 Khối lượng → nghiệm thu (UC-CTR-04) — CTR-10, CTR-12, CTR-13
1. Nhà thầu/chuyên viên `recordMeasurement` theo `boq_item` và kỳ: `quantity_cumulative = lũy kế APPROVED trước + quantity_period`; không vượt khối lượng của phiên bản EFFECTIVE (`QUANTITY_EXCEEDS_BOQ`); kỳ âm chỉ qua `correctMeasurement`; `reference_no` trùng trong hợp đồng → `MEASUREMENT_REFERENCE_DUPLICATE` (trừ override có căn cứ); cổng PMT `START_CONSTRUCTION` phải đạt với hợp đồng xây dựng.
2. `submitMeasurement` → `post_measurements_id_decision` (người khác người nộp).
3. `createAcceptance` chỉ từ khối lượng APPROVED (`MEASUREMENT_NOT_APPROVED`); dòng nghiệm thu chụp đơn giá từ phiên bản EFFECTIVE tại ngày nghiệm thu.
4. `post_acceptances_id_decision`: cần `quality_acceptance_id` khi `requires_quality_acceptance`; không NCR CRITICAL mở trên hạng mục; `accepted_total_vnd + amount ≤ contract_value_vnd`. APPROVED → PAY tạo dòng sổ lũy kế (RECOGNIZE_ACCEPTANCE).
5. Đồng thời: hai nghiệm thu cùng chứa một khối lượng → unique `acceptance_line_measurement_uq` (dòng active) để đúng một thành công, bên kia `MEASUREMENT_ALREADY_ACCEPTED`. Thu hồi nghiệm thu (`revokeAcceptance`) chỉ khi không có đề nghị thanh toán giữ claim.

### 3.5 Bảo lãnh và giữ lại (UC-CTR-05) — CTR-05, CTR-21
Bảo lãnh đăng ký → xác minh với tổ chức phát hành (người khác người đăng ký) → ACTIVE. Job `guarantee-expiry` 06:00 giờ VN gửi cảnh báo ở 30/15/7/0 ngày (khử trùng bằng `last_alert_days`); hết hạn → EXPIRED; không tự gia hạn — `extendGuarantee` tạo bản mới phải xác minh lại. Giải tỏa cần bằng chứng. Giữ lại được tạo khi gửi thanh toán (PAY) theo dòng; giải tỏa (`releaseRetention`) khi điều kiện `release_condition` đạt (WARRANTY_END: nghĩa vụ bảo hành AST đã CLOSED; COMPLETION: hợp đồng COMPLETED; MANUAL_DECISION: có quyết định), quyền `retention.release`, khác người đề xuất.

### 3.6 Đánh giá nhà thầu và xuất cơ sở dữ liệu quốc gia (UC-CTR-06) — CTR-23, CTR-24
Đánh giá định kỳ/hoàn thành/chấm dứt với 5 tiêu chí → điểm tổng theo trọng số rule → xếp hạng; duyệt khác người lập. Vi phạm ghi từ CTR hoặc từ nguồn QMS/PAY/ISS/AUD; xác nhận cần văn bản nếu có chế tài. `exportContractorRecords` sinh CSV/JSON idempotent theo mã băm (không có API hệ thống quốc gia: PROPOSED tệp, MISSING API); `markContractorExportSubmitted` ghi mã biên nhận nhập tay [CXN-EXE-01].

## 4. State machine

```
Contract
 DRAFT ─submit-review─► IN_REVIEW ─sign─► SIGNED ─activate─► ACTIVE ─complete─► COMPLETED ─close─► CLOSED
   ▲  ◄────return──────────┘                │               │ ▲  suspend│resume                ▲
   │                                        │               ▼ │        SUSPENDED                │
 DRAFT|IN_REVIEW ─cancel─► CANCELLED        └──terminate──► TERMINATED ◄── ACTIVE|SUSPENDED      │
                                                              └────────────── close ─────────────┘
```

| Từ | Command | Đến | Ai | Guard | Audit/Event |
|---|---|---|---|---|---|
| DRAFT | `submitContractForReview` | IN_REVIEW | `contract.review.submit` | BOQ cân, liên danh 100, giá ≤ trần, kế hoạch APPROVED, không xung đột | `ctr.contract.review_requested.v1` |
| IN_REVIEW | `returnContractDraft` | DRAFT | `contract.review.decide` | lý do; khác người lập | `ctr.contract.returned.v1` |
| IN_REVIEW | `recordContractSigning` | SIGNED | `contract.sign` (DoA) | khác người lập; tài liệu sạch; không xung đột chưa xử lý | `ctr.contract.signed.v1` |
| SIGNED | `post_contracts_id_activate` | ACTIVE | `contract.activate` | bảo lãnh thực hiện; cổng PMT; CAP COMMIT | `ctr.contract.activated.v1`, `ctr.commitment.changed.v1` |
| ACTIVE | `suspendContract` | SUSPENDED | `contract.suspend` | lý do + văn bản (CHECK `contract_status_reason_chk`) | `ctr.contract.suspended.v1` |
| SUSPENDED | `resumeContract` | ACTIVE | `contract.suspend` | văn bản | `ctr.contract.resumed.v1` |
| SIGNED/ACTIVE/SUSPENDED | `terminateContract` | TERMINATED | `contract.terminate` (DoA) | văn bản; khác người đề xuất | `ctr.contract.terminated.v1` |
| ACTIVE | `completeContract` | COMPLETED | `contract.complete` | nghiệm thu hoàn thành APPROVED; không NCR CRITICAL; không khối lượng treo | `ctr.contract.completed.v1` |
| COMPLETED/TERMINATED | `closeContract` | CLOSED | `contract.close` | quyết toán CLOSED; tạm ứng = 0 hoặc ngoại lệ; giữ lại xử lý xong | `ctr.contract.closed.v1` |
| DRAFT/IN_REVIEW | `cancelContractDraft` | CANCELLED | `contract.update` | lý do | `ctr.contract.cancelled.v1` |

Cấm (409 `CONTRACT_STATE_INVALID`): mọi chuyển khác, gồm CLOSED→*, TERMINATED→ACTIVE, CANCELLED→*, SUSPENDED→COMPLETED, SIGNED→COMPLETED. Mỗi chuyển ghi `contract_status_change` (append-only).

| Đối tượng | Chuyển trạng thái (command) | Guard chính / mã lỗi |
|---|---|---|
| ContractRevision | DRAFT → PENDING_EFFECTIVE (CO approve) → EFFECTIVE (job theo `valid_from`) → SUPERSEDED; DRAFT → REJECTED | một EFFECTIVE mỗi hợp đồng (`contract_revision_effective_uq`); `contract_revision_decided_chk` |
| ChangeRequest | DRAFT → SUBMITTED → EVALUATED → APPROVED/REJECTED; EVENT/PCO → PROMOTED; → WITHDRAWN | tầng theo cấu hình; CO APPROVED cần văn bản + effective_on (`change_request_approved_chk`); maker ≠ checker |
| Measurement | DRAFT → SUBMITTED → APPROVED/REJECTED/DRAFT; APPROVED → SUPERSEDED (correct) | `measurement_cumulative_chk`, `measurement_correction_chk`, `measurement_maker_checker_chk` |
| Acceptance | DRAFT → SUBMITTED → APPROVED/REJECTED/DRAFT; APPROVED → REVOKED | QA khi yêu cầu; không NCR CRITICAL; `acceptance_approved_chk`; revoke khi không có claim (`ACCEPTANCE_ALREADY_CLAIMED`) |
| Guarantee | PENDING_VERIFICATION → ACTIVE/REJECTED; ACTIVE → EXPIRED (job) / RELEASED / CALLED / SUPERSEDED (extend) | `guarantee_active_verified_chk`, `guarantee_release_chk` |
| RetentionHold | HELD → PARTIALLY_RELEASED → RELEASED; HELD → FORFEITED (chấm dứt có quyết định) | `retention_hold_release_chk`, điều kiện giải tỏa |
| ContractorPerformance | DRAFT → SUBMITTED → APPROVED; APPROVED → SUPERSEDED (revision mới) | khác người lập (`contractor_performance_checker_chk`) |
| ContractorViolation | RECORDED → CONFIRMED / REVOKED; CONFIRMED → APPEALED | chế tài cần văn bản |

## 5. Quy tắc nghiệp vụ và công thức

- **BR-CTR-01 (trần giá).** `contract_value_vnd ≤ estimate_ceiling_vnd` (giá gói thầu/dự toán được duyệt) tại tạo, sửa và mọi phiên bản; CHECK `contract_estimate_ceiling_chk`.
- **BR-CTR-02 (thành tiền dòng).** `amount_vnd = làm tròn(quantity × unit_price)` theo `rounding_rule` (HALF_UP mặc định; DOWN/UP theo hợp đồng); đơn vị VND nguyên. Ví dụ 3 × 1.234,5 = 3.703,5 → HALF_UP 3.704, DOWN 3.703. Σ `amount_vnd` các dòng của phiên bản = `contract_revision.amount_vnd` (sai lệch 0). Hợp đồng trọn gói: dòng là mốc thanh toán với quantity 1. `ESTIMATE_BASED`: dòng là hạng mục dự toán.
- **BR-CTR-03 (phiên bản áp dụng).** Đơn giá cho nghiệm thu = đơn giá của `boq_line` thuộc phiên bản EFFECTIVE tại ngày nghiệm thu; phiên bản PENDING_EFFECTIVE không dùng. Hồi tố chỉ qua `approveRetroactiveAdjustment` và tạo điều chỉnh mới, không sửa số đã duyệt.
- **BR-CTR-04 (khối lượng lũy kế).** `cum(n) = cum(n−1) + period(n)`, `0 ≤ cum ≤ quantity(boq_item, phiên bản EFFECTIVE)`; giảm chỉ bằng bản điều chỉnh có `correction_of_id` + lý do; bản đã nằm trong nghiệm thu active không được điều chỉnh (`MEASUREMENT_IN_ACTIVE_ACCEPTANCE`).
- **BR-CTR-05 (giá trị nghiệm thu).** `acceptance_line.amount_vnd = làm tròn(quantity × unit_price_snapshot)`; `accepted_amount_vnd = Σ dòng`; sau duyệt: `contract.accepted_total_vnd ≤ contract_value_vnd` (CHECK `contract_ledger_order_chk`).
- **BR-CTR-06 (giảm giá trị hợp đồng).** Giá trị mới sau CO ≥ `accepted_total_vnd` và ≥ `advance_paid + paid_total − advance_recovered`; vi phạm → `ACCEPTANCE_VALUE_EXCEEDS_CONTRACT`.
- **BR-CTR-07 (số tầng thay đổi).** `tier_count ∈ {1,2,3}`; tầng khởi đầu = {3: EVENT, 2: PCO, 1: CO}; khóa ở lần tạo đầu, không đổi được sau đó (trigger `change_chain_config_guard_tg`, mã `CHANGE_TIERS_LOCKED`).
- **BR-CTR-08 (liên danh).** Σ `share_pct` = 100,0000 và Σ `work_value_vnd` = giá trị hợp đồng khi rời DRAFT (constraint trigger deferred); đúng một LEAD/SOLE active.
- **BR-CTR-09 (giữ lại).** Tỷ lệ theo dòng `retention_pct` (mặc định theo rule `CTR.RETENTION` [CXN-EXE-04]); số giữ lại = làm tròn(gross dòng × pct/100) (PAY tính khi gửi). Giải tỏa: `released ≤ held`; điều kiện theo `release_condition`.
- **BR-CTR-10 (bảo lãnh).** Bảo lãnh thực hiện bắt buộc trước khi hiệu lực khi rule yêu cầu; bảo lãnh tạm ứng ≥ số tạm ứng và còn hạn đến khi thu hồi hết (PAY); cảnh báo 30/15/7/0 ngày.
- **BR-CTR-11 (bảng điểm).** `overall = Σ score_i × w_i` (w theo rule `CTR.SCORECARD`; fixture: chất lượng 30%, tiến độ 25%, an toàn–môi trường 20%, hợp tác 10%, tài chính 15%); làm tròn 2 chữ số; xếp hạng [GIẢ ĐỊNH]: ≥ 90 EXCELLENT, ≥ 75 GOOD, ≥ 60 FAIR, < 60 POOR.
- **BR-CTR-12 (xuất CSDL quốc gia).** Tệp gồm mã số thuế nhà thầu, tên, gói thầu, hợp đồng, kỳ, điểm, xếp hạng, vi phạm đã CONFIRMED (loại, mức, ngày, văn bản); chỉ bản APPROVED/CONFIRMED; định dạng cột [CXN-EXE-01].
- **BR-CTR-13 (xung đột lợi ích).** Người thẩm định/ký có khai báo xung đột còn hiệu lực với nhà thầu → chặn; ngoại lệ chỉ khi người khác không xung đột ký và quyết định xử lý được ghi.
- **BR-CTR-14 (cổng giấy phép).** `activate` hợp đồng xây dựng cần cổng `CONTRACT_ACTIVATION`; khối lượng/nhật ký/kiểm tra của hợp đồng xây dựng cần `START_CONSTRUCTION` (PMT).
- **BR-CTR-15 (maker ≠ checker, DoA).** Mọi duyệt kiểm người duyệt khác người lập/nộp và nằm trong hạn mức DoA (ADM) theo giá trị và loại hồ sơ.

## 6. Dữ liệu

Phân hệ CTR sở hữu 16 bảng (7 bảng hiện có được mở rộng, 9 bảng mới). Quy ước chung: khóa chính `(tenant_id, id)`, khóa ngoại tổng hợp `(tenant_id, x_id)`, tiền `numeric(24,0)` VND nguyên, mọi bảng ENABLE + FORCE RLS với policy RESTRICTIVE `tenant_boundary` và PERMISSIVE `tenant_access` (04 §PostgreSQL và RLS). Mọi cột `*_id` có chỉ mục `<bảng>_<cột>_idx ON (tenant_id, <cột>)`. Cột NOT NULL thêm vào bảng hiện có được thêm nullable hoặc có DEFAULT, backfill rồi mới SET NOT NULL (expand-contract).

#### Bảng `contract` (hiện có, mở rộng)
Phân loại: Nội bộ – tài chính. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `project_id`, `package_id`, `contractor_id`, `code`, `type`, `currency`, `status`, `version`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `title` | text | không |  |  | Tên hợp đồng |
| `advance_category` | text | có | 'CONSTRUCTION' | ∈ {CONSTRUCTION, EQUIPMENT, CONSULTING, EPC, LAND_CLEARANCE, OTHER} | Nhóm áp trần tạm ứng [CXN-02] |
| `is_joint_venture` | boolean | có | false |  | Liên danh; thành viên ở contract_party |
| `signed_on` | date | không |  |  | Ngày ký |
| `effective_from` | date | không |  |  | Ngày hợp đồng có hiệu lực |
| `completion_due` | date | không |  |  | Hạn hoàn thành hiện hành |
| `contract_value_vnd` | numeric(24,0) | có | 0 | contract_value_vnd >= 0 | Giá trị hiệu lực hiện hành = contract_revision EFFECTIVE; chỉ đổi qua lệnh |
| `estimate_ceiling_vnd` | numeric(24,0) | không |  | estimate_ceiling_vnd >= 0 | Trần dự toán/giá gói thầu được duyệt (NULL nếu không áp) |
| `current_revision_id` | uuid | không |  | FK contract_revision | Phiên bản hợp đồng đang hiệu lực |
| `accepted_total_vnd` | numeric(24,0) | có | 0 | accepted_total_vnd >= 0 | Tổng giá trị nghiệm thu đã duyệt (lũy kế) |
| `requested_total_vnd` | numeric(24,0) | có | 0 | requested_total_vnd >= 0 | Tổng đề nghị thanh toán còn hiệu lực (gộp) |
| `paid_total_vnd` | numeric(24,0) | có | 0 | paid_total_vnd >= 0 | Tổng giá trị đã thanh toán (gộp, đã được Kho bạc xác nhận) |
| `advance_paid_vnd` | numeric(24,0) | có | 0 | advance_paid_vnd >= 0 | Tổng tạm ứng đã chi |
| `advance_recovered_vnd` | numeric(24,0) | có | 0 | advance_recovered_vnd >= 0 | Tổng tạm ứng đã thu hồi |
| `advance_outstanding_vnd` | numeric(24,0) | không |  | sinh: advance_paid_vnd - advance_recovered_vnd | Tạm ứng còn lại (cột sinh) |
| `retention_held_vnd` | numeric(24,0) | có | 0 | retention_held_vnd >= 0 | Giữ lại lũy kế |
| `retention_released_vnd` | numeric(24,0) | có | 0 | retention_released_vnd >= 0 | Đã giải tỏa lũy kế |
| `requires_quality_acceptance` | boolean | có | true |  | Nghiệm thu khối lượng cần biên bản nghiệm thu chất lượng QMS |
| `status_reason` | text | không |  |  | Lý do chuyển trạng thái gần nhất (bắt buộc với SUSPENDED/TERMINATED) |
| `status_decision_document_version_id` | uuid | không |  | FK document_version | Văn bản căn cứ tạm dừng/chấm dứt |
| `suspended_from` | date | không |  |  |  |
| `terminated_on` | date | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `contract_ledger_order_chk`: accepted_total_vnd <= contract_value_vnd AND requested_total_vnd <= accepted_total_vnd AND paid_total_vnd <= requested_total_vnd
- CHECK `contract_advance_order_chk`: advance_recovered_vnd <= advance_paid_vnd
- CHECK `contract_cash_out_chk`: advance_paid_vnd + paid_total_vnd - advance_recovered_vnd <= contract_value_vnd
- CHECK `contract_retention_order_chk`: retention_released_vnd <= retention_held_vnd
- CHECK `contract_estimate_ceiling_chk`: estimate_ceiling_vnd IS NULL OR contract_value_vnd <= estimate_ceiling_vnd
- CHECK `contract_effective_dates_chk`: status NOT IN ('ACTIVE','SUSPENDED','COMPLETED','CLOSED') OR (signed_on IS NOT NULL AND effective_from IS NOT NULL)
- CHECK `contract_value_signed_chk`: status IN ('DRAFT','IN_REVIEW','CANCELLED') OR contract_value_vnd > 0
- CHECK `contract_status_reason_chk`: status NOT IN ('SUSPENDED','TERMINATED') OR (status_reason IS NOT NULL AND status_decision_document_version_id IS NOT NULL)
- UNIQUE INDEX `contract_code_uq` (tenant_id, code)

Chỉ mục: `contract_current_revision_id_idx`, `contract_status_decision_document_version_id_idx`, `contract_project_id_idx`, `contract_package_id_idx`, `contract_contractor_id_idx`, `contract_project_status_idx`, `contract_status_due_idx`.

#### Bảng `contract_revision` (hiện có, mở rộng)
Phân loại: Nội bộ – tài chính. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `contract_id`, `revision`, `amount_vnd`, `document_version_id`, `valid_from`, `valid_until`, `status`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `kind` | text | có | 'BASE' | ∈ {BASE, AMENDMENT, CHANGE_ORDER} |  |
| `change_request_id` | uuid | không |  | FK change_request | CO phát sinh phiên bản này |
| `supersedes_id` | uuid | không |  | FK contract_revision |  |
| `retroactive` | boolean | có | false |  | Phiên bản hồi tố — chỉ qua lệnh điều chỉnh hồi tố riêng |
| `decided_by` | uuid | không |  |  |  |
| `decided_at` | timestamptz | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `contract_revision_amount_chk`: amount_vnd >= 0
- CHECK `contract_revision_decided_chk`: status NOT IN ('PENDING_EFFECTIVE','EFFECTIVE','SUPERSEDED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
- UNIQUE INDEX `contract_revision_no_uq` (tenant_id, contract_id, revision)
- UNIQUE INDEX `contract_revision_effective_uq` (tenant_id, contract_id) WHERE status = 'EFFECTIVE'

Chỉ mục: `contract_revision_change_request_id_idx`, `contract_revision_supersedes_id_idx`, `contract_revision_contract_id_idx`, `contract_revision_document_version_id_idx`.

#### Bảng `boq_item` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `business_key` | text | có |  |  | Mã dòng ổn định xuyên các phiên bản hợp đồng |
| `description` | text | có |  |  |  |
| `unit_code` | text | có |  |  |  |
| `status` | text | có | 'ACTIVE' | ∈ {ACTIVE, CANCELLED} |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- UNIQUE INDEX `boq_item_key_uq` (tenant_id, contract_id, business_key)

Chỉ mục: `boq_item_contract_id_idx`.

#### Bảng `boq_line` (hiện có, mở rộng)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `contract_revision_id`, `business_key`, `description`, `unit_code`, `quantity`, `unit_price`, `rounding_rule`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `boq_item_id` | uuid | không |  | FK boq_item | Định danh dòng ổn định (khóa sổ lũy kế) |
| `contract_id` | uuid | không |  | FK contract |  |
| `line_no` | integer | không |  |  |  |
| `amount_vnd` | numeric(24,0) | có | 0 | amount_vnd >= 0 | Thành tiền = làm tròn(quantity × unit_price) theo rounding_rule |
| `retention_pct` | numeric(7,4) | có | 0 | retention_pct BETWEEN 0 AND 100 | Tỷ lệ giữ lại của dòng (%) |
| `milestone_code` | text | không |  |  | Mốc thanh toán |
| `milestone_due_on` | date | không |  |  |  |
| `party_id` | uuid | không |  | FK contract_party | Thành viên liên danh thực hiện dòng |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `boq_line_nonneg_chk`: quantity >= 0 AND unit_price >= 0
- UNIQUE INDEX `boq_line_revision_key_uq` (tenant_id, contract_revision_id, business_key)

Chỉ mục: `boq_line_boq_item_id_idx`, `boq_line_contract_id_idx`, `boq_line_party_id_idx`, `boq_line_contract_revision_id_idx`, `boq_line_item_revision_idx`.

#### Bảng `contract_party` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `contractor_id` | uuid | có |  | FK contractor |  |
| `role` | text | có |  | ∈ {SOLE, LEAD, MEMBER} |  |
| `share_pct` | numeric(7,4) | có |  | share_pct > 0 AND share_pct <= 100 | Tỷ lệ phần việc; tổng = 100 (constraint trigger deferred) |
| `work_value_vnd` | numeric(24,0) | có |  | work_value_vnd >= 0 | Giá trị phần việc của thành viên (mẫu số ngưỡng thu hồi 80%) |
| `status` | text | có | 'ACTIVE' | ∈ {ACTIVE, WITHDRAWN} |  |
| `valid_from` | date | có |  |  |  |
| `valid_until` | date | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- UNIQUE INDEX `contract_party_member_uq` (tenant_id, contract_id, contractor_id)
- UNIQUE INDEX `contract_party_lead_uq` (tenant_id, contract_id) WHERE role IN ('LEAD','SOLE') AND status = 'ACTIVE'

Chỉ mục: `contract_party_contract_id_idx`, `contract_party_contractor_id_idx`.

#### Bảng `contract_status_change` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa. Bảng append-only: `REVOKE UPDATE, DELETE` cho runtime; sửa sai chỉ bằng bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `from_status` | text | có |  |  |  |
| `to_status` | text | có |  |  |  |
| `reason` | text | có |  |  |  |
| `decision_document_version_id` | uuid | không |  | FK document_version |  |
| `effective_on` | date | có |  |  |  |
| `command` | text | có |  |  | Tên command đã chạy |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |

Bất biến DB:
- CHECK `contract_status_change_diff_chk`: from_status <> to_status

Chỉ mục: `contract_status_change_contract_id_idx`, `contract_status_change_decision_document_version_id_idx`.

#### Bảng `guarantee` (hiện có, mở rộng)
Phân loại: Nội bộ – tài chính. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `contract_id`, `kind`, `issuer`, `amount_vnd`, `expires_at`, `verification_status`, `release_evidence_id`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `guarantee_no` | text | không |  |  | Số bảo lãnh/bảo hiểm |
| `party_id` | uuid | không |  | FK contract_party | Thành viên liên danh được bảo lãnh |
| `currency` | char(3) | có | 'VND' | ∈ {VND} |  |
| `valid_from` | date | không |  |  |  |
| `status` | text | có | 'PENDING_VERIFICATION' | ∈ {PENDING_VERIFICATION, ACTIVE, EXPIRED, RELEASED, CALLED, SUPERSEDED, REJECTED} |  |
| `document_version_id` | uuid | không |  | FK document_version | Bản bảo lãnh |
| `extended_from_id` | uuid | không |  | FK guarantee | Bảo lãnh được gia hạn/thay thế |
| `last_alert_days` | integer | không |  |  | Ngưỡng cảnh báo gần nhất đã gửi (30/15/7/0) để khử trùng |
| `released_at` | timestamptz | không |  |  |  |
| `released_by` | uuid | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `guarantee_amount_chk`: amount_vnd > 0
- CHECK `guarantee_release_chk`: status <> 'RELEASED' OR (release_evidence_id IS NOT NULL AND released_at IS NOT NULL)
- CHECK `guarantee_active_verified_chk`: status <> 'ACTIVE' OR verification_status = 'VERIFIED'
- UNIQUE INDEX `guarantee_issuer_no_uq` (tenant_id, issuer, guarantee_no) WHERE guarantee_no IS NOT NULL

Chỉ mục: `guarantee_party_id_idx`, `guarantee_document_version_id_idx`, `guarantee_extended_from_id_idx`, `guarantee_contract_id_idx`, `guarantee_release_evidence_id_idx`, `guarantee_expiry_idx`.

#### Bảng `change_chain_config` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `project_id` | uuid | có |  | FK project |  |
| `tier_count` | smallint | có |  | ∈ {1, 2, 3} | 1 = chỉ CO; 2 = PCO→CO; 3 = ChangeEvent→PCO→CO |
| `locked_at` | timestamptz | không |  |  | Khóa sau lần dùng đầu |
| `locked_by_change_id` | uuid | không |  | FK change_request |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `change_chain_config_lock_chk`: locked_at IS NULL OR locked_by_change_id IS NOT NULL
- UNIQUE INDEX `change_chain_config_project_uq` (tenant_id, project_id)
- TRIGGER bảo vệ (xem SQL): change_chain_config_guard_tg

Chỉ mục: `change_chain_config_project_id_idx`, `change_chain_config_locked_by_change_id_idx`.

#### Bảng `change_request` (hiện có, mở rộng)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `contract_id`, `baseline_revision_id`, `amount_delta_vnd`, `schedule_impact_days`, `reason`, `status`, `version`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `code` | text | không |  |  | Mã theo hợp đồng |
| `stage` | text | có | 'CO' | ∈ {EVENT, PCO, CO} | Tầng trong chuỗi ChangeEvent→PCO→CO |
| `parent_id` | uuid | không |  | FK change_request | Tầng trước đã được promote |
| `event_kind` | text | không |  | ∈ {OWNER_INSTRUCTION, DESIGN_CHANGE, SITE_CONDITION, FORCE_MAJEURE, LEGAL_CHANGE, QUANTITY_VARIANCE, OTHER} |  |
| `estimated_delta_vnd` | numeric(24,0) | không |  |  | Ước tính ở tầng ChangeEvent |
| `evaluated_delta_vnd` | numeric(24,0) | không |  |  | Giá trị đã thẩm định ở tầng PCO |
| `approved_delta_vnd` | numeric(24,0) | không |  |  | Giá trị được duyệt ở tầng CO |
| `effective_on` | date | không |  |  | Ngày hiệu lực của CO |
| `retroactive` | boolean | có | false |  |  |
| `resulting_revision_id` | uuid | không |  | FK contract_revision |  |
| `decision_document_version_id` | uuid | không |  | FK document_version |  |
| `submitted_by` | uuid | không |  |  |  |
| `decided_by` | uuid | không |  |  |  |
| `decided_at` | timestamptz | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `change_request_approved_chk`: status <> 'APPROVED' OR (stage = 'CO' AND decision_document_version_id IS NOT NULL AND effective_on IS NOT NULL AND approved_delta_vnd IS NOT NULL AND decided_by IS NOT NULL)
- CHECK `change_request_maker_checker_chk`: decided_by IS NULL OR submitted_by IS NULL OR decided_by <> submitted_by
- UNIQUE INDEX `change_request_code_uq` (tenant_id, contract_id, code) WHERE code IS NOT NULL

Chỉ mục: `change_request_parent_id_idx`, `change_request_resulting_revision_id_idx`, `change_request_decision_document_version_id_idx`, `change_request_contract_id_idx`, `change_request_baseline_revision_id_idx`.

#### Bảng `measurement` (hiện có, mở rộng)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `contract_revision_id`, `boq_line_id`, `period_id`, `quantity_period`, `quantity_cumulative`, `revision`, `status`, `evidence_refs`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `contract_id` | uuid | không |  | FK contract |  |
| `boq_item_id` | uuid | không |  | FK boq_item |  |
| `party_id` | uuid | không |  | FK contract_party |  |
| `reference_no` | text | không |  |  | Số hồ sơ/biên bản khối lượng của nhà thầu (phát hiện trùng) |
| `duplicate_override_reason` | text | không |  |  | Căn cứ cho phép trùng reference_no |
| `correction_of_id` | uuid | không |  | FK measurement | Bản được điều chỉnh |
| `correction_reason` | text | không |  |  |  |
| `inspection_id` | uuid | không |  | FK inspection | Kiểm tra QMS liên quan |
| `submitted_by` | uuid | không |  |  |  |
| `submitted_at` | timestamptz | không |  |  |  |
| `decided_by` | uuid | không |  |  |  |
| `decided_at` | timestamptz | không |  |  |  |
| `version` | bigint | có | 1 |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `measurement_cumulative_chk`: quantity_cumulative >= 0 AND (quantity_period >= 0 OR correction_of_id IS NOT NULL)
- CHECK `measurement_correction_chk`: (correction_of_id IS NULL) = (correction_reason IS NULL)
- CHECK `measurement_decided_chk`: status NOT IN ('APPROVED','REJECTED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
- CHECK `measurement_maker_checker_chk`: decided_by IS NULL OR submitted_by IS NULL OR decided_by <> submitted_by
- UNIQUE INDEX `measurement_revision_uq` (tenant_id, contract_revision_id, boq_line_id, period_id, revision)
- UNIQUE INDEX `measurement_reference_uq` (tenant_id, contract_id, reference_no) WHERE reference_no IS NOT NULL AND duplicate_override_reason IS NULL AND status <> 'SUPERSEDED'

Chỉ mục: `measurement_contract_id_idx`, `measurement_boq_item_id_idx`, `measurement_party_id_idx`, `measurement_correction_of_id_idx`, `measurement_inspection_id_idx`, `measurement_contract_revision_id_idx`, `measurement_boq_line_id_idx`, `measurement_period_id_idx`, `measurement_contract_status_idx`.

#### Bảng `acceptance` (hiện có, mở rộng)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `contract_id`, `measurement_ids`, `document_version_id`, `approved_at`, `signer_refs`, `status`, `version`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `acceptance_no` | text | không |  |  | Số biên bản |
| `period_id` | uuid | không |  | FK reporting_period |  |
| `accepted_amount_vnd` | numeric(24,0) | có | 0 | accepted_amount_vnd >= 0 | Σ acceptance_line.amount_vnd, khóa khi APPROVED |
| `quality_acceptance_id` | uuid | không |  | FK quality_acceptance | Biên bản nghiệm thu chất lượng QMS (nếu hợp đồng yêu cầu) |
| `submitted_by` | uuid | không |  |  |  |
| `decided_by` | uuid | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `acceptance_approved_chk`: status <> 'APPROVED' OR (approved_at IS NOT NULL AND accepted_amount_vnd > 0 AND decided_by IS NOT NULL)
- CHECK `acceptance_maker_checker_chk`: decided_by IS NULL OR submitted_by IS NULL OR decided_by <> submitted_by
- UNIQUE INDEX `acceptance_no_uq` (tenant_id, contract_id, acceptance_no) WHERE acceptance_no IS NOT NULL

Chỉ mục: `acceptance_period_id_idx`, `acceptance_quality_acceptance_id_idx`, `acceptance_contract_id_idx`, `acceptance_document_version_id_idx`.

#### Bảng `acceptance_line` (mới)
Phân loại: Nội bộ. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `acceptance_id` | uuid | có |  | FK acceptance |  |
| `measurement_id` | uuid | có |  | FK measurement |  |
| `boq_item_id` | uuid | có |  | FK boq_item |  |
| `party_id` | uuid | không |  | FK contract_party |  |
| `contract_revision_id` | uuid | có |  | FK contract_revision | Phiên bản hợp đồng hiệu lực tại ngày nghiệm thu |
| `quantity` | numeric(24,6) | có |  | quantity > 0 |  |
| `unit_price_snapshot` | numeric(24,6) | có |  | unit_price_snapshot >= 0 |  |
| `amount_vnd` | numeric(24,0) | có |  | amount_vnd > 0 | làm tròn(quantity × unit_price_snapshot) theo rounding_rule của dòng |
| `retention_pct_snapshot` | numeric(7,4) | có | 0 |  |  |
| `active` | boolean | có | true |  | false khi nghiệm thu bị REVOKED |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- UNIQUE INDEX `acceptance_line_measurement_uq` (tenant_id, measurement_id) WHERE active
- UNIQUE INDEX `acceptance_line_key_uq` (tenant_id, acceptance_id, boq_item_id, party_id) NULLS NOT DISTINCT

Chỉ mục: `acceptance_line_acceptance_id_idx`, `acceptance_line_measurement_id_idx`, `acceptance_line_boq_item_id_idx`, `acceptance_line_party_id_idx`, `acceptance_line_contract_revision_id_idx`.

#### Bảng `retention_hold` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `boq_item_id` | uuid | có |  | FK boq_item |  |
| `acceptance_id` | uuid | có |  | FK acceptance |  |
| `payment_request_id` | uuid | có |  | FK payment_request |  |
| `party_id` | uuid | không |  | FK contract_party |  |
| `held_vnd` | numeric(24,0) | có |  | held_vnd > 0 |  |
| `released_vnd` | numeric(24,0) | có | 0 | released_vnd >= 0 |  |
| `release_condition` | text | có |  | ∈ {WARRANTY_END, COMPLETION, MANUAL_DECISION} |  |
| `release_not_before` | date | không |  |  |  |
| `status` | text | có | 'HELD' | ∈ {HELD, PARTIALLY_RELEASED, RELEASED, FORFEITED} |  |
| `released_by` | uuid | không |  |  |  |
| `released_at` | timestamptz | không |  |  |  |
| `release_reason` | text | không |  |  |  |
| `release_decision_document_version_id` | uuid | không |  | FK document_version |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `retention_hold_release_chk`: released_vnd <= held_vnd
- CHECK `retention_hold_status_chk`: (status = 'RELEASED') = (released_vnd = held_vnd)
- CHECK `retention_hold_release_audit_chk`: released_vnd = 0 OR (released_by IS NOT NULL AND release_reason IS NOT NULL)
- UNIQUE INDEX `retention_hold_line_uq` (tenant_id, payment_request_id, boq_item_id, party_id) NULLS NOT DISTINCT

Chỉ mục: `retention_hold_contract_id_idx`, `retention_hold_boq_item_id_idx`, `retention_hold_acceptance_id_idx`, `retention_hold_payment_request_id_idx`, `retention_hold_party_id_idx`, `retention_hold_release_decision_document_version_id_idx`, `retention_hold_due_idx`.

#### Bảng `contractor_performance` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `contractor_id` | uuid | có |  | FK contractor |  |
| `evaluation_kind` | text | có |  | ∈ {PERIODIC, COMPLETION, TERMINATION} |  |
| `period_label` | text | có |  |  | Ví dụ 2026-Q2 |
| `revision` | integer | có | 1 | revision > 0 |  |
| `score_quality` | smallint | có |  | score_quality BETWEEN 0 AND 100 |  |
| `score_schedule` | smallint | có |  | score_schedule BETWEEN 0 AND 100 |  |
| `score_safety_env` | smallint | có |  | score_safety_env BETWEEN 0 AND 100 |  |
| `score_cooperation` | smallint | có |  | score_cooperation BETWEEN 0 AND 100 |  |
| `score_financial` | smallint | có |  | score_financial BETWEEN 0 AND 100 |  |
| `overall_score` | numeric(5,2) | có |  | overall_score BETWEEN 0 AND 100 | Trung bình có trọng số theo rule version |
| `rating` | text | có |  | ∈ {EXCELLENT, GOOD, FAIR, POOR} |  |
| `weights_rule_version_id` | uuid | không |  |  | Tham chiếu rule registry (kernel) — logical ref |
| `remarks` | text | không |  |  |  |
| `status` | text | có | 'DRAFT' | ∈ {DRAFT, SUBMITTED, APPROVED, SUPERSEDED} |  |
| `evaluated_by` | uuid | có |  |  |  |
| `approved_by` | uuid | không |  |  |  |
| `approved_at` | timestamptz | không |  |  |  |
| `supersedes_id` | uuid | không |  | FK contractor_performance |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `contractor_performance_checker_chk`: approved_by IS NULL OR approved_by <> evaluated_by
- CHECK `contractor_performance_approved_chk`: status <> 'APPROVED' OR approved_at IS NOT NULL
- UNIQUE INDEX `contractor_performance_rev_uq` (tenant_id, contract_id, evaluation_kind, period_label, revision)

Chỉ mục: `contractor_performance_contract_id_idx`, `contractor_performance_contractor_id_idx`, `contractor_performance_weights_rule_version_id_idx`, `contractor_performance_supersedes_id_idx`.

#### Bảng `contractor_violation` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `contractor_id` | uuid | có |  | FK contractor |  |
| `violation_kind` | text | có |  | ∈ {DELAY, QUALITY, SAFETY, ENVIRONMENT, FALSE_DOCUMENT, ABANDONMENT, OTHER} |  |
| `severity` | text | có |  | ∈ {MINOR, MAJOR, CRITICAL} |  |
| `occurred_on` | date | có |  |  |  |
| `description` | text | có |  |  |  |
| `evidence_document_version_id` | uuid | không |  | FK document_version |  |
| `penalty_kind` | text | có | 'NONE' | ∈ {NONE, WARNING, LIQUIDATED_DAMAGES, TERMINATION, DEBARMENT_PROPOSAL} |  |
| `penalty_amount_vnd` | numeric(24,0) | có | 0 |  |  |
| `decision_document_version_id` | uuid | không |  | FK document_version |  |
| `source_module` | text | có | 'CTR' | ∈ {CTR, QMS, PAY, ISS, AUD} |  |
| `source_ref_id` | uuid | không |  |  |  |
| `status` | text | có | 'RECORDED' | ∈ {RECORDED, CONFIRMED, APPEALED, REVOKED} |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `contractor_violation_penalty_chk`: penalty_kind = 'NONE' OR decision_document_version_id IS NOT NULL OR status = 'RECORDED'

Chỉ mục: `contractor_violation_contract_id_idx`, `contractor_violation_contractor_id_idx`, `contractor_violation_evidence_document_version_id_idx`, `contractor_violation_decision_document_version_id_idx`, `contractor_violation_source_ref_id_idx`, `contractor_violation_contractor_date_idx`.

#### Bảng `contractor_export_batch` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `scope` | text | có |  | ∈ {PERFORMANCE, VIOLATION, BOTH} |  |
| `period_from` | date | có |  |  |  |
| `period_to` | date | có |  |  |  |
| `format` | text | có |  | ∈ {CSV, JSON} |  |
| `file_sha256` | char(64) | có |  |  |  |
| `file_object_key` | text | có |  |  |  |
| `row_count` | integer | có |  | row_count >= 0 |  |
| `status` | text | có | 'GENERATED' | ∈ {GENERATED, SUBMITTED_EXTERNALLY, CONFIRMED, FAILED} |  |
| `submitted_ref` | text | không |  |  | Mã biên nhận từ hệ thống quốc gia (nhập tay) |
| `submitted_on` | date | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |

Bất biến DB:
- CHECK `contractor_export_period_chk`: period_from <= period_to
- UNIQUE INDEX `contractor_export_file_uq` (tenant_id, scope, period_from, period_to, file_sha256)

Chỉ mục: .


## 7. API / command

Mọi lệnh ghi: `Idempotency-Key` (≥16 ký tự) bắt buộc; `If-Match` bắt buộc khi đổi bản ghi có version (cột "If-Match" = có); lỗi trả RFC 7807 Problem với `code` ổn định; DTO là allowlist (trường thừa → 400 INVALID_REQUEST); không có endpoint ghi chung cho `status`, `tenant_id`, role hoặc số tiền đã chốt. Mã lỗi chung ngoài bảng: 401 SESSION_EXPIRED, 403 SCOPE_DENIED, 404 RESOURCE_NOT_FOUND, 409 IDEMPOTENCY_CONFLICT, 422 VALIDATION_FAILED, 429 RATE_LIMIT, 503 PROVIDER_UNAVAILABLE.

| operationId | Method path | Quyền (x-permission) | Request DTO (trường được phép; * = bắt buộc) | Response | Lỗi (HTTP + code) | Idempotency | If-Match |
|---|---|---|---|---|---|---|---|
| `createContract` | `POST /contracts` | `contract.create` | project_id*, package_id*, contractor_id*, code*, title*, type*, advance_category*, is_joint_venture, requires_quality_acceptance, contract_value_vnd*, estimate_ceiling_vnd, completion_due, document_version_id* | CommandResult | 409 CONTRACT_CODE_DUPLICATE; 422 PACKAGE_NOT_AWARDED; 422 CONTRACT_VALUE_EXCEEDS_CEILING; 422 CAPITAL_PLAN_NOT_APPROVED; 422 CONTRACTOR_NOT_VERIFIED; 403 SCOPE_DENIED; 422 VALIDATION_FAILED | bắt buộc | không |
| `reviseContractDraft` | `POST /contracts/{id}/draft` | `contract.update` | title, completion_due, contract_value_vnd, estimate_ceiling_vnd, requires_quality_acceptance, document_version_id | CommandResult | 409 CONTRACT_STATE_INVALID; 422 CONTRACT_VALUE_EXCEEDS_CEILING; 409 VERSION_CONFLICT; 422 VALIDATION_FAILED | bắt buộc | có |
| `replaceContractParties` | `POST /contracts/{id}/parties` | `contract.update` | parties* | CommandResult | 409 CONTRACT_STATE_INVALID; 422 JV_SHARE_NOT_100; 422 CONTRACTOR_NOT_VERIFIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `cancelContractDraft` | `POST /contracts/{id}/cancel` | `contract.update` | reason* | CommandResult | 409 CONTRACT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `submitContractForReview` | `POST /contracts/{id}/submit-review` | `contract.review.submit` | note | CommandResult | 409 CONFLICT_OF_INTEREST_BLOCKED; 422 CONTRACT_VALUE_EXCEEDS_CEILING; 422 CAPITAL_PLAN_NOT_APPROVED; 422 BOQ_TOTAL_MISMATCH; 422 JV_SHARE_NOT_100; 409 CONTRACT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `returnContractDraft` | `POST /contracts/{id}/return` | `contract.review.decide` | reason* | CommandResult | 409 CONTRACT_STATE_INVALID; 403 SELF_APPROVAL_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `recordContractSigning` | `POST /contracts/{id}/sign` | `contract.sign` | signed_on*, signed_document_version_id*, conflict_decision_ref | CommandResult | 409 CONFLICT_OF_INTEREST_BLOCKED; 403 SELF_APPROVAL_DENIED; 422 DOCUMENT_NOT_CLEAN; 409 CONTRACT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `post_contracts_id_activate` | `POST /contracts/{id}/activate` | `contract.activate` | decision*, reason*, evidence_ids*, effective_from*, note | CommandResult | 422 PERFORMANCE_GUARANTEE_MISSING; 409 PERMIT_GATE_BLOCKED; 422 FUND_COMMIT_FAILED; 422 PROJECT_STAGE_INVALID; 409 CONTRACT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `suspendContract` | `POST /contracts/{id}/suspend` | `contract.suspend` | reason*, decision_document_version_id*, suspended_from* | CommandResult | 409 CONTRACT_STATE_INVALID; 422 DECISION_DOCUMENT_REQUIRED; 409 VERSION_CONFLICT | bắt buộc | có |
| `resumeContract` | `POST /contracts/{id}/resume` | `contract.suspend` | reason*, decision_document_version_id*, resumed_on*, extension_days | CommandResult | 409 CONTRACT_STATE_INVALID; 422 DECISION_DOCUMENT_REQUIRED; 409 VERSION_CONFLICT | bắt buộc | có |
| `terminateContract` | `POST /contracts/{id}/terminate` | `contract.terminate` | reason*, decision_document_version_id*, terminated_on*, guarantee_action* | CommandResult | 409 CONTRACT_STATE_INVALID; 422 DECISION_DOCUMENT_REQUIRED; 403 SELF_APPROVAL_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `completeContract` | `POST /contracts/{id}/complete` | `contract.complete` | completion_quality_acceptance_id*, completed_on* | CommandResult | 422 COMPLETION_ACCEPTANCE_REQUIRED; 422 OPEN_CRITICAL_NCR; 422 MEASUREMENT_PENDING; 409 CONTRACT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `closeContract` | `POST /contracts/{id}/close` | `contract.close` | settlement_revision_id*, note | CommandResult | 422 SETTLEMENT_NOT_CLOSED; 422 ADVANCE_OUTSTANDING; 422 RETENTION_UNRESOLVED; 409 CONTRACT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `importBoqLines` | `POST /contract-revisions/{id}/boq-lines` | `boq.manage` | mode*, file_sha256, lines* | CommandResult | 422 REVISION_NOT_DRAFT; 409 BOQ_LINE_DUPLICATE; 422 BOQ_TOTAL_MISMATCH; 422 VALIDATION_FAILED; 409 VERSION_CONFLICT | bắt buộc | có |
| `registerGuarantee` | `POST /contracts/{id}/guarantees` | `guarantee.manage` | kind*, party_id, issuer*, guarantee_no*, amount_vnd*, valid_from*, expires_at*, document_version_id* | CommandResult | 409 GUARANTEE_DUPLICATE; 409 CONTRACT_STATE_INVALID; 422 VALIDATION_FAILED | bắt buộc | không |
| `verifyGuarantee` | `POST /guarantees/{id}/verify` | `guarantee.verify` | outcome*, method*, evidence_document_version_id* | CommandResult | 403 SELF_APPROVAL_DENIED; 409 GUARANTEE_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `extendGuarantee` | `POST /guarantees/{id}/extend` | `guarantee.manage` | new_expires_at*, new_guarantee_no*, document_version_id* | CommandResult | 409 GUARANTEE_STATE_INVALID; 422 VALIDATION_FAILED; 409 VERSION_CONFLICT | bắt buộc | có |
| `releaseGuarantee` | `POST /guarantees/{id}/release` | `guarantee.release` | release_evidence_id*, reason* | CommandResult | 409 GUARANTEE_STATE_INVALID; 422 RELEASE_CONDITION_NOT_MET; 403 SELF_APPROVAL_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `setChangeChainTiers` | `POST /projects/{id}/change-chain-config` | `change.tiers.configure` | tier_count* | CommandResult | 409 CHANGE_TIERS_LOCKED; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | không |
| `createChangeRequest` | `POST /contracts/{id}/change-requests` | `change.manage` | stage*, baseline_revision_id*, event_kind, reason*, estimated_delta_vnd, schedule_impact_days | CommandResult | 422 CHANGE_STAGE_NOT_ALLOWED; 409 CONTRACT_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | không |
| `promoteChangeRequest` | `POST /change-requests/{id}/promote` | `change.manage` | reason* | CommandResult | 422 CHANGE_STAGE_NOT_ALLOWED; 409 CHANGE_STATE_INVALID; 409 CONTRACT_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `evaluateChangeRequest` | `POST /change-requests/{id}/evaluate` | `change.evaluate` | evaluated_delta_vnd*, schedule_impact_days*, funding_impact_note*, scope_impact_note, allocation_line_id | CommandResult | 422 CHANGE_STAGE_NOT_ALLOWED; 409 CHANGE_STATE_INVALID; 409 CONTRACT_STATE_INVALID; 422 ALLOCATION_UNAVAILABLE; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `post_contract_changes_id_decision` | `POST /contract-changes/{id}/decision` | `contract.change.approve` | decision*, reason*, evidence_ids*, approved_delta_vnd, effective_on, decision_document_version_id | CommandResult | 403 SELF_APPROVAL_DENIED; 409 CHANGE_STATE_INVALID; 422 RETROACTIVE_NOT_ALLOWED; 422 DECISION_DOCUMENT_REQUIRED; 422 ALLOCATION_UNAVAILABLE; 409 VERSION_CONFLICT | bắt buộc | có |
| `withdrawChangeRequest` | `POST /change-requests/{id}/withdraw` | `change.manage` | reason* | CommandResult | 409 CHANGE_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `approveRetroactiveAdjustment` | `POST /change-requests/{id}/retroactive-adjustment` | `change.retroactive.approve` | adjustment_basis*, decision_document_version_id*, affected_acceptance_ids* | CommandResult | 409 SETTLEMENT_ALREADY_APPROVED; 403 SELF_APPROVAL_DENIED; 409 CHANGE_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `recordMeasurement` | `POST /contracts/{id}/measurements` | `measurement.record` | contract_revision_id*, boq_item_id*, party_id, period_id*, quantity_period*, reference_no*, duplicate_override_reason, evidence_refs*, inspection_id | CommandResult | 409 MEASUREMENT_REFERENCE_DUPLICATE; 422 REVISION_NOT_EFFECTIVE; 422 QUANTITY_EXCEEDS_BOQ; 422 CUMULATIVE_DECREASE_WITHOUT_CORRECTION; 409 CONTRACT_STATE_INVALID; 409 PERMIT_GATE_BLOCKED; 422 VALIDATION_FAILED | bắt buộc | không |
| `submitMeasurement` | `POST /measurements/{id}/submit` | `measurement.submit` | note | CommandResult | 409 MEASUREMENT_STATE_INVALID; 422 EVIDENCE_REQUIRED; 409 VERSION_CONFLICT | bắt buộc | có |
| `post_measurements_id_decision` | `POST /measurements/{id}/decision` | `measurement.approve` | decision*, reason*, evidence_ids* (schema Decision dùng chung) | CommandResult | 403 SELF_APPROVAL_DENIED; 409 MEASUREMENT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `correctMeasurement` | `POST /measurements/{id}/correct` | `measurement.correct` | quantity_period*, correction_reason*, evidence_refs* | CommandResult | 422 MEASUREMENT_IN_ACTIVE_ACCEPTANCE; 409 MEASUREMENT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `createAcceptance` | `POST /contracts/{id}/acceptances` | `acceptance.create` | measurement_ids*, period_id*, document_version_id*, quality_acceptance_id | CommandResult | 422 MEASUREMENT_NOT_APPROVED; 409 MEASUREMENT_ALREADY_ACCEPTED; 422 QUALITY_ACCEPTANCE_REQUIRED; 409 CONTRACT_STATE_INVALID; 422 VALIDATION_FAILED | bắt buộc | không |
| `submitAcceptance` | `POST /acceptances/{id}/submit` | `acceptance.submit` | signer_refs* | CommandResult | 409 ACCEPTANCE_STATE_INVALID; 422 QUALITY_ACCEPTANCE_REQUIRED; 409 VERSION_CONFLICT | bắt buộc | có |
| `post_acceptances_id_decision` | `POST /acceptances/{id}/decision` | `acceptance.approve` | decision*, reason*, evidence_ids* (schema Decision dùng chung) | CommandResult | 403 SELF_APPROVAL_DENIED; 422 ACCEPTANCE_VALUE_EXCEEDS_CONTRACT; 422 QUALITY_ACCEPTANCE_REQUIRED; 422 OPEN_CRITICAL_NCR; 409 ACCEPTANCE_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `revokeAcceptance` | `POST /acceptances/{id}/revoke` | `acceptance.revoke` | reason*, approval_document_version_id* | CommandResult | 409 ACCEPTANCE_ALREADY_CLAIMED; 409 ACCEPTANCE_STATE_INVALID; 403 SELF_APPROVAL_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `releaseRetention` | `POST /retention-holds/{id}/release` | `retention.release` | amount_vnd*, reason*, decision_document_version_id | CommandResult | 422 RELEASE_CONDITION_NOT_MET; 422 RELEASE_EXCEEDS_HELD; 403 SELF_APPROVAL_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `evaluateContractor` | `POST /contracts/{id}/performance-evaluations` | `contractor.performance.evaluate` | evaluation_kind*, period_label*, score_quality*, score_schedule*, score_safety_env*, score_cooperation*, score_financial*, remarks | CommandResult | 409 EVALUATION_DUPLICATE; 409 CONTRACT_STATE_INVALID; 422 VALIDATION_FAILED | bắt buộc | không |
| `approveContractorEvaluation` | `POST /performance-evaluations/{id}/approve` | `contractor.performance.approve` | note | CommandResult | 403 SELF_APPROVAL_DENIED; 409 EVALUATION_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `recordContractorViolation` | `POST /contracts/{id}/violations` | `contractor.violation.record` | violation_kind*, severity*, occurred_on*, description*, evidence_document_version_id, source_module, source_ref_id | CommandResult | 422 VALIDATION_FAILED; 409 CONTRACT_STATE_INVALID | bắt buộc | không |
| `confirmContractorViolation` | `POST /violations/{id}/confirm` | `contractor.violation.confirm` | penalty_kind*, penalty_amount_vnd, decision_document_version_id | CommandResult | 422 DECISION_DOCUMENT_REQUIRED; 403 SELF_APPROVAL_DENIED; 409 VIOLATION_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `exportContractorRecords` | `POST /contractor-exports` | `contractor.export` | scope*, period_from*, period_to*, format* | CommandResult | 422 EXPORT_EMPTY; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | không |
| `markContractorExportSubmitted` | `POST /contractor-exports/{id}/mark-submitted` | `contractor.export` | submitted_ref*, submitted_on* | CommandResult | 409 EXPORT_STATE_INVALID; 422 VALIDATION_FAILED | bắt buộc | không |
| `getContractSummary` | `GET /contracts/{id}/summary` | `contract.read` | (không) | DTO đọc (read model) | — | — | không |
| `getChangeChain` | `GET /projects/{id}/change-chain` | `change.read` | contract_id | DTO đọc (read model) | 422 VALIDATION_FAILED | — | không |
| `listExpiringGuarantees` | `GET /guarantees/expiring` | `guarantee.read` | within_days, cursor, limit | DTO đọc (read model) | — | — | không |
| `getContractorScorecard` | `GET /contractors/{id}/scorecard` | `contractor.performance.read` | from, to | DTO đọc (read model) | — | — | không |

Mô tả ngắn từng lệnh (summary OpenAPI) và guard trạng thái nằm ở `openapi.json` (`x-state-guard`, `x-domain-events`, `x-error-codes`).

Rà soát GET scaffold (`x-contract-maturity: reference-scaffolding`) của tài nguyên thuộc phân hệ:

| Tài nguyên | Quyết định | Lý do |
|---|---|---|
| `/resources/contract` (list + get) | DTO riêng | Nhà thầu khách chỉ thấy hợp đồng của mình; ẩn các tổng lũy kế nội bộ với vai trò không có ledger.read. |
| `/resources/contract_revision` (list + get) | giữ (DTO đọc + mask) | Chỉ đọc phiên bản hợp đồng trong phạm vi hợp đồng; không có trường nhạy cảm ngoài giá trị đã được cấp quyền contract.read. |
| `/resources/boq_line` (list + get) | giữ (DTO đọc + mask) | Dòng BOQ chỉ đọc theo phạm vi hợp đồng; nhà thầu khách thấy dòng của hợp đồng mình. |
| `/resources/guarantee` (list + get) | DTO riêng | Ẩn thông tin tài khoản/cam kết nội bộ của tổ chức phát hành; giữ trạng thái xác minh và hạn. |
| `/resources/change_request` (list + get) | DTO riêng | Ẩn đánh giá nội bộ chưa duyệt với nhà thầu khách; chỉ trả tầng và trạng thái được phép. |
| `/resources/measurement` (list + get) | DTO riêng | evidence_refs chỉ trả tham chiếu có quyền đọc; ẩn bản chưa nộp của bên khác. |
| `/resources/acceptance` (list + get) | DTO riêng | signer_refs chỉ hiển thị tên/chức danh theo quyền; không lộ định danh ký. |

## 8. UI/UX

Tuân thủ mockup (D-B11): component families tài liệu 06 (bảng, form, board, timeline, compare, confirm), tokens `design_tokens.json`. Số tiền chỉ đọc khi do hệ thống tính; đơn giá/khối lượng hiển thị đủ 6 chữ số thập phân khi cần.

| ID | Tên màn hình | Loại | Nền tảng | Phase | Trường chính | Command / API | Ghi chú nghiệp vụ |
|---|---|---|---|---|---|---|---|
| CTR-19 | Chuỗi thay đổi ChangeEvent → PCO → CO | board | web | P1 | Tầng, Mã, Hợp đồng, Giá trị ước tính, Giá trị thẩm định, Giá trị duyệt, Ảnh hưởng tiến độ, Trạng thái | `createChangeRequest`, `promoteChangeRequest`, `evaluateChangeRequest`, `post_contract_changes_id_decision`, `getChangeChain` | Số tầng cố định theo dự án sau lần dùng đầu; chỉ CO APPROVED tạo phiên bản hợp đồng; duyệt khác người lập; phiên bản chưa hiệu lực không đổi BOQ thanh toán (UC-CTR-03) |
| CTR-20 | Cấu hình số tầng thay đổi của dự án | policy | web | P1 | Dự án, Số tầng (1/2/3), Đã khóa, Thay đổi đầu tiên, Người đặt | `setChangeChainTiers` | Đặt được trước lần dùng đầu; sau đó khóa (CHANGE_TIERS_LOCKED), kể cả bằng SQL trực tiếp (UC-CTR-03) |
| CTR-21 | Giữ lại theo dòng BOQ và giải tỏa | funding | web | P1 | Dòng BOQ, Giữ lại lũy kế, Điều kiện giải tỏa, Ngày sớm nhất, Đã giải tỏa, Còn giữ, Người duyệt | `releaseRetention` | Giải tỏa cần quyền retention.release, điều kiện đạt và người duyệt khác người đề xuất; không vượt số đang giữ (UC-CTR-05) |
| CTR-22 | Tạm dừng, tiếp tục và chấm dứt hợp đồng | confirm | web | P1 | Hợp đồng, Hành động, Lý do, Văn bản quyết định, Ngày hiệu lực, Xử lý bảo lãnh, Ảnh hưởng thanh toán | `suspendContract`, `resumeContract`, `terminateContract` | Mọi chuyển Suspended/Terminated cần lý do, văn bản và người duyệt; Terminated không đảo ngược (UC-CTR-02) |
| CTR-23 | Bảng điểm nhà thầu và nhật ký vi phạm | table | web | P1 | Nhà thầu, Hợp đồng, Chất lượng, Tiến độ, An toàn – môi trường, Hợp tác, Tài chính, Điểm tổng, Xếp hạng, Vi phạm | `evaluateContractor`, `approveContractorEvaluation`, `recordContractorViolation`, `confirmContractorViolation`, `getContractorScorecard` | Điểm theo trọng số rule version; người duyệt khác người lập; vi phạm cần văn bản mới được xác nhận (UC-CTR-06) |
| CTR-24 | Xuất hồ sơ nhà thầu cho cơ sở dữ liệu quốc gia | import | web | P2 | Phạm vi, Kỳ từ – đến, Định dạng, Số dòng, Mã băm SHA-256, Trạng thái nộp, Mã biên nhận | `exportContractorRecords`, `markContractorExportSubmitted` | Tệp xuất idempotent theo mã băm; nộp ra ngoài thực hiện thủ công, mã biên nhận nhập tay (adapter PROPOSED, API MISSING) (UC-CTR-06) |
| CTR-25 | Thành viên liên danh và phạm vi | table | web | P1 | Thành viên, Vai trò, Tỷ lệ phần việc, Giá trị phần việc, Tạm ứng được cấp, Đã thu hồi, Bảo lãnh | `replaceContractParties` | Tổng tỷ lệ phải bằng 100; ngưỡng thu hồi 80% áp theo từng thành viên (UC-CTR-01) |
| CTR-26 | Phiên bản hợp đồng và hiệu lực | timeline | web | P1 | Phiên bản, Loại, Hiệu lực từ, Giá trị, Nguồn thay đổi, Hồi tố, Trạng thái | `getContractSummary`, `approveRetroactiveAdjustment` | Chỉ phiên bản EFFECTIVE dùng cho BOQ thanh toán; phiên bản PENDING_EFFECTIVE hiển thị nhưng không tính; hồi tố qua quy trình riêng (UC-CTR-03) |

Màn hình hiện có được bổ sung (ID giữ nguyên, theo D-B11 được thêm trường):

- CTR-02: thêm trường "Giá trần gói thầu", "Nhóm áp trần tạm ứng", "Liên danh", "Hợp đồng yêu cầu nghiệm thu chất lượng" (FR-CTR-02).
- CTR-04: thêm trường "Tỷ lệ giữ lại (%)", "Quy tắc làm tròn", "Thành viên liên danh" (FR-CTR-04).
- CTR-05: thêm trường "Thành viên liên danh", "Trạng thái xác minh", "Số bảo lãnh", "Mức cảnh báo hết hạn (30/15/7)" (FR-CTR-05).
- CTR-06: thêm trường "Ngưỡng thu hồi hết (80% giá trị phần việc)", "Trần theo loại hợp đồng", "Thành viên liên danh" (FR-CTR-06).
- CTR-09: quy tắc thay bằng: Màn hình tổng hợp chỉ đọc: nhật ký thi công điện tử do QMS sở hữu (QMS-01…QMS-03); mọi ghi/ký đi qua lệnh QMS; hiển thị trạng thái ký và độ phủ theo hợp đồng (FR-CTR-09).
- CTR-11: quy tắc thay bằng: Màn hình tổng hợp chỉ đọc: kiểm tra chất lượng và NCR do QMS sở hữu (QMS-04…QMS-07); NCR CRITICAL chặn nghiệm thu khối lượng (FR-CTR-11).
- CTR-12: thêm trường "Biên bản nghiệm thu chất lượng QMS", "Phiên bản hợp đồng áp dụng" (FR-CTR-12).
- CTR-15: quy tắc thay bằng: Màn hình tổng hợp chỉ đọc: bàn giao, tồn tại và biên bản do AST sở hữu (AST-01, AST-02); hoàn thành hợp đồng cần nghiệm thu hoàn thành đạt và không còn NCR nghiêm trọng (FR-CTR-15).
- CTR-16: quy tắc thay bằng: Màn hình tổng hợp chỉ đọc: bảo hành và khắc phục tồn tại do AST sở hữu (AST-04, AST-05); giải tỏa giữ lại/bảo lãnh bảo hành thực hiện ở CTR-05, CTR-21 (FR-CTR-16).
- CTR-18: quy tắc thay bằng: Màn hình tổng hợp chỉ đọc: hồ sơ tài sản và chuyển giao vận hành do AST sở hữu (AST-03, AST-06); giá trị tài sản không vượt giá trị hợp đồng (FR-CTR-18).

**Trạng thái.** 7 trạng thái chuẩn; riêng: CTR-19 “cấu hình tầng đã khóa” (khóa control số tầng, hiển thị thay đổi đầu tiên), CTR-26 phân biệt PENDING_EFFECTIVE (nhãn “chưa hiệu lực – không dùng cho thanh toán”), CTR-05 nhãn mức cảnh báo, CTR-22 cảnh báo hành động không đảo ngược (chấm dứt). Màn hình tổng hợp CTR-09/11/15/16/18 chỉ đọc với liên kết sang QMS/AST.

**Quyền thao tác.** Nút duyệt ẩn với người lập; nhà thầu khách chỉ thấy hợp đồng của mình và không thấy cột tổng lũy kế tài chính.

**Web/mobile.** Web đầy đủ. Mobile dùng MOB-61 (hợp đồng và mốc hiện trường), MOB-63 (ghi khối lượng và bằng chứng), MOB-65 (duyệt nghiệm thu) thuộc phân hệ MOB, gọi đúng command CTR; offline chỉ xếp hàng `recordMeasurement` với `client_operation_id`; duyệt không thực hiện từ cache.

## 9. Sự kiện, job, tích hợp, quan sát

**Phát.** `ctr.contract.created/review_requested/returned/signed/activated/suspended/resumed/terminated/completed/closed/cancelled.v1` {contract_id, project_id, status, effective_on}; `ctr.commitment.changed.v1` {contract_id, project_id, allocation_line_id?, committed_vnd} → CAP; `ctr.contract_revision.created.v1`; `ctr.change.opened/promoted/evaluated/approved/withdrawn/retroactive_applied.v1`; `ctr.measurement.recorded/submitted/approved/corrected.v1`; `ctr.acceptance.drafted/submitted/approved/revoked.v1` {acceptance_id, contract_id, accepted_amount_vnd, lines[] (boq_item_id, party_id, amount_vnd)} → PAY; `ctr.guarantee.registered/verified/extended/released.v1`; `ctr.retention.released.v1`; `ctr.violation.recorded/confirmed.v1`; `ctr.contractor_evaluation.*.v1`; `ctr.contractor_export.*.v1`.

**Nhận.** `qms.quality_acceptance.approved.v1`/`revoked.v1` (gắn/gỡ `quality_acceptance_id`), `qms.ncr.raised/closed.v1` (cờ chặn nghiệm thu), `ast.warranty.closed.v1` (điều kiện giải tỏa WARRANTY_END), `pay.settlement.closed.v1` (điều kiện đóng), `pmt.permit.*` (đánh giá lại cổng). Consumer idempotent qua `inbox_record`.

**Job.** `revision-effective` (00:05 VN), `guarantee-expiry` (06:00 VN), `retention-due` (06:00 VN, nhắc khi đến `release_not_before`). Temporal workflow phê duyệt hợp đồng/CO theo `workflow_version` của tenant; mỗi bước gọi command có guard.

**Cache.** `t:{tenant_id}:ctr:contract:{id}:summary:v{version}` TTL 60 giây.

**Quan sát.** Metric `ctr_state_transition_total{from,to,outcome}`, `ctr_guarantee_expiring{days}`, `ctr_change_tier_locked_rejections_total`, `ctr_measurement_rejected_total{code}`. Cảnh báo: bảo lãnh tạm ứng hết hạn khi còn tạm ứng chưa thu hồi; phiên bản PENDING_EFFECTIVE quá hạn hiệu lực > 1 ngày (job lỗi).

## 10. Kiểm thử

Bộ fixture synthetic dùng chung được định nghĩa tại `PAY.md` §10 (nhãn [EXE-FX]); mọi ID/người dùng trong bảng là dữ liệu giả. Các test dưới đây là nguồn của `test_cases.json` (ID `UAT-AC…`); loại: domain / integration / security / concurrency / performance / E2E.

| ID | Loại | Ưu tiên | Tình huống | Setup | Input | Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|---|---|
| UAT-AC56 | business | P1 | Người thẩm định/ký có xung đột lợi ích với nhà thầu bị chặn hoặc phải có quyết định xử lý | [EXE-FX] u.tham.dinh có khai báo xung đột lợi ích với NT-A-01 (conflict_declaration CD-001, hiệu lực 2026-01-01..2026-12-31, từ BID); u.lanhdao không có xung đột; HD-A-020 DRAFT của NT-A-01 đã kiểm giá trần. | submitContractForReview bởi u.tham.dinh; recordContractSigning với conflict_decision_ref rỗng rồi có giá trị; chuyển người duyệt sang u.lanhdao. | 1. u.tham.dinh gọi submitContractForReview HD-A-020. 2. u.tham.dinh gọi recordContractSigning không conflict_decision_ref. 3. u.lanhdao ghi quyết định xử lý "QD-XL-001: người có xung đột không tham gia thẩm định" rồi gọi recordContractSigning với conflict_decision_ref=QD-XL-001. 4. Đọc audit_entry của HD-A-020. | chuyên gia có conflict bị chặn hoặc cần quyết định xử lý được ghi audit. Cụ thể: Bước 1 và 2: 409 CONFLICT_OF_INTEREST_BLOCKED, trạng thái vẫn DRAFT/IN_REVIEW, không đổi dữ liệu. Bước 3: 200 SIGNED (người ký không xung đột); conflict_decision_ref lưu cùng bản ghi. Audit có cả hai lần bị chặn với actor, nhà thầu, mã khai báo CD-001. | Response, audit_entry, conflict_declaration CD-001 |
| UAT-AC57 | business | P1 | Giá vượt trần hoặc kế hoạch chưa duyệt bị chặn | [EXE-FX] Gói thầu PKG-A-020 giá gói 10.200.000.000 (budget_vnd); kế hoạch vốn APPROVED cho PRJ-A-001; gói PKG-A-021 thuộc PRJ-A-002 chưa có plan_version APPROVED. | createContract contract_value_vnd=10300000000 cho PKG-A-020; 10200000000 cho PKG-A-020; 5000000000 cho PKG-A-021. | 1. createContract với giá trị 10.300.000.000. 2. createContract với giá trị 10.200.000.000 (bằng giá gói). 3. createContract cho PKG-A-021. 4. Đọc hợp đồng đã tạo. | giá vượt trần hoặc kế hoạch chưa duyệt bị chặn theo rule đã chốt. Cụ thể: Bước 1: 422 CONTRACT_VALUE_EXCEEDS_CEILING, details ceiling_vnd=10200000000. Bước 2: 200 DRAFT, contract_value_vnd=10.200.000.000, estimate_ceiling_vnd=10.200.000.000. Bước 3: 422 CAPITAL_PLAN_NOT_APPROVED. Không hợp đồng nào được tạo ở bước 1 và 3. | Response, bảng contract |
| UAT-AC58 | business | P1 | Phiên bản hợp đồng chưa hiệu lực không đổi BOQ thanh toán; hồi tố cần quy trình riêng | [EXE-FX] CO-A-001 (tầng CO) được duyệt ngày 2026-07-20: B02 đơn giá 2.000.000 → 2.100.000, effective_on 2026-08-01, approved_delta_vnd +250.000.000; phiên bản rev2 PENDING_EFFECTIVE; CO-A-002 có effective_on 2026-06-01 (trước ngày duyệt) không đặt cờ retroactive. | Ghi khối lượng và nghiệm thu B02 ngày 2026-07-25 (500 m3); chạy job hiệu lực ngày 2026-08-01; duyệt CO-A-002; gọi approveRetroactiveAdjustment. | 1. Tạo nghiệm thu ngày 2026-07-25 cho B02 500 m3; đọc unit_price_snapshot và amount_vnd. 2. Chạy job hiệu lực ngày 2026-08-01; đọc contract_revision và contract.contract_value_vnd. 3. Tạo nghiệm thu ngày 2026-08-02 cho B02 100 m3. 4. Duyệt CO-A-002 (effective_on 2026-06-01). 5. Gọi approveRetroactiveAdjustment cho CO-A-002 kèm quyết định. | phụ lục chưa hiệu lực không đổi BOQ thanh toán; hồi tố cần quy trình điều chỉnh riêng. Cụ thể: Nghiệm thu ngày 07-25: unit_price_snapshot 2.000.000, amount 1.000.000.000 (theo rev1). Job 08-01: rev2 EFFECTIVE, rev1 SUPERSEDED, contract_value_vnd tăng 250.000.000 (10.250.000.000). Nghiệm thu 08-02: unit_price_snapshot 2.100.000, amount 210.000.000. Duyệt CO-A-002: 422 RETROACTIVE_NOT_ALLOWED. approveRetroactiveAdjustment: 200, tạo bút toán điều chỉnh, KHÔNG sửa acceptance_line/amount đã duyệt, ghi decision_document và danh sách nghiệm thu bị ảnh hưởng. | Bảng contract_revision, acceptance_line, audit |
| UAT-AC59 | business | P1 | Bảo lãnh sắp hết hạn có thông báo, không tự gia hạn | [EXE-FX] Bảo lãnh tạm ứng BL-A-001 ACTIVE, expires_at 2026-12-01 23:59 (giờ VN); ADV-A-001 còn outstanding 1.250.000.000; người nhận u.ketoan, u.cv.hd. | Chạy job guarantee-expiry với đồng hồ giả lập 2026-11-01, 2026-11-16, 2026-11-24, 2026-12-02. | 1. Chạy job 2026-11-01 (còn 30 ngày); đọc last_alert_days và notification. 2. Chạy 2026-11-16 (15) và 2026-11-24 (7). 3. Chạy lại 2026-11-24 lần hai. 4. Chạy 2026-12-02; đọc guarantee.status và thử requestAdvance mới. | bảo lãnh sắp hết hạn có notification, không tự đánh dấu gia hạn. Cụ thể: Thông báo gửi đúng 3 lần với last_alert_days = 30, 15, 7; chạy lại cùng ngày không tạo thông báo trùng. Trạng thái giữ ACTIVE cho đến hết hạn, expires_at không bị đổi. 2026-12-02: status EXPIRED, tự tạo 1 vướng mắc ISS (outstanding > 0 mà bảo lãnh hết hạn), requestAdvance trả 422 ADVANCE_GUARANTEE_REQUIRED. Chỉ extendGuarantee bằng bản mới mới tạo bảo lãnh thay thế. | Bảng guarantee/notification/issue theo ngày giả lập |
| UAT-AC63 | business | P1 | Khối lượng chưa duyệt không dùng cho nghiệm thu/thanh toán | [EXE-FX] M-A-020 SUBMITTED (B01, 1.000 m3), M-A-021 APPROVED (B02, 200 m3), M-A-022 DRAFT. | createAcceptance với measurement_ids [M-A-020]; [M-A-021, M-A-022]; [M-A-021]; createPaymentRequest từ acceptance DRAFT. | 1. createAcceptance [M-A-020]. 2. createAcceptance [M-A-021, M-A-022]. 3. createAcceptance [M-A-021] rồi tạo đề nghị thanh toán khi acceptance còn DRAFT. 4. Duyệt acceptance rồi tạo đề nghị lại. | measurement chưa duyệt không được dùng cho nghiệm thu/payment certified. Cụ thể: Bước 1 và 2: 422 MEASUREMENT_NOT_APPROVED (liệt kê id M-A-020, M-A-022). Bước 3: acceptance tạo được (DRAFT); createPaymentRequest trả 422 ACCEPTANCE_NOT_APPROVED. Bước 4 sau khi duyệt: tạo được đề nghị; amount_vnd acceptance = 200 × 2.000.000 = 400.000.000. | Response, bảng acceptance/acceptance_line |
| UAT-AC300 | domain | P0 | Bảng chuyển trạng thái hợp đồng: chuyển hợp lệ và bị cấm | [EXE-FX] Các hợp đồng HD-S-01..HD-S-09 lần lượt ở DRAFT, IN_REVIEW, SIGNED, ACTIVE, SUSPENDED, TERMINATED, COMPLETED, CLOSED, CANCELLED. | Chạy bảng ma trận 9 trạng thái × lệnh (submit-review, return, sign, activate, suspend, resume, terminate, complete, close, cancel) với đủ quyền, mỗi lệnh Idempotency-Key riêng. | 1. Với mỗi cặp (trạng thái, lệnh) gọi lệnh và ghi mã trả về. 2. So kết quả với bảng §4: chuyển hợp lệ trả 200 và đích đúng; còn lại 409 CONTRACT_STATE_INVALID. 3. Kiểm contract_status_change có đúng một dòng cho mỗi chuyển hợp lệ. 4. Thử UPDATE contract SET status trực tiếp bằng role machvon_app từ CLOSED về ACTIVE. | Hợp lệ (200): DRAFT→IN_REVIEW, IN_REVIEW→DRAFT, IN_REVIEW→SIGNED, SIGNED→ACTIVE, ACTIVE→SUSPENDED, SUSPENDED→ACTIVE, SIGNED\|ACTIVE\|SUSPENDED→TERMINATED, ACTIVE→COMPLETED, COMPLETED\|TERMINATED→CLOSED, DRAFT\|IN_REVIEW→CANCELLED. Mọi cặp khác (ví dụ CLOSED→ACTIVE, TERMINATED→ACTIVE, SUSPENDED→COMPLETED, CANCELLED→DRAFT) trả 409 CONTRACT_STATE_INVALID và không đổi dữ liệu. UPDATE trực tiếp bị từ chối bởi quyền cột/ứng dụng (role machvon_app không có endpoint ghi status chung; kiểm trigger/ràng buộc CHECK contract_effective_dates_chk). | Ma trận 9×10 kết quả, bảng contract_status_change |
| UAT-AC301 | security | P0 | Nhà thầu khách chỉ thấy hợp đồng của mình; IDOR bị chặn | [EXE-FX] u.nt thuộc NT-A-01 (guest, scope CONTRACT HD-A-001); NT-A-02 có HD-A-002; HD-A-003 của NT-A-03 ở TNT-A; TNT-B có HD-B-001. | Với token u.nt: GET /resources/contract; GET /resources/contract/{HD-A-002}; GET /contracts/{HD-A-002}/summary; GET /resources/boq_line?contract=HD-A-002; POST /contracts/{HD-A-001}/measurements; GET HD-B-001. | 1. Liệt kê danh mục hợp đồng. 2. Truy cập trực tiếp HD-A-002 theo id ở bốn endpoint. 3. Ghi khối lượng cho HD-A-001. 4. Truy cập HD-B-001. 5. Thử gọi contract.activate bằng token u.nt. | Danh mục chỉ có HD-A-001 (1 dòng). HD-A-002: 404 RESOURCE_NOT_FOUND ở mọi endpoint (không phải 403, không lộ tồn tại). Ghi khối lượng HD-A-001: 200 (measurement.record cho guest). HD-B-001: 404. contract.activate: 403 SCOPE_DENIED. Response contract không chứa trường accepted_total_vnd/ledger nội bộ (DTO mask). | Response từng endpoint, so sánh body |
| UAT-AC302 | integration | P0 | Kích hoạt hợp đồng cần bảo lãnh thực hiện, cổng giấy phép và cam kết vốn | [EXE-FX] HD-A-030 SIGNED, loại xây dựng; bảo lãnh thực hiện BL-P-030 PENDING_VERIFICATION 500.000.000 (5%); cổng START/ACTIVATION yêu cầu GPXD hoặc miễn; quỹ AL-A-2026-NSDP đủ. | activateContract effective_from=2026-09-01 ở các điều kiện: chưa xác minh bảo lãnh; bảo lãnh VERIFIED nhưng thiếu GPXD; GPXD ISSUED; CAP trả lỗi AVC. | 1. Gọi activate khi bảo lãnh chưa xác minh. 2. Xác minh bảo lãnh, gọi activate khi chưa có GPXD/miễn. 3. Ghi GPXD ISSUED hiệu lực, gọi activate khi CAP giả lập AVC chặn. 4. Cho CAP cho phép, gọi activate; đọc outbox. | Bước 1: 422 PERFORMANCE_GUARANTEE_MISSING. Bước 2: 422 PERMIT_GATE_BLOCKED (details: gate_code CONTRACT_ACTIVATION, permit_type GPXD). Bước 3: 422 FUND_COMMIT_FAILED, hợp đồng vẫn SIGNED. Bước 4: 200 ACTIVE, effective_from=2026-09-01; outbox có ctr.contract.activated.v1 và ctr.commitment.changed.v1 (amount = contract_value_vnd); CAP ghi COMMIT đúng một lần. | Bốn response, outbox, capital_ledger_entry |
| UAT-AC303 | domain | P0 | Tạm dừng/tiếp tục hợp đồng: lý do, văn bản và hiệu lực lên khối lượng | [EXE-FX] HD-A-001 ACTIVE; DOC-TD-001 là quyết định tạm dừng đã ISSUED; M-A-030 DRAFT. | suspendContract thiếu decision_document_version_id; có văn bản; recordMeasurement khi SUSPENDED; resumeContract với extension_days=20. | 1. suspendContract thiếu văn bản. 2. suspendContract đầy đủ suspended_from=2026-07-10. 3. recordMeasurement kỳ 2026-07 cho B01. 4. resumeContract resumed_on=2026-07-30 extension_days=20; đọc completion_due. | Bước 1: 422 DECISION_DOCUMENT_REQUIRED. Bước 2: 200 SUSPENDED, status_reason và status_decision_document_version_id lưu (CHECK contract_status_reason_chk). Bước 3: 409 CONTRACT_STATE_INVALID. Bước 4: 200 ACTIVE; completion_due thay đổi theo 20 ngày chỉ khi có phiên bản gia hạn được duyệt, nếu không giữ 2026-12-31 và hiển thị đề xuất lập CO gia hạn tiến độ; contract_status_change ghi 2 dòng. | Response, bảng contract/contract_status_change |
| UAT-AC304 | domain | P0 | Chấm dứt hợp đồng không đảo ngược và xử lý bảo lãnh | [EXE-FX] HD-A-001 ACTIVE; bảo lãnh thực hiện BL-P-001 500.000.000 ACTIVE; tạm ứng outstanding 1.250.000.000; DOC-CD-001 là quyết định chấm dứt. | terminateContract guarantee_action=CALL terminated_on=2026-08-15 bởi người có quyền; bởi chính người đề xuất; resumeContract sau chấm dứt. | 1. u.cv.hd (đề xuất) gọi terminateContract. 2. u.lanhdao gọi terminateContract kèm DOC-CD-001. 3. Gọi resumeContract và activateContract. 4. Đọc guarantee, contractor_violation gợi ý, contract. | Bước 1: 403 SELF_APPROVAL_DENIED. Bước 2: 200 TERMINATED, terminated_on=2026-08-15, bảo lãnh BL-P-001 chuyển CALLED, 1 dòng contractor_violation gợi ý ở trạng thái RECORDED (chưa xác nhận). Bước 3: 409 CONTRACT_STATE_INVALID cho cả hai. advance_outstanding_vnd vẫn 1.250.000.000 (không tự xóa). | Response, bảng guarantee/contract |
| UAT-AC305 | integration | P0 | Hoàn thành hợp đồng cần nghiệm thu hoàn thành đạt và không còn NCR nghiêm trọng | [EXE-FX] HD-A-001 ACTIVE; quality_acceptance QA-C-001 phạm vi COMPLETION APPROVED; NCR-007 CRITICAL OPEN; measurement M-A-040 SUBMITTED chưa quyết. | completeContract với QA-C-001 khi còn NCR-007 và M-A-040; sau khi đóng NCR; sau khi quyết M-A-040. | 1. Gọi completeContract. 2. Đóng NCR-007 (qua QMS) rồi gọi lại. 3. Duyệt M-A-040 rồi gọi lại. 4. Đọc contract và warranty_obligation sinh bởi sự kiện. | Bước 1: 422 OPEN_CRITICAL_NCR. Bước 2: 422 MEASUREMENT_PENDING. Bước 3: 200 COMPLETED với completed_on; outbox ctr.contract.completed.v1; AST nhận sự kiện và đề xuất khởi tạo nghĩa vụ bảo hành (chưa tạo tự động nếu chưa có handover). | Response, outbox |
| UAT-AC306 | domain | P1 | Liên danh: tổng tỷ lệ thành viên phải bằng 100 | [EXE-FX] HD-A-002 DRAFT is_joint_venture=true; thành viên M1 60% giá trị phần việc 6.000.000.000, M2 40% 4.000.000.000. | replaceContractParties với M1 60 + M2 30; sau đó 60 + 40; submitContractForReview; UPDATE contract_party share_pct khi hợp đồng SIGNED. | 1. Gửi parties tổng 90%. 2. Gửi parties 60/40 và submitContractForReview. 3. Sau khi SIGNED, UPDATE contract_party SET share_pct=50 WHERE M2 bằng SQL trực tiếp rồi commit. | Bước 1 và submit với tổng 90%: 422 JV_SHARE_NOT_100. Bước 2: 200, Σ work_value_vnd = 10.000.000.000 = giá trị hợp đồng (nếu lệch: 422 BOQ_TOTAL_MISMATCH). Bước 3: commit thất bại do constraint trigger deferred contract_party_share_tg (JV_SHARE_NOT_100, SQLSTATE 23514). | Response, lỗi trigger |
| UAT-AC307 | domain | P0 | Số tầng chuỗi thay đổi khóa sau lần dùng đầu | [EXE-FX] PRJ-A-001 chưa có change_chain_config; PRJ-A-002 cũng chưa có; HD-A-001 thuộc PRJ-A-001; u.cv.hd có change.tiers.configure. | setChangeChainTiers tier_count=3 cho PRJ-A-001; createChangeRequest stage=EVENT; setChangeChainTiers tier_count=2; PRJ-A-002 đặt tier_count=1 và tạo stage=PCO. | 1. Đặt tier_count=3 cho PRJ-A-001; đọc locked_at. 2. Tạo ChangeEvent đầu tiên cho HD-A-001; đọc locked_at và locked_by_change_id. 3. Đặt lại tier_count=2 cho PRJ-A-001; thử UPDATE trực tiếp change_chain_config. 4. PRJ-A-002: đặt tier_count=1, thử createChangeRequest stage=PCO rồi stage=CO. | Bước 1: locked_at NULL. Bước 2: locked_at ≠ NULL, locked_by_change_id = id ChangeEvent đầu. Bước 3: 409 CHANGE_TIERS_LOCKED; UPDATE trực tiếp bị trigger change_chain_config_guard_tg chặn (SQLSTATE 23514). PRJ-A-002 (tier_count=1): stage=PCO → 422 CHANGE_STAGE_NOT_ALLOWED; stage=CO → 200. Cấu hình của PRJ-A-001 không ảnh hưởng PRJ-A-002. | Response, bảng change_chain_config |
| UAT-AC308 | domain | P0 | Duyệt CO tạo phiên bản hợp đồng; maker ≠ checker; không giảm dưới giá trị đã nghiệm thu | [EXE-FX] Chuỗi 3 tầng: CE-001 (EVENT) → PCO-001 → CO-001 do u.cv.hd lập; contract.accepted_total_vnd = 3.000.000.000; CO-001 approved_delta_vnd +500.000.000 effective_on 2026-08-01; CO-002 delta −8.000.000.000. | promote CE-001→PCO-001→CO-001; evaluate; decision approve bởi u.cv.hd rồi bởi u.lanhdao; duyệt CO-002. | 1. promote và evaluate để CO-001 EVALUATED. 2. u.cv.hd gọi decision approve. 3. u.lanhdao gọi decision approve kèm decision_document_version_id. 4. Chạy job hiệu lực ngày 2026-08-01. 5. Duyệt CO-002 (giảm 8.000.000.000). | CE-001 và PCO-001 chuyển PROMOTED, CO-001 EVALUATED. Bước 2: 403 SELF_APPROVAL_DENIED. Bước 3: 200 APPROVED, tạo contract_revision rev2 PENDING_EFFECTIVE amount 10.500.000.000. Sau job: rev2 EFFECTIVE, rev1 SUPERSEDED, contract_value_vnd 10.500.000.000 (partial unique contract_revision_effective_uq giữ đúng 1 EFFECTIVE). CO-002: 422 ACCEPTANCE_VALUE_EXCEEDS_CONTRACT vì giá trị mới 10.500.000.000 − 8.000.000.000 = 2.500.000.000 < accepted_total 3.000.000.000 (bảo vệ bởi CHECK contract_ledger_order_chk). | Chuỗi change_request, contract_revision, response |
| UAT-AC309 | domain | P0 | Giữ lại theo dòng BOQ và giải tỏa có quyền riêng | [EXE-FX] PR-A-001 SETTLED; retention_hold: B01 100.000.000, B02 50.000.000 (điều kiện WARRANTY_END, release_not_before 2028-03-01); u.cv.hd không có retention.release; u.ktt có retention.release; u.lanhdao duyệt. | releaseRetention B01 100000000 bởi u.cv.hd; bởi u.ktt khi chưa đến điều kiện; sau khi warranty_obligation đã CLOSED với số tiền 100000001; 100000000. | 1. u.cv.hd gọi releaseRetention. 2. u.ktt gọi khi bảo hành còn hiệu lực. 3. Đưa warranty_obligation sang CLOSED (không còn claim mở); u.ktt gọi amount 100.000.001. 4. u.ktt gọi amount 100.000.000 kèm reason; kiểm người đề xuất ≠ người duyệt. | Bước 1: 403 (thiếu quyền retention.release). Bước 2: 422 RELEASE_CONDITION_NOT_MET. Bước 3: 422 RELEASE_EXCEEDS_HELD. Bước 4: 200, retention_hold B01 RELEASED (released_vnd = held_vnd = 100.000.000), contract.retention_released_vnd = 100.000.000 ≤ retention_held_vnd 150.000.000; B02 vẫn HELD 50.000.000. | Response, bảng retention_hold/contract |
| UAT-AC310 | domain | P1 | Vòng đời bảo lãnh: xác minh, gia hạn bằng bản mới, giải tỏa có bằng chứng | [EXE-FX] BL-A-002 PENDING_VERIFICATION 500.000.000 hết hạn 2026-12-31; u.cv.hd đăng ký; u.ktt xác minh. | verifyGuarantee bởi người đăng ký; bởi u.ktt outcome=VERIFIED; extendGuarantee new_expires_at=2027-06-30; releaseGuarantee thiếu bằng chứng; đủ. | 1. u.cv.hd verify. 2. u.ktt verify VERIFIED kèm biên bản xác minh. 3. extendGuarantee. 4. releaseGuarantee bản cũ và bản mới không có release_evidence_id; có evidence. | Bước 1: 403 SELF_APPROVAL_DENIED. Bước 2: ACTIVE và verification_status=VERIFIED. Bước 3: bản cũ SUPERSEDED, bản mới (extended_from_id trỏ bản cũ) PENDING_VERIFICATION; expires_at bản cũ không đổi. Bước 4: không evidence → 422 (CHECK guarantee_release_chk / RELEASE_CONDITION_NOT_MET); có evidence → RELEASED với released_at. | Bảng guarantee qua từng bước |
| UAT-AC311 | domain | P0 | Khối lượng lũy kế không giảm nếu thiếu correction_of_id | [EXE-FX] M-A-050 APPROVED B01 kỳ 2026-06 lũy kế 4.000 m3; kỳ 2026-07 sẽ ghi. | recordMeasurement quantity_period=-500 cho kỳ 2026-07; correctMeasurement M-A-050 quantity_period=3500 reason; INSERT SQL trực tiếp quantity_period=-1 không correction. | 1. recordMeasurement quantity_period "-500". 2. correctMeasurement M-A-050 với quantity_period "3500" và correction_reason. 3. INSERT measurement quantity_period=-1, correction_of_id NULL bằng role machvon_app. 4. Đọc chuỗi revision. | Bước 1: 422 CUMULATIVE_DECREASE_WITHOUT_CORRECTION. Bước 2: M-A-050 → SUPERSEDED, bản mới revision 2 DRAFT với correction_of_id=M-A-050 và lũy kế 3.500; nếu M-A-050 đã nằm trong nghiệm thu active: 409 MEASUREMENT_IN_ACTIVE_ACCEPTANCE. Bước 3: lỗi CHECK measurement_cumulative_chk. correction_reason bắt buộc khi có correction_of_id (CHECK measurement_correction_chk). | Response, bảng measurement |
| UAT-AC312 | domain | P0 | Khối lượng không vượt BOQ tại biên | [EXE-FX] B01 quantity 8.000 m3; lũy kế đã duyệt 7.999 m3; revision hợp đồng EFFECTIVE; không có CO tăng khối lượng. | recordMeasurement quantity_period=1 rồi 2 cho B01. | 1. Ghi 1,000000 m3 (tổng 8.000). 2. Ghi thêm 0,000001 m3. 3. Ghi 2 m3 trên bản trước khi duyệt. 4. Tạo CO tăng khối lượng B01 +100 m3, duyệt và hiệu lực; ghi lại 2 m3. | Bước 1: 200 (đúng biên 8.000). Bước 2 và 3: 422 QUANTITY_EXCEEDS_BOQ, details remaining_quantity="0.000000". Bước 4: sau rev mới EFFECTIVE (quantity 8.100) ghi 2 m3 thành công, lũy kế 8.002. | Response, bảng boq_line/measurement |
| UAT-AC313 | integration | P1 | Nghiệm thu khối lượng yêu cầu nghiệm thu chất lượng QMS | [EXE-FX] HD-A-001 requires_quality_acceptance=true; acceptance NT-A-060 SUBMITTED với M-A-060 APPROVED; chưa có QA liên kết; NCR-009 CRITICAL OPEN trên B02. | decision approve NT-A-060 khi chưa có QA; sau khi gắn QA-W-060 APPROVED (sự kiện qms.quality_acceptance.approved.v1) nhưng NCR-009 CRITICAL còn mở; sau khi đóng NCR-009. | 1. u.lanhdao duyệt NT-A-060 khi chưa có quality_acceptance_id. 2. Nhận sự kiện QA-W-060 APPROVED, gắn quality_acceptance_id, duyệt lại khi NCR-009 còn OPEN. 3. Đóng NCR-009 qua QMS (hành động khắc phục đã VERIFIED), duyệt lại. 4. Đọc acceptance và cumulative_ledger. | Bước 1: 422 QUALITY_ACCEPTANCE_REQUIRED. Bước 2: 422 OPEN_CRITICAL_NCR. Bước 3: 200 APPROVED; acceptance.quality_acceptance_id = QA-W-060, accepted_amount_vnd > 0 (CHECK acceptance_approved_chk) và có đúng một bút toán RECOGNIZE_ACCEPTANCE cho mỗi dòng. | Response, outbox, bảng acceptance |
| UAT-AC314 | concurrency | P0 | Hai nghiệm thu đồng thời cùng một khối lượng | [EXE-FX] M-A-070 APPROVED chưa thuộc nghiệm thu nào; hai acceptance DRAFT NT-A-071 (u.cv.hd) và NT-A-072 (u.cv.hd2) cùng chứa M-A-070 trong danh sách. | Hai POST /acceptances/{id}/decision approve đồng thời bởi u.lanhdao và u.lanhdao2, khóa khác nhau. | 1. Chạy 30 vòng với barrier. 2. Đọc acceptance_line theo measurement_id. 3. Đọc contract.accepted_total_vnd và cumulative_ledger. | Mỗi vòng đúng 1 APPROVED và 1 lỗi 409 MEASUREMENT_ALREADY_ACCEPTED (unique acceptance_line_measurement_uq WHERE active); accepted_total_vnd chỉ tăng một lần; acceptance thua giữ SUBMITTED, không dòng sổ. | Bảng kết quả 30 vòng, trạng thái cuối |
| UAT-AC315 | domain | P1 | Bảng điểm nhà thầu, nhật ký vi phạm và xuất tệp cơ sở dữ liệu quốc gia | [EXE-FX] HD-A-001 COMPLETED; trọng số rule CTR.SCORECARD fixture W-01: chất lượng 30%, tiến độ 25%, an toàn–môi trường 20%, hợp tác 10%, tài chính 15%; 1 vi phạm DELAY MAJOR đã CONFIRMED. | evaluateContractor kỳ 2026-Q3 điểm 80/70/90/60/100; approve bởi người lập; bởi u.lanhdao; exportContractorRecords scope=BOTH 2026-07-01..2026-09-30 CSV hai lần; xuất kỳ không có dữ liệu. | 1. Lập đánh giá và đọc overall_score/rating. 2. Duyệt bởi người lập, rồi bởi u.lanhdao. 3. Xuất CSV lần 1 và lần 2 cùng tham số. 4. Xuất kỳ 2027-01-01..2027-01-31. 5. markContractorExportSubmitted với submitted_ref. | overall_score = 80×0,30 + 70×0,25 + 90×0,20 + 60×0,10 + 100×0,15 = 24 + 17,5 + 18 + 6 + 15 = 80,50; rating theo ngưỡng rule (GOOD). Duyệt bởi người lập: 403 SELF_APPROVAL_DENIED. Xuất lần 2 trả cùng batch (cùng file_sha256, unique contractor_export_file_uq) — không tạo bản thứ hai. Kỳ rỗng: 422 EXPORT_EMPTY. Nộp ngoài hệ thống được ghi submitted_ref; trạng thái adapter hiển thị PROPOSED/API MISSING [CXN-EXE-01]. | Bảng contractor_performance/contractor_export_batch, tệp CSV |
| UAT-AC316 | integration | P1 | Idempotency lệnh tạo hợp đồng và chống trùng mã | [EXE-FX] Gói PKG-A-030 đã trúng thầu; chưa có hợp đồng mã HD-A-300. | createContract code=HD-A-300 key K-AC316-A hai lần; cùng key nhưng giá trị khác; key K-AC316-B cùng code. | 1. Gửi lần 1 và lần 2 giống hệt. 2. Gửi cùng key với contract_value_vnd khác. 3. Gửi key mới, cùng code. 4. Đếm hợp đồng mã HD-A-300. | Lần 2 trả đúng body lần 1 (cùng id). Cùng key khác body: 409 IDEMPOTENCY_CONFLICT. Key mới cùng code: 409 CONTRACT_CODE_DUPLICATE. Đúng 1 hợp đồng mã HD-A-300; 1 outbox ctr.contract.created.v1. | Response, đếm bản ghi |
| UAT-AC317 | security | P1 | Tự nâng quyền và ký thay: lệnh ký/kích hoạt hợp đồng | [EXE-FX] u.cv.hd tạo và gửi xem xét HD-A-031; DoA matrix: ký hợp đồng ≤ 20.000.000.000 cần lãnh đạo cấp Ban. | recordContractSigning bởi u.cv.hd (người lập); bởi u.lanhdao vượt hạn mức; payload thêm trường status="ACTIVE" và tenant_id. | 1. u.cv.hd gọi sign. 2. Người có thẩm quyền dưới hạn mức gọi sign cho hợp đồng 25.000.000.000. 3. Gọi sign với body có status và tenant_id. 4. Gọi PATCH /contracts/{id} (không tồn tại) và PUT /resources/contract/{id}. | Bước 1: 403 SELF_APPROVAL_DENIED. Bước 2: 403 SCOPE_DENIED (vượt DoA). Bước 3: 400 INVALID_REQUEST (trường thừa). Bước 4: 404/405 — không có endpoint ghi chung đổi status/tenant_id. | Response từng bước |
| UAT-AC397 | integration | P0 | Idempotency: phát lại cùng khóa trên các lệnh tiền và trạng thái đại diện | [EXE-FX] Sáu lệnh đại diện: decision nghiệm thu, submit thanh toán, importTreasuryStatement, confirmCompensationPayment, closeIssue, releaseRetention; mỗi lệnh có fixture ở trạng thái hợp lệ. | Gửi mỗi lệnh hai lần cùng Idempotency-Key và cùng body; một lần cùng key khác body; một lần khác key sau khi thành công. | 1. Gửi lần 1 và lần 2 cho từng lệnh; so sánh body. 2. Gửi cùng key nhưng đổi một trường body. 3. Gửi key mới sau khi lệnh đã thành công. 4. Đếm audit_entry, outbox_event, bút toán sổ cho từng lệnh. | Lần 2 trả đúng body lần 1 và không tạo thêm audit/outbox/bút toán (mỗi lệnh đúng 1 bộ). Cùng key khác body: 409 IDEMPOTENCY_CONFLICT. Key mới sau thành công: 409 với mã nghiệp vụ tương ứng (ACCEPTANCE_ALREADY_CLAIMED, ALREADY_IMPORTED trả 200 replay, PAYMENT_STATE_INVALID, ISSUE_STATE_INVALID, RELEASE_EXCEEDS_HELD…), không tạo hiệu ứng thứ hai. | Bảng so sánh 6 lệnh × 3 tình huống |
| UAT-AC398 | integration | P1 | Chỉ mục: mọi cột *_id của bảng execution có chỉ mục dẫn đầu tenant_id | [EXE-FX] Schema đã áp; truy vấn pg_index. | Liệt kê cột *_id (trừ tenant_id) của 67 bảng và đối chiếu pg_index (cột đầu tenant_id, cột thứ hai là cột *_id). | 1. Truy vấn information_schema.columns cho 67 bảng, lọc column_name LIKE '%\_id'. 2. Truy vấn pg_index/pg_attribute để lấy cặp (tenant_id, col) của mọi chỉ mục. 3. Tìm cột không có chỉ mục. 4. EXPLAIN truy vấn danh sách theo project_id và theo status+due_at của issue. | Danh sách cột không có chỉ mục rỗng. EXPLAIN dùng Index Scan/Bitmap Index Scan trên issue_project_status_idx và issue_status_due_idx; không có Seq Scan trên bảng ≥ 10.000 dòng fixture. | Kết quả truy vấn catalog, EXPLAIN |

## 11. Tiêu chí nghiệm thu

- **AC-CTR-01**: Given gói thầu đã trúng thầu và kế hoạch vốn đã duyệt, When tạo/gửi/ký hợp đồng, Then giá trị không vượt giá gói, kế hoạch phải APPROVED, người có xung đột lợi ích với nhà thầu không thẩm định/ký, mọi lệnh ghi dùng Idempotency-Key và không có đường ghi chung đổi status/tenant_id. Test: UAT-AC56, UAT-AC57, UAT-AC316, UAT-AC317.
- **AC-CTR-02**: Given hợp đồng ở một trạng thái, When chạy lệnh vòng đời (submit-review, sign, activate, suspend, resume, terminate, complete, close, cancel), Then chỉ các chuyển trong bảng §4 thành công, mỗi chuyển có lý do/văn bản/người duyệt theo guard, và chuyển bị cấm trả 409 CONTRACT_STATE_INVALID. Test: UAT-AC300, UAT-AC302, UAT-AC303, UAT-AC304, UAT-AC305.
- **AC-CTR-03**: Given CO được duyệt, When hiệu lực đến ngày effective_on, Then phiên bản mới EFFECTIVE thay phiên bản cũ, BOQ thanh toán chỉ dùng phiên bản EFFECTIVE tại ngày nghiệm thu, hồi tố chỉ qua quy trình điều chỉnh riêng và không giảm giá trị dưới khối lượng đã nghiệm thu. Test: UAT-AC58, UAT-AC308.
- **AC-CTR-04**: Given bảo lãnh ACTIVE, When tới ngưỡng 30/15/7/0 ngày trước hạn, Then gửi đúng một thông báo mỗi ngưỡng, không tự gia hạn, hết hạn chuyển EXPIRED; gia hạn bằng bản bảo lãnh mới phải xác minh lại. Test: UAT-AC59, UAT-AC310.
- **AC-CTR-05**: Given khối lượng của dòng BOQ, When ghi, nộp, duyệt và nghiệm thu, Then lũy kế không giảm nếu thiếu correction_of_id, không vượt khối lượng BOQ, chỉ khối lượng APPROVED mới vào nghiệm thu, mỗi khối lượng chỉ thuộc một nghiệm thu hoạt động, và nghiệm thu cần biên bản chất lượng QMS khi hợp đồng yêu cầu. Test: UAT-AC63, UAT-AC311, UAT-AC312, UAT-AC313, UAT-AC314.
- **AC-CTR-06**: Given nhà thầu khách có scope một hợp đồng, When truy cập, Then chỉ thấy và ghi trong hợp đồng đó; id hợp đồng khác trả 404. Test: UAT-AC301.
- **AC-CTR-07**: Given hợp đồng liên danh, When rời DRAFT, Then tổng tỷ lệ thành viên bằng 100 và tổng giá trị phần việc bằng giá trị hợp đồng. Test: UAT-AC306.
- **AC-CTR-08**: Given dự án chưa dùng chuỗi thay đổi, When tạo ChangeEvent/PCO/CO đầu tiên, Then số tầng bị khóa và mọi thay đổi sau đó bị chặn ở cả API lẫn DB; tầng không thuộc cấu hình bị từ chối. Test: UAT-AC307.
- **AC-CTR-09**: Given khoản giữ lại theo dòng BOQ, When giải tỏa, Then cần quyền retention.release, điều kiện đạt (hết bảo hành hoặc quyết định), không vượt số đang giữ và người duyệt khác người đề xuất. Test: UAT-AC309.
- **AC-CTR-10**: Given đánh giá nhà thầu đã duyệt, When xuất hồ sơ cho cơ sở dữ liệu quốc gia, Then tệp idempotent theo mã băm, không có dòng chưa duyệt, và việc nộp ngoài hệ thống ghi mã biên nhận nhập tay. Test: UAT-AC315.
- **AC-CTR-11**: Given lệnh ghi quan trọng, When phát lại cùng Idempotency-Key, Then trả đúng phản hồi cũ không tạo thêm audit/outbox/bút toán; khóa mới sau khi thành công bị ràng buộc nghiệp vụ chặn. Test: UAT-AC397.
- **AC-CTR-12**: Given schema execution, When truy vấn catalog, Then mọi cột *_id có chỉ mục dẫn đầu tenant_id. Test: UAT-AC398.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1.** Vòng đời hợp đồng đủ trạng thái và guard; BOQ có `boq_item`; phiên bản và hiệu lực; khối lượng → nghiệm thu (gắn QMS); bảo lãnh + cảnh báo; liên danh; chuỗi thay đổi 1–3 tầng có khóa; giữ lại và giải tỏa. Màn hình: CTR-01…CTR-08, CTR-10, CTR-12, CTR-13, CTR-19, CTR-20, CTR-21, CTR-22, CTR-25, CTR-26.
**R2.** Bảng điểm và nhật ký vi phạm (CTR-23), xuất CSDL quốc gia (CTR-24), hồi tố, chậm tiến độ và bồi hoàn (CTR-14 sâu hóa), so sánh phiên bản nâng cao. **R3.** Tích hợp Hệ thống mạng đấu thầu quốc gia khi có hợp đồng (D05).

| Hạng mục bắt buộc người duyệt | Giờ dự kiến | Người duyệt |
|---|---|---|
| Bảng chuyển trạng thái hợp đồng, DoA và maker–checker | 4 | Chủ nghiệp vụ |
| Hiệu lực phiên bản, hồi tố, BOQ ổn định (tiền) | 5 | Kế toán trưởng + kiến trúc sư |
| Giữ lại, bảo lãnh, bảo hành (mức theo rule) | 3 | Kế toán / Chủ nghiệp vụ xây dựng [CXN-EXE-04] |
| Bảng điểm và định dạng xuất nhà thầu | 3 | Chủ nghiệp vụ đấu thầu [CXN-EXE-01] |
| Migration hợp đồng đang thực hiện (phiên bản, khối lượng lũy kế) | 4 | Data Owner (D04) |

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| ID | Rủi ro / câu hỏi | Owner | Điều kiện giải quyết |
|---|---|---|---|
| R-CTR-01 | Định dạng và trường bắt buộc khi cung cấp đánh giá/vi phạm nhà thầu theo NĐ 214/2025 Đ19–20 [CXN-EXE-01] | Chủ nghiệp vụ đấu thầu | Văn bản gốc + mẫu tệp của Hệ thống mạng đấu thầu quốc gia |
| R-CTR-02 | Mức giữ lại/bảo lãnh bảo hành theo cấp công trình [CXN-EXE-04] | Chủ nghiệp vụ xây dựng | Văn bản gốc NĐ 06/2021 hợp nhất / NĐ 207/2026 |
| R-CTR-03 | Hợp đồng đang thực hiện khi chuyển đổi có lịch sử phụ lục không đầy đủ | Data Owner | Quy tắc migration: chỉ phiên bản có văn bản mới là EFFECTIVE |
| R-CTR-04 | Interface BID về xung đột lợi ích chưa chốt hợp đồng dữ liệu | Kiến trúc | BID công bố `hasConflict(membership, contractor, at)` |
| R-CTR-05 | Ngưỡng xếp hạng bảng điểm là [GIẢ ĐỊNH] | PO | Chủ nghiệp vụ ký rule `CTR.SCORECARD` |
