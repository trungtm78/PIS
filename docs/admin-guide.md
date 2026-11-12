# Hướng dẫn quản trị hệ thống MACHVON

Tài liệu giao nhận theo yêu cầu TK.02 của hồ sơ kỹ thuật "Phần mềm quản lý ĐTXD" v0.3 (hướng dẫn quản trị), dành cho cán bộ quản trị của Ban CĐS&CNTT và quản trị tổ chức. Tài liệu tổng hợp lại từ các sổ tay vận hành đã có trong kho mã (đường dẫn ghi ở cuối mỗi mục) để người quản trị có một nơi bắt đầu; khi cần từng lệnh chi tiết, mở sổ tay được dẫn.

Hướng dẫn cho người dùng cuối nằm ở bộ hướng dẫn sử dụng theo chương (`scripts/hdsd/chapters.json`, dựng bởi `scripts/hdsd/build-docs.mjs`) và ở nút dấu hỏi (phím `?`) trên mỗi màn hình (594 màn hình). Tích hợp với HPM: `docs/integration/hpm-proposal.md`. Kết nối Power BI: `docs/integration/power-bi-model.md`, `docs/integration/power-bi-connection-guide.md`. Cấp dữ liệu cho Data Lakehouse: `docs/integration/lakehouse-proposal.md`. Cấu hình máy chủ khuyến nghị: `docs/runbooks/infra/sizing-uat-prod.md`. Hỗ trợ, trực và báo cáo bảo trì: `docs/delivery/12-maintenance-and-hypercare.md`.

Mục lục: 0 các lớp quản trị; 1 vai trò và quyền; 2 quy tắc; 3 lịch; 4 danh mục; 5 trung tâm tích hợp; 6 sao lưu và khôi phục; 7 nhật ký kiểm toán và giới hạn log; 8 nâng cấp và quay lui; 9 vận hành thường ngày; 10 bảng tra cứu; 11 việc chờ thông tin bên ngoài; 12 cài đặt và cấu hình ban đầu; 13 giám sát; 14 xử lý sự cố.

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
1. Tạo cây đơn vị ở ADM-01. Hồ sơ kỹ thuật nêu 09 đầu mối nhập liệu (07 Ban/Đơn vị và 02 Tổ dự án) cùng Ban KHĐT tổng hợp và lãnh đạo. Với PVFCCo không nhập tay từng đơn vị mà nạp **gói cấu hình mẫu `PVFCCO-TEMPLATE`** (ENT-3d): đăng ký lô chuyển đổi dữ liệu ở ADM-13 với bộ ánh xạ `ORG-PACK-1`, chạy thử, người khác người đăng ký áp dụng, rồi thao tác `materialiseEnterpriseOrgPack` tạo đơn vị, vai trò theo phạm vi, quy trình duyệt nhiều bước, chính sách vắng mặt, ma trận thẩm quyền và các danh mục (người duyệt các bản nháp quy tắc và ma trận là người khác). Màn ORG-01 hiển thị tổ chức, vai trò và kết quả đối chiếu (đủ, thiếu, lệch) ở chế độ chỉ đọc. Gói chỉ là dữ liệu mẫu: tên hai Tổ dự án để `[tên 02 Tổ dự án]`, không có người dùng hay tài khoản thật; thay bằng danh sách thật của PVFCCo khi có (PX-05). Một tenant, các đơn vị là cây con; vai trò nhập và duyệt đơn vị có phạm vi `UNIT_ONLY`, rà soát kế hoạch, chốt kỳ, xem lãnh đạo và quản trị có phạm vi toàn tenant.
2. Mời hoặc tạo thành viên ở ADM-02, gán vai trò ở ADM-03. Một vai trò được cấp theo đơn vị: quyền chỉ có hiệu lực trong đơn vị đó và các đơn vị con. Quyền "trên toàn tenant" (ví dụ xuất nhật ký kiểm toán) không cấp theo cây con.
3. Thành viên khách của nhà thầu (ADM-17) chỉ thấy cổng nhà thầu.
4. Đăng nhập một lần (SSO), LDAP/Active Directory và xác thực đa yếu tố (MFA) do Keycloak đảm nhiệm; mục 9 nêu cách vận hành Keycloak. Ánh xạ nhóm AD (`infra/keycloak/onprem/ad-group-role-map.json`) có hai phần: vai trò của nền tảng (quản trị hệ thống, vận hành nền tảng, thanh toán dịch vụ, hỗ trợ) và `tenantMappings` cho vai trò nghiệp vụ của tenant, sinh từ gói PVFCCO-TEMPLATE theo dạng `MACHVON-PVFCCO-<ĐƠN VỊ>-<VAI TRÒ>`; `npm run infra:check` kiểm hai phần khớp gói. Tên nhóm AD thật do đội thư mục của PVFCCo tạo (PX-16).

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
1. Mở HUB-01: xem bộ kết nối nào đang `FRESH`, `AGING`, `STALE` hay `NEVER_PUSHED` (chưa từng đẩy, không có cảnh báo) và còn sự cố mở.
2. Sự cố mở ở HUB-03: nhận, ghi nguyên nhân, đóng; cảnh báo `CONNECTOR_FAILING`, `CONNECTOR_STALE`, `HPM_PUSH_FAILED`, `HPM_PUSH_STALE` thuộc chủ xử lý là quản trị tích hợp.
3. Bí mật không nằm trong cơ sở dữ liệu, chỉ có tham chiếu `secret://`; đổi bí mật theo `docs/runbooks/infra/secrets-rotation.md`.
4. Bộ kết nối chờ thông tin của khách (HPM, EBS, eProcurement, văn thư) hiện nhãn `PENDING-EXTERNAL`: chạy bằng giả định, chưa được nghiệm thu cho tới khi có đặc tả và xác nhận của bên kia.

**API mở và Power BI.** INT-01 tạo tài khoản máy (khóa bí mật hiện một lần, lưu SHA-256). Đổi khóa giữ khóa cũ trong 0 đến 72 giờ (mặc định 24). INT-04 bật từng tập dữ liệu chứng nhận (DS-DISB giải ngân, DS-CTR hợp đồng) và cấp tài khoản cơ sở dữ liệu chỉ-đọc cho Power BI/Lakehouse (mật khẩu hiện một lần). Gói cài ngoại tuyến có sẵn cổng chỉ-đọc của cơ sở dữ liệu cho công cụ BI nhưng **đóng theo mặc định**: chỉ mở khi vận hành đặt `MACHVON_BI=on` và chạy `install.sh --with-bi`, kèm địa chỉ nghe, danh sách địa chỉ nguồn, chứng thư TLS và nơi gửi nhật ký (`docs/runbooks/infra/bi-port.md`). Khi cổng mở, ảnh cơ sở dữ liệu đã có `pgaudit` (chế độ theo đối tượng: mọi lần đọc view của lược đồ `machvon_bi` đều được ghi kèm tên tài khoản và địa chỉ nguồn), `log_connections` được bật và nhật ký từng ngày được gửi ra khỏi máy chủ; không cần tự đặt `pgaudit.log`. Chi tiết: `docs/open-api.md`, `docs/integration/power-bi-model.md`.

Sổ tay: `docs/runbooks/integration-connectors.md`, `docs/hpm-ebs-connectors.md`.

## 6. Sao lưu và khôi phục

Mục tiêu: RPO 15 phút, RTO 4 giờ, khôi phục về thời điểm bất kỳ trong 35 ngày (cấu hình, kiểm bằng `node scripts/backup-verify.mjs`).

| Việc | Lịch |
|---|---|
| Lưu WAL liên tục | tối đa 60 giây một đoạn |
| Sao lưu đầy đủ (chu kỳ ngày) | hằng ngày 01:30 |
| Sao lưu gia tăng (chu kỳ ngày) | 05:30, 09:30, 13:30, 17:30, 21:30 |
| Sao lưu khác biệt, differential (chu kỳ tuần) | Chủ nhật 12:30; giữ năm bản gần nhất |
| Sao lưu đầy đủ vào kho lưu trữ (chu kỳ tháng) | ngày 1 hằng tháng 03:00, vào kho thứ hai (`repo2`) với khóa mã hóa riêng; giữ mười hai bản |
| Kiểm tra kho sao lưu | Chủ nhật 03:30 |
| Sao lưu thủ công | Yêu cầu ở ADM-32 (đầy đủ, khác biệt hoặc gia tăng), người khác người yêu cầu duyệt, máy chủ chạy; giao diện không tự chạy sao lưu |
| Diễn tập khôi phục | mỗi quý và khi thêm thành phần giữ dữ liệu tenant |

Chính sách giữ tối thiểu ba bản sao lưu gần nhất (`retention.minimumBackups`): kiểm tra từ chối cấu hình giữ ít hơn ba. Bản sao lưu đầy đủ hằng ngày phủ 35 ngày; ngoài ra mỗi tháng một bản ngoại tuyến do hai người giữ khóa (không phải quản trị hệ thống máy chủ sản xuất) chép ra phương tiện ghi một lần hoặc ngắt kết nối, để một bản sao sống sót cả khi kẻ tấn công nắm quyền quản trị (yêu cầu YCK.07): `docs/runbooks/infra/backup-immutable.md`. Biên bản diễn tập khôi phục đầu tiên chưa có: sổ `infra/backup/restore-drill-ledger.json` còn trống, hạn diễn tập đầu là 2027-01-31 (chạy trên máy chủ của PVFCCo, PX-11).

Bản sao nằm ở địa điểm thứ hai, khóa đối tượng chế độ COMPLIANCE giữ 36 ngày (không ai kể cả quản trị kho xóa được), mã hóa hai lớp, danh tính ghi và danh tính quản trị kho là hai người khác nhau. Đây là lớp chống mã độc tống tiền: kẻ chiếm quyền quản trị cũng không xóa được bản sao.

Cảnh báo `pg-wal-archive-failure` và `pg-backup-age` (quá 26 giờ) đi qua kênh trực vận hành độc lập với mô-đun thông báo.

Diễn tập khôi phục (`docs/runbooks/infra/restore-drill.md`): đóng băng chuẩn trên máy dự phòng, khôi phục vào máy sạch tới thời điểm X, so sánh ba chuỗi băm SHA-256 giữa nguồn và bản khôi phục, chạy thử ứng dụng cô lập, ghi biên bản (phiên bản, mốc khôi phục, thời gian thực so với RTO, tên hai người ký), rồi hủy máy khôi phục vì nó chứa dữ liệu thật. Khôi phục dữ liệu riêng một tenant: `docs/sas-tenant-restore.md`, `docs/runbooks/tenant-restore-drill.md`.

Sổ tay: `docs/runbooks/infra/backup-immutable.md`, `docs/runbooks/infra/postgres.md`.

## 7. Nhật ký kiểm toán và giới hạn log

Màn hình ADM-11 Nhật ký kiểm toán (xem, lọc, xuất); ADM-12 Chính sách lưu trữ; ADM-29 Nhật ký đủ trước và sau theo loại đối tượng; ADM-30 Giới hạn số lượng và dung lượng log.

**Giá trị trước và sau (ADM-29).** Mặc định nhật ký chỉ lưu bản khác biệt đã làm sạch (`safe_diff`). Quản trị bật theo từng loại đối tượng nghiệp vụ (kỳ báo cáo mở lại, đẩy HPM, bản chốt, số liệu kỳ...) thì lệnh nào truyền `detail: { before, after }` sẽ được ghi giá trị đủ trước và sau vào bản ghi chỉ thêm `audit_event_detail`; dòng nhật ký có chữ ký giữ băm SHA-256 và kích thước của chi tiết nên sửa chi tiết về sau sẽ bị phát hiện. Quyền `adm.audit_detail.manage` trên toàn tenant, phải nêu lý do, bản thân thay đổi cũng được ghi nhật ký; mỗi loại có hạn mức byte cho một dòng, vượt thì chi tiết bị cắt bớt và đánh dấu `truncated`. Giá trị nhạy cảm (mật khẩu, mã thông báo, số giống số thẻ, trường cá nhân) bị che. Mặc định tắt: bật khi cần truy vết chi tiết, vì chi phí dung lượng. Chi tiết: `docs/runbooks/audit-export.md`.

**Giới hạn log (ADM-30).** Mỗi loại log có hạn mức số dòng, số byte và tỷ lệ cảnh báo `warn_pct` (mặc định 80). Quyền `adm.log_capacity.read` và `adm.log_capacity.manage` trên toàn tenant. Quy tắc không bao giờ xóa bằng chứng nghiệp vụ:
- loại kỹ thuật (hộp thư gửi, hộp sự kiện, phiên, lần gửi) vượt hạn mức thì ban đêm hệ thống chép các dòng cũ nhất vượt hạn mức ra tệp JSON lines có băm (`log_archive_batch`) rồi mới xóa đúng các dòng đã chép; không bao giờ xóa dòng trẻ hơn thời hạn lưu tối thiểu của nền tảng hay dòng đang bị giữ pháp lý;
- nhật ký kiểm toán và chi tiết của nó chỉ được giám sát (cảnh báo, không bao giờ xóa);
- hạn mức không được thấp hơn số dòng mà thời hạn lưu tối thiểu bắt buộc giữ (bị từ chối khi đặt), nên không dùng được để rút ngắn thời hạn lưu.
Cảnh báo `LOG_CAPACITY_NEAR` (tới `warn_pct`) và `LOG_CAPACITY_EXCEEDED` (nghiêm trọng, vượt hạn mức mà chưa dọn được) có sổ tay ở `docs/runbooks/alerts/`. Khi vượt hạn mức: mở ADM-30 xem "dòng đủ điều kiện" và "dòng được bảo vệ"; nâng hạn mức kèm lý do, không rút ngắn thời hạn lưu. Chi tiết: `docs/runbooks/retention.md`.

### Xuất nhật ký kiểm toán

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

Khuyến nghị cho PVFCCo: cài UAT trước, sau đó mới nâng cấp Production trong khung giờ bảo trì; UAT có cấu hình tương đương Production (đây cũng là điều kiện của kiểm thử xâm nhập, yêu cầu YCK.07). Không nâng cấp trong cửa sổ kỳ chốt: xem lịch hỗ trợ kỳ chốt và quy tắc đóng băng ở `docs/delivery/12-maintenance-and-hypercare.md`.

## 9. Vận hành thường ngày

- **Danh tính.** Keycloak (`docs/runbooks/infra/keycloak.md`): quản trị Keycloak đầu tiên đăng nhập một lần rồi tạo quản trị có tên với WebAuthn và tắt tài khoản khởi tạo; liên kết thư mục (AD/LDAP); mỗi người đăng ký yếu tố thứ hai ở lần đăng nhập đầu và vai trò nền tảng bắt buộc WebAuthn (chính sách "MFA khi truy cập từ ngoài mạng nội bộ" của HT.02 cần được xác nhận và cấu hình khi cài tại PVFCCo); xuất realm định kỳ (không chứa mật khẩu); đăng nhập thất bại hàng loạt từ một nguồn là dấu hiệu dò mật khẩu: siết phát hiện brute-force và chặn nguồn ở biên.
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

## 12. Cài đặt và cấu hình ban đầu

Cấu hình máy chủ khuyến nghị cho UAT và Production: `docs/runbooks/infra/sizing-uat-prod.md` (con số xuất phát, đo lại trên phần cứng của PVFCCo trong đợt UAT). Thứ tự khuyến nghị: UAT trước, Production sau, cùng một gói cài đặt.

**Phần A. Cài hạ tầng** (Ban CĐS&CNTT; chi tiết `docs/runbooks/infra/onprem-install.md`, danh mục kiểm tra phòng thí nghiệm `docs/runbooks/infra/lab-install-checklist.md`).

| Bước | Việc | Kiểm tra |
|---|---|---|
| A1 | Nhận gói ngoại tuyến; kiểm chữ ký và `sha256sum --check SHA256SUMS` | Không có tệp lệch |
| A2 | Chuẩn bị máy chủ theo yêu cầu: Linux amd64 hoặc arm64, Docker Engine 28 trở lên, Compose v2.24 trở lên, NTP, DNS và chứng thư cho `PUBLIC_HOST` và `CONTROL_HOST`, LDAPS tới thư mục, kho đối tượng có khóa đối tượng ở địa điểm thứ hai | Bảng "Host requirements" của runbook |
| A3 | Sao chép `infra/onprem/compose/env.template` thành `.env` và điền (tên máy chủ, thư mục, kho sao lưu, kích thước) | Không còn giá trị mẫu |
| A4 | Tạo các tệp bí mật theo `infra/onprem/secrets.json` (chủ root, nhóm `machvon-secrets`, quyền 0440); giữ hộ hai người khóa mã hóa sao lưu `pgbackrest_cipher_pass` ngoại tuyến | `install.sh` từ chối nếu quyền sai |
| A5 | Áp quy tắc tường lửa đường ra (`egress-firewall.sh`): chỉ cơ sở dữ liệu (WAL và sao lưu), tác vụ sao lưu và Keycloak có đường ra, tới kho đối tượng và thư mục | Ứng dụng và dữ liệu không có đường ra |
| A6 | Tạo kho sao lưu bất biến (`infra/backup/bucket/create-bucket.sh`) và danh tính ghi | `node scripts/backup-verify.mjs live ... --probe` |
| A7 | Chạy `sh install.sh`; cài và bật các bộ hẹn giờ systemd (`machvon-backup-*.timer`) | `docker compose ps` mọi dịch vụ khỏe; `/api/health/ready` trả 200 |
| A8 | Keycloak: đăng nhập quản trị khởi tạo một lần, tạo quản trị có tên với WebAuthn, tắt tài khoản khởi tạo; nhập thử realm, kiểm tra liên kết thư mục và đồng bộ đầy đủ | `docs/security/identity-test-plan.md` |
| A9 | Sao lưu đầu tiên và diễn tập khôi phục đầu tiên trước khi nhập dữ liệu thật | `restore-drill.md`; biên bản vào `infra/backup/restore-drill-ledger.json` |
| A10 | TLS và tiêu đề an toàn | `docs/runbooks/infra/tls-headers.md` cuối tài liệu |

**Phần B. Cấu hình ứng dụng** (quản trị tổ chức; mỗi thay đổi tạo phiên bản mới, người công bố khác người soạn).

| Bước | Việc | Màn hình | Ghi chú |
|---|---|---|---|
| B1 | Nạp gói cấu hình PVFCCO-TEMPLATE: đơn vị, vai trò theo phạm vi, quy trình duyệt, ma trận thẩm quyền, danh mục | ADM-13, ORG-01 | Mục 1; thay bằng danh sách thật khi có (PX-05) |
| B2 | Đăng ký nhóm AD cho vai trò nghiệp vụ; mời người dùng, gán vai trò | ADM-02, ADM-03 | Tên nhóm AD thật: PX-16 |
| B3 | Lịch làm việc và ngày nghỉ của năm; năm ngân sách và lịch kỳ báo cáo | ADM-07, MDM-11 | Nhập ngày nghỉ năm sau trước khi năm đó bắt đầu |
| B4 | Hạn từng bước của lịch kỳ (tháng, quý, năm, giao ban) | ADM-31, kho quy tắc ADM-19 | Giá trị mặc định là của nhà cung cấp, chưa kiểm chứng; Ban KHĐT chốt |
| B5 | Từ điển chỉ tiêu, quy tắc nhập liệu, bảng ánh xạ Excel | IND-01, IND-02, IND-03, ADM-19 | Bộ khởi điểm đánh dấu chưa kiểm chứng (PX-02) |
| B6 | Danh mục dùng chung: nguồn vốn, đơn vị tính, tỷ giá, loại báo cáo, cơ quan nhận, nguyên nhân chậm | MDM-01 và các màn theo loại | Mục 4 |
| B7 | Bố cục biểu mẫu nội bộ; sáu biểu mẫu của PVN giữ nhãn DEMO tới khi có mẫu chính thức | RPT-07, RPT-08 | PX-01, PX-15 |
| B8 | Kết nối ngoài: HPM, EBS, eProcurement, văn thư; ánh xạ mã dự án | HUB-01, HPM-01, EBS-01, INT-03 | Nhãn PENDING-EXTERNAL cho tới khi có đặc tả (PX-03, PX-04, PX-06, PX-07) |
| B9 | Nhật ký trước và sau theo loại đối tượng; giới hạn log | ADM-29, ADM-30 | Mục 7 |
| B10 | Tài khoản máy và tài khoản BI; bật và chứng nhận tập dữ liệu | INT-01, INT-04, DGV-18 | `docs/integration/lakehouse-proposal.md` |
| B11 | Gửi biểu mẫu theo lịch bằng email; nhắc việc qua Teams | RML-01; kênh thông báo theo `docs/teams-relay.md` và `docs/runbooks/notification-delivery.md` | Cần SMTP và địa chỉ Teams (PX-16) |
| B12 | Chính sách an toàn, lưu trữ | ADM-12, ADM-14 | |

**Phần C. Nghiệm thu cấu hình**: chạy các việc của danh mục kiểm tra `docs/delivery/10-handover-checklist.md` mục 1 và 2; chạy lượt UAT trên UAT (`docs/delivery/05-sit-uat-scripts.md`); ghi các điểm lệch vào sổ nợ.

## 13. Giám sát

Nguyên tắc: đường cảnh báo vận hành độc lập với sản phẩm (cảnh báo đi tới kênh trực `ops-pager`, không qua mô-đun thông báo), nên vẫn tới người trực khi sản phẩm ngừng. Quy tắc cảnh báo của hạ tầng ở `infra/alerts/`, của ứng dụng ở `alerts/rules/`; mỗi quy tắc có chủ và sổ tay ở `docs/runbooks/alerts/` (hơn 50 tệp), `npm run alerts:check` bảo đảm không quy tắc nào thiếu. Mục tiêu dịch vụ: 99,9 phần trăm yêu cầu hợp lệ được trả lời trong 30 ngày cho năm dịch vụ lõi (DIS, CAP, PAY, PRJ, IAM), tức ngân sách lỗi 43,2 phút; hai cảnh báo tốc độ tiêu ngân sách (`SLO_FAST_BURN`, `SLO_SLOW_BURN`) và `SLO_BUDGET_EXHAUSTED` (`docs/slo-error-budget.md`). Chưa phải cam kết thương mại: điều khoản của nó thuộc hợp đồng (D10).

| Cần theo dõi | Ở đâu | Tần suất | Ngưỡng hành động |
|---|---|---|---|
| Sức khỏe dịch vụ, ngân sách lỗi | Bảng điều khiển hạ tầng; `docs/runbooks/infra/observability.md`; SAS-18 (nhà cung cấp) | Hằng ngày | Cảnh báo SLO; `collector-down` (không có số liệu trong 5 phút thì mọi cảnh báo khác bị che) |
| Thời gian phản hồi dưới 5 giây, báo cáo dưới 20 giây (HT.05) | BI-13 Nhật ký truy vấn và hiệu năng; `node scripts/perf-budget.mjs`; ngân sách `docs/qa/perf-budget.json` (82 thao tác: 67 chức năng, 15 báo cáo) | Hằng tuần, và sau mỗi bản phát hành | p95 vượt ngân sách ở lượt đo; số đo trên phần cứng của PVFCCo chờ PX-10 |
| Sao lưu | Cảnh báo `pg-wal-archive-failure`, `pg-backup-age` (quá 26 giờ); trạng thái trên ADM-32 | Hằng ngày | Bản đầy đủ gần nhất cũ hơn 26 giờ; lưu WAL lỗi |
| Hàng đợi sự kiện và thông báo | Cảnh báo `OUTBOX_LAG`, `OUTBOX_EVENT_DEAD`, `NOTIFICATION_DLQ_BACKLOG`, `CHANNEL_CIRCUIT_OPEN`, `JOB_FAILED` | Hằng ngày | Theo sổ tay từng cảnh báo; `docs/runbooks/outbox-relay-lag.md`, `notification-delivery.md`, `jobs.md` |
| Kết nối ngoài | HUB-01 (`FRESH`, `AGING`, `STALE`, `NEVER_PUSHED`), HUB-03 sự cố, HPM-01 nhật ký đẩy; cảnh báo `CONNECTOR_FAILING`, `CONNECTOR_STALE`, `HPM_PUSH_FAILED`, `HPM_PUSH_STALE`; INT-05 nhật ký truy cập API mở | Hằng ngày; dày hơn trong cửa sổ kỳ chốt | Có sự cố mở; lần giao thành công gần nhất quá cũ |
| Tiến độ nhập liệu kỳ báo cáo | DIS-34 (trạng thái nhập liệu theo đầu mối, hạn từng bước), thông báo quá hạn của quy trình duyệt (`ADM_APPROVAL_OVERDUE`) | Hằng ngày trong kỳ chốt | Đầu mối quá hạn |
| Dung lượng log và nhật ký | ADM-30; cảnh báo `LOG_CAPACITY_NEAR`, `LOG_CAPACITY_EXCEEDED` | Hằng tuần | Tới `warn_pct` |
| Toàn vẹn nhật ký kiểm toán | `AUDIT_CHAIN_BROKEN` (nghiêm trọng) | Liên tục | Chuỗi niêm đứt: `docs/runbooks/audit-tamper-drill.md` |
| Truy cập bất thường | `AUTHZ_DENY_SPIKE`, `ACCESS_REVOCATION_LAG`; đăng nhập thất bại hàng loạt ở Keycloak | Hằng ngày | Mục 9 (danh tính) |
| Bản vá và chuỗi cung ứng | `npm run supply-chain:check -- --audit`, SBOM; `docs/runbooks/supply-chain.md` | Hằng tháng và khi có thông báo lỗ hổng | Lỗ hổng mức nghiêm trọng hoặc cao: vá theo cam kết hợp đồng |
| Hạn giấy phép, chứng nhận tập dữ liệu | `LICENSE_EXPIRING`; cột `certified_until` của `v_dataset_catalogue` | Hằng tuần | Còn dưới 14 ngày |

Tổng hợp theo tháng vào báo cáo bảo trì định kỳ: mẫu và nguồn từng ô ở `docs/delivery/12-maintenance-and-hypercare.md`.

## 14. Xử lý sự cố

Mức độ và thời hạn phản hồi, đường chuyển cấp, danh bạ trực: `docs/delivery/12-maintenance-and-hypercare.md` (mô hình P0 đến P3 theo thiết kế ST-KERNEL-105; cam kết khắc phục sự cố trong vòng 24 giờ là cam kết hợp đồng; thời hạn phản hồi từng mức do hai bên chốt, quyết định D10).

Quy trình chung cho quản trị:
1. **Nhận biết**: cảnh báo từ kênh trực, báo của người dùng, hoặc bất thường ở bảng giám sát (mục 13). Ghi giờ phát hiện, ai báo, hiện tượng; không sửa gì trước khi ghi.
2. **Phân loại**: mất toàn bộ dịch vụ hoặc nghi lộ dữ liệu là mức cao nhất (P0, gọi người trực ngay); sự cố một phân hệ hoặc một kết nối ngoài thấp hơn. Mọi nghi ngờ lộ dữ liệu hoặc xâm nhập báo cho Ban CĐS&CNTT và cán bộ an toàn thông tin ngay.
3. **Cô lập và giảm thiểu**: thay đổi nằm sau cờ tính năng thì nhờ nhà cung cấp tắt cờ (SAS-20); kết nối ngoài lỗi thì tạm dừng đúng kết nối đó (ví dụ trạng thái kết nối HPM ở HPM-01) và xem HUB-02, HUB-03, không ảnh hưởng phần còn lại; nghi lộ bí mật thì xoay bí mật theo mục "A leaked secret" của `docs/runbooks/infra/secrets-rotation.md`; tài khoản BI hoặc tài khoản máy nghi lộ thì thu hồi ở INT-04 hoặc INT-01.
4. **Chẩn đoán** theo sổ tay của đúng cảnh báo (`docs/runbooks/alerts/<MÃ>.md`); nhật ký kiểm toán (ADM-11) cho biết ai làm gì và khi nào; nhật ký truy cập API mở (INT-05).
5. **Khắc phục**: sự cố do bản phát hành mới thì quay lui bằng `rollback.sh` của gói cũ (đích 15 phút, mục 8); lỗi dữ liệu thì khôi phục (mục 6), không quay lui bản; sự cố đẩy HPM thì theo bảng ở `docs/integration/hpm-proposal.md` mục 6 (đẩy lại cùng khóa, tăng `max_attempts`, đính chính).
6. **Xác nhận và đóng**: kiểm tra lại bằng cùng phép đo đã phát hiện (kênh cảnh báo yên lặng 15 phút, `/api/health/ready` trả 200, một màn hình mỗi mô-đun đang dùng); ghi nguyên nhân gốc, hành động đã làm, thời gian khắc phục vào hồ sơ sự cố; việc sửa gốc đi vào bản phát hành kế tiếp và vào báo cáo bảo trì.

Các tình huống thường gặp:

| Tình huống | Làm gì | Tài liệu |
|---|---|---|
| Dịch vụ không lên sau nâng cấp | Quay lui; không sửa migration đã chạy | `onprem-upgrade-rollback.md`, `rollback.md` |
| Mất dữ liệu hoặc hỏng cơ sở dữ liệu | Khôi phục về thời điểm bất kỳ trong 35 ngày (RPO 15 phút, RTO 4 giờ) | `restore-drill.md`; dữ liệu riêng một tenant: `docs/sas-tenant-restore.md` |
| Nghi mã độc tống tiền | Dựa vào bản sao khóa đối tượng COMPLIANCE và bản ngoại tuyến hằng tháng; không dùng tài khoản quản trị nghi bị chiếm | `backup-immutable.md`, `docs/runbooks/infra/malware-scan.md` |
| Chuỗi niêm nhật ký kiểm toán đứt | Cảnh báo nghiêm trọng; không xóa; đối chiếu bằng `verifyAuditExport` | `audit-tamper-drill.md` |
| Hàng đợi thông báo hoặc sự kiện tồn | Kiểm tra độ trễ, kênh đang mở mạch, thử lại | `outbox-relay-lag.md`, `notification-delivery.md` |
| HPM không nhận hoặc nhận lỗi | Xem lỗi ở HPM-01; đẩy lại cùng khóa hoặc sửa dữ liệu rồi phát hành bản mới | `docs/integration/hpm-proposal.md` mục 6 |
| Người dùng bị khóa hoặc không đăng nhập được | Kiểm tra Keycloak, nhóm AD, MFA; không tắt MFA | `docs/runbooks/infra/keycloak.md` |
| Kỳ báo cáo cần mở lại để sửa | Đề nghị mở lại có lý do, người thứ hai duyệt | DIS-22; `docs/dis-snapshot.md` |
| Lỗi số liệu phát hiện sau khi chốt | Mở lại kỳ rồi chốt phiên bản mới, hoặc điều chỉnh ở kỳ sau nếu đã gửi HPM | `docs/integration/hpm-proposal.md` mục 6.2 |
