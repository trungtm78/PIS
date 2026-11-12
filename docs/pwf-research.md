# Nghiên cứu thị trường cho PWF: workflow dự án, deadline ba màu, KPI và chấm điểm nhân viên

Ngày nghiên cứu: 2026-11-12. Làn `pwfspec`. Tài liệu này là căn cứ của đặc tả `Design/MACHVON_Design/01_Documents/05_modules/PWF.md` và của lõi `packages/kernel` (`project-workflow.ts`, `project-schedule.ts`, `deadline-band.ts`, `workflow-kpi.ts`, `process-core.ts`).

## Cách đọc

- Phần A: lập lịch, phụ thuộc, đường găng, tự dời lịch, ngưỡng nhắc, màu đỏ/vàng/xanh, tải công việc ở MS Project, Primavera P6, Asana, Jira, Monday, Smartsheet, ClickUp, Procore, Autodesk Build, Fieldwire, kèm PRINCE2 và PMBOK.
- Phần B: chấm điểm con người ở OKR, Balanced Scorecard, SAP SuccessFactors, Workday, Lattice, 15Five, Culture Amp, Betterworks; các bẫy công bằng (trễ có lý do, việc chung, thao túng, calibration, mẫu nhỏ), pháp lý dữ liệu cá nhân, tiền lệ DORA, EVM, CPARS.
- Phần C: quyết định thiết kế của PWF (nhận hay bỏ, vì sao, nằm ở đâu trong đặc tả và mã).
- Mỗi liên kết ghi mức tin cậy: đã đọc trang, chỉ thấy tóm tắt trong kết quả tìm kiếm, hoặc bài của cộng đồng (không phải tài liệu chính thức). Trang trả 403/404 được ghi rõ; không có liên kết nào được bịa. Phần các điều khoản pháp luật cần luật sư của cơ quan sử dụng rà soát trước khi đưa vào quy chế.
- Bối cảnh sản phẩm: bản công "Hệ thống quản lý đầu tư công" của cơ quan nhà nước cấp tỉnh/bộ; bản doanh nghiệp chỉ thêm gói mẫu qua cơ chế bản (không đổi mã dùng chung).


## Phần A. Lập lịch, deadline và cảnh báo trong các hệ thống quản lý dự án

Ngày nghiên cứu: 2026-11-12. Phạm vi: chỉ đọc tài liệu công khai, không đụng repo.

Quy ước độ tin cậy của nguồn (ghi sau mỗi link khi cần):
- [đã đọc] trang đã được tải và đọc nội dung chính thức.
- [chỉ snippet] chỉ thấy tóm tắt từ kết quả tìm kiếm, trang không tải được hoặc không có thân bài.
- [cộng đồng] bài của người dùng/diễn đàn, không phải tài liệu chính thức; dùng để lấy "người dùng phàn nàn gì".

### 1. MS Project và Project for the web

#### 1.1 Template -> lịch
- Tạo dự án từ template: ô Start date giữ ngày bắt đầu lưu trong file gốc (không tự lấy hôm nay); mặc định "Schedule from = Project Start Date" ([O'Reilly - Setting the Project Start Date](https://www.oreilly.com/library/view/microsoft-project-2013/9781449357955/ch05s02.html) [chỉ snippet, sách bên thứ ba]; trang chính thức [Create a new project from another project or template](https://support.microsoft.com/en-us/project/create-a-new-project-from-another-project-or-template) chỉ thấy snippet, không đọc được từng bước tiếng Anh).
- Lịch của template là lịch "đóng băng": đổi ngày bắt đầu thì Project tính lại toàn mạng, đúng mô hình PWF (start date + duration + dependency).

#### 1.2 Task type, effort-driven
- Ba loại: Fixed Units (mặc định), Fixed Duration, Fixed Work; Work = Duration x Units; effort-driven là hộp kiểm cho Fixed Units/Duration, Fixed Work luôn effort-driven ([Change the task type for more accurate scheduling](https://support.microsoft.com/en-us/project/change-the-task-type-for-more-accurate-scheduling) [chỉ snippet]; [Type fields](https://support.microsoft.com/en-us/project/type-fields) [chỉ snippet]).
- Bài học: kết hợp 3 loại x effort-driven x resource calendar sinh nhiều kết quả khó đoán; diễn đàn và MPUG có cả loạt bài "đừng bực mình với task type" ([MPUG - Task types](https://mpug.com/task-types-dont-get-frustrated) [cộng đồng]).

#### 1.3 Dependency và lead/lag
- Bốn loại FS/SS/FF/SF. Lead = số âm hoặc phần trăm âm (vd "-50%"), lag = số dương ("2d"); phải tạo dependency trước rồi mới nhập lag; trang chính thức không nói lag dùng lịch nào và không giải thích đơn vị elapsed "ed" ([Add lead or lag time to a task](https://support.microsoft.com/en-US/project/add-lead-or-lag-time-to-a-task) [đã đọc]).
- Project for the web: ban đầu chỉ FS, từ 03/2023 có thêm SS/FF/SF; lead/lag được giới thiệu muộn hơn qua blog ([Advanced task dependencies in Project for the web](https://techcommunity.microsoft.com/blog/projectblog/advanced-task-dependencies-in-project-for-the-web/3770480) [chỉ snippet]; [Introducing lead & lag](https://techcommunity.microsoft.com/blog/projectblog/introducing-lead--lag-in-task-dependencies/4031854) [chỉ snippet]).
- Giới hạn của Project for the web: tối đa 3000 task/dự án, 2000 link (chỉ đếm successor), mỗi task tối đa 20 link, leaf task tối đa 1250 ngày, 10 cấp phân cấp, dải ngày 1/1/2000 - 31/12/2149 ([Limits and boundaries](https://learn.microsoft.com/en-us/project-for-the-web/project-for-the-web-limits-and-boundaries) [đã đọc]). Microsoft ghi rõ Project for the web sẽ chuyển thành Planner.

#### 1.4 Constraint (ràng buộc ngày)
- Tám loại, ba nhóm: linh hoạt (ASAP, ALAP), bán linh hoạt (SNET, SNLT, FNET, FNLT), cứng (MSO, MFO). ASAP là mặc định khi lập lịch từ ngày bắt đầu, ALAP khi lập từ ngày kết thúc; sáu loại còn lại cần ngày ràng buộc. Không "xóa" được constraint, chỉ reset về ASAP/ALAP. Gõ tay ngày bắt đầu/kết thúc của một task tự động thêm constraint giữ ngày đó ([Set a task start or finish date (constraint)](https://support.microsoft.com/en-us/project/set-a-task-start-or-finish-date-constraint-for-a-task) [đã đọc]).
- Xung đột constraint với dependency: constraint cứng (MSO/MFO) thường thắng dependency, task đứng yên dù predecessor sớm/muộn; có thể đổi bằng tùy chọn "Tasks will always honor their constraint dates". Nếu predecessor xong quá muộn so với MSO/MFO thì sinh negative slack ([How Project schedules tasks behind the scenes](https://support.microsoft.com/en-US/project/how-project-schedules-tasks-behind-the-scenes) [đã đọc]).
- Deadline khác constraint: deadline không đổi lịch, chỉ hiện chỉ báo "Missed Deadline" khi task kết thúc sau deadline, và có thể giảm total slack tính ra; hạn chế là chỉ báo chỉ hiện khi đã trễ, không cảnh báo sớm ([Deadline (task field)](https://support.microsoft.com/lv-lv/project/deadline-task-field) [chỉ snippet]; [Tips and Tricks: Create Deadline Dates](https://blogs.msdn.microsoft.com/project/tips-and-tricks-create-deadline-dates) [chỉ snippet]).

#### 1.5 Critical path, total/free slack
- Slack (float) = khoảng task có thể trượt trước khi chạm task khác; total slack có thể âm (thiếu thời gian); free slack = số nhỏ hơn giữa start slack và finish slack theo cách Microsoft mô tả; task có slack 0 là critical ([Show slack in your project](https://support.microsoft.com/en-US/project/show-slack-in-your-project-in-project-desktop) [đã đọc]).
- Ngưỡng "critical": tùy chọn "Tasks are critical if slack is less than or equal to" (File > Options > Schedule/Calculation); nâng ngưỡng để tạo near-critical path (cùng trang trên). Đây chính là một "ngưỡng do người dùng đặt" áp lên float, tương tự ý tưởng ngưỡng đỏ/vàng của PWF.
- Phản biện từ MPUG: total slack của milestone kết thúc luôn bằng 0 nên đánh giá thấp slack thật ([MPUG - Deadlines and the most-critical path](https://mpug.com/a-better-microsoft-project-for-time-modeling-deadlines-and-the-most%e2%80%91-critical-path) [cộng đồng]).

#### 1.6 Auto vs manual scheduling
- Mặc định task mới là Manually Scheduled (người dùng tự đặt start/finish/duration); đổi dependency/constraint/lịch không làm đổi ngày của task thủ công ([Task Mode](https://support.microsoft.com/en-gb/office/task-mode-task-field-3b185518-0e9a-4774-ba51-7b8d191bb84a) [chỉ snippet]; trang "behind the scenes" cũng nêu manual task bỏ qua resource calendar [đã đọc]).
- Bài học: hai chế độ trên cùng một mạng làm người dùng khó biết ngày nào là "tính" và ngày nào là "gõ tay"; tích hợp (Clarity) còn không hỗ trợ manual task ([Broadcom KB 47612](https://knowledge.broadcom.com/external/article/47612/auto-scheduled-versus-manually-scheduled.html) [chỉ snippet]).

#### 1.7 Baseline (11 baseline), interim plan
- Tối đa 11 baseline (Baseline + Baseline1..10) và 10 interim plan; baseline lưu ~20 trường (start, finish, duration, work, cost), interim chỉ start/finish. Variance chỉ so với baseline gốc "Baseline", không so với Baseline1..10. Task thêm sau khi lập baseline có variance bằng chính giá trị lịch. Summary task baseline có thể lệch subtask trừ khi "roll up". Có thể sửa lại baseline "bất cứ lúc nào nếu các bên đồng ý" - tức không có khóa bất biến ([Create or update a baseline or an interim plan](https://support.microsoft.com/en-US/project/create-or-update-a-baseline-or-an-interim-plan-in-project-desktop) [đã đọc]).

#### 1.8 Status date, % complete, remaining duration
- Actual duration = Duration x %Complete; Remaining = Duration - Actual; chỉ nên nhập một trong ba trường vì nhập cái này tự tính lại hai cái kia; cột Status so sánh %complete theo thời gian với status date để hiện On Schedule/Late; status date đổi trong Project Information ([Actual Duration](https://support.microsoft.com/en-US/project/actual-duration-task-field) [chỉ snippet]; [Percent (%) Complete](https://support.microsoft.com/en-US/project/percent-complete-fields) [chỉ snippet]).
- Khuyến nghị thực hành: cập nhật bằng remaining duration thay vì % complete, vì % complete không dời ngày kết thúc nên successor không bị tác động ([MPUG - manually entering task progress](https://mpug.com/manually-entering-task-progress-in-microsoft-project) [cộng đồng]).

#### 1.9 Calendar
- Ba base calendar: Standard (T2-T6, 8:00-17:00, nghỉ 1 giờ), 24 Hours, Night Shift. Calendar cấp project, task, resource; task dùng phần giờ giao nhau giữa calendar task và resource; đơn vị: 1 ngày = 8 giờ, 1 tuần = 40 giờ, 1 tháng = 20 ngày làm việc; nhập ngày không giờ thì dùng 8:00 (start) và 17:00 (end) ([How Project schedules tasks behind the scenes](https://support.microsoft.com/en-US/project/how-project-schedules-tasks-behind-the-scenes) [đã đọc]).

### 2. Oracle Primavera P6

#### 2.1 Activity types
- Task Dependent (lập lịch theo calendar của activity), Resource Dependent (theo calendar của resource được gán), Level of Effort (duration suy ra từ activity phụ thuộc, thường là hành chính), Start/Finish Milestone (duration 0, không resource), WBS Summary (tổng hợp ngày/duration/%complete theo mã WBS) ([Activity Attributes (General)](https://docs.oracle.com/cd/F37375_01/English/User_Guides/evm/10292549.htm) [đã đọc]).
- % Complete có ba kiểu: Duration, Units, Physical (cùng trang). Physical % là "phán đoán cá nhân" - nguồn lệch số liệu phổ biến.

#### 2.2 Relationship type, lag, lag calendar
- Tùy chọn "Calendar for scheduling Relationship Lag": calendar của predecessor, successor, 24 hour, hoặc Project Default; lag nhập đơn vị khác giờ được đổi sang giờ theo calendar của predecessor ([Settings Tab of the Schedule Dialog Box](https://docs.oracle.com/cd/G18294_01/p6help/en/90519.htm) [đã đọc]).
- Người dùng: tùy chọn này là cài đặt toàn cục ảnh hưởng mọi dự án trong cơ sở dữ liệu, nên cùng một lag cho kết quả khác nhau giữa máy/cấu hình; nguồn tư vấn khuyên nhập lag "cure time" bằng giờ trên calendar 24 giờ ([Tensix - 24 hour lag](https://tensix.com/scheduling-a-24-hour-elapsed-time-lag-in-primavera-p6/) [chỉ snippet, cộng đồng]).

#### 2.3 Retained logic / progress override / actual dates (tiến độ không theo thứ tự)
- Retained Logic: phần việc còn lại của activity đã tiến hành không được lập lịch cho đến khi mọi predecessor xong. Progress Override: bỏ qua logic, activity chạy tiếp không chờ. Actual Dates: forward/backward pass tính theo ngày thực tế ([Settings Tab of the Schedule Dialog Box](https://docs.oracle.com/cd/G18294_01/p6help/en/90519.htm) [đã đọc]).
- Retained Logic là mặc định; chủ đầu tư hay ưu tiên Retained Logic còn nhà thầu ưu tiên Progress Override ([AACE paper qua PlanningPlanet](https://planningplanet.com/comment/85514) [cộng đồng]) - tức lựa chọn này mang tính tranh chấp hợp đồng, nên cần ghi lại ai chọn, khi nào.

#### 2.4 Float, critical path, longest path, multiple float paths
- Total float tính từ forward/backward pass; "Compute Total Float As": Start Float, Finish Float, hoặc giá trị nhỏ nhất ([Settings Tab](https://docs.oracle.com/cd/G18294_01/p6help/en/90519.htm) [đã đọc]).
- Critical được định nghĩa bằng một trong hai cách: ngưỡng total float tối đa (P6 đánh dấu critical mọi activity vượt ngưỡng, kể cả activity không có quan hệ hoặc không ảnh hưởng ngày kết thúc) hoặc longest path (không thấy sub-critical path) ([Working with Critical Activities](https://docs.oracle.com/cd/G18294_01/p6help/en/6679.htm) [đã đọc]).
- Multiple float paths: chọn activity đích (thường là milestone), số đường cần tính, phương pháp Total Float hoặc Free Float (Free Float ~ longest path); kết quả lưu ở trường Float Path (1 = tới hạn nhất) và Float Path Order ([Advanced Tab](https://docs.oracle.com/cd/G18294_01/p6help/en/92768.htm) [đã đọc]; [Scheduling Overview - Primavera Cloud](https://docs.oracle.com/cd/E80480_01/help/en/user/88251.htm) [đã đọc]). Lưu ý nguồn Oracle nêu calendar khác nhau có thể loại activity nằm trên longest path khỏi critical path.

#### 2.5 Baseline
- Số baseline không giới hạn nhưng chỉ chọn tối đa hai để so sánh; có "project baseline" và "user's primary baseline" (P6 Professional: tới 3 user baseline); muốn sửa baseline phải "restore" thành dự án riêng; đặt project baseline cần cả quyền Edit Project Details và Assign Project Baseline ([Working with Baselines](https://docs.oracle.com/cd/G48897_01/English/User_Guides/p6_eppm_user/6687.htm) [đã đọc]). Đây là mô hình gần với "immutable + phân quyền" nhất trong các công cụ lập lịch.

#### 2.6 Calendar
- Global/project/resource calendar, project/resource liên kết (inherit) với global; ngày lễ/ngoại lệ được kế thừa nếu chưa bị sửa cục bộ, còn workweek và time period không kế thừa ([About Calendars - Oracle](https://docs.oracle.com/cd/G18302_01/English/p6_eppm/17940.htm) [chỉ snippet]; [Tensix - calendars](https://tensix.com/calendars-in-oracle-primavera-p6-explained/) [cộng đồng]).

#### 2.7 Kiểm tra chất lượng lịch: DCMA 14-point
Ngưỡng theo mô tả của vendor Deltek Acumen (không phải bản DCMA gốc, nguồn chỉ nêu số liệu cho một số điểm) ([DCMA 14-Point Assessment Metric Descriptions](https://help.deltek.com/Product/Acumen/8.11/GA/DCMA%2014%20Point%20Assessment%20Metric%20Descriptions.html) [đã đọc]):
- Logic: task thiếu predecessor/successor <= 5% task chưa xong. Leads: lý tưởng 0. Lags: <= 5% số link. Relationship types: FS >= 90% số link. Hard constraints: <= 5%. High float: total float > 44 ngày làm việc. Negative float: < 0 cần giải trình và kế hoạch khắc phục. High duration: > 44 ngày làm việc, <= 5%. Invalid dates: 0. Resources, Missed tasks, Critical path test, CPLI, BEI: không có ngưỡng số trong nguồn này.
- Công thức CPLI theo nguồn: (độ dài critical path + total float) / độ dài critical path.

### 3. Asana, Jira, Monday, Smartsheet, ClickUp

#### 3.1 Template và ngày tương đối
- Asana: task trong template đặt "N ngày sau/trước ngày bắt đầu dự án" hoặc "sau/trước ngày đến hạn dự án"; ngày bắt đầu nhập khi tạo dự án từ template; chọn có tính cuối tuần hay không; một template chỉ có một mỏ neo (start hoặc due), không trộn được; người dùng muốn nhiều mỏ neo (campaign live, campaign end) và muốn áp dụng cho dự án đang chạy ([Asana forum - Relative due dates in custom project templates](https://forum.asana.com/t/relative-due-dates-in-custom-project-templates/783408) [đã đọc, forum có nhân viên Asana]).
- ClickUp: khi áp template chọn giữ ngày gốc hoặc "Remap dates"; khoảng cách giữa các task được giữ theo ngày làm việc; ClickUp khuyên template dùng duration thay vì start/due date; người dùng phàn nàn remap chỉ theo due date không theo start date, và không có "ngày bắt đầu dự án" tĩnh để dùng trong công thức ([Remap dates in templates](https://help.clickup.com/hc/en-us/articles/6326168424471) [chỉ snippet - trang trả 403]; [Task durations in templates](https://help.clickup.com/hc/en-us/articles/31121960157591-Task-durations-in-templates) [chỉ snippet - 403]; [ClickUp feedback - Enable Static Project Start Date](https://feedback.clickup.com/feature-requests/p/enable-static-project-start-date-eg-list-start-date-for-formulas-automations-ai) [chỉ snippet, cộng đồng]).
- Smartsheet: sheet tạo từ template giữ working days của template, không lấy theo cài đặt tài khoản ([Define working days on a sheet](https://help.smartsheet.com/articles/516392-define-working-days-sheet) [đã đọc]).
- Autodesk Build: issue template gán "default due date" cho từng mục; bài nguồn không nói là ngày tuyệt đối hay offset ([ImagineIT - due dates in issue templates](https://resources.imaginit.com/how-tos/autodesk-build-stay-on-track-with-due-dates-in-issue-templates) [đã đọc, bên thứ ba]).

#### 3.2 Dependency và tự dời lịch (cascade)
- Asana auto-shift: dời ngày task phụ thuộc chỉ khi thay đổi gây xung đột (chồng lấn); nếu chỉ có khoảng hở thì không dời nên không giữ được khoảng cách cố định; ban đầu chỉ hoạt động trong Timeline, từng bị rollback 11/2019 rồi phát hành lại 12/2019; người dùng đòi dời theo khoảng cách cố định và milestone cố định/linh hoạt ([Asana forum - Auto-shifting dependency dates](https://forum.asana.com/t/auto-shifting-dependency-dates-is-now-available-on-all-projects/65503) [đã đọc]). Bài help chính thức [Auto-shifting dates for dependent tasks](https://help.asana.com/s/article/auto-shifting-dates-for-dependent-tasks) tải về không có thân bài; hai chế độ "maintain/consume buffer" và điều kiện hai task cùng có due date, task đã hoàn thành bị bỏ qua chỉ lấy từ snippet tìm kiếm.
- ClickUp "Reschedule Dependencies": đổi due date của task chặn thì start/due của task bị chặn dời cùng một lượng; yêu cầu task chặn có due date, task bị chặn có start date; khi bật từ Gantt chỉ task đang hiển thị được dời ([Rescheduling dependencies](https://help.clickup.com/hc/en-us/articles/6304547785367-Reschedule-Dependencies) [chỉ snippet - 403]). Phàn nàn: kéo ngày sớm hơn không kéo task phụ thuộc theo; nhiều blocker thì chỉ dời theo blocker đang sửa; không giới hạn theo ngày làm việc ([ClickUp feedback - limit rescheduling to business days](https://feedback.clickup.com/feature-requests/p/limit-rescheduling-dependencies-to-business-days) [chỉ snippet, cộng đồng]).
- Monday: cột Dependency có ba chế độ Flexible (không cho chồng lấn), Strict (hỗ trợ lead/lag, giữ quan hệ), No action; chỉ dời được ngày đã có sẵn trong cột Date/Timeline; mỗi board một cột Dependency; bốn loại FS/SS/FF/SF đặt trong UI, API không lộ loại; API không phát hiện vòng lặp, client phải tự kiểm ([API - Working with the dependency column](https://developer.monday.com/api-reference/docs/working-with-dependency-column) [đã đọc]). Phàn nàn: Strict có lỗi đã được Monday thừa nhận, lag "khó đoán", Flexible chỉ dời tiến không dời lùi ([Monday community - dependency issues and feedback](https://community.monday.com/t/new-monday-com-dependency-column-issues-and-feedback/84324) [chỉ snippet, cộng đồng]).
- Smartsheet: bật "Dependencies" ở cài đặt sheet (Business/Enterprise, cần Owner/Admin); thay đổi ngày predecessor cập nhật ngay ngày phụ thuộc; ghi đè tay một ngày bị chi phối sẽ gỡ liên kết predecessor khỏi hàng đó; khi bật dependencies thì cấm công thức trong cột Start/End/Duration/%Complete/Predecessors; hỗ trợ FS/SS/FF/SF; lag tính bằng ngày làm việc ([Activate dependencies and use predecessors](https://help.smartsheet.com/articles/765727-enabling-dependencies-using-predecessors) [đã đọc]). Phàn nàn: không có lag theo ngày lịch (elapsed) trong predecessor; workaround là task giả ([Smartsheet community - Elapsed time in predecessors](https://community.smartsheet.com/discussion/comment/267879) [chỉ snippet, cộng đồng]).
- Jira Plans (Advanced Roadmaps): dependency là liên kết issue (mặc định coi mọi link là "Blocks"), hiển thị bằng huy hiệu số; auto-scheduler xếp theo ước lượng, xếp hạng, năng lực đội và release, kết quả "Accept changes" chỉ ghi vào plan, sau đó "Review changes" mới ghi sang issue (hai bước duyệt) ([Auto-schedule issues in Advanced Roadmaps](https://confluence.atlassian.com/jirasoftwareserver101/auto-schedule-issues-in-advanced-roadmaps-1455426643.html) [đã đọc, Data Center]; [Sequential or concurrent dependencies](https://support.atlassian.com:443/jira-software-cloud/docs/use-sequential-or-concurrent-dependencies-in-your-plan/) [đã đọc]). Phàn nàn: dependency chỉ là "chỉ báo trực quan" không phải ràng buộc lịch; issue đã DONE làm hỏng chuỗi lập lịch ([Atlassian KB - auto scheduler discrepancy due to closed issue](https://confluence.atlassian.com/roadmaps-kb/advanced-roadmaps-for-jira-auto-scheduler-discrepancy-due-to-closed-issue-1277100195.html) [chỉ snippet]).

#### 3.3 Nhắc việc, ngưỡng thông báo trước hạn
- Jira Automation: không có trigger "đến hạn" gốc; dùng Scheduled trigger chạy mỗi ngày với JQL như `duedate = startOfDay("+30d") AND resolution is empty`; độ chi tiết theo ngày; bài KB chỉ áp cho Data Center ([Trigger an automation rule based on due date field](https://support.atlassian.com/automation/kb/trigger-an-automation-rule-based-on-due-date-field/) [đã đọc]).
- Smartsheet: trigger "When a date is reached" có tùy chọn x ngày trước/sau, tối đa 365 ngày; phàn nàn: nhắc gửi lặp hoặc gửi sai ngày, phải thêm cột trợ giúp ([Alerts and reminders](https://help.smartsheet.com/articles/542913) [chỉ snippet]; [Smartsheet community announcement](https://community.smartsheet.com/announcement/new-feature-automated-date-based-alerts-actions-365-days-date) [chỉ snippet]).
- Monday: tự động hóa "When date arrives" và "X days before date" kích hoạt ở giờ cố định như nhau cho mọi item; nhắc lặp quá hạn chỉ chạy với cột Date, không chạy với Timeline; trang hỗ trợ chính thức [Alerts and Reminders with Automations](https://support.monday.com/hc/en-us/articles/360000227739-Alerts-and-Reminders-with-Automations) trả 403 nên chỉ có snippet và cộng đồng.
- ClickUp: automation "Due date arrives" không có offset; yêu cầu "7 ngày trước hạn" có ~3.6k vote, được gắn "completed" nhưng người dùng 2025-2026 vẫn báo chưa dùng được, ngày làm việc/ngày lễ "still in progress" ([ClickUp feedback - Relative Date & Time for Automations](https://feedback.clickup.com/feature-requests/p/relative-date-time-for-automations-ex-schedule-7-days-before-due-date) [đã đọc]).
- Asana: chủ dự án nhận task nhắc cập nhật status hằng tuần vào thứ Năm, hạn thứ Sáu (có thể tắt) ([Project progress and status updates](https://help.asana.com/s/article/project-progress-and-status-updates) [chỉ snippet]).

#### 3.4 RAG, trạng thái rủi ro
- Asana: trạng thái dự án on_track / at_risk / off_track / on_hold / complete / dropped, do người dùng chọn thủ công (hoặc AI gợi ý); API: status update "có thể tạo và xóa nhưng không sửa" ([Asana API - Status updates](https://developers.asana.com/docs/status-update) [đã đọc]). Diễn đàn hỏi ranh giới at risk/off track vì không có định nghĩa số ([Asana forum - At Risk vs Off Track](https://forum.asana.com/t/at-risk-vs-off-track/110162) [chỉ snippet, cộng đồng]). Tính không sửa được của status update là mô hình bất biến đáng học.
- Smartsheet: cột Symbols (Red/Yellow/Green) điền bằng công thức IF với TODAY(); mẫu phổ biến: đỏ khi quá hạn và chưa xong, vàng khi còn <= 3 ngày, xanh còn lại; lỗi hay gặp: công thức bị #UNPARSEABLE, cần NETWORKDAYS nếu muốn đếm ngày làm việc ([Smartsheet community - Symbols based on Due Dates](https://community.smartsheet.com/discussion/94059/symbols-based-on-due-dates) [chỉ snippet, cộng đồng]). Ngưỡng nằm trong công thức của từng sheet, không được quản trị tập trung và không có phiên bản.
- Monday: cột Status do người dùng đặt; muốn "Late" tự động phải dùng automation "when date arrives and status is not Done" hoặc công thức rồi sao chép; ngày bị đẩy lùi trước khi đến hạn làm logic sai ([Monday community - Tracking late or delayed items](https://community.monday.com/t/tracking-late-or-delayed-items/123439) [chỉ snippet, cộng đồng]).
- ClickUp: không có RAG tự tính theo ngày trong nguồn đã tìm được [không tìm được nguồn chính thức].

#### 3.5 Workload và capacity
- Asana Workload: chọn đo effort theo số task, % phân bổ, thời gian ước lượng, thời gian thực, hoặc custom field; mặc định là số task; capacity đặt theo người, hàng tuần; ước lượng không tự điền; có ở gói Advanced trở lên ([Workload compare mode](https://help.asana.com/s/article/workload-compare-mode) [chỉ snippet]; [Capacity planning](https://help.asana.com/s/article/capacity-planning) [chỉ snippet]).
- ClickUp Workload: capacity tuần = tổng các ngày làm việc của người đó; đặt giờ cho từng ngày; phàn nàn: lịch 32 giờ T2-T5 bị rải thành 6,4 giờ/ngày trên 5 ngày ([Measure availability or capacity in Workload view](https://help.clickup.com/hc/en-us/articles/30799838221335-Measure-availability-or-capacity-in-Workload-view) [chỉ snippet]; [Set workload capacity per day](https://feedback.clickup.com/feature-requests/p/set-workload-capacity-per-day) [chỉ snippet, cộng đồng]).
- Jira Plans: Kanban lập lịch trên capacity cố định "200 giờ" mỗi tuần, không đổi được; không ghi đè issue trong sprint đang chạy ([Auto-schedule issues](https://confluence.atlassian.com/jirasoftwareserver101/auto-schedule-issues-in-advanced-roadmaps-1455426643.html) [đã đọc]).
- Smartsheet critical path và baseline: xem mục 3.6.

#### 3.6 Baseline, critical path, ngày làm việc ở các công cụ nhẹ
- Smartsheet: một sheet chỉ có một baseline (Baseline Start, Baseline Finish, Variance); chỉ Owner/Admin tạo/sửa baseline; nhật ký hoạt động không ghi thay đổi baseline (chỉ cell history); critical path đỏ trên Gantt, tính lại tự động; có thêm summary path và driving path ([Use baselines and critical path](https://help.smartsheet.com/learning-track/project-setup-and-configuration/use-baselines-and-critical-path) [đã đọc]).
- Smartsheet ngày làm việc: ngày/ngày lễ không làm việc bị loại khỏi duration (chỉ khi bật dependencies); task có thể bắt đầu nhưng không thể kết thúc vào ngày không làm việc; mặc định 8 giờ/ngày; cài đặt cấp tài khoản chỉ áp cho sheet mới ([Define working days](https://help.smartsheet.com/articles/516392-define-working-days-sheet) [đã đọc]).

### 4. Xây dựng: Procore, Autodesk Build, Fieldwire

#### 4.1 Tách "schedule" và "task"
- Procore: tool Schedule nhập lịch từ MS Project, P6, MPX và hiển thị theo ngày/tuần/tháng/Gantt, có tab Lookaheads; trang chính thức không nói task type, dependency, phần nào chỉ đọc, hay quan hệ với tool Tasks; đây là bản "legacy", có bản hiện đại hóa riêng ([Project Schedule - Overview](https://support.procore.com/products/online/user-guide/project-level/schedule/overview) [đã đọc]). Một bài so sánh bên thứ ba nói Schedule là P6/MSP chỉ đọc kèm lookahead rời, hoặc Gantt đơn giản tự dựng; chưa kiểm chứng ([Planera - Procore alternatives](https://planera.io/post/procore-alternatives) [chỉ snippet, bên thứ ba]).
- Autodesk Build: Schedule là bản nhập từ P6/MSP/Asta Powerproject hiển thị Gantt, có version control để so sánh các bản lịch, mỗi activity liên kết đến đối tượng khác trong nền tảng; Workplan là lớp thực thi cho giám sát/tổ trưởng, kéo activity từ Schedule vào plan, có cam kết (committed task chỉ người có quyền mới đổi), chỉ số Percent Plan Complete và nguyên nhân trễ; hệ thống cho thấy khi plan lệch khỏi schedule ([About Schedule and Workplan](https://help.autodesk.com/cloudhelp/ENU/Build-Schedule/files/About_Schedule.html) [đã đọc]).
- Fieldwire: định vị là công cụ lập kế hoạch ngắn hạn tại hiện trường chạy cạnh công cụ giữ master schedule; lookahead = 3-6 tuần cập nhật hằng tuần với mọi trade, mục đích chính là gỡ ràng buộc; khuyên đưa mua sắm (buyout, submittal, giao hàng) vào lịch như activity thật ([Fieldwire blog - scheduling software](https://www.fieldwire.com/blog/construction-management-scheduling-software/) [đã đọc, blog hãng]). Trang help Gantt của Fieldwire trả 403 nên chỉ có snippet: Gantt cho đổi ngày bắt đầu/kết thúc trực tiếp; dependency chỉ thấy từ bài tổng hợp bên thứ ba, chưa kiểm chứng.
- Kết luận chung: ba hãng đều coi lịch CPM (có float, dependency) và việc hiện trường (task, lookahead, cam kết) là hai tầng; tầng dưới "nhìn thấy" lệch với tầng trên chứ không tự ghi đè lên tầng trên.

#### 4.2 Hạn submittal / RFI
- Procore Submittal: "Submittal Schedule Calculations" tính lùi: Planned Return Date = Required On-Site Date - Lead Time; Planned Internal Review Completed = Planned Return - Design Team Review Time; Planned Submit By = Planned Internal Review Completed - Internal Review Time; các trường này chỉ để tham khảo, không đồng bộ với hạn của workflow, và giả định không có vòng sửa ([Best Practices: Submittal Project Configurations](https://support.procore.com/products/online/user-guide/project-level/submittals/best-practices-submittals/best-practices-submittal-project-configurations) [đã đọc]).
- "Dynamic Due Dates": bước workflow định nghĩa bằng thời lượng, khi bước xong thì hạn bước kế tiếp dời tới nếu bước trước trễ, dời lùi nếu bước trước sớm; hạn workflow theo "Working Days" của dự án; nhắc email quá hạn dừng sau 45 ngày quá hạn; sau khi workflow xong, ball-in-court về Submittal Manager không có hạn nên phải thêm Submittal Manager làm bước cuối nếu muốn ép hạn (cùng trang).
- Procore RFI: hạn = số ngày lịch kể từ ngày tạo (admin đặt), tôn trọng ngày làm việc của dự án; tùy chọn nhắc email hằng ngày cho assignee khi quá hạn, dừng sau 45 ngày; trang không nêu giá trị mặc định (glossary nói 3 ngày, chưa xác nhận) ([Configure Advanced Settings: RFIs](https://support.procore.com/products/online/user-guide/project-level/rfi/tutorials/configure-advanced-settings-rfis) [đã đọc]).
- Autodesk Build: không tìm được tài liệu chính thức về công thức hạn submittal; diễn đàn ý tưởng yêu cầu chọn ngày làm việc/ngày lịch cho mọi hạn và hạn riêng cho từng bước, nghĩa là hiện chưa có ([Autodesk forum - calendar and working days option in Build submittals](https://forums.autodesk.com/t/bim-360-ideas/calendar-and-working-days-option-in-build-quot-submittals-quot/idi-p/12275200) [chỉ snippet, cộng đồng]).

#### 4.3 Mẫu quy trình duyệt
- Procore dùng workflow template cho submittal: bước gán cho người cụ thể, không được để trống, nên phải tạo mẫu mới khi đổi nhà thầu; mẫu không có bước Submitter dùng lại được cho nhiều Responsible Contractor (cùng trang Best Practices).

### 5. Cách tiếp cận chung: RAG, dung sai, SPI, thang leo thang

#### 5.1 PRINCE2
- Dung sai (tolerance) đặt trước ở cấp dự án và cấp giai đoạn (có thể cả work package) cho các mục tiêu: thời gian, chi phí, chất lượng, phạm vi, lợi ích, rủi ro, (PRINCE2 7 thêm bền vững). Ví dụ minh họa của nguồn: dự án chi phí +-10%, thời gian +-1 tháng; giai đoạn chi phí +-5%, thời gian +-2 tuần - chỉ là ví dụ, không bắt buộc ([Knowledge Train - exception management](https://knowledgetrain.co.uk/project-management/exception-management) [chỉ snippet]; [PRINCE2 Wiki - Exception report](https://prince2.wiki/management-products/exception-report) [đã đọc, wiki không chính thức]).
- Leo thang theo DỰ BÁO chứ không chờ vi phạm: khi dự báo vượt dung sai, quản lý dự án lập Exception Report gửi Ban dự án, kèm tùy chọn và khuyến nghị; Ban dự án quyết định (gỡ vấn đề, Exception Plan thay thế, điều chỉnh mục tiêu, chấp nhận concession, đóng giai đoạn sớm) (cùng trang). Trang AXELOS chính thức tải về không có thân bài nên chưa trích được văn bản gốc.
- Ý nghĩa cho hệ thống: người đặt dung sai (Ban dự án/cấp trên) khác người báo cáo (quản lý dự án) - tương đồng yêu cầu "người duyệt khác tác giả".

#### 5.2 PMBOK và SPI
- Schedule Management Plan nêu variance threshold / control threshold cho độ lệch so với baseline; ví dụ mẫu dùng 10% hoặc 15%, hoặc "vượt ngưỡng 3 tuần liên tiếp" là điều kiện kích hoạt; không tìm được bản văn PMI chính thức, chỉ có diễn đàn/mẫu ([ProjectManagement.com - control threshold](https://www.projectmanagement.com/discussion-topic/152436/control-threshold) [chỉ snippet, cộng đồng]).
- SPI = EV/PV; 1,0 đúng tiến độ. Mẫu ngưỡng của FEMA (theo snippet, chưa đọc được trang gốc do lỗi kết nối): xanh 0,95-1,05; vàng 0,90-<0,95 hoặc >1,05-1,10; đỏ < 0,90 hoặc > 1,10. Infor: vàng 0,95-0,99, đỏ < 0,95. Birdview: ngưỡng mặc định 1. Cho thấy mỗi tổ chức tự đặt ngưỡng ([FEMA MIP dashboard FAQ](https://hazards.fema.gov/femaportal/usercare/faq/dash02.htm) [chỉ snippet]; [Infor LN - Overall Project Performance](https://docs.infor.com/ln/10.5/en-us/lnolh/help/tp/onlinemanual/bi/000379.html) [chỉ snippet]).
- Giới hạn của SPI cổ điển: tính theo giá trị, không theo đường tới hạn (SPI cao vẫn có thể trễ critical path) và về cuối dự án luôn tiến về 1; vì vậy kết hợp CPLI/BEI của DCMA (mục 2.7) hoặc Earned Schedule.

#### 5.3 Quy tắc "số ngày trước hạn" và thang leo thang
- Dạng "5/2/1 ngày" (vàng từ còn 5 ngày, đỏ từ còn 2, đỏ đậm từ 1) không có chuẩn công bố; tìm thấy ví dụ cùng loại: Smartsheet cộng đồng dùng vàng khi còn <= 3 ngày; Jira dùng JQL theo startOfDay("+Nd"). Đây là cấu hình do người dùng tự viết trong mọi công cụ, không phải tham số quản trị có kiểm soát.
- Thang theo phần trăm thời gian đã trôi (SLA): mẫu 50% cảnh báo, 75% leo thang, 100% vi phạm trong ServiceNow là cấu hình phổ biến, không phải mặc định tài liệu hóa ([ServiceNow community - SLA breach notifications](https://www.servicenow.com/community/itsm-articles/how-to-trigger-sla-breach-notifications-in-servicenow-and-show/ta-p/3499319) [chỉ snippet, cộng đồng]). Lưu ý: ngưỡng phần trăm tự co giãn theo độ dài task, ngưỡng "số ngày" thì không.
- Nhắc việc có trần: Procore dừng nhắc sau 45 ngày quá hạn (mục 4.2); Smartsheet tối đa 365 ngày trước/sau ngày mốc.

#### 5.4 Ngày làm việc ở Việt Nam
- Điều 112 Bộ luật Lao động 2019: các ngày nghỉ lễ, Tết hưởng nguyên lương; khoản 3 giao Thủ tướng Chính phủ ấn định cụ thể lịch nghỉ Tết Âm lịch và Quốc khánh theo từng năm; nếu ngày nghỉ hằng tuần trùng ngày lễ thì nghỉ bù vào ngày làm việc kế tiếp. Nguồn thứ cấp lệch nhau về số ngày (11 hay 12 tùy có tính ngày 24/11 theo nghị quyết 80-NQ/TW hay không) ([Luật Việt Nam - tổng hợp ngày nghỉ lễ, Tết](https://luatvietnam.vn/linh-vuc-khac/tong-hop-cac-ngay-nghi-le-tet-883-104127-article.html) [chỉ snippet, thứ cấp]; [Thư viện pháp luật - nghỉ bù](https://thuvienphapluat.vn/lao-dong-tien-luong/khi-nao-nguoi-lao-dong-duoc-nghi-bu-le-21536.html) [chỉ snippet, trang trả 403]). Không tìm được văn bản chính thức nói về "hoán đổi ngày làm việc"; cần kiểm tra văn bản gốc trước khi chốt dữ liệu lịch.
- Hệ quả: lịch làm việc là dữ liệu có hiệu lực theo thời gian, do cơ quan nhà nước công bố hằng năm, thay đổi sau khi dự án đã lập lịch.

### 6. Bảng so sánh (hệ thống x tính năng)

Ký hiệu: Có = có tài liệu chính thức; Phần = có nhưng giới hạn; Không = không thấy; ? = không xác minh được.

| Tính năng | MS Project | P6 | Asana | Jira Plans | Monday | Smartsheet | ClickUp | Procore | Autodesk Build | Fieldwire |
|---|---|---|---|---|---|---|---|---|---|---|
| Template -> lịch từ ngày bắt đầu | Có (ngày lưu trong template) | ? (copy dự án) | Phần (1 mỏ neo start hoặc due) | Không | ? | Phần (template giữ working days) | Phần (remap theo due) | Phần (due mặc định theo cấu hình) | Phần (due mặc định) | ? |
| FS/SS/FF/SF | Có | Có | Phần | Phần (link Blocks) | Có (qua UI) | Có | Phần | Không rõ | Không rõ | ? |
| Lead/lag | Có (lịch của lag không nêu) | Có, 4 lựa chọn lag calendar | Không | Không | Có (Strict) | Có, chỉ ngày làm việc | ? | Không | Không | ? |
| Constraint ngày (8 loại) | Có | Có (nhiều loại) | Không | Không | Không | Không | Không | Không | Không | Không |
| Cascade dời lịch tự động | Có (auto) | Có | Phần (chỉ khi chồng lấn) | Phần (auto-scheduler, hai bước duyệt) | Phần (Flexible/Strict) | Có | Phần (cùng lượng) | Phần (hạn bước workflow) | ? | ? |
| Critical path / float | Có | Có (+ multiple float paths) | Không | Không | Không | Có (critical path) | Không | Qua file nhập | Qua file nhập | Không |
| Baseline | 11 | Không giới hạn, chọn 2 để so | Không | Không | Không | 1 | Không | Qua phiên bản file | Phiên bản lịch | Không |
| Status date / % complete | Có | Có (3 kiểu %) | Không | Không | Không | % Complete | Không | Có | Có (Percent Plan Complete) | Có |
| Calendar (project/task/resource) | 3 cấp | Global/project/resource | Chỉ bỏ cuối tuần | Không | Không | Cấp sheet/tài khoản | Giờ theo ngày | Working Days dự án | ? | ? |
| Ngưỡng nhắc "N ngày trước hạn" | Chỉ báo Missed Deadline | Không | Không | JQL (tự viết) | Automation, giờ cố định | Alert x ngày trước (tới 365) | Thiếu offset | Email quá hạn, dừng 45 ngày | ? | ? |
| RAG tự tính theo ngày | Cột Status On Schedule/Late | Không | Thủ công | Không | Qua công thức | Symbols qua công thức | ? | Không | Không | Không |
| Workload/capacity | Qua resource | Có | Có (Advanced+) | Có | Có | Có | Có | Có | Có | Manpower |
| Sửa/xóa lịch sử | Baseline sửa được | Baseline phải restore để sửa, có quyền riêng | Status update không sửa được | - | - | Baseline chỉ Owner/Admin, không vào activity log | - | - | Committed task có quyền | - |

Ghi chú: một số ô "?" do trang trợ giúp trả 403 hoặc không có thân bài; không điền suy đoán.

### 7. Điều người dùng hay phàn nàn (tổng hợp có nguồn)
- Gõ tay ngày làm phát sinh ràng buộc ngầm (MS Project tự thêm constraint) và ngày "tính" lẫn "gõ" (manual task, Smartsheet gỡ liên kết predecessor khi ghi đè).
- Cascade không đối xứng: Asana chỉ dời khi chồng lấn; ClickUp không kéo sớm; Monday Flexible không dời lùi.
- Lag khó hiểu: P6 lag calendar toàn cục; Smartsheet không elapsed lag; Monday lag "mờ đục".
- Nhắc việc: giờ cố định cho mọi item (Monday), nhắc lặp/sai ngày (Smartsheet), thiếu offset (ClickUp), phải tự viết JQL (Jira).
- Ngưỡng RAG nằm rải rác trong công thức từng sheet, không có đơn vị quản trị, không phiên bản (Smartsheet, Monday).
- Baseline: sửa được tự do (MS Project), không vào log (Smartsheet), chỉ một cái (Smartsheet), hoặc phải "restore" mới sửa được (P6, cách làm tốt nhất).
- Lịch cố định trong template lệch khi ngày lễ thay đổi hằng năm (không công cụ nào đề cập ngày lễ biến động theo từng năm).

### 8. Rút ra cho hệ thống (bên lập lịch và cảnh báo)

1. ADOPT: tính ngày bằng lịch "ngày làm việc" cấp dự án, có phiên bản và theo hiệu lực (từ Smartsheet "task không thể kết thúc vào ngày nghỉ", Procore "Working Days dự án", P6 calendar kế thừa ngày lễ). Lý do: Điều 112 BLLĐ cho phép Thủ tướng ấn định lịch nghỉ Tết/Quốc khánh hằng năm, lịch đổi sau khi dự án đã lập; ngày lễ phải là dữ liệu có phiên bản, không bao giờ sửa tại chỗ, và kết quả tính ngày phải ghi lại phiên bản lịch đã dùng.
2. ADOPT: tách "lịch kế hoạch" (baseline bất biến) khỏi "lịch dự báo" (bị tính lại khi trễ), như P6 (project baseline cần quyền riêng, muốn sửa phải restore) và Autodesk Build (version lịch, hiển thị lệch giữa plan và schedule). REJECT mô hình MS Project cho sửa baseline "bất cứ lúc nào" và Smartsheet "baseline không vào activity log"; baseline hệ thống chỉ thêm phiên bản mới, người duyệt khác người lập, không ghi đè.
3. ADOPT: lưu ngày kế hoạch (planned), ngày dự báo (forecast), ngày thực tế (actual) là ba loại sự kiện riêng; actual là sự kiện bất biến (chỉ bổ sung bản đính chính có lý do) - từ P6 "Actual Dates" và Asana "status update không sửa, chỉ tạo/xóa". REJECT cách MS Project gom ba loại vào cùng trường bị tính lại.
4. ADOPT: ngưỡng RAG do người dùng đặt (số ngày trước hạn cho vàng/đỏ) lưu thành "bộ quy tắc ngưỡng" có phiên bản, duyệt bởi người khác tác giả, có hiệu lực từ ngày X, kèm phạm vi (toàn hệ thống / loại dự án / dự án / loại task) - từ ý tưởng "critical nếu slack <= N" của MS Project/P6 và dung sai đặt trước của PRINCE2. REJECT mô hình Smartsheet/Monday công thức rải rác từng sheet, không phiên bản, không kiểm soát.
5. ADOPT: ngưỡng tính bằng NGÀY LÀM VIỆC mặc định (tùy chọn theo ngày lịch) và lưu đơn vị trong quy tắc; REJECT đếm ngày lịch thầm lặng. Lý do: Smartsheet phải dùng NETWORKDAYS thủ công, ClickUp thiếu offset theo ngày làm việc, tránh cảnh báo "đỏ" rơi vào cuối tuần/Tết.
6. ADOPT: màu tính từ "số ngày làm việc còn lại tới hạn" và trạng thái task, theo thứ tự rõ ràng (hoàn thành, quá hạn, đỏ, vàng, xanh) và có màu thứ tư "xám/chưa lập lịch"; không để task chưa có ngày hiển thị xanh (bài học Monday: "dependencies chỉ dời ngày đã có"). Ghi quy tắc phiên bản nào đã chấm màu để có thể truy vết.
7. ADOPT: nhắc theo "thang leo thang" gồm nhiều bậc (vd bậc nhắc người thực hiện, bậc báo người phụ trách, bậc báo cấp duyệt), mỗi bậc có ngưỡng, kênh, người nhận và trần số lần/ngày dừng nhắc - từ Procore (nhắc quá hạn hằng ngày, dừng sau 45 ngày), PRINCE2 (leo thang theo dự báo, Exception Report), ServiceNow (mẫu phần trăm). REJECT Monday "giờ cố định cho mọi item" và Jira "tự viết JQL cho từng rule".
8. ADOPT: cảnh báo dựa trên DỰ BÁO (ngày forecast vượt hạn hoặc vượt dung sai) chứ không chỉ khi quá hạn - từ PRINCE2 và từ phàn nàn về chỉ báo "Missed Deadline" của MS Project chỉ hiện khi đã trễ. Đi kèm Exception Report: nội dung, phương án, người quyết định, lưu thành sự kiện bất biến.
9. ADOPT: dependency cho FS/SS/FF/SF có lead/lag nhưng lag lưu kèm loại lịch (làm việc hay lịch/elapsed) và đơn vị - từ P6 lag calendar (4 lựa chọn) và phàn nàn Smartsheet "không có lag theo ngày lịch" (cần cho thời hạn pháp lý, ví dụ số ngày kể từ ngày công bố). REJECT cấu hình lag toàn cục của P6 (cùng lag cho kết quả khác nhau giữa cài đặt); lag phải là thuộc tính của từng quan hệ.
10. ADOPT: tập constraint rút gọn (không sớm hơn ngày X, không muộn hơn ngày Y, và deadline pháp lý chỉ báo) thay vì đủ 8 loại; deadline và constraint là hai khái niệm tách biệt như MS Project (deadline không đổi lịch, constraint thì có). REJECT MSO/MFO cứng tự động thắng dependency (sinh negative slack âm thầm) và REJECT việc tự thêm constraint khi người dùng gõ tay ngày (cạm bẫy MS Project); ghi đè tay phải là một "override" có lý do, người duyệt, thời hạn hiệu lực.
11. ADOPT: tính float (total/free) và đường tới hạn có phân tầng như P6 (longest path + ngưỡng float + multiple float paths đến một milestone, như milestone phê duyệt/nghiệm thu) để xếp hạng mức độ ưu tiên cảnh báo; làm bước sau (không cần ở bản đầu). REJECT chỉ dùng SPI cổ điển (chỉ một con số giá trị, về cuối dự án luôn tiến về 1); dùng thêm kiểm tra kiểu DCMA (thiếu logic, lead, hard constraint, float âm, task quá dài).
12. ADOPT: cascade dời lịch là một hành động có xem trước và duyệt, không tự ghi: tính "phương án dời lịch" (preview, như Jira Plans Accept/Review changes hai bước; Asana modal xem trước), người có quyền duyệt rồi mới ghi thành phiên bản lịch dự báo mới. REJECT cascade tự ghi ngầm (ClickUp/Monday) và cách Asana chỉ dời khi chồng lấn; cho chọn chế độ "giữ khoảng đệm" hoặc "tiêu thụ khoảng đệm" (Asana maintain/consume buffer) làm tham số của quy tắc dời lịch.
13. ADOPT: tiến độ không theo thứ tự cần chính sách rõ (retained logic hay override) lưu theo dự án/phiên bản quy tắc, như P6; mặc định retained logic, vì hợp đồng/chủ đầu tư hay yêu cầu; REJECT việc để người dùng đổi chính sách giữa chừng mà không để lại dấu vết kiểm toán.
14. ADOPT: mẫu quy trình (template) lưu thời lượng, quan hệ và mốc theo "số ngày làm việc từ mốc neo" với NHIỀU mỏ neo được đặt tên (ngày bắt đầu chuẩn bị, ngày phê duyệt, ngày khởi công...) - khắc phục giới hạn Asana "một mỏ neo" và ClickUp "remap theo due". Template có phiên bản; mỗi dự án ghi phiên bản template đã dùng. REJECT sao chép template thành bản riêng rồi không còn liên hệ với gốc.
15. ADOPT: tách tầng "lịch pháp lý/kế hoạch" (milestone, phê duyệt, nghiệm thu, tính theo mẫu) và tầng "nhiệm vụ/hồ sơ" (task, biểu mẫu, KPI, giao việc) - mô hình hai tầng của Autodesk Build (Schedule/Workplan), Fieldwire (master schedule/lookahead), Procore (Schedule/Tasks). Tầng dưới hiển thị độ lệch với tầng trên, không tự ghi đè lên tầng trên.
16. ADOPT: hạn của từng bước duyệt kiểu "Dynamic Due Dates" của Procore (hạn bước kế tiếp = ngày hoàn thành bước trước + thời lượng quy định, theo ngày làm việc) cho quy trình ký/phê duyệt văn bản pháp lý; và tính lùi kiểu "Submittal Schedule Calculations" (ngày cần có - thời gian xử lý - thời gian duyệt) để gợi ý hạn nộp hồ sơ. REJECT cách Procore chỉ để tính lùi "tham khảo, không đồng bộ với hạn thật" (tạo hai nguồn sự thật); hệ thống phải có một nguồn sự thật cho hạn.
17. ADOPT: tính mọi ngày deadline bằng một bộ máy lập lịch xác định (deterministic): cùng đầu vào (ngày bắt đầu, template phiên bản, lịch làm việc phiên bản, quy tắc) cho cùng kết quả, lưu đầu vào để tái hiện; có kiểm tra vòng lặp dependency phía máy chủ (Monday API không kiểm, buộc client tự làm) và giới hạn kích thước (tham chiếu Project for the web: 3000 task, 20 link/task) để tránh dự án quá lớn.
18. ADOPT: chỉ số năng lực/khối lượng (workload) chỉ tham chiếu ở bản đầu, lưu ước lượng công theo từng người và năng lực theo lịch làm việc - từ Asana/ClickUp; REJECT effort-driven và 3 loại task type của MS Project (nhiều tổ hợp khó đoán, nhiều phàn nàn); REJECT tự động cân bằng nguồn lực (resource leveling) ở phiên bản đầu.
19. ADOPT: nhật ký kiểm toán cho mọi thay đổi ngày/quy tắc/ngưỡng/lịch (ai, lúc nào, giá trị cũ, giá trị mới, lý do, người duyệt) - từ khoảng trống Smartsheet (baseline không vào activity log) và P6 (quyền riêng khi đặt baseline). Mọi bản ghi "đã tính màu" và "đã gửi cảnh báo" cũng là sự kiện bất biến để trả lời "vì sao hôm đó hệ thống báo đỏ".
20. ADOPT (mở rộng được): mọi "loại quy tắc" (tính ngày, ngưỡng RAG, bậc leo thang, kênh nhắc, chính sách dời lịch) đăng ký qua một giao diện/lược đồ chung có phiên bản để thêm loại mới mà không sửa lõi; REJECT cách của Jira/Smartsheet/Monday nơi mỗi nhu cầu mới là một công thức hay JQL riêng.

### 9. Chủ đề không tìm được nguồn chính thức hoặc chưa kiểm chứng
- ClickUp: trang trợ giúp chính thức (Reschedule Dependencies, Intro to scheduling, Task durations in templates) trả HTTP 403; thông tin lấy từ snippet và bảng góp ý. RAG tự tính của ClickUp: không tìm thấy nguồn.
- Asana: bài help chính thức "Auto-shifting dates for dependent tasks" tải về không có thân bài; chế độ buffer chỉ có từ snippet.
- Monday: trang support chính thức trả 403; chỉ có tài liệu API (đã đọc) và cộng đồng.
- Jira: không có nguồn chính thức nào về trigger due-date trên Cloud (bài KB chỉ cho Data Center); Plans Cloud không có tài liệu rõ về quy tắc ngày của dependency.
- Smartsheet: không tìm thấy trang chính thức về RAG theo ngày; chỉ có bài cộng đồng.
- Procore: không có mô tả chính thức về quan hệ giữa Schedule và Tasks; Autodesk Build: không tìm được công thức hạn submittal chính thức; Fieldwire: trang help trả 403, chỉ có blog hãng.
- PMBOK/PMI: không tiếp cận được văn bản chính thức; ngưỡng SPI (FEMA/Infor/Birdview) chỉ từ snippet vì trang FEMA lỗi kết nối.
- DCMA: dùng mô tả của vendor Deltek Acumen, không phải tài liệu DCMA gốc; các nguồn khác nhau nêu ngưỡng khác nhau (ví dụ "missing logic" 0% hay 5%).
- Ngày nghỉ Việt Nam: chỉ có nguồn thứ cấp; cần đối chiếu văn bản chính thức (BLLĐ 2019, thông báo hằng năm của Chính phủ).
- Quy tắc "5/2/1 ngày": không có chuẩn công bố; chỉ là thông lệ cấu hình.


## Phần B. KPI quy trình và chấm điểm nhân sự

Ngày nghiên cứu: 2026-11-12. Phạm vi: tài liệu chính thức/nguồn gốc của OKR, BSC, KPI, các hệ HRIS (SAP, Workday, Lattice, 15Five, Culture Amp, Betterworks), các bẫy công bằng, tiền lệ đo lường phần mềm và dự án.

Quy ước độ tin cậy: [ĐỌC] = đã mở và đọc trang; [TÌM] = chỉ thấy qua kết quả tìm kiếm tổng hợp, chưa đọc trang gốc; [KHÔNG ĐỌC ĐƯỢC] = trang trả 403/404, URL chỉ để tra cứu thêm. Ghi chú: một số trang văn bản pháp luật (hethongphapluat.com) có nhúng đoạn chỉ dẫn lạ trong nội dung trang; đã bỏ qua và chỉ dùng nội dung điều luật.

### 1. OKR (Google re:Work, Doerr)

Sự kiện đã xác nhận [ĐỌC] từ [Google re:Work - Set goals with OKRs](https://rework.withgoogle.com/en/guides/set-goals-with-okrs):
- Thang chấm 0.0-1.0 cho từng key result; điểm objective là "trung bình thô" của các KR, đôi khi có trọng số. KR nhị phân chấm 0 hoặc 1; KR chi tiết cho điểm từng phần (0.5 nếu 3/6 tính năng).
- "Điểm ngọt" 0.6-0.7. Liên tục đạt 1.0 nghĩa là OKR chưa đủ tham vọng.
- 3-5 objective, mỗi objective khoảng 3 KR; KR là kết quả đầu ra, không phải hoạt động; OKR công khai; check-in giữa quý và cuối quý.
- Google nói rõ OKR "không đồng nghĩa với đánh giá nhân sự" (not synonymous with performance evaluation).
- Cảnh báo chính thức: sandbagging (đặt thấp để luôn đạt), OKR "business as usual", objective có thể đạt 1.0 mà không tạo giá trị, OKR bị dùng như checklist.

Về tách OKR khỏi lương thưởng [TÌM]: các bản tóm tắt Measure What Matters (Doerr, chương 15) nêu "tách OKR khỏi thưởng để khuyến khích rủi ro và tránh sandbagging". Betterworks cân bằng lại: Doerr tách khỏi lương nhưng không nhất thiết bỏ OKR khỏi đánh giá ([Betterworks - OKRs and compensation](https://blog.betterworks.com/okrs-and-compensation/), [Tability - Why we don't tie OKR outcomes to performance reviews](https://www.tability.io/odt/articles/why-we-dont-tie-okr-outcomes-to-performance-reviews)). Chưa tự mở sách gốc để trích nguyên văn.

ADOPT: mô hình "mục tiêu + kết quả đo được + bằng chứng dễ tìm"; điểm từng phần; chấm KPI công khai cho người liên quan.
REJECT: thang "0.7 là tốt" và triết lý stretch goal làm điểm nhân sự. Trong dự án đầu tư công, hạn và dự toán là cam kết pháp lý, không phải mục tiêu tham vọng; chấm nhân sự bằng điểm "stretch" sẽ khuyến khích đặt thấp hoặc đặt cao tùy lợi ích.

### 2. Balanced Scorecard (Kaplan và Norton)

- Bốn góc nhìn: Tài chính, Khách hàng, Quy trình nội bộ, Học hỏi và tăng trưởng; mỗi góc nhìn có mục tiêu, thước đo, chỉ tiêu (target) và sáng kiến (initiative) ([Wikipedia - Balanced scorecard](https://en.wikipedia.org/wiki/Balanced_scorecard) [ĐỌC]; bài gốc [HBR 1992 - The Balanced Scorecard](https://hbr.org/1992/01/the-balanced-scorecard-measures-that-drive-performance-2) chỉ đọc được phần dẫn: "What you measure is what you get", thước đo định hình hành vi).
- Phân biệt: KPI/thước đo + target = "đang ở đâu so với đích" (kết quả); initiative = tập hành động tác động lên thước đo. Strategy map nối nhân quả giữa các mục tiêu, thước đo chọn 1-2 cho mỗi mục tiêu.
- Phê bình [ĐỌC]: thiếu kiểm chứng chặt; KHÔNG có điểm tổng hợp duy nhất (người quản lý phải tự diễn giải); thiên về doanh nghiệp tư nhân, khớp kém với khu vực công/phi lợi nhuận.

ADOPT: tách "KPI (đo kết quả có target)" khỏi "task/initiative (hành động)"; mỗi KPI phải truy được về một mục tiêu (strategy-map style); đa chiều (hạn, chi phí, chất lượng/hồ sơ, tái làm) thay vì một số duy nhất.
REJECT: góc nhìn Tài chính làm trọng tâm; ép một điểm tổng hợp duy nhất không kèm cơ cấu thành phần (hệ thống vẫn tính điểm kỳ nhưng luôn hiển thị phân rã).

### 3. Thiết kế KPI: SMART, leading và lagging, RAG

- SMART: Doran 1981, Management Review 70(11): bản gốc là Specific, Measurable, Assignable, Realistic, Time-related; Doran lưu ý không phải mục tiêu cấp quản lý nào cũng lượng hóa được ([Project Smart - A brief history of SMART goals](https://www.projectsmart.co.uk/brief-history-of-smart-goals.php) [TÌM]; chưa đọc bài gốc). Chữ A gốc là "Assignable" (có người chịu trách nhiệm) - đúng với assignment ledger của hệ thống.
- Leading (tín hiệu sớm, tác động được) và lagging (xác nhận kết quả muộn) nên dùng cùng nhau ([BMC - Leading vs lagging indicators](https://blogs.bmc.com/leading-vs-lagging-indicators/) [TÌM]). Trong workflow: "số ngày dự kiến trễ" và "tỷ lệ hồ sơ đủ ở bước đầu" là leading; "độ lệch ngày hoàn thành thực tế" và "số lần trả về" là lagging.
- RAG: Đỏ/Vàng/Xanh; khuyến nghị tham khảo là dải vàng khoảng 10% quanh target, có thể siết 3-5% hoặc nới 20%, và phải ghi tài liệu hóa tiêu chí ([ClearPoint - Establish RAG statuses for KPIs](https://www.clearpointstrategy.com/blog/establish-rag-statuses-for-kpis) [TÌM]). KHÔNG tìm được tiêu chuẩn thẩm quyền (PMI hay chính phủ) về ngưỡng RAG; đây là hướng dẫn của một vendor.
- Lattice dùng 3 trạng thái mặc định On track, Progressing, Off track, quản trị viên đổi tên được, tối đa 3 ([Lattice - Customize goal status definitions](https://help.lattice.com/en-us/articles/16542146-customize-goal-status-definitions) [TÌM]).

ADOPT: RAG là lớp HIỂN THỊ suy ra từ điểm/ngưỡng của KPI, ngưỡng nằm trong rule version có phê duyệt; mỗi KPI mang cờ leading/lagging; mỗi KPI có "assignee" rõ.
REJECT: RAG nhập tay do người quản lý chọn (không kiểm chứng, dễ thiên vị).

### 4. SAP SuccessFactors (Performance & Goals)

Không đọc được SAP Help Portal; các điểm dưới là từ các bài Knowledge Base và blog SAP qua tìm kiếm [TÌM]. Nguồn: [SAP KB 2525218](https://userapps.support.sap.com/sap/support/knowledge/en/2525218), [SAP KB 2435115](https://userapps.support.sap.com/sap/support/knowledge/en/2435115), [SAP blog - Calculator rules and metric lookup tables in the goal plan](https://blogs.sap.com/2022/06/13/calculator-rules-and-metric-lookup-tables-in-the-goal-plan/) [KHÔNG ĐỌC ĐƯỢC, 403], [SAP Learning - Configuring performance form sections for calibration](https://learning.sap.com/courses/sap-successfactors-calibration-administration-br/configuring-performance-form-sections-for-calibration) [KHÔNG ĐỌC ĐƯỢC, 404].
- Điểm section = trung bình có trọng số: sum(điểm mục tiêu x trọng số) / sum(trọng số); cấu hình "auto populate goal weights" - nếu không bật, form có thể coi trọng số bằng nhau hoặc bằng 0 (lỗi hay gặp).
- Chuẩn hóa thang (normalize) khi thang của section khác thang tổng: min-max, có thể gây điểm hiển thị khác điểm tính (ví dụ 5.44 thành 6.47) - bài học: chuyển thang phải minh bạch và có công tắc.
- "Calculator rules / metric lookup table": quy đổi giá trị đạt được sang điểm bằng công thức hoặc bảng tra (đây là tiền lệ trực tiếp cho "formula-based rating" và "stepped conversion").
- Điểm tính tự động (calculated) KHÔNG calibrate được vì là điểm hệ thống; điểm tính nằm giữa hai mức được ánh xạ vào bin (ví dụ 2.14 trên thang 1-5 vào bin 3). Có báo cáo calibration finalize ghi đè điểm tổng bằng điểm tính.
- 360: chỉ hỗ trợ công thức trung bình.

ADOPT: trọng số + trung bình có trọng số; bảng tra bậc thang (stepped) làm dữ liệu có version; tách điểm "tính tự động" khỏi điểm "điều chỉnh có duyệt".
REJECT: ghi đè điểm tính bằng một điểm khác mà không lưu cả hai; chuẩn hóa thang ngầm.

### 5. Workday (Performance, Calibration, Talent review 9-box)

Nguồn: [Workday Admin Guide - Reviews with calibration](https://doc.workday.com/admin-guide/en-us/human-capital-management/talent/talent-and-performance-calibration/reviews-with-calibration/zqe1532445263320.html) [ĐỌC], [Workday Education - Calibration](https://doc.workday.com/workday-education/en-us/course-manuals/talent-for-administrators/calibration.html) [ĐỌC].
- Calibration chờ cho tới khi quản lý nộp đánh giá xong (bước "Hold for Review"), nhóm bảo mật hạn chế (khuyến nghị chỉ Talent Administrator); lấy điểm tổng và (tùy chọn) potential.
- nBox (9-box) cấu hình được: trục Performance x Potential, lọc theo tổ chức giám sát/chuỗi quản lý/talent pool; có "target percentage" gợi ý phân phối giữa các ô.
- Quản lý nhận tác vụ "Calibrate Team" và kéo người vào ô; kết quả cuộn lên từng cấp; controller (HR) nộp cuối cùng. Điểm calibrate có thể ghi ngược vào hồ sơ đánh giá; calibrated rating không in trên bản in đánh giá.
- Các trang đọc KHÔNG mô tả audit trail của calibration (không khẳng định có hay không).

ADOPT: luồng "chờ nguồn dữ liệu khóa xong rồi mới điều chỉnh"; phạm vi xem theo cấu trúc tổ chức; người nộp cuối là vai trò khác người đề xuất.
REJECT: ma trận 9-box/potential trong hệ thống (potential là phán đoán chủ quan, không có dữ kiện bất biến); phân phối cưỡng bức theo tỷ lệ.

### 6. Lattice

Nguồn: [Lattice - Calibration (help center)](https://help.lattice.com/hc/en-us/sections/1500002952521-Calibration) [TÌM], [Lattice - Set up calibration in a review cycle](https://help.lattice.com/en-us/articles/15178854-set-up-calibration-in-a-review-cycle) [ĐỌC], [Lattice - July 2024 product updates](https://lattice.com/fr/blog/july-2024-product-updates-lattice-ai-writing-assist-calibration-updates-compensation-cycle-reporting-and-more) [TÌM].
- Calibration bật ở bước Evaluation của review cycle; chỉ calibrate được câu hỏi rating của đánh giá chiều xuống (downward); không có downward review thì không bật được.
- Vai trò facilitator được thêm 2024 để bắc cầu giữa admin và người tham gia; participant xem/tạo/sửa ghi chú, còn reviewee KHÔNG thấy ghi chú/tag calibration của mình. Xuất CSV có trục và tên ô.
- Mục tiêu: trạng thái On track/Progressing/Off track; mục tiêu public ai cũng xem tiến độ; mục tiêu private nguồn mâu thuẫn (chủ + quản lý, hoặc thêm quản lý của quản lý) - xem mục 3.
- Trang đọc được không nói rõ có theo dõi thay đổi điểm (change tracking) hay nhân viên có xem được calibration hay không.

ADOPT: vai trò facilitator tách khỏi admin; ghi chú calibration không hiện cho người được đánh giá (nhưng hệ thống vẫn phải cho người đó thấy MỌI điều chỉnh làm đổi điểm kỳ của mình - mục 14).
REJECT: calibration "ngầm" mà nhân viên không biết điểm đã bị điều chỉnh.

### 7. 15Five

Nguồn: [15Five Help - Get started as an employee](https://success.15five.com/hc/en-us/articles/50989487630363) [ĐỌC], [15Five - BSR field guide for managers](https://go.15five.com/hubfs/BSR%20Field%20Guide%20-%20Managers.pdf) [TÌM], [15Five - Product releases](https://success.15five.com/hc/en-us/articles/50989471559067) [TÌM].
- Check-in hằng tuần (ưu tiên, tâm trạng, vướng mắc); quản lý có thể react, comment, flag, đưa vào 1-on-1. Objective/OKR theo dõi ngay trong check-in, liên kết mục tiêu cha.
- Chu kỳ review: tự đánh giá, đề cử đồng nghiệp, đánh giá đồng nghiệp, nhân viên "acknowledge" kết quả; đánh giá dựa trên check-in đã ghi trong năm (giảm recency bias).
- Có mục "Private Manager Assessment" (sẵn sàng thăng tiến, lương) trong field guide; nhân viên có thể tải review của mình, quản lý/admin xuất hàng loạt. Calibration thuộc gói Perform [TÌM, nguồn đối thủ nên cần kiểm tra lại].
- KHÔNG tìm được tài liệu chính thức mô tả chi tiết quyền riêng tư của check-in/ghi chú riêng.

ADOPT: bước "acknowledge" (nhân viên xác nhận đã xem kết quả) - gắn với quyền phản hồi; nhật ký sự kiện trong kỳ làm cơ sở thay vì trí nhớ cuối kỳ.
REJECT: "Private Manager Assessment" không minh bạch với nhân viên; check-in cảm xúc đưa vào điểm.

### 8. Culture Amp và Betterworks

Culture Amp: [Calibration views](https://support.cultureamp.com/en/articles/10425688-create-and-share-calibration-views) [TÌM], [The science behind ratings preview](https://support.cultureamp.com/en/articles/11710756-the-science-behind-ratings-preview) [ĐỌC], [Rating scale blog](https://blog.cultureamp.com/performance-review-rating-scale) [TÌM].
- Calibration view chỉ đọc, ẩn trường nhân khẩu học và câu hỏi từ chu kỳ trước; mỗi phiên khuyến nghị tối đa 7 calibrator.
- Ratings preview: calibrator xem trước và comment trước cuộc họp; chọn "I support / I abstain / I have questions"; người đổi điểm phải dẫn bằng chứng quan sát được; ghi chú chỉ facilitator xem; có đào tạo calibrator. Dẫn nghiên cứu Speer và cộng sự (2019): calibration làm điểm khớp hơn với chỉ số hiệu suất khác.
- Khảo sát nội bộ: 52% khách hàng dùng thang 4 mức, 31% thang 5 mức; thang chẵn bỏ mức "trung bình" để giảm central tendency.

Betterworks: [Performance review calibration](https://betterworks.com/product/performance-review-calibration), [Calibration minibook](https://www.betterworks.com/wp-content/uploads/2021/04/Calibration_Minibook-1-1.pdf) [TÌM; tài liệu vendor]. Calibration side-by-side với dữ liệu từ mục tiêu, phản hồi, hội thoại chảy vào một view. KHÔNG tìm được tài liệu chính thức về cách Betterworks chấm OKR; một đánh giá 2026 nhận xét thực tế công việc diễn ra ở Jira/Asana nên mục tiêu nhập tay tách rời dữ liệu thật (điều hệ thống tránh vì tính KPI trực tiếp từ sự kiện workflow).

ADOPT: bắt buộc bằng chứng khi đổi điểm; hạn chế người xem; ẩn thuộc tính nhạy cảm; thang có số mức rõ.
REJECT: bỏ phiếu "support/abstain" thay cho phê duyệt có lý do bằng văn bản.

### 9. Bảng so sánh hệ thống x tính năng

| Tính năng | OKR (Google) | BSC | SAP SF | Workday | Lattice | 15Five | Culture Amp | Hệ thống này (đề xuất) |
|---|---|---|---|---|---|---|---|---|
| Nguồn điểm | Tự chấm 0-1 | Thước đo + target | Quản lý nhập hoặc calculator rule | Quản lý nhập | Quản lý nhập | Quản lý/đồng nghiệp | Quản lý nhập | Tính từ sự kiện workflow bất biến |
| Công thức quy đổi | Trung bình thô | Không có điểm tổng | Bảng tra, trọng số | Không nêu | Không nêu | Không nêu | Không nêu | Danh mục công thức an toàn, tuyến tính hoặc bậc thang |
| Trọng số | Tùy chọn | Có (tự thiết kế) | Có, cần bật auto populate | Có | Có | Có | Có | Có, nằm trong rule version |
| Thang điểm | 0.0-1.0 | Tùy | Tùy template (thường 1-5) | Tùy | Tùy | Tùy | 4 hoặc 5 mức | 0-100 hoặc 1-5 quy đổi, ghi rõ |
| Calibration | Không | Không | Có, điểm tính không calibrate được | Có, nBox 9-box | Có, facilitator | Có (gói Perform) | Có, ratings preview, bằng chứng | Điều chỉnh có người duyệt thứ hai, ghi lý do và bằng chứng |
| Nhân viên thấy gì | Công khai | Công khai | Theo cấu hình | Theo cấu hình | Reviewee không thấy ghi chú calibration | Acknowledge kết quả | Calibrator chỉ xem điểm | Thấy toàn bộ dữ kiện, phép tính, điều chỉnh của chính mình |
| Phản hồi/khiếu nại | Không | Không | Comment trong form | Không nêu | Không nêu | Acknowledge | Không nêu | Bắt buộc có kênh phản hồi và khiếu nại, kết quả lưu hồ sơ |
| Tách khỏi quyết định nhân sự | Có (Google: không dùng cho review) | Không nêu | Không nêu | Không nêu | Không nêu | Không nêu | Không nêu | Điểm chỉ hỗ trợ, không tự kích hoạt |
| Audit trail | Không | Không | Không rõ | Không được nêu trong trang đọc | Không rõ | Không rõ | Không rõ | Bắt buộc, bất biến, có hash |

### 10. Bẫy công bằng: ngày trễ được miễn (nghỉ phép, tạm dừng, chặn từ bên ngoài)

Tiền lệ: CPARS/FAR chỉ đánh giá theo yêu cầu hợp đồng; hợp đồng không phạt lỗi ngoài tầm kiểm soát (xem mục 17). OKR doc yêu cầu bằng chứng dễ tìm. Không tìm được tài liệu HRIS nào mô tả "excused delay" tự động; thường là điều chỉnh tay (khoảng trống của thị trường).
ADOPT: loại trừ chỉ khi có sự kiện "tạm dừng đã duyệt" hoặc "trì hoãn bên ngoài đã duyệt" là dữ kiện bất biến, bởi người khác người hưởng lợi; baseline tính lại bằng đồng hồ làm việc đã trừ khoảng miễn.
REJECT: cho người phụ trách tự khai báo miễn trừ có hiệu lực ngay.

### 11. Bẫy công bằng: task chia sẻ và quy trách nhiệm

SAP/Workday/Lattice không mô hình hóa "tỷ lệ đóng góp trên task chung" (trong các tài liệu đã đọc); thường điểm gắn với người quản lý nhập. Scrum/DORA cảnh báo: gắn chỉ số vào từng cá nhân khi công việc là của nhóm gây đổ lỗi và cô lập ([DORA metrics guide](https://dora.dev/guides/dora-metrics/) [ĐỌC]).
ADOPT: sổ phân công (assignment ledger) theo khoảng thời gian có hiệu lực: ai chịu trách nhiệm trong khoảng nào, tỷ lệ đóng góp cho task chung (tổng 100%), thay đổi phân công là sự kiện append-only có người duyệt; điểm task chia theo khoảng và tỷ lệ.
REJECT: gán toàn bộ điểm cho "người phụ trách hiện tại lúc đóng kỳ".

### 12. Bẫy công bằng: gaming và Goodhart

- Goodhart: "khi một thước đo trở thành mục tiêu, nó không còn là thước đo tốt"; Campbell's law tương tự cho chỉ số xã hội dùng ra quyết định ([Wikipedia - Goodhart's law](https://en.wikipedia.org/wiki/Goodhart%27s_law) [ĐỌC]).
- Mountain Goat: khi velocity thành mục tiêu, nhóm "nâng ước lượng", tránh chia nhỏ story, ưu tiên điểm hơn giá trị ([Mountain Goat - Don't compare team velocities](https://www.mountaingoatsoftware.com/agile/agile-leadership/dont-compare-team-velocities) [ĐỌC]). Scrum.org: velocity không phải chỉ số năng suất ([Scrum.org - Don't confuse velocity with success](https://www.scrum.org/resources/blog/dont-confuse-velocity-success) [TÌM]). DORA: đặt target rộng thì dễ bị chơi; dùng nhiều chỉ số có căng thẳng với nhau.
- Google OKR: sandbagging.
Các kiểu chơi đặc thù cho workflow: tách nhỏ task để tăng tỷ lệ đúng hạn; xóa task trễ; dời baseline; ước lượng dự toán cao rồi "tiết kiệm"; trả về hồ sơ cho người khác.
ADOPT (xem bảng mục 15): baseline đóng băng khi bắt đầu task, đổi baseline là sự kiện "lập lịch lại" có đếm và có duyệt; task không xóa vật lý (chỉ hủy có lý do, vẫn nằm trong mẫu); trọng số theo độ khó/giá trị task; bộ KPI nhiều chiều đối trọng (đúng hạn đối trọng với số lần trả về và độ đầy đủ hồ sơ).
REJECT: một KPI đơn lẻ quyết định điểm; "velocity" hay số task xong làm điểm cá nhân.

### 13. Bẫy công bằng: calibration, thiên vị người chấm, recency

- Scullen, Mount và Goff (2000, J. Applied Psychology 85(6)): hiệu ứng riêng của người chấm giải thích khoảng 62% và 53% phương sai điểm ở hai mẫu, còn hiệu suất thực của người được chấm chỉ khoảng 21% và 25%; kết quả bị tranh luận (Hoffman và cộng sự 2010) và các nghiên cứu ứng dụng sau cho tỷ lệ thấp hơn (khoảng một phần ba) ([tóm tắt Scullen và cộng sự](https://academicnewsletter.sufe.edu.cn/info/372766), [nghiên cứu 2020 về idiosyncratic rater effect](https://businessperspectives.org/journals/problems-and-perspectives-in-management/issue-359/manifestation-of-idiosyncratic-rater-effect-in-employee-performance-appraisal) [TÌM]; chưa mở bài gốc).
- Calibration có thể giảm sai số, nhưng chính nó là điểm can thiệp chủ quan (Culture Amp dẫn Speer 2019 [ĐỌC phần tóm tắt]).
- Recency: tài liệu thực hành khuyến nghị ghi quan sát liên tục suốt kỳ ([Duke - Performance appraisal biases](https://inside.sanford.duke.edu/wp-content/uploads/2024/04/Performance-Appraisal-Biases.pdf) [TÌM]); con số "78% quản lý bị ảnh hưởng bởi tháng cuối" không truy được nguồn gốc nên không dùng.
ADOPT: giảm phần điểm do người chấm quyết định về gần 0 bằng cách tính từ sự kiện; các điều chỉnh bắt buộc có bằng chứng, bị giới hạn biên độ, cần người duyệt thứ hai độc lập, hiển thị công khai cho người được chấm; tính điểm tích lũy theo từng task (không chỉ nhìn cuối kỳ).
REJECT: phân phối cưỡng bức (forced ranking); điểm quản lý nhập tự do là thành phần chính.

### 14. Bẫy công bằng: mẫu nhỏ và nhiễu thống kê

- Wilson score interval an toàn cho mẫu nhỏ và quan sát lệch (tỷ lệ gần 0/1), tránh khoảng tin cậy quá rộng hoặc độ rộng bằng 0 của xấp xỉ chuẩn: p nằm trong [(n_s + z^2/2) ± z·sqrt(n_s·n_f/n + z^2/4)] / (n + z^2) ([Wikipedia - Binomial proportion confidence interval](https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval) [ĐỌC]). Trang không cho ngưỡng n tối thiểu bằng số; không tìm được nguồn thẩm quyền về "n tối thiểu cho điểm hiệu suất" - hệ thống phải tự đặt trong rule version và coi là tham số cấu hình có phê duyệt.
- Ví dụ minh họa: 2/2 đúng hạn cho "100%" nhưng khoảng Wilson 95% rất rộng; 1 task trễ khi n=3 làm tỷ lệ tụt 33 điểm.
ADOPT: quy tắc mẫu nhỏ: dưới n_min task đủ điều kiện trong kỳ thì KHÔNG xếp hạng, chỉ hiển thị "chưa đủ dữ liệu" kèm số thô; trên ngưỡng vẫn hiển thị khoảng tin cậy hoặc độ đầy đủ; không so sánh chéo giữa người có n khác xa nhau.
REJECT: xếp hạng/so sánh trực tiếp người có 2 task với người có 40 task.

### 15. Bảng bẫy công bằng -> biện pháp tích hợp trong hệ thống

| Bẫy | Biện pháp trong hệ thống |
|---|---|
| Trễ có lý do (nghỉ phép, tạm dừng, chặn từ ngoài) | Sự kiện "tạm dừng đã duyệt"/"trì hoãn ngoài đã duyệt" bất biến, người duyệt khác người hưởng lợi; công thức tự trừ khoảng miễn khỏi độ lệch ngày |
| Task chung, đổ lỗi | Assignment ledger theo khoảng hiệu lực + tỷ lệ đóng góp tổng 100%; điểm chia theo khoảng |
| Tách nhỏ task để tăng tỷ lệ đúng hạn | Trọng số theo độ khó/giá trị; giới hạn tần suất tạo task cùng loại; cảnh báo bất thường gửi người rà soát (không tự phạt) |
| Xóa task trễ | Không xóa vật lý; hủy có lý do vẫn nằm trong mẫu và trong audit |
| Dời baseline | Baseline đóng băng; mỗi lần lập lịch lại là sự kiện, có KPI "số lần lập lịch lại", cần duyệt |
| Sandbagging ước lượng (dự toán/ngày) | So với baseline đã khóa lúc phê duyệt, KPI "số tiền so với dự toán %" chỉ tính một chiều có dải trung tính, ước lượng quá cao bị đối trọng bởi KPI khác |
| Người chấm thiên vị | Điểm tính tự động; điều chỉnh cần người duyệt thứ hai, lý do và bằng chứng, giới hạn biên độ |
| Recency | Điểm tích lũy theo task trong cả kỳ, không phụ thuộc đánh giá cuối kỳ |
| Mẫu nhỏ/nhiễu | n_min theo rule version; hiển thị "chưa đủ dữ liệu"; khoảng tin cậy |
| Công thức bị đổi âm thầm | Rule version bất biến, tác giả khác người duyệt, kỳ đã chốt dùng đúng version đã ghi hash |
| Số liệu bị sửa sau khi chốt | Khóa kỳ kèm hash; chỉ sửa bằng điều chỉnh có duyệt, không ghi đè |
| Nhân viên không biết/không phản biện được | Công thức công khai; xem toàn bộ dữ kiện và phép tính; quyền phản hồi và khiếu nại có hạn |
| Lộ thông tin / xem rộng quá | Phân quyền theo vai trò: nhân viên (của mình), quản lý trực tiếp (theo đơn vị tại thời điểm kỳ), HR |
| Tự động hóa quyết định nhân sự | Điểm chỉ hiển thị là "căn cứ hỗ trợ"; không có hành động nào (thưởng/kỷ luật/chấm dứt) tự kích hoạt từ điểm |

### 16. Pháp lý và đạo đức: dữ liệu cá nhân, đánh giá, giám sát

Việt Nam (cập nhật quan trọng cho ngày 2026-11-12):
- [Nghị định 13/2023/NĐ-CP - Điều 3 nguyên tắc](https://hethongphapluat.com/nghi-dinh-13-2023-nd-cp-ve-bao-ve-du-lieu-ca-nhan/dieu-3) [ĐỌC]: tuân thủ pháp luật; quyền được biết; đúng mục đích; thu thập tối thiểu; cập nhật; bảo mật; thời hạn lưu trữ phù hợp; trách nhiệm chứng minh sự tuân thủ.
- [Điều 9](https://hethongphapluat.com/nghi-dinh-13-2023-nd-cp-ve-bao-ve-du-lieu-ca-nhan/dieu-9) [ĐỌC]: 11 quyền gồm được biết, đồng ý, truy cập/chỉnh sửa, rút lại đồng ý, xóa, hạn chế xử lý, phản đối, khiếu nại/khởi kiện, bồi thường.
- Nghị định 13 đã bị thay thế: [Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15](https://english.luatvietnam.vn/dan-su/law-on-personal-data-protection-law-no-91-2025-qh15-405135-d1.html) [ĐỌC] có hiệu lực 01/01/2026 (tài liệu luật sư dẫn Nghị định 356/2025/NĐ-CP hướng dẫn, [Allen & Gledhill](https://www.allenandgledhill.com/vn/publication/articles/31075/upcoming-changes-to-vietnam-s-personal-data-protection-regime) [TÌM]; chưa xác minh nguyên văn Nghị định 356). Theo bản đọc: Điều 3 (mục đích, chính xác, lưu trữ có thời hạn, an ninh), Điều 4 (quyền được biết, truy cập, chỉnh sửa, phản đối, xóa, khiếu nại), Điều 14 (xóa khi hết mục đích/thời hạn), và Điều 25 về người lao động: chỉ dùng biện pháp kỹ thuật hợp pháp bảo vệ quyền người lao động và người lao động phải biết rõ; dữ liệu thu thập trái phép qua giám sát không được xử lý; xóa/hủy dữ liệu khi hợp đồng chấm dứt trừ khi thỏa thuận hoặc luật yêu cầu. Luật không có điều riêng về ra quyết định tự động; Điều 30 yêu cầu phân loại rủi ro cho xử lý AI.
- Bộ luật Lao động 2019: trong phiên này CHỈ xác nhận [Điều 118](https://hethongphapluat.com/bo-luat-lao-dong-2019/dieu-118/khoan-3) [ĐỌC phần khoản 3] - người sử dụng lao động phải tham khảo ý kiến tổ chức đại diện người lao động tại cơ sở khi ban hành/sửa nội quy lao động, nội quy bằng văn bản nếu từ 10 lao động, phải thông báo và niêm yết ([tóm tắt Điều 118 qua kết quả tìm kiếm](https://hoatieu.vn/luat-lao-dong-45-2019-qh14-189872) [TÌM]). KHÔNG tìm được điều khoản của Bộ luật Lao động quy định riêng về đánh giá hiệu suất; từ kiến thức nền, căn cứ "thường xuyên không hoàn thành công việc" để chấm dứt hợp đồng phải dựa trên tiêu chí đánh giá trong quy chế của đơn vị (cần đối chiếu Điều 36 BLLĐ và Nghị định 145/2020/NĐ-CP với luật sư; CHƯA kiểm chứng ở đây). Hệ quả thiết kế: quy tắc chấm điểm nên được coi như quy chế được thông báo cho người lao động và, khi cần, tham khảo đại diện người lao động.
- Khu vực công: [Nghị định 90/2020/NĐ-CP (sửa đổi Nghị định 48/2023/NĐ-CP)](https://vbpl.vn/FileData/TW/Lists/vbpq/Attachments/161816/VBHN%20ND%2090-2020%20va%20ND%2048-2023.pdf) và [bài giải đáp nguyên tắc đánh giá](https://thuvienphapluat.vn/hoi-dap-phap-luat/nguyen-tac-danh-gia-xep-loai-chat-luong-can-bo-cong-chuc-vien-chuc-342972.html) [TÌM; trang không đọc được, 403]: đánh giá hằng năm theo nguyên tắc, tiêu chí, thẩm quyền, trình tự (Điều 1-4); không đánh giá nếu thời gian công tác trong năm chưa đủ 6 tháng (có ngoại lệ thai sản); hồ sơ đánh giá được lưu điện tử. Điều này liên quan trực tiếp vì khách hàng là đơn vị đầu tư công: điểm hệ thống là dữ kiện đầu vào, không thay thế quy trình xếp loại cán bộ theo nghị định.

Quốc tế:
- GDPR Điều 5 (tối thiểu hóa, chính xác, công bằng) áp dụng cả khi không thuộc Điều 22; Điều 22 hạn chế quyết định dựa HOÀN TOÀN trên xử lý tự động có tác động đáng kể, và vẫn yêu cầu quyền can thiệp của con người, nêu quan điểm và phản đối; can thiệp "nhãn mác" không đủ ([FPF - ADM case law report](https://fpf.org/wp-content/uploads/2022/05/ADM-Case-law-Report-May-20-2022.pdf), [ISW Legal - GDPR Art. 22](https://iswlegal.com/gdpr/articles/article-22) [TÌM, chưa đọc văn bản EUR-Lex]).
- Giám sát điện tử: tài liệu thực hành nêu giám sát quá mức làm giảm tin cậy, tăng căng thẳng; khuyến nghị minh bạch và cho nhân viên xem dữ liệu của mình ([CIPD - Employee monitoring](https://cipd.org/ie/knowledge/bitesize-research/employee-monitoring) [TÌM]). KHÔNG nguồn được ILO Code of practice 1997 hay Opinion 2/2017 (WP249) trong phiên này, chỉ biết tên tài liệu, chưa kiểm chứng nội dung.
ADOPT: thu thập tối thiểu (chỉ sự kiện workflow, không giám sát hoạt động bàn phím/vị trí/thời gian online); thông báo rõ mục đích; lưu trữ có thời hạn và quy trình xóa/ẩn danh khi hợp đồng chấm dứt trừ khi luật yêu cầu giữ; quyền truy cập và chỉnh sửa dữ liệu của mình; đánh giá tác động trước khi bật.
REJECT: điểm tự động đi thẳng tới quyết định nhân sự; thu thập "telemetry hành vi" làm đầu vào KPI.

### 17. Tiền lệ giao hàng phần mềm và kiểm soát dự án

- DORA: 5 chỉ số (change lead time, deployment frequency, failed deployment recovery time, change fail rate, deployment rework rate); dùng để cải tiến theo thời gian, không để xếp hạng; chỉ số nên dùng cho từng ứng dụng/dịch vụ; trang không bàn về đánh giá cá nhân (ngoài phạm vi trang) ([DORA metrics guide](https://dora.dev/guides/dora-metrics/) [ĐỌC]).
- Velocity: hữu ích chủ yếu bên trong một nhóm để dự báo; không nên làm KPI cá nhân hay so sánh nhóm ([Mountain Goat](https://www.mountaingoatsoftware.com/agile/agile-leadership/dont-compare-team-velocities) [ĐỌC]; phần "cá nhân" là từ các nguồn thực hành [TÌM]).
- Earned value: SPI = EV/PV, CPI = EV/AC; dưới 1 là chậm tiến độ/vượt chi phí ([PMI - Earned value management](https://www.pmi.org/blog/earned-value-management), [PMI - Applications and extensions of EVA](https://www.pmi.org/learning/library/earned-value-analysis-forecast-outcomes-7898) [TÌM]; chưa tự đọc định nghĩa PMBOK nguyên văn). EVM là chỉ số cấp dự án/gói thầu, không có chuẩn cho cá nhân.
- Đánh giá nhà thầu (CPARS, FAR 42.15) [ĐỌC, [FAR 42.1503](https://www.acquisition.gov/far/42.1503)]: thang 5 mức (Exceptional, Very Good, Satisfactory, Marginal, Unsatisfactory) có định nghĩa chữ cho từng mức; phải có đoạn tường thuật phù hợp với định nghĩa; "không được xếp dưới Satisfactory chỉ vì không vượt yêu cầu"; nhà thầu được tối đa 14 ngày lịch để nhận xét/phản bác; có xem xét ở cấp trên cán bộ hợp đồng khi bất đồng. Cũng tham khảo [CPARS data dictionary](https://www.cpars.gov/cparsweb/assets/documents/CPARS-EvaluationDataDictionary.pdf) [TÌM].
ADOPT: thang bậc có định nghĩa chữ cho từng mức (CPARS); cửa sổ phản hồi cố định (14 ngày là tiền lệ, hệ thống đặt tham số); xem xét ở cấp cao hơn khi bất đồng; SPI/CPI như công thức trong danh mục cho cấp task/gói (không cá nhân hóa); chỉ số cấp nhóm cho các chỉ số hệ thống.
REJECT: velocity/số story point làm điểm cá nhân; so sánh chéo dự án khác bản chất.

### 18. Rút ra cho hệ thống (bên KPI và chấm điểm)

1. ADOPT danh mục công thức an toàn (độ lệch ngày, tỷ lệ đúng hạn, tiền so dự toán %, số lần trả về, độ đầy đủ hồ sơ, số lần lập lịch lại) tính từ sự kiện workflow bất biến. Nguồn: SAP calculator rules/lookup tables, Betterworks (tiền lệ ngược: nhập tay tách rời dữ liệu thật). Lý do: loại thiên vị người chấm (Scullen) và kiểm toán được.
2. ADOPT quy đổi điểm tuyến tính hoặc bậc thang qua bảng tra có version; REJECT chuẩn hóa thang ngầm. Nguồn: SAP (lỗi 5.44 thành 6.47), CPARS (thang có định nghĩa). Lý do: minh bạch và tái lập.
3. ADOPT mỗi bậc thang có định nghĩa chữ ngắn (CPARS Table 42-1), không chỉ con số. Lý do: người được chấm hiểu và phản biện được.
4. ADOPT trọng số per-KPI nằm trong rule version, kiểm tra tổng bằng 100 khi duyệt. Nguồn: SAP (auto populate weights), OKR. Lý do: lỗi trọng số bằng 0/bằng nhau của SAP là bài học.
5. ADOPT rule version bất biến, tác giả khác người duyệt, kỳ chốt ghi hash version và dữ kiện. Nguồn: Workday (người nộp cuối là controller), Culture Amp (accountability). Lý do: chống đổi luật âm thầm sau khi thấy điểm.
6. ADOPT sổ phân công theo khoảng hiệu lực với tỷ lệ đóng góp cho task chung. Nguồn: SMART "Assignable" (Doran), DORA (cảnh báo đổ lỗi khi cô lập chỉ số). Lý do: điểm công bằng khi đổi người giữa chừng; không hệ nào trong số đã đọc có tính năng này.
7. ADOPT loại trừ tạm dừng đã duyệt và trì hoãn ngoài đã duyệt như sự kiện bất biến, duyệt bởi người khác. Nguồn: khoảng trống thị trường HRIS, FAR (lỗi ngoài tầm kiểm soát). Lý do: công bằng mà không mở cửa tự khai miễn.
8. ADOPT quy tắc mẫu nhỏ (n_min trong rule version, hiển thị "chưa đủ dữ liệu", khoảng Wilson tham khảo). Nguồn: Wikipedia Wilson interval; không có nguồn thẩm quyền về n_min. Lý do: tránh xếp hạng nhiễu; ngưỡng là tham số cần duyệt chứ không phải hằng số "khoa học".
9. ADOPT KPI nhiều chiều có đối trọng (đúng hạn vs trả về vs hồ sơ đủ vs lập lịch lại). Nguồn: BSC, DORA (chỉ số có căng thẳng với nhau), Goodhart. Lý do: giảm gaming một chiều.
10. ADOPT baseline đóng băng, task không xóa vật lý, đổi baseline là sự kiện đếm và duyệt. Nguồn: Goodhart/Campbell, Mountain Goat (nâng ước lượng), OKR (sandbagging). Lý do: chặn dời mốc, xóa task, tách task.
11. REJECT điểm cá nhân từ velocity/số task xong và so sánh cá nhân kiểu xếp hạng cưỡng bức. Nguồn: Mountain Goat, Scrum.org, DORA, Workday target percentage (không áp dụng). Lý do: chỉ số hệ thống không phải KPI cá nhân.
12. ADOPT điều chỉnh điểm chỉ qua yêu cầu có lý do, bằng chứng, biên độ giới hạn, người duyệt thứ hai độc lập; REJECT ghi đè điểm tính. Nguồn: Culture Amp (bằng chứng quan sát được), SAP (điểm tính không calibrate, nhưng finalize có thể ghi đè), Workday. Lý do: giữ cả điểm tính và điểm điều chỉnh để kiểm toán.
13. ADOPT vai trò facilitator/người duyệt tách khỏi admin và khỏi người đề xuất. Nguồn: Lattice, Workday, Culture Amp. Lý do: tách nhiệm vụ.
14. ADOPT nhân viên thấy toàn bộ dữ kiện, công thức và mọi điều chỉnh ảnh hưởng điểm của mình; REJECT ghi chú calibration ẩn kiểu Lattice/Culture Amp nếu chúng làm đổi điểm mà người đó không biết. Nguồn: Nghị định 13 Điều 3 (quyền được biết), Luật 91/2025 Điều 4. Lý do: tuân thủ và công bằng thủ tục.
15. ADOPT quyền phản hồi/khiếu nại có hạn cố định (tham số, ví dụ 14 ngày theo tiền lệ CPARS) và xem xét ở cấp cao hơn khi bất đồng; kết quả lưu hồ sơ bất biến. Nguồn: FAR 42.1503, 15Five (acknowledge), GDPR Điều 22 (quyền nêu quan điểm và phản đối). Lý do: quy trình hợp lệ.
16. ADOPT phân quyền theo vai trò: nhân viên (của mình), quản lý trực tiếp (theo đơn vị tại thời điểm kỳ, không theo cấu trúc hiện tại), HR; ẩn thuộc tính nhạy cảm khỏi view tổng hợp. Nguồn: Culture Amp (ẩn trường nhân khẩu), Workday (nhóm bảo mật hạn chế), Lattice (visibility mâu thuẫn nên cần chính sách rõ). Lý do: riêng tư và công bằng.
17. ADOPT "điểm chỉ hỗ trợ, không tự kích hoạt" làm bất biến sản phẩm (không có đường mã dẫn từ điểm tới hành động nhân sự). Nguồn: Google re:Work (OKR không phải đánh giá nhân sự), Doerr (tách thưởng), GDPR Điều 22. Lý do: pháp lý và giảm gaming; Doerr là nguồn thứ cấp.
18. REJECT 9-box/potential, forced distribution, RAG nhập tay, đo telemetry hành vi. Nguồn: Workday nBox, Betterworks, nghiên cứu giám sát. Lý do: không có dữ kiện bất biến; phi tương xứng; Luật 91/2025 Điều 25 hạn chế giám sát.
19. ADOPT chính sách lưu trữ có thời hạn: giữ dữ kiện chấm điểm đủ thời hạn pháp lý/kiểm toán, xóa hoặc ẩn danh khi hết mục đích/chấm dứt hợp đồng, kèm xử lý xung đột với "bất biến" (hash giữ, dữ liệu cá nhân gắn khóa có thể xóa). Nguồn: Luật 91/2025 Điều 3, 14, 25; Nghị định 13 Điều 3. Lý do: bất biến không được mâu thuẫn quyền xóa.
20. ADOPT tách lớp hiển thị RAG (suy ra từ ngưỡng có version) khỏi lớp điểm; quy tắc công thức mở rộng bằng cách thêm công thức vào danh mục có kiểm duyệt (không cho biểu thức tự do) để mở rộng an toàn. Nguồn: ClearPoint (ngưỡng RAG tài liệu hóa), SAP (calculator rules). Lý do: mở rộng mà không vỡ kiểm toán.

### 19. Khoảng trống nguồn (cần người xác minh trước khi dùng pháp lý)

- Không đọc được: SAP Help Portal và blog calculator rules (403), trang SAP Learning (404), trang thuvienphapluat về Nghị định 90 (403), bài HBR 1992 đầy đủ (chỉ phần dẫn).
- Chỉ nguồn thứ cấp: lời Doerr về tách OKR khỏi thưởng, Betterworks cách chấm OKR (không tìm được tài liệu chính thức), 15Five quyền riêng tư và calibration, ngưỡng RAG (chỉ vendor), n_min cho mẫu nhỏ (không có nguồn thẩm quyền), nghiên cứu Scullen (chưa mở bài gốc), ILO/WP249 (không nguồn).
- Pháp lý: Bộ luật Lao động chỉ xác nhận Điều 118; điều khoản về đánh giá/chấm dứt hợp đồng vì không hoàn thành công việc (Điều 36, Nghị định 145/2020) chưa kiểm chứng; Nghị định 356/2025 chưa đọc nguyên văn. Mọi mục pháp lý cần luật sư rà soát trước khi đưa vào hợp đồng hoặc quy chế.


## Phần C. Quyết định thiết kế cho PWF (nhận, bỏ, vì sao)

Quy ước: mã D-nn được dẫn trong `PWF.md` (cột "Căn cứ") và trong ghi chú của mã. "Nhận" là đưa vào thiết kế ngay; "Bỏ" là chủ ý không làm kèm lý do; "Để sau" là mở rộng đã chừa chỗ, không làm trong đợt này. Chủ sở hữu đã ủy quyền tự quyết theo tiêu chí quản trị sâu nhất và mở rộng tốt nhất; không có câu hỏi nào chờ chủ sở hữu.

### C.1 Lập lịch và công việc

| Mã | Quyết định | Nhận/Bỏ | Nguồn chính (Phần A, B) | Nằm ở |
|---|---|---|---|---|
| D-01 | Mẫu workflow tính ngày từ MỘT ngày dự định bắt đầu bằng thời lượng ngày làm việc; mẫu đóng băng (phiên bản và băm) khi dự án khởi tạo; mỏ neo phụ thêm bằng ràng buộc "không sớm hơn" tính theo số ngày làm việc từ ngày bắt đầu | Nhận MS Project (ngày bắt đầu lưu, tính lại toàn mạng), ClickUp (giữ khoảng cách theo ngày làm việc); bỏ giới hạn một mỏ neo của Asana | A1.1, A3.1 | BR-PWF-01, 02; `project-workflow.ts`, `tasksFromTemplate` |
| D-02 | Bốn kiểu phụ thuộc FS/SS/FF/SF có độ trễ và độ vượt (lead) bằng ngày làm việc; độ trễ là thuộc tính của từng liên kết, không phải cài đặt toàn cục | Nhận MS Project, P6, Smartsheet; bỏ cấu hình "lịch của độ trễ" toàn cục của P6 (cùng độ trễ cho kết quả khác nhau giữa các máy) | A1.3, A2.2, A3.2 | BR-PWF-03; `scheduleProject` |
| D-03 | Độ trễ theo ngày lịch (elapsed, vd thời hạn niêm yết 30 ngày) CHƯA hỗ trợ ở đợt này: biểu diễn bằng một công việc chờ có thời lượng ngày làm việc tương đương; chừa trường `lag_unit` ở thiết kế dữ liệu | Để sau (ghi rõ giới hạn; Smartsheet cũng thiếu và người dùng phàn nàn) | A3.2, A8.9 | BR-PWF-03, mục 13 |
| D-04 | Sáu loại ràng buộc ngày: không sớm hơn, không muộn hơn (cho bắt đầu và kết thúc), phải bắt đầu vào, phải kết thúc vào. Ràng buộc cứng thắng logic nhưng LUÔN sinh cờ `CONSTRAINT_CONFLICT`, ràng buộc không muộn hơn bị phá sinh `CONSTRAINT_VIOLATED` và độ trễ cho phép âm. Hạn dự án (`targetFinish`) là khái niệm riêng, không đổi lịch | Nhận MS Project (tách deadline và constraint); bỏ cạm bẫy "gõ tay ngày tự thêm ràng buộc" và độ trễ âm âm thầm | A1.4, A8.10 | BR-PWF-04 |
| D-05 | Độ trễ cho phép (total/free float), đường găng theo ngưỡng float người dùng đặt (mặc định 0), đường dài nhất theo chuỗi liên kết chi phối | Nhận MS Project (ngưỡng "critical nếu slack <= N"), P6 (longest path, float ngưỡng); để sau "nhiều đường float đến một mốc" | A1.5, A2.4 | BR-PWF-05 |
| D-06 | Tiến độ không theo thứ tự theo "retained logic": phần còn lại của việc đang làm không lập trước khi tiền nhiệm FS xong; thời lượng còn lại ưu tiên hơn % hoàn thành; việc chưa bắt đầu không được lập trước ngày trạng thái | Nhận P6 (mặc định retained logic) và khuyến nghị MPUG về thời lượng còn lại; bỏ "progress override" | A1.8, A2.3 | BR-PWF-06 |
| D-07 | Đường cơ sở nhiều phiên bản, chỉ thêm, phiên bản mới cần người duyệt khác người lập; độ lệch tính so với đường cơ sở ĐẦU; tính lại phần chưa làm không bao giờ sửa đường cơ sở | Nhận P6 (quyền riêng khi đặt baseline, muốn sửa phải khôi phục), Autodesk Build (phiên bản lịch); bỏ MS Project sửa baseline tự do và Smartsheet baseline không vào nhật ký | A1.7, A2.5, A3.6 | BR-PWF-07, 08 |
| D-08 | Dời lịch là hành động có XEM TRƯỚC rồi áp dụng, ghi lý do, người duyệt; không cascade ngầm. Việc đã xong giữ ngày thực; việc hủy hoặc nhánh bị loại là nút độ dài 0 giữ thứ tự (tránh lỗi "issue đã DONE phá chuỗi" của Jira) | Nhận Jira Plans (hai bước chấp nhận và xem lại), Asana (xem trước); bỏ cascade ngầm của ClickUp/Monday | A3.2, A8.12 | BR-PWF-09; `rescheduleProject`, `diffSchedules` |
| D-09 | Lịch làm việc ghim theo phiên bản từng năm; thiếu năm thì từng công việc báo `CALENDAR_UNAVAILABLE` kèm năm thiếu, không đoán; kết quả ghi các phiên bản lịch đã dùng; dự án dài hơn ba năm tính theo từng năm nối tiếp | Nhận Smartsheet/Procore/P6 (lịch làm việc cấp dự án) và Điều 112 Bộ luật Lao động (lịch nghỉ do Thủ tướng ấn định hằng năm, đổi sau khi dự án đã lập lịch) | A1.9, A5.4 | BR-PWF-10; `PinnedCalendar` |
| D-10 | MỘT lịch có thẩm quyền: công việc đánh dấu là mốc ghi vào chính `project_milestone`; đường cơ sở đầu của workflow là `project_baseline`; look-ahead và EVM đọc qua một cổng; không có lịch thứ hai | Nhận bài học hai tầng của Autodesk Build, Fieldwire, Procore (lịch CPM và việc hiện trường là hai tầng, tầng dưới hiện độ lệch chứ không ghi đè); bỏ nguồn sự thật thứ hai kiểu "tính lùi chỉ để tham khảo" của Procore | A4.1, A4.2, A8.16 | R28; BR-PWF-11 |
| D-11 | Giới hạn kích thước đồ thị mẫu: 400 công việc, 20 liên kết mỗi việc, chuỗi dài nhất 100, 12 giai đoạn; ngân sách hiệu năng: lập lịch 500 việc dưới 200 ms | Nhận Project for the web (3000 việc, 20 liên kết, 10 cấp); chặt hơn vì mỗi việc có chứng từ và KPI | A1.3, A8.17 | BR-PWF-12 |
| D-12 | Giai đoạn workflow (cấu hình được) tách khỏi trạng thái pháp định của dự án (PIMA); mỗi giai đoạn khai báo lệnh chuyển trạng thái và sự kiện hệ thống nó chặn cho tới khi công việc bắt buộc xong; cổng kiểm trong cùng giao dịch của lệnh | Nhận mô hình "workflow gọi lệnh có chốt chặn" của PRJ; bỏ workflow tự ghi trạng thái | R29 | BR-PWF-13; `gateFor` |
| D-13 | Hoàn thành công việc cần danh mục kiểm, bằng chứng đúng loại, chứng từ pháp lý và biểu mẫu mẫu yêu cầu; người duyệt hoàn thành khác người làm (không ngoại lệ); ngoại lệ có lý do và người duyệt chỉ che phần thiếu | Nhận mẫu PRC-1 (lượt sửa, ngoại lệ, người lập khác người duyệt) và Procore (hạn bước duyệt động) | A4.2 | BR-PWF-14; `assessTaskCompletion` |
| D-14 | Loại chứng từ pháp lý là "loại" trừu tượng; bản công phân giải sang danh mục loại chứng từ của dự án đầu tư công (lớp hồ sơ), bản doanh nghiệp đăng ký gói riêng qua manifest; mã chung không nhập mã doanh nghiệp | R42 | BR-PWF-15; `registerLegalDocTypeResolver` |
| D-15 | Nhánh có điều kiện theo nhóm dự án (QTQG, A, B, C), nguồn vốn và loại dự án; một dữ kiện chưa biết không bao giờ làm điều kiện đúng | Nhận mẫu có nhánh (khắc phục "một mỏ neo" và template cứng) | A3.1 | BR-PWF-16; `activeTasks` |
| D-16 | Tiếp nhận dự án đang chạy bằng lệnh có ngày hiệu lực: việc thuộc quá khứ ghi `NOT_TRACKED` hoặc xác nhận đã xong kèm bằng chứng, không vào điểm KPI; chạy thử trước khi áp dụng | Khoảng trống chung (Asana/ClickUp người dùng đòi áp mẫu vào dự án đang chạy) | A3.1 | R36; BR-PWF-17 |
| D-17 | Tải công việc theo người chỉ HIỂN THỊ (số việc, ngày làm việc đã giao theo tuần); không tự cân bằng nguồn lực; không dùng loại tác vụ và effort-driven của MS Project | Nhận Asana/ClickUp (workload là góc nhìn), bỏ resource leveling và 3 loại task type | A1.2, A3.5 | BR-PWF-18 |
| D-18 | Kiểm tra chất lượng lịch kiểu DCMA hiển thị cho người lập mẫu: việc thiếu tiền nhiệm hoặc hậu nhiệm, độ vượt, ràng buộc cứng, việc quá dài, độ trễ cho phép âm | Nhận DCMA 14 điểm (nguồn vendor) ở mức cờ cảnh báo, không chặn; để sau ngưỡng phần trăm | A2.7 | BR-PWF-19 |

### C.2 Hạn, ba màu và nhắc việc

| Mã | Quyết định | Nhận/Bỏ | Nguồn chính | Nằm ở |
|---|---|---|---|---|
| D-20 | Ba ngưỡng do người dùng đặt tính bằng SỐ NGÀY CÒN LẠI: mức bắt đầu khi số ngày còn lại không quá ngưỡng; ví dụ chủ sở hữu "5 ngày xanh, 2 ngày vàng, dưới 1 ngày đỏ" là 5/2/0; vượt hạn luôn đỏ; xa hơn ngưỡng xanh là "chưa vào tầm" (không màu) hoặc xanh khi để trống ngưỡng xanh | Nhận ý "critical nếu slack <= N" của MS Project/P6 và dung sai đặt trước của PRINCE2; bỏ công thức rải rác trong từng sheet của Smartsheet/Monday (không phiên bản, không quản trị) | A1.5, A3.4, A5.1 | BR-PWF-20; `deadlineBand` |
| D-21 | Đơn vị (ngày lịch hay ngày làm việc) do NGUỒN khai báo, không do người thuê: việc, lịch báo cáo giữ ngày lịch với mặc định bằng hằng số cũ (7 và 3), công việc dự án dùng ngày làm việc | Nhận bài học Smartsheet (phải tự dùng NETWORKDAYS) và ClickUp (thiếu offset theo ngày làm việc); R30 | A3.3, A3.4 | BR-PWF-21 |
| D-22 | Ba tầng: mặc định hệ thống, quy tắc `DEADLINE_BAND_POLICY` (tenant hoặc đơn vị, có phiên bản, người duyệt khác người lập, ghi đè theo loại việc, mức ưu tiên, giai đoạn), tùy chọn cá nhân | Nhận PRINCE2 (người đặt dung sai khác người báo cáo) | A5.1 | BR-PWF-22 |
| D-23 | Tùy chọn cá nhân chỉ được nhắc SỚM hơn, không muộn hơn mức chính thức; màn chung (bảng của quản lý, portfolio, báo cáo, KPI) chỉ hiện màu chính thức; màu cá nhân có nhãn "theo cài đặt của bạn" và luôn kèm ngày hạn thật | R40 | BR-PWF-23 |
| D-24 | Nhắc nhiều mốc (`reminder_days`) và leo thang sau N ngày quá hạn, mỗi mốc kích hoạt đúng một lần (khóa theo giá trị mốc, phát lại không trùng); trần nhắc theo bộ máy cảnh báo hiện có | Nhận Procore (nhắc quá hạn hằng ngày, dừng sau 45 ngày), Smartsheet (nhắc x ngày trước hạn); bỏ giờ cố định cho mọi mục của Monday và JQL tự viết của Jira | A3.3, A5.3 | BR-PWF-24; `dueReminders` |
| D-25 | Cảnh báo theo DỰ BÁO: ngày dự báo của mốc vượt hạn cơ sở thì báo `PWF_MILESTONE_AT_RISK` trước khi trễ thật | Nhận PRINCE2 (leo thang theo dự báo, báo cáo ngoại lệ); khắc phục chỉ báo "Missed Deadline" chỉ hiện khi đã trễ | A5.1, A1.4 | BR-PWF-25 |
| D-26 | Việc chưa có ngày không hiện xanh: trạng thái "chưa lập lịch" hoặc "chưa tính được hạn vì thiếu lịch năm N" | Bài học Monday/Smartsheet | A3.4 | BR-PWF-26 |
| D-27 | Trung tâm cảnh báo đọc hạn TRỰC TIẾP từ công việc (nguồn `PROJECT_TASK`), một danh tính cảnh báo cho mỗi công việc và phiên bản lịch; dời, tạm dừng, hủy, hoàn thành cập nhật trong cùng giao dịch | R30 | BR-PWF-27 |

### C.3 KPI và chấm điểm nhân viên

| Mã | Quyết định | Nhận/Bỏ | Nguồn chính | Nằm ở |
|---|---|---|---|---|
| D-30 | Danh mục công thức AN TOÀN, đóng (độ lệch ngày, tỷ lệ đúng hạn, chênh lệch tiền so với dự toán, số lần trả lại, độ đủ chứng từ, số lần dời hạn); bộ KPI chỉ tham chiếu mã trong sổ KPI | Nhận SAP calculator rules và bảng tra; bỏ biểu thức tự do và nhập tay tách rời dữ liệu thật (Betterworks) | B4, B8 | BR-PWF-30, 31; R37; `workflow-kpi.ts` |
| D-31 | Quy đổi điểm tuyến tính hoặc bậc thang, thang 0 đến 100, hiển thị cả giá trị gốc lẫn điểm, không chuẩn hóa ngầm; bậc xếp loại có định nghĩa chữ | Nhận SAP (bảng tra), CPARS (thang có định nghĩa chữ); bỏ chuẩn hóa thang ngầm (lỗi 5,44 thành 6,47 của SAP) | B4, B17 | BR-PWF-32 |
| D-32 | Trọng số từng KPI nằm trong phiên bản quy tắc, kiểm khi duyệt; điểm việc là trung bình có trọng số chỉ trên KPI áp dụng được, chia lại trọng số | Nhận SAP (trung bình có trọng số; lỗi trọng số bằng 0 là bài học), OKR | B4 | BR-PWF-33 |
| D-33 | Sổ phân công chỉ thêm theo khoảng thời gian, vai R/A/C/I và tỷ lệ đóng góp trên việc chung; điểm chia theo khoảng và tỷ lệ; kỳ chốt chụp sổ | Nhận SMART chữ A "Assignable" và cảnh báo của DORA về việc cô lập chỉ số; không hệ HRIS nào đã đọc có tính năng này | B2, B11, B17 | R34; BR-PWF-34 |
| D-34 | Chỉ miễn ngày trễ khi có sự kiện "tạm dừng đã duyệt" hoặc "trì hoãn bên ngoài đã duyệt" do người khác người hưởng lợi duyệt; người phụ trách không tự khai miễn | Khoảng trống thị trường; FAR (lỗi ngoài tầm kiểm soát) | B10 | BR-PWF-35 |
| D-35 | Mẫu nhỏ: dưới số việc hoặc trọng số tối thiểu (tham số có duyệt) thì không xếp loại, hiển thị "chưa đủ dữ liệu" kèm số thô; mẫu số 0 không bao giờ ra NaN | Wilson interval làm tham chiếu hiển thị; không có chuẩn n tối thiểu nên là tham số duyệt | B14 | BR-PWF-36 |
| D-36 | Chống thao túng: đường cơ sở đóng băng khi bắt đầu việc, việc không xóa vật lý (hủy có lý do), việc hủy không được duyệt tính là chưa đạt, trọng số theo số ngày dự kiến (tách nhỏ không làm đẹp tỷ lệ), KPI đối trọng nhau, và cờ bất thường GỬI NGƯỜI RÀ SOÁT, không tự phạt | Goodhart, Mountain Goat, Google OKR (sandbagging), DORA | B12, B15 | BR-PWF-37; `gamingSignals` |
| D-37 | Điều chỉnh điểm chỉ qua yêu cầu có lý do, biên độ giới hạn, người duyệt thứ hai độc lập không phải người được chấm; giữ cả điểm tính và điểm điều chỉnh; người được chấm thấy mọi điều chỉnh | Nhận Workday/Culture Amp (bằng chứng, người nộp cuối là vai khác), SAP (điểm tính không đè); bỏ ghi chú calibration ẩn và bỏ phiếu ủng hộ/bỏ phiếu trắng | B5, B6, B8, B13 | BR-PWF-38; `assertAdjustmentAllowed` |
| D-38 | Kỳ chốt kèm băm, phiên bản quy tắc và dữ kiện; chỉ "chính thức" sau cửa sổ phản hồi hoặc khi mọi phản hồi đã xử lý, phản hồi chạy qua bộ máy duyệt ADM có đồng hồ | R43; CPARS (14 ngày nhận xét), 15Five (xác nhận đã xem) | B7, B17 | BR-PWF-39; `canOfficialize` |
| D-39 | Ba vai xem điểm: người được đánh giá, quản lý trực tiếp theo phạm vi đơn vị tại thời điểm kỳ, bộ phận nhân sự; thi hành ở cơ sở dữ liệu và API; mọi lần xem của người khác và mọi lần xuất ghi nhật ký; điện thoại không lưu đệm bảng điểm người khác | R33; Workday (nhóm bảo mật hạn chế), Culture Amp (ẩn thuộc tính nhạy cảm) | B5, B8, B16 | BR-PWF-40 |
| D-40 | Điểm chỉ là căn cứ hỗ trợ: không có đường mã nào từ điểm tới thưởng, kỷ luật, chấm dứt hợp đồng; điểm KPI không thay quy trình đánh giá cán bộ theo Nghị định 90/2020 | Google re:Work (OKR không phải đánh giá nhân sự), GDPR Điều 22, Luật 91/2025 | B1, B16 | BR-PWF-41 |
| D-41 | Thu thập tối thiểu (chỉ sự kiện workflow, không giám sát bàn phím, vị trí, thời gian trực tuyến); thời hạn lưu (`retention_months`) và xóa hoặc ẩn danh khi hết mục đích, giữ băm | Luật 91/2025 Điều 3, 14, 25; Nghị định 13/2023 Điều 3 | B16 | BR-PWF-42 |
| D-42 | Bỏ: ma trận 9 ô, tiềm năng, xếp hạng cưỡng bức, RAG nhập tay, điểm cá nhân từ số việc xong hoặc velocity, so sánh người có mẫu chênh nhau | Workday nBox, DORA, Scrum.org | B5, B11, B17 | mục 13 |

### C.4 Điểm còn mở (ghi cho người đọc, không chờ chủ sở hữu)

- Ngưỡng và trọng số mặc định, số ngày của mẫu, số việc tối thiểu để xếp loại đều là giá trị khởi đầu `UNVERIFIED` đã gắn nguồn, ngày và công thức; cơ quan sử dụng duyệt theo quy trình quy tắc.
- Số hiệu nghị định hướng dẫn Luật Đầu tư công 58/2024/QH15 và các điều khoản Bộ luật Lao động về đánh giá chưa được kiểm chứng trong nghiên cứu này; cần luật sư của cơ quan sử dụng.
- Mã biểu mẫu `document_template` của DOC do từng tenant công bố; mẫu mặc định không tham chiếu biểu mẫu cụ thể, và việc gắn biểu mẫu được kiểm bằng `FORM_TEMPLATE_UNKNOWN`.
