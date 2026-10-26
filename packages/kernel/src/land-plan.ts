import { DomainError } from './errors.ts';
import type { InventoryItemKind } from './land-inventory.ts';

/**
 * The plan of compensation, support and resettlement (LND BR-LND-05): its items, what each kind of item rests on, how the items add up to the totals of the plan, and which states of a plan can still be
 * written to or replaced by a new revision. The amounts are whole dong and are added as whole numbers.
 */

export const PLAN_EXECUTOR_KINDS = ['PROJECT_OWNER', 'LAND_FUND_CENTRE', 'DISTRICT_BOARD'] as const;
export type PlanExecutorKind = (typeof PLAN_EXECUTOR_KINDS)[number];

export const PLAN_STATUSES = ['DRAFT', 'POSTING', 'POSTING_CLOSED', 'APPROVED', 'PAYING', 'COMPLETED', 'CANCELLED', 'REVISED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_ITEM_KINDS = ['COMPENSATION_LAND', 'COMPENSATION_ASSET', 'SUPPORT_LIVELIHOOD', 'SUPPORT_RELOCATION', 'SUPPORT_TRAINING', 'RESETTLEMENT_LAND', 'RESETTLEMENT_HOUSE'] as const;
export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number];

/** The three totals of a plan: what is paid for what the household loses, what helps it live through the move, and the land or house it is resettled on. */
export const PLAN_TOTAL_GROUPS = ['COMPENSATION', 'SUPPORT', 'RESETTLEMENT'] as const;
export type PlanTotalGroup = (typeof PLAN_TOTAL_GROUPS)[number];

/** The most items one command adds: a plan is composed in steps, and a step stays inside one transaction of a size a person can check. */
export const MAX_ITEMS_PER_COMMAND = 200;

const AMOUNT = /^(0|[1-9]\d{0,23})$/;

export const totalGroupOf = (kind: PlanItemKind): PlanTotalGroup => (kind.startsWith('COMPENSATION_') ? 'COMPENSATION' : kind.startsWith('SUPPORT_') ? 'SUPPORT' : 'RESETTLEMENT');

/** Whether an item of this kind is counted from an inventory (it rests on a confirmed record) or stated as a policy amount with its legal basis (support and resettlement). */
export const restsOnInventory = (kind: PlanItemKind): boolean => kind === 'COMPENSATION_LAND' || kind === 'COMPENSATION_ASSET';

/** The kind of item an inventory record gives: land is compensated as land, every other asset as an asset. */
export const compensationKindOf = (asset: InventoryItemKind): 'COMPENSATION_LAND' | 'COMPENSATION_ASSET' => (asset === 'LAND' ? 'COMPENSATION_LAND' : 'COMPENSATION_ASSET');

/** Items are added to a plan that is a draft and to no other; a posted or approved plan is revised, never edited. */
export const acceptsItems = (status: PlanStatus): boolean => status === 'DRAFT';

/** The states a plan is revised from: it was posted to the households or approved, so a change is a new revision and the earlier one stays as it was read. */
export const REVISABLE_STATUSES: readonly PlanStatus[] = ['POSTING', 'POSTING_CLOSED', 'APPROVED'];
export const canRevise = (status: PlanStatus): boolean => REVISABLE_STATUSES.includes(status);

/** The ways an opinion reaches the officer while a plan is posted (the opinions of the households and of the community, LND 3.1 step 5). */
export const FEEDBACK_CHANNELS = ['IN_PERSON', 'LETTER', 'PORTAL', 'MEETING'] as const;
export type FeedbackChannel = (typeof FEEDBACK_CHANNELS)[number];

/** An opinion is open until an officer handles it, and a handled opinion is final. */
export const FEEDBACK_STATUSES = ['OPEN', 'HANDLED'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** A plan is posted to the households from a draft with something in it. */
export const canPost = (status: PlanStatus): boolean => status === 'DRAFT';

/** Opinions are recorded while the plan is posted and not after: the households were given the period to speak, and what comes later is a complaint. */
export const acceptsFeedback = (status: PlanStatus): boolean => status === 'POSTING';

/** Opinions are handled while the plan is posted and after its posting closed, until it is approved: approval waits for the last one. */
export const acceptsFeedbackHandling = (status: PlanStatus): boolean => status === 'POSTING' || status === 'POSTING_CLOSED';

/** An amount in whole dong (422 `VALIDATION_FAILED`, the field named). */
export function normalizeAmount(value: string, field: string): string {
  const amount = value.trim();
  if (!AMOUNT.test(amount)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return amount;
}

export interface PlanTotals {
  compensation: string;
  support: string;
  resettlement: string;
  grand: string;
}

/** The totals of the items given, by group, added as whole numbers. */
export function totalsOf(items: ReadonlyArray<{ itemKind: PlanItemKind; amountVnd: string }>): PlanTotals {
  const sums: Record<PlanTotalGroup, bigint> = { COMPENSATION: 0n, SUPPORT: 0n, RESETTLEMENT: 0n };
  for (const item of items) sums[totalGroupOf(item.itemKind)] += BigInt(item.amountVnd);
  return {
    compensation: sums.COMPENSATION.toString(),
    support: sums.SUPPORT.toString(),
    resettlement: sums.RESETTLEMENT.toString(),
    grand: (sums.COMPENSATION + sums.SUPPORT + sums.RESETTLEMENT).toString(),
  };
}
