import { REPORT_FORM_MODE_RULE_TYPE, demoFormsOn } from '@machvon/kernel/src/report-layout.ts';
import { registerRuleDefaults, registerRuleType, resolveGovernanceRule } from '@machvon/kernel/src/governance-rules.ts';
import type { DefaultInput, FieldSpec, GovernanceRuleVersion, LegalStatus } from '@machvon/kernel/src/governance-rules.ts';

/**
 * The governance rules that belong to the enterprise edition's report forms (RPT-1, owner decision of 2026-11-08: for the demo stage the six forms are designed by the system itself):
 *   - the enterprise indicator pack: the KPI definitions the six forms are bound to, added as built-in defaults of `KPI_DEFINITION` (formula, numerator, denominator, source, as-of; every one flagged "chưa kiểm chứng"
 *     because the FND-1 semantics spec, docs/fnd-funding-model.md, is still a proposal and the customer has not confirmed the figures);
 *   - the rule type `REPORT_FORM_MODE`: whether demo forms may be issued (`demo_forms`); the environment variable `DEMO_FORMS` overrides it (`demoFormsOn` of the kernel reads both).
 * The registration is called from the edition manifest when the package loads, once (a second call is a no-op), so the public edition never carries these codes.
 */

export const ENTERPRISE_KPI_SOURCE = 'Phân hệ giải ngân (DIS) theo mô hình vốn doanh nghiệp FND-1 (docs/fnd-funding-model.md, bản đề xuất chưa duyệt); số liệu mẫu biểu báo cáo sáu biểu mẫu demo (RPT-1)';
export const ENTERPRISE_KPI_AS_OF = '2026-11-08';

type KpiUnit = 'PERCENT' | 'VND' | 'COUNT';
type KpiPeriod = 'YEAR_TO_DATE' | 'AS_OF_NOW' | 'MONTH';

interface KpiSeed {
  code: string;
  name: string;
  formula: string;
  numerator?: string;
  denominator?: string;
  unit: KpiUnit;
  period: KpiPeriod;
  decimals: number;
}

const money = (code: string, name: string, formula: string, period: KpiPeriod): KpiSeed => ({ code, name, formula, unit: 'VND', period, decimals: 0 });
const percent = (code: string, name: string, formula: string, numerator: string, denominator: string, period: KpiPeriod): KpiSeed => ({ code, name, formula, numerator, denominator, unit: 'PERCENT', period, decimals: 1 });
const count = (code: string, name: string, formula: string): KpiSeed => ({ code, name, formula, unit: 'COUNT', period: 'AS_OF_NOW', decimals: 0 });

/** The indicators of the six report forms, in the order the forms print them. Money is whole dong, percent has one place, counts are whole. */
export const ENTERPRISE_KPI_SEEDS: readonly KpiSeed[] = Object.freeze([
  money('ENT_TOTAL_INVESTMENT', 'Tổng mức đầu tư đang hiệu lực', 'Tổng của tổng mức đầu tư đã được phê duyệt đang hiệu lực của các dự án trong phạm vi báo cáo, tính đến ngày chốt', 'AS_OF_NOW'),
  money('ENT_PLAN_YEAR', 'Kế hoạch vốn năm giao đầu năm', 'Tổng kế hoạch vốn năm theo quyết định giao lần đầu của các dự án trong phạm vi báo cáo (FND-1: PLAN_YEAR)', 'YEAR_TO_DATE'),
  money('ENT_PLAN_IN_FORCE', 'Kế hoạch vốn năm hiện hành', 'Tổng kế hoạch vốn năm đang hiệu lực sau các lần điều chỉnh, tính đến ngày chốt (FND-1: PLAN_IN_FORCE)', 'YEAR_TO_DATE'),
  money('ENT_EXECUTED_PERIOD', 'Giá trị thực hiện trong kỳ', 'Tổng giá trị khối lượng thực hiện được ghi nhận trong kỳ báo cáo (FND-1: ACTUAL của đại lượng EXECUTED)', 'MONTH'),
  money('ENT_DISBURSED_PERIOD', 'Giá trị giải ngân trong kỳ', 'Tổng số đã thanh toán, giải ngân trong kỳ báo cáo (FND-1: ACTUAL của đại lượng DISBURSED)', 'MONTH'),
  money('ENT_ESTIMATE_PERIOD', 'Ước thực hiện của kỳ', 'Tổng số ước thực hiện của cả kỳ đã đưa vào báo cáo của kỳ (FND-1: ESTIMATE_AS_REPORTED)', 'MONTH'),
  money('ENT_EXECUTED_YTD', 'Giá trị thực hiện lũy kế từ đầu năm', 'Tổng giá trị thực hiện các tháng của năm kế hoạch đến hết kỳ báo cáo (FND-1: CUMULATIVE_YTD, đại lượng EXECUTED)', 'YEAR_TO_DATE'),
  money('ENT_DISBURSED_YTD', 'Giá trị giải ngân lũy kế từ đầu năm', 'Tổng số giải ngân các tháng của năm kế hoạch đến hết kỳ báo cáo (FND-1: CUMULATIVE_YTD, đại lượng DISBURSED)', 'YEAR_TO_DATE'),
  money('ENT_EXECUTED_SINCE_START', 'Giá trị thực hiện lũy kế từ khởi công', 'Số dư đầu kỳ đưa vào hệ thống cộng giá trị thực hiện các tháng đến hết kỳ báo cáo (FND-1: CUMULATIVE_SINCE_START, đại lượng EXECUTED)', 'AS_OF_NOW'),
  money('ENT_DISBURSED_SINCE_START', 'Giá trị giải ngân lũy kế từ khởi công', 'Số dư đầu kỳ đưa vào hệ thống cộng số giải ngân các tháng đến hết kỳ báo cáo (FND-1: CUMULATIVE_SINCE_START, đại lượng DISBURSED)', 'AS_OF_NOW'),
  money('ENT_OUTLOOK_YEAR', 'Ước thực hiện cả năm', 'Số thực hiện các tháng đã chốt cộng số ước (hoặc kế hoạch tháng nếu chưa có ước) của các tháng còn lại; không có số cho một tháng thì không tính (FND-1: ESTIMATE_YEAR)', 'YEAR_TO_DATE'),
  money('ENT_CAPITAL_EQUITY', 'Kế hoạch vốn năm: vốn chủ sở hữu', 'Phần kế hoạch vốn năm hiện hành do vốn chủ sở hữu bố trí (FND-1: nhóm EQUITY của FUNDING_TAXONOMY)', 'YEAR_TO_DATE'),
  money('ENT_CAPITAL_DEBT', 'Kế hoạch vốn năm: vốn vay', 'Phần kế hoạch vốn năm hiện hành do vốn vay bố trí (FND-1: nhóm DEBT của FUNDING_TAXONOMY)', 'YEAR_TO_DATE'),
  money('ENT_CAPITAL_OTHER', 'Kế hoạch vốn năm: vốn khác', 'Phần kế hoạch vốn năm hiện hành do các nguồn khác bố trí (FND-1: nhóm OTHER của FUNDING_TAXONOMY)', 'YEAR_TO_DATE'),
  percent(
    'ENT_RATE_EXECUTED_YTD',
    'Tỷ lệ thực hiện lũy kế so kế hoạch năm',
    'Giá trị thực hiện lũy kế từ đầu năm chia cho kế hoạch vốn năm hiện hành, nhân 100 (FND-1: RATE_YEAR_IN_FORCE, đại lượng EXECUTED)',
    'Giá trị thực hiện lũy kế từ đầu năm đến hết kỳ báo cáo',
    'Kế hoạch vốn năm hiện hành',
    'YEAR_TO_DATE',
  ),
  percent(
    'ENT_RATE_DISBURSED_YTD',
    'Tỷ lệ giải ngân lũy kế so kế hoạch năm',
    'Giá trị giải ngân lũy kế từ đầu năm chia cho kế hoạch vốn năm hiện hành, nhân 100 (FND-1: RATE_YEAR_IN_FORCE, đại lượng DISBURSED)',
    'Giá trị giải ngân lũy kế từ đầu năm đến hết kỳ báo cáo',
    'Kế hoạch vốn năm hiện hành',
    'YEAR_TO_DATE',
  ),
  percent(
    'ENT_RATE_SINCE_START',
    'Tỷ lệ thực hiện lũy kế từ khởi công so tổng mức đầu tư',
    'Giá trị thực hiện lũy kế từ khởi công chia cho tổng mức đầu tư đang hiệu lực, nhân 100 (FND-1: RATE_SINCE_START)',
    'Giá trị thực hiện lũy kế từ khởi công',
    'Tổng mức đầu tư đang hiệu lực',
    'AS_OF_NOW',
  ),
  percent(
    'ENT_RATE_OUTLOOK_YEAR',
    'Tỷ lệ ước thực hiện cả năm so kế hoạch',
    'Ước thực hiện cả năm chia cho kế hoạch vốn năm hiện hành, nhân 100 (FND-1: RATE_OUTLOOK_YEAR)',
    'Ước thực hiện cả năm',
    'Kế hoạch vốn năm hiện hành',
    'YEAR_TO_DATE',
  ),
  percent('ENT_SHARE_EQUITY', 'Cơ cấu vốn: tỷ trọng vốn chủ sở hữu', 'Vốn chủ sở hữu chia cho tổng ba nhóm vốn của kế hoạch năm hiện hành, nhân 100 (FND-1: STRUCTURE_SHARE)', 'Kế hoạch vốn năm từ vốn chủ sở hữu', 'Tổng kế hoạch vốn năm của ba nhóm vốn', 'YEAR_TO_DATE'),
  percent('ENT_SHARE_DEBT', 'Cơ cấu vốn: tỷ trọng vốn vay', 'Vốn vay chia cho tổng ba nhóm vốn của kế hoạch năm hiện hành, nhân 100 (FND-1: STRUCTURE_SHARE)', 'Kế hoạch vốn năm từ vốn vay', 'Tổng kế hoạch vốn năm của ba nhóm vốn', 'YEAR_TO_DATE'),
  percent('ENT_SHARE_OTHER', 'Cơ cấu vốn: tỷ trọng vốn khác', 'Vốn khác chia cho tổng ba nhóm vốn của kế hoạch năm hiện hành, nhân 100 (FND-1: STRUCTURE_SHARE)', 'Kế hoạch vốn năm từ các nguồn khác', 'Tổng kế hoạch vốn năm của ba nhóm vốn', 'YEAR_TO_DATE'),
  count('ENT_PROJECTS_TOTAL', 'Số dự án và hạng mục trong báo cáo', 'Số dự án đầu tư xây dựng, mua sắm và sửa chữa lớn có kế hoạch vốn trong năm, tính đến ngày chốt'),
  count('ENT_PROJECTS_ON_TRACK', 'Số dự án đúng hoặc vượt tiến độ', 'Số dự án có đánh giá tiến độ là đúng tiến độ hoặc vượt tiến độ tại ngày chốt'),
  count('ENT_PROJECTS_DELAYED', 'Số dự án chậm tiến độ', 'Số dự án có đánh giá tiến độ là chậm tiến độ tại ngày chốt'),
]);

/** The codes of the pack. */
export const ENTERPRISE_KPI_CODES: readonly string[] = Object.freeze(ENTERPRISE_KPI_SEEDS.map((seed) => seed.code));

const UNVERIFIED: LegalStatus = 'UNVERIFIED';

const defaultOf = (seed: KpiSeed): DefaultInput => ({
  params: {
    name: seed.name,
    formula: seed.formula,
    ...(seed.numerator === undefined ? {} : { numerator: seed.numerator }),
    ...(seed.denominator === undefined ? {} : { denominator: seed.denominator }),
    source: 'Phân hệ giải ngân (DIS), mô hình vốn doanh nghiệp FND-1 (bản đề xuất chưa duyệt)',
    unit: seed.unit,
    period: seed.period,
    owner: 'CAPITAL_PLANNER',
    decimals: seed.decimals,
    refresh_hours: 24,
    allowed_lag_days: 8,
  },
  formula: seed.formula,
  source: ENTERPRISE_KPI_SOURCE,
  asOf: ENTERPRISE_KPI_AS_OF,
  legalStatus: UNVERIFIED,
});

const REPORT_FORM_MODE_SCHEMA: Readonly<Record<string, FieldSpec>> = { demo_forms: { kind: 'boolean' } };

let registered = false;

/**
 * Registers the enterprise indicator pack under `KPI_DEFINITION` and the rule type `REPORT_FORM_MODE`. Idempotent: the package manifest calls it when it loads and a test may call it again. Needs the kernel's own
 * rules to be there first, which importing `governance-rules` guarantees.
 */
export function registerEnterpriseReportRules(): void {
  if (registered) return;
  registered = true;
  registerRuleDefaults('KPI_DEFINITION', Object.fromEntries(ENTERPRISE_KPI_SEEDS.map((seed) => [seed.code, defaultOf(seed)])));
  registerRuleType({
    type: REPORT_FORM_MODE_RULE_TYPE,
    ownerModule: 'RPT',
    modules: ['RPT', 'ENT'],
    formula: 'demo_forms là true thì được phát hành các biểu mẫu demo do hệ thống thiết kế (mỗi bản ra đều đóng dấu MẪU DEMO); là false thì chỉ phát hành mẫu chính thức đã xác nhận; biến môi trường DEMO_FORMS ghi đè giá trị này',
    source: 'Quyết định của chủ sở hữu ngày 2026-11-08: giai đoạn demo, hệ thống tự thiết kế sáu biểu mẫu báo cáo trong lúc chờ mẫu chính thức (RPT-1)',
    asOf: ENTERPRISE_KPI_AS_OF,
    legalStatus: 'VERIFIED',
    schema: REPORT_FORM_MODE_SCHEMA,
    defaults: {
      DEFAULT: { params: { demo_forms: false }, formula: 'Mặc định tắt: chỉ biểu mẫu chính thức đã xác nhận được phát hành; bật bằng quy tắc đã duyệt của đơn vị hoặc biến môi trường DEMO_FORMS=true' },
    },
  });
}

/**
 * Whether demo forms may be issued for a tenant on `asOf`: the approved `REPORT_FORM_MODE` rule of the tenant (or the built-in default, off), overridden by the environment variable `DEMO_FORMS`. The caller passes the
 * rules it read through `GovernancePolicyPort` and `process.env`; nothing here reads a global.
 */
export function demoFormsEnabled(rules: readonly GovernanceRuleVersion[], asOf: string, env: Readonly<Record<string, string | undefined>> = {}): boolean {
  registerEnterpriseReportRules();
  const resolved = resolveGovernanceRule(rules, REPORT_FORM_MODE_RULE_TYPE, 'DEFAULT', asOf);
  return demoFormsOn({ env, ruleParams: resolved?.params });
}
