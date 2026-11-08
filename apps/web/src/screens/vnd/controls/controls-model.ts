import type { components } from '@machvon/contracts';
import { camel } from '../shared/vnd-model';
import type { Translator } from '../../../i18n';

/** VND-07 and VND-08: the independence of the bidders of a package and the finance and load of a contractor. The shapes are the contract's; nothing here is invented. */
type S = components['schemas'];
type T = Translator['t'];

export type IndependenceView = S['VendorIndependence'];
export type IndependenceFinding = S['VendorIndependenceFinding'];
export type IndependenceGate = S['VendorIndependenceGate'];
export type PersonInterest = S['VendorPersonInterest'];
export type PackageControls = S['VendorPackageControls'];
export type FinanceView = S['VendorFinance'];
export type FinancialPeriod = S['VendorFinancialPeriod'];
export type FinanceResult = S['VendorFinanceResult'];
export type CapacityView = S['VendorCapacity'];

export type FindingKind = IndependenceFinding['kind'];
export type Decision = NonNullable<IndependenceFinding['decision']>;
export type InterestKind = PersonInterest['kind'];

/** The permissions of this part of the module (the server decides every one of them again). */
export const PERMISSION_A = {
  independenceRead: 'vnd.independence.read',
  interestDeclare: 'vnd.interest.declare',
  independenceRun: 'vnd.independence.run',
  independenceDecide: 'vnd.independence.decide',
  financeWrite: 'vnd.finance.write',
  financeVerify: 'vnd.finance.verify',
  packageControls: 'vnd.package.controls',
} as const;

export const DECISIONS: readonly Decision[] = ['CLEARED', 'RECUSED', 'BLOCKED'];
export const INTEREST_KINDS: readonly InterestKind[] = ['RELATIVE', 'SHAREHOLDING', 'FORMER_EMPLOYMENT', 'ADVISORY'];
export const FINDING_KINDS: readonly FindingKind[] = [
  'BIDDERS_SHARE_TAX_HEAD',
  'BIDDERS_SHARE_ADDRESS',
  'BIDDERS_SHARE_PHONE',
  'BIDDERS_SHARE_EMAIL',
  'BIDDERS_SHARE_REPRESENTATIVE',
  'BIDDERS_SHARE_OWNER',
  'BIDDERS_SHARE_BANK_ACCOUNT',
  'BIDDERS_CROSS_OWNERSHIP',
  'BIDDER_IS_OWNER_ORGANISATION',
  'BIDDER_CROSS_OWNERSHIP_WITH_OWNER',
  'BIDDER_SHARES_OWNER_WITH_OWNER',
  'PERSON_REPRESENTS_BIDDER',
  'PERSON_OWNS_BIDDER',
  'RELATIVE_REPRESENTS_BIDDER',
  'RELATIVE_OWNS_BIDDER',
  'PERSON_HOLDS_SHARES_IN_BIDDER',
  'FORMER_OFFICIAL_OF_BIDDER',
  'ADVISER_OF_BIDDER',
];
export const FINANCE_TESTS: readonly FinanceResult['test'][] = ['CURRENT_RATIO', 'DEBT_TO_ASSETS', 'INTEREST_COVER', 'AVERAGE_REVENUE'];
export const CAPACITY_SIGNALS: readonly CapacityView['signals'][number][] = ['LOAD_OVER_REVENUE', 'LATE_CONTRACTS', 'NO_REVENUE_DATA'];

export const findingKindLabel = (t: T, code: string): string => t(`vnd.controls.kind.${camel(code)}.name`);
export const strengthLabel = (t: T, code: string): string => t(`vnd.controls.strength.${camel(code)}.name`);
export const decisionLabel = (t: T, code: string): string => t(`vnd.controls.decision.${camel(code)}.name`);
export const interestKindLabel = (t: T, code: string): string => t(`vnd.controls.interestKind.${camel(code)}.name`);
export const financeTestLabel = (t: T, code: string): string => t(`vnd.finance.test.${camel(code)}.name`);
export const financeStatusLabel = (t: T, code: string): string => t(`vnd.finance.status.${camel(code)}.name`);
export const overallLabel = (t: T, code: string): string => t(`vnd.finance.overall.${camel(code)}.name`);
export const capacityStatusLabel = (t: T, code: string): string => t(`vnd.finance.capacityStatus.${camel(code)}.name`);
export const capacitySignalLabel = (t: T, code: string): string => t(`vnd.finance.signal.${camel(code)}.name`);

export const CONTROLS_PATHS = {
  package: (packageId?: string): string => (packageId === undefined ? '/vnd/vnd-07' : `/vnd/vnd-07?package=${encodeURIComponent(packageId)}`),
  finance: (contractorId?: string, packageId?: string): string => {
    if (contractorId === undefined) return '/vnd/vnd-08';
    return packageId === undefined ? `/vnd/vnd-08?contractor=${encodeURIComponent(contractorId)}` : `/vnd/vnd-08?contractor=${encodeURIComponent(contractorId)}&package=${encodeURIComponent(packageId)}`;
  },
} as const;

/** Whole dong with the grouping of the locale; a figure that is not known is a dash. */
export function moneyText(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined) return '–';
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'vi-VN', { maximumFractionDigits: 0 }).format(value);
}

/** A ratio or a percentage with at most two decimals; a figure that is not known is a dash. */
export function ratioText(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined) return '–';
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'vi-VN', { maximumFractionDigits: 2 }).format(value);
}

/** The first problem of a money field typed in a form: whole dong, not negative unless allowed, inside the safe range of a number. */
export function wholeAmount(value: unknown, allowNegative = false): number | null {
  if (typeof value !== 'string' || !/^-?\d{1,16}$/.test(value.trim())) return null;
  const number = Number(value.trim());
  if (!Number.isSafeInteger(number) || (!allowNegative && number < 0)) return null;
  return number;
}
