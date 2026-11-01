import { attributeKey, checkSurvivorshipRule, mergeRecords, unmergeSurvivor } from '../src/master-merge.ts';
import type { AttributeDecision, MergeRecord, SurvivorshipRuleInput } from '../src/master-merge.ts';

const record = (over: Partial<MergeRecord> = {}): MergeRecord => ({ label: 'Contractor A', attributes: {}, sourceSystem: 'TENANT', recordedAt: '2026-01-01T00:00:00Z', ...over });
const rules = (entries: Array<[string, SurvivorshipRuleInput]> = []): Map<string, SurvivorshipRuleInput> => new Map(entries);
const priority = (...sources: string[]): SurvivorshipRuleInput => ({ strategy: 'SOURCE_PRIORITY', sourcePriority: sources });
const thrown = (run: () => unknown): { code: string; status: number; detail?: string; extensions?: Record<string, unknown> } => {
  try {
    run();
  } catch (error) {
    return error as never;
  }
  throw new Error('nothing was thrown');
};

describe('the merge of two master records by the survivorship rules (ST-MDM-010, BR-MDM-05, UAT-AC274)', () => {
  it('takes what only one record has and what both have alike without a rule', () => {
    const result = mergeRecords(record({ attributes: { tax_code: '0101', phone: '024-1', fax: null } }), record({ attributes: { tax_code: '0101', address: 'Cao Bang', fax: '' } }), rules(), {});
    expect(result.attributes).toEqual({ tax_code: '0101', phone: '024-1', address: 'Cao Bang' });
    expect(result.label).toBe('Contractor A');
    expect(Object.fromEntries(result.decisions.map((decision) => [decision.attribute, [decision.chosen, decision.by]]))).toEqual({
      address: ['MERGED', 'ONLY_ONE'],
      label: ['SURVIVOR', 'EQUAL'],
      phone: ['SURVIVOR', 'ONLY_ONE'],
      tax_code: ['SURVIVOR', 'EQUAL'],
    });
  });

  it('follows the order of the sources for an attribute they disagree on: NATIONAL before TREASURY before TENANT (UAT-AC274)', () => {
    const survivor = record({ attributes: { phone: '111' }, sourceSystem: 'TENANT' });
    const merged = record({ attributes: { phone: '222' }, sourceSystem: 'NATIONAL' });
    const order = rules([['phone', priority('NATIONAL', 'TREASURY', 'TENANT')]]);
    const result = mergeRecords(survivor, merged, order, {});
    expect(result.attributes.phone).toBe('222');
    expect(result.decisions.find((decision) => decision.attribute === 'phone')).toMatchObject({ chosen: 'MERGED', by: 'RULE', strategy: 'SOURCE_PRIORITY', source: 'NATIONAL', value: '222' });
    // The other way round the survivor keeps its own.
    expect(mergeRecords(merged, survivor, order, {}).attributes.phone).toBe('222');
    expect(mergeRecords(record({ attributes: { phone: '111' }, sourceSystem: 'NATIONAL' }), record({ attributes: { phone: '222' }, sourceSystem: 'TREASURY' }), order, {}).attributes.phone).toBe(
      '111',
    );
  });

  it('takes the later record for MOST_RECENT, and the one with fewer empty attributes for MOST_COMPLETE with a tie going to the order of the sources', () => {
    const recent: [string, SurvivorshipRuleInput] = ['address', { strategy: 'MOST_RECENT', sourcePriority: [] }];
    const older = record({ attributes: { address: 'old' }, recordedAt: '2026-01-01T00:00:00Z' });
    const newer = record({ attributes: { address: 'new' }, recordedAt: '2026-06-01T00:00:00Z' });
    expect(mergeRecords(older, newer, rules([recent]), {}).attributes.address).toBe('new');
    expect(mergeRecords(newer, older, rules([recent]), {}).attributes.address).toBe('new');
    const complete: [string, SurvivorshipRuleInput] = ['address', { strategy: 'MOST_COMPLETE', sourcePriority: ['NATIONAL', 'TENANT'] }];
    const full = record({ attributes: { address: 'full', phone: '1', email: 'a@b' }, sourceSystem: 'TENANT' });
    const sparse = record({ attributes: { address: 'sparse', phone: '', email: null }, sourceSystem: 'NATIONAL' });
    expect(mergeRecords(sparse, full, rules([complete]), {}).attributes.address).toBe('full');
    // As complete as each other: the order of the sources decides.
    const equal = record({ attributes: { address: 'other', phone: '1', email: 'a@b' }, sourceSystem: 'NATIONAL' });
    expect(mergeRecords(full, equal, rules([complete]), {}).attributes.address).toBe('other');
  });

  it('counts an attribute a record does not have as empty when comparing how complete two records are', () => {
    const sparse = record({ attributes: { address: 'sparse' }, sourceSystem: 'TENANT' });
    const full = record({ attributes: { address: 'full', phone: '123', email: 'a@b' }, sourceSystem: 'NATIONAL' });
    const rule = rules([['address', { strategy: 'MOST_COMPLETE', sourcePriority: ['TENANT', 'NATIONAL'] }]]);
    // The fuller record wins although the order of the sources prefers the sparse one.
    expect(mergeRecords(sparse, full, rule, {}).attributes.address).toBe('full');
    expect(mergeRecords(full, sparse, rule, {}).attributes.address).toBe('full');
  });

  it('is a conflict when no rule settles it - no rule, a decision left to a steward, a tie, an order that names neither source - and names the attributes (409 MERGE_CONFLICT)', () => {
    const a = record({ attributes: { phone: '1', email: 'a', fax: 'x', site: 's', owner: 'o' }, sourceSystem: 'TENANT', recordedAt: '2026-01-01T00:00:00Z' });
    const b = record({ attributes: { phone: '2', email: 'b', fax: 'y', site: 't', owner: 'p' }, sourceSystem: 'TENANT', recordedAt: '2026-01-01T00:00:00Z' });
    const error = thrown(() =>
      mergeRecords(
        a,
        b,
        rules([
          ['email', { strategy: 'STEWARD_DECISION', sourcePriority: [] }],
          ['fax', priority('NATIONAL', 'TREASURY')],
          ['site', { strategy: 'MOST_RECENT', sourcePriority: [] }],
          ['owner', { strategy: 'MOST_COMPLETE', sourcePriority: [] }],
        ]),
        {},
      ),
    );
    expect(error).toMatchObject({ code: 'MERGE_CONFLICT', status: 409, extensions: { attributes: ['email', 'fax', 'owner', 'phone', 'site'] } });
    // A date that cannot be read settles nothing either.
    expect(
      thrown(() => mergeRecords(record({ attributes: { x: '1' }, recordedAt: 'nope' }), record({ attributes: { x: '2' } }), rules([['x', { strategy: 'MOST_RECENT', sourcePriority: [] }]]), {})).code,
    ).toBe('MERGE_CONFLICT');
  });

  it('lets a steward settle what the rules cannot, and refuses an override that means nothing', () => {
    const a = record({ attributes: { phone: '1', email: 'a' } });
    const b = record({ attributes: { phone: '2', email: 'b' } });
    const result = mergeRecords(a, b, rules(), { phone: 'MERGED', email: 'SURVIVOR' });
    expect(result.attributes).toEqual({ phone: '2', email: 'a' });
    expect(result.decisions.filter((decision) => decision.by === 'OVERRIDE').map((decision) => decision.attribute)).toEqual(['email', 'phone']);
    // An override beats the rule.
    expect(mergeRecords(a, b, rules([['phone', priority('TENANT')]]), { phone: 'MERGED', email: 'SURVIVOR' }).attributes.phone).toBe('2');
    for (const bad of [{ nothing: 'MERGED' }, { phone: 'BOTH' }, { label: 'SURVIVOR' }]) {
      expect(thrown(() => mergeRecords(a, b, rules(), { email: 'SURVIVOR', phone: 'SURVIVOR', ...bad }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    }
    // The label is an attribute like the others, and it is only a conflict when the two differ.
    const labelled = mergeRecords(a, record({ label: 'Contractor A2', attributes: { phone: '1', email: 'a' } }), rules(), { label: 'MERGED' });
    expect(labelled.label).toBe('Contractor A2');
    expect(thrown(() => mergeRecords(a, record({ label: 'Contractor A2', attributes: { phone: '1', email: 'a' } }), rules(), {})).extensions).toEqual({ attributes: ['label'] });
    expect(mergeRecords(record({ label: '' }), record({ label: 'From the other' }), rules(), {}).label).toBe('From the other');
  });
});

describe('the undoing of a merge (UAT-AC274, UAT-AC275)', () => {
  const before = record({ label: 'A', attributes: { phone: '111', tax_code: '0101' }, sourceSystem: 'TENANT' });
  const decisions: AttributeDecision[] = [
    { attribute: 'address', chosen: 'MERGED', by: 'ONLY_ONE', strategy: null, source: 'NATIONAL', value: 'Cao Bang' },
    { attribute: 'phone', chosen: 'MERGED', by: 'RULE', strategy: 'SOURCE_PRIORITY', source: 'NATIONAL', value: '222' },
    { attribute: 'tax_code', chosen: 'SURVIVOR', by: 'EQUAL', strategy: null, source: 'TENANT', value: '0101' },
  ];
  const atMerge = { address: 'Cao Bang', phone: '222', tax_code: '0101' };
  const undo = (now: Record<string, unknown>, stewardDecisions: Record<string, unknown> = {}, nowLabel = 'A') =>
    unmergeSurvivor({ decisions, atMerge, atMergeLabel: 'A', now, nowLabel, before, stewardDecisions });

  it('gives the survivor back what it had for the attributes it took from the merged record, and leaves what it gained since', () => {
    const result = undo({ ...atMerge, extra: 'added after the merge' });
    expect(result).toEqual({ label: 'A', attributes: { phone: '111', tax_code: '0101', extra: 'added after the merge' }, reverted: ['address', 'phone'], kept: [] });
    // An attribute the survivor did not have before is gone again.
    expect(result.attributes).not.toHaveProperty('address');
  });

  it('is a conflict when the survivor edited an attribute it took from the merged record (409 UNMERGE_CONFLICT) until a steward decides', () => {
    const now = { ...atMerge, phone: '333' };
    expect(thrown(() => undo(now))).toMatchObject({ code: 'UNMERGE_CONFLICT', status: 409, extensions: { attributes: ['phone'] } });
    expect(undo(now, { phone: 'KEEP' })).toMatchObject({ attributes: { phone: '333' }, kept: ['phone'], reverted: ['address'] });
    expect(undo(now, { phone: 'REVERT' })).toMatchObject({ attributes: { phone: '111' }, kept: [], reverted: ['address', 'phone'] });
  });

  it('does not count an edit of an attribute the survivor kept as its own, and refuses an answer about an attribute that is not in conflict', () => {
    expect(undo({ ...atMerge, tax_code: '9999' }).attributes.tax_code).toBe('9999');
    for (const bad of [{ tax_code: 'KEEP' }, { phone: 'MAYBE' }, { nothing: 'KEEP' }]) {
      expect(thrown(() => undo({ ...atMerge, phone: '333' }, { phone: 'KEEP', ...bad }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    }
    expect(thrown(() => undo(atMerge, { phone: 'KEEP' })).code).toBe('VALIDATION_FAILED');
  });

  it('keeps an attribute that is itself called label (or starts with the escape) apart from the label of the record', () => {
    expect(['label', '~label', 'phone', '~x'].map(attributeKey)).toEqual(['~label', '~~label', 'phone', '~~x']);
    const survivor = record({ label: 'Name', attributes: { label: 'nested-1', '~label': 'escaped-1' } });
    const merged = record({ label: 'Name', attributes: { label: 'nested-2', '~label': 'escaped-2' }, sourceSystem: 'NATIONAL' });
    expect(thrown(() => mergeRecords(survivor, merged, rules(), {})).extensions).toEqual({ attributes: ['~label', '~~label'] });
    const result = mergeRecords(survivor, merged, rules([['~label', priority('NATIONAL', 'TENANT')]]), { '~~label': 'SURVIVOR' });
    expect(result).toMatchObject({ label: 'Name', attributes: { label: 'nested-2', '~label': 'escaped-1' } });
    const decisions = result.decisions.filter((decision) => decision.chosen === 'MERGED');
    expect(decisions.map((decision) => decision.attribute)).toEqual(['~label']);
    const undone = unmergeSurvivor({ decisions, atMerge: result.attributes, atMergeLabel: 'Name', now: result.attributes, nowLabel: 'Name', before: survivor, stewardDecisions: {} });
    expect(undone).toMatchObject({ label: 'Name', attributes: { label: 'nested-1', '~label': 'escaped-1' }, reverted: ['~label'] });
  });

  it('keeps attributes called like what an object inherits or like its prototype as the ordinary names they are', () => {
    const attributes = (): Record<string, unknown> => JSON.parse('{"__proto__": {"deep": 1}, "constructor": "same", "toString": "one", "plain": "p"}');
    const survivor = record({ attributes: attributes() });
    const merged = record({ attributes: { ...JSON.parse('{"__proto__": {"deep": 1}}'), constructor: 'same', hasOwnProperty: 'only-merged' }, sourceSystem: 'NATIONAL' });
    const result = mergeRecords(survivor, merged, rules(), {});
    expect(Object.keys(result.attributes).sort()).toEqual(['__proto__', 'constructor', 'hasOwnProperty', 'plain', 'toString']);
    expect(Object.getPrototypeOf(result.attributes)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(result.attributes))).toEqual({ ...attributes(), hasOwnProperty: 'only-merged' });
    expect(result.decisions.find((decision) => decision.attribute === '__proto__')).toMatchObject({ chosen: 'SURVIVOR', by: 'EQUAL' });
    // An override or an answer named like an inherited property is none of them.
    expect(thrown(() => mergeRecords(record({ attributes: { constructor: 'a' } }), record({ attributes: { constructor: 'b' } }), rules(), {})).extensions).toEqual({ attributes: ['constructor'] });
    const undone = unmergeSurvivor({
      decisions: result.decisions.filter((decision) => decision.chosen === 'MERGED'),
      atMerge: result.attributes,
      atMergeLabel: 'Contractor A',
      now: result.attributes,
      nowLabel: 'Contractor A',
      before: survivor,
      stewardDecisions: {},
    });
    expect(Object.keys(undone.attributes).sort()).toEqual(['__proto__', 'constructor', 'plain', 'toString']);
  });

  it('treats the label as an attribute', () => {
    const labelled: AttributeDecision[] = [{ attribute: 'label', chosen: 'MERGED', by: 'RULE', strategy: 'MOST_RECENT', source: null, value: 'New name' }];
    const run = (nowLabel: string, stewardDecisions: Record<string, unknown> = {}) =>
      unmergeSurvivor({ decisions: labelled, atMerge: {}, atMergeLabel: 'New name', now: {}, nowLabel, before: record({ label: 'Old name' }), stewardDecisions });
    expect(run('New name').label).toBe('Old name');
    expect(thrown(() => run('Edited name')).extensions).toEqual({ attributes: ['label'] });
    expect(run('Edited name', { label: 'KEEP' }).label).toBe('Edited name');
  });
});

describe('a rule of survivorship on its own', () => {
  const rule = (over: Partial<Parameters<typeof checkSurvivorshipRule>[0]> = {}) =>
    checkSurvivorshipRule({ masterType: ' CONTRACTOR ', attributeName: ' phone ', strategy: 'SOURCE_PRIORITY', sourcePriority: [' NATIONAL ', 'TENANT'], effectiveFrom: '2026-11-01', ...over });

  it('takes a strategy with the order of the sources it needs', () => {
    expect(rule()).toEqual({ masterType: 'CONTRACTOR', attributeName: 'phone', strategy: 'SOURCE_PRIORITY', sourcePriority: ['NATIONAL', 'TENANT'] });
    expect(rule({ strategy: 'MOST_RECENT', sourcePriority: undefined }).sourcePriority).toEqual([]);
    expect(rule({ strategy: 'MOST_COMPLETE' }).sourcePriority).toEqual(['NATIONAL', 'TENANT']);
  });

  it.each([
    ['a strategy that is none', { strategy: 'LUCK' }, 'strategy'],
    ['a type that is empty', { masterType: ' ' }, 'master_type'],
    ['an attribute that is too long', { attributeName: 'x'.repeat(101) }, 'attribute_name'],
    ['an attribute that is empty', { attributeName: '' }, 'attribute_name'],
    ['SOURCE_PRIORITY with no order', { sourcePriority: [] }, 'source_priority'],
    ['a source twice', { sourcePriority: ['NATIONAL', 'NATIONAL'] }, 'source_priority'],
    ['a source that is empty', { sourcePriority: ['NATIONAL', ' '] }, 'source_priority'],
    ['too many sources', { sourcePriority: Array.from({ length: 51 }, (_, n) => `S${n}`) }, 'source_priority'],
    ['an order for a steward decision', { strategy: 'STEWARD_DECISION' }, 'source_priority'],
  ])('refuses %s', (_name, over, detail) => {
    expect(thrown(() => rule(over as never))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail });
  });
});
