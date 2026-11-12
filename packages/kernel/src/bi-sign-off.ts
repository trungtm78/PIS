import { DomainError } from './errors.ts';

/**
 * The block of three signatures of a management report that a person made themself (BC.02): who prepared it, who checked it and who approved it, each with the day. The forms of the report engine carry the block
 * as signatures; a dashboard and the exports of a certified metric carry it from the facts of their publication: the author of the version prepared it, a person other than the author and the requester checked the
 * request, a third person decided it. A step nobody took is empty and is printed as such; a name is never made up, and a publication that skipped the check is approved but not complete.
 */

export interface SignOffEntry {
  /** The membership of the person. */
  id: string;
  /** The name of the person in the directory of the tenant, or null when the directory has none. */
  name: string | null;
  /** The instant of the step (ISO 8601, UTC). */
  at: string;
}

export const SIGN_OFF_STATES = ['UNSIGNED', 'PREPARED', 'CHECKED', 'APPROVED'] as const;
export type SignOffState = (typeof SIGN_OFF_STATES)[number];

export interface SignOffBlock {
  versionId: string | null;
  revision: number | null;
  prepared: SignOffEntry | null;
  checked: SignOffEntry | null;
  approved: SignOffEntry | null;
  /** The furthest step taken: APPROVED when it was approved (with or without a check), else CHECKED, PREPARED or UNSIGNED. */
  state: SignOffState;
  /** All three signed. */
  complete: boolean;
}

export function signOffOf(input: Pick<SignOffBlock, 'versionId' | 'revision' | 'prepared' | 'checked' | 'approved'>): SignOffBlock {
  const state: SignOffState = input.approved !== null ? 'APPROVED' : input.checked !== null ? 'CHECKED' : input.prepared !== null ? 'PREPARED' : 'UNSIGNED';
  return { ...input, state, complete: input.prepared !== null && input.checked !== null && input.approved !== null };
}

export interface SignOffLabels {
  prepared: string;
  checked: string;
  approved: string;
  /** What a step nobody took is printed as. */
  none: string;
}

export interface SignOffLine {
  key: 'prepared' | 'checked' | 'approved';
  label: string;
  value: string;
}

const dayOf = (instant: string): string => instant.slice(0, 10);
const entryText = (entry: SignOffEntry | null, none: string): string => (entry === null ? none : `${entry.name ?? entry.id}, ${dayOf(entry.at)}`);

/** The three lines a file or a screen prints under its title: the name and the day, or the word for a step that was not taken. */
export function signOffLines(block: SignOffBlock, labels: SignOffLabels): SignOffLine[] {
  return [
    { key: 'prepared', label: labels.prepared, value: entryText(block.prepared, labels.none) },
    { key: 'checked', label: labels.checked, value: entryText(block.checked, labels.none) },
    { key: 'approved', label: labels.approved, value: entryText(block.approved, labels.none) },
  ];
}

/** The checker is not who asked for the publication and not who wrote what is published (null when the author is not known). */
export function assertCheckerIsIndependent(checker: string, subject: { requestedBy: string; preparedBy: string | null }): void {
  if (checker === subject.requestedBy || checker === subject.preparedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

/** The approver is not the one who checked. */
export function assertApproverIsNotChecker(approver: string, checkedBy: string | null): void {
  if (checkedBy !== null && approver === checkedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}
