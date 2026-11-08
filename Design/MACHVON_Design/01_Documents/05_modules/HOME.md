# HOME — Tổng quan điều hành và trung tâm điều hành giải ngân

Phiên bản đặc tả M1 · 22/10/2026 · HOME **không sở hữu bảng ghi**; mọi số đọc từ PeriodSnapshot FROZEN của DIS (`period_snapshot`, `period_snapshot_line`, `disbursement_ranking`, `early_warning`), CAP (`appropriation`, `allocation_balance`, `reallocation_proposal`), PRJ (`project`, `project_accountability`, `explanation_request`) và ISS. Quy ước chung theo `04_Thiet_ke_co_ban.md`, `05_Thiet_ke_chi_tiet.md` (DrillContext và query security).

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Lãnh đạo UBND/Sở cần một màn hình trả lời trong 30 giây: giải ngân đang ở đâu so với hai mẫu số, đơn vị nào chậm, dự án nào có cảnh báo, ai chịu trách nhiệm, giải trình nào quá hạn, có đề xuất điều chuyển nào chờ — và bấm vào bất kỳ số nào để thấy công thức, phạm vi, thời điểm chốt và bản ghi nguồn mà không mất ngữ cảnh. Đây là "trung tâm điều hành giải ngân" theo Công điện 162/CĐ-TTg [CXN-33] (theo dõi kế hoạch tuần/tháng từng dự án, cảnh báo sớm, xếp hạng, điều chuyển).

**Trong phạm vi:** HOME-01…HOME-10: tổng quan, việc của tôi, cảnh báo sớm, xếp hạng, bản đồ, hồ sơ cảnh báo, cơ cấu nguồn, chi tiết nguồn và phạm vi tính, **HOME-09** trung tâm điều hành, **HOME-10** ngữ cảnh số liệu/truy nguồn; read-model và drill có kiểm quyền lại ở đích.
**Làn phân tích (sâu hóa quản trị, G0-4, G3-1…G3-4).** Thêm HOME-11 và bốn năng lực dùng chung với BI: sổ KPI một định nghĩa với nút "i" trên mọi con số, số chỉ đưa lãnh đạo khi định nghĩa đã chứng nhận, màu xanh vàng đỏ giải thích được, drill ba bước, khối "Thay đổi từ tuần trước". Mọi định nghĩa và ngưỡng là quy tắc có phiên bản của kho `governance_rule` (loại `KPI_DEFINITION`, `RAG_THRESHOLDS`), đọc qua `GovernancePolicyPort` trên giá trị mặc định tích hợp; không còn hằng số trong mã hay trên màn hình.
**Ngoài phạm vi:** tính số liệu (DIS snapshot); quy tắc cảnh báo (DIS); dashboard tự dựng, semantic layer, export lịch (BI); chất lượng/lineage dữ liệu (DGV).

**Giải quyết xung đột HOME↔DGV (O11, CR-HOME-01).** Baseline ghi HOME phụ thuộc "DIS, DGV" nhưng DGV nằm ở G3 trong khi HOME ở G2. Quyết định (Claude quyết, D-B04): phụ thuộc **cứng** của HOME = DIS (PeriodSnapshot + ranking + warning), CAP, PRJ, ISS — đều R1. DGV là phụ thuộc **mềm** từ R2: HOME hiển thị `quality_badge = NOT_ASSESSED` ("Chưa đánh giá chất lượng") và độ mới lấy từ `as_of` của snapshot cho tới khi DGV có `quality_run`; khi DGV sẵn sàng, badge đọc kết quả quality run của dataset snapshot. HOME giữ phase P0/R1. Không có tính năng nào của HOME bị chặn vì thiếu DGV.

**Căn cứ:** CĐ 162/CĐ-TTg [CXN-33]; CV 16437/BTC-ĐTPT [CXN-03]; nguyên tắc BR-R06/BR-R10 của BRD (không công bố số không rõ grain/định nghĩa/nguồn/độ mới; drill giữ scope và snapshot). Thị trường: Power BI RLS, dbt/Cube metric layer (công thức là dữ liệu, tử/mẫu số trả riêng).

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Lãnh đạo UBND tỉnh/bộ | Toàn tenant hoặc theo cây đơn vị được cấp | Mọi màn HOME, drill tới giao dịch Kho bạc/chứng từ nếu có quyền đích | Sửa số; xem dữ liệu ngoài scope qua drill |
| Lãnh đạo Sở/Ban | Đơn vị mình + con | HOME-01..10 trong scope | Như trên |
| Chuyên viên | Scope được giao | HOME-01..08, HOME-10 | HOME-09 tile điều chuyển nếu thiếu `capital.read` |
| Chủ đầu tư | Dự án mình | HOME-01/02/03/06 theo dự án | Xếp hạng đơn vị khác (hiện vị trí của mình + tổng nhóm, không lộ tên đơn vị khác nếu policy `ranking_visibility = OWN_ONLY`) |
| Auditor | Đọc | Như lãnh đạo trong scope audit | Command |

HOME chỉ có thao tác ghi gián tiếp qua command của module nguồn (ví dụ nút "Yêu cầu giải trình" gọi `requestExplanation` của PRJ, "Ghi nhận" gọi `acknowledgeEarlyWarning` của DIS) — quyền kiểm theo command đó.

## 3. Luồng nghiệp vụ

**F1 — Mở trung tâm điều hành (HOME-09).** (1) Client gọi `getCommandCenter?snapshot_id=` (mặc định snapshot FROZEN mới nhất loại PERIOD_CLOSE của kỳ tuần gần nhất mà user có quyền). (2) Server: xác thực membership → tính scope hash → đọc snapshot lines trong scope → trả tiles (hai tỷ lệ, đã giải ngân, kế hoạch hai mẫu số, EAC, số cảnh báo mở theo mức độ, giải trình quá hạn, đề xuất điều chuyển chờ duyệt) mỗi tile kèm `formula`, `numerator`, `denominator`, `null_reason`, `definition_status`, `context_token` ký (HMAC, chứa tenant, scope hash, snapshot, metric, filters, TTL 30 phút). (3) UI hiển thị "Số liệu tại [as_of], Kho bạc tới [cutoff], snapshot [id rút gọn]" cố định ở header.
Nhánh: chưa có snapshot FROZEN → trạng thái Empty "Chưa chốt số liệu kỳ nào" + link DIS-21 (nếu có quyền); snapshot cũ hơn 8 ngày → trạng thái Stale.

**F2 — Drill truy nguồn (HOME-10).** Bấm tile → `explainHomeMetric?context_token=…&child_dimension=unit` → trả children (đơn vị) với tử/mẫu, `reconciles_to_parent` (Σ con = cha) hoặc `non_additive_reason` (tỷ lệ, distinct). Tiếp tục drill: đơn vị → dự án → ô nguồn (`period_snapshot_line`) → report revision (DIS-07) → giao dịch Kho bạc (PAY) → chứng từ (DOC/document_version). Mỗi bước: server xác minh chữ ký token, tenant, membership **hiện tại** và giao scope cũ ∩ scope hiện tại (quyền bị thu hồi có hiệu lực ngay → 403 `SCOPE_DENIED`), giữ nguyên snapshot (không nhảy số mới). Token hết hạn → 409 `SNAPSHOT_EXPIRED` (UI làm mới token cùng snapshot).
**F2a — Drill ba bước (G3-3).** Bước 1 chỉ tiêu theo đơn vị, bước 2 đơn vị theo dự án, bước 3 hồ sơ (báo cáo, giao dịch Kho bạc và cảnh báo đang mở của dự án); `step`, `steps_total` cho biết đang ở đâu. Với tỷ lệ, `order=drag` xếp phần "kéo tụt nhiều nhất" lên đầu theo `drag_points` = (tử số của phần × mẫu số của cả − mẫu số của phần × tử số của cả) / (mẫu số của cả)² × 100, tính trên số nguyên đồng nên tổng các phần bằng 0 và thứ tự kiểm được; thứ tự mặc định vẫn theo mã để con trỏ phân trang không đổi. Bộ lọc (đơn vị, thứ tự) giữ nguyên khi đi xuống và quay lại. Danh sách cảnh báo ở bước 3 chỉ có mã, mức, trạng thái, ngày của dự án người xem được đọc; không lộ tên ngoài quyền.

**F3 — Xếp hạng (HOME-04).** `getDisbursementRankings?snapshot_id&comparison_group&denominator_kind` đọc `disbursement_ranking`; UI cho đổi mẫu số (hai bảng riêng, không trộn) và hiển thị đơn vị bị loại kèm lý do.

**F4 — Cảnh báo (HOME-03/06).** `getHomeWarnings` lọc theo mức độ/quy tắc; HOME-06 hiển thị nguyên nhân (giá trị quan sát vs ngưỡng), bằng chứng (dòng snapshot), người phụ trách (lãnh đạo phụ trách hiện hành từ PRJ), giải trình liên kết, lịch sử; nút "Yêu cầu giải trình" (PRJ) và "Ghi nhận/Bỏ qua" (DIS).

**F5 — Việc của tôi (HOME-02).** `getMyWork` gộp: giải trình được yêu cầu/đang chờ kết luận (PRJ), báo cáo trả lại/nháp quá hạn (DIS), phê duyệt chờ (CAP/DIS/MDM/MNE qua `approval_task` của ADM), nghĩa vụ MNE sắp hạn. Thứ tự: quá hạn → hạn gần → ưu tiên.

**F6 — Cơ cấu nguồn (HOME-07/08).** Đọc appropriation PUBLISHED theo năm: thẻ vốn TTg giao, vốn địa phương giao thêm, vốn kéo dài, vốn hỗ trợ, vốn tăng thu NSTW, ODA; CTMTQG hiển thị "trong đó" của nguồn cha (không cộng); HOME-08 cột "Quan hệ bao hàm" và "Thời điểm chốt".

**F7 — Sổ KPI và số đã chứng nhận (G0-4, G3-1; HOME-09, HOME-01, HOME-03).** `getCommandCenter` đọc định nghĩa của từng tile từ sổ KPI (`getKpiRegister` liệt kê): tên, công thức bằng lời, tử số, mẫu số, khoản loại trừ, kỳ, nguồn, chủ sở hữu, độ trễ cho phép, phiên bản. Mỗi tile (và ba số đếm "cảnh báo mở", "giải trình quá hạn", "đề xuất điều chuyển chờ", trong `count_tiles`) trả thêm `display_value` (chữ của con số mà web, điện thoại và tệp Excel cùng viết, theo số chữ số thập phân của định nghĩa), `kpi` (nội dung nút "i": công thức, nguồn, `as_of`, chủ sở hữu, phiên bản), `certification` và `flags` (NO_DATA, NOT_CERTIFIED, OBSOLETE, STALE, PARTIAL_COVERAGE, UNVERIFIED_DEFINITION). Phiên bản mặc định tích hợp của nền tảng (v0) được chứng nhận bằng rà soát mã nguồn; phiên bản do tenant duyệt (v≥1) là Nháp cho đến khi có người xác nhận và một người KHÁC chứng nhận (BI-19). Số của định nghĩa chưa chứng nhận hoặc đã lỗi thời **không đưa cho người xem**: `value`, tử số, mẫu số là null và `null_reason` = `NOT_CERTIFIED` hoặc `OBSOLETE` (không bao giờ 0, không nhầm với NO_DATA). `exportHomeFigures` xuất cùng các dòng ra CSV/XLSX với đúng chữ `display_value`; ô trống kèm lý do khi không có số. Điện thoại đọc cùng API và hiển thị cùng chữ số.

**F8 — Màu xanh vàng đỏ có giải thích (G3-2; HOME-11).** `getRagReading` chấm từng đơn vị trong phạm vi người xem bằng quy tắc, không bằng cảm tính: bốn yếu tố có trọng số (tỷ lệ giải ngân so với nhịp của năm, cảnh báo Nghiêm trọng đang mở, giải trình quá hạn, tỷ lệ dự án chưa có số Kho bạc), mỗi yếu tố đọc theo đường xanh/vàng của `RAG_THRESHOLDS`; điểm cảnh báo sớm 0 (không có gì sai) đến 100; màu = đường của `EWS_SCORE`. Mỗi đơn vị trả 1 đến 3 yếu tố làm đổi màu (giá trị so với đường, số điểm), độ bao phủ dữ liệu, điểm và màu tuần trước, 8 tuần xu hướng. Đủ dữ liệu = phần trọng số có số ≥ `min_coverage_pct` (60); dưới mức đó đơn vị là "chưa đủ dữ liệu" (NO_DATA), không phải xanh và không phải 0. Người có `home.rag.override` ghi đè màu một đơn vị (`setRagOverride`): màu khác màu của quy tắc, lý do bằng lời 10 đến 500 ký tự, ngày hết hiệu lực sau hôm nay và không quá 90 ngày; ghi đè hiển thị cạnh màu của quy tắc, không thay chỗ; hết hạn tự rơi; gỡ sớm bằng `revokeRagOverride` cũng cần lý do; mỗi lần là một dòng chỉ thêm, có audit và sự kiện. Điểm mỗi đơn vị ghi một lần cho tuần (`early_warning_score`, kèm phân rã từng yếu tố và phiên bản quy tắc đã quyết) bởi job `early-warning-score` (hoặc `scoreEarlyWarningWeek` khi cần), nên màu của một tuần giải thích được cả khi quy tắc đổi sau đó.

**F9 — Thay đổi từ tuần trước (G3-4; HOME-01).** `getHomeChanges` so ảnh chụp mới nhất với ảnh chụp của tuần trước (tuần trước = ảnh chụp đã chốt gần nhất thuộc tuần sớm hơn) trong phạm vi của người xem và trả tối đa 5 dòng do **luật** sinh (`weeklyChanges` của kernel; không mô hình ngôn ngữ nào viết chữ): số đơn vị chuyển đỏ, tỷ lệ giải ngân đổi (điểm phần trăm, chỉ khi đổi từ 0,01), cảnh báo nghiêm trọng tăng giảm, số Kho bạc chi thêm trong tuần, giải trình quá hạn tăng giảm, số dự án chưa có số, số đơn vị hồi phục. Mỗi dòng có đúng một liên kết (drill kèm token, màu, cảnh báo, việc, xếp hạng) và không có tên đơn vị hay dự án. Chỉ so các đơn vị có số cả hai tuần; số của định nghĩa chưa chứng nhận không sinh dòng; không có tuần trước thì trả `reason: NO_PREVIOUS_WEEK` và không dòng nào.

Đồng thời: HOME chỉ đọc; snapshot mới FROZEN trong khi user đang xem → banner "Có số liệu mới (snapshot …) — Làm mới", không tự đổi số.

## 4. State machine

HOME không có đối tượng nghiệp vụ có trạng thái. Trạng thái màn hình (từ hợp đồng Module_Implementation_Contracts):

```
 Loading ──ok──► Ready ──(snapshot mới FROZEN)──► Ready+NewDataBanner ──refresh──► Loading
    │  └─empty──► Empty (chưa có snapshot / không có dữ liệu trong scope)
    │  └─stale──► Stale (as_of quá ngưỡng 8 ngày)
    ├─403──► Denied (scope bị thu hồi; không lộ tên hồ sơ)
    └─5xx/timeout──► Error (retry; giữ bộ lọc)
```

| Từ | Sự kiện | Đến | Guard | Ghi nhận |
|---|---|---|---|---|
| Loading | 200 có tiles | Ready | snapshot FROZEN, scope hợp lệ | telemetry `home_load_ms` |
| Loading | 200 không snapshot | Empty | – | – |
| Ready | `snapshot.frozen` (SSE/poll) | Ready+NewDataBanner | snapshot mới cùng kind, khác id | – |
| Ready | drill 403 | Denied (drawer) | membership hiện tại không giao scope | audit `home.drill_denied` |
| Ready | token hết hạn | Ready (token mới cùng snapshot) | snapshot chưa bị xóa | – |

Bị cấm: hiển thị số không có `as_of`; tự đổi sang snapshot khác khi drill; hiển thị 0 khi `null_reason` khác null.

## 5. Quy tắc nghiệp vụ và công thức

- **BR-HOME-01** Mọi tile mang: scope (đơn vị/dự án/nguồn), `as_of_date`, `treasury_cutoff_date`, `snapshot_id`, đơn vị tính (VND, hiển thị triệu/tỷ có ghi rõ), công thức, `definition_status`. Thiếu bất kỳ → không hiển thị số (METRIC_UNAVAILABLE).
- **BR-HOME-02** Tỷ lệ luôn hiển thị theo cặp DIS BR-DIS-05 (KH TTg giao / KH gồm giao thêm) với cùng tử số; tooltip nêu [CXN-03].
- **BR-HOME-03** Tổng cha = Σ con cho đại lượng cộng được (tiền), kiểm ở server (`reconciles_to_parent`); với tỷ lệ trả tử/mẫu và `non_additive_reason = RATIO`.
- **BR-HOME-04** Unknown ≠ zero: `NO_DATA`, `ZERO_DENOMINATOR`, `TREASURY_COVERAGE_NONE` hiển thị nhãn chữ, không màu đơn thuần; đếm số dự án chưa có dữ liệu ở footer.
- **BR-HOME-05** Tile "Giải trình quá hạn" = số `explanation_request` OVERDUE + RESPONDED quá hạn chưa kết luận trong scope; "Đề xuất điều chuyển chờ" = `reallocation_proposal` SUBMITTED/APPROVED chưa APPLIED.
- **BR-HOME-06** Xếp hạng chỉ từ `disbursement_ranking` của snapshot đang xem; policy `ranking_visibility` (ALL | OWN_ONLY) theo tenant.
- **BR-HOME-07** Bản đồ (HOME-05): vị trí dự án từ địa bàn master version hiệu lực tại as_of (sau cải cách 2025 hiển thị cấp tỉnh–xã) [CXN-34]; dự án không có tọa độ liệt kê riêng, không đặt tại tâm tỉnh.
- **BR-HOME-08** Drill token: HMAC-SHA256 với khóa per-tenant; payload không chứa PII; TTL 30 phút; mỗi lần dùng kiểm lại membership.
- **BR-HOME-09** (G0-4) Mọi con số của HOME có một định nghĩa duy nhất trong sổ KPI (`KPI_DEFINITION`), đọc qua `GovernancePolicyPort`: công thức bằng lời, nguồn, `as_of`, chủ sở hữu, phiên bản hiện ra sau nút "i". Chữ của con số là `display_value`; web, điện thoại và tệp Excel không tự làm tròn. Giá trị khởi điểm nghiên cứu chưa xác nhận mang cờ UNVERIFIED_DEFINITION.
- **BR-HOME-10** (G3-1) Lãnh đạo chỉ nhận số của định nghĩa đã chứng nhận (người chứng nhận khác người xác nhận). Số bị giữ lại có `null_reason` NOT_CERTIFIED/OBSOLETE và cờ tương ứng, không bao giờ 0 hay "không có dữ liệu".
- **BR-HOME-11** (G3-2) Màu do quy tắc quyết định và luôn kèm 1 đến 3 yếu tố, độ bao phủ dữ liệu, điểm tuần trước; thiếu dữ liệu là "chưa đủ dữ liệu". Ghi đè bắt buộc lý do và ngày hết hiệu lực ≤ 90 ngày, hiển thị cạnh màu của quy tắc, có audit.
- **BR-HOME-12** (G3-3) Số tiền cha = Σ con (BR-HOME-03); với tỷ lệ, thứ tự "kéo tụt" là điểm phần trăm chính xác, không phải xếp theo tỷ lệ riêng của từng phần.
- **BR-HOME-13** (G3-4) Khối thay đổi tối đa 5 dòng, mỗi dòng một liên kết, sinh bằng luật từ số của hai tuần trong phạm vi người xem; không tên đơn vị/dự án; dòng không tính được thì không viết.
- **BR-HOME-14** (G2-1) Nhắc lại một việc phải chọn một lý do trong danh sách của quy tắc `SNOOZE_POLICY` (chờ thông tin, chờ bên thứ ba, đã có lịch xử lý, vướng việc khác, nghỉ phép, khác) và phải có lời giải thích khi lý do là "khác". Trần theo mức độ (giá trị khởi điểm, chưa xác nhận với khách hàng: Cần xử lý tối đa 3 ngày, Theo dõi tối đa 14 ngày, Khẩn không được hoãn), không quá `max_consecutive` lần liên tiếp (khởi điểm 2; một lần nhận xử lý hoặc giao việc bắt đầu đếm lại) và không bao giờ quá ngày đến hạn mà phân hệ nguồn đã nêu. Lần hoãn cuối cùng được phép ghi một thông báo lên cấp trên (`SNOOZE_FINAL_NOTICE`) và sự kiện `home.work_snooze_final.v1`. Mỗi lần hoãn lưu mã lý do, lần thứ mấy, đã là lần cuối chưa và phiên bản quy tắc đã quyết định (`builtin` khi là giá trị mặc định của nền tảng); lời của người dùng không đi vào nhật ký kiểm toán hay sự kiện, chỉ mã lý do và độ dài.
- **BR-HOME-15** (G2-2) Mỗi việc có hai đồng hồ đếm theo giờ làm việc trên lịch `WORKDAY_VN` đã công bố: thời gian để nhận việc (từ lúc việc phát sinh, theo mức độ: khởi điểm 2/8/24 giờ làm việc cho Khẩn/Cần xử lý/Theo dõi) và thời gian để xử lý xong (ngày đến hạn của phân hệ nguồn nếu có, nếu không là 8/40/80 giờ làm việc). Năm chưa có lịch công bố thì đồng hồ cần lịch vắng mặt và giao diện nói `CALENDAR_UNAVAILABLE`; không bao giờ đoán ngày. Việc đã được nhận xử lý mà không có dấu hiệu làm việc quá `no_progress_after_working_hours` (khởi điểm 4/24/40 giờ làm việc) hiện nhãn "Cần nhận lại"; nhận lại bắt đầu đếm lại và báo lên cấp trên (`RECLAIM_NOTICE`).
- **BR-HOME-16** (G2-2) Đồng hồ chỉ được tạm dừng khi có mã lý do trong `CLOCK_POLICY.pause_reasons`, lời giải thích từ 5 ký tự, người cho phép (thành viên đang hoạt động của một đơn vị người thao tác được xem, khác chính người tạm dừng; ràng buộc cả ở bảng) và ngày kết thúc không quá `max_pause_days` (khởi điểm 30 ngày). Thời gian làm việc đã dừng được cộng vào hạn; có thể chạy lại sớm (`resumeWorkClock`). Tạm dừng và chạy lại là dòng của `work_action`, không sửa không xóa.
- **BR-HOME-17** (G2-4) Việc đang mở được nhắc theo nhịp của `REMINDER_POLICY` (khởi điểm mỗi 4/8/40 giờ làm việc cho Khẩn/Cần xử lý/Theo dõi, tối đa 40/20/8 lần mỗi việc), tính từ lúc việc phát sinh, lúc nhận xử lý, lúc hết hoãn hoặc hết tạm dừng hay lần nhắc trước. Việc đang hoãn, đang tạm dừng, đã hết số lần nhắc hoặc ở năm chưa có lịch không được nhắc. Mỗi lần nhắc là một dòng `work_reminder` (khóa chuỗi chống ghi đôi) kèm sự kiện `home.work_reminder.v1` trong cùng giao dịch; việc đến người nhận qua NOT.
- **BR-HOME-18** (G0-2) Đồng hồ gốc (`work_clock`) dành cho nghĩa vụ có thời hạn riêng của phân hệ: bắt buộc nêu người chịu trách nhiệm, việc cần làm và hậu quả khi quá hạn; hạn đếm bằng giờ làm việc lúc bắt đầu và lưu kèm các phiên bản lịch đã đọc; một đồng hồ đang chạy cho mỗi (loại, đối tượng); kết thúc là MET hoặc CANCELLED, không xóa. Quá hạn thì việc thành Khẩn. Năm đồng hồ có sẵn (DIS-20, PAY-12, PMT-05, ISS-09, CTR-05) được bọc nguyên trạng và hiện cạnh hai đồng hồ, chưa chuyển cái nào (`docs/work-clocks.md`). Mọi ngưỡng đọc qua `GovernancePolicyPort` (loại `SNOOZE_POLICY`, `CLOCK_POLICY`, `REMINDER_POLICY`, mã `DEFAULT`), mặc định có nguồn và cờ chưa xác nhận.

## 6. Dữ liệu

HOME không tạo bảng. Read-model (view `security_invoker`, RLS áp dụng):

| Read-model | Nguồn | Grain | Ghi chú |
|---|---|---|---|
| `v_home_tiles` | `period_snapshot_line` ⨝ `period_snapshot` | snapshot × scope | tổng hợp theo cây đơn vị tại as_of (đơn vị lịch sử từ snapshot line, không từ cơ cấu hiện tại) |
| `v_home_rankings` | `disbursement_ranking` | snapshot × group × denominator × unit | – |
| `v_home_warnings` | `early_warning` ⨝ `early_warning_rule` ⨝ `project_accountability` | warning | người phụ trách = LEADER_IN_CHARGE ACTIVE tại thời điểm xem |
| `v_home_my_work` | `explanation_request`, `report_revision`, `approval_task`, `mne_report` | việc | lọc theo user |
| `v_home_funding_structure` | `appropriation` PUBLISHED | năm × origin × nguồn | CTMTQG subset |

**Bảng của làn đồng hồ (V1900 đến V1902, khối GOV-2; RLS, `machvon_app` không DELETE, không UPDATE trừ cột kết thúc của `work_clock`).** `work_action` thêm `reason_code`, `allowed_by_membership_id`, `paused_until`, `snooze_ordinal`, `snooze_final`, `policy_version`, hai hành động `PAUSE_CLOCK`/`RESUME_CLOCK` và nguồn `CLOCK` (ràng buộc hình dạng: người cho phép khác người tạm dừng; yêu cầu mã lý do của lần hoãn kiểm cho dòng mới, dòng cũ giữ nguyên). `work_clock` (đồng hồ gốc: loại, đối tượng, chủ, mức độ, việc cần làm, hậu quả, `started_at`, `working_minutes`, `due_at`, phiên bản lịch đã đọc, trạng thái RUNNING/MET/CANCELLED, một đồng hồ đang chạy cho mỗi loại và đối tượng). `work_reminder` (mỗi lần nhắc và mỗi thông báo lên cấp trên, chỉ thêm, khóa chuỗi duy nhất).
**Bảng của làn phân tích (V1810, khối GOV-6; chỉ thêm, RLS, `machvon_app` không UPDATE/DELETE).** `early_warning_score` (tuần × đơn vị: điểm, màu, độ bao phủ, phân rã từng yếu tố, phiên bản quy tắc, cờ chưa xác nhận; duy nhất cho một tuần và một đơn vị); `rag_override` (đơn vị, SET/REVOKE, màu, màu của quy tắc lúc đó, ngày hết hiệu lực, lý do, người ghi); `analytics_certification` thuộc BI (xem BI.md). Định nghĩa và ngưỡng không có cột ở đâu: chúng là quy tắc của `governance_rule`.

Classification: INTERNAL; tile có thể chứa số liệu CONFIDENTIAL nếu dự án CONFIDENTIAL — lọc ở view theo classification grant. Không cache dữ liệu theo user ở client ngoài phiên.

## 7. API / command

| operationId | Method path | x-permission | Request | Response | Lỗi |
|---|---|---|---|---|---|
| `getCommandCenter` | GET /home/command-center | home.read | `snapshot_id?`, `unit_id?`, `denominator_kind?` | `HomeCommandCenter` | 403 SCOPE_DENIED, 404, 422 METRIC_UNAVAILABLE |
| `getDisbursementRankings` | GET /home/rankings | home.read | `snapshot_id`, `comparison_group`, `denominator_kind` | danh sách xếp hạng | 404 |
| `getHomeWarnings` | GET /home/warnings | home.read | `snapshot_id`, `severity`, cursor | danh sách | – |
| `explainHomeMetric` | GET /home/drill | home.read (+ quyền đọc của đích) | `context_token`, `child_dimension`, cursor | `HomeDrillExplanation` | 403 SCOPE_DENIED, 409 SNAPSHOT_EXPIRED, 400 INVALID_REQUEST (token sai chữ ký/tenant) |
| `getMyWork` | GET /home/my-work | home.read | cursor | danh sách việc | – |
| `getKpiRegister` | GET /home/kpi-register | home.read | `as_of?` | định nghĩa, phiên bản, chứng nhận | 422 |
| `exportHomeFigures` | GET /home/command-center/export | home.read | `format` CSV\|XLSX, `snapshot_id?`, `unit_id?`, `denominator_kind?` | tệp base64 + băm | 403 SCOPE_DENIED, 404, 422 |
| `getRagReading` | GET /home/rag | home.read | `snapshot_id?`, `unit_id?` | màu, vì sao, bao phủ, ghi đè, xu hướng | 403 SCOPE_DENIED, 404, 422 |
| `setRagOverride` | POST /home/rag/overrides | home.rag.override | `RagOverrideRequest` | kết quả lệnh | 403 SCOPE_DENIED, 422 VALIDATION_FAILED |
| `revokeRagOverride` | POST /home/rag/overrides/revoke | home.rag.override | `RagOverrideRevoke` | kết quả lệnh | 403, 404, 422 |
| `scoreEarlyWarningWeek` | POST /home/rag/scores | home.rag.score | – | SCORED \| ALREADY_SCORED | 404 |
| `getHomeChanges` | GET /home/changes | home.read | `unit_id?` | ≤ 5 dòng thay đổi | 403 SCOPE_DENIED, 404 |
| `snoozeWork` | POST /home/work-actions/snooze | home.read | `source`, `source_id`, `snooze_until`, `reason_code` (bắt buộc), `reason` (bắt buộc khi OTHER) | kết quả lệnh | 404 WORK_ITEM_GONE, 422 VALIDATION_FAILED, WORK_SNOOZE_NOT_ALLOWED, WORK_SNOOZE_TOO_LONG, WORK_SNOOZE_LIMIT |
| `pauseWorkClock` | POST /home/work-actions/pause | home.read | `source`, `source_id`, `reason_code`, `reason`, `allowed_by_id`, `paused_until` | kết quả lệnh | 404 WORK_ITEM_GONE, 409 WORK_CLOCK_ALREADY_PAUSED, 422 VALIDATION_FAILED, WORK_CLOCK_PAUSE_TOO_LONG, WORK_CLOCK_ALLOWER_INVALID |
| `resumeWorkClock` | POST /home/work-actions/resume | home.read | `source`, `source_id`, `reason?` | kết quả lệnh | 404 WORK_ITEM_GONE, 409 WORK_CLOCK_NOT_PAUSED |
| `getSnoozedWork` | GET /home/work-actions/snoozed | home.read (cần phạm vi đọc) | – | việc đang hoãn trong phạm vi: ai, đến khi nào, lý do, lần thứ mấy | 403 SCOPE_DENIED |
| `getWorkClockPolicies` | GET /home/work-clocks/policies | home.read | – | ba quy tắc đang hiệu lực (phiên bản, chưa xác nhận, công thức, nguồn), năm đồng hồ có sẵn, các năm lịch đã công bố | – |

`getCommandCenter` thêm `count_tiles` và, mỗi tile, `display_value`, `kpi`, `certification`, `flags`; `explainHomeMetric` thêm `order`, `step`, `steps_total`, `drag_points`, `alerts`. Lệnh ghi của làn phân tích (`setRagOverride`, `revokeRagOverride`, `scoreEarlyWarningWeek`) có Idempotency-Key, audit và sự kiện (`home.rag_overridden.v1`, `home.rag_override_revoked.v1`, `home.early_warning_scored.v1`); quyền theo cây đơn vị của lệnh, người ngoài phạm vi nhận 403 `SCOPE_DENIED` không lộ tên.

`getMyWork` thêm cho mỗi việc: `started_at`, `clocks` (`basis`, `claim`, `resolve`, `paused`, `needs_reclaim`), `needs_reclaim`, `snooze` (người hoãn, đến khi nào, mã lý do, lần thứ mấy trên bao nhiêu lần, lần cuối, phiên bản quy tắc), `snooze_count`, `pause`, `pauses`, `reminders` (đã nhắc, lần nhắc kế, đã hết lần), `notices`, `existing_clock`, `expected_action`, `clock_type`, `policy_version`; `counts` thêm `needs_reclaim`, `snoozed`. Mã lỗi mới: `WORK_SNOOZE_TOO_LONG`, `WORK_SNOOZE_LIMIT`, `WORK_CLOCK_PAUSE_TOO_LONG`, `WORK_CLOCK_ALLOWER_INVALID` (422), `WORK_CLOCK_NOT_PAUSED`, `WORK_CLOCK_ALREADY_PAUSED` (409).
Không có command ghi riêng của HOME (Idempotency/If-Match không áp dụng); các nút hành động gọi command của PRJ/DIS/CAP. Không có GET scaffold riêng của HOME.

## 8. UI/UX

Giữ HOME-01…HOME-08. Field thêm: HOME-01 + "Thời điểm số liệu (as_of)", "Công thức" (FR-HOME-10); HOME-04 + "Snapshot", "Lý do loại khỏi xếp hạng" (FR-DIS-21); HOME-07 + "Vốn ODA", "Vốn địa phương giao thêm" (FR-CAP-16).
Mới: **HOME-09** (dashboard theo mockup HOME-01: hàng MetricTile cặp hai tỷ lệ, cột phải "Cảnh báo mở" + "Giải trình quá hạn", bảng xếp hạng thu gọn top/bottom 5, thẻ "Đề xuất điều chuyển chờ", header ngữ cảnh as_of/snapshot cố định); **HOME-10** (DrillDrawer: breadcrumb, tử/mẫu, công thức, loại trừ, bảng con, footer đối soát "Σ con = cha ✔" hoặc lý do không cộng, link nguồn).
**HOME-12 — Việc đang bị hoãn (G2-1, G2-2).** Bảng cho người có phạm vi đọc: việc, nguồn, mức, người hoãn, hoãn đến, lý do, lần hoãn n/tối đa, hạn xử lý; ngữ cảnh số liệu nêu thời điểm và phiên bản quy tắc. Trạng thái: đang tải (khung, không phải 0), rỗng (không có việc nào đang bị hoãn), lỗi có thử lại, một phần (nguồn không đọc được được nêu tên, không thành "không có việc"), cũ, bị từ chối (403). Ngăn thông báo: hộp thoại Nhắc lại chọn lý do từ quy tắc, ghi chú bắt buộc khi "khác", chỉ cho chọn đến số ngày của mức độ và đến ngày đến hạn, nêu "Lần n/tối đa" và cảnh báo ở lần cuối; hộp thoại Tạm dừng đồng hồ (lý do, lời giải thích, người cho phép khác mình, ngày kết thúc); chip "Cần nhận lại" và nút "Nhận lại"; hai đồng hồ "Nhận việc" và "Xử lý" kèm trạng thái chữ (Đang chạy, Tạm dừng, Đạt, Quá hạn) và câu "chưa có lịch làm việc đã công bố" khi thiếu lịch. Điện thoại (MOB): thẻ cảnh báo có chip, hai dòng đồng hồ và phiếu nhắc lại bắt buộc lý do; tạm dừng chỉ trên web.
Component: AppShell, MetricTile, DrillDrawer, DataTable, FilterBar, QualityBadge (NOT_ASSESSED tới R2). Bảy trạng thái + NewDataBanner. Không dùng chỉ màu: mỗi mức cảnh báo có chữ + icon. Mobile: MOB-07 (trang chủ lãnh đạo) dùng cùng `getCommandCenter` (tiles rút gọn, cùng as_of) — đề nghị MOB owner hiển thị hai tỷ lệ (§13).
**HOME-11 — Màu xanh vàng đỏ có giải thích (G3-2).** Danh sách đơn vị đỏ trước: màu bằng chữ và biểu tượng (không chỉ bằng màu), điểm cảnh báo sớm, độ bao phủ dữ liệu, 1 đến 3 "vì sao" (yếu tố, giá trị so với đường, điểm), tuần trước, xu hướng 8 tuần (có bảng thay thế), ghi đè (màu của quy tắc cạnh màu đã ghi đè, lý do, đến ngày, người ghi) và hộp xác nhận có lý do bắt buộc khi ghi đè/gỡ. Đơn vị thiếu dữ liệu ghi "chưa đủ dữ liệu". Bảy trạng thái; từ chối thể hiện là Denied, không phải lỗi. HOME-01 thêm nút "i" trên mọi con số, cờ chất lượng bằng chữ, thẻ tóm tắt màu, khối "Thay đổi từ tuần trước" (≤ 5 dòng, mỗi dòng một liên kết; đọc lỗi không được nói thành "không có thay đổi") và nút xuất Excel/CSV. HOME-10 thêm vệt ba bước, sắp "kéo tụt nhiều nhất trước" với điểm phần trăm, giữ bộ lọc khi quay lại, và danh sách cảnh báo của dự án.

## 9. Sự kiện, job, tích hợp, quan sát

Consumer: `snapshot.frozen.v1` → làm mới cache `t:{tenant}:home:cc:{snapshot}:{scope_hash}` (TTL 10 phút) và đẩy SSE "dữ liệu mới"; `warning.opened/resolved.v1`, `explanation.*` → vô hiệu cache tile cảnh báo. Không có job riêng. Telemetry: `home_load_ms` p95 ≤ 2 s với 5.000 dự án [GIẢ ĐỊNH, D09], `home_drill_denied_total`, `home_null_tile_total{reason}`; audit đọc nhạy cảm (drill tới chứng từ) theo chính sách audit đọc của tenant.
**Job `work-reminder` (G2-4, mỗi 15 phút).** Với từng người đọc được trung tâm cảnh báo, đọc danh sách của họ ở chế độ `rows` (đồng hồ và nhịp của chính sách đã áp dụng); ghi mỗi lần nhắc đến hạn vào `work_reminder` cùng sự kiện `home.work_reminder.v1` trong một giao dịch, và một thông báo `home.work_reclaim_notice.v1` lên cấp trên cho mỗi việc đã nhận xử lý rồi im lặng. Idempotent (khóa chuỗi); tối đa 500 lần nhắc cho một người mỗi lượt; người nào không đọc được danh sách được đếm `failed` và thử lại ở lượt sau; năm chưa có lịch không sinh nhắc. Bộ đếm `home_work_reminder_total`, `home_work_reclaim_notice_total`.
**Job `early-warning-score` (G3-2).** Mỗi giờ: lấy snapshot FROZEN mới nhất; nếu tuần của nó chưa có điểm thì chấm mọi đơn vị bằng quy tắc đang hiệu lực và ghi một dòng cho mỗi đơn vị (một lần cho tuần; lần chạy sau hoặc runner thứ hai không ghi gì), kèm audit `home.early_warning_scored` và sự kiện `home.early_warning_scored.v1`; gauge `early_warning_score_units`. Cảnh báo mới của làn này không thêm loại ALERT_TYPE: màu đỏ là thông tin điều hành, không phải một việc cần ai xử lý; điểm đỏ kéo theo cảnh báo sớm DIS đã có (chủ, hành động, hệ quả đã đăng ký ở đó).

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Setup | Bước | Expected | Bằng chứng |
|---|---|---|---|---|---|---|
| UAT-AC266 | E2E | P0 | S-40 FROZEN | mở HOME-09, drill 4 cấp | as_of/snapshot/công thức mỗi bước; tổng khớp | video |
| UAT-AC267 | security | P0 | thu hồi scope U-BQL2 | drill U-BQL2 | 403 SCOPE_DENIED, không lộ tên | API log |
| UAT-AC268 | business | P0 | dự án không dữ liệu | xem HOME-01/08 | "Chưa có dữ liệu" | screenshot |
| UAT-AC269 | business | P1 | CTMTQG 40 tỷ ⊂ NSTW | HOME-07/08 | không cộng | screenshot |
| UAT-AC270 | business | P1 | không DGV | HOME-01/09 | NOT_ASSESSED, không lỗi | screenshot |
| UAT-AC271 | business | P1 | EW-01 có giải trình | HOME-06 | đủ nguyên nhân/bằng chứng/người | screenshot |
| UAT-AC272 | business | P1 | 3 giải trình | HOME-02 | 3 việc, 1 quá hạn | screenshot |
| UAT-AC04 | domain | P0 | mẫu số 0 | HOME-04 | loại khỏi xếp hạng, lý do | API |
| UAT-AC06 | business | P0 | điều chỉnh chưa accept | HOME-01 | số chưa đổi | snapshot |
| UAT-AC242, UAT-AC254 | domain | P0 | FX-DIS-003/007 | xếp hạng/tỷ lệ | 14%; thứ tự | API |
| UAT-AC265 | security | P0 | token tenant A | B dùng token | 404/400 | log |
| UAT-HOME-G04 | domain | P0 | tenant duyệt định nghĩa v1 chưa chứng nhận | mở HOME-01 | tile null, `null_reason` NOT_CERTIFIED, cờ NOT_CERTIFIED, không 0; chứng nhận bởi người khác thì hiện số | API (`apps/api/test/home/analytics-governance.test.ts`) |
| UAT-HOME-G04b | domain | P0 | snapshot có số | xuất CSV/XLSX và đọc lại | chữ mỗi con số = `display_value` của API = chữ trên web và điện thoại | API + vitest + flutter test |
| UAT-HOME-G32 | domain | P0 | hai tuần, một đơn vị tụt | `getRagReading`, ghi đè, gỡ | đỏ có yếu tố và điểm; ghi đè cạnh màu quy tắc; lý do bắt buộc; hết hạn tự rơi | API |
| UAT-HOME-G33 | security | P0 | scope nhánh Bắc | drill `order=drag` và token của nhánh Nam | thứ tự kéo tụt đúng điểm; token của người khác 400, không lộ tên | API |
| UAT-HOME-G34 | domain | P1 | hai snapshot hai tuần | `getHomeChanges` | ≤ 5 dòng, mỗi dòng một liên kết, không tên; không tuần trước thì NO_PREVIOUS_WEEK | API |
| UI-HOME-09, UI-HOME-10 | screen-contract | P0 | synthetic | 7 trạng thái + banner | đúng field/rule | screenshot |

## 11. Tiêu chí nghiệm thu

- **AC-HOME-01** Given snapshot FROZEN, When mở HOME-09, Then mọi tile có scope, as_of, snapshot, công thức; hai tỷ lệ cạnh nhau. → UAT-AC266
- **AC-HOME-02** Given drill nhiều cấp, Then mỗi cấp giữ snapshot và Σ con = cha cho tiền. → UAT-AC266
- **AC-HOME-03** Given scope bị thu hồi sau khi mở trang, When drill, Then 403 `SCOPE_DENIED` không lộ tên hồ sơ. → UAT-AC267
- **AC-HOME-04** Given thiếu dữ liệu hoặc mẫu số 0, Then hiện nhãn chữ, không 0%. → UAT-AC268, UAT-AC04
- **AC-HOME-05** Given DGV chưa triển khai, Then HOME hoạt động với badge NOT_ASSESSED. → UAT-AC270
- **AC-HOME-06** Given báo cáo điều chỉnh chưa được chấp nhận, Then HOME không đổi số. → UAT-AC06
- **AC-HOME-07** Cảnh báo/giải trình/việc của tôi hiển thị đúng người phụ trách và hạn. → UAT-AC271, UAT-AC272
- **AC-HOME-08** (G0-4) Given sổ KPI, Then mỗi con số có nút "i" mở công thức, nguồn, `as_of`, chủ sở hữu, phiên bản, và chữ của số trên web, điện thoại, Excel trùng nhau. → UAT-HOME-G04b
- **AC-HOME-09** (G3-1) Given định nghĩa chưa chứng nhận, Then lãnh đạo không nhận số (NOT_CERTIFIED), người xác nhận không tự chứng nhận (403 `SELF_APPROVAL_DENIED`). → UAT-HOME-G04
- **AC-HOME-10** (G3-2) Given đơn vị đỏ, Then có 1 đến 3 yếu tố, độ bao phủ và điểm tuần trước; ghi đè cần lý do và hạn ≤ 90 ngày; thiếu dữ liệu không thành xanh. → UAT-HOME-G32
- **AC-HOME-11** (G3-3) Given tỷ lệ, When drill `order=drag`, Then phần kéo tụt nhiều nhất đứng đầu với điểm phần trăm chính xác và bộ lọc được giữ. → UAT-HOME-G33
- **AC-HOME-12** (G3-4) Given hai tuần, Then khối thay đổi có ≤ 5 dòng sinh theo luật, mỗi dòng một liên kết, không tên. → UAT-HOME-G34

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

**R1:** HOME-01..04, 06..10 trên snapshot DIS; drill tới report revision và giao dịch Kho bạc; việc của tôi gồm giải trình + báo cáo + phê duyệt; xung đột DGV xử lý bằng NOT_ASSESSED.
**R2:** HOME-05 bản đồ GIS đầy đủ, badge chất lượng từ DGV, so sánh nhiều snapshot (xu hướng tuần), SSE thời gian thực, cá nhân hóa tile.
**Giờ review người:** quyền drill và rò rỉ scope 3 h; trình bày hai tỷ lệ/định nghĩa với Chủ nghiệp vụ vốn 2 h; UX lãnh đạo (test 5 người) 3 h. Tổng ≈ 8 h.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| CR-HOME-01: đổi phụ thuộc HOME từ "DIS,DGV" sang "DIS,CAP,PRJ,ISS (DGV mềm R2)" | PO | Ghi CR vào Decision_Register |
| Chính sách hiển thị xếp hạng (ALL vs OWN_ONLY) | Lãnh đạo tenant | Cấu hình tenant |
| Ngưỡng stale 8 ngày, p95 2 s [GIẢ ĐỊNH] | Ops/PO (D09/D10) | Capacity profile pilot |
| BI owner: `drill_context` (BI) và HOME token phải dùng chung chuẩn ký/kiểm scope | BI owner | Thống nhất thư viện DrillContext |
| MOB-07 cần hai tỷ lệ + as_of | MOB owner | Cập nhật screen MOB-07 |
| [CXN-03], [CXN-33] như DIS/PRJ | Chủ nghiệp vụ vốn | Xem DIS.md, PRJ.md |

## 14. Quản trị hệ thống cảnh báo: sức khỏe, leo thang, độ phủ (làn GOV-9a, G2-3, G2-5, G2-7, G2-10)

Nguồn: `docs/governance-roadmap-10of10.md` G2-3, G2-5, G2-7, G2-10; nghiên cứu cảnh báo mục A2, A4, A6, A8; quy trình và quy tắc chi tiết ở `docs/alert-governance.md`. Mọi con số là giá trị khởi điểm của nghiên cứu, **chưa kiểm chứng**, đọc qua `GovernancePolicyPort` (loại quy tắc `ESCALATION_POLICY`, `ABSENCE_POLICY`, `ALERT_NOTIFY_POLICY`, `ALERT_HEALTH_TARGETS`, mã `DEFAULT`), có nguồn, công thức, ngày áp dụng; màn hình ghi nhãn "mặc định, chưa xác nhận".

**HOME-13 Sức khỏe hệ thống cảnh báo** (`getAlertHealth`, `getAlertCoverageReport`): mười bốn chỉ số của chính hệ thống cảnh báo tính từ `alert_item_trace` (job `alert-escalation` ghi mỗi 15 phút), `alert_notification_log`, `alert_routing_gap` và độ phủ chức danh. Mỗi chỉ số một công thức, một nguồn, một ngưỡng, một trạng thái (OK, WATCH trong vòng một phần năm ngoài ngưỡng, BREACH, NO_DATA, NO_SOURCE); số không tính được hiện là không có dữ liệu hoặc chưa có nguồn kèm lý do, không bao giờ hiện 0; thời gian nhận và xử lý tính bằng giờ làm việc trên lịch đã công bố, trừ thời gian dừng đồng hồ. Bảng: MTTA, MTTR, đúng hạn, leo thang, leo tới cấp cuối, cảnh báo mỗi người mỗi ngày (phân vị 90), đẩy mỗi người mỗi ngày, ngoài giờ yên tĩnh không có ngoại lệ, tồn cũ (7 và 30 ngày), tỷ trọng mười loại nhiều nhất, tỷ lệ hoãn theo loại, cảnh báo mồ côi và thời gian chuyển người, giao nhận Khẩn (chưa có biên nhận, chờ G2-6), độ phủ người thay. Người xem chỉ thấy các đơn vị trong phạm vi quyền `home.alert.health.read`; job ghi quá hai lượt chạy thì trang ghi "Số liệu cũ".

**Trung tâm cảnh báo** có thêm hai nguồn: `ESCALATION` (việc được chuyển lên người xem, loại cảnh báo `ESCALATED_ITEM`) và `COVERAGE` (khoảng trống người nhận cho người quản lý ủy quyền, loại `COVERAGE_GAP`); thẻ việc có `escalation` lấy từ chuỗi leo thang (người nhận việc, rồi từng cấp ghi chức năng hay thứ bậc), `on_behalf_of` khi người xem nhận thay, `promoted_from` khi việc Theo dõi được nâng một bậc (lý do `WATCH_AGED`).

Lỗi: `ALERT_ESCALATION_STATE_INVALID` (409). Job: `alert-escalation` và `alert-coverage` (15 phút, idempotent, có khóa chuỗi cho từng dòng).
