import { DomainError } from './errors.ts';
import { message } from './messages.ts';

/**
 * The funding taxonomy pack of FND-1 (docs/fnd-funding-model.md section 4): the first axis of a funding figure (the class), the second (the tier), the "of which" subsets, the descriptive tags, the measures, the groups of
 * origins that make the two denominators, how the person enters a report, whether a phasing must add up to the year plan, where the actual figure of each class comes from, which source wins, how far two sources may differ,
 * which ratios the pack publishes and which period grains it accepts. A pack is DATA: the governance rule type `FUNDING_TAXONOMY` (one code per pack) carries it, versioned and approved through the governance store; the
 * two packs below are only the built-in defaults. This module is pure: it parses what the rule holds into the shape the figure engine reads and judges the rules across fields that the closed schema language cannot say.
 */

export const FUNDING_TAXONOMY_RULE_TYPE = 'FUNDING_TAXONOMY';
export const FUNDING_PACK_CODES = ['PUBLIC', 'ENTERPRISE'] as const;
export type FundingPackCode = (typeof FUNDING_PACK_CODES)[number];
export const isFundingPackCode = (value: unknown): value is FundingPackCode => typeof value === 'string' && (FUNDING_PACK_CODES as readonly string[]).includes(value);

/** The pack of the product edition: the public edition counts in the public pack and the enterprise edition in the enterprise pack (ENT-0 names the edition, this names its pack). */
export const fundingPackCodeOfEdition = (edition: 'public' | 'enterprise'): FundingPackCode => (edition === 'enterprise' ? 'ENTERPRISE' : 'PUBLIC');

export const MEASURES = ['DISBURSED', 'EXECUTED'] as const;
export type Measure = (typeof MEASURES)[number];
export const ENTRY_MODES = ['CUMULATIVE_ENTRY', 'PERIOD_ENTRY'] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];
export const ACTUAL_SOURCES = ['TREASURY', 'ERP', 'REPORTED'] as const;
export type ActualSource = (typeof ACTUAL_SOURCES)[number];
export const ACTUALS_PRECEDENCES = ['TREASURY_HEADLINE', 'REPORTED_UNTIL_RECONCILED'] as const;
export type ActualsPrecedence = (typeof ACTUALS_PRECEDENCES)[number];
export const PERIOD_GRAINS = ['WEEK', 'MONTH', 'QUARTER', 'YEAR'] as const;
export type PeriodGrain = (typeof PERIOD_GRAINS)[number];

/** The names a ratio may use for its numerator and its denominator (figures of section 5.2, plus the two public sources and the sum of the classes). */
export const RATIO_TERMS = [
  'ACTUAL',
  'CUMULATIVE_YTD',
  'CUMULATIVE_SINCE_START',
  'ESTIMATE_YEAR',
  'ESTIMATE_AS_REPORTED',
  'PLAN_IN_FORCE',
  'PLAN_IN_FORCE_PRIMARY',
  'PLAN_YEAR',
  'PLAN_PERIOD',
  'PLAN_TO_DATE',
  'TMDT_IN_FORCE',
  'CLASS_SUM',
  'TREASURY_YTD',
  'REPORTED_CUMULATIVE',
] as const;
export type RatioTerm = (typeof RATIO_TERMS)[number];
export const RATIO_BASES = ['OFFICIAL', 'TREASURY', 'REPORTED'] as const;
export type RatioBasis = (typeof RATIO_BASES)[number];

export interface FundingClass {
  code: string;
  label: string;
  additive: boolean;
  takesSubsets: readonly string[];
}
export interface FundingTier {
  code: string;
  label: string;
}
export interface FundingSubset {
  code: string;
  label: string;
  ofClasses: readonly string[];
}
export interface FundingTag {
  code: string;
  label: string;
  carriesAmount: boolean;
}
export interface FundingRatio {
  code: string;
  numerator: RatioTerm;
  denominator: RatioTerm;
  classFilter: readonly string[];
  basis: RatioBasis;
}

/** A pack as the engine reads it. */
export interface FundingPack {
  packCode: string;
  label: string;
  classes: readonly FundingClass[];
  tiers: readonly FundingTier[];
  subsets: readonly FundingSubset[];
  tags: readonly FundingTag[];
  measures: readonly Measure[];
  /** The origin of a plan line (CAP `origin`) to the part of the denominator it belongs to. */
  originGroups: { primary: readonly string[]; added: readonly string[] };
  /** The kinds of decision document (codes of the legal-document catalogue) that may back an appropriation of each origin; an origin that is not here binds no kind (the public pack binds none). */
  originDecisions: ReadonlyMap<string, readonly string[]>;
  entryMode: EntryMode;
  phasingMustSum: boolean;
  /** The source of the actual figure of each class. */
  actualsSource: ReadonlyMap<string, ActualSource>;
  actualsPrecedence: ActualsPrecedence;
  /** Above `pct` percent (of the larger source) or `absVnd` dong, whichever is larger, a difference between two sources needs an explanation. */
  varianceTolerance: { pct: number; absVnd: number };
  ratios: readonly FundingRatio[];
  periodGrains: readonly PeriodGrain[];
}

/** The class code that nothing is left unclassified into. */
export const OTHER_CLASS = 'OTHER';
/** The only tier of a pack that has no second axis. */
export const SINGLE_TIER = 'ALL';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []);
const records = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRecord) : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const flag = (value: unknown): boolean => value === true;

function duplicate(codes: readonly string[]): boolean {
  return new Set(codes).size !== codes.length;
}

/**
 * The judgement across fields of a pack (the `refine` of the rule type): returns the offending field, or undefined. Class codes are unique and `OTHER` is among them (nothing is unclassified); every `of_classes` and
 * `takes_subsets` names a listed code; a pack with no second axis has the single tier `ALL` and a pack with one has at least two; the two groups of origins are disjoint; the ratios name known terms and classes; the
 * source of actuals covers every class once.
 */
export function refineFundingPack(params: Record<string, unknown>): string | undefined {
  const classes = records(params['classes']);
  const classCodes = classes.map((one) => text(one['code']));
  if (duplicate(classCodes)) return 'classes';
  if (!classCodes.includes(OTHER_CLASS)) return 'classes';
  const subsets = records(params['subsets']);
  const subsetCodes = subsets.map((one) => text(one['code']));
  if (duplicate(subsetCodes)) return 'subsets';
  for (const subset of subsets) if (!strings(subset['of_classes']).every((code) => classCodes.includes(code))) return 'subsets';
  for (const one of classes) if (!strings(one['takes_subsets']).every((code) => subsetCodes.includes(code))) return 'classes';
  const tierCodes = records(params['tiers']).map((one) => text(one['code']));
  if (duplicate(tierCodes)) return 'tiers';
  if (tierCodes.length === 1 ? tierCodes[0] !== SINGLE_TIER : tierCodes.includes(SINGLE_TIER)) return 'tiers';
  if (duplicate(records(params['tags']).map((one) => text(one['code'])))) return 'tags';
  if (duplicate(strings(params['measures']))) return 'measures';
  const groups = isRecord(params['origin_groups']) ? params['origin_groups'] : {};
  const primary = strings(groups['PRIMARY']);
  const added = strings(groups['ADDED']);
  if (duplicate(primary) || duplicate(added) || primary.some((origin) => added.includes(origin))) return 'origin_groups';
  const decisions = records(params['origin_decisions']);
  if (duplicate(decisions.map((one) => text(one['origin'])))) return 'origin_decisions';
  for (const one of decisions) {
    if (![...primary, ...added].includes(text(one['origin'])) || duplicate(strings(one['kinds'])) || strings(one['kinds']).length === 0) return 'origin_decisions';
  }
  const sourced = records(params['actuals_source']).flatMap((one) => strings(one['class_codes']));
  if (duplicate(sourced) || !classCodes.every((code) => sourced.includes(code)) || !sourced.every((code) => classCodes.includes(code))) return 'actuals_source';
  const ratios = records(params['ratios']);
  if (duplicate(ratios.map((one) => text(one['code'])))) return 'ratios';
  for (const ratio of ratios) {
    if (!(RATIO_TERMS as readonly string[]).includes(text(ratio['numerator'])) || !(RATIO_TERMS as readonly string[]).includes(text(ratio['denominator']))) return 'ratios';
    if (!strings(ratio['class_filter']).every((code) => classCodes.includes(code))) return 'ratios';
    if (text(ratio['numerator']) === 'CLASS_SUM') return 'ratios';
  }
  if (duplicate(strings(params['period_grains']))) return 'period_grains';
  return undefined;
}

/** The pack a rule holds: the params are judged (422 GOVERNANCE_RULE_PARAMS_INVALID naming the field) and read into the shape of the engine. */
export function parseFundingPack(packCode: string, params: unknown): FundingPack {
  if (!isRecord(params)) throw bad('params');
  const field = refineFundingPack(params);
  if (field !== undefined) throw bad(field);
  const groups = isRecord(params['origin_groups']) ? params['origin_groups'] : {};
  const tolerance = isRecord(params['variance_tolerance']) ? params['variance_tolerance'] : {};
  const sources = new Map<string, ActualSource>();
  for (const one of records(params['actuals_source'])) for (const code of strings(one['class_codes'])) sources.set(code, text(one['source']) as ActualSource);
  return {
    packCode,
    label: text(params['pack_label']),
    classes: records(params['classes']).map((one) => ({ code: text(one['code']), label: text(one['label']), additive: flag(one['additive']), takesSubsets: strings(one['takes_subsets']) })),
    tiers: records(params['tiers']).map((one) => ({ code: text(one['code']), label: text(one['label']) })),
    subsets: records(params['subsets']).map((one) => ({ code: text(one['code']), label: text(one['label']), ofClasses: strings(one['of_classes']) })),
    tags: records(params['tags']).map((one) => ({ code: text(one['code']), label: text(one['label']), carriesAmount: flag(one['carries_amount']) })),
    measures: strings(params['measures']) as Measure[],
    originGroups: { primary: strings(groups['PRIMARY']), added: strings(groups['ADDED']) },
    originDecisions: new Map(records(params['origin_decisions']).map((one) => [text(one['origin']), strings(one['kinds'])] as const)),
    entryMode: text(params['entry_mode']) as EntryMode,
    phasingMustSum: flag(params['phasing_must_sum']),
    actualsSource: sources,
    actualsPrecedence: text(params['actuals_precedence']) as ActualsPrecedence,
    varianceTolerance: { pct: typeof tolerance['pct'] === 'number' ? tolerance['pct'] : 0, absVnd: typeof tolerance['abs_vnd'] === 'number' ? tolerance['abs_vnd'] : 0 },
    ratios: records(params['ratios']).map((one) => ({
      code: text(one['code']),
      numerator: text(one['numerator']) as RatioTerm,
      denominator: text(one['denominator']) as RatioTerm,
      classFilter: strings(one['class_filter']),
      basis: text(one['basis']) as RatioBasis,
    })),
    periodGrains: strings(params['period_grains']) as PeriodGrain[],
  };
}

const ratio = (code: string, numerator: RatioTerm, denominator: RatioTerm, classFilter: readonly string[], basis: RatioBasis): Record<string, unknown> => ({ code, numerator, denominator, class_filter: [...classFilter], basis });

/** The built-in params of the public pack: the six cells of the paper form (BR-DIS-01), the plan split by origin as `planSplitOf` does, the Treasury as the headline of the year plan. */
export function publicPackParams(): Record<string, unknown> {
  return {
    pack_label: message('fnd.pack.public.label'),
    classes: [
      { code: 'CURRENT_YEAR', label: message('fnd.class.current_year'), additive: true, takes_subsets: ['CTMTQG'] },
      { code: 'CARRYOVER', label: message('fnd.class.carryover'), additive: true, takes_subsets: ['CTMTQG'] },
      { code: 'OTHER', label: message('fnd.class.other_public'), additive: true, takes_subsets: [] },
    ],
    tiers: [
      { code: 'CENTRAL', label: message('fnd.tier.central') },
      { code: 'LOCAL', label: message('fnd.tier.local') },
    ],
    subsets: [{ code: 'CTMTQG', label: message('fnd.subset.ctmtqg'), of_classes: ['CURRENT_YEAR', 'CARRYOVER'] }],
    tags: [],
    measures: ['DISBURSED'],
    origin_groups: { PRIMARY: ['PM_ASSIGNED', 'CARRYOVER'], ADDED: ['LOCAL_ADDED', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE'] },
    entry_mode: 'CUMULATIVE_ENTRY',
    phasing_must_sum: false,
    actuals_source: [
      { class_codes: ['CURRENT_YEAR'], source: 'TREASURY' },
      { class_codes: ['CARRYOVER', 'OTHER'], source: 'REPORTED' },
    ],
    actuals_precedence: 'TREASURY_HEADLINE',
    variance_tolerance: { pct: 5, abs_vnd: 0 },
    ratios: [ratio('RATE_PM', 'TREASURY_YTD', 'PLAN_IN_FORCE_PRIMARY', ['CURRENT_YEAR'], 'TREASURY'), ratio('RATE_TOTAL', 'TREASURY_YTD', 'PLAN_IN_FORCE', ['CURRENT_YEAR'], 'TREASURY'), ratio('RATE_CARRYOVER', 'REPORTED_CUMULATIVE', 'PLAN_IN_FORCE', ['CARRYOVER'], 'REPORTED')],
    period_grains: ['WEEK', 'MONTH'],
  };
}

/** The built-in params of the enterprise pack (every value is an assumption of the spec, A-3, until the customer's indicator dictionary arrives). */
export function enterprisePackParams(): Record<string, unknown> {
  return {
    pack_label: message('fnd.pack.enterprise.label'),
    classes: [
      { code: 'EQUITY', label: message('fnd.class.equity'), additive: true, takes_subsets: [] },
      { code: 'LOAN', label: message('fnd.class.loan'), additive: true, takes_subsets: [] },
      { code: 'OTHER', label: message('fnd.class.other_enterprise'), additive: true, takes_subsets: [] },
    ],
    tiers: [{ code: SINGLE_TIER, label: message('fnd.tier.all') }],
    subsets: [],
    tags: [
      { code: 'ODA', label: message('fnd.tag.oda'), carries_amount: false },
      { code: 'COMMERCIAL_LOAN', label: message('fnd.tag.commercial_loan'), carries_amount: false },
      { code: 'BOND', label: message('fnd.tag.bond'), carries_amount: false },
      { code: 'GROUP_LOAN', label: message('fnd.tag.group_loan'), carries_amount: false },
    ],
    measures: ['EXECUTED', 'DISBURSED'],
    origin_groups: { PRIMARY: ['GROUP_ASSIGNED', 'BOARD_APPROVED', 'CARRYOVER'], ADDED: [] },
    origin_decisions: [
      { origin: 'GROUP_ASSIGNED', kinds: ['GROUP_RESOLUTION', 'GROUP_DECISION'] },
      { origin: 'BOARD_APPROVED', kinds: ['COMPANY_RESOLUTION', 'COMPANY_DECISION'] },
      { origin: 'CARRYOVER', kinds: ['GROUP_RESOLUTION', 'GROUP_DECISION', 'COMPANY_RESOLUTION', 'COMPANY_DECISION'] },
    ],
    entry_mode: 'PERIOD_ENTRY',
    phasing_must_sum: true,
    actuals_source: [{ class_codes: ['EQUITY', 'LOAN', 'OTHER'], source: 'ERP' }],
    actuals_precedence: 'REPORTED_UNTIL_RECONCILED',
    variance_tolerance: { pct: 1, abs_vnd: 1_000_000 },
    ratios: [
      ratio('RATE_YEAR_IN_FORCE', 'CUMULATIVE_YTD', 'PLAN_IN_FORCE', [], 'OFFICIAL'),
      ratio('RATE_YEAR_ORIGINAL', 'CUMULATIVE_YTD', 'PLAN_YEAR', [], 'OFFICIAL'),
      ratio('RATE_PERIOD', 'ACTUAL', 'PLAN_PERIOD', [], 'OFFICIAL'),
      ratio('RATE_YTD_PHASED', 'CUMULATIVE_YTD', 'PLAN_TO_DATE', [], 'OFFICIAL'),
      ratio('RATE_OUTLOOK_YEAR', 'ESTIMATE_YEAR', 'PLAN_IN_FORCE', [], 'OFFICIAL'),
      ratio('RATE_SINCE_START', 'CUMULATIVE_SINCE_START', 'TMDT_IN_FORCE', [], 'OFFICIAL'),
      ratio('ESTIMATE_ACCURACY', 'ACTUAL', 'ESTIMATE_AS_REPORTED', [], 'OFFICIAL'),
      ratio('STRUCTURE_SHARE', 'CUMULATIVE_YTD', 'CLASS_SUM', [], 'OFFICIAL'),
    ],
    period_grains: ['MONTH', 'QUARTER', 'YEAR'],
  };
}

/** The params of a built-in pack, a fresh copy each time so that nobody can change a registered default by changing what this returns. */
export const builtInPackParams = (packCode: FundingPackCode): Record<string, unknown> => (packCode === 'ENTERPRISE' ? enterprisePackParams() : publicPackParams());

/** The built-in pack of a code, parsed. */
export const builtInPack = (packCode: FundingPackCode): FundingPack => parseFundingPack(packCode, builtInPackParams(packCode));

/** Which part of the denominator a plan line of this origin belongs to: the plan the Prime Minister gave (primary) or what was added (an origin listed under ADDED); an origin no group lists, and none, counts as primary (as `planSplitOf` does). */
export const splitOfOrigin = (pack: FundingPack, origin: string | null): 'PRIMARY' | 'ADDED' => (origin !== null && pack.originGroups.added.includes(origin) ? 'ADDED' : 'PRIMARY');

/** The class that carries the Treasury figure of the pack: the first class whose actual comes from the Treasury, on the first tier; undefined when no class does. */
export function treasuryCarrier(pack: FundingPack): { classCode: string; tierCode: string } | undefined {
  const carrier = pack.classes.find((one) => pack.actualsSource.get(one.code) === 'TREASURY');
  const tier = pack.tiers[0];
  return carrier === undefined || tier === undefined ? undefined : { classCode: carrier.code, tierCode: tier.code };
}

/** 422 `FUNDING_CLASS_UNKNOWN` naming the field when a class or a tier is not one of the pack. */
export function assertClassAndTier(pack: FundingPack, classCode: string, tierCode: string, field = 'class_code'): void {
  if (!pack.classes.some((one) => one.code === classCode)) throw new DomainError('FUNDING_CLASS_UNKNOWN', 422, field);
  if (!pack.tiers.some((one) => one.code === tierCode)) throw new DomainError('FUNDING_CLASS_UNKNOWN', 422, 'tier_code');
}

/** The crosswalk of a version that removed or renamed a class (section 4.3): every old code maps to a code of the new pack, so that history can be read through it. */
export function assertClassCrosswalk(before: FundingPack, after: FundingPack, crosswalk: Readonly<Record<string, string>>): void {
  for (const one of before.classes) {
    if (after.classes.some((next) => next.code === one.code)) continue;
    const target = crosswalk[one.code];
    if (target === undefined || !after.classes.some((next) => next.code === target)) throw new DomainError('FUNDING_CLASS_UNKNOWN', 422, 'class_crosswalk');
  }
}

/** The pack of a tenant that already has a frozen snapshot cannot change to another pack (409 `TAXONOMY_PACK_LOCKED`); a new version of the same pack is allowed. */
export function assertPackChange(current: string | null, next: string, hasFrozenSnapshot: boolean): void {
  if (current !== null && current !== next && hasFrozenSnapshot) throw new DomainError('TAXONOMY_PACK_LOCKED', 409, 'package');
}

/** The origins an appropriation of the pack may carry: both groups. */
export const originsOfPack = (pack: FundingPack): readonly string[] => [...pack.originGroups.primary, ...pack.originGroups.added];

/** The budget levels an appropriation of the pack may carry: the tiers of the pack (the enterprise pack has the single level `ALL`). */
export const budgetLevelsOfPack = (pack: FundingPack): readonly string[] => pack.tiers.map((one) => one.code);

/**
 * Judges the origin, the budget level and the kind of decision of an appropriation against the pack of the process (CAP, ENT-3e): the origin and the level must be listed by the pack; an origin the pack binds to kinds of
 * decision document (the enterprise pack: the resolution of the group backs `GROUP_ASSIGNED`, the decision of the company backs `BOARD_APPROVED`) needs one of those kinds; an origin it binds to none takes no kind, so the
 * public pack behaves as it always did. 422 `VALIDATION_FAILED` naming the field.
 */
export function assertAppropriationForPack(pack: FundingPack, input: { origin: string; budgetLevel: string; decisionKind: string | null | undefined }): void {
  if (!originsOfPack(pack).includes(input.origin)) throw new DomainError('VALIDATION_FAILED', 422, 'origin');
  if (!budgetLevelsOfPack(pack).includes(input.budgetLevel)) throw new DomainError('VALIDATION_FAILED', 422, 'budget_level');
  const kinds = pack.originDecisions.get(input.origin);
  const given = input.decisionKind ?? null;
  if (kinds === undefined ? given !== null : given === null || !kinds.includes(given)) throw new DomainError('VALIDATION_FAILED', 422, 'decision_kind');
}
