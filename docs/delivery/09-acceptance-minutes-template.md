# 09. Mẫu biên bản kiểm thử chấp nhận, vận hành thử và nghiệm thu

Giai đoạn 4 (biên bản UAT), giai đoạn 6 (biên bản vận hành thử, biên bản nghiệm thu đưa vào sử dụng). Dòng ma trận: GD.4, GD.6, SP.05, SP.09. PVFCCo phê duyệt: có.

Tệp này là bộ mẫu để các bên điền; không chứa kết quả. Biên bản vận hành thử có mẫu riêng ở [08](08-parallel-run-plan.md) mục 7 và được đính kèm vào biên bản nghiệm thu. Biên bản chuyển đổi dữ liệu: [06](06-data-conversion-plan.md) mục 6. Biên bản đào tạo: [07](07-training-plan.md) mục 7.

Nguồn: hồ sơ kỹ thuật mục II.2.3, II.5, II.8 và tiêu chuẩn đánh giá kỹ thuật (mục II.9); điều kiện nghiệm thu và phân loại lỗi P0 đến P3 trong `Design/MACHVON_Design/01_Documents/10_Ke_hoach_kiem_thu_va_chuyen_doi.md` (mục "Defect và điều kiện nghiệm thu"); quy tắc bằng chứng `docs/runbooks/uat-evidence.md`; ma trận [../hskt/TRACEABILITY.md](../hskt/TRACEABILITY.md).

Quy tắc chung: không điền "Đạt" cho mục dựng trên giả định chờ khách (PENDING-EXTERNAL, mã PX-nn); các mục đó ghi "Chờ khách" kèm mã. Một dòng chỉ ghi đạt khi có bằng chứng kèm: thời điểm, bản dựng, phiên bản lược đồ, băm bộ dữ liệu, mã yêu cầu, người chạy.

---

## 1. Biên bản kiểm thử chấp nhận người dùng (UAT)

```
BIÊN BẢN KIỂM THỬ CHẤP NHẬN (UAT)
Số: [khách điền]            Ngày bắt đầu: [..]   Ngày kết thúc: [..]
Phần mềm: Phần mềm quản lý đầu tư xây dựng, bản dựng [mã bản dựng], lược đồ [phiên bản]
Môi trường: UAT của PVFCCo, địa chỉ [khách điền]
Kịch bản: docs/delivery/05-sit-uat-scripts.md, bản [..], đã được PVFCCo phê duyệt ngày [khách điền]
1. Thành phần
   | Họ tên | Đơn vị, đầu mối | Vai trò trong UAT (nhập, duyệt, Ban KHĐT, lãnh đạo, quản trị) | Ký |
   | [khách điền]
2. Báo cáo SIT của nhà cung cấp: đính kèm, số ca [..], đạt [..], lỗi còn mở [..]
3. Kết quả UAT theo mã yêu cầu (mỗi dòng của ma trận truy vết)
   | Mã YC | Ca đã chạy | Đạt | Không đạt | Chưa chạy | Chờ khách (PX) | Ghi chú |
   | [điền khi có]
4. Danh sách lỗi (mẫu ở 05 mục 6): P0 [..], P1 [..], P2 [..], P3 [..]; đã đóng [..]; còn mở [..]
5. Phép thử bắt buộc theo nền tảng (ca then chốt: tiền, cách ly, khôi phục): [..]/28 đạt
6. Mục không đạt hoặc chưa chạy và quyết định: [khách điền]
7. Kết luận: [ ] Đạt   [ ] Đạt có điều kiện   [ ] Không đạt
Chữ ký: Trưởng Ban KHĐT [khách điền]   Đại diện đầu mối [khách điền]
        Ban CĐS&CNTT [khách điền]   Nhà cung cấp [khách điền]
```

Điều kiện đạt (đề xuất theo kế hoạch kiểm thử và chuyển đổi của nền tảng; PVFCCo xác nhận):

| Điều kiện | Ngưỡng |
|---|---|
| Ca then chốt (tiền, cách ly, khôi phục) | 100% đạt |
| Lỗi P0 (rò dữ liệu, sai tiền đã công bố, mất dữ liệu, vượt quyền) và P1 (luồng lõi không hoàn thành) | Không còn mở |
| Lỗi P2, P3 | Có chủ, cách xử lý và hạn do Ban KHĐT duyệt |
| Ca bị bỏ qua | Có lý do; không tính là đạt |
| Mục PENDING-EXTERNAL | Không tính vào số đạt; nằm trong sổ [11](11-pending-external-register.md) |

## 2. Danh sách lỗi và kết quả khắc phục (đính kèm biên bản UAT)

Bảng mẫu ở [05](05-sit-uat-scripts.md) mục 6. Mỗi lỗi đã sửa phải có kết quả kiểm lại do người khác người sửa xác nhận.

## 3. Biên bản nghiệm thu đưa vào sử dụng

```
BIÊN BẢN NGHIỆM THU ĐƯA VÀO SỬ DỤNG
Số: [khách điền]            Ngày: [khách điền]
Hợp đồng số: [khách điền]   Ngày ký: [khách điền]
1. Căn cứ: hồ sơ kỹ thuật v0.3; hợp đồng; các phiếu phê duyệt giai đoạn 1 đến 6
2. Thành phần: PVFCCo [..], Ban CĐS&CNTT [..], Tổ chuẩn hóa dữ liệu [..], nhà cung cấp [..]
3. Đối chiếu sản phẩm bàn giao (mục II.5)
   | STT | Sản phẩm | Tệp, phiên bản | Phiếu phê duyệt số | Kết quả |
   | 1 | Báo cáo khảo sát As-Is và URD | 01 | [..] | [..] |
   | 2 | Quy trình To-Be | 02 | [..] | [..] |
   | 3 | SRS, thiết kế hệ thống, thiết kế tích hợp | 03, 04 | [..] | [..] |
   | 4 | Master data và từ điển chỉ tiêu đã chuẩn hóa, khởi tạo trên hệ thống | 06 và hệ thống | [..] | [..] |
   | 5 | Kịch bản kiểm thử và biên bản UAT | 05, mục 1 | [..] | [..] |
   | 6 | Biên bản xác nhận chuyển đổi dữ liệu | 06 mục 6 | [..] | [..] |
   | 7 | Biên bản đào tạo; tài liệu và video hướng dẫn | 07 | [..] | [..] |
   | 8 | Báo cáo rà soát mã nguồn và pentest độc lập; khắc phục và retest | do đơn vị độc lập cấp | [..] | [..] |
   | 9 | Biên bản vận hành thử và biên bản nghiệm thu | 08 mục 7, tệp này | [..] | [..] |
   | 10 | Bộ tài liệu bàn giao | 10 | [..] | [..] |
   | 11 | Sản phẩm khác theo Điều lệ dự án | [khách điền] | [..] | [..] |
4. Đối chiếu yêu cầu kỹ thuật (mục II.3): bảng mã YC, trạng thái theo ma trận tại ngày nghiệm thu
   | Mã YC | Trạng thái | Bằng chứng | Mục chờ khách còn lại |
   | [điền khi có]
5. Điều kiện bắt buộc
   [ ] Pentest độc lập đạt YCK.07: không còn lỗ hổng Critical, High; Medium đã khắc phục hoặc có biện pháp giảm thiểu PVFCCo chấp thuận bằng văn bản
   [ ] Vận hành thử song song đủ [02] kỳ; không còn lỗi P0, P1
   [ ] Đẩy số liệu sang HPM môi trường chính thức có biên nhận
   [ ] Biên bản chuyển đổi dữ liệu và biên bản đào tạo đã ký
6. Tồn tại và cam kết khắc phục trong bảo hành: [khách điền]
7. Bảo hành: [12] tháng kể từ ngày ký biên bản này (hồ sơ kỹ thuật II.6.3, II.8)
8. Kết luận: [ ] Nghiệm thu đưa vào sử dụng   [ ] Nghiệm thu có điều kiện   [ ] Không nghiệm thu
Chữ ký: Tổng Giám đốc hoặc người được ủy quyền [khách điền]
        Trưởng Ban KHĐT, Tổ trưởng Tổ chuẩn hóa dữ liệu [khách điền]
        Phó Ban phụ trách Ban CĐS&CNTT [khách điền]   Nhà cung cấp [khách điền]
```

## 4. Lưu ý về điều kiện bảo hành đã nêu trong hồ sơ kỹ thuật

Hỗ trợ trực tiếp hoặc trực tuyến trong các kỳ chốt tháng và quý; khắc phục sự cố trong vòng 24 giờ kể từ khi nhận thông báo; điều chỉnh biểu mẫu khi PVN hoặc Tổng công ty đổi mẫu, không phát sinh chi phí ở mức cấu hình; hỗ trợ bảo trì thử trên UAT trước khi áp dụng vào môi trường đang dùng; chạy lại pentest khi có thay đổi lớn; khắc phục lỗ hổng Critical hoặc High trong vòng [07] ngày (mục II.6.3). Các cam kết này cần được đưa vào lịch hỗ trợ giai đoạn 7 (dòng GD.7 của ma trận).

Lịch sử sửa: v0.1 khung ngày 2026-11-09.
