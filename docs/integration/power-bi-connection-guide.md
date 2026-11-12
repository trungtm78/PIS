# Hướng dẫn kết nối Power BI cho Chi nhánh QLPTDA (yêu cầu TH.02)

Dành cho cán bộ Chi nhánh Quản lý phát triển dự án (QLPTDA) làm báo cáo, và cán bộ Ban CĐS&CNTT quản trị tích hợp. Mục tiêu: dựng báo cáo Power BI về giải ngân và hợp đồng của các dự án trên dữ liệu **đã chứng nhận, chỉ đọc** của MACHVON, không đụng tới bảng nghiệp vụ và không phát sinh phí bản quyền. Mô hình dữ liệu: `power-bi-model.md`; tệp mô hình mẫu: `power-bi/machvon-sample-model.tmdl`; truy vấn mẫu: `power-bi-sample-queries.sql`; đề xuất cho Data Lakehouse: `lakehouse-proposal.md`.

Trạng thái: hướng dẫn dựng từ thiết kế và mã nguồn INT-1 và INT-2 (cổng cơ sở dữ liệu tùy chọn của gói cài đặt); **chưa chạy với Power BI Desktop và cơ sở dữ liệu của PVFCCo** (hạ tầng chờ PX-11), và cổng tùy chọn chưa chạy thật trên máy Docker. Các điểm chưa kiểm chứng ghi rõ ở từng bước.

## 1. Ai làm việc gì

| Bước | Người làm | Ở đâu |
|---|---|---|
| Xác nhận hai tập dữ liệu đã bật và được chứng nhận | Quản trị tích hợp; Ban quản trị dữ liệu | INT-04; DGV-18, BI-19 |
| Cấp tài khoản BI cho Power BI, ghi mật khẩu (chỉ hiện một lần) vào kho thông tin xác thực | Quản trị tích hợp | INT-04 |
| Cấp tài khoản máy cho API mở (lấy danh mục dự án) | Quản trị tích hợp | INT-01, INT-02 |
| Cấp địa chỉ nghe, địa chỉ nguồn của cổng dữ liệu, chứng thư và nơi nhận nhật ký; bật cổng cơ sở dữ liệu tùy chọn của gói cài đặt (`install.sh --with-bi`), hoặc chọn dùng API mở | Ban CĐS&CNTT, vận hành hạ tầng | `docs/runbooks/infra/bi-port.md`; phương án ở `lakehouse-proposal.md` mục 6 |
| Dựng mô hình, báo cáo, xuất bản, đặt lịch làm mới | Cán bộ làm báo cáo của Chi nhánh QLPTDA | Power BI Desktop và Service |
| Phân quyền xem theo đơn vị hoặc dự án trong báo cáo | Cán bộ làm báo cáo, Ban CĐS&CNTT | Vai trò an ninh theo dòng của Power BI |

## 2. Điều kiện cần có trước

1. Tập dữ liệu `DS-DISB` (giải ngân) và `DS-CTR` (hợp đồng) đã bật ở INT-04 và sản phẩm dữ liệu tương ứng ở trạng thái CERTIFIED, chưa hết hạn. Nếu chưa, các view trả về **không có dòng nào** mà không báo lỗi; `machvon_bi.v_dataset_catalogue` cho biết lý do (`DISABLED`, `NOT_CERTIFIED`, `EXPIRED`, `NO_BINDING`).
2. Có ít nhất một bản chốt kỳ loại `PERIOD_CLOSE` đã đóng băng (với `DS-DISB`) và một bản chụp hợp đồng đã đóng băng (với `DS-CTR`). Lưu ý với tenant bản doanh nghiệp: bản chốt của bản doanh nghiệp là loại `ENTERPRISE_CLOSE` và **chưa có trong các view** (xem `lakehouse-proposal.md` mục 8); cho tới khi có tập dữ liệu mới, báo cáo giải ngân chỉ có dữ liệu khi tenant có bản chốt `PERIOD_CLOSE`.
3. Cổng cơ sở dữ liệu đã được vận hành bật (theo mặc định **đóng**: gói cài ngoại tuyến chỉ mở cổng web; cổng chỉ-đọc cho công cụ BI chỉ có khi đặt `MACHVON_BI=on` và chạy `install.sh --with-bi`, xem mục 3a và `lakehouse-proposal.md` mục 6), hoặc dùng API mở cho toàn bộ dữ liệu.
4. Máy làm báo cáo: Power BI Desktop bản hiện hành. Đầu nối PostgreSQL của Power BI có thể yêu cầu thành phần `Npgsql`; làm theo thông báo của Power BI Desktop nếu nó yêu cầu (chưa thử trên máy của Chi nhánh).
5. Để làm mới theo lịch trên Power BI Service: cổng dữ liệu tại chỗ (on-premises data gateway) đặt trong mạng PVFCCo, vì cơ sở dữ liệu không mở ra Internet.

## 3. Cấp tài khoản (quản trị tích hợp)

1. Mở INT-04 (Tài khoản BI và tập dữ liệu chứng nhận). Kiểm tra `DS-DISB` và `DS-CTR` đang bật; bật nếu chưa (thao tác ghi nhật ký kiểm toán).
2. Nếu tập chưa được chứng nhận, Ban quản trị dữ liệu xử lý ở DGV-18 (Data product và chứng nhận) hoặc BI-19 (Chứng nhận chỉ tiêu và bộ dữ liệu); hạn chứng nhận hiện ở cột `certified_until` của `v_dataset_catalogue`.
3. Tạo tài khoản BI: đặt nhãn rõ ứng dụng dùng (ví dụ `powerbi-qlptda`), số kết nối 1 đến 20 (đề xuất 2 cho cổng dữ liệu). Hệ thống hiện **một lần** tên đăng nhập `machvon_bi_<12 ký tự hex>` và mật khẩu. Ghi mật khẩu vào kho thông tin xác thực của cổng dữ liệu hoặc kho bí mật của PVFCCo; không gửi qua thư, không ghi vào tệp mô hình hay tệp `.pbids`. Mất mật khẩu thì đổi mật khẩu ở INT-04 (cấp lại).
4. Giao cho cán bộ làm báo cáo: máy chủ và cổng, tên cơ sở dữ liệu, tên đăng nhập (mật khẩu giao qua kênh riêng).
5. Trước khi cấp tài khoản đầu tiên: bảo đảm cổng tùy chọn đã bật cùng nhật ký đọc (mục 3a: ảnh cơ sở dữ liệu của gói có `pgaudit`, cổng tự ghi mọi lần đọc view của `machvon_bi` và gửi nhật ký ra ngoài; không phải đặt tay `pgaudit.log`). Nếu cổng chưa bật thì chưa có công cụ ngoài nào đăng nhập được, nên cũng chưa cấp tài khoản.
6. Nếu cần danh mục dự án (tên, mã, đơn vị chủ quản, mã nhiều hệ thống): INT-01 tạo tài khoản máy, INT-02 cấp phạm vi `open.projects.read` và khóa; khóa bí mật hiện một lần.

### 3a. Cổng cơ sở dữ liệu của gói cài đặt (vận hành hạ tầng, Ban CĐS&CNTT)

Chi tiết từng bước và kiểm tra: `docs/runbooks/infra/bi-port.md`. Tóm tắt cho người làm báo cáo để biết mình nhận được gì:

- Cổng chỉ có khi vận hành bật; địa chỉ nghe, cổng (mặc định 5433), tên cơ sở dữ liệu `machvon` do vận hành giao. Tài khoản BI chỉ vào được bằng **TLS 1.2 trở lên** và mật khẩu SCRAM, **từ các địa chỉ nguồn đã khai** (máy chạy cổng dữ liệu, máy nạp Lakehouse). Máy làm báo cáo cá nhân không nối thẳng được trừ khi địa chỉ của máy nằm trong danh sách đó; làm mới theo lịch đi qua cổng dữ liệu.
- Mỗi nguồn bị giới hạn số kết nối mở (mặc định 20) và mỗi tài khoản có giới hạn riêng (1 đến 20, đặt ở INT-04); vượt giới hạn thì kết nối bị từ chối hoặc bỏ.
- Mọi lần đọc view của `machvon_bi` được ghi (tên tài khoản, thời điểm, địa chỉ nguồn, câu lệnh) bằng `pgaudit` và gửi hằng ngày ra ngoài máy chủ; vì vậy đặt tên tài khoản theo ứng dụng (mục 3, bước 3) để nhật ký chỉ rõ ai đọc.
- Kiểu kết nối nên dùng: `sslmode=verify-full` với chứng thư gốc của PVFCCo nếu công cụ hỗ trợ, tối thiểu `sslmode=require`; chứng thư của máy chủ cơ sở dữ liệu do PVFCCo cấp (PX-11), nên tên hoặc địa chỉ trong chứng thư phải trùng với máy chủ ghi trong kết nối.

Mỗi tài khoản gắn đúng một tenant bằng chính tên đăng nhập; đổi `app.tenant_id` không đọc được tenant khác. Tài khoản BI thấy toàn bộ dữ liệu chứng nhận của tenant, không phân theo đơn vị.

## 4. Nối từ Power BI Desktop (cán bộ làm báo cáo)

1. Mở `docs/integration/machvon-bi.pbids` (nháy đúp) hoặc chọn Get data, PostgreSQL database. Điền máy chủ (kèm cổng) và tên cơ sở dữ liệu; chế độ **Import** (không dùng DirectQuery: mỗi truy vấn bị giới hạn 60 giây).
2. Ở hộp thoại thông tin xác thực chọn Database, nhập tên đăng nhập và mật khẩu của tài khoản BI. Bật mã hóa kết nối nếu Power BI hỏi.
3. Mở bảng `machvon_bi.v_dataset_catalogue` trước tiên. Mỗi dòng phải có `is_open = true`; nếu không, đọc cột `reason` và quay lại mục 3.
4. Dựng mô hình bằng **một** trong hai cách:
   - Dán `docs/integration/power-bi/machvon-sample-model.tmdl` vào khung nhìn TMDL (Options, Preview features, TMDL view), điền hai tham số `ServerName` và `DatabaseName`, chạy; hoặc
   - Tự dựng theo `power-bi-model.md` mục 4: hai bảng sự kiện `FactDisbursement` (từ `v_disbursement_lines`) và `FactContract` (từ `v_contract_lines`, phiên bản mới nhất của mỗi kỳ), các bảng chiều `DimPeriod`, `DimBucket`, `Catalogue`, quan hệ một-nhiều lọc một chiều, rồi các phép đo DAX ở mục 5 của tài liệu đó.
5. Bảng chiều dự án: dùng hàm Power Query ở `power-bi-model.md` mục 6 (lấy mã truy cập, đọc từng trang `/open/v1/projects`). Đặt `BaseUrl`, `ClientId`, `ClientSecret` làm tham số của mô hình; không viết giá trị thật vào tệp. Nối `DimProject[id]` với `project_id` của hai bảng sự kiện.
6. Đổi tên cột và đặt nhãn hiển thị tiếng Việt cho người xem; ẩn các cột khóa uuid.

## 5. Gợi ý các trang báo cáo cho Chi nhánh QLPTDA

| Trang | Nội dung | Nguồn | Lưu ý |
|---|---|---|---|
| 1. Tổng quan danh mục dự án | Kế hoạch vốn, giải ngân Kho bạc, tỷ lệ theo dự án và theo đơn vị chủ quản; xếp hạng theo tỷ lệ | `FactDisbursement`, `DimProject` | Bộ lọc kỳ một lựa chọn; ghi ngày chốt `as_of_date` trên đầu trang |
| 2. Chi tiết dự án | Theo nhóm vốn (`bucket`) và cấp ngân sách (`budget_level`); đường xu hướng giải ngân qua các kỳ | `FactDisbursement` | Xu hướng lấy một điểm mỗi kỳ, không cộng các kỳ |
| 3. Hợp đồng và thanh toán | Giá trị hợp đồng hiện hành, đã thanh toán, tỷ lệ; theo trạng thái và loại hợp đồng | `FactContract` | Tổng các dòng của một hợp đồng bằng đúng giá trị hợp đồng (chia theo tỷ lệ liên danh); không lọc `is_lead` để tránh đếm trùng |
| 4. Chất lượng dữ liệu | Số dòng không có số Kho bạc (`treasury_coverage = NONE`), lý do không có tỷ lệ, hạn chứng nhận | `FactDisbursement`, `Catalogue` | Bắt buộc có: người xem cần biết con số có đang được mở và đủ không |

Quy ước của MACHVON cho mọi con số trong báo cáo: có công thức, nguồn và ngày chốt; thêm chú thích dưới mỗi hình.

## 6. Xuất bản và làm mới

1. Xuất bản lên Power BI Service; ở tập dữ liệu, cấu hình thông tin xác thực của nguồn PostgreSQL qua cổng dữ liệu (tài khoản BI, mật khẩu ở kho của cổng).
2. Đặt lịch làm mới: hằng ngày 06:30; trong cửa sổ kỳ chốt thêm một lần buổi chiều (xem lịch hỗ trợ kỳ chốt ở `docs/delivery/12-maintenance-and-hypercare.md`). Dữ liệu là bản chụp đã đóng băng nên làm mới thường xuyên hơn không làm số đổi.
3. Phân quyền xem: nếu người của một đơn vị chỉ được thấy dự án của đơn vị mình, đặt vai trò an ninh theo dòng (RLS) của Power BI theo `unit_id` hoặc theo đơn vị chủ quản của dự án và gán người dùng; tài khoản BI không làm việc này thay.
4. Khi tài khoản BI bị đổi mật khẩu hoặc thu hồi ở INT-04, cập nhật thông tin xác thực trong cổng dữ liệu, nếu không lần làm mới sẽ lỗi xác thực.

## 7. Kiểm tra số liệu

1. Chạy các truy vấn 1, 2 và 8 của `power-bi-sample-queries.sql` bằng công cụ SQL (hoặc Power Query): danh mục tập dữ liệu, các kỳ có bản chụp, số dòng và tổng theo kỳ.
2. So tổng `plan_total_vnd` và `disbursed_treasury_vnd` của một kỳ trong báo cáo với truy vấn 8; hai số phải bằng nhau.
3. So một kỳ với bản chốt kỳ trên màn hình của MACHVON (bản chốt loại `PERIOD_CLOSE`, màn hình DIS-21, Chốt và đóng băng số liệu kỳ) về tổng kế hoạch, tổng giải ngân; chênh lệch phải được giải trình trước khi công bố báo cáo.
4. Kiểm tra tỷ lệ: tính lại bằng tổng chia tổng; không cộng hay lấy trung bình tỷ lệ của các dòng.

## 8. Lỗi thường gặp

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Kết nối báo không tới được máy chủ (hết thời gian chờ) | Cổng tùy chọn chưa bật, địa chỉ nguồn không nằm trong danh sách, tường lửa, sai cổng | Ban CĐS&CNTT và vận hành kiểm tra `MACHVON_BI`, `BI_ALLOWED_CIDRS` và chuỗi `MACHVON-BI` (`bi-port.md`) |
| Kết nối bị từ chối ngay (no pg_hba.conf entry) | Không dùng TLS, hoặc địa chỉ nguồn không khớp, hoặc dùng tài khoản không phải tài khoản BI | Bật mã hóa trong Power BI (`sslmode=require`); dùng đúng tài khoản `machvon_bi_...`; báo vận hành địa chỉ nguồn thực |
| Đăng nhập thất bại | Mật khẩu sai, đã đổi hoặc thu hồi ở INT-04 | Đổi mật khẩu ở INT-04, cập nhật thông tin xác thực |
| Bảng mở được nhưng không có dòng | Tập chưa bật, chưa chứng nhận hoặc hết hạn; chưa có bản chốt `PERIOD_CLOSE` | Xem `v_dataset_catalogue.reason`; xem điều kiện mục 2 |
| Số giải ngân lớn bất thường | Cộng nhiều kỳ với nhau (giải ngân là lũy kế) | Dùng phép đo chọn một kỳ (`Chosen Period`) |
| Câu truy vấn bị ngắt sau 60 giây | Giới hạn của tài khoản BI | Thu hẹp truy vấn theo `period_id`, dùng chế độ Import |
| Không có tên dự án | Cơ sở dữ liệu BI chỉ có khóa dự án | Nối với danh mục dự án lấy từ API mở (mục 4, bước 5) |
| Lỗi 429 khi gọi API mở | Vượt giới hạn tần suất của tài khoản máy | Chờ số giây của `Retry-After`; đọc theo trang |

## 9. Việc phụ thuộc PVFCCo

Máy chủ và cổng cơ sở dữ liệu cho Power BI (địa chỉ nghe của cổng tùy chọn), địa chỉ nguồn của cổng dữ liệu, chứng thư TLS của máy chủ cơ sở dữ liệu, nơi nhận và thời hạn lưu nhật ký đọc, vùng mạng, người được cấp tài khoản BI và tài khoản máy, vai trò xem theo đơn vị của Chi nhánh QLPTDA: `[khách điền: máy chủ, cổng, tên cơ sở dữ liệu]`, `[khách điền: địa chỉ nguồn của cổng dữ liệu, chứng thư, nơi nhận nhật ký]`, `[khách điền: danh sách người dùng báo cáo và đơn vị]`. Tất cả nằm trong mục PX-11 của sổ `docs/delivery/11-pending-external-register.md`.

Lịch sửa: v0.1 2026-11-12 (làn aud4); v0.2 2026-11-12 (làn INT-2: mục 3a, điều kiện 3 và bước 5 theo cổng cơ sở dữ liệu tùy chọn và `pgaudit` của gói cài đặt).
