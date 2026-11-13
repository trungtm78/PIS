# Hệ thiết kế điện thoại v2 (mobile.v2)

Trạng thái: đề xuất đã tự chọn hướng và tự chấm, chờ chủ sở hữu xác nhận (chủ sở hữu đổi được hướng sau). Đích: bản công, "Hệ thống quản lý đầu tư công", tên biểu tượng "Đầu tư công", cho cơ quan nhà nước; bản doanh nghiệp đi qua lớp phủ ở mục 12.
Nhận diện giữ nguyên: "Xanh dầu điều hành", phông Be Vietnam Pro, lõi `design.md`. Thứ đổi là thứ bậc, mật độ, thành phần, luồng.
Tên mã nội bộ (MACHVON, Mạch Vốn) không xuất hiện trong mockup và không được hiện cho người dùng bản công.

Tệp liên quan: `docs/mobile-ux/findings.md` (khảo sát), `research.md` (nghiên cứu), `key-flows.md` (tám luồng vẽ lại), `mockups/direction-a.html`, `mockups/direction-b.html`, `mockups/direction-b-v1.html`, `before-after.html`, `mockups/measure.json` (số đo), `mockups/src/` (nguồn dựng).

## 0. Trạng thái triển khai (MUX-1, 2026-11-13)

Đã làm trong làn `mux1`: nhóm token `mobileV2` (sinh mã Dart riêng, đầu ra web không đổi), tách `core/theme` (`colors.dart`, `typography.dart`, `components.dart`, `theme_mode.dart`) và chế độ giao diện hệ thống, sáng, tối có lưu, bộ thành phần mục 5 ở `core/widgets` (mỗi cái có widget test và golden sáng, tối, chữ 200%), bộ định dạng duy nhất `core/format`, kiểm tĩnh R38 bánh cóc (`test/static/design_rules_test.dart` và `design_rules_baseline.json`), khung 5 tab và dải trạng thái dựng bằng thành phần mới. Chế độ tối mặc định tắt (mặc định là sáng) cho đến khi các đợt MUX-3 đưa hết màn sang màu của theme; chưa đo được khởi động nguội và thời gian khung hình (không có thiết bị trên máy này), ngân sách đã ghi ở `docs/qa/perf-budget.json`, mục `mobile`.

MUX-3 đợt D (làn `mux3d`): đăng nhập, xác thực hai yếu tố, chọn đơn vị và vai trò, phiên hết hạn, khám phá tổ chức (khung `AuthPage` dựng bằng `AppScaffold`, `AuthHeading`), tìm kiếm toàn cục (ô nhập đứng đầu và tự lấy tiêu điểm, tìm khi gõ sau 400 ms, từ khóa gần đây chỉ lưu khi bấm tìm hoặc mở một kết quả), hội thoại, BI cá nhân, trợ giúp, bản phát hành, quyền thiết bị, soi xét AI, tệp đính kèm, chỉ đạo, và phần trang chủ của bản doanh nghiệp (logo, tên riêng, thuật ngữ giữ nguyên) đã dùng thành phần và token v2; các bộ lọc thành `FilterChips`, khối có viền thành `OutlinedBlock`, hộp thoại nhập vị trí thành `ActionSheet`. Mọi tệp thuộc làn này đã ra khỏi `design_rules_baseline.json`.

## 1. Hai hướng và lựa chọn

**Hướng A, "Bảng điều hành".** Thanh tiêu đề tối và dải điều hành trên cùng, mọi thứ trong thẻ có dải hạn bên trái (đặc cho trễ, đứt nét cho sắp đến hạn, mờ cho còn thời gian), mỗi thẻ có một nút chính nằm ngay trên thẻ ("Phê duyệt", "Bổ sung chứng từ"). Mạnh về nhận diện và về số chạm duyệt (2 từ trang chủ), nhưng mỗi thẻ cao 150 đến 220 px nên màn đầu chỉ chứa 1 đến 3 mục, và khi nhân ra 77 màn thì thẻ, chip đặc, bóng và nút trong thẻ thành bốn mẫu riêng phải được quản.

**Hướng B, "Dòng việc".** Danh sách là trung tâm: tiêu đề lớn trên nền sáng, mỗi mục là một hàng có biểu tượng hạn ở đầu và nhãn hạn ở cuối, nhóm theo hạn bằng tiêu đề nhóm, đường kẻ mảnh thay cho khung, quyết định ở màn chi tiết với xác nhận bằng bottom sheet. Mạnh về mật độ (5 đến 6 mục trong màn đầu), về số lượng mẫu thành phần (một hàng cho mọi danh sách), và về hiệu năng (không bóng, không viền gradient trong danh sách).

### Chấm điểm theo tiêu chí của kế hoạch (phương pháp `plan-design-review`: mỗi tiêu chí một điểm 0 đến 10, ghi điều gì làm nó thành 10, sửa đến khi từ 9)

Điểm dựa trên số đo của mockup đã dựng (`mockups/measure.json`, đo bằng Playwright: số mục thấy đủ ở màn đầu, vùng chạm nhỏ nhất, số cỡ chữ khác nhau, số bóng và gradient mỗi màn) và trên số chạm của 8 việc. Hiệu năng khung hình là ước lượng theo thiết kế, cần đo thật ở MUX-3 đợt A (R41).

| Tiêu chí | A v1 | B v1 | B v2 (chọn) | Bằng chứng và điều còn thiếu để thành 10 |
|---|---|---|---|---|
| Thứ bậc thị giác | 8 | 8 | 9 | B v2: 5 cỡ chữ (12, 13, 15, 22, 32), một neo thương hiệu (dải điều hành tối), nhóm theo hạn, 5 mục thấy đủ ở màn Việc hôm nay (A: 3 trên 6). Thiếu để 10: thử người dùng thật ở cỡ chữ 100% và 150% |
| Số chạm của 8 việc | 7 | 7 | 9 | A v1 và B v1 mới vẽ 6 màn nên thiếu báo cáo hiện trường, tìm kiếm, cài đặt. B v2 vẽ đủ 8 luồng (`key-flows.md`): xem việc 0, nhận việc 1, duyệt 3 từ trang chủ (4 từ tab), tiến độ 1 đến 2, báo cáo hiện trường 2, tìm 1, thông báo 1, cài đặt 2. Thiếu để 10: duyệt 3 từ tab nếu chủ sở hữu cho chế độ hàng đợi |
| Nhất quán thành phần | 7 | 7 | 9 | A v1: 9 cỡ chữ trên 6 màn (12 đến 32, gồm 14, 16, 17, 20, 28) và 4 mẫu (thẻ có dải, chip đặc, hàng, thẻ chỉ số). B v1: cũng lệch (14, 18, 24, 26). B v2: một hàng, một tiêu đề nhóm, một tab gạch chân, một chip, một sheet; chỉ 5 cỡ chữ trong mọi khung. Thiếu để 10: kiểm tĩnh R38 chạy thật trong `flutter test` |
| Trợ năng | 7 | 7 | 9 | A v1: chip 36 px, nút 40 px (dưới 44). B v1: chip 36 px, tab rộng 25 px. B v2: mọi vùng chạm từ 44 px (đo), tương phản chữ trên nền dải từ 6,4:1, ba dải khác hình và có chữ, khung 200% không cắt chữ (lót dòng bỏ ở 1,5 lần trở lên, tiêu đề dừng ở 1,3 lần), chế độ tối 7:1 trở lên. Thiếu để 10: TalkBack và thiết bị thật |
| Hiệu năng khung hình (ước lượng) | 7 | 8 | 9 | A v1: 5 đến 6 bóng mỗi màn, thanh dải bằng gradient lặp. B v1: skeleton gradient (18) và một thanh gradient. B v2: 0 gradient, tối đa 2 bóng (thanh hành động, sheet; nút nổi), hàng cao cố định và ảo hóa. Thiếu để 10: đo thời gian khung hình trên bản release (ngân sách ở mục 10) |
| Phù hợp nhận diện | 9 | 7 | 9 | A giữ thanh tối ở mọi màn. B v1 mất neo thương hiệu. B v2 đưa dải điều hành tối (đúng `design.md`: "CommandHero là neo thị giác của trang chủ lãnh đạo"), vạch teal của thanh điều hướng, cùng token. Thiếu để 10: duyệt của khách |
| Trung bình | 7,5 | 7,3 | 9,0 | |

### Vì sao chọn B (ghi lý do)

1. Điểm v1 gần nhau (7,5 và 7,3): hơn kém không phải căn cứ. Căn cứ là tiêu chí quản trị và mở rộng mà chủ sở hữu đặt ra: 77 màn, phần lớn là danh sách và biểu mẫu. B cần ít mẫu thành phần nhất (mục 6: 14 thành phần), nên kiểm tĩnh R38 bắt được lệch và mỗi đợt MUX-3 áp dụng rẻ hơn.
2. Mật độ: màn đầu của cán bộ chứa 5 trên 6 việc (A: 3), phù hợp việc "xem việc hôm nay" và hiện trường dưới nắng.
3. Hiệu năng và độ ổn định: không bóng trong danh sách, không gradient, hàng cao cố định nên cuộn ảo hóa dễ giữ 60 khung hình trên máy tầm trung.
4. Phần tốt của A được gộp, không bỏ: dải điều hành tối (nhận diện), chip hạn chữ đậm cho mức trễ, xác nhận có tóm tắt hậu quả.
5. Chủ sở hữu đổi được: A hoàn chỉnh ở mức v1 (6 màn); chuyển sang A phải làm lại vòng chấm điểm và tăng thành phần (thẻ có dải, nút trong thẻ). Chi phí đổi được ghi để quyết nhanh.

### Nhật ký vòng lặp B v1 đến B v2 (mỗi dòng có số đo)

| # | Thay đổi | Trước | Sau |
|---|---|---|---|
| 1 | Cỡ chữ về đúng thang 5 bậc | v1: 12, 13, 14, 15, 18, 22, 24, 26, 32 | v2: 12, 13, 15, 22, 32 (mọi khung chuẩn) |
| 2 | Vùng chạm | chip 36 px, tab rộng 25 px, liên kết cao 20 px | tất cả từ 44 px (đo: không còn mục nhỏ) |
| 3 | Bỏ gradient | 18 trong skeleton, 1 trong dải giai đoạn | 0 |
| 4 | Dải điều hành tối ở trang chủ lãnh đạo | không có neo thương hiệu | có (đúng `design.md`) |
| 5 | Dải giai đoạn bị cắt chữ ("Chủ trươn", "Quyết địn") | nhãn 6 giai đoạn trong 6 cột | một dòng "Giai đoạn 4/6 · Thực hiện", 6 đoạn tô theo giai đoạn |
| 6 | Biểu tượng "còn thời gian" trùng biểu tượng "đã xong" (cùng dấu tích) | dấu tích tròn cho cả hai | đồng hồ cho "còn thời gian", dấu tích cho "đã xong" |
| 7 | Xác nhận phê duyệt bị gãy chữ ở nút | hai nút chia đôi hàng | nút chính đầy hàng, "Xem lại hồ sơ" bên dưới |
| 8 | Thêm 9 khung trạng thái và chế độ: xác nhận bằng sheet, danh sách dự án, rỗng, ngoại tuyến, đang tải, tối, chữ 200%, cài đặt ngưỡng, tạo nhanh báo cáo hiện trường | không có | có (`direction-b.html`, khung 7 đến 15) |
| 9 | Chữ 200%: tiêu đề và nhãn tab dừng ở 1,3 lần, bỏ cắt dòng, cột hạn xuống dưới tiêu đề | tiêu đề 64 px, nhãn tab gãy | không cắt chữ nào (khung 13) |

## 2. Quy tắc nền

1. Đọc theo thứ tự: ngữ cảnh một dòng, việc cần làm ngay, số liệu, nguyên nhân, xu hướng (giữ `design.md`).
2. Mỗi màn có một hành động chính. Nút chính là một nút teal đặc; nút phụ viền. Tối đa hai nút trong một thanh hành động.
3. Trạng thái không bao giờ chỉ bằng màu: hình biểu tượng, chữ, màu. Ba dải hạn là ba hình khác nhau.
4. Không hiện trường chưa có (ẩn thay vì "Chưa có"); số "0" chỉ khi thật sự là 0; đang tải hiện skeleton, không hiện 0.
5. Một nguồn cho mỗi con số trên màn: độ mới của dữ liệu nằm trong dòng ngữ cảnh, không lặp.
6. Danh sách là hàng, không phải thẻ; thẻ chỉ dành cho ô chỉ số và khối nhấn mạnh.

## 3. Token `mobile.v2` (R31)

Đặt ở nhóm riêng `mobileV2` trong `Design/MACHVON_Design/04_Design_Assets/design_tokens.json`; bộ sinh mở rộng chỉ phát ra mã Dart (`packages/mobile-tokens`, lớp `MachvonV2Colors`, `MachvonV2Type`, ...). Giá trị token web hiện dùng không đổi và CSS web sinh ra phải giống từng byte (kiểm bằng `tokens:check` và so sánh băm đầu ra CSS). Cổng bắt buộc: `tokens:check`, `dart:check`, làn visual web hai bản không đổi ảnh.

### 3.1 Màu (sáng / tối) và độ tương phản (đo bằng script, WCAG)

| Vai trò | Sáng | Tối | Ghi chú tương phản |
|---|---|---|---|
| `bg` (nền ứng dụng) | `#F3F6F5` | `#0B1A21` | |
| `surface` | `#FFFFFF` | `#112630` | |
| `sunken` | `#EAF0EF` | `#0E202A` | nền rãnh thanh, skeleton |
| `ink` | `#122D3B` | `#E6EEF1` | trên `bg`: 13,19:1 (sáng); 15,09:1 (tối) |
| `ink-2` (chữ phụ) | `#4A5E68` | `#B3C4CB` | trên trắng 6,79:1, trên `bg` 6,25:1 (nâng từ `#5B6E77`: 4,90 trên `bg`); tối 7,0:1 |
| `ink-3` (chữ chú thích, chỉ cỡ 12 trở lên) | `#5B6E77` | `#9DB1BA` | 5,33 trên trắng |
| `line` / `line-strong` | `#DDE6E7` / `#B9C8CC` | `#24404C` / `#38596A` | đường kẻ trang trí 1 px, không dùng để nhận ra điều khiển |
| `outline` (viền nút phụ, chip, ô nhập) | `#7A8F99` | `#6C8A99` | 3,38:1 trên trắng (3,11 trên `bg`); tối 4,27:1: đạt 3:1 của WCAG 1.4.11 |
| `header` (dải điều hành) | `#102E3B` | `#0A2029` | chữ trắng 14,23:1 |
| `primary` | `#007D77` | `#4FD1C5` | nút: trắng trên teal 5,00:1; tối: `#04211F` trên `#4FD1C5` 9,06:1 |
| `primary-strong` (chữ liên kết, tab chọn) | `#00635E` | `#7FE0D6` | trên nền nhạt `#E3F3F1` 6,23:1 |
| `late` chữ / nền / dấu | `#9C1C14` / `#FDECEA` / `#B3261E` | `#FFB4AB` / `#3D1714` / `#FF8A7D` | chữ trên nền 7,09:1 (tối 9,29) |
| `soon` chữ / nền / dấu | `#7A4B00` / `#FFF3D6` / `#B26A00` | `#FFD58A` / `#3B2A07` / `#F2B84B` | 6,72:1 (tối 9,96); dấu `#B26A00` trên trắng 4,24:1 (đạt 3:1 cho hình) |
| `ok` chữ / nền / dấu | `#14633A` / `#E4F4EA` / `#2E7D4F` | `#8FE0B0` / `#0F3321` / `#57C285` | 6,41:1 (tối 8,88) |
| `info` chữ / nền | `#1F5680` / `#E6F0F8` | `#A8D1F0` / `#12303F` | dải ngoại tuyến |

Hổ phách chuẩn (`#F59E0B`) chỉ đạt 2,15:1 trên trắng nên không dùng làm chữ; chữ vàng là nâu hổ phách `#7A4B00` trên nền `#FFF3D6`, hổ phách trung bình chỉ làm hình biểu tượng và viền (đạt 3:1 của WCAG 1.4.11). Nhãn "Trễ" đặc (chữ trắng trên `late-mark` `#B3261E`) dùng ở hướng A; hướng B dùng chữ đỏ đậm trên glyph nền đỏ nhạt.
Màu ngữ nghĩa không bị lớp phủ thương hiệu của đơn vị đổi (giữ quy tắc hiện hành của `MachvonSemantic`).

### 3.2 Chữ: 6 bậc, hai trọng số (400 và 600), có độ cao dòng

Be Vietnam Pro. Độ cao dòng tối thiểu 1,35 vì dấu tiếng Việt xếp chồng; số dùng chữ số đều (`tabular`).

| Bậc | Cỡ/dòng | Trọng số | Dùng cho |
|---|---|---|---|
| Display | 32/40 | 600 | tiêu đề lớn của màn gốc, số điều hành |
| Title | 22/30 | 600 | tiêu đề màn con, số trên ô chỉ số, tiêu đề sheet |
| Heading | 16/24 | 600 | tiêu đề nhóm trong thẻ và biểu mẫu |
| Body | 15/22 | 400 (đậm 600 cho tiêu đề hàng) | nội dung |
| Label | 13/20 | 600 | nhãn hạn, chip, nút phụ, nhãn nhóm |
| Caption | 12/18 | 400 (đậm 600 cho nhãn tab) | ngữ cảnh, chú thích; không có chữ nhỏ hơn 12 |

Trần cỡ chữ hệ thống: Display, Title và nhãn thanh điều hướng dừng ở 1,3 lần; các bậc còn lại theo hệ thống tới 2,0 lần, bỏ cắt dòng từ 1,5 lần, cột hạn xuống dưới tiêu đề. Hiện token web `title` 28 và phone 16 (`MachvonFont.mobileBody`); v2 đổi thang riêng cho điện thoại.

### 3.3 Khoảng cách, bo góc, đổ bóng, chuyển động, vùng chạm

- Khoảng cách: 4, 8, 12, 16, 24, 32 (bỏ 20 và 48 của thang cũ, dùng 16 hoặc 24).
- Bo góc: chip 8, điều khiển 12, thẻ 16, sheet 20 phía trên, glyph 12, tròn 999.
- Đổ bóng: `e0` không (mặc định cho hàng và thẻ chỉ số có viền), `e2` bóng hướng lên cho thanh hành động, sheet, nút nổi. Không bóng trong danh sách cuộn. Chế độ tối dùng viền thay bóng.
- Chuyển động: 150 đến 250 ms, đường cong `cubic-bezier(.2,.7,.2,1)`; chỉ biến đổi và độ mờ; tôn trọng "giảm chuyển động" (chuyển cảnh còn mờ dần 100 ms). Skeleton tĩnh, không lấp lánh.
- Vùng chạm: tối thiểu 48 dp (Android) và 44 pt (iOS) cho mọi điều khiển (theo `MachvonTouch`); chip và liên kết văn bản lót cho đủ vùng chạm; khoảng cách giữa hai vùng chạm 8 dp.
- Biểu tượng: nét 2, lưới 24, 20 hoặc 24 dp; bộ hiện có của Material Icons giữ cho Flutter (bộ vẽ tay trong mockup chỉ để tự chứa).

## 4. Ba dải hạn (đỏ, vàng, xanh)

| Dải | Điều kiện mặc định | Hình | Chữ mẫu | Chữ/nền | Dùng ở |
|---|---|---|---|---|---|
| Đỏ | còn dưới 1 ngày hoặc trễ | bát giác có dấu chấm than | "Trễ 2 ngày", "Hôm nay" | `late` | glyph đầu hàng, nhãn cuối hàng, banner chi tiết |
| Vàng | còn 1 đến 3 ngày | tam giác có dấu chấm than | "Ngày mai", "Còn 2 ngày" | `soon` | như trên |
| Xanh | còn trên 3 ngày | đồng hồ (tròn) | "Còn 8 ngày" | `ok` | như trên; xanh khi hoàn thành dùng dấu tích tròn, khác đồng hồ |

- Ngưỡng ba tầng (kế hoạch, mục quyết định 3): mặc định hệ thống, quy tắc đơn vị `DEADLINE_BAND_POLICY`, tùy chọn cá nhân. Cá nhân chỉ được nhắc sớm hơn quy định (R40); màn chung (bảng quản lý, portfolio, KPI) chỉ hiện màu chính thức; màu cá nhân chỉ ở "Việc của tôi" và thông báo của chính người đó, kèm nhãn "Theo cài đặt của bạn" và luôn kèm ngày hạn thật. Màn cài đặt có xem trước ba dải (khung 14).
- Hạn tính ở máy chủ theo ngày lịch giờ Việt Nam, điện thoại chỉ hiển thị (điện thoại không tự tính hạn từ đồng hồ máy).
- Không dùng màu một mình: có hình khác nhau (bát giác, tam giác, đồng hồ), có chữ, có vị trí (nhóm "Trễ hạn", "Sắp đến hạn", "Còn thời gian" có tiêu đề nhóm). Ba màu chữ (đỏ sẫm, nâu, xanh lá) đều là màu tối: dưới mô phỏng mù màu đỏ-lục chúng gần nhau về độ sáng, nên hình và chữ mang thông tin chính; màu chỉ bổ trợ. Cần kiểm lại bằng trình mô phỏng trên ảnh chụp thật ở đợt A.
- Tên truy cập: nhãn đọc to gồm dải và số liệu, ví dụ "Quá hạn, trễ 2 ngày, hạn 10/11" thay vì chỉ "Trễ 2 ngày".

## 5. Thành phần dùng chung và kiểm tĩnh R38

Thành phần mới hoặc làm lại ở `apps/mobile/lib/core/widgets` (tên đề xuất, mỗi cái có widget test và golden sáng, tối, chữ 200%):

| Thành phần | Thay cho | Ghi chú |
|---|---|---|
| `AppScaffold` (+ `AppTopBar`, `LargeTitleHeader`) | `Scaffold(` 26 nơi, `AppBar(` 17 nơi | thanh trên gọn có ngữ cảnh; tiêu đề lớn cho màn gốc, tiêu đề nhỏ cho màn con |
| `ContextLine` | `ContextBar` + `FreshnessBar` | một dòng: phạm vi, kỳ chốt, độ mới; mở rộng khi bấm |
| `CommandBand` | `CommandHero` | dải điều hành tối: một số lớn, một thanh, hai dòng chú |
| `StatStrip` / `StatCell` | `KpiTile` | ba ô một hàng, đường kẻ đứng, số Title |
| `WorkRow` (+ `WorkRowSkeleton`) | thẻ tự dựng (`BoxDecoration(` 14, `Card(` 29 nơi) | glyph hạn, tiêu đề tối đa 2 dòng, một dòng phụ, cột cuối |
| `GroupHeader` | tiêu đề tự viết | nhóm theo hạn, có số đếm |
| `DeadlineLabel` / `DeadlineGlyph` | `StatusPill` cho hạn | ba dải mục 4; `StatusPill` giữ cho trạng thái nghiệp vụ |
| `StageStrip` | danh sách mốc dạng chữ | 6 đoạn, nhãn giai đoạn hiện tại, số việc xong |
| `FilterChips` | `Wrap` + `ChoiceChip` tự dựng | vùng chạm 44 |
| `UnderlineTabs` | tab dạng khác nhau | cuộn khi chữ lớn |
| `InfoRow` | cặp nhãn/giá trị tự dựng | ẩn khi không có giá trị |
| `ActionBar` | cụm nút xếp chồng | tối đa hai nút, dòng giải thích khi nút chính bị khóa |
| `ActionSheet` / `ConfirmSheet` | `showDialog`, nút trong thẻ | tóm tắt hậu quả, ghi nhật ký kiểm toán |
| `StateView` (rỗng, lỗi, ngoại tuyến, quyền) + `StatusBanner` | `EmptyStateView`, `ProblemStateView`, `StateCard`, `StatusBanners` | một dải báo duy nhất; mỗi loại có câu và hành động |
| `ProgressMeter`, `MiniBar` | thanh tự dựng | tiến độ, giải ngân theo nguồn vốn |
| `core/format`: `formatMoney`, `formatDate`, `formatMoment`, `formatDeadline` | 4 bộ định dạng (xem `findings.md` F-02, F-13) | một bộ, theo mục 6 |

Giữ nguyên: `BrandLogo`, `Skeleton` (bỏ lấp lánh), `StatusPill` (trạng thái nghiệp vụ), `FigureInfo`.

**Kiểm tĩnh (R38)**: một test quét mã `apps/mobile/test/static/design_rules_test.dart`, chạy trong `flutter test`. Trong `lib/features` (và `lib/editions`) cấm: `TextStyle(`, `Color(0x`, `Colors.`, `fontSize:`, `BoxDecoration(`, `Card(`, `AppBar(`, `Scaffold(`, `EdgeInsets` với số trần (không qua `MachvonSpace`), `NumberFormat`, `toStringAsFixed(` ở nơi định dạng tiền hay ngày, `DateTime.now()` để tính hạn. Cho phép ở `lib/core/widgets` và `lib/core/format`. Vì hiện có 15 `TextStyle(`, 14 `BoxDecoration(`, 29 `Card(`, 26 `Scaffold(`, 17 `AppBar(`, dùng cơ chế bánh cóc: tệp `design_rules_baseline.json` ghi số vi phạm hiện có theo tệp, test thất bại khi số tăng và khi một tệp được sửa mà số không giảm theo kế hoạch đợt; mỗi đợt MUX-3 hạ trần, đợt D về 0 và xóa tệp baseline.

## 6. Tiền, ngày, số (bộ định dạng duy nhất)

Nguồn lỗi hiện hành: xem `findings.md` F-02. Quy tắc:

| Chế độ | Quy tắc | Ví dụ |
|---|---|---|
| Rút gọn (ô chỉ số, hàng, tiêu đề dải) | chọn đơn vị lớn nhất có phần nguyên từ 1: đồng (dưới 1.000), nghìn đồng, triệu đồng, tỷ đồng; tối đa 1 chữ số thập phân; làm tròn lên đơn vị kế khi chạm 1.000 (999.960.000 là 1 tỷ đồng, không phải 1.000 triệu đồng); dấu `.` ngăn nghìn, `,` thập phân | 999 đồng; 1 nghìn đồng; 38 tỷ đồng; 928,8 tỷ đồng; 1.058,3 tỷ đồng; 2,4 tỷ đồng (từ 2.350.000.000: làm tròn, kèm số đầy đủ ở chi tiết) |
| Đầy đủ (chi tiết, xác nhận phê duyệt, thanh toán) | đồng đầy đủ có dấu ngăn nghìn, kèm rút gọn trong ngoặc khi từ 1 triệu | 2.350.000.000 đồng (2,35 tỷ) |
| Phần trăm | một chữ số thập phân, dấu phẩy | 58,1% |

Không có đơn vị cố định "triệu đồng" cho mọi số; không bao giờ xuống 0,001 triệu. Hai chế độ ở mã: chính xác (mặc định, màn chưa vẽ lại và mọi nơi người duyệt hay trả tiền cần thấy đủ chữ số: giữ đơn vị theo cỡ số nếu ba chữ số thập phân còn đủ, nếu không thì đồng nguyên, ví dụ 1.049.000.000 là 1,049 tỷ đồng và 1.049.123.456 là 1.049.123.456 đồng) và rút gọn (`decimals: 1`, dành cho hàng và ô chỉ số của màn mới, làm tròn). Đã làm ở `apps/mobile/lib/core/format` (`moneyParts`, `moneyLabel`, `moneyExactLabel`, `moneyFullLabel`, `formatDay`, `formatMoment`, `formatDeadline`): một bộ duy nhất, giờ Việt Nam, ngày trước giờ sau. Hành vi cũ giữ cho số liệu báo cáo xuất tệp (không đổi hợp đồng API).
Ngày: `dd/MM/yyyy`, ngày ngắn `dd/MM`, giờ 24 giờ `HH:mm`, thứ "Thứ Năm". Tương đối chỉ cho hạn: "Hôm nay", "Ngày mai", "Trễ N ngày", "Còn N ngày" kèm ngày thật; không dùng "N ngày trước" cho hạn chót.

## 7. Cấu trúc điều hướng

Năm tab giữ tên: Trang chủ, Dự án, Phê duyệt, Thông báo, Cá nhân; nhãn luôn hiện; số đếm chỉ ở Phê duyệt (việc chờ) và Thông báo (chưa đọc); thanh điều hướng 64 dp, vạch teal ở đầu tab chọn.

| Tab | Nội dung | Bỏ khỏi tab |
|---|---|---|
| Trang chủ | lãnh đạo: dải điều hành, ba ô chỉ số, "Cần bạn quyết định"; cán bộ: "Việc hôm nay" (Của tôi, Cả nhóm, Đã xong), nút "Báo cáo" | thẻ "Cần xử lý ngay" 10 dòng, hai dòng ngữ cảnh |
| Dự án | danh sách dự án có tiến độ, lọc, tìm | 14 lối tắt (chuyển vào dự án và Cá nhân, Công cụ) |
| Phê duyệt | hàng chờ tôi, đã xử lý, tôi gửi | |
| Thông báo | dòng thời gian sự kiện, tách khỏi việc | danh sách việc trùng Trang chủ |
| Cá nhân | hồ sơ, Nhắc hạn việc, Thông báo, Công cụ (Tìm kiếm, Hàng đợi gửi, Làm việc ngoại tuyến, Ủy quyền, Sổ chỉ tiêu, Biểu mẫu), Đổi tổ chức, Đăng xuất | |

Quy tắc: mọi màn chỉ thuộc một tab và mở trong tab đó (sửa MOB-41, 43 gán sai tab, `findings.md` F-07); tìm kiếm là biểu tượng ở thanh trên của mọi tab gốc; màn chi tiết có thanh hành động dưới và ẩn thanh điều hướng; hoàn thành, duyệt xong quay về màn trước kèm thông báo ngắn (snackbar có "Hoàn tác" khi thu hồi được).

## 8. Trạng thái

| Trạng thái | Thiết kế | Khung mockup |
|---|---|---|
| Đang tải | skeleton đúng hình hàng, không hiện số 0, tĩnh | 11 |
| Rỗng: hết việc | biểu tượng tròn xanh, "Hôm nay bạn đã xong việc", việc kế tiếp, nút "Xem việc sắp tới" | 9 |
| Rỗng: lọc không ra | câu nêu bộ lọc đang áp và nút "Xóa bộ lọc" | (mô tả) |
| Rỗng: chưa có dữ liệu | nêu vì sao và ai tạo, không nói "tạo bản ghi" khi người dùng không tạo được | (mô tả) |
| Lỗi | gọi tên nguồn lỗi, thử lại ngay tại chỗ | (giữ `ProblemStateView` cũ về logic) |
| Ngoại tuyến, bản cũ | một dải duy nhất: thời điểm của bản lưu, điều gì không làm được, "Thử lại" | 10 |
| Đang gửi, thành công, xung đột phiên bản | khóa nút, biên nhận (mã, giờ, bước kế), so sánh rồi chọn | (giữ hành vi cũ, thay thành phần) |
| Không có quyền | nói phạm vi bị ẩn, không lộ tên | (giữ) |

## 9. Trợ năng

- Vùng chạm từ 44 px (đo trên mockup) và 48 dp trong Flutter; khoảng cách 8 dp.
- Tương phản chữ tối thiểu 4,5:1, mọi chữ trên nền dải từ 6,4:1; hình và viền điều khiển 3:1.
- Chữ hệ thống tới 200% không cắt nội dung: trần Display, Title, nhãn thanh điều hướng 1,3 lần; hàng bỏ cắt dòng từ 1,5 lần; tab cuộn ngang khi cần (khung 13).
- Không chỉ bằng màu; tên truy cập đọc hạn đủ chữ; thứ tự đọc: tiêu đề, ngữ cảnh, nhóm, hàng; nhóm hạn có vai trò tiêu đề.
- Kiểm bằng `apps/mobile/qa/device/scripts/android_a11y_audit.sh` (48 dp, tên) mỗi đợt, và TalkBack thủ công (chưa chạy được: xem `findings.md`, mục 1).

## 10. Ngân sách hiệu năng (R41, ghi vào `docs/qa/perf-budget.json` ở đợt A)

| Chỉ số | Ngân sách | Ghi chú |
|---|---|---|
| Khởi động nguội đến nội dung chính | từ 2,5 giây trở xuống, p75, bản release, thiết bị tầm trung | UAT lượt 6 ghi vượt 2,5 giây trên emulator; đo lại trên máy thật |
| Thời gian khung hình khi cuộn danh sách 200 hàng | dưới 1% khung quá 16 ms, 0 khung quá 700 ms | `ListView.builder` hoặc sliver, hàng cao cố định, không `Opacity` lồng, không `BackdropFilter` |
| Bóng và gradient trong danh sách | 0 | chỉ thanh hành động, sheet, nút nổi dùng `e2` |
| Ảnh minh họa mỗi màn | không quá 150 KB, không ảnh minh họa trong danh sách | glyph là biểu tượng vector |
| Skeleton | tĩnh | không hoạt họa lấp lánh |

## 11. Chế độ tối

Token ở mục 3.1 cột "Tối"; đã tính tương phản. Quy tắc: viền thay bóng; màu dải sáng hơn và nền dải tối nhưng cùng hình; dải điều hành đậm hơn `#0A2029`; ảnh và logo có biến thể trên nền tối (bộ sẵn `logo-*-ondark.svg`). Khung 12 là mẫu.

## 12. Bản doanh nghiệp (lớp phủ, không cắt phạm vi)

Cùng thành phần và token; khác ở lớp phủ đã có: màu thương hiệu của đơn vị (12 khóa SAS-04: `primary`, `menu`, ...) áp lên `header`, `primary`, `selected`; màu ngữ nghĩa và ba dải hạn không đổi; từ ngữ (`lib/editions/enterprise/enterprise_strings.dart`); khối thương hiệu ba dòng ở trang chủ (`enterprise_home.dart:161-165`) chuyển thành logo trong dải điều hành và mục hồ sơ ở Cá nhân; khung giải ngân theo vốn chủ sở hữu và vốn vay của bản doanh nghiệp dựng bằng `StatStrip` và `WorkRow`, không thành phần riêng. Kiểm bằng `edition:check` và golden hai bản. Bản doanh nghiệp không còn là đích thiết kế nên được áp ở đợt D.

## 13. Kế hoạch áp dụng và rủi ro (R39, R41)

1. Đợt A (khung, 5 tab gốc, Trang chủ, Việc của tôi, Thông báo): token `mobile.v2`, bộ thành phần mục 5, `core/format`, kiểm tĩnh bánh cóc; đo ngân sách mục 10; sửa F-02, F-07, F-08, F-15 ở đợt này vì chúng nằm trong khung.
2. Đợt B (dự án, phê duyệt, ký hồ sơ), C (hiện trường, nhật ký, khối lượng, thanh toán), D (còn lại, bản doanh nghiệp, PWA lãnh đạo dùng lại ngôn ngữ này).
3. Mỗi đợt: `flutter analyze`, widget test, golden (sáng, tối, 200%), Maestro (8 luồng), kiểm trợ năng, cả hai bản, giữ sàn coverage 90% của CI Mobile; thêm test luồng ngoài thành phần: chuyển giữa tab, phê duyệt khi bản cũ hoặc ngoại tuyến, khôi phục xung đột phiên bản. Không đổi hợp đồng API hay logic nghiệp vụ trong làn giao diện.
4. Rủi ro: Smart App Control chặn `sqlite3mc.dll` nên golden và test dùng SQLite không chạy được trên máy này (chạy ở CI Linux); các màn chặn chụp phải kiểm bằng golden vì không chụp được trên máy thật.
