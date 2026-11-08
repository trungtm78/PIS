# RPT — Bộ sinh báo cáo đúng bố cục (report engine)
Baseline 1.5 | Kế hoạch RPT-1 (khối migration 2140–2159), eng-review R9 (thư viện Excel/Word), R17 (dòng dõi bản phát hành, bản cũ bị từ chối), R18 (mẫu chờ xác nhận không được tính là đã nhận). Màn hình RPT-01…RPT-04. Phần mô hình thuần, bộ ghi tệp và sáu biểu mẫu demo xem `docs/report-engine.md`.

## 1. Mục đích, phạm vi, ranh giới
Cơ quan và doanh nghiệp phải gửi báo cáo theo biểu mẫu có hàng và cột cố định (yêu cầu BC.01: Excel giữ nguyên trong mẫu, Word cho phần thuyết minh, quy tắc đặt tên tệp, mỗi kỳ một bản đã phát hành). Phân hệ lập báo cáo cho một biểu mẫu và một kỳ bằng cách điền số liệu của sổ chỉ tiêu (KPI register) vào mẫu, đưa bản nháp qua ba người (lập, kiểm tra, phê duyệt), phát hành thành bản bất biến có mã băm, ghi lần giao cho bên nhận và câu trả lời của bên nhận.
- **Trong phạm vi:** danh mục biểu mẫu theo bản (công khai, doanh nghiệp); lập bản nháp; xem trước từng ô; luồng kiểm tra – phê duyệt – phát hành; chuỗi phiên bản của một kỳ; nhật ký giao và nhận.
- **Ngoài phạm vi:** đẩy tự động sang hệ thống của tập đoàn (ENT-2, kênh `HPM_PUSH` chỉ bộ nối đó được ghi); số liệu tài chính doanh nghiệp thật (FND-1, `docs/fnd-funding-model.md`): biểu mẫu doanh nghiệp bám mã `ENT_*` của sổ chỉ tiêu và hiện chạy trên số minh họa; thiết kế biểu mẫu mới bằng giao diện.
- **Phụ thuộc:** DIS (bản chụp đã chốt và phiên bản của nó), HOME (đọc số qua cùng bộ đọc với màn hình lãnh đạo), ADM (quy tắc `REPORT_FORM_MODE`, `KPI_DEFINITION`), kernel (`report-layout.ts`, `report-issue.ts`, `report-form.ts`).
- **Căn cứ:** yêu cầu BC.01 của khách hàng; thực tiễn lưu hồ sơ báo cáo không sửa được (bản thay thế nêu lý do). Biểu mẫu chính thức của PVFCCo chưa có: sáu biểu mẫu do hệ thống tự thiết kế, ghi `MẪU DEMO — chờ mẫu chính thức` [CXN-DEMO-FORMS].

## 2. Actor, tenant và phạm vi quyền
| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Người lập báo cáo | Toàn tenant (`rpt.generate`, kèm `home.read` để đọc số) | Lập bản nháp, xem | Kiểm tra hoặc duyệt bản của mình |
| Người kiểm tra | Toàn tenant (`rpt.check`) | Kiểm tra bản nháp của người khác | Kiểm tra bản mình lập |
| Người phê duyệt | Toàn tenant (`rpt.approve`, `rpt.issue`) | Duyệt bản đã kiểm, phát hành bản mình đã duyệt | Duyệt bản mình lập hoặc mình kiểm; phát hành bản người khác duyệt |
| Người giao | Toàn tenant (`rpt.deliver`, `rpt.answer`) | Ghi việc giao và câu trả lời của bên nhận | Ghi bên nhận đã nhận bản mẫu demo |
| Người đọc | Toàn tenant (`rpt.read`) | Xem danh mục, bản nháp, bản đã phát hành, nhật ký, tải tệp | Mọi thao tác ghi |
Báo cáo là tài liệu của cả tổ chức: mọi thao tác cần quyền trên toàn tenant (quyền cấp theo cây đơn vị bị từ chối `SCOPE_DENIED`).

## 3. Luồng nghiệp vụ (mỗi luồng trọng yếu)
**L1 Lập và phát hành:** (1) RPT-01 chọn biểu mẫu và kỳ, `generateReport`; (2) hệ thống đăng ký phiên bản biểu mẫu cho tenant lần đầu dùng, đọc số, điền mẫu Excel (và Word), lưu tệp theo mã băm, ghi bản nháp; (3) RPT-02 xem trước và các ô thiếu số; (4) `checkReport` rồi `approveReport` rồi `issueReport` do ba người khác nhau; (5) bản đã phát hành hiện ở RPT-03.
- Lập lại cùng số liệu: bản nháp đang mở trùng nội dung trả `EXISTING`; trùng đúng bản đang hiệu lực trả `DUPLICATE`, không tạo gì.
- Số liệu khác bản đã phát hành: phải có lý do (`422 VALIDATION_FAILED`, `reason`); bản mới là phiên bản n+1, nêu bản bị thay.
- Bản nháp lập trước khi chuỗi tiến lên: phát hành bị từ chối `409 REPORT_OUT_OF_DATE` kèm `current_revision`.
**L2 Giao và nhận:** `deliverReport` ghi lần giao cho một bên nhận qua một kênh; bản đã bị thay bị từ chối `REPORT_OUT_OF_DATE`; giao lại cùng bản cho cùng bên nhận `409 ALREADY_DELIVERED`; `answerReportDelivery` ghi nhận hoặc trả lại; bản mẫu demo không được ghi nhận (`409 TEMPLATE_UNCONFIRMED`, `demo_not_acceptable`).
**Xử lý đồng thời:** mỗi chuỗi (tổ chức, biểu mẫu, kỳ) bị khóa tư vấn khi phát hành và giao; khóa duy nhất (tổ chức, biểu mẫu, kỳ, phiên bản) là lời cuối; người đến sau thấy `REPORT_OUT_OF_DATE` hoặc `ALREADY_DELIVERED`.
Màn hình: RPT-01 → RPT-02 → RPT-03 → RPT-04. Chế độ demo (R18): biến môi trường `DEMO_FORMS`, sau đó quy tắc `REPORT_FORM_MODE`, mặc định tắt; giá trị lạ bị từ chối.

## 4. State machine
```
 DRAFT ──check──► CHECKED ──approve──► APPROVED ──issue──► ISSUED (bản phát hành, bất biến)
```
| Từ | Command | Đến | Ai được làm | Guard | Audit/Event |
|---|---|---|---|---|---|
| (chưa có) | generateReport | DRAFT | `rpt.generate` | biểu mẫu phát hành được; kỳ đúng loại; có lý do nếu thay bản đã phát hành | `rpt.report_generated` / `rpt.report.generated.v1` |
| DRAFT | checkReport | CHECKED | `rpt.check` | người kiểm khác người lập; đúng phiên bản (If-Match) | `rpt.report_checked` / `rpt.report.checked.v1` |
| CHECKED | approveReport | APPROVED | `rpt.approve` | người duyệt khác người lập và người kiểm | `rpt.report_approved` / `rpt.report.approved.v1` |
| APPROVED | issueReport | ISSUED | `rpt.issue` | người phát hành là người duyệt; chuỗi chưa tiến lên; chế độ demo còn bật nếu là mẫu demo | `rpt.report_issued` / `rpt.report.issued.v1` |
Chuyển bị cấm: nhảy bước, lùi bước, sửa bản đã phát hành (`REPORT_STATE_INVALID` 409); tự kiểm hoặc tự duyệt (`SELF_APPROVAL_DENIED` 403). "Bị thay" không phải một cột: bản có phiên bản lớn nhất của chuỗi là bản hiệu lực, các bản trước bị thay theo suy diễn.

## 5. Quy tắc nghiệp vụ và công thức
- **BR-RPT-01:** mỗi ô của biểu mẫu là chữ cố định, sự kiện của báo cáo, chỉ tiêu của sổ chỉ tiêu theo cơ sở kỳ, trường của dòng, tổng hoặc công thức; không có số thì ô để trống kèm lý do, không bao giờ là 0.
- **BR-RPT-02 (R17):** mã băm của bản = SHA-256 của dòng `FORMAT:sha256` của từng tệp theo thứ tự XLSX, DOCX; cùng tệp cho cùng mã băm.
- **BR-RPT-03 (R17):** khóa phát hành là (tổ chức, biểu mẫu, kỳ, phiên bản); bản sửa nêu `supersedes` và lý do 10–2000 ký tự; bản mang mã bản chụp DIS và phiên bản của bản chụp.
- **BR-RPT-04 (R18):** biểu mẫu `DEMO` hiện `MẪU DEMO — chờ mẫu chính thức` ở ô đầu, đầu và chân trang in, thuộc tính tệp và siêu dữ liệu của bản; không bao giờ `READY`, không bao giờ tính là đã nhận (`counts_as_accepted = false`); biểu mẫu chính thức là phiên bản MỚI có `form_ref`.
- **BR-RPT-05:** tệp tải về luôn được kiểm lại mã băm (`HASH_MISMATCH` nếu lệch); tệp là bytes đã phát hành.
- **BR-RPT-06:** chỉ tiêu chưa được chứng nhận hoặc định nghĩa chưa kiểm chứng vẫn hiện nhưng cờ đi kèm trong danh sách ô thiếu số/cảnh báo của bản.

## 6. Dữ liệu
| Bảng | Nội dung | Bất biến |
|---|---|---|
| `report_template_file` | mẫu Excel/Word theo `sha256` | chỉ thêm; mã băm do ràng buộc kiểm |
| `report_output_file` | tệp do bộ ghi tạo, theo `sha256` | chỉ thêm; mã băm do ràng buộc kiểm |
| `report_layout` | phiên bản biểu mẫu đăng ký cho tenant (bố cục JSON, trạng thái, bản, bên nhận) | chỉ thêm; DEMO không có `form_ref`, nguồn minh họa |
| `report_draft` | bản nháp đi qua DRAFT/CHECKED/APPROVED/ISSUED | trigger giữ thứ tự và ba người khác nhau; ISSUED đóng băng |
| `report_issue` | bản đã phát hành | chỉ chèn (trigger từ chối UPDATE/DELETE, quyền ứng dụng không có); trigger kiểm dòng dõi và nguồn từ bản nháp đã duyệt |
| `report_delivery` | nhật ký giao/nhận | chỉ thêm; trigger từ chối ACCEPTED cho bản demo |
Tất cả có `tenant_id`, RLS bắt buộc, chỉ mục dẫn đầu bằng `tenant_id`. Phân loại INTERNAL. Giữ vô thời hạn theo chính sách lưu trữ hồ sơ báo cáo [GIẢ ĐỊNH].

## 7. API / command
| operationId | Method path | Quyền | Lỗi |
|---|---|---|---|
| listReportCatalogue | GET /report-engine/catalogue | rpt.read | — |
| listReportDrafts, getReportDraft, getReportDraftFile | GET /report-engine/drafts[/{id}[/files/{format}]] | rpt.read | RESOURCE_NOT_FOUND, HASH_MISMATCH |
| generateReport | POST /report-engine/drafts | rpt.generate | VALIDATION_FAILED, TEMPLATE_UNCONFIRMED, SCOPE_DENIED |
| checkReport, approveReport | POST /report-engine/drafts/{id}/check, /approve | rpt.check, rpt.approve | REPORT_STATE_INVALID, SELF_APPROVAL_DENIED, VERSION_CONFLICT |
| issueReport | POST /report-engine/drafts/{id}/issue | rpt.issue | + REPORT_OUT_OF_DATE, TEMPLATE_UNCONFIRMED |
| listReportIssues, getReportIssue, getReportIssueFile | GET /report-engine/issues[/{id}[/files/{format}]] | rpt.read | HASH_MISMATCH |
| deliverReport | POST /report-engine/issues/{id}/deliveries | rpt.deliver | REPORT_OUT_OF_DATE, ALREADY_DELIVERED |
| answerReportDelivery | POST /report-engine/issues/{id}/answers | rpt.answer | REPORT_STATE_INVALID, TEMPLATE_UNCONFIRMED |
| listReportDeliveries | GET /report-engine/deliveries | rpt.read | — |
Đường dẫn dùng tiền tố `/report-engine` để không đụng `/reports/{id}` của DIS. Tệp trả dạng JSON base64 kèm mã băm (không dùng liên kết ký). Mọi lệnh ghi có Idempotency-Key; check/approve/issue cần If-Match. Không có endpoint ghi chung cho trạng thái, người ký hay mã băm.

## 8. UI/UX
RPT-01 danh mục (bảng, nút lập, hộp thoại chọn kỳ); RPT-02 bản nháp (xem trước từng ô, ô thiếu số, ba bước, người ký, tệp); RPT-03 bản đã phát hành (mã băm đầy đủ, chuỗi phiên bản, giao và trả lời); RPT-04 nhật ký giao. Bảy trạng thái chuẩn trên mỗi màn hình. Nhãn mẫu demo luôn thấy được, không chỉ ở chú thích. Tên từ chuyên ngành dùng khóa i18n riêng của phân hệ.

## 9. Sự kiện, job, tích hợp, quan sát
Sự kiện `rpt.report.generated|checked|approved|issued|delivered|answered.v1` mang mã, mã băm và người thực hiện, không mang tên người hay số tiền. Không có job nền. Bộ cung cấp số liệu (`ReportFigureProvider`): `DIS_HOME` cho bản công khai; FND-1 đăng ký bộ của mình để biểu mẫu doanh nghiệp chuyển từ số minh họa sang số thật. Mọi lệnh có dòng audit (kể cả lập lại không tạo mới).

## 10. Kiểm thử
| ID | Loại | Nội dung |
|---|---|---|
| `apps/api/test/reports/report-engine.test.ts` | integration | lập từ bản chụp, ba người, dòng dõi, bản lỗi thời, giao một lần, bất biến ở DB, cách ly tenant |
| `apps/api/test/reports/report-engine.enterprise.test.ts` | integration | sáu biểu mẫu demo, nhãn trong tệp, chế độ demo, không bao giờ được nhận |
| `packages/kernel/test/report-form.test.ts` | domain | mã băm của bản, kỳ đúng loại, xem trước |
| `apps/api/test/isolation/*`, `authz/negative-matrix` | security | ca id ngoại lai và ma trận từ chối cho mọi thao tác |
| `apps/web/src/screens/rpt/*.test.tsx` | UI | bảy trạng thái, luồng ba vai, nhãn demo |

## 11. Tiêu chí nghiệm thu (đo được)
- **AC-RPT-01:** Given ba người có đúng quyền, When người lập lập, người kiểm kiểm, người duyệt duyệt và phát hành, Then có đúng một bản phiên bản 1 với mã băm bằng mã băm của tệp tải về. Test `report-engine.test.ts`.
- **AC-RPT-02:** Given người lập tự kiểm hoặc người kiểm tự duyệt, Then `403 SELF_APPROVAL_DENIED` và không có thay đổi.
- **AC-RPT-03:** Given bản phiên bản 1 đã phát hành và số liệu đổi, When lập không lý do Then `422`; có lý do Then phiên bản 2 nêu phiên bản 1; giao phiên bản 1 Then `409 REPORT_OUT_OF_DATE`.
- **AC-RPT-04:** Given một bản đã giao cho một bên nhận, When giao lại cùng bản cho bên đó Then `409 ALREADY_DELIVERED`.
- **AC-RPT-05:** Given biểu mẫu demo và chế độ demo tắt, Then không lập, không phát hành được; bật thì mọi tệp mang nhãn và bản không bao giờ được ghi là đã nhận, kể cả khi chèn thẳng vào cơ sở dữ liệu.
- **AC-RPT-06:** Given màn hình RPT-01…04 ở 1440 px và 390 px, When ép từng trạng thái trong bảy trạng thái, Then mỗi trạng thái hiện đủ, 0 lỗi console, không cuộn ngang ở 1440 px.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+
R1 dùng thật: biểu mẫu tuần giải ngân công khai, luồng ba người, bản bất biến, giao và nhận ghi tay. R2+: số doanh nghiệp thật từ FND-1, biểu mẫu chính thức thay mẫu demo (phiên bản mới, file mẫu của khách, test vàng với file của khách, chủ sở hữu xác nhận trước khi `READY`), kênh đẩy ENT-2, xuất PDF, đăng ký biểu mẫu do tenant tải lên. Hạng mục bắt buộc người duyệt: mọi biểu mẫu chính thức, quy tắc đặt tên tệp, bất kỳ chuyển DEMO → bản chính thức.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba
- Mẫu chính thức của PVFCCo chưa có (owner: Ban KHĐT; điều kiện: nhận file Excel, Word và xác nhận khớp) — mọi bản làm từ mẫu demo là PENDING-EXTERNAL và không được nghiệm thu (R18).
- Ngữ nghĩa số liệu doanh nghiệp (owner: chủ sở hữu FND-1; điều kiện: đặc tả R15 được duyệt) — các mã `ENT_*` đều "chưa kiểm chứng".
- Thư viện `exceljs` ít cập nhật (owner: kỹ thuật; điều kiện: xem lại khi có advisory mức high).
- Công thức tham chiếu sang sheet khác không được viết lại khi chèn dòng (giới hạn đã biết).


## Làn GOV-12: báo cáo kỳ gửi Bộ Tài chính, chữ ký số, khóa kỳ (G4-6)

Bốn mẫu `MOF-DIS-WEEKLY`, `MOF-DIS-MONTHLY`, `MOF-DIS-QUARTERLY`, `MOF-DIS-YEARLY` dựng trên bộ máy báo cáo RPT-1, trạng thái PENDING_EXTERNAL (chờ biểu mẫu chính thức của Bộ Tài chính): soạn và xem được, không phát hành được; số liệu lấy từ bản chụp đã chốt tại cuối kỳ. Người duyệt bản phát hành ký số mã băm của bản qua cổng ký của DOC bằng chứng thư cá nhân của mình; chữ ký của nhà cung cấp thử không được tính khi gửi Bộ Tài chính. Kỳ bị khóa khi bản được ký thật (hoặc được nhận, theo quy tắc `PERIOD_REPORT_RULE`); kỳ khóa không nhận bản mới (`PERIOD_LOCKED`); mở khóa cần người thứ hai và lý do. Màn hình RPT-05 và RPT-06.
