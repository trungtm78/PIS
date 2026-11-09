# Nhận diện thương hiệu Phú Mỹ (PVFCCo) dùng trong bộ trình chiếu

Nguồn duy nhất: trang chủ https://dpm.vn/ và tệp CSS của trang, đọc ngày 2026-11-09. Chỉ ghi điều trang hiển thị; mục nào không thấy trên trang ghi "chưa xác định".

## Tên và mô tả
- Tên pháp lý trên chân trang: "Tổng công ty Phân bón và Hóa chất Dầu khí - CTCP" (viết tắt tiếng Anh PVFCCo; mã cổ phiếu DPM, niêm yết tại HSX). Tên gọi ngắn do trang định danh: "Phú Mỹ".
- Thương hiệu: "Phú Mỹ - Sẻ chia thịnh vượng". Hệ thống nhận diện mới công bố cuối năm 2024, "màu xanh ngọc tươi mới"; chữ Y có chấm cam đỏ là "biểu tượng kép của con người hân hoan và cây trồng đang tỏa nhánh dưới vầng thái dương".
- Khẩu hiệu: "Sẻ chia thịnh vượng" (chung cho Tổng công ty và hóa chất); "Cho mùa bội thu" tiếp tục cho dòng phân bón.
- Mô tả trang chủ: "Phú Mỹ, thương hiệu hàng đầu trong lĩnh vực phân bón và hóa chất tại Việt Nam, cam kết cung cấp sản phẩm chất lượng cao, hỗ trợ nông nghiệp bền vững."
- Lịch sử trên trang: thành lập 28/3/2003; Nhà máy đạm Phú Mỹ khánh thành tháng 12/2004; hơn hai mươi năm cung ứng hơn 20 triệu tấn phân bón; Thương hiệu quốc gia liên tục từ 2014.
- Nhóm sản phẩm trên trang: Phân bón, Hoá chất, Phu My Garden.
- Địa chỉ: 43 Mạc Đĩnh Chi, Phường Sài Gòn, Thành phố Hồ Chí Minh. Điện thoại (028) 38.256.258. Email lienhe@pvfcco.com.vn.

## Logo (tải về D:\PIS-clips-out\deck\assets, không đưa vào git)
| Tệp | Nguồn | Dùng |
| --- | --- | --- |
| dpm-logo-header.webp | https://dpm.vn/public_folder/files_upload/202607/13cad28c01021b2663ffdbc20bd46872.webp | logo đầu trang (chữ PHÚ MỸ, chấm cam, khẩu hiệu; có dòng chú "Trang Thông tin điện tử tổng hợp" ở trên cùng) |
| dpm-logo-alt.webp | https://dpm.vn/public_folder/files_upload/202511/d0ae2ba64257db4165398c071791735f.webp | logo PETROVIETNAM PVFCCo (lá xanh lục, chữ xanh chàm) |
| dpm-favicon.svg | https://dpm.vn/assets/frontend/images/favicon.svg | biểu tượng chữ Y (hai màu #389E9E và #F15A22) |
`prepare_assets.py` cắt bỏ dòng chú trên cùng của logo đầu trang để có hai bản: dpm-logo-lockup.png (chữ + khẩu hiệu) và dpm-logo-wordmark.png (chỉ chữ). Không vẽ lại, không đổi màu.

## Màu (đọc từ `assets/frontend/css/pubweb.css`, biến CSS)
- Chính (xanh ngọc): primary-600 #389E9E; 500 #74BBBB; 400 #9BCFCF; 300 #C3E2E2; 200 #D7ECEC; 100 #EBF5F5.
- Phụ (cam): secondary-600 #F15A22; 500 #F58B64; 400 #F8AC90; 300 #FBCEBD; 200 #FCDED3; 100 #FEEFE9.
- Chữ: #2B323B; xám #6B7076, #95989D; nền nhạt #F9F9F9; đường kẻ #EAEBEB.
- Màu dẫn xuất của bộ trình chiếu (không có trên trang, tính từ màu chính để đủ độ tương phản chữ): xanh ngọc đậm #2B7C7C (nền có chữ trắng), cam đậm #C8470F (chữ nhỏ màu cam).

## Phông
- Trang dùng họ SVN-Nexa (Light, Bold, Heavy), nạp từ `assets/frontend/font`. Phông này không có sẵn trên Windows/Office và không có giấy phép phát hành kèm tệp.
- Bộ trình chiếu dùng Segoe UI (có sẵn trên Windows, hỗ trợ tiếng Việt đầy đủ) làm phông thay thế gần nhất về dáng hình học. Muốn đúng thương hiệu hơn: cài SVN-Nexa rồi đổi `--font` khi dựng (xem README.md).

## Chưa xác định
- Cẩm nang nhận diện thương hiệu (trang có liên kết "Tài liệu cẩm nang nhận diện thương hiệu nhãn hiệu Phú Mỹ") chưa được tải: chưa biết vùng an toàn, kích thước tối thiểu, quy định dùng logo trên nền màu. Nên đối chiếu khi bản trình bày dùng cho bên ngoài.
- Giấy phép dùng phông SVN-Nexa; mã màu in (CMYK/Pantone).

## Hai thương hiệu trên một bộ trình chiếu
Phú Mỹ là khách hàng nên mang nhận diện (màu, logo ở bìa, đầu mỗi trang). "Mạch Vốn" là tên sản phẩm được giới thiệu: logo ngang `logo-enterprise-horizontal` (bản "Phần mềm quản lý đầu tư xây dựng") ở bìa và trang cuối; bản công `logo-public-horizontal` ở phụ lục. Logo Mạch Vốn giữ nguyên màu riêng, đặt trên nền trắng.
