import { hasMessage } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { camel } from '../shared/vnd-model';
import type { EntryProblem } from './investigation-model';

type T = Translator['t'];

// The names of the closed lists of the contract: one key is `head.<code in camel case>.tail`, so one line covers a list and a test walks the list to prove that every code has its words in both languages.
export const leadKindLabel = (t: T, code: string): string => t(`vnd3.leadKind.${camel(code)}.name`);
export const leadStatusLabel = (t: T, code: string): string => t(`vnd3.leadStatus.${camel(code)}.name`);
export const linkKindLabel = (t: T, code: string): string => t(`vnd3.linkKind.${camel(code)}.name`);
export const sourceLabel = (t: T, code: string): string => t(`vnd3.source.${camel(code)}.name`);
export const hitStatusLabel = (t: T, code: string): string => t(`vnd3.hitStatus.${camel(code)}.name`);
export const hitBasisLabel = (t: T, code: string): string => (hasMessage(`vnd3.basis.${camel(code)}.name`) ? t(`vnd3.basis.${camel(code)}.name`) : code);
export const hitClockLabel = (t: T, code: string): string => t(`vnd3.hitClock.${camel(code)}.name`);
export const disputeKindLabel = (t: T, code: string): string => t(`vnd3.disputeKind.${camel(code)}.name`);
export const disputeOutcomeLabel = (t: T, code: string): string => t(`vnd3.disputeOutcome.${camel(code)}.name`);
export const entryProblemLabel = (t: T, code: EntryProblem): string => t(`vnd3.import.problem.${camel(code)}.text`);

/** What a lead or a hit did: the words of the catalogue when it has them (the server may add a move later), else the code as the server wrote it. */
export const leadMoveLabel = (t: T, code: string): string => (hasMessage(`vnd3.leadMove.${camel(code)}.name`) ? t(`vnd3.leadMove.${camel(code)}.name`) : code);
export const hitMoveLabel = (t: T, code: string): string => (hasMessage(`vnd3.hitMove.${camel(code)}.name`) ? t(`vnd3.hitMove.${camel(code)}.name`) : code);

/** The name of a number an evidence carries (a gap in basis points, a count of files); a number this screen has no words for keeps its name as the server wrote it. */
export const evidenceKeyLabel = (t: T, key: string): string => (hasMessage(`vnd3.evidence.${camel(key)}.name`) ? t(`vnd3.evidence.${camel(key)}.name`) : key);

/** One value of an evidence in words: a list is joined, a number keeps its digits, text is as it came. */
export function evidenceValueText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => evidenceValueText(item)).join(', ');
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return String(value);
  return '–';
}
