import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import DrillScreen from './DrillScreen';
import { describeDrill, refreshTargetOf, toDrill } from './drill-model';

const ROUTE = routeOf('HOME-10', 'FR-HOME-10');
const READER = ['home.read'];
const S40 = '00000000-0000-4000-8000-0000000000f2';
const NORTH = '00000000-0000-4000-8000-000000000012';
const SOUTH = '00000000-0000-4000-8000-000000000013';
const PROJECT = '00000000-0000-4000-8000-000000000555';
const LINE = '00000000-0000-4000-8000-000000000777';

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const dong = (billions: number): string => String(billions * 1_000_000_000);

const child = (dimension: string, id: string, code: string, name: string, overrides: Record<string, unknown> = {}) => ({ dimension, id, code, name, value: dong(1000), numerator: null, denominator: null, null_reason: null, context_token: `token-${id}`, ...overrides });
const drillBody = (overrides: Record<string, unknown> = {}) => ({
  context_token: 'token-self',
  metric_code: 'PLAN_TOTAL',
  level: 'SCOPE',
  snapshot_id: S40,
  as_of_date: '2027-10-12',
  treasury_cutoff_date: '2027-10-12',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  scope_changed: false,
  scope: { unit_id: null, unit_name: null, project_id: null, project_code: null, project_name: null, line_id: null },
  formula: 'sum(plan_pm_assigned_vnd + plan_local_added_vnd)',
  unit: 'VND',
  value: dong(1750),
  numerator: null,
  denominator: null,
  null_reason: null,
  child_dimension: 'unit',
  child_dimensions: ['unit', 'project'],
  exclusions: [],
  children: [child('unit', NORTH, 'BQL-N', 'Ban Bắc', { value: dong(1250) }), child('unit', SOUTH, 'BQL-S', 'Ban Nam', { value: dong(500) })],
  reconciles_to_parent: true,
  non_additive_reason: null,
  source_records: [],
  next_cursor: null,
  ...overrides,
});

type Answer = (query: Record<string, string | number>) => unknown;
function client(answer: Answer, center: () => unknown = () => ({})): Harness {
  return harness((operation, input) => {
    const query = ((input as { query?: Record<string, string | number> }).query ?? {}) as Record<string, string | number>;
    if (operation === 'explainHomeMetric') return answer(query);
    if (operation === 'getCommandCenter') return center();
    return new Error(`unexpected read ${operation}`);
  });
}
const OPEN = '/?token=token-start';
const drillCalls = (h: Harness): Array<Record<string, string | number>> => h.read.mock.calls.filter((call) => call[0] === 'explainHomeMetric').map((call) => (call[1] as { query: Record<string, string | number> }).query);

afterEach(cleanup);

describe('HOME-10 trace of a figure (ST-HOME-002, HOME 3 F2)', () => {
  it('AC-ST-HOME-002-1: UAT-AC266 shows the formula, the snapshot and the day, and the children that add up to the figure, with the proof', async () => {
    mount(<DrillScreen route={ROUTE} />, client(() => drillBody()), { permissions: READER }, OPEN);
    const figure = await screen.findByTestId('drill-figure');
    expect(within(figure).getByTestId('drill-value').textContent).toBe(fill(vi_['home.tile.value.vnd'], { value: '1.750.000.000.000' }));
    expect(within(figure).getByTestId('drill-formula').textContent).toContain('plan_pm_assigned_vnd');
    expect(within(figure).getByTestId('drill-snapshot').getAttribute('title')).toBe(S40);
    expect(within(figure).getByTestId('drill-as-of').textContent).toBe('2027-10-12');
    expect(screen.getByTestId(`child-value-${NORTH}`).textContent).toBe(fill(vi_['home.tile.value.vnd'], { value: '1.250.000.000.000' }));
    expect(screen.getByTestId('drill-reconciliation').textContent).toBe(vi_['home.drill.reconcile.ok']);
  });

  it('says a ratio is not added, and gives the numerator and the denominator of each child', async () => {
    const ratio = drillBody({
      metric_code: 'DISBURSEMENT_RATE_PM',
      unit: 'PERCENT',
      value: '50.0000',
      numerator: dong(700),
      denominator: dong(1400),
      reconciles_to_parent: false,
      non_additive_reason: 'RATIO',
      children: [child('unit', NORTH, 'BQL-N', 'Ban Bắc', { value: '60.0000', numerator: dong(600), denominator: dong(1000) })],
    });
    mount(<DrillScreen route={ROUTE} />, client(() => ratio), { permissions: READER }, OPEN);
    await screen.findByTestId('drill-figure');
    expect(screen.getByTestId('drill-numerator').textContent).toBe('700.000.000.000');
    expect(screen.getByTestId('drill-denominator').textContent).toBe('1.400.000.000.000');
    expect(screen.getByTestId('drill-reconciliation').textContent).toBe(vi_['home.drill.reconcile.ratio']);
    const row = document.querySelector(`tr[data-child-id="${NORTH}"]`) as HTMLElement;
    expect(row.textContent).toContain('60.0000%');
    expect(row.textContent).toContain('600.000.000.000');
    expect(row.textContent).toContain('1.000.000.000.000');
  });

  it('does not say the rows add up when they do not', async () => {
    mount(<DrillScreen route={ROUTE} />, client(() => drillBody({ reconciles_to_parent: false })), { permissions: READER }, OPEN);
    expect((await screen.findByTestId('drill-reconciliation')).textContent).toBe(vi_['home.drill.reconcile.broken']);
  });

  it('starts over when the address names another figure, and does not keep the one it had', async () => {
    const user = userEvent.setup();
    const h = client((query) => drillBody({ metric_code: query.context_token === 'token-b' ? 'DISBURSED_TREASURY' : 'PLAN_TOTAL' }));
    mount(
      <>
        <Link to="/?token=token-b">go</Link>
        <DrillScreen route={ROUTE} />
      </>,
      h,
      { permissions: READER },
      OPEN,
    );
    await screen.findByTestId('drill-figure');
    expect(within(screen.getByTestId('drill-figure')).getByRole('heading').textContent).toBe(vi_['home.tile.metric.planTotal']);
    await user.click(screen.getByRole('link', { name: 'go' }));
    await waitFor(() => expect(within(screen.getByTestId('drill-figure')).getByRole('heading').textContent).toBe(vi_['home.tile.metric.disbursed']));
    expect(drillCalls(h).map((query) => query.context_token)).toEqual(['token-start', 'token-b']);
  });

  it('goes down through the children, keeps a trail that can be walked back, and asks each step with the token of the child', async () => {
    const user = userEvent.setup();
    const h = client((query) => {
      if (query.context_token === 'token-start') return drillBody();
      if (query.context_token === `token-${NORTH}`) return drillBody({ level: 'UNIT', scope: { unit_name: 'Ban Bắc', project_code: null, project_name: null }, value: dong(1250), child_dimension: 'project', children: [child('project', PROJECT, 'HD-001', 'Cầu Bến Lức', { value: dong(1250) })] });
      return drillBody({ level: 'PROJECT', scope: { unit_name: 'Ban Bắc', project_code: 'HD-001', project_name: 'Cầu Bến Lức' }, child_dimension: 'cell', child_dimensions: ['cell'], value: dong(1250), children: [child('cell', LINE, 'CURRENT_YEAR|CENTRAL', 'CURRENT_YEAR · CENTRAL', { value: dong(1000) })] });
    });
    mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
    await screen.findByTestId('drill-figure');
    await user.click(screen.getByRole('button', { name: fill(vi_['home.drill.open'], { name: 'BQL-N' }) }));
    await waitFor(() => expect(screen.getByTestId('drill-place').textContent).toBe('Ban Bắc'));
    await user.click(screen.getByRole('button', { name: fill(vi_['home.drill.open'], { name: 'HD-001' }) }));
    await waitFor(() => expect(screen.getByTestId('drill-place').textContent).toBe('HD-001 Cầu Bến Lức'));
    const trail = screen.getByTestId('drill-breadcrumb');
    expect(within(trail).getAllByRole('listitem')).toHaveLength(3);
    expect(drillCalls(h).map((query) => query.context_token)).toEqual(['token-start', `token-${NORTH}`, `token-${PROJECT}`]);
    // Back to the unit: the page of the unit again, with nothing deeper kept.
    await user.click(within(trail).getAllByRole('button')[1] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('drill-place').textContent).toBe('Ban Bắc'));
    expect(within(screen.getByTestId('drill-breadcrumb')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('asks the server again when a step that was visited is visited again, so that a right taken away meanwhile ends it', async () => {
    const user = userEvent.setup();
    let revoked = false;
    const h = client((query) => {
      if (query.context_token === 'token-start') return revoked ? failure(403, 'SCOPE_DENIED') : drillBody();
      return drillBody({ level: 'UNIT', scope: { unit_name: 'Ban Bắc', project_code: null, project_name: null }, children: [] });
    });
    mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
    await screen.findByTestId('drill-figure');
    await user.click(screen.getByRole('button', { name: fill(vi_['home.drill.open'], { name: 'BQL-N' }) }));
    await waitFor(() => expect(screen.getByTestId('drill-place').textContent).toBe('Ban Bắc'));
    revoked = true;
    await user.click(within(screen.getByTestId('drill-breadcrumb')).getAllByRole('button')[0] as HTMLElement);
    expect(await screen.findByTestId('drill-denied')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Ban Bắc|Ban Nam|BQL-N|BQL-S/);
    expect(drillCalls(h).filter((query) => query.context_token === 'token-start')).toHaveLength(2);
  });

  it('lets the leader choose what to break the figure down by, and reads that', async () => {
    const user = userEvent.setup();
    const h = client((query) => (query.child_dimension === 'project' ? drillBody({ child_dimension: 'project', children: [child('project', PROJECT, 'HD-001', 'Cầu Bến Lức')] }) : drillBody()));
    mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
    await screen.findByTestId('drill-children');
    await user.selectOptions(screen.getByLabelText(vi_['home.drill.dimension.label']), 'project');
    expect(await screen.findByText('Cầu Bến Lức')).toBeTruthy();
    expect(drillCalls(h).at(-1)).toMatchObject({ child_dimension: 'project' });
  });

  it('shows the sources of a project: the report revision and the Treasury transactions, and reads the next page of them', async () => {
    const user = userEvent.setup();
    const page = (cursor: string | undefined) =>
      drillBody({
        level: 'PROJECT',
        child_dimension: 'cell',
        child_dimensions: ['cell'],
        children: [],
        source_records: cursor === undefined
          ? [
              { kind: 'REPORT_REVISION', id: 'r1', revision: 2, status: 'ACCEPTED', submitted_at: null, accepted_at: null },
              { kind: 'TREASURY_TRANSACTION', id: 't1', external_id: 'TX-1', amount_vnd: dong(200), confirmed_at: '2027-10-01T03:00:00.000000Z', reversal_of_id: null },
            ]
          : [{ kind: 'TREASURY_TRANSACTION', id: 't2', external_id: 'TX-2', amount_vnd: dong(300), confirmed_at: '2027-10-05T03:00:00.000000Z', reversal_of_id: null }],
        next_cursor: cursor === undefined ? 'next' : null,
      });
    const h = client((query) => page(query.cursor as string | undefined));
    mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
    const sources = await screen.findByTestId('drill-sources');
    expect(sources.querySelector('[data-source="report"]')?.textContent).toBe(fill(vi_['home.drill.sources.report'], { revision: 2, status: 'ACCEPTED' }));
    expect(sources.querySelector('[data-source="treasury"]')?.textContent).toBe(fill(vi_['home.drill.sources.treasury'], { ref: 'TX-1', amount: '200.000.000.000', at: '2027-10-01' }));
    await user.click(screen.getByRole('button', { name: vi_['home.drill.more'] }));
    await waitFor(() => expect(screen.getByTestId('drill-sources').querySelectorAll('[data-source="treasury"]')).toHaveLength(2));
    expect(drillCalls(h).at(-1)).toMatchObject({ cursor: 'next' });
  });

  it('reads the next page of the sources from a cell too, where there are no children to page, and shows the cells of a project once however many pages of sources are read', async () => {
    const user = userEvent.setup();
    const tx = (n: number) => ({ kind: 'TREASURY_TRANSACTION', id: `t${n}`, external_id: `TX-${n}`, amount_vnd: dong(n), confirmed_at: '2027-10-05T03:00:00.000000Z', reversal_of_id: null });
    const cell = client((query) => drillBody({ level: 'CELL', child_dimension: null, child_dimensions: [], children: [], source_records: [tx(query.cursor === undefined ? 1 : 2)], next_cursor: query.cursor === undefined ? 'next' : null }));
    mount(<DrillScreen route={ROUTE} />, cell, { permissions: READER }, OPEN);
    await screen.findByTestId('drill-sources');
    expect(screen.queryByTestId('drill-children')).toBeNull();
    await user.click(screen.getByRole('button', { name: vi_['home.drill.more'] }));
    await waitFor(() => expect(screen.getByTestId('drill-sources').querySelectorAll('[data-source="treasury"]')).toHaveLength(2));
    cleanup();
    // A project: the cells come with the first page, and the next page of transactions brings them again only if the server does.
    const project = client((query) => drillBody({ level: 'PROJECT', child_dimension: 'cell', child_dimensions: ['cell'], children: [child('cell', LINE, 'CURRENT_YEAR|CENTRAL', 'Central')], source_records: [tx(query.cursor === undefined ? 1 : 2)], next_cursor: query.cursor === undefined ? 'next' : null }));
    mount(<DrillScreen route={ROUTE} />, project, { permissions: READER }, OPEN);
    await screen.findByTestId('drill-sources');
    await user.click(screen.getByRole('button', { name: vi_['home.drill.more'] }));
    await waitFor(() => expect(screen.getByTestId('drill-sources').querySelectorAll('[data-source="treasury"]')).toHaveLength(2));
    expect(document.querySelectorAll(`tr[data-child-id="${LINE}"]`)).toHaveLength(1);
  });

  it('starts the reading again, and does not merge, when a later page is read under another scope than the first', async () => {
    const user = userEvent.setup();
    const h = client((query) => {
      if (query.context_token === 'token-renewed') return drillBody({ children: [child('unit', NORTH, 'BQL-N', 'Ban Bắc', { value: dong(1250) })], value: dong(1250) });
      if (query.cursor === undefined) return drillBody({ next_cursor: 'next', scope_hash: 'h1' });
      // The grants changed between the first page and the second: the server reads the second over the scope of now.
      return drillBody({ scope_changed: true, scope_hash: 'h2', context_token: 'token-renewed', children: [child('unit', NORTH, 'BQL-N', 'Ban Bắc', { value: dong(1250) })], value: dong(1250) });
    });
    mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
    await screen.findByTestId('drill-figure');
    expect(screen.getByTestId(`child-value-${SOUTH}`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: vi_['home.drill.more'] }));
    await waitFor(() => expect(drillCalls(h).map((query) => query.context_token)).toContain('token-renewed'));
    await waitFor(() => expect(screen.queryByTestId(`child-value-${SOUTH}`)).toBeNull());
    expect(screen.getByTestId(`child-value-${NORTH}`)).toBeTruthy();
    expect(screen.getByTestId('drill-value').textContent).toBe(fill(vi_['home.tile.value.vnd'], { value: '1.250.000.000.000' }));
    expect(screen.queryByTestId('scope-changed')).toBeNull();
  });

  it('starts the reading again too when the token was of an older scope already (its first page says so) and the scope moves again before the next page', async () => {
    const user = userEvent.setup();
    const h = client((query) => {
      if (query.context_token === 'token-renewed') return drillBody({ scope_hash: 'h2', children: [child('unit', NORTH, 'BQL-N', 'Ban Bắc')] });
      if (query.cursor === undefined) return drillBody({ next_cursor: 'next', scope_changed: true, scope_hash: 'h1', context_token: 'token-h1' });
      return drillBody({ scope_changed: true, scope_hash: 'h2', context_token: 'token-renewed', children: [child('unit', NORTH, 'BQL-N', 'Ban Bắc')] });
    });
    mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
    await screen.findByTestId('scope-changed');
    expect(screen.getByTestId(`child-value-${SOUTH}`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: vi_['home.drill.more'] }));
    await waitFor(() => expect(drillCalls(h).map((query) => query.context_token)).toContain('token-renewed'));
    await waitFor(() => expect(screen.queryByTestId(`child-value-${SOUTH}`)).toBeNull());
  });

  it('shows a transaction that takes another back as what it takes off, with the words that say so', async () => {
    const sources = [
      { kind: 'TREASURY_TRANSACTION', id: 't1', external_id: 'TX-ORIG', amount_vnd: dong(20), contribution_vnd: dong(20), confirmed_at: '2027-10-03T03:00:00.000000Z', reversal_of_id: null },
      { kind: 'TREASURY_TRANSACTION', id: 't2', external_id: 'TX-BACK', amount_vnd: dong(5), contribution_vnd: `-${dong(5)}`, confirmed_at: '2027-10-04T03:00:00.000000Z', reversal_of_id: 't1' },
    ];
    mount(<DrillScreen route={ROUTE} />, client(() => drillBody({ level: 'PROJECT', child_dimension: 'cell', child_dimensions: ['cell'], children: [], source_records: sources })), { permissions: READER }, OPEN);
    const list = await screen.findByTestId('drill-sources');
    const lines = Array.from(list.querySelectorAll('[data-source="treasury"]')).map((line) => line.textContent);
    expect(lines).toEqual([
      fill(vi_['home.drill.sources.treasury'], { ref: 'TX-ORIG', amount: '20.000.000.000', at: '2027-10-03' }),
      fill(vi_['home.drill.sources.reversal'], { ref: 'TX-BACK', amount: '-5.000.000.000', at: '2027-10-04' }),
    ]);
  });

  it('says no data for a child that has none, never 0, and lists what is left out', async () => {
    const missing = drillBody({ children: [child('cell', LINE, 'CURRENT_YEAR|LOCAL', 'Local', { value: null, null_reason: 'NO_DATA' })], exclusions: [{ dimension: 'cell', id: LINE, code: 'CURRENT_YEAR|LOCAL', reason: 'NO_DATA' }] });
    mount(<DrillScreen route={ROUTE} />, client(() => missing), { permissions: READER }, OPEN);
    expect((await screen.findByTestId(`child-value-${LINE}`)).textContent).toBe(vi_['home.tile.nullReason.noData']);
    expect(within(screen.getByTestId('drill-exclusions')).getByText(/CURRENT_YEAR\|LOCAL/).textContent).toContain(vi_['home.tile.nullReason.noData']);
  });

  it('says the rights changed since the page was opened, and takes the renewed token of the answer so that the warning clears', async () => {
    const user = userEvent.setup();
    // The token that was made under the old scope is read as such every time; the one the server gives back is of the scope the reader has now.
    const h = client((query) => (query.context_token === 'token-renewed' ? drillBody() : drillBody({ scope_changed: true, context_token: 'token-renewed' })));
    mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
    expect((await screen.findByTestId('scope-changed')).textContent).toContain(vi_['home.drill.scopeChanged']);
    await user.click(screen.getByRole('button', { name: vi_['home.drill.refresh'] }));
    await waitFor(() => expect(screen.queryByTestId('scope-changed')).toBeNull());
    expect(drillCalls(h).map((query) => query.context_token)).toEqual(['token-start', 'token-renewed']);
  });

  it('hides what was read when a later reading of the same step is refused: no name or figure of the place stays beside the refusal', async () => {
    const user = userEvent.setup();
    let refused = false;
    const h = client(() => (refused ? failure(403, 'SCOPE_DENIED') : drillBody({ scope_changed: true, context_token: '', scope: { unit_name: 'Ban Bắc', project_code: null, project_name: null } })));
    mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
    await screen.findByTestId('drill-place');
    refused = true;
    await user.click(screen.getByRole('button', { name: vi_['home.drill.refresh'] }));
    expect(await screen.findByTestId('drill-denied')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Ban Bắc|BQL-N|BQL-S/);
    expect(screen.queryByTestId('drill-figure')).toBeNull();
    expect(screen.queryByTestId('drill-breadcrumb')).toBeNull();
  });

  it('AC-ST-HOME-002-2: UAT-AC267 says the right is gone, shows no name and says the page needs a refresh', async () => {
    const user = userEvent.setup();
    const h = client((query) => (query.context_token === 'token-start' ? drillBody() : failure(403, 'SCOPE_DENIED')));
    mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
    await screen.findByTestId('drill-figure');
    await user.click(screen.getByRole('button', { name: fill(vi_['home.drill.open'], { name: 'BQL-S' }) }));
    const denied = await screen.findByTestId('drill-denied');
    expect(within(denied).getByText(vi_['home.drill.denied.title'])).toBeTruthy();
    expect(within(denied).getByTestId('needs-refresh').textContent).toBe(vi_['home.drill.needsRefresh']);
    // Not a name of a unit, a project or a step of the trail is left on the page.
    expect(document.body.textContent).not.toMatch(/Ban Nam|Ban Bắc|BQL-S|BQL-N/);
    expect(screen.queryByTestId('drill-breadcrumb')).toBeNull();
    expect(within(denied).getByRole('link', { name: vi_['home.drill.back'] }).getAttribute('href')).toBe('/home/home-09');
  });

  it('AC-ST-HOME-002-3: shows the page of a token that is not good, with no data', async () => {
    mount(<DrillScreen route={ROUTE} />, client(() => failure(400, 'INVALID_REQUEST')), { permissions: READER }, OPEN);
    expect(await screen.findByTestId('drill-invalid')).toBeTruthy();
    expect(screen.queryByTestId('drill-figure')).toBeNull();
  });

  it('says there is nothing to show when no figure was chosen, and does not ask the server', () => {
    const h = client(() => drillBody());
    mount(<DrillScreen route={ROUTE} />, h, { permissions: READER });
    expect(screen.getByTestId('drill-no-token').textContent).toContain(vi_['home.drill.noToken']);
    expect(drillCalls(h)).toHaveLength(0);
  });

  describe('AC-ST-HOME-002-4: a token that is old is renewed over the same snapshot', () => {
    const tile = (code: string, token: string) => ({ metric_code: code, value: '1', numerator: null, denominator: null, null_reason: null, unit: 'VND', formula: 'f', definition_status: 'SIGNED', context_token: token });
    const center = { snapshot_id: S40, as_of_date: '2027-10-12', treasury_cutoff_date: '2027-10-12', freshness: 'FRESH', definition_status: 'SIGNED', legal_confirmation_refs: [], scope: { unit_id: null, projects: 1, scope_hash: 'h' }, tiles: [tile('PLAN_TOTAL', 'token-fresh')], projects_without_data: 0, open_warnings: 0, overdue_explanations: 0, pending_reallocations: 0, quality_badge: 'NOT_ASSESSED' };

    it('asks the center for the same snapshot, takes the new token of the same metric, and goes on', async () => {
      const h = client(
        (query) => (query.context_token === 'token-fresh' ? drillBody() : failure(409, 'SNAPSHOT_EXPIRED', { snapshot_id: S40, metric_code: 'PLAN_TOTAL', unit_id: null, project_id: null })),
        () => center,
      );
      mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
      expect(await screen.findByTestId('drill-figure')).toBeTruthy();
      const asked = h.read.mock.calls.filter((call) => call[0] === 'getCommandCenter').map((call) => (call[1] as { query: Record<string, string> }).query);
      expect(asked).toEqual([{ snapshot_id: S40 }]);
      expect(drillCalls(h).map((query) => query.context_token)).toEqual(['token-start', 'token-fresh']);
      expect(screen.queryByTestId('drill-renewed')).toBeNull();
    });

    it('says the trace goes on from the unit when the old token was below it', async () => {
      const h = client(
        (query) => (query.context_token === 'token-fresh' ? drillBody({ level: 'UNIT' }) : failure(409, 'SNAPSHOT_EXPIRED', { snapshot_id: S40, metric_code: 'PLAN_TOTAL', unit_id: NORTH, project_id: PROJECT })),
        () => center,
      );
      mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
      expect(await screen.findByTestId('drill-renewed')).toBeTruthy();
      const asked = h.read.mock.calls.filter((call) => call[0] === 'getCommandCenter').map((call) => (call[1] as { query: Record<string, string> }).query);
      expect(asked).toEqual([{ snapshot_id: S40, unit_id: NORTH }]);
    });

    it('says the trace goes on from the tile of the unit when the old token was of the unit alone, which a new token of the tile is not', async () => {
      const h = client(
        (query) => (query.context_token === 'token-fresh' ? drillBody({ level: 'UNIT' }) : failure(409, 'SNAPSHOT_EXPIRED', { snapshot_id: S40, metric_code: 'PLAN_TOTAL', unit_id: NORTH, unit_exact: true, project_id: null })),
        () => center,
      );
      mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
      expect(await screen.findByTestId('drill-renewed')).toBeTruthy();
    });

    it('asks for the whole of the scope when the reader may not narrow the center to the unit (a right by a project), and says the trace goes on from there', async () => {
      const calls: Array<Record<string, string>> = [];
      const h = client(
        (query) => (query.context_token === 'token-fresh' ? drillBody() : failure(409, 'SNAPSHOT_EXPIRED', { snapshot_id: S40, metric_code: 'PLAN_TOTAL', unit_id: NORTH, unit_exact: true, project_id: null })),
        () => center,
      );
      h.read.mockImplementation((operation: string, input?: unknown) => {
        const query = ((input as { query?: Record<string, string> }).query ?? {}) as Record<string, string>;
        if (operation === 'explainHomeMetric') return Promise.resolve(query.context_token === 'token-fresh' ? drillBody() : Promise.reject(failure(409, 'SNAPSHOT_EXPIRED', { snapshot_id: S40, metric_code: 'PLAN_TOTAL', unit_id: NORTH, unit_exact: true, project_id: null })));
        calls.push(query);
        return query.unit_id === undefined ? Promise.resolve(center) : Promise.reject(failure(403, 'SCOPE_DENIED'));
      });
      mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
      expect(await screen.findByTestId('drill-renewed')).toBeTruthy();
      expect(calls).toEqual([{ snapshot_id: S40, unit_id: NORTH }, { snapshot_id: S40 }]);
    });

    it('says the token is not good when it cannot be renewed (the center has no such tile now), instead of waiting for ever', async () => {
      const h = client(() => failure(409, 'SNAPSHOT_EXPIRED', { snapshot_id: S40, metric_code: 'GONE', unit_id: null, project_id: null }), () => center);
      mount(<DrillScreen route={ROUTE} />, h, { permissions: READER }, OPEN);
      expect(await screen.findByTestId('drill-invalid')).toBeTruthy();
    });
  });

  describe('the seven standard states', () => {
    it.each([
      ['denied', failure(403, 'FORBIDDEN'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ])('UI-HOME-10 shows the %s state', async (_name, error, title) => {
      mount(<DrillScreen route={ROUTE} />, client(() => error), { permissions: READER }, OPEN);
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-HOME-10 shows the loading state first, names the page, and retries after an error', async () => {
      mount(<DrillScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: READER }, OPEN);
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['home.drill.page.title'] })).toBeTruthy();
      cleanup();
      let failing = true;
      mount(<DrillScreen route={ROUTE} />, client(() => (failing ? failure(500, 'INTERNAL_ERROR') : drillBody())), { permissions: READER }, OPEN);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('drill-figure')).toBeTruthy();
    });
  });
});

describe('the drill as the screen reads it', () => {
  it('reads what makes a figure citable and nothing else: the snapshot, the day, the formula and the unit of measure', () => {
    expect(toDrill(drillBody())?.children.map((entry) => entry.code)).toEqual(['BQL-N', 'BQL-S']);
    for (const bad of [null, [], {}, drillBody({ snapshot_id: '' }), drillBody({ as_of_date: undefined }), drillBody({ formula: '' }), drillBody({ unit: 'EUR' }), drillBody({ level: 'GALAXY' }), drillBody({ scope: undefined })]) expect(toDrill(bad)).toBeUndefined();
  });

  it('leaves out a child without its token and a source that is not of a kind it knows', () => {
    const drill = toDrill(drillBody({ children: [child('unit', NORTH, 'N', 'n', { context_token: '' }), child('galaxy', SOUTH, 'S', 's')], source_records: [{ kind: 'DOCUMENT', id: 'd' }, { kind: 'REPORT_REVISION', id: 'r', revision: 1, status: 'ACCEPTED' }] }));
    expect(drill?.children).toEqual([]);
    expect(drill?.sources.map((source) => source.kind)).toEqual(['REPORT_REVISION']);
  });

  it('tells the failures apart: the right gone, a token that is old or not good, a snapshot that is not there', () => {
    expect([failure(403, 'SCOPE_DENIED'), failure(409, 'SNAPSHOT_EXPIRED'), failure(400, 'INVALID_REQUEST'), failure(422, 'VALIDATION_FAILED'), failure(404, 'RESOURCE_NOT_FOUND'), failure(500, 'X'), new Error('x')].map(describeDrill)).toEqual(['denied', 'expired', 'invalid', 'invalid', 'notFound', 'general', 'general']);
  });

  it('reads where an old token was of from the answer, and only from an expiry', () => {
    expect(refreshTargetOf(failure(409, 'SNAPSHOT_EXPIRED', { snapshot_id: S40, metric_code: 'PLAN_TOTAL', unit_id: NORTH, project_id: null }))).toEqual({ snapshotId: S40, metricCode: 'PLAN_TOTAL', unitId: NORTH, deeper: false });
    expect(refreshTargetOf(failure(409, 'SNAPSHOT_EXPIRED', { snapshot_id: S40, metric_code: 'PLAN_TOTAL', project_id: PROJECT }))?.deeper).toBe(true);
    expect(refreshTargetOf(failure(409, 'SNAPSHOT_EXPIRED', {}))).toBeUndefined();
    expect(refreshTargetOf(failure(403, 'SCOPE_DENIED', { snapshot_id: S40, metric_code: 'x' }))).toBeUndefined();
  });
});
