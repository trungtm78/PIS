import type { Translator } from '../../../i18n';
import { camel } from './common';

type T = Translator['t'];

// Each label is one dynamic key whose head and tail are written in the call, so that the i18n check marks the whole family as used.
export const kindLabel = (t: T, kind: string): string => t(`ctrClaim.kind.${camel(kind)}.label`);
export const statusLabel = (t: T, status: string): string => t(`ctrClaim.status.${camel(status)}.label`);
export const sideLabel = (t: T, side: string): string => t(`ctrClaim.side.${camel(side)}.label`);
export const stepLabel = (t: T, step: string): string => t(`ctrClaim.step.${camel(step)}.label`);
export const decisionLabel = (t: T, decision: string): string => t(`ctrClaim.decision.${camel(decision)}.label`);
export const basisLabel = (t: T, basis: string): string => t(`ctrClaim.basis.${camel(basis)}.label`);
export const effectLabel = (t: T, effect: string): string => t(`ctrClaim.effect.${camel(effect)}.label`);
export const effectHint = (t: T, effect: string): string => t(`ctrClaim.effect.${camel(effect)}.hint`);
export const deadlineLabel = (t: T, code: string): string => t(`ctrClaim.deadline.${camel(code)}.label`);
export const owedByLabel = (t: T, who: string): string => t(`ctrClaim.owedBy.${camel(who)}.label`);
export const termStatusLabel = (t: T, status: string): string => t(`ctrClaim.termStatus.${camel(status)}.label`);
export const particularsFromLabel = (t: T, from: string): string => t(`ctrClaim.particularsFrom.${camel(from)}.label`);
