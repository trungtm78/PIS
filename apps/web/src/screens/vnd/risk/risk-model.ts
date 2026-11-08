import type { components } from '@machvon/contracts';
import type { Tone } from '../../../ui';

/** VND-11 and VND-12: the risk grade and the performance of a contractor. The shapes are the contract's; nothing here is invented. */
type S = components['schemas'];
export type RiskGrade = S['VendorRiskGrade'];
export type RiskAssessment = S['VendorRiskAssessment'];
export type RiskFactor = S['VendorRiskFactor'];
export type RiskLive = S['VendorRiskLive'];
export type RiskRegisterPage = S['VendorRiskRegisterPage'];
export type RiskRegisterItem = S['VendorRiskRegisterItem'];
export type ControlFigure = S['VendorGammaFigure'];
export type RiskTier = RiskAssessment['tier'];
export type RiskState = RiskAssessment['state'];
export type PerformanceView = S['VendorPerformance'];
export type PerformanceLine = S['VendorPerformanceLine'];
export type PerformancePage = S['VendorPerformancePublicationPage'];
export type PublicationClock = NonNullable<PerformanceLine['publication_clock']>;
export type ResponseReview = PerformanceLine['response_review'];
export type PublicationKind = S['VendorPerformancePost']['kind'];
export type Suggestion = PerformanceView['suggestion'];

export const RISK_PERMISSION = { read: 'vnd.read', assess: 'vnd.risk.assess', decide: 'vnd.risk.decide', publish: 'vnd.performance.publish' } as const;

export const RISK_TIERS: readonly RiskTier[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const PUBLICATION_KINDS: readonly PublicationKind[] = ['INITIAL', 'UPDATE_AFTER_WARRANTY', 'UPDATE_AFTER_RESPONSE'];
export const PUBLICATION_STATES = ['ALL', 'DUE', 'OVERDUE', 'POSTED'] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export const tierTone = (tier: RiskTier | null): Tone => (tier === 'LOW' ? 'success' : tier === 'MEDIUM' ? 'info' : tier === 'HIGH' ? 'warning' : tier === 'CRITICAL' ? 'danger' : 'neutral');
export const tierIcon = (tier: RiskTier | null): string => (tier === 'LOW' ? '●' : tier === 'MEDIUM' ? '◐' : tier === 'HIGH' ? '▲' : tier === 'CRITICAL' ? '■' : '○');

export const publicationTone = (clock: PublicationClock | null): Tone =>
  clock === 'MET' ? 'success' : clock === 'MET_LATE' ? 'warning' : clock === 'OVERDUE' ? 'danger' : clock === 'DUE_SOON' ? 'warning' : clock === 'ON_TIME' ? 'info' : 'neutral';
export const responseTone = (review: ResponseReview): Tone => (review === 'OVERDUE' ? 'danger' : review === 'DUE_SOON' ? 'warning' : review === 'WITHIN_REVIEW' ? 'info' : review === 'CLOSED' ? 'success' : 'neutral');

/** The width of the bar of a factor: its points over the most it can add, in whole percent (a factor that can add nothing has no bar). */
export const factorWidth = (factor: Pick<RiskFactor, 'points' | 'max'>): number => (factor.max <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((factor.points * 100) / factor.max))));

/** The reading of a factor as short text: the names and values it came from, in the order of the contract, nothing computed. */
export function readingText(reading: Readonly<Record<string, unknown>>): string {
  return Object.entries(reading)
    .map(([name, value]) => `${name}: ${value === null || value === undefined ? '–' : String(value)}`)
    .join(', ');
}

/** The factors that added points, the largest first, as the explanation shows them; ties keep the order of the contract. */
export const mainFactors = (factors: readonly RiskFactor[]): RiskFactor[] => factors.filter((one) => one.points > 0).sort((a, b) => b.points - a.points);
