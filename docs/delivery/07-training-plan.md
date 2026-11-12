# 07. Kế hoạch đào tạo và mẫu biên bản xác nhận đào tạo

Giai đoạn 5, sản phẩm 7 của mục II.5 (biên bản xác nhận đào tạo; tài liệu và video hướng dẫn). Dòng ma trận: TK.01, TK.02, GD.5, SP.07. PVFCCo phê duyệt: có.

Hồ sơ kỹ thuật (TK.01): đào tạo người dùng cuối tại 09 đầu mối và Ban KHĐT (nhập liệu, phê duyệt, rà soát, lập báo cáo); đào tạo Lãnh đạo khai thác dashboard; đào tạo quản trị hệ thống cho Ban CĐS&CNTT.

Nguồn: bộ hướng dẫn sử dụng `scripts/hdsd/chapters.json` (90 chương: ba chương theo luồng (đăng nhập, danh mục địa bàn, tạo dự án), 74 chương theo nhóm màn hình `tour-*` và mười ba chương điện thoại `m01` đến `m13`), `scripts/hdsd/overview.json`; trợ giúp trên màn hình `apps/web/src/help/help.vi.json` (594 màn hình web, sinh bởi `scripts/help-index.mjs`; nút trợ giúp hoặc phím `?`); hướng dẫn quản trị `docs/admin-guide.md`; hai tài liệu tích hợp `docs/integration/hpm-proposal.md` và `docs/integration/power-bi-model.md`; câu chuyện ST-KERNEL-104 (chương trình đào tạo theo vai trò, môi trường đào tạo dữ liệu tổng hợp) và ST-KERNEL-103 (người dùng thử); `docs/pwa.md`. Kịch bản hai video `docs/clips/enterprise-phu-my.script.md` và `docs/clips/public-investment.script.md` vẫn nằm trong kho mã làm tư liệu nội dung, nhưng video không thuộc đợt giao này (mục 5).

Trạng thái tệp: v0.2, rà soát ngày 2026-11-12 sau khi DOC-3 và các làn ENT đã gộp. Phía nhà cung cấp đã có: giáo trình gắn với chương hướng dẫn, trợ giúp trên màn hình cho mọi màn hình web kể cả các màn riêng của bản enterprise, hướng dẫn quản trị tiếng Việt, mười bốn bài thực hành tăng lên hai mươi mốt (mục 3). Chưa có danh sách người học, lịch, địa điểm, môi trường đào tạo của khách (PX-05, PX-11) nên chưa tổ chức buổi nào và chưa có biên bản ký. Khoảng trống còn lại của nhà cung cấp: các màn IND, RPT, DIR, HPM, EBS, HUB, INT, EQP, BAN, PWA chưa có chương riêng trong `scripts/hdsd/chapters.json`, đang dựa vào trợ giúp trên màn hình và bài thực hành.

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

Mỗi mục trỏ tới chương hướng dẫn có sẵn trong `scripts/hdsd/chapters.json` và tới tên chương của kịch bản video (tư liệu nội dung; video không thuộc đợt giao này, mục 5). Các chương `tour-*` mô tả theo nhóm màn hình của nền tảng; phần riêng bản enterprise (IND, RPT, DIR, HPM, EBS, HUB, INT, EQP, BAN) chưa có chương riêng trong `scripts/hdsd/chapters.json` (khoảng trống của TK.02, xem mục 2.1): học bằng trợ giúp trên màn hình và bài thực hành ở mục 3.

| Nhóm | Chương hướng dẫn (id) | Chương của kịch bản video (tư liệu, video không giao đợt này) | Bài thực hành riêng bản enterprise |
|---|---|---|---|
| A | `01-dang-nhap`, `tour-iam-truy-cap`, `tour-iam-khong-gian-ca-nhan`, `tour-dis-lap-gui-bao-cao`, `tour-home-cong-viec-canh-bao` | Quy trình duyệt số liệu kỳ | Nhập chỉ tiêu và nhập từ Excel (IND-02, IND-03); đọc cảnh báo vi phạm quy tắc; gửi và nhận trả về; thuyết minh 8 trường (T15) |
| B | `tour-dis-quan-ly-ky-bao-cao`, `tour-dis-tong-hop-phan-tich`, `tour-cap-ke-hoach-von`, `tour-cap-dieu-hanh-theo-ky`, `tour-prj-danh-muc-theo-doi`, `tour-adm-quy-trinh-cau-hinh` | Báo cáo gửi Tập đoàn; Đẩy số HPM và đối chiếu kế toán; Chỉ đạo giao ban; Cơ cấu vốn và kế hoạch | Chốt kỳ, mở lại kỳ; phát hành biểu mẫu từ bản chốt; đẩy HPM, đẩy lại, ghi biên nhận (HPM-01); đối chiếu EBS (EBS-01, EBS-02); ghi cuộc giao ban (DIR-01 đến DIR-04); bản chốt doanh nghiệp và so sánh chéo báo cáo (T16); lịch kỳ (T17) |
| C | `tour-home-buc-tranh-tong-the`, `tour-home-cong-viec-canh-bao`, `tour-bi-kham-pha-thiet-ke`, `m01-dang-nhap-dien-thoai`, `m02-trang-chu-dien-thoai` | Tổng quan điều hành; Dự án đầu tư xây dựng | Cài PWA, duyệt trong hàng đợi, xem dashboard, theo dõi chỉ đạo (PWA-01 đến PWA-04, `docs/pwa.md`); đọc chỉ đạo giao ban (DIR-06) |
| D | `tour-adm-to-chuc-con-nguoi`, `tour-adm-quy-trinh-cau-hinh`, `tour-adm-tich-hop-an-toan`, `tour-mdm-to-chuc-dau-tu`, `tour-mdm-nghiep-vu-quy-uoc`, `tour-mdm-vong-doi-danh-muc`, `tour-sas-van-hanh-nen-tang` | Tin cậy và kết thúc | Soạn và duyệt bảng ánh xạ, quy tắc nhập liệu (ADM-19, IND-01 đến IND-03); cấu hình quy trình (ADM-06); ủy quyền; xem nhật ký (ADM-11); xem hub tích hợp (HUB-01 đến HUB-03); sao lưu và khôi phục theo runbook; hạn từng bước của lịch kỳ, sao lưu thủ công, nhật ký trước và sau, hub tích hợp, gói tổ chức (T18 đến T21) |
| E | `01-dang-nhap` | Đẩy số HPM và đối chiếu kế toán | Tải tệp EBS, chạy thử, đọc chênh lệch, giải trình (EBS-01, EBS-02) |

Tài liệu chuẩn bị riêng cho quản trị (nhóm D): `docs/admin-guide.md` (hướng dẫn quản trị bằng tiếng Việt, mười một mục: vai trò và quyền, quy tắc quản trị, lịch, danh mục, trung tâm tích hợp, sao lưu và khôi phục, xuất nhật ký kiểm toán, nâng cấp và quay lui, vận hành thường ngày, bảng tra cứu, việc chờ bên ngoài), `docs/runbooks/infra/onprem-install.md`, `docs/runbooks/infra/backup-immutable.md`, `docs/runbooks/infra/restore-drill.md`, `docs/runbooks/infra/onprem-upgrade-rollback.md`, `docs/runbooks/release-checklist.md`, `docs/open-api.md`, `docs/integration-hub.md`, `docs/integration/hpm-proposal.md`, `docs/integration/power-bi-model.md`, `docs/security/identity-test-plan.md`.

### 2.1 Màn hình riêng của bản enterprise: tài liệu học và trợ giúp

Mọi màn hình web đều có trợ giúp trên màn hình (594 mục, không màn nào thiếu: `scripts/help/no-help.json` rỗng). Các màn dưới đây chưa thuộc chương nào của `scripts/hdsd/chapters.json` (cột chương trống trong `apps/web/src/help/help.vi.json`), nên người học dùng trợ giúp trên màn hình cùng bài thực hành:

| Nhóm | Màn hình | Bài thực hành |
|---|---|---|
| A | IND-02, IND-03 (nhập chỉ tiêu và từ Excel), DIS-35 (thuyết minh 8 trường), DIS-34 (lịch kỳ và bảng trạng thái nhập) | T2, T3, T15 |
| B | DIS-32, DIS-33 (bản chốt kỳ doanh nghiệp), RPT-01 đến RPT-04, RPT-09 (so sánh chéo), HPM-01, HPM-02, EBS-01, EBS-02, DIR-01 đến DIR-05, EQP-01, EQP-02 | T5 đến T9, T16, T17 |
| C | HOME-09, BAN-01 (trình chiếu), DIR-05, PWA-04 (theo dõi chỉ đạo trên điện thoại) | T10 |
| D | ORG-01 (gói tổ chức), IND-01, ADM-19 đến ADM-22, ADM-31 (hạn từng bước), ADM-29, ADM-30 (nhật ký trước và sau, giới hạn log), ADM-32 (sao lưu thủ công), HUB-01 đến HUB-03, INT-01 đến INT-05 | T11 đến T14, T18 đến T20 |
| E | EBS-01, EBS-02 | T8 |

DIR-06 (chỉ đạo giao ban trên điện thoại) là màn của ứng dụng điện thoại, không nằm trong 594 mục trợ giúp của web; người học nhóm C học qua bài T10 và `docs/pwa.md`.

## 3. Bài thực hành

Mọi bài làm trên môi trường đào tạo với dữ liệu tổng hợp, không trên dữ liệu thật (ST-KERNEL-104). Bộ dữ liệu minh họa `docs/clip-data.md` (bộ `enterprise`) là nguồn dữ liệu đào tạo tổng hợp; sáu biểu mẫu vẫn mang dấu MẪU DEMO tới khi có bố cục chính thức (PX-01). Bài T15 đến T21 bổ sung ngày 2026-11-12 cho các chức năng của bản enterprise đã gộp sau bản khung.

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
| T15 | A | Viết thuyết minh 8 trường cho một dự án (DIS-35): kế thừa kỳ trước, sửa lại, chọn nguyên nhân chuẩn, đưa chỉ đạo giao ban vào; mở trợ giúp trên màn hình bằng phím `?` | Biết trường nào còn từ kỳ trước, trường nào đã viết lại; không bỏ trống trường bắt buộc |
| T16 | B | Dựng bản chốt kỳ doanh nghiệp (DIS-32, DIS-33): xem đơn vị còn thiếu số liệu, chốt khi đủ; so sánh chéo báo cáo cùng kỳ trước khi phát hành (RPT-09), giải trình một chênh lệch | Bản chốt bị từ chối khi kỳ chưa đủ (`ENTERPRISE_SNAPSHOT_INCOMPLETE`); phát hành bị từ chối (`REPORT_CROSSCHECK_BLOCKED`) khi còn chênh lệch mức chặn chưa giải trình; người giải trình không là người lập báo cáo liên quan |
| T17 | B | Đọc lịch kỳ và bảng trạng thái nhập theo đầu mối (DIS-34): đầu mối nào chưa nộp, bước nào quá hạn | Tìm đúng đầu mối và bước chậm nhất |
| T18 | D | Đổi hạn từng bước của lịch kỳ bằng quy tắc quản trị (ADM-31): soạn, trình, duyệt bằng người khác | Hạn mới có hiệu lực từ ngày chọn, kỳ đã sinh giữ hạn cũ |
| T19 | D | Yêu cầu sao lưu thủ công (ADM-32): một người đề nghị, người khác duyệt; đọc bản sao lưu và lần kiểm gần nhất | Hiểu ứng dụng không tự chạy sao lưu; người chạy là bộ chạy trên máy chủ |
| T20 | D | Bật chính sách chi tiết nhật ký trước và sau cho một loại đối tượng (ADM-29), đặt giới hạn log (ADM-30); đọc sức khỏe kết nối ở hub (HUB-01 đến HUB-03) | Biết nhật ký kiểm toán không bị dọn tự động; đọc được kết nối nào chậm hoặc lỗi |
| T21 | D | Nạp gói tổ chức mẫu `PVFCCO-TEMPLATE` trên môi trường đào tạo: đăng ký lô, chạy thử, duyệt bằng người khác, `materialiseEnterpriseOrgPack`, đọc báo cáo kiểm ở ORG-01 | Gói nạp lặp lại không đổi gì; chênh lệch được báo, không bị ghi đè |

## 4. Lịch đào tạo (điền khi chốt)

| Buổi | Nhóm | Đầu mối, địa điểm | Ngày | Giảng viên | Hình thức | Môi trường |
|---|---|---|---|---|---|---|
| [khách điền] | | | | | Trực tiếp hoặc trực tuyến | Đào tạo |

Điều kiện mở khóa, chỉ khách cung cấp được: danh sách người học (PX-05), môi trường đào tạo trên hạ tầng của PVFCCo (PX-11), tài khoản đã cấp. Sau chuyển đổi dữ liệu (06) và trước vận hành thử song song (08). Tất cả buổi đào tạo và biên bản ký (mục 7) vì vậy ở trạng thái PENDING-EXTERNAL cho tới khi PX-05 và PX-11 có.

## 5. Tài liệu và video hướng dẫn (sản phẩm cùng biên bản)

| Hạng mục | Nơi có | Tình trạng |
|---|---|---|
| Hướng dẫn sử dụng theo chương | `scripts/hdsd/chapters.json` (90 chương); trang dựng bởi `scripts/hdsd/build-docs.mjs` | Có, tiếng Việt; chương riêng IND, RPT, DIR, HPM, EBS, HUB, INT, EQP, BAN chưa có: trợ giúp trên màn hình thay thế (mục 2.1); nhà cung cấp có thể bổ sung chương, không cần khách |
| Hướng dẫn quản trị | `docs/admin-guide.md` và các runbook ở mục 2 | Có, tiếng Việt (DOC-3 đã gộp); bản cứng khi bàn giao theo [10](10-handover-checklist.md) |
| Hướng dẫn trực tuyến trên màn hình (YCK.08) | `apps/web/src/help/help.vi.json` (594 màn hình), ngăn trợ giúp mở bằng nút hoặc phím `?`; sinh và kiểm bằng `node scripts/help-index.mjs` (`generate`, `check`, nằm trong `npm run qa:check`) | Có (DOC-3 đã gộp) |
| Video hướng dẫn | Kịch bản `docs/clips/enterprise-phu-my.script.md` và `docs/clips/public-investment.script.md` (tư liệu nội dung) | Video không thuộc đợt giao này: chủ dự án đã dừng việc dựng video; hồ sơ kỹ thuật (II.5, sản phẩm 7) nêu "tài liệu và video hướng dẫn", nên việc có giao video hay không, hay thay bằng tài liệu chữ và trợ giúp trên màn hình, là quyết định của chủ dự án và PVFCCo: [khách điền: quyết định về video hướng dẫn] |

## 6. Đánh giá sau đào tạo

- Bài kiểm tra thực hành: người học làm lại bài T-nn của nhóm mình mà không nhìn tài liệu; đạt khi hoàn thành bài không trợ giúp. Mục tiêu theo nền tảng: không dưới 90% tác vụ lõi hoàn thành không trợ giúp (BRD, KPI SUS và tác vụ lõi, đo ở pilot).
- Phiếu phản hồi: [khách điền].
- Ghi nhận câu hỏi lặp để bổ sung hướng dẫn và trợ giúp trên màn hình (sửa nội dung trợ giúp bằng `scripts/help/kind-guides.json`, rồi `node scripts/help-index.mjs generate`).

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

Lịch sử sửa: v0.1 khung ngày 2026-11-09. v0.2 ngày 2026-11-12 (rà soát bởi làn aud4): sửa số chương hướng dẫn (90, mười ba chương điện thoại), thêm trợ giúp trên màn hình (594 màn) và hướng dẫn quản trị `docs/admin-guide.md` vào giáo trình, thêm bảng màn hình riêng bản enterprise (mục 2.1), thêm bài T15 đến T21, ghi rõ video không thuộc đợt giao này; giữ nguyên các điều kiện chờ khách (PX-05, PX-11) và quyết định về video.
