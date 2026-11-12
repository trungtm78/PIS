import { createHash } from 'node:crypto';
import { pdfWithText } from '../pdf.ts';
import type { Obj, SeedContext } from './context.ts';

/**
 * DEMO ONLY, not registered in GROUPS and not part of any dataset. Registry data the AI gateway needs so that the assistant (LLM-22) and the
 * playground (LLM-11) can be shown with a real model: the provider "Anthropic" on the INTERNATIONAL route (public data only), two approved models,
 * their price versions, a published routing policy, one published profile per task type of the assistant, a tenant budget and ONE public source document.
 *
 * Everything goes through the commands of the product as the people of the guide (maker is not checker). It is safe to run twice.
 * Only PUBLIC data may be sent to the external provider: the only document it creates is a summary of figures already published, and the policy
 * of the product itself refuses any source of a higher class on this route (records of projects and contracts are CONFIDENTIAL and never go).
 *
 * Run (from apps/web, with the key the stack was started with):
 *   E2E_STACK_INFO=<stack dir>\stack-info.json E2E_SESSION_KEY=<DEMO_SESSION_KEY> node --experimental-strip-types e2e/hdsd/seed/ai-demo-run.ts
 */

const MAKER = 'projectManager';
const CHECKER = 'capApprover';
const PROVIDER_CODE = 'ANTHROPIC';
const MODELS = [
  // The price lists are indicative demo values (USD per million tokens), to be replaced by the contract price.
  { id: 'claude-sonnet-5-5', input: '3.00', cached: '0.30', output: '15.00' },
  { id: 'claude-haiku-5-5', input: '1.00', cached: '0.10', output: '5.00' },
];
const TASKS = ['AI_ASSIST_QA', 'AI_ASSIST_SUMMARY', 'AI_ASSIST_DRAFT_NOTE'] as const;

const MATRIX = {
  PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'],
  INTERNAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  CONFIDENTIAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  PERSONAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  IMPORTANT_CORE: ['SELF_HOSTED'],
};

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const str = (value: unknown): string => String(value);

const CITATION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['DOCUMENT_VERSION', 'PROJECT', 'CONTRACT', 'APPRAISAL'] },
    id: { type: 'string', format: 'uuid' },
    locator: { type: 'string', minLength: 1, maxLength: 80 },
    quote: { type: 'string', maxLength: 400 },
  },
  required: ['kind', 'id', 'locator'],
  additionalProperties: false,
};

/** The answer contract of the assistant for the kinds without extra fields (the same shape as assistOutputSchema in packages/kernel). */
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    statements: {
      type: 'array',
      maxItems: 60,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^s[0-9]{1,3}$' },
          text: { type: 'string', minLength: 1, maxLength: 1500 },
          basis: { type: 'string', enum: ['SOURCE', 'ASSUMPTION', 'INFERENCE'] },
          citations: { type: 'array', maxItems: 5, items: CITATION_SCHEMA },
          depends_on: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^s[0-9]{1,3}$' } },
        },
        required: ['id', 'text', 'basis', 'citations'],
        additionalProperties: false,
      },
    },
    open_questions: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 500 } },
  },
  required: ['statements'],
  additionalProperties: false,
};

async function rows(ctx: SeedContext, path: string): Promise<Obj[]> {
  try {
    return await ctx.list(MAKER, path);
  } catch {
    return [];
  }
}

async function ensureProvider(ctx: SeedContext): Promise<void> {
  const existing = (await rows(ctx, '/ai-providers')).find((row) => row.provider_code === PROVIDER_CODE);
  if (existing !== undefined && existing.status === 'ACTIVE') return;
  const made = existing ?? (await ctx.command(MAKER, '/ai-providers', { provider_code: PROVIDER_CODE, name: 'Anthropic (Claude)', region_country: 'US', route_class: 'INTERNATIONAL', max_classification: 'PUBLIC' }));
  const id = str(existing?.id ?? (made as Obj).resource_id);
  let version = Number(existing?.version ?? (made as Obj).resource_version);
  if (existing?.no_training_attested !== true) {
    // Demo record of the data-handling attestation; the real one is the signed agreement with the provider (replace it before any real data).
    const attested = await ctx.command(MAKER, `/ai-providers/${id}/attestation`, { data_location_country: 'US', no_training_attested: true, attestation_ref: 'DEMO-DPA-ANTHROPIC-2026' }, { version });
    version = Number(attested.resource_version);
  }
  await ctx.command(CHECKER, `/ai-providers/${id}/activation`, { d07_approval_ref: 'D07-2026-DEMO' }, { version });
}

async function ensurePolicy(ctx: SeedContext): Promise<void> {
  const published = (await rows(ctx, '/ai-classification-policies')).find((row) => row.status === 'PUBLISHED' && row.international_enabled === true);
  if (published !== undefined) return;
  const drafted = await ctx.command(MAKER, '/ai-classification-policies', {
    matrix: MATRIX,
    international_enabled: true,
    d07_approval_ref: 'D07-2026-DEMO',
    legal_basis: 'Demo: the international route is open for public data only',
    effective_from: `${ctx.day(-30)}T00:00:00.000Z`,
  });
  await ctx.command(CHECKER, `/ai-classification-policies/${drafted.resource_id}/publish`, {}, { version: drafted });
}

/** The enterprise edition routes to an external provider only under an approved exception (public data only here, valid for a limited time). */
async function ensureException(ctx: SeedContext): Promise<void> {
  const provider = (await rows(ctx, '/ai-providers')).find((row) => row.provider_code === PROVIDER_CODE);
  const providerId = str(provider?.id);
  const open = (await rows(ctx, '/ai/external-exceptions')).find((row) => row.provider_id === providerId && row.status === 'APPROVED');
  if (open !== undefined) return;
  const asked = await ctx.command(MAKER, '/ai/external-exceptions', {
    provider_id: providerId,
    max_classification: 'PUBLIC',
    reason: 'Demo of the AI assistant with a real model: only public, already published figures are sent, and no internal or confidential record.',
    valid_days: 30,
  });
  await ctx.command(CHECKER, `/ai/external-exceptions/${asked.resource_id}/decision`, { decision: 'APPROVE', approval_ref: 'DEMO-EXC-2026-01' }, { version: asked });
}


async function ensureModels(ctx: SeedContext): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const existing = await rows(ctx, '/ai-models');
  const prices = await rows(ctx, '/ai-pricing-versions');
  for (const model of MODELS) {
    let row = existing.find((entry) => entry.model_id === model.id);
    if (row === undefined) {
      const providers = await rows(ctx, '/ai-providers');
      const providerId = str(providers.find((entry) => entry.provider_code === PROVIDER_CODE)?.id);
      const made = await ctx.command(MAKER, '/ai-models', { provider_id: providerId, model_id: model.id, capabilities: {}, context_window: 200000, max_output: 8000, max_classification: 'PUBLIC' });
      await ctx.command(CHECKER, `/ai-models/${made.resource_id}/approval`, {}, { version: made });
      row = { id: made.resource_id };
    } else if (row.status !== 'APPROVED') {
      await ctx.command(CHECKER, `/ai-models/${row.id}/approval`, {}, { version: Number(row.version) });
    }
    const modelRef = str(row.id);
    ids.set(model.id, modelRef);
    if (!prices.some((entry) => entry.model_ref_id === modelRef || entry.model_id === model.id)) {
      await ctx.command(MAKER, '/ai-pricing-versions', {
        provider: 'Anthropic',
        model_id: model.id,
        model_ref_id: modelRef,
        currency: 'USD',
        effective_from: `${ctx.day(-30)}T00:00:00.000Z`,
        input_per_million: model.input,
        cached_per_million: model.cached,
        output_per_million: model.output,
        cached_semantics: 'INCLUDED_IN_INPUT',
        reasoning_in_output: true,
        source_url: 'https://www.anthropic.com/pricing',
        fx_rate_to_vnd: '25400',
        fx_source: 'Demo rate, indicative',
      });
    }
  }
  return ids;
}

async function ensureBudget(ctx: SeedContext): Promise<void> {
  if ((await rows(ctx, '/ai-budgets')).some((row) => row.scope_kind === 'TENANT')) return;
  await ctx.command(MAKER, '/ai-budgets', { scope_kind: 'TENANT', period: 'MONTH', limit_vnd: '20000000', hard_stop: true, effective_from: ctx.day(-30) });
}

/** One approved prompt, one dataset, one profile with a signed passing evaluation on the international route, and the publication, for a task type. */
async function ensureProfile(ctx: SeedContext, task: string, models: Map<string, string>): Promise<string> {
  const profiles = await rows(ctx, '/resources/model_profile_version');
  const published = profiles.find((row) => row.task_type === task && row.status === 'PUBLISHED');
  if (published !== undefined) return str(published.id);

  const key = task.toLowerCase();
  const prompt = await ctx.command(MAKER, '/ai-prompts', {
    task_type: task,
    name: `${key}-demo`,
    template_object_key: `tenants/demo/prompts/${key}-r1.txt`,
    template_sha256: sha256(`demo prompt ${task}`),
    input_schema: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] },
    output_schema: ANSWER_SCHEMA,
  });
  await ctx.command(CHECKER, `/ai-prompts/${prompt.resource_id}/approval`, {}, { version: prompt });

  const kase = (code: string, extra: Record<string, unknown> = {}) => ({ case_code: code, input_ref: `inputs/${code}.txt`, expected: { answer: 'x' }, classification: 'PUBLIC', ...extra });
  const dataset = await ctx.command(MAKER, '/ai-eval-datasets', {
    dataset_code: `EV-${task}`.slice(0, 40),
    task_type: task,
    source: 'SYNTHETIC',
    cases: [kase('c1'), kase('c2'), kase('inj-1', { tags: ['injection'] })],
  });

  const draft = await ctx.command(MAKER, '/model-profiles', {
    task_type: task,
    model_id: MODELS[0]!.id,
    allowed_model_ids: [...models.values()],
    output_cap: 4000,
    max_input_tokens: 50000,
    timeout_ms: 90000,
    concurrency_limit: 4,
    output_schema: ANSWER_SCHEMA,
    tool_allowlist: [],
    max_classification: 'PUBLIC',
    routing_policy: { routes: ['INTERNATIONAL'] },
    prompt_version_id: prompt.resource_id,
    retention_days: 90,
  });
  const run = await ctx.command(MAKER, '/ai-eval-runs', { profile_version_id: draft.resource_id, dataset_version_id: dataset.resource_id, route_class: 'INTERNATIONAL' });
  await ctx.command(CHECKER, `/ai-eval-runs/${run.resource_id}/signature`, { decision: 'PASS', comment: 'Demo: reviewed the synthetic cases and the metrics' }, { version: run });
  const current = await ctx.get<Obj>(CHECKER, `/resources/model_profile_version/${draft.resource_id}`);
  await ctx.command(CHECKER, `/model-profiles/${draft.resource_id}/publish`, { decision: 'approve', reason: 'Demo: the international route was evaluated and signed', evidence_ids: [] }, { version: Number(current.version) });
  return draft.resource_id;
}

/** A summary of already published figures, as a PUBLIC document the assistant may read; returns the document version id. */
async function ensurePublicSummary(ctx: SeedContext): Promise<string> {
  const symbol = 'DEMO-AI-PUBLIC-02';
  const existing = await ctx.find(MAKER, '/incoming-documents', (letter: Obj) => letter.original_symbol === symbol);
  if (existing !== undefined) {
    const version = (await rows(ctx, '/resources/document_version')).find((row) => row.document_id === existing.document_id);
    return str(version?.id);
  }

  const projects = await rows(ctx, '/resources/project');
  const lines = [
    'BAN TOM TAT CONG KHAI - KE HOACH VON DAU TU CONG (DU LIEU MAU DE TRINH DIEN)',
    'Pham vi: cac du an trong ke hoach von cua don vi, chi gom thong tin da cong bo.',
    '',
    ...projects.slice(0, 12).map((project, index) => {
      const code = str(project.code ?? project.project_code ?? index + 1);
      const name = str(project.name ?? project.title ?? '');
      const group = project.project_group === undefined || project.project_group === null ? '' : `, nhom ${str(project.project_group)}`;
      const unit = project.owner_unit_name === undefined || project.owner_unit_name === null ? '' : `, chu dau tu ${str(project.owner_unit_name)}`;
      return `${index + 1}. ${code} - ${name}${group}${unit}, trang thai ${str(project.status ?? '')}`;
    }),
    '',
    'Luu y: day la tai lieu cong khai, khong chua thong tin noi bo hay bi mat.',
  ].map((line) => line.normalize('NFD').replace(/[̀-ͯ]/gu, '').replace(/đ/gu, 'd').replace(/Đ/gu, 'D'));
  const buffer = pdfWithText(lines);
  const file = ctx.expectOk(await ctx.upload<{ file_object_key: string; file_sha256: string }>(MAKER, '/document-files', { filename: 'ban-tom-tat-cong-khai-ke-hoach-von.pdf', buffer }), 'upload the public summary').json;
  const received = await ctx.must<{ resource_id: string; document_id: string; version_id: string }>(MAKER, 'POST', '/incoming-documents', {
    title: 'Ban tom tat cong khai ke hoach von dau tu cong (du lieu mau)',
    doc_type_code: 'QD',
    channel: 'UPLOAD',
    classification: 'PUBLIC',
    file_object_key: file.file_object_key,
    file_sha256: file.file_sha256,
    original_symbol: symbol,
    original_issued_on: ctx.day(-7),
    sender_name: 'Demo - cong bo thong tin',
  });
  return received.version_id;
}

export async function seedAiDemo(ctx: SeedContext): Promise<{ documentVersionId: string; profiles: Record<string, string> }> {
  ctx.group = 'ai-demo';
  await ctx.step('LLM', 'provider (international, public data only)', () => ensureProvider(ctx));
  await ctx.step('LLM', 'routing policy in force', () => ensurePolicy(ctx));
  await ctx.step('LLM', 'external exception (edition rule)', () => ensureException(ctx));
  const models = await ctx.step('LLM', 'models and price versions', () => ensureModels(ctx));
  await ctx.step('LLM', 'tenant budget', () => ensureBudget(ctx));
  const profiles: Record<string, string> = {};
  for (const task of TASKS) profiles[task] = await ctx.step('LLM', `profile ${task}`, () => ensureProfile(ctx, task, models));
  const documentVersionId = await ctx.step('DOC', 'public source document', () => ensurePublicSummary(ctx));
  return { documentVersionId, profiles };
}
