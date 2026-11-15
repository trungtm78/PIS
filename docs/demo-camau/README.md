# Bộ dữ liệu demo tỉnh Cà Mau trên màn hình thật

Chụp ngày 15/11/2026 từ nhánh `lane/camau1`, trên ứng dụng chạy thật ở máy phát triển: `node scripts/demo-public.mjs` (web dựng ở chế độ development, API trên PostgreSQL nhúng,
`clip-seed apply --dataset camau` chạy trọn trên một stack sạch rồi `verify`), ảnh lấy bằng `node docs/demo-camau/capture.mjs` (Chromium của Playwright, 1440×900, ảnh toàn trang,
đăng nhập bằng phiên phát triển `?devUser=<người>`). Không có ảnh dựng tay. Với cả chín ảnh, kịch bản chụp đo được: không có lỗi JavaScript, trang không cuộn ngang.

**Dữ liệu trong ảnh là MINH HỌA**, không phải số liệu thật của tỉnh Cà Mau; tên người là tên minh họa (xem `docs/runbooks/demo-data-camau.md`).
Tên hệ thống trên ảnh vẫn là "Hệ thống quản lý đầu tư công": bộ dữ liệu chỉ đổi tenant, đơn vị, địa bàn, dự án.

## Kết quả nạp và kiểm của lượt chụp

- `apply`: mã thoát 0, 16 pha, không có bước nào bị sản phẩm từ chối; tổng thời gian các nhóm seed khoảng 170 giây.
- `verify`: **đạt 54/54 kiểm**. Một số số đọc lại: 53 dự án đã đăng ký (45 của danh mục cộng 8 dự án có workflow của nhóm `clip-public-pwf-review`), 32 dự án có mã dự án quốc gia,
  19 kế hoạch lựa chọn nhà thầu, 60 gói thầu, 16 nhà thầu, 5 hợp đồng đang hiệu lực, 3 đề nghị thanh toán (2 đã thanh toán, 1 chờ Kho bạc), 1 tạm ứng quá hạn thu hồi,
  40 quy trình gói thầu đã chạy (16 trễ, 2 tạm dừng), 33 cảnh báo sớm đang mở, 4 ảnh chụp kỳ đã chốt, giải ngân 965,414 tỷ đồng trên kế hoạch 2.566 tỷ đồng (37,62%),
  6 chỉ đạo (3 quá hạn), 4 thành viên Ban chỉ đạo, hộp phê duyệt của lãnh đạo có đủ năm loại hồ sơ chờ.
- Quét các sổ đọc được qua API bằng tài khoản chủ sở hữu (dự án, đơn vị, nhà thầu, hợp đồng, gói thầu, văn bản đến và đi, chỉ đạo, cảnh báo, vai, địa bàn...): không còn chuỗi nào mang
  tên tỉnh, xã, phường, cơ quan của bộ hướng dẫn cũ, trừ danh mục tỉnh, thành của nền tảng (trong đó có Cao Bằng, Lào Cai: đúng là danh mục cả nước).

Một kiểm của `verify` đã được sửa trong lượt này vì nó sai với cả bộ cũ: đề nghị điều chỉnh điểm do chủ sở hữu lập (cán bộ Ban quản lý dự án không có quyền với điểm của người khác)
nên chờ ở hộp phê duyệt của **lãnh đạo quyết định**, không ở hộp của chính người lập; kiểm trước đó đọc hộp của chủ sở hữu và luôn ra 0.

## Ảnh

| Ảnh | Mã màn | Người | Đang hiển thị | Đã tự xem |
|---|---|---|---|---|
| [`01-trang-chu-tong-quan-dieu-hanh.png`](01-trang-chu-tong-quan-dieu-hanh.png) | HOME-01 | Nguyễn Văn An (chủ sở hữu, tài khoản `demo`) | Tổng quan điều hành: việc cần xử lý ngay, giải ngân năm 2026, cảnh báo, dòng vốn theo tháng T1 đến T11, xếp hạng đơn vị | Cỡ đầy đủ. Tenant "UBND tỉnh Cà Mau"; việc nhắc dự án `DA-MT101`, `DA-MT102`, "Trường THPT Khánh Lâm". Còn thấy: số tiền lớn hiện dạng chưa nhóm chữ số ("965414000000 đồng") và các nhãn "Định nghĩa chưa được xác nhận": là của sản phẩm, không thuộc bộ dữ liệu |
| [`02-danh-sach-du-an.png`](02-danh-sach-du-an.png) | PRJ-01 | chủ sở hữu | Danh sách 53 dự án: mã, tên, chủ đầu tư, nhóm A/B/C, giai đoạn, mã dự án quốc gia | Cỡ đầy đủ ở lượt chụp đầu (trước khi đổi tên đơn vị chủ đầu tư); lượt cuối chưa mở lại ảnh này, tên chủ đầu tư đã thấy đúng ở ảnh 03 và 08 |
| [`03-giai-ngan-tong-hop-theo-chu-dau-tu.png`](03-giai-ngan-tong-hop-theo-chu-dau-tu.png) | DIS-12 | Trần Thị Bích (lãnh đạo, `lanhdao`) | Tổng hợp giải ngân theo chủ đầu tư, kỳ W2026-46, số Kho bạc đến 13/11/2026 | Cỡ đầy đủ. Một đơn vị: Ban Quản lý dự án xây dựng tỉnh Cà Mau, 32 dự án, 96,54% theo kế hoạch Thủ tướng giao, 37,62% theo tổng kế hoạch. Bảng rộng hơn khung nên cột cuối bị cắt trong ảnh (bảng cuộn trong khung của nó) |
| [`04-giai-ngan-hai-ty-le.png`](04-giai-ngan-hai-ty-le.png) | DIS-19 | lãnh đạo | Hai tỷ lệ giải ngân song song | Chưa mở xem ở cỡ đọc được; chỉ có số đo của kịch bản (không lỗi, không cuộn ngang) |
| [`05-bang-deadline-toan-danh-muc.png`](05-bang-deadline-toan-danh-muc.png) | PWF-07 | chủ sở hữu | Bảng deadline toàn danh mục: 137 việc đang mở, ba màu hạn | Lượt chụp đầu, ảnh thu nhỏ (không đọc được từng chữ nhỏ): 6 đỏ, 4 vàng, 5 xanh, 122 chưa vào tầm; dự án ở Khánh Lâm, U Minh, Năm Căn, Đầm Dơi, Tân Thuận. Tên một số việc nhắc "Sở Kế hoạch và Đầu tư": là tên việc trong mẫu quy trình của sản phẩm, không thuộc bộ dữ liệu. Lượt cuối chưa mở lại |
| [`06-bang-diem-don-vi.png`](06-bang-diem-don-vi.png) | PWF-12 | chủ sở hữu | Bảng điểm đơn vị, kỳ quý IV/2026 của "Khối Ban quản lý dự án chuyên ngành", bản nháp tạm tính | Cỡ đầy đủ. Sáu người, có điểm và xếp loại (Tốt, Đạt, Cần cải thiện, Chưa có điểm) |
| [`07-cay-to-chuc.png`](07-cay-to-chuc.png) | ADM-01 | chủ sở hữu | Cây tổ chức | Cỡ đầy đủ, lượt cuối. 28 đơn vị: UBND tỉnh; nút "Khối Ban quản lý dự án chuyên ngành" với ba Ban quản lý dự án; mười hai sở, ngành và Văn phòng UBND tỉnh; Ban Quản lý Khu kinh tế; chín xã, phường |
| [`08-bang-dieu-hanh-ban-chi-dao.png`](08-bang-dieu-hanh-ban-chi-dao.png) | BAN-01 | Trần Văn Hùng (Trưởng Ban chỉ đạo, `truongban`) | Bảng điều hành Ban chỉ đạo: toàn tỉnh so với kế hoạch, theo ngành, dự án cần Trưởng ban quan tâm, cảnh báo, chỉ đạo | Ảnh thu nhỏ, đọc được tiêu đề và tên dự án: `DA-NN103` cống và đê biển Tây, `DA-MT102` kè bờ biển Đông, `DA-GT107`, `DA-GT105` đường ven biển, `DA-YT109` Bệnh viện Sản - Nhi |
| [`09-viec-cua-toi-can-bo.png`](09-viec-cua-toi-can-bo.png) | HOME-02 | Phạm Quốc Dũng (cán bộ Ban quản lý dự án, `canbo.qlda`) | Việc của tôi | Chưa mở xem; chỉ có số đo của kịch bản |

## Chưa làm ở lượt này

- Ảnh điện thoại: không chụp.
- Ảnh 02, 05 của lượt cuối và ảnh 04, 09 chưa được mở xem lại ở cỡ đọc được (ghi ở cột cuối).
- Chưa nạp lên bản cài chạy Docker: xem `docs/runbooks/demo-data-camau.md`, mục 6.
