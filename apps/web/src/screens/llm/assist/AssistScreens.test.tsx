import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import AssistantScreen from './AssistantScreen';
import ConfigScreen from './ConfigScreen';
import EvaluationScreen from './EvaluationScreen';
import ExceptionsScreen from './ExceptionsScreen';
import ReviewScreen from './ReviewScreen';
import RunDetailScreen from './RunDetailScreen';
import { AS_OF, FORBIDDEN, assumption, countsOf, decisionView, error, inference, mount, proposal, reviewItem, reviewRun, routeOf, run, statement, unsupportedStatement, uuid } from './test/assist-support';

const word = (key: string): string => {
  const found = (base as Record<string, string | undefined>)[key];
  if (found === undefined) throw new Error(`missing key ${key}`);
  return found;
};
const USER = ['ai.assist.use', 'ai.assist.review', 'ai.assist.evaluate', 'ai.assist.decide', 'ai.config.read', 'llm.provider.read'];
const page = (items: unknown[]) => ({ items, next_cursor: null, as_of: AS_OF });
const checklist = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(300 + n),
  code: `CHK-${n}`,
  revision: 1,
  title: `Checklist ${n}`,
  applies_to: 'DIS_REPORT',
  status: 'PUBLISHED',
  items: [{ code: 'FUNDING', label: 'Names the funding source', kind: 'REQUIRED_TERMS', severity: 'BLOCKER', params: { terms: ['state budget'] } }],
  created_by: uuid(1),
  created_at: AS_OF,
  published_by: uuid(2),
  published_at: AS_OF,
  version: 2,
  ...over,
});
const criteriaSet = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(400 + n),
  code: `SET-${n}`,
  revision: 1,
  title: `Criteria ${n}`,
  scale_max: 100,
  status: 'PUBLISHED',
  criteria: [
    { code: 'TIME', label: 'Schedule', guidance: '', weight_bp: 6000, evidence_required: true },
    { code: 'QUALITY', label: 'Quality', guidance: '', weight_bp: 4000, evidence_required: true },
  ],
  weights_total_bp: 10000,
  created_by: uuid(1),
  created_at: AS_OF,
  published_by: uuid(2),
  published_at: AS_OF,
  version: 2,
  ...over,
});
const provider = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(500 + n),
  provider_code: `VN-HOST-${n}`,
  name: `Provider ${n}`,
  region_country: 'VN',
  route_class: 'DOMESTIC_HOSTED',
  max_classification: 'INTERNAL',
  status: 'ACTIVE',
  data_location_country: null,
  data_location_detail: null,
  no_training_attested: false,
  attestation_ref: null,
  attested_by: null,
  attested_at: null,
  version: 3,
  ...over,
});
const exception = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(600 + n),
  provider_id: uuid(501),
  provider_code: 'VN-HOST-1',
  route_class: 'DOMESTIC_HOSTED',
  task_type: null,
  max_classification: 'INTERNAL',
  reason: 'The model of the customer is down for maintenance.',
  requested_by: uuid(9),
  requested_at: AS_OF,
  requested_valid_days: 7,
  status: 'REQUESTED',
  in_force: false,
  decided_by: null,
  decided_at: null,
  decision_note: null,
  approval_ref: null,
  valid_from: null,
  valid_until: null,
  revoked_by: null,
  revoked_at: null,
  revoke_reason: null,
  use_count: 0,
  version: 1,
  ...over,
});

interface World {
  runs?: unknown[];
  runsFail?: Error;
  detail?: unknown;
  checklists?: unknown[];
  criteria?: unknown[];
  providers?: unknown[];
  exceptions?: unknown[];
  policy?: Record<string, unknown>;
  fail?: Record<string, Error>;
}

function world(state: World = {}): Harness {
  const answer = (operation: string): unknown => {
    const failure = state.fail?.[operation];
    if (failure !== undefined) return failure;
    switch (operation) {
      case 'listAiAssistRuns':
        return state.runsFail ?? page(state.runs ?? []);
      case 'getAiAssistRun':
        return state.detail ?? run(1);
      case 'listAiReviewChecklists':
        return page(state.checklists ?? []);
      case 'listAiEvalCriteriaSets':
        return page(state.criteria ?? []);
      case 'listAiProviders':
        return page(state.providers ?? []);
      case 'listAiExternalExceptions':
        return page(state.exceptions ?? []);
      case 'getAiEditionPolicy':
        return state.policy ?? { name: 'public', external_routing: 'ALLOWED', attestation_required: false };
      default:
        return page([]);
    }
  };
  const h = harness(answer, (operation) => (operation === 'createAiAssistRun' ? run(7) : { resource_id: uuid(1), status: 'OK', resource_version: 2 }));
  // The lists that are read to the end go through readAll: it answers the items of the same page.
  Object.assign(h.client, { readAll: vi.fn((operation: string) => Promise.resolve(((answer(operation) as { items?: unknown[] }).items ?? []) as unknown[])) });
  return h;
}

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

describe('LLM-22 the assistant (AI.01, AI.05, AI.07)', () => {
  const route = routeOf('LLM-22');
  const open = (state: World = {}, options: { permissions?: string[]; mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) => {
    const h = world(state);
    mount(<AssistantScreen route={route} />, h, { permissions: options.permissions ?? USER, ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.path === undefined ? {} : { path: options.path }) });
    return h;
  };

  it('says that the answer is a proposal, and is denied to a person who may not ask', async () => {
    open();
    expect((await screen.findByTestId('page-advisory')).textContent).toBe(word('llm.assist.run.advisory'));
    cleanup();
    open({}, { permissions: ['ai.config.read'] });
    expect(screen.queryByTestId('ask-button')).toBeNull();
  });

  it('refuses an empty form before it calls anything: the text and the sources are required', async () => {
    const h = open();
    fireEvent.click(await screen.findByTestId('ask-button'));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends the question with its sources and shows the answer by what each statement rests on', async () => {
    const statements = [statement('s1'), assumption('s2'), inference('s3', ['s1']), unsupportedStatement('s4')];
    const h = world();
    h.command.mockResolvedValue(run(7, { statements, counts: countsOf(statements) }));
    mount(<AssistantScreen route={route} />, h, { permissions: USER, path: `/?subject_kind=PROJECT&subject_id=${uuid(201)}` });
    fireEvent.change(await screen.findByLabelText(word('llm.assist.form.text')), { target: { value: 'What is the investment?' } });
    fireEvent.click(screen.getByTestId('ask-button'));
    await screen.findByTestId('run-view');
    expect(h.command).toHaveBeenCalledWith('createAiAssistRun', expect.objectContaining({ body: expect.objectContaining({ kind: 'QA', request_text: 'What is the investment?' }) }));
    expect(screen.getByTestId('count-statements').textContent).toContain('4');
    expect(screen.getByTestId('count-unsupported').textContent).toContain('1');
    expect(screen.getByTestId('statements').textContent).toContain('Statement s1');
    expect(screen.getByTestId('advisory-note')).toBeTruthy();
  });

  it('shows the refusal of the gateway as it is told', async () => {
    const h = world();
    h.command.mockRejectedValue(error(422, 'AI_EXTERNAL_EXCEPTION_REQUIRED'));
    mount(<AssistantScreen route={route} />, h, { permissions: USER, path: `/?subject_kind=PROJECT&subject_id=${uuid(201)}` });
    fireEvent.change(await screen.findByLabelText(word('llm.assist.form.text')), { target: { value: 'What is the investment?' } });
    fireEvent.click(screen.getByTestId('ask-button'));
    expect((await screen.findByTestId('submit-failure')).textContent).not.toBe('');
  });

  it('is read only when the workspace is: the button is off and the note says why', async () => {
    open({}, { mode: 'READ_ONLY' });
    expect(await screen.findByTestId('read-only-note')).toBeTruthy();
    expect((screen.getByTestId('ask-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the history of the person: empty, listed with a link to each run, and a failure with a retry', async () => {
    open({ runs: [] });
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    cleanup();
    open({ runs: [run(1), run(2, { status: 'REFUSED', refusal_code: 'AI_ROUTE_NOT_ALLOWED', statements: [] })] });
    expect((await screen.findAllByTestId('open-run')).length).toBe(2);
    cleanup();
    open({ runsFail: error(500, 'INTERNAL') });
    expect(await screen.findByRole('button', { name: word('states.retry.action') })).toBeTruthy();
  });
});

describe('LLM-23 one run and the decision of the person (AI.01, AI.04)', () => {
  const route = routeOf('LLM-23');
  const open = (state: World = {}, id: string = uuid(1), permissions: string[] = USER, mode?: 'FULL' | 'READ_ONLY') => {
    const h = world(state);
    mount(<RunDetailScreen route={route} />, h, { permissions, path: `/?run=${id}`, ...(mode === undefined ? {} : { mode }) });
    return h;
  };

  it('says there is no run when the link names none, and when the server does not know it', async () => {
    open({}, 'nope');
    expect(await screen.findByTestId('no-run')).toBeTruthy();
    cleanup();
    open({ fail: { getAiAssistRun: error(404, 'RESOURCE_NOT_FOUND') } });
    expect(await screen.findByTestId('run-not-found')).toBeTruthy();
  });

  it('is denied without the right to ask, and shows a failure with a retry', async () => {
    open({}, uuid(1), ['ai.config.read']);
    expect(screen.queryByTestId('run-view')).toBeNull();
    cleanup();
    open({ fail: { getAiAssistRun: error(500, 'INTERNAL') } });
    expect(await screen.findByRole('button', { name: word('states.retry.action') })).toBeTruthy();
  });

  it('shows the statements by their label, the unsupported one as without a source, the hidden citations and the instruction-like text', async () => {
    const statements = [statement('s1'), unsupportedStatement('s2')];
    open({ detail: run(1, { statements, counts: countsOf(statements, { withheld_citations: 2, injection_signals: 1 }) }) });
    await screen.findByTestId('run-view');
    expect(screen.getByTestId('count-verified').textContent).toContain('1');
    expect(screen.getByTestId('withheld-note')).toBeTruthy();
    expect(screen.getByTestId('injection-note')).toBeTruthy();
    expect(screen.getByTestId('decision-panel')).toBeTruthy();
  });

  it('records the decision: the person gives a reason and accepts; a run already decided shows the receipt and no panel', async () => {
    const h = open({});
    await screen.findByTestId('decision-panel');
    fireEvent.change(within(screen.getByTestId('decision-panel')).getByRole('textbox'), { target: { value: 'The statements agree with the file of the project.' } });
    fireEvent.click(screen.getByTestId('record-decision'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideAiAssistRun', expect.objectContaining({ body: expect.objectContaining({ decision: expect.any(String) }) })));
    cleanup();
    open({ detail: run(1, { decision: decisionView('ACCEPTED'), decision_status: 'ACCEPTED' }) });
    expect(await screen.findByTestId('decision-receipt')).toBeTruthy();
    expect(screen.queryByTestId('record-decision')).toBeNull();
  });

  it('tells a person who may not decide, and a workspace that is read only', async () => {
    open({}, uuid(1), ['ai.assist.use']);
    expect(await screen.findByTestId('decide-no-right')).toBeTruthy();
    cleanup();
    open({}, uuid(1), USER, 'READ_ONLY');
    expect(await screen.findByTestId('decide-read-only')).toBeTruthy();
  });

  it('shows the refusal of a run that the gateway did not serve', async () => {
    open({ detail: run(1, { status: 'REFUSED', refusal_code: 'AI_EXTERNAL_EXCEPTION_REQUIRED', statements: [], counts: countsOf([]), completeness: 'NONE' }) });
    expect(await screen.findByTestId('run-refused')).toBeTruthy();
    expect(screen.queryByTestId('decision-panel')).toBeNull();
  });
});

describe('LLM-24 the review of a file before it is sent up (AI.02)', () => {
  const route = routeOf('LLM-24');
  const open = (state: World = {}, permissions: string[] = USER) => {
    const h = world(state);
    mount(<ReviewScreen route={route} />, h, { permissions });
    return h;
  };

  it('says that the verdict is advice, and is denied without the right to review', async () => {
    open({ checklists: [checklist(1)] });
    expect(await screen.findByTestId('review-advice')).toBeTruthy();
    cleanup();
    open({}, ['ai.assist.use']);
    expect(screen.queryByTestId('review-button')).toBeNull();
  });

  it('says when no checklist is published, shows a failure to read them and a denial', async () => {
    open({ checklists: [] });
    expect(await screen.findByTestId('no-published-checklist')).toBeTruthy();
    cleanup();
    open({ fail: { listAiReviewChecklists: error(500, 'INTERNAL') } });
    expect(await screen.findByTestId('section-failed')).toBeTruthy();
    cleanup();
    open({ fail: { listAiReviewChecklists: FORBIDDEN } });
    expect(await screen.findByTestId('section-denied')).toBeTruthy();
  });

  it('asks for the checklist and the document, then reviews and shows the verdict and each item', async () => {
    const items = [reviewItem('FUNDING'), reviewItem('DELAY', { result: 'UNKNOWN', by: 'ASSISTANT', severity: 'BLOCKER', detail: 'PASS_WITHOUT_EVIDENCE' })];
    const h = open({ checklists: [checklist(1)] });
    h.command.mockResolvedValue(reviewRun(7, items, 'NOT_READY'));
    await screen.findByRole('option', { name: /CHK-1/ });
    fireEvent.click(screen.getByTestId('review-button'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(word('llm.review.form.checklist')), { target: { value: uuid(301) } });
    fireEvent.change(screen.getByLabelText(word('llm.review.form.document')), { target: { value: uuid(101) } });
    fireEvent.click(screen.getByTestId('review-button'));
    expect((await screen.findByTestId('review-verdict')).textContent).not.toBe('');
    expect(h.command).toHaveBeenCalledWith('createAiAssistRun', expect.objectContaining({ body: expect.objectContaining({ kind: 'DOC_REVIEW', checklist_id: uuid(301) }) }));
    expect(screen.getByTestId('review-counts').textContent).toContain('1');
  });
});

describe('LLM-25 the evaluation of a contract (AI.04)', () => {
  const route = routeOf('LLM-25');
  const open = (state: World = {}, permissions: string[] = USER) => {
    const h = world(state);
    mount(<EvaluationScreen route={route} />, h, { permissions });
    return h;
  };

  it('says that nothing is totalled from the proposal, and is denied without the right to evaluate', async () => {
    open({ criteria: [criteriaSet(1)] });
    expect(await screen.findByTestId('evaluation-note')).toBeTruthy();
    cleanup();
    open({}, ['ai.assist.use']);
    expect(screen.queryByTestId('evaluation-button')).toBeNull();
  });

  it('says when no set of criteria is published', async () => {
    open({ criteria: [] });
    expect(await screen.findByTestId('no-published-set')).toBeTruthy();
  });

  it('shows the proposal with the score withheld for a criterion that needs evidence, and lets the person score it; the total is computed from the accepted scores', async () => {
    const proposals = [proposal('TIME', 6000, 80), proposal('QUALITY', 4000, null, 'NEEDS_EVIDENCE')];
    const evaluated = run(7, {
      kind: 'CONTRACT_EVAL',
      criteria_set_id: uuid(401),
      statements: [],
      counts: countsOf([]),
      result: { open_questions: [], signals: { count: 0, kinds: [] }, truncated: false, included_parts: 1, evaluation: { criteria_set: { id: uuid(401), code: 'SET-1', revision: 1, title: 'Criteria 1' }, scale_max: 100, criteria: proposals } },
    });
    const h = open({ criteria: [criteriaSet(1)] });
    h.command.mockResolvedValue(evaluated);
    await screen.findByRole('option', { name: /SET-1/ });
    fireEvent.change(screen.getByLabelText(word('llm.evaluation.form.set')), { target: { value: uuid(401) } });
    fireEvent.change(screen.getByLabelText(word('llm.evaluation.form.contract')), { target: { value: uuid(701) } });
    fireEvent.click(screen.getByTestId('evaluation-button'));
    await screen.findByTestId('score-panel');
    expect(screen.getByTestId('proposed-score')).toBeTruthy();
    fireEvent.change(within(screen.getByTestId('score-QUALITY')).getByRole('spinbutton'), { target: { value: '60' } });
    expect(screen.getByTestId('live-total').textContent).toContain('72');
  });
});

describe('LLM-26 the checklists and the sets of criteria (AI.02, AI.04)', () => {
  const route = routeOf('LLM-26');
  const MANAGER = ['ai.config.read', 'ai.config.manage', 'ai.config.approve'];
  const open = (state: World = {}, permissions: string[] = MANAGER) => {
    const h = world(state);
    mount(<ConfigScreen route={route} />, h, { permissions });
    return h;
  };

  it('is denied without a right over the configuration', async () => {
    open({}, ['ai.assist.use']);
    expect(screen.queryByTestId('config-rule')).toBeNull();
  });

  it('shows the rule, the checklists with their state, and the criteria in the other tab', async () => {
    open({ checklists: [checklist(1), checklist(2, { status: 'DRAFT', version: 1, published_by: null, published_at: null })], criteria: [criteriaSet(1)] });
    expect((await screen.findByTestId('config-rule')).textContent).toBe(word('llm.config.page.rule'));
    expect(await screen.findByText('CHK-1')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('tab')[1] as HTMLElement);
    expect(await screen.findByText('SET-1')).toBeTruthy();
    expect(screen.getByTestId('panel-criteria')).toBeTruthy();
  });

  it('shows a failure with a retry and an empty list', async () => {
    open({ fail: { listAiReviewChecklists: error(500, 'INTERNAL') } });
    expect(await screen.findByRole('button', { name: word('states.retry.action') })).toBeTruthy();
    cleanup();
    open({ checklists: [] });
    await screen.findByTestId('config-rule');
    expect(screen.queryByText('CHK-1')).toBeNull();
  });

  it('publishes a draft with its version, and tells the person who drafted it that another person publishes', async () => {
    const h = open({ checklists: [checklist(2, { status: 'DRAFT', version: 1, published_by: null, published_at: null })] });
    h.command.mockRejectedValueOnce(error(403, 'SELF_APPROVAL_DENIED'));
    fireEvent.click(await screen.findByRole('button', { name: word('llm.config.action.publish') }));
    const confirm = await screen.findAllByRole('button', { name: word('llm.config.action.publish') });
    fireEvent.click(confirm[confirm.length - 1] as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('publishAiReviewChecklist', expect.objectContaining({ ifMatchVersion: 1 })));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
  });

  it('offers a new draft only to who may manage, and keeps the new button off in a read only workspace', async () => {
    open({}, ['ai.config.read']);
    await screen.findByTestId('config-rule');
    expect(screen.queryByTestId('new-button')).toBeNull();
  });
});

describe('LLM-27 the providers outside the customer servers and their exceptions (AI.07, R5, KT.02)', () => {
  const route = routeOf('LLM-27');
  const ADMIN = ['llm.provider.read', 'llm.provider.manage', 'llm.exception.read', 'llm.exception.request', 'llm.exception.approve'];
  const open = (state: World = {}, permissions: string[] = ADMIN) => {
    const h = world(state);
    mount(<ExceptionsScreen route={route} />, h, { permissions });
    return h;
  };
  const STRICT = { name: 'customer-servers-only', external_routing: 'EXCEPTION_REQUIRED', attestation_required: true };

  it('is denied without any right over the providers or the exceptions', async () => {
    open({}, ['ai.assist.use']);
    expect(screen.queryByTestId('policy-banner')).toBeNull();
  });

  it('tells what the edition says: off by default under the strict policy, and the routing policy kept under the public one', async () => {
    open({ policy: STRICT, providers: [provider(1)] });
    const strict = (await screen.findByTestId('policy-banner')).textContent;
    cleanup();
    open({ providers: [provider(1)] });
    const lenient = (await screen.findByTestId('policy-banner')).textContent;
    expect(strict).not.toBe(lenient);
  });

  it('lists the providers with where they keep the data and whether they attested no training', async () => {
    open({ policy: STRICT, providers: [provider(1), provider(2, { data_location_country: 'VN', data_location_detail: 'Data hall 2', no_training_attested: true, attestation_ref: 'DPA-2026-07', attested_by: uuid(3), attested_at: AS_OF })] });
    expect(await screen.findByText('VN-HOST-1')).toBeTruthy();
    expect(screen.getByText('VN-HOST-2')).toBeTruthy();
    expect(screen.getAllByTestId('location').length).toBeGreaterThan(0);
  });

  it('lists the exceptions with their state and keeps the receipt of a request', async () => {
    const h = open({ policy: STRICT, providers: [provider(1)], exceptions: [exception(1), exception(2, { status: 'APPROVED', in_force: true, approval_ref: 'DEC-2026-114', valid_from: AS_OF, valid_until: '2026-11-15T03:00:00.000Z', use_count: 3, version: 2 })] });
    expect(await screen.findByText('DEC-2026-114')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('request-button'));
    expect(await screen.findByTestId('request-form')).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows a failure of the providers with a retry, and a denial of the exceptions', async () => {
    open({ fail: { listAiProviders: error(500, 'INTERNAL') } });
    expect(await screen.findAllByRole('button', { name: word('states.retry.action') })).not.toHaveLength(0);
    cleanup();
    open({ providers: [], fail: { listAiExternalExceptions: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) } });
    expect(await screen.findByTestId('policy-banner')).toBeTruthy();
  });
});
