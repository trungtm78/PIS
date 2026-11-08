# EBS — Oracle EBS: nhập tệp và đối chiếu theo mã dự án (chỉ bản doanh nghiệp)

Đặc tả phân hệ của lane ENT-2 theo `_KHUNG_DAC_TA.md`. Chưa có tệp mẫu chính thức của Oracle EBS nên bố cục tệp là giả định `WORKING-ASSUMPTION-2026.1`, ghi **PENDING-EXTERNAL** (eng-review R18): chạy được trong thử nghiệm nhưng không được nghiệm thu khi chưa có tệp mẫu chính thức và Ban Tài chính kế toán xác nhận. Phân hệ chỉ tồn tại trong bản doanh nghiệp (cùng cách tách mã như HPM).

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Số giải ngân và giá trị cam kết theo mã dự án trong hệ thống phải khớp bản kê của kế toán trên Oracle EBS; mỗi chênh lệch phải có người chịu trách nhiệm, hạn xử lý và lời giải trình, không để ai tự xử lý chênh lệch của số liệu mình lập.

**Trong phạm vi.** Nhập tệp do người dùng trao (không kết nối EBS): chạy thử không ghi gì, áp dụng một lần theo băm tệp, báo lỗi từng dòng; giữ nguyên bản kê chỉ thêm (`ebs_record`); đối chiếu theo mã dự án và kỳ; hạng mục chênh lệch có chủ, hạn, bốn kiểu giải trình; giao lại; kết nối `ebs.ledger` có độ mới và cảnh báo.

**Ngoài phạm vi.** Truy cập trực tiếp Oracle EBS; sửa số liệu của phân hệ khác (chủ bản ghi sửa bằng lệnh của họ).

**Phụ thuộc.** Khung nhập tệp (`file_import`), PAY (sổ giao dịch Kho bạc), CTR (giá hợp đồng đang hiệu lực), lịch làm việc đã công bố (ADM), quy tắc quản trị, trung tâm cảnh báo.

**Căn cứ.** Kế hoạch ENT-2; eng-review R18.

## 2. Actor, tenant và phạm vi quyền

| Actor | Scope | Được phép | Bị cấm |
|---|---|---|---|
| Quản trị tích hợp | TENANT | `ebs.admin` bật/tắt kết nối kèm lý do | Giải trình chênh lệch của số liệu mình lập |
| Người nhập tệp | TENANT | `ebs.import`, `ebs.import.preview` | Giải trình chênh lệch từ tệp mình nạp |
| Người đối chiếu, chủ hạng mục | TENANT | `ebs.reconcile` chạy đối chiếu, giải trình, giao lại | Làm chủ hạng mục của số liệu mình lập |
| Người đọc | TENANT | `ebs.read` | Ghi |

## 3. Luồng nghiệp vụ

### 3.1 Nhập tệp (UC-EBS-01) — EBS-01
1. `uploadEbsFile` đưa tệp CSV hoặc XLSX qua cổng tải (xét theo byte, quét mã độc) và cho biết tệp có đủ cột của mẫu.
2. `previewEbsFile` chạy thử đúng như áp dụng, không ghi gì; mẫu lạ bị từ chối `EBS_LAYOUT_VERSION_UNKNOWN` trước khi mở tệp.
3. `importEbsFile` áp dụng một lần theo băm tệp; lần hai trả `IMPORT_FILE_ALREADY_APPLIED`; tệp không dòng nào lấy được bị từ chối cả tệp kèm dòng lỗi; kết nối tắt thì từ chối áp dụng (chạy thử vẫn được).

### 3.2 Đối chiếu (UC-EBS-02) — EBS-02
1. `reconcileEbs` so, theo từng mã dự án và kỳ của lần trích mới nhất, giải ngân lũy kế (sổ Kho bạc, hoàn trả trừ ra) và giá trị cam kết (giá hợp đồng đang hiệu lực) với bản kê EBS; mỗi chênh lệch mở một hạng mục có chủ không thuộc những người lập số liệu và hạn theo ngày làm việc.
2. `resolveEbsDifference` do chủ hạng mục giải trình: `OURS_WRONG` hoặc `EBS_WRONG` (cần bằng chứng), `TIMING` hoặc `WAIVED` (cần ngày xem lại từ ngày mai tới một năm).
3. `reassignEbsDifference` giao cho người khác không phải người lập số liệu; hạn không đổi. Mọi bước ghi ADM-11.

## 4. State machine

```
Item: OPEN -> RESOLVED (một lần, cuối); số liệu của hạng mục mở được làm mới khi lần trích mới làm số đổi
Import: IMPORTING -> APPLIED | FAILED
```

## 5. Quy tắc nghiệp vụ và công thức

Chênh lệch = số của EBS trừ số của mình, đúng từng đồng, không làm tròn trước khi so; chỉ chỉ tiêu EBS nêu mới được so; thiếu số của mình là `MISSING_OURS` (không coi là 0). Dấu vân tay hai bên giữ cho việc đọc lại không mở hạng mục mới; hạng mục đã giải trình chỉ mở lại khi số đổi hoặc ngày xem lại đến. Hạn xử lý = số ngày làm việc của quy tắc `EBS_RECONCILE_POLICY` (mặc định 5, chưa kiểm chứng) theo lịch đã công bố; thiếu lịch: `CALENDAR_NOT_EFFECTIVE`.

## 6. Dữ liệu

`ebs_record` (V2243, chỉ thêm, khóa theo mã dự án, kỳ, ngày trích); `ebs_reconciliation_item` (V2244, ràng buộc chủ không thuộc người lập, người giải trình không thuộc người lập, bằng chứng hoặc ngày xem lại theo kiểu giải trình, trigger giữ bất biến); dùng chung `ent_connection`. RLS bắt buộc và ép buộc, chỉ mục dẫn đầu bằng `tenant_id`.

## 7. API / command

`getEbsConnection`, `setEbsConnectionState`, `uploadEbsFile`, `previewEbsFile`, `importEbsFile`, `reconcileEbs`, `listEbsDifferences`, `resolveEbsDifference`, `reassignEbsDifference`. Mã lỗi: `EBS_LAYOUT_VERSION_UNKNOWN`, `EBS_CONNECTION_DISABLED`, `EBS_ITEM_STATE_INVALID`, cùng mã của khung nhập tệp.

## 8. UI/UX

EBS-01 (kết nối, chạy thử, áp dụng, các lần nhập) và EBS-02 (đối chiếu, hạng mục, giải trình): bộ thành phần chung, bảy trạng thái, công thức và nguồn trên mỗi con số, dải PENDING-EXTERNAL.

## 9. Sự kiện, job, tích hợp, quan sát

Sự kiện: `ent.connection.changed.v1`, `ebs.import.applied.v1`, `ebs.reconciliation.run.v1`, `ebs.difference.resolved.v1`, `ebs.difference.reassigned.v1`. Cảnh báo `CONNECTOR_STALE` (độ tuổi tệp theo `CONNECTOR_FRESHNESS` mã `EBS_FILE`). Không có lời gọi mạng tới Oracle EBS. Mô tả cho Integration Hub nằm ở một tệp `ebs-connection.ts`.

## 10. Kiểm thử

Quy tắc thuần (`ebs-rules.test.ts`); API với cơ sở dữ liệu thật (`ebs.enterprise.test.ts`): chạy thử không ghi, áp dụng một lần, đối chiếu, chủ không thuộc người lập, giải trình, giao lại, làm mới, cách ly tenant, không có socket ra ngoài, ràng buộc ở cơ sở dữ liệu; màn hình bằng vitest.

## 11. Tiêu chí nghiệm thu (đo được)

AC-1: chạy thử không ghi dòng nào. AC-2: tệp áp dụng một lần. AC-3: mỗi chênh lệch có chủ không thuộc người lập số liệu và hạn. AC-4: giải trình đủ bằng chứng hoặc ngày xem lại, ghi ADM-11. AC-5: không có kết nối mạng ra ngoài. Hạng mục dựng trên giả định không được nghiệm thu khi chưa có tệp mẫu chính thức.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

Tối thiểu: nhập tệp, đối chiếu giải ngân và cam kết, giải trình. Sâu hóa khi có tệp mẫu: thêm chỉ tiêu, bộ chuyển API, đối chiếu theo gói thầu và hợp đồng, tự đề xuất chủ hạng mục theo trách nhiệm dự án.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

Quyền đọc và định dạng dữ liệu Oracle EBS: chủ Ban Tài chính kế toán và Ban Chuyển đổi số và Công nghệ thông tin; chưa có thì dùng mẫu giả định và không nghiệm thu (PENDING-EXTERNAL). Giải ngân so lũy kế đến cuối kỳ là giả định về cách EBS cộng số. Con số của quy tắc chưa được khách hàng xác nhận.
