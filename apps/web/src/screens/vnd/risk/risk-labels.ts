import type { Translator } from '../../../i18n';
import type { PublicationClock, PublicationKind, PublicationState, ResponseReview, RiskState, RiskTier, Suggestion } from './risk-model';

type T = Translator['t'];

/** A catalogue key segment is lower camel case: the stored value DUE_SOON is looked up as dueSoon. */
const part = (value: string): string => value.toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export const tierLabel = (t: T, tier: RiskTier): string => t(`vnd.risk.tier.${part(tier)}.name`);
export const riskStateLabel = (t: T, state: RiskState): string => t(`vnd.risk.state.${part(state)}.name`);
export const factorLabel = (t: T, factor: string): string => t(`vnd.risk.factor.${part(factor)}.name`);
export const factorFormula = (t: T, factor: string): string => t(`vnd.risk.factor.${part(factor)}.formula`);
export const publicationClockLabel = (t: T, clock: PublicationClock): string => t(`vnd.performance.clock.${part(clock)}.name`);
export const responseReviewLabel = (t: T, review: ResponseReview): string => t(`vnd.performance.review.${part(review)}.name`);
export const publicationKindLabel = (t: T, kind: PublicationKind): string => t(`vnd.performance.kind.${part(kind)}.name`);
export const publicationStateLabel = (t: T, state: PublicationState): string => t(`vnd.performance.state.${part(state)}.name`);
export const ratingLabel = (t: T, rating: string): string => t(`vnd.performance.rating.${part(rating)}.name`);
export const suggestionLabel = (t: T, suggestion: Suggestion): string => t(`vnd.performance.suggestion.${part(suggestion)}.name`);
