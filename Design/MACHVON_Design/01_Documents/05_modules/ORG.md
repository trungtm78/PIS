# ORG — Tổ chức và vai trò của bản enterprise (chỉ bản doanh nghiệp)

Đặc tả phân hệ của lane ENT-3d theo `_KHUNG_DAC_TA.md`: gói cấu hình PVFCCo (yêu cầu HT.02, HT.03, MD.03, QT.01 của HSKT v0.3). Gói là DỮ LIỆU MẪU gắn nhãn `PVFCCO-TEMPLATE`, không có người, không có tài khoản; tên hai Tổ dự án là chỗ giữ `[tên Tổ dự án]` cho tới khi khách hàng nêu.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Khách hàng có 09 đầu mối nhập liệu (07 Ban/Đơn vị và 02 Tổ dự án), mỗi đầu mối 01 người nhập và 01 người phê duyệt; Ban Kế hoạch và Đầu tư (KHĐT) rà soát và chốt kỳ; Ban Tổng Giám đốc và Hội đồng quản trị xem dashboard; Ban Chuyển đổi số và Công nghệ thông tin (CĐS&CNTT) quản trị. Cấu hình này phải nạp được, kiểm chứng được và sửa được khi khách xác nhận tên, mà không lập trình lại và không tạo tenant cho từng đơn vị.

**Trong phạm vi.** Một tenant, cây đơn vị, năm vai trò theo phạm vi (nhập liệu và phê duyệt `UNIT_ONLY`; rà soát và chốt kỳ, lãnh đạo xem, quản trị `TENANT`), chỗ ngồi (vai trò ở đơn vị với số người tối thiểu và tối đa, không bao giờ là người), quy trình duyệt từng bước (`UNIT_APPROVER` → `PLANNING_REVIEW` → `PERIOD_CLOSE` → `PUSH`) có hạn từng bước, mặc định ủy quyền, nhóm thư mục AD cho từng chỗ ngồi, danh mục dùng chung MD.03 (kỳ báo cáo, loại báo cáo, cơ quan nhận, nguồn vốn, đơn vị tính, nguyên nhân chậm tiến độ trong cây MDM-17).

**Ngoài phạm vi.** Người và tài khoản thật (chờ khách, R18); tên chính thức của hai Tổ dự án; đồng bộ nhóm thư mục thành quyền tự động (bản đồ nhóm là nguồn cho bước đó); biểu mẫu chính thức.

**Phụ thuộc.** ADM (lô nhập `migration_batch`, quy tắc quản trị, ma trận thẩm quyền, ADM-11), IAM (đơn vị, vai trò), MDM (đề xuất và duyệt hai người), WF-1 (`REPORT_ACCEPT`).

**Căn cứ.** HSKT v0.3 HT.02, HT.03, MD.03, QT.01; kế hoạch ENT-3 và eng-review R24.

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Quản trị Ban CĐS&CNTT | TENANT | đăng ký, chạy thử lô gói (`adm.migration.manage`); xem gói (`adm.migration.read`) | áp dụng lô do mình đăng ký |
| Người áp dụng | TENANT | `adm.migration.approve` áp dụng lô, rồi tạo đơn vị và vai trò (cần thêm quyền của từng loại đối tượng) | tạo vai trò có bậc hoặc quyền hơn mình |
| Người nhập liệu | UNIT_ONLY | nhập, nhập tệp, nộp báo cáo của đơn vị mình | quyết định, xem đơn vị khác |
| Người phê duyệt đơn vị | UNIT_ONLY | duyệt số liệu của đơn vị mình, ủy quyền | nhập, chốt kỳ, đẩy |
| Ban KHĐT rà soát | TENANT | rà soát, chốt kỳ, đẩy HPM, đối chiếu EBS | nhập liệu |
| Lãnh đạo xem | TENANT | chỉ đọc | mọi thao tác ghi |

## 3. Luồng nghiệp vụ

### 3.1 Nạp gói (UC-ORG-01) — ORG-01
1. Quản trị tải tệp mẫu (`pvfcco-template.csv`, hoặc tệp đã sửa tên) ở ORG-01.
2. Quản trị đăng ký tệp ở màn hình lô nhập (thực thể `ORG_PACK`, ánh xạ `ORG-PACK-1`, nguồn `PVFCCO-TEMPLATE`) và yêu cầu chạy thử. Chạy thử đọc từng dòng, xét cây đơn vị, vai trò, chỗ ngồi, phân tách nhiệm vụ, chuỗi duyệt, chính sách vắng mặt, danh mục theo quy tắc kiểu của MDM; lỗi nêu dòng và cột (`PACK_INVALID`).
3. Người khác áp dụng lô (`SELF_APPROVAL_DENIED` nếu là người đăng ký); tổng kiểm soát khớp.
4. Người áp dụng gọi `materialiseEnterpriseOrgPack` với mã lô: tạo đơn vị (dưới gốc của tenant, gốc được nhận nguyên), vai trò tùy biến; đề xuất (không kích hoạt) quy tắc `REPORT_ACCEPT` dạng `STAGED`, quy tắc `ABSENCE_POLICY`, bản nháp ma trận thẩm quyền (gộp với ma trận đang hiệu lực) và các mục danh mục chờ duyệt. Chạy lại không đổi gì; khác biệt được báo `DRIFT`, không ghi đè.
5. Người có thẩm quyền khác duyệt từng đề xuất ở màn hình của phần đó.

### 3.2 Kiểm chứng (UC-ORG-02) — ORG-01
Báo cáo gồm kế hoạch (tạo, khớp, chờ duyệt, khác biệt, bị chặn) và chỗ ngồi so với người giữ (`VACANT`, `FILLED`, `OVER`) cùng số quyền ngoài chỗ ngồi.

## 4. State machine

```
Lô gói: Uploaded -> Validating -> DryRunPassed | DryRunFailed ; DryRunPassed -> Applying -> Applied ; Applied -> RolledBack (bản chuẩn bị; đối tượng đã tạo không bị xóa)
Mục của gói: CREATE -> CREATED ; PENDING -> (duyệt ở khung sở hữu) ; DRIFT, BLOCKED chỉ báo
```

## 5. Quy tắc nghiệp vụ và công thức

Thuần trong `packages/kernel/src/org-pack.ts`: một gốc, cha biết, không vòng, sâu tối đa 8; một đơn vị tổng hợp; mỗi loại vai trò đúng một; người nhập không quyết định (`SOD_DECIDES`); lãnh đạo chỉ đọc; người duyệt không nhập và không chốt kỳ; mỗi đầu mối đúng một chỗ nhập và một chỗ duyệt, mỗi chỗ một người; Ban KHĐT tối thiểu hai người (rà soát, chốt, đẩy không phải của một người); quản trị tối thiểu hai người (đăng ký khác áp dụng); chuỗi duyệt qua `reportWorkflowDefect`, mỗi bước có hạn 1 đến 720 giờ làm việc, không tên người, không leo thang tới người; ủy quyền tối đa 90 ngày, xem xét thường xuyên tối đa 365 ngày; nhóm AD trong bộ lọc `MACHVON-*`, tối đa 64 ký tự, không trùng.

## 6. Dữ liệu

Không có bảng mới. Dùng `migration_batch`, `migration_row` (V1309), `organization_unit`, `role_definition`, `governance_rule`, `doa_matrix_version`, `master_record`. Năm kiểu danh mục mới trong `master-types.ts`: `REPORTING_PERIOD_KIND`, `REPORT_TYPE`, `RECEIVING_AGENCY`, `CAPITAL_SOURCE`, `REPORT_UNIT`. Bản đồ nhóm AD: `infra/keycloak/onprem/ad-group-role-map.json` mục `tenantMappings`.

## 7. API / command

`getEnterpriseOrgPack` (GET `/enterprise/org-pack`, tùy chọn `batch_id`, quyền `adm.migration.read` trên toàn tenant); `materialiseEnterpriseOrgPack` (POST `/enterprise/org-pack/materialisations`, quyền `adm.migration.approve` cùng quyền của từng loại đối tượng; mã lỗi `ORG_PACK_INVALID`, `MIGRATION_STATE_INVALID`, `SCOPE_DENIED`, `ROLE_ESCALATION_DENIED`).

## 8. UI/UX

ORG-01: hướng dẫn nạp năm bước, tải tệp, xem gói của lô, nút tạo đơn vị và vai trò, báo cáo kiểm chứng, bảng đơn vị, vai trò, chỗ ngồi kèm nhóm AD, các bước duyệt, ủy quyền, danh mục. Bảy trạng thái qua `StateBoundary`; chỉ đọc ở chế độ READ_ONLY.

## 9. Sự kiện, job, tích hợp, quan sát

Sự kiện `ent.org_pack.materialised.v1` (mã lô, băm, số); kiểm toán `ent.org_pack.materialised` kèm danh sách mục và kết quả. Không gọi mạng.

## 10. Kiểm thử

Kernel (`org-pack.test.ts`); gói mẫu (`packages/edition-enterprise/test/org-pack.test.ts`); kiểu danh mục (`master-types-ent3d.test.ts`); API với cơ sở dữ liệu thật (`org-pack.enterprise.test.ts`: chạy thử bắt lỗi, người đăng ký không áp dụng, tạo, chạy lại không đổi, khác biệt, chỗ ngồi, đơn vị chỉ thấy đơn vị mình, KHĐT và lãnh đạo thấy tất cả); bản đồ AD (`infra-artefacts.test.mjs`); màn hình (`OrgPackScreen.test.tsx`).

## 11. Tiêu chí nghiệm thu (đo được)

AC-1: gói mẫu qua chạy thử không lỗi; gói vi phạm một quy tắc bị báo đúng dòng. AC-2: chạy lần hai không tạo gì. AC-3: người dùng một đầu mối không có `ind.entry` ở đơn vị khác. AC-4: vai trò lãnh đạo chỉ có quyền đọc.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

Tối thiểu: gói mẫu, nạp, kiểm chứng, xem. Sâu hóa: đồng bộ nhóm thư mục thành cấp quyền, nhập tên thật qua bảng ánh xạ chuyển đổi khi khách cung cấp.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

Tên chính thức hai Tổ dự án và danh sách nhân sự: chủ Tổ chuẩn hóa dữ liệu (PENDING-EXTERNAL, R18). Thời hạn từng bước là giả định mẫu cho tới khi Ban KHĐT xác nhận.
