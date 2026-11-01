import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { routeOf } from '../../dgv/test-support';
import { mountInSession } from '../../doc/test-support';
import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import GuardrailScreen from './GuardrailScreen';
import { refusals, toGuardProfile } from './model';
import type { RequestEntry } from '../gateway-model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const uuid = (n: number): string => `b1b2c3d4-0000-4000-8000-${String(n).padStart(12, 'e')}`;
const ROUTE = routeOf('LLM-15', 'FR-LLM-15');
const ALL = ['model_profile_version.read', 'llm.policy.read', 'llm.audit.read'];
const CCCD = '001099012345';
const MATRIX = { PUBLIC: ['DOMESTIC_HOSTED', 'INTERNATIONAL'], INTERNAL: ['DOMESTIC_HOSTED'], CONFIDENTIAL: ['DOMESTIC_HOSTED'], PERSONAL: [], IMPORTANT_CORE: ['SELF_HOSTED'] };

const profile = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  task_type: `summarise-${n}`,
  revision: n,
  model_id: 'viet-llm',
  status: 'PUBLISHED',
  routing_policy: { routes: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], thresholds: {} },
  tool_allowlist: ['search_documents', 'read_document'],
  max_classification: 'CONFIDENTIAL',
  retention_days: 90,
  version: 1,
  ...extra,
});
const policy = (extra: Record<string, unknown> = {}) => ({
  id: uuid(800),
  revision: 3,
  matrix: MATRIX,
  international_enabled: true,
  d07_approval_ref: 'D07-1',
  legal_basis: 'Luat',
  effective_from: '2026-01-01T00:00:00Z',
  status: 'PUBLISHED',
  created_by: uuid(1),
  version: 1,
  ...extra,
});
const refused = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  task_type: `summarise-${n}`,
  subject_module: 'PRJ',
  data_classification: 'CONFIDENTIAL',
  route_class: null,
  provider_code: null,
  model_id: null,
  status: 'REJECTED_POLICY',
  reject_code: 'PROMPT_INJECTION',
  cost_vnd: null,
  created_at: `2026-11-0${n}T17:30:00Z`,
  ...extra,
});

interface World {
  profiles: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  policyRefused: Array<Record<string, unknown>>;
  citationRefused: Array<Record<string, unknown>>;
  morePolicy: Array<Record<string, unknown>>;
  failing: Set<string>;
}

function open(state: Partial<World> = {}, permissions: readonly string[] | undefined = ALL): Harness & { world: World } {
  const world: World = { profiles: [profile(1)], policies: [policy()], policyRefused: [], citationRefused: [], morePolicy: [], failing: new Set(), ...state };
  const h = harness((operation, input) => {
    const query = (input as { query?: Record<string, string> } | undefined)?.query ?? {};
    if (operation !== 'listAiRequests') return new Error(`unexpected read ${operation}`);
    if (world.failing.has(`requests:${query.status}`)) return new Error('boom');
    if (query.cursor !== undefined) return world.failing.has('more') ? new Error('boom') : { items: world.morePolicy, next_cursor: null };
    const items = query.status === 'REJECTED_POLICY' ? world.policyRefused : world.citationRefused;
    return { items, next_cursor: query.status === 'REJECTED_POLICY' && (world.morePolicy.length > 0 || world.failing.has('more')) ? 'c2' : null };
  });
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (world.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_model_profile_version') return Promise.resolve(world.profiles);
    if (operation === 'listAiClassificationPolicies') return Promise.resolve(world.policies);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  mountInSession(<GuardrailScreen route={ROUTE} />, h, { permissions }, '/llm/llm-15');
  return Object.assign(h, { world });
}

const refusalRows = (): HTMLElement[] => within(screen.getByTestId('refusals-table')).getAllByRole('row').slice(1);

afterEach(() => cleanup());

describe('the model of the guardrails (ST-LLM-009)', () => {
  it('reads a profile that is in force with its tools, routes, ceiling and retention, and leaves out the rest', () => {
    expect(toGuardProfile(profile(1))).toEqual({
      id: uuid(1),
      taskType: 'summarise-1',
      revision: 1,
      modelId: 'viet-llm',
      tools: ['search_documents', 'read_document'],
      routes: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
      maxClassification: 'CONFIDENTIAL',
      retentionDays: 90,
    });
    expect(toGuardProfile(profile(2, { tool_allowlist: 'x', routing_policy: null, max_classification: 'x', retention_days: 1.5, model_id: 3 }))).toMatchObject({
      tools: [],
      routes: [],
      maxClassification: null,
      retentionDays: null,
      modelId: '',
    });
    for (const bad of [null, [], {}, profile(3, { status: 'DRAFT' }), profile(3, { id: 3 }), profile(3, { task_type: null }), profile(3, { revision: '1' })])
      expect(toGuardProfile(bad)).toBeUndefined();
  });

  it('keeps the refusals of a guardrail, the latest first, and narrows them to the words typed', () => {
    const entry = (n: number, extra: Partial<RequestEntry> = {}): RequestEntry => ({
      id: uuid(n),
      taskType: 'summarise',
      subjectModule: 'PRJ',
      classification: 'INTERNAL',
      route: null,
      providerCode: null,
      modelId: null,
      status: 'REJECTED_POLICY',
      rejectCode: 'PROMPT_INJECTION',
      citations: null,
      costVnd: null,
      createdAt: `2026-11-0${n}T00:00:00Z`,
      ...extra,
    });
    const list = [entry(1), entry(2, { status: 'REJECTED_NO_CITATION', rejectCode: 'NO_CITATION' }), entry(3, { status: 'FAILED' }), entry(4, { createdAt: '2026-11-01T00:00:00Z' })];
    expect(refusals(list, '').map((row) => row.id)).toEqual([uuid(2), uuid(1), uuid(4)]);
    expect(refusals(list, 'no_cit').map((row) => row.id)).toEqual([uuid(2)]);
    expect(refusals(list, 'zzz')).toEqual([]);
  });
});

describe('LLM-15 guardrails and data', () => {
  it('says what the gateway holds every request to, whatever the profile', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: word('llm.guardrail.page.title') })).toBeTruthy();
    const controls = within(screen.getByTestId('guardrail-controls'));
    for (const control of ['pii', 'tools', 'untrusted', 'citation', 'storage']) {
      expect(controls.getByText(word(`llm.guardrail.control.${control}.name`))).toBeTruthy();
      expect(controls.getByText(word(`llm.guardrail.control.${control}.holds`))).toBeTruthy();
    }
  });

  it('shows for each profile in force the tools it may call, the routes, the highest class and the days it keeps', async () => {
    open({ profiles: [profile(1), profile(2, { status: 'DRAFT' }), profile(3, { tool_allowlist: [], routing_policy: { routes: [] }, max_classification: null, retention_days: null })] });
    const section = await screen.findByTestId('guardrail-profiles');
    await within(section).findByText('summarise-1');
    const rows = within(section).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('search_documents, read_document')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(`${word('llm.route.domestic')}, ${word('llm.route.selfHosted')}`)).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(word('llm.classification.confidential'))).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(word('llm.guardrail.profiles.days').replace('{value}', '90'))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(word('llm.guardrail.profiles.noTools'))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getAllByText('—')).toHaveLength(3);
  });

  it('shows the routes each class of data may take under the policy in force, or under the baseline', async () => {
    open();
    const section = await screen.findByTestId('guardrail-routes');
    await within(section).findByTestId('routes-source');
    expect(within(section).getByTestId('routes-source').textContent).toBe(word('llm.guardrail.routes.policy').replace('{revision}', '3'));
    expect(section.querySelector('[data-classification="PUBLIC"]')?.textContent).toContain(word('llm.route.international'));
    expect(section.querySelector('[data-classification="PERSONAL"]')?.textContent).toContain(word('llm.guardrail.routes.none'));
    expect(section.querySelector('[data-classification="IMPORTANT_CORE"]')?.textContent).toContain(word('llm.route.selfHosted'));
    cleanup();
    open({ policies: [] });
    const baseline = await screen.findByTestId('guardrail-routes');
    expect((await within(baseline).findByTestId('routes-source')).textContent).toBe(word('llm.guardrail.routes.baseline'));
    expect(baseline.querySelector('[data-classification="PUBLIC"]')?.textContent).not.toContain(word('llm.route.international'));
  });

  it('lists the injection rejections with their rule, the latest first, with a link to the trace', async () => {
    open({
      policyRefused: [refused(1), refused(2, { reject_code: 'AI_ROUTE_NOT_ALLOWED' })],
      citationRefused: [refused(3, { status: 'REJECTED_NO_CITATION', reject_code: 'NO_CITATION', data_classification: 'INTERNAL' })],
    });
    await screen.findByTestId('refusals-table');
    const rows = refusalRows();
    expect(rows.map((row) => row.getAttribute('data-request-id'))).toEqual([uuid(3), uuid(2), uuid(1)]);
    const injection = rows[2] as HTMLElement;
    expect(within(injection).getByTestId('refusal-rule').textContent).toContain('PROMPT_INJECTION');
    expect(within(injection).getByRole('link', { name: 'b1b2c3d4' }).getAttribute('href')).toBe(`/llm/llm-14?trace=${uuid(1)}`);
    expect(within(rows[1] as HTMLElement).getByTestId('refusal-rule').textContent).toContain(word('llm.rejectCode.routeNotAllowed'));
    expect(within(rows[0] as HTMLElement).getByTestId('refusal-rule').textContent).toContain(word('llm.rejectCode.noCitation'));
    fireEvent.change(document.getElementById('refusals-words') as HTMLElement, { target: { value: 'injection' } });
    expect(refusalRows()).toHaveLength(1);
    fireEvent.change(document.getElementById('refusals-words') as HTMLElement, { target: { value: 'nothing' } });
    expect(screen.getByTestId('refusals-none')).toBeTruthy();
  });

  it('shows no personal pattern and a refusal without a rule with a dash', async () => {
    open({ policyRefused: [refused(1, { task_type: `extract ${CCCD}`, reject_code: 'RULE 0912345678' }), refused(2, { reject_code: null })] });
    await screen.findByTestId('refusals-table');
    const page = document.body.textContent ?? '';
    expect(page).not.toContain(CCCD);
    expect(page).not.toContain('0912345678');
    expect(within(refusalRows()[0] as HTMLElement).getByTestId('refusal-rule').textContent).toBe('—');
  });

  it('loads more refusals and keeps what is shown when a page fails', async () => {
    open({ policyRefused: [refused(1)], morePolicy: [refused(2)] });
    await screen.findByTestId('refusals-table');
    fireEvent.click(screen.getByTestId('refusals-more'));
    await waitFor(() => expect(refusalRows()).toHaveLength(2));
    cleanup();
    open({ policyRefused: [refused(1)], failing: new Set(['more']) });
    await screen.findByTestId('refusals-table');
    fireEvent.click(screen.getByTestId('refusals-more'));
    expect(await screen.findByTestId('refusals-more-failed')).toBeTruthy();
    expect(refusalRows()).toHaveLength(1);
  });

  it('shows the state of each part on its own: empty, failed with a retry', async () => {
    const h = open({ profiles: [], failing: new Set(['listAiClassificationPolicies', 'requests:REJECTED_NO_CITATION']) });
    expect(await within(await screen.findByTestId('guardrail-profiles')).findByText(word('states.empty.title'))).toBeTruthy();
    expect(await within(screen.getByTestId('guardrail-routes')).findByText(word('states.error.title'))).toBeTruthy();
    expect(await within(screen.getByTestId('guardrail-refusals')).findByText(word('states.error.title'))).toBeTruthy();
    h.world.failing.clear();
    h.world.policyRefused = [refused(1)];
    fireEvent.click(within(screen.getByTestId('guardrail-routes')).getByRole('button', { name: word('states.retry.action') }));
    expect(await within(screen.getByTestId('guardrail-routes')).findByTestId('routes-source')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('guardrail-refusals')).getByRole('button', { name: word('states.retry.action') }));
    expect(await screen.findByTestId('refusals-table')).toBeTruthy();
  });

  it('is denied part by part without the right to read it, and reads only what it may', async () => {
    const h = open({ policyRefused: [refused(1)] }, ['llm.audit.read']);
    expect(await screen.findByTestId('profiles-denied')).toBeTruthy();
    expect(screen.getByTestId('routes-denied')).toBeTruthy();
    await screen.findByTestId('refusals-table');
    const names = (h.client.readAll as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0]);
    expect(names).toEqual([]);
    cleanup();
    const none = open({}, []);
    expect(await screen.findByTestId('refusals-denied')).toBeTruthy();
    expect(screen.getByTestId('profiles-denied')).toBeTruthy();
    expect(none.read).not.toHaveBeenCalled();
    expect((none.client.readAll as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    expect(screen.getByTestId('guardrail-controls')).toBeTruthy();
    cleanup();
    open({}, undefined);
    expect(await screen.findByTestId('guardrail-profiles')).toBeTruthy();
  });
});
