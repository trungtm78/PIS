# Triển khai trên Windows Server bằng container Windows (một máy chủ)

Tài liệu này dành cho máy chủ **không chạy được container Linux** (máy ảo không có ảo hóa lồng: không WSL 2, không Hyper-V). Bản tham chiếu vẫn là
bản Linux (`docs/runbooks/deploy-web-quickstart.md`, `infra/onprem/`); mục 9 liệt kê những điểm khác. Mọi tệp hạ tầng ở `infra/onprem-windows/`,
không tệp nào chứa bí mật.

Lần cài đầu tiên theo tài liệu này: 2026-11-15, Windows Server 2025 Datacenter (bản dựng 26100), 16 vCPU, 32 GB RAM, Docker Engine 29.9.3, Compose v5.7.1.
Trên cùng máy có sẵn một máy chủ web khác (Apache ở cổng 80/443, MySQL 3306): cài đặt này không dừng, không sửa và không dùng cổng của nó.

## 1. Kiến trúc

```
Internet ──TCP 8443 (HTTPS, chứng thư Let's Encrypt)──► web (nginx)
                                                         ├─ /        ứng dụng web (tệp tĩnh)
                                                         ├─ /api/ ──► api (Node 24)  ──► db (PostgreSQL 18 + pgvector)
                                                         └─ /idp/ ──► keycloak       ──► db
                                              workers (Node 24, việc nền) ──► db, clamav
                                              clamav (clamd, quét tệp tải lên)
```

| Dịch vụ | Image (dựng ngay trên máy chủ) | Nền | Chạy bằng | Ghi chú |
|---|---|---|---|---|
| `db` | `machvon/db-windows` | Nano Server ltsc2025 | ContainerUser | PostgreSQL 18.6 (bản nhị phân EDB) + pgvector 0.8.7 biên dịch trong lúc dựng image |
| `keycloak` | `machvon/keycloak-windows` | Nano Server | ContainerUser | Keycloak 26.5.2 + Java 21 (Temurin), realm của sản phẩm, đường dẫn `/idp` |
| `api`, `workers` | `machvon/api-windows` | Nano Server | ContainerUser | Node 24.22.2; mã đã **biên dịch** (không có nguồn TypeScript, không có test) |
| `web` | `machvon/web-windows` | Server Core | ContainerUser | nginx 1.30.6 cho Windows (cần `USER32.dll` nên không chạy trên Nano Server) |
| `clamav` | `machvon/clamav-windows` | Server Core | ContainerUser | ClamAV 1.4.6; chữ ký tải về volume khi khởi động lần đầu |
| `volumes-init` | Nano Server | | ContainerAdministrator, không mạng | chạy một lần: cấp quyền ghi cho ContainerUser trên các volume |

- Cách ly: **process isolation** (`isolation: process`); image nền phải khớp bản dựng của máy chủ (`WINDOWS_TAG=ltsc2025`).
- Mạng: một mạng `nat` riêng `172.29.240.0/24`, địa chỉ cố định cho từng dịch vụ. **Chỉ `web` mở cổng ra ngoài: 8443.** Cơ sở dữ liệu, Keycloak (kể cả
  bảng quản trị, nginx trả 404 cho `/idp/admin`), clamd chỉ nghe trong mạng đó. Không có cổng debug.
- Tường lửa Windows: cài đặt này thêm đúng **một** quy tắc vào (`MACHVON HTTPS`, TCP 8443). Cổng 80 chỉ mở trong vài phút khi xin hoặc gia hạn chứng thư (mục 5).
- Dữ liệu: volume Docker `machvon_pgdata` (cơ sở dữ liệu), `machvon_objects` (tệp tải lên), `machvon_invitations` (lời mời), `machvon_weblogs` (nhật ký truy cập),
  `machvon_clamav_db` (chữ ký).
- Mã nguồn **không** nằm trên máy chủ: máy build tạo một gói build đã biên dịch, máy chủ dựng image từ gói đó rồi **xóa gói**. Trên máy chủ chỉ còn image,
  volume, cấu hình và bí mật.

## 2. Vị trí trên máy chủ

Mọi thứ dưới `C:\ProgramData\MACHVON` (chỉ Administrators và SYSTEM vào được):

| Đường dẫn | Nội dung |
|---|---|
| `compose\compose.yaml`, `compose\.env` | tệp compose của bản đang chạy và cấu hình (không có bí mật) |
| `host\*.ps1` | các script vận hành của mục 4 đến 8 |
| `secrets\<dịch vụ>\` | **tệp bí mật**, mỗi dịch vụ một thư mục, gắn chỉ-đọc vào đúng container đó ở `C:\run\secrets`. Danh sách: `secrets.json` |
| `secrets\admin\` | thứ chỉ người đọc: `first-accounts.json` (tài khoản đầu tiên). Không container dịch vụ nào gắn thư mục này |
| `backups\` | bản sao lưu (mục 6); `backup-spool\` là nơi container `db` ghi tạm, luôn trống giữa hai lần sao lưu |
| `releases\<phiên bản>\` | tệp compose của từng bản đã cài (dùng khi rollback) |
| `state\`, `logs\`, `acme\` | bản trước đó, nhật ký script, win-acme và chứng thư đã cấp |

Quyền của `secrets\<dịch vụ>`: SYSTEM và Administrators toàn quyền, `S-1-5-93-2-2` (ContainerUser của container cách ly tiến trình) chỉ đọc, không ai khác.
Bí mật sinh ngẫu nhiên ngay trên máy chủ (`host\secrets.ps1`), không có trong git, image, tệp compose hay `.env`.

**Tài khoản quản trị nằm ở đâu:**

- Quản trị Keycloak (tài khoản khởi tạo `machvon-admin`): mật khẩu ở `secrets\keycloak\keycloak_admin_password`. Chỉ dùng được từ trong máy chủ (`host\keycloak-admin.ps1`).
- Quản trị hệ thống, chủ sở hữu tenant và người dùng mẫu: `secrets\admin\first-accounts.json` (tên đăng nhập, mật khẩu, mã bí mật OTP và địa chỉ `otpauth://` của từng người).
- Giữ bản sao ngoại tuyến của `secrets\api\field_encryption_keys`: mất tệp này thì các cột mã hóa không đọc lại được.

## 3. Đóng gói (máy build) và cài đặt (máy chủ)

Máy build: Windows x64, Node 24, repo đã `npm ci`. Máy chủ: tính năng Windows `Containers`, Docker Engine chạy dạng dịch vụ, plugin Compose.

```
# máy build
node scripts/onprem-windows-pack.mjs --version 1.0.1 --public-origin https://180-93-34-176.sslip.io:8443 --edition public --out D:\pack-1.0.1
tar -czf pack-1.0.1.tgz -C D:\pack-1.0.1 .
scp pack-1.0.1.tgz Administrator@<máy chủ>:C:/pis-setup/pack.tgz

# máy chủ (PowerShell, quản trị)
mkdir C:\pis-setup\pack; tar.exe -xzf C:\pis-setup\pack.tgz -C C:\pis-setup\pack; del C:\pis-setup\pack.tgz
powershell -ExecutionPolicy Bypass -File C:\pis-setup\pack\infra\onprem-windows\host\install.ps1 -Pack C:\pis-setup\pack
```

Gói gồm: `web/dist` (web đã build cho đúng một địa chỉ công khai), `api/app` (JavaScript đã biên dịch + `node_modules` production cho win32-x64 + migration),
`infra/` và `tools/`, `VERSION`, `manifest.json` (SHA-256 từng tệp, `install.ps1` kiểm trước khi dựng).

`install.ps1` làm chín bước, dừng ở bước đầu tiên hỏng, chạy lại được: kiểm gói và dựng image; chép tệp máy chủ và tạo `.env` (lần đầu); tạo bí mật còn thiếu
và chứng thư tạm; (nâng cấp) sao lưu; khởi động `db`, **chạy migration**, đặt mật khẩu ba vai trò ứng dụng, đăng ký placement và khóa ký license (`control-plane.ps1`);
khởi động mọi dịch vụ và chờ healthy; tắt liên kết thư mục LDAP khi chưa có thư mục, ghi phần trình bày của realm theo bản (mục 12) và đặt luồng đăng nhập
theo `MACHVON_DEMO_SINGLE_FACTOR` (mục 11); đăng ký quy tắc tường lửa và tác vụ hằng ngày; **xóa gói**.

Lần dựng image `db` đầu tiên cài bộ công cụ C++ của Microsoft trong một tầng build để biên dịch pgvector: khoảng 20 đến 30 phút. Các lần sau dùng lại tầng đã có.

Kiểm tra sau khi cài:

```
docker compose --env-file C:\ProgramData\MACHVON\compose\.env -f C:\ProgramData\MACHVON\compose\compose.yaml ps
curl.exe -fsS https://<PUBLIC_HOST>/api/health/ready
curl.exe -fsS https://<PUBLIC_HOST>/idp/realms/machvon/.well-known/openid-configuration
```

## 4. Tài khoản đầu tiên

```
copy C:\ProgramData\MACHVON\host\first-accounts.example.json C:\pis-setup\first-accounts.input.json   # rồi sửa tên, email, vai trò
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\first-accounts.ps1 -InputFile C:\pis-setup\first-accounts.input.json
```

Script đi theo đường chính thức của sản phẩm, không ghi thẳng vào cơ sở dữ liệu nghiệp vụ: tạo người trong realm (API quản trị Keycloak, từ trong mạng compose);
quản trị hệ thống đăng nhập ở client `machvon-control` và `scripts/onprem-first-tenant.mjs` gọi `requestTenantProvisioning`, chờ tenant `Active`; chủ sở hữu
đăng nhập và chấp nhận lời mời sản phẩm ghi vào volume lời mời; chủ sở hữu mời từng thành viên (`inviteMember`) với vai trò nêu trong tệp, thành viên chấp nhận.
Chạy lại được: việc đã xong (ghi trong `first-accounts.json`) không làm lại. Mã vai trò của tenant: `TENANT_ADMIN`, `UNIT_ADMIN`, `LEADER`, `SPECIALIST`,
`INVESTOR_OFFICER`, `AUDITOR`, `MEMBER`...

Sau đó: giao cho từng người mục của họ trong `secrets\admin\first-accounts.json` (họ nhập địa chỉ `otpauth://` vào ứng dụng xác thực, đổi mật khẩu), rồi xóa tệp.

Thêm người về sau: tạo tài khoản bằng `host\keycloak-admin.ps1 create-user ... --password-file ... --totp-secret-file ...` (hai tệp đặt trong `secrets\admin`,
mỗi tệp một dòng; mã OTP là 20 chữ và số), rồi chủ sở hữu hoặc quản trị đơn vị mời người đó ở màn ADM-02 của web.

Dữ liệu minh họa (dự án, hợp đồng mẫu) **không** được nạp vào bản này. Nếu cần một môi trường demo có dữ liệu, dùng bộ nạp của bản demo
(`npm run demo:enterprise`, `scripts/clips/`, xem `docs/demo/demo-enterprise.md`) trên một cài đặt riêng, không nạp vào cơ sở dữ liệu thật.

## 5. Chứng thư HTTPS

Chưa có tên miền nên dùng tên `180-93-34-176.sslip.io` (trỏ về địa chỉ IP của máy chủ) với chứng thư **Let's Encrypt**, tin cậy với trình duyệt và ứng dụng di động.

```
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\certificate.ps1 -Mode acme -HostName 180-93-34-176.sslip.io -WebRoot C:\laragon\www [-Staging]
```

- Thử thách HTTP-01 phải vào cổng 80, mà cổng 80 thuộc máy chủ web khác trên máy. Script (win-acme) đặt tệp thử thách dưới `<WebRoot>\.well-known\acme-challenge`
  của máy chủ web đó rồi xóa đi; **không đổi cấu hình** của nó. Cổng 80 được mở ở tường lửa Windows bằng một quy tắc riêng chỉ trong lúc xin và luôn được đóng lại.
- **Gia hạn tự động:** tác vụ hằng ngày gọi `certificate.ps1 -Mode renew`; khi chứng thư còn dưới 30 ngày nó xin lại theo đúng cách trên rồi bảo nginx nạp chứng thư mới.
  Xem `logs\certificate.log` và `logs\daily.log`.
- Dự phòng: `-Mode private` tạo chứng thư từ một CA riêng trên máy chủ. Trình duyệt và ứng dụng di động **không tin** chứng thư này cho tới khi cài chứng thư CA
  (`state\private-ca.crt`) lên thiết bị; bản APK phát hành không tin CA do người dùng cài, nên với ứng dụng di động phương án này coi như không dùng được.
- Khi có tên miền thật: build gói mới với `--public-origin` mới (địa chỉ OIDC được biên dịch vào web), sửa `PUBLIC_HOST`, `PUBLIC_HOSTNAME`, `CONTROL_HOST` trong `.env`,
  cài gói, xin chứng thư cho tên mới, build lại APK.

## 6. Sao lưu và khôi phục

```
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\backup.ps1 -Label manual
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\restore.ps1 -Backup C:\ProgramData\MACHVON\backups\<mốc>-<nhãn> -Confirm RESTORE
```

- Tác vụ `MACHVON daily` (SYSTEM, 02:30 mỗi đêm, `host\daily.ps1`): sao lưu, gia hạn chứng thư khi tới hạn, cập nhật chữ ký ClamAV, xoay nhật ký truy cập (giữ 30 ngày).
- Mỗi bản sao lưu là một thư mục `backups\<yyyyMMdd-HHmmss>-<nhãn>`: `machvon.dump`, `keycloak.dump` (pg_dump dạng custom), `roles.sql` (vai trò, không có mật khẩu),
  `SHA256SUMS`, `release.txt`. Giữ 14 ngày. Bản sao lưu nằm **ngoài** mọi volume Docker nhưng vẫn trên cùng ổ đĩa: hãy chép thư mục `backups` sang máy khác theo lịch riêng.
- `restore.ps1` kiểm checksum, sao lưu trạng thái hiện tại (`before-restore`), dừng các dịch vụ dùng cơ sở dữ liệu, tạo lại hai cơ sở dữ liệu từ bản sao lưu rồi khởi động lại.
  Mọi thứ ghi sau bản sao lưu đó bị mất.
- Tệp tải lên (volume `machvon_objects`) **chưa** nằm trong bản sao lưu này; sao chép `C:\ProgramData\docker\volumes\machvon_objects` theo lịch riêng khi bắt đầu có tệp.
- Bí mật (`secrets\`) phải được giữ riêng, ngoại tuyến: bản sao lưu không chứa chúng.

## 7. Cập nhật phiên bản và rollback

Cập nhật = đóng gói bản mới với số phiên bản mới rồi chạy đúng lệnh cài của mục 3. Trên máy đã có dữ liệu, `install.ps1` sao lưu trước (`before-<phiên bản>`),
ghi lại bản đang chạy, migrate, rồi thay container. Image của bản cũ được giữ lại.

```
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\rollback.ps1            # về bản ngay trước
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\rollback.ps1 -Version 1.0.0
```

Rollback khởi động lại image và tệp compose của bản trước; **không** lùi lược đồ cơ sở dữ liệu (migration theo kiểu expand-contract, xem
`docs/runbooks/infra/onprem-upgrade-rollback.md`). Nếu dữ liệu hỏng thì không rollback mà khôi phục (mục 6).

## 8. Vận hành thường ngày

- Dịch vụ `docker` khởi động cùng máy (Automatic, tự khởi động lại khi lỗi); mọi container `restart: always` nên tự lên lại sau khi máy khởi động lại.
- Trạng thái: lệnh `docker compose ... ps` ở mục 3. Nhật ký: `docker logs machvon-api-1` (mỗi container giữ 5 tệp 20 MB).
- Quản trị Keycloak chỉ làm được từ máy chủ: `host\keycloak-admin.ps1` (`disable-directory`, `enable-directory`, `create-user`, `delete-user`).
- Nối thư mục AD/LDAPS: điền `LDAP_*` trong `.env`, đặt mật khẩu bind vào `secrets\keycloak\ldap_bind_credential`, `docker compose ... up -d keycloak`, rồi
  `keycloak-admin.ps1 enable-directory`.
- Ứng dụng di động dùng chung địa chỉ: API `https://<PUBLIC_HOST>/api`, OIDC `https://<PUBLIC_HOST>/idp/realms/machvon`, client `machvon-mobile`:

```
cd apps/mobile
flutter build apk --profile --dart-define=MACHVON_API_BASE_URL=https://<PUBLIC_HOST>/api --dart-define=MACHVON_OIDC_ISSUER=https://<PUBLIC_HOST>/idp/realms/machvon --dart-define=MACHVON_OIDC_CLIENT_ID=machvon-mobile --dart-define=MACHVON_EDITION=public
```

  Bản `--release` chỉ được ký khi có `apps/mobile/android/key.properties` (khóa phát hành, không commit); thiếu tệp đó thì bản release không cài được.

## 9. Khác gì so với bản Linux, và giới hạn đã biết

| Điểm | Bản Windows này | Lý do, hệ quả |
|---|---|---|
| Sao lưu | pg_dump hằng ngày | pgBackRest không có bản Windows: **không** có lưu trữ WAL liên tục, không khôi phục tới thời điểm; điểm khôi phục là bản dump gần nhất (RPO tới 24 giờ) |
| Kho S3, object lock | không dùng | hệ quả của dòng trên; bản sao lưu phải được chép ra ngoài bằng lịch riêng |
| pgaudit, cổng đọc cho BI | không có | pgaudit không có bản dựng Windows; `compose.bi.yaml` không áp dụng |
| Liên kết thư mục LDAPS | **tắt** trong realm đang chạy (`keycloak-admin.ps1 disable-directory`) | chưa có thư mục; tệp realm của sản phẩm không bị sửa, bật lại bằng `enable-directory` |
| Hệ thống tệp chỉ-đọc, `cap_drop`, mạng `internal` | không có trên container Windows | bù lại: ContainerUser, không cổng nào ngoài 8443, bí mật gắn chỉ-đọc theo từng dịch vụ |
| Chữ ký ClamAV | tải lúc chạy (cần đường ra `database.clamav.net`) | bản Linux đóng sẵn trong image |
| Heap của Keycloak | đặt cứng (`KEYCLOAK_JAVA_HEAP`) | Java trong container Windows tính heap theo RAM của máy chủ, không theo giới hạn container |
| Mã của API | JavaScript đã biên dịch, nạp bằng Node (không cần `@swc/core`) | không đặt nguồn TypeScript lên máy chủ |
| Kiến trúc | chỉ amd64, chỉ container Windows | image không chạy được trên Linux và ngược lại |

Ba điều phát hiện khi cài, thuộc về **sản phẩm** (đã xử lý trong script của bản này, nên được sửa ở sản phẩm):

1. **Người dùng mới không tự ghi danh được yếu tố thứ hai.** Luồng đăng nhập của realm đòi yếu tố thứ hai ở mọi lần đăng nhập, và với người chưa có OTP hay WebAuthn
   thì cả hai lựa chọn đều không khả dụng: Keycloak trả "Invalid username or password" dù mật khẩu đúng. Vì vậy quản trị cấp sẵn OTP khi tạo tài khoản
   (`keycloak-admin.mjs create-user`, `first-accounts.mjs`).
2. **Không có lệnh hay migration nào tạo placement.** `requestTenantProvisioning` trả 422 `PLACEMENT_UNAVAILABLE` cho tới khi bảng `machvon.placement` có một dòng `Active`.
   `control-plane.ps1` thêm dòng đó (bằng vai trò chủ lược đồ, như bộ test của sản phẩm làm). Câu trả lời 422 được lưu theo khóa idempotency: gọi lại với đúng nội dung cũ
   sẽ nhận lại 422, phải đổi nội dung yêu cầu.
3. **Không có lệnh nào đăng ký khóa ký license.** Bước `LICENSE_PILOT` hỏng với `SIGNING_KEY_UNAVAILABLE` cho tới khi khóa công khai có trong `machvon.license_signing_key`.
   `control-plane.ps1` đăng ký khóa công khai suy ra từ tệp bí mật (hiệu lực 3 năm; tới hạn phải xoay khóa theo `docs/runbooks/infra/secrets-rotation.md`).

4. **Danh mục dùng chung (địa bàn, ngành...) tới tenant mới chậm tới 6 giờ.** Việc nền `master-baseline-sync` chạy lần đầu sau đúng một chu kỳ 6 giờ kể từ khi
   `workers` khởi động (khởi động lại `workers` là đếm lại từ đầu), và không có lệnh nào kích hoạt nó. Trước lúc đó tenant chưa có danh mục địa bàn nên
   `createProject` chưa gọi được (trường bắt buộc `area_master_version_id`); tenant tự thêm địa bàn cũng bị từ chối (`POLICY_LOCKED`) vì loại này chỉ mở rộng từ danh mục nền.
   **Từ bản 1.0.2:** biến `WORKERS_RUN_AT_START` (danh sách tên việc nền, mặc định của bản cài này là `master-baseline-sync`) cho `workers` chạy các việc đó một lần
   ngay khi khởi động, dưới cùng khóa và cùng sổ lượt chạy như một lượt theo chu kỳ; danh mục tới tenant sau vài giây, không còn phải chờ 6 giờ. Muốn chạy lại ngay:
   `docker compose ... up -d --force-recreate --no-deps workers`.
5. **Bảng vai trò hệ thống còn mỏng** (nhiều dòng ghi "PENDING SIGN-OFF" trong `packages/db/src/system-roles.ts`): `SPECIALIST`, `INVESTOR_OFFICER` chưa có quyền nào,
   quyền xem hồ sơ cá nhân (`profile.self`) chỉ nằm trong vai trò `MEMBER`. `first-accounts.mjs` vì vậy cấp thêm `MEMBER` (phạm vi tenant) cho mỗi thành viên nó mời.

Đã kiểm trên bản cài 2026-11-15 (từ máy ngoài máy chủ): web và API qua chứng thư Let's Encrypt; đăng nhập OIDC mật khẩu + OTP (`acr=aal2`) ở client `machvon-web`
và `machvon-mobile`; lệnh ghi `createOrganizationUnit`, `grantRole` rồi đọc lại; APK bản profile trên emulator Android đăng nhập qua trình duyệt hệ thống và nạp Trang chủ;
sao lưu, tác vụ hằng ngày, nâng cấp 1.0.0 lên 1.0.1, rollback về 1.0.0 và tiến lại 1.0.1 (mỗi lần khoảng 2 đến 3 phút); container tự lên lại sau khi dịch vụ Docker khởi động lại.
Chưa kiểm: `createProject` (lý do ở điểm 4), `restore.ps1` trên dữ liệu thật, khởi động lại cả máy, gia hạn chứng thư thật (mới chạy nhánh "chưa tới hạn").

Giới hạn khác:

- Quản trị hệ thống đầu tiên chỉ có OTP. Chính sách của sản phẩm cho nhân sự mặt điều khiển là WebAuthn (nhóm `MACHVON-SYSTEM-ADMINS`): thêm người đó vào nhóm và ghi danh khóa bảo mật khi sẵn sàng.
- Tài khoản khởi tạo của Keycloak (`machvon-admin`) còn bật vì các script dùng nó; nó chỉ vào được từ trong máy chủ.
- `CONTROL_HOST` trùng `PUBLIC_HOST`: web chưa có giao diện đăng nhập cho client `machvon-control`, tenant đầu tiên được tạo bằng script.
- Chưa có lời mời qua email (không có máy chủ thư): lời mời được ghi vào volume `machvon_invitations`; với người mời về sau, quản trị đọc tệp trong volume và chuyển đường dẫn cho người được mời.
- Một máy chủ duy nhất: không có dự phòng; máy khởi động lại là gián đoạn vài phút.
- APK giao kèm là bản `profile` ký bằng khóa debug, dùng để thử trên điện thoại thật; phát hành lên cửa hàng cần khóa phát hành của chủ sở hữu.

## 10. Tài khoản demo và cách một script lấy access token

**Tài khoản demo** (toàn quyền trong tenant, vai trò `TENANT_OWNER` phạm vi tenant): `C:\ProgramData\MACHVON\secrets\admin\demo-account.json` trên máy chủ
(chỉ Administrators và SYSTEM đọc được). Tệp gồm `origin`, `username`, `password`, `totpSecret`, `otpauth`, `tenantId`, `membershipId`.
Realm đòi yếu tố thứ hai ở mọi lần đăng nhập nên tài khoản đã được cấp sẵn TOTP: người dùng nhập địa chỉ `otpauth` vào ứng dụng xác thực (Google Authenticator,
Microsoft Authenticator...) rồi đăng nhập web bằng tên, mật khẩu và mã 6 số; script tính mã từ `totpSecret` (RFC 6238, SHA-1, 6 số, 30 giây).

**Lấy token cho script** (nạp dữ liệu, UAT). Realm **không có** password grant (`directAccessGrantsEnabled=false`) và không có client secret; cách duy nhất là:

| Bước | Gọi | Kết quả |
|---|---|---|
| 1 | Authorization code + PKCE (S256), client công khai `machvon-web`, `redirect_uri=https://<PUBLIC_HOST>/auth/callback`, `scope=openid`; trả lời các trang đăng nhập của Keycloak như trình duyệt (tên + mật khẩu, rồi OTP) | `code` |
| 2 | `POST https://<PUBLIC_HOST>/idp/realms/machvon/protocol/openid-connect/token` với `grant_type=authorization_code`, `client_id`, `redirect_uri`, `code`, `code_verifier` | token **định danh** (`aud=machvon-api`, `acr=aal2`, sống 5 phút) |
| 3 | `POST https://<PUBLIC_HOST>/api/me/session/tenant-selection` `{ "tenant_id", "membership_id" }` kèm `Authorization: Bearer <token định danh>` và `Idempotency-Key` | token **tenant** (`access_token`) dùng cho mọi route của tenant |

Repo có sẵn script làm cả ba bước, chỉ in ra token:

```
ssh -i <khóa> Administrator@<máy chủ> "type C:\ProgramData\MACHVON\secrets\admin\demo-account.json" | node scripts/onprem-api-token.mjs --account -
# --json in { access_token, expires_in, tenant_id, membership_id }; --identity-only dừng ở bước 2; --client machvon-mobile không dùng được ở đây (redirect là scheme của app)
curl -H "Authorization: Bearer $TOKEN" https://<PUBLIC_HOST>/api/resources/organization_unit?limit=5
```

Đọc tệp tài khoản qua `ssh ... | --account -` để mật khẩu không nằm lại trên máy chạy script. Lệnh ghi (POST/PUT) phải kèm `Idempotency-Key` (một UUID mới cho mỗi lệnh);
thao tác có phiên bản kèm `If-Match: "<version>"`. Token hết hạn sau vài phút: gặp 401 thì gọi lại script. Cùng một người đăng nhập sai 5 lần liên tiếp sẽ bị Keycloak khóa tạm.
Các tài khoản mẫu khác (quản trị hệ thống, quản trị đơn vị, lãnh đạo, chuyên viên, cán bộ chủ đầu tư) ở `secrets\admin\first-accounts.json`, cùng dạng trường.

Lưu ý cho làn nạp dữ liệu: `createProject` cần danh mục địa bàn, do việc nền `master-baseline-sync` đưa tới tenant. Từ bản 1.0.2 việc này chạy ngay mỗi lần `workers`
khởi động (mục 9, điểm 4); ở bản cũ hơn phải chờ 6 giờ và không được khởi động lại `workers` trong lúc chờ.

Khi bản cài bật **chế độ demo một yếu tố** (mục 11) thì đăng nhập chỉ còn tên + mật khẩu: bước 1 không có trang OTP, token định danh mang `acr=aal1`, và trường
`totpSecret` trong tệp tài khoản không còn được hỏi tới (vẫn giữ để dùng lại khi bật 2FA). `scripts/onprem-api-token.mjs` chạy được ở cả hai chế độ.

## 11. Chế độ demo một yếu tố (tắt 2FA trên bản DEMO)

**Quyết định (chủ sở hữu, 2026-11-15):** máy chủ demo `180-93-34-176.sslip.io:8443` chạy ở chế độ một yếu tố để người xem đăng nhập chỉ bằng tên + mật khẩu.
Đây là công tắc **của bản cài**, không phải mặc định của sản phẩm: tệp realm (`infra/keycloak/onprem/machvon-realm.json`), chính sách bảo mật của tenant
(`mfa_required_roles`, BR-IAM-11) và các thao tác step-up (`x-step-up: aal2`) trong mã **không đổi**; test giữ chúng (`scripts/onprem-windows-pack.test.mjs`).

Công tắc gồm hai nửa, phải đi cùng nhau:

| Nửa | Ở đâu | Khi bật |
|---|---|---|
| Keycloak (realm đang chạy) | `keycloak-admin.ps1 single-factor on` | bước cấp 2 `machvon level 2` của luồng `machvon browser forms` thành `DISABLED`: đăng nhập dừng sau mật khẩu, token mang `acr=aal1` (Keycloak không nói dối về mức xác thực); `CONFIGURE_TOTP` thôi là hành động mặc định và được gỡ khỏi những người đang chờ. OTP và khóa đã cấp của mọi người **được giữ nguyên** |
| API và workers | `.env`: `MACHVON_DEMO_SINGLE_FACTOR=true` **và** `MACHVON_DEPLOYMENT_PURPOSE=demo` | mọi token hợp lệ được coi như phiên vừa qua yếu tố thứ hai: vai trò thuộc `mfa_required_roles` (ví dụ `TENANT_OWNER`) chọn được tenant, thao tác step-up (`grantRole`, phát hành theme...) không còn trả `403 MFA_REQUIRED` |

Hàng rào: API **từ chối khởi động** (mã thoát 78, nêu tên biến) nếu `MACHVON_DEMO_SINGLE_FACTOR=true` mà thiếu `MACHVON_DEPLOYMENT_PURPOSE=demo`, hoặc nếu
`MACHVON_ENVIRONMENT` khai `production`/`dr`, hoặc nếu giá trị không đúng chữ `true`/`false`; khi chạy ở chế độ này mỗi lần khởi động API ghi một dòng
`WARNING: MACHVON_DEMO_SINGLE_FACTOR is on...` ra nhật ký (`docker logs machvon-api-1`). Mặc định của mẫu `.env` là `false`.

```
# bật (chỉ trên bản demo, không có dữ liệu thật)
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\single-factor.ps1 -Mode on -IAcceptThisIsADemonstration
# bật lại 2FA (trạng thái của sản phẩm)
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MACHVON\host\single-factor.ps1 -Mode off
```

Script ghi hai biến vào `.env`, tạo lại `api` và `workers`, rồi đổi luồng của realm đang chạy; `install.ps1` của các bản sau đọc lại `.env` và giữ đúng chế độ đã chọn.
Tạo lại `workers` làm các việc nền đếm lại chu kỳ (riêng `master-baseline-sync` chạy ngay, mục 9 điểm 4).

**Rủi ro đã chấp nhận, và vì sao chỉ dành cho demo:**

- Mật khẩu lộ là mất tài khoản: không còn lớp thứ hai, kể cả với chủ sở hữu tenant, quản trị bảo mật và quản trị hệ thống (client `machvon-control` dùng chung luồng).
- Step-up mất tác dụng: cấp vai trò, phát hành theme, duyệt... chạy được bằng phiên mật khẩu, không hỏi lại. Nhật ký kiểm toán vẫn ghi đủ, nhưng ghi mức `aal2` cho các phiên này
  vì API coi chúng là đủ mức; phân biệt bằng dòng cảnh báo lúc khởi động và sổ `logs\single-factor.log` (thời điểm bật/tắt).
- Không được nhập dữ liệu thật hay nối thư mục AD thật khi công tắc còn bật. Trước khi chuyển một bản cài thành bản dùng thật: chạy `single-factor.ps1 -Mode off`,
  kiểm đăng nhập phải hỏi OTP, và đổi mật khẩu các tài khoản đã dùng trong lúc demo.
- Khóa tạm sau 5 lần sai mật khẩu, thời hạn phiên, PKCE, HTTPS và phân quyền theo vai trò **không** bị nới.

**Rollback về bản trước 1.0.2:** chạy `single-factor.ps1 -Mode off` **trước** rồi mới `rollback.ps1`. Bản cũ không biết công tắc này: API của nó đòi lại yếu tố thứ hai
trong khi realm vẫn dừng sau mật khẩu, nên chủ sở hữu tenant sẽ không chọn được tổ chức (`MFA_REQUIRED`). Image Keycloak cũ cũng không có theme `pis-public`:
trang đăng nhập trở về giao diện mặc định của Keycloak cho tới khi tiến lại 1.0.2.

Đã kiểm trên máy chủ demo sau khi cài 1.0.2 (2026-11-15): đăng nhập web ở 1440 px và 390 px chỉ bằng tên + mật khẩu, không có trang OTP, token định danh `acr=aal1`;
chủ sở hữu chọn được tổ chức và vào Tổng quan; `grantRole` (step-up) trả 201; danh mục địa bàn (34 dòng `AREA`) có ngay sau khi `workers` khởi động. Ảnh: `docs/demo-camau/login/`.

Khi bật lại 2FA: người đã có OTP (các tài khoản tạo bằng `first-accounts.ps1`, `keycloak-admin.ps1 create-user`) đăng nhập lại bằng mật khẩu + mã như trước; người được
tạo trong lúc demo mà chưa có OTP phải được quản trị cấp OTP (mục 9, điểm 1).

## 12. Giao diện đăng nhập của bản công

Bản công có theme đăng nhập riêng `pis-public` (`infra/keycloak/themes/pis-public`, kế thừa `keycloak.v2` của Keycloak 26.5): hai phần (bảng giới thiệu bên trái ẩn dưới
1024 px, thẻ đăng nhập bên phải), màu "Xanh dầu điều hành", phông Be Vietnam Pro nhúng trong theme (không gọi CDN), tiếng Việt cho mọi trang của luồng (đăng nhập,
mã một lần, thiết lập OTP, đổi mật khẩu, lỗi, hết hạn, đăng xuất) và tiếng Anh khi trình duyệt để tiếng Anh. Tên hiển thị là "Hệ thống quản lý đầu tư công"; bản công
không hiện tên mã ở trang nào của người dùng. Bản doanh nghiệp không nhận theme này và giữ nguyên realm.

- Gói `--edition public` chép theme vào `infra/keycloak/themes` (image Keycloak `COPY` vào `C:\keycloak\themes`) và chép phần trình bày của realm
  (`infra/keycloak/onprem/presentation.public.json`: `displayName`, `loginTheme`, `internationalizationEnabled`, `supportedLocales`, `defaultLocale`,
  tên bên tin cậy WebAuthn) cạnh công cụ quản trị. Tệp realm chỉ được nhập ở lần khởi động đầu, nên `install.ps1` ghi phần trình bày vào realm **đang chạy** bằng
  `keycloak-admin.ps1 apply-presentation` (chỉ nhận các trường trình bày; không đổi được luồng hay chính sách).
- Sửa theme: sửa tệp, đóng gói bản mới, cài. Khi nâng Keycloak, so `template.ftl` của theme với `theme/keycloak.v2/login/template.ftl` của bản mới.
- Tên trong ứng dụng xác thực: OTP cấp từ bản 1.0.2 mang tên "Hệ thống quản lý đầu tư công <máy chủ>"; mục đã nhập trước đó vẫn hiện tên cũ trên điện thoại của người dùng
  (tên này nằm trong ứng dụng xác thực, máy chủ không đổi được) và vẫn dùng bình thường. Muốn đổi thì người dùng sửa tên mục trong ứng dụng.
- Bản Linux (`infra/onprem`) chưa nối theme này vào image Keycloak của nó.
