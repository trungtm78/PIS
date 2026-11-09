# 11. Sổ các mục chờ khách (PENDING-EXTERNAL)

Dòng ma trận: GD.1 đến GD.7 và mọi mã có nhãn PENDING-EXTERNAL. Nguồn nguyên tắc: rà soát kỹ thuật ENT-3, quy tắc R18 ("không nghiệm thu khi chưa có tài liệu hoặc quyết định của khách"). Dữ liệu gốc của sổ nằm ở `docs/hskt/requirements.json` (khóa `pendingExternal`); bảng dưới và bảng cuối `docs/hskt/TRACEABILITY.md` cùng một nguồn. Kiểm tra `node scripts/hskt-trace.mjs check` báo lỗi khi một mã PX-nn của dữ liệu không có trong tệp này, hoặc không dòng nào dùng.

Cách hiểu: phần mềm đã dựng sẵn với bộ giả định gắn nhãn; các giả định được ghi ở cột "Giả định đang dùng". Mọi con số, biểu mẫu, kết nối dựng trên giả định không được tính vào nghiệm thu, và các đầu ra mang nhãn tương ứng (DEMO, UNVERIFIED, `acceptance: PENDING_EXTERNAL`).

---

## 1. Sổ

| Mã | Khách cần cung cấp | Đơn vị cung cấp | Cần trước | Giả định đang dùng | Chặn các mã yêu cầu | Tình trạng |
| --- | --- | --- | --- | --- | --- | --- |
| PX-01 | Bố cục chính thức của 06 biểu mẫu báo cáo (PVN tháng, PVN quý Biểu 2, HPM tháng, Ủy ban ĐTPT-KHCN, giao ban đầu tư, ĐTXD và CTSC Nhà máy Đạm Phú Mỹ) | Ban KHĐT | GĐ 1 (trước khóa thiết kế biểu mẫu) | Sáu biểu mẫu DEMO do hệ thống thiết kế (`docs/report-engine.md`), mọi đầu ra đóng dấu MẪU DEMO | BC.01 | Chưa nhận |
| PX-02 | Từ điển chỉ tiêu và bộ nguyên tắc nhập liệu đã được Tổ chuẩn hóa dữ liệu thống nhất | Tổ chuẩn hóa dữ liệu, Ban KHĐT | GĐ 1 | Chỉ tiêu, quy tắc và bảng ánh xạ khởi điểm gắn `legalStatus: UNVERIFIED` (`docs/ind-indicator-dictionary.md`) | DL.01, DL.02, TK.03, SP.04 | Chưa nhận |
| PX-03 | Thông tin kỹ thuật HPM: nền tảng, đơn vị phát triển, khả năng mở API, cấu trúc dữ liệu nhận | Ban CĐS&CNTT | GĐ 2 (thiết kế tích hợp) | Gói giao nhận ghi ra tệp `HPM-FILE-WORKING-ASSUMPTION-2026.1`, người ghi biên nhận (`docs/hpm-ebs-connectors.md`) | QT.01, TH.01, GD.2, GD.6, SP.03 | Chưa nhận |
| PX-04 | Mẫu tệp xuất từ Oracle EBS và quyền đọc (tệp, DB hay API); phạm vi và phương thức đối chiếu | Ban TCKT, Ban CĐS&CNTT | GĐ 2 | Bố cục `WORKING-ASSUMPTION-2026.1`: project_code, period, extract_date, disbursed_vnd, committed_vnd | CN.04, TH.03 | Chưa nhận |
| PX-05 | Danh sách 09 đầu mối (07 Ban/Đơn vị và 02 Tổ dự án, kèm tên 02 Tổ dự án), người nhập liệu và người phê duyệt của từng đầu mối, nhân sự Ban KHĐT và lãnh đạo | Tổ chuẩn hóa dữ liệu | GĐ 1 (khảo sát) và GĐ 5 (đào tạo) | Gói cấu hình mẫu PVFCCO-TEMPLATE, không dùng tên thật (ENT-3d) | HT.02, TK.01, GD.1, GD.5, SP.01, SP.07 | Chưa nhận |
| PX-06 | Đặc tả kết nối eProcurement (số liệu mua sắm trang thiết bị dự án) và cách lấy dữ liệu | Ban Thương mại, Ban CĐS&CNTT | GĐ 2 | Nhập tay và nhập tệp theo biểu mẫu; chưa có bộ kết nối | CN.02, TH.03 | Chưa nhận |
| PX-07 | Đặc tả hệ thống văn thư (văn bản pháp lý) và hệ thống xác thực tập trung của Tổng công ty | Ban CĐS&CNTT | GĐ 2 | Tệp đính kèm tải lên; xác thực qua Keycloak liên kết AD (`docs/runbooks/infra/keycloak.md`) | MD.02, TH.03 | Chưa nhận |
| PX-08 | Phạm vi dữ liệu lịch sử cần chuyển đổi (từ năm nào, những biểu nào) | Ban KHĐT | GĐ 1 | Kỳ vận hành đầu tiên làm mốc; lịch sử chỉ nạp sau khi Ban KHĐT chốt phạm vi | DL.03, TK.03, GD.5, SP.06 | Chưa nhận |
| PX-09 | Đơn vị độc lập rà soát mã nguồn và kiểm thử xâm nhập được PVFCCo chấp thuận; giấy phép dịch vụ; kết quả và retest | PVFCCo (chấp thuận), nhà cung cấp (thuê) | GĐ 4 đến GĐ 6 (điều kiện nghiệm thu) | Gói sẵn sàng pentest `docs/security/pentest-readiness.md`; chưa có báo cáo độc lập | YCK.07, GD.6, SP.08 | Chưa nhận |
| PX-10 | Cấu hình phần cứng thực của máy chủ UAT và Production để đo hiệu năng (phản hồi dưới 5 giây, báo cáo dưới 20 giây) | Ban CĐS&CNTT | GĐ 4 | Ngân sách hiệu năng `docs/qa/perf-budget.json` đo trên máy phát triển | HT.05 | Chưa nhận |
| PX-11 | Hạ tầng máy chủ hai môi trường UAT và Production, tài khoản truy cập HPM, EBS, Data Lakehouse, SMTP và Teams | Ban CĐS&CNTT | GĐ 3 (môi trường UAT), GĐ 6 (Production) | Gói cài ngoại tuyến `docs/runbooks/infra/onprem-install.md` thử trên máy của nhà cung cấp | TH.02, HT.01, YCK.02, YCK.06, TK.01, GD.3 | Chưa nhận |
| PX-12 | Phê duyệt của PVFCCo cho từng giai đoạn và từng sản phẩm bàn giao (chữ ký, ngày) theo mục II.2.3 và II.5 | PVFCCo | Cuối mỗi giai đoạn | Mẫu phiếu phê duyệt ở `docs/delivery/README.md`; chưa có chữ ký | GD.1, GD.2, GD.3, GD.4, GD.7, SP.01, SP.02, SP.03, SP.05, SP.06, SP.07, SP.09, SP.10, SP.11 | Chưa nhận |
| PX-13 | Hai kỳ báo cáo thực tế để vận hành song song với biểu mẫu Excel và số liệu Excel của hai kỳ đó | 09 đầu mối, Ban KHĐT | GĐ 6 | Kế hoạch và mẫu đối chiếu ở `docs/delivery/08-parallel-run-plan.md`; chưa có kỳ thực tế | TK.04, GD.6, SP.09 | Chưa nhận |
| PX-14 | Danh mục dự án chính thức (22 dự án đầu tư xây dựng, 01 hạng mục mua sắm tài sản dự án, 09 hạng mục mua sắm tài sản cố định), mã HPM và mã EBS từng dự án, cấp quản lý cấp dưới dự án do Ban KHĐT xác nhận | Ban KHĐT | GĐ 1 | Dữ liệu minh họa của clip và bản chuyển đổi mẫu; không dùng làm số liệu thật | MD.01, TK.03, GD.5, SP.04 | Chưa nhận |
| PX-15 | Mẫu báo cáo của Sở/Ban/Ngành cần gửi (theo mẫu của đơn vị yêu cầu) | Ban KHĐT | GĐ 2 | Chưa có mẫu; công cụ cấu hình bố cục ENT-4b dựng sẵn | BC.01 | Chưa nhận |
| PX-16 | Thông tin SSO/LDAP/Active Directory (nhóm AD theo vai trò), SMTP và địa chỉ Teams để gửi nhắc việc | Ban CĐS&CNTT | GĐ 3 | Realm Keycloak mẫu và bảng ánh xạ nhóm AD mẫu (`infra/keycloak`) | QT.02, HT.02, YCK.01, YCK.07 | Chưa nhận |
| PX-17 | Ước tính số người dùng (nhập liệu, phê duyệt, Ban KHĐT, lãnh đạo, quản trị) để tính năng lực hạ tầng | Tổ chuẩn hóa dữ liệu | GĐ 2 | Phần mềm không giới hạn bản quyền theo số người dùng; chưa có con số | YCK.02, YCK.03 | Chưa nhận |

Cột "Tình trạng" của sổ này do người giữ hợp đồng cập nhật khi nhận tài liệu; khi đổi, sửa đồng thời dòng ma trận tương ứng.

## 2. Hậu quả nếu chưa có

| Mã | Điều không làm được | Điều vẫn làm được |
|---|---|---|
| PX-01 | Nghiệm thu biểu mẫu BC.01 theo bố cục chính thức; gửi PVN bằng bản phần mềm | Dựng, xuất, thử sáu biểu mẫu DEMO có dấu; thay mẫu theo hướng dẫn ở `docs/report-engine.md` |
| PX-02 | Nghiệm thu từ điển chỉ tiêu và quy tắc nhập liệu (SP.04) | Nhập, kiểm tra, nhập Excel theo bộ khởi điểm; thay bằng bản chính thức qua màn ADM-19 mà không sửa mã |
| PX-03 | Nghiệm thu đẩy HPM; xác nhận biên nhận thật | Đẩy ra tệp, thử đẩy lại, biên nhận do người ghi; đính chính |
| PX-04 | Nghiệm thu đối chiếu EBS | Nạp tệp theo bố cục giả định, đối chiếu và giải trình chênh lệch |
| PX-05 | Cấu hình tài khoản thật; đào tạo đúng người | Gói mẫu PVFCCO-TEMPLATE; đào tạo trên dữ liệu tổng hợp |
| PX-06, PX-07 | Kết nối eProcurement, văn thư | Nhập tay hoặc tệp; đính kèm tệp |
| PX-08 | Chuyển đổi dữ liệu lịch sử | Chuyển danh mục, kế hoạch năm và số dư đầu kỳ |
| PX-09 | Nghiệm thu đưa vào sử dụng (điều kiện bắt buộc) | Chuẩn bị theo `docs/security/pentest-readiness.md`, rà soát nội bộ |
| PX-10 | Chứng minh HT.05 trên phần cứng khách | Đo trên máy của nhà cung cấp |
| PX-11 | Cài thử lên UAT, Production; hiệu năng thật; diễn tập khôi phục trên máy khách; nhắc việc qua email và Teams thật | Cài thử từ gói ngoại tuyến trên máy nhà cung cấp |
| PX-12 | Chuyển giai đoạn theo nguyên tắc Waterfall | Soạn sản phẩm của giai đoạn kế trên cơ sở giả định, đánh dấu nháp |
| PX-13 | Biên bản vận hành thử; nghiệm thu | Chạy thử nội bộ trên dữ liệu đào tạo |
| PX-14 | Nạp danh mục dự án thật; mã HPM, EBS | Dữ liệu minh họa |
| PX-15 | Mẫu Sở/Ban/Ngành | Công cụ cấu hình bố cục (ENT-4b) |
| PX-16 | Đăng nhập AD thật; email, Teams thật | Realm mẫu, nhắc việc trong hệ thống |
| PX-17 | Cấu hình hạ tầng khuyến nghị theo số người dùng | Cấu hình khuyến nghị theo kịch bản mẫu |

## 3. Phiếu gửi yêu cầu và xác nhận (mẫu)

Mỗi lần xin, nhà cung cấp gửi một phiếu; khi nhận, ghi băm tệp và ngày.

```
PHIẾU YÊU CẦU CUNG CẤP THÔNG TIN
Mã mục chờ: PX-[..]        Giai đoạn cần: GĐ [..]        Hạn nhận: [khách điền]
Gửi: [đơn vị cung cấp]     Từ: [nhà cung cấp]            Ngày gửi: [..]
Nội dung cần: [chép từ cột "Khách cần cung cấp"]
Định dạng mong muốn: [tệp mẫu Excel, tài liệu kỹ thuật, danh sách]
Dùng để: [mã yêu cầu bị chặn]
-- phần trả lời --
Đã nhận: [ ] đủ  [ ] một phần, còn thiếu: [..]
Tệp: [tên]    Băm SHA-256: [..]    Ngày nhận: [..]    Người giao: [khách điền]
Người xác nhận của PVFCCo: [khách điền]    Chữ ký: [khách điền]
Giả định đã thay bằng dữ liệu thật: [ ] có  [ ] chưa (lý do: [..])
```

## 4. Các quyết định (không phải tài liệu) khách cần đưa ra

Những điểm hồ sơ kỹ thuật để ngoặc vuông, cần Tổ chuẩn hóa dữ liệu chốt. Các điểm này không có mã PX riêng vì không chặn phần mềm, nhưng chặn phê duyệt To-Be và SRS (PX-12):

1. Cấp quản lý dưới dự án giai đoạn 1 (MD.01); phạm vi quản lý số ước (DL.01).
2. Loại hình "sửa chữa lớn" có chính thức không (MD.01).
3. Hạn từng bước theo từng loại kỳ; quy tắc ghi đè kỳ hay điều chỉnh ở kỳ sau (QT.02, TH.01).
4. Ngưỡng chênh lệch cho phép khi đối chiếu EBS và so sánh chéo báo cáo (CN.04).
5. Quy trình bổ sung ngoài điều chỉnh kế hoạch và chỉ đạo giao ban (QT.02).
6. Số kỳ vận hành song song và ngưỡng chấp nhận người dùng (TK.04).

## 5. Ghi chú về những thứ ngoài mã

Các việc chỉ chuẩn bị, do nhà cung cấp hoặc bên thứ ba thực hiện: thuê đơn vị rà soát mã nguồn và pentest độc lập, đo hiệu năng trên phần cứng của khách, vận hành thử hai kỳ thực tế, đào tạo tại 09 đầu mối. Chúng nằm trong sổ ở dạng PX-09, PX-10, PX-13 và PX-05.

Lịch sử sửa: v0.1 ngày 2026-11-09, sinh từ `docs/hskt/requirements.json`.
