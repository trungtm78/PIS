# Đề xuất phương thức tích hợp với HPM (yêu cầu TH.01)

Bản nháp để trao đổi với Ban CĐS&CNTT của PVFCCo. Căn cứ: hồ sơ kỹ thuật "Phần mềm quản lý ĐTXD" v0.3 (TH.01), đặc tả phân hệ `Design/MACHVON_Design/01_Documents/05_modules/HPM.md`, mô tả hiện trạng `docs/hpm-ebs-connectors.md`, mã nguồn `packages/edition-enterprise/src/integration` (cổng `HpmPort`, quy tắc `hpm-rules.ts`, sổ đẩy `hpm-store.ts`).

Trạng thái: **PENDING-EXTERNAL**. Phần dưới đây là đề xuất của nhà cung cấp; cấu trúc dữ liệu và giao diện kỹ thuật của HPM chưa được cung cấp, nên mọi điều phụ thuộc vào HPM đều ghi là giả định cho tới khi Ban CĐS&CNTT xác nhận.

## 1. Yêu cầu và điều đã biết

Yêu cầu TH.01: tự động đẩy số liệu báo cáo tháng (và dữ liệu khác theo yêu cầu của HPM) đã được Ban KHĐT chốt sang HPM đúng cấu trúc dữ liệu của HPM, thay việc nhập tay; ghi nhận kết quả đẩy, cảnh báo lỗi, cho phép đẩy lại; xử lý trường hợp điều chỉnh số liệu sau khi đẩy (ghi đè kỳ hoặc điều chỉnh ở kỳ sau) theo một quy tắc thống nhất. Nhà cung cấp đề xuất phương thức phù hợp với khả năng của HPM.

Điều đã biết về HPM: là hệ thống báo cáo của Tổng công ty, nhận số liệu tháng sau khi Ban KHĐT chốt. **Chưa biết**: nền tảng, đơn vị phát triển, có mở API hay không, cấu trúc dữ liệu, cách nhận trùng, cách xử lý ghi đè (xem danh sách cần cung cấp ở mục 5).

Điều đã có trong MACHVON (bản doanh nghiệp):

| Thành phần | Trạng thái |
|---|---|
| Cổng `HpmPort` và bộ ghi tệp `HpmFileWriter` | Có. Dựng gói zip (`manifest.json` + báo cáo + tệp đính kèm), cố định thời gian trong zip nên cùng yêu cầu cho cùng byte (một lần gửi lại chỉ khác số lần thử và thời gian trong bản kê); ghi vào thư mục của tenant, không mở kết nối mạng |
| Khóa chống trùng `tổ chức, mẫu, kỳ, rN` | Có. `hpm_push` duy nhất theo (tenant, khóa); nội dung khác dưới cùng khóa là `HPM_KEY_REUSED` |
| Đẩy lại | Có. `hpm_push_attempt` chỉ thêm, tối đa `max_attempts` của quy tắc `HPM_PUSH_POLICY` (mặc định 5, chưa kiểm chứng), hết lượt là `HPM_RETRY_EXHAUSTED` |
| Thứ tự phiên bản | Có. Bản cũ hơn bản đã phát hành hoặc bản HPM đã nhận là `REPORT_OUT_OF_DATE`; cùng byte là `ALREADY_DELIVERED` |
| Ghi biên nhận | Có. Do người khác người đẩy ghi; bản mẫu DEMO không bao giờ được ghi là đã nhận |
| Ghi đè kỳ đã nhận | Có. Cần kỳ mở lại (DIS) và đính chính do hai người đề nghị và duyệt, dùng một lần |
| Độ mới và cảnh báo | Có. `FRESH`, `AGING`, `STALE`; cảnh báo `HPM_PUSH_FAILED`, `HPM_PUSH_STALE` cho quản trị tích hợp |
| Bước PUSH của quy trình duyệt gọi đẩy HPM | **Chưa** (kế hoạch ENT-3c); hiện PUSH là bước người |
| Điều chỉnh "ở kỳ sau" | **Chưa** (kế hoạch ENT-3c); mới có ghi đè |
| Mã dự án HPM theo từng dự án | **Chưa** (kế hoạch ENT-3e, qua `master_crosswalk`) |
| Bộ chuyển tiếp API cho `HpmPort` | **Chưa**, chờ giao diện của HPM |

## 2. Ba phương thức

### 2.1 API / web service

MACHVON gọi API của HPM (REST/JSON hoặc SOAP) từ phía ra: một lời gọi cho mỗi báo cáo, mang khóa chống trùng, nhận phản hồi đồng bộ hoặc biên nhận bất đồng bộ.

- Ưu: kiểm tra hợp lệ ngay, có mã lỗi cụ thể cho từng lần thử; ghi nhận "đã nhận" tự động, không cần người ghi; khóa chống trùng ánh xạ thẳng vào tiêu đề `Idempotency-Key`; ít thành phần trung gian; ghi đè và điều chỉnh có thể biểu diễn bằng phiên bản.
- Nhược: cần HPM có API ổn định, có tài liệu, có môi trường thử; cần mở đường ra từ MACHVON tới HPM (một địa chỉ trong danh sách cho phép đường ra); hai hệ thống ràng buộc về thời gian chạy (HPM bảo trì thì phải thử lại).
- Hợp với kiến trúc hiện tại: bộ chuyển tiếp thay `HpmFileWriter` sau `HPM_PORT`, sổ đẩy, quy tắc và màn hình giữ nguyên.

### 2.2 Cơ sở dữ liệu trung gian

Hai bên thống nhất một lược đồ trung gian (bảng tạm) đặt trong cơ sở dữ liệu của một bên; MACHVON ghi dòng vào bảng, HPM (hoặc tác vụ ETL của HPM) đọc và nạp.

- Ưu: dùng được khi HPM chỉ có khả năng đọc cơ sở dữ liệu hoặc ETL có sẵn; bên nhận chủ động theo nhịp của mình.
- Nhược: cần tài khoản cơ sở dữ liệu xuyên vùng mạng (trái với nguyên tắc cơ sở dữ liệu không nối trực tiếp Internet và quyền tối thiểu của HT.02 nếu bảng đặt ở vùng ngoài); không có biên nhận tự nhiên (phải thêm cột trạng thái hai chiều); trùng và ghi đè phải tự dựng bằng khóa duy nhất và trạng thái; lược đồ chung là một hợp đồng khó đổi phiên bản; khó truy vết lỗi từng lần thử; thêm một cơ sở dữ liệu để vận hành và sao lưu.
- Chỉ nên chọn khi HPM không thể làm gì khác.

### 2.3 Tệp chuẩn

MACHVON dựng một gói tệp chuẩn (cấu trúc, mã hóa, tên và băm đã thống nhất) và chuyển qua kênh đã thỏa thuận: thư mục chia sẻ có kiểm soát, SFTP hoặc kho đối tượng; HPM nhập gói theo lịch hoặc theo sự kiện.

- Ưu: yêu cầu thấp nhất với HPM (chỉ cần nhập tệp, vốn là cách nhập tay hôm nay); tách rời thời gian chạy của hai hệ thống; gói có băm và bản kê nên kiểm chứng được và lưu được làm bằng chứng; MACHVON đã có sẵn bộ ghi tệp và gói zip.
- Nhược: biên nhận không tự động (HPM phải trả tệp biên nhận hoặc người ghi nhận); kiểm tra hợp lệ muộn (lỗi chỉ biết sau khi HPM nhập); phải có quy ước tên và vị trí tệp, dọn tệp cũ; có thể bị nhập trùng nếu HPM không dùng khóa trong bản kê.

### 2.4 So sánh

| Tiêu chí | API / web service | CSDL trung gian | Tệp chuẩn |
|---|---|---|---|
| Đòi hỏi ở HPM | API có tài liệu, môi trường thử | Đọc bảng hoặc ETL | Nhập tệp |
| Biên nhận | Tự động, đồng bộ hoặc bất đồng bộ | Phải thêm cột trạng thái hai chiều | Tệp biên nhận hoặc người ghi |
| Chống trùng | Khóa trong tiêu đề, HPM từ chối trùng | Khóa duy nhất trong bảng | Khóa trong bản kê, HPM phải tôn trọng |
| Phát hiện lỗi | Ngay | Khi HPM đọc | Khi HPM nhập |
| Đẩy lại, ghi đè | Tự nhiên (cùng khóa; phiên bản mới) | Tự dựng | Gói mới có số phiên bản; HPM phải biết thay |
| Ranh giới an ninh | Một địa chỉ ra, kênh TLS, bí mật trong kho | Tài khoản CSDL xuyên vùng | Kênh tệp, ký hoặc băm gói |
| Truy vết | Nhật ký từng lần gọi | Nhật ký phải tự dựng | Gói lưu lại đúng như đã gửi |
| Công sức MACHVON | Bộ chuyển tiếp mới (nhỏ) | Lược đồ và tác vụ mới | Đã có (cần chốt cấu trúc) |
| Chi phí bản quyền | Không | Có thể (giấy phép CSDL, ETL) | Không |
| Hợp lý khi | HPM có API | HPM chỉ đọc CSDL | HPM chưa có gì, hoặc làm cầu nối |

## 3. Khuyến nghị

**Đích: API / web service. Cầu nối ngay: tệp chuẩn. CSDL trung gian: chỉ khi Ban CĐS&CNTT xác nhận HPM không thể nhận bằng hai cách trên.**

Lý do (theo tiêu chí quản trị sâu nhất và khả năng mở rộng):
1. Tệp chuẩn dùng được ngay và không chờ HPM; bộ ghi tệp, khóa chống trùng, đẩy lại, biên nhận và ghi đè có kiểm soát đã chạy được trong MACHVON, nên rủi ro tiến độ thấp nhất.
2. API cho biên nhận tự động và phát hiện lỗi ngay, là cách duy nhất cho phép bước PUSH của quy trình duyệt tự gọi HPM và đóng vòng "đẩy rồi mới biết" thành "đẩy và biết kết quả".
3. Hai cách dùng cùng một cổng `HpmPort`, cùng khóa và cùng sổ đẩy: chuyển từ tệp sang API chỉ là đổi bộ chuyển tiếp, không đổi sổ, quy tắc hay màn hình, nên không có việc làm lại.
4. CSDL trung gian làm tăng bề mặt tấn công và công vận hành, mâu thuẫn với nguyên tắc quyền tối thiểu của HT.02, nên chỉ là phương án cuối.

## 4. Kế hoạch theo giai đoạn

| Giai đoạn | Nội dung | Điều kiện vào | Tiêu chí ra |
|---|---|---|---|
| G0 (đã có) | Bộ ghi tệp với cấu trúc giả định `HPM-FILE-WORKING-ASSUMPTION-2026.1`, ghi biên nhận bằng tay | Không | Nhãn PENDING-EXTERNAL hiển thị; không có kết nối mạng ra ngoài (kiểm thử tự động) |
| G1 | Chốt cấu trúc gói chuẩn với HPM: tệp dữ liệu theo đúng cấu trúc HPM + bản kê; kênh chuyển (thư mục/SFTP); tệp biên nhận trả về; ánh xạ mã dự án HPM; bước PUSH của quy trình duyệt gọi đẩy; điều chỉnh "ở kỳ sau" | Mục 5 mục A và B được cung cấp | HPM nhập thử đúng một kỳ thật trên môi trường thử; số liệu khớp từng chỉ tiêu; đẩy lại không nhập trùng |
| G2 | Bộ chuyển tiếp API thay bộ ghi tệp (nếu HPM mở API); khóa chống trùng đi theo tiêu đề; biên nhận đồng bộ hoặc bằng gọi lại; danh sách cho phép đường ra có đúng một địa chỉ HPM | Mục 5 mục C; môi trường thử có API | Bộ kiểm thử hợp đồng với giả lập HPM đạt; một kỳ thật chạy song song với G1, hai kết quả giống nhau |
| G3 | Vận hành thử cùng kỳ chạy song song 02 kỳ báo cáo (TK.04): đẩy tự động, đối chiếu với nhập tay, khắc phục; cảnh báo và đẩy lại được diễn tập | G1 hoặc G2 xong | Biên bản đối chiếu hai kỳ do Ban KHĐT ký; không còn khác biệt chưa giải trình |
| G4 | Đối chiếu ngược (đọc lại trạng thái kỳ từ HPM để so với sổ đẩy) nếu HPM cung cấp | HPM có API đọc | Cảnh báo khi trạng thái lệch quá một chu kỳ |

Mỗi giai đoạn kết thúc bằng một bản xác nhận của Ban CĐS&CNTT; cho tới đó mọi kết quả mang nhãn PENDING-EXTERNAL và không được dùng để nghiệm thu.

## 5. Thông tin Ban CĐS&CNTT cần cung cấp

**A. Về HPM.**
1. Nền tảng, phiên bản, đơn vị phát triển và đầu mối kỹ thuật; hệ thống đặt tại đâu (máy chủ PVFCCo hay ngoài) và vùng mạng.
2. HPM có mở API hay không; nếu có: tài liệu (OpenAPI/WSDL), địa chỉ môi trường thử và thật, cách xác thực (OAuth 2, khóa API, chứng thư hai chiều, thư mục AD), giới hạn tần suất, giới hạn kích thước, cửa sổ bảo trì.
3. Nếu không có API: HPM nhập được tệp không (định dạng, mã hóa ký tự, kích thước tối đa, kênh nhận, lịch nhập) hoặc đọc được cơ sở dữ liệu trung gian không.

**B. Về dữ liệu.**
4. Cấu trúc dữ liệu báo cáo tháng mà HPM nhận: danh sách trường, kiểu, bắt buộc hay không, danh mục mã đi kèm, quy ước kỳ (tháng, ngày chốt, lũy kế hay phát sinh), đơn vị tiền (đồng, nghìn đồng).
5. Mã dự án trong HPM và quan hệ với mã của EBS và mã nội bộ; mã đơn vị/đầu mối; danh sách loại báo cáo ngoài báo cáo tháng mà HPM cần ("các dữ liệu khác").
6. Mẫu tệp thật (đã ẩn dữ liệu nhạy cảm) và bộ dữ liệu thử có đáp án.

**C. Về hành vi.**
7. HPM nhận trùng thì xử lý thế nào (bỏ qua, báo lỗi, ghi đè); có trường khóa hay mã giao dịch để nhận biết trùng.
8. HPM xử lý một kỳ đã nhận được gửi lại với số liệu khác thế nào: thay thế cả kỳ, lưu thêm phiên bản, hay từ chối; có cho thay kỳ đã khóa không.
9. Cách HPM báo kết quả: phản hồi đồng bộ, tệp biên nhận, gọi lại, hay chỉ xem trên giao diện; mã lỗi và cách phân biệt lỗi dữ liệu với lỗi tạm thời.
10. Thời hạn nhập kỳ của HPM và ai quyết định chấp nhận lại sau hạn.
11. Quy tắc điều chỉnh sau khi đẩy mà Ban KHĐT muốn áp dụng (xem mục 6) và ngưỡng trọng yếu (nếu có).

**D. Về an ninh và vận hành.**
12. Đường mạng từ MACHVON tới HPM, quy tắc tường lửa, chứng thư; yêu cầu mã hóa và ký gói.
13. Môi trường thử (UAT) của HPM và thời gian cho phép thử; người liên lạc khi lỗi.
14. Yêu cầu lưu vết và lưu trữ bản đã gửi.

## 6. Quy tắc lỗi, thử lại và điều chỉnh

Đề xuất để đưa vào thiết kế To-Be (cần Ban KHĐT và Ban CĐS&CNTT xác nhận). Các con số là cấu hình, không nằm trong mã, và ghi là chưa kiểm chứng.

### 6.1 Phân loại lỗi và cách xử lý

| Loại | Ví dụ | Xử lý | Cảnh báo |
|---|---|---|---|
| Tạm thời | Hết thời gian chờ, lỗi mạng, HPM bảo trì, mã 5xx | Hiện: người có quyền `hpm.push` đẩy lại thủ công, **cùng khóa**, lần thử n+1, tối đa `max_attempts` (mặc định 5). Đề xuất (chưa có): tự thử lại có lùi dần (ví dụ 1, 5, 15, 60 phút) khi có bộ chuyển tiếp API | `HPM_PUSH_FAILED` ngay khi có lần đẩy lỗi, cho quản trị tích hợp |
| Hết lượt | `HPM_RETRY_EXHAUSTED` | Không đẩy lại được nữa. Quản trị công bố phiên bản mới của quy tắc `HPM_PUSH_POLICY` (ADM-21, người công bố khác người soạn) với `max_attempts` lớn hơn, kèm lý do, rồi người có quyền `hpm.push` đẩy lại | `HPM_PUSH_FAILED` (cùng mức với `HPM_PUSH_STALE`, theo `stale_severity`) |
| Bị từ chối do dữ liệu | HPM trả lỗi hợp lệ (thiếu trường, mã lạ, sai kỳ) | **Không** tự thử lại. Người lập sửa số liệu ở nguồn (ví dụ thiếu ánh xạ mã), phát hành phiên bản mới (rN+1) rồi đẩy | Hiện trên HPM-01 với lý do HPM trả |
| Trùng | HPM báo đã có, hoặc MACHVON thấy cùng byte | Coi là thành công (`ALREADY_DELIVERED`), không gửi lại | Không |
| Quá cũ | Bản cũ hơn bản đã phát hành hoặc bản HPM đã nhận (`REPORT_OUT_OF_DATE`) | Từ chối; trả về phiên bản hiện hành để người dùng đẩy bản đúng | Không |
| Mẫu chưa xác nhận | Bản có nhãn DEMO (`TEMPLATE_UNCONFIRMED`) | Không bao giờ ghi là đã nhận | Dải PENDING-EXTERNAL |
| Lâu không có lần giao nào | Lần giao thành công gần nhất cũ hơn `warn_after_hours` (mặc định 720 giờ) là `AGING`, cũ hơn `max_age_hours` (mặc định 1080 giờ) là `STALE`; các số này là mặc định chưa kiểm chứng, Ban KHĐT chỉnh theo lịch báo cáo thật | `HPM_PUSH_STALE` |

Nguyên tắc chung: một khóa (tổ chức, mẫu, kỳ, phiên bản) tương ứng đúng một nội dung; thử lại không bao giờ đổi nội dung; mọi lần thử, kết quả và biên nhận được ghi chỉ thêm, kèm người thực hiện và thời điểm; người đẩy không ghi biên nhận của chính mình.

### 6.2 Điều chỉnh sau khi đã đẩy: ghi đè kỳ hay điều chỉnh ở kỳ sau

Hai cách cùng tồn tại; mỗi trường hợp dùng cách nào do quy tắc dưới đây quyết định, không do người đẩy tự chọn.

| Tình huống | Cách xử lý | Điều kiện kiểm soát |
|---|---|---|
| Phát hiện sai **trước khi** HPM ghi nhận (mới ghi tệp, chưa có biên nhận) | Phát hành phiên bản mới của kỳ, bản cũ thành "đã bị thay thế" | Quy trình duyệt thường |
| Sai trong **kỳ liền kề đang mở** hoặc kỳ vừa đóng, HPM nhận được bản thay thế, số sai lớn hơn ngưỡng trọng yếu | **Ghi đè kỳ**: mở lại kỳ (DIS) được duyệt, đề nghị đính chính nêu lý do, người thứ hai duyệt, dùng một lần; đẩy phiên bản rN+1; HPM thay cả kỳ | Đã có trong MACHVON (`hpm_correction`); mỗi bước ghi nhật ký kiểm toán |
| Sai nhỏ dưới ngưỡng trọng yếu, hoặc phát hiện sau khi **kỳ kế tiếp đã đóng**, hoặc HPM không cho thay kỳ đã khóa | **Điều chỉnh ở kỳ sau**: kỳ đã đóng giữ nguyên; chênh lệch được ghi thành dòng điều chỉnh có tham chiếu tới kỳ gốc và lý do trong kỳ đang mở, và đi theo báo cáo kỳ đó | Cần lệnh mới và cách trình bày dòng điều chỉnh trong báo cáo (kế hoạch ENT-3c); duyệt theo quy trình thường |
| Sai về chỉ tiêu lũy kế | Lũy kế được tính lại từ các kỳ; ghi đè hoặc điều chỉnh đều phải làm cho lũy kế khớp sổ cái | Kiểm tra tổng ở bước phát hành |

Lý do chọn "điều chỉnh ở kỳ sau" làm mặc định cho sai nhỏ và kỳ đã khóa: lịch sử đã báo cáo cho cấp trên không bị sửa lặng lẽ, dấu vết đầy đủ, HPM không cần tính năng thay kỳ. Ghi đè là ngoại lệ có hai người ký. Cả hai cách đều ghi ADM-11.

Cần xác nhận: ngưỡng trọng yếu (số tiền hoặc tỷ lệ), số ngày còn cho phép ghi đè, và liệu HPM có nhận phiên bản thay thế.

### 6.3 Kiểm chứng chấp nhận

AC-1: đẩy lại sau lỗi cho đúng một dòng sổ và hai lần thử cùng khóa. AC-2: bản cũ hơn bản đã nhận bị từ chối kèm phiên bản hiện hành. AC-3: ghi đè kỳ đã nhận khi chưa có kỳ mở lại và đính chính được duyệt bị từ chối. AC-4: người đẩy không ghi được biên nhận của mình. AC-5: không có kết nối ra ngoài địa chỉ đã khai báo. AC-6 (G1 trở đi): một kỳ thật nhập vào HPM thử, từng chỉ tiêu khớp. AC-7 (sau ENT-3c): sai nhỏ ở kỳ đã đóng sinh dòng điều chỉnh ở kỳ sau và kỳ cũ không đổi.

## 7. An ninh

- MACHVON luôn là bên gọi ra; không mở cổng vào cho HPM. Hiện bộ ghi tệp khai báo không có đường ra (`egressPolicy: NONE`) và bộ kiểm thử theo dõi socket để bảo đảm điều đó. Khi chuyển sang bộ chuyển tiếp API (G2), bản mô tả bộ kết nối đổi thành đường ra khai báo (`DECLARED`: một máy chủ HPM, một lý do) và tường lửa của máy chủ chỉ cho phép đúng địa chỉ đó.
- Thông tin xác thực không nằm trong cơ sở dữ liệu hay mã: chỉ tham chiếu `secret://`, đổi theo `docs/runbooks/infra/secrets-rotation.md`.
- Gói chỉ chứa mã, băm và số liệu báo cáo đã phát hành; sự kiện phát ra chỉ chứa mã, băm, số, không có nội dung báo cáo.
- TLS 1.2 trở lên; băm SHA-256 của gói ghi trong bản kê và trong sổ đẩy.

## 8. Phân công

| Việc | Bên làm |
|---|---|
| Cung cấp thông tin mục 5, môi trường thử HPM, đầu mối kỹ thuật | Ban CĐS&CNTT |
| Xác nhận quy tắc điều chỉnh, ngưỡng trọng yếu, cách tính lũy kế | Ban KHĐT |
| Bộ chuyển tiếp, gói chuẩn, ánh xạ mã, bước PUSH tự động, điều chỉnh kỳ sau, kiểm thử | Nhà cung cấp |
| Vận hành kết nối, xử lý cảnh báo, ghi biên nhận | Quản trị tích hợp của PVFCCo |
| Đối chiếu hai kỳ chạy song song | Ban KHĐT với nhà cung cấp |
