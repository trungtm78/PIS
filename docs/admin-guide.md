# Hướng dẫn quản trị hệ thống MACHVON

Tài liệu giao nhận theo yêu cầu TK.02 của hồ sơ kỹ thuật "Phần mềm quản lý ĐTXD" v0.3 (hướng dẫn quản trị), dành cho cán bộ quản trị của Ban CĐS&CNTT và quản trị tổ chức. Tài liệu tổng hợp lại từ các sổ tay vận hành đã có trong kho mã (đường dẫn ghi ở cuối mỗi mục) để người quản trị có một nơi bắt đầu; khi cần từng lệnh chi tiết, mở sổ tay được dẫn.

Hướng dẫn cho người dùng cuối nằm ở `docs/hdsd` (có video) và ở nút dấu hỏi (phím `?`) trên mỗi màn hình. Tích hợp với HPM: `docs/integration/hpm-proposal.md`. Kết nối Power BI: `docs/integration/power-bi-model.md`.

## 0. Phân biệt các lớp quản trị

| Lớp | Ai làm | Làm ở đâu |
|---|---|---|
| Quản trị tổ chức (tenant) | Chủ sở hữu tổ chức, Quản trị tổ chức, Quản trị đơn vị | Màn hình nhóm ADM, MDM, HUB, INT trong ứng dụng |
| Quản trị an ninh | Quản trị an ninh, Kiểm toán viên (chỉ đọc) | ADM-11 (nhật ký), ADM-12 (lưu trữ), ADM-14 (an toàn), ADM-24 (tách bạch nhiệm vụ) |
| Quản trị hạ tầng | Ban CĐS&CNTT | Máy chủ: gói cài ngoại tuyến, sao lưu, Keycloak, giám sát (mục 6, 8, 9) |

Nguyên tắc chung: mọi thay đổi cấu hình tạo ra một phiên bản mới có hiệu lực theo ngày, không sửa đè bản đang chạy; người công bố khác người soạn; thao tác nhạy cảm cần xác thực lần hai; mọi thao tác ghi vào nhật ký kiểm toán.

## 1. Vai trò và quyền

Màn hình: ADM-01 Cây tổ chức, ADM-02 Người dùng và mời thành viên, ADM-03 Vai trò và quyền, ADM-04 Ủy quyền có thời hạn, ADM-15 Ma trận thẩm quyền phê duyệt, ADM-25 Ủy quyền vĩnh viễn, ADM-26 Làm thay có người duyệt, ADM-27 Phạm vi theo kỳ báo cáo, ADM-28 Vắng mặt, người thay và độ phủ người nhận cảnh báo, ADM-17 Thành viên khách (nhà thầu).

**Vai trò có sẵn.** Chủ sở hữu tổ chức (toàn quyền trong tổ chức, thao tác nhạy cảm cần xác thực lần hai), Quản trị tổ chức, Quản trị an ninh, Quản trị đơn vị, Lãnh đạo (phê duyệt hồ sơ thuộc thẩm quyền, xem bảng điều hành), Quản trị thông báo, Chuyên viên (làm nghiệp vụ theo các vai trò nghiệp vụ cấp thêm), Cán bộ chủ đầu tư, Kiểm toán viên (chỉ đọc nhật ký), Người xem thuê bao, Nhà thầu (khách, chỉ xem hợp đồng của mình), Thành viên (quyền cơ bản). Bảng đầy đủ và lời diễn giải: `scripts/hdsd/content.json`.

**Cấp quyền.**
1. Tạo cây đơn vị ở ADM-01 (09 đầu mối của PVFCCo là 07 Ban/Đơn vị và 02 Tổ dự án; danh sách đầu mối và người nhập, người duyệt sẽ được đưa vào bằng gói cấu hình PVFCCo, không lấy dữ liệu thật của khách vào mã nguồn).
2. Mời hoặc tạo thành viên ở ADM-02, gán vai trò ở ADM-03. Một vai trò được cấp theo đơn vị: quyền chỉ có hiệu lực trong đơn vị đó và các đơn vị con. Quyền "trên toàn tenant" (ví dụ xuất nhật ký kiểm toán) không cấp theo cây con.
3. Thành viên khách của nhà thầu (ADM-17) chỉ thấy cổng nhà thầu.
4. Đăng nhập một lần (SSO), LDAP/Active Directory và xác thực đa yếu tố (MFA) do Keycloak đảm nhiệm; việc ánh xạ nhóm AD sang vai trò thuộc gói cấu hình PVFCCo (mục 9 nêu cách vận hành Keycloak).

**Thẩm quyền phê duyệt (DoA).** ADM-15 là bảng dữ liệu "loại hồ sơ, khoảng số tiền, đơn vị, vai trò người duyệt, số cấp duyệt". Hồ sơ đang chạy giữ phiên bản ma trận lúc bắt đầu; ma trận công bố sau chỉ áp cho hồ sơ bắt đầu sau. Đơn vị gần nhất với hồ sơ thắng; ô "cần người duyệt khác nhau" buộc các cấp là những người khác nhau. Chi tiết: `docs/adm-doa-resolver.md`.

**Ủy quyền.** Có thời hạn (ADM-04, tối đa 90 ngày), vĩnh viễn kèm điều kiện kết thúc bằng lời (ADM-25), làm thay trong tối đa 8 giờ có lý do và người duyệt (ADM-26; không bao giờ làm thay các quyền quyết định, ký, duyệt, hay quyền quản trị). Phạm vi theo kỳ báo cáo (ADM-27) giới hạn một vai trò vào một số kỳ. Vắng mặt và người thay (ADM-28) bảo đảm cảnh báo luôn có người nhận. Chi tiết: `docs/adm-delegation.md`.

**Tách bạch nhiệm vụ.** ADM-24 hiển thị ma trận các cặp nhiệm vụ một người không được giữ cùng lúc (mức `BLOCK` chặn lệnh, `WARN` để lại dấu vết cho kiểm toán). Ma trận là quy tắc `SOD_MATRIX` của kho quy tắc (mục 2). Cùng nguyên tắc ấy ở nơi khác: người đẩy báo cáo lên HPM không được ghi biên nhận của chính lần đẩy đó (ràng buộc ở cơ sở dữ liệu).

Xem thêm: `Design/MACHVON_Design/01_Documents/05_modules/ADM.md`.

## 2. Quy tắc quản trị

Màn hình: ADM-19 Kho quy tắc quản trị, ADM-20 Chi tiết loại quy tắc, ADM-21 Soạn phiên bản quy tắc, ADM-22 So sánh phiên bản quy tắc, ADM-23 Sổ loại cảnh báo.

Mọi ngưỡng, hạn, số lần thử, thời gian cảnh báo đều là quy tắc có phiên bản chứ không nằm cứng trong mã.
1. ADM-19 liệt kê từng loại quy tắc: đơn vị sở hữu, số mã đang dùng quy tắc riêng hay mặc định, trạng thái kiểm chứng, căn cứ, ngày lấy số, công thức.
2. ADM-20 đặt quy tắc đang áp dụng cạnh mặc định có sẵn, mỗi tham số một hàng; hàng khác mặc định được đánh dấu.
3. ADM-21 soạn bản nháp; biểu mẫu được sinh từ lược đồ tham số của loại (khoảng cho phép, độ dài, ngày giờ, danh sách). Ngày hiệu lực chọn trong tương lai; bản công bố cần người khác người soạn.
4. ADM-22 so sánh hai phiên bản để duyệt trước khi công bố.
5. Con số pháp lý được đánh dấu "chưa kiểm chứng" cho tới khi đơn vị pháp chế xác nhận; không dùng chúng để kết luận trong hồ sơ chính thức.
6. ADM-23 là sổ các loại cảnh báo: mỗi loại có chủ xử lý, hành động mong đợi và hậu quả nếu bỏ qua. Mọi cảnh báo mới phải đăng ký ở đây; quy trình xử lý: `docs/alert-governance.md`.

Bản cũ không bị xóa: một hồ sơ đã tính theo phiên bản nào thì luôn truy lại được phiên bản đó.

## 3. Lịch

Có hai lịch khác nhau, không lưu trùng dữ liệu của nhau.

| Lịch | Màn hình | Trả lời câu hỏi |
|---|---|---|
| Lịch làm việc | ADM-07 Lịch công tác và ngày nghỉ | Ngày nào làm việc; hạn tính bằng giờ làm việc kéo dài bao lâu |
| Lịch báo cáo | MDM-11 Năm ngân sách và lịch kỳ | Một ngày thuộc kỳ báo cáo nào, hạn nộp của kỳ là khi nào |

Làm việc với lịch làm việc: mỗi năm một phiên bản cho mỗi mã lịch gồm các ngày làm việc trong tuần (mặc định ca 08:00-12:00 và 13:00-17:00), ngày nghỉ kèm căn cứ pháp lý, ngày làm bù. Nhập ngày nghỉ của năm kế tiếp trước khi năm đó bắt đầu, vì mọi hạn phê duyệt, SLA và hạn nhắc việc đều tính theo lịch này. Múi giờ cố định Asia/Ho_Chi_Minh (+07:00). Chi tiết hàm tính: `docs/adm-working-time.md`.

## 4. Danh mục

Màn hình: MDM-01 Trung tâm danh mục và các màn hình theo loại (MDM-02 đến MDM-24), thao tác MDM-25 đến MDM-32, MDM-33 phạm vi toàn hệ thống và tenant, MDM-35 bản ghi chủ và crosswalk, MDM-36 quy tắc survivorship.

- Mỗi mục là một bản ghi có các phiên bản hiệu lực theo ngày. Mục "nền tảng" do nhà cung cấp phát hành (không sửa trong tenant); loại mở rộng cho phép tenant thêm mục con của mình.
- Ngừng dùng một mục buộc nêu mục kế thừa (loại cần thiết như nguồn vốn, giai đoạn dự án, nhóm dự án, đơn vị tính). Gộp mã trùng ở MDM-30; mã hệ thống ngoài (EBS, HPM, Kho bạc) nối với mã nội bộ ở MDM-24 và MDM-35 (crosswalk).
- Nhập hàng loạt từ tệp ở MDM-29 qua khung nhập tệp: chạy thử trước, không tạo bản ghi trùng khi nhập lại cùng một tệp.
- Nhóm vướng mắc và nguyên nhân (MDM-17) là danh mục chuẩn dự kiến dùng cho phần nguyên nhân của thuyết minh báo cáo.
- Tra mọi kiểu thuộc tính và luật máy chủ kiểm tra: `docs/mdm-catalogue-dictionary.md`.

## 5. Trung tâm tích hợp

Màn hình: HUB-01 Danh mục bộ kết nối và sức khỏe, HUB-02 Chi tiết, HUB-03 Nhật ký sự cố; INT-01 Tài khoản máy, INT-02 Phạm vi và khóa, INT-03 Ánh xạ mã dự án đa hệ thống, INT-04 Tài khoản BI và tập dữ liệu chứng nhận, INT-05 Nhật ký truy cập API mở; HPM-01, HPM-02; EBS-01, EBS-02.

**Hub quản mọi kết nối ngoài như nhau.** Mỗi bộ kết nối có một bản mô tả: hướng (vào/ra), giao thức, mẫu tệp có phiên bản, quy tắc độ mới, loại thông tin xác thực, chủ xử lý, khai báo đường ra mạng. Hub chỉ đọc bảng của bộ kết nối, không ghi đè. Chi tiết: `docs/integration-hub.md`.

Việc người quản trị tích hợp làm hằng ngày:
1. Mở HUB-01: xem bộ kết nối nào đang `FRESH`, `AGING` hay `STALE` và còn sự cố mở.
2. Sự cố mở ở HUB-03: nhận, ghi nguyên nhân, đóng; cảnh báo `CONNECTOR_FAILING`, `CONNECTOR_STALE`, `HPM_PUSH_FAILED`, `HPM_PUSH_STALE` thuộc chủ xử lý là quản trị tích hợp.
3. Bí mật không nằm trong cơ sở dữ liệu, chỉ có tham chiếu `secret://`; đổi bí mật theo `docs/runbooks/infra/secrets-rotation.md`.
4. Bộ kết nối chờ thông tin của khách (HPM, EBS, eProcurement, văn thư) hiện nhãn `PENDING-EXTERNAL`: chạy bằng giả định, chưa được nghiệm thu cho tới khi có đặc tả và xác nhận của bên kia.

**API mở và Power BI.** INT-01 tạo tài khoản máy (khóa bí mật hiện một lần, lưu SHA-256). Đổi khóa giữ khóa cũ trong 0 đến 72 giờ (mặc định 24). INT-04 bật từng tập dữ liệu chứng nhận (DS-DISB giải ngân, DS-CTR hợp đồng) và cấp tài khoản cơ sở dữ liệu chỉ-đọc cho Power BI/Lakehouse (mật khẩu hiện một lần). Trước khi cấp tài khoản BI đầu tiên phải bật `pgaudit.log = 'read'` cho vai trò nhóm và `log_connections`, vì đó là nhật ký duy nhất cho biết công cụ BI đã đọc gì. Chi tiết: `docs/open-api.md`, `docs/integration/power-bi-model.md`.

Sổ tay: `docs/runbooks/integration-connectors.md`, `docs/hpm-ebs-connectors.md`.

## 6. Sao lưu và khôi phục

Mục tiêu: RPO 15 phút, RTO 4 giờ, khôi phục về thời điểm bất kỳ trong 35 ngày (cấu hình, kiểm bằng `node scripts/backup-verify.mjs`).

| Việc | Lịch |
|---|---|
| Lưu WAL liên tục | tối đa 60 giây một đoạn |
| Sao lưu đầy đủ | hằng ngày 01:30 |
| Sao lưu gia tăng | 05:30, 09:30, 13:30, 17:30, 21:30 |
| Kiểm tra kho sao lưu | Chủ nhật 03:30 |
| Diễn tập khôi phục | mỗi quý và khi thêm thành phần giữ dữ liệu tenant |

Bản sao nằm ở địa điểm thứ hai, khóa đối tượng chế độ COMPLIANCE giữ 36 ngày (không ai kể cả quản trị kho xóa được), mã hóa hai lớp, danh tính ghi và danh tính quản trị kho là hai người khác nhau. Đây là lớp chống mã độc tống tiền: kẻ chiếm quyền quản trị cũng không xóa được bản sao.

Cảnh báo `pg-wal-archive-failure` và `pg-backup-age` (quá 26 giờ) đi qua kênh trực vận hành độc lập với mô-đun thông báo.

Diễn tập khôi phục (`docs/runbooks/infra/restore-drill.md`): đóng băng chuẩn trên máy dự phòng, khôi phục vào máy sạch tới thời điểm X, so sánh ba chuỗi băm SHA-256 giữa nguồn và bản khôi phục, chạy thử ứng dụng cô lập, ghi biên bản (phiên bản, mốc khôi phục, thời gian thực so với RTO, tên hai người ký), rồi hủy máy khôi phục vì nó chứa dữ liệu thật. Khôi phục dữ liệu riêng một tenant: `docs/sas-tenant-restore.md`, `docs/runbooks/tenant-restore-drill.md`.

Sổ tay: `docs/runbooks/infra/backup-immutable.md`, `docs/runbooks/infra/postgres.md`.

## 7. Xuất nhật ký kiểm toán

Màn hình ADM-11 Nhật ký kiểm toán (xem, lọc, xuất); ADM-12 Chính sách lưu trữ.

- Quyền `audit.export` cấp trên toàn tenant (không cấp theo cây con), kỳ xuất tối đa 366 ngày, định dạng CSV (để đọc) hoặc JSONL (để kiểm chứng), tệp tối đa 64 MiB. Lệnh idempotent: gửi lại không tạo tệp thứ hai.
- Tệp xuất gồm bản kê (MANIFEST), các dấu niêm (SEAL: gốc Merkle, băm liên kết), các dòng sự kiện (EVENT) và lá băm (LEAF). Người nhận kiểm chứng tính toàn vẹn mà không cần cơ sở dữ liệu và không cần tin người gửi (`verifyAuditExport`).
- Trường chứa giá trị nhạy cảm được che khi xuất (dòng có `redacted: true`); ô CSV bắt đầu bằng `=`, `+`, `-`, `@` được thêm dấu nháy để bảng tính không thực thi.
- Chuỗi niêm bị đứt kích hoạt cảnh báo nghiêm trọng `AUDIT_CHAIN_BROKEN`; xử lý theo `docs/runbooks/audit-tamper-drill.md`.
- Chính sách lưu trữ (ADM-12): lớp nghiệp vụ (hồ sơ dự án, hợp đồng, thanh toán, báo cáo, nhật ký kiểm toán) khi hết hạn chỉ vào danh sách rà soát và không bao giờ tự xóa, hội đồng lưu trữ quyết định; lớp kỹ thuật (outbox, hộp sự kiện, phiên, lần gửi) tự dọn hằng đêm. Lệnh giữ pháp lý luôn được ưu tiên: bản ghi bị giữ không bị dọn.

Sổ tay: `docs/runbooks/audit-export.md`, `docs/runbooks/retention.md`.

## 8. Nâng cấp và quay lui

Cài và nâng cấp bằng gói ngoại tuyến có chữ ký (`docs/runbooks/infra/onprem-install.md`, `onprem-upgrade-rollback.md`).

Nâng cấp:
1. Kiểm chữ ký và `sha256sum --check` của gói mới; đọc ghi chú phát hành để biết migration, bí mật mới và biến môi trường mới.
2. Xác nhận bản sao lưu gần nhất dưới 26 giờ và lần diễn tập khôi phục gần nhất trong quý.
3. Giải nén gói mới cạnh gói cũ (`/opt/machvon/<phiên bản>`), giữ gói cũ để quay lui.
4. Chạy `install.sh`: nó kiểm gói, nạp ảnh, kiểm bí mật, sao lưu đầy đủ và kiểm tra, ghi phiên bản trước, chạy migration, thay dịch vụ và đợi kiểm tra sức khỏe.
5. Trỏ `/opt/machvon/current` sang bản mới; kiểm tra nhanh: đăng nhập có MFA, mở một màn hình mỗi mô-đun đang dùng, `/api/health/ready` trả 200, kênh cảnh báo yên lặng 15 phút.

Quay lui (đích 15 phút): nếu thay đổi nằm sau cờ tính năng thì tắt cờ trước; còn lại chạy `rollback.sh` của gói cũ. Cơ sở dữ liệu không bao giờ bị quay lui: các migration theo kiểu mở rộng rồi thu hẹp, bản N-1 chạy được với lược đồ của bản N. Lỗi dữ liệu thì dùng khôi phục (mục 6), không dùng quay lui. Không sửa migration đã chạy; sửa tiếp bằng bản phát hành mới.

Khuyến nghị cho PVFCCo: cài UAT trước, sau đó mới nâng cấp Production trong khung giờ bảo trì; UAT có cấu hình tương đương Production (đây cũng là điều kiện của kiểm thử xâm nhập, yêu cầu HT.02).

## 9. Vận hành thường ngày

- **Danh tính.** Keycloak (`docs/runbooks/infra/keycloak.md`): quản trị Keycloak đầu tiên đăng nhập một lần rồi tạo quản trị có tên với WebAuthn và tắt tài khoản khởi tạo; liên kết thư mục (AD/LDAP) và MFA bắt buộc cho truy cập từ ngoài mạng nội bộ; xuất realm định kỳ (không chứa mật khẩu); đăng nhập thất bại hàng loạt từ một nguồn là dấu hiệu dò mật khẩu: siết phát hiện brute-force và chặn nguồn ở biên.
- **Bí mật.** Đổi bí mật bằng phiên bản mới, triển khai bên dùng, kiểm tra, vô hiệu bản cũ, ghi nhật ký xoay; bí mật lộ thì theo mục "A leaked secret" của `secrets-rotation.md`.
- **Cảnh báo vận hành.** Mỗi quy tắc cảnh báo có một sổ tay riêng trong `docs/runbooks/alerts`, `npm run alerts:check` bảo đảm quy tắc nào cũng có chủ và sổ tay.
- **Giám sát.** `docs/runbooks/infra/observability.md`; sức khỏe toàn nền tảng ở SAS-18 (nhà cung cấp).
- **Mạng.** Chỉ cơ sở dữ liệu (WAL và sao lưu), tác vụ sao lưu và Keycloak có đường ra ngoài, qua mạng `egress` cố định; ứng dụng và dữ liệu không có đường ra. Cơ sở dữ liệu không nối Internet; TLS 1.2 trở lên: `docs/runbooks/infra/tls-headers.md`.
- **Bản vá.** Thành phần bên thứ ba dùng phiên bản còn hỗ trợ; quét chuỗi cung ứng và SBOM: `docs/runbooks/supply-chain.md`, `docs/runbooks/infra/security-scanning.md`. Cam kết vá lỗi bảo mật trong 01 tháng là cam kết hợp đồng.

## 10. Bảng tra cứu

| Cần làm | Mở |
|---|---|
| Cài đặt mới | `docs/runbooks/infra/onprem-install.md` |
| Nâng cấp, quay lui | `docs/runbooks/infra/onprem-upgrade-rollback.md`, `rollback.md` |
| Sao lưu bất biến | `docs/runbooks/infra/backup-immutable.md` |
| Diễn tập khôi phục | `docs/runbooks/infra/restore-drill.md` |
| Xuất nhật ký kiểm toán | `docs/runbooks/audit-export.md` |
| Lưu trữ và giữ pháp lý | `docs/runbooks/retention.md` |
| Kết nối tích hợp | `docs/integration-hub.md`, `docs/runbooks/integration-connectors.md` |
| HPM và EBS | `docs/hpm-ebs-connectors.md`, `docs/integration/hpm-proposal.md` |
| API mở, BI | `docs/open-api.md`, `docs/integration/power-bi-model.md` |
| Phát hành | `docs/runbooks/release-checklist.md` |
| Trình duyệt hỗ trợ | `docs/runbooks/browser-differences.md` |
| Xử lý từng cảnh báo | `docs/runbooks/alerts/` |

## 11. Việc chờ thông tin bên ngoài (nhắc lại cho quản trị)

Chưa thể nghiệm thu khi chưa có: cấu trúc dữ liệu và giao diện kỹ thuật của HPM; mẫu tệp và quyền đọc Oracle EBS; bố cục chính thức của sáu biểu mẫu; từ điển chỉ tiêu và bộ nguyên tắc nhập liệu; danh sách 09 đầu mối và nhân sự; đặc tả eProcurement và văn thư; kết quả kiểm thử xâm nhập của đơn vị độc lập; số đo hiệu năng trên phần cứng của PVFCCo.
