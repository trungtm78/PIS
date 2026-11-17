# ADV — Cố vấn AI (nhóm chức năng sẽ triển khai; hiện chỉ có thực đơn và trang giới thiệu)

Đặc tả phân hệ theo yêu cầu của chủ sản phẩm ngày 18/11/2026 cho sản phẩm "Hệ thống quản lý đầu tư công": thêm nhóm thực đơn "Cố vấn AI" gồm năm mục, mỗi mục một trang giới thiệu nói rõ chức năng **sẽ triển khai** và giải thích ý tưởng bằng chữ. Mỗi trang có thêm thẻ "Màn hình dự kiến": bản phác họa màn hình của chức năng với số liệu ví dụ. Chưa có màn hình làm việc, chưa có số liệu thật, chưa có biểu mẫu gửi được. Mã nằm ở `apps/web/src/screens/adv`; thực đơn và route sinh từ `03_Engineering/navigation_architecture.json` và `screen_catalog.json` (bản vá `docs/plans/adv1.contract.json`).

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Lãnh đạo tỉnh và các đơn vị cần biết hệ thống sẽ có các chức năng cố vấn điều hành nào, để chuẩn bị nhu cầu và không nhầm với chức năng đang chạy.

**Trong phạm vi.** Nhóm thực đơn "Cố vấn AI" trên thanh bên và trong thư viện ứng dụng; năm trang giới thiệu ADV-01 đến ADV-05: cố vấn điều hành vốn bằng AI, cố vấn điều hành vốn bằng chuyên gia tài chính, cố vấn giải pháp chiến lược, cố vấn sửa đổi quy trình hiện hữu, cố vấn đào tạo chiến lược và quản lý.

**Ngoài phạm vi.** Bản thân các chức năng cố vấn (mô hình dự báo, kịch bản điều chuyển vốn, kết nối chuyên gia, dự thảo văn bản, chương trình đào tạo), gói thuê bao và thanh toán, đối tác kết nối. Các phần này là hạng mục riêng, chưa lập kế hoạch. Phụ thuộc về sau: CAP, DIS, PAY, PWF, ISS, DIR, DOC, LLM.

**Căn cứ.** Yêu cầu của chủ sản phẩm; mục tiêu giải ngân của Đề án 57 được nêu theo đúng tên gọi trong yêu cầu, không trích dẫn số liệu.

## 2. Actor, tenant và phạm vi quyền

| Actor | Tenant/scope | Hành động được phép | Hành động bị cấm |
|---|---|---|---|
| Mọi thành viên đã đăng nhập | Tenant của mình | Mở thực đơn và đọc năm trang giới thiệu | Không có thao tác ghi nào |

Trang không gọi dịch vụ và không đọc dữ liệu của tenant, nên không cần quyền riêng trong ma trận quyền và không cần migration hay seed.

## 3. Luồng nghiệp vụ

1. Người dùng mở nhóm "Cố vấn AI" trên thanh bên (hoặc trong thư viện ứng dụng).
2. Chọn một trong năm mục; hệ thống mở trang giới thiệu tương ứng (ADV-01 đến ADV-05).
3. Người dùng đọc trạng thái "Sẽ triển khai", tóm tắt và các phần giải thích. Không có bước nào thay đổi dữ liệu.

## 4. State machine

Không có trạng thái nghiệp vụ. Mỗi trang chỉ có một trạng thái hiển thị: nội dung giới thiệu kèm nhãn "Sẽ triển khai".

## 5. Quy tắc nghiệp vụ và công thức

- BR-ADV-01: mọi trang phải nói bằng chữ rằng chức năng sẽ triển khai và hiện chưa hoạt động; không được thể hiện trạng thái chỉ bằng màu.
- BR-ADV-02: không nêu tên đối tác thật, không nêu mức phí; phần chữ giới thiệu không có số liệu. Mức phí ghi "theo thỏa thuận khi triển khai".
- BR-ADV-05: bản phác họa (thẻ "Màn hình dự kiến") luôn mang dòng "Màn hình dự kiến, số liệu ví dụ"; mọi con số trong đó là ví dụ, không đọc từ dữ liệu của tenant; người và tổ chức dùng tên chung (Chuyên gia tài chính 1, Ngân hàng đối tác A); ô nhập và nút không gửi gì, chỉ đổi phần đang hiển thị.
- BR-ADV-03: ADV-01 nêu ba gói: Tiêu chuẩn (miễn phí), Chuyên sâu và Cao cấp (thuê bao hằng tháng). ADV-02 nêu phí tư vấn thu gián tiếp qua đối tác kết nối.
- BR-ADV-04: nội dung nêu rõ AI và cố vấn chỉ khuyến nghị; quyết định thuộc người có thẩm quyền; hệ thống không tự ban hành văn bản, không tự sửa số liệu.

## 6. Dữ liệu

Không có bảng mới, không sửa bảng. Nội dung trang là chuỗi trong bộ từ của ứng dụng web (`adv.*` trong `vi.json` và `en.json`).

## 7. API / command

Không có operation. Không có GET scaffold nào của phân hệ.

## 8. UI/UX

ADV-01 đến ADV-05 dùng chung một thành phần trang: tiêu đề kèm biểu tượng của mục, nhãn trạng thái "Sẽ triển khai" (StatusPill), một đoạn tóm tắt, rồi hai thẻ (Tabs): "Màn hình dự kiến" (mở trước) và "Giới thiệu" (địa chỉ `?view=intro`). Bản phác họa: ADV-01 ô hỏi và ba câu gợi ý, khuyến nghị tuần có độ tin cậy, biểu đồ ba kịch bản giải ngân, bảng dự án nên điều chuyển vốn, dải ba gói với khối bị khóa (có dấu khóa và chữ); ADV-02 danh bạ chuyên gia, lịch tuần, phiên tư vấn, các bước và ghi chú phí qua đối tác; ADV-03 dải chỉ tiêu Đề án 57 (giá trị ví dụ), ma trận phương án theo tác động và khả thi, dự thảo quyết sách với tiến trình Soạn, Lấy ý kiến, Trình, Ban hành; ADV-04 hai làn quy trình hiện hành và đề xuất với số ngày, biểu đồ điểm nghẽn, bảng đề xuất sửa đổi; ADV-05 chương trình theo đối tượng, lịch buổi học, biểu đồ năng lực trước và sau, bảng tiến độ đơn vị. Biểu đồ là SVG có tên và câu mô tả, bảng 3 đến 5 dòng cuộn trong vùng riêng. Thẻ "Giới thiệu" gồm ghi chú chức năng chưa hoạt động và các phần (SectionCard): Chức năng dự kiến, Dữ liệu sử dụng, Cách hoạt động, Gói dịch vụ và phí (ADV-01) hoặc Phí dịch vụ (ADV-02), Lợi ích cho lãnh đạo tỉnh. Biểu tượng: `spark` cho nhóm; `chip`, `expert`, `compass`, `flowEdit`, `graduation` cho năm mục, vẽ cùng kiểu với bộ biểu tượng của thanh bên. Trang không có 7 trạng thái chuẩn vì không nạp dữ liệu.

## 9. Sự kiện, job, tích hợp, quan sát

Không có sự kiện, job hay tích hợp.

## 10. Kiểm thử

| ID | Loại | Ưu tiên | Bước | Expected |
|---|---|---|---|---|
| UI-ADV-01 đến UI-ADV-05 | screen-contract | P1 | Mở từng trang từ thanh bên và bằng địa chỉ, ở 1440 px và 390 px | Có nhãn "Sẽ triển khai" bằng chữ, mỗi phần có tiêu đề và ít nhất một dòng, thẻ đầu là bản phác họa có dòng "Màn hình dự kiến, số liệu ví dụ", không gửi dữ liệu, không có tên đối tác thật hay mức phí |

Kiểm thử thành phần ở `apps/web/src/screens/adv/AdvisoryScreen.test.tsx`; kiểm thử thực đơn ở `apps/web/src/navigation/model.test.ts` và `apps/web/src/shell`.

## 11. Tiêu chí nghiệm thu (đo được)

- AC-ADV-01 (UI-ADV-01): thanh bên và thư viện ứng dụng có nhóm "Cố vấn AI" với biểu tượng riêng, bên dưới là năm mục, mỗi mục một biểu tượng, dẫn tới ADV-01 đến ADV-05.
- AC-ADV-02 (UI-ADV-02): mỗi trang có nhãn "Sẽ triển khai", tóm tắt và đủ các phần; ADV-01 có ba gói, không có mức phí; ADV-02 nêu phí qua đối tác.
- AC-ADV-03 (UI-ADV-03): một tiêu đề trang, mỗi phần một tiêu đề, không tràn ngang ở 390 px.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

Hiện tại (R3): thực đơn và năm trang giới thiệu. Về sau: từng chức năng cố vấn là một epic riêng, cần người duyệt các hạng mục tiền (gói thuê bao, phí qua đối tác), quyền, quyết định AI và mẫu văn bản dự thảo.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

- Mức phí, kỳ thanh toán và đối tác kết nối chuyên gia: chủ sản phẩm quyết định khi triển khai.
- Nội dung chính thức của Đề án 57 (mục tiêu, chỉ tiêu) cần chủ nghiệp vụ cung cấp trước khi xây chức năng cố vấn chiến lược.
- Nhóm này có hiển thị trong bản doanh nghiệp hay không: chủ sản phẩm quyết định (nội dung hiện viết cho điều hành đầu tư công cấp tỉnh).
