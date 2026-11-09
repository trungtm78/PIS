# 10. Danh mục bộ tài liệu và sản phẩm bàn giao

Giai đoạn 6 (bộ tài liệu bàn giao) và giai đoạn 7 (bảo hành, bảo trì). Dòng ma trận: TK.02, GD.6, GD.7, SP.08, SP.10, SP.11. PVFCCo phê duyệt: có cho mục 8 của sản phẩm bàn giao (báo cáo pentest); mục 10 không ghi cần phê duyệt nhưng bàn giao có biên bản.

Hồ sơ kỹ thuật (II.5, sản phẩm 10): tài liệu cài đặt, vận hành, quản trị; mã nguồn hoặc gói cài đặt và cấu hình; tài liệu API. Câu chuyện ST-KERNEL-107 bổ sung: mã nguồn, đặc tả, runbook, sổ xác nhận pháp lý đã xác nhận và chưa xác nhận, kết quả UAT, sổ nợ kỹ thuật.

Cách dùng: cột "Tình trạng" ghi `Có` (tệp đã có trong kho mã), `Một phần` hoặc `Chưa` (làn nêu tên đang làm), `Chờ khách` (mã PX-nn). Cột "Nhận" để PVFCCo ký nhận từng dòng khi bàn giao.

---

## 1. Tài liệu cài đặt

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Cài từ gói ngoại tuyến (yêu cầu máy chủ, bí mật, các bước, kiểm tra sau cài, giới hạn) | `docs/runbooks/infra/onprem-install.md` | Có | [khách điền] |
| Nâng cấp và quay lui | `docs/runbooks/infra/onprem-upgrade-rollback.md`, `docs/runbooks/infra/rollback.md` | Có | |
| Môi trường UAT và Production | `docs/runbooks/infra/environments.md` | Một phần; cấu hình khuyến nghị riêng cho PVFCCo: DOC-3 (PX-11, PX-17) | |
| Danh tính, Keycloak, liên kết AD | `docs/runbooks/infra/keycloak.md`, `docs/security/identity-test-plan.md` | Có; nhập thử realm lên máy chủ thật: INFRA-2 (PX-16) | |
| PostgreSQL, Redis, kho đối tượng, quan sát, điều phối, đồng bộ di động | `docs/runbooks/infra/postgres.md`, `redis.md`, `object-storage.md`, `observability.md`, `temporal.md`, `powersync.md` | Có | |
| TLS, tiêu đề an toàn, xoay vòng bí mật | `docs/runbooks/infra/tls-headers.md`, `docs/runbooks/infra/secrets-rotation.md` | Có | |

## 2. Tài liệu vận hành

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Sao lưu bất biến, mã hóa, lưu giữ | `docs/runbooks/infra/backup-immutable.md` | Có; chu kỳ tuần/tháng, differential, giữ 03 bản, sao lưu thủ công trên giao diện: INFRA-2 | |
| Diễn tập khôi phục toàn hệ thống và từng tenant | `docs/runbooks/infra/restore-drill.md`, `docs/runbooks/tenant-restore-drill.md` | Có; bằng chứng diễn tập trên máy PVFCCo: chờ (PX-11) | |
| Cổng vào của hạ tầng và bằng chứng khôi phục | `docs/runbooks/infra/README.md` | Có | |
| Nhật ký kiểm toán, xuất, thử phát hiện sửa đổi | `docs/runbooks/audit-export.md`, `docs/runbooks/audit-tamper-drill.md` | Có | |
| Lưu giữ và giữ pháp lý | `docs/runbooks/retention.md` | Có | |
| Các công việc nền, hàng đợi gửi, độ trễ outbox | `docs/runbooks/jobs.md`, `docs/runbooks/notification-delivery.md`, `docs/runbooks/outbox-relay-lag.md` | Có | |
| Kết nối tích hợp | `docs/runbooks/integration-connectors.md`, `docs/integration-hub.md`, `docs/hpm-ebs-connectors.md` | Có; phương thức tích hợp HPM đề xuất: DOC-3 (PX-03) | |
| Chuỗi cung ứng, bản vá | `docs/runbooks/supply-chain.md`, `docs/runbooks/infra/security-scanning.md` | Có; bản vá trong 01 tháng (YCK.07) cần quy trình theo dõi: INFRA-2 | |
| Hiệu năng và ngân sách lỗi | `docs/qa/performance.md`, `docs/qa/perf-budget.json`, `docs/slo-error-budget.md` | Có; đo trên phần cứng khách (PX-10) | |
| Cảnh báo vận hành | `alerts/` và `docs/alert-governance.md` | Có | |
| Quy trình phát hành | `docs/runbooks/release-checklist.md` | Có | |
| Hỗ trợ, trực, hypercare (ST-KERNEL-105) | Thiết kế trong `Design/MACHVON_Design/01_Documents/09_Ke_hoach_trien_khai.md` | Một phần; lịch hỗ trợ kỳ chốt cho PVFCCo: chưa lập | |

## 3. Tài liệu quản trị (TK.02)

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Hướng dẫn quản trị bằng tiếng Việt: người dùng, vai trò, phạm vi, ủy quyền, danh mục, quy tắc, quy trình, kết nối, nhật ký, sao lưu | Gộp từ chương `tour-adm-*`, `tour-mdm-*` của `scripts/hdsd/chapters.json` và các runbook trên | Chưa (DOC-3) | |
| Danh mục quy tắc quản trị, cách soạn và duyệt | `docs/governance-roadmap-10of10.md`, màn ADM-19 đến ADM-22 | Có (tiếng Anh, tiếng Việt trong màn hình) | |
| Chỉ tiêu, quy tắc nhập liệu, bảng ánh xạ Excel | `docs/ind-indicator-dictionary.md` | Có | |
| Biểu mẫu báo cáo, cách thay mẫu demo bằng mẫu chính thức | `docs/report-engine.md` | Có; công cụ cấu hình bố cục không lập trình: ENT-4b | |
| Phân quyền, ủy quyền, thẩm quyền phê duyệt | `docs/adm-doa-resolver.md`, `docs/adm-delegation.md`, `docs/adm-approval-workflow.md` | Có | |
| Cấu hình PVFCCo (09 đầu mối, người nhập và duyệt, ánh xạ nhóm AD) | Gói cấu hình PVFCCO-TEMPLATE | Chưa (ENT-3d); dữ liệu thật chờ PX-05, PX-16 | |

## 4. Tài liệu người dùng

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Hướng dẫn sử dụng theo chương (web và điện thoại) | `scripts/hdsd/chapters.json`, dựng bởi `scripts/hdsd/build-docs.mjs` | Có; chương riêng IND, RPT, DIR, HPM, EBS: DOC-3 | |
| Cài và dùng ứng dụng cài được (PWA) | `docs/pwa.md` | Có | |
| Video giới thiệu (hai bản) | `docs/clips/enterprise-phu-my.script.md`, `docs/clips/public-investment.script.md` | Kịch bản có; video tiếng Việt chờ giọng đọc và nhạc | |
| Hướng dẫn trực tuyến trên màn hình (YCK.08) | Chưa có | Chưa (DOC-3) | |

## 5. Thiết kế

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Bộ thiết kế BRD, FRD, thiết kế cơ bản, chi tiết, UI/UX, di động, dữ liệu, triển khai, kiểm thử | `Design/MACHVON_Design/01_Documents/` (02 đến 10) | Có | |
| Đặc tả phân hệ | `Design/MACHVON_Design/01_Documents/05_modules/` | Có | |
| Catalogue kỹ thuật (màn hình, API, câu chuyện, mã lỗi, từ điển dữ liệu, ERD) | `Design/MACHVON_Design/03_Engineering/` (kèm `ERD.mmd`) | Có | |
| Giao diện mẫu | `Design/MACHVON_Design/02_Prototype/` | Có | |
| Hồ sơ giao nhận Waterfall (tập này) và ma trận truy vết | `docs/delivery/`, `docs/hskt/TRACEABILITY.md` | Có (khung) | |

## 6. Mã nguồn, gói cài đặt và cấu hình

| Hạng mục | Cách có | Kiểm | Tình trạng | Nhận |
|---|---|---|---|---|
| Mã nguồn kho `machvon` (workspaces `apps/*`, `packages/*`) tại thẻ phát hành | Kho mã; bản chụp kèm băm | `git tag`, băm bản chụp | Chờ thẻ phát hành | |
| Gói cài ngoại tuyến bản enterprise (ảnh OCI linux/amd64 và linux/arm64, SBOM, `manifest.json`, `SHA256SUMS`, `install.sh`, `rollback.sh`) | `node scripts/onprem-bundle.mjs build --version <v> --public-host <host> --edition enterprise --out dist/onprem` | `node scripts/onprem-bundle.mjs verify dist/onprem` | Chờ tên máy chủ chính thức (PX-11) | |
| SBOM (CycloneDX) | `npm run sbom` | `npm run supply-chain:check -- --audit` | Có công cụ | |
| Cấu hình hạ tầng khai báo: `infra/onprem/`, `infra/keycloak/onprem/`, `infra/backup/` | Trong gói | `npm run infra:check` | Có | |
| Di trú cơ sở dữ liệu | `db/migrations/`, `db/migrations/blocks.json` | `npm run migrations:check`, `npm run expand-contract:check` | Có | |
| Kiểm soát mã bản enterprise không lọt vào bản công | `scripts/edition-check.mjs` | `npm run edition:check` | Có | |
| Sổ giấy phép của phụ thuộc và bản quyền | `supply-chain.json`, SBOM | Không có phí bản quyền khi tích hợp (TH.03) | Rà soát khi bàn giao | |
| Bí mật, khóa, tài khoản quản trị ban đầu | Danh sách `infra/onprem` (tên bí mật, không giá trị) | Giao riêng theo quy trình xoay vòng | Giao khi cài | |

## 7. Tài liệu API (TH.03)

| Hạng mục | Tệp | Tình trạng | Nhận |
|---|---|---|---|
| Tài liệu API mở cho hệ thống ngoài (Lakehouse, Power BI, hệ thống khác) | `docs/open-api/openapi.json`, `docs/open-api.md` | Có; giữ đồng bộ bằng `node scripts/open-api-publish.mjs --check` | |
| Hợp đồng API đầy đủ (toàn bộ thao tác) | `Design/MACHVON_Design/03_Engineering/openapi.json` | Có | |
| Mã lỗi | `Design/MACHVON_Design/03_Engineering/error_codes.json` | Có | |
| Cách tích hợp HPM (API, DB trung gian, tệp chuẩn) | Tài liệu đề xuất | Chưa (DOC-3); chờ PX-03 | |
| Mô hình Power BI mẫu | Tài liệu và tệp mẫu | Chưa (DOC-3) | |

## 8. Bằng chứng chất lượng và an toàn thông tin (sản phẩm 5, 8 và nền cho nghiệm thu)

| Hạng mục | Nguồn | Tình trạng | Nhận |
|---|---|---|---|
| Kết quả UAT và danh sách lỗi | [09](09-acceptance-minutes-template.md), `docs/UAT-EVIDENCE.md`, `docs/UAT-COVERAGE.md` | Mẫu; chạy UAT trên bản đã gộp: chưa | |
| Báo cáo rà soát mã nguồn (SAST) và rà soát thư viện (SCA) của đơn vị độc lập | Do đơn vị độc lập cấp | Chờ khách (PX-09) | |
| Báo cáo pentest, khắc phục và retest đạt YCK.07 | Do đơn vị độc lập cấp; gói đầu vào `docs/security/pentest-readiness.md` | Chờ khách (PX-09) | |
| Bằng chứng nội bộ chuẩn bị cho pentest | `docs/security/pentest-readiness.md` mục 6 và 7 (khoảng trống đã biết, bằng chứng người kiểm thử nhận) | Có | |
| Bằng chứng trợ năng, hiệu năng | `docs/qa/a11y-baseline.json`, `docs/qa/perf-budget.json` | Có | |
| Sổ xác nhận pháp lý (đã xác nhận, chưa xác nhận) | `docs/runbooks/legal-confirmation.md`, `Design/MACHVON_Design/03_Engineering/legal_confirmation_ledger.json` | Có | |
| Sổ nợ kỹ thuật và việc còn mở | `TODOS.md`, `PROGRESS.md` | Có | |

## 9. Bảo hành và bảo trì (giai đoạn 7)

| Cam kết theo hồ sơ kỹ thuật | Cách thực hiện | Tình trạng |
|---|---|---|
| Bảo hành, bảo trì, hỗ trợ vận hành [12] tháng sau nghiệm thu | Hợp đồng | Ngoài tài liệu này |
| Hỗ trợ trực tiếp hoặc trực tuyến trong kỳ chốt tháng và quý | Lịch hỗ trợ kỳ chốt: [khách điền: kỳ, đầu mối] | Chưa lập |
| Khắc phục sự cố trong vòng 24 giờ | Mô hình trực P0 đến P3 (ST-KERNEL-105) | Thiết kế có; đường liên hệ của PVFCCo chờ |
| Điều chỉnh biểu mẫu khi PVN hoặc Tổng công ty đổi mẫu | Thay mẫu theo `docs/report-engine.md`; công cụ ENT-4b | Một phần |
| Kiểm tra bảo trì trên UAT trước khi áp dụng | `docs/runbooks/release-checklist.md` | Có |
| Hỗ trợ kỹ thuật khi bên thứ ba kết nối | `docs/open-api.md`, hub tích hợp | Có |
| Chạy lại pentest khi có thay đổi lớn; khắc phục lỗ hổng Critical hoặc High trong [07] ngày | Theo YCK.07 | Chờ PX-09 |
| Báo cáo bảo trì định kỳ (sản phẩm giai đoạn 7) | Mẫu: [khách điền: tần suất, nội dung] | Chưa lập |

## 10. Biên bản bàn giao

```
BIÊN BẢN BÀN GIAO TÀI LIỆU VÀ SẢN PHẨM
Số: [khách điền]            Ngày: [khách điền]
Bên giao (nhà cung cấp): [khách điền]    Bên nhận (PVFCCo, Ban CĐS&CNTT): [khách điền]
1. Đối chiếu các mục 1 đến 8 của danh mục: tổng [..] dòng; đã nhận [..]; chưa có [..] (kèm hạn)
2. Phương tiện bàn giao: [bản cứng, bản mềm, video]; băm SHA-256 của gói: [..]
3. Tài khoản và bí mật đã giao (tên, người nhận, ngày; không ghi giá trị): [khách điền]
4. Kiểm tra sau bàn giao: bản cài chạy từ gói trên máy chủ của PVFCCo [ ] đạt  [ ] không đạt
5. Kết luận: [ ] Bàn giao đủ   [ ] Bàn giao còn thiếu, danh sách và hạn: [..]
Chữ ký: bên giao [khách điền]   bên nhận [khách điền]
```

Lịch sử sửa: v0.1 khung ngày 2026-11-09.
