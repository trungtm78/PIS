/**
 * The built-in default params that lane C (analytics, G0-4 and G3-2) adds under the rule types `KPI_DEFINITION` and `RAG_THRESHOLDS` of `governance-rules.ts`. Plain data with no imports, so that the rules module can
 * spread them into its defaults without a cycle. Every number here is a starting value of the research (roadmap, "chưa kiểm chứng") to be confirmed with the customer and the auditors; a tenant approves its own
 * version of a code and that version wins (maker is not checker).
 */

export interface AnalyticsDefault {
  params: Record<string, unknown>;
  unverified: boolean;
}

const KPI_OWNER = 'CAPITAL_PLANNER';
const KPI_SOURCE = 'Phân hệ giải ngân (DIS), ảnh chụp số liệu đã chốt';

const kpi = (params: Record<string, unknown>, unverified = true): AnalyticsDefault => ({ params, unverified });

/** The figures of the command center HOME-01/HOME-03, one definition each. `formula` is the sentence a reader sees; the numerator, the denominator and the exclusions say what is in it. */
export const KPI_HOME_DEFAULTS: Readonly<Record<string, AnalyticsDefault>> = {
  DISBURSEMENT_RATE_PM: kpi({
    name: 'Tỷ lệ giải ngân so với kế hoạch Thủ tướng giao',
    formula: 'Số Kho bạc đã chi lũy kế trong năm chia cho kế hoạch vốn Thủ tướng Chính phủ giao, nhân 100',
    numerator: 'Số Kho bạc Nhà nước đã chi lũy kế đến ngày chốt số của Kho bạc',
    denominator: 'Kế hoạch vốn năm do Thủ tướng Chính phủ giao đã phân bổ cho dự án',
    exclusions: ['Vốn chuyển tiếp từ năm trước được tính ở chỉ tiêu riêng', 'Dự án chưa có số của Kho bạc không đưa vào tử số và được báo riêng'],
    source: KPI_SOURCE,
    unit: 'PERCENT',
    period: 'YEAR_TO_DATE',
    owner: KPI_OWNER,
    decimals: 2,
    refresh_hours: 24,
    allowed_lag_days: 8,
    rag_code: 'DISBURSEMENT_RATIO',
  }),
  DISBURSEMENT_RATE_TOTAL: kpi({
    name: 'Tỷ lệ giải ngân so với toàn bộ kế hoạch vốn năm',
    formula: 'Số Kho bạc đã chi lũy kế trong năm chia cho tổng kế hoạch Thủ tướng giao và phần tỉnh bổ sung, nhân 100',
    numerator: 'Số Kho bạc Nhà nước đã chi lũy kế đến ngày chốt số của Kho bạc',
    denominator: 'Kế hoạch vốn Thủ tướng giao cộng phần địa phương bổ sung, đã phân bổ cho dự án',
    exclusions: ['Vốn chuyển tiếp từ năm trước được tính ở chỉ tiêu riêng', 'Dự án chưa có số của Kho bạc không đưa vào tử số và được báo riêng'],
    source: KPI_SOURCE,
    unit: 'PERCENT',
    period: 'YEAR_TO_DATE',
    owner: KPI_OWNER,
    decimals: 2,
    refresh_hours: 24,
    allowed_lag_days: 8,
    rag_code: 'DISBURSEMENT_RATIO',
  }),
  DISBURSED_TREASURY: kpi({
    name: 'Số Kho bạc đã chi lũy kế',
    formula: 'Tổng số tiền Kho bạc Nhà nước đã chi cho các dự án trong phạm vi, tính đến ngày chốt số của Kho bạc',
    numerator: 'Tổng giao dịch chi của Kho bạc đã đối soát, trừ các giao dịch đã hoàn',
    exclusions: ['Số do chủ đầu tư tự báo chưa có xác nhận của Kho bạc'],
    source: KPI_SOURCE,
    unit: 'VND',
    period: 'YEAR_TO_DATE',
    owner: KPI_OWNER,
    decimals: 0,
    refresh_hours: 24,
    allowed_lag_days: 8,
  }),
  PLAN_PM_ASSIGNED: kpi({
    name: 'Kế hoạch vốn Thủ tướng giao đã phân bổ',
    formula: 'Tổng kế hoạch vốn năm do Thủ tướng Chính phủ giao đã phân bổ chi tiết cho dự án trong phạm vi',
    denominator: 'Kế hoạch vốn năm do Thủ tướng giao',
    exclusions: ['Vốn chưa phân bổ chi tiết cho dự án'],
    source: KPI_SOURCE,
    unit: 'VND',
    period: 'YEAR_TO_DATE',
    owner: KPI_OWNER,
    decimals: 0,
    refresh_hours: 24,
    allowed_lag_days: 8,
  }),
  PLAN_TOTAL: kpi({
    name: 'Tổng kế hoạch vốn năm',
    formula: 'Kế hoạch Thủ tướng giao cộng phần địa phương bổ sung, đã phân bổ cho dự án trong phạm vi',
    denominator: 'Kế hoạch Thủ tướng giao cộng phần địa phương bổ sung',
    exclusions: ['Vốn chưa phân bổ chi tiết cho dự án'],
    source: KPI_SOURCE,
    unit: 'VND',
    period: 'YEAR_TO_DATE',
    owner: KPI_OWNER,
    decimals: 0,
    refresh_hours: 24,
    allowed_lag_days: 8,
  }),
  OPEN_WARNINGS: kpi({
    name: 'Cảnh báo sớm đang mở',
    formula: 'Số cảnh báo sớm còn yêu cầu ai đó xử lý (mới, đã nhận, đang yêu cầu giải trình) trong phạm vi của người xem',
    numerator: 'Cảnh báo ở trạng thái mở, đã nhận hoặc đang yêu cầu giải trình',
    exclusions: ['Cảnh báo đã đóng hoặc đã kết luận'],
    source: 'Phân hệ cảnh báo sớm (DIS), đếm tại thời điểm xem',
    unit: 'COUNT',
    period: 'AS_OF_NOW',
    owner: 'WARNING_OWNER',
    decimals: 0,
    refresh_hours: 1,
    allowed_lag_days: 0,
  }),
  OVERDUE_EXPLANATIONS: kpi({
    name: 'Giải trình quá hạn',
    formula: 'Số yêu cầu giải trình đã quá hạn mà chưa có kết luận trong phạm vi của người xem',
    numerator: 'Yêu cầu giải trình quá hạn hoặc đã đến hạn mà chưa kết luận',
    exclusions: ['Giải trình đã được kết luận'],
    source: 'Phân hệ giải trình (DIS), đếm tại thời điểm xem',
    unit: 'COUNT',
    period: 'AS_OF_NOW',
    owner: 'WARNING_OWNER',
    decimals: 0,
    refresh_hours: 1,
    allowed_lag_days: 0,
  }),
  PENDING_REALLOCATIONS: kpi({
    name: 'Đề xuất điều chuyển vốn đang chờ',
    formula: 'Số đề xuất điều chuyển vốn đã trình hoặc đã duyệt mà chưa áp dụng trong phạm vi của người xem',
    numerator: 'Đề xuất điều chuyển ở trạng thái đã trình hoặc đã duyệt chờ áp dụng',
    exclusions: ['Đề xuất đã áp dụng hoặc bị từ chối'],
    source: 'Phân hệ điều chuyển vốn (CAP), đếm tại thời điểm xem',
    unit: 'COUNT',
    period: 'AS_OF_NOW',
    owner: KPI_OWNER,
    decimals: 0,
    refresh_hours: 1,
    allowed_lag_days: 0,
  }),
};

/**
 * The factors of the early-warning score of a unit (G3-2) and its bands, as `RAG_THRESHOLDS` codes. A factor is read against its own line (`green`, `amber`, the better side by `direction`) and carries a `weight`;
 * the score runs 0 (nothing wrong) to 100 (everything wrong), so `EWS_SCORE` reads LOWER_IS_BETTER. `min_coverage_pct` of a factor is not used; that of `EWS_SCORE` is the share of the weight that must have data
 * before a band is given at all (below it the unit is "chưa đủ dữ liệu", never green).
 */
export const EWS_RATE_CODE = 'EWS_RATE_VS_PACE';
export const EWS_CRITICAL_CODE = 'EWS_CRITICAL_WARNINGS';
export const EWS_OVERDUE_CODE = 'EWS_OVERDUE_EXPLANATIONS';
export const EWS_NO_DATA_CODE = 'EWS_NO_DATA_SHARE';
export const EWS_SCORE_CODE = 'EWS_SCORE';
export const EWS_FACTOR_CODES = [EWS_RATE_CODE, EWS_CRITICAL_CODE, EWS_OVERDUE_CODE, EWS_NO_DATA_CODE] as const;

export const RAG_EWS_DEFAULTS: Readonly<Record<string, AnalyticsDefault>> = {
  // Disbursement rate over the pace of the year (day of the year / days of the year): 0,95 and 0,85 of the pace are the starting lines of the research.
  [EWS_RATE_CODE]: { params: { direction: 'HIGHER_IS_BETTER', green: 0.95, amber: 0.85, min_coverage_pct: 0, weight: 40 }, unverified: true },
  // Open warnings of the severity "Nghiêm trọng" in the unit: none is green, one or two is amber.
  [EWS_CRITICAL_CODE]: { params: { direction: 'LOWER_IS_BETTER', green: 0, amber: 2, min_coverage_pct: 0, weight: 30 }, unverified: true },
  [EWS_OVERDUE_CODE]: { params: { direction: 'LOWER_IS_BETTER', green: 0, amber: 2, min_coverage_pct: 0, weight: 20 }, unverified: true },
  // The share of the projects of the unit that have no Treasury figure, in percent.
  [EWS_NO_DATA_CODE]: { params: { direction: 'LOWER_IS_BETTER', green: 10, amber: 30, min_coverage_pct: 0, weight: 10 }, unverified: true },
  [EWS_SCORE_CODE]: { params: { direction: 'LOWER_IS_BETTER', green: 25, amber: 45, min_coverage_pct: 60 }, unverified: true },
};
