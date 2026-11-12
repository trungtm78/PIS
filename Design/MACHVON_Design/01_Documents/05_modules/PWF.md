# PWF — Workflow dự án, lập lịch và hạn ba màu, KPI và chấm điểm nhân viên

Phiên bản đặc tả M1 · 12/11/2026 · Làn `pwfspec` (bước 1 phần 2 của kế hoạch "Đợt mới 2026-11-12"; rà soát kỹ thuật R28 đến R43). Căn cứ nghiên cứu: `docs/pwf-research.md` (mã D-nn). Lõi thuần đã có: `packages/kernel/src/project-workflow.ts`, `project-schedule.ts`, `deadline-band.ts`, `workflow-kpi.ts`, `process-core.ts`. Quy ước chung (tenant, RLS, idempotency, audit/outbox, Problem, i18n, 7 trạng thái giao diện) ở `05_Thiet_ke_chi_tiet.md` và `04_Thiet_ke_co_ban.md`, không chép lại. Phân hệ là **mã dùng chung của bản công** ("Hệ thống quản lý đầu tư công"); bản doanh nghiệp chỉ thêm gói mẫu và loại chứng từ qua cơ chế bản (R42), không có nội dung riêng của khách hàng nào trong mã chung. Chuỗi hiển thị công khai không ghi tên mã sản phẩm.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề nghiệp vụ.** Mỗi dự án đầu tư công đi qua một trình tự công việc có thật: chuẩn bị đầu tư (chủ trương, nghiên cứu tiền khả thi, nghiên cứu khả thi, thẩm định, quyết định đầu tư), thực hiện (kế hoạch vốn, đấu thầu, thi công, giám sát, thanh toán), kết thúc (nghiệm thu, bàn giao, quyết toán, đánh giá). Hôm nay hệ thống chỉ có trạng thái pháp định của dự án (PIMA, PRJ mục 4) và quy trình lựa chọn nhà thầu theo gói (PRC-1, BID); chưa có công việc của dự án, chưa có ngày bắt đầu dự định, chưa có hạn từng việc, chưa có ba mức đỏ/vàng/xanh do người dùng đặt ngưỡng, chưa có KPI theo workflow và chưa có chấm điểm nhân viên. PWF bổ sung ba chức năng gắn với nhau (yêu cầu của chủ sở hữu 2026-11-12):

1. **Workflow dự án (PWF-1).** Mẫu workflow là quy tắc có phiên bản (`PROJECT_WORKFLOW_TEMPLATE`): giai đoạn cấu hình được, công việc định nghĩa động (thời lượng ngày làm việc, phụ thuộc FS/SS/FF/SF có độ trễ, mốc, bắt buộc hay không, vai phụ trách, người duyệt hoàn thành, chứng từ pháp lý, biểu mẫu, danh mục kiểm, KPI, nhánh theo nhóm dự án và nguồn vốn). Dự án khởi tạo hoặc tiếp nhận thì đóng băng một bản của mẫu.
2. **Hạn và ba màu (PWF-2).** Từ ngày dự định bắt đầu và thời lượng trong mẫu, hệ thống tính ngày bắt đầu, hạn, độ trễ cho phép và đường găng của từng công việc và mốc trên lịch làm việc có phiên bản. Màu đỏ/vàng/xanh tính theo số ngày còn lại tới hạn, ngưỡng do người dùng đặt qua ba tầng (mặc định hệ thống, quy tắc tenant hoặc đơn vị `DEADLINE_BAND_POLICY`, tùy chọn cá nhân chỉ được nhắc sớm hơn).
3. **KPI và chấm điểm (PWF-3).** Mỗi workflow có bộ KPI (`WORKFLOW_KPI_SET`) chọn từ danh mục phép tính an toàn, quy đổi sang điểm tuyến tính hoặc bậc thang; từ điểm việc, theo sổ phân công, hệ thống tính điểm nhân viên theo kỳ (`STAFF_SCORING_POLICY`) và nêu rõ mọi phép loại trừ, mẫu nhỏ và điều chỉnh. Điểm là **căn cứ hỗ trợ**, không tự dẫn tới thưởng, kỷ luật hay chấm dứt hợp đồng (BR-PWF-41).

**Trong phạm vi:** soạn, duyệt, phiên bản mẫu workflow và bốn loại quy tắc; khởi tạo và tiếp nhận workflow cho dự án; công việc, bằng chứng, danh mục kiểm, người duyệt hoàn thành khác người làm, ngoại lệ, tạm dừng, hủy, trì hoãn bên ngoài có duyệt; sổ phân công; lập lịch xuôi và ngược, đường cơ sở nhiều phiên bản, dời lịch có xem trước và duyệt; cổng giai đoạn kiểm trong cùng giao dịch của lệnh chuyển trạng thái PRJ; bảng deadline toàn danh mục, lịch tháng, mốc 30 ngày tới, tải công việc theo người (chỉ hiển thị); nguồn cảnh báo `PROJECT_TASK`, nhắc nhiều mốc và leo thang; tùy chọn cá nhân; KPI theo công việc, điểm kỳ, điều chỉnh có duyệt, phản hồi qua ADM, xuất tệp, năm màn điện thoại.

**Ngoài phạm vi:** chuyển PRC-1 sang bộ máy chung (giữ nguyên, R29; chỉ rút hàm thuần sang `process-core.ts`); cân bằng nguồn lực tự động (resource leveling) và lập lịch theo chi phí (D-17); độ trễ theo ngày lịch kiểu elapsed (D-03, để sau); tự động áp hậu quả nhân sự từ điểm; ma trận 9 ô, xếp hạng cưỡng bức (D-42); thiết kế lại giao diện điện thoại ngoài các màn PWF (làn MUX); nội dung riêng của một khách hàng.

**Phụ thuộc:** PRJ (dự án, trạng thái pháp định, `project_milestone`, `project_baseline`, `project_accountability`, `prj-stage-store`), ADM (quy tắc có phiên bản và người duyệt khác người lập, lịch làm việc `WorkCalendarStore`, bộ máy duyệt, ADM-11 nhật ký xem, `alert_notification_profile`), HOME (trung tâm cảnh báo, `WORK_SOURCES`, đồng hồ), DOC (biểu mẫu `document_template`, văn bản), BID (loại bằng chứng của PRC-1 dùng chung), IAM (membership, cây đơn vị, scope), MDM (nhóm dự án, nguồn vốn), BI (sổ KPI `KPI_DEFINITION`, `RAG_THRESHOLDS`), IPF/EVM/look-ahead (đọc lịch qua cổng, BR-PWF-11).

**Căn cứ.** Luật Đầu tư công 58/2024/QH15 (trình tự chuẩn bị đầu tư, thực hiện, kết thúc), Luật Đấu thầu 22/2023/QH15, các nghị định hướng dẫn `[CXN-13]` (số hiệu chưa kiểm chứng; nằm trong `source` của quy tắc, `legalStatus: UNVERIFIED`); Điều 112 Bộ luật Lao động 2019 (lịch nghỉ do Thủ tướng ấn định hằng năm, nên lịch làm việc là dữ liệu có phiên bản); Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 (Điều 3, 4, 14, 25) và Nghị định 90/2020/NĐ-CP về đánh giá cán bộ, công chức `[CXN-PWF-01]` cho phần điểm nhân viên. Thị trường: MS Project, Primavera P6, Asana, Jira Plans, Monday, Smartsheet, ClickUp, Procore, Autodesk Build, Fieldwire (lập lịch, nhắc hạn, RAG); OKR, Balanced Scorecard, SAP SuccessFactors, Workday, Lattice, 15Five, Culture Amp (điểm, calibration, công bằng): xem `docs/pwf-research.md` Phần C.

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Quản trị quy trình dự án (maker của mẫu) | Tenant; đơn vị nếu quy tắc có `unit_id` | Soạn nháp và trình `PROJECT_WORKFLOW_TEMPLATE`, `WORKFLOW_KPI_SET`, `STAFF_SCORING_POLICY`, `DEADLINE_BAND_POLICY` (qua kho quy tắc ADM); `validateProjectWorkflowTemplate`, `previewProjectWorkflowTemplate` | Tự duyệt quy tắc mình soạn (`SELF_APPROVAL_DENIED`) |
| Người duyệt quy tắc (checker) | Tenant | Duyệt hoặc trả quy tắc | Duyệt quy tắc do mình soạn |
| Chủ đầu tư / Ban QLDA (quản lý dự án) | Scope đơn vị `owner_unit_id`/`investor_unit_id` và đơn vị con | `startProjectWorkflow`, `adoptProjectWorkflow`, `assignProjectTask`, `proposeProjectReschedule`, `requestProjectTaskException` | Tự duyệt đề nghị dời lịch hoặc ngoại lệ do mình lập |
| Người thực hiện công việc | Công việc được giao trong sổ phân công | `startProjectTask`, `attachProjectTaskEvidence`, `completeProjectTaskChecklistItem`, `completeProjectTask`, `requestProjectTaskPause`, `resumeProjectTask`, đặt tùy chọn cá nhân | Duyệt hoàn thành việc của mình (`SELF_APPROVAL_DENIED`); tự khai miễn trễ |
| Người duyệt hoàn thành (vai `approver_role` của việc) | Dự án trong scope | `approveProjectTaskCompletion`, `returnProjectTask`, `decideProjectTaskException`, `decideProjectReschedule` | Duyệt khi chính mình là người làm hoặc đã hoàn thành mục danh mục kiểm của việc (`MAKER_IS_APPROVER`, không ngoại lệ nào che được) |
| Lãnh đạo, giám sát (đọc) | Scope đơn vị | Đọc workflow, bảng deadline (màu chính thức), tải công việc | Mọi lệnh ghi |
| Người được đánh giá (nhân viên) | Chính mình | `getMyStaffScore`, xem toàn bộ dữ kiện và phép tính của mình, `submitStaffScoreResponse` | Xem điểm người khác |
| Quản lý trực tiếp | Đơn vị tại thời điểm của kỳ (R33) | `listStaffScoreLines` (đơn vị), `getStaffScoreLine`, `requestStaffScoreAdjustment`, xuất tệp trong scope | Xem kỳ sau khi chuyển đơn vị hoặc bị thu hồi quyền; duyệt điều chỉnh do mình đề xuất; duyệt điều chỉnh điểm của chính mình |
| Bộ phận nhân sự | Toàn tenant theo quyền `staff_score.read_hr` | Xem, xuất, chốt kỳ, xử lý phản hồi, `decideStaffScoreAdjustment` (khi không phải người đề xuất hoặc người được chấm) | Sửa điểm tính; xóa kỳ đã chốt |
| Người rà soát tín hiệu thao túng | Quyền `staff_score.review` | Xem cờ bất thường của kỳ | Cờ không tự đổi điểm |
| Kho bạc, Sở Kế hoạch và Đầu tư, Sở Tài chính (vai phối hợp) | Vai trong sổ phân công của việc | Nhận việc thẩm định, kiểm soát chi; là người duyệt hoàn thành của việc thuộc vai | Mọi quyền khác của PWF |
| Hệ thống | Job và consumer | Tính lại lịch tăng dần, sinh và đóng cảnh báo `PROJECT_TASK`, nhắc nhiều mốc, chốt kỳ theo lịch, chính thức hóa kỳ (`officializeStaffScorePeriod`) | Đổi trạng thái pháp định của dự án (chỉ kiểm cổng) |

Mọi truy vấn áp RLS tenant rồi lọc cây đơn vị; người ngoài scope nhận 404. Riêng bảng điểm: RLS theo chủ thể và phạm vi ở tầng cơ sở dữ liệu, không chỉ ở API (BR-PWF-40).

## 3. Luồng nghiệp vụ

**F1 — Soạn và duyệt mẫu (PWF-01, PWF-02).** Maker mở thư viện mẫu, chọn mã (`PUBLIC_INVESTMENT`, `PUBLIC_PROCUREMENT`, `PUBLIC_REPAIR` hoặc mã mới), soạn nháp: giai đoạn, công việc, liên kết, nhánh, chứng từ, biểu mẫu, danh mục kiểm, KPI. `validateProjectWorkflowTemplate` trả danh sách lỗi (vòng lặp phụ thuộc, tham chiếu không tồn tại, vượt giới hạn) và gợi ý chất lượng lịch kiểu DCMA (BR-PWF-19, không chặn); `previewProjectWorkflowTemplate` lập lịch thử với ngày bắt đầu và nhóm dự án chọn tạm. Trình, người duyệt khác người soạn duyệt; mẫu `UNVERIFIED` hiển thị nhãn "mặc định, chưa xác nhận". Mẫu đã duyệt có hiệu lực từ ngày chọn; dự án đang chạy giữ bản đã đóng băng.

**F2 — Khởi tạo workflow (PWF-05 → PWF-03).** Tiền điều kiện: dự án trong scope, chưa có workflow (`PWF_WORKFLOW_EXISTS`), quyền `pwf.workflow.manage`. (1) Chọn mẫu theo loại dự án, nhập `planned_start_date`, xác nhận dữ kiện nhánh (nhóm dự án và nguồn vốn lấy từ dự án, sửa được trước khi tạo). (2) `startProjectWorkflow` (Idempotency-Key): đóng băng mẫu (mã, phiên bản, băm, nội dung), tạo `project_task` cho mọi việc (nhánh không có được đánh dấu `EXCLUDED`, vẫn giữ làm nút độ dài 0), tạo sổ phân công mặc định từ `project_accountability` và vai trong mẫu, chạy `scheduleProject` trên lịch làm việc ghim theo phiên bản, ghi `project_schedule_version` 1 và đường cơ sở 1 (BR-PWF-07, 11). (3) Năm không có lịch: từng việc nhận `CALENDAR_UNAVAILABLE` kèm năm thiếu; workflow vẫn tạo, hạn của việc đó hiển thị "chưa tính được, thiếu lịch năm N", không có ngày đoán. Đồng thời: hai người tạo cùng lúc, người sau nhận `PWF_WORKFLOW_EXISTS` (khóa theo dự án).

**F3 — Tiếp nhận dự án đang chạy (PWF-05; R36).** `adoptProjectWorkflow` với `effective_date` và `dry_run=true` trả bản chạy thử: việc thuộc quá khứ (kết thúc trước ngày hiệu lực) được chọn một trong hai: `NOT_TRACKED` (không vào điểm KPI, không có đồng hồ) hoặc "đã xong" kèm bằng chứng đúng loại; việc đang dở nhận ngày bắt đầu thực và thời lượng còn lại. Áp dụng (`dry_run=false`) là một giao dịch; nhập hàng loạt theo danh mục dự án là một job gọi lại lệnh này từng dự án với báo cáo từng dòng. Việc `NOT_TRACKED` không bao giờ vào mẫu số KPI (BR-PWF-17).

**F4 — Thực hiện công việc (PWF-04, MOB-79).** (1) `startProjectTask` (người được giao, tiền nhiệm cần thiết đã đủ theo loại liên kết, không bắt buộc FS xong nếu quản lý cho phép bắt đầu sớm có ghi lý do) đặt ngày bắt đầu thực. (2) Nộp bằng chứng và hoàn thành mục danh mục kiểm (`attachProjectTaskEvidence`, `completeProjectTaskChecklistItem`); chứng từ pháp lý đính theo loại đã phân giải qua edition (BR-PWF-15), biểu mẫu sinh từ `document_template` theo mẫu. (3) `completeProjectTask` chạy `assessTaskCompletion`: thiếu mục, bằng chứng, chứng từ hoặc biểu mẫu thì trả 422 `PWF_TASK_COMPLETION_BLOCKED` kèm danh sách `blockers`; đủ và việc có `approver_role` thì chuyển `AWAITING_APPROVAL`. (4) Người duyệt hoàn thành `approveProjectTaskCompletion` (khác người làm) hoặc `returnProjectTask` (tăng số lần trả lại, lý do bắt buộc); duyệt xong việc `DONE`, đóng cảnh báo, đóng đồng hồ, cập nhật lịch tăng dần trong cùng giao dịch, phát sự kiện.

**F5 — Ngoại lệ, tạm dừng, hủy, trì hoãn bên ngoài (PWF-04).** Một bảng đề nghị (`project_task_exception`) với bốn loại: `WAIVE_REQUIREMENT` (miễn mục, bằng chứng, chứng từ, biểu mẫu còn thiếu; không bao giờ miễn quy tắc người làm khác người duyệt), `CANCEL_TASK` (hủy việc, kể cả việc bắt buộc), `PAUSE` (tạm dừng), `EXTERNAL_DELAY` (trì hoãn do bên ngoài: chờ cơ quan, mặt bằng, thời tiết). Người làm hoặc quản lý đề nghị kèm lý do (từ 20 ký tự) và bằng chứng; người quyết định khác người đề nghị. Chỉ `PAUSE` và `EXTERNAL_DELAY` đã được DUYỆT mới tạo khoảng được miễn trong điểm KPI (BR-PWF-35); người phụ trách không tự khai miễn. Hủy việc không được duyệt vẫn tính là chưa đạt khi chấm (BR-PWF-37). Việc hủy hoặc nhánh bị loại thành nút độ dài 0 giữ thứ tự (BR-PWF-09).

**F6 — Dời ngày bắt đầu và tính lại lịch (PWF-06).** Điều kiện kích hoạt: đổi `planned_start_date`, trễ thực tế, đổi thời lượng hoặc liên kết, bổ sung hoặc bỏ việc của riêng dự án, đổi phiên bản lịch làm việc. (1) `proposeProjectReschedule` tính xem trước bằng `rescheduleProject`: lịch mới của phần chưa làm (việc đã xong giữ ngày thực), danh sách việc thay đổi (dời bao nhiêu ngày làm việc, đổi độ trễ cho phép, thành hoặc hết găng), độ lệch so với đường cơ sở; lưu thành đề nghị (băm đầu vào và kết quả). (2) Người duyệt khác người đề nghị `decideProjectReschedule` kèm `If-Match` phiên bản workflow; thành công thì phát hành `project_schedule_version` mới nguyên tử dưới khóa theo dự án; hai người dời cùng lúc: người sau nhận 409 `PWF_SCHEDULE_VERSION_CONFLICT` và xem lại bản mới. (3) Đường cơ sở KHÔNG đổi khi dời lịch; chỉ thêm đường cơ sở phiên bản mới qua quy trình đường cơ sở của PRJ (người duyệt khác người lập). Đếm số lần dời hạn chưa miễn vào KPI `PWF_RESCHEDULE_COUNT`.

**F7 — Cổng giai đoạn (PWF-03; R29).** Mẫu khai báo giai đoạn nào chặn lệnh hoặc sự kiện nào của PRJ (`submitProjectForAppraisal`, `decideProjectAppraisal`, `startProjectImplementation`, `completeProject`, `closeProject`, và tùy chọn `capital.plan_published.v1`, `settlement.closed.v1`). `ProjectWorkflowGate.assert(tx, project, target)` do PWF cung cấp, được `prj-stage-store` gọi trong CÙNG giao dịch của mọi lệnh và của consumer sự kiện hệ thống; việc bắt buộc, thuộc nhánh dự án có, trong giai đoạn chặn lệnh phải `DONE` (và được duyệt), được miễn có duyệt, hoặc hủy có duyệt. Chưa đủ: 422 `PWF_GATE_CLOSED` kèm danh sách việc còn thiếu và lý do; consumer sự kiện không chuyển trạng thái, ghi `pwf.gate.refused.v1` và tạo cảnh báo. Dự án chưa có workflow giữ hành vi cũ, không có kiểm tra nào (hợp đồng hồi quy, BR-PWF-13). `evaluateProjectGate` cho màn xem trước một lệnh có chạy được không.

**F8 — Hạn, màu và cảnh báo (PWF-07, PWF-08, PWF-15).** Mỗi công việc tính `deadlineBand` từ hạn dự báo hiện hành, ngày hôm nay (giờ Việt Nam), đơn vị của nguồn `PROJECT_TASK` (ngày làm việc), ngưỡng theo thứ tự: mặc định hệ thống 5/2/0, quy tắc `DEADLINE_BAND_POLICY` (ghi đè theo loại việc, mức ưu tiên, giai đoạn), tùy chọn cá nhân. Trung tâm cảnh báo đọc hạn trực tiếp từ công việc (không tạo đồng hồ cho từng việc, R30): một danh tính cảnh báo cho mỗi công việc và phiên bản lịch; dời lịch, tạm dừng, hủy, hoàn thành cập nhật trong cùng giao dịch; chạy lại không sinh trùng. Nhắc nhiều mốc (`reminder_days`, mỗi mốc kích hoạt đúng một lần theo khóa `(task, phiên bản lịch, mốc)`) và leo thang sau N ngày quá hạn dùng bộ máy nhắc, leo thang, ủy quyền vắng mặt sẵn có. Cảnh báo theo dự báo `PWF_MILESTONE_AT_RISK` khi ngày dự báo của mốc vượt hạn cơ sở.

**F9 — KPI theo workflow và chốt kỳ (PWF-09, PWF-10, PWF-14).** (1) Khi việc `DONE`, hủy, hoặc tới hạn, job ghi `task_kpi_result` bất biến cho từng KPI áp dụng: giá trị, điểm, trạng thái (`OK`, `NOT_APPLICABLE`, `EXCLUDED`, `MISSING_FACT`), phiên bản bộ KPI, băm dữ kiện nguồn. (2) Cuối kỳ (tháng, quý hoặc năm theo `STAFF_SCORING_POLICY`) người có quyền `staff_score.manage` gọi `computeStaffScorePeriod` (bản nháp có thể tính lại) rồi `lockStaffScorePeriod`: chụp khoảng phân công, tỷ lệ, phiên bản chính sách, lịch, đường cơ sở và mốc cắt sự kiện; kỳ chốt có băm; tính lại từ ảnh chụp cho cùng băm. Chốt kỳ đồng thời với điều chỉnh: dưới khóa theo kỳ; điều chỉnh sau chốt tạo kết quả thay thế có dòng dõi, không ghi đè. (3) Kỳ mở cửa sổ phản hồi `response_window_days`; kỳ chỉ "chính thức" khi hết cửa sổ và không còn phản hồi mở, hoặc mọi phản hồi đã xử lý (BR-PWF-39).

**F10 — Xem điểm, phản hồi, điều chỉnh (PWF-11 đến PWF-13, MOB-81; R33, R43).** Nhân viên xem điểm của mình kèm phân rã tới từng việc và dữ kiện, nút "i" công thức, các điều chỉnh làm đổi điểm. Nhân viên phản hồi `submitStaffScoreResponse` trong cửa sổ (nội dung ≥ 20 ký tự); phản hồi chạy qua bộ máy duyệt ADM (loại nghiệp vụ `STAFF_SCORE_RESPONSE`, handler `handleStaffScoreResponse`, đồng hồ xử lý và cảnh báo). Quản lý trong scope `requestStaffScoreAdjustment` (lý do, bằng chứng, trong biên độ `max_adjustment_points`); nhân sự hoặc người quyền duyệt khác người đề xuất và khác người được chấm `decideStaffScoreAdjustment`. Giữ cả điểm tính và điểm điều chỉnh; người được chấm thấy mọi điều chỉnh. Mọi lần người khác xem hoặc xuất ghi ADM-11.

**F11 — Điện thoại (MOB-78 đến MOB-82).** Dải giai đoạn và danh sách việc theo màu hạn, chi tiết việc (nộp chứng từ, hoàn thành, xin dời hạn), việc của tôi theo hạn (màu cá nhân kèm nhãn "theo cài đặt của bạn" và ngày hạn thật), điểm KPI của tôi, cài đặt nhắc hạn cá nhân. Dữ liệu cũ ghi giờ đồng bộ; lệnh gửi lại ngoại tuyến kiểm phiên bản, trả "công việc đã thay đổi", không ghi đè; không lưu đệm bảng điểm của người khác và xóa đệm khi phiên bản quyền đổi (BR-PWF-40).

## 4. State machine

**Công việc (`project_task.status`).**

```
 NOT_STARTED --start--> IN_PROGRESS --complete(đủ điều kiện)--> AWAITING_APPROVAL --approve--> DONE
      |                    |  ^                                     |
      |                    |  +-----return(lý do)-------------------+
      |                    +--pause(duyệt)--> ON_HOLD --resume--> IN_PROGRESS
      +--cancel(duyệt)--> CANCELLED <--cancel(duyệt)-- IN_PROGRESS / ON_HOLD / AWAITING_APPROVAL
 Việc không có approver_role: complete -> DONE. EXCLUDED (nhánh không có) và NOT_TRACKED (tiếp nhận) là trạng thái cuối, không chuyển.
```

| Từ | Command | Đến | Ai được làm | Guard | Audit/Event |
|---|---|---|---|---|---|
| NOT_STARTED | `startProjectTask` | IN_PROGRESS | Người được giao trong sổ phân công | Workflow ACTIVE; tiền nhiệm theo loại liên kết đủ điều kiện hoặc có lý do bắt đầu sớm | `project_task_log` START; `pwf.task.started.v1` |
| IN_PROGRESS | `completeProjectTask` | AWAITING_APPROVAL hoặc DONE | Người được giao | `assessTaskCompletion` ok; chứng từ và biểu mẫu đủ hoặc ngoại lệ `WAIVE_REQUIREMENT` đã duyệt | COMPLETE_REQUESTED hoặc COMPLETED; `pwf.task.completed.v1` |
| AWAITING_APPROVAL | `approveProjectTaskCompletion` | DONE | Vai `approver_role`, khác mọi người làm | Không phải người làm hoặc người hoàn thành mục danh mục kiểm | APPROVED; kích hoạt KPI, đóng cảnh báo |
| AWAITING_APPROVAL | `returnProjectTask` | IN_PROGRESS | Người duyệt | Lý do ≥ 20 ký tự | RETURNED, `return_count` + 1 |
| IN_PROGRESS | `requestProjectTaskPause` + `decideProjectTaskException` | ON_HOLD | Người làm đề nghị, người khác duyệt | Lý do, bằng chứng | PAUSE_APPROVED; khoảng được miễn vào KPI |
| ON_HOLD | `resumeProjectTask` | IN_PROGRESS | Người được giao hoặc quản lý | Đóng khoảng tạm dừng | RESUMED |
| bất kỳ trừ DONE | `decideProjectTaskException` (CANCEL_TASK) | CANCELLED | Người duyệt khác người đề nghị | Không còn việc con chưa hủy (không có việc con, chỉ liên kết: hậu nhiệm giữ thứ tự theo BR-PWF-09) | CANCELLED; việc không xóa vật lý |

Chuyển bị cấm: DONE sang trạng thái khác (sửa sau xong là một bản đính chính có lý do và người duyệt, không đổi trạng thái); CANCELLED, EXCLUDED, NOT_TRACKED sang bất kỳ; tự duyệt hoàn thành (`SELF_APPROVAL_DENIED` hoặc `MAKER_IS_APPROVER`); hoàn thành khi thiếu điều kiện (`PWF_TASK_COMPLETION_BLOCKED`); mọi chuyển trên workflow đã hủy hoặc đã đóng (`PWF_TASK_STATE_INVALID`).

**Workflow (`project_workflow.status`).** `ACTIVE` (đang chạy) ↔ `ON_HOLD` (cùng trạng thái SUSPENDED của dự án) → `COMPLETED` (mọi việc bắt buộc DONE hoặc được miễn, `closeProject`) hoặc `CANCELLED` (dự án hủy). Giai đoạn workflow là dẫn xuất từ công việc (giai đoạn mở = giai đoạn đầu tiên còn việc bắt buộc chưa xong), KHÔNG phải trạng thái pháp định; trạng thái pháp định đổi chỉ qua lệnh PRJ (bảng chuyển cố định `prj-stage-machine.ts`).

**Đề nghị dời lịch.** `PROPOSED` → `APPROVED` (phát hành phiên bản lịch) | `REJECTED` | `SUPERSEDED` (phiên bản workflow đã đổi trước khi duyệt); mỗi workflow tối đa một đề nghị `PROPOSED` (`PWF_RESCHEDULE_PENDING_EXISTS`).

**Kỳ chấm điểm (`staff_score_period.status`).** `DRAFT` (tính lại được) → `LOCKED` (có băm, mở cửa sổ phản hồi) → `OFFICIAL` (hết cửa sổ, không còn phản hồi mở, hoặc mọi phản hồi đã xử lý). Không có đường quay lại; sửa là điều chỉnh có dòng dõi hoặc kỳ thay thế (`supersedes_period_id`).

**Điều chỉnh điểm.** `REQUESTED` → `APPROVED` | `REJECTED`; đề nghị chỉ lập được cho kỳ `LOCKED` hoặc `OFFICIAL`.

## 5. Quy tắc nghiệp vụ và công thức

Đơn vị mặc định: ngày làm việc trên lịch làm việc của tenant (`working-time.ts`); VND nguyên; phần trăm làm tròn 2 chữ số; ngày giờ Việt Nam (UTC+7). Quy tắc có căn cứ pháp lý lưu dạng dữ liệu (phiên bản có `legal_basis`, hiệu lực từ-đến); số liệu mặc định gắn `formula`, `source`, `asOf`, `legalStatus` (kiểm bởi `governance:check`).

**Lập lịch**
- **BR-PWF-01 (một ngày bắt đầu).** Ngày bắt đầu việc đầu tiên là ngày làm việc đầu tiên không trước `planned_start_date`; ngày bắt đầu dự định rơi ngày nghỉ thì dời tới ngày làm việc kế. [D-01]
- **BR-PWF-02 (mẫu đóng băng).** Dự án giữ bản sao mẫu với mã, phiên bản quy tắc và `template_hash` (SHA-256 của JSON chuẩn tắc); sửa hoặc duyệt phiên bản mẫu mới không đổi dự án đang chạy; thêm, đổi, bỏ việc của riêng dự án là ghi đè có lý do và nhật ký (`applyOverrides`). [D-01]
- **BR-PWF-03 (bốn kiểu liên kết).** Việc có thời lượng d ngày làm việc chiếm các ô s đến s+d-1 (kết thúc loại trừ e = s+d). FS: s ≥ e(tiền nhiệm) + lag; SS: s ≥ s(tiền nhiệm) + lag; FF: e ≥ e(tiền nhiệm) + lag; SF: e ≥ s(tiền nhiệm) + lag; lag âm là vượt (lead), trong ±365 ngày làm việc ở mẫu; lag là thuộc tính của liên kết. Hai việc có thể nối bằng nhiều kiểu khác nhau, không trùng (task, kind). Mốc có thời lượng 0, ngày của mốc là ngày làm việc mà tiền nhiệm của nó kết thúc; mốc không có tiền nhiệm nằm ở ngày làm việc đầu tiên. Việc không bao giờ bắt đầu trước ngày bắt đầu dự định. [D-02, D-03]
- **BR-PWF-04 (ràng buộc).** Sáu loại: không sớm hơn (SNET, FNET), không muộn hơn (SNLT, FNLT), phải bắt đầu vào (MSO), phải kết thúc vào (MFO); ràng buộc ở mẫu là số ngày làm việc kể từ ngày bắt đầu, ở dự án là ngày tuyệt đối. MSO/MFO thắng logic nhưng luôn sinh `CONSTRAINT_CONFLICT` khi logic đòi muộn hơn; SNLT/FNLT bị phá sinh `CONSTRAINT_VIOLATED` và độ trễ cho phép âm; với mốc, SNET đọc như FNET. Hạn dự án (`targetFinish`) là khái niệm riêng: không đổi lịch, chỉ làm độ trễ cho phép âm khi lịch vượt hạn. [D-04]
- **BR-PWF-05 (độ trễ cho phép và đường găng).** Lượt xuôi cho (ES, EF), lượt ngược cho (LS, LF) từ hạn dự án hoặc việc kết thúc muộn nhất. Total float = LF − EF (ô làm việc); free float = nhỏ nhất của độ rộng từng liên kết tới hậu nhiệm (FS: ES(hậu) − lag − EF; SS: ES(hậu) − lag − ES; FF: EF(hậu) − lag − EF; SF: EF(hậu) − lag − ES) và khoảng tới cuối dự án, không vượt total float. Găng khi total float ≤ ngưỡng (mặc định 0, người dùng đặt `criticalFloatDays`). Đường dài nhất là chuỗi liên kết chi phối đi ngược từ việc kết thúc muộn nhất, qua nút độ dài 0. Việc xong hoặc bị loại không có độ trễ cho phép. [D-05]
- **BR-PWF-06 (tiến độ thực).** Việc `DONE` giữ ngày bắt đầu và kết thúc thực và ràng buộc hậu nhiệm theo ngày thực; việc `IN_PROGRESS` giữ ngày bắt đầu thực, phần còn lại bắt đầu không trước ngày trạng thái và không trước khi tiền nhiệm FS kết thúc (retained logic), thời lượng còn lại lấy theo thứ tự: số nhập tay, từ % hoàn thành làm tròn lên, số ngày đã qua; việc chưa bắt đầu không được lập trước ngày trạng thái. `DONE` thiếu ngày thực: giữ ngày kế hoạch và cờ `ACTUAL_DATES_MISSING`. [D-06]
- **BR-PWF-07 (đường cơ sở).** Đường cơ sở đầu tiên của workflow chính là `project_baseline` phiên bản 1; thêm phiên bản chỉ qua quy trình đường cơ sở (người lập khác người duyệt, không ghi đè); độ lệch của việc tính theo đường cơ sở ĐẦU ở mọi chỗ tính điểm. [D-07, R28]
- **BR-PWF-08 (dời lịch không đổi cơ sở).** Tính lại phần chưa làm giữ nguyên đường cơ sở; mỗi lần dời là sự kiện có lý do và người duyệt, đếm vào KPI số lần dời hạn. [D-07]
- **BR-PWF-09 (nút độ dài 0).** Việc `CANCELLED` hoặc nhánh `EXCLUDED` không nằm trong lịch hiển thị nhưng giữ thứ tự: hậu nhiệm vẫn chịu độ trễ và loại liên kết qua nó (`P → X → S` vẫn ràng S theo P cộng lag hai chặng); không tính độ trễ cho phép; không xóa vật lý. [D-08]
- **BR-PWF-10 (lịch ghim).** Lịch làm việc ghim theo phiên bản từng năm (`PinnedCalendar`); các năm nối liền từ năm của ngày bắt đầu; năm thiếu lịch: từng việc `CALENDAR_UNAVAILABLE` kèm `missing_year`, ngày kết thúc dự án không công bố; kết quả ghi `calendar_versions`; đổi phiên bản lịch kích hoạt đề nghị dời lịch (F6), không tự đổi ngày. Dự án dài hơn tầm quét 3 năm của `addWorkingTime` được lập theo từng năm nối tiếp. [D-09]
- **BR-PWF-11 (một lịch có thẩm quyền).** Việc `kind = MILESTONE` ghi vào chính một dòng `project_milestone` (hai phía cùng đọc, `project_task.milestone_id`); `planned_start_date` lấy từ đường cơ sở hiệu lực (có thì dùng, chưa có thì tạo đường cơ sở đầu); look-ahead, EVM, IPF đọc lịch PWF qua một cổng đọc; bảng ánh xạ và test đối chiếu: số liệu trước và sau khi gắn workflow không lệch. [D-10]
- **BR-PWF-12 (giới hạn).** Mẫu: tối đa 400 việc, 12 giai đoạn, 20 liên kết mỗi việc, chuỗi dài nhất 100; lập lịch 500 việc dưới 200 ms (đo bằng `perf-budget`). [D-11]
- **BR-PWF-28 (phát hành nguyên tử).** Phát hành lịch dưới `pg_advisory_xact_lock(project)` và `If-Match` phiên bản workflow; ghi `project_schedule_version` (băm đầu vào và kết quả, phiên bản lịch làm việc, mô tả thay đổi) và cập nhật `project_task` trong một giao dịch; xung đột trả 409 `PWF_SCHEDULE_VERSION_CONFLICT`. [R32]
- **BR-PWF-29 (đọc có giới hạn).** Bảng deadline và KPI đọc trực tiếp `project_task` bằng chỉ mục (tenant, trạng thái, hạn dự báo) và (tenant, người phụ trách, hạn), phân trang theo con trỏ; tổng và số đếm theo màu là truy vấn đếm chính xác riêng; nguồn cảnh báo chỉ đưa việc trong tầm cảnh báo và báo rõ khi bị cắt; ngân sách: bảng deadline p95 ≤ 800 ms ở 1.000 dự án × 200 việc, chốt kỳ 5.000 người ≤ 20 s, có ngân sách số truy vấn. [R35]

**Workflow và cổng**
- **BR-PWF-13 (cổng giai đoạn).** Xem F7. Cổng kiểm trong cùng giao dịch của mọi lệnh và sự kiện hệ thống chuyển trạng thái, kể cả phát hành kế hoạch vốn và quyết toán; PRC-1 giữ nguyên bảng và bộ chuyển riêng. [D-12, R29]
- **BR-PWF-14 (hoàn thành việc).** Hoàn thành cần: mọi mục danh mục kiểm bắt buộc xong với bằng chứng đúng loại, mọi loại chứng từ pháp lý và biểu mẫu mẫu yêu cầu đã có, người duyệt hoàn thành (nếu có `approver_role`) khác mọi người làm; ngoại lệ đã duyệt chỉ che phần thiếu, không che quy tắc người làm khác người duyệt. [D-13]
- **BR-PWF-15 (loại chứng từ theo bản).** Mẫu khai "loại chứng từ" (mã trừu tượng); bản công phân giải tới danh mục loại chứng từ của dự án đầu tư công và lớp hồ sơ (`resolveLegalDocType`: quyết định chủ trương đầu tư, báo cáo nghiên cứu tiền khả thi và khả thi, báo cáo thẩm định, quyết định đầu tư, quyết định giao kế hoạch vốn, phê duyệt thiết kế và dự toán, kế hoạch và kết quả lựa chọn nhà thầu, hợp đồng, biên bản nghiệm thu, hồ sơ thanh toán, xác nhận kiểm soát chi của Kho bạc, biên bản bàn giao, báo cáo và quyết định phê duyệt quyết toán, báo cáo đánh giá dự án); bản doanh nghiệp đăng ký bộ phân giải riêng qua manifest; mã dùng chung không nhập mã doanh nghiệp (`edition:check`). Mã không phân giải được: `LEGAL_DOC_TYPE_UNKNOWN` khi duyệt mẫu. [D-14, R42]
- **BR-PWF-16 (nhánh có điều kiện).** Việc có `when` chỉ thuộc dự án khi mọi điều kiện đúng với dữ kiện dự án (`project_group`, `funding_source`, `project_type`); dữ kiện chưa biết không bao giờ làm điều kiện đúng; dự án đổi nhóm hoặc nguồn vốn kích hoạt đề nghị dời lịch, việc mới thêm nhánh vào có đồng hồ từ ngày hiệu lực. [D-15]
- **BR-PWF-17 (tiếp nhận).** Việc thuộc quá khứ của dự án tiếp nhận là `NOT_TRACKED` hoặc `DONE` có bằng chứng; chỉ việc có dữ kiện sau ngày hiệu lực vào KPI. [D-16, R36]
- **BR-PWF-18 (tải công việc).** Tải theo người = số việc mở và số ngày làm việc kế hoạch còn lại theo tuần, chia theo tỷ lệ phân công; chỉ hiển thị, không cân bằng tự động. [D-17]
- **BR-PWF-19 (kiểm tra chất lượng lịch).** Cờ cảnh báo cho người soạn mẫu, không chặn: việc thiếu tiền nhiệm hoặc hậu nhiệm, độ vượt (lead), ràng buộc cứng, việc dài hơn 44 ngày làm việc, độ trễ cho phép âm; ngưỡng phần trăm của DCMA để sau. [D-18]

**Hạn, màu, nhắc**
- **BR-PWF-20 (ba ngưỡng).** Với số ngày còn lại r (hạn trừ hôm nay; âm là quá hạn): `RED` khi r ≤ `red_days`; `YELLOW` khi `red_days` < r ≤ `yellow_days`; `GREEN` khi `yellow_days` < r ≤ `green_days`; `NONE` ("chưa vào tầm") khi r > `green_days`; `green_days` rỗng nghĩa là mọi r lớn hơn `yellow_days` đều `GREEN`. Ví dụ chủ sở hữu "5 ngày xanh, 2 ngày vàng, dưới 1 ngày đỏ" là 5/2/0: r = 6 → NONE, 5 và 3 → GREEN, 2 và 1 → YELLOW, 0 và -1 → RED. Thứ tự nghiêm ngặt `green_days` > `yellow_days` > `red_days` ≥ −1 (−1: chỉ đỏ khi đã quá hạn). Việc không có hạn: `NONE` (`NO_DUE`); thiếu lịch năm của đơn vị ngày làm việc: `UNKNOWN`, không đoán. Việc `DONE` hoặc `CANCELLED` không có màu. [D-20, D-26]
- **BR-PWF-21 (đơn vị theo nguồn).** Nguồn khai đơn vị: `HOME_WORK` và `REPORT_SCHEDULE` ngày lịch, `PROJECT_TASK` ngày làm việc; mặc định `HOME_WORK` 7/−1 và `REPORT_SCHEDULE` 3/−1 bằng hằng số cũ (`NEAR_DAYS` 7, `SCHEDULE_DUE_SOON_DAYS` 3) nên test trung tâm cảnh báo hiện có xanh không sửa; quy tắc có `unit` khác đơn vị của nguồn bị từ chối `DEADLINE_BAND_UNIT_MISMATCH`. [D-21, R30]
- **BR-PWF-22 (ba tầng).** Thứ tự: mặc định hệ thống → `DEADLINE_BAND_POLICY` (mã quy tắc là mã nguồn; có thể ghi đè theo `task_kind`, `priority`, `phase`, ghi đè đầu tiên khớp thắng; phạm vi tenant hoặc đơn vị, đơn vị gần nhất thắng) → tùy chọn cá nhân. Quy tắc có phiên bản, người duyệt khác người lập, hiệu lực từ ngày chọn. [D-22]
- **BR-PWF-23 (cá nhân chỉ sớm hơn; R40).** Ngưỡng cá nhân sau khi gộp phải lớn hơn hoặc bằng ngưỡng chính thức ở từng mức (`DEADLINE_PERSONAL_NOT_EARLIER` khi lưu; khi đọc, mức muộn hơn được nâng lên bằng mức chính thức và liệt kê trong `clamped`); cảnh báo chính thức, leo thang và KPI luôn theo quy tắc tenant; màn chung (bảng của quản lý, portfolio, báo cáo, KPI) chỉ hiện màu chính thức; màu cá nhân chỉ ở "Việc của tôi" và thông báo của chính người đó, có nhãn "theo cài đặt của bạn" và luôn kèm ngày hạn thật. [D-23]
- **BR-PWF-24 (nhắc nhiều mốc).** `reminder_days` giảm dần (ví dụ 5, 2, 0, −1); mỗi mốc đã vượt kể từ lần đánh giá trước kích hoạt đúng một lần theo khóa `(task, phiên bản lịch, mốc)`; `escalate_after_overdue_days` leo thang sau N ngày quá hạn theo thang leo thang có sẵn; trần số lần nhắc và ngưỡng bỏ nhắc theo bộ máy cảnh báo. [D-24]
- **BR-PWF-25 (dự báo).** `PWF_MILESTONE_AT_RISK` khi ngày dự báo của mốc (lịch hiện hành) sau hạn cơ sở của nó, hoặc khi việc găng trên đường tới mốc có độ trễ cho phép âm. [D-25]
- **BR-PWF-26 (chưa có ngày).** Việc chưa có ngày hoặc có `CALENDAR_UNAVAILABLE` hiển thị "chưa tính được hạn" kèm nguyên nhân; không bao giờ xanh. [D-26]
- **BR-PWF-27 (cảnh báo đọc trực tiếp).** Nguồn `PROJECT_TASK` đọc hạn từ `project_task`; không có `work_clock` cho từng việc; cảnh báo đóng cùng giao dịch hoàn thành, hủy, dời lịch. [D-27, R30]

**KPI và chấm điểm**
- **BR-PWF-30 (danh mục phép tính).** `DAYS_DEVIATION` (ngày hoặc ngày làm việc giữa hạn cơ sở và ngày xong thực; việc mở quá hạn lấy ngày hôm nay; `against` = `FIRST_BASELINE` mặc định; dương là trễ; ngày được miễn của tạm dừng và trì hoãn bên ngoài đã duyệt trong khoảng quá hạn bị trừ, không dưới 0), `ON_TIME_RATE` (xong trong hạn cơ sở cộng `grace_days`; việc được miễn rời cả tử và mẫu; mẫu số 0 → `NOT_APPLICABLE`), `AMOUNT_VARIANCE_PCT` ((thực − dự toán)/dự toán × 100; dự toán 0 → `NOT_APPLICABLE`), `RETURN_COUNT`, `EVIDENCE_COMPLETENESS` (bằng chứng bắt buộc đã có / bắt buộc × 100), `RESCHEDULE_COUNT` (đề nghị dời hạn đã duyệt, trừ trì hoãn bên ngoài đã duyệt). Danh mục đóng, không biểu thức tự do; thêm phép tính mới là đổi mã kernel có test. [D-30]
- **BR-PWF-31 (bộ KPI chỉ tham chiếu).** `WORKFLOW_KPI_SET` gồm `template_code` và danh sách mục `{kpi_code, operation, operation_params, applies_to, weight, scale, rag_code}`; `kpi_code` là mã `KPI_DEFINITION` (tên, đơn vị, công thức diễn giải, nút "i"), `rag_code` là mã `RAG_THRESHOLDS`, `operation` là mã danh mục kernel; không định nghĩa công thức lần hai; `governance:check` báo `GOV_REFERENCE_MISSING` khi mã không tồn tại (kiểm cả mẫu workflow: `kpi_codes`). [D-30, R37]
- **BR-PWF-32 (quy đổi điểm).** Tuyến tính: điểm = kẹp((giá trị − `worst`)/(`best` − `worst`), 0, 1) × 100, làm tròn 2 chữ số, đúng với cả hướng "càng nhỏ càng tốt"; bậc thang: `AT_MOST` (bậc đầu có giá trị ≤ bound, bound tăng dần) hoặc `AT_LEAST` (bound giảm dần), kèm `otherwise_score`. Luôn hiển thị cả giá trị gốc và điểm; không chuẩn hóa thang ngầm. Dải xếp loại có tên mã và `min_score` giảm dần, bậc cuối 0. [D-31]
- **BR-PWF-33 (điểm việc).** Điểm việc = trung bình có trọng số của các KPI áp dụng được có điểm; trọng số chia lại; không còn KPI nào → điểm việc rỗng, nêu lý do từng mục bị loại. Tổng trọng số dương, kiểm khi duyệt. [D-32]
- **BR-PWF-34 (sổ phân công và tỷ lệ).** `project_task_assignment` chỉ thêm: người, vai R/A/C/I, khoảng từ-đến, tỷ lệ đóng góp 1 đến 100; tổng tỷ lệ của các người cùng vai đồng thời không quá 100 (`PWF_ASSIGNMENT_INVALID`); phần của một người trên một việc = (số ngày của khoảng phân công trùng cửa sổ việc / số ngày cửa sổ việc) × tỷ lệ/100 × hệ số vai (`role_factors`: R 1, A 0,5, C 0,2, I 0 mặc định); trọng số hiệu dụng = trọng số ưu tiên (`priority_weights`: thấp 0,5, thường 1, cao 1,5, găng 2) × số ngày làm việc kế hoạch (khi `weight_by_planned_days`) × phần của người; đổi người giữa chừng chia theo khoảng. [D-33, R34]
- **BR-PWF-35 (miễn trễ).** Chỉ `PAUSE` và `EXTERNAL_DELAY` đã được người khác người đề nghị duyệt mới là khoảng được miễn; việc chuyển người phụ trách không tạo khoảng miễn. [D-34]
- **BR-PWF-36 (điểm người và mẫu nhỏ).** Điểm người = Σ(trọng số hiệu dụng × điểm việc) / Σ(trọng số hiệu dụng) trên việc `RATED`; việc hủy có duyệt, được miễn, chưa bắt đầu rời mẫu số; mẫu số 0 → `NOT_RATED` (không bao giờ NaN); số việc xếp loại < `min_rated_tasks` hoặc tổng trọng số < `min_effective_weight` → `SMALL_SAMPLE`: có điểm và số thô, không xếp loại, không so sánh xếp hạng giữa người có mẫu chênh nhau. [D-35]
- **BR-PWF-37 (chống thao túng).** Đường cơ sở đóng băng khi bắt đầu việc; việc không xóa vật lý; việc hủy không được duyệt tính 0 điểm (`cancelled_unapproved` = `COUNT_AS_MISSED`) hoặc bỏ qua theo chính sách; trọng số theo số ngày kế hoạch nên tách việc không làm đẹp tỷ lệ; KPI đối trọng nhau (đúng hạn, số lần trả lại, độ đủ chứng từ, số lần dời); `gamingSignals` sinh cờ `CANCELLED_SHARE_HIGH`, `TASKS_SPLIT_AFTER_BASELINE`, `BASELINE_REVISED_IN_PERIOD`, `ASSIGNEE_CHANGED_NEAR_DUE` cho người rà soát; cờ không đổi điểm. [D-36, R34]
- **BR-PWF-38 (điều chỉnh).** `|điểm| ≤ max_adjustment_points`, lý do ≥ `min_reason_length`, người duyệt khác người đề nghị, khác người được chấm, người đề nghị khác người được chấm; điểm sau = kẹp(0..100); giữ cả điểm tính và điểm điều chỉnh; người được chấm thấy mọi điều chỉnh. [D-37]
- **BR-PWF-39 (chốt kỳ và chính thức).** Kỳ chốt có `snapshot_hash` = SHA-256 JSON chuẩn tắc của ảnh chụp; tính lại từ ảnh chụp cho cùng băm; kỳ `OFFICIAL` khi hết cửa sổ phản hồi và không còn phản hồi mở, hoặc có phản hồi và mọi phản hồi đã xử lý; phản hồi xử lý qua ADM có đồng hồ và cảnh báo; xem xét ở cấp cao hơn khi bất đồng. [D-38, R43]
- **BR-PWF-40 (riêng tư, ba vai).** (1) Người được đánh giá: điểm của mình; (2) quản lý trực tiếp: đơn vị tại thời điểm của kỳ (chuyển đơn vị, thu hồi quyền: quản lý cũ mất quyền với kỳ sau); (3) nhân sự: toàn tenant. Thi hành ở tầng cơ sở dữ liệu (chính sách theo chủ thể và phạm vi) lẫn API; truy sâu và xuất tệp kiểm lại quyền trên tài liệu nguồn; mọi lần xem của người khác và mọi lần xuất ghi ADM-11; người ngoài quyền nhận 404; điện thoại không lưu đệm bảng điểm của người khác và xóa đệm khi phiên bản quyền đổi. [D-39, R33]
- **BR-PWF-41 (điểm chỉ hỗ trợ).** Không có đường mã nào từ điểm hoặc xếp loại tới thưởng, kỷ luật, chấm dứt hợp đồng; mọi màn điểm ghi "căn cứ hỗ trợ, quyết định thuộc người có thẩm quyền"; điểm không thay thế đánh giá cán bộ theo Nghị định 90/2020/NĐ-CP `[CXN-PWF-01]`. [D-40]
- **BR-PWF-42 (thu thập tối thiểu và lưu trữ).** Chỉ dữ kiện sự kiện workflow; không thu thập hoạt động bàn phím, vị trí, thời gian trực tuyến; `retention_months` (mặc định 60, UNVERIFIED): hết hạn thì xóa hoặc ẩn danh dữ liệu cá nhân gắn khóa có thể xóa, giữ băm và số tổng hợp ẩn danh; đánh giá tác động dữ liệu cá nhân trước khi bật cho tenant. [D-41]

**Mẫu số 0 và trường hợp biên.** Mọi phép chia kiểm mẫu số 0 (`NOT_APPLICABLE`, `NOT_RATED`); điểm luôn trong 0 đến 100; hai KPI cùng mã trong một bộ bị từ chối; lịch rỗng không lặp vô hạn.

## 6. Dữ liệu

Khối migration **PWF-1: 3000–3019** (workflow, lịch, deadline, nhắc; PWF-2 dùng chung khối) và **PWF-3: 3020–3039** (KPI và điểm), đăng ký bằng `node scripts/contract-patch.mjs register-block`. Mọi bảng: `tenant_id`, RLS `tenant_access` FORCE, `created_at/by`, `updated_at/by`, `version` (If-Match) nếu sửa được. Phân loại: nội bộ; riêng bảng điểm: cá nhân (nhạy cảm).

**PWF-1 (V3000 đến V3019).**
- `project` (mở rộng rồi thu): `planned_start_date date NULL` (V3000, expand-contract; lấy từ đường cơ sở hiệu lực khi có, BR-PWF-11).
- `project_workflow` (mới): id, project_id (duy nhất), template_code, template_rule_id, template_rule_version, template_hash, template (jsonb đóng băng), facts (jsonb: project_group, funding_source, project_type), planned_start_date, status (ACTIVE | ON_HOLD | COMPLETED | CANCELLED), schedule_version (int, If-Match), baseline_id (FK `project_baseline`), calendar_pins (jsonb: năm → phiên bản), adopted_on (date NULL), created_by. Chỉ mục (tenant, project_id).
- `project_task` (mới): id, workflow_id, project_id, task_code, name, phase_code, kind, required, responsible_role, approver_role, priority, duration_working_days, status, excluded (bool), tracked (bool, false khi `NOT_TRACKED`), planned_start, planned_finish (dự báo hiện hành), baseline_start, baseline_finish (đường cơ sở đầu), late_start, late_finish, total_float, free_float, critical, state (SCHEDULED | COMPLETED | PASS_THROUGH | CALENDAR_UNAVAILABLE), missing_year, actual_start, actual_finish, remaining_working_days, percent_complete, return_count, reschedule_count, estimate_vnd, actual_vnd (số nguyên), milestone_id (FK `project_milestone`, NULL nếu không phải mốc), due_band (cache, không là nguồn sự thật), created_by. UNIQUE (workflow_id, task_code); chỉ mục (tenant, status, planned_finish), (tenant, assignee, planned_finish) qua `project_task_assignment`; CHECK mốc có `duration_working_days = 0`.
- `project_task_dependency` (mới, chỉ đọc sau khởi tạo trừ ghi đè): task_id, predecessor_id, kind, lag_working_days, `lag_unit` (WORKING_DAYS, chừa chỗ cho CALENDAR_DAYS, D-03); UNIQUE (task_id, predecessor_id, kind); kiểm không vòng lặp ở ứng dụng và trigger.
- `project_task_checklist_item` (mới): task_id, item_code, required, evidence_kinds, done, done_by, done_at.
- `project_task_evidence` (mới, chỉ thêm): id, task_id, item_code NULL, evidence_kind, document_id NULL, legal_doc_type NULL, form_template_code NULL, external_ref, note, attached_by, attached_at.
- `project_task_assignment` (mới, chỉ thêm; R34): id, task_id, membership_id, role (RESPONSIBLE | ACCOUNTABLE | CONSULTED | INFORMED), valid_from, valid_to NULL, share_pct (1..100), reason, assigned_by, approved_by NULL; EXCLUDE chồng khoảng cùng (task, người, vai); kiểm tổng tỷ lệ ≤ 100.
- `project_task_exception` (mới): id, task_id, kind (WAIVE_REQUIREMENT | CANCEL_TASK | PAUSE | EXTERNAL_DELAY), items (jsonb), valid_from, valid_to NULL, reason, evidence_ref, status (REQUESTED | APPROVED | REJECTED | USED), requested_by, decided_by, decided_at, decision_note; CHECK `decided_by <> requested_by`.
- `project_task_log` (mới, chỉ thêm): id, workflow_id, task_id NULL, kind (START, COMPLETE_REQUESTED, APPROVED, RETURNED, PAUSE_APPROVED, RESUMED, CANCELLED, EXCEPTION, RESCHEDULED, GATE_CHECKED, ASSIGNED, ADOPTED, ...), at, actor, reason, subject (jsonb).
- `project_schedule_version` (mới, chỉ thêm): id, workflow_id, version, input_hash, result_hash, calendar_versions (jsonb), critical_path (jsonb), changes (jsonb), reason, proposed_by, approved_by, published_at.
- `project_reschedule_proposal` (mới; tiền lệ `project_reschedule_event`): id, workflow_id, status, base_version, input (jsonb), preview (jsonb), reason, proposed_by, decided_by, decided_at.
- `project_task_baseline` (mới, chỉ thêm): baseline_id, task_id, start, finish (một dòng mỗi việc mỗi phiên bản đường cơ sở).
- `project_task_reminder` (mới, chỉ thêm): task_id, schedule_version, reminder_day, fired_at; UNIQUE (task_id, schedule_version, reminder_day) — khóa chống nhắc trùng.
- `alert_notification_profile` (mở rộng): `deadline_green_days`, `deadline_yellow_days`, `deadline_red_days` NULL, `personal_reminder_days` int[]; ràng buộc CHECK thứ tự.
- Chỉ mục, RLS, chính sách (V3007); khóa ngoại tới `project`, `membership`, `project_milestone`, `project_baseline`.

**PWF-3 (V3020 đến V3039).**
- `task_kpi_result` (mới, bất biến): id, task_id, kpi_code, operation, kpi_set_rule_id, kpi_set_version, state, value (numeric), score (numeric 0..100 NULL), weight, inputs_hash, inputs (jsonb), computed_at; không UPDATE/DELETE (trigger); bản thay thế là dòng mới `supersedes_id`.
- `staff_score_period` (mới): id, scope_unit_id, period_kind, period_from, period_to, status (DRAFT | LOCKED | OFFICIAL), policy_rule_id, policy_version, snapshot (jsonb), snapshot_hash, locked_by, locked_at, response_until, official_at, supersedes_period_id; UNIQUE (tenant, scope_unit_id, period_from, period_to) trừ kỳ thay thế.
- `staff_score_line` (mới): id, period_id, membership_id, unit_id_at_period (đơn vị tại thời điểm kỳ), score_computed, score_adjusted, rating, state (RATED | NOT_RATED | SMALL_SAMPLE), rated_task_count, effective_weight, contributions (jsonb), excluded (jsonb), flags (jsonb). RLS theo chủ thể và phạm vi (V3023): chính người đó, hoặc quản lý có scope trên `unit_id_at_period`, hoặc quyền `staff_score.read_hr`.
- `staff_score_adjustment` (mới): id, line_id, points, reason, evidence_ref, status, requested_by, decided_by, decided_at; CHECK `requested_by <> decided_by`.
- `staff_score_response` (mới): id, line_id, body, status (OPEN | HANDLED), submitted_at, handled_by, handled_at, approval_instance_id (ADM).
- Chính sách lưu trữ (V3024): job xóa hoặc ẩn danh theo `retention_months`.
- Nhật ký xem: dùng ADM-11 sẵn có, không bảng riêng.

**Bất biến DB (tóm tắt).** `project_task_log`, `project_task_evidence`, `project_task_assignment`, `project_schedule_version`, `project_task_baseline`, `task_kpi_result` chỉ thêm (trigger chặn UPDATE/DELETE); `decided_by <> requested_by` ở bảng ngoại lệ và điều chỉnh; một workflow mỗi dự án; một đề nghị dời lịch `PROPOSED` mỗi workflow (UNIQUE một phần); mốc ghi vào đúng một `project_milestone`.

**Quy tắc (rule types, kho quy tắc ADM).** Cả bốn có người soạn khác người duyệt, hiệu lực theo ngày, `legalStatus: UNVERIFIED` cho giá trị mặc định kèm `formula`, `source`, `asOf` (kiểm bởi `governance:check`):

| Loại | Mã | Tham số chính | Mặc định |
|---|---|---|---|
| `PROJECT_WORKFLOW_TEMPLATE` | loại dự án | `name`, `project_type`, `phases[{code, name, gates[]}]`, `tasks[{code, name, phase, kind, duration_working_days, required, responsible_role, approver_role, priority, predecessors[{task, kind, lag_working_days}], constraint{kind, offset_working_days}, legal_doc_types[], form_templates[], checklist[{code, name, required, evidence_kinds[]}], kpi_codes[], when[{field, in[]}]}]` | `PUBLIC_INVESTMENT` (đầu tư công xây dựng, 34 việc, rẽ nhánh QTQG/A/B/C và nguồn vốn), `PUBLIC_PROCUREMENT` (mua sắm tài sản, 19 việc), `PUBLIC_REPAIR` (sửa chữa lớn, 17 việc) |
| `DEADLINE_BAND_POLICY` | mã nguồn (`HOME_WORK`, `REPORT_SCHEDULE`, `PROJECT_TASK`) | `unit`, `green_days?`, `yellow_days`, `red_days`, `overrides[{match{task_kind, priority, phase}, ...}]`, `reminder_days[]`, `escalate_after_overdue_days?` | 7/−1 ngày lịch; 3/−1 ngày lịch; 5/2/0 ngày làm việc, nhắc 5, 2, 0, −1, leo thang sau 3 ngày |
| `WORKFLOW_KPI_SET` | mã bộ | `template_code`, `items[{kpi_code, operation, operation_params, applies_to, weight, scale, rag_code}]` | `DEFAULT_PROJECT_WORKFLOW`: sáu KPI, trọng số 40/25/10/10/10/5 |
| `STAFF_SCORING_POLICY` | mã chính sách | `period_kind`, `role_factors`, `priority_weights`, `weight_by_planned_days`, `cancelled_unapproved`, `min_rated_tasks`, `min_effective_weight`, `bands[]`, `calibration{max_adjustment_points, min_reason_length, requires_second_approver}`, `response_window_days`, `retention_months` | Quý; 1/0,5/0,2/0; 0,5/1/1,5/2; 5 việc, 3 trọng số; EXCELLENT 90, GOOD 75, FAIR 60, WEAK 0; 10 điểm; 10 ngày; 60 tháng |

Mã KPI mặc định đăng ký trong `KPI_DEFINITION`: `PWF_TASK_DEVIATION_DAYS`, `PWF_ON_TIME_RATE`, `PWF_AMOUNT_VARIANCE_PCT`, `PWF_RETURN_COUNT`, `PWF_EVIDENCE_COMPLETENESS`, `PWF_RESCHEDULE_COUNT`; ngưỡng điểm `PWF_SCORE` trong `RAG_THRESHOLDS` (xanh từ 80, vàng từ 60).

**Loại cảnh báo (`ALERT_TYPE`, nguồn `PROJECT_TASK`; đã đăng ký trong kernel).** `PWF_TASK_DUE_SOON` (WATCH, chủ: người được giao, 24 giờ), `PWF_TASK_OVERDUE` (ACTION, người được giao, 24 giờ), `PWF_MILESTONE_AT_RISK` (ACTION, quản lý dự án, 48 giờ); mỗi loại có chủ, hành động, hậu quả, giờ phản hồi, lý do tồn tại và ngày rà soát. Đăng ký thêm ở làn pwf3: `PWF_SCORE_RESPONSE_OPEN` (phản hồi điểm chờ xử lý) và `PWF_RESCHEDULE_PENDING` (đề nghị dời lịch chờ duyệt).

## 7. API / command

Tất cả đăng ký bằng `node scripts/contract-patch.mjs`; tag `PWF`; lệnh ghi cần `Idempotency-Key`, sửa tài nguyên có phiên bản cần `If-Match`. Rà soát GET scaffold: mọi tài nguyên PWF dùng DTO riêng có mask theo scope (`x-read-model`), không có endpoint ghi chung cho trạng thái, số tiền đã chốt, vai hay tenant; bảng điểm không expose qua GET scaffold.

| operationId | Method path | Quyền (x-permission) | Request / Response | Lỗi (code) | Idempotency | If-Match |
|---|---|---|---|---|---|---|
| `validateProjectWorkflowTemplate` | POST /project-workflow/templates/validate | pwf.template.manage | `PwfTemplateParams` → `PwfTemplateValidation` (findings, quality flags) | `VALIDATION_FAILED` | không (đọc tính) | không |
| `previewProjectWorkflowTemplate` | POST /project-workflow/templates/preview | pwf.template.manage | `PwfTemplatePreviewRequest` (params, planned_start_date, facts) → `PwfSchedulePreview` | `PWF_SCHEDULE_INVALID`, `PWF_DEPENDENCY_CYCLE`, `CALENDAR_NOT_EFFECTIVE` | không | không |
| `startProjectWorkflow` | POST /projects/{project_id}/workflow | pwf.workflow.manage | `PwfWorkflowStart` → `CommandResult` | `PWF_WORKFLOW_EXISTS`, `PWF_TEMPLATE_NOT_FOUND`, `PWF_FACTS_REQUIRED`, `SCOPE_DENIED` | có | không |
| `adoptProjectWorkflow` | POST /projects/{project_id}/workflow/adopt | pwf.workflow.adopt | `PwfWorkflowAdopt` (effective_date, dry_run, past_tasks[]) → `PwfAdoptResult` | `PWF_WORKFLOW_EXISTS`, `PWF_ADOPT_INVALID` | có | không |
| `getProjectWorkflow` | GET /projects/{project_id}/workflow | pwf.read | `PwfWorkflowDetail` (giai đoạn, việc, màu chính thức, cổng) | 404 | không | không |
| `listProjectTasks` | GET /projects/{project_id}/workflow/tasks | pwf.read | `PwfTaskPage` (lọc giai đoạn, màu, người, trạng thái; con trỏ) | — | không | không |
| `getProjectSchedule` | GET /projects/{project_id}/workflow/schedule | pwf.read | `PwfSchedule` (ngày, độ trễ cho phép, đường găng, phiên bản lịch làm việc, cờ) | — | không | không |
| `evaluateProjectGate` | GET /projects/{project_id}/workflow/gates/{target} | pwf.read | `PwfGateAssessment` | — | không | không |
| `getProjectTask` | GET /project-tasks/{task_id} | pwf.read | `PwfTaskDetail` (chứng từ, biểu mẫu, danh mục kiểm, lịch sử, ngoại lệ, sổ phân công, KPI nếu có quyền) | 404 | không | không |
| `startProjectTask` | POST /project-tasks/{task_id}/start | pwf.task.work | `PwfTaskStart` → `CommandResult` | `PWF_TASK_STATE_INVALID`, `VERSION_CONFLICT` | có | có |
| `attachProjectTaskEvidence` | POST /project-tasks/{task_id}/evidence | pwf.task.work | `PwfEvidenceInput` → `CommandResult` | `PWF_TASK_STATE_INVALID`, `LEGAL_DOC_TYPE_UNKNOWN` | có | không |
| `completeProjectTaskChecklistItem` | POST /project-tasks/{task_id}/checklist/{item_code}/complete | pwf.task.work | `PwfChecklistComplete` → `CommandResult` | `PWF_TASK_STATE_INVALID` | có | có |
| `completeProjectTask` | POST /project-tasks/{task_id}/complete | pwf.task.work | `PwfTaskComplete` → `CommandResult` | `PWF_TASK_COMPLETION_BLOCKED` (kèm `blockers`), `PWF_TASK_STATE_INVALID`, `VERSION_CONFLICT` | có | có |
| `approveProjectTaskCompletion` | POST /project-tasks/{task_id}/approve-completion | pwf.task.approve | `PwfDecisionInput` → `CommandResult` | `SELF_APPROVAL_DENIED`, `MAKER_IS_APPROVER`, `PWF_TASK_STATE_INVALID` | có | có |
| `returnProjectTask` | POST /project-tasks/{task_id}/return | pwf.task.approve | `PwfReturnInput` (reason) → `CommandResult` | `PWF_TASK_STATE_INVALID`, `VALIDATION_FAILED` | có | có |
| `requestProjectTaskException` | POST /project-tasks/{task_id}/exceptions | pwf.task.work | `PwfExceptionRequest` (kind, items, valid_from, valid_to, reason, evidence_ref) → `CommandResult` | `PWF_EXCEPTION_INVALID`, `PWF_TASK_STATE_INVALID` | có | không |
| `decideProjectTaskException` | POST /project-task-exceptions/{id}/decide | pwf.task.approve | `PwfDecisionInput` → `CommandResult` | `SELF_APPROVAL_DENIED`, `PWF_EXCEPTION_INVALID` | có | có |
| `resumeProjectTask` | POST /project-tasks/{task_id}/resume | pwf.task.work | → `CommandResult` | `PWF_TASK_STATE_INVALID` | có | có |
| `assignProjectTask` | POST /project-tasks/{task_id}/assignments | pwf.task.assign | `PwfAssignmentInput` (membership_id, role, valid_from, valid_to, share_pct, reason) → `CommandResult` | `PWF_ASSIGNMENT_INVALID`, `SCOPE_DENIED` | có | không |
| `listProjectTaskAssignments` | GET /project-tasks/{task_id}/assignments | pwf.read | `PwfAssignmentPage` | — | không | không |
| `proposeProjectReschedule` | POST /projects/{project_id}/workflow/reschedules | pwf.schedule.propose | `PwfRescheduleRequest` (planned_start_date?, progress, overrides, reason) → `PwfReschedulePreview` | `PWF_RESCHEDULE_PENDING_EXISTS`, `PWF_SCHEDULE_INVALID`, `PWF_DEPENDENCY_CYCLE` | có | có |
| `decideProjectReschedule` | POST /project-reschedules/{id}/decide | pwf.schedule.approve | `PwfDecisionInput` → `CommandResult` | `SELF_APPROVAL_DENIED`, `PWF_SCHEDULE_VERSION_CONFLICT`, `CALENDAR_NOT_EFFECTIVE` | có | có |
| `getDeadlineBoard` | GET /pwf/deadlines | pwf.read | `PwfDeadlineBoard` (hàng + tổng chính xác theo màu, `shown`/`total`, cờ bị cắt); chỉ màu chính thức | — | không | không |
| `getDeadlineCalendar` | GET /pwf/deadlines/calendar | pwf.read | `PwfDeadlineCalendar` (tháng) | — | không | không |
| `getUpcomingMilestones` | GET /pwf/milestones/upcoming | pwf.read | `PwfMilestoneList` (30 ngày tới) | — | không | không |
| `getProjectWorkload` | GET /pwf/workload | pwf.read | `PwfWorkload` (theo người, tuần) | — | không | không |
| `getMyTasks` | GET /me/project-tasks | pwf.task.work | `PwfMyTaskPage` (màu chính thức và màu cá nhân kèm nhãn, ngày hạn thật) | — | không | không |
| `getDeadlinePreference` | GET /me/deadline-preference | pwf.preference.own | `PwfDeadlinePreference` | — | không | không |
| `setDeadlinePreference` | PUT /me/deadline-preference | pwf.preference.own | `PwfDeadlinePreference` → `CommandResult` | `DEADLINE_BAND_THRESHOLDS_INVALID`, `DEADLINE_PERSONAL_NOT_EARLIER`, `VERSION_CONFLICT` | có | có |
| `previewDeadlineBand` | GET /pwf/deadline-band/preview | pwf.read | `PwfBandPreview` (ví dụ "còn 5 ngày: xanh") | `DEADLINE_BAND_THRESHOLDS_INVALID` | không | không |
| `getKpiOperations` | GET /pwf/kpi-operations | pwf.read | `PwfKpiOperationList` (danh mục, đơn vị, hướng tốt, dữ kiện cần) | — | không | không |
| `listTaskKpiResults` | GET /project-tasks/{task_id}/kpi-results | pwf.read | `PwfKpiResultPage` (nút "i": công thức, nguồn, dữ kiện) | — | không | không |
| `computeStaffScorePeriod` | POST /staff-score-periods | staff_score.manage | `StaffScorePeriodRequest` (scope_unit_id, period_from, period_to, policy_code) → `StaffScorePeriodPreview` (DRAFT) | `STAFF_SCORE_PERIOD_OVERLAP`, `STAFF_SCORE_SHARE_INVALID`, `CALENDAR_NOT_EFFECTIVE` | có | không |
| `lockStaffScorePeriod` | POST /staff-score-periods/{id}/lock | staff_score.manage | → `CommandResult` | `STAFF_SCORE_PERIOD_LOCKED`, `VERSION_CONFLICT` | có | có |
| `listStaffScorePeriods` | GET /staff-score-periods | staff_score.read_unit | `StaffScorePeriodPage` | — | không | không |
| `getStaffScorePeriod` | GET /staff-score-periods/{id} | staff_score.read_unit | `StaffScorePeriod` | 404 | không | không |
| `listStaffScoreLines` | GET /staff-score-periods/{id}/lines | staff_score.read_unit | `StaffScoreLinePage` (chỉ trong scope; ghi ADM-11) | — | không | không |
| `getMyStaffScore` | GET /me/staff-scores | staff_score.read_own | `MyStaffScorePage` (điểm, phân rã, điều chỉnh, phản hồi) | — | không | không |
| `getStaffScoreLine` | GET /staff-score-lines/{id} | staff_score.read_own hoặc read_unit hoặc read_hr | `StaffScoreLine` (phân rã tới việc và dữ kiện; ghi ADM-11 khi người khác xem) | 404 | không | không |
| `compareStaffScoreLines` | GET /staff-score-lines/compare | staff_score.read_own hoặc read_unit | `StaffScoreComparison` (so sánh kỳ của cùng người; không xếp hạng chéo mẫu chênh) | — | không | không |
| `exportStaffScorePeriod` | GET /staff-score-periods/{id}/export | staff_score.export | tệp Excel; kiểm lại quyền trên tài liệu nguồn; ghi ADM-11 | `SCOPE_DENIED` | không | không |
| `listStaffScoreSignals` | GET /staff-score-periods/{id}/signals | staff_score.review | `StaffScoreSignalPage` (cờ thao túng) | — | không | không |
| `requestStaffScoreAdjustment` | POST /staff-score-lines/{id}/adjustments | staff_score.adjust | `StaffScoreAdjustmentRequest` (points, reason, evidence_ref) → `CommandResult` | `STAFF_SCORE_ADJUSTMENT_INVALID`, `STAFF_SCORE_PERIOD_LOCKED` | có | không |
| `decideStaffScoreAdjustment` | POST /staff-score-adjustments/{id}/decide | staff_score.approve | `PwfDecisionInput` → `CommandResult` | `STAFF_SCORE_ADJUSTMENT_INVALID`, `SELF_APPROVAL_DENIED` | có | có |
| `submitStaffScoreResponse` | POST /staff-score-lines/{id}/responses | staff_score.read_own | `StaffScoreResponseInput` → `CommandResult` | `STAFF_SCORE_RESPONSE_WINDOW_CLOSED`, `VALIDATION_FAILED` | có | không |
| `handleStaffScoreResponse` | POST /staff-score-responses/{id}/handle | staff_score.approve | `StaffScoreResponseHandle` (kết luận, giữ hay điều chỉnh) → `CommandResult` | `SELF_APPROVAL_DENIED` | có | có |
| `officializeStaffScorePeriod` | POST /staff-score-periods/{id}/officialize | staff_score.manage (hoặc job) | → `CommandResult` | `STAFF_SCORE_PERIOD_LOCKED` | có | có |

Cổng nội bộ (không phải REST): `ProjectWorkflowGate.assert(tx, project, target)` cho `prj-stage-store` và consumer sự kiện hệ thống; `ProjectScheduleReadPort` cho look-ahead, EVM, IPF; `LegalDocTypeResolver` theo bản.

## 8. UI/UX

Tuân thủ mockup (D-B11): dùng đúng họ thành phần và token; chuỗi qua khóa i18n (parts); 7 trạng thái chuẩn (rỗng, đang tải, lỗi, ngoại tuyến, không quyền, một phần, quá hạn dữ liệu) + trạng thái riêng của PWF: "chưa tính được hạn, thiếu lịch năm N", "mẫu chưa xác nhận". Màu đỏ/vàng/xanh luôn kèm chữ và biểu tượng (trợ năng), không chỉ màu. Mọi con số có nút "i" (công thức, nguồn, ngày, phiên bản quy tắc).

**Web (module PWF, mã màn đăng ký bằng `contract-patch add-screen`, đánh số tiếp PWF-01...).**

| ID | Màn | Kiểu | Ghi chú |
|---|---|---|---|
| PWF-01 | Thư viện mẫu workflow | table | Mẫu theo loại dự án, phiên bản, trạng thái, cờ chưa kiểm chứng, so sánh hai phiên bản |
| PWF-02 | Soạn mẫu workflow | form | Dựng trên trình soạn quy tắc `apps/web/src/screens/adm/governance` và mẫu BID-31: giai đoạn, cây việc, liên kết (bốn kiểu, lag), nhánh, chứng từ theo loại, biểu mẫu, danh mục kiểm, KPI; kiểm lỗi trực tiếp, xem trước lịch |
| PWF-03 | Workflow của dự án (tab trong PRJ-03) | detail | Tái dùng `ProcessTree`, `Timeline`, `DayStrip`, `Stepper`: cây tiến trình, Gantt có đường găng và đường cơ sở, bảng cột theo giai đoạn, cổng của lệnh PRJ, nút mô phỏng "nếu dời ngày bắt đầu" |
| PWF-04 | Chi tiết công việc | detail | Chứng từ, biểu mẫu sinh từ mẫu, danh mục kiểm, ngoại lệ, tạm dừng, sổ phân công, lịch sử, KPI của việc |
| PWF-05 | Khởi tạo và tiếp nhận workflow | form | Chọn mẫu, ngày bắt đầu, dữ kiện nhánh; tiếp nhận với ngày hiệu lực, chạy thử, nhập hàng loạt |
| PWF-06 | Xem trước và duyệt dời lịch | detail | So sánh lịch trước/sau theo ngày làm việc, thay đổi độ trễ cho phép và đường găng, độ lệch cơ sở; duyệt, trả |
| PWF-07 | Bảng deadline toàn danh mục | dashboard | Lọc theo màu, giai đoạn, người, đơn vị; lịch tháng; mốc 30 ngày tới; tải công việc theo người; chỉ màu chính thức; "đang hiện N trên M" |
| PWF-08 | Chính sách ba màu | form | Soạn `DEADLINE_BAND_POLICY` có xem trước "còn 5 ngày: xanh, còn 2 ngày: vàng, dưới 1 ngày: đỏ", đơn vị theo nguồn |
| PWF-09 | Bộ KPI workflow | form | Soạn `WORKFLOW_KPI_SET`: chọn phép tính từ danh mục, tham số, thang điểm có xem trước đường quy đổi, trọng số, tham chiếu mã KPI |
| PWF-10 | Chính sách chấm điểm | form | Soạn `STAFF_SCORING_POLICY`: kỳ, hệ số vai, trọng số ưu tiên, mẫu nhỏ, dải xếp loại, biên độ điều chỉnh, cửa sổ phản hồi, lưu trữ |
| PWF-11 | Bảng điểm của tôi | dashboard | Điểm kỳ, xếp loại hoặc "chưa đủ dữ liệu", phân rã, nút "i", so sánh kỳ, điều chỉnh, phản hồi |
| PWF-12 | Bảng điểm đơn vị | table | Cho quản lý và nhân sự trong scope; xuất Excel; không xếp hạng chéo mẫu chênh |
| PWF-13 | Chi tiết điểm | detail | Truy tới từng việc, dữ kiện, khoảng phân công, phép loại trừ, cờ; đề nghị điều chỉnh |
| PWF-14 | Kỳ chấm điểm | detail | Tính nháp, chốt kỳ, cửa sổ phản hồi, phản hồi chờ xử lý, chính thức hóa, tín hiệu thao túng cho người rà soát |
| PWF-15 | Nhắc hạn của tôi | form | Ngưỡng cá nhân (chỉ sớm hơn), mốc nhắc, xem trước; cảnh báo khi ngưỡng bị nâng bằng mức chính thức |
| PWF-16 | Sổ phân công | table | Khoảng thời gian, vai, tỷ lệ của một việc; thêm phân công; chồng khoảng bị chặn |

**Điện thoại (module MOB, tiếp MOB-78...).** MOB-78 Workflow dự án (dải giai đoạn, danh sách việc theo màu hạn); MOB-79 Chi tiết việc (nộp chứng từ, hoàn thành, xin dời hạn); MOB-80 Việc của tôi theo hạn (màu cá nhân có nhãn "theo cài đặt của bạn" kèm ngày hạn thật); MOB-81 Điểm KPI của tôi (chỉ của mình, không lưu đệm của người khác); MOB-82 Cài đặt nhắc hạn cá nhân. Dựng bằng bộ thành phần MUX-1; lệnh ngoại tuyến kiểm phiên bản.

**Quyền thao tác.** Nút theo quyền và trạng thái (`can_*` do máy chủ trả); lệnh bị từ chối vì cổng hiển thị danh sách việc còn thiếu, có đường dẫn tới từng việc. Khác biệt web/điện thoại: điện thoại không soạn mẫu, không soạn quy tắc, không xem bảng điểm người khác.

## 9. Sự kiện, job, tích hợp, quan sát

- **Domain event** (outbox, v1): `pwf.workflow.started`, `pwf.workflow.adopted` (id, project_id, template_code, template_hash, schedule_version); `pwf.task.started`, `completed`, `approved`, `returned`, `cancelled`, `paused`, `resumed`; `pwf.task.exception.requested`, `decided`; `pwf.schedule.published` (workflow_id, version, project_finish, result_hash); `pwf.reschedule.proposed`, `decided`; `pwf.gate.refused` (project_id, target, missing[] mã việc); `pwf.score.period.locked`, `officialized`; `pwf.score.adjustment.decided`; `pwf.score.response.submitted`, `handled`. Payload không có điểm của người, tên hay lý do; chỉ id, mã, số ngày.
- **Consumer.** PRJ (cổng, trong giao dịch của lệnh, không qua sự kiện); HOME (nguồn `PROJECT_TASK` đọc trực tiếp); EVM và look-ahead qua `ProjectScheduleReadPort`; BI (chỉ tiêu số việc găng, tỷ lệ đúng hạn ở mức tổng hợp ẩn danh).
- **Job.** Tính lại lịch tăng dần khi hoàn thành, đổi tiến độ hoặc đổi lịch làm việc (≤ 200 ms cho 500 việc); sinh `task_kpi_result` khi việc xong, hủy, quá hạn; nhắc nhiều mốc và leo thang mỗi ngày (khóa chống trùng); chốt kỳ theo lịch (≤ 20 s cho 5.000 người); chính thức hóa kỳ; xóa hoặc ẩn danh theo `retention_months`; nhập hàng loạt tiếp nhận.
- **Cache key** có tenant; bảng điểm không đệm ở máy khách của người khác.
- **Quan sát.** Metric: `pwf_schedule_ms`, `pwf_schedule_calendar_unavailable_total`, `pwf_gate_refused_total`, `pwf_deadline_board_ms`, `pwf_score_period_ms`; log không chứa điểm, lý do hay tên người; ngân sách hiệu năng ở `docs/qa/perf-budget.json` (đo lại trước cổng).
- **Cảnh báo vận hành.** Năm không có lịch làm việc trong tầm dự án; công việc không có người phụ trách; đề nghị dời lịch chờ quá hạn; phản hồi điểm chờ quá hạn.

## 10. Kiểm thử

Bảng test: `ID | Loại | Ưu tiên | Setup | Input | Bước | Expected | Bằng chứng`. Dữ liệu synthetic. Lõi thuần đã có test (số liệu ở báo cáo của làn); các ca dưới là phần còn lại của đặc tả và UAT.

| ID | Loại | Ưu | Setup | Bước và Expected | Bằng chứng |
|---|---|---|---|---|---|
| T-PWF-01 | domain | P0 | Mẫu `PUBLIC_INVESTMENT`, lịch 2026 có ngày nghỉ | `scheduleProject` từ 2026-11-02: ngày từng việc, mốc, đường găng đúng bảng giá trị tay; đổi sang nhóm C: nhánh bị loại giữ thứ tự | `packages/kernel/test/project-schedule.test.ts` |
| T-PWF-02 | domain | P0 | Bốn kiểu liên kết có lag và lead | Mỗi quan hệ thỏa trên ô làm việc; lead không đưa việc trước ngày bắt đầu | `project-schedule.property.test.ts` |
| T-PWF-03 | property | P0 | Đồ thị ngẫu nhiên không vòng | Không vòng lặp, lịch đơn điệu (thời lượng dài hơn không làm việc nào kết thúc sớm hơn, thêm liên kết không làm việc nào sớm hơn), độ trễ cho phép không âm, đường dài nhất toàn việc găng | như trên |
| T-PWF-04 | domain | P0 | Đồ thị có vòng | `PWF_DEPENDENCY_CYCLE`; mẫu bị từ chối ở `validateRuleParams` | `project-workflow.test.ts` |
| T-PWF-05 | domain | P0 | Lịch chỉ có 2026, dự án chạy sang 2027 | Việc sang 2027 `CALENDAR_UNAVAILABLE` với `missing_year = 2027`, không ngày đoán, dự án không có ngày kết thúc | `project-schedule.test.ts` |
| T-PWF-06 | domain | P0 | Dự án 1.500 ngày làm việc, lịch 2026–2032 | Ngày kết thúc đúng, đi qua nhiều năm (vượt tầm quét 3 năm) | như trên |
| T-PWF-07 | domain | P1 | Đang làm dở, hoàn thành sớm, tiền nhiệm bị hủy | Việc xong giữ ngày thực, phần còn lại lập từ ngày trạng thái, nút độ dài 0 giữ thứ tự, `rescheduleProject` giữ cơ sở và liệt kê thay đổi | như trên |
| T-PWF-08 | domain | P0 | Bảng 5/2/0 và ba tầng | Quyết định màu theo bảng; cá nhân không bao giờ muộn hơn chính thức; `HOME_WORK` mặc định bằng `workBucket` cũ cho mọi r từ −400 đến 400; `REPORT_SCHEDULE` bằng `scheduleStepState` cũ | `deadline-band.test.ts`, `deadline-band.property.test.ts` |
| T-PWF-09 | domain | P0 | Công thức, quy đổi, mẫu số 0 | Mỗi phép tính, hai hướng tuyến tính, bậc thang, trọng số chia lại, miễn trễ, `NOT_APPLICABLE` | `workflow-kpi.test.ts` |
| T-PWF-10 | domain | P0 | Chống thao túng | Xóa, tách, đổi người, dời cơ sở: điểm không tăng; cờ sinh cho người rà soát | như trên |
| T-PWF-11 | property | P0 | Điểm ngẫu nhiên | Điểm luôn trong 0 đến 100, không NaN; thứ tự việc không đổi điểm người; trọng số không âm | `workflow-kpi.property.test.ts` |
| T-PWF-12 | domain | P1 | Tham chiếu | Mã KPI, RAG, mẫu trong mặc định tồn tại; mã sai bị `governance:check` báo | `scripts/governance-check.test.mjs` |
| T-PWF-13 | hồi quy CRITICAL | P0 | Test PRC-1 | `bid-workflow`, `bid-process-tree`, `bid-timeline`, `apps/api/test/bid/package-workflow.test.ts` xanh, không sửa assertion; `bid-workflow.ts` xuất lại đúng hàm của `process-core.ts` | `process-core.test.ts` |
| T-PWF-14 | hồi quy CRITICAL | P0 | Chuyển giai đoạn PRJ | Dự án chưa có workflow: test PRJ hiện có xanh, không sửa assertion; có workflow: mọi lệnh và sự kiện hệ thống chạy cổng | pwf1 |
| T-PWF-15 | hồi quy CRITICAL | P0 | Trung tâm cảnh báo | Test hiện có xanh với mặc định mới (7 và 3 ngày lịch) | pwf2 |
| T-PWF-16 | integration | P0 | DB | Đóng băng mẫu; sửa mẫu sau không đổi dự án; nhật ký chỉ thêm; sổ phân công chồng khoảng bị chặn | pwf1 |
| T-PWF-17 | integration | P0 | DB đồng thời | Hai người dời lịch cùng lúc: người sau 409; chốt kỳ đồng thời với điều chỉnh không mất dữ liệu | pwf1, pwf3 |
| T-PWF-18 | security | P0 | IDOR, ba vai | Cùng tenant khác đơn vị, quản lý cũ sau chuyển đơn vị, xuất hàng loạt, đệm điện thoại sau thu hồi: 404 hoặc không có dữ liệu | pwf3 |
| T-PWF-19 | security | P0 | Tự duyệt | Người làm duyệt việc của mình, người đề nghị duyệt ngoại lệ, quản lý tự duyệt điều chỉnh: bị từ chối | pwf1, pwf3 |
| T-PWF-20 | performance | P1 | Danh mục lớn | Bảng deadline p95 ≤ 800 ms ở 1.000 dự án × 200 việc; lập lịch 500 việc ≤ 200 ms; chốt kỳ 5.000 người ≤ 20 s; số truy vấn có trần | `perf-budget` |
| T-PWF-21 | E2E | P1 | Web và điện thoại | Màu chính thức và màu cá nhân (R40); phản hồi điểm → xử lý → kỳ chính thức; ngoại tuyến gửi lệnh cũ không ghi đè | pwf-mobile |

**Ca UAT** (đăng ký trong `docs/uat/pwf`, tên `UAT-PWF-nn`; chạy bằng `uat-test-only` cho cả hai bản): UAT-PWF-01 soạn, trình và duyệt mẫu bởi người khác; UAT-PWF-02 khởi tạo workflow từ ngày bắt đầu, xem hạn từng việc; UAT-PWF-03 năm thiếu lịch hiện "chưa tính được hạn"; UAT-PWF-04 tiếp nhận dự án đang chạy với chạy thử; UAT-PWF-05 hoàn thành việc thiếu chứng từ bị chặn, bổ sung rồi hoàn thành, người duyệt khác người làm; UAT-PWF-06 chuyển giai đoạn bị cổng chặn kèm danh sách việc thiếu; UAT-PWF-07 dời lịch xem trước, duyệt, đường cơ sở không đổi; UAT-PWF-08 đặt ngưỡng 5/2/0 và thấy màu đúng; UAT-PWF-09 tùy chọn cá nhân sớm hơn và bảng quản lý vẫn chính thức; UAT-PWF-10 chốt kỳ, xem điểm của tôi và phân rã; UAT-PWF-11 phản hồi điểm và xử lý; UAT-PWF-12 điều chỉnh điểm cần người duyệt thứ hai; UAT-PWF-13 quản lý cũ không còn xem được; UAT-PWF-14 mẫu nhỏ không xếp loại; UAT-PWF-15 điện thoại: việc của tôi theo hạn, hoàn thành việc, điểm của tôi.

## 11. Tiêu chí nghiệm thu (đo được)

Mỗi tiêu chí `AC-ST-PWF-nnn-m` gắn test ID ở mục 10 và câu chuyện ở mục 14.

- AC-ST-PWF-001-1: Cho mẫu có vòng phụ thuộc, khi lưu nháp, thì bị từ chối `PROJECT_WORKFLOW_TEMPLATE_INVALID`/`GOVERNANCE_RULE_PARAMS_INVALID` nêu đúng trường (T-PWF-04, UAT-PWF-01). AC-ST-PWF-001-2: người soạn không tự duyệt được (T-PWF-19).
- AC-ST-PWF-002-1: Cho dự án chưa có workflow và ngày bắt đầu dự định, khi `startProjectWorkflow`, thì mọi việc có ngày bắt đầu, hạn, độ trễ cho phép và đường găng đúng bảng tay, mẫu đóng băng có băm (T-PWF-01, T-PWF-16). AC-ST-PWF-002-2: năm thiếu lịch hiện "chưa tính được hạn", không ngày đoán (T-PWF-05).
- AC-ST-PWF-003-1: Cho dự án đang chạy, khi tiếp nhận với ngày hiệu lực, thì chạy thử không ghi dữ liệu và việc quá khứ `NOT_TRACKED` không vào điểm (T-PWF-16, UAT-PWF-04).
- AC-ST-PWF-004-1: Cho workflow có nhánh, khi xem tiến độ, thì Gantt và cây khớp lịch, đường găng đánh dấu, nhánh bị loại không hiện (T-PWF-01, T-PWF-07).
- AC-ST-PWF-005-1: Cho việc thiếu chứng từ bắt buộc, khi hoàn thành, thì 422 `PWF_TASK_COMPLETION_BLOCKED` kèm `blockers` (T-PWF-19, UAT-PWF-05). AC-ST-PWF-005-2: đủ điều kiện thì chuyển chờ duyệt hoặc xong.
- AC-ST-PWF-006-1: Người làm không duyệt được hoàn thành việc của mình, kể cả khi có ngoại lệ (T-PWF-19). AC-ST-PWF-006-2: trả lại tăng số lần trả và cần lý do.
- AC-ST-PWF-007-1: Chỉ tạm dừng và trì hoãn bên ngoài đã được duyệt mới trừ khỏi độ lệch ngày của KPI (T-PWF-09, T-PWF-10). AC-ST-PWF-007-2: hủy không duyệt tính chưa đạt.
- AC-ST-PWF-008-1: Sổ phân công không cho tổng tỷ lệ cùng vai quá 100 và không chồng khoảng (T-PWF-16, T-PWF-09).
- AC-ST-PWF-009-1: Dự án có workflow, khi `startProjectImplementation` mà giai đoạn chặn còn việc bắt buộc chưa xong, thì 422 `PWF_GATE_CLOSED` kèm danh sách việc, và sự kiện hệ thống không chuyển trạng thái (T-PWF-14, UAT-PWF-06). AC-ST-PWF-009-2: dự án không có workflow giữ hành vi cũ.
- AC-ST-PWF-010-1: Dời lịch có xem trước, hai người dời cùng lúc: người sau 409; đường cơ sở không đổi (T-PWF-07, T-PWF-17, UAT-PWF-07).
- AC-ST-PWF-011-1: Với ngưỡng 5/2/0 và hôm nay là ngày làm việc d, hạn cách 6, 5, 3, 2, 1, 0, −1 ngày làm việc cho màu NONE, GREEN, GREEN, YELLOW, YELLOW, RED, RED (T-PWF-08, UAT-PWF-08). AC-ST-PWF-011-2: mặc định `HOME_WORK`/`REPORT_SCHEDULE` bằng hằng số cũ (T-PWF-15).
- AC-ST-PWF-012-1: Bảng deadline hiện tổng chính xác theo màu kể cả khi danh sách bị cắt, ghi "đang hiện N trên M"; chỉ màu chính thức (T-PWF-20).
- AC-ST-PWF-013-1: Dời lịch, tạm dừng, hủy, hoàn thành cập nhật cảnh báo trong cùng giao dịch; chạy lại không sinh trùng; mỗi mốc nhắc đúng một lần (T-PWF-15, T-PWF-21).
- AC-ST-PWF-014-1: Ngưỡng cá nhân muộn hơn chính thức bị từ chối khi lưu; cảnh báo chính thức và KPI không đổi theo tùy chọn cá nhân (T-PWF-08, UAT-PWF-09).
- AC-ST-PWF-015-1: Bộ KPI tham chiếu mã không tồn tại bị từ chối; mặc định tham chiếu đúng (T-PWF-12).
- AC-ST-PWF-016-1: Kỳ chốt có băm; tính lại từ ảnh chụp cho cùng băm; kỳ chốt không đổi khi phân công hay cơ sở đổi sau đó (T-PWF-10, T-PWF-17).
- AC-ST-PWF-017-1: Nhân viên xem điểm của mình tới từng việc, gửi phản hồi trong cửa sổ, kỳ chính thức sau khi phản hồi xử lý xong (T-PWF-21, UAT-PWF-10, UAT-PWF-11).
- AC-ST-PWF-018-1: Quản lý cũ, người khác đơn vị, xuất hàng loạt: không xem được bảng điểm ngoài quyền; mọi lần xem của người khác ghi ADM-11 (T-PWF-18, UAT-PWF-13). AC-ST-PWF-018-2: điều chỉnh cần người duyệt thứ hai khác người được chấm và nằm trong biên độ (T-PWF-19, UAT-PWF-12). AC-ST-PWF-018-3: mẫu nhỏ không xếp loại (T-PWF-09, UAT-PWF-14).
- AC-ST-PWF-019-1: Điện thoại hiện workflow, việc của tôi theo hạn (màu cá nhân có nhãn và ngày thật), điểm của tôi; không lưu đệm bảng điểm người khác (T-PWF-21, UAT-PWF-15).
- AC-ST-PWF-020-1: Tải công việc theo người chỉ hiển thị, không đổi lịch (T-PWF-20).

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

- **R1 (dùng thật):** F1 đến F8 (mẫu, khởi tạo, công việc, cổng, lập lịch, ba màu, nhắc, bảng deadline), PWF-01 đến PWF-08, PWF-15, MOB-78 đến MOB-80 và MOB-82; lõi kernel đã xong (đợt này).
- **R2:** F9 và F10 (KPI, chốt kỳ, điểm, phản hồi qua ADM, điều chỉnh), PWF-09 đến PWF-14, PWF-16, MOB-81; tiếp nhận hàng loạt; tải công việc.
- **R3 / để sau:** độ trễ theo ngày lịch (`lag_unit`), nhiều đường độ trễ tới một mốc, ngưỡng phần trăm DCMA, "giữ khoảng đệm" hay "tiêu thụ khoảng đệm" khi dời, gói mẫu của bản doanh nghiệp (do khách duyệt quy trình To-Be, `PENDING-EXTERNAL`).
- **Giờ review người dự kiến (bắt buộc người duyệt):** tiền (`estimate_vnd`, `actual_vnd`): 2 giờ; quyền (ba vai bảng điểm, chính sách DB, IDOR): 4 giờ; migration (V3000 đến V3039, mở rộng `project`, `alert_notification_profile`): 3 giờ; mẫu văn bản pháp lý (loại chứng từ, mẫu mặc định): 3 giờ; quyết định liên quan người lao động (chính sách chấm điểm, lưu trữ): 3 giờ pháp chế.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Owner | Điều kiện giải quyết |
|---|---|---|
| Số hiệu nghị định hướng dẫn Luật Đầu tư công 58/2024/QH15 và trình tự từng nhóm dự án chưa kiểm chứng (`[CXN-13]`) | Pháp chế của cơ quan sử dụng | Xác nhận, đổi `legalStatus` sang VERIFIED trong phiên bản quy tắc |
| Chính sách chấm điểm so với quy chế đánh giá cán bộ, công chức (Nghị định 90/2020, Điều 36 Bộ luật Lao động) và tham khảo đại diện người lao động (`[CXN-PWF-01]`) | Pháp chế và công đoàn của cơ quan | Thông báo quy chế chấm điểm, đánh giá tác động dữ liệu cá nhân trước khi bật |
| Mã biểu mẫu `document_template` của DOC do từng tenant công bố; mẫu mặc định chưa tham chiếu biểu mẫu | Quản trị DOC của tenant | Gắn biểu mẫu khi duyệt mẫu; kiểm `FORM_TEMPLATE_UNKNOWN` |
| Độ trễ ngày lịch kiểu elapsed (thời hạn niêm yết, thời hạn khiếu nại) | Chủ sản phẩm | Làm khi có yêu cầu cụ thể; cách tạm: việc chờ có số ngày làm việc tương đương |
| Lịch làm việc năm sau chưa công bố khi lập lịch dài | Quản trị ADM | Công bố lịch; việc báo `CALENDAR_UNAVAILABLE`, đề nghị dời lịch tự sinh khi phiên bản lịch đổi |
| Chênh lệch số ngày nghỉ lễ giữa các nguồn thứ cấp | Quản trị ADM | Đối chiếu văn bản chính thức khi nhập lịch (`legal_basis_ref`) |
| Hiệu năng danh mục lớn | Kỹ thuật | Đo bằng `perf-budget` trước cổng (con số hiện là ước tính) |
| Ngưỡng mặc định, trọng số, số ngày của mẫu là giá trị khởi đầu | Chủ đầu tư | Duyệt theo quy trình quy tắc; nhãn "mặc định, chưa xác nhận" hiển thị đến khi duyệt |

Không có câu hỏi nào chờ chủ sở hữu: mọi lựa chọn mở đã được quyết theo tiêu chí quản trị sâu nhất và mở rộng tốt nhất (D-01 đến D-42).

## 14. Câu chuyện (story) và truy vết

| ID | Câu chuyện | Màn | Quy tắc | AC |
|---|---|---|---|---|
| ST-PWF-001 | Là quản trị quy trình, tôi soạn và trình mẫu workflow, người khác duyệt | PWF-01, 02 | BR-PWF-02, 12, 15, 16, 19 | AC-ST-PWF-001-1, 001-2 |
| ST-PWF-002 | Là quản lý dự án, tôi khởi tạo workflow từ ngày dự định bắt đầu và thấy hạn từng việc | PWF-05, 03 | BR-PWF-01 đến 05, 10, 11 | AC-ST-PWF-002-1, 002-2 |
| ST-PWF-003 | Là quản lý dự án, tôi tiếp nhận dự án đang chạy | PWF-05 | BR-PWF-17 | AC-ST-PWF-003-1 |
| ST-PWF-004 | Là lãnh đạo, tôi xem cây tiến trình, Gantt và đường găng | PWF-03 | BR-PWF-05, 09 | AC-ST-PWF-004-1 |
| ST-PWF-005 | Là người thực hiện, tôi nộp chứng từ và hoàn thành việc | PWF-04, MOB-79 | BR-PWF-14 | AC-ST-PWF-005-1, 005-2 |
| ST-PWF-006 | Là người duyệt, tôi duyệt hoặc trả lại việc | PWF-04 | BR-PWF-14 | AC-ST-PWF-006-1, 006-2 |
| ST-PWF-007 | Là người thực hiện, tôi xin tạm dừng, hủy, miễn hoặc ghi trì hoãn bên ngoài có người duyệt | PWF-04 | BR-PWF-35, 37 | AC-ST-PWF-007-1, 007-2 |
| ST-PWF-008 | Là quản lý, tôi ghi sổ phân công theo khoảng và tỷ lệ | PWF-16 | BR-PWF-34 | AC-ST-PWF-008-1 |
| ST-PWF-009 | Là chủ đầu tư, tôi không thể chuyển giai đoạn khi việc bắt buộc chưa xong | PWF-03 | BR-PWF-13 | AC-ST-PWF-009-1, 009-2 |
| ST-PWF-010 | Là quản lý, tôi dời lịch có xem trước và người khác duyệt | PWF-06 | BR-PWF-08, 28 | AC-ST-PWF-010-1 |
| ST-PWF-011 | Là quản trị, tôi đặt ngưỡng ba màu theo ngày | PWF-08 | BR-PWF-20 đến 22 | AC-ST-PWF-011-1, 011-2 |
| ST-PWF-012 | Là lãnh đạo, tôi xem bảng deadline toàn danh mục và lịch tháng | PWF-07 | BR-PWF-23, 29 | AC-ST-PWF-012-1 |
| ST-PWF-013 | Là người được giao, tôi nhận nhắc hạn đúng lúc, không trùng | trung tâm cảnh báo | BR-PWF-24, 25, 27 | AC-ST-PWF-013-1 |
| ST-PWF-014 | Là người dùng, tôi đặt nhắc sớm hơn cho riêng mình | PWF-15, MOB-82 | BR-PWF-23 | AC-ST-PWF-014-1 |
| ST-PWF-015 | Là quản trị, tôi soạn bộ KPI và chính sách chấm điểm | PWF-09, 10 | BR-PWF-30 đến 33 | AC-ST-PWF-015-1 |
| ST-PWF-016 | Là nhân sự, tôi tính và chốt kỳ chấm điểm | PWF-14 | BR-PWF-36, 37, 39 | AC-ST-PWF-016-1 |
| ST-PWF-017 | Là nhân viên, tôi xem điểm của tôi và phản hồi | PWF-11, MOB-81 | BR-PWF-39, 40 | AC-ST-PWF-017-1 |
| ST-PWF-018 | Là quản lý, tôi xem điểm đơn vị, đề nghị điều chỉnh có duyệt và xuất tệp | PWF-12, 13 | BR-PWF-36, 38, 40, 41, 42 | AC-ST-PWF-018-1, 018-2, 018-3 |
| ST-PWF-019 | Là cán bộ, tôi theo dõi việc trên điện thoại | MOB-78 đến 80 | BR-PWF-23, 26 | AC-ST-PWF-019-1 |
| ST-PWF-020 | Là lãnh đạo, tôi xem tải công việc theo người | PWF-07 | BR-PWF-18 | AC-ST-PWF-020-1 |

Đã đăng ký (làn `pwfreg`, 2026-11-13) vào `implementation_plan.json` (epic EP-PWF, tám feature FT-PWF-01..08, 20 câu chuyện), `test_cases.json` (T-PWF-01..21, UAT-PWF, UI-PWF-01..16, UI-MOB-78..82), `traceability.json` (FR-PWF-01..16, FR-MOB-78..82), `implementation_backlog.json` (BL-PWF-01..16, BL-MOB-78..82) và `navigation_architecture.json`, bằng `node scripts/contract-patch.mjs apply --spec docs/plans/pwf-register.json` (công cụ `contract-patch` có thêm các lệnh `add-epic`, `add-feature`, `add-story`, `add-test-case`, `add-trace`, `add-backlog`, `add-route`, `add-nav-group`); các ID trên là khóa của việc đó.

## 15. Kiểm chứng đã thực hiện trong làn này

Lõi thuần (không DB): `process-core.ts` (hàm ngày và ngày làm việc dùng chung với PRC-1, `bid-workflow.ts` xuất lại, test PRC-1 không sửa), `project-workflow.ts` (kiểu mẫu, bộ kiểm, vòng lặp, nhánh, tham chiếu, bộ phân giải loại chứng từ theo bản, hoàn thành việc, cổng, ba mẫu mặc định công), `project-schedule.ts` (lượt xuôi và ngược, bốn kiểu liên kết, ràng buộc, tiến độ thực, lịch ghim, tính lại giữ cơ sở), `deadline-band.ts` (ba màu, ba tầng, nguồn khai đơn vị, nhắc nhiều mốc), `workflow-kpi.ts` (danh mục phép tính, quy đổi, tổng hợp theo kỳ, tín hiệu, điều chỉnh, băm); kiểm `governance:check` thêm tham chiếu `GOV_REFERENCE_MISSING`. Số test và độ phủ ở báo cáo của làn.
