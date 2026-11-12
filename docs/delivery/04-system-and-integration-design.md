# 04. Tài liệu thiết kế hệ thống và chỉ mục thiết kế tích hợp

Giai đoạn 2, sản phẩm 3 của mục II.5 (tài liệu thiết kế hệ thống; thiết kế tích hợp HPM/ERP/Lakehouse). Dòng ma trận: GD.2, SP.03. Mã yêu cầu: TH.01 đến TH.03, HT.01, HT.05, HT.06, YCK.01, YCK.02, YCK.04 đến YCK.08, TK.02. PVFCCo phê duyệt: có (khi trình cùng SRS).

Tệp này là chỉ mục có trích yếu: mỗi mục nêu điều đã thiết kế và đã xây, kèm tệp nguồn để đọc chi tiết. Không chép lại tài liệu kỹ thuật. Điều chưa biết vì chờ khách ghi PENDING-EXTERNAL và mã PX-nn của sổ ([11](11-pending-external-register.md)).

Trạng thái tệp (v0.2, 2026-11-12): đã điền từ thiết kế và mã nguồn đến ngày 2026-11-12, sau khi các làn ENT-3a đến ENT-4e, INFRA-2 và DOC-3 gộp vào nhánh chính; mọi đường dẫn nêu ở đây đã được kiểm là tồn tại. Đề xuất phương thức tích hợp HPM (đích API, cầu nối tệp chuẩn, DB trung gian chỉ là phương án cuối) đã viết ở `docs/integration/hpm-proposal.md`, mô hình Power BI và Lakehouse ở `docs/integration/power-bi-model.md`, cấu hình khuyến nghị ở `docs/runbooks/infra/sizing-uat-prod.md`, hướng dẫn quản trị ở `docs/admin-guide.md` và hướng dẫn trên màn hình ở `apps/web/src/help/help.vi.json`. Còn chờ khách: cấu trúc và khả năng của HPM (PX-03), mẫu tệp và quyền đọc EBS (PX-04), eProcurement và văn thư (PX-06, PX-07), hạ tầng và thông tin AD, SMTP, Teams (PX-11, PX-16), số người dùng (PX-17), phê duyệt (PX-12). Các thiết kế dựa trên giả định ghi nhãn rõ giả định.

---

## 1. Kiến trúc hệ thống

Nguồn: `Design/MACHVON_Design/01_Documents/04_Thiet_ke_co_ban.md` (kiến trúc mục tiêu, ranh giới dữ liệu, thành phần, triển khai), `05_Thiet_ke_chi_tiet.md`.

| Lớp | Lựa chọn thiết kế | Ghi chú |
|---|---|---|
| Backend | TypeScript, NestJS modular monolith | OpenAPI là hợp đồng nguồn: `Design/MACHVON_Design/03_Engineering/openapi.json` |
| Web | React và TypeScript (Vite) | Màn hình theo `screen_catalog.json`; ứng dụng cài được cho quản lý (PWA, `docs/pwa.md`) |
| Cơ sở dữ liệu | PostgreSQL 16 trở lên (gói cài đặt ngoại tuyến dùng PostgreSQL 18, `infra/onprem/images.json`) | Cách ly theo tenant bằng row-level security bật và ép buộc; bản sao đọc cho BI |
| Danh tính | Keycloak, OIDC, MFA, liên kết AD | `docs/runbooks/infra/keycloak.md`, `docs/security/identity-test-plan.md` |
| Điều phối | Cơ chế quy trình duyệt trong cơ sở dữ liệu; Temporal là phương án chạy tiếp quản | `docs/adm-approval-workflow.md` |
| Sự kiện | Transactional outbox, inbox, idempotency key, If-Match | TKCB mục command, outbox, inbox |
| Tệp | Kho đối tượng tương thích S3; quét mã độc bằng ClamAV (`apps/api/src/modules/files/clamd-scan.ts`) trước khi liên kết, tệp chưa quét ở trạng thái chờ và không liên kết hay tải xuống được | `docs/runbooks/infra/object-storage.md`, `docs/runbooks/infra/malware-scan.md` |
| Quan sát | OpenTelemetry, cảnh báo có chủ và runbook | `docs/runbooks/infra/observability.md`, `docs/slo-error-budget.md` |
| Gói cài đặt | Docker compose ngoại tuyến cho một hoặc hai máy chủ, ảnh đóng sẵn amd64 và arm64, tệp tổng kiểm, SBOM, script cài và quay lui | `infra/onprem/compose/compose.yaml`, `scripts/onprem-bundle.mjs`, `docs/runbooks/infra/onprem-install.md` |
| Hướng dẫn trên màn hình | Ngăn trợ giúp mở từ nút dấu hỏi ở thanh trên hoặc phím `?`; một mục cho mỗi màn web (594 màn), sinh từ danh mục màn hình và các hành trình hướng dẫn, tải khi mở lần đầu; kiểm bằng `node scripts/help-index.mjs check` | `scripts/help-index.mjs`, `apps/web/src/help/help.vi.json`, `apps/web/src/shell/HelpDrawer.tsx` |

Bản enterprise tách khỏi bản công: mã riêng của PVFCCo nằm ở `packages/edition-enterprise`, nạp qua một điểm nối duy nhất; bản công không chứa mã đó (`npm run edition:check`). HPM và EBS chỉ có ở bản enterprise (`docs/hpm-ebs-connectors.md`).

### 1.1 Mô hình dữ liệu và nơi nhập một lần (DL.01, MD.01)

| Khái niệm | Nơi lưu | Tài liệu |
|---|---|---|
| Dự án, danh mục, mã ngoài hệ thống | `project`, `master_record`, `master_crosswalk` | `docs/prj-national-code-file.md`, `docs/mdm-catalogue-dictionary.md` |
| Kế hoạch vốn, phiên bản điều chỉnh | CAP | `docs/capital-balances.md`, `docs/cap-ledger.md` |
| Số liệu vốn theo kỳ: kế hoạch phân kỳ, số ước, số thực, điều chỉnh | FND-1: `plan_figure_revision` | `docs/fnd-funding-model.md` |
| Số liệu chỉ tiêu nhập và qua tệp | IND-1: `ind_figure` (chỉ thêm, không sửa) | `docs/ind-indicator-dictionary.md` |
| Bản chốt kỳ | `period_snapshot` (băm SHA-256, đóng băng) | `docs/dis-snapshot.md` |
| Biểu mẫu đã phát hành | RPT-1: bản phát hành bất biến có mã băm; Excel, Word và PDF dựng từ một mô hình tài liệu; mã băm bố cục `layout_sha256` | `docs/report-engine.md` |
| Số liệu đã chốt của bản enterprise | `period_snapshot_figure` (số liệu vốn) và `period_snapshot_indicator` (chỉ tiêu), băm schema 2, V2660; dựng và chốt bởi hai người; dựng lại chỉ sau kỳ mở lại đã duyệt | `docs/fnd-funding-model.md`, `packages/kernel/src/enterprise-snapshot.ts`, `packages/db/src/enterprise-snapshot-store.ts` |
| Thuyết minh có cấu trúc | `report_narrative`: khối tám trường theo gói, mã nguyên nhân chuẩn, tham chiếu chỉ đạo giao ban, dấu vết kế thừa kỳ trước; nằm trong băm của bản nháp | `packages/kernel/src/ent-narrative.ts`, `docs/plans/ent3b.md` |
| Số liệu của mỗi bản nháp để so sánh chéo | `report_figure_set`: chỉ thêm, băm; cổng so sánh chéo ở `issueReport`; `report_crosscheck_explanation` chỉ thêm | `docs/report-engine.md` (mục so sánh chéo), `packages/kernel/src/report-crosscheck.ts` |

Một đường đọc: biểu mẫu, dashboard, gói HPM và đối chiếu EBS cùng đọc bản chốt, không đọc thẳng bảng gốc (quyết định kỹ thuật R21). Đường đọc đã có: bản chốt doanh nghiệp (dựng ở DIS-32, chốt ở DIS-33) và bộ đọc duy nhất `EnterpriseFigureReader`; sáu biểu mẫu (`apps/api/src/editions/enterprise/snapshot-provider.ts`), bảng lãnh đạo (`getLeaderRates`) và gói HPM đọc qua bộ đọc đó. Kỳ chưa có bản chốt thì sáu biểu mẫu chạy dữ liệu minh họa và mang nhãn MẪU DEMO; bản chốt chỉ dựng khi mọi ô kế hoạch đã có số thực.

## 2. Thiết kế bảo mật và vận hành (YCK.06, YCK.07, HT.01, HT.06)

| Chủ đề | Thiết kế | Nguồn |
|---|---|---|
| Cách ly và phân quyền | Quyền theo hành động, phạm vi theo đơn vị, dự án, kỳ; tách nhiệm vụ | `docs/adm-doa-resolver.md`, ADM-24 |
| Xác thực | SSO, MFA, khóa tài khoản, phiên; realm Keycloak nhập được, kiểm cấu trúc offline | `docs/security/identity-test-plan.md`, `docs/runbooks/infra/lab-install-checklist.md` |
| Mã hóa, tiêu đề an toàn | TLS 1.2 trở lên, tiêu đề bảo mật | `docs/runbooks/infra/tls-headers.md` |
| Bí mật | Xoay vòng, không có trong repo | `docs/runbooks/infra/secrets-rotation.md` |
| Chuỗi cung ứng | SBOM, quét phụ thuộc và image | `docs/runbooks/supply-chain.md`, `docs/runbooks/infra/security-scanning.md` |
| Nhật ký kiểm toán | Chuỗi băm có niêm phong, xuất có chữ ký băm; giá trị đủ trước và sau theo loại đối tượng, mặc định tắt (ADM-29, HT.06); giới hạn dòng và dung lượng log, lưu trữ có băm trước khi xóa, không bao giờ xóa nhật ký kiểm toán (ADM-30) | `docs/runbooks/audit-export.md`, `docs/runbooks/audit-tamper-drill.md`, `docs/runbooks/retention.md` |
| Sao lưu | Đầy đủ hằng ngày, gia tăng mỗi 4 giờ, khác biệt hằng tuần, đầy đủ hằng tháng vào kho lưu trữ riêng, giữ tối thiểu 03 bản, khóa bất biến, bản ngoại tuyến; sao lưu thủ công là yêu cầu của một người, duyệt bởi người khác, chạy bởi máy chủ (ADM-32); diễn tập khôi phục có sổ chứng cứ | `infra/backup/backup-policy.json`, `docs/runbooks/infra/backup-immutable.md`, `docs/runbooks/infra/restore-drill.md` |
| Quét mã độc, đường ra, ransomware | Tệp chỉ CLEAN sau khi clamd quét; đường ra chỉ cho db, backup, keycloak tới kho đối tượng và máy chủ thư mục, còn lại bị chặn; danh mục kịch bản ransomware có kiểm soát và ca kiểm tra | `docs/runbooks/infra/malware-scan.md`, `docs/security/ransomware-scenarios.md` |
| Sẵn sàng pentest | Phạm vi, quy tắc, OWASP Top 10, API Top 10, ASVS mức 2 | `docs/security/pentest-readiness.md` |
| Cài đặt tại chỗ | Gói ngoại tuyến, yêu cầu máy chủ, nâng cấp và quay lui | `docs/runbooks/infra/onprem-install.md`, `docs/runbooks/infra/onprem-upgrade-rollback.md` |
| Quét mã nguồn và phụ thuộc | CodeQL, quét bí mật, quét phụ thuộc và ảnh, DAST (ZAP baseline) chạy khi đã khai báo địa chỉ đích | `docs/runbooks/infra/security-scanning.md` |

Đã xây ở INFRA-2 (kiểm bằng quy tắc tĩnh và máy chủ giả, chưa chạy trên máy thật): chu kỳ sao lưu tuần và tháng, bản khác biệt, giữ tối thiểu 03 bản, bản ngoại tuyến, yêu cầu sao lưu thủ công, quét mã độc tệp tải lên qua clamd, kiểm thử danh sách cho phép đường ra, kịch bản ransomware trong gói pentest, kiểm cấu trúc realm Keycloak. Còn thiếu hoặc chờ khách: biên bản diễn tập khôi phục (sổ `infra/backup/restore-drill-ledger.json` còn trống, cần máy sạch ở site 2, PX-11); pentest và rà soát mã nguồn độc lập (PX-09); nhập thử realm Keycloak trên máy thật (PX-16); ClamAV không nằm trong bộ compose (ảnh không chốt được bản băm offline), vận hành viên cấp clamd theo `docs/runbooks/infra/malware-scan.md`.

## 3. Thiết kế tích hợp

### 3.1 Khung tích hợp chung

Mọi kết nối ngoài dùng chung Integration Hub (`docs/integration-hub.md`): mô tả bộ kết nối bằng một tệp, mô hình sức khỏe và cảnh báo, giao thức truyền (tệp, webhook ký HMAC, HTTPS, SOAP, SFTP, đọc DB một chiều, hàng đợi, hộp thư), quy tắc không ra ngoài khi chưa được tenant duyệt, đường ETL năm bước (trích, kiểm, biến đổi theo ánh xạ có phiên bản và người duyệt, nạp idempotent, chặn lỗi), nhật ký chạy chỉ thêm. Nhập tệp từ hệ thống ngoài đi qua khung nhập tệp idempotent (`docs/file-import.md`): băm tệp, khóa nghiệp vụ từng dòng, cách ly dòng lỗi, mục đối chiếu có chủ và hạn.

### 3.2 HPM (TH.01)

| Mục | Thiết kế | Tình trạng |
|---|---|---|
| Cổng giao tiếp | `HpmPort`; bộ ghi tệp `HpmFileWriter` thay được bằng bộ chuyển tiếp API mà không đổi gì khác | Có; đặc tả HPM chờ (PX-03) |
| Khóa đẩy | tổ chức, biểu mẫu, kỳ, phiên bản; trùng khóa khác nội dung là `HPM_KEY_REUSED`; thử lại cùng khóa | Có |
| Thứ tự phiên bản | Bản cũ hơn bản đã phát hành hoặc đã được HPM nhận bị từ chối (`REPORT_OUT_OF_DATE`) | Có |
| Ghi đè kỳ đã nhận | Cần kỳ mở lại đã duyệt và đính chính do hai người đề nghị và duyệt | Có (HPM-02) |
| Biên nhận | Người ghi biên nhận khác người đẩy; bản DEMO không bao giờ được nhận | Có |
| Điều chỉnh ở kỳ sau | Cách thứ hai theo hồ sơ kỹ thuật: `proposeHpmCorrection` với `mode: ADJUST_NEXT_PERIOD`, người khác quyết định, số có dấu ghi vào kỳ kế tiếp, nhật ký chỉ thêm (`hpm_adjustment`, V2702) | Có (ENT-3c) |
| Bước PUSH của quy trình gọi đẩy, trạng thái chờ biên nhận | `HpmApprovalPush` đẩy theo khóa, bước giữ ở `AWAITING_RECEIPT` (`approval_step_hold`, V2700) tới khi người khác ghi biên nhận ở HPM-01; không báo "xong" khi HPM chưa nhận (R22) | Có (ENT-3c) |
| Mã dự án HPM theo từng dự án | Hàng của `master_crosswalk` (INT-03); bản kê của gói liệt kê mã HPM của từng dự án và cách tìm ra (`CROSSWALK` hay `DIRECT`) | Có (ENT-3e); mã thật chờ PX-14 |
| Phân loại lỗi và thử lại | Tạm thời, hết lượt, bị từ chối do dữ liệu, trùng, quá cũ, mẫu chưa xác nhận, lâu không có lần giao; tự thử lại có lùi dần chỉ là đề xuất (cần bộ chuyển tiếp API) | Quy tắc có; xem `docs/integration/hpm-proposal.md` mục 6 |
| Màn hình | HPM-01 (kết nối, nhật ký, đẩy lại, biên nhận), HPM-02 (đính chính) | Có |
| Cảnh báo | `HPM_PUSH_FAILED`, `HPM_PUSH_STALE` | Có |
| Phương thức tích hợp đề xuất | Quyết định đề xuất: đích là API, cầu nối ngay là tệp chuẩn (dùng được không chờ HPM, cùng cổng `HpmPort`, chuyển sang API chỉ đổi bộ chuyển tiếp), cơ sở dữ liệu trung gian chỉ khi hai cách kia không dùng được (tăng bề mặt tấn công, trái nguyên tắc quyền tối thiểu); lộ trình G0 đến G4; 14 thông tin cần Ban CĐS&CNTT cung cấp; quy tắc ghi đè hay điều chỉnh ở kỳ sau | Có `docs/integration/hpm-proposal.md`; là đề xuất, chờ PX-03 |

Nguồn: `docs/hpm-ebs-connectors.md` mục 2 và mục 6; `docs/integration/hpm-proposal.md`; `Design/MACHVON_Design/01_Documents/05_modules/HPM.md`.

### 3.3 Oracle EBS (TH.03, CN.04)

| Mục | Thiết kế | Tình trạng |
|---|---|---|
| Nhập | Chạy thử không ghi, áp dụng một lần theo băm tệp, bản ghi chỉ thêm | Có; bố cục giả định WORKING-ASSUMPTION-2026.1 (PX-04) |
| Đối chiếu | Theo mã dự án và kỳ, chính xác đến đồng, giải ngân lũy kế và cam kết | Có (EBS-02) |
| Mục chênh lệch | Chủ không là người nạp tệp hay người chạy đối chiếu; hạn theo ngày làm việc; giải trình `OURS_WRONG`, `EBS_WRONG`, `TIMING`, `WAIVED` | Có |
| Qua `master_crosswalk` | Mã EBS của dự án đọc qua ánh xạ ACTIVE hiệu lực trong ngày trước; so khớp thẳng mã dự án giữ làm dự phòng một phiên bản (`DIRECT_MATCH_FALLBACK`); ánh xạ trùng mã của dự án khác bị từ chối (409 `CROSSWALK_DUPLICATE`) | Có (ENT-3e); mã thật chờ PX-14 |
| Đọc trực tiếp DB | Giao thức `DB_READ` của hub có sẵn (chỉ SELECT) | Chưa nối EBS (PX-04) |

Nguồn: `docs/hpm-ebs-connectors.md` mục 3; `05_modules/EBS.md`.

### 3.4 Data Lakehouse và Power BI (TH.02)

| Đường | Thiết kế | Nguồn |
|---|---|---|
| API mở `/open/v1` | Tài khoản máy có phạm vi; token 5 phút; tập dữ liệu đã chứng nhận (giải ngân từ bản chốt, hợp đồng); mọi lần đọc ghi nhật ký; tài liệu `docs/open-api/openapi.json` | `docs/open-api.md` mục 2 |
| Đăng nhập DB cho BI | Đăng nhập chỉ đọc gắn một tenant bằng tên; vòng đời đăng nhập có nhật ký | `docs/open-api.md` mục 4 |
| Tập dữ liệu chứng nhận | Phiên bản theo kỳ từ bản chốt đóng băng, có điểm chất lượng | `docs/bi-datasets.md`, `docs/bi-policies.md` |
| Mô hình Power BI mẫu và hướng dẫn nối | Hai con đường (tài khoản BI chỉ-đọc, API mở), các view `machvon_bi` (`v_dataset_catalogue`, `v_disbursement_lines`, `v_contract_lines`), mô hình sao đề xuất, phép đo DAX mẫu, truy vấn mẫu, tệp `.pbids` không chứa bí mật; chế độ Import theo nhịp đóng kỳ | `docs/integration/power-bi-model.md`, `docs/integration/machvon-bi.pbids`, `docs/integration/power-bi-sample-queries.sql` |
| Data Lakehouse | Sao chép từng kỳ vào vùng thô bằng tài khoản BI riêng cho mỗi ứng dụng đọc; nạp theo kiểu thay cả kỳ (khóa `period_id`) vì bản chốt cũ chuyển sang đã bị thay thế; không xóa vùng thô khi nguồn trả rỗng | `docs/integration/power-bi-model.md` mục 7; cách Lakehouse nhận chờ PX-11 |
| Số liệu bản chốt doanh nghiệp cho BI | Chưa có tập dữ liệu chứng nhận cho số liệu vốn và chỉ tiêu của bản chốt doanh nghiệp (hiện chỉ có giải ngân và hợp đồng); đọc qua `getEnterpriseSnapshot` và `getLeaderRates` của bản enterprise | Còn thiếu; cần một tập dữ liệu chứng nhận, không đọc thẳng bảng nghiệp vụ |

Màn hình: INT-01 đến INT-05. Không phát sinh phí bản quyền khi tích hợp: không có giới hạn theo số người dùng hoặc số kết nối ở bản enterprise.

### 3.5 eProcurement, văn thư, xác thực tập trung (TH.03)

| Hệ thống | Thiết kế sẵn có | Chờ |
|---|---|---|
| eProcurement | Khung nhập tệp và hub; bộ kết nối e-GP của bản công là mẫu (`docs/egp-connector.md`); màn EQP-01, EQP-02 đọc từ gói thầu, hợp đồng, thanh toán và hiển thị trạng thái nhập tệp e-GP, ẩn số hợp đồng và thanh toán khi người xem không có quyền (`docs/plans/ent4e.md`) | Đặc tả dữ liệu mua sắm trang thiết bị dự án (PX-06) |
| Hệ thống văn thư | Tệp đính kèm hồ sơ pháp lý; phân hệ DOC của nền tảng (`docs/doc-interop.md`) | Đặc tả kết nối (PX-07) |
| Xác thực tập trung | Keycloak liên kết AD, ánh xạ nhóm AD sang vai trò; nhóm theo đơn vị và vai trò của gói ORG-01 sinh ra từ gói mẫu (`infra/keycloak/onprem/ad-group-role-map.json`, `tenantMappings`) | Thông tin AD (PX-16) |

### 3.6 Bản đồ mã dự án giữa các hệ thống (MD.01)

`master_crosswalk` (INT-03) ánh xạ mã ngoài và bản ghi chủ cho từng hệ thống nguồn; đề xuất và duyệt bởi hai người (`proposeProjectCode`, `decideProjectCode`). Bảng mã HPM, mã EBS của 22 + 01 + 09 hạng mục là dữ liệu của khách (PX-14). Đối chiếu EBS và gói HPM đã đọc mã qua crosswalk theo kiểu mở rộng rồi thu (R25, `docs/hpm-ebs-connectors.md` mục 3.1, `packages/edition-enterprise/src/integration/project-code-resolver.ts`); bước thu (bỏ so khớp thẳng) làm ở phiên bản sau, khi bảng độ phủ trên INT-03 không còn dự án phụ thuộc so khớp thẳng và không còn xung đột. Màn INT-03 cho số dự án đã ánh xạ, đang chờ và xung đột.

### 3.7 Email, Teams và gửi biểu mẫu theo lịch (QT.02, YCK.01, BC.02)

| Mục | Thiết kế | Tình trạng |
|---|---|---|
| Email | Bộ gửi SMTP viết bằng thư viện chuẩn của Node (`apps/api/src/notifications/delivery/smtp-adapter.ts`), cấu hình bằng biến môi trường; phân loại mã trả lời (4xx thử lại, 5xx dừng, mất trả lời sau DATA là chưa rõ); ở môi trường thật ở trạng thái đề xuất cho tới khi vận hành viên đặt `MACHVON_SMTP_VERIFIED=true` | Có, kiểm với máy chủ SMTP giả; relay thật chờ PX-16 |
| Teams | Bộ gửi tới incoming webhook (`apps/api/src/notifications/delivery/teams-webhook-adapter.ts`): chỉ https, máy chủ trong danh sách cho phép, không theo chuyển hướng, thời gian chờ 10 giây; hoặc relay của vận hành viên | Có, kiểm với máy chủ giả; địa chỉ Teams thật chờ PX-16 |
| Nhắc việc theo lịch kỳ | Bản ghi `reporting_reminder` duy nhất theo (kỳ, đơn vị, bước, loại, số thứ tự), sự kiện `dis.calendar_step.reminded.v1`; tenant chọn kênh bằng quy trình thông báo | Có (`docs/teams-relay.md`) |
| Gửi biểu mẫu đã phát hành theo lịch | Lịch gắn một chuỗi biểu mẫu, cron theo giờ Việt Nam, người nhận là thành viên của tenant (địa chỉ đọc lúc gửi, không lưu), tệp XLSX hoặc PDF kèm băm SHA-256; mỗi (lịch, bản, người nhận) gửi một lần; biểu mẫu DEMO không bao giờ được gửi; nhật ký chỉ thêm | Có (RML-01, `Design/MACHVON_Design/01_Documents/05_modules/RML.md`); gửi thật chờ PX-16 |

## 4. Hiệu năng, năng lực và môi trường (HT.05, YCK.02)

- Ngân sách hiệu năng: `docs/qa/perf-budget.json`, cách chạy `docs/qa/performance.md`; HSKT yêu cầu phản hồi dưới 5 giây, xem báo cáo dưới 20 giây. Đo trên phần cứng của khách: PX-10. Tệp ngân sách có dòng riêng cho đọc bản chốt doanh nghiệp (`PB-R016`), so sánh chéo (`PB-R017`), bảng lịch kỳ và bảng trạng thái nhập liệu (`PB-F068`, `PB-F069`) và PDF biểu mẫu (`PB-R008`); đã đo trên máy phát triển với bộ dữ liệu mẫu nhỏ (`docs/qa/performance.md`), chưa phải số đo nghiệm thu.
- Hai môi trường UAT và Production: `docs/runbooks/infra/environments.md`; cấu hình khuyến nghị cho PVFCCo ở `docs/runbooks/infra/sizing-uat-prod.md` (tóm tắt dưới đây).

| Hạng mục | UAT | Production |
|---|---|---|
| Mô hình | 1 máy chủ, toàn bộ bộ compose | CSDL chính và CSDL dự phòng đồng bộ, 2 máy ứng dụng hoạt động-hoạt động sau bộ cân bằng tải, kho đối tượng bất biến ở site 2 |
| Máy chủ | 8 vCPU, 24 GB, 100 GB hệ thống, 200 GB CSDL (IOPS bền vững tối thiểu 3.000), 300 GB tệp, 500 GB sao lưu | CSDL: mỗi máy 8 vCPU, 32 GB, 500 GB SSD; ứng dụng: mỗi máy 8 vCPU, 16 GB, 100 GB SSD; kho site 2 từ 1 TB, hai bucket; hai bộ ngoại tuyến luân phiên 1 TB |
| Mục tiêu | Nghiệm thu chức năng, đo hiệu năng, diễn tập cài đặt và khôi phục | RPO 15 phút, RTO 4 giờ |

Giả định tải làm căn cứ tính (do nhà cung cấp đặt, chờ PX-17 xác nhận): 09 đầu mối, 150 người dùng có tên, 40 người đồng thời giờ cao điểm (hạn nhập ngày 5), 25 lãnh đạo xem, CSDL 20 GB tăng 10 GB mỗi năm, tệp đính kèm 200 GB tăng 100 GB mỗi năm. Các con số là khuyến nghị xuất phát, phải đo lại trên phần cứng của khách (PX-10, PX-11); trên 100 người đồng thời hoặc CSDL trên 100 GB áp dụng mục 8 của tài liệu đó.
- Cổng phát hành: `docs/runbooks/release-checklist.md`.

### 4.1 Tài liệu quản trị, hướng dẫn và đề xuất tích hợp đi kèm (TK.02, YCK.08)

| Tài liệu | Dành cho | Nội dung |
|---|---|---|
| `docs/admin-guide.md` | Ban CĐS&CNTT, quản trị tổ chức | Mục 0 đến 11: các lớp quản trị, vai trò và quyền, quy tắc quản trị, lịch, danh mục, trung tâm tích hợp, sao lưu và khôi phục, xuất nhật ký kiểm toán, nâng cấp và quay lui, vận hành thường ngày, bảng tra cứu, việc chờ thông tin bên ngoài. Chưa nói tới ADM-29 đến ADM-32, ORG-01, RPT-07 đến RPT-09, RML-01 (cần bổ sung trước khi bàn giao, [10](10-handover-checklist.md)) |
| `apps/web/src/help/help.vi.json` | Người dùng cuối | Hướng dẫn từng màn web (mục đích, vai trò, các bước, quy tắc), mở bằng nút trợ giúp hoặc phím `?`; trung tâm hướng dẫn IAM-08 và bộ hdsd có video là lớp trên |
| `docs/integration/hpm-proposal.md` | Ban CĐS&CNTT, Ban KHĐT | Ba phương thức, so sánh, khuyến nghị, kế hoạch G0 đến G4, thông tin cần cung cấp, quy tắc lỗi và điều chỉnh |
| `docs/integration/power-bi-model.md` | CN QLPTDA, Ban CĐS&CNTT | Mô hình ngữ nghĩa mẫu, an ninh, view, phép đo, làm mới, Lakehouse, hạn chế đã biết |
| `docs/runbooks/infra/sizing-uat-prod.md` | Ban CĐS&CNTT | Cấu hình khuyến nghị UAT và Production |

## 5. Phụ thuộc cần khách trước khi chốt thiết kế

| Mã | Cần | Ảnh hưởng |
|---|---|---|
| PX-03 | Giao diện kỹ thuật HPM | Chọn bộ chuyển tiếp thay bộ ghi tệp; mọi con số về đẩy HPM chưa tính nghiệm thu |
| PX-04 | Mẫu tệp EBS, quyền đọc | Chọn tệp hay đọc DB; ngưỡng chênh lệch |
| PX-06, PX-07 | Đặc tả eProcurement, văn thư | Bộ kết nối chưa dựng |
| PX-11, PX-16 | Hạ tầng và thông tin AD, SMTP, Teams | Cài thử, nhắc việc thật |
| PX-17, PX-10 | Số người dùng; cấu hình phần cứng thật để đo | Cấu hình khuyến nghị đang dựa trên giả định tải của nhà cung cấp; HT.05 chưa chứng minh được |
| PX-14, PX-05 | Danh mục dự án và mã HPM, EBS; danh sách đầu mối và người | Bảng mã crosswalk, gói tổ chức ORG-01 đang là dữ liệu mẫu |
| PX-09 | Đơn vị pentest độc lập | Gói sẵn sàng pentest chưa được kiểm chứng bởi bên thứ ba |

Lịch sử sửa: v0.1 khung ngày 2026-11-09. v0.2 ngày 2026-11-12, rà soát bởi làn aud4: viết lại dòng trạng thái và danh sách mã yêu cầu; thêm vào mục 1 các hàng gói cài đặt, hướng dẫn trên màn hình, số liệu đã chốt của bản enterprise, thuyết minh có cấu trúc, số liệu so sánh chéo; mục 2 thêm nhật ký đủ trước và sau, giới hạn log, sao lưu ba chu kỳ và thủ công, quét mã độc, đường ra, ransomware và danh sách đã xây, còn thiếu của INFRA-2; mục 3.2 đổi ba dòng ENT-3c, DOC-3 thành đã có và thêm mã dự án HPM, phân loại lỗi; mục 3.3 và 3.6 đổi ENT-3e thành đã có; mục 3.4 thêm mô hình Power BI, Lakehouse và khoảng trống tập dữ liệu bản chốt doanh nghiệp; mục 3.5 thêm EQP và ánh xạ nhóm AD; thêm mục 3.7 (email, Teams, gửi biểu mẫu theo lịch), tóm tắt cấu hình khuyến nghị ở mục 4, mục 4.1 (tài liệu đi kèm) và các dòng phụ thuộc mới ở mục 5.
