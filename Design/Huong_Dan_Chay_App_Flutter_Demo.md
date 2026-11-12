# Hướng dẫn chạy app Flutter (Mạch Vốn, bản Doanh nghiệp) cho buổi demo 15:00

Cập nhật 10/11/2026 11:40. Đã kiểm chứng trên điện thoại Android thật Sharp SH-M19 (Android 12, arm64), serial `356660110224186`, đăng nhập thật với IdP thử của stack demo (cổng 47311/47312).

**Điện thoại của người trình bày là iPhone: KHÔNG build được bản iOS trên Windows** (cần máy Mac và Xcode). Vì vậy app Flutter chỉ chạy trên Android (điện thoại thật hoặc máy ảo). Với iPhone, dùng bản web (cổng 5173 hoặc 5443 qua HTTPS).

## 1. Hai file APK (cùng một mã nguồn, khác địa chỉ máy chủ)

| File | Trỏ tới | Dùng khi | Cần gì |
|---|---|---|---|
| `C:\PIS\Design\MachVon_DPM_debug.apk` | `http://127.0.0.1:47311` (API), IdP `http://127.0.0.1:47312` | **Phương án USB** (ổn định nhất, không phụ thuộc Wi-Fi) và máy ảo | cáp USB + `adb reverse` (mục 3) |
| `C:\PIS\Design\MachVon_DPM_debug_LAN.apk` | `http://172.20.10.5:47311` (API), IdP `http://172.20.10.5:47312` | **Phương án Wi-Fi** (điện thoại và laptop cùng mạng "iPhone của Trung") | 2 bộ chuyển tiếp LAN trên 172.20.10.5:47311 và :47312 đang chạy (mục 4) |

Cả hai là bản `debug`, có sẵn thư viện cho arm64-v8a, armeabi-v7a và x86_64, nên cài được trên điện thoại thật lẫn máy ảo. Phiên bản debug chỉ cho phép http với địa chỉ loopback; bản LAN có vá riêng (mục 7).

Hai bản cùng tên gói `vn.machvon.app`: cài bản này sẽ ghi đè bản kia (dùng `adb install -r`, rồi `pm clear` để đăng nhập lại từ đầu).

## 2. Chuẩn bị chung (một lần)

PowerShell:

```powershell
$adb = "C:\Android\sdk\platform-tools\adb.exe"
& $adb devices -l          # phải thấy 356660110224186 ở trạng thái "device" (bật Gỡ lỗi USB, chấp nhận khoá RSA)
```

Kiểm tra stack demo còn sống (đọc, không thay đổi gì):

```powershell
curl.exe -s http://127.0.0.1:47312/realms/machvon/.well-known/openid-configuration   # phải trả JSON, có "issuer":"http://127.0.0.1:47312/realms/machvon"
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:47311/                        # trả 404 là bình thường (API sống)
```

## 3. PHƯƠNG ÁN A: điện thoại Android thật qua USB (khuyến nghị, đã chạy được)

```powershell
$adb = "C:\Android\sdk\platform-tools\adb.exe"; $p = "356660110224186"
& $adb -s $p reverse tcp:47311 tcp:47311        # điện thoại gọi 127.0.0.1:47311 là tới API của laptop
& $adb -s $p reverse tcp:47312 tcp:47312        # 127.0.0.1:47312 là tới IdP thử của laptop
& $adb -s $p reverse --list                     # phải thấy hai dòng UsbFfs
& $adb -s $p install -r C:\PIS\Design\MachVon_DPM_debug.apk
& $adb -s $p shell pm clear vn.machvon.app      # đăng nhập lại từ đầu (tuỳ chọn)
& $adb -s $p shell monkey -p vn.machvon.app -c android.intent.category.LAUNCHER 1
```

LƯU Ý QUAN TRỌNG: **`adb reverse` mất khi rút/cắm lại cáp USB hoặc khi adb khởi động lại** (đã gặp hai lần khi thử). App hiện "Không kết nối được máy chủ" thì chạy lại hai lệnh `reverse` ở trên. Giữ cáp cắm suốt buổi demo.

Đăng nhập (IdP thử không có ô mật khẩu, tự đăng nhập người đã chọn):

1. Mở app, bấm **Đăng nhập bằng SSO** (nút xanh).
2. Màn **Chọn đơn vị và vai trò**: chọn **Đạm Phú Mỹ**, bấm **Tiếp tục**. (Hà Giang và Lào Cai là đơn vị khác của cùng tài khoản; đừng chọn.)
3. Màn **Xác thực hai yếu tố**: bấm **Xác thực trong trình duyệt**. IdP thử cấp mức aal2 ngay, không hỏi mã.
4. Vào **Trang chủ điều hành**. Muốn tiếng Việt: tab **Cá nhân**, mục **Ngôn ngữ**, chọn **Tiếng Việt** (điện thoại đặt tiếng Anh thì app mặc định tiếng Anh).

Người đăng nhập: **mặc định là người đầu tiên của danh sách thử = `owner` (Nguyễn Văn An, chủ tenant)**; đây là người đã kiểm chứng. IdP thử không có form chọn người; nó đọc tên người từ một tệp cạnh tệp thông tin của stack.

Muốn đăng nhập là lãnh đạo `capApprover` (Trần Thị Bích, vai trò LANH_DAO_SO và LEADER, duyệt kế hoạch vốn): TRƯỚC khi bấm SSO, ghi tên vào tệp (tệp này chỉ ảnh hưởng đăng nhập từ app di động, web dùng `?devUser=` nên không bị ảnh hưởng):

```powershell
Set-Content -NoNewline -Encoding ascii "$env:TEMP\machvon-demo\stack-info.json.user" "capApprover"
# quay lại người mặc định: Remove-Item "$env:TEMP\machvon-demo\stack-info.json.user"
```

Rồi trong app: tab Cá nhân, Thiết bị và đăng xuất, đăng xuất; mở lại và bấm SSO. **Chưa thử `capApprover` trên điện thoại** (tôi không sửa tệp này vì nó nằm ở thư mục của stack demo đang chạy); thử trước 14:30 một lần nếu cần vai trò lãnh đạo.

## 4. PHƯƠNG ÁN B: điện thoại Android thật qua Wi-Fi (đã chạy được, không cần cáp)

Điều kiện: điện thoại nối Wi-Fi "iPhone của Trung" (hiện là 172.20.10.2), laptop 172.20.10.5, hai bộ chuyển tiếp TCP chạy sẵn (`scratchpad\lan-proxy.cjs <lanIp> <cổng nghe> <cổng đích>`): 172.20.10.5:47311 vào 47311 và 172.20.10.5:47312 vào 47312. Đã đo: từ điện thoại nối tới 172.20.10.5:47311 được (API trả `400 Bad Request` cho yêu cầu không hợp lệ, tức là có kết nối).

```powershell
$adb = "C:\Android\sdk\platform-tools\adb.exe"; $p = "356660110224186"
& $adb -s $p reverse --remove-all                # bỏ reverse để chắc chắn đang đi bằng Wi-Fi
& $adb -s $p install -r C:\PIS\Design\MachVon_DPM_debug_LAN.apk
& $adb -s $p shell pm clear vn.machvon.app
& $adb -s $p shell monkey -p vn.machvon.app -c android.intent.category.LAUNCHER 1
```

Đăng nhập y hệt mục 3 (SSO, Đạm Phú Mỹ, Xác thực trong trình duyệt). Đã chạy: tới Trang chủ điều hành khi KHÔNG có `adb reverse`. Rủi ro: nếu điểm phát sóng cấp IP khác cho laptop (khác 172.20.10.5) thì APK LAN không dùng được (địa chỉ nằm cứng trong APK); khi đó dùng phương án A hoặc build lại (mục 7).

## 5. PHƯƠNG ÁN C: máy ảo Android trên laptop (dự phòng, chưa thử với app)

Máy ảo `Medium_Phone_API_36.1` (Android 16, x86_64, 1080x2400, tăng tốc WHPX) có sẵn. Đã khởi động và chạy tới khi adb báo `device` bình thường (khoảng 1 phút); chưa cài app lên máy ảo này. Lưu ý: khởi động mặc định bị crash (mã 139) khi nạp snapshot `default_boot`, phải dùng `-no-snapshot`.

```powershell
$env:ANDROID_SDK_ROOT = "C:\Android\sdk"; $env:ANDROID_HOME = "C:\Android\sdk"
Start-Process "C:\Android\sdk\emulator\emulator.exe" -ArgumentList "-avd","Medium_Phone_API_36.1","-no-snapshot","-gpu","auto"
# chờ ~60 giây tới khi: & $adb -s emulator-5554 shell getprop sys.boot_completed   in ra 1
& $adb -s emulator-5554 reverse tcp:47311 tcp:47311
& $adb -s emulator-5554 reverse tcp:47312 tcp:47312
& $adb -s emulator-5554 install -r C:\PIS\Design\MachVon_DPM_debug.apk       # bản USB/loopback cũng dùng cho máy ảo
& $adb -s emulator-5554 shell monkey -p vn.machvon.app -c android.intent.category.LAUNCHER 1
```

Khi máy ảo và điện thoại cùng cắm, luôn thêm `-s <serial>` cho mọi lệnh adb. Tắt máy ảo: `& $adb -s emulator-5554 emu kill`. Cửa sổ máy ảo lần trước báo vị trí ngoài màn hình (ptDst=(675,-855)): nếu không thấy cửa sổ, kéo bằng Win+phím mũi tên hoặc bấm vào biểu tượng trên thanh tác vụ.

## 6. Các màn hình đã kiểm chứng trên điện thoại thật (ảnh ở `...\scratchpad\flutter\`)

| Màn hình | Kết quả |
|---|---|
| Đăng nhập SSO, chọn đơn vị, 2 yếu tố | đạt (cả USB và Wi-Fi) |
| Trang chủ điều hành (10 dự án; Khẩn 3, Cần xử lý 43, Theo dõi 9; thẻ "Chỉ đạo quá hạn GB-2026-001/CD-01") | đạt; ảnh `p06.png`, `p12_home_vi.png`, `l03.png` |
| Thông báo (1 việc khẩn là chỉ đạo quá hạn) | đạt; `p10_notif.png` |
| Dự án (12 dự án, Kế hoạch vốn, Vướng mắc theo tuần, ...) | đạt; `p11_projects.png` |
| Cá nhân (tên Nguyễn Văn An, đổi ngôn ngữ, ủy quyền, sổ chỉ tiêu...) | đạt; `p07_profile.png`, `l04_vi.png` |
| Phê duyệt | **mở được nhưng KHÔNG chụp được màn hình**: app đặt cờ bảo mật (FLAG_SECURE) cho màn này. Nếu chiếu điện thoại lên máy chiếu bằng scrcpy hoặc ghi hình thì tab Phê duyệt sẽ đen. Đây là thiết kế của app, không phải lỗi. |

Chưa đi sâu vào chi tiết từng chỉ đạo/kế hoạch vốn; chưa chạy thử thao tác ghi (duyệt, ký). Màn Phê duyệt chưa được xem nội dung.

## 7. Cách build lại và bản vá đã dùng (KHÔNG nằm trong C:\PIS)

Mã nguồn và gói trong `C:\PIS` không bị sửa. Máy này có Flutter 3.44.6 (Dart 3.12.2) nhưng `apps/mobile/pubspec.yaml` đòi Flutter >=3.47 (Dart ^3.13). Không nâng Flutter, nên bản build dùng **bản sao** ở `%TEMP%\machvon-flutter-demo` (gồm `apps\mobile`, `packages\mobile-api-client`, `packages\mobile-tokens`) với hai thay đổi nền: hạ ràng buộc SDK xuống 3.12/3.44, bỏ `dev_dependencies` (flutter_test), hạ `sqlite3` về `^3.5.2` để `flutter pub get` giải được trên Flutter 3.44.6. Build debug chạy được; chưa chạy bộ kiểm thử đơn vị (không cần cho APK).

Lưu ý môi trường (đã xử lý trên máy này): Gradle tự tải Android SDK Platform 37 vào `C:\Android\sdk\platforms\android-37.0` nhưng AGP tìm `android-37`, nên đã tạo junction `C:\Android\sdk\platforms\android-37` trỏ tới `android-37.0`. Nếu build báo "Failed to find target with hash string 'android-37'": `cmd /c mklink /J C:\Android\sdk\platforms\android-37 C:\Android\sdk\platforms\android-37.0`. Lần build đầu mất khoảng 13 phút (tải phụ thuộc qua mạng chậm), các lần sau 1 đến 8 phút.

Lệnh build (từ thư mục bản sao `apps\mobile`; một lần build tại một thời điểm, Gradle ăn nhiều RAM):

```powershell
# APK USB / máy ảo (loopback)
flutter build apk --debug --dart-define=MACHVON_API_BASE_URL=http://127.0.0.1:47311 --dart-define=MACHVON_EDITION=enterprise --dart-define=MACHVON_OIDC_ISSUER=http://127.0.0.1:47312/realms/machvon --dart-define=MACHVON_OIDC_CLIENT_ID=machvon-web
# APK Wi-Fi (cần bản vá LAN bên dưới)
flutter build apk --debug --dart-define=MACHVON_API_BASE_URL=http://172.20.10.5:47311 --dart-define=MACHVON_EDITION=enterprise --dart-define=MACHVON_OIDC_ISSUER=http://172.20.10.5:47312/realms/machvon --dart-define=MACHVON_OIDC_CLIENT_ID=machvon-web
# kết quả: build\app\outputs\flutter-apk\app-debug.apk
```

Điểm đáng chú ý: đăng nhập di động cần `MACHVON_OIDC_ISSUER` và `MACHVON_OIDC_CLIENT_ID` (client id của IdP thử là `machvon-web`), nếu thiếu thì app đi đường "tìm tổ chức".

**Bản vá chỉ dành cho bản LAN** (đầy đủ tại `C:\PIS\Design\flutter_demo_patch.diff`, gồm cả phần hạ SDK ở trên). Lý do: IdP thử tự xưng là `http://127.0.0.1:47312` trong tài liệu discovery và trong id_token, còn điện thoại gọi nó bằng 172.20.10.5; app so khớp chặt nên phải chuẩn hoá hai địa chỉ về một. Tóm tắt:

1. `lib/app/app_config.dart`, `lib/features/session/auth/oidc_client.dart`, `lib/features/document_signing/document_fetcher.dart`: thêm `'172.20.10.5'` vào danh sách host loopback được phép dùng http (chỉ bản debug).
2. `oidc_client.dart`: thêm `_demoCanon()` đổi `//172.20.10.5:` thành `//127.0.0.1:` rồi so sánh, dùng ở 3 chỗ: `issuer` trong discovery, tham số `iss` trên đường chuyển hướng về app, và claim `iss` của id_token; `_endpointUri` thay host 127.0.0.1 trong các endpoint do IdP công bố bằng host/cổng của issuer đã cấu hình.
3. `android/app/src/debug/AndroidManifest.xml`: `android:usesCleartextTraffic="true"` (chỉ debug) để cho phép http tới laptop.

Chỉ dùng cho demo trên mạng tin cậy; không đưa vào bản phát hành.

## 8. Trỏ vào cổng khác (stack thử 47400/47401)

Địa chỉ nằm cứng trong APK, nên mỗi cặp cổng một APK. APK trong thư mục này trỏ vào demo thật **47311/47312**. Muốn trỏ stack thử 47400/47401: build lại với `MACHVON_API_BASE_URL=http://127.0.0.1:47400` và `MACHVON_OIDC_ISSUER=http://127.0.0.1:47401/realms/machvon` (rồi `adb reverse tcp:47400 tcp:47400` và `tcp:47401 tcp:47401`). Không thể dùng `adb reverse tcp:47311 tcp:47400` để đánh lừa app, vì IdP tự xưng đúng cổng của nó (47401) trong tài liệu discovery. Đã dùng thẳng demo thật 47311/47312 cho phần kiểm thử (chỉ đăng nhập và đọc các màn hình).

## 9. Khi có sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| Bấm SSO báo lỗi không kết nối / quay mãi | USB: chạy lại hai lệnh `adb reverse` (mục 3). Wi-Fi: kiểm tra `curl.exe http://172.20.10.5:47311/` từ laptop trả 404 và bộ chuyển tiếp còn chạy (`netstat -ano | findstr 172.20.10.5`). |
| `adb devices` không thấy máy, hoặc "device offline" / "closed" | Rút cắm cáp, chấp nhận hộp thoại RSA trên điện thoại, `adb kill-server` rồi `adb start-server`, rồi làm lại `reverse`. |
| Lệnh adb báo "more than one device" | Thêm `-s 356660110224186` (hoặc `-s emulator-5554`). |
| Trình duyệt Chrome hiện ra hỏi tài khoản hoặc thông báo ở lần đầu | Bấm "Use without an account" / "No thanks"; đó là Chrome, không phải app. |
| Màn Phê duyệt chụp/chiếu bị đen | Do cờ bảo mật của app; thao tác trực tiếp trên điện thoại, đừng ghi hình màn này. |
| "Cổng bị chặn" / đăng nhập quay về màn đầu | Gỡ app dữ liệu cũ: `adb -s <serial> shell pm clear vn.machvon.app`, mở lại và đăng nhập lại. |
| App báo lỗi ngay khi mở (CONFIG) | APK không được build với đủ `--dart-define`; dùng đúng hai file APK trong `C:\PIS\Design`. |
| Muốn xem nhật ký | `adb -s <serial> logcat -d -v brief | findstr /i "flutter machvon"` |
| Điện thoại sập nguồn/khoá màn hình giữa buổi | Mở khoá, giữ app ở nền; phiên đăng nhập còn lưu. Bật "Giữ màn hình sáng" trong Tuỳ chọn nhà phát triển. |

## 10. Những gì CHƯA làm hoặc chưa chắc

- Bản iOS: không thể trên Windows.
- Máy ảo chưa cài và chạy app (chỉ kiểm tra máy ảo khởi động được).
- Đăng nhập với `capApprover` chưa thử (mặc định là `owner`, đã thử).
- Màn Phê duyệt không chụp được nên chưa xem nội dung; chưa thử các thao tác ghi.
- Flutter 3.44.6 thay vì 3.47.7 chính thức (hạ phụ thuộc `sqlite3` về 3.5.2): app chạy bình thường trong thử nghiệm, nhưng không được kiểm thử bằng bộ test của dự án.
