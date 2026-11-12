# Tám luồng chính vẽ lại (bản công, hướng B v2)

"Chạm" tính từ màn đang mở là tab gốc tương ứng, không tính gõ chữ. Cột "Hiện tại" là số đo trên bản đang chạy (emulator `guide`, 2026-11-12) hoặc suy ra từ bảng định tuyến khi màn chặn chụp (ghi rõ). Khung là số khung trong `mockups/direction-b.html` (ảnh `mockups/png/direction-b-N.png`).

| # | Việc | Hiện tại | v2 | Khung |
|---|---|---|---|---|
| 1 | Xem việc đến hạn | 0 chạm nhưng danh sách theo mức khẩn, không theo hạn | 0 chạm: Trang chủ cán bộ là "Việc hôm nay" nhóm Trễ hạn, Sắp đến hạn, Còn thời gian | 2 |
| 2 | Nhận một việc | 1 chạm, nút dưới nếp gấp | 1 chạm: nút chính trên hàng "Cả nhóm", hoặc mở việc rồi "Nhận việc" (2) | 2, 5 |
| 3 | Duyệt | 4 chạm (theo bảng định tuyến; không chạy được) | 3 chạm từ Trang chủ lãnh đạo: hàng, "Phê duyệt", "Xác nhận phê duyệt"; 4 từ tab Phê duyệt | 1, 4, 7 |
| 4 | Xem tiến độ dự án | 2 chạm + 3 lần cuộn, tiến độ là chữ | 1 chạm: thanh tiến độ và giai đoạn ngay trên hàng dự án; 2 chạm: tab Tiến độ có dải 6 giai đoạn và danh sách việc | 8, 3 |
| 5 | Báo cáo hiện trường | 5 chạm trở lên; "Ghi nhận vướng mắc" không có nút tạo | 2 chạm: nút "Báo cáo", chọn loại (chụp ảnh, vướng mắc, nhật ký, khối lượng); dự án gần nhất tự chọn; gửi được ngoại tuyến | 15 |
| 6 | Tìm hồ sơ | 2 chạm + gõ, chôn ở Cá nhân | 1 chạm + gõ: biểu tượng tìm ở thanh trên mọi tab gốc | 1 đến 4 |
| 7 | Đọc thông báo | 1 chạm, nhưng nội dung trùng danh sách việc | 1 chạm: dòng thời gian sự kiện, nhóm Hôm nay, Hôm qua, bộ lọc Hạn việc, Phê duyệt, Hệ thống | 6 |
| 8 | Đổi cài đặt | 2 chạm, không có mục Cài đặt | 2 chạm: Cá nhân, "Nhắc hạn việc" với xem trước ba màu | 14 |

## Luồng chi tiết

**1. Việc hôm nay.** Mở ứng dụng, tab Trang chủ (cán bộ) hiện tiêu đề lớn "Việc hôm nay", ngày và tên; ba tab "Của tôi", "Cả nhóm", "Đã xong"; các nhóm theo hạn; nút nổi "Báo cáo". Mỗi hàng: biểu tượng hạn (bát giác, tam giác, đồng hồ), tiêu đề tối đa hai dòng, "mã dự án · chứng từ đã có/cần", nhãn hạn và ngày hạn. Hết việc: khung 9. Ngoại tuyến: khung 10. Cỡ chữ 200%: khung 13.

**2. Nhận việc.** "Cả nhóm" liệt kê việc chưa có người nhận (hàng có nút "Nhận việc" ở cột cuối, 1 chạm; không có xác nhận vì hoàn tác được trong 10 giây bằng snackbar). Việc đã nhận chuyển sang "Của tôi". Người không có quyền nhận thấy hàng chỉ đọc kèm lý do.

**3. Duyệt.** Trang chủ lãnh đạo: nhóm "Cần bạn quyết định" (4) hiện các hàng có tiêu đề, người gửi, số tiền rút gọn, hạn. Chạm hàng mở hồ sơ (khung 7 phía sau): dòng hạn lớn "Còn 1 ngày", tiêu đề, số tiền lớn, người gửi, các dòng dữ kiện để quyết, chứng từ, thanh hành động "Trả lại", "Phê duyệt". Chạm "Phê duyệt" mở sheet xác nhận: tóm tắt hậu quả (điều chuyển 12 tỷ đồng từ DA-CB-017 sang DA-CB-023, tổng không đổi), kết quả kiểm tra chứng từ, ghi chú "ghi vào nhật ký kiểm toán dưới tên bạn". "Xác nhận phê duyệt" thực hiện, quay về danh sách với snackbar biên nhận (mã, giờ). Trả lại bắt buộc nhập lý do. Phê duyệt chỉ chạy khi có mạng và dữ liệu còn mới; khi bản cũ hoặc ngoại tuyến thì nút khóa kèm lý do (R39). Không vuốt để duyệt tiền.

**4. Tiến độ dự án.** Tab Dự án: tiêu đề lớn "Dự án", dòng "32 dự án · số liệu chốt", chip lọc (Tất cả, Chậm tiến độ 6, Đang thực hiện), hàng dự án (mã, nhóm, tên, thanh tiến độ, giai đoạn, nhãn "Chậm 6 ngày" hoặc "Đúng tiến độ"). Chạm hàng: màn dự án có tiêu đề, "Nhóm B · Giải ngân 63% · Hoàn thành 58%", sáu đoạn giai đoạn với "Giai đoạn 4/6 · Thực hiện · Việc xong 7/12", bốn tab Tổng quan, Tiến độ, Vốn, Hồ sơ. Tab Tiến độ: nhóm "Cần chú ý", "Sắp tới", "Đã xong". Ẩn trường chưa có. Tiền theo mục 6 của `design-system-v2.md`.

**5. Báo cáo hiện trường.** Nút nổi "Báo cáo" ở Việc hôm nay (và trong màn dự án) mở sheet: dự án gần nhất tự điền, bốn loại. Chọn loại rồi điền biểu mẫu một màn (ảnh, ghi chú, vị trí tùy chọn); "Gửi" cố định ở dưới; khi không có mạng, báo "Đã lưu, sẽ gửi khi có mạng" và mục xuất hiện trong "Hàng đợi gửi" (Cá nhân, Công cụ) kèm số đếm. Màn danh sách vướng mắc có nút "Ghi nhận vướng mắc" (sửa F-06).

**6. Tìm hồ sơ.** Biểu tượng tìm ở thanh trên mọi tab gốc mở màn tìm toàn cục (hồ sơ, dự án, hợp đồng, gói thầu) có tìm gần đây và lọc theo loại; không còn nằm trong Cá nhân.

**7. Thông báo.** Tab Thông báo là dòng thời gian sự kiện (không phải danh sách việc): nhóm Hôm nay, Hôm qua; chấm chưa đọc; nhãn loại ("Hạn việc", "Phê duyệt", "Hệ thống") với biểu tượng; chạm mở màn liên quan; "Đọc hết". Thông báo hạn dùng cùng ba dải và luôn ghi ngày hạn thật.

**8. Cài đặt.** Cá nhân: hồ sơ ở đầu; "Nhắc hạn việc" với hai bước chỉnh (vàng khi còn tối đa N ngày, đỏ khi còn dưới M ngày) và xem trước ba dải; dòng chú "Theo cài đặt của bạn, chỉ đổi màu và lúc nhắc trên máy này; cảnh báo chính thức và KPI theo quy định của đơn vị" (R40; cá nhân chỉ được nhắc sớm hơn quy định). Thông báo đẩy, giờ yên lặng. Công cụ: tìm kiếm, hàng đợi gửi, ngoại tuyến, ủy quyền, sổ chỉ tiêu, biểu mẫu. Đổi tổ chức, đăng xuất ở cuối.
