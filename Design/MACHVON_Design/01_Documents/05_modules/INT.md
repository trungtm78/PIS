# INT — Tích hợp và API mở (INT-1)

Phân hệ INT mở dữ liệu đã chứng nhận của một tổ chức cho máy và công cụ BI mà không có đường vòng qua ranh giới tổ chức. Căn cứ: kế hoạch Đợt 4 mục 4 (INT-1), rà soát kỹ thuật R6 và R13 (`C:\Users\PNE_AI_01\.claude\plans\harmonic-foraging-pond.md`). Mã nguồn: `packages/kernel/src/open-api*.ts`, `packages/db/src/int-*.ts`, `apps/api/src/modules/int/`, migration `V2200`–`V2203`. Tài liệu vận hành cho người đọc bên ngoài: `docs/open-api.md` và `docs/open-api/openapi.json` (tập con OpenAPI công bố).

## 1. Mục đích, phạm vi, ranh giới

- **Vấn đề.** Kho dữ liệu (Lakehouse), Power BI và các hệ thống của tổ chức (PMIS, ERP, tài chính) cần đọc số liệu đã chốt và đối chiếu mã dự án; đường đọc trực tiếp bảng gốc sẽ vượt qua RLS (các vai trò V001 là `NOBYPASSRLS` nhưng một vai trò báo cáo dùng chung đọc bảng gốc thì không bị ràng buộc theo tổ chức).
- **Trong phạm vi.** (a) API mở `/open/v1` cho tài khoản máy: client credentials, phạm vi chỉ đọc, giới hạn tần suất, nhật ký mọi lần đọc; (b) tập dữ liệu đã chứng nhận bật cho người đọc bên ngoài; (c) tài khoản CSDL chỉ đọc cho công cụ BI, mỗi tổ chức một tài khoản cho mỗi công cụ, gắn với tổ chức bằng chính tên đăng nhập; (d) mã dự án của ta trong các hệ thống khác, trên `master_crosswalk`.
- **Ngoài phạm vi.** Không có phạm vi ghi trong API mở ở phiên bản này; không có đường đẩy dữ liệu ra (ENT-2 đẩy HPM); nhật ký từng câu lệnh SELECT của tài khoản BI (xem mục 13: dùng pgaudit ở máy chủ CSDL); mã của mạng đấu thầu quốc gia vẫn thuộc EGP-1 (`MUASAMCONG`).
- **Phụ thuộc.** ADM (vai trò, kiểm toán), DGV (`data_product` và trạng thái CERTIFIED), DIS (ảnh chụp kỳ đã chốt `period_snapshot`), CTR (`contract_fact_snapshot`), BID/EGP-1 (bảng `master_crosswalk` mở rộng ở V1940), MDM.
- **Căn cứ.** Thực tiễn: OAuth 2.0 client credentials (RFC 6749 mục 4.4), RFC 9457 cho lỗi; PostgreSQL row-level security và SCRAM-SHA-256 (RFC 5802/7677).

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Quản trị tích hợp (`int.account.*`, `int.bi.*`, `int.dataset.*`, `int.system.manage`) | Toàn tổ chức (grant TENANT) | Mở, sửa, tạm khóa, thu hồi tài khoản máy; đổi khóa; tạo, đổi mật khẩu, ngừng tài khoản BI; bật hoặc tắt tập dữ liệu; đăng ký hệ thống | Grant trên một nhánh đơn vị: `403 SCOPE_DENIED` |
| Chuyên viên dữ liệu chủ (`int.codes.propose`, `int.codes.approve`) | Toàn tổ chức | Đề xuất, duyệt, từ chối, ngừng mã dự án; người đề xuất không tự duyệt | Tự duyệt đề xuất của mình: `403 SELF_APPROVAL_DENIED` |
| Người đọc (`int.*.read`, `int.access.read`) | Toàn tổ chức | Xem danh sách, nhật ký, trạng thái; không thấy bí mật (chỉ gợi ý 8 ký tự) | Mọi lệnh |
| Tài khoản máy | Một tổ chức, đúng phạm vi đã cấp | Đọc `/open/v1/*` trong phạm vi | Bất kỳ đường nào khác; mã truy cập của người dùng không dùng được ở đây và ngược lại |
| Tài khoản CSDL BI | Một tổ chức (bảng `machvon_bi.reader_binding`) | `SELECT` các view đã chứng nhận | Mọi bảng khác, mọi lệnh ghi, đổi tổ chức bằng `app.tenant_id` |

## 3. Luồng nghiệp vụ

1. **Mở tài khoản máy (INT-01).** `createMachineAccount` trả `client_id` và `client_secret` một lần (`withheld`: bản lưu để phát lại có `client_secret` rỗng). Hệ thống chỉ giữ SHA-256 của bí mật. Hậu điều kiện: một dòng `int_machine_account`, một dòng `int_machine_credential`, một dòng kiểm toán và một sự kiện, không dòng nào chứa bí mật.
2. **Lấy mã truy cập.** `POST /open/v1/token` với `grant_type=client_credentials`: mã ES256, đối tượng `machvon-open`, 5 phút, mang tổ chức, tài khoản, thông tin xác thực và phạm vi. Mọi từ chối (mã khách lạ, sai bí mật, hết hạn, bị thu hồi, tài khoản tạm khóa, tổ chức bị khóa) trả `401 OPEN_CLIENT_INVALID` giống nhau; với mã khách đã biết, lần từ chối có dòng `DENIED_CLIENT` trong nhật ký. Phạm vi xin chỉ được thu hẹp, không rộng hơn tài khoản (`403 OPEN_SCOPE_DENIED`).
3. **Đọc dữ liệu.** Mỗi lần gọi xét lại mã, tài khoản, thông tin xác thực và tổ chức theo trạng thái hiện tại (tạm khóa có hiệu lực ngay với mã còn sống), lấy một chỗ trong giới hạn tần suất của tài khoản (`429 RATE_LIMIT` với `Retry-After`), kiểm phạm vi, kiểm cổng tập dữ liệu, đọc dưới RLS của tổ chức, và ghi dòng nhật ký trong cùng giao dịch với việc đọc.
4. **Đổi khóa.** `rotateMachineCredential` tạo khóa mới; khóa cũ sống thêm `grace_hours` (0 đến 72, mặc định 24); khóa còn đang chờ hết hạn chuyển tiếp trước đó bị thu hồi, nên không bao giờ quá hai khóa sống.
5. **Bật tập dữ liệu (INT-04).** `setExportDataset` chỉ bật khi sản phẩm dữ liệu đang CERTIFIED và chưa hết hạn (`422 OPEN_DATASET_NOT_CERTIFIED`); từ lúc bật, cổng được xét lại ở mọi lần đọc.
6. **Tài khoản BI (INT-04).** `createBiReader` gọi hàm đặc quyền `machvon_bi.provision_reader` tạo tài khoản CSDL (`NOSUPERUSER NOBYPASSRLS`, chỉ đọc, giới hạn kết nối, `statement_timeout`) với mật khẩu dạng SCRAM do ứng dụng tạo; mật khẩu hiện một lần. Đổi mật khẩu ngắt các phiên đang mở; tạm khóa ghi `active = false` vào bảng ràng buộc trước (mọi view và chính sách trả rỗng ngay) rồi `NOLOGIN` và ngắt phiên; ngừng thì xóa tài khoản.
7. **Mã dự án đa hệ thống (INT-03).** Đăng ký hệ thống (mã chữ hoa, khuôn dạng mã); đề xuất mã (`proposeProjectCode`), người khác duyệt (`decideProjectCode`), ngừng (`retireProjectCode`). Đường đi và ràng buộc là của EGP-1 trên `master_crosswalk`.

Màn hình: INT-01 Tài khoản máy, INT-02 Phạm vi và khóa, INT-03 Ánh xạ mã dự án đa hệ thống, INT-04 Tài khoản BI và tập dữ liệu chứng nhận, INT-05 Nhật ký truy cập API mở.

## 4. State machine

Tài khoản máy: `ACTIVE <-> SUSPENDED`, `ACTIVE|SUSPENDED -> REVOKED` (cuối).

| Từ | Command | Đến | Ai | Guard | Audit/Event |
|---|---|---|---|---|---|
| ACTIVE | `decideMachineAccount` SUSPEND | SUSPENDED | `int.account.manage` toàn tổ chức | lý do 10 ký tự trở lên, đúng version | `int.machine_account_decided`, `int.machine_account.changed.v1` |
| SUSPENDED | REACTIVATE | ACTIVE | như trên | tài khoản chưa quá ngày hết hạn của chính nó | như trên |
| ACTIVE hoặc SUSPENDED | REVOKE | REVOKED | như trên | thu hồi mọi thông tin xác thực cùng giao dịch | như trên |

Mọi chuyển khác (ví dụ từ REVOKED) là `409 OPEN_ACCOUNT_STATE_INVALID`. Tài khoản BI: `ACTIVE <-> SUSPENDED`, `ACTIVE|SUSPENDED -> RETIRED` (cuối, tài khoản CSDL bị xóa; `409 BI_READER_STATE_INVALID`). Mã dự án: `PROPOSED -> ACTIVE|REJECTED`, `ACTIVE -> RETIRED` (cuối; `409 EGP_MAPPING_STATE_INVALID`).

## 5. Quy tắc nghiệp vụ và công thức

- **BR-INT-01.** Một tài khoản máy chỉ đọc đúng phạm vi và đúng tổ chức của nó; không có phạm vi ghi.
- **BR-INT-02.** Bí mật sinh ra từ 32 byte ngẫu nhiên, hiện một lần, lưu dạng SHA-256 (giá trị ngẫu nhiên entropy cao không cần hàm chậm); so sánh hằng thời gian; không có bí mật trong nhật ký ứng dụng, kiểm toán, sự kiện hay bản lưu phát lại.
- **BR-INT-03.** Giới hạn tần suất theo tài khoản: cửa sổ cố định 60 giây, `rate_limit_per_minute` từ 1 đến 6000 (mặc định 60); bộ đếm nằm trong tiến trình (nhiều tiến trình nhân trần lên theo số tiến trình), nhật ký truy cập là bản ghi chính thức.
- **BR-INT-04 (cổng tập dữ liệu).** Mở khi và chỉ khi `enabled` và `data_product.certification_status = 'CERTIFIED'` và (`certification_expires_on` rỗng hoặc lớn hơn hôm nay theo giờ Việt Nam). Cùng một công thức ở kernel `datasetGate` và ở SQL `machvon_bi.dataset_state`; test cơ sở dữ liệu khóa hai bên với nhau.
- **BR-INT-05 (R13).** Tổ chức của tài khoản BI được suy từ `current_user` qua `machvon_bi.reader_binding`, không bao giờ từ biến phiên `app.tenant_id`. Ba lớp: view `security_invoker` lọc theo tổ chức của hàm `dataset_state`; chính sách `bi_reader_boundary` (RESTRICTIVE, chỉ cho nhóm `machvon_bi_reader`) trên bốn bảng nguồn; chỉ cấp quyền cột cho những cột view dùng. Đổi `app.tenant_id` sang tổ chức khác thì không đọc được dòng nào, cả ở view lẫn ở bảng.
- **BR-INT-06.** View chỉ đọc ảnh chụp FROZEN (`period_snapshot.status = 'FROZEN'`, loại `PERIOD_CLOSE`): bất biến, có nhãn chứng nhận và ngày hết hạn trên từng dòng.
- **BR-INT-07.** Mã dự án: một mã ngoài chỉ thuộc một dự án tại một thời điểm, một dự án chỉ giữ một mã ACTIVE cho mỗi hệ thống; mã phải khớp khuôn dạng hệ thống khai báo (kiểm ở ứng dụng và ở trigger V2203); không có bảng định danh ngoài mới.

## 6. Dữ liệu

Migration khối INT-1 (2200–2219): `V2200` (vai trò nhóm `machvon_bi_reader`, schema `machvon_bi`, bốn hàm đặc quyền, quyền `int.*` cho chủ tổ chức), `V2201` (bảng), `V2202` (ràng buộc, hàm, chính sách, view), `V2203` (trigger mã dự án).

| Bảng | Nội dung | Ghi chú |
|---|---|---|
| `int_source_system` | Hệ thống nguồn: mã, tên, loại, khuôn dạng mã, trạng thái | `MUASAMCONG` và `TENANT_ALIAS` bị cấm (CHECK) |
| `int_machine_account` | Tên, mô tả, phạm vi (`text[]`, CHECK theo danh mục), tần suất, ngày hết hạn, trạng thái, lý do | tên duy nhất không phân biệt hoa thường trừ tài khoản đã thu hồi |
| `int_machine_credential` | `client_id` (duy nhất toàn cục), `secret_hash`, gợi ý, `superseded_at`, `expires_at`, `revoked_at` | trigger giữ nguyên danh tính, không xóa |
| `int_client_directory` | Chỉ mục `client_id` → tổ chức, không RLS, chỉ vai trò điều khiển đọc, do trigger giữ | như `tenant_domain_directory` |
| `int_access_log` | Một dòng mỗi lần gọi: tài khoản, thông tin xác thực, thao tác, phạm vi, đường dẫn (không có chuỗi truy vấn), tên tham số, kết quả, mã trạng thái, số dòng, mã tương quan | chỉ thêm, kể cả vai trò sở hữu |
| `int_export_dataset` | Tập dữ liệu bật cho người đọc ngoài, sản phẩm dữ liệu đứng sau, lý do | FK sang `data_product` |
| `int_bi_reader`, `int_bi_reader_event` | Sổ tài khoản BI và lịch sử | lịch sử chỉ thêm |
| `master_crosswalk` (mở rộng, EGP-1) | `subject_type = PROJECT`, `external_type = PROJECT_CODE` | không bảng mới |
| `machvon_bi.reader_binding` | `login_name` → tổ chức, `active` | chỉ chủ sở hữu và hàm đặc quyền chạm tới |

Phân loại: `int_machine_*`, `int_bi_reader*`, `int_export_dataset` là CONFIDENTIAL; nhật ký truy cập INTERNAL. Giữ lại: nhật ký truy cập theo chính sách lưu trữ ADM (không xóa bằng ứng dụng).

## 7. API / command

| operationId | Method path | Quyền | Lỗi chính | If-Match |
|---|---|---|---|---|
| `listMachineAccounts`, `getMachineAccount` | GET `/int/machine-accounts[/{id}]` | `int.account.read` | 403 `SCOPE_DENIED` | không |
| `createMachineAccount` | POST `/int/machine-accounts` | `int.account.manage` | 409 `OPEN_ACCOUNT_NAME_TAKEN`, 422 | không |
| `updateMachineAccount`, `decideMachineAccount`, `rotateMachineCredential` | POST `/int/machine-accounts/{id}/update|decision|rotate` | `int.account.manage` | 409 `OPEN_ACCOUNT_STATE_INVALID`, `VERSION_CONFLICT` | có |
| `listOpenAccessLog` | GET `/int/access-log` | `int.access.read` | 422 | không |
| `listExportDatasets`, `setExportDataset` | GET `/int/export-datasets`, POST `/int/export-datasets/state` | `int.dataset.read`, `int.dataset.manage` | 422 `OPEN_DATASET_NOT_CERTIFIED` | có (version 1 khi chưa cấu hình) |
| `listBiReaders`, `getBiReader`, `createBiReader`, `rotateBiReaderPassword`, `decideBiReader` | `/int/bi-readers...` | `int.bi.read`, `int.bi.manage` | 409 `BI_READER_STATE_INVALID`, 503 `BI_PROVISIONING_UNAVAILABLE` | có |
| `listSourceSystems`, `registerSourceSystem`, `retireSourceSystem` | `/int/source-systems...` | `int.codes.read`, `int.system.manage` | 409 `INT_SOURCE_SYSTEM_TAKEN`, `INT_SOURCE_SYSTEM_IN_USE` | có (retire) |
| `listProjectCodes`, `proposeProjectCode`, `decideProjectCode`, `retireProjectCode` | `/int/project-codes...` | `int.codes.read`, `int.codes.propose`, `int.codes.approve` | 409 `CROSSWALK_DUPLICATE`, 403 `SELF_APPROVAL_DENIED` | có |
| `issueOpenApiToken` | POST `/open/v1/token` | công khai, xác thực bằng client credentials | 401 `OPEN_CLIENT_INVALID`, 403 `OPEN_SCOPE_DENIED` | không |
| `getOpenApiDocument`, `listOpenProjects`, `listOpenProjectCodes`, `listOpenDatasets`, `listOpenDisbursementLines`, `listOpenContractLines` | GET `/open/v1/...` | phạm vi `open.*.read` | 401, 403, 429 | không |

`createMachineAccount`, `rotateMachineCredential`, `createBiReader`, `rotateBiReaderPassword` trả bí mật một lần; trường `client_secret` và `password` được `withheld` khỏi bản lưu Idempotency-Key. Các GET quản trị là DTO riêng; không có endpoint ghi chung cho trạng thái, phạm vi hay tenant.

## 8. UI/UX

Năm màn hình dùng bộ thành phần `apps/web/src/ui`, bảy trạng thái chuẩn và ContextBar trên mọi con số. Mỗi bí mật hiện trong hộp thoại một lần với nút sao chép và cảnh báo "không xem lại được"; sau khi đóng chỉ còn gợi ý 8 ký tự. Thao tác ẩn khi thiếu quyền; người chỉ đọc thấy nhãn "chỉ xem". INT-04 hiển thị tên schema và tên view cho người cấu hình công cụ BI, và lý do một tập dữ liệu đang đóng (`DISABLED`, `NOT_CERTIFIED`, `EXPIRED`). Chỉ web (không có phần mobile).

## 9. Sự kiện, job, tích hợp, quan sát

Sự kiện (payload chỉ có mã định danh và mã): `int.machine_account.changed.v1`, `int.bi_reader.changed.v1`, `int.export_dataset.changed.v1`, `int.source_system.changed.v1`, `int.project_code.changed.v1`. Không có job nền. Giới hạn tần suất trong tiến trình. Quan sát: nhật ký truy cập là nguồn cho số lần gọi, từ chối và 429 theo tài khoản; đọc qua tài khoản BI không vào bảng này (xem mục 13).

## 10. Kiểm thử

| ID | Loại | Nội dung |
|---|---|---|
| `packages/kernel/test/open-api.test.ts` | domain | phạm vi, cổng chứng nhận, vòng đời, giới hạn tần suất, bí mật, tập con OpenAPI |
| `packages/db/test/int-open-api.test.ts` | integration, security | mã dự án trên `master_crosswalk`, tài khoản máy, tra cứu theo mã khách, nhật ký chỉ thêm, **test âm R13** (đổi `app.tenant_id` sang tổ chức khác không đọc được gì ở view lẫn bảng), vòng đời tài khoản BI, so khớp API và view |
| `apps/api/test/int/int.test.ts` | integration | quyền, bí mật hiện một lần và không nằm ở đâu, token, phạm vi, cổng tập dữ liệu, 429, tạm khóa có hiệu lực ngay, tài liệu công bố |
| `apps/api/test/isolation/*` | security | ca ID ngoại cho mọi thao tác có ID và kênh CSDL (cả đường API lẫn đường tài khoản BI) |
| UAT-INT-001 đến UAT-INT-003, UI-INT-01 đến UI-INT-05 | UAT, màn hình | theo `test_cases.json` |

## 11. Tiêu chí nghiệm thu (đo được)

- **AC-INT-01.** Cho hai tổ chức, một tài khoản máy có một phạm vi, khi đọc trong và ngoài phạm vi, tạm khóa lúc đang giữ mã, đổi khóa; thì chỉ thấy dữ liệu tổ chức mình trong phạm vi, tạm khóa có hiệu lực ngay, bí mật hiện một lần và không nằm ở đâu, mọi lần gọi có dòng nhật ký (UAT-INT-001).
- **AC-INT-02.** Cho hai tài khoản BI, khi một tài khoản đổi `app.tenant_id` sang tổ chức kia; thì không đọc được dòng nào ở view và ở bảng (UAT-INT-002).
- **AC-INT-03.** Cho một hệ thống có khuôn dạng mã, khi người đề xuất tự duyệt và khi đề xuất trùng; thì `SELF_APPROVAL_DENIED` và `CROSSWALK_DUPLICATE` (UAT-INT-003).

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

R2: toàn bộ phần trên. Hạng mục bắt buộc người duyệt: quyền (ma trận `int.*` do chủ nghiệp vụ ký), an ninh (hàm đặc quyền tạo tài khoản CSDL, 4 giờ đến 8 giờ). R3: phạm vi ghi (cần thiết kế riêng), dịch vụ đếm tần suất dùng chung nhiều tiến trình, tập dữ liệu thứ ba trở đi theo yêu cầu.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

- **Nhật ký đọc của tài khoản BI.** PostgreSQL không ghi từng SELECT nếu không có pgaudit; vận hành bật `pgaudit.log = 'read'` cho nhóm `machvon_bi_reader` và `log_connections`. Chủ sở hữu: quản trị hạ tầng; điều kiện giải quyết: bật ở môi trường sản xuất trước khi cấp tài khoản BI đầu tiên.
- **Môi trường không cho tạo vai trò.** Cơ sở dữ liệu quản lý (managed) có thể không cho migration đặc quyền tạo vai trò; khi đó các lệnh BI trả `503 BI_PROVISIONING_UNAVAILABLE` và không đổi gì. Chủ sở hữu: quản trị hạ tầng.
- **Bộ đếm tần suất trong tiến trình.** Triển khai nhiều bản sao thì giới hạn thực tế nhân lên; nhật ký truy cập là bản ghi chính thức; bộ đếm dùng chung là việc của R3.
- **Mật khẩu của tài khoản BI do chủ tổ chức giữ.** Công cụ BI lưu mật khẩu theo cách riêng của nó; đổi mật khẩu định kỳ là trách nhiệm của quản trị tích hợp.
