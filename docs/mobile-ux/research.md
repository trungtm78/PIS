# Nghiên cứu UX cho ứng dụng điện thoại "Hệ thống quản lý đầu tư công" (thiết kế lại v2)

Ngày truy cập mọi nguồn: 2026-11-12. Phạm vi: ứng dụng Flutter 5 tab (Trang chủ, Dự án, Phê duyệt, Thông báo, Cá nhân), hai phiên bản (khu vực công, doanh nghiệp), người dùng là lãnh đạo và cán bộ quản lý dự án đầu tư vốn, có cán bộ làm việc hiện trường, mạng không ổn định, tiếng Việt dấu dài.

Tài liệu này chỉ gồm nghiên cứu và đặc tả khuyến nghị. Không có thay đổi mã sản phẩm.

---

## 1. Phương pháp và danh sách nguồn

### 1.1 Phương pháp

1. Tìm kiếm web (WebSearch) để định vị nguồn, sau đó tải trang (WebFetch) để đọc nội dung gốc khi có thể.
2. Mỗi nguồn được gắn mức kiểm chứng:
   - **[T]** = đã tải và đọc trang gốc, trích dẫn dưới đây lấy từ trang đó.
   - **[K]** = chỉ thấy qua kết quả tìm kiếm (đoạn tóm tắt của công cụ), chưa đọc trang gốc. Dùng để định hướng, không coi là bằng chứng cứng.
   - **[X]** = trang không tải được hoặc chỉ trả về tiêu đề. Ghi rõ ở mục 5, không suy diễn nội dung.
3. Các con số tương phản trong tài liệu do chính nhóm tính bằng công thức WCAG (độ chói tương đối sRGB, tỷ lệ (L1+0,05)/(L2+0,05)) bằng script Node cục bộ ngày 2026-11-12. Định dạng số, ngày tiếng Việt được kiểm tra bằng `Intl` của Node 24 (ICU 78.3, CLDR 48.0) và đối chiếu với trang locale. Các con số này không phải trích dẫn nguồn ngoài.
4. Khi một khuyến nghị là suy luận của nhóm (không có nguồn nói thẳng) thì ghi "Suy luận".

### 1.2 Danh sách nguồn

Hướng dẫn nền tảng và tiêu chuẩn:

| Mã | Nguồn | URL | Mức |
|---|---|---|---|
| S1 | NN/g, 10 Usability Heuristics | https://www.nngroup.com/articles/ten-usability-heuristics/ | T |
| S2 | WCAG 2.2, SC 2.5.8 Target Size (Minimum) | https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html | T |
| S3 | WCAG 2.2, SC 1.4.1 Use of Color | https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html | T |
| S4 | WCAG 2.2, SC 1.4.11 Non-text Contrast | https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html | T |
| S5 | WCAG 2.2, SC 1.4.3 Contrast (Minimum) | https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html | T |
| S6 | WCAG 2.2, SC 1.4.4 Resize Text | https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html | T |
| S7 | Android Developers, Navigation bar (Compose, M3) | https://developer.android.com/develop/ui/compose/components/navigation-bar | T |
| S8 | Google Accessibility Help, touch target 48dp | https://support.google.com/accessibility/android/answer/7101858 | T |
| S9 | Material Components Android, BottomNavigation.md | https://raw.githubusercontent.com/material-components/material-components-android/master/docs/components/BottomNavigation.md | T |
| S10 | Material Components Android, Chip.md | https://raw.githubusercontent.com/material-components/material-components-android/master/docs/components/Chip.md | T |
| S11 | Material Components Android, Card.md | https://raw.githubusercontent.com/material-components/material-components-android/master/docs/components/Card.md | T |
| S12 | Material Components Android, BottomSheet.md | https://raw.githubusercontent.com/material-components/material-components-android/master/docs/components/BottomSheet.md | T |
| S13 | Material Components Android, theming/Color.md | https://raw.githubusercontent.com/material-components/material-components-android/master/docs/theming/Color.md | T |
| S14 | Material Components Android, TopAppBar.md | https://raw.githubusercontent.com/material-components/material-components-android/master/docs/components/TopAppBar.md | T |
| S15 | Material Components Android, ProgressIndicator.md | https://raw.githubusercontent.com/material-components/material-components-android/master/docs/components/ProgressIndicator.md | T |
| S16 | Material Components Android, Dialog.md | https://raw.githubusercontent.com/material-components/material-components-android/master/docs/components/Dialog.md | T |
| S17 | Apple HIG, Tab bars (qua dữ liệu JSON của trang) | https://developer.apple.com/design/human-interface-guidelines/tab-bars (JSON: https://developer.apple.com/tutorials/data/design/human-interface-guidelines/tab-bars.json) | T |
| S18 | Apple HIG, Accessibility | https://developer.apple.com/design/human-interface-guidelines/accessibility | T |
| S19 | Apple HIG, Typography | https://developer.apple.com/design/human-interface-guidelines/typography | T |
| S20 | Apple HIG, Color | https://developer.apple.com/design/human-interface-guidelines/color | T |
| S21 | Apple HIG, Progress indicators | https://developer.apple.com/design/human-interface-guidelines/progress-indicators | T |
| S22 | Apple HIG, Sheets | https://developer.apple.com/design/human-interface-guidelines/sheets | T |
| S23 | Apple HIG, Alerts | https://developer.apple.com/design/human-interface-guidelines/alerts | T |
| S24 | Apple HIG, Lists and tables | https://developer.apple.com/design/human-interface-guidelines/lists-and-tables | T |
| S25 | Apple HIG, Widgets (glanceability) | https://developer.apple.com/design/human-interface-guidelines/widgets | T |
| S26 | Apple HIG, Gauges | https://developer.apple.com/design/human-interface-guidelines/gauges | T |
| S27 | IBM Carbon, Status indicator pattern | https://carbondesignsystem.com/patterns/status-indicator-pattern/ | T |
| S28 | GOV.UK Design System, Tag | https://design-system.service.gov.uk/components/tag/ | T |
| S29 | GOV.UK Design System, Complete multiple tasks (task list) | https://design-system.service.gov.uk/patterns/complete-multiple-tasks/ | T |
| S30 | Atlassian Design System, Lozenge usage | https://atlassian.design/components/lozenge/usage | T |
| S31 | Okabe và Ito, Color Universal Design (trang JFly) | https://jfly.uni-koeln.de/color/ | T (mã hex lấy từ S31b) |
| S31b | Mã hex Okabe-Ito, tài liệu gói R `see` | https://search.r-project.org/CRAN/refmans/see/html/okabeito_colors.html | K |
| S32 | NN/g, Mobile navigation patterns | https://www.nngroup.com/articles/mobile-navigation-patterns/ | T |
| S33 | NN/g, Confirmation dialog | https://www.nngroup.com/articles/confirmation-dialog/ | T |
| S34 | NN/g, Hamburger menus (nghiên cứu điều hướng ẩn 2015) | https://www.nngroup.com/articles/hamburger-menus/ | K |
| S35 | Android Developers, Offline-first app | https://developer.android.com/topic/architecture/data-layer/offline-first | T |

Hệ thống sản phẩm:

| Mã | Nguồn | URL | Mức |
|---|---|---|---|
| P1 | Procore, mobile và field collaboration | https://www.procore.com/en-gb/fc/mobile-and-field-collaboration | T |
| P2 | Procore, Add a Task (iOS) | https://v2.support.procore.com/product-manuals/tasks-ios/tutorials/add-a-task-ios | K |
| P3 | Procore, Add a Task (Android), có quy tắc email quá hạn | https://support.procore.com/procore-mobile-android/user-guide/tasks-android/tutorials/add-a-task-android | K |
| P4 | Procore, Add a Daily Log Entry (Android), ngoại tuyến | https://support.procore.com/procore-mobile-android/user-guide/daily-log-android/tutorials/add-a-daily-log-entry-android | K |
| P5 | Autodesk Build mobile, Initial project download | https://help.autodesk.com/cloudhelp/ENU/Build-Mobile/files/download-project/Download_Project_Initial.html | T |
| P6 | Fieldwire, Introduction to the Tasks Tab and Views | https://help.fieldwire.com/hc/en-us/articles/202634034 | K |
| P7 | Fieldwire, iPad app (bản vẽ ngoại tuyến) | https://www.fieldwire.com/construction-apps/ipad/ | K |
| P8 | Asana, 4 ways to master My Tasks | https://asana.com/resources/asana-tips-my-tasks.md | T |
| P9 | Asana, color-blind mode | https://asana.com/inside-asana/new-accessibility-feature-colorblind-friendly.md | T |
| P10 | Asana Forum, màu ngày hạn | https://forum.asana.com/t/control-start-date-and-due-date-colors/65671 | K |
| P11 | Asana, project progress and status updates | https://help.asana.com/s/article/project-progress-and-status-updates | K |
| P12 | Linear, Mobile | https://linear.app/mobile | T |
| P13 | Linear, Project graph | https://linear.app/docs/project-graph | T |
| P14 | Linear, Project status | https://linear.app/docs/project-status | T |
| P15 | Jira, câu hỏi cộng đồng "Red colour when due date is breached" | https://community.atlassian.com/t5/Jira-questions/Red-colour-when-due-date-is-breached/qaq-p/2356905 | K |
| P16 | Jira, lỗi ngày hạn lệch một ngày trên mobile JRACLOUD-67757 | https://jira.atlassian.com/browse/JRACLOUD-67757 | K |
| P17 | monday.com, Conditional Coloring | https://support.monday.com/hc/en-us/articles/360015468399-Conditional-Coloring | K |
| P18 | monday.com cộng đồng, Conditional Coloring on Mobile App | https://community.monday.com/t/conditional-coloring-on-mobile-app/121577 | K |
| P19 | ClickUp, đề xuất "Overdue tasks should be clearly visible on mobile" | https://feedback.clickup.com/new-mobile-app/p/overdue-tasks-should-be-clearly-visible-and-organized-on-mobile | K (chỉ tiêu đề) |
| P20 | Cultured Code, Things: Today / Upcoming | https://culturedcode.com/things/support/articles/2803579/ | K |
| P21 | Todoist, bài viết Smart Schedule (Adweek) | https://www.adweek.com/?p=496731 | K |
| P22 | Todoist, mục Overdue bị gập trông như trống | https://blog.vghaisas.com/til-todoist-overdue/ | K |
| P23 | Smartsheet, Available symbols for the symbols column | https://help.smartsheet.com/articles/2480316-available-symbols-in-symbols-column | T |
| P24 | Microsoft Project, Status Indicator (task field) | https://support.microsoft.com/en-us/project/status-indicator-task-field | K |
| P25 | Oracle Primavera P6, Bars tab | https://docs.oracle.com/cd/F74773_01/p6help/en/91597.htm | K |
| P26 | Tensix, P6 super critical bars | https://tensix.com/primavera-p6-and-super-critical-bars/ | K |
| P27 | SAP, My Inbox (flexible workflow) | https://learning.sap.com/courses/sap-workflow-overview-basics-strategy-and-extensibility/performing-further-settings | K |
| P28 | SAP Concur, mobile app | https://www.concur.com/products/mobile-app | K |
| P29 | SAP Concur cộng đồng, Audit trail mobile app | https://community.concur.com/t5/Concur-Expense-Forum/Audit-trail-mobile-app/m-p/62365 | K |
| P30 | Workday Inbox, hướng dẫn Louisville | https://service.louisville.edu/TDClient/277/Portal/KB/Article/20808/Using-Your-Workday-Inbox | K |
| P31 | ServiceNow, Approvals experience reference | https://www.servicenow.com/docs/r/etYGEBUVr6RQYKLnfpRuhw/rtCVYhQ8MHHEF5SGr1hq_g | T |
| P32 | DocuSign, ký trên Android | https://www.docusign.com/blog/how-to-sign-document-android-phone-or-tablet | K |
| P33 | Adobe Acrobat Sign mobile, Sign documents | https://www.adobe.com/devnet-docs/adobesign/android/en/sign.html | K |
| P34 | Adobe, Mobile-friendly view | https://experienceleague.adobe.com/en/docs/document-cloud-learn/sign-learning-hub/mobile/mobile-tutorials/mobile-friendly | K |
| P35 | MoMo, blog an toàn bảo mật | https://www.momo.vn/blog/momo-co-an-toan-khong-giai-dap-tu-a-z-thong-tin-c198dt2342 | K |
| P36 | Locale Planet, ICU vi-VN | http://www.localeplanet.com/icu/vi-VN/index.html | T |
| P37 | Wikipedia, Date and time notation in Vietnam | https://en.wikipedia.org/wiki/Date_and_time_notation_in_Vietnam | T |
| P38 | Công văn 10010/CT-TTHT (2013) về dấu phân cách trên hóa đơn | https://thuvienphapluat.vn/cong-van/Thue-Phi-Le-Phi/Cong-van-10010-CT-TTHT-nam-2013-dau-phan-cach-tren-hoa-don-Ho-Chi-Minh-250331.aspx | K |
| P39 | Kosara, Data Display vs. Data Visualization (chỉ trích đồng hồ gauge) | https://www.eagereyes.org/blog/2012/data-display-vs-data-visualization | K |
| P40 | Tableau, Bullet graphs beat gauge charts | https://www.tableau.com/blog/bullet-graphs-beat-gauge-charts | K |
| P41 | Cursa, Resilient UX: stale indicators, queued actions | https://cursa.app/en/page/resilient-ux-stale-indicators-queued-actions-and-graceful-degradation | K (blog, độ tin cậy thấp) |
| P42 | TypeDrawers, dấu tiếng Việt xếp chồng và giãn dòng | https://typedrawers.com/discussion/comment/67954 | K |
| P43 | Norman và Nielsen, Gestural interfaces: a step backward (bản tóm tắt) | https://ignorethecode.net/blog/2010/05/30/nielsen_and_norman_on_gestures/ | K |
| P44 | Material Design 2, Empty states | https://m2.material.io/design/communication/empty-states.html | K |
| P45 | Salesforce Lightning, Empty state | https://spring-20.lightningdesignsystem.com/guidelines/empty-state | K |

---

## 2. Nghiên cứu theo nhóm

Quy ước cột: "Áp dụng" là điều nhóm lấy làm chuẩn cho v2; "Loại bỏ" là điều không lấy; "Lý do" gắn với bối cảnh PIS (cán bộ quản lý dự án đầu tư, hiện trường, mạng yếu, tiếng Việt dấu dài, hai phiên bản công và doanh nghiệp).

### 2.1 Ứng dụng hiện trường xây dựng: Procore, Autodesk Build, Fieldwire

Điểm chính từ nguồn:

- Procore tuyên bố xem bản vẽ hiện hành khi không có sóng, nhật ký công trường (daily log, "site diaries") và danh sách lỗi (snag list) cập nhật ngoại tuyến rồi đồng bộ khi có mạng; ảnh chụp gắn thẳng vào bản vẽ; quan sát hiện trường liên kết với công việc để rõ trách nhiệm [P1][T]. Tài liệu Android nói các thao tác nhật ký làm được ngoại tuyến và đồng bộ sau [P4][K].
- Trạng thái công việc Procore: Initiated, In Progress, Ready for Review, Closed, Void. Email nhắc quá hạn hằng ngày chỉ gửi khi quá hạn và trạng thái là Initiated hoặc In Progress; không gửi khi Ready for Review, Closed, Void [P2][P3][K].
- Autodesk Build mobile cho chọn gói tải về trước khi đi hiện trường: chỉ bản vẽ hiện hành, tất cả phiên bản hoặc không; ảnh 7/14/30/60 ngày gần nhất; chỉ vấn đề đang mở; biểu mẫu chỉ đang xử lý; đồng bộ nền chỉ khi đang sạc và có Wi-Fi [P5][T].
- Fieldwire: công việc ghim lên bản vẽ; mặc định có cột Overdue, Due Today, In Progress khi có ngày bắt đầu và kết thúc; quá hạn là ngày kết thúc đã qua và chưa Complete hoặc Verified; ghim chuyển đỏ khi đến hạn hôm nay hoặc quá hạn, "không ảnh hưởng độ ưu tiên" [P6][K]. Bản vẽ xem và chú thích ngoại tuyến [P7][K].

| Hệ thống | Mẫu thiết kế đáng chú ý | Áp dụng | Loại bỏ | Lý do | Nguồn (URL) |
|---|---|---|---|---|---|
| Procore | Trạng thái công việc là chuỗi ngắn có bước "Ready for Review"; quá hạn chỉ tính khi còn mở | Quá hạn chỉ tính cho trạng thái "Đang làm / Chưa bắt đầu"; việc "Chờ duyệt" không bị tô đỏ trễ hạn | Đếm trễ hạn cho việc đã gửi duyệt | Cán bộ đã xong phần mình thì không bị "phạt" bằng màu đỏ; tránh nhiễu danh sách | P2, P3 (support.procore.com) |
| Procore | Nhật ký ngoại tuyến, thay đổi lưu cục bộ rồi đồng bộ | Báo cáo hiện trường ghi cục bộ trước (ghi lười), hiện nhãn "Chờ đồng bộ" | Bắt buộc có mạng để lưu nháp | Hiện trường mạng yếu; mất báo cáo là thất bại nghiêm trọng | P1, P4 |
| Autodesk Build | Gói tải ngoại tuyến chọn theo phạm vi và theo ngày (ảnh N ngày, hồ sơ đang mở) | Màn "Dữ liệu ngoại tuyến": chọn dự án, hồ sơ, ảnh theo số ngày; hiện dung lượng | Đồng bộ nền chỉ khi sạc và có Wi-Fi | Cán bộ hiện trường ít khi cắm sạc, mạng di động là mạng chính; để người dùng chủ động và tự đồng bộ khi có mạng | P5 |
| Autodesk Build | Đánh giá người dùng trên App Store nói mất dữ liệu làm ngoại tuyến khi tải lên (chỉ là giai thoại) | Hàng chờ gửi (outbox) hiển thị số lượng, thử lại, không bao giờ im lặng bỏ dữ liệu | Đồng bộ im lặng không báo lỗi | Niềm tin: một lần mất dữ liệu làm hỏng cả ứng dụng | Kết quả tìm kiếm App Store (K): https://apps.apple.com/app/plangrid-build-field-app/id498795789 |
| Fieldwire | Việc ghim trên bản vẽ, cột Overdue / Due Today / In Progress; màu ghim độc lập với ưu tiên | Tách ba trục riêng: trạng thái, hạn, ưu tiên; mỗi trục một ký hiệu riêng | Dùng một màu để gộp "hôm nay" và "trễ" (Fieldwire đỏ cả hai) | Hôm nay chưa trễ; gộp làm mất thang bậc cảnh báo | P6 |
| Fieldwire | Nhóm theo cột trạng thái, ưu tiên 1 2 3 | Bảng nhóm "Trễ hạn / Hôm nay / Sắp tới" cho "Việc hôm nay" | Giao diện Kanban kéo thả trên điện thoại | Kéo thả ngang trên màn nhỏ khó dùng một tay; nhóm dọc có tiêu đề dính (sticky) đủ dùng | P6 |
| Fieldwire | Bản vẽ ngoại tuyến, ghim việc theo vị trí | Dự án có hồ sơ/bản vẽ: mở ngoại tuyến sau khi tải | Làm màn hình bản vẽ phức tạp ở v2 | Ngoài phạm vi 6 màn mẫu; ghi nhận làm bước sau | P7 |

### 2.2 Ứng dụng việc cá nhân và quản lý công việc: Asana, Jira, Linear, Monday, ClickUp, Things 3, Todoist

Điểm chính từ nguồn:

- Asana My Tasks có 4 mục mặc định Recently Assigned, Today, Upcoming, Later; Asana tự chuyển việc vào Today một ngày trước hạn và Upcoming một tuần trước hạn [P8][T]. Màu ngày hạn mặc định (diễn đàn người dùng): xám sắp tới, xanh lục hôm nay, đỏ quá hạn; người dùng xin màu vàng cho hôm nay, Asana chưa chấp nhận theo bằng chứng tìm được [P10][K]. Chế độ mù màu: ngày hạn quá hạn in đậm thêm [P9][T].
- Linear mobile: Inbox "chạm để xử lý, vuốt để xóa, hoãn (snooze) để xử lý sau"; thông báo đẩy có lịch giờ nhận [P12][T]. Trang mobile không nhắc ngoại tuyến.
- Monday: tô màu có điều kiện chỉ hỗ trợ giá trị cố định, không so sánh ngày động; cách làm là tự động hóa đặt trạng thái rồi tô trạng thái; người dùng báo di động không hiển thị màu như máy tính (chưa xác nhận từ monday.com) [P17][P18][K].
- Things 3: Today chỉ nên chứa việc thật sự làm hôm nay, có mục This Evening; Upcoming có 7 ngày tới liệt kê riêng bắt đầu từ ngày mai; việc có hạn chót vẫn nằm ở Anytime; nên đặt ngày bắt đầu sớm hơn hạn chót nếu cần nhiều hơn một ngày [P20][K].
- Todoist: kéo vuốt để dời lịch và dời hàng loạt việc trễ [P21][K]; mục Overdue bị gập làm người dùng tưởng trống, phải chạm mũi tên để thấy [P22][K].
- Jira: không tìm được tài liệu chính thức về tô đỏ quá hạn trên mobile. Có lỗi công khai ngày hạn hiển thị lệch một ngày trên mobile [P16][K] và hỏi đáp cộng đồng nhắc biểu tượng tam giác cảnh báo đỏ trên roadmap web [P15][K].
- ClickUp: có đề xuất công khai yêu cầu việc quá hạn phải hiển thị rõ ràng và tách bạch trên mobile (chỉ thấy tiêu đề) [P19][K].

| Hệ thống | Mẫu thiết kế đáng chú ý | Áp dụng | Loại bỏ | Lý do | Nguồn (URL) |
|---|---|---|---|---|---|
| Asana | My Tasks theo mục: Recently Assigned, Today, Upcoming, Later, tự chuyển theo hạn | "Việc hôm nay" nhóm: Mới giao, Trễ hạn, Hôm nay, Sắp tới (7 ngày), Sau đó, Chưa đặt hạn; số đếm ở tiêu đề nhóm | Tự chuyển ở máy khách | Quy tắc phân nhóm tính phía máy chủ theo múi giờ Asia/Ho_Chi_Minh để mọi thiết bị giống nhau | P8 https://asana.com/resources/asana-tips-my-tasks.md |
| Asana | Mục "Recently Assigned" là hộp tiếp nhận cần phân loại | Nhóm "Mới giao" cho việc chưa xác nhận đã xem; một chạm "Đã nhận" | Bắt cán bộ tự kéo việc sang nhóm khác | Cán bộ hiện trường không có thời gian sắp xếp thủ công; hệ thống phân nhóm sẵn | P8 |
| Asana | Chế độ mù màu: quá hạn in đậm thêm | Quá hạn luôn dùng chữ đậm 700 cùng biểu tượng, không phụ thuộc màu | Chỉ đổi bảng màu | Màu đơn thuần không đủ (WCAG 1.4.1) | P9 https://asana.com/inside-asana/new-accessibility-feature-colorblind-friendly.md ; S3 |
| Asana | Ngày hạn "hôm nay" màu xanh lục (diễn đàn) | Hôm nay dùng dải hổ phách, không xanh lục | Xanh lục cho "hôm nay" | Xanh lục nghĩa là ổn; hôm nay là điểm cần chú ý; chính người dùng Asana đã xin màu vàng | P10 https://forum.asana.com/t/control-start-date-and-due-date-colors/65671 |
| Linear | Inbox: chạm để xử lý, hoãn, vuốt xóa; thông báo có lịch giờ | Thông báo: vuốt chỉ cho "Đánh dấu đã đọc" (hoàn tác được); lịch giờ yên lặng ở Cá nhân | Vuốt để xóa không hoàn tác | Xóa mất dấu vết hành chính; mọi vuốt phải có nút tương đương hiển thị | P12 https://linear.app/mobile ; P43 |
| Linear | Đồ thị dự án có phạm vi, ngày dự kiến hoàn thành, đường đỏ ngày mục tiêu | Chỉ lấy một dòng chữ "Dự kiến hoàn thành" và đường mốc kế hoạch trên thanh tiến độ | Biểu đồ burn-up trên điện thoại | Biểu đồ nhiều đường khó đọc trên màn nhỏ; chữ ngắn đủ quyết định | P13 https://linear.app/docs/project-graph |
| Jira | Chưa kiểm chứng được cách hiển thị quá hạn trên mobile; có lỗi lệch ngày | Tính "hạn" theo ngày lịch (chỉ ngày, múi giờ cố định UTC+7), không so thời điểm | So sánh thời điểm có múi giờ | Lỗi lệch một ngày của Jira là bài học trực tiếp cho dải "Trễ N ngày" | P16 https://jira.atlassian.com/browse/JRACLOUD-67757 |
| Monday | Màu có điều kiện không đọc được ngày động; mobile có thể không tô màu | Dải hạn tính trung tâm (máy chủ trả về `band` và `daysDelta`), mobile là công dân hạng nhất | Phụ thuộc cấu hình màu thủ công của từng bảng | Hai bản (công, doanh nghiệp) và nhiều thiết bị cần cùng một quy tắc | P17, P18 |
| ClickUp | Người dùng đòi việc quá hạn nổi bật và tách riêng trên mobile | Nhóm "Trễ hạn" luôn ở đầu, luôn mở, có số đếm | Lẫn trễ hạn vào danh sách chung | Đây chính là phàn nàn "không có tổ chức" của khách | P19 |
| Things 3 | Today chỉ chứa việc thật sự làm hôm nay; Upcoming 7 ngày đầu tách từng ngày; ngày bắt đầu khác hạn chót | "Việc hôm nay" chỉ gồm trễ + đến hạn hôm nay + việc đang làm; 7 ngày sau gom theo từng ngày (T2..CN) | Lẫn mọi việc vào một danh sách dài | Giảm tải nhận thức; một màn hình trả lời "hôm nay tôi phải làm gì" | P20 https://culturedcode.com/things/support/articles/2803579/ |
| Todoist | Dời lịch hàng loạt việc trễ; mục Overdue bị gập thì tưởng trống | "Xin gia hạn" là hành động chính ở chi tiết việc; tiêu đề nhóm luôn hiện số đếm kể cả khi gập | Dời lịch tự do không lý do | Ở PIS dời hạn là nghiệp vụ có duyệt, cần lý do và hồ sơ | P21, P22 |

### 2.3 Phê duyệt và ký: ngân hàng, hệ thống phê duyệt doanh nghiệp, ký điện tử

Điểm chính từ nguồn:

- SAP My Inbox: người duyệt có thể Approve, Reject, Claim, Suspend, Forward, xem lịch sử phê duyệt; có luồng bắt buộc nhập bình luận trước khi duyệt hoặc từ chối; màu xanh lục và đỏ cho hai nút được cấu hình sẵn [P27][K].
- Workday Inbox: nút Approve, Deny, Send Back nằm cuối mỗi mục; Deny dừng cả tiến trình ("dùng thận trọng"), Send Back khi cần sửa; sau khi xử lý, mục kế tiếp trong Inbox tự hiện [P30][K].
- ServiceNow: ghi mỗi hành động và bình luận kèm tên người duyệt; từ chối kèm bình luận tạo thêm một mục bình luận; chỉ yêu cầu còn mở mới hiện [P31][T].
- SAP Concur: quản lý duyệt, từ chối báo cáo chi phí ngay trên di động [P28][K]; cộng đồng báo log "đã xem biên lai" chỉ ghi nếu xem ở cả cấp tiêu đề và cấp khoản mục, nhiều người báo không ghi, và duyệt do người được ủy quyền chỉ hiện tên người duyệt chính, không nói có ủy quyền [P29][K].
- DocuSign: bước "Next" nhảy tới trường bắt buộc kế tiếp, "Finish" chỉ có khi mọi trường bắt buộc đã xong; cộng đồng hỏi vì sao không bấm được Finish, nguyên nhân thường là còn trường bắt buộc bỏ sót [P32][K]. Adobe Sign: danh sách "Waiting for You", "Start" hiện mọi trường bắt buộc, "Finish" khi đủ; chế độ mobile-friendly có dấu * ở trường bắt buộc, thanh tiến độ xanh dương lấp dần, lỗi đỏ ngay dưới trường [P33][P34][K].
- Ngân hàng, ví Việt: MoMo công bố nhiều lớp xác thực (PIN, OTP, sinh trắc, AI) cho giao dịch [P35][K]. Không tải được thông số giao diện màn xác nhận của VCB Digibank hay MoMo (xem mục 5). Chỉ biết VCB Digibank có bản "chữ to, số rõ" cho khách lớn tuổi (tiêu đề bài báo Lao Động trong kết quả tìm kiếm, chưa đọc được nội dung) [X].

| Hệ thống | Mẫu thiết kế đáng chú ý | Áp dụng | Loại bỏ | Lý do | Nguồn (URL) |
|---|---|---|---|---|---|
| SAP My Inbox | Duyệt, từ chối, chuyển tiếp, xem lịch sử; bình luận bắt buộc ở một số luồng | Từ chối và Trả lại bắt buộc có lý do; Duyệt cho phép ghi chú tùy chọn; có "Chuyển tiếp" nếu ủy quyền bật | Gộp từ chối và trả lại làm một | Nghiệp vụ hành chính cần phân biệt "không đồng ý" và "bổ sung" | P27 https://learning.sap.com/courses/sap-workflow-overview-basics-strategy-and-extensibility/performing-further-settings |
| SAP My Inbox | Nút xanh lục cho duyệt, đỏ cho từ chối | Giữ ngữ nghĩa nhưng thêm biểu tượng và chữ động từ rõ | Chỉ dựa vào màu | WCAG 1.4.1, HIG Color | P27 ; S3 ; S20 |
| Workday | Approve / Deny / Send Back; Deny dừng cả quy trình; sau khi xử lý tự sang mục kế tiếp | Ba hành động: Phê duyệt, Trả lại, Từ chối; sau thao tác có nút "Hồ sơ tiếp theo" | Hai nút duy nhất duyệt/từ chối | "Trả lại để bổ sung" là đường thường gặp nhất, tránh người duyệt bấm từ chối khi chỉ cần sửa | P30 https://service.louisville.edu/TDClient/277/Portal/KB/Article/20808/Using-Your-Workday-Inbox |
| ServiceNow | Mỗi hành động và bình luận là một bản ghi có tên người duyệt | Lịch sử phê duyệt mỗi hồ sơ: người, vai trò, hành động, dd/MM/yyyy HH:mm, ghi chú | Ghi nhật ký chung chung không có tên | Kiểm toán nhà nước và nội bộ cần truy vết | P31 https://www.servicenow.com/docs/r/etYGEBUVr6RQYKLnfpRuhw/rtCVYhQ8MHHEF5SGr1hq_g |
| SAP Concur | Nhật ký "đã xem biên lai" không ổn định; ủy quyền chỉ hiện tên người duyệt chính | Ghi nhật ký "đã xem hồ sơ" ở cấp hồ sơ và hiển thị "A (thay mặt B)" khi ủy quyền | Chỉ ghi khi mở một cấp | Khiếu nại thực tế của người dùng Concur: kiểm toán thiếu bằng chứng | P29 https://community.concur.com/t5/Concur-Expense-Forum/Audit-trail-mobile-app/m-p/62365 |
| DocuSign / Adobe Sign | Hướng dẫn từng bước tới trường bắt buộc; "Finish" chỉ khi đủ; có thanh tiến độ, dấu * | Hoàn thành việc: danh sách hồ sơ bắt buộc "2/3", nút "Hoàn thành" luôn bấm được nhưng hiện thông báo thiếu gì và nhảy tới mục thiếu | Nút bị làm mờ không nói lý do (cộng đồng DocuSign hỏi vì sao không bấm được Finish) | Nút vô hiệu không giải thích vi phạm heuristic 1 và 9 của Nielsen | P32 https://www.docusign.com/blog/how-to-sign-document-android-phone-or-tablet ; P33 ; S1 |
| MoMo, ngân hàng | Nhiều lớp xác thực (PIN, OTP, sinh trắc) cho giao dịch | Tùy chọn: xác thực lại bằng sinh trắc hoặc mã PIN cho phê duyệt từ ngưỡng giá trị cấu hình | Bắt xác thực lại mọi thao tác | Xác nhận quá nhiều làm người dùng bấm lướt (NN/g) | P35 ; S33 |
| NN/g, Apple | Hộp xác nhận chỉ cho việc hậu quả nghiêm trọng; nút ghi động từ cụ thể; ưu tiên hoàn tác | Bảng xác nhận phê duyệt có mô tả cụ thể số tiền và hồ sơ; nút "Phê duyệt 12,5 tỷ đồng" thay "Đồng ý" | Hộp thoại "Bạn có chắc?" | NN/g: phải nhắc lại yêu cầu và nêu rõ cái sắp xảy ra; HIG: nút là động từ | S33 https://www.nngroup.com/articles/confirmation-dialog/ ; S23 https://developer.apple.com/design/human-interface-guidelines/alerts |
| M3, Apple | Bảng đáy (bottom sheet) modal cho tập lựa chọn chặn phần còn lại; bảng có thanh kéo, vuốt để đóng | Xác nhận phê duyệt dùng bottom sheet modal, thanh kéo, đóng bằng vuốt hoặc Huỷ | Dialog giữa màn hình cho luồng nhiều trường | Một tay với tới nút ở đáy dễ hơn; sheet chứa trường ghi chú tốt hơn dialog | S12 ; S22 ; S16 |
| Android offline-first | Ghi trực tuyến bắt buộc (ví dụ chuyển khoản) nên vô hiệu giao diện hoặc báo ngoại tuyến | Phê duyệt chỉ thực hiện khi trực tuyến; ngoại tuyến thì nút hiện lý do "Cần có mạng để phê duyệt" | Xếp hàng phê duyệt chờ đồng bộ | Phê duyệt là hành vi pháp lý, thời điểm và dữ liệu hồ sơ phải khớp phía máy chủ | S35 https://developer.android.com/topic/architecture/data-layer/offline-first |

### 2.4 Hướng dẫn thiết kế: Material Design 3, Apple HIG, WCAG 2.2, Nielsen

Tóm tắt các điều đã đọc từ nguồn gốc:

**Material Design 3 (qua tài liệu Material Components và developer.android.com; trang m3.material.io không tải được, xem mục 5)**
- Navigation bar dùng cho 3 đến 5 đích đến ngang hàng, cửa sổ compact, đích nhất quán [S7][T]; "navigation bars can have three to five destinations" [S9][T]. Nhãn mặc định: hiện cho mọi mục khi ≤ 3 mục, chỉ mục được chọn khi ≥ 4 mục [S9][T]. Huy hiệu (badge) có thể là số, chữ hoặc chỉ chấm [S9][T].
- Top app bar: small cho bố cục dày hoặc khi cuộn; "medium flexible" tiêu đề lớn thu nhỏ khi cuộn; "large flexible" nhấn mạnh tiêu đề; bản medium và large cũ đã bị loại bỏ [S14][T].
- Card có ba kiểu: elevated (đổ bóng, tách nền), filled (tách nhẹ, ít nhấn), outlined (viền, nhấn nhất, là mặc định); cả ba có độ đọc và chức năng như nhau, chọn theo mức nhấn [S11][T].
- Chip: assist, filter, input, suggestion; vùng chạm tối thiểu mặc định 48dp [S10][T].
- Bottom sheet: standard cùng tồn tại với màn hình chính, không có scrim; modal chặn tương tác, có scrim, thay cho menu và hộp thoại đơn giản; thanh kéo tùy chọn, tối thiểu 48dp [S12][T].
- Dialog là chủ ý gây gián đoạn, dùng tiết kiệm [S16][T].
- Vai trò màu: primary/secondary/tertiary cùng container và on-colors; vai trò error có error, error container; bề mặt theo tầng surface container thay cho lớp phủ nâng; chủ đề tối dùng tone 80 cho điểm nhấn, tone 30 cho container; khi tạo màu tùy biến phải giữ cùng độ chói để không phá yêu cầu tương phản [S13][T].
- Chỉ báo tiến độ: tuyến tính có đường ray cố định nhìn thấy, tròn có đường ray ẩn và có thể đặt trên thẻ; chỉ dùng một loại cho mỗi hoạt động; chuỗi tiến trình nên hiện tiến độ tổng thể [S15][T]; thanh ≤ 4dp có thể không vẽ chỉ báo focus cho TalkBack [S15][T].
- Vùng chạm 48dp, cách nhau 8dp [S8][T].
- Trạng thái rỗng: tải được trang Material 1 và 2 (cũ) nói về hình và dòng chữ không tương tác [P44][K]; không tìm được trang M3 mới. Lightning: thông điệp bắt buộc, nút hành động và hình tùy chọn [P45][K].

**Apple HIG**
- Tab bar: giữ luôn hiển thị khi điều hướng; số tab vừa đủ, "avoid overflow tabs"; "include tab labels... use single words whenever possible"; badge chỉ cho thông tin quan trọng ("a red oval containing white text and either a number or an exclamation point"); tab bar là điều hướng, không phải hành động; không vô hiệu hoặc ẩn tab, mục rỗng thì giải thích vì sao [S17][T].
- Vùng chạm mặc định 44x44pt, tối thiểu 28x28pt; đệm khoảng 12pt quanh phần tử có viền, 24pt quanh phần tử không viền [S18][T].
- Tương phản theo WCAG AA: chữ đến 17pt cần 4,5:1; 18pt hoặc đậm cần 3:1; phải kiểm tra cả sáng và tối, và có phương án Tăng tương phản [S18][T]. "Convey information with more than color alone", ví dụ hình dạng hoặc biểu tượng riêng cho từng trạng thái [S18][T]; "Avoid relying solely on color..." [S20][T].
- Chữ: kích thước mặc định 17pt, tối thiểu 11pt; hỗ trợ phóng chữ ít nhất 200% [S18][S19][T]. Bảng Dynamic Type: Body 17pt mặc định, Footnote 13, Caption 1 12, Caption 2 11; ở cỡ AX5 Body là 53 [S19][T].
- Danh sách: giữ chữ dòng ngắn gọn, nếu nhiều chữ thì chỉ liệt kê tiêu đề và mở chi tiết; trang không nói về swipe action [S24][T].
- Widgets (độ "đọc lướt"): chỉ thông tin trực tiếp phục vụ mục đích chính, cân bằng mật độ, chữ ≥ 11pt, "convey meaning without relying on specific colors", hiện thời điểm cập nhật cuối khi dữ liệu không liên tục [S25][T].
- Sheet: medium/large detent, thanh kéo, vuốt để đóng, nếu có Done thì ghép với Cancel, mỗi lần một sheet [S22][T]. Alert: dùng tiết kiệm, nút là động từ cụ thể, đừng đặt Cancel làm mặc định [S23][T].
- Tiến độ: ưu tiên chỉ báo xác định (determinate), phải chính xác và đều nhịp, hiện mô tả ngắn có ích, đặt nhất quán [S21][T]. Gauge: nhãn cho giá trị hiện tại và hai đầu khoảng [S26][T].

**WCAG 2.2**
- 1.4.1: màu không được là phương tiện duy nhất; trạng thái lỗi chỉ màu đỏ là không đạt; cần biểu tượng hoặc chữ; hai màu khác cả sắc độ và độ chói với tỷ lệ ≥ 3:1 được coi là khác biệt bổ sung nhưng với xanh/đỏ hợp lệ/không hợp lệ vẫn cần dấu hiệu thêm [S3][T].
- 1.4.3: chữ thường 4,5:1; chữ lớn (≥ 18pt hoặc 14pt đậm) 3:1; ngưỡng, 4,499:1 là trượt [S5][T].
- 1.4.11: thành phần giao diện và đối tượng đồ họa cần ≥ 3:1 với màu liền kề; ví dụ ngôi sao vàng nhạt trên trắng 1,2:1 là trượt; viền #767676 trên trắng đạt [S4][T].
- 1.4.4: chữ phóng đến 200% không mất nội dung và chức năng; mọi mức trung gian cũng vậy; chữ cắt bớt chỉ chấp nhận nếu toàn bộ nội dung hiện ra khi kích hoạt và người dùng được báo [S6][T].
- 2.5.8 (AA): mục tiêu ≥ 24x24 CSS px, hoặc có khoảng cách đủ; 44x44 px là ngưỡng nâng cao [S2][T].

**Nielsen, 10 heuristic áp dụng cho di động** (định nghĩa lấy từ [S1][T]; cột phải là suy luận áp dụng của nhóm)

| # | Heuristic | Áp dụng trên ứng dụng PIS |
|---|---|---|
| 1 | Visibility of system status | Dải hạn ba màu có chữ; nhãn "Chờ đồng bộ"; dòng "Cập nhật 09:41"; tiến độ có số % |
| 2 | Match system and real world | Từ nghiệp vụ: "Trễ 3 ngày", "Trình ký", "Trả lại"; số tiền theo "tỷ đồng, triệu đồng"; ngày dd/MM/yyyy |
| 3 | User control and freedom | Hoàn tác khi vuốt "đã đọc"; Huỷ ở mọi sheet; nút Quay lại cố định |
| 4 | Consistency and standards | Cùng một bộ chip, biểu tượng, định dạng số/ngày ở cả 6 màn và cả hai phiên bản; theo chuẩn M3 và HIG cho tab, sheet |
| 5 | Error prevention | Bảng xác nhận nêu số tiền; kiểm tra hồ sơ bắt buộc trước khi hoàn thành; vô hiệu phê duyệt khi ngoại tuyến kèm lý do |
| 6 | Recognition rather than recall | Thẻ hiển thị đủ dữ kiện để quyết định; không bắt nhớ thông tin từ màn trước |
| 7 | Flexibility and efficiency | Bộ lọc chip "Trễ / Hôm nay"; "Hồ sơ tiếp theo"; phím tắt vuốt chỉ làm đường tắt cho nút hiển thị |
| 8 | Aesthetic and minimalist design | Tối đa 3 đến 4 chỉ số ở màn lãnh đạo; mỗi thẻ ≤ 5 dòng |
| 9 | Recognize, diagnose, recover from errors | Lỗi đồng bộ: nói rõ cái gì, vì sao, nút "Thử lại"; báo thiếu hồ sơ nào |
| 10 | Help and documentation | Trạng thái rỗng giải thích và có lối đi; tooltip một lần cho thao tác vuốt |

### 2.5 Dải hạn và trạng thái RAG: ai làm thế nào

Điểm chính từ nguồn:

- IBM Carbon: chỉ báo trạng thái kết hợp biểu tượng, hình dạng, màu, chữ; "at least three of these elements must be present" để đạt WCAG; màu: đỏ nguy hiểm, cam cảnh báo nghiêm trọng, vàng cảnh báo thường, lục bình thường/thành công, lam thông báo hoặc tiến độ quy trình, xám nháp hoặc chưa bắt đầu; tương phản phi văn bản ≥ 3:1; chỉ báo hình dạng cần viền và chữ, nhất là cam và vàng nhạt trên nền sáng; hợp nhất trạng thái dùng màu chú ý cao nhất; tránh hơn 5 đến 6 chỉ báo trên một màn; hình dạng mang nghĩa văn hóa (lục giác là dừng, tam giác ngược là nhường) [S27][T].
- GOV.UK Tag: màu có xám, lục, lam ngọc, lam, tím, đỏ tươi, đỏ, cam, vàng; "Do not use colour alone"; thẻ nền sáng chữ tối thay cho chữ trắng nền tối vì người dùng tưởng thẻ là nút; đỏ chỉ dành cho lỗi [S28][S29][T]. Task list: Completed là chữ đen không nền; Not yet started / In progress dùng màu; Cannot start yet là chữ xám không liên kết [S29][T].
- Atlassian Lozenge: màu ngữ nghĩa cho trạng thái quy trình hoặc rủi ro, nhãn ngắn dạng "On track", "Blocked", viết hoa chữ đầu; "Don't use color alone"; kèm chữ và nếu hữu ích có biểu tượng [S30][T].
- Smartsheet: bộ ký hiệu có sẵn đỏ-vàng-lục, thêm lam hoặc xám, hình thời tiết, quả cầu Harvey (rỗng đến đầy), mũi tên lên-xuống; không thêm ký hiệu tùy biến; cộng đồng hay dùng quy tắc cuộn "đỏ nếu có bất kỳ đỏ" [P23][T].
- Microsoft Project: dùng biểu tượng chứ không dựa vào màu: dấu tích là xong, đồng hồ có dấu tích là đúng tiến độ, đồng hồ có dấu chấm than là trễ [P24][K].
- Primavera P6: thanh đỏ cho hoạt động găng (critical), thanh "super critical" tùy biến cho độ trôi âm (negative float, tức trễ so với lịch) [P25][P26][K]. Đỏ ở P6 nghĩa "đường găng" chứ không phải "quá hạn", cần tránh nhầm khi hiển thị lịch dự án.
- Asana: mô tả trạng thái dự án On track (lục), At risk (vàng), Off track (đỏ), On hold, Complete [P11][K]. Đã nêu ở 2.2 về ngày hạn và chế độ mù màu.
- Monday: cam là sắp đến hạn, đỏ là quá hạn trên cột timeline, đổi màu theo trạng thái (diễn đàn, chưa xác nhận chính thức) [P17][K].
- Procore, Fieldwire: đã nêu ở 2.1.

| Hệ thống | Mẫu thiết kế đáng chú ý | Áp dụng | Loại bỏ | Lý do | Nguồn (URL) |
|---|---|---|---|---|---|
| IBM Carbon | Quy tắc ≥ 3 yếu tố (biểu tượng, hình, màu, chữ); 3:1 cho chỉ báo; viền cho chỉ báo hình khi cam/vàng trên nền sáng | Chip hạn: biểu tượng + hình riêng + màu + chữ (4 yếu tố); chip có viền 1dp | Chấm màu trơn kèm chữ rất nhỏ | Khách có thể có người dùng mù màu; hổ phách trên trắng rất yếu (xem bảng 5.2) | S27 https://carbondesignsystem.com/patterns/status-indicator-pattern/ |
| GOV.UK | Thẻ nền sáng chữ tối; đỏ chỉ cho lỗi; trạng thái hoàn thành là chữ thường không nền | Chip nền nhạt, chữ tối; "Đã xong" là chữ xám đậm có dấu tích, không nền | Chip nền đậm chữ trắng cho trạng thái | Giảm nhầm với nút; giảm "gào" khi danh sách dài | S28, S29 https://design-system.service.gov.uk/components/tag/ |
| Atlassian | Lozenge nhãn ngắn, chữ đầu viết hoa, chữ + biểu tượng | Nhãn sentence case: "Trễ 3 ngày", "Còn 2 ngày"; độ dài ≤ 14 ký tự ở cỡ chữ 1,0 | Viết HOA TOÀN BỘ | Dấu tiếng Việt dày hơn, in hoa tăng độ cao và khó đọc (suy luận); ngắn giúp không bị cắt khi chữ phóng to | S30 https://atlassian.design/components/lozenge/usage |
| Microsoft Project | Biểu tượng riêng (tích, đồng hồ tích, đồng hồ chấm than) thay màu | Tham khảo ý tưởng đồng hồ cho "sắp đến hạn" | Sao chép nguyên biểu tượng Microsoft | Chứng minh biểu tượng hình là chuẩn doanh nghiệp quen thuộc | P24 https://support.microsoft.com/en-us/project/status-indicator-task-field |
| Smartsheet | Bộ ký hiệu R-Y-G(-Blue/-Gray), Harvey ball; cuộn "đỏ nếu có đỏ" | Thẻ dự án cuộn trạng thái theo "xấu nhất" của con (Carbon cũng nói dùng màu chú ý cao nhất) | Cho tự do thêm màu thứ 5, 6 | Tối đa ba dải hạn cộng "xong" và "chưa đặt hạn" | P23 https://help.smartsheet.com/articles/2480316-available-symbols-in-symbols-column ; S27 |
| Primavera P6 | Đỏ chỉ đường găng; thanh riêng cho độ trôi âm | Trên lịch giai đoạn dự án: "Chậm so với kế hoạch" dùng hình vạch chéo + đỏ, không gọi là "găng" | Nhập hai ngữ nghĩa vào một màu | Tránh nhầm "găng" và "trễ" | P25, P26 https://docs.oracle.com/cd/F74773_01/p6help/en/91597.htm |
| Asana, Monday, Procore, Fieldwire | Màu khác nhau cho hôm nay (lục, vàng), quá hạn (đỏ); đỏ cho cả hôm nay lẫn trễ ở Fieldwire | Ba dải: Trễ (đỏ), Sắp đến/hôm nay (hổ phách), Còn thời gian (lục) | Lục cho "hôm nay"; đỏ cho "hôm nay" | Hôm nay là cảnh báo nhẹ, chưa vi phạm | P6, P8, P10, P17 |

#### 2.5.1 Bảng tương phản đã tính (nhóm tự tính, WCAG, ngày 2026-11-12)

Văn bản trên nền trắng #FFFFFF, trừ khi ghi khác:

| Cặp màu (chữ trên nền) | Tỷ lệ | Đánh giá |
|---|---|---|
| Hổ phách #F59E0B trên trắng | 2,15 | Trượt cả chữ (4,5) và biểu tượng (3) |
| Hổ phách #FFB000 trên trắng | 1,83 | Trượt |
| Cam Okabe-Ito #E69F00 trên trắng | 2,25 | Trượt |
| Vàng Okabe-Ito #F0E442 trên trắng | 1,32 | Trượt nặng; chỉ dùng cho nền lớn, không dùng cho chữ |
| Cam đỏ Okabe-Ito (vermilion) #D55E00 trên trắng | 3,87 | Chỉ đạt chữ lớn hoặc biểu tượng |
| Xanh lục lam Okabe-Ito #009E73 trên trắng | 3,42 | Chỉ đạt biểu tượng; chữ thường trượt |
| Lục lam đậm #00694B trên trắng | 6,73 | Đạt |
| Hổ phách đậm #8A5A00 trên trắng | 5,93 | Đạt chữ thường |
| Chữ #7A4B00 trên nền #FFF3D6 | 6,72 | Đạt chữ thường, đề xuất cho chip "sắp đến hạn" |
| Biểu tượng/viền #B26A00 trên trắng | 4,24 | Đạt biểu tượng (≥ 3), không dùng cho chữ nhỏ |
| Biểu tượng #B26A00 trên nền #FFF3D6 | 3,84 | Đạt biểu tượng (≥ 3) |
| Chữ #9C1C14 trên nền #FDECEA | 7,09 | Đạt, đề xuất cho chip "trễ" |
| Đỏ #B3261E trên trắng | 6,54 | Đạt |
| Chữ #14633A trên nền #E4F4EA | 6,41 | Đạt, đề xuất cho chip "còn thời gian" |
| Lục #1B7F4B trên trắng | 5,02 | Đạt |
| Xanh đậm thương hiệu #0F2D3D trên trắng; chữ trắng trên #0F2D3D | 14,35 | Rất cao |
| Teal #0E7C86 trên trắng | 4,95 | Đạt sát ngưỡng |
| Teal đậm #0B6B74 trên trắng; chữ trắng trên nền #0B6B74 | 6,23 | Đạt, đề xuất làm màu nhấn/nút chính |
| Chữ phụ #44545C trên trắng | 7,87 | Đạt AAA |
| Chữ phụ #5F6B73 trên #F6F8F9 | 5,14 | Đạt |
| Tối: chữ #FFC857 trên #0F2D3D | 9,33 | Đạt |
| Tối: chữ #FFB4AB trên #4A1713 | 8,69 | Đạt |
| Tối: chữ #FFD58A trên #4A3300 | 8,58 | Đạt |
| Tối: chữ #8EE0AE trên #0F3A24 | 8,13 | Đạt |
| Đường ray tiến độ #D5DEE2 so với trắng | 1,37 | Không đạt 3:1; cần viền #78898F (3,64 trên trắng) |
| Thanh lấp teal #0B6B74 trên ray #D5DEE2 | 4,56 | Đạt |
| Thanh lấp đỏ #B3261E trên ray #D5DEE2 | 4,79 | Đạt |
| Thanh lấp lục #1B7F4B trên ray #D5DEE2 | 3,67 | Đạt (≥ 3) |

Kết luận từ bảng: hổ phách "chuẩn" (#F59E0B, #FFB000, #E69F00) không dùng được làm màu chữ trên nền trắng. Cách sửa là chữ nâu hổ phách đậm trên nền hổ phách nhạt (6,7:1) và dùng hổ phách trung bình chỉ cho biểu tượng, viền (≥ 3:1) khi luôn có chữ đi kèm. Carbon cũng nhắc chỉ báo hình cần viền với cam và vàng nhạt trên nền sáng [S27].

#### 2.5.2 Bảng màu an toàn cho mù màu

- Okabe-Ito (8 màu): cam #E69F00, lam nhạt #56B4E9, lục lam #009E73, vàng #F0E442, lam #0072B2, cam đỏ #D55E00, tím hồng #CC79A7, đen #000000 (mã hex từ [S31b][K], trang [S31][T] chỉ có hình bảng màu). Lời khuyên từ trang gốc [S31][T]: không truyền thông tin chỉ bằng màu, kết hợp hình, ký hiệu, vạch; dán nhãn trực tiếp; tránh tương phản chỉ về sắc ở cùng độ sáng (ví dụ chữ đỏ trên nền lục); dùng nét dày, ký hiệu lớn, chữ đậm; không gọi đối tượng chỉ bằng tên màu; dùng trình mô phỏng chỉ để tham khảo và nhờ người mù màu kiểm tra.
- Ba dải đề xuất không thể chỉ dựa vào Okabe-Ito vì cần ngữ nghĩa "đỏ-vàng-lục" mà người dùng đã quen. Cách an toàn: giữ đỏ/hổ phách/lục nhưng làm chúng khác nhau về độ sáng hiển thị, hình dạng và chữ. Đỏ và lục chính của đề xuất khác nhau ở chói nhưng gần nhau (đỏ #B3261E trên trắng 6,54, lục #1B7F4B 5,02), nên hình dạng và chữ là phần phân biệt thực sự. Suy luận.
- ColorBrewer: không tải được trong phiên này nên không trích dẫn (mục 5).
- Material 3: không có vai trò "warning" hay "success"; chỉ có error (tone 40 sáng, 80 tối) và tertiary là màu nhấn thứ ba tùy chọn [S13][T]. Khuyến nghị: mở rộng bộ màu bằng các vai trò ngữ nghĩa riêng (warning, success) có cặp on-/container tương tự, tính theo quy tắc tone 40 trên container tone 90 và tone 80 trên container tone 30 (chữ tối), không mượn tertiary vì tertiary là màu thương hiệu thay đổi được. Suy luận, dựa vào [S13].

### 2.6 Màn hình lãnh đạo (bảng điều khiển) và dải giai đoạn tiến độ

Điểm chính từ nguồn:

- HIG Widgets: chỉ thông tin phục vụ mục đích chính; cân bằng mật độ ("overly dense layouts are less glanceable"); chữ ≥ 11pt; không dựa vào màu; thời điểm cập nhật cuối [S25][T].
- Số chỉ số: nguồn thực hành (không phải NN/g) khuyến nghị 2 đến 3 thẻ KPI chính, 3 đến 6 chỉ số tổng, đưa phần phụ xuống màn chi tiết; một blog nói hầu hết người dùng chỉ để ý ba thẻ đầu trong hàng năm thẻ (chưa kiểm chứng, nguồn từ kết quả tìm kiếm thứ cấp) [K].
- Vòng tròn so với thanh: Kosara và Few chỉ trích đồng hồ (gauge) cho bảng điều khiển kinh doanh; Tableau nói biểu đồ "bullet" dễ đọc hơn gauge [P39][P40][K]. Một bài tổng hợp 51 nghiên cứu về đồng hồ đeo tay nói thanh nhanh và chính xác hơn vòng (chưa tìm được nghiên cứu gốc, không dùng làm bằng chứng cứng). Material: tuyến tính có ray cố định; tròn ray ẩn, đặt được trong thẻ [S15][T]; HIG: nên dùng chỉ báo xác định và chính xác [S21][T].
- Linear: đồ thị dự án có đường phạm vi, tiến độ, đường đỏ ngày mục tiêu, ước tính hoàn thành kèm khoảng lạc quan/bi quan khoảng 40% [P13][T]; trạng thái dự án hiển thị cạnh tên và biểu tượng trên thanh dự án [P14][T].
- Asana: cập nhật trạng thái On track, At risk, Off track kèm mô tả; xem dòng thời gian cập nhật trước đó trong tab Progress/Overview [P11][K].
- GOV.UK task list: danh sách bước với trạng thái đi kèm, "Cannot start yet" là chữ xám không liên kết [S29][T]. Carbon: lam là tiến độ quy trình, xám là chưa bắt đầu [S27][T].
- Procore: trạng thái công việc là chuỗi Initiated, In Progress, Ready for Review, Closed [P2][K].
- Không tìm được nguồn đáng tin về dải bước (stepper) trong Autodesk, Fieldwire, Asana timeline mobile hoặc "progress tracker" ngân hàng (xem mục 5). Các khuyến nghị dải giai đoạn dưới đây dựa trên GOV.UK, Carbon, Material và HIG.

| Hệ thống | Mẫu thiết kế đáng chú ý | Áp dụng | Loại bỏ | Lý do | Nguồn (URL) |
|---|---|---|---|---|---|
| HIG Widgets | Một ý tưởng đơn giản, mật độ cân bằng, "cập nhật lúc" | Trang chủ lãnh đạo: 3 thẻ KPI + danh sách "Cần bạn quyết định" tối đa 5 mục | 6 đến 8 thẻ số cùng cấp | Lãnh đạo mở điện thoại để quyết định, không để đọc báo cáo | S25 https://developer.apple.com/design/human-interface-guidelines/widgets |
| Material, HIG | Chỉ báo tuyến tính với ray cố định, xác định | Thanh tiến độ 8dp, ray có viền, nhãn "42,5%" bên phải | Vòng tròn cho nhiều dự án trong một danh sách | Nhiều thanh so sánh được bằng mắt; vòng chỉ hợp một chỉ số trung tâm | S15, S21 ; P39, P40 |
| Linear | Ước tính ngày hoàn thành với khoảng bất định; đường mốc đỏ | Một dòng "Dự kiến hoàn thành: 12/2026"; vạch mốc kế hoạch trên thanh | Biểu đồ nhiều đường | Điện thoại không đủ chỗ; quyết định cần con số | P13 https://linear.app/docs/project-graph |
| Asana | Trạng thái dự án On track / At risk / Off track kèm câu mô tả | Dự án có "Sức khỏe": Đúng tiến độ / Có rủi ro / Chậm tiến độ, kèm câu giải thích của người phụ trách | Chỉ có chấm màu không lời | Lãnh đạo cần lý do; màu đơn lẻ thiếu ngữ cảnh | P11 https://help.asana.com/s/article/project-progress-and-status-updates |
| GOV.UK, Carbon | Danh sách bước: Hoàn thành, Đang làm, Chưa bắt đầu, Chưa thể bắt đầu; xám cho chưa bắt đầu; lam cho tiến độ | Dải giai đoạn dự án (xem 4.4) | Dải bước nằm ngang rất dài cuộn mất bối cảnh | Một dải nhìn một lần và chạm để mở chi tiết giai đoạn | S29 https://design-system.service.gov.uk/patterns/complete-multiple-tasks/ ; S27 |
| Procore | Trạng thái công việc là chuỗi ngắn | Tab "Tiến độ" của dự án liệt kê giai đoạn và mốc theo chuỗi trạng thái | Quá nhiều trạng thái tùy biến | Ít trạng thái, hiểu nhanh | P2 |
| Smartsheet | Quả cầu Harvey (rỗng, 1/4, 1/2, 3/4, đầy) | Biểu tượng giai đoạn: rỗng (chưa), nửa (đang), tích (xong) | Quá nhiều mức lẻ | Ba trạng thái đủ cho dải giai đoạn | P23 |

### 2.7 Định dạng tiền và ngày tháng bằng tiếng Việt trên điện thoại

Kiểm chứng:

- Dấu phân cách: locale vi-VN dùng dấu phẩy `,` cho thập phân và dấu chấm `.` cho hàng nghìn; ký hiệu tiền tệ ₫, mã VND [P36][T]. Công văn 10010/CT-TTHT quy định dấu chấm sau hàng nghìn, triệu, tỷ và dấu phẩy sau hàng đơn vị trên hóa đơn (công văn một cục thuế, không phải quy định chung cho phần mềm; cho phép phần mềm kế toán dùng quy ước ngược) [P38][K].
- Ngày: dd/MM/y ngắn, ví dụ 12/11/2026; dạng ngắn trung bình là "12 thg 11, 2026" [P36][T]. Thứ tự ngày, tháng, năm; thứ T2 đến T7, CN; tuần bắt đầu từ thứ Hai; giờ 24h dạng 13:15 hoặc 13h15 [P37][T].
- Kiểm tra bằng `Intl` (Node 24, ICU 78.3, CLDR 48.0; chạy 2026-11-12):
  - Tiền tệ: `1.500.000 ₫`, `12.500.000.000 ₫`.
  - Rút gọn ngắn mặc định: 1.500.000 thành `1,5 Tr`; 1.234.567.890 thành `1,2 T`; 12.500.000.000 thành `13 T` (làm tròn thành số nguyên, mất hàng thập phân); 1.000.000.000.000 thành `1 NT`. Rút gọn dạng dài: `1,5 triệu`, `1,2 tỷ`, `13 tỷ`, `1 nghìn tỷ`.
  - Ngày tương đối `numeric: auto`: "Hôm nay", "Ngày mai", "Hôm qua", "Ngày kia", "3 ngày trước".
- Phát hiện: định dạng rút gọn mặc định của thư viện làm tròn 12,5 tỷ thành "13 T" và dùng "T" mơ hồ (tỷ hay tấn), nên cần hàm định dạng riêng theo quy tắc ở 4.5, không dùng `compact` thô.
- Tên đơn vị lớn tiếng Việt theo bản dịch i18n-js: Nghìn, Triệu, Tỷ, Nghìn tỷ [kết quả tìm kiếm tệp https://cdn.jsdelivr.net/npm/i18n-js@4.5.3/json/vi.json, K].
- Quy tắc nghiệp vụ "không viết tắt" cho số tiền bằng chữ trên chứng từ (không ghi "tr", "k", "đ") là của hóa đơn, hợp đồng, không áp dụng cho UI nhưng cho thấy văn bản pháp lý khác UI [kết quả tìm kiếm Viettel Store, K: https://viettelstore.vn/tin-tuc/doi-so-tien-thanh-chu].

| Hệ thống | Mẫu thiết kế đáng chú ý | Áp dụng | Loại bỏ | Lý do | Nguồn (URL) |
|---|---|---|---|---|---|
| CLDR vi-VN | `,` thập phân, `.` hàng nghìn, `₫`, ngày dd/MM/y | Dùng đúng hai dấu này ở mọi nơi, kể cả trường nhập | Dấu phẩy hàng nghìn kiểu Mỹ | Người dùng Việt đọc "1,5" là một phẩy năm; "1,500" gây hiểu sai nghiêm trọng | P36 http://www.localeplanet.com/icu/vi-VN/index.html |
| Hóa đơn VN | Dấu chấm sau nghìn, triệu, tỷ; phẩy sau đơn vị | Chi tiết và phê duyệt hiển thị số đầy đủ theo quy tắc này | Tự viết tắt trong chứng từ | Phù hợp thói quen kế toán công và doanh nghiệp | P38 |
| ICU compact | `1,5 Tr`, `1,2 T`, `13 T` cho 12,5 tỷ | Không dùng thô | "T" mơ hồ, mất hàng thập phân | Sai số khi duyệt tiền | Kiểm tra cục bộ ICU 78.3 |
| Wikipedia VN | dd/MM/yyyy, 24 giờ, T2..CN, tuần từ thứ Hai | Ngày hiển thị dd/MM/yyyy, giờ HH:mm, thứ viết tắt T2..CN, tuần bắt đầu thứ Hai | AM/PM, định dạng tháng/ngày kiểu Mỹ | Tiêu chuẩn Việt Nam | P37 https://en.wikipedia.org/wiki/Date_and_time_notation_in_Vietnam |
| Intl RelativeTimeFormat vi | "Hôm nay", "Ngày mai", "Hôm qua", "Ngày kia" | Dùng "Hôm nay", "Ngày mai"; thay "Hôm qua" và "3 ngày trước" bằng "Trễ 1 ngày", "Trễ 3 ngày" (gắn nghiệp vụ) | "3 ngày trước" cho hạn chót | "Trước" mơ hồ: đã xảy ra hay đã quá hạn; "Trễ" nói đúng nghiệp vụ | Kiểm tra cục bộ |
| VCB, MoMo | Không kiểm chứng được màn hình cụ thể | Không suy diễn | Không trích dẫn | Xem mục 5 | X |

---

## 3. Nguyên tắc thiết kế rút ra

Mỗi nguyên tắc có nhãn nguồn (mã ở mục 1.2) và nhãn Suy luận nếu không có nguồn nói thẳng.

1. **Một tab, một câu hỏi.** Năm tab là mức tối đa (3 đến 5, ngang hàng), luôn hiện nhãn đủ chữ ngắn, luôn hiển thị khi điều hướng, không dùng tab cho hành động, không ẩn tab rỗng mà giải thích vì sao rỗng. [S7][S9][S17][S32][S34]
2. **Badge chỉ cho điều cần hành động.** Số trên "Phê duyệt" (số hồ sơ chờ bạn); "Thông báo" chỉ chấm; không đặt badge ở tab khác. Số vượt 99 hiển thị "99+". [S17][S9][S27]
3. **Màn hình trả lời đúng một câu hỏi.** Trang chủ lãnh đạo: "Tôi cần quyết định gì bây giờ?". "Việc hôm nay": "Hôm nay tôi phải làm gì và cái gì đã trễ?". Dự án: "Dự án này có ổn không và đang ở đâu?". [S25][P8][P20][S1]
4. **Ba dải hạn cố định, tính ở máy chủ.** Cùng quy tắc ở mọi thiết bị và hai phiên bản; máy khách không tự tính để tránh lệch múi giờ. Hạn tính theo ngày lịch UTC+7. [P16][P17][P18][P8]
5. **Màu không bao giờ đi một mình.** Mọi trạng thái có ít nhất ba trong bốn yếu tố: biểu tượng, hình riêng, màu, chữ. Quá hạn thêm chữ đậm. [S3][S18][S20][S27][S30][P9]
6. **Tương phản có mục tiêu đo được.** Chữ ≥ 4,5:1 (mục tiêu thực tế ≥ 6:1 cho chip), biểu tượng/viền/đường ray ≥ 3:1, kiểm tra cả sáng và tối, có phương án tăng tương phản. [S4][S5][S18][S13]
7. **Hổ phách chỉ là biểu tượng và viền; chữ là nâu đậm trên nền hổ phách nhạt.** [S27] (viền cho cam/vàng nhạt) cùng bảng tính 2.5.1.
8. **Vùng chạm 48dp, cách 8dp; thẻ nguyên khối là một vùng chạm.** Không đặt hai nút nhỏ cạnh nhau trong thẻ. [S8][S10][S18][S2]
9. **Chữ phóng đến 200% không mất chức năng.** Bố cục co giãn, chip và tiêu đề được xuống dòng, không cố định chiều cao thẻ; nội dung cắt bớt phải mở được ở chi tiết. Dòng cách ≥ 1,4 cho chữ tiếng Việt. [S6][S18][S19][P42]
10. **Thẻ chứa đủ dữ kiện để quyết định, không hơn.** Thẻ việc: hạn, tên, dự án, người, tiến độ hồ sơ. Thẻ phê duyệt: loại, số tiền đầy đủ, người trình, hạn xử lý, bước trong chuỗi, số hồ sơ đính kèm. [S25][S24][P27][P30][P31][S1]
11. **Thanh hành động dính, hành động cụ thể, ba lựa chọn.** Phê duyệt, Trả lại, Từ chối; nút ghi động từ cụ thể; hành động chính ở đáy trong tầm ngón cái. [P30][S23][S33]
12. **Bảng đáy cho xác nhận, không hộp thoại giữa màn hình.** Nêu cụ thể cái sắp xảy ra (số tiền, hồ sơ, bước); lý do bắt buộc cho từ chối và trả lại; chỉ một sheet tại một thời điểm. [S12][S22][S33][P27][S16]
13. **Xác nhận chỉ cho hậu quả nghiêm trọng; còn lại cho hoàn tác.** Phê duyệt tiền và từ chối cần xác nhận; "đã đọc", chuyển nhóm cho hoàn tác. [S33][S23][S1]
14. **Vết kiểm toán nhìn thấy được.** Mỗi hồ sơ có dòng thời gian: người, vai trò, hành động, thời điểm dd/MM/yyyy HH:mm, ghi chú; ủy quyền hiển thị "A thay mặt B"; có ghi nhận đã xem hồ sơ. [P29][P31][P30]
15. **Vuốt chỉ là đường tắt, không là con đường duy nhất.** Mọi vuốt có nút tương đương; chỉ cho việc hoàn tác được; không vuốt để duyệt tiền. [P43][P12]. Suy luận: quy tắc cụ thể (chỉ cho việc hoàn tác được, không vuốt để duyệt tiền); trang HIG Lists and tables không nói về swipe nên không dùng làm căn cứ.
16. **Ngoại tuyến là trạng thái bình thường.** Đọc từ dữ liệu cục bộ ngay, ghi lười cho dữ liệu hiện trường, ghi trực tuyến bắt buộc cho phê duyệt; nhãn "Chờ đồng bộ", hàng chờ có số đếm, lỗi có "Thử lại", dòng "Cập nhật lúc". [S35][P4][P5][P41][S25]
17. **Tiền: chọn đơn vị theo độ lớn, không bao giờ hiển thị phần nhỏ hơn một đơn vị.** Số đầy đủ ở chi tiết và phê duyệt; một đơn vị cho mọi số trong cùng so sánh. [P36][P38] và kiểm tra ICU cục bộ.
18. **Ngày tháng viết theo thói quen Việt, tương đối khi gần, tuyệt đối khi xa.** Hôm nay, Ngày mai, Còn N ngày, Trễ N ngày; sau 30 ngày hiện dd/MM/yyyy; luôn có ngày tuyệt đối ở chi tiết. [P36][P37]
19. **Thanh trước vòng, số bên cạnh.** Thanh tuyến tính có ray nhìn thấy và nhãn phần trăm; vòng tròn chỉ cho một chỉ số trung tâm; tiến độ vs kế hoạch dùng thanh có vạch mốc. [S15][S21][S26][P39][P40]
20. **Trạng thái rỗng giải thích, có lối đi, không trách.** Mọi danh sách rỗng có tiêu đề, một câu lý do và một hành động nếu có; trạng thái rỗng tích cực ("Không có hồ sơ chờ bạn") dùng tông chúc mừng nhẹ. [S17][P44][P45]

---

## 4. Đặc tả khuyến nghị

Đơn vị: dp cho kích thước, sp cho chữ. Phông chữ: Be Vietnam Pro. Mọi chữ dùng sp để phóng theo cài đặt hệ thống đến 200% (hoặc hơn) mà không cắt chức năng [S6][S19].

### 4.1 Nền tảng chung

Màu (sáng), tính tương phản ở 2.5.1:

| Vai trò | Mã | Dùng |
|---|---|---|
| Header teal đậm | #0F2D3D | Thanh app bar, chữ trắng trên đó 14,35:1 |
| Chữ phụ trên header | #B8CBD2 | 8,55:1 trên header |
| Nhấn chính (nút, liên kết, thanh tiến độ) | #0B6B74 | 6,23:1 với trắng |
| Nền màn hình | #F6F8F9 | |
| Bề mặt thẻ | #FFFFFF | |
| Chữ chính | #0F2D3D | 13,47:1 trên #F6F8F9 |
| Chữ phụ | #44545C | 7,39:1 trên #F6F8F9 |
| Viền thẻ (trang trí, thẻ đã là chữ) | #C9D3D8, 1dp | không cần 3:1 vì thẻ không thay thế chữ; viền điều khiển nhập liệu dùng #78898F (3,64:1) |

Chủ đề tối: nền #0F2D3D/#122C38, thẻ #16394A, chữ #E6EEF1 (10,40:1 trên thẻ), chữ phụ #A9BDC6 (6,27:1). Phải kiểm tra cả hai chủ đề [S18][S13].

Chữ (Be Vietnam Pro, dòng cách theo tỷ lệ ≥ 1,45 cho chữ thân vì dấu xếp chồng cần chỗ [P42]; tỷ lệ là suy luận, bài TypeDrawers chỉ nói cần giãn dòng, không đưa con số):

| Vai trò | sp / dòng | Đậm | Dùng |
|---|---|---|---|
| headline | 24 / 32 | 600 | Tên màn trên header lớn |
| title-large | 20 / 28 | 600 | Số tiền nổi bật, tiêu đề mục |
| title-medium | 16 / 24 | 600 | Tiêu đề thẻ |
| body | 14 / 22 | 400 | Nội dung |
| label-large | 14 / 20 | 600 | Nút |
| label | 12 / 18 | 600 | Chip, nhãn nhỏ; không nhỏ hơn 12sp (HIG: tối thiểu 11pt) [S19] |

Khoảng cách: lề màn hình 16dp; khoảng giữa thẻ 8dp; padding thẻ 16dp ngang, 12dp dọc; bán kính thẻ 12dp. Thanh điều hướng đáy: 5 mục, mỗi mục ≥ 48dp, nhãn luôn hiện, badge số ở "Phê duyệt", chấm ở "Thông báo" [S9][S17].

App bar: Trang chủ dùng "medium flexible" thu nhỏ khi cuộn (lời chào, ngày); các tab còn lại dùng small [S14]. Thẻ: outlined cho thẻ việc/hồ sơ (lặp nhiều), filled (tonal) cho ô KPI, elevated chỉ cho phần nổi như bottom sheet [S11].

### 4.2 Mẫu thẻ việc

```
+--------------------------------------------------------+
| [ ! Trễ 3 ngày ]                       Đang thực hiện   |  hàng 1: chip hạn + trạng thái (chữ xám, không chip)
| Hoàn thiện hồ sơ nghiệm thu hạng mục móng M2            |  tiêu đề, tối đa 2 dòng
| DA Nhà máy xử lý nước thải KCN A  ·  Mã DA-2026-014     |  dự án, 1 dòng, cắt giữa nếu dài
| (avatar) Nguyễn Văn An     Hạn 09/11/2026      2/3 hồ sơ|  hàng meta
| [======----] 60%                                        |  thanh tiến độ (nếu có)
+--------------------------------------------------------+
```

Đặc tả:

- Container: outlined, bán kính 12dp, nền trắng, viền 1dp #C9D3D8; cả thẻ là một vùng chạm, chiều cao tối thiểu 96dp ở cỡ chữ 100%, không có chiều cao tối đa. Ở cỡ chữ ≥ 150% tiêu đề cho phép 3 dòng và các phần tử ở hàng meta xuống dòng.
- Hàng 1: chip hạn bên trái (xem 4.4), trạng thái quy trình bên phải bằng chữ label 12sp màu chữ phụ kèm biểu tượng nhỏ 16dp (Chưa bắt đầu, Đang thực hiện, Chờ duyệt, Đã xong). Việc "Chờ duyệt" không hiện chip trễ [P2][P3].
- Hàng 2: tiêu đề title-medium 16/24, tối đa 2 dòng.
- Hàng 3: dự án body 13 hoặc 14sp màu chữ phụ, 1 dòng, cắt giữa khi dài (HIG: dấu chấm lửng giữa giúp phân biệt) [S24]. Mã dự án sau dấu chấm giữa.
- Hàng 4: avatar 24dp + tên (label 12sp, 1 dòng); hạn dạng "Hạn 09/11/2026"; số hồ sơ bắt buộc "2/3 hồ sơ" với biểu tượng kẹp giấy. Cả ba phần tử là chữ thông tin, không nút.
- Hàng 5 (tuỳ chọn): thanh tiến độ 8dp, ray có viền #78898F, nhãn % 12sp bên phải [S15].
- Ưu tiên: biểu tượng cờ nhỏ chỉ khi cao hoặc khẩn, không dùng màu cho ưu tiên để tránh trùng với dải hạn. Trục ưu tiên độc lập với trục hạn [P6].
- Hành động nhanh: không đặt nút trong thẻ; mở chi tiết thì có "Hoàn thành" và "Xin gia hạn". Vuốt trái tùy chọn: "Xin gia hạn", vuốt phải: "Đánh dấu đã xem"; chỉ là đường tắt, có nút tương đương, hoàn tác được [P43][P12].
- Nhóm và tiêu đề dính: Mới giao (nếu có) / Trễ hạn / Hôm nay / 7 ngày tới (theo từng ngày, nhãn "T2 10/11") / Sau đó / Chưa đặt hạn; tiêu đề nhóm có số đếm kể cả khi gập; nhóm Trễ hạn và Hôm nay luôn mở [P8][P20][P22].
- Trạng thái: nhấn giữ có nhấn chìm (state layer) đủ rõ; trạng thái đã đọc/chưa: chấm teal 8dp bên trái tiêu đề cho "Mới giao".
- Trạng thái rỗng "Việc hôm nay": biểu tượng nhỏ, tiêu đề "Hôm nay không có việc đến hạn", dòng phụ "Xem việc 7 ngày tới", nút liên kết. Không chê trách [S17][P44][P45].
- Ngoại tuyến: nhãn nhỏ "Chờ đồng bộ" (biểu tượng đồng hồ-mũi tên) cạnh hàng 1 khi có thay đổi chưa gửi; không thay đổi bố cục thẻ [P41][S35].
- Hoàn thành việc có hồ sơ bắt buộc: nút "Hoàn thành" luôn bấm được; nếu thiếu thì hiện bảng báo "Còn thiếu 1 hồ sơ: Biên bản nghiệm thu" và nút "Thêm hồ sơ" (cuộn tới mục thiếu) [P32][P33][P34].

### 4.3 Mẫu thẻ phê duyệt

```
+--------------------------------------------------------+
| Phê duyệt vốn           [ ! Hạn xử lý: Còn 2 ngày ]     |  loại hồ sơ + chip hạn
| Điều chỉnh kế hoạch vốn năm 2026 - DA Nhà máy A         |  title-medium, 2 dòng
| 12,5 tỷ đồng                                            |  title-large 20/28 w700, số tabular
| 12.500.000.000 ₫  ·  chiếm 18,2% kế hoạch vốn năm       |  label 12sp
| Trình bởi: Trần Thị B (Phòng Kế hoạch)  ·  10/11/2026   |  người trình, ngày
| Bước 3/4: Bạn  ->  Giám đốc          5 hồ sơ, chưa xem 2 |  vị trí trong chuỗi, hồ sơ
+--------------------------------------------------------+
```

Dữ kiện bắt buộc để quyết định (suy luận từ cấu trúc ServiceNow, Workday, SAP, Concur): loại hồ sơ/quy trình; tên và mã; số tiền đầy đủ và ngữ cảnh (tỷ lệ trên kế hoạch hoặc dự toán nếu có); người trình và đơn vị; ngày trình; hạn xử lý (dải hạn); vị trí của bạn trong chuỗi; số tài liệu và số chưa xem; ghi chú của các bước trước ở chi tiết [P27][P30][P31][P29].

Luồng:

1. Danh sách: tab "Phê duyệt" có bộ lọc chip "Chờ tôi / Đã xử lý / Tất cả", sắp xếp theo hạn xử lý gần nhất trước, nhóm "Trễ hạn xử lý" trước. Không có nút duyệt trên thẻ danh sách, chỉ mở chi tiết (tiền không duyệt bằng vuốt) [P43][S33].
2. Chi tiết: thông tin tóm tắt đầu trang, tab hoặc mục "Hồ sơ", "Lịch sử", "Ghi chú". Thanh hành động dính ở đáy.
3. Thanh hành động dính: cao 72dp (nút 52dp, khoảng đệm 10dp, lề ngang 16dp, vùng an toàn dưới cùng), đường kẻ 1dp phía trên, luôn thấy khi cuộn. Bố cục: [Từ chối] (outlined, chữ và biểu tượng đỏ #B3261E, rộng 1x), [Trả lại] (outlined, teal, 1x), [Phê duyệt] (filled teal #0B6B74, chữ trắng 6,23:1, 2x). Ba nút trên điện thoại hẹp: hai nút phụ gộp vào hàng trên hoặc menu "Khác" khi cỡ chữ ≥ 150%, nút Phê duyệt luôn ở dưới cùng [S8][P30].
4. Chạm "Phê duyệt" mở bottom sheet modal [S12][S22]:
   - Thanh kéo (vùng ≥ 48dp) và nút "Huỷ".
   - Tiêu đề "Xác nhận phê duyệt".
   - Bốn dòng: Hồ sơ (tên + mã), Số tiền (đầy đủ, `12.500.000.000 ₫`), Bước (3/4), Người trình.
   - Ô ghi chú (tùy chọn khi duyệt; bắt buộc khi Trả lại/Từ chối, tối thiểu 10 ký tự, hiện lỗi ngay dưới ô) [P27][P34].
   - Nút chính "Phê duyệt 12,5 tỷ đồng" (động từ cụ thể, không phải "Đồng ý") [S23][S33]; nút phụ "Huỷ". Không hiện hộp thoại thứ hai. Nếu có tùy chọn sinh trắc/PIN theo ngưỡng thì yêu cầu ngay sau nút chính [P35].
5. Sau khi duyệt: bảng đóng, hiện snackbar "Đã phê duyệt" và nút "Hồ sơ tiếp theo" (theo Workday) [P30]. Nếu phía máy chủ cho thu hồi trong thời hạn ngắn thì có nút "Hoàn tác" (quyết định nghiệp vụ, cần xác nhận với đội backend; xem mục 5); nếu không thì không hứa hoàn tác [S33].
6. Ngoại tuyến: ba nút hiển thị nhưng "Phê duyệt" vô hiệu kèm dòng lý do "Cần có mạng để phê duyệt" ngay trên thanh; không xếp hàng phê duyệt [S35].
7. Lịch sử (dấu vết kiểm toán): dòng thời gian dọc, mỗi mục: biểu tượng hành động + người + vai trò + hành động + dd/MM/yyyy HH:mm + ghi chú; ủy quyền hiện "A thay mặt B"; mục "Đã xem hồ sơ" có người và thời điểm; mục chưa tới lượt là chữ xám "Chờ" [P29][P31][S29].

### 4.4 Dải hạn ba màu

Tính ở máy chủ, trả về `band`, `daysDelta` và nhãn gợi ý; máy khách chỉ hiển thị. Hạn tính theo ngày lịch UTC+7 (Asia/Ho_Chi_Minh); đếm theo ngày lịch (Hôm nay = 0). Quy tắc ngưỡng cấu hình theo quy trình (mặc định: "sắp đến hạn" khi còn ≤ 3 ngày lịch; Procore tính hạn theo ngày làm việc của dự án, nên cho phép cấu hình ngày làm việc ở bản doanh nghiệp [P3]). Chỉ tính cho trạng thái đang mở; việc "Chờ duyệt" hoặc "Đã xong" không có dải trễ [P2][P3].

| Dải | Điều kiện | Chữ (ví dụ) | Biểu tượng (hình viền khác nhau) | Nền chip | Màu chữ | Viền, biểu tượng | Độ đậm |
|---|---|---|---|---|---|---|---|
| Trễ | `daysDelta < 0` | "Trễ 3 ngày" (1 ngày: "Trễ 1 ngày") | Hình bát giác đặc có dấu chấm than ("dừng") | #FDECEA | #9C1C14 (7,09:1 trên nền) | #B3261E (6,54:1 trên trắng) | 700 |
| Sắp đến hạn | `0 <= daysDelta <= 3` | "Hôm nay", "Ngày mai", "Còn 2 ngày", "Còn 3 ngày" | Hình tam giác viền có dấu chấm than (đồng hồ cho "Hôm nay" nếu cần phân biệt) | #FFF3D6 | #7A4B00 (6,72:1 trên nền) | #B26A00 (3,84:1 trên nền, 4,24:1 trên trắng) | 600 ("Hôm nay": 700) |
| Còn thời gian | `daysDelta > 3` | "Còn 12 ngày"; sau 30 ngày: "15/12/2026" | Hình tròn viền có dấu tích | #E4F4EA | #14633A (6,41:1 trên nền) | #1B7F4B (5,02:1 trên trắng) | 500 |
| Đã xong | trạng thái hoàn thành | "Đã xong" | Hình tròn đặc có dấu tích, chữ xám đậm #44545C, không nền | không | #44545C | #44545C | 500 |
| Chưa đặt hạn | không có hạn | "Chưa đặt hạn" | Gạch ngang | không | #44545C | #44545C | 400 |

Hình dạng: bát giác (trễ), tam giác (sắp đến hạn), tròn (còn thời gian) có đường viền ngoài khác hẳn nhau, nên ba dải phân biệt được khi chuyển ảnh xám. Hình lục giác/bát giác mang nghĩa "dừng" và tam giác mang nghĩa "cảnh báo" trong ngữ cảnh Carbon nêu [S27]. Biểu tượng 16dp bên trong chip cao 28dp; viền chip 1dp màu viền/biểu tượng; bán kính chip 6dp (không phải viên thuốc, để không lẫn với chip lọc và nút) [S28].

Mục tiêu tương phản bắt buộc: chữ trong chip ≥ 4,5:1 với nền chip (thực tế 6,4 đến 7,1); biểu tượng và viền ≥ 3:1 với nền liền kề (thực tế 3,84 đến 6,54); kiểm lại ở chủ đề tối bằng các cặp ở 2.5.1 (≥ 8:1); không bao giờ dùng hổ phách #F59E0B, #FFB000, #E69F00 làm chữ trên trắng (2,15 đến 1,83) [S4][S5].

Chế độ mù màu và phụ trợ: bỏ màu đi thì ba dải vẫn còn hình khác nhau và chữ khác nhau; quá hạn thêm chữ đậm 700 [P9]; đọc màn hình nhận "Trễ 3 ngày, hạn 09/11/2026". Trên thanh tiến độ và dòng thời gian, đoạn "chậm so với kế hoạch" dùng nền đỏ có vạch chéo thay cho đỏ trơn để không chỉ dựa màu [S3][S31].

Tổng hợp trạng thái nhiều mục (thẻ dự án): lấy dải xấu nhất trong các mục con (Trễ > Sắp đến hạn > Còn thời gian) và hiện số lượng, ví dụ "2 việc trễ" [S27][P23].

### 4.5 Quy tắc định dạng tiền

Hàm định dạng riêng, không dùng `compact` thô (mục 2.7). Đầu vào là số đồng nguyên (hoặc thập phân cố định), `abs(v)` là trị tuyệt đối:

| Khoảng | Đơn vị hiển thị | Số thập phân tối đa | Ví dụ |
|---|---|---|---|
| `abs(v) < 1.000.000` | đồng, số đầy đủ | 0 | `850.000 ₫`, `1.000 ₫` |
| `1.000.000 <= abs(v) < 1.000.000.000` | triệu đồng | 1 (bỏ số 0 thừa) | 12.345.678 thành `12,3 triệu đồng`; 250.000.000 thành `250 triệu đồng` |
| `abs(v) >= 1.000.000.000` | tỷ đồng | 2 (bỏ số 0 thừa) | 1.234.567.890 thành `1,23 tỷ đồng`; 12.500.000.000 thành `12,5 tỷ đồng` |
| `abs(v) >= 1.000.000.000.000` | tỷ đồng với dấu chấm nghìn | 1 | `1.234,5 tỷ đồng` |

Quy tắc:

- Không bao giờ hiển thị giá trị nhỏ hơn 1 của đơn vị đã chọn. "0,001 triệu đồng" là sai vì 0,001 triệu đồng chính là 1.000 đồng; giá trị dưới một triệu hiển thị bằng đồng với dấu chấm nghìn (`1.000 ₫`). Cơ chế chọn "đơn vị lớn nhất mà phần nguyên ≥ 1" bảo đảm điều này.
- Dấu: `.` hàng nghìn, `,` thập phân [P36][P38]. Dấu âm đứng trước (`-1,2 tỷ đồng`); số âm trong bảng đỏ không dùng màu một mình, có dấu trừ. Phần trăm `42,5%`, không có dấu cách trước `%`.
- Làm tròn: nửa lên (half-up); số rút gọn chỉ dùng tóm tắt (ô KPI, thẻ danh sách, thanh tiến độ). Màn chi tiết, thẻ phê duyệt và bảng xác nhận hiển thị số đầy đủ `12.500.000.000 ₫` kèm bản rút gọn.
- Cùng một so sánh (kế hoạch và đã giải ngân, vốn và dự toán) dùng chung một đơn vị: đơn vị của số lớn hơn, ví dụ "Kế hoạch 12,5 tỷ đồng · Đã giải ngân 3,2 tỷ đồng", không lẫn "12,5 tỷ" với "3.200 triệu".
- Từ: dùng "nghìn" (không dùng "ngàn"), "triệu", "tỷ"; trong ô rất hẹp cho phép "tỷ ₫" hoặc "Tr ₫" nhưng không dùng "T" một mình (mơ hồ với tấn) [P36]. Cần kiểm tra Be Vietnam Pro có glyph ₫ và chữ số tabular hay không (mục 5).
- Số trong cột so sánh dùng chữ số tabular (nếu phông hỗ trợ) và căn lề phải.
- Trường nhập: nhập `.` làm hàng nghìn tự chèn, `,` thập phân; không để người dùng nhập "1,500" mà hiểu thành một triệu rưỡi.

### 4.6 Quy tắc ngày tháng

- Ngày tuyệt đối: dd/MM/yyyy (ví dụ 12/11/2026), giờ 24 giờ HH:mm (13:15) [P36][P37]. Viết tắt thứ: T2..T7, CN; tuần bắt đầu thứ Hai [P37].
- Tương đối (chỉ cho hạn trong tương lai gần và quá khứ gần): Hôm nay, Ngày mai, Còn N ngày (N ≤ 30), Trễ N ngày. Từ 31 ngày trở lên hiện dd/MM/yyyy. Hạn trong quá khứ luôn là "Trễ N ngày", không dùng "N ngày trước" cho hạn chót; "N ngày trước" chỉ dùng cho sự kiện đã xảy ra (đã nộp, đã duyệt) [P36].
- Nhóm 7 ngày tới trong "Việc hôm nay": nhãn "T2 10/11", mỗi ngày một dòng tiêu đề nhóm [P20].
- Múi giờ cố định Asia/Ho_Chi_Minh; so sánh theo ngày lịch ở phía máy chủ [P16].
- Thời điểm cập nhật cuối: "Cập nhật 09:41" (hôm nay) hoặc "Cập nhật 11/11 17:20" [S25][P41].

### 4.7 Trạng thái ngoại tuyến và rỗng

| Trạng thái | Hiển thị | Nguồn |
|---|---|---|
| Trực tuyến | Không có chỉ báo | [P41] |
| Mạng chậm | Chấm nhỏ cạnh dòng "Cập nhật lúc" | [P41] |
| Ngoại tuyến | Dải mỏng đầu màn "Đang ngoại tuyến · dữ liệu lúc 09:41"; vẫn hiện dữ liệu cục bộ; nút cần mạng vô hiệu kèm lý do | [S35][P41] |
| Chờ đồng bộ | Nhãn "Chờ đồng bộ" ở mục; số đếm ở Cá nhân > Hàng chờ gửi | [P4][P41] |
| Đang đồng bộ | Chỉ báo nhỏ xác định nếu biết tổng (ví dụ 2/5) | [S21][P41] |
| Lỗi đồng bộ | Nhãn đỏ có biểu tượng "Lỗi đồng bộ" + nút "Thử lại" + lý do; không bỏ dữ liệu | [P5 (cảnh báo giai thoại)][S1] |
| Làm mới thất bại | Giữ dữ liệu cũ, giữ nhãn cũ, thông báo không chặn | [P41] |
| Rỗng | Tiêu đề + một câu lý do + một hành động nếu có | [S17][P44][P45] |

Gói ngoại tuyến cho cán bộ hiện trường: màn chọn dự án và phạm vi (hồ sơ đang mở, ảnh N ngày gần nhất) kèm dung lượng ước tính; đồng bộ tự động khi có mạng và có nút "Đồng bộ ngay" [P5][S35].

---

## 5. Điều chưa kiểm chứng được

Các điểm sau không tải được hoặc không có nguồn đáng tin; không suy diễn nội dung.

1. **Trang Material Design 3 chính thức (m3.material.io)** trả về chỉ tiêu đề (WebFetch trả lời rỗng cho https://m3.material.io/components/navigation-bar/guidelines). Do đó chưa kiểm chứng: chiều cao chính xác của navigation bar, quy cách kích thước badge, hướng dẫn trạng thái rỗng của M3, hướng dẫn tỷ lệ chữ thích ứng, trạng thái lớp (state layers) bằng số. Đã thay bằng tài liệu Material Components Android và developer.android.com ([T]). Không tìm thấy trang M3 mới về empty state, chỉ có Material 1 và 2.
2. **Apple HIG** tải được qua dữ liệu JSON của trang (đọc đủ). Trang HIG gốc dạng HTML trả về chỉ tiêu đề. Trang "Lists and tables" không nói về swipe action; không tìm được trang HIG riêng cho swipe action.
3. **Tài liệu Fieldwire, Procore (Add a Task, Daily Log), Asana forum, Jira, monday.com, ClickUp, Todoist, Things, Smartsheet community, Microsoft Project, Primavera P6, SAP, Concur, Workday** được định vị qua kết quả tìm kiếm; chưa đọc trang gốc (mức K). Trang monday.com Deadline Mode trả về 403. Trang Concur Learning (người duyệt trên Android) trả về 404. Quick Reference Workday của Maryland trả về 403.
4. **Jira mobile**: không tìm được tài liệu chính thức về cách hiển thị việc quá hạn, hộp thư phê duyệt hay thẻ công việc trên di động. Chỉ có lỗi lệch ngày và câu hỏi cộng đồng. Không kết luận về giao diện Jira mobile.
5. **Linear mobile**: không có tài liệu về thao tác vuốt, ngoại tuyến ngoài mô tả trên trang sản phẩm; Linear Project status trang tải được không nói On track/At risk/Off track.
6. **Asana mobile màu ngày hạn**: chỉ có bài diễn đàn người dùng, không phải tài liệu Asana; Asana My Tasks help center tải về chỉ có menu. Chưa xác nhận hành vi hiện tại của app di động.
7. **Todoist, Things 3**: không tìm được trang chính thức mô tả hiển thị việc quá hạn.
8. **Smartsheet RAG help** trả về 404 ở một đường dẫn; trang "Available symbols" tải được nhưng không mô tả hình dạng ký hiệu.
9. **Ngân hàng Việt Nam (VCB Digibank, MoMo)**: không tìm được và không tải được tài liệu mô tả màn hình xác nhận, định dạng số dư hay quy ước "tỷ/triệu". Trang developers.momo.vn (nguyên tắc UX) trả về 403. Bài báo Lao Động về bản "chữ to, số rõ" của VCB Digibank không tải được nội dung (chỉ có tiêu đề). Chưa có bằng chứng đã kiểm chứng về cách các ứng dụng tài chính Việt hiển thị đơn vị lớn; quy tắc chọn đơn vị ở 4.5 là suy luận của nhóm dựa trên locale, hóa đơn và tính đúng toán học.
10. **Bộ nguyên tắc thiết kế bảng điều khiển dành cho di động từ NN/g**: tìm không ra bài có con số thẻ KPI tối đa. Số "2 đến 3 thẻ KPI, 3 đến 6 chỉ số" đến từ blog thực hành thứ cấp, không phải nghiên cứu. Thống kê "73% tăng áp dụng" trong một nguồn bị bỏ vì không xác minh được.
11. **Vòng tròn so với thanh**: không tìm được nghiên cứu gốc (bản tổng hợp 51 nghiên cứu về đồng hồ đeo tay được báo qua một bài báo, không tải được nghiên cứu). Chỉ trích gauge của Few/Kosara đọc qua đoạn tóm tắt tìm kiếm (mức K), chưa đọc trang gốc.
12. **Dải bước (stepper) và "progress tracker" của Autodesk, Fieldwire, Asana timeline mobile, ngân hàng**: không tìm được tài liệu có thể trích. Dải giai đoạn ở 4.4 và mục 2.6 chỉ dựa GOV.UK, Carbon, Material, HIG.
13. **ColorBrewer, bảng màu trạng thái chính thức IBM Carbon (mã hex)**: chưa tải. Mã hex Okabe-Ito lấy từ tài liệu gói R `see` qua kết quả tìm kiếm (mức K), trang gốc JFly chỉ có hình.
14. **Phông Be Vietnam Pro**: chưa kiểm chứng số liệu chiều cao dòng, hỗ trợ glyph ₫, chữ số tabular. Tỷ lệ dòng ≥ 1,45 là suy luận; nguồn TypeDrawers chỉ nói dấu xếp chồng cần giãn dòng.
15. **Thang đo dải hạn "≤ 3 ngày lịch"** và các cỡ dp cụ thể (28dp chip, 72dp thanh hành động, 96dp thẻ) là đề xuất của nhóm, cần kiểm tra thực tế trên máy thật với cỡ chữ 100%, 150%, 200%; không có nguồn nói thẳng.
16. **Hoàn tác phê duyệt**: cần quyết định nghiệp vụ và khả năng backend (có thu hồi không, trong bao lâu). Tài liệu này chỉ nêu điều kiện (4.3 bước 5).
17. **Luật và quy định Việt Nam về trình bày số tiền trên ứng dụng của cơ quan nhà nước**: chỉ có công văn hóa đơn 2013 (K) và tiêu chuẩn TCVN 7561:2005 xuất hiện trong kết quả (không đọc được nội dung). Nếu phiên bản khu vực công cần tuân thủ quy định cụ thể, cần đối chiếu văn bản hiện hành.
