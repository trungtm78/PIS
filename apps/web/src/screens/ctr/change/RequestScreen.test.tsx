import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import RequestScreen from './RequestScreen';
import { PROJECT, UUID_A, active, chain, client, config, contractId, guestRequest, mount, request, requestId, routeOf, world } from './test-support';
import type { World } from './test-support';
import { revision } from '../test-support';

const ROUTE = routeOf('CTR-07', 'FR-CTR-07');
const PATH = `/ctr/ctr-07?contract=${contractId(1)}`;
const OK = { operation_id: 'o', status: 'SUBMITTED', resource_version: 1, resource_id: requestId(9) };
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<RequestScreen route={ROUTE} />, h, { permissions: ['contract.read'], path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const send = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['ctr.change.request.submit'] }));
};
const BASELINE = revision(1, { status: 'EFFECTIVE', revision: 1 }).id;

describe('RequestScreen (CTR-07): raise a change on a contract', () => {
  it('asks for a contract when the address names none, and offers only the ones being performed', async () => {
    const h = open(world(), { path: '/ctr/ctr-07' });
    await screen.findByRole('heading', { level: 2, name: vi_['ctr.change.pick.contract.title'] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.change.request.title']);
    const options = Array.from(document.querySelectorAll('#change-contract option')).map((option) => option.textContent);
    expect(options).toEqual([vi_['ctr.change.pick.contract.choose'], 'HD-A-001 · Hợp đồng số 1', 'HD-A-002 · Hợp đồng số 2']);
    fireEvent.change(document.getElementById('change-contract') as HTMLElement, { target: { value: '' } });
    expect(h.read).not.toHaveBeenCalled();
    fireEvent.change(document.getElementById('change-contract') as HTMLElement, { target: { value: contractId(1) } });
    await screen.findByTestId('facts');
    expect(h.read).toHaveBeenCalledWith('get_resources_contract_id', { path: { id: contractId(1) } });
  });

  it('shows the contract with its requests, and the form with the tier the chain starts at', async () => {
    open(world({ chain: chain({ requests: [request(1), request(2, { code: 'CE-002', status: 'WITHDRAWN' })] }) }));
    await screen.findByTestId('facts');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.change.request.title']);
    expect(screen.getByTestId('contract-code').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('value').textContent).toBe(text('ctr.value.amount', { amount: '10.200.000.000' }));
    const rows = within(screen.getByTestId('requests')).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'CE-001' }).getAttribute('href')).toBe(`/ctr/ctr-19?project=${PROJECT}&contract=${contractId(1)}`);
    expect(within(rows[1] as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['CE-001', vi_['ctr.change.stage.event'], vi_['ctr.change.status.submitted'], '400.000.000', vi_['ctr.change.none.text'], '10']);
    expect(screen.getByTestId('start-stage').textContent).toBe(text('ctr.change.request.stage.notice', { stage: 'ChangeEvent', count: 3 }));
    expect((document.getElementById('request-baseline') as HTMLSelectElement).value).toBe(BASELINE);
    expect(screen.getByTestId('board-link').getAttribute('href')).toBe(`/ctr/ctr-19?project=${PROJECT}&contract=${contractId(1)}`);
    expect(screen.getByText(text('ctr.change.request.footer', { id: 'CTR-07', req: 'FR-CTR-07' }))).toBeTruthy();
  });

  it('AC-ST-CTR-006-1, UAT-AC307: warns that the first request fixes the tiers, and says nothing of it once they are fixed', async () => {
    open(world());
    expect((await screen.findByTestId('locks-notice')).textContent).toBe(text('ctr.change.request.locks.notice', { count: 3 }));
    expect(screen.getByTestId('no-requests').textContent).toBe(vi_['ctr.change.request.list.empty']);
    cleanup();
    open(world({ chain: chain({ config: config({ locked: true, locked_at: '2026-10-24T01:00:00.000Z' }), requests: [request(1)] }) }));
    await screen.findByTestId('start-stage');
    expect(screen.queryByTestId('locks-notice')).toBeNull();
  });

  it('judges the form and raises the request at the first tier under the revision in force', async () => {
    const h = open(world());
    await screen.findByTestId('start-stage');
    type('request-baseline', '');
    send();
    expect(screen.getAllByText(vi_['ctr.change.problem.required'])).toHaveLength(2);
    type('request-baseline', BASELINE);
    type('request-reason', 'x'.repeat(2001));
    type('request-estimated', '1.5');
    type('request-days', 'soon');
    send();
    expect(screen.getByText(vi_['ctr.change.problem.tooLong'])).toBeTruthy();
    expect(screen.getByText(vi_['ctr.change.problem.amount'])).toBeTruthy();
    expect(screen.getByText(vi_['ctr.change.problem.days'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    type('request-reason', 'The owner instructed a wider footpath.');
    type('request-kind', 'DESIGN_CHANGE');
    type('request-estimated', '400000000');
    type('request-days', '10');
    send();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'createChangeRequest',
      expect.objectContaining({
        path: { id: contractId(1) },
        body: { stage: 'EVENT', baseline_revision_id: BASELINE, event_kind: 'DESIGN_CHANGE', reason: 'The owner instructed a wider footpath.', estimated_delta_vnd: '400000000', schedule_impact_days: 10 },
      }),
    );
    expect((await screen.findByTestId('done')).textContent).toBe(vi_['ctr.change.request.done.notice']);
    // The form starts over for the next request.
    expect((document.getElementById('request-reason') as HTMLTextAreaElement).value).toBe('');
  });

  it('raises a request with the reason alone, at the tier of a chain of two or of one', async () => {
    for (const [tiers, stages, stage] of [
      [2, ['PCO', 'CO'], 'PCO'],
      [1, ['CO'], 'CO'],
    ] as const) {
      const h = open(world({ chain: chain({ config: config({ tier_count: tiers, stages }) }) }));
      await screen.findByTestId('start-stage');
      type('request-reason', 'A reason.');
      send();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('createChangeRequest', expect.objectContaining({ body: { stage, baseline_revision_id: BASELINE, reason: 'A reason.' } }));
      cleanup();
    }
  });

  it('offers the revision in force that is the latest, and none that is not in force', async () => {
    const state = world({ details: [active({ revisions: [revision(1, { status: 'SUPERSEDED', revision: 1 }), revision(2, { status: 'EFFECTIVE', revision: 2, amount_vnd: '11000000000' }), revision(3, { status: 'DRAFT', revision: 3 })] })] });
    open(state);
    await screen.findByTestId('start-stage');
    const options = Array.from(document.querySelectorAll('#request-baseline option')).map((option) => option.textContent);
    expect(options).toEqual([text('ctr.change.request.revision.option', { revision: 2, amount: '11.000.000.000' })]);
    expect((document.getElementById('request-baseline') as HTMLSelectElement).value).toBe(revision(2).id);
  });

  it('shows the refusal of the server in words and keeps what was typed', async () => {
    for (const [error, expected] of [
      [problem('CHANGE_STAGE_NOT_ALLOWED', 422, { allowed_stage: 'PCO', tier_count: 2 }), `${vi_['ctr.change.error.wrongStage']} ${text('ctr.change.error.startsAt', { stage: 'PCO' })}`],
      [problem('CHANGE_STAGE_NOT_ALLOWED', 422, { reason: 'TIERS_NOT_CONFIGURED' }), vi_['ctr.change.error.notConfigured']],
      [problem('CONTRACT_STATE_INVALID', 409, { contract_status: 'COMPLETED' }), vi_['ctr.change.error.contractState']],
      [problem('VALIDATION_FAILED', 422, {}), vi_['ctr.change.error.validation']],
      [problem('SCOPE_DENIED', 403, {}), vi_['ctr.change.error.denied']],
      [problem('SESSION_EXPIRED', 401, {}), vi_['ctr.change.error.session']],
    ] as const) {
      open(world(), { command: () => error });
      await screen.findByTestId('start-stage');
      type('request-reason', 'A reason.');
      send();
      expect((await screen.findByTestId('refusal')).textContent).toBe(expected);
      expect((document.getElementById('request-reason') as HTMLTextAreaElement).value).toBe('A reason.');
      expect(screen.queryByTestId('done')).toBeNull();
      cleanup();
    }
  });

  describe('when the form is not offered', () => {
    it('says the tiers are not set, and links to the policy for the one who may set them', async () => {
      open(world({ chain: chain({ config: undefined }) }));
      const notice = await screen.findByTestId('not-configured');
      expect(notice.textContent).toContain(vi_['ctr.change.request.notConfigured']);
      expect(within(notice).getByRole('link', { name: vi_['ctr.change.request.tiers.link'] }).getAttribute('href')).toBe(`/ctr/ctr-20?project=${PROJECT}`);
      cleanup();
      open(world({ chain: chain({ config: undefined, actions: { configure: false, open: true } }) }));
      expect(within(await screen.findByTestId('not-configured')).queryByRole('link')).toBeNull();
    });

    it('says the caller may not raise a change, in a read-only session as well', async () => {
      open(world({ chain: chain({ actions: { configure: false, open: false } }) }));
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.change.request.noCommand']);
      expect(document.getElementById('request-reason')).toBeNull();
      cleanup();
      open(world(), { mode: 'READ_ONLY' });
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.change.request.noCommand']);
    });

    it('says a contract that is not being performed takes no change', async () => {
      open(world({ details: [active({ status: 'COMPLETED' })] }));
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.change.request.notPerformed']);
    });

    it('says a contract with no revision in force has nothing to rest a change on', async () => {
      open(world({ details: [active({ revisions: [revision(1, { status: 'DRAFT' })] })] }));
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.change.request.noRevision']);
    });

    it('shows a guest contractor its requests and no form', async () => {
      open(world({ chain: chain({ config: undefined, requests: [guestRequest(1)], actions: { configure: false, open: false } }) }));
      await screen.findByTestId('requests');
      expect(screen.getByTestId('no-command')).toBeTruthy();
      expect(within(screen.getByTestId('requests')).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
        'CE-001',
        vi_['ctr.change.stage.event'],
        vi_['ctr.change.status.submitted'],
        vi_['ctr.change.none.text'],
        vi_['ctr.change.none.text'],
        vi_['ctr.change.none.text'],
      ]);
    });
  });

  describe('the states', () => {
    it('answers a contract that does not exist for the caller with the empty state', async () => {
      open(world({ details: [] }), { path: `/ctr/ctr-07?contract=${UUID_A}` });
      expect(await screen.findByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
    });

    it('answers a failed read of the chain with the error state, and reads both again when retried', async () => {
      const state = world({ failing: new Set(['getChangeChain']) });
      const h = open(state);
      const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
      state.failing.clear();
      fireEvent.click(retry);
      await screen.findByTestId('start-stage');
      expect(h.read.mock.calls.filter(([operation]) => operation === 'getChangeChain')).toHaveLength(2);
    });
  });
});
