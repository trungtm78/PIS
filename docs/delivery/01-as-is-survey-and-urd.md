# 01. Báo cáo khảo sát hiện trạng (As-Is) và Tài liệu yêu cầu người dùng (URD)

Giai đoạn 1, sản phẩm 1 của mục II.5. Dòng ma trận: GD.1, SP.01. PVFCCo phê duyệt: có.

Nguồn: Hồ sơ kỹ thuật "Phần mềm quản lý đầu tư xây dựng" v0.3 (26 11 03), mục I.1 đến I.4 và II.2 đến II.3; `Design/MACHVON_Design/01_Documents/02_BRD.md`; `docs/report-engine.md` (sáu biểu mẫu do hệ thống thiết kế); `docs/ind-indicator-dictionary.md`; `docs/hpm-ebs-connectors.md`. Những gì chỉ khách biết ghi `[khách điền: ...]`.

Trạng thái tệp: KHUNG. Phần A có sẵn nội dung từ hồ sơ kỹ thuật; khảo sát tại chỗ (mục A.5) chưa thực hiện. Phần B là URD dự thảo, chờ Tổ chuẩn hóa dữ liệu xác nhận (mục PX-02, PX-05, PX-12 của sổ chờ khách).

---

## Phần A. Báo cáo khảo sát hiện trạng (As-Is)

### A.1 Mục đích và căn cứ

Ghi nhận cách PVFCCo đang quản lý số liệu và báo cáo đầu tư xây dựng (ĐTXD) và mua sắm trang thiết bị dự án, làm cơ sở cho URD và quy trình To-Be. Căn cứ (mục I.3 của hồ sơ kỹ thuật):

- Thông báo số 26-369/TB-PBHC ngày 03/02/2026 (kết luận của Phó Tổng Giám đốc tại cuộc họp xem xét tiến độ đầu tư tháng 01/2026);
- Tờ trình số 08/TTr-KHĐT ngày 05/03/2026; Quyết định số 26-681/QĐ-PBHC ngày 16/03/2026 thành lập Tổ chuẩn hóa dữ liệu dự án; Quyết định số 26-3928/QĐ-PBHC ngày 26/10/2026 kiện toàn nhân sự Tổ;
- Biên bản họp số 43/BBH-KHĐT ngày 12/10/2026;
- Kế hoạch mua sắm của Ban KHĐT tại Quyết định số 26-61/QĐ-PBHC ngày 08/01/2026 (hạng mục PM chuẩn hóa dữ liệu, mục 9 của BM.02 thuộc QĐ61);
- Công văn của Ban KHĐT ngày 29/10/2026 về kết quả rà soát hiện trạng báo cáo và kiến nghị chuẩn hóa bộ dữ liệu nền.

### A.2 Phạm vi khảo sát

Chín đầu mối nhập liệu số liệu đầu tư theo kết quả rà soát của Tổ chuẩn hóa dữ liệu: 07 Ban/Đơn vị và 02 Tổ dự án. Hồ sơ kỹ thuật (mục II.2.1) nêu các đơn vị tham gia sau; việc đơn vị nào là một trong 07 đầu mối nhập liệu chưa được hồ sơ chỉ rõ.

| STT | Đơn vị | Vai trò theo hồ sơ kỹ thuật | Là đầu mối nhập liệu |
|---|---|---|---|
| 1 | Ban Kế hoạch và Đầu tư (Ban KHĐT) | Đơn vị đầu mối tổng hợp, rà soát và chốt số liệu | [khách điền: xác nhận] |
| 2 | Chi nhánh Quản lý và Phát triển dự án (CN QLPTDA) | Nhập liệu; dùng Power BI | [khách điền: xác nhận] |
| 3 | Nhà máy Đạm Phú Mỹ | Nhập liệu; có báo cáo ĐTXD và CTSC riêng | [khách điền: xác nhận] |
| 4 | Ban Thương mại | Số liệu mua sắm trang thiết bị dự án | [khách điền: xác nhận] |
| 5 | Ban Kỹ thuật An toàn | Nhập liệu | [khách điền: xác nhận] |
| 6 | Ban Tổng hợp | Nhập liệu | [khách điền: xác nhận] |
| 7 | Ban Tài chính Kế toán (Ban TCKT) | Đối chiếu số liệu giải ngân với EBS | [khách điền: xác nhận] |
| 8 | Trung tâm Nghiên cứu và Ứng dụng | Nhập liệu | [khách điền: xác nhận] |
| 9 | Tổ dự án 1 | Nhập liệu | [khách điền: tên Tổ dự án] |
| 10 | Tổ dự án 2 | Nhập liệu | [khách điền: tên Tổ dự án] |
| 11 | Ban Tổng Giám đốc, Hội đồng quản trị | Khai thác báo cáo, dashboard | không nhập liệu |
| 12 | Ban CĐS&CNTT | Quản trị hệ thống; giám sát kỹ thuật | không nhập liệu |

Phạm vi dữ liệu: toàn bộ dự án ĐTXDCB và hạng mục mua sắm trang thiết bị dự án trong kế hoạch đầu tư (22 dự án đầu tư xây dựng, 01 hạng mục mua sắm tài sản dự án, 09 hạng mục mua sắm tài sản cố định theo kế hoạch năm 2026). Ngoài phạm vi: mua sắm hàng hóa, nguyên liệu, vật tư, dịch vụ phục vụ sản xuất của Nhà máy (thuộc hệ thống eProcurement).

### A.3 Hiện trạng quy trình và biểu mẫu

Công tác quản lý số liệu và báo cáo ĐTXD hiện làm hoàn toàn thủ công trên biểu mẫu Excel. Năm loại biểu mẫu báo cáo ĐTXD được lập song song (mục I.1), cộng báo cáo ĐTXD và CTSC của Nhà máy Đạm Phú Mỹ nêu ở mục BC.01:

| STT | Biểu mẫu hiện hành | Nơi nhận | Kỳ | Thời điểm chốt theo hồ sơ | Mã biểu mẫu DEMO trong hệ thống |
|---|---|---|---|---|---|
| 1 | Báo cáo thực hiện kế hoạch ĐTXDCB và mua sắm trang thiết bị | PVN | Tháng | Ngày 10 đến 15, số liệu ước đến cuối kỳ | `PVN-MONTHLY` |
| 2 | Báo cáo thực hiện ĐTXDCB và mua sắm trang thiết bị (Biểu 2) | PVN | Quý | Ngày 10 đến 15, số liệu ước đến cuối kỳ | `PVN-QUARTERLY-F2` |
| 3 | Báo cáo tháng nhập trên hệ thống HPM | HPM | Tháng | Ngày 15 đến 18, nhập lại | `HPM-MONTHLY` |
| 4 | Báo cáo định kỳ cho Ủy ban Đầu tư phát triển và KHCN | Ủy ban ĐTPT-KHCN | [khách điền: kỳ] | [khách điền] | `COMMITTEE-PERIODIC` |
| 5 | Báo cáo họp giao ban đầu tư hàng tháng | Giao ban | Tháng | Giữa tháng sau | `INVEST-STEERING` |
| 6 | Báo cáo ĐTXD và CTSC của Nhà máy Đạm Phú Mỹ | [khách điền] | [khách điền] | [khách điền] | `PLANT-PHU-MY` |

Cột cuối là sáu biểu mẫu DEMO mà hệ thống tự thiết kế từ mô tả của hồ sơ kỹ thuật (`docs/report-engine.md`, mục "The six PVFCCo forms"); chúng không phải mẫu chính thức. Bố cục chính thức do Ban KHĐT cung cấp (PX-01).

Nội dung chung của các biểu mẫu (mục I.1): kế hoạch năm, giá trị thực hiện và giải ngân trong kỳ, lũy kế từ đầu năm và từ khởi công, cơ cấu vốn, tình hình thực hiện, khó khăn vướng mắc và giải pháp. Khác nhau ở bố trí hàng, cột và thời điểm chốt số liệu.

Quy trình hiện tại (As-Is) theo mô tả của hồ sơ:

```
Mỗi kỳ báo cáo
  CN QLPTDA và các đơn vị nhập lại cùng một bộ số liệu vào nhiều biểu Excel
        |
        v
  Ban KHĐT tổng hợp thủ công
        |
        +--> Báo cáo tháng/quý gửi PVN (ngày 10 đến 15, số ước)
        +--> Nhập tay lần nữa lên HPM (ngày 15 đến 18) --> Data Lakehouse
        +--> Báo cáo Ủy ban ĐTPT-KHCN
        +--> Báo cáo giao ban (giữa tháng sau)
```

### A.4 Hệ thống hiện hữu

| Hệ thống | Vai trò hiện nay | Điều đã biết | Điều cần khảo sát |
|---|---|---|---|
| Biểu mẫu Excel | Nơi nhập và lưu số liệu | Dữ liệu phân tán trong các tệp, không lưu vết điều chỉnh | Tệp mẫu của từng đầu mối, công thức, quy ước đặt tên (PX-01, PX-02) |
| HPM | Nhận số liệu báo cáo tháng ở bước cuối, chuyển sang Data Lakehouse | Chỉ tiếp nhận ở bước cuối; chưa hỗ trợ nhập, phê duyệt, rà soát tại đơn vị | Nền tảng, đơn vị phát triển, khả năng mở API, cấu trúc dữ liệu nhận (PX-03) |
| ERP Oracle EBS | Số liệu kế toán, thanh toán theo mã dự án | Ban TCKT đối chiếu giải ngân | Tệp xuất hay đọc DB, quyền đọc, mẫu tệp (PX-04) |
| Data Lakehouse | Kho dữ liệu của Tổng công ty | Nhận số liệu từ HPM | Cách cấp dữ liệu trực tiếp qua DB hoặc API (TH.02) |
| Power BI | Công cụ báo cáo của CN QLPTDA | Đọc dữ liệu từ nguồn của Tổng công ty | Nguồn đang đọc, mô hình hiện có |
| eProcurement | Mua sắm hàng hóa phục vụ sản xuất | Ngoài phạm vi, nhưng số liệu mua sắm trang thiết bị dự án có thể lấy từ đây | Cách lấy dữ liệu (PX-06) |
| Hệ thống văn thư | Văn bản pháp lý | Chưa rõ | Đặc tả kết nối (PX-07) |
| Xác thực tập trung của Tổng công ty | SSO, LDAP, Active Directory | Hồ sơ yêu cầu tích hợp | Thông tin AD, nhóm theo vai trò (PX-16) |

### A.5 Vấn đề hiện trạng

Rút từ mục I.1, I.2 và đối chiếu với yêu cầu:

| STT | Vấn đề | Hệ quả theo hồ sơ | Mã yêu cầu xử lý |
|---|---|---|---|
| V1 | Cùng một số liệu nhập nhiều lần vào nhiều biểu | Số giải ngân và thuyết minh của một số dự án chưa thống nhất giữa báo cáo nội bộ và báo cáo gửi PVN | DL.01, BC.01, CN.04 |
| V2 | Ban KHĐT tổng hợp thủ công | Thời gian rà soát, đối chiếu, chỉnh sửa kéo dài | QT.01, BC.01 |
| V3 | Số báo cáo tháng nhập tay lại lên HPM | Rủi ro sai lệch, mất thời gian | TH.01 |
| V4 | Không có cơ chế lưu vết điều chỉnh | Khó truy xuất nhanh khi Lãnh đạo yêu cầu | DL.03, HT.06 |
| V5 | HPM không có quy trình nhập, phê duyệt, rà soát tại đơn vị | Chưa đáp ứng lập, theo dõi, phân tích đánh giá | QT.01, QT.02 |
| V6 | Không cảnh báo sai sót đến đầu mối nhập liệu và người phê duyệt | Lỗi đến muộn ở bước tổng hợp | DL.02, QT.01 |
| V7 | Dữ liệu và biểu mẫu khác nhau về thời điểm chốt | Số liệu cùng thời điểm khác nhau giữa các báo cáo | QT.02, CN.04 |

### A.6 Phiếu khảo sát tại 09 đầu mối (điền khi khảo sát)

Mỗi đầu mối một phiếu. Chỉ khách biết các trường này, nên toàn bộ là `[khách điền]`.

| Mục | Nội dung |
|---|---|
| Đầu mối | [khách điền: tên đơn vị] |
| Ngày khảo sát, người hướng dẫn | [khách điền] |
| Biểu mẫu Excel đơn vị đang lập (tên, tần suất, người lập) | [khách điền] |
| Số dự án và hạng mục đơn vị phụ trách | [khách điền] |
| Người nhập liệu dự kiến, người phê duyệt dự kiến (mỗi đầu mối 01 người theo BBH 43/BBH-KHĐT) | [khách điền] |
| Nguồn số liệu của từng chỉ tiêu (kế toán, kỹ thuật, tự tính) | [khách điền] |
| Thời điểm chốt số liệu thực tế và hạn gửi | [khách điền] |
| Khó khăn hiện tại, lỗi hay gặp | [khách điền] |
| Yêu cầu đặc thù | [khách điền] |
| Tệp mẫu đính kèm (băm SHA-256) | [khách điền] |

### A.7 Tiếp nhận từ Tổ chuẩn hóa dữ liệu

Theo mục II.2.3 giai đoạn 1, nhà cung cấp tiếp nhận master data, từ điển chỉ tiêu và bộ nguyên tắc nhập liệu do Tổ chuẩn hóa dữ liệu cung cấp. Hệ thống đã dựng sẵn nơi đặt các dữ liệu này (`docs/ind-indicator-dictionary.md`); bộ khởi điểm hiện gắn `legalStatus: UNVERIFIED`.

| Hạng mục | Tình trạng | Mã chờ |
|---|---|---|
| Danh mục dự án (22 + 01 + 09) và mã HPM, mã EBS từng dự án | chưa nhận | PX-14 |
| Từ điển chỉ tiêu | chưa nhận | PX-02 |
| Bộ nguyên tắc nhập liệu | chưa nhận | PX-02 |
| Bố cục chính thức của 06 biểu mẫu | chưa nhận | PX-01 |

---

## Phần B. Tài liệu yêu cầu người dùng (URD) dự thảo

URD viết ở mức năng lực, như hồ sơ kỹ thuật đã nêu; chi tiết trường dữ liệu, công thức, màn hình sẽ thống nhất với Tổ chuẩn hóa dữ liệu trong giai đoạn 1 và 2. Cột "Tiêu chí nghiệm thu (dự thảo)" là đề xuất của nhà cung cấp, chờ xác nhận. Cột "Trạng thái trong hệ thống" lấy từ ma trận truy vết.

### B.1 Người dùng và vai trò (HT.02)

| Vai trò | Việc chính | Phạm vi dữ liệu |
|---|---|---|
| Người nhập liệu đầu mối (01 người mỗi đầu mối) | Nhập, nhập từ Excel, xem cảnh báo sai sót | Dự án đơn vị mình phụ trách |
| Người phê duyệt tại đơn vị (01 người mỗi đầu mối) | Phê duyệt hoặc trả về kèm ý kiến | Đơn vị mình |
| Ban KHĐT rà soát | Rà soát, kiểm tra, chốt kỳ, đẩy HPM | Toàn Tổng công ty |
| Lãnh đạo (Ban TGĐ, HĐQT) | Xem báo cáo, dashboard, giao chỉ đạo | Toàn Tổng công ty |
| Ban TCKT | Cung cấp và đối chiếu số liệu giải ngân với EBS | [khách điền: phạm vi] |
| Quản trị hệ thống (Ban CĐS&CNTT) | Phân quyền, tham số, sao lưu, bảo mật | Quản trị |

### B.2 Yêu cầu người dùng

| Mã URD | Người dùng cần | Mã HSKT | Ưu tiên | Tiêu chí nghiệm thu (dự thảo) | Trạng thái trong hệ thống |
|---|---|---|---|---|---|
| UR-01 | Một danh mục dự án duy nhất với mã thống nhất và ánh xạ mã HPM, EBS | MD.01 | Bắt buộc | 100% dự án trong phạm vi có mã, mã HPM, mã EBS; ánh xạ truy được hai chiều | PARTIAL, ENT-3e |
| UR-02 | Phân loại dự án theo nhóm A/B/C, loại hình, giai đoạn, đơn vị chủ trì | MD.01 | Bắt buộc | Lọc được theo từng tiêu chí; thêm tiêu chí mới không cần lập trình | PARTIAL, ENT-3e |
| UR-03 | Lưu thông tin chung của dự án (địa điểm, quy mô, thời gian, tổng mức đầu tư, cơ cấu vốn, đầu mối liên lạc) | MD.01 | Bắt buộc | Đủ trường theo hồ sơ; vốn chủ sở hữu cộng vốn vay bằng tổng | PARTIAL |
| UR-04 | Lưu hồ sơ pháp lý và mốc tiến độ kế hoạch, thực tế | MD.02 | Bắt buộc | Mỗi văn bản có số hiệu, ngày, cơ quan ban hành, tệp đính kèm; lịch sử thay đổi truy được | PARTIAL, ENT-3e |
| UR-05 | Danh mục dùng chung do Ban KHĐT quản lý tập trung, đơn vị chỉ dùng | MD.03 | Bắt buộc | Đơn vị không sửa được danh mục; thay đổi có người duyệt và lịch sử | PARTIAL, ENT-4e |
| UR-06 | Nhập một lần, hệ thống tự tính lũy kế, tỷ lệ hoàn thành, chênh lệch so kế hoạch | DL.01 | Bắt buộc | Một số liệu chỉ có một nơi nhập; các chỉ tiêu tổng hợp khớp bộ số golden | PARTIAL, ENT-3a |
| UR-07 | Quản lý giá trị ước và giá trị thực của cùng một kỳ, lưu lịch sử đổi số ước thành số thực | DL.01 | Bắt buộc | Lịch sử chuyển đổi của kỳ xem được | DONE (DIS-29) |
| UR-08 | Từ điển chỉ tiêu có tên, định nghĩa, công thức, đơn vị, nguồn, kỳ áp dụng | DL.02 | Bắt buộc | Mọi chỉ tiêu có đủ trường; đổi công thức không cần lập trình | DONE, chờ PX-02 |
| UR-09 | Cảnh báo ngay khi nhập sai (lũy kế vượt tổng mức đầu tư, tổng vốn chủ sở hữu và vốn vay khác tổng, kỳ đã chốt, trường bắt buộc) | DL.02 | Bắt buộc | Từng quy tắc có ca kiểm thử chạy được và có thể đỏ | DONE, chờ PX-02 |
| UR-10 | Nhập trên màn hình và nhập từ Excel theo mẫu có kiểm tra trước khi ghi | DL.02, YCK.04 | Bắt buộc | Chạy thử không ghi gì; dòng lỗi nêu dòng, trường, mã | DONE |
| UR-11 | Dữ liệu theo kỳ, so cùng kỳ, bản chốt đúng như đã báo cáo | DL.03 | Bắt buộc | Mở lại bản chốt của kỳ cũ cho cùng số | PARTIAL, ENT-3a |
| UR-12 | Quy trình nhập, phê duyệt đơn vị, Ban KHĐT rà soát, chốt kỳ, đẩy HPM; sai sót trả về kèm cảnh báo | QT.01 | Bắt buộc | Từng bước đi qua được; trả về có lý do; bước, vai trò, hạn cấu hình được | PARTIAL, ENT-3c |
| UR-13 | Lịch kỳ tháng, quý, năm, giao ban với hạn từng bước; theo dõi trạng thái từng đầu mối; nhắc việc và cảnh báo quá hạn | QT.02 | Bắt buộc | Đầu mối quá hạn nhận thông báo; bảng tiến độ khớp thực tế | PARTIAL, ENT-4c |
| UR-14 | Chốt kỳ sau khi Ban KHĐT rà soát; mở lại có lý do, người duyệt đúng thẩm quyền, lưu vết | QT.02 | Bắt buộc | Kỳ đã chốt không đổi; mở lại phải có lý do | DONE (DIS-21, DIS-22) |
| UR-15 | Điều chỉnh kế hoạch trong năm; giao và theo dõi chỉ đạo của Lãnh đạo | QT.02, CN.01, CN.03 | Bắt buộc | Chỉ đạo có người nhận, hạn, trạng thái | PARTIAL |
| UR-16 | Ghi kế hoạch vốn năm theo Nghị quyết PVN và Quyết định giao nhiệm vụ của Tổng công ty, phân bổ quý, tháng, cơ cấu nguồn | CN.01 | Bắt buộc | Mỗi dòng kế hoạch nêu căn cứ văn bản | PARTIAL, ENT-3e |
| UR-17 | Nhập và duyệt số liệu thực hiện, giải ngân theo kỳ; thuyết minh có cấu trúc, kế thừa kỳ trước | CN.02 | Bắt buộc | Tám trường thuyết minh; kế thừa có dấu vết | PARTIAL, ENT-3b |
| UR-18 | Theo dõi mua sắm trang thiết bị dự án của Ban Thương mại | CN.02 | Bắt buộc | Kế hoạch, kết quả lựa chọn nhà thầu, giá trị hợp đồng, giải ngân | PARTIAL, ENT-4e |
| UR-19 | Theo dõi mốc tiến độ, cảnh báo dự án chậm, vướng thủ tục | CN.03 | Bắt buộc | Dự án chậm hiện trên dashboard | PARTIAL |
| UR-20 | Đối chiếu giải ngân với EBS theo mã dự án và kỳ; hiển thị chênh lệch và yêu cầu giải trình | CN.04 | Bắt buộc | Mỗi chênh lệch có người nhận, hạn, lý do | DONE trên giả định, PX-04 |
| UR-21 | So sánh chéo số liệu cùng kỳ giữa các loại báo cáo trước phát hành | CN.04 | Bắt buộc | Lệch thì chặn phát hành | PARTIAL, ENT-4a |
| UR-22 | Tự động lập sáu biểu mẫu từ bộ dữ liệu nền, xuất đúng bố cục; Excel, PDF, Word; đặt tên theo quy ước; lưu bản phát hành theo kỳ | BC.01 | Bắt buộc | Số trong sáu biểu khớp nhau | PARTIAL, ENT-3a, ENT-4b |
| UR-23 | Biểu mẫu nội bộ tự cấu hình bố cục (chọn chỉ tiêu, cột, nhóm dự án) | BC.01, HT.04 | Bắt buộc | Không cần lập trình | PARTIAL, ENT-4b |
| UR-24 | Dashboard cho Lãnh đạo và Ban KHĐT; tự tạo báo cáo; trình chiếu tại giao ban; gửi email theo lịch | BC.02 | Bắt buộc | Số trên dashboard khớp bản chốt | PARTIAL, ENT-4d |
| UR-25 | Đẩy số liệu tháng đã chốt sang HPM, ghi kết quả, cảnh báo lỗi, đẩy lại, điều chỉnh sau khi đã đẩy | TH.01 | Bắt buộc | Đẩy lại không trùng; có biên nhận | PARTIAL, ENT-3c, chờ PX-03 |
| UR-26 | Cấp dữ liệu cho Data Lakehouse và Power BI | TH.02 | Bắt buộc | Power BI đọc được tập dữ liệu chứng nhận | PARTIAL, DOC-3 |
| UR-27 | Đọc EBS, sẵn sàng eProcurement, văn thư, xác thực tập trung; API mở có tài liệu, không phí bản quyền | TH.03 | Bắt buộc | Tài liệu API khớp hệ thống | PARTIAL |
| UR-28 | Phân quyền theo vai trò và theo đơn vị, dự án, kỳ | HT.02 | Bắt buộc | Đơn vị chỉ thấy dự án mình | PARTIAL, ENT-3d |
| UR-29 | Ủy quyền trong thời hạn hoặc vĩnh viễn | HT.03 | Bắt buộc | Ủy quyền có hạn, thu hồi được, lưu vết | DONE |
| UR-30 | Quản trị tự đổi danh mục, công thức, quy tắc, lịch kỳ, bố cục nội bộ | HT.04 | Bắt buộc | Mỗi thay đổi có phiên bản và người duyệt | PARTIAL |
| UR-31 | Phản hồi dưới 5 giây, xem báo cáo dưới 20 giây | HT.05 | Bắt buộc | Đo trên phần cứng khách | PARTIAL, PX-10 |
| UR-32 | Lưu vết mọi thao tác kèm giá trị trước/sau, lý do; giới hạn log | HT.06 | Bắt buộc | Truy được từng thay đổi số liệu | PARTIAL, ENT-4e |
| UR-33 | Dùng được trên Chrome, Firefox, Edge, Safari; PWA cho quản lý (duyệt, dashboard, chỉ đạo); SSO và MFA từ ngoài | YCK.01 | Bắt buộc | Ba màn PWA chạy được trên điện thoại | PARTIAL, ENT-4e |
| UR-34 | Hai môi trường UAT và Production | YCK.02 | Bắt buộc | Cấu hình khuyến nghị được duyệt | PARTIAL, DOC-3 |
| UR-35 | Sao lưu ngày/tuần/tháng, giữ tối thiểu 03 bản, một bản bất biến, kiểm tra khôi phục | YCK.06 | Bắt buộc | Có biên bản diễn tập khôi phục | PARTIAL, INFRA-2 |
| UR-36 | Bảo mật theo YCK.07, kể cả pentest độc lập | YCK.07 | Bắt buộc | Không còn lỗ hổng Critical, High | PARTIAL, PX-09 |
| UR-37 | Giao diện tiếng Việt, hướng dẫn trực tuyến trên màn hình | YCK.08 | Bắt buộc | Mỗi màn có nút trợ giúp | PARTIAL, DOC-3 |
| UR-38 | Đào tạo, tài liệu, chuyển đổi dữ liệu, vận hành thử song song 02 kỳ | TK.01 đến TK.04 | Bắt buộc | Biên bản từng bước được ký | PARTIAL, DELIVERY-1 |

### B.3 Yêu cầu phi chức năng và ràng buộc

| Mục | Nội dung theo hồ sơ | Ghi chú |
|---|---|---|
| Hạ tầng | Máy chủ của PVFCCo, Ban CĐS&CNTT quản trị sau nghiệm thu | PX-11 |
| Kinh phí | Dự toán 3 tỷ đồng, kế hoạch mua sắm 2026 (QĐ 26-61/QĐ-PBHC) | Ngoài phạm vi kỹ thuật |
| Thời gian | [06] tháng kể từ ngày ký hợp đồng | Ngoài phạm vi kỹ thuật |
| Số người dùng | [Ước tính ... người dùng] | PX-17 |
| Mở rộng | Gói thầu, hợp đồng, quyết toán, chất lượng - an toàn ở giai đoạn sau | YCK.05; nền tảng đã có các phân hệ này |
| Ứng dụng di động | Chỉ PWA cho quản lý; native iOS/Android ngoài giai đoạn 1 | YCK.01 |

### B.4 Câu hỏi mở cần Tổ chuẩn hóa dữ liệu trả lời

Các chỗ hồ sơ kỹ thuật để dấu ngoặc vuông, chuyển nguyên thành câu hỏi:

1. Phạm vi cấp quản lý dưới dự án (hạng mục, gói thầu, hợp đồng) ở giai đoạn 1 do Ban KHĐT xác nhận (MD.01).
2. Phạm vi quản lý số ước (DL.01).
3. Phạm vi dữ liệu lịch sử cần chuyển đổi (DL.03, TK.03; PX-08).
4. Loại hình "sửa chữa lớn" có là loại hình dự án chính thức không (MD.01).
5. Quy trình bổ sung nào ngoài điều chỉnh kế hoạch và chỉ đạo giao ban (QT.02).
6. Cách lấy dữ liệu từ eProcurement (CN.02; PX-06).
7. Phạm vi và phương thức đối chiếu EBS (TH.03; PX-04).
8. Số kỳ chạy song song (hồ sơ ghi [02]; TK.04, PX-13).

### B.5 Xác nhận

| Vai trò | Họ tên | Chữ ký, ngày |
|---|---|---|
| Soạn thảo (nhà cung cấp) | [khách điền] | [khách điền] |
| Xác nhận nghiệp vụ (Tổ trưởng Tổ chuẩn hóa dữ liệu) | [khách điền] | [khách điền] |
| Giám sát kỹ thuật (Ban CĐS&CNTT) | [khách điền] | [khách điền] |
| Phê duyệt PVFCCo | [khách điền] | [khách điền] |

Lịch sử sửa: v0.1 khung do hệ thống sinh ngày 2026-11-09 từ hồ sơ kỹ thuật v0.3.
