import { DomainError, builtInCodes, registerRuleType, resolveGovernanceRule, sha256Hex } from '@machvon/kernel';
import type { DefaultInput, FieldSpec, GovernanceRuleVersion, RuleParams } from '@machvon/kernel';
import { registerEditionBaseline, sealPack } from '@machvon/db';
import type { BaselineEntry } from '@machvon/db';
import { textsOf } from '../report-forms/texts.ts';

/**
 * The catalogues of the enterprise project register (ENT-3e, HSKT MD.01 and MD.02): the types of project, the flag of the stage in a plan year (new start or continuing), the milestones of the investment life and the types of
 * legal document. Each is a governance rule type with one rule code per entry, so an entry is versioned and approved by someone other than its maker like every other rule, shows its formula, source and as-of day, and is
 * flagged unverified until the customer confirms it; a tenant adds an entry by proposing a new code (no new table). Registered once when the edition loads, so a public process never carries these types. The project types
 * are also published as entries of the master catalogue `PROJECT_TYPE` (a pack that the baseline job applies after the platform pack), so a project can point at one through `project_type_master_version_id`.
 */
interface CatalogueTexts {
  source: string;
  projectType: { formula: string; source: string };
  startFlag: { formula: string; source: string };
  milestone: { formula: string; source: string };
  legalDocType: { formula: string; source: string };
  projectTypes: Record<string, string>;
  startFlags: Record<string, string>;
  milestones: Record<string, string>;
  legalDocTypes: Record<string, string>;
}

export const catalogueTexts = (): CatalogueTexts => textsOf<CatalogueTexts>('catalogue');

export const CATALOGUE_AS_OF = '2026-11-09';
export const PROJECT_TYPE_RULE = 'ENT_PROJECT_TYPE';
export const START_FLAG_RULE = 'ENT_START_FLAG';
export const MILESTONE_RULE = 'ENT_LIFECYCLE_MILESTONE';
export const LEGAL_DOC_TYPE_RULE = 'ENT_LEGAL_DOC_TYPE';
export const CATALOGUE_RULE_TYPES = [PROJECT_TYPE_RULE, START_FLAG_RULE, MILESTONE_RULE, LEGAL_DOC_TYPE_RULE] as const;

export const ENTERPRISE_PROJECT_KINDS = ['CAPITAL_WORKS', 'PROCUREMENT', 'MAJOR_REPAIR'] as const;
export const START_FLAG_BASES = ['STARTS_IN_PLAN_YEAR', 'STARTED_BEFORE_PLAN_YEAR'] as const;
export const MILESTONE_PHASES = ['PREPARATION', 'APPROVAL', 'EXECUTION', 'CLOSURE'] as const;
export const LEGAL_ISSUERS = ['GROUP', 'COMPANY', 'STATE', 'OTHER'] as const;
export const LEGAL_PURPOSES = ['CAPITAL_ASSIGNMENT', 'LIFECYCLE_EVIDENCE'] as const;
export type StartFlag = 'NEW_START' | 'CONTINUING';

const code = (): FieldSpec => ({ kind: 'text', max: 40, pattern: '^[A-Z][A-Z0-9_]{1,39}$' });
const label = (): FieldSpec => ({ kind: 'text', max: 160 });

const PROJECT_TYPE_SCHEMA: Readonly<Record<string, FieldSpec>> = {
  label: label(),
  kind: { kind: 'enum', values: ENTERPRISE_PROJECT_KINDS },
  master_key: { kind: 'text', max: 100, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' },
};
const START_FLAG_SCHEMA: Readonly<Record<string, FieldSpec>> = { label: label(), basis: { kind: 'enum', values: START_FLAG_BASES } };
const MILESTONE_SCHEMA: Readonly<Record<string, FieldSpec>> = {
  label: label(),
  sequence: { kind: 'int', min: 1, max: 1000 },
  phase: { kind: 'enum', values: MILESTONE_PHASES },
  evidence_kinds: { kind: 'list', of: code(), min: 1, max: 8 },
  required: { kind: 'boolean' },
};
const LEGAL_DOC_SCHEMA: Readonly<Record<string, FieldSpec>> = {
  label: label(),
  issuer: { kind: 'enum', values: LEGAL_ISSUERS },
  purpose: { kind: 'enum', values: LEGAL_PURPOSES },
};

interface Seeded {
  code: string;
  params: RuleParams;
}

const texts = catalogueTexts();
const textFor = (group: Record<string, string>, entry: string): string => {
  const found = group[entry];
  if (found === undefined) throw new Error(`enterprise catalogue: no text for ${entry}`);
  return found;
};

export const PROJECT_TYPE_SEEDS: readonly Seeded[] = Object.freeze([
  { code: 'CAPEX_CONSTRUCTION', params: { label: textFor(texts.projectTypes, 'CAPEX_CONSTRUCTION'), kind: 'CAPITAL_WORKS', master_key: 'ENT_CAPEX_CONSTRUCTION' } },
  { code: 'EQUIPMENT_PROCUREMENT', params: { label: textFor(texts.projectTypes, 'EQUIPMENT_PROCUREMENT'), kind: 'PROCUREMENT', master_key: 'ENT_EQUIPMENT_PROCUREMENT' } },
  { code: 'MAJOR_REPAIR', params: { label: textFor(texts.projectTypes, 'MAJOR_REPAIR'), kind: 'MAJOR_REPAIR', master_key: 'ENT_MAJOR_REPAIR' } },
]);

export const START_FLAG_SEEDS: readonly Seeded[] = Object.freeze([
  { code: 'NEW_START', params: { label: textFor(texts.startFlags, 'NEW_START'), basis: 'STARTS_IN_PLAN_YEAR' } },
  { code: 'CONTINUING', params: { label: textFor(texts.startFlags, 'CONTINUING'), basis: 'STARTED_BEFORE_PLAN_YEAR' } },
]);

const milestone = (entry: string, sequence: number, phase: (typeof MILESTONE_PHASES)[number], evidence: string[], required: boolean): Seeded => ({
  code: entry,
  params: { label: textFor(texts.milestones, entry), sequence, phase, evidence_kinds: evidence, required },
});

/** The milestones of the investment life in the order the customer lists them; the gaps between the sequence numbers leave room for a tenant to insert its own. */
export const MILESTONE_SEEDS: readonly Seeded[] = Object.freeze([
  milestone('INVESTMENT_POLICY', 10, 'PREPARATION', ['INVESTMENT_POLICY_DECISION'], true),
  milestone('INVESTMENT_CERTIFICATE', 20, 'PREPARATION', ['INVESTMENT_CERTIFICATE_DOC'], false),
  milestone('FS_APPROVAL', 30, 'APPROVAL', ['FS_APPROVAL_DECISION'], true),
  milestone('TMDT_APPROVAL', 40, 'APPROVAL', ['TMDT_APPROVAL_DECISION'], true),
  milestone('CONTRACTOR_SELECTION_PLAN', 50, 'APPROVAL', ['CONTRACTOR_PLAN_DECISION'], true),
  milestone('GROUNDBREAKING', 60, 'EXECUTION', ['GROUNDBREAKING_RECORD'], true),
  milestone('ACCEPTANCE', 70, 'CLOSURE', ['ACCEPTANCE_RECORD'], true),
  milestone('FINAL_SETTLEMENT', 80, 'CLOSURE', ['SETTLEMENT_DECISION'], true),
]);

const legal = (entry: string, issuer: (typeof LEGAL_ISSUERS)[number], purpose: (typeof LEGAL_PURPOSES)[number]): Seeded => ({ code: entry, params: { label: textFor(texts.legalDocTypes, entry), issuer, purpose } });

export const LEGAL_DOC_TYPE_SEEDS: readonly Seeded[] = Object.freeze([
  legal('GROUP_RESOLUTION', 'GROUP', 'CAPITAL_ASSIGNMENT'),
  legal('GROUP_DECISION', 'GROUP', 'CAPITAL_ASSIGNMENT'),
  legal('COMPANY_RESOLUTION', 'COMPANY', 'CAPITAL_ASSIGNMENT'),
  legal('COMPANY_DECISION', 'COMPANY', 'CAPITAL_ASSIGNMENT'),
  legal('INVESTMENT_POLICY_DECISION', 'GROUP', 'LIFECYCLE_EVIDENCE'),
  legal('INVESTMENT_CERTIFICATE_DOC', 'STATE', 'LIFECYCLE_EVIDENCE'),
  legal('FS_APPROVAL_DECISION', 'COMPANY', 'LIFECYCLE_EVIDENCE'),
  legal('TMDT_APPROVAL_DECISION', 'COMPANY', 'LIFECYCLE_EVIDENCE'),
  legal('CONTRACTOR_PLAN_DECISION', 'COMPANY', 'LIFECYCLE_EVIDENCE'),
  legal('GROUNDBREAKING_RECORD', 'COMPANY', 'LIFECYCLE_EVIDENCE'),
  legal('ACCEPTANCE_RECORD', 'COMPANY', 'LIFECYCLE_EVIDENCE'),
  legal('SETTLEMENT_DECISION', 'COMPANY', 'LIFECYCLE_EVIDENCE'),
]);

const defaultsOf = (seeds: readonly Seeded[]): Record<string, DefaultInput> => Object.fromEntries(seeds.map((seed) => [seed.code, { params: { ...seed.params } }]));

let registered = false;

/** Registers the four rule types, with the built-in entries, and the baseline pack of the project types. Idempotent. */
export function registerEnterpriseCatalogueRules(): void {
  if (registered) return;
  registered = true;
  const provenance = { asOf: CATALOGUE_AS_OF, legalStatus: 'UNVERIFIED' as const };
  registerRuleType({ type: PROJECT_TYPE_RULE, ownerModule: 'PRJ', modules: ['PRJ', 'ENT'], ...provenance, ...texts.projectType, schema: PROJECT_TYPE_SCHEMA, defaults: defaultsOf(PROJECT_TYPE_SEEDS) });
  registerRuleType({ type: START_FLAG_RULE, ownerModule: 'PRJ', modules: ['PRJ', 'CAP', 'ENT'], ...provenance, ...texts.startFlag, schema: START_FLAG_SCHEMA, defaults: defaultsOf(START_FLAG_SEEDS) });
  registerRuleType({
    type: MILESTONE_RULE,
    ownerModule: 'PRJ',
    modules: ['PRJ', 'ENT'],
    ...provenance,
    ...texts.milestone,
    schema: MILESTONE_SCHEMA,
    defaults: defaultsOf(MILESTONE_SEEDS),
  });
  registerRuleType({ type: LEGAL_DOC_TYPE_RULE, ownerModule: 'DOC', modules: ['DOC', 'CAP', 'PRJ', 'ENT'], ...provenance, ...texts.legalDocType, schema: LEGAL_DOC_SCHEMA, defaults: defaultsOf(LEGAL_DOC_TYPE_SEEDS) });
  registerEditionBaseline(enterpriseProjectTypePack());
}

// ---- reading the catalogues ------------------------------------------------------------------------------------------------------------------------

export interface MilestoneEntry {
  code: string;
  label: string;
  sequence: number;
  phase: (typeof MILESTONE_PHASES)[number];
  evidenceKinds: readonly string[];
  required: boolean;
}

export interface LegalDocTypeEntry {
  code: string;
  label: string;
  issuer: (typeof LEGAL_ISSUERS)[number];
  purpose: (typeof LEGAL_PURPOSES)[number];
}

/** The codes of a type in force: the built-in ones and those a tenant added through approved rules; a code whose rule is retired and has no default is not listed. */
function codesOf(rules: readonly GovernanceRuleVersion[], type: string, asOf: string): string[] {
  registerEnterpriseCatalogueRules();
  const codes = new Set([...builtInCodes(type), ...rules.filter((one) => one.type === type).map((one) => one.code)]);
  return [...codes].filter((one) => resolveGovernanceRule(rules, type, one, asOf) !== undefined).sort();
}

export function milestonesOf(rules: readonly GovernanceRuleVersion[], asOf: string): MilestoneEntry[] {
  return milestonesOfResolved(codesOf(rules, MILESTONE_RULE, asOf).map((one) => ({ code: one, params: (resolveGovernanceRule(rules, MILESTONE_RULE, one, asOf) as { params: RuleParams }).params })));
}

/** The milestones as the resolver of the governance rules hands them (a rule of the tenant in force, else the built-in default), in the order of the catalogue. */
export function milestonesOfResolved(resolved: ReadonlyArray<{ code: string; params: RuleParams }>): MilestoneEntry[] {
  return resolved
    .map((one) => ({
      code: one.code,
      label: one.params.label as string,
      sequence: one.params.sequence as number,
      phase: one.params.phase as MilestoneEntry['phase'],
      evidenceKinds: one.params.evidence_kinds as string[],
      required: one.params.required as boolean,
    }))
    .sort((left, right) => left.sequence - right.sequence || left.code.localeCompare(right.code));
}

export function legalDocTypesOf(rules: readonly GovernanceRuleVersion[], asOf: string): LegalDocTypeEntry[] {
  return codesOf(rules, LEGAL_DOC_TYPE_RULE, asOf).map((one) => {
    const params = (resolveGovernanceRule(rules, LEGAL_DOC_TYPE_RULE, one, asOf) as { params: RuleParams }).params;
    return { code: one, label: params.label as string, issuer: params.issuer as LegalDocTypeEntry['issuer'], purpose: params.purpose as LegalDocTypeEntry['purpose'] };
  });
}

/** The legal-document types as the resolver of the governance rules hands them (a rule of the tenant in force, else the built-in default), in the order of the codes. */
export function legalDocTypesOfResolved(resolved: ReadonlyArray<{ code: string; params: RuleParams }>): LegalDocTypeEntry[] {
  return resolved
    .map((one) => ({ code: one.code, label: one.params.label as string, issuer: one.params.issuer as LegalDocTypeEntry['issuer'], purpose: one.params.purpose as LegalDocTypeEntry['purpose'] }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

/**
 * What is wrong across the entries of the catalogues (a rule judges one entry, not the set): two milestones with one sequence number, a milestone whose evidence names a type of document the catalogue does not hold or
 * one that assigns capital rather than proves a milestone. Returns the problems as `kind:code` texts; empty when the set is sound.
 */
export function catalogueProblems(input: { milestones: readonly MilestoneEntry[]; legalDocTypes: readonly LegalDocTypeEntry[] }): string[] {
  const problems: string[] = [];
  const seen = new Map<number, string>();
  for (const one of input.milestones) {
    const earlier = seen.get(one.sequence);
    if (earlier !== undefined) problems.push(`SEQUENCE_REPEATED:${one.code}`);
    else seen.set(one.sequence, one.code);
    for (const kind of one.evidenceKinds) {
      const found = input.legalDocTypes.find((type) => type.code === kind);
      if (found === undefined) problems.push(`EVIDENCE_UNKNOWN:${one.code}:${kind}`);
      else if (found.purpose !== 'LIFECYCLE_EVIDENCE') problems.push(`EVIDENCE_NOT_EVIDENCE:${one.code}:${kind}`);
    }
  }
  return problems;
}

/**
 * The flag of a project in a plan year: new start when it starts in the year, continuing when it started in an earlier year, none when it starts later or has no start year yet. Pure: the caller gives the start year
 * (the year of the groundbreaking milestone, or the planned one while it is not reached).
 */
export function startFlagOf(input: { startYear: number | null; planYear: number }): StartFlag | null {
  if (input.startYear === null) return null;
  if (input.startYear === input.planYear) return 'NEW_START';
  return input.startYear < input.planYear ? 'CONTINUING' : null;
}

/**
 * The milestones a project reached must come in the order of the catalogue: a milestone with a later sequence may not be dated before one with an earlier sequence that was reached too. 422 `VALIDATION_FAILED`
 * naming `milestone`; an unknown code is refused the same way.
 */
export function assertMilestonesInOrder(milestones: readonly MilestoneEntry[], reached: ReadonlyArray<{ code: string; on: string }>): void {
  const bySequence = new Map(milestones.map((one) => [one.code, one.sequence] as const));
  const known = reached.map((one) => {
    const sequence = bySequence.get(one.code);
    if (sequence === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'milestone');
    return { sequence, on: one.on };
  });
  known.sort((left, right) => left.sequence - right.sequence);
  for (let at = 1; at < known.length; at += 1) {
    if ((known[at] as { on: string }).on < (known[at - 1] as { on: string }).on) throw new DomainError('VALIDATION_FAILED', 422, 'milestone');
  }
}

// ---- the project types in the master catalogue -----------------------------------------------------------------------------------------------------

/** The entries of `PROJECT_TYPE` that the pack publishes, in the shape of the baseline. */
export function enterpriseProjectTypeEntries(): BaselineEntry[] {
  return PROJECT_TYPE_SEEDS.map((seed) => ({
    masterType: 'PROJECT_TYPE',
    businessKey: seed.params.master_key as string,
    label: seed.params.label as string,
    attributes: { kind: seed.params.kind },
    validFrom: '2026-01-01',
  }));
}

/** The signed pack; its id carries a short digest so a changed catalogue is a new pack, never a silent rewrite of the old one. */
export function enterpriseProjectTypePack(): ReturnType<typeof sealPack> {
  const entries = enterpriseProjectTypeEntries();
  return sealPack(`ENTERPRISE-PROJECT-TYPES-${sha256Hex(JSON.stringify(entries)).slice(0, 8)}`, entries);
}
