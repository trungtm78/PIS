# 10. Danh mục bộ tài liệu và sản phẩm bàn giao

Giai đoạn 6 (bộ tài liệu bàn giao) và giai đoạn 7 (bảo hành, bảo trì). Dòng ma trận: TK.02, GD.6, GD.7, SP.08, SP.10, SP.11. PVFCCo phê duyệt: có cho mục 8 của sản phẩm bàn giao (báo cáo pentest); mục 10 không ghi cần phê duyệt nhưng bàn giao có biên bản.

Hồ sơ kỹ thuật (II.5, sản phẩm 10): tài liệu cài đặt, vận hành, quản trị; mã nguồn hoặc gói cài đặt và cấu hình; tài liệu API. Câu chuyện ST-KERNEL-107 bổ sung: mã nguồn, đặc tả, runbook, sổ xác nhận pháp lý đã xác nhận và chưa xác nhận, kết quả UAT, sổ nợ kỹ thuật.

Cách dùng: cột "Tình trạng" ghi `Có` (tệp đã có trong kho mã, đã kiểm tra tồn tại ngày 2026-11-12), `Một phần` hoặc `Chưa` (việc của nhà cung cấp còn thiếu, nêu rõ thiếu gì), `Chờ khách` (mã PX-nn: điều chỉ khách hoặc bên ngoài làm được). Cột "Nhận" để PVFCCo ký nhận từng dòng khi bàn giao.

Trạng thái tệp: v0.2, rà soát ngày 2026-11-12 sau khi DOC-3, INFRA-2 và các làn ENT-3, ENT-4 đã gộp: các dòng từng ghi "Chưa" hoặc "Một phần" vì chờ các làn đó nay là `Có` với tệp dẫn cụ thể. Còn lại chỉ là việc chờ khách hoặc bên ngoài (PX-03, PX-05, PX-09, PX-10, PX-11, PX-12, PX-16, PX-17) và việc chỉ làm được sau khi có thẻ phát hành.

---

## 1. Tài liệu cài đặt

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Cài từ gói ngoại tuyến (yêu cầu máy chủ, bí mật, các bước, kiểm tra sau cài, giới hạn) | `docs/runbooks/infra/onprem-install.md` | Có | [khách điền] |
| Nâng cấp và quay lui | `docs/runbooks/infra/onprem-upgrade-rollback.md`, `docs/runbooks/infra/rollback.md` | Có | |
| Môi trường UAT và Production; cấu hình hạ tầng khuyến nghị (CPU, bộ nhớ, đĩa, mạng, kho sao lưu theo giả định tải) | `docs/runbooks/infra/environments.md`, `docs/runbooks/infra/sizing-uat-prod.md` | Có; con số là khuyến nghị xuất phát, đo lại trên phần cứng của PVFCCo (PX-10, PX-11) và theo số người dùng thật (PX-17) | |
| Danh tính, Keycloak, liên kết AD | `docs/runbooks/infra/keycloak.md`, `docs/security/identity-test-plan.md`, `infra/keycloak/onprem/ad-group-role-map.json` | Có; realm đã kiểm cấu trúc ngoại tuyến; nhập thử lên máy chủ thật và nhóm AD thật: PX-11, PX-16 | |
| PostgreSQL, Redis, kho đối tượng, quan sát, điều phối, đồng bộ di động | `docs/runbooks/infra/postgres.md`, `docs/runbooks/infra/redis.md`, `docs/runbooks/infra/object-storage.md`, `docs/runbooks/infra/observability.md`, `docs/runbooks/infra/temporal.md`, `docs/runbooks/infra/powersync.md` | Có | |
| TLS, tiêu đề an toàn, xoay vòng bí mật | `docs/runbooks/infra/tls-headers.md`, `docs/runbooks/infra/secrets-rotation.md` | Có | |
| Quét mã độc tệp tải lên (ClamAV `clamd`), đường ra mạng cố định | `docs/runbooks/infra/malware-scan.md`, `infra/onprem/config/egress-firewall.sh` | Có; thử EICAR và thử chặn đường ra trên máy thật: PX-11 | |
| Danh mục thử khi cài trên máy thật (nhập realm, EICAR, đường ra, diễn tập khôi phục) | `docs/runbooks/infra/lab-install-checklist.md` | Có; kết quả điền khi cài tại PVFCCo (PX-11) | |

## 2. Tài liệu vận hành

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Sao lưu bất biến, mã hóa, lưu giữ: chu kỳ ngày (đầy đủ và gia tăng), tuần (differential), tháng (bản đầy đủ vào kho lưu trữ thứ hai, giữ 12 bản), giữ tối thiểu 03 bản, bản ngoại tuyến, sao lưu thủ công có người duyệt ở ADM-32 | `docs/runbooks/infra/backup-immutable.md`, `infra/backup/backup-policy.json` | Có (INFRA-2 đã gộp); kiểm bằng `node scripts/backup-verify.mjs`; chạy thật trên kho của PVFCCo: PX-11 | |
| Diễn tập khôi phục toàn hệ thống và từng tenant | `docs/runbooks/infra/restore-drill.md`, `docs/runbooks/tenant-restore-drill.md`, `infra/backup/restore-drill-ledger.json` | Có; sổ diễn tập còn trống, hạn diễn tập đầu 2027-01-31; cần máy sạch ở địa điểm thứ hai và bản chạy thật (PX-11) | |
| Cổng vào của hạ tầng và bằng chứng khôi phục | `docs/runbooks/infra/README.md` | Có | |
| Nhật ký kiểm toán, xuất, thử phát hiện sửa đổi; nhật ký đủ giá trị trước và sau theo loại đối tượng; giới hạn số lượng và dung lượng log | `docs/runbooks/audit-export.md`, `docs/runbooks/audit-tamper-drill.md`, `docs/runbooks/retention.md` | Có (ENT-4e đã gộp: ADM-29, ADM-30) | |
| Lưu giữ và giữ pháp lý | `docs/runbooks/retention.md` | Có | |
| Các công việc nền (kể cả tự chốt và khóa kỳ, nhắc lịch kỳ, gửi báo cáo theo lịch), hàng đợi gửi, độ trễ outbox | `docs/runbooks/jobs.md`, `docs/runbooks/notification-delivery.md`, `docs/runbooks/outbox-relay-lag.md` | Có | |
| Kết nối tích hợp | `docs/runbooks/integration-connectors.md`, `docs/integration-hub.md`, `docs/hpm-ebs-connectors.md`, `docs/integration/hpm-proposal.md` | Có (đề xuất phương thức tích hợp HPM đã viết); chọn phương thức và chạy thật chờ đặc tả HPM (PX-03) | |
| Chuỗi cung ứng, bản vá | `docs/runbooks/supply-chain.md`, `docs/runbooks/infra/security-scanning.md` | Có; bảng xử lý theo mức (Critical 7 ngày, High 30 ngày, Medium 90 ngày) cần đối chiếu với cam kết hợp đồng [07] ngày cho Critical và High, xem [12](12-maintenance-and-hypercare.md) mục 8 | |
| Hiệu năng và ngân sách lỗi | `docs/qa/performance.md`, `docs/qa/perf-budget.json`, `docs/slo-error-budget.md` | Có; đo trên phần cứng khách (PX-10) | |
| Cảnh báo vận hành | `alerts/`, `docs/alert-governance.md`, `docs/runbooks/alerts/` | Có | |
| Quy trình phát hành | `docs/runbooks/release-checklist.md` | Có | |
| Hỗ trợ, trực, hypercare (ST-KERNEL-105), lịch hỗ trợ kỳ chốt, mẫu báo cáo bảo trì | [12](12-maintenance-and-hypercare.md); thiết kế trong `Design/MACHVON_Design/01_Documents/09_Ke_hoach_trien_khai.md` | Có (khung đã lập); họ tên, điện thoại, thời hạn phản hồi theo mức (quyết định D10) và hypercare bao lâu: [khách điền] | |

## 3. Tài liệu quản trị (TK.02)

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Hướng dẫn quản trị bằng tiếng Việt: vai trò và quyền, quy tắc, lịch, danh mục, trung tâm tích hợp, sao lưu và khôi phục, xuất nhật ký, nâng cấp, vận hành thường ngày | `docs/admin-guide.md` (11 mục; DOC-3 đã gộp) và các chương `tour-adm-*`, `tour-mdm-*` của `scripts/hdsd/chapters.json` | Có; mục 6 của hướng dẫn chưa nêu chu kỳ tuần và tháng của INFRA-2 (xem backup-immutable.md) | |
| Danh mục quy tắc quản trị, cách soạn và duyệt | `docs/governance-roadmap-10of10.md`, màn ADM-19 đến ADM-22 | Có (tiếng Anh, tiếng Việt trong màn hình) | |
| Chỉ tiêu, quy tắc nhập liệu, bảng ánh xạ Excel | `docs/ind-indicator-dictionary.md` | Có; giá trị khởi điểm UNVERIFIED tới khi có từ điển chính thức (PX-02) | |
| Biểu mẫu báo cáo, cách thay mẫu demo bằng mẫu chính thức; soạn bố cục biểu mẫu nội bộ không lập trình (RPT-07, RPT-08, quy tắc `REPORT_LAYOUT`) | `docs/report-engine.md` | Có (ENT-4b đã gộp); bố cục chính thức chờ PX-01, PX-15 | |
| Lịch kỳ báo cáo và hạn từng bước (ADM-31, quy tắc `REPORTING_SCHEDULE`) | `packages/kernel/src/reporting-schedule.ts`, `docs/runbooks/jobs.md` | Có; hạn là giá trị khởi đầu UNVERIFIED, Tổ chuẩn hóa dữ liệu chốt (mục 4 của [11](11-pending-external-register.md)) | |
| Phân quyền, ủy quyền, thẩm quyền phê duyệt | `docs/adm-doa-resolver.md`, `docs/adm-delegation.md`, `docs/adm-approval-workflow.md` | Có | |
| Cấu hình PVFCCo (09 đầu mối, người nhập và duyệt, ánh xạ nhóm AD): gói mẫu PVFCCO-TEMPLATE nạp bằng lô chuyển đổi có chạy thử, màn ORG-01 | `packages/edition-enterprise/templates/org-pack/pvfcco-template.csv`, `packages/edition-enterprise/src/org-pack/pvfcco-template.ts`, `packages/kernel/src/org-pack.ts`, `infra/keycloak/onprem/ad-group-role-map.json` | Có (ENT-3d đã gộp) với dữ liệu mẫu và tên Tổ dự án giữ chỗ; dữ liệu thật chờ PX-05, PX-16 | |

## 4. Tài liệu người dùng

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Hướng dẫn sử dụng theo chương (web và điện thoại) | `scripts/hdsd/chapters.json` (90 chương), dựng bởi `scripts/hdsd/build-docs.mjs` | Có; chương riêng IND, RPT, DIR, HPM, EBS, HUB, INT, EQP, BAN chưa có, được thay bằng trợ giúp trên màn hình ở dòng dưới ([07](07-training-plan.md) mục 2.1) | |
| Cài và dùng ứng dụng cài được (PWA) | `docs/pwa.md` | Có | |
| Hướng dẫn trực tuyến trên màn hình (YCK.08) | `apps/web/src/help/help.vi.json` (594 màn hình), `scripts/help-index.mjs` | Có (DOC-3 đã gộp); mở bằng nút trợ giúp hoặc phím `?` | |
| Video hướng dẫn | Kịch bản `docs/clips/enterprise-phu-my.script.md`, `docs/clips/public-investment.script.md` (tư liệu nội dung) | Video không thuộc đợt giao này (chủ dự án đã dừng việc dựng video); hồ sơ kỹ thuật nêu "tài liệu và video hướng dẫn" nên cần quyết định có giao video hay thay bằng tài liệu chữ và trợ giúp trên màn hình: [khách điền: quyết định của chủ dự án và PVFCCo] | |

## 5. Thiết kế

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Bộ thiết kế BRD, FRD, thiết kế cơ bản, chi tiết, UI/UX, di động, dữ liệu, triển khai, kiểm thử | `Design/MACHVON_Design/01_Documents/` (02 đến 10) | Có | |
| Đặc tả phân hệ | `Design/MACHVON_Design/01_Documents/05_modules/` | Có | |
| Catalogue kỹ thuật (màn hình, API, câu chuyện, mã lỗi, từ điển dữ liệu, ERD) | `Design/MACHVON_Design/03_Engineering/` (kèm `ERD.mmd`) | Có | |
| Giao diện mẫu | `Design/MACHVON_Design/02_Prototype/` | Có | |
| Hồ sơ giao nhận Waterfall (tập này) và ma trận truy vết | `docs/delivery/`, `docs/hskt/TRACEABILITY.md` | Có (v0.2; sinh lại ma trận bằng `node scripts/hskt-trace.mjs generate` khi đổi `docs/hskt/requirements.json`) | |

## 6. Mã nguồn, gói cài đặt và cấu hình

| Hạng mục | Cách có | Kiểm | Tình trạng | Nhận |
|---|---|---|---|---|
| Mã nguồn kho `machvon` (workspaces `apps/*`, `packages/*`) tại thẻ phát hành | Kho mã; bản chụp kèm băm | `git tag`, băm bản chụp | Chờ thẻ phát hành (kho chưa có thẻ phát hành; chỉ có thẻ nền tảng thiết kế `baseline-v1.3`) | |
| Gói cài ngoại tuyến bản enterprise (ảnh OCI linux/amd64 và linux/arm64, SBOM, tệp manifest và tệp tổng kiểm SHA256SUMS do lệnh dựng gói sinh, và hai tệp mẫu `infra/onprem/bundle/install.sh`, `infra/onprem/bundle/rollback.sh`) | `node scripts/onprem-bundle.mjs build --version <v> --public-host <host> --edition enterprise --out dist/onprem` | `node scripts/onprem-bundle.mjs verify dist/onprem` | Có công cụ; dựng bản thật chờ tên máy chủ chính thức (PX-11) | |
| SBOM (CycloneDX) | `npm run sbom` | `npm run supply-chain:check -- --audit` | Có công cụ | |
| Cấu hình hạ tầng khai báo: `infra/onprem/`, `infra/keycloak/onprem/`, `infra/backup/` | Trong gói | `npm run infra:check` | Có | |
| Di trú cơ sở dữ liệu | `db/migrations/`, `db/migrations/blocks.json` | `npm run migrations:check`, `npm run expand-contract:check` | Có | |
| Kiểm soát mã bản enterprise không lọt vào bản công | `scripts/edition-check.mjs` | `npm run edition:check` | Có | |
| Sổ giấy phép của phụ thuộc và bản quyền | `supply-chain.json`, SBOM | Không có phí bản quyền khi tích hợp (TH.03) | Rà soát khi bàn giao | |
| Bí mật, khóa, tài khoản quản trị ban đầu | Danh sách `infra/onprem/secrets.json` (tên bí mật, không giá trị) | Giao riêng theo quy trình xoay vòng | Giao khi cài | |

## 7. Tài liệu API (TH.03)

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Tài liệu API mở cho hệ thống ngoài (Lakehouse, Power BI, hệ thống khác) | `docs/open-api/openapi.json`, `docs/open-api.md` | Có; giữ đồng bộ bằng `node scripts/open-api-publish.mjs --check` | |
| Hợp đồng API đầy đủ (toàn bộ thao tác) | `Design/MACHVON_Design/03_Engineering/openapi.json` | Có | |
| Mã lỗi | `Design/MACHVON_Design/03_Engineering/error_codes.json` | Có | |
| Cách tích hợp HPM (API, DB trung gian, tệp chuẩn) | `docs/integration/hpm-proposal.md`, `docs/hpm-ebs-connectors.md` | Có (đề xuất); chọn phương thức chờ PX-03 | |
| Mô hình Power BI mẫu | `docs/integration/power-bi-model.md`, `docs/integration/machvon-bi.pbids`, `docs/integration/power-bi-sample-queries.sql` | Có; thử trên Power BI và Data Lakehouse thật: PX-11 | |

## 8. Bằng chứng chất lượng và an toàn thông tin (sản phẩm 5, 8 và nền cho nghiệm thu)

| Hạng mục | Nguồn | Tình trạng | Nhận |
|---|---|---|---|
| Kết quả UAT và danh sách lỗi | [09](09-acceptance-minutes-template.md) (mục 1.1 có số đếm điền sẵn), `docs/UAT-EVIDENCE.md`, `docs/UAT-COVERAGE.md`, `docs/uat/RUN-2026-11-09-r2.md` | Mẫu và bằng chứng phát triển có (63 trên 676 hàng PASS, 20 trên 28 ca then chốt PASS); UAT tại PVFCCo chưa chạy: PX-11, PX-12 | |
| Báo cáo rà soát mã nguồn (SAST) và rà soát thư viện (SCA) của đơn vị độc lập | Do đơn vị độc lập cấp | Chờ khách (PX-09) | |
| Báo cáo pentest, khắc phục và retest đạt YCK.07 | Do đơn vị độc lập cấp; gói đầu vào `docs/security/pentest-readiness.md` | Chờ khách (PX-09) | |
| Bằng chứng nội bộ chuẩn bị cho pentest | `docs/security/pentest-readiness.md` mục 6 và 7 (khoảng trống đã biết, bằng chứng người kiểm thử nhận), `docs/security/ransomware-scenarios.md` | Có | |
| Quét SAST, SCA, ảnh container, bí mật trong kho (của nhà cung cấp, chạy trong CI; không thay cho rà soát và pentest của đơn vị độc lập ở hai dòng trên) | `docs/runbooks/infra/security-scanning.md`, `docs/runbooks/supply-chain.md` | Có | |
| Bằng chứng trợ năng, hiệu năng | `docs/qa/a11y-baseline.json`, `docs/qa/perf-budget.json` | Có; hiệu năng trên phần cứng khách: PX-10 | |
| Sổ xác nhận pháp lý (đã xác nhận, chưa xác nhận) | `docs/runbooks/legal-confirmation.md`, `Design/MACHVON_Design/03_Engineering/legal_confirmation_ledger.json` | Có | |
| Sổ nợ kỹ thuật và việc còn mở | `TODOS.md`, `PROGRESS.md` | Có | |

## 9. Bảo hành và bảo trì (giai đoạn 7)

Kế hoạch chi tiết, mô hình hỗ trợ, hypercare, lịch hỗ trợ kỳ chốt và mẫu báo cáo bảo trì định kỳ nằm ở [12](12-maintenance-and-hypercare.md). Các giá trị trong ngoặc vuông của bảng là của hồ sơ kỹ thuật, giữ nguyên như hồ sơ ghi.

| Cam kết theo hồ sơ kỹ thuật | Cách thực hiện | Tình trạng |
|---|---|---|
| Bảo hành, bảo trì, hỗ trợ vận hành [12] tháng sau nghiệm thu | Hợp đồng | Ngoài tài liệu này; tính từ ngày ký biên bản nghiệm thu ([09](09-acceptance-minutes-template.md) mục 3) |
| Hỗ trợ trực tiếp hoặc trực tuyến trong kỳ chốt tháng và quý | [12](12-maintenance-and-hypercare.md) mục 5 (bảng lịch theo loại kỳ, hạn từng bước lấy từ quy tắc `REPORTING_SCHEDULE`) | Có (khung); người trực và đầu mối: [khách điền: họ tên, điện thoại] |
| Khắc phục sự cố trong vòng 24 giờ | Mô hình trực P0 đến P3 (ST-KERNEL-105), [12](12-maintenance-and-hypercare.md) mục 2 | Có (khung); thời hạn phản hồi theo mức do D10 chưa chốt; đường liên hệ của PVFCCo: [khách điền] |
| Điều chỉnh biểu mẫu khi PVN hoặc Tổng công ty đổi mẫu | Thay mẫu theo `docs/report-engine.md`; soạn bố cục ở RPT-07, RPT-08 (ENT-4b) | Có; mẫu chính thức chờ PX-01, PX-15 |
| Kiểm tra bảo trì trên UAT trước khi áp dụng | `docs/runbooks/release-checklist.md`, `docs/runbooks/infra/onprem-upgrade-rollback.md` | Có |
| Hỗ trợ kỹ thuật khi bên thứ ba kết nối | `docs/open-api.md`, hub tích hợp (HUB-01 đến HUB-03) | Có |
| Chạy lại pentest khi có thay đổi lớn; khắc phục lỗ hổng Critical hoặc High trong [07] ngày | Theo YCK.07; bảng xử lý ở `docs/runbooks/infra/security-scanning.md` | Chờ PX-09 (đơn vị độc lập); thời hạn nội bộ cần khớp [07] ngày: [12](12-maintenance-and-hypercare.md) mục 8 |
| Báo cáo bảo trì định kỳ (sản phẩm giai đoạn 7) | Mẫu ở [12](12-maintenance-and-hypercare.md) mục 7; tần suất: [khách điền] | Có (mẫu); tần suất và người nhận: [khách điền] |
| Kế hoạch bảo hành, bảo trì và hypercare | [12](12-maintenance-and-hypercare.md) | Có (khung) |

## 10. Biên bản bàn giao

```
BIÊN BẢN BÀN GIAO TÀI LIỆU VÀ SẢN PHẨM
Số: [khách điền]            Ngày: [khách điền]
Bên giao (nhà cung cấp): [khách điền]    Bên nhận (PVFCCo, Ban CĐS&CNTT): [khách điền]
1. Đối chiếu các mục 1 đến 9 của danh mục: tổng [..] dòng; đã nhận [..]; chưa có [..] (kèm hạn)
2. Phương tiện bàn giao: [bản cứng, bản mềm, video nếu có]; băm SHA-256 của gói: [..]
3. Tài khoản và bí mật đã giao (tên, người nhận, ngày; không ghi giá trị): [khách điền]
4. Kiểm tra sau bàn giao: bản cài chạy từ gói trên máy chủ của PVFCCo [ ] đạt  [ ] không đạt
5. Kết luận: [ ] Bàn giao đủ   [ ] Bàn giao còn thiếu, danh sách và hạn: [..]
Chữ ký: bên giao [khách điền]   bên nhận [khách điền]
```

Lịch sử sửa: v0.1 khung ngày 2026-11-09. v0.2 ngày 2026-11-12 (rà soát bởi làn aud4): các dòng chờ ENT-3d, ENT-4b, INFRA-2, DOC-3 chuyển thành `Có` kèm tệp thật (gói PVFCCO-TEMPLATE, hướng dẫn quản trị, trợ giúp trên màn hình, đề xuất tích hợp HPM, mô hình Power BI, cấu hình hạ tầng khuyến nghị, chu kỳ sao lưu); sửa đường dẫn viết tắt thành đường dẫn đầy đủ; thêm dòng quét mã độc, danh mục thử trên máy thật, bảng lịch kỳ, ghi rõ video không thuộc đợt giao này; thêm [12](12-maintenance-and-hypercare.md) vào mục 9 và mục 2; nêu mâu thuẫn thời hạn vá (7 và 30 ngày so với [07] ngày của hợp đồng).
