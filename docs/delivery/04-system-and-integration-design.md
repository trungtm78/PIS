# 04. Tài liệu thiết kế hệ thống và chỉ mục thiết kế tích hợp

Giai đoạn 2, sản phẩm 3 của mục II.5 (tài liệu thiết kế hệ thống; thiết kế tích hợp HPM/ERP/Lakehouse). Dòng ma trận: GD.2, SP.03. Mã yêu cầu: TH.01 đến TH.03, HT.01, HT.05, YCK.02, YCK.04 đến YCK.07. PVFCCo phê duyệt: có (khi trình cùng SRS).

Tệp này là chỉ mục có trích yếu: mỗi mục nêu điều đã thiết kế và đã xây, kèm tệp nguồn để đọc chi tiết. Không chép lại tài liệu kỹ thuật. Điều chưa biết vì chờ khách ghi PENDING-EXTERNAL và mã PX-nn của sổ ([11](11-pending-external-register.md)).

Trạng thái tệp: KHUNG đã điền; thiết kế tích hợp HPM chờ cấu trúc và khả năng của HPM (PX-03), đối chiếu EBS chờ mẫu tệp (PX-04); tài liệu đề xuất phương thức tích hợp HPM (API, DB trung gian, tệp chuẩn) do làn DOC-3 viết.

---

## 1. Kiến trúc hệ thống

Nguồn: `Design/MACHVON_Design/01_Documents/04_Thiet_ke_co_ban.md` (kiến trúc mục tiêu, ranh giới dữ liệu, thành phần, triển khai), `05_Thiet_ke_chi_tiet.md`.

| Lớp | Lựa chọn thiết kế | Ghi chú |
|---|---|---|
| Backend | TypeScript, NestJS modular monolith | OpenAPI là hợp đồng nguồn: `Design/MACHVON_Design/03_Engineering/openapi.json` |
| Web | React và TypeScript (Vite) | Màn hình theo `screen_catalog.json`; ứng dụng cài được cho quản lý (PWA, `docs/pwa.md`) |
| Cơ sở dữ liệu | PostgreSQL 16 trở lên | Cách ly theo tenant bằng row-level security bật và ép buộc; bản sao đọc cho BI |
| Danh tính | Keycloak, OIDC, MFA, liên kết AD | `docs/runbooks/infra/keycloak.md`, `docs/security/identity-test-plan.md` |
| Điều phối | Cơ chế quy trình duyệt trong cơ sở dữ liệu; Temporal là phương án chạy tiếp quản | `docs/adm-approval-workflow.md` |
| Sự kiện | Transactional outbox, inbox, idempotency key, If-Match | TKCB mục command, outbox, inbox |
| Tệp | Kho đối tượng tương thích S3, quét tệp trước khi liên kết | `docs/runbooks/infra/object-storage.md` |
| Quan sát | OpenTelemetry, cảnh báo có chủ và runbook | `docs/runbooks/infra/observability.md`, `docs/slo-error-budget.md` |

Bản enterprise tách khỏi bản công: mã riêng của PVFCCo nằm ở `packages/edition-enterprise`, nạp qua một điểm nối duy nhất; bản công không chứa mã đó (`npm run edition:check`). HPM và EBS chỉ có ở bản enterprise (`docs/hpm-ebs-connectors.md`).

### 1.1 Mô hình dữ liệu và nơi nhập một lần (DL.01, MD.01)

| Khái niệm | Nơi lưu | Tài liệu |
|---|---|---|
| Dự án, danh mục, mã ngoài hệ thống | `project`, `master_record`, `master_crosswalk` | `docs/prj-national-code-file.md`, `docs/mdm-catalogue-dictionary.md` |
| Kế hoạch vốn, phiên bản điều chỉnh | CAP | `docs/capital-balances.md`, `docs/cap-ledger.md` |
| Số liệu vốn theo kỳ: kế hoạch phân kỳ, số ước, số thực, điều chỉnh | FND-1: `plan_figure_revision` | `docs/fnd-funding-model.md` |
| Số liệu chỉ tiêu nhập và qua tệp | IND-1: `ind_figure` (chỉ thêm, không sửa) | `docs/ind-indicator-dictionary.md` |
| Bản chốt kỳ | `period_snapshot` (băm SHA-256, đóng băng) | `docs/dis-snapshot.md` |
| Biểu mẫu đã phát hành | RPT-1: bản phát hành bất biến có mã băm | `docs/report-engine.md` |

Một đường đọc: biểu mẫu, dashboard, gói HPM và đối chiếu EBS cùng đọc bản chốt, không đọc thẳng bảng gốc (quyết định kỹ thuật R21). Dựng bản chốt enterprise (băm schema 2) và bộ đọc là việc của ENT-3a; hiện sáu biểu mẫu chạy dữ liệu minh họa.

## 2. Thiết kế bảo mật và vận hành (YCK.06, YCK.07, HT.01, HT.06)

| Chủ đề | Thiết kế | Nguồn |
|---|---|---|
| Cách ly và phân quyền | Quyền theo hành động, phạm vi theo đơn vị, dự án, kỳ; tách nhiệm vụ | `docs/adm-doa-resolver.md`, ADM-24 |
| Xác thực | SSO, MFA, khóa tài khoản, phiên | `docs/security/identity-test-plan.md` |
| Mã hóa, tiêu đề an toàn | TLS 1.2 trở lên, tiêu đề bảo mật | `docs/runbooks/infra/tls-headers.md` |
| Bí mật | Xoay vòng, không có trong repo | `docs/runbooks/infra/secrets-rotation.md` |
| Chuỗi cung ứng | SBOM, quét phụ thuộc và image | `docs/runbooks/supply-chain.md`, `docs/runbooks/infra/security-scanning.md` |
| Nhật ký kiểm toán | Chuỗi băm có niêm phong, xuất có chữ ký băm | `docs/runbooks/audit-export.md`, `docs/runbooks/audit-tamper-drill.md` |
| Sao lưu | Sao lưu bất biến, diễn tập khôi phục | `docs/runbooks/infra/backup-immutable.md`, `docs/runbooks/infra/restore-drill.md` |
| Sẵn sàng pentest | Phạm vi, quy tắc, OWASP Top 10, API Top 10, ASVS mức 2 | `docs/security/pentest-readiness.md` |
| Cài đặt tại chỗ | Gói ngoại tuyến, yêu cầu máy chủ, nâng cấp và quay lui | `docs/runbooks/infra/onprem-install.md`, `docs/runbooks/infra/onprem-upgrade-rollback.md` |

Khoảng trống đã biết (làn INFRA-2): chu kỳ sao lưu tuần/tháng, bản khác biệt, giữ tối thiểu 03 bản, quét mã độc tệp tải lên, kiểm thử allowlist egress, kịch bản ransomware trong gói pentest.

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
| Điều chỉnh ở kỳ sau | Cách thứ hai theo hồ sơ kỹ thuật | ENT-3c |
| Bước PUSH của quy trình gọi đẩy, trạng thái chờ biên nhận | Không báo "xong" khi HPM chưa nhận (R22) | ENT-3c |
| Màn hình | HPM-01 (kết nối, nhật ký, đẩy lại, biên nhận), HPM-02 (đính chính) | Có |
| Cảnh báo | `HPM_PUSH_FAILED`, `HPM_PUSH_STALE` | Có |
| Phương thức tích hợp đề xuất | API hay DB trung gian hay tệp chuẩn, lập luận chọn | DOC-3 |

Nguồn: `docs/hpm-ebs-connectors.md` mục 2; `Design/MACHVON_Design/01_Documents/05_modules/HPM.md`.

### 3.3 Oracle EBS (TH.03, CN.04)

| Mục | Thiết kế | Tình trạng |
|---|---|---|
| Nhập | Chạy thử không ghi, áp dụng một lần theo băm tệp, bản ghi chỉ thêm | Có; bố cục giả định WORKING-ASSUMPTION-2026.1 (PX-04) |
| Đối chiếu | Theo mã dự án và kỳ, chính xác đến đồng, giải ngân lũy kế và cam kết | Có (EBS-02) |
| Mục chênh lệch | Chủ không là người nạp tệp hay người chạy đối chiếu; hạn theo ngày làm việc; giải trình `OURS_WRONG`, `EBS_WRONG`, `TIMING`, `WAIVED` | Có |
| Qua `master_crosswalk` | Hiện so khớp thẳng mã dự án | ENT-3e |
| Đọc trực tiếp DB | Giao thức `DB_READ` của hub có sẵn (chỉ SELECT) | Chưa nối EBS (PX-04) |

Nguồn: `docs/hpm-ebs-connectors.md` mục 3; `05_modules/EBS.md`.

### 3.4 Data Lakehouse và Power BI (TH.02)

| Đường | Thiết kế | Nguồn |
|---|---|---|
| API mở `/open/v1` | Tài khoản máy có phạm vi; token 5 phút; tập dữ liệu đã chứng nhận (giải ngân từ bản chốt, hợp đồng); mọi lần đọc ghi nhật ký; tài liệu `docs/open-api/openapi.json` | `docs/open-api.md` mục 2 |
| Đăng nhập DB cho BI | Đăng nhập chỉ đọc gắn một tenant bằng tên; vòng đời đăng nhập có nhật ký | `docs/open-api.md` mục 4 |
| Tập dữ liệu chứng nhận | Phiên bản theo kỳ từ bản chốt đóng băng, có điểm chất lượng | `docs/bi-datasets.md`, `docs/bi-policies.md` |
| Mô hình Power BI mẫu và hướng dẫn nối | Chưa có | DOC-3 |

Màn hình: INT-01 đến INT-05. Không phát sinh phí bản quyền khi tích hợp: không có giới hạn theo số người dùng hoặc số kết nối ở bản enterprise.

### 3.5 eProcurement, văn thư, xác thực tập trung (TH.03)

| Hệ thống | Thiết kế sẵn có | Chờ |
|---|---|---|
| eProcurement | Khung nhập tệp và hub; bộ kết nối e-GP của bản công là mẫu (`docs/egp-connector.md`) | Đặc tả dữ liệu mua sắm trang thiết bị dự án (PX-06) |
| Hệ thống văn thư | Tệp đính kèm hồ sơ pháp lý; phân hệ DOC của nền tảng (`docs/doc-interop.md`) | Đặc tả kết nối (PX-07) |
| Xác thực tập trung | Keycloak liên kết AD, ánh xạ nhóm AD sang vai trò | Thông tin AD (PX-16) |

### 3.6 Bản đồ mã dự án giữa các hệ thống (MD.01)

`master_crosswalk` (INT-03) ánh xạ mã ngoài và bản ghi chủ cho từng hệ thống nguồn; đề xuất và duyệt bởi hai người (`proposeProjectCode`, `decideProjectCode`). Bảng mã HPM, mã EBS của 22 + 01 + 09 hạng mục là dữ liệu của khách (PX-14). Đổi đối chiếu EBS và HPM sang crosswalk làm theo kiểu mở rộng rồi thu (R25): ENT-3e.

## 4. Hiệu năng, năng lực và môi trường (HT.05, YCK.02)

- Ngân sách hiệu năng: `docs/qa/perf-budget.json`, cách chạy `docs/qa/performance.md`; HSKT yêu cầu phản hồi dưới 5 giây, xem báo cáo dưới 20 giây. Đo trên phần cứng của khách: PX-10.
- Hai môi trường UAT và Production: `docs/runbooks/infra/environments.md`; cấu hình khuyến nghị riêng cho PVFCCo theo số người dùng (PX-17): DOC-3.
- Cổng phát hành: `docs/runbooks/release-checklist.md`.

## 5. Phụ thuộc cần khách trước khi chốt thiết kế

| Mã | Cần | Ảnh hưởng |
|---|---|---|
| PX-03 | Giao diện kỹ thuật HPM | Chọn bộ chuyển tiếp thay bộ ghi tệp; mọi con số về đẩy HPM chưa tính nghiệm thu |
| PX-04 | Mẫu tệp EBS, quyền đọc | Chọn tệp hay đọc DB; ngưỡng chênh lệch |
| PX-06, PX-07 | Đặc tả eProcurement, văn thư | Bộ kết nối chưa dựng |
| PX-11, PX-16 | Hạ tầng và thông tin AD, SMTP, Teams | Cài thử, nhắc việc thật |

Lịch sử sửa: v0.1 khung ngày 2026-11-09.
