import type { FinScenarioInput } from './fin-analysis.ts';

/**
 * The built-in scenarios of an investment appraisal (lane FIN-1): favourable and adverse, as deltas to the inputs. They are starting values to be settled with the customer (an unverified configuration,
 * never a rule of law). The file imports nothing at run time, so that the web app can read the same values as the server without pulling in the formula module.
 */
export const FIN_DEFAULT_SCENARIOS: readonly FinScenarioInput[] = [
  { code: 'FAVOURABLE', label: 'Thuận lợi', deltas: { benefitPct: '10', capexPct: '-5', opexPct: '-5', maintenancePct: '-5', discountRatePp: '-1' } },
  { code: 'ADVERSE', label: 'Bất lợi', deltas: { benefitPct: '-15', capexPct: '15', opexPct: '10', maintenancePct: '10', discountRatePp: '2', benefitDelayPeriods: '1' } },
];
