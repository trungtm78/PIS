# 05. Kịch bản kiểm thử SIT và UAT theo mã yêu cầu

Giai đoạn 3 (sản phẩm: kịch bản kiểm thử) và giai đoạn 4 (biên bản UAT, danh sách lỗi). Dòng ma trận: GD.3, GD.4, SP.05. PVFCCo phê duyệt: kịch bản kiểm thử (GĐ 3); biên bản UAT (GĐ 4).

Tệp này nối mỗi mã yêu cầu của hồ sơ kỹ thuật với (a) kiểm thử tích hợp hệ thống (SIT) mà nhà cung cấp chạy tự động trong kho mã, (b) ca UAT của các đầu mối trong `docs/uat/<phân hệ>/uat.json`, (c) khoảng trống kiểm thử đã biết. Tệp không chứa kết quả chạy: kết quả chỉ có giá trị khi sinh từ lượt chạy có bằng chứng (mục 5).

Trạng thái tệp: KHUNG. Kịch bản chưa được Tổ chuẩn hóa dữ liệu duyệt. Ca cho IND, RPT, DIR, HPM, EBS, HUB, INT và ENT (bản enterprise) đã có trong `docs/uat` từ 2026-11-12 (mục 4); chưa có lượt chạy UAT nào được công nhận trên bản đã gộp.

---

## 1. Hai tầng kiểm thử

| Tầng | Ai chạy | Chạy ở đâu | Công cụ trong kho mã | Kết quả |
|---|---|---|---|---|
| SIT | Nhà cung cấp | Môi trường kiểm thử của nhà cung cấp, sau đó trên UAT của PVFCCo | Kiểm thử đơn vị và tích hợp (Jest, Vitest, `node --test`) trên cơ sở dữ liệu thật; route walk và visual của web (`docs/runbooks/web-e2e.md`); kiểm tra tĩnh trong `npm run lint` | Báo cáo chạy của nhà cung cấp kèm bản dựng |
| UAT | Đầu mối cùng nhà cung cấp, theo kịch bản đã duyệt | Môi trường UAT của PVFCCo | Ca trong `docs/uat/<phân hệ>/uat.json` (hợp đồng handoff của uat-test-writer); chạy bằng Jest trên bản enterprise (`apps/api/test/uat`), Playwright, Maestro hoặc tay | Biên bản UAT (mẫu: [09](09-acceptance-minutes-template.md)); danh sách lỗi |

Cách chạy tầng SIT trên cơ sở dữ liệu: các suite dùng chung một máy chủ PostgreSQL thử và xếp hàng qua `scripts/lane.mjs` (`docs/runbooks/test-lanes.md`). Nền tảng của ca UAT hiện có: web 857, API 163, Android 77 (`docs/uat/INDEX.md`).

## 2. Cổng nghiệm thu theo hồ sơ kỹ thuật (giai đoạn 4)

1. SIT do nhà cung cấp thực hiện và nộp báo cáo trước UAT.
2. UAT cùng các đầu mối theo kịch bản đã được PVFCCo phê duyệt (giai đoạn 3).
3. Khắc phục lỗi; mọi lỗi mức nghiêm trọng đóng trước khi sang giai đoạn 5.
4. Mục dựng trên giả định chờ khách (HPM, EBS, mẫu biểu chính thức, từ điển chỉ tiêu) ghi PENDING-EXTERNAL và không tính là đạt (quy tắc R18). Sổ ở [11](11-pending-external-register.md).
5. Điều kiện bắt buộc cho nghiệm thu: kết quả pentest độc lập đạt (YCK.07, PX-09).

## 3. Kịch bản theo mã yêu cầu

Cột "SIT" là tệp kiểm thử trong kho mã hoặc nhóm kiểm thử. Cột "Ca UAT" là mã ca trong `docs/uat/<phân hệ>/uat.json` (chỉ nêu ví dụ tiêu biểu; danh mục đầy đủ ở tệp). Cột "Khoảng trống" nêu điều chưa có kịch bản.

### 3.1 MD, DL

| Mã | Kịch bản chính (UAT) | SIT | Ca UAT ví dụ | Khoảng trống |
|---|---|---|---|---|
| MD.01 | Tạo dự án, kiểm tra mã duy nhất, thêm ánh xạ mã HPM và EBS, lọc theo nhóm, loại hình, giai đoạn | `apps/api/test/prj`, `apps/api/test/int`, `apps/api/test/mdm` | `docs/uat/prj` (43 ca), `docs/uat/mdm` (58 ca): TC-UAT-AC203, TC-UAT-AC276 | Ca cho mã HPM theo dự án, loại dự án enterprise (ENT-3e) |
| MD.02 | Thêm văn bản pháp lý có tệp, ghi mốc kế hoạch và thực tế, xem lịch sử phiên bản kế hoạch | `apps/api/test/prj`, `apps/api/test/doc` | `docs/uat/prj`, `docs/uat/doc` (56 ca) | Danh mục mốc vòng đời enterprise |
| MD.03 | Sửa danh mục bằng đề xuất và duyệt hai người; đơn vị không tự sửa | `apps/api/test/mdm` | `docs/uat/mdm`: TC-UAT-AC48, TC-UAT-AC46 | Tỷ giá, loại báo cáo, cơ quan nhận (ENT-4e) |
| DL.01 | Nhập một số liệu, thấy lũy kế và tỷ lệ tự tính; nhập số ước rồi số thực, xem lịch sử | `apps/api/test/fnd`, `apps/api/test/dis`, `packages/kernel/test/fnd-figures.test.ts` | `docs/uat/dis` (69 ca) | Thuyết minh 8 trường và kế thừa kỳ trước (ENT-3b) |
| DL.02 | Nhập sai theo từng quy tắc (lũy kế vượt tổng mức đầu tư, vốn không cân, kỳ đã chốt, thiếu trường); nhập tệp Excel: chạy thử, áp dụng, áp dụng lại cùng tệp | `apps/api/test/ind/ind.test.ts`, `packages/kernel/test/ind-entry.test.ts`, `ind-import-mapping.test.ts` | `docs/uat/ind` (32 ca, 21 chạy tự động): UAT-IND-E2E-01, UAT-IND-E2E-02, UAT-IND-DAT-01 | Từ điển, quy tắc và ánh xạ khởi điểm chờ Tổ chuẩn hóa dữ liệu (PX-02); biên giá trị làm tay |
| DL.03 | Chốt kỳ, mở lại kỳ, xem bản chốt đúng số đã báo cáo, so cùng kỳ | `apps/api/test/dis/snapshot.test.ts`, `period-reopen.test.ts`, `golden.test.ts` | `docs/uat/dis`: TC-UAT-AC03 (409 PERIOD_LOCKED), TC-UAT-AC246 (lý do mở lại) | Bản chốt enterprise (ENT-3a) |

### 3.2 QT, CN

| Mã | Kịch bản chính (UAT) | SIT | Ca UAT ví dụ | Khoảng trống |
|---|---|---|---|---|
| QT.01 | Đi hết luồng nhập, duyệt đơn vị, Ban KHĐT, chốt, đẩy HPM; trả về có lý do; người nhập không tự duyệt; cấu hình lại bước | `packages/kernel/test/dis-report-workflow.test.ts`, `apps/api/test/dis/report-staged-approval.test.ts`, `apps/api/test/adm` | `docs/uat/adm`: TC-UAT-AC111 (SELF_APPROVAL_DENIED), `docs/uat/dis`: TC-UAT-AC05 | Bước PUSH gọi HPM, quy trình cho lô FND và IND (ENT-3c) |
| QT.02 | Sinh kỳ, quá hạn nhập sang kỳ trễ, chốt, mở lại; xem tiến độ nộp từng đầu mối; nhận nhắc việc | `apps/api/test/dis/reporting-period.test.ts`, `submission-progress.test.ts`, `period-reopen.test.ts` | `docs/uat/dis`: TC-UAT-PLAN-66 | Lịch quý, năm, giao ban; email thật (ENT-4c) |
| CN.01 | Lập kế hoạch năm, phân bổ, điều chỉnh có văn bản | `apps/api/test/cap` | `docs/uat/cap` (54 ca): TC-UAT-AC230, TC-UAT-PLAN-64 | Nguồn GROUP_ASSIGNED, BOARD_APPROVED (ENT-3e) |
| CN.02 | Nhập và duyệt số liệu thực hiện, giải ngân; xem lũy kế và tỷ lệ | `apps/api/test/dis`, `apps/api/test/fnd` | `docs/uat/dis` | Thuyết minh có cấu trúc; màn mua sắm trang thiết bị (ENT-3b, ENT-4e) |
| CN.03 | Ghi cuộc giao ban, giao chỉ đạo, ghi tiến độ, gia hạn, đóng; xem chỉ đạo quá hạn; chỉ đạo vào thuyết minh kỳ sau | `apps/api/test/dir/directive.test.ts`, `packages/kernel/test/directive.test.ts` | `docs/uat/dir` (48 ca, 28 chạy tự động): UAT-DIR-E2E-01, UAT-DIR-SOD-01, UAT-DIR-STA-01 | Phạm vi theo đơn vị và đầu vào báo cáo kỳ sau làm tay (cần grant theo đơn vị và đồng hồ giả); DIR-06 trên điện thoại |
| CN.04 | Nạp tệp EBS, chạy thử, áp dụng; đối chiếu; giải trình chênh lệch; so sánh chéo báo cáo | `apps/api/test/editions/ebs.enterprise.test.ts`, `apps/api/test/dis` (kiểm tổng chéo) | `docs/uat/ebs` (30 ca, 19 chạy tự động): UAT-EBS-E2E-01, UAT-EBS-E2E-02, UAT-EBS-STA-01 | Bố cục tệp EBS thật (PX-04); ánh xạ mã nối với INT làm tay; so sánh chéo ở `docs/uat/rpt` (UAT-RPT-XCK-01, làm tay) |

### 3.3 BC, TH

| Mã | Kịch bản chính (UAT) | SIT | Ca UAT ví dụ | Khoảng trống |
|---|---|---|---|---|
| BC.01 | Lập từng biểu mẫu cho một kỳ, duyệt ba người, phát hành, tải Excel, Word; kiểm bản đồ ô đúng mẫu; xuất lại cho kỳ đã phát hành | `packages/edition-enterprise/test/report-forms.test.ts`, `apps/api/test/reports/report-engine.test.ts`, `report-engine.enterprise.test.ts`, `packages/kernel/test/report-layout.test.ts` | `docs/uat/rpt` (60 ca, 35 chạy tự động): UAT-RPT-E2E-01, UAT-RPT-SOD-01, UAT-RPT-STA-02 | Mẫu chính thức (PX-01); ký số, lịch email và biểu mẫu demo làm tay |
| BC.02 | Lãnh đạo mở dashboard, thấy tỷ lệ, chậm tiến độ, chỉ đạo quá hạn; truy nguồn; tạo báo cáo; gửi lịch | `apps/api/test/home`, `apps/api/test/bi` | `docs/uat/home` (19 ca): TC-UAT-AC266, TC-UAT-AC267; `docs/uat/bi` (37 ca) | Chế độ trình chiếu, tỷ lệ theo kế hoạch enterprise (ENT-4d) |
| TH.01 | Đẩy một biểu mẫu đã phát hành, nhận lỗi, đẩy lại cùng khóa, ghi biên nhận, đính chính kỳ đã nhận | `apps/api/test/editions/hpm.enterprise.test.ts` | `docs/uat/hpm` (32 ca, 19 chạy tự động): UAT-HPM-E2E-01, UAT-HPM-IDM-01, UAT-HPM-STA-02 | Mọi kết quả trên bộ ghi tệp là PENDING-EXTERNAL (PX-03); đính chính cần kỳ mở lại thật của DIS (làm tay) |
| TH.02 | Mở tài khoản máy, lấy token, đọc tập dữ liệu chứng nhận; đăng nhập BI chỉ đọc | `apps/api/test/int` | `docs/uat/int` (42 ca, 29 chạy tự động): UAT-INT-E2E-01, UAT-INT-IDM-01, UAT-INT-SOD-01 | Power BI mẫu (DOC-3); đăng nhập BI bằng kết nối CSDL thật làm tay |
| TH.03 | Đối chiếu EBS (xem CN.04); xem sức khỏe kết nối ở hub; gọi API mở không phí | `apps/api/test/hub`, `apps/api/test/int` | `docs/uat/hub` (36 ca, 25 chạy tự động): UAT-HUB-E2E-01, UAT-HUB-SOD-01, UAT-HUB-STA-01 | eProcurement, văn thư (PX-06, PX-07) |

### 3.4 HT, YCK

| Mã | Kịch bản chính (UAT) | SIT | Ca UAT ví dụ | Khoảng trống |
|---|---|---|---|---|
| HT.01 | Kiểm cách ly dữ liệu, TLS, tiêu đề bảo mật trên UAT | `apps/api/test/isolation`, `apps/api/test/conformance` | `docs/uat/nfr` (69 ca), `docs/uat/critical` (28 ca): TC-UAT-NFR-TENANCY-02 | Chạy trên máy chủ PVFCCo (PX-11) |
| HT.02 | Mỗi vai trò chỉ thấy và làm đúng việc; đầu mối chỉ thấy dự án mình; vượt quyền bị chặn | `apps/api/test/authz`, `apps/api/test/adm` | `docs/uat/adm`: TC-UAT-AC103, TC-UAT-AC105, TC-UAT-AC106 | Ca theo ma trận 09 đầu mối (ENT-3d) |
| HT.03 | Ủy quyền có hạn, ủy quyền vĩnh viễn, thu hồi; người nhận làm thay và được ghi | `apps/api/test/adm` | `docs/uat/adm` | Không |
| HT.04 | Đổi quy tắc nhập liệu hoặc công thức chỉ tiêu qua quy tắc quản trị: soạn, trình, duyệt khác người, có hiệu lực | `apps/api/test/gov` | `docs/uat/adm` | Bố cục biểu mẫu nội bộ, lịch kỳ (ENT-4b, ENT-4c) |
| HT.05 | Đo thời gian phản hồi và thời gian sinh báo cáo | `scripts/perf-budget.mjs`, `docs/qa/perf-budget.json` | `docs/uat/nfr`: TC-UAT-PLAN-11 | Đo trên phần cứng khách (PX-10) |
| HT.06 | Mỗi thao tác tạo, sửa, duyệt, chốt, mở lại, đẩy HPM có dòng nhật ký; xuất nhật ký | `apps/api/test/adm`, `apps/api/test/conformance` | `docs/uat/adm`, `docs/uat/nfr`: TC-UAT-NFR-SECURITY-11 | Giá trị trước/sau, giới hạn log (ENT-4e) |
| YCK.01 | Cài PWA, duyệt trong hàng đợi, xem dashboard, theo dõi chỉ đạo, nhận thông báo; thử trên Chrome, Firefox, Edge, Safari | `apps/web/src/pwa/*.test.ts(x)`, route walk | `docs/uat/mob` (88 ca): TC-UI-MOB-03, TC-UAT-PLAN-36 | PWA-04 (ENT-4e); làn Edge; email/Teams thật |
| YCK.02 | Cài bản vào UAT và Production từ gói ngoại tuyến; nâng cấp, quay lui | `scripts/onprem-bundle.mjs` | `docs/uat/nfr` | Cài thật trên máy chủ PVFCCo (PX-11) |
| YCK.03 | Tạo tài khoản với số lượng lớn, không bị chặn bản quyền | `apps/api/test/provisioning` | `docs/uat/sas` | Số người dùng ước tính (PX-17) |
| YCK.04 | Nhập CSV, XLSX; xuất Excel, Word, PDF; gọi API | `apps/api/test/dis`, `apps/api/test/int`, `apps/api/test/files` | `docs/uat/dis`: TC-UAT-AC261 (tệp xuất) | PDF biểu mẫu (ENT-4b) |
| YCK.05 | Thêm chỉ tiêu, quy tắc mới bằng cấu hình; nâng cấp giữ cấu hình | `apps/api/test/gov`, `apps/api/test/hub` | `docs/uat/adm` | Không |
| YCK.06 | Sao lưu, khôi phục sang môi trường thử, so băm; kiểm tra bản bất biến | `scripts/backup-verify.mjs`, `scripts/restore-drill.mjs` | `docs/uat/critical` (nhóm restore), `docs/uat/sas` | Chu kỳ tuần/tháng, differential, bản ngoại tuyến (INFRA-2) |
| YCK.07 | Chạy pentest độc lập theo `docs/security/pentest-readiness.md`; kiểm thử xác thực, MFA, khóa tài khoản | `docs/security/identity-test-plan.md`, `apps/api/test/auth`, `apps/api/test/session` | `docs/uat/iam` (20 ca): TC-UAT-AC121; `docs/uat/nfr`: TC-UAT-NFR-SECURITY-03 | Pentest độc lập (PX-09); quét mã độc, egress (INFRA-2) |
| YCK.08 | Bỏ trống trường bắt buộc thấy lỗi ngay; giao diện tiếng Việt; mở trợ giúp trên màn hình | `apps/web` (lint i18n, a11y), `scripts/a11y-lint.mjs` | `docs/uat/iam` | Trợ giúp trực tuyến trên màn hình (DOC-3) |

### 3.5 TK

| Mã | Kịch bản | Tài liệu |
|---|---|---|
| TK.01 | Kiểm tra sau đào tạo: người học làm lại bài thực hành của chương mình | [07](07-training-plan.md) |
| TK.02 | Rà soát bộ tài liệu theo danh mục bàn giao | [10](10-handover-checklist.md) |
| TK.03 | Chạy thử chuyển đổi trên bản sao, đối soát số dòng và tổng tiền, Ban KHĐT ký | [06](06-data-conversion-plan.md) |
| TK.04 | Chạy song song hai kỳ, đối chiếu từng chỉ tiêu | [08](08-parallel-run-plan.md) |

## 4. Khoảng trống của bộ kịch bản

1. Đã có thư mục `docs/uat/<phân hệ>/uat.json` cho IND, RPT, DIR, HPM, EBS, HUB, INT và ENT (339 ca: 198 chạy tự động trong `apps/api/test/uat`, 141 làm tay kèm lý do trong từng ca). Còn thiếu thư mục cho BAN, FEED, FND, VND và các ca thiết kế của phân hệ khác chưa chuyển sang handoff (306 ca của `test_cases.json`).
2. Bộ ca hiện có phủ 100% mục yêu cầu của thiết kế nhưng chỉ 2 trong 26 phân hệ đạt sàn `TC_min` (`docs/uat/INDEX.md`): các phân hệ còn lại thiếu ca đào giá trị biên, bảng quyết định, đường chuyển trạng thái sai và ma trận quyền.
3. Ca cho hành vi của bản enterprise (bản chốt enterprise, đẩy HPM, đối chiếu EBS, chỉ đạo, báo cáo từ bản chốt, API mở, Hub) đã có và chạy được trên bản enterprise tại `apps/api/test/uat`; còn làm tay: thuyết minh 8 trường (UAT-ENT-NAR-01), PUSH của quy trình gọi HPM với kỳ mở lại thật (UAT-HPM-E2E-02), so sánh chéo (UAT-RPT-XCK-01), PWA trên điện thoại (UAT-ENT-PWA-01 đến 03).
4. Ca "chờ khách" phải gắn nhãn PX-nn trong tiêu đề hoặc trường `rule_ref` để không lẫn vào số đạt.

## 5. Bằng chứng và cách ghi kết quả

- Chưa có lượt chạy UAT nào được công nhận: `docs/UAT-EVIDENCE.md` (sinh bởi `npm run uat:evidence`) hiện ghi 63 trên 676 hàng yêu cầu PASS, phần còn lại NOT_RUN; 20 trên 28 kiểm thử then chốt PASS. Đây là số của bản công, không phải của lượt UAT tại PVFCCo.
- Một hàng chỉ PASS khi mọi ca nó nêu có bản ghi PASS kèm bằng chứng (thời điểm, bản dựng, phiên bản lược đồ, băm bộ dữ liệu, mã yêu cầu, liên kết). Quy tắc ở `docs/runbooks/uat-evidence.md`.
- Biên bản UAT của PVFCCo lập theo mẫu ở [09](09-acceptance-minutes-template.md), đính kèm báo cáo sinh từ kho kết quả.

## 6. Danh sách lỗi (mẫu)

| Mã lỗi | Mã ca | Mã yêu cầu | Mức | Mô tả | Người báo | Hạn sửa | Trạng thái | Kết quả kiểm lại |
|---|---|---|---|---|---|---|---|---|
| [điền khi có] | | | Nghiêm trọng, Cao, Trung bình, Thấp | | | | Mở, Đã sửa, Đã kiểm lại | |

Quy tắc: lỗi Nghiêm trọng đóng trước khi sang giai đoạn 5; lỗi còn mở khi nghiệm thu phải có biện pháp giảm thiểu PVFCCo chấp thuận bằng văn bản.

Lịch sử sửa: v0.1 khung ngày 2026-11-09; v0.2 ngày 2026-11-12 thêm ca UAT cho bản enterprise (lane uatent).
