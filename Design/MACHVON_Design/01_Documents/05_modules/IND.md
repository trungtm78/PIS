# IND — Chỉ tiêu và quy tắc nhập liệu (IND-1)

Đặc tả đầy đủ về thiết kế, quyết định và ví dụ nằm ở `docs/ind-indicator-dictionary.md`; tệp này giữ phần theo khung đặc tả phân hệ để các kiểm tra của bộ thiết kế đọc được. Mã định danh viết bằng tiếng Anh. Mọi giá trị chưa có căn cứ từ khách hàng ghi `[GIẢ ĐỊNH]`.

## 1. Mục đích, phạm vi, ranh giới
- Vấn đề: số liệu đầu tư của doanh nghiệp được nhập từ nhiều biểu mẫu Excel với tên chỉ tiêu, đơn vị tính (đồng, triệu đồng, tỷ đồng) và cách hiểu "thực hiện", "giải ngân" không thống nhất; số nhập sai (lũy kế vượt tổng mức đầu tư, vốn chủ sở hữu cộng vốn vay lệch tổng nguồn vốn) chỉ bị phát hiện khi đã vào báo cáo.
- Trong phạm vi: từ điển chỉ tiêu mở rộng sổ KPI (`KPI_DEFINITION`), quy tắc nhập liệu `DATA_ENTRY_RULE` kiểm ngay khi nhập, số liệu nhập theo chỉ tiêu (`ind_figure`, chỉ thêm), bảng ánh xạ nhập Excel `INDICATOR_IMPORT_MAPPING` có phiên bản và người duyệt. Ngoài phạm vi: mô hình vốn tổng quát và bộ số liệu doanh nghiệp (FND-1), mẫu báo cáo (RPT-1, ENT-1).
- Phụ thuộc: ADM (kho quy tắc quản trị, phê duyệt hai người), DIS (kỳ báo cáo, báo cáo tuần), PRJ (dự án, tổng mức đầu tư), khung nhập tệp (`file_import`).
- Căn cứ: hồ sơ khách hàng DL.01, DL.02 (từ điển chỉ tiêu và bộ nguyên tắc nhập liệu) `[GIẢ ĐỊNH]` cho tới khi khách hàng cung cấp bản chính thức.

## 2. Actor, tenant và phạm vi quyền
| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Tổ chuẩn hóa dữ liệu | Toàn tenant | Đọc từ điển, quy tắc, bảng ánh xạ (`ind.read`); soạn định nghĩa và quy tắc qua kho quy tắc quản trị; chạy thử số liệu (`ind.entry`) | Tự duyệt phiên bản mình soạn |
| Cán bộ dự án | Cây đơn vị hoặc dự án được cấp | Nhập số liệu (`ind.entry`), sửa kèm lý do; xem số liệu trong phạm vi | Nhập vào dự án ngoài phạm vi, nhập vào kỳ đã chốt khi chưa có phiên mở lại được duyệt |
| Người nhập tệp | Dự án trong phạm vi quyền | Tải tệp, chạy thử (`ind.import.preview`), áp dụng (`ind.import`) | Áp dụng qua bảng ánh xạ chưa được duyệt, ghi đè số đang có |
| Người duyệt | Toàn tenant | Duyệt định nghĩa, quy tắc, bảng ánh xạ qua kho quy tắc | Duyệt phiên bản do chính mình soạn |

## 3. Luồng nghiệp vụ
- Soạn và duyệt: người soạn tạo bản nháp của một mã (chỉ tiêu, quy tắc hoặc bảng ánh xạ) qua kho quy tắc quản trị, người khác duyệt; phiên bản có hiệu lực từ ngày ghi.
- Nhập số liệu: `enterIndicatorFigures` kiểm dự án trong phạm vi, kỳ nhận nhập, chỉ tiêu là loại nhập được và số hợp đơn vị, rồi các quy tắc đã duyệt của nơi nhập; ghi bản 1, số khác số đang có là bản kế tiếp kèm lý do, cùng số thì không đổi.
- Nhập tệp: `uploadIndicatorFile` (cửa tệp, quét, cho biết bảng ánh xạ đọc được tệp) → `previewIndicatorImport` (chạy thử, không ghi) → `importIndicatorFile` (áp dụng một lần theo băm tệp); số mới được ghi, số khác số đang có thành chênh lệch có người xử lý, dòng sai vào báo cáo lỗi với dòng, trường, mã.
- Quy tắc áp vào các nơi nhập số có sẵn: báo cáo tuần/tháng của DIS (`post_reports`, `post_reports_id_revisions`) và tạo dự án (`createProject`) gọi cùng bộ kiểm; tenant chưa duyệt quy tắc nào thì hành vi không đổi.

## 4. State machine
Chỉ tiêu, quy tắc và bảng ánh xạ dùng vòng đời của kho quy tắc quản trị: `DRAFT → SUBMITTED → APPROVED → RETIRED`, người duyệt khác người soạn và người trình (`SELF_APPROVAL_DENIED`). Số liệu không có vòng đời: mỗi bản chỉ thêm (`revision`), bản có hiệu lực là bản lớn nhất. Lần nhập tệp theo khung nhập tệp: `IMPORTING → APPLIED | FAILED`.

## 5. Quy tắc nghiệp vụ và công thức
- BR-IND-01: một chỉ tiêu là một định nghĩa KPI có mã, tên, đơn vị, công thức, người phụ trách, phiên bản; không có bản sao thứ hai. Chỉ tiêu `DERIVED` do hệ thống tính, không được nhập.
- BR-IND-02: chỉ quy tắc đã được duyệt mới giữ lần nhập; quy tắc khởi điểm của nền tảng là khuôn. Kiểm tra: `CUMULATIVE_NOT_ABOVE_TOTAL` (lũy kế không lớn hơn tổng, cộng sai số), `PARTS_EQUAL_TOTAL` (tổng các phần bằng tổng, trong sai số), `PERIOD_LOCKED_AFTER_CLOSE` (kỳ ở trạng thái đóng), `FIELD_REQUIRED`, `VALUE_IN_RANGE`. Mức `BLOCK` chặn (422 `IND_ENTRY_RULE_VIOLATED`), `WARN` cho qua và ghi vết.
- BR-IND-03: tiền và số đếm là số nguyên đồng; tỷ lệ tối đa 6 chữ số thập phân; so sánh bằng số thập phân chính xác, không dùng số thực.
- BR-IND-04: bảng ánh xạ chỉ đọc tệp khi có phiên bản được duyệt và còn hiệu lực (409 `IND_MAPPING_NOT_APPROVED`); đơn vị của tờ (đồng, nghìn, triệu, tỷ) và cách viết số (`PLAIN`, `VN`) là thuộc tính của dòng ánh xạ và của bảng.
- BR-IND-05: tệp không bao giờ ghi đè một số đang có: số khác thành chênh lệch (`IND_FIGURE_DIFFERS`), sửa bằng lệnh nhập kèm lý do.

## 6. Dữ liệu
`ind_figure` (mới): `tenant_id`, `id`, `project_id`, `period_id`, `indicator_code`, `revision`, `value numeric(30,6)`, `unit`, `definition_version`, `source` (`ENTRY`/`IMPORT`), `import_id`, `import_line`, `mapping_code`, `mapping_version`, `mapping_rule_id`, `reason`, `entered_by`, `entered_at`. Bất biến: chỉ thêm (trigger và thu quyền UPDATE, DELETE), `unique (tenant, project, period, indicator, revision)`, bản sửa phải có lý do, tiền và số đếm nguyên, nguồn tệp phải nêu tệp, dòng và phiên bản bảng ánh xạ. RLS bắt buộc và ép buộc. Định nghĩa, quy tắc và bảng ánh xạ nằm ở `governance_rule`, không có bảng riêng.

## 7. API / command
| operationId | Method path | Quyền | Ghi chú |
|---|---|---|---|
| listIndicators | GET /indicators | ind.read | Từ điển, lọc theo nhóm, cách có số, từ khóa |
| getIndicator | GET /indicators/detail | ind.read | Chi tiết, lịch sử phiên bản, nơi dùng |
| listIndicatorEntryRules | GET /indicator-entry-rules | ind.read | Quy tắc đang hiệu lực và khuôn |
| evaluateIndicatorEntry | POST /indicator-entry-rules/evaluate | ind.entry | Chạy thử, không ghi |
| listIndicatorImportMappings | GET /indicator-import-mappings | ind.read | Bảng ánh xạ và vấn đề |
| getIndicatorImportMapping | GET /indicator-import-mappings/detail | ind.read | Lịch sử phiên bản, người lập, người duyệt |
| enterIndicatorFigures | POST /indicator-figures | ind.entry | 422 `IND_ENTRY_RULE_VIOLATED`, 409 `PERIOD_LOCKED` |
| listIndicatorFigures | GET /indicator-figures | ind.read | Bản có hiệu lực trong phạm vi |
| listIndicatorFigureHistory | GET /indicator-figures/history | ind.read | Mọi bản của một số |
| uploadIndicatorFile | POST /indicator-imports/files | ind.import.preview | Multipart, quét mã độc |
| previewIndicatorImport | POST /indicator-imports/preview | ind.import.preview | Chạy thử |
| importIndicatorFile | POST /indicator-imports | ind.import | Một lần theo băm tệp |
| listIndicatorImports | GET /indicator-imports | ind.read | Lịch sử |
| listIndicatorImportRows | GET /indicator-imports/rows | ind.read | Dòng bị từ chối và chênh lệch |
Không có thao tác nào gọi bằng id trong đường dẫn; định nghĩa, quy tắc, bảng ánh xạ soạn và duyệt qua `createGovernanceRuleDraft` và các lệnh của kho quy tắc.

## 8. UI/UX
IND-01 Từ điển chỉ tiêu (kèm nhập và lịch sử số liệu), IND-02 Quy tắc nhập liệu (kèm chạy thử), IND-03 Bảng ánh xạ nhập Excel (kèm luồng tải, chạy thử, áp dụng và lịch sử). Bảy trạng thái chuẩn; giá trị khởi điểm hiện nhãn "chưa được khách hàng xác nhận"; không có ô nhập cho chỉ tiêu do hệ thống tính. Dùng đúng component families và tokens của mockup (D-B11).

## 9. Sự kiện, job, tích hợp, quan sát
Sự kiện `ind.figure.entered.v1` (id, dự án, kỳ, mã chỉ tiêu, bản, giá trị, đơn vị) và `ind.import.applied.v1` (id lần nhập, bảng ánh xạ và phiên bản, số dòng, số số liệu ghi, số chênh lệch). Dấu vết kiểm toán ghi mã, phiên bản, số và tên trường, không ghi lời lý do. Không có job nền. Chênh lệch của tệp dùng hàng đợi đối soát của khung nhập tệp.

## 10. Kiểm thử
| ID | Loại | Ưu tiên | Nội dung |
|---|---|---|---|
| UAT-PLAN-IND-1 | business | P1 | Từ điển, khuôn quy tắc, chạy thử trước và sau khi duyệt |
| UAT-PLAN-IND-2 | integration | P0 | Nhập số liệu qua quy tắc chặn và cảnh báo, sửa có lý do, kỳ đã chốt |
| UAT-PLAN-IND-3 | integration | P0 | Tệp qua bảng ánh xạ chưa duyệt và đã duyệt, dòng bị từ chối, chênh lệch, nạp lại |
| UI-IND-01..03 | screen-contract | P0 | Bảy trạng thái và nhãn trường |
Tự động: kernel (bộ kiểm, đọc số, bố cục tệp), db (bản chỉ thêm, RLS, bộ nhập), API qua HTTP (quyền, phạm vi, cách ly tenant, idempotency).

## 11. Tiêu chí nghiệm thu
AC-ST-IND-001-1, AC-ST-IND-001-2, AC-ST-IND-002-1, AC-ST-IND-002-2, AC-ST-IND-003-1, AC-ST-IND-003-2, AC-ST-IND-003-3 trong `implementation_plan.json`, mỗi tiêu chí gắn test ID ở mục 10.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+
R2: toàn bộ phạm vi trên với bộ chỉ tiêu và bảng ánh xạ mẫu. Hạng mục bắt buộc người duyệt: quyền và phân quyền, bảng ánh xạ thay đổi cách hiểu số liệu. Sâu hóa sau: nối chỉ tiêu vào báo cáo doanh nghiệp (RPT-1, ENT-1) và mô hình vốn (FND-1), kiểm tra giữa kỳ với số kế toán (ENT-2).

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba
- Từ điển chỉ tiêu và bộ nguyên tắc nhập liệu chính thức của khách hàng (DL.01, DL.02): owner Tổ chuẩn hóa dữ liệu; khi có thì thay giá trị khởi điểm bằng phiên bản được duyệt.
- Tệp biểu mẫu thật của khách hàng: owner Ban KHĐT; hai bố cục mẫu là giả định `PENDING-EXTERNAL` cho tới khi có tệp chuẩn và bên nhận xác nhận.
- Đơn vị tính (triệu hay tỷ đồng, có hay không VAT) và định nghĩa "thực hiện", "giải ngân": owner Ban TCKT; ghi ở thuộc tính chỉ tiêu và dòng ánh xạ.
