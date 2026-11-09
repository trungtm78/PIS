# Cấu hình hạ tầng khuyến nghị cho môi trường UAT và Production

Tài liệu này đáp ứng mục "cấu hình UAT/Production khuyến nghị" của HSKT v0.3 (YCK.02, HT.05) và là phụ lục của `onprem-install.md`. Các con số là **khuyến nghị xuất phát**, tính từ giả định tải ở mục 1 và từ giới hạn tài nguyên trong `infra/onprem/compose/env.template`; chúng phải được đo lại trên phần cứng của khách trong đợt UAT (mục 9) trước khi chốt mua sắm.

## 1. Giả định tải (cần khách xác nhận)

| Giả định | Giá trị dùng để tính | Ghi chú |
|---|---|---|
| Số đầu mối nhập liệu | 09 | Mỗi đầu mối có người nhập và người duyệt |
| Người dùng có tên | 150 | 09 đầu mối x tối đa 10 người + Ban kế hoạch đầu tư + lãnh đạo + quản trị |
| Người dùng đồng thời giờ cao điểm | 40 | Cao điểm là hạn nhập số liệu cuối kỳ (ngày 5 hằng tháng) |
| Lãnh đạo xem dashboard/báo cáo | 25 | Truy vấn đọc, trình chiếu tại phòng họp giao ban |
| Dung lượng CSDL khi vận hành | 20 GB, tăng 10 GB mỗi năm | Biểu mẫu, nhật ký kiểm toán, lịch sử bản chốt kỳ |
| Tệp đính kèm | 200 GB, tăng 100 GB mỗi năm | Tệp tải lên đã quét mã độc, lưu ở kho đối tượng |
| Thời gian cao điểm nhập/kết xuất | 5 ngày mỗi tháng | Kết xuất PDF/Excel lô lớn chạy ở `workers`, không chạy trên API |

Nếu số người dùng đồng thời vượt 100 hoặc dung lượng CSDL vượt 100 GB, áp dụng mục 8.

## 2. Mô hình triển khai

| Môi trường | Mô hình | Mục đích |
|---|---|---|
| UAT | 1 máy chủ, toàn bộ compose set (`infra/onprem/compose`) | Nghiệm thu chức năng, đo hiệu năng, diễn tập cài đặt và khôi phục |
| Production | 2 máy chủ ứng dụng/CSDL tại site 1 + máy chủ dự phòng (CSDL standby đồng bộ) + kho đối tượng bất biến tại site 2 | Vận hành thật, RPO 15 phút, RTO 4 giờ |

UAT phải cùng phiên bản gói cài đặt, cùng cấu hình mạng egress, cùng ClamAV và cùng realm Keycloak với Production để kết quả nghiệm thu có giá trị (khác nhau về kích thước, không khác nhau về cấu trúc).

## 3. UAT (một máy chủ)

| Thành phần | Khuyến nghị |
|---|---|
| CPU | 8 vCPU |
| Bộ nhớ | 24 GB |
| Đĩa hệ thống và ảnh container | 100 GB SSD |
| Đĩa CSDL và WAL | 200 GB SSD (IOPS bền vững tối thiểu 3.000) |
| Kho tệp đính kèm | 300 GB (đĩa cục bộ hoặc kho S3 nội bộ) |
| Kho sao lưu (bucket khóa bất biến, site 2 hoặc máy khác) | 500 GB |
| Mạng | 1 Gbps nội bộ; đường ra chỉ tới kho đối tượng và máy chủ thư mục (xem mục 6) |
| Hệ điều hành | Linux x86-64 hoặc arm64 (gói hỗ trợ cả hai), Docker Engine với compose v2.24 trở lên, đồng hồ đồng bộ NTP |

## 4. Production

| Máy chủ | Số lượng | CPU | Bộ nhớ | Đĩa | Chạy gì |
|---|---|---|---|---|---|
| CSDL chính | 1 | 8 vCPU | 32 GB | 500 GB SSD (CSDL + WAL), 2 đĩa RAID 1 hoặc tương đương | PostgreSQL 18, pgBackRest, lưu trữ WAL liên tục |
| CSDL dự phòng (standby đồng bộ) | 1 | 8 vCPU | 32 GB | 500 GB SSD | Bản sao đồng bộ, nơi lấy mốc đối chiếu khi diễn tập khôi phục |
| Ứng dụng | 2 (hoạt động-hoạt động sau bộ cân bằng tải) | 8 vCPU | 16 GB | 100 GB SSD | web (nginx), api, workers, keycloak, clamav |
| Kho đối tượng bất biến, site 2 | 1 hệ thống (của khách) | theo nhà cung cấp | theo nhà cung cấp | 1 TB trở lên, hai bucket (vận hành và lưu trữ) | Bản sao lưu khóa COMPLIANCE, tách khỏi vận hành |
| Phương tiện ngoại tuyến | 2 bộ luân phiên | - | - | 1 TB mỗi bộ | Bản sao ngoại tuyến hằng tháng (`backup-immutable.md`, mục Offline copy) |

Ghi chú: ClamAV cần khoảng 3 GB bộ nhớ riêng cho cơ sở chữ ký; Keycloak cần tối thiểu 2 GB. Với 2 máy ứng dụng, Keycloak chạy ở chế độ cụm cần cấu hình bổ sung (bộ đệm phân tán) ngoài phạm vi gói hiện tại: giai đoạn đầu chạy Keycloak trên một máy ứng dụng và dùng máy thứ hai làm dự phòng nóng.

### Giới hạn container (khớp `infra/onprem/compose/env.template`)

| Dịch vụ | CPU tối đa | Bộ nhớ tối đa |
|---|---|---|
| db | DB_CPUS=4 | DB_MEMORY=8g |
| keycloak | KEYCLOAK_CPUS=2 | KEYCLOAK_MEMORY=2g |
| clamav | CLAMAV_CPUS=2 | CLAMAV_MEMORY=3g |
| api | API_CPUS=2 | API_MEMORY=2g |
| workers | WORKERS_CPUS=2 | WORKERS_MEMORY=2g |
| web | WEB_CPUS=1 | WEB_MEMORY=256m |
| backup | BACKUP_CPUS=2 | BACKUP_MEMORY=2g |

Production nâng `DB_CPUS` lên 8, `DB_MEMORY` lên 24g, `DB_SHARED_BUFFERS` lên 8GB (khoảng một phần tư bộ nhớ của máy CSDL), `DB_MAX_CONNECTIONS` giữ 200 và `API_CPUS`/`WORKERS_CPUS` lên 4 khi đo thấy CPU của API trên 70% ở giờ cao điểm.

## 5. Sao lưu, lưu trữ và sức chứa kho

Chính sách: `infra/backup/backup-policy.json` (bản đầy đủ hằng ngày, gia tăng 4 giờ, khác biệt hằng tuần, bản đầy đủ hằng tháng vào kho lưu trữ, giữ tối thiểu 03 bản mới nhất, khóa bất biến COMPLIANCE 36 ngày cho kho vận hành và 400 ngày cho kho lưu trữ).

| Kho | Cách tính | Dung lượng ước tính |
|---|---|---|
| Kho vận hành (repo1) | 35 bản đầy đủ nén (khoảng 7 GB mỗi bản với CSDL 20 GB) + WAL 35 ngày (khoảng 3 GB mỗi ngày) + hệ số 1,2 vì khóa giữ phiên bản 36 ngày | khoảng 450 GB |
| Kho lưu trữ (repo2) | 12 bản đầy đủ hằng tháng + WAL của 2 bản gần nhất | khoảng 200 GB |
| Phương tiện ngoại tuyến | 1 bản đầy đủ tháng gần nhất cộng tệp `backup.info` và `archive` | khoảng 20 GB mỗi lần, bộ 1 TB chứa nhiều tháng |

Các hệ số (nén 3:1, 3 GB WAL mỗi ngày) là giả định: sau tháng đầu vận hành phải đo lại bằng `pgbackrest info` và điều chỉnh dung lượng.

## 6. Mạng và an toàn

* Chỉ dịch vụ `web` mở cổng 80/443 ra mạng người dùng. CSDL, API và ClamAV nằm trên mạng nội bộ không có cổng công bố và không có đường ra.
* Đường ra duy nhất là mạng `egress` (dải 172.29.250.0/24) của `db`, `backup` và `keycloak`, bị tường lửa chủ (`infra/onprem/config/egress-firewall.sh`) giới hạn tới kho đối tượng (cổng 443) và máy chủ thư mục LDAPS (cổng 636); mọi đích khác bị chặn.
* Băng thông: 100 Mbps từ site 1 tới kho đối tượng site 2 là đủ cho WAL liên tục và bản đầy đủ hằng ngày trong cửa sổ 4 giờ; bản đầy đủ đầu tiên (khoảng 20 GB) cần khoảng 30 phút ở 100 Mbps.
* Chứng chỉ TLS (cert và key) do khách cấp; Keycloak tin cậy CA của máy chủ thư mục qua `ldap_ca_cert`.

## 7. Khả dụng và phục hồi

| Chỉ tiêu | Giá trị | Cách đạt |
|---|---|---|
| RPO | 15 phút | WAL chuyển bắt buộc mỗi 60 giây, lưu trữ liên tục sang site 2, standby đồng bộ |
| RTO | 4 giờ | Phục hồi từ bản đầy đủ gần nhất (không phải chuỗi dài) + WAL; diễn tập hằng quý đo thời gian thật |
| Chuyển đổi sang standby | 15 phút | `infra/postgres/backup.json`, runbook `postgres.md` |
| Mất một máy ứng dụng | Không gián đoạn | Máy còn lại phục vụ; kiểm tra sức khỏe của bộ cân bằng tải |
| Mất cả site 1 | Phục hồi tại site 2 trong RTO | Dùng kho site 2 và gói cài đặt ngoại tuyến |

Sổ chứng cứ diễn tập khôi phục: `infra/backup/restore-drill-ledger.json`; lệnh `node scripts/backup-verify.mjs drill-status` báo diễn tập quá hạn.

## 8. Khi tải tăng

| Dấu hiệu | Việc làm |
|---|---|
| Hơn 100 người dùng đồng thời | Thêm máy ứng dụng thứ ba, tăng `DB_MAX_CONNECTIONS` kèm bộ gom kết nối, đo lại |
| CSDL trên 100 GB | Tách đĩa WAL, tăng bộ nhớ máy CSDL, xem lại bảng lớn (nhật ký kiểm toán) theo chính sách lưu giữ |
| Kết xuất báo cáo lớn làm chậm giao diện | Tăng `WORKERS_CPUS` và `WORKERS_MEMORY` (workers tách khỏi API) |
| ClamAV chậm khi tải tệp lớn | Tăng `CLAMAV_CPUS`, `MACHVON_CLAMD_TIMEOUT_MS` |

## 9. Việc cần đo trên phần cứng của khách (PENDING-EXTERNAL)

Chưa có số đo hiệu năng trên phần cứng của khách; các mục sau là điều kiện chốt cấu hình Production trong đợt UAT:

1. Thời gian đáp ứng p95 của 10 thao tác chính với 40 người dùng đồng thời (kịch bản trong bộ UAT hiệu năng).
2. Thời gian phục hồi thực tế của bản đầy đủ gần nhất (đầu vào của RTO).
3. Thời gian bản đầy đủ hằng ngày và dung lượng thực của kho sau 7 ngày.
4. Thời gian quét ClamAV một tệp 25 MiB.
5. Mức dùng CPU, bộ nhớ, đĩa trong ngày cao điểm cuối kỳ.

Kết quả ghi vào biên bản UAT; nếu một số đo vượt ngưỡng, nâng cấu hình ở mục 4 trước khi vận hành thật.
