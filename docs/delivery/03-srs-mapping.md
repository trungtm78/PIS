# 03. Đối chiếu SRS: mã yêu cầu HSKT tới BRD, FRD và tài liệu thiết kế

Giai đoạn 2, sản phẩm 3 của mục II.5 (SRS). Dòng ma trận: GD.2, SP.03. PVFCCo phê duyệt: có (SRS).

Tài liệu này không chép lại yêu cầu. Nó chỉ ra, cho từng mã yêu cầu của hồ sơ kỹ thuật, đặc tả nằm ở đâu trong bộ thiết kế `Design/MACHVON_Design/01_Documents` để Tổ chuẩn hóa dữ liệu duyệt SRS bằng cách đọc đúng chỗ. Trạng thái xây dựng của từng mã nằm ở [../hskt/TRACEABILITY.md](../hskt/TRACEABILITY.md).

Trạng thái tệp (v0.2, 2026-11-12): đã điền từ bộ thiết kế và mã nguồn đến ngày 2026-11-12, sau khi các làn ENT-3a đến ENT-4e, INFRA-2, DOC-3 gộp vào nhánh chính. Bảng ở mục 2 chỉ ra đặc tả và tài liệu của từng mã; mục 2.10 thêm màn hình, thao tác thật và điều còn thiếu hoặc chờ khách (mã PX-nn); mục 3 liệt kê đoạn của SRS là bổ sung enterprise chưa nằm trong BRD, FRD. Khi ma trận truy vết và tệp này khác nhau thì tệp này phản ánh mã nguồn đến 2026-11-12 và ma trận sẽ được sinh lại từ `docs/hskt/requirements.json`. Việc PVFCCo duyệt SRS (PX-12) và các điểm chờ khách vẫn mở.

## 1. Cách đọc bộ thiết kế

| Tài liệu | Đường dẫn | Nói về | Ghi chú |
|---|---|---|---|
| Nghiên cứu và phân tích nguồn | `Design/MACHVON_Design/01_Documents/01_Nghien_cuu_va_phan_tich_nguon.md` | Căn cứ pháp lý, thị trường | |
| BRD | `.../02_BRD.md` | Mục tiêu, quy tắc kinh doanh `BR-xx`, `BR-Rxx` | Baseline 1.4 viết cho nền tảng đầu tư công; không nhắc HPM, EBS (kiểm lại bằng tìm kiếm ngày 2026-11-12: 0 lần nhắc ở BRD, FRD, thiết kế cơ bản, thiết kế chi tiết) |
| FRD | `.../03_FRD.md` | Use case `UC01` đến `UC28`, hợp đồng chung | Cùng ghi chú |
| Thiết kế cơ bản | `.../04_Thiet_ke_co_ban.md` | Kiến trúc, tenant, tích hợp bằng tệp, hạ tầng, SLO | |
| Thiết kế chi tiết | `.../05_Thiet_ke_chi_tiet.md` | Dữ liệu, thuật toán, API, lỗi, import tệp | |
| Đặc tả phân hệ | `.../05_modules/<MÃ>.md` | Mười hai mục theo `_KHUNG_DAC_TA.md`: luồng, trạng thái, quy tắc `BR-<MÃ>-NN`, API, kiểm thử | Các phân hệ bản enterprise (IND, RPT, DIR, HPM, EBS, HUB, INT, BAN, FEED, ORG, EQP, RML, PWA) chỉ có ở đây |
| UI/UX | `.../06_UI_UX_Design_System.md` | Hệ thiết kế | |
| Di động | `.../07_Smartphone_iOS_Android.md` | Ứng dụng điện thoại | |
| Quản trị dữ liệu | `.../08_Quan_tri_du_lieu_va_truong_thanh.md` | Master data, chất lượng, lineage | |
| Kế hoạch triển khai | `.../09_Ke_hoach_trien_khai.md` | Lộ trình, cutover, đào tạo, bàn giao | |
| Kiểm thử và chuyển đổi | `.../10_Ke_hoach_kiem_thu_va_chuyen_doi.md` | Tầng kiểm thử, migration rehearsal, cutover | |
| Catalogue kỹ thuật | `Design/MACHVON_Design/03_Engineering/*.json` | `screen_catalog.json`, `openapi.json`, `implementation_plan.json`, `traceability.json`, `test_cases.json` | Máy đọc được; ma trận truy vết đối chiếu với các tệp này |
| Kế hoạch từng làn enterprise | `docs/plans/ent3a.md`, `docs/plans/ent3b.md`, `docs/plans/ent3c.md`, `docs/plans/ent3d.md`, `docs/plans/ent3e.md`, `docs/plans/ent4a.md`, `docs/plans/ent4b.md`, `docs/plans/ent4c.md`, `docs/plans/ent4d.md`, `docs/plans/ent4e.md`, `docs/plans/infra1.md`, `docs/plans/infra2.md`, `docs/plans/int1.md`, `docs/plans/doc3.md`, `docs/plans/delivery1.md` | Quyết định thiết kế, bước đã làm, điều chưa làm của từng làn | Nguồn của các bổ sung enterprise chưa có trong BRD, FRD và chưa có trong `DIS.md`, `ADM.md`, `MDM.md` (mục 3); số màn hình trong kế hoạch có thể khác danh mục (DIS-30 và DIS-31 của kế hoạch ENT-3a nay là DIS-32 và DIS-33), lấy danh mục làm chuẩn |

Lưu ý trung thực: BRD và FRD baseline 1.4 mô tả nền tảng (đầu tư công) mà bản enterprise dùng chung. Những gì riêng của PVFCCo đã được xây sau baseline được ghi ở đặc tả phân hệ (ORG, EQP, RML, PWA, RPT, HPM, EBS, IND, DIR), ở kế hoạch từng làn và ở các tài liệu `docs/*.md` kèm theo, không ở BRD và FRD. Khi SRS được trình duyệt, nhà cung cấp phải nêu rõ đoạn nào là của nền tảng, đoạn nào là bổ sung enterprise; bảng dưới làm việc đó từng mã.

## 2. Bảng đối chiếu

Quy ước: `PRJ.md` là `Design/MACHVON_Design/01_Documents/05_modules/PRJ.md`. Viết tắt "TKCB" là thiết kế cơ bản (04), "TKCT" là thiết kế chi tiết (05). Cột "Tài liệu kho mã" là tệp `docs/` mô tả cách đã xây.

### 2.1 Master data (MD)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| MD.01 | `PRJ.md`, `MDM.md`, `INT.md` (ánh xạ mã đa hệ thống INT-03) | FRD UC28 (danh mục dự án và vòng đời), UC13 (dữ liệu chủ); 08 (master data); BR-R05 | `docs/prj-national-code-file.md`, `docs/mdm-succession.md`, `docs/mdm-merge.md`, `docs/hpm-ebs-connectors.md` (mục 3.1, mã dự án qua crosswalk), `docs/plans/ent3e.md` |
| MD.02 | `PRJ.md`, `DOC.md`, `PMT.md` | FRD UC23 (hồ sơ pháp lý), UC28; BR-R13, BR-R05 | `docs/prj-revisions.md`, `docs/prj-wbs.md`, `docs/doc-dossiers.md`, `docs/plans/ent3e.md` |
| MD.03 | `MDM.md`, `ADM.md` (ADM-05) | FRD UC13; 08 mục master data đầy đủ và hiệu lực theo thời gian | `docs/mdm-catalogue-dictionary.md`, `docs/plans/ent3d.md`, `docs/plans/ent4e.md` |

### 2.2 Bộ dữ liệu nền (DL)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| DL.01 | `DIS.md`, `IND.md`, `CAP.md` | FRD UC01; BR-R01, BR-R02, BR-R03; TKCT mục thuật toán tổng hợp | `docs/fnd-funding-model.md`, `docs/dis-rates.md`, `docs/dis-report.md`, `docs/plans/ent3a.md`, `docs/plans/ent3b.md` |
| DL.02 | `IND.md` | TKCT mục import tệp idempotent (A3) | `docs/ind-indicator-dictionary.md`, `docs/file-import.md` |
| DL.03 | `DIS.md` (DIS-21, DIS-22), `BI.md` | FRD UC02 (khóa kỳ); BR-R11, BR-R02 | `docs/dis-snapshot.md`, `docs/bi-datasets.md`, `docs/plans/ent3a.md` |

### 2.3 Quy trình (QT)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| QT.01 | `ADM.md` (ADM-06, ADM-15, ADM-18), `DIS.md`, `ORG.md` | FRD UC18 (thẩm quyền phê duyệt), UC02; BR-R04, BR-03 | `docs/adm-approval-workflow.md`, `docs/adm-doa-resolver.md`, `docs/dis-report-decision.md`, `docs/work-clocks.md`, `docs/plans/ent3c.md` |
| QT.02 | `DIS.md` (DIS-14, DIS-15, DIS-21, DIS-22), `MDM.md` (MDM-11), `ADM.md` (ADM-07), `DIR.md` | FRD UC02, UC19; BR-R11 | `docs/dis-report-progress.md`, `docs/adm-working-time.md`, `docs/dis-submission-board.md`, `docs/plans/ent4c.md`, `docs/teams-relay.md` |

### 2.4 Chức năng nghiệp vụ (CN)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| CN.01 | `CAP.md` | FRD UC03 (kế hoạch, phân bổ, điều chuyển); BR-R01 | `docs/capital-balances.md`, `docs/cap-ledger.md`, `docs/cap-reallocation.md`, `docs/plans/ent3e.md` |
| CN.02 | `DIS.md`, `IND.md`, `PRJ.md`, `EQP.md` | FRD UC01; BR-R02, BR-R03 | `docs/dis-report-submit.md`, `docs/dis-weekly-plan.md`, `docs/prj-explanation.md`, `docs/plans/ent3b.md`, `docs/plans/ent4e.md` |
| CN.03 | `DIR.md`, `PRJ.md`, `BAN.md`, `RML.md` | FRD UC19, UC28; BR-R10 | `docs/committee-workspace.md`, `docs/dis-warning.md`, `docs/prj-risk-signals.md`, `docs/plans/ent4d.md` |
| CN.04 | `EBS.md`, `DGV.md`, `DIS.md` (DIS-26) | FRD UC14; BR-R12 | `docs/hpm-ebs-connectors.md`, `docs/gov-d-cross-total.md`, `docs/dgv-reconciliation.md`, `docs/finance-feed.md`, `docs/report-engine.md` (mục so sánh chéo), `docs/plans/ent4a.md` |

### 2.5 Báo cáo (BC)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| BC.01 | `RPT.md`, `MNE.md`, `DOC.md` | FRD UC27 (mẫu pháp định), UC21; BR-R13 | `docs/report-engine.md`, `docs/dis-report-export.md`, `docs/mne-export.md`, `docs/plans/ent4b.md` |
| BC.02 | `HOME.md`, `BI.md`, `BAN.md`, `RML.md`, `PWA.md` | FRD UC19, UC10; BR-R06, BR-R10 | `docs/home-command-center.md`, `docs/bi-dashboards.md`, `docs/bi-exports.md`, `docs/plans/ent4d.md`, `docs/pwa.md` |

### 2.6 Tích hợp (TH)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| TH.01 | `HPM.md`, `HUB.md` | TKCB mục tích hợp dựa trên tệp và trạng thái adapter | `docs/hpm-ebs-connectors.md`, `docs/integration-hub.md`, `docs/integration/hpm-proposal.md`, `docs/plans/ent3c.md` |
| TH.02 | `INT.md`, `BI.md`, `HUB.md` | TKCB mục kiến trúc BI | `docs/open-api.md`, `docs/open-api/openapi.json`, `docs/bi-datasets.md`, `docs/integration/power-bi-model.md`, `docs/integration/machvon-bi.pbids`, `docs/integration/power-bi-sample-queries.sql` |
| TH.03 | `EBS.md`, `INT.md`, `HUB.md`, `ADM.md` (ADM-09) | TKCB mục tích hợp tệp | `docs/hpm-ebs-connectors.md`, `docs/open-api.md`, `docs/runbooks/infra/keycloak.md`, `docs/plans/ent3e.md` |

### 2.7 Quản trị hệ thống (HT)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| HT.01 | `SAS.md`, `ADM.md` (ADM-14) | TKCB mục hosting nội địa; mục ranh giới dữ liệu và cách ly | `docs/runbooks/infra/onprem-install.md`, `docs/runbooks/infra/tls-headers.md`, `docs/runbooks/infra/sizing-uat-prod.md`, `docs/runbooks/infra/lab-install-checklist.md` |
| HT.02 | `ADM.md`, `IAM.md`, `ORG.md` | FRD UC17, UC18; BR-R07 | `docs/adm-doa-resolver.md`, `docs/iam-self-service.md`, `docs/security/identity-test-plan.md`, `docs/plans/ent3d.md`, `infra/keycloak/onprem/ad-group-role-map.json` |
| HT.03 | `ADM.md` (ADM-04, ADM-25) | FRD UC18; BR-R04 | `docs/adm-delegation.md` |
| HT.04 | `ADM.md` (ADM-19 đến ADM-22), `IND.md`, `MDM.md`, `RPT.md` | TKCT mục quy tắc pháp lý và mẫu biểu là dữ liệu (R4); BR-R13 | `docs/governance-roadmap-10of10.md`, `docs/ind-indicator-dictionary.md`, `docs/plans/ent4b.md`, `docs/plans/ent4c.md` |
| HT.05 | `NFR` (nonfunctional_requirements.json), `BI.md` (BI-13) | TKCB mục SLO, RPO, RTO; 10 mục kiểm thử tải | `docs/qa/performance.md`, `docs/qa/perf-budget.json`, `docs/slo-error-budget.md`, `docs/runbooks/infra/sizing-uat-prod.md` |
| HT.06 | `ADM.md` (ADM-11, ADM-12) | TKCT mục kiểm thử và quan sát; BR-03 | `docs/runbooks/audit-export.md`, `docs/runbooks/retention.md`, `docs/plans/ent4e.md` |

### 2.8 Yêu cầu khác (YCK)

| Mã | Đặc tả phân hệ | BRD, FRD, thiết kế | Tài liệu kho mã |
|---|---|---|---|
| YCK.01 | `MOB.md`, `NOT.md`, `HOME.md`, `PWA.md` | FRD UC20, UC09; 07 (điện thoại) | `docs/pwa.md`, `docs/runbooks/browser-differences.md`, `docs/runbooks/notification-delivery.md`, `docs/teams-relay.md`, `docs/plans/ent4c.md` |
| YCK.02 | `SAS.md` | TKCB mục môi trường, CI/CD | `docs/runbooks/infra/environments.md`, `docs/runbooks/infra/onprem-install.md`, `docs/runbooks/infra/sizing-uat-prod.md` |
| YCK.03 | `SAS.md` | BR-05 (vận hành, license) | `docs/delivery/11-pending-external-register.md` (PX-17) |
| YCK.04 | `IND.md`, `DIS.md`, `INT.md` | TKCT mục import tệp idempotent | `docs/file-import.md`, `docs/open-api.md`, `docs/dis-report-import.md`, `docs/report-engine.md` (PDF, ENT-4b) |
| YCK.05 | `HUB.md`, `ADM.md` | TKCB mục triển khai vận hành và mở rộng | `docs/integration-hub.md`, `docs/kernel-release-compatibility.md`, `docs/runbooks/infra/onprem-upgrade-rollback.md` |
| YCK.06 | `SAS.md` (SAS-21) | TKCB mục sao lưu, khôi phục và DR | `docs/runbooks/infra/backup-immutable.md`, `docs/runbooks/infra/restore-drill.md`, `docs/plans/infra2.md`, `infra/backup/backup-policy.json` |
| YCK.07 | `IAM.md`, `ADM.md` (ADM-14) | TKCT mục kiểm thử; BR-R14, BR-R15 | `docs/security/pentest-readiness.md`, `docs/security/identity-test-plan.md`, `docs/runbooks/supply-chain.md`, `docs/security/ransomware-scenarios.md`, `docs/runbooks/infra/malware-scan.md`, `docs/runbooks/infra/security-scanning.md` |
| YCK.08 | `IND.md` (IND-02), `IAM.md` (IAM-08) | 06 (UI/UX) | `scripts/hdsd/chapters.json`, `scripts/help-index.mjs`, `apps/web/src/help/help.vi.json`, `docs/plans/doc3.md` |

### 2.9 Triển khai (TK)

| Mã | Tài liệu thiết kế | Tài liệu giao nhận |
|---|---|---|
| TK.01 | `09_Ke_hoach_trien_khai.md` mục vận hành, hỗ trợ, đào tạo và bàn giao | [07](07-training-plan.md) |
| TK.02 | `09_Ke_hoach_trien_khai.md` | [10](10-handover-checklist.md); `docs/admin-guide.md` (hướng dẫn quản trị), `docs/integration/hpm-proposal.md`, `docs/integration/power-bi-model.md` |
| TK.03 | `10_Ke_hoach_kiem_thu_va_chuyen_doi.md` mục migration rehearsal và đối soát | [06](06-data-conversion-plan.md) |
| TK.04 | `10_Ke_hoach_kiem_thu_va_chuyen_doi.md` mục cutover và rollback; `docs/dis-d03-signoff-pack.md` (cổng chạy song song hai kỳ) | [08](08-parallel-run-plan.md) |

### 2.10 Màn hình, thao tác và điều còn thiếu của bản enterprise theo mã yêu cầu

Mã màn hình theo `Design/MACHVON_Design/03_Engineering/screen_catalog.json`, tên thao tác theo `openapi.json` cùng thư mục; cột cuối nêu điều chưa có hoặc chờ khách, để SRS không hứa quá điều đã xây.

| Mã | Màn hình | Thao tác chính | Còn thiếu hoặc chờ khách |
|---|---|---|---|
| MD.01 | PRJ-01, PRJ-02, INT-03, MDM-35 | `listProjectCodes`, `proposeProjectCode`, `decideProjectCode`, `retireProjectCode` | Danh mục chính thức 22 + 01 + 09 hạng mục, mã HPM, mã EBS, cấp dưới dự án (PX-14) |
| MD.02 | PRJ-04, PRJ-07 | thao tác của PRJ | Danh mục loại văn bản và mốc vòng đời chính thức (PX-02); nối hệ thống văn thư (PX-07) |
| MD.03 | ADM-05, MDM-32, MDM-33 | thao tác của MDM | Giá trị chính thức của các danh mục (PX-02); nguồn và căn cứ chốt tỷ giá do khách cung cấp (không có mã PX riêng) |
| DL.01 | DIS-27, DIS-28, DIS-29, DIS-35 | `proposeFundingFigures`, `acceptFundingFigures`, `getFundingFigureHistory`, `getReportNarrativeContext` | Phạm vi quản lý số ước (câu B.4-2 của [01](01-as-is-survey-and-urd.md)); chỉ tiêu chính thức (PX-02) |
| DL.02 | IND-01, IND-02, IND-03 | `listIndicators`, `evaluateIndicatorEntry`, `previewIndicatorImport`, `importIndicatorFile` | Từ điển và quy tắc chính thức (PX-02) |
| DL.03 | DIS-21, DIS-22, DIS-32, DIS-33 | `buildEnterpriseSnapshot`, `freezeEnterpriseSnapshot`, `getEnterpriseSnapshot`, `getEnterpriseSnapshotReadiness` | Phạm vi dữ liệu lịch sử (PX-08) |
| QT.01 | ADM-06, ADM-15, ADM-18, DIS-06 | `submitFundingFigures`, `returnFundingFigures`, `enterIndicatorFigures`, `recordHpmReceipt` | Người giữ vai trò (PX-05); giao diện HPM thật cho bước PUSH (PX-03) |
| QT.02 | DIS-34, ADM-31, DIS-15, DIS-21, DIS-22 | `getReportingCalendar`, `getReportingCalendarBoard`, `requestPeriodReopen`, `decidePeriodReopen` | Hạn chính thức (D03); DIS-34 chưa theo dõi bước Ban KHĐT rà soát và bước đẩy HPM; email, Teams thật (PX-16) |
| CN.01 | CAP-03, CAP-05, CAP-06, HOME-07 | thao tác của CAP | Văn bản căn cứ thật của kế hoạch 2026 do Ban KHĐT cung cấp |
| CN.02 | DIS-35, EQP-01, EQP-02 | `inheritReportNarrative`, `listEquipmentProcurement`, `getEquipmentProcurement` | Nối eProcurement (PX-06) |
| CN.03 | DIR-01 đến DIR-06, PWA-04, HOME-09, BAN-01 | `getDirectivesForReport`, `getBlockedProjects`, `getDirectiveWidget` | Định nghĩa "vướng thủ tục" do Ban KHĐT xác nhận |
| CN.04 | EBS-02, DIS-26, RPT-09 | `reconcileEbs`, `listEbsDifferences`, `getReportCrosscheck`, `explainCrosscheckFinding` | Mẫu EBS thật (PX-04); dung sai và mức chặn (D03) |
| BC.01 | RPT-01 đến RPT-04, RPT-07, RPT-08 | `issueReport`, `getReportDraftFile`, `previewReportLayout` | Bố cục chính thức của sáu biểu mẫu (PX-01); mẫu Sở/Ban/Ngành (PX-15) |
| BC.02 | HOME-09, BAN-01, BI-02, PWA-03, RML-01 | `getLeaderRates`, `createReportMailSchedule`, `listReportMailings` | Email thật (PX-16); số kỳ thực (PX-13) |
| TH.01 | HPM-01, HPM-02 | `submitHpmPush`, `retryHpmPush`, `recordHpmReceipt`, `proposeHpmCorrection`, `decideHpmCorrection` | Giao diện kỹ thuật HPM (PX-03); bộ chuyển tiếp API chưa có |
| TH.02 | INT-01, INT-02, INT-04, INT-05 | `createBiReader`, `listBiDatasets`, `listOpenDatasets`, `issueOpenApiToken` | Chưa có tập dữ liệu chứng nhận cho bản chốt doanh nghiệp (số liệu vốn, chỉ tiêu); cách Lakehouse nhận (PX-11) |
| TH.03 | EBS-01, EBS-02, INT-03 | `importEbsFile`, `reconcileEbs`, `getOpenApiDocument` | Đọc trực tiếp DB của EBS (PX-04); eProcurement (PX-06); văn thư (PX-07); xác thực tập trung (PX-16) |
| HT.02 | ORG-01, ADM-15, ADM-27 | `getEnterpriseOrgPack`, `materialiseEnterpriseOrgPack` | Danh sách đầu mối, người, tên hai Tổ dự án (PX-05); nhóm AD (PX-16) |
| HT.03 | ADM-04, ADM-25, ADM-26 | thao tác của ADM | không |
| HT.04 | ADM-19 đến ADM-22, ADM-31, RPT-07, RPT-08 | thao tác kho quy tắc, `previewReportLayout` | không |
| HT.05 | không có màn riêng | không có | Đo trên phần cứng khách (PX-10); `docs/qa/perf-budget.json` chưa có dòng cho đọc bản chốt doanh nghiệp, so sánh chéo, lịch kỳ và PDF |
| HT.06 | ADM-11, ADM-12, ADM-29, ADM-30 | `saveAuditDetailPolicy`, `getLogCapacity`, `saveLogCapacityPolicy` | Giá trị trước, sau mới nối cho mở lại kỳ và đẩy HPM; số giới hạn log do Ban CĐS&CNTT đặt |
| YCK.01 | PWA-01 đến PWA-10 | không có | Email, Teams, SSO, MFA thật (PX-16, PX-11) |
| YCK.04 | IND-03, DIS-10, RPT-02 | `importIndicatorFile`, `issueReport` | không |
| YCK.06 | ADM-32 | `requestBackup`, `decideBackupRequest`, `recordBackupOutcome` | Diễn tập khôi phục có biên bản (PX-11) |
| YCK.07 | ADM-14 | không có | Pentest độc lập (PX-09); nhập thử realm Keycloak trên máy thật (PX-16) |
| YCK.08 | nút trợ giúp trên mọi màn web (594 màn), IAM-08 | không có | Bản tiếng Anh của hướng dẫn chưa có (không thuộc yêu cầu) |

## 3. Khoảng trống của bộ thiết kế so với hồ sơ kỹ thuật

Những điểm SRS phải bổ sung hoặc Tổ chuẩn hóa dữ liệu phải xác nhận vì bộ thiết kế baseline chưa nêu hoặc đặc tả phân hệ chưa cập nhật. Phần lớn đã được xây (xem mục 2.10); điều còn thiếu cho SRS là đưa chúng vào bộ thiết kế:

1. Mô hình sáu biểu mẫu của PVFCCo và dữ liệu nền một lần: nằm ở `docs/report-engine.md`, `docs/ind-indicator-dictionary.md`, `docs/fnd-funding-model.md` (spec FND-1 còn đề xuất, chưa được duyệt theo rà soát R15); cần đưa vào SRS dưới dạng mục riêng khi trình duyệt. Khi đọc mục 13 của `docs/fnd-funding-model.md`, lưu ý đoạn "chưa dựng lệnh dựng và chốt bản chốt enterprise" đã được làn ENT-3a hoàn thành (`packages/db/src/enterprise-snapshot-store.ts`, DIS-32, DIS-33).
2. HPM và EBS: có đặc tả phân hệ `HPM.md`, `EBS.md` và đề xuất phương thức `docs/integration/hpm-proposal.md`; nội dung kỹ thuật chờ khách (PX-03, PX-04).
3. Thuyết minh có cấu trúc 8 trường, kế thừa kỳ trước, nguyên nhân chuẩn (CN.02): đã xây (DIS-35, `packages/kernel/src/ent-narrative.ts`, `docs/plans/ent3b.md`) nhưng chưa có trong FRD và chưa có trong `DIS.md`.
4. Quy trình duyệt cho lô số liệu vốn và nhập chỉ tiêu, bước PUSH chờ biên nhận, điều chỉnh ở kỳ sau (QT.01, TH.01): đã xây (`docs/adm-approval-workflow.md`, `docs/hpm-ebs-connectors.md` mục 6, `docs/plans/ent3c.md`) nhưng chưa có trong `ADM.md`, `DIS.md`.
5. Lịch kỳ nhiều loại, hạn từng bước, nhắc việc (QT.02): đã xây (`docs/plans/ent4c.md`, `packages/kernel/src/reporting-schedule.ts`) nhưng chưa có trong `DIS.md`, `MDM.md`, `ADM.md`.
6. Phân quyền theo gói 09 đầu mối (HT.02): đã có đặc tả `ORG.md` và `docs/plans/ent3d.md`.
7. So sánh chéo trước phát hành, PDF, bố cục cấu hình không cần lập trình (CN.04, BC.01, HT.04): có ở `RPT.md` và `docs/report-engine.md`; trình chiếu, tỷ lệ so kế hoạch năm, email theo lịch (BC.02) ở `RML.md`; mua sắm trang thiết bị (CN.02) ở `EQP.md`.
8. Nhật ký giá trị trước và sau, giới hạn log (HT.06), sao lưu thủ công và chu kỳ sao lưu (YCK.06): đã xây (`docs/plans/ent4e.md`, `docs/plans/infra2.md`, `docs/runbooks/audit-export.md`, `docs/runbooks/retention.md`) nhưng chưa có trong `ADM.md`.
9. Bộ tài liệu DOC-3 đã có: hướng dẫn trên màn hình, hướng dẫn quản trị, đề xuất phương thức tích hợp HPM, mô hình Power BI, cấu hình khuyến nghị. Hướng dẫn quản trị `docs/admin-guide.md` chưa nói tới ADM-29 đến ADM-32, ORG-01, RPT-07 đến RPT-09 và RML-01; cần bổ sung trước khi bàn giao (SP.10).
10. Bộ UAT theo phân hệ chưa có tệp `docs/uat/<phân hệ>/uat.json` cho IND, RPT, DIR, HPM, EBS, ORG, EQP, RML (GD.3; xem [05](05-sit-uat-scripts.md)).

Lịch sử sửa: v0.1 khung ngày 2026-11-09. v0.2 ngày 2026-11-12, rà soát bởi làn aud4: thêm dòng trạng thái; thêm vào mục 1 các phân hệ ORG, EQP, RML, PWA và hàng kế hoạch từng làn; bổ sung vào mục 2 các đặc tả phân hệ, kế hoạch làn và tài liệu mới cho các mã MD.01 đến YCK.08 đã có làn xây; thêm mục 2.10 (màn hình, thao tác, điều còn thiếu); viết lại mục 3 (sáu khoảng trống cũ nay là đã xây, thêm các khoảng trống thật còn lại).
