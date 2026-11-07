import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import { describeLlmProblem, matrixInForce, policyBody, providerBody, toModel, toPolicyBook, toProvider, validateModel, validatePolicy, validateProvider, initialPolicy, EMPTY_PROVIDER, EMPTY_MODEL, BASELINE, CLASSIFICATIONS } from './llm-model';
import ModelsScreen from './ModelsScreen';
import PolicyMatrixScreen from './PolicyMatrixScreen';
import ProvidersScreen from './ProvidersScreen';

const PROVIDERS = routeOf('LLM-02', 'FR-LLM-02');
const MODELS = routeOf('LLM-03', 'FR-LLM-03');
const POLICY = routeOf('LLM-19', 'FR-LLM-19');
const ADMIN = ['llm.provider.manage', 'llm.policy.manage', 'llm.provider.read', 'llm.policy.read'];
const SECURITY = ['llm.provider.approve', 'llm.policy.approve', 'llm.provider.read', 'llm.policy.read'];
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const rawProvider = (overrides: Record<string, unknown> = {}) => ({
  id: P1,
  provider_code: 'VN-HOST',
  name: 'Nha cung cap trong nuoc',
  region_country: 'VN',
  route_class: 'DOMESTIC_HOSTED',
  max_classification: 'CONFIDENTIAL',
  data_agreement_document_id: '00000000-0000-4000-8000-0000000000d1',
  d07_approval_ref: null,
  adapter_status: 'PROPOSED',
  status: 'PROPOSED',
  approved_by: null,
  created_by: '00000000-0000-4000-8000-0000000000b1',
  created_at: '2026-10-01T00:00:00.000Z',
  version: 3,
  ...overrides,
});
const INTL = rawProvider({ id: P2, provider_code: 'INTL-1', name: 'International lab', region_country: 'US', route_class: 'INTERNATIONAL', max_classification: 'PUBLIC', data_agreement_document_id: null, version: 1 });
const rawModel = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  provider_id: P1,
  model_id: 'llm-small',
  model_version: '1',
  capabilities: { json_schema: true, tools: true },
  context_window: 8000,
  max_output: 1000,
  max_classification: 'INTERNAL',
  status: 'PROPOSED',
  created_by: '00000000-0000-4000-8000-0000000000b1',
  created_at: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...overrides,
});
const COMPLIANT = { PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], INTERNAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], CONFIDENTIAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], PERSONAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], IMPORTANT_CORE: ['SELF_HOSTED'] };
const rawPolicy = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000e1',
  revision: 1,
  matrix: COMPLIANT,
  international_enabled: false,
  d07_approval_ref: null,
  legal_basis: 'Luat 2026',
  effective_from: '2026-01-01T00:00:00.000Z',
  status: 'PUBLISHED',
  approved_by: '00000000-0000-4000-8000-0000000000b2',
  created_by: '00000000-0000-4000-8000-0000000000b1',
  created_at: '2026-10-01T00:00:00.000Z',
  version: 2,
  ...overrides,
});

interface World {
  providers: unknown[] | Error;
  models: unknown[] | Error;
  policies: unknown[] | Error;
}
const normal = (): World => ({ providers: [rawProvider(), INTL], models: [rawModel()], policies: [rawPolicy()] });

function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness(() => new Error('unexpected read'), command);
  const readAll = vi.fn((operation: string) => {
    const result = operation === 'listAiProviders' ? world.providers : operation === 'listAiModels' ? world.models : operation === 'listAiClassificationPolicies' ? world.policies : new Error(`unexpected readAll ${operation}`);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('the pure rules of the registry screens (ST-LLM-001)', () => {
  it('reads a provider, a model and a policy as the screens need them, and leaves out what lacks it', () => {
    expect(toProvider(rawProvider())).toMatchObject({ code: 'VN-HOST', route: 'DOMESTIC_HOSTED', hasAgreement: true, version: 3 });
    expect(toProvider({ ...rawProvider(), route_class: 'MOON' })).toBeUndefined();
    expect(toProvider(null)).toBeUndefined();
    expect(toModel(rawModel())).toMatchObject({ modelId: 'llm-small', capabilities: ['json_schema', 'tools'] });
    expect(toModel({ ...rawModel(), max_output: 'x' })).toBeUndefined();
    const book = toPolicyBook([rawPolicy(), rawPolicy({ id: 'x', status: 'DRAFT', revision: 2 }), { id: 'broken' }]);
    expect(book.policies.length).toBe(2);
    expect(book.inForce?.revision).toBe(1);
  });

  it('AC-ST-LLM-001-2: UAT-AC458 shows the baseline with the international route off when nothing is published, and the published matrix with it only where the tenant turned it on', () => {
    const none = matrixInForce(toPolicyBook([]));
    expect(none.PUBLIC).toEqual(['DOMESTIC_HOSTED', 'SELF_HOSTED']);
    expect(none.IMPORTANT_CORE).toEqual(['SELF_HOSTED']);
    const withRoute = { ...COMPLIANT, PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'] };
    expect(matrixInForce(toPolicyBook([rawPolicy({ matrix: withRoute, international_enabled: true, d07_approval_ref: 'D07-1' })])).PUBLIC).toContain('INTERNATIONAL');
    expect(matrixInForce(toPolicyBook([rawPolicy({ matrix: withRoute, international_enabled: false })])).PUBLIC).not.toContain('INTERNATIONAL');
    for (const level of CLASSIFICATIONS.filter((candidate) => candidate !== 'PUBLIC')) expect(BASELINE[level]).not.toContain('INTERNATIONAL');
  });

  it('AC-ST-LLM-001-1: UAT-AC457 refuses before sending an international provider above public data and a domestic one outside Viet Nam, and builds the body of a good one', () => {
    expect(validateProvider({ ...EMPTY_PROVIDER, code: 'X', name: 'Provider' })).toMatchObject({ code: 'invalidCode' });
    expect(validateProvider({ ...EMPTY_PROVIDER, code: 'INTL-1', name: 'Provider', route: 'INTERNATIONAL', region: 'US', maxClassification: 'INTERNAL' })).toEqual({ maxClassification: 'internationalPublicOnly' });
    expect(validateProvider({ ...EMPTY_PROVIDER, code: 'VN-1', name: 'Provider', region: 'SG' })).toEqual({ region: 'notVietnam' });
    expect(validateProvider({ ...EMPTY_PROVIDER, code: 'VN-1', name: 'Provider', agreementDocumentId: 'x' })).toEqual({ agreementDocumentId: 'invalidDocument' });
    expect(validateProvider({ ...EMPTY_PROVIDER, code: 'VN-1', name: 'Provider' })).toEqual({});
    expect(providerBody({ ...EMPTY_PROVIDER, code: ' VN-1 ', name: 'Provider', region: 'vn' })).toEqual({ provider_code: 'VN-1', name: 'Provider', region_country: 'VN', route_class: 'DOMESTIC_HOSTED', max_classification: 'PUBLIC' });
  });

  it('refuses a model above its provider and an output the window cannot hold', () => {
    const providers = [toProvider(rawProvider())!];
    const ok = { ...EMPTY_MODEL, providerId: P1, modelId: 'llm-small', maxClassification: 'INTERNAL' as const };
    expect(validateModel(ok, providers)).toEqual({});
    expect(validateModel({ ...ok, maxClassification: 'PERSONAL' }, providers)).toEqual({ maxClassification: 'aboveProvider' });
    expect(validateModel({ ...ok, contextWindow: '100', maxOutput: '1000' }, providers)).toEqual({ maxOutput: 'outputAboveWindow' });
    expect(validateModel({ ...ok, contextWindow: 'x' }, providers)).toEqual({ contextWindow: 'invalidNumber' });
    expect(validateModel({ ...ok, providerId: '' }, providers)).toEqual({ providerId: 'required' });
  });

  it('AC-ST-LLM-001-1: UAT-AC457 asks D07 when the international route is on, never names that route while it is off, and keeps the line of important data', () => {
    const base = initialPolicy(matrixInForce(toPolicyBook([])), '2026-10-01');
    expect(validatePolicy({ ...base, legalBasis: 'Luat 2026' })).toEqual({});
    expect(validatePolicy({ ...base, legalBasis: 'ab' })).toEqual({ legalBasis: 'required' });
    expect(validatePolicy({ ...base, legalBasis: 'Luat 2026', internationalEnabled: true })).toEqual({ d07Ref: 'needsD07' });
    expect(validatePolicy({ ...base, legalBasis: 'Luat 2026', effectiveFrom: 'tomorrow' })).toEqual({ effectiveFrom: 'invalidDate' });
    expect(validatePolicy({ ...base, legalBasis: 'Luat 2026', matrix: { ...base.matrix, IMPORTANT_CORE: [] } })).toEqual({ matrix: 'importantCore' });
    const staged = { ...base, legalBasis: 'Luat 2026', matrix: { ...base.matrix, PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'] as never } };
    expect((policyBody(staged).matrix as Record<string, string[]>).PUBLIC).not.toContain('INTERNATIONAL');
    const on = policyBody({ ...staged, internationalEnabled: true, d07Ref: ' D07-1 ' });
    expect(on).toMatchObject({ international_enabled: true, d07_approval_ref: 'D07-1', effective_from: '2026-09-30T17:00:00.000Z' });
    expect((on.matrix as Record<string, string[]>).PUBLIC).toContain('INTERNATIONAL');
  });

  it('puts a refusal in words by its code and keeps what the server added only for the levels of a weakened baseline', () => {
    expect(describeLlmProblem(failure(422, 'D07_APPROVAL_REQUIRED'))).toEqual({ reason: 'needsD07', detail: '' });
    expect(describeLlmProblem(failure(422, 'POLICY_WEAKENS_BASELINE', 'INTERNAL,PERSONAL'))).toEqual({ reason: 'weakensBaseline', detail: 'INTERNAL,PERSONAL' });
    expect(describeLlmProblem(failure(403, 'SELF_APPROVAL_DENIED')).reason).toBe('selfApproval');
    expect(describeLlmProblem(failure(409, 'VERSION_CONFLICT')).reason).toBe('stale');
    expect(describeLlmProblem(failure(500, 'INTERNAL_ERROR')).reason).toBe('general');
    expect(describeLlmProblem(new Error('x')).reason).toBe('general');
  });
});

describe('LLM-02 providers (ST-LLM-001, LLM F2)', () => {
  it('writes the status of a provider as a pill and the number of providers in the context bar', async () => {
    mount(<ProvidersScreen route={PROVIDERS} />, client(normal()), { permissions: ADMIN });
    const cards = await screen.findByTestId('provider-cards');
    const pill = within(within(cards).getAllByTestId('provider-status')[0] as HTMLElement).getByText(/.+/).closest('.ui-pill');
    expect(pill).not.toBeNull();
    const bar = screen.getByRole('group', { name: vi_['ui.contextBar.label'] });
    expect(within(bar).getByText('Số nhà cung cấp')).toBeTruthy();
  });

  it('AC-ST-LLM-001-1: UAT-AC457 shows each provider with its route, highest class, agreement, D07 and status, and says international is public only', async () => {
    mount(<ProvidersScreen route={PROVIDERS} />, client(normal()), { permissions: ADMIN });
    const cards = await screen.findByTestId('provider-cards');
    const domestic = within(cards).getByRole('article', { name: 'Nha cung cap trong nuoc' });
    expect(domestic.getAttribute('data-route')).toBe('DOMESTIC_HOSTED');
    expect(domestic.textContent).toContain(vi_['llm.route.domestic']);
    expect(domestic.textContent).toContain(vi_['llm.classification.confidential']);
    expect(domestic.textContent).toContain(vi_['llm.providers.card.agreementYes']);
    const intl = within(cards).getByRole('article', { name: 'International lab' });
    expect(intl.textContent).toContain(vi_['llm.route.international']);
    expect(intl.textContent).toContain(vi_['llm.providers.card.agreementNo']);
    expect(screen.getByTestId('providers-international-note').textContent).toBe(vi_['llm.providers.internationalNote']);
  });

  it('AC-ST-LLM-001-1: UAT-AC457 activates a provider with the version it was read at, and asks the D07 reference only of an international one', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => ({ status: 'ACTIVE' }));
    mount(<ProvidersScreen route={PROVIDERS} />, h, { permissions: SECURITY });
    const cards = await screen.findByTestId('provider-cards');
    const domestic = within(cards).getByRole('article', { name: 'Nha cung cap trong nuoc' });
    expect(within(domestic).queryByLabelText(vi_['llm.providers.activate.d07'])).toBeNull();
    await user.click(within(domestic).getByRole('button', { name: vi_['llm.providers.activate.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['activateAiProvider', { path: { id: P1 }, ifMatchVersion: 3, body: {} }]);
    const intl = within(cards).getByRole('article', { name: 'International lab' });
    await user.type(within(intl).getByLabelText(vi_['llm.providers.activate.d07']), ' D07-2026-01 ');
    await user.click(within(intl).getByRole('button', { name: vi_['llm.providers.activate.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command.mock.calls[1]).toMatchObject(['activateAiProvider', { path: { id: P2 }, ifMatchVersion: 1, body: { d07_approval_ref: 'D07-2026-01' } }]);
  });

  it.each([
    ['D07_APPROVAL_REQUIRED', 'llm.reason.needsD07'],
    ['SELF_APPROVAL_DENIED', 'llm.reason.selfApproval'],
    ['DATA_AGREEMENT_REQUIRED', 'llm.reason.needsAgreement'],
    ['VERSION_CONFLICT', 'llm.reason.stale'],
  ] as const)('puts the refusal %s of an activation in words', async (code, key) => {
    const user = userEvent.setup();
    mount(<ProvidersScreen route={PROVIDERS} />, client(normal(), () => failure(code === 'SELF_APPROVAL_DENIED' ? 403 : code === 'VERSION_CONFLICT' ? 409 : 422, code)), { permissions: SECURITY });
    const cards = await screen.findByTestId('provider-cards');
    await user.click(within(within(cards).getByRole('article', { name: 'Nha cung cap trong nuoc' })).getByRole('button', { name: vi_['llm.providers.activate.submit'] }));
    expect((await screen.findByTestId('activate-refused')).textContent).toBe(vi_[key]);
  });

  it('offers neither the activation to who cannot approve it, nor the form to who cannot register, nor either on a provider that is already active', async () => {
    const world = { ...normal(), providers: [rawProvider({ status: 'ACTIVE' })] };
    const { unmount } = mount(<ProvidersScreen route={PROVIDERS} />, client(world), { permissions: SECURITY });
    await screen.findByTestId('provider-cards');
    expect(screen.queryByRole('button', { name: vi_['llm.providers.activate.submit'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['llm.providers.form.title'] })).toBeNull();
    unmount();
    mount(<ProvidersScreen route={PROVIDERS} />, client(normal()), { permissions: ['llm.provider.read'] });
    await screen.findByTestId('provider-cards');
    expect(screen.queryByRole('button', { name: vi_['llm.providers.activate.submit'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['llm.providers.form.title'] })).toBeNull();
  });

  it('AC-ST-LLM-001-1: UAT-AC457 stops an international provider above public data at the form, and sends a good registration once', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => ({ status: 'PROPOSED' }));
    mount(<ProvidersScreen route={PROVIDERS} />, h, { permissions: ADMIN });
    const form = await screen.findByRole('form', { name: vi_['llm.providers.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.providers.form.code']), 'INTL-9');
    await user.type(within(form).getByLabelText(vi_['llm.providers.form.name']), 'Another lab');
    await user.selectOptions(within(form).getByLabelText(vi_['llm.providers.form.route']), 'INTERNATIONAL');
    fireEvent.change(within(form).getByLabelText(vi_['llm.providers.form.region']), { target: { value: 'US' } });
    await user.selectOptions(within(form).getByLabelText(vi_['llm.providers.form.max']), 'INTERNAL');
    await user.click(within(form).getByRole('button', { name: vi_['llm.providers.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.problem.internationalPublicOnly'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.selectOptions(within(form).getByLabelText(vi_['llm.providers.form.max']), 'PUBLIC');
    await user.click(within(form).getByRole('button', { name: vi_['llm.providers.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['registerAiProvider', { body: { provider_code: 'INTL-9', name: 'Another lab', region_country: 'US', route_class: 'INTERNATIONAL', max_classification: 'PUBLIC' } }]);
    expect(await screen.findByTestId('provider-saved')).toBeTruthy();
  });

  it('puts the refusals of a registration in words', async () => {
    const user = userEvent.setup();
    mount(<ProvidersScreen route={PROVIDERS} />, client(normal(), () => failure(409, 'PROVIDER_CODE_DUPLICATE')), { permissions: ADMIN });
    const form = await screen.findByRole('form', { name: vi_['llm.providers.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.providers.form.code']), 'VN-HOST');
    await user.type(within(form).getByLabelText(vi_['llm.providers.form.name']), 'Again');
    await user.click(within(form).getByRole('button', { name: vi_['llm.providers.form.submit'] }));
    expect((await screen.findByTestId('provider-refused')).textContent).toBe(vi_['llm.reason.duplicateProvider']);
  });

  describe('the standard states', () => {
    it.each([
      ['denied', { ...normal(), providers: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), providers: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), providers: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), providers: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-LLM-02 shows the %s state', async (_name, world, text) => {
      mount(<ProvidersScreen route={PROVIDERS} />, client(world), { permissions: ADMIN });
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    });

    it('UI-LLM-02 says that nothing is registered, and still offers to register the first provider', async () => {
      mount(<ProvidersScreen route={PROVIDERS} />, client({ ...normal(), providers: [] }), { permissions: ADMIN });
      expect((await screen.findByTestId('providers-none')).textContent).toBe(vi_['llm.providers.none']);
      expect(screen.getByRole('form', { name: vi_['llm.providers.form.title'] })).toBeTruthy();
    });

    it('UI-LLM-02 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<ProvidersScreen route={PROVIDERS} />, h, { permissions: ADMIN });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['llm.providers.page.title'] })).toBeTruthy();
    });
  });
});

describe('LLM-03 model catalogue (ST-LLM-001, LLM F2)', () => {
  it('AC-ST-LLM-001-1: UAT-AC459 lists the models with their provider, window, highest class and status, and says that one which is not approved cannot be used', async () => {
    const world = { ...normal(), models: [rawModel(), rawModel({ id: '00000000-0000-4000-8000-0000000000c2', model_id: 'llm-big', model_version: null, status: 'APPROVED', max_classification: 'CONFIDENTIAL' })] };
    mount(<ModelsScreen route={MODELS} />, client(world), { permissions: ADMIN });
    const table = await screen.findByTestId('model-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('llm-small');
    expect(rows[0]?.textContent).toContain('Nha cung cap trong nuoc');
    expect(rows[0]?.textContent).toContain('8,000');
    expect(rows[0]?.textContent).toContain(vi_['llm.modelStatus.proposed']);
    expect(rows[0]?.textContent).toContain(vi_['llm.models.notUsable']);
    expect(rows[1]?.textContent).toContain(vi_['llm.modelStatus.approved']);
    expect(rows[1]?.textContent).not.toContain(vi_['llm.models.notUsable']);
    expect(screen.getByTestId('models-usable-note').textContent).toBe(vi_['llm.models.usableNote']);
  });

  it('shows the status of a model as a pill that says the word, counts the models in the context bar and the applied filter on the button of the panel', async () => {
    const user = userEvent.setup();
    const world = { ...normal(), models: [rawModel(), rawModel({ id: '00000000-0000-4000-8000-0000000000c3', provider_id: P2, model_id: 'intl-model' })] };
    mount(<ModelsScreen route={MODELS} />, client(world), { permissions: ADMIN });
    const table = await screen.findByTestId('model-table');
    expect(within(table).getAllByText(vi_['llm.modelStatus.proposed'])[0]?.closest('.ui-pill')?.className).toContain('ui-tone-info');
    const bar = screen.getByRole('group', { name: vi_['ui.contextBar.label'] });
    expect(within(bar).getByText('Số mô hình đang hiện')).toBeTruthy();
    expect(within(bar).getByText('2')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(vi_['llm.models.filter']), P2);
    expect(await screen.findByRole('button', { name: vi_['ui.filterPanel.toggleApplied'].replace('{count}', '1') })).toBeTruthy();
  });

  it('narrows the table to a provider', async () => {
    const user = userEvent.setup();
    const world = { ...normal(), models: [rawModel(), rawModel({ id: '00000000-0000-4000-8000-0000000000c3', provider_id: P2, model_id: 'intl-model' })] };
    mount(<ModelsScreen route={MODELS} />, client(world), { permissions: ADMIN });
    const table = await screen.findByTestId('model-table');
    expect(within(table).getAllByRole('row').length).toBe(3);
    await user.selectOptions(screen.getByLabelText(vi_['llm.models.filter']), P2);
    expect(within(await screen.findByTestId('model-table')).getAllByRole('row').length).toBe(2);
    expect(screen.getByTestId('model-table').textContent).toContain('intl-model');
  });

  it('stops a model above its provider at the form, and registers a good one with its capabilities', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => ({ status: 'PROPOSED' }));
    mount(<ModelsScreen route={MODELS} />, h, { permissions: ADMIN });
    const form = await screen.findByRole('form', { name: vi_['llm.models.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.models.form.modelId']), 'llm-new');
    await user.selectOptions(within(form).getByLabelText(vi_['llm.models.form.max']), 'PERSONAL');
    await user.click(within(form).getByRole('button', { name: vi_['llm.models.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.problem.aboveProvider'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.selectOptions(within(form).getByLabelText(vi_['llm.models.form.max']), 'INTERNAL');
    await user.click(within(form).getByLabelText(vi_['llm.capability.jsonSchema']));
    await user.click(within(form).getByRole('button', { name: vi_['llm.models.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['registerAiModel', { body: { provider_id: P1, model_id: 'llm-new', capabilities: { json_schema: true }, context_window: 8000, max_output: 1000, max_classification: 'INTERNAL' } }]);
    expect(await screen.findByTestId('model-saved')).toBeTruthy();
  });

  it('puts the refusal of a duplicate model in words and offers no form to who cannot register', async () => {
    const user = userEvent.setup();
    const { unmount } = mount(<ModelsScreen route={MODELS} />, client(normal(), () => failure(409, 'MODEL_DUPLICATE')), { permissions: ADMIN });
    const form = await screen.findByRole('form', { name: vi_['llm.models.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.models.form.modelId']), 'llm-small');
    await user.selectOptions(within(form).getByLabelText(vi_['llm.models.form.max']), 'INTERNAL');
    await user.click(within(form).getByRole('button', { name: vi_['llm.models.form.submit'] }));
    expect((await screen.findByTestId('model-refused')).textContent).toBe(vi_['llm.reason.duplicateModel']);
    unmount();
    mount(<ModelsScreen route={MODELS} />, client(normal()), { permissions: ['llm.provider.read'] });
    await screen.findByTestId('model-table');
    expect(screen.queryByRole('form', { name: vi_['llm.models.form.title'] })).toBeNull();
  });

  describe('the standard states', () => {
    it.each([
      ['denied', { ...normal(), models: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), providers: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), models: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), models: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-LLM-03 shows the %s state', async (_name, world, text) => {
      mount(<ModelsScreen route={MODELS} />, client(world), { permissions: ADMIN });
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    });

    it('UI-LLM-03 says that there is no model, and still offers to register one', async () => {
      mount(<ModelsScreen route={MODELS} />, client({ ...normal(), models: [] }), { permissions: ADMIN });
      expect((await screen.findByTestId('models-none')).textContent).toBe(vi_['llm.models.empty']);
      expect(screen.getByRole('form', { name: vi_['llm.models.form.title'] })).toBeTruthy();
    });

    it('UI-LLM-03 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<ModelsScreen route={MODELS} />, h, { permissions: ADMIN });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['llm.models.page.title'] })).toBeTruthy();
    });
  });
});

describe('LLM-19 classification and routing policy (ST-LLM-001, LLM BR-LLM-01)', () => {
  const cell = (level: string, route: string): HTMLElement => {
    const row = within(screen.getByTestId('policy-matrix')).getAllByRole('row').find((candidate) => candidate.getAttribute('data-level') === level) as HTMLElement;
    return Array.from(row.querySelectorAll('td')).find((td) => td.getAttribute('data-route') === route) as HTMLElement;
  };

  it('AC-ST-LLM-001-2: UAT-AC458 shows the matrix in force: important data on a self-hosted model only and nothing above public data going international', async () => {
    mount(<PolicyMatrixScreen route={POLICY} />, client(normal()), { permissions: ADMIN });
    await screen.findByTestId('policy-matrix');
    expect(screen.getByTestId('policy-in-force').textContent).toBe(fill(vi_['llm.policy.inForce'], { revision: 1 }));
    expect(cell('IMPORTANT_CORE', 'SELF_HOSTED').getAttribute('data-allowed')).toBe('true');
    expect(cell('IMPORTANT_CORE', 'DOMESTIC_HOSTED').getAttribute('data-allowed')).toBe('false');
    for (const level of ['INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE']) {
      expect(cell(level, 'INTERNATIONAL').getAttribute('data-allowed')).toBe('false');
      expect(cell(level, 'INTERNATIONAL').textContent).toBe(vi_['llm.policy.matrix.never']);
    }
    // International is a route of public data only, and it is closed (not impossible) until the tenant turns it on.
    expect(cell('PUBLIC', 'INTERNATIONAL').textContent).toBe(vi_['llm.policy.matrix.closed']);
  });

  it('says that the baseline applies when nothing has been published', async () => {
    mount(<PolicyMatrixScreen route={POLICY} />, client({ ...normal(), policies: [] }), { permissions: ADMIN });
    const note = await screen.findByTestId('policy-in-force');
    expect(note.getAttribute('data-baseline')).toBe('true');
    expect(note.textContent).toBe(vi_['llm.policy.baselineOnly']);
    expect(cell('PUBLIC', 'INTERNATIONAL').getAttribute('data-allowed')).toBe('false');
    expect(screen.getByTestId('policy-none')).toBeTruthy();
  });

  it('AC-ST-LLM-001-2: UAT-AC458 drafts from the matrix in force with the line of important data fixed and the international route only for public data, once D07 is given', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => ({ status: 'DRAFT' }));
    mount(<PolicyMatrixScreen route={POLICY} />, h, { permissions: ADMIN });
    const form = await screen.findByRole('form', { name: vi_['llm.policy.form.title'] });
    const core = within(form).getByLabelText(vi_['llm.route.selfHosted'], { selector: '#cell-IMPORTANT_CORE-SELF_HOSTED' }) as HTMLInputElement;
    expect([core.checked, core.disabled]).toEqual([true, true]);
    expect(form.querySelector('#cell-IMPORTANT_CORE-DOMESTIC_HOSTED')).toBeNull();
    expect(form.querySelector('#cell-INTERNAL-INTERNATIONAL')).toBeNull();
    const intlCell = form.querySelector('#cell-PUBLIC-INTERNATIONAL') as HTMLInputElement;
    expect(intlCell.disabled).toBe(true);
    await user.type(within(form).getByLabelText(vi_['llm.policy.form.basis']), 'Luat 2026');
    await user.click(within(form).getByLabelText(vi_['llm.policy.form.international']));
    await user.click(within(form).getByRole('button', { name: vi_['llm.policy.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.problem.needsD07'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.policy.form.d07']), 'D07-2026-01');
    expect((form.querySelector('#cell-PUBLIC-INTERNATIONAL') as HTMLInputElement).disabled).toBe(false);
    await user.click(form.querySelector('#cell-PUBLIC-INTERNATIONAL') as HTMLInputElement);
    await user.click(within(form).getByRole('button', { name: vi_['llm.policy.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const body = (h.command.mock.calls[0]?.[1] as { body: { matrix: Record<string, string[]>; international_enabled: boolean; d07_approval_ref: string } }).body;
    expect(h.command.mock.calls[0]?.[0]).toBe('createAiClassificationPolicy');
    expect(body).toMatchObject({ international_enabled: true, d07_approval_ref: 'D07-2026-01' });
    expect(body.matrix.PUBLIC).toContain('INTERNATIONAL');
    expect(body.matrix.IMPORTANT_CORE).toEqual(['SELF_HOSTED']);
    expect(await screen.findByTestId('policy-saved')).toBeTruthy();
  });

  it('AC-ST-LLM-001-2: UAT-AC458 publishes a draft at the version it was read at, and puts the weakened levels and the self-approval in words', async () => {
    const user = userEvent.setup();
    const draft = rawPolicy({ id: '00000000-0000-4000-8000-0000000000e2', revision: 2, status: 'DRAFT', version: 5 });
    const answers = [failure(422, 'POLICY_WEAKENS_BASELINE', 'INTERNAL,PERSONAL'), failure(403, 'SELF_APPROVAL_DENIED'), { status: 'PUBLISHED' }];
    const h = client({ ...normal(), policies: [rawPolicy(), draft] }, () => answers.shift());
    mount(<PolicyMatrixScreen route={POLICY} />, h, { permissions: SECURITY });
    const rows = await screen.findByTestId('policy-revisions');
    const publish = within(rows).getByRole('button', { name: vi_['llm.policy.publish'] });
    expect(within(rows).getAllByRole('button').length).toBe(1);
    await user.click(publish);
    expect((await screen.findByTestId('publish-refused')).textContent).toBe(fill(vi_['llm.reason.weakensBaseline'], { levels: 'INTERNAL,PERSONAL' }));
    await user.click(publish);
    await waitFor(() => expect(screen.getByTestId('publish-refused').textContent).toBe(vi_['llm.reason.selfApproval']));
    await user.click(publish);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
    expect(h.command.mock.calls[2]).toMatchObject(['publishAiClassificationPolicy', { path: { id: '00000000-0000-4000-8000-0000000000e2' }, ifMatchVersion: 5 }]);
  });

  it('AC-ST-LLM-001-2: UAT-AC458 lets the approver see the matrix of a draft before publishing it, so that two drafts do not look alike', async () => {
    const wider = { ...COMPLIANT, PERSONAL: ['SELF_HOSTED'], INTERNAL: ['DOMESTIC_HOSTED'] };
    const draft = rawPolicy({ id: '00000000-0000-4000-8000-0000000000e2', revision: 2, status: 'DRAFT', matrix: wider });
    mount(<PolicyMatrixScreen route={POLICY} />, client({ ...normal(), policies: [rawPolicy(), draft] }), { permissions: SECURITY });
    const preview = await screen.findByTestId('policy-matrix-00000000-0000-4000-8000-0000000000e2');
    const open = (matrixTable: HTMLElement, level: string, route: string): string | null => {
      const row = within(matrixTable).getAllByRole('row').find((candidate) => candidate.getAttribute('data-level') === level) as HTMLElement;
      return (Array.from(row.querySelectorAll('td')).find((td) => td.getAttribute('data-route') === route) as HTMLElement).getAttribute('data-allowed');
    };
    // The draft narrows personal data to the self-hosted route and internal data to the domestic one; the matrix in force still has both routes.
    expect([open(preview, 'PERSONAL', 'DOMESTIC_HOSTED'), open(preview, 'INTERNAL', 'SELF_HOSTED'), open(preview, 'PERSONAL', 'SELF_HOSTED')]).toEqual(['false', 'false', 'true']);
    expect([open(screen.getByTestId('policy-matrix'), 'PERSONAL', 'DOMESTIC_HOSTED'), open(screen.getByTestId('policy-matrix'), 'INTERNAL', 'SELF_HOSTED')]).toEqual(['true', 'true']);
    expect(screen.getByTestId('policy-matrix-00000000-0000-4000-8000-0000000000e1')).toBeTruthy();
  });

  it('shows the effective date of a policy as the day in Viet Nam it was entered for', async () => {
    mount(<PolicyMatrixScreen route={POLICY} />, client({ ...normal(), policies: [rawPolicy({ effective_from: '2026-10-27T17:00:00.000Z' })] }), { permissions: ADMIN });
    const rows = within(await screen.findByTestId('policy-revisions')).getAllByRole('row');
    expect(rows[1]?.textContent).toContain('2026-10-28');
    expect(rows[1]?.textContent).not.toContain('2026-10-27');
  });

  it('offers no publishing to who cannot approve, and no draft form to who cannot manage', async () => {
    const draft = rawPolicy({ id: '00000000-0000-4000-8000-0000000000e2', revision: 2, status: 'DRAFT' });
    mount(<PolicyMatrixScreen route={POLICY} />, client({ ...normal(), policies: [rawPolicy(), draft] }), { permissions: ['llm.policy.read'] });
    const rows = await screen.findByTestId('policy-revisions');
    expect(within(rows).queryByRole('button', { name: vi_['llm.policy.publish'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['llm.policy.form.title'] })).toBeNull();
  });

  describe('the standard states', () => {
    it.each([
      ['denied', { ...normal(), policies: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), policies: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), policies: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), policies: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-LLM-19 shows the %s state', async (_name, world, text) => {
      mount(<PolicyMatrixScreen route={POLICY} />, client(world), { permissions: ADMIN });
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    });

    it('UI-LLM-19 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<PolicyMatrixScreen route={POLICY} />, h, { permissions: ADMIN });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['llm.policy.page.title'] })).toBeTruthy();
    });
  });
});
