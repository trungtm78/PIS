# 08. Kế hoạch vận hành thử song song hai kỳ báo cáo và các bước đối chiếu

Giai đoạn 6, sản phẩm 9 của mục II.5 (biên bản vận hành thử). Dòng ma trận: TK.04, GD.6, SP.09. Mã liên quan: CN.04, TH.01. PVFCCo phê duyệt: có.

Hồ sơ kỹ thuật (TK.04, giai đoạn 6): hỗ trợ vận hành song song với biểu mẫu Excel trong [02] kỳ báo cáo thực tế; đối chiếu kết quả và khắc phục trước khi nghiệm thu; đẩy số liệu sang HPM môi trường chính thức; khắc phục tồn tại; bàn giao.

Nguồn: `Design/MACHVON_Design/01_Documents/10_Ke_hoach_kiem_thu_va_chuyen_doi.md` (mục migration rehearsal và đối soát, dual-run, cutover, defect và điều kiện nghiệm thu); câu chuyện ST-DIS-024 (cổng chạy song song hai kỳ, dung sai 0 đồng cùng cơ sở tính, không còn lỗi P0 hoặc P1) và ST-KERNEL-103 (pilot hai kỳ, chênh lệch phân loại thành định nghĩa, thời điểm, lỗi dữ liệu, SUS từ 80, từ 90% tác vụ không trợ giúp); `docs/dis-d03-signoff-pack.md`; `docs/file-import.md` (mục đối chiếu, mục chênh lệch có chủ và hạn); `docs/hpm-ebs-connectors.md`; `docs/ind-indicator-dictionary.md` (chênh lệch `IND_FIGURE_DIFFERS`).

Trạng thái tệp: KHUNG. Chưa có kỳ thực tế (PX-13) và chưa có giao diện HPM chính thức (PX-03). Số kỳ [02] theo hồ sơ; lịch cụ thể do Ban KHĐT chọn.

---

## 1. Nguyên tắc

1. Hai hệ thống chạy cùng kỳ: biểu mẫu Excel vẫn là bản chính thức gửi PVN, HPM và nơi nhận cho tới khi biên bản nghiệm thu được ký; phần mềm là bản song song. Không gửi báo cáo chính thức bằng bản phần mềm khi chưa nghiệm thu.
2. Mỗi đầu mối nhập vào phần mềm cùng số liệu đã nhập vào Excel, không nhập số khác.
3. So sánh từng chỉ tiêu, từng dự án, từng kỳ; sai lệch được phân loại và có chủ, không bỏ qua tổng.
4. Chênh lệch tiền: dung sai 0 đồng trên cùng cơ sở tính; chênh lệch do thời điểm hoặc làm tròn chỉ chấp nhận theo quy tắc đã ký (ST-DIS-024, ST-KERNEL-103).
5. Mục nào dựng trên giả định chờ khách (mẫu biểu chính thức, từ điển chỉ tiêu, HPM, EBS) ghi PENDING-EXTERNAL và không tính là đạt (R18).

## 2. Lựa chọn kỳ

| Kỳ | Loại | Nội dung phải chạy | Lý do |
|---|---|---|---|
| Kỳ 1 | [khách điền: tháng ...] | Báo cáo tháng gửi PVN, báo cáo tháng HPM, báo cáo giao ban, báo cáo Ủy ban nếu kỳ rơi vào, báo cáo Nhà máy Đạm Phú Mỹ | Chạy đủ chuỗi nhập, duyệt, rà soát, chốt, phát hành |
| Kỳ 2 | [khách điền: nên là tháng cuối quý] | Thêm Biểu 2 báo cáo quý gửi PVN (có ước cả năm) | Đề xuất để kỳ 2 là cuối quý, vì Biểu 2 chỉ phát sinh theo quý; Ban KHĐT quyết định |

Điều kiện bắt đầu kỳ 1: biên bản chuyển đổi dữ liệu đã ký ([06](06-data-conversion-plan.md)), đào tạo xong ([07](07-training-plan.md)), UAT đạt không còn lỗi P0 hoặc P1 ([05](05-sit-uat-scripts.md)), môi trường Production đã cài (PX-11).

## 3. Lịch trong một kỳ

Mốc ngày lấy từ hiện trạng nêu trong hồ sơ kỹ thuật (số liệu ước chốt ngày 10 đến 15; nhập lại HPM ngày 15 đến 18; giao ban giữa tháng sau). Mốc To-Be do Tổ chuẩn hóa dữ liệu quyết định ([02](02-to-be-process.md) mục 6).

| Mốc | Việc | Chủ | Ghi |
|---|---|---|---|
| T0 | Mở kỳ trên phần mềm; đầu mối bắt đầu nhập đồng thời với lập Excel | Ban KHĐT | |
| T0 đến hạn nhập | Đầu mối nhập; cảnh báo sai sót đến người nhập và người duyệt | Đầu mối | Ghi các cảnh báo hệ thống bắt mà Excel không bắt |
| Hạn nhập | Người duyệt đơn vị duyệt; Ban KHĐT rà soát | Đơn vị, Ban KHĐT | |
| Trước chốt | Chạy đối chiếu bước 1 và 2 (mục 4) | Nhà cung cấp, Ban KHĐT | |
| Chốt | Chốt kỳ trên phần mềm; Excel chốt cùng thời điểm | Ban KHĐT | |
| Sau chốt | Đối chiếu bước 3 đến 6; đẩy HPM môi trường chính thức nếu PX-03 đã có; ghi biên nhận | Ban KHĐT, nhà cung cấp | Excel vẫn là bản gửi chính thức |
| Giao ban | Xem chỉ đạo, kết quả chỉ đạo đưa vào thuyết minh kỳ sau | Ban KHĐT | |
| T+n | Họp kết quả kỳ: danh sách chênh lệch, lỗi, quyết định | Tổ chuẩn hóa dữ liệu | Biên bản mục 7 |

## 4. Các bước đối chiếu

Chạy cho mỗi kỳ, theo thứ tự. Người chạy là nhà cung cấp cùng Ban KHĐT; người xác nhận khác người chạy.

| Bước | Đối chiếu | Cách làm | Công cụ | Dung sai |
|---|---|---|---|---|
| 1 | Đầu vào: số nhập vào phần mềm với số trong tệp Excel của đầu mối | Nạp tệp Excel qua ánh xạ đã duyệt vào kỳ đối chứng, so từng dòng | Chạy thử nhập tệp (`previewIndicatorImport`): dòng khác số hiện là `IND_FIGURE_DIFFERS` trong hàng đợi đối chiếu của khung nhập tệp | 0 đồng cùng cơ sở |
| 2 | Quy tắc: lỗi mà phần mềm chặn hoặc cảnh báo | Liệt kê mọi cảnh báo `BLOCK` và `WARN` đã bắn trong kỳ, xác nhận đúng là lỗi thật hay quy tắc sai | Nhật ký nhập liệu; quy tắc ADM-19 | Mỗi quy tắc sai phải sửa trước chốt |
| 3 | Đầu ra: sáu biểu mẫu từ phần mềm với biểu mẫu Excel đã gửi | So từng ô số: tổng mức đầu tư, kế hoạch, thực hiện, giải ngân, lũy kế, tỷ lệ, cơ cấu vốn | Bản phát hành bất biến có mã băm (RPT-03); bản đồ ô | 0 đồng; tỷ lệ cùng làm tròn hai chữ số |
| 4 | Chéo giữa các báo cáo: số tháng, quý, giao ban, HPM của cùng kỳ | Số kỳ trong các báo cáo khác loại phải khớp (ba tháng bằng quý; giao ban bằng bản chốt) | So sánh chéo cùng kỳ (CN.04), cần ENT-4a; trong lúc chưa có, so bằng tay theo bảng mục 5 | 0 đồng |
| 5 | Kế toán: giải ngân với EBS theo mã dự án | Nạp tệp EBS của Ban TCKT, đối chiếu, giải trình chênh lệch | EBS-01, EBS-02: `OURS_WRONG`, `EBS_WRONG`, `TIMING`, `WAIVED` | Theo `EBS_RECONCILE_POLICY`; chạy trên giả định cho tới khi có PX-04 |
| 6 | HPM: số đã đẩy với số HPM hiển thị | Đẩy, ghi biên nhận, đối chiếu số trên giao diện HPM | HPM-01; khóa chống trùng; đính chính HPM-02 nếu phải thay kỳ đã nhận | 0 đồng; chỉ chạy được khi có PX-03 |
| 7 | Bản chốt: bản chốt của kỳ giữ đúng số đã báo cáo | Mở bản chốt tháng sau, so băm | DIS-21; băm SHA-256 của bản chốt | Băm trùng |
| 8 | Dashboard: số trên dashboard lãnh đạo với bản chốt | So các ô tỷ lệ và tổng | HOME-09; ENT-4d | Khớp với bản chốt |

Tệp Excel đối chứng được lưu cùng băm SHA-256 để tái chạy bước 1 và 3 được.

## 5. Bảng ghi sai lệch (mỗi kỳ một bảng)

| Mã | Kỳ | Dự án | Chỉ tiêu | Excel | Phần mềm | Chênh | Phân loại | Nguyên nhân | Chủ | Hạn | Xử lý | Trạng thái |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [điền khi có] | | | | | | | định nghĩa, thời điểm, lỗi dữ liệu | | | | | Mở, Đã giải trình, Đã sửa, Chấp nhận có quy tắc ký |

Phân loại theo ST-KERNEL-103:

| Loại | Nghĩa | Xử lý |
|---|---|---|
| Định nghĩa | Hai bên tính khác nhau (công thức, cơ sở tính, thuộc kỳ nào) | Tổ chuẩn hóa dữ liệu quyết định định nghĩa; ghi vào từ điển chỉ tiêu qua ADM-19 |
| Thời điểm | Cùng số nhưng khác ngày chốt | Chấp nhận chỉ khi có quy tắc thời điểm đã ký; ghi vào quy tắc |
| Lỗi dữ liệu | Số nhập sai hoặc dữ liệu nguồn sai | Sửa ở nguồn; kỳ đã chốt chỉ sửa qua mở lại có lý do (QT.02) |

Chủ của mục chênh lệch không là người nạp tệp (quy tắc của khung nhập tệp và EBS). Mục không có chủ hoặc quá hạn xử lý là một trong những điều kiện chặn nghiệm thu.

## 6. Tiêu chí kết thúc vận hành thử

Đề xuất lấy từ cổng chạy song song của nền tảng (ST-DIS-024, ST-KERNEL-103); Tổ chuẩn hóa dữ liệu xác nhận:

1. Hai kỳ thực tế đã chạy đủ các bước 1 đến 8 (bước 6 khi có HPM chính thức).
2. Không còn chênh lệch tiền không giải thích được; mọi chênh lệch còn lại có phân loại và chủ; chênh lệch thời điểm hoặc làm tròn chỉ còn dưới quy tắc đã ký.
3. Không còn lỗi P0 hoặc P1 mở. P0: rò dữ liệu, sai tiền đã công bố, mất dữ liệu, vượt quyền. P1: luồng lõi không hoàn thành, không có cách xử lý chấp nhận được.
4. Người dùng hoàn thành tác vụ lõi không trợ giúp: không dưới 90% tác vụ, SUS từ 80 (đo, không tự khai), theo mục tiêu của nền tảng (BRD, ST-KERNEL-103).
5. Báo cáo đúng hạn: không dưới 95% trong hai kỳ song song (BRD, KPI báo cáo đúng hạn).
6. Pentest độc lập đạt (YCK.07, PX-09) và đã có biên bản khắc phục và retest.
7. Chốt kỳ, mở lại kỳ, đẩy HPM đều có nhật ký đủ người, thời điểm, lý do (HT.06).

Mục 4 và 5 là mục tiêu của nền tảng; PVFCCo có thể đặt ngưỡng khác: `[khách điền: ngưỡng chấp nhận]`.

## 7. Mẫu biên bản vận hành thử (sản phẩm 9, phần 1)

```
BIÊN BẢN VẬN HÀNH THỬ SONG SONG
Số: [khách điền]            Ngày: [khách điền]
1. Kỳ đã chạy: kỳ 1 [..], kỳ 2 [..]; thời gian từ [..] đến [..]
2. Thành phần: Ban KHĐT [..], 09 đầu mối [..], Ban TCKT [..], Ban CĐS&CNTT [..], nhà cung cấp [..]
3. Kết quả theo bước đối chiếu 1 đến 8 (mỗi kỳ)
   | Bước | Kỳ 1 | Kỳ 2 | Số chênh lệch còn | Ghi chú |
4. Bảng sai lệch (đính kèm, mục 5): tổng [..]; đã giải trình [..]; còn mở [..]
5. Lỗi: P0 mở [..]; P1 mở [..]; P2, P3 mở [..] (đính kèm danh sách)
6. Đo người dùng: tỷ lệ tác vụ không trợ giúp [..]%; SUS [..]; báo cáo đúng hạn [..]%
7. Việc đẩy HPM môi trường chính thức: [ ] đã đẩy, biên nhận số [..]  [ ] chưa đẩy, lý do [..]
8. Tồn tại và kế hoạch khắc phục: [khách điền]
9. Kết luận: [ ] Đạt, chuyển nghiệm thu  [ ] Đạt có điều kiện  [ ] Chưa đạt, chạy thêm kỳ
Chữ ký: Trưởng Ban KHĐT [khách điền]   Đại diện 09 đầu mối [khách điền]
        Ban CĐS&CNTT [khách điền]   Nhà cung cấp [khách điền]
```

## 8. Rủi ro

1. Hai nguồn nhập cùng lúc làm tăng việc cho đầu mối: giảm bằng nhập từ tệp Excel qua ánh xạ đã duyệt (IND-03) thay vì gõ lại.
2. Mẫu biểu chính thức chưa có (PX-01): bước 3 so với biểu Excel thật của khách, không phải sáu biểu DEMO; nếu bố cục khác thì phải làm lại bảng ô tương ứng trước kỳ 1.
3. HPM chưa có giao diện (PX-03): bước 6 chưa chạy được; biên bản ghi rõ.
4. Hai kỳ có thể không đủ để gặp trường hợp mở lại kỳ: Tổ chuẩn hóa dữ liệu nên chủ động diễn tập một lần mở lại kỳ trên môi trường UAT trong thời gian chạy thử.

Lịch sử sửa: v0.1 khung ngày 2026-11-09.
