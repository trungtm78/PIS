import { DomainError } from './errors.ts';
import { canonicalJson } from './canonical-json.ts';

/**
 * The merge of two master records and its undoing (ST-MDM-010, MDM 3.1 F5, BR-MDM-05, MDM-30, MDM-35, MDM-36). Two records that stand for one thing are consolidated into the survivor, attribute by attribute, by the
 * survivorship rule that is published for the attribute: the source with the higher place in the order (SOURCE_PRIORITY), the later record (MOST_RECENT), the record with fewer empty attributes (MOST_COMPLETE, a tie
 * going to the order of the sources) or a steward's decision (STEWARD_DECISION). An attribute that only one record has, or that both have alike, needs no rule. An attribute the rules cannot settle is a conflict until a
 * steward chooses. Pure functions of their input.
 */
export const SURVIVORSHIP_STRATEGIES = ['SOURCE_PRIORITY', 'MOST_RECENT', 'MOST_COMPLETE', 'STEWARD_DECISION'] as const;
export type SurvivorshipStrategy = (typeof SURVIVORSHIP_STRATEGIES)[number];
export type MergeSide = 'SURVIVOR' | 'MERGED';
/** The pseudo attribute that stands for the label of the record. */
export const LABEL_ATTRIBUTE = 'label';
const ESCAPE = '~';

/**
 * The key an attribute is settled under. The label of the record is `label`, so an attribute of the record that is itself called `label` (or starts with the escape) is keyed `~label`: the two never share a key,
 * whatever the attributes are called.
 */
export const attributeKey = (name: string): string => (name === LABEL_ATTRIBUTE || name.startsWith(ESCAPE) ? `${ESCAPE}${name}` : name);
const attributeName = (key: string): string => (key.startsWith(ESCAPE) ? key.slice(1) : key);

const MAX_ATTRIBUTE = 100;
const MAX_SOURCES = 50;

export interface SurvivorshipRuleInput {
  strategy: SurvivorshipStrategy;
  /** The sources in order, the first one winning; empty when the strategy does not use an order. */
  sourcePriority: readonly string[];
}

export interface MergeRecord {
  label: string;
  attributes: Readonly<Record<string, unknown>>;
  /** The system the record came from (NATIONAL, TREASURY, TENANT, ...), or null when it is not known. */
  sourceSystem: string | null;
  /** When the version that is in force was recorded (an ISO instant), for MOST_RECENT. */
  recordedAt: string;
}

/** How an attribute of the survivor came to be what it is after the merge. */
export type DecisionBy = 'ONLY_ONE' | 'EQUAL' | 'RULE' | 'OVERRIDE';

export interface AttributeDecision {
  attribute: string;
  chosen: MergeSide;
  by: DecisionBy;
  /** The strategy that settled it, for `by = RULE`. */
  strategy: SurvivorshipStrategy | null;
  /** The source of the side that was chosen. */
  source: string | null;
  value: unknown;
}

export interface MergeResult {
  label: string;
  attributes: Record<string, unknown>;
  decisions: AttributeDecision[];
}

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
/** What an object holds under a name of its own: attributes are free-form, so `constructor` or `__proto__` is a name like any other, never what an object inherits. */
const own = (object: Readonly<Record<string, unknown>>, name: string): unknown => (Object.hasOwn(object, name) ? object[name] : undefined);
const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** How many of the attributes the two records name (and the label) a record leaves empty or does not have: the fewer, the more complete. */
function emptiness(record: MergeRecord, names: readonly string[]): number {
  return names.filter((name) => isEmpty(own(record.attributes, name))).length + (isEmpty(record.label) ? 1 : 0);
}

function rank(sources: readonly string[], source: string | null): number {
  const place = source === null ? -1 : sources.indexOf(source);
  return place < 0 ? Number.POSITIVE_INFINITY : place;
}

/** The side a rule prefers, or undefined when the rule cannot tell (a tie, an order that names neither source, a decision left to a steward). */
function settle(rule: SurvivorshipRuleInput, survivor: MergeRecord, merged: MergeRecord): MergeSide | undefined {
  const byOrder = (): MergeSide | undefined => {
    const a = rank(rule.sourcePriority, survivor.sourceSystem);
    const b = rank(rule.sourcePriority, merged.sourceSystem);
    if (a === b) return undefined;
    return a < b ? 'SURVIVOR' : 'MERGED';
  };
  switch (rule.strategy) {
    case 'STEWARD_DECISION':
      return undefined;
    case 'SOURCE_PRIORITY':
      return byOrder();
    case 'MOST_RECENT': {
      const a = Date.parse(survivor.recordedAt);
      const b = Date.parse(merged.recordedAt);
      if (Number.isNaN(a) || Number.isNaN(b) || a === b) return undefined;
      return a > b ? 'SURVIVOR' : 'MERGED';
    }
    case 'MOST_COMPLETE': {
      const names = [...new Set([...Object.keys(survivor.attributes), ...Object.keys(merged.attributes)])];
      const a = emptiness(survivor, names);
      const b = emptiness(merged, names);
      if (a === b) return byOrder();
      return a < b ? 'SURVIVOR' : 'MERGED';
    }
  }
}

/**
 * The record that results from a merge. For each attribute the two records disagree on, the steward's override (`SURVIVOR` or `MERGED`) wins, then the published rule; what neither settles is a conflict: 409
 * `MERGE_CONFLICT` naming the attributes (`extensions.attributes`). An override for an attribute the records agree on is refused (422): it would mean nothing.
 */
export function mergeRecords(survivor: MergeRecord, merged: MergeRecord, rules: ReadonlyMap<string, SurvivorshipRuleInput>, overrides: Readonly<Record<string, unknown>>): MergeResult {
  const sides = new Map<string, MergeRecord>([
    ['SURVIVOR', survivor],
    ['MERGED', merged],
  ]);
  const attributes = new Set<string>([LABEL_ATTRIBUTE, ...Object.keys(survivor.attributes).map(attributeKey), ...Object.keys(merged.attributes).map(attributeKey)]);
  const valueOf = (record: MergeRecord, attribute: string): unknown => (attribute === LABEL_ATTRIBUTE ? record.label : own(record.attributes, attributeName(attribute)));
  for (const [attribute, choice] of Object.entries(overrides)) {
    if (!attributes.has(attribute) || (choice !== 'SURVIVOR' && choice !== 'MERGED')) throw new DomainError('VALIDATION_FAILED', 422, `survivorship_overrides.${attribute}`);
    const a = valueOf(survivor, attribute);
    const b = valueOf(merged, attribute);
    if (isEmpty(a) || isEmpty(b) || same(a, b)) throw new DomainError('VALIDATION_FAILED', 422, `survivorship_overrides.${attribute}`);
  }
  const decisions: AttributeDecision[] = [];
  const conflicts: string[] = [];
  for (const attribute of [...attributes].sort()) {
    const a = valueOf(survivor, attribute);
    const b = valueOf(merged, attribute);
    const decide = (chosen: MergeSide, by: DecisionBy, strategy: SurvivorshipStrategy | null): void => {
      const record = sides.get(chosen) as MergeRecord;
      decisions.push({ attribute, chosen, by, strategy, source: record.sourceSystem, value: chosen === 'SURVIVOR' ? (a ?? null) : (b ?? null) });
    };
    if (isEmpty(a) && isEmpty(b)) continue;
    if (isEmpty(b)) decide('SURVIVOR', 'ONLY_ONE', null);
    else if (isEmpty(a)) decide('MERGED', 'ONLY_ONE', null);
    else if (same(a, b)) decide('SURVIVOR', 'EQUAL', null);
    else {
      const override = own(overrides, attribute);
      if (override === 'SURVIVOR' || override === 'MERGED') {
        decide(override, 'OVERRIDE', null);
        continue;
      }
      const rule = rules.get(attribute);
      const side = rule === undefined ? undefined : settle(rule, survivor, merged);
      if (rule === undefined || side === undefined) conflicts.push(attribute);
      else decide(side, 'RULE', rule.strategy);
    }
  }
  if (conflicts.length > 0) throw new DomainError('MERGE_CONFLICT', 409, 'survivorship_overrides', { extensions: { attributes: conflicts } });
  const result = new Map<string, unknown>();
  let label = survivor.label;
  for (const decision of decisions) {
    if (decision.attribute === LABEL_ATTRIBUTE) label = decision.value as string;
    else result.set(attributeName(decision.attribute), decision.value);
  }
  return { label, attributes: Object.fromEntries(result), decisions };
}

export interface UnmergeInput {
  /** The decisions the merge made, as it stored them. */
  decisions: readonly AttributeDecision[];
  /** The attributes of the version of the survivor that the merge made. */
  atMerge: Readonly<Record<string, unknown>>;
  atMergeLabel: string;
  /** The attributes of the version of the survivor now. */
  now: Readonly<Record<string, unknown>>;
  nowLabel: string;
  /** The survivor as it was before the merge. */
  before: MergeRecord;
  /** The steward's answer for each attribute that was edited since: `KEEP` the value now, or `REVERT` to the one before the merge. */
  stewardDecisions: Readonly<Record<string, unknown>>;
}

export interface UnmergeResult {
  label: string;
  attributes: Record<string, unknown>;
  /** The attributes that came from the merged record and that the survivor gets back to their value before the merge. */
  reverted: string[];
  /** The attributes edited since the merge, with the answer of the steward. */
  kept: string[];
}

/**
 * What the survivor becomes when a merge is undone. The attributes the merge took from the merged record go back to what the survivor had before; the others stay as they are now (the survivor lived on after the
 * merge). An attribute that came from the merged record and was edited since the merge is a conflict - the edit would be lost - until a steward says `KEEP` or `REVERT` for it: 409 `UNMERGE_CONFLICT` naming them
 * (`extensions.attributes`). A decision for an attribute that is not in conflict is refused (422).
 */
export function unmergeSurvivor(input: UnmergeInput): UnmergeResult {
  const fromMerged = input.decisions.filter((decision) => decision.chosen === 'MERGED');
  const valueNow = (attribute: string): unknown => (attribute === LABEL_ATTRIBUTE ? input.nowLabel : own(input.now, attributeName(attribute)));
  const valueAtMerge = (attribute: string): unknown => (attribute === LABEL_ATTRIBUTE ? input.atMergeLabel : own(input.atMerge, attributeName(attribute)));
  const edited = fromMerged.map((decision) => decision.attribute).filter((attribute) => !same(valueNow(attribute), valueAtMerge(attribute)));
  for (const [attribute, answer] of Object.entries(input.stewardDecisions)) {
    if (!edited.includes(attribute) || (answer !== 'KEEP' && answer !== 'REVERT')) throw new DomainError('VALIDATION_FAILED', 422, `steward_decisions.${attribute}`);
  }
  const open = edited.filter((attribute) => own(input.stewardDecisions, attribute) === undefined);
  if (open.length > 0) throw new DomainError('UNMERGE_CONFLICT', 409, 'steward_decisions', { extensions: { attributes: open } });
  const attributes = new Map<string, unknown>(Object.entries(input.now));
  let label = input.nowLabel;
  const reverted: string[] = [];
  const kept: string[] = [];
  for (const decision of fromMerged) {
    if (edited.includes(decision.attribute) && own(input.stewardDecisions, decision.attribute) === 'KEEP') {
      kept.push(decision.attribute);
      continue;
    }
    reverted.push(decision.attribute);
    const name = attributeName(decision.attribute);
    const before = decision.attribute === LABEL_ATTRIBUTE ? input.before.label : own(input.before.attributes, name);
    if (decision.attribute === LABEL_ATTRIBUTE) label = before as string;
    else if (isEmpty(before)) attributes.delete(name);
    else attributes.set(name, before);
  }
  return { label, attributes: Object.fromEntries(attributes), reverted, kept };
}

/** A rule of survivorship, checked on its own: an attribute of up to 100 characters, a strategy, the order of sources (1 to 50 names, none twice) required for SOURCE_PRIORITY, and a day it takes effect. */
export function checkSurvivorshipRule(input: { masterType: string; attributeName: string; strategy: string; sourcePriority: readonly string[] | undefined; effectiveFrom: string }): {
  masterType: string;
  attributeName: string;
  strategy: SurvivorshipStrategy;
  sourcePriority: string[];
} {
  const strategy = SURVIVORSHIP_STRATEGIES.find((candidate) => candidate === input.strategy);
  if (strategy === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'strategy');
  const masterType = input.masterType.trim();
  if (masterType === '' || masterType.length > 50 || masterType.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, 'master_type');
  const attributeName = input.attributeName.trim();
  if (attributeName === '' || attributeName.length > MAX_ATTRIBUTE || attributeName.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, 'attribute_name');
  const sources = (input.sourcePriority ?? []).map((source) => source.trim());
  if (sources.length > MAX_SOURCES || sources.some((source) => source === '' || source.length > 50 || source.includes('\0')) || new Set(sources).size !== sources.length)
    throw new DomainError('VALIDATION_FAILED', 422, 'source_priority');
  if (strategy === 'SOURCE_PRIORITY' && sources.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'source_priority');
  if (strategy === 'STEWARD_DECISION' && sources.length > 0) throw new DomainError('VALIDATION_FAILED', 422, 'source_priority');
  return { masterType, attributeName, strategy, sourcePriority: sources };
}
