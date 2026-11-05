# Gói nghiệp vụ UAT: MACHVON (đầu tư công)

Sinh ở Bước 0 của `uat-test-writer`. Dùng cho mọi bộ UAT trong `docs/uat/<feature>/`.

## Authority Brief (nguồn chân lý, độc lập với mã)

| Nguồn | Dùng cho |
| --- | --- |
| `Design/MACHVON_Design/03_Engineering/nonfunctional_requirements.json` | yêu cầu phi chức năng NFR-* và cách đo (`measure`) |
| `Design/MACHVON_Design/03_Engineering/test_cases.json` | ca thiết kế (bước, kết quả mong đợi, bằng chứng cần thu) |
| `Design/MACHVON_Design/03_Engineering/traceability.json` | màn hình ↔ yêu cầu ↔ ca |
| `Design/MACHVON_Design/03_Engineering/legal_confirmation_ledger.json` | căn cứ pháp lý (chưa xác nhận thì ca chưa được tuyên bố là đạt về pháp lý) |
| `Design/MACHVON_Design/01_Documents/05_modules/*.md` | quy tắc nghiệp vụ theo phân hệ |

Quy tắc oracle: kết quả mong đợi của ca là của thiết kế. Mã được đọc để tìm điểm neo (đường dẫn, bảng), không để lấy kỳ vọng.

## Persona (người dùng thật)

| Persona | Vai | Tenant | Ghi chú |
| --- | --- | --- | --- |
| chuyen-vien-tinh-a / chuyen-vien-tinh-b | chuyên viên có grant theo cây đơn vị | A / B | cặp dùng để thử cách ly tenant |
| chuyen-vien-so-x / chuyen-vien-so-nn / chuyen-vien-ban-qlda-gt | chuyên viên một đơn vị | A | thử phạm vi đơn vị trong một tenant |
| quan-tri-tenant-a | quản trị tenant | A | theme, thành viên |
| quan-tri-he-thong | quản trị hệ thống (control plane) | — | kiểm tra RLS toàn schema |
| nguoi-lap-bao-cao | người lập báo cáo giải ngân | A | gửi báo cáo, idempotency |
| can-bo-phan-bo-von | cán bộ phân bổ vốn | A | lệnh phân bổ, số dư |
| nha-cung-cap-kenh-thong-bao | nhà cung cấp kênh (email/SMS/Zalo) | — | biên nhận có thể muộn, trùng, sai thứ tự |
| he-thong-workflow | tác vụ nền | — | ngữ cảnh tenant của worker |
| can-bo-hien-truong | cán bộ hiện trường (ứng dụng di động) | A | offline, đổi tenant |
| van-hanh-ha-tang | vận hành hạ tầng | — | sao lưu, khôi phục, rollback |

## Hành trình (journey)

| Journey | Nội dung | Nền tảng |
| --- | --- | --- |
| J-ISOL-01 | người của tenant/đơn vị này không bao giờ thấy hoặc đổi được dữ liệu của tenant/đơn vị khác | api, web, android |
| J-MONEY-01 | tiền không bị tạo ra hay mất đi: một lệnh thành công, gửi lại không nhân đôi, biên nhận không lùi trạng thái | api, android |
| J-RESTORE-01 | sau sự cố, dữ liệu và dịch vụ khôi phục trong cam kết RPO 15 phút, RTO 4 giờ | api (hạ tầng) |

## Mock được phép

Chỉ biên ngoài không do mình sở hữu: nhà cung cấp kênh thông báo, kho lưu trữ đối tượng ngoài, dịch vụ ký số. Cơ sở dữ liệu, API và web của MACHVON chạy thật.

## Môi trường chạy trên máy này

Ngăn xếp `apps/api/test/e2e-stack` (API Nest thật + PostgreSQL 18 nhúng + 3 tenant A/B/C đã seed), web Vite, trình duyệt Chromium. Không có: sao lưu WAL/PITR, kho đối tượng thật, Keycloak, Temporal, PowerSync, thiết bị Android (chỉ có AVD `guide`, chưa build APK), macOS.
