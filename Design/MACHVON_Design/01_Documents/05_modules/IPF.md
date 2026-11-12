# IPF — Hồ sơ đầu tư của dự án (chỉ bản doanh nghiệp)

Đặc tả phân hệ của lane AUD5 (HSKT MD.01, MD.02 và CN.01: loại dự án, cờ khởi công mới hoặc chuyển tiếp, mốc vòng đời so với danh mục, hồ sơ pháp lý theo loại, nguồn kế hoạch vốn). Mã nằm ở `packages/edition-enterprise/src/integration/investment-profile.ts` và `investment-profile-store.ts`, `apps/api/src/editions/enterprise/investment-profile.controller.ts`, `apps/web/src/editions/enterprise/screens/ipf`; bản công khai từ chối mã phân hệ `IPF` (`ENTERPRISE_ONLY_MODULES`). Kế hoạch và lý do: `docs/plans/aud2.md`, `docs/plans/aud5.md`.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Người lập kế hoạch cần đọc hồ sơ đầu tư của một dự án ở một chỗ: dự án thuộc loại nào, trong năm kế hoạch là khởi công mới hay chuyển tiếp, các mốc đầu tư đã đạt đến đâu so với danh mục của doanh nghiệp, có mốc nào đạt sai thứ tự hoặc mốc bắt buộc bị bỏ qua, có những hồ sơ pháp lý nào theo từng loại của danh mục, và vốn của kế hoạch năm đến từ Nghị quyết của PVN hay Quyết định của Tổng công ty, kèm văn bản căn cứ.

**Trong phạm vi.** Màn IPF-01 (chỉ đọc) trên mô hình đọc `getProjectInvestmentProfile`; kiểm loại văn bản pháp lý theo danh mục `ENT_LEGAL_DOC_TYPE` khi gắn vào hồ sơ của dự án (`createProjectDocument`, `updateProjectDocument`) qua điểm mở rộng của bản doanh nghiệp, lưu ở bảng `project_document_legal_type`.

**Ngoài phạm vi.** Sửa mốc, kế hoạch hay văn bản (làm ở PRJ, CAP, DOC); kết nối văn thư thật (PX-07); danh mục dự án chính thức (PX-14).

**Phụ thuộc.** PRJ (dự án, mốc), CAP (dòng kế hoạch, nguồn, văn bản căn cứ), DOC (hồ sơ dự án), quản trị (danh mục loại dự án, mốc, loại văn bản).

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Người xem dự án (`project.read`) | Phạm vi của người đó | Đọc hồ sơ đầu tư | Đọc dự án ngoài phạm vi (404 như không tồn tại) |
| Người soạn hoặc duyệt kế hoạch (`capital.plan.draft`) | Như trên | Thấy thêm bản kế hoạch đang soạn | |
| Người không có quyền đọc hồ sơ dự án (`doc.repo.read`) | Như trên | Thấy hồ sơ đầu tư | Thấy hồ sơ pháp lý (danh sách rỗng) |

Một tenant, RLS theo `tenant_id`.

## 3. Luồng nghiệp vụ

1. Người dùng chọn dự án và năm kế hoạch (để trống là năm hiện tại, giờ Việt Nam).
2. Màn đọc `getProjectInvestmentProfile` và vẽ: phân loại và giai đoạn, cảnh báo về mốc, mốc so với danh mục kèm hồ sơ chứng minh, hồ sơ pháp lý theo loại, kế hoạch vốn theo nguồn.
3. Khi gắn hồ sơ vào dự án, bản doanh nghiệp kiểm loại văn bản theo danh mục và giữ cùng giao dịch.
Màn hình: IPF-01.

## 4. State machine

Không có: màn chỉ đọc. Cờ giai đoạn đọc ra, không lưu: NEW_START khi năm khởi công bằng năm kế hoạch, CONTINUING khi trước năm kế hoạch, không xác định khi không có mốc khởi công và không ghi năm bắt đầu hoặc mốc khởi công đã hủy.

## 5. Quy tắc nghiệp vụ và công thức

- BR-IPF-01: năm khởi công lấy từ ngày khởi công thực tế, nếu chưa thì ngày kế hoạch, nếu dự án chưa có mốc khởi công thì năm bắt đầu ghi trên dự án.
- BR-IPF-02: mốc của danh mục mà dự án chưa có là NOT_HELD, không bao giờ là đã xong; mốc đạt trước mốc đứng trước trong danh mục là MILESTONE_ORDER; mốc bắt buộc chưa đạt khi mốc sau đã đạt là REQUIRED_SKIPPED.
- BR-IPF-03: kế hoạch vốn năm đọc theo từng kế hoạch năm của dự án, mỗi lịch sử một bản: bản đã phát hành, và với người soạn hoặc duyệt kế hoạch thì thêm bản mới nhất còn đang soạn. Tách theo nguồn GROUP_ASSIGNED (Nghị quyết PVN), BOARD_APPROVED (Quyết định của Tổng công ty), nguồn khác; số tiền là chuỗi đồng nguyên.
- BR-IPF-04: hồ sơ pháp lý chỉ gồm hồ sơ còn dùng (không lưu trữ) người xem được đọc theo phạm vi và quyền đọc hồ sơ, nhóm theo loại theo thứ tự danh mục, mới nhất trước, tối đa 20 hồ sơ mỗi nhóm (số đếm là tổng).
- BR-IPF-05: loại văn bản pháp lý của hồ sơ phải là mã đang hiệu lực của `ENT_LEGAL_DOC_TYPE` (mã gốc hoặc mã tenant thêm qua quy tắc đã duyệt); bản công khai từ chối mọi loại nêu tên (422 `legal_doc_type`, lý do NOT_AVAILABLE).

## 6. Dữ liệu

Bảng `project_document_legal_type` (migration V2940, khối AUD5-1, RLS bắt buộc): hồ sơ, mã loại. Không có bảng sao số liệu của PRJ, CAP, DOC; hồ sơ đầu tư tính khi đọc.

## 7. API / command

| operationId | Method path | Quyền | Lỗi | Idempotency | If-Match |
|---|---|---|---|---|---|
| `getProjectInvestmentProfile` | GET /projects/{id}/investment-profile | `project.read` | 404 RESOURCE_NOT_FOUND, 422 VALIDATION_FAILED (plan_year) | không | không |
| `createProjectDocument` | POST /project-documents | `doc.repo.upload` | 422 VALIDATION_FAILED (legal_doc_type) | có | không |
| `updateProjectDocument` | POST /project-documents/{id}/description | `doc.repo.upload` | 422 VALIDATION_FAILED (legal_doc_type), 409 VERSION_CONFLICT | có | có |

## 8. UI/UX

IPF-01: chọn dự án và năm; năm sai có lời cạnh ô; chưa chọn dự án, không tìm thấy, lỗi, từ chối đều có lời riêng. Mốc chưa có hiện "Chưa có"; mốc đạt mà không có hồ sơ chứng minh nào có dòng cảnh báo. Bảy trạng thái chuẩn, bộ thành phần và token chung.

## 9. Sự kiện, job, tích hợp, quan sát

Không có job riêng. Gắn hoặc đổi loại văn bản có dòng nhật ký `doc.repo.document_legal_type_set` (bản doanh nghiệp).

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Nội dung |
|---|---|---|---|
| UAT-ENT-IPF-01 | UAT | P1 | Loại, cờ, mốc, cảnh báo, tách theo nguồn |
| UAT-ENT-IPF-02 | UAT | P1 | Năm sai, dự án không có, người không có quyền |
| UAT-ENT-IPF-03 | UAT | P1 | Bản công khai không đổi |
| UAT-ENT-IPF-04 | UAT | P1 | Bản doanh nghiệp kiểm loại theo danh mục |
| UAT-ENT-IPF-05 | UAT | P1 | Hồ sơ theo loại theo phạm vi đọc |
| UI-IPF-01 | Màn hình | P1 | Trường, 7 trạng thái |

## 11. Tiêu chí nghiệm thu (đo được)

- AC-IPF-01: dự án khởi công năm 2025 là NEW_START trong năm kế hoạch 2025 và CONTINUING trong 2026; mốc chưa có là NOT_HELD (UAT-ENT-IPF-01).
- AC-IPF-02: loại văn bản không có trong danh mục là 422 trên `legal_doc_type` ở bản doanh nghiệp, và loại nêu tên là 422 NOT_AVAILABLE ở bản công khai (UAT-ENT-IPF-03, UAT-ENT-IPF-04).
- AC-IPF-03: IPF-01 hiển thị đủ trường và bảy trạng thái (UI-IPF-01).

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

Không thuộc R1 (chỉ bản doanh nghiệp). R3: toàn bộ mục trên. Sâu hóa sau: chọn loại văn bản ngay trên màn tạo hồ sơ DOC-24 (cần một thao tác đọc danh mục cho người lập hồ sơ), kết nối văn thư thật.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

- Danh mục mốc, loại văn bản và loại dự án là giả định làm việc chờ khách xác nhận (nhãn chưa xác nhận); nghiệm thu chờ danh mục chính thức (PX-14).
- Kết nối văn thư thật chờ đặc tả (PX-07).
