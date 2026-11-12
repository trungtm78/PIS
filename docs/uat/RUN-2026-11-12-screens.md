# Lượt kiểm màn hình theo hợp đồng (UI-<MÀN HÌNH>), 2026-11-12

Người chạy: tác tử `uatscreen` (nhánh `lane/uatscreen`). Công cụ: `apps/web/e2e/screen-contract.spec.ts` (một test Playwright cho mỗi ca `TC-UI-<MÀN HÌNH>` của bản đang kiểm, mã ca nằm trong tên test), đo trực tiếp trên trình duyệt (Chrome hệ thống, 1440 px và 390 px), không dùng kết quả đọc mã.
Cây mã của lượt đầu là gốc của nhánh (b3781a1f4); lượt sau chạy trên cây đã gộp main (trong đó có bộ dữ liệu demo đầy đủ, nên nhiều màn hình có bản ghi để đo hơn) cộng các sửa bên dưới. Hai cột "lần đầu" và "sau sửa" vì thế khác nhau do cả hai nguyên nhân; từng khác biệt được gán ở mục "Phát hiện theo nguyên nhân gốc".
Bằng chứng nhỏ (không có trace, video): `uat/run/uat-2026-11-12-screens/{enterprise,public}/{summary,results}.json` (sau khi sửa) và `.../before/{summary,results}.json` (lượt đầu, trước khi sửa).

## Kết quả

| Bản | Lượt đầu: ca | đạt | đỏ | Sau khi sửa: ca | đạt | đỏ | bỏ qua |
|---|---:|---:|---:|---:|---:|---:|---:|
| Doanh nghiệp (PVFCCo) | 448 | 267 | 181 | 448 | 389 | 59 | 0 |
| Đầu tư công | 439 | 262 | 177 | 439 | 381 | 58 | 0 |

Bản đầu tư công có 439 ca vì 9 màn hình chỉ có ở bản doanh nghiệp. Bản doanh nghiệp sau sửa gồm bốn đoạn chạy cả bảng và một đoạn chạy lại 8 ca CTR sau khi sửa (kết quả sau cùng của mỗi ca là lần chạy cuối của nó). Ba ca là làm tay, không nằm trong các số trên (DIR-06, PWA-05, PWA-06, lý do ở dưới).
"Đạt" nghĩa là mọi mệnh đề trình duyệt quyết định được đều đúng; điều trình duyệt không quyết định được (mỗi ca liệt kê trong `notDecided` của `results.json`) KHÔNG được tính là đạt: xem mục "Trình duyệt không quyết định".

### Số ca đỏ theo mệnh đề (một ca có thể đỏ nhiều mệnh đề)

| Mệnh đề | Doanh nghiệp: lần đầu | sau sửa | Đầu tư công: lần đầu | sau sửa |
|---|---:|---:|---:|---:|
| Không có hành động ngoài quyền (người chỉ xem) | 12 | 0 | 9 | 0 |
| Lỗi trả đúng Problem (type, title, status, code, correlation_id) | 11 | 0 | 11 | 0 |
| Không cuộn ngang ở 390 px | 21 | 0 | 21 | 0 |
| Token thiết kế (cỡ chữ tối thiểu 12 px, tiêu đề không nghiêng) | 140 | 0 | 141 | 0 |
| Trường của danh mục có trên màn hình | 57 | 58 | 56 | 57 |
| Trường đúng thứ tự danh mục | 2 | 2 | 2 | 2 |

Không có ca nào đỏ ở các mệnh đề: màn hình có mã màn hình, không hiện thẻ lỗi sập, không lỗi console hoặc lỗi không bắt, nhãn truy cập (axe), trạng thái denied và 403, API trúng thao tác của openapi, sáu trạng thái ép trên chính màn hình.

## Phát hiện theo nguyên nhân gốc

Phân loại: S = lỗi sản phẩm (đã sửa trong lượt này, có test hồi quy), O = oracle hoặc mâu thuẫn tài liệu thiết kế (không sửa sản phẩm, chờ chủ sở hữu), E = môi trường.

### S1. Thân lỗi API dùng `correlationId`, hợp đồng đòi `correlation_id` (sửa)

`Problem.required` trong `openapi.json` có `correlation_id`; client Dart sinh từ hợp đồng (`responses.generated.dart`) và các dữ liệu mẫu của app điện thoại cũng viết `correlation_id`. Chỉ `apps/api/src/problem.filter.ts`, client web (`packages/api-client`) và client Dart viết tay dùng `correlationId`. Bên sai là bên viết `correlationId`: sửa API, client web và client Dart theo hợp đồng, không sửa hợp đồng. Header `X-Correlation-Id` không đổi. 11 ca (mọi thân 403 của ADM-15..18, IAM-09, NOT-17, OMNI-11, SAS-22..25 ở lượt đầu) đã đỏ vì lý do này.
Test hồi quy: `apps/api/test/problem.filter.test.ts` (đọc `Problem.required` từ hợp đồng và đòi mọi thành viên, không có `correlationId`), các bộ API có DB đã chạy lại (command-pipeline, policy-guard, placement-migration, audit-events: 80 test đạt), `packages/api-client` 47 test, `packages/mobile-api-client` và `contract_wiring_test` của app. `contracts:check` vẫn xanh.

### S2. Nút ghi hiện cho người chỉ xem (sửa)

13 màn hình (CTR-03 lộ ra khi gộp bộ dữ liệu demo đầy đủ của main; CTR-23, DGV-09, DGV-20, DOC-02, EBS-02, HPM-01, HPM-02, INT-03, INT-04, RPT-01, RPT-07, RPT-08, tổng 17 nút) chỉ xét chế độ của tenant và điều máy chủ nói về từng dòng, không xét quyền trong phiên. Người dùng phiên chỉ có quyền `*.read` vẫn thấy "Lập đánh giá", "Chạy đối soát", "Đẩy báo cáo", "Tạo tài khoản BI"... Sửa: hàm dùng chung `holds(permissions, quyền)` (`apps/web/src/session/holds.ts`) và mỗi màn hình chỉ hiện nút khi phiên có đúng quyền của lệnh phía sau (`x-permission` của openapi). Máy chủ vẫn xét lại mọi lệnh. DOC-02 không cần sửa sản phẩm: các nút nằm trong `<fieldset disabled>`, oracle trước đó chỉ đọc thuộc tính `disabled` của chính nút (xem O1).
Test hồi quy: mỗi màn hình có test "người chỉ có quyền đọc không thấy nút, người có quyền thấy nút" (ví dụ `ContractorScorecardScreen.test.tsx`, `MappingScreen.test.tsx`, `PushLogScreen.test.tsx`, `LayoutScreens.test.tsx`).
RPT-08 (soạn bố cục) không còn cho thêm hoặc xóa dòng, lưu bản nháp khi thiếu `adm.governance.manage`; màn hình vẫn cho xem bố cục và bản xem trước, và nói "Chỉ xem" (khóa dịch có sẵn `rpt.cat.action.noRight`, không thêm chuỗi).

### S3. Tràn ngang ở 390 px (sửa)

Nguyên nhân thật, đo bằng oracle mới (nó nêu phần tử vượt mép): (a) 16 bảng trần `<table class="table">` của 14 màn hình LLM, 3 bảng của HUB-02, 1 bảng của PAY-09 không nằm trong vùng cuộn; (b) lưới một cột `.two` của nguyên mẫu viết `1fr` (không co dưới nội dung rộng nhất) kéo cả trang (ADM-12); (c) dãy sáu liên kết "tab" của sáu màn hình tổng hợp hợp đồng (CTR-09, 11, 15, 16, 17, 18) và hàng thao tác `.ctr-row-actions` không xuống dòng, danh sách sự kiện `.ctr-facts` của CTR-12 có cột `1fr` không co (lộ ra khi gộp dữ liệu demo của `main`); (d) trạng thái của thẻ mục `.ui-section__status` dùng `white-space: nowrap` (DIS-15). Sửa: mỗi bảng nằm trong vùng `role="region"` có tên, `tabIndex=0` cuộn ngang (mẫu của `KitTable`), lưới co về `minmax(0, 1fr)`, trạng thái được xuống dòng.
ADM-07, ADM-09, ADM-15, HOME-04, PRJ-21 đã hết tràn ngay sau khi gộp `main` (không do lượt này).
Test hồi quy: `apps/web/src/styles/styles.test.ts` (lưới), test của từng màn hình LLM/HUB/PAY không đổi và vẫn đạt; mệnh đề tràn của spec đo lại bằng trình duyệt.

### S4. Chữ dưới 12 px (sửa)

Dòng chú thích cuối màn hình "Màn hình XXX-NN · FR-..." (`.prototype-note`) ở 9-11 px vì tờ `workspace-navigation.css` của nguyên mẫu đặt lại cỡ chữ dưới `.workspace-app` mạnh hơn luật 12 px của `app.css`: đã thêm `.workspace-app .prototype-note`. Các luật 9-11 px khác của nguyên mẫu (`small`, `.pill`, `.badge`, `.eyebrow`, `.legend`, `.steps span`, `.metric .change`) và của 19 tệp CSS của module (liên kết quay lại "← ...", mã `.dis-code`, `.dgv-code`, nhãn trục biểu đồ DIS-23, nhãn đồ thị VND, khối băm ADM-audit) được nâng lên 12 px theo design.md. Không có test nào đọc cỡ chữ của dòng chú thích (đã tìm).
Ảnh chuẩn thị giác: các sửa này đổi điểm ảnh của dòng chú thích và của liên kết quay lại ở những màn hình mang chúng; KHÔNG chạm ảnh chuẩn. Kết quả `visual.spec` sau sửa ở mục "Ảnh chuẩn thị giác" bên dưới.
Phần vỏ ứng dụng (thanh bên 9-10 px, vết dẫn `.workspace-breadcrumb` 11 px, nhãn nhóm menu) cũng dưới 12 px nhưng nằm ngoài vùng `[data-screen-id]` mà mệnh đề đo và do tờ CSS nguyên mẫu đặt; chưa sửa vì đổi mọi ảnh chuẩn: quyết định của chủ sở hữu.

### O1. Oracle: nút trong `<fieldset disabled>` bị tính là nút đang bật (sửa oracle)

`element.disabled` của một nút trong fieldset bị khóa là `false` dù nút không bấm được (DOC-02). Oracle dùng `:disabled`. Chứng âm: trang mẫu sạch có một nút "Lưu bản nháp" trong fieldset khóa và vẫn không có finding.
Codex review vòng cuối bắt thêm một chỗ hở của oracle: nhóm tên "Mở" (chỉ mở trang) loại luôn cả "Mở lại" (mở lại hồ sơ, là ghi dữ liệu), nên nút này không bao giờ bị báo cho người chỉ xem. Đã thu hẹp thành "Mở" không đi kèm "lại"; chứng âm: trang cố ý hỏng có nút "Mở lại" và finding phải nêu nó. Chạy lại 157 ca của 11 phân hệ có nút "Mở lại" (AST, CAP, SAS, ISS, QMS, DGV, OMNI, DIR, DOC, INT, PRJ) ở cả hai bản: không có finding quyền mới.

### O2. Oracle: 57 ca "trường của danh mục không thấy trên màn hình" (chờ chủ sở hữu, không sửa sản phẩm)

Tên trường trong `screen_catalog.json` là mô tả bằng lời (ví dụ "Đã giải ngân (ngày Kho bạc)", "Xem trước PDF có watermark", "Điều kiện (DPA, ẩn danh, D07)", "Đơn vị và 09 đầu mối") chứ không phải nhãn trên màn hình; oracle so khớp chữ đã bỏ dấu và hoa thường nên không thể kết luận. Mỗi ca nêu đúng những trường không thấy. Cần chủ sở hữu quyết: (1) giữ danh mục là mô tả và bỏ mệnh đề "fields" khỏi các ca này, (2) hoặc thêm cột nhãn hiển thị vào danh mục. Sau khi gộp bộ dữ liệu demo của main có 58 ca doanh nghiệp (57 ca đầu tư công), vì thêm màn hình có bản ghi để đo. Danh sách lượt đầu (doanh nghiệp, 57 ca): ADM-15, AST-07, AUD-01, AUD-04, AUD-10, CAP-20, CTR-20, CTR-24, DGV-21, DIS-19, DIS-20, DIS-22, DIS-23, DIS-25, DOC-02, DOC-04, DOC-07, DOC-09, DOC-10, DOC-11, DOC-14, DOC-16, EBS-01, HOME-09, HPM-01, HUB-01, HUB-02, IND-01, IND-03, INT-02, INT-04, ISS-09, LLM-19, LND-04, LND-05, LND-09, LND-12, MNE-08, ORG-01, PAY-11, PAY-13, PAY-15, PMT-03, PMT-04, PMT-06, PRJ-14, PRJ-21, PWA-10, QMS-04, QMS-05, RPT-01, RPT-07, RPT-08, RPT-09, SAS-23, SAS-24, SAS-25.
Thêm 120 lượt ca không thể đo trường vì màn hình không có bản ghi hoặc biểu mẫu trên dữ liệu seed (xem `notDecided`: "fields: no record or form on the seeded data"): đó là giới hạn của dữ liệu, không phải đỏ.

### O3. Oracle hoặc tài liệu: thứ tự trường ADM-15 và IAM-09

Danh mục ghi thứ tự "Từ (VND), Đến (VND), Hiệu lực, Căn cứ" (ADM-15) và "Phạm vi, Hiệu lực" (IAM-09); màn hình hiện theo thứ tự khác. Chưa rõ danh mục hay mockup đúng: cần chủ sở hữu.

### O4. Mâu thuẫn tài liệu thiết kế: cỡ chữ

design.md cấm cỡ chữ dưới 12 px, trong khi chính CSS của nguyên mẫu (`Design/MACHVON_Design/02_Prototype`, gói thiết kế giữ nguyên) đặt 9-11 px ở nhiều chỗ. Sản phẩm theo design.md (S4); nguyên mẫu không sửa.

### E. Môi trường

- Làn `browser` chỉ cho một lượt chạy trình duyệt; mỗi đoạn chạy dưới 25 phút, hai bản chạy lần lượt. Một tiến trình khác giữ làn gần 35 phút làm lượt kiểm chờ đến khi làn tự thu hồi khóa cũ (30 phút).
- Một số lượt mở trang thất bại do máy hết socket hoặc bộ nhớ được mở lại một lần (`failedByTheMachine`); màn hình lỗi vì lý do riêng không bao giờ được mở lại.
- 6 ca SAS đạt không mang mã yêu cầu API (màn hình điều khiển không gọi API tenant): ghi nhận, không phải lỗi.

## Ảnh chuẩn thị giác (không chạm ảnh chuẩn, nhưng sửa S4 đổi điểm ảnh)

`npx playwright test e2e/visual.spec.ts` (bản đầu tư công, bộ ảnh chuẩn của Windows) sau các sửa: 159 đạt, 50 đỏ ("the page frame regions match the baseline PNG", vùng heading lệch khoảng 0,5% đến 2% điểm ảnh, ngưỡng 0,1%).
Đối chứng: chạy lại đúng 50 ca đó với các luật cỡ chữ 9-11 px của S4 đặt về như cũ (chỉ trong cây làm việc, không commit): 45 ca đạt, nghĩa là 45 ca đỏ là do nâng cỡ chữ lên 12 px (liên kết quay lại "← ...", `.pill`, `small`, ...): AST-02, AUD-03, BID-02, BID-16, CAP-02, CTR-08, CTR-10, CTR-26, DIS-02..06, DIS-18, DIS-22, DOC-07, DOC-09, DOC-19, ISS-02, ISS-03, ISS-04, ISS-07, LND-06, LND-13, MDM-25..27, MDM-31, NOT-02, NOT-12, PAY-02, PAY-03, PAY-06, PAY-08, PMT-02, PRJ-02, PRJ-03, PRJ-15, SAS-02, SAS-03, SAS-07, SAS-08, SAS-13, SAS-15, SAS-22.
5 ca còn lại đỏ dù đã đặt cỡ chữ về cũ: CTR-03, CTR-04, CTR-06, PRJ-09, PRJ-10 (vùng heading lệch 0,4% đến 11%): không do cỡ chữ; nguyên nhân chưa tra (nghi do main: màn CTR/PRJ của nó đổi, hoặc `.ctr-row-actions` xuống dòng); chưa có đối chứng trên cây main nguyên vẹn.
Quyết định cần chủ sở hữu: xem lại ảnh chụp mới rồi chạy `npm run e2e:visual:update -w @machvon/web` cho 45 ca, hoặc giữ cỡ chữ 11 px của nguyên mẫu ở các liên kết quay lại (trái design.md).

## Trình duyệt không quyết định

Mỗi ca nêu điều nó không quyết định được: dữ liệu và kiểm tra theo Module_Implementation_Contracts và FRD (261 ca), thông báo lỗi nghiệp vụ theo mã Problem ổn định (54 ca và các ca riêng), quy tắc nghiệp vụ được áp dụng (khoảng 40 ca), dải PENDING-EXTERNAL hiển thị (5), không mất dữ liệu nhập khi 409 (11), không hiện số 0 khi chưa đọc được số liệu (8). Các điều này thuộc bộ kiểm API và bộ test thành phần, không thuộc mệnh đề màn hình; một ca "đạt" ở đây không nói gì về chúng.

## Ca làm tay

| Ca | Lý do |
|---|---|
| UI-DIR-06 (màn hình điện thoại) | không phải đường web; thuộc bộ Maestro/Flutter |
| UI-PWA-05 | màn hình của một nhiệm vụ duyệt cụ thể; cần bản ghi và người duyệt thật |
| UI-PWA-06 | màn hình của một chỉ đạo cụ thể; cần bản ghi thật |

## Chứng âm (bộ đo có thể đỏ)

- `screen-contract negative control: a page that keeps the contract has no finding`: trang sạch (có cả nút trong fieldset khóa) không có finding.
- `... a page built to break the contract is red on every clause the browser decides`: trang cố ý hỏng đỏ ở mọi mệnh đề, mỗi finding nêu nguyên nhân (nay gồm phần tử gây tràn "reached by div (right 2408)" và phần tử chữ nhỏ "in p").
- `apps/web/e2e/support/screen-contract.test.ts`: 45 test với số đo bị biến đổi, mỗi mệnh đề đỏ khi số đo sai.
- `scripts/uat-screen-contract.test.mjs`: 8 test, độ phủ dòng 98,65%.

## Tái hiện

```bash
cd apps/web
# bản đầu tư công
MACHVON_TEST_LANE=unit SCREEN_CONTRACT_OUT=<tệp>.jsonl UAT_JOURNAL=<tệp>.journal.jsonl node ../../scripts/lane.mjs browser -- npx playwright test e2e/screen-contract.spec.ts
# bản doanh nghiệp: thêm MACHVON_EDITION=enterprise VITE_EDITION=enterprise (cả hai)
# chạy nhanh vài ca: SCREEN_CONTRACT_ONLY=TC-UI-LLM-01,TC-UI-ADM-12
```

Hai bản chạy lần lượt (làn trình duyệt khóa một lượt); toàn bộ bảng chạy trong 4 đoạn dưới 25 phút. Ghép vào kho kết quả của bản phát hành (`docs/uat-run-results.json`) bằng `node scripts/uat-run.mjs --journal <nhật ký> --merge`: CHƯA làm ở đây (kho này là sản phẩm của đường phát hành).

## Việc còn lại

- Chủ sở hữu quyết O2 (57 ca trường), O3 (thứ tự trường), cỡ chữ của vỏ ứng dụng (O4).
- Ghép nhật ký vào kho kết quả phát hành khi cắt bản.
- Các mệnh đề mà trình duyệt không quyết định cần bộ kiểm API và test thành phần (không thuộc lượt này).

Đỏ còn lại sau sửa (doanh nghiệp): quyền (không còn); tràn ngang (không còn); chữ nhỏ (không còn); Problem (không còn); thứ tự ADM-15, IAM-09.
