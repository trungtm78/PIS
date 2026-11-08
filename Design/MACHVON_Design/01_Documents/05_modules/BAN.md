# BAN — Bảng điều hành Ban chỉ đạo (committee workspace)
Baseline 1.5 | Kế hoạch BAN-1 (khối migration 2520–2539), yêu cầu của chủ sở hữu ngày 08/11/2026: Trưởng Ban chỉ đạo đầu tư công của tỉnh (Ban 57, cán bộ Công an tỉnh, đơn vị PA05) điều hành tiến độ đầu tư công toàn tỉnh. Màn hình BAN-01…BAN-07. Quyết định chi tiết, cổng `ProvinceFactsReader` và bảng dữ liệu xem `docs/committee-workspace.md`.

## 1. Mục đích, phạm vi, ranh giới
Trưởng Ban chỉ đạo cần một nơi duy nhất, truy vết được, trả lời: toàn tỉnh giải ngân đang ở đâu so với kế hoạch, cùng kỳ năm trước và đường kỳ vọng của năm; ngành, địa bàn, chủ đầu tư, nguồn vốn nào chậm; dự án nào cần Trưởng ban quan tâm; đơn vị nào không báo cáo; chỉ đạo nào quá hạn. Số liệu lấy từ lõi dữ liệu thật qua cổng `ProvinceFactsReader`; không có nhãn hay chế độ mô phỏng nào trên màn hình, tệp hay thẻ. Công thức, nguồn và thời điểm của mọi con số nằm sau nút "i" (đó là quản trị, không phải con dấu).
- **Trong phạm vi:** bảng điều hành toàn tỉnh (BAN-01); danh sách dự án cần quan tâm và quyết định của Ban (BAN-02); hồ sơ họp qua bộ sinh báo cáo (BAN-03); theo dõi chỉ đạo quá hạn và leo thang theo đơn vị (BAN-04); cảnh báo của Ban (BAN-05); danh sách Ban và vị trí (BAN-06); nhật ký xem màn hình nhạy cảm (BAN-07); thẻ trên PWA và điện thoại.
- **Ngoài phạm vi:** tính số liệu giải ngân (DIS), nguồn cấp số liệu của Sở Tài chính (FEED-1 ghi vào cùng lõi), giao ban và chỉ đạo (DIR, dùng lại lệnh của DIR), SSO và MFA (giai đoạn hạ tầng; đã để chỗ cắm trong nhật ký).

## 2. Actor, tenant và phạm vi quyền
| Actor | Vai trò hệ thống | Được phép | Bị cấm |
|---|---|---|---|
| Trưởng ban | COMMITTEE_HEAD (cấp trên toàn tenant) | Đọc toàn bộ; quyết định trên danh sách quan tâm; xác nhận cảnh báo; ra chỉ đạo, đóng chỉ đạo, duyệt gia hạn (DIR); duyệt hồ sơ họp | Mọi quyền ghi dữ liệu tài chính; đọc nhật ký xem |
| Thành viên | COMMITTEE_MEMBER | Đọc; kiểm hồ sơ họp | Quyết định, cảnh báo, ghi |
| Thư ký | COMMITTEE_SECRETARIAT | Đọc; quản lý danh sách Ban; đánh giá cảnh báo; ghi quyết định; ra chỉ đạo và biên bản (DIR); lập và phát hành hồ sơ họp | Duyệt hồ sơ họp mình lập; ghi dữ liệu tài chính |
| Quản trị bảo mật, kiểm toán viên | SECURITY_ADMIN, AUDITOR | Đọc nhật ký xem (`committee.audit.read`) | Đọc số liệu điều hành nếu không có vai trò Ban |
Phạm vi đọc là toàn bộ tenant (mọi chủ đầu tư và ngành); không bao giờ qua tenant (RLS). Quyền gắn ở phạm vi từng đơn vị không đủ: `403 SCOPE_DENIED`. Phân loại dữ liệu: bảng điều hành CONFIDENTIAL, danh sách Ban và nhật ký PERSONAL.

## 3. Luồng nghiệp vụ
1. Trưởng ban mở BAN-01: số toàn tỉnh và theo ngành, địa bàn, chủ đầu tư, nguồn vốn; nhật ký ghi lượt xem trong cùng giao dịch.
2. Từ BAN-02 Trưởng ban xem lý do và số tiền đang bị đe dọa, đánh dấu đã xem, hoãn có lý do đến một ngày, hoặc ra chỉ đạo từ dòng dự án (lệnh của DIR) rồi ghi quyết định "đã ra chỉ đạo".
3. Thư ký đánh giá lại cảnh báo; Trưởng ban xác nhận có ghi chú; điều kiện hết đúng thì cảnh báo tự đóng.
4. Trước cuộc họp thư ký lập hồ sơ họp (BAN-03), thành viên kiểm, Trưởng ban duyệt, thư ký phát hành bản Excel và Word.
5. Thư ký giữ danh sách Ban (BAN-06); an ninh và kiểm toán xem nhật ký (BAN-07).

## 4. State machine
Vị trí trong Ban: ACTIVE → ENDED (có lý do, không xóa, không mở lại). Cảnh báo: OPEN → ACKNOWLEDGED → RESOLVED, hoặc OPEN → RESOLVED; RESOLVED là cuối cùng. Quyết định trên danh sách quan tâm: nhật ký chỉ thêm (đã xem, hoãn, đã ra chỉ đạo, đưa lại); trạng thái hiện tại là dòng mới nhất.

## 5. Quy tắc nghiệp vụ và công thức
- **BR-BAN-01** Số liệu đến từ cổng `ProvinceFactsReader`; cái chưa biết là null, không bao giờ là 0; số cùng kỳ năm trước chỉ có khi mọi dòng vốn đều có, nếu thiếu thì nêu độ phủ.
- **BR-BAN-02** Đường giải ngân kỳ vọng nội suy tuyến tính trong tháng từ quy tắc COMMITTEE_POLICY (chưa kiểm chứng, nêu nguồn và ngày). Màu xếp theo chênh lệch giữa tỷ lệ và đường kỳ vọng (điểm phần trăm).
- **BR-BAN-03** Dải dự báo cuối năm là thấp nhất đến cao nhất của các cách ước tính dùng được (nhịp năm đến nay, số đã làm chia tỷ lệ kỳ vọng, số đã làm nhân tỷ lệ cả năm trước trên cùng kỳ), mỗi cách không vượt kế hoạch; chỉ một cách thì nói rõ là mỏng.
- **BR-BAN-04** Dự án cần quan tâm khi có một trong năm lý do (chậm tiến độ, vướng thủ tục, nguy cơ vượt dự toán, giải ngân thấp xa kế hoạch, đơn vị không báo cáo); điểm tác động = 100 × (Σ trọng số × mức độ ÷ Σ trọng số) × (0,5 + 0,5 × min(1, số tiền đang bị đe dọa ÷ mức tham chiếu)); mức độ 0,5 tại ngưỡng, 1 tại gấp đôi.
- **BR-BAN-05** Bốn cảnh báo: toàn tỉnh chậm hơn đường kỳ vọng quá ngưỡng; ngành chậm hơn tỉnh quá ngưỡng (bỏ ngành có kế hoạch quá nhỏ); đơn vị không báo cáo; chỉ đạo quá hạn của đơn vị. Mỗi loại có ALERT_TYPE với chủ sở hữu, việc cần làm, hậu quả và thời hạn phản hồi.
- **BR-BAN-06** Mỗi lượt xem màn hình nhạy cảm ghi một dòng nhật ký trong cùng giao dịch (người xem, vai trò trong Ban, màn hình, bộ lọc, ngày và nguồn số liệu, mức xác thực), không chứa số liệu; nhật ký chỉ thêm. Không có lượt xem nặc danh.
- **BR-BAN-07** Một Trưởng ban đang hiệu lực mỗi Ban; không tự bổ nhiệm; vị trí kết thúc phải có lý do.
- **BR-BAN-08** Vai trò Ban không có quyền ghi dữ liệu tài chính (kiểm bằng test).

## 6. Dữ liệu
Bảng: `committee`, `committee_member`, `committee_view_audit`, `committee_attention_decision`, `committee_alert` (V2520 đến V2522; vai trò hệ thống cho tenant cũ ở V2523). Tất cả có RLS bắt buộc, chỉ mục dẫn đầu bằng `tenant_id`; nhật ký xem và quyết định chỉ thêm; vị trí và cảnh báo có trigger giữ các cột bất biến. Không có bảng sổ cái.

## 7. API / command
Đọc: `getCommitteeWorkspace`, `listCommitteeAttention`, `getCommitteeDirectiveTracker`, `getCommitteeMeetingPack`, `listCommitteeAlerts`, `getCommitteeRoster`, `listCommitteeViewAudit`. Lệnh (Idempotency-Key, kiểm toán, sự kiện): `registerCommittee`, `appointCommitteeMember`, `endCommitteeMember` (If-Match), `recordAttentionDecision`, `evaluateCommitteeAlerts`, `acknowledgeCommitteeAlert` (If-Match). Mã lỗi: `COMMITTEE_STATE_INVALID`, `COMMITTEE_ROLE_TAKEN`. Hồ sơ họp dùng biểu mẫu `BAN-MEETING-PACK` của bộ sinh báo cáo (RPT).

## 8. UI/UX
BAN-01: hàng thẻ số có nút "i", bảng theo ngành, địa bàn, chủ đầu tư, nguồn vốn với dải dự báo, khối "Thay đổi từ tuần trước", cảnh báo, dự án cần quan tâm. BAN-02: bảng xếp hạng với lý do bằng chữ và biểu tượng, hộp quyết định và nút ra chỉ đạo. BAN-03: nội dung hồ sơ, lập hồ sơ, các bản. BAN-04: bảng đơn vị và danh sách chỉ đạo quá hạn. BAN-05: danh sách cảnh báo. BAN-06: danh sách vị trí. BAN-07: nhật ký có phân trang. Bảy trạng thái chuẩn, không chỉ dựa vào màu, phone và PWA có thẻ cùng số liệu.

## 9. Sự kiện, job, tích hợp, quan sát
Sự kiện: `committee.registered.v1`, `committee.member_appointed.v1`, `committee.member_ended.v1`, `committee.attention_decided.v1`, `committee.alert_raised.v1`, `committee.alert_resolved.v1`, `committee.alert_acknowledged.v1`. Tích hợp: cổng `ProvinceFactsReader` (FEED-1 ghi vào lõi), DIR (chỉ đạo), RPT (hồ sơ họp). Chỗ cắm để lại: trung tâm cảnh báo của HOME chưa đọc `committee_alert`; mức xác thực của phiên (SSO, MFA) cấp qua token `COMMITTEE_ASSURANCE`.

## 10. Kiểm thử
Kernel: quy tắc thuần (đường kỳ vọng, dải dự báo, xếp hạng, cảnh báo). API qua làn db: `apps/api/test/committee/committee.test.ts` (đọc toàn tỉnh từ bảng thật, nhật ký xem, danh sách quan tâm và quyết định, theo dõi chỉ đạo, bốn cảnh báo, danh sách Ban, nhật ký, hồ sơ họp, cách ly tenant); ma trận từ chối quyền, cách ly tenant, `system-roles.test.ts`. UAT-BAN-001…006, UI-BAN-01…07.

## 11. Tiêu chí nghiệm thu (đo được)
AC-ST-BAN-001-1…7 trong `implementation_plan.json`: đọc toàn tỉnh và từ chối, nhật ký xem chỉ thêm, danh sách quan tâm và quyết định, bốn cảnh báo, danh sách Ban, hồ sơ họp ba người, bảy trạng thái giao diện.

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+
R2: toàn bộ phạm vi trên. Sau đó: MFA bắt buộc theo `mfa_required` khi hạ tầng có SSO; trung tâm cảnh báo của HOME đọc cảnh báo của Ban; nguồn cấp số liệu của Sở Tài chính mở rộng độ phủ.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba
Ngưỡng và đường kỳ vọng là giá trị khởi điểm chưa kiểm chứng với Ban chỉ đạo và Sở Tài chính; số liệu đúng đến đâu phụ thuộc vào bản chụp giải ngân đã chốt và nguồn cấp của Sở Tài chính; vai trò Công an tỉnh cần quy chế truy cập được Ban phê duyệt.
