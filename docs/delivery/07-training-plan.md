# 07. Kế hoạch đào tạo và mẫu biên bản xác nhận đào tạo

Giai đoạn 5, sản phẩm 7 của mục II.5 (biên bản xác nhận đào tạo; tài liệu và video hướng dẫn). Dòng ma trận: TK.01, TK.02, GD.5, SP.07. PVFCCo phê duyệt: có.

Hồ sơ kỹ thuật (TK.01): đào tạo người dùng cuối tại 09 đầu mối và Ban KHĐT (nhập liệu, phê duyệt, rà soát, lập báo cáo); đào tạo Lãnh đạo khai thác dashboard; đào tạo quản trị hệ thống cho Ban CĐS&CNTT.

Nguồn: bộ hướng dẫn sử dụng `scripts/hdsd/chapters.json` (91 chương: ba chương theo luồng (đăng nhập, danh mục địa bàn, tạo dự án), 74 chương theo nhóm màn hình `tour-*` và mười bốn chương điện thoại `m01` đến `m14`), `scripts/hdsd/overview.json`; kịch bản hai video `docs/clips/enterprise-phu-my.script.md` và `docs/clips/public-investment.script.md` (chương video của bản PVFCCo: giới thiệu, tổng quan điều hành, cơ cấu vốn và kế hoạch, dự án, báo cáo gửi Tập đoàn, quy trình duyệt số liệu kỳ, đẩy số HPM và đối chiếu kế toán, chỉ đạo giao ban, hồ sơ dự án và trợ lý AI, tin cậy và kết thúc); câu chuyện ST-KERNEL-104 (chương trình đào tạo theo vai trò, môi trường đào tạo dữ liệu tổng hợp) và ST-KERNEL-103 (người dùng thử); `docs/pwa.md`.

Trạng thái tệp: KHUNG. Chưa có danh sách người học, lịch, địa điểm, môi trường đào tạo của khách (PX-05, PX-11). Nội dung giáo trình đã gắn vào các chương hướng dẫn có sẵn.

---

## 1. Đối tượng và nhóm đào tạo

| Nhóm | Ai | Số người | Mục tiêu sau khóa | Thời lượng đề xuất |
|---|---|---|---|---|
| A. Người nhập liệu và người phê duyệt tại đơn vị | 01 người nhập và 01 người phê duyệt mỗi đầu mối, 09 đầu mối (BBH 43/BBH-KHĐT) | 18 theo số đầu mối; [khách điền: số thực] | Nhập hoặc nhập từ Excel, sửa theo cảnh báo, gửi; phê duyệt hoặc trả về kèm ý kiến | [khách điền] (đề xuất 1 buổi mỗi nhóm) |
| B. Ban KHĐT | Người rà soát, chốt kỳ, đẩy HPM, lập biểu mẫu | [khách điền] | Rà soát, trả về, chốt và mở lại kỳ, lập và phát hành sáu biểu mẫu, đẩy HPM, đối chiếu EBS, ghi chỉ đạo giao ban | [khách điền] (đề xuất 2 buổi) |
| C. Lãnh đạo | Ban Tổng Giám đốc, Hội đồng quản trị, lãnh đạo ban | [khách điền] | Đọc dashboard, truy nguồn con số, giao và theo dõi chỉ đạo, duyệt trên điện thoại (PWA) | [khách điền] (đề xuất 1 buổi ngắn) |
| D. Quản trị hệ thống | Ban CĐS&CNTT | [khách điền] | Phân quyền, ủy quyền, danh mục, quy tắc và bảng ánh xạ, quy trình duyệt, kết nối HPM, EBS, nhật ký, sao lưu và khôi phục, bảo mật, nâng cấp | [khách điền] (đề xuất 2 buổi) |
| E. Ban TCKT | Người cung cấp tệp EBS và giải trình chênh lệch | [khách điền] | Nạp tệp EBS, đọc đối chiếu, giải trình chênh lệch | [khách điền] (đề xuất nửa buổi) |

Thời lượng và số người là đề xuất khung; Tổ chuẩn hóa dữ liệu quyết định.

## 2. Giáo trình theo nhóm

Mỗi mục trỏ tới chương hướng dẫn có sẵn trong `scripts/hdsd/chapters.json` và chương video. Các chương `tour-*` mô tả theo nhóm màn hình của nền tảng; phần riêng bản enterprise (IND, RPT, DIR, HPM, EBS) học bằng bài thực hành ở mục 3 cho tới khi có chương hướng dẫn riêng (khoảng trống của TK.02, làn DOC-3).

| Nhóm | Chương hướng dẫn (id) | Chương video | Bài thực hành riêng bản enterprise |
|---|---|---|---|
| A | `01-dang-nhap`, `tour-iam-truy-cap`, `tour-iam-khong-gian-ca-nhan`, `tour-dis-lap-gui-bao-cao`, `tour-home-cong-viec-canh-bao` | Quy trình duyệt số liệu kỳ | Nhập chỉ tiêu và nhập từ Excel (IND-02, IND-03); đọc cảnh báo vi phạm quy tắc; gửi và nhận trả về |
| B | `tour-dis-quan-ly-ky-bao-cao`, `tour-dis-tong-hop-phan-tich`, `tour-cap-ke-hoach-von`, `tour-cap-dieu-hanh-theo-ky`, `tour-prj-danh-muc-theo-doi`, `tour-adm-quy-trinh-cau-hinh` | Báo cáo gửi Tập đoàn; Đẩy số HPM và đối chiếu kế toán; Chỉ đạo giao ban; Cơ cấu vốn và kế hoạch | Chốt kỳ, mở lại kỳ; phát hành biểu mẫu từ bản chốt; đẩy HPM, đẩy lại, ghi biên nhận (HPM-01); đối chiếu EBS (EBS-01, EBS-02); ghi cuộc giao ban (DIR-01 đến DIR-04) |
| C | `tour-home-buc-tranh-tong-the`, `tour-home-cong-viec-canh-bao`, `tour-bi-kham-pha-thiet-ke`, `m01-dang-nhap-dien-thoai`, `m02-trang-chu-dien-thoai` | Tổng quan điều hành; Dự án đầu tư xây dựng | Cài PWA, duyệt trong hàng đợi, xem dashboard, theo dõi chỉ đạo (PWA-01 đến PWA-04, `docs/pwa.md`); đọc chỉ đạo giao ban (DIR-06) |
| D | `tour-adm-to-chuc-con-nguoi`, `tour-adm-quy-trinh-cau-hinh`, `tour-adm-tich-hop-an-toan`, `tour-mdm-to-chuc-dau-tu`, `tour-mdm-nghiep-vu-quy-uoc`, `tour-mdm-vong-doi-danh-muc`, `tour-sas-van-hanh-nen-tang` | Tin cậy và kết thúc | Soạn và duyệt bảng ánh xạ, quy tắc nhập liệu (ADM-19, IND-01 đến IND-03); cấu hình quy trình (ADM-06); ủy quyền; xem nhật ký (ADM-11); xem hub tích hợp (HUB-01 đến HUB-03); sao lưu và khôi phục theo runbook |
| E | `01-dang-nhap` | Đẩy số HPM và đối chiếu kế toán | Tải tệp EBS, chạy thử, đọc chênh lệch, giải trình (EBS-01, EBS-02) |

Tài liệu chuẩn bị riêng cho quản trị (nhóm D): `docs/runbooks/infra/onprem-install.md`, `docs/runbooks/infra/backup-immutable.md`, `docs/runbooks/infra/restore-drill.md`, `docs/runbooks/infra/onprem-upgrade-rollback.md`, `docs/runbooks/release-checklist.md`, `docs/open-api.md`, `docs/integration-hub.md`, `docs/security/identity-test-plan.md`. Hướng dẫn quản trị hoàn chỉnh bằng tiếng Việt: làn DOC-3.

## 3. Bài thực hành

Mọi bài làm trên môi trường đào tạo với dữ liệu tổng hợp, không trên dữ liệu thật (ST-KERNEL-104). Dữ liệu minh họa của clip (`docs/clip-data.md`) là nguồn dữ liệu đào tạo; sáu biểu mẫu vẫn mang dấu MẪU DEMO.

| Bài | Nhóm | Việc làm | Kết quả đạt |
|---|---|---|---|
| T1 | A | Đăng nhập, đổi mật khẩu, bật xác thực hai bước | Vào được hệ thống bằng tài khoản mình |
| T2 | A | Nhập số liệu một dự án có lỗi cố ý (lũy kế vượt tổng mức đầu tư); đọc cảnh báo; sửa; gửi | Gửi thành công sau khi sửa |
| T3 | A | Nhập từ tệp Excel mẫu: chạy thử, đọc dòng lỗi, sửa tệp, áp dụng | Chạy thử không ghi gì; áp dụng một lần |
| T4 | A | Người phê duyệt: duyệt một báo cáo và trả về một báo cáo kèm lý do | Hiểu người nhập không tự duyệt được |
| T5 | B | Rà soát, trả về, chốt kỳ; mở lại kỳ có lý do | Kỳ đã chốt không đổi; mở lại có người duyệt khác |
| T6 | B | Lập và phát hành một biểu mẫu từ bản chốt; tải Excel và Word | Mở đúng mẫu, đúng dấu DEMO |
| T7 | B | Đẩy HPM, gặp lỗi, đẩy lại, ghi biên nhận | Không đẩy trùng; hiểu chờ biên nhận |
| T8 | B, E | Nạp tệp EBS, đối chiếu, giải trình một chênh lệch | Có người nhận, hạn, lý do |
| T9 | B, C | Ghi cuộc giao ban, giao chỉ đạo, ghi tiến độ, gia hạn, đóng | Chỉ đạo có người nhận và hạn |
| T10 | C | Mở dashboard, truy nguồn một con số, đọc hai tỷ lệ, duyệt trên điện thoại | Đọc đúng phạm vi và thời điểm của số |
| T11 | D | Tạo người dùng, giao vai trò theo phạm vi đơn vị, ủy quyền có hạn | Đơn vị chỉ thấy dự án mình |
| T12 | D | Soạn quy tắc nhập liệu mới, trình, duyệt bằng người khác, đọc so sánh phiên bản | Quy tắc có hiệu lực theo phiên bản |
| T13 | D | Khôi phục một bản sao lưu sang môi trường thử, so băm | Khớp băm |
| T14 | D | Đọc nhật ký kiểm toán một thao tác chốt kỳ | Tìm được người, thời điểm, lý do |

## 4. Lịch đào tạo (điền khi chốt)

| Buổi | Nhóm | Đầu mối, địa điểm | Ngày | Giảng viên | Hình thức | Môi trường |
|---|---|---|---|---|---|---|
| [khách điền] | | | | | Trực tiếp hoặc trực tuyến | Đào tạo |

Điều kiện mở khóa: danh sách người học (PX-05), môi trường đào tạo (PX-11), tài khoản đã cấp. Sau chuyển đổi dữ liệu (06) và trước vận hành thử song song (08).

## 5. Tài liệu và video hướng dẫn (sản phẩm cùng biên bản)

| Hạng mục | Nơi có | Tình trạng |
|---|---|---|
| Hướng dẫn sử dụng theo chương | `scripts/hdsd/chapters.json`; trang dựng bởi `scripts/hdsd/build-docs.mjs` | Có, tiếng Việt; chương riêng IND, RPT, DIR, HPM, EBS cần bổ sung (DOC-3) |
| Video giới thiệu cho PVFCCo (Đạm Phú Mỹ) | `docs/clips/enterprise-phu-my.script.md` | Kịch bản có; dựng tiếng Việt, còn thiếu giọng đọc và nhạc được duyệt |
| Video giới thiệu đầu tư công | `docs/clips/public-investment.script.md` | Như trên |
| Hướng dẫn quản trị | Runbook ở mục 2 | Tập hợp có; bản hướng dẫn tiếng Việt: DOC-3 |
| Hướng dẫn trực tuyến trên màn hình (YCK.08) | Chưa có | DOC-3 |

## 6. Đánh giá sau đào tạo

- Bài kiểm tra thực hành: người học làm lại bài T-nn của nhóm mình mà không nhìn tài liệu; đạt khi hoàn thành bài không trợ giúp. Mục tiêu theo nền tảng: không dưới 90% tác vụ lõi hoàn thành không trợ giúp (BRD, KPI SUS và tác vụ lõi, đo ở pilot).
- Phiếu phản hồi: [khách điền].
- Ghi nhận câu hỏi lặp để bổ sung hướng dẫn và trợ giúp trên màn hình.

## 7. Mẫu biên bản xác nhận đào tạo (sản phẩm 7)

```
BIÊN BẢN XÁC NHẬN ĐÀO TẠO
Số: [khách điền]            Ngày: [khách điền]
Địa điểm, hình thức: [khách điền]
Nhóm đào tạo: [ ] A người nhập, người phê duyệt  [ ] B Ban KHĐT  [ ] C Lãnh đạo
              [ ] D quản trị hệ thống  [ ] E Ban TCKT
1. Giảng viên (nhà cung cấp): [khách điền]
2. Nội dung đã đào tạo (chương hướng dẫn, bài thực hành T-nn): [khách điền]
3. Danh sách tham dự
   | STT | Họ tên | Đơn vị, đầu mối | Chức danh | Bài hoàn thành | Ký |
   | [khách điền]
4. Kết quả đánh giá: số người đạt [..] / số người dự [..]
5. Tài liệu đã giao: [hướng dẫn sử dụng, video, hướng dẫn quản trị] (kèm phiên bản)
6. Tồn tại và cam kết bổ sung: [khách điền]
7. Kết luận: [ ] Xác nhận đã đào tạo đủ  [ ] Cần đào tạo bổ sung
Chữ ký: đại diện đơn vị được đào tạo [khách điền]   Ban KHĐT [khách điền]   Nhà cung cấp [khách điền]
```

Lịch sử sửa: v0.1 khung ngày 2026-11-09.
