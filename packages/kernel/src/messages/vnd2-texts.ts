/**
 * The Vietnamese texts of the governance rules, alert types and indicators of lane VND-2 (the controls of contractors and suppliers; docs/vendor-controls.md): a module (not the JSON catalogue) because the pure
 * rules of the lane also run in the browser, where the catalogue cannot be read. Every legal number is a starting value of the research, flagged unverified until the legal staff of the tenant confirm it.
 */
export const VND2_TEXT = {
  source:
    'Nghiên cứu quản trị nhà thầu (08/11/2026) theo tóm tắt Điều 6, 16, 20 Luật Đấu thầu 22/2023 và Điều 19, 20 NĐ 214/2025/NĐ-CP, chưa đối chiếu Công báo; các con số vận hành là lựa chọn khởi đầu của hệ thống, đơn vị tự đặt và phê duyệt',
  independence_formula:
    'Hai bên không độc lập khi dùng chung mã số thuế gốc, tài khoản, chủ sở hữu hoặc người đại diện (mạnh), dùng chung địa chỉ, điện thoại, thư điện tử (trung bình), hoặc một bên sở hữu bên kia trên cross_ownership_investor_pct phần trăm (với chủ đầu tư) hay cross_ownership_bidders_pct phần trăm (giữa nhà thầu); cán bộ rời tổ chức dưới former_official_months tháng vẫn bị coi là liên quan; tín hiệu không phải kết luận',
  finance_formula:
    'Thanh khoản = tài sản ngắn hạn / nợ ngắn hạn (đạt khi từ min_current_ratio_x100/100); nợ trên tài sản = tổng nợ / tổng tài sản (đạt khi không quá max_debt_to_assets_pct phần trăm); khả năng trả lãi = EBIT / chi phí lãi vay (đạt khi từ min_interest_cover_x100/100); doanh thu bình quân của revenue_years năm đã xác minh phải từ revenue_multiple_x100/100 lần giá trị một năm của gói; liên danh tính theo tỷ lệ góp của từng thành viên; ít hơn min_verified_years năm đã xác minh thì không đủ dữ liệu để kết luận',
  capacity_formula:
    'Tải = giá trị còn lại của hợp đồng đang làm + giá trị gói đã trúng chưa ký nhân pending_award_weight_pct phần trăm; tín hiệu vượt khi tải / doanh thu bình quân năm lớn hơn max_load_multiple_x100/100 hoặc số hợp đồng trễ lớn hơn max_late_contracts',
  security_formula:
    'Bảo đảm dự thầu phải bằng mức gói yêu cầu nhân hệ số uy tín (3 lần trong 2 năm kể từ ngày đăng sự kiện uy tín, quy tắc VENDOR_REPUTATION), còn hiệu lực đến hết hiệu lực hồ sơ dự thầu cộng validity_margin_days ngày, và đã được người thứ hai xác nhận với tổ chức phát hành khi require_confirmation; cảnh báo trước first_warning_days và second_warning_days ngày hết hạn; tịch thu do một người đề nghị và người khác quyết định trên văn bản',
  subcontract_formula:
    'Tổng tỷ lệ thầu phụ đã chấp thuận cộng tỷ lệ đề nghị không được vượt tỷ lệ hồ sơ dự thầu đã nêu, nhà thầu chính giữ ít nhất prime_min_share_pct phần trăm giá trị hợp đồng; vượt phần đã nêu hoặc thầu phụ không nêu trong hồ sơ dự thầu thì chặn (BLOCK) hoặc chỉ chấp thuận kèm ngoại lệ có lý do (EXCEPTION); sau mỗi lần thanh toán nhà thầu chính ghi số đã trả thầu phụ trong confirm_payment_within_days ngày',
  risk_formula:
    'Điểm rủi ro = tổng điểm của các yếu tố, mỗi yếu tố tối đa bằng trọng số weight_* của nó (hồ sơ thiếu, hạn chế, sự kiện uy tín đã đăng, chứng chỉ hết hạn, cảnh báo tài khoản, đánh giá kém liên tiếp, tài chính dưới ngưỡng, tải vượt, phát hiện độc lập chưa quyết, vi phạm thầu phụ, bảo đảm bị tịch thu); hạng LOW, MEDIUM, HIGH, CRITICAL theo medium_from, high_from, critical_from; hạn chế đang hiệu lực giữ hạng không thấp hơn restriction_floor; từ hạng dual_check_from cần người thứ hai xác nhận; xem lại sau review_months_* tháng',
  performance_formula:
    'Đánh giá được công khai chậm nhất publish_within_months tháng sau ngày hợp đồng kết thúc; nhà thầu phản hồi trong thời hạn của quy tắc EGP_POSTING_DEADLINES mã CONTRACTOR_RESPONSE, chủ đầu tư xem xét phản hồi trong review_response_days ngày; từ poor_streak_remedy đánh giá kém liên tiếp cần kế hoạch khắc phục, từ poor_streak_restriction thì gợi ý hồ sơ hạn chế (không tự mở); cửa sổ hồi cứu retrospect_years năm, retrospect_years_construction năm cho xây dựng',
  alerts: {
    independence_finding: {
      action: 'Xem phát hiện về tính độc lập, quyết định bỏ qua có lý do, rút người ra khỏi tổ hoặc chặn nhà thầu; người quyết định phải khác người chạy kiểm tra.',
      consequence: 'Gói không thể trao kết quả khi còn phát hiện mạnh chưa quyết hoặc đã bị chặn; kết quả có thể bị hủy vì vi phạm quy định về độc lập.',
      why: 'Quan hệ sở hữu, đại diện hoặc người thân giữa nhà thầu, tổ chuyên gia và chủ đầu tư làm sai lệch đánh giá và vi phạm Điều 6, 16 Luật Đấu thầu.',
    },
    security_expiry: {
      action: 'Gia hạn hoặc thay bảo đảm dự thầu sắp hết hạn, hoặc ghi nhận bảo đảm đã giải tỏa; xác nhận với tổ chức phát hành nếu chưa xác nhận.',
      consequence: 'Bảo đảm hết hạn trước khi hồ sơ hết hiệu lực thì mất khả năng tịch thu và hồ sơ dự thầu có thể bị loại.',
      why: 'Bảo đảm dự thầu chỉ có giá trị khi còn hiệu lực và đã được xác nhận với tổ chức phát hành.',
    },
    subcontract_breach: {
      action: 'Xem thầu phụ vượt phần đã nêu hoặc không có trong hồ sơ dự thầu, chấp thuận ngoại lệ có lý do hoặc chấm dứt thầu phụ.',
      consequence: 'Chuyển nhượng vượt phần thầu phụ đã nêu là hành vi bị cấm (Điều 16) và làm hợp đồng rủi ro.',
      why: 'Tổng thầu phụ vượt phần hồ sơ dự thầu đã nêu hoặc thầu phụ chưa được chấp thuận đang làm việc.',
    },
    sub_payment_confirm: {
      action: 'Ghi số đã trả cho thầu phụ của kỳ thanh toán vừa xong (số tiền, ngày, mã tham chiếu) hoặc nêu lý do chưa trả.',
      consequence: 'Thầu phụ không được trả đúng hạn làm dừng công trường và rủi ro khiếu nại; hồ sơ thanh toán kỳ sau thiếu bằng chứng.',
      why: 'Mỗi kỳ thanh toán của nhà thầu chính có phần của thầu phụ đã chấp thuận phải được xác nhận đã trả.',
    },
    performance_publish: {
      action: 'Công khai kết quả đánh giá thực hiện hợp đồng trên hệ thống quốc gia và ghi biên nhận trước hạn 6 tháng.',
      consequence: 'Công khai muộn là vi phạm Điều 20 NĐ 214/2025 và bảng điểm không được dùng khi lựa chọn nhà thầu.',
      why: 'Đánh giá đã chốt nhưng chưa có biên nhận công khai và hạn 6 tháng sau khi hợp đồng kết thúc đang đến.',
    },
    performance_response: {
      action: 'Xem phản hồi của nhà thầu về đánh giá, cập nhật đánh giá nếu phản hồi đúng hoặc giữ nguyên có lý do.',
      consequence: 'Phản hồi đúng mà không cập nhật làm dữ liệu công khai sai; chủ đầu tư chịu trách nhiệm về tính trung thực.',
      why: 'Nhà thầu đã phản hồi đánh giá và thời hạn chủ đầu tư xem xét đang chạy hoặc đã quá.',
    },
    poor_streak: {
      action: 'Lập kế hoạch khắc phục với nhà thầu có đánh giá kém liên tiếp; từ lần thứ ba xem xét đề nghị hồ sơ hạn chế.',
      consequence: 'Nhà thầu tiếp tục nhận gói mới với rủi ro tiến độ và chất lượng tăng.',
      why: 'Hai hoặc nhiều bản đánh giá kém liên tiếp của cùng một nhà thầu.',
    },
    capacity_finance: {
      action: 'Xem tải hoặc chỉ tiêu tài chính của nhà thầu trong gói đang xét, ghi nhận nhận định của tổ chuyên gia.',
      consequence: 'Nhà thầu quá tải hoặc yếu tài chính có nguy cơ trễ tiến độ hoặc bỏ dở hợp đồng.',
      why: 'Tải đồng thời vượt bội số doanh thu hoặc chỉ tiêu tài chính dưới ngưỡng của quy tắc.',
    },
    risk_review: {
      action: 'Xác nhận hạng rủi ro đang chờ người thứ hai hoặc xem lại hạng đã quá hạn xem lại.',
      consequence: 'Hạng cũ làm sai độ sâu thẩm định; hạng cao chưa xác nhận không có hiệu lực.',
      why: 'Hạng rủi ro cần xác nhận kép hoặc đã quá ngày xem lại theo quy tắc.',
    },
  },
  kpi: {
    source: 'Nghiên cứu quản trị nhà thầu (08/11/2026), mục 6 các chỉ số cho lãnh đạo; tính từ sổ của làn VND-2, chưa kiểm chứng với khách hàng',
    independence_checked: { name: 'Gói đã kiểm tra tính độc lập', formula: 'Số gói có ít nhất một hồ sơ dự thầu đã chạy kiểm tra độc lập chia số gói có hồ sơ dự thầu nhân 100', numerator: 'Gói đã chạy kiểm tra độc lập', denominator: 'Gói có hồ sơ dự thầu' },
    risk_review_in_time: { name: 'Hạng rủi ro xem lại đúng hạn', formula: 'Số nhà thầu có hạng đã xác nhận và chưa quá ngày xem lại chia số nhà thầu có hạng đã xác nhận nhân 100', numerator: 'Hạng chưa quá hạn xem lại', denominator: 'Nhà thầu có hạng đã xác nhận' },
    high_risk_contractors: { name: 'Nhà thầu hạng cao', formula: 'Số nhà thầu có hạng đã xác nhận là HIGH hoặc CRITICAL', numerator: 'Nhà thầu hạng HIGH hoặc CRITICAL', denominator: 'Không có mẫu số (số đếm)' },
    performance_published_in_time: { name: 'Đánh giá công khai đúng hạn 6 tháng', formula: 'Số đánh giá công khai trong hạn chia tổng số đã công khai và số quá hạn chưa công khai nhân 100', numerator: 'Đánh giá công khai trong hạn', denominator: 'Đã công khai cộng quá hạn chưa công khai' },
    response_reviewed_in_time: { name: 'Phản hồi của nhà thầu xử lý đúng hạn', formula: 'Số phản hồi đã xử lý trong hạn xem xét chia số phản hồi đã xử lý và số quá hạn chưa xử lý nhân 100', numerator: 'Phản hồi xử lý trong hạn', denominator: 'Đã xử lý cộng quá hạn chưa xử lý' },
    security_confirmed: { name: 'Bảo đảm dự thầu đã xác nhận', formula: 'Số bảo đảm đã xác nhận với tổ chức phát hành chia số bảo đảm đã nhận (không tính bị từ chối) nhân 100', numerator: 'Bảo đảm đã xác nhận', denominator: 'Bảo đảm đã nhận không bị từ chối' },
    sub_payment_confirmed: { name: 'Thanh toán thầu phụ đã xác nhận đúng hạn', formula: 'Số bản ghi đã trả thầu phụ trong hạn chia số bản ghi đã ghi và số quá hạn chưa ghi nhân 100', numerator: 'Đã ghi trong hạn', denominator: 'Đã ghi cộng quá hạn chưa ghi' },
  },
} as const;
