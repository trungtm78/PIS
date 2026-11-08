import { ApiError } from '@machvon/api-client';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as translate } from '../../i18n';
import EscalationScreen from './EscalationScreen';
import { AS_OF, DEPUTY, ESCALATION_ID, HEALTH_READER, OTHER, READER, client, escalationRow, failing, mount, policyParams, route, rule, world } from './test-support';
import type { World } from './test-support';

const ROUTE = route('NOT-19', 'FR-NOT-19', 'NOT');
const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);
const SECOND = '00000000-0000-4000-8000-00000000e002';
const THIRD = '00000000-0000-4000-8000-00000000e003';
const FOURTH = '00000000-0000-4000-8000-00000000e004';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const page = (items: unknown[], over: Record<string, unknown> = {}) => ({ items, rule: rule({ params: policyParams() }), as_of: AS_OF, ...over });

function open(state: World, permissions: readonly string[] | undefined = HEALTH_READER) {
  const h = client(state);
  const view = mount(<EscalationScreen route={ROUTE} />, h, { permissions, path: '/not/not-19' });
  return { h, ...view };
}

describe('EscalationScreen (NOT-19): the levels an item was sent up', () => {
  it('shows a skeleton while it loads and then a row for each level', async () => {
    const { h } = open(world());
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: text('alertgov.escalation.table.caption') });
    expect(h.read).toHaveBeenCalledWith('listAlertEscalations', { query: { status: 'open', limit: '100' } });
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(row.textContent).toContain('Post the invitation to bid');
    expect(row.textContent).toContain(text('alertgov.kind.hierarchical'));
    expect(row.textContent).toContain(text('alertgov.trigger.notClaimed'));
    expect(row.textContent).toContain('Tran Van Me');
    expect(row.textContent).toContain(text('alertgov.status.open'));
    expect(within(row).getByRole('link', { name: 'Post the invitation to bid' })).toBeInTheDocument();
  });

  it('marks a functional level, a raised item and a level a deputy received', async () => {
    open(
      world({
        escalations: page([
          escalationRow(ESCALATION_ID, { kind: 'FUNCTIONAL', level: 2, recipient: { id: OTHER, name: 'Le Thi Other' } }),
          escalationRow(SECOND, { kind: 'PROMOTION', level: 0, trigger: 'WATCH_AGED', recipient: null, routed_via: 'NONE', severity: 'ACTION', from_severity: 'WATCH' }),
          escalationRow(THIRD, { recipient: { id: DEPUTY, name: 'Pham Deputy' }, routed_via: 'DEPUTY' }),
          escalationRow(FOURTH, { trigger: 'ORPHANED', routed_via: 'FALLBACK_ADMIN', status: 'CLOSED', closed_at: AS_OF, close_reason: 'RESOLVED' }),
        ]),
      }),
    );
    const table = await screen.findByRole('table', { name: text('alertgov.escalation.table.caption') });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain(text('alertgov.kind.functional'));
    expect(rows[1]?.textContent).toContain(text('alertgov.kind.promotion'));
    expect(rows[1]?.textContent).toContain(text('alertgov.escalation.promoted.text', { from: text('alertgov.severity.watch') }));
    expect(rows[1]?.textContent).toContain(text('alertgov.trigger.watchAged'));
    expect(rows[2]?.textContent).toContain(text('alertgov.via.deputy'));
    expect(rows[3]?.textContent).toContain(text('alertgov.trigger.orphaned'));
    expect(rows[3]?.textContent).toContain(text('alertgov.status.closed'));
  });

  it('shows the chain in force with its version, the hold, the raising of items to be watched and the label of a default nobody confirmed', async () => {
    open(world());
    const policy = await screen.findByTestId('policy');
    expect(within(policy).getByTestId('steps-URGENT').textContent).toContain(text('alertgov.escalation.step.after', { what: text('alertgov.escalation.step.hierarchical', { levels: 1 }), hours: 0 }));
    expect(within(policy).getByTestId('steps-URGENT').textContent).toContain(text('alertgov.escalation.step.functional', { role: 'AUDITOR' }));
    expect(policy.textContent).toContain(text('alertgov.escalation.policy.noLevels'));
    expect(policy.textContent).toContain(text('alertgov.escalation.policy.hold', { hours: 8 }));
    expect(within(policy).getByTestId('promotion').textContent).toBe(text('alertgov.escalation.policy.promotion', { days: 20 }));
    expect(screen.getByTestId('rule-note').textContent).toContain(text('alertgov.rule.version.text', { version: 'builtin' }));
    expect(screen.getByTestId('rule-note').textContent).toContain(text('alertgov.rule.unverified.label'));
    expect(screen.getByRole('button', { name: text('alertgov.info.open.label', { name: text('alertgov.escalation.policy.title') }) })).toBeInTheDocument();
  });

  it('says so when the policy cannot be read, and when a promotion is switched off', async () => {
    open(world({ escalations: page([escalationRow(ESCALATION_ID)], { rule: rule({ params: {} }) }) }));
    expect(await screen.findByText(text('alertgov.escalation.policy.unreadable'))).toBeInTheDocument();
    cleanup();
    open(world({ escalations: page([escalationRow(ESCALATION_ID)], { rule: rule({ params: { ...policyParams(), watch_promotion: { enabled: false, after_working_days: 20 } } }) }) }));
    expect((await screen.findByTestId('promotion')).textContent).toBe(text('alertgov.escalation.policy.promotionOff'));
  });

  it('offers to acknowledge only the levels the signed-in person received and that are open', async () => {
    open(
      world({
        escalations: page([
          escalationRow(ESCALATION_ID),
          escalationRow(SECOND, { recipient: { id: OTHER, name: 'Le Thi Other' } }),
          escalationRow(THIRD, { status: 'ACKNOWLEDGED', acknowledged_at: AS_OF }),
          escalationRow(FOURTH, { kind: 'PROMOTION', level: 0, trigger: 'WATCH_AGED', recipient: null, routed_via: 'NONE', from_severity: 'WATCH' }),
        ]),
      }),
    );
    await screen.findByRole('table', { name: text('alertgov.escalation.table.caption') });
    expect(screen.getByTestId(`ack-${ESCALATION_ID}`)).toBeInTheDocument();
    for (const id of [SECOND, THIRD, FOURTH]) expect(screen.queryByTestId(`ack-${id}`)).toBeNull();
  });

  it('acknowledges with one command, shows the result and reads the list again', async () => {
    const { h } = open(world());
    await userEvent.click(await screen.findByTestId(`ack-${ESCALATION_ID}`));
    expect(await screen.findByTestId('ack-done')).toBeInTheDocument();
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command.mock.calls[0]?.[0]).toBe('acknowledgeAlertEscalation');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ESCALATION_ID } });
    expect(h.read.mock.calls.filter(([operation]) => operation === 'listAlertEscalations').length).toBeGreaterThanOrEqual(2);
  });

  it('locks the button while the command runs, so that a second click is not a second command', async () => {
    const state = world();
    const { h } = open(state);
    let release: (value: unknown) => void = () => undefined;
    (h.client as unknown as { command: unknown }).command = h.command.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const button = await screen.findByTestId(`ack-${ESCALATION_ID}`);
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByTestId(`ack-${ESCALATION_ID}`)).toBeDisabled());
    expect(screen.getByTestId(`ack-${ESCALATION_ID}`).textContent).toBe(text('alertgov.escalation.ack.pending'));
    await userEvent.click(screen.getByTestId(`ack-${ESCALATION_ID}`));
    expect(h.command).toHaveBeenCalledTimes(1);
    await act(async () => release({ operation_id: 'o', status: 'ACKNOWLEDGED', resource_version: 2 }));
    expect(await screen.findByTestId('ack-done')).toBeInTheDocument();
  });

  it('says in words what the server answered when the level is not theirs (404) or was already taken (409), and lets the message go', async () => {
    const { h } = open(world());
    h.command.mockRejectedValueOnce(new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }));
    await userEvent.click(await screen.findByTestId(`ack-${ESCALATION_ID}`));
    expect((await screen.findByTestId('ack-error')).textContent).toContain(text('alertgov.problem.notFound.text'));
    h.command.mockRejectedValueOnce(new ApiError({ status: 409, code: 'ALERT_ESCALATION_STATE_INVALID', correlationId: 'c' }));
    await userEvent.click(screen.getByTestId(`ack-${ESCALATION_ID}`));
    await waitFor(() => expect(screen.getByTestId('ack-error').textContent).toContain(text('alertgov.problem.state.text')));
    await userEvent.click(within(screen.getByTestId('ack-error')).getByRole('button', { name: text('alertgov.common.dismiss.action') }));
    expect(screen.queryByTestId('ack-error')).toBeNull();
  });

  it('asks for all the levels when the filter says so', async () => {
    const { h } = open(world());
    await screen.findByRole('table', { name: text('alertgov.escalation.table.caption') });
    await userEvent.selectOptions(screen.getByTestId('status'), 'all');
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listAlertEscalations', { query: { status: 'all', limit: '100' } }));
  });

  it('shows an empty list as empty, an error with a retry, and keeps the last list when a refresh fails', async () => {
    open(world({ escalations: page([]) }));
    expect(await screen.findByText(text('states.empty.title'))).toBeInTheDocument();
    cleanup();
    const broken = world({ failing: failing('listAlertEscalations', new Error('boom')) });
    open(broken);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    broken.failing.clear();
    await userEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    await screen.findByRole('table', { name: text('alertgov.escalation.table.caption') });
    cleanup();
    const state = world();
    const { queries } = open(state);
    await screen.findByRole('table', { name: text('alertgov.escalation.table.caption') });
    state.failing = failing('listAlertEscalations', new Error('boom'));
    await queries.refetchQueries();
    expect(await screen.findByTestId('stale')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: text('alertgov.escalation.table.caption') })).toBeInTheDocument();
  });

  it('is denied without the right to read the health, and when the server refuses', async () => {
    const { h } = open(world(), READER);
    expect(await screen.findByText(text('states.denied.title'))).toBeInTheDocument();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    open(world({ failing: failing('listAlertEscalations', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })) }));
    expect(await screen.findByText(text('states.denied.title'))).toBeInTheDocument();
  });
});
