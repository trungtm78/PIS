import type { Translator } from '../../../i18n';
import { camel } from '../claims/common';

type T = Translator['t'];

// Each label is one dynamic key whose head and tail are written in the call, so that the i18n check marks the whole family as used.
export const statusLabel = (t: T, status: string): string => t(`ctrWarn.status.${camel(status)}.label`);
export const categoryLabel = (t: T, category: string): string => t(`ctrWarn.category.${camel(category)}.label`);
export const partyLabel = (t: T, party: string): string => t(`ctrWarn.party.${camel(party)}.label`);
export const likelihoodLabel = (t: T, likelihood: string): string => t(`ctrWarn.likelihood.${camel(likelihood)}.label`);
export const reviewLabel = (t: T, outcome: string): string => t(`ctrWarn.review.${camel(outcome)}.label`);
export const closeLabel = (t: T, outcome: string): string => t(`ctrWarn.close.${camel(outcome)}.label`);
export const closeHint = (t: T, outcome: string): string => t(`ctrWarn.close.${camel(outcome)}.hint`);
export const actionStatusLabel = (t: T, status: string): string => t(`ctrWarn.actionStatus.${camel(status)}.label`);
export const issueKindLabel = (t: T, kind: string): string => t(`ctrWarn.issueKind.${camel(kind)}.label`);
export const clockLabel = (t: T, code: string): string => t(`ctrWarn.clock.${camel(code)}.label`);
export const intoLabel = (t: T, into: string): string => t(`ctrWarn.into.${camel(into)}.label`);
