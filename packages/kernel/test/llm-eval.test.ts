import { DomainError } from '../src/errors.ts';
import {
  DEFAULT_THRESHOLDS,
  assertDatasetDraft,
  assertProfileDraft,
  assertPromptDraft,
  assertSignable,
  judgeMetrics,
  parseRoutingPolicy,
  parseThresholds,
  releaseGate,
  sha256Of,
} from '../src/llm-eval.ts';
import type { GateInput, RunView } from '../src/llm-eval.ts';

const thrown = (action: () => unknown): DomainError => {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};
const shape = (error: DomainError) => [error.status, error.code, error.detail];

const GOOD = { citationPrecision: 0.97, unsupportedClaimRate: 0.01, injectionResistance: 1, schemaValidRate: 0.995 };

describe('the thresholds and the judgement of a run (ST-LLM-004, LLM BR-LLM-08)', () => {
  it('AC-ST-LLM-004-1: UAT-AC459 passes metrics at the thresholds and fails each that is not met, with injection resistance at exactly one', () => {
    expect(judgeMetrics(GOOD, DEFAULT_THRESHOLDS)).toEqual({ passed: true, failures: [] });
    expect(judgeMetrics({ ...GOOD, citationPrecision: 0.95, unsupportedClaimRate: 0.02, schemaValidRate: 0.99 }, DEFAULT_THRESHOLDS).passed).toBe(true);
    expect(judgeMetrics({ ...GOOD, injectionResistance: 0.9 }, DEFAULT_THRESHOLDS)).toEqual({ passed: false, failures: ['injection_resistance'] });
    expect(judgeMetrics({ ...GOOD, citationPrecision: 0.949, unsupportedClaimRate: 0.021, schemaValidRate: 0.98 }, DEFAULT_THRESHOLDS).failures).toEqual(['citation_precision', 'unsupported_claim_rate', 'schema_valid_rate']);
    // A figure that is not a share is never a pass.
    expect(judgeMetrics({ ...GOOD, citationPrecision: Number.NaN }, DEFAULT_THRESHOLDS).failures).toEqual(['citation_precision']);
    expect(judgeMetrics({ ...GOOD, unsupportedClaimRate: -0.1 }, DEFAULT_THRESHOLDS).failures).toEqual(['unsupported_claim_rate']);
  });

  it('lets a policy tighten the thresholds and never loosen them', () => {
    expect(parseThresholds(undefined)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds({ citation_precision_min: 0.98 }).citationPrecisionMin).toBe(0.98);
    for (const loose of [{ citation_precision_min: 0.9 }, { unsupported_claim_rate_max: 0.05 }, { injection_resistance_min: 0.99 }, { schema_valid_rate_min: 0.5 }]) {
      expect(shape(thrown(() => parseThresholds(loose)))).toEqual([422, 'VALIDATION_FAILED', 'routing_policy']);
    }
    expect(thrown(() => parseThresholds({ citation_precision_min: 2 })).detail).toBe('routing_policy');
    expect(thrown(() => parseThresholds('x')).detail).toBe('routing_policy');
  });
});

describe('the routing policy of a profile (ST-LLM-004)', () => {
  it('takes the routes a profile may use, each once, and refuses the international route for anything above public data', () => {
    expect(parseRoutingPolicy({ routes: ['DOMESTIC_HOSTED', 'INTERNATIONAL'] }, 'PUBLIC').routes).toEqual(['DOMESTIC_HOSTED', 'INTERNATIONAL']);
    expect(shape(thrown(() => parseRoutingPolicy({ routes: ['DOMESTIC_HOSTED', 'INTERNATIONAL'] }, 'INTERNAL')))).toEqual([422, 'AI_ROUTE_NOT_ALLOWED', 'routing_policy']);
    expect(parseRoutingPolicy({ routes: ['SELF_HOSTED'] }, 'IMPORTANT_CORE').routes).toEqual(['SELF_HOSTED']);
    // The whole baseline holds, not the international rule alone: the most protected data stays on the self-hosted route.
    expect(shape(thrown(() => parseRoutingPolicy({ routes: ['DOMESTIC_HOSTED'] }, 'IMPORTANT_CORE')))).toEqual([422, 'AI_ROUTE_NOT_ALLOWED', 'routing_policy']);
    expect(shape(thrown(() => parseRoutingPolicy({ routes: ['SELF_HOSTED', 'DOMESTIC_HOSTED'] }, 'IMPORTANT_CORE')))).toEqual([422, 'AI_ROUTE_NOT_ALLOWED', 'routing_policy']);
    expect(shape(thrown(() => parseRoutingPolicy({ routes: ['SELF_HOSTED'] }, 'SECRET')))).toEqual([422, 'AI_ROUTE_NOT_ALLOWED', 'routing_policy']);
    for (const bad of [null, {}, { routes: [] }, { routes: ['MOON'] }, { routes: ['SELF_HOSTED', 'SELF_HOSTED'] }, { routes: 'SELF_HOSTED' }]) {
      expect(thrown(() => parseRoutingPolicy(bad, 'PUBLIC')).detail).toBe('routing_policy');
    }
  });
});

describe('prompts (ST-LLM-004, LLM BR-LLM-10)', () => {
  const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
  const draft = { taskType: 'BID_EXTRACT', name: 'extract', templateObjectKey: 'tenants/t/prompts/extract-r5.txt', templateSha256: sha256Of('template'), inputSchema: schema, outputSchema: schema };

  it('takes a draft with a template hash and two object schemas, and refuses the rest with PROMPT_SCHEMA_INVALID naming the schema', () => {
    expect(() => assertPromptDraft(draft)).not.toThrow();
    expect(sha256Of('template')).toMatch(/^[0-9a-f]{64}$/);
    expect(shape(thrown(() => assertPromptDraft({ ...draft, outputSchema: { type: 'string' } })))).toEqual([422, 'PROMPT_SCHEMA_INVALID', 'output_schema']);
    expect(thrown(() => assertPromptDraft({ ...draft, inputSchema: { type: 'object', properties: {} } })).detail).toBe('input_schema');
    expect(thrown(() => assertPromptDraft({ ...draft, inputSchema: { ...schema, required: ['missing'] } })).detail).toBe('input_schema');
    expect(thrown(() => assertPromptDraft({ ...draft, inputSchema: null })).code).toBe('PROMPT_SCHEMA_INVALID');
    expect(thrown(() => assertPromptDraft({ ...draft, templateSha256: 'abc' })).detail).toBe('template_sha256');
    expect(thrown(() => assertPromptDraft({ ...draft, templateObjectKey: 'x' })).detail).toBe('template_object_key');
  });
});

describe('evaluation datasets (ST-LLM-004, LLM-12)', () => {
  const kase = (code: string, extra: Record<string, unknown> = {}) => ({ case_code: code, input_ref: `inputs/${code}.txt`, expected: { answer: 'x' }, ...extra });

  it('takes synthetic or anonymised cases, counts the injection ones, and gives the highest class among them', () => {
    const made = assertDatasetDraft({ datasetCode: 'EV-SUM', taskType: 'SUMMARY', source: 'SYNTHETIC', cases: [kase('c1', { classification: 'PUBLIC' }), kase('c2', { tags: ['injection'] }), kase('c3', { tags: ['injection', 'vi'] })] });
    expect(made.cases.length).toBe(3);
    expect(made.injectionCases).toBe(2);
    expect(made.maxClassification).toBe('INTERNAL');
    expect(assertDatasetDraft({ datasetCode: 'EV-PUB', taskType: 'SUMMARY', source: 'ANONYMISED', cases: [kase('c1', { classification: 'PUBLIC' })] }).maxClassification).toBe('PUBLIC');
  });

  it('refuses a case above internal as real data that was not made harmless, and names the case', () => {
    const error = thrown(() => assertDatasetDraft({ datasetCode: 'EV-SUM', taskType: 'SUMMARY', source: 'SYNTHETIC', cases: [kase('c1'), kase('c2', { classification: 'PERSONAL' })] }));
    expect(shape(error)).toEqual([409, 'EVAL_CASE_CLASSIFICATION_INVALID', 'c2']);
  });

  it('refuses real data as a source, no case, a repeated or ill-formed case and a bad tag', () => {
    const base = { datasetCode: 'EV-SUM', taskType: 'SUMMARY', source: 'SYNTHETIC', cases: [kase('c1')] };
    expect(thrown(() => assertDatasetDraft({ ...base, source: 'PRODUCTION' })).detail).toBe('source');
    expect(thrown(() => assertDatasetDraft({ ...base, cases: [] })).detail).toBe('cases');
    expect(thrown(() => assertDatasetDraft({ ...base, cases: [kase('c1'), kase('c1')] })).detail).toBe('cases');
    expect(thrown(() => assertDatasetDraft({ ...base, cases: [kase('bad code')] })).detail).toBe('cases');
    expect(thrown(() => assertDatasetDraft({ ...base, cases: [{ case_code: 'c1', input_ref: '', expected: {} }] })).detail).toBe('cases.c1.input_ref');
    expect(thrown(() => assertDatasetDraft({ ...base, cases: [{ case_code: 'c1', input_ref: 'x', expected: [] }] })).detail).toBe('cases.c1.expected');
    expect(thrown(() => assertDatasetDraft({ ...base, cases: [kase('c1', { tags: [1] })] })).detail).toBe('cases.c1.tags');
    expect(thrown(() => assertDatasetDraft({ ...base, cases: [kase('c1', { classification: 'SECRET' })] })).detail).toBe('cases.c1.classification');
    expect(thrown(() => assertDatasetDraft({ ...base, datasetCode: '!' })).detail).toBe('dataset_code');
  });
});

describe('the draft of a profile (ST-LLM-004, LLM-04)', () => {
  const draft = { effort: null, outputCap: 1000, maxInputTokens: 8000, timeoutMs: 30000, concurrencyLimit: 4, retentionDays: 90, toolAllowlist: ['search_documents'], outputSchema: { type: 'object' }, allowedModelIds: ['m1'], maxClassification: 'INTERNAL' };

  it('takes limits that are counts, tools that only read and models each once', () => {
    expect(() => assertProfileDraft(draft)).not.toThrow();
    expect(() => assertProfileDraft({ ...draft, effort: 'high' })).not.toThrow();
    expect(shape(thrown(() => assertProfileDraft({ ...draft, toolAllowlist: ['search_documents', 'delete_document'] })))).toEqual([422, 'TOOL_NOT_READ_ONLY', 'delete_document']);
    const field = (change: Partial<typeof draft>) => thrown(() => assertProfileDraft({ ...draft, ...change })).detail;
    expect(field({ outputCap: 0 })).toBe('output_cap');
    expect(field({ maxInputTokens: 1.5 })).toBe('max_input_tokens');
    expect(field({ timeoutMs: 3_000_000_000 })).toBe('timeout_ms');
    expect(field({ concurrencyLimit: -1 })).toBe('concurrency_limit');
    expect(field({ retentionDays: 0 })).toBe('retention_days');
    expect(field({ effort: 'extreme' as never })).toBe('effort');
    expect(field({ maxClassification: 'SECRET' })).toBe('max_classification');
    expect(field({ outputSchema: [] as never })).toBe('output_schema');
    expect(field({ allowedModelIds: [] })).toBe('allowed_model_ids');
    expect(field({ allowedModelIds: ['m1', 'm1'] })).toBe('allowed_model_ids');
    expect(field({ toolAllowlist: ['search_documents', 'search_documents'] })).toBe('tool_allowlist');
  });
});

describe('the gate of the release (ST-LLM-004, LLM BR-LLM-08)', () => {
  const run = (id: string, route: RunView['route'], status: RunView['status'], passed: boolean | null = true): RunView => ({ id, route, status, passed });
  const base: GateInput = { routes: ['DOMESTIC_HOSTED', 'INTERNATIONAL'], runs: [], modelStatuses: [{ id: 'm1', status: 'APPROVED', supportsEffort: true }], effort: null, createdBy: 'drafter', actor: 'publisher' };

  it('AC-ST-LLM-004-3: UAT-NFR-AI-04 asks for an evaluation when there is none at all', () => {
    expect(releaseGate(base)).toEqual({ ok: false, code: 'EVAL_REQUIRED', detail: 'eval_run' });
    expect(releaseGate({ ...base, runs: [run('old', 'DOMESTIC_HOSTED', 'SUPERSEDED')] }).ok).toBe(false);
    expect((releaseGate({ ...base, runs: [run('old', 'DOMESTIC_HOSTED', 'SUPERSEDED')] }) as { code: string }).code).toBe('EVAL_REQUIRED');
  });

  it('AC-ST-LLM-004-1: UAT-AC459 refuses a route with no signed evaluation, then one whose evaluation failed, and publishes when each route has a signed pass', () => {
    const domestic = run('d1', 'DOMESTIC_HOSTED', 'SIGNED_PASS');
    expect(releaseGate({ ...base, runs: [domestic] })).toEqual({ ok: false, code: 'EVAL_MISSING_FOR_ROUTE', detail: 'INTERNATIONAL' });
    // An evaluation that is run and not yet signed is not one.
    expect(releaseGate({ ...base, runs: [domestic, run('i1', 'INTERNATIONAL', 'PENDING_SIGNATURE')] })).toEqual({ ok: false, code: 'EVAL_MISSING_FOR_ROUTE', detail: 'INTERNATIONAL' });
    expect(releaseGate({ ...base, runs: [domestic, run('i1', 'INTERNATIONAL', 'SIGNED_FAIL', false)] })).toEqual({ ok: false, code: 'EVAL_NOT_PASSED', detail: 'INTERNATIONAL' });
    // A pass signed over metrics that did not meet the thresholds is not a pass either.
    expect(releaseGate({ ...base, runs: [domestic, run('i1', 'INTERNATIONAL', 'SIGNED_PASS', false)] })).toMatchObject({ ok: false, code: 'EVAL_NOT_PASSED' });
    expect(releaseGate({ ...base, runs: [domestic, run('i1', 'INTERNATIONAL', 'SIGNED_PASS')] })).toEqual({ ok: true, evidence: ['d1', 'i1'] });
    // Dropping the international route (r4) leaves a profile that needs the domestic pass only.
    expect(releaseGate({ ...base, routes: ['DOMESTIC_HOSTED'], runs: [domestic, run('i1', 'INTERNATIONAL', 'SIGNED_FAIL', false)] })).toEqual({ ok: true, evidence: ['d1'] });
  });

  it('AC-ST-LLM-004-1: UAT-AC459 judges a route by its newest evaluation: an older pass does not release it once it was evaluated again and that run is not signed as passed', () => {
    const oldPass = run('d-old', 'DOMESTIC_HOSTED', 'SIGNED_PASS');
    const intl = run('i1', 'INTERNATIONAL', 'SIGNED_PASS');
    // The runs come newest first, as the store reads them.
    expect(releaseGate({ ...base, runs: [run('d-new', 'DOMESTIC_HOSTED', 'PENDING_SIGNATURE'), oldPass, intl] })).toEqual({ ok: false, code: 'EVAL_MISSING_FOR_ROUTE', detail: 'DOMESTIC_HOSTED' });
    expect(releaseGate({ ...base, runs: [run('d-new', 'DOMESTIC_HOSTED', 'FAILED', null), oldPass, intl] })).toEqual({ ok: false, code: 'EVAL_MISSING_FOR_ROUTE', detail: 'DOMESTIC_HOSTED' });
    expect(releaseGate({ ...base, runs: [run('d-new', 'DOMESTIC_HOSTED', 'SIGNED_FAIL', false), oldPass, intl] })).toEqual({ ok: false, code: 'EVAL_NOT_PASSED', detail: 'DOMESTIC_HOSTED' });
    expect(releaseGate({ ...base, runs: [run('d-new', 'DOMESTIC_HOSTED', 'SIGNED_PASS'), run('d-fail', 'DOMESTIC_HOSTED', 'SIGNED_FAIL', false), intl] })).toEqual({ ok: true, evidence: ['d-new', 'i1'] });
  });

  it('judges the models and the parameters before the evaluations, and the person last', () => {
    const passing = [run('d1', 'DOMESTIC_HOSTED', 'SIGNED_PASS'), run('i1', 'INTERNATIONAL', 'SIGNED_PASS')];
    expect(releaseGate({ ...base, runs: passing, modelStatuses: [{ id: 'm1', status: 'APPROVED', supportsEffort: true }, { id: 'm2', status: 'PROPOSED', supportsEffort: true }] })).toEqual({ ok: false, code: 'MODEL_NOT_APPROVED', detail: 'm2' });
    expect(releaseGate({ ...base, runs: passing, effort: 'high', modelStatuses: [{ id: 'm1', status: 'APPROVED', supportsEffort: false }] })).toEqual({ ok: false, code: 'UNSUPPORTED_PARAMETER', detail: 'effort' });
    expect(releaseGate({ ...base, runs: passing, effort: 'high' }).ok).toBe(true);
    expect(releaseGate({ ...base, runs: passing, actor: 'drafter' })).toEqual({ ok: false, code: 'SELF_APPROVAL_DENIED', detail: 'created_by' });
    expect(releaseGate({ ...base, runs: [], actor: 'drafter' })).toMatchObject({ code: 'EVAL_REQUIRED' });
  });

  it('AC-ST-LLM-004-1: UAT-AC459 lets an expert sign a finished run as a pass only when its metrics passed, and never the person who started it', () => {
    const finished = { status: 'PENDING_SIGNATURE', passed: true, finished: true };
    expect(() => assertSignable(finished, 'PASS', 'starter', 'expert')).not.toThrow();
    expect(() => assertSignable({ ...finished, passed: false }, 'FAIL', 'starter', 'expert')).not.toThrow();
    expect(shape(thrown(() => assertSignable({ ...finished, passed: false }, 'PASS', 'starter', 'expert')))).toEqual([422, 'EVAL_NOT_PASSED', 'metrics']);
    expect(shape(thrown(() => assertSignable(finished, 'PASS', 'expert', 'expert')))).toEqual([403, 'SELF_APPROVAL_DENIED', undefined]);
    expect(thrown(() => assertSignable({ ...finished, finished: false }, 'PASS', 'starter', 'expert')).code).toBe('EVAL_NOT_FINISHED');
    expect(thrown(() => assertSignable({ ...finished, status: 'FAILED' }, 'PASS', 'starter', 'expert')).code).toBe('EVAL_NOT_FINISHED');
    expect(thrown(() => assertSignable({ ...finished, status: 'SIGNED_PASS' }, 'PASS', 'starter', 'expert')).code).toBe('STAGE_TRANSITION_DENIED');
  });
});
