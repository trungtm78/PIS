# 03. Đối chiếu SRS: mã yêu cầu HSKT tới BRD, FRD và tài liệu thiết kế

Giai đoạn 2, sản phẩm 3 của mục II.5 (SRS). Dòng ma trận: GD.2, SP.03. PVFCCo phê duyệt: có (SRS).

Tài liệu này không chép lại yêu cầu. Nó chỉ ra, cho từng mã yêu cầu của hồ sơ kỹ thuật, đặc tả nằm ở đâu trong bộ thiết kế `Design/MACHVON_Design/01_Documents` để Tổ chuẩn hóa dữ liệu duyệt SRS bằng cách đọc đúng chỗ. Trạng thái xây dựng của từng mã nằm ở [../hskt/TRACEABILITY.md](../hskt/TRACEABILITY.md).

## 1. Cách đọc bộ thiết kế

| Tài liệu | Đường dẫn | Nói về | Ghi chú |
|---|---|---|---|
| Nghiên cứu và phân tích nguồn | `Design/MACHVON_Design/01_Documents/01_Nghien_cuu_va_phan_tich_nguon.md` | Căn cứ pháp lý, thị trường | |
| BRD | `.../02_BRD.md` | Mục tiêu, quy tắc kinh doanh `BR-xx`, `BR-Rxx` | Baseline 1.4 viết cho nền tảng đầu tư công; không nhắc HPM, EBS (kiểm bằng tìm kiếm) |
| FRD | `.../03_FRD.md` | Use case `UC01` đến `UC28`, hợp đồng chung | Cùng ghi chú |
| Thiết kế cơ bản | `.../04_Thiet_ke_co_ban.md` | Kiến trúc, tenant, tích hợp bằng tệp, hạ tầng, SLO | |
| Thiết kế chi tiết | `.../05_Thiet_ke_chi_tiet.md` | Dữ liệu, thuật toán, API, lỗi, import tệp | |
| Đặc tả phân hệ | `.../05_modules/<MÃ>.md` | Mười hai mục theo `_KHUNG_DAC_TA.md`: luồng, trạng thái, quy tắc `BR-<MÃ>-NN`, API, kiểm thử | Các phân hệ bản enterprise (IND, RPT, DIR, HPM, EBS, HUB, INT, BAN, FEED) chỉ có ở đây |
| UI/UX | `.../06_UI_UX_Design_System.md` | Hệ thiết kế | |
| Di động | `.../07_Smartphone_iOS_Android.md` | Ứng dụng điện thoại | |
| Quản trị dữ liệu | `.../08_Quan_tri_du_lieu_va_truong_thanh.md` | Master data, chất lượng, lineage | |
| Kế hoạch triển khai | `.../09_Ke_hoach_trien_khai.md` | Lộ trình, cutover, đào tạo, bàn giao | |
| Kiểm thử và chuyển đổi | `.../10_Ke_hoach_kiem_thu_va_chuyen_doi.md` | Tầng kiểm thử, migration rehearsal, cutover | |
| Catalogue kỹ thuật | `Design/MACHVON_Design/03_Engineering/*.json` | `screen_catalog.json`, `openapi.json`, `implementation_plan.json`, `traceability.json`, `test_cases.json` | Máy đọc được; ma trận truy vết đối chiếu với các tệp này |

Lưu ý trung thực: BRD và FRD baseline 1.4 mô tả nền tảng (đầu tư công) mà bản enterprise dùng chung. Những gì riêng của PVFCCo đã được xây sau baseline được ghi ở đặc tả phân hệ và ở các tài liệu `docs/*.md` kèm theo, không ở BRD và FRD. Khi SRS được trình duyệt, nhà cung cấp phải nêu rõ đoạn nào là của nền tảng, đoạn nào là bổ sung enterprise; bảng dưới làm việc đó từng mã.

## 2. Bảng đối chiếu

Quy ước: `PRJ.md` là `Design/MACHVON_Design/01_Documents/05_modules/PRJ.md`. Viết tắt "TKCB" là thiết kế cơ bản (04), "TKCT" là thiết kế chi tiết (05). Cột "Tài liệu kho mã" là tệp `docs/` mô tả cách đã xây.

### 2.1 Master data (MD)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| MD.01 | `PRJ.md`, `MDM.md`, `INT.md` (ánh xạ mã đa hệ thống INT-03) | FRD UC28 (danh mục dự án và vòng đời), UC13 (dữ liệu chủ); 08 (master data); BR-R05 | `docs/prj-national-code-file.md`, `docs/mdm-succession.md`, `docs/mdm-merge.md` |
| MD.02 | `PRJ.md`, `DOC.md`, `PMT.md` | FRD UC23 (hồ sơ pháp lý), UC28; BR-R13, BR-R05 | `docs/prj-revisions.md`, `docs/prj-wbs.md`, `docs/doc-dossiers.md` |
| MD.03 | `MDM.md`, `ADM.md` (ADM-05) | FRD UC13; 08 mục master data đầy đủ và hiệu lực theo thời gian | `docs/mdm-catalogue-dictionary.md` |

### 2.2 Bộ dữ liệu nền (DL)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| DL.01 | `DIS.md`, `IND.md`, `CAP.md` | FRD UC01; BR-R01, BR-R02, BR-R03; TKCT mục thuật toán tổng hợp | `docs/fnd-funding-model.md`, `docs/dis-rates.md`, `docs/dis-report.md` |
| DL.02 | `IND.md` | TKCT mục import tệp idempotent (A3) | `docs/ind-indicator-dictionary.md`, `docs/file-import.md` |
| DL.03 | `DIS.md` (DIS-21, DIS-22), `BI.md` | FRD UC02 (khóa kỳ); BR-R11, BR-R02 | `docs/dis-snapshot.md`, `docs/bi-datasets.md` |

### 2.3 Quy trình (QT)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| QT.01 | `ADM.md` (ADM-06, ADM-15, ADM-18), `DIS.md` | FRD UC18 (thẩm quyền phê duyệt), UC02; BR-R04, BR-03 | `docs/adm-approval-workflow.md`, `docs/adm-doa-resolver.md`, `docs/dis-report-decision.md`, `docs/work-clocks.md` |
| QT.02 | `DIS.md` (DIS-14, DIS-15, DIS-21, DIS-22), `MDM.md` (MDM-11), `ADM.md` (ADM-07), `DIR.md` | FRD UC02, UC19; BR-R11 | `docs/dis-report-progress.md`, `docs/adm-working-time.md`, `docs/dis-submission-board.md` |

### 2.4 Chức năng nghiệp vụ (CN)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| CN.01 | `CAP.md` | FRD UC03 (kế hoạch, phân bổ, điều chuyển); BR-R01 | `docs/capital-balances.md`, `docs/cap-ledger.md`, `docs/cap-reallocation.md` |
| CN.02 | `DIS.md`, `IND.md`, `PRJ.md` | FRD UC01; BR-R02, BR-R03 | `docs/dis-report-submit.md`, `docs/dis-weekly-plan.md`, `docs/prj-explanation.md` |
| CN.03 | `DIR.md`, `PRJ.md`, `BAN.md` | FRD UC19, UC28; BR-R10 | `docs/committee-workspace.md`, `docs/dis-warning.md`, `docs/prj-risk-signals.md` |
| CN.04 | `EBS.md`, `DGV.md`, `DIS.md` (DIS-26) | FRD UC14; BR-R12 | `docs/hpm-ebs-connectors.md`, `docs/gov-d-cross-total.md`, `docs/dgv-reconciliation.md`, `docs/finance-feed.md` |

### 2.5 Báo cáo (BC)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| BC.01 | `RPT.md`, `MNE.md`, `DOC.md` | FRD UC27 (mẫu pháp định), UC21; BR-R13 | `docs/report-engine.md`, `docs/dis-report-export.md`, `docs/mne-export.md` |
| BC.02 | `HOME.md`, `BI.md`, `BAN.md` | FRD UC19, UC10; BR-R06, BR-R10 | `docs/home-command-center.md`, `docs/bi-dashboards.md`, `docs/bi-exports.md` |

### 2.6 Tích hợp (TH)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| TH.01 | `HPM.md`, `HUB.md` | TKCB mục tích hợp dựa trên tệp và trạng thái adapter | `docs/hpm-ebs-connectors.md`, `docs/integration-hub.md` |
| TH.02 | `INT.md`, `BI.md`, `HUB.md` | TKCB mục kiến trúc BI | `docs/open-api.md`, `docs/open-api/openapi.json`, `docs/bi-datasets.md` |
| TH.03 | `EBS.md`, `INT.md`, `HUB.md`, `ADM.md` (ADM-09) | TKCB mục tích hợp tệp | `docs/hpm-ebs-connectors.md`, `docs/open-api.md`, `docs/runbooks/infra/keycloak.md` |

### 2.7 Quản trị hệ thống (HT)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| HT.01 | `SAS.md`, `ADM.md` (ADM-14) | TKCB mục hosting nội địa; mục ranh giới dữ liệu và cách ly | `docs/runbooks/infra/onprem-install.md`, `docs/runbooks/infra/tls-headers.md` |
| HT.02 | `ADM.md`, `IAM.md` | FRD UC17, UC18; BR-R07 | `docs/adm-doa-resolver.md`, `docs/iam-self-service.md`, `docs/security/identity-test-plan.md` |
| HT.03 | `ADM.md` (ADM-04, ADM-25) | FRD UC18; BR-R04 | `docs/adm-delegation.md` |
| HT.04 | `ADM.md` (ADM-19 đến ADM-22), `IND.md`, `MDM.md` | TKCT mục quy tắc pháp lý và mẫu biểu là dữ liệu (R4); BR-R13 | `docs/governance-roadmap-10of10.md`, `docs/ind-indicator-dictionary.md` |
| HT.05 | `NFR` (nonfunctional_requirements.json), `BI.md` (BI-13) | TKCB mục SLO, RPO, RTO; 10 mục kiểm thử tải | `docs/qa/performance.md`, `docs/qa/perf-budget.json`, `docs/slo-error-budget.md` |
| HT.06 | `ADM.md` (ADM-11, ADM-12) | TKCT mục kiểm thử và quan sát; BR-03 | `docs/runbooks/audit-export.md`, `docs/runbooks/retention.md` |

### 2.8 Yêu cầu khác (YCK)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| YCK.01 | `MOB.md`, `NOT.md`, `HOME.md` | FRD UC20, UC09; 07 (điện thoại) | `docs/pwa.md`, `docs/runbooks/browser-differences.md`, `docs/runbooks/notification-delivery.md` |
| YCK.02 | `SAS.md` | TKCB mục môi trường, CI/CD | `docs/runbooks/infra/environments.md`, `docs/runbooks/infra/onprem-install.md` |
| YCK.03 | `SAS.md` | BR-05 (vận hành, license) | `docs/delivery/11-pending-external-register.md` (PX-17) |
| YCK.04 | `IND.md`, `DIS.md`, `INT.md` | TKCT mục import tệp idempotent | `docs/file-import.md`, `docs/open-api.md`, `docs/dis-report-import.md` |
| YCK.05 | `HUB.md`, `ADM.md` | TKCB mục triển khai vận hành và mở rộng | `docs/integration-hub.md`, `docs/kernel-release-compatibility.md`, `docs/runbooks/infra/onprem-upgrade-rollback.md` |
| YCK.06 | `SAS.md` (SAS-21) | TKCB mục sao lưu, khôi phục và DR | `docs/runbooks/infra/backup-immutable.md`, `docs/runbooks/infra/restore-drill.md` |
| YCK.07 | `IAM.md`, `ADM.md` (ADM-14) | TKCT mục kiểm thử; BR-R14, BR-R15 | `docs/security/pentest-readiness.md`, `docs/security/identity-test-plan.md`, `docs/runbooks/supply-chain.md` |
| YCK.08 | `IND.md` (IND-02), `IAM.md` (IAM-08) | 06 (UI/UX) | `scripts/hdsd/chapters.json` |

### 2.9 Triển khai (TK)

| Mã | Tài liệu thiết kế | Tài liệu giao nhận |
|---|---|---|
| TK.01 | `09_Ke_hoach_trien_khai.md` mục vận hành, hỗ trợ, đào tạo và bàn giao | [07](07-training-plan.md) |
| TK.02 | `09_Ke_hoach_trien_khai.md` | [10](10-handover-checklist.md) |
| TK.03 | `10_Ke_hoach_kiem_thu_va_chuyen_doi.md` mục migration rehearsal và đối soát | [06](06-data-conversion-plan.md) |
| TK.04 | `10_Ke_hoach_kiem_thu_va_chuyen_doi.md` mục cutover và rollback; `docs/dis-d03-signoff-pack.md` (cổng chạy song song hai kỳ) | [08](08-parallel-run-plan.md) |

## 3. Khoảng trống của bộ thiết kế so với hồ sơ kỹ thuật

Những điểm SRS phải bổ sung hoặc Tổ chuẩn hóa dữ liệu phải xác nhận vì bộ thiết kế baseline chưa nêu:

1. Mô hình sáu biểu mẫu của PVFCCo và dữ liệu nền một lần: nằm ở `docs/report-engine.md`, `docs/ind-indicator-dictionary.md`, `docs/fnd-funding-model.md` (spec FND-1 còn đề xuất, chưa được duyệt theo rà soát R15); cần đưa vào SRS dưới dạng mục riêng khi trình duyệt.
2. HPM và EBS: chỉ có đặc tả phân hệ `HPM.md`, `EBS.md`; nội dung kỹ thuật chờ khách (PX-03, PX-04).
3. Thuyết minh có cấu trúc 8 trường và kế thừa kỳ trước (CN.02): thiết kế trong kế hoạch ENT-3b, chưa có trong FRD.
4. Quy trình duyệt cho lô số liệu vốn và nhập chỉ tiêu (QT.01): ENT-3c.
5. Lịch kỳ nhiều loại (QT.02): ENT-4c.
6. Phân quyền theo gói 09 đầu mối (HT.02): ENT-3d.

Lịch sử sửa: v0.1 khung ngày 2026-11-09.
