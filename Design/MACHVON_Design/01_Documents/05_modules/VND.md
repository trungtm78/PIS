# VND — Quản lý nhà thầu và nhà cung cấp (nền: hồ sơ, tài khoản, chứng chỉ, hồ sơ cấm, sự kiện uy tín, cổng chặn)

Phiên bản đặc tả M1 · 08/11/2026 · Làn VND-1 của đợt sâu hóa quản trị. Nguồn nghiên cứu: `research-vendor.md` mục V1, V2, V3, V8, V12 và các cảnh báo, chỉ số thuộc các mục đó. Mã: `packages/kernel/src/vendor-*.ts`, `packages/db/src/vendor-*.ts`, `apps/api/src/modules/bid/vendor*.ts` (đăng ký trong phân hệ BID), `apps/web/src/screens/vnd/`. Tài liệu kỹ thuật chi tiết: `docs/vendor-management.md`. VND-2 (độc lập, chỉ tiêu tài chính, tải trọng, bảo đảm dự thầu, nhà thầu phụ, phân hạng rủi ro, đánh giá thực hiện hợp đồng) và VND-3 (điều tra, sàng lọc liên tục, cổng nhà thầu) xây tiếp trên nền này.

## 1. Mục đích, phạm vi, ranh giới

**Vấn đề.** Sổ nhà thầu của BID chỉ có danh tính (mã số thuế đã xác minh) và hạn chế ghi tay hoặc nhập từ tệp. Thiếu: người đại diện, địa chỉ, chủ sở hữu; kiểm soát tài khoản nhận tiền (đổi tài khoản là cách gian lận thanh toán phổ biến nhất); chứng chỉ và nhân sự chủ chốt có hạn; quy trình cấm có đủ bước và hạn quyết định; liên danh bị cấm đủ mọi thành viên; sổ sự kiện uy tín dự thầu; và một cổng chặn thống nhất ở nộp hồ sơ, kết quả, kích hoạt hợp đồng, thầu phụ và thanh toán.

**Trong phạm vi:** VND-01 đến VND-06; bảng `contractor` (cột hồ sơ), `contractor_owner`, `contractor_duplicate_suggestion`, `contractor_bank_account`, `contractor_bank_change_request`, `contractor_bank_event`, `contractor_qualification`, `contractor_key_staff`, `package_qualification_requirement`, `joint_venture`, `joint_venture_member`, `restriction_case`, `restriction_case_member`, `restriction_case_event`, `contractor_reputation_event`; cột `case_id`, `lifted_at` của `contractor_restriction`; cổng `VendorGate`.
**Ngoài phạm vi:** nhà thầu phụ, bảo đảm dự thầu, chỉ tiêu tài chính, tải trọng, phân hạng rủi ro, đánh giá thực hiện hợp đồng (VND-2); đồ thị liên kết, sàng lọc danh sách ngoài, cổng nhà thầu (VND-3); tra cứu chính thức mã số thuế (adapter của BID còn PROPOSED).
**Phụ thuộc:** BID (nhà thầu, kết quả), CTR (hợp đồng), PAY (thanh toán), DOC (văn bản quyết định, thư nhà thầu), ADM (lịch làm việc, quy tắc quản trị, ADM-11), HOME (trung tâm cảnh báo), MDM (hợp nhất).

**Căn cứ.** NĐ 214/2025/NĐ-CP Điều 19 (cơ sở dữ liệu nhà thầu), 20 (uy tín dự thầu, kết quả thực hiện hợp đồng), 133 (cấm tham gia đấu thầu: thời gian cấm theo nhóm hành vi, quyết định trong 15 ngày, liên danh cấm mọi thành viên, thời hiệu 10 năm); Luật Đấu thầu 22/2023 Điều 6, 16. Đọc từ bản tóm tắt, **chưa kiểm chứng** với Công báo và các luật sửa đổi 57/2024, 90/2025. Mọi con số pháp lý là quy tắc quản trị ghi "chưa kiểm chứng" cho đến khi pháp chế của đơn vị xác nhận.

## 2. Actor, tenant và phạm vi quyền

| Actor | Phạm vi | Được phép | Bị cấm |
|---|---|---|---|
| Cán bộ đấu thầu | Cả tenant | `vnd.read`, `vnd.profile.write`, `vnd.qualification.write`, `vnd.restriction.propose` | Quyết định cấm do chính mình đề nghị (`SELF_APPROVAL_DENIED`) |
| Người đối chiếu | Cả tenant | `vnd.qualification.verify` | Đối chiếu chứng chỉ do mình nhập |
| Kế toán thanh toán | Cả tenant | `vnd.bank.request`, `vnd.bank.callback` | Duyệt hoặc gọi lại đề nghị đổi tài khoản do mình lập |
| Người duyệt tài khoản | Cả tenant | `vnd.bank.approve` (hai vai khác nhau, hai người khác nhau) | Duyệt cả hai vai |
| Người có thẩm quyền cấm | Cả tenant | `vnd.restriction.decide` (quyết định, đưa vào hiệu lực, gỡ) | Quyết định hồ sơ do mình đề nghị |
| Đại diện chủ đầu tư | Cả tenant | `vnd.reputation.write`, `vnd.reputation.post` (người đăng khác người ghi), `vnd.venture.write` | Đăng sự kiện do mình ghi |
| Dữ liệu chủ | Cả tenant | `vnd.duplicate.decide` | Hợp nhất theo tên |

Sổ nhà thầu thuộc cả tenant: mọi quyền xét theo cấp quyền trên toàn tenant, cấp quyền theo cây đơn vị bị từ chối `SCOPE_DENIED`.

## 3. Luồng nghiệp vụ

**F1 — Hồ sơ nhà thầu chủ (VND-01, VND-02).** (1) Cán bộ nhập người đại diện, địa chỉ, điện thoại, thư điện tử, số đăng ký kinh doanh (`updateVendorProfile`, If-Match); hệ thống giữ khóa băm của dạng chuẩn để so trùng. (2) Thêm chủ sở hữu hoặc chủ sở hữu hưởng lợi (`addVendorOwner`), kết thúc khi đổi (`endVendorOwner`, giữ lịch sử); hoặc nhà thầu khai không có chủ sở hữu trên ngưỡng (`declareVendorNoOwnerAboveThreshold`). (3) Hệ thống kiểm mã số thuế (dạng, chữ số kiểm: chỉ là tín hiệu) và tính độ phủ theo quy tắc `VENDOR_PROFILE`. (4) Quét trùng (`scanVendorDuplicates`): cặp đạt điểm là gợi ý; người dữ liệu chủ bỏ qua hoặc chuyển hợp nhất (`decideVendorDuplicate`). (5) Xem trước cổng chặn (`checkVendorGate`).

**F2 — Tài khoản nhận tiền (VND-04).** (1) Đề nghị đổi kèm thư của nhà thầu (`requestVendorPayeeChange`; chủ tài khoản phải khớp tên pháp lý khi quy tắc yêu cầu; nhà thầu phải đã xác minh và có số điện thoại trong hồ sơ). (2) Hai người khác người đề nghị duyệt hai vai: khớp hợp đồng và khớp tài khoản (`approveVendorPayeeChange`). (3) Một người gọi lại bằng số đã có trong hồ sơ (`recordVendorPayeeCallback`): số gọi phải là số hồ sơ hiện tại và lúc đề nghị, đã có trong hồ sơ đủ số ngày quy tắc; không xác nhận thì đề nghị bị từ chối. (4) Đủ ba bước thì tài khoản mới hiệu lực nhưng thanh toán chờ `waiting_hours`; tài khoản cũ chuyển SUPERSEDED. (5) Rút (`cancelVendorPayeeChange`), từ chối (`rejectVendorPayeeChange`), đóng tài khoản (`closeVendorPayeeAccount`); đề nghị hết hạn sau `request_valid_days`. Số tài khoản mã hóa, chỉ hiện dạng che; nhật ký đủ chuỗi.

**F3 — Chứng chỉ và nhân sự chủ chốt (VND-05).** Nhập (`addVendorQualification`, `addVendorKeyStaff`), người khác đối chiếu với bản gốc (`verifyVendorCertificate`), thu hồi (`revokeVendorCertificate`); cảnh báo hết hạn 60 và 30 ngày và ngày hết; gói thầu đặt yêu cầu (`setVendorPackageRequirements`) và cổng so nhà thầu với yêu cầu lúc kích hoạt hợp đồng và thầu phụ.

**F4 — Hồ sơ cấm (VND-03).** Đề nghị (`openVendorRestrictionCase` hoặc `openVendorRestrictionCaseFromEgpRecord` từ bản ghi hạn chế đã nhập từ mạng đấu thầu quốc gia) → thông báo cho nhà thầu → phản hồi hoặc hết cửa sổ không phản hồi (`advanceVendorRestrictionCase`) → quyết định cấm hoặc bác bỏ bởi người khác người đề nghị, trong 15 ngày kể từ khi nhận đề nghị (`decideVendorRestrictionCase`) → đưa vào hiệu lực: ghi hạn chế cho nhà thầu và mọi thành viên liên danh (`putVendorRestrictionIntoEffect`) → hết hạn hoặc gỡ khi khiếu nại thành công (`liftVendorRestrictionCase`).

**F5 — Sự kiện uy tín dự thầu và liên danh (VND-06).** Ghi sự kiện (`recordVendorReputationEvent`), hạn đăng 7 ngày làm việc tính trên lịch; người khác đăng lên mạng đấu thầu quốc gia và nhập biên nhận (`postVendorReputationEvent`) hoặc rút kèm lý do (`retractVendorReputationEvent`); đã đăng thì hệ số bảo đảm dự thầu 3 lần trong 2 năm. Lập liên danh (`createVendorJointVenture`), kết thúc (`endVendorJointVenture`).

**F6 — Cổng chặn.** `VendorGate` hỏi ở nộp hồ sơ dự thầu, kết quả, kích hoạt hợp đồng, thầu phụ (dành cho VND-2), thanh toán. Hạn chế đang hiệu lực, mã số thuế chưa xác minh luôn chặn; hồ sơ chưa đủ và chứng chỉ chưa đáp ứng chặn hoặc cảnh báo theo quy tắc `VENDOR_GATE`; thanh toán bị chặn khi không có tài khoản hiệu lực.

## 4. State machine

Hồ sơ cấm: `PROPOSED → NOTICE_SENT → RESPONSE_RECEIVED → DECIDED → EFFECTIVE → EXPIRED | LIFTED`; `PROPOSED | NOTICE_SENT | RESPONSE_RECEIVED → DISMISSED` (rút hoặc bác bỏ); `DECIDED → LIFTED`.

| Từ | Command | Đến | Ai | Guard | Audit/Event |
|---|---|---|---|---|---|
| (mới) | `openVendorRestrictionCase` | PROPOSED | `vnd.restriction.propose` | nhóm hành vi hợp lệ, trong thời hiệu, chưa có hồ sơ trùng, có lịch làm việc | `vnd.restriction_case.moved.v1` |
| PROPOSED | `advance` SEND_NOTICE | NOTICE_SENT | `vnd.restriction.propose` | hạn phản hồi sau thời điểm gửi | idem |
| NOTICE_SENT | `advance` RECORD_RESPONSE / CLOSE_NO_RESPONSE | RESPONSE_RECEIVED | idem | không phản hồi chỉ đóng sau khi hết cửa sổ (`RESTRICTION_RESPONSE_WINDOW_OPEN`) | idem |
| RESPONSE_RECEIVED | `decideVendorRestrictionCase` | DECIDED hoặc DISMISSED | `vnd.restriction.decide` | khác người đề nghị (403); thời gian cấm trong khoảng nhóm hành vi (422 `RESTRICTION_BAN_PERIOD_INVALID`); có văn bản quyết định | idem; `decided_late` |
| DECIDED | `putVendorRestrictionIntoEffect` | EFFECTIVE | `vnd.restriction.decide` | từ ngày bắt đầu (409 `RESTRICTION_NOT_YET_EFFECTIVE`); văn bản còn hiệu lực (422 `DECISION_DOCUMENT_NOT_EFFECTIVE`) | `vnd.restriction.effective.v1` mỗi hạn chế |
| EFFECTIVE | job `expireDue` | EXPIRED | hệ thống | qua ngày cuối | idem |
| DECIDED, EFFECTIVE | `liftVendorRestrictionCase` | LIFTED | `vnd.restriction.decide` | lý do 10 ký tự | idem |

Cấm: chuyển từ trạng thái không thuộc cột "Từ" (409 `RESTRICTION_CASE_STATE_INVALID`); quyết định hai lần; sửa hồ sơ đã kết thúc (CHECK và trigger).

Đề nghị đổi tài khoản: `REQUESTED → ACTIVATED | REJECTED | CANCELLED | EXPIRED`; ba bước độc lập thứ tự (khớp hợp đồng, khớp tài khoản, gọi lại), bước cuối kích hoạt. Sự kiện uy tín: `RECORDED → POSTED | RETRACTED`, cả hai cuối. Tài khoản: `ACTIVE → SUPERSEDED | CLOSED`.

## 5. Quy tắc nghiệp vụ và công thức

- **BR-VND-01** Hồ sơ đủ khi mọi trường `required_before_bid` của quy tắc `VENDOR_PROFILE` có; độ phủ = số trường có / số trường yêu cầu (làm tròn %, 100 khi không yêu cầu trường nào).
- **BR-VND-02** Mã số thuế: dạng 10 số hoặc 10 số và 3 số chi nhánh quyết định lưu; chữ số kiểm (trọng số 31 29 23 21 19 17 13 7 5 3) chỉ là tín hiệu ghi "chưa kiểm chứng".
- **BR-VND-03** Trùng: điểm = tổng trọng số tín hiệu chung (`VENDOR_DUPLICATE_SIGNALS`); gợi ý từ 60 điểm; không bao giờ hợp nhất theo tên.
- **BR-VND-04** Đổi tài khoản cần hai người duyệt hai vai khác nhau, đều khác người đề nghị, và gọi lại bằng số trong hồ sơ; tài khoản mới hiệu lực sau 72 giờ; thanh toán chặn khi không có tài khoản hiệu lực (`PAYEE_ACCOUNT_NOT_VALID`).
- **BR-VND-05** Chứng chỉ chưa đối chiếu không đáp ứng yêu cầu; ngày cuối của hiệu lực vẫn còn hiệu lực; cảnh báo 60 và 30 ngày.
- **BR-VND-06** Hạn quyết định cấm = ngày nhận đề nghị + 15 ngày (lịch làm việc đã công bố; năm không có lịch là `CALENDAR_NOT_EFFECTIVE`, không đoán); quyết định muộn được phép nhưng ghi `decided_late` và cảnh báo.
- **BR-VND-07** Thời gian cấm trong khoảng nhóm hành vi (3 nhóm: 36–60, 12–36, 6–12 tháng); nhiều nhóm: từ mức tối thiểu lớn nhất đến tổng mức tối đa, không quá 60 tháng; thời hiệu 10 năm; 3 quyết định còn hiệu lực gợi ý cấm cấp tỉnh, 5 gợi ý toàn quốc (gợi ý, không tự quyết).
- **BR-VND-08** Liên danh: một trưởng, tổng tỷ lệ góp bằng 100; hồ sơ cấm liên danh áp mọi thành viên trừ nhóm hành vi ngoại lệ (chỉ thành viên vi phạm).
- **BR-VND-09** Sự kiện uy tín: hạn đăng 7 ngày làm việc (quy tắc `EGP_POSTING_DEADLINES` mã `REPUTATION_EVENT`); đã đăng thì bảo đảm dự thầu nhân 3 trong 2 năm kể từ ngày đăng.
- **BR-VND-10** Cổng chặn: hạn chế và mã số thuế chưa xác minh không bao giờ được nới; hồ sơ và chứng chỉ theo `VENDOR_GATE` (mặc định cảnh báo vì dữ liệu cũ chưa có).

## 6. Dữ liệu

Migration khối VND-1: `V2400` hồ sơ (cột mới của `contractor`, `contractor_owner`, `contractor_duplicate_suggestion`), `V2401` tài khoản (`contractor_bank_change_request`, `contractor_bank_account`, `contractor_bank_event`), `V2402` chứng chỉ (`contractor_qualification`, `contractor_key_staff`, `package_qualification_requirement`), `V2403` liên danh, `V2404` hồ sơ cấm (`restriction_case`, `restriction_case_member`, `restriction_case_event`, cột của `contractor_restriction`), `V2405` sự kiện uy tín, `V2406` nguồn cảnh báo `VENDOR`. Mọi bảng có `tenant_id`, RLS bắt buộc, chỉ mục bắt đầu bằng `tenant_id`, `version`. Phân loại: chủ sở hữu, tài khoản, nhân sự chủ chốt, người đại diện, điện thoại = PERSONAL (số tài khoản mã hóa bằng bộ mã hóa trường, chỉ mục mù HMAC; khóa so trùng là băm của dạng chuẩn); hồ sơ cấm chưa hiệu lực = CONFIDENTIAL. Bất biến DB: tách nhiệm vụ bằng CHECK (người duyệt khác người đề nghị; người quyết định khác người đề nghị; người đăng khác người ghi; người đối chiếu khác người nhập), chủ sở hữu, tài khoản, chứng chỉ, sự kiện, hồ sơ cấm không sửa nội dung và không xóa, nhật ký chỉ ghi thêm, một tài khoản hiệu lực mỗi nhà thầu, tổng tỷ lệ liên danh bằng 100 (trigger hoãn).

## 7. API / command

12 thao tác đọc và 30 thao tác ghi dưới `/vendor/...` (tag VND trong `openapi.json`); danh sách đầy đủ và quyền trong `docs/vendor-management.md` mục 10 và trong kế hoạch (`implementation_plan.json`, ST-VND-001 đến ST-VND-005). Mọi lệnh ghi có Idempotency-Key; lệnh trên bản ghi có phiên bản dùng If-Match (409 `VERSION_CONFLICT`). Mã lỗi mới: `PAYEE_ACCOUNT_NOT_VALID`, `PAYEE_ACCOUNT_NAME_MISMATCH`, `BANK_CHANGE_STATE_INVALID`, `BANK_CHANGE_CALLBACK_INVALID`, `RESTRICTION_CASE_STATE_INVALID`, `RESTRICTION_BAN_PERIOD_INVALID`, `RESTRICTION_CASE_TIME_BARRED`, `RESTRICTION_CASE_DUPLICATE`, `RESTRICTION_RESPONSE_WINDOW_OPEN`, `RESTRICTION_NOT_YET_EFFECTIVE`, `RESTRICTION_NOT_YET_ENDED`, `JOINT_VENTURE_SHARES_INVALID`, `CONTRACTOR_PROFILE_INCOMPLETE`, `CONTRACTOR_QUALIFICATION_MISSING`. Không có endpoint ghi chung cho trạng thái, tenant, số tài khoản rõ.

## 8. UI/UX

| Màn hình | Nội dung |
|---|---|
| VND-01 Sổ nhà thầu | danh sách, độ phủ, hạn chế, hồ sơ cấm đang mở, tài khoản, chứng chỉ sắp hết hạn; chỉ số của sổ |
| VND-02 Hồ sơ nhà thầu chủ | hồ sơ, chủ sở hữu, kiểm mã số thuế, gợi ý hợp nhất, tổng hợp hạn chế và uy tín, kiểm tra cổng |
| VND-03 Hồ sơ cấm | danh sách, chi tiết từng bước, đồng hồ 15 ngày, thành viên bị ảnh hưởng, gợi ý cấp tỉnh hoặc toàn quốc, mở từ bản ghi mạng đấu thầu |
| VND-04 Tài khoản nhận tiền | tài khoản hiệu lực và thời gian chờ, đề nghị đổi và ba bước, nhật ký, chặn thanh toán |
| VND-05 Chứng chỉ và nhân sự | danh sách, đối chiếu, thu hồi, yêu cầu của gói, hạn hết |
| VND-06 Sự kiện uy tín và liên danh | sổ sự kiện với đồng hồ 7 ngày, đăng và biên nhận, hệ số bảo đảm, liên danh |

Mỗi màn hình đủ 7 trạng thái chuẩn và trạng thái riêng; mỗi con số có dấu "i" (công thức, nguồn, ngày) và cờ "chưa kiểm chứng" ở số pháp lý; thao tác ẩn khi thiếu quyền; số tài khoản chỉ hiện dạng che (nhập đầy đủ chỉ ở ô của biểu mẫu đề nghị). Điện thoại: màn hình chỉ đọc là việc của VND-3.

## 9. Sự kiện, job, tích hợp, quan sát

Sự kiện (ids và mã, không có lời của người dùng, không có số tài khoản): `vnd.profile.updated.v1`, `vnd.owner.changed.v1`, `vnd.duplicate.decided.v1`, `vnd.bank.changed.v1`, `vnd.qualification.changed.v1`, `vnd.restriction_case.moved.v1`, `vnd.restriction.effective.v1`, `vnd.reputation.changed.v1`, `vnd.joint_venture.changed.v1`. Cảnh báo `ALERT_TYPE` nguồn `VENDOR`: `VENDOR_RESTRICTED_EXPOSURE` (V-A1), `VENDOR_REPUTATION_POST` (V-A2), `VENDOR_DEBARMENT_DECISION` (V-A3), `VENDOR_PAYEE_ACCOUNT` (V-A6), `VENDOR_QUALIFICATION_EXPIRY` (V-A8), mỗi loại có chủ, hành động mong đợi, hậu quả. Chỉ số vào sổ KPI: `VENDOR_PROFILE_COVERAGE`, `VENDOR_DEBARMENT_IN_TIME`, `VENDOR_REPUTATION_POSTED_IN_TIME`, `VENDOR_ACCOUNT_CHANGES`. Điểm nối: bản ghi hạn chế từ mạng đấu thầu quốc gia mở hồ sơ cấm (`docs/egp-connector.md` mục 10); EGP-2 đọc sổ sự kiện uy tín cho nghĩa vụ `REPUTATION_EVENT`; MDM nhận sự kiện hợp nhất; CTR và PAY gọi `VendorGate`.

## 10. Kiểm thử

| ID | Loại | Nội dung |
|---|---|---|
| UAT-PLAN-151 | nghiệp vụ | hồ sơ, độ phủ, chủ sở hữu, gợi ý trùng, xem trước cổng |
| UAT-PLAN-152 | nghiệp vụ | hồ sơ cấm đủ bước, liên danh, hiệu lực và gỡ |
| UAT-PLAN-143 | nghiệp vụ | đổi tài khoản hai người duyệt, gọi lại, thời gian chờ, chặn thanh toán |
| UAT-PLAN-144 | nghiệp vụ | chứng chỉ, nhân sự, cảnh báo hết hạn, yêu cầu của gói |
| UAT-PLAN-145 | nghiệp vụ | sổ sự kiện uy tín, hạn 7 ngày làm việc, hệ số bảo đảm, liên danh |
| UI-VND-01 đến UI-VND-06 | hợp đồng màn hình | 7 trạng thái và nhãn trường của từng màn hình |

Kiểm thử tự động: `packages/kernel/test/vendor.test.ts` (quy tắc thuần), `packages/db/test/vendor-store.test.ts` (kho dữ liệu, bất biến DB, cổng), `apps/api/test/bid/vendor.test.ts` (thao tác, quyền, audit, outbox, cách ly tenant), `apps/web/src/screens/vnd/**` (màn hình). Dữ liệu synthetic.

## 11. Tiêu chí nghiệm thu

Xem `implementation_plan.json`, các câu chuyện ST-VND-001 đến ST-VND-005 (AC-ST-VND-NNN-k Given/When/Then, mỗi AC gắn test ID).

## 12. Mức tối thiểu cho R1 và phần sâu hóa R2+

R2 (làn VND-1): toàn bộ nội dung trên. Hạng mục bắt buộc có người duyệt: quyền (ma trận quyền `vnd.*`), tiền (cổng thanh toán và đổi tài khoản), migration, quy tắc pháp lý (mọi số pháp lý). R3: VND-2 và VND-3.

## 13. Rủi ro, câu hỏi mở, phụ thuộc bên thứ ba

| Mục | Chủ | Điều kiện giải quyết |
|---|---|---|
| Số pháp lý (15 ngày, thời gian cấm, thời hiệu, 7 ngày làm việc, hệ số 3 lần) chưa đối chiếu Công báo | Pháp chế đơn vị | Phê duyệt quy tắc riêng của tenant (bản có lý do) |
| Thuật toán chữ số kiểm mã số thuế chưa có nguồn chính thức | Quản trị dữ liệu | Nguồn chính thức hoặc tra cứu chính thức qua adapter của BID |
| Hạng và nơi cấp chứng chỉ theo NĐ 175/2024 có nguồn nói khác nhau | Quản lý hợp đồng | Văn bản hiện hành; danh sách loại chứng chỉ là dữ liệu mở rộng được |
| Chủ sở hữu hưởng lợi: ngưỡng 25% hoặc quyền kiểm soát theo văn bản chống rửa tiền (có nguồn nhắc NĐ 168/2025, NĐ 296/2026) | Pháp chế | Xác nhận văn bản hiện hành |
| Đăng sự kiện lên mạng đấu thầu quốc gia là thao tác tay đến khi có đặc tả | Đơn vị vận hành mạng | Đặc tả giao diện (EGP-2) |
| Mặc định cổng cảnh báo thay vì chặn với hồ sơ và chứng chỉ | Trưởng ban đấu thầu | Đơn vị hoàn tất hồ sơ rồi duyệt quy tắc `VENDOR_GATE` mức BLOCK |
