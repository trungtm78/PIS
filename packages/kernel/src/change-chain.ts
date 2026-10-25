import { DomainError } from './errors.ts';

/**
 * The chain of changes of a contract (CTR 3.3, BR-CTR-07, ST-CTR-006): a project uses one, two or three tiers (ChangeEvent, PCO, CO), the number is fixed when the first request of the
 * project is raised, a request starts at the first tier of the chain and is promoted tier by tier, and only a CO is decided and can change the contract. This module holds the
 * table of the tiers and of the statuses and the rules of the sizes that the stores and the database both enforce.
 */
export const TIER_COUNTS = [1, 2, 3] as const;
export type TierCount = (typeof TIER_COUNTS)[number];

export const CHANGE_STAGES = ['EVENT', 'PCO', 'CO'] as const;
export type ChangeStage = (typeof CHANGE_STAGES)[number];

export const CHANGE_STATUSES = ['DRAFT', 'SUBMITTED', 'EVALUATED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'PROMOTED'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const CHANGE_EVENT_KINDS = ['OWNER_INSTRUCTION', 'DESIGN_CHANGE', 'SITE_CONDITION', 'FORCE_MAJEURE', 'LEGAL_CHANGE', 'QUANTITY_VARIANCE', 'OTHER'] as const;
export type ChangeEventKind = (typeof CHANGE_EVENT_KINDS)[number];

/** The tiers a project with this many tiers goes through, in order: 3 is ChangeEvent, PCO, CO; 2 is PCO, CO; 1 is CO alone. */
export function stagesOf(tierCount: TierCount): readonly ChangeStage[] {
  return CHANGE_STAGES.slice(CHANGE_STAGES.length - tierCount);
}

/** The tier a first request starts at: EVENT for 3 tiers, PCO for 2, CO for 1. */
export const startStageOf = (tierCount: TierCount): ChangeStage => stagesOf(tierCount)[0] as ChangeStage;

/** The tier a request is promoted to, or undefined when it is at the last tier (a CO is decided, not promoted) or its tier is not in the chain. */
export function nextStageOf(stage: ChangeStage, tierCount: TierCount): ChangeStage | undefined {
  const stages = stagesOf(tierCount);
  const at = stages.indexOf(stage);
  return at < 0 ? undefined : stages[at + 1];
}

export const tierCountOf = (value: unknown): TierCount | undefined => TIER_COUNTS.find((count) => count === value);

/** The tiers that are evaluated: the assessment of cost, schedule, scope and funding is made on a PCO or a CO, not on the first notice of an event. */
export const EVALUATED_STAGES: readonly ChangeStage[] = ['PCO', 'CO'];

/** The statuses of a contract in which a change can be raised: it is being performed (a suspended contract may still need a variation, such as more time). */
export const CHANGEABLE_CONTRACT_STATUSES: readonly string[] = ['ACTIVE', 'SUSPENDED'];

/** The statuses in which a request can still be promoted, evaluated or withdrawn. */
export const OPEN_CHANGE_STATUSES: readonly ChangeStatus[] = ['SUBMITTED', 'EVALUATED'];

const CODE_PREFIX: Readonly<Record<ChangeStage, string>> = { EVENT: 'CE', PCO: 'PCO', CO: 'CO' };

/** The code of the n-th request of a tier in a contract: CE-001, PCO-002, CO-003. */
export const changeCode = (stage: ChangeStage, n: number): string => `${CODE_PREFIX[stage]}-${String(n).padStart(3, '0')}`;

const SIGNED_VND = /^-?[0-9]{1,24}$/;

/** A signed whole amount of VND as text (a change may add to the contract or take from it); anything else is 422 `VALIDATION_FAILED` naming the field. */
export function signedVnd(value: string, field: string): string {
  const trimmed = value.trim();
  if (!SIGNED_VND.test(trimmed)) throw new DomainError('VALIDATION_FAILED', 422, field);
  // "-0" and "007" are not how an amount is written; the stored value is the number.
  return BigInt(trimmed).toString();
}

export const MAX_SCHEDULE_DAYS = 36_500;

/** A whole number of days, positive when the change delays the contract and negative when it hastens it, within a hundred years. */
export function scheduleDays(value: number, field: string): number {
  if (!Number.isInteger(value) || Math.abs(value) > MAX_SCHEDULE_DAYS) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}
