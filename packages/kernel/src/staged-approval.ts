import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { DomainError } from './errors.ts';
import { issueKeyOf } from './report-issue.ts';
import { REPORT_ACCEPT_BUSINESS_TYPE, REPORT_WORKFLOW_RESOURCE, REPORT_WORKFLOW_RULE_CODE } from './dis-report-workflow.ts';

/**
 * The staged approval of ENT-3c (QT.01): the steps unit approver, planning review, period close and push, run by the ADM engine for three owners (the weekly disbursement report of DIS, a batch of funding figures of
 * FND, a batch of indicator entries of IND). The steps of each owner are data in the governance rules registry under the rule type `APPROVAL_WORKFLOW_DEFINITION`; this module is the pure part: which owner has which
 * business type and rule, the package its PUSH step hands to the receiver, and the moves of a hold (the PUSH step waits for the receipt, R22).
 */

export const FND_FIGURE_BUSINESS_TYPE = 'fnd.figures.accept';
export const FND_FIGURE_RULE_CODE = 'FND_FIGURE_ACCEPT';
export const FND_FIGURE_RESOURCE = 'plan_figure_batch';
export const IND_ENTRY_BUSINESS_TYPE = 'ind.entry.accept';
export const IND_ENTRY_RULE_CODE = 'IND_ENTRY_ACCEPT';
export const IND_ENTRY_RESOURCE = 'ind_entry_batch';

export const STAGED_OWNERS = ['REPORT', 'FND_FIGURE', 'IND_ENTRY'] as const;
export type StagedOwner = (typeof STAGED_OWNERS)[number];

export interface StagedApprovalSpec {
  owner: StagedOwner;
  /** The business type of the ADM engine (BUSINESS_TYPES). */
  businessType: string;
  /** The code of the rule `APPROVAL_WORKFLOW_DEFINITION` that holds the steps. */
  ruleCode: string;
  /** What the engine calls the record of an instance. */
  resourceType: string;
  /** The layout the PUSH step delivers under (the project is appended: one series per record, R8). */
  pushLayout: string;
}

/** The three owners of a staged approval; the engine and the boot guard (R14) are driven from this list and from `BUSINESS_TYPES`. */
export const STAGED_APPROVALS: readonly StagedApprovalSpec[] = [
  { owner: 'REPORT', businessType: REPORT_ACCEPT_BUSINESS_TYPE, ruleCode: REPORT_WORKFLOW_RULE_CODE, resourceType: REPORT_WORKFLOW_RESOURCE, pushLayout: 'DIS_WEEKLY' },
  { owner: 'FND_FIGURE', businessType: FND_FIGURE_BUSINESS_TYPE, ruleCode: FND_FIGURE_RULE_CODE, resourceType: FND_FIGURE_RESOURCE, pushLayout: 'FND_FIGURES' },
  { owner: 'IND_ENTRY', businessType: IND_ENTRY_BUSINESS_TYPE, ruleCode: IND_ENTRY_RULE_CODE, resourceType: IND_ENTRY_RESOURCE, pushLayout: 'IND_ENTRIES' },
];

export const stagedApprovalOf = (owner: StagedOwner): StagedApprovalSpec => STAGED_APPROVALS.find((spec) => spec.owner === owner) as StagedApprovalSpec;
export const stagedApprovalOfBusinessType = (businessType: string): StagedApprovalSpec | undefined => STAGED_APPROVALS.find((spec) => spec.businessType === businessType);

// ---- the package the PUSH step hands over ---------------------------------------------------------------------------------------------------

/** The series of one record under a layout: `DIS_WEEKLY-DA-0001`. A code that had to be changed to fit a layout code gets six hex digits of its hash, so two codes never share a series. */
export function pushLayoutCodeOf(base: string, subjectCode: string): string {
  const cleaned = subjectCode.toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const exact = cleaned === subjectCode.toUpperCase() && cleaned !== '';
  const tail = exact ? cleaned : `${cleaned.slice(0, 40)}-${sha256Hex(subjectCode).slice(0, 6).toUpperCase()}`.replace(/^-/, '');
  return `${base}-${tail}`.slice(0, 60);
}

export interface PushPackage {
  layoutCode: string;
  period: string;
  revision: number;
  fileName: string;
  /** The delivery document: canonical JSON of the record as it was approved, so the same record always has the same hash. */
  text: string;
  sha256: string;
}

/** The package of a record: its facts (ids, codes and figures, never a name), canonical so the hash is stable. */
export function pushPackageOf(input: { layoutCode: string; period: string; revision: number; owner: StagedOwner; facts: Readonly<Record<string, unknown>>; adjustments?: ReadonlyArray<Readonly<Record<string, unknown>>> }): PushPackage {
  const text = canonicalJson({ owner: input.owner, layout: input.layoutCode, period: input.period, revision: input.revision, facts: input.facts, adjustments: input.adjustments ?? [] });
  return { layoutCode: input.layoutCode, period: input.period, revision: input.revision, fileName: `${input.layoutCode}-${input.period}-r${input.revision}.json`, text, sha256: sha256Hex(text) };
}

/** The key of the push of a record: organisation, layout, period and revision (R8); the same record and revision always give the same key. */
export const approvalPushKeyOf = (input: { orgId: string; layoutCode: string; period: string; revision: number }): string => issueKeyOf(input);

// ---- the hold ---------------------------------------------------------------------------------------------------------------------------------

/** The PUSH step does not finish by itself: `AWAITING_RECEIPT` until the receiver answers (R22). */
export const HOLD_STATES = ['AWAITING_RECEIPT', 'PUSH_FAILED', 'PUSHED', 'REJECTED', 'CANCELLED'] as const;
export type HoldState = (typeof HOLD_STATES)[number];
export const OPEN_HOLD_STATES: readonly HoldState[] = ['AWAITING_RECEIPT', 'PUSH_FAILED'];
export const HOLD_STEP_KIND = 'PUSH';

export const isOpenHold = (state: HoldState): boolean => OPEN_HOLD_STATES.includes(state);

/** Whether a decision on a task is held: the step is the PUSH step and the process has a receiver to push to (otherwise the step is a person's, as it has always been). */
export const holdsStep = (stepTag: string | undefined, receiverPresent: boolean): boolean => receiverPresent && stepTag === HOLD_STEP_KIND;

export type PushStatus = 'PENDING' | 'WRITTEN' | 'FAILED' | 'ACCEPTED' | 'REJECTED';

/** The state of the hold after a push attempt: a written package waits for the receipt, a failed one can be retried with the same key, and the answer of the receiver, when it is already on the key, is the answer. */
export function holdStateAfterPush(status: PushStatus): HoldState {
  switch (status) {
    case 'FAILED':
      return 'PUSH_FAILED';
    case 'ACCEPTED':
      return 'PUSHED';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return 'AWAITING_RECEIPT';
  }
}

/** What a recorded receipt does to an open hold: an acceptance releases it (the step is done and the instance goes on), a rejection ends it (the record goes back by the usual return). A hold that is not open takes none (409). */
export function holdMoveOnReceipt(hold: { state: HoldState }, receipt: 'ACCEPTED' | 'REJECTED'): { to: 'PUSHED' | 'REJECTED'; release: boolean } {
  if (hold.state !== 'AWAITING_RECEIPT') throw new DomainError('APPROVAL_HOLD_STATE_INVALID', 409, 'state');
  return receipt === 'ACCEPTED' ? { to: 'PUSHED', release: true } : { to: 'REJECTED', release: false };
}

/** The state the step shows on the screens: the PUSH step of a held task reads `AWAITING_RECEIPT` (never "done") until the receipt. */
export function stepStateOf(taskStatus: string, hold: { state: HoldState } | undefined): string {
  if (hold === undefined) return taskStatus;
  if (hold.state === 'PUSHED') return 'PUSHED';
  if (hold.state === 'CANCELLED') return 'Cancelled';
  return hold.state;
}
