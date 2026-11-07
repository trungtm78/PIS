# Hệ Thống Lý Dự Án Đầu Tư Công thiết kế trải nghiệm và hệ thống giao diện
(Cập nhật 1.4 — CR-06-01) Baseline 1.4 | 22/10/2026 | Hướng thiết kế: phòng điều hành dòng vốn, tập trung ngữ cảnh và hành động. Đây là hợp đồng UI/UX ràng buộc cho web (React) và ứng dụng Flutter.

(Cập nhật 1.4 — CR-06-02) Hiệu lực ràng buộc (D-B11, người dùng chốt 22/10/2026). Mockup là chuẩn bắt buộc: `02_Prototype` (shell, workspace-navigation, 7 trạng thái), `04_Design_Assets/design_tokens.json` (Ruby / Porcelain), các component family của tài liệu này. Được thêm field vào màn hình đã có (ghi rõ FR nguồn). Màn hình mới phải dùng đúng style, theme, component và layout của mockup, theo quy trình ở mục "Quy trình thêm màn hình và field mới". Màn hình mới được vẽ vào prototype (R10) và chỉ trở thành chuẩn visual-regression sau khi PO duyệt baseline hình ảnh. Đoạn baseline 1.3 bị sửa hoặc bỏ được chép nguyên văn ở phụ lục cuối tài liệu.

(Cập nhật 1.4 — CR-06-13) Đổi hướng màu: D-B11 giữ nguyên hiệu lực ràng buộc nhưng bảng màu mặc định chuyển từ Ruby / Porcelain sang **Xanh dầu điều hành** theo quyết định của người dùng ngày 07/11/2026 (nền thiết kế `MACHVON_Design_v1` cộng các mẫu quản trị của hệ thống đang chạy ở Cao Bằng). Nội dung đổi: menu trái xanh dầu `#102E3B`, thẻ không gian làm việc `#1C3B48`, mục đang chọn `#1C4A52` với vạch `#2FB5A8`, nút chính mòng két `#007D77`, đầu bảng `#173D48` chữ trắng, nền `#F3F6F5`; phông Be Vietnam Pro tự đóng gói; bo góc viên 999. Màu vàng `#E0AA52` chỉ còn là màu nguồn vốn kéo dài; đường kế hoạch dùng `chartPlan` nét đứt kèm nhãn; hổ phách `#9A5B00` chỉ dành cho cảnh báo. Thêm token `focusOnDark` `#7FE0D6` cho viền focus trên nền tối. Hàng chip điều hướng của prototype v1 không được đưa lại (đã cấm ở mục Kiến trúc thông tin). Bổ sung thành phần quản trị dùng chung (khối điều hành, thanh ngữ cảnh số liệu, thẻ chỉ số, bảng hai tầng có hàng tổng, hàng đợi "Cần xử lý ngay", chuông cảnh báo, chip trạng thái, thanh nút dính đáy, dòng dấu vết) và quy tắc thứ bậc: việc cần xử lý đứng trước số liệu trên màn điều hành. Chi tiết ở `design.md` ở gốc repo. Ảnh chuẩn 478 màn phải xuất lại và được PO duyệt (`docs/r10-baseline-approvals.md`).

## Nguyên tắc trải nghiệm
Mỗi màn hình trả lời ba câu: đang xem phạm vi nào, điều gì cần chú ý, hành động tiếp theo là gì. Không đặt một bộ KPI giống nhau lên mọi phân hệ. Điều hành thể hiện xu hướng và việc ưu tiên; báo cáo dùng từng bước kiểm tra; chuyên gia nhà thầu dùng bàn làm việc tài liệu/nhận xét; tương tác dùng inbox; BI dùng canvas; master data dùng cây hiệu lực và impact review.

Thiết kế tách rõ lớp ứng dụng cho người dùng nghiệp vụ và Design Studio để duyệt toàn bộ catalogue. Thanh chọn màn hình/trạng thái của prototype không phải thành phần production. Prototype có dữ liệu minh họa và tương tác mô phỏng; những nút chưa có backend hiển thị thông điệp mô phỏng rõ ràng. Không dùng thông báo thành công giả cho hành động gửi ra ngoài.

## Kiến trúc thông tin
Web có thanh điều hướng theo vai trò, phạm vi tenant/đơn vị luôn nhìn thấy, tìm nhanh và hộp công việc. Đường dẫn sâu gồm module → đối tượng → phiên bản/tab. Trong một module, các điểm bắt đầu công việc được phân nhóm trong menu dọc; chi tiết và biểu mẫu giữ ngữ cảnh cha. Không sử dụng hàng chip kéo ngang để liệt kê tất cả màn hình. Sidebar chuyển thành drawer trên màn hình hẹp; tenant admin và platform admin là workspace khác, không dồn mọi quyền vào một menu.

Màn hình gốc theo vai trò: lãnh đạo vào điều hành; cán bộ vào việc/báo cáo đến hạn; kế toán vào hồ sơ/đối soát; chuyên gia vào bàn phân tích; data steward vào quality queue; platform operator vào tenant health. Một người có nhiều vai trò được đổi workspace, vẫn kiểm quyền server.

## Hệ thống thị giác
Màu chính đỏ ruby #B4233D, chữ than #29272D, sidebar/surface trắng #FFFFFF, nền trắng ấm #F7F5F4. Điểm chọn #FFF0F2; emerald #287866 cho trạng thái tích cực, amber #99631C cho cảnh báo. Amber phục vụ cảnh báo/ưu tiên, không gắn ngẫu nhiên cho mọi thẻ. Dùng chữ 14–16 px cho nội dung, 24–32 px cho tiêu đề, số tabular trong bảng tiền. Font có tiếng Việt hoàn chỉnh; triển khai có thể chọn font thương mại/mã nguồn mở đã kiểm license. Mockup dùng Segoe UI/Arial để mở offline ổn định.

Grid desktop 12 cột, nội dung co giãn, gutter 16–24 px, spacing theo 4/8 px. Card radius 14, input 8, pill trạng thái 20. Bảng dùng đường phân cách nhẹ, header cố định, tên/mã dự án ghim, tiền canh phải, số âm có ký hiệu và lời giải thích. Đơn vị tiền hiện ở header và tooltip; cho đổi tỷ/triệu/đồng nhưng không đổi giá trị lưu.

(Cập nhật 1.4 — CR-06-03) Nguồn token duy nhất là `04_Design_Assets/design_tokens.json` (nhóm `color`, `font`, `space`, `radius`, `viewport`, `touch`, `prototypeNavigation`, `businessNavigation`). Web sinh CSS custom properties/TypeScript tokens từ tệp này; Flutter sinh `ThemeData` (ColorScheme, TextTheme, khoảng cách, bo góc, kích thước chạm 44 pt/48 dp) từ cùng tệp bằng bước build, không sao chép tay giá trị (D-B12). Theme tenant đã công bố (SAS-04) chỉ ghi đè nhóm màu và nhận diện được phép, sau publish; token ngữ nghĩa success/warning/danger giữ phân biệt. Đổi token là thay đổi hợp đồng: cập nhật `design_tokens.json`, `02_Prototype/brand-theme.css` và chạy lại kiểm tương phản.

## Tính động có kiểm soát
Dashboard: kéo thả/reorder/resize trong mode chỉnh sửa; auto-save nháp có version; publish riêng; undo/redo; layout riêng desktop/tablet/mobile. Bộ lọc có chips, clear-all, saved view, URL context an toàn. Chart selection cross-filter bảng và widget liên quan; reset có nút rõ; mọi widget công bố metric version và freshness. Mục tiêu production phải hỗ trợ keyboard reorder tương đương drag.

Form: progressive disclosure theo loại nguồn/hồ sơ/model; giữ giá trị khi đổi tab; dirty indicator và cảnh báo rời trang; autosave nháp với trạng thái đang lưu/đã lưu/lỗi, không giả định autosave đã gửi. Validation inline sau tương tác, summary lỗi khi submit và focus tới lỗi đầu. Đổi model cập nhật effort được hỗ trợ và chi phí ước tính; đổi gói/license hiện impact trước lưu.

Bảng: cấu hình cột, ghim, đổi thứ tự, density, filter builder và chọn hàng; hành động batch có preview số đối tượng, phạm vi và thất bại từng dòng. Bulk approve không bỏ qua kiểm tra từng hồ sơ. Drawer giữ ngữ cảnh danh sách; full page dành cho chỉnh sửa nhiều bước/tài liệu lớn. Hộp thoại chỉ dùng quyết định ngắn, luôn nêu đối tượng và hậu quả.

Chuyển động 120–180 ms cho hover/toggle, 180–240 ms cho drawer, không animation kéo dài ở bảng nghiệp vụ. Tôn trọng prefers-reduced-motion. Loading dùng skeleton thay vì hiện KPI 0 rồi đổi sang số thật; đây là cải tiến sau quan sát clip tại 00:03–00:05. Progress thật theo stage, không phần trăm giả. Toast cho phản hồi nhẹ, error quan trọng cố định trong vùng nội dung.

## Drill down và giải thích số liệu
Tất cả số tổng hợp có affordance ↘/link, tooltip nêu ý nghĩa và action xem chi tiết. Từ tài chính đi tới đơn vị/nguồn/dự án/kỳ/giao dịch/chứng từ; từ AI tới task/run/attempt/usage; từ thông báo tới workflow/recipient/attempt/provider callback; từ SaaS tới tenant/subscription/license/invoice line. Bảng ngữ cảnh gồm scope, as_of, snapshot, formula, unit và exclusions.

Drawer drill có breadcrumb, tổng được chọn, nhóm con và footer đối soát. Tỷ lệ show numerator/denominator. Khi con không cộng được phải nêu lý do (distinct overlap, ratio, suppressed scope). Không làm drill chỉ mở trang tổng quan khác mất bộ lọc. Tải chứng từ cần quyền hiện tại; link nguồn hết hạn có hướng dẫn cấp lại.

## Trạng thái và khả năng tiếp cận
Mỗi nhóm màn hình có loading, populated, empty, validation error, service error, permission denied, stale data; mobile thêm offline, sync pending/conflict, permission denied camera/push; SaaS thêm grace/expired/suspended. Empty phân biệt chưa có dữ liệu với không có kết quả lọc. Không dùng chỉ màu để truyền trạng thái. Focus ring rõ, tab order theo luồng, heading semantic, input labels liên kết, aria-live phù hợp và tooltip không chứa thông tin duy nhất.

Mục tiêu WCAG AA phải được đo ở UI production, bao gồm brand tenant thay màu. Tương phản body tối thiểu mục tiêu 4,5:1, control/big text 3:1; logo không thay cho tên tenant trong xác thực. Text scaling 200% và screen reader phải được kiểm ở luồng lõi. Nội dung tiếng Việt không cắt tên dự án thiếu tooltip/xem đầy đủ.

(Cập nhật 1.4 — CR-06-04) Mục tiêu đo là WCAG 2.2 AA (D-B06), gồm các tiêu chí mới của 2.2: kích thước đích chạm tối thiểu 24×24 px CSS trên web (mobile theo 44 pt/48 dp), focus không bị che bởi header/sidebar cố định, thao tác kéo có phương án không kéo, không bắt nhập lại thông tin đã cung cấp trong cùng luồng, xác thực không dựa trên kiểm tra nhận thức. Tên bảy trạng thái chuẩn dùng trong catalogue và test: loading, populated, empty, validation error, service error, permission denied, stale data. Mobile thêm: offline, sync pending, sync conflict, kết quả chưa xác định (UNKNOWN, theo `05_modules/MOB.md`), từ chối quyền camera/push/vị trí. SaaS thêm: grace, expired, suspended. Văn bản DOC thêm: chờ xác nhận pháp lý (watermark CXN), chữ ký không hợp lệ.

## Bộ component và bàn giao thiết kế
Component families: AppShell, TenantSwitcher, WorkspaceNav, SearchPalette, MetricTile, DataTable, FilterBar, DrillDrawer, MoneyInput, FiscalPeriodPicker, FundingMatrix, EvidenceViewer, ComparePanel, WorkflowCanvas, NotificationPreview, LicenseImpactPanel, MasterTree, QualityBadge, SyncQueue và MobileBottomNav. Mỗi component có variants theo density/state/permission, token và event contract.

Tệp design_tokens.json là nguồn token ban đầu; screen_catalog.json là danh mục màn hình; Screen_Specifications.html nối màn hình với role/field/validation/AC. PNG là bản review raster; HTML/CSS/JS là prototype sửa được. Figma chưa kết nối nên không có file Figma native hay Auto Layout/component library được xác nhận; có thể nhập SVG vector và dùng HTML/ảnh làm tham chiếu khi kết nối công cụ thiết kế. Không gọi PNG là layer Figma chỉnh sửa được.

### Component bổ sung cho phân hệ mới
(Cập nhật 1.4 — CR-06-05) Các phân hệ mới (DOC, LND, PMT, QMS, AUD, AST, MNE) và phần mở rộng (PAY, CAP, DIS) cần bảy component. Mỗi component là tổ hợp của các family đã có, dùng lại token, variant density/state/permission và event contract của family gốc; không tạo family mới hoặc style riêng.

| Component | Dùng ở | Tổ hợp từ family có sẵn | Quy tắc riêng |
|---|---|---|---|
| DocumentViewer / SignaturePanel | DOC (văn bản đi/đến, ký), MOB-67, PAY/MNE (xem bản phát hành) | EvidenceViewer (vùng PDF, trang, phóng to) + ComparePanel (so phiên bản) + DrillDrawer (báo cáo xác minh chữ ký) | Hiển thị từng chữ ký: vai trò, chứng thư, kết quả VALID/INVALID/INDETERMINATE, mã lỗi; ký luôn qua bước xác nhận có step-up; không có nút ký trong push hay swipe |
| TransmittalList | DOC (phân phối, văn bản đến), PMT, AUD | DataTable + FilterBar + DrillDrawer | Cột số/ký hiệu/ngày ghim trái; trạng thái giao nhận bằng nhãn chữ, không chỉ màu; hành động hàng loạt có preview |
| ParcelMap | LND (thửa, hộ ảnh hưởng), QMS (ảnh geotag), PRJ map | EvidenceViewer (lớp bản đồ/ảnh) + MasterTree (phân cấp địa bàn) + DrillDrawer | Dữ liệu cá nhân (họ tên, CCCD) ẩn mặc định, chỉ hiện theo quyền; luôn có dạng danh sách thay thế cho bản đồ (bàn phím, trình đọc màn hình) |
| PermitTimeline | PMT (mốc giấy phép), PRJ (vòng đời PIMA), DOC (vòng đời văn bản) | WorkflowCanvas (dạng chỉ đọc theo trục thời gian) + QualityBadge (hạn hiệu lực) + MetricTile | Mốc quá hạn/sắp hết hạn dùng amber/danger kèm chữ; ngày theo múi giờ Asia/Ho_Chi_Minh |
| FindingTracker | AUD (kết luận, kiến nghị, khắc phục), QMS (NCR), BID (phát hiện AI) | DataTable + QualityBadge + ComparePanel + DrillDrawer | Mỗi dòng có người chịu trách nhiệm, hạn, bằng chứng; đóng phát hiện cần bằng chứng và người duyệt khác người xử lý |
| LedgerTable | PAY (sổ lũy kế R7, tạm ứng), CAP (sổ cái vốn), CTR (giữ lại) | DataTable + MoneyInput (chế độ chỉ đọc) + DrillDrawer | Tiền canh phải, số tabular, đơn vị ở header; bút toán đảo hiển thị là dòng riêng liên kết dòng gốc, không ẩn hay gạch xóa; không có ô sửa số đã chốt |
| RateComparison | DIS, HOME, MNE (hai tỷ lệ giải ngân, xếp hạng) | MetricTile + DrillDrawer | Luôn hiện tử số, mẫu số và tên mẫu số cho từng tỷ lệ; mẫu số 0 hiện "không áp dụng" kèm lý do, không hiện 0% |

## Kiểm định UX và ngưỡng đạt mục tiêu
Pilot với đại diện mỗi vai trò, task đo được: tìm hồ sơ, lập báo cáo, xử lý return, drill tới chứng từ, xác nhận thông báo, cấu hình license và kiểm chứng AI. Mục tiêu đề xuất ≥90% hoàn tất task lõi không trợ giúp, lỗi nhập trọng yếu bằng 0 trong bài test, SUS ≥80 và thời gian tìm nguồn giảm ≥50% so với baseline. Cần đo thực tế; không tự chấm UI 9/10 bằng cảm nhận của người thiết kế.

(Cập nhật 1.4 — CR-06-06) Tiêu chí đo của mục tiêu "10/10" theo D-B06: SUS ≥ 80, ≥ 90% task lõi hoàn tất không trợ giúp, 0 lỗi nhập trọng yếu, 100% test critical đạt, WCAG 2.2 AA. Đo ở pilot (D09); không tự chấm điểm.

## Quy trình thêm màn hình và field mới
(Cập nhật 1.4 — CR-06-07) Áp dụng cho mọi màn hình mới của 7 phân hệ mới, mọi màn hình mở rộng và mọi field thêm vào màn hình cũ.
1. **Định danh.** ID màn hình theo đuôi tiếp của phân hệ (ví dụ CAP-22 sau CAP-21; phân hệ mới bắt đầu từ 01; mobile MOB-69 trở đi), không đổi hay tái dùng ID cũ. FR mới `FR-<MÃ>-NN`, test màn hình `UI-<screen>`, backlog `BL-<screen>`.
2. **Chọn loại màn hình có sẵn.** Mỗi màn hình mới chọn một `kind` đã có trong `screen_catalog.json` (ví dụ `list`, `table`, `detail`, `form`, `approval`, `review`, `compare`, `timeline`, `documents`, `map`, `reconcile`, `import`, `dashboard`). Kind mới chỉ được thêm khi không kind nào phù hợp, có CR và PO duyệt.
3. **Chọn component.** Dùng component family ở mục trên hoặc component bổ sung (là tổ hợp của family). Không viết style riêng ngoài token; không đổi shell, sidebar, bottom navigation hay pattern điều hướng. Phân hệ mới vào thư viện ứng dụng và danh mục phân hệ; sáu đích trực tiếp của sidebar chỉ đổi qua CR được PO duyệt.
4. **Field.** Mỗi field thêm ghi FR nguồn, kiểu, đơn vị, bắt buộc/tùy chọn, quy tắc validation và trường dữ liệu (bảng.cột) trong đặc tả phân hệ mục 8. Tiền dùng MoneyInput, kỳ dùng FiscalPeriodPicker; field nhạy cảm ghi classification và quy tắc che.
5. **Trạng thái.** Thiết kế đủ 7 trạng thái chuẩn; mobile thêm offline, sync pending, sync conflict, UNKNOWN; SaaS thêm grace/expired/suspended; ghi trạng thái riêng của phân hệ trong đặc tả mục 8.
6. **Khả năng tiếp cận.** Đạt WCAG 2.2 AA: nhãn liên kết, thứ tự tab theo luồng, focus nhìn thấy và không bị che, tương phản theo token, không truyền thông tin chỉ bằng màu, kích thước đích chạm, text scaling 200% (web) và dynamic type (mobile).
7. **Mobile.** Màn hình Flutter dùng `ThemeData` sinh từ `design_tokens.json`; khung 390×844, kiểm 360×800 và 430×932; chạm 44 pt/48 dp; không dùng cử chỉ là cách duy nhất cho chức năng quan trọng.
8. **Prototype và tài sản.** Thêm màn hình vào `02_Prototype` trong shell hiện có (refresh cache key), cập nhật `screen_catalog.json`, `navigation_architecture.json`, xuất PNG/SVG bằng script export (không chạy bootstrap ghi đè shell — AGENTS.md).
9. **Cổng review.** (a) Tự kiểm: token, component, 7 trạng thái, a11y tự động; (b) Codex review mã (D-B05); (c) PO duyệt baseline hình ảnh của màn hình; chỉ sau đó ảnh được dùng làm chuẩn visual-regression; (d) visual-regression so với baseline đã duyệt chặn merge khi lệch ngoài ngưỡng. Màn hình chưa qua (c) mang nhãn "chưa duyệt hình ảnh" trong catalogue.

## Thanh điều hướng bản thiết kế — cập nhật v1.2
Tên hiển thị chính thức theo yêu cầu: Hệ Thống Lý Dự Án Đầu Tư Công. Giữ đường dẫn thư mục và mã màn hình để không làm hỏng bookmark, traceability và liên kết tài liệu. Tên mới xuất hiện ở web, smartphone, các tài liệu và thư viện hình.

(Cập nhật 1.4 — CR-06-08) Thanh điều hướng sử dụng nền trắng #FFFFFF, biểu trưng kiến trúc nền ruby #991C35, chữ đậm vừa và khoảng trắng rõ ràng. Thứ bậc gồm nhận diện hệ thống, tìm màn hình, lựa chọn Web/Mobile và Tùy chọn. Toàn bộ màn hình trong `02_Prototype/screens.js` được đưa vào hộp tìm kiếm (327 ở baseline 1.3; số hiện hành đo tại `03_Engineering/Implementation_Readiness.html`); trạng thái mô phỏng nằm trong bảng Tùy chọn cùng mã/tên màn hình và nút trước/sau. Khi chọn trạng thái khác chuẩn, nút Tùy chọn có dấu hiệu và nhãn giải thích.

Ctrl/Cmd K mở bảng tìm màn hình; hỗ trợ tiếng Việt có dấu hoặc không dấu, tên/mã/phân hệ, bộ lọc nền tảng và phân hệ, lịch sử tám màn hình gần nhất lưu cục bộ. Phím lên/xuống chọn kết quả, Enter mở, Escape đóng và trả focus. Web/Mobile ghi nhớ màn hình gần nhất của từng nền tảng trong phiên; thay đổi nền tảng quay về trạng thái chuẩn. Kết quả rỗng có hướng dẫn bỏ bộ lọc. Hộp thoại có nhãn, focus ring và giữ vòng Tab bên trong.

Ở độ rộng ≤620px, thanh điều hướng chuyển thành hai hàng; các điều khiển giữ nhãn cần thiết và không tràn ngang. Bộ kiểm tra navigation_qa.json ghi nhận hành vi điều hướng và bố cục 390/768/1134/1440px. Các ảnh tham chiếu nằm trong 04_Design_Assets/navigation. Thanh này phục vụ review prototype; không thay thế thanh nghiệp vụ và tìm hồ sơ của ứng dụng production.

## Điều hướng nghiệp vụ — bản làm việc hiện tại

### Quyết định thiết kế
Một sidebar ổn định rộng 252 px ở desktop, 236 px ở cửa sổ hẹp; không còn rail thứ hai, bộ chọn phân hệ lồng nhau hoặc catalogue chip cuộn ngang. Cá nhân gồm Tổng quan, Việc của tôi, Thông báo. Sáu nghiệp vụ mở trực tiếp: Dự án, Kế hoạch vốn, Giải ngân, Thanh toán, Nhà thầu, BI & báo cáo.

(Cập nhật 1.4 — CR-06-09) Mỗi phân hệ có nút đóng/mở riêng cho các lối tắt. Nhóm đã mở được giữ trong phiên, không tự đóng khi chọn nhóm khác. Chuyển route giữ khung trang và vị trí cuộn sidebar; đóng/mở nhóm không dựng lại nội dung hoặc xóa dữ liệu form đang nhập. Màn hình con giữ mục cha và đường quay lại. Tất cả chức năng mở danh mục đầy đủ của phân hệ; Tất cả ứng dụng mở thư viện có tìm kiếm trên toàn bộ route web của `navigation_architecture.json` (261 ở baseline 1.3). Sáu nhóm cũ chỉ còn là cách tổ chức thư viện, không chiếm một thanh điều hướng thường trực. Bảy phân hệ mới vào thư viện ứng dụng và danh mục phân hệ theo mục "Quy trình thêm màn hình và field mới".

### Cá nhân hóa và quản trị
Ngôi sao đầu trang ghim hoặc bỏ ghim route. Mục Đã ghim hỗ trợ đổi thứ tự, lưu localStorage và giữ sau tải trang. Quản trị & cấu hình nằm ở cuối sidebar, mở sáu phân hệ ADM, LLM, SAS, MDM, DGV, IAM. Prototype hiển thị phạm vi review đầy đủ; sản phẩm thật phải lọc menu theo quyền và kiểm quyền ở API.

### Notification Center
Hộp thông báo là danh sách và vùng đọc trong cùng một panel. Bộ lọc Tất cả/Chưa đọc/Cần xử lý, tìm không dấu, số chưa đọc đồng bộ sidebar; chọn thông báo mở nội dung và hành động liên quan. Không dùng bảng dữ liệu chung cho inbox. Bản mẫu có bốn thông báo; trạng thái đọc là dữ liệu phiên mô phỏng.

### Responsive và bàn phím
Web ≤980 px: sidebar thành drawer trái, thao tác mở/đóng có tên, Escape trả focus. ≤720 px: inbox chuyển sang danh sách hoặc chi tiết với nút quay lại. Smartphone giữ năm đích có icon và nhãn: Trang chủ, Dự án, Phê duyệt, Thông báo, Cá nhân. Tác vụ từ inbox smartphone đi tới route mobile. Thư viện và danh mục có tìm kiếm, focus ban đầu, vòng Tab và Escape. Ctrl/Cmd K là công cụ tìm màn hình phục vụ review; production cần tìm hồ sơ có phạm vi và quyền riêng.

### Thứ bậc thị giác
Nền trắng và xám ấm, đỏ ruby cho hành động và điểm chọn, emerald/amber cho trạng thái. Menu chính 14 px, menu ngữ cảnh 12 px, nội dung 14–16 px, tiêu đề 25–27 px. Thanh review 56 px desktop và 98 px mobile, header nghiệp vụ 54 px. Có trạng thái hover, selected, focus, disabled; chữ và icon đi cùng màu.

### Bằng chứng và giới hạn
(Cập nhật 1.4 — CR-06-10) Mapping giữ nguyên toàn bộ 261 route web và 66 route mobile của baseline 1.3; route mới thêm theo R10 không đổi route cũ. Số route hiện hành đo tại `03_Engineering/Implementation_Readiness.html`. Xem navigation_architecture.json, workspace_navigation_qa.json, design_review_coverage.json. Tham chiếu nghiên cứu và hạng mục rà soát tại UX_Research_and_Review.html. Đây là prototype có dữ liệu minh họa, chưa phải kiểm thử người dùng hoặc chứng nhận WCAG.

## Theme & thương hiệu theo tenant — SAS-04
(Cập nhật 1.4 — CR-06-11) Nguồn duy nhất của quy tắc SAS-04: `03_Engineering/Tenant_Theme_Specification.html` (System Admin độc quyền ghi, Tenant Admin chỉ đọc, preview tách tenant, review trước publish/rollback, mã lỗi duy nhất `REVIEW_INVALID`). Phần UI ràng buộc của tài liệu này: preview web/smartphone trong vùng sandbox, bước review hiển thị diff trước/sau, tenant đích và phiên bản gốc; kiểm sáu cặp màu ≥ 4,5:1 trước khi cho xác nhận; thông điệp lỗi review "Bản xem trước không còn hợp lệ — tạo review mới". Bốn đoạn SAS-04 của baseline 1.3 được chép ở phụ lục.

## Bàn giao UI cho đội phát triển
(Cập nhật 1.4 — CR-06-12) Giữ Ruby/Porcelain làm default, tenant tokens chỉ áp dụng sau publish. Menu cha không reload document, giữ DOM/scroll/focus/form; không tái lập dải catalogue ngang. Mỗi màn hình có loading/empty/error/denied/stale/conflict, keyboard labels, focus restore và responsive. Design_Board/prototype/bộ ảnh xuất của mọi màn hình (327 ở baseline 1.3, cộng màn hình mới theo R10) là nguồn review giao diện; trạng thái demo không thay quyền server. SAS-04 dùng preview sandbox, diff trước/sau và rollback version mới; TC TH01–TH05,UX01 là điều kiện nghiệm thu. Web và Flutter cùng sinh theme từ `design_tokens.json`; contract test backend ↔ client Dart sinh từ `openapi.json` là bắt buộc (D-B12).

(Cập nhật 1.4 — CR-06-13) Tài liệu điều phối: 05_Thiet_ke_chi_tiet (chỉ mục 25 phân hệ); 05_modules/<MÃ>.md mục 8 (UI/UX của phân hệ); 07_Smartphone_iOS_Android; 09_Ke_hoach_trien_khai; 10_Ke_hoach_kiem_thu_va_chuyen_doi; 03_Engineering/Tenant_Theme_Specification.html; 03_Engineering/Implementation_Backlog.html; 03_Engineering/Test_Case_Catalogue.html; 03_Engineering/Decision_Register.html.

## Phụ lục: ánh xạ nội dung baseline 1.3
Danh sách dưới chép nguyên văn mọi đoạn baseline 1.3 đã sửa hoặc bỏ, kèm nơi nội dung hiện nằm. Đoạn không có ở đây được giữ nguyên văn trong thân tài liệu. Mã đoạn `Bnn` đánh số các đoạn không phải tiêu đề của baseline 1.3 theo thứ tự xuất hiện, bắt đầu từ B00.

- **B00** — Sửa (CR-06-01). Nội dung hiện nằm ở: dòng phiên bản đầu tài liệu (Baseline 1.4; nêu tính ràng buộc web + Flutter).
  > # Hệ Thống Lý Dự Án Đầu Tư Công thiết kế trải nghiệm và hệ thống giao diện Baseline 1.3 | 22/10/2026 | Hướng thiết kế: phòng điều hành dòng vốn, tập trung ngữ cảnh và hành động.
- **B19** — Sửa (CR-06-08). Nội dung hiện nằm ở: Thanh điều hướng bản thiết kế, đoạn 2 (bỏ số cứng 327; số hiện hành đo ở Implementation_Readiness).
  > Thanh điều hướng sử dụng nền trắng #FFFFFF, biểu trưng kiến trúc nền ruby #991C35, chữ đậm vừa và khoảng trắng rõ ràng. Thứ bậc gồm nhận diện hệ thống, tìm màn hình, lựa chọn Web/Mobile và Tùy chọn. Số lượng 327 màn hình được đưa vào hộp tìm kiếm; trạng thái mô phỏng nằm trong bảng Tùy chọn cùng mã/tên màn hình và nút trước/sau. Khi chọn trạng thái khác chuẩn, nút Tùy chọn có dấu hiệu và nhãn giải thích.
- **B23** — Sửa (CR-06-09). Nội dung hiện nằm ở: Điều hướng nghiệp vụ › Quyết định thiết kế, đoạn 2 (bỏ số cứng 261 route; thêm chỗ của 7 phân hệ mới).
  > Mỗi phân hệ có nút đóng/mở riêng cho các lối tắt. Nhóm đã mở được giữ trong phiên, không tự đóng khi chọn nhóm khác. Chuyển route giữ khung trang và vị trí cuộn sidebar; đóng/mở nhóm không dựng lại nội dung hoặc xóa dữ liệu form đang nhập. Màn hình con giữ mục cha và đường quay lại. Tất cả chức năng mở danh mục đầy đủ của phân hệ; Tất cả ứng dụng mở thư viện có tìm kiếm trên 261 route web. Sáu nhóm cũ chỉ còn là cách tổ chức thư viện, không chiếm một thanh điều hướng thường trực.
- **B28** — Sửa (CR-06-10). Nội dung hiện nằm ở: Điều hướng nghiệp vụ › Bằng chứng và giới hạn (giữ 261/66 route của 1.3, thêm route mới R10).
  > ### Bằng chứng và giới hạn Mapping giữ nguyên 261 route web và 66 route mobile. Xem navigation_architecture.json, workspace_navigation_qa.json, design_review_coverage.json. Tham chiếu nghiên cứu và hạng mục rà soát tại UX_Research_and_Review.html. Đây là prototype có dữ liệu minh họa, chưa phải kiểm thử người dùng hoặc chứng nhận WCAG.
- **B29** — Bỏ (trùng lặp SAS-04) (CR-06-11). Nội dung hiện nằm ở: 03_Engineering/Tenant_Theme_Specification.html mục Ma trận quyền.
  > Chỉ System Admin được cấu hình thương hiệu cho các tenant: màu sắc, logo, menu, header, footer, tên hệ thống, địa chỉ và thông tin liên hệ. Tenant Admin chỉ được đọc cấu hình đã công bố của tenant mình, không được sửa, lưu nháp, tải logo, tạo review, áp dụng hoặc khôi phục. Các quyền quản trị nội bộ tenant khác không bao gồm quyền cấu hình thương hiệu.
- **B30** — Bỏ (trùng lặp SAS-04) (CR-06-11). Nội dung hiện nằm ở: 03_Engineering/Tenant_Theme_Specification.html mục Trạng thái và luồng, Kiểm tra cấu hình; phần UI giữ trong mục Theme SAS-04 của tài liệu này.
  > Bản nháp tách biệt theo tenant và không thay đổi giao diện đang dùng. Xem trước web/smartphone trong vùng riêng; bước review hiển thị chênh lệch trước/sau, tenant đích và phiên bản gốc. Xác nhận áp dụng tạo phiên bản bất biến mới. Khôi phục cũng phải review và tạo phiên bản mới, giữ nguyên lịch sử. Kiểm tra trường bắt buộc, email, tệp logo và sáu cặp màu tương phản tối thiểu 4,5:1 trước khi công bố.
- **B31** — Bỏ (trùng lặp SAS-04) (CR-06-11). Nội dung hiện nằm ở: 03_Engineering/Tenant_Theme_Specification.html mục Hợp đồng lỗi và Nghiệm thu; 05_modules/SAS.md BR-SAS-17.
  > Server phải xác thực System Admin cho mọi lệnh ghi; không tin vai trò, tenant_id hoặc cờ quyền do trình duyệt gửi. Review gắn actor, tenant, hash nội dung, base version và hạn sử dụng. Kiểm tra lại quyền và phiên bản trong giao dịch công bố; trả 403 khi thiếu quyền, 409 khi xung đột, 422 khi cấu hình không hợp lệ. Audit ghi người thực hiện, tenant, bản trước/sau, lý do khôi phục và thời điểm; không ghi bí mật vào log.
- **B32** — Bỏ (trùng lặp SAS-04) (CR-06-11). Nội dung hiện nằm ở: 03_Engineering/Tenant_Theme_Specification.html mục Prototype và bằng chứng.
  > Prototype SAS-04 dùng localStorage và bộ chọn vai trò mô phỏng để kiểm tra trải nghiệm. Đây không phải hệ thống xác thực hoặc cách ly tenant thật. Chi tiết triển khai và tiêu chí nghiệm thu nằm tại 03_Engineering/Tenant_Theme_Specification.html.
- **B33** — Sửa (CR-06-12). Nội dung hiện nằm ở: Bàn giao UI cho đội phát triển, đoạn 1 (bỏ số cứng 327 ảnh xuất; thêm theme sinh từ tokens cho web + Flutter, contract test Dart).
  > ## Bàn giao UI cho đội phát triển Giữ Ruby/Porcelain làm default, tenant tokens chỉ áp dụng sau publish. Menu cha không reload document, giữ DOM/scroll/focus/form; không tái lập dải catalogue ngang. Mỗi màn hình có loading/empty/error/denied/stale/conflict, keyboard labels, focus restore và responsive. Design_Board/prototype/327 exports là nguồn review giao diện; trạng thái demo không thay quyền server. SAS-04 dùng preview sandbox, diff trước/sau và rollback version mới; TC TH01–TH05,UX01 là điều kiện nghiệm thu.
- **B34** — Sửa (CR-06-13). Nội dung hiện nằm ở: Bàn giao UI cho đội phát triển, đoạn cuối (thêm 05, 05_modules, 07, Tenant_Theme_Specification).
  > Tài liệu điều phối: 09_Ke_hoach_trien_khai; 10_Ke_hoach_kiem_thu_va_chuyen_doi; 03_Engineering/Implementation_Backlog.html; 03_Engineering/Test_Case_Catalogue.html; 03_Engineering/Decision_Register.html.
