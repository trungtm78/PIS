# Demo bản enterprise: Phần mềm quản lý đầu tư xây dựng (Mạch Vốn) cho Đạm Phú Mỹ / PVFCCo

Tài liệu này dành cho người trình diễn. Máy demo là một máy Windows 11 sạch, dựng từ mã nguồn git. Không cần Docker, không cần cài PostgreSQL: cơ sở dữ liệu là PostgreSQL nhúng, tự khởi động cùng ứng dụng và bị xóa khi tắt.
Toàn bộ số liệu là DỮ LIỆU MINH HỌA, không phải số liệu thật của khách hàng.

## 1. Chuẩn bị máy (làm một lần, cần Internet)

| Thứ cần | Ghi chú |
|---|---|
| Windows 10/11 64-bit | Dùng tài khoản thường, KHÔNG cần quyền Administrator. |
| RAM | Tối thiểu 8 GB trống khi chạy (khuyến nghị máy 16 GB). Đóng bớt Chrome nhiều tab, IDE, máy ảo trước khi chạy. |
| Ổ đĩa | Còn trống khoảng 5 GB (thư viện npm, PostgreSQL nhúng, dữ liệu tạm). |
| Node.js | Bản 24 trở lên (yêu cầu `"engines": {"node": ">=24"}` trong `package.json`). Tải bản LTS mới tại nodejs.org, kiểm tra `node -v` ra `v24.x`. Kèm `npm`. |
| Git | git-scm.com (hoặc nhận mã nguồn dưới dạng file `.zip`/`git bundle`). |
| Google Chrome | Trình duyệt trình diễn. Bản thường, bản mới. |
| Docker | KHÔNG cần (PostgreSQL nhúng đi kèm gói `embedded-postgres` do `npm ci` tải về). |

Lấy mã nguồn, ví dụ vào thư mục ngắn để tránh lỗi đường dẫn dài của Windows:

```
cd C:\
git clone https://github.com/trungtm78/PIS.git machvon
cd machvon
git checkout <nhánh hoặc thẻ do đội phát triển bàn giao>
npm ci
```

Nếu nhận gói `git bundle`: `git clone machvon.bundle machvon`. Nếu nhận file `.zip`: giải nén vào `C:\machvon` rồi chạy `npm ci`.
`npm ci` mất vài phút và tải cả bản PostgreSQL nhúng cho Windows (`@embedded-postgres/windows-x64`), nên PHẢI có Internet ở bước này. Sau đó máy chạy demo không cần Internet.

Kiểm tra nhanh sau khi cài: `node scripts/demo-enterprise.mjs --dry-run` in ra các bước và địa chỉ đăng nhập mà chưa khởi động gì.

## 2. Chạy demo bằng một lệnh

```
cd C:\machvon
npm run demo:enterprise
```

Lệnh này (file `scripts/demo-enterprise.mjs`) làm theo thứ tự:

1. Kiểm tra Node, thư viện đã cài, các cổng 5173 (web), 47311 (API), 47312 (đăng nhập thử) còn trống; nếu bận thì dừng và nói rõ cổng nào, cách xử lý.
2. Khởi động API + PostgreSQL nhúng: chính là `npm run e2e:stack -w @machvon/api` (đúng bộ khung đã dùng cho các bài kiểm thử trình duyệt), với `MACHVON_EDITION=enterprise`, `E2E_SEED=docs`, `DEMO_FORMS=true`.
3. Nạp bộ dữ liệu mẫu Đạm Phú Mỹ: chính là `node scripts/clip-seed.mjs apply --dataset enterprise` (xem `docs/clip-data.md`). Chạy một lần mỗi lần khởi động, mất khoảng 2 đến 5 phút. Trong thời gian này màn hình in tiến độ từng pha; đừng đóng cửa sổ.
4. Khởi động web (Vite, `VITE_EDITION=enterprise`) và chờ đến khi trang trả lời.
5. In ra khung chữ SAN SANG cùng địa chỉ mở bằng Chrome và danh sách người dùng demo.

Tổng cộng 4 đến 8 phút ở lần chạy đầu. Hãy khởi động trước giờ demo ít nhất 15 phút và để cửa sổ dòng lệnh chạy suốt buổi.
Dừng: bấm Ctrl+C trong cửa sổ đó. Lệnh tự dừng web, API, PostgreSQL nhúng và xóa thư mục tạm. Mỗi lần khởi động là một cơ sở dữ liệu mới và nạp lại dữ liệu mẫu (cùng một hạt giống nên cùng số liệu, ngày tháng tính theo ngày chạy).

Tùy chọn: `npm run demo:enterprise -- --open` (tự mở Chrome), `--web-port 5200 --api-port 47400 --idp-port 47401` (đổi cổng), `--no-seed` (bỏ nạp dữ liệu, chỉ để thử nhanh), `--dry-run`, `--help`.

Vì sao web chạy bằng `vite dev` chứ không phải bản build + preview: đăng nhập của người dùng demo là "phiên phát triển" (`?devUser=`), chỉ có trong bản dev; bản build production không có phiên này và sẽ đòi hệ thống đăng nhập thật (OIDC). Đây cũng chính là cách các bài kiểm thử trình duyệt và các clip đã chạy.

## 3. Đăng nhập và các vai trò

Không có mật khẩu: đăng nhập bằng cách mở địa chỉ có `?devUser=<khóa>`. Ví dụ lãnh đạo xem Trung tâm điều hành: `http://127.0.0.1:5173/home/home-09?devUser=owner`.
LƯU Ý: nếu bấm F5 hoặc gõ lại địa chỉ, phải giữ `?devUser=...` ở cuối; thiếu nó phiên quay về người dùng mặc định và hầu hết màn hình báo không có quyền. Trong khi bấm chuyển trang trong ứng dụng thì phiên giữ nguyên.
Đổi vai trò: sửa giá trị `devUser` trên thanh địa chỉ rồi Enter.

| `devUser` | Người (minh họa) | Vai trò | Dùng để cho xem |
|---|---|---|---|
| `owner` | Nguyễn Văn An | Chủ tenant (TENANT_OWNER), là "người thứ hai" của mọi cặp lập / duyệt | Trung tâm điều hành HOME-09, cơ cấu vốn HOME-07, giao ban và chỉ đạo DIR, nhà thầu, cảnh báo, trình chiếu. Vai trò mặc định để mở demo. |
| `capApprover` | Trần Thị Bích | Lãnh đạo (LANH_DAO_SO + LEADER) | Duyệt kế hoạch vốn CAP, kỳ báo cáo và khóa số liệu DIS, ký duyệt báo cáo. |
| `projectManager` | Phạm Quốc Dũng | Cán bộ ban quản lý dự án | Dự án PRJ, mua sắm thiết bị EQP, hồ sơ dự án DOC, trợ lý AI LLM. |
| `docHead` | Trần Văn Hùng | Trưởng phòng soạn thảo (COMMITTEE_HEAD) | Biểu mẫu báo cáo RPT-01 đến RPT-03, so sánh chéo RPT-09. KHÔNG vào được màn hình đẩy HPM (HPM-01, HPM-02): dùng `owner` cho phần HPM. |
| `unitAdmin` | Lê Minh Cường | Quản trị đơn vị | Quản trị đơn vị, lịch nhắc, thành viên. |
| `treasuryMaker` | Hoàng Thị Lan | Kế toán | Thanh toán, đối chiếu kế toán. |
| `auditor` | Vũ Đức Minh | Kiểm toán | Chỉ đọc, nhật ký kiểm toán. |
| `nobody` | Đỗ Thị Hà | Thành viên thường | Quyền tối thiểu: minh họa màn hình "không có quyền". |

Bộ người dùng lấy từ `apps/web/e2e/support/docs-people.json` (tên) và `apps/web/e2e/support/e2e-fixtures.json` (tài khoản nền). Các vai trò khác trong bộ clip (ví dụ `mneAdmin`, `dgvSteward`, `sysAdmin`) KHÔNG có trong bộ khung demo này; mọi kịch bản dưới đây dùng 4 vai trò đầu bảng.

## 4. Kịch bản demo 15 bước cho lãnh đạo Đạm Phú Mỹ (khoảng 25 phút)

Mở Chrome toàn màn hình, thu nhỏ chữ nếu cần (Ctrl và dấu trừ). Mã màn hình (ví dụ HOME-09) hiện ở đầu trang. Câu nói gợi ý để tham khảo, tự điều chỉnh theo khán giả.

| # | Vai trò | Địa chỉ (sau `127.0.0.1:5173`) | Làm gì và nói gì |
|---|---|---|---|
| 1 | `owner` | `/home/home-09?devUser=owner` | Trung tâm điều hành (HOME-09). Chỉ dải số liệu chính và khung "tỷ lệ so với kế hoạch năm theo công ty, đơn vị, dự án" (khung dành riêng cho bản enterprise). Nói: "Lãnh đạo thấy ngay đâu đang chậm, đâu đang bị chặn." |
| 2 | `owner` | `/home/home-07` | Cơ cấu các nguồn vốn (HOME-07): vốn chủ sở hữu và vốn vay, so sánh số ước với số thực. Nói về hai loại vốn của doanh nghiệp, không phải ngân sách tỉnh. |
| 3 | `capApprover` | `/cap/cap-03`, `/cap/cap-07`, `/cap/cap-12` | Kế hoạch vốn năm, điều chỉnh và điều chuyển giữa các phiên bản, kế hoạch ước giải ngân. Có thể bấm so sánh phiên bản. |
| 4 | `projectManager` | `/prj/prj-01`, `/prj/prj-14`, `/prj/prj-15` | 12 dự án (6 đầu tư xây dựng, 6 mua sắm thiết bị) ở các giai đoạn: danh sách, cổng giai đoạn (ngân hàng dự án và vòng đời), chấm điểm thẩm định. Mở một dự án để xem hồ sơ. |
| 5 | `docHead` | `/rpt/rpt-01?devUser=docHead` | Báo cáo gửi Tập đoàn (PVN) và HPM: danh mục sáu biểu mẫu demo (cột trạng thái, nhãn "MẪU DEMO - chờ mẫu chính thức"). Chọn một biểu mẫu, bấm lập báo cáo, xem bản xem trước. |
| 6 | `docHead` | `/rpt/rpt-02`, `/rpt/rpt-03` | Luồng kiểm tra, phê duyệt, phát hành và các bản đã phát hành (người lập khác người kiểm khác người duyệt, mỗi bản có mã băm, tên tệp theo quy tắc). |
| 7 | `docHead` | `/rpt/rpt-09` | So sánh chéo báo cáo cùng kỳ trước khi phát hành (RPT-09): phát hiện số liệu lệch giữa các biểu mẫu. |
| 8 | `owner` | `/hpm/hpm-01?devUser=owner`, `/hpm/hpm-02` | Đẩy lên HPM: nhật ký đẩy (2 lần đã đẩy), khóa chống đẩy trùng, từ chối bản cũ, đẩy lại, đính chính kỳ đã được nhận. Nói rõ: kết nối là tệp giả định, xem mục 6. |
| 9 | `owner` | `/ebs/ebs-01`, `/ebs/ebs-02` | Đối chiếu Oracle EBS theo mã dự án (khoảng 32 chênh lệch minh họa, có giải trình). Nói rõ: nhập từ tệp, chờ đặc tả chính thức của EBS, xem mục 6. |
| 10 | `owner` | `/dir/dir-01`, `/dir/dir-03`, `/dir/dir-04`, `/dir/dir-05` | Giao ban và chỉ đạo: các cuộc giao ban, bảng theo dõi chỉ đạo (có chỉ đạo quá hạn), dòng thời gian một chỉ đạo, và chỉ đạo của kỳ trở thành đầu vào báo cáo kỳ sau. |
| 11 | `projectManager` | `/eqp/eqp-01`, `/eqp/eqp-02` | Mua sắm trang thiết bị dự án: danh sách dòng mua sắm và chi tiết. Rồi gói thầu `/bid/bid-03` và kế hoạch lựa chọn nhà thầu `/bid/bid-15`. |
| 12 | `owner` | `/bid/bid-01`, `/ctr/ctr-23`, `/home/home-03` | Nhà thầu (16 nhà thầu minh họa, hồ sơ, bảng điểm vi phạm) và cảnh báo sớm HOME-03 với hồ sơ cảnh báo HOME-06. |
| 13 | `owner` | `/home/home-09`, nút "Trình chiếu" | Chế độ trình chiếu: bấm "Trình chiếu" để chạy tự động từng bảng số liệu, chữ lớn, toàn màn hình; có chọn "Tự chuyển sau". Thoát bằng "Thoát trình chiếu". Cũng có ở `/dir/dir-05` và bảng điều hành Ban chỉ đạo `/ban/ban-01`. |
| 14 | `owner` | Nút dấu hỏi "Hướng dẫn màn hình này" ở thanh trên | Ngăn trợ giúp trượt ra từ bên phải: giải thích đúng màn hình đang mở, có liên kết tới trung tâm hướng dẫn. Mở ở bất cứ màn hình nào. |
| 15 | `owner` | `/pwa/pwa-01` | Ứng dụng trên điện thoại (PWA): trang chủ ứng dụng cài đặt, thẻ "Cài đặt ứng dụng", hàng đợi phê duyệt `/pwa/pwa-02`, bảng điều hành lãnh đạo `/pwa/pwa-03`. Xem lưu ý dưới đây. |

Lưu ý về cài PWA lên điện thoại: trình duyệt chỉ cho cài khi trang chạy qua HTTPS và là bản build production có service worker. Bản demo cục bộ (`http://127.0.0.1`, vite dev) không đủ điều kiện, nên thẻ cài đặt sẽ báo "Chỉ cài đặt được khi trang chạy qua HTTPS". Ở buổi demo hãy: (a) mở các màn hình PWA trên máy tính (hoặc khung điện thoại của Chrome, F12 rồi biểu tượng điện thoại), và (b) chiếu clip điện thoại đã quay sẵn khi cần cho thấy cài thật. Đừng hứa cài thử trực tiếp trên điện thoại từ máy demo này.

Thứ tự gợi ý nếu chỉ có 10 phút: bước 1, 2, 4, 5, 7, 8, 10, 13.

## 5. Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Lệnh dừng với "Cổng đang được dùng" | Một lần chạy demo trước còn treo hoặc chương trình khác giữ cổng. Tìm: `netstat -ano \| findstr :47311`, rồi `tasklist /FI "PID eq <pid>"`. Tắt tiến trình đó, hoặc chạy với cổng khác: `npm run demo:enterprise -- --web-port 5200 --api-port 47400 --idp-port 47401`. Chỉ tắt tiến trình `node`/`postgres` do chính bạn mở. |
| "Bộ nhớ trống còn ... GB" | Đóng ứng dụng khác. PostgreSQL nhúng cần vùng nhớ chung; máy đầy RAM sẽ báo lỗi "could not create shared memory segment" (mã 1455). Chạy lại sau khi giải phóng RAM. Không cần khởi động lại máy. |
| API không lên sau vài phút | Đọc 40 dòng cuối được in ra. Nguyên nhân thường gặp: hết RAM, phần mềm diệt virus quét `postgres.exe`, thiếu `npm ci`. Chạy lại lệnh. |
| Nạp dữ liệu báo lỗi | Lệnh tự dừng mọi thứ. Chạy lại `npm run demo:enterprise` (mỗi lần là cơ sở dữ liệu mới). Nếu vẫn lỗi, báo đội phát triển kèm các dòng cuối. |
| Trang trắng hoặc "không có quyền" sau F5 | Thiếu `?devUser=...` ở địa chỉ. Gõ lại địa chỉ ở mục 3. |
| Lần mở màn hình đầu tiên hơi chậm | Vite biên dịch theo nhu cầu; mở thử các màn hình trong kịch bản một lần trước giờ demo để làm nóng. |
| Chrome không mở / không có Chrome ở đường dẫn chuẩn | Demo chỉ cần một trình duyệt bất kỳ; bản chuẩn là `C:\Program Files\Google\Chrome\Application\chrome.exe`. Tự mở Chrome rồi dán địa chỉ in ra ở khung SAN SANG. Chỉ các bài kiểm thử tự động (Playwright) mới cần đường dẫn này, bỏ qua với demo. |
| Windows Smart App Control chặn tệp chưa ký (DLL, exe) | KHÔNG cần và KHÔNG nên tắt Smart App Control. Việc này thường chỉ ảnh hưởng đến các bài kiểm thử đơn vị của ứng dụng di động (Flutter), mà demo không cần: không chạy chúng. Nếu chính `postgres.exe` của PostgreSQL nhúng bị chặn (thông báo trong Windows Security, mục Protection history), hãy nhờ bộ phận IT cho phép tệp đó hoặc dùng một máy khác; đừng thay đổi cài đặt bảo mật. |
| Muốn nạp lại dữ liệu sạch | Ctrl+C rồi chạy lại lệnh. Không có trạng thái nào lưu giữa hai lần chạy. |
| Cổng thay đổi | Địa chỉ trong mục 3 dùng cổng web mặc định 5173; nếu đổi `--web-port`, thay số tương ứng (lệnh in sẵn đúng địa chỉ). |

## 6. "MẪU DEMO" và PENDING-EXTERNAL: nói với khách hàng thế nào cho trung thực

- MẪU DEMO - chờ mẫu chính thức: sáu biểu mẫu báo cáo gửi PVN và HPM trong bản demo là mẫu do đội phát triển dựng để minh họa (bật bằng `DEMO_FORMS=true`). Mỗi bản có nhãn "MẪU DEMO - chờ mẫu chính thức". Bố cục chưa phải mẫu chính thức của Tập đoàn, nên KHÔNG bao giờ được tính là bản đã được chấp nhận chính thức. Khi khách hàng bàn giao mẫu chính thức, thay vào gói biểu mẫu là xong.
- PENDING-EXTERNAL: HPM (hệ thống nhận báo cáo của Tập đoàn), Oracle EBS (sổ kế toán) và e-GP (hệ thống đấu thầu quốc gia) hiện là bộ nối dựa trên TỆP (ghi tệp ra cho HPM, đọc tệp xuất từ EBS), vì chưa có đặc tả giao diện và tệp mẫu thật từ khách hàng. Bản demo cho thấy đúng luồng nghiệp vụ (khóa chống đẩy trùng, từ chối phiên bản cũ, đối chiếu theo mã dự án, giải trình chênh lệch), còn định dạng tệp là GIẢ ĐỊNH TẠM, chờ tài liệu chính thức của bên nhận. Màn hình e-GP chỉ có ở bản công khai, không có trong bộ dữ liệu enterprise.
- Mẫu thanh toán Kho bạc và các màn hình của bản công khai không thuộc dữ liệu enterprise; không dùng chúng trong demo này.
- Con số cấu hình pháp lý ở một số quy tắc là mặc định chưa kiểm chứng; dữ liệu cũng là minh họa. Hãy nói điều này khi được hỏi.

## 7. Kết quả chạy thử trên máy dựng (2026-11-09)

Chạy `npm run demo:enterprise` trên Windows 11, Node 24.20: API lên, nạp dữ liệu enterprise xong (có hai thông báo từ chối mà các nhóm nạp chấp nhận: xác minh chữ ký văn bản và công bố hai bảng BI; không ảnh hưởng kịch bản), web lên, `/__e2e/health` trả 200. Chrome headless (Playwright) mở được Trung tâm điều hành HOME-09 với `owner` (thương hiệu Đạm Phú Mỹ, 10 dự án, chỉ đạo quá hạn) và 21 màn hình của kịch bản tải được, 0 lỗi JavaScript. Riêng `docHead` bị từ chối ở HPM-01 và HPM-02, nên bước 8 dùng `owner`. Bước 15 (cài PWA thật) không thử được ở bản dev, xem lưu ý ở mục 4.
