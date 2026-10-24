import { DomainError } from '@machvon/kernel';
import type { MasterContent } from './master-store.ts';
import type { TenantTx } from './tenant-database.ts';

/** An entry of the catalogue that another entry refers to: the attributes of its latest version. */
export interface EntryRef {
  masterType: string;
  businessKey: string;
  attributes: Record<string, unknown>;
}

/** Looks entries up by type and key; entries that are retired do not count, entries still waiting for their publication do. */
export interface TypeLookup {
  entry(masterType: string, businessKey: string): Promise<EntryRef | undefined>;
}

export interface TypeInput {
  masterType: string;
  businessKey: string;
  content: MasterContent;
  /** The entry that `content.parentRecordId` names, when it names one. */
  parent: EntryRef | undefined;
  lookup: TypeLookup;
}

type Field =
  | { name: string; kind: 'text'; required?: boolean; maxLength: number; pattern?: RegExp }
  | { name: string; kind: 'integer'; required?: boolean; min: number; max: number }
  | { name: string; kind: 'boolean'; required?: boolean }
  | { name: string; kind: 'choice'; required?: boolean; choices: readonly string[] }
  | { name: string; kind: 'identifiers'; required?: boolean; maxItems: number }
  /** A list of structured values: the rule of the type checks what is in it, here it only has to be a list. */
  | { name: string; kind: 'list'; required?: boolean; maxItems: number }
  | { name: string; kind: 'key'; required?: boolean; refType: string }
  | { name: string; kind: 'keys'; required?: boolean; refType: string; maxItems: number };

export interface MasterTypeDefinition {
  masterType: string;
  fields: readonly Field[];
  /** Attributes that are not listed are refused (rule data drives decisions, so it takes nothing it does not define). */
  strict?: boolean;
  /** Rule data (BR-MDM-09): it carries the legal basis and the module that owns it, and is approved by that module's owner. */
  rule?: boolean;
  check?: (input: TypeInput) => Promise<void> | void;
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
/** A confirmation that a rule waits for: a number of the register of confirmations, or a named working assumption that has none yet. */
const CXN = /^(CXN-\d{1,4}|ASSUMPTION-[A-Z0-9-]{1,30})$/;
const AMOUNT = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A format pattern is only ever run against a string of at most this many characters, which bounds what a careless pattern can cost. */
export const NATIONAL_CODE_SAMPLE_LIMIT = 64;

const fail = (field: string): never => {
  throw new DomainError('VALIDATION_FAILED', 422, field);
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max;

export const FUND_CATEGORIES = ['NSTW', 'NSDP', 'ODA', 'CTMTQG', 'OTHER'] as const;
export const FUND_RELATIONS = ['ADDITIVE', 'SUBSET_OF'] as const;
export const PROGRAM_KINDS = ['CTMTQG', 'NATIONAL_TARGET', 'SECTORAL', 'LOCAL'] as const;
export const PROJECT_TYPE_KINDS = ['CAPITAL_WORKS', 'PROCUREMENT', 'PREPARATION', 'OTHER'] as const;
export const AUTHORITY_SCOPES = ['NATIONAL', 'MINISTRY', 'PROVINCE', 'COMMUNE'] as const;
export const RULE_OWNER_MODULES = ['PRJ', 'CAP', 'DIS', 'PAY', 'CTR', 'MNE'] as const;
export const NATIONAL_CODE_MODES = ['BLOCK', 'WARN'] as const;

const RULE_FIELDS: readonly Field[] = [
  { name: 'owner_module', kind: 'choice', required: true, choices: RULE_OWNER_MODULES },
  { name: 'awaiting_confirmation', kind: 'boolean' },
  { name: 'cxn', kind: 'text', maxLength: 40, pattern: CXN },
];

/** Cents of a decimal string such as "2300000000000.50"; amounts are strings so that no float ever touches a threshold. */
function cents(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function checkBands(bands: unknown): { sectorKey: string | null; groupKey: string }[] {
  if (!Array.isArray(bands) || bands.length === 0 || bands.length > 200) return fail('attributes.bands');
  const parsed = bands.map((band) => {
    if (!isObject(band)) return fail('attributes.bands');
    const { sector_key: sector, group_key: group, min_amount: min, max_amount: max } = band;
    if (sector !== null && !(typeof sector === 'string' && KEY.test(sector))) return fail('attributes.bands');
    if (typeof group !== 'string' || !KEY.test(group)) return fail('attributes.bands');
    if (typeof min !== 'string' || !AMOUNT.test(min) || (max !== null && !(typeof max === 'string' && AMOUNT.test(max)))) return fail('attributes.bands');
    const low = cents(min);
    const high = max === null ? null : cents(max as string);
    if (high !== null && high <= low) return fail('attributes.bands');
    return { sectorKey: sector as string | null, groupKey: group, low, high };
  });
  // The bands of one sector (and of the default, which has no sector) cover every amount once: from zero, edge to edge, open at the top.
  const bySector = new Map<string, typeof parsed>();
  for (const band of parsed) bySector.set(band.sectorKey ?? '', [...(bySector.get(band.sectorKey ?? '') ?? []), band]);
  if (!bySector.has('')) return fail('attributes.bands');
  for (const list of bySector.values()) {
    const sorted = [...list].sort((left, right) => (left.low < right.low ? -1 : left.low > right.low ? 1 : 0));
    if (sorted[0]?.low !== 0n) return fail('attributes.bands');
    sorted.forEach((band, index) => {
      const next = sorted[index + 1];
      if (next === undefined ? band.high !== null : band.high !== next.low) fail('attributes.bands');
    });
  }
  return parsed;
}

function checkCriteria(criteria: unknown, threshold: unknown): void {
  if (!Array.isArray(criteria) || criteria.length === 0 || criteria.length > 50) return fail('attributes.criteria');
  const codes = new Set<string>();
  let total = 0;
  for (const criterion of criteria) {
    if (!isObject(criterion)) return fail('attributes.criteria');
    const { code, name, max_score: score } = criterion;
    if (typeof code !== 'string' || !KEY.test(code) || codes.has(code) || !text(name, 200)) return fail('attributes.criteria');
    if (!Number.isInteger(score) || (score as number) < 1 || (score as number) > 100) return fail('attributes.criteria');
    codes.add(code);
    total += score as number;
  }
  // The scores add up to the 100 points that the pass threshold is a part of.
  if (total !== 100) fail('attributes.criteria');
  if (!Number.isInteger(threshold) || (threshold as number) < 1 || (threshold as number) > 100) fail('attributes.pass_threshold');
}

const DEFINITIONS: readonly MasterTypeDefinition[] = [
  {
    masterType: 'FUND_SOURCE',
    fields: [
      { name: 'category', kind: 'choice', required: true, choices: FUND_CATEGORIES },
      { name: 'relation', kind: 'choice', required: true, choices: FUND_RELATIONS },
      { name: 'onlending', kind: 'boolean' },
    ],
    check: ({ content, parent }) => {
      const { category, relation, onlending } = content.attributes;
      // BR-MDM-06: a national target programme is always a part of a budget source, never a source that adds to it.
      if (category === 'CTMTQG' && relation !== 'SUBSET_OF') throw new DomainError('SUBSET_SOURCE_NOT_ADDITIVE', 422, 'attributes.relation');
      if (category === 'ODA') {
        if (relation !== 'ADDITIVE') fail('attributes.relation');
        if (typeof onlending !== 'boolean') fail('attributes.onlending');
      } else if (onlending !== undefined) {
        fail('attributes.onlending');
      }
      if (relation === 'SUBSET_OF') {
        // A part is counted inside the whole it belongs to: the whole is itself a source of its own, never another part.
        if (parent === undefined || parent.attributes.relation === 'SUBSET_OF') fail('parent_record_id');
        if (category === 'CTMTQG' && parent?.attributes.category !== 'NSTW' && parent?.attributes.category !== 'NSDP') fail('parent_record_id');
      }
    },
  },
  {
    masterType: 'PROGRAM',
    fields: [
      { name: 'kind', kind: 'choice', required: true, choices: PROGRAM_KINDS },
      { name: 'period_from', kind: 'integer', required: true, min: 2000, max: 2100 },
      { name: 'period_to', kind: 'integer', required: true, min: 2000, max: 2100 },
      { name: 'fund_source_key', kind: 'key', refType: 'FUND_SOURCE' },
    ],
    check: async ({ content, lookup }) => {
      const { kind, period_from: from, period_to: to, fund_source_key: source } = content.attributes;
      if ((to as number) < (from as number)) fail('attributes.period_to');
      if (kind === 'CTMTQG') {
        if (typeof source !== 'string') fail('attributes.fund_source_key');
        const found = await lookup.entry('FUND_SOURCE', source as string);
        if (found?.attributes.category !== 'CTMTQG') fail('attributes.fund_source_key');
      }
    },
  },
  { masterType: 'SECTOR', fields: [{ name: 'sort_order', kind: 'integer', min: 0, max: 100000 }] },
  { masterType: 'PROJECT_GROUP', fields: [{ name: 'rank', kind: 'integer', required: true, min: 1, max: 10 }] },
  { masterType: 'PROJECT_TYPE', fields: [{ name: 'kind', kind: 'choice', choices: PROJECT_TYPE_KINDS }] },
  {
    masterType: 'PROJECT_STAGE',
    fields: [
      { name: 'sequence', kind: 'integer', required: true, min: 1, max: 100 },
      { name: 'allowed_next', kind: 'keys', refType: 'PROJECT_STAGE', maxItems: 20 },
      { name: 'terminal', kind: 'boolean' },
    ],
    check: ({ content }) => {
      const next = content.attributes.allowed_next;
      if (content.attributes.terminal === true && Array.isArray(next) && next.length > 0) fail('attributes.allowed_next');
    },
  },
  {
    masterType: 'DECISION_TYPE',
    fields: [
      { name: 'required_fields', kind: 'identifiers', required: true, maxItems: 30 },
      { name: 'template', kind: 'text', maxLength: 100 },
    ],
  },
  {
    masterType: 'DECISION_AUTHORITY',
    fields: [
      { name: 'agency_key', kind: 'text', required: true, maxLength: 100 },
      { name: 'decision_type_key', kind: 'key', required: true, refType: 'DECISION_TYPE' },
      { name: 'scope', kind: 'choice', required: true, choices: AUTHORITY_SCOPES },
    ],
  },
  {
    masterType: 'PROJECT_GROUP_THRESHOLDS',
    rule: true,
    strict: true,
    fields: [...RULE_FIELDS, { name: 'bands', kind: 'list', required: true, maxItems: 200 }],
    check: async ({ content, lookup }) => {
      const bands = checkBands(content.attributes.bands);
      for (const band of bands) {
        if ((await lookup.entry('PROJECT_GROUP', band.groupKey)) === undefined) fail('attributes.bands');
        if (band.sectorKey !== null && (await lookup.entry('SECTOR', band.sectorKey)) === undefined) fail('attributes.bands');
      }
    },
  },
  {
    masterType: 'NATIONAL_CODE_REQUIRED',
    rule: true,
    strict: true,
    fields: [...RULE_FIELDS, { name: 'mode', kind: 'choice', required: true, choices: NATIONAL_CODE_MODES }, { name: 'from_stage_key', kind: 'key', required: true, refType: 'PROJECT_STAGE' }],
  },
  {
    masterType: 'NATIONAL_CODE_FORMAT',
    rule: true,
    strict: true,
    fields: [...RULE_FIELDS, { name: 'pattern', kind: 'text', required: true, maxLength: 200 }, { name: 'example', kind: 'text', required: true, maxLength: NATIONAL_CODE_SAMPLE_LIMIT }],
    check: ({ content }) => {
      const { pattern, example } = content.attributes as { pattern: string; example: string };
      let expression: RegExp;
      try {
        expression = new RegExp(pattern);
      } catch {
        return fail('attributes.pattern');
      }
      if (!expression.test(example)) fail('attributes.example');
    },
  },
  {
    masterType: 'APPRAISAL_CRITERIA',
    rule: true,
    strict: true,
    fields: [...RULE_FIELDS, { name: 'criteria', kind: 'list', required: true, maxItems: 50 }, { name: 'pass_threshold', kind: 'integer', required: true, min: 1, max: 100 }],
    check: ({ content }) => checkCriteria(content.attributes.criteria, content.attributes.pass_threshold),
  },
];

/** The entries of the tenant by type and key, read from the database inside the transaction of the command. */
export function tenantLookup(tx: TenantTx): TypeLookup {
  return {
    entry: async (masterType, businessKey) => {
      const rows = await tx.query<{ attributes: Record<string, unknown> }>(
        `select v.attributes from machvon.master_record r
           join lateral (select x.attributes from machvon.master_record_version x where x.master_record_id = r.id order by x.revision desc limit 1) v on true
          where r.master_type = $1 and r.business_key = $2 and r.status not in ('RETIRED', 'MERGED')
          order by case r.namespace when 'PLATFORM' then 0 else 1 end limit 1`,
        [masterType, businessKey],
      );
      return rows[0] === undefined ? undefined : { masterType, businessKey, attributes: rows[0].attributes };
    },
  };
}

/** The entry that a record id names, with the attributes of its latest version. */
export async function entryOfRecord(tx: TenantTx, recordId: string): Promise<EntryRef | undefined> {
  const rows = await tx.query<{ master_type: string; business_key: string; attributes: Record<string, unknown> }>(
    `select r.master_type, r.business_key, v.attributes from machvon.master_record r
       join lateral (select x.attributes from machvon.master_record_version x where x.master_record_id = r.id order by x.revision desc limit 1) v on true
      where r.id = $1::uuid`,
    [recordId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { masterType: row.master_type, businessKey: row.business_key, attributes: row.attributes };
}

const BY_TYPE: ReadonlyMap<string, MasterTypeDefinition> = new Map(DEFINITIONS.map((definition) => [definition.masterType, definition]));

export const masterTypeDefinition = (masterType: string): MasterTypeDefinition | undefined => BY_TYPE.get(masterType);
export const isRuleType = (masterType: string): boolean => BY_TYPE.get(masterType)?.rule === true;
export const ruleTypes = (): string[] => DEFINITIONS.filter((definition) => definition.rule === true).map((definition) => definition.masterType);

async function checkField(field: Field, value: unknown, input: TypeInput): Promise<void> {
  const name = `attributes.${field.name}`;
  switch (field.kind) {
    case 'text':
      if (!text(value, field.maxLength) || (field.pattern !== undefined && !field.pattern.test(value))) fail(name);
      return;
    case 'integer':
      if (!Number.isInteger(value) || (value as number) < field.min || (value as number) > field.max) fail(name);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail(name);
      return;
    case 'choice':
      if (typeof value !== 'string' || !field.choices.includes(value)) fail(name);
      return;
    case 'list':
      if (!Array.isArray(value) || value.length > field.maxItems) fail(name);
      return;
    case 'identifiers':
      if (!Array.isArray(value) || value.length > field.maxItems || new Set(value).size !== value.length || !value.every((item) => typeof item === 'string' && IDENTIFIER.test(item))) fail(name);
      return;
    case 'key':
      if (typeof value !== 'string' || !KEY.test(value) || (await input.lookup.entry(field.refType, value)) === undefined) fail(name);
      return;
    case 'keys': {
      if (!Array.isArray(value) || value.length > field.maxItems || new Set(value).size !== value.length) return fail(name);
      for (const item of value) {
        if (typeof item !== 'string' || !KEY.test(item) || item === input.businessKey || (await input.lookup.entry(field.refType, item)) === undefined) fail(name);
      }
    }
  }
}

/**
 * The rules of a catalogue type that no table can state: which attributes an entry carries, which entries it refers to, and the
 * relations between them (a national target programme is a subset of its budget source). Types without a definition are free.
 * Every failure is 422 naming the field, except the one the contract names (`SUBSET_SOURCE_NOT_ADDITIVE`).
 */
export async function validateMasterContent(input: TypeInput): Promise<void> {
  const definition = BY_TYPE.get(input.masterType);
  if (definition === undefined) return;
  const { attributes, legalBasis } = input.content;
  if (definition.rule === true) {
    // BR-MDM-09: a rule without its legal basis, or one that waits for a confirmation without saying which, is not a rule.
    if (legalBasis === null || legalBasis.trim() === '') fail('legal_basis');
    if (attributes.awaiting_confirmation === true && attributes.cxn === undefined) fail('attributes.cxn');
  }
  const known = new Set(definition.fields.map((field) => field.name));
  if (definition.strict === true) {
    for (const name of Object.keys(attributes)) if (!known.has(name)) fail(`attributes.${name}`);
  }
  for (const field of definition.fields) {
    const value = attributes[field.name];
    if (value === undefined || value === null) {
      if (field.required === true) fail(`attributes.${field.name}`);
      continue;
    }
    await checkField(field, value, input);
  }
  await definition.check?.(input);
}
