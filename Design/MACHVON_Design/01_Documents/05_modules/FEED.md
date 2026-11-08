# FEED — Số liệu từ ứng dụng của Sở Tài chính (kết nối `fin.sotaichinh`)
Baseline 1.5 | Kế hoạch FEED-1 (khối migration 2500–2519), eng-review R18 (mẫu tệp chờ xác nhận không được tính là đã nghiệm thu). Màn hình FEED-01…FEED-05. Quyết định của chủ đầu tư ngày 08/11/2026: làm phần lõi thật trước; không có dấu hay cảnh báo "mô phỏng"; bản ghi của mọi kênh đi vào lõi như nhau, kênh chỉ là cột nguồn gốc. Chi tiết mã nguồn: `docs/finance-feed.md`, `docs/plans/feed1.md`.

## 1. Mục đích, phạm vi, ranh giới
Ban chỉ đạo do trưởng Ban 57 (PA05, Công an tỉnh) cần nhìn toàn tỉnh một lần: kế hoạch vốn và giải ngân của từng dự án đầu tư công, chủ đầu tư nào báo cáo trễ, số nào của Sở Tài chính lệch với số của ta. Phân hệ nhận số liệu từ ứng dụng của Sở Tài chính, ánh xạ mã dự án của Sở sang dự án của ta, đối chiếu với báo cáo DIS và Kho bạc, và giao cho người xử lý từng chênh lệch.
- **Trong phạm vi:** kết nối và độ mới của số liệu; ba kênh nhận (tệp, đẩy, bộ sinh dữ liệu); chạy thử từng dòng và áp dụng một lần cho mỗi tệp; ánh xạ mã; đối chiếu và xử lý chênh lệch; ba chỉ số chất lượng (độ đầy đủ, độ kịp thời, tỷ lệ sai lệch); điều khiển bộ sinh dữ liệu.
- **Ngoài phạm vi:** cổng đẩy thật (INT-1: tài khoản máy, `FeedApiPushAdapter` hiện từ chối `503 FEED_API_UNAVAILABLE`); màn hình điều hành của trưởng ban (BAN-1, đọc qua `getFinanceFeedFacts`).
- **Phụ thuộc:** DIS (bản chụp đã chốt), ADM (quy tắc `CONNECTOR_FRESHNESS`/`FIN_FEED` và `FINANCE_FEED_POLICY`), kernel (`finance-feed*.ts`), kho bản ghi `master_crosswalk`.
- **Căn cứ:** yêu cầu của chủ đầu tư ngày 08/11/2026; thực tiễn đối soát số liệu giải ngân đầu tư công giữa Sở Tài chính, Kho bạc và chủ đầu tư. Mẫu tệp chính thức của Sở chưa có: mẫu `WORKING-ASSUMPTION-FIN-2026.1` là giả định [CXN-FEED-LAYOUT], mọi thứ dựng trên đó ghi PENDING-EXTERNAL.

## 2. Actor, tenant và phạm vi quyền
| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Quản trị tích hợp | Toàn tenant (`fin.feed.admin`, `fin.feed.generator`) | Bật/tắt kết nối kèm lý do; khởi động, dừng, gieo lại, chạy thêm một tháng cho bộ sinh dữ liệu | Thao tác khi không gian làm việc chỉ đọc |
| Chuyên viên kế hoạch | Toàn tenant (`fin.feed.preview`, `fin.feed.import`, `fin.feed.map`, `fin.feed.reconcile`) | Tải tệp, chạy thử, áp dụng, đề xuất và thu hồi ánh xạ, chạy đối chiếu | Duyệt ánh xạ do mình đề xuất; xử lý chênh lệch do mình lập số liệu |
| Người duyệt | Toàn tenant (`fin.feed.map.approve`, `fin.feed.resolve`) | Duyệt hoặc từ chối ánh xạ của người khác; xử lý chênh lệch | Tự duyệt, tự xử lý (`SELF_APPROVAL_DENIED`) |
| Ban chỉ đạo (đọc) | Toàn tenant (`fin.feed.read`) | Xem mọi màn hình, đọc số liệu tổng hợp | Mọi thao tác ghi |
Mọi thao tác cần quyền trên toàn tenant: số liệu của Sở không thuộc một đơn vị nào (quyền cấp theo cây đơn vị bị từ chối `SCOPE_DENIED`). Màn hình lấy quyền của người dùng từ `actions` của kết nối và từ `can_decide`, `can_resolve`, `can_retire` của từng dòng; máy chủ kiểm lại.

## 3. Luồng nghiệp vụ (mỗi luồng trọng yếu)
**L1 Nhận tệp (FEED-02):** (1) chọn loại (dự án, kế hoạch vốn, giải ngân, mốc) và tệp CSV/XLSX; (2) `uploadFinanceFeedFile`: kiểm theo nội dung, quét, đọc bảng, cho biết loại nào tệp khớp; (3) `previewFinanceFeedFile`: chạy thử từng dòng, không ghi gì; (4) `importFinanceFeedFile`: áp dụng một lần cho mỗi mã băm. Tệp đã áp dụng: `409 IMPORT_FILE_ALREADY_APPLIED`; không dòng nào nhận được: `422 IMPORT_HAS_ERRORS` kèm số dòng; kết nối tắt: `409 FEED_CONNECTION_DISABLED`.
**L2 Ánh xạ mã (FEED-03):** `proposeFinanceFeedMapping` → `decideFinanceFeedMapping` (người khác) → `retireFinanceFeedMapping` kèm lý do; một mã của Sở chỉ ứng với một dự án tại một thời điểm (`CROSSWALK_DUPLICATE`).
**L3 Đối chiếu (FEED-04):** `runFinanceFeedReconciliation` cho một năm ngân sách, người phụ trách không phải người lập số liệu; mỗi số lệch quá ngưỡng thành một việc có hạn; `resolveFinanceFeedDifference` bằng `ACCEPT_FEED`, `KEEP_OURS`, `DISPUTE` (cần `evidence_ref`) hoặc `WAIVE` (cần `review_on` trong một năm).
**L4 Bộ sinh dữ liệu (FEED-05):** `controlFinanceFeedGenerator` với `START`, `STOP`, `RESEED`, `TICK`; mỗi thao tác cần lý do; bản ghi sinh ra đi qua cùng mẫu, kiểm tra và áp dụng như một tệp.
**L5 Theo dõi (FEED-01):** độ mới theo quy tắc, ba chỉ số chất lượng, đơn vị báo cáo trễ, cảnh báo `FEED_STALE`, `FEED_UNIT_LATE`, `FEED_DISCREPANCY_LARGE`.
**Đồng thời:** lệnh có phiên bản (`If-Match`) trả `409 VERSION_CONFLICT`, màn hình đề nghị tải lại; hai người cùng áp dụng một tệp: người đến sau thấy `IMPORT_FILE_ALREADY_APPLIED`.

## 4. State machine
Kết nối: `OFF ⇄ ON` (cần lý do, ghi lịch sử). Bộ sinh dữ liệu: `STOPPED ⇄ RUNNING`. Ánh xạ: `PROPOSED → ACTIVE | REJECTED`, `ACTIVE → RETIRED`. Chênh lệch: `OPEN → RESOLVED`.
| Từ | Command | Đến | Ai được làm | Guard | Audit/Event |
|---|---|---|---|---|---|
| OFF/ON | setFinanceFeedConnectionState | ON/OFF | `fin.feed.admin` | lý do ≥ 10 ký tự; đúng phiên bản | `fin.feed_connection_switched` / `fin.feed.connection.changed.v1` |
| STOPPED | controlFinanceFeedGenerator START | RUNNING | `fin.feed.generator` | kết nối bật | `fin.feed_generator_moved` / `fin.feed.generator.moved.v1` |
| RUNNING | STOP / TICK / RESEED | STOPPED / RUNNING | `fin.feed.generator` | TICK cần còn tháng (≤ 11) | như trên |
| PROPOSED | decideFinanceFeedMapping | ACTIVE / REJECTED | `fin.feed.map.approve` | người duyệt khác người đề xuất | `fin.feed_mapping_approved|rejected` / `fin.feed.mapping.decided.v1` |
| ACTIVE | retireFinanceFeedMapping | RETIRED | `fin.feed.map` | lý do | `fin.feed_mapping_retired` |
| OPEN | resolveFinanceFeedDifference | RESOLVED | `fin.feed.resolve` | không phải người lập số liệu; lý do 10/20 ký tự; DISPUTE cần bằng chứng; WAIVE cần ngày xem lại | `fin.feed_difference_resolved` |
Chuyển bị cấm: `FEED_MAPPING_STATE_INVALID`, `FEED_DIFFERENCE_STATE_INVALID`, `FEED_GENERATOR_STATE_INVALID` (409); tự duyệt `SELF_APPROVAL_DENIED` (403).

## 5. Quy tắc nghiệp vụ và công thức
- **BR-FEED-01:** độ tuổi dữ liệu = bây giờ − thời điểm áp dụng lần nhận gần nhất của kênh nào cũng tính; còn mới đến `warn_after_hours`, sắp cũ đến `max_age_hours`, cũ quá đó (`FEED_STALE`). Số liệu cũ hiện là cũ, không hiện là "không có dữ liệu".
- **BR-FEED-02:** độ đầy đủ = số đơn vị đã báo cáo kỳ ÷ số đơn vị phải báo cáo; độ kịp thời = số đơn vị báo đúng hạn ÷ số đơn vị đã báo; tỷ lệ sai lệch = số chênh lệch đã mở ÷ số số liệu đã đối chiếu. Mẫu số 0: không tính được, không bao giờ là 0%.
- **BR-FEED-03:** chênh lệch = số của Sở − số của ta; % = |chênh lệch| ÷ số của ta, hai chữ số thập phân; lớn khi vượt `large_discrepancy_pct`.
- **BR-FEED-04:** mỗi mã băm tệp áp dụng một lần; bản ghi cùng khóa không ghi hai lần.
- **BR-FEED-05 (R18):** mẫu tệp giả định ghi PENDING-EXTERNAL trên mọi màn hình đọc tệp cho đến khi Sở công bố mẫu chính thức.
- **BR-FEED-06:** không có lời gọi nào ra ngoài máy; cổng đẩy từ chối cho đến khi có tài khoản máy.

## 6. Dữ liệu
Bảng `finance_feed_connection` (+ sự kiện, chỉ thêm), `finance_feed_run`, `finance_feed_record` (cột `channel` FILE | API_PUSH | GENERATOR, `epoch`), `finance_feed_difference`, `finance_feed_reconciliation`; ánh xạ trên `master_crosswalk`. Có `tenant_id`, RLS bắt buộc, chỉ mục dẫn đầu bằng `tenant_id`; phân loại INTERNAL. Chi tiết trong `db/migrations` khối 2500–2519.

## 7. API / command
| operationId | Method path | Quyền | Lỗi |
|---|---|---|---|
| getFinanceFeedConnection, getFinanceFeedQuality, getFinanceFeedFacts, listFinanceFeedProjects | GET /finance-feed/connection, /quality, /facts, /projects | fin.feed.read | SCOPE_DENIED, VALIDATION_FAILED |
| listFinanceFeedRuns, getFinanceFeedRun | GET /finance-feed/runs[/{id}] | fin.feed.read | RESOURCE_NOT_FOUND |
| listFinanceFeedMappings, listFinanceFeedUnmapped, listFinanceFeedDifferences | GET /finance-feed/mappings, /unmapped, /differences | fin.feed.read | VALIDATION_FAILED |
| setFinanceFeedConnectionState | POST /finance-feed/connection/state | fin.feed.admin | VERSION_CONFLICT, VALIDATION_FAILED |
| controlFinanceFeedGenerator | POST /finance-feed/generator | fin.feed.generator | FEED_GENERATOR_STATE_INVALID, VERSION_CONFLICT |
| uploadFinanceFeedFile, previewFinanceFeedFile, importFinanceFeedFile | POST /finance-feed/imports/files, /imports/preview, /imports | fin.feed.preview, fin.feed.import | IMPORT_FILE_ALREADY_APPLIED, IMPORT_HAS_ERRORS, FEED_CONNECTION_DISABLED, FEED_LAYOUT_VERSION_UNKNOWN |
| proposeFinanceFeedMapping, decideFinanceFeedMapping, retireFinanceFeedMapping | POST /finance-feed/mappings[/{id}/decision|/retire] | fin.feed.map, fin.feed.map.approve | SELF_APPROVAL_DENIED, CROSSWALK_DUPLICATE, FEED_MAPPING_STATE_INVALID |
| runFinanceFeedReconciliation, resolveFinanceFeedDifference | POST /finance-feed/reconciliations, /differences/{id}/resolution | fin.feed.reconcile, fin.feed.resolve | SELF_APPROVAL_DENIED, FEED_DIFFERENCE_STATE_INVALID |
| pushFinanceFeedBatch | POST /finance-feed/push | fin.feed.push | FEED_API_UNAVAILABLE |
Mọi lệnh ghi có Idempotency-Key; lệnh trên bản ghi có phiên bản cần If-Match.

## 8. UI/UX
FEED-01 kết nối (trạng thái, kênh, độ mới, chất lượng, đơn vị trễ, cảnh báo, lịch sử); FEED-02 các lần nhận và nhập tệp; FEED-03 ánh xạ mã; FEED-04 danh sách chênh lệch; FEED-05 điều khiển bộ sinh dữ liệu. Bảy trạng thái chuẩn trên mỗi màn hình (đang tải, rỗng, một phần, lỗi kèm số liệu cũ, bị từ chối 403, thành công); mỗi con số có "i" nêu công thức, nguồn, ngày số liệu. Nhãn PENDING-EXTERNAL luôn thấy được trên màn hình đọc tệp.

## 9. Sự kiện, job, tích hợp, quan sát
Sự kiện `fin.feed.connection.changed.v1`, `fin.feed.generator.moved.v1`, `fin.feed.import.applied.v1`, `fin.feed.mapping.proposed|decided|retired.v1`, `fin.feed.reconciliation.completed.v1`, `fin.feed.difference.resolved.v1`: mang mã, mã băm và người thực hiện, không mang tên người. Cảnh báo vào trung tâm cảnh báo (nguồn `CONNECTOR`). Không có job nền.

## 10. Kiểm thử
| ID | Loại | Nội dung |
|---|---|---|
| `apps/web/src/screens/feed/*.test.tsx` | UI | bảy trạng thái, chạy thử và áp dụng, hai người cho ánh xạ và chênh lệch, điều khiển bộ sinh dữ liệu |
| `apps/web/src/screens/feed/feed-model.test.ts` | domain | đọc đáp ứng, kiểm biểu mẫu, mã lỗi |
| `packages/kernel/test/finance-feed*.test.ts` | domain | mẫu, bộ sinh, độ mới, đối chiếu |
| `apps/api/test/isolation/*`, `authz/negative-matrix` | security | ca id ngoại lai và ma trận từ chối |

## 11. Tiêu chí nghiệm thu (đo được)
- **AC-FEED-01:** Given một tệp hợp lệ, When chạy thử rồi áp dụng, Then chạy thử không ghi gì, áp dụng ghi đúng số dòng hợp lệ; áp dụng lại cùng tệp Then `409 IMPORT_FILE_ALREADY_APPLIED`.
- **AC-FEED-02:** Given người đề xuất ánh xạ hoặc người lập số liệu, When tự duyệt hoặc tự xử lý, Then `403 SELF_APPROVAL_DENIED` và không có thay đổi.
- **AC-FEED-03:** Given bộ sinh dữ liệu, When khởi động, chạy thêm tháng, dừng và gieo lại, Then trạng thái và đời dữ liệu đổi đúng và mỗi thao tác có dòng lịch sử; bản ghi của mọi kênh hiện như nhau.
- **AC-FEED-04:** Given FEED-01…FEED-05 ở 1440 px và 390 px, When ép từng trạng thái, Then mỗi trạng thái hiện đủ, mỗi số có "i", 0 lỗi console, không cuộn ngang ở 1440 px.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+
R1 dùng thật: nhận tệp theo mẫu giả định, ánh xạ hai người, đối chiếu và xử lý chênh lệch, bộ sinh dữ liệu. R2+: mẫu chính thức của Sở thay mẫu giả định, cổng đẩy qua tài khoản máy (INT-1), màn hình điều hành của trưởng ban (BAN-1). Hạng mục bắt buộc người duyệt: ngưỡng chênh lệch và hạn báo cáo của chủ đầu tư.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba
- Mẫu tệp chính thức của Sở Tài chính chưa có (owner: Sở Tài chính; điều kiện: nhận tệp mẫu từng loại và xác nhận khớp) — mọi kết quả dựng trên mẫu giả định là PENDING-EXTERNAL.
- Tài khoản máy của cổng tích hợp (owner: nhóm INT-1; điều kiện: cấp client credentials) — đến lúc đó cổng đẩy từ chối.
- Ngưỡng sai lệch, ngưỡng chênh lệch lớn và hạn báo cáo là giá trị mặc định chưa xác nhận (owner: cán bộ tài chính của chủ đầu tư).
