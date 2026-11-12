# Bộ UAT theo hợp đồng handoff (uat-test-writer)

Sinh bởi một bộ quy tắc cố định từ 1097 ca thiết kế (26 phân hệ đầu) và từ ca thiết kế cộng ca sâu của bản enterprise (8 phân hệ IND, RPT, DIR, HPM, EBS, HUB, INT, ENT; lane uatent) (26 phân hệ đầu) và từ ca thiết kế cộng ca sâu của bản enterprise (8 phân hệ IND, RPT, DIR, HPM, EBS, HUB, INT, ENT; lane uatent) (26 phân hệ đầu) và từ ca thiết kế cộng ca sâu của bản enterprise (8 phân hệ IND, RPT, DIR, HPM, EBS, HUB, INT, ENT; lane uatent) (26 phân hệ đầu) và từ ca thiết kế cộng ca sâu của bản enterprise (8 phân hệ IND, RPT, DIR, HPM, EBS, HUB, INT, ENT; lane uatent) (26 phân hệ đầu) và từ ca thiết kế cộng ca sâu của bản enterprise (8 phân hệ IND, RPT, DIR, HPM, EBS, HUB, INT, ENT; lane uatent) (26 phân hệ đầu) và từ ca thiết kế cộng ca sâu của bản enterprise (8 phân hệ IND, RPT, DIR, HPM, EBS, HUB, INT, ENT; lane uatent) (26 phân hệ đầu) và từ ca thiết kế cộng ca sâu của bản enterprise (8 phân hệ IND, RPT, DIR, HPM, EBS, HUB, INT, ENT; lane uatent) (26 phân hệ đầu) và từ ca thiết kế cộng ca sâu của bản enterprise (8 phân hệ IND, RPT, DIR, HPM, EBS, HUB, INT, ENT; lane uatent) (`Design/MACHVON_Design/03_Engineering/test_cases.json`), một thư mục cho mỗi phân hệ:
`docs/uat/<phân hệ>/uat.json` (hợp đồng handoff, `validate_uat_json.py` đạt) và `_coverage-ledger.md`. Kết quả mong đợi là của thiết kế, không lấy từ mã.
`docs/uat/critical/` là lát cắt 28 ca then chốt (tiền, cách ly, khôi phục), các ca ấy cũng nằm trong thư mục phân hệ của chúng.

## Kết quả cổng của writer (máy tính, không tự điền)

| Phân hệ | Ca | Coverage item | Phủ | M1 | M4 (rủi ro) | TC_min | Đạt sàn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| ADM | 55 | 21 | 100.0% | 21 | 80 | 80 | thiếu 25 |
| AST | 15 | 8 | 100.0% | 8 | 50 | 50 | thiếu 35 |
| AUD | 23 | 11 | 100.0% | 11 | 80 | 80 | thiếu 57 |
| BI | 37 | 20 | 100.0% | 20 | 80 | 80 | thiếu 43 |
| BID | 38 | 22 | 100.0% | 22 | 80 | 80 | thiếu 42 |
| CAP | 54 | 21 | 100.0% | 21 | 120 | 120 | thiếu 66 |
| CTR | 60 | 35 | 100.0% | 35 | 120 | 120 | thiếu 60 |
| DGV | 41 | 22 | 100.0% | 22 | 80 | 80 | thiếu 39 |
| DIR | 47 | 6 | 100.0% | 6 | 50 | 50 | thiếu 3 |
| DIS | 69 | 30 | 100.0% | 30 | 120 | 120 | thiếu 51 |
| DOC | 56 | 23 | 100.0% | 23 | 80 | 80 | thiếu 24 |
| EBS | 29 | 2 | 100.0% | 2 | 80 | 80 | thiếu 51 |
| ENT | 59 | 11 | 100.0% | 11 | 80 | 80 | thiếu 21 |
| HOME | 19 | 11 | 100.0% | 11 | 25 | 25 | thiếu 6 |
| HPM | 31 | 2 | 100.0% | 2 | 80 | 80 | thiếu 49 |
| HUB | 36 | 3 | 100.0% | 3 | 50 | 50 | thiếu 14 |
| IAM | 20 | 11 | 100.0% | 11 | 120 | 120 | thiếu 100 |
| IND | 32 | 3 | 100.0% | 3 | 80 | 80 | thiếu 48 |
| INT | 42 | 5 | 100.0% | 5 | 80 | 80 | thiếu 38 |
| ISS | 22 | 11 | 100.0% | 11 | 50 | 50 | thiếu 28 |
| LLM | 39 | 21 | 100.0% | 21 | 50 | 50 | thiếu 11 |
| LND | 29 | 15 | 100.0% | 15 | 80 | 80 | thiếu 51 |
| MDM | 58 | 39 | 100.0% | 39 | 80 | 80 | thiếu 22 |
| MNE | 27 | 10 | 100.0% | 10 | 80 | 80 | thiếu 53 |
| MOB | 88 | 68 | 100.0% | 68 | 50 | 68 | đạt |
| NFR | 69 | 53 | 100.0% | 53 | 50 | 53 | đạt |
| NOT | 42 | 17 | 100.0% | 17 | 80 | 80 | thiếu 38 |
| OMNI | 23 | 11 | 100.0% | 11 | 50 | 50 | thiếu 27 |
| PAY | 52 | 24 | 100.0% | 24 | 120 | 120 | thiếu 68 |
| PMT | 14 | 6 | 100.0% | 6 | 50 | 50 | thiếu 36 |
| PRJ | 43 | 22 | 100.0% | 22 | 80 | 80 | thiếu 37 |
| QMS | 25 | 12 | 100.0% | 12 | 50 | 50 | thiếu 25 |
| RPT | 60 | 11 | 100.0% | 11 | 80 | 80 | thiếu 20 |
| SAS | 79 | 38 | 100.0% | 38 | 120 | 120 | thiếu 41 |

- Hợp đồng handoff hợp lệ: 34/34 phân hệ.
- Phủ coverage item: 100% ở mọi phân hệ (mỗi yêu cầu có ít nhất một ca).
- Đạt sàn `TC_min`: 2/34 phân hệ. 32 phân hệ dưới sàn: ca thiết kế phủ yêu cầu nhưng chưa đào phân vùng giá trị, biên, bảng quyết định, đường chuyển trạng thái sai và ma trận quyền. Không độn ca để đạt con số.
- Nền tảng của ca: web 913, api 446, android 77.

## Bản enterprise: IND, RPT, DIR, HPM, EBS, HUB, INT, ENT (lane uatent, 2026-11-12)

Tám thư mục mới. Mỗi thư mục có ca thiết kế của phân hệ (nguyên văn `test_cases.json`) và ca sâu: ma trận quyền theo từng thao tác của `openapi.json` (một ca cho mỗi thao tác, quyền lấy từ `x-permission`), idempotency, đường chuyển trạng thái sai, kiểm toán và outbox, cách ly tenant (IDOR), hiệu năng theo ngân sách của khách (5 giây chức năng, 20 giây báo cáo, `docs/qa/perf-budget.json`), a11y và các việc chờ khách (PX-nn, quy tắc R18: không tính là đạt).
Ca sâu đã được thêm vào `test_cases.json` và `traceability.json` (nguồn "UAT enterprise (lane uatent)") nên `npm run uat:run` và `npm run uat:evidence` nhận ra theo mã ca.

| Phân hệ | Ca | Chạy tự động | Làm tay (ca sâu) | Ca thiết kế (làm tay) |
| --- | ---: | ---: | ---: | ---: |
| DIR | 48 | 28 | 5 | 15 |
| EBS | 30 | 19 | 5 | 6 |
| ENT | 59 | 22 | 10 | 27 |
| HPM | 32 | 19 | 7 | 6 |
| HUB | 36 | 25 | 4 | 7 |
| IND | 32 | 21 | 5 | 6 |
| INT | 42 | 29 | 5 | 8 |
| RPT | 60 | 35 | 7 | 18 |
| Tổng | 339 | 198 | - | - |

Kịch bản chạy được nằm ở `apps/api/test/uat/` (Jest, cơ sở dữ liệu nhúng thật, toàn bộ bản enterprise): `enterprise-authz.uat.test.ts` (ma trận quyền cho mọi thao tác) và một bộ cho mỗi phân hệ (`hpm`, `ebs`, `dir`, `ind`, `int`, `hub`, `rpt`, `ent`). Tên mỗi test mang mã ca nên `npm run uat:run` ghép kết quả vào đúng ca; mỗi bộ có một chứng âm (kiểm chứng rằng phép kiểm đỏ được). `npm run uat:check` kiểm mọi mã màn hình, story và ca nêu trong các `uat.json`, và rằng ca khai là tự động có kịch bản nêu mã của nó.
Làm tay còn lại và lý do: trường `automation.reason` của từng ca; tóm tắt ở `_coverage-ledger.md` của từng phân hệ.

## Việc còn lại của writer (nợ có chủ đích)

1. **Đào sâu theo thao tác:** `openapi.json` có 1.017 thao tác (545 có body, 1.493 trường bắt buộc, 818 trường có ràng buộc, 296 enum). Ca "thiếu trường X thì 422" chỉ có giá trị khi khẳng định `detail` nêu đúng trường X, nếu không nó vẫn đạt khi có lỗi 422 khác (oracle yếu). Cần bộ sinh ví dụ hợp lệ theo schema trước khi sinh ca.
2. **Ba mục cần người** của bảng tự kiểm: fault-seeding, adversarial-verify, đánh giá UX bởi người đóng vai persona.
3. **M2 và FP chưa đo** (khai 0): `TC_min` hiện là MAX(M1, M4).
4. **Khối chuyên sâu** (`access`, `db_assert`, `idempotency`, `transition`) chỉ có ở 28 ca then chốt. Các ca loại `RED` mang nhãn `security` thiếu đường dẫn và ma trận vai nên chưa bật được cổng quyền/IDOR; `perf_budget` chưa có vì ngân sách hiệu năng là thoả thuận sản phẩm, chưa ai đặt.
