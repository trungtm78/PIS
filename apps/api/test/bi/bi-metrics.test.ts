import { ANALYST, BiApp, DATASET, DEPRECATED_DATASET, NOBODY, PIPELINE, READER, SCOPED, TENANT_A, TENANT_B } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(120_000);

const app = new BiApp();
const field = (name: string) => ({ op: 'field', name });
const sum = (name: string) => ({ op: 'sum', args: [field(name)] });
const RATE = { code: 'disbursement_rate', grain: 'project', aggregation_type: 'ratio', numerator: sum('GIAI_NGAN'), denominator: sum('KE_HOACH_TTG'), unit: 'percent', null_policy: 'NULL_NOT_ZERO', effective_from: '2026-01-01' };
const BALANCE = { code: 'capital_balance', grain: 'fund', aggregation_type: 'semi_additive', expression: sum('SO_DU'), unit: 'VND', effective_from: '2026-01-01' };

const sync = async (metrics: unknown[], commit = 'c1a2b3c', member = PIPELINE, tenantId?: string): Promise<{ reply: Reply; sha256: string }> => {
  const { key, sha256 } = await app.bundle(metrics, tenantId);
  const reply = await app.call('POST', '/bi/metric-registry-syncs', { member, body: { source_commit: commit, bundle_object_key: key, bundle_sha256: sha256 }, ...(tenantId === undefined ? {} : { tenantId }) });
  return { reply, sha256 };
};
const draftBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  code: 't_rate',
  grain: 'project',
  aggregation_type: 'ratio',
  expression_ast: { op: 'div', args: [sum('A'), sum('B')] },
  numerator_ast: sum('A'),
  denominator_ast: sum('B'),
  unit: 'percent',
  null_policy: 'NULL_NOT_ZERO',
  dimension_codes: ['unit'],
  dataset_id: DATASET,
  effective_from: '2026-01-01',
  ...overrides,
});
const draft = (overrides: Record<string, unknown> = {}, member = ANALYST, tenantId?: string): Promise<Reply> =>
  app.call('POST', '/bi/metric-definitions', { member, body: draftBody(overrides), ...(tenantId === undefined ? {} : { tenantId }) });
const list = (query = '', member = READER, tenantId?: string): Promise<Reply> => app.call('GET', `/resources/metric_definition${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
const runs = () =>
  app.harness.owner<{ status: string; source_commit: string; added_count: number; revised_count: number; retired_count: number; error_json: { code: string; detail: string | null } | null }>(TENANT_A, [
    ['select status, source_commit, added_count, revised_count, retired_count, error_json from machvon.bi_metric_sync_run order by created_at, id'],
  ]);
const rows = (code: string) =>
  app.harness.owner<{ revision: number; status: string; origin: string; source_commit: string | null; definition_sha256: string | null; effective_until: string | null; certified_by: string | null }>(TENANT_A, [
    ['select revision, status, origin, source_commit, definition_sha256, effective_until::text as effective_until, certified_by from machvon.metric_definition where code = $1 order by revision', [code]],
  ]);

describe('the registry of metrics (ST-BI-001, BI F1)', () => {
  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);
  beforeEach(() => app.reset());

  describe('the sync of the metrics of the platform', () => {
    it('AC-ST-BI-001-1: UAT-AC471 applies a bundle with its commit and the hash of its definition, takes the same bundle as NO_CHANGE, refuses a tenant that edits the metric, and refuses a changed denominator under the same code', async () => {
      const first = await sync([RATE]);
      expect(first.reply.status).toBe(200);
      expect(first.reply.json).toMatchObject({ status: 'APPLIED', added: 1, revised: 0, retired: 0 });
      const [applied] = await rows('disbursement_rate');
      expect(applied).toMatchObject({ revision: 1, status: 'CERTIFIED', origin: 'PLATFORM_CODE', source_commit: 'c1a2b3c', certified_by: null });
      expect(applied?.definition_sha256).toMatch(/^[0-9a-f]{64}$/);

      // The same bundle again: NO_CHANGE, and no revision.
      const again = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'c1a2b3c', bundle_object_key: (await app.bundle([RATE])).key, bundle_sha256: first.sha256 } });
      expect(again.json).toMatchObject({ status: 'NO_CHANGE', added: 0, revised: 0, retired: 0 });
      expect(await rows('disbursement_rate')).toHaveLength(1);

      // A tenant admin edits the metric of the platform under its code.
      const edited = await draft({ code: 'disbursement_rate' });
      expect([edited.status, edited.json.code]).toEqual([422, 'PLATFORM_METRIC_READ_ONLY']);

      // A later commit changes the denominator and keeps the code and the day.
      const changed = await sync([{ ...RATE, denominator: sum('KE_HOACH_TONG') }], 'c4d5e6f');
      expect([changed.reply.status, changed.reply.json.code]).toEqual([422, 'BREAKING_CHANGE_WITHOUT_NEW_CODE']);
      expect(await rows('disbursement_rate')).toHaveLength(1);
      expect((await runs()).map((run) => [run.status, run.source_commit])).toEqual([['APPLIED', 'c1a2b3c'], ['NO_CHANGE', 'c1a2b3c'], ['REJECTED', 'c4d5e6f']]);
      expect((await runs())[2]?.error_json).toEqual({ code: 'BREAKING_CHANGE_WITHOUT_NEW_CODE', detail: 'disbursement_rate' });
    });

    it('takes a change of what a number means as the next revision when it starts on a later day, supersedes the revision it replaces, and keeps both', async () => {
      await sync([RATE]);
      const later = await sync([{ ...RATE, denominator: sum('KE_HOACH_TONG'), effective_from: '2027-01-01' }], 'a1b2c3d');
      expect(later.reply.json).toMatchObject({ status: 'APPLIED', added: 0, revised: 1, retired: 0 });
      const both = await rows('disbursement_rate');
      expect(both.map((row) => [row.revision, row.status, row.effective_until])).toEqual([[1, 'SUPERSEDED', '2027-01-01'], [2, 'CERTIFIED', null]]);
      expect(both[1]?.source_commit).toBe('a1b2c3d');
      // Anything that does not change the meaning is a revision at once: here the dimensions and the null policy.
      const relabelled = await sync([{ ...RATE, denominator: sum('KE_HOACH_TONG'), effective_from: '2027-01-01', dimensions: ['unit'], null_policy: 'ZERO_IF_NO_ROWS' }], 'e5f6a7b');
      expect(relabelled.reply.json).toMatchObject({ status: 'APPLIED', revised: 1 });
      expect((await rows('disbursement_rate')).map((row) => [row.revision, row.status])).toEqual([[1, 'SUPERSEDED'], [2, 'SUPERSEDED'], [3, 'CERTIFIED']]);
    });

    it('retires a code that left the bundle, and brings it back as the next revision when it returns', async () => {
      await sync([RATE, BALANCE]);
      const without = await sync([BALANCE], 'b2c3d4e');
      expect(without.reply.json).toMatchObject({ status: 'APPLIED', retired: 1 });
      const [retired] = await rows('disbursement_rate');
      expect(retired?.status).toBe('RETIRED');
      expect(retired?.effective_until).not.toBeNull();
      const back = await sync([RATE, BALANCE], 'c3d4e5f');
      expect(back.reply.json).toMatchObject({ status: 'APPLIED', revised: 1 });
      expect((await rows('disbursement_rate')).map((row) => [row.revision, row.status])).toEqual([[1, 'RETIRED'], [2, 'CERTIFIED']]);
      expect((await rows('capital_balance')).map((row) => row.revision)).toEqual([1]);
    });

    it('applies the bytes of an older bundle again when they come from a revert commit, and takes the same old commit sent again as the same deploy', async () => {
      const first = await sync([RATE], 'deploy01');
      await sync([BALANCE], 'deploy02');
      expect((await rows('disbursement_rate')).map((row) => row.status)).toEqual(['RETIRED']);
      const revert = await sync([RATE], 'revert01');
      expect(revert.sha256).toBe(first.sha256);
      expect(revert.reply.json).toMatchObject({ status: 'APPLIED', revised: 1 });
      expect((await rows('disbursement_rate')).map((row) => [row.revision, row.status])).toEqual([[1, 'RETIRED'], [2, 'CERTIFIED']]);
      // The first deploy sent again, after all that, changes nothing: it was applied.
      const replay = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'deploy01', bundle_object_key: (await app.bundle([RATE])).key, bundle_sha256: first.sha256 } });
      expect(replay.json).toMatchObject({ status: 'NO_CHANGE' });
      expect((await rows('disbursement_rate')).map((row) => row.status)).toEqual(['RETIRED', 'CERTIFIED']);
    });

    it('refuses a bundle whose hash is not the hash of its bytes, a metric that is not valid and a bundle that is not stored, and keeps each refusal as a run', async () => {
      const stored = await app.bundle([RATE]);
      const wrong = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'badhash1', bundle_object_key: stored.key, bundle_sha256: '0'.repeat(64) } });
      expect([wrong.status, wrong.json.code]).toEqual([422, 'BUNDLE_HASH_MISMATCH']);
      const invalid = await sync([{ ...RATE, unit: '' }], 'badmetr');
      expect([invalid.reply.status, invalid.reply.json.code]).toEqual([422, 'METRIC_DEFINITION_INVALID']);
      const raw = await sync([{ ...BALANCE, expression: { op: 'raw_sql', sql: 'select 1' } }], 'badtree');
      expect([raw.reply.status, raw.reply.json.code]).toEqual([422, 'METRIC_DEFINITION_INVALID']);
      const missing = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'missing1', bundle_object_key: `${stored.key.slice(0, -4)}0000`, bundle_sha256: 'a'.repeat(64) } });
      expect(missing.status).toBe(404);
      expect((await runs()).map((run) => [run.status, run.source_commit, run.error_json?.code ?? null])).toEqual([
        ['REJECTED', 'badhash1', 'BUNDLE_HASH_MISMATCH'],
        ['REJECTED', 'badmetr', 'METRIC_DEFINITION_INVALID'],
        ['REJECTED', 'badtree', 'METRIC_DEFINITION_INVALID'],
        ['REJECTED', 'missing1', 'RESOURCE_NOT_FOUND'],
      ]);
      expect(await app.count('select count(*)::text as n from machvon.metric_definition')).toBe(0);
    });

    it('takes a deploy that found nothing to change as processed: sent again after a later deploy removed the metric, it does not bring it back', async () => {
      await sync([RATE], 'deploy-a');
      const unchanged = await sync([RATE], 'deploy-b');
      expect(unchanged.reply.json).toMatchObject({ status: 'NO_CHANGE' });
      await sync([BALANCE], 'deploy-c');
      expect((await rows('disbursement_rate')).map((row) => row.status)).toEqual(['RETIRED']);
      const replay = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'deploy-b', bundle_object_key: (await app.bundle([RATE])).key, bundle_sha256: unchanged.sha256 } });
      expect(replay.json).toMatchObject({ status: 'NO_CHANGE' });
      expect((await rows('disbursement_rate')).map((row) => row.status)).toEqual(['RETIRED']);
    });

    it('answers a refused sync again to the same key, audits it, and lets the same commit be sent once what refused it is put right', async () => {
      const stored = await app.bundle([RATE]);
      const body = { source_commit: 'refused1', bundle_object_key: stored.key, bundle_sha256: '0'.repeat(64) };
      const first = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body, key: 'refused-key-0001' });
      const again = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body, key: 'refused-key-0001' });
      expect([first.status, first.json.code]).toEqual([422, 'BUNDLE_HASH_MISMATCH']);
      expect([again.status, again.json.code]).toEqual([422, 'BUNDLE_HASH_MISMATCH']);
      expect((await runs()).map((run) => run.status)).toEqual(['REJECTED']);
      const audited = await app.harness.owner<{ action: string }>(TENANT_A, [["select action from machvon.audit_event where resource_id = (select id from machvon.bi_metric_sync_run where source_commit = 'refused1')"]]);
      expect(audited).toHaveLength(1);
      const fixed = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { ...body, bundle_sha256: stored.sha256 } });
      expect(fixed.json).toMatchObject({ status: 'APPLIED', added: 1 });
    });

    it('serializes two syncs of one bundle: one applies it and the other finds it applied', async () => {
      const { key, sha256 } = await app.bundle([RATE, BALANCE]);
      const send = (suffix: string) => app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: `racing-${suffix}`, bundle_object_key: key, bundle_sha256: sha256 } });
      const replies = await Promise.all([send('a'), send('b')]);
      expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
      expect(replies.map((reply) => reply.json.status).sort()).toEqual(['APPLIED', 'NO_CHANGE']);
      expect(await app.count('select count(*)::text as n from machvon.metric_definition')).toBe(2);
    });

    it('audits and announces what was applied, with the commit and the codes, and replays an idempotent call without a second run', async () => {
      const { key, sha256 } = await app.bundle([RATE]);
      const body = { source_commit: 'audited1', bundle_object_key: key, bundle_sha256: sha256 };
      const first = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body, key: 'sync-idempotent-0001' });
      const replay = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body, key: 'sync-idempotent-0001' });
      expect(replay.json).toEqual(first.json);
      expect(await app.count('select count(*)::text as n from machvon.bi_metric_sync_run')).toBe(1);
      const id = first.json.resource_id as string;
      const audited = await app.harness.owner<{ action: string; outcome: string }>(TENANT_A, [['select action, outcome from machvon.audit_event where resource_id = $1', [id]]]);
      expect(audited.map((row) => [row.action, row.outcome])).toEqual([['bi.metric_registry_synced', 'SUCCESS']]);
      const events = await app.harness.owner<{ type: string; payload: { added: string[]; source_commit: string } }>(TENANT_A, [['select type, payload from machvon.outbox_event where aggregate_id = $1', [id]]]);
      expect(events.map((row) => row.type)).toEqual(['bi.metric_registry.synced.v1']);
      expect(events[0]?.payload).toMatchObject({ added: ['disbursement_rate'], source_commit: 'audited1' });
    });
  });

  describe('the metrics a tenant drafts', () => {
    it('AC-ST-BI-001-2: UAT-AC472 refuses a ratio without a denominator and an expression with a raw_sql node, and drafts a valid metric under the t_ prefix', async () => {
      const noDenominator = await draft({ denominator_ast: undefined });
      expect([noDenominator.status, noDenominator.json.code]).toEqual([422, 'RATIO_REQUIRES_NUMERATOR_DENOMINATOR']);
      const rawSql = await draft({ aggregation_type: 'additive', numerator_ast: undefined, denominator_ast: undefined, expression_ast: { op: 'raw_sql', sql: 'select * from payment_request' } });
      expect([rawSql.status, rawSql.json.code]).toEqual([422, 'EXPRESSION_NOT_ALLOWED']);
      expect(await app.count('select count(*)::text as n from machvon.metric_definition')).toBe(0);
      const made = await draft();
      expect(made.status).toBe(200);
      expect(made.json).toMatchObject({ status: 'DRAFT', code: 't_rate', revision: 1 });
      const [row] = await rows('t_rate');
      expect(row).toMatchObject({ revision: 1, status: 'DRAFT', origin: 'TENANT_UI', source_commit: null, definition_sha256: null, certified_by: null });
    });

    it('gives the next revision to a code the tenant drafted before, and keeps a draft per revision', async () => {
      await draft();
      const second = await draft({ grain: 'unit' });
      expect(second.json).toMatchObject({ revision: 2 });
      expect((await rows('t_rate')).map((row) => row.revision)).toEqual([1, 2]);
    });

    it('refuses a code without the t_ prefix, a dataset that does not exist or is deprecated, and a dimension the dataset does not offer', async () => {
      const prefix = await draft({ code: 'free_rate' });
      expect([prefix.status, prefix.json.code, prefix.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'code']);
      expect((await draft({ code: 't_' })).status).toBe(422);
      const nowhere = await draft({ dataset_id: '00000000-0000-4000-8000-0000000000ee' });
      expect([nowhere.status, nowhere.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const old = await draft({ dataset_id: DEPRECATED_DATASET });
      expect([old.status, old.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const foreign = await draft({ dimension_codes: ['contractor_tax_id'] });
      expect([foreign.status, foreign.json.code]).toEqual([422, 'DIMENSION_NOT_IN_DATASET']);
      const stranger = await draft({ glossary_term_id: '00000000-0000-4000-8000-0000000000ee' });
      expect([stranger.status, stranger.json.code, stranger.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'glossary_term_id']);
      const contradicting = await draft({ expression_ast: { op: 'const', value: 1 } });
      expect([contradicting.status, contradicting.json.code]).toEqual([422, 'METRIC_DEFINITION_INVALID']);
      const bad = await draft({ unit: ' ' });
      expect([bad.status, bad.json.code]).toEqual([422, 'METRIC_DEFINITION_INVALID']);
      expect(await app.count('select count(*)::text as n from machvon.metric_definition')).toBe(0);
    });

    it('audits and announces the draft', async () => {
      const made = await draft();
      const id = made.json.resource_id as string;
      const audited = await app.harness.owner<{ action: string }>(TENANT_A, [['select action from machvon.audit_event where resource_id = $1', [id]]]);
      expect(audited.map((row) => row.action)).toEqual(['bi.metric_drafted']);
      const events = await app.harness.owner<{ type: string }>(TENANT_A, [['select type from machvon.outbox_event where aggregate_id = $1', [id]]]);
      expect(events.map((row) => row.type)).toEqual(['bi.metric.drafted.v1']);
    });
  });

  describe('the catalogue', () => {
    it('lists the revisions by code with where they come from, narrowed by origin, status and code, and opens one', async () => {
      await sync([RATE, BALANCE]);
      await draft();
      const all = await list();
      expect(all.status).toBe(200);
      expect(items(all).map((item) => [item.code, item.origin, item.status])).toEqual([
        ['capital_balance', 'PLATFORM_CODE', 'CERTIFIED'],
        ['disbursement_rate', 'PLATFORM_CODE', 'CERTIFIED'],
        ['t_rate', 'TENANT_UI', 'DRAFT'],
      ]);
      expect(items(await list('?origin=TENANT_UI')).map((item) => item.code)).toEqual(['t_rate']);
      expect(items(await list('?status=DRAFT')).map((item) => item.code)).toEqual(['t_rate']);
      expect(items(await list('?code=disbursement_rate')).map((item) => item.code)).toEqual(['disbursement_rate']);
      const rate = items(all)[1] as Record<string, unknown>;
      expect(rate).toMatchObject({ source_commit: 'c1a2b3c', aggregation_type: 'ratio', unit: 'percent', null_policy: 'NULL_NOT_ZERO', denominator_ast: sum('KE_HOACH_TTG'), numerator_ast: sum('GIAI_NGAN'), effective_from: '2026-01-01' });
      expect(rate.definition_sha256).toMatch(/^[0-9a-f]{64}$/);
      const one = await app.call('GET', `/resources/metric_definition/${rate.id as string}`, { member: READER });
      expect(one.json).toMatchObject({ id: rate.id, code: 'disbursement_rate' });
    });

    it('pages by code and revision without repeating or skipping a revision', async () => {
      await sync([RATE, BALANCE]);
      await draft();
      await draft({ grain: 'unit' });
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 6; page += 1) {
        const reply = await list(`?limit=2${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
        seen.push(...items(reply).map((item) => `${item.code as string}#${item.revision as number}`));
        if (reply.json.next_cursor === null) break;
        cursor = reply.json.next_cursor as string;
      }
      expect(seen).toEqual(['capital_balance#1', 'disbursement_rate#1', 't_rate#1', 't_rate#2']);
    });

    it('refuses a filter it does not know, a cursor that is not its own, and an id that is not there', async () => {
      expect((await list('?origin=SOMEWHERE')).status).toBe(422);
      expect((await list('?status=GONE')).status).toBe(422);
      expect((await list('?code=Not A Code')).status).toBe(422);
      expect((await list('?cursor=bm90LWEtY3Vyc29y')).status).toBe(422);
      expect((await app.call('GET', '/resources/metric_definition/00000000-0000-4000-8000-0000000000ff', { member: READER })).status).toBe(404);
    });
  });

  describe('who may do what', () => {
    it('keeps the sync to the pipeline and the draft to the data owner, over the whole tenant', async () => {
      const { key, sha256 } = await app.bundle([RATE]);
      const body = { source_commit: 'denied01', bundle_object_key: key, bundle_sha256: sha256 };
      for (const member of [ANALYST, READER, NOBODY, SCOPED]) {
        expect((await app.call('POST', '/bi/metric-registry-syncs', { member, body })).status).toBe(403);
      }
      for (const member of [PIPELINE, READER, NOBODY, SCOPED]) {
        expect((await draft({}, member)).status).toBe(403);
      }
      expect(await app.count('select count(*)::text as n from machvon.bi_metric_sync_run')).toBe(0);
      expect(await app.count('select count(*)::text as n from machvon.metric_definition')).toBe(0);
    });

    it('lets those with the right to read the catalogue read it, and nobody else', async () => {
      await sync([RATE]);
      for (const member of [PIPELINE, ANALYST, READER]) expect((await list('', member)).status).toBe(200);
      for (const member of [NOBODY]) expect((await list('', member)).status).toBe(403);
    });

    it('keeps each tenant to its own registry: a bundle of one tenant is not found by another, and a metric of one is not seen by the other', async () => {
      const { key, sha256 } = await app.bundle([RATE]);
      const foreign = await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, tenantId: TENANT_B, body: { source_commit: 'foreign1', bundle_object_key: key, bundle_sha256: sha256 } });
      expect(foreign.status).toBe(404);
      await sync([RATE]);
      expect(items(await list('', PIPELINE, TENANT_B))).toEqual([]);
      const own = await sync([RATE], 'tenantb1', PIPELINE, TENANT_B);
      expect(own.reply.json).toMatchObject({ status: 'APPLIED' });
      expect(items(await list('', PIPELINE, TENANT_B)).map((item) => item.code)).toEqual(['disbursement_rate']);
      expect(items(await list()).map((item) => item.source_commit)).toEqual(['c1a2b3c']);
    });
  });
});
