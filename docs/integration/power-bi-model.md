# Mô hình ngữ nghĩa mẫu cho Power BI và Data Lakehouse (yêu cầu TH.02)

Tài liệu cho Chi nhánh QLPTDA, Ban CĐS&CNTT và cán bộ làm báo cáo. Mục tiêu: nối Power BI (và các công cụ BI khác, và Data Lakehouse của Tổng công ty) vào dữ liệu đã chứng nhận của MACHVON mà không đụng tới bảng nghiệp vụ, không có chi phí bản quyền thêm. Căn cứ: `docs/open-api.md` (lane INT-1), migration `V2200` và `V2202`, `packages/kernel/src/open-api.ts`, `packages/db/src/int-bi-reader-store.ts`.

Hướng dẫn từng bước cho Chi nhánh QLPTDA: `power-bi-connection-guide.md`. Đề xuất cấp dữ liệu cho Data Lakehouse (tài khoản theo ứng dụng, RLS, nhịp làm mới, đường mạng): `lakehouse-proposal.md`.

Tệp kèm theo (không chứa bí mật):

| Tệp | Dùng để |
|---|---|
| `docs/integration/machvon-bi.pbids` | Mở nhanh kết nối PostgreSQL trong Power BI Desktop; điền máy chủ và cơ sở dữ liệu |
| `docs/integration/power-bi-sample-queries.sql` | Truy vấn mẫu trên các view; dùng làm nguồn bảng của mô hình hoặc kiểm tra số liệu |
| `docs/integration/power-bi/machvon-sample-model.tmdl` | Mô hình ngữ nghĩa mẫu dạng văn bản TMDL (bảng, quan hệ, phép đo, tham số); dán vào khung nhìn TMDL của Power BI Desktop hoặc nạp bằng Tabular Editor; chưa mở thử trong Power BI Desktop (xem mục 9) |
| `docs/integration/power-bi/machvon-enterprise-model.tmdl` | Như trên cho tenant bản doanh nghiệp: bảng `FactEnterprise` (`v_enterprise_plan_actual`), `FactFunding` (`v_enterprise_funding_split`), `DimPeriod`, `DimClass`, `Catalogue` và phép đo tỷ lệ, cơ cấu vốn (mục 3.4); chưa mở thử trong Power BI Desktop |

## 1. Hai con đường đọc dữ liệu

| Đường | Dùng khi | Cách nối | Giới hạn |
|---|---|---|---|
| Tài khoản BI chỉ-đọc vào cơ sở dữ liệu (khuyến nghị cho Power BI và Lakehouse) | Cần khối lượng lớn, truy vấn SQL | Máy chủ và cơ sở dữ liệu của nền tảng, tài khoản `machvon_bi_xxxxxxxxxxxx` cấp ở INT-04, lược đồ `machvon_bi` | Mỗi tài khoản gắn đúng một tenant (một tenant có thể có nhiều tài khoản); số kết nối 1 đến 20; mỗi câu lệnh tối đa 60 giây; chỉ đọc |
| API mở `/open/v1` | Cần danh mục dự án, mã dự án nhiều hệ thống, hoặc công cụ không nối được cơ sở dữ liệu | OAuth 2 client credentials, tài khoản máy ở INT-01, mã truy cập 5 phút | Giới hạn tần suất của tài khoản (429 `RATE_LIMIT`, header `Retry-After`); phân trang `limit` tối đa 200 |

Hai đường cùng đọc **bản chụp đã đóng băng** (không đọc bảng sống) và chỉ khi tập dữ liệu đã được bật và chứng nhận ở INT-04. Tập dữ liệu chưa bật, chưa chứng nhận hoặc hết hạn thì view trả về không có dòng nào (không báo lỗi); view `v_dataset_catalogue` cho biết lý do.

## 2. Cách tổ chức an ninh (tóm tắt cho người làm mô hình)

- Mỗi tài khoản BI gắn với đúng một tenant bằng chính tên đăng nhập; đổi `app.tenant_id` không đọc được tenant khác. Không có quyền ghi.
- Mật khẩu hiện một lần khi cấp (hoặc đổi) ở INT-04; nhà cung cấp chỉ lưu bản băm SCRAM-SHA-256. Đặt mật khẩu trong kho thông tin xác thực của Power BI hoặc cổng dữ liệu, không để trong tệp mô hình hay tệp `.pbids`.
- Mọi lần đọc được ghi bằng `pgaudit` ở máy chủ cơ sở dữ liệu: ảnh cơ sở dữ liệu của gói cài ngoại tuyến đã có `pgaudit` và cổng BI tùy chọn bật ghi nhật ký (`docs/runbooks/infra/bi-port.md`); với cách cài khác, cán bộ vận hành cần bật `pgaudit.log = 'read'` trước khi cấp tài khoản đầu tiên.
- Kết nối bằng TLS (`sslmode=require` trở lên); cơ sở dữ liệu không mở ra Internet, nên Power BI Service cần cổng dữ liệu (on-premises data gateway) đặt trong mạng PVFCCo.

## 3. Các view

Lược đồ `machvon_bi`. Các cột `*_vnd` là số nguyên đồng (numeric 24,0).

### 3.1 `v_dataset_catalogue` (mở đầu tiên)

`dataset_code`, `view_name`, `grain`, `is_open`, `reason` (`OPEN`, `DISABLED`, `NOT_CERTIFIED`, `EXPIRED`, `NO_BINDING`), `certified_until`. Mỗi báo cáo nên có một trang hiển thị bảng này để người xem biết số liệu có đang mở hay không.

### 3.2 `v_disbursement_lines` (DS-DISB, giải ngân)

Một dòng cho mỗi ô (dự án, nhóm `bucket`, cấp ngân sách) của bản chụp; đơn vị và phiên bản nguồn vốn là thuộc tính của dòng. Bản chụp là bản chụp đã đóng băng "đóng kỳ" của một kỳ báo cáo.

| Cột | Kiểu | Ý nghĩa |
|---|---|---|
| `snapshot_id`, `period_id`, `as_of_date` | uuid, uuid, date | Bản chụp, kỳ báo cáo, ngày chốt số |
| `line_id`, `project_id`, `unit_id`, `fund_source_version_id` | uuid | Khóa; `fund_source_version_id` có thể rỗng |
| `bucket` | text | `CURRENT_YEAR`, `CARRYOVER`, `OTHER` |
| `budget_level` | text | `CENTRAL`, `LOCAL` |
| `plan_total_vnd` | số | Kế hoạch vốn có hiệu lực cuối kỳ |
| `disbursed_treasury_vnd` | số, có thể rỗng | Giải ngân lũy kế theo Kho bạc |
| `disbursed_reported_vnd` | số, có thể rỗng | Giải ngân lũy kế theo báo cáo đã được chấp nhận; **không phải tổng các kỳ** |
| `period_delta_vnd` | số, có thể rỗng | Phát sinh trong kỳ |
| `rate_total_pct`, `rate_null_reason` | số, text | Tỷ lệ giải ngân đã tính sẵn; rỗng kèm lý do `ZERO_DENOMINATOR`, `NO_DATA`, `TREASURY_COVERAGE_NONE` |
| `treasury_coverage` | text | `COMPLETE`, `PARTIAL`, `NONE`: mức Kho bạc phủ số liệu của dòng |
| `certification_expires_on` | date | Ngày hết hạn chứng nhận |

Quy tắc sử dụng: giải ngân là **lũy kế**, vì thế để xem một kỳ thì lấy bản chụp của kỳ đó; không cộng các kỳ với nhau. Dòng không có ai báo cáo là rỗng chứ không phải 0. Không cộng `rate_total_pct` giữa các dòng: tính lại bằng tổng giải ngân chia tổng kế hoạch (mục 5).

### 3.3 `v_contract_lines` (DS-CTR, hợp đồng)

Một dòng cho mỗi (hợp đồng, bên tham gia đang hiệu lực) của bản chụp "sự kiện hợp đồng" đã đóng băng. Tiền của hợp đồng được chia cho các bên theo `share_pct` bằng phương pháp phần dư lớn nhất, đến từng đồng, nên **tổng các dòng của hợp đồng bằng đúng giá trị hợp đồng**; không cần lọc `is_lead` để tránh đếm trùng.

| Cột | Ý nghĩa |
|---|---|
| `snapshot_id`, `period_id`, `revision`, `cutoff_date` | Bản chụp, kỳ, **số phiên bản** của kỳ (mỗi lần chốt lại là một phiên bản; lấy phiên bản lớn nhất để xem số hiện hành, hoặc so các phiên bản để thấy đính chính), ngày cắt |
| `contract_id`, `contractor_id`, `is_lead`, `share_pct` | Hợp đồng; nhà thầu; có phải bên đứng đầu liên danh; tỷ lệ chia |
| `project_id`, `unit_id` | Dự án, đơn vị |
| `contract_status`, `contract_type` | Trạng thái, loại hợp đồng |
| `contract_value_vnd`, `active_value_vnd`, `paid_vnd` | Giá trị hợp đồng, giá trị hiện hành sau điều chỉnh, đã thanh toán (phần của bên này) |

### 3.4 Tập DS-ENT (số liệu kỳ doanh nghiệp, chỉ bản doanh nghiệp)

Tập `DS-ENT` đọc **bản chốt kỳ loại `ENTERPRISE_CLOSE`** (ENT-3a, migration `V2660`) mà `v_disbursement_lines` không đọc. Chỉ bản doanh nghiệp bật được tập này (INT-04 chỉ liệt kê nó ở bản đó); cổng giống hai tập trên: tenant bật, sản phẩm dữ liệu CERTIFIED chưa hết hạn, nếu không các view trả về không có dòng nào và `v_enterprise_dataset_catalogue` cho biết lý do. Mỗi kỳ chỉ hiện **bản chốt đang hiệu lực** (bản đã bị bản chốt lại thay thế không hiện, cột `revision` cho biết đó là lần chốt thứ mấy), nên cộng nhiều kỳ không bị đếm trùng một kỳ. Tài khoản BI của tenant A không đọc được dòng nào của tenant B, kể cả khi đặt `app.tenant_id` sang tenant B (kiểm thử `packages/db/test/int-enterprise-bi.test.ts`).

Đơn vị (`unit_id`) là đơn vị chủ quản của dự án ở cuối kỳ, tức công ty thành viên của Tổng công ty; dòng `level = 'TENANT'` của `v_enterprise_by_unit` là toàn Tổng công ty. Số tiền là đồng nguyên (numeric 24,0). Ô không có số là rỗng (kèm lý do ở `v_enterprise_figures.null_reason`), không bao giờ là 0; tỷ lệ tính bằng tổng chia tổng và rỗng khi kế hoạch không dương.

| View | Một dòng là | Dùng để |
|---|---|---|
| `v_enterprise_dataset_catalogue` | Một view của `DS-ENT` | Xem tập đang mở hay không và vì sao không (`is_open`, `reason`, `certified_until`) |
| `v_enterprise_figures` | Một con số của bản chốt: (dự án, nhóm vốn `class_code`, cấp `tier_code`, thước đo `measure`, loại số `figure_kind`, `grain`, `ordinal`) | Dạng dài, nền cho mọi view khác; nạp Lakehouse theo `period_id`. Loại số: `PLAN_YEAR`, `PLAN_ADJUSTED`, `PLAN_IN_FORCE`, `PLAN_MONTH` hoặc `PLAN_QUARTER`, `PLAN_TO_DATE`, `ESTIMATE`, `ESTIMATE_AS_REPORTED`, `ACTUAL`, `CUMULATIVE_YTD`, `CUMULATIVE_SINCE_START`, `ESTIMATE_YEAR`, và `TMDT_IN_FORCE` (tổng mức đầu tư của dự án, nhóm `TOTAL`) |
| `v_enterprise_plan_actual` | (dự án, nhóm vốn, cấp, thước đo) | Kế hoạch, thực hiện, lũy kế cạnh nhau: `plan_year_vnd`, `plan_adjusted_vnd`, `plan_in_force_vnd`, `plan_period_vnd`, `plan_to_date_vnd`, `estimate_vnd`, `actual_vnd` (phát sinh trong kỳ), `cumulative_ytd_vnd`, `cumulative_since_start_vnd`, `estimate_year_vnd`, `rate_in_force_pct`, `rate_to_date_pct`; `period_grain`, `plan_year`, `period_ordinal` là kỳ bản chốt khép lại |
| `v_enterprise_funding_split` | (dự án, thước đo) | Cơ cấu nguồn vốn: kế hoạch hiệu lực và lũy kế của vốn chủ sở hữu (`EQUITY`), vốn vay (`LOAN`), các nhóm còn lại gộp thành `other`, tổng, và `equity_share_pct`, `loan_share_pct` |
| `v_enterprise_by_unit` | (đơn vị, thước đo) và một dòng toàn tenant (`unit_id` rỗng) | Cộng theo đơn vị: `project_count`, kế hoạch, thực hiện, lũy kế, tỷ lệ tính từ tổng, cơ cấu vốn |

Mỗi dòng có thước đo `measure` (`EXECUTED` thực hiện, `DISBURSED` giải ngân): hai thước đo **không cộng với nhau**, nên mọi truy vấn và phép đo phải lọc đúng một thước đo (mô hình mẫu có bảng `DimMeasure` nối với cả hai bảng sự kiện và mặc định `DISBURSED`). Quy tắc sử dụng giống mục 3.2: số lũy kế là của đúng một kỳ, không cộng các kỳ với nhau; không cộng hay lấy trung bình các cột `*_pct`, tính lại bằng tổng chia tổng (năm chỉ tiêu `metrics/ent_rate_in_force`, `ent_rate_to_date`, `ent_cumulative_ytd`, `ent_plan_in_force`, `ent_period_actual` định nghĩa các phép tính đó một lần; một kiểm thử gắn từng trường và chiều của chúng với cột của `v_enterprise_plan_actual`). Truy vấn mẫu 12 đến 18 ở `power-bi-sample-queries.sql` chạy trên các view này; mô hình mẫu cho bản doanh nghiệp là `power-bi/machvon-enterprise-model.tmdl`.

## 4. Mô hình ngữ nghĩa đề xuất

Dạng sao với hai bảng sự kiện và các bảng chiều. Tên bảng trong Power BI đặt tiếng Anh ngắn gọn, nhãn hiển thị đặt tiếng Việt.

```
                 DimPeriod (period_id, as_of_date, năm, tháng)
                      |1                       |1
                      |*                       |*
 DimProject --1:*-- FactDisbursement      FactContract --*:1-- DimProject
 DimUnit    --1:*--      |*                    |*
 DimFundSource -1:*-     |                     +--*:1-- DimContractor
                         +-- DimBucket (bucket, nhãn)
```

| Bảng | Nguồn | Khóa | Ghi chú |
|---|---|---|---|
| `FactDisbursement` | `machvon_bi.v_disbursement_lines` | `line_id` | Nhập (Import); làm mới theo lịch |
| `FactContract` | `machvon_bi.v_contract_lines` | (`snapshot_id`, `contract_id`, `contractor_id`) | Chỉ giữ phiên bản mới nhất mỗi kỳ trong truy vấn nguồn (xem tệp SQL mẫu) |
| `DimPeriod` | Hợp các cặp (`period_id`, ngày chốt) khác nhau của `v_disbursement_lines` (`as_of_date`) và `v_contract_lines` (`cutoff_date`); cả hai bảng sự kiện nối qua `period_id` | `period_id` | Bảng lịch tạo trong Power BI |
| `DimProject` | API mở `GET /open/v1/projects` (mã, tên, trạng thái, phân loại, đơn vị chủ quản, mã quốc gia) | `id` = `project_id` | Cơ sở dữ liệu BI không có tên dự án: lấy từ API mở (mục 6) |
| `DimUnit`, `DimFundSource`, `DimContractor` | **Chưa có nguồn** trong cổng BI hiện tại: chỉ có khóa uuid | `unit_id`, `fund_source_version_id`, `contractor_id` | Đề xuất bổ sung view danh mục (xem mục 8); trước mắt hiển thị theo mã dự án và đơn vị chủ quản của dự án |
| `DimBucket` | Bảng nhập tay 3 dòng | `bucket` | `CURRENT_YEAR` là "Kế hoạch năm nay", `CARRYOVER` là "Vốn kéo dài", `OTHER` là "Khác" |
| `Catalogue` | `machvon_bi.v_dataset_catalogue` | `dataset_code` | Trang trạng thái dữ liệu |

Quan hệ: một-nhiều từ chiều sang sự kiện, lọc một chiều. Kiểu dữ liệu: các cột `*_vnd` đặt "Số thập phân" (số thực chính xác tới 9 triệu tỷ đồng, đủ cho mọi tổng của PVFCCo); cột tỷ lệ đặt "Số thập phân"; cột uuid đặt "Văn bản" và ẩn khỏi người dùng báo cáo.

## 5. Phép đo mẫu (DAX)

```dax
-- Giải ngân và giá trị hợp đồng là lũy kế của từng bản chụp kỳ: luôn tính ở đúng một kỳ (theo period_id, vì hai kỳ khác nhau có thể trùng ngày chốt).
-- Người xem chọn một kỳ trong bộ lọc DimPeriod; nếu không chọn thì lấy kỳ có ngày chốt mới nhất.
-- Kỳ được đưa vào biến TRƯỚC khi CALCULATE: nếu gọi phép đo [Chosen Period] bên trong FILTER, chuyển ngữ cảnh dòng làm điều kiện luôn đúng và cộng dồn mọi kỳ.
Chosen Period :=
COALESCE (
    SELECTEDVALUE ( DimPeriod[period_id] ),
    MAXX ( TOPN ( 1, ALLSELECTED ( DimPeriod ), DimPeriod[as_of_date], DESC ), DimPeriod[period_id] )
)

Plan VND :=
VAR ChosenPeriod = [Chosen Period]
RETURN CALCULATE ( SUM ( FactDisbursement[plan_total_vnd] ), DimPeriod[period_id] = ChosenPeriod )

Disbursed Treasury VND :=
VAR ChosenPeriod = [Chosen Period]
RETURN CALCULATE ( SUM ( FactDisbursement[disbursed_treasury_vnd] ), DimPeriod[period_id] = ChosenPeriod )

Disbursement Rate % := DIVIDE ( [Disbursed Treasury VND], [Plan VND] )

Period Delta VND :=
VAR ChosenPeriod = [Chosen Period]
RETURN CALCULATE ( SUM ( FactDisbursement[period_delta_vnd] ), DimPeriod[period_id] = ChosenPeriod )

Lines Without Treasury Coverage :=
VAR ChosenPeriod = [Chosen Period]
RETURN CALCULATE ( COUNTROWS ( FactDisbursement ), FactDisbursement[treasury_coverage] = "NONE", DimPeriod[period_id] = ChosenPeriod )

Contract Value VND :=
VAR ChosenPeriod = [Chosen Period]
RETURN CALCULATE ( SUM ( FactContract[active_value_vnd] ), DimPeriod[period_id] = ChosenPeriod )

Paid To Contractors VND :=
VAR ChosenPeriod = [Chosen Period]
RETURN CALCULATE ( SUM ( FactContract[paid_vnd] ), DimPeriod[period_id] = ChosenPeriod )

Paid Share % := DIVIDE ( [Paid To Contractors VND], [Contract Value VND] )
```

Lưu ý: dòng có `treasury_coverage = "NONE"` nằm trong mẫu số (kế hoạch) nhưng không có giải ngân Kho bạc, nên tỷ lệ bị thấp đi; xem phép đo `Lines Without Treasury Coverage` và cân nhắc lọc kế hoạch về các dòng có dữ liệu Kho bạc khi báo cáo cho lãnh đạo. `Disbursement Rate %` không dùng cột `rate_total_pct` đã tính sẵn vì tỷ lệ không cộng được qua các dòng; chia lại tổng với tổng cho đúng ở mọi mức gộp. Mỗi phép đo cần kèm chú thích công thức, nguồn và ngày chốt số theo quy ước của MACHVON ("mọi con số có công thức, nguồn, thời điểm"): đặt `as_of_date` của kỳ trên đầu trang báo cáo.

## 6. Dữ liệu chiều từ API mở (Power Query)

Power BI không tự chạy luồng client credentials; viết hai hàm Power Query: một lấy mã truy cập, một đọc các trang. Tham số `BaseUrl`, `ClientId`, `ClientSecret` là tham số của mô hình (đặt khi xuất bản, hoặc đặt trong Key Vault của cổng dữ liệu); **không viết giá trị thật vào tệp**.

```
let
    GetToken = () =>
        let
            Body = Json.FromValue([grant_type = "client_credentials", client_id = ClientId, client_secret = ClientSecret, scope = "open.projects.read"]),
            Response = Web.Contents(BaseUrl, [RelativePath = "open/v1/token", Headers = [#"Content-Type" = "application/json"], Content = Body]),
            Token = Json.Document(Response)[access_token]
        in Token,
    Token = GetToken(),
    GetPage = (cursor as nullable text) =>
        let
            Query = [limit = "200"] & (if cursor = null then [] else [cursor = cursor]),
            Page = Json.Document(Web.Contents(BaseUrl, [RelativePath = "open/v1/projects", Query = Query, Headers = [Authorization = "Bearer " & Token]]))
        in Page,
    Pages = List.Generate(
        () => GetPage(null),
        each _ <> null,
        each if [next_cursor] = null then null else GetPage([next_cursor]),
        each [items]),
    Projects = Table.FromRecords(List.Combine(Pages))
in Projects
```

Mã truy cập sống 5 phút: nếu danh sách lớn, đặt cả hàm lấy mã và hàm đọc trang trong một truy vấn làm mới ngắn, hoặc xin lại mã sau mỗi vài trang. Lỗi 429 thì chờ `Retry-After` giây.

## 7. Làm mới và Data Lakehouse

- **Power BI.** Chế độ Import, làm mới theo lịch bám theo nhịp đóng kỳ (ví dụ hằng ngày vào buổi sáng, và ngay sau khi Ban KHĐT chốt kỳ). Không khuyến nghị DirectQuery: mỗi truy vấn chạy trong giới hạn 60 giây và đi qua chính sách an ninh theo từng dòng.
- **Lakehouse.** Sao chép từng kỳ từ hai view vào vùng thô (bronze) bằng Spark JDBC, Data Factory hoặc công cụ ETL của Tổng công ty, với tài khoản BI riêng (một tài khoản cho mỗi ứng dụng đọc, để thu hồi riêng khi cần). Khóa nạp: `period_id`. Bản chụp đã đóng băng không đổi, nhưng khi một kỳ được chốt lại thì bản cũ chuyển sang "đã bị thay thế", biến mất khỏi view, và bản mới có `snapshot_id` khác; vì vậy nạp theo kiểu thay cả kỳ (xóa các dòng cũ của `period_id` rồi thêm dòng mới trong một giao dịch), không cộng dồn. Với hợp đồng, theo chú thích của view mỗi phiên bản (`revision`) của kỳ là một bộ dòng riêng, nên có thể giữ các phiên bản để theo dõi đính chính; kiểm tra điều này trên UAT trước khi dựa vào nó (xem mục 8).
- **Kiểm tra sau khi nạp.** So tổng `plan_total_vnd` và `disbursed_treasury_vnd` của từng kỳ giữa nguồn và vùng thô; số dòng; `certification_expires_on` còn hạn. Khác biệt phải được giải trình trước khi công bố báo cáo.
- **Khi chứng nhận hết hạn.** View ngừng trả dòng; việc nạp phải coi "0 dòng" cho một kỳ đã có là lỗi, không phải là dữ liệu: không xóa vùng thô khi nguồn trả rỗng và `v_dataset_catalogue.is_open` là false.

## 8. Hạn chế đã biết và đề xuất tiếp theo

1. Chưa có view danh mục đơn vị, nguồn vốn, nhà thầu cho tài khoản BI; chỉ có khóa. Đề xuất thêm các view `v_dim_unit`, `v_dim_fund_source`, `v_dim_contractor` có cùng cơ chế cổng và chứng nhận, rồi cập nhật mô hình này.
2. Số liệu kỳ doanh nghiệp đã có ở tập `DS-ENT` (INT-2, mục 3.4). Còn lại: (a) chưa có chiều đơn vị (tên công ty), tên dự án, tên nhóm vốn trong cổng BI, chỉ có khóa và mã nhóm vốn (mục 1 của danh sách này); (b) chưa có API mở `/open/v1` cho `DS-ENT`; (c) chưa chạy truy vấn chỉ tiêu `ent_*` trong BI nội bộ (cần bộ nối và nguồn đọc riêng, xem `lakehouse-proposal.md` mục 8); (d) thuyết minh của kỳ không thuộc tập này.
3. Gói cài ngoại tuyến đã có cổng cơ sở dữ liệu chỉ-đọc tùy chọn (đóng theo mặc định) và `pgaudit` (INT-2; `lakehouse-proposal.md` mục 6, `docs/runbooks/infra/bi-port.md`) nhưng chưa chạy thật trên Docker; đường mạng do PVFCCo chọn. Cho tới khi cổng được bật, Power BI lấy dữ liệu qua API mở bằng hàm Power Query ở mục 6 (API mở chưa có `DS-ENT`), hoặc nối cơ sở dữ liệu ở UAT khi Ban CĐS&CNTT đã mở cổng.
4. Chưa có đo hiệu năng trên phần cứng của PVFCCo; cần chạy các truy vấn mẫu trên môi trường UAT cấu hình tương đương Production và ghi kết quả.
5. Việc giữ nhiều `revision` của hợp đồng trong Lakehouse và việc bản chụp hợp đồng cũ có còn hiện sau khi kỳ được chốt lại cần được thử trên UAT bằng một kỳ được chốt lại; kết quả ghi vào tài liệu này.
6. Bản mẫu `.pbids` không đi kèm báo cáo `.pbix`: báo cáo mẫu cần dữ liệu thật hoặc dữ liệu thử đã chứng nhận trong UAT.

## 9. Mô hình TMDL mẫu

Tệp `docs/integration/power-bi/machvon-sample-model.tmdl` là mô hình ngữ nghĩa của mục 4 và 5 viết dưới dạng văn bản TMDL: ba tham số (`ServerName`, `DatabaseName`, `OpenApiBaseUrl`), bảng `FactDisbursement`, `FactContract`, `DimPeriod`, `DimBucket`, `Catalogue`, các quan hệ một-nhiều và các phép đo DAX. Cách dùng: mở Power BI Desktop, bật khung nhìn TMDL (tính năng xem trước, Options, Preview features), dán nội dung tệp vào và chạy; hoặc nạp bằng Tabular Editor. Bảng `DimProject` lấy từ API mở bằng hàm Power Query ở mục 6, nên không nằm trong tệp (cần tham số thông tin xác thực mà tệp không được chứa).

Tình trạng: **chưa mở thử trong Power BI Desktop** (môi trường soạn tài liệu không có Power BI Desktop). Cú pháp theo đặc tả TMDL; nếu Power BI Desktop báo lỗi ở dòng nào thì sửa dòng đó và ghi lại vào lịch sửa của tài liệu này. Số liệu thật chưa có: mô hình chỉ có ý nghĩa khi tài khoản BI đọc được tập dữ liệu đã bật và chứng nhận (mục 1).

Lịch sửa: v0.2 2026-11-12 (rà soát lane aud4: thêm mục 9, cập nhật mục 8 theo phát hiện về bản chốt doanh nghiệp và đường mạng); v0.3 2026-11-12 (lane INT-2: thêm mục 3.4 tập `DS-ENT`, mô hình `machvon-enterprise-model.tmdl`, truy vấn mẫu 12 đến 18, cập nhật mục 2 và 8 theo cổng cơ sở dữ liệu và `pgaudit` đã có trong gói cài đặt).
