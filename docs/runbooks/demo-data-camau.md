# Dữ liệu demo tỉnh Cà Mau: nạp, xóa, nạp lại

Bộ dữ liệu demo mặc định của bản công **"Hệ thống quản lý đầu tư công"** là bộ `camau` (`scripts/fixtures/clip-data/camau.json`): tenant "UBND tỉnh Cà Mau",
cây đơn vị theo tổ chức của tỉnh sau hợp nhất năm 2025, 45 dự án đầu tư công. Bộ Cao Bằng cũ (`public`) còn trong repo cho các clip và test cũ, không còn là mặc định.

**Mọi dữ liệu là MINH HỌA.** Tên đơn vị và địa danh tra theo nguồn công khai (mục 7); tên dự án, mã, tổng mức, kế hoạch vốn, giải ngân, gói thầu, nhà thầu, hợp đồng,
văn bản và **tên người** đều là dữ liệu dựng để trình diễn, **không phải số liệu thật của tỉnh Cà Mau** và không chỉ một người thật nào.
Tên sản phẩm (tên hệ thống, tên ứng dụng, tiêu đề trang) không thuộc bộ dữ liệu và không đổi theo bộ dữ liệu.

Dữ liệu được tạo **bằng chính lệnh của sản phẩm** (API thật, đúng vai, đúng luồng lập và duyệt), không ghi thẳng vào bảng nghiệp vụ. Mô tả đầy đủ lớp nạp: `docs/clip-data.md`.

## 1. Thành phần

| Thành phần | Ở đâu | Việc |
|---|---|---|
| Bộ dữ liệu | `scripts/fixtures/clip-data/camau.json` | danh mục 32 dự án đặt tên (cộng 13 dự án của các nhóm nền), địa bàn, nguồn vốn, văn bản; `tenant` (đơn vị, tên vai, tài khoản); `localize.pairs` (từ ngữ thay cho từ ngữ của bộ hướng dẫn) |
| Quyền của vai đơn vị | `scripts/fixtures/clip-data/demo-roles.json` | bản chụp `docsRoles` của stack docs (mã vai, hạng, quyền); lấy lại bằng `node scripts/demo-tenant-input.mjs --roles-from <stack-info.json>` |
| Nạp và kiểm | `scripts/clip-seed.mjs` (`plan`, `apply`, `verify`, `preflight`) | chạy các nhóm seed, đọc lại bằng API và so với kỳ vọng |
| Đăng nhập trên bản cài | `scripts/clip-seed-auth.mjs`, `scripts/onprem-api-token.mjs` | mỗi người của lớp seed đăng nhập realm bằng tài khoản riêng (authorization code + PKCE, mật khẩu, OTP), chọn tenant; token 5 phút được giữ lại và xin mới khi sắp hết |
| Tenant demo trên bản cài | `scripts/demo-tenant-input.mjs`, `infra/onprem-windows/tools/demo-tenant.mjs`, `infra/onprem-windows/host/demo-tenant.ps1` | đơn vị, vai, người dùng và membership bằng lệnh chính thức (`createOrganizationUnit`, `createCustomRole`, `inviteMember`, `acceptInvitation`, `grantRole`) |
| Xóa sạch | `infra/onprem-windows/host/demo-reset.ps1` | sao lưu rồi dựng lại cơ sở dữ liệu của sản phẩm, rỗng |
| Chạy thử trên máy phát triển | `scripts/demo-public.mjs` (`npm run demo:public`) | dựng web, stack, nạp `camau`, `verify`, mở web |

Vì các nhóm seed viết sẵn cho tỉnh của bộ hướng dẫn (bảng chữ, khóa địa bàn, mã đơn vị nằm trong mã nguồn), bộ `camau` khai các cặp từ `[từ của bộ hướng dẫn, từ của Cà Mau]`.
Mọi chuỗi tiến trình seed **gửi đi** được đổi sang từ của Cà Mau, mọi câu trả lời nó **đọc về** được đổi ngược lại, và tệp kế hoạch đưa cho nó cũng được đổi ngược trước
(`apps/web/e2e/hdsd/seed/localize.ts`, `planForSeeds`). Sản phẩm chỉ giữ từ ngữ của Cà Mau. `clip-seed plan` báo lỗi nếu một chuỗi của bộ dữ liệu không đi qua được nguyên vẹn.

## 2. Tài khoản demo

Khai trong `camau.json`, mục `tenant.accounts`. Mỗi tài khoản đứng trên một người của lớp seed (`apps/web/e2e/support/docs-people.json`); tên hiển thị là tên minh họa.

| Tên đăng nhập | Người (khóa) | Đơn vị | Vai | Dùng để |
|---|---|---|---|---|
| `demo` | Nguyễn Văn An (`owner`) | UBND tỉnh Cà Mau | `TENANT_OWNER` | **đủ mọi quyền của tenant**: xem mọi màn, duyệt, quản trị |
| `lanhdao` | Trần Thị Bích (`capApprover`) | Khối Ban quản lý dự án chuyên ngành | Lãnh đạo đơn vị, `LEADER` | phê duyệt, quyết định |
| `canbo.qlda` | Phạm Quốc Dũng (`projectManager`) | Ban Quản lý dự án xây dựng tỉnh Cà Mau | Cán bộ Ban quản lý dự án | lập hồ sơ, thực hiện |
| `ketoan` | Hoàng Thị Lan (`treasuryMaker`) | Sở Tài chính | Kế toán thanh toán | thanh toán, tạm ứng |
| `nhanvien` | Bùi Thị Mai (`projectViewer`) | Ban Quản lý dự án xây dựng tỉnh Cà Mau | `STAFF_MEMBER` | "Việc hôm nay" của cán bộ, nhân viên |
| `quantri.donvi`, `thanhtra`, `truongban`, `quantri.baomat`, `thanhvien` | các người còn lại của lớp seed | | quản trị đơn vị, thanh tra, Trưởng Ban chỉ đạo, quản trị bảo mật, thành viên | cần cho việc nạp; có thể giao thêm để xem theo vai |

- Máy phát triển: không có mật khẩu, đăng nhập bằng `?devUser=<khóa>` (ví dụ `http://127.0.0.1:5180/?devUser=owner`).
- Bản cài: mật khẩu và mã bí mật OTP sinh ngẫu nhiên trên máy chủ, nằm ở `C:\ProgramData\MACHVON\secrets\admin\demo-credentials.json` (chỉ Administrators và SYSTEM).
  Realm đòi yếu tố thứ hai ở **mọi** lần đăng nhập và không cho người mới tự ghi danh, nên mỗi tài khoản được cấp sẵn TOTP: giao cho người dùng tên đăng nhập, mật khẩu và
  địa chỉ `otpauth://` (nhập vào Google Authenticator hoặc Microsoft Authenticator). Không có mật khẩu nào trong repo.

## 3. Trên máy phát triển

```
npm run demo:public                       # = node scripts/demo-public.mjs ; mặc định --dataset camau, web 5180, API 47411
node docs/demo-camau/capture.mjs          # chụp lại ảnh của docs/demo-camau
```

Lệnh dựng web (chế độ development), stack API (PostgreSQL nhúng, `E2E_SEED=docs`, tenant lấy từ bộ dữ liệu qua `E2E_TENANT_PROFILE`), chạy `clip-seed apply --dataset camau`
rồi `verify`, và mở web. Dừng: tạo tệp `<thư mục chạy>/stack-info.json.stop`. Cơ sở dữ liệu mới ở mỗi lần chạy, nên "xóa và nạp lại" trên máy phát triển là chạy lại lệnh.
Trên stack này đồng hồ lùi được (`/__e2e/clock`): kế hoạch vốn được công bố 80 ngày trước, thanh toán gửi 40 ngày trước, quy trình gói thầu chạy ở bảy mốc, nên có việc quá hạn thật.

## 4. Trên bản cài chạy Docker (production demo)

Bản cài không có phiên phát triển, không có đường `/__e2e`, và mã nguồn không nằm trên máy chủ. Thứ tự:

**Bước 0 (một lần, trên máy phát triển).** Tạo hai thứ để chép lên máy chủ, không thứ nào chứa bí mật:

```
node scripts/demo-tenant-input.mjs --dataset camau --out demo-tenant.input.json     # đơn vị, vai, người
node scripts/demo-tools-pack.mjs --out demo-tools                                   # công cụ, khi image dựng trước khi có demo-tenant.mjs
scp -r demo-tenant.input.json demo-tools infra/onprem-windows/host/demo-tenant.ps1 infra/onprem-windows/host/demo-reset.ps1 Administrator@<máy chủ>:C:/pis-setup/
# trên máy chủ: chép hai tệp .ps1 vào C:\ProgramData\MACHVON\host (chúng dùng common.ps1 ở đó)
```

**Bước 1. Tenant và chủ sở hữu.** Cần một tenant có chủ sở hữu tên đăng nhập `demo`, và tệp tài khoản của người đó
(`{ origin, username, password, totpSecret, tenantId, membershipId }`, mặc định `secrets\admin\demo-account.json`, xem `deploy-windows-containers.md` mục 10).

- Tenant mới (sau khi xóa sạch ở mục 5): chạy `host\first-accounts.ps1` với tệp vào khai `tenant: { code: "ca-mau", name: "UBND tỉnh Cà Mau", rootUnitName: "Ủy ban nhân dân tỉnh Cà Mau", subdomain: "ca-mau" }`,
  `owner.username: "demo"`, `members: []`; rồi lập `demo-account.json` từ mục của `demo` trong `first-accounts.json` cộng `origin`, `tenantId`, `membershipId`.
- Tenant đang có và **chưa có dữ liệu nghiệp vụ**: dùng luôn; `demo-tenant` đổi mã và tên đơn vị gốc thành của Cà Mau. Tên tenant hiển thị (theme) là của mặt điều khiển,
  công cụ này không đổi: nếu tên đang là tên khác thì chọn cách xóa sạch.

**Bước 2. Đơn vị, vai, người (trên máy chủ).**

```
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\demo-tenant.ps1 -InputFile C:\pis-setup\demo-tenant.input.json -Tools C:\pis-setup\demo-tools
```

Kết quả: `secrets\admin\demo-credentials.json`. Chạy lại được; việc đã xong không làm lại. Công cụ bỏ khỏi vai các quyền mà chủ sở hữu tenant không giữ
(quy tắc chống leo thang của `createCustomRole`) và in tên chúng; quyền có tên mà `createCustomRole` không nhận đã bị loại từ lúc lập tệp vào (`droppedPermissions`).
Vai dài hơn 200 quyền được tạo thành nhiều phần (`CAN_BO_BAN_QLDA`, `CAN_BO_BAN_QLDA_2`...), cấp cùng nhau.

**Bước 3. Chờ danh mục dùng chung.** Tenant mới chưa có danh mục địa bàn cho tới khi việc nền `master-baseline-sync` chạy (6 giờ một lần kể từ khi `workers` khởi động;
không có lệnh nào kích hoạt; **đừng khởi động lại `workers`**, mỗi lần khởi động lại là đếm lại). `preflight` cho biết đã sẵn sàng chưa; `apply --wait-baseline <phút>` chờ hộ.

**Bước 4. Kiểm, nạp, kiểm (từ máy phát triển).** Tệp tài khoản được đọc qua ssh vào đầu vào chuẩn, không nằm lại trên máy chạy lệnh:

```
ssh -i <khóa> Administrator@<máy chủ> "type C:\ProgramData\MACHVON\secrets\admin\demo-credentials.json" | node scripts/clip-seed.mjs preflight --dataset camau --api https://<PUBLIC_HOST>/api --credentials -
ssh ...                                                                                                 | node scripts/clip-seed.mjs apply     --dataset camau --api https://<PUBLIC_HOST>/api --credentials - --wait-baseline 400
ssh ...                                                                                                 | node scripts/clip-seed.mjs verify    --dataset camau --api https://<PUBLIC_HOST>/api --credentials -
```

- `preflight`: từng người đăng nhập được, đủ đơn vị của bộ dữ liệu, tỉnh `CA-MAU` có hiệu lực trong danh mục của tenant.
- `apply` trả mã 3 và nói rõ khi danh mục chưa tới. Mật khẩu chỉ đi vào biến môi trường của tiến trình con; trên đĩa chỉ có một tệp tạm giữ token (sống 5 phút), xóa khi xong.
- Cùng một người đăng nhập sai 5 lần liên tiếp bị Keycloak khóa tạm: bộ nạp không thử lại một lần đăng nhập đã hỏng.

**Khác với máy phát triển (đã biết trước, chưa đo trên bản cài):** bản cài không lùi được đồng hồ, nên những gì bộ dữ liệu làm cho "trễ thật" (bước quy trình gói thầu quá hạn,
tạm ứng quá hạn thu hồi, ảnh chụp kỳ đã khóa của các tháng trước) có thể không trễ hoặc không tạo được; hai việc stack làm thay con người (nhà thầu nhận lời mời cổng nhà thầu,
xác nhận pháp lý mẫu trình bày) không có ở đó. `verify --tolerate "<tên kiểm>,<tên kiểm>"` cho qua **đúng tên** những kiểm đó và in chúng là `tol`; tên không khớp kiểm nào là lỗi.
Danh sách tên được chốt bằng lượt chạy thật ở giai đoạn 2 và ghi vào mục 6.

## 5. Xóa sạch dữ liệu demo trên bản cài

```
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\demo-reset.ps1 -Confirm RESET-DEMO-DATA
```

Lệnh **xóa mọi tenant và toàn bộ dữ liệu** của cơ sở dữ liệu sản phẩm; chỉ dùng cho bản cài demo. Nó làm, theo thứ tự, và dừng ở bước đầu tiên hỏng:

1. sao lưu cả hai cơ sở dữ liệu (`backup.ps1`, nhãn `before-demo-reset`) và kiểm bản sao lưu có đủ tệp; chưa có bản sao lưu thì không đổi gì;
2. chuyển `first-accounts.json`, `demo-account.json`, `demo-credentials.json` vào `<bản sao lưu>\admin-files` và xóa những người đó khỏi realm (`-KeepPeople` để giữ);
3. dừng `web`, `workers`, `api`; `DROP DATABASE machvon` rồi tạo lại rỗng (cơ sở dữ liệu của Keycloak, realm và client được giữ);
4. chạy migration, đăng ký placement và khóa ký license (`control-plane.ps1`);
5. khởi động mọi dịch vụ, chờ healthy.

Quay lại trạng thái trước: `restore.ps1 -Backup <thư mục before-demo-reset> -Confirm RESTORE` rồi chép các tệp trong `admin-files` về `secrets\admin`.
Không đụng tới: volume tệp tải lên (`machvon_objects`: tệp cũ còn trên đĩa, không còn bản ghi nào trỏ tới), chứng thư, bí mật của dịch vụ.
Sau khi xóa: làm lại mục 4 từ bước 1. Vì `workers` khởi động lại, danh mục dùng chung tới tenant mới sau **tối đa 6 giờ**.

Sản phẩm không có lệnh xóa ngay một tenant: `startTenantOffboarding` đòi cửa sổ xuất dữ liệu ít nhất 30 ngày, nên xóa sạch một bản demo là dựng lại cơ sở dữ liệu, có sao lưu trước.

## 6. Trạng thái đã kiểm

| Việc | Ở đâu | Kết quả |
|---|---|---|
| `clip-seed apply --dataset camau` trên stack sạch | máy phát triển, 2026-11-15 | chạy trọn, mã 0; xem `docs/demo-camau/README.md` |
| `clip-seed verify --dataset camau` | máy phát triển | đạt 54 kiểm |
| `demo-tenant`: đổi tên đơn vị gốc, tạo đơn vị, tạo vai theo phần | API thật của stack phát triển, tenant thứ hai, token của chủ sở hữu | đạt (đơn vị và vai đọc lại được); phần người (Keycloak, lời mời) chỉ có test với sản phẩm giả lập |
| Đăng nhập bằng token OIDC của từng người, `preflight`, `apply`, `verify` trên bản cài | bản cài | **chưa chạy** (giai đoạn 2) |
| `demo-reset.ps1` | bản cài | **chưa chạy**; có test tĩnh về thứ tự sao lưu rồi mới xóa |

## 7. Nguồn tra cứu tên đơn vị và địa danh (tra ngày 2026-11-15)

- Hợp nhất tỉnh Bạc Liêu và tỉnh Cà Mau thành tỉnh Cà Mau: Nghị quyết 202/2025/QH15 (12/6/2025). Cấp xã: Nghị quyết 1655/NQ-UBTVQH15 (16/6/2025), 64 đơn vị (55 xã, 9 phường),
  chính quyền hai cấp từ 1/7/2025. Danh sách 64 xã, phường và trụ sở UBND tỉnh (phường Tân Thành): https://vi.wikipedia.org/wiki/Cà_Mau ;
  https://luatvietnam.vn/hanh-chinh/nghi-quyet-1655-nq-ubtvqh15-2025-sap-xep-don-vi-hanh-chinh-cap-xa-tinh-ca-mau-403015-d1.html
- Ba Ban quản lý dự án chuyên ngành cấp tỉnh sau sắp xếp (công bố 31/12/2025): xây dựng, xây dựng công trình giao thông, công trình nông nghiệp:
  https://www.sggp.org.vn/ca-mau-sap-xep-6-ban-quan-ly-du-an-chuyen-nganh-cap-tinh-post831490.html (bài báo viết tắt "BQLDA"; tên đầy đủ trong bộ dữ liệu là suy ra từ đó).
- 13 cơ quan chuyên môn thuộc UBND tỉnh sau hợp nhất: số lượng theo https://thanhtra.com.vn/doi-noi-52FA82FBF/ca-mau-thay-doi-ra-sao-sau-mot-nam-van-hanh-chinh-quyen-2-cap-5c80c3edc.html ;
  **tên từng sở** lấy theo khung chung của tỉnh sau sắp xếp năm 2025 (Tài chính, Xây dựng, Nông nghiệp và Môi trường, Khoa học và Công nghệ, Y tế, Giáo dục và Đào tạo, Công Thương,
  Văn hóa, Thể thao và Du lịch, Nội vụ, Tư pháp, Dân tộc và Tôn giáo, Thanh tra tỉnh, Văn phòng UBND tỉnh), chưa đối chiếu với quyết định của UBND tỉnh cho từng sở.

Những chỗ là quy ước của bộ dữ liệu, không phải tổ chức thật: đơn vị "Khối Ban quản lý dự án chuyên ngành" là nút gom trong cây (ba Ban thật thuộc thẳng UBND tỉnh; các nhóm seed cần
một đơn vị có đơn vị con); mọi dự án minh họa đứng tên một chủ đầu tư (Ban Quản lý dự án xây dựng tỉnh Cà Mau); "Kho bạc Nhà nước khu vực Cà Mau" là tên minh họa;
mã số thuế của nhà thầu minh họa dùng đầu số của bộ hướng dẫn; tên việc trong mẫu quy trình của sản phẩm (ví dụ nhắc "Sở Kế hoạch và Đầu tư") là dữ liệu nền của sản phẩm, không thuộc bộ dữ liệu này.

## 8. Bổ sung sau lần nạp thật trên bản cài (2026-11-16)

Những điều dưới đây chỉ lộ ra khi nạp trên bản cài chạy image phát hành; mục 4 và 5 vẫn đúng, đọc kèm mục này.

**8.1 Ký số của bản demo (`MACHVON_DEMO_SIGNING`).** Sản phẩm chưa có adapter của một tổ chức chứng thực thật: trên bản cài, lãnh đạo không ký được, cơ quan không đóng dấu
được, nên không văn bản nào được phát hành, và mọi việc cần "quyết định đã phát hành" (duyệt kế hoạch lựa chọn nhà thầu, rồi gói thầu, hợp đồng, thanh toán) đứng lại.
Bản cài DEMO được bật một bộ thay thế: tổ chức chứng thực minh họa dùng một lần, chỉ bản cài này tin; phiên ký tự được chấp thuận; chứng thư do nó cấp luôn được trả lời
"chưa bị thu hồi". Chữ ký làm ra **không có giá trị pháp lý**. Công tắc chỉ bật được khi `MACHVON_DEPLOYMENT_PURPOSE=demo`; sai cấu hình thì API từ chối khởi động.

```
# máy phát triển: tạo tệp tổ chức chứng thực (có khóa riêng của các danh tính minh họa) và tệp chứng thư công khai
cd apps/api
node --import ./scripts/ts-register.mjs scripts/demo-pki.ts --out <tmp>/demo_pki --certificates <tmp>/demo-pki-certificates.json \
  --authority "PIS Demo Root CA (khong co gia tri phap ly)" --signer "leader|Tran Thi Bich|<don vi>" --signer "organization|Uy ban nhan dan tinh Ca Mau"
scp <tmp>/demo_pki Administrator@<máy chủ>:C:/pis-setup/demo_pki      # rồi xóa tệp ở máy phát triển
# máy chủ
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\demo-signing.ps1 -Mode on -PkiFile C:\pis-setup\demo_pki -IAcceptThisIsADemonstration
# máy phát triển, sau khi đã có tenant và người (demo-tenant): đăng ký chứng thư bằng lệnh chính thức registerSigningCertificate
ssh ... "type ...\demo-credentials.json" | node scripts/demo-signing-register.mjs --dataset camau --api https://<PUBLIC_HOST>/api --credentials - --certificates <tmp>/demo-pki-certificates.json
```

Tệp nằm ở `secrets\api\demo_pki` và được image nạp theo quy ước tệp bí mật (`MACHVON_DEMO_PKI_FILE`, chỉ đặt khi công tắc bật). Sau mỗi lần xóa sạch (mục 5) chứng thư đã đăng ký
mất theo cơ sở dữ liệu: đăng ký lại bằng lệnh cuối. Tệp văn bản của DOC đang ở bộ nhớ của tiến trình API (sản phẩm chưa nối kho đối tượng cho DOC): sau khi `api` khởi động lại,
văn bản đã phát hành vẫn có hiệu lực nhưng tệp PDF của chúng không tải lại được.

**8.2 Mật khẩu demo dùng chung.** `demo-tenant.ps1 -DemoPassword <mật khẩu>` đặt MỘT mật khẩu cho mọi tài khoản demo (kể cả chủ sở hữu), không tạm thời, và đặt lại ở mỗi lần chạy,
nên nạp lại vẫn ra đúng mật khẩu ấy. Không có tham số thì mỗi tài khoản một mật khẩu 13 chữ và số. Realm của bản này không có chính sách mật khẩu nên không phải nới gì.
Mật khẩu dùng chung chỉ dành cho bản demo; không ghi nó vào repo. Kiểm đăng nhập thật của từng tài khoản: `... | node docs/demo-camau/login-check.mjs`.
Tệp giao khách hàng (ngoài git): `... | node scripts/demo-accounts-xlsx.mjs --credentials - --api https://<PUBLIC_HOST>/api --out <tệp .xlsx>` (quyền của từng tài khoản được đọc từ bản cài).

**8.3 Thứ tự đúng của một lần xóa và nạp lại.**

1. `demo-reset.ps1 -Confirm RESET-DEMO-DATA` (từ bản 1.0.5 nó kết thúc mọi phiên của realm trước khi xóa người, để trình duyệt còn cookie của người cũ không gặp trang lỗi).
2. `first-accounts.ps1 -InputFile <first-accounts.camau.json>` (tenant "UBND tỉnh Cà Mau", chủ sở hữu `demo`, quản trị hệ thống `quantri.hethong`).
3. `demo-tenant.ps1 -InputFile ... [-Tools ...] -DemoPassword <mật khẩu>`; mặc định nó lấy chủ sở hữu từ `first-accounts.json` khi không có `demo-account.json`.
4. `docker restart machvon-workers-1`: việc nền `master-baseline-sync` chạy khi `workers` khởi động, nên tenant mới có danh mục địa bàn sau vài phút (không phải 6 giờ).
5. `demo-signing-register.mjs` (mục 8.1), rồi `clip-seed preflight`, `apply`, `verify`.

**8.4 Bộ nhớ của lần nạp.** Các nhóm seed ghi sổ và các bước "chỉ làm một lần" vào `<thư mục nhà>/.clip-seed/<máy chủ>-<tenant>` (hoặc `--state-dir`); thư mục này phải còn giữa các lần
`apply` trên cùng một tenant, nếu mất thì lần chạy lại vấp các bước không lặp lại được (ví dụ xác nhận pháp lý một mẫu đã xác nhận). Trong đó không có mật khẩu hay token.

**8.5 Tên người.** Realm hiển thị `firstName lastName`; tên tiếng Việt viết họ trước, nên công cụ đặt họ và tên đệm vào `firstName`, tên vào `lastName` ("Nguyễn Văn An").

**8.6 Ba chỗ mà dữ liệu trên bản cài khác bản e2e.** Cả ba đã sửa trong lớp seed (commit `56c2a6b9a`), ghi lại để người nạp sau hiểu vì sao có các tham số này.

- *Ngày hiệu lực của kế hoạch.* Ảnh chụp tiến độ và cảnh báo sớm chỉ tính từ ngày kế hoạch có hiệu lực. Bản e2e dời đồng hồ; bản cài thì không, nên seed đặt
  `effective_at` của kế hoạch lùi 80 ngày (`planEffectiveAt()`), không có tham số nào phải truyền.
- *Mã người.* Giao việc cần mã tài khoản (`user_account_id`), không phải mã thành viên của tenant; seed đọc nó từ danh sách người của bản cài.
- *Xác nhận bố cục mẫu thanh toán.* Thanh toán bị chặn `TEMPLATE_UNCONFIRMED` cho tới khi bố cục mẫu được xác nhận; sản phẩm chưa có màn hình hay lệnh công khai cho việc này,
  bản e2e xác nhận bằng SQL. Trên bản cài DEMO dùng đúng cách ấy qua một lệnh ngoài: `clip-seed apply ... --layout-confirm-command "ssh ... powershell -File C:\ProgramData\MACHVON\host\demo-layout-confirm.ps1"`.
  Lệnh này ghi thẳng cơ sở dữ liệu, **chỉ dành cho bản demo**.

**8.7 Một yếu tố (bản demo) phải hạ cả mức mà các client đòi.** Chế độ một yếu tố của realm chỉ bỏ bước TOTP; các client web và mobile vẫn xin mức `aal2`. Người còn phiên SSO
ở mức `aal1` mở lại trang thì realm đòi nâng mức, không nâng được và hiện "Tên đăng nhập hoặc mật khẩu không đúng" **trước khi người ấy gõ gì**. Từ commit `a59c34f04`, công cụ
`keycloak-admin` khi bật một yếu tố cũng đặt `default.acr.values` và `minimum.acr.value` của các client về `aal1` (tắt một yếu tố thì trả lại `aal2`). Trên máy chủ, thay đổi này
đã được áp bằng một lần chạy công cụ bản mới đè lên; image 1.0.8 chưa mang nó trong công cụ của chính image, bản phát hành kế tiếp mới có.

**8.8 Hai kiểm tra của `clip-seed verify` phụ thuộc đồng hồ.** Trên bản cài không có cách chính thức nào để lùi thời gian:

| Kiểm tra | Vì sao chưa đạt ngay sau khi nạp | Khi nào tự đạt |
|---|---|---|
| tạm ứng quá hạn thu hồi | cờ quá hạn do việc nền hằng ngày lúc 06:00 đặt | sau lần chạy 06:00 kế tiếp (đã đạt lúc 07:00 ngày 2026-11-16) |
| luồng phê duyệt trễ hạn | hạn của từng bước tính từ lúc bước ấy thật sự được mở | khi thời hạn xử lý của bước trôi qua (tính bằng ngày) |

Chỉ hai kiểm tra này được phép bỏ qua bằng `--tolerate`, và phải ghi rõ trong biên bản nạp. Mọi kiểm tra khác đỏ là lỗi thật.

**8.9 Ba lời từ chối được chấp nhận khi `apply`.** `egp` trả `CROSSWALK_DUPLICATE` (bảng đối chiếu đã có từ danh mục gốc), bàn giao hồ sơ trả `VALIDATION_FAILED`
(cần tệp đã quét virus của kho đối tượng), và gắn khách của cổng nhà thầu (hành vi chỉ có trong bản e2e). Ba mục này không tạo dữ liệu, các màn hình liên quan vẫn có số liệu từ các nhóm khác.

**8.10 Các bản phát hành trong đợt nạp 2026-11-16.**

| Bản | Nội dung |
|---|---|
| 1.0.3 | ký số của bản demo (lỗi: biến `*_FILE` trỏ tới tệp chưa có làm API không khởi động) |
| 1.0.4 | đọc nội dung `MACHVON_DEMO_PKI`, compose chỉ truyền tệp khi công tắc bật |
| 1.0.5 | trả lời thu hồi cho chứng thư của bản demo; `demo-reset` kết thúc mọi phiên; trang lỗi của realm có nút "Đăng nhập lại" |
| 1.0.6 | tệp văn bản DOC nằm trên đĩa (`MACHVON_OBJECT_ROOT/doc-files`), còn sau khi API khởi động lại |
| 1.0.7 | nút "Đăng xuất" thật, nhãn phiên bản, thanh "tải lại" khi tab chạy bản cũ, `version.json` không lưu đệm |
| 1.0.8 | vai trò cao nhất dưới tên người, trang "Bạn đã đăng xuất" |

Sau 1.0.6 đoạn cuối của mục 8.1 ("tệp PDF không tải lại được sau khi API khởi động lại") không còn đúng: tệp còn trên đĩa. Đường tải về của DOC trong câu trả lời API vẫn là `mock://`
(sản phẩm chưa nối kho đối tượng cho DOC), nên nút tải tệp trên màn hình chưa mở được tệp.
