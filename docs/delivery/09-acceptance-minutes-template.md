# 09. Mẫu biên bản kiểm thử chấp nhận, vận hành thử và nghiệm thu

Giai đoạn 4 (biên bản UAT), giai đoạn 6 (biên bản vận hành thử, biên bản nghiệm thu đưa vào sử dụng). Dòng ma trận: GD.4, GD.6, SP.05, SP.09. PVFCCo phê duyệt: có.

Tệp này là bộ mẫu để các bên điền; không chứa kết quả. Biên bản vận hành thử có mẫu riêng ở [08](08-parallel-run-plan.md) mục 7 và được đính kèm vào biên bản nghiệm thu. Biên bản chuyển đổi dữ liệu: [06](06-data-conversion-plan.md) mục 6. Biên bản đào tạo: [07](07-training-plan.md) mục 7.

Nguồn: hồ sơ kỹ thuật mục II.2.3, II.5, II.8 và tiêu chuẩn đánh giá kỹ thuật (mục II.9); điều kiện nghiệm thu và phân loại lỗi P0 đến P3 trong `Design/MACHVON_Design/01_Documents/10_Ke_hoach_kiem_thu_va_chuyen_doi.md` (mục "Defect và điều kiện nghiệm thu"); quy tắc bằng chứng `docs/runbooks/uat-evidence.md`; ma trận [../hskt/TRACEABILITY.md](../hskt/TRACEABILITY.md).

Trạng thái tệp: v0.2, rà soát ngày 2026-11-12. Phần mẫu biên bản không đổi; thêm các bảng điền sẵn bằng số đếm lấy từ tài liệu do hệ thống sinh (mục 1.1) và bảng tình trạng chuẩn bị của mười một sản phẩm (mục 3.1). Các bảng điền sẵn không phải kết quả UAT: kết quả vẫn là NOT_RUN cho tới khi có lượt chạy tại PVFCCo (PX-12 và các mã PX nêu ở từng dòng).

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

### 1.1 Số đếm điền sẵn cho mục 2, 3 và 5 của biên bản UAT

Nguồn: `docs/UAT-EVIDENCE.md` (sinh bởi `npm run uat:evidence` từ kho kết quả `docs/uat-run-results.json`; lượt chạy `local-2026-11-07-mobile-r3`, bản dựng 9c978a88aa24, lược đồ 1706), đọc ngày 2026-11-12. Tại ngày lập biên bản UAT, sinh lại tài liệu từ lượt chạy tại PVFCCo và thay các số dưới đây. Chỉ có số đếm; không có dòng nào được chuyển từ NOT_RUN thành đạt khi chưa có bản ghi PASS kèm bằng chứng.

| Chỉ số | Số hiện tại | Ghi chú |
|---|---|---|
| Hàng yêu cầu của bộ thiết kế (667 yêu cầu, 676 hàng theo màn hình) | 676 | |
| PASS | 63 | Từ lượt chạy phát triển, không phải UAT tại PVFCCo |
| UNPROVEN (PASS thiếu bằng chứng) | 1 | Không tính đạt |
| FAIL | 1 | Phải có mã lỗi trong danh sách lỗi |
| NOT_RUN | 611 | Ghi "Chưa chạy" |
| WAIVED, SKIPPED, GAP | 0, 0, 0 | |
| Ca then chốt (tiền, cách ly, khôi phục) PASS | 20 trên 28 | 8 ca còn lại: NOT_RUN 5, UNPROVEN 3; điều kiện đạt đòi 28 trên 28 |
| Tiêu chí nghiệm thu có tên trong kiểm thử đang chạy (`docs/UAT-COVERAGE.md`) | 810 trên 836 | 26 tiêu chí chưa có kiểm thử |
| Lỗi mở theo mức | [điền khi có] | Danh sách lỗi ở [05](05-sit-uat-scripts.md) mục 6 |

Đối chiếu theo mã yêu cầu của hồ sơ kỹ thuật (cho bảng ở mục 3 của biên bản): số màn hình liên quan lấy từ cột Bằng chứng của ma trận `docs/hskt/requirements.json`, trạng thái từng màn hình lấy từ `docs/UAT-EVIDENCE.md`. Mã không có màn hình liên quan (HT.01, YCK.02, YCK.03) được kiểm bằng ca phi chức năng của `docs/uat/nfr` và `docs/uat/critical`, không qua màn hình.

| Mã YC | Màn hình liên quan | Đạt (PASS) | Không đạt (FAIL, UNPROVEN) | Chưa chạy (NOT_RUN) | Chờ khách (PX) |
|---|---|---|---|---|---|
| MD.01 | 6 | 0 | 0 | 6 | PX-14 |
| MD.02 | 5 | 0 | 0 | 5 | PX-07 |
| MD.03 | 6 | 0 | 0 | 6 | |
| DL.01 | 4 | 0 | 0 | 4 | PX-02 |
| DL.02 | 5 | 0 | 0 | 5 | PX-02 |
| DL.03 | 4 | 0 | 0 | 4 | PX-08 |
| QT.01 | 6 | 1 | 0 | 5 | PX-03 |
| QT.02 | 10 | 0 | 0 | 10 | PX-16 |
| CN.01 | 7 | 0 | 0 | 7 | |
| CN.02 | 6 | 1 | 0 | 5 | PX-06 |
| CN.03 | 8 | 0 | 0 | 8 | |
| CN.04 | 4 | 0 | 0 | 4 | PX-04 |
| BC.01 | 7 | 0 | 0 | 7 | PX-01, PX-15 |
| BC.02 | 7 | 0 | 0 | 7 | |
| TH.01 | 4 | 0 | 0 | 4 | PX-03 |
| TH.02 | 6 | 0 | 0 | 6 | PX-11 |
| TH.03 | 6 | 0 | 0 | 6 | PX-04, PX-06, PX-07 |
| HT.01 | 0 (ca phi chức năng) | không áp dụng | không áp dụng | không áp dụng | PX-11 |
| HT.02 | 5 | 0 | 0 | 5 | PX-05, PX-16 |
| HT.03 | 4 | 0 | 0 | 4 | |
| HT.04 | 7 | 0 | 0 | 7 | |
| HT.05 | 2 | 0 | 0 | 2 | PX-10 |
| HT.06 | 4 | 0 | 0 | 4 | |
| YCK.01 | 4 | 0 | 0 | 4 | PX-16 |
| YCK.02 | 0 (ca phi chức năng) | không áp dụng | không áp dụng | không áp dụng | PX-11, PX-17 |
| YCK.03 | 0 (ca phi chức năng) | không áp dụng | không áp dụng | không áp dụng | PX-17 |
| YCK.04 | 7 | 0 | 0 | 7 | |
| YCK.05 | 4 | 0 | 0 | 4 | |
| YCK.06 | 2 | 0 | 0 | 2 | PX-11 |
| YCK.07 | 2 | 0 | 0 | 2 | PX-09, PX-16 |
| YCK.08 | 3 | 0 | 0 | 3 | |

Trong bảng chỉ có 2 lượt PASS (QT.01 và CN.02, mỗi mã một màn hình); phần lớn trong 63 màn hình PASS thuộc các phân hệ nền (đăng nhập, trang chủ, dự án...) không được nêu trong cột Bằng chứng của mã yêu cầu nào ở trên. Một màn hình dùng chung cho nhiều mã được đếm ở từng mã. Cột "Chờ khách" lấy từ khóa `pending` của `docs/hskt/requirements.json`; mã có cột này không rỗng thì phần dựng trên giả định không được tính vào số đạt dù màn hình đã PASS.

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

### 3.1 Tình trạng chuẩn bị của mười một sản phẩm (đọc ngày 2026-11-12, để điền cột "Kết quả" khi nghiệm thu)

Cột "Còn thiếu" chỉ nêu điều chỉ khách hoặc bên ngoài làm được; việc nhà cung cấp tự làm được đã nằm trong từng tệp.

| STT | Sản phẩm | Tệp có sẵn | Còn thiếu (mã PX) |
|---|---|---|---|
| 1 | Báo cáo khảo sát As-Is và URD | [01](01-as-is-survey-and-urd.md), khung điền từ hồ sơ kỹ thuật | Khảo sát tại 09 đầu mối (PX-05); phê duyệt giai đoạn 1 (PX-12) |
| 2 | Quy trình To-Be | [02](02-to-be-process.md) | Hạn từng bước và người giữ vai trò do Tổ chuẩn hóa dữ liệu chốt (mục 4 của [11](11-pending-external-register.md)); phê duyệt (PX-12) |
| 3 | SRS, thiết kế hệ thống, thiết kế tích hợp | [03](03-srs-mapping.md), [04](04-system-and-integration-design.md), `docs/integration/hpm-proposal.md` | Đặc tả kỹ thuật HPM (PX-03); phê duyệt (PX-12) |
| 4 | Master data và từ điển chỉ tiêu | [06](06-data-conversion-plan.md), `docs/ind-indicator-dictionary.md`, gói `PVFCCO-TEMPLATE` | Từ điển và danh mục chính thức (PX-02, PX-14) |
| 5 | Kịch bản và biên bản UAT | [05](05-sit-uat-scripts.md), mục 1 của tệp này | Chạy UAT tại PVFCCo cùng đầu mối, môi trường UAT (PX-11), phê duyệt kịch bản và ký (PX-12) |
| 6 | Biên bản chuyển đổi dữ liệu | [06](06-data-conversion-plan.md) mục 6 | Tệp Excel hiện hành, phạm vi lịch sử, danh mục thật (PX-02, PX-08, PX-14) |
| 7 | Biên bản đào tạo; tài liệu và video | [07](07-training-plan.md); `docs/admin-guide.md`; trợ giúp trên màn hình | Danh sách người học, môi trường đào tạo (PX-05, PX-11); quyết định về video hướng dẫn: [khách điền: quyết định của chủ dự án và PVFCCo] |
| 8 | Báo cáo rà soát mã nguồn và pentest độc lập | `docs/security/pentest-readiness.md` (gói đầu vào) | Đơn vị độc lập được PVFCCo chấp thuận, báo cáo, khắc phục, retest (PX-09) |
| 9 | Biên bản vận hành thử và nghiệm thu | [08](08-parallel-run-plan.md), mục 3 của tệp này | Hai kỳ thực tế và số liệu Excel (PX-13), HPM chính thức (PX-03), pentest đạt (PX-09) |
| 10 | Bộ tài liệu bàn giao | [10](10-handover-checklist.md), [12](12-maintenance-and-hypercare.md) | Thẻ phát hành, tên máy chủ chính thức, cài thử trên máy PVFCCo (PX-11) |
| 11 | Sản phẩm khác theo Điều lệ dự án | không | Điều lệ dự án (PX-12) |

## 4. Lưu ý về điều kiện bảo hành đã nêu trong hồ sơ kỹ thuật

Hỗ trợ trực tiếp hoặc trực tuyến trong các kỳ chốt tháng và quý; khắc phục sự cố trong vòng 24 giờ kể từ khi nhận thông báo; điều chỉnh biểu mẫu khi PVN hoặc Tổng công ty đổi mẫu, không phát sinh chi phí ở mức cấu hình; hỗ trợ bảo trì thử trên UAT trước khi áp dụng vào môi trường đang dùng; chạy lại pentest khi có thay đổi lớn; khắc phục lỗ hổng Critical hoặc High trong vòng [07] ngày (mục II.6.3). Các cam kết này được cụ thể hóa trong [12](12-maintenance-and-hypercare.md) (mô hình hỗ trợ P0 đến P3, kế hoạch hypercare, lịch hỗ trợ kỳ chốt, mẫu báo cáo bảo trì định kỳ; dòng GD.7 của ma trận). Các giá trị trong ngoặc vuông của hồ sơ kỹ thuật ([12] tháng, [07] ngày) giữ nguyên như hồ sơ ghi; thời hạn phản hồi và xử lý theo mức sự cố là quyết định D10 chưa được chốt, nằm ở [12] mục 2.

Lịch sử sửa: v0.1 khung ngày 2026-11-09. v0.2 ngày 2026-11-12 (rà soát bởi làn aud4): thêm mục 1.1 (số đếm điền sẵn từ bằng chứng UAT do hệ thống sinh, kết quả NOT_RUN giữ nguyên), mục 3.1 (tình trạng chuẩn bị của mười một sản phẩm kèm mã PX) và liên kết tới [12](12-maintenance-and-hypercare.md) trong mục 4.
