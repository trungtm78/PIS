import { isRuleType, masterTypeDefinition, ruleTypes, safePattern, validateMasterContent } from '../src/master-types';
import type { EntryRef, TypeLookup } from '../src/master-types';
import type { MasterContent } from '../src/master-store';

const content = (attributes: Record<string, unknown>, overrides: Partial<MasterContent> = {}): MasterContent => ({
  label: 'Entry',
  attributes,
  parentRecordId: null,
  validFrom: '2025-01-01',
  validUntil: null,
  legalBasis: null,
  ...overrides,
});

const entry = (masterType: string, businessKey: string, attributes: Record<string, unknown> = {}): EntryRef => ({ masterType, businessKey, attributes });

const CATALOGUE: EntryRef[] = [
  entry('FUND_SOURCE', 'NSTW-DTPT', { category: 'NSTW', relation: 'ADDITIVE' }),
  entry('FUND_SOURCE', 'CTMTQG-NTM', { category: 'CTMTQG', relation: 'SUBSET_OF' }),
  entry('PROJECT_GROUP', 'A', { rank: 2 }),
  entry('PROJECT_GROUP', 'B', { rank: 3 }),
  entry('PROJECT_GROUP', 'C', { rank: 4 }),
  entry('SECTOR', 'TRANSPORT'),
  entry('PROJECT_STAGE', 'PREPARATION', { sequence: 1 }),
  entry('PROJECT_STAGE', 'EXECUTION', { sequence: 2 }),
  entry('DECISION_TYPE', 'APPROVAL', { required_fields: ['number'] }),
];
const lookup: TypeLookup = { entry: (masterType, businessKey) => Promise.resolve(CATALOGUE.find((item) => item.masterType === masterType && item.businessKey === businessKey)) };

async function problem(masterType: string, businessKey: string, value: MasterContent, parent?: EntryRef): Promise<{ code: string; status: number; detail: string | undefined } | undefined> {
  try {
    await validateMasterContent({ masterType, businessKey, content: value, parent, lookup });
  } catch (error) {
    const e = error as { code: string; status: number; detail?: string };
    return { code: e.code, status: e.status, detail: e.detail };
  }
  return undefined;
}
const invalid = (field: string) => ({ code: 'VALIDATION_FAILED', status: 422, detail: field });
const NSTW = CATALOGUE[0] as EntryRef;

describe('the definitions of the catalogue types', () => {
  it('leaves a type without a definition free and knows the rule types', () => {
    expect(masterTypeDefinition('AREA')).toBeUndefined();
    expect(masterTypeDefinition('FUND_SOURCE')?.masterType).toBe('FUND_SOURCE');
    expect(ruleTypes().sort()).toEqual(['APPRAISAL_CRITERIA', 'NATIONAL_CODE_FORMAT', 'NATIONAL_CODE_REQUIRED', 'PROJECT_GROUP_THRESHOLDS']);
    expect(isRuleType('NATIONAL_CODE_REQUIRED')).toBe(true);
    expect(isRuleType('SECTOR')).toBe(false);
    return expect(problem('AREA', 'X', content({ anything: [1, 2] }))).resolves.toBeUndefined();
  });
});

describe('FUND_SOURCE (BR-MDM-06)', () => {
  const source = (attributes: Record<string, unknown>) => content({ category: 'NSTW', relation: 'ADDITIVE', ...attributes });

  it('accepts the sources the tree is made of', async () => {
    expect(await problem('FUND_SOURCE', 'NSTW', source({}))).toBeUndefined();
    expect(await problem('FUND_SOURCE', 'NSTW-DTPT', source({}), NSTW)).toBeUndefined();
    expect(await problem('FUND_SOURCE', 'ODA-WB', content({ category: 'ODA', relation: 'ADDITIVE', onlending: true }))).toBeUndefined();
    expect(await problem('FUND_SOURCE', 'CTMTQG-NTM', content({ category: 'CTMTQG', relation: 'SUBSET_OF' }), NSTW)).toBeUndefined();
  });

  it('refuses a national target programme that adds to its budget source (AC-ST-MDM-003-1)', async () => {
    expect(await problem('FUND_SOURCE', 'CTMTQG-NTM', content({ category: 'CTMTQG', relation: 'ADDITIVE' }), NSTW)).toEqual({ code: 'SUBSET_SOURCE_NOT_ADDITIVE', status: 422, detail: 'attributes.relation' });
  });

  it('wants a subset to sit inside a budget source of its own, never inside another subset', async () => {
    expect(await problem('FUND_SOURCE', 'CTMTQG-NTM', content({ category: 'CTMTQG', relation: 'SUBSET_OF' }))).toEqual(invalid('parent_record_id'));
    expect(await problem('FUND_SOURCE', 'CTMTQG-NTM', content({ category: 'CTMTQG', relation: 'SUBSET_OF' }), entry('FUND_SOURCE', 'CTMTQG-X', { category: 'CTMTQG', relation: 'SUBSET_OF' }))).toEqual(invalid('parent_record_id'));
    expect(await problem('FUND_SOURCE', 'CTMTQG-NTM', content({ category: 'CTMTQG', relation: 'SUBSET_OF' }), entry('FUND_SOURCE', 'ODA-WB', { category: 'ODA', relation: 'ADDITIVE', onlending: false }))).toEqual(invalid('parent_record_id'));
    expect(await problem('FUND_SOURCE', 'X', source({ category: 'OTHER', relation: 'SUBSET_OF' }), NSTW)).toBeUndefined();
  });

  it('keeps ODA additive and says whether it is on-lent, and nothing else is on-lent', async () => {
    expect(await problem('FUND_SOURCE', 'ODA-WB', content({ category: 'ODA', relation: 'SUBSET_OF', onlending: true }), NSTW)).toEqual(invalid('attributes.relation'));
    expect(await problem('FUND_SOURCE', 'ODA-WB', content({ category: 'ODA', relation: 'ADDITIVE' }))).toEqual(invalid('attributes.onlending'));
    expect(await problem('FUND_SOURCE', 'NSTW', source({ onlending: false }))).toEqual(invalid('attributes.onlending'));
  });

  it('names the attribute that is missing or not one of the allowed values', async () => {
    expect(await problem('FUND_SOURCE', 'X', content({ relation: 'ADDITIVE' }))).toEqual(invalid('attributes.category'));
    expect(await problem('FUND_SOURCE', 'X', content({ category: 'NSTW' }))).toEqual(invalid('attributes.relation'));
    expect(await problem('FUND_SOURCE', 'X', source({ category: 'LOTTERY' }))).toEqual(invalid('attributes.category'));
    expect(await problem('FUND_SOURCE', 'X', source({ relation: 1 }))).toEqual(invalid('attributes.relation'));
  });
});

describe('PROGRAM', () => {
  const programme = (attributes: Record<string, unknown>) => content({ kind: 'LOCAL', period_from: 2021, period_to: 2025, ...attributes });

  it('takes a period and a kind, and a national target programme names its source', async () => {
    expect(await problem('PROGRAM', 'P1', programme({}))).toBeUndefined();
    expect(await problem('PROGRAM', 'NTM', programme({ kind: 'CTMTQG', fund_source_key: 'CTMTQG-NTM' }))).toBeUndefined();
    expect(await problem('PROGRAM', 'NTM', programme({ kind: 'CTMTQG' }))).toEqual(invalid('attributes.fund_source_key'));
    expect(await problem('PROGRAM', 'NTM', programme({ kind: 'CTMTQG', fund_source_key: 'NSTW-DTPT' }))).toEqual(invalid('attributes.fund_source_key'));
    expect(await problem('PROGRAM', 'P1', programme({ fund_source_key: 'UNKNOWN' }))).toEqual(invalid('attributes.fund_source_key'));
  });

  it('refuses a period that ends before it starts, and a year that is not one', async () => {
    expect(await problem('PROGRAM', 'P1', programme({ period_to: 2020 }))).toEqual(invalid('attributes.period_to'));
    expect(await problem('PROGRAM', 'P1', programme({ period_from: 1850 }))).toEqual(invalid('attributes.period_from'));
    expect(await problem('PROGRAM', 'P1', programme({ period_from: 2021.5 }))).toEqual(invalid('attributes.period_from'));
    expect(await problem('PROGRAM', 'P1', programme({ kind: 'OTHER' }))).toEqual(invalid('attributes.kind'));
  });
});

describe('the stages, the project groups and types, the decisions', () => {
  it('checks the stage graph: known stages, none that points at itself, none after a terminal stage', async () => {
    expect(await problem('PROJECT_STAGE', 'PREPARATION', content({ sequence: 1, allowed_next: ['EXECUTION'] }))).toBeUndefined();
    expect(await problem('PROJECT_STAGE', 'PREPARATION', content({ sequence: 1, allowed_next: ['PREPARATION'] }))).toEqual(invalid('attributes.allowed_next'));
    expect(await problem('PROJECT_STAGE', 'PREPARATION', content({ sequence: 1, allowed_next: ['NOWHERE'] }))).toEqual(invalid('attributes.allowed_next'));
    expect(await problem('PROJECT_STAGE', 'PREPARATION', content({ sequence: 1, allowed_next: ['EXECUTION', 'EXECUTION'] }))).toEqual(invalid('attributes.allowed_next'));
    expect(await problem('PROJECT_STAGE', 'CLOSED', content({ sequence: 9, terminal: true, allowed_next: ['EXECUTION'] }))).toEqual(invalid('attributes.allowed_next'));
    expect(await problem('PROJECT_STAGE', 'CLOSED', content({ sequence: 9, terminal: true }))).toBeUndefined();
    expect(await problem('PROJECT_STAGE', 'CLOSED', content({ terminal: true }))).toEqual(invalid('attributes.sequence'));
    expect(await problem('PROJECT_STAGE', 'CLOSED', content({ sequence: 0 }))).toEqual(invalid('attributes.sequence'));
  });

  it('wants a rank for a project group and keeps the kind of a project type to the known ones', async () => {
    expect(await problem('PROJECT_GROUP', 'A', content({ rank: 2 }))).toBeUndefined();
    expect(await problem('PROJECT_GROUP', 'A', content({}))).toEqual(invalid('attributes.rank'));
    expect(await problem('PROJECT_GROUP', 'A', content({ rank: 11 }))).toEqual(invalid('attributes.rank'));
    expect(await problem('PROJECT_TYPE', 'NEW', content({ kind: 'CAPITAL_WORKS' }))).toBeUndefined();
    expect(await problem('PROJECT_TYPE', 'NEW', content({}))).toBeUndefined();
    expect(await problem('PROJECT_TYPE', 'NEW', content({ kind: 'MAGIC' }))).toEqual(invalid('attributes.kind'));
    expect(await problem('SECTOR', 'T', content({ sort_order: -1 }))).toEqual(invalid('attributes.sort_order'));
    expect(await problem('SECTOR', 'T', content({ sort_order: 3, group: 'infrastructure' }))).toBeUndefined();
  });

  it('lists the fields that a decision type requires as identifiers, and ties an authority to a decision type', async () => {
    expect(await problem('DECISION_TYPE', 'APPROVAL', content({ required_fields: ['number', 'issued_on'], template: 'TPL-APPROVAL' }))).toBeUndefined();
    expect(await problem('DECISION_TYPE', 'APPROVAL', content({}))).toEqual(invalid('attributes.required_fields'));
    expect(await problem('DECISION_TYPE', 'APPROVAL', content({ required_fields: ['Number'] }))).toEqual(invalid('attributes.required_fields'));
    expect(await problem('DECISION_TYPE', 'APPROVAL', content({ required_fields: ['a', 'a'] }))).toEqual(invalid('attributes.required_fields'));
    expect(await problem('DECISION_AUTHORITY', 'PM-APPROVAL', content({ agency_key: 'PM', decision_type_key: 'APPROVAL', scope: 'NATIONAL' }))).toBeUndefined();
    expect(await problem('DECISION_AUTHORITY', 'PM-APPROVAL', content({ agency_key: 'PM', decision_type_key: 'UNKNOWN', scope: 'NATIONAL' }))).toEqual(invalid('attributes.decision_type_key'));
    expect(await problem('DECISION_AUTHORITY', 'PM-APPROVAL', content({ agency_key: 'PM', decision_type_key: 'APPROVAL', scope: 'GALAXY' }))).toEqual(invalid('attributes.scope'));
    expect(await problem('DECISION_AUTHORITY', 'PM-APPROVAL', content({ agency_key: ' ', decision_type_key: 'APPROVAL', scope: 'NATIONAL' }))).toEqual(invalid('attributes.agency_key'));
  });
});

describe('rule data (BR-MDM-09)', () => {
  const rule = (attributes: Record<string, unknown>, legalBasis: string | null = 'Law 58/2024/QH15') =>
    content({ owner_module: 'PRJ', ...attributes }, { legalBasis });
  const band = (sector: string | null, group: string, min: string, max: string | null) => ({ sector_key: sector, group_key: group, min_amount: min, max_amount: max });
  const THRESHOLDS = [band(null, 'C', '0', '120000000000'), band(null, 'B', '120000000000', '1000000000000'), band(null, 'A', '1000000000000', null)];

  it('carries its legal basis, its owner module and the confirmation it waits for', async () => {
    const required = { mode: 'BLOCK', from_stage_key: 'EXECUTION' };
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule(required))).toBeUndefined();
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule(required, null))).toEqual(invalid('legal_basis'));
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule(required, '  '))).toEqual(invalid('legal_basis'));
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule({ ...required, owner_module: undefined }))).toEqual(invalid('attributes.owner_module'));
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule({ ...required, owner_module: 'XYZ' }))).toEqual(invalid('attributes.owner_module'));
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule({ ...required, awaiting_confirmation: true }))).toEqual(invalid('attributes.cxn'));
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule({ ...required, awaiting_confirmation: true, cxn: 'CXN-01' }))).toBeUndefined();
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule({ ...required, cxn: 'see CXN-01' }))).toEqual(invalid('attributes.cxn'));
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule({ ...required, mode: 'MAYBE' }))).toEqual(invalid('attributes.mode'));
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule({ ...required, from_stage_key: 'NOWHERE' }))).toEqual(invalid('attributes.from_stage_key'));
  });

  it('takes nothing that the rule does not define', async () => {
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule({ mode: 'BLOCK', from_stage_key: 'EXECUTION', exception: 'always' }))).toEqual(invalid('attributes.exception'));
  });

  it('accepts a threshold table that covers every amount once, and refuses gaps, overlaps and open tops', async () => {
    expect(await problem('PROJECT_GROUP_THRESHOLDS', 'DEFAULT', rule({ bands: THRESHOLDS }))).toBeUndefined();
    expect(await problem('PROJECT_GROUP_THRESHOLDS', 'DEFAULT', rule({ bands: [...THRESHOLDS, band('TRANSPORT', 'C', '0', '60000000000'), band('TRANSPORT', 'B', '60000000000', null)] }))).toBeUndefined();
    const broken = (bands: unknown) => problem('PROJECT_GROUP_THRESHOLDS', 'DEFAULT', rule({ bands }));
    expect(await broken([band(null, 'C', '1', '100'), band(null, 'B', '100', null)])).toEqual(invalid('attributes.bands'));
    expect(await broken([band(null, 'C', '0', '100'), band(null, 'B', '101', null)])).toEqual(invalid('attributes.bands'));
    expect(await broken([band(null, 'C', '0', '100'), band(null, 'B', '50', null)])).toEqual(invalid('attributes.bands'));
    expect(await broken([band(null, 'C', '0', '100'), band(null, 'B', '100', '500')])).toEqual(invalid('attributes.bands'));
    expect(await broken([band('TRANSPORT', 'C', '0', null)])).toEqual(invalid('attributes.bands'));
    expect(await broken([band(null, 'C', '0', '0')])).toEqual(invalid('attributes.bands'));
    expect(await broken([band(null, 'C', '0', null), band(null, 'B', '5', null)])).toEqual(invalid('attributes.bands'));
    expect(await broken([band(null, 'Z', '0', null)])).toEqual(invalid('attributes.bands'));
    expect(await broken([band(null, 'C', '0', '100'), band('MARS', 'B', '0', null), band(null, 'B', '100', null)])).toEqual(invalid('attributes.bands'));
    expect(await broken([band(null, 'C', '0.001', null)])).toEqual(invalid('attributes.bands'));
    expect(await broken([band(null, 'C', '-1', null)])).toEqual(invalid('attributes.bands'));
    expect(await broken([{ sector_key: null, group_key: 'C', min_amount: 0, max_amount: null }])).toEqual(invalid('attributes.bands'));
    expect(await broken([])).toEqual(invalid('attributes.bands'));
    expect(await broken(['x'])).toEqual(invalid('attributes.bands'));
    expect(await broken({})).toEqual(invalid('attributes.bands'));
  });

  it('compares the edges of the bands as exact amounts, cents included', async () => {
    expect(await problem('PROJECT_GROUP_THRESHOLDS', 'DEFAULT', rule({ bands: [band(null, 'C', '0', '100.5'), band(null, 'B', '100.50', null)] }))).toBeUndefined();
    expect(await problem('PROJECT_GROUP_THRESHOLDS', 'DEFAULT', rule({ bands: [band(null, 'C', '0', '100.5'), band(null, 'B', '100.51', null)] }))).toEqual(invalid('attributes.bands'));
  });

  it('wants a format that is a pattern and an example that matches it', async () => {
    expect(await problem('NATIONAL_CODE_FORMAT', 'DEFAULT', rule({ pattern: '^\\d{7}$', example: '7654321' }))).toBeUndefined();
    expect(await problem('NATIONAL_CODE_FORMAT', 'DEFAULT', rule({ pattern: '^\\d{7}$', example: 'abc' }))).toEqual(invalid('attributes.example'));
    expect(await problem('NATIONAL_CODE_FORMAT', 'DEFAULT', rule({ pattern: '(', example: '1' }))).toEqual(invalid('attributes.pattern'));
    expect(await problem('NATIONAL_CODE_FORMAT', 'DEFAULT', rule({ pattern: 'x'.repeat(201), example: 'x' }))).toEqual(invalid('attributes.pattern'));
    expect(await problem('NATIONAL_CODE_FORMAT', 'DEFAULT', rule({ pattern: '^a$', example: 'a'.repeat(65) }))).toEqual(invalid('attributes.example'));
  });

  it('takes a code format only from the safe subset: anchored, bounded atoms, no group, alternation, star or plus', async () => {
    const format = (pattern: string, example: string) => problem('NATIONAL_CODE_FORMAT', 'DEFAULT', rule({ pattern, example }));
    expect(await format('^[A-Z]{2}-\\d{4,6}$', 'VN-12345')).toBeUndefined();
    expect(await format('^a?a?a?a?$', 'aa')).toBeUndefined();
    for (const unsafe of ['^(a+)+$', '^a*$', '^a+$', '^a|b$', '^(a)$', '^\\d{7}', '\\d{7}$', '^$', '^a{3,2}$', '^a{99}$', '^[^a]$', '^a?a?a?a?a?$', '^\\1$', `^${'a'.repeat(41)}$`]) {
      expect(await format(unsafe, 'a')).toEqual(invalid('attributes.pattern'));
    }
    // The classic exponential pattern is refused before it is ever run.
    const started = Date.now();
    expect(await format('^(a+)+$', `${'a'.repeat(63)}!`)).toEqual(invalid('attributes.pattern'));
    expect(Date.now() - started).toBeLessThan(200);
    expect(safePattern('^\\d{7}$')?.test('7654321')).toBe(true);
    expect(safePattern('^\\d{7}$')?.test('765432')).toBe(false);
  });

  it('does not take a null where a confirmation reference is due', async () => {
    const required = { mode: 'BLOCK', from_stage_key: 'EXECUTION', awaiting_confirmation: true };
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule({ ...required, cxn: null }))).toEqual(invalid('attributes.cxn'));
    expect(await problem('NATIONAL_CODE_REQUIRED', 'DEFAULT', rule({ ...required, cxn: 7 }))).toEqual(invalid('attributes.cxn'));
  });

  it('wants criteria that add up to 100 points and a pass threshold inside them', async () => {
    const criteria = [{ code: 'RELEVANCE', name: 'Relevance', max_score: 40 }, { code: 'FEASIBILITY', name: 'Feasibility', max_score: 60 }];
    expect(await problem('APPRAISAL_CRITERIA', 'APPR-CRIT-2026r1', rule({ criteria, pass_threshold: 60 }))).toBeUndefined();
    expect(await problem('APPRAISAL_CRITERIA', 'APPR-CRIT-2026r1', rule({ criteria, pass_threshold: 101 }))).toEqual(invalid('attributes.pass_threshold'));
    expect(await problem('APPRAISAL_CRITERIA', 'APPR-CRIT-2026r1', rule({ criteria: [criteria[0]], pass_threshold: 60 }))).toEqual(invalid('attributes.criteria'));
    expect(await problem('APPRAISAL_CRITERIA', 'APPR-CRIT-2026r1', rule({ criteria: [criteria[0], { ...criteria[0] }, criteria[1]], pass_threshold: 60 }))).toEqual(invalid('attributes.criteria'));
    expect(await problem('APPRAISAL_CRITERIA', 'APPR-CRIT-2026r1', rule({ criteria: [{ code: 'A', name: ' ', max_score: 100 }], pass_threshold: 60 }))).toEqual(invalid('attributes.criteria'));
    expect(await problem('APPRAISAL_CRITERIA', 'APPR-CRIT-2026r1', rule({ criteria: [{ code: 'A', name: 'A', max_score: 1.5 }], pass_threshold: 60 }))).toEqual(invalid('attributes.criteria'));
    expect(await problem('APPRAISAL_CRITERIA', 'APPR-CRIT-2026r1', rule({ criteria: ['x'], pass_threshold: 60 }))).toEqual(invalid('attributes.criteria'));
    expect(await problem('APPRAISAL_CRITERIA', 'APPR-CRIT-2026r1', rule({ criteria: [], pass_threshold: 60 }))).toEqual(invalid('attributes.criteria'));
    expect(await problem('APPRAISAL_CRITERIA', 'APPR-CRIT-2026r1', rule({ criteria, pass_threshold: 0 }))).toEqual(invalid('attributes.pass_threshold'));
  });
});
