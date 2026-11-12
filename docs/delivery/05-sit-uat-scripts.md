# 05. Kịch bản kiểm thử SIT và UAT theo mã yêu cầu

Giai đoạn 3 (sản phẩm: kịch bản kiểm thử) và giai đoạn 4 (biên bản UAT, danh sách lỗi). Dòng ma trận: GD.3, GD.4, SP.05. PVFCCo phê duyệt: kịch bản kiểm thử (GĐ 3); biên bản UAT (GĐ 4).

Tệp này nối mỗi mã yêu cầu của hồ sơ kỹ thuật với (a) kiểm thử tích hợp hệ thống (SIT) mà nhà cung cấp chạy tự động trong kho mã, (b) ca UAT của các đầu mối trong `docs/uat/<phân hệ>/uat.json`, (c) khoảng trống kiểm thử đã biết. Tệp không chứa kết quả chạy: kết quả chỉ có giá trị khi sinh từ lượt chạy có bằng chứng (mục 5).

Trạng thái tệp: v0.2, rà soát ngày 2026-11-12 sau khi các làn ENT-3a đến ENT-3e, ENT-4a đến ENT-4e, INFRA-2 và DOC-3 đã gộp vào main. Phần SIT của các làn đó đã có tệp kiểm thử (cột SIT của mục 3). Kịch bản chưa được Tổ chuẩn hóa dữ liệu duyệt (phiếu giai đoạn 3, PX-12). Phần UAT của bản enterprise chưa chuyển hết thành `uat.json`: 399 trên 1496 ca của bộ thiết kế chưa có trong `docs/uat` (mục 4).

---

## 1. Hai tầng kiểm thử

| Tầng | Ai chạy | Chạy ở đâu | Công cụ trong kho mã | Kết quả |
|---|---|---|---|---|
| SIT | Nhà cung cấp | Môi trường kiểm thử của nhà cung cấp, sau đó trên UAT của PVFCCo | Kiểm thử đơn vị và tích hợp (Jest, Vitest, `node --test`) trên cơ sở dữ liệu thật; route walk và visual của web (`docs/runbooks/web-e2e.md`, làn trình duyệt gồm cả Edge: `.github/workflows/browsers.yml`); kiểm tra tĩnh trong `npm run lint` và `npm run qa:check` (trợ năng, ngân sách hiệu năng, trợ giúp trên màn hình, ma trận HSKT) | Báo cáo chạy của nhà cung cấp kèm bản dựng |
| UAT | Đầu mối cùng nhà cung cấp, theo kịch bản đã duyệt | Môi trường UAT của PVFCCo | Ca trong `docs/uat/<phân hệ>/uat.json` (hợp đồng handoff của uat-test-writer); chạy bằng Playwright, Maestro hoặc tay; kết quả vào kho `docs/uat-run-results.json` rồi sinh `docs/UAT-EVIDENCE.md` bằng `npm run uat:evidence` | Biên bản UAT (mẫu: [09](09-acceptance-minutes-template.md)); danh sách lỗi |

Cách chạy tầng SIT trên cơ sở dữ liệu: các suite dùng chung một máy chủ PostgreSQL thử và xếp hàng qua `scripts/lane.mjs` (`docs/runbooks/test-lanes.md`). Nền tảng của ca UAT hiện có: web 857, API 163, Android 77 (`docs/uat/INDEX.md`, 26 phân hệ, 1097 ca; thư mục `docs/uat/critical` là lát cắt 28 ca then chốt nằm trong các phân hệ, không cộng trùng).

Trước UAT của PVFCCo đã có một lượt chạy phát triển do tác tử UAT thực hiện, chỉ báo cáo, không sửa mã: `docs/uat/RUN-2026-11-09-r2.md` (bản dựng ce52f5f6b, đã gồm các làn ENT-3, ENT-4, INFRA-2, DOC-3). Công cụ kết luận NO-RUN cho bản enterprise; đây là bằng chứng phát triển, không phải UAT ký nghiệm thu. Các lượt sau được ghi ở `PROGRESS.md`; chưa có tổng hợp tương ứng trong `docs/uat`.

## 2. Cổng nghiệm thu theo hồ sơ kỹ thuật (giai đoạn 4)

1. SIT do nhà cung cấp thực hiện và nộp báo cáo trước UAT.
2. UAT cùng các đầu mối theo kịch bản đã được PVFCCo phê duyệt (giai đoạn 3).
3. Khắc phục lỗi; mọi lỗi mức nghiêm trọng đóng trước khi sang giai đoạn 5.
4. Mục dựng trên giả định chờ khách (HPM, EBS, mẫu biểu chính thức, từ điển chỉ tiêu) ghi PENDING-EXTERNAL và không tính là đạt (quy tắc R18). Sổ ở [11](11-pending-external-register.md).
5. Điều kiện bắt buộc cho nghiệm thu: kết quả pentest độc lập đạt (YCK.07, PX-09).

## 3. Kịch bản theo mã yêu cầu

Cột "SIT" là tệp kiểm thử trong kho mã hoặc nhóm kiểm thử (đã kiểm tra đường dẫn tồn tại ngày 2026-11-12). Cột "Ca UAT" là mã ca trong `docs/uat/<phân hệ>/uat.json` (chỉ nêu ví dụ tiêu biểu; danh mục đầy đủ ở tệp). Cột "Khoảng trống" nêu điều chưa có kịch bản hoặc chưa chạy được vì chờ khách.

### 3.1 MD, DL

| Mã | Kịch bản chính (UAT) | SIT | Ca UAT ví dụ | Khoảng trống |
|---|---|---|---|---|
| MD.01 | Tạo dự án, kiểm tra mã duy nhất, thêm ánh xạ mã HPM và EBS (`proposeProjectCode`, `decideProjectCode` ở INT-03), lọc theo nhóm, loại hình (kể cả loại `ENT_PROJECT_TYPE` của bản enterprise), giai đoạn | `apps/api/test/prj`, `apps/api/test/int`, `apps/api/test/mdm/master-crosswalk.test.ts`, `packages/db/test/master-crosswalk-store.test.ts`, `packages/edition-enterprise/src/integration/project-code-resolver.test.ts`, `packages/edition-enterprise/src/integration/project-codes.test.ts`, `packages/edition-enterprise/src/integration/hpm-project-codes.test.ts` | `docs/uat/prj` (43 ca), `docs/uat/mdm` (58 ca): TC-UAT-AC203, TC-UAT-AC276 | Chưa có ca UAT cho mã EBS và HPM theo dự án và loại dự án enterprise (ENT-3e đã gộp; chưa có `docs/uat/int`); danh sách mã thật: PX-14 |
| MD.02 | Thêm văn bản pháp lý có tệp, ghi mốc kế hoạch và thực tế, xem lịch sử phiên bản kế hoạch; chọn mốc vòng đời và loại hồ sơ theo danh mục enterprise (`ENT_LIFECYCLE_MILESTONE`, `ENT_LEGAL_DOC_TYPE`) | `apps/api/test/prj`, `apps/api/test/doc`, `packages/edition-enterprise/src/integration/ent-catalogue.test.ts` | `docs/uat/prj`, `docs/uat/doc` (56 ca) | Chưa có ca UAT cho danh mục enterprise; nối hệ thống văn thư: PX-07 |
| MD.03 | Sửa danh mục bằng đề xuất và duyệt hai người; đơn vị không tự sửa; nhập tỷ giá `FX_RATE` theo kỳ và có văn bản căn cứ | `apps/api/test/mdm`, `packages/kernel/src/fx-rate.test.ts` | `docs/uat/mdm`: TC-UAT-AC48, TC-UAT-AC46 | Chưa có ca UAT cho tỷ giá (ENT-4e); loại báo cáo và cơ quan nhận chưa thấy danh mục MDM riêng (xem 03) |
| DL.01 | Nhập một số liệu, thấy lũy kế và tỷ lệ tự tính; nhập số ước rồi số thực, xem lịch sử; viết thuyết minh 8 trường, kế thừa kỳ trước, chọn nguyên nhân chuẩn MDM-17 (DIS-35) | `apps/api/test/fnd`, `apps/api/test/dis`, `packages/kernel/test/fnd-figures.test.ts`, `packages/kernel/test/ent-narrative.test.ts`, `packages/db/test/ent-narrative-store.test.ts`, `apps/web/src/screens/dis/narrative/NarrativeScreen.test.tsx` | `docs/uat/dis` (69 ca) | Chưa có ca UAT cho thuyết minh có cấu trúc (ENT-3b, ENT-4e); phạm vi quản lý số ước chờ Ban KHĐT (mục 4 của sổ 11) |
| DL.02 | Nhập sai theo từng quy tắc (lũy kế vượt tổng mức đầu tư, vốn không cân, kỳ đã chốt, thiếu trường); nhập tệp Excel: chạy thử, áp dụng, áp dụng lại cùng tệp | `apps/api/test/ind/ind.test.ts`, `apps/api/test/ind/ind-staged-approval.test.ts`, `packages/kernel/test/ind-entry.test.ts`, `packages/kernel/test/ind-import-mapping.test.ts` | chưa có thư mục `docs/uat/ind` (bộ thiết kế có UI-IND-01 đến 03 chưa thành `uat.json`) | Cần ca UAT cho IND-01 đến IND-03; từ điển chính thức: PX-02 |
| DL.03 | Chốt kỳ, mở lại kỳ, xem bản chốt đúng số đã báo cáo, so cùng kỳ; dựng và chốt bản chốt kỳ doanh nghiệp (DIS-32, DIS-33) | `apps/api/test/dis/snapshot.test.ts`, `apps/api/test/dis/period-reopen.test.ts`, `apps/api/test/dis/golden.test.ts`, `apps/api/test/fnd/enterprise-snapshot.test.ts`, `packages/db/test/enterprise-snapshot-store.test.ts`, `packages/kernel/test/enterprise-snapshot.test.ts` | `docs/uat/dis`: TC-UAT-AC03 (409 PERIOD_LOCKED), TC-UAT-AC246 (lý do mở lại) | Chưa có ca UAT cho bản chốt enterprise (ENT-3a): kỳ chưa đủ số liệu bị từ chối `ENTERPRISE_SNAPSHOT_INCOMPLETE`, chốt lại có đánh số bản |

### 3.2 QT, CN

| Mã | Kịch bản chính (UAT) | SIT | Ca UAT ví dụ | Khoảng trống |
|---|---|---|---|---|
| QT.01 | Đi hết luồng nhập, duyệt đơn vị, Ban KHĐT, chốt, đẩy HPM (bước PUSH giữ chờ biên nhận); trả về có lý do; người nhập không tự duyệt; cấu hình lại bước; cùng một quy trình cho báo cáo DIS, lô số liệu vốn FND và lô chỉ tiêu IND | `packages/kernel/test/dis-report-workflow.test.ts`, `apps/api/test/dis/report-staged-approval.test.ts`, `apps/api/test/dis/report-push-hold.test.ts`, `apps/api/test/ind/ind-staged-approval.test.ts`, `apps/api/test/adm` | `docs/uat/adm`: TC-UAT-AC111 (SELF_APPROVAL_DENIED), `docs/uat/dis`: TC-UAT-AC05 | Chưa có ca UAT cho PUSH giữ chờ biên nhận (ENT-3c); kết quả với HPM thật: PX-03 |
| QT.02 | Sinh kỳ tháng, quý, năm, giao ban; hạn từng bước theo quy tắc `REPORTING_SCHEDULE` (DIS-34, ADM-31); quá hạn nhập sang kỳ trễ, chốt, mở lại; tiến độ nộp từng đầu mối; nhắc việc | `apps/api/test/dis/reporting-period.test.ts`, `apps/api/test/dis/submission-progress.test.ts`, `apps/api/test/dis/period-reopen.test.ts`, `packages/kernel/test/reporting-schedule.test.ts`, `packages/kernel/test/reporting-board.test.ts`, `packages/db/test/reporting-calendar.test.ts`, `apps/web/src/screens/dis/calendar/calendar-screens.test.tsx` | `docs/uat/dis`: TC-UAT-PLAN-66 | Chưa có ca UAT cho lịch quý, năm, giao ban (ENT-4c); hạn là giá trị khởi đầu UNVERIFIED chờ Tổ chuẩn hóa dữ liệu; email, Teams thật: PX-16 |
| CN.01 | Lập kế hoạch năm, phân bổ, điều chỉnh có văn bản; nguồn `GROUP_ASSIGNED`, `BOARD_APPROVED`, `CARRYOVER` của bản enterprise có văn bản căn cứ đúng loại | `apps/api/test/cap`, `packages/kernel/test/fnd-origin-pack.test.ts`, `packages/db/test/cap-enterprise-origin.test.ts`, `apps/web/src/screens/cap/enterprise-origin.test.ts` | `docs/uat/cap` (54 ca): TC-UAT-AC230, TC-UAT-PLAN-64 | Chưa có ca UAT cho nguồn enterprise (ENT-3e) |
| CN.02 | Nhập và duyệt số liệu thực hiện, giải ngân; xem lũy kế và tỷ lệ; xem mua sắm trang thiết bị dự án (EQP-01, EQP-02) | `apps/api/test/dis`, `apps/api/test/fnd`, `packages/kernel/src/equipment-procurement.test.ts`, `apps/web/src/editions/enterprise/screens/eqp/EquipmentScreens.test.tsx` | `docs/uat/dis` | Chưa có ca UAT cho EQP (ENT-4e); kết nối eProcurement: PX-06 |
| CN.03 | Ghi cuộc giao ban, giao chỉ đạo, ghi tiến độ, gia hạn, đóng; xem chỉ đạo quá hạn; chỉ đạo vào thuyết minh kỳ sau (DIR-05) | `apps/api/test/dir/directive.test.ts`, `packages/kernel/test/directive.test.ts`, `packages/kernel/test/ent-narrative.test.ts` | chưa có thư mục `docs/uat/dir` | Cần ca UAT cho DIR-01 đến DIR-06 |
| CN.04 | Nạp tệp EBS, chạy thử, áp dụng; đối chiếu; giải trình chênh lệch; so sánh chéo báo cáo cùng kỳ (RPT-09) và kiểm tổng chéo giải ngân (DIS-26) | `apps/api/test/editions/ebs.enterprise.test.ts`, `apps/api/test/reports/crosscheck.enterprise.test.ts`, `packages/kernel/test/report-crosscheck.test.ts`, `packages/db/test/report-crosscheck-store.test.ts`, `apps/web/src/screens/rpt/crosscheck/CrosscheckScreen.test.tsx`, `apps/api/test/dis` | chưa có thư mục `docs/uat/ebs` và `docs/uat/rpt` | UAT cho EBS và so sánh chéo (ENT-4a đã gộp); ngưỡng chênh lệch và mẫu EBS thật: PX-04 |

### 3.3 BC, TH

| Mã | Kịch bản chính (UAT) | SIT | Ca UAT ví dụ | Khoảng trống |
|---|---|---|---|---|
| BC.01 | Lập từng biểu mẫu cho một kỳ từ bản chốt, duyệt ba người, phát hành, tải Excel, Word, PDF; kiểm bản đồ ô đúng mẫu; so sánh chéo trước phát hành (RPT-09); soạn bố cục biểu mẫu nội bộ không lập trình (RPT-07, RPT-08) | `packages/edition-enterprise/test/report-forms.test.ts`, `packages/edition-enterprise/test/snapshot-data.test.ts`, `apps/api/test/reports/report-engine.test.ts`, `apps/api/test/reports/report-engine.enterprise.test.ts`, `apps/api/test/reports/report-engine.snapshot.enterprise.test.ts`, `apps/api/test/reports/report-pdf.test.ts`, `apps/api/test/reports/report-pdf.golden.enterprise.test.ts`, `apps/api/test/reports/configured-forms.test.ts`, `packages/kernel/test/report-layout.test.ts`, `packages/kernel/test/report-layout-config.test.ts` | chưa có thư mục `docs/uat/rpt` | UAT cho RPT; mẫu chính thức: PX-01, PX-15; sáu biểu mẫu còn dấu MẪU DEMO |
| BC.02 | Lãnh đạo mở dashboard, thấy tỷ lệ, chậm tiến độ, chỉ đạo quá hạn; truy nguồn; chế độ trình chiếu; tạo báo cáo; gửi lịch qua email | `apps/api/test/home`, `apps/api/test/bi`, `apps/api/test/editions/leader-rates.enterprise.test.ts`, `packages/edition-enterprise/src/leader/rates.test.ts`, `packages/edition-enterprise/src/delivery/delivery-runner.test.ts`, `apps/web/src/ui/PresentationMode.test.tsx` | `docs/uat/home` (19 ca): TC-UAT-AC266, TC-UAT-AC267; `docs/uat/bi` (37 ca) | Chưa có ca UAT cho bảng tỷ lệ enterprise, trình chiếu và gửi báo cáo theo lịch (ENT-4d); email thật: PX-16 |
| TH.01 | Đẩy một biểu mẫu đã phát hành, nhận lỗi, đẩy lại cùng khóa, ghi biên nhận, đính chính kỳ đã nhận (ghi đè hoặc điều chỉnh ở kỳ sau) | `apps/api/test/editions/hpm.enterprise.test.ts`, `apps/api/test/editions/hpm-adjustment.enterprise.test.ts` | chưa có thư mục `docs/uat/hpm` | UAT cho HPM; mọi kết quả trên bộ ghi tệp là PENDING-EXTERNAL (PX-03) |
| TH.02 | Mở tài khoản máy, lấy token, đọc tập dữ liệu chứng nhận; đăng nhập BI chỉ đọc; mô hình Power BI mẫu (`docs/integration/power-bi-model.md`, `docs/integration/machvon-bi.pbids`) | `apps/api/test/int`, `apps/api/test/isolation` | chưa có thư mục `docs/uat/int` | UAT cho INT; thử mô hình mẫu trên Power BI và Lakehouse thật: PX-11 |
| TH.03 | Đối chiếu EBS (xem CN.04); xem sức khỏe kết nối ở hub (HUB-01 đến HUB-03); gọi API mở không phí | `apps/api/test/hub`, `apps/api/test/int` | chưa có thư mục `docs/uat/hub` | UAT cho HUB; eProcurement, văn thư: PX-06, PX-07 |

### 3.4 HT, YCK

| Mã | Kịch bản chính (UAT) | SIT | Ca UAT ví dụ | Khoảng trống |
|---|---|---|---|---|
| HT.01 | Kiểm cách ly dữ liệu, TLS, tiêu đề bảo mật trên UAT | `apps/api/test/isolation`, `apps/api/test/conformance` | `docs/uat/nfr` (69 ca), `docs/uat/critical` (28 ca): TC-UAT-NFR-TENANCY-02 | Chạy trên máy chủ PVFCCo (PX-11) |
| HT.02 | Mỗi vai trò chỉ thấy và làm đúng việc; đầu mối chỉ thấy dự án mình; vượt quyền bị chặn; nạp gói cấu hình PVFCCO-TEMPLATE (ORG-01) qua lô chuyển đổi, người duyệt khác người đăng ký | `apps/api/test/authz`, `apps/api/test/adm`, `apps/api/test/editions/org-pack.enterprise.test.ts`, `packages/edition-enterprise/test/org-pack.test.ts`, `packages/kernel/test/org-pack.test.ts` | `docs/uat/adm`: TC-UAT-AC103, TC-UAT-AC105, TC-UAT-AC106 | Chưa có ca UAT cho gói PVFCCO-TEMPLATE (ENT-3d); gói chỉ mang dữ liệu mẫu, tên thật chờ PX-05, nhóm AD thật chờ PX-16 |
| HT.03 | Ủy quyền có hạn, ủy quyền vĩnh viễn, thu hồi; người nhận làm thay và được ghi | `apps/api/test/adm` | `docs/uat/adm` | Không |
| HT.04 | Đổi quy tắc nhập liệu hoặc công thức chỉ tiêu qua quy tắc quản trị: soạn, trình, duyệt khác người, có hiệu lực; đổi hạn từng bước của lịch kỳ (ADM-31); soạn bố cục biểu mẫu (RPT-08) | `apps/api/test/gov`, `packages/kernel/test/reporting-schedule.test.ts`, `packages/kernel/test/report-layout-config.test.ts` | `docs/uat/adm` | Chưa có ca UAT cho lịch kỳ và bố cục cấu hình (ENT-4b, ENT-4c) |
| HT.05 | Đo thời gian phản hồi (5 giây) và thời gian sinh báo cáo (20 giây) theo `docs/qa/perf-budget.json`: 82 thao tác, trong đó 67 lớp FUNCTION và 15 lớp REPORT, đo p95 trên 20 mẫu | `scripts/perf-budget.mjs`, `scripts/perf-budget.test.mjs`, `docs/qa/performance.md` | `docs/uat/nfr`: TC-UAT-PLAN-11 | Chưa có dòng ngân sách cho PDF biểu mẫu và đọc bản chốt enterprise; đo trên phần cứng khách (PX-10) |
| HT.06 | Mỗi thao tác tạo, sửa, duyệt, chốt, mở lại, đẩy HPM có dòng nhật ký; xuất nhật ký (ADM-11); giá trị trước và sau theo loại đối tượng (ADM-29); giới hạn số lượng và dung lượng log (ADM-30) | `apps/api/test/adm`, `apps/api/test/conformance`, `packages/kernel/src/audit-detail.test.ts`, `packages/db/test/audit-detail.test.ts`, `packages/kernel/src/log-capacity.test.ts`, `packages/db/test/log-capacity-job.test.ts` | `docs/uat/adm`, `docs/uat/nfr`: TC-UAT-NFR-SECURITY-11 | Chưa có ca UAT cho ADM-29 và ADM-30 (ENT-4e); chính sách chi tiết mặc định tắt, PVFCCo chọn loại đối tượng bật |
| YCK.01 | Cài PWA, duyệt trong hàng đợi, xem dashboard, theo dõi chỉ đạo (PWA-04), nhận thông báo; thử trên Chrome, Firefox, Edge, Safari | `apps/web/src/pwa/PwaSessionGuard.test.tsx`, `apps/web/src/pwa/screens`, `apps/web/e2e/support/browsers.test.ts`, `apps/api/test/notifications/smtp-adapter.test.ts`, `apps/api/test/notifications/teams-webhook-adapter.test.ts` | `docs/uat/mob` (88 ca): TC-UI-MOB-03, TC-UAT-PLAN-36 | Chưa có `docs/uat/pwa` (14 ca UI và PLAN của PWA ở bộ thiết kế chưa thành `uat.json`); email, Teams thật: PX-16; Safari mới được thử bằng động cơ WebKit trong làn CI (`docs/runbooks/browser-differences.md`), chưa thử trên Safari thật |
| YCK.02 | Cài bản vào UAT và Production từ gói ngoại tuyến; nâng cấp, quay lui; đối chiếu cấu hình khuyến nghị `docs/runbooks/infra/sizing-uat-prod.md` | `scripts/onprem-bundle.mjs`, `scripts/onprem-bundle.test.mjs`, `scripts/infra-check.mjs` | `docs/uat/nfr` | Cài thật trên máy chủ PVFCCo (PX-11); số người dùng (PX-17) |
| YCK.03 | Tạo tài khoản với số lượng lớn, không bị chặn bản quyền | `apps/api/test/provisioning` | `docs/uat/sas` | Số người dùng ước tính (PX-17); gói và hạn mức ghế của PVFCCo |
| YCK.04 | Nhập CSV, XLSX; xuất Excel, Word, PDF; gọi API | `apps/api/test/dis`, `apps/api/test/int`, `apps/api/test/files`, `apps/api/test/reports/report-pdf.test.ts` | `docs/uat/dis`: TC-UAT-AC261 (tệp xuất) | PDF biểu mẫu đã dựng (ENT-4b), chưa có ca UAT |
| YCK.05 | Thêm chỉ tiêu, quy tắc mới bằng cấu hình; nâng cấp giữ cấu hình | `apps/api/test/gov`, `apps/api/test/hub` | `docs/uat/adm` | Không |
| YCK.06 | Sao lưu, khôi phục sang môi trường thử, so băm; kiểm tra bản bất biến; chu kỳ ngày, tuần (differential), tháng (kho lưu trữ thứ hai), giữ tối thiểu 03 bản; yêu cầu sao lưu thủ công có người duyệt (ADM-32) | `scripts/backup-verify.mjs`, `scripts/backup-verify.test.mjs`, `scripts/backup-cycles.test.mjs`, `scripts/restore-drill.mjs`, `apps/api/test/adm/backup-request.test.ts`, `packages/db/test/backup-request.test.ts`, `packages/kernel/test/backup-request.test.ts` | `docs/uat/critical` (nhóm restore), `docs/uat/sas` | Chưa có bằng chứng diễn tập khôi phục: sổ `infra/backup/restore-drill-ledger.json` còn trống, hạn diễn tập đầu 2027-01-31; cần máy sạch ở địa điểm thứ hai (PX-11) |
| YCK.07 | Chạy pentest độc lập theo `docs/security/pentest-readiness.md`; kiểm thử xác thực, MFA, khóa tài khoản; quét mã độc tệp tải lên; kiểm tra đường ra mạng; kịch bản ransomware | `docs/security/identity-test-plan.md`, `apps/api/test/auth`, `apps/api/test/session`, `apps/api/test/files/clamd-scan.test.ts`, `scripts/egress-rules.test.mjs`, `docs/security/ransomware-scenarios.md` | `docs/uat/iam` (20 ca): TC-UAT-AC121; `docs/uat/nfr`: TC-UAT-NFR-SECURITY-03 | Pentest độc lập (PX-09); nhập thử realm Keycloak và thử EICAR, egress trên máy thật theo `docs/runbooks/infra/lab-install-checklist.md` (PX-11, PX-16) |
| YCK.08 | Bỏ trống trường bắt buộc thấy lỗi ngay; giao diện tiếng Việt; mở trợ giúp trên màn hình bằng nút trợ giúp hoặc phím `?` (594 màn hình có hướng dẫn) | `apps/web/src/help/help-index.test.ts`, `scripts/help-index.test.mjs`, `scripts/a11y-lint.mjs` | `docs/uat/iam` | Chưa có ca UAT cho ngăn trợ giúp (DOC-3 đã gộp); chương hướng dẫn riêng cho IND, RPT, DIR, HPM, EBS chưa có (xem 07) |

### 3.5 TK

| Mã | Kịch bản | Tài liệu |
|---|---|---|
| TK.01 | Kiểm tra sau đào tạo: người học làm lại bài thực hành của chương mình | [07](07-training-plan.md) |
| TK.02 | Rà soát bộ tài liệu theo danh mục bàn giao | [10](10-handover-checklist.md) |
| TK.03 | Chạy thử chuyển đổi trên bản sao, đối soát số dòng và tổng tiền, Ban KHĐT ký | [06](06-data-conversion-plan.md) |
| TK.04 | Chạy song song hai kỳ, đối chiếu từng chỉ tiêu | [08](08-parallel-run-plan.md) |

## 4. Khoảng trống của bộ kịch bản

1. Bộ thiết kế `Design/MACHVON_Design/03_Engineering/test_cases.json` hiện có 1496 ca. 1097 ca đã thành ca UAT trong `docs/uat/<phân hệ>/uat.json` (26 thư mục phân hệ). 399 ca chưa thành `uat.json`: 133 ca `UAT-PLAN-nn` và 266 ca `UI-*`, `UAT-*` của các màn hình và câu chuyện thêm sau. Trong 266 ca đó, 128 ca thuộc phân hệ chưa có thư mục: VND 40, RPT 14, PWA 14, BAN 13, INT 8, FEED 8, HUB 7, DIR 6, PORTAL 5, IND 3, EQP 3, HPM 2, EBS 2, ORG 1, RML 1, INFRA 1. Chưa có thư mục `docs/uat/<phân hệ>` cho các phân hệ đó (cũng như FND, không có màn riêng: số liệu vốn nhập ở DIS-27 đến DIS-29). Việc sinh ca theo hợp đồng handoff của uat-test-writer thuộc giai đoạn 3; sinh xong thêm vào `docs/uat/INDEX.md`. Việc này do nhà cung cấp làm, không cần khách.
2. 138 ca còn lại của 266 thuộc phân hệ đã có thư mục (DIS 17, ADM 16, CTR 15, PRJ 14, BI 12, BID 11, MOB 9, AUD 8, PAY 7, LLM 6, DOC 6, HOME 5, CAP 4, NOT 3, IAM 3, MNE 1, QMS 1) và cần sinh thêm vào thư mục đó.
3. Bộ ca hiện có phủ 100% mục yêu cầu của thiết kế (khi sinh) nhưng chỉ 2 trong 26 phân hệ đạt sàn `TC_min` (MOB, NFR; `docs/uat/INDEX.md`): các phân hệ còn lại thiếu ca đào giá trị biên, bảng quyết định, đường chuyển trạng thái sai và ma trận quyền.
4. Hành vi của bản enterprise sau khi ENT-3 và ENT-4 gộp đã có SIT (mục 3) và đã qua lượt chạy phát triển r2, nhưng chưa có ca UAT ký được: bản chốt enterprise, thuyết minh 8 trường, PUSH giữ chờ biên nhận, so sánh chéo, lịch kỳ, gói PVFCCO-TEMPLATE, nhật ký đủ trước và sau, giới hạn log, sao lưu thủ công.
5. Ca "chờ khách" phải gắn nhãn PX-nn trong tiêu đề hoặc trường `rule_ref` để không lẫn vào số đạt.
6. Phép đo cần phần cứng, hạ tầng hoặc đơn vị ngoài (chỉ khách hoặc bên ngoài làm được): đo hiệu năng trên máy chủ PVFCCo (PX-10); cài UAT và Production, diễn tập khôi phục, thử EICAR và egress (PX-11); email, Teams, nhóm AD thật (PX-16); pentest độc lập (PX-09); chạy UAT cùng đầu mối và ký (PX-05, PX-12).

## 5. Bằng chứng và cách ghi kết quả

Số liệu sinh bởi công cụ trong kho mã, đọc ngày 2026-11-12 (không chạy lại công cụ khi soạn tệp này):

| Nguồn | Số liệu hiện tại |
|---|---|
| `docs/UAT-EVIDENCE.md` (lượt chạy `local-2026-11-07-mobile-r3`, bản dựng 9c978a88aa24, lược đồ 1706) | 63 trên 676 hàng yêu cầu hoàn tất (667 yêu cầu): PASS 63, UNPROVEN 1, NOT_RUN 611, FAIL 1, WAIVED 0, SKIPPED 0, GAP 0; 63 trên 676 màn hình hoàn tất, 0 màn hình không có ca; 20 trên 28 ca then chốt PASS (8 ca còn lại: NOT_RUN 5, UNPROVEN 3) |
| `docs/UAT-COVERAGE.md` (sinh bởi `npm run uat:trace`) | 810 trên 836 tiêu chí nghiệm thu nêu trong tiêu đề của kiểm thử đang chạy; 26 tiêu chí chưa có kiểm thử; 189 câu chuyện có trạng thái hoàn tất, 574 trên 599 tiêu chí đã phủ cộng 25 kiểm tra ngoài khai báo |
| `docs/uat/INDEX.md` | 26 phân hệ, 1097 ca, phủ 100% coverage item, 2 trên 26 đạt sàn `TC_min` |
| `docs/uat/RUN-2026-11-09-r2.md` | Lượt chạy phát triển, bản enterprise: số ca thật 477 đạt, 0 lỗi, 620 không chạy; kết luận công cụ NO-RUN |

- Chưa có lượt chạy UAT nào được công nhận: các số trên là của bản công và của lượt chạy phát triển, không phải của lượt UAT tại PVFCCo. Kết quả NOT_RUN giữ nguyên là NOT_RUN; không được ghi thành đạt khi chưa có bản ghi PASS kèm bằng chứng.
- Một hàng chỉ PASS khi mọi ca nó nêu có bản ghi PASS kèm bằng chứng (thời điểm, bản dựng, phiên bản lược đồ, băm bộ dữ liệu, mã yêu cầu, liên kết). Quy tắc ở `docs/runbooks/uat-evidence.md`.
- Biên bản UAT của PVFCCo lập theo mẫu ở [09](09-acceptance-minutes-template.md), đính kèm báo cáo sinh từ kho kết quả; bảng đối chiếu ở [09](09-acceptance-minutes-template.md) mục 1 được điền sẵn số đếm theo các số trên.

## 6. Danh sách lỗi (mẫu)

| Mã lỗi | Mã ca | Mã yêu cầu | Mức | Mô tả | Người báo | Hạn sửa | Trạng thái | Kết quả kiểm lại |
|---|---|---|---|---|---|---|---|---|
| [điền khi có] | | | Nghiêm trọng, Cao, Trung bình, Thấp | | | | Mở, Đã sửa, Đã kiểm lại | |

Quy tắc: lỗi Nghiêm trọng đóng trước khi sang giai đoạn 5; lỗi còn mở khi nghiệm thu phải có biện pháp giảm thiểu PVFCCo chấp thuận bằng văn bản. Bốn mức Nghiêm trọng, Cao, Trung bình, Thấp của bảng trên được đối chiếu theo thứ tự với P0, P1, P2, P3 của kế hoạch kiểm thử (`Design/MACHVON_Design/01_Documents/10_Ke_hoach_kiem_thu_va_chuyen_doi.md`, mục "Defect và điều kiện nghiệm thu").

Lịch sử sửa: v0.1 khung ngày 2026-11-09. v0.2 ngày 2026-11-12 (rà soát bởi làn aud4): cập nhật cột SIT và khoảng trống theo các làn ENT-3, ENT-4, INFRA-2, DOC-3 đã gộp; sửa số ca của bộ thiết kế (1496) và của `docs/uat` (1097, 399 ca chưa chuyển); cập nhật số liệu `docs/UAT-EVIDENCE.md` (63 trên 676) và `docs/UAT-COVERAGE.md`; thêm lượt chạy phát triển r2; liệt kê phép đo chờ khách kèm mã PX.
