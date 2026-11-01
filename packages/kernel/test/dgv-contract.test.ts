import { CONTRACT_MIGRATION_DAYS, ODCS_PINNED, classifyChange, earliestMigrationEnd, migrationWindowEnough, odcsSha256, parseOdcs, requiredConsumers } from '../src/dgv-contract.ts';
import type { ContractColumn } from '../src/dgv-contract.ts';

const OWNER = '00000000-0000-4000-8000-000000000001';

const property = (name: string, overrides: Record<string, unknown> = {}) => ({ name, logicalType: 'string', ...overrides });
const document = (
  properties: unknown[] = [
    property('unit_code', { required: true, primaryKey: true }),
    property('amount', { logicalType: 'number', physicalType: 'numeric(24,0)', customProperties: [{ property: 'unit', value: 'VND' }] }),
  ],
  extra: Record<string, unknown> = {},
) => ({
  apiVersion: ODCS_PINNED,
  kind: 'DataContract',
  id: 'ds-disb',
  version: '3.0.0',
  status: 'active',
  schema: [{ name: 'disbursement', properties }],
  ...extra,
});
const columns = (raw: unknown): ContractColumn[] => parseOdcs(raw, ODCS_PINNED).columns;
const bad = (raw: unknown, path: string, version: string = ODCS_PINNED) => {
  try {
    parseOdcs(raw, version);
  } catch (error) {
    expect(error).toMatchObject({ code: 'ODCS_SCHEMA_INVALID', status: 422, detail: path });
    return;
  }
  throw new Error(`the document was accepted: ${path}`);
};

describe('reading an ODCS document of the pinned version (ST-DGV-005, DGV 3.1 F2)', () => {
  it('puts the columns in one shape: the types, what is required, the key, the classification and the unit', () => {
    const parsed = parseOdcs(
      document(
        [
          property('unit_code', { required: true, primaryKey: true, classification: 'internal' }),
          property('amount', { logicalType: 'number', physicalType: 'numeric(24,0)', customProperties: [{ property: 'unit', value: 'VND' }] }),
        ],
        {
          slaProperties: [
            { property: 'freshness', value: 24, unit: 'h' },
            { property: 'retention', value: 10, unit: 'y' },
          ],
          quality: [{ rule: 'nullCheck' }],
          customProperties: [
            { property: 'consumer', value: { kind: 'MODULE', ref: 'HOME', owner_user_id: OWNER.toUpperCase() } },
            { property: 'other', value: 1 },
          ],
        },
      ),
      ODCS_PINNED,
    );
    expect(parsed.columns).toEqual([
      { object: 'disbursement', name: 'amount', logicalType: 'number', physicalType: 'numeric(24,0)', required: false, primaryKey: false, classification: null, unit: 'VND' },
      { object: 'disbursement', name: 'unit_code', logicalType: 'string', physicalType: null, required: true, primaryKey: true, classification: 'INTERNAL', unit: null },
    ]);
    expect(parsed.consumers).toEqual([{ kind: 'MODULE', ref: 'HOME', ownerUserId: OWNER }]);
    expect(parsed.quality).toEqual([{ rule: 'nullCheck' }]);
    expect(parsed.freshnessSeconds).toBe(86_400);
  });

  it('has no consumer, no quality and no freshness when the document names none', () => {
    expect(parseOdcs(document(), ODCS_PINNED)).toMatchObject({ consumers: [], quality: [], freshnessSeconds: null });
    expect(parseOdcs(document(undefined, { slaProperties: [{ property: 'latency', value: 5, unit: 'm' }] }), ODCS_PINNED).freshnessSeconds).toBeNull();
    expect(parseOdcs(document(undefined, { slaProperties: [{ property: 'freshness', value: 90, unit: 'm' }] }), ODCS_PINNED).freshnessSeconds).toBe(5400);
    expect(parseOdcs(document(undefined, { slaProperties: [{ property: 'freshness', value: 30, unit: 's' }] }), ODCS_PINNED).freshnessSeconds).toBe(30);
    expect(parseOdcs(document(undefined, { slaProperties: [{ property: 'freshness', value: 2, unit: 'd' }] }), ODCS_PINNED).freshnessSeconds).toBe(172_800);
  });

  it('takes the other versions of the pinned line and no other', () => {
    expect(parseOdcs({ ...document(), apiVersion: 'v3.0.0' }, 'v3.0.0').columns).toHaveLength(2);
    bad({ ...document(), apiVersion: 'v2.2.2' }, 'odcs_version', 'v2.2.2');
    bad(document(), 'apiVersion', 'v3.0.1');
  });

  it.each([
    ['not an object', [], 'odcs_json'],
    ['not an object (null)', null, 'odcs_json'],
    ['a kind that is not a contract', { ...document(), kind: 'DataProduct' }, 'kind'],
    ['no id', { ...document(), id: '' }, 'id'],
    ['no version', { ...document(), version: undefined }, 'version'],
    ['no status', { ...document(), status: 3 }, 'status'],
    ['no schema', { ...document(), schema: undefined }, 'schema'],
    ['an empty schema', { ...document(), schema: [] }, 'schema'],
    ['an object that is not one', { ...document(), schema: ['x'] }, 'schema[0]'],
    ['an object without a name', { ...document(), schema: [{ properties: [property('a')] }] }, 'schema[0].name'],
    ['an object without properties', { ...document(), schema: [{ name: 'o' }] }, 'schema[0].properties'],
    ['an object with an empty list of properties', { ...document(), schema: [{ name: 'o', properties: [] }] }, 'schema[0].properties'],
    [
      'two objects of one name',
      {
        ...document(),
        schema: [
          { name: 'o', properties: [property('a')] },
          { name: 'o', properties: [property('a')] },
        ],
      },
      'schema[1].name',
    ],
    ['a property that is not one', document([3]), 'schema[0].properties[0]'],
    ['a property without a name', document([{ logicalType: 'string' }]), 'schema[0].properties[0].name'],
    ['a name with a NUL', document([property('a\0b')]), 'schema[0].properties[0].name'],
    ['a name that is too long', document([property('a'.repeat(201))]), 'schema[0].properties[0].name'],
    ['two properties of one name', document([property('a'), property('a')]), 'schema[0].properties[1].name'],
    ['a type the standard does not have', document([property('a', { logicalType: 'decimal' })]), 'schema[0].properties[0].logicalType'],
    ['required that is not a boolean', document([property('a', { required: 'yes' })]), 'schema[0].properties[0].required'],
    ['a primary key that is not a boolean', document([property('a', { primaryKey: 1 })]), 'schema[0].properties[0].primaryKey'],
    ['a classification that is not a text', document([property('a', { classification: 4 })]), 'schema[0].properties[0].classification'],
    ['a physical type that is not a text', document([property('a', { physicalType: 4 })]), 'schema[0].properties[0].physicalType'],
    ['custom properties of a column that are not a list', document([property('a', { customProperties: {} })]), 'schema[0].properties[0].customProperties'],
    ['a custom property without a name', document([property('a', { customProperties: [{ value: 1 }] })]), 'schema[0].properties[0].customProperties[0]'],
    ['a unit that is not a text', document([property('a', { customProperties: [{ property: 'unit', value: 3 }] })]), 'schema[0].properties[0].customProperties'],
    ['quality that is not a list', { ...document(), quality: {} }, 'quality'],
    ['custom properties of the contract that are not a list', { ...document(), customProperties: 'x' }, 'customProperties'],
    ['a custom property of the contract that is not one', { ...document(), customProperties: [1] }, 'customProperties[0]'],
    ['a consumer without a value', { ...document(), customProperties: [{ property: 'consumer' }] }, 'customProperties[0].value'],
    [
      'a consumer of a kind the platform does not know',
      { ...document(), customProperties: [{ property: 'consumer', value: { kind: 'PARTNER', ref: 'x', owner_user_id: OWNER } }] },
      'customProperties[0].value.kind',
    ],
    ['a consumer without a reference', { ...document(), customProperties: [{ property: 'consumer', value: { kind: 'MODULE', ref: '', owner_user_id: OWNER } }] }, 'customProperties[0].value.ref'],
    [
      'a consumer without an owner',
      { ...document(), customProperties: [{ property: 'consumer', value: { kind: 'MODULE', ref: 'HOME', owner_user_id: 'me' } }] },
      'customProperties[0].value.owner_user_id',
    ],
    ['sla properties that are not a list', { ...document(), slaProperties: {} }, 'slaProperties'],
    ['an sla property that is not one', { ...document(), slaProperties: [4] }, 'slaProperties[0]'],
    ['a freshness without a value', { ...document(), slaProperties: [{ property: 'freshness', unit: 'h' }] }, 'slaProperties[0].value'],
    ['a freshness of no time', { ...document(), slaProperties: [{ property: 'freshness', value: 0, unit: 'h' }] }, 'slaProperties[0].value'],
    ['a freshness in an unknown unit', { ...document(), slaProperties: [{ property: 'freshness', value: 3, unit: 'w' }] }, 'slaProperties[0].value'],
  ])('refuses %s naming the path', (_name, raw, path) => bad(raw, path));

  it('refuses more consumers than a contract may have, and more columns than it may have', () => {
    const consumers = Array.from({ length: 101 }, (_, index) => ({ property: 'consumer', value: { kind: 'MODULE', ref: `M${index}`, owner_user_id: OWNER } }));
    bad({ ...document(), customProperties: consumers }, 'customProperties');
    bad({ ...document(), schema: [{ name: 'o', properties: Array.from({ length: 1001 }, (_, index) => property(`c${index}`)) }] }, 'schema');
    bad({ ...document(), schema: Array.from({ length: 101 }, (_, index) => ({ name: `o${index}`, properties: [property('a')] })) }, 'schema');
  });

  it('reads the fields of an object and the element of an array as columns named by their path, and refuses a nesting that is not one or too deep', () => {
    const nested = document([
      property('address', { logicalType: 'object', properties: [property('city'), property('geo', { logicalType: 'object', properties: [property('lat', { logicalType: 'number' })] })] }),
      property('tags', { logicalType: 'array', items: property('tag', { required: true }) }),
    ]);
    expect(columns(nested).map((column) => column.name)).toEqual(['address', 'address.city', 'address.geo', 'address.geo.lat', 'tags', 'tags[]']);
    expect(columns(nested).find((column) => column.name === 'tags[]')?.required).toBe(true);
    bad(document([property('a', { logicalType: 'object', properties: 'x' })]), 'schema[0].properties[0].properties');
    bad(document([property('a', { logicalType: 'object', properties: [1] })]), 'schema[0].properties[0].properties[0]');
    bad(document([property('a', { logicalType: 'object', properties: [property('b', { logicalType: 'nope' })] })]), 'schema[0].properties[0].properties[0].logicalType');
    bad(document([property('a', { logicalType: 'array', items: 'x' })]), 'schema[0].properties[0].items');
    bad(document([property('a', { logicalType: 'object', properties: [property('b'), property('b')] })]), 'schema[0].properties[0].properties[1].name');
    let deep: Record<string, unknown> = property('leaf');
    for (let level = 0; level < 10; level += 1) deep = property(`n${level}`, { logicalType: 'object', properties: [deep] });
    bad(document([deep]), `schema[0].properties[0]${'.properties[0]'.repeat(8)}.properties`);
  });

  it('takes a change inside a nested column as a change of the contract: a type changed or a field removed is breaking', () => {
    const before = columns(document([property('address', { logicalType: 'object', properties: [property('zip', { logicalType: 'integer' }), property('city')] })]));
    const retyped = columns(document([property('address', { logicalType: 'object', properties: [property('zip', { logicalType: 'string' }), property('city')] })]));
    const dropped = columns(document([property('address', { logicalType: 'object', properties: [property('zip', { logicalType: 'integer' })] })]));
    expect(classifyChange(before, retyped)).toMatchObject({ compatibility: 'BREAKING', changes: [{ kind: 'TYPE_CHANGED', column: 'address.zip' }] });
    expect(classifyChange(before, dropped)).toMatchObject({ compatibility: 'BREAKING', changes: [{ kind: 'COLUMN_REMOVED', column: 'address.city' }] });
  });

  it('does not take a field of an object and a column named like its path as the same column', () => {
    const nested = columns(document([property('a', { logicalType: 'object', properties: [property('b')] })]));
    const flat = columns(document([property('a', { logicalType: 'object' }), property('a.b')]));
    expect(flat.map((column) => column.name)).toEqual(['a', 'a\\.b']);
    expect(classifyChange(nested, flat)).toMatchObject({
      compatibility: 'BREAKING',
      changes: [
        { kind: 'COLUMN_REMOVED', column: 'a.b' },
        { kind: 'COLUMN_ADDED_OPTIONAL', column: 'a\\.b' },
      ],
    });
    // The element of an array is not a column that is named like it.
    const array = columns(document([property('t', { logicalType: 'array', items: property('x') })]));
    const named = columns(document([property('t', { logicalType: 'array' }), property('t[]')]));
    expect(classifyChange(array, named).compatibility).toBe('BREAKING');
  });

  it('refuses a classification the platform does not rank, and a freshness that is less than a second or more than a number can hold', () => {
    bad(document([property('a', { classification: 'SECRET' })]), 'schema[0].properties[0].classification');
    bad(document([property('a', { classification: 'PERSONAL ' })]), 'schema[0].properties[0].classification');
    expect(columns(document([property('a', { classification: 'personal' })]))[0]?.classification).toBe('PERSONAL');
    const freshness = (value: unknown, unit = 's') => ({ slaProperties: [{ property: 'freshness', value, unit }] });
    bad(document(undefined, freshness(0.1)), 'slaProperties[0].value');
    bad(document(undefined, freshness(1e300, 'd')), 'slaProperties[0].value');
    expect(parseOdcs(document(undefined, freshness(0.5)), ODCS_PINNED).freshnessSeconds).toBe(1);
  });

  it('counts a consumer declared twice once', () => {
    const twice = { property: 'consumer', value: { kind: 'MODULE', ref: 'HOME', owner_user_id: OWNER } };
    expect(parseOdcs({ ...document(), customProperties: [twice, twice] }, ODCS_PINNED).consumers).toHaveLength(1);
  });

  it('hashes the same document to the same value whatever the order of its keys, and another document to another', () => {
    const a = { x: 1, y: { b: 2, a: 1 } };
    expect(odcsSha256(a)).toBe(odcsSha256({ y: { a: 1, b: 2 }, x: 1 }));
    expect(odcsSha256(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(odcsSha256(a)).not.toBe(odcsSha256({ x: 2, y: { b: 2, a: 1 } }));
  });
});

describe('the compatibility of a revision with the one that is published (BR-DGV-07, UAT-AC50)', () => {
  const before = columns(
    document([
      property('unit_code', { required: true, primaryKey: true }),
      property('amount', { logicalType: 'number', physicalType: 'numeric(24,0)', customProperties: [{ property: 'unit', value: 'VND' }] }),
      property('note'),
    ]),
  );
  const classify = (properties: unknown[]) => classifyChange(before, columns(document(properties)));
  const keep = [
    property('unit_code', { required: true, primaryKey: true }),
    property('amount', { logicalType: 'number', physicalType: 'numeric(24,0)', customProperties: [{ property: 'unit', value: 'VND' }] }),
    property('note'),
  ];

  it('has nothing to be compared with for the first revision', () => {
    expect(classifyChange(undefined, before)).toEqual({ compatibility: 'INITIAL', changes: [] });
  });

  it('is backward compatible when nothing of the columns changes', () => {
    expect(classify(keep)).toEqual({ compatibility: 'BACKWARD_COMPATIBLE', changes: [] });
  });

  it('is backward compatible when an optional column is added (UAT-AC50, r5)', () => {
    expect(classify([...keep, property('remark')])).toEqual({
      compatibility: 'BACKWARD_COMPATIBLE',
      changes: [{ kind: 'COLUMN_ADDED_OPTIONAL', object: 'disbursement', column: 'remark', breaking: false }],
    });
  });

  it('is breaking when the type changes and a column is renamed (UAT-AC50, r4)', () => {
    const result = classify([
      property('org_unit_code', { required: true, primaryKey: true }),
      property('amount', { logicalType: 'number', physicalType: 'numeric(24,2)', customProperties: [{ property: 'unit', value: 'VND' }] }),
      property('note'),
    ]);
    expect(result.compatibility).toBe('BREAKING');
    expect(
      result.changes
        .filter((change) => change.breaking)
        .map((change) => `${change.kind}:${change.column}`)
        .sort(),
    ).toEqual(['COLUMN_REMOVED:unit_code', 'GRAIN_CHANGED:org_unit_code', 'TYPE_CHANGED:amount']);
  });

  it.each([
    ['a column removed', [keep[0], keep[1]], 'COLUMN_REMOVED'],
    ['a column added as required', [...keep, property('flag', { required: true })], 'COLUMN_ADDED_REQUIRED'],
    ['an optional column made required', [keep[0], keep[1], property('note', { required: true })], 'MADE_REQUIRED'],
    [
      'the logical type changed',
      [keep[0], property('amount', { logicalType: 'string', physicalType: 'numeric(24,0)', customProperties: [{ property: 'unit', value: 'VND' }] }), keep[2]],
      'TYPE_CHANGED',
    ],
    ['the scale changed', [keep[0], property('amount', { logicalType: 'number', physicalType: 'numeric(24,2)', customProperties: [{ property: 'unit', value: 'VND' }] }), keep[2]], 'TYPE_CHANGED'],
    [
      'the precision narrowed',
      [keep[0], property('amount', { logicalType: 'number', physicalType: 'numeric(12,0)', customProperties: [{ property: 'unit', value: 'VND' }] }), keep[2]],
      'TYPE_CHANGED',
    ],
    [
      'the physical type changed to another type',
      [keep[0], property('amount', { logicalType: 'number', physicalType: 'float', customProperties: [{ property: 'unit', value: 'VND' }] }), keep[2]],
      'TYPE_CHANGED',
    ],
    ['a physical type given where there was none', [keep[0], keep[1], property('note', { physicalType: 'text' })], 'none'],
    ['the key that gives the grain changed', [property('unit_code', { required: true }), keep[1], keep[2]], 'GRAIN_CHANGED'],
    ['the unit changed', [keep[0], property('amount', { logicalType: 'number', physicalType: 'numeric(24,0)', customProperties: [{ property: 'unit', value: 'USD' }] }), keep[2]], 'UNIT_CHANGED'],
    ['the classification raised', [property('unit_code', { required: true, primaryKey: true, classification: 'PERSONAL' }), keep[1], keep[2]], 'CLASSIFICATION_RAISED'],
  ])('is breaking when %s', (_name, properties, kind) => {
    const result = classify(properties);
    if (kind === 'none') {
      expect(result.compatibility).toBe('BACKWARD_COMPATIBLE');
      return;
    }
    expect(result.compatibility).toBe('BREAKING');
    expect(result.changes.some((change) => change.kind === kind && change.breaking)).toBe(true);
  });

  it.each([
    ['a required column made optional', [property('unit_code', { primaryKey: true }), keep[1], keep[2]], 'MADE_OPTIONAL'],
    [
      'a type widened in precision with the same scale',
      [keep[0], property('amount', { logicalType: 'number', physicalType: 'numeric(30,0)', customProperties: [{ property: 'unit', value: 'VND' }] }), keep[2]],
      null,
    ],
    ['an integer widened to a number', [keep[0], keep[1], property('note', { logicalType: 'string' })], null],
    ['a classification lowered', [keep[0], keep[1], keep[2]], null],
  ])('is backward compatible when %s', (_name, properties, kind) => {
    const result = classify(properties);
    expect(result.compatibility).toBe('BACKWARD_COMPATIBLE');
    if (kind !== null) expect(result.changes.map((change) => change.kind)).toEqual([kind]);
  });

  it('takes an integer widened to a number as a widening, and a number narrowed to an integer as a change of type', () => {
    const integer = columns(document([property('n', { logicalType: 'integer' })]));
    const number = columns(document([property('n', { logicalType: 'number' })]));
    expect(classifyChange(integer, number).compatibility).toBe('BACKWARD_COMPATIBLE');
    expect(classifyChange(number, integer).compatibility).toBe('BREAKING');
  });

  it('takes a physical type that had a length widened as it holds more, and a classification lowered as backward compatible', () => {
    const short = columns(document([property('n', { physicalType: 'varchar(10)', classification: 'CONFIDENTIAL' })]));
    const long = columns(document([property('n', { physicalType: 'varchar(20)', classification: 'INTERNAL' })]));
    expect(classifyChange(short, long)).toMatchObject({ compatibility: 'BACKWARD_COMPATIBLE', changes: [{ kind: 'CLASSIFICATION_LOWERED', breaking: false }] });
    expect(classifyChange(long, short).compatibility).toBe('BREAKING');
  });

  it('tells a physical type that was there and is gone from one that was never there', () => {
    const typed = columns(document([property('n', { physicalType: 'varchar(10)' })]));
    const untyped = columns(document([property('n')]));
    expect(classifyChange(typed, untyped).compatibility).toBe('BREAKING');
    expect(classifyChange(untyped, typed).compatibility).toBe('BACKWARD_COMPATIBLE');
  });

  it('still checks the physical type when the logical type widens: an integer that becomes a number must not narrow', () => {
    const wide = columns(document([property('n', { logicalType: 'integer', physicalType: 'numeric(20,0)' })]));
    const narrow = columns(document([property('n', { logicalType: 'number', physicalType: 'numeric(10,0)' })]));
    const same = columns(document([property('n', { logicalType: 'number', physicalType: 'numeric(20,0)' })]));
    const other = columns(document([property('n', { logicalType: 'number', physicalType: 'float' })]));
    expect(classifyChange(wide, narrow)).toMatchObject({ compatibility: 'BREAKING', changes: [{ kind: 'TYPE_CHANGED', breaking: true }] });
    expect(classifyChange(wide, same).compatibility).toBe('BACKWARD_COMPATIBLE');
    // A numeric type that becomes a floating one cannot be shown to hold what it held.
    expect(classifyChange(wide, other).compatibility).toBe('BREAKING');
  });

  it.each([
    ['bigint', 'numeric(2,0)', 'BREAKING'],
    ['bigint', 'numeric(19,0)', 'BACKWARD_COMPATIBLE'],
    ['bigint', 'numeric(21,2)', 'BACKWARD_COMPATIBLE'],
    ['bigint', 'numeric(20,2)', 'BREAKING'],
    ['bigint', 'numeric', 'BACKWARD_COMPATIBLE'],
    ['bigint', 'decimal(25,0)', 'BACKWARD_COMPATIBLE'],
    ['integer', 'bigint', 'BACKWARD_COMPATIBLE'],
    ['bigint', 'integer', 'BREAKING'],
    ['smallint', 'integer', 'BACKWARD_COMPATIBLE'],
    ['int4', 'int8', 'BACKWARD_COMPATIBLE'],
    ['int2', 'int4', 'BACKWARD_COMPATIBLE'],
    ['int8', 'int4', 'BREAKING'],
    ['integer', 'numeric(9,0)', 'BREAKING'],
    ['integer', 'float', 'BREAKING'],
    ['integer', 'varchar(20)', 'BREAKING'],
    ['text', 'varchar(20)', 'BREAKING'],
  ])('takes an integer column whose physical type goes from %s to %s as %s', (from, to, expected) => {
    const before = columns(document([property('n', { logicalType: 'integer', physicalType: from })]));
    const after = columns(document([property('n', { logicalType: 'number', physicalType: to })]));
    expect(classifyChange(before, after).compatibility).toBe(expected);
  });

  it('takes a column added to the key as a change of the grain, required or not', () => {
    const plain = columns(document([property('a', { required: true, primaryKey: true })]));
    const keyed = columns(document([property('a', { required: true, primaryKey: true }), property('b', { primaryKey: true })]));
    expect(classifyChange(plain, keyed)).toEqual({ compatibility: 'BREAKING', changes: [{ kind: 'GRAIN_CHANGED', object: 'disbursement', column: 'b', breaking: true }] });
    const optional = columns(document([property('a', { required: true, primaryKey: true }), property('b')]));
    expect(classifyChange(plain, optional).compatibility).toBe('BACKWARD_COMPATIBLE');
  });

  it('compares the columns of an object with those of the same object only', () => {
    const one = columns({
      ...document(),
      schema: [
        { name: 'a', properties: [property('x')] },
        { name: 'b', properties: [property('x')] },
      ],
    });
    const other = columns({ ...document(), schema: [{ name: 'a', properties: [property('x')] }] });
    expect(classifyChange(one, other).changes).toEqual([{ kind: 'COLUMN_REMOVED', object: 'b', column: 'x', breaking: true }]);
  });
});

describe('the window of a breaking change and the consumers that must approve it', () => {
  it('ends at least thirty days after the revision takes effect', () => {
    expect(CONTRACT_MIGRATION_DAYS).toBe(30);
    expect(earliestMigrationEnd('2026-11-01')).toBe('2026-12-01');
    expect(earliestMigrationEnd('2026-12-15')).toBe('2027-01-14');
    expect(migrationWindowEnough('2026-11-01', '2026-12-01')).toBe(true);
    expect(migrationWindowEnough('2026-11-01', '2026-12-31')).toBe(true);
    expect(migrationWindowEnough('2026-11-01', '2026-11-30')).toBe(false);
  });

  it('asks each consumer once, those the contract declares and those the platform knows of, in one order', () => {
    const home = { kind: 'MODULE' as const, ref: 'HOME', ownerUserId: OWNER };
    const bi = { kind: 'BI_DATASET' as const, ref: 'DS-DISB-BI', ownerUserId: OWNER };
    const other = { ...bi, ownerUserId: '00000000-0000-4000-8000-000000000002' };
    expect(requiredConsumers([home, bi], [other, { kind: 'EXPORT', ref: 'MNE-07', ownerUserId: OWNER }]).map((consumer) => `${consumer.kind}:${consumer.ref}`)).toEqual([
      'BI_DATASET:DS-DISB-BI',
      'EXPORT:MNE-07',
      'MODULE:HOME',
    ]);
    // The platform knows who answers for a dataset of BI: a declaration cannot name somebody else.
    expect(requiredConsumers([bi], [other])[0]?.ownerUserId).toBe(other.ownerUserId);
    expect(requiredConsumers([other], [bi])[0]?.ownerUserId).toBe(OWNER);
    expect(requiredConsumers([], [])).toEqual([]);
  });
});
