import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import DecisionLogScreen from './DecisionLogScreen';
import { recordLink, toDecisionDetail, toDecisionPage } from './decision-model';

const ROUTE = routeOf('BI-22', 'FR-BI-22');
const WRITER = ['home.read', 'home.decision.record'];
const READER = ['home.read'];
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const ME = { id: '00000000-0000-4000-8000-000000000001', name: 'Leader One' };
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  subject: { kind: 'KPI_TILE', metric_code: 'DISBURSEMENT_RATE_PM', unit_id: null, unit_name: null, source: null, source_id: null, title: null },
  kind: 'DIRECT_ACTION',
  reason: 'Ask the units that lag to catch up this month.',
  headline: { metric_code: 'DISBURSEMENT_RATE_PM', display_value: '60,00', null_reason: null },
  figures_sha256: 'a'.repeat(64),
  snapshot_id: 's1',
  as_of_date: '2027-10-12',
  unverified: true,
  follow_up: { owner: null, due_on: '2027-10-30', state: 'DUE_SOON' },
  decided_by: ME,
  decided_at: '2027-10-20T03:00:00.000Z',
  latest_outcome: null,
  outcome_count: 0,
  ...over,
});
const policy = { kinds: ['ACCEPT_RISK', 'DIRECT_ACTION', 'ESCALATE'], reason_min: 10, reason_max: 1000, follow_up_max_days: 180, outcome_note_min: 5, rule_version: 'builtin', unverified: true };
const page = (items: unknown[], over: Record<string, unknown> = {}) => ({ items, next_cursor: null, as_of: '2027-10-20', policy, ...over });
const detail = (id: string, over: Record<string, unknown> = {}) => ({
  ...item(id),
  figures: { figure: { value: '60.0000', display_value: '60,00', null_reason: null }, tiles: [{ metric_code: 'DISBURSEMENT_RATE_PM', display_value: '60,00', null_reason: null }] },
  digest_ok: true,
  current: { as_of_date: '2027-10-19', display_value: '70,00', null_reason: null },
  comparison: { metric_code: 'DISBURSEMENT_RATE_PM', then: '60.0000', now: '70.0000', delta: '10.0000', direction: 'UP', null_reason: null },
  outcomes: [{ id: 'o1', outcome: 'STILL_OPEN', note: 'The north unit asked for time.', superseded_by: null, actor: ME, at: '2027-10-22T03:00:00.000Z' }],
  ...over,
});

interface Answers {
  list?: (query: Record<string, unknown>) => unknown;
  one?: (id: string) => unknown;
  command?: (operation: string, input: { body?: Record<string, unknown>; path?: { id: string } }) => unknown;
}
function client(answers: Answers = {}): Harness {
  return harness(
    (operation, input) => {
      if (operation === 'listAnalyticsDecisions') return (answers.list ?? (() => page([item(D1), item(D2, { kind: 'ESCALATE', latest_outcome: 'RESOLVED', follow_up: { owner: null, due_on: '2027-10-18', state: 'RESOLVED' } })])))(((input as { query?: Record<string, unknown> }).query ?? {}) as Record<string, unknown>);
      if (operation === 'getAnalyticsDecision') return (answers.one ?? ((id) => detail(id)))((input as { path: { id: string } }).path.id);
      return new Error(`unexpected read ${operation}`);
    },
    (operation, input) => (answers.command ?? (() => ({ operation_id: 'op', status: 'RECORDED', resource_version: 1, resource_id: D1 })))(operation, input as never),
  );
}
const commands = (h: Harness, operation: string): Array<{ body?: Record<string, unknown>; path?: { id: string } }> => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { body?: Record<string, unknown>; path?: { id: string } });

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

describe('BI-22 decision log (G3-6)', () => {
  it('lists the decisions with the figure of the moment, the follow-up state and who decided', async () => {
    mount(<DecisionLogScreen route={ROUTE} />, client(), { permissions: WRITER });
    const table = await screen.findByTestId('decision-table');
    const rows = within(table).getAllByTestId('decision-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(fill(tr('ana.decision.subject.tile'), { code: 'DISBURSEMENT_RATE_PM', unit: tr('ana.decision.subject.wholeScope') }));
    expect(rows[0]?.textContent).toContain('60,00');
    expect(rows[0]?.textContent).toContain(tr('ana.decision.followUp.dueSoon'));
    expect(rows[0]?.textContent).toContain(tr('ana.decision.kind.DIRECT_ACTION'));
    expect(rows[1]?.textContent).toContain(tr('ana.decision.followUp.resolved'));
    expect(rows[0]?.textContent).toContain('Leader One');
    expect(screen.getByTestId('ana-unverified')).toBeTruthy();
  });

  it('opens a decision and shows the frozen figure beside today and the difference, the digest and the outcomes', async () => {
    mount(<DecisionLogScreen route={ROUTE} />, client(), { permissions: WRITER });
    fireEvent.click(await screen.findByTestId(`decision-open-${D1}`));
    const compare = await screen.findByTestId('decision-compare');
    expect(compare.textContent).toContain('60,00');
    expect(compare.textContent).toContain('70,00');
    expect(screen.getByTestId('decision-delta').textContent).toBe('10.0000');
    expect(screen.getByTestId('decision-digest').textContent).toBe(fill(tr('ana.decision.digest.ok'), { digest: 'a'.repeat(12) }));
    expect(screen.getByTestId('decision-outcomes').textContent).toContain('The north unit asked for time.');
    expect(screen.getByTestId('decision-reason').textContent).toContain('catch up');
  });

  it('says plainly when the digest does not match and when there is no difference to give', async () => {
    mount(<DecisionLogScreen route={ROUTE} />, client({ one: (id) => detail(id, { digest_ok: false, comparison: { metric_code: 'X', then: null, now: '1', delta: null, direction: null, null_reason: 'NO_VALUE_THEN' }, current: null }) }), { permissions: WRITER });
    fireEvent.click(await screen.findByTestId(`decision-open-${D1}`));
    expect((await screen.findByTestId('decision-digest')).textContent).toBe(tr('ana.decision.digest.bad'));
    expect(screen.getByTestId('decision-delta').textContent).toBe(tr('ana.common.na'));
    expect(screen.getByTestId('decision-compare').textContent).toContain(tr('ana.decision.compare.noThen'));
  });

  it('records an outcome with a note, and asks for the replacing decision when it is superseded', async () => {
    const h = client();
    mount(<DecisionLogScreen route={ROUTE} />, h, { permissions: WRITER });
    fireEvent.click(await screen.findByTestId(`decision-open-${D1}`));
    await screen.findByTestId('outcome-kind');
    const send = screen.getByTestId('outcome-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('outcome-note'), { target: { value: 'Caught up as asked.' } });
    fireEvent.change(screen.getByTestId('outcome-kind'), { target: { value: 'RESOLVED' } });
    fireEvent.click(send);
    await waitFor(() => expect(commands(h, 'recordAnalyticsDecisionOutcome')).toHaveLength(1));
    expect(commands(h, 'recordAnalyticsDecisionOutcome')[0]).toMatchObject({ path: { id: D1 }, body: { outcome: 'RESOLVED', note: 'Caught up as asked.' } });
    fireEvent.change(screen.getByTestId('outcome-kind'), { target: { value: 'SUPERSEDED' } });
    fireEvent.change(screen.getByTestId('outcome-note'), { target: { value: 'Replaced by the escalation.' } });
    expect((screen.getByTestId('outcome-send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('outcome-replacement'), { target: { value: D2 } });
    expect((screen.getByTestId('outcome-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not offer to record anything to a reader without the right, and offers nothing on a superseded decision', async () => {
    mount(<DecisionLogScreen route={ROUTE} />, client(), { permissions: READER });
    expect(await screen.findByTestId('decision-table')).toBeTruthy();
    expect(screen.queryByTestId('decision-new')).toBeNull();
    fireEvent.click(screen.getByTestId(`decision-open-${D1}`));
    await screen.findByTestId('decision-detail');
    expect(screen.queryByTestId('outcome-send')).toBeNull();
    cleanup();
    mount(<DecisionLogScreen route={ROUTE} />, client({ one: (id) => detail(id, { latest_outcome: 'SUPERSEDED' }) }), { permissions: WRITER });
    fireEvent.click(await screen.findByTestId(`decision-open-${D1}`));
    await screen.findByTestId('decision-detail');
    expect(screen.queryByTestId('outcome-send')).toBeNull();
    expect(screen.getByText(tr('ana.decision.outcome.closed'))).toBeTruthy();
  });

  it('records a decision from the link of a figure: the figure is named, the kind and reason are asked, the server freezes the numbers', async () => {
    const h = client();
    const user = userEvent.setup();
    mount(<DecisionLogScreen route={ROUTE} />, h, { permissions: WRITER }, recordLink({ kind: 'KPI_TILE', metricCode: 'DISBURSEMENT_RATE_PM' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(fill(tr('ana.decision.subject.tile'), { code: 'DISBURSEMENT_RATE_PM', unit: tr('ana.decision.subject.wholeScope') }));
    fireEvent.change(within(dialog).getByTestId('decision-kind'), { target: { value: 'ESCALATE' } });
    fireEvent.change(within(dialog).getByTestId('decision-due'), { target: { value: '2027-11-30' } });
    const reason = within(dialog).getByRole('textbox', { name: new RegExp(fill(tr('ana.decision.dialog.reason'), { min: 10, max: 1000 }).slice(0, 12)) });
    await user.type(reason, 'Raise it with the chair of the board.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.decision.dialog.confirm') }));
    await waitFor(() => expect(commands(h, 'recordAnalyticsDecision')).toHaveLength(1));
    expect(commands(h, 'recordAnalyticsDecision')[0]?.body).toEqual({ subject: { kind: 'KPI_TILE', metric_code: 'DISBURSEMENT_RATE_PM' }, kind: 'ESCALATE', reason: 'Raise it with the chair of the board.', follow_up: { due_on: '2027-11-30' } });
    expect(await screen.findByTestId('decision-notice')).toBeTruthy();
  });

  it('says why a record was refused, inside the dialog, and keeps it open', async () => {
    const h = client({ command: () => new ApiError({ status: 422, code: 'METRIC_UNAVAILABLE', correlationId: 'c' }) });
    const user = userEvent.setup();
    mount(<DecisionLogScreen route={ROUTE} />, h, { permissions: WRITER }, recordLink({ kind: 'KPI_TILE', metricCode: 'DISBURSEMENT_RATE_PM' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /./ }), 'Raise it with the chair of the board.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.decision.dialog.confirm') }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(tr('ana.decision.problem.metricUnavailable'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('filters by subject and by open follow-up, and shows the empty, error and denied states', async () => {
    const h = client();
    mount(<DecisionLogScreen route={ROUTE} />, h, { permissions: WRITER });
    await screen.findByTestId('decision-table');
    fireEvent.change(screen.getByTestId('decision-filter-subject'), { target: { value: 'URGENT_ALERT' } });
    fireEvent.click(screen.getByTestId('decision-filter-open'));
    await waitFor(() => expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, unknown> }).query.subject_kind === 'URGENT_ALERT' && (call[1] as { query: Record<string, unknown> }).query.open_follow_up === true)).toBe(true));
    cleanup();
    mount(<DecisionLogScreen route={ROUTE} />, client({ list: () => page([]) }), { permissions: WRITER });
    expect(await screen.findByText(tr('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<DecisionLogScreen route={ROUTE} />, client({ list: () => new Error('boom') }), { permissions: WRITER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<DecisionLogScreen route={ROUTE} />, client({ list: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) }), { permissions: WRITER });
    expect((await screen.findByRole('alert')).textContent).toContain(tr('states.denied.title'));
  });

  it('reads answers that are not decisions as nothing and builds the links of a figure and an alert', () => {
    expect(toDecisionPage({})).toBeUndefined();
    expect(toDecisionDetail({ id: 'x' })).toBeUndefined();
    expect(toDecisionPage({ items: [{ id: 'bad' }], policy })?.items).toEqual([]);
    expect(recordLink({ kind: 'URGENT_ALERT', source: 'EARLY_WARNING', sourceId: 'w-1' })).toBe('/bi/bi-22?record=URGENT_ALERT&source=EARLY_WARNING&source_id=w-1');
    expect(recordLink({ kind: 'KPI_TILE', metricCode: 'A', unitId: 'u' })).toBe('/bi/bi-22?record=KPI_TILE&metric=A&unit=u');
  });
});
