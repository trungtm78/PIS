# Kết quả khảo sát UI/UX ứng dụng điện thoại (MUX-0)

Phạm vi: `apps/mobile` (Flutter, 442 tệp Dart, 77 màn MOB, 5 tab), cả bản công (Hệ thống quản lý đầu tư công) và bản doanh nghiệp. Ngày khảo sát: 2026-11-12 đến 13. Không sửa mã sản phẩm.
Chủ sở hữu đã chốt (2026-11-12): sản phẩm và thiết kế mới nhắm tới cơ quan nhà nước (bản công); bản doanh nghiệp giữ nguyên nhưng không còn là đích thiết kế. Các lỗi xếp hạng dưới đây ưu tiên bản công; ảnh bản doanh nghiệp là bằng chứng bổ sung.

## 1. Cách đo

- Chạy ứng dụng thật trên emulator AVD `guide` (Pixel 6, Android 15, 720x1560 px, 320 dpi = 360x780 dp), bản debug biên dịch từ cây mã `ac10f7afc`, hai lần biên dịch: không đặt `MACHVON_EDITION` (bản công) và `=enterprise`. API là bộ khung e2e thật (`npm run e2e:stack`), nạp dữ liệu mẫu `clip-seed` (bản công: 45 dự án, 134 việc cần xử lý; bản doanh nghiệp: 21 dự án, 73 việc). Đăng nhập qua IdP thử của bộ khung. Điều khiển bằng `adb`, đo khung điều khiển bằng `uiautomator dump`, chụp bằng `screencap`.
- Phương pháp theo skill `ui-runtime-audit`: đo cái đang chạy. Mỗi phát hiện có ảnh hoặc bản dump và vị trí mã (tệp:dòng) khi truy được.
- Đối chiếu Nielsen (N1 đến N10), Material 3 (M3), Apple HIG, WCAG 2.2 (nguồn trong `research.md`).
- Ảnh: `docs/mobile-ux/audit/public/` (40 tệp) và `docs/mobile-ux/audit/enterprise/` (23 tệp), tổng 7,8 MB.

### Độ phủ và những gì không chụp được

| Nhóm | Kết quả |
|---|---|
| Chụp được (bản công) | MOB-02, 03, 04, 07 (3 lần cuộn), 09 (2 lần cuộn, nhóm lối tắt), 10 (3 lần cuộn), 11, 13, 15, 22, 28, 30, 31, 32, 41, 43, 47, 48, 49, 52, 53, 54, 55, 56, 60, 61, 62, 63. Ít nhất 30 màn; có trạng thái đang tải (MOB-62), rỗng (MOB-28, 41) |
| Chụp được (bản doanh nghiệp) | Đăng nhập, chọn đơn vị, MOB-07, 09, 10, 11, 15, 22, 30, 32, 41, 47, văn bản đến; ngoại tuyến (`state-offline-*`) |
| Chặn chụp (cố ý) | 19 mã trong `kSecureScreenIds` (`apps/mobile/lib/core/navigation/route_policy.dart:37`): MOB-14 đến 17, 20, 21, 23 đến 27, 56, 60, 65, 67, 72 đến 74, DOC-22. Android trả ảnh đen (7,5 KB; `enterprise/mob-23-approvals-BLACK-secure-screen.png`). Tab Phê duyệt chỉ có bản dump (`public/mob-23-approvals-uidump.txt`). Đánh giá các màn này từ mã và golden |
| Cần dữ liệu hoặc quyền | Luồng duyệt MOB-24 đến 26 (danh sách rỗng với người dùng IdP thử), báo cáo tuần MOB-14 đến 21, ký MOB-67, 72 đến 74, màn có camera và GPS |
| Không đo được | TalkBack, chữ hệ thống 200%, iOS, thiết bị thật, thời gian khung hình, khởi động nguội (UAT lượt 6: trên 2,5 giây). Làm ở MUX-3 đợt A (R41) |
| Một người dùng IdP | Không đổi được vai nên không thấy MOB-08 (cán bộ) riêng; cả hai bản hiện "Trang chủ lãnh đạo/điều hành". Màn cán bộ đánh giá từ mã |

## 2. Tám việc chính: số chạm đo thực

| # | Việc | Hiện tại | Vấn đề | Đề xuất v2 |
|---|---|---|---|---|
| 1 | Xem việc đến hạn | 0 chạm nhưng trả lời sai câu hỏi: "Cần xử lý ngay" xếp theo mức khẩn, 134 mục, không có "việc hôm nay" hay ba màu (`public/mob-07-home-top.png`) | Hạn không là trục sắp xếp | "Việc hôm nay" xếp theo hạn, ba dải: 0 chạm |
| 2 | Nhận một việc | 1 chạm + cuộn: nút "Nhận xử lý" dưới nếp gấp (y 1264 đến 1360/1560) | Hành động chính bị đẩy xuống | Nút chính trên hàng: 1 chạm |
| 3 | Duyệt | 4 chạm theo bảng định tuyến (tab, hồ sơ MOB-24, Duyệt MOB-25, xác nhận); không chạy được vì danh sách rỗng và màn chặn chụp | Rỗng nói "tạo bản ghi đầu tiên"; bản doanh nghiệp hiện ba hàng giống hệt (`enterprise/mob-23-approvals-uidump.txt`) | 3 chạm từ Trang chủ (hàng, Phê duyệt, Xác nhận trong sheet) |
| 4 | Xem tiến độ dự án | 2 chạm + 3 lần cuộn qua 4 lối tắt và nhóm thu gọn; tiến độ là danh sách chữ (`public/mob-09-projects.png`, `enterprise/mob-10-project-detail-scroll1.png`) | Không có phần trăm, không có dải giai đoạn | Thanh tiến độ ngay trong danh sách; tab Tiến độ |
| 5 | Báo cáo hiện trường | 5 chạm trở lên (Dự án, mở nhóm, "Hợp đồng và nhật ký công trường", chọn hợp đồng, "Viết nhật ký"); "Ghi nhận vướng mắc" kết thúc ở danh sách rỗng không có nút tạo (`public/mob-28-field-issue-form.png`) | 14 lối tắt chung một nhóm | Nút "Báo cáo" nổi, sheet 4 loại: 2 chạm |
| 6 | Tìm hồ sơ | 2 chạm + gõ (Cá nhân, Tìm kiếm trong hệ thống; `public/mob-52-search.png`); ô tìm của tab Dự án chỉ tìm dự án | Tìm toàn cục chôn | Biểu tượng tìm ở mọi tab: 1 chạm |
| 7 | Đọc thông báo | 1 chạm nhưng tab Thông báo hiện lại đúng danh sách việc của Trang chủ (`public/mob-32-notifications.png`) | Hai nơi cùng nội dung | Dòng thời gian sự kiện tách khỏi việc: 1 chạm |
| 8 | Đổi cài đặt | 2 chạm nhưng khó thấy: biểu tượng ở tab Thông báo; tab Cá nhân không có "Cài đặt" (`public/mob-47-account.png`) | Không có nơi đặt ngưỡng | Cá nhân, Nhắc hạn việc: 2 chạm, có xem trước |

## 3. Phát hiện xếp theo mức ảnh hưởng (A cao, B trung bình, C nhất quán và tích nợ)

### A
F-01 Màn đầu không có thứ bậc: thanh tiêu đề tối 112 px; dòng "Số liệu tại 06/11/2026" rồi "Toàn bộ phạm vi · 32 dự án · Chốt 06/11/2026 · Cập nhật 00:08" (cùng thông tin hai lần; "Cập nhật" gãy dòng); bản doanh nghiệp thêm khối ba dòng "Mạch Vốn / Phần mềm... / Đạm Phú Mỹ, Cán bộ của tổ chức" (160 px). Thẻ việc đầu có nhãn "Khẩn" lặp ngay dưới chip "Khẩn 23", 10 dòng chữ cùng cỡ, nút dưới nếp gấp; số liệu giải ngân nằm ở lần cuộn thứ hai. Ảnh: `public/mob-07-home-top.png`, `enterprise/mob-07-leader-home-top.png`, `mob-07-leader-home-scroll2.png`. Mã: `apps/mobile/lib/features/read_support/data_view.dart:245` (thanh độ mới gắn mọi màn), `:279-317` (`FreshnessBar`), `lib/core/widgets/context_bar.dart:12`, `lib/editions/enterprise/enterprise_home.dart:161-165`, `lib/features/dashboard/widgets/alert_card.dart:273`.
F-02 Số tiền sai đơn vị và gãy dòng: 38 tỷ hiện "38.000 triệu đồng" (`public/mob-10-project-detail.png`); "1.534.000 triệu đồng" và "26.788,606145 triệu đồng" cỡ 32 gãy hai dòng (`enterprise/mob-15-capital-plan.png`); 1.000 đồng hiện "0,001 triệu đồng" (`docs/demo-redesign/phone/mob-project-detail.png`). Mã: gốc lỗi `lib/features/read_support/money.dart:44` (`formatMillions`: luôn chia cho 1.000.000, giữ tới sáu số lẻ) và `read_support/amounts.dart:8` (`millionsLabel`, 52 chỗ gọi trong 19 tệp); bản thứ hai `lib/features/offline/offline_format.dart:23` (`formatMoney`), thứ ba bọc ở `reporting/labels.dart:221`. Hai `formatMoment`: `offline_format.dart:14` (DateTime) và `read_support/moment.dart:9` (chuỗi ISO). Lưu ý: đề bài nêu `offline_format.dart:23`, nhưng lỗi hiển thị thật nằm ở `money.dart:44`.
F-03 Tab Dự án là thực đơn 14 lối tắt: ô tìm, ô lọc, "Hiển thị 45 trên 45", 4 hàng (Bản đồ hiện trường, Kế hoạch vốn, Dự án chưa nộp báo cáo, Vướng mắc theo tuần), nhóm thu gọn "Báo cáo và công việc hiện trường" chứa 10 hàng nữa; dự án đầu chỉ thấy ở y=1164/1560. Ảnh: `public/mob-09-projects.png`, `mob-12-field-work-expanded.png`, `mob-09-projects-module-launcher-list.png`. Mã: `lib/features/project_views/screens/project_list_screen.dart:113-116`, `:188-192` (`ExpansionTile`, `kProjectWorkLinks`), `:218`.
F-04 Chi tiết dự án là bảng "nhãn: giá trị" với nhiều "Chưa có", thẻ Vốn lặp "527.000.000.000 đồng" rồi "527.000 triệu đồng", mốc là chữ; chip "Đã xong" mang biểu tượng cảnh báo vàng vì gộp trạng thái và độ trễ. Ảnh: `public/mob-10-project-detail.png`, `enterprise/mob-10-project-detail-scroll1.png`. Mã: `lib/features/project_views/screens/project_detail_screen.dart:145` (`StatusPill(... warn: milestone.delayed)`).
F-05 Không có hạn ba màu: hạn chỉ là chữ đỏ "Quá hạn 35 ngày"; màu dành cho mức khẩn (đỏ, vàng, xanh dương); không có mức xanh, không có ngưỡng ngày; chip "Khẩn 23, Cần xử lý 62, Theo dõi 52" trông như bộ lọc nhưng không bấm được (không có cờ clickable trong dump). Ảnh: `public/mob-07-home-top.png`.
F-06 Trạng thái rỗng chung chung: một câu "Chưa có dữ liệu. Điều chỉnh bộ lọc hoặc tạo bản ghi đầu tiên." cho phê duyệt, hàng đợi gửi, vướng mắc, thông báo; "Ghi nhận vướng mắc" chỉ hiện danh sách rỗng, không có nút ghi nhận. Ảnh: `public/mob-28-field-issue-form.png`, `mob-41-queue.png`. Mã: `lib/core/l10n/core_strings.dart:17-18`.

### B
F-07 Đổi tab ngầm: từ Cá nhân bấm "Hàng đợi gửi" thì tab chọn thành Dự án, Quay lại về danh sách dự án (đo bằng `uiautomator`). Mã: `lib/core/navigation/mobile_routes.generated.dart:46,48` (MOB-41, 43 `tab: AppTab.projects`); MOB-52 ở `:57` đúng `account`.
F-08 Hai dải ngoại tuyến cùng nói một điều, chiếm 40% màn đầu (`enterprise/state-offline-home-refresh-failed.png`). Mã: `data_view.dart:300-310` cộng `lib/core/state/status_banners.dart`.
F-09 Chữ phẳng: toàn chữ 12 đến 16, `fontWeight:` 56 chỗ trong `lib/features`; tiêu đề, nhãn, giá trị, chip tranh nhau.
F-10 Cụm nút xếp chồng không đều: 5 nút dọc, hai nút cuối rộng khác nhau và dính nhau; tiêu đề thanh trên bị cắt "Hợp đồng và m..." (`public/mob-13-diary-hub.png`).
F-11 Tìm kiếm toàn cục và cài đặt chôn; tab Cá nhân là 10 hàng cùng dạng không nhóm (`public/mob-47-account.png`; `lib/features/account/screens/account_screen.dart`).

### C
F-12 Thành phần dùng chung quá ít (R38), đếm trong `lib/features` (357 tệp): `TextStyle(` 15 chỗ (`account/screens/tenant_switch_screen.dart:209,218`, `attachments/screens/attachments_screen.dart:121,257`, `dashboard/widgets/committee_card.dart:142`, `field_quantities/screens/inspection_screen.dart:331,357,358`, `offline/screens/conflict_screen.dart:212`, `offline/screens/offline_screen.dart:82`, `offline/screens/queue_screen.dart:135,224`, `personal_bi/tile_card.dart:365`, `procurement_workflow/screens/process_tree_screen.dart:146`, `release/screens/help_screen.dart:143`); `BoxDecoration(` 14 (ví dụ `dashboard/widgets/alert_card.dart:49`, `rag_card.dart:279`); `Scaffold(` 26 và `AppBar(` 17 viết lại từng màn; `Card(` 29; `FilledButton`/`OutlinedButton`/`TextButton` 82/65/47; `EdgeInsets` số 367 (8 chỗ số trần `EdgeInsets.all(16)`); `SizedBox(height:` 307. `lib/core/widgets` có 7 widget (778 dòng); chỉ `StatusPill` được dùng rộng (102 lần).
F-13 Bốn bộ định dạng số và ngày (F-02, thêm `read_support/data_view.dart:320`).
F-14 Thẻ việc quá dài: `alert_card.dart` 519 dòng, mỗi thẻ 11 thông tin; hậu quả và cấp leo thang nên ở chi tiết.
F-15 Tên mã lộ ở bản công: màn đăng nhập "Biểu tượng Mạch Vốn", "Mạch vốn thông suốt, đầu tư công minh bạch" (`public/mob-02-sign-in.png`); chủ sở hữu đã chốt không hiện tên mã.
F-16 Hai thanh chiếm 14% chiều cao: tiêu đề tối 112 px + thanh độ mới 112 px trên 1560 px, kể cả màn lồng sâu.
F-17 Vùng chạm đạt (nav 72 dp, nút 48 dp) nhưng hình giống nút mà không bấm được (F-05).
F-18 Tương phản: `textSecondary` trên nền `#F3F6F5` là 4,90:1 (sát ngưỡng, chữ 12); bốn màu ngữ nghĩa hiện hành 4,61 đến 5,53 (đạt, sát). V2 nâng lên 6,4 đến 7,1.

## 4. Chấm theo bộ nguyên tắc (hiện trạng, /10)
N1 6 · N2 4 · N3 6 · N4 5 · N6 4 · N8 4 · N9 5 · M3 6 · HIG 5 · WCAG 2.2 AA 7. Điểm mạnh nên giữ: tên truy cập đầy đủ; trạng thái luôn có biểu tượng và chữ; ngoại tuyến đọc từ bản lưu có nhãn thời điểm; chặn chụp màn nhạy cảm; phông Be Vietnam Pro tốt cho dấu tiếng Việt.

## 5. Mười phát hiện hàng đầu
1. F-01 trang chủ không thứ bậc, ngữ cảnh lặp hai lần, thẻ việc 10 dòng. 2. F-02 số tiền sai đơn vị. 3. F-03 tab Dự án là thực đơn 14 lối tắt. 4. F-05 không có hạn ba màu, chip giống nút. 5. F-04 chi tiết dự án là bảng nhãn/giá trị, không có tiến độ. 6. F-06 rỗng chung chung. 7. Báo cáo hiện trường 5 chạm trở lên, duyệt 4 chạm, tìm kiếm và cài đặt chôn. 8. F-07 đổi tab ngầm. 9. F-08 hai dải ngoại tuyến. 10. F-12 chỉ một thành phần dùng chung thật, 15 `TextStyle(`, 14 `BoxDecoration(`, bốn bộ định dạng.
