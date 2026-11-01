import { ApiError } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { routeOf } from '../../dgv/test-support';
import { mountInSession } from '../../doc/test-support';
import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import * as labels from './labels';
import { EMPTY_FORM, MAX_DOCUMENTS, MAX_INPUT, describeProblem, documentIds, requestBody, sha256Hex, toAnswer, validate } from './model';
import PlaygroundScreen from './PlaygroundScreen';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0310'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('LLM-11', 'FR-LLM-11');
const ALL = ['ai.invoke', 'model_profile_version.read', 'llm.audit.read'];
const HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

const profile = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  task_type: `summarise-${n}`,
  revision: n,
  model_id: 'viet-llm',
  status: 'PUBLISHED',
  routing_policy: { routes: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], thresholds: {} },
  max_classification: 'CONFIDENTIAL',
  version: 1,
  ...extra,
});
const answer = (extra: Record<string, unknown> = {}) => ({
  operation_id: 'op',
  status: 'COMPLETED',
  resource_version: 1,
  resource_id: uuid(900),
  data_classification: 'CONFIDENTIAL',
  route_class: 'DOMESTIC_HOSTED',
  reject_code: null,
  ...extra,
});
const decision = {
  ai_request_id: uuid(900),
  data_classification: 'CONFIDENTIAL',
  classification_basis: [],
  policy_version_id: uuid(800),
  route_class: 'DOMESTIC_HOSTED',
  provider_code: 'VN1',
  model_id: 'viet-llm',
  status: 'COMPLETED',
  reject_code: null,
  attempts: [
    { id: uuid(700), attempt_no: 1, attempt_kind: 'PRIMARY', route_class: 'DOMESTIC_HOSTED', provider_code: 'VN1', model_id: 'viet-llm', outcome: 'SUCCESS', latency_ms: 90, cost_vnd: '1200.5' },
  ],
};

interface Options {
  profiles?: Array<Record<string, unknown>>;
  permissions?: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  failProfiles?: boolean;
}

function open(options: Options = {}): Harness {
  const h = harness((operation) => (operation === 'getAiRequestRoute' ? decision : new Error(`unexpected read ${operation}`)), options.command ?? (() => answer()));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) =>
    operation === 'get_resources_model_profile_version' && options.failProfiles !== true
      ? Promise.resolve(options.profiles ?? [profile(1), profile(2, { status: 'DRAFT' })])
      : Promise.reject(new Error(`${operation} failed`)),
  );
  mountInSession(
    <PlaygroundScreen route={ROUTE} />,
    h,
    { permissions: 'permissions' in options ? options.permissions : ALL, ...(options.mode === undefined ? {} : { mode: options.mode }) },
    '/llm/llm-11',
  );
  return h;
}

const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const calls = (h: Harness): Array<{ body: Record<string, unknown>; attempt: unknown }> =>
  h.command.mock.calls.filter((call) => call[0] === 'requestAiCompletion').map((call) => call[1] as { body: Record<string, unknown>; attempt: unknown });
const fill = async (extra: Record<string, string> = {}): Promise<void> => {
  await screen.findByRole('form', { name: word('llm.playground.form.title') });
  type('pg-profile', uuid(1));
  type('pg-input', 'hello');
  for (const [id, value] of Object.entries(extra)) type(id, value);
};
const run = (): void => {
  fireEvent.click(screen.getByRole('button', { name: word('llm.playground.submit.action') }));
};

afterEach(() => cleanup());

describe('the model of the playground (ST-LLM-009)', () => {
  it('hashes the text so that only the hash can travel', async () => {
    expect(await sha256Hex('hello')).toBe(HELLO);
  });

  it('reads the document versions once each, in lower case, from lines, commas and spaces', () => {
    expect(documentIds(` ${uuid(1).toUpperCase()}\n${uuid(2)}, ${uuid(1)} ;  `)).toEqual([uuid(1), uuid(2)]);
    expect(documentIds('')).toEqual([]);
  });

  it('checks the form before it is sent', () => {
    expect(validate(EMPTY_FORM)).toEqual({ profileId: 'required', input: 'required' });
    expect(validate({ ...EMPTY_FORM, profileId: 'p', input: 'x', subjectModule: '' })).toEqual({ subjectModule: 'required' });
    expect(validate({ ...EMPTY_FORM, profileId: 'p', input: 'x', subjectModule: '9!' }).subjectModule).toBe('invalid');
    expect(validate({ ...EMPTY_FORM, profileId: 'p', input: 'x', documents: 'not-an-id' }).documents).toBe('invalid');
    const many = Array.from({ length: MAX_DOCUMENTS + 1 }, (_, n) => uuid(n)).join('\n');
    expect(validate({ ...EMPTY_FORM, profileId: 'p', input: 'x', documents: many }).documents).toBe('tooMany');
    expect(validate({ ...EMPTY_FORM, profileId: 'p', input: 'x'.repeat(MAX_INPUT + 1) }).input).toBe('tooLong');
    expect(validate({ ...EMPTY_FORM, profileId: 'p', input: 'x', maxCostVnd: '12.5' }).maxCostVnd).toBe('invalid');
    expect(validate({ ...EMPTY_FORM, profileId: 'p', input: 'x', attestationId: 'x' }).attestationId).toBe('invalid');
    expect(validate({ ...EMPTY_FORM, profileId: 'p', input: 'x', maxCostVnd: '5000000', attestationId: uuid(5), documents: uuid(1) })).toEqual({});
  });

  it('builds the request from references and the hash, never from the text', () => {
    const form = { ...EMPTY_FORM, profileId: uuid(1), subjectModule: ' prj ', documents: uuid(2), input: 'secret words', maxCostVnd: ' 5000 ', attestationId: uuid(3).toUpperCase() };
    const body = requestBody(form, 'summarise', HELLO);
    expect(body).toEqual({
      task_type: 'summarise',
      subject_module: 'PRJ',
      source_refs: [{ document_version_id: uuid(2) }],
      input_ref: `playground/${HELLO}`,
      input_sha256: HELLO,
      max_cost_vnd: '5000',
      anonymisation_attestation_id: uuid(3),
    });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(requestBody({ ...EMPTY_FORM, input: 'x' }, 'summarise', HELLO)).not.toHaveProperty('max_cost_vnd');
  });

  it('reads what the gateway answered and refuses what it cannot read', () => {
    expect(toAnswer(answer())).toEqual({ requestId: uuid(900), status: 'COMPLETED', classification: 'CONFIDENTIAL', route: 'DOMESTIC_HOSTED', rejectCode: null });
    expect(toAnswer(answer({ data_classification: 'x', route_class: null, reject_code: 'AI_ROUTE_NOT_ALLOWED', status: 'REJECTED_POLICY' }))).toEqual({
      requestId: uuid(900),
      status: 'REJECTED_POLICY',
      classification: null,
      route: null,
      rejectCode: 'AI_ROUTE_NOT_ALLOWED',
    });
    for (const bad of [null, [], {}, answer({ status: 'LOST' }), answer({ resource_id: 3 })]) expect(toAnswer(bad)).toBeUndefined();
  });

  it('tells why the gateway refused by its code, a rate limit that is not the budget as the quota', () => {
    expect(describeProblem(problem(429, 'BUDGET_EXCEEDED'))).toBe('budget');
    expect(describeProblem(problem(429, 'RATE_LIMITED'))).toBe('quota');
    expect(describeProblem(problem(422, 'AI_ROUTE_NOT_ALLOWED'))).toBe('routeNotAllowed');
    expect(describeProblem(problem(409, 'AI_KILL_SWITCH_ENGAGED'))).toBe('killSwitch');
    expect(describeProblem(problem(422, 'VALIDATION_FAILED'))).toBe('validation');
    expect(describeProblem(problem(403, 'SCOPE_DENIED'))).toBe('scope');
    expect(describeProblem(problem(500, 'X'))).toBe('general');
    expect(describeProblem(new Error('x'))).toBe('general');
  });

  it('words every problem and every reason', () => {
    const t = ((key: string) => word(key)) as never;
    for (const entry of ['required', 'invalid', 'tooMany', 'tooLong'] as const) expect(labels.problemMessage(t, entry)).toBe(word(`llm.playground.problem.${entry}`));
    for (const entry of ['quota', 'budget', 'routeNotAllowed', 'killSwitch', 'validation', 'scope', 'general'] as const)
      expect(labels.reasonMessage(t, entry)).toBe(word(`llm.playground.reason.${entry}`));
  });
});

describe('LLM-11 controlled playground', () => {
  it('offers the profiles that are published and says what the chosen one may use', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: word('llm.playground.page.title') })).toBeTruthy();
    await screen.findByRole('form', { name: word('llm.playground.form.title') });
    const options = within(document.getElementById('pg-profile') as HTMLElement).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([word('llm.playground.profile.none'), 'summarise-1 #1 · viet-llm']);
    expect(screen.queryByTestId('playground-profile')).toBeNull();
    type('pg-profile', uuid(1));
    const facts = screen.getByTestId('playground-profile');
    expect(facts.textContent).toContain(word('llm.route.domestic'));
    expect(facts.textContent).toContain(word('llm.classification.confidential'));
    expect(screen.getByTestId('playground-note').textContent).toBe(word('llm.playground.rule.note'));
  });

  it('shows a profile with no route or ceiling with dashes', async () => {
    open({ profiles: [profile(1, { routing_policy: { routes: [], thresholds: {} }, max_classification: null })] });
    await screen.findByRole('form', { name: word('llm.playground.form.title') });
    type('pg-profile', uuid(1));
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('does not send a form that is not valid, and says what is wrong', async () => {
    const h = open();
    await screen.findByRole('form', { name: word('llm.playground.form.title') });
    run();
    expect(await screen.findAllByText(word('llm.playground.problem.required'))).toHaveLength(2);
    expect(calls(h)).toHaveLength(0);
  });

  it('sends the hash and a reference with the documents, clears the input and shows the metadata of the answer', async () => {
    const h = open();
    await fill({ 'pg-documents': uuid(7), 'pg-cost': '5000000', 'pg-module': 'prj' });
    run();
    const result = await screen.findByTestId('playground-result');
    expect(calls(h)).toHaveLength(1);
    const sent = calls(h)[0] as { body: Record<string, unknown> };
    expect(sent.body).toMatchObject({
      task_type: 'summarise-1',
      subject_module: 'PRJ',
      source_refs: [{ document_version_id: uuid(7) }],
      input_ref: `playground/${HELLO}`,
      input_sha256: HELLO,
      max_cost_vnd: '5000000',
    });
    expect(JSON.stringify(sent.body)).not.toContain('"hello"');
    expect(within(result).getByTestId('result-classification').textContent).toBe(word('llm.classification.confidential'));
    expect(within(result).getByTestId('result-route').textContent).toBe(word('llm.route.domestic'));
    expect(within(result).getByTestId('result-status').textContent).toBe(word('llm.requestStatus.completed'));
    expect((document.getElementById('pg-input') as HTMLTextAreaElement).value).toBe('');
    expect(
      within(result)
        .getByRole('link', { name: word('llm.playground.result.trace') })
        .getAttribute('href'),
    ).toBe(`/llm/llm-14?trace=${uuid(900)}`);
    const attempts = await screen.findByTestId('playground-attempts');
    expect(within(attempts).getByText('1,200.5 ₫')).toBeTruthy();
    expect(JSON.stringify(h.command.mock.calls)).not.toContain('"hello"');
  });

  it('keeps the text the person went on typing while the try was being answered, and clears the text that was sent', async () => {
    let answerNow: () => void = () => undefined;
    const h = open({ command: () => new Promise((resolve) => (answerNow = () => resolve(answer()))) });
    await fill();
    run();
    await waitFor(() => expect(calls(h)).toHaveLength(1));
    type('pg-input', 'the next prompt');
    await act(async () => answerNow());
    await screen.findByTestId('playground-result');
    expect((document.getElementById('pg-input') as HTMLTextAreaElement).value).toBe('the next prompt');
    expect(calls(h)).toHaveLength(1);
  });

  it('sends a PUBLIC try and a CONFIDENTIAL try through the same operation and shows the route each was given', async () => {
    let n = 0;
    const h = open({ command: () => (n++ === 0 ? answer({ data_classification: 'PUBLIC', route_class: 'INTERNATIONAL', resource_id: uuid(901) }) : answer()) });
    await fill({ 'pg-documents': uuid(7) });
    run();
    await waitFor(() => expect(screen.getByTestId('result-route').textContent).toBe(word('llm.route.international')));
    expect(screen.getByTestId('result-classification').textContent).toBe(word('llm.classification.public'));
    type('pg-input', 'hello again');
    type('pg-documents', uuid(8));
    run();
    await waitFor(() => expect(screen.getByTestId('result-route').textContent).toBe(word('llm.route.domestic')));
    expect(new Set(h.command.mock.calls.map((call) => call[0]))).toEqual(new Set(['requestAiCompletion']));
    expect(calls(h)).toHaveLength(2);
  });

  it('shows the rule that refused a try and a route that was not given', async () => {
    open({ command: () => answer({ status: 'REJECTED_POLICY', route_class: null, reject_code: 'AI_ROUTE_NOT_ALLOWED' }) });
    await fill();
    run();
    const result = await screen.findByTestId('playground-result');
    expect(within(result).getByTestId('result-route').textContent).toBe(word('llm.requests.noRoute'));
    expect(within(result).getByTestId('result-status').textContent).toContain(word('llm.rejectCode.routeNotAllowed'));
  });

  it('shows no classification when the answer does not carry one', async () => {
    open({ command: () => answer({ data_classification: null }) });
    await fill();
    run();
    expect((await screen.findByTestId('result-classification')).textContent).toBe('—');
  });

  it('does not read the trace of a try without the right to audit', async () => {
    const h = open({ permissions: ['ai.invoke', 'model_profile_version.read'] });
    await fill();
    run();
    await screen.findByTestId('playground-result');
    expect(screen.queryByRole('link', { name: word('llm.playground.result.trace') })).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows no attempts when the trace has none', async () => {
    const h = open();
    h.read.mockImplementation(() => Promise.resolve({ ...decision, attempts: [] }));
    await fill();
    run();
    await screen.findByTestId('playground-result');
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    expect(screen.queryByTestId('playground-attempts')).toBeNull();
  });

  it('keeps the attempt of the same try when it is sent again after a lost answer, and starts another for a new one', async () => {
    let n = 0;
    const h = open({
      command: () => {
        n += 1;
        return n === 1 ? new ApiError({ status: 503, code: 'UNAVAILABLE', correlationId: 'c', extensions: {} }) : answer();
      },
    });
    await fill();
    run();
    expect(await screen.findByTestId('playground-refused')).toBeTruthy();
    expect(screen.getByTestId('playground-refused').textContent).toBe(word('llm.playground.reason.general'));
    run();
    await screen.findByTestId('playground-result');
    const [first, second] = calls(h);
    expect(second?.attempt).toBe(first?.attempt);
  });

  it('says why a try was refused', async () => {
    open({ command: () => problem(429, 'BUDGET_EXCEEDED') });
    await fill();
    run();
    expect((await screen.findByTestId('playground-refused')).textContent).toBe(word('llm.playground.reason.budget'));
  });

  it('shows an answer that cannot be read as a failure', async () => {
    open({ command: () => ({}) });
    await fill();
    run();
    expect((await screen.findByTestId('playground-refused')).textContent).toBe(word('llm.playground.reason.general'));
  });

  it('cannot be run in a read-only session', async () => {
    open({ mode: 'READ_ONLY' });
    await screen.findByRole('form', { name: word('llm.playground.form.title') });
    expect((screen.getByRole('button', { name: word('llm.playground.submit.action') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is denied without the right to try or the right to read the profiles, and reads nothing', async () => {
    for (const permissions of [['model_profile_version.read'], ['ai.invoke']]) {
      const h = open({ permissions });
      expect(await screen.findByTestId('playground-denied')).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
      expect((h.client.readAll as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
      cleanup();
    }
  });

  it('shows the states of the profile read: empty, failed, and a session that lists no permissions', async () => {
    open({ profiles: [profile(2, { status: 'DRAFT' })] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open({ failProfiles: true });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open({ permissions: undefined });
    expect(await screen.findByRole('form', { name: word('llm.playground.form.title') })).toBeTruthy();
  });
});
