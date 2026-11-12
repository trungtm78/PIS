# Đề xuất cấp dữ liệu cho Data Lakehouse của Tổng công ty (yêu cầu TH.02)

Tài liệu đề xuất của nhà cung cấp, gửi Ban CĐS&CNTT của PVFCCo và đơn vị vận hành Data Lakehouse. Căn cứ: hồ sơ kỹ thuật "Phần mềm quản lý ĐTXD" v0.3 (TH.02: cấp dữ liệu qua cơ sở dữ liệu hoặc API cho Data Lakehouse và công cụ báo cáo, không phát sinh phí bản quyền), `docs/open-api.md` (lane INT-1), migration `V2200` đến `V2202`, `packages/kernel/src/open-api.ts`, `packages/db/src/int-bi-reader-store.ts`. Mô hình dữ liệu cho Power BI: `power-bi-model.md`; hướng dẫn nối cho Chi nhánh QLPTDA: `power-bi-connection-guide.md`.

Trạng thái: **PENDING-EXTERNAL (PX-11)**. Phần phía MACHVON đã dựng và có kiểm thử, kể cả cổng cơ sở dữ liệu chỉ-đọc tùy chọn và `pgaudit` trong gói cài ngoại tuyến (lane INT-2, mục 6); phần phía Lakehouse (nền tảng, vùng mạng, công cụ nạp) và việc chọn đường mạng chưa có thông tin nên mọi điều ở mục 5 và phần lựa chọn của mục 6 là đề xuất, chưa chạy trên hạ tầng của PVFCCo. Cổng tùy chọn đã được kiểm tra bằng kiểm thử tĩnh (`npm run infra:check`) và kiểm thử chạy các tập lệnh quyết định, nhưng **chưa chạy thật trên máy Docker** (xem `docs/runbooks/infra/lab-install-checklist.md`, mục G2).

Hai phát hiện của đợt rà soát 2026-11-12 ảnh hưởng tới việc dùng cho PVFCCo, chi tiết ở mục 6 và mục 8: (1) gói cài ngoại tuyến không mở đường mạng tới cơ sở dữ liệu và ảnh chưa có `pgaudit` (**đã xử lý ở INT-2**: cổng chỉ-đọc tùy chọn, đóng theo mặc định, có danh sách địa chỉ nguồn, TLS, SCRAM, giới hạn kết nối và `pgaudit` kèm gửi nhật ký ra ngoài máy chủ; vẫn phải chờ PVFCCo chốt địa chỉ, chứng thư và nơi nhận nhật ký); (2) `DS-DISB` chỉ đọc bản chốt `PERIOD_CLOSE`, chưa có tập dữ liệu cho bản chốt `ENTERPRISE_CLOSE` của bản doanh nghiệp.

## 1. Điều đã có ở phía MACHVON

| Thành phần | Nội dung | Nơi đọc |
|---|---|---|
| Tài khoản BI chỉ-đọc vào cơ sở dữ liệu | Mỗi tài khoản (`machvon_bi_<12 ký tự hex>`) gắn đúng một tenant bằng chính tên đăng nhập; `NOSUPERUSER NOBYPASSRLS`; số kết nối 1 đến 20; mỗi câu lệnh tối đa 60 giây; mật khẩu hiện một lần, hệ thống chỉ giữ bản băm SCRAM-SHA-256 | INT-04; `docs/open-api.md` mục 4 |
| Các view chứng nhận | `machvon_bi.v_dataset_catalogue`, `v_disbursement_lines` (DS-DISB), `v_contract_lines` (DS-CTR); đọc **bản chụp đã đóng băng**, không đọc bảng sống | `power-bi-model.md` mục 3 |
| An ninh theo từng dòng (RLS) | View `security_invoker`; tenant lấy từ `machvon_bi.reader_binding` theo tên đăng nhập, không theo biến phiên `app.tenant_id`; bốn bảng nguồn có thêm chính sách `RESTRICTIVE bi_reader_boundary` cho vai trò nhóm `machvon_bi_reader`; chỉ cấp quyền theo cột | `V2200`, `V2202`; kiểm thử phủ định `packages/db/test/int-open-api.test.ts` |
| Cổng chứng nhận | Tập dữ liệu chỉ mở khi được bật ở INT-04, sản phẩm dữ liệu ở trạng thái CERTIFIED (DGV-18, BI-19) và chưa hết hạn; ngược lại view trả về không dòng nào và `v_dataset_catalogue` nêu lý do | `kernel/open-api.ts` hàm `datasetGate` |
| API mở `/open/v1` | Tài khoản máy (INT-01), OAuth 2 client credentials, mã truy cập 5 phút, giới hạn tần suất, phân trang `limit` tối đa 200; đọc dự án, mã dự án nhiều hệ thống, hai tập dữ liệu | `docs/open-api/openapi.json` |
| Nhật ký | API: `int_access_log` trong cùng giao dịch với lần đọc (INT-05); cơ sở dữ liệu: `pgaudit` chế độ theo đối tượng ghi mọi lần đọc view của `machvon_bi` kèm tên tài khoản và địa chỉ nguồn, nhật ký kết nối, gửi hằng ngày ra ngoài máy chủ (mục 6); `int_bi_reader_event` cho vòng đời tài khoản | `docs/open-api.md` mục 5; `docs/runbooks/infra/bi-port.md` |

## 2. Hai đường cấp dữ liệu và khi nào dùng

| Đường | Khối lượng | Dùng cho | Điểm cần chú ý |
|---|---|---|---|
| Cơ sở dữ liệu (tài khoản BI) | Lớn, truy vấn SQL, nạp theo lô | Nạp hai tập dữ liệu vào vùng thô của Lakehouse; Power BI chế độ Import | Cần bật cổng tùy chọn của gói cài đặt và PVFCCo chốt đường mạng (mục 6); chỉ hai tập chứng nhận |
| API mở | Nhỏ đến vừa | Danh mục dự án, mã dự án nhiều hệ thống (bảng chiều), hệ thống không nối được cơ sở dữ liệu | Giới hạn tần suất; mã truy cập 5 phút; không có thao tác ghi |

Khuyến nghị: **bảng sự kiện (giải ngân, hợp đồng) nạp qua cơ sở dữ liệu; bảng chiều (dự án, mã dự án) nạp qua API mở.** Hai đường cùng đọc dữ liệu đã chứng nhận nên không lệch nhau về nội dung.

## 3. Mô hình tài khoản đề xuất: một tài khoản cho mỗi ứng dụng đọc

PVFCCo dùng một tenant (quyết định R24 của rà soát kỹ thuật). Vì tài khoản BI gắn với tenant chứ không gắn với đơn vị, mỗi tài khoản đọc được toàn bộ dữ liệu chứng nhận của tenant.

| Tài khoản (nhãn ở INT-04) | Dùng bởi | Số kết nối | Ghi chú |
|---|---|---|---|
| `lakehouse-ingest` | Tác vụ nạp của Lakehouse | 2 đến 4 | Chỉ chạy theo lịch ở mục 4; không dùng chung với người |
| `powerbi-gateway` | Cổng dữ liệu tại chỗ của Power BI (Import) | 2 | Làm mới theo lịch |
| `analyst-<tên đơn vị>` (tùy chọn) | Cán bộ phân tích cần truy vấn tay (Chi nhánh QLPTDA, Ban KHĐT) | 1 | Có thể thu hồi riêng từng người; không dùng để nạp |

Nguyên tắc: không dùng chung một tài khoản cho nhiều ứng dụng để khi có sự cố thu hồi được đúng nơi (INT-04, đổi hoặc thu hồi); mật khẩu đặt trong kho thông tin xác thực của công cụ nạp, không để trong mã, tệp cấu hình hay tệp `.pbids`; đổi mật khẩu theo chu kỳ mà Ban CĐS&CNTT quy định ([khách điền: chu kỳ đổi mật khẩu tài khoản dịch vụ]).

**Phân quyền phía Lakehouse và phía công cụ báo cáo là việc của PVFCCo.** Tài khoản BI thấy mọi đơn vị của tenant. Nếu cần người của một đơn vị chỉ thấy dự án của đơn vị mình, phải đặt vai trò an ninh theo dòng ở lớp báo cáo (Power BI RLS theo `unit_id`) hoặc ở lớp chuẩn của Lakehouse; MACHVON không còn kiểm soát dữ liệu sau khi đã rời hệ thống.

## 4. Nhịp làm mới

Các view chỉ chứa bản chụp đóng băng của kỳ đã đóng, nên dữ liệu không đổi giữa các lần chốt; không cần đọc theo thời gian thực và không có lý do chạy làm mới nhiều lần trong ngày.

| Việc | Khi nào | Cách |
|---|---|---|
| Nạp định kỳ | Hằng ngày 02:00 theo giờ Hà Nội, ngoài giờ nhập liệu | Hỏi `v_dataset_catalogue` (đang mở không); so danh sách `snapshot_id` của từng `period_id` với vùng thô; chỉ nạp kỳ có `snapshot_id` mới hoặc chưa có |
| Nạp ngay sau khi chốt kỳ | Ban KHĐT chốt kỳ (bước `PERIOD_CLOSE`, mặc định ngày 12 sau cuối kỳ tháng theo `REPORTING_SCHEDULE`, xem `docs/delivery/12-maintenance-and-hypercare.md`) | Vận hành kích tay hoặc đặt thêm một lần chạy lúc 07:30 và 13:30 trong cửa sổ kỳ chốt; không cần gọi lại cả lịch sử |
| Làm mới Power BI | Hằng ngày 06:30 và sau khi nạp Lakehouse xong, trong cửa sổ kỳ chốt thêm 14:00 | Chế độ Import; xem `power-bi-model.md` mục 7 |
| Kiểm tra đối soát | Sau mỗi lần nạp | Mục 5.3 |
| Kiểm tra hạn chứng nhận | Hằng tuần | Cảnh báo khi `certification_expires_on` còn dưới 14 ngày; Ban quản trị dữ liệu gia hạn chứng nhận ở DGV-18 |

Các con số giờ trên là đề xuất xuất phát, chưa kiểm chứng; Ban CĐS&CNTT chỉnh theo lịch tải của Lakehouse. Kỳ tháng theo giá trị mặc định của quy tắc `REPORTING_SCHEDULE` (Ban KHĐT chỉnh được ở ADM-31): hạn nhập ngày 5, chốt kỳ ngày 12, đẩy HPM ngày 15 sau cuối tháng, nên nhu cầu nạp tập trung vào khoảng ngày 12 đến 16 của tháng sau.

## 5. Cách nạp vào Lakehouse

### 5.1 Vùng thô (bronze), nạp theo kỳ và thay cả kỳ

Một bản chụp đã đóng băng không đổi, nhưng khi một kỳ được chốt lại thì bản cũ chuyển sang "đã bị thay thế", biến khỏi view, và bản mới có `snapshot_id` khác. Vì vậy nạp theo kiểu thay cả kỳ, không cộng dồn:

```sql
-- Chạy trong một giao dịch ở phía Lakehouse, cho từng period_id cần nạp
BEGIN;
DELETE FROM bronze.machvon_disbursement_lines WHERE period_id = :period_id;
INSERT INTO bronze.machvon_disbursement_lines
SELECT *, now() AS loaded_at
FROM staging.machvon_disbursement_lines;   -- bản đọc từ machvon_bi.v_disbursement_lines của period_id đó
COMMIT;
```

Nguồn đọc (mỗi kỳ một lượt, không đọc cả bảng nhiều lần):

```sql
SELECT * FROM machvon_bi.v_disbursement_lines WHERE period_id = :period_id;
SELECT * FROM machvon_bi.v_contract_lines     WHERE period_id = :period_id;
```

Với hợp đồng, mỗi phiên bản (`revision`) của một kỳ là một bộ dòng riêng; giữ nhiều phiên bản trong vùng thô để theo dõi đính chính, và hướng dẫn rõ cho người dùng vùng chuẩn lấy `max(revision)` của kỳ (mục 4 của `power-bi-model.md` đã có truy vấn mẫu). Việc view có còn trả bản hợp đồng cũ sau khi kỳ được chốt lại hay không cần thử trên UAT bằng một kỳ chốt lại và ghi kết quả vào tài liệu này (mục 8, việc 3).

Kích thước dữ liệu: bản chụp giải ngân có tối đa một dòng cho mỗi (dự án, nhóm vốn `bucket`, cấp ngân sách); với phạm vi trong hồ sơ kỹ thuật (22 dự án đầu tư xây dựng, 01 hạng mục mua sắm tài sản dự án, 09 hạng mục mua sắm tài sản cố định, tức 32 mục) và 3 nhóm vốn, 2 cấp ngân sách, mỗi kỳ có tối đa 32 x 3 x 2 = 192 dòng. Khối lượng nhỏ: một lần nạp chạy trong vài giây và không đòi hỏi cụm Spark; công cụ ETL thông thường là đủ. Con số này suy ra từ hồ sơ, không phải số đo; đo lại trên dữ liệu UAT.

### 5.2 Vùng chuẩn (silver) và vùng phục vụ (gold)

- Vùng chuẩn: đổi tên cột sang quy ước của Lakehouse, ép kiểu (`*_vnd` là số nguyên đồng, kiểu `numeric(24,0)` hoặc `decimal(24,0)`, không dùng số thực), ghép `DimProject` từ API mở, giữ `snapshot_id` và `revision` làm dòng dõi.
- Vùng phục vụ: bảng theo chủ đề của từng báo cáo (giải ngân theo dự án và kỳ, giá trị hợp đồng và đã thanh toán). Tỷ lệ phải tính lại bằng tổng chia tổng, không cộng tỷ lệ của các dòng (`rate_total_pct` chỉ để xem từng dòng).
- Giải ngân là lũy kế: một kỳ lấy đúng bản chụp của kỳ đó; không cộng các kỳ với nhau.

### 5.3 Đối soát sau mỗi lần nạp

| Kiểm tra | Cách | Khi lệch |
|---|---|---|
| Số dòng và tổng | Với mỗi `period_id`: số dòng, `sum(plan_total_vnd)`, `sum(disbursed_treasury_vnd)` ở nguồn (truy vấn 8 của `power-bi-model.md` / `power-bi-sample-queries.sql`) so với vùng thô | Không công bố báo cáo cho tới khi giải trình; nạp lại kỳ lệch |
| Hạn chứng nhận | `certification_expires_on` còn hạn | Báo Ban quản trị dữ liệu |
| Kỳ biến mất | Kỳ đã có ở vùng thô nhưng nguồn trả không dòng | **Không xóa vùng thô**; coi là sự cố (chứng nhận hết hạn hoặc tập bị tắt), kiểm `v_dataset_catalogue.is_open` và `reason` |

### 5.4 Khi chứng nhận hết hạn hoặc tập bị tắt

View ngừng trả dòng, không báo lỗi. Tác vụ nạp phải coi "0 dòng cho một kỳ đã có" là lỗi, không phải dữ liệu mới; luôn đọc `v_dataset_catalogue` trước khi nạp.

## 6. Đường mạng và an ninh (điểm cần Ban CĐS&CNTT quyết)

**Hiện trạng gói cài đặt (INT-2).** Gói cài ngoại tuyến (`infra/onprem/compose/compose.yaml`) vẫn chỉ công bố cổng của lớp web: dịch vụ cơ sở dữ liệu nằm trong mạng `data` và **không có cổng ra ngoài theo mặc định**. Để công cụ ngoài đăng nhập tài khoản BI, gói có thêm một **cổng chỉ-đọc tùy chọn, đóng theo mặc định** (phương án B bên dưới, đã dựng): chỉ mở khi vận hành đặt `MACHVON_BI=on` và chạy `install.sh --with-bi`. Cổng gồm các lớp khóa, từ ngoài vào trong:

| Lớp | Nội dung | Nơi cấu hình |
|---|---|---|
| Địa chỉ nghe | Đúng một địa chỉ IPv4 của máy chủ do vận hành đặt (`BI_LISTEN_ADDRESS`, bắt buộc, không có mặc định); `0.0.0.0` bị từ chối, và `npm run infra:check` báo lỗi nếu tệp compose công bố cổng trên mọi địa chỉ | `compose.bi.yaml`; `config/bi-render.sh` |
| Tường lửa máy chủ | Chuỗi `MACHVON-BI` trong `DOCKER-USER`: chỉ nhận các địa chỉ nguồn `BI_ALLOWED_CIDRS` (mạng hẹp nhất /16, không nhận `0.0.0.0/0`), mỗi nguồn có giới hạn số kết nối mở (`BI_MAX_CONNECTIONS_PER_ADDRESS`), còn lại bị bỏ; `install.sh` không khởi động cổng khi chưa có chuỗi này | `config/bi-firewall.sh` |
| `pg_hba.conf` | Dựng từ cùng danh sách nguồn: tài khoản BI (thành viên `machvon_bi_reader`) chỉ vào được bằng `hostssl`, từ địa chỉ cho phép, vào cơ sở dữ liệu `machvon`, bằng `scram-sha-256`; mọi vai trò khác (ứng dụng, mặt phẳng điều khiển, Keycloak, chủ sở hữu) chỉ vào được từ các mạng nội bộ của bộ compose; dòng cuối từ chối | `config/pg_hba-bi.conf.template` |
| TLS | TLS 1.2 trở lên, chỉ bộ mã ECDHE; chứng thư và khóa là hai tệp bí mật `db_tls_cert`, `db_tls_key` do PVFCCo cấp | `secrets-bi.json`; `docker/bi-tls-prepare.sh` |
| SCRAM | `password_encryption=scram-sha-256`; hệ thống chỉ giữ bản băm | cấu hình cơ sở dữ liệu |
| Từng tài khoản | `NOSUPERUSER NOBYPASSRLS`, số kết nối 1 đến 20, mỗi câu lệnh tối đa 60 giây, một tenant, không quyền ghi | INT-04; `V2200` |
| Nhật ký đọc | Ảnh cơ sở dữ liệu có `pgaudit`, tải sẵn; ở chế độ theo đối tượng trên vai trò `machvon_bi_auditor` (được cấp SELECT trên mọi view của `machvon_bi`): mỗi lần đọc view ghi một dòng `AUDIT: OBJECT` kèm tên tài khoản và địa chỉ nguồn, kèm nhật ký kết nối, ngắt kết nối và đăng nhập sai, vào tệp từng ngày | `config/bi-audit-setup.sql` |
| Gửi nhật ký | Tập lệnh `bi-audit-ship.sh` chạy hằng ngày (bộ hẹn giờ `machvon-bi-audit-ship`) gửi từng ngày đã xong tới nơi nhận (`directory:` là thư mục của kho nhật ký PVFCCo, hoặc `syslog:máy:cổng` qua TCP), kiểm tra bản sao bằng SHA-256, ghi sổ; chỉ xóa tệp trên máy chủ khi đã quá thời hạn lưu (`BI_AUDIT_RETENTION_DAYS`, mặc định 400, không dưới 365) **và** đã gửi | `config/bi-audit-ship.sh` |

Cổng không được mở khi một giá trị còn trống hoặc sai: `bi-render.sh` từ chối nguồn rộng hơn /16, địa chỉ nghe `0.0.0.0` hoặc không phải IPv4, cổng dưới 1024, nơi nhận nhật ký không hợp lệ và thời hạn lưu dưới 365 ngày, và không ghi tệp nào khi từ chối. Các bước bật, kiểm tra (gồm các kiểm tra phủ định: không TLS, địa chỉ lạ, vai trò ứng dụng, vượt giới hạn kết nối), tắt và xoay chứng thư: `docs/runbooks/infra/bi-port.md`. Hai khóa địa chỉ nguồn (tường lửa và `pg_hba.conf`) độc lập nhau; nếu cấu hình Docker che địa chỉ của máy khách thì tường lửa vẫn giữ và các dòng `pg_hba.conf` của nhóm BI không khớp, nên kết nối thất bại chứ không mở.

Việc **chọn đường mạng vẫn thuộc PVFCCo** (PX-11). Ba phương án, theo thứ tự khuyến nghị:

| Phương án | Mô tả | Ưu | Nhược |
|---|---|---|---|
| A. Đọc từ máy chủ dự phòng (standby) của Production | Mở cổng cơ sở dữ liệu của máy dự phòng cho địa chỉ của cổng dữ liệu Power BI và của tác vụ nạp Lakehouse, chỉ qua TLS. Vai trò và ràng buộc tài khoản là dữ liệu của cơ sở dữ liệu nên được sao chép sang máy dự phòng; view chỉ đọc nên chạy được ở đó | Không thêm tải cho máy chủ chính; nhật ký đọc tách khỏi nhật ký giao dịch | Truy vấn dài có thể xung đột với việc phát lại WAL (cần đặt `max_standby_streaming_delay`); phải thử trên UAT; UAT một máy chủ không có máy dự phòng; gói cài đặt chưa có bộ compose riêng cho máy dự phòng nên cổng tùy chọn ở trên áp dụng cho máy chủ chính, việc áp cho máy dự phòng cần làm thêm khi PVFCCo chọn A |
| B. Cổng nghe riêng trên máy chủ chính (**đã dựng, tùy chọn**) | Cổng tùy chọn ở trên: một địa chỉ nghe, tường lửa chỉ cho địa chỉ của công cụ BI, `pg_hba.conf` chỉ cho `hostssl` và chỉ cho tài khoản `machvon_bi_%` | Đơn giản, dùng được cho UAT; có sẵn nhật ký `pgaudit` | Mở một cổng cơ sở dữ liệu trên máy chủ chính, trái với nguyên tắc "cơ sở dữ liệu không nối trực tiếp mạng ngoài" nếu không giới hạn chặt; cần có tường lửa của PVFCCo ngoài tường lửa máy chủ |
| C. Chỉ dùng API mở | Lakehouse và Power BI đọc cả hai tập dữ liệu qua `/open/v1` | Không mở cổng cơ sở dữ liệu; giới hạn tần suất và nhật ký truy cập sẵn | Chậm với khối lượng lớn (mỗi trang tối đa 200 dòng); khối lượng hiện tại nhỏ nên vẫn khả thi; không dùng được cho truy vấn tay |

Đề xuất: **dùng C ngay cho đợt UAT khi chưa có thông tin mạng** (không cần thay đổi hạ tầng), **chuyển sang A cho Production** khi Ban CĐS&CNTT chấp thuận mở cổng của máy dự phòng; B dùng cho UAT khi cần thử đường cơ sở dữ liệu, sau khi PVFCCo cấp địa chỉ nghe, địa chỉ nguồn, chứng thư và nơi nhận nhật ký.

Các yêu cầu an ninh áp dụng cho mọi phương án:

- TLS 1.2 trở lên với chứng thư do PVFCCo tin cậy (`sslmode=verify-full` ở phía Lakehouse khi có thể); không có đường ra Internet cho cơ sở dữ liệu. Cổng tùy chọn không nhận kết nối không TLS.
- Tường lửa cho phép đúng các địa chỉ nguồn của Lakehouse và của cổng dữ liệu; danh sách này do Ban CĐS&CNTT cấp và là giá trị `BI_ALLOWED_CIDRS` ([khách điền: địa chỉ nguồn của Lakehouse và của cổng dữ liệu Power BI, địa chỉ nghe, chứng thư của máy chủ cơ sở dữ liệu]).
- Ghi vết đọc: nhật ký của máy chủ cơ sở dữ liệu cho các tài khoản BI do cổng tùy chọn tự bật (`pgaudit` theo đối tượng, `log_connections`, `log_disconnections`), không cần đặt tay `pgaudit.log` hay `log_statement`. Nơi nhận nhật ký và thời hạn lưu ở phía PVFCCo ([khách điền: kho nhật ký hoặc máy thu syslog, thời hạn lưu, người được đọc]); mặc định phía MACHVON giữ 400 ngày trên máy chủ sau khi đã gửi.
- Tài khoản không có quyền ghi; thu hồi hoặc đổi mật khẩu ở INT-04 có hiệu lực ngay và ghi vào `int_bi_reader_event`.
- Dữ liệu đã nạp vào Lakehouse thuộc trách nhiệm của PVFCCo về phân loại, lưu giữ và phân quyền; tài liệu này không thay thế quy định an toàn thông tin của Tổng công ty.

## 7. Kế hoạch theo giai đoạn

| Giai đoạn | Nội dung | Điều kiện vào | Tiêu chí ra |
|---|---|---|---|
| L0 (đã có) | Hai tập chứng nhận, tài khoản BI, API mở, tài liệu và truy vấn mẫu | Không | Kiểm thử cách ly: tài khoản BI đặt `app.tenant_id` sang tenant khác không đọc được gì |
| L1 | Chọn phương án đường mạng (mục 6) và bật cổng tùy chọn ở UAT (`bi-port.md`, danh mục G2 của `lab-install-checklist.md`); cấp tài khoản `powerbi-gateway` và `lakehouse-ingest` ở UAT; nạp thử một kỳ | PX-11 (hạ tầng UAT), thông tin Lakehouse (mục 9) | Đối soát mục 5.3 khớp cho một kỳ; nhật ký đọc có dòng `AUDIT: OBJECT` của tài khoản và đã được gửi tới nơi nhận |
| L2 | Chạy theo lịch mục 4 trong hai kỳ chốt thật; thử chốt lại một kỳ để xác nhận cách giữ `revision`; thử chứng nhận hết hạn | L1 xong; hai kỳ báo cáo thật (PX-13) | Không có kỳ lệch chưa giải trình; kỳ chốt lại thay đúng; hết hạn chứng nhận không xóa vùng thô |
| L3 | Mở rộng tập dữ liệu (mục 8, việc 1 và 2) và bảng chiều; đo hiệu năng trên phần cứng của PVFCCo (PX-10) | L2 xong | Báo cáo mẫu của Chi nhánh QLPTDA chạy trên dữ liệu thật |

Mỗi giai đoạn kết thúc bằng xác nhận của Ban CĐS&CNTT; cho tới đó mọi số liệu qua đường này mang nhãn PENDING-EXTERNAL và không dùng để nghiệm thu.

## 8. Hạn chế đã biết và việc đề xuất làm tiếp

1. **Chưa có view bảng chiều** (đơn vị, nguồn vốn, nhà thầu) cho tài khoản BI; chỉ có khóa. Đề xuất thêm `v_dim_unit`, `v_dim_fund_source`, `v_dim_contractor` cùng cơ chế cổng và chứng nhận. Trước mắt: tên dự án và mã dự án lấy từ API mở.
2. **Chưa có tập dữ liệu chứng nhận cho bản chốt kỳ doanh nghiệp** (số liệu vốn và chỉ tiêu theo đơn vị và dự án; thuyết minh không thuộc tập này). Đây là khoảng trống thật của TH.02 sau khi ENT-3a gộp: view `v_disbursement_lines` chỉ đọc bản chốt loại `PERIOD_CLOSE` (giải ngân theo Kho bạc của bản công), còn bản chốt của bản doanh nghiệp là loại `ENTERPRISE_CLOSE` (migration `V2660`) nên **không hiện ở `DS-DISB`**; với dữ liệu PVFCCo, Power BI và Lakehouse chỉ thấy `DS-DISB` khi tenant có thêm bản chốt `PERIOD_CLOSE`. Hiện chỉ có `DS-DISB` và `DS-CTR` (`OPEN_DATASETS`). Đề xuất tập `DS-ENT-SNAPSHOT` đọc bản chốt đã đóng băng, cùng cơ chế `security_invoker`, ràng buộc `bi_reader_boundary` và cổng chứng nhận; không cho đọc thẳng bảng nghiệp vụ. Việc cần làm: migration và view mới, thêm vào `OPEN_DATASETS`, API mở, kiểm thử cách ly; chưa có làn nhận việc.
3. **Cần thử trên UAT**: kỳ chốt lại với view hợp đồng (còn hiện bản cũ không); truy vấn dài trên máy dự phòng; hiệu năng ba truy vấn nạp trên phần cứng của PVFCCo (PX-10).
4. **Chưa có sự kiện thông báo "kỳ vừa chốt"** cho phía Lakehouse: hiện phía Lakehouse phải hỏi theo lịch (mục 4). Đề xuất phát sự kiện ra qua Integration Hub khi bản chốt được đóng băng; chỉ khi Lakehouse hỗ trợ nhận.
5. **Cổng mạng và `pgaudit` đã có trong gói cài đặt (INT-2) nhưng chưa chạy thật trên Docker** (mục 6): cần thử trên UAT theo danh mục G2 của `lab-install-checklist.md` (đầu cuối: hợp nhất tệp compose, khởi động PostgreSQL với các tham số này, quy tắc `DOCKER-USER`, dòng nhật ký `pgaudit`). Phương án A (máy dự phòng) chưa có bộ compose riêng. IPv6 chưa hỗ trợ. Đường mạng và nơi nhận nhật ký do PVFCCo chọn (PX-11).

## 9. Thông tin Ban CĐS&CNTT cần cung cấp

1. Nền tảng Lakehouse (tên, phiên bản, đặt trong mạng nào), công cụ nạp được phép dùng (Spark JDBC, Data Factory, ETL khác), đầu mối kỹ thuật.
2. Lakehouse nhận dữ liệu bằng cách nào: kéo từ cơ sở dữ liệu, gọi API, hay tệp thả vào vùng đặt trước.
3. Quy ước vùng (thô, chuẩn, phục vụ), quy ước tên bảng và cột, kiểu số tiền.
4. Quy định an toàn thông tin cho dữ liệu đưa vào Lakehouse: phân loại, mã hóa, lưu giữ, ai được đọc.
5. Địa chỉ nguồn cần cho phép ở tường lửa; vùng mạng của cổng dữ liệu Power BI.
6. Tần suất làm mới mong muốn của từng báo cáo và cửa sổ không được tải nặng.
7. Chu kỳ đổi mật khẩu tài khoản dịch vụ.

Các câu trả lời ghi vào sổ ở `docs/delivery/11-pending-external-register.md` (PX-11) khi nhận; khi đó chuyển tài liệu này từ đề xuất sang thiết kế đã xác nhận.

## 10. Phân công

| Việc | Bên làm |
|---|---|
| Cung cấp thông tin mục 9, mở đường mạng, chọn công cụ nạp, vận hành Lakehouse | Ban CĐS&CNTT |
| Cấp và thu hồi tài khoản BI, bật tập dữ liệu (INT-04), chứng nhận sản phẩm dữ liệu (DGV-18) | Quản trị tích hợp và Ban quản trị dữ liệu của PVFCCo |
| Phân quyền theo đơn vị ở lớp báo cáo và Lakehouse | PVFCCo |
| View chiều, tập dữ liệu bản chốt doanh nghiệp, kiểm thử cách ly và hiệu năng; cổng cơ sở dữ liệu tùy chọn và `pgaudit` trong gói cài đặt (đã dựng, INT-2) | Nhà cung cấp |

Lịch sửa: v0.1 2026-11-12 (rà soát lane aud4: tách khỏi `power-bi-model.md`, thêm mục 6 và 8 từ phát hiện về đường mạng và `pgaudit`); v0.2 2026-11-12 (lane INT-2: mục 6 và 8 cập nhật theo cổng chỉ-đọc tùy chọn và `pgaudit` đã có trong gói cài đặt).
