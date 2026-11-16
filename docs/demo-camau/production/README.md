# Bản demo trên máy chủ: ảnh chụp và kết quả kiểm (2026-11-16)

Máy chủ: `https://180-93-34-176.sslip.io:8443`, bản phát hành **1.0.8**, tenant "UBND tỉnh Cà Mau", bộ dữ liệu `camau`.
Tên sản phẩm trên màn hình vẫn là "Hệ thống quản lý đầu tư công"; chỉ dữ liệu là của Cà Mau.
Cách nạp và xóa dữ liệu: `docs/runbooks/demo-data-camau.md` (mục 4, 5 và 8).

## Ảnh chụp

Mọi ảnh trong thư mục này chụp từ máy chủ bằng Playwright, đăng nhập thật qua trang đăng nhập của hệ thống.

| Tệp | Nội dung | Chụp bằng |
|---|---|---|
| `01` … `17` | 17 màn hình có dữ liệu Cà Mau: tổng quan điều hành, việc của tôi, cảnh báo sớm, danh sách dự án, kế hoạch vốn năm, nguồn vốn, giải ngân, gói thầu, nhà thầu, hợp đồng, thanh toán, bảng deadline, bảng điểm đơn vị, cây tổ chức, văn bản đi, theo dõi phê duyệt, bàn chỉ đạo | `../capture-production.mjs` |
| `login-01`, `login-02` | trang đăng nhập tiếng Việt với trình duyệt tiếng Anh; trang chủ sau khi đăng nhập (một tổ chức thì không hỏi chọn) | `../login-ux-check.mjs` |
| `login-03`, `login-04` | phiên của nhà cung cấp danh tính đã chết: trang báo lỗi có nút "Đăng nhập lại", bấm vào thì ra form tên đăng nhập và mật khẩu | `../login-ux-check.mjs` |
| `session-01` … `session-04` | vai trò cao nhất dưới tên người, nút "Đăng xuất", trang "Bạn đã đăng xuất", form đăng nhập sau đó, `lanhdao` đăng nhập trong cùng trình duyệt | `../session-check.mjs` |
| `session-05`, `session-06` | tài khoản bị xóa trong khi trình duyệt còn cookie: kết thúc ở form đăng nhập, không kẹt ở trang lỗi | `../session-check.mjs` |

Chạy lại (mật khẩu đọc từ máy chủ qua ống dẫn, không nằm trong lệnh):

```
ssh -i <khóa> Administrator@<máy chủ> "type C:\ProgramData\MACHVON\secrets\admin\demo-credentials.json" | node docs/demo-camau/capture-production.mjs
```

Ảnh điện thoại (`mobile/`): **chưa có**. Xem mục "Chưa kiểm".

## Bộ dữ liệu

`clip-seed verify` chạy lại sau lượt UAT, 07:00 ngày 2026-11-16: 54 kiểm tra, 53 đạt, 1 chưa đạt.

- "tạm ứng quá hạn thu hồi" tự đạt sau việc nền 06:00, đúng như dự đoán trong runbook mục 8.8.
- "luồng phê duyệt trễ hạn: 0" là kiểm tra duy nhất còn đỏ: hạn của bước phê duyệt tính từ lúc bước được mở thật, bản cài không có cách chính thức để lùi thời gian.
  Với `--tolerate "workflows late"` lệnh kết thúc bằng mã 0 ("54 checks, 1 tolerated by name").

Lượt UAT không làm thay đổi dữ liệu (chỉ mở màn hình; monkey chạy bằng tài khoản chỉ xem), nên không phải xóa và nạp lại.

## UAT trên bản demo (kỹ năng `uat-test-only`, chỉ báo cáo)

Báo cáo: `uat/run/uat-2026-11-16-production-demo/report.md`, khối kết luận: `verdict.txt` cùng thư mục.

```
VERDICT: FAIL
KẾT LUẬN: NO-GO
TỔNG: 1199 | PASS: 258 | FAIL: 3 | KHÔNG CHẠY: 938
```

NO-GO ở đây là do **độ phủ**, không phải do số ca hỏng: 261 trong 1199 ca chạy được trên bản demo (21,8 %, cổng G3 đòi 95 %).

| Nhóm | Số ca | Kết quả |
|---|---|---|
| hợp đồng màn hình (mở được, không lỗi script, không tràn ngang, control có nhãn) | 261 | 258 đạt, 3 hỏng |
| ca web cần kịch bản và dữ liệu dựng riêng của bộ e2e, hoặc có thao tác ghi/xóa (không chạy để giữ dữ liệu demo) | 640 | KHÔNG CHẠY (`khong-co-kich-ban`) |
| ca API cần dữ liệu của stack e2e | 218 | KHÔNG CHẠY (`can-du-lieu-stack-e2e`) |
| ca mobile | 80 | KHÔNG CHẠY (`ngoai-thiet-bi`) |

Ba ca hỏng:

| Ca | Màn hình | Thực tế | Tái hiện |
|---|---|---|---|
| `TC-UI-BI-02` | Dashboard của tôi | trang tràn ngang 6 px ở khung 1280 | 2/2, cũng hỏng ở lượt 2 |
| `TC-UI-CTR-11` | Kiểm tra chất lượng và NCR | quá 60 giây | 1/2, chạy lại thì đạt |
| `TC-UI-LLM-09` | Chi tiết usage và đối soát | màn hình không hiện trong 45 giây | 1/2, chạy lại thì đạt |

Ở lượt 2 (vô hiệu, xem dưới) hai ca hỏng một lần là `TC-UI-IAM-04` và `TC-UI-NOT-09`, lượt 3 chúng đạt. Tức là mỗi lượt có hai màn hình bất kỳ không mở kịp một lần;
máy chạy kiểm lúc ấy thiếu bộ nhớ, nên chưa kết luận được đó là lỗi của sản phẩm hay của máy kiểm. Chỉ `TC-UI-BI-02` là hỏng ổn định.

Các cổng khác:

- Chứng âm (G11): ba mệnh đề cố ý sai đều đỏ. Rào không-sửa (G9): sạch. Bằng chứng (G12): 258 ca đạt đều có trace, ảnh, video.
- Monkey (G8), hạt giống cố định, giới hạn 150 thao tác hoặc 180 giây: chưa đăng nhập 124 thao tác, 0 bất thường; tài khoản `nhanvien` 123 thao tác, 0 lỗi chặn,
  6 ghi nhận mức S3 đều là "403" trong console khi tài khoản chỉ xem mở màn hình ngoài quyền. Monkey Android không chạy.
- Khả năng tiếp cận (G16): báo cáo ghi ĐẠT nhưng **con số ấy không đo các màn hình**. Công cụ quét của kỹ năng mở từng địa chỉ rồi quét ngay; ứng dụng giữ phiên trong bộ nhớ nên
  nó quét 262 lần tấm thẻ "Đăng nhập". Kết quả đo bổ sung trên chính các màn hình (ngoài cổng) ở mục dưới.
- Hiệu năng (G17): ca duy nhất có ngân sách (`TC-UAT-PWF-PERF-01`, 1.000 dự án x 200 việc) cần dữ liệu của stack e2e, không đo. Đo theo `docs/qa/perf-budget.json`
  bằng `scripts/perf-budget.mjs --token-command` (20 mẫu mỗi thao tác): 89 thao tác, 77 trong ngân sách, 11 không đo (thiếu biến như mã báo cáo),
  1 hỏng: `PB-R017 exportStaffScorePeriod` trả 422 ở cả 20 mẫu (thời gian 74 ms, tức là lời gọi bị từ chối chứ không chậm). p95 của 78 thao tác đo được: từ 39 ms đến 231 ms, riêng hai thao tác khoảng 1,5 giây; tất cả dưới ngân sách của chúng.
- Ma trận quyền/IDOR (G14) và dữ liệu/audit/idempotency (G15): không đo được trên bản demo.

### Ba lượt chạy

| Thư mục | Chuyện gì |
|---|---|
| `uat-2026-11-16-production-demo-attempt1` | dừng ngay ở bước đăng nhập: kịch bản chờ một tiêu đề `main h1` mà giao diện không có. Kịch bản đã đóng băng không được sửa, nên phải mở lượt mới. Không ca nào chạy. |
| `uat-2026-11-16-production-demo-attempt2` | chạy hết nhưng **BÁO CÁO VÔ HIỆU**, do hai lỗi của chính người chạy: bước chạy lại các ca hỏng đã xóa thư mục bằng chứng của lượt chính, và ba ảnh màn hình trong `docs/` được chụp lại khi rào đang bật. |
| `uat-2026-11-16-production-demo` | lượt 3, hợp lệ: bước chạy lại ghi bằng chứng vào thư mục riêng, cây mã sạch suốt lượt. Số liệu ở trên là của lượt này. |

### Đo bổ sung khả năng tiếp cận trên màn hình đã đăng nhập

Cùng bộ luật axe (WCAG 2.0/2.1/2.2 mức A và AA), nhưng đăng nhập bằng `demo` rồi mới quét từng màn hình: `../a11y-signed-in.mjs`, kết quả thô ở `a11y-signed-in.json`.
Đây là số đo ngoài các cổng của báo cáo UAT, không đổi kết luận của nó.

Quét được 261/261 màn hình: 247 không có vi phạm, 14 có vi phạm mức "serious", không có mức "critical".

| Luật | Số màn hình | Màn hình (số phần tử) |
|---|---|---|
| `color-contrast` | 7 | ADM-07 (24), CAP-10 (108), CTR-04 (1), DIS-12 (1), DIS-15 (1), PAY-01 (1), PAY-07 (1) |
| `scrollable-region-focusable` | 3 | CAP-10 (1), NOT-05 (1), PRJ-13 (1) |
| `target-size` | 3 | DGV-04 (2), HOME-05 (11), MDM-02 (3) |
| `label-content-name-mismatch` | 2 | ADM-07 (108), BI-05 (4) |
| `definition-list` | 1 | CAP-03 (1) |

`IAM-04` (chọn tổ chức) chuyển thẳng về trang chủ vì tài khoản chỉ có một tổ chức, nên ở địa chỉ ấy thứ được quét là trang chủ.
axe chỉ bắt được một phần lỗi tiếp cận; con số này không phải là tuyên bố tuân thủ WCAG 2.2 AA.

## Chưa kiểm

- **Ứng dụng điện thoại.** APK `PIS-dau-tu-cong-180-93-34-176-profile.apk` (dựng 00:16 ngày 2026-11-16, sau commit cuối cùng chạm `apps/mobile`) cài được trên máy ảo "guide",
  mở ra màn hình đăng nhập tiếng Việt và trang đăng nhập của hệ thống hiện đúng trong trình duyệt của máy. Chưa đi tới màn hình sau đăng nhập: máy ảo bị dừng vì máy dựng hết bộ nhớ.
  Chưa có ảnh điện thoại nào trong `mobile/`. Đăng xuất trên điện thoại chưa kiểm.
- `restore` từ bản sao lưu của `demo-reset` chưa chạy thử.
- Nút tải tệp của văn bản DOC: đường tải trong API vẫn là `mock://`.
- Luồng phê duyệt trễ hạn chỉ xuất hiện khi thời hạn thật trôi qua.
