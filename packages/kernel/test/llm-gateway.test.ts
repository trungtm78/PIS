import { GatewayFailure, assertProfileDraft, classifySources, followsSchema, planRoute, postCheck, requiresCitations, unsupportedSchemaKeyword } from '../src/index.ts';
import type { DomainError, RouteCandidate, RoutePlanInput } from '../src/index.ts';

type Class = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PERSONAL' | 'IMPORTANT_CORE';
const source = (id: string, classification: Class) => ({ documentVersionId: id, classification });
const thrown = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('did not throw');
};

describe('the class of a request (ST-LLM-005, LLM BR-LLM-02)', () => {
  it('AC-ST-LLM-005-1: UAT-AC458 is the highest class of the sources, personal data above confidential, and keeps the sources it came from', () => {
    expect(classifySources([source('a', 'PUBLIC')]).classification).toBe('PUBLIC');
    expect(classifySources([source('a', 'PUBLIC'), source('b', 'INTERNAL')]).classification).toBe('INTERNAL');
    expect(classifySources([source('a', 'PUBLIC'), source('b', 'PERSONAL')]).classification).toBe('PERSONAL');
    expect(classifySources([source('a', 'CONFIDENTIAL'), source('b', 'PERSONAL')]).classification).toBe('PERSONAL');
    expect(classifySources([source('a', 'PERSONAL'), source('b', 'IMPORTANT_CORE'), source('c', 'PUBLIC')]).classification).toBe('IMPORTANT_CORE');
    expect(classifySources([source('a', 'PUBLIC'), source('b', 'INTERNAL')]).basis).toEqual([
      { document_version_id: 'a', classification: 'PUBLIC' },
      { document_version_id: 'b', classification: 'INTERNAL' },
    ]);
  });

  it('refuses a request with no source, and a source of a class that does not exist', () => {
    expect(thrown(() => classifySources([])).code).toBe('VALIDATION_FAILED');
    expect(thrown(() => classifySources([source('a', 'SECRET' as never)])).code).toBe('VALIDATION_FAILED');
  });
});

const candidate = (modelId: string, route: RouteCandidate['route']): RouteCandidate => ({ modelRefId: `ref-${modelId}`, modelId, providerId: `p-${modelId}`, providerCode: `P-${modelId}`, route, pricingVersionId: `price-${modelId}` });
const MODELS = [candidate('dom', 'DOMESTIC_HOSTED'), candidate('self', 'SELF_HOSTED'), candidate('intl', 'INTERNATIONAL')];
const MATRIX: Record<Class, Array<RouteCandidate['route']>> = {
  PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'],
  INTERNAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  CONFIDENTIAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  PERSONAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  IMPORTANT_CORE: ['SELF_HOSTED'],
};
const input = (overrides: Partial<RoutePlanInput> = {}): RoutePlanInput => ({
  classification: 'PUBLIC',
  profileMax: 'IMPORTANT_CORE',
  profileRoutes: ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'],
  policy: { matrix: MATRIX, internationalEnabled: true },
  candidates: MODELS,
  primaryModelId: 'dom',
  ...overrides,
});
const modelsOf = (plan: ReturnType<typeof planRoute>): string[] => (plan.ok ? plan.attempts.map((attempt) => attempt.modelId) : []);

describe('the route of a request (ST-LLM-005, LLM BR-LLM-01)', () => {
  it('AC-ST-LLM-005-1: UAT-AC458 offers public data every route that is on, the primary model first, and the others as the profile lists them', () => {
    expect(modelsOf(planRoute(input()))).toEqual(['dom', 'self', 'intl']);
    expect(modelsOf(planRoute(input({ primaryModelId: 'self' })))).toEqual(['self', 'dom', 'intl']);
    expect(modelsOf(planRoute(input({ primaryModelId: 'unknown' })))).toEqual(['dom', 'self', 'intl']);
  });

  it('keeps the international route for public data, and off unless a policy turns it on', () => {
    expect(modelsOf(planRoute(input({ classification: 'INTERNAL' })))).toEqual(['dom', 'self']);
    expect(modelsOf(planRoute(input({ classification: 'PERSONAL' })))).toEqual(['dom', 'self']);
    expect(modelsOf(planRoute(input({ policy: { matrix: MATRIX, internationalEnabled: false } })))).toEqual(['dom', 'self']);
    expect(modelsOf(planRoute(input({ policy: undefined })))).toEqual(['dom', 'self']);
    // A policy that lists the international route for internal data (it cannot be published) is not believed.
    const odd = { matrix: { ...MATRIX, INTERNAL: ['DOMESTIC_HOSTED', 'INTERNATIONAL'] as Array<RouteCandidate['route']> }, internationalEnabled: true };
    expect(modelsOf(planRoute(input({ classification: 'INTERNAL', policy: odd })))).toEqual(['dom']);
  });

  it('refuses important data without a self-hosted model, a class the profile does not take, and a request no approved model can serve', () => {
    const none = planRoute(input({ classification: 'IMPORTANT_CORE', candidates: [MODELS[0] as RouteCandidate, MODELS[2] as RouteCandidate] }));
    expect(none).toEqual({ ok: false, code: 'AI_ROUTE_NOT_ALLOWED', detail: 'model' });
    expect(planRoute(input({ classification: 'IMPORTANT_CORE', profileRoutes: ['DOMESTIC_HOSTED'] }))).toEqual({ ok: false, code: 'AI_ROUTE_NOT_ALLOWED', detail: 'route' });
    expect(modelsOf(planRoute(input({ classification: 'IMPORTANT_CORE' })))).toEqual(['self']);
    expect(planRoute(input({ classification: 'CONFIDENTIAL', profileMax: 'INTERNAL' }))).toEqual({ ok: false, code: 'AI_ROUTE_NOT_ALLOWED', detail: 'max_classification' });
    expect(planRoute(input({ candidates: [] }))).toEqual({ ok: false, code: 'AI_ROUTE_NOT_ALLOWED', detail: 'model' });
    expect(planRoute(input({ profileRoutes: ['INTERNATIONAL'], policy: { matrix: MATRIX, internationalEnabled: false } }))).toEqual({ ok: false, code: 'AI_ROUTE_NOT_ALLOWED', detail: 'route' });
  });
});

describe('the checks after the answer (ST-LLM-005, LLM F1 step 7)', () => {
  const CITED = { type: 'object', properties: { summary: { type: 'string' }, citations: { type: 'array', items: { type: 'object' } } }, required: ['summary', 'citations'] };

  it('AC-ST-LLM-005-4: UAT-AC466 accepts an answer that follows the schema and cites sources of the request, and says how many', () => {
    const output = JSON.stringify({ summary: 'ok', citations: [{ document_version_id: 'a' }, { document_version_id: 'b' }] });
    const checked = postCheck({ output, outputSchema: CITED, sourceIds: ['a', 'b', 'c'] });
    expect(checked).toMatchObject({ ok: true, citations: 2 });
    expect(checked.ok && checked.outputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AC-ST-LLM-005-4: UAT-AC466 does not accept text that is not JSON, JSON that breaks the schema, a profile that wants citations and gets none, or a citation of what is not a source', () => {
    expect(postCheck({ output: 'no json here', outputSchema: CITED, sourceIds: ['a'] })).toEqual({ ok: false, code: 'INVALID_JSON' });
    expect(postCheck({ output: '{"summary": 3, "citations": [{"document_version_id":"a"}]}', outputSchema: CITED, sourceIds: ['a'] })).toEqual({ ok: false, code: 'INVALID_JSON' });
    expect(postCheck({ output: '{"citations": [{"document_version_id":"a"}]}', outputSchema: CITED, sourceIds: ['a'] })).toEqual({ ok: false, code: 'INVALID_JSON' });
    // Missing citations are told first, whatever else is wrong with the answer.
    expect(postCheck({ output: '{"summary": 3, "citations": []}', outputSchema: CITED, sourceIds: ['a'] })).toEqual({ ok: false, code: 'REJECTED_NO_CITATION' });
    expect(postCheck({ output: '{"citations": []}', outputSchema: CITED, sourceIds: ['a'] })).toEqual({ ok: false, code: 'REJECTED_NO_CITATION' });
    expect(postCheck({ output: '{"summary": "x"}', outputSchema: CITED, sourceIds: ['a'] })).toEqual({ ok: false, code: 'REJECTED_NO_CITATION' });
    expect(postCheck({ output: '[1]', outputSchema: CITED, sourceIds: ['a'] })).toEqual({ ok: false, code: 'INVALID_JSON' });
    expect(postCheck({ output: '{"summary":"x","citations":[]}', outputSchema: CITED, sourceIds: ['a'] })).toEqual({ ok: false, code: 'REJECTED_NO_CITATION' });
    expect(postCheck({ output: '{"summary":"x","citations":[{"document_version_id":"zzz"}]}', outputSchema: CITED, sourceIds: ['a'] })).toEqual({ ok: false, code: 'REJECTED_NO_CITATION' });
    expect(postCheck({ output: '{"summary":"x","citations":[{"note":"no id"}]}', outputSchema: CITED, sourceIds: ['a'] })).toEqual({ ok: false, code: 'REJECTED_NO_CITATION' });
    // A profile that does not require citations takes an answer without them, and still refuses one that cites what is not a source.
    const plain = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
    expect(postCheck({ output: '{"summary":"x"}', outputSchema: plain, sourceIds: ['a'] })).toMatchObject({ ok: true, citations: 0 });
    expect(postCheck({ output: '{"summary":"x","citations":[{"document_version_id":"zzz"}]}', outputSchema: plain, sourceIds: ['a'] })).toEqual({ ok: false, code: 'REJECTED_NO_CITATION' });
  });

  it('follows the part of JSON Schema that the profiles use', () => {
    expect(requiresCitations(CITED)).toBe(true);
    expect(requiresCitations({ type: 'object', required: ['summary'] })).toBe(false);
    expect(requiresCitations(undefined)).toBe(false);
    expect(followsSchema([1, 2], { type: 'array', items: { type: 'integer' } })).toBe(true);
    expect(followsSchema([1, 'x'], { type: 'array', items: { type: 'integer' } })).toBe(false);
    expect(followsSchema('b', { enum: ['a', 'b'] })).toBe(true);
    expect(followsSchema('c', { enum: ['a', 'b'] })).toBe(false);
    expect(followsSchema(true, { type: 'boolean' })).toBe(true);
    expect(followsSchema(1.5, { type: 'number' })).toBe(true);
    expect(followsSchema(1.5, { type: 'integer' })).toBe(false);
    expect(followsSchema({ a: { b: 1 } }, { type: 'object', properties: { a: { type: 'object', required: ['b'] } } })).toBe(true);
    expect(followsSchema({ a: {} }, { type: 'object', properties: { a: { type: 'object', required: ['b'] } } })).toBe(false);
    expect(followsSchema({}, undefined)).toBe(true);
  });

  it('AC-ST-LLM-005-4: UAT-AC466 checks every limit that a profile may put in its schema: lengths, patterns, formats, numbers, items, extra properties, constants and several types', () => {
    const schema = {
      type: 'object',
      required: ['id', 'note'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', format: 'uuid' },
        note: { type: ['string', 'null'], minLength: 2, maxLength: 5, pattern: '^[a-z]+$' },
        score: { type: 'integer', minimum: 1, maximum: 5 },
        tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } },
        kind: { const: 'summary' },
        at: { type: 'string', format: 'date-time' },
        extra: { type: 'object', additionalProperties: { type: 'integer' } },
      },
    };
    const good = { id: '3f9a1c2e-0b4d-4d3a-9c1e-7a2c5d6e8f10', note: 'ok', score: 3, tags: ['a'], kind: 'summary', at: '2026-10-28T10:00:00Z', extra: { n: 1 } };
    expect(followsSchema(good, schema)).toBe(true);
    expect(followsSchema({ ...good, note: null }, schema)).toBe(true);
    for (const bad of [{ id: 'nope' }, { note: 'x' }, { note: 'toolongnote' }, { note: 'UP' }, { score: 0 }, { score: 6 }, { score: 2.5 }, { tags: [] }, { tags: ['a', 'b', 'c'] }, { tags: [1] }, { kind: 'other' }, { at: '28/10/2026' }, { extra: { n: 'x' } }, { stranger: 1 }, { note: 5 }]) {
      expect([JSON.stringify(bad), followsSchema({ ...good, ...bad }, schema)]).toEqual([JSON.stringify(bad), false]);
    }
    expect(followsSchema({ ...good, id: undefined }, schema)).toBe(false);
    expect(followsSchema(1, false)).toBe(false);
    expect(followsSchema('x', { type: 'null' })).toBe(false);
    expect(followsSchema(null, { type: 'null' })).toBe(true);
  });

  it('refuses, when a profile is drafted, a keyword of an output schema that the gateway cannot check, so that no rule is taken as applied that was not', () => {
    expect(unsupportedSchemaKeyword({ type: 'object', properties: { a: { type: 'string', description: 'free', format: 'uuid' } }, required: ['a'], title: 'x' })).toBeUndefined();
    expect(unsupportedSchemaKeyword({})).toBeUndefined();
    expect(unsupportedSchemaKeyword({ $ref: '#/x' })).toBe('$ref');
    expect(unsupportedSchemaKeyword({ oneOf: [] })).toBe('oneOf');
    expect(unsupportedSchemaKeyword({ type: 'object', properties: { a: { anyOf: [] } } })).toBe('properties.a.anyOf');
    expect(unsupportedSchemaKeyword({ type: 'array', items: { patternProperties: {} } })).toBe('items.patternProperties');
    expect(unsupportedSchemaKeyword({ type: 'string', format: 'email' })).toBe('format');
    expect(unsupportedSchemaKeyword({ type: 'string', pattern: '(' })).toBe('pattern');
    expect(unsupportedSchemaKeyword({ type: 'thing' })).toBe('type');
    expect(unsupportedSchemaKeyword({ type: [] })).toBe('type');
    expect(unsupportedSchemaKeyword({ type: 'object', additionalProperties: { uniqueItems: true } })).toBe('additionalProperties.uniqueItems');
    expect(unsupportedSchemaKeyword('text')).toBe('schema');
    // A keyword whose value is not of the shape the check reads would be ignored: it is refused too.
    expect(unsupportedSchemaKeyword({ type: 'object', required: 'citations' })).toBe('required');
    expect(unsupportedSchemaKeyword({ type: 'object', required: [1] })).toBe('required');
    expect(unsupportedSchemaKeyword({ type: 'object', properties: { summary: { type: 'string', maxLength: '5' } } })).toBe('properties.summary.maxLength');
    expect(unsupportedSchemaKeyword({ type: 'string', minLength: -1 })).toBe('minLength');
    expect(unsupportedSchemaKeyword({ type: 'string', minLength: 1.5 })).toBe('minLength');
    expect(unsupportedSchemaKeyword({ type: 'number', minimum: '1' })).toBe('minimum');
    expect(unsupportedSchemaKeyword({ type: 'array', maxItems: null })).toBe('maxItems');
    expect(unsupportedSchemaKeyword({ type: 'string', pattern: 5 })).toBe('pattern');
    expect(unsupportedSchemaKeyword({ type: 'string', format: 5 })).toBe('format');
    expect(unsupportedSchemaKeyword({ enum: [] })).toBe('enum');
    expect(unsupportedSchemaKeyword({ enum: 'a' })).toBe('enum');
    expect(unsupportedSchemaKeyword({ type: 'object', properties: [] })).toBe('properties');
    expect(unsupportedSchemaKeyword({ type: 'array', items: [{ type: 'string' }] })).toBe('items');
    expect(unsupportedSchemaKeyword({ type: 'object', additionalProperties: 'no' })).toBe('additionalProperties');
    expect(unsupportedSchemaKeyword({ type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 5, minimum: 0 } }, additionalProperties: false })).toBeUndefined();
    const draft = { effort: null, outputCap: 1000, maxInputTokens: 8000, timeoutMs: 30_000, concurrencyLimit: 4, retentionDays: 90, toolAllowlist: [], outputSchema: { type: 'object', oneOf: [] }, allowedModelIds: ['m1'], maxClassification: 'PUBLIC' };
    expect(thrown(() => assertProfileDraft(draft)).detail).toBe('output_schema');
    expect(() => assertProfileDraft({ ...draft, outputSchema: { type: 'object' } })).not.toThrow();
  });

  it('compares constants and enums as JSON values, whatever the order of the properties, and looks only at the own properties of an answer', () => {
    expect(followsSchema({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] })).toBe(true);
    expect(followsSchema({ a: 1, b: [1, { y: 2, x: 1 }] }, { const: { b: [1, { x: 1, y: 2 }], a: 1 } })).toBe(true);
    expect(followsSchema({ a: 1 }, { const: { a: 1, b: 2 } })).toBe(false);
    expect(followsSchema({ a: 1, b: 2 }, { const: { a: 1 } })).toBe(false);
    expect(followsSchema([1, 2], { const: [2, 1] })).toBe(false);
    expect(followsSchema(0, { const: -0 })).toBe(true);
    expect(followsSchema(null, { const: null })).toBe(true);
    // A property that is only inherited is not there: JSON.parse makes own properties, and a required name is never met by the prototype.
    expect(followsSchema({}, { type: 'object', required: ['toString'] })).toBe(false);
    expect(followsSchema({}, { type: 'object', required: ['constructor'] })).toBe(false);
    expect(followsSchema(JSON.parse('{"__proto__": {"x": 1}}'), { type: 'object', required: ['__proto__'] })).toBe(true);
    expect(followsSchema({ toString: 1 }, { type: 'object', additionalProperties: false, properties: { toString: { type: 'string' } } })).toBe(false);
    expect(followsSchema('x', { type: 'string', format: 'toString' })).toBe(false);
    expect(unsupportedSchemaKeyword({ type: 'string', format: 'constructor' })).toBe('format');
  });

  it('takes a date and a moment only when they exist on the calendar and on the clock', () => {
    const date = { type: 'string', format: 'date' };
    const moment = { type: 'string', format: 'date-time' };
    expect(followsSchema('2026-10-28', date)).toBe(true);
    expect(followsSchema('2028-02-29', date)).toBe(true);
    for (const bad of ['2026-99-99', '2026-02-29', '2026-13-01', '2026-04-31', '2026-00-10', '2026-10-00', '28/10/2026']) expect([bad, followsSchema(bad, date)]).toEqual([bad, false]);
    expect(followsSchema('2026-10-28T23:59:59Z', moment)).toBe(true);
    expect(followsSchema('2026-10-28T10:00:00.123+07:00', moment)).toBe(true);
    expect(followsSchema('2026-12-31T23:59:60Z', moment)).toBe(true);
    for (const bad of ['2026-01-01T99:99:99Z', '2026-01-01T24:00:00Z', '2026-01-01T10:60:00Z', '2026-01-01T10:00:61Z', '2026-02-30T10:00:00Z', '2026-01-01T10:00:00+24:00', '2026-01-01T10:00:00+07:60', '2026-01-01 10:00:00Z']) expect([bad, followsSchema(bad, moment)]).toEqual([bad, false]);
  });

  it('says only the kind of a failure of the provider', () => {
    const failure = new GatewayFailure('TIMEOUT');
    expect([failure.kind, failure.message, failure.name]).toEqual(['TIMEOUT', 'TIMEOUT', 'GatewayFailure']);
  });
});
