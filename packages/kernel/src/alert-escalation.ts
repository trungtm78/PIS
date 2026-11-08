import { DomainError } from './errors.ts';
import { addWorkingTime } from './working-time.ts';
import type { WorkCalendarSource, WorkingInterval } from './working-time.ts';
import type { ClockSeverity, ClockView, ItemClocks } from './work-clock.ts';
import { ALERT_GOV_TEXT } from './messages/alert-gov-texts.ts';

/**
 * Escalation of an alert that nobody acts on (roadmap G2-3, research A4, docs/alert-governance.md). An item of the alert centre that is not taken up, goes silent after it was taken up, or runs past its time, goes up a chain of levels;
 * each level is marked FUNCTIONAL (another unit of expertise, named by a role: planning-finance, inspection) or HIERARCHICAL (the line leadership above the owner, so many tiers up), and each level has its own waiting time in working hours
 * counted on the published working calendar by the same engine as the clocks (`itemClocks`, `addWorkingTime`). An item to be watched never goes to a person; once it has aged a rule-given number of working days untouched it is raised one
 * step (WATCH to ACTION) with a stated reason, so that "yellow for ever" cannot happen.
 *
 * Everything here is pure: the policy (a governance rule, `ESCALATION_POLICY`), the calendars and the clock of the caller come in as arguments. A year without a published working calendar never gives a guessed level time: the levels whose
 * time needs it are absent and the basis says so, exactly as the clocks do.
 */

export const ESCALATION_RULE_TYPE = 'ESCALATION_POLICY';
export const ESCALATION_DEFAULT_CODE = 'DEFAULT';

export const ESCALATION_KINDS = ['FUNCTIONAL', 'HIERARCHICAL'] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

/** What starts the climb: nobody took the item up in time, somebody took it up and then showed no sign of work, it ran past its time; an item with no valid owner (ORPHANED) climbs at once and is not configurable. */
export const ESCALATION_TRIGGERS = ['NOT_CLAIMED', 'NO_PROGRESS', 'OVERDUE'] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number] | 'ORPHANED';

export interface EscalationStep {
  kind: EscalationKind;
  /** Working hours after the previous level was reached (the first level: after the trigger fired); 0 means at once. */
  after_working_hours: number;
  /** HIERARCHICAL: how many leadership tiers above the owner (1 is the nearest). */
  levels_up?: number | undefined;
  /** FUNCTIONAL: the code of the role of the function that takes the item over. */
  function_role?: string | undefined;
}

type PerSeverity<T> = Readonly<Record<ClockSeverity, T>>;

export interface EscalationPolicy {
  /** The levels for each severity, nearest first; an item to be watched has none. */
  steps: PerSeverity<readonly EscalationStep[]>;
  /** The triggers in force (the item is also escalated at once when it is orphaned). */
  triggers: readonly (typeof ESCALATION_TRIGGERS)[number][];
  /** A level whose recipient acknowledged the item holds the next levels for this many working hours; an item still open after it goes on up. */
  hold_after_acknowledge_working_hours: PerSeverity<number>;
  /** Where an item without a valid owner goes (the owner is gone, or absent with nobody to cover). */
  orphan_step: EscalationStep;
  /** An item to be watched that nobody touched for so many working days is raised to be acted on. */
  watch_promotion: { enabled: boolean; after_working_days: number };
  /** The lowest rank of a role that counts as line leadership, and the lowest rank of an administrative role (used only when no leadership exists, so that the chain is never empty). */
  leader_min_rank: number;
  admin_fallback_min_rank: number;
}

/** Starting values of the research (PagerDuty escalation policies, ITIL functional and hierarchical escalation), to be settled with the customer and the audit; they are not legal numbers. */
export function escalationPolicyDefaults(): EscalationPolicy {
  return {
    steps: {
      URGENT: [
        { kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: 1 },
        { kind: 'FUNCTIONAL', after_working_hours: 4, function_role: 'AUDITOR' },
        { kind: 'HIERARCHICAL', after_working_hours: 8, levels_up: 2 },
      ],
      ACTION: [
        { kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: 1 },
        { kind: 'HIERARCHICAL', after_working_hours: 16, levels_up: 2 },
      ],
      WATCH: [],
    },
    triggers: [...ESCALATION_TRIGGERS],
    hold_after_acknowledge_working_hours: { URGENT: 8, ACTION: 24, WATCH: 40 },
    orphan_step: { kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: 1 },
    watch_promotion: { enabled: true, after_working_days: 20 },
    leader_min_rank: 60,
    admin_fallback_min_rank: 90,
  };
}

// -- Reading what a governance rule carries ----------------------------------------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const ROLE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const MAX_STEPS = 5;

function stepOf(value: unknown, field: string): EscalationStep {
  if (!isRecord(value)) throw invalid(field);
  const kind = value.kind;
  if (kind !== 'FUNCTIONAL' && kind !== 'HIERARCHICAL') throw invalid(`${field}.kind`);
  const after = value.after_working_hours;
  if (typeof after !== 'number' || !Number.isInteger(after) || after < 0 || after > 720) throw invalid(`${field}.after_working_hours`);
  if (kind === 'HIERARCHICAL') {
    const up = value.levels_up;
    if (typeof up !== 'number' || !Number.isInteger(up) || up < 1 || up > 5) throw invalid(`${field}.levels_up`);
    if (value.function_role !== undefined) throw invalid(`${field}.function_role`);
    return { kind, after_working_hours: after, levels_up: up };
  }
  const role = value.function_role;
  if (typeof role !== 'string' || !ROLE_CODE.test(role)) throw invalid(`${field}.function_role`);
  if (value.levels_up !== undefined) throw invalid(`${field}.levels_up`);
  return { kind, after_working_hours: after, function_role: role };
}

function perSeverityNumbers(value: unknown, field: string, min: number, max: number): PerSeverity<number> {
  if (!isRecord(value)) throw invalid(field);
  const read = (key: ClockSeverity): number => {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) throw invalid(`${field}.${key}`);
    return number;
  };
  return { URGENT: read('URGENT'), ACTION: read('ACTION'), WATCH: read('WATCH') };
}

/** The params of an `ESCALATION_POLICY` rule, checked: a rule that does not say all of it is refused rather than half applied. An item to be watched never has a level (it is raised instead). */
export function escalationPolicyOf(params: unknown): EscalationPolicy {
  if (!isRecord(params)) throw invalid('params');
  const steps = params.steps;
  if (!isRecord(steps)) throw invalid('steps');
  const read = (severity: ClockSeverity): EscalationStep[] => {
    const list = steps[severity];
    if (!Array.isArray(list) || list.length > MAX_STEPS) throw invalid(`steps.${severity}`);
    return list.map((one, index) => stepOf(one, `steps.${severity}[${index}]`));
  };
  const parsed = { URGENT: read('URGENT'), ACTION: read('ACTION'), WATCH: read('WATCH') };
  if (parsed.WATCH.length > 0) throw invalid('steps.WATCH');
  if (parsed.URGENT.length === 0) throw invalid('steps.URGENT');
  if (parsed.ACTION.length === 0) throw invalid('steps.ACTION');
  const triggers = params.triggers;
  if (!Array.isArray(triggers) || triggers.length === 0 || !triggers.every((one) => (ESCALATION_TRIGGERS as readonly unknown[]).includes(one)) || new Set(triggers).size !== triggers.length) throw invalid('triggers');
  const promotion = params.watch_promotion;
  if (!isRecord(promotion) || typeof promotion.enabled !== 'boolean') throw invalid('watch_promotion');
  const days = promotion.after_working_days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) throw invalid('watch_promotion.after_working_days');
  const leader = params.leader_min_rank;
  const admin = params.admin_fallback_min_rank;
  if (typeof leader !== 'number' || !Number.isInteger(leader) || leader < 1 || leader > 89) throw invalid('leader_min_rank');
  if (typeof admin !== 'number' || !Number.isInteger(admin) || admin < leader || admin > 99) throw invalid('admin_fallback_min_rank');
  return {
    steps: parsed,
    triggers: triggers as (typeof ESCALATION_TRIGGERS)[number][],
    hold_after_acknowledge_working_hours: perSeverityNumbers(params.hold_after_acknowledge_working_hours, 'hold_after_acknowledge_working_hours', 0, 720),
    orphan_step: stepOf(params.orphan_step, 'orphan_step'),
    watch_promotion: { enabled: promotion.enabled, after_working_days: days },
    leader_min_rank: leader,
    admin_fallback_min_rank: admin,
  };
}

// -- When the levels are reached ----------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface AcknowledgedLevel {
  level: number;
  ackedAt: Date;
}

export interface EscalationInput {
  severity: ClockSeverity;
  now: Date;
  lifecycle: 'NEW' | 'CLAIMED' | 'IN_PROGRESS' | 'RESOLVED';
  /** The two clocks of the item as `itemClocks` gave them. */
  clocks: Pick<ItemClocks, 'claim' | 'resolve' | 'needsReclaim'> | null;
  /** A paused item and a snoozed one is in somebody's hands: its trigger does not hold. */
  paused: boolean;
  snoozedUntil: Date | null;
  /** The item has no valid owner now (the owner left, or is absent and nobody covers): it climbs at once. */
  orphaned: { since: Date } | null;
  /** The levels whose recipients acknowledged the item. */
  acknowledged: readonly AcknowledgedLevel[];
  policy: EscalationPolicy;
  calendars: WorkCalendarSource | undefined;
  intervals?: readonly WorkingInterval[] | undefined;
}

export interface EscalationLevelPlan {
  /** 1-based. */
  level: number;
  step: EscalationStep;
  /** The instant the level is reached: null when it cannot be counted (no published calendar for a level that waits). */
  reachedAt: string | null;
  reached: boolean;
}

export interface EscalationEvaluation {
  /** `NOT_APPLICABLE`: resolved, or nothing to climb for the severity; `NO_TRIGGER`: no trigger holds now; `CALENDAR_UNAVAILABLE`: a level that waits could not be counted. */
  basis: 'WORKING_TIME' | 'CALENDAR_UNAVAILABLE' | 'NO_TRIGGER' | 'NOT_APPLICABLE';
  triggers: Array<{ trigger: EscalationTrigger; since: string }>;
  anchor: string | null;
  levels: EscalationLevelPlan[];
  /** The highest level reached by `now` (0 when none). */
  reached: number;
  /** When the next level is reached, null when the chain is at its top or nothing is counted. */
  nextAt: string | null;
  steps: number;
}

const iso = (date: Date): string => date.toISOString();

function triggersOf(input: EscalationInput): Array<{ trigger: EscalationTrigger; since: Date }> {
  const found: Array<{ trigger: EscalationTrigger; since: Date }> = [];
  if (input.orphaned !== null) found.push({ trigger: 'ORPHANED', since: input.orphaned.since });
  if (input.paused || (input.snoozedUntil !== null && input.snoozedUntil.getTime() > input.now.getTime())) return found;
  const on = (trigger: (typeof ESCALATION_TRIGGERS)[number]): boolean => input.policy.triggers.includes(trigger);
  const claim: ClockView | null | undefined = input.clocks?.claim;
  if (on('NOT_CLAIMED') && input.lifecycle === 'NEW' && claim != null && claim.state === 'BREACHED') found.push({ trigger: 'NOT_CLAIMED', since: new Date(claim.due_at) });
  const reclaim = input.clocks?.needsReclaim;
  if (on('NO_PROGRESS') && input.lifecycle === 'CLAIMED' && reclaim != null) found.push({ trigger: 'NO_PROGRESS', since: new Date(reclaim.since) });
  const resolve = input.clocks?.resolve;
  if (on('OVERDUE') && resolve != null && resolve.state === 'BREACHED') found.push({ trigger: 'OVERDUE', since: new Date(resolve.due_at) });
  return found;
}

/**
 * The climb of an item: which triggers hold, when each level is reached, how far it has gone and when the next level comes. The first level is reached when the earliest trigger fired plus its own waiting time (usually none), each later level
 * after its own waiting time counted from the level before (in working hours). A level whose recipient acknowledged the item holds the later levels for the hold of the severity: the later levels are counted from the end of the hold when that is later.
 * An orphaned item climbs by the orphan step, at once. A resolved item and an item to be watched do not climb.
 */
export function evaluateEscalation(input: EscalationInput): EscalationEvaluation {
  const steps = input.lifecycle === 'RESOLVED' ? [] : input.policy.steps[input.severity];
  const none = (basis: EscalationEvaluation['basis'], triggers: Array<{ trigger: EscalationTrigger; since: Date }> = []): EscalationEvaluation => ({ basis, triggers: triggers.map((one) => ({ trigger: one.trigger, since: iso(one.since) })), anchor: null, levels: [], reached: 0, nextAt: null, steps: steps.length });
  const holding = triggersOf(input);
  const orphan = holding.find((one) => one.trigger === 'ORPHANED');
  if (input.lifecycle === 'RESOLVED') return none('NOT_APPLICABLE');
  if (orphan !== undefined) {
    // An orphaned item climbs by the orphan step alone: nobody is there to act, so the waiting time of the first level is not waited for twice.
    const reached = orphan.since.getTime() <= input.now.getTime();
    return {
      basis: 'WORKING_TIME',
      triggers: holding.map((one) => ({ trigger: one.trigger, since: iso(one.since) })),
      anchor: iso(orphan.since),
      levels: [{ level: 1, step: input.policy.orphan_step, reachedAt: iso(orphan.since), reached }],
      reached: reached ? 1 : 0,
      nextAt: null,
      steps: 1,
    };
  }
  if (steps.length === 0) return none('NOT_APPLICABLE');
  if (holding.length === 0) return none('NO_TRIGGER');
  const anchor = holding.reduce((first, one) => (one.since.getTime() < first.since.getTime() ? one : first)).since;
  const levels: EscalationLevelPlan[] = [];
  let basis: EscalationEvaluation['basis'] = 'WORKING_TIME';
  let previous: Date | null = anchor;
  let floor: Date | null = null;
  let reached = 0;
  let nextAt: string | null = null;
  const hold = input.policy.hold_after_acknowledge_working_hours[input.severity];
  steps.forEach((step, index) => {
    const level = index + 1;
    let at: Date | null = null;
    if (previous !== null) {
      if (step.after_working_hours === 0) at = previous;
      else if (input.calendars === undefined) basis = 'CALENDAR_UNAVAILABLE';
      else {
        try {
          at = addWorkingTime(input.calendars, previous, { minutes: step.after_working_hours * 60 }, input.intervals);
        } catch (failure) {
          if (!(failure instanceof DomainError) || failure.code !== 'CALENDAR_NOT_EFFECTIVE') throw failure;
          basis = 'CALENDAR_UNAVAILABLE';
        }
      }
    }
    if (at !== null && floor !== null && floor.getTime() > at.getTime()) at = floor;
    // The hold of an acknowledged level moves every level after it.
    const acked = input.acknowledged.find((one) => one.level === level);
    if (acked !== undefined && hold > 0 && input.calendars !== undefined) {
      try {
        const until = addWorkingTime(input.calendars, acked.ackedAt, { minutes: hold * 60 }, input.intervals);
        if (floor === null || until.getTime() > floor.getTime()) floor = until;
      } catch (failure) {
        if (!(failure instanceof DomainError) || failure.code !== 'CALENDAR_NOT_EFFECTIVE') throw failure;
        basis = 'CALENDAR_UNAVAILABLE';
      }
    }
    previous = at;
    const isReached = at !== null && at.getTime() <= input.now.getTime();
    if (isReached) reached = level;
    else if (at !== null && nextAt === null) nextAt = iso(at);
    levels.push({ level, step, reachedAt: at === null ? null : iso(at), reached: isReached });
  });
  return { basis, triggers: holding.map((one) => ({ trigger: one.trigger, since: iso(one.since) })), anchor: iso(anchor), levels, reached, nextAt, steps: steps.length };
}

/** The levels that are reached and not yet recorded, lowest first: what a pass has to write. */
export function levelsToRecord(evaluation: EscalationEvaluation, recorded: ReadonlySet<number>): EscalationLevelPlan[] {
  return evaluation.levels.filter((level) => level.reached && !recorded.has(level.level));
}

// -- Raising an item to be watched --------------------------------------------------------------------------------------------------------------------------------------------------------

export const PROMOTION_REASON = 'WATCH_AGED';

export interface PromotionInput {
  severity: ClockSeverity;
  now: Date;
  /** When the item started (the module's start when it says one, else the first time the alert centre saw it). */
  since: Date;
  lifecycle: 'NEW' | 'CLAIMED' | 'IN_PROGRESS' | 'RESOLVED';
  snoozedUntil: Date | null;
  paused: boolean;
  policy: EscalationPolicy;
  calendars: WorkCalendarSource | undefined;
  intervals?: readonly WorkingInterval[] | undefined;
}

export type PromotionVerdict = { promote: false; reason: 'NOT_WATCH' | 'DISABLED' | 'TOUCHED' | 'NOT_YET' | 'CALENDAR_UNAVAILABLE' } | { promote: true; from: 'WATCH'; to: 'ACTION'; reasonCode: typeof PROMOTION_REASON; since: string };

/** Whether an item that is only to be watched has waited long enough, untouched, to be raised one step. An item somebody took up, put off or paused is touched and keeps its severity. */
export function evaluatePromotion(input: PromotionInput): PromotionVerdict {
  if (input.severity !== 'WATCH') return { promote: false, reason: 'NOT_WATCH' };
  if (!input.policy.watch_promotion.enabled) return { promote: false, reason: 'DISABLED' };
  if (input.lifecycle !== 'NEW' || input.paused || (input.snoozedUntil !== null && input.snoozedUntil.getTime() > input.now.getTime())) return { promote: false, reason: 'TOUCHED' };
  if (input.calendars === undefined) return { promote: false, reason: 'CALENDAR_UNAVAILABLE' };
  try {
    const due = addWorkingTime(input.calendars, input.since, { minutes: input.policy.watch_promotion.after_working_days * 8 * 60 }, input.intervals);
    if (due.getTime() > input.now.getTime()) return { promote: false, reason: 'NOT_YET' };
    return { promote: true, from: 'WATCH', to: 'ACTION', reasonCode: PROMOTION_REASON, since: iso(due) };
  } catch (failure) {
    if (failure instanceof DomainError && failure.code === 'CALENDAR_NOT_EFFECTIVE') return { promote: false, reason: 'CALENDAR_UNAVAILABLE' };
    throw failure;
  }
}

// -- Who receives a level -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A person who could receive an escalated item, with what the choice of tier needs: the highest rank of their grants that reach the owner's place, the depth of the unit they belong to and the roles they hold there. */
export interface EscalationCandidate {
  membershipId: string;
  rank: number;
  unitDepth: number;
  roleCodes: readonly string[];
}

export interface EscalationOwner {
  membershipId: string;
  /** The highest rank of the owner's grants. */
  rank: number;
}

export type EscalationVia = 'PRIMARY' | 'FALLBACK_HIERARCHY' | 'FALLBACK_ADMIN';
export type EscalationGap = 'FUNCTION_VACANT' | 'NO_LEADER';

export interface EscalationTarget {
  recipients: string[];
  via: EscalationVia;
  /** Why the plain choice was not possible; the gap is recorded in the routing gaps and counted as orphaned. */
  gap: EscalationGap | null;
}

export interface TargetOptions {
  /** People who must not receive it (the owner, and those who already got a lower level). */
  exclude?: readonly string[];
  /** The rank an approver of the item must have at least (the band of the matrix of authority for an approval). */
  minRank?: number;
}

const byDepthThenRank = (left: EscalationCandidate, right: EscalationCandidate): number => right.unitDepth - left.unitDepth || left.rank - right.rank || left.membershipId.localeCompare(right.membershipId, 'en');

/** One entry per person: the highest rank, the deepest unit, all the roles. */
function distinctPeople(candidates: readonly EscalationCandidate[], exclude: ReadonlySet<string>): EscalationCandidate[] {
  const merged = new Map<string, EscalationCandidate>();
  for (const candidate of candidates) {
    if (exclude.has(candidate.membershipId)) continue;
    const known = merged.get(candidate.membershipId);
    merged.set(
      candidate.membershipId,
      known === undefined ? { ...candidate, roleCodes: [...candidate.roleCodes] } : { membershipId: known.membershipId, rank: Math.max(known.rank, candidate.rank), unitDepth: Math.max(known.unitDepth, candidate.unitDepth), roleCodes: [...new Set([...known.roleCodes, ...candidate.roleCodes])] },
    );
  }
  return [...merged.values()];
}

function hierarchical(levelsUp: number, owner: EscalationOwner, people: readonly EscalationCandidate[], policy: EscalationPolicy, minRank: number): EscalationTarget {
  const floor = Math.max(policy.leader_min_rank, owner.rank + 1, minRank);
  const leaders = people.filter((person) => person.rank >= floor && person.rank < policy.admin_fallback_min_rank).sort(byDepthThenRank);
  if (leaders.length > 0) {
    // The tiers are the distinct (unit depth, rank) pairs, nearest unit and lowest rank first; asking for more tiers than there are gives the top one.
    const tiers: EscalationCandidate[][] = [];
    for (const person of leaders) {
      const last = tiers[tiers.length - 1];
      if (last !== undefined && last[0]?.unitDepth === person.unitDepth && last[0]?.rank === person.rank) last.push(person);
      else tiers.push([person]);
    }
    const tier = tiers[Math.min(levelsUp, tiers.length) - 1] ?? [];
    return { recipients: tier.map((person) => person.membershipId), via: 'PRIMARY', gap: null };
  }
  const admins = people.filter((person) => person.rank >= Math.max(policy.admin_fallback_min_rank, owner.rank + 1, minRank)).sort(byDepthThenRank);
  if (admins.length > 0) return { recipients: admins.map((person) => person.membershipId), via: 'FALLBACK_ADMIN', gap: 'NO_LEADER' };
  return { recipients: [], via: 'FALLBACK_ADMIN', gap: 'NO_LEADER' };
}

/**
 * Who receives a level (FUNCTIONAL: everybody who holds the function's role at the owner's place, a team; HIERARCHICAL: the leaders so many tiers above the owner). A function nobody holds falls to the first leadership tier and says so
 * (`FUNCTION_VACANT`); a place with no leadership falls to the administrators and says so (`NO_LEADER`); with none at all the list is empty and the caller records the item as orphaned. The chain is never silently empty.
 */
export function resolveEscalationRecipients(step: EscalationStep, owner: EscalationOwner, candidates: readonly EscalationCandidate[], policy: EscalationPolicy, options: TargetOptions = {}): EscalationTarget {
  const exclude = new Set([owner.membershipId, ...(options.exclude ?? [])]);
  const people = distinctPeople(candidates, exclude);
  const minRank = options.minRank ?? 0;
  if (step.kind === 'HIERARCHICAL') return hierarchical(step.levels_up ?? 1, owner, people, policy, minRank);
  const holders = people.filter((person) => step.function_role !== undefined && person.roleCodes.includes(step.function_role) && person.rank >= minRank);
  if (holders.length > 0) return { recipients: holders.sort(byDepthThenRank).map((person) => person.membershipId), via: 'PRIMARY', gap: null };
  const fallback = hierarchical(1, owner, people, policy, minRank);
  return { ...fallback, via: fallback.via === 'PRIMARY' ? 'FALLBACK_HIERARCHY' : fallback.via, gap: 'FUNCTION_VACANT' };
}

/** The words of each level for the item card ("who receives it next"): `Leadership, tier 1`, `Function AUDITOR`. */
export function escalationChainLabels(policy: EscalationPolicy, severity: ClockSeverity): string[] {
  return policy.steps[severity].map((step) => (step.kind === 'HIERARCHICAL' ? ALERT_GOV_TEXT.chain_hierarchical(step.levels_up ?? 1) : ALERT_GOV_TEXT.chain_functional(step.function_role ?? '')));
}

/** The one series of an escalation row: an item, a level and a person; recording it twice records it once. */
export const escalationSeriesKey = (source: string, sourceId: string, level: number, recipient: string): string => `ESCALATION:${source}:${sourceId}:${level}:${recipient.toLowerCase()}`.slice(0, 200);

/** The one series of a promotion of an item. */
export const promotionSeriesKey = (source: string, sourceId: string): string => `PROMOTION:${source}:${sourceId}`.slice(0, 200);
