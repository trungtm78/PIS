# Bộ hồ sơ giao nhận theo mô hình Waterfall

Bộ hồ sơ này đáp ứng mục II.2.3 (bảy giai đoạn) và II.5 (mười một sản phẩm bàn giao) của Hồ sơ kỹ thuật "Phần mềm quản lý đầu tư xây dựng" v0.3 của PVFCCo (bản 26 11 03). Các tệp là khung do hệ thống sinh từ tài liệu thiết kế và mã nguồn đã có: phần nào kho mã đã biết thì được điền và dẫn nguồn; phần chỉ khách biết được để trống dạng `[khách điền: ...]`. Không có số liệu nào được bịa. Mọi mục chờ khách nằm trong sổ ở [11-pending-external-register.md](11-pending-external-register.md) và không được tính vào nghiệm thu (quy tắc R18 của rà soát kỹ thuật).

Ma trận truy vết từng mã yêu cầu tới màn hình, thao tác, câu chuyện, tài liệu và kiểm thử: [../hskt/TRACEABILITY.md](../hskt/TRACEABILITY.md), sinh từ [../hskt/requirements.json](../hskt/requirements.json) bằng `node scripts/hskt-trace.mjs generate`; `node scripts/hskt-trace.mjs check` (trong `npm run qa:check`) báo lỗi khi ma trận và kho mã lệch nhau.

## Bảy giai đoạn và nơi nằm sản phẩm

Nguyên tắc của hồ sơ kỹ thuật: các giai đoạn thực hiện tuần tự; chỉ sang giai đoạn sau khi sản phẩm của giai đoạn trước được PVFCCo xác nhận hoặc phê duyệt. Cột "PVFCCo phê duyệt" lấy nguyên từ bảng ở mục II.2.3.

| GĐ | Giai đoạn | Sản phẩm đầu ra theo hồ sơ kỹ thuật | Tệp trong bộ hồ sơ này | PVFCCo phê duyệt | Dòng ma trận |
|---|---|---|---|---|---|
| 1 | Khảo sát hiện trạng, phân tích yêu cầu | Báo cáo khảo sát As-Is; Tài liệu yêu cầu người dùng (URD) | [01](01-as-is-survey-and-urd.md) | Có | GD.1, SP.01 |
| 2 | Thiết kế tương lai | Quy trình To-Be; SRS; tài liệu thiết kế hệ thống; thiết kế tích hợp HPM/ERP/Lakehouse | [02](02-to-be-process.md), [03](03-srs-mapping.md), [04](04-system-and-integration-design.md) | Có (quy trình To-Be và SRS) | GD.2, SP.02, SP.03 |
| 3 | Xây dựng, cấu hình | Phần mềm trên môi trường UAT; kịch bản kiểm thử (SIT, UAT) | [05](05-sit-uat-scripts.md) | Kịch bản kiểm thử | GD.3, SP.05 |
| 4 | Kiểm nghiệm | Biên bản kiểm thử UAT; danh sách lỗi và kết quả khắc phục | [05](05-sit-uat-scripts.md), [09](09-acceptance-minutes-template.md) | Có | GD.4, SP.05 |
| 5 | Chuyển đổi dữ liệu, đào tạo | Biên bản xác nhận chuyển đổi dữ liệu; biên bản đào tạo; tài liệu và video hướng dẫn | [06](06-data-conversion-plan.md), [07](07-training-plan.md) | Có | GD.5, SP.04, SP.06, SP.07 |
| 6 | Vận hành thử, nghiệm thu | Biên bản vận hành thử; biên bản nghiệm thu; bộ tài liệu bàn giao | [08](08-parallel-run-plan.md), [09](09-acceptance-minutes-template.md), [10](10-handover-checklist.md) | Có | GD.6, SP.08, SP.09, SP.10 |
| 7 | Bảo hành, bảo trì | Báo cáo bảo trì định kỳ (II.5 không liệt kê thành sản phẩm đánh số) | [12](12-maintenance-and-hypercare.md) (hỗ trợ, hypercare, lịch kỳ chốt, mẫu báo cáo bảo trì), [10](10-handover-checklist.md) (mục bảo hành), `docs/runbooks/release-checklist.md` | không áp dụng | GD.7 |

Kế hoạch chi tiết bảy giai đoạn phải được nhà cung cấp trình PVFCCo trong vòng 10 ngày sau khi ký hợp đồng (mục II.4); tệp này là khung của kế hoạch đó, không thay thế nó.

## Mười một sản phẩm bàn giao (mục II.5)

| STT | Sản phẩm | Cần phê duyệt | Tệp |
|---|---|---|---|
| 1 | Báo cáo khảo sát hiện trạng và URD | Có | 01 |
| 2 | Quy trình quản lý To-Be | Có | 02 |
| 3 | SRS, thiết kế hệ thống, thiết kế tích hợp | Có | 03, 04 |
| 4 | Bộ master data và từ điển chỉ tiêu đã chuẩn hóa, khởi tạo trên hệ thống | Có | 06 (phần ánh xạ), `docs/ind-indicator-dictionary.md` |
| 5 | Kịch bản kiểm thử và biên bản kiểm thử chấp nhận (UAT) | Có | 05, 09 |
| 6 | Biên bản xác nhận chuyển đổi dữ liệu | Có | 06 |
| 7 | Biên bản xác nhận đào tạo; tài liệu và video hướng dẫn | Có | 07 |
| 8 | Báo cáo rà soát mã nguồn và pentest của đơn vị độc lập; báo cáo khắc phục và retest | Có | 10 (mục an toàn thông tin), `docs/security/pentest-readiness.md` |
| 9 | Biên bản vận hành thử và biên bản nghiệm thu | Có | 08, 09 |
| 10 | Bộ tài liệu bàn giao: cài đặt, vận hành, quản trị; mã nguồn hoặc gói cài đặt và cấu hình; tài liệu API | không ghi | 10 |
| 11 | Sản phẩm khác theo Điều lệ dự án | không ghi | chờ Điều lệ dự án |

## Tình trạng bộ hồ sơ (rà soát 2026-11-12, lane aud4)

Các tệp 01 đến 10 đã được điền lại đến v0.2 từ thiết kế và mã nguồn sau khi các làn ENT-3, ENT-4, INFRA-2, DOC-3 gộp; tệp 12 (bảo hành, hypercare, lịch hỗ trợ kỳ chốt, mẫu báo cáo bảo trì) là tệp mới. Ma trận truy vết: 3 dòng DONE, 29 PARTIAL, 21 PENDING-EXTERNAL (cập nhật bằng `node scripts/hskt-trace.mjs generate`).

| Dòng | Tình trạng | Việc còn lại và bên làm |
|---|---|---|
| GD.1, SP.01 | PENDING-EXTERNAL | Khảo sát tại 09 đầu mối và phê duyệt: PX-05, PX-12 |
| GD.2, SP.02, SP.03 | PENDING-EXTERNAL | Chốt hạn từng bước, cấu trúc HPM, phê duyệt: PX-03, PX-12 |
| GD.3, GD.4, SP.05 | PARTIAL | Nhà cung cấp: sinh nốt 399 ca UAT và các phân hệ chưa có thư mục, chạy UAT ký được; khách: môi trường UAT, ký (PX-11, PX-12) |
| GD.5, SP.04, SP.06, SP.07, TK.01, TK.03 | PENDING-EXTERNAL | Tệp Excel, danh mục dự án, từ điển chỉ tiêu, danh sách người học: PX-02, PX-05, PX-08, PX-14 |
| GD.6, SP.08, SP.09, TK.04 | PENDING-EXTERNAL | Hai kỳ báo cáo thực, giao diện HPM, pentest độc lập: PX-13, PX-03, PX-09 |
| GD.7 | PENDING-EXTERNAL | Bắt đầu sau nghiệm thu; đường liên hệ, người trực, thời hạn phản hồi (D10), PX-12 |
| SP.10 | PENDING-EXTERNAL | Gói cài với tên máy chủ chính thức, biên bản bàn giao ký: PX-11, PX-12 |
| SP.11 | PENDING-EXTERNAL | Điều lệ dự án |
| TK.02 | PARTIAL | Video hướng dẫn (đã dừng, cần quyết định với PVFCCo) và bản cứng |

## Phiếu phê duyệt giai đoạn (mẫu dùng chung)

Mỗi giai đoạn kết thúc bằng một phiếu; chỉ sau khi phiếu có đủ chữ ký thì giai đoạn sau mới bắt đầu. Ngày và chữ ký là việc của PVFCCo (mục PX-12 của sổ).

| Trường | Nội dung |
|---|---|
| Giai đoạn | GĐ [số], [tên giai đoạn] |
| Sản phẩm trình duyệt | [tên tệp và phiên bản; băm SHA-256 của bản trình] |
| Ngày trình | [khách điền: ngày] |
| Người trình (nhà cung cấp) | [khách điền: họ tên, chức danh] |
| Đơn vị xem xét | Tổ chuẩn hóa dữ liệu; Ban CĐS&CNTT giám sát kỹ thuật |
| Kết quả | [ ] Phê duyệt  [ ] Phê duyệt kèm yêu cầu chỉnh sửa  [ ] Chưa đạt |
| Ý kiến, yêu cầu chỉnh sửa | [khách điền] |
| Chữ ký Trưởng Ban KHĐT, Tổ trưởng Tổ chuẩn hóa dữ liệu | [khách điền] |
| Chữ ký Phó Ban phụ trách Ban CĐS&CNTT | [khách điền] |
| Phê duyệt của Tổng Giám đốc (khi hồ sơ kỹ thuật yêu cầu) | [khách điền] |

Cấp ký lấy từ khối ký của hồ sơ kỹ thuật (soạn thảo, kiểm tra, phê duyệt); nếu PVFCCo quy định khác thì thay trong phiếu, không đổi nguyên tắc.

## Cách dùng và cập nhật

1. Mỗi tệp có phần "Nguồn" liệt kê tài liệu của kho mã đã dùng; khi tài liệu nguồn đổi thì cập nhật tệp tương ứng và dòng ma trận.
2. Trường `[khách điền: ...]` chỉ được điền bằng thông tin do PVFCCo cung cấp, ghi rõ người cung cấp và ngày trong phần "Lịch sử sửa" của tệp.
3. Khi một mục trong sổ PX được khách cung cấp: chuyển trạng thái trong sổ, sửa dòng ma trận (`docs/hskt/requirements.json`), sinh lại ma trận.
4. Tệp tiếng Việt, tên tệp tiếng Anh; chỉ có Markdown, cổng kiểm tra mã không quét thư mục này nhưng `check` của ma trận kiểm sự tồn tại của các tệp được dẫn.
