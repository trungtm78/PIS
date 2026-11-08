# HUB — Trung tâm tích hợp dữ liệu (Integration Hub)
Baseline 1.5 | Kế hoạch HUB-1 (khối migration 2540–2559), chỉ đạo của chủ đầu tư ngày 2026-11-08: xem như xây hệ Integration Hub quản lý mọi kết nối dữ liệu bên ngoài (mua sắm công, Sở Tài chính, HPM, Oracle EBS, Kho bạc, mã dự án quốc gia, tài khoản máy); bổ sung giao thức kết nối và giao thức thu thập dữ liệu theo mô hình ETL; tác tử thu thập chạy trên mọi nền tảng, kể cả ARM. Mô tả kỹ thuật đầy đủ: `docs/integration-hub.md`.

## 1. Mục đích, phạm vi, ranh giới
Mỗi bộ kết nối với hệ thống bên ngoài trước đây tự có bảng kết nối, lịch sử và cảnh báo riêng. Trung tâm tích hợp là một lớp đọc và ghi nhật ký phía trên: mọi bộ kết nối (đã có và sẽ có) cắm vào bằng một bản khai báo (`ConnectorDescriptor`), được quản lý giống nhau: danh mục có sức khỏe, độ mới theo quy tắc, lịch sử chạy, sự cố, bật tắt có lý do, ánh xạ có phiên bản và người duyệt, quy trình ETL có bản ghi bị loại và dòng dõi, tác tử thu thập.
- **Trong phạm vi:** danh mục và sức khỏe (KHỎE, CŨ, LỖI, TẮT, CHỜ BÊN NGOÀI, CHƯA CHẠY); bộ chỉ tiêu cho sổ KPI; nhật ký chạy chỉ ghi thêm; sự cố và ảnh chụp sức khỏe theo giờ; mô hình giao thức (FILE_DROP, WEBHOOK_INBOUND, GENERATOR chạy đủ; HTTPS_REST, SOAP_XML, SFTP, DB_READ, MESSAGE_QUEUE, EMAIL_INBOX là cổng có bộ giả lập, bộ chuyển thật từ chối); mô hình ETL và bộ chạy thuần; đăng ký tác tử thu thập; bộ kiểm tra tuân thủ cho các nhánh bộ kết nối.
- **Ngoài phạm vi:** viết lại bảng kết nối của nhánh khác (bộ chuyển chỉ đọc); bộ chuyển giao thức thật ra mạng; kho và lệnh của ngoại lệ ra mạng (HUB-2); viết lại các lần nhập hiện có thành thể hiện của bộ chạy ETL (việc tiếp theo, bắt đầu với e-GP).
- **Phụ thuộc:** ADM (sổ bộ kết nối, quy tắc `CONNECTOR_FRESHNESS`, `ALERT_TYPE`, `KPI_DEFINITION`, nhật ký kiểm toán ADM-11), MDM (`master_crosswalk`), BID (BID-22 đến BID-24 và các màn hình bộ kết nối khác), HOME (trung tâm cảnh báo).
- **Căn cứ:** thực tiễn tích hợp dữ liệu doanh nghiệp (mô hình ETL, hộp thư chết, dòng dõi dữ liệu); các số liệu ngưỡng là lựa chọn vận hành của nhóm dự án, gắn cờ chưa xác nhận cho đến khi cơ quan phê duyệt quy tắc của mình.

## 2. Actor, tenant và phạm vi quyền
| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Người đọc | Toàn tenant (`hub.read`) | Xem danh mục, chi tiết, lần chạy, bản ghi bị loại, sự cố, sức khỏe, tác tử | Mọi thao tác ghi |
| Quản trị tích hợp | Toàn tenant (`hub.state.manage`, `hub.incident.manage`, `hub.snapshot.capture`, `hub.reject.manage`) | Bật tắt có lý do, báo, nhận và đóng sự cố, quét sức khỏe, xử lý lại hoặc bỏ bản ghi bị loại | Đóng sự cố không lý do |
| Người đề xuất ánh xạ | Toàn tenant (`hub.mapping.propose`) | Đề xuất phiên bản ánh xạ | Tự duyệt phiên bản mình đề xuất |
| Người duyệt ánh xạ | Toàn tenant (`hub.mapping.approve`) | Duyệt hoặc từ chối phiên bản của người khác | Duyệt phiên bản của chính mình |
| Tài khoản máy / bộ kết nối | Toàn tenant (`hub.run.record`, `hub.agent.heartbeat`) | Báo lần chạy, báo nhịp tim | Mọi thao tác khác |
| Quản trị tác tử | Toàn tenant (`hub.agent.manage`) | Đăng ký tác tử thu thập | Lưu bí mật của tác tử trong cơ sở dữ liệu |
Mọi thao tác cần quyền trên toàn tenant: quyền cấp theo cây đơn vị bị từ chối `SCOPE_DENIED` (một kết nối không thuộc đơn vị nào).

## 3. Luồng nghiệp vụ
**L1 Giám sát:** HUB-01 `listHubConnectors` và `getHubHealthSummary` đọc sức khỏe tại thời điểm đọc; `captureHubSnapshot` (job hoặc nút) chụp theo giờ và mở hoặc tự đóng sự cố.
**L2 Bật tắt:** HUB-02 `setHubConnectorState` (If-Match, lý do ≥ 10 ký tự); bộ kết nối có công tắc riêng (e-GP) được chuyển qua lệnh riêng của nó, các bộ khác dùng bảng của trung tâm; mọi lần đều ghi vào lịch sử của trung tâm.
**L3 Báo lần chạy:** `recordHubRun` (bộ kết nối không có lịch sử riêng, tài khoản máy); lần chạy có `source_ref` chỉ ghi một lần; mẫu phải là mẫu và phiên bản bản khai báo có.
**L4 Sự cố:** trung tâm mở một sự cố cho mỗi bộ kết nối và mỗi loại (LỖI, CŨ) và một cho toàn trung tâm (CŨ cùng lúc); điều kiện hết thì tự đóng (`AUTO_RESOLVED`); người dùng báo (`openHubIncident`), nhận và đóng (`decideHubIncident`) kèm lý do.
**L5 ETL:** quy trình lấy lô sau mốc đọc, kiểm tra theo mẫu, biến đổi theo ánh xạ đã duyệt, nạp qua lệnh riêng của bộ kết nối (chạy thử trước); bản ghi hỏng vào danh sách bị loại; mốc đọc chỉ dịch sau khi nạp thành công; `decideHubReject` xử lý lại hoặc bỏ.
**L6 Ánh xạ:** `proposeHubMapping` rồi `decideHubMapping` bởi người khác; phiên bản được duyệt thay phiên bản đang dùng (cái cũ thành `RETIRED`).
**L7 Tác tử:** `registerHubAgent` (hệ điều hành, kiến trúc CPU, phiên bản, bộ kết nối phục vụ), `heartbeatHubAgent` (phiên bản, độ sâu hàng đợi); tình trạng theo nhịp tim.

## 4. State machine
| Đối tượng | Từ | Command | Đến | Guard | Lỗi |
|---|---|---|---|---|---|
| Sự cố | OPEN | `decideHubIncident` ACKNOWLEDGE | ACKNOWLEDGED | lý do, version | 409 `HUB_INCIDENT_STATE_INVALID` |
| Sự cố | OPEN, ACKNOWLEDGED | `decideHubIncident` RESOLVE | RESOLVED | lý do, version | 409 `HUB_INCIDENT_STATE_INVALID` |
| Sự cố | OPEN, ACKNOWLEDGED | quét sức khỏe (điều kiện hết) | RESOLVED (`AUTO_RESOLVED`) | hệ thống | |
| Ánh xạ | PROPOSED | `decideHubMapping` APPROVE | APPROVED (bản cũ RETIRED) | người khác người đề xuất | 403 `SELF_APPROVAL_DENIED`, 409 `HUB_MAPPING_STATE_INVALID` |
| Ánh xạ | PROPOSED | `decideHubMapping` REJECT | REJECTED | như trên | như trên |
| Bản ghi bị loại | OPEN | `decideHubReject` REPROCESS | REPROCESSED | có bộ xử lý nối sẵn, ánh xạ đã duyệt, bản ghi qua được | 409 `HUB_PIPELINE_NOT_WIRED`, 409 `HUB_MAPPING_NOT_APPROVED`, 422 |
| Bản ghi bị loại | OPEN | `decideHubReject` DISCARD | DISCARDED | lý do | 409 `HUB_REJECT_STATE_INVALID` |
| Tác tử | ACTIVE | `heartbeatHubAgent` | ACTIVE | không lùi thời gian | 409 `HUB_AGENT_RETIRED` |
Trạng thái sức khỏe của bộ kết nối không phải máy trạng thái lưu: tính tại lúc đọc theo thứ tự TẮT, LỖI, CHỜ BÊN NGOÀI hoặc CHƯA CHẠY, CŨ, KHỎE.

## 5. Quy tắc nghiệp vụ và công thức
- **BR-HUB-01:** LỖI khi `failing_after_runs` lần chạy gần nhất đều thất bại (quy tắc `INTEGRATION_HUB_POLICY`, mặc định 1); CŨ khi tuổi lần chạy thành công gần nhất vượt `max_age_hours` của quy tắc `CONNECTOR_FRESHNESS` theo `ruleCode` của bản khai báo; CHỜ BÊN NGOÀI khi mẫu chờ xác nhận và chưa chạy lần nào. Mẫu chờ xác nhận được ghi bên cạnh trạng thái, không đổi trạng thái.
- **BR-HUB-02:** tỷ lệ khỏe = số KHỎE / số đang giám sát × 100 (một số thập phân); đang giám sát = đang bật và không CHỜ BÊN NGOÀI; không có bộ nào đang giám sát thì không có con số (không hiển thị 100 giả).
- **BR-HUB-03:** cảnh báo cũ toàn trung tâm khi tỷ lệ bộ CŨ trong số đang giám sát đạt `hub_stale_ratio_percent` và có ít nhất `hub_stale_min_connectors` bộ.
- **BR-HUB-04:** mỗi bộ kết nối chỉ có một sự cố mở cho mỗi loại; sự cố chỉ ghi thêm lịch sử, không xóa.
- **BR-HUB-05:** bí mật không nằm trong cơ sở dữ liệu: chỉ tham chiếu kho khóa `secret://…`.
- **BR-HUB-06:** bộ kết nối có giao thức ra máy khác phải khai báo `egress: DECLARED` (máy chủ và lý do); giao thức không ra mạng thì mã nguồn không được nhập mô-đun mạng hay gọi `fetch` (kiểm tra tĩnh và kiểm tra khi chạy).
- **BR-HUB-07:** ánh xạ chỉ chạy khi được người khác người đề xuất duyệt; mốc đọc chỉ dịch sau khi nạp thành công của lần chạy thật.
- **BR-HUB-08:** tác tử mất nhịp tim sau `agent_stale_after_minutes` (mặc định 15).
Chỉ tiêu cho sổ KPI (`KPI_DEFINITION`): `HUB_CONNECTORS_HEALTHY_PCT`, `HUB_OLDEST_DATA_AGE_DAYS`, `HUB_FAILED_RUNS_7D`, `HUB_DISCREPANCY_BACKLOG`, `HUB_PENDING_MAPPINGS`, mỗi chỉ tiêu có công thức, tử số, mẫu số, loại trừ, nguồn, thời điểm, chủ sở hữu và cờ chưa xác nhận. Loại cảnh báo (`ALERT_TYPE`): `CONNECTOR_FAILING`, `CONNECTOR_HUB_STALE` (và `CONNECTOR_STALE` sẵn có), mỗi loại có chủ sở hữu, việc cần làm và hậu quả.

## 6. Dữ liệu
Khối migration 2540–2559: `hub_connector_state` (công tắc của bộ kết nối không có công tắc riêng, version), `hub_connector_event` (chỉ ghi thêm), `hub_run_log` (chỉ ghi thêm; số dòng, mã lỗi, số liệu từng bước, băm lô, mốc đọc), `hub_incident` và `hub_incident_event` (chỉ ghi thêm), `hub_health_snapshot` (chỉ ghi thêm, mỗi phạm vi một dòng mỗi giờ), `hub_pipeline_mapping` (phiên bản ánh xạ, người đề xuất khác người duyệt bằng CHECK), `hub_pipeline_watermark`, `hub_pipeline_reject` (hộp thư chết), `hub_lineage` (chỉ ghi thêm), `hub_collector_agent`. Mọi bảng có `tenant_id` dẫn đầu mọi chỉ mục, RLS bật và ép buộc, quyền xóa bị thu hồi; classification INTERNAL; không có dữ liệu cá nhân (bản ghi bị loại giữ bản ghi nguồn: coi là dữ liệu nội bộ của tenant, không đưa vào sự kiện outbox).

## 7. API / command
| operationId | Method path | Quyền | Ghi chú |
|---|---|---|---|
| `listHubConnectors` | GET `/integration-hub/connectors` | `hub.read` | DTO riêng, kèm tóm tắt |
| `getHubConnector` | GET `/integration-hub/connectors/{code}` | `hub.read` | dữ liệu mọi tab |
| `listHubConnectorRuns` | GET `/integration-hub/connectors/{code}/runs` | `hub.read` | keyset |
| `listHubRejects` | GET `/integration-hub/connectors/{code}/rejects` | `hub.read` | keyset |
| `listHubIncidents` | GET `/integration-hub/incidents` | `hub.read` | keyset, lọc theo trạng thái và bộ kết nối |
| `getHubHealthSummary` | GET `/integration-hub/health` | `hub.read` | bộ chỉ tiêu, xu hướng, chính sách |
| `listHubAgents` | GET `/integration-hub/agents` | `hub.read` | |
| `setHubConnectorState` | POST `/integration-hub/connectors/{code}/state` | `hub.state.manage` | If-Match, Idempotency-Key |
| `recordHubRun` | POST `/integration-hub/connectors/{code}/runs` | `hub.run.record` | Idempotency-Key |
| `openHubIncident` | POST `/integration-hub/incidents` | `hub.incident.manage` | |
| `decideHubIncident` | POST `/integration-hub/incidents/{id}/decision` | `hub.incident.manage` | If-Match |
| `captureHubSnapshot` | POST `/integration-hub/snapshots` | `hub.snapshot.capture` | |
| `proposeHubMapping` | POST `/integration-hub/connectors/{code}/mappings` | `hub.mapping.propose` | |
| `decideHubMapping` | POST `/integration-hub/mappings/{id}/decision` | `hub.mapping.approve` | If-Match, maker khác checker |
| `decideHubReject` | POST `/integration-hub/rejects/{id}/decision` | `hub.reject.manage` | If-Match |
| `registerHubAgent` | POST `/integration-hub/agents` | `hub.agent.manage` | |
| `heartbeatHubAgent` | POST `/integration-hub/agents/{code}/heartbeat` | `hub.agent.heartbeat` | |
Không có endpoint ghi chung cho trạng thái, `tenant_id` hay quyền. Mã lỗi riêng: `HUB_INCIDENT_STATE_INVALID`, `HUB_MAPPING_VERSION_TAKEN`, `HUB_MAPPING_STATE_INVALID`, `HUB_MAPPING_NOT_APPROVED`, `HUB_REJECT_STATE_INVALID`, `HUB_AGENT_CODE_TAKEN`, `HUB_AGENT_RETIRED`, `HUB_PIPELINE_NOT_WIRED`, `HUB_PROTOCOL_UNAVAILABLE`, `HUB_MANIFEST_INVALID`, `WEBHOOK_SIGNATURE_INVALID`.

## 8. UI/UX
- **HUB-01:** danh mục bộ kết nối, bộ chỉ tiêu có biểu tượng "i" (công thức, nguồn, thời điểm, cờ chưa xác nhận), cảnh báo cũ toàn trung tâm, nút quét sức khỏe.
- **HUB-02:** bảy tab (tổng quan, lần chạy, quy trình ETL, ánh xạ, chênh lệch, tài khoản và tác tử, mẫu tệp và chính sách) và liên kết sang màn hình riêng của bộ kết nối (BID-22 đến BID-24, BID-32, BID-33, các màn hình FEED và ENT theo route).
- **HUB-03:** nhật ký sự cố có lọc, báo, nhận và đóng sự cố kèm lý do.
Bảy trạng thái chuẩn (đang tải, có dữ liệu, rỗng, lỗi nhập, lỗi dịch vụ có thử lại, từ chối quyền, dữ liệu cũ) cho cả ba màn hình; mọi chuỗi qua khóa dịch; web trước, thẻ sức khỏe chỉ đọc trên điện thoại là tùy chọn (chưa làm).

## 9. Sự kiện, job, tích hợp, quan sát
Sự kiện outbox (chỉ id, mã, số đếm): `hub.connector.state_changed.v1`, `hub.run.recorded.v1`, `hub.incident.opened.v1`, `hub.incident.acknowledged.v1`, `hub.incident.resolved.v1`, `hub.incident.auto_resolved.v1`, `hub.snapshot.captured.v1`, `hub.mapping.proposed.v1`, `hub.mapping.approved.v1`, `hub.mapping.rejected.v1`, `hub.reject.reprocessed.v1`, `hub.reject.discarded.v1`, `hub.agent.registered.v1`, `hub.agent.heartbeat.v1`. Job: quét sức khỏe theo giờ gọi `captureHubSnapshot`. Cảnh báo `CONNECTOR_FAILING` và `CONNECTOR_HUB_STALE` là loại việc của trung tâm cảnh báo (nguồn `CONNECTOR`).

## 10. Kiểm thử
| ID | Loại | Ưu tiên | Nội dung |
|---|---|---|---|
| UAT-HUB-001 | UAT | P0 | Danh mục: bộ chờ bên ngoài không tính vào tỷ lệ khỏe; bộ lỗi có cảnh báo; "i" của mọi chỉ tiêu |
| UAT-HUB-002 | UAT | P0 | Bật tắt có lý do, chuyển cho lệnh riêng của e-GP; version cũ bị từ chối |
| UAT-HUB-003 | UAT | P0 | Sự cố mở một lần, tự đóng khi hết điều kiện, nhận và đóng có lý do |
| UAT-HUB-004 | UAT | P0 | Ánh xạ: người đề xuất không tự duyệt; quy trình không chạy khi chưa duyệt; mốc đọc chỉ dịch sau nạp; bản ghi bị loại xử lý lại |
| UI-HUB-01 đến UI-HUB-03 | screen-contract | P0 | nhãn trường, quy tắc chính, bảy trạng thái |
Kiểm thử kỹ thuật: `packages/kernel/test/connector-hub.test.ts`, `connector-protocols.test.ts`, `etl-pipeline.test.ts` (kể cả lỗi từng phần, thử lại, phát lại, mốc đọc, xử lý lại bản ghi bị loại, kiểm tra tuân thủ), `packages/db/test/hub-store.test.ts`, `apps/api/test/hub/hub.test.ts`, ma trận quyền, cách ly tenant (ca id lạ cho ba lệnh theo id), `apps/web/src/screens/hub/*.test.tsx`.

## 11. Tiêu chí nghiệm thu (đo được)
- **AC-HUB-01:** Cho ba bộ kết nối (một khỏe, một chờ bên ngoài, một lỗi), khi mở HUB-01, thì tỷ lệ khỏe là 50% (1/2, không tính bộ chờ), bộ lỗi có cảnh báo `CONNECTOR_FAILING`, mỗi chỉ tiêu có "i"; test UAT-HUB-001.
- **AC-HUB-02:** Cho e-GP đang bật, khi tắt có lý do ≥ 10 ký tự, thì công tắc và lịch sử của e-GP đổi, version cũ là 409 `VERSION_CONFLICT`; test UAT-HUB-002.
- **AC-HUB-03:** Cho một bộ kết nối có lần chạy lỗi, khi quét hai lần, thì chỉ một sự cố mở; khi có lần chạy thành công và quét lại, sự cố tự đóng; nhận và đóng cần lý do; test UAT-HUB-003.
- **AC-HUB-04:** Cho một ánh xạ do A đề xuất, khi A duyệt thì 403 `SELF_APPROVAL_DENIED`, khi B duyệt thì được dùng; khi nạp lỗi thì mốc đọc không dịch; test UAT-HUB-004.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+
R1 "dùng thật": danh mục, sức khỏe, nhật ký chạy, sự cố, bật tắt, bốn bản khai báo có sẵn. R2: viết lại các lần nhập hiện có thành thể hiện của bộ chạy ETL, ngoại lệ ra mạng (HUB-2), bộ chuyển thật cho HTTPS_REST và SFTP, lịch chạy theo lịch làm việc ADM, trung tâm cảnh báo cho mọi bộ kết nối, thẻ sức khỏe trên điện thoại. Hạng mục cần người duyệt: ngưỡng của `INTEGRATION_HUB_POLICY` và `CONNECTOR_FRESHNESS` (chủ nghiệp vụ), ngoại lệ ra mạng (quản trị bảo mật).

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba
- Mẫu tệp chính thức của các hệ thống bên ngoài chưa có: bộ kết nối giữ trạng thái "chờ bên ngoài" cho đến khi có mẫu và xác nhận (owner: quản trị tích hợp; điều kiện: có mẫu chính thức).
- Ngưỡng độ mới là giá trị khởi điểm chưa xác nhận (owner: chủ nghiệp vụ; điều kiện: cơ quan phê duyệt quy tắc của mình).
- Tác tử thu thập do nhánh FEED-1 xây; trung tâm chỉ cố định đăng ký và nhịp tim (owner: FEED-1).
- Đọc "CTL" trong yêu cầu là ETL (trích xuất, biến đổi, nạp); đọc "ARM" là ARM (nền tảng phần cứng và hệ điều hành chéo): ghi trong `docs/integration-hub.md`.
