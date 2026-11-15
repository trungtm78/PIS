# Triển khai nhanh web + API + cơ sở dữ liệu lên một máy chủ bằng Docker

Tài liệu này là bản rút gọn để đưa bản hiện tại lên MỘT máy chủ Linux bằng Docker Compose. Triển khai lên máy chủ CHỈ bằng gói Docker này (quyết định của chủ sở hữu).
Nguồn chi tiết hơn: `docs/runbooks/infra/onprem-install.md`, `docs/runbooks/infra/onprem-upgrade-rollback.md`, `docs/runbooks/infra/lab-install-checklist.md`, `docs/runbooks/api-runtime.md`.

Gói đã được CHẠY THẬT trên máy Linux của GitHub Actions (workflow `On-prem smoke`, `.github/workflows/onprem-smoke.yml`): mục 9 ghi chính xác bước nào đã chạy, lượt chạy nào, và phần nào vẫn chưa kiểm chứng.

Một máy chủ chạy sáu dịch vụ (`infra/onprem/compose/compose.yaml`): `db` (PostgreSQL 18 + pgBackRest + pgvector), `keycloak` (đăng nhập OIDC), `clamav` (quét tệp tải lên), `api`, `workers`,
`web` (nginx: phục vụ web, kết thúc TLS, chuyển `/api/` tới API và `/idp/` tới Keycloak). Chỉ `web` mở cổng ra ngoài (80, 443).

## 1. Cần có gì

| Nơi | Yêu cầu |
|---|---|
| Máy build (có Internet) | Node 24, mã nguồn, Docker có buildx, `skopeo`. Build cả hai kiến trúc cần thêm QEMU; build cho một kiến trúc (`--platform linux/amd64`) thì không cần |
| Máy chủ | Linux amd64 hoặc arm64; **Docker Engine 28 trở lên với containerd image store** (bật: `{"features":{"containerd-snapshotter":true}}` trong `/etc/docker/daemon.json`, rồi `systemctl restart docker`); **Compose v2.24 trở lên**; `sha256sum`; NTP đồng bộ. Đã chạy thật với Docker 28.0.4, Compose 2.38.2 |
| Cỡ máy | Tham chiếu sản xuất: 8 vCPU, 24 GB RAM, 500 GB SSD. Tối thiểu để chạy được (cỡ máy đã chạy thật): 4 vCPU, 16 GB RAM, 40 GB đĩa trống cho ảnh và gói (một gói một kiến trúc khoảng 1,4 GB; ảnh đã nạp khoảng 4 GB). Với máy 16 GB giữ nguyên các giới hạn của `env.template` |
| Tên miền và chứng thư | DNS cho `PUBLIC_HOST` và `CONTROL_HOST` cùng trỏ về máy chủ; một chứng thư TLS hợp lệ cho cả hai tên |
| Thư mục người dùng | Active Directory qua LDAPS: bắt buộc (xem mục 4, "Bắt buộc hay tùy chọn") |
| Kho đối tượng | S3 tương thích qua HTTPS, hai bucket có object lock, đặt ở máy KHÁC máy chủ này: bắt buộc (mục 4) |

Bản web được build cho ĐÚNG MỘT tên miền (địa chỉ OIDC được biên dịch vào bản web). Đổi tên miền là build lại gói.

## 2. Kiểm tra mã nguồn trước khi build (máy build)

```
npm ci
npm run typecheck
npx eslint .
npm run infra:check
```

## 3. Đóng gói (máy build)

Chọn một số phiên bản chính xác (không bao giờ `latest`), tên miền công khai và bản (`public` hoặc `enterprise`):

```
node scripts/onprem-bundle.mjs plan   --version 1.0.0 --public-host machvon.example.vn
node scripts/onprem-bundle.mjs build  --version 1.0.0 --public-host machvon.example.vn --edition enterprise --platform linux/amd64 --out dist/onprem
node scripts/onprem-bundle.mjs verify dist/onprem
```

`plan` chỉ in các lệnh. `build` in tiến trình của docker ra màn hình và tạo thư mục gói: `images/*.oci.tar` (`machvon/api`, `machvon/workers`, `machvon/web`, `machvon/db`, Keycloak, ClamAV), `VERSION`, `manifest.json`,
`SHA256SUMS`, `sbom.cdx.json`, `install.sh`, `rollback.sh`, cây `infra/`, các runbook và `scripts/onprem-first-tenant.mjs`. Bỏ `--platform` thì gói chứa cả amd64 lẫn arm64 (lâu hơn nhiều vì build giả lập).
Trên máy 4 vCPU, build gói một kiến trúc mất khoảng 1 phút rưỡi. Chép cả thư mục sang máy chủ, ví dụ `/opt/machvon/1.0.0`.

## 4. Biến môi trường và tệp bí mật (máy chủ)

Sao chép `infra/onprem/compose/env.template` thành `/etc/machvon/compose.env` và điền. Tệp này chỉ chứa cấu hình, KHÔNG chứa bí mật.

| Biến | Ý nghĩa |
|---|---|
| `MACHVON_EDITION` | `public` hoặc `enterprise`: phải khớp với bản đã build |
| `PUBLIC_HOST`, `CONTROL_HOST` | tên miền của web và của mặt điều khiển (`PUBLIC_HOST` phải đúng tên đã build) |
| `MACHVON_SECRETS_DIR`, `MACHVON_SECRETS_GID` | thư mục tệp bí mật (`/etc/machvon/secrets`) và nhóm được đọc (1900) |
| `LDAP_URL`, `LDAP_BIND_DN`, `LDAP_USERS_DN`, `LDAP_GROUPS_DN` | thư mục người dùng (`ldaps://...:636`) |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION` và ba biến `BACKUP_ARCHIVE_S3_*` | hai kho sao lưu; endpoint là `tên-máy` hoặc `tên-máy:cổng`, không có `https://` |
| các biến còn lại | giữ giá trị mẫu (`MACHVON_VERSION` do `install.sh` tự đặt; `MACHVON_BI=off`) |

### Tệp bí mật: bắt buộc hay tùy chọn

Mỗi tên trong `infra/onprem/secrets.json` là một tệp trong `MACHVON_SECRETS_DIR`. `install.sh` từ chối chạy nếu thiếu MỘT tệp bất kỳ: với cài đặt một máy, **cả 22 tệp đều bắt buộc**, không có tệp tùy chọn.
Chỉ hai tệp của `secrets-bi.json` (`db_tls_cert`, `db_tls_key`) là tùy chọn: chỉ cần khi bật cổng đọc cho BI.

| Nhóm | Tệp | Cách có |
|---|---|---|
| Tự sinh trên máy chủ | `db_owner_password`, `keycloak_db_password` | `openssl rand -hex 32` |
| | `database_url_owner`, `database_url_app`, `database_url_control`, `database_url_outbox_relay` | `postgres://machvon_<vai trò>:<mật khẩu hex>@db:5432/machvon`; mật khẩu của `owner` là nội dung `db_owner_password`, ba cái kia mỗi cái một `openssl rand -hex 32` |
| | `outbox_signing_key`, `pgbackrest_cipher_pass`, `pgbackrest_archive_cipher_pass` | `openssl rand -base64 48` (hai mật khẩu pgBackRest: giữ hộ ngoại tuyến, mất là không đọc được bản sao lưu nào) |
| | `tenant_token_signing_key` | `openssl ecparam -name prime256v1 -genkey -noout` |
| | `license_signing_key` | `openssl genpkey -algorithm ed25519` |
| | `field_encryption_keys` | `printf "1:%s" "$(openssl rand -base64 32)"` |
| | `keycloak_admin_password` | `openssl rand -base64 24` |
| Chứng thư của máy chủ | `tls_cert`, `tls_key` | chuỗi chứng thư và khóa của `PUBLIC_HOST` (kèm `CONTROL_HOST`) |
| Do quản trị thư mục cấp | `ldap_bind_credential`, `ldap_ca_cert` | mật khẩu tài khoản dịch vụ chỉ đọc; chứng thư CA đã ký chứng thư LDAPS |
| Do quản trị kho đối tượng cấp | `backup_s3_access_key`, `backup_s3_secret_key`, `backup_archive_s3_access_key`, `backup_archive_s3_secret_key` | khóa ghi của hai bucket |
| | `backup_s3_ca_cert` | chứng thư CA đã ký chứng thư HTTPS của kho (PEM, có thể nhiều CA). Kho dùng CA công cộng: `cp /etc/ssl/certs/ca-certificates.crt backup_s3_ca_cert` |

**Thư mục LDAPS và kho S3 là bắt buộc và được giữ nguyên như vậy**, vì hai lý do an toàn, không phải vì kỹ thuật:

- Kho S3 ở máy khác là nơi DUY NHẤT giữ bản sao lưu và WAL. Cơ sở dữ liệu đẩy WAL sang đó mỗi phút; `install.sh` tạo kho pgBackRest ngay ở bước 5 và dừng nếu không tới được kho. Lưu bản sao lưu trên chính máy chủ thì hỏng đĩa hay mã độc tống tiền là mất cả dữ liệu lẫn bản sao lưu, nên gói không có chế độ "lưu cục bộ".
  Máy chưa có kho: dựng một kho S3 tương thích (ví dụ MinIO, có TLS) trên một máy thứ hai, tạo bucket bằng `sh infra/backup/bucket/create-bucket.sh <bucket> https://<kho>:<cổng> <vùng>` (và thêm `archive` cho bucket lưu trữ). Đúng cách này đã chạy thật trên runner.
- Realm được nhập với liên kết thư mục (mật khẩu ở lại Active Directory, vai trò hệ thống lấy từ nhóm `MACHVON-*`). Keycloak vẫn khởi động khi thư mục không tới được, nhưng khi đó chỉ người dùng tạo tay trong Keycloak đăng nhập được (cách bộ kiểm thử làm, mục 7.2);
  chưa có chế độ "không thư mục" chính thức (mục 9).

Quyền tệp, chạy bằng root:

```
groupadd --gid 1900 machvon-secrets
chgrp -R 1900 "$MACHVON_SECRETS_DIR" && chmod 0750 "$MACHVON_SECRETS_DIR" && chmod 0440 "$MACHVON_SECRETS_DIR"/*
chown 999 "$MACHVON_SECRETS_DIR/keycloak_db_password" "$MACHVON_SECRETS_DIR/backup_s3_ca_cert"
```

Mật khẩu trong các `database_url_*` chỉ gồm chữ, số và `_ . ~ -` (`install.sh` kiểm). `scripts/onprem-smoke/prepare.sh` (bước 5/6 của nó) là ví dụ chạy được của toàn bộ mục này.

## 5. Cài đặt: nạp ảnh, migrate, khởi động (máy chủ)

```
cd /opt/machvon/1.0.0
sha256sum --check SHA256SUMS
sh install.sh --env-file /etc/machvon/compose.env
```

`install.sh` chạy bằng root, làm tám bước và dừng ở bước đầu tiên hỏng: kiểm `SHA256SUMS`, nạp ảnh từ gói (không tải gì từ Internet), kiểm tệp bí mật và tệp compose, (nâng cấp: sao lưu đầy đủ),
khởi động `db` và tạo kho pgBackRest, **chạy migration**, đặt mật khẩu các vai trò cơ sở dữ liệu, khởi động mọi dịch vụ và chờ health check (300 giây). Chạy lại được nhiều lần.
Trên máy 4 vCPU cả lệnh mất khoảng 2 phút rưỡi.

Chạy riêng migration khi cần (cùng lệnh mà `install.sh` dùng):

```
export MACHVON_VERSION=$(cat VERSION)
docker compose --env-file /etc/machvon/compose.env -f infra/onprem/compose/compose.yaml --profile tools run --rm migrate
```

Trước khi mở cho người dùng: áp tường lửa đường ra `sh infra/onprem/config/egress-firewall.sh <kho đối tượng> <cổng> <thư mục> <cổng> --apply` (không có `--apply` thì chỉ in quy tắc),
và bật các bộ hẹn giờ sao lưu trong `infra/onprem/systemd/`.

## 6. Kiểm tra sức khỏe

```
export MACHVON_VERSION=$(cat VERSION)
docker compose --env-file /etc/machvon/compose.env -f infra/onprem/compose/compose.yaml ps
curl -fsS https://<PUBLIC_HOST>/api/health/ready
curl -fsS https://<PUBLIC_HOST>/api/health/live
curl -fsS https://<PUBLIC_HOST>/idp/realms/machvon/.well-known/openid-configuration
curl -fsS http://<PUBLIC_HOST>/healthz
docker compose --env-file /etc/machvon/compose.env -f infra/onprem/compose/compose.yaml --profile tools run --rm backup check
```

Sáu dịch vụ phải `healthy`. `/api/health/ready` trả 200 khi cơ sở dữ liệu trả lời VÀ mọi migration đã áp. `backup check` chứng minh WAL tới được cả hai kho.
Mở `https://<PUBLIC_HOST>/` phải ra trang đăng nhập của Keycloak. Bộ kiểm `scripts/onprem-smoke/verify.mjs` làm đúng các bước này (và mục 7) bằng máy.

## 7. Quản trị Keycloak, tenant đầu tiên và người dùng đầu tiên

### 7.1 Vào quản trị Keycloak một cách an toàn

Bảng quản trị Keycloak KHÔNG mở ra ngoài: nginx trả 404 cho `/idp/admin`, và container `keycloak` không mở cổng nào trên máy chủ. Đường vào chính thức là dòng lệnh quản trị `kcadm.sh` chạy BÊN TRONG container,
tức chỉ người đã SSH vào máy chủ và có quyền Docker (root) mới vào được. Không cần mở cổng, không cần đường hầm:

```
cd /opt/machvon/<phiên bản> && export MACHVON_VERSION=$(cat VERSION)
C="docker compose --env-file /etc/machvon/compose.env -f infra/onprem/compose/compose.yaml"
K="/opt/keycloak/bin/kcadm.sh"
# Đăng nhập: mật khẩu đi qua biến môi trường, không nằm trên dòng lệnh
KC_CLI_PASSWORD="$(cat /etc/machvon/secrets/keycloak_admin_password)" $C exec -T -e KC_CLI_PASSWORD keycloak $K config credentials \
  --server http://127.0.0.1:8080/idp --realm master --user machvon-admin --config /tmp/kcadm.config
# Ví dụ: xem realm, kiểm tra kết nối thư mục
$C exec -T keycloak $K get realms/machvon --fields realm,browserFlow --config /tmp/kcadm.config
```

Việc phải làm ngay sau lần cài đầu: tạo quản trị viên có tên riêng trong realm `master`, rồi tắt tài khoản khởi tạo `machvon-admin` (`onprem-install.md`, "After the install").
Giao diện web của bảng quản trị không dùng được qua cổng công khai theo thiết kế; chưa có đường hầm chính thức cho giao diện đó (mục 9).

### 7.2 Quản trị viên hệ thống

Người tạo tenant phải có vai trò realm `SystemAdmin`.

- Có Active Directory: đưa người đó vào nhóm AD `MACHVON-SYSTEM-ADMINS` (`infra/keycloak/onprem/ad-group-role-map.json`). Vai trò mặt điều khiển bắt buộc khóa bảo mật WebAuthn.
- Chưa có AD (cách bộ kiểm thử làm, đã chạy thật): tạo người dùng ngay trong Keycloak. Người này đăng ký mã một lần (TOTP) ở lần đăng nhập đầu.

```
$C exec -T keycloak $K create users -r machvon -s username=<tên> -s enabled=true -s email=<email> -s emailVerified=true -s firstName=<tên> -s lastName=<họ> --config /tmp/kcadm.config
KC_CLI_PASSWORD='<mật khẩu tạm>' $C exec -T -e KC_CLI_PASSWORD keycloak $K set-password -r machvon --username <tên> --config /tmp/kcadm.config
$C exec -T keycloak $K add-roles -r machvon --uusername <tên> --rolename SystemAdmin --config /tmp/kcadm.config
```

### 7.3 Tenant đầu tiên: `scripts/onprem-first-tenant.mjs`

Bản web production chưa có đường đăng nhập mặt điều khiển, nên màn SAS-02 chưa dùng được bằng trình duyệt. Đường chính thức là script của gói: nó gọi `POST /system/tenants`
(`requestTenantProvisioning`) bằng token của client `machvon-control`. Script không giữ mật khẩu hay khóa nào: nó in ra địa chỉ đăng nhập, quản trị viên đăng nhập trên trình duyệt (kèm xác thực lần hai),
rồi dán lại địa chỉ mà trình duyệt bị chuyển tới.

Chạy trên máy có Node 24 và tới được `https://<PUBLIC_HOST>` (máy của quản trị viên), từ thư mục gói:

```
NODE_EXTRA_CA_CERTS=/đường/dẫn/ca.pem \
node scripts/onprem-first-tenant.mjs --public-host <PUBLIC_HOST> --control-host <CONTROL_HOST> \
  --code dpm --name "Tên tenant" --owner-email chu.so.huu@example.vn --root-unit-name "Tên đơn vị gốc" --subdomain dpm
```

(`NODE_EXTRA_CA_CERTS` chỉ cần khi chứng thư của máy chủ do CA nội bộ ký.) Hoặc chạy ngay trên máy chủ bằng ảnh `api` của gói, không cần cài Node:

```
docker run --rm -it --network host --entrypoint node -v "$PWD/scripts:/s:ro" -v /đường/dẫn/ca.pem:/ca.pem:ro -e NODE_EXTRA_CA_CERTS=/ca.pem \
  machvon/api:$(cat VERSION) /s/onprem-first-tenant.mjs --public-host <PUBLIC_HOST> --control-host <CONTROL_HOST> --code dpm ...
```

Các bước script làm: in địa chỉ đăng nhập; quản trị viên đăng nhập và dán địa chỉ `https://<CONTROL_HOST>/auth/callback?...` (trang đó có thể không tải được, chỉ cần địa chỉ);
script lấy gói cước `STANDARD` đang Published, gửi yêu cầu, chờ tiến trình `workers` chạy xong các bước khởi tạo tới khi tenant `Active` (mặc định chờ 300 giây), rồi in id của tenant.
Chạy lại đúng lệnh đó không tạo tenant thứ hai (cùng khóa idempotency). Tham số khác: `--plan-code`, `--governing-body-type`, `--region`, `--isolation-mode`, `--wait-seconds`, `--locale en`.

### 7.4 Người dùng đầu tiên: lời mời chủ sở hữu

Các dịch vụ không có đường ra Internet nên ứng dụng KHÔNG gửi được thư. Mỗi lời mời (chủ sở hữu tenant, thành viên mời ở ADM-02) được ghi thành một tệp trong volume `invitations`,
chỉ tài khoản dịch vụ đọc được. Người vận hành đọc tệp trên máy chủ, chuyển `link` cho người được mời qua kênh tin cậy, rồi xóa tệp:

```
$C exec -T workers sh -c 'cat /var/lib/machvon/invitations/*.json'
$C exec -T workers sh -c 'rm /var/lib/machvon/invitations/<invitation_id>.json'
```

Người được mời mở `link`, đăng nhập bằng tài khoản có ĐÚNG địa chỉ email được mời (email đã xác minh), đăng ký mã một lần ở lần đầu, rồi bấm chấp nhận. Lời mời có hiệu lực 7 ngày;
tệp của lời mời hết hạn tự bị xóa ở lần gửi kế tiếp. Riêng tệp không cho ai vào được: chấp nhận vẫn cần đăng nhập bằng đúng email.
Gửi lại lời mời chủ sở hữu: `node scripts/onprem-first-tenant.mjs --public-host ... --control-host ... --reinvite <id tenant> --owner-email <email> --reason "<lý do, từ 10 ký tự>" --document-ref "<số văn bản>"`.
Các người dùng sau do chủ sở hữu mời và gán vai trò ở ADM-02, ADM-03 (`docs/runbooks/members.md`); lời mời của họ cũng nằm trong volume này.

## 8. Nâng cấp và rollback

Nâng cấp là cài gói mới BÊN CẠNH gói cũ (giữ nguyên thư mục gói cũ), cùng lệnh `install.sh`; trên máy đã có cơ sở dữ liệu nó tự sao lưu đầy đủ và kiểm bản sao lưu trước rồi mới migrate:

```
sh /opt/machvon/<bản mới>/install.sh --env-file /etc/machvon/compose.env
```

Rollback khởi động lại ảnh của bản trước, KHÔNG lùi lược đồ cơ sở dữ liệu (migration theo kiểu expand-contract nên bản trước chạy được với lược đồ mới):

```
sh /opt/machvon/<bản trước>/rollback.sh /opt/machvon/<bản trước> --env-file /etc/machvon/compose.env
```

Trên máy 4 vCPU: nâng cấp khoảng 1 phút rưỡi, rollback dưới 1 phút. Nếu dữ liệu bị hỏng thì không rollback: khôi phục theo `docs/runbooks/infra/restore-drill.md`.

## 9. Đã chạy thật và chưa kiểm chứng

RUN_EVIDENCE_PLACEHOLDER
