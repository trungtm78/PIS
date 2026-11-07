# Lộ trình quản trị sâu 10/10: cảnh báo, phân tích, kiểm soát vốn

Ngày 08/11/2026. Căn cứ: ba đợt nghiên cứu thị trường và chuẩn (đầu tư công quốc tế và Việt Nam; kiểm soát dự án vốn: Primavera, SAP, Procore, Aconex, FIDIC, NEC4, EVM, OCP red flags; quản trị cảnh báo: ISA-18.2, PagerDuty, ServiceNow, Power BI, Tableau). Nguyên tắc: **không giảm phạm vi, cho phép tăng, thứ tự thực hiện được đổi**. Hạ tầng dùng chung làm trước vì nhiều chức năng dựa vào nó.

## 1. Cách chấm "10/10"

Không có chuẩn bên ngoài nào chấm cả hệ thống này. Mức 10/10 ở đây là: **đạt mọi yêu cầu MUST** của tiêu chí đó trong các nghiên cứu, **và đo được** (IMF PIMA chấm cả "thiết kế trên giấy" lẫn "hiệu quả thực tế"; hệ thống phải tự đo cả hai). Điểm hiện tại dưới đây là ước lượng của tôi từ các tài liệu thiết kế, mã đã làm và kết quả tìm kiếm từ khóa trong spec; cần chủ sản phẩm và kiểm toán xác nhận.

| # | Tiêu chí | Hiện tại (ước lượng) | Khoảng trống chính | Sau lộ trình |
|---|---|---|---|---|
| C1 | Kiểm soát vòng đời đầu tư | 5 | Chưa có cổng giai đoạn chặn chuyển bước; baseline có phê duyệt nhưng chưa tính độ lệch và số lần dời mốc; chưa có điều kiện "không có kế hoạch vốn trên hệ thống thì không giải ngân" | 10 |
| C2 | Kiểm soát tiền | 6 | Chưa có EVM (CPI/SPI/EAC), đường S theo baseline, sổ dự phòng, thay đổi nhiều tầng theo ngưỡng, sổ claim, khớp ba bên tự động | 10 |
| C3 | Cảnh báo và leo thang | 6 | Từng cảnh báo mạnh; thiếu quản trị cả hệ thống: sổ loại cảnh báo, trần hoãn, hai đồng hồ nhận/xử lý, giờ yên tĩnh, bản tin, trần đẩy, biên nhận giao nhận, độ phủ ủy quyền, KPI của chính hệ thống cảnh báo | 10 |
| C4 | Phân tích điều hành | 6 | Chưa có sổ KPI một định nghĩa, RAG giải thích được, dự báo có dải, "tuần này thay đổi gì", nhật ký quyết định, SLA độ tươi, xếp hạng chuẩn hóa | 10 |
| C5 | Toàn vẹn, chống sai phạm | 6 | Có maker-checker và nhật ký; thiếu ma trận tách nhiệm vụ kiểm tại commit, kiểm hóa đơn trùng/giá bất thường, 12 chỉ báo red flag mua sắm | 10 |
| C6 | Chất lượng dữ liệu, đối soát | 5 | Có DGV; thiếu đối soát KBNN hằng ngày làm hạng mục có chủ, tổng khớp theo chiều trước khi công bố, thẻ điểm chất lượng công khai | 10 |
| C7 | Minh bạch, giám sát bên ngoài | 3 | Chưa có gói hồ sơ giám sát cộng đồng (Luật 58 Điều 78-79), cổng công khai, xuất OC4IDS, lịch đánh giá theo Điều 76-77, mẫu báo cáo đi Bộ Tài chính | 10 |
| C8 | Khả năng mở rộng | 6 | Ngưỡng và quy tắc nằm rải rác; cần một nơi dữ liệu có phiên bản, có phê duyệt (xem mục 2) | 10 |

## 2. Hạ tầng dùng chung (làm trước, mở rộng về sau)

Mọi chức năng mới là **cấu hình dữ liệu, không phải hằng số trong mã**. Năm khối:

1. **Kho quy tắc quản trị (`governance_rule`)**: mỗi quy tắc có loại, tham số, hiệu lực từ-đến, phiên bản, người lập, người duyệt (maker ≠ checker), ghi ADM-11, ghi đè theo tổ chức (SAS-04 đã có mẫu). Dùng cho: sổ loại cảnh báo, ngưỡng RAG, ngưỡng thay đổi hợp đồng, tiêu chí cổng giai đoạn, ma trận SoD, bộ red flag, chính sách thông báo, lịch làm việc. Ngưỡng của nghiên cứu (0,95/0,85, 10%, K = 5/ngày…) chỉ là **giá trị khởi điểm cần chốt với khách hàng và kiểm toán**.
2. **Bộ máy đồng hồ (`clock`)**: điều kiện bắt đầu, tạm dừng (có lý do và người cho phép), dừng; lịch ngày làm việc (ADM-working-time); mỗi đồng hồ sinh mục cảnh báo có hậu quả và nhịp nhắc. Gom các đồng hồ đang rải rác (DIS-20, tạm ứng PAY, giấy phép PMT, SLA vướng mắc ISS, bảo lãnh CTR) và thêm đồng hồ hợp đồng, thời hạn thanh toán 2 ngày/tạm ứng 1 ngày (NĐ 254/2025), quyết toán 5/4 tháng.
3. **Đường ống cảnh báo**: nguồn → khử trùng và gộp → chính sách (mức, kênh, giờ yên tĩnh, trần) → giao nhận (`notification_delivery`) → hành động (`work_action` đã có) → KPI. Giữ nguyên hợp đồng API hiện có, chỉ thêm trường.
4. **Lớp số liệu**: sổ KPI (một định nghĩa, một chủ sở hữu, hiệu lực), dataset có trạng thái chứng nhận, ảnh chụp số liệu (dis-snapshot mở rộng cho mọi KPI), SLA độ tươi, nhật ký quyết định chỉ bổ sung.
5. **Bộ nối ra ngoài**: mã dự án quốc gia là khóa, nhập và đối soát KBNN, xuất mẫu báo cáo đi Bộ Tài chính, xuất OC4IDS/OCDS, kênh Zalo ZNS/SMS. Mỗi bộ nối có trạng thái (hoạt động/trễ/lỗi) hiện ở thanh ngữ cảnh. Kết nối trực tiếp với hệ thống quốc gia phụ thuộc cơ quan quản lý mở giao diện (chưa kiểm chứng), nên làm nhập/xuất tệp trước.

## 3. Danh mục chức năng hợp nhất (không bớt mục nào)

Mã nguồn: P# = nghiên cứu đầu tư công; K# = kiểm soát dự án vốn; A#/B# = cảnh báo/phân tích. Kích cỡ: S ≤ 1 tuần, M 1-3 tuần, L > 3 tuần (một nhóm ba tác tử). Làn: G0 hạ tầng, G1 vốn và vòng đời, G2 cảnh báo, G3 phân tích, G4 toàn vẹn và minh bạch.

**G0: hạ tầng**
| ID | Chức năng | Nguồn | Module | Mức | Cỡ |
|---|---|---|---|---|---|
| G0-1 | Kho quy tắc quản trị có phiên bản, phê duyệt, hiệu lực, ghi đè theo tổ chức | A1, B2, K05, K14 | ADM, SAS | MUST | L |
| G0-2 | Bộ máy đồng hồ và lịch ngày làm việc, hợp nhất đồng hồ có sẵn | A5, K07, P12, P13 | NOT, ADM, các module nguồn | MUST | L |
| G0-3 | Sổ loại cảnh báo (chủ sở hữu, hành động mong đợi, hậu quả, thời hạn đáp ứng, lý do tồn tại, ngày xét lại) | A1 | NOT, ADM | MUST | M |
| G0-4 | Sổ KPI một định nghĩa; mỗi số có nút "i" mở công thức, nguồn, giờ cập nhật; kiểm đối chiếu web, di động, Excel | B2, P7 | BI, HOME | MUST | L |

**G1: vòng đời và tiền**
| ID | Chức năng | Nguồn | Module | Mức | Cỡ |
|---|---|---|---|---|---|
| G1-1 | Cổng giai đoạn: tiêu chí là dữ liệu, chặn chuyển trạng thái, ngoại lệ có duyệt | P1, K14 | PRJ, ADM, DOC | MUST | L |
| G1-2 | Điều kiện giải ngân: thiếu danh mục hoặc kế hoạch vốn trên hệ thống thì chặn đề nghị thanh toán, báo đúng nguyên nhân (NĐ 85/2025 Điều 53) | P2 | CAP, PAY | MUST | M |
| G1-3 | Baseline bất biến, độ lệch so với v0, số lần dời mốc (≥ 3 lần báo kiểm toán), tái thẩm định khi vượt ngưỡng | P3, K21 | PRJ, CTR, DIS | MUST | M |
| G1-4 | EVM đủ bộ (PV, EV, AC, CPI, SPI, EAC, ETC, VAC, TCPI); EV chỉ từ khối lượng đã nghiệm thu; ghi công thức EAC đang dùng; thiếu baseline thì "chưa đủ dữ liệu" | K01 | PRJ, CTR, PAY, BI | MUST | L |
| G1-5 | Đường S so với baseline v0 và hiện hành, có "xem tại ngày" và bảng thay thế | K02 | PRJ, DIS, BI | MUST | M |
| G1-6 | Khả dụng vốn xuống cấp hợp đồng và thay đổi; EAC vượt tổng mức thì URGENT | K03 | CAP, PRJ | MUST | M |
| G1-7 | Sổ dự phòng và dự trữ quản lý (rút gắn rủi ro hoặc lệnh thay đổi, bất biến) | K04 | PRJ, CTR | MUST | M |
| G1-8 | Thay đổi hợp đồng nhiều tầng theo ngưỡng và ủy quyền, cộng dồn so với giá gốc, chặn khi hết vốn | K05 | CTR, ADM | MUST | M |
| G1-9 | Sổ claim có thời hiệu theo từng hợp đồng (không gán mặc định FIDIC cho hợp đồng nội địa) | K06 | CTR, ISS, AUD | MUST | M |
| G1-10 | Khớp ba bên đo, nghiệm thu, thanh toán và báo cáo cho kiểm toán; giữ lại; chặn giải phóng khi còn tồn đọng chất lượng, bảo hành hoặc claim | K08, K09 | PAY, CTR, QMS, AST | MUST | M |
| G1-11 | Tạm ứng: trần theo chính sách có hiệu lực theo ngày, bảng thu hồi dự kiến so với thực tế, dư nợ vượt giá trị còn lại thì URGENT | K10 | PAY | MUST | M |
| G1-12 | Điều chuyển vốn theo hiệu suất, mô phỏng tác động lên tỷ lệ toàn tỉnh, duyệt theo ủy quyền | P5 | CAP | MUST | M |
| G1-13 | Chấm điểm thẩm định, kết quả khuyến nghị / thiếu thông tin / không khuyến nghị, kho dự án đã thẩm định | P4 | PRJ, CAP | MUST (kết quả) | M |
| G1-14 | Sổ rủi ro có điểm trước và sau phản ứng, trigger tự động từ CPI/SPI, đồng hồ, tạm ứng treo | K11 | PRJ | MUST | M |
| G1-15 | Sổ cảnh báo sớm hợp đồng (sổ đầu 1 tuần, họp 2 tuần, phát hành lại 1 tuần sau họp) tách khỏi cảnh báo giải ngân | K12 | ISS, CTR | MUST | M |
| G1-16 | Dự báo giải ngân tới 31/12 và các mốc chỉ đạo; đo độ chính xác dự báo của từng chủ đầu tư | P10, B7 | DIS, CAP | MUST | M |
| G1-17 | Đồng hồ thanh toán 2 ngày làm việc, tạm ứng 1 ngày, lý do trả lại chuẩn hóa, mẫu 03.a/04.a/05.a/TT | P12 | PAY | MUST | M |
| G1-18 | Hợp đồng gắn dự án, gói thầu, nhà thầu; thay đổi tạo bản điều chỉnh tác động baseline; quyết toán 5/4 tháng có đồng hồ | P13 | CTR, BID | MUST | M |
| G1-19 | Look-ahead 2-6 tuần và bài học kinh nghiệm bắt buộc ở cổng đóng | K13 | QMS, PRJ, MNE | NICE | M |

**G2: quản trị cảnh báo**
| ID | Chức năng | Nguồn | Module | Mức | Cỡ |
|---|---|---|---|---|---|
| G2-1 | Hoãn có lý do, trần theo mức (Cần xử lý ≤ 3 ngày, Theo dõi ≤ 14 ngày), tối đa 2 lần liên tiếp, lần cuối báo cấp trên; danh sách "đang bị hoãn" | A3 | NOT, HOME | MUST | S |
| G2-2 | Hai đồng hồ đến-nhận và đến-xử lý; "cần nhận lại" khi đã nhận nhưng im lặng; dừng đồng hồ có lý do và người cho phép | A5 | NOT | MUST | M |
| G2-3 | Leo thang đánh dấu chức năng hay thứ bậc, leo theo trạng thái, Theo dõi tồn lâu thì nâng một bậc | A4 | NOT | MUST | M |
| G2-4 | Nhịp nhắc theo mức, ghi từng lần nhắc | A5 | NOT | MUST | S |
| G2-5 | Hồ sơ thông báo mỗi người: giờ yên tĩnh có ngoại lệ Khẩn đã quá hạn nhận, bản tin sáng, trần đẩy mỗi ngày, gộp cùng gốc; chuông trong ứng dụng luôn nói thật | A6 | NOT, IAM, MOB | MUST | L |
| G2-6 | Biên nhận giao nhận, thang kênh đẩy, Zalo hoặc SMS, leo cấp; mẫu tin không chứa số liệu tài chính; quản lý đồng ý nhận tin | A7 | NOT, ADM | MUST | L |
| G2-7 | Ủy quyền vắng mặt, kiểm tra độ phủ, cảnh báo mồ côi tự rơi lên cấp trên, báo cáo độ phủ vai trò | A8 | IAM, NOT, ADM | MUST | L |
| G2-8 | Tự đóng theo điều kiện nguồn; mở lại nếu điều kiện còn; báo cáo "đóng nhưng không có bản ghi" | A9 | NOT | MUST | M |
| G2-9 | Nút "cảnh báo này không đúng" có danh mục lý do vào hàng đợi chủ loại | A10 | NOT | MUST | S |
| G2-10 | Trang "Sức khỏe hệ thống cảnh báo" với 14 KPI (MTTA, MTTR, % đúng hạn, % leo thang, cảnh báo/người/ngày, đẩy/người/ngày, ngoài giờ, tồn cũ, Top-10 loại, tỷ lệ hoãn, mồ côi, giao nhận Khẩn, độ phủ ủy quyền) | A2 | BI, HOME | MUST | L |
| G2-11 | Phát hiện lũ: quá ngưỡng thì gộp thành thẻ tóm tắt, giữ riêng Khẩn | A2 | NOT | MUST | S |
| G2-12 | Nguồn mới: đồng hồ hợp đồng, rà soát tài liệu, độ tươi dữ liệu, bất thường | K07, K16, B8 | NOT | MUST | M |

**G3: phân tích điều hành**
| ID | Chức năng | Nguồn | Module | Mức | Cỡ |
|---|---|---|---|---|---|
| G3-1 | Dataset có trạng thái Nháp/Đã xác nhận/Đã chứng nhận/Lỗi thời; HOME-03 và dashboard lãnh đạo chỉ dùng metric đã chứng nhận | B1 | BI | MUST | M |
| G3-2 | RAG có quy tắc, "vì sao đỏ" 1-3 yếu tố, độ bao phủ dữ liệu, ghi đè phải có lý do; điểm cảnh báo sớm có phân rã, lưu theo tuần | K15, B3 | BI, HOME | MUST | L |
| G3-3 | Drill-through ba bước KPI → đơn vị/dự án → hồ sơ, giữ bộ lọc, không lộ tên ngoài quyền | B6 | HOME | MUST | M |
| G3-4 | Khối "Thay đổi từ tuần trước" sinh theo luật, tối đa 5 dòng, mỗi dòng có liên kết | B6 | HOME, BI | MUST | M |
| G3-5 | Dự báo cuối năm có dải theo tốc độ 4-8 tuần, lũy kế và mùa vụ; "cần bao nhiêu mỗi tuần" | B7 | BI, DIS | MUST | M |
| G3-6 | Nhật ký quyết định gắn HOME-03 và cảnh báo Khẩn, chụp số liệu tại thời điểm quyết định | B7, P17 | BI, HOME, ADM | MUST | M |
| G3-7 | SLA độ tươi theo dataset, "Số liệu cũ" tự hiện, thẻ điểm chất lượng theo module và đơn vị | B8, P5.table | BI, DGV | MUST | M |
| G3-8 | Xếp hạng nhiều chỉ số, chuẩn hóa theo quy mô, chú thích đơn vị vướng ngoài kiểm soát có người duyệt, cho khiếu nại số liệu; cặp tỷ lệ giải ngân với tiến độ vật lý | P8, B5 | DIS, HOME | MUST | M |
| G3-9 | Phân tích điểm nghẽn có số tiền bị giữ, nguyên nhân chuẩn, tuổi nợ, người giữ; dự án dừng có hồ sơ lý do và kế hoạch khởi động lại | P9 | HOME, ISS, LND, PMT | MUST | M |
| G3-10 | Heat-map theo đơn vị, nguồn vốn, nhà thầu | K15 | BI | MUST | M |
| G3-11 | Truy nguồn metric ← dataset ← bảng ← module; backtest ngưỡng cảnh báo sớm; xếp hạng xu hướng; dự báo theo nguồn vốn | B1, B3, B5, B7 | BI | NICE | M |

**G4: toàn vẹn, đối soát, minh bạch**
| ID | Chức năng | Nguồn | Module | Mức | Cỡ |
|---|---|---|---|---|---|
| G4-1 | Ma trận tách nhiệm vụ (dữ liệu), kiểm tại commit ở CTR, PAY, BID; ngoại lệ có hạn, hai người duyệt | K17, K08 | ADM, CTR, PAY, BID | MUST | L |
| G4-2 | Kiểm toàn vẹn thanh toán: trùng, đơn giá bất thường, vượt hợp đồng, khối lượng lệch nhật ký | K19 | PAY, CTR | MUST | M |
| G4-3 | Red flag mua sắm: 12 chỉ báo tính được từ dữ liệu BID/CTR (R011, R002, R055, R054, R059, R069, R064, R018, R003, R031, R046, R028), chỉ gửi AUD, chặn người liên quan; xếp hạng để điều tra, không kết luận | K20 | BID, CTR, AUD | MUST | L |
| G4-4 | Đối soát KBNN hằng ngày theo mã dự án và nguồn vốn, chênh lệch vượt ngưỡng thành hạng mục có chủ | P18, P5.table | PAY, DIS, DGV | MUST | M |
| G4-5 | Tổng khớp theo chiều (đơn vị = nguồn = dự án) trước khi công bố chỉ số; giải ngân không vượt kế hoạch, hợp đồng, nghiệm thu | P5.table | DIS, BI, PAY | MUST | M |
| G4-6 | Báo cáo kỳ có chữ ký số, khóa kỳ, xuất đúng mẫu đi Bộ Tài chính (tuần, tháng, quý, năm) | P6, P18 | DIS | MUST | M |
| G4-7 | Lịch đánh giá tự sinh theo nhóm dự án (Điều 76-77 Luật 58: nhóm A đủ 4 loại; B, C kết thúc và tác động), chỉ tiêu lợi ích gắn từ PRJ | P14 | MNE, PRJ | MUST | M |
| G4-8 | Gói hồ sơ giám sát cộng đồng: hạn thông báo 45 ngày, theo dõi phản hồi và trả lời | P16 | PRJ, DOC | MUST | M |
| G4-9 | Cổng công khai chỉ đọc theo bộ trường được phép; xuất OC4IDS | P16, P13 | PRJ, SAS | NICE | L |
| G4-10 | Liên kết khuyến nghị kiểm toán vào xếp hạng và hồ sơ chủ đầu tư | P15 | AUD, DIS | MUST | S |
| G4-11 | Transmittal tài liệu có hạn xem xét, trạng thái WIP/Shared/Published/Archive | K16 | DOC | MUST | M |
| G4-12 | Kênh tố giác ẩn danh, sổ quà tặng; kiểm ảnh hiện trường (EXIF/GPS/băm, không trùng giữa dự án); cổng nhà thầu; Monte Carlo; đo lợi ích sâu; kết nối trực tiếp hệ thống quốc gia | K17, K18, K22, P14, P18 | LND, BID, QMS, IAM | NICE | L |

Nguyên tắc cố định xuyên suốt: **AI hoặc ảnh không quyết định thanh toán**; mọi số ghi nguồn và độ tươi; không âm thanh, không nhấp nháy; mọi thay đổi cấu hình, hoãn, ủy quyền, dừng đồng hồ ghi ADM-11.

## 4. Trình tự thực hiện (đã đổi so với kế hoạch ban đầu)

1. **Hoàn tất dữ liệu nghiệp vụ thật cho clip và ảnh** (đang làm). Không dừng: các chức năng dưới đây cần dữ liệu thật để kiểm.
2. **G0** (kho quy tắc, bộ máy đồng hồ, sổ loại cảnh báo, sổ KPI): khóa hợp đồng API và dữ liệu trước, vì G1-G4 dựa vào.
3. **G1** và **G2** chạy song song (hai nhóm tác tử, không chung tệp): G1 theo thứ tự nền dữ liệu (G1-3, G1-4, G1-5) → kiểm soát tiền (G1-6..G1-11) → hạn và quyền (G1-15, G1-9, G1-17) → danh mục và cổng (G1-1, G1-13, G1-14). G2 theo thứ tự G2-1, 2, 4, 5, 7, 10 rồi G2-3, 6, 8, 9, 11, 12.
4. **G3** sau khi G0-4 và dữ liệu G1 có số; **G4** song song từng phần: G4-1, G4-2, G4-4, G4-5 trước (kiểm soát), G4-3 (red flag) sau khi G4-1 xong, G4-8 và G4-9 cuối.
5. Mỗi làn kết thúc bằng: kiểm thử, dữ liệu mẫu thật, ảnh chụp, **quay lại chương hướng dẫn tương ứng** (các chương là mô-đun nên quay lại từng phần).

## 5. Tiêu chí nghiệm thu 10/10

- Mọi ngưỡng, quy tắc, định nghĩa KPI nằm trong kho quy tắc, có phiên bản và người duyệt; không còn hằng số ngưỡng trong mã (kiểm bằng quét mã).
- Mỗi con số trên HOME-01/03 có công thức, nguồn, giờ cập nhật, ngày chốt; web, di động, Excel khớp nhau (test đối chiếu).
- 14 KPI của hệ thống cảnh báo đo được từ dữ liệu thật; trang sức khỏe cảnh báo hiển thị đủ.
- Không cảnh báo mồ côi: mọi cảnh báo có người nhận hợp lệ, chuỗi leo thang không bao giờ trống.
- Mọi thay đổi tiền hoặc trạng thái dựng lại được "số liệu tại ngày X" từ nhật ký.
- Mỗi chức năng MUST có: test đơn vị và API, kịch bản duyệt trên giao diện, dữ liệu mẫu thật, ảnh chụp, đoạn hướng dẫn.
- Kiểm chứng pháp lý trước khi cam kết với khách: văn bản gốc NĐ 85/2025, NĐ 275/2025, NĐ 254/2025, hiệu lực NĐ 40/2020 và CV 8310/VPCP-KTTH, bộ KPI CV 659/VPCP-CĐS, trần tạm ứng và mức giữ lại bảo hành, thời hiệu claim theo hợp đồng mẫu.

## 6. Rủi ro và điểm chưa kiểm chứng

- Ngưỡng ISA-18.2/EEMUA (khoảng 1-2 cảnh báo/10 phút/người) là của công nghiệp, lấy từ tài liệu tóm tắt của hãng, **không áp trực tiếp**; dùng làm phương pháp và hiệu chỉnh bằng dữ liệu thật sau 4-6 tuần.
- Số liệu và pháp lý Việt Nam trong nghiên cứu đến từ trang tổng hợp và báo chí, chưa đối chiếu Công báo. Trang hethongphapluat.com khi tải có chèn dòng chỉ dẫn lạ; nội dung đó bị bỏ qua, chỉ dùng URL làm nguồn.
- Sản phẩm và chuẩn chưa mở được bản gốc: InEight, Kahua, Trimble, Hexagon/Bentley, Smartsheet, Power Platform, COSO ERM, ISO 19650/21502/37001, PMI EVM Standard, AACE 40R-08, ServiceNow on-call, Splunk On-Call, Zalo ZNS callback, báo cáo PIMA Việt Nam.
- Xếp hạng công khai có rủi ro hành vi sai (đơn vị làm đẹp số, phạt đơn vị báo cáo tốt): hạn chế bằng G3-8 (nhiều chỉ số, chuẩn hóa, khiếu nại).
- Red flag chỉ là tín hiệu điều tra; phải giới hạn quyền xem và không hiển thị như kết luận.
- Quy mô: G0-G4 gồm khoảng 60 hạng mục, 14 hạng mục cỡ L. Làm tuần tự mất nhiều tháng; chạy theo làn song song với kiểm thử và dữ liệu thật mới đạt nhịp hợp lý.
