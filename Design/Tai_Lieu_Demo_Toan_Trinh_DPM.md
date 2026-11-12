# Mạch Vốn (bản doanh nghiệp): Tài liệu trình diễn toàn trình cho Đạm Phú Mỹ / PVFCCo

Buổi demo 15:00 ngày 10/11/2026. Tài liệu có hai người đọc: (1) người trình diễn, đứng cạnh máy chiếu, mở từng màn hình và kể; (2) lãnh đạo Đạm Phú Mỹ đọc lại sau buổi demo để nắm "dữ liệu lớn dần thế nào từ lúc bắt đầu đến lúc hoàn thành và quản trị".

Toàn bộ số liệu là DỮ LIỆU MINH HỌA do đội phát triển dựng, không phải số liệu thật của Đạm Phú Mỹ. Các biểu mẫu báo cáo gửi Tập đoàn là MẪU DEMO. Hãy nói điều này một lần ở đầu buổi (xem mục 5, câu hỏi 1 và 2).

---

## Trước giờ demo (10 dòng)

1. **Chia sẻ qua Google Meet**: "A tab" (tab Chrome) cho web, "A window" (cửa sổ "MachVon - dien thoai", chạy `C:\PIS\Design\Chieu_Dien_Thoai_Android.cmd`, cáp USB-C) cho điện thoại. Web: `http://127.0.0.1:5173`; qua mạng: `https://172.20.10.5:5443` (tự vào là `owner`).
2. **Mở sẵn 4 tab, mỗi tab một vai**: `owner`, `capApprover`, `projectManager`, `docHead`. Luôn có `?devUser=...` ở cuối địa chỉ; F5 thiếu nó là mất phiên.
3. Hồi 1-2: `/prj/prj-14?devUser=projectManager`, `/cap/cap-03?devUser=owner` (chọn "KHV-2026 · Đã công bố" trong ô Kế hoạch).
4. Hồi 3-5: `/bid/bid-15?devUser=capApprover`, `/ctr/ctr-01?devUser=projectManager`, `/ctr/ctr-12?devUser=owner`. Hồi 6-7: `/pay/pay-01?devUser=owner`, `/iss/iss-01?devUser=projectManager`.
5. Hồi 8: `/dis/dis-01?devUser=projectManager`, `/rpt/rpt-03?devUser=docHead`, `/hpm/hpm-01?devUser=owner` (docHead KHÔNG vào được HPM), `/ebs/ebs-02?devUser=owner`.
6. Hồi 9-11: `/home/home-09?devUser=owner`, `/dir/dir-03?devUser=owner`, `/m/approvals?devUser=owner`, `/aud/aud-01?devUser=owner`, `/adm/adm-11?devUser=owner`. Ưu tiên đi bằng menu bên trái (Báo cáo gửi Tập đoàn, Đẩy HPM và đối chiếu EBS, Chỉ đạo và giao ban).
7. **TUYỆT ĐỐI KHÔNG BẤM**: RPT-09 "Ghi giải trình"; RPT-02 "Phê duyệt" và "Phát hành bản này"; HPM-01 "Đẩy báo cáo", "Đẩy lại", "Ghi biên nhận"; "Duyệt" hoặc "Trả lại" ở `/m/approvals`, DIS-28, CTR-08, CTR-12, ISS-07, BID-18; mọi nút "Tạo", "Lập". Mỗi thao tác chỉ làm được một lần và không nạp lại được.
8. Không gõ tay `?id=`, `?contract=`, `?engagement=`, `?snapshot=`: bấm từ danh sách. Không so hai màn có số giải ngân khác nhau cho cùng một dự án (mục 8.3).
9. Điện thoại Android: giữ cáp USB-C; tab Phê duyệt bị đen khi chiếu, dùng web `/m/approvals`; ứng dụng đăng nhập là `owner`.
10. Nói ở đầu buổi: "dữ liệu minh họa", "biểu mẫu là MẪU DEMO", "HPM và EBS là tệp giả định (PENDING-EXTERNAL)". Không khởi động lại máy demo sau 14:30.

---

## 0. Cách dùng tài liệu này

**Cách đọc ký hiệu**

- `devUser` là "người đang đăng nhập". Không có mật khẩu: thêm `?devUser=<khóa>` vào cuối địa chỉ. Bấm F5 hoặc gõ lại địa chỉ mà thiếu phần này thì phiên rơi về người mặc định và nhiều màn báo "không có quyền". Đang bấm chuyển trang trong ứng dụng thì phiên được giữ.
- Địa chỉ gốc trên máy chiếu: `http://127.0.0.1:5173`. Bảng dưới chỉ ghi phần đuôi, ví dụ `/prj/prj-14?devUser=projectManager`.
- Địa chỉ qua mạng nội bộ cho điện thoại/iPhone: `https://172.20.10.5:5443` (tự đăng nhập là `owner`). Muốn đổi sang vai khác hãy dùng cổng 5173 trên laptop (chưa kiểm xem `?devUser=` có đổi được vai trên cổng 5443 hay không).
- **Bản cuối (đã đối chiếu trực tiếp trên máy demo thật lúc khoảng 14:10 ngày 10/11/2026)**: số KHÔNG có dấu là số đã thấy trên màn hình thật hoặc tính tất định từ bộ dữ liệu nền. **‹chưa xác minh›** đứng sau một con số nghĩa là con số lấy từ bản chạy thử và CHƯA được mở lại trên máy thật: mở đúng màn đó một lần trước 14:30. Số đổi theo đồng hồ (Việc của tôi, chuông, "quá hạn n ngày", "còn n giờ") được ghi "khoảng" và sẽ khác lúc trình diễn.
- Ngày tuyệt đối trong tài liệu tính theo hôm nay D = 10/11/2026. D-55 = 16/09/2026, D+10 = 20/11/2026.
- **Mẹo mở màn có tham số**: các màn ISS-03, ISS-04, ISS-07, AUD-03/05/06/07/08/09/10, CTR-03, CTR-09, CTR-11, CTR-33, PRJ-03, EQP-02, DIS-33 cần một mã trong địa chỉ (`?id=`, `?contract=`, `?engagement=`, `?snapshot=`...). KHÔNG gõ tay: vào từ màn danh sách và bấm vào dòng.

**Menu bên trái (thanh bên) của bản doanh nghiệp**

Thanh bên bản cuối có 10 nhóm nghiệp vụ, đã thêm "Báo cáo gửi Tập đoàn", "Đẩy HPM và đối chiếu EBS" và "Chỉ đạo và giao ban" ngay sau "Giải ngân". Khi đang ở một module khác (vướng mắc, chất lượng, kiểm toán, bàn giao tài sản...) thanh bên hiện thêm mục của module đó; còn lại vào bằng "Tất cả ứng dụng" (thư viện ứng dụng, địa chỉ `/apps`). Trong tài liệu này, ở mỗi hồi dùng đường menu trước, địa chỉ chỉ là phương án dự phòng. Các màn từng bắt "chọn một bản ghi" (CTR-04, CTR-09, CTR-12, CTR-17, CTR-25, PAY-03, DIS-03 đến 08, PRJ-09, PRJ-10) nay mở sẵn một bản ghi được chọn tự động (hợp đồng đang thực hiện có giá trị lớn nhất, dự án đầu tiên đang thẩm định...) kèm ô chọn để đổi.

| Mục thanh bên | Mục con thấy ngay | Màn tương ứng |
|---|---|---|
| Tổng quan | (không có) | HOME-01 |
| Việc của tôi | (không có) | HOME-02 |
| Thông báo | Điều phối thông báo, Vận hành gửi tin, Tùy chọn nhận tin | NOT-01, NOT-06, NOT-04, NOT-03 |
| Dự án | Tiến độ & mốc, Hồ sơ pháp lý, Chủ trương đầu tư, Quyết toán | PRJ-01, PRJ-07, PRJ-04, PRJ-09, PRJ-12 |
| Kế hoạch vốn | Kế hoạch năm, Phân bổ vốn, Điều chỉnh vốn, Theo dõi kế hoạch | CAP-01 (mục cha), CAP-03, CAP-06, CAP-07, CAP-15 |
| Giải ngân | Tổng hợp giải ngân, Thuyết minh tháng, Tiến độ nộp, Lịch kỳ báo cáo | DIS-01 (mục cha), DIS-12, DIS-13, DIS-15, DIS-14 |
| Báo cáo gửi Tập đoàn | Danh mục biểu mẫu, Bản nháp báo cáo, Bản đã phát hành, So sánh chéo | RPT-01 (mục cha), RPT-02, RPT-03, RPT-09 |
| Đẩy HPM và đối chiếu EBS | Đẩy báo cáo lên HPM, Đính chính kỳ đã nhận, Kết nối Oracle EBS, Đối chiếu EBS theo mã dự án | HPM-01 (mục cha), HPM-02, EBS-01, EBS-02 |
| Chỉ đạo và giao ban | Các cuộc giao ban, Bảng theo dõi chỉ đạo, Chỉ đạo của kỳ báo cáo | DIR-01 (mục cha), DIR-03, DIR-05 |
| Hợp đồng | BOQ & mốc thanh toán, Nhật ký công trường, Nghiệm thu, Quyết toán | CTR-01 (mục cha), CTR-04, CTR-09, CTR-12, CTR-17 |
| Thanh toán | Theo dõi Kho bạc, Đối soát giao dịch, Tạm ứng & thu hồi | PAY-01 (mục cha), PAY-04, PAY-05, PAY-07 |
| Nhà thầu | Gói thầu & đề án, Phân tích AI, So sánh đề án, Kế hoạch lựa chọn | BID-01 (mục cha), BID-03, BID-09, BID-10, BID-15 |
| BI & báo cáo | Dashboard của tôi, Thiết kế dashboard, Chỉ tiêu, Phân tích dữ liệu | BI-01 (mục cha), BI-02, BI-03, BI-05, BI-09 |

Mỗi nhóm có nút "Tất cả chức năng" mở thư mục đầy đủ của module (ví dụ Kế hoạch vốn mở được CAP-01 đến CAP-23). Cuối thanh bên có "Tất cả ứng dụng" và "Quản trị & cấu hình".

Các module còn lại không có sẵn trên thanh bên, vào bằng "Tất cả ứng dụng" rồi chọn đúng tên ô (DIR, RPT, HPM, EBS đã có trên thanh bên):

| Tên ô trong "Tất cả ứng dụng" | Module | Dùng ở hồi |
|---|---|---|
| Điều hành | HOME | 9 |
| Vướng mắc & hiện trường | ISS | 7 |
| Hồ sơ pháp lý & giấy phép | PMT | 7 |
| Chất lượng & nhật ký thi công | QMS | 5 |
| Bàn giao tài sản & bảo hành | AST | 10 |
| Thanh tra & kiểm toán | AUD | 10 |
| Mua sắm trang thiết bị | EQP | 4 |
| Quản lý nhà thầu | VND | 3 |
| Văn bản & báo cáo | DOC | 11 |
| Danh mục dùng chung | MDM | 0 |
| Quản trị tổ chức | ADM | 0, 11 |
| Trung tâm thông báo | NOT | 11 |

Ba ô trong thư viện KHÔNG nên bấm trước khách: "Ứng dụng cài đặt cho lãnh đạo" (dẫn tới `/pwa/pwa-01`, màn chưa đăng ký, dùng `/m` thay thế), "Bảng điều hành Ban chỉ đạo" (mô tả còn chữ "toàn tỉnh"; nếu cần dùng `/ban/ban-01` thì tự kiểm lời trước) và "Số liệu từ Sở Tài chính" (của bản công khai).

---

## 1. Tổng quan một trang: câu chuyện 12 hồi

**Một câu cho cả buổi**: "Một dự án đi từ ý tưởng đến hoàn thành, và ở mỗi bước dữ liệu được nhập MỘT lần, nằm ở MỘT nguồn, có vết ai làm gì, và tự chảy sang bước sau." Dòng chảy kinh doanh của hệ thống: nhập, duyệt, rà soát, chốt kỳ, đẩy HPM.

**Chỉ năm khóa cần nhớ** (bấm vào chúng để đi từ màn này sang màn khác): mã dự án `DA-PMDT105` (hoặc `DA-PMTB164`); gói thầu `PMDT105-XL01`; hợp đồng `HD-PMDT105-XL01`; kế hoạch vốn `KHV-2026`; kỳ `ENT-M2026-10` (báo cáo gửi Tập đoàn gọi là `2026-M10`). Các số quyết định `NN/QĐ-HĐTV` là khóa phụ ghi lại "căn cứ pháp lý" của từng bước.

**Sợi chỉ đỏ của buổi trình diễn**: dự án `DA-PMDT105` "Nâng công suất hệ thống nước làm mát", TMĐT 681 tỷ, khu kho cảng Cái Mép. Đi qua nó ở mọi hồi; các dự án khác dùng để cho thấy "mỗi dự án đang ở một giai đoạn khác nhau".

| Hồi | Thời điểm trong câu chuyện | Việc xảy ra | Dữ liệu có thêm ở hồi này | Khóa nối sang hồi sau |
|---|---|---|---|---|
| 0. Nền tảng | Trước dự án đầu tiên | Dựng tổ chức, danh mục, quyền, lịch làm việc | 5 đơn vị; 8 người dùng; 12 quy tắc ủy quyền ký (`41/QĐ-HĐTV`); 3 khu vực đầu tư (`88/QĐ-HĐTV`); 2 nguồn vốn | mã đơn vị `DPM-KHDT-QLDA`, khu `PM-KHO-CANG` |
| 1. Dự án | Từ D-70 | Đăng ký, trình thẩm định, chấm điểm, quyết định, gán mã | 12 dự án (6 đầu tư `DA-PMDT`, 6 mua sắm `DA-PMTB`), TMĐT cộng 4.643 tỷ; 12 tờ trình + 12 thông báo thẩm định; điểm 83, nhóm B; thêm 6 dự án ở các giai đoạn đầu/cuối (PRJ-01 hiện 18 dự án) | `DA-PMDT105`, mã cấp trên `7893001` |
| 2. Vốn | Từ 12/2025 | Giao nguồn, lập kế hoạch năm, công bố, điều chỉnh, kiểm soát hạn mức | 2 nguồn giao (vốn chủ sở hữu 745 tỷ, vốn vay 813 tỷ); `KHV-2026` 20 dòng = 1.534 tỷ, bản 2 chuyển 10 tỷ; `KHV-2025` 1.304 tỷ; kế hoạch trung hạn 52 dòng ‹chưa xác minh›; sổ cái 160 bút toán ‹chưa xác minh› | dòng vốn gắn mã dự án; sự kiện "công bố kế hoạch" tự chuyển dự án sang "Đã bố trí vốn" |
| 3. Nhà thầu | Quý III | Lập kế hoạch lựa chọn, đấu thầu, đánh giá, duyệt kết quả | 16 nhà thầu; 10 kế hoạch thầu; 34 gói; 44 hồ sơ dự thầu; 8 gói trúng thầu có hợp đồng; 2 gói chờ duyệt kết quả | mã gói `PMDT105-XL01` |
| 4. Hợp đồng | D-55 (16/09) | Soạn, bảo lãnh, ký, kích hoạt; thiết bị | 8 hợp đồng ACTIVE = 240,163 tỷ; 6 bảo lãnh 5%; BOQ; 9 dòng thiết bị `TB26-01..09` | `HD-PMDT105-XL01` |
| 5. Thực hiện | D-46 đến nay | Nhật ký, đo khối lượng, kiểm tra, thí nghiệm, nghiệm thu | khối lượng và nghiệm thu 3 tháng (9, 10, 11) ‹chưa xác minh›; 8 đề nghị kiểm tra; 4 phiếu không phù hợp; mốc dự án | số nghiệm thu = đầu vào thanh toán |
| 6. Thanh toán | D-46 đến nay | Bảo lãnh và khoản tạm ứng, đề nghị thanh toán, ngân hàng xác nhận, giữ lại 5% | 19 đề nghị thanh toán (6 tạm ứng, 5 đợt tháng 9, 8 đợt tháng 10); thu hồi tạm ứng; sao kê ngân hàng | `DNTT-PMDT105-XL01-09` |
| 7. Phát sinh | D-30 đến nay | Vướng mắc, leo thang, thay đổi hợp đồng, claim, giấy phép | 11 vướng mắc (6 loại, 24 chính sách SLA) ‹chưa xác minh›; chuỗi thay đổi CE, PCO, CO; 2 claim; hồ sơ giấy phép 4 dự án | `VM-2026-0000nn` ‹chưa xác minh›, `CO-001`, `CLM-001` |
| 8. Chốt kỳ, báo cáo | Tháng 10/2026 | Nhập lô số liệu, khóa kỳ, dựng và chốt bản chốt; lập báo cáo, đẩy HPM, đối chiếu EBS | 24 lô kế hoạch năm + khoảng 48 lô tháng ‹chưa xác minh›; bản chốt `ENT-M2026-10` 928,756 / 1.534 tỷ = 60,54%; 6 báo cáo đã phát hành; 2 lần đẩy HPM; 32 chênh lệch EBS; báo cáo tuần `W2026-46` | bản chốt FROZEN (mã băm SHA-256) |
| 9. Điều hành | Hôm nay | Dashboard, cảnh báo sớm, giao ban và chỉ đạo, điện thoại | HOME-09/07; 3 cuộc giao ban, 6 chỉ đạo (2 quá hạn); cảnh báo `EW-DN-01..03`; 6 việc chờ duyệt trên điện thoại | đọc đúng bản chốt của hồi 8 |
| 10. Kiểm toán, bàn giao, đóng | Hôm nay và sau đó | Kiểm toán nội bộ và thanh tra, bàn giao tài sản, bảo hành, quyết toán, bài học | 4 cuộc kiểm toán/thanh tra (AUD-01 theo dõi 3), 11 kiến nghị; 3 biên bản bàn giao; 2 tài sản; 3 yêu cầu bảo hành; 6 dự án ở giai đoạn đầu/cuối vòng đời ‹chưa xác minh› | kiến nghị gắn mã dự án, hợp đồng |
| 11. Quản trị | Xuyên suốt | Nhật ký kiểm toán, ủy quyền, quy trình duyệt, văn bản, thông báo | nhật ký 50 dòng ở trang đầu; hàng đợi phê duyệt ADM-18 (12 hàng ở trang đầu, số đổi); 12 loại văn bản ủy quyền | mọi hồi trên đều để lại dòng nhật ký |

**Đường đi ngắn nhất qua cả câu chuyện, với `DA-PMDT105` (nếu chỉ có 10 phút)**: PRJ-03 (dự án) rồi CAP-03 (vốn) rồi BID-03 (gói `PMDT105-XL01`) rồi CTR-03 (hợp đồng `HD-PMDT105-XL01`) rồi CTR-12 (nghiệm thu) rồi ISS-01 (vướng mắc I01) rồi DIS-33 (bản chốt) rồi HOME-09 (dashboard) rồi ADM-11 (nhật ký). Chi tiết mục 6.

**Bốn nguyên tắc hệ thống để nhắc ở mọi hồi**

1. Người lập không phải người duyệt: hệ thống từ chối người nhập tự duyệt (mã lỗi `SELF_APPROVAL_DENIED`), kiểm theo tài khoản chứ không theo chức danh.
2. Mọi quyết định đều trỏ vào một văn bản có số hiệu hợp lệ (`NN/QĐ-HĐTV`).
3. Kỳ đã chốt không đổi; muốn mở lại phải có lý do, phạm vi, thời hạn và người duyệt khác người đề nghị.
4. Mọi lệnh để lại dòng nhật ký không sửa được, niêm phong theo chuỗi (ADM-11).

---

## 1b. Đối chiếu bản Giới thiệu v2 → màn hình demo

Khách đã nhận bản "Giới thiệu Hệ thống quản lý DTXD DPM" (v2, 17 trang chiếu) và sẽ mong buổi demo TRẢ LỜI từng điều trong đó. Bảng dưới đi theo thứ tự trang. Cột "Dữ liệu sẵn?": **Có** (mở ra là thấy), **Một phần** (thấy được nhưng thiếu so với lời hứa), **Chưa** (demo không thể hiện). Dấu ‹chưa xác minh› = chưa mở lại trên máy demo thật.

### 1b.1 Bảng đối chiếu

| Trang | Điều bản giới thiệu nói | Mở gì (màn, địa chỉ, người) | Khán giả thấy (dữ liệu thật của demo) | Dữ liệu sẵn? | Nếu chưa đủ thì nói |
|---|---|---|---|---|---|
| 2 | Năm biểu Excel lập song song: (1) tháng gửi PVN, (2) quý gửi PVN, (3) tháng trên HPM, (4) định kỳ cho Ủy ban Đầu tư phát triển - KHCN, (5) giao ban đầu tư hàng tháng | RPT-01 `/rpt/rpt-01?devUser=projectManager` | Danh mục biểu mẫu (9 dòng): `PVN-MONTHLY` (1), `PVN-QUARTERLY-F2` (2), `HPM-MONTHLY` (3), `COMMITTEE-PERIODIC` (4, chỉ có trong danh mục, không phát hành), `INVEST-STEERING` (5), thêm `PLANT-PHU-MY`; các mẫu này mang nhãn "MẪU DEMO - chờ mẫu chính thức"; ngoài ra có biểu mẫu nội bộ `BAN-MEETING-PACK`, `DIS-WEEKLY` ở trạng thái "Đã xác nhận, số liệu thật" | Một phần | "Năm biểu này được sinh từ CÙNG một số liệu. Bố cục hiện là mẫu demo; khi Ban KHĐT bàn giao bố cục chính thức thì nạp vào, không phải viết lại chương trình." Mẫu (4) mới có trong danh mục |
| 2 | 09 đầu mối nhập liệu (07 Ban/Đơn vị và 02 Tổ dự án) | ADM-01 `/adm/adm-01?devUser=owner`; DIS-15 `/dis/dis-15?devUser=owner` | Cây 5 đơn vị `DPM-*`; cả 12 dự án đăng ký ở MỘT đơn vị chủ đầu tư `DPM-KHDT-QLDA`; DIS-15 đếm theo dự án (DIS-01 tuần `W2026-46`: đã gửi 8/13), không theo 09 đầu mối | Chưa | "Demo dựng 5 đơn vị và 8 người dùng mẫu, chưa phải 09 đầu mối thật. Danh sách 09 đầu mối, người nhập, người duyệt là đầu vào ở giai đoạn 1 (trang 15); cấu hình thêm đơn vị và đầu mối làm trên màn hình quản trị, không cần lập trình." Đừng chiếu bảng "theo đơn vị" của HOME-09 như thể có 9 hàng (chỉ có 1) |
| 2 | 10 đến 18 ngày chốt số mỗi tháng (ước ngày 10-15, nhập lại HPM ngày 15-18) | DIS-14 `/dis/dis-14?devUser=owner`; DIS-15 | Lịch kỳ có hạn từng bước (tuần `W2026-46` hạn 13/11 10:00; thuyết minh tháng `M2026-11` hạn 05/12) ‹chưa xác minh›, kỳ `ENT-M2026-10` đã khóa | Một phần | "Demo cho thấy lịch, hạn và nhắc quá hạn. Rút từ 10-18 ngày xuống bao nhiêu sẽ đo thật khi chạy song song hai kỳ với Excel (trang 14, giai đoạn 6); chúng tôi không hứa con số trước khi đo." |
| 2 | 100% thủ công, dữ liệu rải trong tệp, không lưu vết điều chỉnh | ADM-11 `/adm/adm-11?devUser=owner` | 50+ dòng nhật ký: ai, lúc nào, làm gì, trên mã nào; "Xem thay đổi" cho thấy trước và sau ‹chưa xác minh› | Có | – |
| 3 | Hệ quả 1: nhập lại nhiều lần | DIS-28 `/dis/dis-28?devUser=projectManager` rồi RPT-03 `/rpt/rpt-03?devUser=docHead` | Số vốn nhập MỘT lần ở lô số liệu; từ cùng bản chốt `ENT-M2026-10` ra 4 báo cáo kỳ `2026-M10` đã phát hành (`PVN-01/THANG`, `HPM-01/THANG`, `GB-01/THANG`, `NM-01/THANG`) | Có | Kỳ `2026-M09` và `2026-Q3` KHÔNG có bản chốt nên báo cáo dùng số minh họa: không mở nội dung hai bản này |
| 3 | Hệ quả 2: số liệu lệch giữa báo cáo nội bộ và báo cáo gửi PVN | RPT-09 `/rpt/rpt-09?devUser=docHead&kind=MONTH&year=2026&index=5` (kịch bản mục 6.4) | Một số lệch XR-02 chặn phát hành: giải ngân tháng 3/2025 của `DA-PMDT105` (vốn chủ sở hữu) báo cáo lại cao hơn 2 tỷ; hệ thống từ chối phát hành đến khi người khác người lập giải trình | Có (một lần dùng) | Nếu đã dùng rồi: chiếu lại `KN-02` ở AUD-06 (cùng số lệch 2 tỷ xuất hiện trong kiến nghị kiểm toán) hoặc chuyển sang ảnh/clip |
| 3 | Hệ quả 3: rà soát kéo dài, đối chiếu chỉnh sửa | DIS-01 và DIS-11 `/dis/dis-01?devUser=capApprover` (bấm vào báo cáo) | `DA-PMDT137`: bản 1 bị TRẢ LẠI kèm lý do (khối lượng chưa khớp biên bản nghiệm thu tháng 10), bản 2 được chấp nhận, DIS-11 đặt hai bản cạnh nhau; `DA-PMTB180` bị trả lại, chờ chuyên viên sửa ‹chưa xác minh› | Một phần | "Hệ thống rút ngắn vì lỗi bị chặn ngay khi nhập và trả đúng người kèm lý do. Số ngày rút được sẽ đo ở giai đoạn chạy song song." Chỉ có tuần `W2026-46`, không có lịch sử các kỳ trước |
| 3 | Hệ quả 4: không có vết, khó truy xuất khi lãnh đạo hỏi | ADM-11 (`owner`); HOME-10 (bấm dấu "i" cạnh số ở HOME-09) | Mỗi lệnh có người làm; hệ thống từ chối người lập tự duyệt (`SELF_APPROVAL_DENIED`); con số 60,54% truy về đúng bản chốt (mã kỳ, phiên bản, mã băm) | Có | – |
| 3 | Hệ quả 5: HPM chỉ nhận ở bước cuối, không hỗ trợ nhập, duyệt, rà soát | HPM-01 `/hpm/hpm-01?devUser=owner` (không dùng `docHead`); HPM-02 | 2 dòng đẩy: tổng 2, đã ghi chờ biên nhận 1 (`HPM-MONTHLY` `2026-M10`), HPM đã nhận 0, lỗi 0, HPM từ chối 1 (`2026-M09`, tham chiếu `HPM-2026-M09`, ghi biên nhận bởi Nguyễn Văn An lúc 13:30); trạng thái kết nối PENDING-EXTERNAL; bộ ghi tệp thay HPM, không gọi mạng; khóa chống đẩy trùng. HPM-02 chưa có đề nghị đính chính (đúng thiết kế) | Một phần | "Nhập, duyệt, rà soát diễn ra TRONG Mạch Vốn; HPM chỉ nhận gói đã chốt. Kết nối hiện ghi tệp, chờ đặc tả kỹ thuật HPM; chưa có trạng thái 'HPM đã nhận' trong demo." |
| 3 | Kết luận 12/10/2026 (a): mỗi đầu mối 01 người nhập và 01 người duyệt | DIS-28 (`projectManager` lập, `capApprover` chấp nhận); ADM-06 `/adm/adm-06?devUser=capApprover` | Quy tắc `REPORT_ACCEPT`: 1 bước "Lãnh đạo duyệt báo cáo tuần của dự án", người duyệt `owner` hoặc `capApprover`, hạn 8 giờ làm việc ‹chưa xác minh›; người lập khác người duyệt | Một phần | "Cơ chế đã chạy; việc gán đúng người nhập, người duyệt cho từng đầu mối làm cùng Tổng công ty ở giai đoạn 1." |
| 3 | Kết luận (b): số đã duyệt chuyển Ban KHĐT rà soát rồi mới lên HPM | RPT-02 `/rpt/rpt-02?devUser=docHead`; HPM-01 | Báo cáo đi qua ba người khác nhau: `projectManager` lập, `owner` "Xác nhận đã kiểm tra", `docHead` phê duyệt và phát hành; rồi mới đẩy HPM | Một phần | "Bước rà soát của Ban KHĐT hiện thể hiện bằng bước 'kiểm tra' của báo cáo. Bước duyệt nhiều cấp (đơn vị rồi Ban KHĐT) đã có trong mã nhưng demo chỉ nạp quy trình một bước; cấu hình đúng theo quy định của Phú Mỹ khi triển khai." |
| 3 | Kết luận (c): cảnh báo sai sót đến người nhập và người duyệt | HOME-03 `/home/home-03?devUser=owner`, HOME-06; IND-02 `/ind/ind-02?devUser=projectManager` ("Chạy thử các số") | Quy tắc `EW-DN-01..03` (báo cáo tuần chậm: theo dõi, cần xử lý, khẩn), đang hiển thị 7 cảnh báo; IND-02 chạy thử quy tắc "lũy kế không vượt tổng mức đầu tư". Trả lại phải kèm lý do từ 10 ký tự | Một phần | "Cảnh báo có sẵn là loại báo cáo chậm và vướng mắc quá hạn; thêm loại cảnh báo theo từ điển chỉ tiêu của Phú Mỹ khi nhận từ điển." |
| 3 | Kết luận (d): kết nối HPM và Data Lakehouse | HUB-01 `/hub/hub-01?devUser=owner`; HPM-01; INT-04 | HUB-01 liệt kê các kết nối: `hpm.reports` và `ebs.ledger` ở trạng thái chờ bên ngoài (PENDING_EXTERNAL) | Chưa | Xem các dòng trang 5, 6 bên dưới: HPM, EBS ghi nhận tệp; Lakehouse có API mở nhưng chưa nối vào hạ tầng của Tổng công ty |
| 4 | Nhập một lần (1 lần) | DIS-28, DIS-33 | Lô số liệu theo dự án x nguồn vốn nhập một lần, mọi màn sau đọc lại | Có | – |
| 4 | Một nguồn số liệu (1 nguồn) | HOME-09 `/home/home-09?devUser=owner` | 60,54% (928,756 / 1.534 tỷ), cùng kỳ năm trước 46,83%, +13,71 điểm; HOME-07, BAN-01, `/m/dashboard`, báo cáo RPT đều đọc đúng bản chốt đó | Có | Không đặt cạnh nhau các chuỗi số khác (mục 8.3) |
| 4 | Có vết | ADM-11 | Như trên | Có | – |
| 4 | Tự động: biểu mẫu sinh từ cùng số liệu | RPT-01 rồi RPT-02 | Bản nháp lập từ bản chốt, ghi `snapshot_ref` (mã + phiên bản) vào báo cáo | Có | – |
| 4 | Quy trình 5 bước: 1 Nhập, 2 Phê duyệt, 3 Rà soát, 4 Chốt kỳ, 5 Đẩy HPM | 1: DIS-28 (`projectManager`); 2: DIS-28 "Chấp nhận" hoặc `/m/approvals` (`capApprover`); 3: RPT-02 "Xác nhận đã kiểm tra" (`owner`); 4: DIS-14 khóa sổ rồi DIS-33 "Chốt bản này" (`owner`); 5: HPM-01 | Đủ năm bước có dữ liệu thật: lô vốn đã chấp nhận, kỳ `ENT-M2026-10` khóa, bản chốt FROZEN (SHA-256), báo cáo đã phát hành, gói HPM đã ghi | Có (bước 3 một phần, xem dòng "Kết luận (b)") | – |
| 5 | Kiến trúc: web trên máy tính và điện thoại (PWA), quản trị | Web: HOME-09; `/m?devUser=owner`; ADM-01, ADM-03 | Cùng một dữ liệu qua máy tính, PWA và ứng dụng Flutter trên Android | Có | – |
| 5 | Keycloak: đăng nhập một lần (SSO), xác thực đa yếu tố (MFA), liên kết AD | Web: không có. Điện thoại Android: đăng nhập SSO trong app Flutter | Web demo dùng "phiên phát triển" `?devUser=` (không mật khẩu). App Flutter đăng nhập qua một máy chủ định danh THỬ, có bước "Xác thực hai yếu tố" mô phỏng | Chưa | "Đây là bản mô phỏng để thấy luồng. Keycloak thật và liên kết AD cần thông tin AD của Tổng công ty (trang 6, 13 và 15); chưa nhập thử vào máy chủ thật." |
| 5 | Bản chốt kỳ đóng băng, băm SHA-256 | DIS-33 `/dis/dis-33?snapshot=<từ DIS-32>&devUser=owner` | Bản chốt FROZEN phiên bản N, nút "Kiểm tra lại mã băm"; bản cũ thành "đã thay thế" | Có | – |
| 5 | Cơ sở dữ liệu "PostgreSQL 16+", cách ly theo tổ chức (RLS), kho tệp kiểu S3, quét tệp | Không có màn hình | – | Chưa (không nhìn thấy trên giao diện) | "Máy demo dùng cơ sở dữ liệu PostgreSQL nhúng tự khởi động và tự xóa khi tắt, chỉ để trình diễn. Cơ sở dữ liệu thật (PostgreSQL 16 trở lên), cách ly theo tổ chức và kho tệp được cài trên máy chủ UAT/Production của Tổng công ty." Demo chỉ có một tổ chức nên không thể chiếu cách ly |
| 5 | Nhật ký kiểm toán chuỗi băm, niêm phong | ADM-11 | "Xuất có niêm phong" (tối đa 366 ngày) | Có | – |
| 5, 6 | Integration Hub: HPM (cổng HpmPort, ghi tệp chuẩn, khóa chống trùng) | HUB-01 rồi HPM-01 (`owner`) | `hpm.reports` PENDING_EXTERNAL; 2 lần đẩy; khóa chống đẩy trùng, bản cũ bị từ chối | Một phần | "Chờ đặc tả kỹ thuật HPM; hiện ghi tệp. Khi có đặc tả chỉ thay bộ chuyển tiếp, nghiệp vụ giữ nguyên." |
| 5, 6 | Oracle EBS: nạp tệp, chạy thử không ghi, đối chiếu theo mã dự án và kỳ | EBS-01, EBS-02 `/ebs/ebs-02?devUser=owner`; INT-03 (ánh xạ mã) | Tệp trích 07/11/2026 (16 dòng, 8 dự án x 2 kỳ), 32 chênh lệch có chủ, hạn, giải trình. EBS-02 chạy trên tệp của chính nó, không so với bản chốt DIS-33 | Một phần | "Định dạng tệp là giả định, chờ mẫu tệp và quyền đọc EBS. Chênh lệch ở đây là minh họa." INT-03 chưa có dữ liệu mẫu, đừng hứa xem ánh xạ mã |
| 5, 6 | Data Lakehouse, Power BI: API mở `/open/v1`, token ngắn hạn, tập dữ liệu chứng nhận, đăng nhập CSDL chỉ đọc | INT-01 `/int/int-01?devUser=owner`, INT-04, INT-05 | Các màn có và chạy nhưng TRỐNG (chưa mở tài khoản máy, chưa có tài khoản BI) | Chưa | "Cơ chế đã có sẵn (chính trang 6 cũng ghi 'mô hình Power BI mẫu chưa có'). Hôm nay xem BI nội bộ ở BI-01. Nối Lakehouse thật khi có thông tin hạ tầng." |
| 5, 6 | eProcurement, văn thư: nhập tay hoặc tệp; Email và Teams: nhắc việc | BID-03, DOC-12; RML-01; NOT-01 | Gói thầu, văn bản trong hệ thống; nhắc việc trong hệ thống (chuông thông báo). RML-01 (email theo lịch) không có lịch nào | Một phần | "Chờ đặc tả eProcurement, văn thư và thông tin SMTP, Teams. Hiện nhắc trong hệ thống." Chuông thông báo hiện tiêu đề chung "Thông báo mới" nên chỉ giới thiệu luồng ở NOT-06 |
| 7 | Một bản chốt, nhiều đầu ra: biểu mẫu Excel/Word/PDF, dashboard, gói HPM, đối chiếu EBS | DIS-33 → RPT-02, HOME-09, HPM-01, EBS-02 | Biểu mẫu phát hành bất biến có mã băm; dashboard cùng số; gói HPM khóa chống trùng | Một phần | Chính trang 7 ghi "đang hoàn thiện": sáu biểu mẫu chạy trên dữ liệu minh họa có đánh dấu. Chưa kiểm xuất đủ cả ba định dạng Excel, Word, PDF ‹chưa xác minh› |
| 8 | Master data và danh mục dự án: mã thống nhất, ánh xạ mã HPM/EBS; nhóm A/B/C, loại hình, giai đoạn; hồ sơ pháp lý, mốc, lịch sử | MDM-25 và MDM-32; PRJ-01, PRJ-14, PRJ-03; PMT-01; PRJ-07 | 18 dự án, mã `DA-PM...`, mã cấp trên `7893001..`, nhóm B/C, 7 giai đoạn; hồ sơ giấy phép 4 dự án; 4 mốc mỗi dự án ‹chưa xác minh› | Có (ánh xạ mã HPM/EBS: chưa) | Ánh xạ mã sang HPM và EBS (INT-03) chưa có dữ liệu mẫu |
| 8 | Bộ dữ liệu nền và từ điển chỉ tiêu: công thức, quy tắc kiểm khi nhập, nhập Excel; quản trị tự đổi | IND-01, IND-02, IND-03 (`/ind/ind-02?devUser=projectManager`); ADM-19 | Từ điển chỉ tiêu khởi đầu (đánh dấu "chưa xác minh"), quy tắc mẫu (lũy kế không vượt tổng mức, tổng thành phần bằng tổng, kỳ khóa không nhập, trường bắt buộc), nút "Chạy thử các số" | Một phần | "Từ điển chỉ tiêu và nguyên tắc nhập liệu của Phú Mỹ là đầu vào chờ khách bàn giao (trang 15)." Không có số nhập tay hay tệp Excel mẫu để chiếu |
| 8 | Quy trình To-Be và kỳ báo cáo: lịch kỳ, theo dõi từng đầu mối, nhắc quá hạn, mở lại kỳ có đề nghị và duyệt | DIS-14, DIS-15, DIS-22 `/dis/dis-22?devUser=capApprover` | Kỳ `ENT-M2026-10` đã khóa; `ENT-M2026-05` đã mở lại và có bản sửa 2 (bản 1 giữ nguyên); tiến độ nộp tuần `W2026-46`: đã gửi 8/13 | Có | – |
| 8 | Kế hoạch vốn năm và các phiên bản; tự tính lũy kế, tỷ lệ so kế hoạch và cùng kỳ; thuyết minh, khó khăn vướng mắc | CAP-03, CAP-07 (`owner`); HOME-09; DIS-13; ISS-01 | `KHV-2026` bản 2 (1.534 tỷ); tỷ lệ 60,54% so 46,83%; thuyết minh tháng `M2026-11` với khối 8 trường; 11 vướng mắc theo dự án | Có | Nhắc dặn ở mục 8.3: không đặt CAP-03 cạnh HOME-09 cho `DA-PMDT105`/`DA-PMDT114` |
| 9 | Chỉ đạo giao ban: đơn vị thực hiện, hạn, trạng thái, tiến độ, dòng thời gian; cập nhật được trên điện thoại | DIR-01, DIR-03 (`owner`); `/m/directives` | 3 cuộc giao ban, 6 chỉ đạo, 2 quá hạn (`GB-2026-001/CD-01`, `GB-2026-002/CD-03`); dòng thời gian ở DIR-04 (mở từ DIR-03) | Có | Chỉ đạo của `GB-2026-003` nói "gói thầu thiết bị chính" nhưng gắn `DA-PMDT154`: đừng đọc nội dung đó |
| 9 | Đẩy HPM kèm biên nhận; đối chiếu EBS với chủ, hạn, giải trình | HPM-01; EBS-02 | Như các dòng trang 5, 6 | Một phần | Như trên: chưa có "HPM đã nhận" |
| 10 | Báo cáo theo biểu mẫu: điền thẳng vào Excel mẫu giữ bố cục; xuất Excel, Word, PDF; bản phát hành bất biến, có mã băm | RPT-02, RPT-03 (`docHead`) | 6 bản đã phát hành, mỗi bản có mã băm; ba người ký | Một phần | Bố cục chính thức chờ Ban KHĐT; xuất Word, PDF chưa kiểm ‹chưa xác minh› |
| 10 | Dashboard lãnh đạo: số truy nguồn, màu xanh vàng đỏ có giải thích; chế độ trình chiếu | HOME-09 (nút "Trình chiếu"); HOME-10; HOME-11 `/home/home-11?devUser=owner` | Trình chiếu chạy từng bảng chữ lớn toàn màn hình; truy nguồn từng số; giải thích màu | Có | Dùng bảng "Tỷ lệ giải ngân theo đơn vị", không dừng ở thẻ "Xếp hạng" cuối trang (ghi "Chưa có dữ liệu") |
| 11 | Cảnh báo: việc quá hạn, việc bị hoãn, loại cảnh báo nhiều nhất, việc cần xử lý ngay | HOME-03, HOME-12, HOME-13, HOME-02 (`owner`) | Cảnh báo `EW-DN-01..03`; "Cần xử lý ngay" hiện vướng mắc quá hạn ‹chưa xác minh› | Có | Nội dung các màn HOME-12, HOME-13 chưa kiểm ‹chưa xác minh› |
| 11 | Nhà thầu: hồ sơ chủ, kiểm mã số thuế, gắn gói thầu và hợp đồng | BID-01, VND-01 (`owner`); CTR-03 | 16 nhà thầu theo mã số thuế (13 đã xác minh, 2 chưa, 1 bị từ chối); Nam Việt gắn `PMDT105-XL01` và `HD-PMDT105-XL01` | Có | – |
| 11 | Cây tiến độ: mọi gói thầu xếp thành cây theo hình thức và bước; nhấn vào bước xem các gói | BID-27 `/bid/bid-27?devUser=owner`, BID-28, BID-29 | Cây có gói ở các bước khác nhau: đóng thầu, đánh giá, trả lại ở bước duyệt hồ sơ, tạm giữ ở bước đánh giá ‹chưa xác minh› | Có | – |
| 12 | Điện thoại cho người quản lý: trang chủ, danh sách dự án, hàng đợi duyệt (duyệt hoặc trả về kèm ý kiến), dashboard, chỉ đạo | `/m/approvals?devUser=owner`, `/m/dashboard`, `/m/directives`; app Flutter Android | 6 báo cáo tuần chờ lãnh đạo (41,0; 27,5; 18,2; 12,4; 7,2; 4,6 tỷ) ‹chưa xác minh›; app Flutter: Trang chủ điều hành, Dự án, Thông báo | Có | Phê duyệt trong app Flutter không chiếu được (màn đen) |
| 12 | Thông báo đẩy mở đúng màn hình; cài lên màn hình như ứng dụng; truy cập từ ngoài qua SSO và MFA | `/m/notifications`; `/m/settings` | Màn cài đặt thông báo đẩy (không phải hộp thư); thẻ "Cài đặt ứng dụng" báo "Chỉ cài đặt được khi trang chạy qua HTTPS" | Chưa | "Cài PWA và thông báo đẩy cần chạy qua HTTPS trên bản phát hành, và truy cập từ ngoài mạng cần SSO, MFA: làm ở môi trường UAT của Tổng công ty. Hôm nay xem trên Android bằng app thử." |
| 13 | An toàn thông tin: quyền theo hành động, phạm vi đơn vị, dự án, kỳ; TLS; cách ly dữ liệu; nhật ký chuỗi băm; sao lưu và khôi phục | ADM-03; `nobody` mở một màn nghiệp vụ (`/prj/prj-01?devUser=nobody`); ADM-11; ADM-32 | Phân quyền thật ở máy chủ: bấm sai vai bị từ chối (403); nhật ký chuỗi băm. ADM-32 có màn sao lưu nhưng KHÔNG có dữ liệu mẫu ‹chưa xác minh› | Một phần | Chính trang 13 ghi rõ phần "đang hoàn thiện": kiểm thử xâm nhập độc lập, quét mã độc tệp tải lên, chu kỳ sao lưu tuần/tháng, diễn tập khôi phục trên máy của Tổng công ty |
| 14 | Bảy giai đoạn Waterfall (GĐ1 đến GĐ7) | Không có gì để mở | – | Chưa (không phải chức năng) | "Lộ trình phối hợp với Tổng công ty; mỗi giai đoạn chỉ bắt đầu khi sản phẩm giai đoạn trước được xác nhận." |
| 15 | Việc Tổng công ty cần cung cấp: bố cục biểu mẫu, từ điển chỉ tiêu, 09 đầu mối, danh mục dự án, mã HPM/EBS, đặc tả HPM/EBS/eProcurement, AD, SMTP, Teams, máy chủ | Không có gì để mở | – | Chưa (không phải chức năng) | "Khi chưa có, hệ thống dùng giả định ghi rõ và dữ liệu minh họa." Đó chính là những gì khách đang thấy hôm nay (MẪU DEMO, tệp giả định) |
| 16 | Màn 1: Tổng quan lãnh đạo | HOME-09 `/home/home-09?devUser=owner` | 60,54%, 46,83%, +13,71 điểm; bảng theo dự án; nút "Trình chiếu" | Có | – |
| 16 | Màn 2: Chỉ đạo giao ban | DIR-01 `/dir/dir-01?devUser=owner`, DIR-03 | 3 cuộc giao ban, 6 chỉ đạo, 2 quá hạn | Có | – |
| 16 | Màn 3: Kỳ chốt đẩy sang HPM | DIS-33 (`owner`), HPM-01 (`owner`) | Bản chốt FROZEN kỳ `ENT-M2026-10` có mã băm; gói `HPM-MONTHLY 2026-M10` "Đã ghi gói, chờ biên nhận" | Có | Nói rõ kết nối là tệp giả định |
| 16 | Màn 4: Báo cáo gửi Tập đoàn | RPT-01, RPT-02, RPT-03 (`docHead`) | 6 bản đã phát hành, nhãn "MẪU DEMO", mã băm | Có | Chỉ mở báo cáo kỳ `2026-M10` |
| 16 | Màn 5: Trung tâm báo cáo phân tích | BI-01 `/bi/bi-01?devUser=owner` | `BD-LANH-DAO`, `BD-HOP-DONG`, `BD-NHA-THAU`, `BD-TAM-UNG-BAO-LANH` (đã công bố); BI-02: 25 ô chỉ tiêu | Có | Bản cuối đã công bố 4 dashboard; mở `BD-LANH-DAO` hoặc BI-02 (25 ô chỉ tiêu). Hai dashboard còn là bản nháp, đừng mở |
| 16 | Màn 6: Cây tiến độ gói thầu | BID-27 và BID-29 (`owner`) | Như trang 11 | Có | – |
| 16 | Clip giới thiệu `phu-my-gioi-thieu.mp4` (khoảng 10 phút) | Máy chiếu | – | Có (tệp riêng) | Dùng làm phương án dự phòng nếu máy demo hoặc điện thoại gặp sự cố |

### 1b.2 Điều bản giới thiệu hứa nhưng demo CHƯA thể hiện được (trả lời thật thà)

| Điều được hứa | Tình trạng trong demo | Trả lời |
|---|---|---|
| 09 đầu mối nhập liệu (07 Ban/Đơn vị và 02 Tổ dự án) | Demo có 5 đơn vị `DPM-*`, 8 người dùng mẫu và MỘT đơn vị chủ đầu tư (`DPM-KHDT-QLDA`) cho cả 12 dự án; chưa có 09 đầu mối nhiều người nhập | "Số đầu mối và người nhập, người duyệt do Tổng công ty chỉ định (trang 15). Thêm đầu mối là cấu hình trên màn hình quản trị, không phải lập trình." |
| SSO, MFA, liên kết AD (Keycloak) | Web dùng phiên phát triển `?devUser=`; app Android dùng máy chủ định danh thử | "Chờ thông tin AD của Tổng công ty; cấu hình và kiểm tra trên máy chủ thật ở giai đoạn 3." |
| Email, Microsoft Teams | Không có SMTP, Teams; RML-01 (gửi biểu mẫu qua email theo lịch) không có lịch; nhắc việc chỉ trong hệ thống | "Chờ SMTP và địa chỉ Teams của Tổng công ty." |
| Data Lakehouse, Power BI qua API mở | INT-01..05 trống; chưa có mô hình Power BI mẫu | "Cơ chế có sẵn; nối thật khi Tổng công ty cung cấp hạ tầng và quyền đọc." |
| HPM (API) và Oracle EBS (đọc thật) | Chỉ tệp giả định; mục PENDING-EXTERNAL; không có "HPM đã nhận" | "Định dạng thật theo đặc tả HPM và mẫu tệp EBS khi nhận được." |
| eProcurement, văn thư | Nhập tay hoặc theo tệp; e-GP thuộc bản công khai, không có trong dữ liệu doanh nghiệp | "Chờ đặc tả hệ thống." |
| Ứng dụng native iOS | Chưa; app Flutter chỉ dựng cho Android (iOS cần máy Mac). Chính trang 12 gọi native là "hướng mở rộng" | "Giai đoạn đầu dùng PWA (iPhone dùng được qua trình duyệt); Android đã có bản chạy thử." |
| Cài PWA lên màn hình, thông báo đẩy, truy cập ngoài mạng | Bản demo là bản phát triển, không cài được; thẻ cài đặt báo cần HTTPS | "Làm trên môi trường UAT với HTTPS và SSO." Có thể chiếu clip quay sẵn nếu khách muốn thấy cài thật |
| Gói cài ngoại tuyến và hai môi trường UAT, Production | Demo chạy từ mã nguồn trên một máy, không minh họa gói cài | "Là hạng mục triển khai trên máy chủ của Tổng công ty (giai đoạn 3)." |
| PostgreSQL 16+, cách ly dữ liệu theo tổ chức (RLS), kho tệp S3, quét tệp | Không có màn hình; demo có một tổ chức và cơ sở dữ liệu nhúng tự xóa khi tắt | "Là nền tảng bên dưới, kiểm chứng bằng kiểm thử tự động và kiểm thử xâm nhập độc lập (trang 13)." |
| Kiểm thử xâm nhập độc lập; quét mã độc; sao lưu tuần/tháng/khác biệt; diễn tập khôi phục | Chưa có để chiếu; ADM-32 không có dữ liệu | "Trang 13 đã nêu là đang hoàn thiện; sẽ phối hợp chọn đơn vị độc lập với Tổng công ty." |
| Bố cục chính thức biểu mẫu và từ điển chỉ tiêu của Phú Mỹ | Sáu biểu mẫu là MẪU DEMO; mẫu (4) cho Ủy ban chỉ có trong danh mục; từ điển chỉ tiêu "chưa xác minh" | "Thay vào gói biểu mẫu và từ điển khi Ban KHĐT bàn giao." |
| Duyệt nhiều cấp (đơn vị rồi Ban KHĐT rồi chốt kỳ) theo đúng kết luận 12/10 | Mã đã có bước đơn vị, bước Ban KHĐT, bước chốt kỳ; demo chỉ nạp một bước "Chấp nhận" | "Quy trình là dữ liệu cấu hình; thiết lập theo quy định của Phú Mỹ ở giai đoạn thiết kế." |
| Rút ngắn thời gian chốt số (từ 10-18 ngày) | Chưa đo, vì cần chạy song song 2 kỳ thật với Excel | "Chúng tôi sẽ đo ở giai đoạn 6, không đưa con số khi chưa có." |
| Dữ liệu lịch sử và dữ liệu thật của Phú Mỹ | Toàn bộ là dữ liệu minh họa; tuần/tháng cũ gần như trống | "Phạm vi dữ liệu lịch sử cần chuyển do Tổng công ty xác định (trang 15)." |

---

## 2. Vai trò (8 người dùng demo) và ai làm gì

Chuỗi trình diễn chuẩn: `projectManager` lập, `capApprover` duyệt, `owner` là "người thứ hai" hoặc thay `capApprover`. Quyền thật nằm ở máy chủ: giao diện hiện đủ nút nhưng bấm sai vai trò thì nhận lỗi 403, đây cũng là một cách minh họa "kiểm soát".

| `devUser` | Người (minh họa) | Đơn vị | Làm gì trong câu chuyện | Dùng để cho xem | Giới hạn cần biết |
|---|---|---|---|---|---|
| `owner` | Nguyễn Văn An | Tổng công ty (DPM-HQ) | Chủ tenant; người thứ hai của mọi cặp lập/duyệt: chấm thẩm định, xác minh nhà thầu và bảo lãnh, ký và kích hoạt hợp đồng, duyệt nghiệm thu, đóng băng bản chốt, kiểm báo cáo, ghi biên nhận HPM, xin mở lại kỳ, xác nhận hoàn tất vướng mắc | Vai mặc định cho hầu hết màn: HOME-09, HOME-07, CAP, DIS-33, DIR, HPM, EBS, ADM, AUD | Là người đăng nhập sẵn trên điện thoại và trên cổng 5443 |
| `capApprover` | Trần Thị Bích | Ban Kế hoạch và Đầu tư | Lãnh đạo: quyết định thẩm định, duyệt giao vốn, duyệt và công bố kế hoạch vốn, duyệt kế hoạch thầu và kết quả thầu, duyệt lô số liệu, duyệt mở lại kỳ, công bố quy tắc cảnh báo, lập và gửi nghiệm thu, giao việc xử lý vướng mắc, duyệt báo cáo tuần | Mọi màn "Duyệt", "Công bố", "Quyết định"; chỉ đọc ở các màn khác | KHÔNG lập; chưa thử đăng nhập vai này trên app điện thoại |
| `projectManager` | Phạm Quốc Dũng | Ban Quản lý dự án đầu tư | Cán bộ: đăng ký dự án, trình thẩm định, lập kế hoạch vốn, kế hoạch thầu, hợp đồng, đo khối lượng, đề nghị thanh toán, ghi vướng mắc, lập lô số liệu, dựng bản chốt, lập báo cáo, nhập EBS, đẩy HPM | PRJ, EQP, CTR (soạn), QMS, ISS, DIS-28/32, RPT-01, HPM (lập) | KHÔNG duyệt, công bố, ký, nghiệm thu; không phân công lãnh đạo ở PRJ-17 |
| `docHead` | Trần Văn Hùng | Tổng công ty | Trưởng phòng soạn thảo: phê duyệt và phát hành 6 mẫu báo cáo, ghi giải trình số lệch RPT-09 | RPT-01, RPT-02, RPT-03, RPT-09, DOC | KHÔNG vào được HPM-01 và HPM-02: dùng `owner` |
| `treasuryMaker` | Hoàng Thị Lan | Ban Tài chính Kế toán | Kế toán thanh toán: kiểm soát và gửi đề nghị thanh toán, ghép giao dịch ngân hàng | PAY-01, PAY-05 (nếu cần mở bằng đúng vai) | Phần lớn các màn khác chỉ đọc |
| `unitAdmin` | Lê Minh Cường | Ban Kế hoạch và Đầu tư | Quản trị đơn vị | Hầu như không dùng | Thiếu quyền đọc ADM-01, ADM-02, ADM-03: ĐỪNG dùng để cho xem quản trị |
| `auditor` | Vũ Đức Minh | Tổng công ty | Kiểm toán viên, chỉ đọc | Chỉ minh họa "chỉ đọc" | Không vào được module AUD; ADM-11 có thể báo không có quyền: mở ADM-11 bằng `owner` |
| `nobody` | Đỗ Thị Hà | Văn phòng Ban KH&ĐT | Thành viên thường, quyền tối thiểu | Minh họa màn "không có quyền" (kiểm soát truy cập) | – |

Những việc KHÔNG làm được bằng 8 vai này, nên đừng hứa trình diễn sống: mọi việc của nhà thầu (chữ ký nhà thầu trên nhật ký công trường, cổng nhà thầu); chấp nhận lời mời thành viên ở ADM-02; "HPM đã nhận" và đính chính kỳ đã nhận; toàn bộ module quản trị nền tảng SaaS.

---

## 3. Mười hai hồi, từng hồi một

Mỗi hồi có: dữ liệu lúc này; bảng màn hình theo thứ tự mở; nối trước và sau; kiểm soát hệ thống để chỉ ra; lời dẫn; điều cần tránh. Cột "Người" là `devUser` nên dùng và lý do ngắn.

### Hồi 0. Nền tảng: tổ chức, danh mục, quyền, lịch (khoảng 1,5 phút)

**Dữ liệu lúc này**: 5 đơn vị `DPM-*`; 8 người dùng; vai trò hệ thống cộng 3 vai trò thêm cho buổi demo ‹chưa xác minh›; 12 quy tắc ủy quyền ký; 3 khu vực đầu tư; 2 nguồn vốn; lịch làm việc `WORKDAY_VN` 2026 và 2027; lịch kỳ báo cáo `ENTERPRISE`.

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 0.1 | ADM-01 Cây tổ chức (Tất cả ứng dụng, ô "Quản trị tổ chức") | `/adm/adm-01?devUser=owner` | `owner`: thấy toàn cây | Tổng công ty Đạm Phú Mỹ `DPM-HQ`; dưới nó Ban Kế hoạch và Đầu tư `DPM-KHDT` (kèm Văn phòng `DPM-KHDT-VP` và Ban Quản lý dự án đầu tư `DPM-KHDT-QLDA`) và Ban Tài chính Kế toán `DPM-TCKT`. Cả 12 dự án thuộc `DPM-KHDT-QLDA` |
| 0.2 | ADM-02 Người dùng và mời thành viên | `/adm/adm-02?devUser=owner` | `owner` | Thành viên đang dùng; 7 lời mời ở trạng thái "Chờ chấp nhận" vào 5 đơn vị ‹chưa xác minh›. Chỉ nói: lời mời gửi qua email, người được mời tự chấp nhận (không bấm thay) |
| 0.3 | ADM-03 Vai trò và quyền | `/adm/adm-03?devUser=owner` | `owner` | Vai trò gắn theo đơn vị: Lãnh đạo (LANH_DAO_SO), Cán bộ ban QLDA (CAN_BO_BAN_QLDA), Kế toán thanh toán; thêm 3 vai trò tạo cho demo: LAP_BI "Lập bảng điều hành", DUYET_BI "Duyệt và công bố bảng điều hành", XAC_NHAN_VUONG_MAC "Xác nhận hoàn tất và gia hạn vướng mắc" ‹chưa xác minh›. Cấp vai trò đòi xác thực bước hai (hộp "Xác thực") |
| 0.4 | MDM-25 đề xuất danh mục, rồi MDM-32 duyệt và công bố (Tất cả ứng dụng, ô "Danh mục dùng chung") | `/mdm/mdm-25?devUser=projectManager`, `/mdm/mdm-32?devUser=capApprover` | `projectManager` đề xuất, `capApprover` duyệt | 3 khu vực công bố theo `88/QĐ-HĐTV` (12/08/2026, "Quyết định về việc công bố danh mục khu vực đầu tư của Tổng công ty"): `PM-KCN-PHU-MY` Khu công nghiệp Phú Mỹ (6 dự án), `PM-NHA-MAY-DAM` Khu nhà máy Đạm Phú Mỹ (3 dự án), `PM-KHO-CANG` Khu kho cảng Cái Mép (3 dự án) |
| 0.5 | ADM-15 Ma trận thẩm quyền phê duyệt | `/adm/adm-15?devUser=owner` | `owner` | 12 loại văn bản (QĐ, công văn, báo cáo, tờ trình, hợp đồng, bảo lãnh...), mức tiền từ 0, người duyệt vai trò Lãnh đạo, căn cứ `41/QĐ-HĐTV` (ban hành 14/04/2026, hiệu lực 24/04/2026). CHỈ chỉ vào bảng, đừng đọc dòng "căn cứ" (xem mục 8) |
| 0.6 | ADM-07 Lịch công tác và ngày nghỉ; MDM-11 lịch kỳ | `/adm/adm-07?devUser=owner`, `/mdm/mdm-11?devUser=owner` | `owner` | Lịch `WORKDAY_VN` (thứ Hai đến thứ Sáu kèm ngày lễ). Hạn xử lý của vướng mắc và của từng bước duyệt tính theo giờ làm việc trên lịch này |

**Nối sang hồi sau**: đơn vị `DPM-KHDT-QLDA` và khu `PM-KHO-CANG` được chọn khi đăng ký dự án (hồi 1). Lịch kỳ `ENTERPRISE` sinh ra kỳ `ENT-M2026-10` (hồi 8). Ma trận ủy quyền được "ghim" phiên bản vào mỗi hồ sơ ký (hồi 11).

**Kiểm soát đang minh họa**: danh mục có phiên bản; người đề xuất khác người duyệt; công bố phải kèm văn bản quyết định hợp lệ; cấp quyền cần xác thực hai bước.

> **Lời dẫn**: "Trước khi có dự án nào, hệ thống đã biết công ty có những đơn vị nào, ai được ký việc gì, khu vực đầu tư nào được công bố, và lịch làm việc để tính hạn. Mọi danh mục đều có người đề xuất, người duyệt và một quyết định của Hội đồng thành viên làm căn cứ."

---

### Hồi 1. Dự án ra đời, được thẩm định và được tổ chức (khoảng 3 phút)

**Dữ liệu lúc này**: 12 dự án chính (6 đầu tư xây dựng mã `DA-PMDT105/114/120/130/137/154`, 6 mua sắm thiết bị mã `DA-PMTB164/168/172/180/191/204`) với tổng mức đầu tư 4.643 tỷ (đầu tư 3.925 tỷ, mua sắm 718 tỷ). Cộng thêm 6 dự án ở các giai đoạn đầu và cuối vòng đời (mã `DA-PMDT901` đến `DA-PMTB906`, TMĐT nhỏ 8 đến 62 tỷ) để cho thấy "mọi giai đoạn", tổng 18 dự án. Mỗi dự án chính có: tờ trình `NNN/TTr-BQLDA` (01/09/2026), phiếu chấm điểm (điểm 83, nhóm B hoặc C), thông báo thẩm định `NNN/TB-HĐTĐ` (01/10/2026), mã dự án cấp trên `7893001..7893010`, 4 cấu phần, 4 mốc, 3 rủi ro, người phụ trách.

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 1.1 | PRJ-14 Ngân hàng dự án và vòng đời (thanh bên: Dự án, nút "Tất cả chức năng") | `/prj/prj-14?devUser=projectManager` | `projectManager`: người đăng ký và theo dõi | Các cột giai đoạn: Ý tưởng 1 (`DA-PMDT901`), Thẩm định 1 (`DA-PMDT902`), Ngân hàng dự án 2 (`DA-PMDT154`, `DA-PMTB204`), Đã bố trí vốn 4, Đang thực hiện 6, Tạm dừng 1 (`DA-PMDT904`), Hoàn thành 2 (`DA-PMTB905`, `DA-PMTB906`); tích "hiện giai đoạn đã kết thúc" thì thêm Bị từ chối 1 (`DA-PMDT903`). Đây là "bức tranh toàn danh mục" |
| 1.2 | PRJ-01 Danh sách dự án (thanh bên: Dự án) | `/prj/prj-01?devUser=projectManager` | `projectManager` | 18 dự án; cột "Mã dự án cấp trên" (`7893001`...), cột "Lãnh đạo phụ trách" có tên. Bấm mã `DA-PMDT105` để vào dự án |
| 1.3 | PRJ-03 Không gian dự án (bấm từ PRJ-01) | `/prj/prj-03?id=<từ danh sách>&devUser=projectManager` | `projectManager` | `DA-PMDT105` "Nâng công suất hệ thống nước làm mát (1)": giai đoạn Đang thực hiện, TMĐT 681 tỷ, 2026 đến 2029, điểm thẩm định 83, nhóm B, địa bàn Khu kho cảng Cái Mép, mã cấp trên `7893001`. Bản cuối có 5 tab làm việc: Tổng quan, Mục tiêu, Kế hoạch, Giải ngân, Vướng mắc (thêm `&tab=plan` v.v. vào địa chỉ để mở thẳng). Nội dung từng tab chưa được đọc lại trên bản cuối: mở thử trước giờ |
| 1.4 | PRJ-15 Chấm điểm thẩm định | `/prj/prj-15?devUser=owner` | `owner`: người chấm phải khác người đề xuất | Tự chọn `DA-PMDT902` "Cải tạo hệ thống chiếu sáng và phòng cháy khu kho cảng (8)" (đang thẩm định, tờ trình `902/TTr-BQLDA`): phiếu chấm TRỐNG với 5 tiêu chí (Phù hợp chiến lược 25, Khả thi 25, Hiệu quả 20, Khả năng cân đối vốn 20, Rủi ro 10; điểm 0 đến 5). Chỉ cho xem, ĐỪNG bấm "Ghi phiếu" trừ khi muốn làm sống (xem 1.5) |
| 1.5 | PRJ-10 Thẩm định và quyết định | `/prj/prj-10?devUser=capApprover` (mở sẵn dự án đầu tiên đang thẩm định, có ô chọn) | `capApprover`: người quyết định khác người đề xuất | `DA-PMDT903` "Xây dựng nhà điều hành phụ trợ khu công nghiệp": không chấp thuận, lý do trùng phạm vi với kho chứa. `DA-PMDT902`: "chưa có phiếu". Quyết định cho dự án chính nằm ở thông báo `NNN/TB-HĐTĐ`. Làm sống (chấm điểm rồi quyết định) cần dán UUID văn bản vào ô: chỉ làm khi đã chuẩn bị sẵn ‹chưa xác minh› |
| 1.6 | PRJ-17 Phân công lãnh đạo phụ trách | `/prj/prj-17?devUser=owner` | `owner` hoặc `capApprover` (`projectManager` không phân công được) | `DA-PMDT105/130`, `DA-PMTB164/180`: Trần Thị Bích phụ trách; các dự án còn lại: Phạm Quốc Dũng; Phạm Quốc Dũng làm đầu mối khi lãnh đạo là Trần Thị Bích. Văn bản `2xx/QĐ-HĐTV` "Quyết định phân công lãnh đạo phụ trách dự án..." (cột "Văn bản phân công" đang hiện chuỗi mã, đừng đọc) ‹chưa xác minh› |
| 1.7 | PRJ-05 Cấu phần và WBS (mở từ PRJ-03 hoặc "Tất cả chức năng" của Dự án) | `/prj/prj-05?id=<DA-PMDT105>&devUser=projectManager` | `projectManager` | 4 cấu phần của `DA-PMDT105` cộng đúng 681 tỷ: CP1 Xây lắp 62% = 422,22 tỷ; CP2 Thiết bị công nghệ và phụ trợ 20% = 136,2 tỷ; CP3 Tư vấn và QLDA 8% = 54,48 tỷ; CP4 Chi phí khác và dự phòng 10% = 68,1 tỷ ‹chưa xác minh› |
| 1.8 | PRJ-07 Tiến độ và mốc (thanh bên: Dự án, Tiến độ & mốc) | `/prj/prj-07?devUser=projectManager` | `projectManager` | 4 mốc mỗi dự án: GĐ1 hoàn thành; GĐ2 CHẬM kèm lý do (ví dụ "Bàn giao mặt bằng và khởi công" chậm do chờ phê duyệt biện pháp thi công trong khu vực đang vận hành); GĐ3 và GĐ4 sắp tới ‹chưa xác minh›. Dự án mua sắm: mốc "Nhà sản xuất giao thiết bị chính" chậm do nhà sản xuất lùi lịch |
| 1.9 | PRJ-16 Sổ rủi ro; PRJ-18 Tổ công tác | `/prj/prj-16?devUser=projectManager`, `/prj/prj-18?devUser=owner` | `projectManager`, `owner` | PRJ-16: 3 rủi ro mỗi dự án (R01 đã leo thang, R02 quá hạn đang xử lý, R03 theo dõi), 5 nhóm rủi ro công bố theo `176/QĐ-HĐTV`. PRJ-18: `TCT-2026-01` "Tổ công tác đôn đốc giải ngân và tiến độ các dự án đầu tư năm 2026" (`178/QĐ-HĐTV`, trưởng tổ Trần Thị Bích, 5 thành viên gắn `DA-PMDT105`, `DA-PMDT120`, `DA-PMTB164`, `DA-PMTB172`) và `TCT-2026-02` "Tổ công tác xử lý vướng mắc dự án Nâng công suất hệ thống nước làm mát" (`179/QĐ-HĐTV`, `DA-PMDT105`) ‹chưa xác minh› |

**Nối**: ← hồi 0 (đơn vị `DPM-KHDT-QLDA`, khu `PM-KHO-CANG`). → hồi 2: dự án ở "Ngân hàng dự án" chỉ ra được khỏi giai đoạn này khi có dòng vốn trong một kế hoạch đã công bố; mã cấp trên `7893001` là điều kiện để bố trí vốn.

**Kiểm soát đang minh họa**: cổng giai đoạn (trạng thái dự án chỉ đổi qua lệnh có kiểm tra; đi sai cổng báo `STAGE_TRANSITION_DENIED`); thẩm định ba người khác nhau (người đề xuất, người chấm điểm, người quyết định); chấm điểm mù; mọi bước đòi số văn bản.

**Làm sống được (một lần, tùy chọn)**: owner chấm điểm `DA-PMDT902` ở PRJ-15 rồi `capApprover` quyết định ở PRJ-10 (cần số văn bản/thông báo ở dạng UUID). Chỉ nên làm ở bản 60 phút và khi đã tìm sẵn UUID ở DOC-12.

> **Lời dẫn**: "Đây là toàn bộ danh mục đầu tư của công ty, 18 dự án, mỗi dự án đứng đúng một giai đoạn. Nhìn dự án DA-PMDT105: nó đi qua tờ trình, chấm điểm, quyết định của ba người khác nhau, được gán mã dự án cấp trên rồi mới được bố trí vốn. Hệ thống không cho nhảy cóc giai đoạn."

---

### Hồi 2. Kế hoạch vốn (khoảng 4 phút)

**Dữ liệu lúc này**: hai nguồn vốn được giao năm 2026 (vốn chủ sở hữu 745 tỷ theo `91/QĐ-HĐTV`, vốn vay 813 tỷ theo `92/QĐ-HĐTV`, mỗi nguồn dư 12 tỷ so với kế hoạch để làm dự phòng); `KHV-2026` bản 1 rồi bản 2: 20 dòng (10 dự án có vốn x 2 nguồn) = 1.534 tỷ (vốn chủ sở hữu 733, vốn vay 801); `KHV-2025` bản năm trước = 1.304 tỷ; `KHV-2024`; kế hoạch trung hạn `KHV-TH-2027-2030` (52 dòng, 2.958 tỷ trên trần 3.980 tỷ) ‹chưa xác minh›; kiểm soát hạn mức, giữ vốn, điều chuyển, mô phỏng, sổ cái.

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 2.1 | CAP-16 Sổ dự toán và nguồn được giao (thanh bên: Kế hoạch vốn, "Tất cả chức năng") | `/cap/cap-16?devUser=owner` | `projectManager` ghi nguồn, `capApprover` duyệt | Nguồn `VCSH` (quỹ `NSDP-DTPT`, 745 tỷ, `91/QĐ-HĐTV` ngày 20/12/2025) và `VAY` (`ODA-ONLEND`, 813 tỷ, `92/QĐ-HĐTV` ngày 22/12/2025). Kế hoạch bị chặn không vượt số nguồn được giao. Nói "vốn chủ sở hữu" và "vốn vay", đừng đọc tên quỹ |
| 2.2 | CAP-01 Kế hoạch trung hạn (bấm "Kế hoạch vốn" trên thanh bên) | `/cap/cap-01?devUser=owner` | `owner` | `KHV-TH-2027-2030` bản 1 công bố theo `133/QĐ-HĐTV`: 52 dòng (10 dự án x 2 nguồn x 4 năm), đề xuất 2.958 tỷ dưới trần 3.980 tỷ; nguồn mới giao cho 2027 đến 2030 (vốn chủ sở hữu 760/560/380/210 tỷ theo `131/QĐ-HĐTV`, vốn vay 790/640/410/230 tỷ theo `132/QĐ-HĐTV`). Bản 2 là NHÁP dãn tiến độ `DA-PMDT120` từ 2028 sang 2029 ‹chưa xác minh› |
| 2.3 | CAP-03 Kế hoạch năm (thanh bên: Kế hoạch vốn, Kế hoạch năm) | `/cap/cap-03?devUser=owner` | `owner` hoặc `capApprover` (cùng thấy đủ 20 dòng) | Màn mở sẵn ở `KHV-2024`. Trong ô "Kế hoạch" có 4 mục: `KHV-2024`, `KHV-2025`, và HAI dòng `KHV-2026`; CHỌN dòng "KHV-2026 · 2026 · Đã công bố" (bản đang hiệu lực = bản 2; dòng còn lại "Kế hoạch đã bị thay thế" là bản 1): 20 dòng, tổng 1.534.000 triệu (con số 1.534 tỷ đã thấy trên HOME-07; tổng trên CAP-03 chưa chọn lại để đọc). Ví dụ `DA-PMDT105`: vốn chủ sở hữu 160 + vốn vay 159 = 319 tỷ; `DA-PMDT114`: 110 + 62 = 172 tỷ. Ô Kế hoạch còn có `KHV-2025` (1.304 tỷ) và `KHV-2024` |
| 2.4 | CAP-07 Điều chỉnh và điều chuyển (thanh bên: Kế hoạch vốn, Điều chỉnh vốn) | `/cap/cap-07?devUser=owner` | `owner` | Màn mở sẵn ở kế hoạch MỚI NHẤT (kế hoạch trung hạn); phải chọn `KHV-2026` trong ô "Kế hoạch" (hoặc `?plan=<mã>`). Bản 2 so với bản 1: chuyển 10 tỷ từ `DA-PMDT105` sang `DA-PMDT114` trên MỖI nguồn (tổng không đổi, chênh lệch 0), văn bản `58/QD-DPM` ngày 08/11/2026 |
| 2.5 | CAP-10 Phê duyệt kế hoạch | `/cap/cap-10?plan=<mã>&devUser=capApprover` | `projectManager` gửi, `capApprover` phê duyệt và công bố | Chuỗi gửi duyệt, phê duyệt, công bố. Công bố bản 1 dựa vào `95/QĐ-HĐTV` (ngày 12/01/2026). Bốn mắt: người tạo, người gửi, người duyệt, người công bố không trùng nhau |
| 2.6 | CAP-12 Kế hoạch ước giải ngân (thanh bên: Kế hoạch vốn, "Tất cả chức năng") | `/cap/cap-12?devUser=owner` | `owner` | Chọn ô "Dự án" `DA-PMDT105`: ước giải ngân tháng 10, 11, 12 = 33,9 / 50,85 / 84,75 tỷ; đăng ký tháng 11, 12 = 47,46 / 74,58 tỷ ‹chưa xác minh›. 8 dự án có ước và đăng ký |
| 2.7 | CAP-17 Kiểm soát hạn mức khả dụng (AVC) | `/cap/cap-17?devUser=owner` | `owner` | Hai chính sách đã công bố: `AVC-DPM-01` (toàn Tổng công ty, cảnh báo 85%, chặn 100%) và `AVC-DPM-02` (vốn vay, cảnh báo 80%, chặn 95%). Hai dòng vốn chủ sở hữu của `DA-PMDT105` đang ở mức 95,05% (mức cảnh báo) ‹chưa xác minh› |
| 2.8 | CAP-18 Giữ vốn trước cam kết | `/cap/cap-18?devUser=owner` | `owner` | 8 khoản giữ vốn, ví dụ gói `PMDT105-TB01` giữ 66,5 tỷ (vốn vay), `HD-PMDT105-XL01` tạm ứng 3 tỷ; 1 khoản đã hoàn lại (`PMDT130-TB01` 15 tỷ) ‹chưa xác minh› |
| 2.9 | CAP-19 Đề xuất điều chuyển vốn chậm sang nhanh; CAP-23 điều chuyển theo hiệu suất | `/cap/cap-19?devUser=capApprover`, `/cap/cap-23?devUser=capApprover` | `capApprover` | `DC-2026-01` (6 tỷ `DA-PMTB172` sang `DA-PMTB168`, đã duyệt, CHƯA áp dụng), `DC-2026-02` (12 tỷ `DA-PMDT137` sang `DA-PMDT120`, chờ duyệt), `DC-2026-03` (10 tỷ `DA-PMTB180` sang `DA-PMDT114`, bị từ chối kèm lý do), `DC-2026-04` nháp ‹chưa xác minh›. Các ô số trên đầu CAP-23 để trống theo thiết kế |
| 2.10 | CAP-20 Kéo dài thời gian giải ngân; CAP-09 Mô phỏng | `/cap/cap-20?devUser=capApprover`, `/cap/cap-09?devUser=owner` | `capApprover` | CAP-20: `DA-PMDT114` vốn vay 10 tỷ kéo dài tới 30/06/2027 (vướng mắc pháp lý PCCC, chờ duyệt); `DA-PMDT130` 15 tỷ tới 31/03/2027 (chờ duyệt); `DA-PMTB180` 12 tỷ (bị từ chối). CAP-09: 3 kịch bản `KB-2026-01..03` ‹chưa xác minh› |
| 2.11 | CAP-11 Khóa năm; CAP-21 Sổ cái vốn | `/cap/cap-11?devUser=owner`, `/cap/cap-21?devUser=owner` | `owner` | CAP-11: năm 2024 KHÓA, 2025 ĐÓNG SƠ BỘ. CAP-21: khoảng 160 bút toán (ALLOCATE, APPROPRIATE, RESERVE, LAPSE, và COMMIT, UNCOMMIT, DISBURSE sinh ra từ hợp đồng và thanh toán của hồi 4 và 6) ‹chưa xác minh› |

**Nối**: ← hồi 1 (mã dự án và mã cấp trên). → hồi 3 và 4: mỗi dòng vốn là một `allocation_line` được gắn vào gói thầu; hợp đồng ACTIVE sinh bút toán `COMMIT` trên chính dòng đó (sẽ thấy ở CAP-21 và CAP-22). Kế hoạch năm là MẪU SỐ của tỷ lệ giải ngân ở hồi 8 và 9. Sự kiện "công bố kế hoạch vốn" tự chuyển 4 dự án sang "Đã bố trí vốn" (PRJ-14 hồi 1).

**Kiểm soát đang minh họa**: nguồn được giao là trần cứng; công bố cần văn bản và bốn mắt; điều chỉnh sinh bản MỚI chứ không sửa bản cũ (bản 1 thành "đã thay thế"); không điều chỉnh xuống dưới số đã cam kết; chính sách AVC chặn khi vượt ngưỡng.

**Không có/không áp dụng**: không đề xuất điều chuyển nào đã áp dụng, không đề nghị kéo dài nào được duyệt, nên `KHV-2026` vẫn 1.534 tỷ. CAP-14 trống theo thiết kế. CAP-22 chỉ có số khi mở từ một hợp đồng hoặc dự án (`/cap/cap-22?contract=<mã>`), mở thẳng từ menu chỉ hiện hướng dẫn.

> **Lời dẫn**: "Vốn của công ty đến từ hai nguồn: vốn chủ sở hữu và vốn vay. Hội đồng thành viên giao nguồn bằng quyết định, rồi kế hoạch năm 1.534 tỷ chia cho 10 dự án và hai nguồn. Khi cần dồn 10 tỷ từ dự án này sang dự án khác, hệ thống lập bản 2 chứ không xóa bản 1, và tổng vẫn khớp."

---

### Hồi 3. Lựa chọn nhà thầu (khoảng 3 phút)

**Dữ liệu lúc này**: 16 nhà thầu (13 đã xác minh, 2 chưa xác minh, 1 bị từ chối); 10 kế hoạch lựa chọn nhà thầu đã phê duyệt; 34 gói thầu; 44 hồ sơ dự thầu. Bốn dự án đấu thầu đầy đủ (`DA-PMDT105`, `DA-PMDT114`, `DA-PMTB164`, `DA-PMTB168`: 16 gói); sáu dự án còn lại đứng ở những bước khác nhau của quy trình (18 gói).

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 3.1 | BID-01 Danh sách nhà thầu (thanh bên: Nhà thầu) | `/bid/bid-01?devUser=owner` | `owner` xác minh (khác người đăng ký) | 16 nhà thầu đăng ký theo mã số thuế: ví dụ Công ty Cổ phần Xây dựng Công nghiệp Nam Việt, Cổ phần Cơ khí và Xây lắp Dầu khí Minh Phát, Cổ phần Tư vấn Thiết kế và Giám sát Công nghiệp Bảo An, Cổ phần Máy nén và Thiết bị Áp lực Tân Phát; 1 nhà thầu bị từ chối (Quang Vinh). VND-01 (ô "Quản lý nhà thầu") là sổ chi tiết cùng dữ liệu |
| 3.2 | BID-15 Kế hoạch lựa chọn nhà thầu (thanh bên: Nhà thầu, Kế hoạch lựa chọn) | `/bid/bid-15?devUser=capApprover` | `projectManager` lập và trình, `capApprover` phê duyệt | 10 kế hoạch "Đã phê duyệt". Chọn `DA-PMDT105`: 5 gói `PMDT105-XL01` (71,4 tỷ, đấu thầu rộng rãi), `-XL02` (51,0 tỷ), `-TV01` (tư vấn giám sát 10,14 tỷ), `-TB01` (thiết bị chính 67,6 tỷ), `-KS01` (khảo sát 6,76 tỷ). Mỗi kế hoạch kèm số quyết định `NN/QĐ-HĐTV` |
| 3.3 | BID-03 Gói thầu và đề án | `/bid/bid-03?devUser=projectManager` | `projectManager` | 34 gói với trạng thái khác nhau: Đã trúng thầu (AWARDED), Chờ duyệt kết quả (RESULT_PENDING), Đang đánh giá (EVALUATING), Hồ sơ niêm phong (SEALED). `PMDT105-XL01`: trúng 70,329 tỷ, nhà thầu Nam Việt |
| 3.4 | BID-05 Tiếp nhận hồ sơ dự thầu; BID-04 Tiêu chí đánh giá | `/bid/bid-05?devUser=projectManager`, `/bid/bid-04?devUser=capApprover` | `projectManager`; `capApprover` duyệt tiêu chí | `PMDT105-XL01` có 4 hồ sơ dự thầu (Nam Việt, Minh Phát, Việt Hưng, Hồng Phúc); giá thắng bằng giá trúng, các giá sau cao hơn. Hồ sơ NIÊM PHONG đến khi mở thầu; tiêu chí tổng trọng số 100, đã duyệt và khóa |
| 3.5 | BID-17 Theo dõi mời thầu và mốc | `/bid/bid-17?devUser=projectManager` | `projectManager` | Mốc mời thầu, đóng thầu, mở thầu (mở thầu cách ngày trúng 12 ngày, mời thầu cách 38 ngày) |
| 3.6 | BID-27 / BID-28 / BID-29 Cây tiến độ quy trình (Tất cả chức năng của Nhà thầu) | `/bid/bid-27?devUser=owner`, `/bid/bid-29?devUser=owner` | `owner` xem; `projectManager` chuyển bước | 6 dự án (`DA-PMDT120`, `130`, `137`, `DA-PMTB172`, `180`, `191`) mỗi dự án 3 gói đứng ở bước khác nhau: đóng thầu, đánh giá, trả lại ở bước duyệt hồ sơ (`PMDT137-XL01`), tạm giữ ở bước đánh giá (`PMTB172-TB01`, gắn với vướng mắc I11 hồi 7), đăng kết quả... ‹chưa xác minh› |
| 3.7 | BID-18 Phê duyệt kết quả lựa chọn | `/bid/bid-18?devUser=capApprover` | `projectManager` trình, `capApprover` hoặc `owner` quyết định (khác người trình) | Gói `PMDT105-TB01` (thiết bị chính, 66,586 tỷ, Hồng Phúc đề xuất) và `PMDT114-TB01` (20,488 tỷ) đang CHỜ duyệt kết quả. Có thể duyệt sống, xem "Làm sống được" bên dưới |

**Làm sống được (một lần)**: `capApprover` bấm "Quyết định" ở BID-18 cho `PMDT105-TB01`; cần điền mã văn bản quyết định hiệu lực. Sau đó mở `/eqp/eqp-02?devUser=projectManager` (dòng `TB26-03`) thì giai đoạn dòng thiết bị tự đổi sang "Đã chọn nhà thầu": bằng chứng "một dữ liệu, nhiều màn". Thử trước 14:30 để biết mã văn bản cần dùng ‹chưa xác minh›; một khi đã duyệt thì không quay lại.

**Nối**: ← hồi 2 (gói lấy vốn từ dòng vốn: ngân sách gói là tỷ lệ của dòng lớn nhất). → hồi 4: mã gói `PMDT105-XL01` đi tiếp thành `HD-PMDT105-XL01`; nhà thầu trúng ở BID-18 là nhà thầu DUY NHẤT chọn được khi soạn hợp đồng.

**Kiểm soát đang minh họa**: người xác minh khác người đăng ký; hồ sơ niêm phong; kê khai xung đột lợi ích (mỗi gói đã mở thầu có tuyên bố "không xung đột" của hai người); giá trúng không vượt giá gói; người duyệt kết quả khác người trình.

> **Lời dẫn**: "Mỗi gói thầu lấy vốn từ một dòng của kế hoạch vừa rồi. Hồ sơ dự thầu được niêm phong cho đến khi mở thầu, người duyệt kết quả phải khác người trình. Gói thiết bị chính của DA-PMDT105 đang chờ lãnh đạo duyệt; duyệt xong, dòng mua sắm thiết bị tự đổi giai đoạn mà không ai phải nhập lại."

---

### Hồi 4. Hợp đồng và thiết bị (khoảng 3 phút)

**Dữ liệu lúc này**: 8 hợp đồng ACTIVE tổng 240,163 tỷ, ký ngày 16/09/2026 (D-55), hiệu lực 17/09/2026; 6 bảo lãnh thực hiện (mỗi bảo lãnh 5%, hợp đồng tư vấn không có); mỗi hợp đồng 1 dòng BOQ; 8 hợp đồng là hợp đồng liên danh (nhà thầu thắng và nhà thầu xếp thứ hai, tỷ lệ 70/30) ‹chưa xác minh›; 9 dòng thiết bị.

| Mã hợp đồng | Dự án | Nhà thầu | Giá trị (đồng) | Hạn hoàn thành |
|---|---|---|---|---|
| `HD-PMDT105-XL01` | `DA-PMDT105` | Nam Việt | 70.329.000.000 | 03/05/2028 |
| `HD-PMDT105-XL02` | `DA-PMDT105` | Minh Phát | 50.490.000.000 | 04/03/2028 |
| `HD-PMDT105-TV01` | `DA-PMDT105` | Bảo An | 9.937.000.000 | 02/06/2028 |
| `HD-PMDT114-XL01` | `DA-PMDT114` | Nam Việt | 41.370.000.000 | 03/05/2028 |
| `HD-PMDT114-XL02` | `DA-PMDT114` | Minh Phát | 29.700.000.000 | 04/03/2028 |
| `HD-PMDT114-TV01` | `DA-PMDT114` | Bảo An | 3.057.000.000 | 02/06/2028 |
| `HD-PMTB164-TB01` | `DA-PMTB164` | Tân Phát | 8.820.000.000 | 08/07/2027 |
| `HD-PMTB168-TB01` | `DA-PMTB168` | Tân Phát | 26.460.000.000 | 08/07/2027 |

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 4.1 | CTR-01 Danh mục hợp đồng (thanh bên: Hợp đồng) | `/ctr/ctr-01?devUser=projectManager` | `projectManager` | 8 hợp đồng ACTIVE như bảng trên. Bấm `HD-PMDT105-XL01` để vào không gian hợp đồng |
| 4.2 | CTR-03 Không gian thực hiện hợp đồng | `/ctr/ctr-03?contract=<từ danh sách>&devUser=owner` | `owner`: người ký và kích hoạt (khác người soạn) | Giá trị 70.329.000.000, Nam Việt, ký 16/09/2026, hiệu lực 17/09/2026; trạng thái các bước soạn, bảo lãnh, xem xét, ký, kích hoạt. Căn cứ ủy quyền ký `41/QĐ-HĐTV` |
| 4.3 | CTR-04 BOQ và mốc thanh toán (thanh bên: Hợp đồng) | `/ctr/ctr-04?devUser=projectManager` | `projectManager` | Một dòng `B01`: 1.000 M3 x 70.329.000 đồng = 70.329.000.000 (tổng BOQ phải đúng bằng giá trị hợp đồng) |
| 4.4 | CTR-05 Bảo lãnh và bảo hiểm | `/ctr/ctr-05?devUser=owner` | `owner` xác minh (người đăng ký không tự xác minh) | `BL-PMDT105-XL01`: 5% = 3.516.450.000 đồng, hiệu lực từ 13/09/2026 đến 15/12/2027, do "Ngân hàng thương mại cổ phần đối tác" phát hành |
| 4.5 | CTR-25 Thành viên liên danh | `/ctr/ctr-25?devUser=projectManager` | `projectManager` | Hợp đồng liên danh: nhà thầu dẫn đầu và nhà thầu thành viên với tỷ lệ 70/30 (là điều kiện để trả tiền cho đúng bên ở hồi 6) ‹chưa xác minh› |
| 4.6 | CTR-23 Bảng điểm nhà thầu (mở thẳng sẽ chọn nhà thầu đầu tiên, nên chọn Nam Việt trong danh sách) | `/ctr/ctr-23?devUser=owner` | `capApprover` phê duyệt đánh giá | Đánh giá 2026-Q3 của Nam Việt: chất lượng 88, tiến độ 72, an toàn môi trường 90, phối hợp 85, tài chính 80; ghi chú "Phê duyệt sau khi kiểm tra tại hiện trường" |
| 4.7 | EQP-01 Mua sắm trang thiết bị dự án (Tất cả ứng dụng, ô "Mua sắm trang thiết bị"), rồi EQP-02 | `/eqp/eqp-01?devUser=projectManager` | `projectManager` | Chọn dự án `DA-PMTB164`: dòng `TB26-01` "Máy nén khí ly tâm 2 cấp 3.000 m3/giờ, nhập từ Đức" gắn gói `PMTB164-TB01`, hợp đồng `HD-PMTB164-TB01`, giá trị kế hoạch 9.360 triệu (căn cứ `KH-TB-2026/01`), giai đoạn "Đã ký hợp đồng" đọc tự động từ BID và CTR. 9 dòng: 6 gắn gói, 2 mới theo kế hoạch chưa có gói, 1 đã hủy (`TB26-09`, máy phát điện dự phòng, gộp) |

**Nối**: ← hồi 3 (gói thầu và nhà thầu trúng). → hồi 5 và 6: hợp đồng là GỐC của khối lượng, nghiệm thu, đề nghị thanh toán, claim, thay đổi, vướng mắc, kiểm toán. Hợp đồng ACTIVE cam kết vốn (`COMMIT`) trên dòng vốn của gói (hồi 2, CAP-21).

**Kiểm soát đang minh họa**: chuỗi soạn (`projectManager`), xác minh bảo lãnh (`owner`), gửi xem xét (`capApprover`), ký và kích hoạt (`owner`): người soạn và người gửi xem xét không được ký hay kích hoạt; giá hợp đồng không vượt giá gói; tổng BOQ bằng giá trị hợp đồng; dự án phải ở giai đoạn thực hiện và có kế hoạch vốn đã duyệt mới kích hoạt được.

**Chỉ nói thận trọng**: tên thiết bị `TB26-02..06` gắn theo thứ tự mã gói nên không khớp tên dự án (ví dụ dự án "phòng thí nghiệm" nhưng dòng là hệ thống DCS); chỉ kể `TB26-01` (khớp "Mua sắm máy nén khí"). Hai hợp đồng `PMTB164/168-TB01` có ngày ký 16/09/2026, sớm hơn ngày trao thầu của `PMTB164-TB01` (D-48): đừng so ngày giữa hai màn.

> **Lời dẫn**: "Gói thầu trúng được soạn thành hợp đồng: giá, bản BOQ, bảo lãnh 5% do ngân hàng phát hành và được người thứ hai xác minh. Người ký là người khác người soạn. Từ đây, mã HD-PMDT105-XL01 là khóa mà khối lượng, nghiệm thu, thanh toán, thay đổi, vướng mắc và kiểm toán đều bám vào."

---

### Hồi 5. Thực hiện: nhật ký, khối lượng, kiểm tra, nghiệm thu (khoảng 4 phút)

**Dữ liệu lúc này**: khối lượng đo và nghiệm thu cho 3 tháng (9, 10, 11) trên 8 hợp đồng; nhật ký công trường; 8 đề nghị kiểm tra; 2 biên bản nghiệm thu chất lượng; 6 mẫu thí nghiệm vật liệu; 4 phiếu không phù hợp ‹chưa xác minh›. Phần lớn có mốc thời gian lùi về quá khứ để "lớn dần": tạm ứng ngày 25/09, khối lượng tháng 9 ngày 05/10, tháng 10 và 11 hôm nay.

Giá trị nghiệm thu (tỷ đồng) của 8 hợp đồng ‹chưa xác minh›: tháng 9 tổng 6,417 (5 hợp đồng); tháng 10 tổng 23,552 (8 hợp đồng); tháng 11 tổng 12,327 (7 hợp đồng, đang chờ duyệt). Riêng `HD-PMDT105-XL01`: khối lượng 40 / 85 / 60 M3, nghiệm thu 2,813 / 5,978 / 4,220 tỷ. Tháng 9 cộng tháng 10 của XL01 là 8,791 tỷ, tương đương 12,5% hợp đồng.

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 5.1 | QMS-01 Danh mục nhật ký thi công (Tất cả ứng dụng, ô "Chất lượng & nhật ký thi công") | `/qms/qms-01?devUser=projectManager` | `projectManager` lập hộ nhà thầu | Nhật ký của `HD-PMDT105-XL01` (lắp bơm tuần hoàn, hàn ống DN600, bể thu hồi) khoảng 10 đến 11 ngày làm việc; `HD-PMDT114-XL01` (móng và khung thép kho chứa) cách ngày. Các nhật ký ở trạng thái NHÁP (chữ ký nhà thầu cần tài khoản khách của nhà thầu, không có trong demo) ‹chưa xác minh› |
| 5.2 | CTR-09 Nhật ký công trường (thanh bên: Hợp đồng, Nhật ký công trường) | `/ctr/ctr-09?id=<từ QMS-01>&devUser=projectManager` | `projectManager` | Cùng nhật ký, nhìn từ phía hợp đồng. Ba chữ ký trên cùng một mã băm (nhà thầu, giám sát, chủ đầu tư) |
| 5.3 | CTR-10 Ghi nhận khối lượng | `/ctr/ctr-10?contract=<từ CTR-01>&devUser=projectManager` | `projectManager` đo, `capApprover` duyệt đo | `HD-PMDT105-XL01`: khối lượng 40 (T9), 85 (T10), 60 (T11) M3; hồ sơ `KL-PMDT105-XL01-T09`, `-T10`, `-T11`; không vượt BOQ, không giảm lũy kế ‹chưa xác minh› |
| 5.4 | CTR-12 Nghiệm thu khối lượng (thanh bên: Hợp đồng, Nghiệm thu) | `/ctr/ctr-12?contract=<từ CTR-01>&devUser=owner` | `capApprover` lập và gửi, `owner` quyết định | Nghiệm thu T9 (2,813 tỷ) và T10 (5,978 tỷ) đã duyệt; T11 (4,220 tỷ) đang "Đã gửi" chờ người thứ hai quyết định ‹chưa xác minh›. Mã `NT-001..`, biên bản `BBNT-...`, kỳ báo cáo `M2026-09/10/11` |
| 5.5 | QMS-04 Đề nghị kiểm tra, nghiệm thu | `/qms/qms-04?contract=<từ CTR-01>&devUser=projectManager` | `projectManager` | 8 đề nghị: 2 đạt (cốt thép bệ móng bơm P-101B; cốt thép móng M2 kho chứa), 1 không đạt (ống thép DN600 lô 05 thiếu số lô nấu), 1 có điều kiện (an toàn hàn cắt làm việc nóng cạnh ống hiện hữu), 2 đã lên lịch, 1 mới, 1 đã hủy ‹chưa xác minh› |
| 5.6 | QMS-05 Biên bản nghiệm thu chất lượng | `/qms/qms-05?devUser=capApprover` | `capApprover` lập, `owner` ký và quyết định | 2 biên bản: một biên bản đang ký (giám sát và chủ đầu tư đã ký), một bản nháp ‹chưa xác minh› |
| 5.7 | QMS-06 Thí nghiệm vật liệu | `/qms/qms-06?devUser=projectManager` | `projectManager` | Bê tông khoan lõi đạt 31,0 MPa; thép CB400-V D25 và xi măng PC40 lô 15 đạt; cát vàng lô 04 và đá dăm 1x2 lô 11 đang chờ kết quả ‹chưa xác minh› |
| 5.8 | QMS-07 Không phù hợp và hành động khắc phục | `/qms/qms-07?contract=<từ CTR-01>&devUser=projectManager` | `projectManager` giao, `owner` xác nhận | 4 phiếu: bê tông móng M2 (đã đóng), lớp bảo vệ cốt thép bệ bơm P-101B (đã nộp bằng chứng khắc phục), đá dăm lô 11 (đã giao hành động), thiếu rào chắn khu hàn cắt (nghiêm trọng, mới) ‹chưa xác minh›. KIỂM TRƯỚC giờ demo: không có phiếu tiêu đề tiếng Anh "Material test failed..." |
| 5.9 | QMS-11 Độ phủ nhật ký và cảnh báo thiếu nhật ký | `/qms/qms-11?contract=<từ CTR-01>&devUser=projectManager` | `projectManager` | Tỷ lệ ngày có nhật ký của hợp đồng (XL01 gần như liên tục, kho chứa cách ngày) |

**Nối**: ← hồi 4 (hợp đồng). → hồi 6: giá trị nghiệm thu đã duyệt là đầu vào của bảng xác định giá trị thanh toán (CTR-13) và đề nghị thanh toán. → hồi 7: kết quả kiểm tra "không đạt" và phiếu không phù hợp sinh vướng mắc (bê tông móng M2 ở QMS-07 chính là vướng mắc I04 ở ISS).

**Kiểm soát đang minh họa**: nghiệm thu do người lập khác người quyết định; hệ thống chặn nghiệm thu khi còn phiếu không phù hợp nghiêm trọng mở, thiếu biên bản chất lượng hoặc vượt giá trị hợp đồng; khối lượng không giảm lũy kế; ba chữ ký trên một mã băm. Lưu ý: nếu bấm duyệt nghiệm thu T11 của `HD-PMDT105-XL01` mà bị chặn vì phiếu "thiếu rào chắn khu hàn cắt" còn mở, đó chính là kiểm soát đang hoạt động (kiểm trước, ‹chưa xác minh›).

**Không làm được trên máy chiếu**: QMS-09 (nhật ký ngoại tuyến) và QMS-10 (chụp ảnh hiện trường kiểm vị trí) chỉ có trên ứng dụng điện thoại, không có địa chỉ web.

> **Lời dẫn**: "Từ hợp đồng, khối lượng được đo hằng tháng rồi nghiệm thu. Người đo khác người duyệt đo, người lập nghiệm thu khác người quyết định nghiệm thu. Khi có thí nghiệm hay phiếu không phù hợp nghiêm trọng, hệ thống chặn nghiệm thu cho đến khi xử lý xong."

### Hồi 6. Thanh toán: tạm ứng, đề nghị thanh toán, ngân hàng xác nhận (khoảng 3 phút)

**Dữ liệu lúc này** (mốc thời gian lùi về quá khứ để dữ liệu "lớn dần", tất cả ‹chưa xác minh›):

| Mốc | Ngày | Việc đã xảy ra |
|---|---|---|
| A | 25/09/2026 (D-46) | Bảo lãnh tạm ứng `BLTU-<mã gói>` (ngân hàng phát hành, `owner` xác minh); khoản tạm ứng; đề nghị thanh toán tạm ứng `DNTT-<mã gói>-TU`; gửi ngân hàng; ngân hàng xác nhận; ghép giao dịch: khoản tạm ứng "Đã thanh toán", bắt đầu thu hồi |
| B | 05/10/2026 (D-36) | Khối lượng tháng 9: đo, duyệt đo, nghiệm thu, đề nghị thanh toán `DNTT-<mã gói>-09`, kiểm soát và gửi (kế toán), ngân hàng xác nhận: "Đã thanh toán" |
| C | Hôm nay | Tháng 10: nghiệm thu và đề nghị `DNTT-<mã gói>-10` đã gửi ngân hàng, CHỜ xác nhận. Tháng 11: đã đo, biên bản nghiệm thu "Đã gửi" chờ người thứ hai |

Tạm ứng chỉ áp dụng cho hợp đồng xây lắp và tư vấn (XL01, XL02, TV01 của hai dự án `DA-PMDT105`, `DA-PMDT114`; trần tạm ứng xây lắp từ 10 tỷ là 20%, tư vấn 30%, ngưỡng thu hồi 80%). Hợp đồng thiết bị (`TB01`) không có tạm ứng. Khoản tạm ứng (đã thấy trên PAY-01): `DNTT-PMDT114-TV01-TU` 427.000.000; `DNTT-PMDT114-XL02-TU` 3.118.000.000; các khoản còn lại (XL01-105 khoảng 7,384 tỷ; XL02-105 5,301; TV01-105 1,391; XL01-114 4,343) ‹chưa xác minh›.

**Công thức**: số được thanh toán = giá trị nghiệm thu − thu hồi tạm ứng − giữ lại 5%.
Ví dụ đã thấy trên PAY-01: `DNTT-PMDT105-XL01-09`: giá trị khối lượng 2.813.160.000, số được thanh toán 2.145.073.429, trạng thái "Đã thanh toán". `DNTT-PMDT105-XL01-10`: giá trị khối lượng 5.977.965.000, số được thanh toán 4.558.281.036, trạng thái "Đã gửi Kho bạc" (chờ xác nhận). PAY-01 hiện 19 hồ sơ: 8 đợt tháng 10 (`-10`, đã gửi), 5 đợt tháng 9 (`-09`, đã thanh toán) và 6 tạm ứng (`-TU`, đã thanh toán). PAY-07 hiện 6 khoản tạm ứng.

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 6.1 | CTR-13 Bảng xác định giá trị thanh toán | `/ctr/ctr-13?devUser=owner` | `owner` xem | Giá trị nghiệm thu của hợp đồng quy ra số được thanh toán. Đây là chỗ "nghiệm thu chảy sang thanh toán" |
| 6.2 | CTR-06 Tạm ứng và lịch thu hồi (Tất cả chức năng của Hợp đồng) | `/ctr/ctr-06?devUser=owner` | `owner` | Khoản tạm ứng và bảng "Lịch thu hồi" theo tỷ lệ số đã đề nghị thanh toán |
| 6.3 | PAY-01 Danh sách hồ sơ thanh toán (thanh bên: Thanh toán) | `/pay/pay-01?devUser=owner` | `owner` xem; `projectManager` lập, `treasuryMaker` kiểm soát và gửi | 19 hồ sơ: `DNTT-...-TU` và `-09` (Đã thanh toán), `-10` (hiện nhãn "Đã gửi Kho bạc", thực chất gửi ngân hàng, chờ xác nhận) |
| 6.4 | PAY-07 Tạm ứng và thu hồi (thanh bên: Thanh toán) | `/pay/pay-07?devUser=owner` | `owner` | Từng khoản tạm ứng: đã tạm ứng, đã thu hồi, còn lại |
| 6.5 | CTR-21 Giữ lại theo dòng BOQ | `/ctr/ctr-21?devUser=owner` | `owner` | Các khoản giữ lại 5% ở trạng thái "Đang giữ", điều kiện giải tỏa "Hoàn thành hợp đồng" |
| 6.6 | CAP-22 Kiểm soát vốn theo hợp đồng (CHỈ mở từ hợp đồng) | `/cap/cap-22?contract=<từ CTR-01>&devUser=owner` | `owner` | Vốn đã cam kết và đã giải ngân của hợp đồng so với dòng vốn; CAP-21 có các bút toán COMMIT, UNCOMMIT, DISBURSE sinh ra tự động từ các đề nghị thanh toán |

**Nối**: ← hồi 5 (giá trị nghiệm thu). → hồi 8 và 10: tiền đã giải ngân theo hợp đồng nuôi sổ cái vốn. Trên màn thanh toán chạy bốn biểu mẫu demo (03.a, 04.a, 04.b, 05.a/TT).

**Kiểm soát đang minh họa**: người lập đề nghị khác người kiểm soát/gửi khác ngân hàng xác nhận; chỉ trả tiền cho thành viên của hợp đồng (vì vậy 8 hợp đồng là liên danh); khoản tạm ứng thu hồi tự động theo công thức; giữ lại 5% đến khi hoàn thành; sổ cái vốn tự ghi theo mọi bước.

**Cẩn thận**: (1) nhãn "Kho bạc" trên màn PAY ("Đã gửi Kho bạc", "Theo dõi Kho bạc", tên 4 biểu mẫu có đuôi `/TT`) là nhãn cố định của sản phẩm; chứng từ ngân hàng ghi "Ngân hàng thương mại đối tác". Nói: "tên màn kế thừa, bản doanh nghiệp sẽ đổi sang ngân hàng". (2) PAY-05 "Giao dịch chờ ghép" hiện các dòng sao kê `KB-...` (32 dòng, 543,33 tỷ) là chuỗi số riêng, KHÔNG liên quan các đề nghị trên: tránh mở PAY-05 trước khách, hoặc nói rõ đó là sao kê mẫu. (3) Hợp đồng thiết bị không có tạm ứng và CTR-14 chỉ có "điều chỉnh hồi tố" (không có phạt chậm tiến độ).

> **Lời dẫn**: "Nghiệm thu được bao nhiêu thì thanh toán bấy nhiêu, trừ đi phần tạm ứng phải thu hồi và 5% giữ lại bảo hành. Người lập hồ sơ, người kiểm soát và ngân hàng là các bên khác nhau; kế hoạch vốn tự ghi số đã cam kết và đã giải ngân theo từng bước."

---

### Hồi 7. Vướng mắc, thay đổi hợp đồng, claim và giấy phép (khoảng 5 phút)

**Dữ liệu lúc này** (‹chưa xác minh›): 11 vướng mắc `VM-2026-0000nn` thuộc 6 loại (tiến độ và cung ứng thiết bị; mặt bằng và giấy phép; chất lượng; an toàn, phòng cháy và môi trường; hợp đồng, thanh toán và đấu thầu; thay đổi thiết kế), 24 chính sách SLA; chuỗi thay đổi hợp đồng `CE`, `PCO`, `CO` trên 4 hợp đồng; 2 claim; hồ sơ giấy phép của 4 dự án; đồng hồ được lùi về ngày ghi nhận nên cột "hạn xử lý/quá hạn" phản ánh đúng tuổi của vướng mắc.

**11 vướng mắc, và cái nối với hồi trước** (mã `VM-2026-0000nn` theo thứ tự tạo, có thể khác):

| Khóa | Dự án / hợp đồng | Nội dung (rút gọn) | Mức | Trạng thái | Nối sang |
|---|---|---|---|---|---|
| I01 | `DA-PMDT105` / `HD-PMDT105-XL01` | Bơm tuần hoàn và quạt tháp giải nhiệt nhập khẩu giao chậm 11 ngày | Cao | Đang xử lý, đã gia hạn 1 lần, đã leo thang cấp 2 lên Ban KHĐT và được tiếp nhận | Claim gia hạn 11 ngày của Nam Việt (CTR-32/33) |
| I02 | `DA-PMDT105` / `HD-PMDT105-XL02` | Chưa bàn giao mặt bằng khu tháp giải nhiệt số 2 (vướng ống nước chữa cháy hiện hữu) | Cao | QUÁ HẠN, hệ thống tự leo thang cấp 2 | Hợp đồng XL02 |
| I03 | `DA-PMDT114` | Hồ sơ thẩm duyệt PCCC kho chứa bị yêu cầu bổ sung | Trung bình | Đã giao, chưa bắt đầu | Giấy phép PCCC "yêu cầu bổ sung" (PMT-01); kéo dài giải ngân `DA-PMDT114` (CAP-20) |
| I04 | `DA-PMDT114` / `HD-PMDT114-XL01` | Cường độ bê tông móng M2 kho chứa 27,4 MPa so với 30 MPa thiết kế (khoan lõi 31,0 MPa) | Cao | CHỜ XÁC NHẬN hoàn tất (ISS-07) | Phiếu không phù hợp QMS-07, thí nghiệm QMS-06 |
| I05 | `DA-PMTB164` / `HD-PMTB164-TB01` | Máy nén khí nhập từ Đức bị giữ tại cảng Cái Mép do thiếu C/O | Cao | Leo thang cấp 2, chờ tiếp nhận | Dòng `TB26-01`, claim phạt chậm giao |
| I06 | `DA-PMTB168` / `HD-PMTB168-TB01` | Bất đồng giá trị thanh toán đợt 1 hệ thống DCS: nhà thầu 30% (7,938 tỷ), chủ đầu tư 20% (5,292 tỷ) | Trung bình | Đang xử lý | Hợp đồng 26,46 tỷ |
| I07 | `DA-PMDT120` | Thay đổi thiết kế: bổ sung bộ lọc túi thứ hai theo quy chuẩn khí thải mới | Trung bình | Đã đóng, người thứ hai xác nhận | – |
| I08 | `DA-PMDT130` | Giấy phép môi trường khu đóng bao mở rộng chưa được cấp | Cao | Mới ghi nhận, chưa giao | GPMT "đang thẩm định" (PMT-01) |
| I09 | `DA-PMDT105` / `HD-PMDT105-XL01` | Rò rỉ hóa chất xử lý nước làm mát tại khu bồn chứa (có vị trí GPS Phú Mỹ) | Nghiêm trọng | Đã leo thang cấp 1 | An toàn, môi trường |
| I10 | `DA-PMDT114` | Tư vấn giám sát chậm nộp báo cáo tuần 43 | Thấp | Đã đóng | – |
| I11 | `DA-PMTB172` | Nhà thầu kiến nghị về đánh giá hồ sơ dự thầu gói `PMTB172-TB01` | Trung bình | Đang xử lý | Gói đang tạm giữ ở BID-29 (`HOLD:EVALUATE`) |

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 7.1 | ISS-01 Danh sách vướng mắc (Tất cả ứng dụng, ô "Vướng mắc & hiện trường") | `/iss/iss-01?devUser=projectManager` | `projectManager` ghi nhận và xử lý | 11 vướng mắc; thẻ trên cùng: ĐANG MỞ 9, QUÁ HẠN 1, ĐÃ LEO THANG 4; I02 quá hạn. Bấm vào dòng để mở |
| 7.2 | ISS-03 Không gian xử lý (bấm từ ISS-01; đừng gõ tay `?id=`) | `/iss/iss-03?id=<từ ISS-01>&devUser=projectManager` | `projectManager` xử lý, `capApprover` giao việc | Mở I04 (bê tông móng M2): dòng thời gian chỉ thêm, hạn theo lịch làm việc. Dòng lịch sử mang ngày hôm nay (do hệ thống ghi giờ thật) |
| 7.3 | ISS-04 Chuyển cấp và gia hạn; ISS-10 Leo thang và tổ công tác | `/iss/iss-04?id=<từ ISS-01>&devUser=owner`, `/iss/iss-10?devUser=capApprover` | `owner` gia hạn (người xử lý không tự gia hạn); `capApprover` hoặc `owner` tiếp nhận leo thang | I01: gia hạn 1 lần (tối đa 2), leo thang cấp 2 và đã tiếp nhận; I02 tự leo thang vì quá hạn; I05, I09 đang leo thang |
| 7.4 | ISS-07 Xác nhận hoàn tất (bấm từ ISS-01 hoặc "Việc của tôi") | `/iss/iss-07?id=<I04>&devUser=owner` | `owner`: người đóng độc lập với người xử lý | I04 chờ "Xác nhận và đóng" hoặc "Giao lại". Làm sống được một lần |
| 7.5 | ISS-06 Tiến độ xử lý theo tuần; ISS-08 Ma trận theo tuần | `/iss/iss-06?devUser=capApprover`, `/iss/iss-08?devUser=capApprover` | `capApprover` | Chỉ có tuần hiện hành `2026-W46` (09 đến 15/11/2026): theo số liệu chạy thử phát sinh 11, đã đóng 2 ‹chưa xác minh›. Tuần trước trống (đừng chọn) |
| 7.6 | ISS-09 Chính sách SLA | `/iss/iss-09?devUser=owner` | `owner` | Giờ làm việc trả lời/xử lý: Nghiêm trọng 2/40, Cao 4/160, Trung bình 8/240, Thấp 16/400; riêng An toàn, môi trường mức Nghiêm trọng 1/24 |
| 7.7 | ISS-05 Kiểm tra hiện trường | `/iss/iss-05?devUser=projectManager` | `projectManager` | Chọn đợt kiểm tra đã lên lịch (KT-002 "an toàn thi công trên cao khung thép kho" hoặc "Nghiệm thu giai đoạn lắp đặt cụm bơm số 1"): mỗi hạng mục không đạt tạo một vướng mắc |
| 7.8 | CTR-20 Cấu hình số tầng thay đổi; CTR-07 Yêu cầu thay đổi; CTR-19 Chuỗi thay đổi | `/ctr/ctr-19?devUser=projectManager` | `projectManager` lập và nâng tầng, `owner` thẩm định | Số tầng 3 của `DA-PMDT105`, `DA-PMDT114`, `DA-PMTB164`. Hợp đồng `HD-PMDT105-XL01`: (a) sự kiện thiết kế thay đổi, rút ngắn ống tuần hoàn 80 m (−420.000.000) thành PCO rồi CO bậc 1; (b) sự kiện điều kiện hiện trường, cáp ngầm ngoài khảo sát (+1.850.000.000, +12 ngày) thành CO bậc 2. Sự kiện `CE-001` của `HD-PMDT105-XL02` chờ báo giá (+620.000.000); `PCO-001` của `HD-PMDT114-XL01` đã thẩm định chờ lệnh (+430.000.000) ‹chưa xác minh› |
| 7.9 | CTR-08 So sánh và duyệt phụ lục (mở từ CTR-19) | `/ctr/ctr-08?devUser=capApprover` | `capApprover` duyệt (khác người lập, nâng tầng, thẩm định) | CO được duyệt: "Duyệt phụ lục", "Trả lại", "Từ chối" |
| 7.10 | CTR-26 Phiên bản hợp đồng; CTR-27 Bậc thay đổi | `/ctr/ctr-26?devUser=owner`, `/ctr/ctr-27?devUser=owner` | `owner` | Hợp đồng `HD-PMDT105-XL01`: phiên bản 1 = 70.329.000.000 (hiện hành); phiên bản 2 = 69.909.000.000 hiệu lực 13/11/2026 (CO −420 triệu); phiên bản 3 = 71.759.000.000 hiệu lực 20/11/2026 (CO +1,85 tỷ, biến động cộng dồn 2,03%) ‹chưa xác minh›. Chỉ CO được duyệt mới sinh phiên bản mới |
| 7.11 | PRJ-22 Sổ dự phòng và dự trữ quản lý | `/prj/prj-22?devUser=owner` | `owner` lập quỹ, `projectManager` đề nghị rút, `capApprover` duyệt | Quỹ dự phòng `DA-PMDT105` 3,7 tỷ (quyết định `QD-DP-PMDT105/2026`); đề nghị rút 1,85 tỷ để bù cho CO bậc 2 ‹chưa xác minh› |
| 7.12 | CTR-34 Điều khoản claim; CTR-32 Sổ claim; CTR-33 Hồ sơ claim | `/ctr/ctr-32?devUser=projectManager`, `/ctr/ctr-33?claim=<từ CTR-32>&devUser=projectManager` | `projectManager` đề xuất điều khoản và đăng ký claim; `owner` duyệt điều khoản | `HD-PMTB164-TB01`: điều khoản claim của chủ đầu tư (Điều 14: thông báo 14 ngày, hồ sơ 30, phản hồi 21, quyết toán 30); claim `CLM-001` "Phạt vi phạm do chậm giao lô thiết bị thứ nhất" 132.300.000 đồng (1,5% giá trị hợp đồng), 15 ngày, đã thông báo ngày D-14 và nộp hồ sơ D-7. `HD-PMDT105-XL01`: claim gia hạn thời gian 11 ngày. Đồng hồ thời hiệu của từng bước |
| 7.13 | PMT-01 Hồ sơ giấy phép; PMT-03 loại giấy phép; PMT-05 hết hạn; PMT-06 miễn giấy phép (Tất cả ứng dụng, ô "Hồ sơ pháp lý & giấy phép") | `/pmt/pmt-01?devUser=projectManager` | `projectManager` lập; `owner` quyết định miễn | 4 dự án có hồ sơ: `DA-PMDT105` (giấy phép xây dựng, thiết kế, môi trường, PCCC, khai thác nước mặt đã cấp; giấy phép làm việc nóng đã cấp, hết hạn sau 20 ngày; giấy phép môi trường yêu cầu bổ sung); `DA-PMDT114` (PCCC yêu cầu bổ sung); `DA-PMDT120` (PCCC bị từ chối rồi nộp lại); `DA-PMDT130` (giấy phép xây dựng được miễn theo quy hoạch 1/500 khu công nghiệp, quyết định do `owner`; môi trường đang thẩm định). 7 loại giấy phép ở PMT-03 ‹chưa xác minh› |
| 7.14 | PRJ-06 Điều chỉnh dự án | `/prj/prj-06?id=<DA-PMDT130>&devUser=capApprover` | `projectManager` đề xuất, `capApprover` duyệt | `DA-PMDT130`: đề nghị tăng TMĐT 840 lên 861 tỷ (bù trượt giá thiết bị nhập khẩu), CHỜ duyệt, TMĐT hiện hành chưa đổi; `DA-PMTB172`: kéo dài thời gian thực hiện tới 2028, đã duyệt (`205/QĐ-HĐTV`). ĐỪNG mở dòng "Lần 1 hồ sơ ban đầu" (khóa kỹ thuật) |

**Điện thoại**: ứng dụng Flutter (tab Thông báo và Trang chủ điều hành) hiện các việc khẩn, trong đó có vướng mắc leo thang và chỉ đạo quá hạn; PWA `/m` không có màn vướng mắc riêng.

**Nối**: ← hồi 5 và 6 (hợp đồng, nghiệm thu, thanh toán). → hồi 9 và 10: vướng mắc quá hạn hiện ở "Việc của tôi" và Cần xử lý ngay trên HOME-09; thay đổi hợp đồng tạo phiên bản hợp đồng mới và sinh bút toán trên sổ cái vốn; kiến nghị kiểm toán gắn đúng hợp đồng.

**Kiểm soát đang minh họa**: SLA tự gán theo loại và mức, tính theo giờ làm việc; tối đa 2 lần gia hạn; leo thang không đóng vướng mắc gốc; người đóng khác người xử lý; chuỗi thay đổi ba tầng, người duyệt khác người lập, tăng giá phải nêu nguồn bù (dự phòng), hiệu lực không lùi; claim có điều khoản và đồng hồ thời hiệu (quá hạn thì bị chặn).

**Làm sống được (một lần)**: `owner` bấm "Xác nhận và đóng" ở ISS-07 cho I04; `capApprover` duyệt `PCO-001` của `HD-PMDT114-XL01` ở CTR-08 (khi duyệt sẽ sinh phiên bản hợp đồng mới ở CTR-26); `capApprover` quyết định đề nghị điều chỉnh `DA-PMDT130` ở PRJ-06 (cần số văn bản). Quyền xác nhận vướng mắc cho `capApprover` có thể chưa dùng được do ngày cấp quyền tính theo giờ thật, nên dùng `owner` ‹chưa xác minh›.

**Cẩn thận**: ISS-03, ISS-04, ISS-07 mở bằng cách bấm từ danh sách; CTR-14 chỉ có "điều chỉnh hồi tố", không có phạt chậm (phạt đi theo claim); số vướng mắc hiện ở một số màn có nhãn loại "Vướng mắc" nhưng dòng lịch sử sự kiện đều mang ngày hôm nay.

> **Lời dẫn**: "Công trình thật luôn có vướng mắc. Ở đây mỗi vướng mắc có mức độ, hạn xử lý tính theo giờ làm việc, tự leo thang khi quá hạn, và khi xong thì một người độc lập phải xác nhận. Bê tông móng không đạt, thiết bị nhập khẩu giao chậm, rồi thay đổi hợp đồng, claim: tất cả bám vào đúng một mã hợp đồng, nên lãnh đạo thấy được cả chuỗi chứ không phải từng mảnh."

---

### Hồi 8. Chốt kỳ và báo cáo lên Tập đoàn (khoảng 6 phút)

Đây là hồi trả lời câu "một nguồn số liệu": MỘT bản chốt được tạo ra một lần, và mọi dashboard, báo cáo, gói đẩy HPM đều đọc đúng bản đó.

**Dữ liệu lúc này**:

- Báo cáo tuần `W2026-46` (07 đến 13/11/2026, hạn 13/11 10:00) và thuyết minh tháng `M2026-11` (hạn 05/12): chứa số giải ngân lũy kế theo từng dự án ‹chưa xác minh›.
- Lô số liệu vốn: 24 lô kế hoạch năm (12 dự án x vốn chủ sở hữu và vốn vay) và khoảng 48 lô số thực (thực hiện và giải ngân tháng 1 đến 10) ‹chưa xác minh›.
- Bản chốt `ENT-M2026-10`: 928.756.000.000 / 1.534.000.000.000 = **60,54%**; cùng kỳ năm trước `ENT-M2025-10`: 610.677.000.000 / 1.304.000.000.000 = **46,83%**; chênh +13,71 điểm. Kỳ `ENT-M2026-05` đã mở lại và có bản sửa 2.
- 6 báo cáo biểu mẫu đã phát hành; 2 lần đẩy HPM; 16 dòng tệp Oracle EBS và 32 chênh lệch đối chiếu.

**Phần A. Nhập số liệu theo tuần và tháng**

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 8.1 | DIS-15 Tiến độ nộp báo cáo (thanh bên: Giải ngân, Tiến độ nộp) | `/dis/dis-15?devUser=owner` | `owner`, `capApprover` | Tuần `W2026-46` (thanh DIS-01): "Đã gửi 8/13" (62%), hạn 10:00 ngày 13/11, còn 5 dự án chưa gửi, chưa quá hạn; DIS-15 có bảng theo đơn vị (chưa đọc kỹ) |
| 8.2 | DIS-01 Danh sách báo cáo tuần (thanh bên: Giải ngân) | `/dis/dis-01?devUser=projectManager` | `projectManager` lập và gửi, `capApprover` duyệt | 6 báo cáo "Đã gửi, chờ lãnh đạo": `DA-PMDT105` (lũy kế 41,0 tỷ), `DA-PMDT114` (27,5), `DA-PMDT120` (18,2), `DA-PMTB164` (12,4), `DA-PMTB168` (7,2), `DA-PMTB172` (4,6); `DA-PMDT130` đã chấp nhận 33 tỷ; `DA-PMDT137` chấp nhận bản 2 (21,5 tỷ); `DA-PMTB180` bị trả lại (6,1 tỷ); `DA-PMTB191` nháp (1,9 tỷ) ‹chưa xác minh› |
| 8.3 | DIS-07 Chi tiết báo cáo; DIS-11 Lịch sử và so sánh (bấm từ DIS-01) | `/dis/dis-07?report=<từ DIS-01>&devUser=capApprover` | `capApprover` | `DA-PMDT137`: bản 1 bị TRẢ LẠI (khối lượng chưa khớp biên bản nghiệm thu tháng 10), bản 2 đã sửa và được chấp nhận; DIS-11 đặt hai bản cạnh nhau. `DA-PMTB180` bị trả lại vì thiếu thuyết minh chậm thanh toán lô máy biến áp thứ hai (trả lại phải kèm lý do từ 10 ký tự) |
| 8.4 | DIS-13 Thuyết minh tháng (thanh bên: Giải ngân); DIS-12 Tổng hợp giải ngân | `/dis/dis-13?devUser=owner`, `/dis/dis-12?devUser=owner` | `owner` | `M2026-11`: 6 báo cáo đã chấp nhận (`DA-PMDT105/114/130/137`, `DA-PMTB164/168`), 3 nháp; mỗi báo cáo 4 mục thuyết minh (kết quả, nguyên nhân, giải pháp, kiến nghị) và khối 8 trường doanh nghiệp (hiện trạng, tiến độ, giải ngân, vướng mắc, giải pháp, kế hoạch kỳ tới, kiến nghị) ‹chưa xác minh› |

Giới hạn: lịch sử các tuần `W2026-39..45` và tháng 9, 10 trống (kế hoạch vốn mới công bố nên các kỳ đã qua bị từ chối); chỉ có tuần `W2026-46` và tháng 11. Đừng chọn tuần cũ.

**Phần B. Lô số liệu vốn, khóa kỳ, bản chốt**

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 8.5 | DIS-28 Lập và duyệt lô số liệu vốn | `/dis/dis-28?devUser=projectManager` | `projectManager` lập, gửi; `capApprover` chấp nhận (hoặc trả lại kèm lý do) | Lô theo dự án x nhóm vốn x thước đo; tổng các kỳ phải bằng kế hoạch năm; người lập không tự duyệt |
| 8.6 | DIS-27 Số liệu vốn theo kỳ; DIS-29 Lịch sử của một kỳ | `/dis/dis-27?devUser=owner`, `/dis/dis-29?devUser=owner` | `owner` | Số lũy kế `DA-PMDT105` theo vốn chủ sở hữu và vốn vay trong kỳ `ENT-M2026-10` |
| 8.7 | DIS-14 Lịch kỳ và khóa sổ (thanh bên: Giải ngân, Lịch kỳ báo cáo) | `/dis/dis-14?devUser=owner` | `owner`, `projectManager` đóng mềm rồi khóa sổ | Kỳ `ENT-M2026-10` đã khóa; kỳ `ENT-M2026-05` đã khóa rồi mở lại; kỳ khóa không nhận thêm số |
| 8.8 | DIS-32 Dựng và rà soát bản chốt kỳ doanh nghiệp | `/dis/dis-32?devUser=projectManager` | `projectManager` dựng | "Kỳ đã đủ số liệu chưa": 12 dự án, 24 ô, đủ. Nếu thiếu số thực thì hệ thống chặn và liệt kê đơn vị, ô, tháng thiếu |
| 8.9 | DIS-33 Bản chốt kỳ doanh nghiệp (bấm từ DIS-32) | `/dis/dis-33?snapshot=<từ DIS-32>&devUser=owner` | `owner` chốt (khác người dựng) | Bản chốt FROZEN phiên bản N, mã băm SHA-256, nút "Kiểm tra lại mã băm". 928.756.000.000 / 1.534.000.000.000 = 60,54%. Bản cũ thành "đã thay thế" |
| 8.10 | DIS-22 Mở lại kỳ có lý do | `/dis/dis-22?devUser=capApprover` | `owner` hoặc `projectManager` đề nghị (≥20 ký tự lý do); `capApprover` duyệt (1 đến 168 giờ) | Kỳ `ENT-M2026-05` mở lại để sửa, sinh bản sửa 2 (bản 1 giữ nguyên) |

Số giải ngân lũy kế tháng 1 đến 10 so với kế hoạch năm, theo dự án (đây là các con số trên HOME-09; kế hoạch năm là bản 1, xem lưu ý ở mục 8):

| Dự án | Kế hoạch năm (tỷ) | Giải ngân lũy kế (tỷ) | Tỷ lệ | Cùng kỳ 2025 |
|---|---|---|---|---|
| `DA-PMDT105` | 339 | 209,997 | 61,94% | 39,14% |
| `DA-PMDT114` | 152 | 111,189 | 73,15% | 48,00% |
| `DA-PMDT120` | 227 | 145,210 | 63,96% | 42,73% |
| `DA-PMDT130` | 342 | 200,369 | 58,58% | 40,85% |
| `DA-PMDT137` | 223 | 103,112 | 46,23% | 63,70% |
| `DA-PMTB164` | 33 | 13,942 | 42,24% | 60,16% |
| `DA-PMTB168` | 78 | 53,389 | 68,44% | 46,73% |
| `DA-PMTB172` | 61 | 37,439 | 61,37% | 55,48% |
| `DA-PMTB180` | 65 | 44,140 | 67,90% | 56,19% |
| `DA-PMTB191` | 14 | 9,969 | 71,20% | 53,39% |
| **Tổng** | **1.534** | **928,756** | **60,54%** | **46,83%** |

(Hai dự án chưa có kế hoạch vốn là `DA-PMDT154` và `DA-PMTB204` hiện "Chưa có số liệu".)

**Phần C. Báo cáo gửi Tập đoàn, HPM, EBS**

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 8.11 | RPT-01 Danh mục biểu mẫu báo cáo (thanh bên: Báo cáo gửi Tập đoàn) | `/rpt/rpt-01?devUser=projectManager` | `projectManager` lập | 6 biểu mẫu, đều gắn nhãn "MẪU DEMO - chờ mẫu chính thức": báo cáo tháng gửi Tập đoàn (`PVN-MONTHLY`), biểu 2 theo quý (`PVN-QUARTERLY-F2`), định dạng HPM (`HPM-MONTHLY`), giao ban đầu tư (`INVEST-STEERING`), nhà máy Phú Mỹ (`PLANT-PHU-MY`); mẫu thứ sáu `COMMITTEE-PERIODIC` chỉ có trong danh mục, không phát hành |
| 8.12 | RPT-02 Kiểm tra, phê duyệt, phát hành; RPT-03 Bản đã phát hành | `/rpt/rpt-02?devUser=docHead`, `/rpt/rpt-03?devUser=docHead` | Ba người khác nhau: `projectManager` lập, `owner` kiểm, `docHead` phê duyệt và phát hành | 6 bản đã phát hành, mỗi bản có mã băm. Kỳ `2026-M10` lấy số từ ĐÚNG bản chốt `ENT-M2026-10` (số `snapshot_ref` = mã + phiên bản in vào báo cáo): ví dụ `PVN-01/THANG`, `GB-01/THANG`, `NM-01/THANG`, `HPM-01/THANG` |
| 8.13 | RPT-09 So sánh chéo cùng kỳ | `/rpt/rpt-09?devUser=docHead&kind=MONTH&year=2026&index=5` | `docHead` giải trình (khác người lập) | KỲ `2026-M05` có đúng 1 số lệch chặn phát hành (XR-02): giải ngân tháng 3/2025 của `DA-PMDT105` (vốn chủ sở hữu) báo cáo lại cao hơn 2 tỷ so với bản chốt; chưa giải trình. Kịch bản đầy đủ ở mục 6.4 |
| 8.14 | HPM-01 Đẩy báo cáo lên HPM (thanh bên: Đẩy HPM và đối chiếu EBS) | `/hpm/hpm-01?devUser=owner` (KHÔNG dùng `docHead`) | `projectManager` đẩy, `owner` ghi biên nhận | 2 dòng: `HPM-MONTHLY` kỳ `2026-M10` trạng thái "Đã ghi gói, chờ biên nhận"; kỳ `2026-M09` trạng thái "HPM từ chối", tham chiếu `HPM-2026-M09`, lý do "Mẫu demo, chờ mẫu chính thức nên chưa thể ghi nhận là đã được chấp nhận". Khóa đẩy = biểu mẫu + kỳ + phiên bản + SHA-256; đẩy lại cùng bản bị chặn |
| 8.15 | HPM-02 Đính chính kỳ đã nhận | `/hpm/hpm-02?devUser=owner` | `owner` | Chưa có đề nghị nào nên chỉ hiện câu giải thích. Đó là đúng |
| 8.16 | EBS-01 Kết nối Oracle EBS; EBS-02 Đối chiếu theo mã dự án (thanh bên: Đẩy HPM và đối chiếu EBS) | `/ebs/ebs-01?devUser=owner`, `/ebs/ebs-02?devUser=owner` | `capApprover` tải tệp, `projectManager` nhập và chạy đối chiếu, `owner` nhận giải trình | Tệp trích ngày 07/11/2026, 16 dòng (8 dự án x 2 kỳ 2026-08, 2026-09), 32 chênh lệch (16 dòng x 2 chỉ tiêu). Ví dụ `DA-PMDT105`: 2026-08 giải ngân 63.024 triệu, 2026-09 35.308 triệu, cam kết 272.400 triệu (= 40% TMĐT) |

**Điện thoại**: 6 báo cáo tuần `W2026-46` đang chờ lãnh đạo hiện ở `/m/approvals` (mục 9.11); duyệt trên điện thoại thì DIS-15 và DIS-01 trên máy tính đổi theo.

**Nối**: ← hồi 5, 6, 7 (số liệu giải ngân theo dự án). → hồi 9: HOME-09, HOME-07, BAN-01 và ứng dụng điện thoại đọc đúng bản chốt FROZEN này. Báo cáo RPT và gói HPM đóng dấu `snapshot_ref` của bản chốt. Quy tắc nền R21: không màn nào tự tính lại số.

**Kiểm soát đang minh họa**: người nhập khác người duyệt (`SELF_APPROVAL_DENIED`); trả về phải có lý do; bản chốt bất biến, băm SHA-256, người dựng khác người chốt; mở lại kỳ cần lý do, phạm vi, thời hạn và người duyệt khác người đề nghị; báo cáo cần ba người khác nhau; khóa chống đẩy trùng HPM và từ chối phiên bản cũ; chênh lệch chặn phát hành đến khi có giải trình.

**Nói rõ với khách (PENDING-EXTERNAL)**: HPM và Oracle EBS hiện là kết nối dựa trên TỆP (ghi tệp cho HPM, đọc tệp xuất của EBS), định dạng là giả định tạm, chờ đặc tả chính thức. Bản chính thức sẽ được ghi nhận khi Tập đoàn bàn giao mẫu chính thức và HPM xác nhận định dạng. Không có trạng thái "HPM đã nhận" trong demo.

**Cẩn thận**: (1) KỲ báo cáo `2026-M09` (HPM) và `2026-Q3` (biểu 2 quý) không có bản chốt, nên nội dung báo cáo dùng dữ liệu minh họa của gói báo cáo (22 dự án có nhãn "(minh họa)", không phải `DA-PM*`): chỉ mở nội dung các báo cáo kỳ `2026-M10`. (2) Bốn chuỗi "giải ngân" khác nhau (bản chốt 928,756 tỷ; sao kê ngân hàng 543,33 tỷ; tệp EBS; chuỗi báo cáo tuần, ví dụ 41,0 tỷ cho `DA-PMDT105`) là các chuỗi minh họa độc lập, KHÔNG đối chiếu với nhau: không mở hai màn cạnh nhau cho cùng một dự án. (3) RPT-09 chỉ trình diễn được MỘT lần (mục 6.4).

> **Lời dẫn**: "Chuyên viên nhập số, lãnh đạo duyệt, rồi kỳ được khóa và hệ thống dựng một bản chốt có mã băm. Từ giờ không ai sửa lặng lẽ được. Báo cáo gửi Tập đoàn và dashboard của lãnh đạo đều đọc đúng bản chốt này, cho nên hai nơi không thể lệch nhau. Muốn sửa phải mở lại kỳ có lý do và có người thứ hai duyệt."

---

### Hồi 9. Điều hành: dashboard, cảnh báo, chỉ đạo, điện thoại (khoảng 5 phút)

**Dữ liệu lúc này**: không tạo dữ liệu mới cho dashboard; mọi con số đọc từ bản chốt của hồi 8. Thêm: 3 cuộc giao ban và 6 chỉ đạo (2 quá hạn); 3 quy tắc cảnh báo sớm; cảnh báo mở và đã ghi nhận; việc chờ duyệt trên điện thoại.

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 9.1 | HOME-09 Trung tâm điều hành giải ngân (Tất cả ứng dụng, ô "Điều hành", hoặc từ HOME-01) | `/home/home-09?devUser=owner` | `owner` | Khung "Giải ngân so với kế hoạch năm": công ty 60,54% (928,756 / 1.534 tỷ), cùng kỳ năm trước 46,83%, +13,71 điểm; bảng theo đơn vị (một đơn vị) và theo dự án. Nút "Trình chiếu" chạy từng bảng chữ lớn toàn màn hình. Chỉ dùng bảng "Tỷ lệ giải ngân theo đơn vị", KHÔNG dừng ở thẻ "Xếp hạng giải ngân theo đơn vị" ở cuối (ghi "Chưa có dữ liệu") |
| 9.2 | HOME-07 Cơ cấu nguồn vốn | `/home/home-07?devUser=owner` | `owner` | Vốn chủ sở hữu: kế hoạch 733 tỷ, giải ngân 360,270 tỷ (49,15%), thực hiện 411,580 tỷ (56,15%). Vốn vay: 801 tỷ, 568,486 tỷ (70,97%), 624,555 tỷ (77,97%). Tỷ trọng kế hoạch 47,8% / 52,2%. "Vốn khác" ghi "Chưa có dữ liệu" (không phải 0) |
| 9.3 | HOME-10 Ngữ cảnh số liệu và truy nguồn | bấm dấu "i" cạnh một con số ở HOME-09 | `owner` | Con số được truy về đúng bản chốt (mã kỳ, phiên bản, mã băm). Dùng để trả lời "số này từ đâu ra" |
| 9.4 | HOME-03 Cảnh báo sớm; HOME-06 Hồ sơ cảnh báo | `/home/home-03?devUser=owner`; HOME-06 mở từ một dòng | `capApprover` công bố quy tắc, `projectManager` phân loại, `owner` yêu cầu giải trình | Quy tắc `EW-DN-01` (theo dõi), `EW-DN-02` (cần xử lý), `EW-DN-03` (khẩn) cho "báo cáo tuần chậm"; HOME-03 đang hiển thị 7 cảnh báo (HOME-09 mục "Cần xử lý ngay": Khẩn 5, Cần xử lý 52, Theo dõi 16 trên toàn phạm vi, số đổi theo đồng hồ). Từ HOME-06: "Yêu cầu giải trình", "Ghi nhận", "Bỏ qua". Cảnh báo chỉ sinh khi bản chốt tuần được đóng băng, không tự bịa |
| 9.5 | HOME-02 Việc của tôi (thanh bên) | `/home/home-02?devUser=owner` | `owner` | Việc cần làm gom từ mọi module (phê duyệt, vướng mắc quá hạn, chỉ đạo, cảnh báo): `owner` khoảng 25 việc (Khẩn 3, Cần xử lý 16, Theo dõi 6); `projectManager` khoảng 72, `capApprover` khoảng 85, `docHead` khoảng 10. Số đổi theo đồng hồ. Bấm một việc là đến đúng màn xử lý |
| 9.6 | DIR-01 Các cuộc giao ban (thanh bên: Chỉ đạo và giao ban); DIR-03 Bảng theo dõi chỉ đạo | `/dir/dir-01?devUser=owner`, `/dir/dir-03?devUser=owner` | `projectManager` ghi nhận, `owner` theo dõi | 3 cuộc: `GB-2026-001` (11/09/2026, tháng trước), `GB-2026-002` (11/10/2026), `GB-2026-003` (03/11/2026, bất thường). 6 chỉ đạo, mỗi chỉ đạo gắn một dự án; 2 QUÁ HẠN: `GB-2026-001/CD-01` (hoàn thiện hồ sơ thiết kế kỹ thuật, `DA-PMDT105`, hạn 21/10) và `GB-2026-002/CD-03` (đối chiếu số liệu giải ngân với hệ thống kế toán, `DA-PMDT137`, hạn 07/11) |
| 9.7 | DIR-04 Chi tiết chỉ đạo (CHỈ mở từ DIR-03 hoặc DIR-01) | bấm mã chỉ đạo ở DIR-03 | `owner` | Dòng thời gian của một chỉ đạo. Gõ thẳng `/dir/dir-04` sẽ tự mở chỉ đạo cấp bách nhất hoặc màn trống |
| 9.8 | DIR-05 Chỉ đạo của kỳ làm đầu vào báo cáo kỳ sau | `/dir/dir-05?devUser=owner` | `owner` | Chỉ đạo của kỳ trở thành đầu vào thuyết minh báo cáo kỳ sau (nối ngược lại hồi 8) |
| 9.9 | BI-01 Thư viện dashboard (thanh bên: BI & báo cáo) | `/bi/bi-01?devUser=owner` | `projectManager` lập, `capApprover` công bố theo `152/QĐ-HĐTV` | Thư viện có 6 dashboard: ĐÃ CÔNG BỐ `BD-LANH-DAO` (Bảng điều hành lãnh đạo: hợp đồng và mua sắm), `BD-HOP-DONG` (Hợp đồng, nghiệm thu và thanh toán), `BD-NHA-THAU` (Cơ cấu nhà thầu và mức độ cạnh tranh), `BD-TAM-UNG-BAO-LANH` (Tạm ứng, giữ lại và bảo lãnh); BẢN NHÁP `BD-BIEN-DONG-HOP-DONG`, `BD-THANH-TOAN-DU-AN`. BI-02 "Chỉ tiêu của tôi" (thanh bên: Dashboard của tôi) hiện 25 ô chỉ tiêu có tên tiếng Việt, kỳ mặc định `W2026-45` |

**Điện thoại, phần 1: ứng dụng web PWA (`/m`)**. Dùng cửa sổ trình duyệt thu nhỏ còn 390 px, hoặc mở bằng iPhone qua `https://172.20.10.5:5443/m`.

| # | Màn | Địa chỉ | Khán giả thấy gì |
|---|---|---|---|
| 9.10 | Trang chủ ứng dụng | `/m?devUser=owner` | Đếm "6 việc chờ duyệt, 0 quá hạn", thẻ cài đặt ứng dụng |
| 9.11 | Hàng đợi phê duyệt | `/m/approvals?devUser=owner` | 6 báo cáo tuần `W2026-46` chờ lãnh đạo: mỗi thẻ ghi dự án và số lũy kế giải ngân (tỷ): `DA-PMDT105` 41,0; `DA-PMDT114` 27,5; `DA-PMDT120` 18,2; `DA-PMTB164` 12,4; `DA-PMTB168` 7,2; `DA-PMTB172` 4,6; hạn "Còn 1 ngày" ‹chưa xác minh›. Mỗi báo cáo là một việc cho CẢ hai lãnh đạo (`owner`, `capApprover`): ai duyệt trước thì việc của người kia tự hủy |
| 9.12 | Chi tiết phê duyệt | `/m/approvals/<mã việc>` (bấm từ thẻ) | Nội dung báo cáo, nút "Duyệt" và "Trả lại" (trả lại phải ghi lý do từ 10 ký tự) |
| 9.13 | Bảng điều hành lãnh đạo; chi tiết số liệu; tiến độ đấu thầu | `/m/dashboard`, `/m/dashboard/detail`, `/m/progress` | Cùng bản chốt `ENT-M2026-10`, hiển thị theo cỡ điện thoại |
| 9.14 | Theo dõi chỉ đạo | `/m/directives`, `/m/directives/<mã>` | Cùng 6 chỉ đạo của DIR |
| 9.15 | Cài đặt | `/m/settings`, `/m/notifications` | Thu hồi thiết bị; cài đặt thông báo đẩy (đây KHÔNG phải hộp thư thông báo) |

Phê duyệt trên điện thoại là MỘT LẦN: duyệt một báo cáo thì báo cáo thành "Đã chấp nhận", việc của lãnh đạo kia mất, và con số ở DIS-15 (hồi 8) đổi. Nếu muốn làm sống, chỉ duyệt một thẻ (ví dụ `DA-PMTB172` 4,6 tỷ) rồi quay lại DIS-15 để cho thấy kết nối.

**Điện thoại, phần 2: ứng dụng Flutter trên Android Sharp SH-M19** (hướng dẫn đầy đủ ở `C:\PIS\Design\Huong_Dan_Chay_App_Flutter_Demo.md`, tóm tắt ở Phụ lục A).

| # | Màn | Khán giả thấy gì |
|---|---|---|
| 9.16 | Đăng nhập | "Đăng nhập bằng SSO", chọn đơn vị "Đạm Phú Mỹ", "Xác thực trong trình duyệt" (hai yếu tố, không hỏi mã); vào là `owner` |
| 9.17 | Trang chủ điều hành | 10 dự án; Khẩn 3, Cần xử lý 43, Theo dõi 9; thẻ "Chỉ đạo quá hạn GB-2026-001/CD-01" ‹chưa xác minh› |
| 9.18 | Thông báo | Việc khẩn là chỉ đạo quá hạn |
| 9.19 | Dự án | Danh sách dự án (12 hoặc 18 ‹chưa xác minh›), Kế hoạch vốn, Vướng mắc theo tuần |
| 9.20 | Cá nhân | Tên Nguyễn Văn An, đổi ngôn ngữ (chọn Tiếng Việt), ủy quyền |
| 9.21 | Phê duyệt | Mở được nhưng màn hình điện thoại bị chặn quay/chiếu (đen) do cờ bảo mật của ứng dụng: thao tác trực tiếp trên điện thoại, đừng ghi hình màn này |

**Nối**: ← hồi 8 (bản chốt). Dashboard, PWA và Flutter đều là các "cửa sổ" nhìn vào cùng một dữ liệu: duyệt báo cáo tuần trên điện thoại làm đổi DIS-15 trên máy tính; chỉ đạo ở DIR-03 hiện trên cả Flutter lẫn `/m/directives`.

**Kiểm soát đang minh họa**: dashboard chỉ đọc bản chốt (không tự tính), chỉ truy nguồn được; cảnh báo có phân loại, leo thang theo lịch (khẩn: lãnh đạo bậc 1 ngay, bậc 2 sau 8 giờ làm việc nữa) ‹chưa xác minh›; phê duyệt trên điện thoại đòi xác thực hai yếu tố và người lập không tự duyệt; thiết bị có thể thu hồi từ xa.

> **Lời dẫn**: "Lãnh đạo không cần hỏi ai, mở một màn hình là thấy: giải ngân 60,54% so với kế hoạch năm, cao hơn cùng kỳ năm trước gần 14 điểm. Bấm vào con số là truy được về đúng bản chốt. Chỉ đạo giao ban nào quá hạn, vướng mắc nào cần quyết, hiện ngay trên điện thoại, và lãnh đạo duyệt báo cáo ngay trên đó."

---

### Hồi 10. Kiểm toán, bàn giao tài sản, bảo hành, kết thúc dự án (khoảng 5 phút)

**Dữ liệu lúc này** (‹chưa xác minh›): 4 cuộc kiểm toán/thanh tra; kiến nghị và theo dõi khắc phục; 3 biên bản bàn giao tài sản; 2 tài sản; 3 yêu cầu bảo hành; 6 dự án ở các đầu mút của vòng đời. Lưu ý: người dùng `auditor` KHÔNG vào được module kiểm toán; dùng `owner`.

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 10.1 | AUD-01 Tổng quan kiểm toán (Tất cả ứng dụng, ô "Thanh tra & kiểm toán") | `/aud/aud-01?devUser=owner` | `owner` | 3 cuộc đang theo dõi (1 đang diễn ra, 2 theo dõi kiến nghị), 9 kiến nghị mở, 0 quá hạn, tiền kiến nghị 3.240.000.000 đồng, đã thu hồi 900.000.000 (27,78%), số kiến nghị đã đóng 2/11 (18,18%). Danh sách chỉ liệt kê `KTNB-2026-01` (5 kiến nghị mở), `KTNB-2026-05` (0), `KTR-DKVN-2026-03` (4) |
| 10.2 | AUD-02 Danh sách cuộc | `/aud/aud-02?devUser=owner` | `projectManager` lập, `capApprover` giao kiến nghị, `owner` xác minh | `KTNB-2026-01` kiểm toán nội bộ công tác đầu tư xây dựng 2026 (Ban Kiểm toán nội bộ Tổng công ty, `311/QĐ-HĐTV`, đang theo dõi thực hiện); `KTR-DKVN-2026-03` kiểm tra công tác lựa chọn nhà thầu và quản lý hợp đồng mua sắm thiết bị (Ban Kiểm tra - Giám sát Tập đoàn Dầu khí Việt Nam, `892/QĐ-DKVN`, đang theo dõi); `KTNB-2026-05` quản lý vốn và giải ngân `KHV-2026` (đang tiến hành); `KTNB-2027-01` quyết toán vốn đầu tư `DA-PMTB164` (đã lập kế hoạch) |
| 10.3 | AUD-03 Hồ sơ cuộc (chọn cuộc trong danh sách); AUD-05 Phát hiện; AUD-06 Kiến nghị | `/aud/aud-03?engagement=<từ AUD-02>&devUser=owner` | `owner` | `KTNB-2026-01`: báo cáo `07/BC-KTNB`, phạm vi `DA-PMDT105/114/120`, `HD-PMDT105-XL01`, `HD-PMDT105-TV01`; 5 phát hiện `NB-01..05`; 6 kiến nghị `KN-01..06`, tổng 3,24 tỷ |
| 10.4 | AUD-07 Theo dõi thực hiện; AUD-08 Thu hồi tài chính; AUD-09 Bằng chứng khắc phục; AUD-10 Báo cáo kết quả | `/aud/aud-07?engagement=<từ AUD-02>&devUser=owner` | `owner` | `KN-01` thu hồi 1,24 tỷ chi phí tư vấn giám sát vượt định mức `HD-PMDT105-TV01`, đã nộp trả 0,9 tỷ (AUD-08 đối chiếu thu hồi); `KN-02` điều chỉnh 2,0 tỷ số liệu giải ngân tháng 3/2025 của `DA-PMDT105` (chính là số lệch XR-02 ở RPT-09, hồi 8; đang thực hiện); `KN-03` phụ lục gia hạn `HD-PMDT105-XL01` (ĐÃ ĐÓNG); `KN-04` hồ sơ vật liệu `HD-PMDT114-XL01` (chờ xác minh); `KN-05` quy trình điều chỉnh kế hoạch lựa chọn nhà thầu (đã giao); `KN-06` kiểm điểm trách nhiệm (chưa giao). `KTR-DKVN-2026-03`: kết luận `58/KL-KTGS`, phát hiện `TB-01` hợp đồng `HD-PMTB164-TB01` ký ngày 16/9 trước ngày công bố kết quả 23/9 (đúng số liệu thật của dữ liệu mẫu); `TB-KN-03` ĐANG PHẢN BIỆN kèm công văn giải trình. Báo cáo kết quả thực hiện kiến nghị: "đã yêu cầu, chờ ban hành" |
| 10.5 | AST-01 Danh sách bàn giao (Tất cả ứng dụng, ô "Bàn giao tài sản & bảo hành") | `/ast/ast-01?devUser=projectManager` | `projectManager` lập, `capApprover` hoặc `owner` quyết định nhận bàn giao | `BBBG-PMTB164-01` (máy nén khí 2 cấp, `HD-PMTB164-TB01`, Tân Phát): 2 tồn tại đã khắc phục và kiểm, ĐÃ NGHIỆM THU; `BBBG-PMTB164-02` (đợt 2 phụ tùng) bản nháp; `BBBG-PMTB168-01` (DCS và đo lường amoniac): 4 tồn tại (1 nghiêm trọng còn mở, 1 sửa chờ xác minh, 2 mở) nên "có vấn đề" ‹chưa xác minh› |
| 10.6 | AST-02 Biên bản bàn giao và tồn tại; AST-03 Hồ sơ tài sản | `/ast/ast-02?id=<từ AST-01>&devUser=projectManager`, `/ast/ast-03?handover=<từ AST-01>&devUser=projectManager` | `projectManager` | AST-02 của `BBBG-PMTB168-01`: tồn tại nghiêm trọng chặn nhận bàn giao. AST-03: tài sản `TS-PMTB164-01` 7,9 tỷ và `TS-PMTB164-02` 0,92 tỷ (cộng 8,82 tỷ = giá trị hợp đồng) ‹chưa xác minh› |
| 10.7 | AST-04 Bảo hành và giữ lại; AST-05 Yêu cầu bảo hành | `/ast/ast-04?handover=<từ AST-01>&devUser=projectManager`, `/ast/ast-05?devUser=projectManager` | `projectManager` | Kế hoạch bảo trì 6 tháng, bảo hành 24 tháng, giữ lại 441 triệu (5% của 8,82 tỷ). Yêu cầu bảo hành `BH-PMTB164-01` (rò rỉ dầu, đã xác minh), `-02` (cảm biến nhiệt độ, nhà thầu đã cam kết), `-03` (đồng hồ áp suất, mở, hạn phản hồi 17/11/2026) ‹chưa xác minh› |
| 10.8 | PRJ-14 / PRJ-01 (cuối vòng đời) | `/prj/prj-14?devUser=projectManager` | `projectManager` | `DA-PMDT904` TẠM DỪNG (`198/QĐ-HĐTV`, chờ thẩm duyệt PCCC); `DA-PMTB905` và `DA-PMTB906` HOÀN THÀNH; `DA-PMDT903` BỊ TỪ CHỐI (trùng phạm vi kho chứa). Dòng vốn 3 dự án đã thi công nằm trong kế hoạch năm 2024 `KHV-2024`, không đụng `KHV-2026` |
| 10.9 | PRJ-12 Quyết toán dự án (thanh bên: Dự án, Quyết toán) | `/prj/prj-12?devUser=owner` | `projectManager` lập, `owner` xác minh và duyệt | `DA-PMTB905` (camera giám sát và báo cháy tự động, 14 tỷ): quyết toán ĐÃ GỬI, chờ xác minh. `DA-PMTB906` (thiết bị bảo hộ và an toàn lao động, 8 tỷ): quyết toán ĐÃ ĐÓNG theo quyết định phê duyệt quyết toán |
| 10.10 | PRJ-29 Bài học kinh nghiệm và cổng đóng dự án; PRJ-19 Yêu cầu giải trình; PRJ-11 Bàn giao tài sản | `/prj/prj-29?devUser=owner`, `/prj/prj-19?devUser=owner`, `/prj/prj-11?devUser=owner` | `owner` | PRJ-29: `DA-PMTB906` có 3 bài học đã duyệt. PRJ-19: 3 yêu cầu giải trình do `owner` gửi: `DA-PMDT904` (đã trả lời, được CHẤP NHẬN), `DA-PMDT137` (giải ngân thấp, đã trả lời, TRẢ LẠI để bổ sung), `DA-PMDT130` (chậm mốc, chờ giải trình). PRJ-11: bàn giao của `DA-PMTB164` (2 dòng, 1 đã nghiệm thu, 1 nháp) |

**Nối**: ← mọi hồi trước. Kiến nghị kiểm toán bám đúng mã dự án và mã hợp đồng, và số lệch RPT-09 xuất hiện lại ở `KN-02`. Bàn giao tài sản đóng vòng của hợp đồng `HD-PMTB164-TB01` (từ hồi 3: gói; hồi 4: hợp đồng; hồi 7: claim; hồi 10: tài sản và bảo hành).

**Kiểm soát đang minh họa**: kiến nghị có người giao, hạn và bằng chứng khắc phục, phản biện được; thu hồi tài chính đối chiếu với số nộp; nhận bàn giao bị chặn khi còn tồn tại nghiêm trọng; đóng dự án cần quyết toán, không còn vốn cam kết và bài học đã duyệt; mỗi quyết định cần số văn bản.

**Giới hạn thật thà**: KHÔNG có dự án nào ở trạng thái "Đã quyết toán" hoặc "Đã đóng" (sản phẩm chưa có bộ tiêu thụ sự kiện chuyển từ Hoàn thành sang Đã quyết toán); PRJ-12 ghi "đã quyết toán, chờ chuyển giai đoạn" và lệnh đóng dự án chưa dùng được. Dự án mới không có hợp đồng nên bàn giao tài sản trình diễn trên `DA-PMTB164` (đang thực hiện) chứ không phải trên dự án hoàn thành. PRJ-13 (theo dõi tháng) lấy từ báo cáo tháng ở DIS nên không do nhóm này tạo.

> **Lời dẫn**: "Dự án không chấm dứt khi nghiệm thu. Kiểm toán nội bộ và đoàn kiểm tra của Tập đoàn để lại kiến nghị; mỗi kiến nghị có người nhận, hạn và bằng chứng khắc phục. Tài sản được bàn giao có biên bản, có tồn tại phải sửa, có bảo hành hai năm. Và vòng đời kết thúc bằng quyết toán, bài học kinh nghiệm cho dự án sau."

---

### Hồi 11. Quản trị: nhật ký, quy trình duyệt, văn bản, thông báo (khoảng 3 phút)

**Dữ liệu lúc này**: toàn bộ lệnh của 10 hồi trước đã để lại dòng nhật ký; quy tắc duyệt báo cáo tuần dạng dữ liệu cấu hình; sổ văn bản đi và đến; luồng thông báo.

| # | Màn (đường vào) | Địa chỉ | Người | Khán giả thấy gì |
|---|---|---|---|---|
| 11.1 | ADM-11 Nhật ký kiểm toán (Tất cả ứng dụng, ô "Quản trị tổ chức") | `/adm/adm-11?devUser=owner` (KHÔNG dùng `auditor`) | `owner` | trang đầu hiện 50 dòng: ai làm gì, lúc nào, trên mã nào. Lọc theo mã (ví dụ `HD-PMDT105-XL01`). "Xem thay đổi" cho thấy trước/sau; "Xuất có niêm phong" (tối đa 366 ngày); chuỗi băm không sửa được. Đây là bằng chứng cho mọi hồi trên |
| 11.2 | ADM-18 Theo dõi quy trình phê duyệt | `/adm/adm-18?devUser=owner` | `owner` vận hành | Hàng đợi chờ phê duyệt (trang đầu hiện 12 hàng, gồm các báo cáo tuần của điện thoại; số đổi theo đồng hồ); nút "Chuyển người xử lý", "Hủy phê duyệt"; hạn tính theo giờ làm việc |
| 11.3 | ADM-06 Dựng quy trình phê duyệt | `/adm/adm-06?devUser=capApprover` | `owner` soạn, `capApprover` duyệt | Quy tắc `REPORT_ACCEPT` (duyệt báo cáo tuần): 1 bước "Lãnh đạo duyệt báo cáo tuần của dự án", người duyệt `owner` hoặc `capApprover`, hạn 8 giờ làm việc (1 ngày), hiệu lực từ hôm nay. Nói: "quy trình là dữ liệu cấu hình, đổi được khi quy định đổi, không phải sửa chương trình" |
| 11.4 | ADM-15 / ADM-04 (đã mở ở hồi 0) | `/adm/adm-15?devUser=owner` | `owner` | Ma trận ủy quyền ký được ghim phiên bản vào từng hồ sơ ký |
| 11.5 | DOC sổ văn bản (Tất cả ứng dụng, ô "Văn bản & báo cáo", mở DOC-12) | `/doc/doc-12?devUser=projectManager` | `projectManager` soạn, `capApprover` ký, `owner` cấp số, đóng dấu, phát hành | Văn bản đi 18, văn bản đến 13, hồ sơ 5 ‹chưa xác minh›; các số xuyên suốt tài liệu này: `88`, `91`, `92`, `95`, `105/QĐ-HĐTV`, `58/QD-DPM`... Mọi duyệt, công bố đều trỏ vào một văn bản ở đây. Lọc loại "Quyết định" |
| 11.6 | NOT-06 Điều phối thông báo (thanh bên: Thông báo); NOT-05 danh mục sự kiện | `/not/not-06?devUser=owner`, `/not/not-05?devUser=owner` | `owner` | 21 luồng sự kiện đã công bố; mẫu thông báo, nhóm người nhận (NOT-07, NOT-08). Hộp thông báo NOT-01 của `owner` có 10 mục chưa đọc (8 cần xử lý; số trên huy hiệu thanh bên là 3, đổi theo đồng hồ): tiêu đề đang hiện chung "Thông báo mới" (chuỗi dịch chưa đầy đủ), nên chỉ giới thiệu luồng, KHÔNG đọc từng thông báo |

**Kiểm soát đang minh họa**: nhật ký chỉ thêm, niêm phong chuỗi; người soạn khác người công bố; quy trình có phiên bản và người duyệt phiên bản khác người soạn; hạn tính theo lịch làm việc; ủy quyền có thời hạn.

> **Lời dẫn**: "Phần ít được nhìn thấy nhất nhưng quan trọng nhất cho kiểm toán: mọi lệnh bạn thấy hôm nay đều có dòng nhật ký, không sửa được, niêm phong theo chuỗi. Quy trình duyệt là dữ liệu cấu hình: khi quy định thay đổi, quản trị sửa bằng màn hình này, có người duyệt, không cần lập trình lại."

### Hồi 12 (tùy chọn). Trợ lý AI trên tài liệu công khai (khoảng 2 phút)

Chỉ làm khi còn giờ và mạng ổn định. Đây là Claude THẬT, không phải câu trả lời dựng sẵn.

| # | Màn | Địa chỉ | Người | Khán giả thấy |
|---|---|---|---|---|
| 12.1 | LLM-22 Trợ lý AI | `http://127.0.0.1:5173/llm/llm-22?devUser=owner&subject_kind=DOCUMENT_VERSION&subject_id=8c16138c-3d07-4147-8b23-61cf298c23da` | `owner` | Câu hỏi về một tài liệu mẫu CÔNG KHAI; mất khoảng 14 giây để có câu trả lời; kèm dẫn chứng |

**Kiểm soát đang minh họa**: chỉ dữ liệu phân loại CÔNG KHAI mới được gửi ra ngoài hệ thống. Hồ sơ dự án và hợp đồng bị chặn bởi quy tắc phân loại dữ liệu, nên KHÔNG hỏi AI về dự án hay hợp đồng của Phú Mỹ trên màn này. AI chỉ gợi ý, người quyết định (BID-18 nói rõ "AI không là căn cứ quyết định").

> **Lời dẫn**: "Trợ lý AI trả lời trên tài liệu công khai và dẫn chứng. Dữ liệu nội bộ của công ty, như hợp đồng hay hồ sơ dự án, bị hệ thống chặn không cho ra ngoài. AI chỉ hỗ trợ đọc, người có thẩm quyền vẫn quyết định."

**Kết buổi (30 giây)**: quay lại HOME-09 và nói: "Từ lúc một ý tưởng được đăng ký đến lúc tài sản được bàn giao, dữ liệu được nhập một lần, nằm ở một nguồn, có vết ai làm, và đi tự động đến báo cáo gửi Tập đoàn. Số liệu hôm nay là minh họa; khi Đạm Phú Mỹ bàn giao mẫu chính thức và đặc tả HPM, EBS thì kết nối thật được cắm vào."

---

## 4. Bản đồ liên kết: một khóa, mọi màn nó xuất hiện

Cách dùng: đang đứng ở một màn, muốn cho khách thấy "cùng mã này ở chỗ khác", tra khóa ở đây.

### 4.1 Khóa chính

| Khóa | Ý nghĩa | Sinh ra ở | Xuất hiện ở các màn |
|---|---|---|---|
| `DA-PMDT105` | Dự án "Nâng công suất hệ thống nước làm mát", 681 tỷ | PRJ-02 (hồi 1) | PRJ-01, 03, 05, 07, 14, 16, 17, 18, 22 (dự phòng); CAP-03, 07, 10, 12, 17, 18, 21, 22; BID-15, 03, 18 (gói `PMDT105-TB01`); CTR-01 đến CTR-33 (3 hợp đồng); EQP-01 (`TB26-03`); ISS-01 (I01, I02, I09); QMS-01, 04, 06, 07; PMT-01; DIS-01/07/13/15, DIS-27/28/33; HOME-09 (bảng theo dự án); EBS-02; DIR-03 (`GB-2026-001/CD-01`); RPT-09 (kỳ `2026-M05`); AUD (`KTNB-2026-01`, `KN-02`); `/m/approvals`; ADM-11 |
| `DA-PMTB164` | Mua sắm máy nén khí, 86 tỷ, nhóm C | PRJ-02 | PRJ-14; CAP-03; BID-03 (3 gói); EQP-01 (`TB26-01`, `TB26-08`); CTR-01 (`HD-PMTB164-TB01`); ISS I05; CTR-32/33 (`CLM-001`); AST-01 đến AST-05; PRJ-11; AUD `KTR-DKVN-2026-03`; `KTNB-2027-01` |
| `7893001` | Mã dự án cấp trên của `DA-PMDT105` (`7893001..7893010`) | PRJ-21 | PRJ-01 (cột "Mã dự án cấp trên"), PRJ-03, PRJ-21; điều kiện để công bố kế hoạch vốn (CAP-10) và để bắt đầu thực hiện |
| `DPM-KHDT-QLDA`, `PM-KHO-CANG` | Đơn vị chủ đầu tư; khu vực đầu tư | ADM-01, MDM-25/32 (hồi 0) | PRJ-02, PRJ-01, PRJ-03; DIR-01 (đơn vị nhận chỉ đạo); HOME-09 (bảng theo đơn vị) |
| `VCSH`, `VAY` (quỹ `NSDP-DTPT`, `ODA-ONLEND`) | Vốn chủ sở hữu 745 tỷ; vốn vay 813 tỷ | CAP-16 (hồi 2) | CAP-04, 05, 03, 06; DIS-27/28 (lô theo nhóm vốn); HOME-07; CAP-17 (AVC-DPM-02) |
| `KHV-2026` (bản 1, bản 2) | Kế hoạch vốn năm 2026, 20 dòng, 1.534 tỷ | CAP-03/10 (hồi 2) | CAP-03, 06, 07, 10, 12, 15, 17, 18, 19, 20, 21, 23; PRJ-14 (sự kiện chuyển "Đã bố trí vốn"); DIS-28 (mẫu số của tỷ lệ); HOME-09; PAY (dòng vốn của đề nghị thanh toán); AUD `KTNB-2026-05` |
| `PMDT105-XL01` | Gói thầu xây lắp của `DA-PMDT105`, 70,329 tỷ | BID-16/15 (hồi 3) | BID-15, 03, 04, 05, 17, 29; CTR-02 (soạn hợp đồng); EQP-02 (gói có đuôi `-TBnn`) |
| Nhà thầu Nam Việt (mã số thuế) | Nhà thầu trúng `XL01` của hai dự án | BID-01/02 | BID-01, 05, 18; VND-01; CTR-03, 23, 25 (bảng điểm 2026-Q3); `DNTT` |
| `HD-PMDT105-XL01` | Hợp đồng, 70.329.000.000 đồng | CTR-02/03 (hồi 4) | CTR-01, 03, 04, 05, 06, 07, 08, 09, 10, 12, 13, 19, 20, 21, 23, 25, 26, 27, 32, 33; QMS-01, 04, 05, 06, 07, 11; ISS-01 (I01, I09); PAY-01, PAY-07 (`DNTT-PMDT105-XL01-TU/-09/-10`); CAP-18, 21, 22; AUD `KTNB-2026-01`; ADM-11 |
| `TB26-01..09` | 9 dòng mua sắm thiết bị | EQP-01 (hồi 4) | EQP-01, 02; BID (gói `-TB01`); CTR (hợp đồng `HD-...-TB01`) |
| `KL-<gói>-T09/T10/T11`, `NT-001..`, `BBNT-...` | Hồ sơ đo khối lượng, nghiệm thu, biên bản nghiệm thu | CTR-10/12 (hồi 5) | CTR-10, 12, 13; DIS-13 (kỳ `M2026-09/10/11`) |
| `DNTT-<gói>-TU/-09/-10`, `BLTU-<gói>`, `NH-<gói>-09` | Đề nghị thanh toán; bảo lãnh tạm ứng; xác nhận ngân hàng | PAY (hồi 6) ‹chưa xác minh› | PAY-01, 04, 07; CTR-06, 13, 21; CAP-21, 22 |
| `VM-2026-0000nn` ‹chưa xác minh› | Vướng mắc | ISS-02 (hồi 7) | ISS-01, 03, 04, 06, 07, 08, 10, 11; HOME-02 và HOME-09 ("Cần xử lý ngay"); Flutter Thông báo |
| `CE-001`, `PCO-001`, `CO-001` | Sự kiện thay đổi, thay đổi dự kiến, thay đổi được duyệt | CTR-07/19 (hồi 7) | CTR-07, 19, 08, 20, 26, 27; PRJ-22; CAP-21 |
| `CLM-001` | Claim | CTR-32 (hồi 7) | CTR-32, 33, 34; CTR-19 (liên kết CO) |
| `ENT-M2026-10` / `2026-M10` / `snapshot_ref` | Kỳ giải ngân doanh nghiệp / kỳ của bộ máy báo cáo / mã + phiên bản bản chốt | DIS-14/32/33 (hồi 8) | DIS-14, 27, 28, 29, 32, 33; HOME-09, 07, 10; BAN-01; RPT-01, 02, 03; HPM-01; `/m/dashboard` |
| `W2026-46`, `M2026-11` | Tuần và tháng của báo cáo giải ngân | DIS-01/13 (hồi 8) | DIS-01, 07, 11, 13, 15; `/m/approvals`; ADM-18; HOME-03 (cảnh báo báo cáo chậm) |
| `GB-2026-001/CD-01` | Chỉ đạo giao ban quá hạn gắn `DA-PMDT105` | DIR-01 (hồi 9) | DIR-01, 03, 04, 05; HOME-02; `/m/directives`; Flutter Trang chủ và Thông báo |
| `EW-DN-01..03` | Quy tắc cảnh báo sớm (theo dõi, cần xử lý, khẩn) | DIS-20 (hồi 9) | HOME-03, 06, 02, 13; NOT |
| `PVN-MONTHLY 2026-M05`, `XR-02` | Bản nháp báo cáo và số lệch chặn phát hành | RPT-01 / DIS-22 (hồi 8) | RPT-02, 09; DIS-22, 33 (bản sửa 2 của kỳ `ENT-M2026-05`); AUD `KN-02` |
| `HPM-MONTHLY 2026-M10` | Khóa đẩy HPM | HPM-01 (hồi 8) | RPT-01, 02, 03; HPM-01, 02 |
| `KTNB-2026-01`, `KTR-DKVN-2026-03` | Cuộc kiểm toán nội bộ; cuộc kiểm tra của Tập đoàn | AUD-02 (hồi 10) | AUD-01 đến AUD-10; DOC; `DA-PMDT105/114/120`, `HD-PMDT105-XL01`, `HD-PMDT105-TV01`, `HD-PMTB164-TB01`, `HD-PMTB168-TB01` |
| `BBBG-PMTB164-01`, `TS-PMTB164-01/02`, `BH-PMTB164-01..03` | Biên bản bàn giao, tài sản, yêu cầu bảo hành | AST-01 (hồi 10) | AST-01 đến AST-05; PRJ-11 |

### 4.2 Số quyết định và văn bản: dùng để cho khách thấy "mọi bước đều có căn cứ"

| Số văn bản | Nội dung | Dùng ở |
|---|---|---|
| `41/QĐ-HĐTV` (14/04/2026) | Phân cấp ủy quyền ký văn bản | ADM-15, ADM-04; chuỗi ký hợp đồng CTR-03 |
| `88/QĐ-HĐTV` (12/08/2026) | Công bố danh mục khu vực đầu tư | MDM-25/32, PRJ-02/03 |
| `91/QĐ-HĐTV`, `92/QĐ-HĐTV` (12/2025) | Giao kế hoạch vốn chủ sở hữu và vốn vay năm 2026 | CAP-16, CAP-05 |
| `95/QĐ-HĐTV` (12/01/2026) | Giao kế hoạch vốn đầu tư năm 2026 (công bố `KHV-2026`) | CAP-10, CAP-03 |
| `58/QD-DPM` (08/11/2026) | Điều chỉnh kế hoạch vốn 2026 (bản 2) | CAP-07 |
| `81, 82, 83/QĐ-HĐTV` | Kế hoạch vốn năm 2025 (`KHV-2025`) | CAP-03 (chọn năm 2025) |
| `61, 62, 63/QĐ-HĐTV` | Kế hoạch vốn năm 2024 (`KHV-2024`) | CAP-03, CAP-11 |
| `131, 132, 133/QĐ-HĐTV` | Nguồn vốn 2027-2030; kế hoạch trung hạn | CAP-04/05, CAP-01 |
| `NNN/TTr-BQLDA`, `NNN/TB-HĐTĐ`, `NNN/QĐ-HĐTV` (số NNN = số trong mã dự án) | Tờ trình, thông báo thẩm định, quyết định đầu tư/khởi công | PRJ-09, 15, 10, 14, DOC |
| `176/QĐ-HĐTV` | Danh mục loại vướng mắc và nhóm rủi ro | ISS-09, PRJ-16 |
| `178, 179/QĐ-HĐTV` | Tổ công tác `TCT-2026-01`, `TCT-2026-02` | PRJ-18 |
| `198/QĐ-HĐTV`; `205/QĐ-HĐTV` | Tạm dừng `DA-PMDT904`; kéo dài thời gian `DA-PMTB172` | PRJ-01/03; PRJ-06 |
| `QD-DP-PMDT105/2026` | Quỹ dự phòng `DA-PMDT105` 3,7 tỷ | PRJ-22, CTR-19 |
| `152/QĐ-HĐTV` | Công bố bảng điều hành BI | BI-01 |
| `311/QĐ-HĐTV`; `892/QĐ-DKVN`; `07/BC-KTNB`; `58/KL-KTGS` | Quyết định kiểm toán nội bộ; quyết định kiểm tra của Tập đoàn; báo cáo kiểm toán; kết luận kiểm tra | AUD-02, 03 |

---

## 5. Nếu khán giả hỏi: câu trả lời thật thà

1. **"Đây có phải số liệu thật của Đạm Phú Mỹ không?"** Không. Toàn bộ là dữ liệu minh họa do đội phát triển dựng để cho thấy luồng nghiệp vụ. Tên đơn vị, mã dự án, số tiền được đặt cho giống thực tế; khi triển khai, số liệu thật được nạp hoặc nhập vào.
2. **"Biểu mẫu báo cáo gửi PVN/HPM là mẫu chính thức?"** Chưa. Sáu biểu mẫu là MẪU DEMO (nhãn "MẪU DEMO - chờ mẫu chính thức"), bố cục chưa phải mẫu của Tập đoàn, nên không bao giờ được tính là "đã được chấp nhận chính thức". Khi khách bàn giao mẫu chính thức, thay vào gói biểu mẫu là xong.
3. **"Đã nối được HPM và Oracle EBS thật chưa?"** Chưa; đây là mục PENDING-EXTERNAL. Hiện là bộ nối dựa trên tệp (ghi tệp cho HPM, đọc tệp xuất từ EBS) vì chưa có đặc tả giao diện và tệp mẫu thật. Demo cho thấy đúng luồng nghiệp vụ (khóa chống đẩy trùng, từ chối phiên bản cũ, đối chiếu theo mã dự án, giải trình chênh lệch); định dạng tệp là giả định tạm. Không có trạng thái "HPM đã nhận" vì mẫu DEMO bị chặn ghi nhận đã nhận.
4. **"Còn e-GP, Kho bạc?"** Là các chức năng của bản công khai (quản lý đầu tư công): e-GP không có trong dữ liệu doanh nghiệp. Màn thanh toán còn mang nhãn "Kho bạc" vì kế thừa; ở doanh nghiệp, chứng từ ghi "Ngân hàng thương mại đối tác".
5. **"Sao còn chữ 'ngân sách địa phương', 'Ủy ban nhân dân', 'Cao Bằng', 'Vốn ODA vay lại'?"** Đó là nhãn danh mục nền kế thừa từ bản công khai (ví dụ tên nguồn vốn `NSDP-DTPT`, danh mục địa bàn, một chuỗi ở ADM-15). Phần lớn là dữ liệu danh mục, đổi bằng cách công bố danh mục mới có phiên bản, không phải viết lại chương trình; một số nhãn cố định trong màn thanh toán cần chỉnh trong sản phẩm. Trên màn đã chọn, người dùng thấy "vốn chủ sở hữu" và "vốn vay".
6. **"Có làm lại được phần giải trình số lệch (RPT-09) hoặc đẩy HPM không?"** Mỗi lần giải trình hay đẩy là MỘT lần dùng: số lệch đã giải trình thì hết, bản đã đẩy thì bị chặn đẩy trùng. Muốn diễn lại phải nạp lại dữ liệu mẫu. Đây là đúng tính chất "không sửa im lặng".
7. **"Nhà thầu có vào hệ thống được không?"** Thiết kế có cổng nhà thầu, nhưng bản demo không có tài khoản nhà thầu nên các nhật ký công trường ở trạng thái nháp (chữ ký nhà thầu chưa có) và phần trả lời làm rõ của nhà thầu không trình diễn được.
8. **"Phạt chậm tiến độ, bồi hoàn xử lý ở đâu?"** Qua claim của hợp đồng (CTR-32/33/34, ví dụ phạt 132,3 triệu cho `HD-PMTB164-TB01`). Màn CTR-14 hiện chỉ làm "điều chỉnh hồi tố"; quy tắc phạt tự động chưa được ban hành trong sản phẩm.
9. **"Duyệt nhiều cấp (đơn vị, rồi Ban KHĐT, rồi chốt kỳ) có không?"** Cơ chế đã có trong mã (bước đơn vị, bước Ban KHĐT, bước chốt kỳ, bước đẩy) nhưng bản demo chỉ nạp quy trình một bước "Chấp nhận". Quy trình là dữ liệu cấu hình nên thiết lập theo đúng quy định của Đạm Phú Mỹ khi triển khai.
10. **"Nhập số liệu vốn bằng Excel được không?"** Với lô vốn chủ sở hữu/vốn vay thì chưa có nhập Excel; hiện nhập trên màn lô số liệu (DIS-28). Nhập Excel hiện chỉ có cho báo cáo tuần.
11. **"Sao con số giải ngân ở màn này khác màn kia?"** Trong bản demo có bốn chuỗi minh họa độc lập (bản chốt kỳ, báo cáo tuần theo hợp đồng, sao kê ngân hàng, tệp EBS), mỗi chuỗi do một đường nhập riêng và chưa được dựng để khớp nhau. Dashboard của lãnh đạo CHỈ đọc bản chốt. Khi triển khai, các nguồn được đối chiếu qua màn đối chiếu EBS và kiểm tổng chéo.
12. **"Có ứng dụng cho iPhone không?"** Ứng dụng Flutter hiện chạy trên Android; bản iOS cần dựng trên máy Mac. iPhone dùng bản web (PWA `/m`) qua trình duyệt; cài PWA lên màn hình chỉ làm được khi trang chạy HTTPS và là bản phát hành (bản demo là bản phát triển nên thẻ cài đặt báo "Chỉ cài đặt được khi trang chạy qua HTTPS").
13. **"Dữ liệu lưu ở đâu, tắt máy có mất không?"** Máy demo dùng cơ sở dữ liệu nhúng, tắt là xóa và mỗi lần chạy nạp lại dữ liệu mẫu (cùng hạt giống nên cùng số liệu). Bản triển khai dùng cơ sở dữ liệu bền vững.
14. **"Đăng nhập, bảo mật thế nào?"** Demo dùng "phiên phát triển" `?devUser=` (không mật khẩu) chỉ để trình diễn các vai. Bản triển khai dùng đăng nhập SSO chuẩn (OIDC) và xác thực hai yếu tố cho quyết định duyệt. Quyền thật nằm ở máy chủ: bấm sai vai bị từ chối.
15. **"Dự án đã quyết toán và đóng ở đâu?"** Demo có dự án hoàn thành (`DA-PMTB905` quyết toán đã gửi, `DA-PMTB906` quyết toán đã đóng) nhưng chưa có dự án ở trạng thái "Đã quyết toán/Đã đóng": bước chuyển giai đoạn cuối chưa nối vào sản phẩm.
16. **"Các ngưỡng, tỷ lệ (5% giữ lại, 20% tạm ứng, SLA...) có đúng quy định của DPM không?"** Là giá trị mặc định chưa kiểm chứng với quy chế của Đạm Phú Mỹ; chúng cấu hình được, sẽ chốt cùng khách khi triển khai.

17. **"Có AI không, AI đọc dữ liệu của chúng tôi không?"** Có trợ lý AI (LLM-22) trả lời bằng mô hình Claude thật, nhưng chỉ dữ liệu phân loại CÔNG KHAI được gửi ra ngoài; hồ sơ dự án và hợp đồng bị chặn bởi quy tắc phân loại dữ liệu. Phân tích AI ở BID-06 đến BID-13 chưa có dữ liệu mẫu. AI không bao giờ là căn cứ quyết định.
18. **"Chiếu điện thoại thế nào, sao tab Phê duyệt đen?"** App Android được chiếu qua cáp USB-C bằng scrcpy; ứng dụng đặt cờ bảo mật nên riêng tab Phê duyệt bị đen khi chiếu. Muốn cho khách xem phê duyệt thì mở `/m/approvals` trên web.

---

## 6. Lộ trình trình diễn

Khi chỉ có `owner` trên máy chiếu, đổi vai bằng cách sửa `devUser` trên thanh địa chỉ rồi Enter (trước khi đổi, ghi nhớ màn đang mở).

### 6.1 Bản 10 phút: đi theo `DA-PMDT105` qua tám điểm dừng

| Phút | Điểm dừng | Địa chỉ | Người | Một câu |
|---|---|---|---|---|
| 0:00 | HOME-09 (kết quả cuối) | `/home/home-09?devUser=owner` | `owner` | "60,54% so với kế hoạch năm, cùng kỳ năm trước 46,83%. Ta đi ngược lại xem con số này sinh ra thế nào." |
| 0:45 | PRJ-14 rồi PRJ-03 | `/prj/prj-14?devUser=projectManager` | `projectManager` | "18 dự án, mỗi cái một giai đoạn; bấm DA-PMDT105." |
| 1:45 | CAP-03 (chọn `KHV-2026`) | `/cap/cap-03?devUser=owner` | `owner` | "Vốn: 1.534 tỷ, chia hai nguồn; đây là dòng của dự án." |
| 2:45 | BID-03 rồi CTR-03 | `/bid/bid-03?devUser=projectManager`, `/ctr/ctr-01?devUser=projectManager` | `projectManager` | "Gói PMDT105-XL01 thành hợp đồng HD-PMDT105-XL01, 70,3 tỷ." |
| 3:45 | CTR-12 | `/ctr/ctr-12?devUser=owner` | `owner` | "Khối lượng được nghiệm thu từng tháng; người duyệt khác người lập." |
| 4:45 | ISS-01 rồi ISS-03 (I04) | `/iss/iss-01?devUser=projectManager` | `projectManager` | "Bê tông móng không đạt: vướng mắc có hạn, có leo thang, có người đóng độc lập." |
| 5:45 | DIS-33 | `/dis/dis-32?devUser=projectManager` rồi bấm sang bản chốt | `owner` | "Kỳ được khóa, dựng bản chốt có mã băm; đây là nguồn duy nhất." |
| 6:45 | RPT-02 và HPM-01 | `/rpt/rpt-02?devUser=docHead`, `/hpm/hpm-01?devUser=owner` | `docHead`, `owner` | "Báo cáo gửi Tập đoàn lập từ chính bản chốt này; ba người ký; đẩy HPM có khóa chống trùng." |
| 8:00 | Điện thoại `/m/approvals` hoặc Flutter | `/m/approvals?devUser=owner` | `owner` | "Lãnh đạo duyệt báo cáo tuần ngay trên điện thoại." |
| 9:00 | ADM-11 | `/adm/adm-11?devUser=owner` | `owner` | "Mọi bước ban nãy đều có vết, không sửa được." |

### 6.2 Bản 25 phút: theo thứ tự hồi

| Phút | Hồi | Màn chính | Ghi chú |
|---|---|---|---|
| 0:00 | Mở đầu | HOME-09 | Nói "dữ liệu minh họa" và "mẫu demo" (câu hỏi 1, 2) |
| 1:30 | 0 | ADM-01, MDM-25 (bỏ qua nếu thiếu giờ) | 1 phút |
| 2:30 | 1 | PRJ-14, PRJ-01, PRJ-03, PRJ-07 | 2,5 phút |
| 5:00 | 2 | CAP-16, CAP-03, CAP-07, CAP-12 | 3 phút |
| 8:00 | 3 và 4 | BID-15, BID-03, BID-18; CTR-01, CTR-03, CTR-04, EQP-01 | 3,5 phút |
| 11:30 | 5 | QMS-06 hoặc QMS-07, CTR-10, CTR-12 | 2 phút |
| 13:30 | 6 | PAY-01, CTR-13 | 1,5 phút |
| 15:00 | 7 | ISS-01, ISS-03, CTR-19, CTR-26, CTR-33 | 3 phút |
| 18:00 | 8 | DIS-15, DIS-33, RPT-02, HPM-01, EBS-02 | 4 phút |
| 22:00 | 9 | HOME-09 (đã mở), HOME-03, DIR-03, `/m/approvals` | 2,5 phút |
| 24:30 | 10 và 11 | AUD-01, AST-01, ADM-11 | cắt còn 30 giây mỗi cái nếu thiếu giờ |

### 6.3 Bản 60 phút: đầy đủ, có thao tác sống và hỏi đáp

| Phút | Nội dung |
|---|---|
| 0 đến 5 | Mở đầu, HOME-09, giải thích sợi chỉ đỏ `DA-PMDT105`, vai trò (mục 2) |
| 5 đến 10 | Hồi 0 và 1 (có PRJ-15 chấm điểm sống nếu đã chuẩn bị UUID) |
| 10 đến 18 | Hồi 2 (thêm CAP-17, CAP-18, CAP-19, CAP-20, CAP-21) |
| 18 đến 25 | Hồi 3 và 4, duyệt kết quả BID-18 sống, rồi EQP-02 đổi giai đoạn |
| 25 đến 32 | Hồi 5 và 6 (thêm QMS-04, QMS-05, CTR-06, PAY-07) |
| 32 đến 40 | Hồi 7 (ISS-07 xác nhận sống, CTR-08 duyệt CO) |
| 40 đến 48 | Hồi 8 (mục 6.4 làm RPT-09 trọn vẹn, HPM-01, EBS-02) |
| 48 đến 54 | Hồi 9 (điện thoại: duyệt một báo cáo, quay lại DIS-15) |
| 54 đến 58 | Hồi 10 và 11 |
| 58 đến 60 | Kết buổi, hỏi đáp (mục 5) |

### 6.4 Kịch bản RPT-09 và HPM (làm một lần, mất 4 đến 5 phút)

Chỉ thực hiện ở bản 60 phút hoặc khi khách muốn thấy sống. Làm tuần tự và KHÔNG làm thử trước trên máy demo thật.

1. `docHead` mở `/rpt/rpt-02?devUser=docHead`, dòng `PVN-MONTHLY` kỳ `2026-M05` (trạng thái "Đã kiểm tra"), bấm "Mở bản nháp".
2. Bấm "Xem so sánh chéo với các báo cáo cùng kỳ": thấy số lệch XR-02 "Báo cáo bằng bản chốt kỳ", mức "Chặn phát hành", chỉ tiêu `ENT_DISBURSED_SINCE_START`, "Số kỳ vọng" so với "Số thực tế", chênh 2 tỷ, công thức và nguồn (báo cáo lập từ bản chốt bản sửa 1, bản chốt kỳ nay là bản sửa 2).
3. Quay lại bản nháp, bấm "Phê duyệt" rồi "Phát hành bản này": hệ thống TỪ CHỐI ("Bản nháp này chưa phát hành được: còn 1 số lệch mức chặn chưa có giải trình").
4. Mở `/rpt/rpt-09?devUser=docHead&kind=MONTH&year=2026&index=5`, ghi lý do từ 20 ký tự, bấm "Ghi giải trình" (người giải trình là `docHead`, không lập báo cáo nào trong kỳ).
5. Quay lại bản nháp, bấm "Phát hành bản này": thành công, có mã băm.
6. Mở `/hpm/hpm-01?devUser=owner` để cho xem: "chờ biên nhận" (2026-M10), "HPM từ chối" (2026-M09), và nhắc khóa chống đẩy trùng.

Nói: "Số lệch bị chặn đến khi có người KHÁC người lập giải trình, và giải trình chỉ có giá trị với đúng các số đó."

### 6.5 Các thao tác "làm sống" (mỗi thao tác chỉ làm được một lần)

| Việc | Màn | Người | Hậu quả nhìn thấy | Làm trước 14:30? |
|---|---|---|---|---|
| Duyệt kết quả gói `PMDT105-TB01` | BID-18 | `capApprover` | Gói trúng thầu; `TB26-03` ở EQP-02 đổi giai đoạn | Không; chỉ thử khi chắc chắn mã văn bản |
| Chấm điểm `DA-PMDT902` rồi quyết định | PRJ-15, PRJ-10 | `owner`, `capApprover` | Dự án chuyển giai đoạn thẩm định | Không; cần UUID văn bản |
| Xác nhận và đóng vướng mắc I04 | ISS-07 | `owner` | I04 đóng, ma trận ISS-08 đổi | Không |
| Quyết định nghiệm thu tháng 11 | CTR-12 | `owner` | Giá trị đã nghiệm thu tăng; có thể bị chặn bởi phiếu không phù hợp nghiêm trọng | Thử đọc lỗi chặn, không bấm duyệt |
| Duyệt `PCO-001` của `HD-PMDT114-XL01` | CTR-08 | `capApprover` | Sinh phiên bản hợp đồng mới ở CTR-26 | Không |
| Giải trình XR-02 và phát hành | RPT-09, RPT-02 | `docHead` | Số lệch hết, báo cáo phát hành | Tuyệt đối không |
| Duyệt báo cáo tuần trên điện thoại | `/m/approvals` | `owner` | Báo cáo thành "Đã chấp nhận"; DIS-15 đổi; việc của lãnh đạo kia hủy | Không |

---

## 7. Danh sách kiểm trước giờ demo

**Khởi động (xong trước 14:00, không khởi động lại sau 14:30)**

- [ ] Chạy `npm run demo:enterprise` trong thư mục mã nguồn. Lệnh kiểm tra Node, các cổng **5173** (web), **47311** (API), **47312** (đăng nhập thử) còn trống, khởi động cơ sở dữ liệu nhúng và API, nạp dữ liệu mẫu, khởi động web, rồi in khung "SAN SANG". Nạp dữ liệu mất vài phút đến hơn chục phút với các nhóm mới ‹chưa xác minh›.
- [ ] GIỮ cửa sổ dòng lệnh mở suốt buổi. Ctrl+C là dừng và XÓA toàn bộ dữ liệu.
- [ ] Máy trình diễn: đóng bớt ứng dụng nặng (cần khoảng 8 GB RAM trống); cắm điện; tắt chế độ ngủ.
- [ ] KHÔNG chạy `clip-seed.mjs apply` hay khởi động `demo:enterprise` lần hai trên các cổng demo.

**Kiểm số (mục B Phụ lục): mở đúng các màn có dấu ‹chưa xác minh› và sửa tài liệu này nếu số khác.**

- [ ] HOME-09: 60,54%, cùng kỳ 46,83%, +13,71 điểm. HOME-07: vốn chủ sở hữu 733 tỷ, vốn vay 801 tỷ.
- [ ] PRJ-01 có 18 dự án; PRJ-14 phân bố 1/1/2/4/6/1/2 (Bị từ chối 1).
- [ ] CTR-01 có 8 hợp đồng ACTIVE; ISS-01 có 11 vướng mắc (không có bản trùng "-v2/-v3"); QMS-07 có 4 phiếu không phù hợp (không có phiếu tiêu đề tiếng Anh).
- [ ] BI-01: hai bảng đã công bố hay chưa. Nếu chưa, bỏ bước 9.9.

**Đăng nhập và làm nóng**

- [ ] Mở mỗi màn trong lộ trình sẽ dùng một lần bằng đúng `devUser` (lần đầu Vite biên dịch hơi chậm).
- [ ] Chrome toàn màn hình, Ctrl và dấu trừ để thu chữ; ghi nhớ cách đổi vai bằng thanh địa chỉ.
- [ ] Mở sẵn tài liệu này và danh sách số quyết định (mục 4.2) trên màn hình phụ.

**Mạng nội bộ cho iPhone/máy khác**

- [ ] Địa chỉ `https://172.20.10.5:5443` mở được và tự đăng nhập là `owner`. Nếu trình duyệt cảnh báo chứng chỉ, chọn tiếp tục ‹chưa xác minh›.
- [ ] Máy tính và điện thoại cùng mạng "iPhone của Trung"; địa chỉ 172.20.10.5 của laptop có thể đổi nếu điểm phát sóng cấp lại: kiểm bằng `ipconfig`.

**Chia sẻ qua Google Meet**: chia sẻ "A tab" (tab Chrome đang mở web) cho phần web, và "A window" (cửa sổ "MachVon - dien thoai") cho phần điện thoại. Chiếu điện thoại bằng `C:\PIS\Design\Chieu_Dien_Thoai_Android.cmd` (cáp USB-C + scrcpy); tab Phê duyệt bị đen khi chiếu, dùng web `/m/approvals`.

**Điện thoại Android Sharp SH-M19 với ứng dụng Flutter** (chi tiết `C:\PIS\Design\Huong_Dan_Chay_App_Flutter_Demo.md`, tóm tắt ở Phụ lục A)

- [ ] Gỡ lỗi USB bật; `adb devices -l` thấy serial `356660110224186` ở trạng thái "device".
- [ ] Phương án USB (khuyến nghị): cài `C:\PIS\Design\MachVon_DPM_debug.apk`, chạy lại hai lệnh `adb reverse tcp:47311 tcp:47311` và `tcp:47312 tcp:47312`; GIỮ cáp suốt buổi (rút cắm là mất reverse).
- [ ] Phương án Wi-Fi: cài `MachVon_DPM_debug_LAN.apk`, hai bộ chuyển tiếp LAN 172.20.10.5:47311 và :47312 phải đang chạy.
- [ ] Đăng nhập thử một lần: SSO, đơn vị "Đạm Phú Mỹ", "Xác thực trong trình duyệt"; vào là `owner`; chọn Tiếng Việt ở tab Cá nhân.
- [ ] Bật "Giữ màn hình sáng"; tab Phê duyệt bị đen khi chiếu/ghi hình, thao tác trực tiếp.

**Ngay trước khi vào phòng**

- [ ] Mở màn đầu tiên (HOME-09) sẵn trên máy chiếu; đóng thông báo, tin nhắn, các tab không liên quan.
- [ ] In hoặc mở sẵn mục 8 (những điều KHÔNG bấm).

---

## 8. Những điều KHÔNG bấm / KHÔNG đặt cạnh nhau

### 8.1 Màn trống hoặc giới hạn (đúng thiết kế, nhưng lộ ra sẽ mất thời gian giải thích)

| Màn / hành động | Vì sao | Thay bằng |
|---|---|---|
| PRJ-03: các tab Mục tiêu, Kế hoạch, Giải ngân, Vướng mắc | Bản cuối đã hoạt động nhưng chưa đọc kỹ nội dung | Mở thử trước giờ; nếu trống thì ở lại tab Tổng quan |
| PRJ-06: dòng "Lần 1 hồ sơ ban đầu" | Hiện dạng khóa kỹ thuật | Dòng đề nghị `DA-PMDT130` |
| PRJ-17: cột "Văn bản phân công" | Hiện chuỗi mã | Chỉ chỉ vào cột "Lãnh đạo phụ trách" |
| PRJ-03: ô cập nhật địa bàn | Danh sách địa bàn còn "Cao Bằng" (dữ liệu nền cũ) | Không mở ô này |
| PRJ-13 theo dõi tháng | Đọc báo cáo tháng ở DIS, có thể trống | DIS-13 |
| PRJ-10 / PRJ-15 / DIR-04 / EQP-02 / HOME-06 / CTR-23 mở thẳng | Tự chọn mục đầu tiên (có ghi chú) | Mở từ danh sách |
| ISS-03, ISS-04, ISS-07, AUD-03..10, CTR-03, CTR-33 gõ tay `?id=` | Cần mã nội bộ | Bấm từ danh sách |
| ISS-06, ISS-08: chọn tuần trước | Chỉ có tuần `2026-W46` | Giữ tuần hiện hành |
| DIS-01, DIS-13: các tuần/tháng cũ (`W2026-39..45`, tháng 9, 10) | Trống (kế hoạch vốn mới công bố hôm nay) | `W2026-46`, `M2026-11` |
| CAP-14; ô số trên đầu CAP-23 | Trống theo thiết kế | CAP-19 |
| CAP-22 mở thẳng từ menu | Chỉ hiện hướng dẫn | Mở từ hợp đồng (`?contract=`) |
| CAP-03/06/07/10 mở thẳng | Mặc định chọn kế hoạch trung hạn `KHV-TH-2027-2030` | Chọn `KHV-2026` trong ô "Kế hoạch" |
| PMT-04 (quy tắc chặn mốc) | Không có quy tắc; PMT-06 chỉ có 1 miễn giấy phép | PMT-01, PMT-05 |
| LND (giải phóng mặt bằng), MNE (giám sát đánh giá) | Không có dữ liệu; hợp với đường công cộng | Không mở |
| BID-06 đến BID-13 (OCR, phân tích AI, làm rõ, thẩm tra) | Không có dữ liệu; cần mô hình AI | BID-03, BID-15, BID-18 |
| CTR-14 | Chỉ "điều chỉnh hồi tố", không có phạt | CTR-32/33 |
| QMS-09, QMS-10 | Chỉ trên ứng dụng điện thoại | Không có |
| PAY-05 "Giao dịch chờ ghép" | Hiện sao kê `KB-...` không liên quan các đề nghị | PAY-01, PAY-07 |
| HOME-09: thẻ "Xếp hạng giải ngân theo đơn vị" ở cuối | "Chưa có dữ liệu" (thẻ kiểu Kho bạc) | Bảng "Tỷ lệ giải ngân theo đơn vị" ở khung doanh nghiệp |
| RML-01 (gửi email theo lịch), HPM-02 | Trống; HPM-02 chưa có đề nghị đính chính | Bỏ qua, hoặc nói "đúng là chưa có" |
| AUD-10 "Báo cáo kết quả" ban hành | Chỉ tới "đã yêu cầu, chờ ban hành" (không có bộ soạn văn bản) | Nói rõ trạng thái |
| `/m/notifications` | Là màn cài đặt thông báo đẩy, KHÔNG phải hộp thư | `/m/approvals` |
| NOT-01 chuông: tiêu đề từng thông báo | Hiện chung "Thông báo mới" (chuỗi dịch chưa đủ) | NOT-06 (luồng) |
| `/pwa/pwa-01..10` và ô "Ứng dụng cài đặt cho lãnh đạo" trong thư viện | Màn chưa đăng ký | `/m` |
| SAS, LLM, INT, DGV, IND, IAM-04 | Quản trị nền tảng/AI/tích hợp, trống hoặc không có quyền | Không mở |
| QMS-06: kết quả "không đạt" | Cố ý không tạo (nếu có, sẽ sinh phiếu tiêu đề tiếng Anh) | Chỉ xem bản có sẵn |

### 8.2 Chữ còn mang sắc thái bản công khai (đừng đọc to, đừng chiếu lâu)

- MDM-04 và MDM-09: nhãn "Ủy ban nhân dân", nguồn vốn `NSDP-DTPT` tên "Vốn đầu tư phát triển ngân sách địa phương", `ODA-ONLEND` tên "Vốn ODA vay lại". Dùng CAP-16 và HOME-07 (đã hiện "vốn chủ sở hữu/vốn vay").
- MDM-02 / MDM-25: có thể còn 3 phường Cao Bằng (Thục Phán, Nùng Trí Cao, Tân Giang) cạnh 3 khu vực Phú Mỹ ‹chưa xác minh›; chỉ chỉ vào 3 khu vực `PM-*`.
- ADM-04, ADM-15: dòng "căn cứ" còn chuỗi `QD-UBND-QUY-CHE-UY-QUYEN-2026`; chỉ chỉ vào bảng quy tắc.
- DOC-12: văn bản `41/QĐ-HĐTV` và 6 quyết định khởi công `NNN/QĐ-HĐTV` có thể còn người gửi "Ủy ban nhân dân tỉnh Cao Bằng"; DOC-17: hồ sơ `HS-DT205-2026`, `HS-TH012-2026` và quyết định `129/QĐ-HĐTV` của bản tỉnh ‹chưa xác minh›. Nếu mở sổ văn bản, lọc đúng văn bản cần chứ đừng cuộn.
- Màn PAY: "Đã gửi Kho bạc", "Theo dõi gửi Kho bạc", 4 biểu mẫu tên đuôi `/TT`.
- CAP-12: cấp ngân sách "Trung ương" ‹chưa xác minh›.
- Thư viện ứng dụng: ô "Bảng điều hành Ban chỉ đạo" (mô tả "toàn tỉnh"), "Số liệu từ Sở Tài chính", "Tài khoản & hỗ trợ". BAN-01 có thể còn lời công khai: kiểm trước khi dùng ‹chưa xác minh›.
- Văn bản `58/QD-DPM` viết "QD" không dấu và người gửi khác ba quyết định `QĐ-HĐTV`: không đọc to dòng này.

### 8.3 Những cặp số KHÔNG đặt cạnh nhau (dữ liệu minh họa chưa khớp)

| Cặp | Lệch gì | Cách nói |
|---|---|---|
| CAP-03/07 với HOME-09 / DIS-33 cho `DA-PMDT105`, `DA-PMDT114` | Kế hoạch bản 2 (319 và 172 tỷ) so với bản chốt dựng trên bản 1 (339 và 152 tỷ). Tổng công ty vẫn 1.534 tỷ, lệch 20 tỷ giữa hai dự án | Chỉ nói tổng công ty khi chuyển giữa hai màn này |
| Bốn chuỗi giải ngân: bản chốt (DA-PMDT130: 200,369 tỷ), sao kê ngân hàng (181,26 tỷ), tệp EBS (36,3 tỷ tháng 8), báo cáo tuần (33,0 tỷ) | Bốn đường nhập độc lập | Không mở cùng lúc; xem câu hỏi 11 |
| Nội dung công văn/báo cáo DOC với HOME-09 | Văn bản nói "tỷ lệ giải ngân 61,4%" (đầu tư 58%, mua sắm 66%), số tiền "640.000 triệu" cho dự án amoniac, "120.000 triệu" cho máy nén khí | Không mở nội dung công văn cạnh HOME-09 |
| Tên thiết bị `TB26-02..06` với tên dự án | Gắn theo thứ tự mã gói | Chỉ kể `TB26-01` |
| Ngày ký `HD-PMTB164/168-TB01` (16/09) với ngày trao thầu `PMTB164-TB01` (23/09) | Ký trước trao thầu (kiểm toán `TB-01` khai thác chính điểm này) | Chỉ kể ở hồi 10 |
| Ngày công bố `KHV-2026` (12/01/2026) với ngày thẩm định dự án (09 và 10/2026) | Mốc thời gian sinh theo "lùi từ hôm nay" | Không so ngày giữa hồi 1 và hồi 2 |
| `GB-2026-003/CD-01` nói "gói thầu thiết bị chính" nhưng gắn `DA-PMDT154` | Dự án chưa có gói thầu | Không đọc nội dung chỉ đạo này |
| Báo cáo kỳ `2026-M09` và `2026-Q3` | Không có bản chốt nên dùng dữ liệu minh họa (22 dự án "(minh họa)") | Chỉ mở báo cáo `2026-M10` |

### 8.4 Vai trò và thao tác dễ sai

- `docHead` KHÔNG vào được HPM-01 và HPM-02: dùng `owner`.
- `auditor` không vào được module kiểm toán và có thể bị từ chối ở ADM-11: dùng `owner`.
- `unitAdmin` thiếu quyền đọc ADM-01/02/03: đừng dùng để cho xem quản trị.
- `projectManager` không duyệt, không công bố, không phân công lãnh đạo (PRJ-17), không lập nghiệm thu: nếu bấm sẽ nhận lỗi 403.
- Không ai tự duyệt việc mình lập (`SELF_APPROVAL_DENIED`): khi demo thao tác sống, đổi `devUser` giữa lập và duyệt.
- Chưa thử đăng nhập `capApprover` trên ứng dụng Flutter; mặc định là `owner`.
- F5 hoặc gõ lại địa chỉ mà thiếu `?devUser=` là mất phiên.
- Mỗi thao tác sống ở mục 6.5 chỉ làm được một lần; sau 14:30 không khởi động lại để "làm lại".

---

## Phụ lục A. Điện thoại: tóm tắt thao tác

**A1. PWA trên trình duyệt (`/m`)**: mở `/m?devUser=owner` trên cổng 5173 (laptop) hoặc `https://172.20.10.5:5443/m` (iPhone). Cửa sổ laptop thu còn 390 px nếu muốn giả lập điện thoại. Không cài được lên màn hình trong bản demo (cần HTTPS và bản phát hành).

**A2. Ứng dụng Flutter trên Android Sharp SH-M19 (serial `356660110224186`)**

1. `adb devices -l` phải thấy máy ở trạng thái "device" (adb nằm ở `C:\Android\sdk\platform-tools\adb.exe`).
2. Phương án USB: `adb -s 356660110224186 reverse tcp:47311 tcp:47311` và `... tcp:47312 tcp:47312`; cài `C:\PIS\Design\MachVon_DPM_debug.apk` (`adb install -r`); mở ứng dụng. Nếu app báo "Không kết nối được máy chủ" thì chạy lại hai lệnh reverse.
3. Phương án Wi-Fi: gỡ reverse (`adb reverse --remove-all`), cài `MachVon_DPM_debug_LAN.apk`; cần điện thoại cùng mạng "iPhone của Trung" và hai bộ chuyển tiếp 172.20.10.5:47311/:47312 đang chạy.
4. Trong app: "Đăng nhập bằng SSO", chọn "Đạm Phú Mỹ" (đừng chọn Hà Giang hay Lào Cai), "Tiếp tục", "Xác thực trong trình duyệt". Vào là `owner` (Nguyễn Văn An). Tab "Cá nhân", mục "Ngôn ngữ", chọn "Tiếng Việt".
5. Các tab đã kiểm trên điện thoại thật: Trang chủ điều hành, Thông báo, Dự án, Cá nhân. Tab Phê duyệt mở được nhưng màn hình bị chặn chụp/chiếu.
6. Sự cố: màn trắng hoặc đăng nhập quay về đầu thì `adb -s 356660110224186 shell pm clear vn.machvon.app` rồi đăng nhập lại.

**Điều không thể**: dựng bản iOS của ứng dụng Flutter trên Windows. iPhone của người trình bày dùng bản web.

## Phụ lục B. Số đã đối chiếu trên máy demo thật (khoảng 14:10 ngày 10/11/2026)

"Khoảng" = số đổi theo đồng hồ. "‹chưa xác minh›" = chưa mở lại trên bản cuối, mở thử trước 14:30.

| Màn | Số/điều thấy trên máy thật | Ghi chú |
|---|---|---|
| PRJ-01 | 18 dự án | Đã thấy |
| PRJ-14 | Ý tưởng 1 (`DA-PMDT901`), Thẩm định 1 (`DA-PMDT902`), Ngân hàng dự án 2 (`DA-PMDT154`, `DA-PMTB204`: "Thiếu mã dự án cấp trên"), Đã bố trí vốn 4 | Các cột sau (Đang thực hiện 6, Tạm dừng 1, Hoàn thành 2) ‹chưa xác minh› |
| CAP-01 | "Số kế hoạch 6"; CAP-03 ô "Kế hoạch" có 4 mục (`KHV-2024`, `KHV-2025`, hai dòng `KHV-2026`) | 52 dòng, 2.958 tỷ ‹chưa xác minh› |
| HOME-07 | Kế hoạch vốn năm 1.534 tỷ, giải ngân lũy kế 928,75 tỷ; bản chốt ngày 10/11/2026 phiên bản 1 | HOME-09: 10 dự án, "Số liệu chốt 06/11/2026"; 60,54% / 46,83% / +13,71 ‹chưa xác minh trên bản cuối, đã khớp ở các lần chạy thử›|
| CAP-17 | 2 chính sách AVC | Mức 95,05% ‹chưa xác minh› |
| CTR-01 | 8 hợp đồng | Tổng 240,163 tỷ tính tất định |
| CTR-12, CTR-25 | Mở sẵn hợp đồng đang thực hiện có giá trị lớn nhất, có ô chọn | Giá trị nghiệm thu từng kỳ ‹chưa xác minh› |
| PAY-01 | 19 hồ sơ: 8 đợt `-10` (Đã gửi Kho bạc), 5 đợt `-09`, 6 tạm ứng (Đã thanh toán) | `DNTT-PMDT105-XL01-09` 2.145.073.429; `-10` 4.558.281.036 |
| PAY-07 | 6 khoản tạm ứng | Đã thấy |
| ISS-01 | 11 vướng mắc: Đang mở 9, Quá hạn 1, Đã leo thang 4 | Đã thấy |
| ISS-06 | Tuần 2026-W46 (09 đến 15/11) | Số phát sinh/đóng ‹chưa xác minh› |
| QMS-07 | Màn mở theo hợp đồng chọn ở ô | 4 phiếu ‹chưa xác minh› |
| PMT-01 | 4 hồ sơ pháp lý | Đã thấy |
| DIS-01 | Tuần W2026-46: "Đã gửi 8/13" (62%), hạn 10:00 13/11, còn 5 dự án chưa gửi | Đã thấy |
| DIS-13, DIS-33 | DIS-13 có ô chọn tháng/dự án (danh sách 18 dự án) | Số liệu tháng 11 và bản chốt ‹chưa xác minh› |
| DIS-14 | 76 kỳ trong năm 2026 | Đã thấy |
| RPT-01 | 9 dòng biểu mẫu, chế độ demo đang bật | Đã thấy |
| RPT-03 | 6 bản đã phát hành | Đã thấy |
| HPM-01 | Tổng 2 lần đẩy: chờ biên nhận 1, đã nhận 0, từ chối 1, lỗi 0 | Đã thấy |
| EBS-02 | 32 chênh lệch đang mở, 0 quá hạn | Đã thấy |
| HOME-03 | 7 cảnh báo đang hiển thị | Đã thấy |
| HOME-02 / thanh bên "Việc của tôi" | `owner` khoảng 25 (Khẩn 3, Cần xử lý 16, Theo dõi 6); `projectManager` khoảng 72; `capApprover` khoảng 85; `docHead` khoảng 10 | Đổi theo đồng hồ |
| HOME-09 "Cần xử lý ngay" | Khẩn 5, Cần xử lý 52, Theo dõi 16 (khoảng); chỉ đạo `GB-2026-001/CD-01` quá khoảng 19 ngày | Đổi theo đồng hồ |
| DIR-03 | 6 chỉ đạo, 2 quá hạn, 3 đang mở/đang thực hiện, 1 hoàn thành, 1 đã báo lãnh đạo đơn vị | Đã thấy |
| `/m`, `/m/approvals` | "6 việc chờ duyệt, 0 quá hạn" | Đã thấy |
| NOT-01 (owner) | 10 chưa đọc, 8 cần xử lý; huy hiệu thanh bên "3" (khoảng) | Tiêu đề hiện "Thông báo mới" |
| BI-01 | 6 dashboard: 4 đã công bố, 2 bản nháp | Đã thấy |
| BI-02 | 25 ô chỉ tiêu, kỳ mặc định W2026-45 | Theo thông báo của điều phối, chưa đếm lại |
| AUD-01 | 3 cuộc theo dõi, 9 kiến nghị mở, 0 quá hạn, 3.240.000.000 / thu hồi 900.000.000 (27,78%), đóng 2/11 | Đã thấy |
| AST-01 | 3 biên bản bàn giao | Đã thấy |
| PRJ-19 | 3 yêu cầu giải trình | Đã thấy |
| PRJ-12 | Có ô chọn dự án | Trạng thái quyết toán `DA-PMTB905/906` ‹chưa xác minh› |
| ADM-11 | 50 dòng ở trang đầu | Đã thấy |
| ADM-18 | 12 hàng ở trang đầu | Số đổi theo đồng hồ |
| CAP-21 | Trang đầu 25 bút toán | Tổng khoảng 160 ‹chưa xác minh› |
| Flutter Trang chủ | Khẩn / Cần xử lý / Theo dõi = 3 / 43 / 9 theo lần thử lúc 11:40 | ‹chưa xác minh›, số đã đổi |
