# Bộ trình chiếu giới thiệu hệ thống cho Phú Mỹ (PVFCCo)

20 trang, 16:9, ghi chú người nói tiếng Việt ở mọi trang. Dựng từ mẫu `Slide_Gioi_Thieu_Nen_Tang_Chuoi_Cung_Ung_Nguyen_Kim_20261015-ver2.pptx` (chỉ đọc, không sửa tệp gốc): giữ khổ trang, bộ layout, ngôn ngữ hình ảnh (dải màu đầu trang, tiêu đề nhỏ trên cùng, số thứ tự trong vòng tròn, thẻ nền nhạt, chân trang có đường kẻ); thay màu, phông, logo bằng nhận diện Phú Mỹ (`brand-notes.md`).

## Dựng lại
```
python -m pip install python-pptx            # python-pptx 1.0.2, kéo theo lxml, Pillow
python -X utf8 scripts/deck/prepare_assets.py # cắt logo, ảnh màn hình, ảnh điện thoại
python -X utf8 scripts/deck/build_deck.py     # ra D:\PIS-clips-out\deck\*.pptx và ảnh xem trước
```
Tùy chọn của `build_deck.py`: `--template`, `--assets`, `--content`, `--req`, `--out`, `--preview`, `--font`.

## Tệp
- `content.json`: toàn bộ chữ tiếng Việt và ghi chú người nói; sửa chữ ở đây rồi dựng lại.
- `build_deck.py`: dựng theme, layout (bìa, nội dung, nền xanh) và 20 trang bằng hình gốc của PowerPoint (không có ảnh chụp trang). Số liệu trang "Mức đáp ứng" đọc trực tiếp từ `docs/hskt/requirements.json` nên tự cập nhật khi ma trận đổi.
- `deck_lib.py`: tiện ích vẽ; đo chữ bằng phông Segoe UI thật để tự thu nhỏ chữ cho vừa khung, báo "TRAN CHU" khi không vừa, và vẽ ảnh xem trước.
- `prepare_assets.py`, `brand-notes.md`: ảnh đầu vào và nguồn nhận diện.

## Đầu vào ngoài kho (không commit)
- `D:\PIS-clips-out\deck\assets`: logo dpm.vn đã tải, logo Mạch Vốn (từ `D:\PIS-clips-out\brand`), ảnh cắt từ khung hình clip.
- `D:\PIS-clips-out\deck\frames`: khung hình trích từ `D:\PIS-clips-out\enterprise\enterprise-phu-my.*.screen.mp4` và `phone` bằng ffmpeg của imageio_ffmpeg (`-ss <giây> -frames:v 1`).

## Quyết định thiết kế
- Phú Mỹ (khách hàng) mang nhận diện: màu xanh ngọc #389E9E và cam #F15A22 của dpm.vn, logo ở bìa, đầu mỗi trang và trang cuối. Mạch Vốn (sản phẩm) giữ logo riêng, đặt trên nền trắng ở bìa, trang cuối và phụ lục.
- Phông: Segoe UI thay SVN-Nexa của dpm.vn (không có sẵn trên Windows). Đổi phông bằng `--font` (chỉ đổi theme; phép đo vừa khung vẫn theo Segoe UI).
- Không có LibreOffice hay PowerPoint trên máy dựng: ảnh xem trước (`D:\PIS-clips-out\deck\preview`) là mô phỏng từ danh sách hình của chính bộ dựng, không phải bản vẽ của PowerPoint. Nên mở tệp bằng PowerPoint để xem lần cuối (phông Segoe UI, trang số hiện khi trình chiếu).
