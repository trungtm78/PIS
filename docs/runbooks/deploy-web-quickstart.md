# Triển khai nhanh web + API + cơ sở dữ liệu lên một máy chủ (từ mã nguồn hiện tại)

Tài liệu này là bản rút gọn, đọc trong 10 phút, để đưa bản hiện tại lên MỘT máy chủ Linux. Nguồn chi tiết và đầy đủ hơn:
`docs/runbooks/infra/onprem-install.md`, `docs/runbooks/infra/onprem-upgrade-rollback.md`, `docs/runbooks/infra/lab-install-checklist.md`,
`docs/runbooks/api-runtime.md`. Mọi lệnh dưới đây đều có trong repo; mục 9 nêu rõ những gì CHƯA được chạy thử.

Một máy chủ chạy sáu dịch vụ bằng Docker Compose (`infra/onprem/compose/compose.yaml`): `db` (PostgreSQL 18 + pgBackRest + pgvector),
`keycloak` (đăng nhập OIDC), `clamav` (quét tệp tải lên), `api`, `workers`, `web` (nginx: phục vụ web, kết thúc TLS, chuyển `/api/` tới API và `/idp/` tới Keycloak).
Chỉ `web` mở cổng ra ngoài (80, 443).

## 1. Cần có gì

| Nơi | Yêu cầu |
|---|---|
| Máy build (có Internet) | Node 24, mã nguồn đã `npm ci`, Docker có buildx (kèm QEMU để build cả amd64 và arm64) và `skopeo` |
| Máy chủ | Linux amd64 hoặc arm64; Docker Engine 28 trở lên với containerd image store; Compose v2.24 trở lên; `sha256sum`; NTP đồng bộ. Cỡ tham chiếu: 8 vCPU, 24 GB RAM, 500 GB SSD |
| Tên miền và chứng thư | DNS cho `PUBLIC_HOST` (và `CONTROL_HOST`); chứng thư TLS hợp lệ cho các tên đó |
| Bên ngoài | Thư mục người dùng qua LDAPS (Active Directory) và kho S3 có object lock ở địa điểm thứ hai cho sao lưu: compose yêu cầu các tệp bí mật của cả hai, `install.sh` từ chối chạy nếu thiếu tệp |

Bản web được build cho ĐÚNG MỘT tên miền (địa chỉ OIDC được biên dịch vào bản web: `infra/onprem/docker/web.Dockerfile`). Đổi tên miền là build lại ảnh `web`.

## 2. Kiểm tra mã nguồn trước khi build (máy build)

```
npm ci
npm run typecheck
npx eslint .
npm run architecture
npm run i18n:check
npm run infra:check
```

Build thử web cho cả hai bản như CI làm (job `Edition public` / `Edition enterprise` của `.github/workflows/ci.yml`), rồi quét gói:

```
cd apps/web
VITE_EDITION=public     npx vite build --outDir /tmp/web-public
VITE_EDITION=enterprise npx vite build --outDir /tmp/web-enterprise
cd ../..
node scripts/edition-check.mjs --public-dist /tmp/web-public
VITE_EDITION=enterprise MACHVON_EDITION=enterprise node scripts/edition-check.mjs --enterprise-dist /tmp/web-enterprise
```

`npm run build -w @machvon/web` làm cùng việc đó kèm kiểm kiểu (`tsc --noEmit`), ghi ra `apps/web/dist`.

## 3. Đóng gói (máy build)

Chọn một số phiên bản chính xác (không bao giờ `latest`), tên miền công khai và bản (`public` hoặc `enterprise`):

```
node scripts/onprem-bundle.mjs plan   --version 1.0.0 --public-host machvon.example.vn
node scripts/onprem-bundle.mjs build  --version 1.0.0 --public-host machvon.example.vn --edition public --out dist/onprem
node scripts/onprem-bundle.mjs verify dist/onprem
```

`plan` chỉ in các lệnh sẽ chạy, không chạy gì. `build` tạo thư mục `dist/onprem`: `images/*.oci.tar` (`machvon/api`, `machvon/workers`, `machvon/web`, `machvon/db`, Keycloak, ClamAV),
`VERSION`, `manifest.json`, `SHA256SUMS`, `sbom.cdx.json`, `install.sh`, `rollback.sh`, cây `infra/onprem/` và các runbook. Chép cả thư mục sang máy chủ, ví dụ `/opt/machvon/1.0.0`.

## 4. Biến môi trường và tệp bí mật (máy chủ)

Sao chép `infra/onprem/compose/env.template` thành `infra/onprem/compose/.env` và điền. Tệp này chỉ chứa cấu hình, KHÔNG chứa bí mật.

| Biến bắt buộc | Ý nghĩa |
|---|---|
| `MACHVON_VERSION` | `install.sh` tự ghi đè bằng nội dung tệp `VERSION` của gói |
| `MACHVON_EDITION` | `public` hoặc `enterprise`: phải khớp với bản đã build ảnh `web` |
| `PUBLIC_HOST`, `CONTROL_HOST` | tên miền của web và của mặt điều khiển |
| `WEB_HTTP_PORT`, `WEB_HTTPS_PORT` | 80 và 443 |
| `MACHVON_SECRETS_DIR`, `MACHVON_SECRETS_GID` | thư mục tệp bí mật (`/etc/machvon/secrets`) và nhóm được đọc (1900) |
| `OIDC_REALM`, `KEYCLOAK_ADMIN_USER`, `TENANT_TOKEN_KEY_ID`, `LICENSE_SIGNING_KEY_ID` | định danh |
| `LDAP_URL`, `LDAP_BIND_DN`, `LDAP_USERS_DN`, `LDAP_GROUPS_DN` | liên kết thư mục |
| `BACKUP_S3_*`, `BACKUP_ARCHIVE_S3_*` | hai kho sao lưu |
| `DB_*`, `KEYCLOAK_*`, `CLAMAV_*`, `API_*`, `WORKERS_*`, `WEB_*`, `BACKUP_CPUS`, `BACKUP_MEMORY` | giới hạn tài nguyên; giữ giá trị mẫu làm điểm xuất phát |
| `MACHVON_BI` | để `off` (cổng đọc cho BI đóng) |

Tệp bí mật: mỗi tên trong `infra/onprem/secrets.json` là một tệp trong `MACHVON_SECRETS_DIR` (tệp đó ghi rõ ai đọc và cách sinh). Tóm tắt:

| Tệp | Cách sinh |
|---|---|
| `db_owner_password`, `keycloak_db_password` | `openssl rand -hex 32` |
| `database_url_owner`, `database_url_app`, `database_url_control`, `database_url_outbox_relay` | URL `postgres://machvon_<vai trò>:<mật khẩu hex>@db:5432/machvon`; mật khẩu của `owner` là nội dung `db_owner_password` |
| `outbox_signing_key` | `openssl rand -base64 48` |
| `tenant_token_signing_key` | `openssl ecparam -name prime256v1 -genkey -noout` |
| `license_signing_key` | `openssl genpkey -algorithm ed25519` |
| `field_encryption_keys` | `printf "1:%s" "$(openssl rand -base64 32)"` |
| `keycloak_admin_password` | `openssl rand -base64 24` |
| `pgbackrest_cipher_pass`, `pgbackrest_archive_cipher_pass` | `openssl rand -base64 48` (giữ hộ ngoại tuyến: mất là không đọc được bản sao lưu nào) |
| `tls_cert`, `tls_key` | chứng thư và khóa của `PUBLIC_HOST` |
| `ldap_bind_credential`, `ldap_ca_cert` | do quản trị thư mục cấp |
| `backup_s3_access_key`, `backup_s3_secret_key`, `backup_archive_s3_access_key`, `backup_archive_s3_secret_key` | do quản trị kho đối tượng cấp |

Mật khẩu trong các `database_url_*` chỉ gồm chữ, số và `_ . ~ -` (`install.sh` kiểm). Quyền tệp, chạy bằng root:

```
groupadd --gid 1900 machvon-secrets
chgrp -R 1900 "$MACHVON_SECRETS_DIR" && chmod 0750 "$MACHVON_SECRETS_DIR" && chmod 0440 "$MACHVON_SECRETS_DIR"/*
chown 999 "$MACHVON_SECRETS_DIR/keycloak_db_password"
```

## 5. Cài đặt: nạp ảnh, migrate, khởi động (máy chủ)

```
cd /opt/machvon/1.0.0
sha256sum --check SHA256SUMS
sh install.sh
```

`install.sh` làm tám bước theo thứ tự và dừng ở bước đầu tiên hỏng: kiểm `SHA256SUMS`, nạp ảnh, kiểm tệp bí mật và tệp compose, (nâng cấp: sao lưu đầy đủ), khởi động `db`,
**chạy migration**, đặt mật khẩu các vai trò cơ sở dữ liệu từ tệp bí mật, khởi động mọi dịch vụ và chờ health check (300 giây). Chạy lại được nhiều lần.

Chạy riêng migration khi cần (cùng lệnh mà `install.sh` dùng):

```
export MACHVON_VERSION=$(cat VERSION)
docker compose --env-file infra/onprem/compose/.env -f infra/onprem/compose/compose.yaml --profile tools run --rm migrate
```

Trước khi mở cho người dùng: áp tường lửa đường ra `sh infra/onprem/config/egress-firewall.sh <kho đối tượng> <cổng> <thư mục> <cổng> --apply` (không có `--apply` thì chỉ in quy tắc),
và bật các bộ hẹn giờ sao lưu trong `infra/onprem/systemd/`.

## 6. Kiểm tra sức khỏe

```
docker compose --env-file infra/onprem/compose/.env -f infra/onprem/compose/compose.yaml ps
curl -fsS https://<PUBLIC_HOST>/api/health/ready
curl -fsS https://<PUBLIC_HOST>/api/health/live
curl -fsS https://<PUBLIC_HOST>/idp/realms/<OIDC_REALM>/.well-known/openid-configuration
curl -fsS http://<máy chủ>/healthz
```

Mọi dịch vụ phải `healthy`. `/api/health/ready` trả 200 khi cơ sở dữ liệu trả lời VÀ mọi migration đã áp; trả 503 kèm `pending_migrations` khi còn migration chưa chạy.
`/api/health/live` luôn 200 khi tiến trình sống. Mở `https://<PUBLIC_HOST>/` phải ra trang đăng nhập của Keycloak.

## 7. Tenant và người dùng đầu tiên

1. Quản trị Keycloak: đăng nhập một lần bằng `KEYCLOAK_ADMIN_USER` và tệp `keycloak_admin_password`, tạo quản trị có tên với WebAuthn, rồi tắt tài khoản khởi tạo (`onprem-install.md`, mục "After the install").
2. Quản trị hệ thống (mặt điều khiển): người thuộc nhóm AD `MACHVON-SYSTEM-ADMINS` nhận vai trò `SystemAdmin` (`infra/keycloak/onprem/ad-group-role-map.json`); vai trò mặt điều khiển bắt buộc WebAuthn.
3. Tenant đầu tiên: quản trị hệ thống tạo ở màn SAS-02 (`/sas/sas-02`), tức lệnh `requestTenantProvisioning` (`POST /system/tenants`): mã tenant, tên, email chủ sở hữu, phiên bản gói cước, đơn vị gốc, tên miền con.
   Tiến trình `workers` chạy 11 bước khởi tạo; tenant chuyển `Active` khi xong (xem ở SAS-01 `/sas/sas-01`), kèm license thử nghiệm, vai trò, đơn vị gốc, theme và lời mời chủ sở hữu.
4. Người dùng đầu tiên của tenant: chủ sở hữu nhận lời mời; các người sau được mời và gán vai trò ở ADM-02, ADM-03 (`docs/runbooks/members.md`, `docs/admin-guide.md` Phần B).

## 8. Nâng cấp và rollback

Nâng cấp là cài gói mới BÊN CẠNH gói cũ (giữ nguyên thư mục gói cũ), cùng lệnh `install.sh`; trên máy đã có cơ sở dữ liệu nó tự sao lưu đầy đủ trước rồi mới migrate:

```
sh /opt/machvon/<bản mới>/install.sh --env-file /etc/machvon/compose.env
```

Rollback (mục tiêu 15 phút) khởi động lại ảnh của bản trước, KHÔNG lùi lược đồ cơ sở dữ liệu (migration theo kiểu expand-contract nên bản trước chạy được với lược đồ mới):

```
sh /opt/machvon/<bản trước>/rollback.sh /opt/machvon/<bản trước> --env-file /etc/machvon/compose.env
```

Nếu dữ liệu bị hỏng thì không rollback: khôi phục theo `docs/runbooks/infra/restore-drill.md`. Bảng "dừng giữa chừng thì làm gì" ở `onprem-upgrade-rollback.md`.

## 9. Những gì CHƯA kiểm chứng

Đã chạy trên máy phát triển (Windows, không có Docker) ngày 2026-11-15, tại nhánh `lane/web1`: `npm run typecheck`, `npx eslint .`, `npm run architecture`, `npm run i18n:check`,
build web cho cả hai bản (`public`, `enterprise`) và quét gói bằng `scripts/edition-check.mjs`. Bộ e2e của web chạy với API thật và PostgreSQL nhúng, phiên đăng nhập phát triển.

CHƯA chạy lần nào, ở máy này hay ở đâu khác (`onprem-install.md` cũng ghi rõ điều này):

- `scripts/onprem-bundle.mjs build`: chưa build ảnh nào, chưa có gói ngoại tuyến nào được tạo ra.
- `install.sh`, `rollback.sh`, tệp compose, bốn Dockerfile, cấu hình nginx, nhập realm Keycloak: mới qua kiểm tĩnh (`npm run infra:check`) và kiểm thử đơn vị. Lần cài đầu tiên trên máy lab là nơi chúng được chứng minh; đi theo `lab-install-checklist.md`.
- Đăng nhập OIDC thật qua Keycloak với thư mục AD, bắt buộc MFA, và xác thực lần hai (step-up `aal2`) bằng Keycloak: e2e chỉ dùng phiên phát triển và một IdP thử nghiệm.
- Sao lưu pgBackRest, object lock, diễn tập khôi phục, tường lửa đường ra.

Điểm cần người quyết định trước khi cài cho khách (đọc từ mã, chưa thử):

- **Đăng nhập mặt điều khiển trên bản web production.** Ảnh `web` được build với một client OIDC là `machvon-web`, và nginx chỉ phục vụ `PUBLIC_HOST`. Realm có client `machvon-control` với địa chỉ `https://<CONTROL_HOST>/auth/callback`,
  nhưng trong `apps/web/src` không có chỗ nào dùng client đó và nginx không có khối máy chủ cho `CONTROL_HOST`. Các màn SAS của quản trị hệ thống (kể cả SAS-02 tạo tenant) hiện chỉ được chạy thử bằng phiên phát triển (`?devUser=sysAdmin`).
  Vì vậy bước 7.3 có thể chưa làm được bằng trình duyệt trên bản production; khi đó tenant đầu tiên phải tạo bằng cách gọi `POST /system/tenants` với token của client `machvon-control`.
- **Bảng quản trị Keycloak.** nginx trả 404 cho `/idp/admin` ở cổng công khai, và mạng `app` không có đường ra, nên bước 7.1 cần một đường vào khác (ví dụ đường hầm tới container `keycloak`) mà repo chưa mô tả.
- **Không có đường chạy production thiếu Keycloak.** Phiên phát triển (chọn người dùng không cần mật khẩu) chỉ có trong bản dev của web và không nằm trong gói production. Bản demo từ mã nguồn không cần Docker là `npm run demo:enterprise`
  (`docs/demo/demo-enterprise.md`): PostgreSQL nhúng, dữ liệu minh họa, mất khi tắt, KHÔNG dùng làm môi trường thật.
- LDAPS và hai kho S3 là bắt buộc theo tệp compose hiện tại: máy chủ chưa có hai thứ đó thì `install.sh` dừng ở bước kiểm tệp bí mật.
