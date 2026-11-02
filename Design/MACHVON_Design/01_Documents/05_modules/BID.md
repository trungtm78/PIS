# BID — Nhà thầu, lựa chọn nhà thầu và phân tích AI có dẫn chứng

Phiên bản đặc tả M1 · 22/10/2026 · Nguồn dữ liệu máy: `work/staging/intelligence.json` (bảng sửa `contractor`, `proposal`, `procurement_package`, `criteria_version`, `analysis_run`, `analysis_finding`; bảng mới `procurement_plan`, `procurement_milestone`, `procurement_result`, `procurement_import_batch`, `procurement_external_link`, `bid_conflict_declaration`, `procurement_petition`, `proposal_document`, `document_page_ocr`, `analysis_evidence`, `analysis_finding_review`, `evaluation_report`, `bid_clarification`, `contractor_restriction`). Quy ước chung theo `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md`; AI gọi qua LLM (`LLM.md`), văn bản qua DOC (`DOC.md`). Baseline v1.3: BID-01…BID-20, FRD UC06 (AC13–AC17) và UC15 được giữ nguyên; tài liệu này bổ sung.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Chủ đầu tư và tổ chuyên gia phải (a) lập và trình duyệt kế hoạch lựa chọn nhà thầu (KHLCNT) đúng nguồn vốn, (b) đánh giá hồ sơ dự thầu theo bộ tiêu chí đã duyệt, khách quan và có dẫn chứng, (c) trình người có thẩm quyền phê duyệt kết quả (KQLCNT) và (d) xử lý kiến nghị. Hệ thống mạng đấu thầu quốc gia là nơi tổ chức đấu thầu qua mạng; MACHVON **không thay thế** hệ thống đó mà quản lý phía chủ đầu tư: kế hoạch, mốc, đối soát tệp, hồ sơ đánh giá nội bộ và AI hỗ trợ đọc hồ sơ dài. AI chỉ là **đầu vào kiểm chứng**: mọi nhận xét phải có dẫn chứng tới trang tài liệu, mọi thay đổi và quyết định do con người ghi lại.

**Trong phạm vi:** KHLCNT có revision và quyết định (DOC); gói thầu gắn dòng vốn CAP; mốc mời/đóng/mở thầu/đánh giá/phê duyệt; nhập tệp và đối soát với Hệ thống mạng đấu thầu quốc gia (adapter PROPOSED, chỉ tệp); hồ sơ nhà thầu định danh theo MST đã xác minh, hạn chế tham gia; tiếp nhận hồ sơ (CONFIDENTIAL, khóa tới thời điểm mở); OCR và xác nhận trang; bộ tiêu chí có phiên bản; lượt phân tích AI bất biến; nhận xét kèm dẫn chứng; thẩm tra chuyên gia; khai báo xung đột lợi ích; so sánh đề án cùng phiên bản tiêu chí; làm rõ hồ sơ; báo cáo/biên bản đánh giá phát hành qua DOC; trình và phê duyệt KQLCNT; kiến nghị của nhà thầu; dùng bảng điểm thực hiện hợp đồng của CTR (`contractor_performance` APPROVED) làm lịch sử và dẫn chứng.

**Ngoài phạm vi:** đăng tải/mở thầu trên Hệ thống mạng đấu thầu quốc gia (người dùng thao tác trên hệ thống đó); hợp đồng và thực hiện (CTR — BID-14 chỉ hiển thị liên kết); định giá/ngân sách AI (LLM); dữ liệu cá nhân nhân sự nhà thầu ngoài mức cần cho tiêu chí (tối thiểu hóa).

**Phụ thuộc:** PRJ (dự án), CAP (`allocation_line`), MDM (master CONTRACTOR — nguồn định danh; merge chỉ qua MDM), LLM (`AiGatewayPort`, phân loại, ngân sách, `ai_decision_record`), DOC (QĐ KHLCNT/KQLCNT, biên bản, làm rõ), CTR (sở hữu bảng điểm `contractor_performance` và nhật ký vi phạm `contractor_violation`, interface `getContractorScorecard`; nhận `bid.result.approved.v1`), ADM (DoA, lịch), IAM (guest nhà thầu). Đồ thị: `BID → PRJ, MDM, LLM, DOC`; CTR → BID.

**Căn cứ.** Luật Đấu thầu 22/2023/QH15 (sửa bởi Luật 90/2025/QH15); NĐ 214/2025/NĐ-CP (lựa chọn nhà thầu; đánh giá nhà thầu — Điều 19–20 theo research [CXN-BID-01]); TT 79/2025/TT-BTC (mẫu hồ sơ) [CXN-BID-03]; kiến nghị trong lựa chọn nhà thầu và thời hạn giải quyết [CXN-BID-02]; Luật BVDLCN 91/2025 (dữ liệu nhân sự nhà thầu). Thị trường: Oracle Unifier/Procore (bid management), các công cụ đánh giá hồ sơ có dẫn chứng (evidence-grounded review) và khung NIST AI RMF (Govern/Map/Measure/Manage), OWASP LLM Top 10 2025.

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Chuyên viên kế hoạch đấu thầu (bên mời thầu) | Dự án trong cây đơn vị | `createProcurementPlan`, `submitProcurementPlan`, `recordProcurementMilestone`, `importProcurementFile`, `createCriteriaVersion`, `receiveProcurementPetition`/`resolve` | Tự duyệt KHLCNT/tiêu chí |
| Người có thẩm quyền (chủ đầu tư/UBND) | Theo DoA | `decideProcurementPlan`, `approveCriteriaVersion`, `decideConflictOfInterest`, `decideProcurementResult` | Duyệt hồ sơ do mình lập/trình |
| Văn thư tiếp nhận | Gói thầu | `receiveProposal` (chỉ metadata trước giờ mở) | Xem nội dung hồ sơ trước giờ mở |
| Thành viên tổ chuyên gia | Gói được phân công, sau khai báo xung đột | `declareConflictOfInterest`, `startAnalysisRun` (baseline `POST /analysis-runs`), `reviewOcrPage`, `reviewAnalysisFinding`, `createEvaluationReport`, `signOffEvaluationReport`, `sendBidClarification`, `compareProposals` | Xem hồ sơ khi chưa khai báo/bị RECUSED; quyết định KQLCNT |
| Người trình kết quả | Gói | `submitProcurementResult` | Phê duyệt kết quả do mình trình |
| Quản lý nhà thầu | Toàn tenant | `registerContractor`, `verifyContractor`, `recordContractorRestriction`, `recordContractorEvaluation`, `approveContractorEvaluation` (người khác) | Gộp nhà thầu theo tên (phải qua MDM merge) |
| Nhà thầu (guest) | Gói/hợp đồng của mình | `recordClarificationAnswer`, đọc yêu cầu làm rõ của mình | Thấy nhà thầu khác, nhận xét AI, tiêu chí nội bộ |
| AI (qua LLM) | Không là actor ghi | Sinh đề xuất nhận xét có dẫn chứng | Mọi ghi trạng thái/quyết định (OWASP LLM06) |
| Auditor | Đọc theo scope | Hồ sơ đánh giá, lịch sử thẩm tra | Mọi command |

## 3. Luồng nghiệp vụ

**F1 — KHLCNT (BID-15, BID-16).** `createProcurementPlan` với các gói (mã, giá gói, phương thức, loại hợp đồng, hình thức qua mạng, dòng vốn CAP, thời gian) → DRAFT; `submitProcurementPlan` kiểm Σ giá gói theo từng dòng vốn ≤ số được bố trí (`PACKAGE_BUDGET_EXCEEDS_ALLOCATION`) và dự án ở giai đoạn cho phép → IN_REVIEW; `decideProcurementPlan` (≠ người lập) kèm QĐ phê duyệt (DOC, mẫu `DOC-QD-PHE-DUYET-KHLCNT`) → APPROVED, bản trước SUPERSEDED. Điều chỉnh = revision mới. Đồng thời: unique một phần một bản APPROVED/dự án.

**F2 — Nhà thầu (BID-01, BID-02, BID-21).** `registerContractor` khớp master MDM theo MST (không theo tên); `verifyContractor` bằng giấy tờ/tra cứu chính thức; trùng MST đã VERIFIED → 409 và chuyển đề nghị merge sang MDM. Hạn chế (`contractor_restriction`) nhập từ tệp nguồn chính thức hoặc theo quyết định; còn hiệu lực → chặn tiếp nhận hồ sơ và trình kết quả.

**F3 — Tiếp nhận và OCR (BID-05, BID-06).** `receiveProposal` tạo `proposal` + `proposal_document` (tệp đã quét virus, `document` loại ATTACHMENT, phân loại CONFIDENTIAL); `access_released_at` = giờ mở thầu; trước đó chỉ văn thư thấy metadata. OCR theo trang (`document_page_ocr`); trang dưới ngưỡng tin cậy (mặc định 0,85 [GIẢ ĐỊNH]) hoặc bảng không khớp tổng → NEEDS_REVIEW; phân tích tài chính chờ xác nhận. Quyết định xung đột: ALLOWED mở hồ sơ cho thành viên; RECUSED loại thành viên khỏi hồ sơ của nhà thầu có quan hệ (toàn gói khi không nêu nhà thầu); BLOCKED loại khỏi cả gói; xung đột chưa quyết định đã đóng phần nó bao trùm; RECUSED/BLOCKED rút thành viên khỏi `signed_off_by` của biên bản chưa phát hành.

**F4 — Tiêu chí (BID-04).** `createCriteriaVersion`: tiêu chí, điều kiện bắt buộc, thang điểm, Σ trọng số = 100, bằng chứng yêu cầu; tiêu chí cấm (tên, đặc tính cá nhân không liên quan, vùng miền) → 422 `PROHIBITED_CRITERION`; `approveCriteriaVersion` (≠ người soạn) khóa phiên bản; đã có lượt phân tích thì không sửa (tạo revision).

**F5 — Lượt phân tích AI (BID-07, BID-08, BID-09).** Baseline `POST /analysis-runs` (operationId `post_analysis_runs`, giữ nguyên) với `proposal_id`, `criteria_version_id`, `profile_version_id`: (1) kiểm người gọi đã khai báo xung đột; (2) tính `document_version_set_sha256` và `input_hash` — cùng input trả lượt hiện có; (3) phân loại dữ liệu = mức cao nhất của tài liệu (hồ sơ dự thầu = CONFIDENTIAL) → LLM chỉ chọn tuyến DOMESTIC_HOSTED/SELF_HOSTED (R5); (4) LLM đặt chỗ ngân sách; (5) pipeline: trích dữ kiện → **tính toán xác định bằng code** (giá, khối lượng, tỷ lệ) → đối chiếu tiêu chí → dựng nhận xét có dẫn chứng → **kiểm dẫn chứng tồn tại** (trích dẫn có trên đúng trang của đúng `document_version`, `verified_present`) → AWAITING_REVIEW/COMPLETED. Nội dung hồ sơ là dữ liệu không tin cậy (LLM01): bọc tách khỏi chỉ dẫn; công cụ chỉ đọc; không truy cập mạng. Đổi tiêu chí/hồ sơ → lượt mới `supersedes_run_id`; lượt cũ bất biến. Hủy: baseline `POST /analysis-runs/{id}/cancel` reconcile phần đã dùng. Triển khai (ST-BID-009, `docs/bid-analysis.md`): lượt chạy đồng bộ trong yêu cầu (QUEUED/RUNNING chỉ tồn tại trong giao dịch; Temporal là việc triển khai), tệp đầu vào của model là tệp tạo ra lưu ở kho (`inputRef`), chỉ hủy được lượt AWAITING_REVIEW chưa có nhận xét nào được thẩm tra, và lượt FAILED/REJECTED_BY_POLICY/CANCELLED không giữ băm đầu vào.

**F6 — Thẩm tra và báo cáo (BID-10, BID-12, BID-13).** `reviewAnalysisFinding` (lý do ≥ 20 ký tự) ghi `analysis_finding_review` và `ai_decision_record` (LLM) với kết quả ACCEPTED/ACCEPTED_WITH_CHANGE/REJECTED. `compareProposals` chỉ gộp lượt cùng `criteria_version_id`. `createEvaluationReport` yêu cầu mọi nhận xét đã có `final_status`; ý kiến khác được ghi riêng; khi mọi thành viên `signOffEvaluationReport` → yêu cầu DOC phát hành biên bản. Triển khai thẩm tra và so sánh (ST-BID-010, `docs/bid-review.md`): quyết định của chuyên gia là một dòng `analysis_finding_review` trỏ tới nhận xét, không bao giờ sửa nhận xét (trigger chặn mọi UPDATE `analysis_finding`); trạng thái và điểm đứng là của quyết định mới nhất, `analysis_finding.status` giữ nguyên điều mô hình đã nói; mỗi quyết định ghi cùng giao dịch một `ai_decision_record` (ACCEPTED khi giữ nguyên trạng thái và điểm, ACCEPTED_WITH_CHANGE khi đổi, REJECTED khi trả về NEEDS_REVIEW); phiên bản của nhận xét (If-Match) là số quyết định + 1; lượt chạy thành COMPLETED khi nhận xét cuối cùng có quyết định; điểm nằm trong khoảng 0 đến thang điểm của tiêu chí; không có thao tác chấp nhận hàng loạt; `compareProposals` chỉ dựng từ quyết định của người, không có tổng xếp hạng và không nêu bên thắng, lượt khác phiên bản tiêu chí bị loại với lý do `CRITERIA_VERSION_MISMATCH`, thuộc tính cá nhân và vùng miền được liệt kê trong `excluded_attributes`. Làm rõ hồ sơ (ST-BID-011, `docs/bid-clarification.md`, BID-11): thành viên tổ chuyên gia có toàn quyền xem đề án (đã mở thầu, đã khai báo xung đột, không bị RECUSED) gửi `sendBidClarification` với câu hỏi (10–4000 ký tự), căn cứ tùy chọn là nhận xét của chính đề án đó và hạn trả lời ở tương lai (`DUE_IN_PAST`); yêu cầu được ghi SENT cùng thư làm rõ là một văn bản DOC mật về yêu cầu (`sent_document_id`); đề án đã bị thay thế/rút → 409 `PROPOSAL_NOT_OPEN`, đề án chưa mở thầu hoặc bị xung đột loại → 404. Nhà thầu (guest của đúng nhà thầu đó) hoặc văn thư giữ thư ghi `recordClarificationAnswer` bằng một văn bản DOC trong hạn; sau hạn → 409 `CLARIFICATION_EXPIRED` (kể cả lần trả lời thứ hai) và yêu cầu không đổi, đã trả lời hoặc đã rút → 409 `CLARIFICATION_STATE_INVALID`; guest của nhà thầu khác, của tenant khác hoặc thành viên bị loại bởi xung đột nhận 404; trạng thái EXPIRED là trạng thái hiển thị của yêu cầu SENT quá hạn (không có việc nền ghi đè); nhà thầu không thấy người hỏi và nhận xét căn cứ.

**F7 — Kết quả và kiến nghị (BID-18, BID-20).** `submitProcurementResult` (giá trúng ≤ giá gói; KHLCNT APPROVED; nhà thầu không bị hạn chế; báo cáo ISSUED) → `decideProcurementResult` bởi người có thẩm quyền (≠ người trình) kèm QĐ KQLCNT → APPROVED, phát `bid.result.approved.v1` (CTR lập hợp đồng; guest được mời). Kiến nghị của nhà thầu có hạn xử lý theo quy tắc dữ liệu [CXN-BID-02].

**F8 — Đối soát Hệ thống mạng đấu thầu quốc gia (BID-17, BID-19).** `importProcurementFile` (dry-run → apply), idempotent theo `file_sha256` (A3); dòng lỗi vào báo cáo; cập nhật mốc `source=IMPORT` và `procurement_external_link`; chênh lệch có owner. Không có lời gọi API.

**F9 — Lịch sử nhà thầu từ CTR (BID-02).** CTR sở hữu bảng điểm (`contractor_performance`) và vi phạm (`contractor_violation`) theo NĐ 214/2025 [CXN-BID-01]. BID không ghi bảng điểm riêng: `getContractorHistory` gọi interface CTR `getContractorScorecard` và chỉ dùng bản APPROVED; consumer `ctr.contractor_evaluation.approved.v1` làm mới cache lịch sử. Khi phân tích tiêu chí kinh nghiệm/năng lực, pipeline đưa bảng điểm APPROVED vào như dẫn chứng `SCORECARD` (`analysis_evidence.contractor_performance_id`). Vi phạm có `penalty_kind = DEBARMENT_PROPOSAL` chỉ trở thành `contractor_restriction` khi có quyết định (DOC).

## 4. State machine

```
procurement_plan:   DRAFT ─submit─► IN_REVIEW ─approve(QĐ)─► APPROVED ─(revision mới APPROVED)─► SUPERSEDED ; IN_REVIEW ─reject/return─► DRAFT|CANCELLED
criteria_version:   DRAFT ─approve─► APPROVED ─(revision mới)─► SUPERSEDED
analysis_run:       QUEUED ─► RUNNING ─► AWAITING_REVIEW ─► COMPLETED ; RUNNING ─► FAILED|CANCELLED|REJECTED_BY_POLICY   (giá trị status baseline giữ nguyên; bổ sung theo bảng)
analysis_finding:   (AI) SUPPORTED|CONTRADICTED|MISSING|NEEDS_REVIEW ──expert review──► final_status (bất biến sau báo cáo ISSUED)
evaluation_report:  DRAFT ─all sign-off─► SIGNED_OFF ─issue request─► ISSUE_REQUESTED ─doc.issued─► ISSUED ─(báo cáo mới)─► SUPERSEDED
procurement_result: DRAFT ─submit─► SUBMITTED ─approve(QĐ)─► APPROVED ; SUBMITTED ─reject─► REJECTED ; DRAFT|SUBMITTED ─cancel─► CANCELLED
```

| Từ | Command | Đến | Ai | Guard | Event |
|---|---|---|---|---|---|
| DRAFT (plan) | `submitProcurementPlan` | IN_REVIEW | chuyên viên | Σ gói ≤ dòng vốn; dự án ≥ PIPELINE | `bid.plan.submitted.v1` |
| IN_REVIEW | `decideProcurementPlan` APPROVE | APPROVED | thẩm quyền ≠ người lập | QĐ EFFECTIVE | `bid.plan.approved.v1` |
| DRAFT (criteria) | `approveCriteriaVersion` | APPROVED | thẩm quyền ≠ người soạn | Σ trọng số 100; không tiêu chí cấm | `bid.criteria.approved.v1` |
| (mới) | `POST /analysis-runs` | QUEUED→… | tổ chuyên gia | khai báo xung đột; tuyến hợp lệ; ngân sách | `ai.run.started.v1` (baseline LLM) |
| finding | `reviewAnalysisFinding` | final_status | tổ chuyên gia đã khai báo | lý do ≥ 20 | `bid.finding.reviewed.v1` |
| DRAFT (report) | `signOffEvaluationReport` (đủ thành viên) | SIGNED_OFF → ISSUE_REQUESTED | thành viên | không nhận xét chưa thẩm tra | `bid.report.signed_off.v1` |
| SUBMITTED (result) | `decideProcurementResult` APPROVE | APPROVED | thẩm quyền ≠ người trình | QĐ; giá ≤ gói; không hạn chế | `bid.result.approved.v1` |

Cấm: sửa tiêu chí đã khóa (`CRITERIA_LOCKED_BY_RUN`); ghi đè lượt/nhận xét cũ; APPROVED (result) → bất kỳ trừ khi có quyết định hủy mới (ngoài R1); AI ghi bất kỳ trạng thái nào. Mã lỗi chung `*_STATE_INVALID`.

## 5. Quy tắc nghiệp vụ và công thức

- **BR-BID-01** Định danh nhà thầu = MST đã xác minh (unique một phần khi VERIFIED); không tự gộp theo tên; merge/unmerge qua MDM.
- **BR-BID-02** Σ `budget_vnd` các gói dùng cùng `allocation_line_id` ≤ `allocated_vnd` khả dụng (CAP `getCapitalAvailability`) tại lúc submit; giá trúng ≤ giá gói (`PRICE_EXCEEDS_PACKAGE_BUDGET`).
- **BR-BID-03** Hồ sơ dự thầu CONFIDENTIAL, ACL theo gói + khai báo xung đột + `access_released_at`; mọi mở dẫn chứng kiểm lại ACL tài liệu (AC14).
- **BR-BID-04** Tiêu chí: Σ trọng số = 100 khi chấm điểm theo trọng số; điểm tiêu chí ∈ thang đã khai; điểm tổng = Σ(điểm_i/thang_i × trọng số_i), numeric làm tròn half-up 2 chữ số; tiêu chí đạt/không đạt tính riêng (một tiêu chí bắt buộc "không đạt" ⇒ không đạt tổng thể, không bù điểm).
- **BR-BID-05** Lượt bất biến: `input_hash = SHA-256(criteria_version_id ‖ document_version_set_sha256 ‖ profile_version_id ‖ prompt_version_id)`; cùng hash trả lượt cũ.
- **BR-BID-06** Số liệu tiền/khối lượng tính bằng code decimal theo công thức đã duyệt; model chỉ diễn giải; không suy gian lận từ thiếu bằng chứng (trạng thái MISSING, không phải CONTRADICTED).
- **BR-BID-07** Nhận xét SUPPORTED/CONTRADICTED cần ≥ 1 dẫn chứng `verified_present = true`; không đạt → hệ thống hạ về NEEDS_REVIEW và gắn cờ "Thiếu nguồn" (OWASP LLM09: câu trả lời không có trích dẫn bị từ chối).
- **BR-BID-08** `confidence_type` là tín hiệu hiệu chuẩn trên eval, không hiển thị như xác suất đúng.
- **BR-BID-09** Mọi thay đổi trạng thái/điểm của chuyên gia ghi `analysis_finding_review` + `ai_decision_record`; kết luận cuối (KQLCNT) do người có thẩm quyền, không có nút "chấp nhận đề xuất AI".
- **BR-BID-10** Xung đột lợi ích: khai báo bắt buộc trước khi xem hồ sơ; có xung đột → người khác quyết ALLOWED/RECUSED/BLOCKED kèm lý do.
- **BR-BID-11** So sánh đề án chỉ khi cùng `criteria_version_id`; thuộc tính cấm bị loại khỏi so sánh và được liệt kê.
- **BR-BID-12** Bảng điểm nhà thầu thuộc CTR (`contractor_performance`, trọng số theo rule version của CTR); BID chỉ đọc bản APPROVED và không tính lại điểm.
- **BR-BID-13** Nhập tệp idempotent theo `file_sha256`; dry-run không ghi; apply chỉ một lần.
- **BR-BID-14** Hạn xử lý kiến nghị và thời hạn trong lựa chọn nhà thầu là dữ liệu có `legal_basis` + hiệu lực [CXN-BID-02].

## 6. Dữ liệu

| Bảng | Thay đổi/Trường chính | Ràng buộc/Index | Classification | Retention |
|---|---|---|---|---|
| `contractor` (sửa) | + master_record_id, legal_form, xác minh, audit cols; FK `profile_document_id` → `document` | unique MST khi VERIFIED | INTERNAL | 10 năm sau HĐ cuối |
| `proposal` (sửa) | + submitted_at, bid_price_vnd, access_released_at, classification, withdrawn_reason; FK project | ACL theo gói | CONFIDENTIAL | Theo hồ sơ lựa chọn [CXN-05] |
| `procurement_package` (sửa) | + plan_id, title, contract_type, bidding_form, allocation_line_id, duration_days, external_package_code; FK `approved_decision_id` → `document` | unique (dự án, mã, revision) | INTERNAL | Theo dự án |
| `criteria_version` (sửa) | + status, legal_basis, weights_sum, audit; FK package | Σ = 100; SoD | INTERNAL | Theo hồ sơ |
| `analysis_run` (sửa) | + package_id, ai_request_id, data_classification, route_class, prompt_version_id, retrieval_snapshot_id, document_version_set_sha256, supersedes_run_id, thời điểm; FK profile, reservation | unique input khi không hủy | CONFIDENTIAL | Theo hồ sơ |
| `analysis_finding` (sửa) | + confidence_type, evidence_count, final_status, reviewed_at | final_status ⇒ reviewer | CONFIDENTIAL | Theo hồ sơ |
| bảng mới (14) | xem danh sách cột | CHECK/unique như §5 | INTERNAL/CONFIDENTIAL/PERSONAL (khai báo xung đột) | Theo hồ sơ/10 năm |

`proposal.document_version_ids` (jsonb baseline) được giữ, đánh dấu dữ liệu tương thích; nguồn sự thật mới là `proposal_document`. `analysis_finding.evidence_refs` (baseline) giữ làm bản tóm tắt; nguồn sự thật mới là `analysis_evidence`. Mọi cột `*_id` có index `(tenant_id, col)`.

- `contractor` (sửa): id, tax_identifier, legal_name, verification_status, profile_document_id, master_record_id, legal_form, verified_by, verified_at, verification_evidence_document_id, created_at, created_by, updated_at, updated_by, version
- `proposal` (sửa): id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, bid_price_vnd, access_released_at, classification, withdrawn_reason, created_at, created_by, version
- `procurement_package` (sửa): id, project_id, code, budget_vnd, method, revision, status, approved_decision_id, plan_id, title, contract_type, bidding_form, allocation_line_id, planned_start_period, duration_days, external_package_code, created_at, created_by, version
- `criteria_version` (sửa): id, package_id, revision, criteria_json, approved_by, effective_at, status, legal_basis, weights_sum, created_by, created_at, version
- `analysis_run` (sửa): id, proposal_id, criteria_version_id, profile_version_id, input_hash, status, budget_reservation_id, package_id, ai_request_id, data_classification, route_class, prompt_version_id, retrieval_snapshot_id, document_version_set_sha256, supersedes_run_id, requested_by, started_at, finished_at, cancel_reason, created_at
- `analysis_finding` (sửa): id, run_id, criterion_id, status, finding, evidence_refs, reviewer_id, override_reason, confidence_type, evidence_count, final_status, reviewed_at, created_at
- `procurement_plan` (mới): id, project_id, revision, title, total_value_vnd, legal_basis, decision_document_id, status, supersedes_id, approved_by, approved_at, created_at, created_by, updated_at, updated_by, version
- `procurement_milestone` (mới): id, package_id, milestone_kind, planned_at, actual_at, source, import_batch_id, created_at, created_by, updated_at, updated_by, version
- `procurement_result` (mới): id, package_id, winner_contractor_id, award_price_vnd, evaluation_report_id, decision_document_id, outcome, status, submitted_by, approved_by, approved_at, created_at, created_by, updated_at, updated_by, version
- `procurement_import_batch` (mới): id, source_system, adapter_status, file_sha256, file_object_key, mode, rows_total, rows_ok, rows_error, errors_json, status, created_at, created_by, updated_at, updated_by, version
- `procurement_external_link` (mới): id, package_id, external_system, external_code, last_batch_id, diff_status, diff_json, diff_owner_user_id, created_at, created_by, updated_at, updated_by, version
- `bid_conflict_declaration` (mới): id, package_id, user_id, has_conflict, relation_text, contractor_id (nhà thầu có quan hệ; bỏ trống = toàn gói), declared_at, decision, decided_by, decided_at, decision_reason, created_at, created_by, updated_at, updated_by, version
- `procurement_petition` (mới): id, package_id, contractor_id, petition_kind, received_on, due_on, petition_document_id, status, resolution_document_id, handled_by, created_at, created_by, updated_at, updated_by, version
- `proposal_document` (mới): id, proposal_id, document_version_id, part, received_at, received_by
- `document_page_ocr` (mới): id, document_version_id, page_index, ocr_confidence, text_sha256, text_object_key, tables_json, engine_version, review_status, reviewed_by, reviewed_at, created_at
- `analysis_evidence` (mới): id, finding_id, evidence_kind, document_version_id, page_index, bbox, quote_sha256, quote_excerpt, contractor_performance_id, calc_ref, verified_present, created_at
- `analysis_finding_review` (mới): id, finding_id, reviewer_user_id, from_status, to_status, score_before, score_after, reason, ai_decision_record_id, decided_at, decision (ACCEPTED/ACCEPTED_WITH_CHANGE/REJECTED), checked_evidence_ids (V1352; bất biến, chỉ ghi khi lượt chạy chờ chuyên gia hoặc đã đủ quyết định)
- `evaluation_report` (mới): id, package_id, criteria_version_id, run_ids, summary_json, dissenting_opinions, payload_sha256, report_document_id, status, signed_off_by, created_at, created_by, updated_at, updated_by, version
- `bid_clarification` (mới): id, package_id, proposal_id, question, basis_finding_id, due_at, status, sent_document_id, answer_document_id, answered_at, answered_by, answered_as_guest (V1353; ghi ở trạng thái SENT cùng thư mật của DOC; câu hỏi, hạn và thư không đổi; đã trả lời/hết hạn/rút được giữ nguyên; mỗi văn bản chỉ là thư hoặc câu trả lời của một yêu cầu), created_at, created_by, updated_at, updated_by, version
- `contractor_restriction` (mới): id, contractor_id, kind, source, effective_from, effective_until, decision_document_id, import_batch_id, note, created_at, created_by, updated_at, updated_by, version

## 7. API / command

| operationId | Method path | x-permission | Request DTO | Lỗi chính | Idem | If-Match |
|---|---|---|---|---|---|---|
| `createProcurementPlan` | POST /procurement-plans | bid.plan.manage | `BidPlanCreate` | PROJECT_STAGE_INVALID, PACKAGE_CODE_DUPLICATE, ALLOCATION_LINE_INVALID | ✔ | – |
| `submitProcurementPlan` | POST /procurement-plans/{id}/submit | bid.plan.manage | – | PLAN_STATE_INVALID, PACKAGE_BUDGET_EXCEEDS_ALLOCATION | ✔ | ✔ |
| `decideProcurementPlan` | POST /procurement-plans/{id}/decision | bid.plan.approve | `BidPlanDecision` | SELF_APPROVAL_DENIED, DECISION_DOCUMENT_NOT_EFFECTIVE, PLAN_STATE_INVALID | ✔ | ✔ |
| `createCriteriaVersion` | POST /criteria-versions | bid.criteria.manage | `BidCriteriaDraft` | CRITERIA_WEIGHT_INVALID, PROHIBITED_CRITERION, PACKAGE_STATE_INVALID | ✔ | – |
| `approveCriteriaVersion` | POST /criteria-versions/{id}/approval | bid.criteria.approve | – | SELF_APPROVAL_DENIED, CRITERIA_LOCKED_BY_RUN, CRITERIA_STATE_INVALID, VERSION_CONFLICT | ✔ | ✔ |
| `registerContractor` | POST /contractors | bid.contractor.manage | `BidContractorRegister` | TAX_ID_INVALID, CONTRACTOR_ALREADY_VERIFIED | ✔ | – |
| `verifyContractor` | POST /contractors/{id}/verification | bid.contractor.verify | `BidContractorVerify` | SELF_APPROVAL_DENIED, TAX_ID_DUPLICATE_VERIFIED | ✔ | ✔ |
| `recordContractorRestriction` | POST /contractors/{id}/restrictions | bid.contractor.verify | `BidRestriction` | DECISION_DOCUMENT_NOT_EFFECTIVE | ✔ | – |
| `receiveProposal` | POST /proposals | bid.proposal.receive | `BidProposalReceive` | BID_CLOSED, CONTRACTOR_RESTRICTED, CONTRACTOR_NOT_VERIFIED, SCAN_PENDING | ✔ | – |
| `reviewOcrPage` | POST /document-page-ocr/{id}/review | bid.ocr.review | `BidOcrReview` | OCR_STATE_INVALID; CONFLICT_UNDECLARED; VALIDATION_FAILED | ✔ | – |
| `uploadOcrCorrectionFile` | POST /document-page-ocr/files | bid.ocr.review | tệp văn bản thuần | văn bản đã sửa của một trang được quét mã độc, lưu kho; chưa gắn vào trang nào | FILE_NOT_CLEAN, FILE_TYPE_NOT_ALLOWED, PAYLOAD_TOO_LARGE, SCAN_PENDING | ✔ | – |
| `listProposalOcrPages` | GET /proposals/{id}/ocr-pages | bid.ocr.read | – | `BidOcrPageList`: trang, độ tin cậy, văn bản nhận dạng, trạng thái xác nhận và cổng cho phân tích tài chính; chỉ người có toàn quyền xem hồ sơ | CONFLICT_UNDECLARED | – | – |
| `declareConflictOfInterest` | POST /procurement-packages/{id}/conflict-declarations | bid.evaluate | `BidConflictDeclare` | ALREADY_DECLARED | ✔ | – |
| `decideConflictOfInterest` | POST /bid-conflict-declarations/{id}/decision | bid.conflict.decide | `BidConflictDecision` | SELF_APPROVAL_DENIED | ✔ | ✔ |
| `uploadProposalFile` | POST /proposals/files | bid.proposal.receive | tệp PDF | tệp được quét mã độc, lưu kho, đếm trang; chưa gắn vào hồ sơ nào | FILE_NOT_CLEAN, SCAN_PENDING, UPLOAD_NOT_PDF | ✔ | – |
| `listConflictDeclarations` | GET /procurement-packages/{id}/conflict-declarations | bid.read | – | người có `bid.conflict.decide` thấy mọi khai báo của gói, thành viên tổ chuyên gia thấy khai báo của mình | – | – | – |
| `reviewAnalysisFinding` | POST /analysis-findings/{id}/review | bid.evaluate | `BidFindingReview` | CONFLICT_UNDECLARED, REASON_REQUIRED (lý do < 20 ký tự sau khi cắt khoảng trắng; do lệnh phán, không phải schema), RUN_NOT_COMPLETED, VERSION_CONFLICT, VALIDATION_FAILED (điểm ngoài thang); trả `BidFindingReviewed` | ✔ | ✔ (phiên bản nhận xét = số quyết định + 1) |
| `createEvaluationReport` | POST /evaluation-reports | bid.evaluate | `BidReportCreate` | CRITERIA_VERSION_MISMATCH, UNREVIEWED_FINDINGS | ✔ | – |
| `signOffEvaluationReport` | POST /evaluation-reports/{id}/sign-off | bid.evaluate | – | CONFLICT_UNDECLARED, ALREADY_SIGNED_OFF | ✔ | ✔ |
| `sendBidClarification` | POST /bid-clarifications | bid.evaluate | `BidClarificationCreate` | PROPOSAL_NOT_OPEN, DUE_IN_PAST, CONFLICT_UNDECLARED, VALIDATION_FAILED (câu hỏi, căn cứ không thuộc đề án); người dùng guest nhận SCOPE_DENIED | ✔ | – |
| `recordClarificationAnswer` | POST /bid-clarifications/{id}/answer | bid.clarification.answer | `BidClarificationAnswer` | CLARIFICATION_EXPIRED, CLARIFICATION_STATE_INVALID, VERSION_CONFLICT, CONFLICT_UNDECLARED, VALIDATION_FAILED (văn bản không có, là thư làm rõ, đã dùng cho yêu cầu khác, hồ sơ dự thầu, hoặc guest nêu văn bản không do mình tạo); ngoài phạm vi → 404 (SCOPE_DENIED không phát ra: UAT-AC452 đòi 404) | ✔ | ✔ |
| `listBidClarifications` | GET /bid-clarifications | bid.clarification.read | – | `BidClarificationList`: guest chỉ thấy yêu cầu gửi cho nhà thầu của mình và không thấy người hỏi hay nhận xét căn cứ; nhân sự theo phạm vi dự án và khai báo xung đột (CONFLICT_UNDECLARED); lọc `package_id`, `proposal_id`; `status` EXPIRED là trạng thái hiển thị | VALIDATION_FAILED | – | – |
| `getBidClarification` | GET /bid-clarifications/{id} | bid.clarification.read | – | một yêu cầu; của nhà thầu khác hoặc tenant khác → 404 | CONFLICT_UNDECLARED | – | – |
| `submitProcurementResult` | POST /procurement-results | bid.result.submit | `BidResultSubmit` | PRICE_EXCEEDS_PACKAGE_BUDGET, PLAN_NOT_APPROVED, CONTRACTOR_RESTRICTED, REPORT_NOT_ISSUED | ✔ | – |
| `decideProcurementResult` | POST /procurement-results/{id}/decision | bid.result.approve | `BidResultDecision` | SELF_APPROVAL_DENIED, DECISION_DOCUMENT_NOT_EFFECTIVE, RESULT_STATE_INVALID | ✔ | ✔ |
| `listProcurementResults` | GET /procurement-results | bid.read | – | `BidResultList` | VALIDATION_FAILED | – | – |
| `importProcurementFile` | POST /procurement-imports | bid.import | `BidImportRequest` | IMPORT_FILE_ALREADY_APPLIED, IMPORT_HAS_ERRORS, UPLOAD_NOT_ALLOWED_TYPE | ✔ | – |
| `recordProcurementMilestone` | POST /procurement-packages/{id}/milestones | bid.plan.manage | `BidMilestone` | MILESTONE_ORDER_INVALID | ✔ | ✔ |
| `uploadProcurementFile` | POST /procurement-imports/files | bid.import | tệp CSV/XLSX | tệp được quét mã độc, lưu kho và đọc cột package_code, external_code, milestone_kind, actual_at | FILE_NOT_CLEAN, IMPORT_SCHEMA_INVALID, IMPORT_EMPTY | ✔ | – |
| `listProcurementMilestones` | GET /procurement-milestones | bid.read | – | mốc của các gói thầu trong phạm vi, theo mã gói và thứ tự mốc | – | – | – |
| `listProcurementExternalLinks` | GET /procurement-external-links | bid.read | – | liên kết gói thầu với mã gói ngoài, sai lệch (mốc, mã gói), chủ sở hữu sai lệch và lần nhập gần nhất | – | – | – |
| `receiveProcurementPetition` | POST /procurement-petitions | bid.petition.manage | `BidPetitionReceive` | PETITION_OUT_OF_TIME; PETITION_STATE_INVALID; TIMER_RULE_UNCONFIRMED; CALENDAR_NOT_EFFECTIVE; VALIDATION_FAILED; SCOPE_DENIED | ✔ | – |
| `resolveProcurementPetition` | POST /procurement-petitions/{id}/resolution | bid.petition.manage | `BidPetitionResolve` | PETITION_STATE_INVALID; CONFLICT_OF_INTEREST_BLOCKED; VALIDATION_FAILED; SCOPE_DENIED; VERSION_CONFLICT | ✔ | ✔ |
| `listProcurementPetitions` | GET /procurement-petitions | bid.read | – | `BidPetitionList` | VALIDATION_FAILED | – | – |
| `compareProposals` | GET /procurement-packages/{id}/proposal-comparison | bid.evaluate | – | `BidComparison`: các đề án có toàn quyền xem, cùng `criteria_version_id` (mặc định bản đang hiệu lực), ô chỉ chứa quyết định của người; `excluded` liệt kê lượt bị loại (`CRITERIA_VERSION_MISMATCH`, `NO_ANALYSIS_RUN`), `excluded_criteria` và `excluded_attributes`; CONFLICT_UNDECLARED, VALIDATION_FAILED (bản tiêu chí của gói khác) | – | – |
| `getContractorHistory` | GET /contractors/{id}/history | bid.contractor.read | – | – | – | – |
| `listAnalysisFindings` | GET /analysis-runs/{id}/findings | bid.evaluate | – | `AnalysisFindingList`: nhận xét kèm dẫn chứng (trang, trích dẫn, `verified_present`), cờ `missing_source`; chỉ người có toàn quyền xem hồ sơ; lọc `status`, `missing_source` | CONFLICT_UNDECLARED | – | – |
| `searchProposalPassages` | GET /procurement-packages/{id}/proposal-passages | bid.evaluate | – | `BidProposalPassageList`: đoạn văn nhất gần câu hỏi, chỉ từ trang của hồ sơ người gọi có toàn quyền xem (ACL lọc trước khi nhúng và so sánh; người bị RECUSED không thấy hồ sơ của nhà thầu đó) | VALIDATION_FAILED, AI_ROUTE_NOT_ALLOWED, AI_KILL_SWITCH_ENGAGED, MODEL_NOT_APPROVED | – | – |
| `listProcurementPlans` | GET /procurement-plans | bid.read | – | – | – | – |

Lệnh baseline giữ nguyên (không đổi operationId/path): `post_analysis_runs` (POST /analysis-runs, `ai.analyze`; thân `AnalysisRequest` thêm `max_cost_vnd` tùy chọn; lỗi CONFLICT_UNDECLARED, CRITERIA_STATE_INVALID, PROFILE_NOT_PUBLISHED, TOOL_NOT_READ_ONLY, OCR_NOT_RECORDED, OCR_REVIEW_PENDING, AI_ROUTE_NOT_ALLOWED, BUDGET_EXCEEDED, AI_KILL_SWITCH_ENGAGED; không có If-Match) và `post_analysis_runs_id_cancel` (POST /analysis-runs/{id}/cancel, `ai.cancel`, If-Match, thân `AnalysisCancel` {reason}; lỗi ANALYSIS_STATE_INVALID, VERSION_CONFLICT) — đặc tả hành vi ở F5; và `post_findings_id_review` (POST /findings/{id}/review, `ai.review`, If-Match, thân `BidFindingDecision` {decision: approve|reject, reason, evidence_ids}; cùng lệnh với `reviewAnalysisFinding`: approve giữ trạng thái đang đứng, reject trả về NEEDS_REVIEW, nêu các trích dẫn đã kiểm; `return` không còn vì nhận xét không có nơi để trả về) — đặc tả hành vi ở F6; đọc lượt/nhận xét qua `get_resources_analysis_run(_id)` và `get_resources_analysis_finding(_id)` (DTO không trả `input_hash` và `ai_request_id`). **Rà soát GET scaffold:** `contractor` dto (mask MST một phần với người không đủ quyền; guest chỉ thấy chính mình); `proposal` dto (CONFIDENTIAL, ACL + `access_released_at`); `procurement_package` giữ; `criteria_version` giữ; `analysis_run` dto; `analysis_finding` dto (đọc đầy đủ qua `listAnalysisFindings`). Không có endpoint ghi chung cho `status`, `final_status`, `award_price_vnd` đã duyệt.

## 8. UI/UX

Giữ BID-01…BID-20 (field baseline giữ nguyên, chỉ bổ sung — bảng CR §13); mới BID-21 (hạn chế tham gia). Component: DataTable, FilterBar, EvidenceViewer (trang PDF + bbox dẫn chứng, cờ "Thiếu nguồn"), ComparePanel (BID-10, chỉ cột cùng phiên bản tiêu chí), WorkflowCanvas (BID-08 tiến trình), QualityBadge (OCR), MoneyInput (giá gói, giá trúng).

| ID | Tên | Kind | Phase | Nền tảng | Trường chính |
|---|---|---|---|---|---|
| BID-01 | Danh sách nhà thầu | list | P1 | web | Mã số thuế; Tên; Năng lực; Hợp đồng; Trạng thái xác minh; Hạn chế còn hiệu lực |
| BID-02 | Hồ sơ nhà thầu | detail | P1 | web | Pháp lý; Nhân sự; Kinh nghiệm; Lịch sử thực hiện; Thẻ điểm thực hiện hợp đồng (APPROVED); Cấm/đình chỉ |
| BID-03 | Gói thầu và đề án | list | P1 | web | Gói thầu; Dự án; Giai đoạn; Hạn; KHLCNT (revision); Nguồn vốn |
| BID-04 | Tiêu chí đánh giá | criteria | P1 | web | Tiêu chí; Trọng số; Ngưỡng; Bằng chứng yêu cầu; Trạng thái duyệt; Σ trọng số |
| BID-05 | Tiếp nhận hồ sơ | import | P1 | web | Nhà thầu; Tệp; Phiên bản; Phân loại bảo mật; Thời điểm mở quyền xem; Giá dự thầu |
| BID-06 | Kiểm tra OCR | documents | P1 | web | Trang; Độ tin cậy; Nội dung gốc; Nội dung nhận dạng; Trạng thái xác nhận |
| BID-07 | Cấu hình lượt phân tích | form | P1 | web | Bộ tiêu chí; Phiên bản hồ sơ; Profile AI; Hạn chi phí; Phân loại dữ liệu; Tuyến model được phép |
| BID-08 | Tiến trình phân tích | timeline | P1 | web | Trích xuất; Đối chiếu; Kiểm chứng; Hoàn tất; Bước thất bại; Chi phí đã dùng |
| BID-09 | Bàn phân tích có dẫn chứng | ai | P1 | web | Tiêu chí; Nhận xét AI; Trang nguồn; Độ chắc chắn; Trạng thái bằng chứng; Trích dẫn đã kiểm |
| BID-10 | So sánh đề án | compare | P1 | web | Nhà thầu A; Nhà thầu B; Tiêu chí; Rủi ro; Phiên bản tiêu chí dùng chung |
| BID-11 | Làm rõ hồ sơ | conversation | P1 | web | Câu hỏi; Căn cứ; Hạn trả lời; Người nhận; Trạng thái; Văn bản trả lời |
| BID-12 | Thẩm tra chuyên gia | review | P1 | web | Nhận xét; Điều chỉnh; Lý do; Xung đột lợi ích; Lịch sử thẩm tra |
| BID-13 | Biên bản đánh giá | documents | P1 | web | Phiên bản; Chữ ký; Kết luận; Ý kiến khác; Trạng thái DOC |
| BID-14 | Hợp đồng và thay đổi | table | P1 | web | Hợp đồng; Giá trị; Tiến độ; Phụ lục |
| BID-15 | Kế hoạch lựa chọn nhà thầu | table | P1 | web | Gói thầu; Dự toán; Phương thức; Thời gian; Trạng thái; Quyết định phê duyệt (DOC) |
| BID-16 | Lập và điều chỉnh kế hoạch thầu | form | P1 | web | Dự án; Gói thầu; Giá gói thầu; Nguồn vốn; Căn cứ; Phương thức; Loại hợp đồng; Hình thức (qua mạng/không qua mạng) |
| BID-17 | Theo dõi mời thầu và mốc lựa chọn | timeline | P1 | web | Gói thầu; Ngày mời; Đóng thầu; Làm rõ; Mở thầu; Nguồn mốc (thủ công/nhập tệp) |
| BID-18 | Phê duyệt kết quả lựa chọn | approval | P1 | web | Gói thầu; Báo cáo chuyên gia; Nhà thầu; Giá trúng; Quyết định; Kết quả (trúng/không có HSDT đạt/hủy) |
| BID-19 | Liên kết cổng đấu thầu và đối soát | import | P1 | web | Mã gói thầu ngoài; Nguồn; Lần đồng bộ; Sai lệch; Băm tệp; Chế độ dry-run/apply |
| BID-20 | Kiến nghị và xung đột lợi ích | form | P1 | web | Gói thầu; Người liên quan; Khai báo; Kiến nghị; Hạn xử lý; Quyết định xử lý xung đột |
| BID-21 | Hạn chế tham gia lựa chọn nhà thầu | table | P1 | web | Nhà thầu; Loại hạn chế; Nguồn; Hiệu lực; Quyết định |

Trạng thái riêng: "Chưa khai báo xung đột" (chặn toàn trang hồ sơ), "Hồ sơ khóa tới giờ mở thầu", "Trang OCR cần xác nhận", "Thiếu nguồn", "Đã thẩm tra (có lý do)", "Tuyến AI bị chặn (phân loại)", "Adapter PROPOSED — nhập tệp thủ công". Nhãn AI luôn hiển thị "Đề xuất của AI — cần chuyên gia thẩm tra"; không có nút hành động hàng loạt "chấp nhận tất cả". Mobile: không có màn BID.

## 9. Sự kiện, job, tích hợp, quan sát

Events: `bid.plan.drafted/submitted/approved.v1`, `bid.criteria.drafted/approved.v1`, `bid.contractor.registered/verified/restricted.v1`, `bid.proposal.received.v1`, `bid.ocr.reviewed.v1`, `bid.conflict.declared/decided.v1`, `bid.finding.reviewed.v1`, `bid.report.drafted/signed_off.v1`, `bid.clarification.sent/answered.v1`, `bid.result.submitted.v1`, `bid.result.approved.v1 {package_id, contractor_id, award_price_vnd, decision_document_id}`, `bid.import.applied.v1`, `bid.milestone.recorded.v1`, `bid.petition.received/resolved.v1`. Consumers: `ctr.contractor_evaluation.approved.v1` (CTR → làm mới lịch sử), `doc.issued/rejected.v1` (biên bản, QĐ), `llm.request.completed.v1`/`failed.v1` (tiến trình lượt), `master.record_merged.v1` (MDM → cập nhật `master_record_id`). Temporal: `BidAnalysisWorkflow` (các bước pipeline, mỗi bước một `ai_request`, timeout và hủy), `BidImportWorkflow`. Job: `bid.petition-due` (hằng ngày), `bid.restriction-expiry`. Telemetry: `bid_finding_missing_evidence_ratio`, `bid_finding_override_ratio` (chuyên gia đổi trạng thái AI), `bid_run_cost_vnd`, `bid_ocr_review_backlog`; log không chứa nội dung hồ sơ hay tên nhân sự.

## 10. Kiểm thử

Ma trận: positive (AC445, AC451, AC455), negative (AC17, AC447, AC452), boundary (AC449, AC455), đồng thời/idempotency (AC15, AC454), bảo mật (AC14, AC448, AC450, AC446), AI (AC13, AC16; đánh giá tuyến ở LLM).

| ID | Loại | Ưu tiên | Setup | Input/Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC13 | business | P1 | Gói G-01, criteria_version CV-1 (5 tiêu chí, 3 tiêu chí "quan trọng"), hồ sơ HS-A 40 trang đã OCR; lượt R-13 COMPLETED với 5 nhận xét; profile AI mock trả 1 nhận xét quan trọng không có trang nguồn. | 1) GET /analysis-runs/{R-13}/findings 2) Mở BID-09 cho tiêu chí thiếu nguồn 3) Kiểm analysis_evidence.verified_present của các trích dẫn | 4 nhận xét có ≥ 1 dẫn chứng DOCUMENT (document_version, page_index, quote_sha256, verified_present=true); nhận xét quan trọng thiếu nguồn có status=NEEDS_REVIEW và cờ "Thiếu nguồn" trên BID-09; không có nhận xét SUPPORTED/CONTRADICTED nào với evidence_count=0 (guard BR-BID-07 trong command ghi nhận xét). | DB analysis_evidence + UI |
| UAT-AC14 | business | P1 | Hai hồ sơ HS-A (nhà thầu A) và HS-B (nhà thầu B) cùng gói; chuyên gia E1 có quyền HS-A nhưng HS-B bị giới hạn (acl_json loại E1 vì xung đột RECUSED); chỉ mục vector chứa cả hai. | 1) E1 chạy truy vấn hỏi đáp trong BID-09 "kinh nghiệm thi công cầu" 2) E1 mở dẫn chứng là trang 12 của HS-B qua GET /document-versions/{HS-B-v}/download 3) Kiểm log truy xuất | Kết quả truy xuất chỉ gồm đoạn của HS-A (lọc tenant + ACL trước khi tính tương đồng); mở trang HS-B trả 404; log truy xuất không có id đoạn của HS-B. | retrieval log + API log |
| UAT-AC15 | business | P1 | Lượt R-15 COMPLETED với CV-1 và tập tài liệu S1 (băm D1); sau đó CV-2 được duyệt và HS-A bổ sung tệp làm rõ (tập S2, băm D2). | 1) POST /analysis-runs với CV-2 + S2 2) POST /analysis-runs lại với CV-1 + S1 (cùng input) 3) Đọc R-15 và nhận xét của nó | Lượt mới R-16 với supersedes_run_id=R-15, input_hash khác; lặp lại CV-1 + S1 trả lượt R-15 hiện có (unique input) thay vì tạo bản mới; nhận xét và trạng thái của R-15 không đổi (không UPDATE nào trên analysis_finding của R-15). | DB analysis_run |
| UAT-AC16 | business | P1 | Nhận xét F-16 status=SUPPORTED điểm 4/5 trong lượt R-16; chuyên gia E2 đã khai báo không xung đột; người có thẩm quyền A-approver. | 1) E2 POST /analysis-findings/{F-16}/review {to_status:"CONTRADICTED", score_after:"2", reason:"ngắn"} 2) Lặp lại với reason "Hợp đồng tương tự ở trang 18 chưa được nghiệm thu, không đạt yêu cầu kinh nghiệm" 3) E2 POST /procurement-results/{id}/decision APPROVE | Lần 1: 422 REASON_REQUIRED; lần 2: 200, analysis_finding_review ghi from SUPPORTED → CONTRADICTED, score 4 → 2, ai_decision_record ACCEPTED_WITH_CHANGE; quyết định KQLCNT bởi E2: 403 SCOPE_DENIED (chỉ A-approver có bid.result.approve). | analysis_finding_review + ai_decision_record |
| UAT-AC17 | business | P1 | Gói G-01: lượt R-A (nhà thầu A, CV-2) và R-B (nhà thầu B, CV-1); người soạn tiêu chí thử thêm tiêu chí "Giám đốc là người địa phương" và "Giới tính người đại diện". | 1) GET /procurement-packages/{G-01}/proposal-comparison?criteria_version_id=CV-2 2) POST /criteria-versions với tiêu chí bị cấm | So sánh chỉ gồm lượt CV-2 (R-A) và báo R-B bị loại vì CRITERIA_VERSION_MISMATCH; excluded_attributes liệt kê tên/đặc tính cá nhân; tạo tiêu chí bị cấm: 422 PROHIBITED_CRITERION. | API log |
| UAT-AC445 | domain | P0 | Dự án P-A-010 IMPLEMENTATION, dòng vốn AL-1 = 30.000.000.000; A-planner lập KHLCNT 2 gói G-01 18 tỷ, G-02 10 tỷ; A-approver có bid.plan.approve. | 1) POST /procurement-plans {...}; submit; A-planner tự decision APPROVE 2) A-approver APPROVE không có decision_document_id, rồi có QĐ KH-01 (EFFECTIVE) 3) Lập revision 2 thêm G-03 5 tỷ (Σ 33 tỷ > 30 tỷ) và submit | Tự duyệt: 403 SELF_APPROVAL_DENIED; thiếu QĐ: 422 DECISION_DOCUMENT_NOT_EFFECTIVE; có QĐ: APPROVED, bid.plan.approved.v1; revision 2 submit: 422 PACKAGE_BUDGET_EXCEEDS_ALLOCATION; vẫn chỉ 1 KHLCNT APPROVED. | DB |
| UAT-AC446 | domain | P0 | Nhà thầu NT-1 MST 0101234567 VERIFIED; NT-2 cùng MST nhưng UNVERIFIED tên "Cty NT Một"; NT-3 bị DEBARMENT 2026-01-01..2027-12-31 theo QĐ. | 1) POST /contractors/{NT-2}/verification VERIFIED 2) POST /proposals cho NT-3 vào G-01 3) POST /procurement-results với winner NT-3 | Xác minh NT-2: 409 TAX_ID_DUPLICATE_VERIFIED (không gộp tự động; gợi ý merge MDM); NT-3 hồ sơ: 422 CONTRACTOR_RESTRICTED; trình kết quả: 422 CONTRACTOR_RESTRICTED. | DB + API log |
| UAT-AC447 | domain | P1 | Bộ tiêu chí CV-3 trọng số 30/30/20/10 (Σ 90); CV-4 hợp lệ Σ 100 đã có lượt phân tích. | 1) POST /criteria-versions CV-3 2) Duyệt CV-4 lần nữa sau khi sửa trọng số | CV-3: 422 CRITERIA_WEIGHT_INVALID; sửa CV-4 sau khi có lượt: 409 CRITERIA_LOCKED_BY_RUN (tạo revision mới). | DB |
| UAT-AC448 | security | P0 | Hồ sơ HS-A nhận lúc 2026-11-10 09:00, đóng thầu 2026-11-12 09:00 (access_released_at); E1 thuộc tổ chuyên gia đã khai báo; văn thư VT có bid.proposal.receive. | 1) E1 GET /resources/proposal/{HS-A} lúc 2026-11-11 2) VT GET cùng lúc 3) E1 GET lúc 2026-11-12 09:05 | E1 trước giờ mở: 404; VT: chỉ metadata (nhà thầu, thời điểm nhận, số tệp), không có giá dự thầu và tệp; sau giờ mở E1 thấy đầy đủ DTO. | API log |
| UAT-AC449 | domain | P1 | HS-A có trang 23 (bảng giá) ocr_confidence 0.71 < ngưỡng 0.85 → NEEDS_REVIEW. | 1) POST /analysis-runs cho HS-A 2) Chuyên gia POST /document-page-ocr/{p23}/review CORRECTED 3) Chạy lại | Lượt đầu dừng ở bước trích xuất tài chính với trạng thái AWAITING_REVIEW (không gọi model cho phần tài chính); sau xác nhận, lượt mới chạy đủ; giá dự thầu được tính bằng code decimal từ bảng đã xác nhận. | DB |
| UAT-AC450 | security | P0 | E3 thuộc tổ chuyên gia gói G-01 chưa khai báo; E4 khai báo có quan hệ với NT-1. | 1) E3 GET /analysis-runs/{R}/findings 2) E4 tự POST /bid-conflict-declarations/{id}/decision ALLOWED 3) A-approver quyết định RECUSED; E4 truy cập HS của NT-1 | E3: 403 CONFLICT_UNDECLARED; E4 tự quyết: 403 SELF_APPROVAL_DENIED; sau RECUSED E4 nhận 404 với hồ sơ NT-1 và bị loại khỏi signed_off_by. | audit |
| UAT-AC451 | integration | P1 | CTR có bảng điểm contractor_performance CP-7 (hợp đồng C-07, NT-1, kỳ 2026-Q3, overall 83.00) APPROVED và CP-8 (SUBMITTED, chưa duyệt); CTR phát ctr.contractor_evaluation.approved.v1 cho CP-7. | 1) GET /contractors/{NT-1}/history 2) Chạy lượt phân tích mới của NT-1 cho tiêu chí "kinh nghiệm thực hiện hợp đồng tương tự" 3) Đọc analysis_evidence của nhận xét | History chỉ gồm CP-7 (APPROVED) với overall 83.00, không có CP-8; nhận xét có dẫn chứng evidence_kind=SCORECARD trỏ contractor_performance_id=CP-7; BID không ghi bảng điểm riêng (nguồn sự thật CTR). | DB + API |
| UAT-AC452 | security | P1 | Làm rõ CL-1 gửi NT-1 (guest scope hợp đồng/gói G-01), hạn 2026-11-20 17:00; NT-2 là guest gói khác. | 1) NT-2 GET/POST answer cho CL-1 2) NT-1 trả lời 2026-11-20 16:00 3) NT-1 trả lời lần hai 2026-11-21 | NT-2: 404; NT-1 lần 1: ANSWERED với answer_document_id; lần hai: 409 CLARIFICATION_EXPIRED (trạng thái không đổi). | API log |
| UAT-AC453 | integration | P1 | Gói G-01 có 6 nhận xét, 1 nhận xét chưa thẩm tra (final_status NULL); tổ chuyên gia 3 người. | 1) POST /evaluation-reports 2) Thẩm tra nhận xét còn lại rồi tạo lại; 3 người sign-off 3) DOC phát doc.issued cho biên bản | Lần đầu: 422 UNREVIEWED_FINDINGS; sau thẩm tra: DRAFT; đủ 3 sign-off → ISSUE_REQUESTED; sau doc.issued → ISSUED với report_document_id. | DB + DOC |
| UAT-AC454 | integration (idempotency) | P0 | Tệp kết quả từ Hệ thống mạng đấu thầu quốc gia 3 dòng (1 dòng mã gói không tồn tại), adapter PROPOSED, không có lời gọi mạng ra ngoài. | 1) POST /procurement-imports DRY_RUN 2) APPLY 3) APPLY lại cùng tệp 4) Kiểm egress log | Dry-run: rows_ok=2, rows_error=1 (PACKAGE_NOT_FOUND) không ghi dữ liệu; APPLY: 2 mốc BID_OPENING/RESULT_PUBLISHED source=IMPORT, external_link IN_SYNC; APPLY lại: 409 IMPORT_FILE_ALREADY_APPLIED; egress 0 kết nối tới muasamcong. | procurement_import_batch |
| UAT-AC455 | domain | P0 | G-01 giá gói 18.000.000.000; báo cáo đánh giá ISSUED; A-proposer trình, A-approver duyệt. | 1) POST /procurement-results {outcome:"AWARDED", winner:NT-1, award_price_vnd:"18500000000"} 2) Trình lại 17.650.000.000; A-proposer tự duyệt 3) A-approver duyệt kèm QĐ KQ-01 | 422 PRICE_EXCEEDS_PACKAGE_BUDGET; tự duyệt 403 SELF_APPROVAL_DENIED; APPROVED, bid.result.approved.v1 {package_id, contractor_id, award_price_vnd:"17650000000", decision_document_id}; không có dấu vết AI trong quyết định ngoài liên kết báo cáo. | DB + outbox |
| UAT-AC456 | business | P1 | Quy tắc hạn xử lý kiến nghị là dữ liệu (ví dụ 7 ngày làm việc [CXN-BID-02]); NT-2 gửi kiến nghị về kết quả ngày 2026-11-25. | 1) POST /procurement-petitions 2) Đặt đồng hồ sau hạn chưa trả lời 3) POST resolution kèm văn bản | due_on tính theo lịch làm việc tenant; quá hạn hiển thị cảnh báo và nhắc NOT; RESOLVED khi có resolution_document_id; thiếu văn bản: 422. | DB |

## 11. Tiêu chí nghiệm thu

- **AC-BID-01** (FRD AC13) Mọi nhận xét quan trọng có trang nguồn đã kiểm hoặc cờ thiếu nguồn. → UAT-AC13
- **AC-BID-02** (FRD AC14) ACL tài liệu áp dụng cả truy xuất vector và mở dẫn chứng. → UAT-AC14, UAT-AC448
- **AC-BID-03** (FRD AC15) Đổi tiêu chí/hồ sơ tạo lượt mới; lượt cũ không bị viết lại. → UAT-AC15
- **AC-BID-04** (FRD AC16) Chuyên gia sửa điểm phải có lý do; kết luận cuối do người có thẩm quyền. → UAT-AC16, UAT-AC455
- **AC-BID-05** (FRD AC17) So sánh cùng phiên bản tiêu chí; không dùng tên/đặc tính cá nhân. → UAT-AC17, UAT-AC447
- **AC-BID-06** Given KHLCNT, Then tách nhiệm vụ, QĐ bắt buộc, Σ gói ≤ vốn. → UAT-AC445
- **AC-BID-07** Given nhà thầu trùng MST hoặc bị hạn chế, Then bị chặn. → UAT-AC446
- **AC-BID-08** Given xung đột lợi ích chưa khai báo/đã RECUSED, Then không xem được hồ sơ. → UAT-AC450
- **AC-BID-09** Given tệp từ Hệ thống mạng đấu thầu quốc gia, Then dry-run/apply idempotent, không gọi mạng. → UAT-AC454
- **AC-BID-10** Given bảng điểm CTR, Then chỉ bản APPROVED xuất hiện trong lịch sử và làm dẫn chứng SCORECARD. → UAT-AC451

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1 (dùng thật):** F1, F2, F4, F7 (không AI), F8 nhập tệp, khai báo xung đột; BID-01…05, BID-15…BID-20 với dữ liệu thật. **R2:** F3 OCR, F5–F6 phân tích AI có dẫn chứng (khi LLM + tuyến trong nước đạt eval, NFR-AI-04), BID-06…BID-13, F9 lịch sử từ CTR, BID-21. **R3:** đồng bộ thêm nguồn chính thức khi có hợp đồng tích hợp (D05).
**Giờ review người:** quyết định AI và quy tắc dẫn chứng (AI Lead + chủ nghiệp vụ đấu thầu, 6 h); quy tắc pháp lý NĐ 214/2025 và kiến nghị [CXN-BID-01/02/03] (Pháp chế, 4 h); quyền/xung đột lợi ích (3 h); dẫn chứng bảng điểm CTR (1 h). Tổng ≈ 14 h.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| [CXN-BID-01] NĐ 214/2025 Điều 19–20: nội dung, kỳ và công bố đánh giá nhà thầu (CTR sở hữu dữ liệu) | Pháp chế + chủ nghiệp vụ đấu thầu | Văn bản gốc; seed trọng số |
| [CXN-BID-02] Thời hạn và cấp giải quyết kiến nghị trong lựa chọn nhà thầu | Pháp chế | Văn bản gốc → quy tắc dữ liệu |
| [CXN-BID-03] Mẫu hồ sơ/biên bản theo TT 79/2025/TT-BTC | Pháp chế | Mẫu DOC |
| D07: model trong nước/tự host đạt eval cho đọc hồ sơ tiếng Việt dài | AI Lead | Eval NFR-AI-04 đạt ngưỡng |
| Cross-module: CTR cung cấp interface đọc `getContractorScorecard` (bản APPROVED) và sự kiện `ctr.contractor_evaluation.approved.v1`; FK `analysis_evidence.contractor_performance_id` → `contractor_performance` | CTR owner | Đã có trong fragment execution; xác nhận interface public |
| Cross-module: MDM master CONTRACTOR khóa theo MST, sự kiện merge | MDM owner | Đã có merge/unmerge; xác nhận loại CONTRACTOR |
| Cross-module: CAP `getCapitalAvailability` cho kiểm vốn KHLCNT | CAP owner | Interface có sẵn |
| Không có API Hệ thống mạng đấu thầu quốc gia | Integration Lead (D05) | Giữ nhập tệp, adapter PROPOSED |
| Giả định giá trị enum baseline `contractor.verification_status` chứa 'VERIFIED' [GIẢ ĐỊNH] | Data owner | Kiểm khi migration; sửa điều kiện unique nếu khác |

**Thay đổi bản ghi baseline (CR, baseline-first):**

| Bản ghi baseline | Thay đổi (cũ → mới) | Lý do |
|---|---|---|
| bảng contractor | thêm cột master_record_id, legal_form, verified_by, verified_at, verification_evidence_document_id, created_at, created_by, updated_at, updated_by, version; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE | Đặc tả M1; quy ước RLS của 04 |
| bảng proposal | thêm cột submitted_at, bid_price_vnd, access_released_at, classification, withdrawn_reason, created_at, created_by, version; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE | Đặc tả M1; quy ước RLS của 04 |
| bảng procurement_package | thêm cột plan_id, title, contract_type, bidding_form, allocation_line_id, planned_start_period, duration_days, external_package_code, created_at, created_by, version; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE | Đặc tả M1; quy ước RLS của 04 |
| bảng criteria_version | thêm cột status, legal_basis, weights_sum, created_by, created_at, version; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK sod_chk, weights_chk | Đặc tả M1; quy ước RLS của 04 |
| bảng analysis_run | thêm cột package_id, ai_request_id, data_classification, route_class, prompt_version_id, retrieval_snapshot_id, document_version_set_sha256, supersedes_run_id, requested_by, started_at, finished_at, cancel_reason, created_at; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE | Đặc tả M1; quy ước RLS của 04 |
| bảng analysis_finding | thêm cột confidence_type, evidence_count, final_status, reviewed_at, created_at; policy tenant_boundary PERMISSIVE → RESTRICTIVE + thêm tenant_access PERMISSIVE; thêm CHECK override_chk | Đặc tả M1; quy ước RLS của 04 |
| GET /resources/contractor, /resources/contractor/{id} | thêm x-exposure=dto, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/proposal, /resources/proposal/{id} | thêm x-exposure=dto, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/procurement_package, /resources/procurement_package/{id} | thêm x-exposure=keep, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/criteria_version, /resources/criteria_version/{id} | thêm x-exposure=keep, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/analysis_run, /resources/analysis_run/{id} | thêm x-exposure=dto, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| GET /resources/analysis_finding, /resources/analysis_finding/{id} | thêm x-exposure=dto, x-exposure-reason (giữ nguyên mọi trường baseline) | BRIEF: phân loại GET scaffold |
| BID-01 / BL-BID-01 / trace FR-BID-01 | fields: +Trạng thái xác minh; Hạn chế còn hiệu lực; rule: nối thêm "Nhà thầu định danh theo MST đã xác minh (master MDM); không gộp theo tên gần giống."; test_ids (backlog, trace): +UAT-AC446 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-02 / BL-BID-02 / trace FR-BID-02 | fields: +Thẻ điểm thực hiện hợp đồng (APPROVED); Cấm/đình chỉ; rule: nối thêm "Lịch sử lấy từ bảng điểm CTR (contractor_performance APPROVED, getContractorScorecard); không phải nhận xét AI."; test_ids (backlog, trace): +UAT-AC451 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-03 / BL-BID-03 / trace FR-BID-03 | fields: +KHLCNT (revision); Nguồn vốn; rule: nối thêm "Gói thầu thuộc KHLCNT đã duyệt mới được tổ chức lựa chọn."; test_ids (backlog, trace): +UAT-AC445 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-04 / BL-BID-04 / trace FR-BID-04 | fields: +Trạng thái duyệt; Σ trọng số; rule: nối thêm "Σ trọng số = 100; tiêu chí cấm (tên, đặc tính cá nhân không liên quan) bị từ chối; khóa khi đã có lượt phân tích."; test_ids (backlog, trace): +UAT-AC17, UAT-AC447 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-05 / BL-BID-05 / trace FR-BID-05 | fields: +Thời điểm mở quyền xem; Giá dự thầu; rule: nối thêm "Hồ sơ CONFIDENTIAL, chỉ metadata trước thời điểm mở thầu; quét virus trước khi liên kết."; test_ids (backlog, trace): +UAT-AC448 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-06 / BL-BID-06 / trace FR-BID-06 | fields: +Trạng thái xác nhận; rule: nối thêm "Trang OCR dưới ngưỡng tin cậy phải được chuyên gia xác nhận trước phân tích tài chính."; test_ids (backlog, trace): +UAT-AC449 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-07 / BL-BID-07 / trace FR-BID-07 | fields: +Phân loại dữ liệu; Tuyến model được phép; rule: nối thêm "Phân loại lấy mức cao nhất của tài liệu; tuyến model theo chính sách R5 (không tự hạ phân loại)."; test_ids (backlog, trace): +UAT-AC15, UAT-AC19 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-08 / BL-BID-08 / trace FR-BID-08 | fields: +Bước thất bại; Chi phí đã dùng; rule: nối thêm "Mỗi bước là attempt có chi phí; hủy reconcile phần đã dùng."; test_ids (backlog, trace): +UAT-AC18 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-09 / BL-BID-09 / trace FR-BID-09 | fields: +Trạng thái bằng chứng; Trích dẫn đã kiểm; rule: nối thêm "Nhận xét quan trọng phải có trang nguồn hoặc cờ thiếu nguồn; mở dẫn chứng kiểm lại ACL tài liệu."; test_ids (backlog, trace): +UAT-AC13, UAT-AC14 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-10 / BL-BID-10 / trace FR-BID-10 | fields: +Phiên bản tiêu chí dùng chung; rule: nối thêm "Chỉ so sánh các lượt cùng criteria_version."; test_ids (backlog, trace): +UAT-AC17 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-11 / BL-BID-11 / trace FR-BID-11 | fields: +Trạng thái; Văn bản trả lời; rule: nối thêm "Gửi/nhận qua văn bản DOC; nhà thầu chỉ thấy câu hỏi của gói mình."; test_ids (backlog, trace): +UAT-AC452 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-12 / BL-BID-12 / trace FR-BID-12 | fields: +Lịch sử thẩm tra; rule: nối thêm "Sửa điểm/trạng thái bắt buộc lý do ≥ 20 ký tự; chưa khai báo xung đột thì không mở được."; test_ids (backlog, trace): +UAT-AC16, UAT-AC450 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-13 / BL-BID-13 / trace FR-BID-13 | fields: +Trạng thái DOC; rule: nối thêm "Biên bản phát hành qua DOC; nhận xét chưa thẩm tra không vào biên bản."; test_ids (backlog, trace): +UAT-AC453 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-14 / BL-BID-14 / trace FR-BID-14 | rule: nối thêm "Hợp đồng do CTR sở hữu; BID chỉ hiển thị liên kết từ KQLCNT." | Làm rõ ranh giới BID/CTR |
| BID-15 / BL-BID-15 / trace FR-BID-15 | fields: +Quyết định phê duyệt (DOC); rule: nối thêm "Một KHLCNT APPROVED mỗi dự án; điều chỉnh tạo revision mới."; test_ids (backlog, trace): +UAT-AC445 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-16 / BL-BID-16 / trace FR-BID-16 | fields: +Loại hợp đồng; Hình thức (qua mạng/không qua mạng); rule: nối thêm "Σ giá gói không vượt nguồn vốn được bố trí; người duyệt khác người lập."; test_ids (backlog, trace): +UAT-AC445 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-17 / BL-BID-17 / trace FR-BID-17 | fields: +Nguồn mốc (thủ công/nhập tệp); rule: nối thêm "Mốc thực tế theo thứ tự mời → đóng → mở → đánh giá → phê duyệt."; test_ids (backlog, trace): +UAT-AC454 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-18 / BL-BID-18 / trace FR-BID-18 | fields: +Kết quả (trúng/không có HSDT đạt/hủy); rule: nối thêm "Giá trúng không vượt giá gói thầu; AI không là căn cứ quyết định; người duyệt khác người trình."; test_ids (backlog, trace): +UAT-AC455 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-19 / BL-BID-19 / trace FR-BID-19 | fields: +Băm tệp; Chế độ dry-run/apply; rule: nối thêm "Adapter PROPOSED, chỉ nhập tệp; nạp lại cùng tệp trả "đã nạp"."; test_ids (backlog, trace): +UAT-AC454 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| BID-20 / BL-BID-20 / trace FR-BID-20 | fields: +Quyết định xử lý xung đột; rule: nối thêm "Người khai báo không tự quyết định; kiến nghị có hạn xử lý theo quy tắc dữ liệu."; test_ids (backlog, trace): +UAT-AC450, UAT-AC456 | Bổ sung field/quy tắc theo đặc tả M1 (D-B11 cho phép thêm field vào màn hình cũ) |
| UAT-AC13 | setup/steps: template 3 bước → cụ thể; expected: "mọi nhận xét quan trọng có nguồn trang hoặc cờ thiếu nguồn." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-BID-09, FR-BID-07 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC14 | setup/steps: template 3 bước → cụ thể; expected: "document ACL áp dụng cả vector retrieval và mở dẫn chứng." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-BID-09, FR-LLM-16 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC15 | setup/steps: template 3 bước → cụ thể; expected: "thay tiêu chí/hồ sơ phải tạo run mới, kết quả cũ không bị viết lại." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-BID-07, FR-BID-08 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC16 | setup/steps: template 3 bước → cụ thể; expected: "chuyên gia sửa điểm phải có lý do; kết luận cuối do người có thẩm quyền." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-BID-12, FR-BID-18 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
| UAT-AC17 | setup/steps: template 3 bước → cụ thể; expected: "so sánh nhà thầu dùng cùng phiên bản tiêu chí; không lấy tên, đặc tính cá nhân không liên quan làm tiêu chí." → giữ ý nghĩa, thêm giá trị quan sát được; covers: (không có) → FR-BID-10, FR-BID-04 | BRIEF: viết lại AC sở hữu bằng dữ liệu synthetic cụ thể, xóa test mồ côi |
