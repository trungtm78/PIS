# 01. Báo cáo khảo sát hiện trạng (As-Is) và Tài liệu yêu cầu người dùng (URD)

Giai đoạn 1, sản phẩm 1 của mục II.5. Dòng ma trận: GD.1, SP.01. PVFCCo phê duyệt: có.

Nguồn: Hồ sơ kỹ thuật "Phần mềm quản lý đầu tư xây dựng" v0.3 (26 11 03), mục I.1 đến I.4 và II.2 đến II.3; `Design/MACHVON_Design/01_Documents/02_BRD.md`; `docs/report-engine.md` (sáu biểu mẫu do hệ thống thiết kế); `docs/ind-indicator-dictionary.md`; `docs/hpm-ebs-connectors.md`; `docs/integration/hpm-proposal.md` và `docs/integration/power-bi-model.md` (hai tài liệu đề xuất tích hợp); `docs/runbooks/infra/sizing-uat-prod.md` (cấu hình khuyến nghị); `scripts/help-index.mjs` (hướng dẫn trên màn hình); `docs/hskt/TRACEABILITY.md` (ma trận truy vết). Những gì chỉ khách biết ghi `[khách điền: ...]`.

Trạng thái tệp (v0.2, 2026-11-12): đã điền từ thiết kế và mã nguồn đến ngày 2026-11-12, sau khi các làn ENT-3a đến ENT-3e, ENT-4a đến ENT-4e, INFRA-2 và DOC-3 đã gộp vào nhánh chính. Phần A (As-Is) có sẵn nội dung từ hồ sơ kỹ thuật; khảo sát tại 09 đầu mối (mục A.6) và việc xác nhận nơi nhập liệu (mục A.2) chưa thực hiện, vì chỉ khách biết (PX-05). Phần B là URD dự thảo: mỗi yêu cầu đã gắn trạng thái thật, màn hình, thao tác và tiêu chí nghiệm thu; chờ Tổ chuẩn hóa dữ liệu xác nhận và PVFCCo ký duyệt (PX-02, PX-05, PX-12 của sổ chờ khách).

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

Giả định làm việc của hệ thống (không thay cho xác nhận của khách): gói cấu hình mẫu `PVFCCO-TEMPLATE` (màn ORG-01; `packages/edition-enterprise/src/org-pack/pvfcco-template.ts`) coi Ban KHĐT là đơn vị tổng hợp, không phải một trong 09 đầu mối; 09 đầu mối nhập liệu là Chi nhánh QLPTDA, Nhà máy Đạm Phú Mỹ, Ban Thương mại, Ban Kỹ thuật An toàn, Ban Tổng hợp, Ban TCKT, Trung tâm Nghiên cứu và Ứng dụng và hai Tổ dự án (tên để trống, `[khách điền: tên Tổ dự án]`). Ban Tổng Giám đốc và Hội đồng quản trị chỉ xem; Ban CĐS&CNTT quản trị. Việc có đúng như vậy không là câu hỏi cho PX-05.

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

Cột cuối là sáu biểu mẫu DEMO mà hệ thống tự thiết kế từ mô tả của hồ sơ kỹ thuật (`docs/report-engine.md`, mục "The six PVFCCo forms"); chúng không phải mẫu chính thức. Bố cục chính thức do Ban KHĐT cung cấp (PX-01). Khi kỳ đã có bản chốt doanh nghiệp (DIS-32, DIS-33), bản nháp của sáu biểu mẫu lấy số từ bản chốt (`data_source` là LIVE, ghi mã và phiên bản bản chốt) thay cho dữ liệu minh họa; biểu mẫu vẫn mang nhãn MẪU DEMO cho tới khi PX-01 được cung cấp. Hệ thống xuất Excel giữ nguyên mẫu, Word cho thuyết minh và PDF từ cùng một mô hình tài liệu (`docs/report-engine.md`).

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
| HPM | Nhận số liệu báo cáo tháng ở bước cuối, chuyển sang Data Lakehouse | Chỉ tiếp nhận ở bước cuối; chưa hỗ trợ nhập, phê duyệt, rà soát tại đơn vị | Nền tảng, đơn vị phát triển, khả năng mở API, cấu trúc dữ liệu nhận (PX-03). Đề xuất phương thức nối đã viết (đích API, cầu nối tệp chuẩn): `docs/integration/hpm-proposal.md` |
| ERP Oracle EBS | Số liệu kế toán, thanh toán theo mã dự án | Ban TCKT đối chiếu giải ngân | Tệp xuất hay đọc DB, quyền đọc, mẫu tệp thật (PX-04). Hệ thống đang chạy theo bố cục giả định `WORKING-ASSUMPTION-2026.1` (EBS-01, EBS-02) |
| Data Lakehouse | Kho dữ liệu của Tổng công ty | Nhận số liệu từ HPM | Cách cấp dữ liệu trực tiếp qua DB hoặc API (TH.02). Hệ thống đã có tài khoản BI chỉ-đọc và API mở (`docs/open-api.md`); cần Ban CĐS&CNTT cho biết cách Lakehouse nhận (PX-11) |
| Power BI | Công cụ báo cáo của CN QLPTDA | Đọc dữ liệu từ nguồn của Tổng công ty | Nguồn đang đọc, mô hình hiện có. Mô hình mẫu và hướng dẫn nối đã viết: `docs/integration/power-bi-model.md` |
| eProcurement | Mua sắm hàng hóa phục vụ sản xuất | Ngoài phạm vi, nhưng số liệu mua sắm trang thiết bị dự án có thể lấy từ đây | Cách lấy dữ liệu (PX-06). Màn EQP-01, EQP-02 đọc từ gói thầu, hợp đồng, thanh toán của nền tảng; chưa có bộ kết nối |
| Hệ thống văn thư | Văn bản pháp lý | Chưa rõ | Đặc tả kết nối (PX-07) |
| Xác thực tập trung của Tổng công ty | SSO, LDAP, Active Directory | Hồ sơ yêu cầu tích hợp | Thông tin AD, nhóm theo vai trò (PX-16). Hệ thống đã có realm Keycloak mẫu và bảng ánh xạ nhóm AD theo gói ORG-01 (`infra/keycloak/onprem/ad-group-role-map.json`) |

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

Cách hệ thống xử lý từng vấn đề (đã xây, trạng thái ở mục B.2):

| Vấn đề | Chức năng xử lý | Màn hình hoặc thao tác |
|---|---|---|
| V1 | Số liệu vốn và chỉ tiêu nhập một lần; bản chốt kỳ đóng băng và một bộ đọc duy nhất cho biểu mẫu, dashboard, gói HPM | DIS-27, DIS-28, DIS-32, DIS-33; `buildEnterpriseSnapshot`, `freezeEnterpriseSnapshot` |
| V2 | Lập biểu mẫu tự động từ bản chốt, xuất Excel, Word, PDF; so sánh chéo trước phát hành | RPT-01, RPT-02, RPT-09 |
| V3 | Đẩy HPM theo khóa chống trùng, biên nhận, đẩy lại; bước PUSH của quy trình giữ chờ biên nhận | HPM-01; `submitHpmPush`, `recordHpmReceipt` |
| V4 | Nhật ký kiểm toán chuỗi băm; giá trị trước và sau theo loại đối tượng; lịch sử chuyển số ước thành số thực | ADM-11, ADM-29, DIS-29 |
| V5 | Quy trình nhiều bước cho báo cáo DIS, lô số liệu vốn và lô chỉ tiêu (`REPORT_ACCEPT`, `FND_FIGURE_ACCEPT`, `IND_ENTRY_ACCEPT`) | ADM-06, ADM-18, DIS-06 |
| V6 | Quy tắc nhập liệu chặn hoặc cảnh báo ngay lúc nhập; trả về kèm cảnh báo đã giữ và lý do | IND-02; `evaluateIndicatorEntry` |
| V7 | Lịch kỳ có hạn từng bước, kỳ đóng băng, so sánh chéo cùng kỳ | DIS-34, ADM-31, DIS-33, RPT-09 |

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

Nơi nạp đã dựng sẵn cho từng hạng mục, để khi khách giao là nạp được không cần lập trình: danh mục dự án và mã HPM, mã EBS qua ánh xạ mã dự án INT-03 (đề xuất và duyệt bởi hai người, bảng độ phủ cho biết dự án nào chưa có mã); từ điển chỉ tiêu và quy tắc nhập liệu qua IND-01, IND-02 và kho quy tắc ADM-19; tổ chức và vai trò qua lô nhập ADM với ánh xạ `ORG-PACK-1` (chạy thử, người áp dụng khác người đăng ký). Các hạng mục chưa nhận vẫn là `chưa nhận`.

---

## Phần B. Tài liệu yêu cầu người dùng (URD) dự thảo

URD viết ở mức năng lực, như hồ sơ kỹ thuật đã nêu; chi tiết trường dữ liệu, công thức, màn hình sẽ thống nhất với Tổ chuẩn hóa dữ liệu trong giai đoạn 1 và 2. Cột "Tiêu chí nghiệm thu (dự thảo)" là đề xuất của nhà cung cấp, chờ xác nhận. Cột "Trạng thái trong hệ thống" đối chiếu ma trận truy vết với mã nguồn đến 2026-11-12 (mục B.2.1 nêu màn hình, thao tác, tài liệu). Quy ước: DONE là đã có và có bằng chứng; DONE trên giả định là phần mềm đã có nhưng dựa trên giá trị khởi điểm chưa được khách xác nhận (kèm mã chờ), nên chưa tính vào nghiệm thu (quy tắc R18); PARTIAL là còn thiếu phần nêu trong ô, kèm điều cần có.

### B.1 Người dùng và vai trò (HT.02)

| Vai trò | Việc chính | Phạm vi dữ liệu |
|---|---|---|
| Người nhập liệu đầu mối (01 người mỗi đầu mối) | Nhập, nhập từ Excel, xem cảnh báo sai sót | Dự án đơn vị mình phụ trách |
| Người phê duyệt tại đơn vị (01 người mỗi đầu mối) | Phê duyệt hoặc trả về kèm ý kiến | Đơn vị mình |
| Ban KHĐT rà soát | Rà soát, kiểm tra, chốt kỳ, đẩy HPM | Toàn Tổng công ty |
| Lãnh đạo (Ban TGĐ, HĐQT) | Xem báo cáo, dashboard, giao chỉ đạo | Toàn Tổng công ty |
| Ban TCKT | Cung cấp và đối chiếu số liệu giải ngân với EBS | [khách điền: phạm vi] |
| Quản trị hệ thống (Ban CĐS&CNTT) | Phân quyền, tham số, sao lưu, bảo mật | Quản trị |

Trong gói mẫu ORG-01 các vai trò này là `ENT_DATA_ENTRY`, `ENT_UNIT_APPROVER`, `ENT_PLANNING_REVIEWER`, `ENT_LEADERSHIP_VIEWER` và `ENT_EDITION_ADMIN`; vai trò nhập liệu và phê duyệt có phạm vi `UNIT_ONLY` (đơn vị chỉ thấy dự án mình), các vai trò còn lại có phạm vi toàn tenant; mỗi đầu mối có chỗ cho một người nhập và một người phê duyệt. Gói không chứa tên người hay tài khoản (PX-05).

### B.2 Yêu cầu người dùng

| Mã URD | Người dùng cần | Mã HSKT | Ưu tiên | Tiêu chí nghiệm thu (dự thảo) | Trạng thái trong hệ thống |
|---|---|---|---|---|---|
| UR-01 | Một danh mục dự án duy nhất với mã thống nhất và ánh xạ mã HPM, EBS | MD.01 | Bắt buộc | 100% dự án trong phạm vi có mã, mã HPM, mã EBS; ánh xạ truy được hai chiều; bảng độ phủ trên INT-03 cho số đã ánh xạ, đang chờ, xung đột | DONE trên giả định, chờ PX-14 (danh mục và mã thật) |
| UR-02 | Phân loại dự án theo nhóm A/B/C, loại hình, giai đoạn, đơn vị chủ trì | MD.01 | Bắt buộc | Lọc được theo từng tiêu chí; thêm tiêu chí mới không cần lập trình (quy tắc có phiên bản `ENT_PROJECT_TYPE`, `ENT_START_FLAG`) | DONE trên giả định, chờ PX-14 và câu B.4-4 |
| UR-03 | Lưu thông tin chung của dự án (địa điểm, quy mô, thời gian, tổng mức đầu tư, cơ cấu vốn, đầu mối liên lạc) | MD.01 | Bắt buộc | Đủ trường theo hồ sơ; vốn chủ sở hữu cộng vốn vay bằng tổng | PARTIAL: PRJ-02 có địa bàn, tổng mức đầu tư, nhóm, năm bắt đầu và kết thúc; vốn chủ sở hữu, vốn vay, tổng nguồn vốn là chỉ tiêu `EQUITY_CAPITAL`, `LOAN_CAPITAL`, `TOTAL_FUNDING` của IND-01; chưa đối chiếu được từng trường quy mô, đầu mối liên lạc với hồ sơ vì danh sách trường do Tổ chuẩn hóa dữ liệu chốt (PX-02) |
| UR-04 | Lưu hồ sơ pháp lý và mốc tiến độ kế hoạch, thực tế | MD.02 | Bắt buộc | Mỗi văn bản có số hiệu, ngày, cơ quan ban hành, tệp đính kèm; lịch sử thay đổi truy được | DONE trên giả định, chờ PX-02 (danh mục loại văn bản và mốc vòng đời chính thức, hiện `ENT_LEGAL_DOC_TYPE`, `ENT_LIFECYCLE_MILESTONE` gắn UNVERIFIED) và PX-07 (nối hệ thống văn thư) |
| UR-05 | Danh mục dùng chung do Ban KHĐT quản lý tập trung, đơn vị chỉ dùng | MD.03 | Bắt buộc | Đơn vị không sửa được danh mục; thay đổi có người duyệt và lịch sử | DONE trên giả định, chờ PX-02: loại báo cáo, cơ quan nhận, loại kỳ, nguồn vốn, đơn vị tính, tỷ giá, nguyên nhân chậm đã là danh mục quản lý được; giá trị chính thức do Tổ chuẩn hóa dữ liệu cung cấp |
| UR-06 | Nhập một lần, hệ thống tự tính lũy kế, tỷ lệ hoàn thành, chênh lệch so kế hoạch | DL.01 | Bắt buộc | Một số liệu chỉ có một nơi nhập; các chỉ tiêu tổng hợp khớp bộ số golden | DONE trên giả định, chờ PX-02 (chỉ tiêu chính thức) và câu B.4-2 (phạm vi số ước) |
| UR-07 | Quản lý giá trị ước và giá trị thực của cùng một kỳ, lưu lịch sử đổi số ước thành số thực | DL.01 | Bắt buộc | Lịch sử chuyển đổi của kỳ xem được | DONE (DIS-29) |
| UR-08 | Từ điển chỉ tiêu có tên, định nghĩa, công thức, đơn vị, nguồn, kỳ áp dụng | DL.02 | Bắt buộc | Mọi chỉ tiêu có đủ trường; đổi công thức không cần lập trình | DONE, chờ PX-02 |
| UR-09 | Cảnh báo ngay khi nhập sai (lũy kế vượt tổng mức đầu tư, tổng vốn chủ sở hữu và vốn vay khác tổng, kỳ đã chốt, trường bắt buộc) | DL.02 | Bắt buộc | Từng quy tắc có ca kiểm thử chạy được và có thể đỏ | DONE, chờ PX-02 |
| UR-10 | Nhập trên màn hình và nhập từ Excel theo mẫu có kiểm tra trước khi ghi | DL.02, YCK.04 | Bắt buộc | Chạy thử không ghi gì; dòng lỗi nêu dòng, trường, mã | DONE (chỉ tiêu: IND-03; thuyết minh: ánh xạ `ENT-NARRATIVE-1`) |
| UR-11 | Dữ liệu theo kỳ, so cùng kỳ, bản chốt đúng như đã báo cáo | DL.03 | Bắt buộc | Mở lại bản chốt của kỳ cũ cho cùng số | DONE trên giả định: bản chốt doanh nghiệp đóng băng có băm (DIS-32, DIS-33), mở lại chỉ qua kỳ mở lại đã duyệt, bản mới có phiên bản mới; số thật cần kỳ thực tế (PX-13) và phạm vi dữ liệu lịch sử (PX-08) |
| UR-12 | Quy trình nhập, phê duyệt đơn vị, Ban KHĐT rà soát, chốt kỳ, đẩy HPM; sai sót trả về kèm cảnh báo | QT.01 | Bắt buộc | Từng bước đi qua được; trả về có lý do; bước, vai trò, hạn cấu hình được | DONE trên giả định, chờ PX-05 (người giữ vai trò) và PX-03 (bước đẩy HPM thật): quy trình nhiều bước chạy cho báo cáo DIS, lô số liệu vốn, lô chỉ tiêu; các loại duyệt mới bật bằng `MACHVON_APPROVAL_BUSINESS_TYPES` |
| UR-13 | Lịch kỳ tháng, quý, năm, giao ban với hạn từng bước; theo dõi trạng thái từng đầu mối; nhắc việc và cảnh báo quá hạn | QT.02 | Bắt buộc | Đầu mối quá hạn nhận thông báo; bảng tiến độ khớp thực tế | PARTIAL: lịch `REPORTING_SCHEDULE` (ADM-31), bảng DIS-34, nhắc việc và báo lãnh đạo đã có; DIS-34 chưa lấy dữ kiện của bước Ban KHĐT rà soát và bước đẩy HPM nên hai bước này hiện ghi là chưa theo dõi (`NOT_TRACKED`); các con số hạn là giá trị khởi đầu chưa xác nhận (D03); email và Teams thật chờ PX-16 |
| UR-14 | Chốt kỳ sau khi Ban KHĐT rà soát; mở lại có lý do, người duyệt đúng thẩm quyền, lưu vết | QT.02 | Bắt buộc | Kỳ đã chốt không đổi; mở lại phải có lý do | DONE (DIS-21, DIS-22; bản chốt doanh nghiệp DIS-32, DIS-33 theo cùng quy tắc) |
| UR-15 | Điều chỉnh kế hoạch trong năm; giao và theo dõi chỉ đạo của Lãnh đạo | QT.02, CN.01, CN.03 | Bắt buộc | Chỉ đạo có người nhận, hạn, trạng thái | DONE trên giả định, chờ câu B.4-5: điều chỉnh kế hoạch (CAP-07, lịch `PLAN_ADJUSTMENT`), chỉ đạo giao ban (DIR-01 đến DIR-06, PWA-04) |
| UR-16 | Ghi kế hoạch vốn năm theo Nghị quyết PVN và Quyết định giao nhiệm vụ của Tổng công ty, phân bổ quý, tháng, cơ cấu nguồn | CN.01 | Bắt buộc | Mỗi dòng kế hoạch nêu căn cứ văn bản | DONE trên giả định, chờ PX-02: đăng ký phân bổ theo gói enterprise có nguồn `GROUP_ASSIGNED`, `BOARD_APPROVED`, loại văn bản gắn với nguồn, tách theo dự án ở `v_project_origin_decision` |
| UR-17 | Nhập và duyệt số liệu thực hiện, giải ngân theo kỳ; thuyết minh có cấu trúc, kế thừa kỳ trước | CN.02 | Bắt buộc | Tám trường thuyết minh; kế thừa có dấu vết | DONE trên giả định, chờ PX-01 (bố cục chính thức): DIS-35, nguyên nhân chuẩn từ danh mục MDM-17, chỉ đạo giao ban đưa vào thuyết minh |
| UR-18 | Theo dõi mua sắm trang thiết bị dự án của Ban Thương mại | CN.02 | Bắt buộc | Kế hoạch, kết quả lựa chọn nhà thầu, giá trị hợp đồng, giải ngân | DONE trên giả định, chờ PX-06: EQP-01, EQP-02 đọc từ gói thầu, hợp đồng, thanh toán; nối eProcurement chưa có |
| UR-19 | Theo dõi mốc tiến độ, cảnh báo dự án chậm, vướng thủ tục | CN.03 | Bắt buộc | Dự án chậm hiện trên dashboard | DONE trên giả định: ô dự án vướng thủ tục và chỉ đạo quá hạn trên bảng lãnh đạo (HOME-09, BAN-01); định nghĩa "vướng thủ tục" (vướng mắc, giấy phép, đất đai quá hạn) do Ban KHĐT xác nhận |
| UR-20 | Đối chiếu giải ngân với EBS theo mã dự án và kỳ; hiển thị chênh lệch và yêu cầu giải trình | CN.04 | Bắt buộc | Mỗi chênh lệch có người nhận, hạn, lý do | DONE trên giả định, PX-04 (mã dự án đọc qua ánh xạ INT-03 trước, so khớp thẳng sau) |
| UR-21 | So sánh chéo số liệu cùng kỳ giữa các loại báo cáo trước phát hành | CN.04 | Bắt buộc | Lệch thì chặn phát hành | DONE trên giả định, chờ D03 (dung sai, mức chặn, cặp báo cáo) và PX-01: RPT-09, cổng trong `issueReport` (409 `REPORT_CROSSCHECK_BLOCKED`), giải trình bởi người khác người lập |
| UR-22 | Tự động lập sáu biểu mẫu từ bộ dữ liệu nền, xuất đúng bố cục; Excel, PDF, Word; đặt tên theo quy ước; lưu bản phát hành theo kỳ | BC.01 | Bắt buộc | Số trong sáu biểu khớp nhau | PARTIAL: xuất đủ Excel, Word, PDF, lấy số từ bản chốt, đặt tên theo quy ước, lưu bản phát hành; bố cục vẫn là MẪU DEMO, chờ bố cục chính thức (PX-01) |
| UR-23 | Biểu mẫu nội bộ tự cấu hình bố cục (chọn chỉ tiêu, cột, nhóm dự án) | BC.01, HT.04 | Bắt buộc | Không cần lập trình | DONE trên giả định, chờ PX-15 (mẫu Sở/Ban/Ngành): RPT-07, RPT-08, quy tắc `REPORT_LAYOUT` có phiên bản |
| UR-24 | Dashboard cho Lãnh đạo và Ban KHĐT; tự tạo báo cáo; trình chiếu tại giao ban; gửi email theo lịch | BC.02 | Bắt buộc | Số trên dashboard khớp bản chốt | DONE trên giả định, chờ PX-13 (số kỳ thực) và PX-16 (email thật): tỷ lệ so kế hoạch năm và cùng kỳ năm trước theo công ty, đơn vị, dự án; chế độ trình chiếu; RML-01 gửi biểu mẫu đã phát hành theo lịch |
| UR-25 | Đẩy số liệu tháng đã chốt sang HPM, ghi kết quả, cảnh báo lỗi, đẩy lại, điều chỉnh sau khi đã đẩy | TH.01 | Bắt buộc | Đẩy lại không trùng; có biên nhận | PARTIAL, chờ PX-03: bước PUSH giữ chờ biên nhận, đẩy lại cùng khóa, ghi đè kỳ và điều chỉnh ở kỳ sau đã có; bộ ghi vẫn là tệp theo cấu trúc giả định, chưa có bộ chuyển tiếp API |
| UR-26 | Cấp dữ liệu cho Data Lakehouse và Power BI | TH.02 | Bắt buộc | Power BI đọc được tập dữ liệu chứng nhận | PARTIAL: mô hình mẫu và hướng dẫn nối đã viết (`docs/integration/power-bi-model.md`), tập chứng nhận hiện có là giải ngân và hợp đồng; chưa có tập chứng nhận cho số liệu bản chốt doanh nghiệp; cách Lakehouse nhận chờ PX-11 |
| UR-27 | Đọc EBS, sẵn sàng eProcurement, văn thư, xác thực tập trung; API mở có tài liệu, không phí bản quyền | TH.03 | Bắt buộc | Tài liệu API khớp hệ thống | PARTIAL: EBS đọc qua tệp và mã dự án qua INT-03, API mở có tài liệu `docs/open-api/openapi.json`; eProcurement, văn thư, xác thực tập trung chờ PX-06, PX-07, PX-16; EBS đọc trực tiếp DB chưa nối (PX-04) |
| UR-28 | Phân quyền theo vai trò và theo đơn vị, dự án, kỳ | HT.02 | Bắt buộc | Đơn vị chỉ thấy dự án mình | DONE trên giả định, chờ PX-05 và PX-16: gói PVFCCO-TEMPLATE (ORG-01), 09 đầu mối, ánh xạ nhóm AD, nạp bằng lệnh có chạy thử |
| UR-29 | Ủy quyền trong thời hạn hoặc vĩnh viễn | HT.03 | Bắt buộc | Ủy quyền có hạn, thu hồi được, lưu vết | DONE |
| UR-30 | Quản trị tự đổi danh mục, công thức, quy tắc, lịch kỳ, bố cục nội bộ | HT.04 | Bắt buộc | Mỗi thay đổi có phiên bản và người duyệt | DONE: kho quy tắc ADM-19 đến ADM-22, lịch kỳ ADM-31, bố cục RPT-07, danh mục MDM |
| UR-31 | Phản hồi dưới 5 giây, xem báo cáo dưới 20 giây | HT.05 | Bắt buộc | Đo trên phần cứng khách | PARTIAL, PX-10: đo trên phần cứng khách; `docs/qa/perf-budget.json` đã có dòng riêng cho đọc bản chốt doanh nghiệp (PB-R016), so sánh chéo (PB-R017), bảng lịch kỳ và bảng trạng thái nhập liệu (PB-F068, PB-F069) và PDF biểu mẫu (PB-R008), đã đo trên máy phát triển (p95 dưới 0,2 giây, bộ dữ liệu mẫu nhỏ; `docs/qa/performance.md`); số đo có giá trị nghiệm thu vẫn là số đo trên phần cứng khách |
| UR-32 | Lưu vết mọi thao tác kèm giá trị trước/sau, lý do; giới hạn log | HT.06 | Bắt buộc | Truy được từng thay đổi số liệu | PARTIAL: nhật ký chuỗi băm, giới hạn dòng và dung lượng log (ADM-30) và giá trị trước, sau theo loại đối tượng (ADM-29, mặc định tắt) đã có; mới nối cho mở lại kỳ và đẩy HPM, các loại còn lại cần thêm `detail` ở nơi ghi nhật ký |
| UR-33 | Dùng được trên Chrome, Firefox, Edge, Safari; PWA cho quản lý (duyệt, dashboard, chỉ đạo); SSO và MFA từ ngoài | YCK.01 | Bắt buộc | Ba màn PWA chạy được trên điện thoại | PARTIAL, PX-16: PWA-02, PWA-03, PWA-04, làn CI Edge, bộ gửi email SMTP và Teams có kiểm thử với máy chủ giả; email, Teams, SSO, MFA thật chờ thông tin của khách |
| UR-34 | Hai môi trường UAT và Production | YCK.02 | Bắt buộc | Cấu hình khuyến nghị được duyệt | PARTIAL, PX-17 và PX-11: cấu hình khuyến nghị đã viết (`docs/runbooks/infra/sizing-uat-prod.md`) trên giả định tải do nhà cung cấp đặt; chờ khách xác nhận số người dùng và hạ tầng |
| UR-35 | Sao lưu ngày/tuần/tháng, giữ tối thiểu 03 bản, một bản bất biến, kiểm tra khôi phục | YCK.06 | Bắt buộc | Có biên bản diễn tập khôi phục | PARTIAL, PX-11: chu kỳ ngày, tuần, tháng, bản ngoại tuyến, giữ tối thiểu 03 bản, yêu cầu sao lưu thủ công hai người (ADM-32) đã có; chưa có biên bản diễn tập khôi phục (sổ `infra/backup/restore-drill-ledger.json` còn trống, cần máy sạch ở site 2) |
| UR-36 | Bảo mật theo YCK.07, kể cả pentest độc lập | YCK.07 | Bắt buộc | Không còn lỗ hổng Critical, High | PARTIAL, PX-09: gói sẵn sàng pentest, quét mã độc tệp tải lên, kiểm thử allowlist egress, kịch bản ransomware đã có; pentest độc lập và nhập thử realm Keycloak trên máy thật chưa làm |
| UR-37 | Giao diện tiếng Việt, hướng dẫn trực tuyến trên màn hình | YCK.08 | Bắt buộc | Mỗi màn có nút trợ giúp | DONE: nút trợ giúp và phím `?` trên mọi màn web, 594 màn có hướng dẫn, kiểm tra bằng `node scripts/help-index.mjs check` |
| UR-38 | Đào tạo, tài liệu, chuyển đổi dữ liệu, vận hành thử song song 02 kỳ | TK.01 đến TK.04 | Bắt buộc | Biên bản từng bước được ký | PARTIAL: giáo trình, hướng dẫn quản trị (`docs/admin-guide.md`) và khung 05 đến 10 đã có; chưa tổ chức đào tạo, chuyển đổi, vận hành song song (PX-05, PX-08, PX-13) |

### B.2.1 Truy vết URD tới màn hình, thao tác và tài liệu

Mã màn hình theo `Design/MACHVON_Design/03_Engineering/screen_catalog.json`; tên thao tác theo `openapi.json` cùng thư mục.

| Mã URD | Màn hình | Thao tác chính | Tài liệu và mã nguồn |
|---|---|---|---|
| UR-01 | PRJ-01, INT-03, MDM-35 | `listProjectCodes`, `proposeProjectCode`, `decideProjectCode`, `retireProjectCode` | `docs/hpm-ebs-connectors.md` mục 3.1; `packages/edition-enterprise/src/integration/project-code-resolver.ts` |
| UR-02 | PRJ-01, PRJ-02, ADM-19 | `createProject` | `packages/edition-enterprise/src/integration/ent-catalogue.ts` (`ENT_PROJECT_TYPE`, `ENT_START_FLAG`) |
| UR-03 | PRJ-02, PRJ-03, IND-01 | `createProject`, `listIndicators` | `docs/ind-indicator-dictionary.md` |
| UR-04 | PRJ-04, PRJ-07 | thao tác của phân hệ PRJ | `packages/edition-enterprise/src/integration/ent-catalogue.ts` (`ENT_LEGAL_DOC_TYPE`, `ENT_LIFECYCLE_MILESTONE`); `docs/doc-dossiers.md` |
| UR-05 | ADM-05, MDM-32, MDM-33 | thao tác của phân hệ MDM | `packages/db/src/master-types.ts` (`REPORT_TYPE`, `RECEIVING_AGENCY`, `REPORTING_PERIOD_KIND`, `CAPITAL_SOURCE`, `REPORT_UNIT`, `FX_RATE`); `docs/mdm-catalogue-dictionary.md` |
| UR-06 | DIS-27, DIS-28, DIS-29, DIS-32, DIS-33 | `proposeFundingFigures`, `acceptFundingFigures`, `getEnterpriseSnapshot` | `docs/fnd-funding-model.md`; `packages/kernel/src/enterprise-snapshot.ts` |
| UR-07 | DIS-29 | `getFundingFigureHistory` | `docs/fnd-funding-model.md` |
| UR-08 | IND-01 | `listIndicators`, `getIndicator` | `docs/ind-indicator-dictionary.md` |
| UR-09 | IND-02 | `listIndicatorEntryRules`, `evaluateIndicatorEntry` | `docs/ind-indicator-dictionary.md` |
| UR-10 | IND-03, DIS-10 | `previewIndicatorImport`, `importIndicatorFile` | `docs/file-import.md` |
| UR-11 | DIS-21, DIS-32, DIS-33 | `buildEnterpriseSnapshot`, `freezeEnterpriseSnapshot`, `listEnterpriseSnapshots`, `getEnterpriseSnapshotReadiness` | `docs/dis-snapshot.md`; `packages/db/src/enterprise-snapshot-store.ts` |
| UR-12 | ADM-06, ADM-15, ADM-18, DIS-06, RPT-02 | `submitFundingFigures`, `returnFundingFigures`, `enterIndicatorFigures` | `docs/adm-approval-workflow.md`; `packages/kernel/src/staged-approval.ts` |
| UR-13 | DIS-34, ADM-31, DIS-15, MDM-11 | `getReportingCalendar`, `getReportingCalendarBoard` | `packages/kernel/src/reporting-schedule.ts`; `docs/teams-relay.md` |
| UR-14 | DIS-21, DIS-22 | `requestPeriodReopen`, `decidePeriodReopen` | `docs/dis-snapshot.md` |
| UR-15 | CAP-07, DIR-01 đến DIR-06, PWA-04 | `addDirective`, `assignDirective`, `recordDirectiveProgress` | `docs/committee-workspace.md` |
| UR-16 | CAP-03, CAP-05, CAP-06 | thao tác của phân hệ CAP | `docs/fnd-funding-model.md` (`origin_decisions`); `docs/capital-balances.md` |
| UR-17 | DIS-35 | `getReportNarrativeContext`, `inheritReportNarrative`, `getReportNarrativeTemplate` | `packages/kernel/src/ent-narrative.ts` |
| UR-18 | EQP-01, EQP-02 | `listEquipmentProcurement`, `getEquipmentProcurement`, `createEquipmentProcurementItem` | `packages/kernel/src/equipment-procurement.ts` |
| UR-19 | HOME-03, HOME-09, BAN-01, PRJ-07 | `getBlockedProjects`, `getDirectiveWidget`, `getDirectivesForReport` | `packages/edition-enterprise/src/leader/tiles.ts` |
| UR-20 | EBS-01, EBS-02 | `previewEbsFile`, `importEbsFile`, `reconcileEbs`, `listEbsDifferences`, `resolveEbsDifference` | `docs/hpm-ebs-connectors.md` |
| UR-21 | RPT-09, RPT-02 | `getReportCrosscheck`, `explainCrosscheckFinding`, `listCrosscheckExplanations`, `issueReport` | `docs/report-engine.md`; `packages/kernel/src/report-crosscheck.ts` |
| UR-22 | RPT-01, RPT-02, RPT-03, RPT-04 | `issueReport`, `getReportDraftFile`, `getReportIssueFile` | `docs/report-engine.md`; `apps/api/src/modules/reports/report-pdf.ts` |
| UR-23 | RPT-07, RPT-08 | `previewReportLayout` | `packages/kernel/src/report-layout-config.ts` |
| UR-24 | HOME-09, BAN-01, BI-02, PWA-03, RML-01 | `getLeaderRates`, `createReportMailSchedule`, `listReportMailings` | `apps/web/src/ui/PresentationMode.tsx`; `Design/MACHVON_Design/01_Documents/05_modules/RML.md` |
| UR-25 | HPM-01, HPM-02 | `submitHpmPush`, `retryHpmPush`, `recordHpmReceipt`, `proposeHpmCorrection`, `decideHpmCorrection` | `docs/hpm-ebs-connectors.md`; `docs/integration/hpm-proposal.md` |
| UR-26 | INT-01, INT-02, INT-04, INT-05 | `createBiReader`, `listBiDatasets`, `listOpenDatasets`, `issueOpenApiToken` | `docs/open-api.md`; `docs/integration/power-bi-model.md` |
| UR-27 | EBS-01, EQP-01, INT-01 đến INT-05 | `getOpenApiDocument`, `listOpenProjects` | `docs/open-api/openapi.json`; `docs/runbooks/infra/keycloak.md` |
| UR-28 | ORG-01, ADM-15, ADM-27 | `getEnterpriseOrgPack`, `materialiseEnterpriseOrgPack` | `packages/kernel/src/org-pack.ts`; `Design/MACHVON_Design/01_Documents/05_modules/ORG.md` |
| UR-29 | ADM-04, ADM-25, ADM-26 | thao tác của phân hệ ADM | `docs/adm-delegation.md` |
| UR-30 | ADM-19 đến ADM-22, ADM-31, RPT-07 | thao tác kho quy tắc của ADM | `docs/governance-roadmap-10of10.md` |
| UR-31 | không có màn riêng | không có | `docs/qa/performance.md`; `docs/qa/perf-budget.json` |
| UR-32 | ADM-11, ADM-12, ADM-29, ADM-30 | `listAuditDetailPolicies`, `saveAuditDetailPolicy`, `getLogCapacity`, `saveLogCapacityPolicy` | `docs/runbooks/audit-export.md`; `docs/runbooks/retention.md` |
| UR-33 | PWA-01 đến PWA-10 | không có | `docs/pwa.md`; `docs/runbooks/browser-differences.md`; `docs/teams-relay.md` |
| UR-34 | không có màn riêng | không có | `docs/runbooks/infra/sizing-uat-prod.md`; `docs/runbooks/infra/environments.md` |
| UR-35 | ADM-32 | `requestBackup`, `decideBackupRequest`, `listBackupRequests`, `recordBackupOutcome` | `infra/backup/backup-policy.json`; `docs/runbooks/infra/backup-immutable.md`; `docs/runbooks/infra/restore-drill.md` |
| UR-36 | ADM-14 | không có | `docs/security/pentest-readiness.md`; `docs/security/ransomware-scenarios.md`; `docs/runbooks/infra/malware-scan.md` |
| UR-37 | IAM-08 và nút trợ giúp của mọi màn web | không có | `apps/web/src/help/help.vi.json`; `apps/web/src/shell/HelpDrawer.tsx`; `scripts/help-index.mjs` |
| UR-38 | không có màn riêng | không có | [05](05-sit-uat-scripts.md) đến [10](10-handover-checklist.md); `docs/UAT-COVERAGE.md` |

### B.2.2 Cách kiểm tiêu chí và thống kê trạng thái

Tiêu chí của từng UR được kiểm bằng ca trong [05](05-sit-uat-scripts.md) (theo mã yêu cầu HSKT) và bộ UAT theo phân hệ (`docs/uat/INDEX.md`). Lưu ý trung thực: `docs/UAT-COVERAGE.md` chỉ phủ các câu chuyện R0 và R1 của nền tảng; các phân hệ enterprise (IND, RPT, DIR, HPM, EBS, ORG, EQP, RML) chưa có thư mục `docs/uat/<phân hệ>/uat.json`, nên tiêu chí của chúng chưa được UAT tự động đối chiếu.

Thống kê 38 yêu cầu ở bản v0.2: DONE 8 (UR-07 đến UR-10, UR-14, UR-29, UR-30, UR-37; UR-08 và UR-09 còn chờ PX-02); DONE trên giả định 17; PARTIAL 13. Số liệu đếm bằng tay từ bảng B.2, chỉ có giá trị khi bảng không đổi.

### B.3 Yêu cầu phi chức năng và ràng buộc

| Mục | Nội dung theo hồ sơ | Ghi chú |
|---|---|---|
| Hạ tầng | Máy chủ của PVFCCo, Ban CĐS&CNTT quản trị sau nghiệm thu | PX-11; cấu hình khuyến nghị UAT và Production: `docs/runbooks/infra/sizing-uat-prod.md` (đề xuất của nhà cung cấp, cần đo trên phần cứng của khách) |
| Kinh phí | Dự toán 3 tỷ đồng, kế hoạch mua sắm 2026 (QĐ 26-61/QĐ-PBHC) | Ngoài phạm vi kỹ thuật |
| Thời gian | [06] tháng kể từ ngày ký hợp đồng | Ngoài phạm vi kỹ thuật |
| Số người dùng | [Ước tính ... người dùng] | PX-17. Để tính cấu hình, nhà cung cấp tạm giả định 150 người dùng có tên và 40 người đồng thời giờ cao điểm; đây không phải số của khách |
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

Giả định làm việc hiện có trong hệ thống cho từng câu (chờ xác nhận, không phải quyết định của khách):

| Câu | Giả định làm việc | Nơi thể hiện |
|---|---|---|
| 1 | Số liệu báo cáo và bản chốt tính theo dự án; cấp cấu phần, gói thầu, hợp đồng có trong nền tảng nhưng chưa là cấp báo cáo | DIS-32, DIS-33; PRJ-05 |
| 2 | Số ước quản lý cùng số thực của kỳ, ghi lịch sử khi số thực thay số ước | DIS-27, DIS-28, DIS-29 |
| 3 | Kỳ vận hành đầu tiên làm mốc, lịch sử chỉ nạp sau khi Ban KHĐT xác nhận phạm vi | [06](06-data-conversion-plan.md); PX-08 |
| 4 | "Sửa chữa lớn" là một loại hình trong danh mục loại dự án, gắn UNVERIFIED | `ENT_PROJECT_TYPE` (kind `MAJOR_REPAIR`) |
| 5 | Chỉ có điều chỉnh kế hoạch trong năm và chỉ đạo giao ban | lịch `PLAN_ADJUSTMENT`, CAP-07, DIR |
| 6 | Nhập tay hoặc tệp; chưa có bộ kết nối eProcurement | EQP-01, EQP-02; PX-06 |
| 7 | Đối chiếu theo mã dự án và kỳ trên tệp theo bố cục giả định | EBS-01, EBS-02; PX-04 |
| 8 | Hai kỳ, theo hồ sơ | [08](08-parallel-run-plan.md); PX-13 |

### B.5 Xác nhận

| Vai trò | Họ tên | Chữ ký, ngày |
|---|---|---|
| Soạn thảo (nhà cung cấp) | [khách điền] | [khách điền] |
| Xác nhận nghiệp vụ (Tổ trưởng Tổ chuẩn hóa dữ liệu) | [khách điền] | [khách điền] |
| Giám sát kỹ thuật (Ban CĐS&CNTT) | [khách điền] | [khách điền] |
| Phê duyệt PVFCCo | [khách điền] | [khách điền] |

Lịch sử sửa: v0.1 khung do hệ thống sinh ngày 2026-11-09 từ hồ sơ kỹ thuật v0.3. v0.2 ngày 2026-11-12, rà soát bởi làn aud4 theo mã nguồn sau khi các làn ENT-3a đến ENT-4e, INFRA-2, DOC-3 gộp: viết lại dòng trạng thái; thêm giả định làm việc về 09 đầu mối (ORG-01), nơi nạp dữ liệu của khách, bảng truy vết vấn đề V1 đến V7 tới chức năng; cập nhật trạng thái 38 yêu cầu UR-01 đến UR-38 (UR-01, UR-02, UR-04, UR-05, UR-06, UR-11, UR-12, UR-15 đến UR-19, UR-21, UR-23, UR-24, UR-28 lên DONE trên giả định; UR-30 và UR-37 lên DONE; UR-03, UR-13, UR-22, UR-25 đến UR-27, UR-31 đến UR-36, UR-38 giữ PARTIAL, ghi rõ điều còn thiếu); thêm bảng B.2.1 (màn hình, thao tác, tài liệu), B.2.2 và bảng giả định cho câu hỏi mở B.4.
