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

## Persona và hành trình của bản enterprise

Thêm bởi lane uatent (2026-11-12) cho tám phân hệ IND, RPT, DIR, HPM, EBS, HUB, INT, ENT. Mỗi persona là một người của tenant A giữ đúng một vai (một bộ quyền, trên cả tenant); vai nào cần tách hai tay thì có hai persona khác nhau. Quyền lấy từ `x-permission` của `openapi.json`. Tên persona là tên vai của khối `access.allow`; giá trị tài khoản không nằm trong repo.

| Persona | Phân hệ | Tenant | Vai |
| --- | --- | --- | --- |
| ind-admin | IND | A | giữ ind.read, ind.entry, ind.import.preview, ind.import trên cả tenant |
| ind-reader | IND | A | giữ ind.read trên cả tenant |
| rpt-preparer | RPT | A | giữ rpt.read, rpt.generate, home.read trên cả tenant |
| rpt-checker | RPT | A | giữ rpt.read, rpt.check trên cả tenant |
| rpt-approver | RPT | A | giữ rpt.read, rpt.approve, rpt.issue trên cả tenant |
| rpt-sender | RPT | A | giữ rpt.read, rpt.deliver, rpt.answer trên cả tenant |
| rpt-signer | RPT | A | giữ rpt.read, rpt.sign trên cả tenant |
| rpt-locker | RPT | A | giữ rpt.read, rpt.lock.read, rpt.lock.unlock trên cả tenant |
| rpt-mailer | RPT | A | giữ rpt.read, rpt.mail.read, rpt.mail.manage trên cả tenant |
| rpt-crosschecker | RPT | A | giữ rpt.read, rpt.crosscheck.read, rpt.crosscheck.explain trên cả tenant |
| rpt-reader | RPT | A | giữ rpt.read trên cả tenant |
| rpt-all | RPT | A | giữ rpt.read, rpt.generate, rpt.check, rpt.approve, rpt.issue, rpt.deliver, rpt.answer, home.read trên cả tenant |
| dir-secretary | DIR | A | giữ directive.meeting.manage, directive.manage, directive.close, directive.read trên cả tenant |
| dir-assignee | DIR | A | giữ directive.progress, directive.read trên cả tenant |
| dir-closer | DIR | A | giữ directive.close, directive.read trên cả tenant |
| dir-decider | DIR | A | giữ directive.extension.decide, directive.read trên cả tenant |
| dir-reader | DIR | A | giữ directive.read trên cả tenant |
| hpm-admin | HPM | A | giữ hpm.read, hpm.admin, hpm.push, hpm.receipt, hpm.correction.propose, hpm.correction.decide trên cả tenant |
| hpm-pusher | HPM | A | giữ hpm.read, hpm.push trên cả tenant |
| hpm-receiver | HPM | A | giữ hpm.read, hpm.receipt trên cả tenant |
| hpm-proposer | HPM | A | giữ hpm.read, hpm.correction.propose trên cả tenant |
| hpm-decider | HPM | A | giữ hpm.read, hpm.correction.decide trên cả tenant |
| hpm-reader | HPM | A | giữ hpm.read trên cả tenant |
| ebs-admin | EBS | A | giữ ebs.read, ebs.admin, ebs.import, ebs.import.preview, ebs.reconcile trên cả tenant |
| ebs-reconciler | EBS | A | giữ ebs.read, ebs.reconcile trên cả tenant |
| ebs-previewer | EBS | A | giữ ebs.read, ebs.import.preview trên cả tenant |
| ebs-owner | EBS | A | giữ ebs.read, ebs.reconcile trên cả tenant |
| ebs-reader | EBS | A | giữ ebs.read trên cả tenant |
| hub-admin | HUB | A | giữ hub.read, hub.state.manage, hub.run.record, hub.incident.manage, hub.snapshot.capture, hub.reject.manage, hub.agent.manage, hub.agent.heartbeat trên cả tenant |
| hub-proposer | HUB | A | giữ hub.read, hub.mapping.propose trên cả tenant |
| hub-approver | HUB | A | giữ hub.read, hub.mapping.approve trên cả tenant |
| hub-reader | HUB | A | giữ hub.read trên cả tenant |
| int-admin | INT | A | giữ int.account.read, int.account.manage, int.access.read, int.dataset.read, int.dataset.manage, int.bi.read, int.bi.manage, int.codes.read, int.codes.propose, int.codes.approve, int.system.manage trên cả tenant |
| int-checker | INT | A | giữ int.codes.read, int.codes.approve trên cả tenant |
| int-reader | INT | A | giữ int.account.read, int.access.read, int.dataset.read, int.bi.read, int.codes.read trên cả tenant |
| may-doc-bi | INT | A | giữ open.projects.read, open.disbursement.read, open.project-codes.read trên cả tenant |
| ent-builder | ENT | A | giữ funding.snapshot.build, funding.snapshot.read trên cả tenant |
| ent-freezer | ENT | A | giữ funding.snapshot.freeze, funding.snapshot.read trên cả tenant |
| ent-both | ENT | A | giữ funding.snapshot.build, funding.snapshot.freeze, funding.snapshot.read trên cả tenant |
| ent-reader | ENT | A | giữ funding.snapshot.read trên cả tenant |
| ent-leader | ENT | A | giữ home.read trên cả tenant |
| ent-org-admin | ENT | A | giữ adm.migration.read, adm.migration.approve trên cả tenant |
| ent-equipment | ENT | A | giữ bid.read, bid.plan.manage trên cả tenant |
| ent-report-editor | ENT | A | giữ report.read, report.edit, report.import trên cả tenant |
| quan-tri-tenant-b | mọi phân hệ | B | quản trị tenant B của cùng phân hệ, dùng để thử IDOR (ca ISO) |

| Journey | Phân hệ | Nền tảng |
| --- | --- | --- |
| J-AUTHZ-01 | mọi phân hệ enterprise | api |
| J-DIR-BOARD-01 | DIR | api |
| J-DIR-LIFECYCLE-01 | DIR | api |
| J-DIR-PWA-01 | DIR | web |
| J-DIR-REPORT-01 | DIR | api |
| J-EBS-CONN-01 | EBS | api |
| J-EBS-IMPORT-01 | EBS | api |
| J-EBS-RECON-01 | EBS | api |
| J-ENT-EQUIP-01 | ENT | api |
| J-ENT-LEADER-01 | ENT | api |
| J-ENT-NARRATIVE-01 | ENT | api |
| J-ENT-ORG-01 | ENT | api |
| J-ENT-PWA-01 | ENT | web |
| J-ENT-SNAPSHOT-01 | ENT | api |
| J-FR-DIR-01 | DIR | api |
| J-FR-DIR-02 | DIR | web |
| J-FR-DIR-03 | DIR | api |
| J-FR-DIR-04 | DIR | api |
| J-FR-DIR-05 | DIR | api |
| J-FR-DIR-06 | DIR | api |
| J-FR-DIS-32 | ENT | api |
| J-FR-DIS-34 | ENT | api |
| J-FR-DIS-35 | ENT | api |
| J-FR-EBS-01 | EBS | web |
| J-FR-EBS-02 | EBS | web |
| J-FR-EQP-01 | ENT | web |
| J-FR-EQP-02 | ENT | web |
| J-FR-HPM-01 | HPM | web |
| J-FR-HPM-02 | RPT | web |
| J-FR-HUB-01 | HUB | web |
| J-FR-HUB-02 | HUB | web |
| J-FR-HUB-03 | HUB | web |
| J-FR-IND-01 | IND | api |
| J-FR-IND-02 | IND | web |
| J-FR-IND-03 | IND | api |
| J-FR-INT-01 | INT | web |
| J-FR-INT-02 | INT | web |
| J-FR-INT-03 | INT | web |
| J-FR-INT-04 | INT | web |
| J-FR-INT-05 | INT | web |
| J-FR-RPT-01 | RPT | web |
| J-FR-RPT-02 | RPT | web |
| J-FR-RPT-03 | RPT | web |
| J-FR-RPT-04 | RPT | web |
| J-FR-RPT-05 | RPT | web |
| J-FR-RPT-06 | RPT | web |
| J-FR-RPT-07 | RPT | web |
| J-FR-RPT-08 | RPT | web |
| J-FR-RPT-09 | RPT | web |
| J-HPM-CONN-01 | HPM | api |
| J-HPM-CORR-01 | HPM | api |
| J-HPM-PUSH-01 | HPM | api |
| J-HUB-AGENT-01 | HUB | api |
| J-HUB-CONN-01 | HUB | api |
| J-HUB-HEALTH-01 | HUB | api |
| J-HUB-INCIDENT-01 | HUB | api |
| J-HUB-MAPPING-01 | HUB | api |
| J-HUB-REJECT-01 | HUB | api |
| J-HUB-RUN-01 | HUB | api |
| J-IND-ENTRY-01 | IND | api |
| J-IND-IMPORT-01 | IND | api |
| J-INT-BI-01 | INT | api |
| J-INT-CODES-01 | INT | api |
| J-INT-OPEN-01 | INT | api |
| J-RPT-CROSS-01 | RPT | api |
| J-RPT-DELIVER-01 | RPT | api |
| J-RPT-FORMS-01 | RPT | api |
| J-RPT-MAIL-01 | RPT | api |
| J-RPT-PUBLISH-01 | RPT | api |
| J-RPT-SIGN-01 | RPT | api |

Ba hành trình của phần đầu (J-ISOL-01, J-MONEY-01, J-RESTORE-01) vẫn áp dụng; ca cách ly của tám phân hệ dùng J-ISOL-01. Ca chờ khách mang nhãn PX-nn trong `rule_ref` hoặc tiêu đề (`docs/delivery/11-pending-external-register.md`) và không được tính là đạt (quy tắc R18).
