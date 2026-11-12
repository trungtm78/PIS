# 06. Kế hoạch chuyển đổi dữ liệu, ánh xạ biểu mẫu Excel và mẫu biên bản xác nhận

Giai đoạn 5, sản phẩm 6 của mục II.5 (biên bản xác nhận chuyển đổi dữ liệu) và sản phẩm 4 (bộ master data và từ điển chỉ tiêu). Dòng ma trận: TK.03, GD.5, SP.04, SP.06. PVFCCo phê duyệt: có.

Hồ sơ kỹ thuật (TK.03): chuyển đổi danh mục dự án, kế hoạch năm, số liệu lũy kế đến đầu kỳ vận hành và dữ liệu lịch sử từ các biểu mẫu Excel hiện hành theo phạm vi thống nhất; lập biên bản xác nhận với Ban KHĐT.

Nguồn: `docs/ind-indicator-dictionary.md`; `docs/adm-migration.md`; `docs/file-import.md`; `docs/fnd-funding-model.md`; `docs/report-engine.md`; `packages/edition-enterprise/src/report-forms/messages/forms.vi.json` và `packages/edition-enterprise/src/report-forms/messages/kpi-pack.vi.json` (cột và chỉ tiêu của sáu biểu mẫu DEMO); `packages/edition-enterprise/templates/org-pack/pvfcco-template.csv` (gói tổ chức mẫu); `docs/hpm-ebs-connectors.md` (mã dự án qua `master_crosswalk`); `Design/MACHVON_Design/01_Documents/10_Ke_hoach_kiem_thu_va_chuyen_doi.md` (mục migration rehearsal, cutover); `Design/MACHVON_Design/03_Engineering/mapping_source_template.json`.

Trạng thái tệp: v0.2, rà soát ngày 2026-11-12 sau khi các làn ENT-3a đến ENT-3e và ENT-4 đã gộp. Phía hệ thống đã sẵn các đích nạp của bản enterprise (bảng ở mục 1). Chưa nhận tệp Excel hiện hành của khách nên ánh xạ dưới đây là ánh xạ theo sáu biểu mẫu DEMO do hệ thống thiết kế, đánh dấu cần đối chiếu từng cột với tệp thật. Theo quy tắc của kế hoạch chuyển đổi, chưa có tệp thật thì không ghi ánh xạ là đã hoàn tất, không chạy thử chuyển đổi và không ký biên bản. Mọi nhãn UNVERIFIED trong chỉ tiêu khởi điểm giữ nguyên tới khi Tổ chuẩn hóa dữ liệu xác nhận (PX-02). Điều chỉ khách làm được: gửi tệp Excel hiện hành (PX-02, PX-08), danh mục dự án và mã HPM, EBS (PX-14), danh sách 09 đầu mối (PX-05).

---

## 1. Phạm vi

| Nhóm dữ liệu | Nguồn Excel | Đích trong hệ thống | Phạm vi dữ liệu |
|---|---|---|---|
| Danh mục dự án và hạng mục | Cột mã, tên, nhóm, loại hình, đơn vị chủ trì của các biểu mẫu | Danh mục dự án (PRJ), bản ghi chủ (MDM) | 22 dự án đầu tư xây dựng, 01 hạng mục mua sắm tài sản dự án, 09 hạng mục mua sắm tài sản cố định theo kế hoạch năm 2026 (hồ sơ kỹ thuật, mục II.2.1) |
| Tổ chức, vai trò, 09 đầu mối, người nhập và người duyệt | Danh sách do Tổ chuẩn hóa dữ liệu cung cấp | Gói cấu hình `PVFCCO-TEMPLATE` (ORG-01), nạp bằng lô chuyển đổi `ORG-PACK-1`, rồi `materialiseEnterpriseOrgPack` (ENT-3d) | 09 đầu mối: 07 Ban và đơn vị, 02 Tổ dự án; [khách điền: danh sách thật, PX-05] |
| Ánh xạ mã HPM, EBS | Bảng mã Ban KHĐT và Ban TCKT giữ | `master_crosswalk`: loại `PROJECT_CODE`, hệ nguồn `EBS` hoặc `HPM`, người duyệt khác người đề xuất, có thời hạn hiệu lực (INT-03: `proposeProjectCode`, `decideProjectCode`; ENT-3e) | Như trên; [khách điền: danh sách mã, PX-14] |
| Loại dự án, cờ khởi công, mốc vòng đời, loại hồ sơ pháp lý | Cột loại hình của biểu mẫu; danh sách Ban KHĐT | Danh mục quy tắc quản trị `ENT_PROJECT_TYPE`, `ENT_START_FLAG`, `ENT_LIFECYCLE_MILESTONE`, `ENT_LEGAL_DOC_TYPE`, cùng bản ghi chủ `PROJECT_TYPE` (ENT-3e); cờ UNVERIFIED tới khi khách xác nhận | Như trên; loại "sửa chữa lớn" có chính thức không: quyết định của Tổ chuẩn hóa dữ liệu |
| Kế hoạch năm | Cột "Kế hoạch vốn năm giao đầu năm" và "hiện hành" | Kế hoạch vốn (CAP) và `plan_figure_revision` (FND-1); nguồn kế hoạch của bản enterprise `GROUP_ASSIGNED`, `BOARD_APPROVED`, `CARRYOVER`, mỗi nguồn cần văn bản căn cứ đúng loại (nghị quyết, quyết định của Tập đoàn hoặc của công ty) | Năm 2026 |
| Số liệu lũy kế đến đầu kỳ vận hành | Cột "Lũy kế từ đầu năm", "Lũy kế từ khởi công" | Số dư đầu kỳ của số liệu vốn (FND-1) | Đến hết kỳ trước kỳ vận hành đầu tiên |
| Cơ cấu vốn | Cột vốn chủ sở hữu, vốn vay, khác | Số liệu vốn theo nhóm (FND-1, `FUNDING_TAXONOMY`) | Như trên |
| Nội dung thuyết minh | Tình hình, tiến độ, nguyên nhân, khó khăn, kế hoạch tới, kiến nghị | Thuyết minh có cấu trúc 8 trường (DIS-35, ENT-3b), nhập bằng bảng ánh xạ `ENT-NARRATIVE-1` của thao tác nhập báo cáo (`createReportImport`) hoặc gõ trực tiếp | Kỳ gần nhất; [khách điền] |
| Dữ liệu lịch sử | Các kỳ trước | Số liệu theo kỳ | [khách điền: Ban KHĐT chốt phạm vi, PX-08] |

Chuyển đổi chỉ nạp, không thay quy trình: mọi con số nạp vào có nguồn là tệp, mã tệp và dòng.

## 2. Sáu biểu mẫu Excel và ánh xạ vào từ điển chỉ tiêu

Sáu biểu mẫu (mã `PVN-MONTHLY`, `PVN-QUARTERLY-F2`, `HPM-MONTHLY`, `COMMITTEE-PERIODIC`, `INVEST-STEERING`, `PLANT-PHU-MY`) có chung một bộ cột. Bảng dưới ánh xạ từng cột tới chỉ tiêu. "Khởi điểm IND-1" là chỉ tiêu nhập được (`valueKind: ENTERED`) trong `packages/kernel/src/ind-definitions.ts`; "Mã ENT" là chỉ tiêu của bộ chỉ tiêu enterprise (`packages/edition-enterprise/src/report-forms/rules.ts`) đọc từ số liệu vốn FND-1; chỉ tiêu dẫn xuất (`DERIVED`) do hệ thống tính, không nạp.

| Cột trên biểu mẫu (mã cột) | Là | Khởi điểm IND-1 hoặc đích khác | Mã ENT | Đơn vị và tỷ lệ | Cách nạp |
|---|---|---|---|---|---|
| STT (`stt`) | Số thứ tự | không | không | | Không nạp, hệ thống đánh |
| Mã dự án (`code`) | Khóa | Mã dự án trong PRJ; mã HPM và EBS vào crosswalk | không | | Nạp danh mục dự án trước |
| Tên dự án, hạng mục (`name`) | Danh mục | PRJ | không | | Nạp danh mục |
| Nhóm (`grp`) | Phân loại A/B/C | MDM nhóm và loại dự án | không | | Nạp danh mục |
| Loại hình, Đơn vị chủ trì (`kind`, `owner_unit`) | Phân loại | MDM loại dự án (`ENT_PROJECT_TYPE`, ENT-3e); đơn vị trong cây tổ chức của gói `PVFCCO-TEMPLATE` (ENT-3d) | không | | Nạp cây tổ chức trước, rồi danh mục; loại hình theo danh mục enterprise |
| Tổng mức đầu tư (`tmdt`) | Số liệu | `TOTAL_INVESTMENT` (VND) | `ENT_TOTAL_INVESTMENT` | Triệu đồng trên biểu, đồng trong hệ thống: `scale` MILLION | Nhập từ tệp qua ánh xạ |
| Kế hoạch vốn năm giao đầu năm (`plan_year`) | Số liệu | `PLAN_YEAR` (VND) | `ENT_PLAN_YEAR` | như trên | Nhập từ tệp; hoặc từ CAP |
| Kế hoạch vốn năm hiện hành (`plan_force`) | Số liệu | Kế hoạch đang hiệu lực sau điều chỉnh, từ CAP và FND-1 | `ENT_PLAN_IN_FORCE` | như trên | Nạp kế hoạch gốc và các lần điều chỉnh có văn bản |
| Ước thực hiện kỳ (`est_p`) | Số ước | FND-1, đại lượng ước | `ENT_ESTIMATE_PERIOD` | như trên | Nạp là số ước, không là số thực |
| Thực hiện trong kỳ, giá trị thực hiện (`exec_p`) | Số liệu | `EXECUTED_PERIOD` (VND) | `ENT_EXECUTED_PERIOD` | như trên | Nhập từ tệp |
| Thực hiện trong kỳ, giải ngân (`disb_p`) | Số liệu | `DISBURSED_PERIOD` (VND) | `ENT_DISBURSED_PERIOD` | như trên | Nhập từ tệp |
| Lũy kế từ đầu năm, thực hiện và giải ngân (`exec_ytd`, `disb_ytd`) | Dẫn xuất từ các tháng; có chỉ tiêu nhập `CUMULATIVE_YTD` | `CUMULATIVE_YTD` | `ENT_EXECUTED_YTD`, `ENT_DISBURSED_YTD` | như trên | Nạp từng tháng đã qua để hệ thống cộng; số lũy kế trong tệp dùng để đối soát |
| Lũy kế từ khởi công (`exec_start`, `disb_start`) | Số dư đầu kỳ đưa vào cộng các tháng | Số dư đầu kỳ của FND-1 | `ENT_EXECUTED_SINCE_START`, `ENT_DISBURSED_SINCE_START` | như trên | Nạp số dư đầu kỳ một lần ở thời điểm bắt đầu vận hành |
| Ước thực hiện cả năm (`outlook`) | Dẫn xuất | không nhập | `ENT_OUTLOOK_YEAR` | | Không nạp |
| Tỷ lệ % so kế hoạch năm, thực hiện, giải ngân, ước cả năm (`rate_exec`, `rate_disb`, `rate_outlook`) | Dẫn xuất | `RATE_YEAR_IN_FORCE`, `RATE_SINCE_START` (DERIVED) | `ENT_RATE_EXECUTED_YTD`, `ENT_RATE_DISBURSED_YTD`, `ENT_RATE_OUTLOOK_YEAR`, `ENT_RATE_SINCE_START` | Phần trăm, hai chữ số | Không nạp; dùng để đối soát tỷ lệ trong tệp với tỷ lệ hệ thống tính |
| Cơ cấu vốn kế hoạch năm, vốn chủ sở hữu, vốn vay, khác (`cap_equity`, `cap_debt`, `cap_other`) | Số liệu | `EQUITY_CAPITAL`, `LOAN_CAPITAL`, `TOTAL_FUNDING`; nhóm vốn của `FUNDING_TAXONOMY` | `ENT_CAPITAL_EQUITY`, `ENT_CAPITAL_DEBT`, `ENT_CAPITAL_OTHER`; tỷ trọng `ENT_SHARE_*` | như trên | Nhập từ tệp; quy tắc vốn chủ sở hữu cộng vốn vay bằng tổng áp dụng |
| Tình hình thực hiện, đánh giá tiến độ (`status`, `schedule`) | Văn bản | Thuyết minh; tiến độ vật lý `PHYSICAL_PROGRESS_REPORTED` (PERCENT) nếu có số | không | | Nạp vào thuyết minh 8 trường (DIS-35, ENT-3b đã gộp, bảng ánh xạ `ENT-NARRATIVE-1`); tiến độ vật lý nạp bằng chỉ tiêu nếu tệp có số |
| Nguyên nhân (`cause`) | Văn bản | Danh mục nguyên nhân MDM-17 | không | | Đối chiếu từng câu với danh mục chuẩn (chọn mã trong danh sách MDM-17, kèm văn bản tự do ở trường nguyên nhân); câu không khớp đưa vào ghi chú |
| Khó khăn vướng mắc và giải pháp, kế hoạch kỳ tới, kiến nghị (`issues`, `next`, `proposal`) | Văn bản | Thuyết minh | không | | Nạp vào thuyết minh (`ENT-NARRATIVE-1`); mỗi trường tối đa 4000 ký tự |

Quy ước: tiền lưu bằng đồng nguyên; biểu mẫu tính bằng triệu đồng nên bảng ánh xạ dùng `scale: MILLION`; số thập phân Việt Nam dùng `number_format: VN` khi tệp viết `1.234,56` (`docs/ind-indicator-dictionary.md`, mục 4). Số không nguyên đồng hoặc quá chính xác bị từ chối kèm dòng và mã (`NUMBER_NOT_WHOLE`, `NUMBER_TOO_PRECISE`).

Chỉ tiêu có đặc điểm kê khai trong từ điển chỉ tiêu (tên, định nghĩa, công thức, đơn vị, nguồn nhập, kỳ áp dụng) là giá trị khởi điểm UNVERIFIED. Khi nhận từ điển chính thức, cập nhật qua màn ADM-19 (soạn, trình, duyệt khác người, có hiệu lực), không sửa mã.

## 3. Khai báo bảng ánh xạ nhập Excel

Bảng ánh xạ là quy tắc quản trị `INDICATOR_IMPORT_MAPPING` (IND-03): có phiên bản, người duyệt khác người soạn, ngày hiệu lực; tệp chỉ đọc được qua một phiên bản đã duyệt (409 `IND_MAPPING_NOT_APPROVED`).

| Tham số | Giá trị đề xuất cho biểu mẫu PVFCCo | Ghi chú |
|---|---|---|
| `layout` | `COLUMNS` (một dòng một dự án) cho các biểu mẫu dạng bảng; `ROWS` (một dòng một chỉ tiêu của một dự án) nếu đơn vị lập dạng phiếu | Chọn theo tệp thật của từng đầu mối |
| `project_column` | Cột "Mã dự án" | Nhãn khớp không phân biệt hoa thường và khoảng trắng |
| `period_column` hoặc kỳ đặt trong yêu cầu | Kỳ ghi trong tên tệp hay ô tiêu đề | [khách điền: quy ước từng biểu] |
| `number_format` | `PLAIN` hoặc `VN` | Theo tệp thật |
| `lines` | Một dòng cho mỗi cột số liệu ở bảng mục 2: `{ indicator, source, scale, required }` | `required` đặt cho tổng mức đầu tư, kế hoạch năm |

Mỗi tệp nạp qua trình tự: tải lên (`uploadIndicatorFile`, quét tệp), chạy thử (`previewIndicatorImport`, không ghi gì, báo từng dòng lỗi), áp dụng (`importIndicatorFile`, một lần cho mỗi băm tệp). Nạp lại cùng tệp không tạo bản ghi mới; khác số với số đã có không ghi đè mà thành mục chênh lệch cần giải quyết (`IND_FIGURE_DIFFERS`). Số liệu lưu theo kiểu chỉ thêm: số đầu là bản 1, số khác là bản kế tiếp có lý do.

Mã dòng bị từ chối: `PROJECT_UNKNOWN`, `PERIOD_UNKNOWN`, `PERIOD_AMBIGUOUS`, `PERIOD_LOCKED`, `INDICATOR_UNKNOWN`, `INDICATOR_NOT_ENTERABLE`, `NUMBER_INVALID`, `NUMBER_NOT_WHOLE`, `NUMBER_TOO_PRECISE`, `VALUE_REQUIRED`, `ROW_EMPTY`, `ENTRY_RULE_BLOCKED`.

## 4. Trình tự chuyển đổi

Theo kế hoạch kiểm thử và chuyển đổi (inventory, profile, mapping có version, extract manifest và checksum, staging, validate và quarantine, master match, load idempotent, reconcile, owner sign-off) và công cụ đã xây:

| Bước | Việc | Công cụ trong hệ thống | Người làm | Người ký |
|---|---|---|---|---|
| 1 | Kiểm kê tệp Excel của 09 đầu mối: tên, người giữ, kỳ, băm SHA-256 | Danh sách ở mục 7 | Nhà cung cấp, đầu mối | Ban KHĐT |
| 2 | Phân tích dữ liệu (profile): trùng mã, thiếu mã, đơn vị tính, định dạng số | Bản xem trước (preview) | Nhà cung cấp | |
| 3 | Chốt danh mục dự án chính thức và mã HPM, EBS | MDM nhập hàng loạt (MDM-29, `stageMasterImport`), crosswalk (INT-03) | Ban KHĐT duyệt | Ban KHĐT |
| 4 | Khai báo và duyệt bảng ánh xạ nhập Excel | IND-03, ADM-19 | Nhà cung cấp soạn, Ban KHĐT duyệt | Ban KHĐT |
| 5 | Nạp thử trên bản sao (rehearsal) | `registerMigrationBatch`, `dryRunMigrationBatch` (ADM-13), `previewIndicatorImport` | Nhà cung cấp | |
| 6 | Đối soát bản nạp thử: số dòng, tổng tiền, tổng theo đơn vị, tỷ lệ so với tệp | Mục 5 | Nhà cung cấp, đầu mối | |
| 7 | Nạp thật | `applyMigrationBatch` (người duyệt khác người đăng ký), `importIndicatorFile` | Ban KHĐT duyệt | Ban KHĐT |
| 8 | Đối soát lần cuối và lập biên bản | Mục 6 | Nhà cung cấp, Ban KHĐT | Ban KHĐT |
| 9 | Hoàn tác nếu sai | `rollbackMigrationBatch` đánh dấu bản ghi INVALID, không xóa | Ban KHĐT duyệt | |

Một lô chuyển đổi đi theo trạng thái `Uploaded`, `Validating`, `DryRunPassed`, `Applying`, `Applied`; lô đã áp dụng giữ người duyệt, số dòng và tổng kiểm (`docs/adm-migration.md`). Bảng ánh xạ chung của nền tảng là `GENERIC-1` và `GENERIC-CHILD-1`; bản enterprise đăng ký thêm `ORG-PACK-1` (gói tổ chức, nguồn `PVFCCO-TEMPLATE`) và `ENT-NARRATIVE-1` (thuyết minh); bảng nhập chỉ tiêu là quy tắc `INDICATOR_IMPORT_MAPPING` (mục 3). Ánh xạ từ tệp thật của khách vẫn chờ khách (PX-02): chưa có tệp thật thì chưa khai báo và chưa duyệt bảng ánh xạ nguồn.

Thứ tự phụ thuộc khi nạp bản enterprise (mỗi bước chỉ chạy sau bước trước đã được người duyệt khác người đăng ký chấp nhận): (a) gói tổ chức và vai trò `PVFCCO-TEMPLATE` (đơn vị chủ trì phải có trước dự án); (b) danh mục loại dự án, nguồn vốn, đơn vị tính, tỷ giá, nguyên nhân chậm tiến độ (bản ghi chủ và danh mục `ENT_*`); (c) danh mục dự án và ánh xạ mã HPM, EBS (`master_crosswalk`); (d) kế hoạch năm và nguồn kế hoạch; (e) số dư đầu kỳ và các tháng đã qua; (f) thuyết minh kỳ gần nhất. Gói `PVFCCO-TEMPLATE` chỉ chứa tên đơn vị mẫu và hai Tổ dự án mang tên giữ chỗ (`[tên Tổ dự án 1]`, `[tên Tổ dự án 2]`); tên và tài khoản thật do PVFCCo cung cấp, không nằm trong kho mã (PX-05).

Điểm cần lưu ý khi cutover: kỳ vận hành đầu tiên chỉ bắt đầu sau khi biên bản xác nhận chuyển đổi được ký; trước cutover có sao lưu đã thử khôi phục và cửa sổ đóng băng được duyệt (`Design/MACHVON_Design/01_Documents/10_Ke_hoach_kiem_thu_va_chuyen_doi.md`).

## 5. Quy tắc đối soát

| Kiểm tra | Cách làm | Dung sai |
|---|---|---|
| Số dự án | Số dòng đã nạp bằng số dự án trong tệp (22 + 01 + 09 hoặc số Ban KHĐT xác nhận) | 0 |
| Tổng tiền theo từng cột | Tổng hệ thống bằng tổng ô tổng cộng của tệp, theo đơn vị chủ trì và theo kỳ | 0 cùng cơ sở tính; ngoại lệ thời điểm hoặc làm tròn cần quy tắc được ký |
| Lũy kế | Lũy kế hệ thống tính từ số dư đầu kỳ và các tháng bằng lũy kế trong tệp | 0 |
| Tỷ lệ | Tỷ lệ hệ thống tính bằng tỷ lệ trong tệp, làm tròn hai chữ số | Một đơn vị làm tròn |
| Cơ cấu vốn | Vốn chủ sở hữu cộng vốn vay cộng khác bằng tổng | 0 |
| Ánh xạ mã dự án | Mỗi dự án có một mã EBS và một mã HPM đang hiệu lực trong `master_crosswalk`, đều đã duyệt; không mã ngoài nào trùng mã của dự án khác (phần `coverage` của `listProjectCodes`, hiển thị ở INT-03: số dự án, đã ánh xạ, chờ duyệt, xung đột) | 0 dự án thiếu mã |
| Cây tổ chức và vai trò | Báo cáo kiểm của gói `PVFCCO-TEMPLATE` (ORG-01): không đơn vị mồ côi, mỗi đầu mối đủ ghế nhập và ghế duyệt, không vi phạm tách bạch nhiệm vụ | 0 vi phạm |
| Đối chiếu EBS | Giải ngân so với bản kê EBS theo mã dự án (EBS-02) | Theo quy tắc `EBS_RECONCILE_POLICY`; chạy trên giả định cho tới khi có PX-04 |
| Thuyết minh | Mỗi dự án có đủ văn bản từng trường | Kiểm tay |

Mỗi chênh lệch được phân loại (định nghĩa, thời điểm, lỗi dữ liệu) và có chủ. Giữ mã nguồn và mã lần chạy để truy ngược (kế hoạch kiểm thử và chuyển đổi, CR-TEST-05).

## 6. Mẫu biên bản xác nhận chuyển đổi dữ liệu (sản phẩm 6)

```
BIÊN BẢN XÁC NHẬN CHUYỂN ĐỔI DỮ LIỆU
Số: [khách điền]            Ngày: [khách điền]
Dự án: Phần mềm quản lý đầu tư xây dựng của PVFCCo

1. Thành phần tham dự
   Ban KHĐT: [khách điền]   Tổ chuẩn hóa dữ liệu: [khách điền]
   Ban CĐS&CNTT: [khách điền]   Nhà cung cấp: [khách điền]
2. Phạm vi đã thống nhất: [khách điền: danh mục, kế hoạch năm, lũy kế đến hết kỳ ..., lịch sử từ ...]
3. Tệp nguồn (bảng ở mục 7): số tệp [..], băm SHA-256 đã ghi
4. Kết quả đối soát (bảng mục 5)
   | Kiểm tra | Tệp | Hệ thống | Chênh | Phân loại | Kết luận |
   | [điền khi có]
5. Mục chưa nạp hoặc nạp có điều kiện, lý do, hạn: [khách điền]
6. Lô chuyển đổi: mã lô [..], người đăng ký [..], người duyệt [..], số dòng [..], tổng kiểm [..]
7. Kết luận: [ ] Xác nhận  [ ] Xác nhận có điều kiện  [ ] Chưa xác nhận
Chữ ký: Trưởng Ban KHĐT [khách điền]   Nhà cung cấp [khách điền]   Giám sát kỹ thuật Ban CĐS&CNTT [khách điền]
```

## 7. Kiểm kê tệp nguồn (điền khi nhận)

| STT | Đầu mối | Tên tệp, tên biểu | Kỳ | Người giữ | Băm SHA-256 | Biểu mẫu tương ứng | Ghi chú |
|---|---|---|---|---|---|---|---|
| 1 | [khách điền] | [khách điền] | [khách điền] | [khách điền] | [điền khi nhận] | [một trong sáu mã] | |

## 8. Rủi ro và quyết định chờ

1. Chưa có tệp thật: ánh xạ ở mục 2 phải đối chiếu từng cột; có thể thêm cột ngoài sáu biểu mẫu DEMO. Cột lạ không bị bỏ: ghi vào danh sách cột chưa ánh xạ và hỏi Tổ chuẩn hóa dữ liệu.
2. Phạm vi lịch sử chưa chốt (PX-08): chuyển đổi bắt đầu từ danh mục, kế hoạch năm và số dư đầu kỳ; lịch sử chỉ nạp thêm theo phạm vi Ban KHĐT chốt.
3. Số ước và số thực của cùng kỳ: nạp số ước vào đại lượng ước, không nạp vào số thực; phạm vi quản lý số ước chờ Ban KHĐT xác nhận.
4. Mã HPM và mã EBS từng dự án (PX-14) là điều kiện để đối soát EBS và đẩy HPM chạy đúng.

Lịch sử sửa: v0.1 khung ngày 2026-11-09. v0.2 ngày 2026-11-12 (rà soát bởi làn aud4): thêm các đích nạp đã có của bản enterprise (gói `PVFCCO-TEMPLATE`, `master_crosswalk` cho mã HPM và EBS, danh mục `ENT_*`, nguồn kế hoạch CAP, thuyết minh `ENT-NARRATIVE-1`), thứ tự phụ thuộc khi nạp, hai dòng đối soát mới; giữ nguyên phần chờ khách (PX-02, PX-05, PX-08, PX-14).
