import type { Translator } from '../../../i18n';
import type { PublicationClock, PublicationKind, PublicationState, ResponseReview, RiskState, RiskTier, Suggestion } from './risk-model';

type T = Translator['t'];

export const tierLabel = (t: T, tier: RiskTier): string => t(`vnd.risk.tier.${tier}.name`);
export const riskStateLabel = (t: T, state: RiskState): string => t(`vnd.risk.state.${state}.name`);
export const factorLabel = (t: T, factor: string): string => t(`vnd.risk.factor.${factor}.name`);
export const factorFormula = (t: T, factor: string): string => t(`vnd.risk.factor.${factor}.formula`);
export const publicationClockLabel = (t: T, clock: PublicationClock): string => t(`vnd.performance.clock.${clock}.name`);
export const responseReviewLabel = (t: T, review: ResponseReview): string => t(`vnd.performance.review.${review}.name`);
export const publicationKindLabel = (t: T, kind: PublicationKind): string => t(`vnd.performance.kind.${kind}.name`);
export const publicationStateLabel = (t: T, state: PublicationState): string => t(`vnd.performance.state.${state}.name`);
export const ratingLabel = (t: T, rating: string): string => t(`vnd.performance.rating.${rating}.name`);
export const suggestionLabel = (t: T, suggestion: Suggestion): string => t(`vnd.performance.suggestion.${suggestion}.name`);
