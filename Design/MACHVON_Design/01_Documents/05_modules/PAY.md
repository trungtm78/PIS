# PAY — Thanh toán và Kho bạc

Đặc tả phân hệ theo `_KHUNG_DAC_TA.md`. Baseline 1.4, 22/10/2026. Quy ước chung (tenant, RLS, idempotency, audit/outbox, lỗi, i18n, trạng thái UI) nằm ở `04_Thiet_ke_co_ban.md` và `05_Thiet_ke_chi_tiet.md`; tài liệu này chỉ nêu phần riêng của PAY. Mục [CXN-nn] là căn cứ pháp lý chờ xác nhận (sổ xác nhận R4); mục [GIẢ ĐỊNH] là lựa chọn của Claude theo D-B04.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Chủ đầu tư/Ban QLDA phải đề nghị tạm ứng và thanh toán cho nhà thầu theo khối lượng đã nghiệm thu, gửi hồ sơ Kho bạc, đối chiếu số Kho bạc đã thanh toán với số nội bộ và quyết toán dự án. Rủi ro lớn nhất là tiền: trùng đề nghị cho cùng một lần nghiệm thu (hai người, hai màn hình, hai khóa chống lặp), thanh toán vượt khối lượng/giá trị hợp đồng/dự toán, thu hồi tạm ứng sai, nạp lặp sao kê làm cộng đôi, và đóng quyết toán khi còn công nợ. PAY đặt các bất biến này xuống tầng dữ liệu (R7) thay vì tin vào idempotency key.

**Người dùng và giá trị.** Kế toán (lập, gửi), kế toán trưởng/lãnh đạo (kiểm soát, duyệt), cán bộ đối soát (Kho bạc), Sở Tài chính/auditor (đọc, truy vết). Giá trị: không thể thanh toán trùng ở tầng DB, có dấu vết bút toán đảo cho kiểm toán, báo cáo giải ngân dựa trên số Kho bạc xác nhận chứ không phải số đã gửi.

**Trong phạm vi.** (1) Đề nghị thanh toán `INTERIM`/`FINAL`/`ADVANCE` và vòng đời DRAFT→SETTLED; (2) sổ lũy kế hợp đồng × dòng BOQ × nghiệm thu (`cumulative_ledger`, `cumulative_ledger_entry`) với khóa hàng hợp đồng, ràng buộc DB và bút toán đảo (R7); (3) tạm ứng và thu hồi theo NĐ 254/2025: điều kiện, trần theo loại hợp đồng, thu hồi hết ở ngưỡng 80% theo từng thành viên liên danh, tạm ứng GPMB thu hồi trong 30 ngày, chặn vượt dự toán/giá trị hợp đồng, cảnh báo quá hạn; (4) biểu mẫu Kho bạc 03.a/TT, 04.a/TT, 04.b/TT, 05.a/TT sinh qua DOC; (5) nhập sao kê/tệp Kho bạc idempotent (A3) và đối soát chênh lệch có chủ xử lý; (6) quyết toán niên độ và dự án hoàn thành theo TT 91/2025 (mẫu 01–05/QTNĐ, 01–12/QTDA, quyết định 10/QTDA) với hạn thẩm tra theo nhóm dự án; (7) truy vết chuỗi dự án→…→quyết toán.

**Ngoài phạm vi.** Lệnh chi/Kho bạc điện tử thật và TABMIS (không có API công khai cho bên thứ ba: adapter chỉ tệp, trạng thái PROPOSED, API MISSING); hóa đơn điện tử (adapter MISSING, D08); sổ kế toán tổng hợp và giữ vốn (CAP); ký số hồ sơ gửi Kho bạc (DOC); tính thuế (PAY chỉ lưu điều chỉnh thuế có căn cứ); ngoại tệ/ODA (R1 chỉ VND, CHECK `currency = 'VND'`) [GIẢ ĐỊNH].

**Phụ thuộc (theo ID).** CTR (hợp đồng, BOQ, nghiệm thu `acceptance`, giữ lại), CAP (`allocation_line`, kiểm AVC, ghi DISBURSE khi nhận `pay.payment.settled.v1`), DOC (`generateDocumentFromTemplate`), ISS (vướng mắc tự tạo từ hạng mục quá hạn), LND (hoàn ứng GPMB bằng khoản chi), AUD (kết luận trong quyết toán), DIS/MNE (tiêu thụ số liệu đã thanh toán), NOT (cảnh báo). Quan hệ đồ thị: PAY → CTR, CAP, DOC (04 §Đồ thị phụ thuộc).

**Căn cứ.**

| Căn cứ | Áp dụng | Dạng dữ liệu | Trạng thái |
|---|---|---|---|
| NĐ 254/2025/NĐ-CP (thay NĐ 99/2021; chuyển tiếp Điều 54) | Điều kiện tạm ứng, trần theo loại hợp đồng, thu hồi 80% theo thành viên liên danh, GPMB 30 ngày, chặn vượt dự toán/giá trị | `rule_version` các khóa `PAY.ADVANCE.CAP`, `PAY.ADVANCE.RECOVERY`, `PAY.ADVANCE.GPMB_DAYS` (legal_basis + effective_from/until) | [CXN-02] |
| NĐ 254/2025 phụ lục mẫu 03.a, 04.a, 04.b, 05.a/TT (27 mẫu) | Hồ sơ gửi Kho bạc | `DocumentTemplate` (DOC), `payment_form_instance` lưu phiên bản đã dùng | [CXN-08] |
| TT 91/2025/TT-BTC (thay TT 96/2021) | Quyết toán niên độ 01–05/QTNĐ, dự án hoàn thành 01–12/QTDA, quyết định 10/QTDA; hạn thẩm tra theo nhóm | `rule_version` `PAY.SETTLEMENT.VERIFY_DEADLINE`, `DocumentTemplate` | [CXN-09] |
| CV 16437/BTC-ĐTPT | Thời điểm tính giải ngân = ngày Kho bạc thanh toán | `treasury_transaction.confirmed_at` | [CXN-03] |
| Luật ĐTC 58/2024 (sửa 90/2025); quy tắc “không có mã trên Hệ thống TTQG thì không giải ngân” | Chặn tạo đề nghị khi dự án chưa có `national_project_code` | cờ policy tenant | [CXN-01] |
| Thực tiễn thị trường: Primavera Unifier/SAP PSM (đề nghị thanh toán lũy kế theo dòng), Procore (pay application) | Mô hình sổ lũy kế theo dòng × kỳ | — | tham chiếu |

Tham số pháp lý không hard-code: trần tạm ứng theo loại, ngưỡng 80%, số ngày GPMB, hạn thẩm tra theo nhóm là dữ liệu phiên bản. Bản ghi nghiệp vụ lưu id phiên bản đã áp dụng (`cap_rule_version_id`, `deadline_rule_version_id`). Slice dùng tham số CXN-* chưa xác nhận không được DONE; ở môi trường test dùng rule fixture có nhãn “fixture – không phải quy định”.

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Kế toán (maker) | Cây đơn vị chủ đầu tư/Ban QLDA; scope PROJECT hoặc CONTRACT | `payment.create`, `payment.document.attach`, `payment.submit`, `payment.treasury.send`, `advance.request`, `treasury.import` | Duyệt (`payment.verify`) hồ sơ do chính mình tạo/gửi; ghi chung `status` |
| Kế toán trưởng / lãnh đạo (checker) | Như trên, DoA theo số tiền | `payment.verify`, `payment.return`, `payment.reverse`, `reconciliation.resolve`, `settlement.exception.approve` | Tự duyệt hồ sơ mình lập (403 `SELF_APPROVAL_DENIED`, CHECK DB) |
| Cán bộ đối soát | Scope PROJECT/UNIT | `treasury.import`, `treasury.match`, `treasury.confirm_manual`, `reconciliation.assign`, `reconciliation.resolve` | Xóa/sửa giao dịch đã xác nhận (chỉ bút toán đảo) |
| Cán bộ quyết toán | Scope PROJECT | `settlement.open`, `settlement.submit`, `settlement.verify`, `settlement.forms.generate` | Đóng khi còn công nợ không ngoại lệ |
| Người duyệt quyết toán (lãnh đạo) | Scope PROJECT/UNIT | `settlement.close`, `settlement.exception.approve` | Tự duyệt ngoại lệ do mình lập |
| Nhà thầu khách (guest) | Scope CONTRACT | Không có quyền PAY ghi; xem trạng thái đề nghị của hợp đồng mình khi được cấp `payment.read` rút gọn | Thấy sổ lũy kế, tạm ứng, giá trị giữ lại nội bộ, hợp đồng khác |
| Auditor | Scope được cấp, chỉ đọc | `ledger.read`, `payment.chain.read`, `payment.read`, xuất có nguồn | Mọi lệnh ghi |
| Hệ thống (job/Temporal) | Service principal theo tenant | Job cảnh báo tạm ứng, job quá hạn đối soát, workflow nhập tệp | Bỏ qua guard của command; ghi trực tiếp bảng |

Quyền đọc dữ liệu = ranh giới tenant (RLS) ∩ scope grant ∩ phân loại. Trường tiền (gross, thu hồi, giữ lại, net) chỉ trả cho vai trò có `payment.read`; mask bắt buộc cho nhà thầu khách và auditor không được cấp.

## 3. Luồng nghiệp vụ

### 3.1 Đề nghị thanh toán theo sổ lũy kế (UC-PAY-01) — màn hình PAY-01, PAY-02, PAY-03, PAY-10, CTR-13

**Tiền điều kiện.** Nghiệm thu khối lượng (`acceptance`) ở APPROVED, chưa REVOKED; hợp đồng ACTIVE (hoặc ma trận §5.9); dòng vốn `allocation_line` đúng năm kế hoạch; dự án có mã TTQG nếu policy tenant bật [CXN-01]. **Hậu điều kiện.** `payment_request` SUBMITTED giữ đúng một claim lên nghiệm thu; sổ lũy kế và tổng hợp trên `contract` tăng đúng phần đề nghị; bút toán CLAIM append-only; audit + outbox cùng commit.

Luồng chính:
1. Kế toán gọi `createPaymentRequest` (acceptance_id, dòng vốn, số hồ sơ). Máy chủ tính `gross = Σ acceptance_line.amount_vnd`, thu hồi tạm ứng, giữ lại, net (§5); client không gửi gross/net. Có thể tồn tại nhiều bản DRAFT cho cùng nghiệm thu (cảnh báo hiển thị), claim chỉ chiếm ở bước gửi.
2. Đính kèm chứng từ (`attachPaymentDocument`): hóa đơn, biên bản; phát hiện trùng hóa đơn trong hợp đồng (§5.8).
3. Kế toán gọi `post_payment_requests_id_submit` với `expected_gross_vnd` và `expected_net_vnd` (chống màn hình cũ), `If-Match` version và `Idempotency-Key`. Giao dịch (thứ tự khóa cố định để tránh deadlock: hợp đồng → dòng `cumulative_ledger` theo `boq_item_id` tăng dần → `contract_advance` theo `party_id, tranche_no` → CAP qua interface):
   1. `BEGIN`; `SET LOCAL app.tenant_id/actor_id/request_id`; ghi `idempotency_record` (cùng key + cùng hash → trả phản hồi cũ; khác hash → 409 `IDEMPOTENCY_CONFLICT`).
   2. `SELECT … FROM contract WHERE id = :c FOR UPDATE` — mọi lệnh tiền của một hợp đồng tuần tự hóa tại đây.
   3. `SELECT … FROM payment_request WHERE id = :p FOR UPDATE`; kiểm `status = DRAFT` (hoặc RETURNED đã revise) và `version`.
   4. Guard hợp đồng (§5.9): `ACTIVE`, hoặc `SUSPENDED` với nghiệm thu có trước ngày tạm dừng; `TERMINATED` chỉ với `FINAL`.
   5. Guard nghiệm thu: APPROVED, cùng hợp đồng, không REVOKED. Sai → 422 `ACCEPTANCE_NOT_APPROVED`.
   6. **Chiếm claim**: `UPDATE payment_request SET status='SUBMITTED', claims_acceptance=true`. Nếu đã có bản khác giữ claim (kể cả vừa commit trước đó nhờ khóa hợp đồng) → vi phạm unique `payment_request_active_acceptance_uq` → 409 `ACCEPTANCE_ALREADY_CLAIMED`. Thứ tự ưu tiên lỗi: `ACCEPTANCE_ALREADY_CLAIMED` trước `VALUE_EXCEEDED`.
   7. Với từng `payment_request_line`: `UPDATE cumulative_ledger SET requested_vnd += gross, advance_recovered_vnd += recovery, retention_held_vnd += retention`; CHECK `requested ≤ accepted` vi phạm → 409 `VALUE_EXCEEDED` (phòng thủ chiều sâu khi kiểm tra ứng dụng bị bỏ qua).
   8. `UPDATE contract SET requested_total_vnd += gross`; CHECK `contract_ledger_order_chk` và `contract_cash_out_chk` → 409 `VALUE_EXCEEDED`.
   9. Với thu hồi: `UPDATE contract_advance SET recovered_vnd += recovery` theo từng thành viên; CHECK `recovered ≤ paid` → 422 `ADVANCE_RECOVERY_EXCEEDED`.
   10. Gọi CAP `checkAndReserve(allocation_line_id, net)`; từ chối → 422 `ALLOCATION_UNAVAILABLE`.
   11. Ghi bút toán `cumulative_ledger_entry` kind `CLAIM` (mỗi dòng) và `ADVANCE_RECOVERY`, `RETENTION_HOLD`; ghi `retention_hold`; ghi `audit_entry` và `outbox_event pay.payment_request.submitted.v1`; `COMMIT`.
4. Người kiểm soát (khác người lập và người gửi) gọi `verifyPaymentRequest` → VERIFIED.
5. Sinh biểu mẫu (UC-PAY-03), gửi Kho bạc, nhận xác nhận, ghép → SETTLED (§3.3).

Nhánh thay thế/lỗi/hủy: trả hồ sơ (`returnPaymentRequest`) tạo bút toán `CLAIM_RELEASE` đảo đúng bút toán CLAIM, đặt `claims_acceptance=false`, trạng thái RETURNED để sửa và gửi lại; hủy bản DRAFT/RETURNED (`cancelPaymentRequest`). Retry: chỉ retry khi serialization failure/deadlock (tối đa 3), cùng Idempotency-Key.

**Xử lý đồng thời.** Hai người, hai khóa khác nhau, cùng nghiệm thu: lệnh đến sau chờ khóa hàng hợp đồng, sau đó thấy claim đã chiếm → 409 `ACCEPTANCE_ALREADY_CLAIMED`; tuyệt đối không có hai thành công (UAT-AC320). Nếu mã ứng dụng lỗi bỏ sót kiểm tra, DB vẫn chặn: unique một phần (claim) hoặc CHECK `requested ≤ accepted` → `VALUE_EXCEEDED` (UAT-AC321). Idempotency key chỉ chống bấm lặp của cùng actor (UAT-AC345).

### 3.2 Tạm ứng và thu hồi (UC-PAY-02) — PAY-07, PAY-11, PAY-12, CTR-06, LND-07

1. `requestAdvance` kiểm: hợp đồng ACTIVE và đã hiệu lực (`effective_from ≤ hôm nay`); với `kind = CONTRACT` có bảo lãnh tạm ứng ACTIVE + VERIFIED, hạn còn hiệu lực, giá trị bảo lãnh ≥ số tạm ứng; số đề nghị ≤ trần = `cap_pct(loại hợp đồng, bậc giá trị) × giá trị phần việc − Σ tạm ứng đã chi` (rule `PAY.ADVANCE.CAP` [CXN-02]); `kind = GPMB` không cần bảo lãnh nhưng bắt buộc có `recovery_deadline = paid_on + 30 ngày` khi chi [CXN-12].
2. Tạm ứng PLANNED → tạo `payment_request` loại ADVANCE (`createPaymentRequest`), đi qua submit/verify/gửi/ghép như §3.1. Khi Kho bạc xác nhận: `advance_ledger_entry DISBURSE`, `contract_advance.paid_vnd`, `contract.advance_paid_vnd`; status PAID.
3. Thu hồi trong mỗi thanh toán định kỳ theo công thức §5.3; thu hồi ngoài thanh toán (GPMB hoàn ứng bằng khoản chi, hoàn trả tiền) bằng `recordAdvanceRecovery`.
4. Job `advance-overdue` hằng ngày 06:00 giờ VN: mức 1 = T−7, mức 2 = đến hạn, mức 3 = quá hạn (đặt `overdue_since`, tạo vướng mắc ISS `ADVANCE_OVERDUE` một lần), mức 4 = quá hạn ≥ 7 ngày (leo thang lên lãnh đạo phụ trách). Với tạm ứng hợp đồng: quá hạn khi lũy kế thanh toán đạt ngưỡng thu hồi mà `outstanding > 0`, hoặc khi hợp đồng COMPLETED/TERMINATED còn `outstanding > 0`.
5. Không có thao tác nào tự đánh dấu “đã thu hồi”; `acknowledgeAdvanceAlert` chỉ ghi kế hoạch xử lý và hạn.

### 3.3 Kho bạc: biểu mẫu, gửi, nhập sao kê, đối soát (UC-PAY-03) — PAY-04, PAY-05, PAY-06, PAY-09, PAY-13, PAY-14

1. `generatePaymentForms` yêu cầu DOC sinh 03.a/TT, 04.a/TT, 04.b/TT, 05.a/TT từ `DocumentTemplate` có hiệu lực tại ngày lập; template chưa xác nhận [CXN-08] bị từ chối `TEMPLATE_UNCONFIRMED`, hết hiệu lực `TEMPLATE_NOT_EFFECTIVE`. Kết quả lưu `payment_form_instance` (phiên bản mẫu, căn cứ pháp lý, mã băm tệp); sinh lại làm bản cũ SUPERSEDED. Ánh xạ trường (dữ liệu → mẫu): giá trị khối lượng nghiệm thu ← `gross`; thu hồi tạm ứng ← `advance_recovery`; giữ lại ← `retention`; số đề nghị ← `net`; hợp đồng/nhà thầu/dòng vốn/năm kế hoạch ← hợp đồng và `allocation_line`. Mã mẫu và nội dung cột do phụ lục NĐ 254/2025 quyết định [CXN-08], không hard-code trong PAY.
2. `markPaymentSentToTreasury` ghi ngày gửi và số hồ sơ phía Kho bạc (nhập tay hoặc xuất tệp) → SENT_TREASURY; không giả định API.
3. Nhập sao kê/tệp (`importTreasuryStatement`, workflow Temporal): tải tệp (quét virus), tính SHA-256; nếu `(tenant, provider, file_sha256)` đã tồn tại và không FAILED → trả `ALREADY_IMPORTED` với `import_id` cũ, không tạo bản ghi. Với tệp mới, mỗi dòng tính `business_key = provider|so_chung_tu|ngay_chung_tu|ma_du_an_kbnn` và `row_hash`: chưa có → NEW (tạo `treasury_transaction`, nguồn `FILE_IMPORT`); trùng key và trùng hash → DUPLICATE (bỏ qua); trùng key khác hash → CONFLICT (không sửa giao dịch gốc, mở `reconciliation_item DUPLICATE_CONFLICT`); lỗi định dạng → ERROR vào quarantine kèm mã lỗi. Dòng lưu `raw_masked` (che số tài khoản). Hai lần nhập đồng thời cùng tệp: unique `treasury_import_file_uq` bảo đảm đúng một lần áp dụng (UAT-AC333).
4. Ghép: `matchTreasuryTransaction` (hoặc tự động theo `treasury_ref`/số hồ sơ + dòng vốn). Khớp số tiền (`amount = net`) → SETTLED: `cumulative_ledger.paid_vnd`, `contract.paid_total_vnd`, `advance recovered` được ghi nhận, outbox `pay.payment.settled.v1` cho CAP (DISBURSE), DIS/MNE. Lệch → `reconciliation_item AMOUNT_MISMATCH` hiển thị hai cột và chênh lệch; đề nghị giữ SENT_TREASURY; không bao giờ tự chọn số lớn hơn (UAT-AC12).
5. Mỗi hạng mục chênh lệch có `owner_membership_id` và `due_at` bắt buộc; quá hạn tự tạo vướng mắc ISS; xóa sổ cần phê duyệt riêng khác người xử lý.
6. Callback Kho bạc (adapter MOCK ở test, MISSING ở thực tế): `receiveTreasuryCallback` xác thực chữ ký, dedupe theo `provider_event_id` (inbox) và theo khóa nghiệp vụ; gọi lặp trả phản hồi cũ (UAT-AC10).

### 3.4 Đảo bút toán (UC-PAY-04) — PAY-08, PAY-17

`reversePayment` chỉ cho SETTLED, cần lý do, văn bản phê duyệt và giao dịch hoàn trả Kho bạc đã xác nhận (`REFUND` tham chiếu giao dịch gốc). Hệ thống tạo `PAYMENT_REVERSAL`, `ADVANCE_RECOVERY_REVERSAL`, đảo giữ lại và `CLAIM_RELEASE` bằng bút toán mới có `reversal_of_id` (mỗi bút toán chỉ được đảo một lần: unique `cumulative_ledger_entry_reversal_uq`). Không UPDATE/DELETE bút toán. Sau khi đảo toàn bộ, nghiệm thu có thể được claim lại. `getPaymentChain` cho phép truy vết toàn chuỗi (PAY-17).

### 3.5 Quyết toán (UC-PAY-05) — PAY-15, PAY-16, CTR-17

1. `openSettlement` (phạm vi ANNUAL/PROJECT/CONTRACT) lấy số liệu từ sổ lũy kế: `settled_amount_vnd`, `outstanding_vnd`, `unrecovered_advance_vnd`; `refreshSettlementFigures` tính lại khi DRAFT/RETURNED.
2. `submitSettlement` chốt `project_group` tại ngày nộp và tính `verification_due_on = submitted_on + số ngày(nhóm)` bằng rule `PAY.SETTLEMENT.VERIFY_DEADLINE` có hiệu lực [CXN-09]; thiếu nhóm → 422 `PROJECT_GROUP_MISSING`; rule chưa xác nhận → `DEADLINE_RULE_UNCONFIRMED`.
3. `generateSettlementForms` yêu cầu DOC sinh 01–05/QTNĐ (niên độ) hoặc 01–12/QTDA (dự án hoàn thành); 10/QTDA là quyết định phê duyệt quyết toán (văn bản do DOC phát hành).
4. `recordSettlementVerification`: VERIFYING → VERIFIED hoặc RETURNED, kèm tham chiếu kết luận AUD. Job nhắc hạn: T−30, T−7, quá hạn → ISS.
5. Đóng (`post_settlements_id_close`) cần văn bản quyết định ISSUED; còn công nợ/tạm ứng chưa thu thì cần `approveSettlementException` trước (người khác người lập), số công nợ giữ nguyên (UAT-AC66).

## 4. State machine

```
PaymentRequest (INTERIM/FINAL)
 DRAFT ──submit──► SUBMITTED ──verify──► VERIFIED ──send-treasury──► SENT_TREASURY ──match(=net)──► SETTLED ──reverse──► REVERSED
   ▲                  │ return              │ return                   │ return (Kho bạc từ chối)
   │                  ▼                     ▼                          ▼
   └──── revise ── RETURNED ◄───────────────┴──────────────────────────┘
 DRAFT/RETURNED ──cancel──► CANCELLED
 claims_acceptance = true ⇔ SUBMITTED | VERIFIED | SENT_TREASURY | SETTLED (CHECK payment_request_claim_chk)
```

| Từ | Command | Đến | Ai được làm | Guard | Audit/Event |
|---|---|---|---|---|---|
| ∅ | `createPaymentRequest` | DRAFT | `payment.create` | nghiệm thu APPROVED; hợp đồng hợp lệ; request_no không trùng | `pay.payment_request.drafted.v1` |
| DRAFT/RETURNED | `revisePaymentDraft` | DRAFT | `payment.create` | version khớp | `…revised.v1` |
| DRAFT | `post_payment_requests_id_submit` | SUBMITTED | `payment.submit` | §3.1 bước 3.1–3.11; net cân; chứng từ bắt buộc đủ | `pay.payment_request.submitted.v1` |
| SUBMITTED | `verifyPaymentRequest` | VERIFIED | `payment.verify` | khác người tạo và người gửi (CHECK `payment_request_checker_chk`) | `…verified.v1` |
| VERIFIED | `markPaymentSentToTreasury` | SENT_TREASURY | `payment.treasury.send` | đủ biểu mẫu GENERATED | `…sent_treasury.v1` |
| SENT_TREASURY | `matchTreasuryTransaction` | SETTLED | `treasury.match` | giao dịch UNMATCHED, amount = net | `pay.payment.settled.v1` |
| SUBMITTED/VERIFIED/SENT_TREASURY | `returnPaymentRequest` | RETURNED | `payment.return` | lý do; nhả claim bằng CLAIM_RELEASE | `…returned.v1` |
| DRAFT/RETURNED | `cancelPaymentRequest` | CANCELLED | `payment.cancel` | chưa giữ claim | `…cancelled.v1` |
| SETTLED | `reversePayment` | REVERSED | `payment.reverse` | hoàn trả Kho bạc xác nhận; phê duyệt | `pay.payment.reversed.v1` |

Chuyển bị cấm (409 `PAYMENT_STATE_INVALID`): SETTLED→DRAFT/RETURNED; REVERSED/CANCELLED→bất kỳ; SENT_TREASURY→DRAFT; SUBMITTED→SETTLED (bỏ qua Kho bạc); mọi sửa `gross/net/status` trực tiếp.

```
ContractAdvance: PLANNED ─(payment_request ADVANCE submit)─► REQUESTED ─(Kho bạc xác nhận)─► PAID ─(thu hồi đầu tiên)─► RECOVERING ─(recovered = paid)─► FULLY_RECOVERED
                 PLANNED|REQUESTED ──cancel──► CANCELLED        (quá hạn là cờ overdue_since, không phải trạng thái)
TreasuryImport:  RECEIVED ─► PARSED ─► APPLIED | PARTIALLY_APPLIED ;  RECEIVED ─► FAILED (cho phép nhập lại cùng tệp)
ReconciliationItem: OPEN ─► EXPLAINED ─► RESOLVED ;  OPEN|EXPLAINED ─► WRITTEN_OFF_APPROVED (cần văn bản + người duyệt khác)
SettlementRevision: DRAFT ─► SUBMITTED ─► VERIFYING ─► VERIFIED ─► CLOSED ;  SUBMITTED|VERIFYING ─► RETURNED ─► (refresh) DRAFT ;  mọi bản ─► SUPERSEDED khi có revision mới
```

| Từ | Command | Đến | Guard |
|---|---|---|---|
| DRAFT/RETURNED | `submitSettlement` | SUBMITTED | nhóm dự án; rule hạn xác nhận |
| SUBMITTED | `recordSettlementVerification(VERIFYING)` | VERIFYING | `settlement.verify`; khác người nộp |
| VERIFYING | `recordSettlementVerification(VERIFIED|RETURNED)` | VERIFIED/RETURNED | kèm findings |
| VERIFIED | `post_settlements_id_close` | CLOSED | văn bản ISSUED; công nợ = 0 hoặc có ngoại lệ (CHECK `settlement_revision_close_chk`) |

## 5. Quy tắc nghiệp vụ và công thức

Đơn vị: VND nguyên (`numeric(24,0)`), số thập phân khối lượng 6 chữ số; làm tròn HALF_UP trừ khi dòng quy định khác; mẫu số 0 hoặc không áp dụng → kết quả 0 và lý do `NOT_APPLICABLE`.

- **BR-PAY-01 (bất biến R7).** Với mọi khóa `(hợp đồng, boq_item, nghiệm thu, thành viên)`: `0 ≤ paid ≤ requested ≤ accepted`; `advance_recovered + retention_held ≤ requested`. Với hợp đồng: `paid_total ≤ requested_total ≤ accepted_total ≤ contract_value` và `advance_paid + paid_total − advance_recovered ≤ contract_value`. Các điều kiện là CHECK DB; ứng dụng kiểm trước để trả mã lỗi thân thiện.
- **BR-PAY-02 (một nghiệm thu – một claim).** Tối đa một `payment_request` loại INTERIM/FINAL có `claims_acceptance = true` trên một `acceptance_id` (unique một phần). Claim chỉ nhả bằng return/cancel/reverse có lý do.
- **BR-PAY-03 (gross).** `gross = Σ acceptance_line.amount_vnd`, mỗi dòng `= làm tròn(quantity × unit_price_snapshot)` theo `rounding_rule`; `unit_price_snapshot` lấy từ phiên bản hợp đồng EFFECTIVE tại ngày nghiệm thu (CTR).
- **BR-PAY-04 (thu hồi tạm ứng tuyến tính).** Với thành viên m: `V_m` = giá trị phần việc; `θ` = ngưỡng (mặc định 80%) [CXN-02]; `A_m` = tạm ứng đã chi; `G_m` = Σ gross đã đề nghị trước + gross đợt này. Mức đã thu hồi mục tiêu `R_m(G) = floor(A_m × min(1; G / (θ × V_m)))`; thu hồi đợt này `= R_m(G_m) − Σ đã thu hồi`, không âm, không vượt `A_m − Σ đã thu hồi`. Khi `G_m ≥ θ × V_m` thu hồi hết phần còn lại. Ví dụ UAT-AC323: `V = 10.000.000.000`, `A = 2.000.000.000`, `θ = 80%`, `G = 3.000.000.000` → `floor(2.000.000.000 × 3/8) = 750.000.000`. Ví dụ liên danh UAT-AC327: M1 `V = 6.000.000.000`, `A = 900.000.000`; thanh toán 2.400.000.000 → 450.000.000; lũy kế 4.800.000.000 = θV → hết 900.000.000, không phụ thuộc M2. Phương pháp khác (theo tỷ lệ ghi trong hợp đồng) là giá trị khác của tham số `recovery_method` trong rule, vẫn bị chặn trần bởi ngưỡng.
- **BR-PAY-05 (giữ lại).** `retention(dòng) = làm tròn(gross(dòng) × retention_pct(dòng) / 100)`; tổng giữ lại = Σ dòng. Giữ lại lưu `retention_hold` theo dòng; giải tỏa thuộc CTR.
- **BR-PAY-06 (net).** `net = gross − advance_recovery − retention + tax_adjustment`, `tax_adjustment` có dấu, cần `tax_adjustment_basis`. CHECK `payment_request_net_chk` và `payment_request_line_net_chk`. Tổng dòng bằng header.
- **BR-PAY-07 (phân bổ theo dòng).** Thu hồi và giữ lại của header được phân bổ theo tỷ lệ `gross` của dòng bằng phương pháp phần dư lớn nhất: phần nguyên theo sàn, phần dư chia cho dòng có phần thập phân lớn nhất, hòa thì theo `boq_item_id` tăng dần (xác định, lặp lại được). Ví dụ 100 VND trên hai dòng 1/3:2/3 → 33 và 67; 101 VND → 34 và 67 (UAT-AC324).
- **BR-PAY-08 (trùng tham chiếu).** `request_no` duy nhất theo hợp đồng (không override); hóa đơn `(contract, invoice_no)` duy nhất trừ khi có `duplicate_override_reason` + người duyệt có quyền; cùng số hóa đơn ở hợp đồng khác trong tenant chỉ cảnh báo (UAT-AC60). Khối lượng trùng `reference_no` thuộc CTR.
- **BR-PAY-09 (ma trận trạng thái hợp đồng).** ACTIVE: mọi loại. SUSPENDED: INTERIM chỉ cho nghiệm thu có `approved_at` trước `suspended_from`; ADVANCE cấm. TERMINATED: chỉ FINAL cho nghiệm thu đã APPROVED trước ngày chấm dứt. SIGNED/COMPLETED/CLOSED: ADVANCE/INTERIM cấm; COMPLETED cho phép FINAL.
- **BR-PAY-10 (trần tạm ứng).** `cap = cap_pct × V_m − Σ tạm ứng đã chi (PAID, REQUESTED)`; `cap_pct` tra theo `(advance_category, bậc giá trị)` trong rule [CXN-02]. Số đề nghị ≤ cap. Giá trị bảo lãnh tạm ứng ≥ số đề nghị.
- **BR-PAY-11 (GPMB).** `recovery_deadline = paid_on + days` với `days = 30` theo rule `PAY.ADVANCE.GPMB_DAYS` [CXN-12]; cảnh báo mức 1 tại `deadline − 7`, mức 2 tại `deadline`, mức 3 tại `deadline + 1`, mức 4 tại `deadline + 7`.
- **BR-PAY-12 (chặn vượt dự toán).** Hợp đồng `ESTIMATE_BASED` dùng `contract_value_vnd` = dự toán được duyệt; mọi thanh toán + tạm ứng chưa thu hồi không vượt giá trị này (CHECK `contract_cash_out_chk`).
- **BR-PAY-13 (đối soát).** `difference = confirmed − internal` (có dấu); khớp khi `difference = 0`; không có dung sai tự động. Số chênh lệch hiển thị cùng hai số gốc.
- **BR-PAY-14 (năm kế hoạch).** Mỗi đề nghị gắn `allocation_line_id` có `plan_year` ≥ năm của nghiệm thu và còn hạn giải ngân (hoặc đã kéo dài với văn bản); thời điểm tính giải ngân = `confirmed_at` của Kho bạc [CXN-03].
- **BR-PAY-15 (hạn thẩm tra quyết toán).** `verification_due_on = submitted_on + days(project_group)` bằng rule hiệu lực tại ngày nộp [CXN-09]; fixture test: QTQG/A 270 ngày, B 180 ngày, C 120 ngày (không phải quy định). Đổi rule sau không đổi hạn đã áp.
- **BR-PAY-16 (maker ≠ checker).** Người kiểm soát khác người tạo và người gửi; người duyệt ngoại lệ quyết toán khác người lập; xóa sổ đối soát khác chủ xử lý; mọi quyền duyệt theo DoA (ADM).
- **BR-PAY-17 (chống ghi chung).** Không API nào nhận `status`, `gross_vnd`, `net_vnd`, `claims_acceptance` từ client; số tiền do máy chủ tính từ nghiệm thu và sổ.

## 6. Dữ liệu

Phân hệ PAY sở hữu 13 bảng (4 bảng hiện có được mở rộng, 9 bảng mới). Quy ước chung: khóa chính `(tenant_id, id)`, khóa ngoại tổng hợp `(tenant_id, x_id)`, tiền `numeric(24,0)` VND nguyên, mọi bảng ENABLE + FORCE RLS với policy RESTRICTIVE `tenant_boundary` và PERMISSIVE `tenant_access` (04 §PostgreSQL và RLS). Mọi cột `*_id` có chỉ mục `<bảng>_<cột>_idx ON (tenant_id, <cột>)`. Cột NOT NULL thêm vào bảng hiện có được thêm nullable hoặc có DEFAULT, backfill rồi mới SET NOT NULL (expand-contract).

#### Bảng `payment_request` (hiện có, mở rộng)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `project_id`, `contract_id`, `acceptance_id`, `currency`, `gross_vnd`, `advance_recovery_vnd`, `retention_vnd`, `tax_adjustment_vnd`, `net_vnd`, `status`, `version`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `request_kind` | text | có | 'INTERIM' | ∈ {ADVANCE, INTERIM, FINAL} |  |
| `request_no` | text | không |  |  | Số hồ sơ đề nghị (duy nhất theo hợp đồng) |
| `advance_id` | uuid | không |  | FK contract_advance | Chỉ với request_kind = ADVANCE |
| `settlement_revision_id` | uuid | không |  | FK settlement_revision | Chỉ với request_kind = FINAL |
| `allocation_line_id` | uuid | không |  | FK allocation_line | Dòng vốn (nguồn × năm kế hoạch) chịu thanh toán |
| `plan_year` | integer | không |  | plan_year BETWEEN 2000 AND 2100 |  |
| `claims_acceptance` | boolean | có | false |  | true khi đang giữ nghiệm thu (SUBMITTED…SETTLED); nền của unique một phần R7 |
| `treasury_submitted_on` | date | không |  |  |  |
| `treasury_ref` | text | không |  |  | Số hồ sơ/chứng từ phía Kho bạc (nhập tay hoặc từ sao kê) |
| `submitted_by` | uuid | không |  |  |  |
| `submitted_at` | timestamptz | không |  |  |  |
| `verified_by` | uuid | không |  |  |  |
| `verified_at` | timestamptz | không |  |  |  |
| `return_reason` | text | không |  |  |  |
| `cancel_reason` | text | không |  |  |  |
| `reversal_reason` | text | không |  |  |  |
| `reversed_by` | uuid | không |  |  |  |
| `reversed_at` | timestamptz | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `payment_request_net_chk`: net_vnd = gross_vnd - advance_recovery_vnd - retention_vnd + tax_adjustment_vnd
- CHECK `payment_request_amounts_chk`: gross_vnd >= 0 AND advance_recovery_vnd >= 0 AND retention_vnd >= 0 AND advance_recovery_vnd + retention_vnd <= gross_vnd
- CHECK `payment_request_kind_chk`: (request_kind = 'ADVANCE' AND advance_id IS NOT NULL AND acceptance_id IS NULL) OR (request_kind <> 'ADVANCE' AND acceptance_id IS NOT NULL)
- CHECK `payment_request_claim_chk`: claims_acceptance = (request_kind <> 'ADVANCE' AND status IN ('SUBMITTED','VERIFIED','SENT_TREASURY','SETTLED'))
- CHECK `payment_request_checker_chk`: verified_by IS NULL OR (verified_by <> created_by AND verified_by <> submitted_by)
- CHECK `payment_request_reverse_chk`: status <> 'REVERSED' OR (reversal_reason IS NOT NULL AND reversed_by IS NOT NULL)
- UNIQUE INDEX `payment_request_active_acceptance_uq` (tenant_id, acceptance_id) WHERE claims_acceptance
- UNIQUE INDEX `payment_request_active_advance_uq` (tenant_id, advance_id) WHERE request_kind = 'ADVANCE' AND status IN ('SUBMITTED','VERIFIED','SENT_TREASURY','SETTLED')
- UNIQUE INDEX `payment_request_no_uq` (tenant_id, contract_id, request_no) WHERE request_no IS NOT NULL

Chỉ mục: `payment_request_advance_id_idx`, `payment_request_settlement_revision_id_idx`, `payment_request_allocation_line_id_idx`, `payment_request_project_id_idx`, `payment_request_contract_id_idx`, `payment_request_acceptance_id_idx`, `payment_request_contract_status_idx`, `payment_request_treasury_idx`.

#### Bảng `payment_request_line` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `payment_request_id` | uuid | có |  | FK payment_request |  |
| `acceptance_line_id` | uuid | có |  | FK acceptance_line |  |
| `boq_item_id` | uuid | có |  | FK boq_item |  |
| `party_id` | uuid | không |  | FK contract_party |  |
| `gross_vnd` | numeric(24,0) | có |  | gross_vnd >= 0 |  |
| `advance_recovery_vnd` | numeric(24,0) | có | 0 | advance_recovery_vnd >= 0 | Phân bổ pro-rata, phần dư theo phương pháp phần dư lớn nhất |
| `retention_vnd` | numeric(24,0) | có | 0 | retention_vnd >= 0 |  |
| `net_vnd` | numeric(24,0) | có |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `payment_request_line_net_chk`: net_vnd = gross_vnd - advance_recovery_vnd - retention_vnd AND advance_recovery_vnd + retention_vnd <= gross_vnd
- UNIQUE INDEX `payment_request_line_uq` (tenant_id, payment_request_id, acceptance_line_id)

Chỉ mục: `payment_request_line_payment_request_id_idx`, `payment_request_line_acceptance_line_id_idx`, `payment_request_line_boq_item_id_idx`, `payment_request_line_party_id_idx`.

#### Bảng `cumulative_ledger` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `boq_item_id` | uuid | có |  | FK boq_item |  |
| `acceptance_id` | uuid | có |  | FK acceptance |  |
| `party_id` | uuid | không |  | FK contract_party |  |
| `accepted_vnd` | numeric(24,0) | có | 0 |  | Giá trị nghiệm thu đã ghi nhận cho (HĐ × dòng × nghiệm thu) |
| `requested_vnd` | numeric(24,0) | có | 0 |  | Đề nghị còn hiệu lực lũy kế |
| `paid_vnd` | numeric(24,0) | có | 0 |  | Đã thanh toán (Kho bạc xác nhận) lũy kế, giá trị gộp |
| `advance_recovered_vnd` | numeric(24,0) | có | 0 |  | Tạm ứng đã thu hồi qua dòng này |
| `retention_held_vnd` | numeric(24,0) | có | 0 |  | Giữ lại qua dòng này |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `cumulative_ledger_nonneg_chk`: accepted_vnd >= 0 AND requested_vnd >= 0 AND paid_vnd >= 0 AND advance_recovered_vnd >= 0 AND retention_held_vnd >= 0
- CHECK `cumulative_ledger_requested_le_accepted_chk`: requested_vnd <= accepted_vnd
- CHECK `cumulative_ledger_paid_le_requested_chk`: paid_vnd <= requested_vnd
- CHECK `cumulative_ledger_deductions_chk`: advance_recovered_vnd + retention_held_vnd <= requested_vnd
- UNIQUE INDEX `cumulative_ledger_key_uq` (tenant_id, contract_id, boq_item_id, acceptance_id, party_id) NULLS NOT DISTINCT

Chỉ mục: `cumulative_ledger_contract_id_idx`, `cumulative_ledger_boq_item_id_idx`, `cumulative_ledger_acceptance_id_idx`, `cumulative_ledger_party_id_idx`.

#### Bảng `cumulative_ledger_entry` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo. Bảng append-only: `REVOKE UPDATE, DELETE` cho runtime; sửa sai chỉ bằng bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `ledger_id` | uuid | có |  | FK cumulative_ledger |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `boq_item_id` | uuid | có |  | FK boq_item |  |
| `acceptance_id` | uuid | có |  | FK acceptance |  |
| `payment_request_id` | uuid | không |  | FK payment_request |  |
| `entry_kind` | text | có |  | ∈ {RECOGNIZE_ACCEPTANCE, REVOKE_ACCEPTANCE, CLAIM, CLAIM_RELEASE, PAYMENT, PAYMENT_REVERSAL, ADVANCE_RECOVERY, ADVANCE_RECOVERY_REVERSAL, RETENTION_HOLD, RETENTION_RELEASE} |  |
| `accepted_delta_vnd` | numeric(24,0) | có | 0 |  |  |
| `requested_delta_vnd` | numeric(24,0) | có | 0 |  |  |
| `paid_delta_vnd` | numeric(24,0) | có | 0 |  |  |
| `advance_recovery_delta_vnd` | numeric(24,0) | có | 0 |  |  |
| `retention_delta_vnd` | numeric(24,0) | có | 0 |  |  |
| `advance_outstanding_after_vnd` | numeric(24,0) | có |  |  | Số tạm ứng còn lại của hợp đồng/thành viên sau bút toán (ảnh chụp để kiểm toán) |
| `reversal_of_id` | uuid | không |  | FK cumulative_ledger_entry |  |
| `reason` | text | không |  |  |  |
| `posted_at` | timestamptz | có | now() |  |  |
| `request_id` | uuid | có |  |  | correlation_id của command đã ghi |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |

Bất biến DB:
- CHECK `cumulative_ledger_entry_reversal_chk`: (entry_kind IN ('REVOKE_ACCEPTANCE','CLAIM_RELEASE','PAYMENT_REVERSAL','ADVANCE_RECOVERY_REVERSAL')) = (reversal_of_id IS NOT NULL)
- CHECK `cumulative_ledger_entry_reversal_sign_chk`: entry_kind NOT IN ('REVOKE_ACCEPTANCE','CLAIM_RELEASE','PAYMENT_REVERSAL','ADVANCE_RECOVERY_REVERSAL') OR (accepted_delta_vnd <= 0 AND requested_delta_vnd <= 0 AND paid_delta_vnd <= 0 AND advance_recovery_delta_vnd <= 0)
- CHECK `cumulative_ledger_entry_forward_sign_chk`: entry_kind IN ('REVOKE_ACCEPTANCE','CLAIM_RELEASE','PAYMENT_REVERSAL','ADVANCE_RECOVERY_REVERSAL','RETENTION_RELEASE') OR (accepted_delta_vnd >= 0 AND requested_delta_vnd >= 0 AND paid_delta_vnd >= 0 AND advance_recovery_delta_vnd >= 0 AND retention_delta_vnd >= 0)
- UNIQUE INDEX `cumulative_ledger_entry_reversal_uq` (tenant_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL

Chỉ mục: `cumulative_ledger_entry_ledger_id_idx`, `cumulative_ledger_entry_contract_id_idx`, `cumulative_ledger_entry_boq_item_id_idx`, `cumulative_ledger_entry_acceptance_id_idx`, `cumulative_ledger_entry_payment_request_id_idx`, `cumulative_ledger_entry_reversal_of_id_idx`, `cumulative_ledger_entry_request_id_idx`, `cumulative_ledger_entry_ledger_posted_idx`.

#### Bảng `contract_advance` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `party_id` | uuid | có |  | FK contract_party | Thành viên nhận tạm ứng (nhà thầu đơn lẻ = SOLE) |
| `tranche_no` | smallint | có | 1 | tranche_no > 0 |  |
| `kind` | text | có |  | ∈ {CONTRACT, GPMB} |  |
| `amount_vnd` | numeric(24,0) | có |  | amount_vnd > 0 | Số đề nghị tạm ứng |
| `cap_vnd` | numeric(24,0) | có |  |  | Trần tại thời điểm đề nghị = cap_pct(rule) × giá trị phần việc − tạm ứng đã chi |
| `cap_rule_version_id` | uuid | không |  |  | rule registry PAY.ADVANCE.CAP [CXN-02] |
| `guarantee_id` | uuid | không |  | FK guarantee | Bảo lãnh tạm ứng (bắt buộc với kind = CONTRACT) |
| `allocation_line_id` | uuid | không |  | FK allocation_line |  |
| `status` | text | có | 'PLANNED' | ∈ {PLANNED, REQUESTED, PAID, RECOVERING, FULLY_RECOVERED, CANCELLED} |  |
| `paid_vnd` | numeric(24,0) | có | 0 |  |  |
| `recovered_vnd` | numeric(24,0) | có | 0 |  |  |
| `outstanding_vnd` | numeric(24,0) | không |  | sinh: paid_vnd - recovered_vnd |  |
| `paid_on` | date | không |  |  |  |
| `recovery_threshold_pct` | numeric(7,4) | có | 80 | recovery_threshold_pct > 0 AND recovery_threshold_pct <= 100 | Ngưỡng thu hồi hết (80% giá trị phần việc) [CXN-02] |
| `recovery_deadline` | date | không |  |  | GPMB: paid_on + 30 ngày [CXN-12] |
| `overdue_since` | date | không |  |  |  |
| `last_alert_level` | smallint | có | 0 | last_alert_level BETWEEN 0 AND 4 |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `contract_advance_amounts_chk`: paid_vnd <= amount_vnd AND recovered_vnd <= paid_vnd AND amount_vnd <= cap_vnd
- CHECK `contract_advance_guarantee_chk`: kind = 'GPMB' OR guarantee_id IS NOT NULL
- CHECK `contract_advance_paid_chk`: status IN ('PLANNED','REQUESTED','CANCELLED') OR (paid_on IS NOT NULL AND paid_vnd > 0)
- CHECK `contract_advance_gpmb_deadline_chk`: kind <> 'GPMB' OR status IN ('PLANNED','REQUESTED','CANCELLED') OR recovery_deadline IS NOT NULL
- UNIQUE INDEX `contract_advance_tranche_uq` (tenant_id, contract_id, party_id, tranche_no)

Chỉ mục: `contract_advance_contract_id_idx`, `contract_advance_party_id_idx`, `contract_advance_cap_rule_version_id_idx`, `contract_advance_guarantee_id_idx`, `contract_advance_allocation_line_id_idx`, `contract_advance_overdue_idx`.

#### Bảng `advance_ledger_entry` (hiện có, mở rộng)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo. Bảng append-only: `REVOKE UPDATE, DELETE` cho runtime; sửa sai chỉ bằng bút toán đảo.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `contract_id`, `payment_request_id`, `entry_kind`, `amount_vnd`, `reversal_of_id`, `posted_at`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `advance_id` | uuid | không |  | FK contract_advance |  |
| `party_id` | uuid | không |  | FK contract_party |  |
| `outstanding_after_vnd` | numeric(24,0) | có | 0 |  | Số tạm ứng còn lại sau bút toán |
| `reason` | text | không |  |  |  |
| `posted_by` | uuid | không |  |  |  |
| `request_id` | uuid | không |  |  | correlation_id |

Bất biến DB:
- CHECK `advance_ledger_entry_amount_chk`: amount_vnd > 0
- CHECK `advance_ledger_entry_reversal_chk`: (entry_kind IN ('REVERSE_DISBURSE','REVERSE_RECOVER')) = (reversal_of_id IS NOT NULL)
- UNIQUE INDEX `advance_ledger_entry_reversal_uq` (tenant_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL

Chỉ mục: `advance_ledger_entry_advance_id_idx`, `advance_ledger_entry_party_id_idx`, `advance_ledger_entry_request_id_idx`, `advance_ledger_entry_contract_id_idx`, `advance_ledger_entry_payment_request_id_idx`, `advance_ledger_entry_reversal_of_id_idx`.

#### Bảng `treasury_import` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `provider` | text | có | 'KBNN_FILE' |  | Mã bộ chuyển đổi (adapter) — PROPOSED |
| `source_kind` | text | có |  | ∈ {STATEMENT_FILE, EXPORT_FILE} |  |
| `file_name` | text | có |  |  |  |
| `file_sha256` | char(64) | có |  |  |  |
| `file_object_key` | text | có |  |  |  |
| `statement_date` | date | không |  |  |  |
| `row_total` | integer | có | 0 |  |  |
| `row_new` | integer | có | 0 |  |  |
| `row_duplicate` | integer | có | 0 |  |  |
| `row_conflict` | integer | có | 0 |  |  |
| `row_error` | integer | có | 0 |  |  |
| `status` | text | có | 'RECEIVED' | ∈ {RECEIVED, PARSED, APPLIED, PARTIALLY_APPLIED, FAILED} |  |
| `workflow_id` | text | không |  |  | Temporal workflowId |
| `imported_by` | uuid | có |  |  |  |
| `imported_at` | timestamptz | có | now() |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |

Bất biến DB:
- CHECK `treasury_import_counts_chk`: row_total = row_new + row_duplicate + row_conflict + row_error OR status IN ('RECEIVED','FAILED')
- UNIQUE INDEX `treasury_import_file_uq` (tenant_id, provider, file_sha256) WHERE status <> 'FAILED'

Chỉ mục: `treasury_import_workflow_id_idx`.

#### Bảng `treasury_import_row` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `import_id` | uuid | có |  | FK treasury_import |  |
| `row_no` | integer | có |  | row_no > 0 |  |
| `business_key` | text | có |  |  | provider\|so_chung_tu\|ngay_chung_tu\|ma_du_an_kbnn |
| `row_hash` | char(64) | có |  |  |  |
| `outcome` | text | có |  | ∈ {NEW, DUPLICATE, CONFLICT, ERROR} |  |
| `error_code` | text | không |  |  |  |
| `treasury_transaction_id` | uuid | không |  | FK treasury_transaction |  |
| `raw_masked` | jsonb | có |  |  | Bản dòng đã che số tài khoản/định danh; không lưu bản gốc |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |

Bất biến DB:
- CHECK `treasury_import_row_error_chk`: outcome <> 'ERROR' OR error_code IS NOT NULL
- UNIQUE INDEX `treasury_import_row_no_uq` (tenant_id, import_id, row_no)

Chỉ mục: `treasury_import_row_import_id_idx`, `treasury_import_row_treasury_transaction_id_idx`, `treasury_import_row_key_idx`.

#### Bảng `treasury_transaction` (hiện có, mở rộng)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `project_id`, `external_id`, `provider`, `amount_vnd`, `confirmed_at`, `reversal_of_id`, `source_hash`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `contract_id` | uuid | không |  | FK contract |  |
| `payment_request_id` | uuid | không |  | FK payment_request |  |
| `import_id` | uuid | không |  | FK treasury_import |  |
| `allocation_line_id` | uuid | không |  | FK allocation_line |  |
| `plan_year` | integer | không |  |  |  |
| `direction` | text | có | 'PAYMENT' | ∈ {PAYMENT, REFUND} |  |
| `document_no` | text | không |  |  |  |
| `document_date` | date | không |  |  |  |
| `source_kind` | text | có | 'FILE_IMPORT' | ∈ {FILE_IMPORT, MANUAL_CONFIRMED, CALLBACK_MOCK} |  |
| `row_hash` | char(64) | không |  |  |  |
| `match_status` | text | có | 'UNMATCHED' | ∈ {UNMATCHED, MATCHED, EXCEPTION} |  |
| `matched_at` | timestamptz | không |  |  |  |
| `matched_by` | uuid | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `treasury_transaction_amount_chk`: amount_vnd > 0
- CHECK `treasury_transaction_refund_chk`: (direction = 'REFUND') = (reversal_of_id IS NOT NULL)
- CHECK `treasury_transaction_match_chk`: match_status <> 'MATCHED' OR (payment_request_id IS NOT NULL AND matched_at IS NOT NULL)

Chỉ mục: `treasury_transaction_contract_id_idx`, `treasury_transaction_payment_request_id_idx`, `treasury_transaction_import_id_idx`, `treasury_transaction_allocation_line_id_idx`, `treasury_transaction_project_id_idx`, `treasury_transaction_external_id_idx`, `treasury_transaction_reversal_of_id_idx`, `treasury_transaction_match_idx`.

#### Bảng `reconciliation_item` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Theo RetentionPolicy hồ sơ dự án (DOC) [CXN-05]; legal hold chặn xóa.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `project_id` | uuid | có |  | FK project |  |
| `contract_id` | uuid | không |  | FK contract |  |
| `payment_request_id` | uuid | không |  | FK payment_request |  |
| `treasury_transaction_id` | uuid | không |  | FK treasury_transaction |  |
| `import_row_id` | uuid | không |  | FK treasury_import_row |  |
| `kind` | text | có |  | ∈ {AMOUNT_MISMATCH, UNMATCHED_TRANSACTION, MISSING_CONFIRMATION, DUPLICATE_CONFLICT, ADVANCE_OVERDUE} |  |
| `internal_amount_vnd` | numeric(24,0) | không |  |  | Số nội bộ (đề nghị) |
| `confirmed_amount_vnd` | numeric(24,0) | không |  |  | Số Kho bạc xác nhận |
| `difference_vnd` | numeric(24,0) | không |  | sinh: confirmed_amount_vnd - internal_amount_vnd | Chênh lệch (cột sinh) — không tự chọn số lớn hơn |
| `owner_membership_id` | uuid | có |  | FK membership |  |
| `due_at` | timestamptz | có |  |  |  |
| `status` | text | có | 'OPEN' | ∈ {OPEN, EXPLAINED, RESOLVED, WRITTEN_OFF_APPROVED} |  |
| `resolution_note` | text | không |  |  |  |
| `resolved_by` | uuid | không |  |  |  |
| `resolved_at` | timestamptz | không |  |  |  |
| `issue_id` | uuid | không |  | FK issue | Vướng mắc ISS tự tạo khi quá hạn |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `reconciliation_item_resolved_chk`: status NOT IN ('RESOLVED','WRITTEN_OFF_APPROVED') OR (resolution_note IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)

Chỉ mục: `reconciliation_item_project_id_idx`, `reconciliation_item_contract_id_idx`, `reconciliation_item_payment_request_id_idx`, `reconciliation_item_treasury_transaction_id_idx`, `reconciliation_item_import_row_id_idx`, `reconciliation_item_owner_membership_id_idx`, `reconciliation_item_issue_id_idx`, `reconciliation_item_open_idx`.

#### Bảng `payment_document` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `payment_request_id` | uuid | có |  | FK payment_request |  |
| `contract_id` | uuid | có |  | FK contract |  |
| `document_version_id` | uuid | có |  | FK document_version |  |
| `doc_kind` | text | có |  | ∈ {INVOICE, ACCEPTANCE_MINUTES, GUARANTEE, CONTRACT_COPY, TREASURY_FORM, OTHER} |  |
| `checksum` | char(64) | có |  |  |  |
| `invoice_no` | text | không |  |  |  |
| `invoice_date` | date | không |  |  |  |
| `signed` | boolean | có | false |  |  |
| `duplicate_override_reason` | text | không |  |  |  |
| `duplicate_override_by` | uuid | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `payment_document_invoice_chk`: doc_kind <> 'INVOICE' OR (invoice_no IS NOT NULL AND invoice_date IS NOT NULL)
- CHECK `payment_document_override_chk`: (duplicate_override_reason IS NULL) = (duplicate_override_by IS NULL)
- UNIQUE INDEX `payment_document_version_uq` (tenant_id, payment_request_id, document_version_id)
- UNIQUE INDEX `payment_document_invoice_uq` (tenant_id, contract_id, invoice_no) WHERE doc_kind = 'INVOICE' AND duplicate_override_reason IS NULL

Chỉ mục: `payment_document_payment_request_id_idx`, `payment_document_contract_id_idx`, `payment_document_document_version_id_idx`.

#### Bảng `payment_form_instance` (mới)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `tenant_id` | uuid | có |  |  |  |
| `id` | uuid | có |  |  |  |
| `subject_kind` | text | có |  | ∈ {PAYMENT_REQUEST, SETTLEMENT} |  |
| `payment_request_id` | uuid | không |  | FK payment_request |  |
| `settlement_revision_id` | uuid | không |  | FK settlement_revision |  |
| `form_code` | text | có |  |  | Ví dụ 03.a/TT, 04.a/TT, 04.b/TT, 05.a/TT, 01/QTNĐ…12/QTDA [CXN-08, CXN-09] |
| `template_version_id` | uuid | không |  |  | DocumentTemplate version (DOC) — logical ref |
| `outgoing_document_id` | uuid | không |  |  | Văn bản DOC được sinh — logical ref |
| `file_sha256` | char(64) | không |  |  |  |
| `legal_basis` | text | có |  |  | Ảnh chụp căn cứ pháp lý của mẫu tại thời điểm sinh |
| `status` | text | có | 'REQUESTED' | ∈ {REQUESTED, GENERATED, FAILED, SUPERSEDED} |  |
| `generated_at` | timestamptz | không |  |  |  |
| `generated_by` | uuid | không |  |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | có |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | có |  |  |  |
| `version` | bigint | có | 1 |  |  |

Bất biến DB:
- CHECK `payment_form_instance_subject_chk`: (payment_request_id IS NOT NULL) <> (settlement_revision_id IS NOT NULL)
- UNIQUE INDEX `payment_form_request_uq` (tenant_id, payment_request_id, form_code) WHERE status = 'GENERATED'
- UNIQUE INDEX `payment_form_settlement_uq` (tenant_id, settlement_revision_id, form_code) WHERE status = 'GENERATED'

Chỉ mục: `payment_form_instance_payment_request_id_idx`, `payment_form_instance_settlement_revision_id_idx`, `payment_form_instance_template_version_id_idx`, `payment_form_instance_outgoing_document_id_idx`.

#### Bảng `settlement_revision` (hiện có, mở rộng)
Phân loại: Nội bộ – tài chính. Lưu giữ: Giữ như chứng từ kế toán/quyết toán theo danh mục lưu trữ [CXN-05]; không xóa, chỉ bút toán đảo.
Cột hiện có giữ nguyên: `tenant_id`, `id`, `project_id`, `contract_id`, `revision`, `settled_amount_vnd`, `outstanding_vnd`, `unrecovered_advance_vnd`, `audit_finding_refs`, `status`.

| Cột | Kiểu | Bắt buộc | Mặc định | Ràng buộc | Ghi chú |
|---|---|---|---|---|---|
| `settlement_scope` | text | có | 'PROJECT' | ∈ {ANNUAL, PROJECT, CONTRACT} |  |
| `fiscal_year` | integer | không |  | fiscal_year BETWEEN 2000 AND 2100 |  |
| `project_group` | text | không |  | ∈ {QTQG, A, B, C} | Nhóm dự án tại ngày nộp — quyết định hạn thẩm tra [CXN-09] |
| `submitted_on` | date | không |  |  |  |
| `verification_due_on` | date | không |  |  | submitted_on + số ngày theo nhóm (rule data) [CXN-09] |
| `verified_on` | date | không |  |  |  |
| `deadline_rule_version_id` | uuid | không |  |  | rule registry PAY.SETTLEMENT.VERIFY_DEADLINE |
| `decision_document_version_id` | uuid | không |  | FK document_version | Quyết định phê duyệt quyết toán (mẫu 10/QTDA) [CXN-09] |
| `exception_reason` | text | không |  |  | Căn cứ đóng khi còn công nợ/tạm ứng |
| `exception_approved_by` | uuid | không |  |  |  |
| `exception_approved_at` | timestamptz | không |  |  |  |
| `supersedes_id` | uuid | không |  | FK settlement_revision |  |
| `version` | bigint | có | 1 |  |  |
| `created_at` | timestamptz | có | now() |  |  |
| `created_by` | uuid | không |  |  |  |
| `updated_at` | timestamptz | có | now() |  |  |
| `updated_by` | uuid | không |  |  |  |

Bất biến DB:
- CHECK `settlement_revision_money_chk`: settled_amount_vnd >= 0 AND outstanding_vnd >= 0 AND unrecovered_advance_vnd >= 0
- CHECK `settlement_revision_scope_chk`: (settlement_scope <> 'CONTRACT' OR contract_id IS NOT NULL) AND (settlement_scope <> 'ANNUAL' OR fiscal_year IS NOT NULL)
- CHECK `settlement_revision_close_chk`: status <> 'CLOSED' OR ((outstanding_vnd = 0 AND unrecovered_advance_vnd = 0) OR (exception_reason IS NOT NULL AND exception_approved_by IS NOT NULL AND exception_approved_at IS NOT NULL))
- CHECK `settlement_revision_due_chk`: status = 'DRAFT' OR (submitted_on IS NOT NULL AND verification_due_on IS NOT NULL)
- UNIQUE INDEX `settlement_revision_key_uq` (tenant_id, project_id, contract_id, settlement_scope, fiscal_year, revision) NULLS NOT DISTINCT

Chỉ mục: `settlement_revision_deadline_rule_version_id_idx`, `settlement_revision_decision_document_version_id_idx`, `settlement_revision_supersedes_id_idx`, `settlement_revision_project_id_idx`, `settlement_revision_contract_id_idx`, `settlement_revision_due_idx`.


Thứ tự khóa trong giao dịch tiền (bắt buộc để tránh deadlock): `contract` → `cumulative_ledger` (theo `boq_item_id` rồi `acceptance_id`) → `contract_advance` (theo `party_id`, `tranche_no`) → `allocation_balance` (CAP). Không giao dịch nào khóa theo thứ tự ngược lại. Quyền DB: `machvon_app` chỉ INSERT/SELECT trên `cumulative_ledger_entry`, `advance_ledger_entry`; UPDATE trên `cumulative_ledger` chỉ qua hàm lệnh được review.

## 7. API / command

Mọi lệnh ghi: `Idempotency-Key` (≥16 ký tự) bắt buộc; `If-Match` bắt buộc khi đổi bản ghi có version (cột "If-Match" = có); lỗi trả RFC 7807 Problem với `code` ổn định; DTO là allowlist (trường thừa → 400 INVALID_REQUEST); không có endpoint ghi chung cho `status`, `tenant_id`, role hoặc số tiền đã chốt. Mã lỗi chung ngoài bảng: 401 SESSION_EXPIRED, 403 SCOPE_DENIED, 404 RESOURCE_NOT_FOUND, 409 IDEMPOTENCY_CONFLICT, 422 VALIDATION_FAILED, 429 RATE_LIMIT, 503 PROVIDER_UNAVAILABLE.

| operationId | Method path | Quyền (x-permission) | Request DTO (trường được phép; * = bắt buộc) | Response | Lỗi (HTTP + code) | Idempotency | If-Match |
|---|---|---|---|---|---|---|---|
| `createPaymentRequest` | `POST /payment-requests` | `payment.create` | contract_id*, request_kind*, acceptance_id, advance_id, settlement_revision_id, allocation_line_id*, request_no*, tax_adjustment_vnd, tax_adjustment_basis, advance_recovery_extra_vnd | CommandResult | 422 ACCEPTANCE_NOT_APPROVED; 409 ACCEPTANCE_ALREADY_CLAIMED; 409 CONTRACT_STATE_INVALID; 409 PAYMENT_REFERENCE_DUPLICATE; 409 PAYMENT_STATE_INVALID; 422 ALLOCATION_UNAVAILABLE; 422 PLAN_YEAR_MISMATCH; 422 NATIONAL_CODE_REQUIRED; 422 NATIONAL_CODE_FORMAT_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | không |
| `revisePaymentDraft` | `POST /payment-requests/{id}/draft` | `payment.create` | allocation_line_id, request_no, tax_adjustment_vnd, tax_adjustment_basis, advance_recovery_extra_vnd | CommandResult | 409 PAYMENT_STATE_INVALID; 422 PAYMENT_NET_MISMATCH; 409 PAYMENT_REFERENCE_DUPLICATE; 409 ACCEPTANCE_ALREADY_CLAIMED; 409 CONTRACT_STATE_INVALID; 422 ALLOCATION_UNAVAILABLE; 422 PLAN_YEAR_MISMATCH; 422 NATIONAL_CODE_REQUIRED; 422 NATIONAL_CODE_FORMAT_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `attachPaymentDocument` | `POST /payment-requests/{id}/documents` | `payment.document.attach` | document_version_id*, doc_kind*, invoice_no, invoice_date, signed, duplicate_override_reason | CommandResult | 409 INVOICE_DUPLICATE; 422 DOCUMENT_NOT_CLEAN; 409 PAYMENT_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 403 SELF_APPROVAL_DENIED | bắt buộc | không |
| `post_payment_requests_id_submit` | `POST /payment-requests/{id}/submit` | `payment.submit` | expected_gross_vnd*, expected_net_vnd* | PayPaymentCommandResult | 409 ACCEPTANCE_ALREADY_CLAIMED; 409 VALUE_EXCEEDED; 422 ADVANCE_RECOVERY_EXCEEDED; 422 PAYMENT_NET_MISMATCH; 409 CONTRACT_STATE_INVALID; 422 ALLOCATION_UNAVAILABLE; 422 INVOICE_REQUIRED; 409 PAYMENT_STATE_INVALID; 409 VERSION_CONFLICT; 422 ACCEPTANCE_NOT_APPROVED; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | có |
| `verifyPaymentRequest` | `POST /payment-requests/{id}/verify` | `payment.verify` | note | PayPaymentCommandResult | 403 SELF_APPROVAL_DENIED; 409 PAYMENT_STATE_INVALID; 409 VERSION_CONFLICT; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | có |
| `returnPaymentRequest` | `POST /payment-requests/{id}/return` | `payment.return` | reason*, returned_by_treasury | PayPaymentCommandResult | 409 PAYMENT_STATE_INVALID; 409 VERSION_CONFLICT; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | có |
| `cancelPaymentRequest` | `POST /payment-requests/{id}/cancel` | `payment.cancel` | reason* | CommandResult | 409 PAYMENT_STATE_INVALID; 422 VALIDATION_FAILED; 403 SCOPE_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `generatePaymentForms` | `POST /payment-requests/{id}/forms` | `payment.forms.generate` | form_codes*, place* | PayGeneratedPaymentForms | 422 TEMPLATE_NOT_EFFECTIVE; 422 TEMPLATE_UNCONFIRMED; 409 PAYMENT_STATE_INVALID; 503 PROVIDER_UNAVAILABLE; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | không |
| `markPaymentSentToTreasury` | `POST /payment-requests/{id}/send-treasury` | `payment.treasury.send` | treasury_submitted_on*, treasury_ref, form_instance_ids* | PayPaymentCommandResult | 422 FORMS_NOT_GENERATED; 409 PAYMENT_STATE_INVALID; 409 VERSION_CONFLICT; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | có |
| `listPaymentForms` | `GET /payment-requests/{id}/forms` | `payment_request.read` | (không) | PayPaymentFormPage | 403 SCOPE_DENIED | — | không |
| `reversePayment` | `POST /payment-requests/{id}/reverse` | `payment.reverse` | reason (bắt buộc: thiếu → 422 VALIDATION_FAILED), approval_document_version_id (bắt buộc: thiếu → 422 APPROVAL_REQUIRED), refund_treasury_transaction_id (bắt buộc: thiếu hoặc sai → 422 REFUND_NOT_CONFIRMED) | PayReversalResult | 409 PAYMENT_STATE_INVALID; 422 REFUND_NOT_CONFIRMED; 422 APPROVAL_REQUIRED; 422 DOCUMENT_NOT_CLEAN; 403 SELF_APPROVAL_DENIED; 409 ADVANCE_STATE_INVALID; 409 VALUE_EXCEEDED; 409 VERSION_CONFLICT; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | có |
| `importTreasuryStatement` | `POST /treasury-imports` | `treasury.import` | file_object_id*, file_sha256*, source_kind*, statement_date | CommandResult | 422 TREASURY_IMPORT_SCHEMA_INVALID; 422 FILE_NOT_CLEAN; 422 HASH_MISMATCH; 422 VALIDATION_FAILED | bắt buộc | không |
| `confirmTreasuryManually` | `POST /treasury-transactions` | `treasury.confirm_manual` | payment_request_id*, document_no*, document_date*, amount_vnd*, confirmed_at*, evidence_document_version_id* | CommandResult | 409 TREASURY_TRANSACTION_DUPLICATE; 409 PAYMENT_STATE_INVALID; 422 AMOUNT_MISMATCH_OPENED; 403 SELF_APPROVAL_DENIED | bắt buộc | không |
| `receiveTreasuryCallback` | `POST /integrations/treasury/callbacks` | `treasury.callback.receive` | provider_event_id*, provider*, document_no*, document_date*, project_code*, amount_vnd*, direction*, confirmed_at*, signature* | CommandResult | 422 SIGNATURE_INVALID; 409 TREASURY_TRANSACTION_DUPLICATE; 422 VALIDATION_FAILED | bắt buộc | không |
| `matchTreasuryTransaction` | `POST /treasury-transactions/{id}/match` | `treasury.match` | payment_request_id*, note | PayMatchResult | 422 AMOUNT_MISMATCH_OPENED; 409 PAYMENT_STATE_INVALID; 409 TRANSACTION_ALREADY_MATCHED; 422 PLAN_YEAR_MISMATCH; 409 ADVANCE_STATE_INVALID; 409 VALUE_EXCEEDED; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | không |
| `assignReconciliationItem` | `POST /reconciliation-items/{id}/assign` | `reconciliation.assign` | owner_membership_id*, due_at* | PayReconciliationCommandResult | 409 RECONCILIATION_STATE_INVALID; 409 VERSION_CONFLICT; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | có |
| `resolveReconciliationItem` | `POST /reconciliation-items/{id}/resolve` | `reconciliation.resolve` | resolution*, note (bắt buộc: thiếu → 422 VALIDATION_FAILED), approval_document_version_id | PayReconciliationCommandResult | 422 APPROVAL_REQUIRED; 403 SELF_APPROVAL_DENIED; 409 RECONCILIATION_STATE_INVALID; 409 VERSION_CONFLICT; 422 DOCUMENT_NOT_CLEAN; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | có |
| `requestAdvance` | `POST /contracts/{id}/advances` | `advance.request` | party_id*, kind*, amount_vnd*, guarantee_id, allocation_line_id*, tranche_no | PayAdvanceCommandResult | 422 ADVANCE_CONTRACT_NOT_EFFECTIVE; 422 ADVANCE_GUARANTEE_REQUIRED; 422 ADVANCE_CAP_EXCEEDED; 422 ADVANCE_OUTSTANDING_PRIOR; 422 ALLOCATION_UNAVAILABLE; 409 VALUE_EXCEEDED; 422 VALIDATION_FAILED; 422 ADVANCE_RULE_UNCONFIRMED; 403 SCOPE_DENIED | bắt buộc | không |
| `cancelAdvance` | `POST /advances/{id}/cancel` | `advance.cancel` | reason* | PayAdvanceCommandResult | 409 ADVANCE_STATE_INVALID; 409 VERSION_CONFLICT; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | có |
| `recordAdvanceRecovery` | `POST /advances/{id}/recoveries` | `advance.recover` | amount_vnd*, basis*, source_ref_id, evidence_document_version_id* | PayAdvanceCommandResult | 422 ADVANCE_RECOVERY_EXCEEDED; 409 ADVANCE_STATE_INVALID; 409 VERSION_CONFLICT; 422 DOCUMENT_NOT_CLEAN; 422 VALIDATION_FAILED; 403 SCOPE_DENIED | bắt buộc | có |
| `acknowledgeAdvanceAlert` | `POST /advances/{id}/acknowledge-alert` | `advance.alert.ack` | note*, action_plan_due_on* | CommandResult | 422 ADVANCE_NOT_OVERDUE; 409 VERSION_CONFLICT | bắt buộc | có |
| `openSettlement` | `POST /settlements` | `settlement.open` | project_id*, contract_id, settlement_scope*, fiscal_year | CommandResult | 409 SETTLEMENT_OPEN_EXISTS; 422 PROJECT_STAGE_INVALID; 422 VALIDATION_FAILED | bắt buộc | không |
| `refreshSettlementFigures` | `POST /settlements/{id}/refresh` | `settlement.open` | note | CommandResult | 409 SETTLEMENT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `submitSettlement` | `POST /settlements/{id}/submit` | `settlement.submit` | submitted_on* | CommandResult | 422 PROJECT_GROUP_MISSING; 422 DEADLINE_RULE_UNCONFIRMED; 409 SETTLEMENT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `recordSettlementVerification` | `POST /settlements/{id}/verification` | `settlement.verify` | outcome*, findings*, audit_finding_refs | CommandResult | 409 SETTLEMENT_STATE_INVALID; 403 SELF_APPROVAL_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `approveSettlementException` | `POST /settlements/{id}/exception-approval` | `settlement.exception.approve` | reason*, approval_document_version_id* | CommandResult | 422 NO_OUTSTANDING_TO_EXCEPT; 403 SELF_APPROVAL_DENIED; 409 SETTLEMENT_STATE_INVALID; 409 VERSION_CONFLICT | bắt buộc | có |
| `post_settlements_id_close` | `POST /settlements/{id}/close` | `settlement.close` | decision*, reason*, evidence_ids*, decision_document_version_id* | CommandResult | 422 SETTLEMENT_HAS_OUTSTANDING; 409 SETTLEMENT_STATE_INVALID; 422 DECISION_DOCUMENT_REQUIRED; 403 SELF_APPROVAL_DENIED; 409 VERSION_CONFLICT | bắt buộc | có |
| `generateSettlementForms` | `POST /settlements/{id}/forms` | `settlement.forms.generate` | form_codes* | CommandResult | 422 TEMPLATE_NOT_EFFECTIVE; 422 TEMPLATE_UNCONFIRMED; 409 SETTLEMENT_STATE_INVALID; 503 PROVIDER_UNAVAILABLE | bắt buộc | không |
| `getCumulativeLedger` | `GET /contracts/{id}/cumulative-ledger` | `ledger.read` | boq_item_id, acceptance_id, cursor, limit | DTO đọc (read model) | — | 422 VALIDATION_FAILED; 403 SCOPE_DENIED | không |
| `listOverdueAdvances` | `GET /advances/overdue` | `advance.read` | level, cursor, limit | DTO đọc (read model) | — | — | không |
| `getAdvanceRecoveryPlan` | `GET /advances/{id}/recovery-plan` | `advance.read` | (không) | PayAdvanceRecoveryPlan | — | — | không |
| `listAdvances` | `GET /advances` | `advance.read` | contract_id, status, cursor, limit | PayAdvancePage | 422 VALIDATION_FAILED; 403 SCOPE_DENIED | — | không |
| `getPaymentChain` | `GET /payment-chain` | `payment.chain.read` | project_id, contract_id | DTO đọc (read model) | — | — | không |
| `getTreasuryImport` | `GET /treasury-imports/{id}` | `treasury.import.read` | (không) | DTO đọc (read model) | — | — | không |
| `listReconciliationItems` | `GET /reconciliation-items` | `reconciliation.read` | status, owner_membership_id, cursor, limit | PayReconciliationItemPage | 422 VALIDATION_FAILED; 403 SCOPE_DENIED | — | không |
| `getReconciliationItem` | `GET /reconciliation-items/{id}` | `reconciliation.read` | (không) | PayReconciliationItem | 403 SCOPE_DENIED | — | không |
| `getTreasuryTracking` | `GET /treasury-tracking` | `treasury_transaction.read` | cursor, limit | PayTreasuryTrackingPage | 422 VALIDATION_FAILED; 403 SCOPE_DENIED | — | không |

Mô tả ngắn từng lệnh (summary OpenAPI) và guard trạng thái nằm ở `openapi.json` (`x-state-guard`, `x-domain-events`, `x-error-codes`).

Rà soát GET scaffold (`x-contract-maturity: reference-scaffolding`) của tài nguyên thuộc phân hệ:

| Tài nguyên | Quyết định | Lý do |
|---|---|---|
| `/resources/payment_request` (list + get) | DTO riêng | Trường tiền (gross, thu hồi, giữ lại, net) chỉ trả cho vai trò có payment.read; nhà thầu khách không thấy. |
| `/resources/advance_ledger_entry` (list + get) | không expose | Sổ nhật ký tạm ứng chỉ dùng nội bộ; người dùng đọc qua getAdvanceRecoveryPlan và getCumulativeLedger. |
| `/resources/treasury_transaction` (list + get) | DTO riêng | Số tài khoản/định danh giao dịch bị che; chỉ vai trò tài chính thấy số tiền theo dự án trong phạm vi. |
| `/resources/settlement_revision` (list + get) | DTO riêng | Ẩn audit_finding_refs với người không có quyền AUD; số liệu theo phiên bản. |

## 8. UI/UX

Tuân thủ mockup (D-B11): dùng component families của tài liệu 06 (bảng đối soát `reconcile`, biểu mẫu, bảng tài chính `funding`, hộp xác nhận `confirm`, cây `tree`), tokens `design_tokens.json`, chủ đề Ruby/Porcelain; số tiền căn phải, nhóm nghìn, đơn vị “VND” hiển thị cố định, không hiển thị thập phân.

| ID | Tên màn hình | Loại | Nền tảng | Phase | Trường chính | Command / API | Ghi chú nghiệp vụ |
|---|---|---|---|---|---|---|---|
| PAY-10 | Sổ lũy kế hợp đồng × dòng BOQ × nghiệm thu | reconcile | web | P1 | Hợp đồng, Dòng BOQ, Nghiệm thu, Đã nghiệm thu, Đã đề nghị, Đã thanh toán, Tạm ứng còn lại, Giữ lại | `getCumulativeLedger` | Tổng đề nghị ≤ giá trị nghiệm thu ≤ giá trị hợp đồng (CHECK DB); sửa sai bằng bút toán đảo, không xóa (UC-PAY-01) |
| PAY-11 | Đề nghị tạm ứng | form | web | P1 | Hợp đồng, Thành viên, Loại tạm ứng, Số đề nghị, Trần cho phép, Bảo lãnh tạm ứng, Nguồn vốn – năm kế hoạch | `requestAdvance`, `cancelAdvance` | Chỉ sau khi hợp đồng có hiệu lực và có bảo lãnh tạm ứng hợp lệ; không vượt trần theo loại hợp đồng (UC-PAY-02) |
| PAY-12 | Cảnh báo tạm ứng quá hạn và thu hồi | board | web | P1 | Hợp đồng, Thành viên, Còn lại, Hạn thu hồi, Số ngày quá hạn, Mức cảnh báo, Người xử lý | `listOverdueAdvances`, `recordAdvanceRecovery`, `acknowledgeAdvanceAlert` | Tạm ứng GPMB thu hồi trong 30 ngày; cảnh báo T-7, đến hạn, quá hạn, leo thang; không tự đánh dấu đã thu hồi (UC-PAY-02) |
| PAY-13 | Nhập sao kê Kho bạc | import | web | P1 | Tệp, Mã băm SHA-256, Ngày sao kê, Dòng mới, Dòng trùng, Dòng xung đột, Dòng lỗi, Trạng thái | `importTreasuryStatement`, `getTreasuryImport` | Idempotent theo mã băm tệp + khóa nghiệp vụ từng dòng; nạp lại báo đã nạp; dòng lỗi vào quarantine (UC-PAY-03) |
| PAY-14 | Biểu mẫu thanh toán Kho bạc | documents | web | P1 | Mẫu (03.a/TT, 04.a/TT, 04.b/TT, 05.a/TT), Phiên bản mẫu, Căn cứ pháp lý, Trạng thái xác nhận, Tệp sinh, Ngày gửi | `generatePaymentForms`, `markPaymentSentToTreasury` | Mẫu sinh từ DOC theo phiên bản có hiệu lực; mẫu chưa xác nhận [CXN-08] không cho gửi (UC-PAY-03) |
| PAY-15 | Quyết toán niên độ và dự án hoàn thành | review | web | P1 | Phạm vi, Nhóm dự án, Giá trị quyết toán, Công nợ, Tạm ứng chưa thu, Hạn thẩm tra, Ngoại lệ đóng, Trạng thái | `openSettlement`, `refreshSettlementFigures`, `submitSettlement`, `recordSettlementVerification`, `approveSettlementException`, `post_settlements_id_close` | Đóng khi còn công nợ/tạm ứng cần phê duyệt ngoại lệ; hạn thẩm tra theo nhóm dự án (UC-PAY-05) |
| PAY-16 | Biểu mẫu quyết toán và hạn thẩm tra | calendar | web | P1 | Mẫu 01–05/QTNĐ, Mẫu 01–12/QTDA, Quyết định 10/QTDA, Ngày nộp, Hạn thẩm tra, Số ngày còn lại | `generateSettlementForms` | Hạn tính theo nhóm dự án tại ngày nộp bằng rule có hiệu lực; mẫu chưa xác nhận không sinh (UC-PAY-05) |
| PAY-17 | Truy vết chuỗi thanh toán | tree | web | P1 | Dự án, Hợp đồng (phiên bản), Khối lượng, Nghiệm thu, Thanh toán, Kho bạc, Quyết toán | `getPaymentChain` | Chuỗi truy vết theo tenant và phiên bản, chỉ đọc (UC-PAY-04) |

Màn hình hiện có được bổ sung (ID giữ nguyên, theo D-B11 được thêm trường):

- PAY-02: thêm trường "Dòng BOQ / nghiệm thu", "Dòng vốn – năm kế hoạch", "Hạn mức dòng vốn còn lại" (FR-PAY-02).
- PAY-05: thêm trường "Tệp nguồn và mã băm", "Chủ xử lý", "Hạn xử lý" (FR-PAY-05).
- PAY-07: thêm trường "Hạn thu hồi", "Ngưỡng 80% theo thành viên", "Số ngày quá hạn" (FR-PAY-07).

**Trạng thái màn hình.** 7 trạng thái chuẩn (loading, populated, empty, validation error, service error, permission denied, stale) cho mọi màn hình PAY. Trạng thái riêng: PAY-02/PAY-10 “đã bị người khác chiếm nghiệm thu” (hiển thị mã `ACCEPTANCE_ALREADY_CLAIMED` và người/hồ sơ đang giữ, không lộ chi tiết ngoài scope); PAY-13 “đã nạp” (ALREADY_IMPORTED trỏ tới lần nạp cũ); PAY-14/PAY-16 “mẫu chưa xác nhận CXN-*” khóa nút gửi; PAY-12 “quá hạn mức n”. Dữ liệu tiền stale: hiển thị thời điểm snapshot và buộc `expected_gross_vnd/expected_net_vnd` khi gửi.

**Validation.** Số tiền do máy chủ tính (chỉ đọc); `tax_adjustment` bắt buộc căn cứ; `request_no` bắt buộc; ngày theo múi giờ VN; tệp sao kê giới hạn kích thước theo quota tenant, định dạng theo mẫu adapter.

**Quyền thao tác.** Nút “Gửi”, “Kiểm soát”, “Đảo” chỉ hiện khi có quyền và trạng thái cho phép; nút bị ẩn khi người dùng là người lập (maker–checker) và hiển thị lý do khi tooltip.

**Web/mobile.** Web đầy đủ. Mobile (MOB-27 theo dõi thanh toán, MOB-60 đối soát Kho bạc, thuộc MOB) chỉ đọc trạng thái, số liệu đối soát và nhận cảnh báo; mọi trường tiền ở chế độ chỉ đọc, không gửi/duyệt từ cache offline (04 §PowerSync). Bảng `cumulative_ledger`, `reconciliation_item` không nằm trong hợp đồng sync trừ cột trạng thái cho MOB-27/MOB-60 [GIẢ ĐỊNH].

## 9. Sự kiện, job, tích hợp, quan sát

**Domain event (phát qua outbox, tên `pay.<aggregate>.<past>.v<n>`).** `pay.payment_request.submitted.v1` {payment_request_id, contract_id, acceptance_id, gross_vnd, net_vnd, allocation_line_id, plan_year}; `pay.payment_request.returned.v1`; `pay.payment.settled.v1` {payment_request_id, contract_id, project_id, amount_vnd, allocation_line_id, plan_year, confirmed_at} → CAP ghi DISBURSE, DIS/MNE cập nhật; `pay.payment.settled.v2` = v1 kèm `treasury_paid_on` (ngày Kho bạc xác nhận, giờ Việt Nam) và `request_kind`; `pay.payment.reversed.v1` {payment_request_id, contract_id, project_id, amount_vnd, allocation_line_id, plan_year, request_kind, refund_transaction_id, refund_confirmed_at, treasury_paid_on (ngày Kho bạc xác nhận khoản đã trả)} → CAP đảo DISBURSE, DIS/MNE trừ lại; `pay.advance.planned.v1`/`recovered.v1`/`alert_acknowledged.v1`; `pay.treasury_import.applied.v1` {import_id, row_new, row_conflict}; `pay.treasury_transaction.confirmed.v1`/`matched.v1`; `pay.reconciliation.assigned.v1`/`resolved.v1`/`overdue.v1` {source_ref_id, reference_code, project_id, contract_id, owner_unit_id, severity} (ISS mở vướng mắc); `pay.settlement.opened/submitted/verified/closed.v1`; `pay.payment_form.requested.v1` (consumer DOC; quyết toán), `pay.payment_form.generated.v1` {payment_request_id, forms[form_code, template_code, template_revision, file_sha256, payload_sha256]} (biểu mẫu Kho bạc đã sinh). Payload tối thiểu, không PII; consumer idempotent bằng `inbox_record (consumer, event_id)`.

**Sự kiện nhận.** `ctr.acceptance.approved.v1` (tạo `cumulative_ledger` và bút toán RECOGNIZE_ACCEPTANCE), `ctr.acceptance.revoked.v1` (REVOKE_ACCEPTANCE, chỉ khi không còn claim), `ctr.contract.suspended/terminated.v1` (cập nhật ma trận §5.9), `lnd.compensation.paid.v1` (gợi ý hoàn ứng GPMB, thao tác thu hồi vẫn qua command), `doc.document.issued.v1` (biểu mẫu/quyết định 10/QTDA đã phát hành).

**Job/Temporal.** Workflow `treasury-import` (quét virus → parse → áp dụng từng lô trong transaction ngắn, activity idempotent theo `import_id/row_no`); job `advance-overdue` (06:00 VN); job `reconciliation-overdue` (mỗi giờ); job `settlement-deadline` (06:00 VN: T−30, T−7, quá hạn); mỗi job mang `tenant_id` trong memo/search attribute, key `wf:{workflowId}:{activityId}`.

**Tích hợp.** Adapter Kho bạc: tệp sao kê/xuất hồ sơ, PROPOSED; callback MOCK; API MISSING (04 §Tích hợp). Hóa đơn điện tử MISSING (D08). Mọi “gọi ngoài” đều qua port/adapter có mock có contract; trạng thái adapter hiển thị trên PAY-13.

**Cache key.** `t:{tenant_id}:pay:ledger:{contract_id}:v{contract.version}` (TTL 60 giây, vô hiệu khi có `pay.*` của hợp đồng); không cache dữ liệu tiền làm nguồn sự thật.

**Quan sát.** Metric: `pay_submit_total{outcome,problem_code}`, `pay_claim_conflict_total`, `pay_value_exceeded_total`, `pay_ledger_lock_wait_seconds`, `pay_treasury_import_rows{outcome}`, `pay_reconciliation_open`, `pay_advance_overdue`, `pay_settlement_overdue`. Log: không ghi số tài khoản, họ tên; chỉ id. Cảnh báo: `pay_value_exceeded_total` > 0 từ CHECK DB (tức ứng dụng bỏ sót), `pay_ledger_lock_wait_seconds` p95 > 2 giây, `reconciliation backlog` quá hạn > 0.

## 10. Kiểm thử

Bộ fixture synthetic dùng chung được định nghĩa tại `PAY.md` §10 (nhãn [EXE-FX]); mọi ID/người dùng trong bảng là dữ liệu giả. Các test dưới đây là nguồn của `test_cases.json` (ID `UAT-AC…`); loại: domain / integration / security / concurrency / performance / E2E.

**Fixture EXE-FX** — tenant TNT-A (UBND tỉnh A) và TNT-B; đơn vị CDT-A-01 (Ban QLDA giao thông A), SOTC-A (Sở Tài chính A), UBND-XA-A1 (xã A1), TTQD-A (Trung tâm phát triển quỹ đất A); dự án PRJ-A-001 "Đường tỉnh ĐT.A1 km0–km12" (nhóm B); nhà thầu NT-A-01 (Công ty TNHH Xây dựng Minh An, synthetic); hợp đồng HD-A-001 đơn giá cố định 10.000.000.000 VND, ACTIVE từ 2026-03-01, BOQ B01 đào đất 8.000 m3 × 500.000 = 4.000.000.000, B02 bê tông 2.500 m3 × 2.000.000 = 5.000.000.000, B03 hoàn thiện 500 m2 × 2.000.000 = 1.000.000.000; nghiệm thu NT-A-001 kỳ 2026-06: B01 4.000 m3 = 2.000.000.000, B02 500 m3 = 1.000.000.000 (tổng 3.000.000.000); tạm ứng ADV-A-001 2.000.000.000 chi 2026-03-15; giữ lại 5% trên gross; người dùng: u.ketoan, u.ketoan2 (kế toán), u.ktt (kế toán trưởng), u.cv.hd (chuyên viên hợp đồng), u.lanhdao (lãnh đạo duyệt), u.gs (tư vấn giám sát, khách), u.nt (nhà thầu NT-A-01, khách), u.audit (auditor), u.b.ketoan (TNT-B).

Quy tắc dữ liệu giả của fixture: tham số rule pháp lý (trần tạm ứng, hạn thẩm tra, mốc ngày GPMB, thời hạn bảo hành, ngưỡng GPS) được cấp bằng rule fixture có nhãn "fixture – không phải quy định"; slice thật chỉ DONE khi các mục CXN-* tương ứng đã xác nhận (R4).

| ID | Loại | Ưu tiên | Tình huống | Setup | Input | Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|---|---|
| UAT-AC10 | business | P0 | Cùng callback Kho bạc hai lần chỉ tạo một giao dịch | [EXE-FX] PR-A-001 (HD-A-001, NT-A-001) ở SENT_TREASURY, net 2.100.000.000; adapter Kho bạc ở trạng thái MOCK; chưa có treasury_transaction nào của PR-A-001. | POST /integrations/treasury/callbacks với provider_event_id=EVT-KB-0001, document_no=CT-0001, document_date=2026-07-02, project_code=PRJ-A-001, amount_vnd=2100000000, direction=PAYMENT, chữ ký HMAC hợp lệ; gửi lại đúng body lần 2; sau đó gửi provider_event_id=EVT-KB-0002 nhưng cùng document_no/document_date/project_code. | 1. Gửi callback EVT-KB-0001 lần 1, ghi status/body và số dòng treasury_transaction (đếm theo tenant+provider+external_id). 2. Gửi lại callback EVT-KB-0001 lần 2 với cùng Idempotency-Key và cùng body; so sánh body với lần 1. 3. Gửi EVT-KB-0002 (event khác, cùng khóa nghiệp vụ CT-0001\|2026-07-02\|PRJ-A-001). 4. Đọc PR-A-001, contract.paid_total_vnd, cumulative_ledger.paid_vnd và số outbox pay.payment.settled.v1. | cùng callback hai lần chỉ tạo một giao dịch. Cụ thể: Lần 1: 200, tạo đúng 1 treasury_transaction (amount 2.100.000.000, source_kind=CALLBACK_MOCK), PR-A-001 chuyển SETTLED. Lần 2: 200 với body y hệt lần 1, số dòng vẫn 1. EVT-KB-0002: 409 TREASURY_TRANSACTION_DUPLICATE, số dòng vẫn 1. contract.paid_total_vnd = 3.000.000.000 (không phải 6.000.000.000); đúng 1 outbox pay.payment.settled.v1. | Log request/response ba lần gọi; kết quả SELECT count(*) trước/sau; dump outbox_event |
| UAT-AC11 | business | P0 | Nhập sao kê lặp không cộng hai lần trong tổng đối soát | [EXE-FX] Tệp KB-A-2026-06-30.csv (3 dòng: CT-0001 2.100.000.000; CT-0002 450.000.000; CT-0003 120.000.000; tổng 2.670.000.000) SHA-256 = HASH-F1; tệp KB-A-2026-07-01.csv chứa lại đúng 3 dòng trên cộng dòng CT-0004 300.000.000, SHA-256 = HASH-F2. | POST /treasury-imports lần lượt với F1, F1 lần 2, F2; sau đó mở PAY-05 xem tổng đối soát. | 1. Nhập F1; đọc treasury_import (row_total, row_new, row_duplicate). 2. Nhập lại F1 (Idempotency-Key mới); đọc result và số bản ghi treasury_import. 3. Nhập F2; đọc row_new/row_duplicate và số treasury_transaction. 4. Tính tổng amount_vnd các treasury_transaction của PRJ-A-001 và so với tổng hiển thị ở PAY-05. | tổng đối soát không cộng cả bản gốc và bản nhập lặp. Cụ thể: F1: status APPLIED, row_new=3, tổng 2.670.000.000. F1 lần 2: result=ALREADY_IMPORTED, không tạo treasury_import mới (đếm vẫn 1). F2: row_duplicate=3, row_new=1, treasury_transaction tổng = 4 dòng; tổng đối soát = 2.970.000.000 (không phải 5.640.000.000). | Bảng treasury_import, treasury_import_row, ảnh chụp PAY-05 |
| UAT-AC12 | business | P0 | Số nội bộ khác số xác nhận hiển thị hai cột và sai lệch | [EXE-FX] PR-A-002 net 1.000.000.000 ở SENT_TREASURY; sao kê xác nhận CT-0201 amount 990.000.000 cho PR-A-002; u.ktt là chủ xử lý được giao. | Nhập sao kê chứa CT-0201 rồi chạy matchTreasuryTransaction; mở PAY-05 và PAY-06; sau đó resolveReconciliationItem. | 1. Nhập sao kê và ghép CT-0201 với PR-A-002. 2. Đọc reconciliation_item: kind, internal_amount_vnd, confirmed_amount_vnd, difference_vnd, owner_membership_id, due_at. 3. Mở PAY-05: đọc hai cột và cột chênh lệch; kiểm trạng thái PR-A-002. 4. Gọi resolve với resolution=EXPLAINED không có note rồi có note "Kho bạc trừ phí 10.000.000 theo thông báo TB-77". | số nội bộ khác số xác nhận hiển thị hai cột và sai lệch, không tự chọn số lớn hơn. Cụ thể: Tạo 1 reconciliation_item AMOUNT_MISMATCH: internal 1.000.000.000, confirmed 990.000.000, difference −10.000.000; PAY-05 hiển thị cả hai số và chênh lệch −10.000.000, không tự chọn số lớn hơn. PR-A-002 vẫn SENT_TREASURY, contract.paid_total_vnd không tăng. resolve không có note: 422 VALIDATION_FAILED; có note: item EXPLAINED, ghi audit. due_at và owner bắt buộc (không null). | Bản ghi reconciliation_item, ảnh PAY-05, audit_entry |
| UAT-AC60 | business | P1 | Phát hiện trùng hóa đơn, khối lượng và số hồ sơ thanh toán | [EXE-FX] PR-A-001 có chứng từ hóa đơn invoice_no=HD-0001234 (2026-07-01); measurement M-A-010 có reference_no=KL-2026-06-B01; PR-A-001 có request_no=DNTT-001; u.cv.hd có quyền payment.document.attach; u.ktt có quyền duyệt ngoại lệ trùng. | Đính kèm HD-0001234 vào PR-A-003 cùng hợp đồng; ghi measurement mới reference_no=KL-2026-06-B01; tạo payment request request_no=DNTT-001; lặp lại với duplicate_override_reason. | 1. attachPaymentDocument PR-A-003 với invoice_no=HD-0001234 không override. 2. recordMeasurement với reference_no=KL-2026-06-B01 cùng hợp đồng HD-A-001. 3. createPaymentRequest với request_no=DNTT-001 cùng HD-A-001. 4. attachPaymentDocument lần nữa kèm duplicate_override_reason="Hóa đơn điều chỉnh theo thông báo 12/TB" bởi u.ktt; đọc payment_document và audit. 5. Đính kèm hóa đơn HD-0001234 cho hợp đồng HD-A-009 (hợp đồng khác). | duplicate invoice/measurement/payment reference phát hiện trong tenant và hợp đồng; override có căn cứ. Cụ thể: Bước 1: 409 INVOICE_DUPLICATE. Bước 2: 409 MEASUREMENT_REFERENCE_DUPLICATE. Bước 3: 409 PAYMENT_REFERENCE_DUPLICATE (không có override cho số hồ sơ thanh toán). Bước 4: 200, payment_document có duplicate_override_reason và duplicate_override_by=u.ktt, audit ghi lý do; bước 5: 200 kèm cảnh báo cấp tenant DUPLICATE_INVOICE_OTHER_CONTRACT (không chặn). | Response 409/200, bảng payment_document, audit_entry |
| UAT-AC61 | business | P1 | Tổng lũy kế thu hồi tạm ứng không vượt gốc tạm ứng | [EXE-FX] ADV-A-001 gốc 2.000.000.000 đã PAID; đã thu hồi 750.000.000 (PR-A-001); còn lại 1.250.000.000; ngưỡng thu hồi 80% chưa đạt. | recordAdvanceRecovery amount_vnd=1300000000; sau đó 1250000000; sau đó reversal một phần. | 1. Gọi recordAdvanceRecovery 1.300.000.000 basis=REFUND. 2. Gọi recordAdvanceRecovery 1.250.000.000. 3. Đọc contract_advance (paid, recovered, outstanding) và contract.advance_recovered_vnd. 4. Thử UPDATE trực tiếp contract_advance SET recovered_vnd = 2000000001 bằng role machvon_app. | tổng lũy kế thu hồi tạm ứng không vượt gốc tạm ứng sau điều chỉnh hợp lệ. Cụ thể: Bước 1: 422 ADVANCE_RECOVERY_EXCEEDED (vượt 50.000.000), không có bút toán. Bước 2: 200, recovered_vnd = 2.000.000.000, outstanding = 0, status FULLY_RECOVERED, contract.advance_recovered_vnd = 2.000.000.000 = advance_paid_vnd. Bước 4: lỗi CHECK contract_advance_amounts_chk (recovered ≤ paid), dòng không đổi. | Response, bảng contract_advance/advance_ledger_entry, lỗi SQLSTATE 23514 |
| UAT-AC64 | business | P1 | Số net không cân thì chặn gửi; làm tròn theo quy tắc hợp đồng | [EXE-FX] PR-A-001 DRAFT: gross 3.000.000.000, thu hồi tạm ứng 750.000.000, giữ lại 150.000.000, điều chỉnh thuế 0, net 2.100.000.000; dòng BOQ B09 của HD-A-003 có quantity 3, unit_price 1234,5 với rounding_rule HALF_UP; dòng B10 cùng số liệu rounding_rule DOWN. | submit với expected_net_vnd=2100000001; sau đó expected_net_vnd=2100000000; chèn trực tiếp payment_request net sai; tính amount_vnd cho B09/B10. | 1. POST submit với expected_gross_vnd=3000000000, expected_net_vnd=2100000001. 2. POST submit với expected_net_vnd=2100000000. 3. INSERT trực tiếp payment_request với gross=100, advance_recovery=10, retention=5, tax_adjustment=0, net=86 bằng role machvon_app. 4. Tạo BOQ B09 và B10 rồi đọc amount_vnd. | số net không cân với các cấu phần thì chặn gửi; rounding dùng quy tắc currency/contract version. Cụ thể: Bước 1: 422 PAYMENT_NET_MISMATCH, trạng thái vẫn DRAFT, không bút toán sổ. Bước 2: 200 SUBMITTED. Bước 3: lỗi CHECK payment_request_net_chk (net phải = 85). B09: amount_vnd = 3.704 (3703,5 làm tròn lên); B10: 3.703; rule làm tròn lưu cùng dòng. | Response 422/200, lỗi CHECK, bảng boq_line |
| UAT-AC66 | business | P1 | Đóng quyết toán khi còn công nợ/tạm ứng cần phê duyệt ngoại lệ | [EXE-FX] SR-A-001 (PROJECT, nhóm B) ở VERIFIED: settled 9.850.000.000, outstanding_vnd 150.000.000, unrecovered_advance_vnd 0; QĐ phê duyệt DOC-QD-001 đã có; u.lanhdao có quyền settlement.exception.approve; u.ktt là người lập. | closeSettlement không ngoại lệ; approveSettlementException bởi chính người lập; bởi u.lanhdao; closeSettlement lại. | 1. POST /settlements/{SR-A-001}/close với decision_document_version_id=DOC-QD-001. 2. POST exception-approval bởi u.ktt (người lập) với reason. 3. POST exception-approval bởi u.lanhdao với reason="Công nợ chờ bảo lãnh bảo hành theo biên bản 05/BB" và approval_document_version_id. 4. POST close lần 2; đọc settlement_revision và hợp đồng. | close khi còn công nợ/tạm ứng cần exception approval, không tự coi bằng zero. Cụ thể: Bước 1: 422 SETTLEMENT_HAS_OUTSTANDING (outstanding 150.000.000), không tự coi bằng 0. Bước 2: 403 SELF_APPROVAL_DENIED. Bước 3: 200, lưu exception_reason, exception_approved_by=u.lanhdao. Bước 4: 200, status CLOSED, outstanding_vnd vẫn 150.000.000 (không bị ghi đè), ràng buộc settlement_revision_close_chk thỏa nhờ ngoại lệ. | Response, bản ghi settlement_revision trước/sau, audit_entry |
| UAT-AC67 | business | P1 | Truy vết chuỗi dự án → hợp đồng → khối lượng → nghiệm thu → thanh toán → Kho bạc → quyết toán | [EXE-FX] Chuỗi hoàn chỉnh PRJ-A-001 → HD-A-001 rev1 → M-A-010/M-A-011 → NT-A-001 → PR-A-001 → CT-0001 → SR-A-001 rev1; chuỗi tương tự thuộc TNT-B; u.audit có scope PROJECT PRJ-A-001; u.b.ketoan thuộc TNT-B. | GET /payment-chain?project_id=PRJ-A-001&contract_id=HD-A-001 bởi u.audit; cùng truy vấn bởi u.b.ketoan; GET với project_id của TNT-B bởi u.audit. | 1. Gọi getPaymentChain bởi u.audit; kiểm từng nút và version. 2. Sửa measurement M-A-010 qua correctMeasurement tạo bản 2, gọi lại chuỗi. 3. Gọi bởi u.b.ketoan với project_id PRJ-A-001. 4. Gọi bởi u.audit với project_id thuộc TNT-B. | toàn bộ chuỗi dự án → hợp đồng → measurement → acceptance → payment → treasury → settlement truy vết được theo tenant và phiên bản. Cụ thể: Bước 1: 7 nút theo thứ tự project, contract(revision 1), measurement, acceptance, payment_request, treasury_transaction, settlement_revision, mỗi nút có id và version; tổng nút payment = 3.000.000.000 gross. Bước 2: chuỗi hiển thị measurement revision 2 và đánh dấu revision 1 SUPERSEDED, acceptance NT-A-001 giữ liên kết revision đã dùng. Bước 3 và 4: 404 RESOURCE_NOT_FOUND, không lộ tồn tại. | JSON chuỗi, ảnh PAY-17, log truy vấn tenant B |
| UAT-AC320 | concurrency | P0 | R7: hai người, hai khóa idempotency, cùng một nghiệm thu | [EXE-FX] PR-A-101 (u.ketoan, request_no DNTT-101) và PR-A-102 (u.ketoan2, request_no DNTT-102) cùng DRAFT, version 1, cùng acceptance_id=NT-A-001 (accepted 3.000.000.000); cumulative_ledger: (HD-A-001,B01,NT-A-001) accepted 2.000.000.000 requested 0; (B02) accepted 1.000.000.000 requested 0; contract.requested_total_vnd=0. | Hai request submit đồng thời có rào đồng bộ: POST /payment-requests/PR-A-101/submit (Idempotency-Key K-AC320-0001, If-Match "1") và POST /payment-requests/PR-A-102/submit (K-AC320-0002, If-Match "1"), cùng expected_gross_vnd=3000000000, expected_net_vnd=2100000000. | 1. Dựng lại fixture cho mỗi vòng; chạy 50 vòng, mỗi vòng hai luồng khởi chạy sau cùng một barrier. 2. Ghi status/code của từng luồng. 3. Sau mỗi vòng đọc: SELECT count(*) FROM payment_request WHERE acceptance_id=NT-A-001 AND claims_acceptance; cumulative_ledger.requested_vnd từng dòng; contract.requested_total_vnd; số cumulative_ledger_entry kind CLAIM. 4. Chạy thêm 10 vòng với kiểm tra ứng dụng bị tắt (test hook ở repository) để kiểm chứng ràng buộc DB. | Mọi vòng: đúng 1 phản hồi 200 và 1 phản hồi 409 code ACCEPTANCE_ALREADY_CLAIMED; không bao giờ 2 phản hồi 200. Trạng thái cuối: đúng 1 payment_request claims_acceptance=true; requested_vnd B01=2.000.000.000, B02=1.000.000.000 (không nhân đôi); contract.requested_total_vnd=3.000.000.000; đúng 2 bút toán CLAIM (mỗi dòng 1); bên thua không có bút toán, vẫn DRAFT. Khi tắt kiểm tra ứng dụng: bên thua nhận 409 với code ACCEPTANCE_ALREADY_CLAIMED (từ unique payment_request_active_acceptance_uq) hoặc VALUE_EXCEEDED (từ CHECK cumulative_ledger_requested_le_accepted_chk), vẫn đúng 1 thành công. | Bảng kết quả 60 vòng (status, code), SELECT trạng thái cuối, log lỗi SQLSTATE 23505/23514 đã ánh xạ |
| UAT-AC321 | security | P0 | Ràng buộc DB chặn trùng claim và vượt giá trị khi bỏ qua ứng dụng | [EXE-FX] PR-A-001 SUBMITTED giữ claim NT-A-001 (claims_acceptance=true); cumulative_ledger B01 accepted 2.000.000.000 requested 2.000.000.000; kết nối bằng role machvon_app với app.tenant_id=TNT-A. | Các câu SQL trực tiếp: INSERT payment_request thứ hai (claims_acceptance=true, acceptance_id=NT-A-001); UPDATE cumulative_ledger SET requested_vnd=2000000001; UPDATE contract SET requested_total_vnd=3000000001; DELETE FROM cumulative_ledger_entry; UPDATE cumulative_ledger_entry SET requested_delta_vnd=0. | 1. Chạy INSERT payment_request trùng claim. 2. Chạy UPDATE cumulative_ledger vượt accepted. 3. Chạy UPDATE contract vượt accepted_total. 4. Chạy DELETE và UPDATE trên cumulative_ledger_entry. 5. Chạy lại câu 1 nhưng claims_acceptance=false cùng status SUBMITTED. | Câu 1: lỗi unique payment_request_active_acceptance_uq (23505). Câu 2: lỗi CHECK cumulative_ledger_requested_le_accepted_chk (23514). Câu 3: lỗi CHECK contract_ledger_order_chk (23514). Câu 4: lỗi permission denied (REVOKE UPDATE, DELETE) cho cả DELETE và UPDATE. Câu 5: lỗi CHECK payment_request_claim_chk. Không dòng nào thay đổi. | Bản ghi SQLSTATE và tên ràng buộc từng câu |
| UAT-AC322 | domain | P0 | Sổ lũy kế qua submit → return → submit lại và bút toán đảo | [EXE-FX] PR-A-001 DRAFT cho NT-A-001; sổ lũy kế trống (requested 0). | submit; verify; returnPaymentRequest reason="Thiếu bảng 03.a/TT"; chỉnh DRAFT; submit lần 2; verify; send-treasury; match; reversePayment. | 1. Submit PR-A-001 rồi đọc cumulative_ledger và entries. 2. Return PR-A-001; đọc lại entries và claims_acceptance. 3. Revise rồi submit lại; verify bởi u.ktt; send-treasury; ghép giao dịch CT-0001 2.100.000.000. 4. reversePayment với reason và approval_document_version_id; đọc entries. 5. Thử reversePayment lần 2. | Sau submit: B01 requested 2.000.000.000, B02 1.000.000.000; 2 entry CLAIM. Sau return: requested 0, 2 entry CLAIM_RELEASE (reversal_of_id trỏ về CLAIM), claims_acceptance=false, status RETURNED; entries không bị xóa/sửa (tổng 4). Sau settle: paid_vnd B01 2.000.000.000, B02 1.000.000.000. Sau reverse: PAYMENT_REVERSAL (paid_delta −2.000.000.000 và −1.000.000.000) và CLAIM_RELEASE, paid_vnd 0, requested_vnd 0, status REVERSED, acceptance NT-A-001 claim được lại. Reverse lần 2: 409 PAYMENT_STATE_INVALID; thử chèn thêm reversal cho cùng entry: vi phạm unique cumulative_ledger_entry_reversal_uq. | Dump cumulative_ledger_entry theo thứ tự posted_at, số dòng trước/sau |
| UAT-AC323 | domain | P0 | Tính gross, thu hồi tạm ứng, giữ lại và net của PR-A-001 | [EXE-FX] ADV-A-001 gốc 2.000.000.000, ngưỡng 80% (V=10.000.000.000 → 8.000.000.000), chưa thu hồi; giữ lại 5% trên gross từng dòng; NT-A-001 gross 3.000.000.000. | createPaymentRequest request_kind=INTERIM, acceptance_id=NT-A-001, allocation_line_id=AL-A-2026-NSDP, tax_adjustment_vnd=0. | 1. Tạo đề nghị; đọc header gross/advance_recovery/retention/net. 2. Đọc payment_request_line của từng dòng B01, B02. 3. Gửi tax_adjustment_vnd=-1000000 kèm tax_adjustment_basis rồi đọc lại net. 4. Gửi body có trường gross_vnd=999 để thử ghi đè. | Header: gross 3.000.000.000; advance_recovery = floor(2.000.000.000 × 3.000.000.000 / 8.000.000.000) = 750.000.000; retention 150.000.000; net 2.100.000.000. Dòng B01: gross 2.000.000.000, thu hồi 500.000.000, giữ lại 100.000.000, net 1.400.000.000; B02: 1.000.000.000, 250.000.000, 50.000.000, 700.000.000. Với tax_adjustment −1.000.000: net 2.099.000.000. Body có gross_vnd bị từ chối 400 INVALID_REQUEST (DTO allowlist). | Response, bảng payment_request và payment_request_line |
| UAT-AC324 | domain | P0 | Phân bổ thu hồi theo dòng bằng phương pháp phần dư lớn nhất | [EXE-FX] Nghiệm thu NT-A-004 hai dòng: B01 gross 1.000.000.000, B02 gross 2.000.000.000; tạm ứng còn lại đủ; tổng thu hồi tính được 100 VND (dữ liệu test thu nhỏ). | Gọi hàm phân bổ qua createPaymentRequest với tổng thu hồi 100 VND; lặp với 101 VND. | 1. Tạo đề nghị với tổng thu hồi 100; đọc advance_recovery_vnd từng dòng. 2. Lặp với 101; đọc lại. 3. Kiểm tổng dòng = tổng header và mỗi dòng ≤ gross dòng. | Tổng 100: B01 = 33, B02 = 67 (33,33→33; 66,67→67), tổng 100. Tổng 101: B01 = 34 (33,67→34), B02 = 67 (67,33→67), tổng 101. Không dòng nào lệch ±1 so với tổng header; kết quả lặp lại ổn định ở lần chạy thứ hai (xác định). | Bảng payment_request_line cho hai lần tạo |
| UAT-AC325 | domain | P0 | Điều kiện tạm ứng: hợp đồng hiệu lực và bảo lãnh tạm ứng | [EXE-FX] HD-A-004 trạng thái SIGNED (chưa ACTIVE); HD-A-001 ACTIVE có bảo lãnh tạm ứng BL-A-001 2.000.000.000 hết hạn 2027-03-01 ở ACTIVE/VERIFIED; HD-A-005 ACTIVE nhưng bảo lãnh tạm ứng chưa xác minh (UNVERIFIED); HD-A-006 ACTIVE bảo lãnh đã EXPIRED. | POST /contracts/{id}/advances amount_vnd=1000000000 kind=CONTRACT cho HD-A-004, HD-A-005, HD-A-006, HD-A-001. | 1. Gọi requestAdvance cho HD-A-004. 2. Gọi cho HD-A-005. 3. Gọi cho HD-A-006. 4. Gọi cho HD-A-001 rồi đọc contract_advance. | HD-A-004: 422 ADVANCE_CONTRACT_NOT_EFFECTIVE. HD-A-005 và HD-A-006: 422 ADVANCE_GUARANTEE_REQUIRED (bảo lãnh phải ACTIVE+VERIFIED và hạn còn hiệu lực). HD-A-001: 200, contract_advance PLANNED, amount 1.000.000.000, cap_vnd = 2.000.000.000 (20% × 10.000.000.000, fixture), guarantee_id = BL-A-001, không có advance_ledger_entry nào cho đến khi chi. | Bốn response, bản ghi contract_advance |
| UAT-AC326 | domain | P0 | Trần tạm ứng theo loại hợp đồng tại biên | [EXE-FX] Rule PAY.ADVANCE.CAP fixture RULE-ADV-FIX-01 (không phải quy định): CONSTRUCTION giá trị ≥ 10.000.000.000 → 20%; CONSULTING → 30%; trạng thái rule: CHƯA XÁC NHẬN [CXN-02] nhưng cho phép dùng ở môi trường test; HD-A-001 giá trị 10.000.000.000 CONSTRUCTION, chưa có tạm ứng; HD-A-007 CONSULTING giá trị 1.000.000.000. | requestAdvance amount_vnd=2000000000, sau đó 2000000001, sau đó tranche 2 sau khi tranche 1 là 1500000000; HD-A-007 amount_vnd=300000000 và 300000001. | 1. HD-A-001 requestAdvance 2.000.000.000. 2. HD-A-001 requestAdvance 2.000.000.001 trên hợp đồng mới tương đương. 3. HD-A-001 có tranche 1 = 1.500.000.000 (PAID); requestAdvance tranche 2 = 600.000.000. 4. HD-A-007 requestAdvance 300.000.000 rồi 300.000.001. | 2.000.000.000: 200 (bằng trần). 2.000.000.001: 422 ADVANCE_CAP_EXCEEDED, details cap_vnd=2000000000. Tranche 2 = 600.000.000: 422 ADVANCE_CAP_EXCEEDED (còn 500.000.000 = 2.000.000.000 − 1.500.000.000). HD-A-007: 300.000.000 → 200; 300.000.001 → 422. Mọi lần từ chối ghi cap_rule_version_id RULE-ADV-FIX-01 và cảnh báo hiển thị "[CXN-02] chưa xác nhận". | Response chi tiết cap_vnd, bản ghi contract_advance |
| UAT-AC327 | domain | P0 | Thu hồi hết khi thanh toán đạt 80% giá trị phần việc của từng thành viên liên danh | [EXE-FX] HD-A-002 liên danh giá trị 10.000.000.000: M1 (LEAD) 60% giá trị phần việc 6.000.000.000, tạm ứng 900.000.000; M2 40% giá trị 4.000.000.000, tạm ứng 600.000.000; ngưỡng 80% mỗi thành viên; chưa thu hồi. | Thanh toán 1: gross M1 = 2.400.000.000; thanh toán 2: gross M1 = 2.400.000.000; thanh toán 3: gross M2 = 1.000.000.000. | 1. Submit thanh toán 1 của M1; đọc recovered của M1. 2. Submit thanh toán 2 của M1 (lũy kế gross 4.800.000.000); đọc recovered của M1 và outstanding. 3. Submit thanh toán 3 của M2; đọc recovered của M2. 4. Thử thu hồi thêm cho M1 sau khi đã hết. | Thanh toán 1: M1 thu hồi floor(900.000.000 × 2.400.000.000 / 4.800.000.000) = 450.000.000. Thanh toán 2: lũy kế đạt 4.800.000.000 = 80% × 6.000.000.000 → thu hồi 450.000.000, tổng 900.000.000, outstanding M1 = 0, advance M1 FULLY_RECOVERED. Thanh toán 3: M2 thu hồi floor(600.000.000 × 1.000.000.000 / 3.200.000.000) = 187.500.000, outstanding M2 = 412.500.000 (không bị ảnh hưởng tiến độ của M1). Thu hồi thêm cho M1: số thu hồi tính được bằng 0. | Bảng contract_advance theo thành viên, advance_ledger_entry |
| UAT-AC328 | integration | P1 | Tạm ứng GPMB phải thu hồi trong 30 ngày và cảnh báo quá hạn | [EXE-FX] ADV-G-001 loại GPMB 1.000.000.000 chi 2026-07-01 cho TTQD-A; recovery_deadline = 2026-07-31 [CXN-12]; chưa thu hồi; job cảnh báo chạy hằng ngày 06:00 giờ VN; u.ketoan nhận thông báo. | Chạy job với đồng hồ giả lập 2026-07-24, 2026-07-31, 2026-08-01, 2026-08-08; ghi nhận thu hồi 400.000.000 vào 2026-08-02. | 1. Chạy job ngày 07-24 và đọc last_alert_level, notification. 2. Chạy 07-31. 3. Chạy 08-01 và đọc overdue_since, issue ISS tạo ra. 4. Ghi recordAdvanceRecovery 400.000.000 (2026-08-02) và chạy job 08-08. | 07-24: cảnh báo mức 1 (còn 7 ngày). 07-31: mức 2 (đến hạn). 08-01: overdue_since=2026-08-01, mức 3, tự tạo 1 vướng mắc ISS source_module=PAY loại ADVANCE_OVERDUE (không tạo trùng khi chạy lại job). Sau thu hồi 400.000.000: outstanding 600.000.000, vẫn quá hạn; 08-08 mức 4 và leo thang cấp 2 lên lãnh đạo phụ trách. Không có thao tác nào tự đánh dấu đã thu hồi. | Bảng contract_advance theo ngày giả lập, notification, issue |
| UAT-AC329 | domain | P1 | Tạm ứng hợp đồng chưa thu hồi hết khi hoàn thành bị cảnh báo | [EXE-FX] HD-A-008 đã COMPLETED, ADV tranche 1 outstanding 300.000.000 sau khi tổng gross thanh toán đạt 100% giá trị. | Chạy job advance-overdue cho 2026-12-31; mở PAY-12; thử closeContract. | 1. Chạy job; đọc contract_advance.overdue_since và listOverdueAdvances. 2. Gọi closeContract HD-A-008 khi settlement chưa có ngoại lệ. 3. Gọi acknowledgeAdvanceAlert với action_plan_due_on. | Advance vào danh sách quá hạn mức 3 vì đã quá ngưỡng thu hồi mà outstanding > 0; closeContract trả 422 ADVANCE_OUTSTANDING; acknowledge lưu note và action_plan_due_on nhưng không đổi outstanding (300.000.000). | Response listOverdueAdvances, response closeContract |
| UAT-AC330 | domain | P0 | Chặn thanh toán vượt dự toán/giá trị hợp đồng | [EXE-FX] HD-A-009 ESTIMATE_BASED giá trị 500.000.000 (dự toán được duyệt), estimate_ceiling_vnd 500.000.000; accepted_total 500.000.000; đã SETTLED 400.000.000 gross, advance_paid 0; PR-A-009b DRAFT gross 100.000.000; PR-A-009c DRAFT gross 100.000.001 (nghiệm thu NT-A-009c lập thủ công qua dữ liệu test). | submit PR-A-009b rồi match; submit PR-A-009c; cập nhật HD-A-009 contract_value_vnd=499999999 bằng SQL trực tiếp. | 1. Submit và settle PR-A-009b (100.000.000). 2. Submit PR-A-009c. 3. UPDATE contract SET contract_value_vnd=499999999 trên HD-A-009 bằng role machvon_app. 4. Đọc contract.paid_total_vnd. | PR-A-009b: paid_total = 500.000.000 = contract_value. PR-A-009c: 409 VALUE_EXCEEDED (vượt accepted_total/giá trị), không thay đổi sổ. UPDATE giá trị xuống 499.999.999: lỗi CHECK contract_ledger_order_chk/contract_cash_out_chk. contract.paid_total_vnd vẫn 500.000.000. | Response, lỗi CHECK, bảng contract |
| UAT-AC331 | domain | P0 | Đảo thanh toán đã SETTLED và hoàn trả giao dịch Kho bạc | [EXE-FX] PR-A-001 SETTLED (gross 3.000.000.000, thu hồi 750.000.000, giữ lại 150.000.000); giao dịch CT-0001 2.100.000.000; sao kê hoàn trả CT-0901 REFUND 2.100.000.000 tham chiếu CT-0001 đã nhập; DOC-APPROVAL-009 là văn bản duyệt. | reversePayment không lý do; có lý do nhưng chưa có refund; có refund_treasury_transaction_id=CT-0901 và phê duyệt. | 1. reverse không reason. 2. reverse có reason, không có refund_treasury_transaction_id. 3. reverse với CT-0901 và approval_document_version_id. 4. Đọc advance_ledger_entry, cumulative_ledger_entry, contract, acceptance NT-A-001 claim. | Bước 1: 422 VALIDATION_FAILED. Bước 2: 422 REFUND_NOT_CONFIRMED. Bước 3: 200, status REVERSED, bút toán đảo: PAYMENT_REVERSAL (paid −3.000.000.000 gộp), ADVANCE_RECOVERY_REVERSAL (−750.000.000 → advance outstanding tăng lại 750.000.000), RETENTION_RELEASE âm theo retention_hold bị hủy; contract.paid_total_vnd về 0; không dòng nào bị xóa. NT-A-001 có thể tạo đề nghị mới. | Dump ledger entries, advance entries, contract |
| UAT-AC332 | security | P0 | Maker ≠ checker cho verify/approve thanh toán | [EXE-FX] PR-A-001 do u.ketoan tạo và gửi; u.ketoan2 và u.ktt có quyền payment.verify. | verifyPaymentRequest bởi u.ketoan; bởi u.ketoan2; UPDATE verified_by trực tiếp. | 1. u.ketoan (người tạo/gửi) gọi verify. 2. u.ketoan2 gọi verify. 3. UPDATE payment_request SET verified_by=created_by bằng SQL trực tiếp. 4. Kiểm audit_entry. | Bước 1: 403 SELF_APPROVAL_DENIED, status vẫn SUBMITTED. Bước 2: 200, status VERIFIED, verified_by=u.ketoan2. Bước 3: lỗi CHECK payment_request_checker_chk. Audit có hai bản ghi (một bị từ chối, một thành công) kèm actor. | Response, audit_entry |
| UAT-AC333 | concurrency | P0 | Nhập cùng một tệp Kho bạc đồng thời chỉ áp dụng một lần | [EXE-FX] Tệp KB-A-2026-07-15.csv 5 dòng tổng 3.250.000.000, SHA-256 HASH-F3; chưa nhập; hai người u.ketoan và u.ketoan2 có quyền treasury.import. | Hai POST /treasury-imports đồng thời với cùng file_sha256=HASH-F3 và hai Idempotency-Key khác nhau; sau đó nhập tệp F3b có cùng nội dung nhưng khác 1 byte (HASH-F3b). | 1. Gửi hai request đồng thời với barrier, 30 vòng. 2. Đọc số treasury_import có file_sha256=HASH-F3 và số treasury_transaction. 3. Nhập F3b. 4. Đổi tenant sang TNT-B và nhập HASH-F3. | Mỗi vòng: 1 request trả APPLIED (row_new=5), request kia trả ALREADY_IMPORTED trỏ cùng import_id; luôn đúng 1 treasury_import và 5 treasury_transaction. F3b: coi là tệp mới nhưng 5 dòng đều row_duplicate=5 (khóa nghiệp vụ + row_hash trùng), row_new=0, tổng không đổi 3.250.000.000. TNT-B: APPLIED độc lập (hash chỉ duy nhất trong tenant). | Kết quả 30 vòng, số dòng bảng treasury_import/treasury_transaction theo tenant |
| UAT-AC334 | integration | P1 | Dòng sao kê xung đột và dòng lỗi vào quarantine có chủ xử lý | [EXE-FX] Đã có treasury_transaction CT-0001 2.100.000.000 (row_hash RH-1); tệp KB-A-2026-07-20.csv gồm: dòng 1 CT-0001 amount 2.100.000.000 (giống hệt), dòng 2 CT-0001 amount 2.150.000.000 (cùng khóa, khác số tiền), dòng 3 thiếu so_chung_tu, dòng 4 CT-0500 hợp lệ 80.000.000. | Nhập tệp; mở PAY-13 và PAY-06. | 1. Nhập tệp và đọc treasury_import_row từng dòng. 2. Đọc reconciliation_item sinh ra. 3. Kiểm raw_masked của dòng có số tài khoản. 4. Gán chủ xử lý và hạn cho item. | Dòng 1: DUPLICATE (không tạo giao dịch). Dòng 2: CONFLICT, reconciliation_item DUPLICATE_CONFLICT, giao dịch gốc CT-0001 không bị sửa. Dòng 3: ERROR code MISSING_DOCUMENT_NO, không tạo giao dịch. Dòng 4: NEW. Import status PARTIALLY_APPLIED với row_new=1, row_duplicate=1, row_conflict=1, row_error=1 (khớp row_total=4). raw_masked che số tài khoản (chỉ 4 ký tự cuối). Item có owner_membership_id và due_at sau assign. | Bảng treasury_import_row, reconciliation_item |
| UAT-AC335 | integration | P0 | Ghép Kho bạc đạt SETTLED, cập nhật sổ và phát sự kiện cho CAP/DIS | [EXE-FX] PR-A-001 SENT_TREASURY net 2.100.000.000; allocation_line AL-A-2026-NSDP có allocated 20.000.000.000, disbursed 0; giao dịch CT-0001 2.100.000.000 UNMATCHED. | matchTreasuryTransaction(CT-0001, PR-A-001); sau đó matchTreasuryTransaction cho CT-0001 lần 2 với PR-A-002. | 1. Ghép CT-0001 với PR-A-001. 2. Đọc PR-A-001, cumulative_ledger.paid_vnd, contract.paid_total_vnd, contract_advance.recovered_vnd. 3. Đọc outbox và (qua consumer) capital_ledger_entry DISBURSE. 4. Ghép lần 2 CT-0001 với PR-A-002. | PR-A-001 SETTLED; cumulative_ledger.paid_vnd B01 2.000.000.000, B02 1.000.000.000; contract.paid_total_vnd 3.000.000.000; contract_advance.recovered_vnd 750.000.000; outbox có pay.payment.settled.v1 với payload tối thiểu (payment_request_id, amount_vnd 2.100.000.000, allocation_line_id, confirmed_at); consumer CAP tạo đúng 1 capital_ledger_entry DISBURSE 2.100.000.000. Ghép lần 2: 409 TRANSACTION_ALREADY_MATCHED. | Outbox event, capital_ledger_entry, bảng sổ |
| UAT-AC336 | integration | P1 | Quy trình hạng mục đối soát: giao chủ, quá hạn, xóa sổ cần duyệt | [EXE-FX] reconciliation_item RI-001 AMOUNT_MISMATCH −10.000.000 OPEN, due_at 2026-07-10 17:00; u.ktt là chủ; u.lanhdao có quyền duyệt xóa sổ. | Chạy job 2026-07-11; resolve WRITTEN_OFF không duyệt; resolve WRITTEN_OFF với phê duyệt bởi cùng người; bởi u.lanhdao. | 1. Chạy job quá hạn đối soát lúc 2026-07-11 06:00. 2. resolve WRITTEN_OFF thiếu approval_document_version_id. 3. resolve WRITTEN_OFF bởi chính chủ xử lý. 4. resolve WRITTEN_OFF bởi u.lanhdao kèm văn bản. | Job tạo 1 vướng mắc ISS và gán issue_id vào RI-001 (chạy lại job không tạo thêm). Bước 2: 422 APPROVAL_REQUIRED. Bước 3: 403 SELF_APPROVAL_DENIED. Bước 4: 200, status WRITTEN_OFF_APPROVED, có resolved_by/resolved_at/resolution_note; difference_vnd −10.000.000 giữ nguyên (không sửa số gốc). | Bảng reconciliation_item, issue, audit_entry |
| UAT-AC337 | integration | P1 | Sinh biểu mẫu Kho bạc qua DOC theo mẫu có hiệu lực và đã xác nhận | [EXE-FX] Template DOC "03.a/TT" phiên bản 2026.1 effective_from 2026-01-01, trạng thái CXN-08 = ĐÃ XÁC NHẬN; template "05.a/TT" phiên bản 2026.1 CXN-08 = CHƯA XÁC NHẬN; template "04.b/TT" phiên bản cũ hết hiệu lực 2025-12-31; PR-A-001 VERIFIED. | generatePaymentForms form_codes=[03.a/TT, 05.a/TT, 04.b/TT]; sau đó markPaymentSentToTreasury. | 1. Gọi generatePaymentForms cho ba mẫu. 2. Đọc payment_form_instance từng mẫu. 3. Gọi markPaymentSentToTreasury với form_instance_ids chỉ có 03.a/TT. 4. Sinh lại 03.a/TT sau khi sửa tax_adjustment. | 03.a/TT: GENERATED, lưu legal_basis, template_version_id, file_sha256 và outgoing_document_id. 05.a/TT: 422 TEMPLATE_UNCONFIRMED (không sinh). 04.b/TT: 422 TEMPLATE_NOT_EFFECTIVE. markPaymentSentToTreasury thiếu bộ mẫu bắt buộc: 422 FORMS_NOT_GENERATED. Sinh lại: bản cũ SUPERSEDED, bản mới GENERATED, vẫn đúng 1 GENERATED cho (PR-A-001, 03.a/TT). | Bảng payment_form_instance, response |
| UAT-AC338 | domain | P0 | Hợp đồng bị chấm dứt chỉ cho phép thanh toán FINAL cho khối lượng đã nghiệm thu | [EXE-FX] HD-A-001 TERMINATED 2026-08-15; NT-A-001 đã SETTLED; NT-A-005 APPROVED trước chấm dứt (500.000.000) chưa thanh toán; NT-A-006 DRAFT; advance outstanding 1.250.000.000. | createPaymentRequest INTERIM cho NT-A-005; request_kind=FINAL cho NT-A-005 với settlement_revision_id; request_kind=ADVANCE; INTERIM cho NT-A-006. | 1. Tạo INTERIM cho NT-A-005. 2. Tạo FINAL cho NT-A-005 có settlement_revision_id SR-A-T1. 3. requestAdvance mới. 4. Tạo FINAL cho NT-A-006 (chưa APPROVED). | INTERIM: 409 CONTRACT_STATE_INVALID. FINAL cho NT-A-005: 200 DRAFT (thu hồi tạm ứng tính trên 500.000.000 theo công thức). requestAdvance: 422 ADVANCE_CONTRACT_NOT_EFFECTIVE. FINAL cho NT-A-006: 422 ACCEPTANCE_NOT_APPROVED. Tạm ứng outstanding vẫn 1.250.000.000 cho đến khi quyết toán. | Bốn response, bảng payment_request |
| UAT-AC339 | domain | P0 | Hạn thẩm tra quyết toán theo nhóm dự án | [EXE-FX] Rule PAY.SETTLEMENT.VERIFY_DEADLINE fixture RULE-SET-FIX-01 (không phải quy định, trạng thái CXN-09 chưa xác nhận nhưng bật ở test): QTQG/A = 270 ngày, B = 180 ngày, C = 120 ngày tính từ submitted_on; SR-A-001 (PRJ-A-001 nhóm B) DRAFT; SR-A-010 dự án nhóm C; SR-A-011 dự án chưa có project_group. | submitSettlement SR-A-001 submitted_on=2026-10-01; SR-A-010 submitted_on=2026-10-01; SR-A-011; đổi RULE-SET-FIX-01 sang trạng thái "chưa bật" rồi submit lại. | 1. Submit SR-A-001; đọc verification_due_on. 2. Submit SR-A-010; đọc verification_due_on. 3. Submit SR-A-011. 4. Tắt rule rồi submit SR-A-012. | SR-A-001: verification_due_on = 2027-03-30 (180 ngày kể từ 2026-10-01). SR-A-010: 2026-10-01 + 120 ngày = 2027-01-29. SR-A-011: 422 PROJECT_GROUP_MISSING. Khi rule chưa được bật: 422 DEADLINE_RULE_UNCONFIRMED. deadline_rule_version_id lưu RULE-SET-FIX-01; đổi rule sau đó không làm đổi hạn của SR-A-001 (giữ phiên bản đã áp dụng). | Bản ghi settlement_revision, rule version đã áp dụng |
| UAT-AC340 | integration | P1 | Sinh biểu mẫu quyết toán niên độ và dự án hoàn thành | [EXE-FX] SR-A-020 phạm vi ANNUAL fiscal_year 2026 và SR-A-021 phạm vi PROJECT cùng ở VERIFIED; template DOC 01/QTNĐ…05/QTNĐ và 01/QTDA…12/QTDA có mặt, trạng thái CXN-09 = ĐÃ XÁC NHẬN cho 01/QTNĐ, 01/QTDA, 10/QTDA; các mẫu còn lại CHƯA XÁC NHẬN. | generateSettlementForms cho SR-A-020 form_codes=[01/QTNĐ, 02/QTNĐ]; cho SR-A-021 form_codes=[01/QTDA, 10/QTDA]; closeSettlement SR-A-021. | 1. Sinh 01/QTNĐ và 02/QTNĐ cho SR-A-020. 2. Sinh 01/QTDA và 10/QTDA cho SR-A-021. 3. Đóng SR-A-021 kèm decision_document_version_id. 4. Đọc payment_form_instance. | 01/QTNĐ và 01/QTDA sinh GENERATED; 02/QTNĐ: 422 TEMPLATE_UNCONFIRMED. 10/QTDA được sinh là dự thảo quyết định (outgoing document chưa ISSUED) chỉ khi phiên bản mẫu đã xác nhận; closeSettlement cần decision_document_version_id của văn bản ISSUED, nếu là dự thảo: 422 DECISION_DOCUMENT_REQUIRED. Sau khi cung cấp văn bản hợp lệ: CLOSED. | Bảng payment_form_instance, response |
| UAT-AC341 | security | P0 | Cách ly tenant cho sổ lũy kế, thanh toán và Kho bạc | [EXE-FX] Dữ liệu tương tự của TNT-B (PR-B-001, CT-B-0001, import HASH-F1 cũng đã nhập ở TNT-B); u.ketoan thuộc TNT-A; kết nối machvon_app không đặt app.tenant_id. | Với token u.ketoan: GET /payment-requests/{PR-B-001}, GET /contracts/{HD-B-001}/cumulative-ledger, POST submit PR-B-001, POST /treasury-imports với HASH-F1; truy vấn SQL không đặt tenant; truy vấn với app.tenant_id=TNT-A đọc bảng của TNT-B. | 1. Gọi bốn request với id của TNT-B. 2. Chạy SELECT count(*) trên payment_request, cumulative_ledger, treasury_transaction, reconciliation_item khi chưa đặt app.tenant_id. 3. Đặt app.tenant_id=TNT-A và SELECT theo id của TNT-B. 4. Nhập HASH-F1 ở TNT-A (đã nhập ở TNT-B). | Bốn request: 404 RESOURCE_NOT_FOUND (submit không đổi gì ở TNT-B). SQL không tenant: count = 0 ở cả bốn bảng. SQL tenant A: 0 dòng của B. Nhập HASH-F1 ở TNT-A: APPLIED (không báo ALREADY_IMPORTED của tenant khác). Không rò rỉ tên dự án/số tiền ở body lỗi. | Response và kết quả SQL |
| UAT-AC342 | domain | P1 | Thanh toán gắn đúng năm kế hoạch và dòng vốn | [EXE-FX] AL-A-2026-NSDP (plan_year 2026, còn khả dụng 5.000.000.000), AL-A-2025-NSDP (plan_year 2025, đã hết hạn giải ngân, không gia hạn), AL-A-2026-LOW (còn 1.000.000.000); NT-A-001 gross 3.000.000.000 lập ngày 2026-07-01. | createPaymentRequest với allocation_line_id lần lượt AL-A-2025-NSDP, AL-A-2026-LOW, AL-A-2026-NSDP. | 1. Tạo với AL-A-2025-NSDP. 2. Tạo với AL-A-2026-LOW rồi submit. 3. Tạo với AL-A-2026-NSDP rồi submit. 4. Đọc payment_request.plan_year. | AL-A-2025: 422 PLAN_YEAR_MISMATCH. AL-A-2026-LOW: tạo được nhưng submit trả 422 ALLOCATION_UNAVAILABLE (khả dụng 1.000.000.000 < net 2.100.000.000), không bút toán sổ. AL-A-2026-NSDP: SUBMITTED, plan_year=2026. | Response, bảng payment_request |
| UAT-AC343 | performance | P1 | Truy vấn sổ lũy kế hợp đồng lớn đạt ngân sách p95 | [EXE-FX] Hợp đồng HD-A-PERF có 5.000 dòng BOQ, 120 nghiệm thu, 40.000 dòng cumulative_ledger; Postgres cấu hình staging. | GET /contracts/{HD-A-PERF}/cumulative-ledger?limit=50 và theo boq_item_id 300 lần, 20 luồng. | 1. Nạp dữ liệu hiệu năng. 2. Chạy 300 truy vấn trang đầu và 300 truy vấn lọc theo boq_item_id. 3. Đo p50/p95/p99 và kiểm kế hoạch truy vấn dùng chỉ mục (tenant_id, contract_id) / (tenant_id, boq_item_id). | p95 ≤ 300 ms cho trang 50 dòng; không Seq Scan trên cumulative_ledger trong EXPLAIN; trang kế tiếp ổn định (cursor) khi có ghi mới; tổng hợp trả numerator/denominator chính xác với tổng SUM. | Báo cáo đo p50/p95/p99, EXPLAIN (ANALYZE) |
| UAT-AC344 | domain | P0 | Hợp đồng tạm dừng chặn đề nghị mới, cho phép nghiệm thu đã có trước ngày tạm dừng | [EXE-FX] HD-A-001 ACTIVE rồi SUSPENDED từ 2026-07-10 (decision DOC-TD-001); NT-A-002 APPROVED ngày 2026-07-05; NT-A-003 APPROVED ngày 2026-07-12 (sau tạm dừng, do dữ liệu nhập sai); ADV-A-002 PLANNED. | createPaymentRequest cho NT-A-002 và NT-A-003; submit; requestAdvance; resumeContract. | 1. Tạo và submit đề nghị cho NT-A-002. 2. Tạo đề nghị cho NT-A-003. 3. requestAdvance. 4. resumeContract rồi tạo lại đề nghị cho NT-A-003. | NT-A-002: SUBMITTED được (nghiệm thu trước ngày tạm dừng). NT-A-003: 409 CONTRACT_STATE_INVALID (nghiệm thu phát sinh sau tạm dừng). requestAdvance: 422 ADVANCE_CONTRACT_NOT_EFFECTIVE. Sau resume: tạo được đề nghị cho NT-A-003, contract_status_change ghi 2 bản (ACTIVE→SUSPENDED, SUSPENDED→ACTIVE) kèm lý do và văn bản. | Response, bảng contract_status_change |
| UAT-AC345 | integration | P1 | Gửi lại submit cùng khóa trả đúng phản hồi cũ; khóa khác bị chặn bởi ràng buộc nghiệp vụ | [EXE-FX] PR-A-001 DRAFT version 3; PR-A-001b DRAFT cùng NT-A-001. | submit PR-A-001 key K-AC345-A hai lần; submit với K-AC345-A nhưng body expected_net_vnd khác; submit PR-A-001b key K-AC345-B. | 1. Submit PR-A-001 (K-AC345-A), ghi body phản hồi. 2. Gửi lại cùng request, cùng key. 3. Gửi cùng key nhưng expected_net_vnd=2100000001. 4. Submit PR-A-001b với key K-AC345-B. | Lần 2 trả đúng body lần 1 (cùng resource_version=4), không thêm bút toán (còn 2 entry CLAIM). Cùng key khác body: 409 IDEMPOTENCY_CONFLICT. PR-A-001b với key mới: 409 ACCEPTANCE_ALREADY_CLAIMED — idempotency key không chống được trùng ý định, ràng buộc nghiệp vụ mới chặn. | Response bốn lần, số entry sổ |
| UAT-AC396 | security | P0 | Danh mục RLS: mọi bảng của nhóm execution có FORCE RLS và đủ hai policy | [EXE-FX] Áp schema_reference.sql (module execution) vào PostgreSQL 16 sạch; role machvon_app NOSUPERUSER NOBYPASSRLS; 67 bảng thuộc nhóm execution. | Truy vấn catalog: pg_class.relrowsecurity/relforcerowsecurity và pg_policies cho 67 bảng; kết nối machvon_app không đặt app.tenant_id đọc 5 bảng mẫu; bảng LND cá nhân với app.scope_units không đặt. | 1. SELECT relname FROM pg_class WHERE relname = ANY(<67 bảng>) AND NOT (relrowsecurity AND relforcerowsecurity). 2. SELECT tablename FROM pg_policies nhóm theo bảng: đếm policy RESTRICTIVE tenant_boundary và PERMISSIVE tenant_access. 3. Kết nối machvon_app, SELECT count(*) trên contract, payment_request, cumulative_ledger, affected_household, issue. 4. Đặt app.tenant_id=TNT-A và app.scope_units không đặt, SELECT affected_household. | Truy vấn 1 trả 0 dòng. Mỗi bảng có đúng policy tenant_boundary (permissive=RESTRICTIVE) và tenant_access (PERMISSIVE); 8 bảng LND cá nhân có thêm scope_units_guard RESTRICTIVE. Bước 3: count = 0 cho cả 5 bảng. Bước 4: 0 dòng (fail-closed khi thiếu scope). | Kết quả truy vấn catalog |
| UAT-AC399 | integration | P0 | Giao dịch ghi nguyên tử: audit + outbox + sổ cùng commit; lỗi giữa chừng không để lại bút toán | [EXE-FX] PR-A-001 DRAFT; bật tiêm lỗi (fault injection) ở các điểm: sau UPDATE cumulative_ledger, sau INSERT cumulative_ledger_entry, sau INSERT audit_entry, ngay trước COMMIT. | Gọi submit PR-A-001 với lỗi tiêm tại từng điểm; sau đó gọi lại với khóa cũ khi không có lỗi. | 1. Với mỗi điểm lỗi, gọi submit, ghi mã lỗi trả về (503 hoặc 500 retryable). 2. Đọc payment_request.status, cumulative_ledger, cumulative_ledger_entry, audit_entry, outbox_event. 3. Gọi lại submit với cùng Idempotency-Key khi không có lỗi. 4. Chạy relay outbox hai lần. | Tại mọi điểm lỗi: giao dịch rollback hoàn toàn — PR-A-001 vẫn DRAFT, requested_vnd = 0, không entry/audit/outbox mới. Gọi lại với khóa cũ: 200 SUBMITTED, đúng 2 CLAIM, 1 audit, 1 outbox. Relay chạy 2 lần giao đúng 1 lần (inbox_record chống trùng) cho consumer idempotent. | Trạng thái bảng sau từng điểm lỗi |

## 11. Tiêu chí nghiệm thu

- **AC-PAY-01**: Given hai người dùng, hai Idempotency-Key khác nhau, một nghiệm thu, When cùng gửi đề nghị thanh toán, Then đúng một thành công và một nhận 409 ACCEPTANCE_ALREADY_CLAIMED (hoặc VALUE_EXCEEDED khi kiểm tra ứng dụng bị bỏ qua), sổ lũy kế không nhân đôi và mọi bút toán append-only. Test: UAT-AC320, UAT-AC321, UAT-AC322, UAT-AC343, UAT-AC345, UAT-AC399.
- **AC-PAY-02**: Given giao dịch Kho bạc đã xác nhận, When callback/nhập tệp lặp hoặc ghép, Then chỉ tạo một giao dịch, đề nghị chuyển SETTLED và phát pay.payment.settled.v1 đúng một lần. Test: UAT-AC10, UAT-AC335.
- **AC-PAY-03**: Given tệp sao kê, When nhập lặp hoặc đồng thời, Then dựa trên SHA-256 + khóa nghiệp vụ nên không tính hai lần, dòng xung đột/lỗi vào quarantine và tổng đối soát không cộng bản lặp. Test: UAT-AC11, UAT-AC333, UAT-AC334.
- **AC-PAY-04**: Given số nội bộ khác số Kho bạc, When ghép, Then tạo hạng mục có chủ xử lý và hạn, hiển thị cả hai số và chênh lệch, không tự chọn số lớn hơn, xóa sổ cần phê duyệt riêng. Test: UAT-AC12, UAT-AC336.
- **AC-PAY-05**: Given hóa đơn/khối lượng/số hồ sơ thanh toán đã tồn tại, When nhập trùng, Then bị chặn, riêng hóa đơn cho phép override có căn cứ và người duyệt. Test: UAT-AC60.
- **AC-PAY-06**: Given tạm ứng đã chi, When thu hồi, Then tổng lũy kế thu hồi không vượt gốc tạm ứng và CHECK DB chặn vi phạm. Test: UAT-AC61.
- **AC-PAY-07**: Given đề nghị thanh toán, When tính và gửi, Then net = gross − thu hồi − giữ lại + điều chỉnh thuế, số không cân bị chặn ở API và DB, phân bổ theo dòng xác định và làm tròn theo quy tắc dòng. Test: UAT-AC64, UAT-AC323, UAT-AC324.
- **AC-PAY-08**: Given quyết toán còn công nợ/tạm ứng, When đóng, Then cần phê duyệt ngoại lệ bởi người khác người lập; số công nợ không bị ghi đè bằng 0. Test: UAT-AC66.
- **AC-PAY-09**: Given chuỗi dự án→hợp đồng→khối lượng→nghiệm thu→thanh toán→Kho bạc→quyết toán, When truy vết, Then trả đủ nút kèm phiên bản và chỉ trong tenant của người dùng. Test: UAT-AC67.
- **AC-PAY-10**: Given đề nghị tạm ứng, When kiểm tra điều kiện, Then chỉ chấp nhận khi hợp đồng đã hiệu lực, có bảo lãnh tạm ứng ACTIVE+VERIFIED và không vượt trần theo loại hợp đồng [CXN-02]. Test: UAT-AC325, UAT-AC326.
- **AC-PAY-11**: Given hợp đồng liên danh, When thanh toán, Then tạm ứng của từng thành viên được thu hồi hết khi lũy kế thanh toán của thành viên đó đạt 80% giá trị phần việc, độc lập với thành viên khác. Test: UAT-AC327.
- **AC-PAY-12**: Given tạm ứng GPMB hoặc tạm ứng quá ngưỡng thu hồi, When tới hạn 30 ngày/quá hạn, Then cảnh báo T-7, đến hạn, quá hạn, leo thang và tự tạo vướng mắc một lần, không tự đánh dấu đã thu hồi. Test: UAT-AC328, UAT-AC329.
- **AC-PAY-13**: Given hợp đồng theo dự toán hoặc giá trị hợp đồng, When thanh toán vượt, Then bị chặn 409 VALUE_EXCEEDED và CHECK DB giữ bất biến. Test: UAT-AC330.
- **AC-PAY-14**: Given thanh toán đã SETTLED, When đảo, Then bút toán đảo (không xóa) cùng hoàn trả Kho bạc đã xác nhận, claim nghiệm thu được nhả và mỗi bút toán chỉ đảo một lần. Test: UAT-AC331.
- **AC-PAY-15**: Given hồ sơ thanh toán, When kiểm soát/duyệt, Then người duyệt khác người lập và người gửi (API và CHECK DB). Test: UAT-AC332.
- **AC-PAY-16**: Given biểu mẫu Kho bạc, When sinh qua DOC, Then chỉ dùng phiên bản mẫu có hiệu lực và đã xác nhận [CXN-08], lưu căn cứ pháp lý và mã băm tệp. Test: UAT-AC337.
- **AC-PAY-17**: Given hợp đồng SUSPENDED hoặc TERMINATED, When tạo đề nghị, Then áp ma trận cho phép (nghiệm thu trước ngày tạm dừng; chỉ FINAL sau chấm dứt). Test: UAT-AC338, UAT-AC344.
- **AC-PAY-18**: Given hồ sơ quyết toán, When nộp, Then hạn thẩm tra tính theo nhóm dự án bằng rule hiệu lực đã xác nhận [CXN-09] và biểu mẫu 01–05/QTNĐ, 01–12/QTDA sinh qua DOC. Test: UAT-AC339, UAT-AC340.
- **AC-PAY-19**: Given hai tenant, When truy cập chéo hoặc thiếu ngữ cảnh, Then 404/0 dòng và mọi bảng execution có FORCE RLS cùng hai policy. Test: UAT-AC341, UAT-AC396.
- **AC-PAY-20**: Given đề nghị thanh toán, When gắn dòng vốn, Then đúng năm kế hoạch nguồn và đủ hạn mức khả dụng. Test: UAT-AC342.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1 “dùng thật”.** Sổ lũy kế R7 đầy đủ (bảng, ràng buộc, khóa, reversal, test đồng thời); tạo/gửi/kiểm soát/trả/hủy/đảo đề nghị; tạm ứng đủ điều kiện + trần + thu hồi tuyến tính + ngưỡng 80% theo thành viên; chặn vượt dự toán; nhập sao kê qua tệp idempotent, ghép và đối soát chênh lệch; sinh biểu mẫu 03.a/TT, 04.a/TT, 04.b/TT, 05.a/TT qua DOC khi mẫu đã xác nhận; quyết toán dự án với hạn theo nhóm, ngoại lệ đóng; truy vết chuỗi. Màn hình lõi: PAY-01…PAY-10, PAY-13, PAY-14, PAY-15, PAY-17.

**R2.** Quyết toán niên độ đầy đủ 01–05/QTNĐ, 12 mẫu QTDA, lịch hạn thẩm tra (PAY-16); đối soát tự động nhiều khóa; hoàn ứng GPMB tự gợi ý từ LND; ngoại tệ/ODA; thanh toán theo dự toán không hợp đồng (giao nhiệm vụ); báo cáo xu hướng tạm ứng. **R3.** Adapter Kho bạc thật (sau D05), hóa đơn điện tử (D08).

**Giờ review người (R2) — hạng mục bắt buộc người duyệt.**

| Hạng mục | Giờ dự kiến | Người duyệt |
|---|---|---|
| Sổ lũy kế R7: DDL, ràng buộc, thứ tự khóa, test đồng thời | 8 | Kế toán trưởng + kiến trúc sư |
| Công thức thu hồi/trần/ngưỡng 80% và fixture | 6 | Kế toán / Pháp chế [CXN-02] |
| Bảng ánh xạ biểu mẫu 03.a/TT, 04.a/TT, 04.b/TT, 05.a/TT | 4 | Kế toán [CXN-08] |
| Mẫu quyết toán và hạn thẩm tra theo nhóm | 4 | Kế toán / Chủ nghiệp vụ vốn [CXN-09] |
| Quyền và maker–checker, DoA | 3 | Chủ nghiệp vụ |
| Migration dữ liệu thanh toán lịch sử (không nhập sổ lũy kế từ nguồn chưa đối soát) | 4 | Data Owner (D04) |

WIP ≤ 2 slice chờ người duyệt (R2): thứ tự đề xuất slice 1 = sổ R7 + đề nghị; slice 2 = tạm ứng; slice 3 = Kho bạc + đối soát; slice 4 = quyết toán.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| ID | Rủi ro / câu hỏi | Owner | Điều kiện giải quyết |
|---|---|---|---|
| R-PAY-01 | Trần tạm ứng theo loại hợp đồng và ngưỡng 80% theo thành viên chưa kiểm bản gốc NĐ 254/2025 [CXN-02] | Kế toán / Pháp chế | Phụ lục gốc; rule `PAY.ADVANCE.*` được ký; fixture gắn ID mục |
| R-PAY-02 | Mã và nội dung mẫu 03.a/TT, 04.a/TT, 04.b/TT, 05.a/TT chưa xác minh [CXN-08] | Kế toán | Phụ lục gốc; DOC publish template đã xác nhận |
| R-PAY-03 | Mẫu quyết toán TT 91/2025 và hạn thẩm tra theo nhóm [CXN-09] | Kế toán / Chủ nghiệp vụ vốn | Thông tư gốc; rule được ký |
| R-PAY-04 | Định dạng tệp sao kê Kho bạc chưa có mẫu thật (D05) | Integration Lead | Mẫu tệp thật đã ẩn danh; nâng adapter từ PROPOSED lên VERIFIED |
| R-PAY-05 | Thời điểm tính giải ngân = ngày Kho bạc thanh toán [CXN-03] ảnh hưởng DIS | Chủ nghiệp vụ vốn | Công văn gốc |
| R-PAY-06 | Hiệu năng khóa hàng hợp đồng khi nhiều đề nghị đồng thời | Kiến trúc | Đo ở staging: p95 lock wait ≤ 2 giây; nếu vượt, tách khóa theo `acceptance` (CR) |
| R-PAY-07 | Thanh toán không qua hợp đồng (giao nhiệm vụ/dự toán thuần) chưa có mô hình riêng ngoài `ESTIMATE_BASED` | Chủ nghiệp vụ vốn | Quyết định phạm vi R2 [GIẢ ĐỊNH] |
| R-PAY-08 | Quy tắc chặn khi dự án thiếu mã TTQG [CXN-01] | Chủ nghiệp vụ vốn | Văn bản gốc; cờ policy tenant |
